/**
 * 「房间邀请 + 房间分享」门禁 —— `scripts/verify-invite.ts`
 *
 * 为什么单独一个脚本（而不是塞进 verify-dm.ts）：
 *   私信门禁守的是「消息能不能来回」；这一套守的是**两个新机制**：
 *     ① **邀请** —— 房间里的对局方把「当前房间」发给私聊对象，
 *        对方点一下**直接进房**；
 *     ② **分享** —— 复制房间链接，别人点开就进这局。
 *   两件事各自有独立的失败长相，混在一起会让红字指向不明。
 *
 * 门禁清单（7 条，I1~I7）：
 *   I1  房间里的私聊面板底部出现「邀请来这局 · 房间码」按钮（**房间码要对**）。
 *   I2  点它 → 对方私信里出现的是**可点的卡片**（带房间码 + 「加入房间」），
 *       不是一句普通文字。
 *   I3  点卡片 → 接收方**直接进房间**：URL 变成 /room/房间码，
 *       且身份是**对局方**（HUD 上有房间码块 —— 观众看不到那块）。
 *   I4  已在另一局里点邀请 → **先弹二次确认**（离开 = 判负，代价要摆在眼前），
 *       取消之后人还在原来那局。
 *   I5  顶栏「分享」按钮 → 小菜单里两件事（复制房间链接 / 复制房间码）。
 *   I6  复制房间链接 → **剪贴板里真的就是** /room/房间码 的链接
 *       （读回来核对，不看 toast 就算过）。
 *   I7  **没记住用户名**的人打开分享链接 → 出现「取个名字，进这局」→
 *       填完名字**直接落到房间里**（不是「需要先登录」，也不是回大厅）。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号（I1…I7）——
 * 变异脚本靠「❌ 行里含门禁编号」判定「这一条被抓到了」，
 * 失败信息不带编号就会出现假绿。
 *
 * 用法：
 *   npx tsx scripts/verify-invite.ts
 *
 * 零新增依赖：复用项目已有的 ws；Chromium 用本机 Playwright 浏览器缓存
 * （可用环境变量 CHROMIUM_PATH 覆盖）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, type Page } from './lib/browser';
import { GameClient, sleep } from './lib/game-client';
import { TestServer } from './lib/test-server';

const OUT_DIR = join(process.cwd(), 'artifacts', 'invite');

/* ------------------------------------------------------------------ */
/* 结果汇总                                                            */
/* ------------------------------------------------------------------ */
interface Verdict {
  ok: boolean;
  label: string;
  detail: string;
}

const results: Verdict[] = [];

function verdict(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

/**
 * 跑一条门禁；出错时**用它自己的编号**记一条 ❌，然后继续往下跑。
 *
 * （失败信息不带编号 → 变异脚本判不出「这条被抓到了」→ 假绿。）
 */
async function step<T>(id: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    verdict(true, `${id} ${label}`, '');
    return r;
  } catch (e) {
    verdict(false, `${id} ${label}`, `执行出错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 页面操作的小零件                                                    */
/* ------------------------------------------------------------------ */

/** 在大厅里登录（填用户名 → 点「进入大厅」） */
async function login(page: Page, base: string, name: string): Promise<void> {
  await page.navigate(`${base}/`);
  await page.waitForExpr(`!!document.querySelector('#username')`, '用户名输入框', 60000);
  // 等 hydration 完再填 —— 之前写进去的值会被 React 重置掉
  await sleep(1200);
  await page.waitConnected();
  await page.fillInput('#username', name);
  await page.clickText('button', '进入大厅', '进入大厅');
  await page.waitForExpr(
    `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('创建房间'))`,
    '大厅页面',
    60000,
  );
}

/** 建房（大厅 →「创建房间」→「确定」），返回房间码 */
async function createRoom(page: Page): Promise<string> {
  await page.clickText('button', '创建房间', '创建房间');
  await sleep(300);
  await page.clickText('button', '确定', '确定');
  await page.waitForExpr(`location.pathname.startsWith('/room/')`, '跳到对局页', 30000);
  const code = await page.evaluate<string>(`location.pathname.split('/').pop()`);
  return code.trim().toUpperCase();
}

/**
 * 打开私聊面板，并让**对话对象落在某个人身上**。
 *
 * 走的是顶栏「在线 N」→ 那个人行尾的气泡按钮 ——
 * 这是界面里**唯一**能凭空开出一个新会话的入口
 * （会话列表只列已经聊过的人）。
 */
async function openDmWith(page: Page, peerName: string): Promise<void> {
  // 打开在线名单
  await page.evaluate(`(() => {
    const dot = document.querySelector('.status-dot');
    if (dot) dot.click();
    return !!dot;
  })()`);
  await page.waitForExpr(`!!document.querySelector('.online-panel')`, '在线名单', 20000);

  // 找到那个人，点他行尾的气泡按钮
  const clicked = await page.evaluate<boolean>(`(() => {
    const row = [...document.querySelectorAll('.online-row')].find((r) => {
      const n = r.querySelector('.online-name');
      return n && n.textContent.trim() === ${JSON.stringify(peerName)};
    });
    if (!row) return false;
    const btn = row.querySelector('.online-dm');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`在线名单里找不到「${peerName}」`);

  await page.waitForExpr(`!!document.querySelector('.dm-panel')`, '私信面板', 20000);
  // 对话对象确实落在那个人身上（不是上一个、不是空的）
  await page.waitForExpr(
    `(() => {
      const t = document.querySelector('.dm-title');
      return !!t && t.textContent.trim() === ${JSON.stringify(peerName)};
    })()`,
    `对话对象是「${peerName}」`,
    20000,
  );
}

/**
 * 在**某个容器里**按可见文本点一个元素。
 *
 * 为什么不能直接用 `clickText`：同一个词在页面上可能出现好几处 ——
 * 「加入房间」既是私信卡片上的按钮，也是**大厅「加入房间」那个开局方式**。
 * 按全文找会点错那一个（实测踩过：门禁点了大厅的模式按钮，卡片根本没被点到）。
 * 所以点按钮必须**限定在它该在的容器里**。
 */
async function clickWithin(
  page: Page,
  container: string,
  tag: string,
  text: string,
  label: string,
): Promise<void> {
  const done = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector(${JSON.stringify(container)});
    if (!root) return false;
    const el = [...root.querySelectorAll(${JSON.stringify(tag)})]
      .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!done) throw new Error(`点不到「${label}」（${container} 里的「${text}」）`);
}

/** 读页面里的剪贴板内容（读不出来就把错误原样抛出去） */
async function readClipboard(page: Page): Promise<string> {
  return page.evaluate<string>(`(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      return 'CLIPBOARD_ERROR:' + (e && e.message ? e.message : String(e));
    }
  })()`, true);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-invite-'));

  /*
   * 收尾要关的东西放在一个**对象**里 ——
   * 用 `let x: T | null` 的话，TypeScript 不会跟踪「在回调里赋值」，
   * 到了 `finally` 里就被收窄成 `never`，`x?.close()` 直接编译不过。
   */
  const ctx: { server?: TestServer; browser?: Browser; rival?: GameClient } = {};

  try {
    const server = await TestServer.start(dataDir);
    ctx.server = server;
    console.log(`   · 服务端已起：${server.url}（存档目录 ${dataDir}）`);

    // 热身：dev 模式的 Next 第一次请求要现场编译
    try {
      await fetch(`${server.url}/`, { signal: AbortSignal.timeout(120000) });
    } catch {
      /* 热身失败不致命 */
    }

    const browser = await Browser.launch({ width: 1500, height: 950 });
    ctx.browser = browser;
    const host = await browser.newPage();
    /*
     * 客人用**隔离上下文** —— 模拟「另一台设备」。
     *
     * 为什么不能跟房主共用一个浏览器上下文：
     *   同一浏览器的标签页是**共享 localStorage** 的，而座位凭证就存在那儿 ——
     *   客人的标签页会读到房主的凭证，走「认领座位」那条路，
     *   于是「点邀请进的是不是对局方」这类判据就**测不到真正的入座路径**
     *   （实测踩过：把入座改成观战，门禁照样全绿）。
     */
    const guest = await browser.newIsolatedPage();
    /*
     * 剪贴板权限：门禁要**把复制出来的链接读回来核对**，
     * 光看一句「已复制」的提示不算数。
     */
    await host.grantClipboard(server.url);

    /* ---------------- 准备：房主建房、客人登录 ---------------- */
    await login(host, server.url, '房主');
    await login(guest, server.url, '客人');
    const code = await createRoom(host);
    console.log(`   · 房主建好房间 ${code}`);

    /* ---------------- I1 邀请按钮在私聊面板底部 ---------------- */
    await step('I1', '房间里的私聊面板出现「邀请来这局 · 房间码」按钮', async () => {
      await openDmWith(host, '客人');
      await host.waitForExpr(`!!document.querySelector('.dm-invite-send')`, '邀请按钮', 20000);
      const text = await host.evaluate<string>(
        `(document.querySelector('.dm-invite-send') || {}).textContent || ''`,
      );
      if (!text.includes(code)) {
        throw new Error(`按钮上的房间码不对（期望含 ${code}）：${text.trim()}`);
      }
    });

    /* ---------------- I2 邀请发出去 → 对方收到可点卡片 ---------------- */
    await step('I2', '邀请发出去 → 对方私信里是可点的卡片', async () => {
      await clickWithin(host, '.dm-foot', 'button', '邀请来这局', '邀请按钮');
      // 对方：打开私信面板 → 点「房主」那条会话
      await openDmWith(guest, '房主');
      await guest.waitForExpr(`!!document.querySelector('.dm-invite-card')`, '邀请卡片', 20000);
      const shown = await guest.evaluate<string>(
        `(document.querySelector('.dm-invite-code') || {}).textContent || ''`,
      );
      if (shown.trim() !== code) {
        throw new Error(`卡片上的房间码不对（期望 ${code}）：${shown.trim()}`);
      }
      // 卡片上得真有个「加入房间」的入口 —— 不然它只是一段字
      const action = await guest.evaluate<string>(
        `(document.querySelector('.dm-invite-act') || {}).textContent || ''`,
      );
      if (!action.includes('加入房间')) {
        throw new Error(`卡片上没有「加入房间」：${action.trim()}`);
      }
    });

    /* ---------------- I3 点卡片 → 直接进房间 ---------------- */
    await step('I3', '点邀请卡片 → 接收方直接进房间（对局方，不是观众）', async () => {
      await clickWithin(guest, '.dm-log', 'button', '加入房间', '邀请卡片');
      try {
        await guest.waitForExpr(`location.pathname === '/room/${code}'`, '跳到房间页', 30000);
        // 房间码块只有**对局方**看得见（观众看不到）—— 用它判身份
        await guest.waitForExpr(`!!document.querySelector('.hud-code')`, '房间码块（对局方）', 30000);
      } catch (e) {
        const log = (await guest.wsLog()).filter((m) => m.t !== '?');
        const room = await guest.evaluate<string>(
          `JSON.stringify({ path: location.pathname, hasCode: !!document.querySelector('.hud-code'), body: document.body.innerText.slice(0, 160).replace(/\\n/g, ' / ') })`,
        );
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n    页面：${room}\n    WS 流水：${JSON.stringify(log.slice(-30))}`,
        );
      }
    });

    /* ---------------- I4 跨房间点邀请 → 二次确认 ---------------- */
    await step('I4', '已在另一局里点邀请 → 先弹二次确认（离开 = 判负）', async () => {
      // 用 ws 客户端开另一个房间，给客人发一份**别的房间**的邀请
      const rival = new GameClient(server.wsUrl);
      ctx.rival = rival;
      await rival.ready();
      await rival.hello('对手丙');
      rival.send({ t: 'room.create', timeControl: '10+0' });
      const rivalRoom = await rival.waitForRoomSince(0, '对手的房间');
      // 客人的 userId：从大厅在线名单里按名字找
      const online = await rival.waitFor<Array<{ userId: string; name: string }>>(
        (m) =>
          m.t === 'lobby' && Array.isArray(m.state?.onlineUsers)
            ? (m.state.onlineUsers as Array<{ userId: string; name: string }>)
            : null,
        '在线名单',
      );
      const guestUser = online.find((u) => u.name === '客人');
      if (!guestUser) throw new Error('在线名单里找不到「客人」');

      rival.send({ t: 'dm.invite', to: guestUser.userId, roomCode: rivalRoom.code });

      // 客人：在私信里点开「对手丙」那条会话 → 点卡片 → 应该先弹确认
      await openDmWith(guest, '对手丙');
      await guest.waitForExpr(`!!document.querySelector('.dm-invite-card')`, '对手丙的邀请卡片', 20000);
      await clickWithin(guest, '.dm-log', 'button', '加入房间', '对手丙的邀请卡片');
      await guest.waitForExpr(`!!document.querySelector('.dm-confirm')`, '二次确认条', 20000);

      // 代价必须写在脸上（离开 = 判负）
      const text = await guest.evaluate<string>(
        `(document.querySelector('.dm-confirm-text') || {}).textContent || ''`,
      );
      if (!text.includes('判你输')) {
        throw new Error(`确认条没把代价写出来：${text.trim()}`);
      }

      // 取消 → 人还在原来那局（不能被一条邀请悄悄带走）
      await clickWithin(guest, '.dm-confirm-actions', 'button', '取消', '取消');
      await sleep(400);
      const path = await guest.evaluate<string>(`location.pathname`);
      if (path !== `/room/${code}`) {
        throw new Error(`取消之后人不在原来那局了：${path}`);
      }
    });

    /* ---------------- I5 分享菜单 ---------------- */
    await step('I5', '顶栏「分享」按钮 → 小菜单里有复制链接 / 复制房间码', async () => {
      await host.focus();
      await host.evaluate(`(() => {
        const b = document.querySelector('.share-btn');
        if (b) b.click();
        return !!b;
      })()`);
      await host.waitForExpr(`!!document.querySelector('.share-menu')`, '分享菜单', 20000);
      const items = await host.evaluate<string[]>(
        `[...document.querySelectorAll('.share-menu .ctx-item')].map((b) => (b.textContent || '').trim())`,
      );
      if (items.length !== 2) {
        throw new Error(`菜单项数量不对（期望 2）：${JSON.stringify(items)}`);
      }
      const joined = items.join(' | ');
      if (!joined.includes('复制房间链接') || !joined.includes('复制房间码')) {
        throw new Error(`菜单项不对：${joined}`);
      }
    });

    /* ---------------- I6 复制房间链接 → 剪贴板里就是它 ---------------- */
    await step('I6', '复制房间链接 → 剪贴板里真的是 /room/房间码 的链接', async () => {
      await host.focus();
      await clickWithin(host, '.share-menu', 'button', '复制房间链接', '复制房间链接');
      // 等复制完成（成功/失败都有提示）
      await host.waitForExpr(
        `[...document.querySelectorAll('.toast-text')]
           .some((t) => (t.textContent || '').includes('复制'))`,
        '复制提示',
        20000,
      );
      const text = await readClipboard(host);
      if (text.startsWith('CLIPBOARD_ERROR:')) {
        throw new Error(`读不到剪贴板：${text}`);
      }
      const want = `${server.url}/room/${code}`;
      if (text.trim() !== want) {
        throw new Error(`剪贴板内容不对（期望 ${want}）：${text.trim()}`);
      }
    });

    /* ---------------- I7 没名字的人打开分享链接 → 取名直接进房 ---------------- */
    await step('I7', '没记住用户名的人打开分享链接 → 取名后直接进房间', async () => {
      // 用**另一个房间**（对手丙那个还有空位）—— 房主那个局已经满了，
      // 新访客进去只能是观众，测不到「参与游戏」。
      const rivalRoom = await ctx.rival!.waitForRoomSince(0, '对手的房间');
      const visitor = await browser!.newIsolatedPage();
      // 在**应用脚本跑之前**清掉本机记住的名字与身份 —— 模拟「第一次来」
      await visitor.addInitScript(
        `try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }`,
      );
      await visitor.navigate(`${server.url}/room/${rivalRoom.code}`);
      await visitor.waitForExpr(`!!document.querySelector('#join-name')`, '取名输入框', 30000);
      await sleep(600);
      await visitor.fillInput('#join-name', '新访客');
      await clickWithin(visitor, '.card', 'button', '进入房间', '进入房间');
      await visitor.waitForExpr(`location.pathname === '/room/${rivalRoom.code}'`, '落到房间页', 30000);
      // 房间码块 = **对局方**才有 → 说明他真的进来下棋了，不是站在门口
      await visitor.waitForExpr(`!!document.querySelector('.hud-code')`, '房间码块（对局方）', 30000);
    });
  } finally {
    ctx.rival?.close();
    await ctx.browser?.close();
    await ctx.server?.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`❌ 邀请门禁失败：${failed.length}/${results.length} 条不达标。`);
    process.exit(1);
  }
  console.log(`✅ 邀请门禁通过：${results.length} 条全部达标。`);
}

main().catch((e) => {
  console.error('门禁执行失败：', e);
  process.exit(1);
});
