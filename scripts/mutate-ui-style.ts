/**
 * UI 视觉门禁（scripts/verify-ui-style.ts）的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、量错元素）时，「全绿」是假的 ——
 *   假绿比没有门禁更危险，人会开始忽略它。
 *   所以每条门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *   ❌ 行里必须带**门禁编号**（V1…V14）——
 *   所以 verify-ui-style.ts 里每条门禁的失败信息都带编号。
 *
 * 每个变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 三条自查（都踩过）：
 *   ① 变异必须是**替换**，不能是「插入一条会被后面同名声明覆盖的声明」——
 *      那样变异根本没生效，门禁红是假的、判成「没抓到」也是假的。
 *   ② 每个目标串必须**唯一命中**（命中 0 次 = 变异是空操作；命中 2 次 = 改错了地方）。
 *   ③ 跑完之后必须逐字节确认源码已还原。
 *
 * 用法：
 *   npx tsx scripts/mutate-ui-style.ts [http://127.0.0.1:3000] [变异名片段] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { UI_STYLE_GROUPS } from './lib/ui-style-groups';

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
  /**
   * 本条变异要跑哪几组门禁。
   *
   * **不给就自动取 `expect` 所属的组** —— 绝大多数情况不用写。
   * 写出来只为了「这条变异还会影响到别的组」的情况（例如它改的是共享样式）。
   *
   * 为什么要有它：原来每条变异都跑**全部门禁**（28s），实测单条变异 49s 里
   * 有 20s 是陪跑。分组之后只跑相关的组 → 单条降到 ~20s。
   */
  groups?: string[];
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

const CSS = 'src/app/globals.css';

const MUTATIONS: Mutation[] = [
  {
    /*
     * 大厅的下拉框已经从原生 `<select>` 换成自绘的 Picker 组件
     * （原生下拉的展开列表仍是系统绘制的，样式不受控）。
     * 于是这条变异从「把 appearance 改回 auto」换成等价的新形态：
     * **把自绘的选中标记去掉** —— 选中态就退回到「浏览器默认画的那一套」。
     */
    name: '【一】自绘下拉退回「没自绘」（选中项没有自己的勾选标记）',
    file: 'src/components/Picker.tsx',
    from:
      '{option.value === value && (\n                <Check className="picker-tick" size={14} aria-hidden="true" />\n              )}',
    to: '{false && (\n                <Check className="picker-tick" size={14} aria-hidden="true" />\n              )}',
    expect: 'V1',
  },
  {
    name: '【二】滑块退回浏览器原生外观',
    file: CSS,
    from: '.settings-range {\n  appearance: none;\n  -webkit-appearance: none;',
    to: '.settings-range {\n  appearance: auto;\n  -webkit-appearance: auto;',
    expect: 'V2',
  },
  {
    name: '【三】品牌图标又变回字符 ♞',
    file: 'src/app/page.tsx',
    from: '<Castle size={17} />',
    to: '♞',
    expect: 'V3',
  },
  {
    name: '【四】用手写裸 svg 顶替 lucide 组件',
    file: 'src/app/page.tsx',
    from: '<Castle size={17} />',
    to: '<svg width="17" height="17" viewBox="0 0 24 24"><path d="M3 3h18v18H3z" /></svg>',
    expect: 'V4',
  },
  {
    name: '【五】落子权竖条画成透明',
    file: CSS,
    from:
      ".player-row.turn::before {\n  content: '';\n  position: absolute;\n  left: -1px;\n  top: 6px;\n  bottom: 6px;\n  width: 3px;\n  border-radius: 0 3px 3px 0;\n  background: var(--accent);",
    to:
      ".player-row.turn::before {\n  content: '';\n  position: absolute;\n  left: -1px;\n  top: 6px;\n  bottom: 6px;\n  width: 3px;\n  border-radius: 0 3px 3px 0;\n  background: transparent;",
    expect: 'V5',
  },
  {
    name: '【六】落子权方块不再高亮',
    file: CSS,
    from: '.player-row.turn .piece-dot {\n  border-color: var(--accent);\n  background: var(--accent);',
    to: '.player-row.turn .piece-dot {\n  border-color: var(--accent);\n  background: var(--card);',
    expect: 'V6',
  },
  {
    name: '【七】键盘焦点环被去掉',
    file: CSS,
    from: ':focus-visible {\n  outline: 2px solid var(--accent);',
    to: ':focus-visible {\n  outline: none;',
    expect: 'V7',
  },
  {
    name: '【八】中屏断点失效（1000px 下还是两栏）',
    file: CSS,
    from:
      '@media (max-width: 1199px) {\n  .lobby-grid {\n    grid-template-columns: minmax(0, 1fr);\n  }\n}',
    to:
      '@media (max-width: 1199px) {\n  .lobby-grid {\n    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);\n  }\n}',
    expect: 'V8',
  },
  {
    /*
     * 【九】窄屏下四个开局方式写死列宽，横向溢出
     *
     * 原来的目标是 `.lobby-foot .tip`（大厅底部那块玩法说明）——
     * 那一整块解释性文字本轮已经被删掉了，所以换成**窄屏媒体查询**里的
     * `.mode-bar`：把它写死成两列 220px，390px 视口下必然溢出。
     *
     * 教训照旧：**变异必须真的溢出**。
     * 旧写法（minmax(200px) → minmax(400px)）实测抓不到 ——
     * 容器只有 332px 时，Chrome 会把 minmax(400px,1fr) 的轨道**夹到容器宽**，
     * 根本不产生溢出 —— 这种变异等于没测。
     */
    name: '【九】窄屏下开局方式写死列宽，横向溢出',
    file: CSS,
    from:
      '  .mode-bar {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }',
    to:
      '  .mode-bar {\n    grid-template-columns: repeat(2, 220px);\n  }',
    expect: 'V9',
  },
  {
    name: '【十】设置弹窗写死最小宽度，窄屏溢出',
    file: CSS,
    /*
     * 旧写法（width 改 460px、删掉 max-width）**实测抓不到**：
     * .overlay 是 display:flex，弹窗是 flex item，flex-shrink 会把它压回视口宽。
     * 要真的溢出必须用 min-width（flex item 的 min-width 默认是 auto，
     * 显式给 460px 才压不下去）。
     */
    from: '  width: min(460px, 92vw);\n  max-width: 100%;',
    to: '  width: min(460px, 92vw);\n  min-width: 460px;',
    expect: 'V10',
  },
  {
    name: '【十一】全局 toast 根本没挂载',
    file: 'src/app/layout.tsx',
    from: [
      "import { ToastHost } from '@/components/ToastHost';\n",
      '        <ToastHost />\n',
    ],
    to: ['', ''],
    expect: 'V11',
  },
  {
    name: '【十二】界面密度偏好写死不生效',
    file: 'src/lib/ui-prefs.ts',
    from: "    '--ui-density': String(prefs.density),",
    to: "    '--ui-density': '1',",
    expect: 'V12',
  },
  {
    name: '【十三】reduced-motion 降级被删掉',
    file: CSS,
    from: 'animation-duration: 0.001ms !important;',
    to: 'animation-duration: 1s !important;',
    expect: 'V13',
  },
  {
    name: '【十五】窄屏「快捷聊天 + 棋谱」那行压不下去，页面横向溢出',
    file: CSS,
    /*
     * 这一条是被**真事故**逼出来的：窄屏对局页里 `.rail-quick-row`
     * 少写了 min-width: 0 → flex 子项的 automatic minimum size 按内容算
     * → 这一行撑到 425px → 430px 视口下页面宽 513px。
     * V9 量的是大厅页，量不到对局页，所以补了 V9b。
     */
    from: ".rail-quick-row {\n  display: flex;\n  align-items: center;\n  gap: var(--sp-2);\n  /*\n   * min-width: 0 —— **必须写**。\n   *\n   * 这一行是 .col-chat（窄屏时是 flex row）的子项，里面是\n   * 「快捷聊天（自己横向滚的容器）」+「棋谱按钮（不参与压缩）」。\n   *\n   * flex 子项的默认 min-width 是 auto = **min-content 尺寸**，\n   * 不写 0 的话这一行就压不下去：它的 min-content 被快捷聊天的内容宽度撑住，\n   * 于是在 430px 手机上整行宽 425px → 页面被撑到 513px → **横向溢出**。\n   * （.rail-quick 自己虽然写了 min-width: 0，但那只管它自己；\n   *   父级这一行的 automatic minimum size 照样是按内容算的。）\n   */\n  min-width: 0;\n}",
    to: ".rail-quick-row {\n  display: flex;\n  align-items: center;\n  gap: var(--sp-2);\n  /*\n   * min-width: 0 —— **必须写**。\n   *\n   * 这一行是 .col-chat（窄屏时是 flex row）的子项，里面是\n   * 「快捷聊天（自己横向滚的容器）」+「棋谱按钮（不参与压缩）」。\n   *\n   * flex 子项的默认 min-width 是 auto = **min-content 尺寸**，\n   * 不写 0 的话这一行就压不下去：它的 min-content 被快捷聊天的内容宽度撑住，\n   * 于是在 430px 手机上整行宽 425px → 页面被撑到 513px → **横向溢出**。\n   * （.rail-quick 自己虽然写了 min-width: 0，但那只管它自己；\n   *   父级这一行的 automatic minimum size 照样是按内容算的。）\n   */\n}",
    expect: 'V9b',
  },
  {
    name: '【十四】图标按钮丢掉可访问名',
    file: 'src/app/room/[code]/page.tsx',
    from: '            title="设置"\n            aria-label="设置"\n',
    to: '',
    expect: 'V14',
  },
  {
    name: '【十六】聊天输入框又变回 258px 高（一堵墙）',
    file: CSS,
    /*
     * 真事故的复现：`.chat-strip` 在宽屏是**纵向** flex，
     * 而 `.chat-input-row` 写着 `flex: 0 1 258px` ——
     * `flex-basis` 跟着容器的**轴**走，258px 于是落到了**高度**上，
     * 输入框被撑到 258px 高（实测 223×258），比整块聊天记录区还高。
     *
     * 那条 258px 当初是给窄屏横排聊天带留的（那时 flex-basis 作用于宽度）。
     * 改版改了布局，同一个数字的轴就变了。
     */
    from: '.chat-strip .chat-input-row {\n  flex: 0 0 auto;',
    to: '.chat-strip .chat-input-row {\n  flex: 0 1 258px;',
    expect: 'V15',
  },
  {
    name: '【十七】聊天不再飘弹幕（只进聊天窗口）',
    file: 'src/app/room/[code]/page.tsx',
    /*
     * 规则是「所有聊天消息既进聊天窗口，又飘弹幕」。
     * 这一条拆掉「飘弹幕」那半边 —— 只留聊天窗口。
     */
    from: '          pushDanmaku(msg.message.name, msg.message.text);',
    to: '          // 变异：不再飘弹幕',
    expect: 'V16',
  },
  {
    name: '【十八】快捷聊天进了聊天记录（规则说只飘弹幕）',
    file: 'src/app/room/[code]/page.tsx',
    /*
     * 规则现在是「**快捷聊天只飘弹幕，不进聊天记录**」（用户要求：
     * 「快捷聊天不出现在聊天记录中」）。
     *
     * 判据在**客户端**：服务端广播的消息带 `quick` 标记，
     * 客户端只把**不带**标记的写进聊天记录。
     * 这一条拆掉那个判断 → 快捷聊天也进了记录 → V17 红。
     *
     * （这一条以前是拆服务端的「留底」，但服务端后来根本不写 room.chat 了 ——
     *  规则改成客户端按 `quick` 标记分流，变异目标随之换边。）
     */
    from: '          if (!msg.message.quick) {',
    to: '          if (msg.message) {',
    expect: 'V17',
  },
  {
    name: '【十九】战利品根本不显示（玩家行下方空着）',
    file: 'src/app/room/[code]/page.tsx',
    expect: 'V18',
    from: '        {captured.length > 0 && (',
    to: '        {false && (',
  },
  {
    name: '【二十】战利品归属反了（显示自己的子，不是吃掉的）',
    file: 'src/app/room/[code]/page.tsx',
    expect: 'V18',
    from: "    const capturedColor: 'w' | 'b' = color === 'w' ? 'b' : 'w';",
    to: "    const capturedColor: 'w' | 'b' = color;",
  },
  {
    name: '【二十一】窄屏棋盘可用高度估算偏大（棋盘被算成一条缝）',
    file: CSS,
    expect: 'V19',
    /*
     * **要动的是 CSS 里的 `--board-vh`，不是 JS 里的 `STACK_EXTRA_H`。**
     *
     * 探针 + 源码实测出来的结论：
     *   棋盘尺寸 = `.board-frame { width: min(100%, var(--board-vh)) }`，
     *   窄屏的 `--board-vh: calc(100vh - 294px)` → 500 − 294 = **206px**
     *   —— 与实测边长一字不差。
     *   而 JS 的 `STACK_EXTRA_H` 只参与 `wideW >= narrowW` 的**比较**
     *   （决定走宽屏还是窄屏），**根本不决定棋盘有多大**。
     *   所以前两次改 `STACK_EXTRA_H`（60 / 100 / 300）全都抓不到：
     *   棋盘还是 206px（300 那次只是把布局翻成宽屏 → 176px）。
     *
     * 现在把「可用高度估算」改大：294 → 450 → 窄屏下
     * `calc(100vh - 450px)` = 50px → 棋盘被算成 **50px 的一条缝**。
     * V19 直接量 `.board-frame` 的边长 → 硬判据，必然变红。
     *
     * 顺带记下两条实测结论（别再走回头路）：
     *   ① `.page` 是 **100vh 固定高度**，800×500 下舞台底边在 393px、
     *      离视口底还有 87px 余量 → 「页面出不出滚动条」**不是硬判据**；
     *   ② 800×500 下棋盘边长有**下界 176px**（= 列宽），
     *      「棋盘 ≥ 120px」那个判据在该视口下**恒真**，抓不到东西。
     * → 能同时抓住两个方向的，是**对账式判据**：
     *   棋盘边长应当等于「视口高 − 可用高度估算」= 206px。
     */
    from: '  --board-vh: calc(100vh - 294px);',
    to: '  --board-vh: calc(100vh - 450px);',
  },
  {
    name: '【二十四】JS 布局估算与 CSS 对不上（窄屏误判成宽屏）',
    file: 'src/app/room/[code]/page.tsx',
    expect: 'V19',
    /*
     * 守住**另一半**估算：JS 的 `STACK_EXTRA_H` 决定走宽屏还是窄屏
     * （`wideW >= narrowW`），CSS 的 `--board-vh` 决定棋盘到底多大。
     *
     * 这两个是**同一个量的两份估算**（HUD + 间距 + 聊天块的高度）——
     * 改一个忘了另一个，就会出现「JS 以为是宽屏、CSS 以为是窄屏」的错位。
     *
     * 154 → 300：估算剩余高度被扣到 60px（< 列宽 176px）→
     * `wideW(176) >= narrowW(60)` 成立 → **800×500 下误判成宽屏布局** →
     * 棋盘变成列宽 176px，而正确值应该是 206px → V19 的**对账判据**红。
     *
     * 这条守的是「模式选错」，【二十一】守的是「尺寸算错」——
     * 两个失效方向各一条，缺一条就有一半是盲区。
     */
    from: 'const STACK_EXTRA_H = 154;',
    to: 'const STACK_EXTRA_H = 300;',
  },
  {
    name: '【二十二】toast 不跨页清（大厅页的报错飘进对局页）',
    file: 'src/components/ToastHost.tsx',
    expect: 'V21',
    /*
     * toast 挂在**根布局**、状态在**模块级单例**里 ——
     * 不在换页时收掉，大厅页的报错就一路跟到对局页右上角，
     * 正好压在棋盘上方（老截图右上角那道红字就是它）。
     */
    from: '  const pathname = usePathname();\n  useEffect(() => {\n    clearToasts();\n  }, [pathname, clearToasts]);',
    to: '  const pathname = usePathname();\n  useEffect(() => {\n    // 变异：不再跨页清空 toast\n  }, [pathname, clearToasts]);',
  },
  {
    name: '【二十三】房间码校验错误又跑回全局 toast',
    file: 'src/app/page.tsx',
    expect: 'V20',
    /*
     * 校验错误常驻在字段旁边（`.field-error`）——
     * 变回 toast 就等于没改：飘走的提示 + 跨页残留。
     */
    from: "      setRoomCodeError('房间码为 4 位字符');",
    to: "      setRoomCodeError(null);\n      pushToast('error', '房间码为 4 位字符');",
  },
  {
    name: '【二十五】设置弹窗的底部渐隐层整个被删掉',
    file: CSS,
    expect: 'V22',
    /*
     * 渐隐层没了 → 内容超出面板时就是**硬切**：最后一行直接顶在面板下边缘，
     * 看着像被裁坏了（用户原话：「特别是下面」）。
     *
     * 注意 `content: ''` 在这个文件里出现 3 次，所以目标串带上选择器，
     * 保证唯一命中。
     */
    from: ".settings-panel::after {\n  content: '';",
    to: ".settings-panel::after {\n  content: none;",
  },
  {
    name: '【二十六】底部渐隐层写成全透明（看着在，其实什么都不挡）',
    file: CSS,
    expect: 'V23',
    /*
     * 渐变还在、高度也对、方向也对 —— 但**两端都是透明**，
     * 于是它一个像素都挡不住，等于没有渐隐。
     *
     * 这条专门打 **V23**（像素差分）：光看 CSSOM 全是对，
     * 只有把渐隐层关掉再比一次像素，才知道它到底挡没挡东西。
     */
    from: '  background: linear-gradient(to bottom, transparent, var(--bg-panel));',
    to: '  background: linear-gradient(to bottom, transparent, transparent);',
  },
];

const sh = (cmd: string, args: string[]): { code: number; out: string } => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/**
 * **端口从 `--url` 里取，不写死 3000。**
 *
 * 写死 3000 有两个后果：
 *   ① 会 `kill -9` 掉**用户自己起在 3000 上的服务**（可能正开着一局棋）；
 *   ② `--url=` 指到别的端口时，脚本却仍然去重启 3000 ——
 *      门禁跑的是**旧服务**，红的是别的门禁，结论直接作废。
 *
 * 端口跟着 `--url` 走，工具就只碰自己该碰的那个端口。
 */
const PORT = (() => {
  try {
    return new URL(APP_URL).port || '3000';
  } catch {
    return '3000';
  }
})();

/**
 * **构建目录**：默认 `.next`，可以用 `NEXT_DIST_DIR` 隔离。
 *
 * 为什么重要：`next build` 一开始会**清空**目标目录。
 * 隔离到 `.next-gate` 之后，变异测试就不会把用户 `npm start` 用的
 * 生产构建冲掉（服务重启时直接报「找不到生产构建」）。
 */
const DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next';

/**
 * 当前**监听**目标端口的 PID 列表。
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
    ['-c', `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null | tr '\\n' ' '`],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 停掉监听目标端口的服务，并**等端口真的空出来**。
 */
function stopServer(): void {
  for (let i = 0; i < 40; i += 1) {
    const pids = listeners();
    if (pids.length === 0) return;
    sh('bash', [
      '-c',
      `for p in ${pids.join(' ')}; do kill -9 "$p" 2>/dev/null; done; true`,
    ]);
    spawnSync('sleep', ['0.5']);
  }
  if (listeners().length !== 0) throw new Error('旧服务没停干净');
}

/**
 * 起新服务，并确认**监听目标端口的是新起的那个**。
 *
 * 为什么不能只看 `curl 200`：如果新服务起不来（端口还没释放之类），
 * curl 会打到**旧服务**上 —— 门禁跑的是上一条变异的产物，
 * 结论直接作废，而且症状特别隐蔽（红的是**别的**门禁）。
 */
function startServer(before: Set<string>): void {
  spawnSync(
    'bash',
    ['-c', `PORT=${PORT} NEXT_DIST_DIR=${DIST_DIR} nohup npm start > /tmp/chess-server.log 2>&1 &`],
    {
      cwd: ROOT,
      stdio: 'ignore',
    },
  );

  for (let i = 0; i < 60; i += 1) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${APP_URL}/`], {
      encoding: 'utf8',
    });
    const now = listeners();
    const isNew = now.length > 0 && now.every((p) => !before.has(p));
    if ((r.stdout ?? '').trim() === '200' && isNew) return;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error('服务重启后没有响应');
}

/**
 * 重新构建并重启生产服务。
 *
 * **顺序必须是「停服务 → build → 起服务」**，不能反过来。
 *
 * 为什么（实测踩出来的）：`next build` 一开始会**清空 `.next`**，
 * 而运行中的生产服务器（`next({ dev: false })` 程序化 API）正在读写同一个目录。
 * 两边撞上的结果有两种，都很难查：
 *   ① build 自己报 `ENOENT: .next/server/pages-manifest.json`
 *      / `.nft.json` —— 报错指向 build，真凶是**服务器进程**；
 *   ② 服务器读到被清空的 `.next` 直接崩掉，端口空着，
 *      后面起服务时又冒出别的问题。
 *
 * 实测：服务运行中连跑 4 次 build，第 1 次就 ENOENT 挂掉，
 * 后面 3 次（服务已经死了、没人抢 `.next`）全部成功。
 */
function rebuild(): void {
  console.log('   · 停服务 → 构建 → 起服务…');

  /*
   * 「工作区有没有被别人改过」的检查**不在这里做**。
   *
   * 原先放在 build 之前，但调用顺序是「先写盘写变异 → 再 build」——
   * 于是**脚本自己写的那份变异**必然被当成「别人改过」，每条变异都直接报错退出。
   * 现在挪到循环里「写盘之前」：那时文件还是原样，检查才有意义
   * （而且正好能覆盖 build 期间被改的情况 —— 下一条变异开始前会发现）。
   */

  // ① 先停旧服务（build 期间不能有服务器在读写 .next）
  const before = new Set(listeners());
  stopServer();

  // ② 再构建
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
  if (!existsSync(join(ROOT, DIST_DIR, 'BUILD_ID'))) {
    console.error(`   · 构建产物不完整（${DIST_DIR}/BUILD_ID 缺失）—— build 很可能被中断了`);
    throw new Error('构建产物不完整');
  }

  // ③ 起新服务（确认监听目标端口的是新进程，不是残留的旧服务）
  startServer(before);
}

/* ------------------------------------------------------------------ */
/* 互斥锁：同一工作区只允许一份变异脚本在跑                             */
/* ------------------------------------------------------------------ */

/**
 * 为什么要锁：
 *
 * 变异脚本会 **改源码 → 跑门禁 → 还原源码**，还要 **`next build`**。
 * 两份并发时后果很实在：
 *   - A 把 `<ToastHost />` 删成变异态 → B 把这个状态读成自己的「原始版本」
 *     → B 结束时还原回去 → **功能被永久吃掉**（实测真的发生过）；
 *   - 两边同时 build，互相清 `.next` → `ENOENT: build-manifest.json`；
 *   - 两边同时改同一份 globals.css → 还原出「对方的变异态」→ 源码停在脏状态。
 *
 * 而且 **`task_stop` 不保证整个进程组死透**（实测：cancel 之后 tsx 主进程
 * 又活了十几分钟，把 globals.css 改成了变异态）。
 * 所以不能靠「我记得只有一个在跑」，要靠锁。
 */
const LOCK_FILE = join(ROOT, 'node_modules/.cache/chess-mutate.lock');

function lockHeld(): boolean {
  try {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    // 进程还在吗（信号 0 只做存在性检查）
    process.kill(pid, 0);
    return true;
  } catch {
    // 文件不存在，或进程已死（ESRCH）→ 锁可接管
    return false;
  }
}

function acquireLock(): void {
  if (lockHeld()) {
    throw new Error(
      '同一工作区已经有一份变异脚本在跑（锁文件：' +
        LOCK_FILE +
        '）。并发会互相改写源码 —— 先确认那个进程真的停了再重跑。',
    );
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
 * 为什么 PID 锁不够：锁只能防「另一份变异脚本」，
 * 防不住「另一个 agent / 另一个会话正在编辑源码」。
 * 实测踩过：主对话在 17:25 改 `verify-ui-style.ts`，
 * 正好撞上本脚本 `next build` 的类型检查阶段 ——
 * build 读到改动到一半的文件，报出一个当时存在、下一分钟就不存在的错。
 *
 * 做法：启动时记下**所有变异目标文件**的指纹（mtime + 大小），
 * 每次 build 前比对。有人动过就**直接退出**，不接着跑 ——
 * 在别人正在改的树上跑变异，结论既不可信又会把人家的改动还原掉。
 */
const WORKSPACE_FINGERPRINT = new Map<string, string>();

/**
 * 指纹 = **内容哈希**（不是 mtime + size）。
 *
 * 为什么不用 mtime：脚本每跑完一条变异都会把文件**还原**回去，
 * 还原 = 重新写盘 = **mtime 变了**（内容其实一模一样）。
 * 于是「下一条变异开始前」的自查会把自己上一条还��当成「别人改过」，
 * 每轮都只能跑第一条。
 *
 * 内容哈希对「自己还原」免疫（内容相同 → 哈希相同），
 * 对「别人真的改了内容」照常报警。
 */
function fileFingerprint(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
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
    // 空变异自查：替换后文件必须真的变了
    if (ok && probe === src) {
      bad += 1;
      console.error(`❌ 变异「${m.name}」是空变异（替换后内容没变）`);
      ok = false;
    }
    if (ok) console.log(`✅ 命中 1 次：${m.name}`);
  }
  console.log(`\n${DRY ? '（dry-run，未改任何文件）' : ''} 共 ${RUN.length} 条变异，${bad} 条目标串不对`);
  process.exit(bad === 0 ? 0 : 1);
}

// 真跑之前先拿锁（--dry 不改文件，不需要）
acquireLock();
process.on('exit', releaseLock);

// 记下工作区指纹（之后每次 build 前比对）
snapshotWorkspace();

let caught = 0;
const missed: string[] = [];
/** 门禁编号 → 哪几条变异把它打红过（跑完出覆盖报告用） */
const redByGate = new Map<string, string[]>();

/**
 * 这条变异要跑哪几组门禁。
 *
 * 默认取 `expect` 所属的组；变异显式写了 `groups` 就用它。
 * 写出来的值必须**包含** `expect` 所属的组 —— 否则这条变异永远抓不到
 * （自检会拦）。
 */
function groupsFor(m: Mutation): string[] {
  const expectGroups = groupsOfGate(UI_STYLE_GROUPS, m.expect);
  const gs = m.groups ?? expectGroups;
  if (gs.length === 0) {
    throw new Error(
      `变异「${m.name}」期望的门禁「${m.expect}」不属于任何组 —— ` +
        `请把它加进 ${Object.keys(UI_STYLE_GROUPS).join(' / ')} 里的某一组。`,
    );
  }
  return gs;
}

/**
 * 从门禁输出里提取**实际变红的门禁编号**。
 *
 * 只看 `❌` 开头、且后面紧跟门禁编号的行 —— 脚本自身的报错
 * （`❌ 门禁脚本自身崩溃` / `❌ UI 视觉门禁失败`）没有编号，不会被误认。
 */
function extractRedGateIds(out: string): string[] {
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.includes('❌')) continue;
    const m = line.match(/❌\s*([A-Z]{1,2}\d+[a-z]?)\b/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

for (const m of RUN) {
  const groups = groupsFor(m);
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
  // 空变异自查
  if (probe === original) {
    console.error(`❌ 变异「${m.name}」是空变异（替换后内容没变）`);
    process.exit(1);
  }

  console.log(`\n▶ 变异：${m.name}（期望 ${m.expect} 变红，跑 ${groups.join('、')} 组）`);
  /*
   * 写盘**之前**确认工作区没被别人动过 ——
   * 放在这里才有效：脚本自己写的那份变异不能算成「别人的改动」。
   */
  assertWorkspaceUnchanged();
  try {
    let mutated = original;
    for (const e of edits) mutated = mutated.replace(e.from, e.to);
    writeFileSync(path, mutated);
    // 再确认一次：磁盘上的文件确实变了（防「以为写进去了其实没写」）
    if (readFileSync(path, 'utf8') !== mutated) {
      throw new Error('写盘后读回来的内容不对');
    }
    /*
     * 构建失败 → **终止整轮**，不要「记一笔继续下一条」。
     *
     * 为什么：build 失败意味着工作区已经不可信（`.next` 可能是半成品、
     * 服务可能还停在旧产物上）。继续跑下去，剩下的结论全都不可信 ——
     * 比「早停」糟得多。
     *
     * （原来的写法是 catch 住记一笔继续，结果后面几条全在脏环境里跑，
     *  出现了「红的是别的门禁」的假阴性。）
     */
    rebuild();
    /*
     * **只跑相关的组**，不跑全部门禁。
     *
     * 原来每条变异都跑全部 23 条（28s），实测单条变异 49s 里**有 20s 是陪跑** ——
     * 每条变异只期望 1 条红，其余 22 条与它无关。
     * 分组之后单条降到 ~20s，全量 24 条从 1 小时掉到 ~10 分钟。
     */
    const r = sh('npx', [
      'tsx',
      'scripts/verify-ui-style.ts',
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
      const extra = redGates.filter((g) => g !== m.expect);
      console.log(
        `   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.code}` +
          (extra.length ? `（顺带打红：${extra.join('、')}）` : ''),
      );
    } else {
      console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.code}`);
      console.error(r.out.slice(-2500));
      missed.push(m.name);
    }
  } finally {
    // **逐字节还原**：跑完必须确认源码回到了原样，
    // 否则下一条变异会在脏源码上跑，结论全不可信。
    writeFileSync(path, original);
    const now = readFileSync(path, 'utf8');
    if (now !== original) {
      console.error(`❌ 严重：${m.file} 没能还原！请立刻检查工作区。`);
      process.exit(1);
    }
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
  for (const n of missed) console.log(`   · 没抓到：${n}`);
  process.exit(1);
}

/* ==================================================================== */
/* 覆盖报告 + 组覆盖自检（这就是「按组强制」这条规矩的执行点）        */
/* ==================================================================== */
{
  /*
   * 自检用**全量变异表**，不是本次跑的子集 ——
   * `--filter` 单跑一条时，其他组当然「没有变异跑过」，
   * 但那是**没跑到**，不是**没守着**。守不守得住是表本身的事。
   */
  const mutationMeta = MUTATIONS.map((m) => ({ id: m.name, expect: m.expect }));
  const mutationGroups = new Map<string, string[]>(
    MUTATIONS.map((m) => [m.name, groupsFor(m)] as [string, string[]]),
  );

  /*
   * **硬自检**：每个组（机制）至少有一条变异守着，且那条变异的期望门禁属于该组。
   * 不满足 → 退出码非 0 —— 这一组的门禁是「没人验证过它会不会红」的。
   */
  const problems = checkGroupCoverage(UI_STYLE_GROUPS, mutationMeta, mutationGroups);
  if (problems.length > 0) {
    console.error('\n❌ 组覆盖自检不通过：');
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }

  console.log('\n📋 门禁覆盖报告');
  for (const [group, ids] of Object.entries(UI_STYLE_GROUPS)) {
    const guards = MUTATIONS.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
    console.log(`   ✅ ${group.padEnd(9)} ${ids.join('、')} —— ${guards.length} 条变异守着`);
  }

  /*
   * **软提示**：某条门禁从没被任何变异打红过。
   *
   * 这不一定是什么都不对（按组强制，不是按门禁强制），
   * 但它值得看一眼：要么它对应的机制没人破坏过，要么**它是个摆设**。
   *
   * 只跑子集时（`--filter`）这个提示会**大面积误报** —— 那条门禁只是这次没被跑到。
   * 所以这种情况下只说明「本次跑了多少条」，不列具体编号。
   */
  const neverRed = allGateIds(UI_STYLE_GROUPS).filter((id) => !redByGate.has(id));
  if (RUN.length < MUTATIONS.length) {
    console.log(`\nℹ️  本次只跑了 ${RUN.length}/${MUTATIONS.length} 条变异，覆盖报告里的「打红」结论不完整。`);
  } else if (neverRed.length > 0) {
    console.log(`\n⚠️  从没被任何变异打红过的门禁：${neverRed.join('、')}`);
    console.log('   （按组强制，不按门禁强制 —— 这几条门禁的失效方式目前没人验证）');
  }
}
