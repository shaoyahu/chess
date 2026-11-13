#!/usr/bin/env tsx
/**
 * **「抽签定黑白 + 准备环节」门禁**（`scripts/verify-color-draw.ts`）。
 *
 * ## 为什么要有这一套
 *
 * 改之前的规则是「谁先进来谁执白」—— 用户指出这不对，
 * 改成：**两人到齐时服务端抽签**，并且**双方都点「准备」才开局**。
 *
 * 这套门禁守的就是那条新规矩：
 *
 * | 编号 | 断言 |
 * | --- | --- |
 * | C1 | 人机选「我执白」→ 玩家坐白方 |
 * | C2 | 人机选「我执黑」→ 玩家坐黑方 |
 * | C3 | 人机选「随机」→ 玩家拿到的颜色是 w / b 之一，且身份是 player |
 * | C4 | 人机「随机」连开 16 局 → **白方归属出现过 ≥2 种**（抽签真的随机） |
 * | C5 | 开房间：**第一个进来的人没有座位**（颜色待定），房间是 waiting |
 * | C6 | 第二个人进来 → **两人各执一边**，房间进入 preparing |
 * | C7 | 只有一方点「准备」→ **不开局** |
 * | C8 | 双方都点「准备」→ **开局**，而且白方先走 |
 * | C9 | 大厅里的房间摘要带着「待抽签的玩家名字」（不是显示成空房间） |
 *
 * ## 为什么用 WebSocket 而不是浏览器
 *
 * 这一套要验的是**服务端的规则**，不是界面长相。
 * 用 ws 直连更快、更稳（不受浏览器时序影响），而且能一次跑很多局。
 * 界面那部分由 `verify:ui-style` 守着。
 */
import { spawnSync } from 'node:child_process';
import { GameClient, sleep } from './lib/game-client';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function resolveUrl(argv: string[]): string {
  const arg = argv.find((a) => a.startsWith('--url='));
  if (arg) return arg.slice('--url='.length);
  const env = process.env.VERIFY_URL;
  if (env) return env;
  return 'http://127.0.0.1:3000';
}

const BASE = resolveUrl(process.argv.slice(2));
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

interface Verdict {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

const results: Verdict[] = [];

function verdict(id: string, ok: boolean, label: string, detail: string): void {
  results.push({ id, ok, label, detail });
  if (ok) {
    console.log(`✅ ${id} ${label} —— ${detail}`);
  } else {
    console.log(`❌ ${id} ${label} —— ${detail}`);
  }
}

/** 门禁的编号过滤（`--gate=C1,C5`） */
const gateArg = process.argv.slice(2).find((a) => a.startsWith('--gate='));
const only = gateArg ? new Set(gateArg.slice('--gate='.length).split(',').map((s) => s.trim())) : null;
const gateEnabled = (id: string): boolean => !only || only.has(id);

/* ------------------------------------------------------------------ */
/* 协议层小工具                                                        */
/* ------------------------------------------------------------------ */

/** 建一个登录好的客户端 */
async function connect(name: string): Promise<GameClient> {
  const c = new GameClient(WS_URL);
  await c.ready();
  c.send({ t: 'hello', name });
  await c.waitFor((m) => (m.t === 'session' ? m : null), `${name} 登录`);
  return c;
}

/**
 * 建一个人机房，返回这局里「我是谁」。
 *
 * @param color `'random'` / `'w'` / `'b'`
 */
async function createAiRoom(
  client: GameClient,
  color: 'random' | 'w' | 'b',
): Promise<{ state: ReturnType<GameClient['latestRoomWithRole']>; role: string; myColor?: string }> {
  const since = client.msgCount;
  client.send({ t: 'room.create', timeControl: 'blitz', withAI: true, difficulty: 'normal', color });
  const state = await client.waitForRoomSince(since, '人机房快照');
  const withRole = client.latestRoomWithRole();
  return { state: withRole, role: String(withRole?.role ?? ''), myColor: withRole?.color };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`目标服务：${BASE}`);
  const clients: GameClient[] = [];

  try {
    /* ---------------- C1 / C2 / C3：人机选色 ---------------- */
    if (gateEnabled('C1') || gateEnabled('C2') || gateEnabled('C3')) {
      const c = await connect('人机选色测试');
      clients.push(c);

      if (gateEnabled('C1')) {
        const r = await createAiRoom(c, 'w');
        const seat = r.state?.state.seats.w;
        const ok =
          r.myColor === 'w' &&
          Boolean(seat) &&
          seat?.isAI !== true &&
          seat?.userId === c.session?.userId;
        verdict(
          'C1',
          ok,
          '人机选「我执白」→ 玩家坐白方',
          `服务端说我执 ${r.myColor ?? '（没给）'}｜白方座位=${JSON.stringify(seat)}`,
        );
      }

      if (gateEnabled('C2')) {
        const r = await createAiRoom(c, 'b');
        const seat = r.state?.state.seats.b;
        const ok =
          r.myColor === 'b' &&
          Boolean(seat) &&
          seat?.isAI !== true &&
          seat?.userId === c.session?.userId;
        verdict(
          'C2',
          ok,
          '人机选「我执黑」→ 玩家坐黑方',
          `服务端说我执 ${r.myColor ?? '（没给）'}｜黑方座位=${JSON.stringify(seat)}`,
        );
      }

      if (gateEnabled('C3')) {
        const r = await createAiRoom(c, 'random');
        const ok = r.role === 'player' && (r.myColor === 'w' || r.myColor === 'b');
        verdict(
          'C3',
          ok,
          '人机选「随机」→ 玩家拿到 w / b 之一，身份是 player',
          `身份=${r.role}｜我执 ${r.myColor ?? '（没给）'}`,
        );
      }

      c.close();
      clients.pop();
    }

    /* ---------------- C4：抽签真的随机 ---------------- */
    if (gateEnabled('C4')) {
      const c = await connect('随机性测试');
      clients.push(c);
      const seen = new Set<string>();
      const rounds = 16;
      for (let i = 0; i < rounds; i += 1) {
        const r = await createAiRoom(c, 'random');
        if (r.myColor) seen.add(r.myColor);
      }
      /*
       * 概率性断言：16 次全是同一个颜色的概率是 2 × 0.5^16 ≈ 0.003%。
       * 用它守的是「抽签真的随机」—— 如果实现写死成固定颜色，这条必红。
       */
      verdict(
        'C4',
        seen.size >= 2,
        `人机「随机」连开 ${rounds} 局 → 白方归属出现过 ≥2 种`,
        `出现过的颜色=${[...seen].join('/')}（${rounds} 次里 ${seen.size} 种）`,
      );
      c.close();
      clients.pop();
    }

    /* ---------------- C5 / C6 / C7 / C8：房间抽签 + 准备环节 ---------------- */
    if (
      gateEnabled('C5') ||
      gateEnabled('C6') ||
      gateEnabled('C7') ||
      gateEnabled('C8')
    ) {
      const a = await connect('房主');
      const b = await connect('客人');
      clients.push(a, b);

      // 甲建房
      const sinceA = a.msgCount;
      a.send({ t: 'room.create', timeControl: 'blitz' });
      const roomA = await a.waitForRoomSince(sinceA, '甲的房间快照');
      const code = roomA.code;

      if (gateEnabled('C5')) {
        const seatW = roomA.seats.w?.userId;
        const seatB = roomA.seats.b?.userId;
        const ok = !seatW && !seatB && roomA.status === 'waiting' && Boolean(roomA.pending);
        verdict(
          'C5',
          ok,
          '第一个进房间的人**没有座位**（颜色待定），房间在等人',
          `白方座位=${seatW ?? '空'}、黑方座位=${seatB ?? '空'}｜` +
            `待抽签=${roomA.pending?.name ?? '无'}｜status=${roomA.status}`,
        );
      }

      // 乙进房 → 两人到齐 → 抽签
      const sinceB = b.msgCount;
      const sinceA2 = a.msgCount;
      b.send({ t: 'room.join', code, mode: 'play' });
      const roomB = await b.waitForRoomSince(sinceB, '乙进房后的快照');
      const roomA2 = await a.waitForRoomSince(sinceA2, '甲收到抽签后的快照');

      if (gateEnabled('C6')) {
        const wId = roomA2.seats.w?.userId;
        const bId = roomA2.seats.b?.userId;
        const aId = a.session?.userId;
        const bIdInRoom = b.session?.userId;
        const twoSides = Boolean(wId && bId && wId !== bId);
        const coversBoth = (wId === aId && bId === bIdInRoom) || (wId === bIdInRoom && bId === aId);
        const ok = twoSides && coversBoth && roomA2.status === 'preparing' && !roomA2.pending;
        verdict(
          'C6',
          ok,
          '第二个人进来 → **两人各执一边**，房间进入准备阶段',
          `白方=${roomA2.seats.w?.name ?? '空'}、黑方=${roomA2.seats.b?.name ?? '空'}｜` +
            `status=${roomA2.status}｜待抽签=${roomA2.pending?.name ?? '无'}｜` +
            `乙看到的 status=${roomB.status}`,
        );
      }

      if (gateEnabled('C7')) {
        const sinceA3 = a.msgCount;
        a.send({ t: 'ready' });
        await sleep(400);
        const stillPrep = a.latestRoom();
        const ok = stillPrep?.status === 'preparing';
        verdict(
          'C7',
          ok,
          '只有一方点「准备」→ **不开局**',
          `甲点了准备之后 status=${stillPrep?.status ?? '读不到'}`,
        );
      }

      if (gateEnabled('C8')) {
        const sinceA4 = a.msgCount;
        b.send({ t: 'ready' });
        const after = await a.waitForRoomSince(
          sinceA4,
          '双方准备后的开局快照',
          15000,
          (s) => s.status === 'playing',
        );
        const turn = after.fen.split(' ')[1];
        verdict(
          'C8',
          after.status === 'playing' && turn === 'w',
          '双方都点「准备」→ **开局**，而且白方先走',
          `status=${after.status}｜当前走子方=${turn}｜白方=${after.seats.w?.name ?? '空'}`,
        );
      }

      a.close();
      b.close();
      clients.pop();
      clients.pop();
    }

    /* ---------------- C9：大厅摘要带待抽签玩家 ---------------- */
    if (gateEnabled('C9')) {
      const c = await connect('大厅摘要测试');
      clients.push(c);
      const since = c.msgCount;
      c.send({ t: 'room.create', timeControl: 'blitz' });
      const room = await c.waitForRoomSince(since, '建房快照');
      /*
       * 等大厅列表里出现这个房间。
       *
       * 必须**轮询最新一份**大厅快照 —— `waitFor` 是从最早开始扫的，
       * 拿到的是建房**之前**的那份（里面当然没有这个房间）。
       */
      let mine: { code: string; pendingName?: string } | undefined;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !mine) {
        const rooms = (c.latestLobby()?.rooms ?? []) as Array<{
          code: string;
          pendingName?: string;
        }>;
        mine = rooms.find((r) => r.code === room.code);
        if (!mine) await sleep(150);
      }
      verdict(
        'C9',
        Boolean(mine?.pendingName),
        '大厅里的房间摘要带着「待抽签的玩家名字」（不是显示成空房间）',
        `我的房间在大厅里=${JSON.stringify(mine)}`,
      );
      c.close();
      clients.pop();
    }
  } catch (err) {
    verdict(
      'Z',
      false,
      '门禁脚本自身出错（前置步骤失败）',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    for (const c of clients) c.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条。`);
  if (failed.length) {
    console.log('失败门禁：');
    for (const f of failed) console.log(`  ❌ ${f.id} ${f.label} —— ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

void main();
