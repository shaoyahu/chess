/**
 * **摆棋** —— 自由练习里「自己摆放双方棋子」的纯逻辑层。
 *
 * 为什么不用 FEN 当中间态：
 *   摆到一半的棋盘很可能**没有王**（或者有两个王），而 FEN 是被 chess.js
 *   严格校验的格式 —— 缺王、兵站错排都会让 `new Chess(fen)` 直接抛错。
 *   所以摆棋阶段的「事实来源」是**摆法表**（格 → 棋子），
 *   只有在**开始练习**那一刻才拼成 FEN 并做校验。
 *
 * 棋盘上摆好的每一手，都必须经得起 chess.js 的检查 ——
 * 所以拼出来的 FEN 一律再喂回 chess.js 验一遍（见 `placementToFen` 的注释）。
 */
import { Chess } from 'chess.js';
import { START_FEN } from '../constants';
import type { Color, PieceType } from '../types';

/** 摆在某一格上的棋子 */
export interface PlacedPiece {
  type: PieceType;
  color: Color;
}

/** 摆法表：格名 → 棋子 */
export type Placement = Map<string, PlacedPiece>;

/** 六种棋子（王后车象马兵） */
export const PIECE_TYPES: readonly PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'] as const;

/** 棋子的中文名 */
export const PIECE_LABEL: Record<PieceType, string> = {
  k: '王',
  q: '后',
  r: '车',
  b: '象',
  n: '马',
  p: '兵',
};

/** 读一个 FEN 的摆法 */
export function placementFromFen(fen: string): Placement {
  const placement: Placement = new Map();
  const game = new Chess(fen);
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell) continue;
      placement.set(cell.square, {
        type: cell.type as PieceType,
        color: cell.color as Color,
      });
    }
  }
  return placement;
}

/** 标准摆法（初始局面） */
export function standardPlacement(): Placement {
  return placementFromFen(START_FEN);
}

/** 空棋盘 */
export function emptyPlacement(): Placement {
  return new Map();
}

/**
 * 摆法 → FEN。
 *
 * 王车易位权按**起始位置**判定（王还在 e1/e8、车还在 h1/a1/h8/a8 才有），
 * 吃过路兵格一律写 `-`（摆棋阶段没人关心吃过路兵）。
 *
 * @param turn 谁先走
 */
export function placementToFen(placement: Placement, turn: Color): string {
  const ranks: string[] = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const square = `${String.fromCharCode(97 + file)}${rank}`;
      const piece = placement.get(square);
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    if (empty > 0) row += String(empty);
    ranks.push(row);
  }
  const board = ranks.join('/');
  return `${board} ${turn} ${castlingRights(placement)} - 0 1`;
}

/** 王车易位权 */
function castlingRights(placement: Placement): string {
  let rights = '';
  const is = (square: string, type: PieceType, color: Color): boolean => {
    const piece = placement.get(square);
    return Boolean(piece && piece.type === type && piece.color === color);
  };
  if (is('e1', 'k', 'w')) {
    if (is('h1', 'r', 'w')) rights += 'K';
    if (is('a1', 'r', 'w')) rights += 'Q';
  }
  if (is('e8', 'k', 'b')) {
    if (is('h8', 'r', 'b')) rights += 'k';
    if (is('a8', 'r', 'b')) rights += 'q';
  }
  return rights || '-';
}

/**
 * 摆法是否合法。
 *
 * 判据与 chess.js 的 FEN 校验保持一致（少一条都对不上）：
 *  1. 双方**各恰好一个王**；
 *  2. 兵不能站在第一排 / 第八排（那里没有升变）。
 *
 * @returns 错误文案；合法时返回 null
 */
export function validatePlacement(placement: Placement): string | null {
  const kings: Record<Color, number> = { w: 0, b: 0 };
  for (const [square, piece] of placement) {
    if (piece.type === 'k') kings[piece.color] += 1;
    if (piece.type === 'p' && (square[1] === '1' || square[1] === '8')) {
      return '兵不能站在第一排或第八排';
    }
  }
  if (kings.w === 0) return '白方缺一个王';
  if (kings.b === 0) return '黑方缺一个王';
  if (kings.w > 1) return '白方不能有两个王';
  if (kings.b > 1) return '黑方不能有两个王';
  return null;
}

/**
 * 摆法 → FEN，并在**开始练习**前做最终校验。
 *
 * @returns 合法时返回 FEN；不合法时返回 `{ error }`
 */
export function buildPracticeFen(
  placement: Placement,
  turn: Color,
): { fen: string; error: null } | { fen: null; error: string } {
  const error = validatePlacement(placement);
  if (error) return { fen: null, error };
  const fen = placementToFen(placement, turn);
  // 最后一道保险：拼出来的 FEN 必须能被 chess.js 接受（规则只认它）
  try {
    new Chess(fen);
  } catch {
    return { fen: null, error: '这个摆法不是合法局面' };
  }
  return { fen, error: null };
}

/** 在某个格子放子（同格覆盖） */
export function placePiece(
  placement: Placement,
  square: string,
  piece: PlacedPiece,
): Placement {
  const next: Placement = new Map(placement);
  next.set(square, piece);
  return next;
}

/** 拿走某个格子的子 */
export function removePiece(placement: Placement, square: string): Placement {
  const next: Placement = new Map(placement);
  next.delete(square);
  return next;
}
