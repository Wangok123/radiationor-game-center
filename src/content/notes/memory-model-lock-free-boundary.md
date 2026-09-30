---
slug: memory-model-lock-free-boundary
title: 并发、内存模型与无锁边界
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 5 分钟
tags: 并发 | 内存模型 | 无锁
summary: 区分原子性、可见性和有序性，明确 lock、Interlocked、volatile 与消息传递各自的合同。
---

# 并发、内存模型与无锁边界

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

并发 bug 的根源常不是“两个线程同时改变量”这么简单，而是可见性、原子性和操作顺序。`lock` 同时提供互斥和进入/退出的内存同步；`Interlocked` 适合单个原子状态转换；`volatile` 只处理特定读写的可见性，不让复合操作原子。优先选择清晰的所有权、消息传递或受锁保护的数据结构，只有测量证明锁竞争是瓶颈时才考虑无锁。

## 三个性质

| 性质 | 问题 | 示例 |
| --- | --- | --- |
| 原子性 | 操作会不会被观察到一半？ | `count++` 是读改写，不是原子操作。 |
| 可见性 | 写入何时被其他核心看见？ | 轮询 flag 可能读到过期值。 |
| 有序性 | 编译器/CPU 能否重排？ | 发布对象前必须先完成对象初始化。 |

## happens-before 是推理单位

并发代码不能凭“我先写了这行”推断另一线程一定按该顺序观察。要找同步边建立 happens-before：同一把 `lock` 的 unlock 到后续 lock、`Interlocked`/`Volatile` 的特定操作、任务/队列的完成与等待、JobHandle 的依赖，才让发布前写入对获取后读者具有可见/有序含义。具体 .NET/CPU 实现细节仍由运行时文档和目标版本约束。

安全发布的目标是：writer 初始化对象全部字段后，通过一个有同步语义的引用/标志发布；reader 先获取同一同步点，再读取对象。只把普通 reference 写到 static 字段，另一个线程可能看到引用但无法以此证明其余初始化的可见性。

```text
writer: initialize payload -> release/publish ready
reader: acquire/read ready -> consume payload
```

“单个 reference 赋值通常原子”不等于对象图发布安全；“字段是 `volatile`”也不让多字段 snapshot 自动一致。若读者需要 `x/y/version` 同时对应一个状态，使用 lock、immutable replacement、版本化 snapshot 或单 owner queue，而不是给每个字段各加 volatile。

## lock、Interlocked、volatile 的边界

| 工具 | 适合 | 提供 | 不解决 |
| --- | --- | --- | --- |
| `lock` | 多字段不变量、短临界区 | 互斥 + 进入/退出同步 | 锁外访问、锁内 IO/await、锁顺序循环。 |
| `Interlocked` | 单变量计数/CAS 状态转移 | 原子 read-modify-write 与内存顺序语义 | 多对象事务、外部副作用 exactly-once。 |
| `volatile` / `Volatile` | ready flag、取消标志等简单发布/观察 | 特定读写的可见性/排序 | `count++`、check-then-act、复合 snapshot。 |
| immutable snapshot | 读多写少、读者需一致视图 | 发布一个完整新值 | 写时复制成本、嵌套可变对象。 |
| single owner/message | 状态自然串行 | 所有权和顺序 | queue capacity、延迟、失败处理。 |

CAS 循环（compare-exchange）必须定义失败重试、退出/取消、ABA 和外部副作用。若 update factory 内会发事件/写数据库，CAS 失败重试可能执行多次，必须把副作用移到成功提交后或改为锁/事务协议。

## 无锁并不等于没有等待

lock-free 通常表示系统中至少有一个线程可推进；wait-free 表示每个线程在有界步骤内推进；它们都不自动保证公平、低尾延迟、内存安全或业务正确性。一个不停 CAS 失败的热点线程可能 starvation；一个无锁队列仍可能因满、消费者停止或 GC/缓存 miss 而等待。

ABA 是指值从 A 变 B 又回 A，CAS 只看见 A 而误以为状态未变。native pointer/可回收节点场景还需要安全内存回收（hazard pointer、epoch 等）；在托管 C# 中 GC 减少了悬垂对象回收问题，但复用对象、index/version、池化 handle 和业务状态仍可发生逻辑 ABA。多数 Unity 业务不应手写这类结构，优先标准容器、Job safety 或单 owner。

## 设计一个并发状态机

把共享变量写成有限状态和合法转换，而非多个 bool：

```text
Created -> Running -> Completing -> Completed
                   \-> Cancelled
```

每次转换由 CAS/lock 完成，返回值说明谁赢得 owner；winner 负责开始/清理资源，loser 不做重复副作用。对取消与完成竞态，定义先发生者、晚到结果释放、可观察终态和回调线程。比起 `bool started; bool cancelled; bool disposed;`，状态机更容易覆盖不可能组合。

## 选择策略

1. 能否把数据限制在一个线程或一个 job owner？这是最低复杂度方案。
2. 能否通过 immutable snapshot、channel/queue 消息传递转移所有权？
3. 需要临界区时，使用短、无外部调用、定义明确的 `lock`。
4. 仅当状态是单变量转换且失败重试语义清晰时使用 `Interlocked`。
5. 无锁容器要同时说明 ABA、内存回收、饥饿、公平性和测试策略；多数 Unity 业务不应手写。

先问读者是否真的需要共享可变状态。很多所谓锁竞争可以改为：worker 写私有 buffer，完成后按 JobHandle/queue 把 immutable result 交给主线程；或者将多次更新合并为一个 latest-value message。降低共享频率和缩小数据所有权范围，往往比手写无锁更能改善 P99 和可维护性。

## Unity 关联

Unity API 主要受主线程约束。Job System 通过 read/write 声明和 `JobHandle` 管理依赖；它不是允许任意线程共享 `GameObject` 的工具。把后台/Job 结果收敛到一个主线程应用点，避免半完成数据逃逸。

NativeContainer 和 Job 的读写声明形成的是另一套依赖/安全模型：producer job 写入、consumer job 依赖 producer，主线程在 `Complete` 后读取/Dispose。不要混用 managed `lock` 来“修复”没有声明的 job 依赖；也不要把 `GameObject`/`Transform` 当作可共享数据。主线程回流还要检查 owner/generation 和队列预算，相关资源与写入权限仍需由明确的生命周期协议管理。

## 验证

并发问题需要压力、随机调度和不变量检查。为生产者/消费者记录序列号、丢失数、重复数和最大队列长度；对锁竞争使用 Profiler/trace 测等待时间，而非凭直觉改无锁。

| 测试 | 不变量 | 产物 |
| --- | --- | --- |
| 多生产者/消费者 | 序列号无丢失/重复，FIFO 若合同要求 | seed、完整序列/差异、queue depth。 |
| publish/consume | reader 不观察半初始化 snapshot | 状态 hash、race trace。 |
| cancel/complete race | 仅一个终态 winner，资源只释放一次 | transition log、owner id。 |
| CAS hotspot | 有界 retry/公平性在压力下可接受 | retries、per-thread progress、P99。 |
| lock contention | 互斥不变量正确且等待在预算内 | lock wait、hold time、stack/trace。 |
| Unity lifecycle | scene unload 后无晚到 apply/Native use | generation、JobHandle/handle accounting。 |

普通单元测试通过只能证明某个调度下无错；引入随机 barrier、重复运行、线程/CPU 数变化、故障/取消注入和 trace 才能扩大覆盖。最终仍需目标 runtime/IL2CPP/设备验证，不能用桌面 .NET 微测试外推。

## 常见误区

- `volatile` 不能让 `if (!initialized) initialized = true` 变成原子。
- `ConcurrentDictionary` 不意味着其中 value 的复合更新自动线程安全。
- 用 `lock(this)` 或公开对象作为锁，会让外部代码意外参与锁协议。
- 锁内进行 IO、await 或 Unity API 回调，容易扩大临界区或死锁。
- “`volatile` 等于线程安全”：它不保护多字段不变量和复合操作。
- “CAS 成功一次就没有竞态”：忽略 ABA、失败重试、winner 资源和外部副作用。
- “无锁一定更快”：热点 CAS、cache line ping-pong、重试和不公平可能让尾延迟更差。
- “读到非 null 就已初始化”：普通引用发布没有构成完整的同步证明。

## 参考资料

- [learn.microsoft.com/dotnet/csharp/language-reference/keywords/lock-statement](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/lock-statement)
- [learn.microsoft.com/dotnet/api/system.threading.interlocked](https://learn.microsoft.com/dotnet/api/system.threading.interlocked)
