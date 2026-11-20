/**
 * 新增功能门禁（scripts/verify-settings-ui.ts）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（U1…U13）——
 *   所以 verify-settings-ui.ts 里每条门禁的失败信息都带编号。
 *
 * 每个变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 用法：
 *   npx tsx scripts/mutate-settings-ui.ts [http://127.0.0.1:3000] [变异名片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateTurnedRed } from './lib/gate-match';

/*
 * 参数解析：**URL 和过滤词都不能靠「位置」猜**（详见 mutate-move-arrow.ts 的同段注释）。
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

/**
 * 端口**跟着 APP_URL 走**，不写死 3000。
 *
 * 原来 `listeners()` 和 `rebuild()` 里都写死了 3000：
 *   · 门禁跑在 3111 上时，脚本会去杀 3000 端口上的进程 ——
 *     那可能是**用户自己开着的服务**，直接被 kill -9。
 *   · 重建后又在 3000 起服务，门禁却去连 3111 —— 测的根本不是自己起的那个。
 */
const APP_PORT = (() => {
  try {
    const u = new URL(APP_URL);
    if (u.port) return u.port;
    return u.protocol === 'https:' ? '443' : '80';
  } catch {
    return '3000';
  }
})();

/**
 * 变异脚本自己起的服务用**独立的存档目录**。
 *
 * 门禁会造房间、造会话 —— 落在用户的真实存档里就是凭空多出几个假房间。
 * 这里指到 /tmp 下的独立目录，跟生产数据彻底隔开。
 */
const MUTATE_DATA_DIR = join('/tmp', `lan-chess-mutate-${APP_PORT}`);

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string;
  /**
   * 原文（必须唯一命中）。
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
    name: '【一】齿轮按钮点了不打开设置',
    file: 'src/app/room/[code]/page.tsx',
    from: 'onClick={() => setSettingsOpen(true)}',
    to: 'onClick={() => setSettingsOpen(false)}',
    expect: 'U1',
  },
  {
    name: '【二】设置面板少了「辅助下棋」开关',
    file: 'src/components/SettingsDialog.tsx',
    from: 'aria-label="辅助下棋开关"',
    to: 'aria-label="辅助下棋开关X"',
    expect: 'U2',
  },
  {
    name: '【三】音效默认改成开',
    file: 'src/lib/settings.ts',
    from: '  soundEnabled: false,',
    to: '  soundEnabled: true,',
    expect: 'U3',
  },
  {
    name: '【四】棋盘又叠回木纹贴图（不纯色）',
    file: 'src/components/Board2D.tsx',
    from: "        '--wood-light': activeTheme.wood ? `url(${getWoodTexture('light')})` : 'none',",
    to: "        '--wood-light': `url(${getWoodTexture('light')})`,",
    expect: 'U4',
  },
  {
    name: '【五】换配色不生效（深格写死原木色）',
    file: 'src/components/Board2D.tsx',
    from: "        '--bg-board-dark': activeTheme.dark,",
    to: "        '--bg-board-dark': '#a97c50',",
    expect: 'U5',
  },
  {
    name: '【六】棋谱按钮跑到快捷聊天左边',
    file: 'src/app/globals.css',
    // 目标串跟着 globals.css 的改版更新过（间距改成了 var(--sp-2)，
    // 后面还加了 min-width: 0 与说明注释）—— 变异必须命中**当前**代码。
    from: `.rail-quick-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);`,
    to: `.rail-quick-row {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: var(--sp-2);`,
    expect: 'U6',
  },
  {
    /*
     * 【七】棋谱按钮点了没反应。
     *
     * 宽屏下棋谱是**左栏常驻的记谱卡**，按钮只管「收起 / 展开」。
     * 按钮失灵 → 卡收不起来 → U19 的「收起后卡真的没了」判据变红。
     */
    name: '【七】棋谱按钮点了没反应（记谱卡收不起来）',
    file: 'src/app/room/[code]/page.tsx',
    from: `                  if (isNarrow) setNotationSheetOpen(true);
                  else setNotationCardOpen((v) => !v);`,
    to: `                  void 0; // 变异：点了没反应`,
    expect: 'U19',
  },
  {
    name: '【八】窄屏棋谱浮层样式跟聊天不一样',
    file: 'src/app/globals.css',
    from: `.notation-panel {
  width: min(360px, 92vw);
  max-width: 100%;
  /* 固定高度（不跟着着法条数变）—— 和聊天弹层一个规矩 */
  height: min(62vh, 520px);
  max-height: min(62vh, 520px);
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);`,
    to: `.notation-panel {
  width: min(360px, 92vw);
  max-width: 100%;
  /* 固定高度（不跟着着法条数变）—— 和聊天弹层一个规矩 */
  height: min(62vh, 520px);
  max-height: min(62vh, 520px);
  display: flex;
  flex-direction: column;
  background: #eeeeee;`,
    expect: 'U8',
  },
  {
    name: '【九】点「提示」不发请求（箭头永远不出现）',
    file: 'src/app/room/[code]/page.tsx',
    from: "                          send({ t: 'hint.request' });",
    to: "                          void 0; // 变异：不发提示请求",
    expect: 'U9',
  },
  {
    /*
     * 【九b】辅助下棋又变成**自动**显示下一步（回到老行为）。
     *
     * 这条守的是「点了才显示」这条新要求本身 ——
     * 没有它，U9a 的判据（有没有发过 hint.request）就没有变异守着。
     *
     * 改法：把清理用的 effect 变回「轮到我走就自动请求」。
     * 用 `hintFenRef` 当「这个局面已经要过了」的闸门，所以不会每个快照都发一次。
     */
    name: '【九b】辅助下棋又变成自动显示下一步（没点按钮就出箭头）',
    file: 'src/app/room/[code]/page.tsx',
    from: `    if (hintFenRef.current && hintFenRef.current !== roomState.fen) {
      setHintMove(null);
    }
    hintFenRef.current = roomState.fen;`,
    to: `    if (hintFenRef.current === roomState.fen) return;
    hintFenRef.current = roomState.fen;
    setHintPending(true);
    send({ t: 'hint.request' });`,
    expect: 'U9',
  },
  {
    name: '【十】关掉辅助下棋后箭头不消失',
    file: 'src/app/room/[code]/page.tsx',
    from: `    if (!settings.hintEnabled) {
      hintFenRef.current = '';
      setHintMove(null);
      return;
    }`,
    to: `    if (!settings.hintEnabled) {
      hintFenRef.current = '';
      return;
    }`,
    expect: 'U10',
  },
  {
    name: '【十一】默认难度不是「普通」',
    file: 'src/lib/types.ts',
    from: "export const DEFAULT_DIFFICULTY: Difficulty = 'normal';",
    to: "export const DEFAULT_DIFFICULTY: Difficulty = 'hard';",
    expect: 'U11',
  },
  {
    /*
     * 【十三】服务端进房失败不再回错误消息（只回 toast）。
     *
     * 目标串跟着代码更新过：进房失败现在走 `rejectJoin()`，
     * 里面先发一条 toast、再发一条 error —— 去掉后者，
     * 页面就永远停在「正在进入房间…」（拿不到原因，也没有出口）。
     */
    name: '【十三】服务端进房失败不再回错误消息（只回 toast）',
    file: 'src/server/ws-hub.ts',
    from: "    this.send(client, { t: 'error', message, code });",
    to: "    // 变异：不再回错误消息",
    expect: 'U13',
  },
  {
    /*
     * 【十四】客户端不处理进房失败（页面永远停在「正在进入房间…」）。
     *
     * 这段处理**搬过家**：原来在对局页的 subscribe 回调里，
     * 现在在 socket 层（`useSocket`）—— 原因要跨页面活着（从私信卡片点进来时
     * 请求是大厅页发的，对局页是之后才挂上的），所以放全局状态。
     *
     * 改的是「**记不记**这条原因」，不是 `case 'error':` 那个标签 ——
     * 改标签会让 TS 的联合类型收窄失效（`msg.message` 就不是那个类型了），
     * **构建直接失败**，那条变异就变成了「什么都没测到」。
     */
    name: '【十四】客户端不处理进房失败（页面永远停在「正在进入房间…」）',
    file: 'src/hooks/useSocket.ts',
    from: `          this.setState({ joinError: { message: msg.message, code: msg.code } });`,
    to: `          // 变异：不记录进房失败的原因`,
    expect: 'U13',
  },
  {
    name: '【十五】错误卡片上没有「返回大厅」按钮',
    file: 'src/app/room/[code]/page.tsx',
    from: `            <p className="hint">原因：{joinError}</p>
            <button className="btn primary" onClick={backToLobby}>
              返回大厅
            </button>`,
    to: `            <p className="hint">原因：{joinError}</p>`,
    expect: 'U13',
  },
  {
    name: '【十二】音效开关不初始化音频上下文',
    file: 'src/components/SettingsDialog.tsx',
    from: `                    resumeAudio();
                    playSound('click', settings.soundVolume);`,
    to: `                    void 0;`,
    expect: 'U12',
  },

  /* ------------------------------------------------------------------ */
  /* 本轮：棋子风格 / 棋子材质                                          */
  /* ------------------------------------------------------------------ */
  {
    /*
     * 【十六】风格不接线 —— 设置面板切了风格，棋盘上的棋子却不变。
     *
     * 这是最典型的「设置项是摆设」故障：落盘了、UI 也变了，
     * 只有棋盘没跟着变。用户会以为设置坏了。
     */
    name: '【十六】棋子风格不接线（切了风格棋盘上的棋子不变）',
    file: 'src/components/Board2D.tsx',
    from: '                  style={pieceStyle}',
    to: "                  style={'classic'}",
    expect: 'U15',
  },
  {
    name: '【十七】棋子材质不接线（切了材质棋盘上的棋子不变）',
    file: 'src/components/Board2D.tsx',
    from: '                  material={pieceMaterial}',
    to: "                  material={'wood'}",
    expect: 'U16',
  },
  {
    /*
     * 【十八】外观设置不落盘 —— 切完刷新就没了。
     *
     * 注意这里改的是 **saveSettings**（写盘的地方），
     * 不是读盘的地方 —— 因为「读盘时回落默认值」这条兜底
     * 会把读盘也改坏的话，U17 会跟着红，两条门禁就分不清是谁的问题了。
     */
    name: '【十八】棋子外观设置不落盘（刷新就丢）',
    file: 'src/lib/settings.ts',
    from: '    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));',
    to: "    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, pieceStyle: 'classic' }));",
    expect: 'U15',
  },
  {
    /*
     * 【十九】条件 hook 崩溃 —— 把像素版改回「提前 return」。
     *
     * 这是本轮真实踩过的坑：从经典切到像素的那一刻，
     * React 抛 "Rendered fewer hooks than expected"，整棵棋盘消失。
     * 变异脚本要确认 **U15 会红**（形状签名取不到 → 判定失败）。
     */
    name: '【十九】像素版改回提前 return（切风格时整块棋盘崩掉）',
    file: 'src/components/PieceGlyph.tsx',
    from: `  const grainLines = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const x = 36 + i * 9;
      out.push(\`M\${x} 18 C\${x - 2.5} 40 \${x + 2.5} 62 \${x} 94\`);
    }
    return out;
  }, []);`,
    to: `  if (isPixel) {
    return (
      <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
        <ellipse cx="50" cy="93" rx="17" ry="3.4" fill={palette.shadow} />
        <PixelSprite grid={grid} palette={palette} />
      </svg>
    );
  }

  const grainLines = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const x = 36 + i * 9;
      out.push(\`M\${x} 18 C\${x - 2.5} 40 \${x + 2.5} 62 \${x} 94\`);
    }
    return out;
  }, []);`,
    expect: 'U15',
  },
  {
    /*
     * 【二十】材质层不裁剪 —— 高光/木纹直接画到棋盘上。
     *
     * 剪影判定（U18）守的就是这条链：材质层必须被 clipPath 裁回棋子轮廓。
     */
    name: '【二十】材质层不裁剪（高光画到棋盘格上）',
    file: 'src/components/PieceGlyph.tsx',
    from: '          <g clipPath={`url(#${clipId})`}>',
    to: '          <g>',
    expect: 'U18',
  },

  /* ------------------------------------------------------------------ */
  /* 本轮：棋谱从弹窗改成左栏常驻卡 + 局域网 http 下的复制兜底          */
  /* ------------------------------------------------------------------ */
  {
    /*
     * 【二十一】棋谱又变回弹窗 —— 记谱卡直接铺满整个视口。
     *
     * 复现的是用户拍板否掉的那个形态：棋谱盖在棋盘上（还压暗整页）。
     * 判据 U19 守的是「常驻左栏 + 不与棋盘相交 + 没有遮罩」。
     */
    name: '【二十一】棋谱又变回弹窗（记谱卡铺满视口、盖住棋盘）',
    file: 'src/app/globals.css',
    from: `.notation-card {
  display: flex;
  flex-direction: column;`,
    to: `.notation-card {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;`,
    expect: 'U19',
  },
  {
    /*
     * 【二十二】复制不再走兜底 —— 又直接调 navigator.clipboard。
     *
     * 这正是用户报的故障：局域网里跑的是 `http://192.168.x.x`，
     * **不是安全上下文**，那儿 `navigator.clipboard` 压根是 `undefined`，
     * 直接调必抛异常 → 「复制失败，请检查浏览器权限」。
     * 判据 U20 把那个环境复现出来（抹掉 navigator.clipboard），
     * 这条变异必须让 U20 变红。
     */
    name: '【二十二】复制 PGN 不走兜底（直接调 navigator.clipboard）',
    file: 'src/app/room/[code]/page.tsx',
    from: '    const ok = await copyText(pgn);',
    to: '    const ok = await navigator.clipboard.writeText(pgn).then(() => true, () => false);',
    expect: 'U20',
  },
  {
    /*
     * 【二十三】遮罩基座又被挪到变体后面 —— 「贴底」的浮层变回垂直居中。
     *
     * 同权重时**后写的赢**：基座 `.overlay` 的 `align-items: center`
     * 一旦写在 `.chat-overlay` / `.notation-overlay` 后面，
     * 变体的 `align-items: flex-end` 就被盖掉。
     * 判据 U8 的「浮层贴屏幕底部」守这条。
     */
    name: '【二十三】遮罩基座挪到变体后面（浮层不再贴底、变成垂直居中）',
    file: 'src/app/globals.css',
    from: `/* ---- 窄屏：底部弹层 ---- */
.notation-overlay {
  align-items: flex-end;
  padding-bottom: 72px;
}`,
    to: `/* ---- 窄屏：底部弹层 ---- */
.notation-overlay {
  align-items: flex-end;
  padding-bottom: 72px;
}

/* 变异：遮罩基座被挪到变体后面 → align-items: center 把「贴底」盖掉 */
.overlay {
  align-items: center;
}`,
    expect: 'U8',
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
 *
 * 原来写的是 `lsof -ti tcp:3000`，那会把**连着** 3000 的**客户端**也捞进来：
 * 门禁自己的 node 进程、Chromium 的 helper，甚至**用户正在用的浏览器**
 * （实测把 Arc 的 Browser Helper 一起捞出来了）。
 * 而这段的用途是 `kill -9` —— 于是门禁会把自己的进程、用户的浏览器一起杀掉。
 *
 * 后果实测：门禁进程被 SIGKILL（退出码 137）、Chromium 残留 30+ 个、
 * 用户开着的浏览器标签页被反复杀掉。
 */
function listeners(): string[] {
  const r = spawnSync(
    'bash',
    ['-c', `lsof -nP -iTCP:${APP_PORT} -sTCP:LISTEN -t 2>/dev/null | tr '\\n' ' '`],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

/** 重新构建并重启生产服务（等端口真的空出来再启，否则会打到旧服务上） */
function rebuild(): void {
  console.log('   · 重新构建…');
  const b = sh('npm', ['run', 'build']);
  if (b.code !== 0) {
    console.error(b.out.slice(-2000));
    throw new Error('构建失败（变异破坏了类型检查？）');
  }

  /*
   * build 之后**校验产物完整**。
   *
   * 为什么：Next 的 build 会先把 `.next` 清空再写。
   * 如果 build 过程中被打断（超时、被 kill、机器负载高），`.next` 会留下**半成品**，
   * 症状是「服务起不来」（报「没有生产构建」）——
   * 而真正的原因在**几分钟之前**，报错现场却指向「服务」。
   */
  if (!existsSync(join(ROOT, '.next/BUILD_ID'))) {
    console.error('   · 构建产物不完整（.next/BUILD_ID 缺失）—— build 很可能被中断了');
    throw new Error('构建产物不完整');
  }

  // 停旧服务，并**等端口真的空出来**
  for (let i = 0; i < 40; i += 1) {
    const pids = listeners();
    if (pids.length === 0) break;
    sh('bash', [
      '-c',
      `for p in ${pids.join(' ')}; do kill -9 "$p" 2>/dev/null; done; true`,
    ]);
    spawnSync('sleep', ['0.5']);
  }
  if (listeners().length !== 0) throw new Error('旧服务没停干净');

  spawnSync(
    'bash',
    [
      '-c',
      `mkdir -p ${MUTATE_DATA_DIR} && PORT=${APP_PORT} LAN_CHESS_DATA_DIR=${MUTATE_DATA_DIR} nohup npm start > /tmp/chess-server.log 2>&1 &`,
    ],
    {
      cwd: ROOT,
      stdio: 'ignore',
    },
  );

  // 等新服务起来
  for (let i = 0; i < 60; i += 1) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${APP_URL}/`], {
      encoding: 'utf8',
    });
    if ((r.stdout ?? '').trim() === '200' && listeners().length > 0) return;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error('服务重启后没有响应');
}

/* --dry：只检查目标串命中次数，不真的改文件（跑全量前先自查一遍） */
const DRY = process.argv.includes('--dry');
const FILTER =
  process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ??
  POSITIONAL[1] ??
  '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

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
  console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红）`);
  try {
    let mutated = original;
    for (const e of edits) mutated = mutated.replace(e.from, e.to);
    if (mutated === original) {
      console.error(`❌ 变异「${m.name}」改完之后文件没变（空变异）`);
      process.exit(1);
    }
    writeFileSync(path, mutated);
    try {
      rebuild();
    } catch (e) {
      // 构建失败 = 变异把类型检查搞崩了 —— 这条变异**不合格**（没测到门禁），
      // 但不能因此中断整轮：记一笔，继续跑下一条。
      console.error(`   ❌ 构建失败（变异破坏了类型检查）：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const r = sh('npx', ['tsx', 'scripts/verify-settings-ui.ts', APP_URL]);
    /*
     * 「这条门禁红了没」由 `scripts/lib/gate-match.ts` 判（那里有单测锁着规则）。
     *
     * 判定规则踩过两次坑，别再改松了：
     *   · 纯 `includes` → 「期望 U2」被「❌ U20 …」冒充成抓到（假绿）；
     *   · 纯词边界 `\bU9\b` → 「❌ U9b …」认不出来（假阴性）。
     */
    const gateRed = gateTurnedRed(r.out, m.expect);
    const nonzero = r.code !== 0;
    if (gateRed && nonzero) {
      caught += 1;
      console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.code}`);
    } else {
      console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.code}`);
      console.error(r.out.slice(-2500));
    }
  } finally {
    writeFileSync(path, original);
  }
}

// 恢复原状后重建一次，保证工作区和服务都是干净的
console.log('\n恢复原状并重建…');
rebuild();

console.log(`\n${'─'.repeat(56)}`);
if (caught === RUN.length) {
  console.log(`✅ 变异测试 ${caught}/${RUN.length} 全部抓到`);
} else {
  console.log(`❌ 变异测试只抓到 ${caught}/${RUN.length}`);
  process.exit(1);
}
