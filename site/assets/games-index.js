// 游戏索引：首页从 ../games.json 读取数据并渲染卡片、标签筛选和搜索。
//
// 这个文件分两层：
//   - 纯函数（normalize / matchesQuery / collectTags / filterGames）：不碰 DOM，Node 单测直接引用；
//   - 渲染层（renderCard / mountGameIndex / loadGames）：只在浏览器里跑。
//
// 收录一个游戏只需要改 site/games.json，不用动这个文件。

const EXTERNAL_URL = /^(?:https?:)?\/\//i

/** 外链（别的域名 / 别的仓库）还是本站子路径 */
export const isExternal = (url) => EXTERNAL_URL.test(String(url ?? ''))

/** 卡片点击后去哪；数据缺失时给个安全兜底 */
export const gameHref = (game) => String(game?.url ?? '') || '#'

/** 统一小写、折叠空白，便于匹配 */
export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 一个游戏可被搜到的全部文本 */
export function haystack(game) {
  return normalize(
    [game?.title, game?.desc, game?.author, game?.players, game?.duration, ...(game?.tags ?? [])].join(' ')
  )
}

/** 空格分词后逐个匹配（AND），空查询恒真 */
export function matchesQuery(game, query) {
  const tokens = normalize(query).split(' ').filter(Boolean)
  if (!tokens.length) return true
  const hay = haystack(game)
  return tokens.every((token) => hay.includes(token))
}

/** 按标签统计，出现次数多的在前；同次数按首次出现的顺序（保留人工编排意图） */
export function collectTags(games) {
  const stats = new Map()
  let order = 0
  for (const game of games ?? []) {
    for (const tag of game?.tags ?? []) {
      const name = String(tag).trim()
      if (!name) continue
      const entry = stats.get(name)
      if (entry) entry.count += 1
      else stats.set(name, {tag: name, count: 1, first: order++})
    }
  }
  return [...stats.values()]
    .map(({tag, count}) => ({tag, count}))
    .sort((a, b) => b.count - a.count || stats.get(a.tag).first - stats.get(b.tag).first)
}

/** 标签 + 关键词组合过滤，保持 games.json 里的顺序（人工排的序即推荐序） */
export function filterGames(games, {query = '', tag = ''} = {}) {
  const wanted = String(tag ?? '').trim()
  return (games ?? []).filter((game) => {
    if (wanted && !(game?.tags ?? []).includes(wanted)) return false
    return matchesQuery(game, query)
  })
}

/** 卡片右下角的动作文案 */
export const enterLabel = (game) => (isExternal(gameHref(game)) ? '前往 ↗' : '进入 →')

/* ------------------------------------------------------------------ */
/* 以下只在浏览器里用                                                   */
/* ------------------------------------------------------------------ */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** 单张卡片；所有字段走 textContent，永远不拼 innerHTML（数据可能来自投稿） */
export function renderCard(game, doc = document) {
  const external = isExternal(gameHref(game))
  const link = el(doc, 'a', 'game-card')
  link.href = gameHref(game)
  if (external) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }

  const icon = el(doc, 'span', 'game-icon', String(game?.icon || game?.title || '?').slice(0, 2))
  icon.setAttribute('aria-hidden', 'true')

  const body = el(doc, 'span', 'game-body')
  const heading = el(doc, 'h3', null, String(game?.title ?? '未命名'))
  if (game?.multiplayer) heading.append(el(doc, 'span', 'game-badge', '可联机'))
  body.append(heading)

  if (game?.desc) body.append(el(doc, 'p', null, String(game.desc)))

  const meta = el(doc, 'span', 'game-meta')
  const chips = [game?.players, game?.duration, ...(game?.tags ?? [])].filter(Boolean)
  for (const chip of chips) meta.append(el(doc, 'span', null, String(chip)))
  if (game?.author) meta.append(el(doc, 'span', 'is-author', String(game.author)))
  body.append(meta)

  link.append(icon, body, el(doc, 'span', 'game-enter', enterLabel(game)))
  const item = el(doc, 'li')
  item.append(link)
  return item
}

function renderTagBar(container, tags, activeTag, onPick, doc) {
  container.replaceChildren()
  const all = el(doc, 'button', 'tag-chip', '全部')
  all.type = 'button'
  all.dataset.tag = ''
  all.setAttribute('aria-pressed', String(!activeTag))
  if (!activeTag) all.classList.add('is-active')
  all.addEventListener('click', () => onPick(''))
  container.append(all)

  for (const {tag, count} of tags) {
    const chip = el(doc, 'button', 'tag-chip', `${tag} ${count}`)
    chip.type = 'button'
    chip.dataset.tag = tag
    const active = tag === activeTag
    chip.setAttribute('aria-pressed', String(active))
    if (active) chip.classList.add('is-active')
    chip.addEventListener('click', () => onPick(active ? '' : tag))
    container.append(chip)
  }
}

/**
 * 把索引挂到首页上。
 * 返回 {setQuery, setTag, render, state}，方便测试和以后加「随机开一局」之类的入口。
 */
export function mountGameIndex({
  grid,
  tagBar,
  searchInput,
  countEl,
  emptyEl,
  games,
  doc = document,
  history = typeof window !== 'undefined' ? window.history : null,
  location = typeof window !== 'undefined' ? window.location : null
}) {
  const allGames = Array.isArray(games) ? games : []
  const tags = collectTags(allGames)
  const params = location ? new URLSearchParams(location.search) : new URLSearchParams()
  const state = {query: params.get('q') ?? '', tag: params.get('tag') ?? ''}

  if (searchInput) searchInput.value = state.query

  const syncUrl = () => {
    if (!history || !location) return
    const next = new URLSearchParams(location.search)
    if (state.query) next.set('q', state.query)
    else next.delete('q')
    if (state.tag) next.set('tag', state.tag)
    else next.delete('tag')
    const query = next.toString()
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
  }

  const render = () => {
    const visible = filterGames(allGames, state)
    grid.replaceChildren(...visible.map((game) => renderCard(game, doc)))
    if (emptyEl) emptyEl.hidden = visible.length > 0
    if (countEl) countEl.textContent = `共 ${visible.length} 款`
    renderTagBar(tagBar, tags, state.tag, (tag) => setTag(tag), doc)
    syncUrl()
  }

  const setQuery = (value) => {
    state.query = String(value ?? '')
    render()
  }
  const setTag = (value) => {
    state.tag = String(value ?? '')
    render()
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => setQuery(searchInput.value))
  }
  if (tagBar) tagBar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setTag('')
  })

  render()
  return {render, setQuery, setTag, state}
}

/** 读 games.json；失败时抛错，由调用方决定怎么提示 */
export async function loadGames(url = './games.json', fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {cache: 'no-cache'})
  if (!response.ok) throw new Error(`games.json 加载失败：HTTP ${response.status}`)
  const data = await response.json()
  if (!data || !Array.isArray(data.games)) throw new Error('games.json 格式不对：缺少 games 数组')
  return data
}
