/**
 * **自由练习的历史游标** —— 纯逻辑层（不碰 React）。
 *
 * 练习要能「上一步 / 下一步」来回走 —— 走错了不用重开，
 * 退回去改一步再继续下。
 *
 * ## 三个量
 *
 * - `startFen` —— 练习的**起始局面**（摆棋定下来的那个）；
 * - `steps` —— 棋谱（每一步都带着**走完之后**的局面）；
 * - `cursor` —— 游标：已经走了几手（0 = 起始局面）。
 *
 * 局面永远由这三个量**算出来**，不单独存一份 —— 存两份就会对不上。
 */
import type { Color } from '../types';

/** 自由练习记下的一手 */
export interface PracticeStep {
  /** 标准记谱（SAN） */
  san: string;
  /** 走这步的是哪一方 */
  color: Color;
  /** 起点 */
  from: string;
  /** 终点 */
  to: string;
  /** 走完这手**之后**的局面 */
  fen: string;
}

/**
 * 第 cursor 手之后的局面。
 *
 * @param startFen 起始局面
 * @param steps    棋谱
 * @param cursor   已经走了几手（0 = 起始局面）
 */
export function positionAt(startFen: string, steps: PracticeStep[], cursor: number): string {
  // 游标越界时**夹回合法范围** —— 越界不是「回到开局」，而是「停在最后」
  const n = Math.max(0, Math.min(cursor, steps.length));
  if (n <= 0) return startFen;
  const step = steps[n - 1];
  return step ? step.fen : startFen;
}

/**
 * 落新的一手：**先把游标之后的棋谱截断**，再追加这一手。
 *
 * 为什么截断：在中间位置落子 = 换了一条线，后面的旧着法不再成立
 * （跟棋谱编辑器一个道理：改了这一手，后面的就不是同一盘棋了）。
 *
 * @param steps  现有棋谱
 * @param cursor 游标（已经走了几手）
 * @param step   新落下的这一手
 */
export function pushStep(
  steps: PracticeStep[],
  cursor: number,
  step: PracticeStep,
): PracticeStep[] {
  const cut = Math.max(0, Math.min(cursor, steps.length));
  return [...steps.slice(0, cut), step];
}
