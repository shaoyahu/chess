/**
 * 「私信」门禁 —— `scripts/verify-dm.ts`
 *
 * 为什么单独一个脚本（而不是塞进 verify-ui-style.ts）：
 *   私信是一条**独立的机制**（点对点消息 + 在线名单 + 右键菜单），
 *   跟「棋盘长得好看」「走子箭头看得见」都不是一回事。
 *   混在一起会让任何一个脚本的失败都很难定位。
 *
 * 门禁清单（14 条，D1~D14）：
 *   D1  大厅顶栏「在线 N」点开就是**真人名单**：
 *       数字 = 名单人数、名单里有对面那个真人、自己的那行标着「你」。
 *   D2  在名单里**右键**某人 → 弹出菜单 → 点「发送消息」→
 *       私信面板打开，且**当前对话对象就是那个人**（不是上一个、不是空的）。
 *   D3  从面板里发出的私信，**对方真的收到**（服务端对端报文），
 *       **发送方自己也留一份**（不然「我发了没有」全靠猜）。
 *   D4  对方发来私信 → 顶栏**未读角标** + 一条提示 →
 *       打开面板角标清零、**历史还在**（私信是有记录的，不是一次性弹窗）。
 *   D5  顶栏图标按钮（设置齿轮、私信）**点击区够大**（用户说「设置图标太小」）。
 *   D6  收到私信弹的 **toast 不许盖住顶栏按钮**（角标被盖住 = 「说有未读」却看不见；
 *       那几秒里「私信 / 设置」还点不动 —— toast 的 z-index 在顶栏之上）。
 *   D7  **对局页**也有私信入口（收到私信的人可能正在棋盘上）。
 *   D8  **对局页**也能查看在线玩家（顶栏「在线 N」点开同样是真人名单）。
 *   D9  在名单里**左键**某人 → 私信面板落在那个人身上（且**不弹**右键菜单）。
 *   D10 顶栏私聊入口是**聊天气泡**图标（不是信封）—— 大厅与对局页都是。
 *   D11 大厅页**没有大段解释性文字**（登录说明 / 玩法底注 / 模式提示 / 名单里的提示句）。
 *   D12 **在线名单浮层点别处就收起** —— 它的 z-index 高过私信抽屉，
 *       不收起就会盖在聊天窗上（用户报的现象：「点了私聊，名单还挡着聊天窗」）。
 *   D13 **私信有最小发送间隔** —— 连点快捷短语只发得出一条（对面不会被糊成一列提示），
 *       冷却过去还能再发（是**延迟**，不是把功能弄没了）；服务端也拒收第二条。
 *   D14 **消息通知限位右上角** —— 同一个人的连发合并成一条提示，
 *       好几个人各发一条时可见提示**最多 4 条**，且整列待在右上角。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（D1…D11）——
 * 变异脚本靠「❌ 行里含门禁编号」判定「这一条被抓到了」，
 * 失败信息不带编号就会出现假绿。
 *
 * 用法：
 *   npx tsx scripts/verify-dm.ts [--url=http://127.0.0.1:3000] [--group=list,message,topbar]
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
import { DM_GROUPS } from './lib/dm-groups';

/**
 * 地址解析：**位置参数不能靠「位置」猜**（`--group=list` 会被当成地址）。
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

/** 本次要跑哪几组门禁。`null` = 全跑（默认）；`['list']` = 只跑名单组。 */
const selectedGroups = parseGroupFilter(DM_GROUPS, process.argv.slice(2));
/** 「这条门禁本次要不要跑」 */
const gateFilter = makeGateFilter(DM_GROUPS, selectedGroups);

const OUT_DIR = join(process.cwd(), 'artifacts', 'dm');
const VIEW_W = 1600;
const VIEW_H = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 浏览器那边的用户名 */
const BROWSER_NAME = '私信验收员';
/** 对面那个人的用户名（用 ws 客户端当） */
const PEER_NAME = '对手乙';

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
/* 极简的游戏协议 ws 客户端 —— 门禁用来**当对面的那个人**                */
/* ------------------------------------------------------------------ */
interface DirectMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  text: string;
  at: number;
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

  /**
   * 记一个**水位线**（此刻已收到几条消息）。
   *
   * 用来数「这一轮**新**来了几条」——
   * `waitFor` 是从队头扫的，早先那条也会被扫到，数不出「新增」。
   */
  mark(): number {
    return this.msgs.length;
  }

  /** 从水位线之后起，符合条件的有几条 */
  countSince(mark: number, pred: (m: Record<string, any>) => boolean): number {
    return this.msgs.slice(mark).filter(pred).length;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
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
    selectedGroups === null
      ? '本次门禁组：全跑'
      : `本次门禁组：${selectedGroups.join('、')}`,
  );
  console.log('');

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-dm-'));
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
     * 用来拿浏览器的 **userId** —— 私信是点对点的，
     * 对面那个 ws 客户端要往回发消息，得知道发给谁。
     * （不能靠「D3 那条消息里的 from」—— 分组跑时 D3 可能被跳过。）
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
                let uid = '';
                try {
                  const j = JSON.parse(s);
                  t = j.t || '?';
                  uid = j.userId || '';
                } catch { /* 不是 JSON 就原样存 */ }
                window.__wsLog.push({ dir, t, uid, at: Date.now() });
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

    const evaluate = async <T,>(expression: string): Promise<T> => {
      const res = await cdp!.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
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

    /** 等一个表达式变成「真值」，返回它的值 */
    const waitForValue = async <T,>(expression: string, label: string, timeoutMs = 20000): Promise<T> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = await evaluate<T>(expression);
        if (v !== undefined && v !== null && v !== false && v !== '') return v;
        await sleep(150);
      }
      const diag = await evaluate<string>(
        `location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' / ')`,
      );
      throw new Error(`等待「${label}」超时。页面状态：${diag}`);
    };

    const waitForExpr = async (expression: string, label: string, timeoutMs = 20000): Promise<void> => {
      await waitForValue<boolean>(`!!(${expression})`, label, timeoutMs);
    };

    /** 切视口（窄屏那条判据要用） */
    const setViewport = async (width: number, height = 900): Promise<void> => {
      await cdp!.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(350);
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

    /** 点一个选择器命中的元素 */
    const clickSelector = async (selector: string, label: string): Promise<void> => {
      const done = await evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!done) throw new Error(`点不到「${label}」（${selector}）`);
    };

    /**
     * 往 React 受控输入框里写值。
     *
     * 必须走 **原生 setter + input 事件**：
     * 直接 `el.value = x` 不会触发 React 的 onChange（React 记住了旧值）。
     */
    const setInputValue = async (selector: string, value: string): Promise<void> => {
      const ok = await evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error(`找不到输入框：${selector}`);
    };

    /**
     * 在 (x, y) 处**右键**。
     *
     * 先走 CDP 的真实右键（mousePressed/mouseReleased，button=right）；
     * 万一这个环境里 CDP 右键没触发 contextmenu，再退回派发一个
     * 同名事件 —— 两条路都经过 React 的 onContextMenu，测的是同一条链。
     */
    const rightClickAt = async (x: number, y: number): Promise<string> => {
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'right',
        buttons: 2,
        clickCount: 1,
      });
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'right',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(300);
      const shown = await evaluate<boolean>(`!!document.querySelector('.ctx-menu')`);
      if (shown) return 'cdp';
      await evaluate(`(() => {
        const target = document.elementFromPoint(${x}, ${y});
        if (!target) return false;
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},
        }));
        return true;
      })()`);
      await sleep(300);
      const shown2 = await evaluate<boolean>(`!!document.querySelector('.ctx-menu')`);
      return shown2 ? 'synthetic' : 'none';
    };

    /**
     * 在 (x, y) 处**左键**点一下（真实的 mousePressed/mouseReleased）。
     *
     * 走 CDP 而不是 `el.click()`：`el.click()` 派发的是**合成**事件，
     * React 能收到，但它绕过了真实指针链路（hover、命中测试）。
     * 「左键点某人」是这一轮新增的交互，必须用真实点击来测。
     */
    const leftClickAt = async (x: number, y: number): Promise<void> => {
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(350);
    };

    /** 在线名单里某人那一行的中心坐标 */
    const onlineRowRect = async (peerName: string): Promise<{ x: number; y: number } | null> =>
      evaluate<{ x: number; y: number } | null>(`
        (() => {
          const row = [...document.querySelectorAll('.online-row')]
            .find((el) => (el.querySelector('.online-name')?.textContent || '').trim() === ${JSON.stringify(peerName)});
          if (!row) return null;
          const r = row.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `);

    /**
     * **左键**点在线名单里的某人 → 私信面板落在他身上。
     *
     * 返回两件事：
     *  - `menuShown`：左键**不该**弹右键菜单（弹了就是两条路混了）；
     *  - `title`：私信面板的对话对象是谁。
     */
    const leftClickPeer = async (
      peerName: string,
    ): Promise<{ menuShown: boolean; title: string }> => {
      const listOpen = await evaluate<boolean>(`!!document.querySelector('.online-panel')`);
      if (!listOpen) {
        await clickSelector('button.status-dot', '顶栏的「在线 N」');
        await waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单浮层');
        await sleep(300);
      }
      const rect = await onlineRowRect(peerName);
      if (!rect) throw new Error(`在线名单里找不到「${peerName}」这一行`);
      await leftClickAt(rect.x, rect.y);
      const menuShown = await evaluate<boolean>(`!!document.querySelector('.ctx-menu')`);
      const title = await evaluate<string>(
        `(document.querySelector('.dm-panel .dm-title')?.textContent || '').trim()`,
      );
      return { menuShown, title };
    };

    /** 某个元素的中心坐标（用来做**真实点击**） */
    const elementRect = async (
      selector: string,
    ): Promise<{ x: number; y: number } | null> =>
      evaluate<{ x: number; y: number } | null>(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `);

    /**
     * **回到大厅页**。
     *
     * 有些门禁会把浏览器带到对局页去（对局页也有私信面板），
     * 后面的门禁要的是大厅的状态 —— 所以自己把自己摆好，
     * 不依赖「上一条门禁跑过什么」。
     */
    const ensureLobby = async (): Promise<void> => {
      const path = await evaluate<string>(`location.pathname`);
      if (path === '/') return;
      await cdp!.send('Page.navigate', { url: APP_URL });
      await waitForExpr(`!!document.querySelector('button[aria-label="私信"]')`, '大厅的私信按钮', 15000);
      await sleep(600);
    };

    /**
     * 打开私信面板，并**落在「对面那个人」的对话上**（能发消息的那一态）。
     *
     * 面板有两个态：会话列表 / 某个对话。快捷短语只在第二个态里，
     * 所以这里要确保落对了人 —— 点进谁，不能靠上一条门禁留下什么。
     *
     * 会话列表里**可能没有**那个人：D11 会清掉身份重新登录，
     * 新身份底下没有历史（历史是按 userId 存的）。
     * 那就换一条路 —— 从**在线名单**点他进去（这条路不依赖历史）。
     */
    const openDmWithPeer = async (): Promise<void> => {
      const panelOpen = await evaluate<boolean>(`!!document.querySelector('.dm-panel')`);
      if (!panelOpen) {
        await clickSelector('button[aria-label="私信"]', '顶栏「私信」按钮');
        await waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板');
        await sleep(400);
      }
      const title = await evaluate<string>(
        `(document.querySelector('.dm-panel .dm-title')?.textContent || '').trim()`,
      );
      if (title !== PEER_NAME) {
        const hasBack = await evaluate<boolean>(`!!document.querySelector('.dm-back')`);
        if (hasBack) {
          await clickSelector('.dm-back', '私信面板的「会话」按钮');
          await waitForExpr(`!!document.querySelector('.dm-list')`, '会话列表');
          await sleep(300);
        }
        const inList = await evaluate<boolean>(
          `[...document.querySelectorAll('.dm-conv-name')].some((e) => (e.textContent || '').trim() === ${JSON.stringify(PEER_NAME)})`,
        );
        if (inList) {
          await clickText('.dm-conv', PEER_NAME, `会话列表里的「${PEER_NAME}」`);
        } else {
          // 历史里没有他 → 从在线名单点进去
          await ensureOnlinePanelOpen();
          const rect = await onlineRowRect(PEER_NAME);
          if (!rect) throw new Error(`在线名单里找不到「${PEER_NAME}」这一行`);
          await leftClickAt(rect.x, rect.y);
        }
        await waitForExpr(`!!document.querySelector('.dm-quick')`, '某个对话的快捷短语');
        await sleep(300);
      }
      await waitForExpr(`!!document.querySelector('.dm-quick .rail-quick-btn')`, '快捷短语按钮');
    };

    /**
     * **确保在线名单浮层是开着的**。
     *
     * 入口那颗按钮是**开关**：浮层已经开着时再点一下是「关」。
     * 所以「打开浮层」不能无脑点按钮 —— 得先看它开没开。
     */
    const ensureOnlinePanelOpen = async (): Promise<void> => {
      const open = await evaluate<boolean>(`!!document.querySelector('.online-panel')`);
      if (open) return;
      await clickSelector('button.status-dot', '顶栏的「在线 N」');
      await waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单浮层');
      await sleep(250);
    };

    /**
     * 浏览器的 userId（从注入的 ws 日志里捞 session 那条）。
     *
     * 取**最后一条**：D11 会清掉身份重新登录，userId 会换 ——
     * 取第一条拿到的是**旧身份**的 id，发过去没人收（消息凭空消失）。
     */
    const browserUserId = async (): Promise<string> =>
      evaluate<string>(
        `(() => {
          const list = (window.__wsLog || []).filter((l) => l.t === 'session' && l.uid);
          const e = list[list.length - 1];
          return e ? e.uid : '';
        })()`,
      );

    /** 造一个新的「人」（ws 客户端），用来当不同的发送方 */
    const newPerson = async (
      name: string,
    ): Promise<{ name: string; client: GameClient; userId: string }> => {
      const c = new GameClient(WS_URL);
      extraPeople.push(c);
      await c.ready();
      c.send({ t: 'hello', name });
      const s = await c.waitFor<Record<string, any>>(
        (m) => (m.t === 'session' ? m : null),
        `「${name}」的 session`,
        8000,
      );
      return { name, client: c, userId: String(s.userId ?? '') };
    };

    /* ================================================================ */
    /* 准备：对面那个人（ws 客户端）+ 一个**没登录**的裸连接               */
    /* ================================================================ */
    /*
     * 裸连接的作用：它是「连上了但还没发 hello」的连接。
     * 服务端的在线名单**只算已登录的连接**，所以裸连接**不该**出现在名单里，
     * 也不该算进「在线 N」那个数字。
     *
     * 有了它，D1 才能验「数字 = 名单人数」这件事 ——
     * 否则名单里只有两个都登录过的人，两种口径碰巧一样，门禁就成了摆设。
     */
    const peer = new GameClient(WS_URL);
    const bare = new GameClient(WS_URL);
    /** 门禁期间临时造出来的「人」（D14 要好几个不同的发送方） */
    const extraPeople: GameClient[] = [];
    try {
      await peer.ready();
      peer.send({ t: 'hello', name: PEER_NAME });
      await peer.waitFor((m) => (m.t === 'session' ? m : null), '对面的 session');
      await bare.ready();
      console.log(`对面的人已上线：${PEER_NAME}（userId=${peer.session?.userId}）`);

      /* ================================================================ */
      /* 准备：浏览器登录进大厅                                           */
      /* ================================================================ */
      await cdp.send('Page.navigate', { url: APP_URL });
      await waitForExpr(`document.readyState === 'complete'`, '首页加载');
      await sleep(600);
      await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
      await setInputValue('input.input', BROWSER_NAME);
      await sleep(200);
      // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点
      await waitForExpr(`!!document.querySelector('.status-dot.online')`, '与服务器连上');
      await clickText('button', '进入大厅', '进入大厅');
      await waitForExpr(
        `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
        '大厅页面',
        15000,
      );
      /*
       * 等「在线 N」这个数字**出现**（至少 1）。
       *
       * 不能等「正好是 2」：那等于把被测的数字写进了**等待条件** ——
       * 一旦这条数字算错了，等待就会超时，门禁报的是「脚本出错」而不是
       * 「D1 不达标」，变异脚本也就抓不到它了。
       */
      await waitForExpr(
        `/在线\\s*[1-9]/.test(document.querySelector('.status-dot')?.textContent || '')`,
        '在线人数',
        15000,
      );
      console.log('浏览器已登录进大厅。');

      /**
       * 让对面发一个房间，返回房间码。
       *
       * 复用同一间房：D7 / D8 / D10 都要「待在一个对局页里」，
       * 各开一间会让浏览器反复换房（换房要走离开 + 加入，白折腾）。
       */
      let roomCode = '';
      const ensureRoom = async (): Promise<string> => {
        if (roomCode) return roomCode;
        peer.send({ t: 'room.create', timeControl: '30+0' });
        const roomMsg = await peer.waitFor<{ state?: { code?: string } }>(
          (m) => (m.t === 'room' ? m : null),
          '对面的房间快照',
          10000,
        );
        roomCode = roomMsg.state?.code ?? '';
        if (!roomCode) throw new Error('对面的房间快照里没有房间码');
        return roomCode;
      };

      /**
       * **对面最近一次发私信的时间**（服务端按发送方限频，1.2 秒一条）。
       */
      let peerLastDmAt = 0;

      /**
       * 让对面发一条私信 —— **先等过限频窗口**再发。
       *
       * 服务端现在按发送方限频（`DM_SEND_MIN_INTERVAL_MS`）。
       * 门禁要是连着发两条，第二条会被**服务端拒收** ——
       * 那不是产品坏了，是门禁没遵守新规矩。
       *
       * 用**不同的人**发就不用等（各人有各人的桶）——
       * D6 量 toast 位置时就这么干：每次量都用新的人，
       * 这样每次拿到的都是**刚弹出来的那条**，
       * 而不是上一条还没消失的旧提示（那会量错）。
       */
      const peerSendDm = async (to: string, text: string): Promise<void> => {
        const wait = peerLastDmAt + 1400 - Date.now();
        if (wait > 0) await sleep(wait);
        peer.send({ t: 'dm.send', to, text });
        peerLastDmAt = Date.now();
      };

      /* ================================================================ */
      /* D1：顶栏「在线 N」点开就是真人名单                                */
      /* ================================================================ */
      if (gateFilter('D1')) {
        await step('D1', '大厅「在线 N」点开是真人名单（数字=名单人数、含对面那人、自己的行标「你」）', async () => {
          await clickSelector('button.status-dot', '顶栏的「在线 N」');
          await waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单浮层');
          await sleep(400);
          const r = await evaluate<{
            topbarText: string;
            headText: string;
            rows: Array<{ name: string; isYou: boolean }>;
          }>(`
            (() => {
              const dot = document.querySelector('button.status-dot');
              const rows = [...document.querySelectorAll('.online-row')].map((el) => ({
                name: (el.querySelector('.online-name')?.textContent || '').trim(),
                isYou: !!el.querySelector('.online-you'),
              }));
              return {
                topbarText: (dot?.textContent || '').trim(),
                headText: (document.querySelector('.online-head')?.textContent || '').trim(),
                rows,
              };
            })()
          `);
          await shot('d1-online-panel');

          const m = r.topbarText.match(/在线\s*(\d+)/);
          const topbarCount = m ? Number(m[1]) : -1;
          const names = r.rows.map((x) => x.name);
          const hasPeer = names.includes(PEER_NAME);
          const youRows = r.rows.filter((x) => x.isYou);
          const youRow = r.rows.find((x) => x.name === BROWSER_NAME);
          const youMarked = !!youRow?.isYou;

          /*
           * 数字必须等于名单行数。
           *
           * 注意**不能**写死「在线 2」：这台机器上可能还开着别的客户端
           * （真人也在用），数字跟着变 —— 写死会把「环境不干净」误判成「功能坏了」。
           * 真正要守的是「数字和名单说的是同一件事」。
           */
          if (topbarCount !== r.rows.length) {
            throw new Error(
              `D1 顶栏写「在线 ${topbarCount}」但名单只有 ${r.rows.length} 行` +
                `（名单：${names.join('、') || '（空）'}）—— 数字和名单对不上就是骗人`,
            );
          }
          if (!hasPeer) {
            throw new Error(`D1 名单里没有「${PEER_NAME}」（名单：${names.join('、')}）`);
          }
          if (!youMarked) {
            throw new Error(`D1 自己那一行没标「你」（自己的行：${youRow ? '有' : '没有'}）`);
          }
          if (youRows.length !== 1) {
            throw new Error(`D1 有 ${youRows.length} 行标着「你」（应该只有 1 行）`);
          }
          verdict(
            true,
            'D1 大厅「在线 N」点开是真人名单（数字=名单人数、含对面那人、自己的行标「你」）',
            `顶栏「${r.topbarText}」｜名单 ${r.rows.length} 行：${names.join('、')}｜自己标了「你」=${youMarked}`,
          );
        });
      }

      /* ================================================================ */
      /* D2：右键某人 → 菜单 → 私信面板落在那个人身上                      */
      /* ================================================================ */
      if (gateFilter('D2')) {
        await step('D2', '名单里右键某人 → 「发送消息」→ 私信面板落在那个人身上', async () => {
          // 名单可能已经关掉了（点一次顶栏按钮开/关）
          const open = await evaluate<boolean>(`!!document.querySelector('.online-panel')`);
          if (!open) {
            await clickSelector('button.status-dot', '顶栏的「在线 N」');
            await waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单浮层');
            await sleep(300);
          }
          const rect = await evaluate<{ x: number; y: number } | null>(`
            (() => {
              const row = [...document.querySelectorAll('.online-row')]
                .find((el) => (el.querySelector('.online-name')?.textContent || '').trim() === ${JSON.stringify(PEER_NAME)});
              if (!row) return null;
              const r = row.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()
          `);
          if (!rect) throw new Error('D2 名单里找不到「' + PEER_NAME + '」这一行');

          const how = await rightClickAt(rect.x, rect.y);
          const menuShown = await evaluate<boolean>(`!!document.querySelector('.ctx-menu')`);
          if (!menuShown) {
            throw new Error(`D2 右键后没弹出菜单（右键方式：${how}）`);
          }
          const itemText = await evaluate<string>(
            `(document.querySelector('.ctx-item')?.textContent || '').trim()`,
          );
          if (!itemText.includes('发送消息')) {
            throw new Error(`D2 菜单里没有「发送消息」这一项（菜单内容：「${itemText}」）`);
          }
          await shot('d2-ctx-menu');

          await clickSelector('.ctx-item', '菜单里的「发送消息」');
          await waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板');
          await sleep(400);
          const title = await evaluate<string>(
            `(document.querySelector('.dm-panel .dm-title')?.textContent || '').trim()`,
          );
          /*
           * **私信不能自己打字**（用户拍板）：面板底部只有快捷短语。
           *
           * 所以这里反过来验 —— 面板里**不该有**输入框，
           * 而**该有**快捷短语按钮。
           * （旧版本这里断言「有输入框」，那是「私信能自己打字」的旧规则，
           *  产品改成只发快捷短语之后这条判据就一直是错的。）
           */
          const hasInput = await evaluate<boolean>(
            `!!document.querySelector('.dm-panel input[aria-label="私信内容"]')`,
          );
          const quickTexts = await evaluate<string[]>(
            `[...document.querySelectorAll('.dm-panel .dm-quick .rail-quick-btn')]
               .map((b) => (b.textContent || '').trim())`,
          );
          await shot('d2-dm-panel');
          if (title !== PEER_NAME) {
            throw new Error(`D2 私信面板的对话对象是「${title}」，应该是「${PEER_NAME}」`);
          }
          if (hasInput) {
            throw new Error('D2 私信面板里有输入框 —— 私信不能自己打字（只能发快捷短语）');
          }
          if (quickTexts.length === 0) {
            throw new Error('D2 私信面板底部没有快捷短语按钮');
          }
          verdict(
            true,
            'D2 名单里右键某人 → 「发送消息」→ 私信面板落在那个人身上',
            `右键方式=${how}｜菜单项「${itemText}」｜面板标题「${title}」｜` +
              `有输入框=${hasInput}｜快捷短语 ${quickTexts.length} 颗`,
          );
        });
      }

      /* ================================================================ */
      /* D9：名单里**左键**某人 → 私信面板落在那个人身上                     */
      /* ================================================================ */
      if (gateFilter('D9')) {
        await step('D9', '名单里左键某人 → 私信面板落在那个人身上（且不弹右键菜单）', async () => {
          /*
           * 先把面板关掉 —— 它必须由**这次左键**打开，
           * 否则「面板开着」会被误当成「左键生效了」。
           */
          const panelOpen = await evaluate<boolean>(`!!document.querySelector('.dm-panel')`);
          if (panelOpen) {
            await clickSelector('.dm-close', '私信面板的关闭按钮');
            await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
            await sleep(300);
          }
          const { menuShown, title } = await leftClickPeer(PEER_NAME);
          await shot('d9-left-click');
          if (menuShown) {
            throw new Error('D9 左键却弹出了右键菜单 —— 左键不该走菜单那条路');
          }
          if (title !== PEER_NAME) {
            throw new Error(`D9 私信面板的对话对象是「${title}」，应该是「${PEER_NAME}」`);
          }
          verdict(
            true,
            'D9 名单里左键某人 → 私信面板落在那个人身上（且不弹右键菜单）',
            `左键后弹了右键菜单=${menuShown}｜面板标题「${title}」`,
          );
        });
      }

      /* ================================================================ */
      /* D3：发出去的私信，对方真的收到；发送方自己也留一份                */
      /* ================================================================ */
      if (gateFilter('D3')) {
        await step('D3', '面板里发出的私信对方真的收到，发送方自己也留一份', async () => {
          /*
           * 面板**必须落在某个人身上**才有快捷短语可点 ——
           * 只开着「会话列表」的话，底部没有短语，点了也发不出去。
           *
           * 所以这里自己把对话对象准备好（用左键点在线名单里的那个人），
           * 不依赖上一条门禁的状态 —— 否则单跑「消息」这一组时 D3 必假红。
           */
          const needPeer = await evaluate<boolean>(`
            (() => {
              const p = document.querySelector('.dm-panel');
              if (!p) return true;
              return !p.querySelector('.dm-quick');
            })()
          `);
          if (needPeer) {
            await leftClickPeer(PEER_NAME);
            await waitForExpr(`!!document.querySelector('.dm-panel .dm-quick')`, '私信面板的快捷短语', 8000);
          }
          /*
           * **私信不能自己打字**（用户拍板）：底部只有快捷短语按钮。
           * 所以这里**点一颗短语**发出去 —— 发出去的内容就是那颗短语的文字。
           */
          const text = await evaluate<string>(
            `(() => {
               const b = document.querySelector('.dm-panel .dm-quick .rail-quick-btn');
               return b ? (b.textContent || '').trim() : '';
             })()`,
          );
          if (!text) throw new Error('D3 私信面板底部没有快捷短语按钮');
          await clickSelector('.dm-panel .dm-quick .rail-quick-btn', '私信面板的快捷短语');

          // 对面（服务端对端）真的收到了吗
          const dm = await peer.waitFor<{ message: DirectMessage }>(
            (m) => (m.t === 'dm' ? (m as { message: DirectMessage }) : null),
            '对面的私信',
            10000,
          );
          const msg = dm.message;
          if (msg.text !== text) {
            throw new Error(`D3 对面收到的内容是「${msg.text}」，应该是「${text}」`);
          }
          if (msg.fromName !== BROWSER_NAME) {
            throw new Error(`D3 对面收到的发件人是「${msg.fromName}」，应该是「${BROWSER_NAME}」`);
          }
          if (msg.to !== peer.session?.userId) {
            throw new Error(`D3 对面收到的收件人 userId 是「${msg.to}」，不是自己`);
          }
          if (!msg.toName) {
            throw new Error('D3 私信没有带上收件人名字（toName）—— 发送方就不知道自己跟谁聊过');
          }

          // 发送方自己也留一份（**等到它出现**再断言，别读到还没渲染的空列表）
          const own = await waitForValue<{ count: number; texts: string[] }>(
            `(() => {
              const msgs = [...document.querySelectorAll('.dm-msg.me .dm-msg-text')].map((e) => (e.textContent || '').trim());
              if (!msgs.includes(${JSON.stringify(text)})) return null;
              return { count: msgs.length, texts: msgs };
            })()`,
            '发送方自己的那条私信',
            8000,
          );
          await shot('d3-sent');
          const mineHasText = own.texts.includes(text);
          if (!mineHasText) {
            throw new Error(`D3 发送方自己的面板里没有这条消息（面板里有：${own.texts.join('、') || '（空）'}）`);
          }
          verdict(
            true,
            'D3 面板里发出的私信对方真的收到，发送方自己也留一份',
            `对面收到「${msg.text}」（发件人 ${msg.fromName}，收件人名 ${msg.toName}）｜自己面板里也有=${mineHasText}`,
          );
        });
      }

      /* ================================================================ */
      /* D4：收到私信 → 角标 + 提示 → 打开后清零 → 历史还在                */
      /* ================================================================ */
      if (gateFilter('D4')) {
        await step('D4', '收到私信有未读角标和提示，打开面板角标清零、历史还在', async () => {
          // 先把面板关掉 —— 未读要在「没看着的时候」才成立
          const wasOpen = await evaluate<boolean>(`!!document.querySelector('.dm-panel')`);
          if (wasOpen) {
            await clickSelector('.dm-close', '私信面板的关闭按钮');
            await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
            await sleep(300);
          }

          // 对面发来一条
          const browserUserId = await peer.waitFor<{ message: DirectMessage }>(
            (m) => (m.t === 'dm' ? (m as { message: DirectMessage }) : null),
            '之前那条私信（拿浏览器的 userId）',
            8000,
          );
          const to = browserUserId.message.from;
          /*
           * **私信只认白名单里的快捷短语**（服务端按 `DM_QUICK_CHATS` 校验）——
           * 自由文本会被服务端拒收，收信方压根收不到，角标和提示都不会出现。
           */
          const text = '马上到';
          await peerSendDm(to, text);

          // 角标 + 提示，一起等（toast 只活几秒，要当场抓）
          const got = await waitForValue<{ badge: string; toast: string }>(
            `(() => {
              const b = document.querySelector('.dm-btn .chat-badge');
              if (!b) return null;
              const toast = [...document.querySelectorAll('.toast-text')].map((e) => (e.textContent || '').trim()).join(' | ');
              return { badge: (b.textContent || '').trim(), toast };
            })()`,
            '顶栏未读角标',
            12000,
          );
          await shot('d4-unread-badge');
          if (got.badge !== '1') {
            throw new Error(`D4 未读角标写的是「${got.badge}」，应该是「1」`);
          }
          if (!got.toast.includes('给你发来一条消息')) {
            throw new Error(`D4 没有弹出「xx 给你发来一条消息」的提示（提示内容：「${got.toast}」）`);
          }

          // 打开面板 → 角标清零（**等角标真的消失**，别读到还没清的那一瞬）
          await clickSelector('button[aria-label="私信"]', '顶栏「私信」按钮');
          await waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板');
          const cleared = await waitForValue<{ badge: string }>(
            `(() => {
              const b = document.querySelector('.dm-btn .chat-badge');
              if (b) return null;
              return { badge: '' };
            })()`,
            '未读角标清零',
            8000,
          );
          if (cleared.badge !== '') {
            throw new Error(`D4 打开面板后未读角标还在（「${cleared.badge}」）`);
          }

          // 历史还在：回到会话列表，里面有对方，最后一条就是刚发来的
          //
          // 面板有两个态：会话列表 / 某个对话。
          // 上一步打开面板时可能直接落在「对话」态（之前选过那个人）——
          // 所以先点「会话」回到列表态，列表里才是「我跟谁聊过」。
          const hasBack = await evaluate<boolean>(`!!document.querySelector('.dm-back')`);
          if (hasBack) {
            await clickSelector('.dm-back', '私信面板的「会话」按钮');
            await waitForExpr(`!!document.querySelector('.dm-list')`, '会话列表');
            await sleep(300);
          }
          const conv = await waitForValue<{ names: string[]; lasts: string[] }>(
            `(() => {
              const items = [...document.querySelectorAll('.dm-conv')];
              if (items.length === 0) return null;
              return {
                names: items.map((e) => (e.querySelector('.dm-conv-name')?.textContent || '').trim()),
                lasts: items.map((e) => (e.querySelector('.dm-conv-last')?.textContent || '').trim()),
              };
            })()`,
            '私信会话列表',
            8000,
          );
          await shot('d4-conversations');
          const convIdx = conv.names.indexOf(PEER_NAME);
          if (convIdx < 0) {
            throw new Error(`D4 会话列表里没有「${PEER_NAME}」（有：${conv.names.join('、') || '（空）'}）`);
          }
          if (!conv.lasts[convIdx].includes(text)) {
            throw new Error(
              `D4 会话列表里「${PEER_NAME}」那条的最后一条是「${conv.lasts[convIdx]}」，不含刚发的「${text}」`,
            );
          }

          // 点进那个会话 → 刚收到的那条在
          await clickSelector('.dm-conv', '会话列表里的那一行');
          await waitForExpr(`!!document.querySelector('.dm-log')`, '某个对话');
          const thread = await waitForValue<string[]>(
            `(() => {
              const texts = [...document.querySelectorAll('.dm-msg-text')].map((e) => (e.textContent || '').trim());
              if (!texts.length) return null;
              return texts;
            })()`,
            '对话里的消息',
            8000,
          );
          if (!thread.includes(text)) {
            throw new Error(`D4 对话里没有刚收到的那条（对话里有：${thread.join('、')}）`);
          }
          verdict(
            true,
            'D4 收到私信有未读角标和提示，打开面板角标清零、历史还在',
            `角标=1｜提示「${got.toast}」｜打开后角标清零｜会话列表：${conv.names.join('、')}`,
          );
        });
      }

      /* ================================================================ */
      /* D5：顶栏图标按钮的点击区够大                                      */
      /* ================================================================ */
      if (gateFilter('D5')) {
        await step('D5', '顶栏图标按钮（设置齿轮、私信）点击区够大（≥36px）', async () => {
          const r = await evaluate<{
            gear: { w: number; h: number; icon: number };
            mail: { w: number; h: number; icon: number };
          }>(`
            (() => {
              const read = (sel) => {
                const b = document.querySelector(sel);
                if (!b) return { w: -1, h: -1, icon: -1 };
                const br = b.getBoundingClientRect();
                const svg = b.querySelector('svg');
                const sr = svg ? svg.getBoundingClientRect() : { width: -1, height: -1 };
                return {
                  w: Math.round(br.width),
                  h: Math.round(br.height),
                  icon: Math.round(Math.min(sr.width, sr.height)),
                };
              };
              return {
                gear: read('button[aria-label="设置"]'),
                mail: read('button[aria-label="私信"]'),
              };
            })()
          `);
          await shot('d5-topbar');
          if (r.gear.w < 36 || r.gear.h < 36) {
            throw new Error(
              `D5 设置按钮只有 ${r.gear.w}×${r.gear.h}px（要 ≥36×36）—— 用户说过「设置图标太小」`,
            );
          }
          if (r.gear.icon < 18) {
            throw new Error(`D5 设置图标只有 ${r.gear.icon}px（要 ≥18px）`);
          }
          if (r.mail.w < 36 || r.mail.h < 36) {
            throw new Error(`D5 私信按钮只有 ${r.mail.w}×${r.mail.h}px（要 ≥36×36）`);
          }
          if (r.mail.icon < 18) {
            throw new Error(`D5 私信图标只有 ${r.mail.icon}px（要 ≥18px）`);
          }
          verdict(
            true,
            'D5 顶栏图标按钮（设置齿轮、私信）点击区够大（≥36px）',
            `设置 ${r.gear.w}×${r.gear.h}px / 图标 ${r.gear.icon}px｜私信 ${r.mail.w}×${r.mail.h}px / 图标 ${r.mail.icon}px`,
          );
        });
      }

      /* ================================================================ */
      /* D6：收到私信弹的 toast 不许盖住顶栏按钮                          */
      /* ================================================================ */
      if (gateFilter('D6')) {
        await step('D6', '收到私信弹的 toast 不盖住顶栏的「私信 / 设置」按钮', async () => {
          // 面板开着的话，顶栏按钮本来就被抽屉挡着 —— 先关掉，量的是「toast 挡不挡」
          const panelOpen = await evaluate<boolean>(`!!document.querySelector('.dm-panel')`);
          if (panelOpen) {
            await clickSelector('.dm-close', '私信面板的关闭按钮');
            await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
            await sleep(300);
          }
          const myId = await waitForValue<string>(
            `(() => {
              const e = (window.__wsLog || []).find((l) => l.t === 'session' && l.uid);
              return e ? e.uid : '';
            })()`,
            '浏览器的 userId',
            10000,
          );

          const measure = async (label: string): Promise<{
            toast: { l: number; t: number; r: number; b: number } | null;
            mail: { l: number; t: number; r: number; b: number } | null;
            gear: { l: number; t: number; r: number; b: number } | null;
            hitMail: boolean;
            hitGear: boolean;
          }> => {
            // 私信只认白名单里的快捷短语（服务端校验），自由文本会被拒收 → 压根没有 toast
            /*
             * 用**一个新人**来发（每次量都换人）：
             *   - 各人有各人的限频桶 —— 不用等，量两次不打架；
             *   - 每次拿到的都是**刚弹出来的那条**，
             *     而不是上一条还没消失的旧提示（量旧提示 = 量错）。
             */
            const from = await newPerson(`量提示的人${label === '宽屏' ? '甲' : '乙'}`);
            from.client.send({ t: 'dm.send', to: myId, text: label === '宽屏' ? '来一盘？' : '缺个对手' });
            return waitForValue(
              `(() => {
                const box = (el) => {
                  if (!el) return null;
                  const b = el.getBoundingClientRect();
                  return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
                };
                /*
                 * 取**最新**那一条提示（ToastHost 把新的排在最上面）。
                 * 取第一条（旧的那条）会量到上一轮留下来的提示 ——
                 * 那不是这一轮弹的，量它等于量了个寂寞。
                 */
                const all = [...document.querySelectorAll('.toast')];
                const t = box(all[0]);
                if (!t) return null;
                const m = box(document.querySelector('button[aria-label="私信"]'));
                const g = box(document.querySelector('button[aria-label="设置"]'));
                const hit = (a, b) => !!(a && b && !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b));
                return { toast: t, mail: m, gear: g, hitMail: hit(t, m), hitGear: hit(t, g) };
              })()`,
              `toast 出现（${label}）`,
              10000,
            );
          };

          const wide = await measure('宽屏');
          await setViewport(430, 932);
          await sleep(400);
          const narrow = await measure('窄屏 430px');
          await shot('d7-toast-vs-topbar');
          await setViewport(VIEW_W, VIEW_H);

          /*
           * 收尾：把这两条测试消息「看过」——
           * 否则未读数被留着，下一条门禁（D7 验「刷新后未读角标 = 1」）就数不干净。
           */
          await clickSelector('button[aria-label="私信"]', '顶栏「私信」按钮');
          await waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板');
          await waitForValue<{ badge: string }>(
            `(() => {
              const b = document.querySelector('.dm-btn .chat-badge');
              if (b) return null;
              return { badge: '' };
            })()`,
            '未读角标清零',
            8000,
          );
          await clickSelector('.dm-close', '私信面板的关闭按钮');
          await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
          await sleep(300);

          const bad: string[] = [];
          if (wide.hitMail) bad.push(`宽屏 toast 盖住了「私信」按钮（toast=${JSON.stringify(wide.toast)}）`);
          if (wide.hitGear) bad.push(`宽屏 toast 盖住了「设置」按钮（toast=${JSON.stringify(wide.toast)}）`);
          if (narrow.hitMail) bad.push(`窄屏 toast 盖住了「私信」按钮（toast=${JSON.stringify(narrow.toast)}）`);
          if (narrow.hitGear) bad.push(`窄屏 toast 盖住了「设置」按钮（toast=${JSON.stringify(narrow.toast)}）`);
          if (bad.length > 0) {
            throw new Error(
              `D6 ${bad.join('；')}—— 角标被盖住就等于「说有未读」却看不见，` +
                `那几秒里按钮还点不动（toast 的 z-index 在顶栏之上）`,
            );
          }
          verdict(
            true,
            'D6 收到私信弹的 toast 不盖住顶栏的「私信 / 设置」按钮',
            `宽屏 toast=${JSON.stringify(wide.toast)}｜窄屏 toast=${JSON.stringify(narrow.toast)}｜都没压到按钮`,
          );
        });
      }

      /* ================================================================ */
      /* D7：对局页也有私信入口                                          */
      /* ================================================================ */
      if (gateFilter('D7')) {
        await step('D7', '对局页也有私信入口，刷新后历史和未读都还在', async () => {
          // 对面建个房，浏览器进去
          const code = await ensureRoom();

          // 浏览器的 userId（从 ws 报文里捞 —— 私信是点对点的，得知道发给谁）
          const myId = await waitForValue<string>(
            `(() => {
              const e = (window.__wsLog || []).find((l) => l.t === 'session' && l.uid);
              return e ? e.uid : '';
            })()`,
            '浏览器的 userId',
            10000,
          );

          /*
           * 先发一条**刷新之前**的消息。
           *
           * 页面跳到对局页是**整页跳转**（真的重新加载）——
           * 私信记录是存在浏览器本地的，刷新之后要还能翻出来，
           * 这才是「有历史、能接着聊」。
           */
          // 面板开着的话，来消息当场就被「看过了」，角标不会亮 —— 先关掉
          const panelOpen = await evaluate<boolean>(`!!document.querySelector('.dm-panel')`);
          if (panelOpen) {
            await clickSelector('.dm-close', '私信面板的关闭按钮');
            await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
            await sleep(300);
          }
          /*
           * **私信只认白名单里的快捷短语**（服务端按 `DM_QUICK_CHATS` 校验）——
           * 自由文本会被服务端拒收，收信方压根收不到，未读角标自然也不会亮。
           *
           * 选「下次一定」：白名单里**只有这条**没被别的门禁用过（D3 用「来一盘？」、
           * D4 用「马上到」、D6 用「来一盘？」/「缺个对手」），
           * 所以下面「最后一条含刷新前那条」这个断言仍然能唯一地认出就是它。
           */
          const oldText = '下次一定';
          await peerSendDm(myId, oldText);
          await waitForExpr(
            `!!document.querySelector('.dm-btn .chat-badge')`,
            '大厅里的未读角标',
            12000,
          );

          await cdp!.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
          await waitForExpr(
            `location.pathname.toUpperCase().includes('${code}')`,
            '跳转到对局页',
            20000,
          );
          await waitForExpr(`!!document.querySelector('button[aria-label="私信"]')`, '对局页的私信按钮', 15000);
          await sleep(600);

          // 刷新之后：未读角标还在（那条消息确实还没看）
          const badge = await waitForValue<string>(
            `(() => {
              const b = document.querySelector('button[aria-label="私信"] .chat-badge');
              return b ? (b.textContent || '').trim() : '';
            })()`,
            '对局页恢复出来的未读角标',
            10000,
          );
          if (badge !== '1') {
            throw new Error(`D7 刷新后对局页的未读角标是「${badge}」，应该是「1」`);
          }

          // 点开 → 历史还在（刷新前发的那条也在）
          await clickSelector('button[aria-label="私信"]', '对局页的「私信」按钮');
          await waitForExpr(`!!document.querySelector('.dm-panel')`, '对局页的私信面板');
          await sleep(400);
          const hasBack = await evaluate<boolean>(`!!document.querySelector('.dm-back')`);
          if (hasBack) {
            await clickSelector('.dm-back', '私信面板的「会话」按钮');
            await waitForExpr(`!!document.querySelector('.dm-list')`, '会话列表');
            await sleep(300);
          }
          const convNames = await evaluate<string[]>(
            `[...document.querySelectorAll('.dm-conv-name')].map((e) => (e.textContent || '').trim())`,
          );
          const convLasts = await evaluate<string[]>(
            `[...document.querySelectorAll('.dm-conv-last')].map((e) => (e.textContent || '').trim())`,
          );
          await shot('d6-room-dm');
          const idx = convNames.indexOf(PEER_NAME);
          if (idx < 0) {
            throw new Error(
              `D7 对局页的私信面板里没有「${PEER_NAME}」的会话（有：${convNames.join('、') || '（空）'}）`,
            );
          }
          if (!convLasts[idx].includes(oldText)) {
            throw new Error(
              `D7 「${PEER_NAME}」那条的最后一条是「${convLasts[idx]}」，不含刷新前发来的「${oldText}」` +
                `—— 刷新之后历史丢了`,
            );
          }
          verdict(
            true,
            'D7 对局页也有私信入口，刷新后历史和未读都还在',
            `房间 ${code}｜刷新后角标=${badge}｜会话：${convNames.join('、')}｜最后一条含刷新前那条=${convLasts[idx].includes(oldText)}`,
          );
        });
      }

      /* ================================================================ */
      /* D8：对局页也能查看在线玩家                                      */
      /* ================================================================ */
      if (gateFilter('D8')) {
        await step('D8', '对局页顶栏也能查看在线玩家（名单里就有对面那个人）', async () => {
          const code = await ensureRoom();
          await cdp!.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
          await waitForExpr(
            `location.pathname.toUpperCase().includes('${code}')`,
            '跳转到对局页',
            20000,
          );
          /*
           * 对局页的顶栏也得有那枚「在线 N」按钮 ——
           * 用户原话：「游戏里不能查看在线玩家，这个有点离谱了」。
           */
          await waitForExpr(`!!document.querySelector('button.status-dot')`, '对局页的「在线 N」按钮', 15000);
          await sleep(600);
          await clickSelector('button.status-dot', '对局页顶栏的「在线 N」');
          await waitForExpr(`!!document.querySelector('.online-panel')`, '对局页的在线名单浮层', 15000);
          /*
           * 等名单里真的出现对面那个人 ——
           * 大厅快照是**连上之后**才推过来的，起手那几帧名单是空的。
           */
          const r = await waitForValue<{
            topbarText: string;
            headText: string;
            rows: Array<{ name: string; isYou: boolean }>;
          }>(
            `(() => {
              const dot = document.querySelector('button.status-dot');
              const rows = [...document.querySelectorAll('.online-row')].map((el) => ({
                name: (el.querySelector('.online-name')?.textContent || '').trim(),
                isYou: !!el.querySelector('.online-you'),
              }));
              if (!rows.some((x) => x.name === ${JSON.stringify(PEER_NAME)})) return null;
              return {
                topbarText: (dot?.textContent || '').trim(),
                headText: (document.querySelector('.online-head')?.textContent || '').trim(),
                rows,
              };
            })()`,
            '对局页在线名单里的真人',
            15000,
          );
          await shot('d8-room-online-panel');
          const m = r.topbarText.match(/在线\s*(\d+)/);
          const topbarCount = m ? Number(m[1]) : -1;
          if (topbarCount !== r.rows.length) {
            throw new Error(
              `D8 对局页顶栏写「在线 ${topbarCount}」但名单只有 ${r.rows.length} 行` +
                `（名单：${r.rows.map((x) => x.name).join('、') || '（空）'}）`,
            );
          }
          verdict(
            true,
            'D8 对局页顶栏也能查看在线玩家（名单里就有对面那个人）',
            `房间 ${code}｜顶栏「${r.topbarText}」｜名单 ${r.rows.length} 行：${r.rows.map((x) => x.name).join('、')}`,
          );
        });
      }

      /* ================================================================ */
      /* D10：顶栏私聊入口是聊天气泡图标（不是信封）                        */
      /* ================================================================ */
      if (gateFilter('D10')) {
        await step('D10', '顶栏私聊入口是聊天气泡图标（不是信封），大厅与对局页都是', async () => {
          const readIcon = async (where: string): Promise<string> => {
            const cls = await evaluate<string>(
              `(document.querySelector('button[aria-label="私信"] svg')?.getAttribute('class') || '')`,
            );
            if (!cls.includes('lucide-message-circle')) {
              throw new Error(
                `D10 ${where}的私聊按钮不是聊天气泡图标（svg class="${cls}"）—— ` +
                  `信封读起来是「邮件」，气泡才是「人跟人说话」`,
              );
            }
            if (cls.includes('lucide-mail')) {
              throw new Error(`D10 ${where}的私聊按钮还是信封图标（svg class="${cls}"）`);
            }
            return cls;
          };

          // 大厅
          await cdp!.send('Page.navigate', { url: APP_URL });
          await waitForExpr(`!!document.querySelector('button[aria-label="私信"]')`, '大厅的私信按钮', 15000);
          const lobbyCls = await readIcon('大厅');

          // 对局页（同一个组件，两处都该是气泡）
          const code = await ensureRoom();
          await cdp!.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
          await waitForExpr(`!!document.querySelector('button[aria-label="私信"]')`, '对局页的私信按钮', 15000);
          const roomCls = await readIcon('对局页');
          await shot('d10-dm-icon');
          verdict(
            true,
            'D10 顶栏私聊入口是聊天气泡图标（不是信封），大厅与对局页都是',
            `大厅 svg class="${lobbyCls}"｜对局页 svg class="${roomCls}"`,
          );
        });
      }

      /* ================================================================ */
      /* D11：大厅页没有大段解释性文字                                    */
      /* ================================================================ */
      if (gateFilter('D11')) {
        await step('D11', '大厅页没有大段解释性文字（登录说明 / 玩法底注 / 模式提示都没了）', async () => {
          /*
           * ① 未登录时的那张登录卡片：不该再有一整段说明。
           *
           * 做法：把身份（sessionStorage）与记住的名字（localStorage）清掉再刷新 ——
           * 客户端没有凭证就不会自动登录，于是回到登录卡片。
           */
          await evaluate(`(() => {
            try { sessionStorage.clear(); localStorage.removeItem('lan-chess.name'); } catch { /* ignore */ }
            return true;
          })()`);
          await cdp!.send('Page.navigate', { url: APP_URL });
          await waitForExpr(`!!document.querySelector('input.input')`, '登录卡片', 15000);
          const loginParas = await evaluate<string[]>(
            `[...document.querySelectorAll('.card p')].map((p) => (p.textContent || '').trim()).filter(Boolean)`,
          );
          await shot('d11-login-card');
          if (loginParas.length > 0) {
            throw new Error(
              `D11 登录卡片里还有说明文字：${loginParas.join(' / ')} —— ` +
                `「取个名字」之后就该能进大厅，不用先读一段话`,
            );
          }

          // ② 重新登录（后面的判据都在登录态下）
          /*
           * 登录卡片是 **SSR 出来**的：React 水合完成前改它的值，
           * 水合时会被**重置回空**（受控组件的值由 state 说了算）。
           * 所以这里写完还要**确认值真的落下了**，没落下就再来一次 ——
           * 否则后面点「进入大厅」会带着空名字去，等于白等。
           */
          let typed = false;
          for (let i = 0; i < 5 && !typed; i += 1) {
            await sleep(400);
            await setInputValue('input.input', BROWSER_NAME);
            await sleep(250);
            typed = await evaluate<boolean>(
              `(document.querySelector('input.input')?.value || '') === ${JSON.stringify(BROWSER_NAME)}`,
            );
          }
          if (!typed) throw new Error('D11 用户名输入框写不进值（水合还没完成？）');
          // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点
          await waitForExpr(`!!document.querySelector('.status-dot.online')`, '与服务器连上');
          await clickText('button', '进入大厅', '进入大厅');
          await waitForExpr(
            `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
            '大厅页面',
            15000,
          );

          // ③ 大厅里没有「玩法说明」底注，也没有模式面板的提示句
          const blocks = await evaluate<{
            foot: boolean;
            hint: boolean;
            idle: boolean;
            paragraphs: string[];
          }>(`
            (() => ({
              foot: !!document.querySelector('.lobby-foot'),
              hint: !!document.querySelector('.panel-hint'),
              idle: !!document.querySelector('.mode-panel-idle'),
              paragraphs: [...document.querySelectorAll('.card p')].map((p) => (p.textContent || '').trim()).filter(Boolean),
            }))()
          `);
          await shot('d11-lobby');
          if (blocks.foot) {
            throw new Error('D11 大厅里又有「玩法说明」底注了（.lobby-foot）');
          }
          if (blocks.hint) {
            throw new Error('D11 开局方式面板里又有提示句了（.panel-hint）');
          }
          if (blocks.idle) {
            throw new Error('D11 大厅里又有那块闲置的说明面板了（.mode-panel-idle）');
          }
          if (blocks.paragraphs.length > 0) {
            throw new Error(`D11 大厅卡片里还有说明段落：${blocks.paragraphs.join(' / ')}`);
          }

          // ④ 四种开局方式的面板里也不许出现说明句
          for (const label of ['快速匹配', '人机对弈', '创建房间', '加入房间']) {
            await clickText('button', label, label);
            await sleep(250);
            const paras = await evaluate<string[]>(
              `[...document.querySelectorAll('.mode-panel p, .mode-panel .hint')].map((p) => (p.textContent || '').trim()).filter(Boolean)`,
            );
            if (paras.length > 0) {
              throw new Error(`D11 「${label}」面板里还有说明句：${paras.join(' / ')}`);
            }
            await clickText('button', '返回', '返回');
            await sleep(200);
          }

          // ⑤ 在线名单浮层里也不许有「右键某个人 → …」那句
          await clickSelector('button.status-dot', '顶栏的「在线 N」');
          await waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单浮层');
          const onlineText = await evaluate<string>(
            `(document.querySelector('.online-panel')?.innerText || '').trim()`,
          );
          await shot('d11-online-panel');
          if (onlineText.includes('右键')) {
            throw new Error(`D11 在线名单里还有「右键」那句说明：${onlineText}`);
          }
          verdict(
            true,
            'D11 大厅页没有大段解释性文字（登录说明 / 玩法底注 / 模式提示都没了）',
            `登录卡片无说明段落｜大厅无 .lobby-foot / .panel-hint｜四种面板无说明句｜在线名单无「右键」提示`,
          );
        });
      }

      /* ================================================================ */
      /* D12：在线名单浮层 —— 点别处就收起                                 */
      /* ================================================================ */
      if (gateFilter('D12')) {
        await step('D12', '在线名单浮层点别处就收起（不会盖在私信面板上）', async () => {
          await ensureLobby();

          /*
           * ① **用户报的那个场景**：开着名单 → 点顶栏「私信」→
           *    名单必须收起。
           *
           * 名单浮层的 z-index（520）**高过**私信抽屉（80）——
           * 名单不收起的话，它正好盖在聊天窗上：看得见、点不着。
           *
           * 必须用**真实点击**（CDP 鼠标事件）：`el.click()` 只派发 click，
           * 不派发 pointerdown —— 而「点别处收起」正是靠 pointerdown 实现的，
           * 用 el.click() 测的话，这条门禁永远测不到真实链路。
           */
          await ensureOnlinePanelOpen();
          const mailRect = await elementRect('button[aria-label="私信"]');
          if (!mailRect) throw new Error('D12 顶栏上找不到「私信」按钮');
          await leftClickAt(mailRect.x, mailRect.y);
          await waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板');
          await sleep(400);
          const stillOpen = await evaluate<boolean>(`!!document.querySelector('.online-panel')`);
          await shot('d12-online-over-dm');
          if (stillOpen) {
            throw new Error(
              'D12 点开私信面板后，在线名单浮层还开着 —— 它盖在聊天窗上（看得见点不着）',
            );
          }

          // ② 名单开着 → 点**别处**（顶栏的标题，那儿没有任何动作）→ 名单必须收起
          await clickSelector('.dm-close', '私信面板的关闭按钮');
          await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
          await ensureOnlinePanelOpen();
          const brandRect = await elementRect('.brand');
          if (!brandRect) throw new Error('D12 顶栏上找不到标题（没有地方点「别处」）');
          await leftClickAt(brandRect.x, brandRect.y);
          await sleep(400);
          const stillOpen2 = await evaluate<boolean>(`!!document.querySelector('.online-panel')`);
          await shot('d12-click-away');
          if (stillOpen2) {
            throw new Error('D12 点别处之后，在线名单浮层没收起（它会一直挡着下面的东西）');
          }
          verdict(
            true,
            'D12 在线名单浮层点别处就收起（开私信面板时会自动让位）',
            '开名单 → 点「私信」：名单已收起｜开名单 → 点顶栏标题：名单已收起',
          );
        });
      }

      /* ================================================================ */
      /* D13：私信限频 —— 客户端冷却 + 服务端拒收                          */
      /* ================================================================ */
      if (gateFilter('D13')) {
        await step('D13', '私信有最小发送间隔（连点只发出一条，服务端也拒收）', async () => {
          await ensureLobby();
          await openDmWithPeer();

          /*
           * ① **客户端**：连点两下快捷短语 → 只能发出去一条。
           *
           * 私密信每发一条，**对面**就弹一条提示；
           * 不限频的话，对面的顶栏会被糊成**一整列提示条**（用户反馈）。
           */
          const mark = peer.mark();
          await clickSelector('.dm-quick .rail-quick-btn', '第一颗快捷短语');
          await sleep(300);
          const cooling = await evaluate<{ disabled: boolean; footText: string }>(`
            (() => {
              const b = document.querySelector('.dm-quick .rail-quick-btn');
              return {
                disabled: b ? b.disabled : false,
                footText: (document.querySelector('.dm-foot')?.innerText || '').trim(),
              };
            })()
          `);
          await shot('d13-cooling');
          if (!cooling.disabled) {
            throw new Error(
              'D13 发完一条之后快捷短语按钮没有变灰 —— 可以按住连点轰炸（对面会被一列提示糊住）',
            );
          }
          /*
           * **不许多写一句提示**（用户拍板：「不用显示冷却几秒…直接用页面的表现」）。
           *
           * 按钮灰了就是「现在发不了」；再补一句「冷却 N 秒」是**多此一举**。
           * 这条判据把「界面自解释」钉死 —— 以后谁想加回那行字，门禁会红。
           */
          if (/冷却|稍等|还要等|\\d+\\s*秒/.test(cooling.footText)) {
            throw new Error(
              `D13 冷却期间多出了提示文字：「${cooling.footText}」—— ` +
                `按钮变灰已经说明了一切，不用再写一句`,
            );
          }
          // 冷却中再点一下（应当按不动）
          const quickRect = await elementRect('.dm-quick .rail-quick-btn');
          if (!quickRect) throw new Error('D13 找不到快捷短语按钮');
          await leftClickAt(quickRect.x, quickRect.y);
          await sleep(500);
          const sent = peer.countSince(mark, (m) => m.t === 'dm');
          if (sent !== 1) {
            throw new Error(`D13 连点两下快捷短语，对面收到了 ${sent} 条私信（应该只有 1 条）`);
          }

          // 冷却过去以后还能再发（冷却是**延迟**，不是把发送功能弄没了）
          await waitForExpr(
            `document.querySelector('.dm-quick .rail-quick-btn') && !document.querySelector('.dm-quick .rail-quick-btn').disabled`,
            '冷却结束',
            6000,
          );
          await clickSelector('.dm-quick .rail-quick-btn', '冷却结束后的快捷短语');
          await sleep(500);
          const sent2 = peer.countSince(mark, (m) => m.t === 'dm');
          if (sent2 !== 2) {
            throw new Error(`D13 冷却结束后再发一条，对面总共只收到 ${sent2} 条（应该是 2 条）`);
          }

          /*
           * ② **服务端**：对面连发 3 条 → 浏览器只该收到 1 条。
           *
           * 客户端那层只是给人看的提示，**规则本身在服务端**：
           * 改个协议就能绕过去的那种不算规则。
           */
          const uid = await browserUserId();
          if (!uid) throw new Error('D13 拿不到浏览器的 userId');
          // 先把未读清掉：开一次面板（会清零）再关上
          await openDmWithPeer();
          await clickSelector('.dm-close', '私信面板的关闭按钮');
          await waitForExpr(`!document.querySelector('.dm-panel')`, '私信面板关掉');
          await sleep(300);
          // 等对面的限频桶空出来（服务端 1.2 秒一条）
          await sleep(1400);
          const mark2 = peer.mark();
          for (const t of ['来一盘？', '马上到', '缺个对手']) {
            peer.send({ t: 'dm.send', to: uid, text: t });
          }
          await waitForExpr(`!!document.querySelector('.dm-btn .chat-badge')`, '未读角标', 6000);
          await sleep(700);
          const badge = await evaluate<string>(
            `(document.querySelector('.dm-btn .chat-badge')?.textContent || '').trim()`,
          );
          const rejected = peer.countSince(
            mark2,
            (m) => m.t === 'toast' && String(m.message || '').includes('发送太快了'),
          );
          await shot('d13-server-limit');
          if (badge !== '1') {
            throw new Error(
              `D13 对面连发 3 条私信，浏览器未读角标是「${badge}」（应该是 1 —— 服务端没限频）`,
            );
          }
          if (rejected < 2) {
            throw new Error(`D13 服务端只拒了 ${rejected} 条（应该拒 2 条）`);
          }
          verdict(
            true,
            'D13 私信有最小发送间隔（连点只发出一条，服务端也拒收）',
            `客户端：连点只到 1 条｜按钮变灰、无提示文字｜冷却后能再发｜服务端拒收 ${rejected} 条｜未读角标=1`,
          );
        });
      }

      /* ================================================================ */
      /* D14：消息通知限位右上角（合并 + 封顶）                            */
      /* ================================================================ */
      if (gateFilter('D14')) {
        await step('D14', '消息通知限位右上角（同一个人合并成一条、条数封顶）', async () => {
          await ensureLobby();
          const uid = await browserUserId();
          if (!uid) throw new Error('D14 拿不到浏览器的 userId');

          /*
           * ① **同一个人的连发合并成一条**。
           *
           * 用**新造的人**发 —— 他的合并计数从 1 开始，
           * 不会被前面几条门禁留下的提示污染。
           */
          const spammer = await newPerson('连发的人');
          try {
            for (let i = 0; i < 3; i += 1) {
              // 间隔放在**发之前**：发完就去看，才看得到「合并成一条」的那条提示
              if (i > 0) await sleep(1400); // 服务端限频 1.2 秒 —— 慢一点发，才不会被服务端拒
              spammer.client.send({ t: 'dm.send', to: uid, text: ['来一盘？', '马上到', '缺个对手'][i] });
            }
            await waitForExpr(
              `[...document.querySelectorAll('.toast-text')].some((e) => (e.textContent || '').includes('连发的人'))`,
              '连发那个人的提示',
              8000,
            );
            await sleep(400);
            const merged = await evaluate<string[]>(
              `[...document.querySelectorAll('.toast-text')].map((e) => (e.textContent || '').trim()).filter((t) => t.includes('连发的人'))`,
            );
            await shot('d14-merged');
            if (merged.length !== 1) {
              throw new Error(
                `D14 同一个人连发 3 条私信，弹了 ${merged.length} 条提示（应该合并成 1 条：「${merged.join(' / ')}」）`,
              );
            }
            if (!/给你发来\s*3\s*条消息/.test(merged[0])) {
              throw new Error(`D14 合并后的提示没写明条数：「${merged[0]}」`);
            }

            /*
             * ② **条数封顶**：好几个人各发一条 → 可见提示**最多 4 条**。
             *
             * 数「这几个新的人各自的提示」而不是数页面上所有的提示 ——
             * 页面上还可能有别的提示（换页清空之类），
             * 那些跟「私信轰炸会不会糊满一屏」没关系。
             */
            const crowd: string[] = [];
            for (let i = 0; i < 7; i += 1) {
              const p = await newPerson(`排队的人${i + 1}`);
              crowd.push(p.name);
              p.client.send({ t: 'dm.send', to: uid, text: '来一盘？' });
            }
            await waitForExpr(
              `[...document.querySelectorAll('.toast-text')].filter((e) => (e.textContent || '').includes('排队的人')).length > 0`,
              '好几个人发来的提示',
              8000,
            );
            await sleep(600);
            const shown = await evaluate<{ texts: string[]; boxes: Array<{ t: number; b: number; r: number }> }>(`
              (() => {
                const els = [...document.querySelectorAll('.toast')];
                return {
                  texts: els.map((e) => (e.textContent || '').trim()),
                  boxes: els.map((e) => {
                    const r = e.getBoundingClientRect();
                    return { t: Math.round(r.top), b: Math.round(r.bottom), r: Math.round(r.right) };
                  }),
                };
              })()
            `);
            const fromCrowd = shown.texts.filter((t) => crowd.some((n) => t.includes(n)));
            await shot('d14-capped');
            if (fromCrowd.length > 4) {
              throw new Error(
                `D14 7 个人各发一条私信，页面上同时有 ${fromCrowd.length} 条提示（最多 4 条）—— ` +
                  `提示会从右上角一路铺到屏幕中间`,
              );
            }
            /*
             * ③ 提示区有**高度上限**（CSS 兜底）—— 没有它，
             *    就算条数封住了，容器本身还是能长到屏幕下面去。
             */
            const maxH = await evaluate<string>(
              `getComputedStyle(document.querySelector('.toasts')).maxHeight`,
            );
            if (!maxH || maxH === 'none') {
              throw new Error('D14 提示区没有高度上限（max-height 被删了）—— 提示条能一路铺到屏幕下面');
            }
            /*
             * ④ 提示**待在右上角**：最下面那条也不能低到屏幕中间去。
             */
            const lowest = shown.boxes.reduce((m, x) => Math.max(m, x.b), 0);
            const viewportH = await evaluate<number>(`window.innerHeight`);
            if (lowest > viewportH * 0.45) {
              throw new Error(
                `D14 提示区垂到 ${lowest}px（视口高 ${viewportH}px）—— 没待在右上角`,
              );
            }
            verdict(
              true,
              'D14 消息通知限位右上角（同一个人合并成一条、条数封顶）',
              `合并：「${merged[0]}」｜${crowd.length} 个人各一条 → 可见 ${fromCrowd.length} 条｜提示区最低 ${lowest}px（视口 ${viewportH}px）｜max-height=${maxH}`,
            );
          } finally {
            spammer.client.close();
            for (const c of extraPeople) c.close();
            extraPeople.length = 0;
          }
        });
      }
    } finally {
      peer.close();
      bare.close();
      for (const c of extraPeople) c.close();
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
