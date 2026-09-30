---
slug: cpu-memory-leak-diagnosis
title: CPU 高占用与内存泄漏排查
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 4 分钟
tags: CPU | 内存泄漏 | 诊断
summary: 从现象分型、采样、追踪和快照入手，建立可以证伪的 CPU 与泄漏调查闭环。
---

# CPU 高占用与内存泄漏排查

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

先确认症状和时间范围，再用采样/追踪数据区分 CPU 真正执行、锁等待、IO 等待、GC、page fault 和忙等循环。内存“增长”要区分托管可达对象、native allocation、文件页缓存、映射和碎片；单次 RSS 快照无法证明泄漏。

## CPU 排查

1. 记录进程/容器限制、核数、负载、频率和线程状态。
2. 用采样 profiler/perf/trace 看热点调用、锁等待、上下文切换、sys/user 时间。
3. 比较 steady state 与突发期，避免把启动/JIT/缓存预热误当长期热点。
4. 修复后看 P99 延迟、CPU、吞吐和错误率，防止只是降低吞吐换来低 CPU。

### 先给 CPU 现象分型

| 现象 | 首先排除/确认 | 常用证据 |
| --- | --- | --- |
| user CPU 高 | 热循环、序列化、加密、算法/GC、忙等 | sampled stacks、flame graph、allocation/GC。 |
| system CPU 高 | syscall、网络/磁盘、page fault、上下文切换 | sys/user split、perf/ETW、IO/fault trace。 |
| CPU 不高但 P99 高 | 锁、队列、IO、线程池 starvation、quota | wait states、queue age、throttle、dependency spans。 |
| 单核满多核闲 | 串行 owner、热点 lock/shard、主线程 | per-thread CPU、run queue、lock/partition distribution。 |
| 容器被 throttled | cgroup quota/period，而非业务计算 | cgroup usage/throttled、host vs container timeline。 |

采样 profiler 的热点是“样本落在何处”，不是自动根因。先将火焰图函数与请求量、实体数、输入分布、版本、GC/IO/锁事件对齐；一个 CPU 函数变高可能只是正确处理更多工作。修复要同时比较单位工作成本、吞吐、错误、队列和 P99。

busy wait、错误重试、轮询过密、日志格式化、低效序列化和锁竞争常把“没有做业务”变成高 CPU。反过来，降低 CPU 的方式若只是限流/丢请求，必须在 SLO/拒绝率中显式说明，不能称性能优化。

## 内存排查

建立随时间增长的序列：RSS/working set、managed heap、native allocations、page cache、GC、handles、线程栈。记录增长与请求、场景、资源加载/卸载的相关性；使用 heap diff、allocation stack、对象引用链和 native memory profiler 定位 owner。

### 泄漏的可证伪定义

固定 workload、资源状态和 warm-up 后，重复相同周期结束时某类 live/owned bytes 持续净增长，且能沿 root/owner 找到不再需要却仍可达/未释放的对象、handle 或 native allocation，才是强泄漏证据。单次 RSS 高、allocator reserved 不下降、GC 尚未回收或 page cache 增长都不是充分证明。

| 类别 | 主要证据 | 常见 owner |
| --- | --- | --- |
| managed live set | heap snapshot diff、GC root path | static/event、cache、closure、task continuation。 |
| native Unity/resource | Memory Profiler/handle ledger | texture/mesh/bundle/NativeArray/Addressables handle。 |
| process handles/FD | handle/FD count、open owner | socket/file/watcher/connection。 |
| thread/stack | thread count、stack dump | blocked worker、unbounded task、leaked loop。 |
| OS/cache/fragmentation | RSS/working set/page faults/allocator stats | mmap/page cache/arena/driver。 |

先做 A/B：关闭一个 feature、限制 cache、禁止某条加载路径或将请求量归零，再看增长斜率变化。之后用 allocation stack/root path 定位 owner，并验证 release/cancel/scene unload/exception 路径。仅靠周期 `GC.Collect` 或重启把曲线压下去会掩盖 owner。

## 采样、追踪与快照的分工

- **sampling profile**：低扰动定位 CPU 热点和线程状态，适合持续/生产近似分析。
- **trace**：关联请求、调度、锁、GC、IO、context switch 和版本，适合尖峰时间线。
- **heap/native snapshot**：回答某时刻谁持有内存，需在相同 workload 多次对比。
- **counters**：长期趋势和告警，不能独立解释对象图/调用栈。

采集本身会有开销。记录 profiler 类型、采样率、Development/Release、Editor/player、symbol、设备/container limit 和是否连接调试器；不要把 Deep Profile/Debug Log 下的数据直接当发布性能结论。

## 调查到修复的闭环

1. 写症状、用户影响、开始时间、版本/部署和 workload 分母。
2. 选一段健康与异常窗口，对齐 CPU、GC、IO、queue、lock、memory/FD 和依赖 trace。
3. 提出可反驳假设，例如“Scene A 退出后 static event 保留 N 个 presenter”。
4. 用最小 A/B 或 failure injection 验证 owner/调用路径，而不是直接大重构。
5. 修复后在同合同下保留 before/after 原始 trace/snapshot，检查吞吐、P95/P99、错误、内存稳定期和回归。

结论格式应为“在版本 X、设备/容器 Y、workload Z 下，指标从 A 到 B；未覆盖哪些平台/长时间行为”，而不是“已修复 CPU/内存”。

## 常见误区

- “CPU 100% 就是死循环”：也可能是合法满载、GC 或系统调用。
- “RSS 不降就是泄漏”：分配器缓存、页缓存和碎片会延迟归还。
- “重启解决了所以找到根因”：重启只证明进程状态被清空。
- “最高 CPU 函数就是根因”：它可能是正确工作，需看单位工作量、等待链和时间线。
- “heap diff 有对象就泄漏”：对象可能是合理 cache/活跃请求；需要生命周期和稳态对照。
- “采样没看到就不存在”：短尖峰/采样率/符号缺失可能遗漏，需要 trace/marker 配合。
- “容器 CPU/内存低于宿主就安全”：cgroup quota/limit 可能先造成 throttling/OOM。

## 验证矩阵

| 场景 | 验收 |
| --- | --- |
| 固定 QPS/实体数 steady state | 单位工作 CPU、P95/P99、queue 无持续增长。 |
| burst/发布/缓存冷启动 | 尖峰可解释，恢复后回到稳态。 |
| 重复 scene/load/unload 或请求周期 | managed/native/handle/FD 期末不单调增长。 |
| 容器 quota/memory limit | throttle/OOM 前有告警和降级，重启后状态可恢复。 |
| 依赖慢/锁竞争 | CPU/线程池不被耗尽，等待/拒绝在预算内。 |

每次保存输入 trace、版本、环境、采集配置、原始 capture/snapshot、假设和失败样本。这样下次 CPU/内存回归才可比较，而不是从一次截图重新猜测。

## 参考资料

- [man7.org/linux/man-pages/man1/perf-top.1.html](https://man7.org/linux/man-pages/man1/perf-top.1.html)
- [learn.microsoft.com/dotnet/core/diagnostics/dotnet-counters](https://learn.microsoft.com/dotnet/core/diagnostics/dotnet-counters)
