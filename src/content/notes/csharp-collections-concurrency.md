---
slug: csharp-collections-concurrency
title: 集合、哈希表与并发边界
date: 2026-09-30
updated: 2026-09-30
category: C# 语言
reading_time: 4 分钟
tags: C# | 集合 | 并发 | 哈希表
summary: 理解哈希表的复杂度前提，以及 ConcurrentDictionary 没有替你解决的业务原子性问题。
---

# 集合、哈希表与并发边界

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

`Dictionary<TKey, TValue>` 用哈希定位 bucket，再在冲突链/条目中比较 key；平均查找接近 O(1)，但依赖稳定的 hash、相等性和足够容量。它不是线程安全容器。`ConcurrentDictionary` 保护自身结构的并发访问，却不能让你放进去的 value 或“先读后改”业务流程自动原子。先明确数据所有权与操作边界，再决定是单线程、锁、不可变快照还是并发容器。

## 哈希表工程约束

| 约束 | 原因 | 后果 |
| --- | --- | --- |
| key 的 hash/equality 在生命周期内稳定 | bucket 根据 hash 选择 | 可变 key 会变得无法查找或产生重复逻辑。 |
| 提前设置容量 | 扩容需要重新分桶 | 热路径扩容导致尖峰与分配。 |
| key 质量良好 | 冲突链决定退化程度 | 恶意/低质量输入可能退化并造成 CPU 风险。 |
| 枚举期间不修改普通 Dictionary | 版本号保护一致性 | 抛异常或逻辑错误。 |

### 平均 O(1) 的前提

哈希表先把 key 映射到 bucket，再按 equality 处理冲突。平均 O(1) 假设 hash 分布合理且负载受控；最坏情况仍可能接近 O(n)。扩容时需分配更大表并重新放置条目，因此偶发扩容会把容量增长变成某一帧的尖峰。

| 场景 | 建议 | 需要量化 |
| --- | --- | --- |
| 可预测的大量插入 | `EnsureCapacity` 或构造容量 | 峰值条目数与实际扩容次数。 |
| 长期缓存 | 设上限/淘汰策略，不把 capacity 当条目数 | live count、reserved capacity、命中和淘汰。 |
| 用户输入作为 key | 规范化并限制长度/数量，选择稳定 comparer | 冲突/哈希成本与最坏输入。 |
| 高频结构变化 | 评估数组索引、稠密 ID 映射或批处理 | 删除成本、缓存局部性、稳定 ID 语义。 |

HashCode 不应被持久化或作为跨进程协议 ID；哈希算法可随运行时/进程变化。存档、网络和 replay 使用稳定业务标识，集合内部 hash 只负责当前运行时查找。

### Equality 与可变 key

若 key 的参与 hash/equality 字段在插入后改变，条目仍在旧 bucket，而查询会计算新 bucket，表现为“明明存在却找不到”。对自定义 key，要让 `Equals` 与 `GetHashCode` 使用同一组字段，并满足相等对象 hash 相同。使用 comparer 把大小写、文化、路径规范化规则固定下来，避免平台/locale 变化改写 key identity。

浮点 key 尤其危险：`NaN`、`-0/+0`、epsilon 相等关系和坐标量化都会改变 equality 语义。空间查询通常应显式量化 cell coordinate 或使用稳定整数 ID，而不是任意把浮点坐标做哈希。

## 并发边界

```csharp
// 错误：两个线程可能都读到旧值，再各自写回。
if (scores.TryGetValue(userId, out var score))
    scores[userId] = score + reward;
```

即使替换为 `ConcurrentDictionary`，这个复合读改写仍不是你的业务原子单元。使用 `AddOrUpdate`、显式锁、单线程 actor，或把增量变成消息并由唯一 owner 消费。回调也可能被执行多次，因此不能在 `AddOrUpdate` 的 factory 内放发送邮件/发奖等外部副作用。

要区分线程安全的层级：

1. **容器结构安全**：并发读写不会破坏 bucket/entry 内部结构。
2. **单次方法原子性**：某次 TryAdd/Remove 是否不可分割地完成。
3. **复合业务不变量**：余额、计数、状态和事件是否一起更新且只做一次。
4. **value 安全**：集合中 `class` 对象的字段能否并发读写。

`ConcurrentDictionary` 只覆盖其文档规定的容器操作。`GetOrAdd`/`AddOrUpdate` 的 factory 可能在竞争下执行多次，虽然最终只有一个值被采用；factory 必须是无外部副作用、可重复计算的纯构造逻辑。若需要 exactly-once side effect，应将它放到成功获得 ownership 的后续流程，并用业务 idempotency 防止崩溃重试重复。

| 方案 | 适用 | 代价/限制 |
| --- | --- | --- |
| 单线程 owner / actor | 更新天然可串行，Unity 主线程状态 | 队列需有界，owner 可能成为吞吐瓶颈。 |
| `lock` | 多字段不变量、临界区短且明确 | 竞争、死锁和临界区外部调用风险。 |
| `ConcurrentDictionary` | 多线程独立 key 操作，value 更新边界简单 | 不提供跨 key 事务和 value 线程安全。 |
| immutable snapshot | 读多写少、读者需稳定视图 | 写时复制分配/复制成本，发布版本要原子。 |
| message passing | 所有权转移自然、能观察队列 | 延迟、排队、拒绝/背压协议需要设计。 |

## Unity 关联

- 每帧用 `Dictionary` 的枚举、闭包或装箱可能产生额外 GC；先用 Profiler 验证。
- 编辑器/主线程业务通常不需要 `ConcurrentDictionary`；为了“线程安全”引入并发容器反而掩盖所有权错误。
- Job/Burst 路径通常使用 `NativeParallelHashMap` 等原生容器，并受 allocator、dependency 和 dispose 生命周期约束。

普通 `Dictionary` 不是因为在 Unity 项目中就只能主线程用；它可以在单 worker 私有数据中安全使用。关键是存在写入时，不能在没有同步协议的情况下并发访问同一实例；多个线程只读且容器安全发布时可共享读取，且 Unity 引擎对象/API 不应因此被传入 worker。Native 容器提供 job safety/allocator 等不同合同，也不是 managed `Dictionary` 的透明替换：检查容量、并发写入权限、allocator 生存期、依赖和 dispose。

查询 API 的返回 ownership 也重要。返回内部可复用 List/array 会避免分配，但调用方若跨下一次查询保存就会读到被覆盖数据；返回新副本更安全但有分配成本。可以用显式 `CopyTo`、caller-provided buffer 或短期 borrow contract 让成本与所有权都可相关资源与写入权限仍需由明确的生命周期协议管理。

## 验证

用随机键做碰撞/扩容压力测试；并发场景记录丢失更新、重复处理、最大等待时间和吞吐。测量后再选择容器，不以类名决定架构。

测试至少分开：

- hash/equality 属性：相等 key 有相同 hash；插入后 key 不变；自定义 comparer 的边界稳定。
- 容量测试：典型与峰值 count 下的扩容次数、GC bytes、操作 P95/P99。
- 并发不变量：多线程增量后总值准确；重复 factory 执行不会触发外部副作用。
- 生命周期：读者持有 borrowed view 时 owner 是否禁止 mutation，或用版本/副本保证稳定。
- Unity Player：Editor 与 IL2CPP target 的实际分配和延迟，不拿微基准外推整帧收益。

## 参考资料

- [learn.microsoft.com/dotnet/api/system.collections.generic.dictionary-2](https://learn.microsoft.com/dotnet/api/system.collections.generic.dictionary-2)
- [learn.microsoft.com/dotnet/api/system.collections.concurrent.concurrentdictionary-2](https://learn.microsoft.com/dotnet/api/system.collections.concurrent.concurrentdictionary-2)
