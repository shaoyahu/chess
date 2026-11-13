/**
 * 「离开房间」门禁 —— `scripts/verify-room-exit.ts`
 *
 * 为什么单独一个脚本（而不是塞进 verify-move-arrow.ts / verify-settings-ui.ts）：
 *   「离开房间」是一条**独立的机制**（房间生命周期），
 *   跟走子箭头看得见、设置弹窗长什么样都不是一回事。
 *   混在一起会让任何一个脚本的失败都很难定位。
 *
 * 门禁清单（3 条，X1~X3）：
 *   X1  对局中点「离开」→ 有二次确认（离开=判负，用户拍板的规矩）→
 *       确认之后**服务端真的收了座位**：对手那边的快照里我这个座位没了，
 *       对局判负结束（winner 是对手、reason=abandon）。
 *   X2  离开之后**不许**再自动 room.join —— 判据是**报文流水**，不是页面状态。
 *       这正是「点离开离不掉」的根因：
 *       离开会把本地房间快照清空，而「进入房间」的 effect 恰恰靠
 *       「本地没有快照」判断要不要加入 —— 于是刚离开就又发一次 room.join，
 *       服务端把人重新放回座位（人还在房里，对局还在跑）。
 *   X3  **观战者**点「离开」→ 直接走人（不弹二次确认：观战离开不影响对局），
 *       服务端把观战者摘掉。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（X1…X3）——
 * 变异脚本靠「❌ 行里含门禁编号」判定「这一条被抓到了」，
 * 失败信息不带编号就会出现假绿。
 *
 * 用法：
 *   npx tsx scripts/verify-room-exit.ts [--url=http://127.0.0.1:3000] [--group=player,spectator]
 *
 * 零新增依赖：复用项目已有的 ws；Chromium 用本机 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeGateFilter, parseGroupFilter } from './lib/gate-groups';
import { ROOM_EXIT_GROUPS } from './lib/room-exit-groups';

/**
 * 地址解析：**位置参数不能靠「位置」猜**（`--group=player` 会被当成地址）。
 * 优先 `--url=`，其次第一个长得像 http 地址的位置参数。
 */
function resolveUrl(argv: string[]): string {
  const explicit = argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  if (explicit) {
    if (!/^https?:\/\//.test(explicit)) throw new Error(`--url= 后面不像地址：${explicit}`);
    return explicit;
  }
  const positional = argv.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));
  return positional ?? 'http://127.0.0.1:3000';
}

const APP_URL = resolveUrl(process.argv.slice(2));
/** 游戏协议的 ws 地址（与 APP_URL 同源） */
const WS_URL = APP_URL.replace(/^http/, 'ws') + '/ws';

/** 本次要跑哪几组门禁。`null` = 全跑（默认）；`['player']` = 只跑玩家组。 */
const selectedGroups = parseGroupFilter(ROOM_EXIT_GROUPS, process.argv.slice(2));
/** 「这条门禁本次要不要跑」 */
const gateFilter = makeGateFilter(ROOM_EXIT_GROUPS, selectedGroups);

const OUT_DIR = join(process.cwd(), 'artifacts', 'room-exit');
const VIEW_W = 1600;
const VIEW_H = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 找一个可用的 Chromium                                                */
/* ------------------------------------------------------------------ */
function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH) {
    return existsSync(process.env.CHROMIUM_PATH) ? process.env.CHROMIUM_PATH : null;
  }
  const candidates: string[] = [];
  const cacheRoots = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    for (const dir of [
      'chromium-1228',
      'chromium-1200',
      'chromium_headless_shell-1228',
      'chromium_headless_shell-1200',
    ]) {
      const base = join(root, dir);
      if (!existsSync(base)) continue;
      candidates.push(
        join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(base, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(base, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
        join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(base, 'chrome-linux/chrome'),
        join(base, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'),
        join(base, 'chrome-headless-shell-linux64/chrome-headless-shell'),
      );
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */
interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  sessionId?: string;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else p.resolve(msg.result);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId = this.sessionId): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

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

/**
 * 跑一条门禁；出错时**用它自己的编号**记一条 ❌，然后继续往下跑。
 *
 * （失败信息不带编号 → 变异脚本判不出「这条被抓到了」→ 假绿。）
 */
async function step<T>(id: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    verdict(false, `${id} ${label}`, `执行出错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 极简的游戏协议 ws 客户端 —— 门禁用来**造房间 / 当对手**              */
/* ------------------------------------------------------------------ */
interface SeatInfo {
  userId: string;
  name: string;
  color: string;
}

interface RoomSnapshot {
  code: string;
  status: string;
  seats: { w?: SeatInfo; b?: SeatInfo };
  spectators: Array<{ userId: string; name: string }>;
  result?: { winner: string; reason: string };
}

class GameClient {
  private readonly ws: WebSocket;
  private readonly msgs: Array<Record<string, any>> = [];
  session: { token: string; userId: string; name: string } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const m = JSON.parse(String(raw)) as Record<string, any>;
        this.msgs.push(m);
        if (m.t === 'session' && !this.session) {
          this.session = { token: m.token, userId: m.userId, name: m.name };
        }
      } catch {
        /* 不是 JSON 就忽略 */
      }
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws 连接超时')), 8000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ws 连接失败：${String(e)}`));
      });
    });
  }

  send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload));
  }

  /** 等一条满足条件的消息（pred 返回 null 表示不满足） */
  async waitFor<T>(
    pred: (m: Record<string, any>) => T | null,
    label: string,
    timeoutMs = 15000,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const m of this.msgs) {
        const v = pred(m);
        if (v !== null && v !== undefined) return v;
      }
      await sleep(100);
    }
    throw new Error(`等待「${label}」超时`);
  }

  /** 最新一份房间快照 */
  latestRoom(): RoomSnapshot | null {
    for (let i = this.msgs.length - 1; i >= 0; i -= 1) {
      const m = this.msgs[i];
      if (m.t === 'room' && m.state) return m.state as RoomSnapshot;
    }
    return null;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 从 room 消息里取房间状态 */
function roomStateOf(msg: Record<string, any>): { code: string; status: string } | null {
  const st = msg.state as { code?: string; status?: string } | undefined;
  if (!st || !st.code || !st.status) return null;
  return { code: st.code, status: st.status };
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.error('❌ 未找到 Chromium。请设置 CHROMIUM_PATH 环境变量。');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Chromium: ${chromium}`);
  console.log(`输出目录：${OUT_DIR}`);
  console.log(
    selectedGroups === null
      ? '本次门禁组：全跑'
      : `本次门禁组：${selectedGroups.join('、')}`,
  );
  console.log('');

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-room-exit-'));
  const proc: ChildProcess = spawn(
    chromium,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${VIEW_W},${VIEW_H}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr?.on('data', () => {
    /* 忽略 Chromium 噪声 */
  });

  let cdp: Cdp | null = null;
  const cleanup = (): void => {
    cdp?.close();
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    const portFile = join(userDataDir, 'DevToolsActivePort');
    let wsUrl = '';
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(portFile)) {
        const lines = readFileSync(portFile, 'utf8').split('\n');
        if (lines.length >= 2 && lines[0].trim()) {
          wsUrl = `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
          break;
        }
      }
      await sleep(100);
    }
    if (!wsUrl) throw new Error('Chromium 未能暴露 DevTools 端口');

    cdp = await Cdp.connect(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /*
     * 抓一手 WebSocket 报文（**只在门禁脚本里注入**，不改产品代码）。
     *
     * 为什么需要：X2 要判的是「离开之后有没有再发 room.join」。
     * 光看页面状态分不清「没发」和「发了但被服务端拒了」——
     * 有了报文流水，一眼就能定位到断在哪一环。
     */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          window.__wsLog = [];
          const Orig = window.WebSocket;
          function Wrapped(url, protocols) {
            const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
            const push = (dir, data) => {
              try {
                const s = typeof data === 'string' ? data : '[binary]';
                let t = '?';
                let code = '';
                try {
                  const j = JSON.parse(s);
                  t = j.t || '?';
                  if (j.code) code = j.code;
                  if (j.state && j.state.code) code = j.state.code;
                } catch { /* 不是 JSON 就原样存 */ }
                window.__wsLog.push({ dir, t, code, at: Date.now() });
                if (window.__wsLog.length > 400) window.__wsLog.shift();
              } catch { /* ignore */ }
            };
            const origSend = ws.send.bind(ws);
            ws.send = (data) => { push('out', data); return origSend(data); };
            ws.addEventListener('message', (ev) => push('in', ev.data));
            return ws;
          }
          Wrapped.prototype = Orig.prototype;
          Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
          window.WebSocket = Wrapped;
        })();
      `,
    });

    const evaluate = async <T,>(expression: string, awaitPromise = false): Promise<T> => {
      const res = await cdp!.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (res.exceptionDetails) {
        throw new Error(
          `页面求值失败：${res.exceptionDetails.text ?? 'unknown'} ${
            res.exceptionDetails.exception?.description ?? ''
          }`,
        );
      }
      return res.result?.value as T;
    };

    const waitForExpr = async (expression: string, label: string, timeoutMs = 40000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = await evaluate<boolean>(`!!(${expression})`);
        if (v) return;
        await sleep(200);
      }
      const diag = await evaluate<string>(
        `location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' / ')`,
      );
      throw new Error(`等待「${label}」超时。页面状态：${diag}`);
    };

    const shot = async (name: string): Promise<void> => {
      const res = await cdp!.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data as string, 'base64'));
    };

    /** 按可见文本点一个按钮 */
    const clickText = async (tag: string, text: string, label: string): Promise<void> => {
      const done = await evaluate<boolean>(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
          .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!done) throw new Error(`点不到「${label}」（文本含「${text}」）`);
    };

    /**
     * 点「准备」按钮。
     *
     * 抽签之后房间进入「准备中」，这个按钮才出现 ——
     * 所以要先**等它出现**再点（`clickText` 是「找不到就立刻抛」，不等待）。
     *
     * 判据用 `trim() === '准备'`：点了之后按钮文字变成「已准备」，
     * 用 `includes` 会把「已准备」也匹配上。
     */
    const clickReady = async (): Promise<void> => {
      await waitForExpr(
        `[...document.querySelectorAll('.hud-actions button')].some((b) => (b.textContent || '').trim() === '准备')`,
        '「准备」按钮出现',
        15000,
      );
      await clickText('button', '准备', '「准备」按钮');
    };

    /* ================================================================ */
    /* 准备：登录进大厅（任何分组都要跑）                               */
    /* ================================================================ */
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(600);
    await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
    await evaluate(`
      (() => {
        const input = document.querySelector('input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '离开验收员');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(200);
    // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点
    await waitForExpr(`!!document.querySelector('.status-dot.online')`, '与服务器连上');
    await clickText('button', '进入大厅', '进入大厅');
    await waitForExpr(
      `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
      '大厅页面',
      15000,
    );
    console.log('浏览器已登录进大厅。');

    /* ================================================================ */
    /* 场景 A：玩家在对局中点「离开」                                   */
    /* ================================================================ */
    if (gateFilter('X1') || gateFilter('X2')) {
      /*
       * 对手（ws 客户端）建房 → 浏览器进去当黑方 → 对局开始（playing）。
       *
       * 为什么用 ws 客户端当对手：房间里要有一个**真的对手**，
       * 才能验「我走了以后，对手那边看到的是「对局结束、我方判负」，
       * 而不是「我还在座位上、对局照跑」。
       */
      const opp = new GameClient(WS_URL);
      try {
        await opp.ready();
        opp.send({ t: 'hello', name: '对手乙' });
        await opp.waitFor((m) => (m.t === 'session' ? m : null), '对手的 session');
        opp.send({ t: 'room.create', timeControl: '30+0' });
        const roomMsg = await opp.waitFor((m) => (m.t === 'room' ? m : null), '对手的房间快照');
        const code = roomStateOf(roomMsg)?.code ?? '';
        if (!code) throw new Error('对手的房间快照里没有房间码');

        // 浏览器进这个房间 → 自动加入 → 变成黑方 → 对局开始
        await cdp.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
        await waitForExpr(
          `location.pathname.toUpperCase().includes('${code}')`,
          '跳转到对局页',
          20000,
        );
        await waitForExpr(`!!document.querySelector('.square[data-square]')`, '棋盘渲染', 20000);
        /*
         * **抽签 + 准备**（新规则）：
         *   两人到齐 → 服务端抽签定黑白 → 房间进入「准备中」→ 双方都点「准备」→ 开局。
         * 黑白是**抽签**定的，所以不能再写死「浏览器是黑方，对手是白方」。
         */
        await opp.waitFor(
          (m) => (m.t === 'room' && m.state?.status === 'preparing' ? m : null),
          '抽签完成（房间进入准备中）',
        );
        await clickReady();
        opp.send({ t: 'ready' });
        await opp.waitFor(
          (m) => (m.t === 'room' && m.state?.status === 'playing' ? m : null),
          '对局开始',
        );
        console.log(`已进入对局页：${code}（黑白由抽签决定）`);

        /* ---------------- X1：离开 → 二次确认 → 服务端真的收座位 ------- */
        await step('X1', '对局中离开要二次确认，确认后服务端真的收了座位', async () => {
          // 点顶栏「离开」→ 应当弹出「对局中离开？」的确认浮层
          await clickText('header button', '离开', '顶栏「离开」按钮');
          await waitForExpr(
            `document.body.innerText.includes('对局中离开？')`,
            '离开的二次确认浮层',
            8000,
          );
          const askText = await evaluate<string>(
            `document.body.innerText.replace(/\\s+/g, ' ').slice(-160)`,
          );
          const askSaysLose = askText.includes('判你输');
          await shot('x1-leave-confirm');

          // 确认 → 回大厅
          await clickText('button', '确认离开', '「确认离开」按钮');
          await waitForExpr(`location.pathname === '/'`, '回到大厅', 15000);

          /*
           * 再等一会儿：**别被弹回对局页**。
           * 迟到的房间快照（加入请求的结果 / 重连时的自动恢复）会把人又拽回棋盘。
           */
          await sleep(2500);
          const stillLobby = await evaluate<string>('location.pathname');

          // 服务端那边：我这个座位应该没了，对局判负结束
          await opp.waitFor(
            (m) => (m.t === 'room' && m.state?.result?.reason === 'abandon' ? m : null),
            '对手收到判负结果',
          );
          const snap = opp.latestRoom();
          const seated = Object.values(snap?.seats ?? {}).filter((s): s is SeatInfo => Boolean(s));
          const onlyOpponent =
            seated.length === 1 && seated[0].userId === opp.session?.userId;
          /*
           * 胜方是不是对手，要跟对手**自己的执色**比 ——
           * 黑白现在是**抽签**定的，不能写死 'w'（老规则下对手永远是创建者、永远执白）。
           * 座位上只剩对手一个人，所以他的座位颜色就是他的执色。
           */
          const winnerIsOpponent = Boolean(
            seated[0] && snap?.result?.winner === seated[0].color,
          );
          const seatGone = seated.length === 1;

          verdict(
            askSaysLose &&
              stillLobby === '/' &&
              seatGone &&
              onlyOpponent &&
              winnerIsOpponent,
            'X1 对局中离开要二次确认，确认后服务端真的收了座位',
            `确认浮层写了判负=${askSaysLose}｜2.5 秒后 pathname=${stillLobby}｜` +
              `对手那边只剩自己=${onlyOpponent}（座位数=${seated.length}）｜` +
              `胜方是对手=${winnerIsOpponent}（result=${JSON.stringify(snap?.result)}）`,
          );
        });

        /* ---------------- X2：离开之后不许再自动 room.join ----------- */
        await step('X2', '离开之后不再自动 room.join（不会被拉回房间）', async () => {
          const log = await evaluate<Array<{ dir: string; t: string; code: string }>>(
            `(window.__wsLog || []).map((e) => ({ dir: e.dir, t: e.t, code: e.code || '' }))`,
          );
          const leaveIdx = log.reduce(
            (acc: number, e, i) => (e.dir === 'out' && e.t === 'room.leave' ? i : acc),
            -1,
          );
          const after = leaveIdx >= 0 ? log.slice(leaveIdx + 1) : [];
          const joinAfter = after.filter((e) => e.dir === 'out' && e.t === 'room.join');
          const outTail = log
            .filter((e) => e.dir === 'out')
            .slice(-8)
            .map((e) => e.t)
            .join(' → ');
          verdict(
            leaveIdx >= 0 && joinAfter.length === 0,
            'X2 离开之后不再自动 room.join（不会被拉回房间）',
            `发出过 room.leave=${leaveIdx >= 0}｜之后又发的 room.join=${joinAfter.length} 次｜` +
              `最近的发包：${outTail}`,
          );
        });
      } finally {
        opp.close();
      }
    }

    /* ================================================================ */
    /* 场景 B：观战者点「离开」                                        */
    /* ================================================================ */
    if (gateFilter('X3')) {
      /*
       * 两个 ws 客户端把房间**坐满** → 浏览器进去只能当观战。
       *
       * 观战者点「离开」**不应该**弹二次确认 ——
       * 观战离开不影响对局，没有要确认的理由；
       * 而且离开的浮层只对棋手渲染，观战者点了会「一点反应都没有」，
       * 人被卡在房间里出不来。
       */
      const host = new GameClient(WS_URL);
      const guest = new GameClient(WS_URL);
      try {
        await host.ready();
        await guest.ready();
        host.send({ t: 'hello', name: '房主甲' });
        await host.waitFor((m) => (m.t === 'session' ? m : null), '房主的 session');
        host.send({ t: 'room.create', timeControl: '30+0' });
        const roomMsg = await host.waitFor((m) => (m.t === 'room' ? m : null), '房主的房间快照');
        const code = roomStateOf(roomMsg)?.code ?? '';
        if (!code) throw new Error('房主的房间快照里没有房间码');

        guest.send({ t: 'hello', name: '房客乙' });
        await guest.waitFor((m) => (m.t === 'session' ? m : null), '房客的 session');
        guest.send({ t: 'room.join', code, mode: 'play' });
        // 抽签完成 → 双方都点「准备」→ 才开局
        await host.waitFor(
          (m) => (m.t === 'room' && m.state?.status === 'preparing' ? m : null),
          '抽签完成（房间进入准备中）',
        );
        host.send({ t: 'ready' });
        guest.send({ t: 'ready' });
        await host.waitFor(
          (m) => (m.t === 'room' && m.state?.status === 'playing' ? m : null),
          '对局开始',
        );

        // 浏览器进这个房间 → 房间满了 → 自动变成观战
        await cdp.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
        await waitForExpr(
          `location.pathname.toUpperCase().includes('${code}')`,
          '跳转到对局页',
          20000,
        );
        await waitForExpr(`!!document.querySelector('.square[data-square]')`, '棋盘渲染', 20000);
        await waitForExpr(`document.body.innerText.includes('观战中')`, '浏览器是观战者', 15000);
        console.log(`已进入观战：${code}`);

        await step('X3', '观战者点「离开」直接走人，服务端把观战者摘掉', async () => {
          await clickText('header button', '离开', '顶栏「离开」按钮');
          await sleep(800);
          const hasAsk = await evaluate<boolean>(
            `document.body.innerText.includes('对局中离开？')`,
          );
          const pathname = await evaluate<string>('location.pathname');
          await sleep(1500);
          const stillLobby = await evaluate<string>('location.pathname');
          await shot('x3-spectator-left');

          // 服务端：观战者应该被摘掉了
          await sleep(800);
          const snap = host.latestRoom();
          const specNames = (snap?.spectators ?? []).map((s) => s.name);
          const specGone = (snap?.spectators ?? []).length === 0;
          // 对局还在跑（观战者离开不影响对局）
          const stillPlaying = snap?.status === 'playing';

          verdict(
            !hasAsk && pathname === '/' && stillLobby === '/' && specGone && stillPlaying,
            'X3 观战者点「离开」直接走人，服务端把观战者摘掉',
            `弹了二次确认=${hasAsk}｜pathname=${pathname}｜1.5 秒后=${stillLobby}｜` +
              `服务端观战者=${specNames.length ? specNames.join('、') : '（没有）'}｜对局仍在=${stillPlaying}`,
          );
        });
      } finally {
        host.close();
        guest.close();
      }
    }
  } catch (err) {
    verdict(false, 'Z 门禁脚本自身出错（前置步骤失败）', err instanceof Error ? err.message : String(err));
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条。`);
  if (failed.length) {
    console.log('失败门禁：');
    for (const f of failed) console.log(`  ❌ ${f.label} —— ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

void main();
