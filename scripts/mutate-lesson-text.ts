/**
 * 变异测试 —— 确认教学文案门禁（scripts/verify-lesson-text.ts）真能抓到回退。
 *
 * 为什么要做：
 *   守卫脚本自己也可能写错（比如正则漏了某种说法、跳过规则太宽），
 *   那它就会变成一个"永远绿"的假警报。所以每条规则都要**改回 bug**，
 *   确认门禁真的会变红 —— 用进程退出码 + 报错编号判定，不 grep 别的文本。
 *
 * 用法：npm run mutate:lessons
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET = resolve(process.cwd(), 'src/lib/practice/lessons/counters-c.ts');
const BACKUP = resolve(process.cwd(), '.lesson-text-mutation-backup.ts');

interface Mutation {
  name: string;
  /** 期望被抓到的检查编号（L1 / L2 / L3 / L4） */
  expect: string;
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 要点谎报子力：把「不吃亏」改成「白方多一个兵」（实际双方平兵）',
    expect: 'L1',
    apply: (src) => src.replace('\'性格：不吃亏、少事。', '\'性格：白方多一个兵、少事。'),
  },
  {
    name: 'M2 要点被删到 2 条（低于下限 3 条）',
    expect: 'L2',
    apply: (src) =>
      src
        .replace(
          '          \'卡帕布兰卡的关键是 c5 冲兵之后 cxd4：黑方用 c 线换 d 线，白方用 Nxd4 收兵 —— 一兵换一兵，换完之后局面干净，子力一分不差。\',\n',
          '',
        )
        .replace(
          '          \'白方那步 Nxd4 是把马放在最该在的位置：它站在 d4，既护着 c6、e6 两路，又盯着黑方的 c5、e6。\',\n',
          '',
        ),
  },
  {
    name: 'M3 讲解占位：相邻两步的 note 写成同一句',
    expect: 'L3',
    apply: (src) =>
      src.replace(
        '{ san: \'Nc6\', note: \'黑方 b8 马出到 c6 —— 马直接顶住白方 d4 的马，黑方要先把 d4 这块中心抢回来。\' },',
        '{ san: \'Nc6\', note: \'白方 f3 马吃回 d4 —— 白方用马收下黑方 c 线冲过来的兵，一兵换一兵，谁也没多谁也没少。\' },',
      ),
  },
  {
    name: 'M4 多线路课的主线改叫「主线」',
    expect: 'L4',
    apply: (src) => src.replace("    mainLabel: '东方体系',", "    mainLabel: '主线',"),
  },
];

function runGuard(): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-lesson-text.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): void {
  const original = readFileSync(TARGET, 'utf-8');
  copyFileSync(TARGET, BACKUP);

  console.log('变异测试：src/lib/practice/lessons/counters-c.ts × scripts/verify-lesson-text.ts\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  try {
    const base = runGuard();
    if (base.code !== 0) {
      console.error('\n❌ 基线就不通过，先把改动本身修好再谈变异。');
      console.error(base.out.split('\n').filter((l) => l.includes('❌')).join('\n'));
      process.exit(1);
    }

    for (const m of MUTATIONS) {
      const mutated = m.apply(original);
      if (mutated === original) {
        console.log(`\n❌ ${m.name}\n   ⚠️  变异没有生效（没匹配到目标字符串）—— 守卫可能是假绿`);
        missed += 1;
        continue;
      }
      writeFileSync(TARGET, mutated, 'utf-8');
      const { code, out } = runGuard();
      const flagged = out.split('\n').some((l) => l.includes(`❌ ${m.expect}`));
      if (code !== 0 && flagged) {
        caught += 1;
        const line = out
          .split('\n')
          .filter((l) => l.includes(`❌ ${m.expect}`))
          .slice(0, 2)
          .join('\n              ');
        console.log(`\n✅ 抓到了  ${m.name}  [退出码 ${code}]`);
        if (line) console.log(`              ${line.trim()}`);
      } else {
        missed += 1;
        console.log(
          `\n❌ 没抓到  ${m.name}  [退出码 ${code}｜${m.expect} 未出现] —— 守卫是假绿`,
        );
      }
    }
  } finally {
    // 无论成败都必须还原，并核对还原后与原始内容逐字节一致
    copyFileSync(BACKUP, TARGET);
    rmSync(BACKUP, { force: true });
    const restored = readFileSync(TARGET, 'utf-8');
    if (restored !== original) {
      console.error('\n❌ 还原失败：counters-c.ts 与原始内容不一致，请检查！');
      process.exit(1);
    }
  }

  const base = runGuard();
  if (base.code !== 0) {
    console.error('\n❌ 还原后基线就不通过，说明改动本身有问题。');
    process.exit(1);
  }

  console.log(
    `\n结果：${missed === 0 ? '✅' : '❌'} ${caught}/${MUTATIONS.length} 个变异全部被抓到，守卫有效`,
  );
  if (missed > 0) process.exit(1);
}

main();
