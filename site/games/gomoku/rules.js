// 五子棋规则：纯函数，不碰 DOM，方便直接在 Node 里跑测试。
//
// 棋盘是一维数组，索引 i 对应 (x, y) = (i % SIZE, floor(i / SIZE))。
// 0 空、1 黑、2 白。座位号直接复用颜色号，省一层映射。

export const SIZE = 15
export const WIN_LENGTH = 5
export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

const DIRECTIONS = [
  [1, 0], // 横
  [0, 1], // 竖
  [1, 1], // 撇
  [1, -1] // 捺
]

export const other = (color) => (color === BLACK ? WHITE : BLACK)

export const createBoard = () => new Array(SIZE * SIZE).fill(EMPTY)

export const indexOf = (x, y) => y * SIZE + x

export const coordsOf = (index) => ({x: index % SIZE, y: Math.floor(index / SIZE)})

export const isFull = (board) => board.every((cell) => cell !== EMPTY)

/**
 * 从最后落子处向外数，返回构成五连的格子索引；没连成返回 null。
 */
export function findWinLine(board, index, color) {
  const {x, y} = coordsOf(index)
  for (const [dx, dy] of DIRECTIONS) {
    const line = [index]
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[indexOf(cx, cy)] === color) {
        line.push(indexOf(cx, cy))
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (line.length >= WIN_LENGTH) return line.sort((a, b) => a - b)
  }
  return null
}

/**
 * 落子。返回新棋盘（不改入参），附带胜负结果。
 */
export function applyMove(board, index, color) {
  if (index < 0 || index >= board.length) throw new RangeError(`落子越界: ${index}`)
  if (board[index] !== EMPTY) throw new Error(`这里已经有子了: ${index}`)
  if (color !== BLACK && color !== WHITE) throw new RangeError(`非法颜色: ${color}`)

  const next = board.slice()
  next[index] = color
  const winLine = findWinLine(next, index, color)
  return {board: next, winLine, draw: !winLine && isFull(next), lastMove: index}
}
