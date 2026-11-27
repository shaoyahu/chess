/**
 * 变异测试 —— 确认「残局关卡」这条新机制的门禁真的能抓到回退。
 *
 * 变异分两组，对应两套守卫：
 *   **浏览器门禁**（scripts/verify-endgame-puzzles.ts，G1~G12）
 *     M1 走错了也推进局面      → G4 必须红
 *     M2 提示不出指引箭头      → G6 必须红
 *     M3 通关后不显示「下一关」→ G7 必须红
 *     M4 关卡列表只渲染 5 关   → G2 必须红
 *     M5 走对了也不推进局面    → G5 必须红
 *     M10 主题筛选不生效       → G10 必须红
 *     M11 不显示对手解说       → G11 必须红
 *     M12 解说内容是空壳       → G12 必须红
 *   **单元测试**（tests/puzzles.test.ts）
 *     M6 只认一着（忽略等价正解）→ 「等价正解算走对」必须红
 *     M7 目标判定恒真          → 「目标没达成时不能算通关」必须红
 *     M8 走错了不记错的着法    → G4 必须红
 *     M9 走对之后不判定通关    → G7 必须红
 *     M13 解说恒真（无论事实都返回一句话）→ G12 必须红
 *     M14 「已败」阈值符号翻转  → 「已败」的判定规则必须红
 *
 * 为什么要做：
 *   守卫脚本自己也可能写错（比如断言写歪、跳过条件太宽），
 *   那它就会变成一个「永远绿」的假警报。所以每条修复都要**改回 bug**，
 *   确认门禁真的会变红 —— 用进程退出码 + 门禁编号判定，不 grep 别的文本。
 *
 * 浏览器那几条会**自己起一个隔离的 dev 服务**（构建目录、存档目录、端口都隔离，
 *   见 scripts/lib/test-server.ts 的说明），不碰用户自己跑着的服务。
 *
 * 用法：npm run mutate:endgame-puzzles
 */
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TestServer } from './lib/test-server';

const PAGE = resolve(process.cwd(), 'src/app/practice/page.tsx');
const SESSION = resolve(process.cwd(), 'src/lib/practice/puzzles/session.ts');
const NOTES = resolve(process.cwd(), 'src/lib/practice/puzzles/notes.ts');
const TYPES = resolve(process.cwd(), 'src/lib/practice/puzzles/types.ts');
const PAGE_BACKUP = resolve(process.cwd(), '.puzzle-mutation-page.tsx');
const SESSION_BACKUP = resolve(process.cwd(), '.puzzle-mutation-session.ts');
const NOTES_BACKUP = resolve(process.cwd(), '.puzzle-mutation-notes.ts');
const TYPES_BACKUP = resolve(process.cwd(), '.puzzle-mutation-types.ts');

type Guard = 'browser' | 'unit';

interface Mutation {
  name: string;
  file: typeof PAGE;
  expect: string;
  guard: Guard;
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 走错了也推进局面（applyPlayerMove 把 ply 加一）',
    file: SESSION,
    expect: 'G4',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'return { session: { ...session, lastWrong: san }, ok: false };',
        'return { session: { ...session, ply: session.ply + 1, lastWrong: san }, ok: false };',
      ),
  },
  {
    name: 'M2 提示不出指引箭头',
    file: PAGE,
    expect: 'G6',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'setHintMove({ from: step.from, to: step.to });',
        'setHintMove(null);',
      ),
  },
  {
    name: 'M3 通关后不显示「下一关」',
    file: PAGE,
    expect: 'G7',
    guard: 'browser',
    apply: (src) => src.replace('{session.solved && (\n                      <button className="btn primary" onClick={nextPuzzle}', '{false && (\n                      <button className="btn primary" onClick={nextPuzzle}'),
  },
  {
    name: 'M4 关卡列表只渲染 5 关',
    file: PAGE,
    expect: 'G2',
    guard: 'browser',
    apply: (src) => src.replace('{visiblePuzzles.map((item) => {', '{visiblePuzzles.slice(0, 5).map((item) => {'),
  },
  {
    name: 'M5 走对了也不推进局面',
    file: SESSION,
    expect: 'G5',
    guard: 'browser',
    apply: (src) => src.replace('let ply = session.ply + 1;', 'let ply = session.ply;'),
  },
  {
    name: 'M6 只认一着（忽略等价正解 also）',
    file: SESSION,
    expect: '等价正解',
    guard: 'unit',
    apply: (src) => src.replace('return (step.also ?? []).includes(san);', 'return false;'),
  },
  {
    name: 'M7 目标判定恒真（终局没达成也说达成了）',
    file: SESSION,
    expect: '目标没达成时不能算通关',
    guard: 'unit',
    apply: (src) => src.replace('return game.isCheckmate();', 'return true;'),
  },
  {
    name: 'M8 走错了不记错的着法（页面上不显示「这一步不对」）',
    file: SESSION,
    expect: 'G4',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'return { session: { ...session, lastWrong: san }, ok: false };',
        'return { session: { ...session }, ok: false };',
      ),
  },
  {
    name: 'M9 走对之后不判定通关（solved 永远是 false）',
    file: SESSION,
    expect: 'G7',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'session: { ...nextSession, solved: isSolved(nextSession) },',
        'session: { ...nextSession, solved: session.solved },',
      ),
  },
  {
    name: 'M10 主题筛选不生效（点了也不筛）',
    file: PAGE,
    expect: 'G10',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        '() => (puzzleTheme ? PUZZLES.filter((p) => p.theme === puzzleTheme) : PUZZLES),',
        '() => PUZZLES,',
      ),
  },
  {
    name: 'M11 不显示对手解说面板',
    file: PAGE,
    expect: 'G11',
    guard: 'browser',
    apply: (src) =>
      src.replace('{opponentNotes.length > 0 && (', '{false && opponentNotes.length > 0 && ('),
  },
  {
    name: 'M12 解说文本恒定（不管事实都返回同一句）',
    file: NOTES,
    expect: 'G12',
    guard: 'browser',
    apply: (src) =>
      src.replace('export function opponentNoteText(note: PuzzleOpponentNote): string | null {',
        'export function opponentNoteText(note: PuzzleOpponentNote): string | null {\n  return "固定的一句话";'),
  },
  {
    name: 'M13 解说恒真（永远说「最优」，掩盖非最优）',
    file: NOTES,
    expect: 'G12',
    guard: 'browser',
    apply: (src) =>
      src.replace("parts.push('这一手不是最优');", "parts.push('这一手是最优');"),
  },
  {
    /*
     * 这条变异是**真实踩过的坑**：
     * 判据写成 `score <= -阈值`（阈值本身是负数），取反后变成 `score <= +阈值`
     * —— 于是几乎每个局面都被判成「对手已经输定了」。
     *
     * 单测必须能抓住它：判据本身有独立断言，且数据里的标志要与判据对得上。
     */
    name: 'M14 「已败」阈值符号翻转（-500 写成 500）',
    file: TYPES,
    expect: '「已败」的判定规则',
    guard: 'unit',
    apply: (src) =>
      src.replace('export const HOPELESS_SCORE_CP = -500;', 'export const HOPELESS_SCORE_CP = 500;'),
  },
];

interface RunResult {
  code: number;
  out: string;
}

function runUnitGuard(): RunResult {
  const r = spawnSync('npx', ['vitest', 'run', 'tests/puzzles.test.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function runBrowserGuard(url: string): Promise<RunResult> {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-endgame-puzzles.ts', `--url=${url}`], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 300000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 守卫输出里有没有「我们期望的那条编号」 */
function hasFlag(out: string, expect: string): boolean {
  return out.split('\n').some((l) => l.includes(expect));
}

/**
 * 还原被变异的文件。
 *
 * 单独抽出来，是因为**中断**（Ctrl-C / 被 kill）时 `finally` 也可能来不及跑 ——
 * 那时仓库里会**留下变异态的生产代码**（实测踩过：
 * 中断之后单测直接挂了 4 条，排查才发现文件是变异的）。
 * 所以信号处理里也要还原。
 */
function restoreAll(originals: Map<string, string>): void {
  copyFileSync(PAGE_BACKUP, PAGE);
  copyFileSync(SESSION_BACKUP, SESSION);
  copyFileSync(NOTES_BACKUP, NOTES);
  copyFileSync(TYPES_BACKUP, TYPES);
  rmSync(PAGE_BACKUP, { force: true });
  rmSync(SESSION_BACKUP, { force: true });
  rmSync(NOTES_BACKUP, { force: true });
  rmSync(TYPES_BACKUP, { force: true });
  for (const [file, content] of originals) {
    if (readFileSync(file, 'utf-8') !== content) {
      console.error(`\n❌ 还原失败：${file} 与原始内容不一致，请检查！`);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const originals = new Map<string, string>([
    [PAGE, readFileSync(PAGE, 'utf-8')],
    [SESSION, readFileSync(SESSION, 'utf-8')],
    [NOTES, readFileSync(NOTES, 'utf-8')],
    [TYPES, readFileSync(TYPES, 'utf-8')],
  ]);
  copyFileSync(PAGE, PAGE_BACKUP);
  copyFileSync(SESSION, SESSION_BACKUP);
  copyFileSync(NOTES, NOTES_BACKUP);
  copyFileSync(TYPES, TYPES_BACKUP);

  // 被中断时也要还原 —— 否则仓库里留下的是**变异态的生产代码**
  const onSignal = (sig: string) => {
    console.log(`\n（收到 ${sig}，还原被变异的文件）`);
    restoreAll(originals);
    process.exit(1);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  console.log('变异测试：残局关卡（page.tsx / puzzles/session.ts）\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  try {
    // 基线：单元测试
    const baseUnit = runUnitGuard();
    if (baseUnit.code !== 0) {
      console.error('\n❌ 基线单元测试就不通过，先把改动本身修好再谈变异。');
      process.exit(1);
    }

    for (const m of MUTATIONS) {
      const original = originals.get(m.file) as string;
      const mutated = m.apply(original);
      if (mutated === original) {
        console.log(`\n❌ ${m.name}\n   ⚠️  变异没有生效（没匹配到目标字符串）—— 守卫可能是假绿`);
        missed += 1;
        continue;
      }
      writeFileSync(m.file, mutated, 'utf-8');

      let result: RunResult;
      if (m.guard === 'unit') {
        result = runUnitGuard();
      } else {
        // 浏览器门禁：起一个隔离的 dev 服务，跑完自己关掉
        const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-puzzle-mutate-'));
        const server = await TestServer.start(dataDir);
        try {
          await server.warmUp('/practice');
          result = await runBrowserGuard(server.url);
        } finally {
          await server.stop();
          rmSync(dataDir, { recursive: true, force: true });
        }
      }

      if (result.code !== 0 && hasFlag(result.out, m.expect)) {
        caught += 1;
        // 打印**全部**失败行：只看自己那条会漏掉「门禁是因为别的原因挂的」
        const failed = result.out
          .split('\n')
          .filter((l) => l.includes('❌') || l.includes('×') || l.includes('FAIL'))
          .slice(0, 6);
        console.log(`\n✅ 抓到了  ${m.name}  [退出码 ${result.code}]`);
        for (const l of failed) console.log(`              ${l.trim()}`);
      } else {
        missed += 1;
        console.log(
          `\n❌ 没抓到  ${m.name}  [退出码 ${result.code}｜期望「${m.expect}」未出现] —— 守卫是假绿`,
        );
      }
      // 还原这一处，下一个变异从干净状态开始
      writeFileSync(m.file, original, 'utf-8');
    }
  } finally {
    // 无论成败都必须还原，并核对还原后与原始内容逐字节一致
    restoreAll(originals);
  }

  console.log(
    `\n结果：${missed === 0 ? '✅' : '❌'} ${caught}/${MUTATIONS.length} 个变异全部被抓到，守卫有效`,
  );
  if (missed > 0) process.exit(1);
}

main();
