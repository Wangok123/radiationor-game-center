---
slug: filesystem-container-limits
title: 文件系统、容器隔离与资源限制
date: 2026-09-30
updated: 2026-09-30
category: 操作系统
reading_time: 4 分钟
tags: 文件系统 | 容器 | 资源限制
summary: 把文件写入、挂载、overlay、句柄和并发写入放回真实 OS 与容器约束中分析。
---

# 文件系统、容器隔离与资源限制

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

容器不是轻量虚拟机：它共享宿主内核，通过 namespace 隔离视图、通过 cgroup 限制/统计 CPU、内存和 IO。文件系统性能还受 page cache、overlay、fsync、文件描述符和挂载语义影响。排查服务“机器很空闲但容器 OOM/被限速”时，必须以容器 cgroup 数据和 limit 为准。

## 常见边界

| 资源 | 容器问题 | 需要观测 |
| --- | --- | --- |
| CPU | quota throttling、CPU steal/争用 | usage、throttled time、run queue。 |
| Memory | cgroup OOM、page cache 与 RSS 混淆 | limit、working set、OOM event、heap/native。 |
| IO | overlay 写放大、fsync 尖峰、共享盘抖动 | latency、queue、bytes、iowait。 |
| FD/进程 | 连接/文件泄漏达到限制 | open FD、ulimit、thread/process count。 |

## 容器限制的真实作用域

namespace 隔离进程/网络/挂载等视图，cgroup 负责资源计量和限制；它们不等同于完整 VM 隔离。容器可见的 CPU 核数、宿主机内存和实际可分配预算可能不同，应用应读取/暴露 cgroup/编排平台的 limit、usage、events 与 throttling，而不是只看宿主机总量。

| 资源 | 常见误解 | 必须定义 |
| --- | --- | --- |
| CPU quota | CPU 未满就不会慢 | quota period/throttling、请求/线程并发、burst 行为。 |
| Memory limit | 宿主机空闲就不会 OOM | cgroup memory、page cache、native heap、OOM kill 重启策略。 |
| IO | 容器共享盘等于本地磁盘 | volume 类型、overlay copy-up、IOPS/latency/flush 合同。 |
| PID/FD | 只有内存会耗尽 | ulimit/PID limit、连接/文件/线程峰值与报警。 |

cgroup OOM 可能杀掉一个进程或整个容器/pod，具体由运行时/编排配置决定；应用内捕获异常不是可靠的最后防线。启动时和运行时都应记录配置 limit，设内存 headroom，遇到压力优先拒绝/降级/释放可再生缓存，而不是等待 kernel kill。

## 文件写入的崩溃一致性

“写文件”涉及应用 buffer、OS page cache、文件系统 journaling、存储设备 flush 和目录 metadata。`write` 返回不必表示断电后数据持久；`rename` 在同一文件系统内通常可作为原子名称切换的一部分，但跨文件系统是 copy+delete 语义，且持久性还依文件/目录同步和目标文件系统保证。

一个常见单文件发布/存档协议：

```text
validate payload -> write temp in target directory
  -> flush according to durability target
  -> fsync temp / close
  -> atomic rename temp -> final (same filesystem)
  -> fsync parent directory if crash durability requires it
  -> retain/rotate previous valid version for recovery
```

## Overlay、volume 与临时目录

容器 writable layer 常有 overlay/联合文件系统语义；首次修改镜像层文件可能 copy-up，批量小写/元数据操作会放大 IO。需要持久化的数据放明确 volume/挂载路径，临时缓存放有容量/清理策略的临时目录；不能依赖容器重建保留 writable layer，也不能假设 volume 会在重启后自动清空。

日志、capture、dump、上传临时文件和缓存各有 owner、命名空间、最大容量、保留期、rotation 和清理失败告警。清理脚本也要避免删除仍被使用/正在写入的文件；按 stable manifest/version/age 识别，而不是宽泛 glob 误删。

## FD、目录与并发写入

每个 socket、文件、pipe、watcher 都消耗 FD；连接泄漏、失败路径未 close、递归打开目录或日志 rotate 都可能达到 limit，随后表现为“随机打开/连接失败”。记录 open FD、FD limit、按类型/owner 计数和失败 errno；把 `EMFILE`/disk-full/permission/read-only 分别处理，不要一律重试。

同一文件多 writer 需要明确协议：单 writer owner、文件锁、append format、原子 temp+rename 或外部 DB/queue。多个容器写共享 volume 时，rename/lock/consistency 的支持取决于网络文件系统，不能按本地 ext4/NTFS 假设。目录扫描也应有深度/条数/时间预算，避免用户上传/缓存爆炸拖垮启动或 GC。

## 文件系统设计

- 写日志/临时文件要有 rotation、容量和清理 owner，不能假设容器重启一定清理 volume。
- 原子发布通常使用临时文件写完、fsync（按持久性需求）、rename；跨文件系统 rename 不一定原子。
- 大量小文件、同步 fsync、递归扫描和 overlay copy-up 都可能成为尾延迟来源。

持久性要求按数据等级选择：可再生缓存可异步/丢失；用户存档/经济账本需写入协议、备份和校验；审计日志需追加、rotation、权限和集中归档。不能因一个文件使用 fsync 就宣称整个业务事务可靠，跨 DB、消息和文件仍需要 outbox/恢复/对账边界。

## 验证矩阵

| 注入 | 通过条件 | 证据 |
| --- | --- | --- |
| 写入中 kill/restart | 启动选择一个完整可校验版本，无静默损坏 | temp/final/bak 状态、recovery log。 |
| disk full / read-only | 快速可解释失败，不无限重试/腐化旧数据 | errno、free bytes、业务降级。 |
| FD exhaustion | 关键路径被保护，泄漏 owner 可定位 | open FD、limit、stack/owner。 |
| CPU quota | throttle 下 P99/queue 符合预算 | cgroup stats、run queue、SLO。 |
| memory pressure/OOM | 预警/降级/重启后状态可恢复 | cgroup events、snapshot、RPO。 |
| slow volume/overlay | IO 有界，日志/缓存不会拖住交易写 | IO latency、fsync、queue/timeout。 |

每次记录 image/version、host/volume 类型、cgroup limit、filesystem/mount、测试脚本和保留产物。容器资源结论不跨云/OS/存储驱动自动成立。

## 验证

在接近真实 limit 下压测：故意超内存、耗尽 FD、慢盘、只读挂载和 pod/container 重启。记录 OOM/kill、throttle、IO P99、数据恢复和报警是否准确。

## 参考资料

- [docs.docker.com/engine/containers/resource_constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [man7.org/linux/man-pages/man7/cgroups.7.html](https://man7.org/linux/man-pages/man7/cgroups.7.html)
