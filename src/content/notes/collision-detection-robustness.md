---
slug: collision-detection-robustness
title: 碰撞检测：空间划分与鲁棒性
date: 2026-09-30
updated: 2026-09-30
category: 算法
reading_time: 4 分钟
tags: 碰撞检测 | 空间划分 | 鲁棒性
summary: 从 broad phase 候选对、narrow phase 和连续检测梳理游戏碰撞系统的正确性边界。
---

# 碰撞检测：空间划分与鲁棒性

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

碰撞系统通常分 broad phase 和 narrow phase：先用包围盒、网格、BVH、四叉树等快速排除不可能相交的对，再用几何算法精确测试和求接触信息。性能不只由算法复杂度决定，还受动态对象更新、候选对数量、缓存局部性和最坏帧影响。

## 游戏工程边界

- AABB/球体适合 broad phase，便宜但 false positive 多。
- 空间网格适合均匀分布与动态对象，场景密度极不均匀时会有热点。
- BVH/树结构适合静态或层次化场景，动态更新和重建成本需计入。
- narrow phase 要定义接触法线、穿透深度、连续碰撞/隧穿和浮点 epsilon。

## Broad Phase 的候选对合同

Broad phase 不判断真实碰撞，只保证所有可能碰撞对不被漏掉，同时尽量减少 false positive。候选对数量、更新成本、内存、最坏热点和稳定顺序都属于接口：

| 结构 | 适合 | 更新或热点风险 |
| --- | --- | --- |
| uniform grid/spatial hash | 动态对象、尺度接近、分布较均匀 | 大对象跨多 cell；密集 cell 候选对爆炸。 |
| sweep and prune | 运动连续、轴投影排序稳定 | 大跳或大量交叉导致排序和候选退化。 |
| BVH/AABB tree | 静态/分层场景、射线或区域查询 | 动态 refit/rebuild、树质量随移动恶化。 |
| quadtree/octree | 空间层级显著、查询区域多样 | 边界对象、多层复制和不均匀热点。 |

每个动态对象插入的 proxy、更新时机、脱离世界如何删除、跨 cell 如何去重必须定义。以 `(minId,maxId)` 形成 canonical pair key，避免同一对在多个 cell 被多次 narrow phase；大对象/静态场景可能需单独索引，否则一个 boss 或墙体会复制成大量候选。

候选数不是唯一指标：平均稀疏场景表现良好，不代表角色聚集、弹幕爆发或世界边界不会退化。记录每 tick candidate pairs、unique pairs、cell occupancy、insert/update/query 时间和最大对象尺寸，而不是只报平均碰撞耗时。

## Narrow Phase 与规则层

Narrow phase 需返回的不止 bool：是否相交、接触点/法线、穿透深度、time of impact、feature id 和稳定排序。碰撞检测与游戏命中判定也不同：攻击 hitbox 对同一 hurtbox 每次 swing 命中几次、无敌帧/阵营/层级/触发时机如何处理，是规则层合同，不能由几何 overlap 自动决定。

| 问题 | 最低定义 |
| --- | --- |
| AABB/圆/胶囊 | 坐标空间、边界接触算不算 hit、尺寸单位。 |
| 多边形/凸体 | winding/法线、退化边、SAT/GJK/EPA 的失败/容差。 |
| 3D mesh | broad proxy、triangle query、backface、缩放约束。 |
| hit detection | tick、攻击实例 id、目标 id、去重和无敌规则。 |

若后续 solver 使用 normal/penetration，方向、深度正负、重叠初始态和多接触排序必须稳定；否则同一几何结果在不同帧/平台导致反弹、卡墙或网络重演差异。

## 离散检测与连续碰撞

离散检测只测试 tick/frame 位置。高速小物体在两帧间穿过薄墙称 tunneling；解决不是盲目提高全局 tick rate。可按风险选择 swept AABB/sphere/capsule、raycast、time-of-impact/CCD、子步进、速度/尺寸限制或玩法命中宽容。连续检测要定义起始重叠、零速度、多个候选碰撞的最早时间和剩余时间处理，且会增加 query/solver 成本。

```text
previous pose -> sweep proxy -> earliest valid hit
  -> move to time of impact -> resolve/slide -> consume remaining time with bounded iterations
```

任何 CCD 都需要最大 iteration/最小推进 epsilon，防止贴面反复命中形成无限循环。将“未收敛/超预算”作为可观测结果，不要悄悄返回不碰撞。

## 鲁棒性

明确坐标系、单位、容差和退化几何（共线、零半径、平行、极大坐标）。不要用任意 `== 0` 判断几何关系；epsilon 必须与场景尺度相关。碰撞结果还要经过时间步和 solver 策略，几何“相交”不等于最终角色应如何响应。

epsilon 不能是全项目神秘常量。相交判定、接触偏移、CCD 最小时间推进、solver skin width 应按世界单位、速度、tick 和浮点精度分别定义；过大产生幽灵碰撞/无法贴近，过小造成抖动/数值噪声。坐标极大时浮点有效精度下降，开放世界需考虑 origin shift/局部坐标或 double 做高层定位。

随机浮点 fuzz 只检查“不崩溃”不够。需要生成退化/近边界图形，并用高精度/慢速 oracle、对称性（A vs B 与 B vs A）、平移/旋转不变性和输出有限性验证。gizmo/replay 保存失败输入、seed、坐标、速度和算法版本，才能复现一帧问题。

## 验证

随机/基于属性的测试覆盖边界、极端尺度、快速移动和重叠初始状态；记录候选对数、narrow phase 时间、穿透深度和漏检/误报。用可视化 gizmo 保存失败样本。

| 测试 | 不变量 |
| --- | --- |
| proxy vs exact | exact hit 必须在 broad 候选中；重复 pair 不多次处理。 |
| 对称/边界 | A/B 交换结果一致；切线/零尺寸按合同处理。 |
| 高速 sweep | 薄墙/小目标不穿透，iteration 有上限。 |
| 密集热点 | candidate/occupancy/CPU 在预算内或降级可相关资源与写入权限仍需由明确的生命周期协议管理。 |
| 生命周期 | spawn/despawn/disable 后 proxy 不残留，ID 不错配。 |
| 规则层 | 同 tick/攻击实例的 hit 去重、无敌/层级正确。 |

目标平台 benchmark 同时记录实体分布、速度、碰撞层矩阵、broad update、pair generation、narrow、solver 和 GC/native allocation。不要只优化几何函数而漏掉 proxy 创建/销毁和规则去重成本。

## 参考资料

- [realtimecollisiondetection.net](https://realtimecollisiondetection.net/)
- [developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation)
