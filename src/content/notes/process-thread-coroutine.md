---
slug: process-thread-coroutine
title: 进程、线程、协程与上下文切换
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 4 分钟
tags: 进程 | 线程 | 协程 | 调度
summary: 从执行实体、并发并行、上下文切换和线程池边界选择合适的异步模型。
---

# 进程、线程、协程与上下文切换

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

进程提供隔离的地址空间和资源边界；线程共享进程资源并由 OS 调度；协程/async 是用户态协作式控制流，切换成本和阻塞语义取决于运行时。上下文切换不是固定数字：寄存器、缓存、调度、锁、NUMA 和工作粒度都会影响实际成本。Unity 主线程、Job worker、线程池和 async continuation 不应混为“多线程”。

## 选择维度

| 需求 | 适合 | 关键风险 |
| --- | --- | --- |
| 隔离崩溃/资源 | 进程/服务 | IPC、部署、序列化。 |
| CPU 并行 | 线程/Job/进程池 | 共享数据、同步、负载均衡。 |
| 大量等待 | async/协程/事件循环 | 不能执行阻塞调用，需取消/背压。 |
| Unity 数据批处理 | Job/Burst | Unity API 主线程边界、dependency。 |

## 四种执行实体不是同一层抽象

| 实体 | 调度者/隔离 | 共享状态 | 典型代价/限制 |
| --- | --- | --- | --- |
| 进程 | OS；独立虚拟地址空间/权限边界 | 通过 IPC/共享内存显式共享 | 创建、IPC、序列化与部署更重，崩溃可隔离。 |
| OS thread | OS scheduler；同进程共享地址空间 | heap/static/handle 都可能共享 | 栈、调度和同步成本；阻塞占用线程。 |
| coroutine / async state machine | runtime/event loop 协作调度 | 通常共享同进程内存 | 挂起不等于并行；阻塞调用会卡住承载线程。 |
| Job / task work item | runtime/Job scheduler 分发到 worker | 受任务依赖/同步合同约束 | 需合适粒度、负载均衡、完成点和取消语义。 |

“线程轻还是协程轻”没有一个脱离 runtime/平台的固定数值。真正要回答的是：工作是否 CPU-bound、是否会阻塞、并发数量级、状态如何隔离、谁负责调度和失败传播、任务粒度是否大于调度成本。

## 并发、并行、异步

- **并发**：多个工作在时间上交错推进，不要求同一时刻同时执行。
- **Parallelism**：多个执行单元在多个核心上同时运行。
- **Asynchrony**：调用方不必阻塞等待操作完成；它本身不保证后台线程或并行。

Unity Coroutine 可以跨帧异步编排，却通常仍在 PlayerLoop 主线程推进；`Task` 可能在完成时回到捕获的 SynchronizationContext；Job 可并行运行，但只有数据和依赖合同允许时才安全。把 `async` 标记成“已后台化”会导致主线程重计算或误用 Unity API。

## 上下文切换与粒度

OS context switch 涉及保存/恢复执行状态，并可能扰动缓存/TLB；但在实际工作负载中，锁竞争、调度延迟、内存带宽和 cache miss 常比单次寄存器保存更重要。工作拆得越细，调度/队列/同步的比例越高；拆得太粗又会负载不均、尾部任务拖慢整体。

```text
useful work per task >> scheduling + synchronization + data movement
```

这不是某个固定微秒阈值。需要在目标平台上测不同 batch size、worker count 与数据规模，并看 throughput、P95/P99、queue wait、worker idle 和主线程 Complete 等待。

## Unity 的几个线程边界

| 机制 | 做什么 | 不做什么 |
| --- | --- | --- |
| Main Thread / PlayerLoop | Unity object、scene、UI、许多 Unity API 的协调入口 | 不应无限 drain worker 结果。 |
| ThreadPool / Task | 通用 managed 工作与 I/O continuation | 不会自动获得 Unity API 权限；共享状态仍需同步。 |
| Job System | 数据并行任务与依赖调度 | 不接收任意 managed object graph / MonoBehaviour。 |
| Coroutine | PlayerLoop 中的分帧流程 | 不把纯 CPU 循环移出主线程。 |

任务完成后的 Unity API apply 需要回到明确主线程 phase，并考虑 owner 是否仍存活、generation 是否仍当前、队列是否有预算。相关资源与写入权限仍需由明确的生命周期协议管理。

## 阻塞、线程池与饥饿

把 CPU-bound 工作交给线程池不代表容量无限。若任务内部同步等待另一个线程池任务、做长时间阻塞 IO、在锁内等待 Unity callback，线程池可能出现 starvation；增加线程数会提高栈/上下文/争用成本，不能替代 bounded concurrency。

在任务入口传播 cancellation/deadline，避免请求取消后继续耗 CPU；但取消需协作式，阻塞调用未必立即停止。长任务应拆分为安全检查点，或使用支持 cancellation 的 API。

## 诊断

区分 runnable、blocked、sleep、IO wait；采集 context switches、run queue、锁等待、CPU cache miss（可用平台工具）和实际吞吐。线程数增加若只增加切换/争用，不会带来并行收益。

诊断时区分 CPU 利用率高与请求延迟高：高 CPU 可能是有效并行，也可能是忙循环/重试；低 CPU 仍可能因锁、IO、主线程同步和线程池队列等待而慢。采集每类线程的 running/runnable/blocked 状态、run queue、context switch、lock wait、IO wait、线程池 queue/worker 数和任务 tail latency。

实验要固定输入并扫描 worker 数与任务 batch size。若吞吐随线程增长后平台化、P99 变差且锁/缓存 miss 增长，就存在争用或内存带宽瓶颈；若 worker idle 而主线程长时间 `Complete`，可能是调度太晚、依赖链串行或任务粒度不平衡。

## 常见错误推理

- “线程越多越快”：超过核心/下游容量后增加调度、缓存争用和连接压力。
- “async 就不会卡”：await 前的同步计算仍在当前线程；`Task.Run` 中调用 Unity API 也不会因此合法。
- “协程可做重活”：每次 MoveNext 执行的同步代码仍会占用 PlayerLoop 帧预算。
- “切换成本只有纳秒”：忽略 cache/TLB、锁、调度等待和数据搬运，微基准结论无法外推。
- “线程安全容器解决竞态”：业务状态跨多个字段/外部副作用仍需原子合同。

## 验证与选择流程

1. 标注 workload 是 CPU、IO、定时等待还是 Unity API 操作。
2. 找到实际调度者、状态 owner、阻塞点、取消和异常路径。
3. 先尝试单线程/批处理/异步 IO；确有 CPU 瓶颈再并行化纯数据。
4. 明确任务粒度、并发上限、结果回流预算和 shutdown 行为。
5. 在目标平台记录吞吐、尾延迟、CPU、内存、run queue/worker 等待和正确性。

## 参考资料

- [man7.org/linux/man-pages/man7/pthreads.7.html](https://man7.org/linux/man-pages/man7/pthreads.7.html)
- [learn.microsoft.com/dotnet/standard/threading/threads-and-threading](https://learn.microsoft.com/dotnet/standard/threading/threads-and-threading)
