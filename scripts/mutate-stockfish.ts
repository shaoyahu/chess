/**
 * 变异测试 —— 确认 Stockfish 接入门禁（scripts/verify-stockfish.ts）真能抓到回退。
 *
 * 为什么要做：
 * 守卫脚本自己也可能写错（比如阈值写太松、断言写反、只在一条路径上生效），
 * 那它就会变成一个「永远绿」的假警报。所以每个改动都要**改回 bug**，
 * 确认门禁真的会变红 —— 用进程退出码判定，不 grep 框架文本。
 *
 * 这条链路横跨 6 个文件，所以备份/还原要按文件处理。
 *
 * 用法：npm run mutate:stockfish
 *      npx tsx scripts/mutate-stockfish.ts M5    # 只跑名字里含 M5 的变异
 */

import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 变异作用的文件 */
const FILES = {
  uci: 'src/lib/engine/uci.ts',
  backend: 'src/lib/engine/uci-backend.ts',
  difficulty: 'src/lib/engine/difficulty.ts',
  source: 'src/lib/engine/engine-source.ts',
  pool: 'src/server/engine-pool.ts',
  worker: 'src/server/engine-worker.ts',
} as const;

type FileKey = keyof typeof FILES;

interface Mutation {
  name: string;
  /** 变异作用的文件 */
  file: FileKey;
  /** 把文件内容改回 bug 的方式 */
  apply: (src: string) => string;
}

const MUTATIONS: Mutation[] = [
  {
    // 送给引擎的局面被写死成初始局面：所有局面都按开局搜
    name: 'M1 position 命令写死 startpos（不在真实局面上搜索）',
    file: 'uci',
    apply: (src) =>
      src.replace(
        'this.write(`position fen ${opts.fen}`);',
        "this.write('position startpos');",
      ),
  },
  {
    // bestmove 解析放宽：非法着法字符串也能通过
    name: 'M2 parseUciMove 的正则放宽（非法着法也能解析出来）',
    file: 'uci',
    apply: (src) =>
      src.replace(
        'const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim());',
        'const m = /^(.+)(.+)([qrbn])?$/.exec(uci.trim());',
      ),
  },
  {
    // 搜索超时后不报错，而是伪造一个着法糊弄上层
    name: 'M3 搜索超时不报错（伪造一个着法返回）',
    file: 'uci',
    apply: (src) =>
      src.replace(
        'reject(new UciError(`引擎搜索超时（${hardTimeout}ms）`));',
        "resolve({ uci: 'a1a1', from: 'a1', to: 'a1', scoreCp: 0, depth: 0, nodes: 0 });",
      ),
  },
  {
    // 着法不再用 chess.js 复核：引擎给出什么都不管
    name: 'M4 引擎着法不再复核（直接判定为无着可走）',
    file: 'backend',
    apply: (src) =>
      src.replace(
        '  const candidate: EngineMove = {\n    from: best.from,',
        '  if (best) return null;\n  const candidate: EngineMove = {\n    from: best.from,',
      ),
  },
  {
    // 限强开关写反：easy 档反而不限强，hard 档反而被限住
    name: 'M5 限强开关写反（easy 不限强、hard 被限住）',
    file: 'backend',
    apply: (src) =>
      src.replace(
        'const wantLimit = opts.limitStrength !== false;',
        'const wantLimit = opts.limitStrength === false;',
      ),
  },
  {
    // 难度 → Elo 的映射写错
    name: 'M6 easy 档的 Elo 映射写错（1320 → 2400）',
    file: 'difficulty',
    apply: (src) => src.replace('  easy: 1320,', '  easy: 2400,'),
  },
  {
    // 不再优先用系统引擎，一律退回 npm 包
    name: 'M7 引擎发现不再优先系统引擎',
    file: 'source',
    apply: (src) => src.replace('  if (system) {', '  if (false && system) {'),
  },
  {
    // 引擎池退化成单进程：并发请求全部串行
    name: 'M8 引擎池退化成单进程（并发能力消失）',
    file: 'pool',
    apply: (src) =>
      src.replace(
        'this.maxWorkers = Math.max(1, opts.maxWorkers ?? defaultMaxWorkers());',
        'this.maxWorkers = 1;',
      ),
  },
  {
    // 子进程忽略 backend 字段：一律走自研引擎，Stockfish 形同虚设
    name: 'M9 子进程忽略 backend 字段（一律走自研引擎）',
    file: 'worker',
    apply: (src) => src.replace("const backend = req.backend ?? 'auto';", "const backend = 'builtin';"),
  },
  {
    // 限强时不下发深度：退化成 go movetime，Stockfish 的限强形同虚设
    // （实测：限强只在 go depth 下咬得住，go movetime 下与不限强几乎同着法）
    name: 'M10 限强时不下发深度（限强退化成 go movetime 而失效）',
    file: 'backend',
    apply: (src) =>
      src.replace(
        'const depth = wantLimit ? (opts.depth ?? stockfishDepthOf(difficulty)) : opts.depth;',
        'const depth = opts.depth;',
      ),
  },
  {
    // 找到杀棋后不再 stop：引擎会一路虚搜到时间耗尽，玩家白等
    // （实测 npm 那个 JS 构建在找到杀棋后会一路冲到 depth 245）
    name: 'M12 找到杀棋后不再 stop（白等满时间预算）',
    file: 'uci',
    apply: (src) =>
      src.replace(
        "return /\\bscore mate\\b/.test(line);",
        'return false;',
      ),
  },
  {
    // 不再跳过 npm 包的软链：npm 环境下会把慢一档的 JS 构建当成系统引擎
    name: 'M13 不再跳过 npm 包软链（慢一档的 JS 构建被当成系统引擎）',
    file: 'uci',
    apply: (src) => src.replace('if (isNpmShim(full)) continue;', 'if (false && isNpmShim(full)) continue;'),
  },
  {
    // 深度上限写死：所有档位都被压到 easy 的深度，难度区分度消失
    name: 'M11 深度上限写死成 6（所有档位都是浅搜）',
    file: 'backend',
    apply: (src) =>
      src.replace(
        'const depth = wantLimit ? (opts.depth ?? stockfishDepthOf(difficulty)) : opts.depth;',
        'const depth = wantLimit ? (opts.depth ?? 6) : opts.depth;',
      ),
  },
];

function runGuard(): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-stockfish.ts'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): void {
  const root = process.cwd();
  const paths: Record<FileKey, string> = {
    uci: resolve(root, FILES.uci),
    backend: resolve(root, FILES.backend),
    difficulty: resolve(root, FILES.difficulty),
    source: resolve(root, FILES.source),
    pool: resolve(root, FILES.pool),
    worker: resolve(root, FILES.worker),
  };
  const backupDir = resolve(root, '.stockfish-mutation-backup');
  const originals = new Map<FileKey, string>();

  for (const key of Object.keys(paths) as FileKey[]) {
    if (!existsSync(paths[key])) {
      console.error(`❌ 源文件不存在: ${paths[key]}`);
      process.exit(1);
    }
    originals.set(key, readFileSync(paths[key], 'utf-8'));
  }

  console.log('变异测试：Stockfish 链路 6 个源文件 × scripts/verify-stockfish.ts\n');
  console.log('基线：未变异 → 门禁通过');

  let caught = 0;
  let missed = 0;

  const filter = process.argv[2];
  const targets = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
  if (targets.length === 0) {
    console.log(`❌ 没有名字包含「${filter}」的变异`);
    process.exit(1);
  }

  try {
    // 基线：未变异必须全绿，否则谈不上「变异能被抓到」
    const base = runGuard();
    if (base.code !== 0) {
      console.log('\n❌ 基线门禁就是红的 —— 先修好门禁再做变异测试');
      console.log(base.out);
      process.exit(1);
    }
    console.log('基线通过 ✅\n');

    for (const m of targets) {
      const original = originals.get(m.file)!;
      const mutated = m.apply(original);
      if (original === mutated) {
        console.log(`\n❌ ${m.name}\n   ⚠️  变异没有生效（没匹配到目标字符串）—— 守卫可能是假绿`);
        missed += 1;
        continue;
      }
      // 只改这一个文件，其它文件保持原样
      writeFileSync(paths[m.file], mutated, 'utf-8');
      const { code, out } = runGuard();
      if (code !== 0) {
        caught += 1;
        const line = out
          .split('\n')
          .filter((l) => l.includes('❌'))
          .slice(0, 3)
          .join('\n');
        console.log(`✅ ${m.name}\n   门禁变红 ✅\n${line}\n`);
      } else {
        missed += 1;
        console.log(`\n❌ ${m.name}\n   ⚠️  门禁仍然全绿 —— 这条守卫抓不到这个回退（假绿）\n`);
      }
      // 每条之后立刻还原，避免下一条在污染态上叠加
      writeFileSync(paths[m.file], original, 'utf-8');
    }
  } finally {
    // 无论如何都要还原源码（跑一半被打断也会走到这里）
    for (const [key, content] of originals) {
      writeFileSync(paths[key], content, 'utf-8');
    }
    rmSync(backupDir, { recursive: true, force: true });
    let allRestored = true;
    for (const [key, content] of originals) {
      if (readFileSync(paths[key], 'utf-8') !== content) allRestored = false;
    }
    console.log(`\n源码已还原：${allRestored ? '✅' : '❌ 与原始内容不一致'}`);
    if (!allRestored) process.exitCode = 1;
  }

  console.log(`\n结果：抓到 ${caught} / ${targets.length}，漏掉 ${missed}`);
  if (missed > 0) {
    console.log('❌ 有变异没被门禁抓到');
    process.exit(1);
  }
  console.log('✅ 全部变异都被门禁抓到');
}

main();
