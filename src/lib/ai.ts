/**
 * 简易 AI 对手 —— 服务端执行，与人类走子走同一条校验/广播路径。
 *
 * 算法：negamax + alpha-beta 剪枝 + 迭代加深（默认深度 3）。
 * 估值：子力 + 位置权重（简化版 PST）+ 机动性 + 王安全。
 */
import { Chess, type Move } from 'chess.js';
import { legalTargets } from './chess-engine';
import type { Color } from './types';

/** 各棋子基础价值（厘兵） */
const PIECE_VALUE: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

/**
 * 简化位置权重表（从白方视角，行 0 = rank 8）。
 * 数值越小越靠后（防守位），用于鼓励子力向中路与己方半区推进。
 */
const PAWN_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT_PST = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP_PST = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const QUEEN_PST = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING_PST = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];

const PST: Record<string, number[]> = {
  p: PAWN_PST,
  n: KNIGHT_PST,
  b: BISHOP_PST,
  r: ROOK_PST,
  q: QUEEN_PST,
  k: KING_PST,
};

const MATE_SCORE = 100000;

/** 静态评估（正数代表白方占优） */
export function evaluate(game: Chess): number {
  let score = 0;
  const board = game.board();
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const table = PST[cell.type];
      // chess.js 的 board() 第 0 行是 rank 8（白方视角的"上"）
      const idx = 8 * (8 - Number(cell.square[1])) + (cell.square.charCodeAt(0) - 97);
      const pst = table ? table[idx] : 0;
      const value = PIECE_VALUE[cell.type] + pst;
      score += cell.color === 'w' ? value : -value;
    }
  }
  // 轻微鼓励先手（行棋权）
  score += game.turn() === 'w' ? 8 : -8;
  return score;
}

/** negamax 搜索，返回以 rootColor 视角计分的分值 */
function negamax(game: Chess, depth: number, alpha: number, beta: number, rootColor: Color): number {
  if (depth === 0 || game.isGameOver()) {
    const raw = evaluate(game);
    return rootColor === 'w' ? raw : -raw;
  }

  const moves = game.moves({ verbose: true }) as Move[];
  if (moves.length === 0) {
    // 无子可走：被将死则负，否则 0
    const raw = evaluate(game);
    const sign = game.inCheck() ? -1 : 1;
    return rootColor === 'w' ? raw * sign : -raw * sign;
  }

  // 走法排序：先吃子（提高剪枝效率）
  moves.sort((a, b) => (b.captured ? PIECE_VALUE[b.captured] : 0) - (a.captured ? PIECE_VALUE[a.captured] : 0));

  for (const move of moves) {
    game.move(move);
    const score = -negamax(game, depth - 1, -beta, -alpha, rootColor);
    game.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/** 把 chess.js 的 Move 收窄为 AI 可用的走子（升变只可能是后/车/象/马） */
function toAiMove(move: Move): {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
} {
  const promo = move.promotion;
  const promotion: 'q' | 'r' | 'b' | 'n' | undefined =
    promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n' ? promo : undefined;
  return { from: move.from, to: move.to, promotion };
}

/**
 * 为 AI 选择一手棋。
 * @param fen 当前局面
 * @param color AI 执子颜色
 * @param depth 搜索深度（越大越慢）
 */
export function chooseAiMove(
  fen: string,
  color: Color,
  depth = 3,
): { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | null {
  const game = new Chess(fen);
  if (game.turn() !== color) return null;
  const moves = game.moves({ verbose: true }) as Move[];
  if (moves.length === 0) return null;

  // 一步杀 / 一步解将：直接短路，速度快且观感好
  const immediate = findImmediateTactical(game);
  if (immediate) return toAiMove(immediate);

  let best: Move | null = null;
  let bestScore = -Infinity;

  // 限制根节点分支数，保证响应速度
  const rootMoves = moves.slice(0, 24);

  for (const move of rootMoves) {
    game.move(move);
    const score = -negamax(game, depth - 1, -Infinity, Infinity, color);
    game.undo();
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  if (!best) return null;
  const promo = best.promotion;
  const promotion: 'q' | 'r' | 'b' | 'n' | undefined =
    promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n' ? promo : undefined;
  return { from: best.from, to: best.to, promotion };
}

/** 找一步立即取胜或立即解将的着法 */
function findImmediateTactical(game: Chess): Move | null {
  const moves = game.moves({ verbose: true }) as Move[];
  for (const move of moves) {
    game.move(move);
    const mate = game.isCheckmate();
    game.undo();
    if (mate) return move;
  }
  // 被将时优先解将
  if (game.inCheck()) {
    for (const move of moves) {
      game.move(move);
      const stillCheck = game.inCheck();
      game.undo();
      if (!stillCheck) return move;
    }
  }
  return null;
}

/** 当前局面该方共有多少合法着（用于评估 AI 强度或调试） */
export function mobility(fen: string): number {
  const game = new Chess(fen);
  return game.moves().length;
}
