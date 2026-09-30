---
slug: async-cancellation-lifecycle
title: async/await、取消与 Unity 生命周期
date: 2026-09-30
updated: 2026-09-30
category: C# 异步
reading_time: 5 分钟
tags: async | 取消 | 生命周期 | Unity
summary: 为异步任务补上 owner、generation、取消、迟到结果和资源释放协议。
---

# async/await、取消与 Unity 生命周期

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

`async/await` 是异步控制流，不等于新线程。Unity 中真正的难点是生命周期：异步操作完成时，其发起对象、Scene 或服务可能已失效。每个异步入口应有取消/失效策略、异常观察策略和结果所有者；不能仅靠 `if (this == null)` 补救。

## 先区分四件事

| 概念 | 解决的问题 | 不保证什么 |
| --- | --- | --- |
| `async/await` | 不阻塞调用方地等待结果 | 不保证在线程池执行。 |
| `Task.Run` | 将纯 CPU 工作放到线程池 | 不允许在线程池访问 Unity API。 |
| Coroutine | 帧间协作式流程 | 不是后台线程，也不自动传播异常/取消语义。 |
| `CancellationToken` | 协作式请求取消 | 不会强制停止不检查 token 的工作。 |

## 推荐结构

```text
Scene / feature owner
  -> 创建一个 operation scope（owner + generation + linked token + resource ledger）
  -> 启动可取消的 IO 或纯计算
  -> await 后验证 scope 仍为 current owner/generation
  -> 在 replace request / disable / scene unload 时使 scope 失效
  -> 在唯一出口分类取消、故障、成功，并观察异常/释放资源
```

“创建 token”不是完整结构。一个实际异步操作至少有四个 owner：谁拥有请求意图、谁拥有底层 operation、谁拥有成功结果/资源、谁拥有 UI 或世界状态的写入权。它们可以相同，也可以不同；不写清楚就容易出现面板关闭后还有下载、下载完成后没有 release、或老结果覆盖新界面。

| 对象 | 何时创建 | 何时失效/释放 | 常见错误 |
| --- | --- | --- | --- |
| request generation | 每次新意图，如搜索词/选中角色变化 | 新请求替代旧请求时递增 | 只有 token，没有“最后一次胜出”规则。 |
| `CancellationTokenSource` | feature/scene 或单次请求作用域 | owner 结束后 `Cancel`，不再使用后 `Dispose` | 复用已经取消的 source；忘记 Dispose linked source。 |
| 底层 task/operation | IO、SDK、Addressables、CPU compute | API 的完成/失败/显式 release 规则 | 以为 token 自动终止不支持取消的底层工作。 |
| result/resource | task 成功后取得的 payload、handle、buffer | 由唯一 consumer 或 scope ledger 释放 | 过期完成仍写 cache，或丢弃结果却泄漏 handle。 |
| UI/world write | 主线程 phase 中提交 | owner/generation 已验证时 | 在 continuation 中直接写已销毁的 view。 |

## 取消、超时、失效和释放不是同一件事

| 动作 | 意图 | 是否保证底层工作停止 | 后续必须做什么 |
| --- | --- | --- | --- |
| `Cancel()` | 请求协作方尽快停止 | 否；依赖 API 是否观察 token | 等待/观察最终完成，清理已取得的资源。 |
| timeout | 不再愿意为结果等待 | 否；常常只是使调用方离开等待 | 标记 generation 过期；处理迟到完成。 |
| owner invalidation | 场景、面板或 feature 已不允许写回 | 否 | 拒绝写回，交给 operation owner 释放结果。 |
| `Dispose()` / `Release()` | 释放 token source、buffer、handle 等资源 | 与取消无必然关系 | 确认没有仍在使用该资源的 operation。 |

对于不支持取消的第三方 SDK，正确做法通常是“逻辑取消”：让旧 scope 失效，保留单一 completion observer，在完成后按 `owner + generation` 决定消费或释放。直接丢掉 `Task` 会把异常、资源和诊断上下文一并丢掉。

## 版本化的最后一次胜出

搜索、头像加载、Addressables 预热、服务器选区等 UI 场景常有重叠请求。即使旧请求的 token 已 cancel，它仍可能恰好在取消前完成；因此写回条件应同时检查 owner 活性和 generation：

```text
start request A -> generation 41
start request B -> generation 42; request A becomes obsolete
A completes late -> observe/release result, but do not apply
B completes      -> apply only if owner is active and generation is still 42
```

generation 应属于拥有展示/状态的 coordinator，不应由后台 task 自己决定。若多个 consumer 共享同一个加载 operation，cache owner 还要分别记录等待者是否离开，不能让先关闭的 UI 直接取消或 release 仍被其他 UI 使用的共享 handle。

## 主线程回流和结构化并发

`await` 的续体运行位置取决于调用环境与 awaitable；不要仅凭“从 MonoBehaviour 调用”就假设一定已回主线程。把 Unity API 写入集中在一个明确的主线程 apply phase，并用测试验证实际使用的 Task/UniTask/SDK continuation 语义。后台工作只处理从 Unity 对象复制出的纯数据。

业务入口尽量返回 `Task` 或项目统一的 awaitable，使上层能等待、组合、取消和观察异常。`async void` 只用于必须满足事件签名的薄入口；入口应立即委托给可观察任务，并将异常送到统一的日志/错误呈现路径。fire-and-forget 不是“不处理结果”，而是由一个长期 owner 显式登记的 supervised operation。

```text
UI click (async void adapter)
  -> coordinator.StartAsync(scope)          // Task: outcome is observed
      -> background parse / network request // pure data only
      -> main-thread ApplyIfCurrent(...)    // owner + generation checked
      -> finally ReleaseOwnedResources(...) // exactly once
```

不要在 `Update` 中无节制启动 task。对周期性工作选择一个明确的并发策略：丢弃正在进行期间的新 tick、合并最新输入、固定容量队列、single-flight 共用同一 operation，或按 feature 预算限流。每一种策略都要定义过载时用户看到什么和指标如何报警。

## 异常分类和结果状态

取消不是成功，也不是普通故障。调用链应让上层可以区分以下状态，而不是靠捕获所有 `Exception` 后写一行日志：

| 结果 | 示例 | UI/领域行为 | 诊断字段 |
| --- | --- | --- | --- |
| Succeeded | 仍是 current scope 的有效 payload | apply，并转移资源所有权 | request id、generation、耗时、缓存状态。 |
| Cancelled | owner 主动取消且 API 协作退出 | 通常无错误弹窗 | cancel reason、阶段、是否仍有底层清理。 |
| Obsolete | 旧请求完成或超时后才返回 | 不 apply；释放/归还结果 | started/current generation、完成延迟。 |
| Recoverable failure | DNS、短暂网络、可重试服务错误 | 有预算的重试或明确的重试 UI | error category、retry count、endpoint。 |
| Terminal failure | 权限、版本、协议/数据不兼容 | 结束 flow 或要求用户动作 | server code、content/build version。 |
| Programmer failure | null owner、线程违规、双重 release | 尽早暴露并修复 | stack、scope ledger、调用路径。 |

`finally` 应负责对本 scope 已取得、且尚未移交的资源做一次性清理；它不应悄悄吞掉原始异常。对于多个并行子任务，明确是 fail-fast 后取消兄弟任务，还是收集全部结果；不定义会导致部分成功的资源和错误状态无人接管。

## Unity 生命周期边界

- `UnityEngine.Object` 和绝大多数 Unity API 只能在主线程访问；后台工作只处理复制出的纯数据。
- `OnDisable` 不是“所有对象永远不再使用”的同义词。对象可能稍后 re-enable；区分 component enable scope、scene scope 和 application scope。
- Scene 卸载时，持有对象的 service、事件订阅、Addressables handle 与任务结果都要有明确 owner。不要让静态单例默默接管 scene scoped task。
- Domain Reload 被关闭时，静态 token source、队列和事件订阅可能跨 play session 残留；必须单独测试初始化/清理。
- Job/NativeContainer 的生命周期由 `JobHandle` 依赖管理，不应把 `CancellationToken` 当作释放仍在被 job 读取的内存的许可。

## 可测试的状态机

```text
Created -> Running -> {Succeeded | Failed | CancelRequested | Obsolete}
CancelRequested -> {Cancelled | CompletedLate}
CompletedLate -> {Released | RecordedFailure}
Succeeded -> {Applied | Obsolete} -> Released/OwnershipTransferred
Failed -> RecordedFailure -> Released
```

终态的关键不变式是：每个完成都被观察；每个 acquired resource 恰好由一个 owner release 或接管；过期结果不能写回；同一 scope 的 release 不会影响另一 scope 的共享资源。把这些写成测试，比测试“没有报错”可靠得多。

## 参考资料

- [learn.microsoft.com/dotnet/csharp/asynchronous-programming](https://learn.microsoft.com/dotnet/csharp/asynchronous-programming/)
- [learn.microsoft.com/dotnet/standard/threading/cancellation-in-managed-threads](https://learn.microsoft.com/dotnet/standard/threading/cancellation-in-managed-threads)
- [learn.microsoft.com/dotnet/api/system.threading.cancellationtokensource](https://learn.microsoft.com/dotnet/api/system.threading.cancellationtokensource)
