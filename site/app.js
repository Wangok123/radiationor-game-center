// 联机五子棋：房间 + 房主权威 + 全量状态同步。
//
// 关键取舍：
// 1. 房主（创建房间的人）的浏览器是唯一裁判，负责落子判定、胜负、座位分配。
// 2. 其他人只发「我想下这里」的动作，等下一次全量快照。
// 3. 桌游状态很小（225 格数组），全量同步比增量同步省心得多。
// 4. 房间号相同的人通过公共中继互相发现，之后棋盘数据走 WebRTC 直连。

import {EMPTY, BLACK, WHITE, createBoard, applyMove, other, SIZE} from './gomoku.js'

const APP_ID = 'lin-gomoku-v1'

const STRATEGIES = {
  mqtt: {label: 'MQTT', file: './vendor/mqtt.js'},
  nostr: {label: 'Nostr', file: './vendor/nostr.js'},
  torrent: {label: 'BitTorrent', file: './vendor/torrent.js'}
}

const STORAGE = {
  name: 'lin-gomoku:name',
  strategy: 'lin-gomoku:strategy',
  relay: 'lin-gomoku:relay',
  turn: 'lin-gomoku:turn'
}

const STAR_POINTS = new Set([
  [3, 3], [3, 11], [11, 3], [11, 11], [7, 7]
].map(([x, y]) => y * SIZE + x))

const LOG_LIMIT = 40

const els = {
  entryPanel: document.getElementById('entry-panel'),
  roomPanel: document.getElementById('room-panel'),
  nameInput: document.getElementById('name-input'),
  codeInput: document.getElementById('code-input'),
  relayUrls: document.getElementById('relay-urls'),
  turnUrl: document.getElementById('turn-url'),
  turnUser: document.getElementById('turn-user'),
  turnCred: document.getElementById('turn-cred'),
  createBtn: document.getElementById('create-btn'),
  joinBtn: document.getElementById('join-btn'),
  entryStatus: document.getElementById('entry-status'),
  roomCode: document.getElementById('room-code'),
  roleText: document.getElementById('role-text'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  netDot: document.getElementById('net-dot'),
  netText: document.getElementById('net-text'),
  board: document.getElementById('board'),
  gameStatus: document.getElementById('game-status'),
  restartBtn: document.getElementById('restart-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  playerList: document.getElementById('player-list'),
  logList: document.getElementById('log-list'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  diagnostics: document.getElementById('diagnostics'),
  diagBody: document.getElementById('diag-body'),
  pingBtn: document.getElementById('ping-btn'),
  iceBtn: document.getElementById('ice-btn'),
  copyDiagBtn: document.getElementById('copy-diag-btn')
}

const app = {
  role: null, // 'host' | 'guest'
  roomId: null,
  strategy: 'mqtt',
  name: '',
  net: null,
  room: null,
  selfId: null,
  hostId: null,
  // 房主私有状态
  game: null,
  spectators: new Map(),
  log: [],
  // 渲染用的统一快照（房主本地生成，客户端从网络收到）
  view: null,
  // 运行期信息
  lastSnapshotAt: 0,
  joinRetryTimer: null,
  diagTimer: null,
  iceResult: null,
  pingResult: null,
  busy: false,
  stopped: false
}

let sendCmd = () => Promise.resolve()
let sendSnap = () => Promise.resolve()

// ---------------------------------------------------------------- 工具函数

const shortId = (id) => (id ? String(id).slice(0, 6) : '—')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 12)
  return name || '无名玩家'
}

function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

function randomCode(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < length; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
  return code
}

function setEntryStatus(text, isError = false) {
  els.entryStatus.textContent = text
  els.entryStatus.classList.toggle('is-error', isError)
}

function selectedStrategy() {
  const checked = document.querySelector('input[name="strategy"]:checked')
  return checked && checked.value in STRATEGIES ? checked.value : 'mqtt'
}

function readRelayUrls() {
  return els.relayUrls.value.split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

function readTurnServers() {
  const url = els.turnUrl.value.trim()
  if (!url) return null
  const server = {urls: url}
  if (els.turnUser.value.trim()) server.username = els.turnUser.value.trim()
  if (els.turnCred.value) server.credential = els.turnCred.value
  return [server]
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE.name, app.name || '')
    localStorage.setItem(STORAGE.strategy, app.strategy)
    localStorage.setItem(STORAGE.relay, els.relayUrls.value)
    localStorage.setItem(STORAGE.turn, [els.turnUrl.value, els.turnUser.value, els.turnCred.value].join('\n'))
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

function loadPrefs() {
  try {
    const savedName = localStorage.getItem(STORAGE.name) || ''
    if (savedName) els.nameInput.value = savedName
    const savedStrategy = localStorage.getItem(STORAGE.strategy)
    if (savedStrategy && savedStrategy in STRATEGIES) {
      const radio = document.querySelector(`input[name="strategy"][value="${savedStrategy}"]`)
      if (radio) radio.checked = true
    }
    els.relayUrls.value = localStorage.getItem(STORAGE.relay) || ''
    const [url = '', user = '', cred = ''] = (localStorage.getItem(STORAGE.turn) || '').split('\n')
    els.turnUrl.value = url
    els.turnUser.value = user
    els.turnCred.value = cred
  } catch {
    /* 读不到就用默认值 */
  }
}

// ---------------------------------------------------------------- 棋盘渲染

function initBoard() {
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.dataset.index = String(i)
    const {x, y} = {x: i % SIZE, y: Math.floor(i / SIZE)}
    cell.setAttribute('role', 'gridcell')
    cell.setAttribute('aria-label', `${y + 1} 行 ${x + 1} 列`)
    if (STAR_POINTS.has(i)) cell.classList.add('star')
    fragment.append(cell)
  }
  els.board.append(fragment)
  els.board.addEventListener('click', (event) => {
    const cell = event.target.closest('.cell')
    if (cell) onCellClick(Number(cell.dataset.index))
  })
}

function paintBoard(game) {
  const cells = els.board.children
  const winSet = new Set(game.winLine || [])
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const value = game.board[i]
    const taken = value !== EMPTY
    cell.classList.toggle('taken', taken)
    cell.classList.toggle('last', i === game.lastMove)
    cell.classList.toggle('win', winSet.has(i))
    const existing = cell.firstElementChild
    if (taken) {
      const wantClass = value === BLACK ? 'stone black' : 'stone white'
      if (!existing) {
        const stone = document.createElement('span')
        stone.className = wantClass
        cell.append(stone)
      } else if (existing.className !== wantClass) {
        existing.className = wantClass
      }
    } else if (existing) {
      existing.remove()
    }
  }
}

function mySeat() {
  if (!app.view) return 0
  const me = app.view.roster.find((row) => row.peerId && row.peerId === app.selfId)
  return me ? me.seat : 0
}

const seatName = (view, seat) => {
  const row = view.roster.find((entry) => entry.seat === seat)
  return row ? row.name : '空位'
}

function isMyTurn() {
  if (!app.view || app.view.game.status !== 'playing') return false
  const seat = mySeat()
  return Boolean(seat) && app.view.game.turn === seat
}

// ---------------------------------------------------------------- 渲染

function render() {
  const view = app.view
  if (!view) return
  const {game} = view
  const seat = mySeat()
  const peers = app.room ? Object.keys(app.room.getPeers()).length : 0

  els.roomCode.textContent = app.roomId || '—'
  els.roleText.textContent = app.role === 'host'
    ? '房主 / 黑棋'
    : seat === BLACK ? '玩家 / 黑棋' : seat === WHITE ? '玩家 / 白棋' : '观战'

  const total = peers + 1
  els.netText.textContent = `${STRATEGIES[app.strategy].label} · ${total} 人在线`
  const anyOpen = app.net && Object.values(app.net.getRelaySockets?.() || {}).some((socket) => socket.readyState === 1)
  els.netDot.dataset.state = app.stopped ? 'bad' : anyOpen ? 'open' : total > 1 || app.role === 'host' ? 'busy' : 'idle'

  paintBoard(game)
  els.board.classList.toggle('is-myturn', isMyTurn())
  renderStatus(view, seat)
  renderPlayers(view, seat)
  renderLog(view)
}

function renderStatus(view, seat) {
  const {game} = view
  const mine = seat ? `（你执${seat === BLACK ? '黑' : '白'}）` : '（观战中）'
  let text = ''
  let warn = false

  if (app.stopped) {
    text = '房主已经离开，这一局结束了。'
    warn = true
  } else if (game.status === 'waiting') {
    text = `等待对手加入…把房间号 ${app.roomId} 或邀请链接发给朋友。`
  } else if (game.status === 'paused') {
    text = '有人掉线，对局暂停；等他刷新回来会恢复座位。'
    warn = true
  } else if (game.status === 'won') {
    const winner = seatName(view, game.winner)
    text = seat === game.winner ? `五子连珠，你赢了 ${mine}` : `${winner} 连成五子，获胜。`
  } else if (game.status === 'draw') {
    text = '棋盘下满，和棋。'
  } else if (isMyTurn()) {
    text = `轮到你落子 ${mine}`
  } else {
    text = `等 ${seatName(view, game.turn)} 落子… ${mine}`
  }

  els.gameStatus.textContent = text
  els.gameStatus.classList.toggle('is-warn', warn)
}

function renderPlayers(view, seat) {
  const rows = []
  for (const color of [BLACK, WHITE]) {
    const row = view.roster.find((entry) => entry.seat === color)
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = `stone-dot ${color === BLACK ? 'black' : 'white'}`
    const label = document.createElement('span')
    label.textContent = row ? row.name : '空位'
    if (row && row.peerId === app.selfId) label.className = 'me'
    if (row && !row.peerId) label.classList.add('offline')
    const tag = document.createElement('span')
    tag.className = 'seat-tag'
    tag.textContent = row && !row.peerId ? '掉线' : color === BLACK ? '黑' : '白'
    li.append(dot, label, tag)
    rows.push(li)
  }
  const spectators = view.roster.filter((entry) => entry.seat === 0)
  if (spectators.length) {
    const li = document.createElement('li')
    const tag = document.createElement('span')
    tag.className = 'seat-tag'
    tag.textContent = '观战'
    const label = document.createElement('span')
    label.textContent = `${spectators.length} 人：${spectators.map((s) => s.name).join('、')}`
    li.append(label, tag)
    rows.push(li)
  }
  els.playerList.replaceChildren(...rows)
  void seat
}

function renderLog(view) {
  // 最新的排在最上面；注意不要原地 reverse，view.log 是快照的一部分
  const items = (view.log || []).slice().reverse().map((line) => {
    const li = document.createElement('li')
    li.textContent = line
    return li
  })
  els.logList.replaceChildren(...items)
}

// ---------------------------------------------------------------- 房主逻辑

function newGame() {
  return {
    seq: 1,
    board: createBoard(),
    turn: BLACK,
    status: 'waiting',
    winner: 0,
    winLine: null,
    lastMove: -1,
    seats: {[BLACK]: null, [WHITE]: null}
  }
}

function hostLog(text) {
  const time = new Date().toLocaleTimeString('zh-CN', {hour12: false}).slice(0, 5)
  app.log.push(`${time} ${text}`)
  if (app.log.length > LOG_LIMIT) app.log.splice(0, app.log.length - LOG_LIMIT)
}

function recomputeStatus() {
  const game = app.game
  if (game.status === 'won' || game.status === 'draw') return
  const blackOnline = Boolean(game.seats[BLACK]?.peerId)
  const whiteOnline = Boolean(game.seats[WHITE]?.peerId)
  const hasStones = game.board.some((cell) => cell !== EMPTY)
  if (blackOnline && whiteOnline) game.status = 'playing'
  else if (hasStones) game.status = 'paused'
  else game.status = 'waiting'
}

function hostView() {
  const roster = []
  for (const seat of [BLACK, WHITE]) {
    const entry = app.game.seats[seat]
    if (entry) roster.push({peerId: entry.peerId || null, name: entry.name, seat, online: Boolean(entry.peerId)})
  }
  for (const [peerId, name] of app.spectators) roster.push({peerId, name, seat: 0, online: true})
  return {hostId: app.selfId, game: app.game, roster, log: app.log.slice(-LOG_LIMIT)}
}

function hostBroadcast() {
  if (app.role !== 'host') return
  app.view = hostView()
  render()
  sendSnap(app.view)
}

function seatForPeer(peerId) {
  for (const seat of [BLACK, WHITE]) {
    const entry = app.game.seats[seat]
    if (entry && entry.peerId === peerId) return seat
  }
  return 0
}

function hostSeatPeer(peerId, rawName) {
  const name = cleanName(rawName)
  if (peerId === app.selfId) return
  // 已经在座位上的人重复发 join（例如收到 who 又问一次），不要重复登记
  if (seatForPeer(peerId)) return
  // 同名的掉线座位优先还给本人（刷新页面后 peerId 会变）
  for (const seat of [BLACK, WHITE]) {
    const entry = app.game.seats[seat]
    if (entry && !entry.peerId && entry.name === name) {
      entry.peerId = peerId
      app.spectators.delete(peerId)
      hostLog(`${name} 回到${seat === BLACK ? '黑' : '白'}棋座位`)
      recomputeStatus()
      hostBroadcast()
      return
    }
  }
  if (!app.game.seats[WHITE] || (!app.game.seats[WHITE].peerId && app.game.seats[WHITE].name === name)) {
    app.game.seats[WHITE] = {peerId, name}
    app.spectators.delete(peerId)
    hostLog(`${name} 坐到白棋`)
    recomputeStatus()
    hostBroadcast()
    return
  }
  if (app.spectators.get(peerId) !== name) {
    app.spectators.set(peerId, name)
    hostLog(`${name} 加入观战`)
    hostBroadcast()
  }
}

function hostApplyMove(index) {
  const game = app.game
  if (game.status !== 'playing') return
  if (!Number.isInteger(index) || index < 0 || index >= game.board.length) return
  if (game.board[index] !== EMPTY) return
  const seat = game.turn
  const result = applyMove(game.board, index, seat)
  game.board = result.board
  game.winLine = result.winLine
  game.lastMove = result.lastMove
  game.seq += 1
  if (result.winLine) {
    game.status = 'won'
    game.winner = seat
    hostLog(`${seatName(hostView(), seat)} 五子连珠，获胜`)
  } else if (result.draw) {
    game.status = 'draw'
    hostLog('棋盘下满，和棋')
  } else {
    game.turn = other(seat)
  }
  hostBroadcast()
}

function hostHandleMove(peerId, index) {
  const seat = seatForPeer(peerId)
  if (!seat) return
  if (app.game.status !== 'playing' || app.game.turn !== seat) return
  hostApplyMove(index)
}

function hostHandleChat(peerId, text) {
  const clean = String(text ?? '').trim().slice(0, 80)
  if (!clean) return
  const seat = seatForPeer(peerId)
  const name = seat ? app.game.seats[seat].name : app.spectators.get(peerId) || '某人'
  hostLog(`${name}：${clean}`)
  hostBroadcast()
}

function hostRestart() {
  const seats = app.game.seats
  app.game = newGame()
  app.game.seats = seats
  app.game.seq += 1
  recomputeStatus()
  hostLog('重新开始一局')
  hostBroadcast()
}

// ---------------------------------------------------------------- 网络层

function onPeerJoin(peerId) {
  if (app.role === 'host') {
    sendCmd({t: 'who'}, {target: peerId})
    hostBroadcast()
  } else {
    sendCmd({t: 'join', name: app.name})
  }
}

function onPeerLeave(peerId) {
  if (app.role === 'host') {
    app.spectators.delete(peerId)
    let changed = false
    for (const seat of [BLACK, WHITE]) {
      const entry = app.game.seats[seat]
      if (entry && entry.peerId === peerId) {
        entry.peerId = null
        hostLog(`${entry.name} 掉线了`)
        changed = true
      }
    }
    if (changed) {
      // 刷新重连的常见时序：新 peer 先到（只能当观战），旧 peer 后掉线。
      // 这里把同名观战者补回空出来的座位。
      for (const seat of [BLACK, WHITE]) {
        const entry = app.game.seats[seat]
        if (!entry || entry.peerId) continue
        for (const [candidateId, candidateName] of app.spectators) {
          if (candidateName !== entry.name) continue
          entry.peerId = candidateId
          app.spectators.delete(candidateId)
          hostLog(`${candidateName} 回到${seat === BLACK ? '黑' : '白'}棋座位`)
          break
        }
      }
      recomputeStatus()
      hostBroadcast()
    }
  } else if (peerId === app.hostId) {
    app.stopped = true
    render()
  }
}

function onCmdMessage(data, context) {
  if (!data || typeof data !== 'object' || app.role !== 'host') {
    if (data && data.t === 'who' && app.role === 'guest') sendCmd({t: 'join', name: app.name})
    return
  }
  const peerId = context.peerId
  switch (data.t) {
    case 'join': hostSeatPeer(peerId, data.name); break
    case 'move': hostHandleMove(peerId, data.i); break
    case 'chat': hostHandleChat(peerId, data.text); break
    case 'restart': hostRestart(); break
    case 'sync': hostBroadcast(); break
    default: break
  }
}

function onSnapMessage(data) {
  if (app.role !== 'guest' || !data || !data.game) return
  app.view = data
  app.hostId = data.hostId
  app.lastSnapshotAt = Date.now()
  app.stopped = false
  if (data.roster.some((row) => row.peerId === app.selfId)) stopJoinRetry()
  render()
}

function stopJoinRetry() {
  if (app.joinRetryTimer) {
    clearInterval(app.joinRetryTimer)
    app.joinRetryTimer = null
  }
}

function startJoinRetry() {
  stopJoinRetry()
  app.joinRetryTimer = setInterval(() => {
    if (app.stopped || !app.room) return
    if (Date.now() - app.lastSnapshotAt > 5000) sendCmd({t: 'join', name: app.name})
  }, 2500)
}

async function startRoom(role, code) {
  if (app.busy) return
  app.busy = true
  try {
    app.name = cleanName(els.nameInput.value)
    app.strategy = selectedStrategy()
    app.role = role
    app.roomId = code
    app.stopped = false
    savePrefs()

    setEntryStatus(`正在加载 ${STRATEGIES[app.strategy].label} 联机模块…`)
    let net
    try {
      net = await import(STRATEGIES[app.strategy].file)
    } catch (error) {
      console.error(error)
      setEntryStatus('联机模块加载失败，刷新页面再试。', true)
      app.role = null
      return
    }
    app.net = net
    app.selfId = net.selfId

    const config = {appId: APP_ID}
    const relayUrls = readRelayUrls()
    if (relayUrls.length) config.relayConfig = {urls: relayUrls}
    const turnServers = readTurnServers()
    if (turnServers) config.turnConfig = turnServers

    setEntryStatus('正在连接信令中继…')
    try {
      app.room = net.joinRoom(config, code)
    } catch (error) {
      console.error(error)
      setEntryStatus(`加入房间失败：${error.message || error}`, true)
      app.role = null
      return
    }

    const cmd = app.room.makeAction('cmd')
    const snap = app.room.makeAction('snap')
    sendCmd = cmd.send
    sendSnap = snap.send
    cmd.onMessage = onCmdMessage
    snap.onMessage = onSnapMessage

    app.room.onPeerJoin = onPeerJoin
    app.room.onPeerLeave = onPeerLeave

    if (role === 'host') {
      app.game = newGame()
      app.game.seats[BLACK] = {peerId: app.selfId, name: app.name}
      app.spectators = new Map()
      app.log = []
      hostLog('房间已创建，等待对手…')
      app.view = hostView()
    } else {
      app.lastSnapshotAt = 0
      app.hostId = null
      sendCmd({t: 'join', name: app.name})
      startJoinRetry()
    }

    showRoom()
    render()
    startDiagLoop()
    setEntryStatus('')
  } finally {
    app.busy = false
  }
}

function leaveRoom() {
  stopJoinRetry()
  clearInterval(app.diagTimer)
  try {
    app.room?.leave()
  } catch {
    /* 已经断开就忽略 */
  }
  // trystero 的房间实例不建议复用，直接刷新页面回到干净状态
  location.href = location.pathname
}

function showRoom() {
  els.entryPanel.hidden = true
  els.roomPanel.hidden = false
  els.chatInput.value = ''
  if (app.role === 'host') {
    els.copyLinkBtn.hidden = false
  } else {
    els.copyLinkBtn.hidden = true
  }
}

// ---------------------------------------------------------------- 交互

function onCellClick(index) {
  if (app.stopped || !app.view) return
  const game = app.view.game
  if (game.status !== 'playing' || game.board[index] !== EMPTY) return
  const seat = mySeat()
  if (!seat || game.turn !== seat) return
  if (app.role === 'host') hostApplyMove(index)
  else sendCmd({t: 'move', i: index})
}

function inviteUrl() {
  const base = `${location.origin}${location.pathname.replace(/index\.html$/, '')}`
  return `${base}?room=${encodeURIComponent(app.roomId || '')}&relay=${app.strategy}`
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.append(helper)
    helper.select()
    const ok = document.execCommand('copy')
    helper.remove()
    return ok
  }
}

// ---------------------------------------------------------------- 诊断

function describeSocket(socket) {
  const state = ['未连接', '已连接', '连接中', '重连中', '已关闭'][socket?.readyState ?? 3] || '未知'
  return state
}

function renderDiagnostics() {
  if (!app.room || !app.net) return
  const sockets = app.net.getRelaySockets?.() || {}
  const peers = app.room.getPeers()
  const peerIds = Object.keys(peers)
  const relayRows = Object.entries(sockets).map(([url, socket]) => {
    const state = describeSocket(socket)
    const cls = socket?.readyState === 1 ? 'ok' : 'bad'
    return `<tr><td>${escapeHtml(url)}</td><td class="${cls}">${state}</td></tr>`
  }).join('') || '<tr><td colspan="2">还没有建立中继连接</td></tr>'

  const peerRows = peerIds.map((peerId) => {
    const pc = peers[peerId]
    const ping = app.pingResult?.[peerId]
    const ice = app.iceResult?.[peerId]
    const iceText = ice ? `本机 ${formatCandidates(ice.local)} / 对端 ${formatCandidates(ice.remote)}` : '未检测'
    return `<tr>
      <td>${escapeHtml(shortId(peerId))}</td>
      <td class="${pc.connectionState === 'connected' ? 'ok' : 'bad'}">${escapeHtml(pc.connectionState)}</td>
      <td>${escapeHtml(pc.iceConnectionState)}</td>
      <td>${ping === undefined ? '—' : escapeHtml(String(ping))}</td>
      <td>${iceText}</td>
    </tr>`
  }).join('') || '<tr><td colspan="5">还没有连上任何人</td></tr>'

  // 只有双方都凑不出 srflx/prflx/relay 时，才说明只能局域网直连
  const lanOnly = app.iceResult && Object.values(app.iceResult).some((ice) => {
    if (!ice?.local) return false
    const kinds = {...ice.local, ...ice.remote}
    return !kinds.srflx && !kinds.prflx && !kinds.relay
  })

  els.diagBody.innerHTML = `
    <h3>本机</h3>
    <table>
      <tr><th>房间</th><td>${escapeHtml(app.roomId || '')}</td></tr>
      <tr><th>角色</th><td>${app.role === 'host' ? '房主（权威端）' : '客户端'}</td></tr>
      <tr><th>我的 peer</th><td>${escapeHtml(shortId(app.selfId))}</td></tr>
      <tr><th>房主 peer</th><td>${escapeHtml(shortId(app.hostId || app.selfId))}</td></tr>
      <tr><th>信令</th><td>${escapeHtml(STRATEGIES[app.strategy].label)}</td></tr>
    </table>
    <h3>中继连接（信令）</h3>
    <table><tr><th>地址</th><th>状态</th></tr>${relayRows}</table>
    <h3>对端连接</h3>
    <table><tr><th>peer</th><th>连接</th><th>ICE</th><th>延迟 ms</th><th>候选（本机 / 对端）</th></tr>${peerRows}</table>
    ${lanOnly ? '<p class="hint">只收集到 host 候选：双方目前可能只能在同一局域网直连。跨网络时如果连不上，填一个可用的 TURN 再试。</p>' : ''}
  `
}

function formatCandidates(counts) {
  if (!counts) return '—'
  const keys = Object.keys(counts)
  if (!keys.length) return '—'
  return keys.map((key) => `${key}×${counts[key]}`).join(' ')
}

async function runPing() {
  if (!app.room) return
  const result = {}
  await Promise.all(Object.keys(app.room.getPeers()).map(async (peerId) => {
    try {
      result[peerId] = await app.room.ping(peerId)
    } catch {
      result[peerId] = '失败'
    }
  }))
  app.pingResult = result
  renderDiagnostics()
}

async function runIceCheck() {
  if (!app.room) return
  const result = {}
  for (const [peerId, pc] of Object.entries(app.room.getPeers())) {
    const local = {}
    const remote = {}
    try {
      const stats = await pc.getStats()
      stats.forEach((report) => {
        if (report.type === 'local-candidate') local[report.candidateType] = (local[report.candidateType] || 0) + 1
        if (report.type === 'remote-candidate') remote[report.candidateType] = (remote[report.candidateType] || 0) + 1
      })
      result[peerId] = {local, remote}
    } catch (error) {
      result[peerId] = {local: {}, remote: {}, error: String(error)}
    }
  }
  app.iceResult = result
  renderDiagnostics()
}

function diagnosticsText() {
  const sockets = app.net?.getRelaySockets?.() || {}
  const peers = app.room?.getPeers() || {}
  const lines = [
    `房间: ${app.roomId}`,
    `角色: ${app.role === 'host' ? '房主' : '客户端'}`,
    `信令: ${STRATEGIES[app.strategy].label}`,
    `我的 peer: ${app.selfId}`,
    `房主 peer: ${app.hostId || app.selfId}`,
    `UA: ${navigator.userAgent}`,
    '中继:'
  ]
  for (const [url, socket] of Object.entries(sockets)) lines.push(`  ${url} → ${describeSocket(socket)}`)
  lines.push('对端:')
  for (const [peerId, pc] of Object.entries(peers)) {
    const ice = app.iceResult?.[peerId]
    lines.push(`  ${shortId(peerId)} 连接=${pc.connectionState} ICE=${pc.iceConnectionState} 候选=${ice ? `${formatCandidates(ice.local)} / ${formatCandidates(ice.remote)}` : '未检测'}`)
  }
  return lines.join('\n')
}

function startDiagLoop() {
  clearInterval(app.diagTimer)
  app.diagTimer = setInterval(() => {
    if (els.roomPanel.hidden || !app.room) return
    if (!els.diagnostics.open) return
    renderDiagnostics()
  }, 2000)
  renderDiagnostics()
}

// ---------------------------------------------------------------- 启动

function bindEvents() {
  els.createBtn.addEventListener('click', () => {
    const code = normalizeCode(els.codeInput.value) || randomCode()
    els.codeInput.value = code
    startRoom('host', code)
  })

  els.joinBtn.addEventListener('click', () => {
    const code = normalizeCode(els.codeInput.value)
    if (code.length < 3) {
      setEntryStatus('先填房间号，或者让房主把邀请链接发你。', true)
      return
    }
    startRoom('guest', code)
  })

  els.codeInput.addEventListener('input', () => {
    els.codeInput.value = normalizeCode(els.codeInput.value)
  })

  els.copyLinkBtn.addEventListener('click', async () => {
    const ok = await copyText(inviteUrl())
    els.copyLinkBtn.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { els.copyLinkBtn.textContent = '复制邀请链接' }, 1600)
  })

  els.restartBtn.addEventListener('click', () => {
    if (app.role === 'host') hostRestart()
    else sendCmd({t: 'restart'})
  })

  els.leaveBtn.addEventListener('click', leaveRoom)

  els.chatForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = els.chatInput.value.trim().slice(0, 80)
    if (!text) return
    els.chatInput.value = ''
    if (app.role === 'host') {
      hostLog(`我：${text}`)
      hostBroadcast()
    } else {
      sendCmd({t: 'chat', text})
    }
  })

  els.pingBtn.addEventListener('click', runPing)
  els.iceBtn.addEventListener('click', runIceCheck)
  els.copyDiagBtn.addEventListener('click', async () => {
    const ok = await copyText(diagnosticsText())
    els.copyDiagBtn.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { els.copyDiagBtn.textContent = '复制诊断信息' }, 1600)
  })

  els.nameInput.addEventListener('change', () => savePrefs())
}

function boot() {
  initBoard()
  loadPrefs()
  bindEvents()

  // 排查用：带 ?debug 打开时把运行期状态挂到 window，方便在控制台看房间和中继情况
  if (new URLSearchParams(location.search).has('debug')) {
    Object.defineProperty(window, '__linGame', {get: () => app})
  }

  const params = new URLSearchParams(location.search)
  const room = normalizeCode(params.get('room') || '')
  const relay = params.get('relay')
  if (relay && relay in STRATEGIES) {
    const radio = document.querySelector(`input[name="strategy"][value="${relay}"]`)
    if (radio) radio.checked = true
  }
  if (room) {
    els.codeInput.value = room
    const savedName = els.nameInput.value.trim()
    if (savedName) {
      // 邀请链接：有昵称就直接进房间
      startRoom('guest', room)
    } else {
      setEntryStatus('输入昵称后点「加入房间」即可入桌。')
      els.nameInput.focus()
    }
  }
}

boot()
