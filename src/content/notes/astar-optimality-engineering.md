---
slug: astar-optimality-engineering
title: A*：最优性与工程化
date: 2026-09-30
updated: 2026-09-30
category: 算法
reading_time: 6 分钟
tags: A* | 寻路 | 启发式
summary: 先定义图和代价，再讨论启发式一致性、堆实现、预算、取消和大规模寻路。
---

# A*：最优性与工程化

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

A* 以 `f(n) = g(n) + h(n)` 选择下一扩展节点：`g` 是已知路径代价，`h` 是到终点的估计。在非负边权、可采纳启发式和正确的重新打开节点策略下，A* 能在给定图模型中找到最短路径；一致启发式可简化为节点关闭后不再重开。游戏里的难点通常是图如何构建、动态障碍如何更新、查询预算、路径平滑和多单位拥堵，而不是背公式。

## 正确性条件

| 条件 | 含义 | 后果 |
| --- | --- | --- |
| 可采纳（admissible）启发式 | `h(n)` 不大于真实最短剩余代价 | 保证最优性。 |
| 一致（consistent）启发式 | `h(n) <= cost(n,m) + h(m)` | 可避免反复 reopen，便于实现。 |
| 非负边权 | 移动代价不能为负 | 否则 Dijkstra/A* 的常规结论不成立。 |

网格四方向可用 Manhattan distance；八方向且直线/对角代价分别为 `D`/`D2` 时，可用 octile distance。启发式要和实际移动规则、地形代价尺度一致。

## 先定义图，而不是先写堆

最短路结论只对实际搜索的图成立。开始实现前写下节点、边、边权和终止条件：

| 设计项 | 必须明确的问题 | 常见误建模 |
| --- | --- | --- |
| 节点 | 是格子、navmesh polygon、portal，还是 `(position, stance)` 状态？ | 忽略朝向、体型或能力，得到物理不可走路径。 |
| 边 | 哪些移动合法；是否允许斜走、穿角、跳跃或 link？ | 对角能穿过两个阻挡格的夹角。 |
| 代价 | 距离、时间、危险度、能量是否可相加且非负？ | 用任意负奖励，破坏 Dijkstra/A* 前提。 |
| 目标 | 到精确点、目标集合最近点，还是接近距离内任一点？ | 只检查 target cell，目标被占时无故失败。 |
| 动态性 | 查询开始后的障碍变化如何解释？ | 算出旧世界路径后不做执行期校验。 |

“最优”也要写出目标函数。最短几何距离、最少时间、最少风险、避开敌人和保持队形不是同一个问题。若把多个目标加权成一个边权，权重就是玩法决策，应能解释其量纲和极端行为。

## 为什么可采纳与一致性重要

令 `g(n)` 为已发现的起点到 `n` 的路径代价，`h*(n)` 为真实最短剩余代价。可采纳表示 `0 <= h(n) <= h*(n)`。因此沿最优路径，`f(n) = g(n) + h(n)` 不会高于最优解代价；当目标以最小 `f` 出队时，队列中不可能有一条更优路径尚未被排除。

一致性又称单调性：`h(n) <= c(n,m) + h(m)`。它保证沿任意边 `f(m) >= f(n)`，所以一个节点以最优 `g` 出队并 closed 后不必 reopen。仅可采纳但不一致的启发式仍可最优，但实现必须允许发现更小 `g` 时重新打开节点；“closed 后永不更新”会得到错误答案。

| 启发式 | 适用图 | 下界为何成立 | 失效信号 |
| --- | --- | --- | --- |
| Manhattan `D * (dx + dy)` | 四方向，最小单步代价为 `D` | 每个轴向差至少要被一条合法边消除 | 存在更便宜的 teleport/对角时会高估。 |
| Octile `D * (max - min) + D2 * min` | 八方向，`D <= D2 <= 2D` | 尽量用对角同时消去两轴差 | 对角规则或 terrain multiplier 改变后失配。 |
| Euclidean lower bound | 连续/任意方向移动，成本至少与距离成正比 | 直线距离不超过任一路径长度 | 只允许网格步且缩放不匹配时不够紧。 |

若 terrain cost 最小倍率为 `wMin`，且基础距离已是下界，可将距离启发式乘 `wMin`；更大的倍率可能高估剩余代价。把“平均地形成本”乘进去可能更快，却可能高估并失去最优性；这时应明确改为 bounded-suboptimal 策略，而不是继续声称最短。

## 工程实现要点

- `open set` 使用最小堆/优先队列；不要每次线性扫描全表。
- `closed set` 和 `gScore` 使用稳定节点 id，避免以浮点坐标作 key。
- 优先队列可能保留旧条目；出队时比较当前 `gScore`，跳过 stale entry。
- 路径搜索应有时间/节点预算，超预算返回可解释状态，而不是卡住一帧。
- 将图查询、寻路、移动控制分离；寻路结果不能直接等同于角色可走的最终轨迹。

### 堆、重复项与 tie-break

二叉堆没有 decrease-key 时，简单且正确的做法是插入新条目；出队时检查其 `g` 是否仍等于 `gScore[node]`，不等则跳过 stale entry。不要为了省几个条目而把 heap 更新写成未经测试的索引表。对相同 `f` 的节点可偏向较小 `h` 或较大 `g` 以影响搜索形状，但 tie-break 只能在主排序相等时介入，不能改变 `f` 的语义。

```text
set start.g = 0; push(start, f = h(start))
while open is not empty and budget remains:
  current = pop minimum f
  if current.g != gScore[current.node]: continue  # stale heap entry
  if IsGoal(current.node): reconstruct parents; return Found
  for each legal edge current -> next:
    tentative = current.g + edge.cost
    if tentative < gScore[next]:
      gScore[next] = tentative; parent[next] = current
      push(next, tentative + h(next))
return budget exhausted, cancelled, or unreachable
```

父指针、`gScore`、closed/open 状态必须使用稳定 node id；用浮点 `Vector3` 做 dictionary key 会将坐标误差变成拓扑错误。对一张查询期不可变的图，可以使用 generation-stamp 数组代替每次清空大数组；但 stamp 溢出、并发查询共享数组和取消后的归还都需要明确 owner。

## 预算、取消和结果语义

路径系统不能只返回 `List<Node>` 或 null。调用者必须能区分：

| 结果 | 含义 | 调用者应做什么 |
| --- | --- | --- |
| `Found` | 已在该图快照中找到符合目标条件的路径 | 进入路径跟随，并继续做动态碰撞/局部避让。 |
| `Unreachable` | open set 穷尽，图中无可行路径 | 选择等待、换目标或反馈不可达。 |
| `BudgetExceeded` | 本次允许节点/时间不足，不能推断无路 | 分帧续算、降级为局部路径或提高优先级。 |
| `Cancelled` | 请求/世界版本已失效 | 丢弃所有中间状态；不能显示为无路。 |
| `InvalidInput` | 起终点、图版本或边权违反合同 | 记录调用错误，不进入重试风暴。 |

节点预算比“超过 X 毫秒就退出”更可复现；真实系统常两者并用。对于多单位，排队、优先级和每帧总 budget 比单次查询微优化重要。将远距离路线拆为层级/区域路径，再按局部图细化，避免每个单位每次都扫描全地图。

## 游戏规模化

小静态地图可直接网格 A*。大地图常用分层图、区域门户、navmesh、多级路径；动态障碍用局部避让、增量更新或短期重新规划。上百单位同时寻路时，需要队列、优先级、批处理和缓存，而不是同帧全算。

局部避让不是 A* 的替代品：A* 解决全局拓扑可达，避让解决短时间的其他 agent 冲突。缓存也必须带图版本、能力 profile 和起终点/区域 key；没有失效协议的路径缓存会在障碍或门状态变化后稳定地产生错误路径。路径平滑、string pulling 或 waypoint 压缩后仍需通过同一碰撞/导航约束验证，不能把视觉后处理当作合法性证明。

## 验证清单

1. 用 Dijkstra 作为小地图 ground truth，对随机起终点验证路径代价。
2. 统计访问节点数、平均/最大查询时间、失败原因、重规划次数。
3. 覆盖无路、目标被占据、动态封路、不同地形权重、相等 `f` 的 tie-break。
4. 在目标设备和真实单位数量下测量，而不是只跑单个 query。

补充以下测试，才能验证实现而非算法名称：

| 测试 | oracle / 不变量 | 典型 bug |
| --- | --- | --- |
| 随机小图 | A* `Found` 成本等于 Dijkstra 成本 | 启发式高估、closed 不 reopen。 |
| 所有边合法 | 每相邻 waypoint 都存在对应合法边 | 穿墙、穿角、平滑越界。 |
| 无路与 budget | 两个结果明确区分且不会互换 | 超预算被当成不可达。 |
| 相同输入重复 | 路径成本和状态稳定；tie-break 可预期 | heap stale、浮点 key、未清空状态。 |
| 图版本变化 | 旧查询被取消或标记 stale | 旧路径写回新地图。 |
| 规模矩阵 | 访问节点、队列峰值、P95/P99、GC | 仅看单 query 平均数。 |

若路径成本允许浮点，oracle 比较要使用定义过的容差，并同时检查路径合法性；不能只因两个浮点数“接近”就接受一条走穿障碍的路径。

## 参考资料

- [theory.stanford.edu/~amitp/GameProgramming](https://theory.stanford.edu/~amitp/GameProgramming/)
- [www.redblobgames.com/pathfinding/a-star/introduction.html](https://www.redblobgames.com/pathfinding/a-star/introduction.html)
