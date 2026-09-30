---
slug: managed-heap-gc-allocation
title: 托管堆、GC 与 Unity 分配
date: 2026-09-30
updated: 2026-09-30
category: C# 性能
reading_time: 4 分钟
tags: C# | GC | Unity | 性能
summary: 把 GC 卡顿拆成分配率、存活集、收集工作和原生资源四个可测量的问题。
---

# 托管堆、GC 与 Unity 分配

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

GC 管理托管对象的可达性，不管理纹理、网格、`NativeArray` 等所有原生资源。Unity 卡顿通常不是“GC 很慢”本身，而是帧热点持续制造短命对象，最终在收集时产生可见停顿。先用 Profiler 找到 `GC Alloc` 的调用点，再判断是去除分配、复用缓冲区、缩短引用链，还是接受冷路径分配。`Dispose` 解决的是原生资源所有权，不能替代托管对象可达性管理。

## 运行时模型

```text
GC root -> 静态字段 / 栈 / 活动对象 / 引擎桥接引用
        -> 托管对象图

不可达对象 -> 标记 ->（运行时与配置相关的）回收/压缩
```

讨论 GC 前先区分四个量：

| 量 | 回答的问题 | 常见误读 |
| --- | --- | --- |
| allocation rate | 每秒/每帧制造多少托管字节？ | `GC.Alloc` 出现一次就代表卡顿。 |
| live managed set | 当前仍可达的托管对象有多少？ | 托管 heap reserved 大就一定泄漏。 |
| collection work/pause | 哪一阶段、在哪些帧承担了收集成本？ | 所有平台/collector 都是一次 stop-the-world。 |
| native/resident memory | Unity/native/GPU 资源实际由谁持有？ | GC 后内存必须立即还给 OS/GPU。 |

分配率高但对象极短命，可能触发频繁收集；分配率低但静态集合无界增长，会造成 live set 和长期扫描成本；native handle 泄漏甚至可能没有明显 `GC.Alloc`。因此先判断哪一个量超预算，再决定删除分配、缩短引用链、释放 native owner 还是控制缓存容量。

Unity 常见托管运行时配置包含 incremental GC 等选项，但具体 collector、后端、平台和版本影响收集行为。增量模式将部分标记工作拆到多帧，目标是限制单次停顿，不等于总 GC 工作减少，也不保证每帧没有预算成本。应在目标 backend/设备上分别记录 collection、allocation 和长帧；不能用桌面 Editor 现象推断移动端 IL2CPP。

关键区分：

| 对象/资源 | 典型 owner | 释放方式 | 常见误解 |
| --- | --- | --- | --- |
| C# `class`、数组、委托 | 托管引用图 | 失去可达性后由 GC 回收 | `null` 不是立即释放。 |
| `NativeArray<T>` | 代码 owner | `Dispose` 或依赖完成后的 `Dispose(JobHandle)` | GC 不会替你释放底层 native allocation。 |
| Texture/Mesh/AssetBundle | Unity 资源系统 | 明确 unload/release 或生命周期管理器 | 托管包装对象消失不保证 GPU/原生内存立即释放。 |

## Unity 中高频分配源

- 热路径中的 `new`、数组重建、`List<T>` 扩容。
- LINQ、迭代器、捕获局部变量的 lambda、字符串插值/拼接。
- 通过接口传递值类型造成装箱；非泛型 API；反射。
- `GetComponents` 返回数组、部分 Unity API 的数组返回值、日志格式化。
- 每帧创建 `WaitForSeconds`、临时集合、闭包回调。

不要把以上列表当禁令。登录、加载、编辑器工具和低频 UI 路径的清晰代码可以分配；目标是让预算敏感的帧路径分配可预测。

不要仅凭语法判断 allocation：struct 是否装箱取决于调用点、接口/非泛型 API、泛型约束与运行时实现；闭包只在捕获状态时构造环境对象，迭代器/LINQ 分配也受具体 API 和 compiler lowering 影响。确认问题时以 target player 的调用栈和 allocation call stack 为准，再用最小代码差异验证。

把分配分成三类，优先级会更清楚：

1. **per-frame hot path**：随帧数稳定增长，先看每帧 bytes、调用次数和是否可合并。
2. **burst/transient**：场景加载、战斗开始或大批 spawn 时集中发生，关注 spike 与峰值存活。
3. **long-lived growth**：cache、事件订阅、池或 static collection 持续增长，关注 live set/root path 与上限。

## 排查流程

1. 在目标设备的 Development Build 上采集 CPU Usage 和 Memory 模块，不以 Editor 数据替代真机。
2. 找 `GC.Alloc` marker，定位具体调用栈，记录每帧字节数、频率和触发场景。
3. 对照内存快照：是短命垃圾、被静态事件/缓存意外持有，还是 native/asset 内存？
4. 设定验收指标，例如战斗 P99 帧小于 25ms、战斗帧 `GC Alloc` 为 0B，而不是笼统地“优化 GC”。
5. 修改后复测峰值、平均值和长时间运行；对象池也可能扩大常驻内存并延迟问题暴露。

一个有效修复闭环应同时回答：allocation 从哪来、修复改变了哪条调用路径、是否只在特定编译后端发生、是否把短命分配转成常驻内存、失败路径是否仍释放 handle。对疑似泄漏，比较同一稳定 workload 多次 capture/snapshot，并沿 root path 找仍可达对象及 owner；单张内存快照只能说明此刻存活，不能单独证明泄漏。

## 对象池的收益和账单

对象池把“频繁创建/回收”换成“预先/峰值创建 + 长期持有 + 生命周期复位”。它适用于创建/销毁频率高、对象成本可观、重置规则完整的同质对象；不是通用 GC 开关。

| 指标 | 池化前 | 池化后应同时检查 |
| --- | --- | --- |
| managed alloc/frame | 可能较高 | 是否下降，以及池自身是否还分配。 |
| native object count | 创建销毁波动 | 是否常驻峰值、是否真正归还。 |
| reset correctness | 新对象天然初始态 | event/Coroutine/粒子/Transform/owner 是否清干净。 |
| memory residency | 活跃对象数 | prewarm、peak、retained、trim/evict 策略。 |
| latency | Instantiate/Destroy spike | 首次扩容和池耗尽时的行为。 |

池必须定义 max capacity、池满策略、预热策略和释放/trim 语义。把池的可复用对象隐藏在静态字段中，可能把临时尖峰变成长期常驻，反而恶化低端设备内存压力。可见具体权衡见 [对象池：所有权与容量策略](object-pool-ownership.html)。

## 常见误区

- **“用对象池就不会 GC”**：池本身、字符串、回调和临时集合仍可能分配；池还可能保留过多内存。
- **“`Dispose` 等于 GC”**：前者通常处理非托管/原生资源，后者处理托管堆可达性。
- **“Editor 没 GC 就安全”**：IL2CPP、设备内存、代码裁剪和运行负载都不同。
- **“`GC.Collect` 能解决卡顿”**：它通常只改变卡顿发生的位置；除非在明确加载边界，否则不可作为常规方案。
- **“内存曲线不降就是泄漏”**：allocator/GC heap 可能保留 reserved capacity；应看 live object、root path、native resource 和重复稳定周期。
- **“增量 GC 就没有停顿”**：它调整工作分布，不消除分配、标记总量或平台差异。
- **“Addressables.Release 会降低 managed heap”**：它表达 asset handle ownership/release，不保证每一帧立即卸载所有依赖或把内存归还 OS。

## 参考资料

- [learn.microsoft.com/dotnet/standard/garbage-collection/fundamentals](https://learn.microsoft.com/dotnet/standard/garbage-collection/fundamentals)
- [docs.unity3d.com/Manual/performance-garbage-collection-best-practices.html](https://docs.unity3d.com/Manual/performance-garbage-collection-best-practices.html)
