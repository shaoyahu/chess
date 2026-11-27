/**
 * 常驻引擎子进程。
 *
 * 为什么要常驻：搜索要几百毫秒到几秒，如果每来一个请求就 spawn 一次，
 * 光是启动 node + tsx 就要 200ms 以上；而且每次都要重新加载 chess.js。
 * 所以父进程起一个常驻子进程，用「一行一个 JSON」的协议通信。
 *
 * 协议：
 *   父 → 子：{"id":1,"fen":"...","color":"w","difficulty":"normal","timeMs":800,
 *            "backend":"auto","limitStrength":true}
 *   子 → 父：{"id":1,"move":{"from":"e2","to":"e4"}} / {"id":1,"error":"..."}
 *
 * 重要：stdout 只许写协议 JSON。任何调试信息一律走 stderr，
 * 否则会污染协议，父进程就解析不出来了。
 *
 * 后端选择（backend）：
 *   - "auto"（缺省）：优先 Stockfish，不可用时降级到自研引擎；
 *   - "stockfish"：只用 Stockfish，不可用就回 error（不静默降级）；
 *   - "builtin"：只用自研引擎。
 *
 * 串行处理：本进程**同时只处理一个搜索**。原因不是「只能同步」，
 * 而是自研引擎的搜索是**同步阻塞**的（会占住整个 event loop）。
 * 并发能力由父进程的进程池（engine-pool.ts）提供。
 */
import { createInterface } from 'node:readline';
import {
  analyzePositionDetailed,
  analyzePositionDetailedAsync,
  type AsyncAnalyzeOptions,
  type Difficulty,
} from '../lib/engine/analysis';
import { StockfishBackend, StockfishUnavailableError } from '../lib/engine/uci-backend';
import type { Color } from '../lib/types';

/** 父 → 子的一条请求 */
interface AnalyzeRequest {
  id: number;
  fen: string;
  color: Color;
  difficulty?: Difficulty;
  timeMs?: number;
  /** 后端选择；缺省 'auto' */
  backend?: AsyncAnalyzeOptions['backend'];
  /** 是否按难度限强；缺省 true */
  limitStrength?: boolean;
}

/** 子 → 父的一条响应 */
interface AnalyzeResponse {
  id: number;
  move?: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | null;
  /** 实际完成的搜索深度（门禁要靠它区分「走了 Stockfish」还是「走了自研引擎」） */
  depth?: number;
  /** 搜索节点数 */
  nodes?: number;
  /** 最佳着法分值（走子方视角，厘兵） */
  score?: number;
  /** 杀棋距离（手，走子方视角）；不是杀棋局面时是 null */
  mateIn?: number | null;
  /** 耗时（毫秒） */
  elapsedMs?: number;
  error?: string;
}

/**
 * 常驻的 Stockfish 实例。
 *
 * 懒启动：第一次真正需要 Stockfish 时才 spawn 引擎进程。
 * 引擎进程很贵（原生 SF 要几百 MB 内存），整个 worker 生命周期只开一个。
 */
let stockfish: StockfishBackend | null = null;

/**
 * Stockfish 是不是已经确认用不了了。
 * 一旦失败过就不再重试 —— 每次请求都重试启动会让整局卡在几秒的失败延迟上。
 */
let stockfishDead = false;

/** 拿到（必要时创建）Stockfish 实例；确认不可用时返回 null */
async function getStockfish(): Promise<StockfishBackend | null> {
  if (stockfishDead) return null;
  if (!stockfish) stockfish = new StockfishBackend();
  try {
    await stockfish.start();
    return stockfish;
  } catch (err) {
    stockfishDead = true;
    process.stderr.write(
      `engine-worker: Stockfish 不可用，降级到自研引擎（${err instanceof Error ? err.message : String(err)}）\n`,
    );
    return null;
  }
}

/** 写一行协议 JSON 到 stdout */
function respond(payload: AnalyzeResponse): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 处理一条请求 */
async function handle(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;

  let id = 0;
  try {
    const req = JSON.parse(text) as AnalyzeRequest;
    id = typeof req.id === 'number' ? req.id : 0;

    if (typeof req.fen !== 'string' || !req.fen) {
      respond({ id, error: '缺少 fen' });
      return;
    }
    if (req.color !== 'w' && req.color !== 'b') {
      respond({ id, error: `非法 color: ${String(req.color)}` });
      return;
    }

    const backend = req.backend ?? 'auto';
    const opts: AsyncAnalyzeOptions = {
      difficulty: req.difficulty,
      timeMs: req.timeMs,
      limitStrength: req.limitStrength,
    };

    if (backend === 'builtin') {
      const result = analyzePositionDetailed(req.fen, req.color, opts);
      respond({
        id,
        move: result.move,
        depth: result.depth,
        nodes: result.nodes,
        score: result.score,
        mateIn: result.mateIn,
        elapsedMs: result.elapsedMs,
      });
      return;
    }

    // auto / stockfish：先试 Stockfish
    const sf = await getStockfish();
    if (sf) {
      try {
        const result = await sf.analyze(req.fen, req.color, opts);
        respond({
          id,
          move: result.move,
          depth: result.depth,
          nodes: result.nodes,
          score: result.score,
          mateIn: result.mateIn,
          elapsedMs: result.elapsedMs,
        });
        return;
      } catch (err) {
        if (backend === 'stockfish') {
          respond({
            id,
            error: err instanceof StockfishUnavailableError ? err.message : String(err),
          });
          return;
        }
        // auto：Stockfish 这次失败，降级到自研引擎
        process.stderr.write(
          `engine-worker: Stockfish 搜索失败，降级（${err instanceof Error ? err.message : String(err)}）\n`,
        );
      }
    } else if (backend === 'stockfish') {
      respond({ id, error: 'Stockfish 不可用' });
      return;
    }

    const result = analyzePositionDetailed(req.fen, req.color, opts);
    respond({
      id,
      move: result.move,
      depth: result.depth,
      nodes: result.nodes,
      score: result.score,
      mateIn: result.mateIn,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    respond({ id, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 串行队列：保证同一进程里同时只有一个搜索在跑。
 * 新的请求排在上一个后面，响应仍然带 id，父进程按 id 匹配，顺序无关。
 */
let chain: Promise<void> = Promise.resolve();

function enqueue(line: string): void {
  chain = chain.then(
    () => handle(line),
    () => handle(line),
  );
}

// stdin 按行读取
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', enqueue);
rl.on('close', () => {
  // 父进程关掉 stdin 就退出
  if (stockfish) stockfish.close();
  process.exit(0);
});

// 调试信息一律走 stderr，绝不能写 stdout
process.on('uncaughtException', (err) => {
  process.stderr.write(`engine-worker 未捕获异常: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
