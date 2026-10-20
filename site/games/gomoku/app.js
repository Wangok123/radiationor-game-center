// 联机五子棋：房主权威 + 全量状态同步。
//
// 关键取舍：
// 1. 房主（创建房间的人）的浏览器是唯一裁判，负责落子判定、胜负、座位分配。
// 2. 其他人只发「我想下这里」的动作，等下一次全量快照。
// 3. 桌游状态很小（225 格数组），全量同步比增量同步省心得多。
//
// 联机传输、诊断面板、入口表单都在 ../../assets/ 下的共用模块里，
// 以后加新游戏只需要替换本文件里的「游戏规则 + 渲染」部分。

import {EMPTY, BLACK, WHITE, createBoard, applyMove, other, SIZE} from './rules.js'
import {cleanName, normalizeCode, randomCode, copyText, timeLabel, readStore, writeStore} from '../../assets/util.js'
import {joinTransport, relaySockets, BUILD, STRATEGIES, DEFAULT_STRATEGY} from '../../assets/room.js'
import {renderStrategyPicker, readRelayUrls, readTurnServers} from '../../assets/room-ui.js'
import {mountDiagnostics} from '../../assets/diag.js'

const STORAGE = {
  name: 'rogc:name',
  strategy: 'rogc:strategy',
  relay: 'rogc:relay',
  turn: 'rogc:turn'
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
  strategyFieldset: document.getElementById('strategy-fieldset'),
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
  diagMount: document.getElementById('diagnostics-mount'),
  browserNotice: document.getElementById('browser-notice'),
  connectHint: document.getElementById('connect-hint'),
  buildText: document.getElementById('build-text')
}

const app = {
  role: null, // 'host' | 'guest'
  roomId: null,
  strategyId: DEFAULT_STRATEGY,
  name: '',
  room: null,
  module: null,
  selfId: null,
  hostId: null,
  diag: null,
  // 房主私有状态
  game: null,
  spectators: new Map(),
  log: [],
  // 渲染用的统一快照（房主本地生成，客户端从网络收到）
  view: null,
  // 运行期信息
  lastSnapshotAt: 0,
  joinRetryTimer: null,
  hintTimer: null,
  busy: false,
  stopped: false,
  // 连接失败/信令错误，展示在诊断面板里
  errors: [],
  turnServers: null,
  joinedAt: 0
}

let sendCmd = () => Promise.resolve()
let sendSnap = () => Promise.resolve()
let getStrategyId = () => DEFAULT_STRATEGY

// ---------------------------------------------------------------- 入口表单

function recordError(text) {
  const line = `${timeLabel()} ${text}`
  app.errors.push(line)
  if (app.errors.length > 10) app.errors.shift()
  console.warn('[联机]', text)
  if (app.role === 'host') hostLog(`连接失败：${text}`)
}

/** 定时更新「连不上」的原因提示：中继没连上 / 还没发现对方。 */
function updateConnectHint() {
  if (!els.connectHint || !app.room) return
  const sockets = Object.values(relaySockets(app.module))
  const relaysUp = sockets.filter((socket) => socket.readyState === 1).length
  const peers = Object.keys(app.room.getPeers()).length
  const waited = Date.now() - app.joinedAt
  let message = ''

  if (app.stopped) {
    message = ''
  } else if (app.role === 'host' && relaysUp === 0) {
    message = `信令中继一个都没连上（0/${sockets.length || 4}），朋友找不到你。检查网络，或换一个中继（Nostr / BitTorrent）重开房间。`
  } else if (app.role !== 'host' && relaysUp === 0) {
    message = `信令中继一个都没连上（0/${sockets.length || 4}），收不到房主的房间信息。检查网络，或换一个中继再进。`
  } else if (app.role !== 'host' && !app.hostId && peers === 0 && waited > 10000) {
    message = '还没收到房主的任何消息：确认房主页面还开着、两端版本号一致；如果两边的「网络自检」只有 host，就需要配 TURN。'
  } else if (app.role === 'host' && peers === 0 && waited > 10000) {
    message = '中继已连上，但还没人加入。确认朋友用的是同一个房间号或邀请链接（房间号区分大小写之外无特殊字符）。'
  }

  els.connectHint.textContent = message
  els.connectHint.hidden = !message
}

function startConnectHint() {
  app.joinedAt = Date.now()
  clearInterval(app.hintTimer)
  app.hintTimer = setInterval(updateConnectHint, 2000)
}

/** 微信内置浏览器 / 不支持 WebRTC 时给一句明确提示。 */
function checkBrowser() {
  if (!els.browserNotice) return
  const inWeChat = /MicroMessenger/i.test(navigator.userAgent)
  let message = ''
  if (typeof RTCPeerConnection === 'undefined') {
    message = '当前浏览器不支持 WebRTC，无法联机。请换用系统浏览器（Chrome / Edge / Safari）打开。'
  } else if (inWeChat) {
    message = '你在微信内置浏览器里，部分机型会限制 WebRTC。如果一直连不上，点右上角「…」→「在浏览器打开」。'
  }
  if (!message) return
  els.browserNotice.textContent = message
  els.browserNotice.hidden = false
}

function setEntryStatus(text, isError = false) {
  els.entryStatus.textContent = text
  els.entryStatus.classList.toggle('is-error', isError)
}

function savePrefs() {
  writeStore(STORAGE.name, app.name || els.nameInput.value || '')
  writeStore(STORAGE.strategy, app.strategyId || getStrategyId())
  writeStore(STORAGE.relay, els.relayUrls.value)
  writeStore(STORAGE.turn, [els.turnUrl.value, els.turnUser.value, els.turnCred.value].join('\n'))
}

function loadPrefs() {
  const savedName = readStore(STORAGE.name)
  if (savedName) els.nameInput.value = savedName
  els.relayUrls.value = readStore(STORAGE.relay)
  const [url = '', user = '', cred = ''] = readStore(STORAGE.turn).split('\n')
  els.turnUrl.value = url
  els.turnUser.value = user
  els.turnCred.value = cred
}

/** 从 URL 与本地存储里决定默认的信令策略。 */
function initialStrategy() {
  const fromUrl = new URLSearchParams(location.search).get('relay')
  if (fromUrl && STRATEGIES[fromUrl]) return fromUrl
  const saved = readStore(STORAGE.strategy)
  return STRATEGIES[saved] ? saved : DEFAULT_STRATEGY
}

// ---------------------------------------------------------------- 棋盘渲染

function initBoard() {
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.dataset.index = String(i)
    cell.setAttribute('role', 'gridcell')
    cell.setAttribute('aria-label', `${Math.floor(i / SIZE) + 1} 行 ${i % SIZE + 1} 列`)
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
  const strategyLabel = STRATEGIES[app.strategyId]?.label || '—'

  els.roomCode.textContent = app.roomId || '—'
  els.roleText.textContent = app.role === 'host'
    ? '房主 / 黑棋'
    : seat === BLACK ? '玩家 / 黑棋' : seat === WHITE ? '玩家 / 白棋' : '观战'

  const anyOpen = Object.values(app.module?.getRelaySockets?.() || {}).some((socket) => socket.readyState === 1)
  els.netText.textContent = `${strategyLabel} · ${peers + 1} 人在线`
  els.netDot.dataset.state = app.stopped ? 'bad' : anyOpen ? 'open' : peers > 0 || app.role === 'host' ? 'busy' : 'idle'

  paintBoard(game)
  els.board.classList.toggle('is-myturn', isMyTurn())
  renderStatus(view, seat)
  renderPlayers(view)
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
    text = seat === game.winner
      ? `五子连珠，你赢了 ${mine}`
      : `${seatName(view, game.winner)} 连成五子，获胜。`
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

function renderPlayers(view) {
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
    const label = document.createElement('span')
    label.textContent = `${spectators.length} 人观战：${spectators.map((s) => s.name).join('、')}`
    const tag = document.createElement('span')
    tag.className = 'seat-tag'
    tag.textContent = '观战'
    li.append(label, tag)
    rows.push(li)
  }
  els.playerList.replaceChildren(...rows)
}

function renderLog(view) {
  // 最新的排最上面；view.log 是快照的一部分，不要原地 reverse
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
  app.log.push(`${timeLabel()} ${text}`)
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
    if (!changed) return
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
  } else if (peerId === app.hostId) {
    app.stopped = true
    render()
  }
}

function onCmdMessage(data, context) {
  if (app.role !== 'host') {
    if (data && data.t === 'who' && app.role === 'guest') sendCmd({t: 'join', name: app.name})
    return
  }
  if (!data || typeof data !== 'object') return
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
    app.strategyId = getStrategyId()
    app.role = role
    app.roomId = code
    app.stopped = false
    savePrefs()

    setEntryStatus(`正在加载 ${STRATEGIES[app.strategyId].label} 联机模块…`)
    app.turnServers = readTurnServers({url: els.turnUrl, username: els.turnUser, credential: els.turnCred})
    app.errors = []
    let transport
    try {
      transport = await joinTransport({
        strategyId: app.strategyId,
        roomId: code,
        relayUrls: readRelayUrls(els.relayUrls),
        turnServers: app.turnServers,
        onJoinError: (details) => recordError(details?.error || '与对端建立连接失败')
      })
    } catch (error) {
      console.error(error)
      setEntryStatus('联机模块加载失败，刷新页面再试。', true)
      app.role = null
      return
    }

    app.room = transport.room
    app.module = transport.module
    app.selfId = transport.selfId

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
    startConnectHint()
    app.diag = mountDiagnostics(els.diagMount, {
      getRoom: () => app.room,
      getModule: () => app.module,
      getStrategyId: () => app.strategyId,
      getRole: () => app.role,
      getRoomId: () => app.roomId,
      getSelfId: () => app.selfId,
      getHostId: () => app.hostId,
      getTurnServers: () => app.turnServers,
      getErrors: () => app.errors
    })
    setEntryStatus('')
  } finally {
    app.busy = false
  }
}

function leaveRoom() {
  stopJoinRetry()
  clearInterval(app.hintTimer)
  app.diag?.stop()
  app.diag = null
  try {
    app.room?.leave()
  } catch {
    /* 已经断开就忽略 */
  }
  // trystero 的房间实例不建议复用，直接刷新回到干净状态
  location.href = location.pathname
}

function showRoom() {
  document.body.classList.add('in-room')
  els.entryPanel.hidden = true
  els.roomPanel.hidden = false
  els.chatInput.value = ''
  els.copyLinkBtn.hidden = app.role !== 'host'
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
  return `${base}?room=${encodeURIComponent(app.roomId || '')}&relay=${app.strategyId}`
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

  els.nameInput.addEventListener('change', () => savePrefs())
}

function boot() {
  initBoard()
  checkBrowser()
  if (els.buildText) els.buildText.textContent = BUILD
  getStrategyId = renderStrategyPicker(els.strategyFieldset, {selectedId: initialStrategy()})
  loadPrefs()
  bindEvents()

  // 排查用：带 ?debug 打开时把运行期状态挂到 window
  if (new URLSearchParams(location.search).has('debug')) {
    Object.defineProperty(window, '__game', {get: () => app})
  }

  const room = normalizeCode(new URLSearchParams(location.search).get('room') || '')
  if (!room) return
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

boot()
