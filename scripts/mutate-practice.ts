/**
 * 变异测试 —— 确认「教学多线路」这条新机制的门禁真的能抓到回退。
 *
 * 变异分两组，对应两套守卫：
 *   **浏览器门禁**（scripts/verify-practice.ts，P1~P12）
 *     M1 分类筛选不过滤        → P4 必须红
 *     M2 切线路不换局面        → P5 必须红
 *     M3 筛选 chip 的数字写死  → P4 必须红
 *     M6「上一步」不动          → P10 必须红
 *     M7 落新的一手不截断      → P11 必须红
 *     M8 练习页退回窄容器      → P12 必须红
 *     M9 棋谱不标当前手        → P10 必须红
 *   **单元测试**（tests/practice.test.ts）
 *     M4 resolveLine 忽略 lineId → 「切线路会换掉整套演示线」必须红
 *     M5 lessonLines 只回主线    → 「应对课至少两条线路」必须红
 *
 * 为什么要做：
 *   守卫脚本自己也可能写错（比如断言写歪、跳过条件太宽），
 *   那它就会变成一个"永远绿"的假警报。所以每条修复都要**改回 bug**，
 *   确认门禁真的会变红 —— 用进程退出码 + 门禁编号判定，不 grep 别的文本。
 *
 * 浏览器那三条会**自己起一个隔离的 dev 服务**（构建目录、存档目录、端口都隔离，
 *   见 scripts/lib/test-server.ts 的说明），不碰用户自己跑着的服务。
 *
 * 用法：npm run mutate:lessons-ui
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TestServer } from './lib/test-server';

const PAGE = resolve(process.cwd(), 'src/app/practice/page.tsx');
const TYPES = resolve(process.cwd(), 'src/lib/practice/lessons/types.ts');
const PAGE_BACKUP = resolve(process.cwd(), '.practice-mutation-page.tsx');
const TYPES_BACKUP = resolve(process.cwd(), '.practice-mutation-types.ts');

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
    name: 'M1 分类筛选不过滤（visibleLessons 永远返回全部课程）',
    file: PAGE,
    expect: 'P4',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        '() => (tagFilter ? LESSONS.filter((l) => l.tag === tagFilter) : LESSONS),',
        '() => LESSONS,',
      ),
  },
  {
    name: 'M2 切线路不换局面（setLineId 永远清空）',
    file: PAGE,
    expect: 'P5',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'setLineId(line.id === activeLine.id ? null : line.id);',
        'setLineId(null);',
      ),
  },
  {
    name: 'M3 筛选 chip 上的课数写死（永远显示总数）',
    file: PAGE,
    expect: 'P4',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        '<span className="lesson-filter-count">{tagCounts.get(tag) ?? 0}</span>',
        '<span className="lesson-filter-count">{LESSONS.length}</span>',
      ),
  },
  {
    name: 'M4 resolveLine 忽略 lineId（切线永远回主线）',
    file: TYPES,
    expect: '切线路会换掉整套演示线',
    guard: 'unit',
    apply: (src) =>
      src.replace(
        '    const found = lesson.lines?.find((line) => line.id === lineId);\n    if (found) return found;',
        '    const found = lesson.lines?.find((line) => line.id === lineId);\n    if (found) { /* 变异：故意忽略 lineId */ }',
      ),
  },
  {
    name: 'M5 lessonLines 只回主线（备用线被吞光）',
    file: TYPES,
    expect: '「应对」课至少两条线路',
    guard: 'unit',
    apply: (src) =>
      src.replace(
        'return [resolveLine(lesson, null), ...(lesson.lines ?? [])];',
        'return [resolveLine(lesson, null)];',
      ),
  },
  {
    /*
     * 自由练习的「上一步」按下去**不动**（游标不变）——
     * 棋盘不退回上一手 → P10 必须红。
     */
    name: 'M6「上一步」不动（游标原地踏步）',
    file: PAGE,
    expect: 'P10',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        'onClick={() => setPracticeCursor((c) => Math.max(0, c - 1))}',
        'onClick={() => { /* 变异：上一步不动 */ }}',
      ),
  },
  {
    /*
     * 在中间位置落新的一手**不截断**后面的旧着法 ——
     * 换了一条线却把旧棋谱留着 → P11 必须红。
     */
    name: 'M7 落新的一手不截断后面的旧着法',
    file: PAGE,
    expect: 'P11',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        `        pushStep(prev, practiceCursor, {
          san: result.step.san,
          color: result.step.color,
          from,
          to,
          fen: result.fen,
        }),`,
        `        [...prev, {
          san: result.step.san,
          color: result.step.color,
          from,
          to,
          fen: result.fen,
        }],`,
      ),
  },
  {
    /*
     * 练习页退回**窄容器**（和对局页不一样）→ 棋盘又挤成一小块 →
     * P12 必须红（用户 2026-11-20 报的就是这个）。
     */
    name: 'M8 练习页退回窄容器（棋盘又被挤小）',
    file: PAGE,
    expect: 'P12',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        '<main className="container wide" style={{ paddingBottom: 40, flex: 1 }}>',
        '<main className="container" style={{ paddingBottom: 40, flex: 1 }}>',
      ),
  },
  {
    /*
     * 棋谱里**不标当前手** —— 退回去之后不知道自己在看哪儿 → P10 必须红。
     */
    name: 'M9 棋谱不标当前手（退回去看不出位置）',
    file: PAGE,
    expect: 'P10',
    guard: 'browser',
    apply: (src) =>
      src.replace(
        `                        <span
                          className={\`san\${row.white ? '' : ' empty'}\${
                            row.whiteIdx === practiceCursor - 1 ? ' current' : ''
                          }\`}
                        >`,
        `                        <span
                          className={\`san\${row.white ? '' : ' empty'}\`}
                        >`,
      ),
  },
];

interface RunResult {
  code: number;
  out: string;
}

function runUnitGuard(): RunResult {
  const r = spawnSync('npx', ['vitest', 'run', 'tests/practice.test.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function runBrowserGuard(url: string): Promise<RunResult> {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-practice.ts', `--url=${url}`], {
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

async function main(): Promise<void> {
  const originals = new Map<string, string>([
    [PAGE, readFileSync(PAGE, 'utf-8')],
    [TYPES, readFileSync(TYPES, 'utf-8')],
  ]);
  copyFileSync(PAGE, PAGE_BACKUP);
  copyFileSync(TYPES, TYPES_BACKUP);

  console.log('变异测试：教学多线路（page.tsx / lessons/types.ts）\n');
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
        const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-practice-mutate-'));
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
          .filter((l) => l.includes('❌') || l.includes('×'))
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
    copyFileSync(PAGE_BACKUP, PAGE);
    copyFileSync(TYPES_BACKUP, TYPES);
    rmSync(PAGE_BACKUP, { force: true });
    rmSync(TYPES_BACKUP, { force: true });
    for (const [file, content] of originals) {
      if (readFileSync(file, 'utf-8') !== content) {
        console.error(`\n❌ 还原失败：${file} 与原始内容不一致，请检查！`);
        process.exit(1);
      }
    }
  }

  console.log(
    `\n结果：${missed === 0 ? '✅' : '❌'} ${caught}/${MUTATIONS.length} 个变异全部被抓到，守卫有效`,
  );
  if (missed > 0) process.exit(1);
}

main();
