/**
 * **残局关卡的判定逻辑** —— 纯函数，不碰 React、不碰 DOM。
 *
 * ## 一关怎么推进
 *
 * 关卡存的是一条走通的着法线（`Puzzle.line`）：
 * 玩家的着法与对手的应手**交替**，从玩家那手开始。
 *
 *   - 玩家走一步 → 拿 SAN 去比对该 ply 的正解（`san` 或 `also` 里的等价解）；
 *   - 走对了 → 推进；紧接着**对手那手自动走掉**（线里已经存好了）；
 *   - 走错了 → **不推进**，记下来给界面标红，玩家可以重来或用提示。
 *
 * 整条线走完 = 通关。**全程不需要引擎** —— 引擎只在离线生成题库时用过。
 *
 * ## 为什么不把「对手的应手」也交给玩家
 *
 * 那样玩家会走出各种乱七八糟的应手，局面就散了，
 * 关卡也就不再是「一道题」而是「一盘棋」。
 * 残局练习要练的是**自己那一步**，对手怎么应是固定的。
 */
import { Chess } from 'chess.js';
import type { Puzzle, PuzzlePly } from './types';

/** 关卡进行中的状态 */
export interface PuzzleSession {
  /** 当前这关 */
  puzzle: Puzzle;
  /** 已经推进到第几个 ply（0 = 还没走） */
  ply: number;
  /** 玩家走过的着法（SAN，按顺序） */
  playerMoves: string[];
  /** 最近一次走错的着法（界面上标红用）；没有就 null */
  lastWrong: string | null;
  /** 是否已通关 */
  solved: boolean;
}

/** 开一关 */
export function startSession(puzzle: Puzzle): PuzzleSession {
  return { puzzle, ply: 0, playerMoves: [], lastWrong: null, solved: false };
}

/**
 * 棋盘当前该显示的局面。
 *
 * 由「起始局面 + 已推进的 ply 数」算出来，不单独存一份 ——
 * 存两份迟早对不上（跟自由练习的棋谱游标同一个道理）。
 */
export function sessionPosition(session: PuzzleSession): string {
  const { puzzle, ply } = session;
  if (ply <= 0) return puzzle.fen;
  const step = puzzle.line[ply - 1];
  return step ? step.fen : puzzle.fen;
}

/**
 * 当前轮到**玩家**走的那一手（线里 ply 位置上的那一步）。
 *
 * @returns null = 线已经走完（或者这一手轮到对手 —— 不该发生）
 */
export function currentPlayerPly(session: PuzzleSession): PuzzlePly | null {
  const { puzzle, ply } = session;
  if (ply >= puzzle.line.length) return null;
  const step = puzzle.line[ply];
  return step.color === puzzle.side ? step : null;
}

/**
 * 这一手算不算走对。
 *
 * @param san 玩家实际走的着法（SAN）
 */
export function isAcceptedMove(session: PuzzleSession, san: string): boolean {
  const step = currentPlayerPly(session);
  if (!step) return false;
  if (step.san === san) return true;
  return (step.also ?? []).includes(san);
}

/**
 * 玩家走一步之后的状态。
 *
 * @param san 玩家实际走的着法（SAN）
 * @returns 新状态；`ok` 为 false 表示**走错了**（此时 ply 不推进）
 */
export function applyPlayerMove(
  session: PuzzleSession,
  san: string,
): { session: PuzzleSession; ok: boolean } {
  if (session.solved) return { session, ok: false };
  const step = currentPlayerPly(session);
  if (!step) return { session, ok: false };

  if (!isAcceptedMove(session, san)) {
    // 走错：**不推进**，只记下来给界面标红
    return { session: { ...session, lastWrong: san }, ok: false };
  }

  const playerMoves = [...session.playerMoves, san];
  let ply = session.ply + 1;

  /*
   * 对手那手自动走掉。
   *
   * 只有当下一 ply 确实是对手的才走 —— 线可能以玩家的着法结尾
   * （例如「将死」就是玩家最后那一手），这时候没有对手应手。
   */
  const next = puzzleLineAt(session.puzzle, ply);
  if (next && next.color !== session.puzzle.side) ply += 1;

  const nextSession: PuzzleSession = {
    ...session,
    ply,
    playerMoves,
    lastWrong: null,
  };

  return {
    session: { ...nextSession, solved: isSolved(nextSession) },
    ok: true,
  };
}

/** 取线里的第 n 手（越界返回 null） */
function puzzleLineAt(puzzle: Puzzle, index: number): PuzzlePly | null {
  if (index < 0 || index >= puzzle.line.length) return null;
  return puzzle.line[index];
}

/**
 * 这关是不是**通关**了。
 *
 * 条件：线走完了，**并且**终局局面确实达成了目标。
 *
 * 「走完线」不等于「达成目标」—— 比如目标是「守和」，
 * 终局必须真的是和棋（僵局 / 子力不足 / 五十回合）才算数。
 */
export function isSolved(session: PuzzleSession): boolean {
  const { puzzle, ply } = session;
  if (ply < puzzle.line.length) return false;
  return goalReached(puzzle, sessionPosition(session));
}

/**
 * 终局局面是否达成了这一关的目标。
 *
 * 各目标的判据：
 *   - `mate`   —— 对方被将死（终局轮到对方，且是绝杀）；
 *   - `draw`   —— 真的是和棋；
 *   - `promote`—— 最后一手是升变（SAN 里有 `=`）；
 *   - `win`    —— 终局没结束（靠子力取胜，引擎离线确认过是胜局），
 *                 或者终局结束且是对方被将死。
 */
export function goalReached(puzzle: Puzzle, finalFen: string): boolean {
  let game: Chess;
  try {
    game = new Chess(finalFen);
  } catch {
    return false;
  }

  switch (puzzle.goal) {
    case 'mate':
      // 轮到走的一方被将死 = 对方赢了
      return game.isCheckmate();
    case 'draw':
      return game.isDraw();
    case 'promote': {
      const last = puzzle.line[puzzle.line.length - 1];
      return Boolean(last && last.san.includes('='));
    }
    case 'win':
      if (!game.isGameOver()) return true; // 引擎离线确认是胜局
      return game.isCheckmate() && game.turn() !== puzzle.side;
    default:
      return false;
  }
}

/**
 * 提示：当前该走的那一手。
 *
 * 返回的是**完整的一步**（着法 + 走完的局面），界面可以高亮起止格，
 * 也可以直接把这步走掉。
 */
export function hintFor(session: PuzzleSession): PuzzlePly | null {
  return currentPlayerPly(session);
}

/** 这一关玩家的着法一共几步（线里玩家那手有多少个） */
export function playerMoveCount(puzzle: Puzzle): number {
  return puzzle.line.filter((step) => step.color === puzzle.side).length;
}
