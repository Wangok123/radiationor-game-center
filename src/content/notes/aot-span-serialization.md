---
slug: aot-span-serialization
title: AOT 泛型、Span 与序列化性能
date: 2026-09-30
updated: 2026-09-30
category: C# 语言
reading_time: 4 分钟
tags: IL2CPP | AOT | Span | 序列化
summary: 从裁剪、泛型可达性、Span 生命周期和协议演进看 AOT 环境下的序列化边界。
---

# AOT 泛型、Span 与序列化性能

> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。

## 核心结论

在 IL2CPP/AOT 环境，运行时通过反射或未知类型构造泛型可能缺少生成代码或被 linker 裁剪；编辑器能跑不代表目标构建能跑。`Span<T>`/`Memory<T>` 可表达切片和减少复制，但受 API、异步生命周期和 Unity/IL2CPP 版本支持边界约束。序列化优化应先看分配、CPU、数据量和兼容性，再选择 source generation、手写 codec 或现有库。

## 三条独立风险线

不要把“IL2CPP 出问题”笼统归因给 AOT。至少区分三种互不等价的失败：

| 风险 | 典型触发方式 | 正确的证据 | 常见错误修复 |
| --- | --- | --- | --- |
| 泛型实例不可用 | 运行时按类型参数构造、反射调用闭合泛型 | 目标 Player 的最小调用和完整堆栈 | 只在 Editor 添加一个泛型测试。 |
| 代码/元数据被裁剪 | 类型只从 JSON、反射、资源配置间接到达 | strip 后 build 的反序列化 smoke、linker report | 把整个程序集无条件 preserve。 |
| 协议不兼容 | 旧存档/服务端 payload 缺字段或类型变化 | 历史样本、unknown/default/null 边界矩阵 | “能反序列化今天的样本”即认为兼容。 |

`link.xml` 是保留声明，不是业务正确性证明。它需要以最小类型/成员范围维护并在目标 build 验证；过宽的 preserve 能掩盖依赖关系，也会增加代码体积和启动/维护成本。反射、`Type.GetType`、按字符串配置类型、序列化多态和动态构造泛型都应有清单，列出触达路径、owner、保留策略和 Player smoke。

## 泛型与序列化的可达性

运行时可选择的类型集合必须在构建时可审计。一个健壮的边界通常是：协议层只允许注册表中的消息 type id，注册表显式引用 codec/泛型实例，未知 id 被拒绝或走版本化降级，而不是把客户端传来的类型名交给反射。这样同时缩小裁剪问题和不可信类型名的攻击面。

```text
payload type id -> allow-listed codec -> known data contract -> domain validation
                                           -> explicit default/unknown-field policy
```

泛型静态字段、装箱、虚调用和共享泛型代码的实际开销也不应凭直觉判断。先以目标 Player 的 build size、解析 CPU、GC 和失败样本为准；如果为了保住 AOT 而改成手写二进制 codec，还必须测版本演进、调试成本、跨语言服务端实现和错误恢复。

## Span、Memory 与生命周期

`Span<T>` 是栈受限的视图，适合在一个同步调用链内切片、解析或格式化；它不是“零分配”的同义词，也不是可跨异步边界的容器。`Memory<T>` 可以表示可长期持有的内存区间，但底层 buffer 的 owner、池化归还时机和异常路径仍需明确。

| 场景 | 合适的边界 | 需要检查的风险 |
| --- | --- | --- |
| 同步 packet parse | `ReadOnlySpan<byte>` 只在方法链内使用 | 越界、字节序、长度前缀、未验证输入。 |
| 异步 IO 后处理 | await 完成后重新取得 span，或持有 owner 明确的 `Memory<byte>` | span 跨 `await`、buffer 被 pool 提前归还。 |
| 大量短 payload | buffer pool + 显式 owner/Dispose | 双重归还、异常泄漏、长时间 pin/大对象堆。 |
| Unity API 交互 | 纯托管编码边界与 Unity main-thread apply 分离 | 把 native/Unity object 生命周期误当作 managed buffer 生命周期。 |

“少一次 copy”只有在 copy 是测得瓶颈时才是收益。小 payload 使用复杂池化可能让尾延迟、错误恢复和所有权问题恶化；先比较 allocation、CPU、payload 大小、缓存命中和维护复杂度。

## 数据协议合同

字段位置、成员名和 `ToString()` 都不是稳定协议。为每个长期存储或网络 payload 定义：schema/version、字段 id 或稳定名称、默认值、null 语义、unknown field 策略、弃用窗口、升级/降级路径和最大长度。对不可信输入还应有递归深度、集合长度、字符串/二进制上限和类型白名单。

| 变更 | 老读新 | 新读老 | 推荐策略 |
| --- | --- | --- | --- |
| 新增可选字段 | 忽略或使用默认值 | 使用默认值 | 保持字段可选并记录默认语义。 |
| 删除字段 | 旧 reader 可能依赖它 | 新 reader 忽略 | 先弃用，再跨一个兼容窗口删除。 |
| 改变含义/单位 | 可能静默错误 | 可能静默错误 | 新 field id/version，禁止复用旧含义。 |
| 多态类型 | 未知派生类失败或不安全 | 同左 | allow-list type id + 明确 fallback。 |

## 设计检查

- AOT 需要哪些具体泛型实例？是否被代码引用、保留或生成？
- 反射扫描、字段名、版本兼容和裁剪配置是否有真机 build 测试？
- `Span<T>` 不能跨 `await` 保存，也不能把栈数据泄漏到异步生命周期。
- 序列化协议是否有字段编号/默认值/未知字段策略，而不是依赖成员顺序？
- 优化后是否减少了网络字节、GC 和 CPU，而不是只改变代码形状？

## 验证矩阵

| 层级 | 最小样本 | 要保留的 evidence | 不能替代 |
| --- | --- | --- | --- |
| Editor contract | 每个 codec 的 round-trip、坏长度、unknown version | test name、fixture、失败 payload | 裁剪后的 AOT 可达性。 |
| IL2CPP build smoke | 反射、多态、泛型、历史 payload | 平台、架构、build report、player log | 性能结论。 |
| 性能 benchmark | 小/典型/最大 payload，冷/热状态 | 原始时间序列、GC、字节数、内存峰值 | 兼容性和安全性。 |
| 版本演进 | N-1/N/N+1 样本与损坏数据 | schema、升级策略、恢复/拒绝行为 | 真实线上数据分布。 |

## 验证

对代表性 payload 比较 JSON、source-generated JSON、二进制 codec：记录字节数、P50/P99 CPU、GC、IL2CPP 构建体积和旧版本兼容性。至少在一个真实目标平台上执行解析/反序列化 smoke。

## 参考资料

- [learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
- [docs.unity3d.com/2022.3/Documentation/Manual/IL2CPP.html](https://docs.unity3d.com/2022.3/Documentation/Manual/IL2CPP.html)
- [docs.unity3d.com/2022.3/Documentation/Manual/ManagedCodeStripping.html](https://docs.unity3d.com/2022.3/Documentation/Manual/ManagedCodeStripping.html)
