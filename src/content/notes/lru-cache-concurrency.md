---
slug: lru-cache-concurrency
title: LRU：缓存淘汰与并发设计
date: 2026-09-30
updated: 2026-09-30
category: 算法
reading_time: 4 分钟
tags: LRU | 缓存 | 并发
summary: 从 workload、容量成本、single-flight 和资源引用生命周期重新审视 LRU 的适用边界。
---

# LRU：缓存淘汰与并发设计

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

经典 LRU 用 hash map 定位节点、双向链表维护最近使用顺序，让 `Get`、`Put` 和淘汰都接近 O(1)。真实缓存还需要定义容量单位、TTL、加载并发、失败缓存、指标和线程安全；仅实现链表不等于可用于生产。

## 不变量

```text
map[key] -> unique node
head <-> most recently used ... least recently used <-> tail
node count == map count <= capacity
```

每次访问移动节点到 head；插入超过容量时从 tail 删除并同步移除 map。重复 key 必须更新同一节点，而非插入两个节点。

链表操作顺序也要保持不变量：移除 node 前确认它仍属于此 cache/generation；删除 tail 时不能让 callback 在 map/list 不一致的中间态运行。capacity 为 0、同 key 更新、value 为 null、weight 超预算、TTL 已过期但未访问都应有明确合同，而非只实现典型 `Get/Put` 典型操作序列。

## LRU 是 Workload 假设

LRU 假设近期使用的 key 更可能再次使用。scan 一次性访问大量冷 key 时会把真正热 key 从尾部挤出，称 cache pollution；频率更重要的工作负载可能适合 LFU/TinyLFU/segmented policy；固定业务优先级可能应显式 reserve/partition，而不是用最近访问时间隐式竞争。

| 策略 | 擅长 | 常见弱点 |
| --- | --- | --- |
| LRU | 时间局部性、简单 O(1) | scan pollution，热门/频率未必保留。 |
| TTL only | 数据新鲜度/自然过期 | 不控制热内存和容量峰值。 |
| LFU/aging | 长期热点 | 历史热点难衰减，维护更复杂。 |
| segmented/admission | 保护常驻工作集 | 参数和观测复杂。 |
| explicit pin/priority | 必须保留的配置/关键资源 | pin 无上限会失去淘汰能力。 |

先从真实 trace 计算 reuse distance、key/value/weight 分布、hit/miss 成本和失效窗口，再选择策略。只报告 hit ratio 会掩盖“命中的是便宜 key、关键 miss 仍打爆源站”；同时量化 miss latency、源站 QPS、eviction rate、tail hit latency 与内存。

## 容量是 Bytes/成本而不只是条目

entry count 适合大小接近的小对象；资源 cache 常需要 weight（字节、解压后内存、GPU/native cost、加载成本）和多预算。一个 100 MB entry 与 100 个 1 KB entry 不能同等对待。weight-based LRU 要定义连续淘汰、单 entry 超预算如何处理、已被借用对象是否可逐出、释放 owner 和异步 unload 时机。

TTL/absolute expiration 与 LRU 是正交：TTL 控制可接受陈旧度，LRU 控制容量压力。过期 entry 若只在访问时清理，冷 key 可能持续占用；后台 sweep 会增加 CPU/锁竞争。按 workload 选择 lazy/eager/批处理清理并记录 expired-but-resident bytes。

## 生产边界

- 缓存容量是 entry、字节还是成本？大对象需要 weight-based eviction。
- TTL 与 LRU 互补：LRU 管访问热度，TTL 管数据陈旧度。
- cache miss 时 single-flight 防止并发加载击穿；loader 失败是否缓存、多久重试？
- 并发下锁保护 map+list 的联合不变量；分段锁/现成库通常优于自写 lock-free LRU。

### Loader、Negative Cache 与 Single-Flight

cache miss 不是直接执行 loader。为每个 key/generation 定义一个 loading owner，其余 caller 的策略是有限等待、返回旧值、快速失败或订阅结果。loader 成功前不把半成品写 cache；失败结果是否 short negative-cache、是否可重试、异常是否共享、取消 waiter 能否取消共同 loader 都需明确。

```text
miss(key, generation)
  -> existing in-flight? join with caller deadline
  -> otherwise create one bounded loader owner
  -> success: validate version, atomically publish entry
  -> failure/cancel: complete waiters, clean in-flight, do not poison forever
```

不要在 cache global lock 下调用 loader/IO；它会让一个慢 key 阻塞所有 hit。in-flight map 也需容量/TTL，防止随机 key 攻击制造无界 task/lock entry。

### 并发与回调

map 和双向链表必须作为一个原子不变量保护；给 dictionary 和 list 分别上锁通常会形成锁顺序/短暂错配 bug。读写锁、分段 cache 或现成 cache 可降低争用，但 eviction/计数/loader 仍可能需要协调。eviction callback、Dispose/unload、事件通知在锁外执行，并携带 entry generation；否则回调重入/慢释放会阻塞 cache 或误释放已重新插入的 key。

Unity 资源缓存还要区分“cache 不再持有”和“所有 consumer 已 release”。淘汰 Addressables handle/对象池资源不能直接销毁仍被 borrower 使用的对象；owner、引用计数/lease 或显式 pin 协议必须可观测。相关资源与写入权限仍需由明确的生命周期协议管理。

## 验证

用引用实现/小容量手工序列验证淘汰顺序；随机操作检查不变量。并发压力检查重复 loader、容量超限、死锁和命中率；真实工作负载还需比较 hit ratio、内存、tail latency 和源站 QPS。

| 测试 | 通过条件 |
| --- | --- |
| 引用模型随机序列 | key/value/order/eviction 与慢速模型一致。 |
| capacity/weight 边界 | map/list/bytes 不超限；超大 entry 策略明确。 |
| TTL/版本竞态 | 旧 loader/过期 entry 不覆盖新 source version。 |
| single-flight burst | 每 key generation loader 有界，waiter deadline 生效。 |
| 并发/回调 | 无死锁、重复 node、错误释放；callback 不在锁内。 |
| trace replay | hit/miss、源站、P99、resident/evicted bytes 达预算。 |

## 参考资料

- [learn.microsoft.com/dotnet/api/system.collections.generic.linkedlist-1](https://learn.microsoft.com/dotnet/api/system.collections.generic.linkedlist-1)
- [learn.microsoft.com/dotnet/api/system.runtime.caching.memorycache](https://learn.microsoft.com/dotnet/api/system.runtime.caching.memorycache)
