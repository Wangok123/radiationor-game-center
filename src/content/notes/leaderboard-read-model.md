---
slug: leaderboard-read-model
title: 排行榜系统与游戏读写分离
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 5 分钟
tags: 排行榜 | 读写分离 | 一致性
summary: 先定义排名语义，再设计权威写入、读模型、热点分区、安全和结算恢复。
---

# 排行榜系统与游戏读写分离

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

排行榜要先明确实时性、排名范围、并列规则、作弊校验、历史赛季和写入峰值。Sorted Set 适合按 score 更新和附近排名查询，但不能单独承担强审计和无限历史；常见架构是权威结算写入、异步更新热榜、持久化赛季结果，并对全榜扫描和热点活动限流。

## 先定义“排名”是什么

排行榜不是一个 `score -> rank` 函数，而是一个有赛季、范围、并列、可见性和结算时刻的产品合同。没有先定义合同，任何 Sorted Set 选型都会在赛季结算、并列奖励或好友榜上线时返工。

| 决策 | 必须明确的问题 | 影响 |
| --- | --- | --- |
| 榜范围 | 全球、区服、公会、好友、分段还是赛区？ | key 设计、分区、跨榜聚合和权限。 |
| 时间 | 实时、近似实时、每日/赛季快照还是最终结算？ | 可接受陈旧度、重放、审计和存储。 |
| 总序 | 分数相同如何排：先达成、次级分、随机稳定值、并列名次？ | score 编码、奖励公平性、分页稳定性。 |
| 身份 | account、角色、队伍还是匿名分身？改名如何显示？ | member key、PII、缓存失效。 |
| 可见性 | top N、around me、好友交集、历史赛季 | 是否能避免全榜扫描和泄漏隐藏玩家。 |
| 权威性 | 客户端报分还是服务端结算？撤销/封禁如何修正？ | 反作弊、审计账本、补偿和重建。 |

排名使用的分数必须有可审计的数值域和 tie-break 规则。不要把多个字段随意拼进一个浮点 score：精度、负数、排序方向和极值都会影响顺序。若使用 Redis Sorted Set 的 double score，确认所有整数/复合编码都在精度范围内；否则用经过测试的辅助排序、多个索引或服务层比较，而不是依赖“看起来排序正确”的样本。

## 数据合同与权威写入

```text
authoritative match result
  -> durable result ledger / outbox
  -> idempotent ranking event
  -> partitioned ranking writer
  -> hot leaderboard projection + audit snapshot
```

一个 score event 至少应能定位和去重：

```text
event = {
  eventId, seasonId, boardId, playerId,
  resultId, playerScoreVersion, score, tieBreak,
  producedAt, schemaVersion
}
```

`eventId` 解决“同一事件被至少一次投递”；`playerScoreVersion` 或权威结算版本解决“同一玩家的旧结果晚到”；`seasonId` 防止赛季切换的延迟消息写进新榜。它们不能互相替代。ranking writer 在写入前应比较 event/score version，记录已应用的 event 或通过幂等事务保证重复投递不重复结算；客户端提交的 score 只能是请求，服务端重算或验证后才产生权威事件。

| 情况 | 错误处理 | 正确合同 |
| --- | --- | --- |
| 同一 result 重投 | 又加一次分/重发奖励 | 以 resultId/eventId 去重，返回首次权威结果。 |
| 旧版本晚到 | 覆盖更高的新成绩 | 拒绝或记录为 stale event。 |
| 跨赛季延迟 | 写进当前赛季 | event 的 seasonId 必须匹配 active/archived policy。 |
| 撤销作弊成绩 | 热榜删了，审计仍保留错误 | 记录修正事件和原因，可重放重建 projection。 |
| writer 故障 | result 已提交但热榜丢更新 | outbox/ledger 可重放，projection 可幂等重建。 |

## 读模型不是一个接口

将请求按访问模式拆开，避免为了一个 `GET /leaderboard` 做全榜排序和全量缓存：

| 读路径 | 所需索引/数据 | 常见边界 |
| --- | --- | --- |
| Top N | 活跃分区的已排序 projection | page 缓存、排名并列和赛区过滤。 |
| Around me | player score + 其相邻窗口 | 玩家不在榜、分数修正、稳定 cursor。 |
| 好友榜 | social graph 与榜 projection 的交集 | 好友服务失败、隐私、N 很大时不能全量 join。 |
| 历史赛季 | 冻结 snapshot / archive | 不与实时热 key 竞争内存。 |
| 奖励结算 | 最终冻结名次 + 审计 ledger | 结算时的重试、幂等发奖和人工修正。 |

分页的 cursor 必须包含排序键和 tie-break，而不只是 offset。否则在高频更新榜中，用户可能重复或跳过条目。客户端展示也要有陈旧度语义，例如“数据更新于 T”，不要把异步 projection 的短暂落后误报成数据丢失。

## 分区、热点与容量

先做数量级估算，再选择单榜、按赛区分片或两级聚合：

```text
active members     = daily active participants * participation rate
steady update QPS  = active members * average updates / active window
peak update QPS    = steady QPS * burst multiplier
hot read QPS       = concurrent viewers * refresh rate
memory budget      = members * projection bytes/member + index/replication overhead
```

把全球榜按用户 id 机械分片会使 Top N 和 Around Me 变成跨分片 merge 问题；而只保留一个热 key 则会让活动末尾、主播曝光或奖励结算形成单点热点。常见折中是按赛季/榜类型/区域隔离热度，对最终全球 Top N 做受控聚合，并把完整历史转存为 immutable snapshot。具体阈值取决于 Redis 版本、member 长度、复制、持久化、实例内存和允许陈旧度，必须压测而不是从博客抄一个“百万用户”的结论。

为 cache eviction、主从切换、重建、跨区延迟和社交图服务不可用预先定义降级：返回上一个已签名 snapshot、只提供 top N、暂停好友榜、展示恢复中，或关闭活动入口。禁止在热榜缓存失效时把所有客户端请求回源全量数据库。

## 一致性、结算与恢复

实时榜通常是可接受短暂最终一致的 projection；奖励结算不是。赛季关闭要有清晰的 fence：停止接收旧赛季 result、持久化最终 source ledger、生成可复算 snapshot、按 snapshot 发奖、保留修正/补偿通道。若需要在线修正，修正事件应有独立 id、原因、操作者和可审计时间，而不是直接手改 hot cache。

恢复策略至少能回答：热 projection 丢失后从哪个 offset 重放、重放期间读取什么、是否双写新旧 key、如何校验重建结果与 ledger 一致、何时安全删除旧赛季。缓存和数据库的“双写”没有原子性时，使用 outbox 或可重放事件流，不要假设按顺序调用两个客户端就能得到一致状态。

## 安全与反作弊边界

- 由服务端验证/重算比赛结果；客户端不能直接写排名 key。
- 结果请求、发奖和修正均需要鉴权、速率限制和审计；管理员工具也是写路径。
- 不在榜 member 中放敏感昵称/账户数据；显示信息与排序身份可分离。
- 记录反作弊拒绝、重复 result、版本回退和异常分数分布，供规则迭代和申诉复核。

## 验证矩阵

| 测试 | 注入 | 必须断言 | 证据 |
| --- | --- | --- | --- |
| 顺序与并列 | 相同 score、极值、tie-break | 排名稳定、分页无重复/遗漏 | fixture 与排序结果。 |
| 幂等/乱序 | 重复 event、旧 version 晚到 | 分数只应用一次；旧事件不覆盖新事件 | event ledger、writer 日志。 |
| 赛季切换 | close 与延迟 event 并发 | fence 生效；奖励 snapshot 可复算 | season epoch、发奖对账。 |
| 重建 | 删除 hot projection 后 replay | 重建结果与 ledger/hash 一致 | offset、快照、差异报告。 |
| 压力/故障 | 热点读写、eviction、failover | read P95、更新滞后、内存和降级符合 SLO | 原始负载数据与监控。 |

## 参考资料

- [redis.io/docs/latest/develop/data-types/sorted-sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [sre.google/sre-book/handling-overload](https://sre.google/sre-book/handling-overload/)
- [redis.io/docs/latest/develop/data-types/streams](https://redis.io/docs/latest/develop/data-types/streams/)
