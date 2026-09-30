---
slug: deadlock-threadpool-blocking
title: 死锁、线程池与阻塞边界
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 4 分钟
tags: 死锁 | 线程池 | 阻塞
summary: 用 wait-for graph、锁顺序和阻塞预算识别死锁、活锁、饥饿与线程池耗尽。
---

# 死锁、线程池与阻塞边界

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

死锁需要互斥、持有并等待、不可剥夺、循环等待同时成立。排查不只看 `lock`，还要看同步等待的 async、回调重入和资源顺序。线程池适合大量短小、可等待的工作；把阻塞 IO 或长 CPU 任务无限塞入线程池，会造成 starvation，令本来异步的请求全部排队。

## 典型死锁

```text
Thread A holds Lock1 -> waits Lock2
Thread B holds Lock2 -> waits Lock1
```

工程上优先固定全局锁顺序、缩短临界区、禁止锁内外部回调/IO，并使用 timeout/诊断而非无限等待。`Task.Result`/`.Wait()` 与需要当前同步上下文的 continuation 组合，也可能造成 async sync-over-async 死锁。

## 先区分死锁、活锁、饥饿与阻塞

| 现象 | 系统状态 | 证据 | 典型处理 |
| --- | --- | --- | --- |
| deadlock | 一组等待形成永久循环，无人能推进 | wait-for graph、线程栈、锁 owner | 打破顺序/资源协议，终止/回滚 victim。 |
| livelock | 工作不断重试/让步但没有有效进展 | CPU 高、attempt 增长、完成数低 | backoff+jitter、优先级/协调。 |
| starvation | 部分工作长期得不到资源 | queue age/P99 高、CPU 未必满 | 公平调度、bulkhead、上限。 |
| long blocking | 等待最终会结束但超预算 | IO/lock/dependency timeline | deadline、并发/队列与依赖优化。 |

把所有“请求卡住”叫死锁会误导修复：线程池 starvation 可能没有锁循环，慢 DB 也可能只是持锁/队列过长。先收集每个执行单元等什么、由谁持有、等待多久、是否存在可推进路径。

## Wait-for graph 与锁顺序

将资源（lock、semaphore、连接、任务 completion、同步上下文）和执行者画成图：`A -> R` 表示 A 等 R，`R -> B` 表示 B 持有/负责 R。存在环才是 deadlock 的强信号。锁顺序规则应是可检查的：例如 `AccountLock < InventoryLock < EventStoreLock`，所有路径按递增顺序获取；跨多个 key 则先按稳定业务 ID 排序。

```text
bad:  transfer(a,b) locks a then b; transfer(b,a) locks b then a
good: order by account id, lock min then max, release in reverse order
```

锁内不执行网络、磁盘、等待另一个 task、调用未知 callback 或 Unity event；这些操作会延长持锁时间或重入获得另一把锁。需要通知外部时，在锁内生成不可变事件/状态快照，锁外发布。

## Async deadlock 的真实前提

典型 .NET 模式：UI/单线程同步上下文调用 `.Result` 阻塞当前线程；async 方法内部 `await` 后尝试回到同一上下文；continuation 无法运行，双方等待。解决不是盲目到处加 `ConfigureAwait(false)`：库代码可考虑不捕获上下文，应用入口应 async all the way，避免同步阻塞 async；Unity 有自己的主线程/PlayerLoop 约束，后台完成的结果仍要由主线程 phase 应用。

还有“逻辑 async deadlock”：两个 Task 各 await 对方、Channel producer 等消费者但消费者等 producer、持有 async semaphore 后 await 一个也需要它的操作。这些同样可画 wait-for graph，`await` 不自动消除循环。

## 线程池 starvation 与阻塞预算

线程池根据运行时启发式增长 worker，不是每个排队任务立即得到线程。同步阻塞 (`.Wait()`、阻塞 IO、长 lock、sync-over-async) 占住 worker 后，后续 continuation/请求也排队，出现 CPU 不满但 P99 很高的 starvation。盲目设置最小线程或无界 `Task.Run` 可能暂时掩盖问题，却增加线程栈、切换和下游压力。

| 工作类型 | 推荐边界 | 不应做 |
| --- | --- | --- |
| async I/O | 真正异步 API + deadline/cancel | 用 `Task.Run` 包住同步 IO 再无界排队。 |
| CPU 计算 | bounded worker/partition，按核心测 batch | 每请求开启长 CPU task。 |
| 外部依赖 | bulkhead semaphore + bounded queue | 让所有请求同时耗尽连接池。 |
| 长期专属 loop | 显式 service/actor owner | 假定 ThreadPool 会自然承担无限长期任务。 |
| Unity apply | 主线程有预算的 queue/phase | worker callback 直接改 Unity object。 |

任何资源池都要有 acquire timeout/deadline 和释放 `finally`。连接池、semaphore、channel capacity 也能参与死锁：所有 worker 拿到一个资源后又等待第二个有限资源，就可能形成资源耗尽循环。

## 线程池边界

- IO completion 不等于业务处理免费；回调中的解析、压缩、序列化仍占线程池/CPU。
- 长任务使用专用 worker、受限并发队列或 `TaskCreationOptions.LongRunning`（根据运行时验证），不要无界 `Task.Run`。
- 线程池 starvation 的症状是队列等待升高、请求尾延迟暴涨、CPU 不一定满。
- Unity 主线程不是线程池；后台任务结果必须以安全队列/主线程 phase 应用。

线程池健康要看队列等待、active/available worker、completed work rate、thread count、GC/CPU 和依赖延迟的时间关系。一个线程数增长、完成率下降、queue age 上升的窗口比“当前线程数是多少”更能说明 starvation。生产诊断用 trace/dump 采样线程栈和任务关联；不要只从一次 Debug.Log 推测。

## 验证

注入锁竞争、下游阻塞、同步等待和突发请求，采集线程池 active/queued、锁等待、线程数、CPU、P99 延迟和拒绝数。使用 dump/trace 找等待图，不靠日志猜测死锁。

| 注入 | 预期 | evidence |
| --- | --- | --- |
| 反序获取两锁 | 测试能超时/诊断环，修复后无环 | wait graph、thread dump、lock order trace。 |
| callback 在锁内重入 | 不会重入获取/长持锁 | callback trace、lock duration。 |
| sync-over-async | 不阻塞 single context；使用全 async path | continuation/thread timeline。 |
| DB/HTTP 慢 | bulkhead 满后有界拒绝，关键路径保留容量 | queue age、in-flight、P99。 |
| CPU burst | worker/queue 有上限，无 starvation | completion rate、CPU、thread count。 |
| Unity scene unload | 晚到结果丢弃且资源释放 | owner/generation、handle count。 |

对每个 timeout 区分“诊断保护”与“正常业务 deadline”。timeout 不是修复死锁；它让系统能失败并留下证据，根因仍要通过顺序、所有权、依赖或容量设计消除。

## 参考资料

- [learn.microsoft.com/dotnet/standard/threading/managed-threading-best-practices](https://learn.microsoft.com/dotnet/standard/threading/managed-threading-best-practices)
- [learn.microsoft.com/dotnet/standard/threading/the-managed-thread-pool](https://learn.microsoft.com/dotnet/standard/threading/the-managed-thread-pool)
