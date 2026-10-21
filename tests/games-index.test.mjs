// 游戏索引的过滤 / 搜索 / 数据校验单测（不碰 DOM，Node 直接跑）：
//   node --test tests/games-index.test.mjs

import {test} from 'node:test'
import assert from 'node:assert/strict'

import {
  collectTags,
  enterLabel,
  filterGames,
  gameHref,
  isExternal,
  matchesQuery,
  normalize
} from '../site/assets/games-index.js'
import {validateGamesData} from '../scripts/lib/games-schema.mjs'

const games = [
  {
    slug: 'gomoku',
    title: '五子棋',
    desc: '棋盘对弈，五子连珠即胜',
    author: 'Lin',
    tags: ['棋类', '回合制'],
    players: '2 人',
    duration: '5 分钟',
    url: 'games/gomoku/'
  },
  {
    slug: 'snake',
    title: '贪吃蛇',
    desc: 'AI 生成的街机小游戏',
    author: 'AI Lab',
    tags: ['街机', '单人'],
    url: 'https://example.com/snake/'
  },
  {
    slug: 'cards',
    title: '翻牌记忆',
    desc: '考记忆力的桌面小游戏',
    author: 'Lin',
    tags: ['棋类', '单人'],
    url: 'games/cards/'
  }
]

test('isExternal 只认绝对地址，站内相对路径不算', () => {
  assert.equal(isExternal('https://example.com/a/'), true)
  assert.equal(isExternal('http://example.com/a/'), true)
  assert.equal(isExternal('games/gomoku/'), false)
  assert.equal(isExternal('./games/gomoku/'), false)
  assert.equal(isExternal(''), false)
  assert.equal(isExternal(null), false)
  assert.equal(isExternal(undefined), false)
})

test('gameHref 缺数据时给安全兜底', () => {
  assert.equal(gameHref({url: 'games/gomoku/'}), 'games/gomoku/')
  assert.equal(gameHref({}), '#')
  assert.equal(gameHref(null), '#')
  assert.equal(gameHref({url: ''}), '#')
})

test('enterLabel 区本站跳转和出站', () => {
  assert.equal(enterLabel({url: 'games/gomoku/'}), '进入 →')
  assert.equal(enterLabel({url: 'https://example.com/x/'}), '前往 ↗')
})

test('normalize 统一大小写和空白', () => {
  assert.equal(normalize('  AI   Lab '), 'ai lab')
  assert.equal(normalize(null), '')
})

test('matchesQuery：空查询恒真', () => {
  for (const game of games) {
    assert.equal(matchesQuery(game, ''), true)
    assert.equal(matchesQuery(game, '   '), true)
    assert.equal(matchesQuery(game, undefined), true)
  }
})

test('matchesQuery：标题、简介、作者、标签、人数都能搜到', () => {
  assert.equal(matchesQuery(games[0], '五子'), true)          // 标题
  assert.equal(matchesQuery(games[0], '连珠'), true)          // 简介
  assert.equal(matchesQuery(games[1], 'ai lab'), true)        // 作者，大小写不敏感
  assert.equal(matchesQuery(games[0], '回合制'), true)        // 标签
  assert.equal(matchesQuery(games[0], '2 人'), true)          // 人数
  assert.equal(matchesQuery(games[0], '贪吃蛇'), false)
})

test('matchesQuery：多个词是 AND，不是 OR', () => {
  assert.equal(matchesQuery(games[1], 'ai 街机'), true)
  assert.equal(matchesQuery(games[1], 'ai 棋类'), false)
})

test('collectTags 统计出现次数，多的排前面', () => {
  const tags = collectTags(games)
  assert.deepEqual(
    tags.map((entry) => entry.tag),
    ['棋类', '单人', '回合制', '街机']
  )
  assert.equal(tags[0].count, 2)
  assert.equal(tags[1].count, 2)
  assert.equal(tags[2].count, 1)
})

test('collectTags 对空数据和脏数据不炸', () => {
  assert.deepEqual(collectTags([]), [])
  assert.deepEqual(collectTags(null), [])
  assert.deepEqual(collectTags([{tags: null}, {}, {tags: ['  ', '']}]), [])
})

test('filterGames：标签过滤', () => {
  const onlyBoard = filterGames(games, {tag: '棋类'})
  assert.deepEqual(onlyBoard.map((game) => game.slug), ['gomoku', 'cards'])
  assert.deepEqual(filterGames(games, {tag: '不存在的标签'}), [])
})

test('filterGames：标签 + 关键词组合，且保持原顺序', () => {
  assert.deepEqual(
    filterGames(games, {tag: '棋类', query: '五子'}).map((game) => game.slug),
    ['gomoku']
  )
  assert.deepEqual(filterGames(games, {}).map((game) => game.slug), ['gomoku', 'snake', 'cards'])
})

test('filterGames 对空数据不炸', () => {
  assert.deepEqual(filterGames(null, {query: 'a'}), [])
  assert.deepEqual(filterGames([], {}), [])
})

test('validateGamesData：合法数据没有错误', () => {
  const {errors} = validateGamesData({
    updated: '2026-10-21',
    games: [
      {slug: 'gomoku', title: '五子棋', url: 'games/gomoku/', desc: '一句话介绍', tags: ['棋类'], multiplayer: true, added: '2026-10-20'},
      {slug: 'ext', title: '外链游戏', url: 'https://example.com/x/', desc: '别人的作品', author: 'Someone'}
    ]
  })
  assert.deepEqual(errors, [])
})

test('validateGamesData：拦住缺字段和重复 slug', () => {
  const {errors} = validateGamesData({
    games: [
      {slug: 'a', url: 'games/a/', desc: 'ok'},
      {slug: 'a', title: '重复', url: 'games/b/', desc: 'ok'},
      {slug: 'Bad Slug', title: 'x', url: 'games/c/', desc: 'ok'}
    ]
  })
  const messages = errors.map((entry) => entry.message).join('\n')
  assert.match(messages, /缺少 title/)
  assert.match(messages, /slug 重复/)
  assert.match(messages, /slug 只能用小写字母/)
})

test('validateGamesData：拦住站内路径写法和脏类型', () => {
  const {errors} = validateGamesData({
    updated: '10/21/2026',
    games: [
      {slug: 'a', title: 'a', url: '/games/a/', desc: 'x', multiplayer: 'yes', added: '2026/10/20', tags: '棋类'},
      {slug: 'b', title: 'b', url: 'games/../etc/', desc: 'x', tags: ['ok', 'ok']}
    ]
  })
  const messages = errors.map((entry) => entry.message).join('\n')
  assert.match(messages, /不要以 \/ 开头/)
  assert.match(messages, /不允许出现 \.\./)
  assert.match(messages, /multiplayer 只能是 true \/ false/)
  assert.match(messages, /tags 必须是数组/)
  assert.match(messages, /YYYY-MM-DD/)
  assert.match(messages, /tags 里有重复项/)
})

test('validateGamesData：顶层结构不对直接返回', () => {
  assert.equal(validateGamesData([]).errors.length, 1)
  assert.equal(validateGamesData({}).errors.length, 1)
  assert.equal(validateGamesData(null).errors.length, 1)
})
