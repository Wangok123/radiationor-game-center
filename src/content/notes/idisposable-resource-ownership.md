---
slug: idisposable-resource-ownership
title: IDisposable、终结器与资源所有权
date: 2026-09-30
updated: 2026-09-30
category: C# 语言
reading_time: 4 分钟
tags: IDisposable | 资源管理 | 所有权 | Unity
summary: 用单一 owner、借用与转移规则解释 Dispose、终结器和 Unity 原生资源的边界。
---

# IDisposable、终结器与资源所有权

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

`IDisposable` 表达调用方可以确定性结束资源使用；GC 只负责托管对象生命周期，不保证文件、socket、native allocation 或 Unity 原生资源及时释放。终结器是最后兜底，不应作为正常释放路径。资源应有单一 owner、明确 transfer/borrow 规则和幂等 `Dispose`，并在异常、取消、Scene unload 下仍能执行。

## ownership 设计

```text
Create -> owner holds resource -> consumer borrows/use
      -> owner Dispose exactly once -> no future use
```

`using`/`try-finally` 适合局部所有权；跨帧/异步资源需要 feature owner 或 service 管理。若把 `NativeArray` 交给 job，应让 `Dispose(JobHandle)` 依赖最后一个读写 job，而不是主线程提前释放。

## 资源图：拥有、借用、转移

不要只在类型上写 `IDisposable`，要描述一条资源图的边：

| 关系 | 含义 | 约束 |
| --- | --- | --- |
| owner | 决定资源何时停止使用并负责一次释放 | 生命周期必须覆盖所有 borrower。 |
| borrower | 临时使用，不取得释放权 | 不缓存超过约定范围、不调用 `Dispose`。 |
| transfer | 原 owner 放弃责任，新 owner 接管 | 转移后旧 owner 不再读/释放；操作应可观察。 |
| shared owner | 多方共同使用 | 需引用计数/集中 registry 或更清晰的单一 owner，不能靠约定口头数人头。 |

多数 bug 是 owner 不明，而非 `Dispose` 少写一次。API 名称可表达约定：`Create/Open/Acquire` 暗示产生 owner；`Get/Read/With` 通常借用；`Take/Detach/Transfer` 表示责任改变。若 API 返回一个 handle，文档要说调用者是否必须释放、失败时 handle 是否有效、重复释放是否安全。

## Dispose 的正确性合同

一个可预测的 `Dispose` 应满足：

1. 第一次调用将对象变为 terminal，释放所有 owned resource。
2. 后续调用幂等，或明确抛出 disposed exception；不能双重释放底层句柄。
3. dispose 后任何公开操作行为确定（抛 `ObjectDisposedException`、返回不可用状态等）。
4. 若释放链包含多个资源，一个失败不应跳过其余清理；需要 try/finally 或聚合异常策略。
5. 释放顺序按依赖逆序：先结束 consumer/job，再释放它依赖的 buffer/handle。

```csharp
public sealed class Session : IDisposable
{
    private bool _disposed;
    private readonly Stream _stream;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stream.Dispose(); // only if Session owns the stream
    }
}
```

如果构造函数接收一个 `Stream`，要么显式接管所有权，要么只借用；不能让用户猜 `Session.Dispose()` 是否关闭传入流。可以用参数名/工厂/文档表达，也可以拆成 owning 与 non-owning API。

## 终结器不是普通兜底

纯 managed wrapper 不应只因实现 `IDisposable` 就加终结器。终结器增加终结队列和对象存活成本，执行时机不可预测，顺序也不保证；更重要的是它可能触达已终结或已卸载的 managed 依赖。只有直接拥有需要兜底释放的原生句柄时才考虑安全句柄/终结机制，并让确定性 `Dispose` 抑制终结。

Unity 的 `UnityEngine.Object` 具有托管 wrapper 与 native object 的双层语义，不能照搬一般 .NET `SafeHandle` 模式；按对应 API 的 `Destroy`、Addressables handle `Release`、NativeContainer `Dispose` 或 package owner 协议管理。托管 wrapper 变成不可达并不等于资源系统立即卸载底层内容。

## 异步与取消中的资源交接

异步方法常见泄漏时序是：调用者取消并认为任务结束，但底层操作仍完成并产生 handle；如果结果无人接收，handle 无人释放。协议要区分“请求取消”和“操作终止”：

```text
caller owns request
  -> operation starts with local owner
  -> success transfers result handle to caller only if request still current
  -> cancelled/stale result is released by operation owner
  -> failure releases partial resources and returns diagnostic
```

取消后竞态完成时，不能直接丢弃 callback 或只检查 owner 是否还活着；要释放迟到结果。若在 `await` 之间持有 pooled buffer、NativeArray 或 Addressables handle，异常、return、cancel 都必须穿过同一个 `finally`/owner cleanup 路径。

## Unity 与 Job 的销毁顺序

NativeContainer 的 dispose 必须排在最后一个 reader/writer job 之后：

```csharp
JobHandle work = job.Schedule(dependency);
JobHandle release = nativeArray.Dispose(work);
```

如果主线程同步读取结果，则先 `Complete` 对应 handle 再读；如果生命周期 owner 在 scene unload 时消失，仍需完成或串接释放依赖。过早 `Dispose` 会触发 safety error/非法访问；长期不 dispose 则造成 native memory 增长。两者是资源协议缺陷，不是 GC 参数问题。

## 终结器边界

终结器运行时间不可预测，可能延长对象存活并增加 GC 成本；实现安全句柄或 native wrapper 时才考虑它，而且必须避免访问已释放/托管依赖。Unity 资源通常应按其 API 的 handle/Release/Destroy 协议管理，不能自创终结器替代。

## 验证

为每个资源类型写重复 Dispose、异常路径、取消路径、Scene 切换和使用后访问测试；开发构建记录 owner、创建栈和未释放数量。目标不是“没有对象”，而是生命周期可解释。

建议用计数型 fake resource 验证 owner 合同：成功 acquire/release 数一致；失败构造释放已创建的前置资源；重复 dispose 不重复 release；borrower 结束不释放 owner 的资源；transfer 后原 owner 的释放不会误伤新 owner；取消后晚到成功仍被释放。对 native/Unity handle 再加 PlayMode 循环和 Memory Profiler snapshot，不能仅凭 mock 测试断言真实资源卸载。

## 参考资料

- [learn.microsoft.com/dotnet/standard/garbage-collection/implementing-dispose](https://learn.microsoft.com/dotnet/standard/garbage-collection/implementing-dispose)
