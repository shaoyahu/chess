/**
 * 「拖拽走子」门禁（`scripts/verify-drag.ts`）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（D1~D10）——
 *   所以 verify-drag.ts 里每条门禁的失败信息都带编号。
 *
 * 每条变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 用法：
 *   npx tsx scripts/mutate-drag.ts [--url=http://127.0.0.1:3000] [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { DRAG_GROUPS } from './lib/drag-groups';

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
     * 【一】2D 落点**不算纵向位移** ——
     * 拖到别的行也算不出落点 → 棋子永远停在原格 → 拖拽等于没反应。
     * （这是「差半格算错」那一类 bug 的极端形态：算出来的落点总在原格。）
     */
    name: '【一】2D 落点不算纵向位移（拖到别的行就落回原格，拖拽等于没反应）',
    file: 'src/components/Board2D.tsx',
    from: `            p.dy,
`,
    to: `            0, // 变异：不算纵向位移
`,
    expect: 'D1',
  },
  {
    /*
     * 【二】2D 非法落点**也照样走子**（客户端不拦，扔给服务端拒）——
     * 服务端会拒，但**浏览器已经把 move 发出去了**。
     * 这条守的是「该不该发这条消息」这个客户端责任。
     */
    name: '【二】2D 拖到非法格也照样发 move（客户端不拦，扔给服务端拒）',
    file: 'src/hooks/useBoardInteraction.ts',
    from: `      const target = dragTargetMap.get(square);
      if (!target) return; // 非法落点 → 什么都不做，棋子弹回原位`,
    to: `      const target =
        dragTargetMap.get(square) ??
        ({ to: square, capture: false, promotionRequired: false, san: '' } as LegalTarget);
      // 变异：非法落点也往下走`,
    expect: 'D2',
  },
  {
    /*
     * 【三】2D 拖动时**不显示落点提示** ——
     * 只显示「点选」那套提示（此时 `selected` 是空的 → 一条都不显示），
     * 于是拖动过程中完全看不出能落到哪。
     */
    name: '【三】2D 拖动时不显示落点提示（看不出能拖到哪）',
    file: 'src/components/Board2D.tsx',
    from: `          const shownTargets = dragFrom ? dragTargetMap : targetMap;`,
    to: `          // 变异：拖动时不显示落点提示
          const shownTargets = targetMap;`,
    expect: 'D3',
  },
  {
    /*
     * 【四】2D 拖完**不吞掉那一次 click** ——
     * 浏览器在 pointerup 之后还会派发一次 click，
     * 那一下 click 会走「点选」流程 → 刚拖完的棋子又被选中（界面上多一圈落点提示）。
     */
    name: '【四】2D 拖完不吞掉那一次 click（顺手把棋子选上了）',
    file: 'src/components/Board2D.tsx',
    from: `      suppressClickRef.current = commit;`,
    to: `      suppressClickRef.current = false; // 变异：不吞那一次 click`,
    expect: 'D4',
  },
  {
    /*
     * 【五】2D **点选走子**被拖拽流程吃掉 ——
     * 点了格子什么也不发生：既不选中，也走不了。
     * 这是「加了新交互、把老交互碰坏了」那一类回归。
     */
    name: '【五】2D 点选走子被拖拽流程吃掉（点了格子什么也不发生）',
    file: 'src/components/Board2D.tsx',
    from: `              onClick={() => onSquareClick(square)}`,
    to: `              onClick={() => undefined} // 变异：点选流程被吃掉`,
    expect: 'D5',
  },
  {
    /*
     * 【六】3D 落点**偏了 0.6 格** ——
     * 看着棋子压在目标格上，实际下到了隔壁文件 → 服务端拒 → 拖拽在 3D 上等于没用。
     *
     * 偏移量要**大于半格**才跨得出文件边界：
     * d5 的中心在 x = -0.5，d 文件占 x ∈ [-1, 0]，
     * 偏 0.4 还在 d 里（等于什么都没变，实测门禁照样全绿），偏 0.6 才落到 e5。
     */
    name: '【六】3D 落点偏了 0.6 格（看着在目标格，其实下到了隔壁文件）',
    file: 'src/components/Board3D.tsx',
    from: `      onDrop(commit ? worldToSquare(d.posX, d.posZ) : null);`,
    to: `      onDrop(commit ? worldToSquare(d.posX + 0.6, d.posZ) : null); // 变异：落点偏了`,
    expect: 'D6',
  },
  {
    /*
     * 【七】3D 拖动时**不抬起棋子** ——
     * 用户要的「按住就抬起来一点」没了，拖动看起来像棋子贴在地上滑。
     */
    name: '【七】3D 拖动时不抬起棋子（Z 轴上抬没了）',
    file: 'src/components/Board3D.tsx',
    from: `const DRAG_LIFT = 0.32;`,
    to: `const DRAG_LIFT = 0; // 变异：不抬起`,
    expect: 'D7',
  },
  {
    /*
     * 【八】3D 拖棋子时**相机跟着转** ——
     * 「按住棋子 = 拖棋子，按住空白处 = 转视角」这条规矩被破坏：
     * 拖到一半棋盘歪了，落点也跟着歪。
     *
     * 为什么打 `enabled` 就够：
     *   OrbitControls 在 `enabled === false` 时**压根不接管手势** ——
     *   所以「关掉」等于「这次按下就不是转视角」，而不是「转一半再停」。
     *   （产品侧已经把 `domElement` 钉死，手势不会再被重渲染中途拆掉，
     *   这条开关是唯一且显式的机制。）
     */
    name: '【八】3D 拖棋子时相机跟着转（拖到一半棋盘歪了）',
    file: 'src/components/Board3D.tsx',
    from: `      enabled={!dragging}`,
    to: `      enabled={true} // 变异：拖棋子时也允许转视角`,
    expect: 'D8',
  },
  {
    /*
     * 【九】3D **按住空白处也转不了视角**（相机被永久禁用）——
     * 反过来那条规矩也坏：想转个视角看看，拖不动。
     */
    name: '【九】3D 按住空白处也转不了视角（相机被永久禁用）',
    file: 'src/components/Board3D.tsx',
    from: `      enabled={!dragging}`,
    to: `      enabled={false} // 变异：相机永远禁用`,
    expect: 'D9',
  },
  {
    /*
     * 【十】3D **点选走子被吃掉** ——
     * 加了拖拽之后，老的「点起点 + 点终点」还能不能用？
     * 这条专门守着那个回归：把棋子的点击选中吃掉之后，
     * 点两下就再也走不了子了（只能拖）。
     */
    name: '【十】3D 点选走子被拖拽流程吃掉（点了两下也没反应）',
    file: 'src/components/Board3D.tsx',
    from: `        onSelect(piece.square);`,
    to: `        void 0; // 变异：吃掉点选`,
    expect: 'D10',
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
  const expectGroups = groupsOfGate(DRAG_GROUPS, m.expect);
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
  DRAG_GROUPS,
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
      'scripts/verify-drag.ts',
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
for (const group of Object.keys(DRAG_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of DRAG_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(
      `  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`,
    );
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

const neverRed = allGateIds(DRAG_GROUPS).filter((id) => !redByGate.has(id));
if (neverRed.length > 0) {
  console.log(`\n⚠️ 这些门禁本轮一次都没被打红：${neverRed.join('、')}`);
  console.log('   （可能是判据恒真 —— 那条门禁抓不到任何东西，等于摆设）');
}

console.log(`\n合计 ${RUN.length} 条变异，抓到 ${caught} 条。`);
process.exit(caught === RUN.length ? 0 : 1);
