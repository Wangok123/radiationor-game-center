---
slug: transactions-mvcc-isolation
title: 事务、MVCC 与隔离级别
date: 2026-09-30
updated: 2026-09-30
category: 数据库
reading_time: 5 分钟
tags: 事务 | MVCC | 隔离级别
summary: 从业务不变量出发理解 MVCC、锁、隔离现象和未知提交，而不是背异常现象清单。
---

# 事务、MVCC 与隔离级别

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

事务用原子性、一致性、隔离性和持久性约束一组操作。隔离不是开关，而是在异常现象、并发度和锁等待间权衡。以 InnoDB 为例，MVCC 通过版本记录和 read view 让普通一致性读尽量不阻塞写；但锁定读、范围更新和唯一性检查仍会加锁。设计写路径时先定义业务不变量，再选择约束、事务边界、隔离级别和重试策略。

## 先从不变量出发

例如“同一用户一天只能领取一次奖励”不能只依赖先查后插：两个并发请求都可能看到未领取。应至少有一个可由数据库执行的约束，例如 `(user_id, reward_id, date)` 唯一索引；事务和应用逻辑在该约束之上处理冲突与幂等返回。

## 隔离现象与手段

| 现象 | 描述 | 典型处理 |
| --- | --- | --- |
| 脏读 | 读到未提交数据 | Read Committed 及以上避免。 |
| 不可重复读 | 同一事务两次读到不同已提交版本 | 更强隔离、锁定读或业务重试。 |
| 幻读 | 范围查询的行集合改变 | Serializable、适当范围锁或改写数据模型。 |
| 写偏斜 | 两事务各自满足检查，组合后违反不变量 | 显式约束、锁定读或 Serializable。 |

不要只背“RC/RR 能否幻读”的简化结论。具体行为取决于数据库、普通快照读与锁定读、索引和查询形状；本文默认讨论 MySQL InnoDB，迁移到 PostgreSQL/SQL Server 时必须重新验证。

## MVCC 与锁不是替代关系

普通一致性读通常读取符合 read view 的历史版本。更新、`SELECT ... FOR UPDATE`、唯一索引冲突和范围修改仍需要锁来协调写入。长事务会延迟历史版本清理，扩大 undo/膨胀和复制压力，因此事务应短、无外部 RPC、无用户交互等待。

## 先写业务不变量，再选择并发控制

事务不能凭空恢复缺失约束。将每条写路径翻译为数据库可观察的条件：

| 不变量 | 脆弱写法 | 可执行的保护 | 冲突后的语义 |
| --- | --- | --- | --- |
| 每日奖励一次 | `SELECT` 未领取后再 `INSERT` | 唯一键 `(user_id, reward_id, day)` | 冲突返回第一次的稳定结果。 |
| 余额不为负 | 先读余额，再在应用层扣减 | `UPDATE ... SET balance=balance-? WHERE balance>=?` | affected rows 为 0 是业务失败，不是盲目重试。 |
| 只能卖一次库存 | 读库存后异步写回 | 条件 update、version column 或锁定读 | 冲突返回售罄/重读后决策。 |
| 聚合状态合法 | 两事务各读不同记录再更新 | 聚合行 version、显式锁或 Serializable | 明确 retry 或拒绝。 |

“先查后写”不是原子性。若结果必须可重放，还需 idempotency key；若写后要通知其它服务，还需 outbox。事务、唯一约束、条件更新和幂等键分别解决不同故障，不能相互替代。

## InnoDB 读的两种语义

本文的 MySQL 8.4/InnoDB 范围内，普通一致性读与锁定读不能混为一谈：

| 读取类型 | 主要目的 | 看到什么 | 对并发写的关系 |
| --- | --- | --- | --- |
| 普通 `SELECT` | 读取一致视图 | 由隔离级别/read view 决定的可见版本 | 通常不以读取本身加排他业务锁。 |
| `SELECT ... FOR UPDATE` / `FOR SHARE` | 读取并协调后续写 | 当前读语义 | 会参与锁竞争，范围与索引/谓词相关。 |
| `UPDATE` / `DELETE` | 修改当前记录或范围 | 当前可修改版本 | 需要记录/索引范围上的协调。 |

因此“MVCC 不加锁”是错误简化。MVCC 尽量降低读写互相阻塞，但写冲突、唯一性、范围更新、外键等仍受锁、索引和语句形状影响。使用 `FOR UPDATE` 前必须说明它保护哪个不变量；给一个大范围无索引查询加锁只会扩大竞争。

## 隔离级别不是异常开关

ACID 的“隔离”不等于所有历史都串行。脏读、不可重复读、幻读和写偏斜是观察现象，最终行为由引擎、隔离级别、普通/锁定读、索引和事务历史共同决定。对 InnoDB，不能把其它数据库的简表直接搬过来；把业务依赖的行为写成并发测试，才是可靠边界。

选择顺序应是：

1. 写下违反不变量的最小并发交错。
2. 优先用 unique/check/foreign-key/条件 update 等数据库约束消除非法状态。
3. 若必须读取后决策，明确锁定读、version compare-and-swap 或更强隔离。
4. 为死锁、序列化冲突和未知提交设计有界 retry 与幂等响应。
5. 用真实 schema、索引和隔离级别复现实验，而不是只读文档表格。

## 事务边界与未知提交

一条正确的事务应短到只包含数据库必须原子化的变更。认证、参数解析、远端 RPC、玩家等待、消息发布和慢 IO 都应在边界外。尤其要处理“commit 成功但响应在网络中丢失”：客户端不能另发一条业务请求，只能带同一 request id 查询或重放，服务端返回第一次的最终结果。

```text
client request(id=K)
  -> begin
  -> insert request/result record unique(K)
  -> conditional domain update
  -> insert outbox event
  -> commit
  -> return stored result for K
```

若连接在 commit 返回前断开，应用层并不知道到底有没有提交。任何按异常类型“猜测没成功”后直接再扣一次库存的设计，都会在这条时序上失效。

## 游戏/服务端写路径模板

```text
request id -> authentication -> validate input
           -> begin short transaction
           -> insert idempotency/reward record with unique key
           -> update balance/inventory guarded by version or condition
           -> commit
           -> publish event through outbox
```

失败时分类：唯一键冲突返回已完成结果；死锁/序列化冲突按有界退避重试；业务约束失败不重试；未知提交结果通过 request id 查询最终状态。

### 重试合同

| 失败类别 | 是否可重试 | 前提 | 记录什么 |
| --- | --- | --- | --- |
| deadlock / transient serialization conflict | 通常可有限重试 | 事务无外部副作用，request id 稳定 | attempt、SQL/lock report、最终结果。 |
| lock wait timeout | 视 workload 而定 | 先定位长事务和索引，不能只增 timeout | wait、阻塞者、重试率。 |
| unique conflict | 不是通用 retry | 要区分幂等重复与真实业务冲突 | key、返回的稳定结果。 |
| condition update 0 rows | 通常业务拒绝 | 无库存/版本过期的产品语义已定义 | 当前版本、预期条件。 |
| connection lost after commit | 不创建新操作 | 以同一 request id 查询 | request state、commit 结果。 |

重试必须有总 deadline、次数、退避和可观测性。无限快速重试会把锁竞争和数据库故障放大为重试风暴。

## 验证

- 并发 100/1,000 个相同领取请求，检查只成功一次且其他请求返回一致结果。
- 采集锁等待、死锁、事务时长、慢查询、undo/历史版本增长。
- 演练事务提交成功但响应丢失，客户端重试后不能重复发奖。

## 参考资料

- [dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)
