// 连接方式：中继模式 / 直连模式。
//
// 两种通道对上层暴露同一套接口，游戏逻辑完全不用改：
//
//   const channel = await connect({
//     transportId, roomId,
//     onCmd, onSnap,           // 收到「客户端动作」和「房主快照」
//     onPeerJoin, onPeerLeave, // 对端出现 / 消失
//     onError,                 // 连接失败原因（直连模式才会有）
//     strategyId, relayUrls, turnServers  // 只有直连模式用到
//   })
//   channel.sendCmd(data)      // 客户端 → 房主
//   channel.sendSnap(data)     // 房主 → 所有人
//   channel.peers()            // 其他参与者 id
//   channel.relayStates()      // 中继连接状态（诊断面板用）
//   channel.stats()            // 收发统计（诊断面板用）
//   channel.leave()

import {connectP2P} from './transport-p2p.js'
import {connectRelay} from './transport-relay.js'

export const TRANSPORTS = {
  relay: {
    id: 'relay',
    label: '中继',
    title: '中继模式（推荐）',
    note: '数据经公共 MQTT broker 转发并端到端加密，两端能上网就能连'
  },
  p2p: {
    id: 'p2p',
    label: '直连',
    title: '直连模式（P2P）',
    note: 'WebRTC 点对点，不经过中继；手机流量等网络可能打洞失败'
  }
}

export const DEFAULT_TRANSPORT = 'relay'

export const transportById = (id) => TRANSPORTS[id] || TRANSPORTS[DEFAULT_TRANSPORT]

export async function connect({transportId = DEFAULT_TRANSPORT, ...options} = {}) {
  const transport = transportById(transportId)
  const factory = transport.id === 'relay' ? connectRelay : connectP2P
  return factory({...options, transportId: transport.id})
}
