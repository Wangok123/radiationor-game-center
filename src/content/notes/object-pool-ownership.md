---
slug: object-pool-ownership
title: 对象池：所有权与容量策略
date: 2026-09-29
category: Unity architecture
reading_time: 9 min
excerpt: 对象池用复用换取更稳定的实例化/销毁成本和更少的短命分配，适合高频、同构、生命周期明确的对象。它不是默认优化：池会提高常驻内存、保留引用并引入状态重置、重复归还和场景残留风险。只有 Profiler 证明 `Instantiate/Destroy` 或分配位于热点后，才按峰值并发和回收策略设计池。
---
# 对象池：所有权与容量策略

## 30 秒回答

对象池用复用换取更稳定的实例化/销毁成本和更少的短命分配，适合高频、同构、生命周期明确的对象。它不是默认优化：池会提高常驻内存、保留引用并引入状态重置、重复归还和场景残留风险。只有 Profiler 证明 `Instantiate/Destroy` 或分配位于热点后，才按峰值并发和回收策略设计池。

## 先做模式选择，而不是先写 PoolManager

对象池适合高频 spawn/despawn、同构、可彻底 reset、且峰值并发有上界的对象，例如投射物、命中特效、临时音效 emitter、列表虚拟化项。它不应成为“出现 GameObject 就池化”的默认答案。

| 方案 | 适合的规模/生命周期 | 好处 | 必须接受的代价 |
| --- | --- | --- | --- |
| 直接 `Instantiate` / `Destroy` | 低频、一次性、状态复杂或资源很重的对象 | 生命周期最直观，不需 reset/lease 协议 | 高峰期可能出现 CPU、GC 或 native allocation spike。 |
| `ObjectPool<T>` / feature pool | 高频同构且可回收的对象 | 稳定峰值、减少创建销毁、可预热 | 常驻内存、双重归还、状态泄漏和场景残留。 |
| 静态预构建/常驻 view | 数量固定、整局都存在的对象 | 不需要 get/release 流程 | 初始加载和常驻内存，无法应对动态上限。 |

先用 Profiler 确认创建/销毁或其连带初始化位于热点，再选对象池。若 N 很小或对象只出现几次，直接生命周期通常比“正确池化”更可靠。`ObjectPool<T>` 解决复用容器，不会替你解决 prefab 加载、跨线程、Addressables handle、场景所有权或业务状态重置。

## 生命周期协议

```text
Pool.Get
  -> caller receives one lease (instance + lease generation)
  -> ActivateForUse: initialize only current-use state
  -> Active
  -> Release exactly once by the lease owner
  -> DeactivateAndReset: cancel/retire external work, clear transient state
  -> inactive cache OR destroy on capacity/scene shutdown
```

核心不是 `SetActive(false)`，而是 owner 和 lease：谁负责归还？对象是否可被重复归还？归还时如何取消 task、退订事件、停止粒子/动画并释放临时资源？为防止双重 release，development build 可维护 active state、lease id 或 collection check；生产环境也应保留可观测的 invalid-release 计数。

| 状态类别 | 激活时必须设定 | 归还时必须撤销/重置 | 容易遗漏的内容 |
| --- | --- | --- | --- |
| Transform / render | parent、position、scale、layer、sorting、material property | parent/layer override、trail/粒子残留 | 只重置位置，忘记颜色或排序。 |
| 玩法状态 | owner、team、damage、target、life deadline、随机 seed | collider、hit dedupe、状态机、计时器 | 上一个 owner 的伤害/阵营泄漏。 |
| 事件和回调 | 当前 lease 的订阅 | 对称 unsubscribe | lambda 无法用同一 delegate 退订。 |
| 异步工作 | request generation、completion owner | cancel/obsolete、观察异常 | 旧下载完成后激活已归还实例。 |
| 资源 | 当前实例使用的 handle/buffer | release 或移交给明确 owner | 以为回收 GameObject 就 release Addressables handle。 |

对象返回池后可能在下一帧立刻借给另一位 owner，因此所有延迟回调必须比较 lease generation。`this != null` 不能识别“同一个实例已被复用给别人”；它只能识别 Unity object 是否仍存在。

## 容量不是常量

容量应由并发和内存预算推导。稳定流量下可用 Little 定律作为估算起点：

```text
average concurrent ~= average spawn rate * average active lifetime
peak concurrent    = workload measurement, not a multiplier copied from another project
pool memory        = inactive count * retained instance memory + active instance memory + dependencies
```

这不是峰值预测公式。爆炸连锁、场景转场、首帧预热、网络抖动或玩家技能组合都会让分布出现长尾；必须从固定 workload 与真实 telemetry 采样 peak concurrency、overflow 和对象存活时间。

| 问题 | 设计选择 | 需要记录 |
| --- | --- | --- |
| 初始容量 | 根据常态并发预热，或在 loading phase 分批创建 | 预热时长、主线程峰值、首用 miss。 |
| 最大容量 | 根据 feature 内存预算设硬上限 | retained memory、active peak、overflow 次数。 |
| pool 满时 | destroy excess、拒绝、新请求合并、降低效果质量或借用共享实例 | 用户可见降级、丢弃率、是否破坏玩法。 |
| shrink | 空闲超过 TTL 后逐步销毁，或场景退出一次性清理 | 回收节奏、下一次 burst 的 re-create cost。 |
| 存储顺序 | 通常 LIFO 可提高最近使用对象的局部性 | 不要把“LIFO 更快”当作未测量结论。 |
| 分池粒度 | 每 prefab/feature/scene 明确隔离 | 防止 A feature 的 burst 占满 B feature 的关键容量。 |

视觉效果可以在池满时合并或省略；权威投射物、碰撞体或任务实体通常不能静默丢弃。容量策略必须随对象的领域重要性改变，不能由通用 pool API 隐藏。

## 场景、资源与跨域所有权

对象实例、prefab asset、Addressables operation handle、bundle 和下载缓存是不同生命周期。池化 GameObject 只管理实例复用；它不自动决定 prefab 的加载 handle 何时 release。推荐先选一个 scope：

| Pool scope | 适合对象 | 关闭时的责任 | 风险 |
| --- | --- | --- | --- |
| scene scoped | 敌人、关卡 VFX、zone 交互物 | 停止/取消 active lease，清空 inactive，销毁 scene-owned instance | 静态全局引用阻止 unload。 |
| feature/session scoped | UI composition、跨场景 loading FX | feature owner dispose 时释放 instance 和 prefab/resource owner | scope 太大导致内存永不下降。 |
| app scoped | 很少数 truly global 的 audio/UI 基础设施 | 明确 shutdown 与诊断入口 | 变成隐藏 singleton，难以统计归属。 |

当对象由 Addressables instantiate 得到时，instance 的回收、pool 的 reuse 与 handle/instance release 必须按当前 Addressables 版本和实际 API 成对设计。不要让一个 screen 关闭时 release 所有共享 prefab，也不要让 global pool 保存 scene-dependent component 引用。相关资源账本见 Advanced/10_资源引用生命周期与加载预算。

## Pool API 的最小边界

把对象的业务初始化暴露给任意 caller，会让 reset 规则散落。更稳妥的边界是由 feature-specific factory/lease 包装通用 pool：

```csharp
public interface IProjectileLease : IDisposable
{
    int Generation { get; }
    ProjectileView View { get; }
    void Launch(in ProjectileCommand command);
}
```

`Dispose` 或明确 `Release` 应只完成一次，并在同一 owner 处记录 spawn/release 原因。接口不是必须的；它只在能防止“外部直接 SetActive / Destroy / Release”这种真实错误时才值得引入。低频对象保持一个简单的 factory + `Destroy` 可能更好。

Unity 的 `ObjectPool<T>` 并不是线程安全容器。worker/Job 可以计算纯 spawn command，主线程的 feature owner 再执行 Get、初始化、Unity API 调用和 Release；不要把 pooled `GameObject`、`Transform` 或普通 managed pool 直接交给后台线程。

## 验证矩阵

| 测试/实验 | 注入 | 必须断言 | 不能证明 |
| --- | --- | --- | --- |
| lease 合同 | double release、release 后 completion、重复 Get | 只归还一次；旧 generation 不写入新 owner | 整帧性能。 |
| reset 合同 | 上一 lease 设置 team/material/event/target | 下一 lease 看不到旧状态 | Addressables/bundle 已回收。 |
| 场景生命周期 | active/inactive lease 后 scene unload | 无残留订阅、无 scene object 引用、正确 destroy/release | 真机 burst 吞吐。 |
| 容量压力 | 常态、峰值、超上限 burst | overflow 策略符合玩法；内存和 P99 在预算内 | 长时热量/碎片行为。 |
| soak | 多次进入/退出、随机 spawn/release | active count 回到基线；无 invalid release/GC 线性增长 | 所有设备的 native/GPU 行为。 |

用峰值粒子/投射物 workload 比较非池化、合理池容量、过度池化。记录 instantiate/destroy 时间、GC、native/managed/GPU 常驻、P99 帧、池命中/首用 miss/overflow、平均与最长 lease、重复归还和过期回调次数。只有满足体验与内存阈值的节省才算优化。

## 常见失败模式

- 预热容量只覆盖平均值，活动峰值时仍在同一帧大量 Instantiate。
- 只回收 GameObject，不取消 coroutine/task/事件订阅，下一 lease 收到上一次的回调。
- 池的 max 容量满时静默丢掉权威对象，造成玩法规则差异。
- object pool 常驻高分辨率纹理/粒子资源，消除了 GC 却使低端设备 native/GPU OOM。
- 全局 pool 存放 scene object 引用，使场景无法真正卸载。
- 先 `Destroy`，后把同一实例 `Release`，或多个 caller 都认为自己是 lease owner。

