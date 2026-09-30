---
slug: http-websocket-protocol-security
title: HTTP、WebSocket 与协议安全
date: 2026-09-30
updated: 2026-09-30
category: 计算机网络
reading_time: 5 分钟
tags: HTTP | WebSocket | 安全
summary: 从连接状态、背压、认证授权、重试幂等和资源上限审视长连接协议。
---

# HTTP、WebSocket 与协议安全

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

HTTP 是请求/响应语义，适合资源、控制面和可观察的 API；WebSocket 在 HTTP 握手后提供双向长连接和消息边界；一条消息可能由多个 frame 组成，但认证续期、业务 schema、背压和幂等仍需应用定义。协议选择后仍要定义超时、最大帧、鉴权、重放/重连、压缩和速率限制，TLS 只解决传输层机密性与完整性的一部分。

## WebSocket 生产边界

- 每条消息需要 length/type/version/sequence 或明确 framing，拒绝超长和未知类型。
- ping/pong 与业务心跳分开记录；代理/负载均衡的 idle timeout 要小于客户端误判窗口。
- backpressure：发送队列有界；状态类消息可覆盖，事件类消息要可靠/去重。
- 连接恢复用 session、cursor 或 snapshot，不假设连接重建后事件从未丢失。
- 鉴权、权限和租户隔离在每条业务消息上生效，不能只在握手检查一次。

## HTTP 与 WebSocket 的责任分层

HTTP 不只适合“普通接口”：它有明确请求/响应、状态码、cache/proxy 语义、幂等方法和可观察的边界，常适合登录、内容下载、控制面、一次性命令和可重试查询。WebSocket 适合服务端需要主动推送、低频双向事件或持续会话，但连接本身不替代业务可靠性/顺序协议。

| 需求 | 倾向 | 仍需设计 |
| --- | --- | --- |
| 可缓存资源/内容 | HTTP/CDN | ETag/version、cache-control、校验/回滚。 |
| 幂等查询/命令 | HTTP | request id、deadline、retry policy。 |
| 服务端推送状态 | WebSocket/SSE/其他 push | cursor、backpressure、恢复 snapshot。 |
| 高频实时状态 | 专用实时传输/UDP/QUIC 视需求 | tick、丢包/拥塞、优先级。 |
| 长任务进度 | HTTP 提交 + poll/push | job id、状态机、过期/权限。 |

WebSocket 支持将一条消息拆成多个 frame，应用应按库提供的完整消息语义处理数据；一条业务记录是否对应一条 WebSocket 消息仍需明确定义，仍应定义 type、version、request/event id、sequence/cursor、最大长度、压缩和错误响应。禁止未知 type 默认执行，解析前限制嵌套、数组长度、字符串/二进制大小，避免反序列化炸弹。

## 连接状态机与恢复

```text
Connecting -> Handshaking -> Authenticated -> Active -> Draining -> Closed
                         \-> Rejected
Active -> Reconnecting -> resume(cursor/session epoch) -> Active or resync snapshot
```

断线不是罕见异常：移动切网、代理 idle timeout、服务器 deploy、负载均衡迁移都会发生。恢复协议必须说明 session/epoch、最后确认 cursor、服务器保留窗口和 snapshot fallback。客户端带旧 cursor 重连时，服务器要么补发可用事件，要么明确要求完整 snapshot；不能假设“连接断了几秒所以没有消息”。重连延迟使用 backoff+jitter 并限制总尝试/后台行为，避免大规模 deploy 后所有 client 同步重连。

业务消息区分 command 和 state/event：command 需要 client request id、权限、幂等与结果确认；状态更新可带 version/cursor、允许 coalescing；重要事件需 event id 去重。不要用 TCP/WebSocket 有序字节流替代跨重连的业务顺序/去重。

## Backpressure 与资源预算

每条连接至少限制：入站 frame/message bytes、解析 CPU、每秒消息/命令、未完成 request、出站 queue bytes/count/age、ping/idle、总生命周期。慢消费者的出站队列若无上限会使服务端堆内存；满时策略依消息语义：最新状态覆盖旧状态、低优先级通知丢弃并计数、可靠 command/event 按协议拒绝/断开/重连，不可静默无限堆积。

反压还要穿透到 producer：如果聊天室/游戏房间持续生成状态，而连接层只在满时丢包，producer 仍可能耗 CPU 构造所有消息。按订阅/relevance、频率、可见性和优先级限制生成工作；记录每 connection queue、dropped/coalesced、state age、close reason 和全局内存。

## 认证、授权与浏览器边界

握手时认证只建立连接身份；每条消息仍要检查当前 session、tenant、role、资源 owner 和操作状态。token 过期、账号封禁、权限撤销和角色切换要有主动断开/重新认证/拒绝策略，不能让已握手连接无限保留旧权限。对于浏览器连接，Origin 校验可降低跨站 WebSocket 劫持风险，但不是身份认证；Cookie 认证还需考虑 SameSite/CSRF 等上下文。

TLS 保护传输中的窃听/篡改，不保护被盗 token、重放的业务 command、服务端逻辑越权、日志泄露或恶意高频调用。敏感操作使用短期 token、nonce/request id、服务端 timestamp/sequence 窗口和幂等记录；避免把 token/query payload 写入 URL、metrics label 或未脱敏日志。

## 安全检查

校验 origin/来源、token 生命周期、重放 nonce、消息大小、解析深度、压缩炸弹和速率；日志避免泄露 token/隐私。客户端输入必须在服务端按业务不变量重新验证。

压缩应在解压后也检查最大大小/比率/CPU，permessage-deflate 等扩展会改变资源与侧信道边界；高压缩比小 frame 可能展开为巨大对象。授权检查在 decode/type 路由后、业务 effect 前执行；错误信息对外避免泄露其他 tenant/resource 是否存在，对内日志保留安全分类与 correlation id。

## HTTP 重试与幂等边界

GET/HEAD 等方法的协议幂等性不自动等于业务无副作用；POST 也可以通过 idempotency key 实现安全重试。连接断开/timeout 后客户端不一定知道服务端是否已完成，尤其是写操作：用稳定 request id 查询/重放同一结果，而不是生成新请求。服务端按身份/operation scope 存储 request result，并给过期/重试窗口明确 TTL。

代理、CDN、LB 会改写超时、连接、header、缓存和 WebSocket idle 行为。发布前验证真实部署链的 max header/frame、TLS 终止、sticky/session routing、idle timeout、健康检查和 drain；本地直连通过不代表生产 proxy 可用。

## 验证

测试慢消费者、断线重连、旧 token、乱序 cursor、恶意超长 frame、代理 idle timeout 和 TLS 证书轮换。指标包括 active connection、send queue、close reason、auth failure、P99 latency 和 parse error。

| 注入 | 必须验证 | 记录 |
| --- | --- | --- |
| deploy/网络切换断线 | cursor 恢复或 snapshot，旧 epoch 不污染新会话 | reconnect time、resync、duplicate/stale drop。 |
| 慢读 client | queue 有界且不影响其它连接 | queue bytes/age、coalesce/drop、close reason。 |
| token 过期/权限撤销 | 后续消息拒绝/重认证，不沿用旧权限 | auth decision、tenant/role trace。 |
| 重复 command/响应丢失 | 幂等结果一致，副作用只一次 | request id、attempt、business result。 |
| 压缩/大包/深嵌套 | 早拒绝，不 OOM/CPU 饥饿 | parser reject、allocation、CPU。 |
| proxy idle/TLS rotation | 预期 close/reconnect，证书更新不中断超过预算 | LB/handshake/close code、SLO。 |

在真实客户端、代理和网络条件下保存协议版本、配置、packet/trace 摘要、build 和测试账号隔离信息。安全测试不以“没有 crash”作为通过：需要明确拒绝原因、资源上限、审计和业务不变量。

## 参考资料

- [www.rfc-editor.org/rfc/rfc9110](https://www.rfc-editor.org/rfc/rfc9110)
- [www.rfc-editor.org/rfc/rfc6455](https://www.rfc-editor.org/rfc/rfc6455)
