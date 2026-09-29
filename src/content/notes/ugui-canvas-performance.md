---
kind: note
tags: [Unity, UGUI, Canvas, Performance]
status: seed
scope: "Unity behavior must be checked against the target Unity version, package/render pipeline, platform, and workload."
last_reviewed: 2026-09-29
sources:
  - https://docs.unity3d.com/2022.3/Documentation/Manual/UICanvas.html
  - https://docs.unity3d.com/2022.3/Documentation/Manual/UIAutoLayout.html
  - https://docs.unity3d.com/2022.3/Documentation/Manual/UIInteractionComponents.html
  - https://docs.unity3d.com/Packages/com.unity.ugui@1.0/manual/index.html
---

# UGUI Canvas 重建与性能

## 30 秒回答

UGUI 的性能瓶颈常是 Canvas rebuild、layout 计算、graphic 更新和批次碎片，而不是“UI 元素数量”本身。把高频变化元素与静态元素拆到合适 Canvas，减少 layout 链和不必要的 `SetActive`/文本重排；先在 Profiler 观察 `Canvas.BuildBatch`、layout marker 和实际 draw/batch，再决定拆分粒度。

## 不要把四类成本混为一谈

“UI 卡”可能是 CPU rebuild、layout 计算、draw/overdraw、输入 raycast、文本生成或资源加载。Canvas 拆分只能影响其中一部分；先将现象归到正确路径，避免把一个新的 Canvas 当成所有 UI 问题的解决方案。

```text
data / animation / RectTransform change
  -> mark layout and/or graphic dirty
  -> layout calculation and placement
  -> geometry / text mesh generation
  -> Canvas batch rebuild and render submission

pointer event
  -> GraphicRaycaster candidate scan
  -> EventSystem dispatch and navigation/focus handling
```

| 成本域 | 常见信号 | 不能直接推出 |
| --- | --- | --- |
| Layout | layout rebuild、`LayoutGroup`/`ContentSizeFitter` 调用 | 一定要删除所有自动布局。 |
| Graphic/Canvas CPU | `Canvas.BuildBatch`、UI mesh/text 生成 | 多拆 Canvas 一定更快。 |
| GPU | UI pass、fill-rate、overdraw、透明混合、mask | batch 少就一定 GPU 快。 |
| Input | `GraphicRaycaster`、EventSystem、点击/拖动延迟 | draw 高就是输入问题。 |
| 数据/文本 | 字符串格式化、TMP mesh、字体 fallback、GC | 文字少就没有文本成本。 |

一次父节点尺寸、字体、文本或层级变化可能使大量子节点参与 layout/rebuild。嵌套 `LayoutGroup` 与 `ContentSizeFitter` 尤其需要警惕：它们会产生多次父子方向的布局查询。具体 marker 名称和调用链受 Unity/UGUI/TMP 版本影响，应从当前目标 capture 读取而不是死背一条固定树。

## Dirty 传播与状态边界

不是每个 `SetText`、`SetActive`、锚点修改或动画属性变化都会触发完全相同的路径，但它们都应被当成潜在 dirty source。优化先回答“这个变化是否必要”和“它能否合并”，再决定怎样拆 Canvas。

| 变化 | 先问的问题 | 常用收敛方式 |
| --- | --- | --- |
| 每帧数字/倒计时 | 玩家是否需要逐帧精度？文本格式是否重复分配？ | 变化时更新、固定 Hz、缓存格式化、只显示可感知精度。 |
| 尺寸/内容自适应 | 该对象是否必须参与 parent 的自动布局？ | 批量写数据后一次刷新；缩短自动布局链；预留稳定尺寸。 |
| Tween/动画 | 是否同时动画 layout 和 graphic，导致两个方向的 dirty？ | 表现层用局部可控变换；避免每帧修改会影响大量 sibling 的结构。 |
| `SetActive`/重挂 parent | 是否只是要隐藏、还是确实结束实例生命周期？ | 选择显隐、CanvasGroup、池化或销毁时，记录各自 layout/raycast/资源语义。 |
| 列表增删 | 是否每次都重新布局全部行？ | virtualize、增量更新、批量提交、稳定 item 高度/估算策略。 |

`Canvas.ForceUpdateCanvases` 之类的强制同步更新只能用于明确需要立即读取布局结果的边界，不能作为每帧“修复显示”的常规手段。它会把原本可合并的工作拉到当前调用点，掩盖真正的 dirty 来源并制造尖峰。

## Canvas 是隔离边界，不是免费分组

将高频更新元素从静态元素分离，可能减少静态部分被反复 rebuild 的 CPU 成本；同时它也可能增加 Canvas 数、batch/draw、排序与管理复杂度。拆分依据应是**更新频率、空间/排序关系和材质边界**，而不是按每个 prefab 或视觉层级机械拆分。

| 方案 | 适用情况 | 预期收益 | 主要代价/反证 |
| --- | --- | --- | --- |
| 单 Canvas | UI 小、变更少、同材质/排序稳定 | 结构最简单，batch 合并机会多 | 高频子节点可能使大静态树重复参与 rebuild。 |
| 按更新域拆 | 静态背景、低频列表、高频计数器/动画明显分离 | 限制 CPU dirty 传播范围 | 每个 Canvas 可能增加 draw，交叠区域会加重 overdraw。 |
| 每组件独立 Canvas | 只有明确的 CPU rebuild 极端热点 | 局部变化几乎不污染兄弟 | 常因 Canvas/draw 数和复杂度上升而更差。 |
| 屏幕/层级 Canvas | overlay、HUD、弹窗有独立生命周期和排序 | 所有权、遮罩、输入、加载边界清楚 | 不等于每个 child 都该再拆一层。 |

拆 Canvas 后必须同时检查：GPU frame、overdraw、draw/batch、Render Thread、CPU P95/P99 和触控/导航延迟。只看到 `Canvas.BuildBatch` 变小就宣布通过，会把成本转移到 GPU 或提交开销。

## Layout 与列表

自动布局适合内容规模有限、可读性和作者效率更重要的 UI；它不适合把数百/数千个频繁变化条目全部挂在一条层层嵌套的 layout 链上。需要分别处理“布局算法”和“列表数量”：

1. 先固定或缓存 item 的尺寸、间距和视觉模板，避免每一行反复请求复杂 preferred size。
2. 将多次数据变更合并到一个提交点，避免每 add/remove 就立刻触发完整 layout。
3. 长列表使用 virtualized view：只创建视口加 overscan 所需 item，并给每个复用 item 明确的 bind/unbind、事件退订和异步图片 generation。
4. 可变高度列表需要记录高度测量、锚点保持和滚动位置校正；“不固定高度”不是跳过虚拟化的理由。
5. 列表 item 的 `LayoutElement`、嵌套 group、文本自动换行和图片异步到达会互相触发布局，先用小 fixture 查明连锁范围。

虚拟化的正确性 contract 不只是在滚动时少创建对象：复用后的 item 不得展示上一个数据项的头像、选中状态、点击回调或异步加载结果。它与对象池的 lease/generation 问题相同，见 [[对象池_所有权与容量策略]]。

## 批处理、透明与 GPU

UGUI 的 batch 受材质、纹理/atlas、层级排序、mask/stencil、裁剪、Canvas 边界和渲染状态等影响。不要通过“把所有图片换成同一张 atlas”就假定整个 UI 会合批；使用 Frame Debugger 或 RenderDoc 看当前帧的实际 batch break 和 UI pass。

GPU UI 成本常来自大面积半透明叠层、全屏背景、模糊/后处理、mask 和被遮挡却仍绘制的图形。高分辨率移动设备尤其要区分：

```text
CPU rebuild improved
  but draw count / overdraw increased
  => total frame or battery experience may regress
```

对视觉层采用明确的遮挡、透明度和排序策略。若一个全屏 overlay 只是暂时隐藏，测量它是否仍在参与 raycast、layout 和绘制；若使用复杂 mask，比较它带来的裁剪收益与 stencil/额外 pass 成本，不能凭“层级更干净”判断性能。

## 输入、Raycast 与可访问性

`GraphicRaycaster` 的候选项越多，pointer event 时的筛选工作越多。对永远不接收点击的装饰 Image/Text 关闭 `Raycast Target`；对不可交互的 Canvas/层按产品需求禁用或隔离 raycaster。不要为了性能移除真正需要键盘、手柄、读屏或触控语义的控件。

| 症状 | 检查 | 合理修复 |
| --- | --- | --- |
| 点击/拖动尾延迟 | Raycaster 候选、EventSystem、ScrollRect、重叠 interactive graphic | 降低装饰物 raycast、隔离层、减少无效 hit target。 |
| 输入穿透/遮挡错误 | Canvas 排序、CanvasGroup、raycast target、modal 状态 | 明确 modal owner 和 focus/raycast contract。 |
| 频繁导航重建 | 选中对象、列表复用、enable/disable 生命周期 | 保持稳定 focus，复用时重新绑定导航语义。 |

性能优化不能破坏焦点顺序、手柄导航、触控热区或模态遮挡。把这些纳入 PlayMode smoke，而不是只看 Profiler。

## 诊断顺序

1. 录制可重复 UI workload：打开/关闭、数据刷新频率、列表长度、镜头/分辨率、输入路径。
2. 用 Timeline/Hierarchy 找 CPU 峰值对应的 layout、text、Canvas 或脚本 dirty source；用调用树定位实际发起修改的组件。
3. 用 Frame Debugger/RenderDoc 与 GPU profiler 分析 draw、透明覆盖和 UI pass；不要从 CPU marker 推导 GPU。
4. 对一个假设做最小变体：例如只拆高频 counter、只降低文本刷新、只虚拟化列表，不要一次重写所有 Canvas。
5. 对照基线和候选的 P50/P95/P99、GC、draw/GPU、输入延迟和视觉/可访问性行为，保留 capture。

LAT 的 UIRoot / ScreenStack / Addressables provider 案例已说明 UI 场景与资源所有权，但当前没有 Canvas profiler capture；不能从结构良好推导 `Canvas.BuildBatch` 或 GPU 已达标。相关证据边界见 [[../Project_Experience/LAT_UIRuntimeScene与预热资源案例]]。

## 验证矩阵

| 变体/注入 | 必须固定 | 必须记录 | 成功条件 |
| --- | --- | --- | --- |
| 单 Canvas、按更新域拆、过度拆分 | 层级、文本刷新、分辨率、图集/材质、输入路径 | CPU rebuild/layout、draw、GPU/overdraw、P95/P99 | 总成本和交互体验优于基线。 |
| 静态/10Hz/每帧文本 | 内容、字体、数值分布 | text mesh/GC、layout、视觉准确度 | 只在体验允许的频率降本。 |
| 10/100/1000 item 列表 | item 模板、可变高度、滚动轨迹 | active item 数、bind/unbind、GC、滚动尾延迟 | 无旧数据/回调泄漏，成本受视口大小控制。 |
| modal/overlay 开关 | raycast、focus、CanvasGroup 状态 | input latency、raycast candidates、可访问性 smoke | 模态和导航正确且无无效绘制/扫描。 |
| scene 往返与异步图片 | UIRoot owner、cache 状态、完成顺序 | handle、generation、memory、旧结果丢弃数 | 无资源泄漏和跨 screen 写回。 |

## 最小实验

构建一个静态面板加高频计数器和长列表的场景，分别比较单 Canvas、计数器/列表按更新域拆分、过度拆分三种版本。再对每一变体比较静态、10Hz 和每帧文本刷新。采集 rebuild 时间、batch、GPU overdraw、raycast、GC、P95/P99 以及视觉/输入 smoke；使用 [[Experiments/04_UI_Rebuild与Canvas拆分]] 保存原始证据。

## 关联

- [[Experiments/04_UI_Rebuild与Canvas拆分]]
- [[对象池_所有权与容量策略]]
- [[主线程_API边界与结果回流]]
- [[../Project_Experience/LAT_UIRuntimeScene与预热资源案例]]
- [[Advanced/09_性能证据链与基准设计]]
