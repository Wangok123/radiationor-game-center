---
slug: graph-search-shortest-path
title: 图搜索、最短路与并查集
date: 2026-09-30
updated: 2026-09-30
category: 算法
reading_time: 4 分钟
tags: 图搜索 | 最短路 | 并查集
summary: 根据权重、连通性和路径恢复需求选择图算法，并为结果补齐可验证的不变量。
---

# 图搜索、最短路与并查集

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 选择表

| 问题约束 | 常见算法 | 关键前提 |
| --- | --- | --- |
| 无权最短步数 | BFS | 边权相同。 |
| 非负权单源最短路 | Dijkstra | 不接受负边。 |
| 有负边且需检测负环 | Bellman-Ford | 成本较高。 |
| DAG 上路径/依赖 | 拓扑序 DP | 图必须无环或先处理环。 |
| 动态连通性合并 | Union-Find | 不擅长删除边/路径本身。 |

## Dijkstra 关键点

优先队列中的旧条目不必强制删除；出队时比较当前距离，跳过 stale entry。距离类型需防溢出，图的边权和方向要与业务模型一致。若启发式满足条件，A* 可看作有方向性的 Dijkstra。

Dijkstra 的不变量是：当当前未定节点以最小暂定距离 `dist[u]` 出队后，在所有边权非负前提下，`dist[u]` 已是最短距离。负边会破坏这个贪心证明，因为稍后可能通过负代价路径降低一个已“确定”节点。

```text
dist[start] = 0; push(start, 0)
while heap not empty:
  (d,u) = pop_min()
  if d != dist[u]: continue   # stale entry
  for (u,v,w) in outgoing(u):
    require w >= 0
    if d + w < dist[v]:
      dist[v] = d + w; parent[v] = u; push(v, dist[v])
```

有向/无向、稀疏/稠密、单源/多源会改变选择：非负稀疏图用 heap Dijkstra 常见；稠密图的数组扫描可能更简单；全源小图可用 Floyd-Warshall；所有边权相同用 BFS；0/1 权可用 deque 0-1 BFS。若只问可达，BFS/DFS/DSU 可能比最短路更合适。

距离和 parent 需要表达“不可达”与合法最大值。用 `long`/checked arithmetic 或先检查 `d > INF - w`，避免溢出变负后被误当最优。并列最短路的 parent 不唯一，测试应比较成本/合法性，除非业务合同要求稳定 tie-break。

## 算法选择的决策树

```text
只问可达/连通? ---- yes -> DFS/BFS/DSU（取决于是否在线动态合并）
        |
        no
        v
要最短路? -- 所有权重相同 -> BFS
        |-- 权重为 0/1 -> 0-1 BFS
        |-- 非负权 -> Dijkstra / A*
        |-- 有负权 -> Bellman-Ford / DAG DP / Johnson 等
        |-- DAG -> 拓扑 DP 可求路径型目标
```

“负边”本身不必然让问题无解：若图是 DAG，可在拓扑序中用线性时间求最短路，即使有负边；若存在可达负环且可无限绕行，最短路可能没有有限解。选择要基于图结构、权重性质和查询目标，而不只是算法名字。

## 并查集

parent 表示连通分量代表；路径压缩和按 size/rank 合并使均摊操作接近常数。它只回答“是否连通/合并后多大”等问题，不保存最短路径，也不能高效撤销任意删除；需要离线回滚时用 rollback DSU 或其他结构。

普通 DSU 的状态不变量是 parent forest：每个节点沿 parent 最终到达一个根，根代表连通分量；union 只把一个根挂到另一个根。路径压缩加按 rank/size 合并，操作摊还复杂度为 `O(α(n))`，不是每次严格常数。`rank` 在路径压缩后不再等于当前树高，只是合并策略使用的上界等级。

```csharp
int Find(int x)
{
    if (parent[x] != x)
        parent[x] = Find(parent[x]);
    return parent[x];
}

bool Union(int a, int b)
{
    a = Find(a); b = Find(b);
    if (a == b) return false;
    if (size[a] < size[b]) (a, b) = (b, a);
    parent[b] = a;
    size[a] += size[b];
    return true;
}
```

若查询“连通分量数量”，初始为 `n`，只有 union 真正合并两个根时减一。若要在线删除边，普通 DSU 不支持拆分；简单把 parent 还原会因路径压缩丢失历史。离线可把边活跃区间放在线段树上并用 rollback DSU，但 rollback 通常禁用路径压缩、记录每次变更以便回滚。

## 图的表示和输入防护

| 表示 | 空间 | 适合 | 风险 |
| --- | --- | --- | --- |
| adjacency list | `O(V+E)` | 稀疏图遍历/最短路 | 大量对象节点可能有分配和缓存成本。 |
| adjacency matrix | `O(V²)` | 稠密小图、快速判边 | 稀疏大图浪费内存。 |
| CSR/紧凑数组 | `O(V+E)` 连续存储 | 大静态图、缓存友好批处理 | 构造/动态更新复杂。 |
| implicit neighbors | 不显式存边 | 网格、规则状态图 | neighbor 生成也需正确处理边界/障碍。 |

解析外部图时限制节点/边数，校验端点范围、重复边、权重范围和整数乘加溢出。恶意输入可用极大稠密图耗尽内存或 CPU；图算法的复杂度预算也是输入验证的一部分。

## 游戏映射

地图区域合并、房间匹配分组、岛屿/连通地形检测适合 DSU；导航路径使用图搜索。不要把 DSU 当寻路算法。

游戏图还需绑定领域版本：门/传送点/破坏地形变化后，旧路径对应的 edge set 可能失效；缓存 key 应包含 topology/version 或明确做局部失效。实时地图查询中也应区分“图快照上的最短路”与“实际 agent 可走路线”，路径跟随还需碰撞、动力学和动态避让验证。

## 验证

随机生成小图，用 Floyd-Warshall/暴力搜索作为 oracle；对 DSU 维护一个朴素集合模型，随机 add/query 比较。覆盖断图、重复边、自环、负权和大权重。

| 测试 | 参考结果/不变量 | 常见错误 |
| --- | --- | --- |
| Dijkstra vs Floyd-Warshall | 每对可达距离相同 | stale entry、方向反了。 |
| BFS vs 单位权 Dijkstra | 距离/可达集相同 | BFS 误用于不同权重。 |
| 负边 DAG vs 暴力拓扑枚举 | 距离相同 | 错误地直接套 Dijkstra。 |
| DSU vs 朴素集合 | 连通关系和 component count 一致 | 重复 union 多减计数。 |
| 小随机图 | parent 路径边均存在，成本等于距离 | 重建回路、无路状态误判。 |
| 极大权/端点错误 | 明确报错或安全拒绝 | 溢出、数组越界、OOM。 |

固定随机 seed 并输出最小反例。最短路比较不能只比 distance 数组；还要验证 parent 重建出的路径从 start 到 goal 连通、每条边合法且总权重吻合。

## 参考资料

- [cp-algorithms.com/graph/dijkstra.html](https://cp-algorithms.com/graph/dijkstra.html)
- [cp-algorithms.com/data_structures/disjoint_set_union.html](https://cp-algorithms.com/data_structures/disjoint_set_union.html)
