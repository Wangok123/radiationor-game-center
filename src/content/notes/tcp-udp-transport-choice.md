---
slug: tcp-udp-transport-choice
title: TCP、UDP、可靠性与传输选择
date: 2026-09-30
updated: 2026-09-30
category: 计算机网络
reading_time: 4 分钟
tags: TCP | UDP | 可靠性
summary: 先定义消息语义和失败处理，再选择 TCP、UDP 或带应用层可靠性的传输方案。
---

# TCP、UDP、可靠性与传输选择

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

TCP 提供面向字节流的可靠、有序传输和拥塞控制，但某个丢失段会阻塞后续字节交付，产生 head-of-line blocking。UDP 提供尽力而为的数据报，不保证可靠、有序或拥塞控制；应用可按不同消息语义选择丢弃、重传、排序和限速。游戏不是简单地“实时用 UDP、业务用 TCP”：关键是每类消息是否要求可靠、顺序、最新值优先以及怎样处理拥塞。

## 消息语义先于协议

| 消息 | 可靠性 | 顺序 | 过期处理 | 示例 |
| --- | --- | --- | --- | --- |
| 登录/支付结果 | 必须 | 通常必须 | 不可丢 | HTTP/TCP/QUIC stream。 |
| 输入命令 | 通常重要 | 按 tick 处理 | 迟到可丢/补 | UDP/自定义可靠层。 |
| 位置快照 | 可丢 | 最新优先 | 旧包立即丢 | UDP datagram。 |
| 技能释放事件 | 通常必须 | 按实体/技能链 | 需去重 | 可靠消息 + event id。 |

不要按“数据类型”把整个游戏强行塞进一条可靠有序通道。一个实体的高频位置快照可能应当可丢且最新优先，而同一实体的技能释放事件需要可靠去重；两者混在可靠有序 stream 时，丢失一个旧位置包可能阻塞后续最新状态。反过来，把所有消息放 UDP 也会让业务自己承担重传、拥塞、公平和安全责任。

为每种消息写一个合同：

```text
owner + message id + sequence/tick + deadline
reliability + ordering scope + max size + congestion budget
duplicate/late/loss behavior + schema version
```

| 语义 | 典型实现倾向 | 关键反例 |
| --- | --- | --- |
| 最新值状态 | 不可靠 datagram + sequence，旧包丢弃 | 必须确认状态才能继续的命令不能直接丢。 |
| 可靠事件 | 可靠层/stream + event id + 幂等 | 不代表所有同连接消息都必须全局有序。 |
| 有序命令流 | per-channel/per-entity sequence | 单一全局序会引入跨实体队头阻塞。 |
| 大块可靠内容 | TCP/QUIC stream/HTTP | 不应与实时小包共享阻塞语义而无隔离。 |

## TCP 的两个常见坑

- TCP 是 **byte stream**，没有业务消息边界。应用必须自定义 length-prefix/分隔符协议，并处理半包、粘包、读到 0（对端关闭）和最大包长。
- TCP 可靠性不等于无限吞吐。拥塞窗口、接收窗口和重传超时会影响延迟；慢消费者和无限发送队列会造成内存增长与延迟雪崩。

TCP 的可靠、有序是每条连接上的字节语义：应用不能越过丢失字节先交付后续字节。多个独立数据流若共享一条 TCP connection，某个流丢包可能使其它逻辑流也等待；QUIC 的多个 stream 在传输层有独立有序空间，但仍共享连接级拥塞控制和路径带宽，不能消除所有队列/拥塞耦合。

TCP 调参前分解 RTT、丢包、cwnd、接收窗口、应用读取速度和 Nagle/delayed ACK 等因素。小包延迟可能来自应用 batching 或发送缓冲，不应只怪协议；关闭 Nagle 也会增加小包数量和网络开销。不要在未经目标网络测量时把 socket option 当作通用低延迟开关。

## UDP 不等于“不可靠网络方案”

UDP 只是数据报传输接口，不为应用提供确认、排序、重复消除、拥塞控制、MTU 探测或连接迁移。应用若在 UDP 上实现可靠层，还要正确处理：

- sequence wraparound 与接收窗口，迟到/重复包不能误认为新消息。
- RTT/RTO 估计，不能用固定极短 timeout 造成重传风暴。
- 选择性 ACK/重传与消息过期；过期位置快照不值得重发。
- 拥塞响应、公平性和带宽预算；可靠 UDP 不能无限发包。
- fragmentation 与 path MTU；单个 IP 分片丢失会让整个 datagram 作废。
- authenticated connection/token、防伪造、放大攻击和重放保护。

实时状态常用序列号丢弃旧值；重要事件可以单独可靠通道重传。把整个自定义协议做成“UDP 上的 TCP”容易得到更少成熟度、更多安全漏洞，而没有获得所需的消息语义隔离。

## 拥塞控制是正确性的一部分

不管 TCP、QUIC 还是自定义 datagram，拥塞意味着路径容量不足；应用持续以固定高频发送会增加排队时延、丢包和所有人的体验。按优先级分配预算：控制/关键输入、重要事件、快照、语音/效果/遥测分别给出上限与降级策略。快照可降低频率、精度或只发变化；事件通常要可靠但可限量；遥测可抽样。

带宽估算按方向分别算：

```text
bytes_per_second = (header + payload + auth/transport overhead)
                    * messages_per_second
                    * recipients/fanout
```

还要计入 ACK、重传、加密、协议头、NAT/IPv6 和峰值同步。平均字节预算不代表 burst 可控；发送队列应同时限制 bytes 和 age。旧快照积压时，清空队列发送 2 秒前状态比直接丢弃更糟。

## 应用层可靠 UDP 的最低组件

sequence/ack、去重窗口、重传超时、RTT 估计、拥塞/速率控制、消息大小限制和 fragmentation 策略。没有这些，"UDP 可靠化" 往往只是在复制 TCP 的一部分 bug。优先评估成熟库或 QUIC，而不是从零手写。

决策时把协议放进系统上下文：部署网络是否允许 UDP、是否需要代理/CDN、连接迁移、加密、stream 多路复用、服务端 SDK、观测工具和版本升级。一个传输层在实验室胜出但被移动网络或企业防火墙阻断，不是有效方案。

## 验证

在真实/模拟网络下测 RTT、jitter、loss、乱序、带宽受限和移动网络切换。观测 p95/p99 延迟、重传率、发送队列、过期快照丢弃率和断线恢复成功率。

| 网络条件/故障 | 要检查的合同 | 指标 |
| --- | --- | --- |
| 随机/突发 loss | 快照是否过期丢弃，事件是否按界限重传 | loss、retransmit、event completion。 |
| reorder/duplicate | sequence window、幂等和顺序 scope | duplicate/late drop、状态回退数。 |
| 带宽骤降 | priority、coalescing、队列 age 上限 | queue bytes/age、P99 state age。 |
| RTT 与 jitter 上升 | timeout、插值缓冲、预测误差 | RTT 分位数、纠正次数、过期包率。 |
| path/NAT 切换 | rebind/connection migration 与认证 | reconnect time、状态丢失/重放。 |
| 恶意大包/伪造包 | size/auth/replay/CPU guard | reject reason、CPU、分配与 amplification。 |

将模拟器参数、版本、网络 trace、客户端数、消息分布和服务端 build 一起保存。localhost 只适合验证协议状态机基本正确，不代表真实公网延迟、丢包、公平性或 MTU。

## 参考资料

- [www.rfc-editor.org/rfc/rfc9293](https://www.rfc-editor.org/rfc/rfc9293)
- [www.rfc-editor.org/rfc/rfc9000](https://www.rfc-editor.org/rfc/rfc9000)
