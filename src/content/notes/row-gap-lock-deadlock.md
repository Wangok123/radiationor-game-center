---
slug: row-gap-lock-deadlock
title: 行锁、间隙锁与死锁诊断
date: 2026-09-30
updated: 2026-09-30
category: 数据库
reading_time: 3 分钟
tags: 行锁 | 间隙锁 | 死锁
summary: 沿锁等待图还原事务时序，再按索引、访问顺序和 retry 合同修复死锁。
---

# 行锁、间隙锁与死锁诊断

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

InnoDB 的锁行为取决于索引、隔离级别、查询类型和访问顺序。行锁并不意味着只锁“这一行”；范围查询和 next-key/gap lock 可能阻止其他事务插入区间。死锁不是数据库“坏了”，而是并发事务形成循环等待；正确做法是保持一致加锁顺序、缩短事务、捕获死锁后有界重试，并保留诊断信息。

## 排查顺序

1. 记录事务 SQL、索引、隔离级别、开始/提交时间和参数。
2. 获取 deadlock report/锁等待图，找出循环边和持锁时间。
3. 比较事务访问表/行顺序，统一顺序或减少锁定范围。
4. 修复索引以避免扫描锁住大量记录；将外部 RPC 移出事务。
5. 仅对明确可重试的死锁做有限退避，业务结果必须幂等。

## 锁住的不是抽象“行”

InnoDB 锁的实际范围由访问路径决定：聚簇/二级索引、唯一性、谓词、隔离级别、普通读或 locking read 都会改变锁定记录/间隙。没有合适索引的范围更新可能扫描并影响远多于业务以为的记录；而唯一等值查询在不同条件下又可能比范围扫描窄。先看实际 SQL 和索引计划，再讨论 lock 名称。

| 语句意图 | 需确认 | 常见误判 |
| --- | --- | --- |
| 唯一键点更新 | 是否真走唯一索引、条件是否完整 | “WHERE id” 一定只锁一行。 |
| 范围领取/扫描 | 索引范围、隔离、当前读语义 | 只影响返回的几行。 |
| `SELECT ... FOR UPDATE` | 保护的业务不变量和锁范围 | 读到数据就天然串行。 |
| 插入 | 唯一检查、相邻 key gap、外键 | 新增一行不会和范围查询冲突。 |

next-key/gap 锁是 InnoDB 特定行为的一部分，细节随隔离级别、语句和版本而变。设计上更重要的是：范围谓词是否必要、索引是否精确、事务是否短、并发更新顺序是否统一。不要为“消灭 gap lock”随意降低隔离级别而不重新验证业务不变量。

## 从锁等待图还原时序

死锁至少有一个循环：T1 持有 A 等 B，T2 持有 B 等 A。诊断报告/等待图应还原每条边：

```text
T1: holds record/index range A -> waits B
T2: holds record/index range B -> waits A
victim: engine aborts one transaction
```

收集事务 id、SQL/绑定参数、隔离级别、表/索引/record/range、开始时间、已持锁时长、等待边和 victim。仅有应用 exception 文本不足以确定哪个索引/范围形成循环；仅看某一条 SQL 也无法知道它先拿了哪些锁。

常见模式：

1. 两事务以不同顺序更新同一组 account/inventory 行。
2. 一条范围更新/二级索引访问与另一条插入或唯一检查交叉。
3. 事务持锁后执行 RPC/慢逻辑，另一个事务积累并形成不同顺序等待。
4. 批处理按非稳定排序分批，不同 worker 拿到重叠记录且顺序不一致。

## 修复顺序与代价

| 修复 | 解决什么 | 要警惕 |
| --- | --- | --- |
| 一致的 key/table 加锁顺序 | 消除循环等待的一类根因 | 必须覆盖所有调用路径/批任务。 |
| 更精确索引/谓词 | 缩小扫描和锁范围 | 新索引有写成本，需验证计划。 |
| 缩短事务 | 降低持锁时长/碰撞窗口 | 不能把原子不变量拆坏。 |
| 分批/排序/分区 | 降低热点与每批锁数 | batch 之间仍需幂等/进度记录。 |
| 有界 retry | 处理不可避免偶发 victim | 不能掩盖高频死锁或重复副作用。 |

“提高 lock wait timeout”只改变等待多久，不打破死锁；“关闭 deadlock detection”可能把快速失败变成更长等待。除非有明确极端并发场景和替代检测/重试方案，不把它们当默认优化。

## 事务与 retry 合同

数据库会选择一个 deadlock victim 回滚；应用只可重试完整、无外部副作用或已具幂等保护的事务。transaction 内不能先发邮件、调用支付或发布不可撤销消息再等待数据库 commit。对领取奖励/扣库存等路径，request id 与唯一约束使 retry 返回同一业务结果；对冲突不等于瞬态错误的业务条件，不能无限重试。

```text
attempt with stable request_id
  -> begin short transaction
  -> deterministic lock/update order
  -> commit
deadlock victim -> bounded backoff + jitter -> retry whole transaction
unknown commit -> query request_id, not create a second operation
```

## 验证

用并发脚本重复触发冲突，记录 deadlock rate、lock wait P95、事务时长、回滚和重试成功率。避免用关闭死锁检测或盲目提高超时掩盖问题。

## 参考资料

- [dev.mysql.com/doc/refman/8.4/en/innodb-locking.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
