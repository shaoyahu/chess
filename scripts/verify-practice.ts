/**
 * 「教学练习」门禁 —— `scripts/verify-practice.ts`
 *
 * 为什么单独一个脚本：
 *   「教学练习」是一条**独立的机制**（课程演示 + 自己摆棋的沙盒），
 *   跟对局页的走子 / 复盘 / 私信都不是一回事，混进别的脚本会让失败难定位。
 *
 * 门禁清单（7 条，P1~P7）：
 *   P1  大厅有「教学练习」入口，点它真的进 /practice。
 *   P2  教学页：课程列表齐全；点「下一步」**棋盘局面真的变了**（不是只改文字），
 *       并且画出了「上一步」箭头。
 *   P3  「典型摆法」切过去：**棋盘换成摆法局面**（与演示局面不同），
 *       而且**不残留演示线的走子箭头**（箭头指的是另一手棋，画出来就是指错地方）。
 *   P4  自由练习：摆到一半（缺王）点「开始练习」→ **报错且不进练习阶段**。
 *   P5  合法局面 → 开始练习 → **双方都能走**（白走 e4、黑走 e5 都进棋谱）。
 *   P6  页面上**没有解释性文字**（不教用户怎么点 —— 界面要自解释）。
 *   P7  窄屏（430px）**不横向溢出**。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（P1…P7）——
 * 失败信息不带编号就会出现假绿（读的人不知道是哪一条挂的）。
 *
 * 用法：
 *   npx tsx scripts/verify-practice.ts [--url=http://127.0.0.1:3000]
 */
import { Browser, sleep } from './lib/browser';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
const OUT_DIR = join(process.cwd(), 'artifacts', 'practice');

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

/**
 * 棋盘上**有子的格子**（从 DOM 读，不依赖页面暴露状态）。
 *
 * 棋子层是绝对定位的一堆 `.piece`（left / top 是百分比），
 * 不是画在格子里的 —— 所以不能按 `[data-square=xx] .piece` 找，
 * 得把 left / top 换算回格名。
 *
 * 只按**白方视角**（不翻转）换算：门禁里的棋盘都是默认朝向。
 */
const PIECE_SQUARES_EXPR = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('.piece-layer .piece')) {
    const col = Math.round(parseFloat(el.style.left) / 12.5);
    const row = Math.round(parseFloat(el.style.top) / 12.5);
    out.push(String.fromCharCode(97 + col) + (8 - row));
  }
  return out;
})()`;

/** 跑一条门禁：失败只记红，不中断（后面的门禁还要跑） */
async function step(
  id: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${id} ${label}`);
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${id} ${label} —— ${message}`);
  }
}

async function main(): Promise<void> {
  const browser = await Browser.launch({ width: 1440, height: 950 });
  try {
    const page = await browser.newPage();
    await page.setViewport(1440, 950);

    /* ================================================================ */
    /* P1：大厅入口 → /practice                                         */
    /* ================================================================ */
    await step('P1', '大厅有「教学练习」入口，点它进 /practice', async () => {
      await page.navigate(APP_URL);
      await page.waitForExpr(`!!document.querySelector('#username')`, '登录卡片');
      await page.fillInput('#username', '门禁');
      await page.clickText('button', '进入大厅', '进入大厅');
      await page.waitForExpr(`!!document.querySelector('.entry-row')`, '教学练习入口');
      await page.clickText('button', '教学练习', '教学练习入口');
      await page.waitForExpr(`location.pathname === '/practice'`, '跳到 /practice');
      const heading = await page.evaluate<string>(
        `(document.querySelector('.brand-text span') || {}).textContent || ''`,
      );
      if (!heading.includes('教学练习')) {
        throw new Error(`P1 进了 /practice，但顶栏写的是「${heading}」`);
      }
    });

    /* ================================================================ */
    /* P2：课程演示真的在动棋盘                                         */
    /* ================================================================ */
    await step('P2', '「下一步」让棋盘局面真的变化，并画出上一步箭头', async () => {
      await page.waitForExpr(`!!document.querySelector('.board2d')`, '教学页棋盘');
      const lessons = await page.evaluate<number>(
        `document.querySelectorAll('.lesson-row').length`,
      );
      if (lessons < 5) throw new Error(`P2 课程列表只有 ${lessons} 课`);

      const before = await page.evaluate<string[]>(PIECE_SQUARES_EXPR);
      const progressBefore = await page.evaluate<string>(
        `((document.querySelector('.lesson-progress') || {}).textContent || '').trim()`,
      );
      await page.clickText('button', '下一步', '下一步');
      await sleep(400);
      const after = await page.evaluate<string[]>(PIECE_SQUARES_EXPR);
      const progressAfter = await page.evaluate<string>(
        `((document.querySelector('.lesson-progress') || {}).textContent || '').trim()`,
      );
      if (before.includes('e2') === after.includes('e2')) {
        throw new Error(
          `P2 走了一步但 e2 的棋子没动（${before.includes('e2')} → ${after.includes('e2')}）`,
        );
      }
      if (progressBefore === progressAfter) {
        throw new Error(`P2 进度没变（${progressBefore} → ${progressAfter}）`);
      }
      const arrows = await page.evaluate<number>(`document.querySelectorAll('.move-arrow polygon').length`);
      if (arrows < 1) throw new Error('P2 走了一步但没有画「上一步」箭头');
      await shot(page, 'p2-lesson-step');
    });

    /* ================================================================ */
    /* P3：典型摆法换局面 + 不残留演示箭头                              */
    /* ================================================================ */
    await step('P3', '「典型摆法」换成摆法局面，且不残留演示线的箭头', async () => {
      /*
       * 换到**伦敦**那课再测：它的「典型摆法」和演示局面差得开
       * （摆法里 b 马在 d2，演示开局 d2 是白兵）。
       *
       * 判据不能写成「d2 有没有子」—— 那种判据在两个局面下都成立，
       * 也就是**恒真**，等于没守卫（这里的第一版就栽在这）。
       * 正确的判据是：**摆法局面与演示局面必须是两套不同的子位**。
       */
      await page.clickText('button', '伦敦开局', '伦敦开局');
      await sleep(300);
      for (let i = 0; i < 3; i += 1) {
        await page.clickText('button', '下一步', '下一步');
        await sleep(150);
      }
      await sleep(300);
      const demoSquares = await page.evaluate<string[]>(PIECE_SQUARES_EXPR);
      const demoArrows = await page.evaluate<number>(
        `document.querySelectorAll('.move-arrow polygon').length`,
      );
      if (demoArrows < 1) {
        throw new Error('P3 前置条件不成立：演示线走了一步却没有箭头 —— 后面这条判据会恒真');
      }

      await page.clickText('button', '典型摆法', '典型摆法');
      await sleep(500);
      const formationSquares = await page.evaluate<string[]>(PIECE_SQUARES_EXPR);
      const arrows = await page.evaluate<number>(
        `document.querySelectorAll('.move-arrow polygon').length`,
      );
      const same =
        formationSquares.length === demoSquares.length &&
        formationSquares.every((sq, i) => sq === demoSquares[i]);
      if (same) {
        throw new Error(
          'P3 切到「典型摆法」，棋盘上还是演示的局面 —— 摆法根本没显示出来',
        );
      }
      if (arrows > 0) {
        throw new Error('P3 「典型摆法」还留着演示线的走子箭头 —— 箭头指的是另一手棋');
      }
      await shot(page, 'p3-formation');
      await page.clickText('button', '走法演示', '走法演示');
      await sleep(300);
    });

    /* ================================================================ */
    /* P4：缺王时不允许开始练习                                        */
    /* ================================================================ */
    await step('P4', '摆到一半（缺王）点「开始练习」→ 报错且不进练习阶段', async () => {
      await page.clickText('button', '自由练习', '自由练习');
      await sleep(400);
      await page.clickText('button', '清空', '清空');
      await sleep(300);
      await page.clickText('button', '开始练习', '开始练习');
      await sleep(400);
      const error = await page.evaluate<string>(
        `((document.querySelector('.field-error') || {}).textContent || '').trim()`,
      );
      if (!error.includes('王')) {
        throw new Error(`P4 缺王时没有报错（读到「${error}」）`);
      }
      const inPlay = await page.evaluate<boolean>(
        `!!document.querySelector('.notation-list')`,
      );
      if (inPlay) {
        throw new Error('P4 缺王也进了练习阶段 —— 校验形同虚设');
      }
      await shot(page, 'p4-setup-error');
    });

    /* ================================================================ */
    /* P5：合法局面 → 开始练习 → 双方都能走                            */
    /* ================================================================ */
    await step('P5', '开始练习后双方都能走，棋谱如实记录', async () => {
      await page.clickText('button', '初始摆法', '初始摆法');
      await sleep(300);
      await page.clickText('button', '开始练习', '开始练习');
      await page.waitForExpr(`!!document.querySelector('.notation-list')`, '练习阶段');
      await sleep(300);

      // 白方走 e2-e4
      await page.evaluate(`document.querySelector('[data-square="e2"]').click()`);
      await sleep(250);
      await page.evaluate(`document.querySelector('[data-square="e4"]').click()`);
      await sleep(350);
      // 黑方走 e7-e5（自己扮演双方）
      await page.evaluate(`document.querySelector('[data-square="e7"]').click()`);
      await sleep(250);
      await page.evaluate(`document.querySelector('[data-square="e5"]').click()`);
      await sleep(400);

      const notation = await page.evaluate<string>(
        `((document.querySelector('.practice-notation') || {}).textContent || '').replace(/\\s+/g, ' ').trim()`,
      );
      if (!notation.includes('e4') || !notation.includes('e5')) {
        throw new Error(`P5 棋谱里没有双方的着法（读到「${notation}」）`);
      }
      const meta = await page.evaluate<string>(
        `((document.querySelector('.practice-col-left .section-meta') || {}).textContent || '').trim()`,
      );
      if (!meta.includes('2')) {
        throw new Error(`P5 手数不对（读到「${meta}」）`);
      }
      await shot(page, 'p5-free-play');
    });

    /* ================================================================ */
    /* P6：没有解释性文字                                              */
    /* ================================================================ */
    await step('P6', '页面上没有「教你怎么点」的解释性文字', async () => {
      const text = await page.evaluate<string>(
        `(document.querySelector('main') || document.body).innerText`,
      );
      const banned = ['点击', '右键', '拖拽', '拖动棋子', '怎么用', '使用方法', '第一步先'];
      const hits = banned.filter((w) => text.includes(w));
      if (hits.length > 0) {
        throw new Error(`P6 页面上出现了交互说明文字：${hits.join(' / ')}`);
      }
    });

    /* ================================================================ */
    /* P7：窄屏不横向溢出                                              */
    /* ================================================================ */
    await step('P7', '窄屏（430px）不横向溢出', async () => {
      await page.setViewport(430, 900);
      await sleep(600);
      const overflow = await page.evaluate<number>(
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
      );
      if (overflow > 1) {
        throw new Error(`P7 430px 视口横向溢出 ${overflow}px`);
      }
    });

    console.log('');
    if (failures === 0) {
      console.log('✅ 教学练习门禁全部通过（7 条）');
    } else {
      console.log(`❌ 教学练习门禁有 ${failures} 条没过`);
    }
  } finally {
    await browser.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ 门禁脚本自身出错：', err);
  process.exit(1);
});
