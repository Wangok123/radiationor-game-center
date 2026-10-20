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
export async function joinTransport({strategyId = DEFAULT_STRATEGY, roomId, relayUrls = [], turnServers = null}) {
  const {module, strategy} = await loadStrategy(strategyId)
  const config = {appId: APP_ID}
  if (relayUrls.length) config.relayConfig = {urls: relayUrls}
  if (turnServers) config.turnConfig = turnServers
  const room = module.joinRoom(config, roomId)
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
