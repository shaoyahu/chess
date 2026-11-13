/**
 * **「断线 / 关网页 / 服务重启」三条恢复路径的门禁** —— `scripts/verify-reconnect.ts`
 *
 * 为什么单独一个脚本（而不是塞进别的门禁）：
 *   这三条是**同一个问题**（玩家回不来对局）的三个面，
 *   但每一条的机制、失败表现、判据都不一样，混在一起会让定位变难。
 *
 * 门禁清单（R1~R4）：
 *   R1  关掉网页再打开 → 凭**座位凭证**认领回原座位（不是变成观战者），而且还能继续走子。
 *   R2  座位凭证**绝不能广播**给对手 —— 对手收到的报文里不能出现 claimKey。
 *   R3  断网 → 客户端自己察觉 → 自动重连 → **座位和身份都不变**。
 *   R4  服务端重启 → 房间、走子记录、座位都还在；玩家回来还认得回自己的座位。
 *
 * 为什么必须用**真浏览器**：
 *   「关掉网页再打开」的关键是浏览器行为 ——
 *   **新标签页共享 localStorage、清空 sessionStorage**。
 *   协议层测得到「认领接口能用」，测不到「客户端有没有把凭证存进 localStorage」。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（变异脚本靠它判「这一条被抓到了」）。
 *
 * 用法：
 *   npx tsx scripts/verify-reconnect.ts [--group=claim,offline,restart]
 *   npx tsx scripts/verify-reconnect.ts --url=http://127.0.0.1:3000   # 用现成的服务（跳过 R4）
 *
 * 零新增依赖：Chromium 用本机 Playwright 浏览器缓存（CHROMIUM_PATH 可覆盖）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { Browser, type Page, sleep } from './lib/browser';
import { GameClient, type RoomSnapshot } from './lib/game-client';
import { makeGateFilter, parseGroupFilter } from './lib/gate-groups';
import { RECONNECT_GROUPS } from './lib/reconnect-groups';

/** 浏览器里用的用户名（门禁里靠它认出「哪个座位是我的」） */
const BROWSER_NAME = '重连验收员';
/** 对手（ws 客户端）的用户名 */
const OPP_NAME = '对手乙';

const OUT_DIR = join(process.cwd(), 'artifacts', 'reconnect');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */
function resolveUrl(argv: string[]): string | null {
  const explicit = argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  if (explicit) {
    if (!/^https?:\/\//.test(explicit)) throw new Error(`--url= 后面不像地址：${explicit}`);
    return explicit;
  }
  const positional = argv.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));
  return positional ?? null;
}

const EXTERNAL_URL = resolveUrl(process.argv.slice(2));
const selectedGroups = parseGroupFilter(RECONNECT_GROUPS, process.argv.slice(2));
const gateFilter = makeGateFilter(RECONNECT_GROUPS, selectedGroups);

/* ------------------------------------------------------------------ */
/* 结果汇总                                                            */
/* ------------------------------------------------------------------ */
interface Verdict {
  ok: boolean;
  label: string;
  detail: string;
}

const results: Verdict[] = [];

function verdict(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

/** 跑一条门禁；出错时**用它自己的编号**记一条 ❌，然后继续往下跑 */
async function step<T>(id: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    verdict(false, `${id} ${label}`, `执行出错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * **半开连接模拟器** —— 一个「会冻住」的 TCP 转发器。
 *
 * ## 为什么需要它
 *
 * 要测的断网是**最难处理的那种**：网络断了，但 TCP 没断。
 * 现象是**两边都以为连接还在**：
 *  - 客户端发出去的 ping 没人回；
 *  - 服务端推过来的房间快照进不了浏览器。
 *
 * 为什么不能直接用浏览器的离线模拟：
 *  - Chromium 的 `Network.emulateNetworkConditions(offline:true)`
 *    **只挡新请求，不会掐断已有连接**（实测：设成 offline 之后，
 *    页面照样每秒收到房间快照、照样收到 pong）；
 *  - `Network.setBlockedURLs` 同样只挡新请求。
 *
 * ## 冻住是怎么做到的
 *
 * 把转发的两端 `pause()` 住：
 *  - 数据仍被内核接收并 ACK（**对端以为一切正常**）；
 *  - 但不再往上转发 —— 客户端的 ping 停在代理的缓冲区里，
 *    服务端的快照也停在代理的缓冲区里。
 *
 * 这正是真实切 Wi-Fi 时看到的样子。
 */
class HalfOpenProxy {
  private readonly server: NetServer;
  private readonly pairs: Array<{ client: NetSocket; upstream: NetSocket }> = [];

  constructor(private readonly upstreamPort: number) {
    this.server = createNetServer((client) => {
      const upstream = netConnect(upstreamPort, '127.0.0.1');
      const pair = { client, upstream };
      this.pairs.push(pair);
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = (): void => {
        const i = this.pairs.indexOf(pair);
        if (i >= 0) this.pairs.splice(i, 1);
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
        try {
          upstream.destroy();
        } catch {
          /* ignore */
        }
      };
      client.on('error', drop);
      upstream.on('error', drop);
      client.on('close', drop);
      upstream.on('close', drop);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  /** 冻住：连接还在，但数据不再流动 */
  freeze(): void {
    for (const p of this.pairs) {
      p.client.pause();
      p.upstream.pause();
    }
  }

  /** 解冻：数据重新流动 */
  unfreeze(): void {
    for (const p of this.pairs) {
      p.client.resume();
      p.upstream.resume();
    }
  }

  close(): void {
    for (const p of this.pairs) {
      try {
        p.client.destroy();
        p.upstream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.pairs.length = 0;
    this.server.close();
  }
}

/* ------------------------------------------------------------------ */
/* 被测服务端（自己起，才能测「重启」）                                 */
/* ------------------------------------------------------------------ */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

class TestServer {
  private constructor(
    private readonly proc: ChildProcess,
    readonly port: number,
    readonly dataDir: string,
    readonly stderr: () => string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  /** 起一个服务端，等它「已启动」 */
  static async start(dataDir: string, port?: number): Promise<TestServer> {
    const usePort = port ?? (await freePort());
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const proc = spawn(tsx, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(usePort),
        // 绑所有网卡 —— 浏览器要走真实网卡（断网测试需要）
        HOST: '0.0.0.0',
        LAN_CHESS_DATA_DIR: dataDir,
        NODE_ENV: 'development',
        /*
         * **构建目录必须隔离** —— 否则门禁会把用户的生产构建冲掉。
         *
         * 为什么：门禁起的是 **dev 模式**的 Next，它往 `distDir` 里写
         * `static/development/` 那些产物，**而且启动时会先清空 `distDir`**。
         * 而 `distDir` 默认就是 `.next` —— 那是**用户 `npm start` 的生产构建目录**。
         *
         * 实测踩出来的后果：跑一次门禁，`.next` 里就没了 `BUILD_ID`、
         * 多了 `static/development/` → 用户的生产服务器重启时
         * 「找不到生产构建」直接起不来。
         *
         * `next.config.mjs` 里已经留了 `NEXT_DIST_DIR` 这个口子，
         * 就是给「并行开发时隔离构建目录」用的 —— 这里用上它。
         * `.next-*` 已经在 `.gitignore` 里。
         */
        NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next-gate',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr?.on('data', (buf: Buffer) => {
      /*
       * **服务端报错必须留下来。**
       *
       * 消息处理里抛出的异常（比如走子时结算棋钟炸了）会让那条消息**静默消失** ——
       * 玩家看到的是「我走了但棋盘没动」，服务端日志里才有真相。
       * 不留 stderr 就等于把唯一的线索扔了。
       */
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
        reject(new Error(`服务端提前退出（code=${code}）：\n${out.slice(-800)}`));
      });
    });
    await started;
    return new TestServer(proc, usePort, dataDir, () => err);
  }

  /** 优雅停服（SIGTERM → 服务端自己落盘） */
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/** 等对手那边的房间快照满足条件 */
async function waitRoom(
  opp: GameClient,
  label: string,
  pred: (s: RoomSnapshot) => boolean,
  timeoutMs = 25000,
): Promise<RoomSnapshot> {
  const start = Date.now();
  let last: RoomSnapshot | null = null;
  while (Date.now() - start < timeoutMs) {
    last = opp.latestRoom();
    if (last && pred(last)) return last;
    await sleep(120);
  }
  throw new Error(
    `等待「${label}」超时。最后的房间快照：${JSON.stringify(last).slice(0, 400)}`,
  );
}

/** 某个名字坐在哪个座位上 */
function seatOf(room: RoomSnapshot, name: string): { color: 'w' | 'b'; userId: string; connected?: boolean } | null {
  if (room.seats.w?.name === name) return { color: 'w', userId: room.seats.w.userId, connected: room.seats.w.connected };
  if (room.seats.b?.name === name) return { color: 'b', userId: room.seats.b.userId, connected: room.seats.b.connected };
  return null;
}

/** 轮到谁走（'w' / 'b'） */
function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** 当前局面里一方的一个合法着法 */
function legalMove(fen: string): { from: string; to: string; promotion?: string } | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const m = moves[0];
  return { from: m.from, to: m.to, promotion: m.promotion };
}

/* ------------------------------------------------------------------ */
/* 场景搭建                                                            */
/* ------------------------------------------------------------------ */

/** 浏览器里登录（填名字 → 进入大厅） */
async function browserLogin(page: Page, name: string, appUrl: string): Promise<void> {
  await page.navigate(appUrl);
  await page.waitForExpr(`!!document.querySelector('#username')`, '用户名输入框');
  /*
   * **等 React hydration 完**再填。
   *
   * 输入框出现在 DOM 里 ≠ 应用已经接管它 ——
   * hydration 之前写进去的值会被 React 重新渲染时**重置掉**，
   * 于是「名字是空的 → 点进入大厅 → 什么都没发生」，
   * 看起来像是按钮坏了，其实是时序问题。
   */
  await sleep(1200);
  await page.waitConnected();
  await page.fillInput('#username', name);
  await page.clickText('button', '进入大厅', '进入大厅');
  await page.waitForExpr(
    `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
    '大厅页面',
    25000,
  );
}

/** 浏览器进房间并成为棋手（等**服务端**确认座位上有人，不靠 DOM 猜） */
async function browserJoinRoom(
  page: Page,
  code: string,
  appUrl: string,
  opp: GameClient,
): Promise<void> {
  await page.navigate(`${appUrl}/room/${code}`);
  await waitRoom(opp, '浏览器入座', (s) => seatOf(s, BROWSER_NAME) !== null);
}

/** 双方点「准备」，进入 playing */
async function readyUp(page: Page, opp: GameClient): Promise<void> {
  await waitRoom(opp, '房间进入准备中', (s) => s.status === 'preparing');
  await page.waitForExpr(
    `[...document.querySelectorAll('.hud-actions button')].some((b) => (b.textContent || '').trim() === '准备')`,
    '「准备」按钮出现',
    20000,
  );
  await page.clickText('button', '准备', '「准备」按钮');
  opp.send({ t: 'ready' });
  await waitRoom(opp, '对局开始', (s) => s.status === 'playing');
}

/** 对手（ws 客户端）建一个房间 */
async function opponentCreatesRoom(opp: GameClient): Promise<string> {
  opp.send({ t: 'room.create', timeControl: '30+0' });
  const room = await opp.waitFor((m) => (m.t === 'room' && m.state ? m.state : null), '对手的房间快照');
  const code = (room as { code?: string }).code ?? '';
  if (!code) throw new Error('对手的房间快照里没有房间码');
  return code;
}

/**
 * 让**轮到的那一方**先走；然后让浏览器走一步。
 *
 * 为什么要这么绕：黑白是**服务端抽签**的，不能假设浏览器是哪一边。
 * 而且「浏览器能不能走这一步」本身就是判据 ——
 * 服务端按**座位身份**校验，走得动 = 座位真的属于这个身份。
 *
 * 返回浏览器走的那一步（用来核对「最后一步确实是它走的」）。
 */
async function letSideMove(
  page: Page,
  opp: GameClient,
  oppUserId: string,
  browserUserId: string,
): Promise<{ from: string; to: string; before: number }> {
  const room = opp.latestRoom();
  if (!room) throw new Error('拿不到房间快照');
  const turn = sideToMove(room.fen);
  const turnUserId = turn === 'w' ? (room.seats.w?.userId ?? '') : (room.seats.b?.userId ?? '');

  // 先让对手走（如果轮到它）—— 不然浏览器那边根本轮不到
  if (turnUserId === oppUserId) {
    const mv = legalMove(room.fen);
    if (!mv) throw new Error('对手无合法着法');
    opp.send({ t: 'move', from: mv.from, to: mv.to, promotion: mv.promotion });
    await waitRoom(opp, '对手落子', (s) => (s.moves?.length ?? 0) >= 1);
  }

  const now = opp.latestRoom()!;
  const turn2 = sideToMove(now.fen);
  const turnUserId2 = turn2 === 'w' ? (now.seats.w?.userId ?? '') : (now.seats.b?.userId ?? '');
  if (turnUserId2 !== browserUserId) {
    throw new Error(`现在轮到的是 ${turnUserId2}，不是浏览器（${browserUserId}）`);
  }
  const mv = legalMove(now.fen);
  if (!mv) throw new Error('浏览器无合法着法');
  /*
   * **「浏览器走之前」已经走了几步** —— 必须在对手那一步之后取。
   *
   * 判据要用这个数，而不是「开局时的步数」：
   * 对手先走时长度已经是 1 了，再拿「> 0」去判，
   * **对手那一步就把条件满足了** —— 浏览器走没走成照样绿（假绿）。
   */
  const before = now.moves?.length ?? 0;
  /*
   * 走**应用自己的**那条连接（`__appWs`）。
   *
   * 不能用「最后一条连接」—— dev 模式下 Next 的 HMR 连接更晚建，
   * 往它发消息等于把 move 发给了空气，而门禁还「通过」了。
   */
  const sent = await page.evaluate<boolean>(
    `(() => {
       const ws = window.__appWs;
       if (!ws || ws.readyState !== 1) return false;
       ws.send(JSON.stringify(${JSON.stringify({
         t: 'move',
         from: mv.from,
         to: mv.to,
         promotion: mv.promotion,
       })}));
       return true;
     })()`,
  );
  if (!sent) throw new Error('页面的游戏连接不可用（__appWs 没连上）');
  return { from: mv.from, to: mv.to, before };
}

/* ------------------------------------------------------------------ */
/* R3 的正文（单独抽出来，方便失败时把报文流水一起带出来）             */
/* ------------------------------------------------------------------ */
async function r3Body(
  tab: Page,
  opp: GameClient,
  userId: string,
  proxy: HalfOpenProxy,
): Promise<void> {
  const opensBefore = (await tab.wsLog()).filter((e) => e.dir === 'open').length;

  /*
   * **断网 = 冻住代理。**
   *
   * 连接还在（TCP 没断），但数据不再流动 ——
   * 客户端发出去的 ping 没人回，服务端推过来的快照也进不来。
   * 两边都以为连接还在 —— 这正是最难处理的那种断线。
   */
  proxy.freeze();

  // ① 客户端**自己**察觉（不等用户操作）
  /*
   * 判据有两条，缺一不可：
   *  a. 应用那条连接不再是 OPEN（心跳超时后主动换连接）；
   *  b. **顶栏的连接状态变成「重连中…」**。
   *
   * b 这条是给「诚实性」留的：连接已经死了，界面还写着「已连接」就是骗人。
   * 只判 a 的话不行 —— 老实现 `socket.close()` 之后连接状态也会变，
   * 但界面仍然显示「已连接」（因为 close 事件一直没来），
   * 于是「玩家看着一个连不上的棋盘，却以为连着」。
   */
  const noticed = await waitFor(
    async () => {
      const state = await tab.appSocketState();
      const text = await tab.evaluate<string>(
        `(document.querySelector('.status-dot') || {}).textContent || ''`,
      );
      if (state !== 1 && text.includes('重连中')) return true;
      return null;
    },
    '客户端察觉断网（心跳超时后换连接 + 界面显示重连中）',
    40000,
  );
  if (!noticed) throw new Error('客户端一直没察觉断网');

  // ② 恢复网络（代理恢复转发 —— 注意**旧连接仍然是死的**，
  //    客户端必须自己换一条新的才走得通）
  proxy.unfreeze();

  // ③ 客户端自己换了一条**新**连接（不是沿用那条半死的）
  await waitFor(
    async () => {
      const opens = (await tab.wsLog()).filter((e) => e.dir === 'open').length;
      return opens > opensBefore ? true : null;
    },
    '客户端自动换上新连接',
    30000,
  );

  // ④ 座位和身份都没变
  const back = await waitRoom(
    opp,
    '浏览器自动重连',
    (s) => {
      const seat = seatOf(s, BROWSER_NAME);
      return seat !== null && seat.connected === true;
    },
    30000,
  );
  const seat = seatOf(back, BROWSER_NAME)!;
  if (seat.userId !== userId) {
    throw new Error(`重连后身份变了：${userId.slice(0, 8)} → ${seat.userId.slice(0, 8)}`);
  }

  // ⑤ **连接真的活了**：落子能被服务端接受
  //    （只看「座位 connected」不够 —— 那可能只是旧连接还没被服务端发现断了）
  const browserMove = await letSideMove(tab, opp, opp.session!.userId, userId);
  const moved = await waitRoom(
    opp,
    '重连后还能落子',
    (s) => (s.moves?.length ?? 0) > browserMove.before,
    15000,
  );
  const last = moved.moves?.[moved.moves.length - 1];
  if (!last || last.from !== browserMove.from || last.to !== browserMove.to) {
    throw new Error(`重连后最后一步不是浏览器走的：${JSON.stringify(last)}`);
  }
  await tab.screenshot(join(OUT_DIR, 'R3-reconnected.png'));
  verdict(true, 'R3 断网 → 客户端自己察觉并重连，座位和身份都不变', `身份不变（${userId.slice(0, 8)}）`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-gate-'));
  let server: TestServer | null = null;
  let browser: Browser | null = null;
  const openPages: Page[] = [];

  try {
    if (EXTERNAL_URL) {
      console.log(`使用现成的服务：${EXTERNAL_URL}`);
    } else {
      server = await TestServer.start(dataDir);
      console.log(`服务端已启动：${server.url}（存档目录 ${dataDir}）`);
    }
    const appUrl = EXTERNAL_URL ?? server!.url;
    /*
     * **浏览器与 ws 对手都走回环。**
     *
     * 断网模拟靠「半开连接代理」做（见 `HalfOpenProxy`），
     * 不需要真实网卡 —— 之前试过 Chromium 的离线模拟，
     * 它**只挡新请求、掐不断已有连接**，根本造不出半开连接。
     */
    const browserUrl = appUrl;
    const wsUrl = appUrl.replace(/^http/, 'ws') + '/ws';

    browser = await Browser.launch();
    console.log('Chromium 已启动。');
    console.log(
      selectedGroups === null
        ? '本次门禁组：全跑'
        : `本次门禁组：${selectedGroups.join('、')}`,
    );
    console.log('');

    /* ================================================================ */
    /* R1 / R2：关掉网页再打开                                         */
    /* ================================================================ */
    if (gateFilter('R1') || gateFilter('R2')) {
      const opp = new GameClient(wsUrl);
      let tab1: Page | null = null;
      let tab2: Page | null = null;
      try {
        await opp.ready();
        await opp.hello(OPP_NAME);
        const code = await opponentCreatesRoom(opp);

        // ---- 标签页 1：登录 → 进房间 → 准备 ----
        tab1 = await browser!.newPage();
        openPages.push(tab1);
        await browserLogin(tab1, BROWSER_NAME, browserUrl);
        await browserJoinRoom(tab1, code, browserUrl, opp);
        await readyUp(tab1, opp);

        const before = await waitRoom(opp, '浏览器在座', (s) => seatOf(s, BROWSER_NAME) !== null);
        const seat1 = seatOf(before, BROWSER_NAME)!;

        // 凭证确实进了 localStorage（按房间码存）
        // **断言放在 R1 里做** —— 失败信息必须带门禁编号，
        // 否则变异脚本归因不到「是哪条门禁抓到的」（会误判成「没抓到」）。
        const stored = await tab1.evaluate<string>(
          `window.localStorage.getItem('lan-chess.claim') || ''`,
        );

        /* ---- 关掉网页：关掉标签页 1 ---- */
        await tab1.close();
        tab1 = null;
        /*
         * **等服务端真的看到掉线**再开标签页 2。
         *
         * 认领的硬条件是「原主人已断线」——
         * 服务端还没处理到 close 事件时，座位仍算「连着」，
         * 这时候发 claim 会被拒（而且**拒得对**：原主人明明还在）。
         */
        await waitRoom(
          opp,
          '服务端看到标签页 1 掉线',
          (s) => {
            const seat = seatOf(s, BROWSER_NAME);
            return seat !== null && seat.connected === false;
          },
          20000,
        );

        /* ---- 标签页 2：新标签页（共享 localStorage、空 sessionStorage）---- */
        tab2 = await browser!.newPage();
        openPages.push(tab2);
        // **不登录** —— 这正是「关掉网页再打开」的状态
        await tab2.navigate(`${browserUrl}/room/${code}`);
        await tab2.waitForExpr(`!!document.querySelector('.page')`, '对局页', 30000);

        await step('R1', '关掉网页再打开 → 认领回原座位并能继续走子', async () => {
          // 凭证得真的存进了 localStorage（按房间码存）
          if (!stored.includes(code)) {
            throw new Error(`localStorage 里没有这个房间的凭证：${stored}`);
          }
          // 客户端必须发的是 room.claim（而不是 room.join）
          const claimSent = await waitFor(
            async () => {
              const log = await tab2!.wsLog();
              return log.some((e) => e.dir === 'out' && e.t === 'room.claim') ? true : null;
            },
            '客户端发出 room.claim',
            25000,
          );
          if (!claimSent) throw new Error('客户端没有发出 room.claim');

          const log = await tab2!.wsLog();
          if (log.some((e) => e.dir === 'out' && e.t === 'room.join')) {
            throw new Error('客户端走的是普通加入（room.join），不是认领（room.claim）');
          }

          // 服务端：座位转给了新身份
          const after = await waitRoom(
            opp,
            '座位转给新身份',
            (s) => {
              const seat = seatOf(s, BROWSER_NAME);
              return seat !== null && seat.userId !== seat1.userId && seat.connected === true;
            },
            25000,
          );
          const seat2 = seatOf(after, BROWSER_NAME)!;
          if (seat2.color !== seat1.color) {
            throw new Error(`换边了：原来 ${seat1.color}，现在 ${seat2.color}`);
          }
          if (after.status !== 'playing') {
            throw new Error(`房间状态变成 ${after.status}（应该是还在进行）`);
          }

          // 还能继续走子 —— 座位真的属于新身份
          try {
            const browserMove = await letSideMove(tab2!, opp, opp.session!.userId, seat2.userId);
            const moved = await waitRoom(
              opp,
              '浏览器落子',
              (s) => (s.moves?.length ?? 0) > browserMove.before,
              15000,
            );
            const count = moved.moves?.length ?? 0;
            if (count < browserMove.before + 1) {
              throw new Error(`走子没被接受（moves 仍是 ${count}）`);
            }
            /*
             * **最后一步必须是浏览器走的那一步**。
             *
             * 只看「步数变多了」不够 —— 对手那一步也能让步数变多。
             * 走到这一步的人是谁，才是「座位是不是我的」的判据。
             */
            const last = moved.moves?.[moved.moves.length - 1];
            if (!last || last.from !== browserMove.from || last.to !== browserMove.to) {
              throw new Error(
                `最后一步不是浏览器走的（房间最后一步：${JSON.stringify(last)}，` +
                  `浏览器走的是 ${browserMove.from}→${browserMove.to}）`,
              );
            }
          } catch (e) {
            const log = await tab2!.wsLog();
            const toasts = opp
              .allMessages()
              .filter((m) => m.t === 'toast')
              .map((m) => String(m.message));
            throw new Error(
              `${e instanceof Error ? e.message : String(e)} | 浏览器报文流水：` +
                `${JSON.stringify(log.slice(-12))} | 对手看到的提示：${JSON.stringify(toasts)}`,
            );
          }
          await tab2!.screenshot(join(OUT_DIR, 'R1-claimed-back.png'));
          verdict(true, 'R1 关掉网页再打开 → 认领回原座位并能继续走子', `座位 ${seat1.color} 边，身份 ${seat2.userId.slice(0, 8)}`);
          return true;
        });

        await step('R2', '座位凭证不会广播给对手', async () => {
          /*
           * **判据是「对手拿到的凭证是不是浏览器那把」**，不是「对手有没有凭证」。
           *
           * 对手自己也是棋手 —— 它**当然**会收到**它自己**的座位凭证
           * （服务端只把凭证发给座位本人）。所以「对手收到了带 claimKey 的报文」
           * 这件事本身是对的；错的是「对手收到了**浏览器那把**」。
           */
          const ownLog = await tab2!.wsLog();
          const ownClaim = ownLog.find((e) => e.dir === 'in' && e.claim)?.claim;
          if (!ownClaim) throw new Error('浏览器自己也没收到座位凭证 —— 凭证根本就没发出来');

          const msgs = opp.allMessages();
          const leaked = msgs.filter((m) => 'claimKey' in m && m.claimKey === ownClaim);
          if (leaked.length > 0) {
            throw new Error(`对手收到了 ${leaked.length} 条带**浏览器凭证**的报文`);
          }
          // 公共快照里的座位对象里也不能有凭证（那是所有人都会看到的）
          const room = opp.latestRoom()!;
          const seatObj: Record<string, unknown> = {
            ...(room.seats.w ?? {}),
            ...(room.seats.b ?? {}),
          };
          if ('claimKey' in seatObj) throw new Error('公共快照的座位对象里带着 claimKey');
          verdict(
            true,
            'R2 座位凭证不会广播给对手',
            `对手 ${msgs.length} 条报文里 0 条带浏览器那把凭证`,
          );
          return true;
        });
      } catch (e) {
        /*
         * **准备阶段出错也要归到门禁编号上。**
         *
         * 失败信息不带编号 → 变异脚本判不出「是哪条门禁抓到的」→ 会误判成「没抓到」。
         */
        verdict(
          false,
          'R1 关掉网页再打开 → 认领回原座位并能继续走子',
          `准备阶段出错：${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        opp.close();
      }
    }

    /* ================================================================ */
    /* R3：断网 → 自动重连                                             */
    /* ================================================================ */
    if (gateFilter('R3')) {
      const opp = new GameClient(wsUrl);
      let tab: Page | null = null;
      let proxy: HalfOpenProxy | null = null;
      try {
        await opp.ready();
        await opp.hello(OPP_NAME);
        const code = await opponentCreatesRoom(opp);
        /*
         * **浏览器这一段走「半开连接代理」。**
         *
         * 代理只是把流量原样转发到服务端 —— 对应用来说它就是「网络」。
         * 冻住它 = 模拟「网断了但 TCP 没断」。
         */
        proxy = new HalfOpenProxy(EXTERNAL_URL ? Number(new URL(EXTERNAL_URL).port) : server!.port);
        const proxyPort = await proxy.listen();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;

        tab = await browser!.newPage();
        openPages.push(tab);
        await browserLogin(tab, BROWSER_NAME, proxyUrl);
        await browserJoinRoom(tab, code, proxyUrl, opp);
        await readyUp(tab, opp);

        const before = await waitRoom(opp, '浏览器在座', (s) => seatOf(s, BROWSER_NAME) !== null);
        const userId = seatOf(before, BROWSER_NAME)!.userId;

        await step('R3', '断网 → 客户端自己察觉并重连，座位和身份都不变', async () => {
          try {
            await r3Body(tab!, opp, userId, proxy!);
          } catch (e) {
            const log = await tab!.wsLog();
            throw new Error(
              `${e instanceof Error ? e.message : String(e)} | 浏览器报文流水：` +
                `${JSON.stringify(log.slice(-15))}`,
            );
          }
        });
      } catch (e) {
        verdict(
          false,
          'R3 断网 → 客户端自己察觉并重连，座位和身份都不变',
          `准备阶段出错：${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        proxy?.close();
        opp.close();
      }
    }

    /* ================================================================ */
    /* R4：服务端重启                                                  */
    /* ================================================================ */
    if (gateFilter('R4') && !EXTERNAL_URL) {
      const opp = new GameClient(wsUrl);
      let tab: Page | null = null;
      try {
        await opp.ready();
        await opp.hello(OPP_NAME);
        const code = await opponentCreatesRoom(opp);
        tab = await browser!.newPage();
        openPages.push(tab);
        await browserLogin(tab, BROWSER_NAME, browserUrl);
        await browserJoinRoom(tab, code, browserUrl, opp);
        await readyUp(tab, opp);

        const before = await waitRoom(opp, '浏览器在座', (s) => seatOf(s, BROWSER_NAME) !== null);
        const userId = seatOf(before, BROWSER_NAME)!.userId;
        const oppToken = opp.session!.token;

        await step('R4', '服务端重启 → 房间、走子记录、座位都还在', async () => {
          // 停服（服务端自己落盘）
          const port = server!.port;
          await server!.stop();
          // 起来（同端口、同存档目录）
          server = await TestServer.start(dataDir, port);

          /*
           * **重连后的判据一律用「新连接」**。
           *
           * 不能用重启前那个 `opp`：它的 socket 已经随服务一起死了，
           * `latestRoom()` 里留着的还是**重启前**的最后一份快照
           * （里面 connected 是 true）——
           * 拿它去等「浏览器重连回房间」，条件**立刻就满足**，
           * 于是门禁在「浏览器根本没回来」的情况下照样绿（假绿）。
           */
          const opp2 = new GameClient(wsUrl);
          try {
            await opp2.ready();
            await opp2.hello(OPP_NAME, oppToken);
            const room = await waitRoom(opp2, '房间回来了', (s) => s.code === code, 30000);
            if (room.status !== 'playing') {
              throw new Error(`重启后房间状态是 ${room.status}（应该是还在进行）`);
            }
            if ((room.moves?.length ?? 0) !== (before.moves?.length ?? 0)) {
              throw new Error('重启后走子记录对不上');
            }
            /*
             * **座位还在，而且浏览器自己回来了。**
             *
             * `connected === true` 这条是关键：恢复出来的房间一律是
             * 「全员断线」状态 —— 只有浏览器**带着原 token 重连成功**，
             * 座位才会变回在线。
             * 会话档案不落盘的话，浏览器会被当成新用户 → 座位回不来 → 这里红。
             */
            const back = await waitRoom(
              opp2,
              '浏览器自己回到座位',
              (s) => {
                const seat = seatOf(s, BROWSER_NAME);
                return seat !== null && seat.connected === true;
              },
              45000,
            );
            const seat = seatOf(back, BROWSER_NAME)!;
            if (seat.userId !== userId) {
              throw new Error(`重启后座位换了人：${userId.slice(0, 8)} → ${seat.userId.slice(0, 8)}`);
            }
          } finally {
            opp2.close();
          }
          await tab!.screenshot(join(OUT_DIR, 'R4-after-restart.png'));
          verdict(true, 'R4 服务端重启 → 房间、走子记录、座位都还在', `房间 ${code}，身份不变`);
          return true;
        });
      } catch (e) {
        verdict(
          false,
          'R4 服务端重启 → 房间、走子记录、座位都还在',
          `准备阶段出错：${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        opp.close();
      }
    }
  } finally {
    for (const p of openPages) {
      try {
        await p.close();
      } catch {
        /* ignore */
      }
    }
    await browser?.close();
    await server?.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`门禁结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('');
    for (const f of failed) console.log(`❌ ${f.label} —— ${f.detail}`);
    // 服务端的异常日志 —— 门禁失败时这是**唯一**能说明「服务端发生了什么」的地方
    const err = server?.stderr();
    if (err && err.trim()) {
      console.log('');
      console.log('服务端 stderr（末尾）：');
      console.log(err.split('\n').slice(-40).join('\n'));
    }
    process.exitCode = 1;
  }
}

/** 等一个异步条件成立 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  label: string,
  timeoutMs = 20000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await sleep(150);
  }
  throw new Error(`等待「${label}」超时`);
}

main().catch((err) => {
  console.error('门禁脚本自身出错：', err);
  process.exit(1);
});
