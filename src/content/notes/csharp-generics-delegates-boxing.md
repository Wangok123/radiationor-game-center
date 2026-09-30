---
slug: csharp-generics-delegates-boxing
title: 泛型、委托与装箱边界
date: 2026-09-30
updated: 2026-09-30
category: C# 语言
reading_time: 5 分钟
tags: C# | 泛型 | 委托 | 装箱
summary: 从值类型、接口、闭包和 AOT 约束梳理 C# 热路径中真正需要测量的运行时成本。
---

# 泛型、委托与装箱边界

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

泛型把类型约束和算法复用结合起来，避免许多强制转换和装箱；委托是类型安全的方法引用，lambda/闭包让行为组合更方便，但可能引入分配和生命周期捕获。Unity 热路径中应关注值类型通过接口、非泛型 API、委托捕获和集合类型擦除造成的装箱，不能把“用了泛型”直接等同于零分配。

性能判断必须落到具体调用点、编译后端和生成代码上。泛型可能减少装箱，却可能增加 IL2CPP 泛型实例、代码体积或间接调用；非捕获 lambda 可能被缓存，也可能因版本、转换或 API 形状而仍产生分配。不要把语言层规则简化为跨 Unity 版本的绝对结论。

## 类型与运行时成本

| 写法 | 潜在成本 | 观察点 |
| --- | --- | --- |
| `List<int>` | 通常避免每个元素装箱 | 扩容、枚举器、传给非泛型 API。 |
| `IEnumerable<int>` / 接口参数 | 可能发生迭代器/装箱或虚调用 | 具体实现、JIT/AOT 和调用频率。 |
| `Action` 捕获局部变量 | closure 对象和委托分配 | 是否每帧创建、捕获对象是否延长生命。 |
| `object` / `ArrayList` | 值类型装箱、拆箱和类型错误 | 热路径改泛型容器。 |

## 先区分四种常被混淆的成本

| 成本 | 常见触发点 | 应如何证明 |
| --- | --- | --- |
| 装箱分配 | 值类型转 `object`、非泛型接口、`string.Format` 等 API | Profiler 的 GC Alloc、IL/生成代码审查。 |
| 闭包对象 | lambda 捕获局部变量或 `this` | 分配调用栈、对象引用链、重复订阅测试。 |
| 委托实例 | 方法组/lambda 转为 delegate，特别是热路径创建 | 逐帧 alloc trace，与缓存 delegate 对照。 |
| 虚调用/间接调用 | 接口、virtual、delegate 调用 | 先确认它是否是热点，再以目标后端 benchmark 判断。 |

它们可以同时出现，也可以完全没有。看到接口或 lambda 只能提出假设，不能直接下“会 GC”或“慢”的结论。

## 泛型与接口的边界

泛型容器 `List<T>` 保存值类型时通常直接保存 `T`，而将同一值传到 `object`、非泛型 `IEnumerable` 或某些 interface 参数时可能装箱。另一个容易遗漏的来源是枚举：`List<T>.Enumerator` 是 struct，但若先转换为 `IEnumerable<T>` / `IEnumerator<T>` 或用不匹配的接口形状遍历，具体运行时可能引入接口调用或装箱。

```csharp
// 观察点不是 "foreach 一定分配"，而是实际静态类型和调用路径。
List<int> values = GetValues();
foreach (var value in values) Consume(value);

IEnumerable<int> sequence = values;
foreach (var value in sequence) Consume(value); // 单独 profile 这条路径
```

`where T : struct`、`class`、基类和接口约束表达的是可用能力与空值/复制语义，不是性能开关。接口约束中的成员调用、`EqualityComparer<T>.Default`、默认构造和反射激活都应针对目标后端测试。避免为绕开一次未证实的接口调用而复制大量专用算法。

## 闭包不是免费语法

```csharp
// 可能每次调用都创建 closure，且捕获 owner。
button.onClick.AddListener(() => Open(itemId));
```

若订阅发生在 `OnEnable`，必须在 `OnDisable` 用同一委托实例退订，或使用可明确释放的 subscription。捕获场景对象/大对象还会延长其可达性，形成隐蔽内存保留。

### 订阅生命周期示例

```csharp
private UnityAction _openAction;

void Awake()
{
    _openAction = OnOpenClicked;
}

void OnEnable() => button.onClick.AddListener(_openAction);
void OnDisable() => button.onClick.RemoveListener(_openAction);
void OnOpenClicked() => Open(itemId);
```

这段写法解决的是“同一实例能退订”和生命周期可读性，不保证所有情况下零分配。若每个 item 有不同参数，应让数据 owner 负责绑定/解绑，或让事件携带数据；不要为了复用一个 lambda 把可销毁的 `MonoBehaviour` 隐式捕获进长寿命 publisher。

## 委托 API 的所有权契约

为事件或 callback API 写清以下条件：谁持有订阅、订阅什么时候失效、触发线程、重入是否允许、异常如何处理、异步完成后 owner 是否仍有效。`Action<T>` 的类型安全不能提供这些生命周期语义。

| 设计 | 适合 | 风险 |
| --- | --- | --- |
| CLR event | 发布者/订阅者长期同寿命 | 忘记退订导致保留链。 |
| 返回 `IDisposable` subscription | 生命周期跨组件、需要显式所有权 | 调用方不 dispose 仍会泄漏。 |
| 一次性 callback | 单次异步结果 | 取消、超时和重复完成必须定义。 |
| 消息队列/事件总线 | 多模块解耦 | 隐式顺序、异常传播和可观测性变差。 |

## 泛型约束的工程价值

`where T : struct`、`class`、接口或 `new()` 不只是编译器提示；它可以减少无意义的运行时检查，让 API 表达所有权和能力边界。但在 IL2CPP/AOT 环境，反射创建未知泛型实例、裁剪和代码体积仍需目标构建验证。

对 public API 优先让参数表达数据所有权：借用的 `ReadOnlySpan<T>` / `IReadOnlyList<T>`、转移所有权的 payload、可变 buffer 和回调的执行线程不应混为一个 `T`。但 `Span<T>` 受 ref struct 生命周期限制，不能穿越 `await`、不能被 lambda 捕获，也不能随意存入类字段；Unity 的 API、运行时 profile 和序列化边界需要逐项验证。

## IL2CPP/AOT 的额外问题

IL2CPP 不是 Editor Mono/JIT 的简单替换。反射按字符串创建泛型类型、序列化器动态发现类型、泛型虚方法、linker stripping、native plugin interop 和泛型代码生成都可能在目标构建失败或产生体积/启动成本。以下问题必须在目标平台构建中验证：

1. 运行时才决定的 `MakeGenericType` / `MakeGenericMethod` 是否有生成和保留代码。
2. 序列化框架使用的类型、字段、构造器是否被裁剪。
3. 值类型泛型、interface dispatch 和 delegate 路径在目标平台的分配与吞吐。
4. 泛型实例增长是否影响 build size、构建时间或启动预热。

项目里应把 AOT 保留策略、生成代码或 `link.xml` 视作交付物；“Editor 能跑”不是证据。具体 Unity 版本、scripting backend、managed stripping level 和序列化包版本必须在验证环境记录中写明。

## 诊断

对同一算法写 `List<int>`、`ArrayList`、接口枚举、捕获 lambda 四个版本，使用 Profiler/BenchmarkDotNet（纯 C# 部分）记录分配、吞吐和尾延迟。结论必须标明 Unity/IL2CPP/设备环境，不能把 Editor JIT 结果外推。

### 最小验证矩阵

| 维度 | 至少一组对照 | 原始证据 |
| --- | --- | --- |
| 装箱 | `List<int>` 与 `ArrayList`/`object` 边界 | 每次操作 GC Alloc、调用栈。 |
| 枚举 | 具体 `List<T>` 与接口静态类型 | 目标 backend 的 capture。 |
| 闭包/委托 | 缓存 handler 与每次构造 lambda | 反复 Enable/Disable 后的订阅数和内存快照。 |
| AOT | Editor 与目标 IL2CPP build | build log、运行日志、stripping 配置。 |
| 泛型序列化 | 已知类型与运行时发现类型 | payload、耗时、AOT 保留/失败日志。 |

## 参考资料

- [learn.microsoft.com/dotnet/csharp/programming-guide/generics](https://learn.microsoft.com/dotnet/csharp/programming-guide/generics/)
- [learn.microsoft.com/dotnet/csharp/programming-guide/types/boxing-and-unboxing](https://learn.microsoft.com/dotnet/csharp/programming-guide/types/boxing-and-unboxing)
