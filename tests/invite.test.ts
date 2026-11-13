/**
 * **房间邀请**的规矩（用户拍板的那条需求）：
 *
 *   1. 房间里的对局方可以把「当前房间」的邀请发给私聊对象；
 *   2. 邀请是**一条带房间码的结构化消息**（不是一句话）——
 *      客户端把它渲染成可点的卡片，对方点一下直接进房；
 *   3. **服务端把关**：不在这个房间里的人 / 观战者 / 人机局 / 已结束的房间，
 *      一律发不出去 —— 规则不能只做一层 UI 皮。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WebSocket as WsClient } from 'ws';
import { WsHub } from '@/server/ws-hub';
import { parseClientMessage, type ServerMessage } from '@/lib/protocol';

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

  /** 最新一条房间快照（还没到就等着） */
  async latestRoom(): Promise<ServerMessage & { t: 'room' }> {
    const list = this.messages.filter((m) => m.t === 'room');
    if (list.length === 0) {
      await this.waitFor((m) => m.t === 'room');
    }
    const msgs = this.messages.filter((m) => m.t === 'room');
    const msg = msgs[msgs.length - 1];
    if (!msg || msg.t !== 'room') throw new Error('不是 room 消息');
    return msg;
  }

  /** 我收到的**邀请**（kind === 'invite' 的私信） */
  invites(): Array<Extract<ServerMessage, { t: 'dm' }>['message']> {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { t: 'dm' }> => m.t === 'dm')
      .map((m) => m.message)
      .filter((msg) => msg.kind === 'invite');
  }

  close(): void {
    this.socket.close();
  }
}

/** 等一会儿，确认「什么都没发生」 */
async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

describe('房间邀请（协议层）', () => {
  it('dm.invite 能被解析，且必须带 4 位房间码', () => {
    const ok = parseClientMessage(JSON.stringify({ t: 'dm.invite', to: 'u1', roomCode: 'AB12' }));
    expect(ok).not.toBeNull();
    expect(ok?.t).toBe('dm.invite');

    // 房间码不是 4 位 → 整条消息作废（协议层就挡住，不进服务端）
    const bad = parseClientMessage(JSON.stringify({ t: 'dm.invite', to: 'u1', roomCode: 'AB1' }));
    expect(bad).toBeNull();
  });
});

describe('房间邀请（服务端规矩）', () => {
  it('房间里的对局方能发出邀请，对方收到带房间码的邀请消息', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();

    alice.send({ t: 'dm.invite', to: bob.userId, roomCode: room.state.code });
    const dm = await bob.waitFor((m) => m.t === 'dm' && m.message.kind === 'invite');

    expect(dm.t === 'dm' && dm.message.roomCode).toBe(room.state.code);
    // 发送方自己也收得到（和普通私信同一条路径：自己看得见自己发了什么）
    expect(alice.invites().length).toBe(1);
    expect(alice.invites()[0].roomCode).toBe(room.state.code);

    alice.close();
    bob.close();
  });

  it('收到邀请的人拿房间码就能进房（点一下直接进房间的那条路）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();
    alice.send({ t: 'dm.invite', to: bob.userId, roomCode: room.state.code });
    const dm = await bob.waitFor((m) => m.t === 'dm' && m.message.kind === 'invite');
    const code = dm.t === 'dm' ? dm.message.roomCode : '';

    // 卡片被点 → 客户端发 room.join
    bob.send({ t: 'room.join', code: code!, mode: 'play' });
    const joined = (await bob.waitFor(
      (m) => m.t === 'room' && m.state.code === code,
    )) as Extract<ServerMessage, { t: 'room' }>;
    expect(joined.t).toBe('room');
    // 进的是**对局方**的位置（不是观众）
    expect(joined.role).toBe('player');

    alice.close();
    bob.close();
  });

  it('不在房间里的人发邀请 → 拒收，对方一条都收不到', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();

    // Bob 根本没进这个房间，却想拿房间码去邀请人
    bob.send({ t: 'dm.invite', to: alice.userId, roomCode: room.state.code });
    const toast = await bob.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('不在这个房间'),
    );
    expect(toast.t).toBe('toast');

    await settle();
    expect(alice.invites().length).toBe(0);

    alice.close();
    bob.close();
  });

  it('观战者不能发邀请（他不是对局方）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    const carol = new TestClient();
    await Promise.all([alice.connect(), bob.connect(), carol.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B'), carol.hello('C')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();
    bob.send({ t: 'room.join', code: room.state.code, mode: 'play' });
    carol.send({ t: 'room.join', code: room.state.code, mode: 'spectate' });
    await carol.waitFor((m) => m.t === 'room' && m.state.spectators.length === 1);

    carol.send({ t: 'dm.invite', to: alice.userId, roomCode: room.state.code });
    const toast = await carol.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('不在这个房间'),
    );
    expect(toast.t).toBe('toast');
    await settle();
    expect(alice.invites().length).toBe(0);

    alice.close();
    bob.close();
    carol.close();
  });

  it('人机对局不能邀请别人（对面坐的是电脑，没有对手可抢）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0', withAI: true });
    const room = await alice.latestRoom();

    alice.send({ t: 'dm.invite', to: bob.userId, roomCode: room.state.code });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('人机'),
    );
    expect(toast.t).toBe('toast');
    await settle();
    expect(bob.invites().length).toBe(0);

    alice.close();
    bob.close();
  });

  it('对局已结束的房间不能再发邀请', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();
    // 直接把房间置为终局（认输要走一整套流程，这里只关心「结束后发不出去」）
    const internal = hub.roomManager.getRoom(room.state.code);
    expect(internal).toBeDefined();
    internal!.status = 'finished';

    alice.send({ t: 'dm.invite', to: bob.userId, roomCode: room.state.code });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('对局已结束'),
    );
    expect(toast.t).toBe('toast');
    await settle();
    expect(bob.invites().length).toBe(0);

    alice.close();
    bob.close();
  });

  it('不能给自己发邀请', async () => {
    const alice = new TestClient();
    await alice.connect();
    await alice.hello('A');

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();

    alice.send({ t: 'dm.invite', to: alice.userId, roomCode: room.state.code });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('自己'),
    );
    expect(toast.t).toBe('toast');
    await settle();
    expect(alice.invites().length).toBe(0);

    alice.close();
  });

  it('对方不在线 → 邀请发不出去（私信本来就只发给在线的人）', async () => {
    const alice = new TestClient();
    const bob = new TestClient();
    await Promise.all([alice.connect(), bob.connect()]);
    await Promise.all([alice.hello('A'), bob.hello('B')]);

    alice.send({ t: 'room.create', timeControl: '10+0' });
    const room = await alice.latestRoom();

    bob.close();
    await settle(300);

    alice.send({ t: 'dm.invite', to: bob.userId, roomCode: room.state.code });
    const toast = await alice.waitFor(
      (m) => m.t === 'toast' && m.kind === 'error' && m.message.includes('不在线'),
    );
    expect(toast.t).toBe('toast');

    alice.close();
  });
});
