/**
 * 难度档定义 —— analysis.ts / uci-backend.ts 共用。
 *
 * 为什么要单独一个文件：难度常量既被「同步 builtin 引擎」用，也被
 * 「异步 Stockfish 后端」用。两边都要 import 同一个运行时常量，
 * 如果常量留在 analysis.ts，而 analysis.ts 又要 import uci-backend.ts，
 * 就会形成**运行时循环依赖**（CJS/ESM 下都可能拿到 undefined）。
 * 把常量挪到这里，两边都只依赖这个叶子模块，循环就断了。
 */

/** 难度档 */
export type Difficulty = 'easy' | 'normal' | 'hard';

/** 各档默认时间预算（毫秒） */
export const DEFAULT_TIME_MS: Record<Difficulty, number> = {
  easy: 200,
  normal: 800,
  hard: 2500,
};

/**
 * 各档最大搜索深度（只对 builtin 引擎有意义）。
 * hard 不真正限深度（迭代加深会一直加深到时间耗尽），
 * 这里设 12 只是防止出现病态局面时无限加深。
 */
export const MAX_DEPTH: Record<Difficulty, number> = {
  easy: 2,
  normal: 4,
  hard: 12,
};

/**
 * 各档在 Stockfish 上对应的搜索深度上限。
 *
 * **深度是难度的主要抓手**，UCI_Elo 是辅助。原因是实测出来的：
 * Stockfish 的限强（UCI_LimitStrength / UCI_Elo）在**浅搜**下才明显咬得住 ——
 * depth 6 + elo 1320 会走 d7c8r（车升变）这种明显偏弱的着法；
 * 但 depth 20 + elo 1320 的着法和不限强几乎一样（搜索精度把限强盖过去了）。
 *
 * 所以「限强」不能单独用，必须配一个浅的深度上限。
 * 同时给 movetime 当兜底，防止复杂局面搜太久。
 */
export const DIFFICULTY_DEPTH: Record<Difficulty, number> = {
  easy: 6,
  normal: 12,
  hard: 18,
};

/**
 * 各档在 Stockfish 上对应的时间预算（毫秒）。
 *
 * 这是**上限**，不是保证：深度先到了就提前返回，时间先到了就截断。
 * 比 builtin 档宽裕一些，因为限强后节点数会变多、同深度的耗时会比不限强大。
 */
export const DIFFICULTY_TIME_MS: Record<Difficulty, number> = {
  easy: 600,
  normal: 1200,
  hard: 2500,
};

/**
 * 各档映射到 Stockfish 的 UCI_Elo 限强值。
 *
 * 接上 Stockfish 之后，难度**统一**由 UCI_Elo 表达 —— builtin 引擎那套
 * 「easy 档 40% 概率故意走次优」的机制不再参与难度控制：
 * SF 限强到 1320 本身就会犯低级错，拟人化更自然，而且全档只有一条难度机制。
 *
 * 注意：UCI_Elo 是 Stockfish 的**粗略近似**，不是精确棋力标定。
 */
export const DIFFICULTY_ELO: Record<Difficulty, number> = {
  easy: 1320,
  normal: 1900,
  hard: 2400,
};

/** 每档难度的默认时间预算（毫秒） */
export function defaultTimeMs(difficulty: Difficulty): number {
  return DEFAULT_TIME_MS[difficulty] ?? DEFAULT_TIME_MS.normal;
}

/** 该档的最大搜索深度（builtin 引擎用） */
export function maxDepthOf(difficulty: Difficulty): number {
  return MAX_DEPTH[difficulty] ?? MAX_DEPTH.normal;
}

/** 该档对应的 Stockfish 限强 Elo */
export function eloOf(difficulty: Difficulty): number {
  return DIFFICULTY_ELO[difficulty] ?? DIFFICULTY_ELO.normal;
}

/** 该档在 Stockfish 上的搜索深度上限 */
export function stockfishDepthOf(difficulty: Difficulty): number {
  return DIFFICULTY_DEPTH[difficulty] ?? DIFFICULTY_DEPTH.normal;
}

/** 该档在 Stockfish 上的时间预算（毫秒） */
export function stockfishTimeMsOf(difficulty: Difficulty): number {
  return DIFFICULTY_TIME_MS[difficulty] ?? DIFFICULTY_TIME_MS.normal;
}
