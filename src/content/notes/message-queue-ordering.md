---
slug: message-queue-ordering
title: 消息队列、分区与事件顺序
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 4 分钟
tags: 消息队列 | 分区 | 事件
summary: 厘清顺序作用域、投递语义、重试与 DLQ，以及 lag 之外的恢复和容量指标。
---

# 消息队列、分区与事件顺序

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

消息队列解耦生产/消费速率、提供缓冲和异步处理，但会引入重复、延迟、乱序、堆积和重放。先定义消息的投递、顺序、保留和幂等语义，再选择 partition key、消费组、重试/DLQ 和容量。全局顺序通常昂贵，更多时候只需要同一聚合内有序。

## 关键设计

| 问题 | 必须回答 |
| --- | --- |
| 分区键 | 哪个实体需要顺序？是否会热点？ |
| 投递语义 | at-most/at-least/exactly-once 的边界在哪里？ |
| 重试 | 哪些错误可重试？退避、最大次数、DLQ 如何处理？ |
| 保留 | 重放/审计窗口多长？磁盘与隐私如何处理？ |
| 堆积 | lag 到什么阈值限流、扩容或降级？ |

消费者应以 event id/业务键幂等，不能依赖“消息只到一次”。事件 schema 需要版本兼容、未知字段处理和 producer/consumer 发布顺序。

## 顺序的作用域必须小于系统

队列通常只能在一个 partition、一个 consumer group 分配、特定配置的范围内提供顺序。全局顺序要求所有消息经同一序列瓶颈，吞吐、可用性和热点都会很差。先问“哪个聚合的哪个不变量需要按序”，再选择 partition key 和 sequence：

| 需求 | 合理顺序域 | 设计方式 | 风险 |
| --- | --- | --- | --- |
| 角色 inventory 事件 | `player_id` | 同 key 分区 + per-player sequence | 大户/脚本玩家热分区。 |
| 订单状态机 | `order_id` | 聚合版本/sequence + 幂等 consumer | 跨订单流程另建协调协议。 |
| 聊天房间 | `room_id` 或 shard | partition key + 房间内 sequence | 超大房间需拆分/限速。 |
| 全局排行榜 | 通常不需全局事件顺序 | 分区写入 + materialized view | 排名快照可有最终一致延迟。 |

producer 重试、broker failover、consumer rebalance、多个来源和跨 partition 消费都会造成重复或相对顺序变化。consumer 对每个聚合维护“最后已应用 sequence/版本”，将小于等于的事件视为 duplicate/stale；遇到 gap 时根据业务选择等待、查询权威状态、重放或进入隔离队列，不能静默跳过。

## 投递语义不等于业务 exactly-once

| 术语 | 常见含义 | 仍需应用处理 |
| --- | --- | --- |
| at-most-once | 不重试/先 ack，可能丢 | 是否允许丢、如何观测。 |
| at-least-once | 失败会重试，可能重复 | event id 幂等、去重保存期。 |
| broker exactly-once | 特定 producer/transaction 范围的协议 | consumer 外部 DB/API 副作用。 |
| business exactly-once | 一个业务效果只生效一次 | 稳定业务 key、事务/inbox、外部 idempotency。 |

不要把“Kafka/某队列开启 exactly-once”直接翻译为支付、发奖或邮件恰好一次。进程可能在本地 effect 成功和 ack/offset commit 之间崩溃；外部系统可能不参与 broker 事务。将 inbox/event id 与本地 effect 写入同一事务，外部调用使用 idempotency key 或状态机，详见 [幂等、Outbox 与至少一次投递](idempotency-outbox-delivery.html)。

## 消费循环、重试和 DLQ

消费端需有一个明确状态机：读取、验证 schema、幂等检查、业务处理、提交 offset/ack、失败分类。不能对所有异常无限即时重试：坏 payload、权限错误、不可兼容 schema 和永久业务冲突会阻塞同一分区；瞬态 DB timeout/网络错误才适合有界退避。

```text
valid event -> process idempotently -> commit/ack
transient failure -> retry with attempt + backoff + deadline
permanent failure -> quarantine/DLQ with original payload + reason + metadata
unknown ordering gap -> hold/reconcile/replay according to aggregate contract
```

DLQ 不是墓地。它必须有 owner、报警、查看权限、replay 工具、去敏策略、保留期和重新投递的去重/顺序规则。直接把 DLQ 原样塞回主 topic 可能在修复前形成无限毒消息循环，或打乱后续版本。

## Lag 是队列时间，不是单一健康指标

lag 需结合到达率、消费速率、消息大小、partition skew 和最老消息年龄解释。积压条数小但每条很大，或条数大但全是过期 telemetry，用户影响不同。用 Little 定律可以估算稳定排队时间，但吞吐不足时 lag 会持续增长；扩 consumer 只在 partition 足够、下游可承受且热点不集中时有效。

| 症状 | 首先检查 | 典型错误 |
| --- | --- | --- |
| 单 partition lag 高 | key skew、慢 key、consumer 处理时间 | 盲目增加同 group consumer。 |
| 所有 partition lag 高 | 下游/DB 饱和、全局输入增大 | 只扩 broker，继续压垮下游。 |
| rebalance 后重复 | offset/ack 与本地 effect 时序 | 关闭重试而牺牲可靠性。 |
| DLQ 增长 | schema/毒消息/业务规则变更 | 只清空 DLQ。 |
| 延迟突然升高 | queue wait、批量、GC、网络、依赖 | 只看消息数。 |

## Schema 与演进合同

事件至少包含 event id、type、schema version、aggregate id/version、发生时间和 trace/correlation id。字段演进要定义未知字段、缺失默认值、弃用窗口和 producer/consumer 部署顺序；不可复用旧字段含义。消费者应先能接受新 schema 的兼容形式，再发布 producer；跨多个团队/版本需做 contract test 和历史 payload replay。

payload 内不要带不受控的类型名或敏感信息。大 payload 影响 broker、复制和 replay；可存不可变对象引用/内容地址，但重放时需保证引用的可用性与版本，而不是读取“当前最新”的可变对象。

## 容量与恢复设计

写下 retention、磁盘、replication、最大消息、批大小、压缩、consumer 并发、backpressure 和 replay 时间预算。恢复不是只重启 consumer：需要算“积压 X 条、每秒稳定处理 Y 条、且正常流量仍在进入”时的清空时间；恢复过程可能需要限流、临时扩容、按优先级跳过过期数据或回填物化视图。

## 验证

注入 consumer 崩溃、重复/乱序消息、分区热点、下游慢和 broker 重启。记录 lag P99、重试率、DLQ、处理时延、重复业务命中和恢复时间。

| 故障 | 通过条件 | evidence |
| --- | --- | --- |
| effect 后 ack 前崩溃 | 再投递不重复业务效果 | inbox/event id、offset 与 DB trace。 |
| 同聚合乱序/gap | 明确等待/重放/拒绝，不静默错状态 | aggregate sequence trace。 |
| poison payload | 不永久阻塞分区；DLQ 可诊断可重放 | reason、schema、attempt、owner。 |
| 分区热点 | 其它 key 不饥饿，热点有策略 | per-partition lag/CPU/throughput。 |
| 下游慢/不可用 | bounded queue/retry，不形成 retry storm | in-flight、deadline、DLQ、恢复曲线。 |
| schema N-1/N/N+1 | 明确兼容/拒绝 | fixture payload、contract test。 |

保留原始事件、版本、broker/consumer 配置、partition assignment、处理日志、metrics 和 replay 命令。没有这些，无法区分 broker 丢失、producer 未发、consumer 重复或业务去重缺陷。

## 参考资料

- [kafka.apache.org/documentation](https://kafka.apache.org/documentation/#intro_concepts_and_terms)
- [microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
