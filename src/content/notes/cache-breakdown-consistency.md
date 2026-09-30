---
slug: cache-breakdown-consistency
title: 缓存设计、击穿与一致性
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 5 分钟
tags: 缓存 | 一致性 | Redis
summary: 从 source of truth、陈旧窗口和并发重建协议设计可退化的缓存系统。
---

# 缓存设计、击穿与一致性

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

缓存是以一致性、内存和复杂度换取延迟与下游容量。设计时先明确缓存的是哪类数据、允许多旧、失效后谁重建、失败时如何退化。cache-aside 常用：读 miss 时加载源数据再写缓存；写入先更新源数据再失效缓存。它不提供强一致性，必须用版本、TTL、消息失效或读修复控制窗口。

## 问题分类

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 穿透 | 查询不存在 key，每次都打到源站 | 参数校验、短 TTL negative cache、布隆过滤器。 |
| 击穿 | 热 key 失效，大量请求并发回源 | single-flight/互斥重建、逻辑过期、预热。 |
| 雪崩 | 大量 key 同时失效或缓存集群不可用 | TTL 抖动、多级缓存、限流、降级、容量隔离。 |
| 脏读 | 更新和失效竞态、消息延迟 | 版本号、短 TTL、顺序化失效、读修复。 |

## 先定义 source of truth 与可接受陈旧度

缓存策略不是先选 Redis 或本地内存，而是先定义数据的权威来源、读写路径和陈旧窗口：

| 数据类别 | source of truth | 可接受陈旧度 | 常见策略 | 不能做 |
| --- | --- | --- | --- | --- |
| 公开配置/静态表 | 版本化内容存储 | 分钟/发布周期 | CDN + 本地/进程缓存，版本 key | 用无版本 key 覆盖后希望所有客户端立刻一致。 |
| 玩家资料读模型 | DB/事件投影 | 秒级或明确版本差 | cache-aside + version/TTL | 写后随便读 replica/cache 并假定刚更新可相关资源与写入权限仍需由明确的生命周期协议管理。 |
| 库存/余额/权限 | 事务性存储 | 通常不可用陈旧值作写决策 | 条件更新/权威读；缓存仅做展示 | 用 cache value 决定扣减或授权。 |
| 排行榜/推荐 | 专用排序/投影 | 可接受最终一致 | materialized cache + snapshot/version | 将刷新延迟伪装为实时强一致。 |
| negative result | 权威源的“当前不存在” | 短且有上限 | negative cache + 参数校验 | 对刚创建资源长时间缓存不存在。 |

TTL 限制单个缓存项的存活时间，不能独自保证端到端陈旧度；从落后副本回填、多级缓存和过期后仍返回旧值都会改变实际窗口。缓存可能在 TTL 内就因 eviction/restart 丢失，也可能因客户端/本地层滞留更久。对写后读、权限撤销、价格/库存等路径，需定义 version、主库 stickiness、主动失效或直接权威读，而不是把 TTL 调短后假定强一致。

## cache-aside 的读写时序

```text
read:
  cache hit -> validate version/age if needed -> return
  miss      -> bounded source read -> populate with ttl/version -> return

write:
  validate -> transactionally update source of truth -> commit
           -> invalidate/update cache through ordered protocol
```

“先更新 DB，再删除 cache”通常比先删后写更少让读者长期回填旧值，但两者都存在竞态：写者 commit 后删除失败、读者在旧值未删前返回、删除后读者从落后 replica 读到旧值再回填。缓解需匹配风险：版本化 cache entry（只接受不低于当前版本）、outbox/CDC 失效、延迟二次删除、读修复或写后主库读。没有一个通用“标准两步”能保证所有跨存储强一致。

缓存 entry 应包含 value、source/version、写入/过期时间和 namespace/schema version。更新时必须拒绝旧版本覆盖新版本；invalidation message 要带 key/version 并可重复处理。若 source 只能提供时间戳，要定义时钟/同值冲突语义，不能把 wall clock 当绝对单调版本。

## 击穿与重建是一个并发协议

热门 key 到期会使许多请求同时回源。single-flight 的目标是让同一 key 同一 generation 最多一个 rebuild owner，其余请求等待有限时间、返回陈旧值或快速拒绝：

| 策略 | 好处 | 风险/约束 |
| --- | --- | --- |
| per-key single-flight | 限制同 key 回源并发 | lock/map 自身要有上限、timeout 和 cleanup。 |
| logical expiry + stale-while-revalidate | 低尾延迟，后台刷新 | 需定义最大 stale age 与刷新失败行为。 |
| refresh ahead/prewarm | 降低可预测热点首 miss | 预测错误会浪费容量，热点变化仍会击穿。 |
| distributed lock | 跨进程合并重建 | lease 丢失/过期、owner crash、锁服务故障和 fencing。 |
| source rate limit | 保护权威源 | 需让用户看到可解释降级，而非无限排队。 |

不要持有全局锁等待源站/HTTP/DB；也不要因 rebuild timeout 立即让每个 waiter 成为新 owner。重建结果要带 generation/version，晚到的旧 rebuild 不能覆盖更新后的 source 数据。

## 穿透、雪崩与容量

negative cache 的 TTL 应短于资源创建传播/重试窗口，并对不存在 key 的基数设置上限；Bloom filter 可以快速拒绝明显不存在项，但会有 false positive，且更新/重建/内存成本要定义。它不是授权机制，也不能取代源站校验。

雪崩防护涵盖更多层：TTL jitter 防同步到期、multi-level cache 防单点、预留源站容量、request coalescing、限流/降级、cache cluster failover 和恢复时 warm-up。随机 TTL 只能打散定时失效，不能解决 cache 全挂、热 key 或回源本身过慢。

容量预算应按 key 数、value size 分布、metadata、复制、过期/淘汰、热点和 working set 算。hit ratio 很高仍可能有最热 1% key 打爆单 node；需要观察 per-key/per-shard QPS、eviction、memory fragmentation、rebuild concurrency、stale age 和源站 miss amplification。

## 设计问题

- TTL 是业务陈旧度预算，不是随手填的数字；配合 jitter 防止同步失效。
- 不能缓存无限增长的高基数数据；要定义 namespace、最大容量、淘汰策略和热点保护。
- 不要把 cache miss 当异常直接无限重试。源站失败时返回陈旧但可接受的数据，或明确失败。
- 缓存 key 包含租户、区域、语言、版本等影响结果的维度，防止数据串用。

key 是协议：写出 namespace、tenant、locale、permission scope、schema/content version 和哈希/编码规则。省略权限或区域维度会造成跨用户/跨区数据泄露；把整个对象序列化后拼接超长 key 又会增加内存与排障成本。迁移 key 格式时采用新 namespace + 双读/回填 + 观察 + 旧 key TTL/清理，避免新旧 serializer 相互覆盖。

本地 L1 与共享 L2 也有一致性差异：L1 更快但每个进程独立，失效广播丢失时会在各实例保留不同旧值；L2 restart 会造成全体 L1 miss/回源。明确每层最大 age、失效通道、容量上限和重启行为，不把“多级缓存”当成免费可用性。

## 验收指标

hit ratio 只是一项指标；还需 cache/源站的 p95、重建并发、内存淘汰、陈旧数据比例、失效消息延迟和降级次数。用热 key 过期、全量失效、cache restart、源站慢四种故障演练验证设计。

| 注入 | 通过条件 | evidence |
| --- | --- | --- |
| 热 key 同时过期 | 每 generation 回源有界，P99 不排队失控 | rebuild owner/waiter、source QPS、queue age。 |
| 写后 delete/消息失败 | 读到旧值的窗口符合 version/staleness 合同 | entry version、outbox/invalidation trace。 |
| source 慢/不可用 | 陈旧值/拒绝符合数据等级，资源不耗尽 | stale age、error、bulkhead、fallback。 |
| cache restart | 回源被节流，关键路径仍有容量 | miss burst、source CPU、recovery time。 |
| 高基数不存在查询 | negative cache/filter 不无限增长 | key count、memory、false positive/源站 QPS。 |

## 参考资料

- [redis.io/docs/latest/develop/using-commands/keyspace](https://redis.io/docs/latest/develop/using-commands/keyspace/)
- [redis.io/docs/latest/develop/reference/eviction](https://redis.io/docs/latest/develop/reference/eviction/)
