---
slug: database-replication-sharding-migration
title: 复制、分片与数据迁移
date: 2026-09-30
updated: 2026-09-30
category: 数据库
reading_time: 4 分钟
tags: 复制 | 分片 | 迁移
summary: 从读写语义、分片键、双写风险和 expand/contract 不变量设计数据库迁移。
---

# 复制、分片与数据迁移

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

复制主要解决读扩展和故障恢复，不自动提供跨副本强一致；分片解决单节点容量/吞吐上限，但引入路由、跨 shard 事务、重平衡和运维复杂度。迁移应优先采用 expand/contract：先兼容新旧 schema，回填并校验，再切换读写，最后清理旧字段，而不是一次性改表并祈祷。

## 复制风险

- replica lag 导致读到旧数据；写后立即读需要 stickiness、版本 token 或读主库。
- 故障转移可能丢失未复制提交、改变写入口；客户端需要重试/幂等和明确错误分类。
- 监控 replication lag、replay error、IO/SQL thread、failover 次数和数据校验差异。

## 复制拓扑先定义读写语义

复制不是一个“多一份数据”的按钮。必须明确复制方式、确认级别、读路由和故障域：

| 需求 | 需要的合同 | 常见误解 |
| --- | --- | --- |
| 写后立即读 | 主库 stickiness、commit version token 或满足条件的副本 | 任意 replica 都会马上看到刚提交的写。 |
| 读扩展 | 可接受 staleness 上限和 fallback | replica lag 只影响监控，不影响业务。 |
| 故障转移 | RPO/RTO、选主/围栏、写入口切换 | promote 后一定没有丢写或双主。 |
| 审计/分析 | 延迟 ETL/只读副本与保留窗口 | 分析查询不会影响复制回放。 |

异步复制中，客户端收到写成功后，副本可能尚未应用该事务；主库故障并提升落后副本时，最近已确认写可能缺失。同步/半同步配置能改变确认窗口，却仍要用具体实现和故障演练验证。读一致性不要靠 sleep：返回 commit/version token，读方等待副本追到该位置、路由主库或显示“结果处理中”。

failover 时还要防止旧主重新可写。选主、fencing/epoch、连接发现、DNS/代理缓存和客户端重试共同决定是否出现双写入口。所有写请求应带 idempotency key；连接错误后重试可能处于“提交成功但响应丢失”的未知状态，不能生成另一笔业务操作。

## 分片键选择

分片键应让主要查询带上路由字段、分布均匀、生命周期和扩容策略明确。热点用户、活动或时间范围会造成单 shard 倾斜；跨 shard 排行、事务和分页应在设计阶段说明退化语义。

### 路由、热点与跨 shard 边界

| 分片策略 | 好处 | 主要风险 |
| --- | --- | --- |
| hash(key) | 分布较均匀，点查容易路由 | 范围扫描/按时间查询跨 shard；热点 key 仍热。 |
| range(key/time) | 范围查询和归档自然 | 最新时间段/大租户造成热点。 |
| directory/lookup | 可按租户灵活迁移 | 路由表本身一致性/可用性成为依赖。 |
| geo/region | 延迟和数据主权友好 | 跨区用户、全局排行和灾备复杂。 |

分片键不是只看 hash 均匀性：主要读写必须携带 key，热 tenant/活动要能拆分或限流，删除/归档生命周期要可控。跨 shard 查询应选择明确策略：scatter-gather 加上页/超时预算、异步物化视图、专门的搜索/排行榜存储，或拒绝该查询。不能先“分库分表”再希望 ORM 自动解决全局排序和事务。

重分片是数据与路由协议：源 shard、目标 shard、路由版本、双读/双写或变更日志、cutover 条件、校验和回滚必须一起设计。迁移期间请求应根据 version 路由，避免一部分写仍到旧 shard、一部分读已转到新 shard。

## 迁移流程

```text
expand schema -> dual-read/compatibility -> backfill in batches
-> compare/checksum -> switch writer/reader -> observe -> contract
```

批量回填要限速、可暂停、可重试且不阻塞线上；双写必须处理失败、重复和顺序，不要把“同时写两处”误认为一致性协议。

### Schema expand/contract 的不变量

```text
v1 reader/writer
  -> add nullable/new table/index (expand)
  -> deploy reader compatible with v1+v2
  -> backfill in bounded idempotent batches
  -> dual-write or derived projection with reconciliation
  -> switch read/write via a measured cutover
  -> retain rollback window
  -> remove old field/code (contract)
```

新字段的默认值、null 语义、旧 writer 写入行为、索引构建影响和 rollback 都应预先定义。一次 DDL 是否在线、是否锁表、是否重建表，取决于引擎/版本/变更类型/数据量；不能把开发库几秒完成外推为生产无风险。

backfill 以主键/稳定游标分批，记录高水位、batch size、错误、速率和校验结果；每批幂等，可暂停/恢复。与线上写竞争时，需定义新旧值的权威顺序：只靠一次离线 copy 可能覆盖后续真实更新。可用 change log、版本号/updated_at 比较、双写+reconciliation 或短暂写围栏，但各自有丢失/冲突边界。

### 双写不是事务协议

应用依次写 A/B 时有四种结果：都成功、仅 A 成功、仅 B 成功、未知提交。重试还会重复。若 B 是异步投影，优先使用 outbox/CDC 将已提交事实传播，消费者按 event id/版本幂等；若确需同步双写，必须有可重放操作日志、对账和明确的 source of truth，不能在请求失败时简单“再写一遍”。

## 对账、切流与回滚

校验不应只比较总行数。按范围/tenant/时间分桶比较 count、checksum、关键字段、缺失/重复、最大版本和延迟；差异需能定位到具体 key 并重放。切流前明确：读写各从何时走新路径、旧路径保留多久、失败如何回退、是否会产生新旧数据分叉。

| 阶段 | 通过条件 | 回滚条件 |
| --- | --- | --- |
| expand | 旧版本完整兼容，DDL 指标在预算内 | metadata/锁影响超预算。 |
| backfill | 差异低于阈值且 lag 可控 | 错误、写压力或差异持续增长。 |
| dual/CDC | 传播延迟、重复和错误可解释 | 未知 source of truth 或 backlog 无法收敛。 |
| cutover | 新路由正确，读写/延迟/SLO 通过 | 错路由、数据差异、故障恢复失败。 |
| contract | 回滚窗口结束且旧读取为零 | 任一旧客户端/依赖仍在使用旧字段。 |

## 验证

在 production-like 数据分布中演练 replica 延迟、主故障/promotion、读后写 token、热点 shard、迁移暂停恢复、写入与 backfill 竞态、切流回滚。保留路由版本、schema 版本、复制位点、对账报告、错误样本和 RPO/RTO；没有这些产物，不能说“分片/迁移安全”。

## 参考资料

- [dev.mysql.com/doc/refman/8.4/en/replication.html](https://dev.mysql.com/doc/refman/8.4/en/replication.html)
- [microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
