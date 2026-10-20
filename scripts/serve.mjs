// 本地预览用的静态服务器（只有本机预览需要 Node，部署到 GitHub Pages 不需要）。
//
//   node scripts/serve.mjs          # http://localhost:8123/
//   node scripts/serve.mjs --port 9000
//
// WebRTC 要求安全上下文：file:// 打开页面时浏览器可能禁用 RTCPeerConnection，
// 所以本地调试请走 http://localhost。
import {createServer} from 'node:http'
import {readFile, stat} from 'node:fs/promises'
import {extname, join, normalize, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../site/', import.meta.url))
const portArg = process.argv.indexOf('--port')
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8123

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    let filePath = normalize(join(root, urlPath))
    if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep) && filePath !== root) {
      res.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(filePath).catch(() => null)
    if (info?.isDirectory()) filePath = join(filePath, 'index.html')
    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'}).end('404 not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`预览地址: http://localhost:${port}/`)
})
