/**
 * 变异测试 —— 确认引擎战术门禁（scripts/verify-engine-tactics.ts）真能抓到回退。
 *
 * 为什么要做：
 * 守卫脚本自己也可能写错（比如阈值写太松、局面选错、断言写反），
 * 那它就会变成一个「永远绿」的假警报。所以每条修复都要**改回 bug**，
 * 确认门禁真的会变红 —— 用进程退出码判定，不 grep 输出文本。
 *
 * 用法：npm run mutate:engine
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC_PATH = resolve(process.cwd(), 'src/lib/engine/search.ts');
const BACKUP = resolve(process.cwd(), '.engine-mutation-backup.ts');

interface Mutation {
  name: string;
  /** 把文件内容改回 bug 的方式 */
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    // PVS 试探后漏了「重搜精确分」：根节点拿到的全是界，排序完全失真
    name: 'M1 删掉 PVS 空窗试探后的重搜（分值变回界值）',
    apply: (src) =>
      src.replace(
        /          if \(score > alpha\) \{\n[\s\S]*?\n          \}\n/,
        '',
      ),
  },
  {
    // 迭代加深结束后才定 best（时间预算已耗尽 → best 落回 rootMoves[0]）
    name: 'M2 bestMove 改回「第一层搜完不赋值、最后才取 rootMoves[0]」',
    apply: (src) =>
      src.replace(
        '        bestMove = localBest;\n        bestScore = localScore;\n',
        '',
      ),
  },
  {
    // quiescence 返回窗口边界而不是本节点真值
    name: 'M3 quiescence 结尾改回 return alpha（返回窗口边界）',
    apply: (src) =>
      src.replace(
        '  // 返回本节点自己的分值（不是继承来的 alpha）\n  return value;',
        '  // 返回本节点自己的分值（不是继承来的 alpha）\n  return alpha;',
      ),
  },
  {
    // quiescence 里剪枝的界被写进本节点 value（把上界当事实）
    name: 'M4 quiescence 把剪枝返回的界写进 value（本该直接上抛，却当成本节点分值继续搜）',
    apply: (src) =>
      src.replace(
        '    if (score >= beta) return score;\n    if (score > value) value = score;',
        '    if (score >= beta) {\n      value = score;\n      continue;\n    }\n    if (score > value) value = score;',
      ),
  },
  {
    // 精确根分选项失效：easy 档拿到的又是界值
    name: 'M5 exactRootScores 选项失效（永远走 PVS）',
    apply: (src) => src.replace('const exactRoot = opts.exactRootScores === true;', 'const exactRoot = false;'),
  },
  {
    // 吃子生成漏掉马步的某个方向（模拟 capturesOnly 分支残缺）
    name: 'M6 吃子生成里马走法漏掉「向小的 file 方向」（d5b4 之类吃不到）',
    apply: (src) =>
      src.replace(
        'const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];',
        'const KNIGHT_OFFSETS = [-33, -31, -14, 14, 18, 31, 33];',
      ),
  },
];

function runGuard(): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-engine-tactics.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 判断这次变异是否**真的生效**（文件确实变了） */
function changed(before: string, after: string): boolean {
  return before !== after;
}

function main(): void {
  const original = readFileSync(SRC_PATH, 'utf-8');
  copyFileSync(SRC_PATH, BACKUP);

  console.log('变异测试：src/lib/engine/search.ts × scripts/verify-engine-tactics.ts\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  // 可选参数：只跑名字里包含该片段的变异（调一条时不用重跑全部）
  const filter = process.argv[2];
  const targets = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
  if (targets.length === 0) {
    console.log(`❌ 没有名字包含「${filter}」的变异`);
    process.exit(1);
  }

  try {
    // 基线：未变异必须全绿，否则谈不上「变异能被抓到」
    writeFileSync(SRC_PATH, original, 'utf-8');
    const base = runGuard();
    if (base.code !== 0) {
      console.log('\n❌ 基线门禁就是红的 —— 先修好门禁再做变异测试');
      console.log(base.out);
      process.exit(1);
    }
    console.log('基线通过 ✅\n');

    for (const m of targets) {
      const mutated = m.apply(original);
      if (!changed(original, mutated)) {
        console.log(`\n❌ ${m.name}\n   ⚠️  变异没有生效（没匹配到目标字符串）—— 守卫可能是假绿`);
        missed += 1;
        continue;
      }
      writeFileSync(SRC_PATH, mutated, 'utf-8');
      const { code, out } = runGuard();
      if (code !== 0) {
        caught += 1;
        const line = out
          .split('\n')
          .filter((l) => l.includes('❌'))
          .slice(0, 3)
          .join('\n');
        console.log(`✅ ${m.name}\n   门禁变红 ✅\n${line}`);
      } else {
        missed += 1;
        console.log(`\n❌ ${m.name}\n   ⚠️  门禁仍然全绿 —— 这条守卫抓不到这个回退（假绿）`);
      }
    }
  } finally {
    // 无论如何都要还原源码（跑一半被打断也会走到这里）
    copyFileSync(BACKUP, SRC_PATH);
    rmSync(BACKUP, { force: true });
    const now = readFileSync(SRC_PATH, 'utf-8');
    console.log(`\n源码已还原：${now === original ? '✅' : '❌ 与原始内容不一致'}`);
  }

  console.log(`\n结果：抓到 ${caught} / ${targets.length}，漏掉 ${missed}`);
  if (missed > 0) {
    console.log('❌ 有变异没被门禁抓到');
    process.exit(1);
  }
  console.log('✅ 全部变异都被门禁抓到');
}

main();
