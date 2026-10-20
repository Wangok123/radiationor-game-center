// 中继模式：对局数据通过公共 MQTT broker 转发。
//
// 为什么需要它：WebRTC 点对点在「手机流量 ↔ 宽带」这种组合下经常打洞失败，
// 而信令用的公共 broker 明明连得上。回合制棋牌对延迟不敏感，直接把消息走 broker
// 反而最稳：不需要 TURN、不需要自己的服务器。
//
// 隐私：所有消息用「应用 + 房间号」派生的 AES-GCM 密钥加密后再发，
// broker 只看到随机 topic 和密文，看不到棋盘内容。

import {APP_ID} from './room.js'

/** 公共 MQTT broker（和直连模式的信令用的是同一批）。 */
const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://public:public@public.cloud.shiftr.io'
]

const HEARTBEAT_MS = 6000
const PEER_TIMEOUT_MS = 20000
const MAX_SEEN = 400

const encoder = new TextEncoder()

const makeId = (length = 20) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  for (let i = 0; i < length; i++) id += alphabet[bytes[i] % alphabet.length]
  return id
}

const bytesToBase64 = (bytes) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

const base64ToBytes = (text) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveKey(material) {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(material), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt: encoder.encode(`${APP_ID}:room`), iterations: 60000, hash: 'SHA-256'},
    baseKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  )
}

async function deriveTopic(material) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`topic:${APP_ID}:${material}`))
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `rogc/v1/${hex}`
}

export async function connectRelay({
  roomId,
  onCmd,
  onSnap,
  onPeerJoin,
  onPeerLeave,
  onError
}) {
  if (typeof crypto?.subtle === 'undefined') {
    throw new Error('当前环境不支持 WebCrypto，无法使用中继模式')
  }

  const {default: mqtt} = await import('./vendor/relay.js')
  const selfId = makeId()
  const key = await deriveKey(roomId)
  const topic = await deriveTopic(roomId)

  const stats = {sent: 0, received: 0, lastInAt: 0}
  const seen = new Set()
  const peers = new Map() // peerId → 最后活跃时间
  const clients = new Map() // url → mqtt client
  let seq = 0
  let closed = false

  const encrypt = async (value) => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, encoder.encode(JSON.stringify(value)))
    return {iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher))}
  }

  const decrypt = async (iv, data) => {
    const plain = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: base64ToBytes(iv)},
      key,
      base64ToBytes(data)
    )
    return JSON.parse(new TextDecoder().decode(plain))
  }

  const publish = async (type, payload) => {
    const body = await encrypt({t: type, p: payload})
    const envelope = JSON.stringify({f: selfId, n: ++seq, iv: body.iv, d: body.data})
    let delivered = false
    for (const client of clients.values()) {
      if (!client.connected) continue
      client.publish(topic, envelope, {qos: 0})
      delivered = true
    }
    if (delivered) stats.sent += 1
    return delivered
  }

  const touchPeer = (peerId) => {
    const known = peers.has(peerId)
    peers.set(peerId, Date.now())
    if (!known) onPeerJoin?.(peerId)
  }

  const handleMessage = async (raw) => {
    if (closed || !raw) return
    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      return
    }
    if (!envelope || envelope.f === selfId || typeof envelope.n !== 'number') return
    const dedupeKey = `${envelope.f}:${envelope.n}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)

    let message
    try {
      message = await decrypt(envelope.iv, envelope.d)
    } catch {
      return // 解不开就忽略（可能是别的房间/旧版本）
    }

    stats.received += 1
    stats.lastInAt = Date.now()
    touchPeer(envelope.f)

    if (message.t === 'cmd') onCmd?.(message.p, {peerId: envelope.f})
    else if (message.t === 'snap') onSnap?.(message.p)
    else if (message.t === 'bye') {
      if (peers.delete(envelope.f)) onPeerLeave?.(envelope.f)
    }
  }

  for (const url of BROKER_URLS) {
    const client = mqtt.connect(url, {
      clientId: `rogc_${selfId}`.slice(0, 23),
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true
    })
    client.on('connect', () => client.subscribe(topic, {qos: 0}))
    client.on('message', (_topic, payload) => { void handleMessage(payload.toString()) })
    client.on('error', () => { /* 单个 broker 挂了不影响其它 */ })
    clients.set(url, client)
  }

  // 关闭页面时尽量广播一声 bye，让对方立刻看到我离线（未送达也没关系，心跳会兜底）
  const sayBye = () => { void publish('bye') }
  window.addEventListener('pagehide', sayBye)
  window.addEventListener('beforeunload', sayBye)

  // 心跳：让对端知道我还活着；同时定期清理掉线的对端
  const heartbeat = setInterval(() => {
    void publish('hi')
    const now = Date.now()
    for (const [peerId, lastSeen] of peers) {
      if (now - lastSeen > PEER_TIMEOUT_MS) {
        peers.delete(peerId)
        onPeerLeave?.(peerId)
      }
    }
  }, HEARTBEAT_MS)

  // 等第一个 broker 连上，超时就报错（不阻塞，继续重连）
  const waitFirstConnection = new Promise((resolve) => {
    const started = Date.now()
    const check = setInterval(() => {
      const connected = [...clients.values()].filter((client) => client.connected).length
      if (connected > 0 || Date.now() - started > 8000) {
        clearInterval(check)
        resolve(connected > 0)
      }
    }, 200)
  })
  const online = await waitFirstConnection
  if (!online) onError?.('中继 broker 一个都没连上：检查网络，或换一个连接方式')

  return {
    kind: 'relay',
    transportId: 'relay',
    selfId,
    sendCmd: (data) => publish('cmd', data),
    sendSnap: (data) => publish('snap', data),
    peers: () => [...peers.keys()],
    detailedPeers: () => new Map(peers),
    relayStates: () => [...clients.entries()].map(([url, client]) => ({
      url,
      state: client.connected ? '已连接' : '未连接',
      ok: Boolean(client.connected)
    })),
    stats: () => ({
      ...stats,
      peers: peers.size,
      sinceLastIn: stats.lastInAt ? Date.now() - stats.lastInAt : null
    }),
    leave: async () => {
      closed = true
      clearInterval(heartbeat)
      window.removeEventListener('pagehide', sayBye)
      window.removeEventListener('beforeunload', sayBye)
      await publish('bye').catch(() => {})
      for (const client of clients.values()) {
        try {
          client.end(true)
        } catch {
          /* 已经关了 */
        }
      }
      clients.clear()
    }
  }
}
