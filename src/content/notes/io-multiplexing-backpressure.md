---
slug: io-multiplexing-backpressure
title: I/O 多路复用与背压
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 5 分钟
tags: I/O | 多路复用 | 背压
summary: 区分 readiness、completion 和业务执行，用有界 framing 与排队模型设计 I/O 服务。
---

# I/O 多路复用与背压

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

I/O 多路复用让一个或少量线程等待多个 socket/FD 的就绪事件，避免“一连接一阻塞线程”的线程栈和上下文切换成本。它解决等待效率，不解决业务处理慢、无限排队或协议设计错误。服务稳定性的关键是背压：当下游消费不过来时，要限制读取、限制入队、丢弃可过期数据或尽早拒绝。

## 事件模型

```text
socket readable -> read until EAGAIN / buffer limit -> decode frames -> enqueue work
socket writable -> drain bounded send queue -> disable write interest when empty
worker complete -> schedule response -> enable write interest
```

以 epoll 为例，level-triggered 更容易实现；edge-triggered 需要在收到通知后读/写到 `EAGAIN`，否则可能丢失后续通知。无论模式，单个连接/事件处理都需要预算，避免热点连接饿死其他连接。

## readiness、completion 与业务执行是三层事

I/O 多路复用的“就绪”只表示一次系统调用可能推进，不表示一条完整协议消息已经到达，也不表示业务可以无限处理：

| 层 | 回答的问题 | 典型对象 | 不能推出 |
| --- | --- | --- | --- |
| readiness | 现在读/写会不会阻塞？ | `epoll`, `select`, `poll` | 一次就能读完整包。 |
| completion | 异步请求是否已完成，结果是多少？ | IOCP、runtime async socket API | callback 中的业务不占 CPU。 |
| protocol | bytes 如何变成有边界、已验证的消息？ | framing parser、decoder | header 已到就可相信 length/payload。 |
| application | 消息何时被接受、排队、拒绝或丢弃？ | actor/worker/DB request | event loop 能承受无限业务积压。 |

在 non-blocking socket 上，`read` 可以返回少量字节、`EAGAIN`、EOF 或错误；`write` 也可能只写一部分。任何假设“一个 read 对应一个 packet”或“一个 write 对端一次收到”的代码都不是可靠协议实现。

## 有界 framing 状态机

以 length-prefix 协议为例，连接 owner 需要持有残留 buffer 和解析状态：

```text
bytes arrive
  -> append only while per-connection buffer < maxBufferedBytes
  -> enough for fixed header? otherwise await next readable event
  -> validate length/type/version before allocation
  -> enough for payload? otherwise await next readable event
  -> decode one bounded frame, enqueue or reject it
  -> repeat only up to this connection's work budget
```

`length` 必须在按它分配内存前检查：非负、不过协议最大值、不过连接/全局 buffer 预算。解码器还需限制嵌套深度、集合数、字符串长度和每次事件可解析帧数；恶意 client 可以用许多合法小帧或一个永不结束的大帧占满 CPU/内存。

写路径同样需一个明确 owner：response 被序列化后进入每连接有界 send queue；可写事件只 drain 到本轮字节/时间预算；队列清空后移除 write interest。若队列满，必须按消息语义做决定，而不是继续分配。

## 背压决策

| 队列/资源 | 过载症状 | 可选策略 |
| --- | --- | --- |
| 收包 buffer | 内存上涨、解码滞后 | 暂停 read interest、限制帧大小、断开违规连接。 |
| 业务队列 | 排队延迟上涨 | 有界队列、按优先级丢弃、快速失败、扩容。 |
| 发包队列 | 慢客户端积压 | 最新状态覆盖旧状态、上限后断开、降采样。 |
| 下游 RPC/DB | 超时重试风暴 | deadline、并发上限、熔断、退避。 |

背压必须沿调用链传播。若 event loop 停止从 socket 读取，但 kernel receive buffer、client 发包、代理重试和业务队列仍在无限增长，系统只是把内存压力移到别处。每个队列应有 owner、容量、单位、满时策略和一个可观测 drop/reject 原因。

### 用排队模型检验容量直觉

Little 定律的形式 `L = λW` 很有用：稳定状态中，平均排队项数 `L` 约等于到达率 `λ` 乘等待时间 `W`。它不是容量公式，但能暴露矛盾：若 10k msg/s 持续流入、下游每条等 2 秒，那么系统平均要承载约 20k 条工作；把队列上限设为 1k 只能意味着快速拒绝/降级，不能同时承诺零丢失和 2 秒等待。

| 消息语义 | 满队列时常见正确策略 | 不应做 |
| --- | --- | --- |
| 最新状态可覆盖 | coalesce by entity/key，仅保留最新版本 | 排队每个过期位置同步。 |
| 可靠命令 | 有界等待、拒绝并让上游按 idempotency retry | 静默丢弃“看起来不重要”的命令。 |
| 心跳/遥测 | 采样或丢弃，并计数 | 让 telemetry 挤掉玩家指令。 |
| 恶意或超限数据 | 尽早关闭/限流并记录原因 | 继续分配直至 OOM。 |

## 公平性、deadline 与关闭

一条活跃连接若在每次 readable event 中读到 `EAGAIN` 才退出，可能在高吞吐情况下独占 event loop；edge-triggered 模式又要求完全 drain。解决方法不是违规半读，而是对 bytes、帧数和业务提交设预算，在必要时把剩余工作重新调度，同时仍正确维护 interest。策略需用压力测试验证，不可凭直觉。

每一层都应携带 deadline：socket idle timeout、decode budget、队列等待上限、RPC deadline、请求总 deadline。超时时应取消尚未开始的工作、释放 buffer、生成可区分的拒绝原因；不要让下游超时后上游继续排队并追加无限重试。连接关闭时也要明确：停止 read、拒绝新 response、drain 还是丢弃已有 send queue、如何释放 decoder 状态。

## C# / Unity 服务端边界

`async` socket API 可以由运行时的 I/O completion 机制驱动，不应把每个 `ReadAsync` 误解为独立工作线程。回调中的业务计算仍会耗 CPU，重任务应进入受限的 worker/actor；而 Unity 客户端网络回调需回到主线程应用到 Unity 对象。

`await` 的关键问题仍是所有权：谁拥有 receive buffer，何时可以归还 pool，cancellation 后 read 是否可能完成，连接结束时谁等待/取消未完成操作。不要在 socket callback 内做数据库、JSON 大对象反序列化或 Unity API 调用；将完成的、已验证的 frame 转成明确的工作单元，再按并发上限交给下游。

## 验证

进行慢读客户端、突发连接、畸形超长帧、下游延迟和断连压力测试。记录 connection count、队列长度、event loop lag、每连接内存、拒绝数、尾延迟和恢复时间。

| 故障注入 | 必须验证 | evidence |
| --- | --- | --- |
| 只发半个 header/payload | 连接不 busy-loop，不错误分配；超时可回收 | decoder state、buffer bytes、timeout log。 |
| 长度为负/超最大值 | 立即拒绝，不创建大对象 | reject reason、连接行为。 |
| 慢读 client | send queue 有上限，其他 client 仍有服务 | per-connection bytes、event-loop lag。 |
| 突发合法小帧 | per-event/worker budget 生效，不饥饿 | frames/s、queue depth、P99。 |
| DB/RPC 变慢 | 读取/入队按策略退压，恢复后不雪崩 | in-flight、deadline、reject/drop rate。 |
| 断连与取消竞态 | buffer/任务只释放一次，无悬挂 response | pool accounting、exception trace。 |

在结论中同时报告流量形状：连接数、每连接速率、帧大小分布、慢客户端比例、下游服务时间与测试时长。没有这些分母的“每秒能处理多少”无法外推。

## 参考资料

- [man7.org/linux/man-pages/man7/epoll.7.html](https://man7.org/linux/man-pages/man7/epoll.7.html)
- [learn.microsoft.com/dotnet/fundamentals/networking/sockets/socket-services](https://learn.microsoft.com/dotnet/fundamentals/networking/sockets/socket-services)
