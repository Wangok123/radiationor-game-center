---
slug: idempotency-outbox-delivery
title: 幂等、Outbox 与至少一次投递
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 5 分钟
tags: 幂等 | Outbox | 消息
summary: 区分投递一次、处理一次和副作用一次，用状态机与 inbox/outbox 应对重复和崩溃。
---

# 幂等、Outbox 与至少一次投递

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

网络超时、进程崩溃和消费者重试会让同一请求或消息重复出现。不要依赖“恰好一次投递”的幻想；应让写操作以稳定 idempotency key 去重，消息使用 at-least-once 投递并由消费者幂等处理。Outbox 将业务状态和待发布事件放在同一数据库事务中，避免“数据库已提交但消息没发”或“消息已发但事务回滚”的双写不一致。

## 故障矩阵

| 时点 | 可能结果 | 需要的设计 |
| --- | --- | --- |
| 服务提交前崩溃 | 无状态变更 | 客户端安全重试。 |
| 提交后响应前断开 | 客户端不知道是否成功 | 使用 request id 查询/重放同一结果。 |
| DB 提交后 MQ 发布前崩溃 | 状态在、事件不在 | Outbox relay 补发。 |
| MQ 发布后 consumer 崩溃 | 可能重复投递 | consumer 按 event id 幂等。 |

## Outbox 结构

```text
business transaction:
  update domain table
  insert outbox(event_id, aggregate_id, type, payload, created_at)
  commit

relay:
  read unpublished outbox rows -> publish -> mark published
```

relay 的“发布成功但标记失败”仍会导致重复，所以消费者需要去重。清理 outbox 前必须满足审计/重放窗口要求。

## 先区分三个不同的“只做一次”

| 边界 | 要避免的重复 | 常用机制 | 仍不能保证 |
| --- | --- | --- | --- |
| HTTP/RPC request | 客户端重试重复创建订单/发奖 | idempotency key + stable stored result | 下游消息已处理。 |
| broker delivery | relay/consumer crash 后重复 publish/consume | at-least-once + event id | 外部副作用自动去重。 |
| consumer business effect | 同一 event 重复扣款/加道具 | inbox/unique event id + same transaction | 多个不同 event 的业务顺序。 |

Outbox 保证的是“本地业务写入”和“待发布意图”在同一个本地事务内提交。它不让 broker publish、邮件发送、支付调用或另一个服务的数据库写入自动变成原子操作；这些边界仍需要幂等、状态机、补偿或人工处理。

## 表结构与状态机

一个可运营的 outbox 记录至少应有稳定不可复用的 `event_id`、聚合/分区键、事件类型和版本、payload 或可靠引用、创建时间、可见/尝试状态。不要把“已发布”只做成无上下文 bool：故障分析需要知道谁在何时、为何重试。

```text
Pending --claim(lease)--> Publishing --broker ack--> Published
   ^             |             |
   |             v             v
   +------- retry_after <--- failure
```

| 字段/概念 | 作用 | 常见漏洞 |
| --- | --- | --- |
| `event_id` | consumer 去重与审计主键 | 按重试重新生成 id。 |
| `aggregate_id`, `sequence` | 分区与聚合内顺序 | 用全局顺序阻塞所有热点。 |
| `payload_version` | schema 演进 | 只存 type name，无法兼容旧 consumer。 |
| `attempt`, `next_attempt_at` | 有界退避与可观测性 | 每次失败立即重发造成风暴。 |
| lease owner/expiry | 多 relay 安全抢占 | worker 崩溃后记录永久卡住。 |
| published metadata | 审计、排障和清理 | 只删行，无法解释漏发/重复。 |

claim 策略必须适配数据库能力与并发数。多个 relay 不应同时持有同一行；lease 过期又必须允许接管。即使 claim 正确，broker ack 后进程崩溃仍会造成再次 publish，这是 at-least-once 的正常时序，consumer 去重不能省略。

## 发布顺序、分区和 payload

“按 created_at 扫描”通常不能给出业务顺序。若同一角色/订单/房间内事件必须有序，写入事务为该聚合分配单调 sequence，relay 使用该聚合 id 作为 broker partition key，consumer 检查重复、乱序和缺口。不同聚合通常不应追求全局顺序，它会把吞吐和可用性变成单点瓶颈。

payload 有两种常见策略：

| 方式 | 好处 | 风险/要求 |
| --- | --- | --- |
| 事务内写不可变 payload | 事件语义稳定，可重放 | outbox 体积、敏感数据、schema 版本需要治理。 |
| 写 domain reference，relay 再读取 | 表小、可取最新投影 | 读取时间点可能改变事件含义；需版本/快照合同。 |

业务事件应描述已经提交的事实，例如 `RewardGranted`，而不是含糊的“请发奖”。命令与事件混淆会让重放行为不可预测。

## 实现细节

- idempotency key 必须由调用方稳定复用，不能每次重试随机生成。
- 去重表需要业务作用域、状态、结果摘要和 TTL；TTL 不能短于最大重试/消息延迟窗口。
- 消费端先以唯一键记录 event id，再执行业务写入，或在同一事务中完成二者。
- 顺序不是默认保证。若聚合内有顺序需求，使用 partition key/sequence 并设计乱序和缺口处理。

### Consumer inbox 与外部副作用

最稳妥的 consumer 路径是将 `event_id` 的 inbox/dedup record 和本地业务更新放进同一事务：先插入唯一 `event_id`，冲突表示已处理；插入成功才执行效果。若 effect 是邮件、第三方支付、推送等外部系统，则本地 inbox 不能让外部调用原子化。需要让供应商侧也接受 idempotency key，或用独立状态机记录“请求已创建/已确认/待人工复核”。

```text
consume E
  -> begin local transaction
  -> insert inbox(E.id) unique
  -> apply local effect only if insert succeeded
  -> commit
  -> perform next externally idempotent step, or create another outbox record
```

不要在 broker callback 中先调用外部 API 再记 inbox；进程在两者之间崩溃时，下一次无法区分“未做”与“已经做但未记录”。

## 保留、重放与可观测性

outbox/inbox TTL 必须覆盖最大 client retry、relay 停顿、broker retention、consumer 延迟、审计和灾难恢复窗口。太短会在重复到达时失去去重记忆；太长会使热表、索引和备份成本持续增长。清理前应区分：已成功且超过重放窗口的记录、失败进入 DLQ 的记录、仍被 lease 的记录、需要审计保留的记录。

至少监控：pending age、pending count、publish latency、attempt distribution、lease expiry count、publish failure、consumer duplicate hit、inbox retention、DLQ count、按 aggregate 的顺序/缺口异常。只监控 broker lag 会遗漏“业务已提交但 relay 没有拿到事件”的本地故障。

## 验收演练

注入在四个故障时点的 kill -9、重复递送、乱序和 relay 重启。验收不是“日志没有异常”，而是余额/道具等不变量不被破坏、最终事件被送达、重复被计数且可解释。

| 注入点 | 应有结果 | 必须保留的证据 |
| --- | --- | --- |
| 本地事务 commit 前 kill | 无 domain change、无 outbox | DB state、request result。 |
| commit 后 relay 前 kill | relay 重启后最终 publish 一次或多次 | outbox state/history、broker records。 |
| broker ack 后 mark published 前 kill | 允许 duplicate，consumer effect 恰好一次 | event id、consumer duplicate counter。 |
| consumer effect 后 ack 前 kill | 再投递不重复生效 | inbox record、business invariant。 |
| 两 relay 抢同一批 | 至多一个有效 lease；过期可接管 | claim/lease timeline。 |
| 同聚合乱序/缺口 | 按规则等待、拒绝或补偿，不静默错序 | sequence trace、decision。 |
| schema N-1/N/N+1 | consumer 明确兼容/拒绝 | sample payload、version result。 |

验收结论需同时写出数据库、broker、consumer 和外部 effect 的边界。若只测到“消息最终出现”，不能声称资产、库存或支付没有重复。

## 参考资料

- [microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
