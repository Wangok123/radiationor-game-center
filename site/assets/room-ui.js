// 共用的联机设置界面：信令策略选择、自定义中继、TURN 表单解析。
// 各个游戏的入口面板只要放空容器，这里负责填充和读取。

import {STRATEGIES, DEFAULT_STRATEGY} from './room.js'
import {TRANSPORTS, DEFAULT_TRANSPORT} from './transport.js'

/** 把「连接方式」单选渲染进 <fieldset>，返回读取当前选择的函数。 */
export function renderTransportPicker(fieldset, {selectedId = DEFAULT_TRANSPORT} = {}) {
  fieldset.replaceChildren()
  for (const transport of Object.values(TRANSPORTS)) {
    const label = document.createElement('label')
    label.className = 'strategy'

    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'transport'
    input.value = transport.id
    input.checked = transport.id === selectedId

    const text = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = transport.title
    const note = document.createElement('em')
    note.textContent = transport.note
    text.append(title, note)

    label.append(input, text)
    fieldset.append(label)
  }

  return () => {
    const checked = fieldset.querySelector('input[name="transport"]:checked')
    return checked ? checked.value : DEFAULT_TRANSPORT
  }
}

/** 把信令策略单选渲染进 <fieldset>，返回读取当前选择的函数。 */
export function renderStrategyPicker(fieldset, {selectedId = DEFAULT_STRATEGY} = {}) {
  fieldset.replaceChildren()
  for (const strategy of Object.values(STRATEGIES)) {
    const label = document.createElement('label')
    label.className = 'strategy'

    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'strategy'
    input.value = strategy.id
    input.checked = strategy.id === selectedId

    const text = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = strategy.title || strategy.label
    const note = document.createElement('em')
    note.textContent = strategy.note
    text.append(title, note)

    label.append(input, text)
    fieldset.append(label)
  }

  return () => {
    const checked = fieldset.querySelector('input[name="strategy"]:checked')
    return checked ? checked.value : DEFAULT_STRATEGY
  }
}

/** 自定义中继地址：每行一个，只接受 ws:// 或 wss://。 */
export function readRelayUrls(textarea) {
  return String(textarea?.value || '')
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => /^wss?:\/\//i.test(line))
}

/** TURN 兜底通道；没填地址就返回 null。 */
export function readTurnServers({url, username, credential}) {
  const address = String(url?.value || '').trim()
  if (!address) return null
  const server = {urls: address}
  const user = String(username?.value || '').trim()
  if (user) server.username = user
  if (credential?.value) server.credential = credential.value
  return [server]
}
