/**
 * 变异测试 —— 确认对比度门禁（scripts/check-contrast.ts）真能抓到回退。
 *
 * 为什么要做：
 * 守卫脚本自己也可能写错（比如阈值写太松、期望表和实际渲染对不上），
 * 那它就会变成一个"永远绿"的假警报。所以每条修复都要**改回 bug**，
 * 确认门禁真的会变红 —— 用进程退出码判定，不 grep 输出文本。
 *
 * 用法：npm run mutate:contrast
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const CSS_PATH = resolve(process.cwd(), 'src/app/globals.css');
const BACKUP = resolve(process.cwd(), '.contrast-mutation-backup.css');

interface Mutation {
  name: string;
  /** 把文件内容改回 bug 的方式 */
  apply: (css: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 2D/3D 切换激活态改回「深色字压棕底」（3.27:1）',
    apply: (css) =>
      css.replace(
        /(\.view-toggle button\.active\s*\{[^}]*?)color:\s*#fff8ec;/,
        '$1color: #20180a;',
      ),
  },
  {
    name: 'M2 --text-faint 改回浅色 #7b7367（页面底色上只有 4.07:1）',
    apply: (css) => css.replace('--text-faint: #726a5e;', '--text-faint: #7b7367;'),
  },
  {
    name: 'M3 终局结果卡文字改回 --accent（4.50:1，差一点点不到线）',
    apply: (css) => css.replace(/(\.result-card\s*\{[^}]*?)color:\s*var\(--accent-strong\);/, '$1color: var(--accent);'),
  },
  {
    name: 'M4 主按钮文字改回深色（配 --accent-strong 底）',
    apply: (css) =>
      css.replace(/(\.btn\.primary\s*\{[^}]*?)color:\s*#fff8ec;/, '$1color: #20180a;'),
  },
  {
    name: 'M5 整体换回暗色主题（--bg-panel 变深底）',
    apply: (css) => css.replace('--bg-panel: #ffffff;', '--bg-panel: #1b1512;'),
  },
];

function runGuard(): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/check-contrast.ts'], {
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
  const original = readFileSync(CSS_PATH, 'utf-8');
  copyFileSync(CSS_PATH, BACKUP);

  console.log('变异测试：src/app/globals.css × scripts/check-contrast.ts\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  try {
    for (const m of MUTATIONS) {
      const mutated = m.apply(original);
      if (!changed(original, mutated)) {
        console.log(`\n❌ ${m.name}\n   ⚠️  变异没有生效（没匹配到目标字符串）—— 守卫可能是假绿`);
        missed += 1;
        continue;
      }
      writeFileSync(CSS_PATH, mutated, 'utf-8');
      const { code, out } = runGuard();
      if (code !== 0) {
        caught += 1;
        const line = out
          .split('\n')
          .filter((l) => l.includes('❌'))
          .slice(0, 2)
          .join('\n              ');
        console.log(`\n✅ 抓到了  ${m.name}  [退出码 ${code}]`);
        if (line) console.log(`              ${line.trim()}`);
      } else {
        missed += 1;
        console.log(`\n❌ 没抓到  ${m.name}  [退出码 0] —— 守卫是假绿`);
      }
    }
  } finally {
    // 无论成败都必须还原，并核对还原后与原始内容逐字节一致
    copyFileSync(BACKUP, CSS_PATH);
    rmSync(BACKUP, { force: true });
    const restored = readFileSync(CSS_PATH, 'utf-8');
    if (restored !== original) {
      console.error('\n❌ 还原失败：globals.css 与原始内容不一致，请检查！');
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
