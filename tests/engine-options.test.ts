/**
 * 引擎运行参数（哈希表大小 / 线程数）的**优先级**与**环境变量解析**。
 *
 * 为什么要有环境变量这一层：
 *   哈希表开多大，本机开发和共享生产机的最优值不一样 ——
 *   本机想开大（搜索更稳），生产机必须开小（内存就那么多）。
 *   写死在代码里只能二选一，做成环境变量则各按各的来。
 *
 * 优先级（从高到低）：**显式传参 > 环境变量 > 内置默认值**。
 * 这一条必须钉死 —— 显式传参被环境变量盖掉的话，
 * 门禁里的假引擎注入就没意义了。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  StockfishBackend,
  hashMbFromEnv,
  threadsFromEnv,
} from '@/lib/engine/uci-backend';
import type { UciBestMove, UciEngineLike, UciSearchOptions } from '@/lib/engine/uci';

/** 记录 setoption 的假引擎 */
function makeFakeEngine(): { engine: UciEngineLike; options: [string, string | number][] } {
  const options: [string, string | number][] = [];
  const engine: UciEngineLike = {
    alive: true,
    async start(): Promise<void> {
      /* 假引擎不需要握手 */
    },
    async search(_opts: UciSearchOptions): Promise<UciBestMove> {
      return {
        uci: 'e2e4',
        from: 'e2',
        to: 'e4',
        scoreCp: 12,
        scoreMate: null,
        depth: 10,
        nodes: 1000,
      };
    },
    setOption(name: string, value: string | number): void {
      options.push([name, value]);
    },
    terminate(): void {
      /* 假引擎没有进程 */
    },
  };
  return { engine, options };
}

/** 假引擎来源（不去找真引擎，免得依赖跑测试的机器上装没装） */
const FAKE_SOURCE = { kind: 'system' as const, command: '/nonexistent/stockfish', args: [], label: '假引擎' };

function lastOption(options: [string, string | number][], name: string): string | number | undefined {
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (options[i]![0] === name) return options[i]![1];
  }
  return undefined;
}

const ENV_KEYS = ['STOCKFISH_HASH_MB', 'STOCKFISH_THREADS'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('引擎运行参数 · 环境变量解析', () => {
  it('没设就是 undefined（让调用方回落到默认值）', () => {
    expect(hashMbFromEnv({})).toBeUndefined();
    expect(threadsFromEnv({})).toBeUndefined();
  });

  it('合法值能读出来，且取整', () => {
    expect(hashMbFromEnv({ STOCKFISH_HASH_MB: '16' })).toBe(16);
    expect(hashMbFromEnv({ STOCKFISH_HASH_MB: ' 32 ' })).toBe(32);
    expect(threadsFromEnv({ STOCKFISH_THREADS: '1' })).toBe(1);
    expect(hashMbFromEnv({ STOCKFISH_HASH_MB: '16.9' })).toBe(16);
  });

  it('非法值一律当没设 —— 不能把 0 或乱码发给引擎', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', 'NaN', '1e999']) {
      expect(hashMbFromEnv({ STOCKFISH_HASH_MB: bad }), `Hash=${bad}`).toBeUndefined();
      expect(threadsFromEnv({ STOCKFISH_THREADS: bad }), `Threads=${bad}`).toBeUndefined();
    }
  });
});

describe('引擎运行参数 · 优先级', () => {
  it('什么都不设 → 用内置默认值（Hash 64MB / Threads 2）', async () => {
    const { engine, options } = makeFakeEngine();
    const backend = new StockfishBackend({ source: FAKE_SOURCE, engineFactory: () => engine });
    try {
      await backend.start();
      expect(lastOption(options, 'Hash')).toBe(64);
      expect(lastOption(options, 'Threads')).toBe(2);
    } finally {
      backend.close();
    }
  });

  it('只有环境变量 → 用环境变量的值', async () => {
    process.env.STOCKFISH_HASH_MB = '16';
    process.env.STOCKFISH_THREADS = '1';
    const { engine, options } = makeFakeEngine();
    const backend = new StockfishBackend({ source: FAKE_SOURCE, engineFactory: () => engine });
    try {
      await backend.start();
      expect(lastOption(options, 'Hash')).toBe(16);
      expect(lastOption(options, 'Threads')).toBe(1);
    } finally {
      backend.close();
    }
  });

  it('显式传参 > 环境变量（门禁注入不能被环境变量盖掉）', async () => {
    process.env.STOCKFISH_HASH_MB = '16';
    process.env.STOCKFISH_THREADS = '1';
    const { engine, options } = makeFakeEngine();
    const backend = new StockfishBackend({
      source: FAKE_SOURCE,
      hashMb: 128,
      threads: 4,
      engineFactory: () => engine,
    });
    try {
      await backend.start();
      expect(lastOption(options, 'Hash')).toBe(128);
      expect(lastOption(options, 'Threads')).toBe(4);
    } finally {
      backend.close();
    }
  });
});
