/**
 * 「残局关卡」门禁 —— `scripts/verify-endgame-puzzles.ts`
 *
 * 为什么单独一个脚本：
 *   「残局关卡」是一条**独立的机制**（关卡列表 + 走子判定 + 提示 + 通关），
 *   跟课程演示、自由摆棋都不是一回事，混进别的脚本会让失败难定位。
 *
 * 门禁清单（13 条，G1~G13）：
 *   G1  /practice 有「残局关卡」分区，点它真的切过去。
 *   G2  关卡列表齐全，每关都带编号、主题与难度星。
 *   G3  选第 1 关 → **棋盘摆出来的就是这一关的起始局面**（棋子分布一致）。
 *   G4  走**错**一步 → 状态条提示「这一步不对」，而且**局面一步都没动**。
 *   G5  走**对**一步 → 棋盘真的推进（对手那手也自动接上了）。
 *   G6  点「提示」→ 棋盘上出现指引箭头。
 *   G7  走完整关 → 显示「通关」，并出现「下一关」；点它切到下一关。
 *   G8  页面上**没有解释性文字**（不教用户怎么点 —— 界面要自解释）。
 *   G9  窄屏（430px）**不横向溢出**。
 *   G10 主题分类筛选：点某个类别，列表只剩那一类；点「全部」能恢复。
 *   G11 对手走完之后，右栏出现「对手怎么走」的解说。
 *   G12 解说有**实质内容**：每个对手节点都带 note，字段自洽，文本不空。
 *   G13 目标那行字跟**真实收尾**对上（不写笼统的「取胜」）。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（G1…G13）——
 * 失败信息不带编号就会出现假绿（读的人不知道是哪一条挂的）。
 *
 * **这一份门禁自己也要被变异测试过**（见 scripts/mutate-endgame-puzzles.ts）。
 *
 * 用法：
 *   npx tsx scripts/verify-endgame-puzzles.ts [--url=http://127.0.0.1:3000]
 */
import { Chess } from 'chess.js';
import { Browser, sleep } from './lib/browser';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PUZZLES } from '../src/lib/practice/puzzles/data';
import { themeLabel } from '../src/lib/practice/puzzles/themes';
import { opponentNoteText } from '../src/lib/practice/puzzles/notes';
import { puzzleGoalText } from '../src/lib/practice/puzzles/goal';

/** 地址解析：优先 `--url=`，其次第一个长得像 http 地址的位置参数 */
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

/** 截图留证目录（跟别的门禁一个套路：失败时能翻出当时的画面） */
const OUT_DIR = join(process.cwd(), 'artifacts', 'endgame-puzzles');

let failures = 0;

/** 存一张截图（存不了不算失败 —— 门禁的判据不是截图） */
async function shot(page: { screenshot: (p: string) => Promise<void> }, name: string): Promise<void> {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot(join(OUT_DIR, `${name}.png`));
  } catch {
    /* ignore */
  }
}

/** 跑一条门禁：失败只记红，不中断（后面的门禁还要跑） */
async function step(id: string, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${id} ${label}`);
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${id} ${label} —— ${message}`);
  }
}

/**
 * 棋盘上**有子的格子**（从 DOM 读，不依赖页面暴露状态）。
 *
 * 棋子层是绝对定位的一堆 `.piece`（left / top 是百分比），
 * 不是画在格子里的 —— 所以不能按 `[data-square=xx] .piece` 找，
 * 得把 left / top 换算回格名。
 *
 * @param flipped 棋盘是不是黑方在下（关卡里玩家执黑时是翻转的）
 */
function pieceSquaresExpr(flipped: boolean): string {
  const file = flipped ? '7 - col' : 'col';
  const rank = flipped ? 'row + 1' : '8 - row';
  /*
   * **括号不能省**：`+` 的优先级高于 `-`，
   * 写成 `String.fromCharCode(97 + col) + 8 - row` 会被解析成
   * `('b' + 8) - row` —— 字符串先拼再相减，得到的根本不是格名。
   */
  return `(() => {
    const out = [];
    for (const el of document.querySelectorAll('.piece-layer .piece')) {
      const col = Math.round(parseFloat(el.style.left) / 12.5);
      const row = Math.round(parseFloat(el.style.top) / 12.5);
      out.push(String.fromCharCode(97 + (${file})) + (${rank}));
    }
    return out;
  })()`;
}

/** FEN 里有子的格子（升序，便于比对） */
function occupiedSquares(fen: string): string[] {
  const game = new Chess(fen);
  const out: string[] = [];
  for (const row of game.board()) {
    for (const cell of row) {
      if (cell) out.push(cell.square);
    }
  }
  return out.sort();
}

/**
 * 玩家走完第 i 手之后，**棋盘上该是什么局面**。
 *
 * 关键：对手那手是**自动走掉**的（题库里已经写好），
 * 所以走完玩家那手，棋盘已经往前走了**两手**。
 */
function positionAfterPlayerMove(puzzle: (typeof PUZZLES)[number], index: number): string {
  const step = puzzle.line[index];
  const reply = puzzle.line[index + 1];
  if (reply && reply.color !== puzzle.side) return reply.fen;
  return step.fen;
}

/** SAN → 起止格 */
function sanToSquares(fen: string, san: string): { from: string; to: string } {
  const game = new Chess(fen);
  const played = game.move(san);
  return { from: played.from, to: played.to };
}

/** 一个**合法但不是正解**的着法（用来测「走错」）；没有就返回 null */
function aWrongButLegalMove(fen: string, rightSan: string, also: string[] = []): string | null {
  const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.san);
  // 排除升变着法：升变会弹选择框，测「走错」时不想掺进升变的交互
  return (
    legal.find((san) => san !== rightSan && !also.includes(san) && !san.includes('=')) ?? null
  );
}

/** 点一格 */
async function clickSquare(
  page: { evaluate: (e: string) => Promise<unknown> },
  square: string,
): Promise<void> {
  await page.evaluate(
    `(() => { const el = document.querySelector('[data-square="${square}"]'); if (!el) throw new Error('找不到格子 ${square}'); el.click(); })()`,
  );
  await sleep(120);
}

/**
 * 等 React **hydration** 完。
 *
 * 为什么必须等：dev 模式下服务端先把 HTML 渲染出来，
 * `.board2d` 这类节点**在 hydration 之前就在 DOM 里** ——
 * 等到它出现并不代表页面「活了」。hydration 没完成时点按钮，
 * React 的 onClick 根本没挂上，点了**一点反应都没有**，
 * 而且不报任何错（最难查的一类问题）。
 *
 * 判据用 React 挂在 DOM 节点上的 `__react*` 属性：
 * hydration 完成后才会出现。
 */
async function waitHydrated(page: {
  waitForExpr: (e: string, label: string, timeoutMs?: number) => Promise<void>;
}): Promise<void> {
  await page.waitForExpr(
    `(() => {
      const el = document.querySelector('.practice-tabs button');
      if (!el) return false;
      return Object.keys(el).some((k) => k.startsWith('__react'));
    })()`,
    'React 完成 hydration',
    60000,
  );
}

/** 升变棋子在弹窗里的顺序（对应界面上的 后/车/象/马） */
const PROMOTION_INDEX: Record<string, number> = { q: 0, r: 1, b: 2, n: 3 };

/**
 * 走一手（点起点 → 点终点；升变还要在弹窗里选棋子）。
 *
 * @param fen 走这手**之前**的局面
 * @param san 要走的着法
 */
async function playMove(
  page: { evaluate: (e: string) => Promise<unknown> },
  fen: string,
  san: string,
): Promise<void> {
  const { from, to } = sanToSquares(fen, san);
  await clickSquare(page, from);
  await clickSquare(page, to);
  await sleep(150);

  // 兵到底线会弹升变框 —— 不选的话这一手走不完
  const needsPromotion = san.includes('=');
  if (needsPromotion) {
    const piece = san.split('=')[1];
    const index = PROMOTION_INDEX[piece];
    if (index === undefined) throw new Error(`看不懂的升变着法：${san}`);
    await page.evaluate(
      `(() => {
        const box = document.querySelector('.promotion-box');
        if (!box) throw new Error('升变框没出现');
        const btn = box.querySelectorAll('.promotion-options button')[${index}];
        if (!btn) throw new Error('升变框里没有第 ${index + 1} 个选项');
        btn.click();
      })()`,
    );
    await sleep(150);
  }
}

async function main(): Promise<void> {
  const browser = await Browser.launch({ width: 1440, height: 950 });
  try {
    const page = await browser.newPage();
    await page.setViewport(1440, 950);

    /* ================================================================ */
    /* G1：切到残局关卡分区                                          */
    /* ================================================================ */
    await step('G1', '/practice 有「残局关卡」分区，点它真的切过去', async () => {
      await page.navigate(`${APP_URL}/practice`);
      await page.waitForExpr(`!!document.querySelector('.board2d')`, '教学页棋盘');
      await waitHydrated(page);
      await page.clickText('button', '残局关卡', '残局关卡分区按钮');
      await page.waitForExpr(`!!document.querySelector('.puzzle-list')`, '关卡列表');
    });

    /* ================================================================ */
    /* G2：关卡列表齐全                                              */
    /* ================================================================ */
    await step('G2', '关卡列表齐全，每关带编号、主题与难度星', async () => {
      const rows = await page.evaluate<number>(`document.querySelectorAll('.puzzle-row').length`);
      if (rows !== PUZZLES.length) {
        throw new Error(`G2 关卡列表有 ${rows} 关，题库是 ${PUZZLES.length} 关`);
      }
      const no = await page.evaluate<string>(
        `((document.querySelector('.puzzle-row-no') || {}).textContent || '').trim()`,
      );
      if (no !== '1') throw new Error(`G2 第一关的编号是「${no}」，应该是 1`);
      const stars = await page.evaluate<number>(
        `document.querySelectorAll('.puzzle-row:first-child .puzzle-row-stars svg').length`,
      );
      if (stars !== 5) throw new Error(`G2 第一关的难度星是 ${stars} 颗，应该是 5`);
      const name = await page.evaluate<string>(
        `((document.querySelector('.puzzle-row-name') || {}).textContent || '').trim()`,
      );
      if (!name) throw new Error('G2 第一关没有主题名');
    });

    /* ================================================================ */
    /* G3：棋盘摆的就是这一关的起始局面                              */
    /* ================================================================ */
    /*
     * 挑一关**有「错但合法」的着法**、而且**解法里没有升变**的关卡。
     *
     *   - 没有错步可测的关卡：有的残局每一步都算对（只有一着能走通），
     *     拿那种关卡测「走错」根本测不到东西；
     *   - 有升变的关卡：升变会弹选择框，门的点子助手不处理那个交互。
     */
    const puzzle =
      PUZZLES.find(
        (p) =>
          !p.line.some((ply) => ply.san.includes('=')) &&
          aWrongButLegalMove(p.fen, p.line[0].san, p.line[0].also ?? []) !== null,
      ) ?? PUZZLES[0];
    const puzzleIndex = PUZZLES.findIndex((p) => p.id === puzzle.id);
    const flipped = puzzle.side === 'b';
    await step('G3', '选一关，棋盘摆出来的就是这一关的起始局面', async () => {
      await page.evaluate(
        `(() => { const el = document.querySelectorAll('.puzzle-row')[${puzzleIndex}]; if (!el) throw new Error('没有关卡行'); el.click(); })()`,
      );
      await sleep(500);
      const onBoard = await page.evaluate<string[]>(pieceSquaresExpr(flipped));
      const expected = occupiedSquares(puzzle.fen);
      const sorted = [...onBoard].sort();
      if (sorted.join(',') !== expected.join(',')) {
        throw new Error(
          `G3 棋盘上的子（${sorted.join(' ')}）跟起始局面（${expected.join(' ')}）对不上`,
        );
      }
    });

    /* ================================================================ */
    /* G4：走错一步 → 提示 + 局面不动                               */
    /* ================================================================ */
    await step('G4', '走错一步：提示「这一步不对」，而且局面一步都没动', async () => {
      const wrongSan = aWrongButLegalMove(puzzle.fen, puzzle.line[0].san, puzzle.line[0].also ?? []);
      if (!wrongSan) throw new Error('G4 这一关没有可以用来测「走错」的着法');
      const before = await page.evaluate<string[]>(pieceSquaresExpr(flipped));

      await playMove(page, puzzle.fen, wrongSan);
      await sleep(300);

      const status = await page.evaluate<string>(
        `((document.querySelector('.puzzle-status.wrong') || {}).textContent || '').trim()`,
      );
      if (!status) throw new Error('G4 走错了却没有出现状态提示');

      const after = await page.evaluate<string[]>(pieceSquaresExpr(flipped));
      if (before.join(',') !== after.join(',')) {
        throw new Error(`G4 走错了局面却变了（${before.join(' ')} → ${after.join(' ')}）`);
      }
      // 步数不能前进
      const steps = await page.evaluate<string>(
        `(() => {
          const rows = [...document.querySelectorAll('.practice-readout')];
          const hit = rows.find((r) => (r.textContent || '').includes('步数'));
          return hit ? (hit.textContent || '').trim() : '';
        })()`,
      );
      if (!/^步数0\s*\/\s*\d+/.test(steps.replace(/\s+/g, ' '))) {
        throw new Error(`G4 走错了但步数还是「${steps}」`);
      }
      await shot(page, 'G4-wrong-move');
    });

    /* ================================================================ */
    /* G5：走对一步 → 棋盘真的推进                                   */
    /* ================================================================ */
    await step('G5', '走对一步：棋盘真的推进了', async () => {
      const before = await page.evaluate<string[]>(pieceSquaresExpr(flipped));
      await playMove(page, puzzle.fen, puzzle.line[0].san);
      await sleep(300);
      const after = await page.evaluate<string[]>(pieceSquaresExpr(flipped));
      if (before.join(',') === after.join(',')) {
        throw new Error('G5 走对了但棋盘没变');
      }
      // 对手那手是自动接上的 —— 期望的是**两手之后**的局面
      const expected = occupiedSquares(positionAfterPlayerMove(puzzle, 0));
      const sorted = [...after].sort();
      if (sorted.join(',') !== expected.join(',')) {
        throw new Error(
          `G5 走完之后的局面（${sorted.join(' ')}）跟题库记的（${expected.join(' ')}）对不上`,
        );
      }
    });

    /* ================================================================ */
    /* G6：提示出指引箭头                                            */
    /* ================================================================ */
    await step('G6', '点「提示」，棋盘上出现指引箭头', async () => {
      await page.clickText('button', '提示', '提示按钮');
      await sleep(300);
      const arrows = await page.evaluate<number>(`document.querySelectorAll('.hint-arrow').length`);
      if (arrows < 1) throw new Error('G6 点了提示但棋盘上没有指引箭头');
      await shot(page, 'G6-hint');
    });

    /* ================================================================ */
    /* G7：走完通关 → 「下一关」可点，且真的切到下一关              */
    /* ================================================================ */
    await step('G7', '走完整关显示「通关」，点「下一关」切到下一关', async () => {
      // 重来，从头走完整关
      await page.clickText('button', '重来', '重来按钮');
      await sleep(400);

      let fen = puzzle.fen;
      for (const ply of puzzle.line) {
        // 对手那手是**自动走掉**的（题库里已经写好），所以只有玩家的手才要点
        if (ply.color === puzzle.side) {
          await playMove(page, fen, ply.san);
          await sleep(250);
        }
        // 每一步之后局面都会变 —— 对手那手也算
        fen = ply.fen;
      }

      const done = await page.evaluate<string>(
        `((document.querySelector('.puzzle-status.done') || {}).textContent || '').trim()`,
      );
      if (!done) throw new Error('G7 走完整关却没有出现「通关」');
      await shot(page, 'G7-solved');

      const nextBtn = await page.evaluate<boolean>(
        `!![...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下一关'))`,
      );
      if (!nextBtn) throw new Error('G7 通关了但没有「下一关」按钮');

      // 当前是第几关（列表里的编号）—— 「下一关」应该正好 +1
      const currentNo = await page.evaluate<string>(
        `((document.querySelector('.puzzle-row.active .puzzle-row-no') || {}).textContent || '').trim()`,
      );
      await page.clickText('button', '下一关', '下一关按钮');
      await sleep(500);
      const active = await page.evaluate<string>(
        `((document.querySelector('.puzzle-row.active .puzzle-row-no') || {}).textContent || '').trim()`,
      );
      if (active !== String(Number(currentNo) + 1)) {
        throw new Error(`G7 点「下一关」后当前关是第 ${active} 关，应该是第 ${Number(currentNo) + 1} 关`);
      }
    });

    /* ================================================================ */
    /* G8：没有解释性文字                                            */
    /* ================================================================ */
    await step('G8', '页面上没有解释性文字（界面要自解释）', async () => {
      const texts = await page.evaluate<string[]>(
        `(() => {
          const banned = ['点击', '请选择', '拖动', '鼠标', '右键', '左键', '怎么玩', '玩法', '提示：'];
          const out = [];
          const walk = (root) => {
            for (const el of root.children) {
              const own = [...el.childNodes]
                .filter((n) => n.nodeType === 3)
                .map((n) => (n.textContent || '').trim())
                .join('');
              if (own && banned.some((b) => own.includes(b))) out.push(own);
              if (el.children.length) walk(el);
            }
          };
          walk(document.querySelector('.practice-grid') || document.body);
          return out;
        })()`,
      );
      if (texts.length > 0) {
        throw new Error(`G8 页面上出现了解释性文字：${texts.slice(0, 3).join(' / ')}`);
      }
    });

    /* ================================================================ */
    /* G9：窄屏不横向溢出                                            */
    /* ================================================================ */
    await step('G9', '窄屏（430px）不横向溢出', async () => {
      await page.setViewport(430, 900);
      await sleep(400);
      const overflow = await page.evaluate<number>(
        `Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)`,
      );
      if (overflow > 2) throw new Error(`G9 窄屏横向溢出了 ${overflow}px`);
      await shot(page, 'G9-narrow');
      await page.setViewport(1440, 950);
    });
    /* ================================================================ */
    /* G10：主题分类筛选                                            */
    /* ================================================================ */
    await step('G10', '主题筛选：点某个类别，列表只剩那一类', async () => {
      // 找一个确实有关卡的类别
      const counts = new Map<string, number>();
      for (const p of PUZZLES) counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
      const target = [...counts.entries()].find(([, n]) => n > 0);
      if (!target) throw new Error('G10 题库里没有任何带主题的关卡');
      const [theme, expected] = target;

      // 点筛选栏里那个类别的按钮（靠 data-theme 定位 —— 标题是中文，会改）
      const clicked = await page.evaluate<boolean>(
        `(() => {
          const hit = document.querySelector('.puzzle-filter [data-theme="' + ${JSON.stringify(theme)} + '"]');
          if (!hit) return false;
          hit.click();
          return true;
        })()`,
      );
      if (!clicked) throw new Error(`G10 筛选栏里找不到「${theme}」这个类别`);
      await sleep(400);

      const rows = await page.evaluate<number>(`document.querySelectorAll('.puzzle-row').length`);
      if (rows !== expected) {
        throw new Error(`G10 筛「${theme}」后有 ${rows} 关，应该是 ${expected} 关`);
      }
      // 每一行的主题都必须是被筛的那个
      const allSame = await page.evaluate<boolean>(
        `(() => {
          const names = [...document.querySelectorAll('.puzzle-row-name')].map((e) => (e.textContent || '').trim());
          return names.length > 0 && names.every((n) => n === ${JSON.stringify(themeLabel(theme))});
        })()`,
      );
      if (!allSame) throw new Error(`G10 筛选后列表里混进了别的类别`);

      // 回到「全部」
      await page.evaluate(
        `(() => {
          const chips = [...document.querySelectorAll('.puzzle-filter .lesson-filter-chip')];
          const all = chips.find((c) => (c.childNodes[0]?.textContent || '').trim() === '全部');
          if (all) all.click();
        })()`,
      );
      await sleep(400);
      const restored = await page.evaluate<number>(`document.querySelectorAll('.puzzle-row').length`);
      if (restored !== PUZZLES.length) {
        throw new Error(`G10 点「全部」后只有 ${restored} 关，应该是 ${PUZZLES.length} 关`);
      }
    });

    /* ================================================================ */
    /* G11：对手着法解说出现在右栏                                    */
    /* ================================================================ */
    await step('G11', '对手走完之后，右栏出现「对手怎么走」的解说', async () => {
      // 回到刚才那一关（列表里点它，不是写死第 1 关 —— 选关是按「有错步可测」挑的）
      await page.evaluate(
        `(() => { const el = document.querySelectorAll('.puzzle-row')[${puzzleIndex}]; if (!el) throw new Error('没有关卡行'); el.click(); })()`,
      );
      await sleep(500);

      // 走一步 → 对手那手自动接上 → 右栏出现解说
      await playMove(page, puzzle.fen, puzzle.line[0].san);
      await sleep(500);

      const hasPanel = await page.evaluate<boolean>(`!!document.querySelector('.puzzle-notes')`);
      if (!hasPanel) throw new Error('G11 走完一步后右栏没有出现「对手怎么走」解说面板');

      const text = await page.evaluate<string>(
        `((document.querySelector('.puzzle-notes-text') || {}).textContent || '').trim()`,
      );
      if (!text) throw new Error('G11 解说面板里没有文字');

      const san = await page.evaluate<string>(
        `((document.querySelector('.puzzle-notes-san') || {}).textContent || '').trim()`,
      );
      if (!san) throw new Error('G11 解说里没有显示对手走的那一手');
    });

    /* ================================================================ */
    /* G12：解说里必须有实质内容，不能是空壳                          */
    /* ================================================================ */
    await step('G12', '解说说的是「为什么这么走」，不是空话', async () => {
      /*
       * 解说文本由 `opponentNoteText` 从离线算好的事实拼出来。
       * 这里查的是**事实**本身：题库里每个对手节点都得带 note，
       * 且 note 的字段要自洽（合法着法数 ≥ 1、分值或杀棋距离至少有一个…）。
       */
      const bad = PUZZLES.flatMap((p) =>
        p.line
          .filter((ply) => ply.color !== p.side)
          .map((ply) => ({ id: p.id, san: ply.san, note: ply.note }))
          .filter((x) => {
            if (!x.note) return true;
            if (x.note.legalCount < 1) return true;
            /*
             * 分值与杀棋距离**至少有一个**。
             *
             * 杀棋局面里引擎给的是「几手后被将死」，没有分值（null）——
             * 所以不能一律要求 bestScoreAfter 非空，
             * 但两个都没有就说明什么事实都没算出来。
             */
            if (x.note.bestScoreAfter === null && x.note.bestMateInAfter === null) return true;
            return false;
          }),
      );
      if (bad.length > 0) {
        const first = bad[0];
        throw new Error(
          `G12 有 ${bad.length} 个对手节点没带解说或数据不自洽（例：${first.id} ${first.san}）`,
        );
      }
      // 解说文本本身不能为空
      for (const p of PUZZLES) {
        for (const ply of p.line) {
          if (ply.color === p.side || !ply.note) continue;
          const text = opponentNoteText(ply.note);
          if (!text || text.length < 6) {
            throw new Error(`G12 ${p.id} 的 ${ply.san} 解说文本是空的或太短：「${text ?? ''}」`);
          }
          /*
           * **语义断言**：事实说「不是最优」，解说就不能说「是最优」。
           *
           * 只查「有没有文本」是不够的 —— 把「不是最优」改成「是最优」，
           * 文本照样有、长度照样够，门禁会照样绿。
           * 这条断言就是防这个的。
           */
          if (ply.note.isBest === false && !text.includes('不是最优')) {
            throw new Error(`G12 ${p.id} 的 ${ply.san} 事实是「不是最优」，解说却没说实话：「${text}」`);
          }
          // 事实说「唯一合法着法」，解说就要说明白
          if (ply.note.legalCount === 1 && !text.includes('只有这一着')) {
            throw new Error(`G12 ${p.id} 的 ${ply.san} 是唯一合法着法，解说却没说：「${text}」`);
          }
        }
      }
    });

    /* ================================================================ */
    /* G13：目标那行字跟真实收尾对上                                  */
    /* ================================================================ */
    await step('G13', '目标那行字说清「赢在哪」，不是笼统的「取胜」', async () => {
      /*
       * 背景：目标写着「黑方取胜」，走完却是 `Qg1+ Kf5 Qxg8` ——
       * 白后被吃了、白王好好站着、**根本没将死**，
       * 玩家只会觉得「这关判错了」（用户原话：「为什么这样就胜利了，
       * 也没有将死对面啊」）。
       *
       * 实测 168 关「取胜」里没有一关是将死 ——
       * 所以这行字必须按真实收尾说：赢下对方的后 / 升变取胜 / 把优势变成胜势。
       */
      const shown = await page.evaluate<string>(
        `(() => {
          const rows = [...document.querySelectorAll('.practice-readout')];
          const hit = rows.find((r) => (r.textContent || '').includes('目标'));
          if (!hit) return '';
          return ((hit.querySelector('.practice-readout-value') || {}).textContent || '').trim();
        })()`,
      );
      if (!shown) throw new Error('G13 右栏里找不到「目标」那一行');

      const expected = puzzleGoalText(puzzle);
      if (shown !== expected) {
        throw new Error(`G13 目标写的是「${shown}」，按这一关的真实收尾应该是「${expected}」`);
      }
      // 笼统的「X方取胜」不行 —— 玩家看不出赢在哪
      const side = puzzle.side === 'w' ? '白方' : '黑方';
      if (shown === `${side}取胜`) {
        throw new Error(`G13 目标还是笼统的「${shown}」，玩家看不出这一关赢在哪`);
      }
    });
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.log(`\n❌ 残局关卡门禁：${failures} 条不通过`);
    process.exit(1);
  }
  console.log('\n✅ 残局关卡门禁全部通过');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
