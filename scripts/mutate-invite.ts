/**
 * 「房间邀请 + 分享」门禁（`scripts/verify-invite.ts`）的变异测试 ——
 * 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的元素）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   ❌ 行里必须带**门禁编号**（I1~I7）——
 *   所以 verify-invite.ts 里每条门禁的失败信息都带编号。
 *
 * ## 与其它变异脚本的一处不同
 *
 * 别的脚本是「改源码 → build → 重启那个共享服务 → 跑门禁」；
 * 这一套的门禁**自己起一个隔离的 dev 服务**（见 `scripts/lib/test-server.ts`），
 * 所以这里**不用 build、也不用重启** ——
 * dev 模式按需编译，源码一改，下次请求就是新代码。
 * （顺带避开了「build 会清空用户的生产构建目录」那个坑。）
 *
 * 用法：
 *   npx tsx scripts/mutate-invite.ts [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { INVITE_GROUPS } from './lib/invite-groups';

const ROOT = process.cwd();

interface Mutation {
  /** 变异名 */
  name: string;
  /**
   * 要改的文件（相对项目根）。
   *
   * 给**数组**时表示「同一个性质由多道网共同保证」——
   * 那时 `from` / `to` 也要给数组，**按位置一一对应**。
   * 只拆一道网是测不出东西的（实测踩过：只拆私聊面板那一次 join，
   * 房间页的 effect 又发了一次，客人照样坐进对局，门禁照样全绿）。
   */
  file: string | string[];
  /**
   * 原文（必须**整行精确匹配**、且唯一命中）。
   * 给**数组**时表示「一次改多处」。
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

/** 这条变异涉及哪些文件 */
function filesOf(m: Mutation): string[] {
  return Array.isArray(m.file) ? m.file : [m.file];
}

const MUTATIONS: Mutation[] = [
  {
    /*
     * 【一】私聊面板里不出现「邀请来这局」按钮。
     *
     * 这一枚按钮是整条邀请链的**起点** —— 没有它，邀请这条需求整条不存在。
     */
    name: '【一】私聊面板里没有「邀请来这局」按钮（整条邀请链的起点没了）',
    file: 'src/components/DirectMessagePanel.tsx',
    from: `              {inviteRoom && (`,
    to: `              {false && (`,
    expect: 'I1',
  },
  {
    /*
     * 【二】邀请消息不渲染成**可点的卡片**，退化成一句普通文字。
     *
     * 这正是需求里明确要的东西（「接收方可以直接点击这个邀请」）——
     * 退化成文字之后，对方只能自己抄房间码。
     */
    name: '【二】邀请不渲染成可点卡片（退化成一句普通文字）',
    file: 'src/components/DirectMessagePanel.tsx',
    from: `                        className="dm-invite-card"`,
    to: `                        className="dm-invite-plain"`,
    expect: 'I2',
  },
  {
    /*
     * 【三】点卡片进去的是**观众**而不是对局方。
     *
     * 需求写的是「进入房间**参与游戏**」—— 进去只能看着不算数。
     *
     * **两道网一起拆**（这正是「一个性质可能由多道网共同保证」那条教训）：
     *   ① 私聊面板点卡片时发的那次 `room.join`；
     *   ② 对局页挂载后 effect 里发的那次 `room.join`。
     * 只拆 ① 的话，② 照样把客人送进对局 —— **门禁全绿，测了个寂寞**
     * （第一次跑就是这样：只拆了私聊面板那一次，I3 没红）。
     */
    name: '【三】点邀请卡片进去的是观众（两道网一起拆：面板那次 + 对局页那次）',
    file: ['src/components/DirectMessagePanel.tsx', 'src/app/room/[code]/page.tsx'],
    from: [`    joinRoom(code, 'play');`, `    joinRoom(code, 'play');`],
    to: [`    joinRoom(code, 'spectate');`, `    joinRoom(code, 'spectate');`],
    expect: 'I3',
  },
  {
    /*
     * 【四】已在别的局里点邀请时**不再二次确认**。
     *
     * 离开一局 = 判负（对方直接获胜）。不确认就跳 = 一条邀请
     * 就能悄悄把人家正在下的一局判掉。
     */
    name: '【四】跨房间点邀请不再二次确认（一条邀请就能判掉人家正在下的棋）',
    file: 'src/components/DirectMessagePanel.tsx',
    from: `    if (current) {
      setPendingJoin(code);
      return;
    }`,
    to: `    if (current) {
      // 变异：不确认，也不加入 —— 直接把人扔在原地
      return;
    }`,
    expect: 'I4',
  },
  {
    /*
     * 【五】分享菜单里少一件事（只剩「复制房间链接」）。
     */
    name: '【五】分享菜单里没有「复制房间码」',
    file: 'src/components/ShareMenu.tsx',
    from: `            复制房间码`,
    to: `            房间码`,
    expect: 'I5',
  },
  {
    /*
     * 【六】「复制房间链接」复制进去的其实是**房间码**。
     *
     * 提示照样弹「房间链接已复制」—— 只看提示的门禁抓不到它，
     * 必须把剪贴板**读回来核对**。
     */
    name: '【六】复制房间链接其实复制的是房间码（提示照样说「已复制」）',
    file: 'src/components/ShareMenu.tsx',
    from: `    const ok = await copyText(roomShareUrl(code));`,
    to: `    const ok = await copyText(code);`,
    expect: 'I6',
  },
  {
    /*
     * 【七】没记住用户名的人打开分享链接时**没有取名入口**。
     *
     * 分享链接最大的用处就在这儿：别人点开就能直接进这局。
     * 没有取名入口 = 分享链接把人挡在门外。
     */
    name: '【七】分享链接进来没有取名入口（别人点开链接进不了这局）',
    file: 'src/app/room/[code]/page.tsx',
    from: `                id="join-name"`,
    to: `                id="join-name-off"`,
    expect: 'I7',
  },
];

/* ------------------------------------------------------------------ */
/* 互斥锁：同一工作区只允许一份变异脚本在跑                            */
/* ------------------------------------------------------------------ */

/**
 * 为什么要锁：
 *   变异脚本会 **改源码 → 跑门禁 → 还原源码**。
 *   两份并发时：A 把源码删成变异态 → B 把这个状态读成自己的「原始版本」
 *   → B 结束时还原回去 → **功能被永久吃掉**（实测真的发生过）。
 */
const LOCK_FILE = join(ROOT, 'node_modules/.cache/chess-mutate-invite.lock');

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
        '）。并发会互相改写源码 —— 先确认那个进程真的停了再跑。',
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
 * 启动时记下**所有变异目标文件**的指纹（sha1 内容哈希），每次跑之前比对。
 * 有人动过就**直接退出** —— 在别人正在改的树上跑变异，结论既不可信，
 * 又会把人家的改动还原掉。
 */
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
    for (const f of filesOf(m)) {
      const p = join(ROOT, f);
      WORKSPACE_FINGERPRINT.set(p, fileFingerprint(p));
    }
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
        '（本轮结论不可信，且继续跑会把人家的改动还原掉）—— 先停手，确认改动归属后再跑。',
    );
  }
}

/* --dry：只检查目标串命中次数，不真的改文件 */
const DRY = process.argv.includes('--dry');
const FILTER = process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? '';
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
  const gs = groupsOfGate(INVITE_GROUPS, m.expect);
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
    const files = filesOf(m);
    const edits = pairs(m);
    let ok = true;
    files.forEach((f, i) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const hits = src.split(edits[i].from).length - 1;
      if (hits !== 1) {
        bad += 1;
        ok = false;
        console.error(`❌ 变异「${m.name}」的目标串在 ${f} 里命中 ${hits} 次（必须恰好 1 次）`);
      }
    });
    if (ok) console.log(`✅ 命中 1 次：${m.name}`);
  }
  console.log(`\n${DRY ? '（dry-run，未改任何文件）' : ''} 共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

/* 组覆盖硬自检：「按组强制」这条规矩的执行点 —— 每个组至少一条变异守着 */
const coverageProblems = checkGroupCoverage(
  INVITE_GROUPS,
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

// 记下工作区指纹（之后每次跑之前比对）
snapshotWorkspace();

let caught = 0;
for (const m of RUN) {
  const files = filesOf(m);
  const edits = pairs(m);
  if (files.length !== edits.length) {
    console.error(`❌ 变异「${m.name}」的文件数与编辑数对不上（${files.length} vs ${edits.length}）`);
    process.exit(1);
  }
  // 读入所有目标文件，并检查每处原文都**恰好命中 1 次**
  const originals = files.map((f) => readFileSync(join(ROOT, f), 'utf8'));
  files.forEach((f, i) => {
    const hits = originals[i].split(edits[i].from).length - 1;
    if (hits !== 1) {
      console.error(`❌ 变异「${m.name}」的目标串在 ${f} 里命中 ${hits} 次（必须恰好 1 次）`);
      process.exit(1);
    }
  });
  const groups = groupsFor(m);
  console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红，跑 ${groups.join('、')} 组）`);
  /*
   * 写盘**之前**确认工作区没被别人动过 ——
   * 放在这里才有效：脚本自己写的那份变异不能算成「别人的改动」。
   */
  assertWorkspaceUnchanged();
  try {
    files.forEach((f, i) => {
      const mutated = originals[i].replace(edits[i].from, edits[i].to);
      if (mutated === originals[i]) {
        console.error(`❌ 变异「${m.name}」改完之后 ${f} 没变（空变异）`);
        process.exit(1);
      }
      writeFileSync(join(ROOT, f), mutated);
      expectFileAsIs(join(ROOT, f));
    });

    const r = spawnSync(
      'npx',
      ['tsx', 'scripts/verify-invite.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 },
    );
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const redGates = extractRedGateIds(out);
    const gateRed = redGates.includes(m.expect);
    const nonzero = r.status !== 0;
    for (const g of redGates) {
      if (!redByGate.has(g)) redByGate.set(g, []);
      redByGate.get(g)!.push(m.name);
    }
    if (gateRed && nonzero) {
      caught += 1;
      console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.status}`);
    } else {
      console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.status} redGates=${redGates.join(',')}`);
      console.error(out.slice(-2500));
    }
  } finally {
    files.forEach((f, i) => {
      writeFileSync(join(ROOT, f), originals[i]);
      expectFileAsIs(join(ROOT, f));
    });
  }
}

/* ------------------------------------------------------------------ */
/* 覆盖报告                                                             */
/* ------------------------------------------------------------------ */
console.log(`\n📋 门禁覆盖报告`);
for (const group of Object.keys(INVITE_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of INVITE_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(`  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`);
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

const neverRed = allGateIds(INVITE_GROUPS).filter((id) => !redByGate.has(id));
if (neverRed.length > 0) {
  console.log(`\nℹ️  本轮没有打红过的门禁：${neverRed.join('、')}`);
  if (RUN.length === MUTATIONS.length) {
    console.error('   ⚠️  全量跑完还有门禁没被打红 —— 它们可能没人守着。');
  }
}

console.log(`\n${'─'.repeat(56)}`);
if (caught === RUN.length) {
  console.log(`✅ 变异测试 ${caught}/${RUN.length} 全部抓到`);
} else {
  console.log(`❌ 变异测试只抓到 ${caught}/${RUN.length}`);
  process.exit(1);
}
