/**
 * 3D 视角深度验收（§9 D6）—— 用**真实 Chromium** 发原生 wheel / 拖拽事件。
 *
 * 为什么不用普通浏览器工具：
 *   滚轮缩放依赖 WebGL 画布收到的原生 `wheel` 事件（OrbitControls 通过它 dolly），
 *   而常规的「滚动页面」动作不会合成 wheel 到画布上，量不到相机距离变化。
 *   所以这里直接用 CDP（Chrome DevTools Protocol）驱动本机 Chromium，
 *   走 `Input.dispatchMouseEvent({type:'mouseWheel'})` 这条真实通路。
 *
 * 零新增依赖：复用项目已有的 `ws`；Chromium 用本机已有的 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 *
 * 判定指标（都在页面内计算，避免引入 PNG 解码依赖）：
 *   把截图解码成像素，统计「暖色木纹像素」——即棋盘格本身（棋子是中性灰，不计入）。
 *   · 缩放 → 棋盘在屏幕上的投影面积随相机距离变化
 *   · 旋转 → 棋盘投影的包围盒宽高 / 重心随方位角变化
 *
 * 用法：
 *   npx tsx scripts/verify-3d-viewport.ts [--url=http://127.0.0.1:3000]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { safeDistance } from '../src/lib/frame3d';

/**
 * 地址解析：**位置参数不能靠「位置」猜**（别的开关会被当成地址）。
 * 优先 `--url=`，其次第一个长得像 http 地址的位置参数 —— 和 verify-dm / verify-ui 等保持一致。
 *
 * 为什么改：原来只认 `process.argv[2]`，于是 `npm run verify:3d` 永远打 3000 端口。
 * 服务跑在别的端口时命令「跑完」但报的是「连接被拒」，看起来像门禁挂了，其实是打错端口。
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
const VIEW_W = 1280;
const VIEW_H = 900;

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
/* 页面内使用的脚本                                                     */
/* ------------------------------------------------------------------ */

/**
 * 在页面里量棋盘的像素投影指标。
 *
 * 只统计**画布区域**内的像素：
 *   - 画布是 WebGL 渲染的，棋盘格必然在画布里；
 *   - 页面上的暖色 UI（按钮、徽章）会污染整页统计，
 *     曾导致「拖拽旋转」指标恒定不变（误报旋转无效）。
 *
 * 两套口径，各管各的：
 *
 *  1. **内容包围盒**（非背景像素）→ 「棋盘有没有撑满画布」「有没有被裁掉」。
 *     背景是纯色 #191512，凡不是它的像素都是棋盘 / 棋子 / 阴影。
 *     这套口径直接量「玩家看到的棋盘」，是「大棋盘」这个硬指标的真值。
 *     （早先用「暖色木纹像素」量填充率，会漏掉阴影里的边框外环，
 *      横向少算约 4%，指标失真。）
 *
 *  2. **暖色木纹像素**（棋盘格纹理）→ 面积与重心，用于缩放 / 旋转的**变化量**判断。
 *     这套对「投影有没有变大/变形」很灵敏。
 *
 * region 用设备像素（左上角 + 宽高），由调用方按 devicePixelRatio 换算。
 */
const METRICS_FN = `
async (b64, region) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  let n = 0, sumX = 0, sumY = 0;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  // 「非背景」口径：画布背景是纯色 #191512，凡不是它的像素都是棋盘/棋子/阴影，
  // 用来判断**棋盘有没有把画布填满**以及**有没有东西被画布边缘裁掉**。
  let cMinX = 1e9, cMaxX = -1e9, cMinY = 1e9, cMaxY = -1e9, cn = 0;
  // 画布最外圈 1~2px 与页面做了混合，会被误判成「内容」→ 内缩几像素再扫
  const INSET = 3;
  const rx = region.x + INSET, ry = region.y + INSET;
  const rw = Math.max(1, region.w - INSET * 2), rh = Math.max(1, region.h - INSET * 2);

  // 先求画布区域的「众数色」= 背景色（three.js 会做色调映射，
  // 实际背景值并不等于 #191512，写死颜色会把整块画布都算成「内容」）
  const hist = new Map();
  for (let y = Math.max(0, ry); y < Math.min(bmp.height, ry + rh); y += 2) {
    for (let x = Math.max(0, rx); x < Math.min(bmp.width, rx + rw); x += 2) {
      const i = (y * bmp.width + x) * 4;
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  let bgKey = 0, bgBest = -1;
  for (const [k, v] of hist) { if (v > bgBest) { bgBest = v; bgKey = k; } }
  const bg = [((bgKey >> 10) & 31) << 3, ((bgKey >> 5) & 31) << 3, (bgKey & 31) << 3];

  for (let y = Math.max(0, ry); y < Math.min(bmp.height, ry + rh); y++) {
    for (let x = Math.max(0, rx); x < Math.min(bmp.width, rx + rw); x++) {
      const i = (y * bmp.width + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const isBg = Math.abs(r - bg[0]) < 12 && Math.abs(g - bg[1]) < 12 && Math.abs(b - bg[2]) < 12;
      if (!isBg) {
        cn++;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;
      }
      // 棋盘木纹是暖色（r 明显大于 b）；棋子是中性灰，背景近黑，都不计入
      if (r > 55 && r - b > 14 && g > 30) {
        n++; sumX += x; sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (n === 0) return { n: 0, area: 0, cx: 0, cy: 0, bw: 0, bh: 0, fillX: 0, fillY: 0, woodFillX: 0, woodFillY: 0, mTop: 0, mBottom: 0, mLeft: 0, mRight: 0, clip: 0, clipEdges: [] };
  return {
    n,
    area: n,
    cx: Math.round(sumX / n),
    cy: Math.round(sumY / n),
    bw: maxX - minX,
    bh: maxY - minY,
    // 棋盘（含边框、棋子、阴影）在画布里的填充率 —— 「大棋盘」的真值
    fillX: +((cMaxX - cMinX) / rw).toFixed(4),
    fillY: +((cMaxY - cMinY) / rh).toFixed(4),
    // 纯棋盘木纹的填充率（参考值）
    woodFillX: +((maxX - minX) / rw).toFixed(4),
    woodFillY: +((maxY - minY) / rh).toFixed(4),
    // 四周留白（像素）
    mLeft: cMinX - rx,
    mRight: rx + rw - 1 - cMaxX,
    mTop: cMinY - ry,
    mBottom: ry + rh - 1 - cMaxY,
    // 非背景内容贴边（= 有东西被裁）的边数
    clip: [cMinX <= rx, cMaxX >= rx + rw - 1, cMinY <= ry, cMaxY >= ry + rh - 1].filter(Boolean).length,
    clipEdges: [
      cMinX <= rx ? '左' : null,
      cMaxX >= rx + rw - 1 ? '右' : null,
      cMinY <= ry ? '上' : null,
      cMaxY >= ry + rh - 1 ? '下' : null,
    ].filter(Boolean),
    content: { w: cMaxX - cMinX, h: cMaxY - cMinY, n: cn, bg },
  };
}`;

/* ------------------------------------------------------------------ */

interface Metrics {
  n: number;
  area: number;
  cx: number;
  cy: number;
  bw: number;
  bh: number;
  /** 棋盘（含边框/棋子/阴影）在画布中的横向 / 纵向填充率（0~1）——「大棋盘」真值 */
  fillX: number;
  fillY: number;
  /** 纯棋盘木纹的横向 / 纵向填充率（参考值） */
  woodFillX: number;
  woodFillY: number;
  /** 棋盘在画布里留下的四周空白（设备像素） */
  mTop: number;
  mBottom: number;
  mLeft: number;
  mRight: number;
  /** 有多少条边被可见内容贴住（>0 = 有东西被画布裁掉） */
  clip: number;
  /** 被贴住的是哪几条边（诊断用） */
  clipEdges: string[];
  /** 可见内容（棋盘 + 棋子 + 阴影）的包围盒 */
  content: { w: number; h: number; n: number; bg: number[] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.error('❌ 未找到 Chromium。请设置 CHROMIUM_PATH 环境变量指向 Chrome/Chromium 可执行文件。');
    process.exit(1);
  }
  console.log(`Chromium: ${chromium}`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'chess3d-'));
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
      // 让 WebGL 在 headless 下可用（macOS 走 Metal，失败时回落到 SwiftShader）
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr?.on('data', () => {
    /* 忽略 Chromium 的噪声日志 */
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
    // 等 DevToolsActivePort 出现
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

    /** 轮询直到表达式返回真值 */
    const waitForExpr = async (expression: string, label: string, timeoutMs = 40000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = await evaluate<boolean>(`!!(${expression})`);
        if (v) return;
        await sleep(300);
      }
      const diag = await evaluate<string>(
        `location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' / ')`,
      );
      throw new Error(`等待「${label}」超时。页面状态：${diag}`);
    };

    // 1) 打开首页
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForExpr(`document.readyState === 'complete'`, '首页加载');
    await sleep(1000);

    // 2) 填用户名并登录
    //    用户名是 React 受控输入，必须用原生 setter 赋值再派发 input 事件
    await waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
    await evaluate(`
      (() => {
        const input = document.querySelector('input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'CDP验收员');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(300);
    // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点
    await waitForExpr(`!!document.querySelector('.status-dot.online')`, '与服务器连上');
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.includes('进入大厅'));
        if (btn) btn.click();
      })()
    `);

    // 3) 等大厅出来，点「人机对弈」→ 确定，进房间
    await waitForExpr(
      `[...document.querySelectorAll('button')].some((b) => b.textContent && b.textContent.includes('人机对弈'))`,
      '「人机对弈」按钮',
    );
    const clicked = await evaluate<boolean>(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.includes('人机对弈'));
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('找不到「人机对弈」按钮');
    // 面板打开后点「确定」才真的开局
    await waitForExpr(`!!document.querySelector('.mode-panel')`, '人机对弈面板');
    const confirmed = await evaluate<boolean>(`
      (() => {
        const btn = [...document.querySelectorAll('.mode-actions button')]
          .find((b) => b.textContent && b.textContent.includes('确定'));
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!confirmed) throw new Error('找不到「确定」按钮');

    // 房间创建后大厅会自动跳转到 /room/<code>
    try {
      await waitForExpr(`location.pathname.startsWith('/room/')`, '跳转对局页', 15000);
    } catch (err) {
      const diag = await evaluate<string>(
        `location.href + ' || ' + document.body.innerText.slice(0, 400).replace(/\\n/g, ' / ')`,
      );
      throw new Error(`${(err as Error).message}\n   页面诊断：${diag}`);
    }

    const roomUrl = await evaluate<string>('location.pathname');
    console.log(`已进入房间：${roomUrl}`);

    // 3) 切到 3D
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent && b.textContent.trim() === '3D');
        if (btn) btn.click();
      })()
    `);
    await sleep(3000);

    /*
     * 把页面上的 HUD / 按钮列 / 弹幕层 / **信息栏**藏起来再量像素。
     *
     * 为什么必须藏：这些是叠在画布上的**页面浮层**，不属于棋盘内容。
     * 而本脚本要量的是「画布里可见内容（棋盘 + 棋子 + 阴影）」的包围盒，
     * 用来判断棋盘有没有被裁掉。
     *
     * 不藏会怎样（实测踩过两次）：
     *   ① 鼠标拖拽会触发页面的 mousemove → 左上角 HUD 立刻醒来 →
     *      它正好压在画布左上角 → 内容包围盒被撑到画布左上角 →
     *      误报「旋转后棋盘被裁掉 左/上 两条边」。
     *   ② 信息栏（常驻的 HUD + 消息条）紧贴画布上方，它的投影会
     *      **盖在画布顶沿**，把上沿染暗 → 内容包围盒顶到画布边缘 →
     *      又一次误报「棋盘被裁掉」。
     *      （投影本身已经修掉了 —— 见 globals.css 里 .hud/.chat-strip 的注释 ——
     *        这里再藏一次，是为了让像素测量只看棋盘，不受任何浮层影响。）
     */
    await evaluate(`
      (() => {
        const s = document.createElement('style');
        s.id = 'verify-hide-overlay';
        s.textContent =
          '.hud, .chat-strip, .rail-chat, .rail-quick, .col-hud, .col-chat, .danmaku-layer, .chat-pop { display: none !important; }';
        document.head.appendChild(s);
        return true;
      })()
    `);
    await sleep(200);

    const canvasBox = await evaluate<{ x: number; y: number; w: number; h: number } | null>(`
      (() => {
        const c = document.querySelector('canvas');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()
    `);
    if (!canvasBox) throw new Error('3D 画布未渲染');
    console.log(`3D 画布：${Math.round(canvasBox.w)}×${Math.round(canvasBox.h)} @ (${Math.round(canvasBox.x)}, ${Math.round(canvasBox.y)})`);

    // 相机真实状态（从 R3F 的 store 里读）—— 取景对不对，看数字比看截图准
    const camState = await evaluate<Record<string, unknown> | null>(`
      (() => {
        const w = window;
        if (!w.__chessCam) return { err: 'no __chessCam' };
        const c = w.__chessCam;
        return {
          pos: c.pos.map((v) => +v.toFixed(3)),
          fov: c.fov,
          aspect: +c.aspect.toFixed(4),
          target: c.target ? c.target.map((v) => +v.toFixed(3)) : null,
          distance: c.distance == null ? null : +c.distance.toFixed(3),
          polar: c.polar == null ? null : +((c.polar * 180) / Math.PI).toFixed(2),
          azimuth: c.azimuth == null ? null : +((c.azimuth * 180) / Math.PI).toFixed(2),
        };
      })()
    `);
    if (camState) console.log(`相机状态：${JSON.stringify(camState)}`);

    // 画布在整页截图里的设备像素区域（截图按 devicePixelRatio 放大）
    const dpr = await evaluate<number>('window.devicePixelRatio || 1');
    const region = {
      x: Math.round(canvasBox.x * dpr),
      y: Math.round(canvasBox.y * dpr),
      w: Math.round(canvasBox.w * dpr),
      h: Math.round(canvasBox.h * dpr),
    };

    // 4) 采样指标
    const metrics = async (): Promise<Metrics> => {
      const shot = await cdp!.send('Page.captureScreenshot', { format: 'png' });
      return evaluate<Metrics>(
        `(${METRICS_FN})(${JSON.stringify(shot.data)}, ${JSON.stringify(region)})`,
        true,
      );
    };

    const wheel = async (deltaY: number, times = 1): Promise<void> => {
      const cx = Math.round(canvasBox.x + canvasBox.w / 2);
      const cy = Math.round(canvasBox.y + canvasBox.h / 2);
      for (let i = 0; i < times; i += 1) {
        await cdp!.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: cx,
          y: cy,
          deltaX: 0,
          deltaY,
        });
        await sleep(120);
      }
      await sleep(600);
    };

    /** 读相机状态（诊断接口 window.__chessCam） */
    const camSnapshot = async (): Promise<{
      distance: number | null;
      polar: number | null;
      azimuth: number | null;
    } | null> =>
      evaluate<{ distance: number | null; polar: number | null; azimuth: number | null } | null>(`
        (() => {
          const w = window;
          if (!w.__chessCam) return null;
          const c = w.__chessCam;
          return {
            distance: c.distance == null ? null : +c.distance.toFixed(4),
            polar: c.polar == null ? null : +((c.polar * 180) / Math.PI).toFixed(2),
            azimuth: c.azimuth == null ? null : +((c.azimuth * 180) / Math.PI).toFixed(2),
          };
        })()
      `);

    const drag = async (dx: number, dy: number, steps = 12): Promise<void> => {
      const x0 = Math.round(canvasBox.x + canvasBox.w * 0.75);
      const y0 = Math.round(canvasBox.y + canvasBox.h * 0.35);
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x0,
        y: y0,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      for (let i = 1; i <= steps; i += 1) {
        await cdp!.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x0 + (dx * i) / steps),
          y: Math.round(y0 + (dy * i) / steps),
          button: 'left',
          buttons: 1,
        });
        await sleep(25);
      }
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Math.round(x0 + dx),
        y: Math.round(y0 + dy),
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(700);
    };

    // 存一张基线截图，便于人工核对取景
    {
      const shot = await cdp!.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync('/tmp/chess3d-baseline.png', Buffer.from(shot.data, 'base64'));
      console.log('基线截图：/tmp/chess3d-baseline.png');
    }

    const m0 = await metrics();
    if (m0.n < 1000) throw new Error(`棋盘像素过少（${m0.n}），WebGL 可能没渲染出来`);
    console.log(`基线：暖色像素 ${m0.n}，木纹包围盒 ${m0.bw}×${m0.bh}`);
    console.log(
      `棋盘在画布中的填充率：横向 ${(m0.fillX * 100).toFixed(1)}% / 纵向 ${(m0.fillY * 100).toFixed(1)}%` +
        `（纯木纹口径：${(m0.woodFillX * 100).toFixed(1)}% / ${(m0.woodFillY * 100).toFixed(1)}%）`,
    );
    console.log(
      `四周留白：上 ${m0.mTop} / 下 ${m0.mBottom} / 左 ${m0.mLeft} / 右 ${m0.mRight} 设备像素` +
        `，可见内容包围盒 ${m0.content.w}×${m0.content.h}，贴边 ${m0.clip} 条` +
        (m0.clip > 0 ? `（${m0.clipEdges.join('/')}边）  ← 有东西被画布裁掉了` : '  （没有被裁）'),
    );

    const results: string[] = [];
    let ok = true;

    // ---- 棋盘必须把画布填满（大棋盘是硬指标）----
    if (m0.clip > 0) {
      ok = false;
      results.push(`❌ 有 ${m0.clip} 条边被可见内容贴住：棋盘/棋子被画布裁掉了`);
    }
    if (m0.fillX >= 0.9 && m0.fillY >= 0.9) {
      results.push(
        `✅ 棋盘撑满画布：横向 ${(m0.fillX * 100).toFixed(1)}% / 纵向 ${(m0.fillY * 100).toFixed(1)}%`,
      );
    } else {
      ok = false;
      results.push(
        `❌ 棋盘没撑满画布：横向 ${(m0.fillX * 100).toFixed(1)}% / 纵向 ${(m0.fillY * 100).toFixed(1)}%`,
      );
    }

    // ---- 缩放：滚轮向前（放大）----
    await wheel(-400, 3);
    const mZoomIn = await metrics();
    const zoomInRatio = mZoomIn.area / m0.area;
    console.log(`放大后：暖色像素 ${mZoomIn.area}（${zoomInRatio.toFixed(2)}×）`);
    if (zoomInRatio > 1.05) {
      results.push(`✅ 滚轮放大生效：棋盘投影面积 ${zoomInRatio.toFixed(2)}×（放大）`);
    } else {
      ok = false;
      results.push(`❌ 滚轮放大未生效：面积比 ${zoomInRatio.toFixed(2)}×`);
    }

    // ---- 缩放：滚轮向后（缩小）----
    await wheel(400, 3);
    const mZoomOut = await metrics();
    const zoomOutRatio = mZoomOut.area / mZoomIn.area;
    console.log(`缩小后：暖色像素 ${mZoomOut.area}（相对放大后 ${zoomOutRatio.toFixed(2)}×）`);
    if (zoomOutRatio < 0.95) {
      results.push(`✅ 滚轮缩小生效：棋盘投影面积 ${zoomOutRatio.toFixed(2)}×（缩小）`);
    } else {
      ok = false;
      results.push(`❌ 滚轮缩小未生效：面积比 ${zoomOutRatio.toFixed(2)}×`);
    }

    // ---- 缩放上下限放到最后做 ----
    // 理由：这一项会把相机推到 maxDistance，之后棋盘在画面里很小，
    // 旋转相关的检查会失去意义（投影变化量太小，测不准）。
    // 缩放前后各测一次面积，确认继续缩小时面积收敛（已到 maxDistance）。

    // ---- 旋转：拖拽一次，视角应变化，且**相机距离不许变** ----
    const beforeDrag = await metrics();
    const camBeforeDrag = await camSnapshot();
    await drag(-320, 0);
    const afterDrag = await metrics();
    const camAfterDrag = await camSnapshot();
    const shapeChanged =
      Math.abs(afterDrag.cx - beforeDrag.cx) > 8 ||
      Math.abs(afterDrag.bw - beforeDrag.bw) > 12 ||
      Math.abs(afterDrag.bh - beforeDrag.bh) > 12;
    console.log(
      `旋转前：重心(${beforeDrag.cx},${beforeDrag.cy}) 包围盒 ${beforeDrag.bw}×${beforeDrag.bh}\n` +
        `旋转后：重心(${afterDrag.cx},${afterDrag.cy}) 包围盒 ${afterDrag.bw}×${afterDrag.bh}`,
    );
    if (shapeChanged) {
      results.push('✅ 拖拽旋转生效：棋盘投影形状/重心发生变化');
    } else {
      ok = false;
      results.push('❌ 拖拽旋转未产生任何变化');
    }

    // ---- 限幅：继续同方向拖，视角应被夹住不再变化 ----
    await drag(-320, 0);
    const atLimit1 = await metrics();
    await drag(-320, 0);
    const atLimit2 = await metrics();
    await drag(-320, 0);
    const atLimit3 = await metrics();
    const drift12 = Math.abs(atLimit2.cx - atLimit1.cx) + Math.abs(atLimit2.bw - atLimit1.bw);
    const drift23 = Math.abs(atLimit3.cx - atLimit2.cx) + Math.abs(atLimit3.bw - atLimit2.bw);
    console.log(
      `限幅连续三次拖拽重心：${atLimit1.cx} → ${atLimit2.cx} → ${atLimit3.cx}\n` +
        `包围盒宽：${atLimit1.bw} → ${atLimit2.bw} → ${atLimit3.bw}`,
    );
    if (drift12 <= 4 && drift23 <= 4) {
      results.push(`✅ 旋转限幅生效：继续同向拖拽，视角不再变化（漂移 ${drift12} / ${drift23}px）`);
    } else {
      ok = false;
      results.push(`❌ 旋转未被限幅：仍在漂移（${drift12} / ${drift23}px）`);
    }

    // ---- 旋转时相机距离必须**不变**（不自动缩放）----
    //
    // 用户明确要求「棋盘转过来就转过来，不要自动进行缩放」：
    // 旧实现一转视角就把相机推远，棋盘自己缩小，把用户刚放大的视角又缩回去。
    // 现在相机距离只由滚轮缩放决定 —— 所以「拖拽旋转前后距离相等」就是这条规则的守卫。
    const dBefore = camBeforeDrag?.distance ?? null;
    const dAfter = camAfterDrag?.distance ?? null;
    const dDelta = dBefore != null && dAfter != null ? Math.abs(dAfter - dBefore) : null;
    console.log(
      `旋转前相机距离：${dBefore ?? '未知'} → 旋转后：${dAfter ?? '未知'}` +
        `（方位角 ${camBeforeDrag?.azimuth ?? '?'}° → ${camAfterDrag?.azimuth ?? '?'}°）`,
    );
    if (dDelta != null && dDelta <= 0.01) {
      results.push(`✅ 旋转时相机距离不变（不自动缩放）：${dBefore} → ${dAfter}`);
    } else {
      ok = false;
      results.push(
        `❌ 旋转时相机距离变了（${dBefore} → ${dAfter}）：自动缩放又回来了？`,
      );
    }

    // ---- 旋转后棋盘是否还在画布里：**信息项，不是门禁** ----
    //
    // 取消自动缩放之后，转到斜角时棋盘上下边缘会有一部分走出画布 —— 这是几何决定的，
    // 回避不掉（棋盘是正方形，转到对角线方向时纵深变长、在画面里变高，而画布高度固定）。
    // 这里把「要完整可见需要退到多远」算出来，方便知道代价。
    const mRot = await metrics();
    const camAfter = camAfterDrag;
    const needRetreat = (() => {
      if (!camAfter || camAfter.distance == null || camAfter.polar == null) return null;
      const polar = (camAfter.polar * Math.PI) / 180;
      const az = (camAfter.azimuth ?? 0) * (Math.PI / 180);
      const cam = camState as { pos?: number[]; aspect?: number } | null;
      const targetZ = 0.8181 * ((cam?.pos?.[2] ?? 1) >= 0 ? 1 : -1);
      const aspect = typeof cam?.aspect === 'number' ? cam.aspect : 1.5579;
      return safeDistance(polar, az, targetZ, aspect);
    })();
    console.log(
      `旋转后相机：${camAfter ? JSON.stringify(camAfter) : '未知'}` +
        `，内容包围盒 ${mRot.content.w}×${mRot.content.h}，填充率 ${(mRot.fillX * 100).toFixed(1)}% / ${(mRot.fillY * 100).toFixed(1)}%` +
        `，留白 上${mRot.mTop}/下${mRot.mBottom}/左${mRot.mLeft}/右${mRot.mRight}` +
        (mRot.clip > 0 ? `，贴边 ${mRot.clipEdges.join('/')}` : '，未贴边'),
    );
    results.push(
      `ℹ️ 旋转后棋盘${mRot.clip === 0 ? '仍完整落在画布里' : `有 ${mRot.clip} 条边走出画布（预期：不再自动缩放）`}` +
        (needRetreat != null ? `；若要完整可见，相机得退到 r=${needRetreat.toFixed(2)}` : ''),
    );

    // ---- 缩放上下限：一直缩小，面积应收敛（maxDistance 兜底）----
    await wheel(400, 25);
    const mMin = await metrics();
    await wheel(400, 25);
    const mMin2 = await metrics();
    const shrinkDrift = Math.abs(mMin2.area - mMin.area) / Math.max(1, mMin.area);
    console.log(`极限缩小：${mMin.area} → ${mMin2.area}（漂移 ${(shrinkDrift * 100).toFixed(2)}%）`);
    if (shrinkDrift < 0.03) {
      results.push(`✅ 缩放上限生效：继续缩小后面积漂移仅 ${(shrinkDrift * 100).toFixed(2)}%（已到 maxDistance）`);
    } else {
      ok = false;
      results.push(`❌ 缩放上限未生效：仍在漂移 ${(shrinkDrift * 100).toFixed(2)}%，请核对 maxDistance 配置`);
    }

    console.log('');
    results.forEach((r) => console.log(`   ${r}`));
    console.log(
      `\n结果：${ok ? '✅ D6 / D7 / D8 通过（取景撑满不裁切 + 可旋转、可限幅、可缩放 + 旋转不自动缩放）' : '❌ D6 / D7 / D8 未通过'}`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
