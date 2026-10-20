// 直连模式：WebRTC 点对点，信令走 Trystero（MQTT / Nostr / BitTorrent）。
//
// 上层只关心「发动作、发快照、谁在线」，具体怎么连由这里负责。

import {joinTransport, relaySockets, describeSocket} from './room.js'

export async function connectP2P({
  roomId,
  strategyId,
  relayUrls = [],
  turnServers = null,
  onCmd,
  onSnap,
  onPeerJoin,
  onPeerLeave,
  onError
}) {
  const transport = await joinTransport({
    strategyId,
    roomId,
    relayUrls,
    turnServers,
    onJoinError: (details) => onError?.(details?.error || '与对端建立连接失败（可能需要 TURN）')
  })
  const room = transport.room
  const stats = {sent: 0, received: 0, lastInAt: 0}

  const cmd = room.makeAction('cmd')
  const snap = room.makeAction('snap')
  cmd.onMessage = (data, context) => {
    stats.received += 1
    stats.lastInAt = Date.now()
    onCmd?.(data, {peerId: context.peerId})
  }
  snap.onMessage = (data) => {
    stats.received += 1
    stats.lastInAt = Date.now()
    onSnap?.(data)
  }
  room.onPeerJoin = (peerId) => onPeerJoin?.(peerId)
  room.onPeerLeave = (peerId) => onPeerLeave?.(peerId)

  const sendCmd = (data, options = {}) => {
    stats.sent += 1
    return cmd.send(data, options.target ? {target: options.target} : undefined).catch(() => {})
  }
  const sendSnap = (data) => {
    stats.sent += 1
    return snap.send(data).catch(() => {})
  }

  return {
    kind: 'p2p',
    transportId: 'p2p',
    strategyId,
    selfId: transport.selfId,
    sendCmd,
    sendSnap,
    peers: () => Object.keys(room.getPeers()),
    relayStates: () => Object.entries(relaySockets(transport.module)).map(([url, socket]) => ({
      url,
      state: describeSocket(socket),
      ok: socket?.readyState === 1
    })),
    stats: () => ({...stats}),
    // 直连模式特有的诊断能力
    room,
    module: transport.module,
    leave: async () => {
      try {
        await room.leave()
      } catch {
        /* 已经断开 */
      }
    }
  }
}
