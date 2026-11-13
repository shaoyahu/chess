/**
 * **浏览器门禁用的极简 CDP 客户端**（零新增依赖）。
 *
 * 为什么不用 Playwright：
 *  本项目没有装 playwright —— 现有的门禁脚本都是「自己起 Chromium +
 *  用 CDP 协议驱动」。这里把那段抽成 lib，**不再复制第 4 份**
 *  （`verify-drag` / `verify-ui-style` / `verify-room-exit` 各有一份拷贝，
 *  改一处就要改三处 —— 那是历史包袱，不该继续扩大）。
 *
 * 支持多标签页：每个 `Page` 对应一个 CDP session。
 * 「关掉网页再打开」这个场景**必须**多标签页：
 *  同一个浏览器 profile 里，**新标签页共享 localStorage、清空 sessionStorage**
 *  —— 这正是「关掉标签页再打开」的浏览器真实行为。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 找一个可用的 Chromium。
 *
 * 优先 `CHROMIUM_PATH` 环境变量，否则翻本机 Playwright 浏览器缓存。
 */
export function findChromium(): string | null {
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

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** CDP 连接（一个浏览器进程一个连接，多个 session） */
export class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (typeof msg.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
      } else {
        p.resolve(msg.result);
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

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
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

/**
 * 页面里的 WebSocket 探针。
 *
 * 注入在**文档加载之前**（`Page.addScriptToEvaluateOnNewDocument`），
 * 所以它能截住应用自己建的那条连接。
 *
 * 暴露三样东西：
 *  - `window.__wsLog` —— 收发报文流水（**判据**：客户端到底发了什么）；
 *  - `window.__appWs` —— **应用自己的**那条连接；
 *  - `window.__sockets` —— 全部连接（URL + 实例）。
 *
 * ## 为什么不能只留「最后一条连接」
 *
 * dev 模式下 **Next.js 会自己再开一条 HMR 连接**（路径是 `/_next/webpack-hmr`），
 * 而且它**比应用的连接晚建**。
 * 只记「最后一个」的话，拿到的是 HMR 那条 —— 往它发 move，服务端根本收不到，
 * 而门禁还「通过」了（假绿）。
 *
 * 所以这里**按 URL 认连接**：路径以 `/ws` 结尾的那条才是游戏的。
 */
export const WS_SPY_SOURCE = `
  (() => {
    window.__wsLog = [];
    window.__sockets = [];
    window.__appWs = null;
    const Orig = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      const u = String(url);
      window.__sockets.push({ url: u, ws });
      if (u.endsWith('/ws')) window.__appWs = ws;
      const push = (dir, data) => {
        try {
          const s = typeof data === 'string' ? data : '[binary]';
          let t = '?';
          let code = '';
          let claim = '';
          try {
            const j = JSON.parse(s);
            t = j.t || '?';
            if (j.code) code = j.code;
            if (j.state && j.state.code) code = j.state.code;
            if (j.claimKey) claim = String(j.claimKey);
          } catch { /* 不是 JSON 就原样存 */ }
          window.__wsLog.push({ dir, t, code, claim, at: Date.now() });
          if (window.__wsLog.length > 400) window.__wsLog.shift();
        } catch { /* ignore */ }
      };
      const origSend = ws.send.bind(ws);
      ws.send = (data) => { push('out', data); return origSend(data); };
      ws.addEventListener('message', (ev) => push('in', ev.data));
      /*
       * **连接的生命周期也要记**（open / close）。
       *
       * 半开连接（网络断了但 TCP 没断）下，
       * close 事件**可能永远不来** —— 浏览器在等对方的关闭帧。
       * 所以「客户端有没有察觉断网」不能只看报文，
       * 得看它有没有自己换一条连接。
       */
      ws.addEventListener('open', () => push('open', ''));
      ws.addEventListener('close', () => push('close', ''));
      ws.addEventListener('error', () => push('error', ''));
      return ws;
    }
    Wrapped.prototype = Orig.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Wrapped;
  })();
`;

/** 一个标签页 */
export class Page {
  constructor(
    private readonly cdp: Cdp,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  async navigate(url: string): Promise<void> {
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
  }

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const res = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      this.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(
        `页面求值失败：${res.exceptionDetails.text ?? 'unknown'} ${
          res.exceptionDetails.exception?.description ?? ''
        }`,
      );
    }
    return res.result?.value as T;
  }

  /** 等页面里的某个表达式为真 */
  async waitForExpr(expression: string, label: string, timeoutMs = 40000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await this.evaluate<boolean>(`!!(${expression})`);
      if (v) return;
      await sleep(150);
    }
    const diag = await this.evaluate<string>(
      `location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' / ')`,
    );
    throw new Error(`等待「${label}」超时。页面状态：${diag}`);
  }

  /**
   * 等 WebSocket **真的连上**。
   *
   * 为什么必须等：大厅的「进入大厅」按钮要靠 socket 才能把名字送上去。
   * 页面刚挂载时 socket 还在握手（顶栏那颗点写着「连接中…」），
   * 这时候点「进入大厅」= **点了没反应** —— 名字没送出去，
   * 页面还是停在登录卡。机器一忙（跑变异脚本、并行门禁）就容易撞上，
   * 报出来的是「等待『大厅页面』超时」，看上去像页面坏了。
   *
   * 判据用顶栏那颗点：连上了 `aria-label` 才是「已连接，在线 N 人」
   * （见 `src/components/OnlineUsersMenu.tsx`）。
   */
  async waitConnected(timeoutMs = 20000): Promise<void> {
    await this.waitForExpr(
      `!!document.querySelector('.status-dot.online')`,
      '与服务器连上',
      timeoutMs,
    );
  }

  /** 按可见文本点一个元素 */
  async clickText(tag: string, text: string, label: string): Promise<void> {
    const done = await this.evaluate<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
        .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!done) throw new Error(`点不到「${label}」（文本含「${text}」）`);
  }

  /**
   * 在输入框里填值。
   *
   * React 受控组件要用**原生 setter**再派发 `input` 事件 ——
   * 直接 `el.value = x` 会被 React 的内部值覆盖（它记着上一次的值）。
   *
   * 还要**重试**：输入框出现在 DOM 里 ≠ React 已经 hydration 完。
   * hydration 之前填进去的值会被 React 重新渲染时**重置掉**，
   * 于是「填了 → 点按钮 → 名字是空的」这种失败看起来毫无征兆。
   */
  async fillInput(selector: string, value: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ok = await this.evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value === ${JSON.stringify(value)};
      })()`);
      // 等一拍再读：hydration 可能刚好在这中间把值冲掉
      await sleep(250);
      const still = await this.evaluate<string>(
        `(document.querySelector(${JSON.stringify(selector)}) || {}).value || ''`,
      );
      if (ok && still === value) return;
      await sleep(250);
    }
    throw new Error(`输入框 ${selector} 填不进值「${value}」`);
  }

  /**
   * 在**应用脚本跑之前**往这个标签页注入一段代码。
   *
   * 用途：模拟「第一次来的新访客」——
   * 清掉 `localStorage`（记住的用户名）与 `sessionStorage`（身份凭证），
   * 而且必须**赶在应用读取它们之前**清（页面一挂载就晚了）。
   */
  async addInitScript(source: string): Promise<void> {
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, this.sessionId);
  }

  /** 把这个标签页切到前台（剪贴板写入要求文档处于聚焦状态） */
  async focus(): Promise<void> {
    await this.cdp.send('Page.bringToFront', {}, this.sessionId);
  }

  /**
   * 改**视口**尺寸（Emulation）—— 用来测窄屏布局。
   *
   * 用 Emulation 而不是改浏览器窗口大小：
   *   窗口大小会受操作系统/窗口管理器限制，测出来的尺寸不可靠；
   *   Emulation 直接覆盖视口，量到的就是页面以为的尺寸。
   */
  async setViewport(width: number, height: number): Promise<void> {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      this.sessionId,
    );
    await sleep(350);
  }

  /**
   * 授予剪贴板权限（读 + 写）。
   *
   * `navigator.clipboard.readText()` 在没授权时会抛 `NotAllowedError` ——
   * 门禁要**把复制出来的东西真的读回来核对**，光看一句 toast 提示不算数。
   *
   * 这是**浏览器级**命令（不带 sessionId）。
   */
  async grantClipboard(origin: string): Promise<void> {
    await this.cdp.send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  }

  /** 断网 / 恢复网络（浏览器层面） */
  async setOffline(offline: boolean): Promise<void> {
    await this.cdp.send('Network.enable', {}, this.sessionId);
    await this.cdp.send(
      'Network.emulateNetworkConditions',
      {
        offline,
        latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1,
      },
      this.sessionId,
    );
  }

  /** 页面里的 WebSocket 收发流水 */
  async wsLog(): Promise<Array<{ dir: string; t: string; code: string; claim: string; at: number }>> {
    return this.evaluate<Array<{ dir: string; t: string; code: string; claim: string; at: number }>>(
      'window.__wsLog || []',
    );
  }

  /**
   * **应用那条连接**现在是什么状态。
   *
   * `null` = 还没建起来；`1` = OPEN；`3` = CLOSED。
   */
  async appSocketState(): Promise<number | null> {
    return this.evaluate<number | null>(
      `window.__appWs ? window.__appWs.readyState : null`,
    );
  }

  /** 截图（存到调用方给的路径） */
  async screenshot(filePath: string): Promise<void> {
    const res = await this.cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      this.sessionId,
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, Buffer.from(res.data as string, 'base64'));
  }

  async close(): Promise<void> {
    try {
      await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* ignore */
    }
  }
}

/** 一个浏览器实例 */
export class Browser {
  private constructor(
    private readonly cdp: Cdp,
    private readonly proc: ChildProcess,
    private readonly userDataDir: string,
  ) {}

  static async launch(windowSize = { width: 1500, height: 950 }): Promise<Browser> {
    const chromium = findChromium();
    if (!chromium) throw new Error('未找到 Chromium。请设置 CHROMIUM_PATH 环境变量。');
    const userDataDir = mkdtempSync(join(tmpdir(), 'lan-chess-browser-'));
    const proc = spawn(
      chromium,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        `--window-size=${windowSize.width},${windowSize.height}`,
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

    const portFile = join(userDataDir, 'DevToolsActivePort');
    let wsUrl = '';
    for (let i = 0; i < 120; i += 1) {
      if (existsSync(portFile)) {
        const lines = readFileSync(portFile, 'utf8').split('\n');
        if (lines.length >= 2 && lines[0].trim()) {
          wsUrl = `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
          break;
        }
      }
      await sleep(100);
    }
    if (!wsUrl) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      throw new Error('Chromium 未能暴露 DevTools 端口');
    }

    const cdp = await Cdp.connect(wsUrl);
    return new Browser(cdp, proc, userDataDir);
  }

  /** 开一个新标签页（**同一个 profile** → 共享 localStorage） */
  async newPage(): Promise<Page> {
    return this.openTarget(undefined);
  }

  /**
   * 开一个**隔离上下文**里的标签页 —— 它有**自己的 localStorage**。
   *
   * 用来模拟「**另一台设备**」：同一浏览器的两个普通标签页是**共享 localStorage** 的，
   * 而两台设备各存各的。门禁里凡是「这两个人不该共用同一份本地存档」的场合，
   * 都要用这个 —— 否则测的是「同一个人的两个标签页」，不是真实场景。
   */
  async newIsolatedPage(): Promise<Page> {
    const { browserContextId } = await this.cdp.send('Target.createBrowserContext', {});
    return this.openTarget(browserContextId);
  }

  private async openTarget(browserContextId?: string): Promise<Page> {
    const { targetId } = await this.cdp.send(
      'Target.createTarget',
      browserContextId ? { url: 'about:blank', browserContextId } : { url: 'about:blank' },
    );
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.cdp, sessionId, targetId);
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    // WebSocket 探针必须在应用脚本跑之前装上
    await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: WS_SPY_SOURCE },
      sessionId,
    );
    return page;
  }

  async close(): Promise<void> {
    this.cdp.close();
    /*
     * **等浏览器真的退出，再删 profile 目录。**
     *
     * 之前是「发完 SIGTERM 立刻 rmSync」：
     * Chrome 还在收尾，目录里的文件还开着 → rm 失败 → 被 catch 吞掉 →
     * **每跑一轮门禁就漏一个几十 MB 的临时 profile**（实测一轮漏 5 个，
     * 攒下来就是几个 G 的垃圾）。
     *
     * 教训跟 PLAN.md U4 那条一样：**「我让它退出了」不等于「它退出了」**，
     * 清理动作要等状态真的变。
     */
    const exited = new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        resolve();
        return;
      }
      this.proc.once('exit', () => resolve());
    });
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 5000);
    await exited;
    clearTimeout(killer);
    // 退干净了再删；万一还有文件被占着，隔一拍再试一次
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* 文件还开着，等一拍再试 */
      }
      if (!existsSync(this.userDataDir)) return;
      await sleep(200);
    }
  }
}
