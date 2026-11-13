/**
 * **复盘**的纯逻辑层（客户端本地算，不上报服务端）。
 *
 * 复盘要解决两件事：
 *  1. **按棋谱重放** —— 服务端记了每一步的 SAN，这里从初始局面逐步重放，
 *     得到「第 N 手之后」的局面。棋谱是唯一事实来源，不重新推导。
 *  2. **自由走棋** —— 复盘时用户能操控**任意一方**的棋子，
 *     而棋盘上同时只有一方「轮到走」（chess.js 的规矩）。
 *
 * ## 自由走棋怎么绕开「只有走子方能动」
 *
 * chess.js 只给**当前走子方**生成着法。所以要让另一方的子也能走，
 * 就得**临时把走子方翻过来**，让那枚棋子成为「走子方」再走。
 *
 * 翻面时必须**清掉吃过路兵格（FEN 第 3 段）**：
 *   ep 格只在「刚刚双步兵推进」之后才有意义，且只属于**对方**。
 *   留着它翻面，等于凭空给对方一个吃过路兵的机会 —— 那个格上根本没有兵可吃。
 *
 * 翻面后走子，走子方自然变成「对手」，
 * 于是自由走棋的规则统一成一句话：**走完之后，轮到走子方的对手**。
 *
 * 代价：沙盒里走子之后，**吃过路兵的权利会丢**（ep 格被清掉）。
 * 这是探索用的沙盒，丢一次 ep 权可以接受；反过来留着一个假的 ep 格
 * 会让棋规本身说谎 —— 那不能接受。
 */
import { Chess } from 'chess.js';
import { START_FEN } from './constants';
import { fenTurn, legalTargets, pieceAt, type LegalTarget } from './chess-engine';
import type { Color, MoveRecord, PieceType } from './types';

/** 复盘的一步 */
export interface ReplayStep {
  /** 起点 */
  from: string;
  /** 终点 */
  to: string;
  /** 标准记谱（SAN） */
  san: string;
  /** 这一步**之后**的局面 */
  fen: string;
  /** 走这步的是哪一方 */
  color: Color;
  /** 走的什么子 */
  piece: PieceType;
  /** 吃掉的子 */
  captured?: PieceType;
  /** 升变成什么 */
  promotion?: PieceType;
}

/**
 * 把棋谱重放成**带局面**的步骤序列。
 *
 * `steps[i]` = 第 i+1 手，`steps[i].fen` = 走完这手之后的局面。
 * 于是「第 n 手之后的局面」= `n === 0 ? START_FEN : steps[n - 1].fen`。
 *
 * 用 SAN 重放而不是 from/to：SAN 是 chess.js 自己生成的，
 * 消歧（哪个马、哪个车）都已经定好了，不会有歧义。
 *
 * @param moves 服务端的走子记录
 * @returns 重放出来的步骤（棋谱与初始局面不符时**到此为止**，不硬编）
 */
export function buildReplaySteps(moves: MoveRecord[]): ReplayStep[] {
  const game = new Chess(START_FEN);
  const steps: ReplayStep[] = [];
  for (const m of moves) {
    let move;
    try {
      move = game.move(m.san);
    } catch {
      // 棋谱与初始局面对不上 —— 到此为止，别硬编后面的着法
      break;
    }
    steps.push({
      from: move.from,
      to: move.to,
      san: move.san,
      fen: game.fen(),
      color: move.color,
      piece: move.piece,
      captured: move.captured,
      promotion: move.promotion,
    });
  }
  return steps;
}

/**
 * 第 n 手之后的局面。
 *
 * @param steps `buildReplaySteps` 的结果
 * @param n     已经走了几手（0 = 开局）
 */
export function positionAt(steps: ReplayStep[], n: number): string {
  if (n <= 0) return START_FEN;
  const step = steps[n - 1];
  return step ? step.fen : START_FEN;
}

/**
 * 翻转走子方（并**清掉吃过路兵格**）。
 *
 * 见文件头「自由走棋怎么绕开只有走子方能动」。
 */
export function flipSideToMove(fen: string): string {
  const parts = fen.split(' ');
  if (parts.length < 4) return fen;
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

/**
 * 自由走棋：走一步（**任意一方**的子都能走）。
 *
 * @param fen  当前局面
 * @param from 起点
 * @param to   终点
 * @param promotion 升变成什么（兵到底线时必填；不填默认后）
 * @returns 走完之后的局面与这一步；非法着法返回 null
 */
export function applyFreeMove(
  fen: string,
  from: string,
  to: string,
  promotion?: PieceType,
): { fen: string; step: ReplayStep } | null {
  const piece = pieceAt(fen, from);
  if (!piece) return null;

  // 走的不是走子方 → 临时翻面，让它成为走子方
  const base = piece.color === fenTurn(fen) ? fen : flipSideToMove(fen);

  const game = new Chess(base);
  let move;
  try {
    move = game.move({ from, to, promotion: promotion ?? 'q' });
  } catch {
    return null; // 非法着法
  }

  const nextFen = game.fen();
  return {
    fen: nextFen,
    step: {
      from: move.from,
      to: move.to,
      san: move.san,
      fen: nextFen,
      color: move.color,
      piece: move.piece,
      captured: move.captured,
      promotion: move.promotion,
    },
  };
}

/**
 * 自由走棋时，某格的**合法落点**（不管那枚子是哪一方的）。
 *
 * @param fen    当前局面
 * @param square 起点
 */
export function freeTargets(fen: string, square: string): LegalTarget[] {
  const piece = pieceAt(fen, square);
  if (!piece) return [];
  const base = piece.color === fenTurn(fen) ? fen : flipSideToMove(fen);
  return legalTargets(base, square);
}

/**
 * 自由走棋时，这一格能不能起拖（有自己的合法着）。
 */
export function freeCanDragFrom(fen: string, square: string): boolean {
  return freeTargets(fen, square).length > 0;
}
