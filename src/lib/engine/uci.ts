/**
 * UCI over stdio 客户端 —— 用 Stockfish 这类外部引擎算着法。
 *
 * 为什么单独一个模块：Stockfish 说 UCI（不是我们自研引擎那套 JSON 协议），
 * 而且它是**独立进程**。把它隔离在这里，上层（engine-pool / engine-worker）
 * 就不用关心 UCI 的握手、`position fen ...`、`go`、`bestmove` 这些细节。
 *
 * 协议速记（Stockfish 19 实测）：
 *   父 → 子：uci / isready / position fen <FEN> / go depth N | go movetime N / stop / quit
 *   子 → 父：uciok / readyok / info depth ... score cp ... / bestmove e2e4 [ponder ...]
 *
 * 两条硬规矩：
 *  1. stdout 里只有引擎自己的输出，**不要混入任何调试打印**（否则 bestmove 解析不出来）；
 *  2. 每个请求都要能超时后兜底 —— 引擎卡住时不能让上层永久 hang。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';

/** 引擎的一次着法建议 */
export interface UciBestMove {
  /** UCI 着法字符串，例如 "e2e4" / "e7e8q" */
  uci: string;
  /** 从 UCI 字符串拆出来的 from / to / promotion */
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
  /** 引擎给出的分值（厘兵，走子方视角）；有 mate 时是 null */
  scoreCp: number | null;
  /**
   * 引擎给出的**杀棋距离**（走子方视角，单位：手）。
   *
   * UCI 规范：`score mate N` 里 N 是**手数**不是步数。
   *   - N > 0：走子方 N 手内把对手将死（对手只能挡）；
   *   - N < 0：走子方 N 手内被将死（对手在杀它）。
   * 不是 mate 局面时是 null。
   *
   * 为什么必须留着它：残局关卡的核心信息就是「几步杀」，
   * 而 `score cp` 在杀棋局面里是 null —— 只看厘兵分值，
   * 「一步杀」和「十手杀」长得一模一样（都是 null）。
   */
  scoreMate: number | null;
  /** 引擎给出的着法深度 */
  depth: number;
  /** 引擎搜索过的节点数 */
  nodes: number;
}

/**
 * **MultiPV 的一条候选着法** —— 一次搜索里同时给出的第 k 优着法。
 *
 * 为什么需要它：残局关卡要回答「对手为什么这么走」，
 * 就得知道**同一局面下所有候选着法分别值多少分**。
 *
 * 逐个着法单独搜索有两个毛病：
 *   1. 慢 —— 每个着法一次搜索；
 *   2. **分数不可比** —— 每次搜索都带着上一遍留下的哈希表残留，
 *      同一个着法两次搜索能差十几厘兵，于是「这手比那手好 30 厘兵」变成噪声。
 *
 * MultiPV 一次搜索给出所有候选，**所有分数出自同一棵搜索树**，
 * 天生可比 —— 这是解说的数据基础。
 */
export interface UciCandidate {
  /** UCI 着法字符串，例如 "e2e4" / "e7e8q" */
  uci: string;
  /** 从 UCI 字符串拆出来的 from / to / promotion */
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
  /** 分值（厘兵，走子方视角）；有 mate 时是 null */
  scoreCp: number | null;
  /** 杀棋距离（手，走子方视角）；不是杀棋局面时是 null */
  scoreMate: number | null;
  /** 该候选达到的搜索深度 */
  depth: number;
}

/** 搜索参数 */
export interface UciSearchOptions {
  /** 局面（完整 FEN，含轮到谁走） */
  fen: string;
  /** 时间预算（毫秒）；与 depth 二选一，优先 timeMs */
  timeMs?: number;
  /** 深度上限 */
  depth?: number;
  /**
   * 要同时返回几个候选着法（MultiPV）。
   *
   * 不传 = 1（只返回最佳着法）。
   * 传 N = 返回前 N 优，每条带自己的分值。
   */
  multiPv?: number;
  /**
   * 搜索前是否**清空哈希表**（`ucinewgame`）。
   *
   * 为什么需要：Stockfish 的哈希表跨搜索保留，
   * 上一遍搜索留下的表项会改变这一遍的剪枝路径 ——
   * 实测**同一个局面连搜三次，分数能漂二十几厘兵、着法也会变**。
   *
   * 离线生成题库必须可复现（同一份题库跑两次要得到同一份 `data.ts`），
   * 所以生成器一律传 true。
   */
  clearHash?: boolean;
  /** 每个请求的硬超时（毫秒）；缺省 timeMs + 10s */
  timeoutMs?: number;
}

/** 引擎进程不可用 / 出错 */
export class UciError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UciError';
  }
}

/** 引擎不可用时的默认兜底超时余量 */
const DEFAULT_TIMEOUT_SLACK_MS = 10_000;

/**
 * 把 "e7e8q" 拆成 from / to / promotion。
 * 非法格式返回 null（不抛异常 —— 上层要的是「没有着法」，不是崩）。
 */
export function parseUciMove(uci: string): { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim());
  if (!m) return null;
  const out: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } = {
    from: m[1],
    to: m[2],
  };
  if (m[3]) out.promotion = m[3] as 'q' | 'r' | 'b' | 'n';
  return out;
}

/**
 * UCI 引擎的最小接口。
 *
 * 为什么要抽接口：Stockfish 的**限强着法选择带随机性**（同参数连跑三次结果都不同），
 * 所以「限强有没有生效」不能靠「跑两遍比对着法」来判定 —— 那种判据天生 flaky。
 * 抽一个接口出来，门禁就能注入**假引擎**，确定性地断言：
 * 我们到底给引擎下了 UCI_LimitStrength / UCI_Elo 什么值、go 的 depth 是多少。
 */
export interface UciEngineLike {
  /** 进程是否活着 */
  readonly alive: boolean;
  /** 启动并握手 */
  start(timeoutMs?: number): Promise<void>;
  /** 算一步着法 */
  search(opts: UciSearchOptions): Promise<UciBestMove>;
  /**
   * **一次搜索拿到多个候选着法**（MultiPV）。
   *
   * 可选实现 —— 门禁注入的假引擎可以只实现 `search`，
   * 调用方（`StockfishBackend.analyzeMulti`）要先探测它在不在。
   */
  searchMulti?(opts: UciSearchOptions): Promise<UciCandidate[]>;
  /** 下发 setoption */
  setOption(name: string, value: string | number): void;
  /** 结束进程 */
  terminate(): void;
}

/**
 * 一个常驻的 UCI 引擎进程。
 *
 * 生命周期：spawn → uci 握手（等 uciok）→ isready（等 readyok）→ 之后就能反复
 * position/go。每次 go 之前都要先 isready（UCI 规范要求，用于同步）。
 */
export class UciEngine implements UciEngineLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readyPromise: Promise<void> | null = null;
  /** 当前正在等 bestmove 的解算器 */
  private pending: {
    resolve: (mv: UciBestMove) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    scoreCp: number | null;
    scoreMate: number | null;
    /** 带 bound 标记（upperbound/lowerbound）的杀棋距离 —— 只在没有精确值时兜底 */
    scoreMateBound: number | null;
    depth: number;
    nodes: number;
    /** 是否已经因为「找到杀棋」发过 stop */
    mateStopped: boolean;
    /**
     * MultiPV 的各行结果（key = multipv 序号）。
     *
     * 只在 `searchMulti` 里用；普通 `search` 不填。
     */
    multi: Map<number, { uci: string; scoreCp: number | null; scoreMate: number | null; scoreMateBound: number | null; depth: number }> | null;
    /** MultiPV 请求的着法数 */
    multiCount: number;
    /** MultiPV 当前收集到的最大 depth（用来只保留最终那批行） */
    multiDepth: number | null;
  } | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
  ) {}

  /** 进程是否活着 */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * 启动并完成握手。已启动时直接复用。
   * @param timeoutMs 握手超时
   */
  async start(timeoutMs = 15_000): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doStart(timeoutMs);
    try {
      await this.readyPromise;
    } catch (err) {
      this.readyPromise = null;
      this.terminate();
      throw err;
    }
  }

  private doStart(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (err) {
        reject(new UciError(`引擎启动失败: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.child = child;
      this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rl.on('line', (line) => this.onLine(line));

      // 引擎的 stderr 不参与协议，但要能被人看到
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        process.stderr.write(`[uci-engine] ${chunk}`);
      });

      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new UciError(`引擎握手超时（${timeoutMs}ms）`)),
        timeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();

      child.on('error', (err) => {
        this.rejectPending(new UciError(`引擎进程出错: ${err.message}`));
        finish(new UciError(`引擎进程出错: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        this.rejectPending(new UciError(`引擎进程已退出 (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
        this.child = null;
        this.rl = null;
        finish(new UciError(`引擎进程已退出 (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
      });

      // 握手：uci → 等 uciok；isready → 等 readyok
      let sawUciOk = false;
      const onHandshakeLine = (line: string) => {
        const t = line.trim();
        if (t === 'uciok') {
          sawUciOk = true;
          this.write('isready');
          return;
        }
        if (t === 'readyok' && sawUciOk) {
          finish(null);
        }
      };
      this.rl.on('line', onHandshakeLine);

      this.write('uci');
    });
  }

  /**
   * 算一步着法。
   * @param opts 局面与搜索参数
   */
  async search(opts: UciSearchOptions): Promise<UciBestMove> {
    await this.start();
    if (!this.alive || !this.child) {
      throw new UciError('引擎进程不可用');
    }

    // UCI 规范：go 之前必须 isready 同步
    await this.ready();
    if (this.pending) {
      throw new UciError('引擎上一次搜索还没结束');
    }

    const budget = opts.timeMs ?? 1000;
    const hardTimeout = opts.timeoutMs ?? budget + DEFAULT_TIMEOUT_SLACK_MS;

    return new Promise<UciBestMove>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.write('stop');
        reject(new UciError(`引擎搜索超时（${hardTimeout}ms）`));
      }, hardTimeout);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending = { resolve, reject, timer, scoreCp: null, scoreMate: null, scoreMateBound: null, depth: 0, nodes: 0, mateStopped: false, multi: null, multiCount: 1, multiDepth: null };

      this.write(`position fen ${opts.fen}`);
      // depth 与 movetime 可以**同时**给：引擎取先到的那个为准。
      // 这不是随便写的 —— Stockfish 的限强（UCI_LimitStrength / UCI_Elo）
      // **只在 go depth 下生效**：go movetime 走的是普通时间管理器，
      // 限强形同虚设（实测：限强 1320 + go movetime 1000 与不限强给出同一个着法，
      // 而限强 1320 + go depth 12 会给出明显不同的着法）。
      // 所以「按难度限强」必须配 depth，上限时间用 movetime 兜底。
      const depth = opts.depth !== undefined ? Math.max(1, Math.round(opts.depth)) : null;
      const movetime = opts.timeMs !== undefined ? Math.max(1, Math.round(opts.timeMs)) : null;
      if (depth !== null && movetime !== null) {
        this.write(`go depth ${depth} movetime ${movetime}`);
      } else if (depth !== null) {
        this.write(`go depth ${depth}`);
      } else if (movetime !== null) {
        this.write(`go movetime ${movetime}`);
      } else {
        this.write('go movetime 1000');
      }
    });
  }

  /**
   * **一次搜索拿到多个候选着法**（MultiPV）。
   *
   * 与逐个着法单独搜索相比：
   *   - 快一个数量级（一次搜索 vs N 次搜索）；
   *   - **各候选的分值出自同一棵搜索树，天生可比**。
   *
   * 第二条才是关键：残局解说要说「这手比那手好多少」，
   * 拿分别搜索来的分值去比，比的是噪声。
   */
  async searchMulti(opts: UciSearchOptions): Promise<UciCandidate[]> {
    await this.start();
    if (!this.alive || !this.child) {
      throw new UciError('引擎进程不可用');
    }

    await this.ready();
    if (this.pending) {
      throw new UciError('引擎上一次搜索还没结束');
    }

    const count = Math.max(1, Math.round(opts.multiPv ?? 1));
    const budget = opts.timeMs ?? 1000;
    const hardTimeout = opts.timeoutMs ?? budget + DEFAULT_TIMEOUT_SLACK_MS;

    return new Promise<UciCandidate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.write('stop');
        reject(new UciError(`引擎搜索超时（${hardTimeout}ms）`));
      }, hardTimeout);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending = {
        resolve: () => {},
        reject,
        timer,
        scoreCp: null,
        scoreMate: null,
        scoreMateBound: null,
        depth: 0,
        nodes: 0,
        mateStopped: false,
        multi: new Map(),
        multiCount: count,
        multiDepth: null,
      };

      // MultiPV 是引擎的**全局选项**，改完必须 isready 才生效。
      this.write(`setoption name MultiPV value ${count}`);
      this.write('isready');
      // 清哈希：让同一局面连搜多次得到**逐字相同**的结果（见 clearHash 说明）。
      if (opts.clearHash) {
        this.write('ucinewgame');
        this.write('isready');
      }
      this.write(`position fen ${opts.fen}`);
      const depth = opts.depth !== undefined ? Math.max(1, Math.round(opts.depth)) : null;
      if (depth !== null) {
        this.write(`go depth ${depth}`);
      } else {
        this.write(`go movetime ${Math.max(1, Math.round(opts.timeMs ?? 1000))}`);
      }

      // bestmove 到达时由 onLine 调用它收尾
      this.multiResolve = (rows) => {
        clearTimeout(timer);
        this.multiResolve = null;
        resolve(rows);
      };
    });
  }

  /** MultiPV 请求的收尾回调（bestmove 到达时触发） */
  private multiResolve: ((rows: UciCandidate[]) => void) | null = null;

  /** 发送 setoption（如 UCI_LimitStrength / UCI_Elo / Threads） */
  setOption(name: string, value: string | number): void {
    this.write(`setoption name ${name} value ${value}`);
  }

  /** 结束进程 */
  terminate(): void {
    this.rejectPending(new UciError('引擎已关闭'));
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        this.child.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      this.child.kill();
      this.child = null;
    }
    this.readyPromise = null;
  }

  /** 等引擎 readyok */
  private ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.child) {
        reject(new UciError('引擎进程不可用'));
        return;
      }
      const timer = setTimeout(() => reject(new UciError('引擎 ready 超时')), 10_000);
      if (typeof timer.unref === 'function') timer.unref();
      const onLine = (line: string) => {
        if (line.trim() === 'readyok') {
          clearTimeout(timer);
          this.rl?.off('line', onLine);
          resolve();
        }
      };
      this.rl?.on('line', onLine);
      this.write('isready');
    });
  }

  /** 处理引擎输出的一行 */
  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;

    if (t.startsWith('info ')) {
      // 只在有正在等待的搜索时收集分值信息
      const p = this.pending;
      if (!p) return;
      const info = parseSearchInfo(t);
      if (info.depth !== null) p.depth = info.depth;
      if (info.nodes !== null) p.nodes = info.nodes;
      if (info.scoreCp !== null) p.scoreCp = info.scoreCp;

      /*
       * MultiPV 收集：**只认最终 depth 的那一批行**。
       *
       * 为什么不能一股脑都收：引擎会随着加深不断重报每一行，
       * 同一个 multipv 序号会被多个 depth 覆盖 ——
       * 收进来的是「各深度混在一起」的分数，不可比。
       *
       * 所以只保留**当前见过的最大 depth** 的那批；
       * 一旦出现更大的 depth，就把之前那批清掉重来。
       */
      if (p.multi) {
        const mp = parseMultiPvInfo(t);
        if (mp && mp.depth !== null && mp.uci) {
          if (p.multiDepth === null || mp.depth > p.multiDepth) {
            p.multiDepth = mp.depth;
            p.multi.clear();
          }
          if (mp.depth === p.multiDepth) {
            const prev = p.multi.get(mp.multipv);
            p.multi.set(mp.multipv, {
              uci: mp.uci,
              scoreCp: mp.scoreCp,
              scoreMate: mp.scoreMate,
              scoreMateBound: mp.scoreMateBound,
              depth: mp.depth,
              // 同一 multipv 序号被重报时，保留「更精确」的那次
              ...(prev && prev.scoreMate !== null && mp.scoreMate === null
                ? { scoreMate: prev.scoreMate, scoreMateBound: prev.scoreMateBound }
                : {}),
            });
          }
        }
        // MultiPV 模式下**不提前 stop**：还有别的候选要收。
        return;
      }

      if (isMateInfoLine(t)) {
        p.scoreCp = null;
        /*
         * `score mate N` 带 upperbound/lowerbound 时，N 只是**搜索窗口的界**，
         * 不是确切的杀棋距离（SF 找到杀棋后往往先报一个 bound）。
         * 精确值单独存，界值只做兜底 —— 杀棋距离算错会把残局关卡分错档。
         */
        if (info.scoreMate !== null) {
          if (isBoundedScoreLine(t)) p.scoreMateBound = info.scoreMate;
          else p.scoreMate = info.scoreMate;
        }
        // 找到杀棋就别再往下虚搜了：SF 确认 mate 之后会**一路加深**，
        // 把整个时间预算耗光（实测一步杀局面能搜到 depth 245），
        // 结果就是「早就知道怎么杀了，却还要让玩家再等两秒」。
        // UCI 规范：stop 之后引擎必须回 bestmove。
        if (!p.mateStopped) {
          p.mateStopped = true;
          try {
            this.write('stop');
          } catch {
            /* 引擎刚好退出了就算了 */
          }
        }
      }
      return;
    }

    if (t.startsWith('bestmove')) {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      clearTimeout(p.timer);

      // MultiPV 请求：交回收集到的候选列表
      if (p.multi) {
        const rows: UciCandidate[] = [];
        for (const [, row] of [...p.multi.entries()].sort((a, b) => a[0] - b[0])) {
          const parsed = parseUciMove(row.uci);
          if (!parsed) continue;
          rows.push({
            uci: row.uci,
            from: parsed.from,
            to: parsed.to,
            ...(parsed.promotion ? { promotion: parsed.promotion } : {}),
            scoreCp: row.scoreCp,
            scoreMate: row.scoreMate ?? row.scoreMateBound,
            depth: row.depth,
          });
        }
        this.multiResolve?.(rows);
        return;
      }

      const parts = t.split(/\s+/);
      const uci = parts[1] ?? '';
      const parsed = parseUciMove(uci);
      if (!parsed) {
        p.reject(new UciError(`引擎返回了无法解析的着法: ${uci}`));
        return;
      }
      p.resolve({
        uci,
        from: parsed.from,
        to: parsed.to,
        ...(parsed.promotion ? { promotion: parsed.promotion } : {}),
        scoreCp: p.scoreCp,
        scoreMate: p.scoreMate ?? p.scoreMateBound,
        depth: p.depth,
        nodes: p.nodes,
      });
    }
  }

  /** 拒掉在途请求 */
  private rejectPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  /** 往引擎 stdin 写一行 */
  private write(line: string): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new UciError('引擎进程不可用');
    }
    this.child.stdin.write(`${line}\n`);
  }
}

/**
 * 这一行 info 是不是「找到杀棋」。
 *
 * 抽成纯函数是为了能**确定性地**测它 —— 门禁直接喂行文本，
 * 不用真的跑一次引擎（真跑一次 2.5 秒，而且不同引擎构建行为还不一样）。
 */
export function isMateInfoLine(line: string): boolean {
  return /\bscore mate\b/.test(line);
}

/**
 * 这一行 info 的分值是不是**带界**的（`upperbound` / `lowerbound`）。
 *
 * 为什么要在意：SF 找到杀棋后往往先报一条带界的
 * `score mate N lowerbound` —— 那个 N 是**搜索窗口的界**，
 * 不是确切的杀棋距离。后面跟的那条不带界的才是确切值。
 *
 * 杀棋距离算错的后果很实在：残局关卡会按「几步杀」分难度，
 * 差一手就会把题分错档，所以精确值和界值必须分开存。
 */
export function isBoundedScoreLine(line: string): boolean {
  return /\b(upperbound|lowerbound)\b/.test(line);
}

  /** 一条 info 行里能解析出来的搜索信息 */
export interface UciSearchInfo {
  /** 搜索深度（不是 seldepth！） */
  depth: number | null;
  /** 已搜索节点数 */
  nodes: number | null;
  /** 分值（厘兵，走子方视角）；mate 时为 null */
  scoreCp: number | null;
  /** 杀棋距离（手，走子方视角）；不是 mate 局面时为 null */
  scoreMate: number | null;
}

/**
 * 解析 UCI 的 info 行。
 *
 * 抽成纯函数是为了能**确定性地**测它 —— 门禁直接喂含 `seldepth` 的行，
 * 断言 depth 取的是真 depth 而不是 seldepth。
 *
 * 注意：UCI 的 info 行里有 **seldepth**（选择性深度），
 * 而 `seldepth` 本身就包含 `depth` 子串 —— 用 /depth (\d+)/ 会把
 * seldepth 的值当成 depth（实测满血搜索报出 depth=245，实际 depth 只有 25）。
 */
export function parseSearchInfo(line: string): UciSearchInfo {
  const t = line.trim();
  const out: UciSearchInfo = { depth: null, nodes: null, scoreCp: null, scoreMate: null };
  if (!t.startsWith('info ')) return out;

  // depth 前面必须是空白或行首，避免匹配到 seldepth
  const depth = /(?:^|\s)depth (\d+)/.exec(t);
  if (depth) out.depth = Number(depth[1]);
  const nodes = /\bnodes (\d+)/.exec(t);
  if (nodes) out.nodes = Number(nodes[1]);
  const mate = /\bscore mate (-?\d+)/.exec(t);
  if (mate) {
    // mate 分值不当作 cp 用
    out.scoreCp = null;
    out.scoreMate = Number(mate[1]);
    return out;
  }
  const score = /\bscore cp (-?\d+)/.exec(t);
  if (score) out.scoreCp = Number(score[1]);
  return out;
}

/**
 * 一条 info 行里能解析出来的 MultiPV 信息。
 *
 * 与 {@link parseSearchInfo} 的区别：多了 **multipv 序号**与 **pv 里的着法**。
 */
export interface UciMultiPvInfo {
  /** 该行的搜索深度 */
  depth: number | null;
  /** 第几优（1 = 最佳） */
  multipv: number;
  /** pv 里的**第一个**着法（UCI 字符串） */
  uci: string | null;
  /** 分值（厘兵，走子方视角）；mate 时为 null */
  scoreCp: number | null;
  /** **精确**杀棋距离（手，走子方视角）；不是杀棋局面时为 null */
  scoreMate: number | null;
  /** 带界值的杀棋距离（只作兜底） */
  scoreMateBound: number | null;
}

/**
 * 解析一行 MultiPV info。
 *
 * ## 为什么要把 bound 值单独拆出来
 *
 * Stockfish 的 `score mate N` 带 `upperbound`/`lowerbound` 时，
 * N 只是**搜索窗口的界**，不是确切的杀棋距离
 * （SF 找到杀棋后往往先报一个 bound，再报确切值）。
 *
 * 解说里要说「这手把杀棋拖到第 N 手」——
 * 拿界值当确切值说出去，数字就是错的。
 * 所以精确值与界值必须分开，界值只作兜底。
 */
export function parseMultiPvInfo(line: string): UciMultiPvInfo | null {
  const t = line.trim();
  if (!t.startsWith('info ')) return null;

  const depthM = /(?:^|\s)depth (\d+)/.exec(t);
  const mpM = /\bmultipv (\d+)/.exec(t);
  const pvM = /\bpv (\S+)/.exec(t);
  if (!depthM || !mpM || !pvM) return null;

  const out: UciMultiPvInfo = {
    depth: Number(depthM[1]),
    multipv: Number(mpM[1]),
    uci: pvM[1],
    scoreCp: null,
    scoreMate: null,
    scoreMateBound: null,
  };

  const cpM = /\bscore cp (-?\d+)/.exec(t);
  const mateM = /\bscore mate (-?\d+)/.exec(t);
  if (mateM) {
    const n = Number(mateM[1]);
    if (isBoundedScoreLine(t)) out.scoreMateBound = n;
    else out.scoreMate = n;
  } else if (cpM) {
    out.scoreCp = Number(cpM[1]);
  }
  return out;
}

/**
 * 找系统里的 Stockfish 可执行文件。
 *
 * 查找顺序：
 *  1. 环境变量 STOCKFISH_PATH（用户显式指定，优先级最高）
 *  2. PATH 里的 stockfish / stockfish-macos / stockfish-x86-64 等常见名字
 *
 * 找不到返回 null —— 调用方要准备好降级路径。
 */
export function findSystemStockfish(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STOCKFISH_PATH;
  if (explicit && explicit.trim()) return explicit.trim();

  const names = ['stockfish', 'stockfish-macos', 'stockfish-mac', 'stockfish-x86-64'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        accessSync(full, fsConstants.X_OK);
      } catch {
        continue; // 不是可执行文件就换下一个
      }
      // **npm 包的软链不算系统引擎**。
      // npm 脚本会把 node_modules/.bin 塞到 PATH 最前面，
      // 里面的 stockfish 是 npm 包（JS 版 Stockfish）的软链 ——
      // 它比原生构建慢一截（实测 nps 88 万 vs 原生 430 万），
      // 认成「系统引擎」就把优先级搞反了。
      if (isNpmShim(full)) continue;
      return full;
    }
  }
  return null;
}

/**
 * 这个可执行文件是不是 npm 包的软链（node_modules/.bin/xxx）。
 *
 * 判断依据是**解析后的真实路径**里有没有 node_modules ——
 * 只看路径字符串会漏掉「别的目录里放了个指向 node_modules 的软链」这种情况。
 */
function isNpmShim(full: string): boolean {
  const marker = `${path.sep}node_modules${path.sep}`;
  try {
    return realpathSync(full).includes(marker);
  } catch {
    return full.includes(marker);
  }
}
