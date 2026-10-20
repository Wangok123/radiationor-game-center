// 联机链路冒烟测试：用两个真实浏览器实例跑完一整局，验证 P2P 是否真的通。
//
//   node tests/p2p-smoke.mjs
//
// 做的事：
//   1. 起本地静态服务器（scripts/serve.mjs），加载 site/
//   2. 开两个无头浏览器：一个创建房间，一个加入房间
//   3. 检查连上、轮流失子、五连判胜、聊天同步、刷新重连回座位、重新开始、房主离开提示
//
// 需要 Node 18+ 和本机的 Edge 或 Chrome。
// 依赖公网信令中继，网络不通时这一步会失败，页面上的「连接诊断」能看到具体原因。
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const PORT = Number(process.env.SMOKE_PORT || 8123)
const BASE = `http://localhost:${PORT}`

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true})
      this.ws.addEventListener('error', reject, {once: true})
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const {resolve, reject} = this.pending.get(message.id)
        this.pending.delete(message.id)
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
      } else if (message.method) {
        this.events.push(message)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({id, method, params}))
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }

  errors() {
    return this.events
      .filter((event) => event.method === 'Runtime.exceptionThrown'
        || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'))
      .map((event) => (event.method === 'Runtime.exceptionThrown'
        ? `异常: ${event.params.exceptionDetails.text} ${event.params.exceptionDetails.exception?.description || ''}`
        : `控制台错误: ${event.params.entry.text}`))
  }
}

function findBrowser() {
  const found = BROWSERS.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 Edge/Chrome，可用 BROWSER_PATH 指定可执行文件路径')
  return found
}

async function launchBrowser(label, debugPort) {
  const profile = mkdtempSync(join(tmpdir(), `p2p-smoke-${label}-`))
  const child = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank'
  ], {stdio: 'ignore'})

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        await cdp.send('Runtime.enable')
        await cdp.send('Log.enable')
        await cdp.send('Page.enable')
        return {cdp, child, profile, debugPort}
      }
    } catch { /* 浏览器还在启动 */ }
    await sleep(250)
  }
  child.kill()
  throw new Error(`${label}: 浏览器调试端口没有就绪`)
}

async function shutdownBrowser({child, profile, debugPort}) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
    const cdp = new Cdp(version.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Browser.close')
  } catch {
    child.kill()
  }
  await sleep(400)
  try { rmSync(profile, {recursive: true, force: true}) } catch { /* 文件可能还被占用 */ }
}

function startServer() {
  const child = spawn(process.execPath, [join(repoRoot, 'scripts/serve.mjs'), '--port', String(PORT)], {stdio: 'ignore'})
  return child
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${BASE}/`)
      if (response.ok) return
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('本地静态服务器没有起来：检查 site/index.html 是否存在')
}

const SNAP = `JSON.stringify({
  stones: document.querySelectorAll('#board .stone').length,
  role: document.getElementById('role-text').textContent,
  net: document.getElementById('net-text').textContent,
  status: document.getElementById('game-status').textContent,
  players: [...document.querySelectorAll('#player-list li')].map((li) => li.textContent.trim()),
  log: [...document.querySelectorAll('#log-list li')].map((li) => li.textContent.trim()),
  diag: document.getElementById('diag-body').textContent.replace(/\\s+/g, ' ').trim()
})`

const onlineCount = (snapshot) => Number((snapshot.net.match(/(\d+) 人在线/) || [])[1] || 0)
const clickCell = (cdp, index) => cdp.evaluate(`document.querySelector('#board .cell[data-index="${index}"]').click()`)

async function enterRoom(cdp, {name, code, action}) {
  await cdp.send('Page.navigate', {url: `${BASE}/`})
  await sleep(1500)
  await cdp.evaluate(`(() => {
    document.getElementById('name-input').value = ${JSON.stringify(name)}
    document.getElementById('code-input').value = ${JSON.stringify(code)}
    document.getElementById(${JSON.stringify(action)}).click()
    return true
  })()`)
}

async function main() {
  const problems = []
  const room = `T${Math.floor(Math.random() * 9000 + 1000)}`
  const server = startServer()
  let host = null
  let guest = null

  try {
    await waitForServer()
    console.log(`[1] 房间 ${room}：房主创建房间`)
    host = await launchBrowser('host', 9400 + Math.floor(Math.random() * 200))
    guest = await launchBrowser('guest', 9600 + Math.floor(Math.random() * 200))
    await enterRoom(host.cdp, {name: '房主A', code: room, action: 'create-btn'})
    await sleep(1200)

    console.log('[2] 客人加入房间，等待 P2P 建立…')
    await enterRoom(guest.cdp, {name: '玩家B', code: room, action: 'join-btn'})
    let connectedAt = 0
    for (let second = 1; second <= 30; second++) {
      await sleep(1000)
      const hostNet = onlineCount(JSON.parse(await host.cdp.evaluate(SNAP)))
      const guestNet = onlineCount(JSON.parse(await guest.cdp.evaluate(SNAP)))
      if (hostNet >= 2 && guestNet >= 2) {
        connectedAt = second
        break
      }
    }
    if (!connectedAt) throw new Error('30 秒内没有连上：信令中继不通，先看页面上的连接诊断')
    console.log(`    ${connectedAt} 秒连上`)

    const seated = JSON.parse(await host.cdp.evaluate(SNAP))
    console.log('    房主:', {role: seated.role, status: seated.status, players: seated.players})
    if (seated.players.length !== 2) problems.push(`玩家列表应只有两位，实际: ${seated.players.join(' / ')}`)

    console.log('[3] 轮流落子至黑棋五连（检查同步与胜负判定）')
    for (const [who, index] of [['host', 112], ['guest', 0], ['host', 113], ['guest', 1],
      ['host', 114], ['guest', 2], ['host', 115], ['guest', 3], ['host', 116]]) {
      await clickCell(who === 'host' ? host.cdp : guest.cdp, index)
      await sleep(600)
    }
    await sleep(1200)
    const hostEnd = JSON.parse(await host.cdp.evaluate(SNAP))
    const guestEnd = JSON.parse(await guest.cdp.evaluate(SNAP))
    console.log('    房主:', {stones: hostEnd.stones, status: hostEnd.status})
    console.log('    客人:', {stones: guestEnd.stones, status: guestEnd.status})
    if (hostEnd.stones !== 9 || guestEnd.stones !== 9) problems.push('落子同步不一致')
    if (!hostEnd.status.includes('你赢了')) problems.push('房主端没有正确判定胜利')
    if (!guestEnd.status.includes('获胜')) problems.push('客人端没有收到胜利结果')

    console.log('[4] 聊天广播')
    await guest.cdp.evaluate(`(() => {
      document.getElementById('chat-input').value = '联机测试一下'
      document.getElementById('chat-form').dispatchEvent(new Event('submit', {cancelable: true}))
      return true
    })()`)
    await sleep(1200)
    const hostChat = JSON.parse(await host.cdp.evaluate(SNAP))
    if (!hostChat.log.some((line) => line.includes('联机测试一下'))) problems.push('房主没收到聊天')

    console.log('[5] 诊断面板 / ICE 候选')
    await host.cdp.evaluate(`document.getElementById('ice-btn').click()`)
    await sleep(2500)
    const diag = JSON.parse(await host.cdp.evaluate(SNAP)).diag
    console.log('   ', diag.slice(0, 320))
    if (diag.includes('还没有连上任何人')) problems.push('诊断面板没有刷新对端状态')

    console.log('[6] 客人用邀请链接刷新重连，应回到白棋座位且棋盘保留')
    await guest.cdp.send('Page.navigate', {url: `${BASE}/?room=${room}&relay=mqtt`})
    let reconnected = false
    for (let second = 1; second <= 20; second++) {
      await sleep(1000)
      const snapshot = JSON.parse(await guest.cdp.evaluate(SNAP))
      if (snapshot.role.includes('白棋') && snapshot.stones === 9) {
        reconnected = true
        console.log(`    ${second} 秒回到座位（role=${snapshot.role} stones=${snapshot.stones}）`)
        break
      }
    }
    if (!reconnected) problems.push('刷新后没有回到座位，或棋盘状态丢失')

    console.log('[7] 重新开始')
    await guest.cdp.evaluate(`document.getElementById('restart-btn').click()`)
    await sleep(1500)
    if (JSON.parse(await host.cdp.evaluate(SNAP)).stones !== 0) problems.push('重新开始后房主棋盘没清空')
    if (JSON.parse(await guest.cdp.evaluate(SNAP)).stones !== 0) problems.push('重新开始后客人棋盘没清空')
    console.log('    两端棋盘已清空')

    console.log('[8] 房主离开，客人应收到提示')
    await host.cdp.send('Page.navigate', {url: 'about:blank'})
    let leftSeen = false
    for (let second = 1; second <= 15; second++) {
      await sleep(1000)
      const snapshot = JSON.parse(await guest.cdp.evaluate(SNAP))
      if (snapshot.status.includes('房主')) {
        leftSeen = true
        console.log(`    ${second} 秒检测到: ${snapshot.status}`)
        break
      }
    }
    if (!leftSeen) problems.push('房主离开后客人没有提示')

    for (const [label, node] of [['房主', host], ['客人', guest]]) {
      const errors = node.cdp.errors()
      if (errors.length) {
        console.log(`    ${label} 控制台报错:`)
        for (const error of errors.slice(0, 5)) console.log('      ', error)
        problems.push(`${label} 有控制台报错`)
      }
    }
  } finally {
    if (host) await shutdownBrowser(host)
    if (guest) await shutdownBrowser(guest)
    server.kill()
  }

  if (problems.length) {
    console.log('\n失败项:')
    for (const problem of problems) console.log('  ✗', problem)
    process.exitCode = 1
    return
  }
  console.log('\n全部通过 ✅ 连接、双向同步、胜负判定、聊天、刷新重连、重新开始、掉线提示')
}

main().catch((error) => {
  console.error('\n失败:', error.message)
  process.exitCode = 1
})
