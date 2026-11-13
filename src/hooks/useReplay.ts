'use client';

/**
 * **复盘**状态机 —— 纯本地，每个用户各看各的。
 *
 * ## 状态
 *
 * - `cursor` —— 棋谱上的第几手（0 = 开局，N = 走完）。
 * - `free` —— **自由走棋沙盒**是否开着。
 * - `freeFen` —— 沙盒里的当前局面。
 *
 * ## 三个按钮
 *
 * - **上一步 / 下一步** —— 沿棋谱前后走（`cursor ± 1`）。
 * - **还原** —— 两条含义，**按有没有自由走棋分开**：
 *   - 没自由走棋 → 回到**开局**（`cursor = 0`）；
 *   - 有自由走棋 → 回到**自由走棋之前**的棋盘（沙盒一关，棋谱游标不动）。
 *
 * ## 自由走棋之后为什么藏掉「上一步 / 下一步」
 *
 * 沙盒里的局面**不在棋谱上** —— 让「下一步」在沙盒里继续走棋谱，
 * 棋盘会从「我随便走的一步」直接跳到「棋谱里的下一手」，
 * 两边根本不是同一个局面的相邻两步，跳得没有道理。
 *
 * 所以规则统一成：**进了沙盒就只剩「还原」**，
 * 还原回到沙盒之前，步进键才重新出现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildReplaySteps, applyFreeMove, positionAt, type ReplayStep } from '@/lib/replay';
import type { MoveRecord, PieceType } from '@/lib/types';

export interface ReplayController {
  /** 复盘是否开着 */
  active: boolean;
  /** 棋谱游标：已经走了几手 */
  cursor: number;
  /** 棋谱总手数 */
  total: number;
  /** 当前该显示的局面 */
  fen: string;
  /** 走到当前这一步的那一步（画走子箭头用；开局那一步是 null） */
  lastStep: ReplayStep | null;
  /** 是否在自由走棋沙盒里 */
  free: boolean;
  /** 「上一步」能不能点 */
  canPrev: boolean;
  /** 「下一步」能不能点 */
  canNext: boolean;
  /** 开始复盘（从棋局结束处进入，棋盘不跳） */
  start: () => void;
  /** 退出复盘 */
  stop: () => void;
  /** 上一步（沿棋谱） */
  prev: () => void;
  /** 下一步（沿棋谱） */
  next: () => void;
  /** 还原 */
  reset: () => void;
  /** 自由走棋一步；非法着法返回 false */
  move: (from: string, to: string, promotion?: PieceType) => boolean;
}

/**
 * @param moves 服务端的走子记录（棋谱）
 * @param canReplay 这一局是不是**刚刚结束** —— 只有这时候复盘才成立
 */
export function useReplay(moves: MoveRecord[], canReplay: boolean): ReplayController {
  /*
   * 棋谱的**内容签名**。
   *
   * 为什么不能直接拿 `moves` 当依赖：
   *   服务端**每秒**广播一次房间快照，走子记录每次都是**新数组**
   *   （publicView 里 `moves.map(m => ({...m}))`）——
   *   按数组身份算，签名每秒都变，棋谱会被反复重放，
   *   「复盘状态复位」的效果也会每秒触发一次（复盘直接被踢回终点）。
   *
   * 所以用「手数 + 最后一手的时间戳」当签名：
   *   - 走一步 → 手数变 ✓
   *   - 悔棋 / 新一局 → 手数变 ✓
   *   - 每秒的棋钟广播 → 两项都不变 ✓
   */
  const signature = `${moves.length}:${moves[moves.length - 1]?.ts ?? 0}`;
  const movesRef = useRef(moves);
  movesRef.current = moves;

  const steps = useMemo(
    () => buildReplaySteps(movesRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  /** 用户点了「复盘」没有（这一局结束之后才点得着） */
  const [started, setStarted] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** 沙盒局面（null = 没进沙盒） */
  const [freeFen, setFreeFen] = useState<string | null>(null);
  /** 沙盒里最后走的那一步（画箭头用） */
  const [freeStep, setFreeStep] = useState<ReplayStep | null>(null);

  /*
   * 这一局**不再刚刚结束**了 → 复盘作废。
   *
   * 什么时候会这样：
   *   - 「再来一局」开了新局（`status` 回到 playing）；
   *   - 悔棋把棋局拉回进行中。
   *
   * 为什么必须在这里复位（而不是让页面自己判断）：
   *   复盘开着的时候，棋盘显示的是**复盘的局面**，不是实时局面。
   *   新一局开始后如果复盘还赖着，新一局走了一步，**棋盘纹丝不动** ——
   *   人会以为自己的棋没走上去。
   *   （这个 bug 是生产环境人工验收时撞出来的：状态行还写着「复盘中」，
   *   而棋盘已经不会跟着新局走了。）
   *
   * 复位到「没开过」还有一个好处：下一局结束时**控制器不会自己冒出来** ——
   * 用户得自己再点一次「复盘」。
   */
  useEffect(() => {
    if (!canReplay) {
      setStarted(false);
      setFreeFen(null);
      setFreeStep(null);
    }
  }, [canReplay]);

  /**
   * 复盘开着吗。
   *
   * `&& canReplay` 是**规则本身**：复盘只在这一局**刚刚结束**的时候成立。
   * 这一局还在下（甚至刚刚重开），就一律不算复盘。
   */
  const active = started && canReplay;

  /*
   * 棋谱变了（新一局 / 悔棋）→ 复盘状态复位。
   *
   * 复位成「棋谱的终点」：进复盘时棋盘正好是终局局面，不跳。
   */
  const stepsRef = useRef(steps);
  useEffect(() => {
    stepsRef.current = steps;
    setCursor(steps.length);
    setFreeFen(null);
    setFreeStep(null);
  }, [steps]);

  /** 当前局面：沙盒优先，没有沙盒就是棋谱上的位置 */
  const fen = useMemo(() => {
    if (freeFen !== null) return freeFen;
    return positionAt(steps, cursor);
  }, [freeFen, steps, cursor]);

  /** 走到当前这一步的那一步 */
  const lastStep = useMemo(() => {
    if (freeStep !== null) return freeStep;
    if (cursor <= 0) return null;
    return steps[cursor - 1] ?? null;
  }, [freeStep, steps, cursor]);

  const free = freeFen !== null;

  const start = useCallback(() => {
    setCursor(stepsRef.current.length);
    setFreeFen(null);
    setFreeStep(null);
    setStarted(true);
  }, []);

  const stop = useCallback(() => {
    setStarted(false);
    setFreeFen(null);
    setFreeStep(null);
  }, []);

  const prev = useCallback(() => {
    // 沙盒里没有「上一步」这回事 —— 只有还原能出去
    if (freeFen !== null) return;
    setCursor((c) => Math.max(0, c - 1));
  }, [freeFen]);

  const next = useCallback(() => {
    if (freeFen !== null) return;
    setCursor((c) => Math.min(stepsRef.current.length, c + 1));
  }, [freeFen]);

  /**
   * 还原。
   *
   * - 在沙盒里 → 关掉沙盒，回到**自由走棋之前**的棋盘（游标不动）。
   * - 不在沙盒里 → 回到**开局**。
   */
  const reset = useCallback(() => {
    if (freeFen !== null) {
      setFreeFen(null);
      setFreeStep(null);
      return;
    }
    setCursor(0);
  }, [freeFen]);

  /** 自由走棋一步 */
  const move = useCallback(
    (from: string, to: string, promotion?: PieceType): boolean => {
      const base = freeFen ?? positionAt(stepsRef.current, cursor);
      const result = applyFreeMove(base, from, to, promotion);
      if (!result) return false;
      setFreeFen(result.fen);
      setFreeStep(result.step);
      return true;
    },
    [freeFen, cursor],
  );

  return {
    active,
    cursor,
    total: steps.length,
    fen,
    lastStep,
    free,
    canPrev: !free && cursor > 0,
    canNext: !free && cursor < steps.length,
    start,
    stop,
    prev,
    next,
    reset,
    move,
  };
}
