---
slug: rate-limit-circuit-breaker
title: 限流、熔断与降级
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 5 分钟
tags: 限流 | 熔断 | 降级
summary: 将 token bucket、熔断状态机、bulkhead、deadline 和降级结果组合成完整的过载策略。
---

# 限流、熔断与降级

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

限流保护入口和共享资源的公平使用；熔断在依赖持续失败时快速阻断调用，避免把线程、连接和重试预算耗尽；降级是在无法完整服务时提供更低成本但可接受的结果。三者服务不同层面，不能用一个“限流器”替代全部。策略必须以资源预算、优先级和用户可见 SLO 为依据。

## 常用算法

| 算法 | 特点 | 适用 |
| --- | --- | --- |
| fixed window | 简单，边界突刺明显 | 粗粒度配额。 |
| sliding window | 更平滑，需更多状态 | API 速率控制。 |
| token bucket | 允许有限突发，限制长期速率 | 玩家/API 限速。 |
| leaky bucket/queue | 平滑输出 | 下游处理速率固定的任务。 |

限流维度至少考虑 user/account、IP/device、endpoint、region 和下游依赖。只按 IP 会误伤 NAT；只按 user 会被大量账号攻击。

### Token bucket 的参数与分布式边界

令 bucket 容量为 `B`，补充速率为 `r` token/s。一次成本为 `c` 的请求仅在 token 足够时通过；在时间 `Δt` 后可用 token 近似为 `min(B, tokens + r*Δt)`。`r` 限制长期平均速率，`B` 决定允许的突发量。对昂贵 endpoint 可按成本消耗多个 token，而不是所有请求都当作 1。

固定窗口容易在窗口边界承受接近 2 倍突发；sliding log 精确但状态随请求数增长；sliding counter 用近似换空间；leaky bucket 平滑输出但会增加队列等待。选择时写清突发允许量、拒绝还是排队、状态大小和时钟源。

分布式限流还要选择强度：各节点本地限额简单/低延迟但全局可能成倍超额；中心化 store 更接近全局额度，却引入网络依赖和热 key；分片租约/额度批发能减少访问，但短时间仍可能超额。玩家公平、防刷和保护单个 DB 的目标不同，不能只说“用 Redis 原子计数”。

## 限流应该放在哪一层

| 位置 | 保护对象 | 常见信号/策略 |
| --- | --- | --- |
| Edge/gateway | 服务整体、带宽、身份验证成本 | IP/account/device、连接/包大小、全局 QPS。 |
| API/业务入口 | endpoint 与租户公平性 | account、operation cost、幂等 key。 |
| 进程内 bulkhead | 线程池/连接池/下游并发 | semaphore、bounded queue、per-dependency concurrency。 |
| 数据库/存储 | 锁、连接、IOPS、热点 key | 有界并发、查询预算、写入配额。 |
| 游戏房间/tick | tick CPU、实体/命令预算 | per-room command cap、实体 relevance、低优先级丢弃。 |

入口速率限制不能代替内部并发限制：低 QPS 的慢请求也可能占满线程/连接。相反，只有 semaphore 没有队列上限，仍可积累无限等待者。

## 熔断状态机

```text
Closed -- failure rate/latency threshold --> Open
Open -- cooldown --> Half-open -- probe success --> Closed
                         \-- probe failure --> Open
```

阈值需要最小样本数、时间窗口和半开探测并发限制。否则少量偶发失败会抖动，或所有实例同时半开形成恢复尖峰。

熔断器还需要明确统计对象：按依赖、operation、region、tenant 还是 endpoint 分桶。粒度过粗会让一个坏租户熔断所有用户；粒度过细则样本不足、状态量增加。失败应区分 timeout、连接失败、业务 4xx、限流拒绝和依赖自身 5xx；把可预期的业务拒绝算作依赖故障，会造成错误熔断。

半开探测应使用小而有界的并发/速率，且成功条件需要足够样本；一次成功不必证明依赖恢复。多个实例使用同一 cooldown 会同步探测，需 jitter 或协调，避免恢复尖峰。熔断打开时 fallback 也必须有自己的预算，不能把主依赖压力转移到缓存/备用服务并再次压垮它。

## Bulkhead、排队与 deadline

Bulkhead 是对独立依赖/优先级隔离并发和队列资源。若支付、排行榜和遥测共享一个无限队列，遥测积压可耗尽线程/内存并拖垮关键支付，即使支付依赖本身健康。

每次远端调用携带 end-to-end deadline。单跳 timeout 应小于剩余 deadline，并预留响应/清理时间；调用链的重试次数相乘，例如 3 层各重试 3 次可产生多达 27 倍尝试。重试只适用于幂等或具 idempotency key 的瞬时错误；按剩余 deadline 做指数退避与 full jitter，过载时快速失败通常优于排队过期请求。

```text
request deadline 800ms
  auth 50ms -> match queue max 300ms -> DB call <= remaining budget
  no budget left -> reject/fallback, do not start another retry
```

## 降级合同

降级不是吞错。对每个功能列出：正常依赖、降级结果、数据新鲜度、允许持续时间、恢复条件及用户可见提示。关键不变量不能被“降级”破坏：交易/存档不能假装成功；排行榜可以返回缓存旧值并带时间戳；遥测可以采样；匹配可以降低候选范围但需控制公平性。

fallback 还要防止 cache stampede 和 stale data 误用。缓存未命中时可用 singleflight、短暂 stale-while-revalidate 或拒绝低优先请求；但安全/经济数据不能随意用陈旧副本做写决策。

## 重试和 deadline

每个 RPC 传播 deadline；只对幂等、瞬态故障进行有限指数退避加 jitter 的重试。重试会放大负载，不能在调用链每层都重试。过载时优先快速拒绝低优先级请求，保留登录、支付、战斗结算等关键路径。

在客户端与服务端记录 retry attempt、原始错误、remaining deadline、限流/熔断状态和最终用户结果。否则“重试成功率上升”可能掩盖首请求错误、资源消耗翻倍和尾延迟恶化。

## 演练

人为让下游延迟 10 倍、返回 50% 错误或完全不可用。验收：关键服务 SLO、队列上限、熔断打开时间、恢复时间、拒绝原因分布和是否存在重试风暴。

| 故障注入 | 验收合同 | 需观察 |
| --- | --- | --- |
| 下游延迟 10 倍 | caller 在 deadline 内返回，不耗尽线程/连接 | in-flight、queue wait、timeout、P99。 |
| 依赖 50% 错误 | 达阈值后熔断，低优先调用停止 | open/half-open 状态、探测量。 |
| 恢复时半开 | 有界探测，不出现所有实例同步重试 | recovery QPS、依赖 CPU、成功窗口。 |
| gateway 重启/限流状态丢失 | 配额语义可解释，不能无限放行 | state reset、超额量、tenant fairness。 |
| fallback 缓存也变慢 | fallback 有独立 bulkhead/截止时间 | fallback queue、stale age、拒绝率。 |

复盘时量化误拒绝、漏限流、级联影响范围、error budget 消耗和回到健康状态所需时间。阈值只能从流量分布/依赖容量和故障演练校准，不能照搬别的服务百分比。

## 参考资料

- [sre.google/sre-book/handling-overload](https://sre.google/sre-book/handling-overload/)
- [sre.google/sre-book/addressing-cascading-failures](https://sre.google/sre-book/addressing-cascading-failures/)
