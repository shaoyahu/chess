/**
 * **门禁用的测试服务端** —— 起一个**隔离**的实例，跑完自己关掉。
 *
 * 为什么单独抽出来：`verify-timeout` / `verify-reconnect` / `verify-invite`
 * 都要「起一个自己的服务」，而这段逻辑有**三个不能省的细节** ——
 * 抄的时候漏掉一个，门禁就会动到用户自己的服务或存档：
 *
 *  1. **构建目录必须隔离**（`NEXT_DIST_DIR`）——
 *     门禁起的是 **dev 模式**的 Next，它往 `distDir` 里写产物，
 *     **而且启动时会先清空 `distDir`**。而 `distDir` 默认就是 `.next` ——
 *     那是**用户 `npm start` 用的生产构建目录**。
 *     不隔离的话，跑一次门禁用户的生产构建就没了（重启直接报「找不到生产构建」）。
 *  2. **存档目录必须隔离**（`LAN_CHESS_DATA_DIR`）——
 *     否则门禁造出来的假房间会落进**用户真正的存档**，重启后凭空多出几个房间。
 *  3. **端口必须随机** —— 不能抢用户正在用的 3000。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** 等一小会儿 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 找一个没人用的端口 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * **预热**：把页面先请求一遍，等 Next 的 dev 编译跑完。
 *
 * 为什么必须有这一步：dev 模式是**按需编译**的 —— 端口监听起来的时候
 * 页面还没编译，第一个请求要等编译完才返回。于是「浏览器首次打开页面」
 * 的耗时里混进了一次全量编译，机器一忙（并行跑别的门禁 / 变异脚本）
 * 就可能超过门禁里 20 秒的等待 → 报「等待『用户名输入框』超时」。
 *
 * 那个报错的含义被彻底带偏了：它看上去像「页面挂了」，
 * 实际上是「编译还没完」。把编译挪到门禁计时之外就没有这个歧义。
 */
export async function warmUpUrl(baseUrl: string, path = '/'): Promise<void> {
  const deadline = Date.now() + 150000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}${path}`);
      const body = await res.text();
      if (res.ok && body.length > 0) {
        last = `HTTP ${res.status}`;
        // 再要一次：dev 模式下第一次请求可能返回的是「编译中」的壳，
        // 第二次才拿到真正渲染出来的 HTML。
        const again = await fetch(`${baseUrl}${path}`);
        await again.text();
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`预热失败（${path}）：${last}`);
}

export class TestServer {
  constructor(
    private readonly proc: ChildProcess,
    readonly port: number,
    readonly dataDir: string,
    private readonly stderrText: () => string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  /**
   * 起一个服务端，等它打出「已启动」。
   *
   * @param dataDir 存档目录（**必须**是临时的 —— 见文件头的说明）
   * @param extraEnv 额外注入的环境变量（例如把页面指向一个「连不上的」WS 地址）
   */
  static async start(
    dataDir: string,
    extraEnv: Record<string, string> = {},
  ): Promise<TestServer> {
    const usePort = await freePort();
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const proc = spawn(tsx, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(usePort),
        HOST: '127.0.0.1',
        LAN_CHESS_DATA_DIR: dataDir,
        NODE_ENV: 'development',
        // 构建目录隔离 —— 见文件头说明 ①
        NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next-gate-invite',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let err = '';
    proc.stderr?.on('data', (buf: Buffer) => {
      err += buf.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });

    let out = '';
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务端启动超时')), 90000);
      proc.stdout?.on('data', (buf: Buffer) => {
        out += buf.toString();
        if (out.includes('局域网国际象棋已启动')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `服务端提前退出（code=${code}）：\n${out.slice(-800)}\n${err.slice(-800)}`,
          ),
        );
      });
    });
    await started;
    const server = new TestServer(proc, usePort, dataDir, () => err);
    await server.warmUp();
    return server;
  }

  /**
   * 预热某个路由（把 dev 编译挪到门禁计时之外 —— 见 warmUpUrl 的说明）。
   */
  async warmUp(path = '/'): Promise<void> {
    await warmUpUrl(`http://127.0.0.1:${this.port}`, path);
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(timer);
  }

  stderr(): string {
    return this.stderrText();
  }
}
