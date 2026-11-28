/**
 * **「WS-only 部署形态」的门禁** —— `scripts/verify-ws-only.ts`
 *
 * 这个脚本守的是**混合部署**那条路（页面在 Vercel、实时服务在自己的服务器）：
 * `server-ws.ts` 那个只跑 WebSocket、不带 Next.js 的入口。
 *
 * 为什么必须有门禁（而不是「看着挺简单，跑一下就知道」）：
 *
 *  1. **`server-ws.ts` 是新入口，配套的 systemd 单元和 nginx 反代都要靠它。**
 *     它要是起不来、握手不对、或者存档不落盘 —— 服务器上的服务会「看着在跑，
 *     其实对局一开就丢」，而这种故障在浏览器里表现为「房间不存在」，很难定位。
 *
 *  2. **最关键的一条是 W4（重启后房间还在）**：这个入口是**独立**的进程，
 *     它自己负责 `restoreFromDisk`。本地开发走 `server.ts`，那条路已经有门禁了；
 *     这条路是新写的，如果没有门禁，「重启不丢对局」这个承诺在混合部署下
 *     就是**没人验证过的**。
 *
 * 门禁清单（W1~W5）：
 *   W1  服务起得来，`/healthz` 返回 `{ok:true, mode:'ws-only'}`。
 *   W2  **不提供页面**：非 `/ws` 的路径一律 404 —— 这是「WS-only」的定义，
 *       页面由 Vercel 托管；要是这里返回了 HTML，说明入口写错了。
 *   W3  WS 握手：`hello` → 收到 `session`（拿到身份）和 `lobby`（拿到大厅）。
 *   W4  **重启不丢对局**：建房 → 存档落盘 → 停服务 → 用同一个存档目录再起 →
 *       大厅里还能看到这个房间、玩家还能凭 token 认回身份。
 *   W5  存档写在**临时目录**里，没碰仓库的 `.data/`。
 *
 * 判定方式跟项目规矩一致：**进程退出码** + 门禁自己打印的 ❌ 行 + 门禁编号。
 * 每条门禁的失败信息都必须带上自己的编号。
 *
 * 用法：
 *   npx tsx scripts/verify-ws-only.ts
 *
 * 零新增依赖。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GameClient, sleep } from './lib/game-client';

/** 起服务时用的入口 —— 就是那个「只跑 WS、不带 Next.js」的入口 */
const ENTRY = 'server-ws.ts';

/** 服务端打出这行就算启动完成 */
const READY_MARKER = 'WebSocket 服务已启动';

/**
 * 门禁里的玩家名 —— 用它来判「门禁的存档有没有漏进仓库的 .data/」。
 *
 * 选它而不是房间码：4 位码有 1/10000 的撞码概率（会假红），
 * 而这个名字带身份，仓库里不可能有。
 */
const GATE_PLAYER_NAME = '门禁甲';

/**
 * 仓库的存档里有没有提到某个名字。
 *
 * @returns 命中的文件名（没命中就是空数组）
 */
function repoFilesMention(dir: string, name: string): string[] {
  const hits: string[] = [];
  if (!existsSync(dir)) return hits;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const text = readFileSync(join(dir, file), 'utf8');
      if (text.includes(name)) hits.push(file);
    } catch {
      /* 读不了就当没命中 */
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 门禁框架                                                            */
/* ------------------------------------------------------------------ */
let failed = 0;

function pass(id: string, text: string): void {
  console.log(`  ✅ ${id} ${text}`);
}

function fail(id: string, text: string): void {
  failed += 1;
  console.log(`  ❌ ${id} ${text}`);
}

function check(id: string, cond: unknown, okText: string, failText: string): boolean {
  /*
   * `Boolean(cond)` 这一步是**必须的**，不是防御性冗余：
   * 直接 `if (cond)` 的话，传进来的若是**数组**（哪怕是空数组），
   * 判定会变成恒真/恒假 —— 空数组是 truthy，`![]` 是 false。
   * 本脚本第一版就栽在这：W5 传的是「命中的文件名数组」，
   * 写成 `!leaked` 之后**永远**判失败（空数组 → 假红）。
   * 所以：条件一律收敛成布尔再判。
   */
  const ok = Boolean(cond);
  if (ok) pass(id, okText);
  else fail(id, failText);
  return ok;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 找一个没人占用的端口 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface WsServer {
  proc: ChildProcess;
  port: number;
  stderrText: () => string;
  stop: () => Promise<void>;
}

/**
 * 起一个 WS-only 服务端。
 *
 * 隔离三样东西（照 `lib/test-server.ts` 的规矩）：
 *  ① 端口 —— 用空闲随机端口，绝不碰 3000（那是用户自己跑着的服务）
 *  ② 存档目录 —— 临时目录，绝不碰仓库的 `.data/`
 *  ③ 构建目录 —— 这里**用不到**（这个入口不跑 Next.js，不产生构建产物）
 *
 * ⚠️ **启动方式必须和 systemd 单元里生产用的那一种一致** ——
 *    生产改成了「node + scripts/ts-loader.mjs」（为了省掉 tsx 的两套运行时），
 *    门禁如果还测 tsx，就等于**测的不是线上跑的那条路**，
 *    线上起不来门禁还是绿的。所以这里用**同一套**参数。
 *    （tsx 那条路仍然要有人跑 —— `server.ts` / 本地开发还在用它，
 *    但那由别的门禁覆盖，不是这个脚本的职责。）
 */
async function startWsServer(dataDir: string): Promise<WsServer> {
  const port = await freePort();
  const loader = join(process.cwd(), 'scripts', 'ts-loader.mjs');
  const proc = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', pathToFileURL(loader).href, ENTRY],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        LAN_CHESS_DATA_DIR: dataDir,
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let err = '';
  proc.stderr?.on('data', (buf: Buffer) => {
    err += buf.toString();
    if (err.length > 8000) err = err.slice(-8000);
  });

  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务端启动超时')), 30000);
    proc.stdout?.on('data', (buf: Buffer) => {
      out += buf.toString();
      if (out.includes(READY_MARKER)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`服务端提前退出（code=${code}）：\n${out.slice(-800)}\n${err.slice(-800)}`),
      );
    });
  });

  return {
    proc,
    port,
    stderrText: () => err,
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* 门禁                                                                */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-ws-only-'));
  let server: WsServer | null = null;

  try {
    /* ---------------- W1 服务起得来 ---------------- */
    server = await startWsServer(dataDir);
    check('W1', true, `服务已启动（端口 ${server.port}）`, '');

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const healthBody = (await health.json()) as { ok?: boolean; mode?: string };
    check(
      'W1',
      health.status === 200 && healthBody.ok === true && healthBody.mode === 'ws-only',
      `/healthz 返回 ${JSON.stringify(healthBody)}`,
      `/healthz 不对：status=${health.status} body=${JSON.stringify(healthBody)}`,
    );

    /* ---------------- W2 不提供页面 ---------------- */
    const rootRes = await fetch(`http://127.0.0.1:${server.port}/`);
    const rootBody = await rootRes.text();
    check(
      'W2',
      rootRes.status === 404 && !rootBody.includes('<!DOCTYPE html'),
      '非 /ws 的路径返回 404（页面归 Vercel）',
      `非 /ws 的路径不该有内容，却拿到 status=${rootRes.status} body=${rootBody.slice(0, 120)}`,
    );

    /* ---------------- W3 WS 握手 ---------------- */
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    const alice = new GameClient(wsUrl);
    await alice.ready();
    await alice.hello('门禁甲');

    check(
      'W3',
      alice.session !== null && alice.session.token.length > 0,
      `握手拿到身份（userId=${alice.session?.userId}）`,
      '握手后没拿到 session —— 身份没建立起来',
    );

    const lobby = await alice.waitFor<{ state: { rooms: unknown[]; online: number } }>(
      (m) => (m.t === 'lobby' ? (m as { state: { rooms: unknown[]; online: number } }) : null),
      '大厅状态',
    );
    check(
      'W3',
      typeof lobby.state.online === 'number' && Array.isArray(lobby.state.rooms),
      `大厅可用（在线 ${lobby.state.online}，房间 ${lobby.state.rooms.length}）`,
      `大厅结构不对：${JSON.stringify(lobby.state).slice(0, 160)}`,
    );

    /* ---------------- W4 重启不丢对局 ---------------- */
    alice.send({ t: 'room.create', timeControl: '5+0' });
    const roomMsg = await alice.waitFor<{ state: { code: string } }>(
      (m) => (m.t === 'room' ? (m as { state: { code: string } }) : null),
      '房间创建',
    );
    const roomCode = roomMsg.state.code;
    const aliceToken = alice.session?.token ?? '';
    check('W4', roomCode.length === 4, `房间已创建（码 ${roomCode}）`, '建房没拿到 4 位房间码');

    // 等存档落盘（store.ts 是节流写的，最多 2 秒一次）
    await sleep(2500);
    const roomsFile = join(dataDir, 'rooms.json');
    const sessionsFile = join(dataDir, 'sessions.json');
    check(
      'W4',
      existsSync(roomsFile) && existsSync(sessionsFile),
      `存档已落盘（${readdirSync(dataDir).join(', ')}）`,
      `存档没落盘：${dataDir} 里是 ${readdirSync(dataDir).join(', ') || '(空)'}`,
    );

    // 重启：同一个存档目录，新进程
    await server.stop();
    server = await startWsServer(dataDir);

    const bob = new GameClient(`ws://127.0.0.1:${server.port}/ws`);
    await bob.ready();
    await bob.hello('门禁乙');
    const lobby2 = await bob.waitFor<{ state: { rooms: Array<{ code: string }> } }>(
      (m) => (m.t === 'lobby' ? (m as { state: { rooms: Array<{ code: string }> } }) : null),
      '重启后的大厅状态',
    );
    const codes = lobby2.state.rooms.map((r) => r.code);
    check(
      'W4',
      codes.includes(roomCode),
      `重启后房间还在（大厅里有 ${codes.join(', ') || '(空)'}）`,
      `重启后房间 ${roomCode} 没了 —— 存档没恢复（大厅：${codes.join(', ') || '(空)'}）`,
    );

    // 身份也要认得回来
    const alice2 = new GameClient(`ws://127.0.0.1:${server.port}/ws`);
    await alice2.ready();
    await alice2.hello('门禁甲', aliceToken);
    check(
      'W4',
      alice2.session !== null && alice2.session.token === aliceToken,
      '凭 token 认回了同一个身份',
      '重启后凭 token 没认回身份（会话表没恢复）',
    );

    /* ---------------- W5 存档隔离 ---------------- */
    /*
     * 判定不能写成「仓库 .data/rooms.json 不存在」—— 那是你自己玩的对局，
     * 早就该在那儿了。真正要判的是：**门禁造出来的房间有没有漏进仓库的存档**。
     *
     * 用**座位名**做判定（门禁里的玩家叫「门禁甲」）：它带身份，
     * 不会像 4 位房间码那样有 1/10000 的撞码概率。
     */
    const repoData = join(process.cwd(), '.data');
    const leaked = repoFilesMention(repoData, GATE_PLAYER_NAME);
    check(
      'W5',
      leaked.length === 0,
      '门禁的存档没漏进仓库 .data/',
      `门禁造出来的房间漏进了仓库存档（${repoData}）：${leaked.join(', ')}`,
    );

    const tempFiles = readdirSync(dataDir);
    check(
      'W5',
      tempFiles.every((f) => f === 'rooms.json' || f === 'sessions.json'),
      `临时目录里只有存档文件：${tempFiles.join(', ')}`,
      `临时目录里有意外文件：${tempFiles.join(', ')}`,
    );
    console.log(`  ℹ️  仓库 .data/ 当前内容：${readdirSync(repoData).join(', ') || '(空)'}`);
  } finally {
    await server?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('');
  if (failed > 0) {
    console.log(`门禁失败：${failed} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch((err) => {
  console.error('门禁脚本自身出错：', err);
  process.exit(1);
});
