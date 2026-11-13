/**
 * 「重连 / 恢复」门禁（`scripts/verify-reconnect.ts`）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * ## 和别的变异脚本不一样的地方
 *
 * **不用 build、不用重启服务**：
 *   `verify-reconnect.ts` 会**自己起一个服务端**（跑在临时存档目录上），
 *   所以「变异源码 → 跑门禁」就是全部 —— 服务端起的就是**变异后的代码**。
 *   这让每条变异省掉了 build（~10s）和服务重启（~2.3s）。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（R1~R4）。
 *
 * 用法：
 *   npx tsx scripts/mutate-reconnect.ts [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { RECONNECT_GROUPS } from './lib/reconnect-groups';

const ROOT = process.cwd();

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string;
  /** 原文（必须**整行精确匹配**、且唯一命中） */
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
     * 【一】客户端**不把座位凭证存进 localStorage**。
     *
     * 这是「关掉网页再打开」的第一块砖：
     * 凭证没了 → 重开后没东西可认领 → 座位回不来。
     */
    name: '【一】客户端不把座位凭证存进 localStorage（重开后没东西可认领）',
    file: 'src/hooks/useSocket.ts',
    from: `          if (msg.claimKey && msg.state.code) {
            const store = loadClaimStore();
            if (store[msg.state.code] !== msg.claimKey) {
              store[msg.state.code] = msg.claimKey;
              saveClaimStore(store);
            }
          }`,
    to: `          // 变异：凭证不落盘 —— 重开网页就认不回座位了`,
    expect: 'R1',
  },
  {
    /*
     * 【二】进房间**永远走普通加入**，不用凭证认领。
     *
     * 症状跟【一】一样（重开后变成观战者），但根因不同：
     * 一个是「凭证没存」，一个是「存了但没用」。
     */
    name: '【二】进房间永远走普通加入（不用凭证认领，重开后变成观战者）',
    file: 'src/hooks/useSocket.ts',
    from: `    const claimKey = loadClaimStore()[code];
    if (claimKey) {
      // 主动加入 = 新的意图 → 清掉「放弃这个房间」的标记
      this.abandoned = false;
      return this.send({ t: 'room.claim', code, claimKey });
    }
    return this.send({ t: 'room.join', code, mode });`,
    to: `    // 变异：不用凭证认领 —— 永远走普通加入
    return this.send({ t: 'room.join', code, mode });`,
    expect: 'R1',
  },
  {
    /*
     * 【三】公共快照里**不再剔除座位凭证**。
     *
     * 凭证一旦广播出去，任何人都能拿它抢走那个座位 ——
     * 哪怕座位的主人此刻正连着。
     */
    name: '【三】公共快照里不再剔除座位凭证（凭证被广播给所有人）',
    file: 'src/server/room-manager.ts',
    from: `    const stripClaim = (seat: Seat | undefined): Seat | undefined =>
      seat
        ? {
            userId: seat.userId,
            name: seat.name,
            color: seat.color,
            connected: seat.connected,
            disconnectedAt: seat.disconnectedAt,
            isAI: seat.isAI,
            ready: seat.ready,
          }
        : undefined;`,
    to: `    // 变异：不再剔除凭证 —— 凭证跟着公共快照广播出去了
    const stripClaim = (seat: Seat | undefined): Seat | undefined => seat;`,
    expect: 'R2',
  },
  {
    /*
     * 【四】客户端**不启动心跳**。
     *
     * 没有心跳，浏览器察觉不到「连接已经死了」——
     * 半开连接下两边都以为连着，对局永远卡住。
     */
    name: '【四】客户端不启动心跳（察觉不到连接已死，断网后回不来）',
    file: 'src/hooks/useSocket.ts',
    from: `      this.lastPongAt = Date.now();
      this.startHeartbeat();`,
    to: `      this.lastPongAt = Date.now();
      // 变异：不启动心跳`,
    expect: 'R3',
  },
  {
    /*
     * 【五】换连接时**不更新界面状态**。
     *
     * 连接已经死了，界面还写着「已连接」—— 玩家看着一个不动的棋盘，
     * 以为是自己卡了，以为要刷新页面。
     * （这条是门禁跑出来之后补的真实 bug。）
     */
    name: '【五】换连接时不更新界面状态（还在骗人说「已连接」）',
    file: 'src/hooks/useSocket.ts',
    from: `    this.stopHeartbeat();
    /*
     * **界面要立刻说实话。**
     *
     * 连接已经死了，却还写着「已连接」—— 玩家看着一个不动的棋盘，
     * 以为是自己卡了，以为要刷新页面。
     *
     * 这条 \`setState\` 不能省：换连接的那几秒里，
     * 顶栏必须显示「重连中…」，人就知道「是我这边断了，正在自己接回来」。
     */
    this.setState({ connected: false });`,
    to: `    this.stopHeartbeat();
    // 变异：不更新界面状态 —— 还在骗人说「已连接」`,
    expect: 'R3',
  },
  {
    /*
     * 【六】**会话档案不落盘**（两道网一起拆）。
     *
     * 认领后旧身份的会话档案会被清掉 —— 否则他再连回来会以为「我还在这个房间里」，
     * 而座位已经换人了。
     *
     * ## 为什么是**两处**一起改
     *
     * 「会话档案落盘」这个性质，服务端有**两道网**：
     *   ① `persist()` → `scheduleSaveSessions()`（节流写盘，走的是常规路径）；
     *   ② `flushNow()` → `flush(rooms, sessions)`（退出前/测试里显式写盘）。
     *
     * 只拆 ① 的话，② 会在服务端退出时**照样把会话档案写下去** ——
     * 门禁照样全绿，**什么也没测到**（实测：只拆 ① 时 R4 没变红）。
     *
     * 这正是「一个性质可能由**两道网**共同保证，只拆一道测到的是另一道网」。
     * 所以这条变异把两道网**一起**拆掉，测的才是「会话档案到底有没有落盘」。
     */
    name: '【六】会话档案不落盘（两道网一起拆：服务重启后身份认不回来）',
    file: 'src/server/ws-hub.ts',
    from: [
      `    scheduleSave(this.roomArchives());
    scheduleSaveSessions(this.sessionArchives());`,
      `  async flushNow(): Promise<void> {
    await flush(this.roomArchives(), this.sessionArchives());
  }`,
    ],
    to: [
      `    scheduleSave(this.roomArchives());
    // 变异：会话档案不落盘（① 常规路径）`,
      `  async flushNow(): Promise<void> {
    // 变异：会话档案不落盘（② 退出前的显式写盘）
    await flush(this.roomArchives());
  }`,
    ],
    expect: 'R4',
  },
];

/* ------------------------------------------------------------------ */
/* 跑一条命令                                                          */
/* ------------------------------------------------------------------ */
function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* ------------------------------------------------------------------ */
/* 互斥锁：同一工作区只允许一份变异脚本在跑                             */
/* ------------------------------------------------------------------ */
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
const WORKSPACE_FINGERPRINT = new Map<string, string>();

function fileFingerprint(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

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
/* 参数                                                                */
/* ------------------------------------------------------------------ */
const DRY = process.argv.includes('--dry');
const FILTER = process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

function groupsFor(m: Mutation): string[] {
  const gs = groupsOfGate(RECONNECT_GROUPS, m.expect);
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
  console.log(`\n（dry-run，未改任何文件）共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

/* 组覆盖硬自检：「按组强制」这条规矩的执行点 —— 每个组至少一条变异守着 */
const coverageProblems = checkGroupCoverage(
  RECONNECT_GROUPS,
  MUTATIONS.map((m) => ({ id: m.name, expect: m.expect })),
  new Map(MUTATIONS.map((m) => [m.name, groupsFor(m)] as [string, string[]])),
);
if (coverageProblems.length > 0) {
  console.error('\n❌ 组覆盖自检不通过：');
  for (const p of coverageProblems) console.error(`   · ${p}`);
  process.exit(1);
}

acquireLock();
process.on('exit', releaseLock);
snapshotWorkspace();

let caught = 0;
for (const m of RUN) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const edits = pairs(m);
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
    /*
     * **门禁自己起服务端**，所以这里不用 build、不用重启 ——
     * 它起的就是**变异后的代码**（dev 模式直接跑源码）。
     */
    const r = sh('npx', ['tsx', 'scripts/verify-reconnect.ts', `--group=${groups.join(',')}`]);
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
    writeFileSync(path, original);
    expectFileAsIs(path);
  }
}

console.log('\n📋 门禁覆盖报告');
for (const group of Object.keys(RECONNECT_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of RECONNECT_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(`  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`);
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

console.log(`\n共 ${RUN.length} 条变异，抓到 ${caught} 条`);
/*
 * 「哪些门禁本轮没被打红过」只在**全量**跑时才有意义 ——
 * `--filter` 只跑某几条，别的门禁当然没人打红它们，
 * 那不是「没人验证」，只是这次没跑到。
 */
const missed = FILTER
  ? []
  : allGateIds(RECONNECT_GROUPS).filter((g) => !(redByGate.get(g) ?? []).length);
if (missed.length > 0) {
  console.error(`❌ 这些门禁本轮没被打红过（等于没人验证它们会不会红）：${missed.join('、')}`);
  process.exitCode = 1;
}
process.exitCode = caught === RUN.length ? 0 : 1;
