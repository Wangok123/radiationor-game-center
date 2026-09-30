---
slug: distributed-lock-lease-id
title: 分布式锁、租约与分布式 ID
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 4 分钟
tags: 分布式锁 | 租约 | 分布式 ID
summary: 明确 acquire、renew、release 的所有权合同，理解租约失效和分布式 ID 的时间边界。
---

# 分布式锁、租约与分布式 ID

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

分布式锁解决的是多个实例对共享资源的互斥协调，不等于业务幂等，也不自动提供正确的故障恢复。锁必须有唯一 token、租约/过期、持有者校验、续租和 fencing token，防止持锁实例暂停后恢复并覆盖新持有者。能用唯一约束、队列单 owner 或数据库原子条件替代锁时，通常更简单可靠。

## 锁协议的危险点

| 问题 | 后果 | 对策 |
| --- | --- | --- |
| client A pause 超过 TTL | B 获得锁，A 恢复后仍写共享资源 | fencing token，下游拒绝旧 token。 |
| 释放了别人的锁 | 资源被错误解锁 | compare-and-delete 唯一 token。 |
| lock service 分区 | 多方以为自己持锁 | 明确共识/租约语义，不宣称强一致。 |
| 临界区包含慢 RPC | 锁长期占用、吞吐下降 | 缩小临界区，异步任务改为状态机。 |

## 租约不是持有权的永久证明

客户端拿到带 TTL 的 lock token，只能说明在 lock service 的某个时间窗口获得了许可；GC pause、进程停顿、网络分区、时钟/续租延迟后，client 可能继续执行，而服务端已将租约授予 B。若 A 仍能写共享资源，单纯 Redis/lease lock 无法阻止旧 owner 覆盖新 owner。

```text
A acquires token=x, fencing=41; pauses beyond lease
B acquires token=y, fencing=42; writes resource
A resumes and attempts write with fencing=41
resource service rejects 41 because last accepted fencing is 42
```

fencing token 必须单调递增并由**被保护资源的下游**持久比较/拒绝旧值；只把 token 记在 lock client 日志中没有作用。数据库可用版本/条件 update，文件/对象存储需要支持条件版本，消息 consumer 可按 sequence/idempotency key 处理。若下游无法执行 fencing，锁协议不能声称能承受长暂停/分区。

## Acquire、Renew、Release 合同

| 操作 | 必须满足 | 常见错误 |
| --- | --- | --- |
| acquire | 唯一随机 owner token、明确 TTL、返回 fencing/version | 使用可猜 token 或把拿锁当业务完成。 |
| renew | 只允许当前 token 在未失效时续约，失败立即进入 lost 状态 | 网络超时后继续假定续租成功。 |
| release | compare-and-delete 当前 token | 无条件 delete 把新 owner 锁删掉。 |
| work | 每次副作用携带 fencing/idempotency | 只在 acquire 时检查一次。 |
| failure | TTL 后可接管，旧 owner 不能再写 | 无限 TTL 造成永久锁泄漏。 |

续租成功也不等于端到端安全：client 可能在发续租前已暂停，下游写可能先后交错。临界区应短、可重试/幂等、可从状态恢复；长事务/长任务更适合 queue + single owner、数据库状态机或 workflow，而不是不断续租。

## 先替代锁的结构化选择

锁常被用于掩盖没有定义不变量。按复杂度从低到高选择：

1. 唯一索引、乐观版本/conditional update 能否让冲突直接由权威存储裁决？
2. 能否按 aggregate/key 分区，使同一 key 的工作落在单 owner/actor/queue？
3. 能否使用幂等任务和状态机，让重复执行安全而不是互斥执行？
4. 是否真有跨实例、不可分割、下游可 fencing 的临界资源？才使用租约锁。

例如“同一用户只能领奖一次”用唯一键和 request id 比锁稳健；“按角色顺序处理事件”用 key partition 比全局锁可扩展；“确保定时任务只跑一次”仍需区分任务**触发一次**与结果**只生效一次**，后者靠幂等/fencing/状态机。

## 分布式 ID 的时间与顺序边界

ID 不应被混用为锁 token、排序版本和安全凭证。Snowflake 类 ID 的时间部分给近似趋势顺序，不保证跨节点的真实因果顺序；节点 id 冲突会直接产生重复；时钟回拨需要阻塞等待、拒绝生成、逻辑时钟或切换节点等明确策略。序列耗尽、跨 region、闰秒/NTP、部署配置和泄露生成速率也应纳入设计。

| ID | 优点 | 风险 |
| --- | --- | --- |
| DB sequence | 简单严格单点序 | 可用性/吞吐/跨 shard 依赖。 |
| UUIDv4 | 高可用、随机 | 索引局部性差、大小/可读性。 |
| UUIDv7/ULID 类 | 近似时间有序 | 时钟/实现差异、全局因果误解。 |
| Snowflake 类 | 紧凑、可本地生成 | node/time/sequence 配置与回拨。 |

对外暴露顺序 ID 可能泄露时间/规模；安全 token 需要不可预测随机性，不能复用时间有序业务 ID。

## ID 设计

ID 需要定义全局唯一、趋势有序、生成可用性、位数/存储、时钟回拨和隐私暴露。Snowflake 类方案通常包含时间、节点和序列位；时钟回拨、节点冲突和跨机配置必须有明确处理。数据库自增、UUIDv4、UUIDv7/ULID 各有索引局部性和可预测性取舍。

## 选择顺序

1. 唯一索引/条件更新能否表达不变量？
2. 能否把工作路由到单一 owner/partition？
3. 能否用任务队列和幂等消费代替锁？
4. 最后才选择分布式锁，并写清租约、fencing、故障和监控。

## 验证

注入持锁进程暂停、网络分区、续租失败、节点重启和时钟回拨。验收共享资源绝不接受旧 fencing token，锁泄漏可恢复，重复执行可识别，且等待/超时指标可观测。

| 注入 | 通过条件 | evidence |
| --- | --- | --- |
| owner pause 超 TTL | 新 owner 可工作，旧 fencing 被拒绝 | fencing sequence、resource write log。 |
| release races new acquire | 旧 token 不能删除新 lock | compare-delete trace。 |
| renew timeout/partition | client 停止有风险写入，状态可恢复 | lease/lost transition、retry。 |
| lock service restart | TTL/持久性语义符合声明，不永久泄漏 | acquire latency、recovery、owner state。 |
| clock rollback/ID node clash | ID 策略拒绝/等待/报警，不重复 | clock/node event、generated IDs。 |
| duplicate job delivery | 业务效果仍恰好一次或可解释 | request/event id、state machine。 |

## 参考资料

- [redis.io/docs/latest/develop/clients/patterns/distributed-locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [microservices.io/patterns/communication-style/idempotent-consumer.html](https://microservices.io/patterns/communication-style/idempotent-consumer.html)
