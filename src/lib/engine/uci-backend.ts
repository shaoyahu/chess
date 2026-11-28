/**
 * Stockfish 后端 —— 用 UCI 引擎实现 analyzePositionDetailed 的接口。
 *
 * 定位：这是「引擎后端」而不是「另一个 API」。
 * 上层（engine-worker）只管问「这个局面走什么」，不关心背后是自研引擎还是 Stockfish。
 *
 * 两套后端的语义必须对齐：
 *  - score 都是**走子方视角**的厘兵（UCI 协议的 `score cp` 就是这个视角）；
 *  - depth 是实际完成的搜索深度；
 *  - 着法一律用 chess.js 复核过 —— 引擎再强也可能给出不符合我们规则的着法，
 *    而服务端会拒绝非法着法，宁可给个平庸的也不能给个非法着法。
 */
import { Chess, type Move } from 'chess.js';
import { UciEngine, type UciBestMove, type UciEngineLike } from './uci';
import { discoverEngineSource, type EngineSource } from './engine-source';
import { eloOf, stockfishDepthOf, stockfishTimeMsOf, type Difficulty } from './difficulty';
import type { AnalyzeOptions, AnalyzeResult, EngineMove } from './analysis';

/** 默认每个引擎实例的哈希表大小（MB） */
const DEFAULT_HASH_MB = 64;

/** 默认线程数（不设成 CPU 核数是因为会开多个引擎实例，见 setThreads） */
const DEFAULT_THREADS = 2;

/**
 * 从环境变量里读一个正整数。
 *
 * 为什么要有这层：引擎的**哈希表大小**和**线程数**在两端的最优值不一样 ——
 * 本机开发想开大一点（搜索更稳），共享生产机上必须开小一点
 * （内存就那么多，哈希开大就把它顶爆）。
 * 写死在代码里只能二选一，做成环境变量则各按各的来。
 *
 * 优先级（见 `start()`）：显式传参 > 环境变量 > 内置默认值。
 */
function positiveIntFromEnv(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** 哈希表大小（MB）：`STOCKFISH_HASH_MB` 可以覆盖 */
export function hashMbFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  return positiveIntFromEnv(env, 'STOCKFISH_HASH_MB');
}

/** 线程数：`STOCKFISH_THREADS` 可以覆盖 */
export function threadsFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  return positiveIntFromEnv(env, 'STOCKFISH_THREADS');
}

/**
 * 引擎不可用 / 出错。
 * 上层据此决定要不要降级到自研引擎。
 */
export class StockfishUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockfishUnavailableError';
  }
}

/** 后端可用的运行参数 */
export interface StockfishBackendOptions {
  /** 引擎来源；不传就自己发现 */
  source?: EngineSource;
  /** 线程数 */
  threads?: number;
  /** 哈希表大小（MB） */
  hashMb?: number;
  /** 引擎启动与握手的超时（毫秒） */
  startupTimeoutMs?: number;
  /**
   * 引擎实例工厂（测试注入缝）。
   *
   * 默认 spawn 真的 Stockfish；门禁注入**假引擎**，
   * 用来确定性地断言「限强开关 / Elo / 深度」到底有没有下到引擎上。
   */
  engineFactory?: (command: string, args: string[]) => UciEngineLike;
}

/**
 * 一个常驻的 Stockfish 实例。
 *
 * 生命周期：懒启动（第一次 analyze 时才 spawn）→ 反复复用 → close() 释放。
 * 引擎进程很贵（原生 SF 要几百 MB 内存），所以**不要**每次分析都重开一个。
 */
export class StockfishBackend {
  private engine: UciEngineLike | null = null;
  private startPromise: Promise<void> | null = null;
  private currentElo: number | null = null;
  private currentLimit: boolean | null = null;

  constructor(private readonly opts: StockfishBackendOptions = {}) {}

  /** 引擎来源是否已经确定 */
  get source(): EngineSource | null {
    return this.opts.source ?? null;
  }

  /** 引擎进程是否已就绪 */
  get ready(): boolean {
    return this.engine !== null && this.engine.alive;
  }

  /**
   * 启动引擎（幂等）。
   * @throws StockfishUnavailableError 找不到引擎或启动失败
   */
  async start(): Promise<void> {
    if (this.engine && this.engine.alive) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const source = this.opts.source ?? discoverEngineSource();
      if (!source) {
        throw new StockfishUnavailableError('系统里没找到 Stockfish，也没有装 npm stockfish 包');
      }
      const factory = this.opts.engineFactory ?? ((cmd: string, args: string[]) => new UciEngine(cmd, args));
      const engine = factory(source.command, source.args);
      try {
        await engine.start(this.opts.startupTimeoutMs ?? 20_000);
      } catch (err) {
        engine.terminate();
        throw new StockfishUnavailableError(
          `Stockfish 启动失败（${source.label}）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // 线程数与哈希表：开太高会和并发的其它引擎实例抢 CPU / 内存
      // （环境变量能覆盖，见 hashMbFromEnv / threadsFromEnv 的说明）
      engine.setOption('Threads', this.opts.threads ?? threadsFromEnv() ?? DEFAULT_THREADS);
      engine.setOption('Hash', this.opts.hashMb ?? hashMbFromEnv() ?? DEFAULT_HASH_MB);
      this.engine = engine;
    })();

    try {
      await this.startPromise;
    } catch (err) {
      this.startPromise = null;
      throw err;
    }
  }

  /**
   * 分析局面，返回推荐着法与统计信息。
   *
   * @param fen 当前局面
   * @param color 要走哪一方
   * @param opts 难度、时间预算、是否限强
   */
  async analyze(fen: string, color: 'w' | 'b', opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const started = Date.now();
    const difficulty: Difficulty = opts.difficulty ?? 'normal';

    // 局面对不对得上：轮到别人走 / 没着可走 → 没有推荐
    const game = new Chess(fen);
    if (game.turn() !== color) {
      return { move: null, depth: 0, nodes: 0, elapsedMs: 0, score: 0, mateIn: null, timedOut: false };
    }
    if (game.moves({ verbose: true }).length === 0) {
      return { move: null, depth: 0, nodes: 0, elapsedMs: 0, score: 0, mateIn: null, timedOut: false };
    }

    await this.start();
    const engine = this.engine;
    if (!engine) {
      throw new StockfishUnavailableError('Stockfish 未就绪');
    }

    // 限强开关：辅助下棋要满血引擎（limitStrength: false），AI 对局按难度限强
    const wantLimit = opts.limitStrength !== false;

    // 时间预算与深度上限。
    //
    // **限强必须配深度** —— 这是实测出来的：Stockfish 的 UCI_LimitStrength / UCI_Elo
    // 在浅搜下才明显咬得住（depth 6 + elo 1320 会走 d7c8r 这种明显偏弱的着法），
    // 而 depth 20 + elo 1320 的着法和不带限强几乎一样（搜索精度把限强盖过去了）。
    // 所以「限强」不能单独用，必须配一个随难度递增的深度上限。
    //
    // 不限强时（辅助下棋）不给深度上限，让引擎在时间预算内搜到最深 —— 要的就是最强那档。
    const timeMs = opts.timeMs ?? (wantLimit ? stockfishTimeMsOf(difficulty) : 2000);
    const depth = wantLimit ? (opts.depth ?? stockfishDepthOf(difficulty)) : opts.depth;
    const wantElo = eloOf(difficulty);
    if (this.currentLimit !== wantLimit) {
      engine.setOption('UCI_LimitStrength', wantLimit ? 'true' : 'false');
      this.currentLimit = wantLimit;
      // 开关变了，Elo 必须重设（否则引擎可能保留旧的限强档）
      this.currentElo = null;
    }
    if (wantLimit && this.currentElo !== wantElo) {
      engine.setOption('UCI_Elo', wantElo);
      this.currentElo = wantElo;
    }

    let best: UciBestMove;
    try {
      best = await engine.search({ fen, timeMs, ...(depth !== undefined ? { depth } : {}) });
    } catch (err) {
      throw new StockfishUnavailableError(
        `Stockfish 搜索失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const elapsedMs = Date.now() - started;
    const move = validateMove(game, best);
    return {
      move,
      depth: best.depth,
      nodes: best.nodes,
      elapsedMs,
      score: best.scoreCp ?? 0,
      /** 杀棋距离（手）；不是杀棋局面时为 null */
      mateIn: best.scoreMate ?? null,
      timedOut: elapsedMs >= timeMs,
    };
  }

  /**
   * **一次分析拿到多个候选着法**（MultiPV）。
   *
   * ## 为什么残局关卡需要它
   *
   * 「解说对手走棋」要回答的是「这手为什么好」——
   * 而「好」只能靠**跟同一局面下的其它着法比**才说得清。
   *
   * 逐个着法单独分析有两个问题：
   *   1. 慢：N 个着法 N 次搜索；
   *   2. **分值不可比**：每次搜索都带着上次残留的哈希表，
   *      同一着法两次分析能差二十几厘兵 —— 拿这种分值比高低，比的是噪声。
   *
   * MultiPV 一次搜索给出所有候选，**分值出自同一棵搜索树**，天生可比。
   *
   * @param fen 当前局面
   * @param color 要走哪一方
   * @param opts 深度、候选数、是否清哈希
   */
  async analyzeMulti(
    fen: string,
    color: 'w' | 'b',
    opts: { depth: number; multiPv: number; clearHash?: boolean; timeMs?: number } ,
  ): Promise<{ move: EngineMove; scoreCp: number | null; mateIn: number | null; depth: number }[]> {
    const game = new Chess(fen);
    if (game.turn() !== color) return [];
    const legal = game.moves({ verbose: true });
    if (legal.length === 0) return [];

    await this.start();
    const engine = this.engine;
    if (!engine) {
      throw new StockfishUnavailableError('Stockfish 未就绪');
    }
    if (typeof engine.searchMulti !== 'function') {
      throw new StockfishUnavailableError('当前引擎后端不支持 MultiPV');
    }

    // MultiPV 是全局选项，限强开关会污染分值 —— 一律用满血引擎。
    if (this.currentLimit !== false) {
      engine.setOption('UCI_LimitStrength', 'false');
      this.currentLimit = false;
      this.currentElo = null;
    }

    const rows = await engine.searchMulti({
      fen,
      depth: opts.depth,
      multiPv: Math.min(opts.multiPv, legal.length),
      ...(opts.clearHash ? { clearHash: true } : {}),
      ...(opts.timeMs !== undefined ? { timeMs: opts.timeMs } : {}),
    });

    const out: { move: EngineMove; scoreCp: number | null; mateIn: number | null; depth: number }[] = [];
    for (const row of rows) {
      // 引擎给的着法一律用 chess.js 复核 —— 宁可少一条，不要一条非法的
      const probe = new Chess(fen);
      let played;
      try {
        played = probe.move({
          from: row.from,
          to: row.to,
          ...(row.promotion ? { promotion: row.promotion } : {}),
        });
      } catch {
        continue;
      }
      out.push({
        move: {
          from: played.from,
          to: played.to,
          // chess.js 的 promotion 类型更宽（含 'p'/'b'/'n'/'r'/'q'），
          // 但这里只可能出现升变四子 —— 收窄一下对上 EngineMove 的类型。
          ...(played.promotion && played.promotion !== 'p'
            ? { promotion: played.promotion as 'q' | 'r' | 'b' | 'n' }
            : {}),
        },
        scoreCp: row.scoreCp,
        mateIn: row.scoreMate,
        depth: row.depth,
      });
    }
    return out;
  }

  /** 释放引擎进程 */
  close(): void {
    if (this.engine) {
      this.engine.terminate();
      this.engine = null;
    }
    this.startPromise = null;
    this.currentElo = null;
    this.currentLimit = null;
  }
}

/**
 * 用 chess.js 复核着法是否合法；不合法就退回 chess.js 的第一着。
 * 宁可给个平庸着法，也不能给个非法着法（服务端会拒绝非法着法）。
 */
function validateMove(game: Chess, best: UciBestMove): EngineMove | null {
  const candidate: EngineMove = {
    from: best.from,
    to: best.to,
    ...(best.promotion ? { promotion: best.promotion } : {}),
  };
  const probe = new Chess(game.fen());
  try {
    probe.move({
      from: candidate.from,
      to: candidate.to,
      ...(candidate.promotion ? { promotion: candidate.promotion } : {}),
    });
    return candidate;
  } catch {
    const legal = game.moves({ verbose: true }) as Move[];
    const first = legal[0];
    if (!first) return null;
    const out: EngineMove = { from: first.from, to: first.to };
    if (first.promotion === 'q' || first.promotion === 'r' || first.promotion === 'b' || first.promotion === 'n') {
      out.promotion = first.promotion;
    }
    return out;
  }
}
