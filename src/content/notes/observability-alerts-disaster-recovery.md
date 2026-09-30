---
slug: observability-alerts-disaster-recovery
title: 可观测性、告警与灾备演练
date: 2026-09-30
updated: 2026-09-30
category: 系统设计
reading_time: 5 分钟
tags: 可观测性 | 告警 | 灾备
summary: 把用户旅程、SLO、指标日志 trace 和恢复演练连接成可行动的运维协议。
---

# 可观测性、告警与灾备演练

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

可观测性不是堆日志和仪表盘，而是让值班者能从症状定位到受影响用户、依赖、版本和故障路径。指标、日志和 trace 各解决不同问题；告警应围绕用户 SLO 和可行动性，而不是机器资源的每次波动。灾备只有在恢复目标、故障域、演练和数据校验都被验证后才算存在。

## 三类信号

| 信号 | 最擅长回答 | 设计要求 |
| --- | --- | --- |
| Metrics | 多大范围、多频繁、是否超预算 | 低基数，含服务/版本/区域等可聚合维度。 |
| Logs | 某次请求为何失败 | structured fields、request id、脱敏、采样策略。 |
| Traces | 跨服务的时间花在哪 | propagation、span 边界、错误/重试标记。 |

不要把 `userId`、订单号等高基数字段作为 metric label；放日志/trace 或受控事件系统。

## 先从用户旅程和 SLO 设计遥测

仪表盘应能回答一个用户可见操作是否成功、慢在哪里、受哪些版本/区域/依赖影响。先定义 SLI 的事件分母、成功标准和时间窗口，再派生指标、日志和 trace：

| 用户操作 | SLI 示例 | 必备维度 | 需要避免 |
| --- | --- | --- | --- |
| 登录 | 成功登录 / 有效登录尝试；P99 延迟 | region、client version、auth result | 将 user id 作为 metric label。 |
| 匹配 | 在目标窗口完成的入队请求比例 | queue region、mode、result | 只报平均排队时间。 |
| 支付/发奖 | 幂等完成且结果可查询的比例 | operation、provider result、attempt | 将“收到请求”当成功。 |
| 内容下载 | 校验通过且可激活的比例 | content version、network class、error | 只统计 HTTP 200。 |

指标必须保持低基数和可聚合；trace/log 记录 request/correlation id、tenant、错误详情、采样决策与版本。若每个 user/item/URL 都做 label，监控系统自身会因 series 爆炸失效。聚合维度与排障维度分开设计。

## 指标、日志、trace 的关联协议

每个跨服务/异步消息至少传播 trace/correlation id、请求/事件 id、版本和 deadline。服务端要在接收、排队、调用依赖、重试、完成/失败等边界创建 span/structured event；异步消费还要保留 producer 时间与 consumer 开始时间，以区分 broker lag 和处理慢。

```text
request id / trace id
  -> gateway span
  -> service span + structured log
  -> outbox event (correlation id, causation id)
  -> consumer span + business result
```

trace sampling不能只随机：错误、慢请求、特定发布版本和高价值操作应保留，正常高频流量可采样；同时记录 sampling rate，否则不能将样本数当总量。日志字段应结构化、可查询、包含 error class 与 stack/cause，但避免 token、密码、完整隐私 payload；脱敏规则也需测试和审计。

## 告警是可行动的决策

page 级告警需要同时满足用户影响、需要人工介入、runbook 有安全动作。将告警分为：

| 级别 | 触发 | 期望动作 | 不应包含 |
| --- | --- | --- | --- |
| page | 快速消耗 error budget/核心功能不可用 | 立即缓解/升级 | 单机瞬时 CPU 抖动。 |
| ticket | 容量趋势、低频错误、SLO 风险 | 工作时间修复/规划 | 需要夜间立刻人工响应的事故。 |
| info/dashboard | 诊断上下文/部署观察 | 关联排障 | 每个状态变化都发通知。 |

burn-rate 告警将错误比例与 error budget 窗口结合：短窗口高 burn 用于快速发现大故障，长窗口中等 burn 防止慢性消耗。阈值需要最小流量/样本保护，避免夜间无流量时百分比噪声或流量暴涨时漏报。告警去重、抑制、依赖拓扑和升级轮值同样是系统设计；依赖已知全挂时不应让每个下游服务同时 page 人。

## 告警设计

```text
symptom alert: SLO burn / error / latency / availability
  -> runbook -> dashboard -> trace/log query -> mitigation
```

每个 page 级告警必须写清：影响、阈值、最常见原因、首个排查查询、可逆缓解动作和升级路径。使用 burn rate 比只看瞬时错误率更贴合 error budget；告警过多会造成疲劳并掩盖真实事故。

runbook 要可执行：前置权限/开关、命令/仪表盘链接、决策树、何时停止、回滚步骤、验证指标、证据归档和沟通模板。只写“检查日志/扩容”不构成 runbook；新值班者在演练环境中应能独立完成一次安全缓解。对有破坏性的操作，先提供只读检查和两人确认/审批边界。

## 容量、发布和合成探测

golden signals（latency、traffic、errors、saturation）有用，但要落到具体资源：队列 age、连接池 in-flight、线程池等待、DB lock wait、cache eviction、GC/native memory、room tick overrun。资源指标通常是预测信号，用户 SLO 是结果信号，两者需要关联而不是互相替代。

发布必须带 build/commit、配置/feature flag、schema/content version 标签，且在部署事件时间线可相关资源与写入权限仍需由明确的生命周期协议管理。对登录、支付、下载、跨区域匹配等关键路径做合成探测，但测试账户/流量要隔离真实统计与业务副作用；“探测成功”也不证明所有真实用户都正常。

## 灾备是恢复协议

RTO 是服务恢复目标，RPO 是可接受数据丢失窗口。它们要按数据/功能分级：静态内容可从可再生构建恢复，玩家交易/存档需要更严的备份、复制、校验和幂等重放；控制平面、密钥、DNS、监控和部署系统本身也可能成为故障域。

| 故障域 | 需要回答 | 验证方式 |
| --- | --- | --- |
| 单实例/节点 | 健康检查、连接迁移、容量余量 | kill/restart + SLO 观察。 |
| AZ/region | 流量切换、数据主从、跨区延迟/RPO | 隔离演练/受控 failover。 |
| 数据损坏/误删 | point-in-time restore、权限、校验 | 从独立备份恢复并对账。 |
| 误发布/配置 | rollback、feature flag、schema 兼容 | canary + 回滚演练。 |
| 凭据/证书 | rotation、失效、应急访问 | 轮换/过期演练。 |

备份“存在”不是恢复：要验证其独立性、加密/密钥可用、恢复脚本、版本兼容、恢复时间和数据校验。恢复后既要比较 count/checksum/version，也要验证业务不变量、重复事件处理和对外读写是否按计划恢复。

## 灾备问题

- RTO：多长时间内恢复服务？RPO：最多能丢失多久的数据？
- 哪些依赖跨同一故障域，哪些备份能独立恢复？
- 数据恢复后如何校验完整性、幂等重放和版本兼容？
- 灰度回滚、DNS/流量切换、只读降级、密钥失效分别由谁操作？

## 演练

至少演练单实例故障、依赖超时、区域不可用、误发布回滚和备份恢复。记录检测时间、缓解时间、恢复时间、人工步骤、数据差异和后续自动化。未演练的 runbook 只能算假设。

### 演练合同与复盘

每次演练先写 hypothesis、blast radius、停止条件、通信、回滚和观测面；实施时记录检测时间（TTD）、确认/缓解时间（TTM）、恢复时间（TTR）、SLO/error budget、数据差异、告警噪声和人工步骤。演练后区分：真正修复、降低风险、仅更新文档、尚未解决的假设；每一项给 owner 和验证日期。

| 演练 | 最小验收 |
| --- | --- |
| 依赖 timeout | bulkhead/熔断/降级保护核心 SLO，告警可定位依赖。 |
| region failover | 写入口 fencing，RPO/RTO 符合声明，客户端恢复可解释。 |
| 备份恢复 | 在隔离环境恢复、校验数据/业务不变量、记录实际耗时。 |
| 误发布 | canary 发现、停止扩散、配置/二进制/schema 回滚可执行。 |
| 队列堆积 | lag、重试和 DLQ 有界，恢复不会二次压垮下游。 |

## 参考资料

- [sre.google/sre-book/monitoring-distributed-systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [sre.google/sre-book/handling-overload](https://sre.google/sre-book/handling-overload/)
