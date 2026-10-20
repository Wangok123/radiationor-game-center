// 共用的联机传输层：信令策略选择、加入房间、对端与中继信息。
//
// 设计上只负责「怎么连上人」，不含任何游戏规则：
// 游戏自己的房主权威逻辑、状态同步、界面都在各自目录里。
//
// 用法：
//   import {joinTransport, STRATEGIES} from '../../assets/room.js'
//   const transport = await joinTransport({strategyId: 'mqtt', roomId: 'ABCDE'})
//   const room = transport.room
//   const [send, action] = room.makeAction('cmd')  // trystero 原生 API

/** 同一站点下所有游戏共用的网络命名空间。换名字 = 换一张网络。 */
export const APP_ID = 'radiationor-game-center-v1'

/** 站点构建版本：排查「两台设备版本不一致」时对比这个字符串。 */
export const BUILD = 'v5 · 2026-10-20'

/**
 * 默认 STUN 服务器。
 *
 * Trystero 自带的默认值是 stun.l.google.com ×3 + stun.cloudflare.com，
 * 在国内网络里 Google 的几个基本不通，常常只剩 host 候选，跨网络就打不了洞。
 * 下面这些是实测能拿到 srflx 的（前 5 个在国内可用），海外用户则由 cloudflare / google 兜底。
 */
// 只放实测能通的：不通的服务器会让 ICE 收集一直等超时，反而拖慢连接。
const DEFAULT_STUN_URLS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.cdnbye.com:3478',
  'stun:stun.cloudflare.com:3478'
]

/** 把默认 STUN 和用户填的 TURN 合并成 RTCPeerConnection 的 iceServers。 */
export function buildIceServers(turnServers = null) {
  const list = DEFAULT_STUN_URLS.map((urls) => ({urls}))
  for (const server of turnServers || []) list.push(server)
  return list
}

/**
 * 网络自检：用配置里的 STUN/TURN 收集一次 ICE 候选，看能不能拿到 srflx/relay。
 * 只有 host 说明这台设备的网络只能局域网直连，跨网络必须靠可用的 TURN。
 */
export async function probeIce({turnServers = null, timeoutMs = 2500} = {}) {
  if (typeof RTCPeerConnection === 'undefined') return {supported: false, types: {}, ms: 0}
  const started = performance.now()
  const types = {}
  const pc = new RTCPeerConnection({iceServers: buildIceServers(turnServers)})
  try {
    pc.createDataChannel('probe')
    // 监听器必须在 setLocalDescription 之前挂上：本地候选可能同步就收集完了
    let finish
    const gathered = new Promise((resolve) => { finish = resolve })
    const timer = setTimeout(finish, timeoutMs)
    const stop = () => {
      clearTimeout(timer)
      finish()
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') stop()
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        stop()
        return
      }
      const match = /typ (host|srflx|prflx|relay)/.exec(event.candidate.candidate)
      if (!match) return
      types[match[1]] = (types[match[1]] || 0) + 1
      // 拿到 srflx/relay 就说明打洞链路可用，不用再等其余服务器超时
      if (match[1] !== 'host') stop()
    }
    await pc.setLocalDescription(await pc.createOffer())
    if (pc.iceGatheringState === 'complete') stop()
    await gathered
  } catch (error) {
    return {supported: true, types, ms: Math.round(performance.now() - started), error: String(error)}
  } finally {
    pc.close()
  }
  return {supported: true, types, ms: Math.round(performance.now() - started)}
}
/**
 * 三种信令策略，按需动态加载对应的打包产物（见 assets/vendor/）。
 * 信令只用来交换 SDP/ICE，游戏数据始终走 WebRTC 点对点。
 */
export const STRATEGIES = {
  mqtt: {
    id: 'mqtt',
    label: 'MQTT',
    title: 'MQTT（EMQX 公共 broker）',
    note: '国内最容易连通的选项，体量稍大',
    file: './vendor/mqtt.js'
  },
  nostr: {
    id: 'nostr',
    label: 'Nostr',
    title: 'Nostr 中继',
    note: '中继数量最多，部分网络不通',
    file: './vendor/nostr.js'
  },
  torrent: {
    id: 'torrent',
    label: 'BitTorrent',
    title: 'BitTorrent Tracker',
    note: '最轻量，公共 tracker 常被墙',
    file: './vendor/torrent.js'
  }
}

export const DEFAULT_STRATEGY = 'mqtt'

const moduleCache = new Map()

/** 动态加载某个策略的打包产物，同一策略只加载一次。 */
export async function loadStrategy(strategyId) {
  const strategy = STRATEGIES[strategyId]
  if (!strategy) throw new Error(`未知的信令策略: ${strategyId}`)
  if (!moduleCache.has(strategyId)) {
    moduleCache.set(strategyId, import(strategy.file))
  }
  try {
    return {module: await moduleCache.get(strategyId), strategy}
  } catch (error) {
    moduleCache.delete(strategyId)
    throw error
  }
}

/**
 * 加入一个房间。
 * @returns {{room, module, strategy, strategyId, selfId}}
 */
export async function joinTransport({
  strategyId = DEFAULT_STRATEGY,
  roomId,
  relayUrls = [],
  turnServers = null,
  onJoinError = null
}) {
  const {module, strategy} = await loadStrategy(strategyId)
  const config = {
    appId: APP_ID,
    // 覆盖 Trystero 的默认值：默认的 Google STUN 在国内基本不通
    rtcConfig: {iceServers: buildIceServers(turnServers)}
  }
  if (relayUrls.length) config.relayConfig = {urls: relayUrls}
  const room = module.joinRoom(config, roomId, onJoinError ? {onJoinError} : undefined)
  return {room, module, strategy, strategyId, selfId: module.selfId}
}

export const peersOf = (room) => (room ? room.getPeers() : {})

export const relaySockets = (module) => module?.getRelaySockets?.() || {}

const SOCKET_STATE = ['未连接', '已连接', '连接中', '重连中', '已关闭']

export const describeSocket = (socket) => SOCKET_STATE[socket?.readyState ?? 3] || '未知'

export function formatCandidates(counts) {
  if (!counts) return '—'
  const keys = Object.keys(counts)
  return keys.length ? keys.map((key) => `${key}×${counts[key]}`).join(' ') : '—'
}

/** 逐个对端测延迟，返回 {peerId: 毫秒 | '失败'}。 */
export async function pingPeers(room) {
  const result = {}
  await Promise.all(Object.keys(peersOf(room)).map(async (peerId) => {
    try {
      result[peerId] = await room.ping(peerId)
    } catch {
      result[peerId] = '失败'
    }
  }))
  return result
}

/** 统计每个对端的 ICE 候选类型（host/srflx/prflx/relay），用来判断打洞情况。 */
export async function iceSnapshot(room) {
  const result = {}
  for (const [peerId, pc] of Object.entries(peersOf(room))) {
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
  return result
}

/** 只有双方都凑不出 srflx/prflx/relay 时，才说明只能局域网直连。 */
export function isLanOnly(ice) {
  if (!ice) return false
  return Object.values(ice).some((entry) => {
    if (!entry?.local) return false
    const kinds = {...entry.local, ...entry.remote}
    return !kinds.srflx && !kinds.prflx && !kinds.relay
  })
}
