/**
 * 搜索引擎与引擎池的单测。
 *
 * 覆盖：
 *  1. 一步杀能被找到
 *  2. 返回的着法一定合法（chess.js 复核）
 *  3. 时间预算被遵守
 *  4. EnginePool 能返回合法着法（会真的起子进程）
 *  5. 无着可走的局面（将死 / 逼和）返回 null
 *  6. easy / normal / hard 三档都能返回合法着法
 *  7. 走法生成与 chess.js 对拍（perft）——保证引擎的棋规和裁判一致
 */
import { describe, it, expect } from 'vitest';
import { Chess, type Move } from 'chess.js';
import {
  analyzePosition,
  analyzePositionDetailed,
  defaultTimeMs,
} from '../src/lib/engine/analysis';
import { EnginePool, createEnginePool } from '../src/server/engine-pool';
import { perft, perftDivide, verifyIncrementalHash } from '../src/lib/engine/search';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** 白车 a1 + 黑王 g8，黑方 f7/g7/h7 有兵 → Ra8 是绝杀 */
const MATE_IN_1_FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
/** 白方被将死（傻瓜将死的终局：1.f3 e5 2.g4 Qh4#，此时轮到白方走） */
const CHECKMATED_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
/** 逼和：黑王 h8，被白后 f7 与白王 g6 控制，无子可走 */
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
/** 白兵 a7 马上升变 */
const PROMOTION_FEN = '8/P6k/8/8/8/8/8/K7 w - - 0 1';

/** 用 chess.js 校验着法是否合法 */
function isLegal(fen: string, move: { from: string; to: string; promotion?: string }): boolean {
  const game = new Chess(fen);
  try {
    game.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

describe('analyzePosition', () => {
  it('能找到一步杀', () => {
    const move = analyzePosition(MATE_IN_1_FEN, 'w', { difficulty: 'normal' });
    expect(move).not.toBeNull();
    expect(move).toMatchObject({ from: 'a1', to: 'a8' });

    // 复核：走完确实是绝杀
    const game = new Chess(MATE_IN_1_FEN);
    game.move({ from: move!.from, to: move!.to });
    expect(game.isCheckmate()).toBe(true);
  });

  it('返回的着法都合法（多个局面）', () => {
    const fens = [START_FEN, MATE_IN_1_FEN, PROMOTION_FEN, STALEMATE_FEN, CHECKMATED_FEN];
    for (const fen of fens) {
      const game = new Chess(fen);
      const color = game.turn() as 'w' | 'b';
      const move = analyzePosition(fen, color, { difficulty: 'normal' });
      if (game.moves().length === 0) {
        expect(move).toBeNull();
        continue;
      }
      expect(move, fen).not.toBeNull();
      expect(isLegal(fen, move!), fen).toBe(true);
    }
  });

  it('升变兵到底线时必须带 promotion', () => {
    const move = analyzePosition(PROMOTION_FEN, 'w', { difficulty: 'normal' });
    expect(move).not.toBeNull();
    expect(move!.from).toBe('a7');
    expect(move!.to).toBe('a8');
    expect(move!.promotion).toBeDefined();
    expect(['q', 'r', 'b', 'n']).toContain(move!.promotion);
    expect(isLegal(PROMOTION_FEN, move!)).toBe(true);
  });

  it('遵守时间预算（300ms 预算不超过 300 + 1500ms）', () => {
    const t0 = Date.now();
    const move = analyzePosition(START_FEN, 'w', { difficulty: 'normal', timeMs: 300 });
    const elapsed = Date.now() - t0;
    expect(move).not.toBeNull();
    expect(elapsed).toBeLessThanOrEqual(300 + 1500);
  });

  it('hard 档同样遵守时间预算', () => {
    const t0 = Date.now();
    const move = analyzePosition(START_FEN, 'w', { difficulty: 'hard', timeMs: 400 });
    const elapsed = Date.now() - t0;
    expect(move).not.toBeNull();
    expect(elapsed).toBeLessThanOrEqual(400 + 1500);
  });

  it('无着可走的局面返回 null', () => {
    // 将死：轮到走棋的一方已经输了
    expect(analyzePosition(CHECKMATED_FEN, 'w', { difficulty: 'normal' })).toBeNull();
    // 逼和：没有合法着法
    expect(analyzePosition(STALEMATE_FEN, 'b', { difficulty: 'normal' })).toBeNull();
  });

  it('不是该方走棋时返回 null', () => {
    expect(analyzePosition(START_FEN, 'b', { difficulty: 'normal' })).toBeNull();
  });

  it('easy / normal / hard 三档都能返回合法着法', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const move = analyzePosition(START_FEN, 'w', { difficulty, timeMs: 150 });
      expect(move, difficulty).not.toBeNull();
      expect(isLegal(START_FEN, move!), difficulty).toBe(true);
    }
  });

  it('defaultTimeMs 返回三档各自的默认预算', () => {
    expect(defaultTimeMs('easy')).toBeGreaterThan(0);
    expect(defaultTimeMs('normal')).toBeGreaterThan(defaultTimeMs('easy'));
    expect(defaultTimeMs('hard')).toBeGreaterThan(defaultTimeMs('normal'));
  });

  it('能给出搜索统计信息（深度 / 节点数 / 耗时）', () => {
    const r = analyzePositionDetailed(START_FEN, 'w', { difficulty: 'normal', timeMs: 300 });
    expect(r.move).not.toBeNull();
    expect(r.depth).toBeGreaterThan(0);
    expect(r.nodes).toBeGreaterThan(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('走法生成与 chess.js 对拍', () => {
  it('perft 与标准值一致', () => {
    expect(perft(START_FEN, 1)).toBe(20);
    expect(perft(START_FEN, 2)).toBe(400);
    expect(perft(START_FEN, 3)).toBe(8902);
    // Kiwipete：经典的「难局面」，能覆盖易位、吃过路兵、升变
    const kiwipete = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    expect(perft(kiwipete, 1)).toBe(48);
    expect(perft(kiwipete, 2)).toBe(2039);
  });

  it('每个局面的合法着法集合与 chess.js 一致', () => {
    const fens = [
      START_FEN,
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    ];
    for (const fen of fens) {
      const game = new Chess(fen);
      const expected = new Set(
        (game.moves({ verbose: true }) as Move[]).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
      );
      // 用引擎自己的 perft 分项拿到着法集合
      const got = new Set(perftDivide(fen, 1).map((r) => r.move));
      expect(got, fen).toEqual(expected);
    }
  });

  it('增量维护的哈希与累加器始终正确', () => {
    const game = new Chess(START_FEN);
    const moves: string[] = [];
    for (let i = 0; i < 20; i++) {
      const list = game.moves({ verbose: true }) as Move[];
      if (list.length === 0) break;
      const m = list[Math.floor(list.length / 2)];
      moves.push(`${m.from}${m.to}${m.promotion ?? ''}`);
      game.move(m);
    }
    expect(verifyIncrementalHash(START_FEN, moves)).toBe(true);
  });
});

describe('EnginePool', () => {
  it('能返回合法着法（真的起子进程）', async () => {
    const pool = createEnginePool();
    try {
      const move = await pool.analyze(START_FEN, 'w', { difficulty: 'normal', timeMs: 300 });
      expect(move).not.toBeNull();
      expect(isLegal(START_FEN, move!)).toBe(true);
    } finally {
      pool.close();
    }
  }, 30_000);

  it('同一进程可以连续分析多个局面', async () => {
    const pool = new EnginePool();
    try {
      const a = await pool.analyze(START_FEN, 'w', { difficulty: 'easy', timeMs: 150 });
      const b = await pool.analyze(MATE_IN_1_FEN, 'w', { difficulty: 'normal', timeMs: 300 });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(isLegal(START_FEN, a!)).toBe(true);
      expect(isLegal(MATE_IN_1_FEN, b!)).toBe(true);
    } finally {
      pool.close();
    }
  }, 30_000);

  it('无着可走时返回 null', async () => {
    const pool = createEnginePool();
    try {
      expect(await pool.analyze(STALEMATE_FEN, 'b', { difficulty: 'normal', timeMs: 200 })).toBeNull();
    } finally {
      pool.close();
    }
  }, 30_000);

  it('子进程崩溃时在途请求会被 reject（不会永久 hang）', async () => {
    const pool = createEnginePool();
    try {
      // 起一个长任务，然后在它算到一半时把子进程杀掉
      const inflight = pool.analyze(START_FEN, 'w', { difficulty: 'hard', timeMs: 4000 });
      await new Promise((r) => setTimeout(r, 150));
      const child = (pool as unknown as { children: { kill: (sig?: string) => boolean }[] }).children[0];
      expect(child).not.toBeNull();
      child?.kill('SIGKILL');

      // 在途请求必须 reject，不能永远挂着
      await expect(inflight).rejects.toThrow();
    } finally {
      pool.close();
    }
  }, 30_000);

  it('子进程崩溃后下次调用能自动重启', async () => {
    const pool = createEnginePool();
    try {
      // 先正常跑一次，确认子进程起来了
      await pool.analyze(START_FEN, 'w', { difficulty: 'easy', timeMs: 100 });
      expect(pool.running).toBe(true);

      // 模拟崩溃：直接把子进程杀掉
      const child = (pool as unknown as { children: { kill: (sig?: string) => boolean }[] }).children[0];
      expect(child).not.toBeNull();
      child?.kill('SIGKILL');

      // 等子进程真的退出
      const t0 = Date.now();
      while (pool.running && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(pool.running).toBe(false);

      // 崩溃后下一次调用应该能自动重启并给出结果
      const move = await pool.analyze(START_FEN, 'w', { difficulty: 'easy', timeMs: 150 });
      expect(move).not.toBeNull();
      expect(isLegal(START_FEN, move!)).toBe(true);
    } finally {
      pool.close();
    }
  }, 30_000);

  it('close 之后不再接受请求', async () => {
    const pool = createEnginePool();
    pool.close();
    await expect(pool.analyze(START_FEN, 'w', { difficulty: 'easy', timeMs: 100 })).rejects.toThrow();
  });
});
