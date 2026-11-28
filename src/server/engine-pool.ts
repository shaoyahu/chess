/**
 * 父进程侧的引擎池：把分析请求转给常驻子进程，返回 Promise。
 *
 * 为什么用子进程：搜索是 CPU 密集的同步计算，放在 WS 服务端的主进程里
 * 会把整个服务（所有房间的广播、棋钟计时）卡住；放到子进程里，
 * 主进程的事件循环照常跑，引擎爱算多久算多久。
 *
 * 为什么是**多**进程池：单个子进程一次只能算一个局面（worker 内部串行，
 * 因为自研引擎的搜索是同步阻塞的）。局域网里多个房间可能同时要 AI 着法，
 * 玩家也可能同时按「辅助下棋」—— 只有一个子进程就会排队。
 * 所以这里按需扩容：来一个请求先找空闲的子进程，全都在忙就再开一个，
 * 到达上限就排队给最闲的那个。
 *
 * 关键行为：
 *  - 子进程崩溃 / 退出时，必须把在途请求全部 reject 掉（不能永久 hang）；
 *  - 崩溃后下次调用 analyze 时自动重启子进程（服务不能因为一次崩溃就永久不可用）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalyzeResult, AsyncAnalyzeOptions, EngineMove } from '../lib/engine/analysis';
import type { Color } from '../lib/types';

export interface EnginePoolOptions {
  /** 可选：覆盖子进程脚本路径（测试用） */
  workerPath?: string;
  /** 最多同时开几个子进程；缺省按 CPU 核数推算 */
  maxWorkers?: number;
}

/** 父 → 子的一条请求 */
interface WorkerRequest {
  id: number;
  fen: string;
  color: Color;
  difficulty: string;
  timeMs?: number;
  backend?: AsyncAnalyzeOptions['backend'];
  limitStrength?: boolean;
}

/** 子 → 父的一条响应 */
interface WorkerResponse {
  id: number;
  move?: EngineMove | null;
  depth?: number;
  nodes?: number;
  score?: number;
  /** 杀棋距离（手，走子方视角）；不是杀棋局面时是 null */
  mateIn?: number | null;
  elapsedMs?: number;
  error?: string;
}

interface Pending {
  resolve: (result: AnalyzeResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /**
   * 这个请求是由哪个子进程受理的。
   * 必须记下来：旧子进程被杀掉、引擎池已经重启之后，旧子进程的 exit 事件才姗姗来迟，
   * 那时如果无差别地 reject 全部在途请求，就会把「新进程刚接下的请求」也一起干掉。
   */
  child: ChildProcess;
}

/** 单个请求的最长等待时间：预算 + 15 秒兜底（防止子进程卡死时永久 hang） */
const REQUEST_TIMEOUT_SLACK_MS = 15_000;

/** 默认最多开几个子进程 */
function defaultMaxWorkers(): number {
  const cpus = os.cpus().length;
  return Math.max(1, Math.min(4, cpus - 1));
}

/**
 * 项目根目录。
 * 不能用 process.cwd()：测试里 cwd 可能不是项目根，
 * 用 import.meta.url 从本文件位置往上推两级（src/server → 项目根）才靠谱。
 */
function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * 决定用什么命令启动子进程。
 *
 * **首选：node 自带的 TypeScript 支持 + 本仓库的解析 loader**
 * （`scripts/ts-loader.mjs`）。理由是内存：tsx 每次要拉起
 * 一套 tsx 的 node 运行时 **加** 一个常驻的 esbuild 服务（约 66MB RSS），
 * 而主服务和这个 worker 子进程**各要一套** —— 开一局 AI 对局时，
 * 服务 cgroup 里就是 7 个进程、RSS 合计约 460MB，
 * 内存上限压不到 256M（实测 256M / 320M 都会被 cgroup OOM killer 打死引擎）。
 *
 * node 22.18+ 自带类型剥离（`--experimental-transform-types`），
 * 不需要 esbuild；`scripts/ts-loader.mjs` 负责补扩展名和 `@/` 别名。
 *
 * **兜底**：仓库里没这个 loader（比如老的部署）就退回 tsx，
 * 保证功能不受影响 —— 只是内存代价回到从前。
 */
function resolveWorkerCommand(script: string): { cmd: string; args: string[] } {
  const root = projectRoot();
  const loader = path.join(root, 'scripts', 'ts-loader.mjs');
  if (existsSync(loader)) {
    return {
      cmd: process.execPath,
      args: ['--experimental-transform-types', '--import', pathToFileURL(loader).href, script],
    };
  }
  // 兜底：仓库里的 tsx 可执行文件。
  const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
  if (existsSync(tsxBin)) {
    return { cmd: tsxBin, args: [script] };
  }
  // 兜底：node 的 --import 加载器（node v22 支持）。
  // 注意 --import 是 node 自己的命令行参数，必须排在脚本路径前面，
  // 所以直接拼进 args，而不是塞进 spawn 的 execArgv（spawn 的 SpawnOptions 里没有这个字段）。
  const tsxLoader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const flags = existsSync(tsxLoader) ? ['--import', tsxLoader] : ['--import', 'tsx'];
  return { cmd: process.execPath, args: [...flags, script] };
}

export class EnginePool {
  private children: ChildProcess[] = [];
  /** 每个子进程当前在途的请求数 */
  private busy = new Map<ChildProcess, number>();
  /** 每个子进程 stdout 的半截缓冲 */
  private buffers = new Map<ChildProcess, string>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private lastError: Error | null = null;
  private readonly maxWorkers: number;

  constructor(private readonly opts: EnginePoolOptions = {}) {
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? defaultMaxWorkers());
  }

  /**
   * 分析局面，返回推荐着法。
   * @param fen 当前局面
   * @param color 要走哪一方
   * @param opts 难度、时间预算、后端选择
   */
  async analyze(
    fen: string,
    color: Color,
    opts: AsyncAnalyzeOptions = {},
  ): Promise<EngineMove | null> {
    const result = await this.analyzeDetailed(fen, color, opts);
    return result.move;
  }

  /**
   * 分析局面，返回推荐着法**与统计信息**（深度 / 节点数 / 分值）。
   *
   * 统计信息不只是给 UI 看 —— 门禁要靠 depth 区分
   * 「这一手到底是 Stockfish 走的，还是自研引擎走的」。
   */
  analyzeDetailed(
    fen: string,
    color: Color,
    opts: AsyncAnalyzeOptions = {},
  ): Promise<AnalyzeResult> {
    if (this.closed) {
      return Promise.reject(new Error('引擎池已关闭'));
    }
    const child = this.pickChild();
    if (!child || !child.stdin) {
      return Promise.reject(this.lastError ?? new Error('引擎子进程启动失败'));
    }

    const id = this.nextId++;
    const payload: WorkerRequest = {
      id,
      fen,
      color,
      difficulty: opts.difficulty ?? 'normal',
      timeMs: opts.timeMs,
      backend: opts.backend,
      limitStrength: opts.limitStrength,
    };

    return new Promise<AnalyzeResult>((resolve, reject) => {
      // 超时兜底：子进程卡住时不能让这个 Promise 永远挂着
      const budget = (opts.timeMs ?? 2500) + REQUEST_TIMEOUT_SLACK_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.release(child);
        reject(new Error(`引擎分析超时（${budget}ms）`));
      }, budget);
      // 别让超时定时器拖住进程退出
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer, child });
      this.busy.set(child, (this.busy.get(child) ?? 0) + 1);

      child.stdin?.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        const item = this.pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(id);
        this.release(child);
        reject(err);
      });
    });
  }

  /** 关闭引擎池（结束子进程，拒绝所有在途请求） */
  close(): void {
    this.closed = true;
    this.rejectAll(new Error('引擎池已关闭'));
    for (const child of this.children) {
      child.kill();
    }
    this.children = [];
    this.busy.clear();
    this.buffers.clear();
  }

  /** 子进程是否活着（测试用） */
  get running(): boolean {
    return this.children.some((c) => c.exitCode === null && !c.killed);
  }

  /** 当前活着的子进程数（测试 / 诊断用） */
  get workerCount(): number {
    return this.children.filter((c) => c.exitCode === null && !c.killed).length;
  }

  /**
   * 挑一个子进程来干活。
   *
   * 策略：先找空闲的；全都忙而且还没到上限就再开一个；到上限了就用最闲的那个。
   */
  private pickChild(): ChildProcess | null {
    this.reapDeadChildren();
    const alive = this.children.filter((c) => c.exitCode === null && !c.killed);
    if (alive.length === 0) {
      return this.spawnChild();
    }
    const idle = alive.find((c) => (this.busy.get(c) ?? 0) === 0);
    if (idle) return idle;
    if (alive.length < this.maxWorkers) {
      return this.spawnChild();
    }
    // 到上限了：选在途请求最少的
    return alive.reduce((best, c) =>
      (this.busy.get(c) ?? 0) < (this.busy.get(best) ?? 0) ? c : best,
    );
  }

  /** 清理已经退出的子进程引用 */
  private reapDeadChildren(): void {
    const dead = this.children.filter((c) => c.exitCode !== null || c.killed);
    if (dead.length === 0) return;
    this.children = this.children.filter((c) => c.exitCode === null && !c.killed);
    for (const c of dead) {
      this.busy.delete(c);
      this.buffers.delete(c);
    }
  }

  /** 启动一个新子进程 */
  private spawnChild(): ChildProcess | null {
    const root = projectRoot();
    const script = this.opts.workerPath
      ? path.resolve(this.opts.workerPath)
      : path.join(root, 'src', 'server', 'engine-worker.ts');
    const { cmd, args } = resolveWorkerCommand(script);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      return null;
    }

    this.children.push(child);
    this.busy.set(child, 0);
    this.buffers.set(child, '');

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // 旧子进程被杀掉后可能还有残留输出到达，这时它已经不是当前子进程了，
      // 写进共享的 buffer 会污染新子进程的协议流，直接丢弃。
      if (!this.children.includes(child)) return;
      this.onStdout(child, chunk);
    });
    // 子进程的调试输出不影响协议，但要能被人看到（父进程的 stderr）
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[engine-worker] ${chunk}`);
    });

    child.on('error', (err) => {
      this.lastError = err;
      this.rejectForChild(child, new Error(`引擎子进程出错: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      // 只有当「退出的这个子进程」还在池子里时才清空引用：
      // 旧进程被杀之后引擎池可能已经重启了新进程，
      // 这时旧进程的 exit 事件如果把引用清掉，新进程就没人管了。
      this.children = this.children.filter((c) => c !== child);
      this.busy.delete(child);
      this.buffers.delete(child);
      this.rejectForChild(
        child,
        new Error(`引擎子进程已退出 (code=${code ?? 'null'} signal=${signal ?? 'null'})`),
      );
    });

    return child;
  }

  /** 解析某个子进程 stdout 里的协议行 */
  private onStdout(child: ChildProcess, chunk: string): void {
    this.buffers.set(child, (this.buffers.get(child) ?? '') + chunk);
    let buffer = this.buffers.get(child) ?? '';
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = buffer.indexOf('\n');
    }
    this.buffers.set(child, buffer);
  }

  private onLine(line: string): void {
    let resp: WorkerResponse;
    try {
      resp = JSON.parse(line) as WorkerResponse;
    } catch {
      // 不是协议 JSON：忽略（子进程 stdout 上不该出现别的东西）
      return;
    }
    const item = this.pending.get(resp.id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(resp.id);
    this.release(item.child);
    if (resp.error) {
      item.reject(new Error(resp.error));
      return;
    }
    item.resolve({
      move: resp.move ?? null,
      depth: resp.depth ?? 0,
      nodes: resp.nodes ?? 0,
      score: resp.score ?? 0,
      mateIn: resp.mateIn ?? null,
      elapsedMs: resp.elapsedMs ?? 0,
      timedOut: false,
    });
  }

  /** 释放一个子进程的占用计数 */
  private release(child: ChildProcess): void {
    const n = (this.busy.get(child) ?? 0) - 1;
    if (n <= 0) this.busy.delete(child);
    else this.busy.set(child, n);
  }

  /** 拒绝所有在途请求（子进程没了，请求不可能有结果了） */
  private rejectAll(err: Error): void {
    for (const [, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    this.pending.clear();
    this.busy.clear();
  }

  /**
   * 只拒绝由某个特定子进程受理的请求。
   * 子进程被杀掉之后，它的 exit 事件是异步到达的；那会儿引擎池可能已经重启了新进程，
   * 如果连新进程的请求一起 reject，调用方就会莫名收到「子进程已退出」。
   */
  private rejectForChild(child: ChildProcess, err: Error): void {
    for (const [id, item] of this.pending) {
      if (item.child !== child) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      item.reject(err);
    }
    this.busy.delete(child);
  }
}

/** 创建引擎池 */
export function createEnginePool(opts: EnginePoolOptions = {}): EnginePool {
  return new EnginePool(opts);
}
