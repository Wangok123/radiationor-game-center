// 校验 site/games.json：
//   node scripts/validate-games.mjs
//
// 除了字段形状，还会检查站内 url 指向的文件真的存在——收录时手滑打错路径，
// 在这里就能拦住，不用等上线点开 404。

import {readFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {validateGamesData} from './lib/games-schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const siteDir = resolve(here, '..', 'site')
const indexPath = join(siteDir, 'games.json')

const EXTERNAL_RE = /^https?:\/\//i

function resolveInternal(url) {
  const clean = url.split('?')[0].split('#')[0]
  if (!clean) return null
  const target = join(siteDir, clean)
  if (clean.endsWith('/')) return join(target, 'index.html')
  return existsSync(target) ? target : join(target, 'index.html')
}

const raw = await readFile(indexPath, 'utf8')

let data
try {
  data = JSON.parse(raw)
} catch (error) {
  console.error(`✗ games.json 不是合法 JSON：${error.message}`)
  process.exit(1)
}

const {errors, games} = validateGamesData(data)

// 站内路径存在性检查（外链跳过：本站不负责别人的站点活着）
for (const [index, game] of games.entries()) {
  if (!game || typeof game.url !== 'string') continue
  const url = game.url.trim()
  if (!url || EXTERNAL_RE.test(url)) continue
  const target = resolveInternal(url)
  if (!target || !existsSync(target)) {
    errors.push({where: `games[${index}] (${game.slug ?? '?'})`, message: `站内 url 找不到对应文件：site/${url} → 期望 ${target}`})
  }
}

if (errors.length) {
  console.error(`✗ games.json 有 ${errors.length} 处问题：`)
  for (const {where, message} of errors) console.error(`  - ${where}: ${message}`)
  process.exit(1)
}

const internal = games.filter((game) => !EXTERNAL_RE.test(String(game.url))).length
const external = games.length - internal
console.log(`✓ games.json 正常：${games.length} 款游戏（站内 ${internal} / 外链 ${external}），更新时间 ${data.updated ?? '未标注'}`)
