---
slug: virtual-memory-page-cache
title: 虚拟内存、页缓存与性能诊断
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 4 分钟
tags: 虚拟内存 | 页缓存 | 性能
summary: 区分 RSS、commit、allocator 保留量和 page fault，建立从内存压力到性能问题的诊断顺序。
---

# 虚拟内存、页缓存与性能诊断

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

进程看到的是虚拟地址空间；页表把虚拟页映射到物理页或文件页。访问尚未驻留的页会发生 page fault，缺页处理可能从磁盘加载、分配物理页或触发回收。内存问题不能只看进程“占用多少 MB”：还要看 working set、commit、匿名页、文件页缓存、page fault、swap 和内存压力。

## 关键概念

| 概念 | 含义 | 诊断意义 |
| --- | --- | --- |
| virtual address space | 可寻址范围 | 大不等于实际占用 RAM。 |
| committed memory | 操作系统承诺可提供后备存储的内存 | 接近 commit limit 有 OOM 风险。 |
| working set / RSS | 当前驻留物理内存 | 反映实际热页规模。 |
| page cache | OS 缓存文件内容 | 读文件快不一定是应用自身缓存有效。 |
| major fault | 常需外部 IO 才能满足 | 容易造成卡顿/延迟尖峰。 |

### 不要混用 RSS、commit 与 allocator 保留量

- **Virtual size** 是进程映射/预留的地址范围，不代表这些页都占物理内存。
- **RSS/working set** 是当前驻留页，但文件映射页可能可回收，且共享页统计口径会重复或按平台不同处理。
- **Commit/commit charge** 反映系统承诺的后备资源，不等于当前 resident。
- **Managed heap reserved** 是运行时为未来分配保留的区域，和其中 live object bytes 不同。
- **Unity/native/GPU allocation** 由不同 allocator/驱动持有，系统进程指标未必能准确归属到具体 Unity owner。

因此“任务管理器内存涨了”只是症状。必须明确是哪个 counter、哪个进程/设备、单位、时间窗口和是否包含 GPU shared memory，再按 owner 类型用 Memory Profiler、系统 trace、平台工具或资源台账分类。

## Page fault 的语义与陷阱

Page fault 是地址映射缺失或权限/写时复制条件触发的处理事件，不必然意味着磁盘读取。minor fault 可通过已有内存页或映射关系解决；major fault 通常需要等待存储 I/O，但具体计数/命名依 OS 工具。首次触碰大块内存、copy-on-write、内存映射文件和 swap-in 都会有不同成本。

同一资源第二次加载更快，可能来自 OS page cache，而非 Unity 自己的缓存；冷启动、热启动必须分开测。清 page cache 的测试操作会影响整台机器且可能需要权限，不要在共享/生产机器上为了“公平”随意执行；更安全的方式是记录冷热状态、交错比较并重复。

## 内存压力的因果链

```text
managed/native/GPU allocation growth
  -> resident/commit pressure
  -> reclaim, cache eviction, paging or allocator failure
  -> page faults / IO wait / CPU contention
  -> long frames, latency tails, OOM or process kill
```

这条链不是必然一对一：文件页缓存增长可能是可回收的；RSS 稳定也可能伴随 GPU OOM；Unity `Reserved` 增长但 `Used` 稳定可能是 allocator 保留策略。需要将时间线上的内存事件与症状对齐，不能把相关性直接当泄漏根因。

## Unity 资源类别与采样

| 类别 | 常见 owner/工具入口 | 应观察 |
| --- | --- | --- |
| Managed objects | Unity Memory Profiler、GC.Alloc/heap stats | live count、root path、managed heap used/reserved。 |
| Native Unity object | Memory Profiler、Unity object counts | object type、native bytes、duplicate/hidden object。 |
| AssetBundle/Addressables | handle owner、Addressables diagnostics | acquired/released、依赖引用、bundle residency。 |
| Texture/Mesh/Audio | importer、Memory Profiler、platform GPU tools | runtime size、mip/format、CPU/GPU copy。 |
| OS file/page cache | OS counters/ETW/perf trace | page faults、IO、working set、cache pressure。 |
| GPU/driver | 平台 GPU profiler/driver counters | resident budget、heap/eviction、提交失败。 |

Memory Profiler snapshot 是某时刻的图，不自动给出泄漏结论。比较同一流程多次稳定循环后的 snapshot，关注对象数量/大小是否单调增长、root path owner 是否合理、场景卸载后哪些依赖仍持有。GPU/native 的可见性依平台工具而异，需要说明盲区。

## 与 Unity/服务端的关系

- 大量资源加载、纹理/mesh 解压、AssetBundle 缓存会同时影响 native 内存、GPU 内存和 OS working set。
- 服务端容器内存限制与宿主机空闲内存不同；必须以 cgroup/容器限制和 OOM kill 事件为准。
- GC 高峰、native 泄漏、page cache 增长和 GPU 驱动分配是不同问题，需要不同工具。

## 诊断顺序

1. 明确症状：OOM、长帧、RSS 增长、swap、磁盘读取尖峰还是启动缓慢。
2. 观察系统级内存压力与 page fault，再看进程级 working set/commit。
3. 分类：托管堆、native、mapped file、页缓存、GPU/driver、线程栈。
4. 用时间序列找增长和场景的对应关系，避免只对单个快照下结论。
5. 修复前先建立峰值和长期稳定性两组预算。

### 容器与平台边界

Linux 容器中宿主机仍有空闲内存，不代表容器不会因 cgroup limit 被 OOM kill；应同时看 process RSS、cgroup memory.current/limit/events、swap 与 reclaim。Windows、Android、iOS、主机 console 的内存压力模型和可用 counter 不同，不能把 Linux `/proc` 指标原样搬到 Unity 目标设备。记录进程架构（32/64 位）、系统版本和 GPU memory budget。

### 排查步骤的证据要求

1. 明确是 OOM kill、Unity allocation failure、帧尖峰、swap/page fault 还是加载慢；确定首次发生时间。
2. 采集系统级和 Unity 级同一时间轴数据，并标注 capture 对运行的扰动。
3. 用场景/资源事件把增长分段：启动、预热、玩法峰值、返回菜单、重复进入退出。
4. 做重复循环或 A/B 关闭单一子系统，观察增长斜率和回落，而不是只比启动/退出两个点。
5. 设定峰值与稳态上限、失效保护和设备矩阵；内存优化后复测帧时间、加载和画质回退。

可将疑似泄漏定义为：固定 workload 与资源状态下，经过 warm-up 后相同周期结束的 live/owned bytes 持续增长，且增长能沿 owner/root path 指向未释放对象/handle。单次快照的高值或 OS 未归还页都不满足这个定义。

## 参考资料

- [docs.kernel.org/mm/overcommit-accounting.html](https://docs.kernel.org/mm/overcommit-accounting.html)
- [learn.microsoft.com/en-us/windows/win32/memory/virtual-address-space](https://learn.microsoft.com/en-us/windows/win32/memory/virtual-address-space)
- [learn.microsoft.com/en-us/windows/win32/memory/virtual-memory-functions](https://learn.microsoft.com/en-us/windows/win32/memory/virtual-memory-functions)
