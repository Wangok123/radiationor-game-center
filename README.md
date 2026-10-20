# 联机五子棋

一个**没有服务器**的多人五子棋，纯静态文件托管在 GitHub Pages。

- 线上地址：<https://wangok123.github.io/lin-unity-workbench/>
- 原理：房主的浏览器是权威端，负责落子判定与状态广播；棋盘数据通过 WebRTC DataChannel
  在玩家之间直传，公共中继（MQTT / Nostr / BitTorrent Tracker）只用来交换连接信息。

```
site/            直接托管到 GitHub Pages 的静态站点，没有构建步骤
  index.html     页面骨架：入口（房间设置） / 房间（棋盘 + 玩家 + 日志 + 诊断）
  style.css      全部样式，无外部依赖
  app.js         房间、房主权威同步、渲染、连接诊断
  gomoku.js      纯规则模块（不碰 DOM，可单测）
  vendor/        Trystero 三种信令策略的打包产物，按需动态加载
scripts/
  serve.mjs             本地预览服务器（只有本地调试需要 Node）
  build-game-vendor.ps1 重新生成 vendor（只在升级 Trystero 时需要）
tests/
  gomoku.test.mjs       规则单测
  p2p-smoke.mjs         两个真实浏览器跑完整一局，验证联机链路
```

## 本地预览

WebRTC 需要安全上下文，别直接双击 `file://` 打开：

```powershell
node scripts/serve.mjs        # http://localhost:8123/
```

## 测试

```powershell
node --test tests/gomoku.test.mjs   # 规则
node tests/p2p-smoke.mjs            # 联机链路（需要本机 Edge 或 Chrome + 公网）
```

冒烟测试会自动起服务器、开两个无头浏览器，验证：连上、双向落子、五连判胜、聊天同步、
刷新重连回座位、重新开始、房主离开提示。

## 怎么玩

1. 打开页面，填昵称，点「创建房间（我做房主）」→ 自动生成房间号。
2. 点「复制邀请链接」发给朋友；朋友打开链接、填昵称、点「加入房间」即可。
3. 房主执黑先手。支持观战、聊天、重新开始。

## 关键设计

- **房主权威**：只有房主的浏览器算裁判，其他人只发「我想下这里」，等下一次全量状态快照。
  桌游状态很小（225 格数组），全量同步比增量同步省心。
- **隐藏信息**：状态由房主裁剪后下发，要做「一夜狼 / 阿瓦隆」这类有秘密身份的游戏时，
  在房主端按座位分别下发即可，框架已经按这个思路搭好。
- **断线**：每个客户端的座位在房主端登记；刷新后同昵称会抢回原座位，棋盘不丢。
  房主掉线则本局结束（暂未做房主迁移）。
- **连接诊断**：页面下方会列出中继连接状态、每个对端的连接状态、延迟、ICE 候选类型。
  只看到 `host` 候选、没有 `srflx/prflx/relay` 时，说明当前只能局域网直连；跨网络连不上
  就在「高级」里填一个可用的 TURN（Open Relay、Metered 都有免费额度）。

## 信令与体积

`site/vendor/` 里是三种信令策略的打包产物，点开房间时按选中的策略**只加载一个**：

| 策略 | 体积 | 说明 |
| --- | --- | --- |
| MQTT | ~400 KB | 默认，公共 broker（EMQX 等），国内最容易连通 |
| Nostr | ~74 KB | 中继数量最多，部分网络不通 |
| BitTorrent Tracker | ~64 KB | 最轻量，公共 tracker 常被墙 |

重新生成（只在升级 Trystero 时）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-game-vendor.ps1
```

脚本把固定版本的依赖装进 `.tools/vendor`（已忽略），再用 esbuild 打包。

## 部署

推到 `main` 即可：`.github/workflows/deploy.yml` 直接把 `site/` 上传为 Pages 产物，
**没有构建步骤**，也不需要 Node。仓库设置里 Pages 的 Source 选 **GitHub Actions**。

## 边界

- P2P 打洞在部分网络会失败，需要自备 TURN；没有 TURN 时成功率取决于双方 NAT。
- P2P 无法防作弊：房主能看到全部状态，适合朋友之间玩，不适合竞技。
- 只支持房间号开局，没有陌生人匹配、排行榜这类需要服务端的功能。
