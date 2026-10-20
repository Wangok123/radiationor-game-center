# vendor：联机依赖的打包产物

这里的三个文件是浏览器端用的 ESM 包，由 [Trystero](https://github.com/dmotz/trystero) 打包而来：

| 文件 | 来源 | 作用 | 体积 |
| --- | --- | --- | --- |
| `mqtt.js` | `@trystero-p2p/mqtt` 0.26.0 | 用 MQTT 公共 broker（EMQX / HiveMQ / shiftr / mosquitto）交换 WebRTC 信令 | ~400 KB |
| `nostr.js` | `@trystero-p2p/nostr` 0.26.0 | 用 Nostr 中继交换信令 | ~74 KB |
| `torrent.js` | `@trystero-p2p/torrent` 0.26.0 | 用 BitTorrent tracker 交换信令 | ~64 KB |

`app.js` 会根据页面上选中的策略**按需动态 import**，所以只会下载其中一个。

## 为什么提交打包产物

`site/` 就是直接托管的静态站点，没有构建步骤，部署也不需要 Node。所以 vendor 产物直接进仓库，
浏览器端不依赖 npm 或 CDN（国内访问 esm.sh、jsdelivr 不一定稳定）。

## 重新生成

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-game-vendor.ps1
```

脚本会把固定版本的依赖装到 `.tools/vendor`（已被 git 忽略），再用 esbuild 重新打包。
只有升级 Trystero 时才需要跑；运行后把这三个文件一起提交。

## 说明

- 信令中继只用来交换 SDP/ICE 信息，**棋盘数据不经过中继**，走 WebRTC DataChannel 端到端加密直传。
- 打包时保留了 `--legal-comments=eof`，因此各文件末尾带上游的许可证声明。
- Trystero 与 MQTT.js 均为 MIT 许可。
