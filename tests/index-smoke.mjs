// 首页索引的 UI 冒烟测试：真的开一个无头浏览器，验证 games.json → 卡片 / 标签 / 搜索都正常。
//   node tests/index-smoke.mjs
//
// 不需要网络：只访问本地 server。需要本机 Edge 或 Chrome（可用 BROWSER_PATH 指定）。

import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const PORT = Number(process.env.SMOKE_PORT || 8199)
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = join(repoRoot, '.qa')

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
  const profile = mkdtempSync(join(tmpdir(), `index-smoke-${label}-`))
  const child = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
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
    } catch { /* 还在启动 */ }
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
  try { rmSync(profile, {recursive: true, force: true}) } catch { /* 可能还被占用 */ }
}

function startServer() {
  return spawn(process.execPath, [join(repoRoot, 'scripts/serve.mjs'), '--port', String(PORT)], {stdio: 'ignore'})
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('本地静态服务器没有起来')
}

async function waitFor(cdp, expression, {timeout = 8000, label = '条件'} = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return
    await sleep(120)
  }
  throw new Error(`等待超时：${label}`)
}

/** 从页面读出索引的完整状态 */
const SNAPSHOT = `JSON.stringify({
  cards: [...document.querySelectorAll('#game-grid .game-card')].map((card) => ({
    title: card.querySelector('h3')?.textContent?.trim() || '',
    href: card.getAttribute('href') || '',
    external: card.getAttribute('target') === '_blank',
    rel: card.getAttribute('rel') || '',
    badge: card.querySelector('.game-badge')?.textContent || '',
    meta: [...card.querySelectorAll('.game-meta > span')].map((node) => node.textContent.trim()),
    enter: card.querySelector('.game-enter')?.textContent?.trim() || ''
  })),
  tags: [...document.querySelectorAll('#game-tags .tag-chip')].map((chip) => chip.textContent.trim()),
  count: document.getElementById('game-count')?.textContent?.trim() || '',
  emptyVisible: !document.getElementById('game-empty')?.hidden,
  errorVisible: !document.getElementById('game-error')?.hidden,
  searchValue: document.getElementById('game-search')?.value ?? null,
  url: location.search
})`

const typeSearch = (cdp, value) => cdp.evaluate(`(() => {
  const input = document.getElementById('game-search')
  input.value = ${JSON.stringify(value)}
  input.dispatchEvent(new Event('input', {bubbles: true}))
})()`)

const clickTag = (cdp, label) => cdp.evaluate(`(() => {
  const chip = [...document.querySelectorAll('#game-tags .tag-chip')]
    .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}))
  if (!chip) throw new Error('找不到标签：' + ${JSON.stringify(label)})
  chip.click()
})()`)

async function screenshot(cdp, name, {width, height}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 500})
  await sleep(250)
  const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'})
  mkdirSync(SHOT_DIR, {recursive: true})
  const file = join(SHOT_DIR, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

const checks = []
const check = (name, condition, detail = '') => {
  checks.push({name, ok: Boolean(condition), detail})
  console.log(`${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : ` — ${detail}`}`)
}

async function main() {
  const server = startServer()
  let browser = null
  try {
    await waitForServer()
    browser = await launchBrowser('index', 9333)
    const {cdp} = browser

    await cdp.send('Page.navigate', {url: `${BASE}/`})
    await waitFor(cdp, `document.querySelectorAll('#game-grid .game-card').length > 0`, {label: '卡片渲染'})
    let state = JSON.parse(await cdp.evaluate(SNAPSHOT))

    check('首页从 games.json 渲染出卡片', state.cards.length >= 1, `实际 ${state.cards.length} 张`)
    check('五子棋卡片存在且指向站内', state.cards.some((card) => card.title.startsWith('五子棋') && card.href === 'games/gomoku/'))
    check('可联机徽标渲染', state.cards.some((card) => card.badge === '可联机'))
    const internalCards = state.cards.filter((card) => !/^https?:/i.test(card.href))
    const externalCards = state.cards.filter((card) => /^https?:/i.test(card.href))
    check('站内卡片在当前页打开', internalCards.length > 0 && internalCards.every((card) => !card.external), JSON.stringify(internalCards.map((c) => [c.title, c.external])))
    check('外链卡片新开标签页并带 noopener', externalCards.length > 0 && externalCards.every((card) => card.external && card.rel.includes('noopener')), JSON.stringify(externalCards.map((c) => [c.title, c.external, c.rel])))
    check('外链卡片文案是「前往 ↗」', externalCards.every((card) => card.enter === '前往 ↗'), externalCards.map((c) => c.enter).join(','))
    check('计入数量文案', /^共 \d+ 款$/.test(state.count), state.count)
    check('标签栏有「全部」+ 数据标签', state.tags[0] === '全部' && state.tags.length > 1, state.tags.join(' / '))
    check('初始不显示空态', !state.emptyVisible)
    check('初始不显示错误', !state.errorVisible)

    // 搜索：命中
    await typeSearch(cdp, '五子')
    await sleep(150)
    state = JSON.parse(await cdp.evaluate(SNAPSHOT))
    check('搜索「五子」命中五子棋', state.cards.length === 1 && state.cards[0].title.startsWith('五子棋'), state.cards.map((c) => c.title).join(','))
    check('搜索词写进 URL', state.url.includes('q='), state.url)

    // 搜索：不命中 → 空态
    await typeSearch(cdp, '这个游戏不存在')
    await sleep(150)
    state = JSON.parse(await cdp.evaluate(SNAPSHOT))
    check('搜不到时显示空态', state.cards.length === 0 && state.emptyVisible)
    check('空态时数量归零', state.count === '共 0 款', state.count)

    // 标签筛选
    await typeSearch(cdp, '')
    await sleep(120)
    await clickTag(cdp, '棋类')
    await sleep(150)
    state = JSON.parse(await cdp.evaluate(SNAPSHOT))
    check('点「棋类」标签后只剩棋类', state.cards.length >= 1 && state.cards.every((card) => card.meta.includes('棋类')), state.cards.map((c) => c.title).join(','))

    // 再点一次取消
    await clickTag(cdp, '棋类')
    await sleep(150)
    state = JSON.parse(await cdp.evaluate(SNAPSHOT))
    check('再点一次取消筛选', !state.url.includes('tag='), state.url)

    const desktopShot = await screenshot(cdp, 'index-home-1440.png', {width: 1440, height: 1100})
    const mobileShot = await screenshot(cdp, 'index-home-390.png', {width: 390, height: 900})
    console.log(`截图: ${desktopShot}`)
    console.log(`截图: ${mobileShot}`)

    // 老入口不能坏：游戏页还能打开
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false})
    await cdp.send('Page.navigate', {url: `${BASE}/games/gomoku/`})
    await waitFor(cdp, `!!document.querySelector('#board .cell')`, {label: '五子棋棋盘'})
    check('五子棋页面仍可打开', true)

    const errors = cdp.errors()
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '))
  } finally {
    if (browser) await shutdownBrowser(browser)
    server.kill()
  }

  const failed = checks.filter((entry) => !entry.ok)
  if (failed.length) {
    console.error(`\n✗ ${failed.length}/${checks.length} 项失败`)
    process.exit(1)
  }
  console.log(`\n✓ ${checks.length} 项全过`)
}

await main()
