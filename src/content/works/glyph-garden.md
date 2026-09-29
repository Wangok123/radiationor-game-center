---
title: 符文花园
type: 系统驱动解谜游戏
date: 2025
platform: Windows
status: 原型完成
summary: 一款安静的格子解谜游戏，玩家通过连接元素符文、规划有限空间来培育会产生反应的花园。
tech: Unity | C# | ScriptableObject | Custom Editor Tools
role: 游戏架构、工具、存档系统
highlight: 设计数据优先的解谜规则，让设计人员无需修改玩法代码即可组合关卡。
image: https://images.unsplash.com/photo-1497250681960-ef046c08a56e?auto=format&fit=crop&w=1200&q=85
---

这个项目研究如何让系统规则保持易理解。基于 ScriptableObject 的内容流程将棋盘逻辑与表现分离，让每个符文自行声明行为。

