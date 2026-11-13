/**
 * UI 视觉门禁 —— 「去浏览器原生控件样式」+ 设计系统 v2 的落地面。
 *
 * 为什么单独一个脚本：
 *   这一轮是**整站视觉重构**（token / 字族 / 图标 / 控件 / 响应式），
 *   和「走子箭头看得见」（verify-move-arrow）、「设置弹窗能用」（verify-settings-ui）
 *   是不同主题。混在一起，任何一条失败都很难定位。
 *
 * 门禁清单（25 条，V1~V23）：
 *   V1  下拉框**接管原生外观**：appearance:none + 自绘 chevron（不是浏览器默认箭头）。
 *   V2  滑块**接管原生外观**：appearance:none + 自绘 thumb（不是系统凹槽）。
 *   V3  全站**没有字符图标**：♞ ⚙ 💬 ♟ ⚪ ⚫ … 一个都不许剩。
 *   V4  功能按钮用 **lucide SVG**：图标数量达标，且没有「光秃的图标按钮」。
 *   V5  签名元素「落子权标记」的**竖条**只出现在轮到走棋的那一行。
 *   V6  签名元素的**方块**在那一行是高亮的（靛蓝实心 + 光晕）。
 *   V7  **键盘焦点环可见**（Tab 走一遍有明确轮廓，不是「鼠标点完就没了」）。
 *   V8  **三断点真的生效**：1400 两栏 / 1000 一栏 / 800 一栏 + 窄屏间距收紧。
 *   V9  390 / 744 / 1280 三个宽度下都**没有横向滚动条**。
 *   V10 设置弹窗**不溢出视口**（窄屏下宽度 ≤ 视口宽）。
 *   V11 **toast 真的渲染**（右上、380px、错误类在 DOM 里）。
 *   V12 界面偏好滑块**真的生效**（--ui-density 变了，元素间距跟着变）。
 *   V13 **prefers-reduced-motion** 下动效关闭（呼吸标记不呼吸）。
 *   V14 图标按钮**都有可访问名**（aria-label 或 title），不是「一个孤零零的方块」。
 *
 *   V21 **上一页的 toast 不跨页残留**进对局页。
 *   V22 **设置弹窗底部留白**：滚到底后最后一项离面板底边 ≥ 16px，
 *       且底部渐隐层必须在、得是渐变、不挡点击、**高度与底部留白相等**。
 *   V23 设置弹窗底部**裁切是渐隐不是硬切**（像素差分：关掉渐隐层像素必须变）。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 *
 * 重要：**每条门禁的失败信息都必须带上自己的编号**（V1…V23）。
 *   变异测试靠「❌ 行里含门禁编号」判定「这一条被抓到了」——
 *   失败只印一句「等待超时」，变异脚本就分不清「门禁红了」还是「脚本崩了」，会出假绿。
 *
 * 用法：
 *   npx tsx scripts/verify-ui-style.ts [http://127.0.0.1:3000]
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
import { GameClient, sideOfName, waitPlaying, waitPreparing } from './lib/game-client';
import { UI_STYLE_GROUPS } from './lib/ui-style-groups';

/**
 * 地址怎么传：
 * - `--url=<地址>`（**推荐**，显式、不怕位置参数被别的开关顶掉）
 * - 位置参数（向后兼容，老调用方式还在用）
 *
 * 位置参数只取**第一个不像开关、且长得像 http 地址**的项 ——
 * 否则 `--group=chat` 会被当成地址，报出一堆看不懂的连接错误。
 */
function resolveUrl(argv: string[]): string {
  const explicit = argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  if (explicit) {
    if (!/^https?:\/\//.test(explicit)) {
      throw new Error(`--url= 后面不像地址：${explicit}`);
    }
    return explicit;
  }
  const positional = argv.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));
  return positional ?? 'http://127.0.0.1:3000';
}

const APP_URL = resolveUrl(process.argv.slice(2));

/**
 * 本次要跑哪几组门禁。
 * `null` = 全跑（默认）；`['chat']` = 只跑聊天组。
 */
const selectedGroups = parseGroupFilter(UI_STYLE_GROUPS, process.argv.slice(2));

/** 「这条门禁本次要不要跑」 */
const gateFilter = makeGateFilter(UI_STYLE_GROUPS, selectedGroups);

const OUT_DIR = join(process.cwd(), 'artifacts', 'ui-style');
const VIEW_W = 1600;
const VIEW_H = 1000;

/**
 * 门禁里**浏览器**的用户名。
 *
 * 它有两个用途，得是**同一个值**：
 *   ① 登录大厅时填进去；
 *   ② 抽签之后查「浏览器执白还是执黑」（`sideOfName` 按**座位名**找人）。
 * 写成两个地方各一份的字符串字面量，改了一处忘了另一处 =
 * 「查不到这个座位」→ 门禁红，但红得莫名其妙。
 */
const BROWSER_NAME = '视觉验收员';
/** 门禁里**对手**的用户名（用 GameClient 连进来的那个人） */
const OPPONENT_NAME = '对手甲';
/**
 * 门禁里**打字聊天**用的那句话。
 *
 * 它不只是 V16 的样本，还是 **V17 的差分基准** ——
 * 「快捷聊天不进记录、不留底」这条规则，只能靠「同一条通道上**一条进一条不进**」
 * 来量（只看「记录里没有它」是恒真断言：记录空着也「没有它」）。
 * 所以两处得用**同一个值**，各写一份字面量迟早对不上。
 */
const TYPED_CHAT_TEXT = '门禁测试消息甲';

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

/**
 * 本次**跳过**的门禁编号（不在 `--group=` 选中的组里）。
 *
 * 跳过**不算失败**：它只是「这次不查这一组」。
 * 但要在结尾报出来 —— 否则「跑 7 条全绿」会被误读成「23 条全绿」。
 */
const skipped: string[] = [];

function verdict(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

/**
 * 跑一条门禁；出错时**用它自己的编号**记一条 ❌，然后继续往下跑。
 *
 * **分组过滤**：不在本次 `--group=` 选中的组里的门禁，**连函数都不执行**
 * （执行了也是白跑 —— 页面状态白改一遍），直接记进 `skipped`。
 *
 * 没有编号的步骤（`准备 造一个对手…`）是**准备步骤**，任何分组下都跑 ——
 * 它负责把环境准备好，跳过它后面的门禁就没得测了。
 */
async function step<T>(
  id: string,
  label: string,
  fn: () => Promise<T>,
  detail: (v: T) => string = () => '',
): Promise<T | undefined> {
  if (!gateFilter(id)) {
    skipped.push(id);
    return undefined;
  }
  try {
    const v = await fn();
    verdict(true, `${id} ${label}`, detail(v));
    return v;
  } catch (e) {
    verdict(false, `${id} ${label}`, `执行出错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * 门禁用来**造一个对手**的游戏协议 ws 客户端 —— 现在**直接用共享的那份**
 * （`scripts/lib/game-client.ts`）。
 *
 * ## 为什么不自己再写一份
 *
 * 原来的副本只知道「连上、收发报文」，而**抽签 + 准备**这套新规则需要三样它没有的东西：
 *   · `msgCount` / `latestRoom()` —— 取「从哪一条消息往后看」的起点、
 *     以及查最新一份房间快照（要知道浏览器抽到了白还是黑）；
 *   · `waitPreparing()` / `waitPlaying()` —— 等抽签完成、等双方准备完开局；
 *   · `sideOfName()` —— 按**名字**查某人执哪一边。
 *
 * 复制一份就意味着这些能力要抄两遍 —— 抄漏一处，门禁就会在**旧规则**下
 * 静悄悄地跑（看着全绿，其实测的不是现在这套流程）。
 * 共享助手是**只读**的：它已经知道新规则长什么样。
 *
 * 为什么非得有「对手」：签名元素「落子权标记」只在**对局进行中**才出现
 * （`isTurn` 要求 `roomState.status === 'playing'`）。
 * 一个人开的房状态是「等待对手」，标记不出现 —— 门禁就永远量不到它。
 */

/** 页面里注入的通用工具：算对比度、读元素盒模型。 */
const PAGE_HELPERS = `
  window.__v = {
    srgb(c) {
      const m = String(c).match(/[\\d.]+/g);
      if (!m) return null;
      return [Number(m[0]), Number(m[1]), Number(m[2])];
    },
    lum(rgb) {
      const f = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    },
    ratio(a, b) {
      const la = this.lum(a), lb = this.lum(b);
      if (la === null || lb === null) return 0;
      const hi = Math.max(la, lb), lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    },
    bgOf(el) {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const rgb = this.srgb(c);
        const alpha = String(c).match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/);
        if (rgb && (!alpha || Number(alpha[1]) > 0.9)) return rgb;
        n = n.parentElement;
      }
      return this.srgb(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
    },
    rect(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
  };
  true;
`;

/** V22 用的：设置弹窗的盒模型快照 */
interface SettingsBox {
  missing: boolean;
  scrollTop: number;
  scrollH: number;
  clientH: number;
  /** 滚动区是否已经滚到底 */
  atEnd: boolean;
  /** 最后一项的底边 → 滚动区底边的距离（就是底部留白） */
  gap: number;
  panelBottom: number;
  viewH: number;
  /** `.settings-body` 的下内边距 */
  padBottom: number;
  /** `.settings-panel::after`（底部渐隐层）的计算样式 */
  fadeContent: string;
  fadeH: number;
  fadeImage: string;
  fadePointer: string;
}

/** V23 用的：两张截图的像素差分结果 */
interface FadeDelta {
  error?: string;
  /** 渐隐打开后比关掉时亮了多少（取全区域最大） */
  maxDelta: number;
  /** 被渐隐洗亮的像素个数 */
  changed: number;
  w: number;
  h: number;
}

/**
 * 页面内使用的脚本：把两张截图解码成像素，比「有渐隐」和「没渐隐」的差别。
 *
 * 为什么在页面里解码：不想为了数像素引入 PNG 解码依赖 ——
 * 浏览器自己会解码（`createImageBitmap` + `OffscreenCanvas`），
 * 和 `verify-3d-viewport.ts` 用的是同一套路。
 *
 * `region` 是**设备像素**坐标（这张截图里要比的那一块）。
 * 返回的 `maxDelta` 是「渐隐打开后比关掉时亮了多少」：
 * 渐隐层没生效 → 两张图一模一样 → 0。
 */
const FADE_DELTA_FN = `
async (b64A, b64B, region) => {
  const load = async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, d: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
  };
  const A = await load(b64A);
  const B = await load(b64B);
  if (A.w !== B.w || A.h !== B.h) {
    return { error: '两次截图尺寸不一致', maxDelta: 0, changed: 0, w: A.w, h: A.h };
  }
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(A.w, x0 + Math.round(region.w));
  const y1 = Math.min(A.h, y0 + Math.round(region.h));
  if (x1 <= x0 || y1 <= y0) {
    return { error: '要比的区域不在截图里', maxDelta: 0, changed: 0, w: A.w, h: A.h };
  }
  let maxDelta = 0, changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.w + x) * 4;
      const la = 0.2126 * A.d[i] + 0.7152 * A.d[i + 1] + 0.0722 * A.d[i + 2];
      const lb = 0.2126 * B.d[i] + 0.7152 * B.d[i + 1] + 0.0722 * B.d[i + 2];
      const delta = la - lb;   // 渐隐打开(A) 应当比关掉(B) 更亮
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 12) changed += 1;
    }
  }
  return { maxDelta: Math.round(maxDelta), changed, w: A.w, h: A.h };
}
`;

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.error('❌ 未找到 Chromium。请设置 CHROMIUM_PATH 环境变量。');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Chromium: ${chromium}`);
  console.log(`输出目录：${OUT_DIR}\n`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-uistyle-'));
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

    /**
     * 点「准备」按钮 —— **抽签之后、正式开局之前**，真人对局双方各点一次。
     *
     * ## 为什么不能直接用 `clickText`
     *
     * `clickText` 是**包含**匹配（`textContent.includes(text)`），
     * 而点了之后按钮会变成「**已准备**」并且 `disabled` ——
     * 「已准备」也包含「准备」，用包含匹配会挑到一个**点不动**的按钮，
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
        throw new Error('点不到「准备」按钮（.hud-actions 里没有可点的「准备」）');
      }
    };

    /**
     * 打开「加入房间」面板（幂等）。
     *
     * **不能盲点那个 tab**：它是**切换**的 —— 面板已经开着的时候再点一下会把它关掉。
     * V11 先开过这个面板（它要用房间码输入框造服务端的错因），
     * V20 再盲点一次就把它关了，于是 V20 等 `#roomcode` 等到超时 ——
     * 而报错只有一句「等待超时」，完全看不出是「上一步把面板关了」。
     */
    const ensureJoinPanel = async (): Promise<void> => {
      const alreadyOpen = await evaluate<boolean>(`!!document.querySelector('#roomcode')`);
      if (alreadyOpen) return;
      await clickText('button', '加入房间', '「加入房间」按钮');
      await waitForExpr(`!!document.querySelector('#roomcode')`, '房间码输入框');
    };

    /** 设一个视口宽度（并等一帧，让媒体查询生效） */
    const setViewport = async (width: number, height = 900): Promise<void> => {
      await cdp!.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(350);
    };

    /* ================================================================ */
    /* 准备：进大厅                                                    */
    /* ================================================================ */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W,
      height: VIEW_H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(500);
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
      '「人机对弈」按钮',
    );
    // 注入页面工具（对比度 / 盒模型）
    await evaluate(PAGE_HELPERS);
    await shot('01-lobby-wide');

    /* ================================================================ */
    /* V1：下拉框不是原生控件（自绘 Picker）                            */
    /* ================================================================ */
    /*
     * 原来这条查的是「原生 `<select>` 有没有被 appearance:none 接管」。
     * 现在大厅里**已经没有原生 select 了**（原生下拉的展开列表仍是系统绘制的，
     * 样式根本不受控），换成自绘的 `Picker` 组件。
     *
     * 判据跟着换成新控件的等价性质：
     *   ① 页面上**一个** `<select>` 都不能有（不能又冒出来一个原生的）；
     *   ② 自绘下拉要真的在页面上（触发器 + 展开后的选项列表）；
     *   ③ 选项不是浏览器画的 —— 是我们自己的按钮 + lucide 勾选标记。
     */
    await step('V1', '下拉框是自绘的（没有原生 select，Picker 自己画）', async () => {
      await clickText('button', '人机对弈', '「人机对弈」按钮');
      await waitForExpr(`!!document.querySelector('.picker-trigger')`, '自绘下拉触发器');
      const r = await evaluate<{ selects: number; triggers: number; options: string[] }>(`
        (() => {
          const triggers = [...document.querySelectorAll('.picker-trigger')];
          const trigger = triggers[0];
          if (trigger) trigger.click();
          return {
            selects: document.querySelectorAll('select').length,
            triggers: triggers.length,
            options: [...document.querySelectorAll('.picker-menu [role="option"]')].map((el) =>
              (el.textContent || '').trim(),
            ),
          };
        })()
      `);
      if (r.selects > 0) throw new Error(`页面上还有 ${r.selects} 个原生 <select>`);
      if (r.triggers === 0) throw new Error('页面上没有自绘下拉（.picker-trigger）');
      await waitForExpr(
        `document.querySelectorAll('.picker-menu [role="option"]').length > 0`,
        '下拉展开后的选项列表',
      );
      const opt = await evaluate<{ count: number; svg: number; text: string }>(`
        (() => {
          const els = [...document.querySelectorAll('.picker-menu [role="option"]')];
          return {
            count: els.length,
            svg: els[0] ? els[0].querySelectorAll('svg.lucide').length : 0,
            text: els[0] ? (els[0].textContent || '').trim() : '',
          };
        })()
      `);
      if (opt.count === 0) throw new Error('下拉展开后一个选项都没有');
      if (!opt.text) throw new Error('选项没有文字');
      // 选中项自带一个 lucide 勾选标记（选中态是我们自己画的，不是浏览器画的）
      const ticked = await evaluate<number>(
        `document.querySelectorAll('.picker-menu .picker-tick').length`,
      );
      if (ticked < 1) throw new Error('选中的选项没有自绘勾选标记');
      // 收起浮层，别把后面的步骤挡在下面
      await evaluate(`
        (() => {
          const t = document.querySelector('.picker-trigger');
          if (t) t.click();
          return true;
        })()
      `);
      await sleep(200);
    });

    /* ================================================================ */
    /* V3：全站没有字符图标                                            */
    /* ================================================================ */
    await step('V3', '全站没有字符图标（♞ ⚙ 💬 ♟ ⚪ ⚫ 等）', async () => {
      const r = await evaluate<{ hits: string[] }>(`
        (() => {
          const BANNED = ['♞','♟','⚙','💬','⚪','⚫','♔','♕','♖','♗','♘','♙','♚','⚡','♜','♝'];
          const hits = [];
          const scan = (text, where) => {
            for (const ch of BANNED) {
              if (text.includes(ch)) hits.push(where + ' 含 ' + ch);
            }
          };
          scan(document.body.innerText || '', 'body');
          document.querySelectorAll('button, a, [role="button"]').forEach((el, i) => {
            scan(el.textContent || '', '按钮#' + i);
          });
          return { hits };
        })()
      `);
      if (r.hits.length) throw new Error(`还有字符图标没换掉：${r.hits.slice(0, 6).join('；')}`);
    });

    /* ================================================================ */
    /* V4：功能按钮用 lucide 图标                                      */
    /* ================================================================ */
    await step('V4', '功能按钮用 lucide SVG 图标', async () => {
      const r = await evaluate<{ icons: number; foreign: string[]; orphanButtons: string[] }>(`
        (() => {
          const icons = document.querySelectorAll('svg.lucide').length;
          /*
           * **所有** svg 都得是 lucide 组件。
           * 手写一个裸 <svg> 顶替图标库，外观能对上，但尺寸/描边/无障碍全不受控 ——
           * 这正是「图标系统只做了一半」的典型形态。
           */
          const foreign = [];
          document.querySelectorAll('svg').forEach((el, i) => {
            if (!el.classList.contains('lucide')) {
              foreign.push('#' + i + ' ' + el.outerHTML.slice(0, 60));
            }
          });
          const orphanButtons = [];
          document.querySelectorAll('button').forEach((el) => {
            const text = (el.innerText || '').trim();
            const hasSvg = !!el.querySelector('svg');
            const named = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            // 「只有图标、没有名字」= 光秃按钮，读屏用户完全不知道它是干嘛的
            if (!text && !named) orphanButtons.push(el.className || '(无 class)');
          });
          return { icons, foreign, orphanButtons };
        })()
      `);
      if (r.icons < 3) throw new Error(`lucide 图标只有 ${r.icons} 个（至少 3 个），图标系统没铺开`);
      if (r.foreign.length) {
        throw new Error(`有手写的裸 svg（不是 lucide 组件）：${r.foreign.slice(0, 3).join('；')}`);
      }
      if (r.orphanButtons.length) {
        throw new Error(`有光秃按钮（无文字也无 aria-label）：${r.orphanButtons.join('；')}`);
      }
    });

    /* ================================================================ */
    /* V2：滑块接管原生外观                                            */
    /* ================================================================ */
    await step('V2', '滑块接管原生外观（appearance:none + 自绘 thumb）', async () => {
      await clickSelector('header button[aria-label="设置"]', '设置齿轮');
      await waitForExpr(`!!document.querySelector('.settings-panel')`, '设置弹窗');
      const r = await evaluate<{ count: number; bad: string[]; thumbRules: number }>(`
        (() => {
          const els = [...document.querySelectorAll('input.settings-range')];
          const bad = [];
          for (const el of els) {
            const cs = getComputedStyle(el);
            const app = cs.appearance || cs.webkitAppearance || '';
            if (app !== 'none') bad.push((el.getAttribute('aria-label') || '') + ': appearance=' + app);
          }
          /*
           * 「thumb 自绘」走 **CSSOM**，不走 getComputedStyle(el, '::-webkit-slider-thumb')：
           * Chrome 对滑块伪元素返回的计算样式是空的（拿到的是 rgba(0,0,0,0)），
           * 用它判定必然假红。
           *
           * 改成直接问「加载中的样式表里，有没有给 thumb 画了底色」——
           * 这才是「接管了原生外观」的真实含义：系统默认滑块是灰白凹槽，
           * 我们画了自己的圆形滑块。
           */
          let thumbRules = 0;
          const baseRules = [];
          const visit = (rules) => {
            for (const rule of rules) {
              /*
               * 顺序不能反：Chrome 支持 CSS 嵌套后，**CSSStyleRule 也有 cssRules**
               * （空的 CSSRuleList，但它是 truthy）。
               * 先判 cssRules 会把每一条普通样式规则都当成容器跳过去 —— 一条都读不到。
               * 所以先看 selectorText：有就是样式规则，没有才是容器规则（@media 之类）。
               */
              const sel = rule.selectorText || '';
              if (!sel) {
                if (rule.cssRules) visit(rule.cssRules);
                continue;
              }
              if (!/slider-thumb/.test(sel)) continue;
              thumbRules += 1;
              /*
               * 只查**基础规则**：:focus-visible / :hover 这类变体是叠加效果
               * （比如焦点环），本来就不画底色。要求变体也画底色是判错了对象。
               */
              if (/:(focus-visible|hover|active|disabled)/.test(sel)) continue;
              baseRules.push(sel);
              const bg = rule.style.background || rule.style.backgroundColor || '';
              const isNone = !bg || bg === 'transparent' || bg === 'none' || bg === 'rgba(0, 0, 0, 0)';
              if (isNone) bad.push(sel + ': thumb 没有底色');
              if (!/appearance/.test(rule.style.cssText)) {
                bad.push(sel + ': thumb 没关掉原生外观（缺 appearance）');
              }
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try { visit(sheet.cssRules); } catch { /* 跨域样式表读不了，跳过 */ }
          }
          if (thumbRules === 0) bad.push('样式表里根本没有滑块 thumb 规则（滑块是系统默认外观）');
          /*
           * 只查 webkit 一套：**Chrome 的 CSSOM 会直接丢掉它不认识的 ::-moz-* 规则**，
           * 在 Chromium 里根本读不到 Firefox 那套，写进判据就是永远假红。
           * Firefox 那套规则由代码评审保证存在，这里不重复断言。
           */
          const webkitBase = baseRules.filter((x) => x.includes('-webkit-slider-thumb'));
          if (webkitBase.length === 0) bad.push('没有 ::-webkit-slider-thumb 基础规则（Chrome 下是系统默认外观）');
          return { count: els.length, bad, thumbRules };
        })()
      `);
      if (r.count === 0) throw new Error('设置弹窗里一个滑块都没有');
      if (r.bad.length) throw new Error(`滑块仍是原生外观：${r.bad.join('；')}`);
    });

    /* ================================================================ */
    /* V10：设置弹窗不溢出视口                                         */
    /* ================================================================ */
    await step('V10', '设置弹窗不溢出视口（窄屏下宽度 ≤ 视口宽）', async () => {
      await setViewport(390, 844);
      await sleep(300);
      const r = await evaluate<{ vw: number; panel: { w: number; left: number } | null }>(`
        (() => {
          const el = document.querySelector('.settings-panel');
          if (!el) return { vw: window.innerWidth, panel: null };
          const r = el.getBoundingClientRect();
          return { vw: window.innerWidth, panel: { w: r.width, left: r.left } };
        })()
      `);
      if (!r.panel) throw new Error('窄屏下设置弹窗不见了');
      if (r.panel.w > r.vw + 1) {
        throw new Error(`弹窗宽 ${r.panel.w.toFixed(1)}px > 视口宽 ${r.vw}px（会横向溢出）`);
      }
      if (r.panel.left < -1) {
        throw new Error(`弹窗左边缘 ${r.panel.left.toFixed(1)}px，超出视口左侧`);
      }
      await setViewport(VIEW_W, VIEW_H);
    });

    /* ================================================================ */
    /* V12：界面偏好滑块真的生效                                       */
    /* ================================================================ */
    await step('V12', '界面偏好滑块真的生效（--ui-density 变了 + 间距跟着变）', async () => {
      const before = await evaluate<{ var: string; pad: number }>(`
        (() => {
          const card = document.querySelector('.card');
          return {
            var: getComputedStyle(document.documentElement).getPropertyValue('--ui-density').trim(),
            pad: card ? parseFloat(getComputedStyle(card).paddingTop) : -1,
          };
        })()
      `);
      await evaluate(`
        (() => {
          const el = document.querySelector('input.settings-range[aria-label="界面密度"]');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, '0.85');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(400);
      const after = await evaluate<{ var: string; pad: number }>(`
        (() => {
          const card = document.querySelector('.card');
          return {
            var: getComputedStyle(document.documentElement).getPropertyValue('--ui-density').trim(),
            pad: card ? parseFloat(getComputedStyle(card).paddingTop) : -1,
          };
        })()
      `);
      if (after.var === before.var || after.var === '') {
        throw new Error(`拖动密度滑块后 --ui-density 没变（${before.var} → ${after.var}）`);
      }
      if (Math.abs(after.pad - before.pad) < 0.5) {
        throw new Error(`--ui-density 变了但卡片间距没跟着变（${before.pad}px → ${after.pad}px）`);
      }
      // 还原
      await evaluate(`
        (() => {
          const el = document.querySelector('input.settings-range[aria-label="界面密度"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, '1');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(250);
    });

    /* ================================================================ */
    /* V22：设置弹窗底部留白 + 渐隐层几何                              */
    /* ================================================================ */
    /*
     * 用户反馈：「感觉这个设置弹窗还需要一个内边距啊你不觉得吗，特别是下面」。
     *
     * 原来的样子：内容比面板高，**底部的留白整个被裁在可视区外** ——
     * 最后一行直接顶在面板下边缘，看着像「被裁坏了」。
     *
     * 这条门禁钉住四件事：
     *   ① 滚到底之后，最后一项离面板底边**必须**还有 ≥ 16px 留白；
     *   ② 底部渐隐层**必须存在**（有内容、有渐变、不挡点击）；
     *   ③ 渐隐层的高度与底部留白**必须相等** ——
     *      不等就会出现「滚到底了底下还在发白」或者「留白被吃掉」；
     *   ④ 弹窗本身不许溢出视口。
     */
    await step('V22', '设置弹窗底部留白（滚到底后最后一项离底边 ≥ 16px）', async () => {
      /** 读一次弹窗的盒模型（顺便读底部渐隐层） */
      const readBox = async (): Promise<SettingsBox> =>
        evaluate<SettingsBox>(`
          (() => {
            const panel = document.querySelector('.settings-panel');
            const body = document.querySelector('.settings-body');
            if (!panel || !body) return { missing: true };
            const rows = [...body.querySelectorAll('.settings-row')];
            const last = rows[rows.length - 1];
            const br = body.getBoundingClientRect();
            const lr = last ? last.getBoundingClientRect() : null;
            const pr = panel.getBoundingClientRect();
            const cs = getComputedStyle(body);
            const after = getComputedStyle(panel, '::after');
            return {
              missing: false,
              scrollTop: body.scrollTop,
              scrollH: body.scrollHeight,
              clientH: body.clientHeight,
              atEnd: body.scrollTop + body.clientHeight >= body.scrollHeight - 1,
              gap: lr ? br.bottom - lr.bottom : -1,
              panelBottom: pr.bottom,
              viewH: window.innerHeight,
              padBottom: parseFloat(cs.paddingBottom),
              fadeContent: after.content,
              fadeH: parseFloat(after.height),
              fadeImage: after.backgroundImage || '',
              fadePointer: after.pointerEvents,
            };
          })()
        `);

      /** 把滚动区滚到底 */
      const scrollToEnd = async (): Promise<void> => {
        await evaluate(`
          (() => {
            const b = document.querySelector('.settings-body');
            b.scrollTop = b.scrollHeight;
            return true;
          })()
        `);
        await sleep(200);
      };

      // —— ① 标准视口：弹窗放得下，底部留白必须看得见 ——
      await setViewport(VIEW_W, VIEW_H);
      await sleep(250);
      const wide = await readBox();
      if (wide.missing) throw new Error('设置弹窗没开（前面的门禁应该已经把它点开了）');
      if (wide.panelBottom > wide.viewH - 8) {
        throw new Error(
          `弹窗底边 ${wide.panelBottom.toFixed(1)}px 超出视口（视口高 ${wide.viewH}px）`,
        );
      }
      await scrollToEnd();
      const wideEnd = await readBox();
      if (!wideEnd.atEnd) {
        throw new Error('设置弹窗的滚动区滚不到底（scrollTop + clientHeight < scrollHeight）');
      }
      if (wideEnd.gap < 16) {
        throw new Error(
          `滚到底后最后一项离面板底边只剩 ${wideEnd.gap.toFixed(1)}px（要求 ≥ 16px 的底部留白）`,
        );
      }

      // —— ② 底部渐隐层：必须在、得是渐变、不能挡点击、高度得和留白一样 ——
      if (wideEnd.fadeContent === 'none' || wideEnd.fadeContent === 'normal') {
        throw new Error('设置弹窗没有底部渐隐层（.settings-panel::after 没有 content）');
      }
      if (!/gradient/.test(wideEnd.fadeImage)) {
        throw new Error(`底部渐隐层不是渐变（background-image = ${wideEnd.fadeImage}）`);
      }
      /*
       * 方向：渐变必须**从上到下**（顶部透明 → 底部面板色）。
       *
       * Chrome 会把 `to bottom`（默认值）和 `180deg` **归一化掉** ——
       * 计算值里干脆不写方向；而反方向（`to top` / `0deg` / `90deg`）会留着。
       * 所以判据是「计算值里**不许出现方向**」：
       * 出现方向 = 不是默认的向下 = 底边不会被洗白 = 硬切又回来了。
       */
      if (/\bto\s|\ddeg/.test(wideEnd.fadeImage)) {
        throw new Error(`底部渐隐层方向不对（background-image = ${wideEnd.fadeImage}）`);
      }
      if (wideEnd.fadePointer !== 'none') {
        throw new Error(`底部渐隐层会挡住点击（pointer-events = ${wideEnd.fadePointer}）`);
      }
      if (!(wideEnd.fadeH > 0) || Math.abs(wideEnd.fadeH - wideEnd.padBottom) > 0.5) {
        throw new Error(
          `底部渐隐层高度 ${wideEnd.fadeH}px 与底部留白 ${wideEnd.padBottom}px 不一致 —— ` +
            `滚到底时渐隐要么盖住内容，要么留白被吃掉`,
        );
      }

      // —— ③ 矮视口：内容放不下时，弹窗不许溢出视口，滚到底也还得有留白 ——
      await setViewport(1600, 560);
      await sleep(300);
      const short = await readBox();
      if (short.panelBottom > short.viewH - 4) {
        throw new Error(
          `矮屏下弹窗底边 ${short.panelBottom.toFixed(1)}px 溢出视口（视口高 ${short.viewH}px）`,
        );
      }
      if (short.scrollH > short.clientH + 1) {
        await scrollToEnd();
        const shortEnd = await readBox();
        if (!shortEnd.atEnd) throw new Error('矮屏下滚动区滚不到底');
        if (shortEnd.gap < 16) {
          throw new Error(`矮屏下滚到底后留白只剩 ${shortEnd.gap.toFixed(1)}px（要求 ≥ 16px）`);
        }
      }
      await setViewport(VIEW_W, VIEW_H);
      await sleep(200);
    });

    /* ================================================================ */
    /* V23：底部裁切是渐隐，不是硬切（像素差分）                       */
    /* ================================================================ */
    /*
     * V22 量的是**几何**（留白够不够、渐隐层在不在）。
     * 这条量的是**画出来的效果**：渐隐层到底有没有真的把底边那截内容洗白。
     *
     * 做法是**差分**：同一屏截两张 —— 一张带渐隐层，一张把渐隐层 `display:none` 掉 ——
     * 然后比像素。渐隐层要是没生效（被删了、写反了、高度对不上），
     * 两张图会一模一样 → 差值 0 → 门禁红。
     *
     * 差分比「截一张看底边有没有黑字」稳得多：字的具体位置、字号、字重变了都不会假红，
     * 只有「渐隐真的起作用 / 没起作用」这一件事会体现在差值上。
     */
    await step('V23', '设置弹窗底部是渐隐不是硬切（关掉渐隐层像素必须变）', async () => {
      await setViewport(1600, 560);
      await sleep(300);
      const region = await evaluate<{ x: number; y: number; w: number; h: number } | { error: string } | null>(`
        (() => {
          const panel = document.querySelector('.settings-panel');
          const body = document.querySelector('.settings-body');
          if (!panel || !body) return null;
          const hints = [...body.querySelectorAll('.settings-hint')];
          const target = hints[hints.length - 1];
          if (!target) return null;
          /*
           * 把最后一条说明文字挪到**裁切线上**（它的底边落到可视区底边下方 4px）——
           * 裁切处得真的有字，否则「渐隐有没有用」根本无从比较。
           *
           * 挪不到就说明这个测试前提不成立（内容布局变了），
           * 这种情况必须报错，不能悄悄放过 —— 放过就是假绿。
           */
          const br = body.getBoundingClientRect();
          const tr = target.getBoundingClientRect();
          body.scrollTop += tr.bottom - (br.bottom + 4);
          const br2 = body.getBoundingClientRect();
          const tr2 = target.getBoundingClientRect();
          const off = tr2.bottom - br2.bottom;
          if (off < -12 || off > 12) return { error: 'setup' };
          const pr = panel.getBoundingClientRect();
          return {
            x: Math.round(pr.left),
            y: Math.round(pr.bottom - 40),
            w: Math.round(pr.width),
            h: 40,
          };
        })()
      `);
      if (!region) throw new Error('设置弹窗没开，或者里面一条说明文字都没有');
      if ('error' in region && region.error === 'setup') {
        throw new Error('测试前提不成立：没能把说明文字挪到底边（内容布局变了？）');
      }

      const dpr = await evaluate<number>('window.devicePixelRatio || 1');
      if (Math.abs(dpr - 1) > 0.01) {
        throw new Error(`门禁要求 devicePixelRatio = 1，实际 ${dpr}`);
      }
      const view = await evaluate<{ w: number; h: number }>(`
        ({ w: window.innerWidth, h: window.innerHeight })
      `);

      const shotA = await cdp!.send('Page.captureScreenshot', { format: 'png' });
      await evaluate(`
        (() => {
          const st = document.createElement('style');
          st.id = '__gate_fade_off';
          st.textContent = '.settings-panel::after { display: none !important; }';
          document.head.appendChild(st);
          return true;
        })()
      `);
      await sleep(300);
      const shotB = await cdp!.send('Page.captureScreenshot', { format: 'png' });
      await evaluate(`
        (() => {
          const st = document.getElementById('__gate_fade_off');
          if (st) st.remove();
          return true;
        })()
      `);

      const r = await evaluate<FadeDelta>(
        `(${FADE_DELTA_FN})(${JSON.stringify(shotA.data)}, ${JSON.stringify(shotB.data)}, ${JSON.stringify(region)})`,
        true,
      );
      if (r.error) throw new Error(r.error);
      if (r.w !== view.w || r.h !== view.h) {
        throw new Error(`截图尺寸 ${r.w}×${r.h} 与视口 ${view.w}×${view.h} 不一致（截的不是当前视口）`);
      }
      if (r.maxDelta < 40) {
        throw new Error(
          `底部渐隐层没起作用：把它关掉后像素最大亮度差只有 ${r.maxDelta}（阈值 40）`,
        );
      }
      if (r.changed < 20) {
        throw new Error(
          `底部渐隐层影响的面太小：关掉它只有 ${r.changed} 个像素变亮（阈值 20）`,
        );
      }
      await setViewport(VIEW_W, VIEW_H);
      await sleep(200);
    });

    /* ================================================================ */
    /* V11：toast 真的渲染                                             */
    /* ================================================================ */
    await step('V11', 'toast 真的渲染（右上 380px + 错误类在 DOM 里）', async () => {
      /*
       * 设置弹窗**可能没开** —— 本次若只跑 `notice` 组，V10（开弹窗那条）会被跳过。
       * 所以这里是「**有才关**」，不是「必须能点到」。
       */
      await evaluate(`
        (() => {
          const b = document.querySelector('.settings-head button');
          if (!b) return false;
          b.click();
          return true;
        })()
      `);
      await sleep(300);
      /*
       * 造一条**后端**的错误 toast：填一个 4 位但根本不存在的房间码 →
       * 服务端回「房间不存在」。
       *
       * 原来这里填的是 'AB'（长度不对），靠大厅的**表单校验**弹 toast。
       * 但表单校验错误已经改成**常驻在字段旁边**的 `.field-error` 了
       * （V20 守着这条），再拿它造 toast 就等于让两条门禁互相依赖 ——
       * V11 变红只说明 V20 的改动还在，实际上 toast 通道可能好好的。
       *
       * 换成服务端错因，正好也是 V11 本来的考点：**后端原话原样透出**。
       */
      // 房间码输入框在「加入房间」面板里 —— 先把那块打开（幂等，见 ensureJoinPanel）
      await ensureJoinPanel();
      await evaluate(`
        (() => {
          const el = document.querySelector('input#roomcode');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, 'ZZZZ');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(200);
      await clickText('button', '确定', '「确定」按钮');
      await waitForExpr(`!!document.querySelector('.toast-error')`, '错误 toast');
      const r = await evaluate<{ w: number; right: number; top: number; text: string }>(`
        (() => {
          const el = document.querySelector('.toast-error');
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            w: rect.width,
            right: window.innerWidth - rect.right,
            top: rect.top,
            text: (el.textContent || '').trim(),
          };
        })()
      `);
      if (r.w < 340 || r.w > 400) {
        throw new Error(`toast 宽 ${r.w.toFixed(1)}px，不在 380px 附近`);
      }
      if (r.right > 40) throw new Error(`toast 不在右上角（右边距 ${r.right.toFixed(1)}px）`);
      if (r.top > 120) throw new Error(`toast 不在顶部（top ${r.top.toFixed(1)}px）`);
      if (!r.text.includes('房间不存在')) {
        throw new Error(`toast 没有透出后端错因（原文：${r.text}）`);
      }
    });

    /* ================================================================ */
    /* V7：键盘焦点环可见                                              */
    /* ================================================================ */
    await step('V7', '键盘焦点环可见（Tab 走一遍有明确轮廓）', async () => {
      /*
       * 必须用**真键盘事件**走 Tab，不能用 el.focus()。
       *
       * 原因：Chrome 的 :focus-visible 只在「焦点是键盘移动来的」时命中。
       * 程序化 .focus() 拿到的是初始值（outline-style: none / width: 3px=medium），
       * 用它判定必然假红 —— 之前就踩过这一脚。
       */
      await cdp!.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp!.send('Page.bringToFront');
      await evaluate(`document.body.focus(); true`);

      let seen = '';
      for (let i = 0; i < 12; i += 1) {
        await cdp!.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        await cdp!.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        await sleep(120);
        const r = await evaluate<{ tag: string; cls: string; style: string; width: number }>(`
          (() => {
            const el = document.activeElement;
            if (!el || el === document.body) return { tag: '', cls: '', style: '', width: 0 };
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName,
              cls: el.className || '',
              style: cs.outlineStyle,
              width: parseFloat(cs.outlineWidth) || 0,
            };
          })()
        `);
        if (r.style !== 'none' && r.width >= 1.5) {
          seen = `${r.tag}.${String(r.cls).split(' ').join('.')}`;
          break;
        }
      }
      await cdp!.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      if (!seen) {
        throw new Error('Tab 走了一轮，没有任何一个焦点元素出现可见轮廓（outline 全是 none）');
      }
      return `焦点元素 ${seen} 有可见轮廓`;
    });

    /* ================================================================ */
    /* V8：三断点真的生效                                              */
    /* ================================================================ */
    await step('V8', '三断点真的生效（1400 两栏 / 1000 一栏 / 800 一栏 + 窄屏收紧）', async () => {
      const colCount = async (w: number): Promise<number> => {
        await setViewport(w, 900);
        const cols = await evaluate<string>(
          `getComputedStyle(document.querySelector('.lobby-grid')).gridTemplateColumns`,
        );
        return cols.trim().split(/\s+/).filter(Boolean).length;
      };
      const wide = await colCount(1400);
      const medium = await colCount(1000);
      const narrow = await colCount(800);
      if (wide !== 2) throw new Error(`1400px 下大厅不是两栏（${wide} 栏）`);
      if (medium !== 1) throw new Error(`1000px 下大厅不是一栏（${medium} 栏）`);
      if (narrow !== 1) throw new Error(`800px 下大厅不是一栏（${narrow} 栏）`);
      // 窄屏（<900）要把布局间距收紧
      await setViewport(800, 900);
      const gapNarrow = await evaluate<string>(
        `getComputedStyle(document.documentElement).getPropertyValue('--layout-gap').trim()`,
      );
      await setViewport(1400, 900);
      const gapWide = await evaluate<string>(
        `getComputedStyle(document.documentElement).getPropertyValue('--layout-gap').trim()`,
      );
      if (gapNarrow === gapWide) {
        throw new Error(`窄屏没有收紧间距（--layout-gap 两档都是 ${gapNarrow}）`);
      }
      await setViewport(VIEW_W, VIEW_H);
    });

    /* ================================================================ */
    /* V9：三个宽度下都没有横向滚动条                                   */
    /* ================================================================ */
    await step('V9', '390 / 744 / 1280 三个宽度下都没有横向滚动条', async () => {
      for (const w of [390, 744, 1280]) {
        await setViewport(w, 900);
        const r = await evaluate<{ sw: number; bw: number; iw: number }>(`
          (() => ({
            sw: document.documentElement.scrollWidth,
            bw: document.body.scrollWidth,
            iw: window.innerWidth,
          }))()
        `);
        const over = Math.max(r.sw, r.bw) - r.iw;
        if (over > 1) {
          throw new Error(`${w}px 宽下横向溢出 ${over}px（scrollWidth=${r.sw}/${r.bw}，视口=${r.iw}）`);
        }
      }
      await setViewport(VIEW_W, VIEW_H);
    });

    /* ================================================================ */
    /* V20：表单校验错误常驻在字段旁，不再走全局 toast                  */
    /* ================================================================ */
    /*
     * 两个病，一个根：
     *
     *   ① 「房间码为 4 位字符」是**表单校验错误**，却走了全局 toast ——
     *      toast 会飘走、还会跨页（②）。校验错在哪一行，就该在那一行说清楚，
     *      而且要**常驻**（用户盯着输入框时它就该在）。
     *   ② toast 挂在**根布局**、状态在**模块级单例**里 → 大厅页的报错会
     *      跟着用户一路飘到对局页右上角，正好压在棋盘上方（老截图里一直有）。
     *
     * 判据四条：
     *   A 填错房间码 → 输入框下方出现 `.field-error`，写明原因；
     *   B 出错的输入框标上 `aria-invalid`；
     *   C 这条校验错误**没有**变成 toast（否则等于没改）；
     *   D 顺带确认 toast 通道本身是好的：填一个不存在的 4 位房间码，
     *     服务端的「房间不存在」能在大厅页看到 —— 给 V21 留个活靶子。
     */
    await step('V20', '房间码校验错误常驻在输入框下面（不是飘走的 toast）', async () => {
      // 房间码输入框在「加入房间」面板里 —— 先把那块打开（幂等，见 ensureJoinPanel）
      await ensureJoinPanel();
      const setRoomCode = async (value: string): Promise<void> => {
        await evaluate(`
          (() => {
            const input = document.querySelector('#roomcode');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(value)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()
        `);
        await sleep(200);
      };

      /* A / B / C：长度不对 → 字段级错误，不是 toast */
      await setRoomCode('AB');
      await clickText('button', '确定', '「确定」按钮');
      /*
       * **不等 `.field-error` 出现。**
       *
       * 那个元素正是被测对象本身 —— 等它 = 把「变异把功能拆了」变成
       * 「等待超时」的无编号报错，变异脚本按「❌ 行 + 编号」判定时会
       * 判成「没抓到」。这里等一个稳定锚点（输入框还在），断言交给下面。
       */
      await sleep(400);
      const r = await evaluate<{ err: string; toast: string; invalid: boolean }>(`
        (() => {
          const err = document.querySelector('.field-error');
          const input = document.querySelector('#roomcode');
          return {
            err: (err?.innerText ?? '').trim(),
            toast: (document.querySelector('.toasts')?.innerText ?? '').trim(),
            invalid: input?.getAttribute('aria-invalid') === 'true',
          };
        })()
      `);
      if (!r.err) {
        throw new Error(
          `输入框下方没有出现字段级错误（校验错误又跑回 toast 了？toast 里是：${r.toast || '空'}）`,
        );
      }
      if (!r.err.includes('房间码为 4 位字符')) {
        throw new Error(`字段错误没写明原因（实际显示：${r.err}）`);
      }
      if (!r.invalid) throw new Error('出错的输入框没有标 aria-invalid');
      if (r.toast.includes('房间码为 4 位字符')) {
        throw new Error('这条校验错误仍然走全局 toast（等于没改，还会跨页残留）');
      }

      /* D：toast 通道本身是好的 —— 服务端的失败提示能在大厅页看到 */
      await setRoomCode('ZZZZ');
      await clickText('button', '确定', '「确定」按钮');
      await waitForExpr(
        `(document.querySelector('.toasts')?.innerText ?? '').includes('房间不存在')`,
        '服务端的「房间不存在」toast',
      );
      /*
       * **把这条 toast 钉住**（悬停 = 计时暂停）。
       *
       * 不钉的话，它 8 秒后自己消失 —— V21 那时断言「它不在了」就成了
       * 恒真断言：门禁绿，但根本没测到跨页清理这回事。
       * 钉住之后，它只可能是因为「换页被清掉」而消失。
       */
      const pinned = await evaluate<boolean>(`
        (() => {
          const t = document.querySelector('.toasts .toast');
          if (!t) return false;
          t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return true;
        })()
      `);
      if (!pinned) throw new Error('找不到那条「房间不存在」toast，没法钉住它');
    });

    /* ================================================================ */
    /* 造一个对手 → 进对局页                                          */
    /* ================================================================ */
    const WS_URL = APP_URL.replace(/^http/, 'ws') + '/ws';
    /*
     * 用「对象持有」而不是裸变量：CFA 会把裸 `let opponent = null` 一路收窄到 null，
     * 闭包里赋值它也不认（`opponent?.close()` 直接报 never）。
     *
     * `browserSide` 是**抽签结果**：浏览器这一局执白还是执黑。
     * 它是**随机的**（服务端 `crypto.randomInt` 抽的），
     * 所以凡是「谁走哪一步」的门禁都得先问一句它 ——
     * 不能再假设「浏览器永远是白方」。
     */
    const ctx: { opponent: GameClient | null; browserSide: 'w' | 'b' | undefined } = {
      opponent: null,
      browserSide: undefined,
    };
    let roomCode = '';

    await step('准备', '造一个对手让对局进入 playing', async () => {
      await clickText('button', '创建房间', '创建房间');
      // 建房在「创建房间」面板里点「确定」之后才真的发生
      await waitForExpr(`!!document.querySelector('.mode-panel')`, '创建房间面板');
      await clickText('button', '确定', '「确定」按钮');
      await waitForExpr(`/\\/room\\/[A-Z0-9]{4}/.test(location.pathname)`, '跳转到对局页');
      roomCode = await evaluate<string>(`location.pathname.split('/').pop() || ''`);
      if (!/^[A-Z0-9]{4}$/.test(roomCode)) throw new Error(`房间码不正常：${roomCode}`);

      ctx.opponent = new GameClient(WS_URL);
      await ctx.opponent.ready();
      ctx.opponent.send({ t: 'hello', name: OPPONENT_NAME });
      await ctx.opponent.waitFor((m) => (m.t === 'session' ? true : null), '对手的 session');
      /*
       * **起点**：从这一刻起收到的房间快照才算数。
       *
       * `waitPreparing` / `waitPlaying` 只看 `since` 之后的消息 ——
       * 不设起点的话，它会匹配到**更早**的旧快照（比如进房之前那份「等待中」）。
       */
      const joinSince = ctx.opponent.msgCount;
      ctx.opponent.send({ t: 'room.join', code: roomCode, mode: 'play' });

      /*
       * **新规则**：两人到齐只**抽签**，进的是「准备中」——
       * 真人对局要**双方都点「准备」**才开局（白方先走）。
       *
       * 所以老那句 `await sleep(1200)` 不够了：那个等待只保证「人进来了」，
       * 现在的状态是「准备中」，还走不了棋 ——
       * 后面凡是依赖「对局进行中」的门禁（战利品那条、落子权标记那条）
       * 会**全部**失效（它们等的是 `playing` 才有的东西）。
       *
       * 四步，顺序不能换：
       *   ① 等抽签完成（status → preparing）；
       *   ② 浏览器**在 UI 上**点「准备」——
       *      走 UI 而不是伪造协议，门禁要验的本来就是「这个按钮能用」；
       *   ③ 对手发 `{ t: 'ready' }`；
       *   ④ 等开局（status → playing）。
       */
      await waitPreparing(ctx.opponent, joinSince);
      // 等「准备」按钮出现：房间进「准备中」之后，前端才会把这个按钮渲染出来
      await waitForExpr(
        `[...document.querySelectorAll('.hud-actions button')].some((b) => (b.textContent || '').trim() === '准备')`,
        '「准备」按钮',
      );
      await clickReadyButton();
      ctx.opponent.send({ t: 'ready' });
      await waitPlaying(ctx.opponent, joinSince);

      /*
       * **抽签结果**：浏览器这一局执白还是执黑。
       *
       * 按**座位名**查（`sideOfName`）—— 房间快照的 `seats.w / seats.b` 里带名字，
       * 不用去翻浏览器的 token。
       */
      ctx.browserSide = sideOfName(ctx.opponent.latestRoom(), BROWSER_NAME);
      if (!ctx.browserSide) {
        throw new Error(`抽签完了却查不出「${BROWSER_NAME}」执哪一边（房间快照里没这个座位）`);
      }
      return `抽签结果：浏览器执${ctx.browserSide === 'w' ? '白' : '黑'}，对手执${
        ctx.browserSide === 'w' ? '黑' : '白'
      }`;
    }, (v) => v);

    /* ================================================================ */
    /* V21：上一页的 toast 不跟着人飘进对局页                          */
    /* ================================================================ */
    /*
     * 大厅页那条「房间不存在」（V20 的 D 造的，而且已经被悬停钉住、
     * 不会自己过期）不该出现在对局页右上角。
     *
     * toast 挂在根布局、状态在模块级单例里 —— 不处理的话它一路跟过来，
     * 正好压在棋盘上方最显眼的位置。
     *
     * 判据：对局页里找不到这条提示。
     */
    await step('V21', '上一页的 toast 不跨页残留进对局页', async () => {
      const r = await evaluate<{ toast: string; path: string }>(`
        (() => ({
          toast: (document.querySelector('.toasts')?.innerText ?? '').trim(),
          path: location.pathname,
        }))()
      `);
      if (!/\/room\/[A-Z0-9]{4}/.test(r.path)) {
        throw new Error(`还没进对局页（当前路径 ${r.path}）`);
      }
      if (r.toast.includes('房间不存在')) {
        throw new Error(`大厅页的「房间不存在」飘到了对局页：${r.toast}`);
      }
    });

    /* ================================================================ */
    /* V9b：对局页在手机窄屏下也不横向溢出                              */
    /* ================================================================ */
    /*
     * 为什么单列一条：V9 量的是**大厅页**的三个宽度，**对局页**没量过。
     * 结果真出事了 —— 窄屏对局页里「快捷聊天 + 棋谱」那一行
     * 没写 min-width: 0，flex 子项的 automatic minimum size 按内容算，
     * 把这一行撑到 425px，页面被顶到 513px（430px 视口）→ 横向溢出。
     *
     * 判据有三条，缺一不可：
     *   ① 页面本身不横向溢出（scrollWidth ≤ 视口宽）；
     *   ② 撑不下的内容**进了快捷聊天自己的滚动容器**（它自己可滚）；
     *   ③ 「聊天」按钮和「棋谱」按钮都还在视口内。
     * 只有 ① 是不够的 —— 溢出可能被别的机制「藏」起来。
     */
    await step('V9b', '对局页 430px 手机窄屏不横向溢出（快捷聊天自己滚）', async () => {
      await setViewport(430, 932);
      const r = await evaluate<{
        sw: number;
        iw: number;
        rowRight: number;
        chatBtnRight: number;
        notationRight: number;
        quickScrolls: boolean;
        quickCount: number;
      }>(`
        (() => {
          const row = document.querySelector('.rail-quick-row');
          const chat = document.querySelector('.rail-chat');
          const note = document.querySelector('.rail-notation-btn');
          const quick = document.querySelector('.rail-quick');
          const rr = row ? row.getBoundingClientRect() : null;
          const cr = chat ? chat.getBoundingClientRect() : null;
          const nr = note ? note.getBoundingClientRect() : null;
          return {
            sw: document.documentElement.scrollWidth,
            iw: window.innerWidth,
            rowRight: rr ? Math.round(rr.right) : -1,
            chatBtnRight: cr ? Math.round(cr.right) : -1,
            notationRight: nr ? Math.round(nr.right) : -1,
            quickScrolls: !!quick && quick.scrollWidth > quick.clientWidth,
            quickCount: document.querySelectorAll('.rail-quick-btn').length,
          };
        })()
      `);
      if (r.sw > r.iw + 1) {
        throw new Error(`对局页在 ${r.iw}px 宽下横向溢出 ${r.sw - r.iw}px（scrollWidth=${r.sw}）`);
      }
      if (r.chatBtnRight > r.iw + 1) {
        throw new Error(`「聊天」按钮右缘 ${r.chatBtnRight} 超出视口 ${r.iw}`);
      }
      if (r.notationRight > r.iw + 1) {
        throw new Error(`「棋谱」按钮右缘 ${r.notationRight} 超出视口 ${r.iw}`);
      }
      if (r.quickCount > 0 && !r.quickScrolls) {
        throw new Error(
          `快捷聊天（${r.quickCount} 个）既没撑破页面也没在自己的容器里滚动 —— 说明放不下时没有「自己滚」`,
        );
      }
      await setViewport(VIEW_W, VIEW_H);
    });

    /* ================================================================ */
    /* V15：聊天输入框的高度（别做成一堵墙）                            */
    /* ================================================================ */
    /*
     * 真事故：宽屏右列的聊天输入框**有 258px 高** —— 比整块聊天记录区还高。
     *
     * 根因：`.chat-strip` 在宽屏是 `flex-direction: column`，
     * 而 `.chat-input-row` 写着 `flex: 0 1 258px` ——
     * **`flex-basis` 跟着容器的轴走**，于是 258px 落到了**高度**上。
     * 那条 258px 当初是给窄屏横排聊天带留的（那时 flex-basis 作用于宽度）。
     * 改版改了布局，同一个数字的轴就变了。
     *
     * 判据：**两条都要量** —— 宽屏常驻的那个 + 窄屏弹层里的那个。
     * 只量一个的话，换个布局就又漏了（这轮已经栽过一次）。
     */
    await step('V15', '聊天输入框高度正常（宽屏常驻 + 窄屏弹层）', async () => {
      const wide = await evaluate<{ inputH: number; btnH: number; rowH: number }>(`
        (() => {
          const input = document.querySelector('.chat-strip .chat-input-row input');
          const btn = document.querySelector('.chat-strip .chat-input-row button');
          const row = document.querySelector('.chat-strip .chat-input-row');
          return {
            inputH: Math.round(input?.getBoundingClientRect().height ?? -1),
            btnH: Math.round(btn?.getBoundingClientRect().height ?? -1),
            rowH: Math.round(row?.getBoundingClientRect().height ?? -1),
          };
        })()
      `);
      if (wide.inputH < 0) throw new Error('宽屏找不到聊天输入框');
      if (wide.inputH > 48 || wide.btnH > 48) {
        throw new Error(
          `宽屏聊天输入框高 ${wide.inputH}px / 发送按钮高 ${wide.btnH}px（应 ≤ 48px，单行输入框的高度）`,
        );
      }
      if (wide.inputH < 24) {
        throw new Error(`宽屏聊天输入框高 ${wide.inputH}px（塌了，正常应 ≥ 24px）`);
      }
      /*
       * **行高也要量**。
       *
       * 只量输入框有个盲区：如果有人给输入框加 `align-self: center`，
       * 输入框就永远按内容高度（33px）显示 —— 界面看着正常，
       * 但输入框**那一行**可能高 258px，把聊天记录区压掉一大半。
       * 所以行高也必须一起量（它才是 flex-basis 落到哪条轴上的直接证据）。
       */
      if (wide.rowH > 64) {
        throw new Error(`宽屏聊天输入框**那一行**高 ${wide.rowH}px（应 ≤ 64px，否则记录区被压扁）`);
      }

      // 窄屏弹层里的那个也量一遍
      await setViewport(430, 932);
      await clickSelector('.rail-chat', '「聊天」按钮');
      await waitForExpr(`!!document.querySelector('.chat-panel-foot .input')`, '聊天弹层');
      await sleep(200);
      const narrow = await evaluate<{ inputH: number }>(`
        (() => {
          const input = document.querySelector('.chat-panel-foot .input');
          return { inputH: Math.round(input?.getBoundingClientRect().height ?? -1) };
        })()
      `);
      await clickText('button', '收起', '收起按钮');
      await setViewport(VIEW_W, VIEW_H);
      await sleep(200);
      if (narrow.inputH < 0) throw new Error('窄屏聊天弹层里找不到输入框');
      if (narrow.inputH > 48 || narrow.inputH < 24) {
        throw new Error(`窄屏聊天弹层输入框高 ${narrow.inputH}px（应在 24~48px 之间）`);
      }
    });

    /* ================================================================ */
    /* V16 / V17：打字聊天留底，快捷聊天只飘弹幕                          */
    /* ================================================================ */
    /*
     * 两种聊天，两套规矩（**产品定的**）：
     *
     *   |            | 飘弹幕 | 进聊天记录 | 写进 room.chat（后来者能看到） |
     *   |------------|--------|------------|-------------------------------|
     *   | 打字聊天   |   ✅    |     ✅     |              ✅                |
     *   | 快捷聊天   |   ✅    |     ❌     |              ❌                |
     *
     * 快捷聊天是「喊一嗓子」：扫一眼就过，**不占记录、也不留底**
     * （服务端 `quickChat()` 不写 `room.chat`；前端收到 `quick: true` 也不往记录里塞）。
     *
     * V16 打字聊天 / V17 快捷聊天 —— **两条都要测**，
     * 只测一条的话，另一条走老路照样全绿。
     *
     * **注意**：这条规矩跟「抽签 + 准备」那次改的是**两件事**。
     * V17 原来断言的是「快捷聊天也进聊天记录、也留底」——
     * 那是更早一版产品的做法，早就跟实现对不上了（门禁一直红）。
     */
    await step('V16', '打字聊天：既进聊天窗口，又飘弹幕', async () => {
      const text = TYPED_CHAT_TEXT;
      await evaluate(`
        (() => {
          const input = document.querySelector('.chat-strip .chat-input-row input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(text)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(250);
      await clickSelector('.chat-strip .chat-input-row button', '「发送」按钮');
      await sleep(800);
      const r = await evaluate<{ inLog: boolean; inDanmaku: boolean; logTail: string; dmText: string }>(`
        (() => {
          const log = document.querySelector('.chat-strip .chat-log');
          const dm = [...document.querySelectorAll('.danmaku-item')];
          return {
            inLog: (log?.innerText ?? '').includes(${JSON.stringify(text)}),
            inDanmaku: dm.some((d) => (d.innerText ?? '').includes(${JSON.stringify(text)})),
            logTail: (log?.innerText ?? '').slice(-60).replace(/\\n/g, ' / '),
            dmText: dm.map((d) => d.innerText.replace(/\\n/g, ' ')).join(' | '),
          };
        })()
      `);
      if (!r.inLog) throw new Error(`聊天窗口里没有这条消息（记录区末尾：${r.logTail}）`);
      if (!r.inDanmaku) throw new Error(`屏幕上没有飘这条消息的弹幕（当前弹幕：${r.dmText}）`);
    });

    await step('V17', '快捷聊天：只飘弹幕，不进聊天记录，也不留底给后来者', async () => {
      /*
       * **判据必须做成「差分」** —— 只断言「记录里没有它」是**恒真断言**
       * （记录本来就是空的，也「没有它」）。
       * 所以拿 **V16 那条打字的**当基准：
       *   同一条通道上，打字的**在**记录里 → 快捷的**不在**记录里。
       * 一进一出，规则才真的被量到了。
       */
      const text = '好棋';
      await clickText('.rail-quick-btn', text, '快捷聊天按钮');
      await sleep(600);
      const r = await evaluate<{
        inLog: boolean;
        typedInLog: boolean;
        inDanmaku: boolean;
        logTail: string;
        dmText: string;
      }>(`
        (() => {
          const msgs = [...document.querySelectorAll('.chat-strip .chat-log .msg')];
          const dm = [...document.querySelectorAll('.danmaku-item')];
          const logAll = msgs.map((m) => m.innerText.replace(/\\n/g, ' ')).join(' | ');
          return {
            inLog: logAll.includes(${JSON.stringify(text)}),
            typedInLog: logAll.includes(${JSON.stringify(TYPED_CHAT_TEXT)}),
            inDanmaku: dm.some((d) => (d.innerText ?? '').includes(${JSON.stringify(text)})),
            logTail: logAll.slice(-160),
            dmText: dm.map((d) => d.innerText.replace(/\\n/g, ' ')).join(' | '),
          };
        })()
      `);
      // ① 快捷聊天唯一的可见结果：飘一条弹幕
      if (!r.inDanmaku) throw new Error(`屏幕上没有飘这条快捷聊天的弹幕（当前弹幕：${r.dmText}）`);
      // ② 差分的前提：记录通道是通的（V16 那条打字的得在里面）
      if (!r.typedInLog) {
        throw new Error(
          `聊天记录里连 V16 那条打字的都没有（记录通道没通，这条门禁没法量）：${r.logTail}`,
        );
      }
      // ③ 快捷聊天**不进**聊天记录
      if (r.inLog) {
        throw new Error(`快捷聊天进了聊天记录（产品规则：快捷聊天只飘弹幕、不留底）：${r.logTail}`);
      }

      /*
       * 再验一条：**不留底**（服务端那一半）。
       * 服务端把 room.chat 随房间快照一起广播，所以「后来者能不能看到」
       * 就是「有没有写进 room.chat」的直接证据。
       * 这里用一个**观战者**连接去读初始快照（观战不影响对局）。
       */
      const watcher = new GameClient(WS_URL);
      try {
        await watcher.ready();
        watcher.send({ t: 'hello', name: '后来者' });
        await watcher.waitFor((m) => (m.t === 'session' ? true : null), '观战者的 session');
        watcher.send({ t: 'room.join', code: roomCode, mode: 'spectate' });
        const history = await watcher.waitFor<Array<{ text?: string }>>(
          (m) =>
            m.t === 'room' && Array.isArray((m.state as { chat?: unknown[] })?.chat)
              ? (m.state as { chat: Array<{ text?: string }> }).chat
              : null,
          '后来者收到带聊天历史的房间快照',
          8000,
        );
        const hasTyped = history.some((c) => c.text === TYPED_CHAT_TEXT);
        const hasQuick = history.some((c) => c.text === text);
        // 差分的前提：打字的得留底（留底通道是通的）
        if (!hasTyped) {
          throw new Error('后来者连 V16 那条打字的都没看到（房间历史没带过来，这条门禁没法量）');
        }
        // 快捷聊天**不留底**
        if (hasQuick) {
          throw new Error('后来者在房间历史里看到了这条快捷聊天（快捷聊天不该留底）');
        }
      } finally {
        watcher.close();
      }
    });

    /* ================================================================ */
    /* V18：双方吃子的情况（每个玩家行下方显示他吃掉的对方棋子）        */
    /* ================================================================ */
    /*
     * 规则：**战利品显示在吃子方自己那一行的下方**（国际象棋惯例）。
     *   - 白方行下面 = 白方吃掉的**黑**子
     *   - 黑方行下面 = 黑方吃掉的**白**子
     *
     * 判据有三条，缺一不可：
     *   ① 两个玩家行**都**有战利品带（只显示一方的，等于没做「双方」）；
     *   ② 战利品**一颗都不能少**（数量对得上棋谱）；
     *   ③ 归属正确 —— 白方行里必须是黑子，黑方行里必须是白子。
     *      这条最容易漏：颜色反了但数量对，肉眼扫一眼不一定看得出来。
     *
     * 走子序列（造出「互相吃掉一兵」）：
     *   白 e2-e4 ｜ 黑 d7-d5 ｜ 白 e4xd5（白吃黑兵，白兵落在 d5）
     *   ｜ 黑 g8-f6 ｜ 白 a2-a3（让出回合）｜ 黑 f6xd5（马从 f6 吃 d5 的白兵）
     *
     * **这盘棋是谁走，现在由抽签决定** —— 黑白不再「谁先进房谁执白」了。
     * 所以下面按「浏览器实际执色」分配：浏览器执白就走白方那三步，
     * 执黑就走黑方那三步（见下面的着法表）。
     * 着法本身还是上面这一盘 —— 变的只是「哪一步由浏览器点」。
     *
     * 让出回合那步必须用**合法**着法：早先写的是「白 d1-d2」——
     * 白后被自己的 d2 兵挡着，走不了，那步静默失败 → 后面黑方那步也跟着被拒。
     *
     * 注意：**马只能吃有子的格子** —— 早先写成 f6xe4 是不合法的（e4 已经被白兵吃空）。
     */
    await step('V18', '双方吃子：各自行下方显示「该方吃掉的对方棋子」', async () => {
      /** 浏览器里点两格走一步（2D 棋盘才有 data-square） */
      const clickMove = async (from: string, to: string): Promise<void> => {
        const ok = await evaluate<boolean>(`
          (() => {
            const f = document.querySelector('[data-square="${from}"]');
            const t = document.querySelector('[data-square="${to}"]');
            if (!f || !t) return false;
            f.click();
            setTimeout(() => t.click(), 120);
            return true;
          })()
        `);
        if (!ok) throw new Error(`点不到格子 ${from} → ${to}`);
        await sleep(500);
      };

      /*
       * **着法按「浏览器实际执色」排** —— 黑白现在是**抽签**定的，
       * 浏览器可能是黑方。老代码写死了「浏览器 = 白方」，抽到黑就整条崩。
       *
       * 棋谱还是**同一盘棋**（白方三步、黑方三步，轮流走，**白方先走**）：
       *   白：e2→e4 ｜ e4×d5（吃黑兵）｜ a2→a3（让出回合）
       *   黑：d7→d5 ｜ g8→f6（马出来）｜ f6→d5（吃白兵）
       * 变的只是**谁点哪一步**：
       *   浏览器执白 → 浏览器走白方那三步，对手走黑方那三步；
       *   浏览器执黑 → 浏览器走黑方那三步，对手走白方那三步
       *                 （于是**第一步是对手走的** —— 白方先走这条规则没变）。
       *
       * 断言一个字都不用改：它验的是「双方各 1 颗战利品 + 归属正确」，
       * 而归属是按**棋子颜色**判的（白方行里必须是黑子），跟谁执白无关。
       */
      if (!ctx.opponent) throw new Error('对手没造出来（准备步骤失败），这条门禁没法跑');
      if (!ctx.browserSide) {
        throw new Error('不知道浏览器执哪一边（抽签结果没拿到），没法决定谁走哪一步');
      }
      const whiteMoves: Array<[string, string]> = [
        ['e2', 'e4'],
        ['e4', 'd5'],
        ['a2', 'a3'],
      ];
      const blackMoves: Array<[string, string]> = [
        ['d7', 'd5'],
        ['g8', 'f6'],
        ['f6', 'd5'],
      ];
      const browserIsWhite = ctx.browserSide === 'w';
      for (let i = 0; i < whiteMoves.length; i += 1) {
        const [wFrom, wTo] = whiteMoves[i];
        const [bFrom, bTo] = blackMoves[i];
        if (browserIsWhite) {
          await clickMove(wFrom, wTo);
          ctx.opponent.send({ t: 'move', from: bFrom, to: bTo });
          await sleep(700);
        } else {
          ctx.opponent.send({ t: 'move', from: wFrom, to: wTo });
          await sleep(700);
          await clickMove(bFrom, bTo);
        }
      }
      await sleep(900);

      const r = await evaluate<{
        rows: Array<{ name: string; dark: boolean; caps: string[] }>;
        status: string;
        turn: string;
        toast: string;
      }>(`
        (() => {
          const rows = [...document.querySelectorAll('.hud-players .player-row')].map((row) => ({
            name: (row.querySelector('.name')?.textContent ?? '').trim(),
            dark: !!row.querySelector('.piece-dot.dark'),
            caps: [...row.querySelectorAll('.captured-strip .cap')].map(
              (c) => (c.getAttribute('aria-label') ?? '').trim(),
            ),
          }));
          const turnRow = document.querySelector('.hud-players .player-row.turn');
          return {
            rows,
            status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
            turn: (turnRow?.querySelector('.name')?.textContent ?? '').trim(),
            toast: [...document.querySelectorAll('[class*="toast"]')]
              .map((t) => (t.textContent ?? '').trim())
              .join(' | '),
          };
        })()
      `);
      const white = r.rows.find((x) => !x.dark);
      const black = r.rows.find((x) => x.dark);
      if (!white || !black) {
        throw new Error(`玩家行没找全（白=${white?.name ?? '无'} 黑=${black?.name ?? '无'}）`);
      }
      if (white.caps.length !== 1) {
        throw new Error(`白方行应有 1 颗战利品（白吃了一个黑兵），实际 ${white.caps.length} 颗：${white.caps.join('、')}`);
      }
      if (black.caps.length !== 1) {
        throw new Error(
          `黑方行应有 1 颗战利品，实际 ${black.caps.length} 颗｜状态="${r.status}" 轮到=${r.turn} toast="${r.toast}"`,
        );
      }
      if (!white.caps[0].startsWith('黑方')) {
        throw new Error(`白方行的战利品颜色错了：${white.caps[0]}（应是「黑方兵」—— 白吃黑）`);
      }
      if (!black.caps[0].startsWith('白方')) {
        throw new Error(`黑方行的战利品颜色错了：${black.caps[0]}（应是「白方兵」—— 黑吃白）`);
      }
      await shot('03-captured-wide');

      /*
       * **3D 页面也要有**。
       *
       * 2D / 3D 共用同一套 HUD 组件，但两边的**布局不同**
       * （2D 竖排卡片 / 3D 横排条），所以不能只测一边 ——
       * 战利品带在 3D 的横排里可能被挤到换行、把 3D 画布压扁。
       */
      await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('.view-toggle button')]
            .find((b) => (b.textContent || '').trim() === '3D');
          if (btn) btn.click();
          return !!btn;
        })()
      `);
      await sleep(3500);
      const r3 = await evaluate<{ caps: number; canvas: boolean }>(`
        (() => ({
          caps: document.querySelectorAll('.captured-strip .cap').length,
          canvas: !!document.querySelector('canvas'),
        }))()
      `);
      await shot('05-captured-3d');
      if (!r3.canvas) throw new Error('切到 3D 后没有渲染出画布');
      if (r3.caps !== 2) {
        throw new Error(`3D 页面上的战利品只剩 ${r3.caps} 颗（2D 上是 2 颗）—— 切到 3D 后没渲染出来`);
      }
      // 切回 2D，后面的门禁都在 2D 下跑
      await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('.view-toggle button')]
            .find((b) => (b.textContent || '').trim() === '2D');
          if (btn) btn.click();
          return true;
        })()
      `);
      await sleep(1200);
    });

    /* ================================================================ */
    /* V19：窄屏下 HUD 长高了，棋盘不能被挤没                            */
    /* ================================================================ */
    /*
     * 战利品带让每个玩家行长高了一截 —— 窄屏下 HUD 在棋盘**上方**，
     * 于是棋盘能用的高度就少了。
     *
     * `planStageLayout` 里的 `STACK_EXTRA_H` 是**估算值**（HUD + 间距 + 聊天块），
     * 估算不准就会算出「放不下」的棋盘边长 → 页面出纵向滚动条。
     *
     * 判据三条：
     *   ① 430px 下页面**不出现纵向滚动条**；
     *   ② 棋盘还有**像样的尺寸**（不能被挤成一条缝）；
     *   ③ HUD 的高度和估算值对得上（差太多说明估算该改了）。
     *
     * **「不出滚动条」不是硬判据，「棋盘边长」才是。**
     *
     * 探针实测（800×500）：`.page` 是 **100vh 固定高度**，
     * `docSH == innerH == 500`，舞台底边在 393px —— **离视口底还有 87px 余量**。
     * 所以「棋盘变大 94px」根本撑不出滚动条（底边才到 487）。
     * → 靠「页面滚动了吗」抓这类变异 = 抓空气（变异【二十一】第一次就这么漏的）。
     * 真正硬的判据是**直接量 `.board-frame` 的边长**：估算偏大 → 边长被算小 → 直接看得见。
     */
    await step('V19', '窄屏下 HUD 长高后棋盘没被挤没', async () => {
      /*
       * 两个视口，测的是**两种不同的约束**：
       *
       * ① 430×932（真实手机）：棋盘是**宽度受限**的
       *    （视口宽 430 → 棋盘 406px，高度还富余一大截）。
       *    所以 HUD 变高在这里**挤不动**棋盘 ——
       *    这条量的是「别把页面顶出滚动条」。
       *
       * ② 800×500（宽而矮）：棋盘**高度受限**
       *    （stackH = 视口高 - 顶栏 - HUD/聊天估算 ≈ 206px < 可用宽 760px）。
       *    这才是 HUD 变高会**真正挤掉**棋盘的场景 ——
       *    `STACK_EXTRA_H` 估算偏大的话，这里就会算出「放不下」的棋盘 → 页面出滚动条。
       *
       * 少测 ② 的话，① 永远是绿的（宽度受限，HUD 再高也挤不动），
       * 那这条门禁就等于没有 —— 变异【二十一】就是这么漏的。
       */
      await setViewport(430, 932);
      await sleep(700);
      const phone = await evaluate<{ sh: number; ih: number; board: number; hud: number }>(`
        (() => {
          const b = document.querySelector('.board-frame');
          const br = b ? b.getBoundingClientRect() : null;
          return {
            sh: document.documentElement.scrollHeight,
            ih: window.innerHeight,
            board: br ? Math.round(Math.min(br.width, br.height)) : -1,
            hud: Math.round(document.querySelector('.hud')?.getBoundingClientRect().height ?? -1),
          };
        })()
      `);
      await shot('04-narrow-430');

      await setViewport(800, 500);
      await sleep(700);
      const squat = await evaluate<{ sh: number; ih: number; board: number; hud: number }>(`
        (() => {
          const b = document.querySelector('.board-frame');
          const br = b ? b.getBoundingClientRect() : null;
          return {
            sh: document.documentElement.scrollHeight,
            ih: window.innerHeight,
            board: br ? Math.round(Math.min(br.width, br.height)) : -1,
            hud: Math.round(document.querySelector('.hud')?.getBoundingClientRect().height ?? -1),
          };
        })()
      `);
      await shot('04b-squat-800x500');

      /*
       * **第三个视口：1100×800 —— 专门盯「宽屏还是窄屏」的判定。**
       *
       * 800×500 那个视口**测不到 JS 侧的布局判定**：
       * 它的列宽只有 176px < 440 → `planStageLayout` 命中第二条（列太窄）→
       * **直接判成窄屏**，第三条（`wideW >= narrowW`）根本不执行 ——
       * 所以 `STACK_EXTRA_H` 在那个视口下改了等于没改。
       *
       * 1100×800 正好卡在判定边界上（探针实测）：
       *   stageW 1060 → 列宽 1060−600 = **460 ≥ 440** → 不走第二条 ✅
       *   视口 1100 > 800 → 不走第一条（正方形/竖长）✅
       *   → 落到第三条：
       *       wideW   = min(460, 800−140)      = 460
       *       narrowW = min(1060, 800−140−154) = 506
       *       460 < 506 → **窄屏**（正常，实测棋盘 506px）
       *   估算一旦偏大（154 → 300）→ narrowW = 360 → 460 ≥ 360 → **翻成宽屏** →
       *   棋盘从 506 变成 460 → 对账判据直接抓到。
       */
      await setViewport(1100, 800);
      await sleep(800);
      const mid = await evaluate<{ sh: number; ih: number; board: number; layout: string }>(`
        (() => {
          const b = document.querySelector('.board-frame');
          const br = b ? b.getBoundingClientRect() : null;
          const stage = document.querySelector('.stage');
          return {
            sh: document.documentElement.scrollHeight,
            ih: window.innerHeight,
            board: br ? Math.round(Math.min(br.width, br.height)) : -1,
            layout: stage ? (stage.className || '') : '',
          };
        })()
      `);
      await shot('04c-mid-1100x800');
      await setViewport(VIEW_W, VIEW_H);
      await sleep(300);

      if (mid.sh > mid.ih + 1) {
        throw new Error(`1100×800 下页面出现纵向滚动条（页面 ${mid.sh} / 视口 ${mid.ih}）`);
      }
      if (!mid.layout.includes('layout-narrow')) {
        throw new Error(`1100×800 下布局应该是窄屏（实测 ${mid.layout}）—— 宽窄屏判定跑偏了`);
      }
      // 1060 舞台宽 − 600 侧栏 = 460 列宽 < 506 → 正常判成窄屏；估算偏大就会翻成宽屏
      if (Math.abs(mid.board - 506) > 12) {
        throw new Error(
          `1100×800 下棋盘边长 ${mid.board}px，与估算值对不上` +
            `（视口 800 − 估算 294 = 506px，容差 12px）—— 布局估算偏了，或宽窄屏判定被翻转`,
        );
      }

      if (phone.sh > phone.ih + 1) {
        throw new Error(
          `430px 下页面出现纵向滚动条（页面 ${phone.sh} / 视口 ${phone.ih}）｜HUD 高 ${phone.hud}px`,
        );
      }
      if (phone.board < 240) {
        throw new Error(`430px 下棋盘只剩 ${phone.board}px（太挤了；HUD 高 ${phone.hud}px）`);
      }
      if (squat.sh > squat.ih + 1) {
        throw new Error(
          `800×500 下页面出现纵向滚动条（页面 ${squat.sh} / 视口 ${squat.ih}）—— ` +
            `HUD 高 ${squat.hud}px，棋盘边长只剩 ${squat.board}px：高度估算偏大，把棋盘算成了放不下的尺寸`,
        );
      }
      if (squat.board < 120) {
        throw new Error(`800×500 下棋盘只剩 ${squat.board}px（被 HUD 挤没了；HUD 高 ${squat.hud}px）`);
      }
      /*
       * **对账式判据：棋盘边长必须等于「视口高 − 顶栏 − 估算值」。**
       *
       * 800×500：500 − 顶栏 140 − 估算 154 = **206px**。
       *
       * 为什么非要加这条：
       *   ① 「不出滚动条」**不是硬判据** —— `.page` 是 100vh 固定高度，
       *      探针实测舞台底边在 393px，离视口底还有 87px 余量，
       *      棋盘变大 94px 也才到 487 —— 压根不产生滚动条。
       *   ② 「棋盘 ≥ 120px」**在这个视口下是恒真的** ——
       *      窄屏布局下棋盘 = min(舞台宽, 估算剩余高度)，宽屏布局下棋盘 = 列宽 176px，
       *      两条路都 ≥ 176px。估算怎么改都下不去 120。
       *
       * 对账就不一样了：估算偏小 → 棋盘算大（260 ≠ 206）、估算偏大 → 布局翻转成宽屏
       * （棋盘 176 ≠ 206），**两个方向都会被抓到**。
       */
      if (Math.abs(squat.board - 206) > 12) {
        throw new Error(
          `800×500 下棋盘边长 ${squat.board}px，与估算值对不上` +
            `（视口 500 − 顶栏 140 − 估算 154 = 206px，容差 12px）—— 布局估算偏了`,
        );
      }
    });

    /* ================================================================ */
    /* V5：落子权标记的竖条只出现在轮到走棋的那一行                      */
    /* ================================================================ */
    await step('V5', '签名元素：落子权竖条只出现在轮到走棋的那一行', async () => {
      await waitForExpr(`document.querySelectorAll('.player-row').length >= 2`, '双方玩家行');
      await waitForExpr(`document.querySelectorAll('.player-row.turn').length === 1`, '唯一一行带落子权标记');
      const r = await evaluate<
        { rows: number; turn: number; bar: { w: string; bg: string; content: string }; others: string[] }
      >(`
        (() => {
          const rows = [...document.querySelectorAll('.player-row')];
          const turn = rows.filter((r) => r.classList.contains('turn'));
          const bar = getComputedStyle(turn[0], '::before');
          const others = [];
          for (const r of rows) {
            if (r.classList.contains('turn')) continue;
            const b = getComputedStyle(r, '::before');
            if (b.content && b.content !== 'none' && parseFloat(b.width) > 0) {
              others.push((r.textContent || '').slice(0, 12) + ' content=' + b.content);
            }
          }
          return {
            rows: rows.length,
            turn: turn.length,
            bar: { w: bar.width, bg: bar.backgroundColor, content: bar.content },
            others,
          };
        })()
      `);
      if (r.turn !== 1) throw new Error(`带落子权标记的行有 ${r.turn} 行（应该恰好 1 行）`);
      if (r.bar.content === 'none' || parseFloat(r.bar.w) < 2) {
        throw new Error(`落子权竖条没渲染（content=${r.bar.content}，width=${r.bar.w}）`);
      }
      if (r.bar.bg === 'rgba(0, 0, 0, 0)') {
        throw new Error('落子权竖条是透明的（看不见）');
      }
      if (r.others.length) {
        throw new Error(`非落子方的行也画了竖条：${r.others.join('；')}`);
      }
    });

    /* ================================================================ */
    /* V6：落子权方块在那一行是高亮的                                   */
    /* ================================================================ */
    await step('V6', '签名元素：落子权方块在落子方那行是高亮的', async () => {
      /*
       * 这里必须断言「方块就是主色」，不能只断言「方块和对方不一样」。
       *
       * 之前只比了 turnBg !== otherBg（对方是黑方 var(--ink-2)），
       * 于是把方块改成 var(--card)（白纸色）照样「和黑方不同」→ 门禁假绿。
       * 参照色用探针元素现场解析 var(--accent)，不写死 hex，
       * 免得换配色后门禁和实现各走各的。
       */
      const r = await evaluate<{
        turnBg: string;
        turnShadow: string;
        otherBg: string;
        accentBg: string;
      }>(`
        (() => {
          const rows = [...document.querySelectorAll('.player-row')];
          const turn = rows.find((r) => r.classList.contains('turn'));
          const other = rows.find((r) => !r.classList.contains('turn'));
          const dot = turn ? turn.querySelector('.piece-dot') : null;
          const t = dot ? getComputedStyle(dot) : null;
          const o = other ? getComputedStyle(other.querySelector('.piece-dot')) : null;
          const probe = document.createElement('span');
          probe.style.position = 'absolute';
          probe.style.visibility = 'hidden';
          probe.style.backgroundColor = 'var(--accent)';
          document.body.appendChild(probe);
          const accentBg = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            turnBg: t ? t.backgroundColor : '',
            turnShadow: t ? t.boxShadow : '',
            otherBg: o ? o.backgroundColor : '',
            accentBg,
          };
        })()
      `);
      if (!r.turnBg) throw new Error('落子方那一行没有 .piece-dot 方块');
      if (!r.accentBg || r.accentBg === 'rgba(0, 0, 0, 0)') {
        throw new Error('取不到主色 --accent 的真实颜色（参照色本身就废了，这条断言无效）');
      }
      if (r.turnBg !== r.accentBg) {
        throw new Error(`落子权方块不是主色：实测 ${r.turnBg}，主色应为 ${r.accentBg}`);
      }
      if (r.turnBg === r.otherBg) {
        throw new Error(`落子权方块没有被高亮（和对方同色 ${r.turnBg}）`);
      }
      if (r.turnShadow === 'none') {
        throw new Error('落子权方块没有光晕（box-shadow:none）');
      }
    });

    /* ================================================================ */
    /* V13：prefers-reduced-motion 下动效关闭                           */
    /* ================================================================ */
    await step('V13', 'prefers-reduced-motion 下动效关闭', async () => {
      /*
       * 量的是**真正在动的元素**：落子权方块（turn-pulse 呼吸动画，常驻、不会消失）。
       *
       * 之前量的是 `.status-dot i` —— 它压根没有动画，
       * `animationDuration` 恒为 0s，这条门禁就是个**永远绿的空转**。
       * 所以这里做成**双向**：先确认默认状态下动画确实在跑（> 0.01s），
       * 再确认 reduced-motion 下它被关掉（≤ 0.01s）。
       * 只有单向判定才会漏掉「动画压根没配」这种假绿。
       */
      const probe = `(() => {
        const el = document.querySelector('.player-row.turn .piece-dot');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { anim: cs.animationDuration, trans: cs.transitionDuration };
      })()`;
      const maxDur = (s: string): number =>
        Math.max(0, ...s.split(',').map((x) => parseFloat(x) || 0));

      const normal = await evaluate<{ anim: string; trans: string } | null>(probe);
      if (!normal) throw new Error('找不到带呼吸动画的落子权方块（.player-row.turn .piece-dot）');
      if (maxDur(normal.anim) <= 0.01) {
        throw new Error(`默认状态下动画时长就是 ${normal.anim} —— 落子权标记压根没在动，这条门禁是空转`);
      }

      await cdp!.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await sleep(350);
      const reduced = await evaluate<{ anim: string; trans: string } | null>(probe);
      await cdp!.send('Emulation.setEmulatedMedia', { features: [] });
      await sleep(150);

      if (!reduced) throw new Error('reduced-motion 下元素消失了');
      if (maxDur(reduced.anim) > 0.01) {
        throw new Error(`reduced-motion 下动画时长仍是 ${reduced.anim}（应当被关掉）`);
      }
      if (maxDur(reduced.trans) > 0.01) {
        throw new Error(`reduced-motion 下过渡时长仍是 ${reduced.trans}（应当被关掉）`);
      }
    });

    /* ================================================================ */
    /* V14：图标按钮都有可访问名                                        */
    /* ================================================================ */
    await step('V14', '图标按钮都有可访问名（aria-label 或 title）', async () => {
      const r = await evaluate<{ bad: string[] }>(`
        (() => {
          const bad = [];
          document.querySelectorAll('button').forEach((el) => {
            const text = (el.innerText || '').trim();
            const named = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            if (!text && !named) {
              bad.push((el.className || '(无 class)') + ' → ' + el.outerHTML.slice(0, 80));
            }
          });
          return { bad };
        })()
      `);
      if (r.bad.length) {
        throw new Error(`有按钮既没有文字也没有可访问名：${r.bad.slice(0, 3).join('；')}`);
      }
    });

    await shot('02-room-wide');

    /* ================================================================ */
    /* 收尾                                                            */
    /* ================================================================ */
    (ctx.opponent as GameClient | null)?.close();

    const failed = results.filter((r) => !r.ok);
    console.log('');
    /*
     * 报告**本次实际跑了什么**。
     *
     * 分组模式下「跑 7 条全绿」很容易被误读成「23 条全绿」——
     * 所以必须把「跳过了哪些」一并印出来，跳过的门禁**不算达标也不算失败**。
     */
    if (selectedGroups) {
      console.log(
        `📦 本次分组：${selectedGroups.join('、')}（跑 ${results.length} 条，跳过 ${skipped.length} 条：` +
          `${skipped.join('、') || '无'}）`,
      );
    }
    if (failed.length === 0) {
      console.log(`✅ UI 视觉门禁通过：${results.length} 条全部达标。`);
      process.exitCode = 0;
    } else {
      console.log(`❌ UI 视觉门禁失败：${failed.length}/${results.length} 条不达标。`);
      for (const f of failed) console.log(`   · ${f.label} —— ${f.detail}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`❌ 门禁脚本自身崩溃：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

void main();
