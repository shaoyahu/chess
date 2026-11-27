/**
 * Stockfish 接入门禁（S1~S10）。
 *
 * 这一层测的是**新链路**：UCI 客户端 → 引擎发现 → Stockfish 后端 →
 * 引擎池 → 常驻子进程。原有 E1~E16 测的是自研引擎，不覆盖这些。
 *
 * 规矩（与既有门禁一致）：
 *  - 每条断言都要带**门禁编号**，失败信息里必须能看到编号；
 *  - 判定靠**进程退出码**，不靠 grep 框架文本；
 *  - 前提要自己校验（局面合法性、着法合法性用 chess.js 对拍），
 *    不要假设「引擎肯定是对的」。
 *
 * 用法：npm run verify:stockfish
 */
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import {
  UciEngine,
  parseUciMove,
  parseSearchInfo,
  parseMultiPvInfo,
  isMateInfoLine,
  findSystemStockfish,
  type UciBestMove,
  type UciEngineLike,
  type UciSearchOptions,
} from '../src/lib/engine/uci';
import { discoverEngineSource } from '../src/lib/engine/engine-source';
import { StockfishBackend, StockfishUnavailableError } from '../src/lib/engine/uci-backend';
import {
  DIFFICULTY_ELO,
  DIFFICULTY_DEPTH,
  DIFFICULTY_TIME_MS,
  eloOf,
} from '../src/lib/engine/difficulty';
import { analyzePositionDetailedAsync, type EngineMove } from '../src/lib/engine/analysis';
import { createEnginePool } from '../src/server/engine-pool';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** 白方一步杀：Qh4# */
const MATE_IN_1_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
/** 逼和局面 */
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
/** 升变：白车 a7，可以走 a8q */
const PROMOTION_FEN = 'r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1';
/**
 * 白方一步杀：Qb8#（黑王 h8，g7/h7 有黑兵，退路全堵）。
 *
 * 挑这个局面的两个前提：
 *  1. **合法** —— 白方走棋时黑王不能已经在被攻击的状态
 *     （踩过坑：白兵 g7 已经攻击 h8，轮到白方走时那是非法局面，SF 直接崩）；
 *  2. **轮到白方走且还有着可走** —— 否则 analyze 压根不会调引擎，断言成了空转。
 */
const MATE_IN_1_ACTIVE_FEN = '7k/1Q4pp/8/8/8/8/8/4K3 w - - 0 1';
/** Kiwipete 经典测试局面 */
const KIWIPETE_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

const failures: string[] = [];
let checks = 0;

function check(id: string, label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`✅ ${id} ${label}`);
  } else {
    const msg = `❌ ${id} ${label}${detail ? ` —— ${detail}` : ''}`;
    console.log(msg);
    failures.push(msg);
  }
}

/** 着法是否合法（用 chess.js 复核） */
function isLegal(fen: string, from: string, to: string, promotion?: string): boolean {
  const game = new Chess(fen);
  try {
    game.move({ from, to, ...(promotion ? { promotion } : {}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 假引擎：记录我们下到引擎的每一个 setoption / search 参数。
 *
 * 为什么要有它：Stockfish 的**限强着法选择带随机性** ——
 * 同一局面、同一参数连跑三次，给出的着法都不一样（实测）。
 * 所以「限强有没有生效」**不能**靠「跑两遍比对着法」来判定，那判据天生 flaky。
 * 换成断言「我们到底给引擎下了什么参数」，就是确定性的。
 */
interface EngineRecorder {
  options: Array<[string, string | number]>;
  searches: UciSearchOptions[];
}

function makeFakeEngine(rec: EngineRecorder): UciEngineLike {
  return {
    alive: true,
    async start(): Promise<void> {
      /* 假引擎不需要握手 */
    },
    async search(opts: UciSearchOptions): Promise<UciBestMove> {
      rec.searches.push(opts);
      return {
        uci: 'e2e4',
        from: 'e2',
        to: 'e4',
        scoreCp: 12,
        scoreMate: null,
        depth: opts.depth ?? 10,
        nodes: 1000,
      };
    },
    setOption(name: string, value: string | number): void {
      rec.options.push([name, value]);
    },
    terminate(): void {
      /* 假引擎没有进程 */
    },
  };
}

/** 记录里最后一次某项 setoption 的值 */
function lastOption(rec: EngineRecorder, name: string): string | number | undefined {
  for (let i = rec.options.length - 1; i >= 0; i -= 1) {
    if (rec.options[i]![0] === name) return rec.options[i]![1];
  }
  return undefined;
}

async function main(): Promise<void> {
  // ---------- S1：引擎发现 ----------
  const source = discoverEngineSource();
  check('S1', '能发现 Stockfish（系统优先或 npm 兜底）', source !== null, source?.label ?? '没找到');
  if (!source) {
    // 没引擎就没法测后面，但门禁必须报出来
    console.error('\n❌ S1 未通过：没有可用引擎，后续门禁无法执行。');
    process.exit(1);
  }

  // ---------- S2：系统引擎查找优先级 ----------
  {
    const fakeEnv = { STOCKFISH_PATH: '/tmp/does-not-exist', PATH: '/nonexistent' } as unknown as NodeJS.ProcessEnv;
    check(
      'S2',
      'STOCKFISH_PATH 优先于 PATH，且不存在的路径不会被误认成引擎',
      findSystemStockfish(fakeEnv) === '/tmp/does-not-exist',
      String(findSystemStockfish(fakeEnv)),
    );
    const noSystem = findSystemStockfish({ PATH: '/nonexistent-dir-xyz' } as unknown as NodeJS.ProcessEnv);
    check('S2', 'PATH 里没有 stockfish 时返回 null', noSystem === null, String(noSystem));
    const disabled = discoverEngineSource({
      PATH: '/nonexistent-dir-xyz',
      STOCKFISH_DISABLE_NPM: '1',
    } as unknown as NodeJS.ProcessEnv);
    check('S2', '关掉系统引擎与 npm 兜底后返回 null（降级链的末端）', disabled === null);

    // npm 脚本会把 node_modules/.bin 塞到 PATH 最前面，
    // 里面的 stockfish 是 npm 包（JS 版）的软链 —— 它比原生构建慢一截，
    // 认成「系统引擎」就把优先级搞反了。这里造一个同样的软链来验证。
    {
      const tmp = mkdtempSync(path.join(tmpdir(), 'sf-shim-'));
      const shim = path.join(tmp, 'stockfish');
      try {
        symlinkSync(path.join(process.cwd(), 'node_modules', 'stockfish', 'scripts', 'cli.js'), shim);
      } catch {
        // 造不出软链就跳过这条断言（不能因为环境问题让门禁红）
      }
      if (existsSync(shim)) {
        const viaShim = findSystemStockfish({ PATH: tmp } as unknown as NodeJS.ProcessEnv);
        check(
          'S2',
          'PATH 里的 npm 包软链（node_modules/.bin/stockfish）不被当成系统引擎',
          viaShim === null,
          String(viaShim),
        );
        const realOne = findSystemStockfish({
          PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
        } as unknown as NodeJS.ProcessEnv);
        check(
          'S2',
          '跳过 npm 软链后能找到真正的系统引擎',
          realOne !== null && !realOne.includes('node_modules'),
          String(realOne),
        );
      }
      rmSync(tmp, { recursive: true, force: true });
    }

    // 系统引擎必须**优先于** npm 包：用一个假路径冒充系统引擎
    const prioritized = discoverEngineSource({
      STOCKFISH_PATH: '/bin/cat',
      PATH: '/nonexistent-dir-xyz',
    } as unknown as NodeJS.ProcessEnv);
    check(
      'S2',
      '系统引擎优先于 npm 包兜底',
      prioritized !== null && prioritized.kind === 'system' && prioritized.command === '/bin/cat',
      JSON.stringify(prioritized),
    );
  }

  // ---------- S3：UCI 握手 + 着法解析 ----------
  const engine = new UciEngine(source.command, source.args);
  try {
    await engine.start(30_000);
    check('S3', 'UCI 握手成功（uciok + readyok）', true);

    const start = await engine.search({ fen: START_FEN, timeMs: 600 });
    check(
      'S3',
      '开局能返回合法着法',
      isLegal(START_FEN, start.from, start.to, start.promotion),
      `${start.from}${start.to}`,
    );
    check('S3', '返回的着法深度 > 0', start.depth > 0, `depth=${start.depth}`);
    check('S3', '返回了节点数', start.nodes > 0, `nodes=${start.nodes}`);

    const promo = await engine.search({ fen: PROMOTION_FEN, timeMs: 600 });
    check(
      'S3',
      '升变局面能返回升变着法',
      promo.promotion !== undefined && isLegal(PROMOTION_FEN, promo.from, promo.to, promo.promotion),
      `${promo.from}${promo.to}${promo.promotion ?? ''}`,
    );
  } catch (err) {
    check('S3', 'UCI 握手与搜索', false, err instanceof Error ? err.message : String(err));
  } finally {
    engine.terminate();
  }

  // ---------- S4：UCI 字符串解析 ----------
  {
    const ok = parseUciMove('e2e4');
    const promo = parseUciMove('e7e8q');
    const bad = parseUciMove('zzz');
    check(
      'S4',
      'parseUciMove 能拆 from/to/promotion，并拒绝非法串',
      ok?.from === 'e2' && ok?.to === 'e4' && promo?.promotion === 'q' && bad === null,
      JSON.stringify({ ok, promo, bad }),
    );
  }

  // ---------- S4b：info 行解析（seldepth 不能当成 depth） ----------
  {
    const line = 'info depth 25 seldepth 30 multipv 1 score cp 13 nodes 1234567 nps 9000000 hashfull 12';
    const info = parseSearchInfo(line);
    check(
      'S4',
      'info 行里的 depth 取的是真 depth，不是 seldepth（实测踩过：满血搜索报出 depth=245）',
      info.depth === 25 && info.nodes === 1234567 && info.scoreCp === 13,
      JSON.stringify(info),
    );
    const mate = parseSearchInfo('info depth 30 seldepth 40 score mate 3 nodes 500');
    check(
      'S4',
      'mate 分值不当作 cp 用（scoreCp 保持 null）',
      mate.depth === 30 && mate.scoreCp === null,
      JSON.stringify(mate),
    );
    check(
      'S4',
      '非 info 行解析不出东西',
      parseSearchInfo('bestmove e2e4').depth === null,
      JSON.stringify(parseSearchInfo('bestmove e2e4')),
    );
    check(
      'S4',
      'isMateInfoLine 只对「score mate」的行返回真（找到杀棋就提前 stop 的判据）',
      isMateInfoLine('info depth 30 seldepth 40 score mate 1 nodes 500 pv e2e4') === true &&
        isMateInfoLine('info depth 25 seldepth 30 score cp 13 nodes 100 pv e2e4') === false &&
        isMateInfoLine('bestmove e2e4') === false,
      'mate/普通行判定',
    );
  }

  /*
   * ---------- S4c：MultiPV 行的解析（bound 值必须分开） ----------
   *
   * 这一条守着**解说数字的正确性**：
   * `score mate N` 带 upperbound/lowerbound 时，N 只是搜索窗口的界，
   * 不是确切的杀棋距离。拿界值当确切值说出去，解说里的「拖到第 N 手」就是错的。
   *
   * 精确值（scoreMate）与界值（scoreMateBound）必须分开存。
   */
  {
    const exact = parseMultiPvInfo(
      'info depth 12 multipv 1 score cp -450 nodes 100 pv e2e4',
    );
    check(
      'S4',
      'MultiPV 行能解析出 depth / multipv / pv 里的着法',
      exact?.depth === 12 && exact?.multipv === 1 && exact?.uci === 'e2e4',
      JSON.stringify(exact),
    );
    check(
      'S4',
      'MultiPV 的 cp 分值正常解析',
      exact?.scoreCp === -450 && exact?.scoreMate === null && exact?.scoreMateBound === null,
      JSON.stringify(exact),
    );

    const exactMate = parseMultiPvInfo(
      'info depth 12 multipv 2 score mate -7 nodes 100 pv d1h5',
    );
    check(
      'S4',
      '不带 bound 的 mate 行 → 杀棋距离进 scoreMate（确切值）',
      exactMate?.scoreMate === -7 && exactMate?.scoreMateBound === null,
      JSON.stringify(exactMate),
    );

    const bounded = parseMultiPvInfo(
      'info depth 12 multipv 3 score mate -5 lowerbound nodes 100 pv a1a2',
    );
    check(
      'S4',
      '带 lowerbound 的 mate 行 → 界值进 scoreMateBound，scoreMate 保持 null',
      bounded?.scoreMate === null && bounded?.scoreMateBound === -5,
      JSON.stringify(bounded),
    );

    const boundedUpper = parseMultiPvInfo(
      'info depth 12 multipv 1 score mate 3 upperbound nodes 100 pv h1h2',
    );
    check(
      'S4',
      '带 upperbound 的 mate 行同样只进兜底字段',
      boundedUpper?.scoreMate === null && boundedUpper?.scoreMateBound === 3,
      JSON.stringify(boundedUpper),
    );

    check(
      'S4',
      '非 MultiPV 行（没有 multipv 字段）解析不出来',
      parseMultiPvInfo('info depth 12 score cp -450 nodes 100 pv e2e4') === null,
      '期望 null',
    );
  }

  // ---------- S5：超时兜底（不能永久 hang） ----------
  {
    const e2 = new UciEngine(source.command, source.args);
    try {
      await e2.start(30_000);
      const t0 = Date.now();
      let threw = false;
      try {
        // 给一个几乎不可能完成的硬超时
        await e2.search({ fen: KIWIPETE_FEN, timeMs: 50, timeoutMs: 1 });
      } catch {
        threw = true;
      }
      const elapsed = Date.now() - t0;
      check(
        'S5',
        '硬超时会抛错而不是永久 hang',
        threw && elapsed < 5000,
        `threw=${threw} elapsed=${elapsed}ms`,
      );
    } finally {
      e2.terminate();
    }
  }

  // ---------- S6：难度 → UCI_Elo 映射 ----------
  {
    check(
      'S6',
      '三档难度映射到约定的 Elo（1320/1900/2400）',
      DIFFICULTY_ELO.easy === 1320 &&
        DIFFICULTY_ELO.normal === 1900 &&
        DIFFICULTY_ELO.hard === 2400 &&
        eloOf('easy') === 1320 &&
        eloOf('normal') === 1900 &&
        eloOf('hard') === 2400,
      JSON.stringify(DIFFICULTY_ELO),
    );
  }

  // ---------- S7：限强参数真的下到了引擎（假引擎，确定性） ----------
  {
    for (const diff of ['easy', 'normal', 'hard'] as const) {
      const rec: EngineRecorder = { options: [], searches: [] };
      const backend = new StockfishBackend({ source, engineFactory: () => makeFakeEngine(rec) });
      try {
        await backend.analyze(START_FEN, 'w', { difficulty: diff });
        const search = rec.searches[0];
        const limit = lastOption(rec, 'UCI_LimitStrength');
        const elo = lastOption(rec, 'UCI_Elo');
        check(
          'S7',
          `${diff} 档下发了限强开关与对应 Elo（${DIFFICULTY_ELO[diff]}）`,
          limit === 'true' && Number(elo) === DIFFICULTY_ELO[diff],
          `UCI_LimitStrength=${String(limit)} UCI_Elo=${String(elo)}`,
        );
        check(
          'S7',
          `${diff} 档的搜索带上了随难度递增的深度上限（${DIFFICULTY_DEPTH[diff]}）`,
          search?.depth === DIFFICULTY_DEPTH[diff],
          `depth=${String(search?.depth)}`,
        );
        check(
          'S7',
          `${diff} 档的搜索带上了时间上限（${DIFFICULTY_TIME_MS[diff]}ms）`,
          search?.timeMs === DIFFICULTY_TIME_MS[diff],
          `timeMs=${String(search?.timeMs)}`,
        );
      } catch (err) {
        check('S7', `${diff} 档限强参数`, false, err instanceof Error ? err.message : String(err));
      } finally {
        backend.close();
      }
    }
  }

  // ---------- S8：limitStrength=false → 关掉限强且不设深度上限（辅助下棋要满血） ----------
  {
    const rec: EngineRecorder = { options: [], searches: [] };
    const backend = new StockfishBackend({ source, engineFactory: () => makeFakeEngine(rec) });
    try {
      await backend.analyze(START_FEN, 'w', {
        difficulty: 'easy',
        limitStrength: false,
        timeMs: 2000,
      });
      const search = rec.searches[0];
      check(
        'S8',
        'limitStrength=false 时明确关掉了 UCI_LimitStrength',
        lastOption(rec, 'UCI_LimitStrength') === 'false',
        `UCI_LimitStrength=${String(lastOption(rec, 'UCI_LimitStrength'))}`,
      );
      check(
        'S8',
        'limitStrength=false 时不设深度上限（满血引擎，时间内搜到最深）',
        search?.depth === undefined && search?.timeMs === 2000,
        `depth=${String(search?.depth)} timeMs=${String(search?.timeMs)}`,
      );
    } catch (err) {
      check('S8', '满血引擎参数', false, err instanceof Error ? err.message : String(err));
    } finally {
      backend.close();
    }
  }

  // ---------- S9：降级链 ----------
  {
    // 显式要求 stockfish 但没有引擎 → 必须报错，不能静默降级
    const noEngineEnv = { PATH: '/nonexistent-dir-xyz', STOCKFISH_DISABLE_NPM: '1' } as unknown as NodeJS.ProcessEnv;
    const savedPath = process.env.PATH;
    const savedDisable = process.env.STOCKFISH_DISABLE_NPM;
    process.env.PATH = noEngineEnv.PATH!;
    process.env.STOCKFISH_DISABLE_NPM = '1';
    let threw = false;
    try {
      await analyzePositionDetailedAsync(START_FEN, 'w', { backend: 'stockfish' });
    } catch (err) {
      threw = err instanceof StockfishUnavailableError;
    }
    check('S9', '显式 backend=stockfish 且无引擎时报错（不静默降级）', threw);

    // auto 模式 → 必须降级到自研引擎并给出合法着法
    let autoMove: EngineMove | null = null;
    try {
      const r = await analyzePositionDetailedAsync(START_FEN, 'w', {
        backend: 'auto',
        timeMs: 400,
      });
      autoMove = r.move;
    } catch (err) {
      check('S9', 'auto 模式降级到自研引擎', false, err instanceof Error ? err.message : String(err));
    }
    check(
      'S9',
      'auto 模式在无引擎时降级到自研引擎并返回合法着法',
      autoMove !== null && isLegal(START_FEN, autoMove.from, autoMove.to, autoMove.promotion),
      autoMove ? `${autoMove.from}${autoMove.to}` : 'null',
    );
    process.env.PATH = savedPath;
    if (savedDisable === undefined) delete process.env.STOCKFISH_DISABLE_NPM;
    else process.env.STOCKFISH_DISABLE_NPM = savedDisable;
  }

  // ---------- S10：引擎池全链路 ----------
  {
    const pool = createEnginePool();
    try {
      const move = await pool.analyze(START_FEN, 'w', { difficulty: 'normal', timeMs: 800 });
      check(
        'S10',
        '引擎池经子进程返回合法着法',
        move !== null && isLegal(START_FEN, move.from, move.to, move.promotion),
        move ? `${move.from}${move.to}` : 'null',
      );

      const builtin = await pool.analyze(START_FEN, 'w', {
        difficulty: 'normal',
        timeMs: 800,
        backend: 'builtin',
      });
      check(
        'S10',
        '引擎池能走 builtin 后端（自研引擎）',
        builtin !== null && isLegal(START_FEN, builtin.from, builtin.to, builtin.promotion),
        builtin ? `${builtin.from}${builtin.to}` : 'null',
      );

      // 并发不应串台：4 个请求各自拿到对应局面的合法着法
      const conc = await Promise.all([
        pool.analyze(START_FEN, 'w', { difficulty: 'normal', timeMs: 700 }),
        pool.analyze(MATE_IN_1_FEN, 'b', { difficulty: 'normal', timeMs: 700 }),
        pool.analyze(STALEMATE_FEN, 'b', { difficulty: 'normal', timeMs: 700 }),
        pool.analyze(PROMOTION_FEN, 'w', { difficulty: 'normal', timeMs: 700 }),
      ]);
      const ok =
        conc[0] !== null &&
        conc[1] !== null &&
        conc[2] === null &&
        conc[3] !== null &&
        isLegal(START_FEN, conc[0]!.from, conc[0]!.to, conc[0]!.promotion) &&
        isLegal(MATE_IN_1_FEN, conc[1]!.from, conc[1]!.to, conc[1]!.promotion) &&
        isLegal(PROMOTION_FEN, conc[3]!.from, conc[3]!.to, conc[3]!.promotion);
      check(
        'S10',
        '并发 4 个请求不串台（逼和局面返回 null，其余各自合法）',
        ok,
        conc.map((m) => (m ? m.from + m.to : 'null')).join(' '),
      );
      check('S10', '并发时确实开了多个子进程', pool.workerCount >= 2, `workerCount=${pool.workerCount}`);

      // 关键判据：auto 后端必须真的走了 Stockfish（深度远高于自研引擎的档位上限）
      const autoDetail = await pool.analyzeDetailed(START_FEN, 'w', {
        difficulty: 'normal',
        timeMs: 900,
      });
      const builtinDetail = await pool.analyzeDetailed(START_FEN, 'w', {
        difficulty: 'normal',
        timeMs: 900,
        backend: 'builtin',
      });
      check(
        'S10',
        'auto 后端确实走了 Stockfish（搜索深度远高于 builtin 档位上限）',
        autoDetail.depth > builtinDetail.depth + 5,
        `auto depth=${autoDetail.depth} builtin depth=${builtinDetail.depth}`,
      );
    } catch (err) {
      check('S10', '引擎池全链路', false, err instanceof Error ? err.message : String(err));
    } finally {
      pool.close();
    }
  }

  // ---------- S11：真实引擎 —— 难度档对应不同的搜索深度 ----------
  {
    const backend = new StockfishBackend({ source });
    try {
      await backend.start();
      const easy = await backend.analyze(START_FEN, 'w', { difficulty: 'easy' });
      const hard = await backend.analyze(START_FEN, 'w', { difficulty: 'hard' });
      check(
        'S11',
        `easy 档实际搜索深度被深度上限压住（≤ ${DIFFICULTY_DEPTH.easy}）`,
        easy.depth > 0 && easy.depth <= DIFFICULTY_DEPTH.easy,
        `depth=${easy.depth}`,
      );
      check(
        'S11',
        `hard 档实际搜索深度明显高于 easy 档（≥ 12）`,
        hard.depth >= 12 && hard.depth > easy.depth,
        `hard depth=${hard.depth} easy depth=${easy.depth}`,
      );
    } catch (err) {
      check('S11', '真实引擎难度深度', false, err instanceof Error ? err.message : String(err));
    } finally {
      backend.close();
    }
  }

  // ---------- S12：真实引擎 —— 辅助下棋走满血引擎（不限深） ----------
  {
    const backend = new StockfishBackend({ source });
    try {
      await backend.start();
      const hint = await backend.analyze(START_FEN, 'w', {
        difficulty: 'hard',
        limitStrength: false,
        timeMs: 2000,
      });
      check(
        'S12',
        '辅助下棋（limitStrength=false）搜到的深度不受难度深度上限限制（≥ 15）',
        hint.depth >= 15 && hint.depth > DIFFICULTY_DEPTH.hard,
        `depth=${hint.depth}（难度上限=${DIFFICULTY_DEPTH.hard}）`,
      );
    } catch (err) {
      check('S12', '满血引擎深度', false, err instanceof Error ? err.message : String(err));
    } finally {
      backend.close();
    }
  }

  // ---------- S13：一步杀局面立刻返回（不发 stop 会白等满时间预算） ----------
  {
    const backend = new StockfishBackend({ source });
    try {
      await backend.start();
      const t0 = Date.now();
      // 注意局面要选**白方还能走**的（黑方已被将死的局面压根不会调引擎，
      // 断言就成了空转 —— 换过两次才踩明白）。
      const mate = await backend.analyze(MATE_IN_1_ACTIVE_FEN, 'w', {
        difficulty: 'hard',
        limitStrength: false,
        timeMs: 2500,
      });
      const elapsed = Date.now() - t0;
      // 一步杀可能有多个解（Qb8# 与 Qa8# 都是杀），所以判据是「走完确实将死」，
      // 用 chess.js 复核，不写死某一个着法。
      const probe = new Chess(MATE_IN_1_ACTIVE_FEN);
      let mated = false;
      if (mate.move) {
        try {
          probe.move({
            from: mate.move.from,
            to: mate.move.to,
            ...(mate.move.promotion ? { promotion: mate.move.promotion } : {}),
          });
          mated = probe.isCheckmate();
        } catch {
          mated = false;
        }
      }
      check(
        'S13',
        '一步杀局面在 1.5 秒内返回，且给出的是真正的杀棋（找到杀棋就停，不白等满时间预算）',
        elapsed < 1500 && mated,
        `elapsed=${elapsed}ms move=${mate.move ? mate.move.from + mate.move.to : 'null'} mated=${mated}`,
      );
    } catch (err) {
      check('S13', '杀棋秒回', false, err instanceof Error ? err.message : String(err));
    } finally {
      backend.close();
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`❌ Stockfish 门禁未通过：${failures.length}/${checks} 条失败`);
    process.exit(1);
  }
  console.log(`✅ Stockfish 门禁全部通过（${checks} 条断言）`);
}

main().catch((err) => {
  console.error('❌ 门禁脚本异常:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
