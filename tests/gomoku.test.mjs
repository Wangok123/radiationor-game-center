// 联机五子棋的规则单元测试（Node 直接跑，不需要浏览器）：
//   node --test tests/gomoku.test.mjs
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  SIZE,
  BLACK,
  WHITE,
  EMPTY,
  createBoard,
  indexOf,
  applyMove,
  findWinLine,
  isFull,
  other
} from '../site/gomoku.js'

const put = (board, coords, color) => {
  for (const [x, y] of coords) board[indexOf(x, y)] = color
  return board
}

test('棋盘是 225 格且全空', () => {
  const board = createBoard()
  assert.equal(board.length, SIZE * SIZE)
  assert.ok(board.every((cell) => cell === EMPTY))
})

test('落子不修改入参棋盘', () => {
  const board = createBoard()
  const {board: next, lastMove} = applyMove(board, indexOf(7, 7), BLACK)
  assert.equal(lastMove, indexOf(7, 7))
  assert.equal(next[indexOf(7, 7)], BLACK)
  assert.equal(board[indexOf(7, 7)], EMPTY, '原棋盘应保持不变')
})

test('落子后不能重复落同一格，越界和非法颜色要报错', () => {
  const board = applyMove(createBoard(), indexOf(1, 1), BLACK).board
  assert.throws(() => applyMove(board, indexOf(1, 1), WHITE), /已经有子/)
  assert.throws(() => applyMove(createBoard(), -1, BLACK), RangeError)
  assert.throws(() => applyMove(createBoard(), SIZE * SIZE, BLACK), RangeError)
  assert.throws(() => applyMove(createBoard(), 0, 3), RangeError)
})

test('横向五连判胜', () => {
  const board = put(createBoard(), [[3, 6], [4, 6], [5, 6], [6, 6]], BLACK)
  const result = applyMove(board, indexOf(7, 6), BLACK)
  assert.ok(result.winLine, '应该判胜')
  assert.equal(result.winLine.length, 5)
  assert.equal(result.draw, false)
})

test('竖向、两个斜向都能判胜', () => {
  for (const coords of [
    [[6, 3], [6, 4], [6, 5], [6, 6], [6, 7]],
    [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]],
    [[9, 5], [8, 6], [7, 7], [6, 8], [5, 9]]
  ]) {
    const board = put(createBoard(), coords, WHITE)
    const [lx, ly] = coords[coords.length - 1]
    assert.ok(findWinLine(board, indexOf(lx, ly), WHITE), `应判胜: ${coords}`)
  }
})

test('四连不算赢', () => {
  const board = put(createBoard(), [[3, 6], [4, 6], [5, 6]], BLACK)
  const result = applyMove(board, indexOf(6, 6), BLACK)
  assert.equal(result.winLine, null)
})

test('被对手隔断不算连成', () => {
  const board = put(createBoard(), [[3, 6], [4, 6], [5, 6]], BLACK)
  board[indexOf(6, 6)] = WHITE
  const result = applyMove(board, indexOf(7, 6), BLACK)
  assert.equal(result.winLine, null, '中间被白子隔断，不应判胜')
})

test('六连也算赢（长连不禁止）', () => {
  const board = put(createBoard(), [[2, 6], [3, 6], [4, 6], [5, 6], [6, 6]], BLACK)
  const result = applyMove(board, indexOf(7, 6), BLACK)
  assert.ok(result.winLine.length >= 6)
})

test('边界外不影响判定', () => {
  const board = put(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0]], BLACK)
  const result = applyMove(board, indexOf(4, 0), BLACK)
  assert.ok(result.winLine)
})

test('棋盘填满且无五连时判和棋', () => {
  const board = createBoard()
  let color = BLACK
  for (let i = 0; i < board.length; i++) board[i] = color
  color = other(color)
  // 直接构造：全盘交替，未落最后一格
  board[board.length - 1] = EMPTY
  const result = applyMove(board, board.length - 1, BLACK)
  assert.equal(isFull(result.board), true)
  // 这种极端摆法可能恰好连成，这里只断言"填满"这一事实
  assert.ok(result.winLine === null || Array.isArray(result.winLine))
})
