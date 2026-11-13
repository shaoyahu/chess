/**
 * 「离开房间」门禁（`scripts/verify-room-exit.ts`）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（X1~X3）——
 *   所以 verify-room-exit.ts 里每条门禁的失败信息都带编号。
 *
 * 每条变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 用法：
 *   npx tsx scripts/mutate-room-exit.ts [--url=http://127.0.0.1:3000] [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { ROOM_EXIT_GROUPS } from './lib/room-exit-groups';

/*
 * 参数解析：**URL 和过滤词都不能靠「位置」猜**。
 * 传 `--url=` / `--filter=` 显式指定；位置参数仍兼容。
 */
const ARG_URL = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const POSITIONAL = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APP_URL = ARG_URL ?? POSITIONAL[0] ?? 'http://127.0.0.1:3000';
if (!/^https?:\/\//.test(APP_URL)) {
  console.error(`❌ APP_URL 不合法：「${APP_URL}」`);
  console.error('   用法：--url=http://127.0.0.1:3000 [--filter=片段]');
  process.exit(1);
}
const ROOT = process.cwd();

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string;
  /**
   * 原文（必须**整行精确匹配**、且唯一命中）。
   * 给**数组**时表示「一次改多处」—— 用在「一个性质由多道网共同保证」的地方。
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

const MUTATIONS: Mutation[] = [
  {
    /*
     * 【一】把「已经明确离开过这个房间」这层保护去掉 ——
     * 这就是「进入房间后离不掉」的**根因本身**：
     * 离开把本地快照清空 → 自动加入的 effect 立刻又发一次 room.join →
     * 服务端把人重新放回座位（人还在房里，对局照跑）。
     */
    name: '【一】离开之后不再记「我已经离开这个房间」（自动 room.join 又回来了）',
    file: 'src/app/room/[code]/page.tsx',
    from: `    // 先记「我已经离开这个房间」—— 否则本地快照被清空之后，
    // 上面那个「进入房间」的 effect 会立刻又发一次 room.join，把自己拉回去。
    leftRoomRef.current = code;`,
    to: `    // 变异：不记「我已经离开这个房间」—— 自动加入的 effect 会把人拉回去
    leftRoomRef.current = null;`,
    expect: 'X2',
  },
  {
    /*
     * 【二】观战者也弹二次确认 ——
     * 而离开的浮层只对**棋手**渲染，于是观战者点了「离开」一点反应都没有，
     * 人被卡在房间里出不来。
     */
    name: '【二】观战者点「离开」也弹二次确认（观战者被卡在房间里）',
    file: 'src/app/room/[code]/page.tsx',
    from: `    if (roomState?.status === 'playing' && myColor && !isSpectator) {`,
    to: `    if (roomState?.status === 'playing') {`,
    expect: 'X3',
  },
  {
    /*
     * 【三】客户端**彻底不通知服务端**（座位没收，对面还在跟幽灵下棋）。
     *
     * 为什么是**两处一起改**：
     *   「离开要通知服务端」这个性质，客户端上有**两道网** ——
     *     ① `leaveRoom()` 里直接发 `room.leave`；
     *     ② 迟到的房间快照到达时，`abandoned` 分支**再补发一次** `room.leave`。
     *   只拆掉 ①，② 会在下一秒把座位收掉 —— **测不到任何东西**（实测：门禁照样全绿）。
     *   这正是「一个性质可能由两道网共同保证，只拆一道测到的是另一道网」。
     *   所以这条变异把两道网**一起**拆掉，测的才是「客户端到底有没有通知服务端」。
     */
    name: '【三】客户端彻底不通知服务端（两道网一起拆：座位没收，对面还在跟幽灵下棋）',
    file: 'src/hooks/useSocket.ts',
    from: [
      `    if (this.state.room) {
      this.send({ t: 'room.leave' });
    }`,
      `          if (this.abandoned) {
            this.send({ t: 'room.leave' });
            break;
          }`,
    ],
    to: [
      `    if (this.state.room) {
      // 变异：不通知服务端
    }`,
      `          if (this.abandoned) {
            // 变异：迟到的快照也不补发 room.leave
            break;
          }`,
    ],
    expect: 'X1',
  },
  {
    /*
     * 【四】服务端收了人却**不删座位** ——
     * 门禁 X1 判的是「对手那边的快照里我这个座位没了」，
     * 所以这条守着服务端那一半。
     */
    name: '【四】服务端离开房间时不删座位（人走了位置还在）',
    file: 'src/server/room-manager.ts',
    from: '      delete room.seats[seat.color];',
    to: '      // 变异：不删座位',
    expect: 'X1',
  },
];

const sh = (cmd: string, args: string[]): { code: number; out: string } => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/**
 * 当前**监听** 3000 端口的 PID 列表。
 *
 * 注意 `-sTCP:LISTEN` —— **只算监听方**。
 * 原来写的是 `lsof -ti tcp:3000`，那会把**连着** 3000 的**客户端**也捞进来：
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

  /*
   * build 之后**校验产物完整**。
   * Next 的 build 会先把 `.next` 清空再写；被打断就留下半成品，
   * 症状是「服务起不来」，而真正的原因在几分钟之前。
   */
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
/* 互斥锁：同一工作区只允许一份变异脚本在跑                             */
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
/* 工作区指纹守卫                                                       */
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

/**
 * 把某个文件的「期望指纹」更新成**当前磁盘上的内容**。
 * 脚本自己写盘之后调它 —— 守卫既能抓「别人动过」，又不会把「脚本自己的变异」算成别人的改动。
 */
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

/* --dry：只检查目标串命中次数，不真的改文件（跑全量前先自查一遍） */
const DRY = process.argv.includes('--dry');
const FILTER =
  process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? POSITIONAL[1] ?? '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

/**
 * 本条变异要跑哪几组门禁。
 *
 * 默认取 `expect` 所属的组；变异显式写了 `groups` 就用它。
 */
function groupsFor(m: Mutation): string[] {
  const expectGroups = groupsOfGate(ROOM_EXIT_GROUPS, m.expect);
  const gs = expectGroups;
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
    const src = readFileSync(join(ROOT, m.file), 'utf8');
    let probe = src;
    let ok = true;
    for (const e of pairs(m)) {
      const hits = probe.split(e.from).length - 1;
      if (hits !== 1) {
        bad += 1;
        ok = false;
        console.error(`❌ 变异「${m.name}」的目标串在 ${m.file} 里命中 ${hits} 次（必须恰好 1 次）`);
      }
      probe = probe.replace(e.from, e.to);
    }
    if (ok) console.log(`✅ 命中 1 次：${m.name}`);
  }
  console.log(`\n${DRY ? '（dry-run，未改任何文件）' : ''} 共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

/* 组覆盖硬自检：「按组强制」这条规矩的执行点 —— 每个组至少一条变异守着 */
const coverageProblems = checkGroupCoverage(
  ROOM_EXIT_GROUPS,
  MUTATIONS.map((m) => ({ id: m.name, expect: m.expect })),
  new Map(MUTATIONS.map((m) => [m.name, groupsFor(m)] as [string, string[]])),
);
if (coverageProblems.length > 0) {
  console.error('\n❌ 组覆盖自检不通过：');
  for (const p of coverageProblems) console.error(`   · ${p}`);
  process.exit(1);
}

// 真跑之前先拿锁（--dry 不改文件，不需要）
acquireLock();
process.on('exit', releaseLock);

// 记下工作区指纹（之后每次 build 前比对）
snapshotWorkspace();

let caught = 0;
for (const m of RUN) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const edits = pairs(m);
  // 每处原文都必须在**当前内容**里恰好命中 1 次
  let probe = original;
  for (const e of edits) {
    const hits = probe.split(e.from).length - 1;
    if (hits !== 1) {
      console.error(`❌ 变异「${m.name}」的目标串在 ${m.file} 里命中 ${hits} 次（必须恰好 1 次）`);
      process.exit(1);
    }
    probe = probe.replace(e.from, e.to);
  }
  const groups = groupsFor(m);
  console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红，跑 ${groups.join('、')} 组）`);
  /*
   * 写盘**之前**确认工作区没被别人动过 ——
   * 放在这里才有效：脚本自己写的那份变异不能算成「别人的改动」。
   */
  assertWorkspaceUnchanged();
  try {
    let mutated = original;
    for (const e of edits) mutated = mutated.replace(e.from, e.to);
    if (mutated === original) {
      console.error(`❌ 变异「${m.name}」改完之后文件没变（空变异）`);
      process.exit(1);
    }
    writeFileSync(path, mutated);
    expectFileAsIs(path);
    try {
      rebuild();
    } catch (e) {
      // 构建失败 = 变异把类型检查搞崩了 —— 这条变异**不合格**（没测到门禁），
      // 但不能因此中断整轮：记一笔，继续跑下一条。
      console.error(`   ❌ 构建失败（变异破坏了类型检查）：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const r = sh('npx', [
      'tsx',
      'scripts/verify-room-exit.ts',
      `--url=${APP_URL}`,
      `--group=${groups.join(',')}`,
    ]);
    const redGates = extractRedGateIds(r.out);
    const gateRed = redGates.includes(m.expect);
    const nonzero = r.code !== 0;
    /* 记下「这条变异实际打红了哪些门禁」→ 跑完出覆盖报告 */
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
    writeFileSync(path, original);
    expectFileAsIs(path);
  }
}

// 恢复原状后重建一次，保证工作区和服务都是干净的
console.log('\n恢复原状并重建…');
rebuild();

/* ------------------------------------------------------------------ */
/* 覆盖报告 + 组覆盖自检                                                */
/* ------------------------------------------------------------------ */
console.log(`\n📋 门禁覆盖报告`);
for (const group of Object.keys(ROOM_EXIT_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of ROOM_EXIT_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(
      `  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`,
    );
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

const neverRed = allGateIds(ROOM_EXIT_GROUPS).filter((id) => !redByGate.has(id));
if (neverRed.length > 0) {
  console.log(`\nℹ️  本轮没有打红过的门禁：${neverRed.join('、')}`);
  if (RUN.length === MUTATIONS.length) {
    console.error('   ⚠️  全量跑完还有门禁没被打红 —— 它们可能没人守着。');
  } else {
    console.log(`   （本轮只跑了 ${RUN.length}/${MUTATIONS.length} 条变异，覆盖报告不完整。）`);
  }
}

console.log(`\n${'─'.repeat(56)}`);
if (caught === RUN.length) {
  console.log(`✅ 变异测试 ${caught}/${RUN.length} 全部抓到`);
} else {
  console.log(`❌ 变异测试只抓到 ${caught}/${RUN.length}`);
  process.exit(1);
}
