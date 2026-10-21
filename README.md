# RadiationOr 游戏中心

一个**即点即玩网页小游戏的索引站**，尤其收 AI 生成的作品：收录清单在 `site/games.json`，
卡片、标签、搜索都由它渲染。整个站是**纯静态文件**，托管在 GitHub Pages，没有后端。

站上的游戏分两类：

- **站内游戏**（如五子棋）：代码在这个仓库里，能用上共用联机层——房主的浏览器当裁判，
  对局走「中继模式」（公共 MQTT broker 转发 + 端到端加密，不需要 TURN）或「直连模式」（WebRTC 点对点）。
- **外链游戏**：点卡片跳到别人的站点。能不能联机由那个游戏自己决定，本站只负责发现。

- 线上地址：<https://wangok123.github.io/radiationor-game-center/>
- 目前收录：五子棋（站内，15×15，2 人，可联机）
- 加一个游戏：改 `site/games.json` 加一条，见下面「收录一个游戏」
- **下一步做什么：见 [ROADMAP.md](ROADMAP.md)**（每完成一项就更新它）

## 目录

```
site/                    直接托管到 Pages 的静态站点，没有构建步骤
  index.html             首页：从 games.json 渲染游戏索引 + 怎么联机
  games.json             收录清单：一条 = 一个游戏（站内相对路径或外链）
  assets/                所有游戏共用的资源
    base.css             设计变量、页头、按钮、表单、面板、页脚
    home.css             首页（hero、游戏卡片、搜索/标签工具栏、步骤）
    games-index.js       索引逻辑：过滤 / 搜索 / 卡片渲染（纯函数可直接单测）
    room.css             房间界面：房间条、玩家、日志、聊天、连接诊断
    transport.js         连接方式入口：中继模式 / 直连模式
    transport-relay.js   中继模式：公共 MQTT + AES-GCM 加密
    transport-p2p.js     直连模式：Trystero + WebRTC
    room.js              直连模式的信令与 STUN/TURN 工具
    room-ui.js           信令单选、自定义中继与 TURN 表单
    diag.js              连接诊断面板（一行挂载）
    util.js              昵称/房间号/复制/本地存储等小工具
    favicon.svg
    vendor/              Trystero 三种信令的打包产物，按需加载
  games/
    gomoku/              五子棋：index.html + app.js + rules.js + gomoku.css
scripts/
  serve.mjs              本地预览服务器
  validate-games.mjs     校验 games.json（字段 + 站内路径是否存在）
  lib/games-schema.mjs   校验规则本体（脚本和单测共用）
  build-game-vendor.ps1  重新生成 assets/vendor（只在升级 Trystero 时）
tests/
  gomoku.test.mjs        规则单测
  games-index.test.mjs   索引的过滤/搜索/数据校验单测
  index-smoke.mjs        无头浏览器验证首页卡片、标签、搜索
  p2p-smoke.mjs          两个真实浏览器跑完整一局，验证联机链路
```

## 收录一个游戏

索引数据只有一份：`site/games.json`。加一条就收录了，**不用改代码**。

```json
{
  "slug": "some-ai-game",
  "title": "某个 AI 小游戏",
  "url": "https://example.com/game/",
  "desc": "一句话介绍，显示在卡片上。",
  "author": "作者 / 出处",
  "tags": ["解谜", "单人"],
  "players": "1 人",
  "duration": "10 分钟",
  "multiplayer": false,
  "icon": "谜",
  "added": "2026-10-21"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `slug` | 是 | 唯一标识，小写字母/数字/连字符 |
| `title` | 是 | 卡片标题 |
| `url` | 是 | 站内写相对路径（`games/gomoku/`），外部写完整 `https://…` |
| `desc` | 是 | 卡片上的一句话介绍 |
| `tags` | 否 | 字符串数组，同时用于筛选按钮和搜索 |
| `author` | 否 | 作者或出处；收别人的作品时请务必填 |
| `players` / `duration` | 否 | 人数、时长，卡片上的小圆角标签 |
| `multiplayer` | 否 | `true` 时卡片显示「可联机」徽标 |
| `icon` | 否 | 卡片左侧方块里的 1–2 个字符，默认取标题首字 |
| `added` | 否 | 收录日期 `YYYY-MM-DD` |

两条规则：

- **站内 vs 外链**：`url` 以 `http` 开头就当外链，卡片会新开标签页并显示「前往 ↗」；其余按站内相对路径处理，显示「进入 →」。
- **外链游戏的联机不由本站负责**：它在别人域名下跑，能不能联机取决于它自己。本站只负责「发现」，标 `multiplayer: true` 前请先确认。

改完跑一下校验（CI 也会跑，写错会挡住部署）：

```powershell
node scripts/validate-games.mjs
```

它会检查字段类型、slug/url 是否重复，以及**站内 url 指向的文件是否真的存在**。

## 加一个新游戏

如果游戏就在本站（`site/games/<slug>/`），照下面走，就能用上共用层；如果只是个外链，**只需要在 `games.json` 加一条**，不用建目录。

联机、诊断、样式都已经抽成共用层了，加一个站内游戏基本只有三步：

1. 复制 `site/games/gomoku/` 为 `site/games/<你的游戏>/`，把 `rules.js`（纯规则）和
   `app.js`（状态 + 渲染 + 房主判定）换成你的玩法，页面里的 `assets/` 路径保持不变。
2. 在 `site/games.json` 里加一条，`url` 写 `games/<你的游戏>/`。
3. push。

外链游戏则是另一种情况：不用建目录，只在 `games.json` 加一条 `https://…` 的记录。

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

两种模式对游戏逻辑完全一致，都遵循「房主权威 + 全量快照」：房主的浏览器是唯一裁判，
其他人只发「我想做这个动作」，等下一次全量快照。

- **中继模式**：两端各自连上公共 MQTT broker，订阅一个由「应用名 + 房间号」哈希出来的 topic。
  消息体用 PBKDF2 派生的 AES-GCM 密钥加密，broker 只看到随机 topic 和密文。
  心跳 6 秒一次，对方关闭页面会立刻广播 bye。
- **直连模式**：公共中继（MQTT / Nostr / BitTorrent）只用来交换 SDP/ICE，
  之后的棋步走 WebRTC DataChannel 点对点直传。

跨网络打洞失败时（页面诊断里只有 `host` 候选、没有 `srflx/prflx/relay`），在游戏页「高级」里
填一个自己的 TURN 再试（Open Relay、Metered 都有免费额度）。

## 本地预览

WebRTC 需要安全上下文，别直接双击 `file://` 打开：

```powershell
node scripts/serve.mjs        # http://localhost:8123/
```

## 测试

```powershell
node --test tests/gomoku.test.mjs tests/games-index.test.mjs   # 规则 + 索引逻辑，秒级
node scripts/validate-games.mjs                               # 收录数据校验
node tests/index-smoke.mjs                                     # 首页卡片/标签/搜索（无头浏览器，需本地 Edge 或 Chrome）
node tests/p2p-smoke.mjs                                       # 联机链路（需要公网）
```

`index-smoke` 会自动起服务器、开一个无头浏览器，验证：卡片从 `games.json` 渲染、可联机徽标、
数量文案、搜索命中/空态、标签筛选与取消、老游戏页仍能打开、页面无 JS 报错，并把桌面/手机截图写到 `.qa/`。

`p2p-smoke` 验证：连上、双向落子、五连判胜、聊天同步、刷新重连回座位、重新开始、房主离开提示。

## 重新生成 vendor

`site/assets/vendor/` 里是三种信令策略的打包产物（MQTT ~400 KB / Nostr ~74 KB / Tracker ~64 KB），
点开房间时只加载选中的那一个。升级 Trystero 时才需要重新生成：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-game-vendor.ps1
```

脚本把固定版本的依赖装进 `.tools/vendor`（已忽略），再用 esbuild 打包。

## 部署

推到 `main` 即可：`.github/workflows/deploy.yml` 会先跑 `validate-games.mjs` 和单测，
再把 `site/` 直接上传成 Pages 产物。**没有构建步骤**，产物就是仓库里的静态文件。
仓库设置里 Pages 的 Source 选 **GitHub Actions**。

## 连不上时的排查顺序

游戏页底部「连接诊断」会显示：版本、房间、角色、双方 peer、信令、WebRTC 支持、网络自检结果、
中继状态、对端连接状态。按下面顺序看：

1. **两端版本号必须一致**（房间栏和诊断第一行，现在是 `v5 · 2026-10-20`）。
   版本不一致说明有一端还是缓存的旧页面，让对方强制刷新或重新打开邀请链接。
2. **先确认连接方式**。中继模式下不依赖 WebRTC，也不受 NAT 影响；如果直连一直失败，
   在入口把「连接方式」切到中继模式（默认就是中继）。
2. **微信内置浏览器**可能限制 WebRTC。如果页面顶部出现黄条提示，点右上角「…」→「在浏览器打开」。
3. **网络自检**：点一下，几秒出结果。
   - 出现 `srflx` 或 `relay` → 这台设备能打洞，问题多半在对端或双方 NAT；
   - 只有 `host` → 这台设备的网络无法跨网络直连，必须配 TURN。
4. **换信令**：MQTT 不通时试试页面上的 Nostr / BitTorrent（不同网络下可达性不一样）。
5. **TURN**：在「高级」里填地址/用户名/密码。实测免费公共 TURN（openrelay）在国内不通，
   比较可靠的是自己用小服务器跑 coturn。

补充：手机 5G/移动网络多为对称 NAT，和家里宽带互连比「宽带↔宽带」难得多；同一 WiFi 下必然能连，
可以用来确认代码本身没问题。

## 已知的默认 ICE 配置

Trystero 自带的默认 STUN 是 `stun.l.google.com` 和 `stun.cloudflare.com`，前者在国内基本不通，
会让 ICE 收集一直等超时。本站改成实测可用的国内 STUN（`assets/room.js` 里的 `DEFAULT_STUN_URLS`）：

```
stun:stun.miwifi.com:3478
stun:stun.chat.bilibili.com:3478
stun:stun.hitv.com:3478
stun:stun.cdnbye.com:3478
stun:stun.cloudflare.com:3478
```

不通的服务器不要往列表里加：ICE 会一直等它超时，反而拖慢连接。

## 边界

- P2P 打洞在部分网络会失败，需要自备 TURN；没有 TURN 时成功率取决于双方 NAT。
- P2P 无法防作弊：房主能看到全部状态，适合朋友之间玩。
- 只有房间号开局，没有陌生人匹配、排行榜这类需要服务端的功能。
