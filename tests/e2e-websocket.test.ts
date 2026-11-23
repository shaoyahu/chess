/**
 * 端到端冒烟测试：启动真实的 HTTP + WebSocket 服务器，
 * 用两个真实客户端模拟「两个人在局域网对战」+ 第三人观战。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WebSocket as WsClient } from 'ws';
import { WsHub } from '@/server/ws-hub';
import { parseClientMessage, type ServerMessage } from '@/lib/protocol';
import { DISCONNECT_GRACE_MS, DM_MAX_UNANSWERED, DM_SEND_MIN_INTERVAL_MS } from '@/lib/constants';
import { Chess } from 'chess.js';
import type { RoomState } from '@/lib/types';

let server: Server;
let hub: WsHub;
let port: number;
const baseUrl = (): string => `ws://127.0.0.1:${port}/ws`;

/** 测试用客户端：收集消息并支持等待条件 */
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

  async hello(name: string): Promise<void> {
    this.send({ t: 'hello', name, token: this.token });
    await this.waitFor((m) => m.t === 'session');
    const session = this.messages.find((m) => m.t === 'session');
    if (session && session.t === 'session') {
      this.token = session.token;
      this.userId = session.userId;
    }
  }

  /** 等待满足条件的消息出现（轮询已收到的消息） */
  async waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 从后往前找：取**最新**一条满足条件的消息
      for (let i = this.messages.length - 1; i >= 0; i -= 1) {
        if (predicate(this.messages[i])) return this.messages[i];
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `等待超时。最后收到的消息：${JSON.stringify(this.messages.slice(-5).map((m) => m.t))}`,
    );
  }

  /** 拿到最新的房间快照 */
  async latestRoom(): Promise<RoomState> {
    const rooms = this.messages.filter((m) => m.t === 'room');
    if (rooms.length === 0) {
      await this.waitFor((m) => m.t === 'room');
    }
    const list = this.messages.filter((m) => m.t === 'room');
    const msg = list[list.length - 1];
    if (!msg || msg.t !== 'room') throw new Error('不是 room 消息');
    return msg.state;
  }

  /** 我自己的执色（从最新一条 room 消息里取；观战者是 undefined） */
  async myColor(): Promise<'w' | 'b' | undefined> {
    const list = this.messages.filter((m) => m.t === 'room');
    const msg = list[list.length - 1];
    if (!msg || msg.t !== 'room') return undefined;
    return msg.color;
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * 真人对局现在**抽签定黑白 + 双方都点「准备」才开局**。
 *
 * 所以测试里凡是「两个人进房 → 直接走子」的地方，
 * 都得补上「等人齐 → 双方准备」这两步。
 */
async function readyBoth(a: TestClient, b: TestClient): Promise<void> {
  // 先等抽签完成（status=preparing），否则「准备」会被服务端拒掉
  await Promise.all([
    a.waitFor((m) => m.t === 'room' && m.state.status === 'preparing'),
    b.waitFor((m) => m.t === 'room' && m.state.status === 'preparing'),
  ]);
  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  await a.waitFor((m) => m.t === 'room' && m.state.status === 'playing');
}

/**
 * 谁执白 —— 白方先走。
 *
 * **按执色判，不按「谁先进房」判** —— 黑白现在是抽签定的。
 */
async function whiteSide(...clients: TestClient[]): Promise<TestClient> {
  for (const c of clients) {
    await c.waitFor((m) => m.t === 'room' && (m.color === 'w' || m.color === 'b'));
    if ((await c.myColor()) === 'w') return c;
  }
  throw new Error('没找到执白方');
}

beforeAll(async () => {
  hub = new WsHub();
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket: WebSocket) => hub.handleConnection(socket));
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('双人实时对战', () => {
  it('两个不同用户名可以配对开局并互相看到对方的走子', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('球球'), bob.hello('小明')]);

    // 快速匹配
    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });

    // 两人到齐 → 抽签定黑白 → 双方准备 → 开局
    await readyBoth(alice, bob);

    const aliceRoom = await alice.latestRoom();
    const bobRoom = await bob.latestRoom();
    expect(aliceRoom.code).toBe(bobRoom.code);
    expect(aliceRoom.status).toBe('playing');
    // 两人各执一边 —— 谁执白由**抽签**决定，不再是「先进队列者执白」
    expect([aliceRoom.seats.w?.name, aliceRoom.seats.b?.name].sort()).toEqual(
      ['小明', '球球'].sort(),
    );
    expect(bobRoom.seats.w?.name).toBe(aliceRoom.seats.w?.name);

    // **白方**走一步 e4，黑方应实时收到
    const white = await whiteSide(alice, bob);
    const black = white === alice ? bob : alice;
    white.send({ t: 'move', from: 'e2', to: 'e4' });
    await black.waitFor((m) => m.t === 'room' && m.state.moves.length === 1);
    const afterMove = await black.latestRoom();
    expect(afterMove.moves[0].san).toBe('e4');
    expect(afterMove.fen.split(' ')[1]).toBe('b');

    // 黑方走一步，白方应看到
    black.send({ t: 'move', from: 'e7', to: 'e5' });
    await white.waitFor((m) => m.t === 'room' && m.state.moves.length === 2);
    const afterBlack = await white.latestRoom();
    expect(afterBlack.moves[1].san).toBe('e5');

    alice.close();
    bob.close();
  });

  it('服务端拒绝非法着法并给出提示', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);
    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });
    await readyBoth(alice, bob);

    // 白方试图跳过 e4 直接走到 e5 —— 非法
    // （**必须由轮到的一方来走**：服务端先查「轮不轮到你」，再查着法合法性）
    const white = await whiteSide(alice, bob);
    white.send({ t: 'move', from: 'e2', to: 'e5' });
    const toast = await white.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('非法'),
    );
    expect(toast.t).toBe('toast');

    // 局面未改变
    const room = await white.latestRoom();
    expect(room.moves).toHaveLength(0);

    alice.close();
    bob.close();
  });

  it('超时判负但**不结束对局**：结果锁定、双方还能继续走棋', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('球球'), bob.hello('小明')]);
    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });
    await readyBoth(alice, bob);

    const white = await whiteSide(alice, bob);
    const black = white === alice ? bob : alice;
    const code = (await alice.latestRoom()).code;
    const room = hub.roomManager.getRoom(code);
    expect(room).toBeDefined();

    /*
     * 把白方的棋钟直接拨成「已经超时」——
     * 门禁不打算真等 5 分钟（最短时限就是 5 分钟）。
     * 服务端每秒 tick 一次 → 最多一秒多就会判超时。
     */
    room!.clock.wMs = 30;
    room!.clock.lastTickAt = Date.now() - 100;

    await white.waitFor((m) => m.t === 'room' && m.state.resultLocked === true, 5000);

    const state = await white.latestRoom();
    // 结果：白方超时 → 黑方胜，并且**锁定**
    expect(state.result).toEqual({ winner: 'b', reason: 'timeout' });
    expect(state.resultLocked).toBe(true);
    expect(state.flagged).toContain('w');
    // **关键**：棋局还在继续（不是终局）
    expect(state.status).toBe('playing');

    // 超时之后**还能继续走棋**，对方也照样收到
    white.send({ t: 'move', from: 'e2', to: 'e4' });
    await black.waitFor((m) => m.t === 'room' && m.state.moves.length === 1);
    const after = await black.latestRoom();
    expect(after.moves[0].san).toBe('e4');
    expect(after.status).toBe('playing');
    // 走完那一步，欠掉的时间被结算进棋钟 → **负数**
    expect(after.clock.wMs).toBeLessThan(0);
    // 结果没有被后续事件改写
    expect(after.result).toEqual({ winner: 'b', reason: 'timeout' });

    alice.close();
    bob.close();
  });

  it('第三人可以观战并实时看到走子', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    const carol = new TestClient();
    await Promise.all([alice.connect(), bob.connect(), carol.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B'), carol.hello('C')]);

    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });
    await readyBoth(alice, bob);
    const room = await alice.latestRoom();

    // 小红以观战身份加入
    carol.send({ t: 'room.join', code: room.code, mode: 'spectate' });
    await carol.latestRoom();
    const carolRoom = await carol.latestRoom();
    expect(carolRoom.spectators.map((s) => s.name)).toContain('C');
    // 观战者没有座位 —— 两个座位都是棋手的（黑白由抽签决定）
    expect([carolRoom.seats.w?.name, carolRoom.seats.b?.name].sort()).toEqual(['A', 'B']);

    // 走一步，观战者应收到
    const white = await whiteSide(alice, bob);
    white.send({ t: 'move', from: 'e2', to: 'e4' });
    await carol.waitFor((m) => m.t === 'room' && m.state.moves.length === 1);
    const carolAfter = await carol.latestRoom();
    expect(carolAfter.moves[0].san).toBe('e4');

    alice.close();
    bob.close();
    carol.close();
  });

  it('房间码加入可以开局', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '5+0' });
    const room = await alice.latestRoom();
    expect(room.code).toHaveLength(4);
    expect(room.status).toBe('waiting');

    bob.send({ t: 'room.join', code: room.code, mode: 'play' });
    await readyBoth(alice, bob);
    const bobRoom = await bob.latestRoom();
    // 两人各执一边（黑白由抽签决定）
    expect([bobRoom.seats.w?.name, bobRoom.seats.b?.name].sort()).toEqual(['A', 'B']);

    alice.close();
    bob.close();
  });

  it('聊天能广播给房内所有人', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);
    alice.send({ t: 'room.create' });
    const room = await alice.latestRoom();
    bob.send({ t: 'room.join', code: room.code, mode: 'play' });
    await readyBoth(alice, bob);

    alice.send({ t: 'chat', text: '你好' });
    const chat = await bob.waitFor((m) => m.t === 'chat');
    if (chat.t === 'chat') {
      expect(chat.message.text).toBe('你好');
      expect(chat.message.name).toBe('A');
    }

    alice.close();
    bob.close();
  });

  it('刷新重连后凭 token 恢复身份与座位', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);
    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });
    const room = await alice.latestRoom();
    const aliceToken = alice.token!;

    // 模拟刷新：断开后用同一个 token 重连
    alice.close();
    await new Promise((r) => setTimeout(r, 100));

    const reconnected = new TestClient();
    await reconnected.connect();
    reconnected.token = aliceToken;
    await reconnected.hello('A');
    expect(reconnected.userId).toBe(alice.userId);

    // 座位应恢复
    await reconnected.waitFor((m) => m.t === 'room');
    const reRoom = await reconnected.latestRoom();
    expect(reRoom.code).toBe(room.code);
    /*
     * 座位要恢复，但**不能写死是哪一边** ——
     * 黑白现在是**抽签**定的，先进队列的不一定是白方。
     */
    const mySeat = [reRoom.seats.w, reRoom.seats.b].find((s) => s?.userId === alice.userId);
    expect(mySeat).toBeDefined();
    expect(mySeat?.name).toBe('A');
    expect(mySeat?.connected).toBe(true);

    bob.close();
    reconnected.close();
  });

  it('刷新重连后仍可继续走子（座位没有因重连丢失）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);
    alice.send({ t: 'queue.join' });
    await alice.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    bob.send({ t: 'queue.join' });
    await readyBoth(alice, bob);
    const aliceToken = alice.token!;

    alice.close();
    await new Promise((r) => setTimeout(r, 100));

    const reconnected = new TestClient();
    await reconnected.connect();
    reconnected.token = aliceToken;
    await reconnected.hello('A');
    await reconnected.waitFor((m) => m.t === 'room');

    // 重连后**自己那一方**仍能走子
    // （黑白是抽签定的，重连不能把他挪到另一边去）
    const white = await whiteSide(reconnected, bob);
    const other = white === reconnected ? bob : reconnected;
    white.send({ t: 'move', from: 'e2', to: 'e4' });
    await other.waitFor((m) => m.t === 'room' && m.state.moves.length === 1);
    const otherRoom = await other.latestRoom();
    expect(otherRoom.moves[0].san).toBe('e4');

    bob.close();
    reconnected.close();
  });
});

describe('协议健壮性', () => {
  it('非法消息被忽略而不是打崩连接', async () => {
    const client = new TestClient();
    await client.connect();
    await client.hello('A');

    client.socket.send('这不是 JSON');
    client.socket.send(JSON.stringify({ t: '不存在的类型' }));
    client.socket.send(JSON.stringify({ t: 'move', from: 'x', to: 'yy' }));

    // 连接应仍然可用
    client.send({ t: 'ping' });
    await client.waitFor((m) => m.t === 'pong');
    client.close();
  });

  it('未登录时不能执行房间操作', async () => {
    const client = new TestClient();
    await client.connect();
    client.send({ t: 'room.create' });
    const toast = await client.waitFor(
      (m) => m.t === 'toast' && m.message.includes('请先登录'),
    );
    expect(toast.t).toBe('toast');
    client.close();
  });

  it('协议解析器会拒绝畸形的移动消息', () => {
    expect(parseClientMessage('{"t":"move","from":"e2"}')).toBeNull();
    expect(parseClientMessage('{"t":"move","from":"e2","to":"e4"}')).not.toBeNull();
    expect(parseClientMessage('{"t":"move","from":"e2","to":"e4","promotion":"p"}')).toBeNull();
  });
});

/**
 * 心跳兜底 —— 防止「人走了，局还挂着」。
 *
 * 真实场景：设备休眠、切 WiFi、拔网线，TCP 连接会变成**半开**，
 * 服务端既收不到 close 也收不到任何数据。
 * 如果只依赖 TCP close 事件，座位就会永远算「在线」，
 * 房间永远显示「进行中」，双方既走不掉也结束不了（僵尸房间）。
 *
 * 这里用 ws 的 `_autoPong = false` 模拟一个**不回 pong 的半开连接**，
 * 验证服务端会主动把它掐掉并把座位标记为断线。
 * 心跳间隔与超时阈值被压缩到毫秒级，让测试跑得快。
 */
describe('心跳兜底（半开连接不能变成僵尸房间）', () => {
  it('不回 pong 的连接会被服务端主动断开，座位标记为断线', async () => {
    const tinyHub = new WsHub({ heartbeatIntervalMs: 40, heartbeatTimeoutMs: 150 });
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket: WebSocket) => tinyHub.handleConnection(socket));
    const srv = createServer();
    srv.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const p = (srv.address() as { port: number }).port;

    // 连上后**不回应 pong**，模拟设备休眠造成的半开连接
    const raw = new WsClient(`ws://127.0.0.1:${p}/ws`);
    (raw as unknown as { _autoPong: boolean })._autoPong = false;
    await new Promise<void>((r) => raw.once('open', () => r()));
    raw.send(JSON.stringify({ t: 'hello', name: '半开连接' }));
    raw.send(JSON.stringify({ t: 'room.create', timeControl: '10+0' }));

    // 服务端应当主动把它掐掉
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('半开连接没有被主动断开')), 5000);
      raw.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // 客户端观察到 close 与服务端处理 close 是两条独立的事件循环，
    // 稍等一下让服务端的 onClose 跑完（否则断言会比断线处理更早）
    await new Promise((r) => setTimeout(r, 200));

    // 座位应被标记为断线（而不是永远 connected）
    // 注：**先进房的人此刻是「颜色待定」**，还没落到 seats.w / seats.b 上，
    // 所以断线标记落在 room.pending 上。
    const rooms = tinyHub.roomManager.allRooms();
    expect(rooms.length).toBe(1);
    expect(rooms[0].pending?.connected).toBe(false);
    expect(rooms[0].pending?.disconnectedAt).toBeGreaterThan(0);

    raw.close();
    wss.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});


/**
 * 人机对局回归测试。
 *
 * 曾经的真实 bug：人机房间创建后 AI 执白先走，但服务端只在「人类落子后」
 * 才排期 AI 走子 —— 初始局面轮到 AI，人类走不了第一步，
 * 于是 AI 的第一步永远没人触发，对局卡死在「等待对手走棋」。
 */
describe('人机对局', () => {
  it('玩家执黑时 AI 执白先走，玩家不会被卡在等待状态', async () => {
    const player = new TestClient();
    await player.connect();
    await player.hello('人机玩家');

    // 玩家选「我执黑」→ AI 执白 → **AI 先走**（正是当年卡死的那条路径）
    player.send({ t: 'room.create', timeControl: '10+0', withAI: true, color: 'b' });

    // AI 必须自己走出第一步
    const moved = await player.waitFor(
      (m) => m.t === 'room' && m.state.moves.length >= 1,
      10000,
    );
    expect(moved.t).toBe('room');
    if (moved.t !== 'room') return;

    expect(moved.state.seats.w?.isAI).toBe(true);
    expect(moved.state.seats.b?.isAI).toBe(false);
    // AI 走完应轮到玩家（黑方）
    expect(moved.state.fen.split(' ')[1]).toBe('b');

    // 玩家落子合法 → AI 应招
    const before = moved.state.moves.length;
    const chess = new Chess(moved.state.fen);
    const pick = chess.moves({ verbose: true })[0];
    player.send({ t: 'move', from: pick.from, to: pick.to, promotion: pick.promotion });

    const replied = await player.waitFor(
      (m) => m.t === 'room' && m.state.moves.length >= before + 2,
      15000,
    );
    expect(replied.t).toBe('room');
    player.close();
  });

  it('玩家执白时由玩家先走，AI 应招', async () => {
    const player = new TestClient();
    await player.connect();
    await player.hello('人机玩家');

    player.send({ t: 'room.create', timeControl: '10+0', withAI: true, color: 'w' });

    const opened = await player.waitFor((m) => m.t === 'room' && m.state.status === 'playing');
    expect(opened.t).toBe('room');
    if (opened.t !== 'room') return;
    expect(opened.state.seats.w?.isAI).toBe(false);
    expect(opened.state.seats.b?.isAI).toBe(true);
    // 白方（玩家）先走
    expect(opened.state.fen.split(' ')[1]).toBe('w');

    const chess = new Chess(opened.state.fen);
    const pick = chess.moves({ verbose: true })[0];
    player.send({ t: 'move', from: pick.from, to: pick.to, promotion: pick.promotion });

    const replied = await player.waitFor(
      (m) => m.t === 'room' && m.state.moves.length >= 2,
      15000,
    );
    expect(replied.t).toBe('room');
    player.close();
  });
});

/**
 * 大厅列表必须跟着房间一起消失。
 *
 * 曾经的真实 bug：房间被清理（删掉）后，服务端只落了盘、**没有广播大厅**，
 * 于是客户端手里还留着那张已经不存在的房间卡 ——
 * 表现就是用户说的「人走了，这盘游戏还没有结束吗」「一直挂在大厅列表里」。
 *
 * 这里锁定的是「房间没了 → 大厅广播里必须没有它」这条端到端契约。
 */
describe('大厅列表会随房间消失而刷新', () => {
  it('房间被清理后，旁观者收到的大厅快照里不再有这个房间', async () => {
    // 清理间隔压到 80 毫秒，测试不必等 30 秒
    const tinyHub = new WsHub({ cleanupIntervalMs: 80 });
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket: WebSocket) => tinyHub.handleConnection(socket));
    const srv = createServer();
    srv.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const p = (srv.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${p}/ws`;

    const owner = new TestClient(url);
    await owner.connect();
    await owner.hello('房主');

    owner.send({ t: 'room.create', timeControl: '10+0' });
    const roomMsg = await owner.waitFor((m) => m.t === 'room');
    if (roomMsg.t !== 'room') throw new Error('不是 room 消息');
    const code = roomMsg.state.code;

    // 旁观者：一直连着，但**不进房间**（进房间就变成在线观战者，房间不会被清理）
    // 注意顺序：必须先建房再接入旁观者，否则它的首条大厅快照里根本没有这个房间，
    // 后面「快照里没有该房间」的断言会立刻被这条旧快照误命中。
    const watcher = new TestClient(url);
    await watcher.connect();
    await watcher.hello('旁观者');
    // 基线：旁观者的大厅快照里确实有这个房间
    const baseline = await watcher.waitFor(
      (m) => m.t === 'lobby' && m.state.rooms.some((r) => r.code === code),
      5000,
    );
    expect(baseline.t).toBe('lobby');

    // 房主离开 → 座位标记断线
    owner.close();
    await new Promise((r) => setTimeout(r, 250));

    // 把断线时刻往前拨过整个宽限期 → 清理时房间会被删掉
    // 注：房主是**第一个进房的人**，此时他「颜色待定」，断线标记落在 pending 上
    const room = tinyHub.roomManager.getRoom(code);
    expect(room).toBeDefined();
    expect(room!.pending).toBeDefined();
    // 用常量算，**不写死数字** —— 宽限期一改，这里跟着改，
    // 否则测试会静默地变成「拨了 61 秒但宽限期是 5 分钟」而不再触发过期
    room!.pending!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;

    // 关键断言：旁观者必须收到一条「已经没有这个房间」的大厅快照
    const updated = await watcher.waitFor(
      (m) => m.t === 'lobby' && !m.state.rooms.some((r) => r.code === code),
      5000,
    );
    expect(updated.t).toBe('lobby');
    if (updated.t !== 'lobby') return;
    expect(updated.state.rooms.some((r) => r.code === code)).toBe(false);

    // 服务端侧房间也确实没了
    expect(tinyHub.roomManager.getRoom(code)).toBeUndefined();

    watcher.close();
    wss.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('双方都掉线且过了宽限期后，房间回落成「等待对手」并广播大厅', async () => {
    // 清理间隔拉到 60 秒：这一轮只允许 tick() 结算，避免 cleanup 抢先删房
    const tinyHub = new WsHub({ cleanupIntervalMs: 60_000 });
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket: WebSocket) => tinyHub.handleConnection(socket));
    const srv = createServer();
    srv.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const p = (srv.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${p}/ws`;

    const a = new TestClient(url);
    const b = new TestClient(url);
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.hello('甲'), b.hello('乙')]);

    // 配对开局
    a.send({ t: 'queue.join' });
    await a.waitFor((m) => m.t === 'toast' && m.message.includes('匹配队列'));
    b.send({ t: 'queue.join' });
    await readyBoth(a, b);
    const roomMsg = await a.waitFor((m) => m.t === 'room');
    if (roomMsg.t !== 'room') throw new Error('不是 room 消息');
    const code = roomMsg.state.code;

    // 旁观者一直连着（不进房间），用来观察大厅广播
    const watcher = new TestClient(url);
    await watcher.connect();
    await watcher.hello('旁观');

    // 双方一起离开
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 300));

    // 把双方的断线时刻拨过整个宽限期
    const room = tinyHub.roomManager.getRoom(code);
    expect(room).toBeDefined();
    // 用常量算，**不写死数字**（宽限期改了这里跟着改）
    room!.seats.w!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;
    room!.seats.b!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;

    // 下一个 tick（≤1 秒）应把僵死座位清掉、房间回落「等待对手」，并广播大厅
    const updated = await watcher.waitFor(
      (m) =>
        m.t === 'lobby' &&
        m.state.rooms.some((r) => r.code === code && r.status === 'waiting'),
      5000,
    );
    expect(updated.t).toBe('lobby');
    if (updated.t !== 'lobby') return;
    const summary = updated.state.rooms.find((r) => r.code === code);
    expect(summary?.status).toBe('waiting');
    // 双方都没回来 → playerOnline 为 false
    expect(summary?.playerOnline).toBe(false);

    watcher.close();
    wss.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

/**
 * 聊天与私信的规矩（用户拍板）：
 *
 *   1. **快捷聊天不进聊天记录** —— 只飘弹幕，记录里留的全是正经聊的话；
 *   2. **观战的人不能打字聊天**，只能发快捷聊天，
 *      但照样**看得见**棋手打的字；
 *   3. **私信只能发快捷短语** —— 不能自己打字。
 */
describe('聊天与私信的规矩', () => {
  it('快捷聊天带 quick 标记，且不写进服务端的聊天记录', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();
    bob.send({ t: 'room.join', code: room.code, mode: 'play' });
    await readyBoth(alice, bob);

    // 打字的 → 进记录
    alice.send({ t: 'chat', text: '打字的进记录' });
    const typed = await bob.waitFor((m) => m.t === 'chat' && !m.message.quick);
    expect(typed.t === 'chat' && typed.message.text).toBe('打字的进记录');

    // 快捷的 → 不进记录，但照样广播出去（客户端据此只飘弹幕）
    alice.send({ t: 'chat.quick', text: '好棋' });
    const quick = await bob.waitFor((m) => m.t === 'chat' && m.message.quick === true);
    expect(quick.t === 'chat' && quick.message.text).toBe('好棋');

    // **服务端的记录**里只有打字的 那一条 —— 快捷聊天没混进去
    const internal = hub.roomManager.getRoom(room.code);
    expect(internal).toBeDefined();
    expect(internal!.chat.map((c) => c.text)).toEqual(['打字的进记录']);

    alice.close();
    bob.close();
  });

  it('观战者打字被拒，但能收到棋手的聊天，也能发快捷聊天', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    const carol = new TestClient();
    await Promise.all([alice.connect(), bob.connect(), carol.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B'), carol.hello('C')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();
    bob.send({ t: 'room.join', code: room.code, mode: 'play' });
    await readyBoth(alice, bob);
    carol.send({ t: 'room.join', code: room.code, mode: 'spectate' });
    await carol.waitFor((m) => m.t === 'room' && m.state.spectators.length === 1);

    // 观战者打字 → 服务端拒绝，并给出**看得见**的原因
    carol.send({ t: 'chat', text: '我来评个理' });
    const toast = await carol.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('观战'),
    );
    expect(toast.t).toBe('toast');

    // 拒绝就是拒绝：房内**任何人都**收不到这条打字消息
    await new Promise((r) => setTimeout(r, 150));
    for (const c of [alice, bob, carol]) {
      const leaked = c.messages.find((m) => m.t === 'chat' && m.message.text === '我来评个理');
      expect(leaked).toBeUndefined();
    }

    // 观战者发**快捷聊天**是可以的（这是他唯一的发言方式）
    carol.send({ t: 'chat.quick', text: '好棋' });
    const quick = await alice.waitFor((m) => m.t === 'chat' && m.message.quick === true);
    expect(quick.t === 'chat' && quick.message.text).toBe('好棋');

    // 棋手打的字，观战者照样看得见
    alice.send({ t: 'chat', text: '棋手的话' });
    const seen = await carol.waitFor((m) => m.t === 'chat' && m.message.text === '棋手的话');
    expect(seen.t === 'chat' && seen.message.quick).toBeFalsy();

    alice.close();
    bob.close();
    carol.close();
  });

  it('私信只认快捷短语，自由文本被拒', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    // 白名单里的短语 → 双方都收到
    alice.send({ t: 'dm.send', to: bob.userId, text: '来一盘？' });
    const dm = await bob.waitFor((m) => m.t === 'dm');
    expect(dm.t === 'dm' && dm.message.text).toBe('来一盘？');

    // 白名单之外的自由文本 → 拒收（对方一条都收不到）
    alice.send({ t: 'dm.send', to: bob.userId, text: '随便打几个字试试' });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('快捷消息'),
    );
    expect(toast.t).toBe('toast');
    expect(
      bob.messages.find((m) => m.t === 'dm' && m.message.text === '随便打几个字试试'),
    ).toBeUndefined();

    alice.close();
    bob.close();
  });

  it('私信有最小发送间隔：连发只发得出一条（限频在服务端）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    /*
     * 连发 3 条 —— **只能有一条真的发出去**。
     *
     * 为什么这条规则要落在服务端：私信每发一条，**对面**就会弹一条提示；
     * 不限频的话，按住一颗快捷短语连点就能把对面顶栏糊成一整列。
     * 客户端那层「按钮变灰」只是给人看的提示，改个协议就能绕过去 ——
     * 绕过去的那种不算规则。
     */
    alice.send({ t: 'dm.send', to: bob.userId, text: '来一盘？' });
    await bob.waitFor((m) => m.t === 'dm');
    alice.send({ t: 'dm.send', to: bob.userId, text: '马上到' });
    alice.send({ t: 'dm.send', to: bob.userId, text: '缺个对手' });

    // 被拒的那两条要给出**看得见**的原因
    const rejected = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('太快'),
    );
    expect(rejected.t).toBe('toast');

    // 对方只收到**一条**
    await new Promise((r) => setTimeout(r, 200));
    const received = bob.messages.filter((m) => m.t === 'dm');
    expect(received.length).toBe(1);
    expect(received[0].message.text).toBe('来一盘？');

    // 等过限频窗口（DM_SEND_MIN_INTERVAL_MS）→ 又能发了（限频是**延迟**，不是封禁）
    await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    alice.send({ t: 'dm.send', to: bob.userId, text: '马上到' });
    await bob.waitFor((m) => m.t === 'dm' && m.message.text === '马上到');

    alice.close();
    bob.close();
  });

  /**
   * **私信的互惠限流**（用户 2026-11-20 提的）：
   *
   *   「当一个人发送 3 条私信后，另一个必须发送私信后第一个人才能继续发送私信，
   *     其中另一个发送私信和第一个人继续发送私信同样需要遵守 3 条数量限制。」
   *
   * 也就是：**能不能继续说，取决于对方有没有理我**。
   * 一问一答能正常聊；单方面刷屏聊不下去。
   */
  it('私信有互惠限流：连发 3 条后必须等对方回一条才能再发', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    /* 连发 3 条 —— 每条之间要过「最小发送间隔」那个桶 */
    for (const t of ['来一盘？', '马上到', '缺个对手']) {
      alice.send({ t: 'dm.send', to: bob.userId, text: t });
      await bob.waitFor((m) => m.t === 'dm' && m.message.text === t);
      await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    }

    /* 第 4 条：对方还没回消息 → **服务端拒收** */
    alice.send({ t: 'dm.send', to: bob.userId, text: '下次一定' });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('还没回'),
    );
    expect(toast.t).toBe('toast');

    /* 对方**只**收到 3 条（被拒的那条根本没发出去） */
    await new Promise((r) => setTimeout(r, 200));
    expect(bob.messages.filter((m) => m.t === 'dm').length).toBe(DM_MAX_UNANSWERED);

    /* 对方回一条 → 额度重置，Alice 又能发了 */
    await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    bob.send({ t: 'dm.send', to: alice.userId, text: '来一盘？' });
    await alice.waitFor((m) => m.t === 'dm' && m.message.text === '来一盘？');
    await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    alice.send({ t: 'dm.send', to: bob.userId, text: '马上到' });
    await bob.waitFor((m) => m.t === 'dm' && m.message.text === '马上到');

    alice.close();
    bob.close();
  });

  it('互惠限流对双方一视同仁：对方连发 3 条之后同样发不出第 4 条', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    for (const t of ['来一盘？', '马上到', '缺个对手']) {
      bob.send({ t: 'dm.send', to: alice.userId, text: t });
      await alice.waitFor((m) => m.t === 'dm' && m.message.text === t);
      await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    }

    /* Bob 的第 4 条同样被拒 —— 规则不偏向任何一边 */
    bob.send({ t: 'dm.send', to: alice.userId, text: '下次一定' });
    const toast = await bob.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('还没回'),
    );
    expect(toast.t).toBe('toast');
    await new Promise((r) => setTimeout(r, 200));
    expect(alice.messages.filter((m) => m.t === 'dm').length).toBe(DM_MAX_UNANSWERED);

    alice.close();
    bob.close();
  });

  it('私信额度会推给客户端：remaining 从满一路降到 0，对方回话后回到满', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    /** 客户端收到的最新一条额度状态里，Alice 对 Bob 还剩几条 */
    const remainingFor = (c: TestClient, peer: string): number => {
      const list = c.messages.filter((m) => m.t === 'dm.state');
      const last = list[list.length - 1];
      if (!last || last.t !== 'dm.state') throw new Error('没收到 dm.state');
      const hit = last.states.find((s) => s.peer === peer);
      return hit ? hit.remaining : DM_MAX_UNANSWERED;
    };

    /* 发一条 → 额度从满（3）降到 2 */
    alice.send({ t: 'dm.send', to: bob.userId, text: '来一盘？' });
    await alice.waitFor(
      (m) => m.t === 'dm.state' && m.states.some((s) => s.peer === bob.userId && s.remaining === 2),
    );
    expect(remainingFor(alice, bob.userId!)).toBe(2);

    /* 再发两条 → 降到 0（被锁住） */
    for (const t of ['马上到', '缺个对手']) {
      await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
      alice.send({ t: 'dm.send', to: bob.userId, text: t });
    }
    await alice.waitFor(
      (m) => m.t === 'dm.state' && m.states.some((s) => s.peer === bob.userId && s.remaining === 0),
    );
    expect(remainingFor(alice, bob.userId!)).toBe(0);

    /* 对方回一条 → 我的额度回到满 */
    await new Promise((r) => setTimeout(r, DM_SEND_MIN_INTERVAL_MS + 100));
    bob.send({ t: 'dm.send', to: alice.userId, text: '来一盘？' });
    await alice.waitFor(
      (m) => m.t === 'dm.state' && m.states.some((s) => s.peer === bob.userId && s.remaining === 3),
    );
    expect(remainingFor(alice, bob.userId!)).toBe(3);

    alice.close();
    bob.close();
  });
});
