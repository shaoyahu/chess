/**
 * 「复盘 + 终局提示」门禁 —— `scripts/verify-replay.ts`
 *
 * ## 这套门禁在验什么
 *
 * 两条需求：
 *
 * ① **终局提示不许挪动页面**。原来「黑方胜利 · 将死」是插在棋盘**上面**的一条
 *    横幅（占文档流），一出现就把棋盘往下顶 —— 棋盘、HUD、聊天全被挪了位置。
 *    现在改成**浮在棋盘正中**的结果卡（绝对定位，不占文档流）。
 *
 * ② **复盘**。终局后双方各出现一个「复盘」按钮；点开出现控制器
 *    （还原 / 上一步 / 下一步）；上一步下一步按棋谱重放；
 *    复盘里还能**操控任意一方**的棋子自由走棋；
 *    自由走棋之后步进键藏起来，只剩「还原」能出去；
 *    而且**复盘是各看各的** —— 两个人各走各的进度，互不影响。
 *
 * | 编号 | 验什么 |
 * |------|--------|
 * | R1 | 结果卡浮在棋盘正中、**不占文档流**，且不挪动棋盘与其他元素 |
 * | R2 | 终局后**双方**都出现「复盘」按钮 |
 * | R3 | 点「复盘」→ HUD 里出现 还原 / 上一步 / 下一步 |
 * | R4 | 「上一步 / 下一步」沿**棋谱**走（棋盘退回到相邻的那一手） |
 * | R5 | 「还原」回到**开局**局面 |
 * | R6 | 复盘里能走**对方**的子（自由走棋），棋盘跟着变 |
 * | R7 | 自由走棋后**步进键藏起来**；「还原」回到自由走棋之前，步进键回来 |
 * | R8 | 复盘里的走子**不发服务端**（报文流水里没有 move） |
 * | R9 | 两个人各走各的复盘进度，**互不影响** |
 *
 * ## 判定方式
 *
 * 进程退出码 + 门禁自己打印的 ❌ 行（必须带编号 R1~R9）。
 * 变异脚本靠「❌ 行里含编号」判定「这条被抓到了」。
 *
 * ## 怎么读棋盘
 *
 * 棋盘的状态**从 DOM 里重建**：棋子 div 的 `left/top` 是显示坐标（百分比），
 * 棋子的 SVG 上有 `aria-label`（如「白方马」），棋盘下沿的坐标标注能定出朝向。
 * 于是能把页面上的棋盘还原成「每格一枚什么子」，和 chess.js 算出的期望局面**逐子比对**。
 *
 * 用法：
 *   npx tsx scripts/verify-replay.ts [--url=http://127.0.0.1:3000] [--group=layout,replay]
 *
 * 零新增依赖：复用项目已有的 ws / chess.js；Chromium 用本机 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { Browser, Page, sleep } from './lib/browser';
import { GameClient } from './lib/game-client';
import { TestServer, warmUpUrl } from './lib/test-server';
import { makeGateFilter, parseGroupFilter } from './lib/gate-groups';
import { REPLAY_GROUPS } from './lib/replay-groups';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */
/*
 * 这套门禁**自己起服务端**（不连外部服务）。
 *
 * 为什么：它要造一个「两个人 + 已经下完 + 已经终局」的房间，
 * 而那个房间得是**这次门禁独有**的 —— 连到用户正在跑的服务上，
 * 门禁造出来的测试房间会落进用户的真实存档（.data/rooms.json）。
 *
 * 服务端起在**随机端口** + **隔离的存档目录** + **隔离的构建目录**，
 * 三样都不会碰到用户自己的东西（见 scripts/lib/test-server.ts）。
 */
const selectedGroups = parseGroupFilter(REPLAY_GROUPS, process.argv.slice(2));
const gateFilter = makeGateFilter(REPLAY_GROUPS, selectedGroups);

/** 门禁自己起的服务（main 里赋值） */
let APP_URL = '';
let WS_URL = '';

const OUT_DIR = join(process.cwd(), 'artifacts', 'replay');
const VIEW_W = 1600;
const VIEW_H = 1000;

/*
 * 构建目录**隔离** —— 门禁起的是 dev 模式的 Next，它启动时会先清空 distDir。
 * 不隔离的话，跑一次门禁用户的 `npm start` 生产构建就没了。
 */
process.env.NEXT_DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next-gate-replay';

/** 门禁里两个浏览器的名字（各占一个座位，模拟两个人） */
const NAME_A = '复盘甲';
const NAME_B = '复盘乙';

/* ------------------------------------------------------------------ */
/* 局面比对                                                            */
/* ------------------------------------------------------------------ */

/** 棋子的类型代号（与 DOM 里 aria-label 对应） */
const PIECE_BY_CN: Record<string, string> = {
  兵: 'p',
  马: 'n',
  象: 'b',
  车: 'r',
  后: 'q',
  王: 'k',
};

/**
 * 把走子方翻过来（并清掉吃过路兵格）。
 *
 * 复盘里的自由走棋**走的可能不是走子方** —— 那就得先翻面再走。
 * 门禁算期望局面时必须**用同一条规则**，否则算出来的是「正常对局」的着法
 * （而正常对局里那步根本不合法）。
 */
function flipTurn(fen: string): string {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

/**
 * 把一个局面算成「每格一枚什么子」的**规范字符串**。
 *
 * 格式：`a1wp b1wn …`（按格名排序）——
 * 排序是为了让两个局面能直接比字符串（顺序不同但内容一样 = 一样）。
 */
function boardFromFen(fen: string): string {
  const game = new Chess(fen);
  const out: string[] = [];
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell) continue;
      out.push(`${cell.square}${cell.color === 'w' ? 'w' : 'b'}${cell.type}`);
    }
  }
  return out.sort().join(' ');
}

/**
 * 从**页面 DOM** 里重建棋盘。
 *
 * 棋子 div 的 `left/top` 是**显示坐标**（百分比，12.5% 一格），
 * 要靠棋盘下沿的坐标标注定出朝向再换算回真实格名。
 * 棋子的种类从 SVG 的 `aria-label`（如「黑方马」）读。
 */
async function readBoard(page: Page): Promise<string> {
  return page.evaluate<string>(`(() => {
    const files = [...document.querySelectorAll('.board2d .coord.file')].map((e) => (e.textContent || '').trim());
    const white = files[0] === 'a';
    const byCn = ${JSON.stringify(PIECE_BY_CN)};
    const out = [];
    for (const el of document.querySelectorAll('.board2d .piece-layer .piece')) {
      const left = parseFloat(el.style.left || '0');
      const top = parseFloat(el.style.top || '0');
      const col = Math.round(left / 12.5);
      const row = Math.round(top / 12.5);
      const label = (el.querySelector('svg')?.getAttribute('aria-label') || '').trim();
      const m = /^(白方|黑方)(兵|马|象|车|后|王)$/.exec(label);
      if (!m) continue;
      const color = m[1] === '白方' ? 'w' : 'b';
      const file = white ? col : 7 - col;
      const rank = white ? 8 - row : row + 1;
      out.push(String.fromCharCode(97 + file) + rank + color + byCn[m[2]]);
    }
    return out.sort().join(' ');
  })()`);
}

/** 等棋盘变成期望的局面 */
async function waitBoard(
  page: Page,
  expected: string,
  label: string,
  timeoutMs = 20000,
): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await readBoard(page);
    if (last === expected) return;
    await sleep(200);
  }
  throw new Error(`等待「${label}」超时。棋盘=${last}｜期望=${expected}`);
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

/** 登录进大厅 */
async function login(page: Page, name: string): Promise<void> {
  await page.navigate(APP_URL);
  await page.waitForExpr(`document.readyState === 'complete'`, '首页加载');
  await sleep(500);
  await page.waitForExpr(`!!document.querySelector('input.input')`, '用户名输入框');
  // 等 socket 连上 —— 不等就点「进入大厅」，点了等于没点（名字送不出去）
  await page.waitConnected();
  await page.fillInput('input.input', name);
  await page.clickText('button', '进入大厅', '进入大厅');
  await page.waitForExpr(
    `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('人机对弈'))`,
    '大厅页面',
    20000,
  );
}

/** 进房间并等棋盘出现 */
async function enterRoom(page: Page, code: string): Promise<void> {
  await page.navigate(`${APP_URL}/room/${code}`);
  await page.waitForExpr(`!!document.querySelector('.board2d')`, '棋盘出现', 25000);
  await sleep(400);
}

/** 点「准备」 */
async function clickReady(page: Page): Promise<void> {
  await page.waitForExpr(
    `[...document.querySelectorAll('.hud-actions button')].some((b) => (b.textContent || '').trim() === '准备')`,
    '「准备」按钮出现',
    25000,
  );
  await page.clickText('button', '准备', '「准备」按钮');
  await sleep(300);
}

/** 点一个格子（走子靠「点起点 → 点终点」两步） */
async function clickSquare(page: Page, square: string): Promise<void> {
  const ok = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('.board2d [data-square="${square}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`点不到格子 ${square}`);
  await sleep(120);
}

/** 走一步棋（点起点 → 点终点） */
async function playMove(page: Page, from: string, to: string): Promise<void> {
  await clickSquare(page, from);
  await clickSquare(page, to);
}

/**
 * 这一页是**白方视角**还是**黑方视角**。
 *
 * 棋盘下沿最左边的坐标标注：白方视角是 `a`，黑方视角是 `h`。
 * 黑白是**抽签**定的，所以门禁必须先问一句「我是谁」再决定怎么走。
 */
async function orientationOf(page: Page): Promise<'w' | 'b'> {
  const first = await page.evaluate<string>(
    `(() => { const el = document.querySelector('.board2d .coord.file'); return el ? (el.textContent || '').trim() : ''; })()`,
  );
  return first === 'a' ? 'w' : 'b';
}

/** HUD 里有没有某个按钮（按文字精确匹配，trim 之后比） */
async function hasHudButton(page: Page, text: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const want = ${JSON.stringify(text)};
    return [...document.querySelectorAll('.hud-actions button')]
      .some((b) => (b.textContent || '').trim() === want);
  })()`);
}

/** 点 HUD 里的某个按钮（限定在 .hud-actions 里，别点到别处同名按钮） */
async function clickHudButton(page: Page, text: string): Promise<void> {
  const ok = await page.evaluate<boolean>(`(() => {
    const want = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll('.hud-actions button')]
      .find((b) => (b.textContent || '').trim() === want);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`点不到 HUD 按钮「${text}」`);
  await sleep(350);
}

/** HUD 按钮是不是禁用 */
async function hudButtonDisabled(page: Page, text: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const want = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll('.hud-actions button')]
      .find((b) => (b.textContent || '').trim() === want);
    return el ? !!el.disabled : false;
  })()`);
}

/** 点「再来一局」（在**自己那一行**里，class 是 `.rematch-btn`） */
async function clickRematch(page: Page): Promise<void> {
  await page.waitForExpr(`!!document.querySelector('.rematch-btn')`, '「再来一局」按钮出现', 15000);
  const ok = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('.rematch-btn');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error('点不到「再来一局」');
  await sleep(300);
}

/** HUD 状态行上的文字（复盘时写的是「复盘中」） */
async function pageStatusText(page: Page): Promise<string> {
  return page.evaluate<string>(
    `((document.querySelector('.hud-status') || {}).textContent || '').trim()`,
  );
}

/* ------------------------------------------------------------------ */
/* 服务端自己的存档 = 事实来源                                          */
/* ------------------------------------------------------------------ */
/*
 * 为什么不能靠那个 `host` ws 客户端看房间状态：
 *   它开局建完房就 `room.leave` 让出了座位 —— **不在房间里了**，
 *   收不到房间广播。于是「等新一局开始」永远等不到。
 *
 * 门禁自己起的服务把存档写在**隔离的目录**里（`LAN_CHESS_DATA_DIR`），
 * 那份 `rooms.json` 就是**服务端自己的状态** —— 比任何客户端转述都可靠。
 * （写盘是节流的，最多每 2 秒一次，所以要轮询。）
 */

interface ServerRoom {
  fen: string;
  moves: number;
  status: string;
}

/** 从服务端存档里读这个房间（读不到就 null —— 文件还没写出来） */
function readServerRoom(dataDir: string, code: string): ServerRoom | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'rooms.json'), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return null;
    for (const arch of raw) {
      const st = (arch as { state?: Record<string, unknown> })?.state;
      if (!st || st.code !== code) continue;
      return {
        fen: String(st.fen ?? ''),
        moves: Array.isArray(st.moves) ? st.moves.length : 0,
        status: String(st.status ?? ''),
      };
    }
  } catch {
    /* 文件还没写出来 */
  }
  return null;
}

/** 等服务端的房间状态满足某个条件 */
async function waitServerRoom(
  dataDir: string,
  code: string,
  label: string,
  pred: (r: ServerRoom) => boolean,
  timeoutMs = 20000,
): Promise<ServerRoom> {
  const start = Date.now();
  let last: ServerRoom | null = null;
  while (Date.now() - start < timeoutMs) {
    last = readServerRoom(dataDir, code);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`等待「${label}」超时。最后读到：${JSON.stringify(last)}`);
}

/** 页面里所有「已发出的报文」里有没有某一种 */
async function sentMessageTypes(page: Page): Promise<string[]> {
  const log = await page.wsLog();
  return [...new Set(log.filter((e) => e.dir === 'out').map((e) => e.t))];
}

/** 已经发出的 move 报文条数（用来分辨「对局里的走子」和「复盘里的走子」） */
async function sentMoveCount(page: Page): Promise<number> {
  const log = await page.wsLog();
  return log.filter((e) => e.dir === 'out' && e.t === 'move').length;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
interface Result {
  label: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

/** 进复盘之前，浏览器已经发过多少条 move（对局里的走子） */
let movesBeforeReplay = 0;

function verdict(ok: boolean, label: string, detail: string): void {
  results.push({ label, ok, detail });
  if (ok) {
    console.log(`✅ ${label}`);
    console.log(`   ${detail}`);
  } else {
    console.log(`❌ ${label}`);
    console.log(`   ${detail}`);
  }
}

/** 每条门禁的标题（编号 → 说明） */
const GATE_TITLES: Record<string, string> = {
  R1: '结果卡浮在棋盘正中、不占文档流、不挪动其他元素',
  R2: '终局后双方都出现「复盘」按钮',
  R3: '点「复盘」→ HUD 里出现 还原 / 上一步 / 下一步',
  R4: '「上一步 / 下一步」沿棋谱前后走',
  R5: '「还原」回到开局局面（且上一步置灰）',
  R6: '复盘里能走「不是走子方」的子（自由走棋）',
  R7: '自由走棋后步进键藏起来；「还原」回到自由走棋之前且步进键回来',
  R8: '复盘里的走子不发服务端（报文流水里没有新的 move）',
  R9: '复盘是各看各的：甲的复盘不影响乙，乙进复盘也只影响自己',
  R10: '窄屏下复盘控制器不把棋盘挤没（430×932 与 800×500 两个视口）',
  R11: '「再来一局」之后复盘自动退出，棋盘跟着新局走',
};

/** 门禁的完整标题（带编号） */
function labelOf(id: string): string {
  return `${id} ${GATE_TITLES[id] ?? ''}`.trim();
}

/**
 * 跑一条门禁。
 *
 * ## 门禁自己抛错时，也要按**它自己的编号**记红
 *
 * 这不是洁癖，是**变异脚本能不能抓到它**的前提：
 *   门禁里「等棋盘变成某个局面」超时，本来就是这条门禁**判负**的正常表现
 *   （功能坏了 → 棋盘没变 → 等不到 → 抛错）。
 *   如果让它一路抛到最外层，报出来的编号是 R0（脚本出错）——
 *   变异脚本按编号找红，找不到 R4 → 「这条变异没被抓到」→ **假绿**：
 *   门禁明明红了，变异脚本却认为它没红。
 *
 * 所以每条门禁自己兜住异常 → 记成**自己的编号** → **继续跑下一条**
 * （后面几条也可能是红的：功能坏了，后面的判据自然对不上）。
 */
async function step(id: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    verdict(
      false,
      labelOf(id),
      `门禁执行失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot(join(OUT_DIR, `${name}.png`));
  } catch {
    /* 截图失败不影响判定 */
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-replay-'));

  /*
   * 起服务 / 起浏览器都放进 try ——
   * 之前它们在 try 外面，失败就是一句裸的 Node 堆栈：
   *   门禁脚本自己挂了 → 变异脚本只能看到「没有 ❌ 行」→ 报「没抓到」。
   * 那不是「没抓到」，那是**根本没跑起来**。两件事必须分得清：
   * 失败时按 R0 记一行（前置步骤失败），退出码非 0，
   * 变异脚本看到 R0 会明确知道「这条变异把应用编译搞挂了」，而不是判据没红。
   */
  let server: TestServer | null = null;
  let browser: Browser | null = null;
  try {
    server = await TestServer.start(dataDir);
    APP_URL = server.url;
    WS_URL = server.wsUrl;
    browser = await Browser.launch({ width: VIEW_W, height: VIEW_H });
  } catch (err) {
    verdict(
      false,
      'R0 门禁脚本自身出错（前置步骤失败）',
      `起服务/起浏览器失败：${err instanceof Error ? err.message : String(err)}`,
    );
    await server?.stop();
    await browser?.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`门禁服务已起：${APP_URL}`);

  /*
   * 两个页面（**隔离上下文** = 两台设备）。
   * 用 `!` 断言：它们在下面的 try 里创建，之后每一条门禁都要用。
   */
  let pageA!: Page;
  let pageB!: Page;
  const host = new GameClient(WS_URL);

  try {
    /* ---------------- 准备：两个人进同一间房 ---------------- */
    await host.ready();
    await host.hello('房主');
    host.send({ t: 'room.create', timeControl: '30+0' });
    const roomMsg = await host.waitFor((m) => (m.t === 'room' ? m : null), '房间快照');
    const code = String((roomMsg as any).state?.code ?? '');
    if (!code) throw new Error('建房失败：没有房间码');
    // 预热房间页路由（dev 模式按需编译 —— 把编译挪到门禁计时之外）
    await warmUpUrl(APP_URL, `/room/${code}`);
    // 房主让出座位（房间保留在「等待对手加入」状态）
    host.send({ t: 'room.leave' });
    await sleep(500);

    // 两个**隔离上下文**的页面 = 两台设备（各自的 localStorage、各自的身份）
    pageA = await browser.newIsolatedPage();
    pageB = await browser.newIsolatedPage();
    await Promise.all([login(pageA, NAME_A), login(pageB, NAME_B)]);
    await Promise.all([enterRoom(pageA, code), enterRoom(pageB, code)]);

    // 抽签 → 双方都点准备 → 开局
    await Promise.all([clickReady(pageA), clickReady(pageB)]);
    await sleep(1200);

    const oriA = await orientationOf(pageA);
    const oriB = await orientationOf(pageB);
    if (oriA === oriB) throw new Error(`两个浏览器居然是同一个视角（${oriA}）—— 抽签没生效`);
    const white = oriA === 'w' ? pageA : pageB;
    const black = oriA === 'w' ? pageB : pageA;

    /* ---------------- 走出将死（愚人将死，4 手） ---------------- */
    const game = new Chess();
    // 1. f3 e5  2. g4 Qh4#
    const line: Array<[Page, string, string]> = [
      [white, 'f2', 'f3'],
      [black, 'e7', 'e5'],
      [white, 'g2', 'g4'],
      [black, 'd8', 'h4'],
    ];
    const boards: string[] = [boardFromFen(game.fen())];
    const fens: string[] = [game.fen()];
    for (const [page, from, to] of line) {
      const before = game.fen();
      game.move({ from, to });
      const after = game.fen();
      if (after === before) throw new Error(`着法 ${from}→${to} 不合法`);
      await playMove(page, from, to);
      await waitBoard(page, boardFromFen(after), `走完 ${from}→${to}`);
      boards.push(boardFromFen(after));
      fens.push(after);
    }
    const finalBoard = boards[boards.length - 1];

    /* ---------------- R1：结果卡浮在棋盘上，不挪动页面 ---------------- */
    if (gateFilter('R1')) {
      await step('R1', async () => {
        await pageA.waitForExpr(`!!document.querySelector('.result-card')`, '结果卡出现', 15000);
        const info = await pageA.evaluate<{
          found: boolean;
          cardPos: string;
          cardRect: { top: number; left: number; width: number; height: number };
          boardRect: { top: number; left: number; width: number; height: number };
          parentClass: string;
        }>(`(() => {
        const card = document.querySelector('.result-card');
        const overlay = document.querySelector('.result-overlay');
        const board = document.querySelector('.board-frame');
        const br = board.getBoundingClientRect();
        if (!card || !overlay) {
          return {
            found: false,
            cardPos: 'missing',
            cardRect: { top: 0, left: 0, width: 0, height: 0 },
            boardRect: { top: br.top, left: br.left, width: br.width, height: br.height },
            parentClass: '',
          };
        }
        const cr = card.getBoundingClientRect();
        return {
          found: true,
          cardPos: getComputedStyle(overlay).position,
          cardRect: { top: cr.top, left: cr.left, width: cr.width, height: cr.height },
          boardRect: { top: br.top, left: br.left, width: br.width, height: br.height },
          parentClass: overlay.parentElement?.className || '',
        };
      })()`);
        /*
         * 差分：把结果卡临时藏起来，看棋盘**会不会动**。
         *
         * 为什么用差分而不是「前后各量一次」：
         *   终局那一刻页面上**同时**发生了别的事（玩家行冒出「再来一局」按钮…），
         *   前后量两次量到的是「所有变化的合集」，分不清是谁挪的。
         *   差分只动结果卡这一个变量 —— 它藏起来棋盘要是不动，
         *   就说明结果卡确实**不占位置**。
         */
        const diff = await pageA.evaluate<{ boardTop: number; boardLeft: number }>(`(() => {
        const overlay = document.querySelector('.result-overlay');
        const board = document.querySelector('.board-frame');
        if (overlay) overlay.style.display = 'none';
        const br = board.getBoundingClientRect();
        const out = { boardTop: br.top, boardLeft: br.left };
        if (overlay) overlay.style.display = '';
        return out;
      })()`);
        const visible = await pageA.evaluate<{ boardTop: number; boardLeft: number }>(`(() => {
        const board = document.querySelector('.board-frame');
        const br = board.getBoundingClientRect();
        return { boardTop: br.top, boardLeft: br.left };
      })()`);

        const onBoard =
          info.found &&
          info.cardRect.top + info.cardRect.height / 2 > info.boardRect.top &&
          info.cardRect.top + info.cardRect.height / 2 < info.boardRect.top + info.boardRect.height &&
          info.cardRect.left + info.cardRect.width / 2 > info.boardRect.left &&
          info.cardRect.left + info.cardRect.width / 2 < info.boardRect.left + info.boardRect.width;
        /*
         * **居中** —— 需求写的是「棋盘**正中**浮一张结果卡」。
         *
         * 只判「在棋盘上」不够：卡片掉到棋盘下沿（还在棋盘范围内）
         * 也会蒙混过关 —— 变异【二】正是这么溜过去的。
         * 所以量卡片中心与棋盘中心的偏差，容差 12% 棋盘边长。
         */
        const dx = Math.abs(
          info.cardRect.left + info.cardRect.width / 2 -
            (info.boardRect.left + info.boardRect.width / 2),
        );
        const dy = Math.abs(
          info.cardRect.top + info.cardRect.height / 2 -
            (info.boardRect.top + info.boardRect.height / 2),
        );
        const centered =
          info.found &&
          dx <= info.boardRect.width * 0.12 &&
          dy <= info.boardRect.height * 0.12;
        const outOfFlow = info.cardPos === 'absolute' || info.cardPos === 'fixed';
        const noShift =
          Math.abs(diff.boardTop - visible.boardTop) < 0.5 &&
          Math.abs(diff.boardLeft - visible.boardLeft) < 0.5;
        const ok = onBoard && centered && outOfFlow && noShift;
        await shot(pageA, 'r1-result-card');
        verdict(
          ok,
          labelOf('R1'),
          `找得到卡=${info.found}｜position=${info.cardPos}｜浮在棋盘上=${onBoard}｜` +
            `居中=${centered}（偏差 ${dx.toFixed(0)}×${dy.toFixed(0)}px）｜` +
            `藏起来棋盘不动=${noShift}（藏=${diff.boardTop.toFixed(1)}/${diff.boardLeft.toFixed(1)}｜` +
            `显=${visible.boardTop.toFixed(1)}/${visible.boardLeft.toFixed(1)}）｜` +
            `父容器=${info.parentClass}`,
        );
      });
    }

    /* ---------------- R2：双方都有「复盘」按钮 ---------------- */
    if (gateFilter('R2')) {
      await step('R2', async () => {
        const [hasA, hasB] = await Promise.all([
          hasHudButton(pageA, '复盘'),
          hasHudButton(pageB, '复盘'),
        ]);
        verdict(hasA && hasB, labelOf('R2'), `甲=${hasA}｜乙=${hasB}`);
      });
    }

    /* ---------------- R3：点开有控制器 ---------------- */
    if (gateFilter('R3')) {
      await step('R3', async () => {
        // 先记下**对局里**已经发过多少条 move —— R8 要靠它分辨
        // 「复盘里的走子」和「棋局本身的走子」
        movesBeforeReplay = await sentMoveCount(pageA);
        await clickHudButton(pageA, '复盘');
        await sleep(400);
        const [reset, prev, next] = await Promise.all([
          hasHudButton(pageA, '还原'),
          hasHudButton(pageA, '上一步'),
          hasHudButton(pageA, '下一步'),
        ]);
        await shot(pageA, 'r3-controller');
        verdict(
          reset && prev && next,
          labelOf('R3'),
          `还原=${reset}｜上一步=${prev}｜下一步=${next}`,
        );
      });
    }

    /* ---------------- R4：上一步/下一步沿棋谱走 ---------------- */
    if (gateFilter('R4')) {
      await step('R4', async () => {
        // 进复盘时停在终局（第 4 手）→ 上一步 = 第 3 手
        await clickHudButton(pageA, '上一步');
        await waitBoard(pageA, boards[3], '上一步回到第 3 手');
        const prevOk = (await readBoard(pageA)) === boards[3];
        // 再下一步 → 回第 4 手
        await clickHudButton(pageA, '下一步');
        await waitBoard(pageA, boards[4], '下一步回到第 4 手');
        const nextOk = (await readBoard(pageA)) === boards[4];
        // 再上一步 → 第 3 手（往返一次，验证不是单向）
        await clickHudButton(pageA, '上一步');
        await waitBoard(pageA, boards[3], '再上一步回到第 3 手');
        const backOk = (await readBoard(pageA)) === boards[3];
        await shot(pageA, 'r4-step-back');
        verdict(
          prevOk && nextOk && backOk,
          labelOf('R4'),
          `上一步→第3手=${prevOk}｜下一步→第4手=${nextOk}｜再上一步→第3手=${backOk}`,
        );
      });
    }

    /* ---------------- R5：还原回到开局 ---------------- */
    if (gateFilter('R5')) {
      await step('R5', async () => {
        await clickHudButton(pageA, '还原');
        await waitBoard(pageA, boards[0], '还原回到开局');
        const backToStart = (await readBoard(pageA)) === boards[0];
        const prevDisabled = await hudButtonDisabled(pageA, '上一步');
        await shot(pageA, 'r5-reset');
        verdict(
          backToStart && prevDisabled,
          labelOf('R5'),
          `回到开局=${backToStart}｜上一步置灰=${prevDisabled}`,
        );
      });
    }

    /* ---------------- R6：自由走棋（能走对方的子） ---------------- */
    if (gateFilter('R6')) {
      await step('R6', async () => {
        // 先走到第 2 手（f3 e5），再让**黑方**的兵 e5→e4 走一步（此时轮到白方）
        await clickHudButton(pageA, '下一步');
        await waitBoard(pageA, boards[1], '下一步到第 1 手');
        await clickHudButton(pageA, '下一步');
        await waitBoard(pageA, boards[2], '下一步到第 2 手');

        /*
         * 自由走棋的关键：走**不是走子方**的子。
         *
         * 第 2 手之后轮到白方（f3 e5 之后是白方走），
         * 所以这里让**黑兵** e5→e4 —— 正常对局里这步根本轮不到黑方走。
         *
         * 期望局面按**同一条规则**算：把走子方翻过来再走
         * （翻面时清掉吃过路兵格 —— 与实现一致）。
         */
        const freeGame = new Chess(flipTurn(fens[2]));
        freeGame.move({ from: 'e5', to: 'e4' });
        const freeBoard = boardFromFen(freeGame.fen());

        await playMove(pageA, 'e5', 'e4');
        await waitBoard(pageA, freeBoard, '自由走棋（黑兵 e5→e4）');
        const moved = (await readBoard(pageA)) === freeBoard;
        await shot(pageA, 'r6-free-move');
        verdict(
          moved,
          labelOf('R6'),
          `走的是黑兵 e5→e4（当时轮到白方）｜棋盘=${moved}`,
        );
      });
    }

    /* ---------------- R7：自由走棋后步进键藏起来；还原后回来 ---------------- */
    if (gateFilter('R7')) {
      await step('R7', async () => {
        const [prevShown, nextShown] = await Promise.all([
          hasHudButton(pageA, '上一步'),
          hasHudButton(pageA, '下一步'),
        ]);
        const hidden = !prevShown && !nextShown;
        // 还原 → 回到自由走棋之前（第 2 手），步进键重新出现
        await clickHudButton(pageA, '还原');
        await waitBoard(pageA, boards[2], '还原回到自由走棋之前');
        const backToPreFree = (await readBoard(pageA)) === boards[2];
        const [prevBack, nextBack] = await Promise.all([
          hasHudButton(pageA, '上一步'),
          hasHudButton(pageA, '下一步'),
        ]);
        await shot(pageA, 'r7-free-reset');
        verdict(
          hidden && backToPreFree && prevBack && nextBack,
          labelOf('R7'),
          `藏起来=${hidden}｜回到自由走棋之前=${backToPreFree}｜` +
            `上一步回来=${prevBack}｜下一步回来=${nextBack}`,
        );
      });
    }

    /* ---------------- R8：复盘里的走子不发服务端 ---------------- */
    if (gateFilter('R8')) {
      await step('R8', async () => {
        const after = await sentMoveCount(pageA);
        const sentMove = after > movesBeforeReplay;
        verdict(
          !sentMove,
          labelOf('R8'),
          `进复盘前已发 move=${movesBeforeReplay} 条｜现在=${after} 条｜` +
            `复盘期间多发=${sentMove}`,
        );
      });
    }

    /* ---------------- R9：两个人各看各的 ---------------- */
    if (gateFilter('R9')) {
      await step('R9', async () => {
        /*
         * 甲的复盘停在第 2 手（第 3 手之前），乙**还没进复盘** ——
         * 乙的棋盘必须还是终局局面（甲的复盘动不了乙的棋盘）。
         */
        const bBefore = await readBoard(pageB);
        const bUntouched = bBefore === finalBoard;

        // 乙现在进复盘 → 停在终局；甲在第 2 手 → 两边棋盘不同
        await clickHudButton(pageB, '复盘');
        await sleep(500);
        const bAtEnd = (await readBoard(pageB)) === finalBoard;
        const aAt = await readBoard(pageA);
        const independent = aAt !== (await readBoard(pageB));
        await shot(pageA, 'r9-a');
        await shot(pageB, 'r9-b');
        verdict(
          bUntouched && bAtEnd && independent,
          labelOf('R9'),
          `甲进复盘前乙的棋盘没变=${bUntouched}｜乙进复盘后停在终局=${bAtEnd}｜` +
            `两边棋盘不同=${independent}`,
        );
      });
    }
    /* ---------------- R10：窄屏下复盘控制器不把棋盘挤没 ---------------- */
    if (gateFilter('R10')) {
      await step('R10', async () => {
        /*
         * 两个视口，测的是**两种不同的约束**（与既有的窄屏门禁同一条道理）：
         *
         * ① 430×932（真实手机）：棋盘**宽度受限** —— HUD 再高也挤不动棋盘，
         *    这里量的是「别把页面顶出滚动条、别横向溢出」。
         * ② 800×500（宽而矮）：棋盘**高度受限** —— 这才是 HUD 变高
         *    会真正挤掉棋盘的场景（复盘控制器有 4 个键，比「复盘」那 1 个高）。
         *
         * 少测 ② 的话 ① 永远是绿的 —— 那这条门禁等于没有。
         */
        const measure = async (): Promise<{
          sh: number;
          ih: number;
          sw: number;
          cw: number;
          board: number;
          hud: number;
        }> =>
          pageA.evaluate(`(() => {
            const b = document.querySelector('.board-frame');
            const br = b ? b.getBoundingClientRect() : null;
            const doc = document.documentElement;
            return {
              sh: doc.scrollHeight,
              ih: window.innerHeight,
              sw: doc.scrollWidth,
              cw: doc.clientWidth,
              board: br ? Math.round(Math.min(br.width, br.height)) : -1,
              hud: Math.round(document.querySelector('.hud')?.getBoundingClientRect().height ?? -1),
            };
          })()`);

        await pageA.setViewport(430, 932);
        await sleep(500);
        const phone = await measure();
        await shot(pageA, 'r10-narrow-430');

        await pageA.setViewport(800, 500);
        await sleep(500);
        const squat = await measure();
        await shot(pageA, 'r10-narrow-800');

        // 回到宽屏（后面的门禁要在宽屏下跑）
        await pageA.setViewport(VIEW_W, VIEW_H);
        await sleep(400);

        const phoneOk =
          phone.board >= 200 && phone.sw <= phone.cw + 1 && phone.sh <= phone.ih + 2;
        const squatOk = squat.board >= 160 && squat.sh <= squat.ih + 2;
        verdict(
          phoneOk && squatOk,
          labelOf('R10'),
          `430×932：棋盘=${phone.board}px｜横向溢出=${phone.sw > phone.cw + 1}｜` +
            `纵向滚动=${phone.sh > phone.ih + 2}｜HUD=${phone.hud}px｜` +
            `800×500：棋盘=${squat.board}px｜纵向滚动=${squat.sh > squat.ih + 2}｜HUD=${squat.hud}px`,
        );
      });
    }

    /* ---------------- R11：新一局开始后复盘必须退出，棋盘跟着新局走 ---------------- */
    if (gateFilter('R11')) {
      await step('R11', async () => {
        /*
         * 这条守的是「**再来一局**之后复盘不能赖着不走」。
         *
         * 原来的 bug：复盘状态机里的 `active` 只管自己，开了新局也不会复位。
         * 于是新一局开始后：
         *   ① 状态行还写着「复盘中」（明明在下棋）；
         *   ② 棋盘走的是**复盘的局面**（`boardFen` 取复盘分支）——
         *      新一局走了一步，棋盘纹丝不动，人会以为自己的棋没走上去。
         *
         * 判据**不看表象**（按钮不见了只是表象），看的是**棋盘跟不跟新局走**：
         *   新一局走一步 → 棋盘必须变成服务端那个局面。
         * 只查「按钮不见了」的话，把 `boardFen` 改回实时局面、
         * 而状态行照旧写「复盘中」，这条门禁就抓不到 —— 状态行会骗人，棋盘不会。
         */
        // ① 双方都点「再来一局」→ 服务端直接开新局
        await clickRematch(pageA);
        await clickRematch(pageB);
        // 新局要重新「准备」才开（服务端规矩：换局之后回到准备环节）
        await Promise.all([clickReady(pageA), clickReady(pageB)]);
        await waitServerRoom(
          dataDir,
          code,
          '新一局开始',
          (r) => r.status === 'playing' && r.moves === 0,
        );

        // ② 新一局里，**白方**是谁？（黑白重新抽签了，要重新问一次）
        const aIsWhite = (await orientationOf(pageA)) === 'w';
        const white = aIsWhite ? pageA : pageB;
        // 等两边的棋盘都回到开局（抽签 / 准备期间会重画）
        const startBoard = boardFromFen(new Chess().fen());
        await Promise.all([
          waitBoard(pageA, startBoard, '甲的棋盘回到开局'),
          waitBoard(pageB, startBoard, '乙的棋盘回到开局'),
        ]);

        // ③ 白方走一步（e2→e4）：棋盘必须跟着**服务端**走
        await playMove(white, 'e2', 'e4');
        const live = await waitServerRoom(
          dataDir,
          code,
          '服务端收到新一局的那一步',
          (r) => r.moves === 1,
        );
        const expectBoard = boardFromFen(live.fen);
        let boardFollows = false;
        try {
          await waitBoard(white, expectBoard, '新一局走的那一步', 15000);
          boardFollows = true;
        } catch {
          boardFollows = false;
        }

        // ④ 复盘的状态**不能**还挂在页面上
        const [stillReplaying, statusText] = await Promise.all([
          hasHudButton(white, '上一步'),
          pageStatusText(white),
        ]);
        await shot(white, 'r11-new-game');

        verdict(
          boardFollows && !stillReplaying && !statusText.includes('复盘中'),
          labelOf('R11'),
          `新一局后棋盘跟着服务端走=${boardFollows}｜复盘键还在=${stillReplaying}｜` +
            `状态行写着「复盘中」=${statusText.includes('复盘中')}`,
        );
      });
    }
  } catch (err) {
    verdict(false, 'R0 门禁脚本自身出错（前置步骤失败）', err instanceof Error ? err.message : String(err));
  } finally {
    host.close();
    await browser.close();
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条。`);
  if (failed.length) {
    console.log('失败门禁：');
    for (const f of failed) console.log(`  ❌ ${f.label} —— ${f.detail}`);
  }
  writeFileSync(
    join(OUT_DIR, 'result.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  );
  process.exit(failed.length ? 1 : 0);
}

void main();
