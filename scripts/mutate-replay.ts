/**
 * 「复盘 + 终局提示」门禁（`scripts/verify-replay.ts`）的变异测试 ——
 * 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的元素）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   ❌ 行里必须带**门禁编号**（R1~R9）。
 *
 * ## 与其它变异脚本的一处不同
 *
 * 别的脚本是「改源码 → build → 重启那个共享服务 → 跑门禁」；
 * 这一套的门禁**自己起一个隔离的 dev 服务**（见 `scripts/lib/test-server.ts`），
 * 所以这里**不用 build、也不用重启** —— dev 模式按需编译，源码一改，下次请求就是新代码。
 * （顺带避开了「build 会清空用户的生产构建目录」那个坑。）
 *
 * 用法：
 *   npx tsx scripts/mutate-replay.ts [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { REPLAY_GROUPS } from './lib/replay-groups';

const ROOT = process.cwd();

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string | string[];
  /**
   * 原文（必须**整行精确匹配**、且唯一命中）。
   * 给**数组**时表示「一次改多处」。
   */
  from: string | string[];
  /** 改成的文字；数组时与 from 一一对应 */
  to: string | string[];
  /** 预期变红的门禁编号 */
  expect: string;
}

/** 把 from/to 统一成等长数组 */
function pairs(m: Mutation): { from: string; to: string }[] {
  const froms = Array.isArray(m.from) ? m.from : [m.from];
  const tos = Array.isArray(m.to) ? m.to : [m.to];
  if (froms.length !== tos.length) {
    throw new Error(`变异「${m.name}」的 from/to 数量对不上（${froms.length} vs ${tos.length}）`);
  }
  return froms.map((f, i) => ({ from: f, to: tos[i] }));
}

/** 这条变异涉及哪些文件 */
function filesOf(m: Mutation): string[] {
  return Array.isArray(m.file) ? m.file : [m.file];
}

const MUTATIONS: Mutation[] = [
  {
    /*
     * 【一】结果卡退回**文档流**（不再绝对定位）。
     *
     * 这正是需求里点名的那条：「这个将死的提示是突然出现的，
     * 会导致页面中其他元素的位置发生改变」。
     *
     * 卡片在 DOM 里就挂在 `.board-panel` 的**第一个子位**，
     * 绝对定位一去掉，它就掉回文档流、把棋盘**往下顶** ——
     * 和老代码（横幅插在棋盘上面）一模一样的毛病。
     */
    name: '【一】终局结果卡退回文档流（不绝对定位 → 又开始把棋盘顶下去）',
    file: 'src/app/globals.css',
    from: `.result-overlay {
  position: absolute;
  inset: 0;`,
    to: `.result-overlay {
  position: static;
  inset: 0;`,
    expect: 'R1',
  },
  {
    /*
     * 【二】结果卡不再**居中**（掉到棋盘区下沿）。
     *
     * 需求写的是「棋盘**正中**浮一张结果卡」——
     * 位置跑偏了就不是那张卡了。
     */
    name: '【二】终局结果卡不居中（掉到棋盘区下沿，不再是「棋盘正中」）',
    file: 'src/app/globals.css',
    from: `.result-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;`,
    to: `.result-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: end center;`,
    expect: 'R1',
  },
  {
    /*
     * 【三】终局后**不出现**「复盘」按钮。
     *
     * 需求原话：「在一方胜利后双方都出现一个复盘按钮」。
     */
    name: '【三】终局后不出现「复盘」按钮',
    file: 'src/app/room/[code]/page.tsx',
    from: `                {myColor && !isSpectator && roomState.status === 'finished' &&
                  (replayActive ? (`,
    to: `                {myColor && !isSpectator && roomState.status === 'finished' && false &&
                  (replayActive ? (`,
    expect: 'R2',
  },
  {
    /*
     * 【四】点「复盘」**打不开**控制器。
     */
    name: '【四】点「复盘」打不开控制器（点了没反应）',
    file: 'src/hooks/useReplay.ts',
    from: `    setStarted(true);
  }, []);`,
    to: `    // 变异：点了也不打开复盘
  }, []);`,
    expect: 'R3',
  },
  {
    /*
     * 【五】「上一步」**不往回走**（点了没反应）。
     *
     * 这一条守的是「上一步下一步按棋谱重放」——
     * 只做下一步不做上一步，也是坏的。
     */
    name: '【五】「上一步」不往回走（复盘只能往前走）',
    file: 'src/hooks/useReplay.ts',
    from: `    setCursor((c) => Math.max(0, c - 1));`,
    to: `    setCursor((c) => c); // 变异：上一步不生效`,
    expect: 'R4',
  },
  {
    /*
     * 【六】「还原」**不回开局**（点了没反应）。
     *
     * 需求原话：「在正常情况下点击还原按钮会回到下棋最开始」。
     */
    name: '【六】「还原」不回开局（点了没反应）',
    file: 'src/hooks/useReplay.ts',
    from: `    setCursor(0);
  }, [freeFen]);`,
    to: `    // 变异：还原不回开局
  }, [freeFen]);`,
    expect: 'R5',
  },
  {
    /*
     * 【七】自由走棋**只允许走当前走子方**（另一方的子点不动）。
     *
     * 需求原话：「用户还能操控任意方的棋子进行复盘走棋」。
     * 这一条拆的是复盘逻辑里「翻走子方」那一步 ——
     * 少了它，自由走棋就退化成只能走自己那一方，等于半条需求没实现。
     */
    name: '【七】自由走棋只允许走当前走子方（另一方的子点不动）',
    file: 'src/lib/replay.ts',
    from: `  const base = piece.color === fenTurn(fen) ? fen : flipSideToMove(fen);

  const game = new Chess(base);`,
    to: `  // 变异：不翻走子方 → 另一方的子根本走不了
  const base = fen;

  const game = new Chess(base);`,
    expect: 'R6',
  },
  {
    /*
     * 【八】自由走棋之后**不藏**步进键（三个键一直都在）。
     *
     * 需求原话：「自由走棋后隐藏上一步下一步按钮，
     * 只有用户点了还原后才重新出现」。
     */
    name: '【八】自由走棋后不藏步进键（上一步/下一步一直在）',
    file: 'src/app/room/[code]/page.tsx',
    from: `                      {!replayFree && (
                        <>
                          <button
                            className="btn small"
                            onClick={replay.prev}`,
    to: `                      {true && (
                        <>
                          <button
                            className="btn small"
                            onClick={replay.prev}`,
    expect: 'R7',
  },
  {
    /*
     * 【九】自由走棋之后点「还原」**不回到自由走棋之前**（沙盒出不去）。
     *
     * 需求原话：「此时点击还原按钮就是恢复到自由走棋之前的棋盘」。
     */
    name: '【九】沙盒里点「还原」回不去（自由走棋之前那个棋盘找不回来）',
    file: 'src/hooks/useReplay.ts',
    from: `    if (freeFen !== null) {
      setFreeFen(null);
      setFreeStep(null);
      return;
    }`,
    to: `    if (freeFen !== null) {
      // 变异：沙盒里还原什么都不做
      return;
    }`,
    expect: 'R7',
  },
  {
    /*
     * 【十】复盘里的走子**发给服务端**。
     *
     * 复盘是各看各的本地状态 —— 走子一旦发出去，就变成「两个人共享的棋局」，
     * 需求就废了（而且服务端会拒收，棋盘与对局会脱节）。
     */
    name: '【十】复盘里的走子发给服务端（复盘不再是个人的）',
    file: 'src/app/room/[code]/page.tsx',
    from: `      if (replayActive) {
        replay.move(from, to, promotion);
        return;
      }`,
    to: `      if (replayActive) {
        replay.move(from, to, promotion);
        send({ t: 'move', from, to, promotion }); // 变异：复盘里也发服务端
        return;
      }`,
    expect: 'R8',
  },
  {
    /*
     * 【十一】复盘的局面改成取**服务端的共享状态**。
     *
     * 这样两个人的复盘进度就被绑成一样了 ——
     * 需求原话：「两个人都点击了复盘，两个人都能看到自己选择的复盘
     * 和控制自己的复盘进度」。
     */
    name: '【十一】复盘局面取服务端的共享状态（两个人的进度被绑成一样）',
    file: 'src/app/room/[code]/page.tsx',
    from: `  const boardFen = replayActive ? replay.fen : (roomState?.fen ?? '');`,
    to: `  // 变异：复盘局面也用服务端的共享状态
  const boardFen = roomState?.fen ?? '';`,
    expect: 'R9',
  },
  {
    /*
     * 【十二】窄屏下棋盘的高度留白**留太多**（棋盘被挤小）。
     *
     * 窄屏下 HUD 在棋盘**上面**、聊天在下面 —— 棋盘能占的高度是
     * `calc(100vh - 294px)`（CSS 里的 `--board-vh`）。
     * 这条守的就是「多出来的按钮不能把棋盘挤掉」：
     * 留白一旦算多，窄屏上棋盘就剩一条缝。
     *
     * 注意要动 **CSS 里的 `--board-vh`**（棋盘尺寸真正由它决定），
     * 不是页面里的 `STACK_EXTRA_H`（那个只参与「宽屏 / 窄屏」的判定，
     * 改它棋盘尺寸纹丝不动 —— 第一版就改错了，变异白跑一轮）。
     */
    name: '【十二】窄屏棋盘高度留白留太多（棋盘被挤成一条缝）',
    file: 'src/app/globals.css',
    from: `  /* 上下各留一块（HUD 条 + 聊天块）→ 棋盘缩小 */
  --board-vh: calc(100vh - 294px);`,
    to: `  /* 上下各留一块（HUD 条 + 聊天块）→ 棋盘缩小 */
  --board-vh: calc(100vh - 420px); /* 变异：留白留太多 */`,
    expect: 'R10',
  },
  {
    /*
     * 【十三】复盘**赖着不走**（开了新局也不作废）。
     *
     * 这是生产环境人工验收时撞出来的真 bug：
     *   上一盘复盘开着 → 点「再来一局」→ 新一局开始 →
     *   ① 状态行还写着「复盘中」；
     *   ② 棋盘显示的是**复盘的局面**，新一局走了一步**棋盘纹丝不动**。
     *
     * 变异把两处保护一起去掉（复位 effect + `active` 上的 `&& canReplay`）——
     * 只去掉一处是抓不到这个 bug 的（另一处会兜住）。
     */
    name: '【十三】复盘赖着不走（开了新局也不作废，棋盘冻在复盘局面）',
    file: 'src/hooks/useReplay.ts',
    from: `  useEffect(() => {
    if (!canReplay) {
      setStarted(false);
      setFreeFen(null);
      setFreeStep(null);
    }
  }, [canReplay]);

  /**
   * 复盘开着吗。
   *
   * \`&& canReplay\` 是**规则本身**：复盘只在这一局**刚刚结束**的时候成立。
   * 这一局还在下（甚至刚刚重开），就一律不算复盘。
   */
  const active = started && canReplay;`,
    to: `  /** 复盘开着吗（变异：不管这一局结不结束） */
  const active = started;`,
    expect: 'R11',
  },
];

/* ------------------------------------------------------------------ */
/* 互斥锁：同一工作区只允许一份变异脚本在跑                            */
/* ------------------------------------------------------------------ */
const LOCK_FILE = join(ROOT, 'node_modules/.cache/chess-mutate-replay.lock');

function lockHeld(): boolean {
  try {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (lockHeld()) {
    console.error(
      '❌ 同一工作区已经有一份变异脚本在跑（锁文件：' +
        LOCK_FILE +
        '）。并发会互相改写源码 —— 先确认那个进程真的停了再跑。',
    );
    process.exit(1);
  }
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 工作区指纹守卫                                                       */
/* ------------------------------------------------------------------ */
const WORKSPACE_FINGERPRINT = new Map<string, string>();

function fileFingerprint(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

function expectFileAsIs(path: string): void {
  WORKSPACE_FINGERPRINT.set(path, fileFingerprint(path));
}

function snapshotWorkspace(): void {
  WORKSPACE_FINGERPRINT.clear();
  for (const m of MUTATIONS) {
    for (const f of filesOf(m)) {
      const p = join(ROOT, f);
      WORKSPACE_FINGERPRINT.set(p, fileFingerprint(p));
    }
  }
}

function assertWorkspaceUnchanged(): void {
  const changed: string[] = [];
  for (const [p, fp] of WORKSPACE_FINGERPRINT) {
    if (fileFingerprint(p) !== fp) changed.push(p.replace(`${ROOT}/`, ''));
  }
  if (changed.length > 0) {
    throw new Error(
      '工作区在变异期间被别人改过：' +
        changed.join('、') +
        '（本轮结论不可信，且继续跑会把人家的改动还原掉）—— 先停手，确认改动归属后再跑。',
    );
  }
}

/* --dry：只检查目标串命中次数，不真的改文件 */
const DRY = process.argv.includes('--dry');
const FILTER = process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

/** 本条变异要跑哪几组门禁 */
function groupsFor(m: Mutation): string[] {
  const gs = groupsOfGate(REPLAY_GROUPS, m.expect);
  if (gs.length === 0) {
    throw new Error(
      `变异「${m.name}」期望的「${m.expect}」不属于任何门禁组 —— ` +
        `它没法被分组跑，也就没法保证这条变异一定抓得到。`,
    );
  }
  return gs;
}

/** 从门禁输出里抽出「实际变红了哪些门禁」（❌ 行开头就是门禁编号）。 */
function extractRedGateIds(out: string): string[] {
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.includes('❌')) continue;
    const m = line.match(/❌\s*([A-Z]{1,2}\d+[a-z]?)\b/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

/** 门禁编号 → 哪条变异把它打红了（跑完出覆盖报告） */
const redByGate = new Map<string, string[]>();

if (DRY) {
  let bad = 0;
  for (const m of RUN) {
    const files = filesOf(m);
    const edits = pairs(m);
    files.forEach((f, i) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const hits = src.split(edits[i].from).length - 1;
      if (hits !== 1) {
        bad += 1;
        console.error(`❌ 变异「${m.name}」的目标串在 ${f} 里命中 ${hits} 次（必须恰好 1 次）`);
      }
    });
  }
  console.log(`\n${DRY ? '（dry-run，未改任何文件）' : ''} 共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

/* 组覆盖硬自检：「按组强制」这条规矩的执行点 —— 每个组至少一条变异守着 */
const coverageProblems = checkGroupCoverage(
  REPLAY_GROUPS,
  MUTATIONS.map((m) => ({ id: m.name, expect: m.expect })),
  new Map(MUTATIONS.map((m) => [m.name, groupsFor(m)] as [string, string[]])),
);
if (coverageProblems.length > 0) {
  console.error('\n❌ 组覆盖自检不通过：');
  for (const p of coverageProblems) console.error(`   · ${p}`);
  process.exit(1);
}

acquireLock();
process.on('exit', releaseLock);
snapshotWorkspace();

let caught = 0;
for (const m of RUN) {
  const files = filesOf(m);
  const edits = pairs(m);
  if (files.length !== edits.length) {
    console.error(`❌ 变异「${m.name}」的文件数与编辑数对不上（${files.length} vs ${edits.length}）`);
    process.exit(1);
  }
  const originals = files.map((f) => readFileSync(join(ROOT, f), 'utf8'));
  files.forEach((f, i) => {
    const hits = originals[i].split(edits[i].from).length - 1;
    if (hits !== 1) {
      console.error(`❌ 变异「${m.name}」的目标串在 ${f} 里命中 ${hits} 次（必须恰好 1 次）`);
      process.exit(1);
    }
  });
  const groups = groupsFor(m);
  console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红，跑 ${groups.join('、')} 组）`);
  assertWorkspaceUnchanged();
  try {
    files.forEach((f, i) => {
      const mutated = originals[i].replace(edits[i].from, edits[i].to);
      if (mutated === originals[i]) {
        console.error(`❌ 变异「${m.name}」改完之后 ${f} 没变（空变异）`);
        process.exit(1);
      }
      writeFileSync(join(ROOT, f), mutated);
      expectFileAsIs(join(ROOT, f));
    });

    const r = spawnSync('npx', ['tsx', 'scripts/verify-replay.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const redGates = extractRedGateIds(out);
    for (const g of redGates) {
      if (!redByGate.has(g)) redByGate.set(g, []);
      redByGate.get(g)!.push(m.name);
    }
    const gateRed = redGates.includes(m.expect);
    const nonzero = r.status !== 0;
    if (gateRed && nonzero) {
      caught += 1;
      console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.status}`);
    } else {
      console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.status} redGates=${redGates.join(',')}`);
      console.error(out.slice(-3000));
    }
  } finally {
    files.forEach((f, i) => {
      writeFileSync(join(ROOT, f), originals[i]);
      expectFileAsIs(join(ROOT, f));
    });
  }
}

/* ------------------------------------------------------------------ */
/* 覆盖报告                                                            */
/* ------------------------------------------------------------------ */
console.log(`\n📋 门禁覆盖报告`);
for (const group of Object.keys(REPLAY_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of REPLAY_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(`  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`);
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

const neverRed = allGateIds(REPLAY_GROUPS).filter((id) => !redByGate.has(id));
if (neverRed.length > 0) {
  console.log(`\n⚠️ 这些门禁本轮一次都没被打红：${neverRed.join('、')}`);
  console.log('   （可能是判据恒真 —— 那条门禁抓不到任何东西，等于摆设）');
}

console.log(`\n合计 ${RUN.length} 条变异，抓到 ${caught} 条。`);
process.exit(caught === RUN.length ? 0 : 1);
