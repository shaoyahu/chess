/**
 * 「**超时判负但不终局**」门禁 —— `scripts/verify-timeout.ts`
 *
 * 规则（用户拍板）：
 *   - 超时 = 判负，**但不结束棋局** —— 双方照样能继续走；
 *   - 结果一旦因超时定下就**锁定**，后来的将死/认输不改写它；
 *   - 棋钟继续走，可以变成**负数**（`-1:23`）；
 *   - 超时后仍然可以申请「再来一局」。
 *
 * 门禁清单（T1~T8）：
 *   T1 超时方的棋钟显示**负数**（`-1:23` 这种）。
 *   T2 超时方的棋钟是**红色**（danger 色）—— 且**不能**被「轮到他走」的
 *      强调色盖掉（判负的一方往往正是该走棋的那一方）。
 *   T3 超时方那一行有「**已超时**」标记。
 *   T4 超时**不是终局**：HUD **不是**「对局已结束」，而且棋盘正中**没有**结果卡
 *      （超时判负但不终局 —— 这局还在下，结果卡盖住棋盘就会挡住人）。
 *      超时的信息由「超时方那一行的『已超时』徽标」交代（T3 已验）。
 *   T5 超时之后这局**还能继续下**：浏览器走一步 → 对方看得见，「已超时」标记不变，
 *      棋盘正中依然没有结果卡。
 *   T6 超时后「**再来一局**」按钮还在（结果已定，允许换局）。
 *   T7 超时那一行的**名字没被挤成一个字**（HUD 列只有 260px，
 *      这一行同时有标记、棋钟和按钮 —— 挤爆了名字就认不出来了）。
 *   T8 超时后**没有「复盘」按钮**（超时不是终局，这局还在下；
 *      复盘一开，棋盘就会显示复盘的局面、走子也不再发给服务端）。
 *
 * 为什么必须用**真浏览器 + 真服务端**：
 *   - 负数怎么显示、颜色有没有被盖掉、标记在不在 —— 都是渲染层的事，
 *     协议层测不到；
 *   - 「还能继续下」要验的是**界面上的棋盘真的还能走**。
 *
 * 怎么造出「已经超时的房间」：
 *   **用存档种子 + 真等一次超时** —— 存档只负责造出对局（两个座位 + 白方 3 秒的钟），
 *   超时是**服务端自己判出来的**（每秒 tick 一次，走完那 3 秒就判）。
 *   为什么不真等 5 分钟：最短时限就是 5 分钟，门禁等不起；
 *   为什么不往服务端加「测试后门」：生产代码不该为门禁留口子。
 *
 * 变异测试（手动跑过，见下）：
 *   - 把服务端的超时改回「终局」 → **T1 / T4 / T5 变红**（服务端那条规则确实在射程内）；
 *   - 去掉 `.clock.over` 样式 → **T2 变红**（颜色确实是被 `.clock.running` 盖住才红的）；
 *   - 去掉玩家行的换行与名字最小宽度 → **T7 变红**（名字真的被压成 0.7 个字）。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都带自己的编号（T1~T8）。
 *
 * 用法：
 *   npx tsx scripts/verify-timeout.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, type Page, sleep } from './lib/browser';
import { warmUpUrl } from './lib/test-server';
import { GameClient } from './lib/game-client';
import { makeGateFilter, parseGroupFilter } from './lib/gate-groups';
import { TIMEOUT_GROUPS } from './lib/timeout-groups';

/** 存档里那个房间的码（要落在房间码字母表里） */
const ROOM_CODE = 'TMO7';
/** 白方（判负方）的座位凭证 —— 浏览器靠它认领回白方座位 */
const WHITE_CLAIM = 'seed-claim-white-0001';
/** 黑方（计时方）的座位凭证 —— 门禁的 ws 客户端靠它认领黑方座位 */
const BLACK_CLAIM = 'seed-claim-black-0001';

const OUT_DIR = join(process.cwd(), 'artifacts', 'timeout');
const selectedGroups = parseGroupFilter(TIMEOUT_GROUPS, process.argv.slice(2));
const gateFilter = makeGateFilter(TIMEOUT_GROUPS, selectedGroups);

/* ------------------------------------------------------------------ */
/* 判据                                                                */
/* ------------------------------------------------------------------ */

interface Verdict {
  ok: boolean;
  label: string;
  detail: string;
}

const results: Verdict[] = [];
const skipped: string[] = [];

function verdict(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

/** 跑一条门禁；出错时记一条 ❌（带编号），然后继续往下跑 */
async function step<T>(id: string, label: string, fn: () => Promise<T>): Promise<T | null> {
  if (!gateFilter(id)) {
    skipped.push(id);
    console.log(`⏭️  ${id} ${label}（本次分组没选中，跳过）`);
    return null;
  }
  try {
    return await fn();
  } catch (e) {
    verdict(false, `${id} ${label}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 存档种子                                                            */
/* ------------------------------------------------------------------ */

/**
 * 造一份「一触即发」的存档。
 *
 * 白方的棋钟只给 **3 秒** —— 超时不是造出来的，是**真等出来的**：
 * 等两边都连上、服务端自己 tick 到时间走完，它才判超时、锁定结果、
 * 把白方标记成「已超时」。黑方的钟是正常的。
 *
 * 这样服务端那条规则（超时判负但不终局）也在门禁的射程里 ——
 * 如果它又变回「超时即终局」，T4/T5 会当场变红。
 *
 * 注意 `running: false` —— 存档恢复出来的座位一律是「断线」状态，
 * 棋钟要等**两边都连上**才会走（这是服务端的规矩）。
 */
function seedArchive(now: number): unknown[] {
  return [
    {
      state: {
        code: ROOM_CODE,
        status: 'playing',
        seats: {
          w: {
            userId: 'seed-white',
            name: '超时方',
            color: 'w',
            connected: false,
            isAI: false,
            ready: true,
          },
          b: {
            userId: 'seed-black',
            name: '计时方',
            color: 'b',
            connected: false,
            isAI: false,
            ready: true,
          },
        },
        spectators: [],
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: [],
        inCheck: false,
        clock: {
          /*
           * 白方只有 **3 秒** —— 超时不是「造出来」的，是**真等出来的**：
           * 服务端每秒 tick 一次，走完这 3 秒它自己判超时。
           * 这样门禁才真的盖住服务端那条规则（存档种子只负责造出对局）。
           */
          wMs: 3_000,
          bMs: 600_000,
          incrementMs: 0,
          lastTickAt: now,
          running: false,
          enabled: true,
        },
        chat: [],
        rematchVotes: [],
        difficulty: 'normal',
        visibility: 'public',
        createdAt: now,
        updatedAt: now,
      },
      timeControl: '10+0',
      claimKeys: { w: WHITE_CLAIM, b: BLACK_CLAIM },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 被测服务端                                                          */
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
    private stderrText: () => string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  static async start(dataDir: string): Promise<TestServer> {
    const usePort = await freePort();
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const proc = spawn(tsx, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(usePort),
        HOST: '127.0.0.1',
        LAN_CHESS_DATA_DIR: dataDir,
        NODE_ENV: 'development',
        /*
         * **构建目录必须隔离** —— dev 模式的 Next 启动时会**清空** `distDir`，
         * 而 `distDir` 默认是 `.next`（用户 `npm start` 的生产构建目录）。
         * 不隔离的话，跑一次门禁用户的生产构建就没了。
         */
        NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next-gate-timeout',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr?.on('data', (buf: Buffer) => {
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
        reject(new Error(`服务端提前退出（code=${code}）：\n${out.slice(-800)}\n${err.slice(-800)}`));
      });
    });
    await started;
    const server = new TestServer(proc, usePort, dataDir, () => err);
    // 预热：dev 模式按需编译 —— 把编译挪到门禁计时之外（见 scripts/lib/test-server.ts）
    await warmUpUrl(server.url, '/');
    await warmUpUrl(server.url, '/room/TMO7');
    return server;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(timer);
  }

  stderr(): string {
    return this.stderrText();
  }
}

/* ------------------------------------------------------------------ */
/* 页面里取数据                                                        */
/* ------------------------------------------------------------------ */

/** 从页面里读出「玩家行」的若干状态 */
interface RowsInfo {
  whiteClockText: string | null;
  whiteClockClass: string | null;
  whiteClockColor: string | null;
  whiteBadge: string | null;
  banner: string | null;
  hud: string | null;
  rematchText: string | null;
  /** HUD 里有没有「复盘」按钮（超时这局还没结束 → 不该有） */
  replayBtn: boolean;
  /** 名字元素实际有多宽（px）—— 被挤没的时候这里会只剩一两个字 */
  nameWidth: number;
  /** 一个汉字大约多宽（px） */
  charWidth: number;
  bodyHead: string;
}

const READ_ROWS = `
(() => {
  const rows = [...document.querySelectorAll('.player-row')];
  const rowOf = (dark) => rows.find((r) => {
    const dot = r.querySelector('.piece-dot');
    return dot && dot.classList.contains('dark') === dark;
  });
  const w = rowOf(false);
  const clock = w ? w.querySelector('.clock') : null;
  const badge = w ? w.querySelector('.badge.timeout') : null;
  const rematch = w ? w.querySelector('.rematch-btn') : null;
  const nameEl = w ? w.querySelector('.name') : null;
  const fs = nameEl ? parseFloat(getComputedStyle(nameEl).fontSize) : 14;
  return {
    whiteClockText: clock ? clock.textContent.trim() : null,
    whiteClockClass: clock ? clock.className : null,
    whiteClockColor: clock ? getComputedStyle(clock).color : null,
    whiteBadge: badge ? badge.textContent.trim() : null,
    banner: (document.querySelector('.result-card') || {}).textContent
      ? document.querySelector('.result-card').textContent.trim() : null,
    hud: (document.querySelector('.hud-status') || {}).textContent
      ? document.querySelector('.hud-status').textContent.trim() : null,
    rematchText: rematch ? rematch.textContent.trim() : null,
    /* 有没有「复盘」按钮（超时这局还没结束 → 不该有） */
    replayBtn: [...document.querySelectorAll('.hud-actions button')]
      .some((b) => (b.textContent || '').trim() === '复盘'),
    nameWidth: nameEl ? nameEl.getBoundingClientRect().width : 0,
    charWidth: fs,
    bodyHead: document.body.innerText.slice(0, 300).replace(/\\n/g, ' / '),
  };
})()
`;

/** 把 CSS 变量里的十六进制颜色换算成 rgb，用来和计算样式比对 */
const READ_DANGER = `
(() => {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  return 'rgb(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ')';
})()
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-timeout-'));
  writeFileSync(join(dataDir, 'rooms.json'), JSON.stringify(seedArchive(Date.now()), null, 2));

  let server: TestServer | null = null;
  let browser: Browser | null = null;
  try {
    server = await TestServer.start(dataDir);
    console.log(`   · 服务端已起：${server.url}（存档目录 ${dataDir}）`);

    /*
     * **先热身一次** —— dev 模式的 Next 第一次请求某个页面要现场编译，
     * 不热身的话浏览器导航会卡在编译上，看起来像「页面没出来」。
     */
    try {
      await fetch(`${server.url}/room/${ROOM_CODE}`, { signal: AbortSignal.timeout(120000) });
    } catch {
      /* 热身失败不致命 —— 下面浏览器那步会报更具体的错 */
    }

    browser = await Browser.launch({ width: 1500, height: 950 });
    const page = await browser.newPage();

    // ① 先在大厅**登录**（身份在 sessionStorage 里，房间页要靠它才肯进）
    await page.navigate(`${server.url}/`);
    await page.waitForExpr(`!!document.querySelector('#username')`, '用户名输入框', 60000);
    /*
     * **等 React hydration 完**再填 ——
     * 输入框出现在 DOM 里 ≠ 应用已经接管它；hydration 之前写进去的值
     * 会被 React 重新渲染时重置掉（症状是「点了没反应」）。
     */
    await sleep(1200);
    await page.waitConnected();
    await page.fillInput('#username', '超时验收员');
    await page.clickText('button', '进入大厅', '进入大厅');
    await page.waitForExpr(
      `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
      '大厅页面',
      30000,
    );

    // ② 把**座位凭证**写进 localStorage —— 客户端进房间时会拿它认领白方座位
    await page.evaluate(
      `window.localStorage.setItem('lan-chess.claim', JSON.stringify({ ${JSON.stringify(
        ROOM_CODE,
      )}: ${JSON.stringify(WHITE_CLAIM)} }))`,
    );

    // ③ 进房间页 —— 客户端会拿凭证去认领白方座位
    await page.navigate(`${server.url}/room/${ROOM_CODE}`);
    await page.waitForExpr(`!!document.querySelector('.player-row')`, '对局页渲染', 60000);

    // ③ 门禁的 ws 客户端认领黑方座位 —— 两边都连上，**棋钟才会走**
    //    （服务端只在两边都在时计时）→ 走起来之后白方那格会同时带
    //    `running` 和 `over` 两个类，正好压住 T2 要验的「颜色优先级」。
    const opp = new GameClient(server.wsUrl);
    await opp.ready();
    await opp.hello('计时方');
    opp.send({ t: 'room.claim', code: ROOM_CODE, claimKey: BLACK_CLAIM });
    await opp.waitFor(
      (m) => m.t === 'room' && m.state?.code === ROOM_CODE,
      '黑方认领座位后的房间快照',
    );

    await page.waitForExpr(
      `!!document.querySelector('.player-row .clock')`,
      '棋钟渲染',
      20000,
    );

    // ④ **等服务端真判超时** —— 白方那 3 秒走完之后，服务端自己会判
    await opp.waitFor(
      (m) => m.t === 'room' && m.state?.result?.reason === 'timeout',
      '服务端判超时',
      30000,
    );
    // 界面也得跟上（「已超时」标记 + 负数计时；**没有**终局结果卡 —— 这一局还在下）
    await page.waitForExpr(
      `!!document.querySelector('.badge.timeout')`,
      '界面上的「已超时」标记',
      20000,
    );
    await sleep(800);

    /* ---------------- T1 负数 ---------------- */
    await step('T1', '超时方的棋钟显示负数', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      const text = info.whiteClockText ?? '';
      // 走起来之后欠账还在涨 → 只判格式，不判具体数值
      if (!/^-\d+:\d{2}$/.test(text)) {
        throw new Error(
          `T1 白方棋钟显示的是「${text}」，不是负数格式（应形如 -1:23）。页面：${info.bodyHead}`,
        );
      }
      verdict(true, 'T1 超时方的棋钟显示负数', text);
      return info;
    });

    /* ---------------- T2 红色 ---------------- */
    await step('T2', '超时方的棋钟是红色（压得住「轮到他走」的强调色）', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      const danger = await page.evaluate<string>(READ_DANGER);
      const color = info.whiteClockColor ?? '';
      if (color !== danger) {
        throw new Error(
          `T2 白方棋钟的颜色是「${color}」，不是超时红「${danger}」` +
            `（class="${info.whiteClockClass}"）—— 说明被 .clock.running 的强调色盖掉了`,
        );
      }
      verdict(true, 'T2 超时方的棋钟是红色', `${color}（danger）`);
      return info;
    });

    /* ---------------- T3 已超时标记 ---------------- */
    await step('T3', '超时方那一行有「已超时」标记', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      if (info.whiteBadge !== '已超时') {
        throw new Error(
          `T3 白方那一行没有「已超时」标记（读到 ${JSON.stringify(info.whiteBadge)}）。页面：${info.bodyHead}`,
        );
      }
      verdict(true, 'T3 超时方那一行有「已超时」标记', '已超时');
      return info;
    });

    /* ---------------- T4 超时不是终局 + 没有结果卡盖住棋盘 ---------------- */
    /*
     * 超时**不是终局** —— 这一局还在下，棋盘还在用。
     *
     * 所以**终局结果卡不出现**：
     *   终局卡是浮在棋盘**正中**的（盖住半张棋盘）——
     *   这一局还没结束，卡片一盖上来就没法继续下了。
     * 超时的信息由两样东西交代：**超时方那一行的「已超时」徽标**（T3 已验）
     * + 超时那一刻弹的那条 toast。
     *
     * HUD 也**不能**说「对局已结束」—— 这一局还在下。
     */
    await step('T4', '超时不是终局：HUD 不是「对局已结束」，结果卡也不盖住棋盘', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      if (info.banner !== null) {
        throw new Error(
          `T4 这一局还在下，棋盘正中却出现了结果卡「${info.banner}」—— 它会盖住棋盘`,
        );
      }
      if ((info.hud ?? '').includes('对局已结束')) {
        throw new Error(`T4 HUD 显示「${info.hud}」—— 超时不该结束对局`);
      }
      if (info.whiteBadge !== '已超时') {
        throw new Error(`T4 超时方那一行的「已超时」标记不见了（读到 ${JSON.stringify(info.whiteBadge)}）`);
      }
      verdict(
        true,
        'T4 超时不是终局：HUD 不是终局、结果卡不盖棋盘、「已超时」标记在',
        `结果卡=${info.banner}｜HUD「${info.hud}」｜徽标「${info.whiteBadge}」`,
      );
      return info;
    });

    /* ---------------- T5 还能继续下 ---------------- */
    await step('T5', '超时之后这局还能继续下（走一步对方看得见）', async () => {
      // 浏览器点 e2 → e4（白方该走棋）
      await page.evaluate(`
        (() => {
          const f = document.querySelector('[data-square="e2"]');
          const t = document.querySelector('[data-square="e4"]');
          if (f && t) { f.click(); setTimeout(() => t.click(), 150); }
          return true;
        })()
      `);
      await sleep(600);
      // 对方（ws 客户端）看到新的一步 —— 说明服务端**收了**这一步
      await opp.waitFor(
        (m) => m.t === 'room' && Array.isArray(m.state?.moves) && m.state.moves.length >= 1,
        '对方收到超时之后的那一步',
        20000,
      );
      // 浏览器这边也要渲染出来（走子高亮）
      await page.waitForExpr(
        `!!document.querySelector('[data-square="e4"].lastmove')`,
        '浏览器渲染出超时之后走的那一步',
        20000,
      );
      /*
       * 超时的判定**不变** —— 结果是锁定的，超时方那一行仍然挂着「已超时」。
       * （这条守的就是「锁定」：服务端要是把结果改写了，这个标记就会掉。）
       */
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      if (info.whiteBadge !== '已超时') {
        throw new Error(
          `T5 走了一步之后「已超时」标记不见了（读到 ${JSON.stringify(info.whiteBadge)}）—— 锁定的判定不该被改写`,
        );
      }
      if (info.banner !== null) {
        throw new Error(`T5 走了一步之后结果卡冒出来了「${info.banner}」—— 这一局还在下，不该有终局卡`);
      }
      verdict(true, 'T5 超时之后这局还能继续下', '走了一步，「已超时」标记不变，也没有终局卡');
      return true;
    });

    /* ---------------- T6 再来一局 ---------------- */
    await step('T6', '超时后「再来一局」按钮还在', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      if (info.rematchText !== '再来一局') {
        throw new Error(
          `T6 白方那一行没有「再来一局」按钮（读到 ${JSON.stringify(info.rematchText)}）` +
            ` —— 超时判负后结果已定，应该允许换局`,
        );
      }
      verdict(true, 'T6 超时后「再来一局」按钮还在', '再来一局');
      return true;
    });

    /* ---------------- T7 名字没被挤没 ---------------- */
    await step('T7', '超时那一行的名字没被挤成一个字', async () => {
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      /*
       * HUD 列只有 260px，而超时那一行同时有「已超时」标记、棋钟和「再来一局」按钮。
       * 全挤在一行的话，名字会被压成**一个字**（省略号都放不下）——
       * 认不出人，比多一行严重得多。
       *
       * 判据：名字的可见宽度至少容得下 3 个字。
       */
      const visible = info.nameWidth / Math.max(1, info.charWidth);
      if (visible < 3) {
        throw new Error(
          `T7 名字只剩 ${visible.toFixed(1)} 个字的宽度（${Math.round(info.nameWidth)}px）` +
            ` —— 这一行挤爆了，名字要能换行/保留宽度`,
        );
      }
      verdict(true, 'T7 超时那一行的名字没被挤成一个字', `${visible.toFixed(1)} 个字宽`);
      return true;
    });

    /* ---------------- T8 超时局面里没有「复盘」 ---------------- */
    await step('T8', '超时后没有「复盘」按钮（这局还没结束）', async () => {
      /*
       * 复盘的门槛是「**这一局刚刚结束**」（`status === 'finished'`）。
       * 超时判负**不是**终局 —— 房间状态保持 `playing`，这局还在下。
       *
       * 所以超时局面里：
       *   - 不该有「复盘」按钮（复盘是「回看一盘下完的棋」）；
       *   - 更不该有复盘控制器（还原 / 上一步 / 下一步）。
       *
       * 这条守的是「**复盘别把超时局面也吃了**」：
       * 复盘开着的时候，棋盘显示的是**复盘的局面**而不是实时局面，
       * 而且走子会被复盘接管（不再发给服务端）。
       * 要是超时时也能进复盘，这一局就等于下不了了 —— 正是「超时判负但还能继续下」要防的事。
       */
      const info = (await page.evaluate<RowsInfo>(READ_ROWS)) as RowsInfo;
      if (info.replayBtn) {
        throw new Error('T8 超时后 HUD 里冒出了「复盘」按钮 —— 这一局还没结束，不该能进复盘');
      }
      const controller = await page.evaluate<boolean>(
        `[...document.querySelectorAll('.hud-actions button')].some((b) =>
           ['还原', '上一步', '下一步', '退出复盘'].includes((b.textContent || '').trim()))`,
      );
      if (controller) {
        throw new Error('T8 超时后 HUD 里冒出了复盘控制器 —— 这局还在下，棋盘不能被复盘接管');
      }
      verdict(true, 'T8 超时后没有「复盘」按钮', '没有复盘按钮，也没有复盘控制器');
      return true;
    });

    await page.screenshot(join(OUT_DIR, 'timeout-room.png'));
    console.log(`   · 截图：${join(OUT_DIR, 'timeout-room.png')}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n共 ${results.length} 条，跳过 ${skipped.length} 条，失败 ${failed.length} 条`);
    if (failed.length > 0) {
      for (const f of failed) console.error(`❌ ${f.label}：${f.detail}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('门禁脚本本身崩了：', e instanceof Error ? e.stack : String(e));
    process.exit(2);
  });
