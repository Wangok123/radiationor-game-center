---
slug: congestion-heartbeat-reconnect
title: 拥塞控制、心跳与断线重连
date: 2026-09-30
updated: 2026-09-30
category: 计算机网络
reading_time: 5 分钟
tags: 拥塞控制 | 心跳 | 重连
summary: 把心跳、故障探测、重连状态机和恢复协议放在带宽、重试和容量约束下设计。
---

# 拥塞控制、心跳与断线重连

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

心跳用于探测连接可达性和故障时间，不是越频繁越好；重连需要指数退避、jitter、会话恢复和幂等；拥塞控制则保护共享网络，避免所有客户端同时重试造成重试风暴。客户端显示“断线”前要区分暂时无响应、网络切换、服务器拒绝和认证失效。

## 先区分四种“还活着”

一个 ping/pong 成功只能证明某个传输路径最近有响应，不能证明用户仍被授权、房间仍存在、游戏状态仍一致。连接设计至少维护四个独立事实：

| 事实 | 典型证据 | 超时后的处理 |
| --- | --- | --- |
| 传输可达 | 最近收包、ACK、ping/pong、socket error | 进入 `Suspect`，开始有限探测。 |
| 会话有效 | access token、session epoch、服务端 lease | 重新认证或进入 `NeedsLogin`，不能无限重试。 |
| 玩法归属有效 | room/match id、seat、服务器迁移 epoch | 恢复订阅、重进房间、观战或明确结束。 |
| 状态连续 | last accepted command、snapshot tick、event cursor | 重同步、去重或回滚，不能只把 UI 改为 Connected。 |

这四者混用是重连 bug 的常见来源：例如 socket 已连通但 token 已过期，或房间仍在但客户端错过了权威事件；“绿点”不等于可以继续提交旧操作。

## 心跳与故障探测

心跳间隔 `H` 和连续失败阈值 `K` 是体验、耗电、服务端连接规模和误判率之间的选择。粗略地，故障被客户端确认的时间下界接近 `K * H`，再加网络抖动和 timeout；因此要求 3 秒内发现故障，却选 5 秒一次、连续 3 次失败，是不相容的。不要把这个模型当作所有协议的固定算法，实际 transport 的 RTO、移动平台后台策略、NAT/代理和服务端负载都必须实测。

| 规则 | 原因 | 反例 |
| --- | --- | --- |
| 活跃业务流量可刷新 liveness | 避免额外包和 radio 唤醒 | 业务包没有被服务端成功处理时不能伪造 ACK。 |
| 使用时间窗口/连续失败 | 单个丢包不是连接死亡 | 无限等待会掩盖 server blackhole。 |
| 记录单调 sequence 或 ping nonce | 延迟到达的旧响应不能恢复新会话 | 只比较“收到任意 pong”。 |
| 客户端与服务端各自判定 | 两端可看到不同的链路失败 | 只依赖客户端计时导致 server 泄漏 room member。 |
| 后台/前台显式转态 | 移动 OS 可能暂停 timer 和 socket | 把 resume 后的大间隔当作连续丢包。 |

心跳消息至少带 connection/session epoch、递增 nonce 或最后接收序号，以及服务端可选择返回的当前 epoch/时间。不要将认证凭据、完整世界状态或可重放的高价值操作塞进心跳包。

## 重连状态机与所有权

```text
Connected
  -> Suspect (liveness deadline crossed; admission of unsafe commands stops)
  -> Disconnecting (close old transport; invalidate callbacks with connection generation)
  -> Backoff (deadline and retry budget owned by one coordinator)
  -> Connecting -> Authenticating -> SessionAccepted
  -> Resyncing (snapshot / event cursor / command acknowledgements)
  -> Ready -> Connected
  \-> NeedsLogin | VersionRejected | MatchClosed | RetryExhausted
```

`Ready` 与 `Connected` 分开很重要：socket 建立和鉴权成功后，UI 可以展示“正在恢复”，但只有 snapshot/cursor 已被应用、旧回调已失效、关键命令的提交状态已确定，才允许玩家继续产生会改变权威状态的输入。

协调器应拥有一个递增 `connectionGeneration`。任何 async DNS、connect、auth、load snapshot 或 UI 回调完成时先检查 generation 与 owner 是否仍有效；否则旧连接的成功回调可能覆盖较新的失败状态，形成难复现的“闪断后又回到旧房间”。这和 Unity 场景/面板异步结果的 owner 检查是同一个生命周期问题。

## 恢复协议，而非“重发全部”

重连请求应是一个显式协议，而不是客户端把本地队列直接循环发送。最低限度需要：

```text
resume request = {
  protocolVersion, sessionToken, sessionEpoch,
  matchOrRoomId, lastServerEventCursor,
  lastAckedCommandSequence, clientBuild, reconnectAttemptId
}
```

服务端响应必须能说明恢复分支：继续增量事件、下发完整 snapshot、要求重新登录、房间已结束、客户端版本不兼容或迁移到新 endpoint。若 command 可能产生奖励、购买、结算或一次性技能效果，服务端按 `(playerId, commandId)` 做去重，并用权威结果回复；客户端不能通过“我没收到回复”推断操作未发生。

| 操作类别 | 断线后的默认策略 | 服务端要求 |
| --- | --- | --- |
| 纯展示/订阅 | 重新订阅或丢弃旧请求 | cursor/epoch 校验。 |
| 可覆盖状态，如移动目标 | 只保留最新意图或等待 snapshot | sequence 防止旧包覆盖新状态。 |
| 幂等查询 | 可安全重试 | request id 便于日志和限流。 |
| 有副作用命令 | 等权威 ACK 后决定是否重发 | durable dedupe、结果查询或幂等 key。 |
| 实时输入流 | 从 last ACK 后补发有限窗口，或请求 snapshot | tick、窗口上限、过期输入策略。 |

恢复期间本地 prediction 如何处理也必须说明：保留尚未确认 command 并在权威 snapshot 后重放，还是清空本地状态并等待服务端？两种策略都可行，但前者依赖确定性/可重放规则，后者更简单却可能出现视觉跳变。参见 [游戏网络同步：预测、插值与校正](network-sync-prediction-reconciliation.html)。

## 重试、拥塞与容量

TCP/QUIC 已有 transport 层的拥塞控制；应用层仍要避免在服务不可用时放大握手、鉴权、数据库和 snapshot 压力。对 UDP 上自定义可靠层，则 sequence、ACK、重传、速率控制、分片和拥塞响应都是应用协议责任，不能只实现“丢包就重发”。

常见退避模型为 `delay(n) = min(cap, base * 2^n) * jitter`，其中 jitter 应在一个明确范围内随机化。重要的不是公式本身，而是总 deadline、最大尝试数、前后台切换、用户主动取消和服务端 `Retry-After` 如何共同决定终态。

```text
reconnect arrival rate ~= simultaneously affected clients / retry spread window
resync egress         ~= recovered clients * average snapshot bytes / recovery window
```

因此一次机房网络抖动后的主要风险不一定是常规 gameplay QPS，而是连接洪峰、token 验证、房间查询、snapshot 序列化和下行带宽同时被打满。服务端需要连接/认证限流、按租户或区域的公平队列、snapshot 限速、可丢弃的非关键订阅，以及在过载时给客户端明确的退避/失败信号。

## 安全与终态

- 重连 token 应有短生命周期、受服务端撤销/epoch 约束；不要把长期凭据写入普通日志。
- endpoint 重定向、版本升级、协议协商和服务端迁移需要签名/可信来源约束，不能接受任意地址。
- 认证失败、版本不兼容、账号封禁、房间结束和重试耗尽是不同终态，UI/埋点/客服排查必须可区分。
- 客户端计时器、重试次数和“最后处理序号”均不可信；权威状态和反作弊判断留在服务端。

## 验证矩阵

| 注入场景 | 必须观测 | 成功条件 | 容易遗漏的反证 |
| --- | --- | --- | --- |
| 0.5/2/10 秒丢网、乱序、丢包 | liveness 时间、generation、旧回调数 | 只启动一个恢复流程；不接受过期回调 | UI 变绿但 snapshot 未完成。 |
| Wi-Fi/蜂窝切换、后台恢复 | socket、DNS、token、timer 跳变 | 恢复或进入明确终态 | timer 造成瞬时重连风暴。 |
| 服务端滚动重启/迁移 | retry QPS、auth、room epoch、snapshot | P95 恢复时间在预算内 | 所有客户端同一时刻打满 auth。 |
| ACK 丢失的副作用命令 | event id、dedupe hit、用户余额/奖励 | 至多生效一次且结果可查询 | 只测“重发最终成功”。 |
| snapshot 超大或版本不兼容 | bytes、解码时间、拒绝码 | 降级/拒绝可观测 | 恢复完成后才发现客户端卡死。 |

## 参考资料

- [www.rfc-editor.org/rfc/rfc5681](https://www.rfc-editor.org/rfc/rfc5681)
- [www.rfc-editor.org/rfc/rfc6298](https://www.rfc-editor.org/rfc/rfc6298)
- [www.rfc-editor.org/rfc/rfc9000](https://www.rfc-editor.org/rfc/rfc9000)
