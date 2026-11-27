/**
 * **「连不上服务器」时的界面门禁** —— `scripts/verify-connection-state.ts`
 *
 * 为什么要有这个门禁（实测出来的原症状，2026-11-27）：
 *   线上服务器僵死时，页面右上角一直写「连接中…」，
 *   点「进入大厅」**毫无反应** —— 玩家只能反复点，以为是自己坏了。
 *
 *   成因有两层：
 *   ① 服务器僵死的形态是「TCP 握上了、TLS/WS 握手永远不完成」
 *      （内核还在应答 SYN，用户态拿不到 CPU）→ 浏览器把 socket 一直挂在
 *      CONNECTING，既不 open 也不 error → 客户端永远显示「连接中…」；
 *   ② 登录逻辑在 CONNECTING 状态下**什么都不做**（在等 onopen 发 hello）
 *      → 那一次点击**没有任何反馈**。
 *
 * 门禁清单（G1~G3）：
 *   G1  握手永远不完成时 → 状态灯最终显示「无法连接」（不是永远「连接中…」）。
 *   G2  连不上时点「进入大厅」→ 有明确反馈（toast），不是静默无反应。
 *   G3  服务器恢复后 → **不用再点一次**就自动进大厅（身份被记住了）。
 *
 * 怎么复现「服务器僵死」：
 *   起一个**只握手不回应**的假 WS 端点（见下面 BlackholeWs）——
 *   浏览器连上去之后永远停在 CONNECTING，和真服务器僵死时的形态一模一样。
 *   然后把页面的 `NEXT_PUBLIC_WS_URL` 指向它，就得到一个「连不上」的页面。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（变异脚本靠它判「这一条被抓到了」）。
 *
 * 用法：
 *   npx tsx scripts/verify-connection-state.ts
 *
 * 零新增依赖：Chromium 用本机 Playwright 浏览器缓存（CHROMIUM_PATH 可覆盖）。
 */
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Browser, type Page, sleep } from './lib/browser';
import { TestServer, freePort } from './lib/test-server';

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
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 「只握手不回应」的假 WS 端点                                        */
/* ------------------------------------------------------------------ */

/**
 * **黑洞端点** —— 复现服务器僵死时的那副形态。
 *
 * 真实僵死时发生了什么：
 *   内核还在应答 SYN（所以 `nc -z` 探 443 是通的），
 *   但 nginx 的用户态拿不到 CPU → **TLS 握手永远不完成**。
 *
 * 这里用同样的手法：收到 HTTP Upgrade 请求后**什么都不回**，
 * 连接就那么挂着 —— 浏览器于是把 WebSocket 一直停在 CONNECTING。
 *
 * `recover()` 之后，同一个端口开始正常处理 Upgrade（用 `ws` 当服务端），
 * 于是门禁可以接着验证「服务器恢复了会怎样」。
 */
class BlackholeWs {
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  /** 收到的连接（关停时要主动掐掉，否则 close() 的回调不会触发） */
  private readonly sockets = new Set<Duplex>();
  private recovered = false;

  constructor(readonly port: number) {
    this.server = createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      if (!this.recovered) {
        // 黑洞：握手握上了，但不回应 —— 浏览器会一直停在 CONNECTING
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  /** 最小可用的服务端协议：收到 hello 就发 session + lobby */
  private onConnection(ws: WebSocket): void {
    ws.on('message', (raw: Buffer | string) => {
      let msg: { t?: string; name?: string };
      try {
        msg = JSON.parse(raw.toString()) as { t?: string; name?: string };
      } catch {
        return;
      }
      if (msg.t !== 'hello') return;
      const name = msg.name ?? '访客';
      ws.send(
        JSON.stringify({
          t: 'session',
          token: 'gate-token',
          userId: 'gate-user',
          name,
        }),
      );
      ws.send(
        JSON.stringify({
          t: 'lobby',
          state: {
            rooms: [],
            queueSize: 0,
            online: 1,
            onlineUsers: [{ userId: 'gate-user', name }],
            queuedUserIds: [],
          },
        }),
      );
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
  }

  /** 切换成「正常服务」—— 之后进来的连接能正常完成握手 */
  recover(): void {
    this.recovered = true;
  }

  async close(): Promise<void> {
    this.wss.close();
    // 半开的连接必须主动掐掉 —— 否则 server.close() 的回调永远不来，
    // 门禁会「卡在清理阶段」而不是「干净退出」。
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/* ------------------------------------------------------------------ */
/* 页面上的小助手                                                       */
/* ------------------------------------------------------------------ */

/** 状态灯当前的文字（连上了是「在线 N」，其余是状态词） */
async function statusText(page: Page): Promise<string> {
  return page.evaluate<string>(
    `(() => { const el = document.querySelector('.status-dot'); return el ? (el.textContent || '').trim() : ''; })()`,
  );
}

/** 等 React hydration 完（dev 模式下 SSR 的 HTML 先到，hydration 之前点按钮没反应） */
async function waitHydrated(page: Page): Promise<void> {
  await page.waitForExpr(
    `(() => {
      const el = document.querySelector('.status-dot');
      if (!el) return false;
      return Object.keys(el).some((k) => k.startsWith('__react'));
    })()`,
    'React 完成 hydration',
    60000,
  );
}

/**
 * **清理一步** —— 出错/卡住都不能影响门禁的结论。
 *
 * 为什么单独抽出来：**门禁的退出码比什么都重要**。
 * 实测踩过：清理里的 promise 永不 resolve → 事件循环空掉 → Node **以 0 静默退出**，
 * 于是「门禁明明打出了 ❌，退出码却是 0」→ 变异脚本据此判「假绿」，
 * 三条变异全被放过。所以清理必须有兜底超时，且**不许吞掉退出码**。
 */
async function cleanupStep(label: string, fn: () => Promise<void> | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15_000);
      }),
    ]);
  } catch (err) {
    console.error(
      `（清理「${label}」出错，已忽略：${err instanceof Error ? err.message : String(err)}）`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-conn-gate-'));
  const blackholePort = await freePort();
  const blackhole = new BlackholeWs(blackholePort);
  await blackhole.listen();

  console.log(`黑洞 WS 端点：ws://127.0.0.1:${blackholePort}/ws（握手永远不完成）\n`);

  let server: TestServer | null = null;
  let browser: Browser | null = null;
  let fatal = '';

  try {
    server = await TestServer.start(dataDir, {
      // 页面连到这个「只握手不回应」的端点 —— 复现服务器僵死
      NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${blackholePort}/ws`,
    });
    console.log(`页面：${server.url}\n`);

    browser = await Browser.launch();
    const page = await browser.newPage();
    await page.navigate(`${server.url}/`);
    await waitHydrated(page);

    /* ---------- G1：连不上要说「无法连接」，不能永远「连接中…」 ---------- */
    const connectTimeoutMs = 10_000;
    let g1 = false;
    let g1Detail = '';
    try {
      const startedAt = Date.now();
      await page.waitForExpr(
        `(() => {
          const el = document.querySelector('.status-dot');
          return !!el && (el.textContent || '').includes('无法连接');
        })()`,
        '状态灯显示「无法连接」',
        connectTimeoutMs + 4_000,
      );
      const elapsed = Date.now() - startedAt;
      g1 = true;
      g1Detail = `${elapsed}ms 后状态灯：${await statusText(page)}`;
    } catch (err) {
      g1Detail = `状态灯停在「${await statusText(page)}」（${
        err instanceof Error ? err.message : String(err)
      }）`;
    }
    verdict(g1, 'G1 连不上时状态灯说「无法连接」', g1Detail);

    /* ---------- G2：点「进入大厅」必须有反馈，不能静默无反应 ---------- */
    let g2 = false;
    let g2Detail = '';
    try {
      await page.fillInput('#username', '门禁员');
      await page.clickText('button', '进入大厅', '进入大厅');
      await sleep(500);
      const toast = await page.evaluate<string>(
        `(() => {
          const el = document.querySelector('.toast-text');
          return el ? (el.textContent || '').trim() : '';
        })()`,
      );
      if (toast.includes('连不上服务器')) {
        g2 = true;
        g2Detail = `toast：${toast}`;
      } else {
        g2Detail = toast ? `toast 内容是「${toast}」` : '没有任何提示（点了像没点）';
      }
    } catch (err) {
      g2Detail = err instanceof Error ? err.message : String(err);
    }
    verdict(g2, 'G2 点「进入大厅」有明确反馈', g2Detail);

    /* ---------- G3：服务器恢复后，不用再点一次就自动进大厅 ---------- */
    blackhole.recover();
    let g3 = false;
    let g3Detail = '';
    try {
      await page.waitForExpr(
        `(() => {
          const el = document.querySelector('.status-dot');
          return !!el && (el.textContent || '').includes('在线');
        })()`,
        '状态灯回到「在线 N」',
        60_000,
      );
      // 进了大厅 = 登录卡片消失了（session 建立）
      const inLobby = await page.evaluate<boolean>(`(() => !document.querySelector('#username'))()`);
      if (inLobby) {
        g3 = true;
        g3Detail = `状态灯：${await statusText(page)}`;
      } else {
        g3Detail = '状态灯说连上了，但还停在登录卡片上（身份没被记住）';
      }
    } catch (err) {
      g3Detail = err instanceof Error ? err.message : String(err);
    }
    verdict(g3, 'G3 服务器恢复后自动进大厅（不用再点一次）', g3Detail);
  } catch (err) {
    fatal = err instanceof Error ? err.message : String(err);
    console.error(`❌ 门禁自身出错：${fatal}`);
  }

  /*
   * **先出结论，再清理。**
   * 顺序很重要：结论必须在退出码之前落到纸上，
   * 清理再慢也不能把结论吃掉（这正是上面那个「静默 exit(0)」坑的解药）。
   */
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (fatal) {
    console.log(`❌ 门禁没能跑完：${fatal}`);
    process.exitCode = 1;
  } else if (failed.length > 0) {
    console.log(`❌ ${failed.length}/${results.length} 条门禁未通过`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${results.length}/${results.length} 条门禁全部通过`);
    process.exitCode = 0;
  }

  await cleanupStep('浏览器', async () => browser?.close());
  await cleanupStep('服务端', async () => server?.stop());
  await cleanupStep('黑洞端点', async () => blackhole.close());
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(process.exitCode ?? 0);
}

void main();
