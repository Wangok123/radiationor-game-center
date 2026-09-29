---
kind: note
tags: [Unity, Profiler, Performance, Debugging]
status: seed
scope: "Unity 2022.3 profiling workflow; conclusions require the recorded device, player build, quality settings, workload, capture settings, and raw artifacts."
last_reviewed: 2026-09-29
sources:
  - https://docs.unity3d.com/2022.3/Documentation/Manual/Profiler.html
  - https://docs.unity3d.com/2022.3/Documentation/Manual/profiler-profiling-applications.html
  - https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Unity.Profiling.ProfilerRecorder.html
related: ["[[Advanced/09_性能证据链与基准设计]]"]
---

# Profiler：从诊断到修复的闭环

## 30 秒回答

Profiler 的用途是定位并证明瓶颈，不是寻找最大的一根条。先确保采样环境可比较，再按帧尖峰/尾延迟分类为 CPU、GPU、内存、IO 或同步；沿调用栈找到可控的工作量或等待原因；做最小改动后复测同一 workload，并检查是否把成本迁移到其他线程或 GPU。

## 四步闭环

1. **定义症状**：卡顿发生的场景、频率、P95/P99、目标设备与 build。
2. **分类等待/工作**：Main Thread、Render Thread、worker、GPU、GC、loading；`Gfx.WaitForPresent` 和 `JobHandle.Complete` 的含义不同。
3. **提出假设**：例如“UI 文本导致 Canvas rebuild”或“发包队列在慢网下增长”，而不是“优化 Update”。
4. **最小变更复验**：保留 before/after capture、影响范围和回归阈值。

每一步都应有可反驳内容。例如“减少 Canvas rebuild”不是假设；“每帧更新的文本使 `Canvas.BuildBatch` 调用次数上升，且分离该区域会在同一 workload 下减少 Main Thread P99，而不会令 GPU/draw 超预算”才是可被 capture 否定的假设。

## 先确定观察窗口

一个 capture 若混入加载、暂停菜单、战斗、后台切换和 shader warm-up，任何平均数都没有明确语义。开始前记录：

| 维度 | 最小记录 |
| --- | --- |
| workload | 场景、输入回放、实体数、相机、时长、随机种子。 |
| player | commit、Unity/package、Development/Release、target、backend、define。 |
| device | 型号、OS、分辨率、quality、帧率上限、温度/电量状态。 |
| profiler | 连接方式、Deep Profile、call stack、profile area、capture 起止帧。 |
| warm-up | 已加载资源、对象池状态、shader 状态，冷启动是否单独记录。 |

以帧时间而不是 FPS 计算 P50/P95/P99；将冷启动、稳定战斗和场景切换分别看作不同 workload。详细 percentile 口径与基准合同见 [[Advanced/09_性能证据链与基准设计]]，本页聚焦于如何从一份 capture 收敛到可验证的改动。

## 从线程时间线走到可控工作量

先看 Timeline，而非直接点 Hierarchy 最大项：

```text
Long frame
  -> Main Thread busy?          -> find call count, allocation, per-call cost
  -> Main Thread waiting?       -> inspect dependency, VSync, render/GPU timeline
  -> Render Thread submission?  -> correlate batches, SetPass, culling, material changes
  -> GPU over budget?           -> use GPU profiler / Frame Debugger / RenderDoc
  -> Worker busy or waiting?    -> inspect job dependency graph and Complete points
  -> Memory/IO event?           -> correlate GC, native growth, loading and page faults
```

一个 marker 的 self time 是它自身工作；total time 包含子调用。自顶向下先看总耗时与调用次数，再用调用树确认是哪一个子节点改变。只盯 self time 容易漏掉深层分配；只盯 total time 又可能把共同父节点误当根因。

## Marker 解读边界

| Marker/现象 | 可能含义 | 不能直接推出 |
| --- | --- | --- |
| `GC.Alloc` | 当前调用有托管分配 | 一定会立刻卡顿。 |
| `Gfx.WaitForPresent` | CPU 正等待图形呈现/帧限制 | 唯一的 GPU 瓶颈位置。 |
| `Canvas.BuildBatch` | UI 批处理重建成本 | 只要拆 Canvas 就会更快。 |
| `Physics.Simulate` | 物理模拟耗时 | 降 `fixedDeltaTime` 一定正确。 |

还应区分“工作”与“等待”。`Gfx.WaitForPresent` 说明 CPU 处于等待图形呈现或帧限制的状态，下一步要比较 GPU 帧、VSync、帧率上限、Render Thread 和 pass 成本；它不是一个可直接优化的函数。`JobHandle.Complete` 高也可能是正确的同步点，只是暴露了上游 job 太晚 schedule、依赖过大或 batch 不合理。

## 常见症状的证据包

| 症状 | 第一份证据 | 第二份证据 | 典型错误动作 |
| --- | --- | --- | --- |
| 高频 Main Thread | Timeline + Hierarchy + call count | allocation 与输入/实体规模关系 | 把所有逻辑改 Job。 |
| 偶发尖峰 | 尖峰帧的完整调用树 | GC、资源加载、锁、scene 事件 | 用平均 FPS 宣布无卡顿。 |
| GPU 慢 | GPU frame time、Frame Debugger/RenderDoc | 分辨率、overdraw、pass、带宽 | 只减少 draw call。 |
| UI 打开变慢 | Canvas rebuild/batch marker、脏化来源 | draw、GPU、布局/文本频率 | 机械拆 Canvas。 |
| 内存持续增长 | 同 workload 的两次 Memory Profiler snapshot | owner/handle/cache 台账 | 看到 reserved memory 就判泄漏。 |
| 加载卡顿 | loading marker、IO/CPU/GC 时间线 | asset dependency、解压和激活阶段 | 只把 API 改成 async。 |

要把样本与业务工作量关联。例如 AI marker 增加 2ms，先问活跃单位、查询次数、路径长度、缓存命中和 camera/scene 是否相同；不清楚分母的毫秒比较通常不能指导容量预算。

## 改动前后的对照设计

1. 先冻结 baseline：同一 commit、设备、场景、预热与输入，保存原始 `.data`/trace。
2. 一次只改变可解释的一组因素，例如“计数器刷新频率”而不是“重做整个 UI”。
3. 基线与候选交错重复，避免 thermal、后台任务和缓存热度只偏向一侧。
4. 对照 CPU、GPU、GC、native memory、draw/quality 和 P95/P99，不把成本迁移视为优化。
5. 写下接受条件和回滚条件；未达标时保留失败 capture，不要只留下成功截图。

`Deep Profile`、Editor 连接和 Development Build 都会改变成本。它们适合定位调用链，但不能未经说明与 release player 的帧预算并列。要比较 release 性能时，使用同一种 player/profile 配置；要解释调用链时，将高开销诊断 capture 单列。

## Capture 卫生

记录 commit、Unity/package 版本、设备、分辨率、quality、warm-up、采样时长和是否连接 Editor。Deep Profile、Profiler 连接、Development Build 都可能扭曲数据，不能和 release 数据混用而不标注。

capture、导出 CSV/JSON、build provenance 和最慢帧调用树应一起归档。图片只能辅助沟通，不能替代可重新打开的原始数据；单个 `ProfilerRecorder` 数字也不能替代多线程、GPU 与内存的完整归因。

## LAT 项目映射与边界

`Assets/Scripts/Editor/CombatFeelLabProfilerAnalyzer.cs` 和 `Assets/Tests_PlayMode/CombatFeel/combat-feel-lab-baseline_test.cs` 设计了 16 x 16 命中检测压力腿、60 tick 预热和 300 tick 样本窗口；`CombatFeelLabOverlay.cs` 也明确把 `OverlaySample` marker 限定在快照读取。这是很好的“先固定正确性 workload，再采样 marker”范例。

源码同时限制了结论：分析器读取特定线程和 marker 子树，不能代表整帧、GPU、worker、native memory 或长时间 thermal 行为。当前没有归档的本机 capture/JSON/XML 时，不可说该 workload 已达标。完整边界与升级流程见 [[../Project_Experience/LAT_CombatFeelLab性能采样与Profiler证据案例]]。

## 最小行动模板

```text
Observation: 低端 Android 战斗 P99 = 48ms，UI 打开时出现尖峰
Hypothesis: 高频计数器使主 Canvas 每帧 rebuild
Change: 高频区域独立 Canvas，并限频文本刷新
Evidence: 同设备/路径 capture，BuildBatch -Xms，P99 -Yms，draw +Z
Decision: 若 GPU/draw 回归低于阈值则保留，否则调整拆分
```

## 验证清单

- [ ] 症状已量化为场景、频率、帧时间分位数和目标设备，而不是“感觉卡”。
- [ ] 时间线已区分 CPU 工作、CPU 等待、GPU、worker、GC/内存和 IO。
- [ ] 假设指出了可改变的工作量及其反证，不是一个泛化的优化动作。
- [ ] before/after 使用同一测量合同，并保留原始 capture 与 provenance。
- [ ] 验证了成本没有转移到 GPU、其他线程、内存、画质或错误恢复路径。
- [ ] 未达标/失败的 capture 同样被归档，下一次可复现。

## 面试追问

- `Gfx.WaitForPresent` 高说明什么？说明 CPU 在等待呈现或帧限制，需要继续看 GPU/Render Thread/VSync；不是“这个函数慢”。
- 为什么平均 FPS 不够？少量严重长帧会被平均值掩盖，应在固定 workload 下报告 frame-time P95/P99 与对应帧归因。
- 为什么优化后还要看 GPU 和内存？局部 CPU marker 下降可能通过更多 draw、缓存或异步队列把成本转移到别处。
