/**
 * 「私信」门禁（`scripts/verify-dm.ts`）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（D1~D6）——
 *   所以 verify-dm.ts 里每条门禁的失败信息都带编号。
 *
 * 每条变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 用法：
 *   npx tsx scripts/mutate-dm.ts [--url=http://127.0.0.1:3000] [--filter=片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { DM_GROUPS } from './lib/dm-groups';

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
     * 【一】「在线 N」把**没登录的连接**也算进去 ——
     * 数字和名单对不上，就是「卡面承诺和真实状态不一致」。
     * 门禁里特意留了一个**连上但没发 hello** 的裸连接：
     * 两种口径只有在它存在时才会分叉。
     */
    name: '【一】「在线 N」把没登录的连接也算进去（数字和名单对不上）',
    file: 'src/server/ws-hub.ts',
    from: '      online: onlineUsers.length,',
    to: '      online: this.clients.size,',
    expect: 'D1',
  },
  {
    /*
     * 【二】右键菜单的「发送消息」不再打开私信面板 ——
     * 菜单还在、点得动，就是没反应。
     */
    name: '【二】右键菜单的「发送消息」不再打开私信面板（点了没反应）',
    file: 'src/components/OnlineUsersMenu.tsx',
    from: `            onClick={() => {
              message(ctxMenu.peer);
            }}`,
    to: `            onClick={() => {
              setCtxMenu(null);
            }}`,
    expect: 'D2',
  },
  {
    /*
     * 【三】服务端只把私信发给**收件人**，不给发送方回一份 ——
     * 发送方就看不到自己发了什么（「我发了没有」全靠猜）。
     *
     * 锚点带上前面那行：`at: Date.now(),` —— 邀请那条路径里有**一模一样**的
     * 两行发送（`kind: 'invite'` 那份），不锚住就会两处都命中，
     * 「恰好命中一次」的自检就会一直红着（自检红着比不检查更糟）。
     */
    name: '【三】服务端只把私信发给收件人，发送方自己不留一份',
    file: 'src/server/ws-hub.ts',
    from: `      at: Date.now(),
    };
    this.send(target, { t: 'dm', message });
    this.send(client, { t: 'dm', message });`,
    to: `      at: Date.now(),
    };
    this.send(target, { t: 'dm', message });
    // 变异：不给发送方回一份`,
    expect: 'D3',
  },
  {
    /*
     * 【四】收到私信**不记未读** ——
     * 顶栏角标不亮，人根本不知道有人找自己。
     */
    name: '【四】收到私信不记未读（顶栏角标不亮）',
    file: 'src/hooks/useSocket.ts',
    from: '          const nextUnread = mine ? this.state.dmUnread : this.state.dmUnread + 1;',
    to: '          const nextUnread = this.state.dmUnread;',
    expect: 'D4',
  },
  {
    /*
     * 【五】顶栏齿轮图标改回 15px —— 用户原话：「这个设置的图标有点太小了」。
     */
    name: '【五】顶栏设置图标改回 15px（图标又变小了）',
    file: 'src/app/page.tsx',
    from: '            <Settings size={19} aria-hidden="true" />',
    to: '            <Settings size={15} aria-hidden="true" />',
    expect: 'D5',
  },
  {
    /*
     * 【六】图标按钮的点击区改回 30×30 ——
     * 原来是 `.icon-btn`（0,1,0）被 `.btn.small`（0,2,0）压掉了 padding，
     * 按钮被限死 30px 宽却还带着 11px 内边距 —— 图标从 8px 宽的内容区里溢出来。
     */
    name: '【六】顶栏图标按钮的点击区改回 30×30（点不准）',
    file: 'src/app/globals.css',
    from: `.btn.icon-btn {
  padding: 8px;
  width: 38px;
  height: 38px;
}`,
    to: `.btn.icon-btn {
  padding: 11px;
  width: 30px;
  height: 30px;
}`,
    expect: 'D5',
  },
  {
    /*
     * 【七】对局页的私信按钮不再打开面板 ——
     * 收到私信的人正在棋盘上，就再也翻不出来了。
     */
    name: '【七】对局页的私信按钮不再打开面板（棋盘上收到私信翻不出来）',
    file: 'src/app/room/[code]/page.tsx',
    from: `          <DmButton unread={dmUnread} onClick={() => setDmOpen(true)} />`,
    to: `          <DmButton unread={dmUnread} onClick={() => setDmOpen(false)} />`,
    expect: 'D7',
  },
  {
    /*
     * 【八】私信记录**不落盘** ——
     * 刷新一次历史就没了，「有历史、能接着聊」就只是刷新前那几分钟的事。
     */
    name: '【八】私信记录不落盘（刷新之后历史就没了）',
    file: 'src/hooks/useSocket.ts',
    from: '          if (uid) saveDmStore(uid, next, nextUnread);',
    to: '          // 变异：不落盘 —— 刷新后历史就没了',
    expect: 'D7',
  },
  {
    /*
     * 【九】toast 挪回顶栏正上方 ——
     * 它会**盖住**顶栏右上角的「私信 / 设置」按钮：
     * 私信的未读角标被盖住（等于「说有未读」却看不见），
     * 而且那几秒里这两枚按钮还点不动（toast 的 z-index 在顶栏之上）。
     */
    name: '【九】收信的提示挪回顶栏正上方（盖住私信 / 设置按钮）',
    file: 'src/app/globals.css',
    from: `  top: 72px;
  right: 16px;
  z-index: 500;`,
    to: `  top: 16px;
  right: 16px;
  z-index: 500;`,
    expect: 'D6',
  },
  {
    /*
     * 【十】对局页顶栏的在线名单入口整个没了 ——
     * 用户原话：「游戏里不能查看在线玩家，这个有点离谱了」。
     */
    name: '【十】对局页顶栏不再有在线名单入口（棋盘上看不到谁在线）',
    file: 'src/app/room/[code]/page.tsx',
    from: `          <OnlineUsersMenu
            connected={connected}
            online={lobby.online}
            users={lobby.onlineUsers}
            selfId={session?.userId}
            offlineLabel="重连中…"
            onMessage={(peer) => {
              setDmPeer(peer);
              setDmOpen(true);
            }}
          />
`,
    to: ``,
    expect: 'D8',
  },
  {
    /*
     * 【十一】名单里**左键**某人不再进私信 ——
     * 右键那条路还在（所以「右键还能用」看着一切正常），
     * 但用户要求的「左键也行」没了。
     */
    name: '【十一】名单里左键某人不再进私信（左键这条路断了）',
    file: 'src/components/OnlineUsersMenu.tsx',
    from: `                  /* 左键 = 直接进私信 */
                  onClick={() => {
                    if (isSelf) return;
                    message(peer);
                  }}`,
    to: `                  /* 左键 = 直接进私信 */
                  onClick={() => {
                    if (isSelf) return;
                  }}`,
    expect: 'D9',
  },
  {
    /*
     * 【十二】私聊入口的图标改回信封 ——
     * 用户原话：「大厅中私聊的图标目前是邮件，应该换成聊天气泡」。
     */
    name: '【十二】私聊入口的图标改回信封（又变回邮件了）',
    file: 'src/components/DmButton.tsx',
    from: [
      `import { MessageCircle } from 'lucide-react';`,
      `<MessageCircle size={19} aria-hidden="true" />`,
    ],
    to: [`import { Mail } from 'lucide-react';`, `<Mail size={19} aria-hidden="true" />`],
    expect: 'D10',
  },
  {
    /*
     * 【十三】大厅里又塞回一整块玩法说明 ——
     * 说明文字一旦回到页面上，界面就等于没设计好（用户明确要求删掉）。
     */
    name: '【十三】大厅里又塞回一整块玩法说明（解释性文字回来了）',
    file: 'src/app/page.tsx',
    from: `      <main className="container" style={{ paddingBottom: 48, flex: 1 }}>`,
    to: `      <main className="container" style={{ paddingBottom: 48, flex: 1 }}>
            <div className="lobby-foot">
              <div className="tip">
                <b>快速匹配</b>
                <span>选好时限进队列，只跟选同一时限的人配对。</span>
              </div>
            </div>`,
    expect: 'D11',
  },
  {
    /*
     * 【十四】在线名单浮层**不再因「点别处」收起** ——
     * 用户报的现象回来了：开着名单点顶栏「私信」，抽屉在名单底下，
     * 名单正好盖在聊天窗上（看得见、点不着）。
     */
    name: '【十四】在线名单浮层不再因「点别处」收起（盖在私信面板上）',
    file: 'src/components/OnlineUsersMenu.tsx',
    from: `    const onDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setOpen(false);
      setCtxMenu(null);
    };`,
    to: `    const onDown = (e: PointerEvent): void => {
      // 变异：点别处不再收起浮层
      void e;
    };`,
    expect: 'D12',
  },
  {
    /*
     * 【十五】客户端**不再有冷却**（快捷短语不禁用、也不再拦一手）——
     * 按住一颗连点就能把私信轰炸出去，对面被糊成一列提示。
     */
    name: '【十五】快捷私信不再有冷却（按住连点就能轰炸）',
    file: 'src/components/DirectMessagePanel.tsx',
    from: [
      `    /* 冷却中：直接不发（按钮已经是灰的，这里是第二道保险） */
    if (Date.now() < cooldownUntil) return;
`,
      `                    disabled={cooling}
                  >
                    {t}`,
      `                  disabled={cooling}
                >
                  <Swords`,
    ],
    to: [
      `    // 变异：不再拦
`,
      `                    disabled={false}
                  >
                    {t}`,
      `                  disabled={false}
                >
                  <Swords`,
    ],
    expect: 'D13',
  },
  {
    /*
     * 【十六】服务端**不再限频** ——
     * 客户端那层只是给人看的提示，改个协议就能绕过去的那种不算规则。
     */
    name: '【十六】服务端不再限频私信（连发全收）',
    file: 'src/server/ws-hub.ts',
    from: `    if (now - client.lastDmAt < DM_SEND_MIN_INTERVAL_MS) {
      this.send(client, { t: 'toast', kind: 'error', message: '发送太快了，稍等一下' });
      return true;
    }`,
    to: `    // 变异：不限频`,
    expect: 'D13',
  },
  {
    /*
     * 【十七】同一个人的私信**不再合并** ——
     * 每条都弹一条提示，连发几条就把对面顶栏糊成一整列。
     */
    name: '【十七】同一个人的私信不再合并成一条（提示糊成一列）',
    file: 'src/hooks/useSocket.ts',
    from: `                \`dm:\${dm.from}\`,
                (n) => \`\${dm.fromName} 给你发来 \${n} 条消息\`,`,
    to: `                undefined,
                (n) => \`\${dm.fromName} 给你发来 \${n} 条消息\`,`,
    expect: 'D14',
  },
  {
    /*
     * 【十八】提示区**不再封顶** ——
     * 提示条从右上角一路铺到屏幕中间，把棋盘盖住。
     */
    name: '【十八】提示区不再封顶（提示条一路铺到屏幕下面）',
    file: 'src/components/ToastHost.tsx',
    from: `const MAX_VISIBLE = 4;`,
    to: `const MAX_VISIBLE = 99;`,
    expect: 'D14',
  },
  {
    /*
     * 【十九】私聊面板里又塞回一句「冷却 N 秒」——
     * 按钮变灰**已经**说明了一切，再写一句是**多此一举**：
     * 用户要的是「按不动」，不是「读一句话再知道按不动」。
     */
    name: '【十九】私聊面板又写回「冷却 N 秒」（界面不自我解释了）',
    file: 'src/components/DirectMessagePanel.tsx',
    from: `                    {t}
                  </button>
                ))}
              </div>`,
    to: `                    {t}
                  </button>
                ))}
                <span className="dm-cool">冷却 1 秒</span>
              </div>`,
    expect: 'D13',
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
  const expectGroups = groupsOfGate(DM_GROUPS, m.expect);
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
  DM_GROUPS,
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
      'scripts/verify-dm.ts',
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
for (const group of Object.keys(DM_GROUPS)) {
  console.log(`\n组「${group}」：`);
  const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
  for (const g of DM_GROUPS[group]) {
    const hits = redByGate.get(g) ?? [];
    console.log(
      `  ${g}：${hits.length ? `被 ${hits.join('、')} 打红` : '本轮没被打红'}`,
    );
  }
  if (guards.length === 0) console.log(`  ⚠️ 这一组没有任何变异守着`);
}

const neverRed = allGateIds(DM_GROUPS).filter((id) => !redByGate.has(id));
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
