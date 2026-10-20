// 共用的「连接诊断」面板：页面里放一个空容器，这里负责生成 DOM、刷新和复制。
// 同时支持两种通道：直连模式（P2P/WebRTC）和中继模式（公共 MQTT broker）。
//
//   import {mountDiagnostics} from '../../assets/diag.js'
//   const diag = mountDiagnostics(document.getElementById('diagnostics-mount'), {
//     getChannel, getTransportId, getStrategyId, getRole, getRoomId, getSelfId, getHostId,
//     getTurnServers, getErrors
//   })
//   diag.stop()  // 离开房间时调用

import {probeIce, BUILD, APP_ID, STRATEGIES, formatCandidates} from './room.js'
import {escapeHtml, shortId, copyText} from './util.js'
import {transportById} from './transport.js'

const REFRESH_MS = 2000
const webRtcSupported = () => typeof RTCPeerConnection !== 'undefined'

export function mountDiagnostics(root, context) {
  root.innerHTML = `
    <details class="diagnostics" id="diagnostics" open>
      <summary>连接诊断（连不上时先看这里）</summary>
      <div class="diag-actions">
        <button id="netcheck-btn" class="chip-button" type="button">网络自检</button>
        <button id="ping-btn" class="chip-button" type="button">测延迟</button>
        <button id="ice-btn" class="chip-button" type="button">检测 ICE 候选</button>
        <button id="copy-diag-btn" class="chip-button" type="button">复制诊断信息</button>
      </div>
      <div class="diag-body" id="diag-body"></div>
    </details>`

  const details = root.querySelector('#diagnostics')
  const body = root.querySelector('#diag-body')
  const netcheckButton = root.querySelector('#netcheck-btn')
  const iceButton = root.querySelector('#ice-btn')
  const pingButton = root.querySelector('#ping-btn')
  const copyButton = root.querySelector('#copy-diag-btn')

  let ice = null
  let ping = null
  let netcheck = null

  const netcheckHint = () => {
    if (!netcheck) return ''
    const types = netcheck.types || {}
    if (!netcheck.supported) return '<p class="hint bad">当前浏览器不支持 WebRTC：只能用中继模式。</p>'
    if (!types.srflx && !types.relay && !types.prflx) {
      return '<p class="hint bad">只拿到 host 候选：这台设备打不了洞，直连模式会失败，请用中继模式或配 TURN。</p>'
    }
    return ''
  }

  const render = () => {
    const channel = context.getChannel()
    if (!channel) return
    const isP2P = channel.kind === 'p2p'
    const transport = transportById(channel.transportId)
    const strategyId = context.getStrategyId()
    const hostId = context.getHostId() || (context.getRole() === 'host' ? context.getSelfId() : null)
    const errors = context.getErrors?.() || []
    const stats = channel.stats?.() || {}
    const relayEntries = channel.relayStates?.() || []
    const relaysUp = relayEntries.filter((entry) => entry.ok).length
    const peerIds = channel.peers()

    // 直连模式才需要的按钮
    netcheckButton.hidden = !isP2P
    iceButton.hidden = !isP2P
    pingButton.hidden = !isP2P

    const relayRows = relayEntries
      .map((entry) => `<tr><td>${escapeHtml(entry.url)}</td><td class="${entry.ok ? 'ok' : 'bad'}">${escapeHtml(entry.state)}</td></tr>`)
      .join('') || '<tr><td colspan="2">还没有建立中继连接</td></tr>'

    let peerRows = ''
    if (isP2P) {
      const peers = channel.room.getPeers()
      peerRows = peerIds.map((peerId) => {
        const pc = peers[peerId]
        const candidate = ice?.[peerId]
        const iceText = candidate ? `本机 ${formatCandidates(candidate.local)} / 对端 ${formatCandidates(candidate.remote)}` : '未检测'
        return `<tr>
          <td>${escapeHtml(shortId(peerId))}</td>
          <td class="${pc.connectionState === 'connected' ? 'ok' : 'bad'}">${escapeHtml(pc.connectionState)}</td>
          <td>${escapeHtml(pc.iceConnectionState)}</td>
          <td>${ping?.[peerId] === undefined ? '—' : escapeHtml(String(ping[peerId]))}</td>
          <td>${iceText}</td>
        </tr>`
      }).join('')
    } else {
      const detailed = channel.detailedPeers?.() || new Map()
      const now = Date.now()
      peerRows = peerIds.map((peerId) => {
        const lastSeen = detailed.get?.(peerId)
        const ago = typeof lastSeen === 'number' ? `${Math.round((now - lastSeen) / 1000)} 秒前` : '—'
        return `<tr>
          <td>${escapeHtml(shortId(peerId))}</td>
          <td class="ok">在线</td>
          <td>${escapeHtml(ago)}</td>
        </tr>`
      }).join('')
    }
    if (!peerRows) {
      peerRows = `<tr><td colspan="${isP2P ? 5 : 3}">还没有连上任何人</td></tr>`
    }

    const netcheckText = isP2P
      ? (netcheck
        ? (netcheck.supported
          ? `${formatCandidates(netcheck.types)}　耗时 ${netcheck.ms} ms${netcheck.error ? `　错误 ${escapeHtml(netcheck.error)}` : ''}`
          : '不支持 WebRTC')
        : '未检测')
      : '中继模式不需要'

    const trafficRow = stats.sent === undefined
      ? ''
      : `<tr><th>收发</th><td>发出 ${stats.sent} 条 / 收到 ${stats.received} 条${stats.sinceLastIn === null || stats.sinceLastIn === undefined ? '' : `，最后一条 ${Math.round(stats.sinceLastIn / 1000)} 秒前`}</td></tr>`

    const errorBlock = errors.length
      ? `<h3>连接错误</h3><ul class="diag-errors">${errors.slice(-5).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      : ''

    const peerHead = isP2P
      ? '<tr><th>peer</th><th>连接</th><th>ICE</th><th>延迟 ms</th><th>候选（本机 / 对端）</th></tr>'
      : '<tr><th>peer</th><th>状态</th><th>最后活跃</th></tr>'

    body.innerHTML = `
      <h3>本机</h3>
      <table>
        <tr><th>版本</th><td>${escapeHtml(BUILD)}</td></tr>
        <tr><th>连接方式</th><td>${escapeHtml(transport.title)}</td></tr>
        <tr><th>房间</th><td>${escapeHtml(context.getRoomId() || '')}</td></tr>
        <tr><th>角色</th><td>${context.getRole() === 'host' ? '房主（权威端）' : '客户端'}</td></tr>
        <tr><th>我的 peer</th><td>${escapeHtml(shortId(context.getSelfId()))}</td></tr>
        <tr><th>房主 peer</th><td>${hostId ? escapeHtml(shortId(hostId)) : '<span class="bad">还没收到房主的任何消息</span>'}</td></tr>
        ${isP2P ? `<tr><th>信令</th><td>${escapeHtml(STRATEGIES[strategyId]?.label || strategyId)}（${relaysUp}/${relayEntries.length || 4} 中继已连接）</td></tr>` : ''}
        ${isP2P ? `<tr><th>WebRTC</th><td>${webRtcSupported() ? '<span class="ok">支持</span>' : '<span class="bad">不支持</span>'}</td></tr>` : ''}
        ${isP2P ? `<tr><th>网络自检</th><td>${netcheckText}</td></tr>` : ''}
        ${trafficRow}
      </table>
      ${isP2P ? netcheckHint() : ''}
      ${isP2P && relaysUp === 0 ? '<p class="hint bad">信令中继一个都没连上：别人找不到你。换一个信令策略，或改用中继模式。</p>' : ''}
      ${!isP2P && relaysUp === 0 ? '<p class="hint bad">中继 broker 一个都没连上：收不到对方的消息。检查网络，或换一张网络再试。</p>' : ''}
      <h3>中继连接</h3>
      <table><tr><th>地址</th><th>状态</th></tr>${relayRows}</table>
      <h3>对端连接</h3>
      <table>${peerHead}${peerRows}</table>
      ${errorBlock}
    `
  }

  const text = () => {
    const channel = context.getChannel()
    if (!channel) return ''
    const isP2P = channel.kind === 'p2p'
    const stats = channel.stats?.() || {}
    const lines = [
      `版本: ${BUILD} (${APP_ID})`,
      `连接方式: ${transportById(channel.transportId).title}`,
      `房间: ${context.getRoomId()}`,
      `角色: ${context.getRole() === 'host' ? '房主' : '客户端'}`,
      `信令: ${STRATEGIES[context.getStrategyId()]?.label || context.getStrategyId()}`,
      `我的 peer: ${context.getSelfId()}`,
      `房主 peer: ${context.getHostId() || (context.getRole() === 'host' ? context.getSelfId() : '未收到房主的任何消息')}`,
      `WebRTC: ${webRtcSupported() ? '支持' : '不支持'}`,
      `UA: ${navigator.userAgent}`,
      `收发: 发出 ${stats.sent ?? 0} / 收到 ${stats.received ?? 0}`,
      '中继:'
    ]
    for (const entry of channel.relayStates?.() || []) lines.push(`  ${entry.url} → ${entry.state}`)
    if (netcheck) lines.push(`网络自检: ${netcheck.supported ? formatCandidates(netcheck.types) : '不支持 WebRTC'}`)
    lines.push('对端:')
    for (const peerId of channel.peers()) {
      if (isP2P) {
        const pc = channel.room.getPeers()[peerId]
        lines.push(`  ${shortId(peerId)} 连接=${pc.connectionState} ICE=${pc.iceConnectionState}`)
      } else {
        lines.push(`  ${shortId(peerId)} 在线`)
      }
    }
    for (const error of context.getErrors?.() || []) lines.push(`错误: ${error}`)
    return lines.join('\n')
  }

  netcheckButton.addEventListener('click', async () => {
    netcheckButton.textContent = '自检中…'
    netcheck = await probeIce({turnServers: context.getTurnServers?.() || null})
    netcheckButton.textContent = '网络自检'
    render()
  })

  iceButton.addEventListener('click', async () => {
    const channel = context.getChannel()
    if (!channel?.room) return
    const result = {}
    for (const [peerId, pc] of Object.entries(channel.room.getPeers())) {
      const local = {}
      const remote = {}
      try {
        const report = await pc.getStats()
        report.forEach((entry) => {
          if (entry.type === 'local-candidate') local[entry.candidateType] = (local[entry.candidateType] || 0) + 1
          if (entry.type === 'remote-candidate') remote[entry.candidateType] = (remote[entry.candidateType] || 0) + 1
        })
        result[peerId] = {local, remote}
      } catch (error) {
        result[peerId] = {local, remote, error: String(error)}
      }
    }
    ice = result
    render()
  })

  pingButton.addEventListener('click', async () => {
    const channel = context.getChannel()
    if (!channel?.room) return
    const result = {}
    await Promise.all(Object.keys(channel.room.getPeers()).map(async (peerId) => {
      try {
        result[peerId] = await channel.room.ping(peerId)
      } catch {
        result[peerId] = '失败'
      }
    }))
    ping = result
    render()
  })

  copyButton.addEventListener('click', async () => {
    const ok = await copyText(text())
    copyButton.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { copyButton.textContent = '复制诊断信息' }, 1600)
  })

  const timer = setInterval(() => {
    if (details.open && context.getChannel()) render()
  }, REFRESH_MS)
  render()

  return {
    refresh: render,
    text,
    stop: () => clearInterval(timer)
  }
}
