/**
 * 走子箭头门禁的变异测试 —— 把实现改回 bug，确认门禁真的会红。
 *
 * 为什么必须做：
 *   门禁自己出 bug（恒真、判据写错、匹配到别的行）时，
 *   「全绿」是假的 —— 这类假绿比没有门禁更危险，人会开始忽略它。
 *   所以每个门禁都要被**故意打坏一次**，确认它真的会红。
 *
 * 判定方式（按项目规矩）：
 *   看**进程退出码** + 门禁自己打印的 ❌ 行 —— 两者都对才算抓到。
 *   不 grep 测试框架的文本标记（换框架就失效）。
 *
 * 每个变异都要重新构建 + 重启服务，门禁跑的是生产构建 —— 慢，但真。
 *
 * 踩过的坑（别再踩）：
 *   ① **重启有竞态**：kill 之后旧进程不会立刻消失，紧接着 curl 可能
 *      打到**旧服务**上 —— 于是「变异没生效」看起来像「门禁没抓到」。
 *      现在的做法是：等端口**真的空出来**再启动，启动后确认监听 PID 变了。
 *   ② **变异可能是个空操作**：把 2D 箭头的 x 起点换掉，对**竖直**的一步
 *      完全没有影响 —— 门禁当然抓不到。现在改成「箭头整体掉头」，
 *      并且 G1 门禁补上了**方向**判定（终点有棋子、起点是空格）。
 *
 * **它会自己重建 + 重启服务** —— 所以**端口、构建目录、存档目录必须隔离**：
 * 端口从 `--url=` 推出来（绝不写死 3000，否则会 kill 掉用户的服务），
 * 构建目录用 `.next-gate-arrow`（`NEXT_DIST_DIR`），
 * 存档目录用 `/tmp/chess-gate-arrow-data`（`LAN_CHESS_DATA_DIR`）。
 *
 * 用法：
 *   npx tsx scripts/mutate-move-arrow.ts [--url=http://127.0.0.1:41777] [--filter=变异名片段]
 *   npx tsx scripts/mutate-move-arrow.ts [--from=N --to=M]   （按序号分批跑）
 *   npx tsx scripts/mutate-move-arrow.ts --dry [--from=N --to=M]  （只查目标串命中，不改文件）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allGateIds, checkGroupCoverage, groupsOfGate } from './lib/gate-groups';
import { ARROW_GROUPS } from './lib/arrow-groups';

const ROOT = process.cwd();

/*
 * 参数解析：**URL 和过滤词都不能靠「位置」猜**。
 *
 * 为什么：早先这里写的是 `process.argv[2] ?? 默认值`，于是
 * `npx tsx scripts/mutate-move-arrow.ts --from=1 --to=10` 里的
 * `--from=1` 被当成了 APP_URL —— curl 去请求 `--from=1/` 永远拿不到 200，
 * rebuild() 于是判定「服务没起来」，重试 3 次全失败后抛错，
 * 而服务端其实一直是好的（日志里 banner 都打出来了）。
 * 这种「参数被误当地址」的 bug 极难一眼看出，因为错误信息指向的是「服务」，
 * 实际坏的是「命令行」。
 *
 * 现在改成显式参数：
 *   --url=http://127.0.0.1:3000   覆盖服务地址
 *   --filter=某某                 只跑名字里含该片段的变异
 * 位置参数仍然支持（第一个非 -- 开头的参数当 URL，第二个当过滤词），
 * 但 URL 长得不像 http 时**直接报错退出**，不再静默地去请求一个非法地址。
 */
const ARG_URL = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const POSITIONAL = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APP_URL = ARG_URL ?? POSITIONAL[0] ?? 'http://127.0.0.1:3000';
if (!/^https?:\/\//.test(APP_URL)) {
  console.error(`❌ APP_URL 不合法：「${APP_URL}」`);
  console.error('   用法：--url=http://127.0.0.1:3000 [--filter=片段] [--from=N --to=M]');
  process.exit(1);
}

/*
 * **三样东西必须隔离** —— 这个脚本会 build、起服务、造房间：
 *
 * | 东西        | 隔离成什么              | 不隔离会怎样                              |
 * |-------------|-------------------------|-------------------------------------------|
 * | 端口        | `--url=` 里的端口        | `kill -9` 掉用户 `npm start` 的服务      |
 * | 构建目录    | `.next-gate-arrow`       | build 清空 `.next`，用户的生产构建被清掉 |
 * | 存档目录    | `/tmp/chess-gate-arrow`  | 门禁造的房间/会话落进用户的真实存档       |
 *
 * 三个都可以用环境变量覆盖（并行开发时各用各的）。
 */
const PORT = Number(new URL(APP_URL).port || 3000);
const DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next-gate-arrow';
const DATA_DIR = process.env.LAN_CHESS_DATA_DIR ?? join(tmpdir(), 'chess-gate-arrow-data');

interface Mutation {
  /** 变异名 */
  name: string;
  /** 要改的文件（相对项目根） */
  file: string;
  /**
   * 原文（必须唯一命中）。
   * 给**数组**时表示「一次改多处」—— 用在「一个性质由多道网共同保证」的地方：
   * 只拆一道，另一道照样兜住 → 门禁假绿（踩过一次）。
   */
  from: string | string[];
  /** 改成的文字；数组时与 from 一一对应 */
  to: string | string[];
  /** 门禁类型：browser = 跑 verify-move-arrow；unit = 跑 vitest 单测 */
  kind: 'browser' | 'unit';
  /** browser：预期变红的门禁编号；unit：预期变红的测试文件 */
  expect: string;
  /**
   * 本条变异要跑哪几个门禁组。
   *
   * **默认从 `expect` 反查** —— 期望变红的是 G25b，它就属于「悔棋」那组。
   * 显式写这个字段只在一种情况下必要：这条变异**同时**影响多个组
   * （比如改了一个公共组件，好几组的门禁都会红）。
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

const MUTATIONS: Mutation[] = [
  {
    name: '3D 箭头缩成一条线（细到读不出来）',
    file: 'src/lib/moveArrow.ts',
    from: `export const ARROW_3D: ArrowOptions = {
  shaftHalfWidth: 0.14,
  headLength: 0.38,
  headHalfWidth: 0.3,
  tipInset: 0.3,
};`,
    to: `export const ARROW_3D: ArrowOptions = {
  shaftHalfWidth: 0.004,
  headLength: 0.004,
  headHalfWidth: 0.004,
  tipInset: 0.3,
};`,
    kind: 'browser',
    expect: 'G5',
  },
  {
    name: '3D 箭头整个隐藏（visible=false）',
    file: 'src/components/Board3D.tsx',
    from: '<mesh geometry={geometry} position={[0, ARROW_Y, 0]} renderOrder={2}>',
    to: '<mesh visible={false} geometry={geometry} position={[0, ARROW_Y, 0]} renderOrder={2}>',
    kind: 'browser',
    expect: 'G5',
  },
  {
    name: '2D 箭头掉头（指向反了）',
    file: 'src/components/Board2D.tsx',
    from: `    const poly = arrowPolygon(
      {
        x: displayCol(lastMove.from, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.from, effectiveOrientation) + 0.5,
      },
      {
        x: displayCol(lastMove.to, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.to, effectiveOrientation) + 0.5,
      },
      ARROW_2D,
    );`,
    to: `    const poly = arrowPolygon(
      {
        x: displayCol(lastMove.to, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.to, effectiveOrientation) + 0.5,
      },
      {
        x: displayCol(lastMove.from, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.from, effectiveOrientation) + 0.5,
      },
      ARROW_2D,
    );`,
    kind: 'browser',
    expect: 'G1',
  },
  {
    name: '弹幕 z-index 提到 HUD 之上（弹幕压住按钮）',
    file: 'src/app/globals.css',
    from: '  z-index: 12;\n  pointer-events: none;',
    to: '  z-index: 40;\n  pointer-events: none;',
    kind: 'browser',
    expect: 'G2',
  },
  {
    name: '布局判定永远走窄屏（宽屏也不左右分列）',
    file: 'src/app/room/[code]/page.tsx',
    from: "  return wideW >= narrowW ? 'wide' : 'narrow';",
    to: "  return 'narrow';",
    kind: 'browser',
    expect: 'G3',
  },
  {
    name: '正方形视口也走宽屏（左右分列）',
    file: 'src/app/room/[code]/page.tsx',
    from: "  if (viewW <= viewH) return 'narrow';",
    to: "  if (viewW <= viewH) return 'wide';",
    kind: 'browser',
    expect: 'G12',
  },
  {
    name: 'HUD 改回「自动淡出」（不再是常驻）',
    file: 'src/app/room/[code]/page.tsx',
    from: '<div className="hud">',
    to: '<div className="hud hud-hidden">',
    kind: 'browser',
    expect: 'G8',
  },
  {
    name: '消息条被藏起来（不再是常驻）',
    file: 'src/app/globals.css',
    from: '.chat-strip {\n  position: relative;\n  z-index: 20;\n  display: flex;',
    to: '.chat-strip {\n  position: relative;\n  z-index: 20;\n  display: none;',
    kind: 'browser',
    expect: 'G9',
  },
  {
    name: '3D 箭尖退到 0.95 格（箭头停不到终点）',
    file: 'src/lib/moveArrow.ts',
    from: '  tipInset: 0.3,\n};',
    to: '  tipInset: 0.95,\n};',
    kind: 'unit',
    expect: 'tests/move-arrow.test.ts',
  },
  {
    name: 'HUD 的投影重新盖回棋盘顶部（窄屏时糊在棋盘上沿）',
    file: 'src/app/globals.css',
    // 必须**替换** `.hud` 规则末尾那句 `box-shadow: none` ——
    // 往规则前面**插入**一条 `box-shadow` 会被同规则后面那句 none 覆盖掉，
    // 整个变异变成空操作，门禁当然抓不到（踩过一次）。
    from: '  box-shadow: none;\n}\n\n/* 宽屏：HUD 竖排，占满左列 */',
    to: '  box-shadow: var(--shadow);\n}\n\n/* 宽屏：HUD 竖排，占满左列 */',
    kind: 'browser',
    expect: 'G11',
  },
  {
    name: '窄屏时棋盘不再缩小（上下两块的空间被吃掉）',
    file: 'src/app/globals.css',
    from: '  --board-vh: calc(100vh - 294px);',
    to: '  --board-vh: calc(100vh - 140px);',
    kind: 'browser',
    expect: 'G13',
  },
  /* ---------- 聊天区改成「一行 + 弹窗 + 角标」之后新增的变异 ---------- */
  {
    name: '窄屏聊天记录又常驻了（记录区/输入框/发送按钮全挤回那一行）',
    file: 'src/app/globals.css',
    from: '.layout-narrow .chat-strip {\n  display: none;\n}',
    to: '.layout-narrow .chat-strip {\n  display: flex;\n}',
    kind: 'browser',
    expect: 'G15',
  },
  {
    name: '窄屏快捷聊天换行了（430px 上变成两行，不是一行）',
    file: 'src/app/globals.css',
    from: '.layout-narrow .rail-quick {\n  flex: 1 1 auto;\n  min-width: 0;\n  flex-direction: row;\n  flex-wrap: nowrap;',
    to: '.layout-narrow .rail-quick {\n  flex: 1 1 auto;\n  min-width: 0;\n  flex-direction: row;\n  flex-wrap: wrap;',
    kind: 'browser',
    expect: 'G19',
  },
  {
    name: '点「聊天」不弹框了（窄屏根本看不到聊天记录）',
    file: 'src/app/room/[code]/page.tsx',
    from: 'if (isNarrow) setChatOpen(true);',
    to: 'if (isNarrow) chatInputRef.current?.focus();',
    kind: 'browser',
    expect: 'G16',
  },
  {
    name: '消息退回「单行 + 省略号」（长消息又被截断）',
    file: 'src/app/globals.css',
    from: '.chat-log .msg {\n  white-space: normal;\n  overflow-wrap: anywhere;\n}',
    to: '.chat-log .msg {\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}',
    kind: 'browser',
    expect: 'G18',
  },
  {
    name: '窄屏快捷聊天不横向滚动（放不下就溢出，按钮被裁掉）',
    file: 'src/app/globals.css',
    // overflow-y 必须**一起**改：只把 overflow-x 改成 visible 的话，
    // 按 CSS 规范「另一个轴不是 visible → 这个轴的 visible 会被算成 auto」，
    // 计算样式根本不变，这条变异就成了**空操作**（踩过一次）。
    from: '.layout-narrow .rail-quick {\n  flex: 1 1 auto;\n  min-width: 0;\n  flex-direction: row;\n  flex-wrap: nowrap;\n  justify-content: flex-start;\n  overflow-x: auto;\n  overflow-y: hidden;',
    to: '.layout-narrow .rail-quick {\n  flex: 1 1 auto;\n  min-width: 0;\n  flex-direction: row;\n  flex-wrap: nowrap;\n  justify-content: flex-start;\n  overflow-x: visible;\n  overflow-y: visible;',
    kind: 'browser',
    expect: 'G19',
  },
  {
    name: '窄屏判定没同步到 ref（对方发来消息也不出角标）',
    file: 'src/app/room/[code]/page.tsx',
    from: '    isNarrowRef.current = isNarrow;',
    to: '    isNarrowRef.current = false;',
    kind: 'browser',
    expect: 'G20',
  },
  {
    name: '打开弹层后角标不清零（看过了还挂着未读）',
    file: 'src/app/room/[code]/page.tsx',
    from: '    setChatUnread(0);',
    to: '    setChatUnread((n) => n);',
    kind: 'browser',
    expect: 'G20b',
  },
  {
    name: '聊天框没有「收起」按钮（点不掉）',
    file: 'src/app/room/[code]/page.tsx',
    from: `<button className="btn small ghost" onClick={() => setChatOpen(false)}>
                  收起
                </button>`,
    to: `<span className="chat-panel-hint">收起</span>`,
    kind: 'browser',
    expect: 'G16',
  },
  /* ---------- 阶段十一：求和 / 悔棋 / 认输 / 滚动条 ---------- */
  {
    name: '【十一】右列不封顶（页面又被顶出滚动条）',
    file: 'src/app/globals.css',
    /*
     * 页面不被顶出滚动条**全靠这一道闸门**：`.col-chat` 的 `max-height: var(--board-vh)`。
     *
     * 早先这里还有「两道网」（`.chat-log` 的 `max-height: 525px` + `.col-chat` 的上限），
     * 变异必须一次拆两道才抓得到 —— 拆一道的话另一道照样兜住 → 假绿。
     * 但那两道网里 `.chat-log` 那道**是多余的**：它把记录区封死，
     * 导致输入框被顶在半空、下面空一大片（用户 2026-11-13 报的就是这个）。
     * 现在记录区不再设自己的上限（跟着右列一起长），**闸门只剩一道** ——
     * 拆一道就必红，门禁的保证反而更强了。
     */
    from: `.layout-wide .col-chat {
  height: 100%;
  /*
   * 右列**不许**比棋盘那列更高 —— 页面不被顶出滚动条**全靠这一道**。
   * 记录区不设自己的上限（它跟着右列一起长，见下），所以这里就是唯一的高度闸门：
   * 拆掉它，聊天内容一多页面就出纵向滚动条（门禁 G21 守着这条）。
   */
  max-height: var(--board-vh);
}`,
    to: `.layout-wide .col-chat {
  height: 100%;
}`,
    kind: 'browser',
    expect: 'G21',
  },
  {
    name: '【十一】聊天记录区又写死高度上限（输入框被顶在半空，下面空一大片）',
    file: 'src/app/globals.css',
    /*
     * 这条把「记录区有固定上限」这件事改回来 —— 也就是用户 2026-11-13 报的
     * 「宽屏下聊天输入框和发送按钮离下面边框还有距离」。
     *
     * 之前记录区是 `max-height: 525px`（写死的魔法值），右列比它高出来的那截
     * 全变成空白，输入框被顶在半空。删掉之后记录区跟着右列一起长，输入框贴底。
     * 所以这条变异必须让 **G30**（输入框贴底）红 —— 少了 G30，
     * 这个 bug 从头到尾没人守。
     */
    from: `.layout-wide .chat-strip .chat-log {
  flex: 1;
  min-height: 0;
}`,
    to: `.layout-wide .chat-strip .chat-log {
  flex: 1;
  min-height: 0;
  max-height: 525px;
}`,
    kind: 'browser',
    expect: 'G30',
  },
  {
    name: '【十一】聊天记录区又用 justify-content: flex-end（溢出甩到上方，滚不到）',
    file: 'src/app/globals.css',
    // 目标串跟着 globals.css 的改版更新过（gap 4px→5px，字号改走 --fs-sm）。
    from: `  justify-content: flex-start;
  gap: 5px;
  font-size: var(--fs-sm);`,
    to: `  justify-content: flex-end;
  gap: 5px;
  font-size: var(--fs-sm);`,
    kind: 'browser',
    expect: 'G21',
  },
  {
    name: '【十一】布局测量不再重跑（直接打开房间链接时卡在窄屏布局）',
    file: 'src/app/room/[code]/page.tsx',
    // 依赖数组本轮加上了视口宽高（视口改由 useViewport 提供）。
    from: '  }, [viewMode, stageEl, viewport.width, viewport.height]);',
    to: '  }, [viewMode]);',
    kind: 'browser',
    expect: 'G21',
  },
  {
    name: '【十一】HUD 按钮顺序换掉（悔棋挪到提议和棋左边）',
    file: 'src/app/room/[code]/page.tsx',
    // 本轮 HUD 按钮里加了 lucide 图标，JSX 结构变了 → 变异改成**换掉两个按钮的文字**，
    // 效果一样（顺序变成「认输 / 悔棋 / 提议和棋」→ G22 红），但不用跟着图标改。
    from: `                          <Handshake size={15} aria-hidden="true" />
                          提议和棋`,
    to: `                          <Handshake size={15} aria-hidden="true" />
                          悔棋`,
    kind: 'browser',
    expect: 'G22',
  },
  {
    name: '【十一】HUD 里没有「悔棋」按钮了',
    file: 'src/app/room/[code]/page.tsx',
    from: "<button\n                          className=\"btn small\"\n                          onClick={() => send({ t: 'takeback.offer' })}\n                          disabled={!canOfferTakeback}\n                          title={\n                            canOfferTakeback\n                              ? '悔掉你刚走的那一步（对方同意后轮到你重走）'\n                              : '只能悔自己刚走的那一步 —— 对方已经回应了就不能悔了'\n                          }\n                        >\n                          <Undo2 size={15} aria-hidden=\"true\" />\n                          悔棋\n                        </button>",
    to: '',
    kind: 'browser',
    expect: 'G22',
  },
  {
    name: '【十一】认输不再二次确认（点一下直接认输）',
    file: 'src/app/room/[code]/page.tsx',
    from: 'onClick={() => setResignAsk(true)}',
    to: "onClick={() => send({ t: 'resign' })}",
    kind: 'browser',
    expect: 'G23',
  },
  {
    name: '【十一】对方求和的浮层少了「反对」按钮',
    file: 'src/app/room/[code]/page.tsx',
    from: `          actions: [
            { label: '反对', onClick: () => send({ t: 'draw.decline' }) },
            { label: '同意', tone: 'primary', onClick: () => send({ t: 'draw.accept' }) },
          ],`,
    to: `          actions: [
            { label: '同意', tone: 'primary', onClick: () => send({ t: 'draw.accept' }) },
          ],`,
    kind: 'browser',
    expect: 'G24',
  },
  {
    name: '【十一】点「悔棋」不把请求发给服务端',
    file: 'src/app/room/[code]/page.tsx',
    from: "onClick={() => send({ t: 'takeback.offer' })}",
    to: "onClick={() => { /* 不发请求 */ }}",
    kind: 'browser',
    // 由 G28 抓：浏览器**自己**点「悔棋」→ 对手必须真的收到这个请求。
    // （G25 抓不到这条 —— G25 里浏览器是**回应方**，请求由对手发起。）
    expect: 'G28',
  },
  {
    name: '【十一】同意悔棋但其实不撤销那一步',
    file: 'src/server/room-manager.ts',
    from: `    const done = this.applyTakeback(room, offer.by);
    if (!done.ok) return { ok: false, message: done.message };
    return { ok: true };`,
    to: `    return { ok: true };`,
    kind: 'browser',
    expect: 'G25b',
  },
  {
    name: '【十一】右侧浮层改回插进文档流（position: static）',
    file: 'src/app/globals.css',
    from: `.side-prompts {
  position: fixed;`,
    to: `.side-prompts {
  position: static;`,
    kind: 'browser',
    expect: 'G26',
  },
  {
    name: '【十一】我方求和的等待浮层没有倒计时',
    file: 'src/app/room/[code]/page.tsx',
    from: `          body: '你已提议和棋。对方同意即成和棋；超时（30 秒）自动拒绝。',
          deadline: roomState.drawDeadline,`,
    to: `          body: '你已提议和棋。对方同意即成和棋；超时（30 秒）自动拒绝。',`,
    kind: 'browser',
    expect: 'G27',
  },
  /* ---------- 阶段十二：「再来一局」按人显示在自己那一行 ---------- */
  {
    name: '【十二】对方那一行也冒出可点的「再来一局」（能替对方点）',
    file: 'src/app/room/[code]/page.tsx',
    from: 'const canRematch = rematchOpen && myColor === color && !isSpectator && !voted && !rematchSent;',
    to: 'const canRematch = rematchOpen && !isSpectator && !voted && !rematchSent;',
    kind: 'browser',
    expect: 'G29',
  },
  {
    name: '【十二】点过之后那一行不显示「已申请」（看不出自己已经申请过）',
    file: 'src/app/room/[code]/page.tsx',
    from: `            {voted && <span className="rematch-voted">已申请</span>}
`,
    to: ``,
    kind: 'browser',
    expect: 'G29b',
  },
  {
    name: '【十二】点过之后还能重复点击（两把锁都拆掉）',
    file: 'src/app/room/[code]/page.tsx',
    // 按钮的可见性由**两把锁**共同保证：
    //   ① 服务端状态 `voted`（已经广播回来的那份）；
    //   ② 本地 `rematchSent`（点下去到广播回来之间的那一小段窗口）。
    // 只拆一把的话，另一把照样兜住 → 门禁全绿、**假绿**（这次又栽在这类问题上）。
    // 所以这条变异**一次把两把锁都拆掉**。
    from: 'const canRematch = rematchOpen && myColor === color && !isSpectator && !voted && !rematchSent;',
    to: 'const canRematch = rematchOpen && myColor === color && !isSpectator;',
    kind: 'browser',
    expect: 'G29b',
  },
  {
    name: '【十二】玩家名字不截断（长名字把窄屏那一行撑破）',
    file: 'src/app/globals.css',
    from: `.player-row .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
    to: `.player-row .name {
  white-space: nowrap;
}`,
    kind: 'browser',
    expect: 'G29d',
  },
  {
    /*
     * 宽屏那一行撑破的**根因**：`.layout-wide .hud-players` 是 `flex-wrap: wrap`，
     * 多行 flex 容器里每条 flex line 的交叉尺寸由**内容**决定 → 行被撑到 431px
     * （HUD 列只有 260px）→ 名字不截断、按钮被挤出屏幕。
     *
     * 注意：这条修复**有两道网**（`flex-wrap: nowrap` + `.player-row` 的 `max-width: 100%`），
     * 只拆一道的话另一道照样兜住 → 门禁全绿、**假绿**（又一次栽在这类问题上）。
     * 所以这条变异**一次把两道网都拆掉**。
     */
    name: '【十二】宽屏玩家行撑破（wrap + 取消 max-width，两道网一起拆）',
    file: 'src/app/globals.css',
    from: [
      `  flex-wrap: nowrap;
  gap: 6px;`,
      `  min-width: 0;
  max-width: 100%;
}

.hud-players .player-row .who {`,
    ],
    to: [
      `  flex-wrap: wrap;
  gap: 6px;`,
      `  min-width: 0;
}

.hud-players .player-row .who {`,
    ],
    kind: 'browser',
    expect: 'G29d',
  },
  {
    /*
     * 玩家名字那格的**收缩下限** + 容器宽度上限 —— 两道网一起拆。
     *
     * 现在（名字至少留 4 个字 + `.row-main` 允许换行那版设计之后），
     * 这条变异在**窄屏**下**撑不破**了：名字放不下就换行，右侧那组落到第二行，
     * 行永远是「两行高、宽度不超容器」。
     * 所以它的实际效果表现在**宽屏**：名字那格不肯收缩 → 玩家行被撑宽 → G29d 红。
     *
     * 窄屏那条（玩家行不许换行 → 行被撑宽 → 整页出横向滚动条 → G29e）
     * 由**下一条**变异守着 —— 要拆的是「换行」那道兜底。
     */
    name: '【十二】玩家名字那格不许收缩 + 容器宽度上限取消（长名字撑破玩家行）',
    file: 'src/app/globals.css',
    /*
     * 这条原来**是个空变异**（改完行为没变 → 门禁当然抓不到）。
     *
     * 原来删的是 `.hud-players` / `.hud-players .player-row` 上的 min-width，
     * 但真正卡住「长名字撑破行」的是**内层** `.player-row .who` 的 `min-width: 0`：
     * `.who` 是 flex 项，它自己带 min-width:0 时才能缩到 0，
     * 于是名字走省略号、行不被撑破；一旦拿掉，`.who` 的最小尺寸就是**名字的文字宽度**，
     * 玩家行的 min-content 随之变宽 → 430px 下整页出横向滚动条。
     *
     * 同时把浏览器这一侧的测试名**加长**（见 verify-move-arrow.ts），
     * 否则名字本身的宽度还没到「放不下」的程度，删了也看不出来。
     */
    from: [
      `  min-width: 0;
  max-width: 100%;
}

/* 宽屏：左列窄，上下叠着放两个玩家 */`,
      `.player-row .who {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  /*
   * **名字至少留 4 个字**（原来是 0 = 可以被压成一个字）。
   *
   * 配合 \`.row-main\` 的换行：右边那组放不下就换到第二行，
   * 名字不会被挤没。
   */
  min-width: 4em;
}`,
    ],
    to: [
      `}

/* 宽屏：左列窄，上下叠着放两个玩家 */`,
      `.player-row .who {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
}`,
    ],
    kind: 'browser',
    expect: 'G29d',
  },
  {
    /*
     * **窄屏那条**：玩家行撑破 —— 「名字格不许收缩」+「那组不许换行」，**两道网一起拆**。
     *
     * 窄屏下行之所以**撑不破**，靠的是两道兜底：
     *   ① `.player-row .who` 的 `min-width: 4em` —— 名字格可以压缩，
     *      压不下就走省略号（宁可截断也不把行撑宽）；
     *   ② `.player-row .row-main` 的 `flex-wrap: wrap` —— 右边那组放不下就落到第二行。
     *
     * 只拆一道，另一道照样兜住，门禁**抓不到**（实测：只拆 ②，名字格照样压缩成
     * 4em + 省略号，行一点没宽；只拆 ①，右边那组换行，行也没宽）。
     * 所以这里**一次把两道一起拆掉** —— 与缺陷 #47、阶段十二前一条是同一类问题。
     *
     * 两道都拆了：名字格的最小组宽度 = 文字宽度（测试名 32 个字 ≈ 384px），
     * 右边那组又挤在同一行 → 玩家行比容器宽 → 430px 下**整页出横向滚动条**，
     * 按钮被挤出屏幕 → G29e 红。
     */
    name: '【十二】窄屏玩家行撑破（名字格不许收缩 + 那组不许换行，两道网一起拆）',
    file: 'src/app/globals.css',
    from: [
      `.player-row .who {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  /*
   * **名字至少留 4 个字**（原来是 0 = 可以被压成一个字）。
   *
   * 配合 \`.row-main\` 的换行：右边那组放不下就换到第二行，
   * 名字不会被挤没。
   */
  min-width: 4em;
}`,
      `  flex-wrap: wrap;
  row-gap: 4px;
}`,
    ],
    to: [
      `.player-row .who {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
}`,
      `  flex-wrap: nowrap;
  row-gap: 4px;
}`,
    ],
    kind: 'browser',
    expect: 'G29e',
  },
  /* ---------- 阶段十三：悔棋的三条规则（用户 2026-11-10 拍板） ---------- */
  {
    /*
     * 规则一：**只撤销你自己走的那一步**，对方同意后轮到你重走。
     * 这条把 applyTakeback 改回「连对方的回应一起撤两步」。
     */
    name: '【十三】悔棋撤两步（连对方的回应一起撤，不是「只撤自己那一步」）',
    file: 'src/server/room-manager.ts',
    // 实现已经换成「用活实例的 undo()」（上一步悔棋规则落地时改的），
    // 原来的 fenStack 写法没了 → 变异改成**连撤两步**（undo 两次）。
    from: `    const undone = room.game.undo();
    if (!undone) return { ok: false, message: '棋谱与局面记录不一致' };`,
    to: `    room.game.undo();
    const undone = room.game.undo();
    if (!undone) return { ok: false, message: '棋谱与局面记录不一致' };`,
    kind: 'unit',
    expect: 'tests/room-manager.test.ts',
  },
  {
    /*
     * 规则二的**服务端一半**：对方已经回应后**不允许**再申请悔棋。
     * 这条把服务端那道拦截去掉 → 单测「对方已经回应时不能再悔棋」变红。
     */
    name: '【十三】对方已经回应后服务端不再拦（还能申请悔棋）',
    file: 'src/server/room-manager.ts',
    from: `    const lastMove = room.moves[room.moves.length - 1];
    if (lastMove.color !== seat.color) {
      return { ok: false, message: '对方已经回应，这一步不能悔了' };
    }`,
    to: `    const lastMove = room.moves[room.moves.length - 1];
    if (lastMove.color !== seat.color && room.moves.length > 100000) {
      return { ok: false, message: '对方已经回应，这一步不能悔了' };
    }`,
    kind: 'unit',
    expect: 'tests/room-manager.test.ts',
  },
  {
    /*
     * 规则三：**棋钟不回退**，时间照常走。
     * 这条把「对方思考的那段时间」记到悔棋者头上（等于让对方替他付账）。
     */
    name: '【十三】悔棋时把对方思考的时间算到悔棋者头上（棋钟被转嫁）',
    file: 'src/server/room-manager.ts',
    from: '     * 否则这段时间会被算到请求方头上 —— 等于让对方替他付账。\n     */\n    if (room.clock.running) this.settleClock(room, turnOf(room.fen));',
    to: '     * 否则这段时间会被算到请求方头上 —— 等于让对方替他付账。\n     */\n    if (room.clock.running) this.settleClock(room, requester);',
    kind: 'unit',
    expect: 'tests/room-manager.test.ts',
  },
  {
    /*
     * 规则二的**客户端一半**：悔棋按钮的可点条件。
     * 去掉「最后一步必须是我」这一条 → 对方刚走完时按钮也变成可点 → G25c 变红。
     */
    name: '【十三】悔棋按钮不看「最后一步是不是我走的」（对方回应后也能点）',
    file: 'src/app/room/[code]/page.tsx',
    from: `  const canOfferTakeback = Boolean(
    myColor && !isSpectator && !hasPendingOffer && lastMoveColor === myColor,
  );`,
    to: `  const canOfferTakeback = Boolean(
    myColor && !isSpectator && !hasPendingOffer,
  );`,
    kind: 'browser',
    expect: 'G25c',
  },
];

const sh = (cmd: string, args: string[]): { code: number; out: string } => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

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
 *
 * 端口也**不许写死 3000** —— 写死的话，这个脚本一跑就会把用户
 * `npm start` 起的那个生产服务 `kill -9` 掉。
 * 端口从 `--url=` 推出来：打哪个端口就只碰哪个端口。
 */
function listeners(): string[] {
  const r = spawnSync('bash', ['-c', `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null | tr '\\n' ' '`], {
    encoding: 'utf8',
  });
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
 * 不能只看 `curl 200`：新服务起不来时 curl 会打到**旧服务**上，
 * 门禁跑的是上一条变异的产物 —— 结论直接作废，而且症状极隐蔽
 *（红的是**别的**门禁）。
 *
 * **构建目录和存档目录都是隔离的**：
 * - `NEXT_DIST_DIR` —— 变异的 build 会**清空**构建目录，
 *   用默认 `.next` 的话会把用户 `npm start` 正在用的生产构建清掉；
 * - `LAN_CHESS_DATA_DIR` —— 门禁造的房间/会话不落进用户的真实存档。
 */
function startServer(before: Set<string>): void {
  spawnSync(
    'bash',
    [
      '-c',
      `PORT=${PORT} NEXT_DIST_DIR=${DIST_DIR} LAN_CHESS_DATA_DIR=${DATA_DIR} ` +
        `nohup npm start > /tmp/chess-server.log 2>&1 &`,
    ],
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
  throw new Error('服务没起来');
}

/**
 * 重新构建并重启生产服务。
 *
 * **顺序必须是「停服务 → build → 起服务」**，不能反过来。
 *
 * 为什么（实测踩出来的）：`next build` 一开始会**清空 `.next`**，
 * 而运行中的生产服务器（`next({ dev: false })` 程序化 API）正在读写同一个目录。
 * 撞上的结果有两种，都很难查：
 *   ① build 自己报 `ENOENT: .next/server/pages-manifest.json` / `.nft.json`
 *      —— 报错指向 build，真凶是**服务器进程**；
 *   ② 服务器读到被清空的 `.next` 直接崩掉，端口空着，
 *      后面起服务时又冒出别的问题。
 *
 * 实测：服务运行中连跑 4 次 build，第 1 次 ENOENT 挂掉，
 * 后面 3 次（服务已死、没人抢 `.next`）全部成功。
 */
function rebuild(): void {
  console.log('   · 停服务 → 构建 → 起服务…');

  // build 会做全项目类型检查 —— 期间有人改源码就会读到半成品
  assertWorkspaceUnchanged();

  // ① 先停旧服务（build 期间不能有服务器在读写 .next）
  const before = new Set(listeners());
  stopServer();

  // ② 再构建（**隔离构建目录** —— 默认 `.next` 是用户 `npm start` 正在用的）
  const b = sh('bash', ['-c', `NEXT_DIST_DIR=${DIST_DIR} npm run build`]);
  if (b.code !== 0) {
    console.error(b.out.slice(-2000));
    throw new Error('构建失败');
  }

  /*
   * build 之后**校验产物完整**。
   *
   * 为什么：Next 的 build 会先把构建目录清空再写。
   * 如果 build 过程中被打断（超时、被 kill、机器负载高），产物目录会留下**半成品**，
   * 症状是「服务起不来」（报「没有生产构建」）——
   * 而真正的原因在**几分钟之前**，报错现场却指向「服务」。
   */
  if (!existsSync(join(ROOT, DIST_DIR, 'BUILD_ID'))) {
    console.error('   · 构建产物不完整（.next/BUILD_ID 缺失）—— build 很可能被中断了');
    throw new Error('构建产物不完整');
  }

  // ③ 起服务（最多试 3 次；每次都必须确认监听目标端口的是新进程）
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
  // 失败时把服务端日志打出来：光说「没响应」会让人以为是服务的问题，
  // 实际十有八九是「请求地址写错了」或者「源码变异把服务编译坏了」。
  console.error('   · 服务端日志（/tmp/chess-server.log）末尾：');
  console.error(sh('bash', ['-c', 'tail -30 /tmp/chess-server.log 2>/dev/null']).out);
  console.error(`   · 实际请求的地址：${APP_URL}/`);
  throw new Error('服务重启后没有响应（已重试 3 次）');
}

/** 只跑名字里含这个片段的变异（调试单条用；不传就是全跑） */
const FILTER =
  process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ??
  POSITIONAL[1] ??
  '';
/*
 * 按序号分批跑（--from=1 --to=10）。
 *
 * 为什么需要：全量 42 条一次跑要 80 分钟，超过后台任务的时间上限，
 * 而**跑到一半被掐断**会留下变异态的源码（finally 来不及还原）。
 * 分批跑既能塞进单次的时间预算，也便于中途查看进度。
 */
const FROM = Number((process.argv.find((a) => a.startsWith('--from=')) ?? '').split('=')[1]);
const TO = Number((process.argv.find((a) => a.startsWith('--to=')) ?? '').split('=')[1]);
let RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (Number.isFinite(FROM) || Number.isFinite(TO)) {
  const a = Number.isFinite(FROM) ? Math.max(0, FROM - 1) : 0;
  const b = Number.isFinite(TO) ? TO : RUN.length;
  RUN = RUN.slice(a, b);
}
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
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
 *
 * 用途：脚本自己写盘之后，把期望值改成自己刚写的那份 ——
 * 这样守卫既能抓「别人动过这个文件」，又不会把「脚本自己的变异」算成别人的改动。
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

// 真跑之前先拿锁（--dry 不改文件，不需要）
acquireLock();
process.on('exit', releaseLock);

// 记下工作区指纹（之后每次 build 前比对）
snapshotWorkspace();

/**
 * 本条变异要跑哪几组门禁。
 *
 * 默认取 `expect` 所属的组；变异显式写了 `groups` 就用它。
 */
function groupsFor(m: Mutation): string[] {
  // 单测类变异跑的是 vitest，不跑门禁 —— 没有组这回事
  if (m.kind !== 'browser') return [];
  const expectGroups = groupsOfGate(ARROW_GROUPS, m.expect);
  const gs = m.groups ?? expectGroups;
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

let caught = 0;
for (const m of RUN) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const edits = pairs(m);
  // 每处原文都必须在**当前内容**里恰好命中 1 次（多处改动按顺序依次替换）
  let probe = original;
  for (const e of edits) {
    const hits = probe.split(e.from).length - 1;
    if (hits !== 1) {
      console.error(`❌ 变异「${m.name}」的目标串在 ${m.file} 里命中 ${hits} 次（必须恰好 1 次）`);
      process.exit(1);
    }
    probe = probe.replace(e.from, e.to);
  }
  console.log(
    m.kind === 'browser'
      ? `\n▶ 变异：${m.name}（期望 ${m.expect} 变红，跑 ${groupsFor(m).join('、')} 组）`
      : `\n▶ 变异：${m.name}（单测 ${m.expect}）`,
  );
  /*
   * 写盘**之前**确认工作区没被别人动过 ——
   * 放在这里才有效：脚本自己写的那份变异不能算成「别人的改动」。
   * （原来这个检查在 rebuild() 里面，也就是**写盘之后**，
   *   于是它把脚本自己的变异当成别人的改动 —— 每条变异都自杀，这套从来没跑起来过。）
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
    // 期望指纹改成「我们刚写的这份」—— 后面 build 前再查一次时，它不算外人的改动
    expectFileAsIs(path);
    if (m.kind === 'browser') {
      const groups = groupsFor(m);
      rebuild();
      // **只跑相关的组** —— 每条变异只期望 1 条红，其余 39 条在陪跑。
      const r = sh('npx', [
        'tsx',
        'scripts/verify-move-arrow.ts',
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
        console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.code}`);
        console.error(r.out.slice(-2500));
      }
    } else {
      // 单测类变异：只跑对应测试文件
      const r = sh('npx', ['vitest', 'run', m.expect]);
      if (r.code !== 0) {
        caught += 1;
        console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.code}`);
      } else {
        console.error(`   ❌ 没抓到！exitCode=${r.code}`);
        console.error(r.out.slice(-2000));
      }
    }
  } finally {
    writeFileSync(path, original);
    // 还原之后期望值回到原文，下一轮的守卫才不会被自己的还原误报
    expectFileAsIs(path);
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

/* ==================================================================== */
/* 覆盖报告 + 组覆盖自检（这就是「按组强制」这条规矩的执行点）        */
/* ==================================================================== */
{
  /*
   * 自检用**全量变异表**，不是本次跑的子集 ——
   * `--filter` 单跑一条时，其他组当然「没有变异跑过」，
   * 但那是**没跑到**，不是**没守着**。守不守得住是表本身的事。
   */
  // 只有**浏览器类**变异才跟门禁组有关（单测类变异跑 vitest，不跑门禁）
  const browserMutations = MUTATIONS.filter((m) => m.kind === 'browser');
  const mutationMeta = browserMutations.map((m) => ({ id: m.name, expect: m.expect }));
  const mutationGroups = new Map<string, string[]>(
    browserMutations.map((m) => [m.name, groupsFor(m)] as [string, string[]]),
  );

  /*
   * **硬自检**：每个组（机制）至少有一条变异守着，且那条变异的期望门禁属于该组。
   * 不满足 → 退出码非 0 —— 这一组的门禁是「没人验证过它会不会红」的。
   */
  const problems = checkGroupCoverage(ARROW_GROUPS, mutationMeta, mutationGroups);
  if (problems.length > 0) {
    console.error('\n❌ 组覆盖自检不通过：');
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }

  console.log('\n📋 门禁覆盖报告');
  for (const [group, ids] of Object.entries(ARROW_GROUPS)) {
    const guards = browserMutations.filter((m) => groupsFor(m).includes(group)).map((m) => m.name);
    console.log(`   ✅ ${group.padEnd(9)} ${ids.join('、')} —— ${guards.length} 条变异守着`);
  }

  /*
   * **软提示**：某条门禁从没被任何变异打红过。
   *
   * 这不一定是什么都不对（按组强制，不按门禁强制），
   * 但它值得看一眼：要么它对应的机制没人破坏过，要么**它是个摆设**。
   *
   * 只跑子集时（`--filter`）这个提示会**大面积误报** —— 那条门禁只是这次没被跑到。
   */
  const neverRed = allGateIds(ARROW_GROUPS).filter((id) => !redByGate.has(id));
  if (RUN.length < MUTATIONS.length) {
    console.log(`\nℹ️  本次只跑了 ${RUN.length}/${MUTATIONS.length} 条变异，覆盖报告里的「打红」结论不完整。`);
  } else if (neverRed.length > 0) {
    console.log(`\n⚠️  从没被任何变异打红过的门禁：${neverRed.join('、')}`);
    console.log('   （按组强制，不按门禁强制 —— 这几条门禁的失效方式目前没人验证）');
  }
}
