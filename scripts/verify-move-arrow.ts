/**
 * 走子箭头验收 —— 「上一步走子箭头」在 2D / 3D 里必须**看得见、且指得对**。
 *
 * 为什么要有这个门禁：
 *   「箭头看不看得见」是**观感问题**，单元测试测不出来。
 *   之前就是靠人工截图复核才发现 3D 的箭头几乎完全被终点棋子吞掉
 *   （只剩一小截黄杆），而没有任何自动化能发现它 —— 回归随时会再来一次。
 *
 * 硬门禁（41 条）：
 *   G1（2D 几何）：箭尖落在两个 lastmove 格之一的**格心**，
 *                   箭杆尾端落在另一个 —— 箭头必须**指对**。
 *   G2（3D 像素）：画布里「强橙色像素」数量够多 —— 箭头必须**看得见**。
 *                   （判据 r-b > 125：箭头本体 r-b ≈ 140，
 *                     终点格的琥珀高亮混色后只有 ≈ 109，够不着门槛。）
 *   G3（宽屏）：HUD 在棋盘**左边**、聊天在棋盘**右边**（左右分列布局）。
 *   G4（窄屏）：HUD 在棋盘**上方**、聊天在棋盘**下方**（上下堆叠布局）。
 *   G5…G9：弹幕层级、3D 宽/窄屏、HUD 常驻、消息条常驻。
 *   G10（3D 像素）：画布**上沿**不能被页面浮层的投影压暗
 *                   ——「不要遮住棋盘」这条要求在 3D 里的落地。
 *   G11（DOM）：**贴在棋盘上方**的元素一律不许带投影
 *                   （投影 z-index 高于画布，必然盖到棋盘顶）。
 *   G12（正方形视口）：正方形视口按**窄屏**处理（用户明确要求）。
 *   G13（窄屏）：棋盘确实被**缩小**，上下让出空间给 HUD / 聊天。
 *   G14：宽屏 / 窄屏都不出现纵向滚动。
 *
 *   聊天记录改成「可展开的框」之后新增：
 *   G15（窄屏）：聊天区**只有一行** —— 记录 / 输入框 / 发送按钮都不常驻，
 *               只留「💬 聊天」按钮 + 6 个快捷聊天（同一行）。
 *   G16（窄屏）：点「聊天」**弹出大框**，历史聊天 + 输入框 + 发送按钮齐全，记录换行完整显示。
 *   G17：点「收起」弹层消失。
 *   G18（宽屏）：右列记录**常驻**，且每条消息换行完整显示（不再被省略号截断）。
 *   G19（手机 430px）：那一行不横向溢出，聊天按钮和 6 个快捷聊天都还在。
 *   G20（窄屏）：对方发来消息 → 聊天按钮右上角出**未读角标**；打开弹层后角标消失。
 *   G30（宽屏）：聊天输入框**贴着面板下沿** —— 记录区不再写死高度上限，
 *              否则输入框会被顶在半空、下面空一大片（用户 2026-11-13 报的）。
 *
 *   求和 / 悔棋 / 认输改成右侧浮层之后新增（在一个**真人对局**的新房间里测，
 *   因为电脑会直接拒绝和棋、自动同意悔棋，触发不了「对方请求 → 我方回应」）：
 *   G21（宽屏）：聊天内容变多 → **只在记录区内部滚动**，页面不出现纵向滚动条。
 *   G22：HUD 按钮顺序是「认输 / 提议和棋 / 悔棋」。
 *   G23：认输必须**二次确认**（点一下只弹浮层，对局继续；确认后才结束）。
 *   G24：对方求和 → 右侧浮层带「同意 / 反对」+ 倒计时。
 *   G25：对方请求悔棋 → 右侧浮层带「同意 / 反对」；同意后那一步**真的被撤销**。
 *   G26：浮层是 `position: fixed`，页面里没有内联文字条，也不撑出滚动条。
 *   G27：我方求和 → 右侧浮层显示「等待对方回应」+ 倒计时。
 *   G28：**我方**点「悔棋」→ 对手真的收到了这个请求（我方也弹出等待浮层）。
 *         （G25 只覆盖了「对方发起 → 我方回应」这一半，缺了「我方发起」这一半。）
 *
 * 顺带把截图存到 artifacts/move-arrow/，方便人工复核观感。
 *
 * **规则变更适配**（服务端上线「抽签 + 准备」那版）：
 *   · **执色改成抽签** —— 两人到齐那一刻服务端掷 `crypto.randomInt` 定黑白，
 *     先进房的人先进「颜色待定」，第二个人进来才各占一边。
 *     「谁先进房谁执白」的老假设**不再成立**：脚本里凡是替某一方走子、
 *     断言某一格上是某个颜色的兵的地方，都改成按**实际执色**来走 / 判
 *     （拿执色：房间快照的 `state.seats.w.name` / `state.seats.b.name`）。
 *   · **真人对局要双方都点「准备」才开局**（`waiting → preparing → playing`），
 *     所以真人对局那段补了：浏览器点「准备」+ 对手发 `{t:'ready'}` + 等 `playing`。
 *   · **人机局可以自己选执色**（随机 / 我执白 / 我执黑）：脚本固定成「我执白」，
 *     fallback 那一步仍然按**实际执色**分支（万一这个选择没点上也不会走错棋子）。
 *
 * 用法：
 *   npx tsx scripts/verify-move-arrow.ts [http://127.0.0.1:3000]
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
import { ARROW_GROUPS } from './lib/arrow-groups';
import { sideOfName } from './lib/game-client';

/**
 * 地址怎么传：
 * - `--url=<地址>`（推荐，显式、不怕位置参数被别的开关顶掉）
 * - 位置参数（向后兼容）
 *
 * 位置参数只取**第一个不像开关、且长得像 http 地址**的项 ——
 * 否则 `--group=chat` 会被当成地址，报出一堆看不懂的连接错误。
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

/**
 * 本次要跑哪几组门禁（`null` = 全跑）。
 *
 * **为什么 arrow 这套也要分组**：原来每条变异都跑全部 40 条门禁，
 * 实测单条变异 2 分钟里有 1 分半是陪跑 —— 每条变异只期望 1 条红。
 * 分组之后只跑相关的组。
 */
const selectedGroups = parseGroupFilter(ARROW_GROUPS, process.argv.slice(2));
const gateFilter = makeGateFilter(ARROW_GROUPS, selectedGroups);

/** 这一组门禁（可能多条）本次要不要跑 */
const gateEnabledAny = (ids: string[]): boolean => ids.some((id) => gateFilter(id));
const OUT_DIR = join(process.cwd(), 'artifacts', 'move-arrow');
const VIEW_W = 1600;
const VIEW_H = 1000;

/* ------------------------------------------------------------------ */
/* 找一个可用的 Chromium                                                */
/* ------------------------------------------------------------------ */
function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH) {
    return existsSync(process.env.CHROMIUM_PATH) ? process.env.CHROMIUM_PATH : null;
  }
  const candidates: string[] = [];
  const cacheRoots = [
    join(homedir(), 'Library/Caches/ms-playwright'), // macOS
    join(homedir(), '.cache/ms-playwright'), // Linux
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    for (const dir of ['chromium-1228', 'chromium-1200', 'chromium_headless_shell-1228', 'chromium_headless_shell-1200']) {
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
/* 页面内统计「强橙色像素」                                            */
/* ------------------------------------------------------------------ */

/**
 * 数画面里的**强橙色**像素 —— 那就是走子箭头本体。
 *
 * 判据 r - b > 125（实测：箭头本体 ≈ 140，终点格琥珀高亮 ≈ 109，
 * 浅格上的琥珀高亮 ≈ 69，木纹 / 棋子 / 背景全部 < 60）。
 * 分几档都统计一遍，方便对着截图核对。
 */
const ORANGE_FN = `
async (b64, region) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const rx = Math.max(0, region.x), ry = Math.max(0, region.y);
  const rw = Math.min(bmp.width - rx, region.w), rh = Math.min(bmp.height - ry, region.h);
  const bins = { gt100: 0, gt125: 0, gt150: 0 };
  let maxDiff = 0;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * bmp.width + x) * 4;
      const diff = d[i] - d[i + 2];
      if (diff > maxDiff) maxDiff = diff;
      if (diff > 100) bins.gt100++;
      if (diff > 125) bins.gt125++;
      if (diff > 150) bins.gt150++;
    }
  }
  return { ...bins, maxDiff };
}`;

/**
 * 取一块矩形的**众数色**、众数占比，以及**5% 分位数**。
 *
 * 两个都要：
 *   · 众数 + 占比 —— 判断这块到底是不是**纯背景**（占比 100% 才是）；
 *   · 5% 分位数 —— 判断这块有没有被**压暗**。
 *     众数在这里靠不住：浮层投影只染黑最上面 2~3 行，
 *     在一块 13 行高的取样块里众数仍然是「干净的底色」，
 *     而分位数能如实反映「有几行被染黑了」。
 */
const BLOCK_FN = `
async (b64, region) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const rx = Math.max(0, region.x), ry = Math.max(0, region.y);
  const rw = Math.min(bmp.width - rx, region.w), rh = Math.min(bmp.height - ry, region.h);
  const hist = new Map();
  const px = [];
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * bmp.width + x) * 4;
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      hist.set(key, (hist.get(key) ?? 0) + 1);
      px.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  let best = -1, bestKey = 0;
  for (const [k, v] of hist) { if (v > best) { best = v; bestKey = k; } }
  const p5 = [0, 1, 2].map((k) => {
    const a = px.map((p) => p[k]).sort((x, y) => x - y);
    return a[Math.floor(a.length * 0.05)];
  });
  return {
    mode: [((bestKey >> 10) & 31) << 3, ((bestKey >> 5) & 31) << 3, (bestKey & 31) << 3],
    ratio: best / Math.max(1, rw * rh),
    p5,
  };
}`;

/**
 * 找出「紧贴棋盘上方」的元素 —— **它们的投影会直接盖到棋盘上**。
 *
 * 判据（三条同时成立才算「贴在棋盘上方」）：
 *   ① 横向与棋盘有交叠（不然投影落在页面留白里，无害）；
 *   ② 完全位于棋盘顶边之上；
 *   ③ 与棋盘顶边的间距 ≤ 40px —— 投影最多往下伸 34px（offset 8 + blur 26）。
 *
 * 返回这些元素的 computed box-shadow：只要不是 'none'，就是在糊棋盘。
 */
const SHADOW_PROBE_FN = `
  (() => {
    const board = document.querySelector('.board-frame');
    if (!board) return { bad: ['取不到棋盘'], checked: [] };
    const bb = board.getBoundingClientRect();
    const bad = [], checked = [];
    for (const sel of ['.hud', '.chat-strip', '.rail-chat', '.rail-quick-btn']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const hOverlap = r.left < bb.right - 1 && bb.left < r.right - 1;
        const above = r.bottom <= bb.top + 1;
        const flush = bb.top - r.bottom <= 40;
        if (hOverlap && above && flush) {
          const sh = getComputedStyle(el).boxShadow;
          checked.push(sel + '=' + sh);
          if (sh !== 'none') bad.push(sel + '=' + sh);
        }
      }
    }
    return { bad, checked };
  })()
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 一方走**它自己那个兵**：白方 e2→e4，黑方 e7→e5。
 *
 * ## 为什么需要它
 *
 * **执色现在是抽签定的** ——「谁先进房谁执白」的老假设已经不成立，
 * 对手可能是白也可能是黑，浏览器反之。
 *
 * 凡是要替某一方走一步的地方（对手走子、浏览器走子），
 * 都得按它**实际**执什么颜色来选兵：
 * 走错颜色的兵，服务端会直接拒掉（`还没轮到你走` / `非法着法`），
 * 那一步就白走了 —— 后面等箭头的门禁会超时，而不是变红。
 */
const pawnStep = (side: 'w' | 'b'): { from: string; to: string } =>
  side === 'w' ? { from: 'e2', to: 'e4' } : { from: 'e7', to: 'e5' };

/* ------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** 两个矩形是否相交（留 1px 容差，避免边框像素抖动误判） */
function overlap(a: Box, b: Box): boolean {
  const pad = 1;
  return (
    a.x + a.w - pad > b.x &&
    b.x + b.w - pad > a.x &&
    a.y + a.h - pad > b.y &&
    b.y + b.h - pad > a.y
  );
}

/**
 * a 相对 b 的方位：left / right / above / below / overlap。
 *
 * 先判横向再判纵向 —— 左右分列的布局里，两块的高度往往一样，
 * 横向关系才是「谁在左谁在右」的关键。
 */
function relation(a: Box, b: Box): 'left' | 'right' | 'above' | 'below' | 'overlap' {
  if (overlap(a, b)) return 'overlap';
  if (a.x + a.w <= b.x + 1) return 'left';
  if (b.x + b.w <= a.x + 1) return 'right';
  if (a.y + a.h <= b.y + 1) return 'above';
  if (b.y + b.h <= a.y + 1) return 'below';
  return 'overlap';
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

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess-arrow-'));
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
        throw new Error(`页面求值失败：${res.exceptionDetails.text ?? 'unknown'}`);
      }
      return res.result?.value as T;
    };

    const waitForExpr = async (expression: string, label: string, timeoutMs = 40000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = await evaluate<boolean>(`!!(${expression})`);
        if (v) return;
        await sleep(250);
      }
      const diag = await evaluate<string>(
        `location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' / ')`,
      );
      throw new Error(`等待「${label}」超时。页面状态：${diag}`);
    };

    /**
     * 让浏览器在棋盘上走一步（点起点 → 点终点）。
     *
     * **不等箭头、不等 `.lastmove` 高亮** —— 那两个正是 G1 / G5 在测的东西。
     * 拿被测元素当等待条件，一旦它坏了就会变成「等超时」而不是「门禁变红」，
     * 门禁编号也就丢了。这里只点一下，走没走成功由后面的门禁自己判。
     */
    const browserMove = async (from: string, to: string): Promise<void> => {
      await evaluate(`
        (() => {
          const f = document.querySelector('[data-square="${from}"]');
          const t = document.querySelector('[data-square="${to}"]');
          if (f && t) { f.click(); setTimeout(() => t.click(), 120); }
          return true;
        })()
      `);
      await sleep(400);
    };

    /**
     * 从**裸 ws 的报文堆**里取最新的房间快照。
     *
     * `oppMsgs` 是从早到晚追加的，所以必须从**尾部**往前找 ——
     * 从前往后找会拿到上一局的旧快照（房间码、执色全是旧的）。
     */
    const latestRoomOf = (msgs: any[]): any | null => {
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (m?.t === 'room' && m.state) return m.state;
      }
      return null;
    };

    /**
     * 等房间进入某个状态（用**对手收到的快照**判，不依赖页面 DOM）。
     *
     * 真人对局现在是「两人到齐 → 抽签定黑白 → **双方都点准备** → 才开始走子」，
     * 所以「房间到齐了」和「对局开始了」是两件事，分开等。
     */
    const waitRoomStatus = async (
      msgs: any[],
      status: string,
      timeoutMs: number,
    ): Promise<any> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const s = latestRoomOf(msgs);
        if (s && s.status === status) return s;
        await sleep(150);
      }
      const s = latestRoomOf(msgs);
      throw new Error(
        `等待房间进入「${status}」超时（当前=${s?.status ?? '（没收到房间快照）'}）`,
      );
    };

    const shot = async (box: Box): Promise<string> => {
      const res = await cdp!.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.w),
          height: Math.round(box.h),
          scale: 2,
        },
      });
      return res.data as string;
    };

    /* ---------------- 登录 + 进房间 ---------------- */
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(800);
    await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
    await evaluate(`
      (() => {
        const input = document.querySelector('input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '箭头验收员这是一个非常非常长的玩家名字用来验证省略号截断与行宽不被撑破');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(200);
    // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点
    await waitForExpr(`!!document.querySelector('.status-dot.online')`, '与服务器连上');
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.includes('进入大厅'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(
      `[...document.querySelectorAll('button')].some((b) => b.textContent && b.textContent.includes('人机对弈'))`,
      '「人机对弈」按钮',
    );
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.includes('人机对弈'));
        if (btn) btn.click();
        return true;
      })()
    `);
    // 人机对弈的表单在「人机对弈」面板里 —— 打开面板后还要点「确定」才真的开局
    await waitForExpr(`!!document.querySelector('#ai-color')`, '人机对弈面板', 10000);
    /*
     * **固定执白**（面板里的「执子」选择器 → 我执白）。
     *
     * 为什么固定：人机局的执色现在是**玩家自己挑**的（随机 / 我执白 / 我执黑），
     * 「电脑一定先手」这条老假设已经不成立。固定成我执白之后：
     *   · 轮到浏览器先走 —— 下面那步 fallback 一定合法（e2→e4 走的是自己的兵）；
     *   · 箭头由**脚本自己走的那一步**产生，不用等引擎想完。
     *
     * 下面的 fallback 仍然按**实际执色**分支 —— 万一这个选择没点上
     * （面板改版 / 选择器 id 变了），也不会走错颜色的兵。
     */
    await evaluate(`
      (() => {
        const trig = document.querySelector('#ai-color');
        if (trig) trig.click();
        return true;
      })()
    `);
    await waitForExpr(
      `!!document.querySelector('.picker-option[data-value="w"]')`,
      '「执子」选项展开',
      5000,
    ).catch(() => undefined);
    await evaluate(`
      (() => {
        const opt = document.querySelector('.picker-option[data-value="w"]');
        if (opt) opt.click();
        return true;
      })()
    `);
    await sleep(200);
    const aiColorPicked = await evaluate<string>(
      `document.querySelector('#ai-color')?.getAttribute('data-value') ?? ''`,
    );
    console.log(
      `人机局执子：${aiColorPicked === 'w' ? '我执白（已固定）' : aiColorPicked || '（没选上 → 按实际执色分支）'}`,
    );
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.mode-actions button')]
          .find((b) => b.textContent && b.textContent.includes('确定'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(`location.pathname.startsWith('/room/')`, '跳转对局页', 20000);
    console.log(`已进入房间：${await evaluate<string>('location.pathname')}`);

    /*
     * 等一手棋走出。
     *
     * **不能再假设「电脑先手」** —— 人机局的执色是玩家自己挑的：
     *   · 浏览器执白 → 轮到它走，**不会有箭头**，得脚本自己走一步；
     *   · 浏览器执黑 → 电脑先走，箭头自己会出来。
     *
     * 走哪一步取决于**浏览器实际执什么颜色**（HUD 状态文案里写着「你执白 / 你执黑」）：
     * 白走 e2→e4，黑走 e7→e5 —— 走错颜色的兵服务端会直接拒掉，
     * 那一步就白走了，等箭头的门禁会超时而不是变红。
     */
    await waitForExpr(
      `((document.querySelector('.hud-status')?.innerText ?? '').includes('你执白') || (document.querySelector('.hud-status')?.innerText ?? '').includes('你执黑'))`,
      'HUD 显示自己的执色',
      15000,
    );
    const aiMyColor = await evaluate<'w' | 'b'>(
      `(document.querySelector('.hud-status')?.innerText ?? '').includes('你执白') ? 'w' : 'b'`,
    );
    const aiStep = pawnStep(aiMyColor);
    console.log(`人机局实际执色：${aiMyColor === 'w' ? '白' : '黑'}`);
    if (aiMyColor === 'w') {
      // 浏览器执白 → 轮到它走：自己走一步，箭头立刻就有
      await browserMove(aiStep.from, aiStep.to);
      await waitForExpr(`!!document.querySelector('.move-arrow polygon')`, '出现上一步箭头（自己走一步）', 15000);
    } else {
      // 浏览器执黑 → 电脑先走；万一电脑没动，兜底走自己的兵（那时已经轮到它了）
      await waitForExpr(`!!document.querySelector('.move-arrow polygon')`, '出现上一步箭头', 20000).catch(
        async () => {
          await browserMove(aiStep.from, aiStep.to);
          await waitForExpr(`!!document.querySelector('.move-arrow polygon')`, '出现上一步箭头（自己走一步）', 15000);
        },
      );
    }
    await sleep(500);

    /* ---------------- 先发一条**超长**聊天消息 ---------------- */
    /*
     * 聊天记录「能不能看清」这件事，只有真的有长消息才测得出来。
     * 所以这里发一条刻意写得很长的消息：
     *   - 宽屏：右列记录区必须**换行完整显示**（不能被省略号截断）；
     *   - 窄屏：不常驻，点「聊天」弹出的弹层里必须**换行完整显示**。
     */
    await evaluate(`
      (() => {
        const input = document.querySelector('.chat-strip .chat-input-row input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(
          input,
          '这是一条刻意写长的聊天消息，用来验收聊天记录到底能不能看清：短消息好办，长消息必须换行完整显示，不能被截成一截省略号让人猜后面写了什么。',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(250);
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.chat-strip .chat-input-row button')]
          .find((b) => b.textContent && b.textContent.includes('发送'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(`document.querySelectorAll('.chat-log .msg').length > 0`, '聊天记录里出现消息', 10000);

    if (gateEnabledAny(["G1", "G8", "G9"])) {
    const geo = await evaluate<{
      points: string | null;
      board: Box | null;
      marks: Array<{ square: string; rect: Box; occupied: boolean }>;
    }>(`
      (() => {
        const poly = document.querySelector('.move-arrow polygon');
        const board = document.querySelector('.board-frame');
        const br = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        // 棋子层里的每一枚棋子落在哪个格子上（按中心点归属）
        const pieces = [...document.querySelectorAll('.piece-layer .piece')].map((el) => {
          const b = el.getBoundingClientRect();
          return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
        });
        return {
          points: poly ? poly.getAttribute('points') : null,
          board: br(board),
          marks: [...document.querySelectorAll('.square.lastmove')].map((el) => {
            const r = br(el);
            const occupied = pieces.some(
              (p) => Math.abs(p.cx - (r.x + r.w / 2)) < r.w / 2 && Math.abs(p.cy - (r.y + r.h / 2)) < r.h / 2,
            );
            return { square: el.getAttribute('data-square'), rect: r, occupied };
          }),
        };
      })()
    `);

    if (!geo.points || !geo.board || geo.marks.length !== 2) {
      verdict(false, 'G1 2D 箭头几何', `多边形=${!!geo.points} 高亮格=${geo.marks.length}（应为 2）`);
    } else {
      const pts = geo.points.split(' ').map((s) => s.split(',').map(Number));
      const tip = pts[3];
      const tail = [(pts[0][0] + pts[6][0]) / 2, (pts[0][1] + pts[6][1]) / 2];
      const cell = geo.board.w / 8;
      /**
       * 换算成「格子下标」：多边形在 viewBox="0 0 8 8" 里，
       * 一个单位就是一格，格子下标 = floor(坐标)。
       */
      const cellOf = (p: number[]): string => `${Math.floor(p[0])},${Math.floor(p[1])}`;
      /** 高亮格的下标（按棋盘网格反推，和多边形同一套坐标系） */
      const markCells = geo.marks.map((m) => ({
        square: m.square,
        occupied: m.occupied,
        cell: `${Math.floor((m.rect.x - geo.board!.x) / cell)},${Math.floor((m.rect.y - geo.board!.y) / cell)}`,
      }));
      const tipCell = cellOf(tip);
      const tailCell = cellOf(tail);
      const tipMark = markCells.find((m) => m.cell === tipCell);
      const tailMark = markCells.find((m) => m.cell === tailCell);
      /**
       * 方向判定：**终点是有棋子的那一格**（棋子已经走到那儿了），
       * 起点是空格（棋子刚离开）。
       * 只验「箭头跨越了这两格」不够 —— 箭头掉头也满足那条，
       * 所以必须把「哪一格有棋子」一起验上。
       */
      const ok =
        tipMark !== undefined &&
        tailMark !== undefined &&
        tipCell !== tailCell &&
        tipMark.occupied &&
        !tailMark.occupied;
      verdict(
        ok,
        'G1 2D 箭头几何与方向',
        `箭尖→${tipMark?.square ?? '（不在高亮格内）'}${tipMark?.occupied ? '(有棋子=终点)' : '(空格)'} 箭尾→${tailMark?.square ?? '（不在高亮格内）'}${tailMark?.occupied ? '(有棋子)' : '(空格=起点)'}`,
      );
    }

    /* ---------------- G8 / G9：HUD 与消息条必须**常驻** ---------------- */
    /*
     * 静置 3 秒（完全不碰鼠标）后，两者都必须**原样还在**。
     *
     * 用户明确要求「HUD 搞成常驻」「消息也常驻」——
     * 以前 HUD 是「鼠标移开淡出」的，所以这里必须真的等过那段时间再断言，
     * 否则一个「立刻淡出」的回归照样能骗过门禁。
     */
    await sleep(3200);
    const persistent = await evaluate<{
      hud: { exists: boolean; hidden: boolean; opacity: string };
      chat: { exists: boolean; display: string; hasInput: boolean; logH: number };
    }>(`
      (() => {
        const hud = document.querySelector('.hud');
        const strip = document.querySelector('.chat-strip');
        return {
          hud: {
            exists: !!hud,
            hidden: hud ? hud.classList.contains('hud-hidden') : true,
            opacity: hud ? getComputedStyle(hud).opacity : 'none',
          },
          chat: {
            exists: !!strip,
            display: strip ? getComputedStyle(strip).display : 'none',
            hasInput: !!strip && !!strip.querySelector('input'),
            logH: strip ? Math.round(strip.querySelector('.chat-log')?.getBoundingClientRect().height ?? 0) : 0,
          },
        };
      })()
    `);
    verdict(
      persistent.hud.exists && !persistent.hud.hidden && Number(persistent.hud.opacity) > 0.9,
      'G8 HUD 常驻（静置 3 秒仍完全可见）',
      `exists=${persistent.hud.exists} hidden=${persistent.hud.hidden} opacity=${persistent.hud.opacity}`,
    );
    verdict(
      persistent.chat.exists &&
        persistent.chat.display !== 'none' &&
        persistent.chat.hasInput &&
        persistent.chat.logH > 0,
      'G9 消息条常驻（有记录区 + 输入框）',
      `exists=${persistent.chat.exists} display=${persistent.chat.display} 输入框=${persistent.chat.hasInput} 记录区高=${persistent.chat.logH}px`,
    );
    }

    const layoutWide = await evaluate<{
      hud: Box | null;
      chat: Box | null;
      board: Box | null;
      stageClass: string;
      danmakuZ: string;
      hudZ: string;
      hudPos: string;
      scroll: { h: number; vh: number };
      shadow: { bad: string[]; checked: string[] };
    }>(`
      (() => {
        const br = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        const z = (sel) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).zIndex : 'none';
        };
        const hud = document.querySelector('.hud');
        return {
          hud: br('.hud'), chat: br('.col-chat'), board: br('.board-frame'),
          stageClass: document.querySelector('.stage')?.className ?? '',
          danmakuZ: z('.danmaku-layer'), hudZ: z('.hud'),
          hudPos: hud ? getComputedStyle(hud).position : 'none',
          scroll: {
            h: document.documentElement.scrollHeight,
            vh: window.innerHeight,
          },
          shadow: ${SHADOW_PROBE_FN},
        };
      })()
    `);

    /* ---------------- G18：宽屏右列的记录要**换行完整显示** ---------------- */
    if (gateEnabledAny(["G18", "G2"])) {
    /*
     * 宽屏（左右分列）时聊天记录是**常驻**在右列的，那个框有 300×525px，够大。
     * 但之前每条消息是 `white-space: nowrap` + 省略号 —— 长消息只剩一截尾巴。
     * 现在改成换行完整显示，这里守住它：
     *   ① 记录区可见且够高；
     *   ② 有消息；
     *   ③ 每条消息的 scrollWidth 不超过 clientWidth（= 没有被横向截断）；
     *   ④ white-space 确实是 normal（不是 nowrap）。
     */
    const wideChat = await evaluate<{
      visible: boolean;
      h: number;
      count: number;
      truncated: number;
      whiteSpace: string;
    }>(`
      (() => {
        const log = document.querySelector('.chat-log');
        const msgs = [...(log?.querySelectorAll('.msg') ?? [])];
        const bad = msgs.filter((m) => m.scrollWidth > m.clientWidth + 1);
        return {
          visible: !!log && getComputedStyle(log).display !== 'none',
          h: log ? Math.round(log.getBoundingClientRect().height) : 0,
          count: msgs.length,
          truncated: bad.length,
          whiteSpace: msgs[0] ? getComputedStyle(msgs[0]).whiteSpace : '',
        };
      })()
    `);
    verdict(
      wideChat.visible &&
        wideChat.h > 100 &&
        wideChat.count > 0 &&
        wideChat.truncated === 0 &&
        wideChat.whiteSpace === 'normal',
      'G18 宽屏：右列聊天记录常驻且每条换行完整显示',
      `可见=${wideChat.visible} 记录区高=${wideChat.h}px 消息数=${wideChat.count} 被截断=${wideChat.truncated} white-space=${wideChat.whiteSpace}`,
    );

    writeFileSync(join(OUT_DIR, '2d-board.png'), Buffer.from(await shot({ x: 0, y: 0, w: VIEW_W, h: VIEW_H }), 'base64'));

    verdict(
      Number(layoutWide.danmakuZ) < Number(layoutWide.hudZ),
      'G2 弹幕层级不压 HUD',
      `弹幕 z-index=${layoutWide.danmakuZ} / HUD z-index=${layoutWide.hudZ}`,
    );
    }

    /* ---------------- G30：宽屏聊天输入框**贴着面板下沿** ---------------- */
    if (gateEnabledAny(["G30"])) {
    /*
     * 用户报的现象（2026-11-13）：宽屏 2D 下，右侧聊天面板里
     * **输入框和发送按钮悬在半空**，下面空出一大片（实测约 358px）。
     *
     * 根因：聊天记录区被 `max-height: 525px` 封了顶，
     * 而右列比 525px 高得多 —— 高出来的那截全成了空白，
     * 输入框被顶在中间，离面板下沿还远着。
     *
     * 判据：**输入框那一行的下沿**到**聊天面板下沿**的距离
     * 只剩面板自己的内边距（10px 左右）。
     *
     * 为什么量「距离」而不是「有没有输入框」：
     * 输入框一直都在、高度也对，坏的是它**待在哪**。
     * 只断言「存在」的话，这个 bug 从头到尾都是绿的。
     */
    const chatBottom = await evaluate<{
      gap: number;
      stripH: number;
      logH: number;
      logMaxH: string;
      pad: number;
    }>(`
      (() => {
        const strip = document.querySelector('.chat-strip');
        const row = document.querySelector('.chat-strip .chat-input-row');
        const log = document.querySelector('.chat-strip .chat-log');
        if (!strip || !row) return { gap: -1, stripH: 0, logH: 0, logMaxH: '', pad: 0 };
        const s = strip.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return {
          gap: Math.round(s.bottom - r.bottom),
          stripH: Math.round(s.height),
          logH: log ? Math.round(log.getBoundingClientRect().height) : 0,
          logMaxH: log ? getComputedStyle(log).maxHeight : '',
          pad: parseFloat(getComputedStyle(strip).paddingBottom) || 0,
        };
      })()
    `);
    const allowed = Math.max(16, chatBottom.pad + 6);
    verdict(
      chatBottom.gap >= 0 && chatBottom.gap <= allowed,
      'G30 宽屏：聊天输入框贴着聊天面板的下沿',
      `输入框下沿距面板下沿 ${chatBottom.gap}px（应 ≈ 面板内边距 ${chatBottom.pad}px，最多 ${allowed}px）` +
        ` 面板高=${chatBottom.stripH}px 记录区高=${chatBottom.logH}px 记录区 max-height=${chatBottom.logMaxH}`,
    );
    }

    /* ---------------- G3：宽屏 → HUD 在左、聊天在右 ---------------- */
    if (gateEnabledAny(["G3"])) {
    /*
     * 用户要求：「屏幕比较宽的时候，HUD 和聊天完全可以放在左边和右边」。
     * 判据：HUD 整块在棋盘**左边**，聊天块整块在棋盘**右边**，且互不重叠。
     */
    if (layoutWide.hud && layoutWide.board && layoutWide.chat) {
      const relHud = relation(layoutWide.hud, layoutWide.board);
      const relChat = relation(layoutWide.chat, layoutWide.board);
      verdict(
        relHud === 'left' && relChat === 'right',
        'G3 宽屏：HUD 在棋盘左边、聊天在棋盘右边',
        `stage="${layoutWide.stageClass}" HUD→棋盘=${relHud} 聊天→棋盘=${relChat}` +
          `（HUD ${JSON.stringify(layoutWide.hud)} 棋盘 ${JSON.stringify(layoutWide.board)}）`,
      );
    } else {
      verdict(false, 'G3 宽屏：HUD 在棋盘左边、聊天在棋盘右边', '取不到元素');
    }

    /* ---------------- 窄屏：压窄视口复验 ---------------- */
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    const layoutNarrow = await evaluate<{
      hud: Box | null;
      chat: Box | null;
      board: Box | null;
      stageClass: string;
      shadow: { bad: string[]; checked: string[] };
    }>(`
      (() => {
        const br = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        return {
          hud: br('.hud'), chat: br('.col-chat'), board: br('.board-frame'),
          stageClass: document.querySelector('.stage')?.className ?? '',
          shadow: ${SHADOW_PROBE_FN},
        };
      })()
    `);
    writeFileSync(join(OUT_DIR, '2d-narrow.png'), Buffer.from(await shot({ x: 0, y: 0, w: 900, h: 1200 }), 'base64'));
    /* ---------------- G4：窄屏 → HUD 在上、聊天在下 ---------------- */
    if (gateEnabledAny(["G4"])) {
    if (layoutNarrow.hud && layoutNarrow.board && layoutNarrow.chat) {
      const relHud = relation(layoutNarrow.hud, layoutNarrow.board);
      const relChat = relation(layoutNarrow.chat, layoutNarrow.board);
      verdict(
        relHud === 'above' && relChat === 'below',
        'G4 窄屏：HUD 在棋盘上方、聊天在棋盘下方',
        `stage="${layoutNarrow.stageClass}" HUD→棋盘=${relHud} 聊天→棋盘=${relChat}` +
          `（HUD ${JSON.stringify(layoutNarrow.hud)} 棋盘 ${JSON.stringify(layoutNarrow.board)}）`,
      );
    } else {
      verdict(false, 'G4 窄屏：HUD 在棋盘上方、聊天在棋盘下方', '取不到元素');
    }
    }

    /* ---------------- G15：窄屏聊天区**只有一行** ---------------- */
    if (gateEnabledAny(["G15"])) {
    /*
     * 用户要的是：窄屏下面**平时不显示**历史聊天 / 输入框 / 发送按钮，
     * 只留一行「💬 聊天」按钮 + 快捷聊天；点「聊天」才弹窗。
     *
     * 这里守住「不显示」这一半：
     *   - 常驻的聊天条（.chat-strip，里面有记录区 + 输入框 + 发送）整体 display:none；
     *   - 页面上不存在可见的记录区 / 输入框；
     *   - 聊天块本身只有**一行**高（装得下「聊天」按钮 + 6 个快捷聊天）；
     *   - 6 个快捷聊天在**同一行**（不换行）。
     */
    const narrowChat = await evaluate<{
      stripDisplay: string;
      logVisible: boolean;
      inputVisible: boolean;
      sendVisible: boolean;
      chatBtnText: string;
      quickCount: number;
      quickRows: number;
      chatBlockH: number;
    }>(`
      (() => {
        const strip = document.querySelector('.chat-strip');
        const log = document.querySelector('.chat-log');
        const input = document.querySelector('.chat-strip .chat-input-row input');
        const send = [...document.querySelectorAll('.chat-strip .chat-input-row button')]
          .find((b) => b.textContent && b.textContent.includes('发送'));
        const btn = document.querySelector('.rail-chat');
        const quick = [...document.querySelectorAll('.rail-quick-btn')];
        const rows = new Set(quick.map((b) => Math.round(b.getBoundingClientRect().top)));
        const block = document.querySelector('.col-chat');
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          stripDisplay: strip ? getComputedStyle(strip).display : 'none',
          logVisible: vis(log),
          inputVisible: vis(input),
          sendVisible: vis(send),
          chatBtnText: (btn?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          quickCount: quick.length,
          quickRows: rows.size,
          chatBlockH: block ? Math.round(block.getBoundingClientRect().height) : 0,
        };
      })()
    `);
    verdict(
      narrowChat.stripDisplay === 'none' &&
        !narrowChat.logVisible &&
        !narrowChat.inputVisible &&
        !narrowChat.sendVisible &&
        narrowChat.chatBtnText.includes('聊天') &&
        narrowChat.quickCount === 6 &&
        narrowChat.quickRows === 1 &&
        narrowChat.chatBlockH > 0 &&
        narrowChat.chatBlockH <= 60,
      'G15 窄屏：聊天区只有一行（记录/输入框/发送都不常驻，只留聊天按钮+快捷聊天）',
      `常驻聊天条 display=${narrowChat.stripDisplay} 记录区可见=${narrowChat.logVisible} 输入框可见=${narrowChat.inputVisible} 发送可见=${narrowChat.sendVisible} 聊天按钮="${narrowChat.chatBtnText}" 快捷聊天=${narrowChat.quickCount}个/${narrowChat.quickRows}行 聊天块高=${narrowChat.chatBlockH}px`,
    );
    }

    /* ---------------- G16：点「聊天」弹出大框，记录完整可读 ---------------- */
    if (gateEnabledAny(["G16"])) {
    await evaluate(`
      (() => {
        const btn = document.querySelector('.rail-chat');
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(`!!document.querySelector('.chat-panel')`, '聊天框弹层出现', 5000).catch(() => {
      /* 下面统一判红 */
    });
    const chatPanel = await evaluate<{
      exists: boolean;
      logH: number;
      w: number;
      count: number;
      truncated: number;
      whiteSpace: string;
      hasInput: boolean;
      hasSend: boolean;
      hasClose: boolean;
    }>(`
      (() => {
        const p = document.querySelector('.chat-panel');
        const log = p?.querySelector('.chat-panel-log');
        const msgs = [...(log?.querySelectorAll('.msg') ?? [])];
        const bad = msgs.filter((m) => m.scrollWidth > m.clientWidth + 1);
        const send = [...(p?.querySelectorAll('button') ?? [])]
          .find((b) => b.textContent && b.textContent.includes('发送'));
        return {
          exists: !!p,
          logH: log ? Math.round(log.getBoundingClientRect().height) : 0,
          w: p ? Math.round(p.getBoundingClientRect().width) : 0,
          count: msgs.length,
          truncated: bad.length,
          whiteSpace: msgs[0] ? getComputedStyle(msgs[0]).whiteSpace : '',
          hasInput: !!p?.querySelector('input'),
          hasSend: !!send && send.getBoundingClientRect().width > 0,
          hasClose: !!p?.querySelector('.chat-panel-head button'),
        };
      })()
    `);
    verdict(
      chatPanel.exists &&
        chatPanel.logH >= 120 &&
        chatPanel.count > 0 &&
        chatPanel.truncated === 0 &&
        chatPanel.whiteSpace === 'normal' &&
        chatPanel.hasInput &&
        chatPanel.hasSend &&
        chatPanel.hasClose,
      'G16 窄屏点「聊天」弹出大框：历史聊天+输入框+发送按钮齐全，且换行完整显示',
      `弹层=${chatPanel.exists} 宽=${chatPanel.w}px 记录区高=${chatPanel.logH}px 消息数=${chatPanel.count} 被截断=${chatPanel.truncated} white-space=${chatPanel.whiteSpace} 输入框=${chatPanel.hasInput} 发送按钮=${chatPanel.hasSend} 收起按钮=${chatPanel.hasClose}`,
    );
    }

    /* ---------------- G17：点「收起」弹层消失 ---------------- */
    if (gateEnabledAny(["G17"])) {
    await evaluate(`
      (() => {
        const btn = document.querySelector('.chat-panel-head button');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(300);
    const panelClosed = await evaluate<boolean>(`!document.querySelector('.chat-panel')`);
    verdict(panelClosed, 'G17 聊天框能收起（点「收起」后弹层消失）', `收起后弹层存在=${!panelClosed}`);
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    /* ---------------- G19：手机窄屏（430px）聊天条不挤爆 ---------------- */
    if (gateEnabledAny(["G19"])) {
    /*
     * 窄屏那条只有「💬 聊天」按钮 + 快捷聊天。
     * 在 430px 这种手机宽度上，6 个快捷聊天 + 按钮放不下是正常的 ——
     * 关键是**页面不能横向溢出**（快捷聊天自己横向滚动），聊天按钮必须看得见。
     */
    const phoneChat = await evaluate<{
      scrollW: number;
      innerW: number;
      chatBtnVisible: boolean;
      chatBtnW: number;
      quickCount: number;
      quickRows: number;
      quickOverflowX: string;
      quickScrolls: boolean;
      stripDisplay: string;
      blockRight: number;
      innerRight: number;
    }>(`
      (() => {
        const btn = document.querySelector('.rail-chat');
        const br = btn?.getBoundingClientRect();
        const block = document.querySelector('.col-chat');
        const bkr = block?.getBoundingClientRect();
        const strip = document.querySelector('.chat-strip');
        const quick = document.querySelector('.rail-quick');
        const quickBtns = [...document.querySelectorAll('.rail-quick-btn')];
        const rows = new Set(quickBtns.map((b) => Math.round(b.getBoundingClientRect().top)));
        return {
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          chatBtnVisible: !!br && br.width > 0 && br.height > 0,
          chatBtnW: br ? Math.round(br.width) : 0,
          quickCount: quickBtns.length,
          quickRows: rows.size,
          quickOverflowX: quick ? getComputedStyle(quick).overflowX : '',
          quickScrolls: !!quick && quick.scrollWidth > quick.clientWidth,
          stripDisplay: strip ? getComputedStyle(strip).display : 'none',
          blockRight: bkr ? Math.round(bkr.right) : 0,
          innerRight: window.innerWidth,
        };
      })()
    `);
    /*
     * 430px 是**一行放不下 6 个快捷聊天**的宽度 —— 正好用来验这条设计的三个要点：
     *   ① 页面**不横向溢出**（溢出的是快捷聊天自己，不是页面）；
     *   ② 快捷聊天**不换行**（换行就变成两行，「一行」的前提没了）；
     *   ③ 放不下时快捷聊天**自己横向滚动**（overflow-x: auto），
     *      而不是把按钮顶出容器、被裁掉。
     */
    verdict(
      phoneChat.scrollW <= phoneChat.innerW + 1 &&
        phoneChat.chatBtnVisible &&
        phoneChat.chatBtnW >= 50 &&
        phoneChat.quickCount === 6 &&
        phoneChat.quickRows === 1 &&
        (phoneChat.quickOverflowX === 'auto' || phoneChat.quickOverflowX === 'scroll') &&
        phoneChat.stripDisplay === 'none' &&
        phoneChat.blockRight <= phoneChat.innerRight + 1,
      'G19 手机窄屏（430px）：聊天那一行不横向溢出，聊天按钮 + 6 个快捷聊天在同一行（放不下自己滚）',
      `页面宽=${phoneChat.scrollW}/视口=${phoneChat.innerW} 聊天按钮可见=${phoneChat.chatBtnVisible} 宽=${phoneChat.chatBtnW}px 快捷聊天=${phoneChat.quickCount}个/${phoneChat.quickRows}行 overflow-x=${phoneChat.quickOverflowX} 自身可滚=${phoneChat.quickScrolls} 常驻聊天条=${phoneChat.stripDisplay} 聊天块右缘=${phoneChat.blockRight}`,
    );
    }

    /*
     * G20（窄屏未读角标）**不在这里测了** —— 它挪到真人对局那一段。
     *
     * 原因：角标要的是「**对方**发来一条普通聊天」，而**观战者发不了普通聊天**
     * （服务端只让观战者发快捷聊天：前端聊天按钮的提示也是
     * 「聊天（观战只能发快捷聊天，不能打字）」）。
     * 而快捷聊天**故意不进记录、也不算未读**。
     *
     * 所以人机局里根本没有能触发这条角标的「对方」——
     * 那局里除了浏览器就是电脑，电脑不发聊天。
     * 真人对局里对手是**真玩家**，能发普通聊天，才造得出这个场景。
     */

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    /* ---------------- G12：正方形视口按「窄屏」处理 ---------------- */
    if (gateEnabledAny(["G12"])) {
    /*
     * 用户原话：「如果屏幕刚好也是正方形，那就认为它是窄屏幕，
     * 减小棋盘的长宽吧，因为把它放在上面和下面。」
     * 正方形视口 → 必须走窄屏（HUD 上 / 聊天下），不能走左右分列。
     */
    const layoutSquare = await evaluate<{
      hud: Box | null;
      chat: Box | null;
      board: Box | null;
      stageClass: string;
    }>(`
      (() => {
        const br = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        return {
          hud: br('.hud'), chat: br('.col-chat'), board: br('.board-frame'),
          stageClass: document.querySelector('.stage')?.className ?? '',
        };
      })()
    `);
    writeFileSync(join(OUT_DIR, '2d-square.png'), Buffer.from(await shot({ x: 0, y: 0, w: 1000, h: 1000 }), 'base64'));
    if (layoutSquare.hud && layoutSquare.board && layoutSquare.chat) {
      const relHud = relation(layoutSquare.hud, layoutSquare.board);
      const relChat = relation(layoutSquare.chat, layoutSquare.board);
      verdict(
        layoutSquare.stageClass.includes('layout-narrow') &&
          relHud === 'above' &&
          relChat === 'below',
        'G12 正方形视口按窄屏处理（HUD 上 / 聊天下）',
        `stage="${layoutSquare.stageClass}" HUD→棋盘=${relHud} 聊天→棋盘=${relChat}`,
      );
    } else {
      verdict(false, 'G12 正方形视口按窄屏处理（HUD 上 / 聊天下）', '取不到元素');
    }
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    const layoutTall = await evaluate<{
      hud: Box | null;
      chat: Box | null;
      board: Box | null;
      stageClass: string;
      scroll: { h: number; vh: number };
    }>(`
      (() => {
        const br = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        return {
          hud: br('.hud'), chat: br('.col-chat'), board: br('.board-frame'),
          stageClass: document.querySelector('.stage')?.className ?? '',
          scroll: { h: document.documentElement.scrollHeight, vh: window.innerHeight },
        };
      })()
    `);
    /* ---------------- G13：窄屏时棋盘确实被缩小 ---------------- */
    if (gateEnabledAny(["G13"])) {
    /*
     * 用户原话：「屏幕窄的话上下就会有空隙……减小棋盘的长宽，
     * 因为把它放在上面和下面。」
     *
     * 取视口 900×700（短而宽 → 两侧放不下两列 → 落窄屏）：
     * 此时棋盘是**被高度**限制的（宽度还富余），所以棋盘边长直接反映
     * 「上下两块吃掉了多少纵向空间」。
     * 判据：① HUD 在上、聊天在下；② 棋盘边长 ≤ 视口高 - 200。
     */
    if (layoutTall.hud && layoutTall.board && layoutTall.chat) {
      const side = Math.min(layoutTall.board.w, layoutTall.board.h);
      const relHud = relation(layoutTall.hud, layoutTall.board);
      const relChat = relation(layoutTall.chat, layoutTall.board);
      verdict(
        layoutTall.stageClass.includes('layout-narrow') &&
          relHud === 'above' &&
          relChat === 'below' &&
          side <= 700 - 200,
        'G13 窄屏：棋盘被缩小，上下让出空间',
        `stage="${layoutTall.stageClass}" 棋盘边长=${Math.round(side)}px（视口高 700，上限 500）` +
          ` HUD→棋盘=${relHud} 聊天→棋盘=${relChat}`,
      );
    } else {
      verdict(false, 'G13 窄屏：棋盘被缩小，上下让出空间', '取不到元素');
    }
    }

    /* ---------------- G14：两种布局都不出现纵向滚动 ---------------- */
    if (gateEnabledAny(["G14"])) {
    /*
     * 棋盘是这页的主角 —— 页面一旦能纵向滚，棋盘就看不全。
     * 宽屏（1600×1000）与窄屏（900×700）都必须「一屏放完」。
     */
    const wideScroll = layoutWide.scroll;
    const narrowScroll = layoutTall.scroll;
    const wideSide = layoutWide.board ? Math.min(layoutWide.board.w, layoutWide.board.h) : 0;
    const narrowSide = layoutTall.board ? Math.min(layoutTall.board.w, layoutTall.board.h) : 0;
    verdict(
      wideScroll.h <= wideScroll.vh + 2 && narrowScroll.h <= narrowScroll.vh + 2,
      'G14 宽屏 / 窄屏都不出现纵向滚动',
      `宽屏：页面 ${wideScroll.h} / 视口 ${wideScroll.vh}（棋盘 ${Math.round(wideSide)}px）` +
        `｜窄屏：页面 ${narrowScroll.h} / 视口 ${narrowScroll.vh}（棋盘 ${Math.round(narrowSide)}px）`,
    );
    }

    /* ---------------- G11：贴在棋盘上方的元素不许带投影 ---------------- */
    if (gateEnabledAny(["G11"])) {
    /*
     * 用户要求「不要遮住棋盘」。信息栏（常驻 HUD + 消息条）就贴在棋盘正上方，
     * 窄屏时右侧按钮列也会挪到棋盘上方 —— 它们的 z-index 高于画布，
     * 一旦带投影，投影就会**直接盖在棋盘顶部**（实测把 3D 画布上沿压暗 7%）。
     */
    const shadowBad = [...layoutWide.shadow.bad, ...layoutNarrow.shadow.bad];
    const shadowChecked = [...layoutWide.shadow.checked, ...layoutNarrow.shadow.checked];
    verdict(
      shadowBad.length === 0,
      'G11 贴在棋盘上方的元素没有投影',
      shadowBad.length === 0
        ? `已检查 ${shadowChecked.length} 个贴在棋盘上方的元素（宽屏 ${layoutWide.shadow.checked.length} / 窄屏 ${layoutNarrow.shadow.checked.length}）· 全部无投影`
        : `带投影的：${shadowBad.join('、')}`,
    );

    }

    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);

    /* ---------------- 切 3D ---------------- */
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.trim() === '3D');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(3500);
    await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`);
    await sleep(200);

    const canvasBox = await evaluate<Box | null>(`
      (() => {
        const c = document.querySelector('canvas');
        if (!c) return null;
        const b = c.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      })()
    `);
    if (!canvasBox) throw new Error('3D 画布没出现');
    writeFileSync(join(OUT_DIR, '3d-board.png'), Buffer.from(await shot({ x: 0, y: 0, w: VIEW_W, h: VIEW_H }), 'base64'));
    /* ---------------- G5：3D 箭头可见性（像素） ---------------- */
    if (gateEnabledAny(["G5"])) {
    const dpr = await evaluate<number>(`window.devicePixelRatio || 1`);
    const region = {
      x: Math.round(canvasBox.x * dpr),
      y: Math.round(canvasBox.y * dpr),
      w: Math.round(canvasBox.w * dpr),
      h: Math.round(canvasBox.h * dpr),
    };
    const canvasShot = await shot(canvasBox);
    const stats = await evaluate<{ gt100: number; gt125: number; gt150: number; maxDiff: number }>(
      `(${ORANGE_FN})(${JSON.stringify(canvasShot)}, ${JSON.stringify(region)})`,
      true,
    );
    // 门禁：强橙色像素 ≥ 500（设备像素）。实测正常值 ≈ 3000，
    // 箭头被棋子吞光时 ≈ 0 —— 差一个数量级，门槛卡得住。
    verdict(
      stats.gt125 >= 500,
      'G5 3D 箭头可见',
      `强橙色像素 r-b>125：${stats.gt125}（门槛 500）· >150：${stats.gt150} · 最大 r-b=${stats.maxDiff}`,
    );
    }

    /* ---------------- G10：3D 画布顶边必须和画布中部一样干净 ---------------- */
    if (gateEnabledAny(["G10", "G6", "G7"])) {
    /*
     * 用户要求「不要遮住棋盘」。信息栏就贴在画布正上方，它的投影一旦盖下来，
     * 画布**顶边**会被染黑（实测 203,212,222 → 189,195,201，只黑最上面 2~3 行）。
     *
     * 判据（为什么这么取样，都是实测出来的）：
     *   · 3D 画布里，棋盘只占 97%，**最上面十几行必然是纯场景底色**；
     *   · 画布四角有一圈 8px 的木色外框，取样要避开（所以 x 从 +2% 起）；
     *   · 信息栏是**左右分开**的（左边 HUD、右边消息条），
     *     所以要在画布宽度上**多点取样**，不能只看一头；
     *   · 投影只染黑 2~3 行，占一块 13 行取样块的 15% ——
     *     众数仍是干净的底色，**必须用 5% 分位数**才看得出来。
     */
    const blockOf = async (box: Box): Promise<{ mode: number[]; ratio: number; p5: number[] }> => {
      const png = await shot(box);
      // 截图的裁剪尺寸是取整过的，取样区域必须跟它**完全一致**，
      // 否则会出现「纯背景占比 106%」这种算错的口径（分母比实际像素还小）。
      const region = { x: 0, y: 0, w: Math.round(box.w) * 2, h: Math.round(box.h) * 2 };
      return evaluate(`(${BLOCK_FN})(${JSON.stringify(png)}, ${JSON.stringify(region)})`, true);
    };
    // 参考块：画布中段左侧 —— 那里同样是纯场景底色，且不会被任何浮层盖到
    /**
     * 量「画布顶边有没有被压暗」。
     *
     * 宽屏和窄屏**都要量**：只有窄屏时 HUD 才贴在画布正上方，
     * 只量宽屏的话这条门禁就成了空转。
     *
     * 取样口径（踩过的坑）：
     *   - 取样带必须**贴着画布最顶上几行**，否则会采到棋盘自己的远端边
     *     （棋盘内容在画布里占 99% 左右，最上面只有 ~1% 是天空）；
     *   - 带宽按画布高度**自适应**（画布越矮，天空带越窄），
     *     所以窄屏的小画布也不会采到棋盘；
     *   - 带太薄（几行）时 p5 取到的就是**最小值** —— 正好是「被染黑的那几行」。
     */
    const probeTopEdge = async (
      w: number,
      h: number,
    ): Promise<{ worst: number; detail: string; refRatio: number }> => {
      await cdp!.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(900);
      const box = await evaluate<Box | null>(`
        (() => {
          const c = document.querySelector('canvas');
          if (!c) return null;
          const b = c.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        })()
      `);
      if (!box) return { worst: 999, detail: '取不到画布', refRatio: 0 };
      // 天空带：画布高度的 0.4%，夹在 1.5 ~ 6px 之间
      const bandH = Math.min(6, Math.max(1.5, box.h * 0.004));
      const ref = await blockOf({
        x: box.x + 6,
        y: box.y + box.h * 0.45,
        w: 20,
        h: bandH,
      });
      const diffs: string[] = [];
      let worst = 0;
      for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const px = Math.round(box.x + box.w * frac);
        const s = await blockOf({ x: px, y: box.y, w: 20, h: bandH });
        const d = Math.max(...[0, 1, 2].map((k) => Math.abs(s.p5[k] - ref.p5[k])));
        worst = Math.max(worst, d);
        diffs.push(`x+${Math.round(px - box.x)}:${d}`);
      }
      return {
        worst,
        detail:
          `画布 ${Math.round(box.w)}×${Math.round(box.h)}，取样带 ${bandH.toFixed(1)}px · ` +
          `参考 p5=rgb(${ref.p5})（纯背景 ${(ref.ratio * 100).toFixed(0)}%）· ` +
          `顶边各取样点与参考的差 ${diffs.join(' ')} · 最大 ${worst}`,
        refRatio: ref.ratio,
      };
    };
    const wideEdge = await probeTopEdge(VIEW_W, VIEW_H);
    const narrowEdge = await probeTopEdge(900, 700);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);
    const worstG10 = Math.max(wideEdge.worst, narrowEdge.worst);
    verdict(
      worstG10 <= 4 && wideEdge.refRatio > 0.8 && narrowEdge.refRatio > 0.8,
      'G10 3D 画布顶边没被浮层压暗',
      `宽屏：${wideEdge.detail}｜窄屏：${narrowEdge.detail}（门槛 4）`,
    );

    /* ---------------- G6 / G7：3D 下 HUD 不能压到最左边那一列棋子 ---------------- */
    /**
     * 3D 里棋盘是**斜着投影**的：画布左边缘到最左一列棋子之间有一段天空，
     * HUD 浮在那段天空里是安全的（用户截图里绿框 1 的位置）。
     * 但画布再窄，HUD 就会伸到棋子上面 —— 所以按「最左棋子列的位置」判。
     */
    const check3dHud = async (w: number, h: number): Promise<{ overlap: boolean; detail: string }> => {
      await cdp!.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(900);
      return evaluate<{ overlap: boolean; detail: string }>(`
        (() => {
          const hud = document.querySelector('.hud');
          const canvas = document.querySelector('canvas');
          if (!hud || !canvas) return { overlap: false, detail: '取不到元素' };
          const hb = hud.getBoundingClientRect();
          const cb = canvas.getBoundingClientRect();
          const leftmostX = cb.left + cb.width * 0.24;
          const overlap = hb.right > leftmostX && hb.bottom > cb.top && cb.bottom > hb.top;
          return {
            overlap,
            detail: 'HUD右边=' + hb.right.toFixed(0) + ' 最左棋子列=' + leftmostX.toFixed(0) +
              ' 画布=' + cb.left.toFixed(0) + '..' + cb.right.toFixed(0) +
              ' HUD位置=' + getComputedStyle(hud).position,
          };
        })()
      `);
    };
    const wide3d = await check3dHud(VIEW_W, VIEW_H);
    const narrow3d = await check3dHud(900, 1200);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);
    verdict(!wide3d.overlap, 'G6 3D 宽屏 HUD 不压最左一列棋子', wide3d.detail);
    verdict(!narrow3d.overlap, 'G7 3D 窄屏 HUD 不压最左一列棋子', narrow3d.detail);

    /* ---------------- 弹幕截图 ---------------- */
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.rail-quick-btn')].find((b) => b.textContent?.includes('好棋'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(700);
    writeFileSync(join(OUT_DIR, 'danmaku.png'), Buffer.from(await shot({ x: 0, y: 0, w: VIEW_W, h: VIEW_H }), 'base64'));

    /* ================================================================
     * 阶段十一：求和 / 悔棋 / 认输 / 滚动条
     * ================================================================ */
    /*
     * 这一整段在**另一个房间**里测。
     *
     * 为什么必须换房间：求和、悔棋的「同意 / 反对」是**对面**发起的，
     * 而人机对局里电脑会**直接拒绝**和棋、**自动同意**悔棋 ——
     * 「对方请求 → 我方回应」这条路径根本触发不了。
     * 所以这里让一个 ws 客户端当对手，跟浏览器真人真事地对上一局。
     *
     * 顺序（每一步都依赖上一步的结果，不能换）：
     *   G22 按钮顺序 → G21 聊天洪水 → G27 我方求和 → G24 对方求和
     *   → G26 浮层不撑页面 → G25 悔棋撤销 → G28 我方发起悔棋
     *   → G23 认输二次确认（最后一步才结束对局）
     */

    }

    // 切回 2D（前面刚测完 3D）
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '2D');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(900);

    // 对手（ws 客户端）创建房间 → 浏览器进去（**执色由抽签定**，不再是「浏览器永远执黑」）
    const oppWsUrl = `${APP_URL.replace(/^http/, 'ws')}/ws`;
    const opp = new WebSocket(oppWsUrl);
    const oppMsgs: any[] = [];
    opp.on('message', (raw) => {
      try {
        oppMsgs.push(JSON.parse(String(raw)));
      } catch {
        /* 忽略非 JSON */
      }
    });
    await new Promise<void>((resolve, reject) => {
      opp.once('open', () => resolve());
      opp.once('error', reject);
    });
    opp.send(JSON.stringify({ t: 'hello', name: '对手乙' }));
    for (let i = 0; i < 40 && !oppMsgs.some((m) => m.t === 'session'); i += 1) await sleep(150);
    opp.send(JSON.stringify({ t: 'room.create' }));
    let oppCode = '';
    for (let i = 0; i < 40 && !oppCode; i += 1) {
      await sleep(150);
      const rm = oppMsgs.find((m) => m.t === 'room');
      if (rm?.state?.code) oppCode = rm.state.code;
    }
    if (!oppCode) throw new Error('对手房间没建起来');
    console.log(`新房间（真人对局）：${oppCode}`);

    await cdp.send('Page.navigate', { url: `${APP_URL}/room/${oppCode}` });
    await waitForExpr(`location.pathname.toUpperCase().includes('${oppCode}')`, '跳转到新房间', 20000);
    /*
     * **真人对局现在不会自动开局** ——
     * 两人到齐那一刻服务端抽签定黑白，房间进入 `preparing`，
     * 然后**双方都点「准备」**才进 `playing`（白方先走）。
     *
     * 所以这里等的是「准备」按钮，**不能**等「认输」——
     * 认输按钮要到 `playing` 才有，在 `preparing` 里等它必然超时。
     * 房间状态用**对手收到的快照**判（不依赖页面 DOM）。
     */
    await waitRoomStatus(oppMsgs, 'preparing', 20000);
    await waitForExpr(
      // 只等「准备」按钮 —— 它在 `preparing` 阶段是 HUD 里唯一的按钮，
      // 出现即说明「抽签完成、双方各就各位」。
      `[...document.querySelectorAll('.hud-actions button')].some((b) => (b.textContent ?? '').trim() === '准备')`,
      '新房间 HUD 出现「准备」按钮',
      20000,
    );
    // 浏览器点「准备」
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '准备');
        if (btn) btn.click();
        return true;
      })()
    `);
    // 对手点「准备」
    opp.send(JSON.stringify({ t: 'ready' }));
    // 双方都准备 → 真的开局
    const playingRoom = await waitRoomStatus(oppMsgs, 'playing', 20000);
    await sleep(600);

    /*
     * **执色是抽签定的** —— 对手可能是白也可能是黑，浏览器反之。
     * 后面凡是「某一方走一步」的地方，都按它**实际**执什么颜色来走自己的兵。
     * 拿法：房间快照里的座位名字（`state.seats.w.name` / `state.seats.b.name`）。
     */
    const oppSide = sideOfName(playingRoom, '对手乙');
    if (!oppSide) throw new Error('房间快照里找不到「对手乙」的座位（抽签结果异常）');
    const browserSide: 'w' | 'b' = oppSide === 'w' ? 'b' : 'w';
    const oppStep = pawnStep(oppSide);
    const browserStep = pawnStep(browserSide);
    console.log(
      `🎲 抽签结果：对手乙=执${oppSide === 'w' ? '白' : '黑'}，浏览器=执${browserSide === 'w' ? '白' : '黑'}`,
    );

    /*
     * 浏览器执白时，**开局就轮到它** —— 对手想走子，浏览器得先把回合让出去。
     *
     * 这一步是后面 G25 / G28 / G25c 的**共同前提**（共享准备动作），
     * 所以不能关进门禁块里 —— 少跑一组，后面的着法就接不上。
     *
     * 走的是 d2→d4：特意跟后面 G25c 要用的「浏览器自己的兵」（e2→e4）错开，
     * 这样那一步在后面还空着，悔棋才有「自己刚走的那一步」可悔。
     */
    if (browserSide === 'w') {
      await browserMove('d2', 'd4');
      await waitForExpr(
        `(document.querySelector('.hud-status')?.innerText ?? '').includes('等待对手走棋')`,
        '浏览器先走一步（把回合交给对手）',
        10000,
      );
    }
    /* ---------------- G22：HUD 按钮顺序 ---------------- */
    if (gateEnabledAny(["G22"])) {
    const btnOrder = await evaluate<string[]>(`
      [...document.querySelectorAll('.hud-actions button')].map((b) => (b.textContent ?? '').trim())
    `);
    verdict(
      btnOrder[0] === '认输' && btnOrder[1] === '提议和棋' && btnOrder[2] === '悔棋',
      'G22 HUD 按钮顺序：认输 / 提议和棋 / 悔棋',
      `实际顺序：${btnOrder.join(' → ')}${btnOrder[2] === '悔棋' ? '' : '（悔棋按钮不见了！）'}`,
    );
    }

    if (gateEnabledAny(["G21"])) {
    /* ---------------- G21：聊天内容变多，页面不许出纵向滚动条 ---------------- */
    /*
     * 用户原话：「当聊天内容变多之后，这里出现了一个全页面的滚动条，
     * 这是有问题的，应该只是聊天内容里有滚动条。」
     *
     * 所以这里让对手连发 30 条**长**消息，把记录区真的撑爆，然后断言：
     *   ① 整个页面高度不超过视口（没有整页滚动条）；
     *   ② 记录区**内部**出现滚动（scrollHeight > clientHeight）。
     * 只断言 ① 是不够的 —— 记录区被压扁成 0 高也能满足 ①，那不是「可读」。
     */
    for (let i = 0; i < 10; i += 1) {
      opp.send(
        JSON.stringify({
          t: 'chat',
          text: `第 ${i + 1} 条：这条消息故意写得很长很长很长很长很长很长很长，用来把聊天记录区撑满，验证记录区自己滚动、页面不出现纵向滚动条。`,
        }),
      );
      // 服务端有 800ms 的发言间隔限制（CHAT_MIN_INTERVAL_MS），发太快会被丢
      await sleep(880);
    }
    await sleep(900);
    const flood = await evaluate<{
      pageH: number;
      vh: number;
      vw: number;
      stageW: number;
      logScroll: number;
      logClient: number;
      msgs: number;
      layout: string;
      diag: string;
    }>(`
      (() => {
        const log = document.querySelector('.chat-log');
        const stage = document.querySelector('.stage');
        const kids = [...(log?.children ?? [])];
        const sum = kids.reduce((a, el) => a + el.getBoundingClientRect().height, 0);
        const first = kids[0];
        const cs = first ? getComputedStyle(first) : null;
        return {
          pageH: document.documentElement.scrollHeight,
          vh: window.innerHeight,
          vw: window.innerWidth,
          stageW: stage ? Math.round(stage.getBoundingClientRect().width) : 0,
          logScroll: log ? log.scrollHeight : 0,
          logClient: log ? log.clientHeight : 0,
          msgs: document.querySelectorAll('.chat-log .msg').length,
          layout: stage?.className ?? '',
          diag:
            '子项高=' + kids.map((k) => Math.round(k.getBoundingClientRect().height)).join(',') +
            ' 合计=' + Math.round(sum) +
            ' 首项文字长=' + (first?.textContent?.length ?? 0) +
            ' 首项minHeight=' + (cs?.minHeight ?? '-') +
            ' 首项flexShrink=' + (cs?.flexShrink ?? '-') +
            ' 记录区宽=' + (log ? Math.round(log.getBoundingClientRect().width) : 0),
        };
      })()
    `);
    verdict(
      flood.layout.includes('layout-wide') &&
        flood.pageH <= flood.vh + 2 &&
        flood.logScroll > flood.logClient &&
        flood.msgs >= 8,
      'G21 宽屏：聊天内容变多只在记录区内部滚动，页面不出现纵向滚动条',
      `布局=${flood.layout || '（无）'}｜视口 ${flood.vw}×${flood.vh}｜舞台宽 ${flood.stageW}｜页面 ${flood.pageH}｜记录区 内容 ${flood.logScroll} / 可视 ${flood.logClient}（内部滚动=${flood.logScroll > flood.logClient}）｜消息 ${flood.msgs} 条｜${flood.diag}`,
    );
    }

    /* ---------------- G20：对方发来新消息 → 聊天按钮右上角出角标 ---------------- */
    if (gateEnabledAny(["G20", "G20b"])) {
    /*
     * 「对方发来消息 → 窄屏右上角出未读角标」。
     *
     * **为什么挪到真人对局这一段**（原来在人机局里测）：
     *   角标要的是一条**普通聊天**，而**观战者只准发快捷聊天**
     *   （服务端的规矩；前端聊天按钮的提示也写着「观战只能发快捷聊天，不能打字」），
     *   而快捷聊天**故意不进记录、也不算未读**。
     *   人机局里除了浏览器就是电脑 —— 电脑不发普通聊天，这条根本造不出来。
     *   真人对局里对手是**真玩家**，发得了普通聊天 ✓。
     *
     * 角标只在**窄屏**计数（宽屏记录常驻可见，一直看得见），
     * 所以这里把视口临时压到 430px，测完再放回宽屏。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    // 服务端对发言有 800ms 的间隔限制 —— 上一条（洪水那批）刚发完，等一下再发
    await sleep(900);
    const badgeText = '新消息来了，看看角标对不对。';
    const chatMsgBefore = oppMsgs.length;
    opp.send(JSON.stringify({ t: 'chat', text: badgeText }));
    /*
     * 等「这条消息真的到了房间」—— 用**对手自己收到的报文**判。
     *
     * **不等角标出现**：角标正是被测元素，拿它当等待条件的话，
     * 它一坏就变成「等超时」，门禁编号反而丢了（该红的时候不红）。
     */
    let chatArrived = false;
    for (let i = 0; i < 80 && !chatArrived; i += 1) {
      chatArrived = oppMsgs
        .slice(chatMsgBefore)
        .some((m: any) => m?.t === 'chat' && m?.message?.text === badgeText);
      if (!chatArrived) await sleep(100);
    }
    await sleep(400); // 浏览器那边再给一点渲染时间

    const badgeOn = await evaluate<{ exists: boolean; text: string; visible: boolean }>(`
      (() => {
        const b = document.querySelector('.chat-badge');
        const r = b?.getBoundingClientRect();
        return {
          exists: !!b,
          text: (b?.textContent ?? '').trim(),
          visible: !!r && r.width > 0 && r.height > 0,
        };
      })()
    `);
    verdict(
      chatArrived && badgeOn.exists && badgeOn.visible && badgeOn.text === '1',
      'G20 窄屏：对方发来消息 → 聊天按钮右上角出现未读角标（1）',
      `消息到达=${chatArrived}｜角标存在=${badgeOn.exists} 可见=${badgeOn.visible} 文字="${badgeOn.text}"`,
    );

    // 打开弹层 → 角标应该消失
    await evaluate(`
      (() => {
        const btn = document.querySelector('.rail-chat');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(500);
    const badgeOff = await evaluate<{ exists: boolean; panelOpen: boolean }>(`
      (() => ({
        exists: !!document.querySelector('.chat-badge'),
        panelOpen: !!document.querySelector('.chat-panel'),
      }))()
    `);
    verdict(
      badgeOff.panelOpen && !badgeOff.exists,
      'G20b 打开聊天弹层后未读角标消失',
      `弹层打开=${badgeOff.panelOpen} 角标仍存在=${badgeOff.exists}`,
    );
    // 收起弹层 + 把视口放回宽屏，别影响后面的门禁
    await evaluate(`
      (() => {
        const btn = document.querySelector('.chat-panel-head button');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(200);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);
    }

    /* ---------------- G27：我方提议和棋 → 「等待对方回应」浮层 ---------------- */
    if (gateEnabledAny(["G27", "G27b"])) {
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '提议和棋');
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(
      `!!document.querySelector('.side-prompt[data-prompt="draw-waiting"]')`,
      '我方求和的等待浮层',
      8000,
    ).catch(() => undefined);
    const drawWaiting = await evaluate<{
      exists: boolean;
      buttons: string[];
      countdown: string;
    }>(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="draw-waiting"]');
        return {
          exists: !!el,
          buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
          countdown: (el?.querySelector('.side-prompt-countdown')?.textContent ?? '').trim(),
        };
      })()
    `);
    verdict(
      drawWaiting.exists && /^\d+ 秒$/.test(drawWaiting.countdown),
      'G27 我方提议和棋：右侧浮层显示「等待对方回应」+ 倒计时',
      `浮层存在=${drawWaiting.exists} 倒计时="${drawWaiting.countdown}" 按钮=${drawWaiting.buttons.join('、')}`,
    );
    // 对方反对 → 浮层消失
    opp.send(JSON.stringify({ t: 'draw.decline' }));
    await sleep(900);
    const drawWaitingGone = await evaluate<boolean>(
      `!document.querySelector('.side-prompt[data-prompt="draw-waiting"]')`,
    );
    verdict(drawWaitingGone, 'G27b 对方反对后，「等待对方回应」浮层消失', `浮层仍存在=${!drawWaitingGone}`);
    }

    /* ---------------- G24：对方提议和棋 → 右侧浮层「同意 / 反对」 ---------------- */
    if (gateEnabledAny(["G24"])) {
    opp.send(JSON.stringify({ t: 'draw.offer' }));
    await waitForExpr(
      `!!document.querySelector('.side-prompt[data-prompt="draw-incoming"]')`,
      '对方求和的右侧浮层',
      8000,
    ).catch(() => undefined);
    const drawIncoming = await evaluate<{
      exists: boolean;
      buttons: string[];
      countdown: string;
    }>(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="draw-incoming"]');
        return {
          exists: !!el,
          buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
          countdown: (el?.querySelector('.side-prompt-countdown')?.textContent ?? '').trim(),
        };
      })()
    `);
    verdict(
      drawIncoming.exists &&
        drawIncoming.buttons.includes('同意') &&
        drawIncoming.buttons.includes('反对') &&
        /^\d+ 秒$/.test(drawIncoming.countdown),
      'G24 对方求和：右侧浮层带「同意 / 反对」两个按钮 + 倒计时',
      `浮层存在=${drawIncoming.exists} 按钮=${drawIncoming.buttons.join('、')} 倒计时="${drawIncoming.countdown}"`,
    );
    }

    /* ---------------- G26：浮层是 fixed，不占文档流；页面里没有内联文字条 ---------------- */
    if (gateEnabledAny(["G26", "G24b"])) {
    /*
     * 用户原话：「目前在页面中突兀增加文本让页面有可能出现滚动条，这个不好。」
     * 所以两件事都要守住：
     *   ① 浮层容器是 `position: fixed`（不参与文档流 → 撑不出滚动条）；
     *   ② 页面里**没有**「对方提议和棋」这种内联文字条（老实现的 .result-banner 里的那一条）。
     */
    const promptLayout = await evaluate<{
      pos: string;
      pageH: number;
      vh: number;
      stray: number;
      boardHasDraw: boolean;
    }>(`
      (() => {
        const cont = document.querySelector('.side-prompts');
        // 「对方提议和棋」这行字只允许出现在右侧浮层里；
        // 老实现把它插在棋盘上方的横幅里（内联文本条）—— 那正是被投诉的东西。
        const stray = [...document.querySelectorAll('body *')].filter((el) => {
          if (el.closest('.side-prompts')) return false;
          if (el.children.length > 0) return false;
          return (el.textContent ?? '').includes('对方提议和棋');
        }).length;
        const board = document.querySelector('.board-panel');
        return {
          pos: cont ? getComputedStyle(cont).position : 'none',
          pageH: document.documentElement.scrollHeight,
          vh: window.innerHeight,
          stray,
          boardHasDraw: board ? (board.innerText ?? '').includes('和棋') : false,
        };
      })()
    `);
    verdict(
      promptLayout.pos === 'fixed' &&
        promptLayout.pageH <= promptLayout.vh + 2 &&
        promptLayout.stray === 0 &&
        !promptLayout.boardHasDraw,
      'G26 求和提示是右侧浮层（fixed），页面里没有内联文字条，也不撑出滚动条',
      `浮层 position=${promptLayout.pos}｜页面 ${promptLayout.pageH} / 视口 ${promptLayout.vh}｜浮层外的「对方提议和棋」文字 ${promptLayout.stray} 处｜棋盘区含「和棋」=${promptLayout.boardHasDraw}`,
    );

    // 点「反对」→ 浮层消失，对局继续
    await evaluate(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="draw-incoming"]');
        const btn = [...(el?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '反对');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(900);
    const afterDecline = await evaluate<{ prompt: boolean; status: string }>(`
      (() => ({
        prompt: !!document.querySelector('.side-prompt[data-prompt="draw-incoming"]'),
        status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
      }))()
    `);
    verdict(
      !afterDecline.prompt && !afterDecline.status.includes('已结束'),
      'G24b 点「反对」后求和浮层消失，对局继续',
      `浮层仍存在=${afterDecline.prompt} 状态="${afterDecline.status}"`,
    );
    }

    /* ---------------- G25：对方请求悔棋 → 同意后真的撤销那一步 ---------------- */
    if (gateEnabledAny(["G25", "G25b"])) {
    /*
     * 抽签之后「谁先走」变了，所以这一段的对局流程按**实际执色**安排：
     *
     *   · 对手要走的那一步 = **它自己那个兵**（白 e2→e4 / 黑 e7→e5）；
     *   · 悔棋请求只能由「刚走完那一步的人」发起（规则：只悔自己那一步），
     *     所以对手走子之前必须已经轮到它 ——
     *     浏览器执白时，上面那段准备动作已经先走了一步，把回合让给了对手。
     */
    opp.send(JSON.stringify({ t: 'move', from: oppStep.from, to: oppStep.to }));
    await sleep(1100);
    const movedState = await evaluate<{ last: number; from: string; to: string }>(`
      (() => {
        const pieceAt = (sq) => {
          const s = document.querySelector('[data-square="' + sq + '"]');
          if (!s) return '';
          const r = s.getBoundingClientRect();
          const pieces = [...document.querySelectorAll('.piece')].map((p) => {
            const b = p.getBoundingClientRect();
            return { cls: p.className, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
          });
          const hit = pieces.find(
            (p) => Math.abs(p.cx - (r.left + r.width / 2)) < r.width / 2 && Math.abs(p.cy - (r.top + r.height / 2)) < r.height / 2,
          );
          return hit ? hit.cls : '';
        };
        return {
          last: document.querySelectorAll('.square.lastmove').length,
          from: pieceAt('${oppStep.from}'),
          to: pieceAt('${oppStep.to}'),
        };
      })()
    `);
    opp.send(JSON.stringify({ t: 'takeback.offer' }));
    await waitForExpr(
      `!!document.querySelector('.side-prompt[data-prompt="takeback-incoming"]')`,
      '对方悔棋的右侧浮层',
      8000,
    ).catch(() => undefined);
    const tbPrompt = await evaluate<{ exists: boolean; buttons: string[] }>(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="takeback-incoming"]');
        return {
          exists: !!el,
          buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
        };
      })()
    `);
    verdict(
      tbPrompt.exists && tbPrompt.buttons.includes('同意') && tbPrompt.buttons.includes('反对'),
      'G25 对方请求悔棋：右侧浮层带「同意 / 反对」两个按钮',
      `浮层存在=${tbPrompt.exists} 按钮=${tbPrompt.buttons.join('、')}`,
    );
    // 点「同意」→ 那一步必须真的被撤销（对手的兵退回原位，高亮也不再是那一步）
    await evaluate(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="takeback-incoming"]');
        const btn = [...(el?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '同意');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(1200);
    const undone = await evaluate<{ marks: string[]; from: string; to: string; prompt: boolean }>(`
      (() => {
        const pieceAt = (sq) => {
          const s = document.querySelector('[data-square="' + sq + '"]');
          if (!s) return '';
          const r = s.getBoundingClientRect();
          const pieces = [...document.querySelectorAll('.piece')].map((p) => {
            const b = p.getBoundingClientRect();
            return { cls: p.className, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
          });
          const hit = pieces.find(
            (p) => Math.abs(p.cx - (r.left + r.width / 2)) < r.width / 2 && Math.abs(p.cy - (r.top + r.height / 2)) < r.height / 2,
          );
          return hit ? hit.cls : '';
        };
        return {
          marks: [...document.querySelectorAll('.square.lastmove')].map((el) => el.getAttribute('data-square') ?? ''),
          from: pieceAt('${oppStep.from}'),
          to: pieceAt('${oppStep.to}'),
          prompt: !!document.querySelector('.side-prompt[data-prompt="takeback-incoming"]'),
        };
      })()
    `);
    /*
     * 判据（按**对手实际执色**来判，不写死「白兵 / e2」）：
     *   ① 那一步**真的走出去了** —— 对手的兵到了目的地；
     *   ② 同意悔棋后它**回到原位**；
     *   ③ 目的地已经空出来；
     *   ④ **被撤销的那一步不再被高亮**。
     *
     * ① 是**执色自适应自己的体检**：如果这里按错了颜色（走错色的兵会被服务端拒掉），
     * ① 就不成立 —— 这条门禁会红，而不是「什么都没发生也算过」。
     *
     * ④ 原来写的是「高亮格数 === 0」——
     * 浏览器执白时它自己先走过一步，高亮理应还留着**它那一步**，
     * 所以这里改成「高亮里不含被撤销的那一步」：撤销成功就一定成立，
     * 撤销没生效（高亮还指着对手那一步）就一定不成立。
     */
    const oppPieceCls = oppSide === 'w' ? 'piece w' : 'piece b';
    verdict(
      movedState.to.includes(oppPieceCls) &&
        undone.from.includes(oppPieceCls) &&
        !undone.to.includes(oppPieceCls) &&
        !undone.marks.includes(oppStep.from) &&
        !undone.marks.includes(oppStep.to),
      'G25b 同意悔棋后，那一步真的被撤销（对手的兵退回原位）',
      `撤销前：${oppStep.from}="${movedState.from}" ${oppStep.to}="${movedState.to}"（高亮 ${movedState.last} 格）` +
        `｜撤销后：${oppStep.from}="${undone.from}" ${oppStep.to}="${undone.to}"｜高亮格=[${undone.marks.join(',')}]` +
        `（不该再含被撤销的 ${oppStep.from}/${oppStep.to}）`,
    );
    }

    /* ---------------- G28：我方点「悔棋」→ 对手真的收到了这个请求 ---------------- */
    if (gateEnabledAny(["G28", "G25c"])) {
    /*
     * G25 抓的是「**对方**发起 → 我方回应」，那条路径里浏览器的「悔棋」按钮根本没被点。
     * 用户要的是「**我方**点悔棋 → 对方同意后可以悔一步」，所以这里补上另一半：
     * 浏览器自己走一步（必须自己走过棋，服务端才允许悔棋），
     * 再点 HUD 上的「悔棋」，断言：
     *   ① 浏览器自己出现「等待对方回应」的右侧浮层；
     *   ② **对手（ws）真的收到了 takeback 请求**（room 快照里带 takebackOffer）。
     */
    opp.send(JSON.stringify({ t: 'move', from: oppStep.from, to: oppStep.to }));
    await sleep(900);
    }

    /* ---------------- G25c：悔棋按钮只在「自己刚走完那一步」时可点 ---------------- */
    if (gateEnabledAny(["G25c", "G28"])) {
    /*
     * 规则（用户拍板）：悔棋**只撤销你自己走的那一步**，对方同意后轮到你重走。
     * 所以只有「我刚走完、对方还没回应」时才能悔 ——
     * 对方一旦回应，这一步就锁死了（对方的着法是踩在我那步上算的）。
     *
     * 此刻：对手刚走完它那一步（${oppStep.from}→${oppStep.to}），轮到浏览器 ——
     * 浏览器还没走过那一步，所以它的「悔棋」按钮必须是**禁用**的。
     */
    const tbBtnState = await evaluate<{ exists: boolean; disabled: boolean }>(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '悔棋');
        return { exists: !!btn, disabled: !!btn && btn.disabled === true };
      })()
    `);
    verdict(
      tbBtnState.exists && tbBtnState.disabled,
      'G25c 悔棋按钮：对方刚走完时是**禁用**的（只能悔自己刚走的那一步）',
      `悔棋按钮存在=${tbBtnState.exists} 已禁用=${tbBtnState.disabled}`,
    );

    // 浏览器走**自己那个兵**（白 e2→e4 / 黑 e7→e5）—— 走完这一步它才有得可悔
    await browserMove(browserStep.from, browserStep.to);
    await waitForExpr(
      `(document.querySelector('.hud-status')?.innerText ?? '').includes('等待对手走棋')`,
      `浏览器走出 ${browserStep.from}→${browserStep.to}`,
      10000,
    );
    const oppMsgsBefore = oppMsgs.length;
    const myTbBtn = await evaluate<{ exists: boolean; disabled: boolean }>(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '悔棋');
        return { exists: !!btn, disabled: !!btn && btn.disabled === true };
      })()
    `);
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '悔棋');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(1200);
    const myTb = await evaluate<{ prompt: boolean; text: string }>(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="takeback-waiting"]');
        return { prompt: !!el, text: (el?.textContent ?? '').replace(/\\s+/g, ' ').trim() };
      })()
    `);
    const oppGotOffer = oppMsgs
      .slice(oppMsgsBefore)
      .some((m: any) => m?.t === 'room' && m?.state?.takebackOffer);
    verdict(
      myTb.prompt && oppGotOffer && myTbBtn.exists && !myTbBtn.disabled,
      'G28 我方点「悔棋」：对手真的收到了悔棋请求（我方也弹出等待浮层）',
      `我方等待浮层=${myTb.prompt}（${myTb.text.slice(0, 40)}）｜对手收到 takebackOffer=${oppGotOffer}｜按钮可点=${myTbBtn.exists && !myTbBtn.disabled}`,
    );
    // 收尾：让对手拒绝，清掉这条待回应请求（后面的认输门禁要求房间是干净的在下状态）
    opp.send(JSON.stringify({ t: 'takeback.decline' }));
    await sleep(800);
    }

    /* ---------------- G23：认输二次确认 ---------------- */
    if (gateEnabledAny(["G23", "G23b", "G23c"])) {
    /*
     * 用户原话：「认输需要二次确认，不然可能会手误点到。」
     * 所以：点「认输」**不能**直接结束对局 —— 必须先出右侧浮层，
     * 确认后才结束；点「取消」则一切照旧。
     */
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '认输');
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(`!!document.querySelector('.side-prompt[data-prompt="resign"]')`, '认输二次确认浮层', 8000).catch(
      () => undefined,
    );
    const resignAsk = await evaluate<{
      exists: boolean;
      buttons: string[];
      status: string;
    }>(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="resign"]');
        return {
          exists: !!el,
          buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
          status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
        };
      })()
    `);
    verdict(
      resignAsk.exists &&
        resignAsk.buttons.includes('取消') &&
        resignAsk.buttons.includes('确认认输') &&
        !resignAsk.status.includes('已结束'),
      'G23 认输要二次确认：点一下只弹浮层，对局还在继续',
      `浮层存在=${resignAsk.exists} 按钮=${resignAsk.buttons.join('、')} 状态="${resignAsk.status}"`,
    );
    // 点「取消」→ 浮层消失，对局继续
    await evaluate(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="resign"]');
        const btn = [...(el?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '取消');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(700);
    const afterCancel = await evaluate<{ prompt: boolean; status: string }>(`
      (() => ({
        prompt: !!document.querySelector('.side-prompt[data-prompt="resign"]'),
        status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
      }))()
    `);
    verdict(
      !afterCancel.prompt && !afterCancel.status.includes('已结束'),
      'G23b 认输浮层点「取消」后什么都没发生',
      `浮层仍存在=${afterCancel.prompt} 状态="${afterCancel.status}"`,
    );
    // 再点认输 → 确认认输 → 这局才真的结束
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-actions button')]
          .find((b) => (b.textContent ?? '').trim() === '认输');
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(`!!document.querySelector('.side-prompt[data-prompt="resign"]')`, '认输二次确认浮层（二次）', 8000).catch(
      () => undefined,
    );
    await evaluate(`
      (() => {
        const el = document.querySelector('.side-prompt[data-prompt="resign"]');
        const btn = [...(el?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '确认认输');
        if (btn) btn.click();
        return true;
      })()
    `);
    await waitForExpr(
      `(document.querySelector('.hud-status')?.innerText ?? '').includes('已结束')`,
      '认输后对局结束',
      8000,
    ).catch(() => undefined);
    const afterResign = await evaluate<{ status: string; prompt: boolean }>(`
      (() => ({
        status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
        prompt: !!document.querySelector('.side-prompt[data-prompt="resign"]'),
      }))()
    `);
    verdict(
      afterResign.status.includes('已结束') && !afterResign.prompt,
      'G23c 点「确认认输」后这局才真的结束',
      `状态="${afterResign.status}" 浮层仍存在=${afterResign.prompt}`,
    );
    }

    /* ---------------- G29：「再来一局」按人显示在自己那一行 ---------------- */
    if (gateEnabledAny(["G29"])) {
    /*
     * 用户原话：「既然这里都显示两个用户，那这里点击再来一局就在点击的用户这里显示再来一局，
     * 然后就不让重复点击再来一局了。」
     *
     * 所以门禁盯四件事：
     *   ① HUD 里**没有**全局的「再来一局」按钮（两个人共用一个按钮 → 分不清是谁点的）；
     *   ② 可点的「再来一局」出现在**自己那一行**（自己 = 箭头验收员），对手那行没有；
     *   ③ 点一次之后自己那行变成「已申请」，**没有可点的按钮了**（不能重复点击）；
     *   ④ 对手也申请 → 双方同意 → 服务端直接开新局（按钮和「已申请」都消失）。
     */
    const rematchRows = await evaluate<{
      globalBtn: number;
      mine: { btn: number; voted: number; name: string };
      theirs: { btn: number; voted: number; name: string };
    }>(`
      (() => {
        const all = [...document.querySelectorAll('.hud-players .player-row')];
        const pick = (name) => all.find((r) => (r.querySelector('.name')?.textContent ?? '').includes(name));
        const info = (r) => r ? {
          btn: [...r.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '再来一局').length,
          voted: [...r.querySelectorAll('.rematch-voted')].length,
          name: (r.querySelector('.name')?.textContent ?? '').trim(),
        } : { btn: -1, voted: -1, name: '这一行没找到' };
        return {
          mine: info(pick('箭头验收员')),
          theirs: info(pick('对手乙')),
          globalBtn: [...document.querySelectorAll('.hud-actions button')]
            .filter((b) => (b.textContent ?? '').trim() === '再来一局').length,
        };
      })()
    `);
    verdict(
      rematchRows.globalBtn === 0 && rematchRows.mine.btn === 1 && rematchRows.theirs.btn === 0,
      'G29 「再来一局」按钮出现在**自己那一行**（HUD 里没有全局按钮）',
      `HUD 全局按钮=${rematchRows.globalBtn}｜我(${rematchRows.mine.name})行可点按钮=${rematchRows.mine.btn}｜对手(${rematchRows.theirs.name})行可点按钮=${rematchRows.theirs.btn}`,
    );
    }

    /* ---------------- G29d：长名字被截断 + 窄屏下按钮也不撑破布局 ---------------- */
    if (gateEnabledAny(["G29d", "G29e", "G29b", "G29c"])) {
    /*
     * 「再来一局」挤进玩家行之后，这一行的**横向空间**就紧张了：
     *   - **宽屏**（HUD 列只有 260px）：名字必须被**省略号截断**，而不是把行撑破；
     *   - **窄屏**（430px）：按钮仍然可见、不出视口、页面不出现横向滚动条。
     * 所以浏览器这一侧的用户名故意取一个很长的（'箭头验收员…名字'），
     * 短名字根本触发不了「挤爆」这个场景（第一版就栽在这：名字太短，门禁永远绿）。
     */
    const wideName = await evaluate<{
      rowScrollW: number;
      rowClientW: number;
      nameW: number;
      nameTruncated: boolean;
      nameScrollW: number;
      nameClientW: number;
      innerW: number;
      pageScrollW: number;
    }>(`
      (() => {
        const all = [...document.querySelectorAll('.hud-players .player-row')];
        const mine = all.find((r) => (r.querySelector('.name')?.textContent ?? '').includes('箭头验收员'));
        const nameEl = mine?.querySelector('.name');
        return {
          rowScrollW: mine?.scrollWidth ?? -1,
          rowClientW: mine?.clientWidth ?? -1,
          nameW: Math.round(nameEl?.getBoundingClientRect().width ?? -1),
          nameTruncated: !!nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1,
          nameScrollW: nameEl?.scrollWidth ?? -1,
          nameClientW: nameEl?.clientWidth ?? -1,
          innerW: window.innerWidth,
          pageScrollW: document.documentElement.scrollWidth,
        };
      })()
    `);
    verdict(
      wideName.nameTruncated && wideName.rowScrollW <= wideName.rowClientW + 1,
      'G29d 宽屏：长名字被省略号截断，玩家行没被撑破',
      `玩家行 ${wideName.rowScrollW}/${wideName.rowClientW}｜名字 ${wideName.nameScrollW}/${wideName.nameClientW}（可见 ${wideName.nameW}px）已截断=${wideName.nameTruncated}｜视口=${wideName.innerW} 页面宽=${wideName.pageScrollW}`,
    );
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    const narrowRematch = await evaluate<{
      btnVisible: boolean;
      btnRight: number;
      innerW: number;
      pageScrollW: number;
      rowScrollW: number;
      rowClientW: number;
      nameW: number;
      nameFits: boolean;
      rowH: number;
    }>(`
      (() => {
        const all = [...document.querySelectorAll('.hud-players .player-row')];
        const mine = all.find((r) => (r.querySelector('.name')?.textContent ?? '').includes('箭头验收员'));
        const btn = [...(mine?.querySelectorAll('button') ?? [])]
          .find((b) => (b.textContent ?? '').trim() === '再来一局');
        const br = btn?.getBoundingClientRect();
        const rr = mine?.getBoundingClientRect();
        return {
          btnVisible: !!br && br.width > 0 && br.height > 0,
          btnRight: br ? Math.round(br.right) : -1,
          innerW: window.innerWidth,
          pageScrollW: document.documentElement.scrollWidth,
          rowScrollW: mine?.scrollWidth ?? -1,
          rowClientW: mine?.clientWidth ?? -1,
          nameW: Math.round(mine?.querySelector('.name')?.getBoundingClientRect().width ?? -1),
          /*
           * 名字**不许被压没**：它得在自己的格子里占着位置（有宽度）。
           *
           * 早先这里断言的是「名字**必须已截断**」，那是更早一版设计留下的：
           * 那时名字被压到只剩省略号，测试名要加长才测得出问题。
           * 现在玩家名字**至少留 4 个字**（.player-row .who 里的 min-width: 4em），
           * 放不下就**换行**完整显示（实测行高 54px = 两行）—— 名字看得全，
           * 比截断更好，所以「必须截断」不再是该有的状态（这条断言与新设计互斥，
           * 上一轮改完一直没被发现 —— 门禁是红的，只是没跑全量）。
           *
           * 真正要守的是「**行不许被撑破**」：删掉那道 min-width: 4em，
           * 名字的最小组宽度变成文字宽度 → 玩家行被撑宽 → 整页出横向滚动条
           * （变异「窄屏玩家行撑破」守的就是这条）。
           */
          nameFits: (() => {
            const n = mine?.querySelector('.name');
            return !!n && n.getBoundingClientRect().width > 0;
          })(),
          rowH: rr ? Math.round(rr.height) : -1,
        };
      })()
    `);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);
    verdict(
      narrowRematch.btnVisible &&
        narrowRematch.btnRight > 0 &&
        narrowRematch.btnRight <= narrowRematch.innerW + 1 &&
        narrowRematch.pageScrollW <= narrowRematch.innerW + 1 &&
        narrowRematch.rowScrollW <= narrowRematch.rowClientW + 1 &&
        narrowRematch.nameW > 0 &&
        narrowRematch.nameFits,
      'G29e 窄屏（430px）：「再来一局」在玩家行里可见、不出视口、不撑出横向滚动条',
      `按钮可见=${narrowRematch.btnVisible} 右缘=${narrowRematch.btnRight}/视口=${narrowRematch.innerW} 页面宽=${narrowRematch.pageScrollW} 玩家行 ${narrowRematch.rowScrollW}/${narrowRematch.rowClientW} 名字宽=${narrowRematch.nameW}px 行高=${narrowRematch.rowH}px`,
    );

    // 点一次 → 我那行变成「已申请」，不能再点
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.hud-players .player-row button')]
          .find((b) => (b.textContent ?? '').trim() === '再来一局');
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(900);
    const afterVote = await evaluate<{ mineBtn: number; mineVoted: number; status: string }>(`
      (() => {
        const all = [...document.querySelectorAll('.hud-players .player-row')];
        const mine = all.find((r) => (r.querySelector('.name')?.textContent ?? '').includes('箭头验收员'));
        return {
          mineBtn: [...(mine?.querySelectorAll('button') ?? [])]
            .filter((b) => (b.textContent ?? '').trim() === '再来一局').length,
          mineVoted: [...(mine?.querySelectorAll('.rematch-voted') ?? [])].length,
          status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
        };
      })()
    `);
    verdict(
      afterVote.mineBtn === 0 && afterVote.mineVoted === 1,
      'G29b 点过一次之后：我那行变成「已申请」，不能重复点击',
      `我行可点按钮=${afterVote.mineBtn} 「已申请」标记=${afterVote.mineVoted} 状态="${afterVote.status}"`,
    );
    // 对手也申请 → 双方同意 → 服务端直接开新局
    opp.send(JSON.stringify({ t: 'rematch' }));
    await sleep(1400);
    const newGame = await evaluate<{ status: string; rematchBtn: number; voted: number }>(`
      (() => ({
        status: (document.querySelector('.hud-status')?.innerText ?? '').trim(),
        rematchBtn: [...document.querySelectorAll('.hud-players .player-row button')]
          .filter((b) => (b.textContent ?? '').trim() === '再来一局').length,
        voted: document.querySelectorAll('.rematch-voted').length,
      }))()
    `);
    verdict(
      !newGame.status.includes('已结束') && newGame.rematchBtn === 0 && newGame.voted === 0,
      'G29c 双方都申请 → 服务端直接开新局（按钮与「已申请」都消失）',
      `状态="${newGame.status}" 残留按钮=${newGame.rematchBtn} 残留「已申请」=${newGame.voted}`,
    );

    }
    opp.close();

    /* ---------------- 汇总 ---------------- */
    console.log('');
    if (selectedGroups) {
      console.log(`📦 本次分组：${selectedGroups.join('、')}（只跑这些组的门禁）`);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${'─'.repeat(56)}`);
    if (failed.length === 0) {
      console.log(`✅ 全部 ${results.length} 项通过`);
      console.log(`截图：${OUT_DIR}`);
    } else {
      console.log(`❌ ${failed.length}/${results.length} 项失败：`);
      for (const f of failed) console.log(`   · ${f.label} —— ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
