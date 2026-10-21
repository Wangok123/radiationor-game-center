// games.json 的结构校验：纯函数，脚本和单测共用。
// 只做「能不能安全渲染」这一层检查，不判断游戏好不好玩。

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EXTERNAL_RE = /^https?:\/\//i

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * 校验整份 games.json。
 * @returns {{errors: Array<{where: string, message: string}>, games: Array<object>}}
 */
export function validateGamesData(data) {
  const errors = []
  const push = (where, message) => errors.push({where, message})

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    push('games.json', '顶层必须是对象')
    return {errors, games: []}
  }
  if (!Array.isArray(data.games)) {
    push('games.json', '缺少 games 数组')
    return {errors, games: []}
  }
  if (data.updated != null && !DATE_RE.test(String(data.updated))) {
    push('updated', `日期要写成 YYYY-MM-DD，现在是 ${JSON.stringify(data.updated)}`)
  }

  const seenSlug = new Map()
  const seenUrl = new Map()

  data.games.forEach((game, index) => {
    const at = `games[${index}]`
    if (!game || typeof game !== 'object' || Array.isArray(game)) {
      push(at, '每个条目必须是对象')
      return
    }

    const label = isNonEmptyString(game.slug) ? `games[${index}] (${game.slug})` : at

    if (!isNonEmptyString(game.slug)) {
      push(label, '缺少 slug')
    } else if (!SLUG_RE.test(game.slug)) {
      push(label, `slug 只能用小写字母、数字和连字符，现在是 ${JSON.stringify(game.slug)}`)
    } else if (seenSlug.has(game.slug)) {
      push(label, `slug 重复，和 games[${seenSlug.get(game.slug)}] 撞了`)
    } else {
      seenSlug.set(game.slug, index)
    }

    if (!isNonEmptyString(game.title)) push(label, '缺少 title')
    if (!isNonEmptyString(game.url)) push(label, '缺少 url')
    if (!isNonEmptyString(game.desc)) push(label, '缺少 desc（卡片上要显示一句话介绍）')

    if (isNonEmptyString(game.url)) {
      const url = game.url.trim()
      if (EXTERNAL_RE.test(url)) {
        // 外链，交给浏览器；只做基本形状检查
        try {
          new URL(url)
        } catch {
          push(label, `url 不是合法的绝对地址：${JSON.stringify(url)}`)
        }
      } else if (url.startsWith('/')) {
        push(label, '站内 url 请写成相对路径（如 games/foo/），不要以 / 开头')
      } else if (url.includes('..')) {
        push(label, '站内 url 不允许出现 ..')
      }
      if (seenUrl.has(url)) push(label, `url 重复，和 games[${seenUrl.get(url)}] 撞了`)
      else seenUrl.set(url, index)
    }

    if (game.author != null && !isNonEmptyString(game.author)) push(label, 'author 不能是空字符串')
    if (game.players != null && !isNonEmptyString(game.players)) push(label, 'players 不能是空字符串')
    if (game.duration != null && !isNonEmptyString(game.duration)) push(label, 'duration 不能是空字符串')
    if (game.icon != null && !isNonEmptyString(game.icon)) push(label, 'icon 不能是空字符串')

    if (game.multiplayer != null && typeof game.multiplayer !== 'boolean') {
      push(label, 'multiplayer 只能是 true / false')
    }

    if (game.added != null && !DATE_RE.test(String(game.added))) {
      push(label, `added 要写成 YYYY-MM-DD，现在是 ${JSON.stringify(game.added)}`)
    }

    if (game.tags != null) {
      if (!Array.isArray(game.tags)) {
        push(label, 'tags 必须是数组')
      } else if (game.tags.some((tag) => !isNonEmptyString(tag))) {
        push(label, 'tags 里不能有空值或非字符串')
      } else if (new Set(game.tags).size !== game.tags.length) {
        push(label, 'tags 里有重复项')
      }
    }
  })

  return {errors, games: data.games}
}
