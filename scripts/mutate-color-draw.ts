#!/usr/bin/env tsx
/**
 * 「抽签定黑白 + 准备环节」门禁（`scripts/verify-color-draw.ts`）的变异测试。
 *
 * 为什么必须做：
 *   门禁自己出 bug（判据恒真、量错了量、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（C1~C9）。
 *
 * 每条变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 用法：
 *   npx tsx scripts/mutate-color-draw.ts [--url=http://127.0.0.1:3000] [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const ARG_URL = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const POSITIONAL = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APP_URL = ARG_URL ?? POSITIONAL[0] ?? 'http://127.0.0.1:3000';
if (!/^https?:\/\//.test(APP_URL)) {
  console.error(`❌ APP_URL 不合法：「${APP_URL}」`);
  console.error('   用法：--url=http://127.0.0.1:3000 [--filter=片段]');
  process.exit(1);
}
const ROOT = process.cwd();

/* ------------------------------------------------------------------ */
/* 变异清单                                                            */
/* ------------------------------------------------------------------ */

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string;
  /** 原文（必须**整段精确匹配**、且唯一命中） */
  from: string;
  /** 改成的文字 */
  to: string;
  /** 预期变红的门禁编号 */
  expect: string;
}

const MUTATIONS: Mutation[] = [
  {
    /*
     * 【C1】人机选「我执白」被**无视** ——
     * 玩家明明点了「我执白」，服务端还是把他塞到黑方。
     * 这正是「人机对弈总是电脑执白」那个老问题的变种。
     */
    name: '【C1】人机选「我执白」被无视（玩家被塞到黑方）',
    file: 'src/server/room-manager.ts',
    from: `    const color: Color = humanColor === 'random' ? this.drawColor() : humanColor;`,
    to: `    const color: Color = humanColor === 'random' ? this.drawColor() : 'b'; // 变异：无视玩家的选择`,
    expect: 'C1',
  },
  {
    /*
     * 【C2】人机选「我执黑」被**无视** ——
     * 跟 C1 是一对：只测一个方向的话，把实现写成「永远白」也能骗过 C1。
     */
    name: '【C2】人机选「我执黑」被无视（玩家被塞到白方）',
    file: 'src/server/room-manager.ts',
    from: `    const color: Color = humanColor === 'random' ? this.drawColor() : humanColor;`,
    to: `    const color: Color = humanColor === 'random' ? this.drawColor() : 'w'; // 变异：无视玩家的选择`,
    expect: 'C2',
  },
  {
    /*
     * 【C3】服务端把「有座位的玩家」**误判成观战者** ——
     * 人机局里玩家的颜色是对的，但身份被算成 spectator，
     * 前端就会给他显示观战视角。
     */
    name: '【C3】有座位的玩家被误判成观战者（role 判错）',
    file: 'src/server/ws-hub.ts',
    from: `      role: seat || isPending ? 'player' : 'spectator',`,
    to: `      role: isPending ? 'player' : 'spectator', // 变异：忘了「有座位」`,
    expect: 'C3',
  },
  {
    /*
     * 【C4】抽签**写死**成白方 ——
     * 随机源还在调用，但结果被忽略。
     * 只看「抽签函数被调用了」是抓不到这种 bug 的。
     */
    name: '【C4】抽签写死成白方（随机源被调用但结果被忽略）',
    file: 'src/server/room-manager.ts',
    from: `    return this.drawSource() < 1 ? 'w' : 'b';`,
    to: `    void this.drawSource();\n    return 'w'; // 变异：抽签写死`,
    expect: 'C4',
  },
  {
    /*
     * 【C5】**先进房的人直接坐定**（还原旧 bug：谁先进来谁执白）——
     * 房间一空就把第一个人塞进白方座位，不再「颜色待定」。
     */
    name: '【C5】先进房的人直接坐白方（还原「谁先进来谁执白」的老 bug）',
    file: 'src/server/room-manager.ts',
    from: `      room.pending = {
        userId: identity.userId,
        name: identity.name,
        connected: true,
      };
      room.status = 'waiting';`,
    to: `      room.seats.w = {
        userId: identity.userId,
        name: identity.name,
        color: 'w',
        connected: true,
        isAI: false,
        ready: false,
      };
      room.status = 'waiting'; // 变异：先进者直接坐白方`,
    expect: 'C5',
  },
  {
    /*
     * 【C6】抽签之后**两人没各执一边**（黑白方是同一个人）——
     * 「两人到齐才抽签」这条规矩的落点就在这里。
     */
    name: '【C6】抽签后黑白两方是同一个人（两人没各执一边）',
    file: 'src/server/room-manager.ts',
    from: `    const firstIsWhite = this.drawWhite() === 'first';
    const white = firstIsWhite ? first : second;
    const black = firstIsWhite ? second : first;`,
    to: `    const firstIsWhite = this.drawWhite() === 'first';
    const white = firstIsWhite ? first : second;
    const black = white; // 变异：黑方与白方同一个人`,
    expect: 'C6',
  },
  {
    /*
     * 【C7】「准备」只算**一方**（把 && 写成 ||）——
     * 一方点了准备就开局，另一方还没来得及看自己执的是哪边。
     *
     * 用 `||` 而不是「只看白方」：后者会随抽签结果时灵时不灵 ——
     * 抽到白方先 ready 的那局会照样红，看起来像门禁在抽签。
     */
    name: '【C7】准备环节只算一方（一方点准备就开局）',
    file: 'src/server/room-manager.ts',
    from: `    const allReady = Boolean(room.seats.w?.ready) && Boolean(room.seats.b?.ready);`,
    to: `    const allReady = Boolean(room.seats.w?.ready) || Boolean(room.seats.b?.ready); // 变异：一方准备就开局`,
    expect: 'C7',
  },
  {
    /*
     * 【C8】开局时**黑方先走** ——
     * 准备环节的意义就是让白方看清自己执白再开；
     * 谁先走搞错了，整局的节奏就反了。
     */
    name: '【C8】开局时黑方先走（先走方搞反）',
    file: 'src/lib/constants.ts',
    from: `export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';`,
    to: `export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'; // 变异：黑方先走`,
    expect: 'C8',
  },
  {
    /*
     * 【C9】大厅摘要**不带待抽签玩家名字** ——
     * 大厅里那个房间就显示成「空房间」，
     * 别人不知道已经有人在等 —— 看起来像房间没人。
     */
    name: '【C9】大厅摘要不带待抽签玩家名字（房间显示成空房间）',
    file: 'src/server/ws-hub.ts',
    from: `      pendingName: room.pending?.name,`,
    to: `      pendingName: undefined, // 变异：大厅里丢掉待抽签玩家`,
    expect: 'C9',
  },
];

/* ------------------------------------------------------------------ */
/* 进程与端口工具                                                      */
/* ------------------------------------------------------------------ */

const sh = (cmd: string, args: string[]): { code: number; out: string } => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/**
 * 当前**监听** 3000 端口的 PID 列表。
 *
 * 注意 `-sTCP:LISTEN` —— **只算监听方**。
 * `lsof -ti tcp:3000` 会把**连着** 3000 的**客户端**也捞进来：
 * 门禁自己的 node 进程、Chromium 的 helper，甚至**用户正在用的浏览器**。
 * 而这段的用途是 `kill -9` —— 于是门禁会把自己的进程、用户的浏览器一起杀掉。
 */
function listeners(): string[] {
  const r = spawnSync('bash', ['-c', "lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | tr '\\n' ' '"], {
    encoding: 'utf8',
  });
  return (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

/** 停掉监听 3000 的服务，并**等端口真的空出来** */
function stopServer(): void {
  for (let i = 0; i < 40; i += 1) {
    const pids = listeners();
    if (pids.length === 0) return;
    sh('bash', ['-c', `for p in ${pids.join(' ')}; do kill -9 "$p" 2>/dev/null; done; true`]);
    spawnSync('sleep', ['0.5']);
  }
  if (listeners().length !== 0) throw new Error('旧服务没停干净');
}

/**
 * 起新服务，并确认**监听 3000 的是新起的那个**。
 *
 * 不能只看 `curl 200`：新服务起不来时 curl 会打到**旧服务**上，
 * 门禁跑的是上一条变异的产物 —— 结论直接作废，而且症状极隐蔽。
 */
function startServer(before: Set<string>): void {
  spawnSync('bash', ['-c', `PORT=3000 nohup npm start > /tmp/chess-server.log 2>&1 &`], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${APP_URL}/`], {
      encoding: 'utf8',
    });
    const now = listeners();
    const isNew = now.length > 0 && now.every((p) => !before.has(p));
    if ((r.stdout ?? '').trim() === '200' && isNew) return;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error('服务没起来');
}

/**
 * 重新构建并重启生产服务。
 *
 * **顺序必须是「停服务 → build → 起服务」**，不能反过来。
 * `next build` 一开始会**清空 `.next`**，而运行中的生产服务器正在读写同一个目录 ——
 * 实测：服务运行中连跑 4 次 build，第 1 次就报 ENOENT 挂掉。
 */
function rebuild(): void {
  console.log('   · 停服务 → 构建 → 起服务…');

  // build 会做全项目类型检查 —— 期间有人改源码就会读到半成品
  assertWorkspaceUnchanged();

  const before = new Set(listeners());
  stopServer();

  const b = sh('npm', ['run', 'build']);
  if (b.code !== 0) {
    console.error(b.out.slice(-2000));
    throw new Error('构建失败');
  }

  // build 之后**校验产物完整**（被打断会留下半成品，症状是「服务起不来」）
  if (!existsSync(join(ROOT, '.next/BUILD_ID'))) {
    console.error('   · 构建产物不完整（.next/BUILD_ID 缺失）—— build 很可能被中断了');
    throw new Error('构建产物不完整');
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      startServer(before);
      return;
    } catch {
      console.error(`   · 服务没起来（第 ${attempt} 次尝试），再试一次`);
      stopServer();
      spawnSync('sleep', ['1']);
    }
  }
  console.error('   · 服务端日志（/tmp/chess-server.log）末尾：');
  console.error(sh('bash', ['-c', 'tail -30 /tmp/chess-server.log 2>/dev/null']).out);
  throw new Error('服务重启后没有响应（已重试 3 次）');
}

/* ------------------------------------------------------------------ */
/* 互斥锁：同一工作区只允许一份变异脚本在跑                            */
/* ------------------------------------------------------------------ */

/**
 * 为什么要锁：
 *   变异脚本会 **改源码 → 跑门禁 → 还原源码**，还要 **`next build`**。
 *   两份并发时：A 把源码删成变异态 → B 把这个状态读成自己的「原始版本」
 *   → B 结束时还原回去 → **功能被永久吃掉**（实测真的发生过）。
 *   而且 `task_stop` 不保证整个进程组死透，所以不能靠「我记得只有一个在跑」。
 */
const LOCK_FILE = join(ROOT, 'node_modules/.cache/chess-mutate.lock');

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
        '）。并发会互相改写源码 —— 先确认那个进程真的停了再重跑。',
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
/* 工作区指纹守卫                                                      */
/* ------------------------------------------------------------------ */

/**
 * 变异期间**别人改了工作区**的检测。
 *
 * 做法：启动时记下**所有变异目标文件**的指纹（sha1 内容哈希），
 * 每次 build 前比对。有人动过就**直接退出** ——
 * 在别人正在改的树上跑变异，结论既不可信，又会把人家的改动还原掉。
 */
const WORKSPACE_FINGERPRINT = new Map<string, string>();

function fileFingerprint(path: string): string {
  try {
    // **内容哈希**，不是 mtime + 大小 ——
    // 脚本自己写盘再还原，内容没变但 mtime 变了，用 mtime 的话下一轮就误报「被别人改过」。
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** 把某个文件的「期望指纹」更新成**当前磁盘上的内容**（脚本自己写盘后调它） */
function expectFileAsIs(path: string): void {
  WORKSPACE_FINGERPRINT.set(path, fileFingerprint(path));
}

function snapshotWorkspace(): void {
  WORKSPACE_FINGERPRINT.clear();
  for (const m of MUTATIONS) {
    const p = join(ROOT, m.file);
    WORKSPACE_FINGERPRINT.set(p, fileFingerprint(p));
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
        '（本轮结论不可信，且继续跑会把人家的改动还原掉）—— 先停手，确认改动归属后再重跑。',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 过滤 / dry                                                          */
/* ------------------------------------------------------------------ */

const DRY = process.argv.includes('--dry');
const FILTER =
  process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? POSITIONAL[1] ?? '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

if (DRY) {
  let bad = 0;
  for (const m of RUN) {
    const src = readFileSync(join(ROOT, m.file), 'utf8');
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      bad += 1;
      console.error(`❌ 变异「${m.name}」的目标串在 ${m.file} 里命中 ${hits} 次（必须恰好 1 次）`);
    } else {
      console.log(`✅ 命中 1 次：${m.name}`);
    }
  }
  console.log(`\n${DRY ? '（dry-run，未改任何文件）' : ''} 共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

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

acquireLock();
process.on('exit', releaseLock);

// 记下工作区指纹（之后每次 build 前比对）
snapshotWorkspace();

let caught = 0;
let fatal: unknown = null;

try {
  for (const m of RUN) {
    const path = join(ROOT, m.file);
    const original = readFileSync(path, 'utf8');
    // 原文必须在**当前内容**里恰好命中 1 次
    const hits = original.split(m.from).length - 1;
    if (hits !== 1) {
      console.error(`❌ 变异「${m.name}」的目标串在 ${m.file} 里命中 ${hits} 次（必须恰好 1 次）`);
      process.exit(1);
    }
    console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红）`);
    /*
     * 写盘**之前**确认工作区没被别人动过 ——
     * 放在这里才有效：脚本自己写的那份变异不能算成「别人的改动」。
     */
    assertWorkspaceUnchanged();
    try {
      const mutated = original.replace(m.from, m.to);
      if (mutated === original) {
        console.error(`❌ 变异「${m.name}」改完之后文件没变（空变异）`);
        process.exit(1);
      }
      writeFileSync(path, mutated);
      expectFileAsIs(path);
      try {
        rebuild();
      } catch (e) {
        /*
         * 构建失败 = 变异把类型检查搞崩了 —— 这条变异**不合格**。
         *
         * 而且**必须终止整轮**：build 失败后 `.next` 是半成品、
         * 服务停在旧产物上，后面全在脏环境里跑，结论一律作废。
         */
        console.error(
          `   ❌ 构建失败（变异破坏了类型检查）：${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }
      const r = sh('npx', ['tsx', 'scripts/verify-color-draw.ts', `--url=${APP_URL}`]);
      const redGates = extractRedGateIds(r.out);
      const gateRed = redGates.includes(m.expect);
      const nonzero = r.code !== 0;
      for (const g of redGates) {
        if (!redByGate.has(g)) redByGate.set(g, []);
        redByGate.get(g)!.push(m.name);
      }
      if (gateRed && nonzero) {
        caught += 1;
        console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.code}`);
      } else {
        console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.code} redGates=${redGates.join(',')}`);
        console.error(r.out.slice(-2500));
      }
    } finally {
      // 还原源码（不论成败都要还原）
      writeFileSync(path, original);
      expectFileAsIs(path);
    }
  }
} catch (e) {
  fatal = e;
} finally {
  // 恢复原状后重建一次，保证工作区和服务都是干净的
  try {
    console.log('\n恢复原状并重建…');
    rebuild();
  } catch (e) {
    if (!fatal) fatal = e;
  }
  releaseLock();
}

if (fatal) {
  console.error(`\n❌ 变异轮次中止：${fatal instanceof Error ? fatal.message : String(fatal)}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 覆盖报告                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n📋 门禁覆盖报告`);
for (const m of MUTATIONS) {
  const hits = redByGate.get(m.expect) ?? [];
  console.log(
    `  ${m.expect}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`,
  );
}

const allExpect = MUTATIONS.map((m) => m.expect);
const neverRed = allExpect.filter((id) => !redByGate.has(id));
if (neverRed.length > 0) {
  console.log(`\n⚠️ 这些门禁本轮一次都没被打红：${neverRed.join('、')}`);
  console.log('   （可能是判据恒真 —— 那条门禁抓不到任何东西，等于摆设）');
}

console.log(`\n合计 ${RUN.length} 条变异，抓到 ${caught} 条。`);
process.exit(caught === RUN.length ? 0 : 1);
