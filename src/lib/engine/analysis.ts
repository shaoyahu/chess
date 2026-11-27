/**
 * 引擎对外 API —— 难度分档与「局面 → 推荐着法」。
 *
 * 这一层是纯同步、无副作用的：WS 服务端可以直接调用，
 * 也可以让常驻子进程（src/server/engine-worker.ts）调用。
 *
 * 安全网：搜索引擎自己有一套走法生成，但它写的是位运算，
 * 万一哪里写错了，返回的着法可能不合法。所以这里统一用 chess.js 再复核一次，
 * 不合法就退回 chess.js 的第一着——宁可给个平庸的着法，也不能给个非法着法。
 */
import { Chess, type Move } from 'chess.js';
import type { Color } from '../types';
import { searchPosition, mateDistanceFromScore, type SearchOutcome } from './search';
import {
  DEFAULT_TIME_MS,
  MAX_DEPTH,
  defaultTimeMs,
  maxDepthOf,
  type Difficulty,
} from './difficulty';
import { StockfishBackend, StockfishUnavailableError } from './uci-backend';

export { defaultTimeMs, maxDepthOf };
export type { Difficulty };

/** 引擎推荐的着法 */
export interface EngineMove {
  from: string;
  to: string;
  /** 升变（兵到底线时必须带上） */
  promotion?: 'q' | 'r' | 'b' | 'n';
}

export interface AnalyzeOptions {
  /** 难度档；缺省 'normal' */
  difficulty?: Difficulty;
  /** 搜索时间预算（毫秒）；缺省取 defaultTimeMs(difficulty) */
  timeMs?: number;
  /**
   * 是否按难度限强（Stockfish 后端）。
   *
   * - 缺省 true：AI 对局用，难度映射成 UCI_Elo（1320/1900/2400）。
   * - 传 false：**满血引擎**，不限强 —— 「辅助下棋」必须用这个，
   *   否则推荐会被 easy 档的限强拖成平庸着法。
   *
   * builtin 引擎没有限强概念，这个字段对它无效。
   */
  limitStrength?: boolean;
  /**
   * 搜索深度上限（**只对 Stockfish 后端有意义**）。
   *
   * 不传就按难度取 stockfishDepthOf(difficulty)。
   * 注意：限强（limitStrength=true）必须配深度才生效，原因见 difficulty.ts 的说明。
   */
  depth?: number;
}

/** easy 档故意走「不是最佳但合法」的着法的概率 */
const EASY_BLUNDER_RATE = 0.4;

/** easy 档只在「排好序的前几着」里挑次优解 */
const EASY_POOL = 5;

/**
 * 分析局面，返回推荐着法；无着可走返回 null。
 *
 * @param fen 当前局面
 * @param color 要走哪一方（不是该方走棋时返回 null）
 * @param opts 难度与时间预算
 */
export function analyzePosition(
  fen: string,
  color: Color,
  opts: AnalyzeOptions = {},
): EngineMove | null {
  const outcome = analyzePositionDetailed(fen, color, opts);
  return outcome.move;
}

/** 带统计信息的分析结果（给 UI 显示「引擎想了多久 / 多深」用） */
export interface AnalyzeResult {
  move: EngineMove | null;
  /** 完成的搜索深度 */
  depth: number;
  /** 搜索节点数 */
  nodes: number;
  /** 耗时（毫秒） */
  elapsedMs: number;
  /** 最佳着法分值（走子方视角，厘兵） */
  score: number;
  /**
   * **杀棋距离**（手，走子方视角）。
   *
   * > 0 = 走子方 N 手内将死对手；< 0 = 走子方 N 手内被将死；
   * > null = 这不是杀棋局面（或引擎没给杀棋分值）。
   *
   * 为什么单独一个字段而不是从 `score` 推：杀棋局面的 `score cp` 是 null，
   * 「一步杀」和「十手杀」在 `score` 上长得一模一样 ——
   * 残局关卡按「几步杀」分难度，靠的就是这个值。
   */
  mateIn: number | null;
  /** 是否因为时间预算耗尽而中断 */
  timedOut: boolean;
}

/**
 * 分析局面并返回完整统计信息。
 */
export function analyzePositionDetailed(
  fen: string,
  color: Color,
  opts: AnalyzeOptions = {},
): AnalyzeResult {
  const difficulty: Difficulty = opts.difficulty ?? 'normal';
  const timeMs = opts.timeMs ?? defaultTimeMs(difficulty);

  // 非法 FEN 直接抛错（上层会转成协议里的 error 字段），局面本身不合法就没法分析
  const game = new Chess(fen);
  if (game.turn() !== color) {
    return { move: null, depth: 0, nodes: 0, elapsedMs: 0, score: 0, mateIn: null, timedOut: false };
  }
  const legal = game.moves({ verbose: true }) as Move[];
  if (legal.length === 0) {
    // 将死 / 逼和：没有可走的着法
    return { move: null, depth: 0, nodes: 0, elapsedMs: 0, score: 0, mateIn: null, timedOut: false };
  }

  const outcome: SearchOutcome = searchPosition(fen, {
    timeMs,
    maxDepth: maxDepthOf(difficulty),
    // easy 档要靠 outcome.moves 的排序挑「次优着法」，
    // 所以根节点必须给出精确可比分值（PVS 的界值排序会挑错着法）。
    exactRootScores: difficulty === 'easy',
  });

  const best = outcome.best;
  let chosen = best;
  if (best && difficulty === 'easy' && outcome.moves.length > 1) {
    // easy 档：有机会故意走一步「不是最佳但合法」的着法。
    // 但两种情况不作弊：已经能绝杀的时候必须绝杀；候选着法会让对手立刻绝杀时跳过。
    const bestIsMate = isCheckmateAfter(game, best);
    if (!bestIsMate && Math.random() < EASY_BLUNDER_RATE) {
      const weaker = pickWeakerMove(game, outcome.moves);
      if (weaker) chosen = weaker;
    }
  }

  const move = chosen ? validateMove(game, chosen) : null;

  return {
    move,
    depth: outcome.depth,
    nodes: outcome.nodes,
    elapsedMs: outcome.elapsedMs,
    score: outcome.score,
    /** 杀棋距离（手）；不是杀棋局面时为 null */
    mateIn: mateDistanceFromScore(outcome.score),
    timedOut: outcome.timedOut,
  };
}

/**
 * 用 chess.js 复核着法是否合法；不合法就退回 chess.js 的第一着。
 * 宁可给个平庸着法，也不能给个非法着法（服务端会拒绝非法着法）。
 */
function validateMove(game: Chess, move: EngineMove): EngineMove {
  const probe = new Chess(game.fen());
  try {
    probe.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
    return move;
  } catch {
    const legal = game.moves({ verbose: true }) as Move[];
    const first = legal[0];
    if (!first) {
      return { from: move.from, to: move.to };
    }
    const out: EngineMove = { from: first.from, to: first.to };
    if (first.promotion === 'q' || first.promotion === 'r' || first.promotion === 'b' || first.promotion === 'n') {
      out.promotion = first.promotion;
    }
    return out;
  }
}

/** 走完这一步之后，对手是不是已经被绝杀 */
function isCheckmateAfter(game: Chess, move: EngineMove): boolean {
  const probe = new Chess(game.fen());
  try {
    probe.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
  } catch {
    return false;
  }
  return probe.isCheckmate();
}

/**
 * easy 档挑一个「不是最佳」的着法。
 * 只从前几着里挑，并且跳过会让对手立刻绝杀的着法（那种「送将」太蠢了，不像新手失误）。
 */
function pickWeakerMove(game: Chess, ranked: { move: EngineMove; score: number }[]): EngineMove | null {
  const pool = ranked.slice(1, EASY_POOL + 1).filter((r) => !allowsImmediateMate(game, r.move));
  if (pool.length === 0) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return picked.move;
}

/** 走完这一步之后，对手有没有一步绝杀 */
function allowsImmediateMate(game: Chess, move: EngineMove): boolean {
  const probe = new Chess(game.fen());
  try {
    probe.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
  } catch {
    return true;
  }
  const replies = probe.moves({ verbose: true }) as Move[];
  for (const reply of replies) {
    probe.move(reply);
    const mate = probe.isCheckmate();
    probe.undo();
    if (mate) return true;
  }
  return false;
}

/**
 * 引擎后端种类
 *
 * - `auto`（缺省）：优先 Stockfish，**不可用时自动降级**到自研引擎。
 * - `stockfish`：只用 Stockfish；不可用就抛错（不静默降级）。
 * - `builtin`：只用自研引擎（同步搜索）。
 */
export type EngineBackendKind = 'auto' | 'stockfish' | 'builtin';

export interface AsyncAnalyzeOptions extends AnalyzeOptions {
  /** 后端选择；缺省 'auto' */
  backend?: EngineBackendKind;
  /**
   * 外部注入的 Stockfish 后端实例。
   *
   * 常驻子进程应该自己持有一个实例（引擎进程很贵，不能每次分析都重开）；
   * 不传的话这里会临时创建一个、用完就关掉 —— 适合一次性调用。
   */
  stockfish?: StockfishBackend;
}

/**
 * 异步分析局面（可走 Stockfish）。
 *
 * 与同步的 {@link analyzePositionDetailed} 的区别：
 *  - 能用 Stockfish（棋力强得多）；
 *  - 是异步的（Stockfish 是外部进程，搜索要等它回话）。
 *
 * @param fen 当前局面
 * @param color 要走哪一方
 * @param opts 后端选择、难度、时间预算
 */
export async function analyzePositionDetailedAsync(
  fen: string,
  color: Color,
  opts: AsyncAnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const backend: EngineBackendKind = opts.backend ?? 'auto';
  if (backend === 'builtin') {
    return analyzePositionDetailed(fen, color, opts);
  }

  const injected = opts.stockfish;
  let own: StockfishBackend | null = null;
  let sf = injected;
  if (!sf) {
    try {
      sf = new StockfishBackend();
      await sf.start();
      own = sf;
    } catch (err) {
      // 显式要求 stockfish 就必须报错；auto 模式才降级
      if (backend === 'stockfish') throw err;
      return analyzePositionDetailed(fen, color, opts);
    }
  }

  try {
    return await sf.analyze(fen, color, opts);
  } catch (err) {
    if (backend === 'stockfish') {
      if (err instanceof StockfishUnavailableError) throw err;
      throw err;
    }
    return analyzePositionDetailed(fen, color, opts);
  } finally {
    if (own) own.close();
  }
}

/**
 * 异步分析局面，返回推荐着法；无着可走返回 null。
 * 语义与 {@link analyzePosition} 一致，只是可以走 Stockfish 且是异步的。
 */
export async function analyzePositionAsync(
  fen: string,
  color: Color,
  opts: AsyncAnalyzeOptions = {},
): Promise<EngineMove | null> {
  const result = await analyzePositionDetailedAsync(fen, color, opts);
  return result.move;
}
