/**
 * 本轮新功能的浏览器门禁 —— 设置弹窗 / 棋谱抽屉 / 棋盘配色 / 辅助下棋 / 音效 / AI 难度。
 *
 * 为什么单独一个脚本（而不是塞进 verify-move-arrow.ts）：
 *   这一批功能都是**产品面**的（用户拍板新增），和「走子箭头看得见」是不同主题；
 *   混在一起会让任何一个脚本的失败都很难定位。
 *
 * 门禁清单（19 条判据，U1~U18）：
 *   U1  顶栏有齿轮按钮，点开就是设置弹窗。
 *   U2  设置弹窗内容齐全：音效开关 / 音量 / 5 套配色 / 辅助下棋 / 翻转棋盘。
 *   U3  音效**默认关**（用户拍板）—— 开关未勾选，且 localStorage 里不是 true。
 *   U4  棋盘格子是**纯色**（用户说「看着不像纯色」）—— background-image 必须是 none。
 *   U5  换配色**真的生效** —— 切「蓝白」后深格背景色变成 #4d7fbe，且已落盘。
 *   U6  「♟ 棋谱」按钮在**快捷聊天右边**、且同一行（用户拍板的位置）。
 *   U7  棋谱抽屉能打开、步数与对局一致、列出了真实 SAN、底部有「复制 PGN」，
 *       点一下真的把 PGN 写进剪贴板。
 *   U8  棋谱抽屉与聊天弹层**同一套样式**（用户拍板「和聊天是同一个样式的」）。
 *   U9  辅助下棋开着 → HUD 里出现「提示」按钮，**点它**才出现**蓝色**指引箭头
 *       （开着的时候**不许**自动显示 —— 判据看的是「有没有发过 hint.request」）。
 *   U10 辅助下棋关掉 → 指引箭头和「提示」按钮一起消失。
 *   U11 大厅的电脑难度是**三档**（easy / normal / hard），默认 normal。
 *   U12 音效开关打开 → 真的创建了 AudioContext（音效不是摆设）。
 *   U13 **进不去房间**（对局已结束 / 房间不存在）→ 页面给出**写明原因的错误卡片**
 *       + 一个「返回大厅」按钮；点它真的回到大厅。
 *   U14 设置里有**棋子风格**（经典/卡通/像素/涂鸦，4 选 1）与
 *       **棋子材质**（木质/金属/塑料，3 选 1），各带一枚真实棋子预览。
 *   U15 切风格 → 棋盘上棋子的**形状**真的变了，且已落盘。
 *   U16 切材质 → 棋盘上棋子的**颜色**真的变了，且已落盘。
 *   U17 刷新页面后外观设置**仍然生效**（落盘 + 回读）。
 *   U18 材质的画法是「大片高光 + clipPath 裁回剪影」—— 裁剪必须真的生效，
 *       材质**不能溢出到棋盘上**（判据用命中测试，带一条反向自检防恒真）。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 *
 * 重要：**每条门禁的失败信息都必须带上自己的编号**（U1…U12）。
 *   变异测试靠「❌ 行里含门禁编号」判定「这一条被抓到了」——
 *   如果失败只印一句「等待超时」，变异脚本就分不清「这条门禁红了」
 *   还是「脚本自己崩了」，会出现假绿。
 *
 * 用法：
 *   npx tsx scripts/verify-settings-ui.ts [http://127.0.0.1:3000]
 *
 * 零新增依赖：复用项目已有的 ws；Chromium 用本机 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * 应用地址。
 *
 * `--url=` 和**位置参数**两种都认 —— 原来只认位置参数，
 * 于是 `--url=http://…` 会被当成地址本身传进 `Page.navigate`，
 * 报「Cannot navigate to invalid URL」这种看不懂的错。
 * 跟别的门禁脚本（verify-color-draw / verify-drag）保持一致。
 */
const APP_URL =
  process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length) ??
  process.env.VERIFY_URL ??
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  'http://127.0.0.1:3000';
/** 游戏协议的 ws 地址（与 APP_URL 同源） */
const WS_URL = APP_URL.replace(/^http/, 'ws') + '/ws';
const OUT_DIR = join(process.cwd(), 'artifacts', 'settings-ui');
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 极简的游戏协议 ws 客户端 —— 门禁用来**造房间**。
 *
 * 为什么需要：有些状态浏览器里造不出来（比如「一个已经结束的对局」，
 * 人机局下不到那一步）。用两个 ws 客户端开房 + 加入 + 认输，
 * 就能得到一个**对局已结束**的房间，正好是「刷新后进不去」的典型场景。
 */
class GameClient {
  private readonly ws: WebSocket;
  private readonly msgs: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.msgs.push(JSON.parse(String(raw)) as Record<string, unknown>);
      } catch {
        /* 不是 JSON 就忽略 */
      }
    });
  }

  /** 等连接建好 */
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
    pred: (m: Record<string, unknown>) => T | null,
    label: string,
    timeoutMs = 10000,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const m of this.msgs) {
        const v = pred(m);
        if (v !== null) return v;
      }
      await sleep(100);
    }
    throw new Error(`等待「${label}」超时`);
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
function roomStateOf(msg: Record<string, unknown>): { code: string; status: string } | null {
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
  console.log(`输出目录：${OUT_DIR}\n`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-settings-'));
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
     * 为什么需要：「辅助下棋」的箭头时有时无 —— 光看页面状态分不清是
     * 「请求没发出去」「服务端没回」还是「回来了但被清掉」。
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
                let fen = '';
                let moves = -1;
                try {
                  const j = JSON.parse(s);
                  t = j.t || '?';
                  if (j.state) {
                    fen = (j.state.fen || '').split(' ')[1] || '';
                    moves = Array.isArray(j.state.moves) ? j.state.moves.length : -1;
                  }
                  if (j.move) fen = 'MOVE:' + j.move.from + j.move.to;
                  if (j.error) fen = 'ERR:' + j.error;
                } catch { /* 不是 JSON 就原样存 */ }
                window.__wsLog.push({ dir, t, fen, moves, at: Date.now() });
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

    /** 点一个元素（JS 点击，触发 React 的 onClick） */
    const clickSelector = async (selector: string, label: string, timeoutMs = 8000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const done = await evaluate<boolean>(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (done) return;
        await sleep(200);
      }
      throw new Error(`点不到「${label}」（${selector}）`);
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

    /* ================================================================ */
    /* U11：大厅的电脑难度是三档                                       */
    /* ================================================================ */
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(600);
    await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
    await evaluate(`
      (() => {
        const input = document.querySelector('input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '设置验收员');
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
      '「人机对弈」按钮',
    );
    // 人机对弈的表单在「人机对弈」面板里 —— 先把它打开
    await clickText('button', '人机对弈', '「人机对弈」按钮');
    await waitForExpr(`!!document.querySelector('#ai-diff')`, '难度下拉');

    await step('U11', '电脑难度是三档（easy/normal/hard，默认 normal）', async () => {
      // 难度是自绘下拉（Picker），不是原生 <select>：展开后读选项的 data-value
      await evaluate(`
        (() => {
          const t = document.querySelector('#ai-diff');
          if (!t) return false;
          t.click();
          return true;
        })()
      `);
      await waitForExpr(
        `document.querySelectorAll('.picker-menu [role="option"]').length > 0`,
        '难度选项列表',
      );
      const diffOptions = await evaluate<{ values: string[]; value: string }>(
        `(() => {
          const opts = [...document.querySelectorAll('.picker-menu [role="option"]')];
          return {
            values: opts.map((o) => o.getAttribute('data-value') || ''),
            value: document.querySelector('#ai-diff')?.getAttribute('data-value') || '',
          };
        })()`,
      );
      verdict(
        diffOptions.values.length === 3 &&
          ['easy', 'normal', 'hard'].every((v) => diffOptions.values.includes(v)) &&
          diffOptions.value === 'normal',
        'U11 电脑难度是三档（easy/normal/hard，默认 normal）',
        `实际选项：${JSON.stringify(diffOptions.values)}，默认值：${diffOptions.value}`,
      );
    });

    /* ================================================================ */
    /* 开一局人机对局                                                   */
    /* ================================================================ */
    await evaluate(`
      (() => {
        const opt = [...document.querySelectorAll('.picker-menu [role="option"]')]
          .find((o) => o.getAttribute('data-value') === 'hard');
        if (!opt) return false;
        opt.click();
        return true;
      })()
    `);
    await sleep(200);

    /*
     * **显式选「我执黑」** ——
     * 人机局现在默认是「随机抽签」（服务端抽，各 50%），
     * 而下面 U5/U7 那步棋写死了「我是黑方：e7 → e5」。
     * 抽到白方那一步就是废棋 → 服务端拒收 → 棋谱是空的 → U7 变红。
     * 把颜色定死，测的仍然是真实链路，只是把随机那一维去掉。
     */
    await evaluate(`
      (() => {
        const t = document.querySelector('#ai-color');
        if (!t) return false;
        t.click();
        return true;
      })()
    `);
    await waitForExpr(
      `(() => {
         const t = document.querySelector('#ai-color');
         const menuId = t && t.getAttribute('aria-controls');
         const menu = menuId ? document.getElementById(menuId) : null;
         return !!(menu && menu.querySelector('[role="option"]'));
       })()`,
      '「执子」选项列表',
    );
    await evaluate(`
      (() => {
        const t = document.querySelector('#ai-color');
        const menuId = t && t.getAttribute('aria-controls');
        const menu = menuId ? document.getElementById(menuId) : null;
        const opt = menu ? [...menu.querySelectorAll('[role="option"]')]
          .find((o) => o.getAttribute('data-value') === 'b') : null;
        if (!opt) return false;
        opt.click();
        return true;
      })()
    `);
    await sleep(200);

    await clickText('button', '确定', '「确定」按钮');
    await waitForExpr(`location.pathname.startsWith('/room/')`, '跳转对局页', 20000);
    console.log(`已进入房间：${await evaluate<string>('location.pathname')}`);

    await waitForExpr(`!!document.querySelector('.square[data-square]')`, '棋盘渲染', 20000);
    await waitForExpr(`!!document.querySelector('.move-arrow polygon')`, '电脑走出第一步', 30000).catch(
      () => undefined,
    );
    await sleep(500);

    /* ================================================================ */
    /* U1：顶栏齿轮 + 点开就是设置弹窗                                 */
    /* ================================================================ */
    await step('U1', '顶栏齿轮能打开设置弹窗', async () => {
      const gear = await evaluate<number>(
        `[...document.querySelectorAll('header button')]
          .filter((b) => (b.getAttribute('aria-label') || '') === '设置').length`,
      );
      verdict(gear === 1, 'U1 顶栏只有一个齿轮设置按钮', `找到 ${gear} 个 aria-label=设置 的按钮`);
      await clickSelector('header button[aria-label="设置"]', '齿轮按钮');
      await waitForExpr(`!!document.querySelector('.settings-panel')`, '设置弹窗打开', 8000);
      verdict(true, 'U1 点齿轮能打开设置弹窗', '.settings-panel 已出现');
    });

    /* ================================================================ */
    /* U2：设置弹窗内容齐全                                            */
    /* ================================================================ */
    await step('U2', '设置弹窗内容齐全', async () => {
      const panel = await evaluate<{
        soundSwitch: boolean;
        volume: boolean;
        themeChips: number;
        themeLabels: string[];
        hintSwitch: boolean;
        flipSwitch: boolean;
      }>(`
        (() => {
          const p = document.querySelector('.settings-panel');
          if (!p) return { soundSwitch: false, volume: false, themeChips: 0, themeLabels: [], hintSwitch: false, flipSwitch: false };
          return {
            soundSwitch: !!p.querySelector('input[aria-label="音效开关"]'),
            volume: !!p.querySelector('input[aria-label="音量"]'),
            themeChips: p.querySelectorAll('.theme-chip').length,
            themeLabels: [...p.querySelectorAll('.theme-chip .theme-name')].map((n) => n.textContent || ''),
            hintSwitch: !!p.querySelector('input[aria-label="辅助下棋开关"]'),
            flipSwitch: !!p.querySelector('input[aria-label="翻转棋盘开关"]'),
          };
        })()
      `);
      verdict(
        panel.soundSwitch &&
          panel.volume &&
          panel.themeChips >= 5 &&
          panel.hintSwitch &&
          panel.flipSwitch &&
          panel.themeLabels.some((l) => l.includes('蓝白')) &&
          panel.themeLabels.some((l) => l.includes('绿白')),
        'U2 设置弹窗内容齐全（音效/音量/≥5 套配色/辅助下棋/翻转棋盘）',
        `主题：${JSON.stringify(panel.themeLabels)}，音效开关=${panel.soundSwitch} 音量=${panel.volume} 辅助=${panel.hintSwitch} 翻转=${panel.flipSwitch}`,
      );
      await shot('u2-settings');
    });

    /* ================================================================ */
    /* U3：音效默认关                                                  */
    /* ================================================================ */
    await step('U3', '音效默认关', async () => {
      const soundDefault = await evaluate<{ checked: boolean; stored: unknown }>(`
        (() => {
          const cb = document.querySelector('.settings-panel input[aria-label="音效开关"]');
          let stored = null;
          try {
            const raw = localStorage.getItem('lan-chess.settings');
            stored = raw ? JSON.parse(raw).soundEnabled : null;
          } catch { stored = 'parse-error'; }
          return { checked: !!cb && cb.checked, stored };
        })()
      `);
      verdict(
        soundDefault.checked === false && soundDefault.stored !== true,
        'U3 音效默认关',
        `开关勾选=${soundDefault.checked}，localStorage.soundEnabled=${JSON.stringify(soundDefault.stored)}`,
      );
    });

    /* ================================================================ */
    /* U4：棋盘格子是纯色                                              */
    /* ================================================================ */
    await step('U4', '棋盘格子是纯色', async () => {
      const pureColor = await evaluate<{ light: string; dark: string }>(`
        (() => {
          const l = document.querySelector('.square.light');
          const d = document.querySelector('.square.dark');
          const cs = l ? getComputedStyle(l) : null;
          const cd = d ? getComputedStyle(d) : null;
          return {
            light: cs ? cs.backgroundImage : 'no-el',
            dark: cd ? cd.backgroundImage : 'no-el',
          };
        })()
      `);
      verdict(
        pureColor.light === 'none' && pureColor.dark === 'none',
        'U4 棋盘格子是纯色（没有木纹贴图）',
        `浅格 background-image=${pureColor.light}，深格=${pureColor.dark}`,
      );
    });

    /* ================================================================ */
    /* U5：换配色真的生效                                              */
    /* ================================================================ */
    await step('U5', '切「蓝白」配色后棋盘真的变色', async () => {
      await evaluate(`
        (() => {
          const chip = [...document.querySelectorAll('.theme-chip')]
            .find((c) => (c.textContent || '').includes('蓝白'));
          if (chip) chip.click();
          return true;
        })()
      `);
      await sleep(600);
      const themed = await evaluate<{ dark: string; light: string; stored: string | null }>(`
        (() => {
          const l = document.querySelector('.square.light');
          const d = document.querySelector('.square.dark');
          let stored = null;
          try {
            const raw = localStorage.getItem('lan-chess.settings');
            stored = raw ? (JSON.parse(raw).boardTheme ?? null) : null;
          } catch { stored = 'parse-error'; }
          return {
            dark: d ? getComputedStyle(d).backgroundColor : 'no-el',
            light: l ? getComputedStyle(l).backgroundColor : 'no-el',
            stored,
          };
        })()
      `);
      verdict(
        themed.dark === 'rgb(77, 127, 190)' && themed.light === 'rgb(219, 231, 246)' && themed.stored === 'ocean',
        'U5 切「蓝白」配色后棋盘真的变色（且已落盘）',
        `深格=${themed.dark}（应 rgb(77, 127, 190)），浅格=${themed.light}，localStorage=${themed.stored}`,
      );
      await shot('u5-ocean');
    });

    /* ================================================================ */
    /* U14：设置里有「棋子风格」「棋子材质」两个切换块                    */
    /* ================================================================ */
    await step('U14', '设置里有棋子风格（4 选 1）与棋子材质（3 选 1）', async () => {
      const chips = await evaluate<{
        styleLabels: string[];
        materialLabels: string[];
        styleActive: string[];
        materialActive: string[];
        previews: number;
      }>(`
        (() => {
          const p = document.querySelector('.settings-panel');
          if (!p) return { styleLabels: [], materialLabels: [], styleActive: [], materialActive: [], previews: 0 };
          const styleChips = [...p.querySelectorAll('button[aria-label^="棋子风格"]')];
          const materialChips = [...p.querySelectorAll('button[aria-label^="棋子材质"]')];
          return {
            styleLabels: styleChips.map((c) => (c.textContent || '').trim()),
            materialLabels: materialChips.map((c) => (c.textContent || '').trim()),
            styleActive: styleChips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.getAttribute('aria-label') || ''),
            materialActive: materialChips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.getAttribute('aria-label') || ''),
            previews: p.querySelectorAll('.piece-chip-preview svg').length,
          };
        })()
      `);
      verdict(
        chips.styleLabels.length === 4 &&
          chips.materialLabels.length === 3 &&
          chips.styleLabels.some((l) => l.includes('经典')) &&
          chips.styleLabels.some((l) => l.includes('卡通')) &&
          chips.styleLabels.some((l) => l.includes('像素')) &&
          chips.styleLabels.some((l) => l.includes('涂鸦')) &&
          chips.materialLabels.some((l) => l.includes('木质')) &&
          chips.materialLabels.some((l) => l.includes('金属')) &&
          chips.materialLabels.some((l) => l.includes('塑料')) &&
          chips.styleActive.length === 1 &&
          chips.materialActive.length === 1,
        'U14 设置里有棋子风格（4 选 1）与棋子材质（3 选 1），且各有一个默认选中',
        `风格：${JSON.stringify(chips.styleLabels)}，材质：${JSON.stringify(chips.materialLabels)}，` +
          `选中：${JSON.stringify(chips.styleActive)} / ${JSON.stringify(chips.materialActive)}`,
      );
      // 每个 chip 都应该带一枚**真的棋子**预览（不是空盒子）
      verdict(
        chips.previews >= 7,
        'U14 每个外观选项都带一枚真实棋子预览',
        `预览里的 SVG 数量：${chips.previews}（4 风格 + 3 材质 = 7）`,
      );
    });

    /* ================================================================ */
    /* U15：切风格 → 棋盘上的棋子真的换了形状                             */
    /* ================================================================ */
    await step('U15', '切棋子风格 → 棋盘上棋子的形状真的变了（且已落盘）', async () => {
      /** 取棋盘上第一枚棋子的「形状签名」：所有 path 的 d + 圆/椭圆的属性 */
      const pieceShapeSig = async (): Promise<string> =>
        evaluate<string>(`
          (() => {
            const svg = document.querySelector('.piece svg');
            if (!svg) return '';
            const parts = [svg.getAttribute('shape-rendering') || ''];
            svg.querySelectorAll('path').forEach((p) => parts.push(p.getAttribute('d') || ''));
            svg.querySelectorAll('circle,ellipse').forEach((c) => parts.push(c.outerHTML));
            return parts.join('#');
          })()
        `);

      const before = await pieceShapeSig();
      await evaluate(`
        (() => {
          const chip = [...document.querySelectorAll('.settings-panel button[aria-label^="棋子风格"]')]
            .find((c) => (c.getAttribute('aria-label') || '').includes('像素'));
          if (chip) chip.click();
          return true;
        })()
      `);
      await sleep(500);
      const after = await pieceShapeSig();
      const stored = await evaluate<string | null>(`
        (() => {
          try {
            const raw = localStorage.getItem('lan-chess.settings');
            return raw ? (JSON.parse(raw).pieceStyle ?? null) : null;
          } catch { return 'parse-error'; }
        })()
      `);
      verdict(
        before.length > 0 && after.length > 0 && before !== after && stored === 'pixel',
        'U15 切「像素」风格 → 棋盘上棋子的形状真的变了（且已落盘）',
        `签名长度 ${before.length} → ${after.length}，是否相同=${before === after}，localStorage.pieceStyle=${stored}`,
      );
      await shot('u15-pixel');
    });

    /* ================================================================ */
    /* U16：切材质 → 棋盘上棋子的表面真的变了                             */
    /* ================================================================ */
    await step('U16', '切棋子材质 → 棋盘上棋子的颜色真的变了（且已落盘）', async () => {
      /** 取第一枚棋子第一条 path 的填充色 */
      const pieceFill = async (): Promise<string> =>
        evaluate<string>(`
          (() => {
            const p = document.querySelector('.piece svg path');
            return p ? (p.getAttribute('fill') || '') : '';
          })()
        `);

      const before = await pieceFill();
      await evaluate(`
        (() => {
          const chip = [...document.querySelectorAll('.settings-panel button[aria-label^="棋子材质"]')]
            .find((c) => (c.getAttribute('aria-label') || '').includes('金属'));
          if (chip) chip.click();
          return true;
        })()
      `);
      await sleep(500);
      const after = await pieceFill();
      const stored = await evaluate<string | null>(`
        (() => {
          try {
            const raw = localStorage.getItem('lan-chess.settings');
            return raw ? (JSON.parse(raw).pieceMaterial ?? null) : null;
          } catch { return 'parse-error'; }
        })()
      `);
      verdict(
        before.length > 0 && after.length > 0 && before !== after && stored === 'metal',
        'U16 切「金属」材质 → 棋盘上棋子的颜色真的变了（且已落盘）',
        `填充色 ${before} → ${after}，localStorage.pieceMaterial=${stored}`,
      );
      await shot('u16-metal');
    });

    /* ================================================================ */
    /* U17：刷新后外观设置还在（落盘 + 回读）                             */
    /* ================================================================ */
    await step('U17', '刷新页面后棋子外观设置仍然生效', async () => {
      const beforeReload = await evaluate<string>(`
        (() => {
          const svg = document.querySelector('.piece svg');
          if (!svg) return '';
          const parts = [svg.getAttribute('shape-rendering') || ''];
          svg.querySelectorAll('path').forEach((p) => parts.push(p.getAttribute('d') || ''));
          return parts.join('#');
        })()
      `);
      await cdp!.send('Page.reload', { ignoreCache: false });
      await waitForExpr(`location.pathname.startsWith('/room/')`, '刷新后回到对局页', 20000);
      await waitForExpr(`!!document.querySelector('.piece svg')`, '刷新后棋盘渲染', 20000);
      await sleep(600);
      const afterReload = await evaluate<string>(`
        (() => {
          const svg = document.querySelector('.piece svg');
          if (!svg) return '';
          const parts = [svg.getAttribute('shape-rendering') || ''];
          svg.querySelectorAll('path').forEach((p) => parts.push(p.getAttribute('d') || ''));
          return parts.join('#');
        })()
      `);
      verdict(
        beforeReload.length > 0 && beforeReload === afterReload,
        'U17 刷新页面后棋子外观设置仍然生效',
        `刷新前后形状签名是否一致=${beforeReload === afterReload}（长度 ${beforeReload.length} / ${afterReload.length}）`,
      );
      // 刷新后设置弹窗是关着的 —— 后面几条门禁还要用它，这里重新打开
      await clickSelector('header button[aria-label="设置"]', '齿轮按钮');
      await waitForExpr(`!!document.querySelector('.settings-panel')`, '设置弹窗重新打开', 8000);
    });

    /* ================================================================ */
    /* U18：材质层必须被裁在棋子剪影内（不能溢出到棋盘上）                 */
    /* ================================================================ */
    await step('U18', '材质层被裁剪在棋子轮廓内（不溢出到棋盘上）', async () => {
      /*
       * 为什么单独守这一条：
       *   材质的画法是「先画一大片高光/木纹，再用 clipPath 裁回棋子轮廓」。
       *   这条链一旦断了（clipPath 的 id 撞了、被删了、材质层忘了加裁剪），
       *   木纹会画到棋盘格上、高光会糊成一坨 —— 画面立刻变脏。
       *   而 id 撞车这种事**真的发生过**（预览脚本多根渲染时所有棋子共用一个
       *   clipPath），所以必须有门禁盯着。
       *
       * 判据用**命中测试**（elementFromPoint），不用像素：
       *   命中测试遵守 clip-path —— 被裁掉的地方就**点不到**材质层了。
       *   像素比对会被抗锯齿和动画搅浑，命中测试不会。
       *   三次采样都在同一个 evaluate 里同步做完 → 中间不可能发生动画位移。
       */
      // 切到「经典 + 金属」：金属那道斜切高光带明显超出棋子剪影，最容易溢出
      for (const [prefix, want] of [
        ['棋子风格', '经典'],
        ['棋子材质', '金属'],
      ] as const) {
        await evaluate(`
          (() => {
            const chips = [...document.querySelectorAll('.settings-panel button[aria-label^="${prefix}"]')];
            const chip = chips.find((c) => (c.getAttribute('aria-label') || '').includes(${JSON.stringify(want)}));
            if (chip) chip.click();
            return true;
          })()
        `);
        await sleep(250);
      }
      await sleep(400);
      /*
       * ⚠️ 必须先**关掉设置弹窗**：
       *   设置是一层全屏 overlay，弹窗开着的时候 elementFromPoint 命中的
       *   是 overlay，不是棋子 —— 采样会全落在棋子外面（材质可见 0 点）。
       */
      await evaluate(`
        (() => {
          const btn = document.querySelector('.settings-panel .settings-head button');
          if (btn) btn.click();
          return true;
        })()
      `);
      await sleep(500);

      const probe = await evaluate<{
        error?: string;
        pieces: number;
        materialPoints: number;
        bodyPoints: number;
        spill: number;
        wouldSpill: number;
        missingClip: number;
        total: number;
      }>(`
        (() => {
          const svgs = [...document.querySelectorAll('.piece svg')];
          if (!svgs.length) return { error: '棋盘上没有棋子' };
          // 命中测试只对视口内的坐标有效 —— 先把棋盘滚进来
          svgs[0].scrollIntoView({ block: 'center', inline: 'center' });

          const N = 32; // 采样网格密度
          let pieces = 0;
          let materialPoints = 0;
          let bodyPoints = 0;
          let spill = 0;
          let wouldSpill = 0;
          let missingClip = 0;
          let total = 0;

          for (const svg of svgs) {
            const g = svg.querySelector('g[clip-path]');
            if (!g) { missingClip += 1; continue; }
            const clipAttr = g.getAttribute('clip-path') || '';
            const clipId = (clipAttr.match(/url\\(#([^)]+)\\)/) || [])[1] || '';
            if (!clipId || !svg.querySelector('#' + CSS.escape(clipId))) {
              missingClip += 1;
              continue;
            }
            pieces += 1;

            const matEls = [...g.querySelectorAll('path,ellipse,rect,circle,line,polygon')];
            const r = svg.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;

            const sample = () => {
              const kinds = [];
              for (let i = 0; i <= N; i += 1) {
                for (let j = 0; j <= N; j += 1) {
                  const x = r.left + (r.width * i) / N;
                  const y = r.top + (r.height * j) / N;
                  const el = document.elementFromPoint(x, y);
                  if (!el) { kinds.push('none'); continue; }
                  if (matEls.includes(el)) { kinds.push('material'); continue; }
                  if (el !== svg && svg.contains(el)) { kinds.push('inside'); continue; }
                  if (el === svg) { kinds.push('svgroot'); continue; }
                  kinds.push('outside');
                }
              }
              return kinds;
            };

            // 棋子可被命中（.piece-layer 是 pointer-events:none，命中事件默认穿透）
            const prevPE = svg.style.pointerEvents;
            svg.style.pointerEvents = 'auto';

            const withMaterial = sample();
            g.style.display = 'none';
            const bodyOnly = sample();
            g.style.display = '';
            const prevClip = g.getAttribute('clip-path');
            g.removeAttribute('clip-path');
            const unclipped = sample();
            if (prevClip) g.setAttribute('clip-path', prevClip);
            svg.style.pointerEvents = prevPE;

            for (let i = 0; i < withMaterial.length; i += 1) {
              total += 1;
              if (withMaterial[i] === 'material') materialPoints += 1;
              if (bodyOnly[i] === 'inside') bodyPoints += 1;
              // 材质画到了「本体之外」的地方 = 溢出
              if (withMaterial[i] === 'material' && bodyOnly[i] !== 'inside') spill += 1;
              // 不裁剪的话本来会溢出到哪儿（用来证明这道门禁不是空跑）
              if (unclipped[i] === 'material' && bodyOnly[i] !== 'inside') wouldSpill += 1;
            }
          }

          return { pieces, materialPoints, bodyPoints, spill, wouldSpill, missingClip, total };
        })()
      `);

      if (probe.error) throw new Error(probe.error);
      verdict(
        probe.missingClip === 0 && probe.spill === 0,
        'U18 材质层被裁剪在棋子轮廓内（不溢出到棋盘上）',
        `棋子 ${probe.pieces} 枚（缺 clip 的 ${probe.missingClip} 枚）· 采样 ${probe.total} 点 · ` +
          `材质可见 ${probe.materialPoints} 点 · 本体 ${probe.bodyPoints} 点 · ` +
          `溢出 ${probe.spill} 点（应 0）· 不裁剪时会溢出 ${probe.wouldSpill} 点`,
      );
      // 反向自检：不裁剪时确实会溢出 → 说明这道门禁有牙齿，不是恒真
      verdict(
        probe.wouldSpill > 0,
        'U18 反向自检：不裁剪时材质真的会溢出（这道门禁不是恒真）',
        `不裁剪会溢出 ${probe.wouldSpill} 点（应 > 0）`,
      );
      // 把设置弹窗**恢复成打开** —— 后面的 U9/U10 还要用它
      await clickSelector('header button[aria-label="设置"]', '齿轮按钮');
      await waitForExpr(`!!document.querySelector('.settings-panel')`, '设置弹窗重新打开', 8000);
    });

    /* ================================================================ */
    /* U9：辅助下棋 → HUD 里出「提示」按钮，点了才有蓝色指引箭头       */
    /* ================================================================ */
    await step('U9', '辅助下棋开启 → HUD 出「提示」按钮，点它才有蓝色箭头', async () => {
      await evaluate(`
        (() => {
          const cb = document.querySelector('.settings-panel input[aria-label="辅助下棋开关"]');
          if (cb && !cb.checked) cb.click();
          return true;
        })()
      `);
      await sleep(400);
      await clickText('.settings-panel button', '关闭', '关闭设置');
      await sleep(300);

      /*
       * ① **不许自动显示**（用户要求：开了辅助下棋也要点「提示」才出下一步）。
       *
       * 判据用**报文流水**，不用「等几秒看有没有箭头」——
       * 后者是那种说不准恒真恒假的判据：引擎算出箭头要多久不确定，
       * 等短了会假绿，等长了白等。
       * 而「有没有发过 hint.request」是**确定的事实**，不靠猜时间。
       */
      const autoRequested = await evaluate<boolean>(
        `(window.__wsLog || []).some((e) => e.dir === 'out' && e.t === 'hint.request')`,
      );
      const autoArrow = await evaluate<boolean>(`!!document.querySelector('.hint-arrow')`);
      const btn = await evaluate<{ exists: boolean; text: string }>(`
        (() => {
          const b = [...document.querySelectorAll('.hud-actions button')]
            .find((x) => (x.textContent || '').includes('提示'));
          return { exists: !!b, text: (b?.textContent || '').trim() };
        })()
      `);
      verdict(
        !autoRequested && !autoArrow && btn.exists,
        'U9a 辅助下棋开着也不自动显示下一步（且 HUD 里冒出「提示」按钮）',
        `自动发过 hint.request=${autoRequested}｜页面上已有箭头=${autoArrow}｜「提示」按钮=${btn.exists}（"${btn.text}"）`,
      );

      // 拍一张「点了之前」的样子：按钮在 HUD 里，棋盘上还没有箭头
      await shot('u9-hint-button');

      /* ② 点「提示」→ 才真的去请求 → 蓝色箭头出现 */
      await clickText('.hud-actions button', '提示', '「提示」按钮');
      await waitForExpr(
        `(() => {
          const p = document.querySelector('.hint-arrow polygon');
          return !!p && getComputedStyle(p).fill === 'rgb(47, 111, 208)';
        })()`,
        '蓝色指引箭头出现（且填色正确）',
        25000,
      ).catch(async (e) => {
        const log = await evaluate<string>(
          `(window.__wsLog || []).map((e) => e.at + ' ' + e.dir + ' ' + e.t + ' turn=' + e.fen + ' moves=' + e.moves).slice(-40).join('\\n')`,
        );
        throw new Error(`${e instanceof Error ? e.message : String(e)} | WebSocket 报文：\n${log}`);
      });
      const info = await evaluate<{ svgCount: number; polyCount: number; fills: string[] }>(`
        (() => {
          const svgs = [...document.querySelectorAll('.hint-arrow')];
          const polys = [...document.querySelectorAll('.hint-arrow polygon')];
          return {
            svgCount: svgs.length,
            polyCount: polys.length,
            fills: polys.map((p) => getComputedStyle(p).fill),
          };
        })()
      `);
      const fill = info.fills[0] ?? 'none';
      /*
       * 箭头必须**留得住**。
       *
       * 之前踩过的坑：服务端每秒广播一次房间快照 → `roomState` 身份每秒变 →
       * 提示 effect 每秒重跑 → 开头那句 `setHintMove(null)` 把刚出现的箭头抹了。
       * 只断言「出现过」是抓不住的（它会闪一下就没），所以这里再等 3 秒复查。
       */
      await sleep(3000);
      const stillThere = await evaluate<boolean>(
        `(() => {
          const p = document.querySelector('.hint-arrow polygon');
          return !!p && getComputedStyle(p).fill === 'rgb(47, 111, 208)';
        })()`,
      );
      verdict(
        info.polyCount >= 1 && fill === 'rgb(47, 111, 208)' && stillThere,
        'U9b 点「提示」→ 出现蓝色指引箭头（且 3 秒后仍在）',
        `svg=${info.svgCount} polygon=${info.polyCount} fill=${fill}（应 rgb(47, 111, 208)），3 秒后仍在=${stillThere}`,
      );
      await shot('u9-hint');
    });

    /* ================================================================ */
    /* U10：关掉辅助下棋 → 箭头消失                                   */
    /* ================================================================ */
    await step('U10', '关掉辅助下棋 → 指引箭头和「提示」按钮一起消失', async () => {
      await clickSelector('header button[aria-label="设置"]', '齿轮按钮');
      await waitForExpr(`!!document.querySelector('.settings-panel')`, '设置弹窗再次打开', 8000);
      await evaluate(`
        (() => {
          const cb = document.querySelector('.settings-panel input[aria-label="辅助下棋开关"]');
          if (cb && cb.checked) cb.click();
          return true;
        })()
      `);
      await sleep(800);
      const hintGone = await evaluate<boolean>(`!document.querySelector('.hint-arrow')`);
      const btnGone = await evaluate<boolean>(`
        ![...document.querySelectorAll('.hud-actions button')]
          .some((x) => (x.textContent || '').includes('提示'))
      `);
      verdict(
        hintGone && btnGone,
        'U10 关掉辅助下棋 → 指引箭头和「提示」按钮一起消失',
        `箭头还在=${!hintGone}｜「提示」按钮还在=${!btnGone}`,
      );
    });

    /* ================================================================ */
    /* U12：音效开关打开 → 真的创建 AudioContext                      */
    /* ================================================================ */
    await step('U12', '音效开关打开 → 真的初始化了音频上下文', async () => {
      await evaluate(`
        (() => {
          window.__audioCtxCount = 0;
          const Orig = window.AudioContext || window.webkitAudioContext;
          if (Orig) {
            const Wrapped = function (...args) {
              window.__audioCtxCount += 1;
              return new Orig(...args);
            };
            Wrapped.prototype = Orig.prototype;
            window.AudioContext = Wrapped;
          }
          return true;
        })()
      `);
      await evaluate(`
        (() => {
          const cb = document.querySelector('.settings-panel input[aria-label="音效开关"]');
          if (cb && !cb.checked) cb.click();
          return true;
        })()
      `);
      await sleep(600);
      const audioCount = await evaluate<number>(`window.__audioCtxCount || 0`);
      verdict(audioCount >= 1, 'U12 音效开关打开 → 真的初始化了音频上下文', `AudioContext 创建次数=${audioCount}`);
      // 复原：关掉音效（后面不再关心）
      await evaluate(`
        (() => {
          const cb = document.querySelector('.settings-panel input[aria-label="音效开关"]');
          if (cb && cb.checked) cb.click();
          return true;
        })()
      `);
      await sleep(300);
      await clickText('.settings-panel button', '关闭', '关闭设置');
      await sleep(300);
    });

    /* ================================================================ */
    /* U6 / U7：棋谱抽屉                                              */
    /* ================================================================ */
    // 走一步自己的棋（我是黑方：e7 → e5）
    await evaluate(`
      (() => {
        const from = document.querySelector('.square[data-square="e7"]');
        if (from) from.click();
        return true;
      })()
    `);
    await sleep(400);
    await evaluate(`
      (() => {
        const to = document.querySelector('.square[data-square="e5"]');
        if (to) to.click();
        return true;
      })()
    `);
    let myMoveIn = false;
    try {
      await waitForExpr(
        `(() => {
          const b = document.querySelector('.notation-count');
          return !!b && parseInt(b.textContent || '0', 10) >= 2;
        })()`,
        '自己的这一步生效',
        20000,
      );
      myMoveIn = true;
    } catch {
      myMoveIn = false;
    }

    await step('U6', '「♟ 棋谱」按钮在快捷聊天右边、同一行', async () => {
      const geo = await evaluate<{ quick: Box | null; btn: Box | null }>(`
        (() => {
          const q = document.querySelector('.rail-quick');
          const b = document.querySelector('.rail-notation-btn');
          const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          };
          return { quick: rect(q), btn: rect(b) };
        })()
      `);
      const sameRow =
        geo.quick !== null &&
        geo.btn !== null &&
        geo.btn.x >= geo.quick.x + geo.quick.w - 2 &&
        geo.btn.y < geo.quick.y + geo.quick.h &&
        geo.btn.y + geo.btn.h > geo.quick.y;
      verdict(
        sameRow,
        'U6 「♟ 棋谱」按钮在快捷聊天右边、同一行',
        `快捷聊天=${JSON.stringify(geo.quick)}，棋谱按钮=${JSON.stringify(geo.btn)}`,
      );
    });

    await step('U7', '棋谱抽屉内容正确 + 复制 PGN', async () => {
      await clickSelector('.rail-notation-btn', '棋谱按钮');
      await waitForExpr(`!!document.querySelector('.notation-panel')`, '棋谱抽屉打开', 8000);
      const notation = await evaluate<{
        rows: number;
        text: string;
        badge: string;
        pgnBtn: boolean;
        pgnDisabled: boolean;
      }>(`
        (() => {
          const p = document.querySelector('.notation-panel');
          if (!p) return { rows: 0, text: '', badge: '', pgnBtn: false, pgnDisabled: false };
          const rows = p.querySelectorAll('.notation-row').length;
          const badge = document.querySelector('.notation-count');
          const btn = [...p.querySelectorAll('button')].find((b) => (b.textContent || '').includes('复制 PGN'));
          return {
            rows,
            text: (p.querySelector('.notation-list') || p).textContent || '',
            badge: badge ? badge.textContent || '' : '',
            pgnBtn: !!btn,
            pgnDisabled: btn ? btn.disabled : false,
          };
        })()
      `);
      const badgeNum = parseInt(notation.badge || '0', 10);
      const expectRows = Math.ceil(badgeNum / 2);
      verdict(
        myMoveIn &&
          notation.rows >= 1 &&
          notation.rows === expectRows &&
          notation.text.includes('e5') &&
          notation.pgnBtn &&
          !notation.pgnDisabled,
        'U7 棋谱抽屉内容正确（步数 / 回合行 / 真实 SAN / 复制 PGN）',
        `着法数=${badgeNum}，回合行=${notation.rows}（应 ${expectRows}），含 e5=${notation.text.includes('e5')}，复制按钮=${notation.pgnBtn}`,
      );
      await shot('u7-notation');

      // 点「复制 PGN」→ 真的写进剪贴板
      await evaluate(`
        (() => {
          window.__pgn = null;
          const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = async (text) => {
            window.__pgn = text;
            try { await orig(text); } catch { /* headless 里可能没权限，不影响判定 */ }
          };
          return true;
        })()
      `);
      await clickText('.notation-panel button', '复制 PGN', '复制 PGN');
      await sleep(800);
      const pgn = await evaluate<string>(`window.__pgn || ''`);
      verdict(
        pgn.includes('e5') && pgn.includes('[Event "') && pgn.includes('1.'),
        'U7 复制 PGN 真的写出了标准 PGN',
        `PGN 长度=${pgn.length}，前 80 字：${pgn.slice(0, 80).replace(/\n/g, '⏎')}`,
      );
    });

    /* ================================================================ */
    /* U8：棋谱抽屉与聊天弹层同一套样式                               */
    /* ================================================================ */
    // 先把宽屏下打开的棋谱抽屉关掉（否则下面那次点击会把它**收起**）
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.notation-panel button')]
          .find((b) => (b.textContent || '').includes('收起'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(400);

    await step('U8', '棋谱抽屉与聊天弹层同一套样式', async () => {
      await cdp!.send('Emulation.setDeviceMetricsOverride', {
        width: 430,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(900);
      const narrowOk = await evaluate<boolean>(`!!document.querySelector('.layout-narrow')`);
      if (!narrowOk) throw new Error('没能切到窄屏布局，无法对比');
      // 打开聊天弹层
      await clickSelector('.rail-chat', '聊天按钮');
      await waitForExpr(`!!document.querySelector('.chat-panel')`, '聊天弹层打开', 8000);
      // 打开棋谱抽屉
      await clickSelector('.rail-notation-btn', '棋谱按钮（窄屏）');
      await waitForExpr(`!!document.querySelector('.notation-panel')`, '棋谱抽屉打开（窄屏）', 8000);
      const styleCmp = await evaluate<{
        bg: [string, string];
        shadow: [string, string];
        headFont: [string, string];
        headPad: [string, string];
      }>(`
        (() => {
          const c = document.querySelector('.chat-panel');
          const n = document.querySelector('.notation-panel');
          if (!c || !n) return { bg: ['',''], shadow: ['',''], headFont: ['',''], headPad: ['',''] };
          const ch = document.querySelector('.chat-panel-head');
          const nh = document.querySelector('.notation-head');
          const ccs = getComputedStyle(c), ncs = getComputedStyle(n);
          return {
            bg: [ccs.backgroundColor, ncs.backgroundColor],
            shadow: [ccs.boxShadow, ncs.boxShadow],
            headFont: [ch ? getComputedStyle(ch).fontSize : '', nh ? getComputedStyle(nh).fontSize : ''],
            headPad: [ch ? getComputedStyle(ch).padding : '', nh ? getComputedStyle(nh).padding : ''],
          };
        })()
      `);
      const same =
        styleCmp.bg[0] === styleCmp.bg[1] &&
        styleCmp.shadow[0] === styleCmp.shadow[1] &&
        styleCmp.headFont[0] === styleCmp.headFont[1] &&
        styleCmp.headPad[0] === styleCmp.headPad[1];
      verdict(
        same,
        'U8 棋谱抽屉与聊天弹层同一套样式',
        `背景=${JSON.stringify(styleCmp.bg)} 阴影一致=${styleCmp.shadow[0] === styleCmp.shadow[1]} 头部字号=${JSON.stringify(styleCmp.headFont)} 头部内距=${JSON.stringify(styleCmp.headPad)}`,
      );
      await shot('u8-narrow');
      await cdp!.send('Emulation.clearDeviceMetricsOverride');
    });
    /* ================================================================ */
    /* U13：进不去房间 → 写明原因 + 返回大厅（刷新后卡死的真实故障）      */
    /* ================================================================ */
    await step('U13', '进不去房间时给出原因和「返回大厅」', async () => {
      /*
       * 造一个「对局已结束」的房间：甲开房 → 乙加入 → 甲认输。
       *
       * 然后让**浏览器**去进这个房间 —— 服务端会拒绝（对局已结束），
       * 页面必须给出**写明原因的错误卡片** + 一个能回大厅的出口。
       *
       * 这正是用户报告的故障：刷新后页面永远停在「正在进入房间…」，
       * 既不知道为什么进不去，也找不到出口。
       */
      const a = new GameClient(WS_URL);
      const b = new GameClient(WS_URL);
      let code = '';
      try {
        await a.ready();
        await b.ready();
        a.send({ t: 'hello', name: '甲' });
        await a.waitFor((m) => (m.t === 'session' ? m : null), '甲的 session');
        a.send({ t: 'room.create', timeControl: '30+0' });
        const roomMsg = await a.waitFor(
          (m) => (m.t === 'room' ? m : null),
          '甲的房间快照',
        );
        code = roomStateOf(roomMsg)?.code ?? '';
        if (!code) throw new Error('甲的房间快照里没有房间码');

        b.send({ t: 'hello', name: '乙' });
        await b.waitFor((m) => (m.t === 'session' ? m : null), '乙的 session');
        b.send({ t: 'room.join', code, mode: 'play' });
        /*
         * **抽签 + 准备**（新规则）：
         *   两人到齐 → 服务端抽签定黑白 → 房间进入「准备中」→ 双方都点「准备」→ 开局。
         * 不补这一步的话，房间永远停在「准备中」，下面等「对局开始」必然超时。
         */
        await b.waitFor(
          (m) => (m.t === 'room' && roomStateOf(m)?.status === 'preparing' ? m : null),
          '抽签完成（房间进入准备中）',
        );
        a.send({ t: 'ready' });
        b.send({ t: 'ready' });
        await b.waitFor(
          (m) => (m.t === 'room' && roomStateOf(m)?.status === 'playing' ? m : null),
          '对局开始',
        );
        a.send({ t: 'resign' });
        await a.waitFor(
          (m) => (m.t === 'room' && roomStateOf(m)?.status === 'finished' ? m : null),
          '对局结束',
        );
      } finally {
        a.close();
        b.close();
      }

      // 浏览器去这个「已结束」的房间
      await cdp!.send('Page.navigate', { url: `${APP_URL}/room/${code}` });
      await waitForExpr(`document.readyState === 'complete'`, '对局页加载', 20000);
      await waitForExpr(
        `[...document.querySelectorAll('h2')].some((h) => (h.textContent || '').includes('进不去这个房间'))`,
        '进不去房间的错误卡片',
        20000,
      );
      const cardText = await evaluate<string>(
        `document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)`,
      );
      const hasReason = cardText.includes('对局已结束');
      const hasBack = await evaluate<boolean>(
        `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('返回大厅'))`,
      );
      verdict(
        hasReason && hasBack,
        'U13 进不去房间时给出原因和「返回大厅」',
        `卡片文字：${cardText.slice(0, 100)}｜有原因=${hasReason} 有返回大厅=${hasBack}`,
      );
      await shot('u13-room-error-card');

      // 点「返回大厅」→ 真的回到大厅
      await clickText('button', '返回大厅', '返回大厅按钮');
      await waitForExpr(`location.pathname === '/'`, '回到大厅', 10000);
      await waitForExpr(
        `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
        '大厅页面',
        10000,
      );
      verdict(true, 'U13 点「返回大厅」真的回到大厅', `pathname=${await evaluate<string>('location.pathname')}`);

      /*
       * 再等一会儿：**别被弹回对局页**。
       *
       * 加入请求的结果 / 重连时服务端的自动恢复房间，都可能在点击之后才到。
       * 晚到的快照会把已经回到大厅的人又拽回棋盘 —— 同样叫「进退两难」，
       * 而且更难察觉（页面自己跳走了）。
       */
      await sleep(2500);
      const stillLobby = await evaluate<string>('location.pathname');
      verdict(
        stillLobby === '/',
        'U13 回大厅后不会被迟到的房间快照弹回对局页',
        `2.5 秒后 pathname=${stillLobby}`,
      );
      await shot('u13-back-to-lobby');
    });
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
