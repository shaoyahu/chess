/**
 * 「拖拽走子」门禁 —— `scripts/verify-drag.ts`
 *
 * ## 这套门禁在验什么
 *
 * 用户要的交互是：**按住棋子 → 拖动 → 拖到能下的地方 → 松手走子**，
 * 2D 平着拖，3D 拖的时候棋子先**抬起来一点**。
 *
 * 但「按住拖」这条链路横跨三层（DOM 事件 / React 状态 / 服务端走子），
 * 每一层都能单独坏掉，而且**坏得都很安静**：
 *   - 拖动没起拖 → 什么都不发生（用户以为功能不存在）；
 *   - 落点算错半格 → 走错棋（用户以为功能坏了）；
 *   - 拖完顺手把棋子「选中」了 → 界面上多出一圈落点提示；
 *   - 3D 拖棋子时相机跟着转 → 拖到一半棋盘歪了。
 *
 * 所以门禁清单（10 条，D1~D10）：
 *
 * | 编号 | 验什么 |
 * |------|--------|
 * | D1 | 2D：按住棋子拖到目标格 → **服务端真的收到这步棋**，且棋盘对得上 |
 * | D2 | 2D：拖到**非法**格 → 不走子，棋子弹回原位（不是「偷偷走了一步」） |
 * | D3 | 2D：拖动**过程中**显示落点提示，且原格高亮（看得出是从哪儿拿起来的） |
 * | D4 | 2D：在原格内拖一下松手 → 既不走子，**也不把它选中**（拖完不误触发点选） |
 * | D5 | 2D：**点选走子仍然可用**（回归 —— 拖拽不能把老交互吃掉） |
 * | D6 | 3D：按住棋子拖 → 真的走了这步棋 |
 * | D7 | 3D：拖动时棋子**抬起来了**（Z 轴上抬一点，量的是渲染出来的真实坐标） |
 * | D8 | 3D：拖动时**相机没有跟着转**（按住棋子 = 拖棋子，不是转视角） |
 * | D9 | 3D：**按住空白处仍然能转视角**（反过来那条也不能坏） |
 * | D10 | 3D：**点选走子仍然可用**（回归 —— 拖拽不能把老交互吃掉） |
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（D1…D10）——
 * 变异脚本靠「❌ 行里含门禁编号」判定「这一条被抓到了」，失败信息不带编号就会出现假绿。
 *
 * ## 黑白现在是**抽签**定的
 *
 * 规则改过了：两个人到齐时服务端用 `crypto.randomInt` **一次性抽签**定黑白，
 * 之后**双方都点「准备」**才开局（白方先走）。
 * 于是浏览器这一局执白还是执黑是**随机的**（各 50%）——
 * 门禁里凡是「浏览器是黑方 / 白方」的地方，都改成
 * **先从房间快照读出浏览器的实际执色，再按那条线走**。
 *
 * 用法：
 *   npx tsx scripts/verify-drag.ts [--url=http://127.0.0.1:3000] [--group=drag2d,drag3d]
 *
 * 零新增依赖：复用项目已有的 ws / chess.js；Chromium 用本机 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Chess } from 'chess.js';
import { legalTargets } from '../src/lib/chess-engine';
import { squareToWorld } from '../src/components/pieceGeometry';
import { makeGateFilter, parseGroupFilter } from './lib/gate-groups';
import { DRAG_GROUPS } from './lib/drag-groups';
import { GameClient, sideOfName, sleep, waitPlaying, waitPreparing, type RoomSnapshot } from './lib/game-client';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */
/**
 * 地址解析：**位置参数不能靠「位置」猜**（`--group=drag2d` 会被当成地址）。
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

const selectedGroups = parseGroupFilter(DRAG_GROUPS, process.argv.slice(2));
const gateFilter = makeGateFilter(DRAG_GROUPS, selectedGroups);

const OUT_DIR = join(process.cwd(), 'artifacts', 'drag');
const VIEW_W = 1600;
const VIEW_H = 1000;

/** 所有格名（a1…h8） */
const ALL_SQUARES: string[] = [];
for (const f of 'abcdefgh') for (let r = 1; r <= 8; r += 1) ALL_SQUARES.push(`${f}${r}`);

/* ------------------------------------------------------------------ */
/* 执色适配                                                            */
/* ------------------------------------------------------------------ */
/**
 * 门禁里**浏览器**的用户名。
 *
 * 它有两个用途，得是**同一个值**：
 *   ① 登录大厅时填进去；
 *   ② 抽签之后查「浏览器执白还是执黑」（`sideOfName` 按**座位名**找人）。
 * 写成两个地方各一份的字符串字面量，改了一处忘了另一处 =
 * 「查不到这个座位」→ 门禁红，但红得莫名其妙。
 */
const BROWSER_NAME = '拖拽验收员';

/**
 * 门禁要拖的那颗兵 —— **按浏览器的实际执色**决定走哪条线。
 *
 * ## 为什么不能写死
 *
 * 黑白现在是**抽签**定的（服务端用 `crypto.randomInt` 掷），
 * 浏览器有 50% 概率执白、50% 概率执黑。
 * 写死「d7 的黑兵」就等于有一半的运行必然失败 ——
 * 而且是**假红**：门禁红的不是产品坏了，是门禁自己假设错了。
 *
 * ## 两条线是**镜像**的
 *
 * 白方视角：兵在 d2 → d4 → d5 → d6；
 * 黑方视角：兵在 d7 → d5 → d4 → d3。
 * 也就是把 rank 换成 `9 - rank`（d7↔d2、d5↔d4、d4↔d5、d3↔d6）。
 */
interface PawnPlan {
  /** D1：一步合法的**两格**推进（d7→d5 / d2→d4） */
  d1: { from: string; to: string };
  /** D2：拖到**非法**格（那格服务端会拒） */
  d2: { from: string; illegal: string };
  /** D3：一步合法推进（拖动过程中要显示落点提示） */
  d3: { from: string; to: string };
  /** D4：在原格内拖一下（既不走子也不选中） */
  d4: { from: string };
  /** D5：点选走子 */
  d5: { from: string; to: string };
}

const PAWN_PLANS: Record<'w' | 'b', PawnPlan> = {
  /** 浏览器执黑：兵在 d7，往 rank 3 方向走 */
  b: {
    d1: { from: 'd7', to: 'd5' },
    d2: { from: 'd5', illegal: 'd3' }, // d5 的兵只能到 d4，d3 非法
    d3: { from: 'd5', to: 'd4' },
    d4: { from: 'd4' },
    d5: { from: 'd4', to: 'd3' },
  },
  /** 浏览器执白：兵在 d2，往 rank 8 方向走（上面那条线的镜像） */
  w: {
    d1: { from: 'd2', to: 'd4' },
    d2: { from: 'd4', illegal: 'd6' }, // d4 的兵只能到 d5，d6 非法
    d3: { from: 'd4', to: 'd5' },
    d4: { from: 'd5' },
    d5: { from: 'd5', to: 'd6' },
  },
};
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
/* ------------------------------------------------------------------ */
/* 棋局小工具                                                          */
/* ------------------------------------------------------------------ */
/** FEN 里某个格子上是什么（没有 → null） */
function pieceAt(fen: string, square: string): { type: string; color: string } | null {
  try {
    const p = new Chess(fen).get(square as never);
    return p ? { type: p.type, color: p.color } : null;
  } catch {
    return null;
  }
}

/** 试着走一步，返回走完的 FEN（不合法 → null） */
function applyQuiet(fen: string, from: string, to: string): string | null {
  try {
    const g = new Chess(fen);
    g.move({ from: from as never, to: to as never });
    return g.fen();
  } catch {
    return null;
  }
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
    selectedGroups === null ? '本次门禁组：全跑' : `本次门禁组：${selectedGroups.join('、')}`,
  );
  console.log('');

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-drag-'));
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
     * 抓一手浏览器的 WebSocket 报文（**只在门禁脚本里注入**，不改产品代码）。
     *
     * 为什么必须有它：
     *   门禁要看的是「**浏览器这边**能不能拖」。
     *   只等服务端快照是不够的 —— 服务端早就说「轮到黑方」，
     *   但浏览器的 React 状态还没更新，`canDragFrom` 仍然是上一回合的值，
     *   于是「按住棋子」被直接忽略（表现为「按下去没反应」）。
     *   有了浏览器侧的报文流水，就能等到「浏览器确实收到这个局面」再动手。
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
                let status = '';
                let fen = '';
                let from = '';
                let to = '';
                try {
                  const j = JSON.parse(s);
                  t = j.t || '?';
                  if (j.code) code = j.code;
                  if (j.state && j.state.code) code = j.state.code;
                  if (j.state && j.state.fen) fen = j.state.fen;
                  if (j.state && j.state.status) status = j.state.status;
                  if (j.from) from = j.from;
                  if (j.to) to = j.to;
                } catch { /* 不是 JSON 就原样存 */ }
                window.__wsLog.push({ dir, t, code, status, fen, from, to, at: Date.now() });
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

    /**
     * 等一个条件成立。
     *
     * 断言可以是**异步**的 —— 之前写成 `if (pred())` 时，
     * 传进来的 Promise 永远为真，于是「等浏览器就绪」其实一次都没等过。
     */
    const waitFor = async (
      pred: () => boolean | Promise<boolean>,
      label: string,
      timeoutMs = 10000,
    ): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await pred()) return;
        await sleep(120);
      }
      throw new Error(`等待「${label}」超时`);
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
      if (!done) {
        // 失败时把页面上的字打出来 —— 不然只能猜「到底缺了什么」
        const page = await evaluate<string>(
          `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`,
        );
        throw new Error(`点不到「${label}」（文本含「${text}」）。页面文字：${page}`);
      }
    };

    /**
     * 点「准备」按钮 —— 抽签之后、正式开局之前，真人对局双方各点一次。
     *
     * ## 为什么不能直接用 `clickText`
     *
     * `clickText` 是**包含**匹配（`textContent.includes(text)`），
     * 而点了之后按钮会变成「**已准备**」并且 `disabled` ——
     * 「已准备」也包含「准备」，包含匹配会挑到一个**点不动**的按钮，
     * 而且报错只会说「点不到」，完全看不出是「它已经准备过了」。
     * 这里按**整段文本相等 + 未 disabled** 精确挑。
     */
    const clickReadyButton = async (): Promise<void> => {
      const done = await evaluate<boolean>(`(() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent || '').trim() === '准备' && !b.disabled);
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!done) {
        const page = await evaluate<string>(
          `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`,
        );
        throw new Error(`点不到「准备」按钮（.hud-actions 里没有可点的「准备」）。页面文字：${page}`);
      }
    };

    /* ================================================================ */
    /* 鼠标：模拟一次真实的「按住 → 拖 → 松手」                            */
    /* ================================================================ */
    const mouse = (
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
      x: number,
      y: number,
      buttons: number,
    ): Promise<any> =>
      cdp!.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });

    /** 按下 */
    const mouseDown = (x: number, y: number): Promise<any> => mouse('mousePressed', x, y, 1);

    /** 松手 */
    const mouseUp = (x: number, y: number): Promise<any> => mouse('mouseReleased', x, y, 0);

    /** 分几步拖到目标点 */
    const mouseDragTo = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      steps = 6,
    ): Promise<void> => {
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
        await sleep(25);
      }
    };

    /* ================================================================ */
    /* 棋盘读数                                                          */
    /* ================================================================ */
    /**
     * 3D：按在棋子**本体**上的高度。
     *
     * 为什么不能按在棋面上：那样射线是**擦着棋子的细杆**掠过去的 ——
     * 实测余量不到 0.01 个世界单位，稍微偏一点就打不中棋子。
     */
    const PIECE_BODY_Y = 0.27;

    /**
     * 3D 拖一次：从 from 拖到 to。
     *
     * ## 落点怎么换算
     *
     * 产品侧的规则是「**棋子位置 = 光标落点 − 抓取偏移**」，
     * 所以要让棋子落在目标格，光标的落点必须是「**目标格中心 + 抓取偏移**」。
     * 抓取偏移是按下那一刻算出来的（手抓在棋子身上的哪个点），
     * 所以要先按下去、读到偏移，才知道松手时指针该在哪。
     */
    const drag3D = async (
      from: string,
      to: string,
      opts: { during?: () => Promise<void>; steps?: number } = {},
    ): Promise<void> => {
      const press = await project3D(from, PIECE_BODY_Y);
      await mouseDown(press.x, press.y);
      await sleep(150);
      const grab = await grab3D();
      if (!grab || grab.from !== from) {
        throw new Error(
          `没抓到棋子 ${from}（抓取诊断=${JSON.stringify(grab)}）—— 按下去的点没落在棋子上`,
        );
      }
      const target = squareToWorld(to);
      const release = await projectWorld3D(target.x + grab.offsetX, target.z + grab.offsetZ);
      await mouseDragTo(press, release, opts.steps ?? 6);
      if (opts.during) await opts.during();
      await mouseUp(release.x, release.y);
    };
    /** 2D：某个格子的屏幕中心 */
    const squareCenter = async (square: string): Promise<{ x: number; y: number }> => {
      const pt = await evaluate<{ x: number; y: number } | null>(`(() => {
        const el = document.querySelector('.square[data-square="${square}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pt) throw new Error(`2D 棋盘上找不到格子 ${square}`);
      return pt;
    };

    /** 2D：某个格子边长（用来算「在原格内挪一小段」） */
    const squareSize = async (square: string): Promise<number> => {
      const s = await evaluate<number | null>(`(() => {
        const el = document.querySelector('.square[data-square="${square}"]');
        if (!el) return null;
        return el.getBoundingClientRect().width;
      })()`);
      if (!s) throw new Error(`2D 棋盘上找不到格子 ${square}`);
      return s;
    };

    /**
     * 2D：棋盘上每个格子里有哪些棋子（颜色）。
     *
     * 棋子层（`.piece-layer`）是格子的**兄弟**而不是子元素，
     * 所以不能靠 DOM 层级找，只能按**中心点落在哪一格**来判断。
     */
    const boardState = async (): Promise<Record<string, string[]>> =>
      evaluate(`(() => {
        const squares = [...document.querySelectorAll('.square[data-square]')];
        const pieces = [...document.querySelectorAll('.piece')].map((p) => ({
          p,
          r: p.getBoundingClientRect(),
        }));
        const out = {};
        for (const sq of squares) {
          const r = sq.getBoundingClientRect();
          const hit = [];
          for (const { p, r: pr } of pieces) {
            const px = pr.left + pr.width / 2;
            const py = pr.top + pr.height / 2;
            if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) {
              const color = [...p.classList].find((c) => c === 'w' || c === 'b');
              hit.push(color || '?');
            }
          }
          out[sq.dataset.square] = hit;
        }
        return out;
      })()`);

    /** 3D：某个格子在屏幕上的位置（默认棋面；传高度则投影到那个高度） */
    const project3D = async (square: string, y?: number): Promise<{ x: number; y: number }> => {
      const extra = y === undefined ? '' : `, ${y}`;
      const pt = await evaluate<{ x: number; y: number } | null>(
        `(() => { const f = window.__chessProject; if (!f) return null; return f(${JSON.stringify(
          square,
        )}${extra}); })()`,
      );
      if (!pt) throw new Error(`3D 投影拿不到格子 ${square}（__chessProject 没就绪？）`);
      return pt;
    };

    /** 3D：棋面上任意一点（世界坐标 xz）的屏幕投影 */
    const projectWorld3D = async (x: number, z: number): Promise<{ x: number; y: number }> => {
      const pt = await evaluate<{ x: number; y: number } | null>(
        `(() => { const f = window.__chessProjectWorld; if (!f) return null; return f(${x}, ${z}); })()`,
      );
      if (!pt) throw new Error('3D 世界坐标投影不可用（__chessProjectWorld 没就绪？）');
      return pt;
    };

    /** 3D：抓取诊断（抓在棋子上的哪个点） */
    const grab3D = async (): Promise<{ from: string; offsetX: number; offsetZ: number } | null> =>
      evaluate(`(() => {
        const g = window.__chessGrab;
        if (!g) return null;
        return { from: g.from || '', offsetX: g.offsetX, offsetZ: g.offsetZ };
      })()`);

    /** 3D：当前拖拽诊断 */
    const dragDiag = async (): Promise<{
      active: boolean;
      from: string;
      x: number;
      y: number;
      z: number;
      restY: number;
    }> =>
      evaluate(`(() => {
        const d = window.__chessDrag;
        if (!d) return { active: false, from: '', x: 0, y: 0, z: 0, restY: 0 };
        return { active: !!d.active, from: d.from || '', x: d.x, y: d.y, z: d.z, restY: d.restY };
      })()`);

    /** 3D：当前机位 */
    const camState = async (): Promise<{
      azimuth: number | null;
      polar: number | null;
      distance: number | null;
      enabled: boolean | null;
    }> =>
      evaluate(`(() => {
        const c = window.__chessCam;
        if (!c) return { azimuth: null, polar: null, distance: null, enabled: null };
        return {
          azimuth: c.azimuth,
          polar: c.polar,
          distance: c.distance,
          enabled: c.enabled === null || c.enabled === undefined ? null : !!c.enabled,
        };
      })()`);

    /**
     * 浏览器**有没有收到**这个局面（且房间已经开局）的快照。
     *
     * 这是「服务端说该我走了」和「浏览器真的能拖了」之间的那一步 ——
     * 服务端更新得比浏览器快，不等这一下就会出现「按下去没反应」。
     *
     * ## 为什么必须连**状态**一起看
     *
     * 房间在「**准备中**」阶段就已经带着 FEN 了（还是 `START_FEN`），
     * 只看「浏览器见过这个 FEN」会把「还在准备中」误判成「已经开局」——
     * 而 `canDragFrom` 还要 `status === 'playing'` 才好使。
     * 所以这里要求**同一条报文**里 FEN 和状态都对得上。
     */
    const browserSawRoom = async (fen: string, status: string): Promise<boolean> =>
      evaluate(
        `(window.__wsLog || []).some((e) => e.dir === 'in' && e.fen === ${JSON.stringify(
          fen,
        )} && e.status === ${JSON.stringify(status)})`,
      );

    /**
     * 浏览器**收到过**某个状态的房间快照（不看 FEN）。
     *
     * 用它确认「浏览器自己已经知道房间在准备中了」——
     * 也就是「准备」按钮这会儿已经渲染出来，可以点了。
     */
    const browserSawStatus = async (status: string): Promise<boolean> =>
      evaluate(
        `(window.__wsLog || []).some((e) => e.dir === 'in' && e.status === ${JSON.stringify(
          status,
        )})`,
      );

    /**
     * 浏览器**发出**的走子消息（`from` → `to`）。
     *
     * 为什么门禁要看这个：
     *   非法落点由**服务端**兜底（服务端会拒），
     *   所以「服务端局面没变」是**恒真**的 —— 那条判据抓不到任何东西。
     *   真正由**客户端**负责的是「**该不该发这条 move**」——
     *   所以判据落在这里：拖到非法格，浏览器就**不该发出**任何 move。
     */
    const outboundMoves = async (): Promise<Array<{ from: string; to: string }>> =>
      evaluate(`(window.__wsLog || [])
        .filter((e) => e.dir === 'out' && e.t === 'move')
        .map((e) => ({ from: e.from || '', to: e.to || '' }))`);

    /* ================================================================ */
    /* 准备：登录进大厅                                                  */
    /* ================================================================ */
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(600);
    await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
    await evaluate(`
      (() => {
        const input = document.querySelector('input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(BROWSER_NAME)});
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
    /* 对手（ws 客户端）                                                 */
    /* ================================================================ */
    /** 当前这一局的对手 */
    let opp: GameClient = null as unknown as GameClient;
    /**
     * 浏览器这一局执什么颜色（**抽签**定的，各 50%）。
     *
     * 门禁后面所有的「拖哪颗兵」「拖到哪」「那子是什么颜色」都跟着它走。
     */
    let browserSide: 'w' | 'b' = 'b';

    /**
     * 开一局：对手建房 → 浏览器进去 → **双方都点准备** → 开局。
     *
     * ## 现在的规则（抽签 + 准备）
     *
     *   ① 先建房的人进「**颜色待定**」状态（`state.pending` 里有他），还没有座位；
     *   ② 第二个人（浏览器）加入时，服务端用 `crypto.randomInt` **一次性抽签**定黑白；
     *   ③ 房间进入 `preparing`，**双方都点「准备」**才 `playing`（白方先走）。
     *
     * 所以浏览器这一局执白还是执黑是**随机的** ——
     * 门禁必须先问一句「浏览器到底是白还是黑」，再决定用哪一套着法。
     *
     * 每一局都用**全新的对手连接**：同一个对手连开两局时，
     * 上一局的座位还挂在服务端（不会自动摘），两局的快照会混在一起。
     */
    const startGame = async (): Promise<string> => {
      opp?.close();
      opp = new GameClient(WS_URL);
      await opp.ready();
      opp.send({ t: 'hello', name: '对手乙' });
      await opp.waitFor((m) => (m.t === 'session' ? m : null), '对手的 session');
      const since = opp.msgCount;
      opp.send({ t: 'room.create', timeControl: '30+0' });
      const snap = await opp.waitForRoomSince(since, '对手的房间快照');
      const code = snap.code ?? '';
      if (!code) throw new Error('对手的房间快照里没有房间码');
      await cdp!.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
      await waitForExpr(
        `location.pathname.toUpperCase().includes('${code}')`,
        '跳转到对局页',
        20000,
      );
      /*
       * 等**抽签完成**（房间进入 `preparing`）。
       *
       * 这一步**必须等浏览器 join 进来**才会发生：
       * 先进来的人只是「颜色待定」，房间还停在 `waiting`，
       * 两个人到齐的那一刻服务端才掷签、才发 `preparing`。
       */
      await waitPreparing(opp, since, 25000);
      /*
       * 双方都点「准备」才开局：
       *   · 浏览器点 `.hud-actions` 里那个「准备」；
       *   · 对手（ws 客户端）发 `{ t: 'ready' }`。
       *
       * 点之前先等**浏览器自己**收到 `preparing` 的房间快照 ——
       * 「准备」按钮这会儿才渲染出来（它按 `roomState.status === 'preparing'` 显示）。
       */
      await waitFor(
        () => browserSawStatus('preparing'),
        '浏览器收到「准备中」的房间快照',
        20000,
      );
      await clickReadyButton();
      opp.send({ t: 'ready' });
      await waitPlaying(opp, since, 25000);
      await waitForExpr(
        `!!document.querySelector('.board2d, .board3d-wrap canvas')`,
        '棋盘渲染',
        25000,
      );
      /*
       * 抽签结果：浏览器这一局执白还是执黑。
       *
       * 按**座位名**找人（`sideOfName`）—— 不用去翻浏览器的 token。
       */
      const side = sideOfName(opp.latestRoom(), BROWSER_NAME);
      if (side !== 'w' && side !== 'b') {
        throw new Error(
          `查不到浏览器抽到的执色（房间快照里没有「${BROWSER_NAME}」这个座位）：` +
            JSON.stringify(opp.latestRoom()?.seats),
        );
      }
      browserSide = side;
      const mine = browserSide === 'w' ? '白' : '黑';
      const theirs = browserSide === 'w' ? '黑' : '白';
      console.log(`已进入对局页：${code}（浏览器抽到${mine}方，对手执${theirs}方）`);
      return code;
    };

    /**
     * 保证**轮到浏览器**，而且「**浏览器那颗兵**」还能按预期走。
     *
     * ## 为什么不能写死「浏览器是黑方」
     *
     * 黑白现在是**抽签**定的 —— 浏览器有一半的概率执白。
     * 所以三处都得跟着执色走：
     *   · 「轮到谁」按**浏览器自己的执色**判断；
     *   · 对手挑着法时按**对手自己的执色**挑（`legalTargets(fen, sq, 对手执色)`）；
     *   · 挑完之后要保证**浏览器那颗兵**仍然能走到预期落点。
     *
     * 为什么要「按预期」挑对手这一步：
     *   对手是自动挑一步的 —— 万一它挑到一步把浏览器那颗兵吃掉/牵制住，
     *   后面几条门禁就没得测了。所以挑的时候要看一眼「走完之后那颗兵还能走到预期落点」。
     *
     * 为什么要等「浏览器收到局面」：
     *   服务端快照变了 ≠ 浏览器能拖了。等浏览器的报文流水里出现这个局面，
     *   才说明浏览器那边也更新完了（否则 `canDragFrom` 还是上一回合的值）。
     *
     * @param pawnSq     浏览器那颗兵现在在哪
     * @param pawnTarget 走完之后它应该还能到哪（用来筛对手的着法）
     */
    const ensureBrowserTurn = async (pawnSq: string, pawnTarget: string): Promise<string> => {
      const fen = opp.latestRoom()?.fen ?? '';
      if (!fen) throw new Error('拿不到对手那边的房间快照');
      const myColor = browserSide;
      const oppColor = myColor === 'w' ? 'b' : 'w';
      const waitBrowser = async (f: string): Promise<string> => {
        await waitFor(
          () => browserSawRoom(f, 'playing'),
          `浏览器收到最新局面（${f.slice(0, 24)}…）`,
          12000,
        );
        await sleep(250); // 等 React 把它渲染出来
        return f;
      };
      // 已经轮到浏览器 → 不用对手动，直接开拖
      if (fen.split(' ')[1] === myColor) return waitBrowser(fen);
      /*
       * 现在轮到**对手** —— 对手得走一步，浏览器才轮得到。
       *
       * 挑着法按**对手自己的执色**挑（抽签之后对手可能是黑方）。
       */
      const candidates: Array<{ from: string; to: string }> = [];
      for (const sq of ALL_SQUARES) {
        for (const t of legalTargets(fen, sq, oppColor)) {
          if (!t.promotionRequired) candidates.push({ from: sq, to: t.to });
        }
      }
      for (const c of candidates) {
        const after = applyQuiet(fen, c.from, c.to);
        if (!after) continue;
        const ts = legalTargets(after, pawnSq, myColor);
        if (!ts.some((t) => t.to === pawnTarget)) continue;
        opp.send({ t: 'move', from: c.from, to: c.to });
        await waitFor(() => (opp.latestRoom()?.fen ?? '') !== fen, '对手走子生效', 10000);
        return waitBrowser(opp.latestRoom()?.fen ?? '');
      }
      throw new Error(
        `对手挑不出一步「走完之后浏览器那颗兵还在预期位置」的着（执色 ${myColor}）`,
      );
    };

    /** 切到 2D / 3D */
    const switchView = async (mode: '2d' | '3d'): Promise<void> => {
      await clickText('.view-toggle button', mode === '3d' ? '3D' : '2D', `视角切换 ${mode}`);
      await sleep(400);
      if (mode === '3d') {
        await waitForExpr(`!!document.querySelector('.board3d-wrap canvas')`, '3D 画布渲染', 25000);
        await waitForExpr(`typeof window.__chessProject === 'function'`, '3D 投影接口就绪', 25000);
      } else {
        await waitForExpr(`!!document.querySelector('.square[data-square]')`, '2D 棋盘渲染', 20000);
      }
      await sleep(500);
    };

    /* ================================================================ */
    /* 2D 组                                                            */
    /* ================================================================ */
    if (gateFilter('D1') || gateFilter('D2') || gateFilter('D3') || gateFilter('D4') || gateFilter('D5')) {
      await startGame();
      await switchView('2d');

      /* ---------------- D1：拖到合法格 → 真的走了这步棋 ---------------- */
      await step('D1', '2D：按住棋子拖到目标格 → 真的走了这步棋', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d1.from, plan.d1.to);
        const before = opp.latestRoom()?.fen ?? '';
        const a = await squareCenter(plan.d1.from);
        const b = await squareCenter(plan.d1.to);
        await mouseDown(a.x, a.y);
        await mouseDragTo(a, b);
        await shot('d1-2d-dragging');
        await mouseUp(b.x, b.y);
        await waitFor(() => (opp.latestRoom()?.fen ?? '') !== before, '服务端收到走子', 10000);
        const after = opp.latestRoom()?.fen ?? '';
        const board = await boardState();
        const onTo = pieceAt(after, plan.d1.to);
        const onFrom = pieceAt(after, plan.d1.from);
        const domTo = board[plan.d1.to] ?? [];
        const domFrom = board[plan.d1.from] ?? [];
        const ok =
          onTo?.type === 'p' &&
          onTo?.color === browserSide &&
          onFrom === null &&
          domTo.length === 1 &&
          domTo[0] === browserSide &&
          domFrom.length === 0;
        await shot('d1-2d-dropped');
        verdict(
          ok,
          'D1 2D：按住棋子拖到目标格 → 真的走了这步棋',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `服务端 ${plan.d1.to}=${JSON.stringify(onTo)}、${plan.d1.from}=${JSON.stringify(onFrom)}｜` +
            `页面上 ${plan.d1.to}=${JSON.stringify(domTo)}、${plan.d1.from}=${JSON.stringify(domFrom)}`,
        );
      });

      /* ---------------- D2：拖到非法格 → 不走子 --------------------- */
      await step('D2', '2D：拖到非法格 → 不走子，棋子弹回原位', async () => {
        const plan = PAWN_PLANS[browserSide];
        /*
         * 挑对手的着法时，约束是「走完之后**浏览器那颗兵**还能走到 `plan.d3.to`」。
         * （D3 那条门禁接着就把兵推到那儿，所以这里挡的是「对手把兵牵住了」。）
         */
        await ensureBrowserTurn(plan.d2.from, plan.d3.to);
        const before = opp.latestRoom()?.fen ?? '';
        const sentBefore = await outboundMoves();
        const a = await squareCenter(plan.d2.from);
        const b = await squareCenter(plan.d2.illegal); // 兵只能到 plan.d3.to，这格非法
        await mouseDown(a.x, a.y);
        await mouseDragTo(a, b);
        await mouseUp(b.x, b.y);
        await sleep(900);
        const after = opp.latestRoom()?.fen ?? '';
        const sentAfter = await outboundMoves();
        const board = await boardState();
        const unchanged = after === before;
        const backHome =
          (board[plan.d2.from] ?? []).length === 1 &&
          (board[plan.d2.from] ?? [])[0] === browserSide;
        const notOnIllegal = (board[plan.d2.illegal] ?? []).length === 0;
        /*
         * 关键判据：**浏览器没有发出**这步棋。
         *
         * 只看「服务端局面没变」是恒真的 —— 服务端本来就会拒非法着，
         * 那条判据抓不到任何东西。真正由客户端负责的是「该不该发这条 move」。
         */
        const newMoves = sentAfter.slice(sentBefore.length);
        const noMoveSent = newMoves.length === 0;
        await shot('d2-2d-illegal');
        verdict(
          unchanged && backHome && notOnIllegal && noMoveSent,
          'D2 2D：拖到非法格 → 不走子，棋子弹回原位',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜服务端局面没变=${unchanged}｜` +
            `${plan.d2.from} 上还有那颗兵=${backHome}｜${plan.d2.illegal} 上没有=${notOnIllegal}｜` +
            `浏览器没发出 move=${noMoveSent}` +
            (newMoves.length ? `（**发了**：${JSON.stringify(newMoves)}）` : ''),
        );
      });

      /* ---------------- D3：拖动中显示落点提示 ----------------------- */
      await step('D3', '2D：拖动过程中显示落点提示，原格高亮', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d3.from, plan.d3.to);
        const a = await squareCenter(plan.d3.from);
        const b = await squareCenter(plan.d3.to);
        await mouseDown(a.x, a.y);
        await mouseDragTo(a, b, 3);
        const view = await evaluate<{
          toDot: boolean;
          toRing: boolean;
          fromSelected: boolean;
          anyHint: number;
        }>(`(() => {
          const from = document.querySelector('.square[data-square=${JSON.stringify(
            plan.d3.from,
          )}]');
          const to = document.querySelector('.square[data-square=${JSON.stringify(plan.d3.to)}]');
          return {
            toDot: !!(to && to.querySelector('.hint-dot')),
            toRing: !!(to && to.querySelector('.hint-ring')),
            fromSelected: !!(from && from.classList.contains('selected')),
            anyHint: document.querySelectorAll('.hint-dot, .hint-ring').length,
          };
        })()`);
        await shot('d3-2d-hints');
        await mouseUp(b.x, b.y);
        await sleep(700);
        // 拖到 plan.d3.to 是合法着 → 这条门禁顺手把棋走掉了，后面几条要重新造回合
        verdict(
          view.toDot && view.fromSelected && view.anyHint >= 1,
          'D3 2D：拖动过程中显示落点提示，原格高亮',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `${plan.d3.to} 有落点圆点=${view.toDot}｜${plan.d3.to} 有吃子红圈=${view.toRing}｜` +
            `原格 ${plan.d3.from} 高亮=${view.fromSelected}｜页面上一共 ${view.anyHint} 个落点提示`,
        );
      });

      /* ---------------- D4：在原格内拖一下 → 不走子也不选中 ----------- */
      await step('D4', '2D：在原格内拖一下松手 → 既不走子，也不把它选中', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d4.from, plan.d5.to);
        const before = opp.latestRoom()?.fen ?? '';
        const a = await squareCenter(plan.d4.from);
        const cell = await squareSize(plan.d4.from);
        // 在**自己那一格内**挪 1/4 格：够超过 4px 的拖动阈值，但没离开这一格
        const end = { x: a.x + cell * 0.25, y: a.y };
        await mouseDown(a.x, a.y);
        await mouseDragTo(a, end, 4);
        await mouseUp(end.x, end.y);
        await sleep(800);
        const after = opp.latestRoom()?.fen ?? '';
        const board = await boardState();
        const unchanged = after === before;
        const stillThere = (board[plan.d4.from] ?? []).length === 1;
        const notSelected = await evaluate<boolean>(
          `!document.querySelector('.square.selected') && document.querySelectorAll('.hint-dot, .hint-ring').length === 0`,
        );
        await shot('d4-2d-same-square');
        verdict(
          unchanged && stillThere && notSelected,
          'D4 2D：在原格内拖一下松手 → 既不走子，也不把它选中',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜局面没变=${unchanged}｜` +
            `${plan.d4.from} 上棋子还在=${stillThere}｜` +
            `没有被顺手选中（页面无 .selected / 无落点提示）=${notSelected}`,
        );
      });

      /* ---------------- D5：点选走子仍然可用（回归） ----------------- */
      await step('D5', '2D：点选走子仍然可用（拖拽没把老交互吃掉）', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d5.from, plan.d5.to);
        const before = opp.latestRoom()?.fen ?? '';
        const a = await squareCenter(plan.d5.from);
        const b = await squareCenter(plan.d5.to);
        // 点起点 → 点终点（老交互）
        await mouseDown(a.x, a.y);
        await mouseUp(a.x, a.y);
        await sleep(350);
        const selected = await evaluate<boolean>(
          `!!document.querySelector('.square[data-square=${JSON.stringify(plan.d5.from)}].selected')`,
        );
        await mouseDown(b.x, b.y);
        await mouseUp(b.x, b.y);
        await waitFor(() => (opp.latestRoom()?.fen ?? '') !== before, '点选走子生效', 10000);
        const after = opp.latestRoom()?.fen ?? '';
        const onTo = pieceAt(after, plan.d5.to);
        const ok = selected && onTo?.type === 'p' && onTo?.color === browserSide;
        await shot('d5-2d-click-move');
        verdict(
          ok,
          'D5 2D：点选走子仍然可用（拖拽没把老交互吃掉）',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `点一下 ${plan.d5.from} 选中了=${selected}｜服务端 ${plan.d5.to}=${JSON.stringify(onTo)}`,
        );
      });
    }

    /* ================================================================ */
    /* 3D 组                                                            */
    /* ================================================================ */
    if (
      gateFilter('D6') ||
      gateFilter('D7') ||
      gateFilter('D8') ||
      gateFilter('D9') ||
      gateFilter('D10')
    ) {
      await startGame();
      await switchView('3d');

      /* ---------------- D6：3D 拖动走子成功 ------------------------- */
      await step('D6', '3D：按住棋子拖 → 真的走了这步棋', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d1.from, plan.d1.to);
        const before = opp.latestRoom()?.fen ?? '';
        await drag3D(plan.d1.from, plan.d1.to);
        await waitFor(() => (opp.latestRoom()?.fen ?? '') !== before, '服务端收到走子', 10000);
        const after = opp.latestRoom()?.fen ?? '';
        const onTo = pieceAt(after, plan.d1.to);
        const onFrom = pieceAt(after, plan.d1.from);
        const ok = onTo?.type === 'p' && onTo?.color === browserSide && onFrom === null;
        await shot('d6-3d-dropped');
        verdict(
          ok,
          'D6 3D：按住棋子拖 → 真的走了这步棋',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `服务端 ${plan.d1.to}=${JSON.stringify(onTo)}、${plan.d1.from}=${JSON.stringify(onFrom)}`,
        );
      });

      /* ---------------- D7：拖动时棋子抬起来了 ----------------------- */
      await step('D7', '3D：拖动时棋子抬起来一点（Z 轴上抬）', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d3.from, plan.d3.to);
        // 用数组收「拖动过程中的读数」—— 局部变量在回调里赋值，TS 的控制流分析会把它当成没赋过
        const seen: Array<{ active: boolean; from: string; x: number; y: number; z: number; restY: number }> =
          [];
        await drag3D(plan.d3.from, plan.d3.to, {
          steps: 3,
          during: async () => {
            seen.push(await dragDiag());
            await shot('d7-3d-lifted'); // 拖动**过程中**截 —— 才看得到棋子是浮着的
          },
        });
        await sleep(700);
        const diag = seen[0] ?? { active: false, from: '', x: 0, y: 0, z: 0, restY: 0 };
        const lift = diag.y - diag.restY;
        const ok = diag.active && diag.from === plan.d3.from && lift > 0.15 && lift < 0.9;
        await shot('d7-3d-lifted');
        verdict(
          ok,
          'D7 3D：拖动时棋子抬起来一点（Z 轴上抬）',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `拖拽诊断：active=${diag.active}、from=${diag.from}｜` +
            `渲染出来的 y=${diag.y.toFixed(3)}、静止高度=${diag.restY.toFixed(3)}｜抬起了 ${lift.toFixed(3)} 格`,
        );
      });

      /* ---------------- D8：拖动时相机不转 --------------------------- */
      await step('D8', '3D：拖棋子的时候相机不跟着转', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d4.from, plan.d5.to);
        const camBefore = await camState();
        const seenDrag: Array<{ active: boolean; from: string }> = [];
        /*
         * **必须水平拖**（和 D9 的操作对称）。
         *
         * 原来这里是「把棋子从 d4 拖到 d3」—— 那是**竖直**方向：
         *   · 水平分量 rotateDelta.x = 0 → 方位角**根本不会变**；
         *   · 竖直分量撞在 maxPolarAngle（π×0.36）上 → 极角也被限幅吃掉。
         * 于是「相机纹丝不动」在这条路径下是**恒真**的：
         * 把 `enabled={!dragging}` 改成 `enabled={true}`（相机本来就该转了），
         * 门禁照样是绿的 —— 这条门禁抓不住任何回退。
         *
         * 改成水平拖之后：水平分量不再为 0，相机一旦被接管，
         * 方位角必然有明显变化 → 判据才真的抓得住回退。
         */
        const press = await project3D(plan.d4.from, PIECE_BODY_Y);
        await mouseDown(press.x, press.y);
        await sleep(150);
        const grab = await grab3D();
        if (!grab || grab.from !== plan.d4.from) {
          throw new Error(
            `D8 没抓住 ${plan.d4.from} 的棋子（抓取诊断=${JSON.stringify(grab)}）`,
          );
        }
        await mouseDragTo(press, { x: press.x + 90, y: press.y }, 8);
        const during = await camState();
        const dDiag = await dragDiag();
        seenDrag.push({ active: dDiag.active, from: dDiag.from });
        await mouseUp(press.x + 90, press.y);
        await sleep(700);
        const dAz =
          camBefore.azimuth !== null && during.azimuth !== null
            ? Math.abs(during.azimuth - camBefore.azimuth)
            : null;
        const dPol =
          camBefore.polar !== null && during.polar !== null
            ? Math.abs(during.polar - camBefore.polar)
            : null;
        /*
         * 判据里**必须**带上「拖动确实起来了」这一条 ——
         * 否则「拖都没拖起来」也会让相机纹丝不动，这条门禁就成了摆设。
         */
        const dragStarted = Boolean(seenDrag[0]?.active);
        const ok =
          dragStarted && dAz !== null && dPol !== null && dAz < 0.01 && dPol < 0.01;
        await shot('d8-3d-camera-still');
        verdict(
          ok,
          'D8 3D：拖棋子的时候相机不跟着转',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜拖动确实起来了=${dragStarted}｜` +
            `相机控制器开着=${during.enabled}｜` +
            `拖动前后方位角变化=${dAz === null ? '读不到' : dAz.toFixed(5)}｜` +
            `极角变化=${dPol === null ? '读不到' : dPol.toFixed(5)}（阈值 0.01 弧度）`,
        );
      });

      /* ---------------- D9：按住空白处仍然能转视角 ------------------- */
      await step('D9', '3D：按住空白处仍然能转视角', async () => {
        // 找一个**空的**格子（棋子身上按是拖棋子，不是转视角）
        const fen = opp.latestRoom()?.fen ?? '';
        const empty = ['d5', 'd4', 'e4', 'c4', 'e3', 'd3', 'c3', 'f4'].find(
          (sq) => pieceAt(fen, sq) === null,
        );
        if (!empty) throw new Error('找不到一个空格子来测「按住空白处转视角」');
        const camBefore = await camState();
        const p = await project3D(empty);
        // 往右拖一段（不松手时读机位）
        await mouseDown(p.x, p.y);
        await mouseDragTo(p, { x: p.x + 90, y: p.y }, 8);
        const camDuring = await camState();
        await mouseUp(p.x + 90, p.y);
        await sleep(700);
        const dAz =
          camBefore.azimuth !== null && camDuring.azimuth !== null
            ? Math.abs(camDuring.azimuth - camBefore.azimuth)
            : null;
        const ok = dAz !== null && dAz > 0.02;
        await shot('d9-3d-orbit');
        verdict(
          ok,
          'D9 3D：按住空白处仍然能转视角',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜按住的空格=${empty}｜` +
            `方位角变化=${dAz === null ? '读不到' : dAz.toFixed(5)}（阈值 0.02 弧度）`,
        );
      });

      /* ---------------- D10：3D 点选走子仍然可用（回归） --------------- */
      await step('D10', '3D：点选走子仍然可用（拖拽没把老交互吃掉）', async () => {
        const plan = PAWN_PLANS[browserSide];
        await ensureBrowserTurn(plan.d5.from, plan.d5.to);
        const before = opp.latestRoom()?.fen ?? '';
        /*
         * 点棋子要按**棋子本体的高度**投影（0.27）——
         * 按棋面投影射线会擦着棋子的细杆掠过（见 PLAN Z.6），就打不中它了。
         */
        const a = await project3D(plan.d5.from, PIECE_BODY_Y);
        const b = await project3D(plan.d5.to, PIECE_BODY_Y);
        // 第一下：点起点（= 选中），**不该走子**
        await mouseDown(a.x, a.y);
        await mouseUp(a.x, a.y);
        await sleep(350);
        const afterFirst = opp.latestRoom()?.fen ?? '';
        const noAccidentalMove = afterFirst === before;
        // 第二下：点终点 → 走子
        await mouseDown(b.x, b.y);
        await mouseUp(b.x, b.y);
        await waitFor(() => (opp.latestRoom()?.fen ?? '') !== before, '点选走子生效', 10000);
        const after = opp.latestRoom()?.fen ?? '';
        const onTo = pieceAt(after, plan.d5.to);
        const onFrom = pieceAt(after, plan.d5.from);
        const moves = await outboundMoves();
        const sent = moves.some((m) => m.from === plan.d5.from && m.to === plan.d5.to);
        /*
         * 判据要同时看三件事：
         *   ① 点一下起点**没有误走子**（拖拽的 pointerup 不该顺手把棋下了）；
         *   ② 浏览器**真的发出了 from→to**（走的是点按那条路，不是别的路径）；
         *   ③ 服务端局面确实对上了。
         */
        const ok =
          noAccidentalMove &&
          sent &&
          onTo?.type === 'p' &&
          onTo?.color === browserSide &&
          onFrom === null;
        await shot('d10-3d-click-move');
        verdict(
          ok,
          'D10 3D：点选走子仍然可用（拖拽没把老交互吃掉）',
          `浏览器执${browserSide === 'w' ? '白' : '黑'}｜` +
            `点一下 ${plan.d5.from} 没误走子=${noAccidentalMove}｜` +
            `浏览器发出 ${plan.d5.from}→${plan.d5.to}=${sent}｜` +
            `服务端 ${plan.d5.to}=${JSON.stringify(onTo)}、${plan.d5.from}=${JSON.stringify(onFrom)}`,
        );
      });
    }

    opp.close();
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
