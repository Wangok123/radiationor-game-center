# RadiationOr 游戏中心

朋友之间点开就能玩的小游戏合集。整个站是**纯静态文件**，托管在 GitHub Pages，没有后端：
房主的浏览器当裁判，游戏数据通过 WebRTC 在玩家之间直传，公共中继只负责牵线。

- 线上地址：<https://wangok123.github.io/radiationor-game-center/>
- 目前有：五子棋（15×15，2 人，回合制）

## 目录

```
site/                    直接托管到 Pages 的静态站点，没有构建步骤
  index.html             首页：游戏列表 + 怎么联机
  assets/                所有游戏共用的资源
    base.css             设计变量、页头、按钮、表单、面板、页脚
    home.css             首页（hero、游戏卡片、步骤）
    room.css             房间界面：房间条、玩家、日志、聊天、连接诊断
    room.js              联机传输层：信令策略、加入房间、对端/中继信息
    room-ui.js           信令单选、自定义中继与 TURN 表单
    diag.js              连接诊断面板（一行挂载）
    util.js              昵称/房间号/复制/本地存储等小工具
    favicon.svg
    vendor/              Trystero 三种信令的打包产物，按需加载
  games/
    gomoku/              五子棋：index.html + app.js + rules.js + gomoku.css
scripts/
  serve.mjs              本地预览服务器
  build-game-vendor.ps1  重新生成 assets/vendor（只在升级 Trystero 时）
tests/
  gomoku.test.mjs        规则单测
  p2p-smoke.mjs          两个真实浏览器跑完整一局，验证联机链路
```

## 加一个新游戏

联机、诊断、样式都已经抽成共用层了，加游戏基本只有三步：

1. 复制 `site/games/gomoku/` 为 `site/games/<你的游戏>/`，把 `rules.js`（纯规则）和
   `app.js`（状态 + 渲染 + 房主判定）换成你的玩法，页面里的 `assets/` 路径保持不变。
2. 在 `site/index.html` 的游戏列表里加一张卡片（照抄五子棋那张，换链接和文案）。
3. push。

可以直接引用的共用能力：

| 模块 | 提供 |
| --- | --- |
| `assets/room.js` | `joinTransport()` 加入房间、`STRATEGIES` 信令定义、`peersOf()`、`relaySockets()`、`pingPeers()`、`iceSnapshot()` |
| `assets/room-ui.js` | `renderStrategyPicker()` 渲染信令单选、`readRelayUrls()` / `readTurnServers()` 读高级表单 |
| `assets/diag.js` | `mountDiagnostics(容器, 上下文)` 生成并刷新连接诊断面板 |
| `assets/util.js` | `cleanName()`、`normalizeCode()`、`randomCode()`、`copyText()`、`readStore()` / `writeStore()` |

推荐的同步模式就是五子棋这套：**房主权威 + 全量快照**。桌游状态很小（一个数组/几个对象），
全量同步比增量同步简单得多；有隐藏信息（手牌、身份）的游戏在房主端按座位分别下发即可。

## 联机原理

1. 双方用同一个房间号进入同一个「房间」。
2. 房间靠公共中继（MQTT / Nostr / BitTorrent Tracker）牵线交换 SDP/ICE，**之后游戏数据不经过中继**，
   走 WebRTC DataChannel 点对点直传。
3. 房主的浏览器是唯一裁判，其他人只发「我想做这个动作」，等下一次全量快照。

跨网络打洞失败时（页面诊断里只有 `host` 候选、没有 `srflx/prflx/relay`），在游戏页「高级」里
填一个自己的 TURN 再试（Open Relay、Metered 都有免费额度）。

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

## 重新生成 vendor

`site/assets/vendor/` 里是三种信令策略的打包产物（MQTT ~400 KB / Nostr ~74 KB / Tracker ~64 KB），
点开房间时只加载选中的那一个。升级 Trystero 时才需要重新生成：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-game-vendor.ps1
```

脚本把固定版本的依赖装进 `.tools/vendor`（已忽略），再用 esbuild 打包。

## 部署

推到 `main` 即可：`.github/workflows/deploy.yml` 直接把 `site/` 上传成 Pages 产物，
没有构建步骤，也不需要 Node。仓库设置里 Pages 的 Source 选 **GitHub Actions**。

## 边界

- P2P 打洞在部分网络会失败，需要自备 TURN；没有 TURN 时成功率取决于双方 NAT。
- P2P 无法防作弊：房主能看到全部状态，适合朋友之间玩。
- 只有房间号开局，没有陌生人匹配、排行榜这类需要服务端的功能。
