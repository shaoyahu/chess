/**
 * 变异测试 —— 确认「连接状态」这条新机制的门禁真的能抓到回退。
 *
 * 变异与对应守卫（scripts/verify-connection-state.ts，G1~G3）：
 *   M1 连接超时形同虚设 → G1 必须红（状态灯永远停在「连接中…」）
 *   M2 连不上时不给反馈 → G2 必须红（点「进入大厅」像没点）
 *   M3 登录时不记住身份 → G3 必须红（服务器恢复了还要再点一次）
 *
 * 为什么必须做：
 *   守卫脚本自己也可能写错（断言写歪、跳过条件太宽、时间给得太松），
 *   那它就会变成一个「永远绿」的假警报。所以每条修复都要**改回 bug**，
 *   确认门禁真的会变红 —— 用**进程退出码 + 门禁编号**判定，不 grep 别的文本。
 *
 * 特别提醒（踩过的坑）：**「没抓到」第一嫌疑是变异本身是空操作**。
 *   比如把一个判断改成恒真，如果那条分支本来就走不到，行为根本没变 ——
 *   门禁当然还是绿的。所以下面每条变异都断言「文件内容确实变了」，
 *   而且挑的都是**有行为差异**的改法。
 *
 * 浏览器门禁会**自己起一个隔离的 dev 服务**（构建目录、存档目录、端口都隔离，
 *   见 scripts/lib/test-server.ts 的说明），不碰用户自己跑着的服务。
 *
 * 用法：npm run mutate:connection-state
 */
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const USE_SOCKET = resolve(process.cwd(), 'src/hooks/useSocket.ts');
const PAGE = resolve(process.cwd(), 'src/app/page.tsx');
const USE_SOCKET_BACKUP = resolve(process.cwd(), '.conn-mutation-useSocket.ts');
const PAGE_BACKUP = resolve(process.cwd(), '.conn-mutation-page.tsx');

interface Mutation {
  name: string;
  file: string;
  /** 期望被抓到的那条门禁编号 */
  expect: string;
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 连接超时形同虚设（永远等不到「连不上」）',
    file: USE_SOCKET,
    expect: 'G1',
    apply: (src) => src.replace('const CONNECT_TIMEOUT_MS = 10_000;', 'const CONNECT_TIMEOUT_MS = 600_000;'),
  },
  {
    name: 'M2 连不上时不给反馈（点「进入大厅」像没点）',
    file: PAGE,
    expect: 'G2',
    apply: (src) =>
      src.replace(
        "    if (status === 'failed') {\n      pushToast('error', '连不上服务器，正在重连');\n    }\n",
        '',
      ),
  },
  {
    name: 'M3 登录时不记住身份（服务器恢复了还要再点一次）',
    file: USE_SOCKET,
    expect: 'G3',
    apply: (src) => src.replace('this.identity = { name: clean, token };', 'this.identity = null;'),
  },
];

interface RunResult {
  code: number;
  out: string;
}

/** 跑一遍浏览器门禁 */
function runBrowserGuard(): RunResult {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-connection-state.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 600000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 门禁输出里有没有「我们期望的那条编号」 */
function hasGate(out: string, expect: string): boolean {
  return out.split('\n').some((l) => l.includes(expect));
}

/**
 * 还原被变异的文件。
 *
 * 单独抽出来，是因为**中断**（Ctrl-C / 被 kill）时 `finally` 也可能来不及跑 ——
 * 那时仓库里会**留下变异态的生产代码**（实测踩过：中断之后单测直接挂了 4 条）。
 * 所以信号处理里也要还原。
 */
function restoreAll(originals: Map<string, string>): void {
  copyFileSync(USE_SOCKET_BACKUP, USE_SOCKET);
  copyFileSync(PAGE_BACKUP, PAGE);
  rmSync(USE_SOCKET_BACKUP, { force: true });
  rmSync(PAGE_BACKUP, { force: true });
  for (const [file, content] of originals) {
    if (readFileSync(file, 'utf-8') !== content) {
      console.error(`\n❌ 还原失败：${file} 与原始内容不一致，请检查！`);
      process.exit(1);
    }
  }
}

function main(): void {
  const originals = new Map<string, string>([
    [USE_SOCKET, readFileSync(USE_SOCKET, 'utf-8')],
    [PAGE, readFileSync(PAGE, 'utf-8')],
  ]);
  copyFileSync(USE_SOCKET, USE_SOCKET_BACKUP);
  copyFileSync(PAGE, PAGE_BACKUP);

  const onSignal = (sig: string): void => {
    console.log(`\n（收到 ${sig}，还原被变异的文件）`);
    restoreAll(originals);
    process.exit(1);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  console.log('变异测试：连接状态（useSocket.ts / page.tsx）\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  try {
    const base = runBrowserGuard();
    if (base.code !== 0) {
      console.error('\n❌ 基线门禁就不通过，先把改动本身修好再谈变异。');
      console.error(base.out.slice(-2000));
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

      const result = runBrowserGuard();
      const red = result.code !== 0;
      const rightGate = hasGate(result.out, m.expect);
      // 打印**全部**失败行：只看自己那条会漏掉「门禁是因为别的原因挂的」
      const failedLines = result.out
        .split('\n')
        .filter((l) => l.includes('❌'))
        .slice(0, 5);
      if (red && rightGate) {
        console.log(`✅ ${m.name} → ${m.expect} 变红（抓到了）`);
        for (const l of failedLines) console.log(`   ${l.trim()}`);
        caught += 1;
      } else if (!red) {
        console.log(`\n❌ ${m.name}\n   ⚠️  门禁**没变红**（退出码 ${result.code}）—— 守卫是假绿`);
        console.log(result.out.slice(-1500));
        missed += 1;
      } else {
        console.log(`\n❌ ${m.name}\n   ⚠️  门禁变红了，但红的不是 ${m.expect} —— 守卫抓错了地方`);
        for (const l of failedLines) console.log(`   ${l.trim()}`);
        missed += 1;
      }

      // 还原（下一条变异要基于原始代码）
      writeFileSync(m.file, original, 'utf-8');
    }
  } finally {
    restoreAll(originals);
  }

  console.log('');
  console.log(`变异测试结果：抓到 ${caught}/${MUTATIONS.length}，漏掉 ${missed}`);
  if (missed > 0) process.exit(1);
  console.log('✅ 门禁真的能抓到回退');
  process.exit(0);
}

main();
