---
slug: network-sync-prediction-reconciliation
title: 游戏网络同步：预测、插值与校正
date: 2026-09-30
updated: 2026-09-30
category: 计算机网络
reading_time: 4 分钟
tags: 网络同步 | 预测 | 插值
summary: 区分 simulation tick、render frame 和 snapshot，建立预测、插值、校正与 rollback 的状态合同。
---

# 游戏网络同步：预测、插值与校正

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

权威服务器决定可验证的真实状态。客户端为本地操控角色做预测以降低输入延迟；远端角色通常对带时间戳的快照做插值以平滑抖动；收到权威快照后，本地角色将确认 tick 的状态对比历史，必要时校正并重放未确认输入。实现前必须给每个字段定义 owner、精度、频率、可靠性和带宽预算。

## 时序模型

```text
Client tick 120: input command -------------------> Server
Client: predict state[120], retain command history
Server tick 120: validate -> authoritative state
Server snapshot(tick 120) ------------------------> Client
Client: compare state[120] -> restore -> replay command[121..now]
```

协议时间需要精确定义：客户端输入通常携带 input sequence/tick，服务器快照需标注 simulation tick 与 acknowledged input；只带 wall-clock timestamp 会受时钟漂移影响。每个 peer 还需要估计 server time 与本地时间偏移，并处理重连后的 epoch/session 变化，避免旧连接包污染新状态。

远端实体不应直接跳到最新 snapshot；通常渲染在服务器时间稍后的一个插值缓冲区中，在相邻快照之间插值。缓冲区越大越稳定，但视觉延迟越大。

## 预测与校正的状态合同

要重放输入，服务器和客户端必须对影响预测的状态字段达成同一序列化/初始化/更新顺序。最小合同包括：

| 状态类别 | 示例 | 预测/复制策略 | 设计风险 |
| --- | --- | --- | --- |
| 输入驱动运动 | 位置、速度、地面状态 | 本地预测；服务器 ack tick 后校正/重放 | 碰撞、浮点和移动模式需同语义。 |
| 权威经济/战斗结果 | 生命、库存、命中确认 | 服务器验证并复制 | 客户端不能通过预测写成权威事实。 |
| 纯表现状态 | 相机 shake、粒子、音效 | 本地触发或由事件提示 | rollback 后要去重/补偿，不能重复播放。 |
| 远端连续运动 | 对手位置/姿态 | snapshot interpolation，必要时 extrapolate | 外推窗口必须有限。 |

客户端保留的历史要有明确上限：输入命令、预测状态、碰撞相关世界快照以及服务器 ack。过旧快照到达时要定义忽略、硬校正或断线；不能无限保存历史来换取“总能重放”。

校正流程通常是：找到权威状态对应 tick、比较可预测字段、若误差超过规则则 restore、重放未确认输入，再对视觉 transform 做短时平滑。不能把模拟状态和渲染状态合二为一，否则平滑会反馈到下一个物理预测，造成误差持续扩大。

## 插值缓冲与外推

客户端渲染远端角色时，维护按 server tick 排序的 snapshot buffer。选择比当前估计服务器时间落后 `bufferDelay` 的两个快照做插值；buffer 越大越能吸收抖动/丢包，但多带来同等量级的视觉延迟。buffer 自适应可依据 arrival jitter，但需限制上下界和变化速率，避免画面延迟忽快忽慢。

若 buffer 没有后续快照，可短时外推速度/简单运动；复杂碰撞、技能或突然转向下，外推误差快速放大。要设置最大 extrapolation duration，超限后 freeze、降级或等新权威状态，不无限猜测。

## Tick 与带宽预算

网络 tick、服务器 simulation tick、客户端 render frame 和 snapshot send rate 是不同频率。通常 snapshot 可低于 simulation tick，通过 delta/compression/relevance 降带宽；客户端按显示帧插值。设计表必须写清哪个状态在哪个频率采样、哪些事件在 tick 间排队、迟到 input 的裁决方式。

```text
per-client egress ~= snapshot header
                 + relevant entities * (quantized state bytes + per-entity overhead)
                   * snapshot rate
                 + reliable events + retransmissions
```

interest management/relevance 不只减字节，也定义客户端能看到哪些实体和何时初始化。delta snapshot 必须可在丢失 base snapshot 后恢复：周期 keyframe、acknowledged baseline 或重同步机制；不能让一个丢失增量永久污染后续解码。

## 决策表

| 策略 | 适用 | 成本/风险 |
| --- | --- | --- |
| 权威状态快照 | 复杂物理、MMO、强反作弊需求 | 带宽、校正、远端平滑。 |
| 输入驱动 lockstep | 强确定性规则、RTS/战棋 | 等待慢客户端、严格确定性、重连复杂。 |
| prediction + reconciliation | 即时操控动作 | 状态历史、重放、视觉误差处理。 |
| rollback | 对抗动作、低延迟交互 | 确定性、状态保存、CPU/内存和调试复杂度。 |

这四种策略并非互斥：一个 action game 可以对本地移动做预测、对远端角色插值、对权威生命做 snapshot、对关键近战动作做短 rollback。选型按**状态类别**而不是给整个游戏贴一个标签。

Rollback 尤其依赖完整、可恢复的 simulation state 和确定输入顺序。它要保存最近 N tick 的状态/输入，出现权威差异后恢复旧状态并重跑。所有参与模拟的随机数、碰撞次序、计时器和外部事件都需可重演；副作用（音效、粒子、成就、日志）需要确认阶段或可去重，避免重放多次触发。

## 必须量化的预算

- tick rate、snapshot rate、最大并发实体数。
- 每实体每次快照字节数、可靠/不可靠比例、relevance/priority 策略。
- RTT、jitter、loss 下的本地误差 P95/P99、回退 tick 数和校正频率。
- 服务器 tick 的 CPU 预算及异常输入验证成本。
- 每个客户端的历史 buffer bytes、快照基线大小与 keyframe 间隔。
- 输入迟到/超前窗口、最大外推时长、重连 epoch 和重同步成本。

## 常见错误

- 用 RPC 传高频连续状态；RPC 是事件语义，状态复制是最终状态语义。
- 未带 tick/sequence，导致无法判断迟到包与重放边界。
- 只在 localhost 双开测试；没有模拟 jitter、loss、乱序和 200ms RTT。
- 让客户端决定伤害、命中或资源扣除；应由权威侧验证。
- 用 render frame 当网络 simulation tick，帧率变化后导致不同客户端状态演进次数不同。
- 仅平滑 Transform 却继续用平滑后的 Transform 参与权威预测/碰撞，造成模拟状态污染。
- delta snapshot 引用未确认/已丢失 baseline，解码状态长期错误。
- rollback 重放时重复产生粒子、音效、奖励等不可逆副作用。
- 将所有消息放同一可靠有序通道，让旧数据的重传阻塞时效更重要的新状态。

## 参考资料

- [gafferongames.com/post/networked_physics_2004](https://gafferongames.com/post/networked_physics_2004/)
- [gafferongames.com/post/snapshot_interpolation](https://gafferongames.com/post/snapshot_interpolation/)
