---
slug: covering-index-query-plan
title: 覆盖索引、回表与索引失效
date: 2026-09-30
updated: 2026-09-30
category: 数据库
reading_time: 4 分钟
tags: 索引 | 查询计划 | 性能
summary: 理解覆盖索引和回表成本，结合选择性、排序与 EXPLAIN 判断索引是否真的有效。
---

# 覆盖索引、回表与索引失效

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

覆盖索引是查询所需列都能从索引叶子页得到，避免再根据主键回表读取数据页；它可能减少随机 IO，但会增加索引大小和写放大。所谓索引“失效”不是绝对开关，而是优化器基于数据分布、成本、谓词和隐式转换选择了不使用或低效使用索引，必须用真实计划验证。

## 典型原因

- 对索引列做函数/表达式，无法直接按原始有序值定位。
- 隐式类型转换、字符集/排序规则不匹配。
- 前导列没有约束，组合索引无法利用后续列定位。
- 选择性太低，全表扫描成本更低。
- `LIKE '%x'`、大范围查询、统计信息过期或数据倾斜。

## 覆盖的代价模型

InnoDB 二级索引叶子保存二级键和主键；查询投影、过滤和排序若都可由叶子满足，优化器可避免按主键回到聚簇索引读取整行。覆盖不是“永远更快”：宽索引会降低每页条目数、增加 buffer pool 压力和 insert/update/delete 维护；表很小、缓存很热或返回行极少时回表成本可能不显著。

| 查询部分 | 能否由索引覆盖 | 含义 |
| --- | --- | --- |
| WHERE 前缀/范围 | 索引键列 | 缩小需扫描的连续 index range。 |
| SELECT 投影 | 索引中已有列/主键 | 避免为取列回表。 |
| ORDER BY | 与索引顺序一致的键序 | 可避免额外排序，但须检查方向/范围/前导列。 |
| GROUP BY / DISTINCT | 特定有序键形状 | 可能流式聚合，不能凭字段名假定。 |

例如 `(user_id, status, updated_at, item_id)` 对 `WHERE user_id=? AND status=? ORDER BY updated_at DESC, item_id DESC LIMIT ?` 可能同时服务过滤和排序；若还只取 `item_id/updated_at`，就可能覆盖。若加入一个大 `description` 只为覆盖，索引体积和写代价很可能超过回表收益。先说明返回列和分页 API，再决定是否覆盖。

## 何谓“索引失效”

索引不是二元开关。至少区分：

1. **无法形成可用范围**：在列上做不等价函数/隐式转换、缺前导键、前缀通配符等。
2. **可使用但筛选差**：低选择性、范围过大、数据倾斜，扫描索引再回表比全表更贵。
3. **可过滤但不能满足排序/投影**：仍可能走索引，却要 filesort/temporary/回表。
4. **统计/代价误判**：estimate 与 actual 差异大，优化器选择不佳计划。
5. **查询语义阻止变换**：collation、NULL、函数、参数类型、隔离/锁定读等需要具体验证。

把列放在函数左边常破坏原始 B+ 树顺序，例如 `WHERE DATE(created_at)=?` 可考虑改成确定边界的范围 `created_at >= ? AND created_at < ?`，前提是时区/日期语义已定义。不要为了索引把业务语义偷偷改掉；若表达式就是领域模型，可评估生成列/功能索引（依版本）并测写成本。

## 组合索引与排序陷阱

组合索引按字典序排列。等值约束前导列后，后续列更容易服务 range/order；前导列范围通常会限制后续列作为连续定位前缀的能力，但后续列仍可能用于覆盖/过滤。`ORDER BY` 能否用索引还受 WHERE、排序方向、join 输出顺序、表达式和 collation 影响。

```sql
-- 稳定 keyset 分页：索引应匹配 user_id、排序和唯一 tie-break
WHERE user_id = ?
  AND (updated_at, item_id) < (?, ?)
ORDER BY updated_at DESC, item_id DESC
LIMIT 50;
```

没有唯一 tie-break 的 offset/keyset 分页在同值排序键下会重复或漏项；这不是数据库“随机”。若 updated_at 可修改，游标跨页时的重排也需产品/API 明确允许或使用 snapshot/version。

## 诊断

使用 `EXPLAIN ANALYZE` 比较 estimated rows、actual rows、扫描行数、回表和排序；然后以代表性数据、冷/热缓存和并发重测。不要仅看到 `type=range` 就认为快，也不要仅看到 `ALL` 就认为必然错误。

读计划时从访问树而不是单字段结论出发：访问哪个索引/范围、估计与实际 rows、loops、过滤发生位置、排序/临时表、总耗时和返回结果正确性。`EXPLAIN ANALYZE` 会实际执行查询，生产环境只对安全、受控的代表查询使用；它不是无副作用诊断命令。

对比冷/热缓存、典型和极端 tenant、读写并发，以及旧/新索引的写路径。数据分布随时间改变，新增索引刚好使测试数据快不证明长期有效；保留 plan、统计信息时间、schema/index DDL、参数样本和性能时间序列。

## 索引变更与回滚

新增索引是 schema 变更：不同 MySQL 版本/表结构/DDL 类型对在线性、锁和重建行为不同。上线前明确 build time、写放大、replication lag、磁盘余量、abort/rollback 和可观察指标。删除索引前检查唯一约束、外键支撑、其他查询的前缀使用、报表/批任务和回滚依赖。

| 阶段 | 通过条件 | 失败处理 |
| --- | --- | --- |
| 离线/预发 | 代表数据计划与结果正确 | 调整列顺序/查询，不直接上生产。 |
| 建索引 | DDL/复制/磁盘在预算内 | 暂停或回滚 DDL，保护写 SLO。 |
| 灰度查询 | P95/P99/扫描行改善，写不退化 | feature flag/查询回退。 |
| 稳定观察 | 多周期/热点参数保持收益 | 留下 plan/指标，必要时移除。 |

## 验收

记录查询 P95/P99、行扫描、逻辑读、索引大小、写入吞吐和迁移成本。覆盖索引只有在读收益超过这些长期成本时才值得保留。

再加入：结果集等价、稳定分页、读写混合下的锁/复制影响、估计与实际行差、冷热缓存。以可复现 generator 构造均匀和倾斜分布，至少保留一个“索引未被选择但全表扫描正确且更快”的反例，避免把索引使用率当成 KPI。

## 参考资料

- [dev.mysql.com/doc/refman/8.4/en/covering-indexes.html](https://dev.mysql.com/doc/refman/8.4/en/covering-indexes.html)
- [dev.mysql.com/doc/refman/8.4/en/range-optimization.html](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)
