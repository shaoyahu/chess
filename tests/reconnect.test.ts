/**
 * **重连与恢复**的端到端测试。
 *
 * 覆盖用户报的三个场景：
 *  1. **关掉网页再打开** —— 凭座位凭证坐回原座位（而不是变成观战者）；
 *  2. **断线后回来** —— 凭 token 恢复身份（这条以前就有，但要和认领并存）；
 *  3. **服务端重启后回来** —— 房间和会话都从存档恢复，座位认得回来。
 *
 * 为什么用「真实 WebSocket + 真实服务端」而不是纯函数测试：
 * 这几条链路跨了「客户端发什么 → 服务端怎么判 → 广播给谁」三层，
 * 纯函数测不到「凭证有没有漏发给别人」这种问题。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WebSocket as WsClient } from 'ws';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { WsHub } from '@/server/ws-hub';
import { setDataDir, resetStore, loadSessions } from '@/server/store';
import type { ServerMessage } from '@/lib/protocol';
import { DISCONNECT_GRACE_MS } from '@/lib/constants';

let server: Server;
let hub: WsHub;
let port: number;
const baseUrl = (): string => `ws://127.0.0.1:${port}/ws`;

/** 测试用客户端 */
class TestClient {
  readonly socket: WsClient;
  readonly messages: ServerMessage[] = [];
  token?: string;
  userId?: string;

  constructor(url: string = baseUrl()) {
    this.socket = new WsClient(url);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('message', (raw: Buffer) => {
      try {
        this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      } catch {
        /* ignore */
      }
    });
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload));
  }

  async hello(name: string, token?: string): Promise<void> {
    this.send({ t: 'hello', name, token: token ?? this.token });
    await this.waitFor((m) => m.t === 'session');
    const session = this.messages.find((m) => m.t === 'session');
    if (session && session.t === 'session') {
      this.token = session.token;
      this.userId = session.userId;
    }
  }

  async waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (let i = this.messages.length - 1; i >= 0; i -= 1) {
        if (predicate(this.messages[i])) return this.messages[i];
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `等待超时。最后收到的消息：${JSON.stringify(this.messages.slice(-5).map((m) => m.t))}`,
    );
  }

  /** 最新的房间快照 */
  latestRoom(): ServerMessage extends { t: 'room' } ? never : any {
    const list = this.messages.filter((m) => m.t === 'room');
    if (!list.length) return null;
    const msg = list[list.length - 1];
    return msg.t === 'room' ? msg : null;
  }

  /** 我收到的**座位凭证**（只有棋手才有） */
  claimKey(): string | undefined {
    const list = this.messages.filter((m) => m.t === 'room');
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (msg.t === 'room' && msg.claimKey) return msg.claimKey;
    }
    return undefined;
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * 让**白方**走第一步（初始局面白先走）。
 *
 * 为什么需要这个helper：
 * 匹配时黑白由**服务端抽签**决定 → 「轮到谁走第一步」不是固定的。
 * 测试如果直接假设「发起方执白」，就会有一半的局因为
 * 「还没轮到对方走」而走不了第一步 → **偶发失败**（最坏的那种）。
 *
 * 所以：谁执白谁先走，另一方等它走完再动。
 */
async function letWhiteMoveFirst(a: TestClient, b: TestClient): Promise<void> {
  const white = a.latestRoom().color === 'w' ? a : b;
  white.send({ t: 'move', from: 'e2', to: 'e4' });
  await new Promise((r) => setTimeout(r, 300));
}

/** 两个人配对并开始对局，返回房间码 */
async function startGame(a: TestClient, b: TestClient): Promise<string> {
  a.send({ t: 'queue.join' });
  await a.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
  b.send({ t: 'queue.join' });
  await Promise.all([
    a.waitFor((m) => m.t === 'room' && m.state.status === 'preparing'),
    b.waitFor((m) => m.t === 'room' && m.state.status === 'preparing'),
  ]);
  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  await Promise.all([
    a.waitFor((m) => m.t === 'room' && m.state.status === 'playing'),
    b.waitFor((m) => m.t === 'room' && m.state.status === 'playing'),
  ]);
  const msg = a.latestRoom();
  return msg.state.code;
}

describe('服务端重启后恢复', () => {
  it('房间与身份都能从存档恢复，玩家回来还认得回自己的座位', async () => {
    /*
     * **独立的一组 hub —— 用自己的存档目录，避免污染别的东西。**
     *
     * 两个细节不能省：
     *  1. `setDataDir(tmpDir)` —— 否则存档会写进**仓库根目录**的 `.data/`，
     *     测试造出来的假房间混进玩家真正在玩的局；
     *  2. `resetStore()` —— 切换目录前先把上一个目录排队的节流定时器掐掉，
     *     否则它醒来后会把旧快照写到新目录里去。
     */
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'lan-chess-restore-'));
    resetStore();
    const prevDataDir = setDataDir(tmpDir);
    try {
      // ---- 第一个「进程」：开局 ----
      const hub1 = new WsHub();
      const wss1 = new WebSocketServer({ noServer: true });
      wss1.on('connection', (s: WebSocket) => hub1.handleConnection(s));
      const srv1 = createServer();
      srv1.on('upgrade', (req, socket, head) => {
        wss1.handleUpgrade(req, socket, head, (ws) => wss1.emit('connection', ws, req));
      });
      await new Promise<void>((r) => srv1.listen(0, '127.0.0.1', r));
      const port1 = (srv1.address() as { port: number }).port;

      const a = new TestClient(`ws://127.0.0.1:${port1}/ws`);
      const b = new TestClient(`ws://127.0.0.1:${port1}/ws`);
      await Promise.all([a.connect(), b.connect()]);
      await Promise.all([a.hello('A'), b.hello('B')]);
      const code = await startGame(a, b);
      const token = a.token!;
      const userId = a.userId;

      // 走一步，让存档里有真实的走子记录（重放时要能重建出来）
      await letWhiteMoveFirst(a, b);

      // 把存档刷到磁盘（不等节流）
      await hub1.flushNow();
      /*
       * **先关客户端，再关服务器。**
       *
       * 顺序反了会卡死：`server.close()` 要等所有连接都结束才回调，
       * 而 WebSocket 连接是**长连接**——客户端还开着的话，
       * 这个 `close()` 的回调永远不来，整个用例直接超时。
       * 「模拟进程退出」也一样：**先断连接，再收服务**。
       */
      a.close();
      b.close();
      await new Promise<void>((r) => wss1.close(() => r()));
      await new Promise<void>((r) => srv1.close(() => r()));

      // ---- 第二个「进程」：重启后恢复 ----
      const hub2 = new WsHub();
      const wss2 = new WebSocketServer({ noServer: true });
      wss2.on('connection', (s: WebSocket) => hub2.handleConnection(s));
      const srv2 = createServer();
      srv2.on('upgrade', (req, socket, head) => {
        wss2.handleUpgrade(req, socket, head, (ws) => wss2.emit('connection', ws, req));
      });
      await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
      const port2 = (srv2.address() as { port: number }).port;

      // 关键：恢复必须发生在**开始服务之前**
      await hub2.restoreFromDisk();

      // 房间回来了
      const restored = hub2.roomManager.getRoom(code);
      expect(restored).toBeDefined();
      expect(restored!.status).toBe('playing');
      // 走子记录也在
      expect(restored!.moves.length).toBe(1);
      // 重启后没人在线 → 座位进入「断线等重连」
      expect(restored!.seats.w?.connected).toBe(false);
      expect(restored!.seats.b?.connected).toBe(false);

      // 玩家带着**同一个 token**回来 → 身份和座位都认得回来
      const a2 = new TestClient(`ws://127.0.0.1:${port2}/ws`);
      await a2.connect();
      await a2.hello('A', token);
      expect(a2.userId).toBe(userId);

      await a2.waitFor((m) => m.t === 'room');
      const state = a2.latestRoom().state;
      const seat = [state.seats.w, state.seats.b].find((s) => s && s.userId === userId);
      expect(seat).toBeDefined();
      expect(seat?.connected).toBe(true);

      a2.close();
      await new Promise<void>((r) => wss2.close(() => r()));
      await new Promise<void>((r) => srv2.close(() => r()));
    } finally {
      resetStore();
      setDataDir(prevDataDir);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

beforeAll(async () => {
  hub = new WsHub();
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket: WebSocket) => hub.handleConnection(socket));
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  /*
   * WebSocket 是**长连接**：不先掐掉的话 `server.close()` 的回调永远不来
   * —— 用例失败时会连带把整个文件卡成超时（还会掩盖真正的失败原因）。
   */
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('关掉网页再打开：凭座位凭证认领回原座位', () => {
  it('凭证只发给座位本人，不会广播给对手', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    // 两个人各自都拿到了**自己**的凭证
    const keyA = a.claimKey();
    const keyB = b.claimKey();
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    // 两个人的凭证不一样 —— 不然就成了一把万能钥匙
    expect(keyA).not.toBe(keyB);

    /*
     * **对手收到的凭证不能是这一方的**。
     *
     * 这是安全底线：凭证一旦广播出去，任何人都能拿它抢走那个座位
     * —— 哪怕座位的主人此刻正连着。
     *
     * 注意：对手**自己**的凭证是有的（他是另一个棋手），
     * 所以要断言的是「拿到的是不是**对方那一把**」。
     */
    const roomMsg = b.messages.filter((m) => m.t === 'room').pop();
    expect(roomMsg && roomMsg.t === 'room' ? roomMsg.claimKey : undefined).not.toBe(keyA);
    // 公共快照里的座位对象里也不能有凭证
    const state = b.latestRoom().state;
    expect(state.seats.w?.claimKey).toBeUndefined();
    expect(state.seats.b?.claimKey).toBeUndefined();

    a.close();
    b.close();
    expect(code).toHaveLength(4);
  });

  it('关掉网页重开后，凭凭证坐回原座位并能继续走子', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    // A 记下自己的凭证（模拟客户端存进 localStorage）
    const claimKey = a.claimKey();
    const oldUserId = a.userId;
    expect(claimKey).toBeTruthy();

    // A 关掉网页 —— 身份凭证（token）随标签页一起没了
    a.close();
    await new Promise((r) => setTimeout(r, 300));

    // A 重新打开网页：**没有 token**（sessionStorage 已清空）→ 服务端发新身份
    const a2 = new TestClient();
    await a2.connect();
    await a2.hello('A');
    expect(a2.userId).not.toBe(oldUserId);

    // 凭凭证认领
    a2.send({ t: 'room.claim', code, claimKey: claimKey! });
    const claimed = await a2.waitFor((m) => m.t === 'room');
    expect(claimed.t).toBe('room');
    if (claimed.t !== 'room') return;

    // 坐回了座位（不是观战者），而且还是原来的那一边
    expect(claimed.role).toBe('player');
    expect(claimed.color).toBeTruthy();
    const mySeat = [claimed.state.seats.w, claimed.state.seats.b].find(
      (s) => s && s.userId === a2.userId,
    );
    expect(mySeat).toBeDefined();
    expect(mySeat?.connected).toBe(true);

    // **还能继续走子** —— 座位没丢
    const myColor = claimed.color!;
    // 我执黑的话，得先让白方（对手）走一步 —— 初始局面白先走
    if (myColor === 'b') {
      b.send({ t: 'move', from: 'e2', to: 'e4' });
      await new Promise((r) => setTimeout(r, 300));
    }
    const before = a2.latestRoom().state.moves.length;
    const from = myColor === 'w' ? 'e2' : 'e7';
    const to = myColor === 'w' ? 'e4' : 'e5';
    a2.send({ t: 'move', from, to });
    await new Promise((r) => setTimeout(r, 400));
    expect(a2.latestRoom().state.moves.length).toBe(before + 1);

    a2.close();
    b.close();
  });

  it('认领后旧身份再连回来，不会跟新身份抢同一个座位', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    const claimKey = a.claimKey();
    const oldToken = a.token!;
    const oldUserId = a.userId;
    expect(claimKey).toBeTruthy();

    // A 关掉网页
    a.close();
    await new Promise((r) => setTimeout(r, 300));

    // A 重开，凭凭证认领 → 新身份
    const a2 = new TestClient();
    await a2.connect();
    await a2.hello('A');
    a2.send({ t: 'room.claim', code, claimKey: claimKey! });
    await a2.waitFor((m) => m.t === 'room' && m.role === 'player');
    const newUserId = a2.userId;
    expect(newUserId).not.toBe(oldUserId);

    /*
     * **旧身份又连回来了**（比如另一个标签页还开着）。
     *
     * 他带的旧 token 必须失效 —— 否则服务端会按会话档案把他塞回房间，
     * 而座位已经是新身份的了：两处都以为自己是棋手，座位只有一个。
     */
    const a3 = new TestClient();
    await a3.connect();
    await a3.hello('A', oldToken);

    // 房间里**只能有一个**用户Id 坐在那个座位上
    const state = a2.latestRoom().state;
    const seatOwners = [state.seats.w?.userId, state.seats.b?.userId].filter(Boolean);
    expect(new Set(seatOwners).size).toBe(2);
    expect(seatOwners).toContain(newUserId);
    // 旧身份没抢到座位
    expect(seatOwners).not.toContain(oldUserId);

    a2.close();
    a3.close();
    b.close();
  });

  it('凭证对不上时拒绝认领，不会把别人的座位抢走', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    const bUserId = b.userId;
    // 拿一个瞎编的凭证去认领
    const c = new TestClient();
    await c.connect();
    await c.hello('C');
    c.send({ t: 'room.claim', code, claimKey: 'not-a-real-claim-key-000' });
    const err = await c.waitFor((m) => m.t === 'toast' && m.kind === 'error');
    expect(err.t).toBe('toast');

    // 对手的座位没被动过
    const state = b.latestRoom().state;
    const bSeat = [state.seats.w, state.seats.b].find((s) => s && s.userId === bUserId);
    expect(bSeat).toBeDefined();

    c.close();
    a.close();
    b.close();
  });

  it('对手还在时抢不走他的座位 —— 抢不到就按普通来客处理（观战）', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    await startGame(a, b);

    const keyA = a.claimKey();
    const aUserId = a.userId;

    // C 拿着 A 的凭证来认领 —— 但 A **还连着**
    const c = new TestClient();
    await c.connect();
    await c.hello('C');
    c.send({ t: 'room.claim', code: a.latestRoom().state.code, claimKey: keyA! });

    /*
     * **坐不回去，但不是把人卡在门外。**
     *
     * 凭证存放在 `localStorage` 里，而**同一浏览器的标签页之间是共享的** ——
     * 所以「凭证的主人还连着」最常见的真实场景就是：
     * 同一个浏览器开了两个标签页，一个在房里下棋，另一个拿着同一份凭证进来。
     * 这种时候把人一拒之门外是错的（他只是个普通来客），
     * 按普通加入处理才对 —— 没座位就观战。
     *
     * 座位本身**照样抢不走**（认领要求原主人已断线，这条没变）。
     */
    await c.waitFor((m) => m.t === 'room' && m.role === 'spectator');

    // A 的座位没被抢走
    const state = a.latestRoom().state;
    const aSeat = [state.seats.w, state.seats.b].find((s) => s && s.userId === aUserId);
    expect(aSeat).toBeDefined();

    c.close();
    a.close();
    b.close();
  });
});

describe('断线后回来', () => {
  it('凭 token 重连能坐回座位（身份没变）', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    await startGame(a, b);

    const token = a.token!;
    const userId = a.userId;
    a.close();
    await new Promise((r) => setTimeout(r, 200));

    const a2 = new TestClient();
    await a2.connect();
    await a2.hello('A', token);
    expect(a2.userId).toBe(userId);

    await a2.waitFor((m) => m.t === 'room');
    const state = a2.latestRoom().state;
    const seat = [state.seats.w, state.seats.b].find((s) => s && s.userId === userId);
    expect(seat).toBeDefined();
    expect(seat?.connected).toBe(true);

    a2.close();
    b.close();
  });

  it('会话档案里两个玩家都记着房间码（先入队的那个也算）', async () => {
    /*
     * 这条盯的是**根因**，不是症状。
     *
     * 症状是「服务重启后玩家回不来房间」；
     * 根因是「会话档案里没记房间码」。
     *
     * 曾经栽在这里：匹配队列里**先入队**的那个玩家是 `oppClient`，
     * 当时只给他写了 `client.roomCode`（会话档案漏记）——
     * 服务重启时没人触发「断线时补记档案」那条路，房间码就没了，
     * 他重连回来认不回房间。
     */
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    // a 是**先入队**的那个（匹配时他是 `oppClient`）
    await hub.flushNow();
    const sessions = await loadSessions();
    const recA = sessions.find((s) => s.userId === a.userId);
    const recB = sessions.find((s) => s.userId === b.userId);
    expect(recA?.roomCode).toBe(code);
    expect(recB?.roomCode).toBe(code);

    a.close();
    b.close();
  });

  it('断线在宽限期内不判负，座位还在等人', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('A'), b.hello('B')]);
    const code = await startGame(a, b);

    a.close();
    await new Promise((r) => setTimeout(r, 300));

    const room = hub.roomManager.getRoom(code);
    expect(room).toBeDefined();
    expect(room!.status).toBe('playing');
    // 座位还在（等人回来），不是被判负
    expect(room!.result).toBeUndefined();
    // 宽限期是 5 分钟 —— 断线时刻落在宽限期之内
    const goneAt = [room!.seats.w?.disconnectedAt, room!.seats.b?.disconnectedAt].find(
      (v) => typeof v === 'number',
    );
    expect(goneAt).toBeDefined();
    expect(Date.now() - goneAt!).toBeLessThan(DISCONNECT_GRACE_MS);

    b.close();
  });
});

/**
 * **旧格式存档的迁移**。
 *
 * 背景：本功能上线前，`.data/rooms.json` 里直接躺着一份房间快照本身，
 * 没有后来加的 `state` / `timeControl` / `claimKeys` 外壳。
 * 用户升级代码后磁盘上还是老文件 —— 认不出就等于把人家下到一半的棋局默默抹掉。
 *
 * 这组用例盯三件事：
 *  1. **棋局状态不丢** —— 走子、座位、时钟、回合方都还在；
 *  2. **重放能重建出同一个局面**（不是只存了个 FEN）；
 *  3. **文件顺手升级成新格式** —— 下次启动不用再迁移一遍。
 */
describe('旧格式存档迁移', () => {
  /** 旧格式样本：直接就是房间快照，没有外壳 */
  function legacyRoomFixture(): unknown {
    const game = new Chess();
    game.move('e4');
    game.move('d6');
    game.move('d4');
    game.move('Nf6');
    return {
      code: 'OLD1',
      status: 'playing',
      seats: {
        w: {
          userId: 'legacy-w',
          name: '旧白',
          color: 'w',
          connected: true,
          isAI: false,
          ready: true,
        },
        b: {
          userId: 'legacy-b',
          name: '旧黑',
          color: 'b',
          connected: true,
          isAI: false,
          ready: true,
        },
      },
      spectators: [],
      fen: game.fen(),
      moves: [
        { from: 'e2', to: 'e4', piece: 'p', color: 'w', san: 'e4', flags: 'b', ts: 1 },
        { from: 'd7', to: 'd6', piece: 'p', color: 'b', san: 'd6', flags: 'n', ts: 2 },
        { from: 'd2', to: 'd4', piece: 'p', color: 'w', san: 'd4', flags: 'b', ts: 3 },
        { from: 'g8', to: 'f6', piece: 'n', color: 'b', san: 'Nf6', flags: 'n', ts: 4 },
      ],
      inCheck: false,
      // 10 分钟制，两人各走了两步 → 反推出来的时限应该是 10+0
      clock: {
        wMs: 600_000,
        bMs: 600_000,
        incrementMs: 0,
        lastTickAt: 1,
        running: true,
        enabled: true,
      },
      chat: [],
      rematchVotes: [],
      createdAt: 1,
      updatedAt: 2,
      difficulty: 'normal',
      visibility: 'public',
    };
  }

  it('棋局状态保住，且文件升级成新格式', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'lan-chess-legacy-'));
    resetStore();
    const prevDataDir = setDataDir(tmpDir);
    try {
      // 写成**旧格式**
      await writeFile(
        path.join(tmpDir, 'rooms.json'),
        JSON.stringify([legacyRoomFixture()], null, 2),
        'utf8',
      );

      const hub = new WsHub();
      await hub.restoreFromDisk();

      const room = hub.roomManager.getRoom('OLD1');
      expect(room).toBeDefined();
      // 状态、走子、座位都在
      expect(room!.status).toBe('playing');
      expect(room!.moves.length).toBe(4);
      expect(room!.seats.w?.name).toBe('旧白');
      expect(room!.seats.b?.name).toBe('旧黑');
      // 时限从棋钟反推出来（10 分钟制）
      expect(room!.timeControl).toBe('10+0');
      // 重启后没人在线 → 座位进入「断线等重连」
      expect(room!.seats.w?.connected).toBe(false);
      expect(room!.seats.b?.connected).toBe(false);

      /*
       * **重放要重建出同一个局面** —— 只存 FEN 的话，
       * 三次重复判定会永远失效（chess.js 靠实例内部的局面出现次数）。
       */
      expect(room!.game.fen()).toBe(room!.fen);

      // 文件顺手升级成新格式（下次启动不用再迁移）
      const upgraded = JSON.parse(
        await readFile(path.join(tmpDir, 'rooms.json'), 'utf8'),
      ) as Array<{ state?: { code?: string } }>;
      expect(upgraded[0]?.state?.code).toBe('OLD1');
    } finally {
      resetStore();
      setDataDir(prevDataDir);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('认不出的存档被丢掉，不影响别的房间', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'lan-chess-legacy-bad-'));
    resetStore();
    const prevDataDir = setDataDir(tmpDir);
    try {
      await writeFile(
        path.join(tmpDir, 'rooms.json'),
        JSON.stringify([legacyRoomFixture(), { 不是房间: true }, null], null, 2),
        'utf8',
      );

      const hub = new WsHub();
      await hub.restoreFromDisk();

      expect(hub.roomManager.getRoom('OLD1')).toBeDefined();
      // 坏的那个没被当成房间塞进来
      expect(hub.roomManager.allRooms().length).toBe(1);
    } finally {
      resetStore();
      setDataDir(prevDataDir);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
