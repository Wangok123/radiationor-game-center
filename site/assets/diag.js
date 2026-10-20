// 共用的「连接诊断」面板：页面里放一个空容器，这里负责生成 DOM、刷新和复制。
//
//   import {mountDiagnostics} from '../../assets/diag.js'
//   const diag = mountDiagnostics(document.getElementById('diagnostics-mount'), {
//     getRoom, getModule, getStrategyId, getRole, getRoomId, getSelfId, getHostId
//   })
//   diag.stop()  // 离开房间时调用

import {
  relaySockets,
  peersOf,
  describeSocket,
  formatCandidates,
  pingPeers,
  iceSnapshot,
  isLanOnly,
  STRATEGIES
} from './room.js'
import {escapeHtml, shortId, copyText} from './util.js'

const REFRESH_MS = 2000

export function mountDiagnostics(root, context) {
  root.innerHTML = `
    <details class="diagnostics" id="diagnostics" open>
      <summary>连接诊断（连不上时先看这里）</summary>
      <div class="diag-actions">
        <button id="ping-btn" class="chip-button" type="button">测延迟</button>
        <button id="ice-btn" class="chip-button" type="button">检测 ICE 候选</button>
        <button id="copy-diag-btn" class="chip-button" type="button">复制诊断信息</button>
      </div>
      <div class="diag-body" id="diag-body"></div>
    </details>`

  const details = root.querySelector('#diagnostics')
  const body = root.querySelector('#diag-body')
  const iceButton = root.querySelector('#ice-btn')
  const pingButton = root.querySelector('#ping-btn')
  const copyButton = root.querySelector('#copy-diag-btn')

  let ice = null
  let ping = null

  const render = () => {
    const room = context.getRoom()
    if (!room) return
    const strategyId = context.getStrategyId()
    const peers = peersOf(room)
    const peerIds = Object.keys(peers)

    const relayRows = Object.entries(relaySockets(context.getModule()))
      .map(([url, socket]) => {
        const state = describeSocket(socket)
        const cls = socket?.readyState === 1 ? 'ok' : 'bad'
        return `<tr><td>${escapeHtml(url)}</td><td class="${cls}">${state}</td></tr>`
      })
      .join('') || '<tr><td colspan="2">还没有建立中继连接</td></tr>'

    const peerRows = peerIds.map((peerId) => {
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
    }).join('') || '<tr><td colspan="5">还没有连上任何人</td></tr>'

    body.innerHTML = `
      <h3>本机</h3>
      <table>
        <tr><th>房间</th><td>${escapeHtml(context.getRoomId() || '')}</td></tr>
        <tr><th>角色</th><td>${context.getRole() === 'host' ? '房主（权威端）' : '客户端'}</td></tr>
        <tr><th>我的 peer</th><td>${escapeHtml(shortId(context.getSelfId()))}</td></tr>
        <tr><th>房主 peer</th><td>${escapeHtml(shortId(context.getHostId() || context.getSelfId()))}</td></tr>
        <tr><th>信令</th><td>${escapeHtml(STRATEGIES[strategyId]?.label || strategyId)}</td></tr>
      </table>
      <h3>中继连接（信令）</h3>
      <table><tr><th>地址</th><th>状态</th></tr>${relayRows}</table>
      <h3>对端连接</h3>
      <table><tr><th>peer</th><th>连接</th><th>ICE</th><th>延迟 ms</th><th>候选（本机 / 对端）</th></tr>${peerRows}</table>
      ${isLanOnly(ice) ? '<p class="hint">只收集到 host 候选：双方目前可能只能在同一局域网直连。跨网络连不上时，在「高级」里填一个可用的 TURN 再试。</p>' : ''}
    `
  }

  const text = () => {
    const room = context.getRoom()
    if (!room) return ''
    const lines = [
      `房间: ${context.getRoomId()}`,
      `角色: ${context.getRole() === 'host' ? '房主' : '客户端'}`,
      `信令: ${STRATEGIES[context.getStrategyId()]?.label || context.getStrategyId()}`,
      `我的 peer: ${context.getSelfId()}`,
      `房主 peer: ${context.getHostId() || context.getSelfId()}`,
      `UA: ${navigator.userAgent}`,
      '中继:'
    ]
    for (const [url, socket] of Object.entries(relaySockets(context.getModule()))) {
      lines.push(`  ${url} → ${describeSocket(socket)}`)
    }
    lines.push('对端:')
    for (const [peerId, pc] of Object.entries(peersOf(room))) {
      const candidate = ice?.[peerId]
      lines.push(`  ${shortId(peerId)} 连接=${pc.connectionState} ICE=${pc.iceConnectionState} 候选=${candidate ? `${formatCandidates(candidate.local)} / ${formatCandidates(candidate.remote)}` : '未检测'}`)
    }
    return lines.join('\n')
  }

  iceButton.addEventListener('click', async () => {
    ice = await iceSnapshot(context.getRoom())
    render()
  })

  pingButton.addEventListener('click', async () => {
    ping = await pingPeers(context.getRoom())
    render()
  })

  copyButton.addEventListener('click', async () => {
    const ok = await copyText(text())
    copyButton.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { copyButton.textContent = '复制诊断信息' }, 1600)
  })

  const timer = setInterval(() => {
    if (details.open && context.getRoom()) render()
  }, REFRESH_MS)
  render()

  return {
    refresh: render,
    text,
    stop: () => clearInterval(timer)
  }
}
