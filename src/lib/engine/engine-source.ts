/**
 * 引擎来源发现 —— 决定用哪个 Stockfish。
 *
 * 优先级（A3 拍板）：
 *   1. **系统 stockfish**：环境变量 STOCKFISH_PATH，或 PATH 里的 stockfish。
 *      原生二进制 + 完整 NNUE + 多线程，棋力最强，零 npm 体积。
 *   2. **npm stockfish 包**（stockfish.js，GPL-3.0）：跨平台一键装，
 *      跑的是 WASM 版，棋力略低于原生但完全够用。
 *   3. **都没有** → 返回 null，由上层降级到自研引擎。
 *
 * 为什么不把 npm 包做成硬依赖失败：局域网主机上有人 brew 装了原生 SF、
 * 有人没装，两种情况都应该能正常开局，不该因为一个可选依赖缺失就起不来。
 */
import { createRequire } from 'node:module';
import { findSystemStockfish } from './uci';

/** 引擎来源种类 */
export type EngineSourceKind = 'system' | 'npm';

/** 一个可执行的引擎来源 */
export interface EngineSource {
  kind: EngineSourceKind;
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 人类可读的标识，用于日志与 UI 展示 */
  label: string;
}

/** npm 包里默认用哪个 flavor */
const DEFAULT_NPM_FLAVOR = 'single';

/**
 * 找 npm 包里的引擎文件。
 * 包不存在 / 没装 / 结构变了 → 返回 null（不抛异常，交给上层降级）。
 */
function findNpmEngine(env: NodeJS.ProcessEnv = process.env): EngineSource | null {
  try {
    const require = createRequire(import.meta.url);
    const sf = require('stockfish') as { findEngine?: (flavor: string) => string };
    if (typeof sf.findEngine !== 'function') return null;
    const flavor = env.STOCKFISH_FLAVOR?.trim() || DEFAULT_NPM_FLAVOR;
    const enginePath = sf.findEngine(flavor);
    if (!enginePath) return null;
    return {
      kind: 'npm',
      command: process.execPath,
      args: [enginePath],
      label: `npm stockfish (${flavor})`,
    };
  } catch {
    // 没装 npm 包，或 require 失败
    return null;
  }
}

/**
 * 发现可用的 Stockfish。
 * @param env 环境变量（测试可注入）
 * @returns 找不到返回 null
 */
export function discoverEngineSource(env: NodeJS.ProcessEnv = process.env): EngineSource | null {
  const system = findSystemStockfish(env);
  if (system) {
    return {
      kind: 'system',
      command: system,
      args: [],
      label: `系统 stockfish (${system})`,
    };
  }
  // 测试用开关：模拟「机器上只有 npm 包」或「什么都没有」
  if (env.STOCKFISH_DISABLE_NPM === '1') return null;
  return findNpmEngine(env);
}
