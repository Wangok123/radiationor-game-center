---
slug: capacity-estimation-slo
title: 容量估算与 SLO
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 4 分钟
tags: 容量 | SLO | 排队
summary: 用用户旅程、SLI、余量和敏感性分析把容量估算从拍数变成可复查模型。
---

# 容量估算与 SLO

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 基础公式

```text
peak QPS = DAU * 高峰请求次数 / 高峰窗口秒数
concurrency ~= arrival rate * average service time   (Little's Law)
daily storage = events/day * bytes/event * replication factor
egress bandwidth = updates/sec * bytes/update * concurrent clients
```

所有公式必须写出假设。例如 100 万 DAU 并不等于 100 万并发；高峰比例、会话长度、消息扇出和地区分布会显著改变结果。

### 从用户数到资源量

把总量拆成有量纲的链：

```text
active users
  -> sessions / user / day
  -> requests / session, peakiness and fan-out
  -> arrival rate + concurrency + payload size
  -> CPU per request, memory per connection, bytes/sec
  -> replicas, headroom, failure-mode capacity
```

例如匹配服务不能只算“在线人数 / 房间人数”。还要估算每秒入队/退队、候选搜索复杂度、重试、跨区比例、匹配批次窗口、房间创建速率和取消流量。聊天/状态同步还需乘消息扇出；一个 1 KB 更新广播给 50 个 peer 与 1 KB 单播不是同一带宽预算。

| 估算对象 | 可用近似 | 还要纳入 |
| --- | --- | --- |
| 并发请求 | `QPS * service time` | 排队时间、重试、长尾工作。 |
| 网络带宽 | `message rate * payload * fanout` | framing/TLS/协议开销、压缩、重传和双向流量。 |
| 存储增长 | `events/day * bytes/event * retention * replicas` | 索引、WAL/AOF、备份、压缩与 tombstone。 |
| 连接内存 | `connections * per-connection state` | TLS、socket buffers、线程/协程栈、队列峰值。 |
| CPU 容量 | `arrival rate * CPU-seconds/request` | GC、锁、kernel、后台 compaction 和争用。 |

服务容量应通过压测测出拐点，而非把硬件标称核心数直接除以平均耗时。饱和点前的排队时延会非线性上升，故额定容量通常要低于极限吞吐，并按故障场景保留余量。

## SLO 先于架构

| 服务 | 例子 | 指标 |
| --- | --- | --- |
| 登录 | 令牌获取 | 成功率、P95/P99 延迟、依赖失败率 |
| 匹配 | 入队到匹配完成 | 排队时间分位数、匹配质量、超时率 |
| 战斗服 | 模拟 tick | tick overrun、房间断开率、state divergence |
| 内容更新 | catalog/bundle 下载 | 成功率、校验失败率、下载时长、回滚率 |

SLO 应区分用户可见错误与内部噪声，并设 error budget。没有 SLO，就无法判断过度设计还是容量不足。

### SLI、SLO、SLA 与窗口

- **SLI** 是用户体验的量化指标，例如成功请求比例或延迟分布，必须定义事件分母和排除项。
- **SLO** 是服务团队的目标及时间窗口，例如滚动 28 天内 99.9% 有效请求成功；它是工程目标，不是“每台机器 99.9% uptime”。
- **SLA** 是对外合同及后果，常有更低目标/赔偿条款；不能拿内部 SLO 直接代替。
- **Error budget** 是 SLO 容许的失败量，用来决定发布速度、可靠性工作和风险预算。

延迟 SLO 应按请求级/操作级分布定义，不建议把平均延迟作为唯一用户体验指标。一个服务可出现平均 20ms、但最慢 1% 达到数秒的情况。成功率分母也要避免只统计“成功到达应用层”的请求而遗漏入口拒绝、超时和下游失败。

## 从 SLO 推导容量余量

估算至少覆盖三种工作点：

1. **steady state**：常态负载和正常部署规模。
2. **peak/burst**：活动、发布、重连风暴、缓存失效等峰值形状和持续时间。
3. **failure state**：失去一个节点/可用区/依赖后，剩余容量能否维持核心 SLO。

N+1 冗余不是“多一台机器”就够。若单节点承担分片且故障后其它节点不能接管数据/连接，资源数量不等于可用容量。要验证故障时连接重分布、缓存冷启动、复制追赶和重试负载是否会形成二次峰值。

```text
required capacity under failure
  >= peak offered load after retries/failover
  with per-node utilization below the measured queueing knee
```

部署时的 CPU 利用率目标应该来自压测的排队拐点和故障余量，不是拍一个通用百分比。对 tick-sensitive game server，还要预算单房间最坏模拟帧和房间数量分布，而不只看整机平均 CPU。

## 设计检查

- 峰值按平均值的多少倍？是否考虑发布、活动、重试风暴？
- 单机最大连接、FD、内存、CPU、网络各是多少？哪一个先到上限？
- 缓存击穿、下游慢、分区故障时的退化行为是什么？
- 写路径能否幂等？消息是否可能重复、乱序或丢失？
- 观测指标能否在 SLO 破坏前发现容量趋势？
- 指标分母、窗口和排除项是否一致？是否会因流量下降而“虚假健康”？
- 峰值和故障时重试是否放大 offered load？限流与降级是否先于排队失控？
- 单机压测结果是否包含真实 key/entity/房间大小分布和长尾？

## 限流、排队与降级的联系

吞吐大于服务能力时，无界队列只会增加等待和内存。容量设计必须规定：入口并发/速率上限、每请求 deadline、队列容量、优先级、过载拒绝和可降级功能。对重试请求设置 exponential backoff+jitter 和总 deadline，避免所有客户端在同一时刻同步重试。

用户可见的降级可以按核心不变量排序：登录/存档/交易等关键写路径通常不能静默丢；排行榜、推荐或遥测可延迟/采样；战斗中状态消息可按语义合并最新快照，但输入命令不能同样覆盖。降级策略应有恢复条件，避免服务恢复后一次性把 backlog 全部灌入。

## 容量估算的敏感性分析

估算数值本身往往不准，重要的是指出哪个假设支配结果。对每个关键假设至少做低/基准/高三档，并计算资源与 SLO 变化：

| 假设 | 低/基准/高 | 影响链 | 可验证来源 |
| --- | --- | --- | --- |
| 峰值并发 | DAU、峰值比例、会话重叠 | connection/memory/CPU | 登录与在线指标。 |
| 请求扇出 | peer 数、缓存 miss fanout | egress、下游 QPS | 生产 trace/sample。 |
| 事件保留 | payload、索引、复制、备份 | 存储、恢复时间 | schema + 实测 row bytes。 |
| 故障重试 | retry policy、失效持续时间 | offered load、排队 | 故障注入/历史事故。 |
| 热点偏斜 | tenant/key 分布 | 单 shard 容量与尾延迟 | histogram/top-key trace。 |

若某个假设翻倍就推翻架构选择，应优先做 PoC/压测验证，而不是把估算表写得更精确。

## 参考资料

- [sre.google/sre-book/service-level-objectives](https://sre.google/sre-book/service-level-objectives/)
- [sre.google/workbook/monitoring](https://sre.google/workbook/monitoring/)
