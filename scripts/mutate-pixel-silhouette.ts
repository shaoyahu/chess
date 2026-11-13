/**
 * 变异测试 —— 确认**像素风辨识度门禁**（tests/pixel-silhouette.test.ts）真能抓到回退。
 *
 * 为什么要做：
 *   守卫脚本自己也可能写错（比如阈值写太松、降采样口径写错、度量恒真），
 *   那它就会变成一个「永远绿」的假警报 —— 比没门禁更危险，因为人会学会忽略它。
 *   所以每条修复都要**改回 bug**，确认门禁真的会变红。
 *   用**进程退出码**判定，不 grep 输出文本。
 *
 * 变异覆盖四类退化：
 *   ① ��子直接撞脸（兵 = 象）
 *   ② 特征退化（象的正圆头、后��平尖、车的垛缝消失、王的横杠收窄）
 *   ③ 度量本身被改坏（降采样阈值放到 0 → 几乎所有格都算实心 → IoU 全体 100%）
 *
 * 用法：npm run mutate:pixel
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET = resolve(process.cwd(), 'src/components/pixelShapes.ts');
const BACKUP = resolve(process.cwd(), '.pixel-mutation-backup.ts');

interface Mutation {
  name: string;
  /** 把源码改回 bug 的方式 */
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 兵直接变成象（两枚棋子共用同一副剪影）',
    apply: (src) => src.replace('function paintPawn(c: PixelCanvas): void {', 'function paintPawn(c: PixelCanvas): void {\n  paintBishop(c);\n  return;'),
  },
  {
    name: 'M2 象的头改回**正圆**（丢掉斜顶特征 → 和兵的圆球头撞脸）',
    apply: (src) =>
      src.replace(
        /const head: Array<\[number, number, number\]> = \[[\s\S]*?\];/,
        'const head: Array<[number, number, number]> = [];\n  c.disc(12, CX, 5);',
      ),
  },
  {
    name: 'M3 后的中央大尖被削成与两侧翼同高（中央高尖 = 后唯一的识别特征）',
    apply: (src) => src.replace('c.taper(4, 13, 15.5, 4, 8);', 'c.taper(9, 8, 15.5, 4, 6);'),
  },
  {
    name: 'M4 车的三个方垛**连成一整块**（垛缝消失 → 特征缩放后就没了）',
    apply: (src) =>
      src.replace(
        /c\.rect\(8, 8, 6, 4\);\n  c\.rect\(8, 14, 6, 4\);\n  c\.rect\(8, 20, 6, 4\);/,
        'c.rect(8, 8, 6, 16);',
      ),
  },
  {
    name: 'M5 王的横杠从 24 格收窄到 12 格（十字不再比别的宽 → 和后/车撞脸）',
    apply: (src) => src.replace('c.rect(6, 4, 4, 24);', 'c.rect(6, 10, 4, 12);'),
  },
  {
    name: 'M6 降采样阈值放到 0（几乎所有格都算实心 → IoU 全体趋近 100%）',
    apply: (src) => src.replace('solidArea / totalArea >= 0.5', 'solidArea / totalArea >= 0'),
  },
];

function runGuard(): { code: number; out: string } {
  const r = spawnSync('npx', ['vitest', 'run', 'tests/pixel-silhouette.test.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function changed(before: string, after: string): boolean {
  return before !== after;
}

function main(): void {
  const original = readFileSync(TARGET, 'utf-8');
  copyFileSync(TARGET, BACKUP);

  console.log('变异测试：src/components/pixelShapes.ts × tests/pixel-silhouette.test.ts\n');
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
      writeFileSync(TARGET, mutated, 'utf-8');
      const { code, out } = runGuard();
      if (code !== 0) {
        caught += 1;
        const line = out
          .split('\n')
          .filter((l) => l.includes('AssertionError') || l.includes('→'))
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
    copyFileSync(BACKUP, TARGET);
    rmSync(BACKUP, { force: true });
    const restored = readFileSync(TARGET, 'utf-8');
    if (restored !== original) {
      console.error('\n❌ 还原失败：pixelShapes.ts 与原始内容不一致，请检查！');
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
