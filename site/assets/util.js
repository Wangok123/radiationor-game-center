// 所有游戏共用的小工具。没有第三方依赖。

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

export const shortId = (id) => (id ? String(id).slice(0, 6) : '—')

export function cleanName(raw, fallback = '无名玩家') {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 12)
  return name || fallback
}

export function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

export function randomCode(length = 5) {
  // 去掉容易看错的 0/O/1/I
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < length; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
  return code
}

/** 有剪贴板 API 就用，没有就退回 execCommand（老浏览器 / http 环境）。 */
export async function copyText(text) {
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

/** 日志用的 HH:MM。 */
export const timeLabel = () => new Date().toLocaleTimeString('zh-CN', {hour12: false}).slice(0, 5)

/** 读取 localStorage，隐私模式下会抛异常，统一吞掉。 */
export function readStore(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writeStore(key, value) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* 存不下就算了，不影响玩 */
  }
}
