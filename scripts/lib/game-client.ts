/**
 * **门禁用的极简 WebSocket 客户端**。
 *
 * 为什么要有它：浏览器门禁需要一个「对手」来陪练 ——
 * 它只做三件事：连上、登录进大厅、收发协议报文。
 *
 * 抽到 lib 里是因为**多套门禁都要它**（拖拽 / 私信 / 退出房间 / 抽签…），
 * 复制粘贴出去改一处就会漏一处。
 */
import { WebSocket } from 'ws';

export interface SeatInfo {
  userId: string;
  name: string;
  color: string;
  connected?: boolean;
  isAI?: boolean;
  ready?: boolean;
}

export interface RoomSnapshot {
  code: string;
  status: string;
  fen: string;
  seats: { w?: SeatInfo; b?: SeatInfo };
  /** 颜色待定的玩家（还没抽签） */
  pending?: { userId: string; name: string };
  spectators: Array<{ userId: string; name: string }>;
  /** 已走的棋（门禁用它判「这一步有没有被接受」） */
  moves?: Array<{ from: string; to: string; promotion?: string }>;
  result?: { winner: string; reason: string };
}

/** 等一小会儿 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GameClient {
  private readonly ws: WebSocket;
  private readonly msgs: Array<Record<string, any>> = [];
  session: { token: string; userId: string; name: string } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const m = JSON.parse(String(raw)) as Record<string, any>;
        this.msgs.push(m);
        if (m.t === 'session' && !this.session) {
          this.session = { token: m.token, userId: m.userId, name: m.name };
        }
      } catch {
        /* 不是 JSON 就忽略 */
      }
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws 连接超时')), 8000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ws 连接失败：${String(e)}`));
      });
    });
  }

  send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * 登录（建立身份）。
   *
   * @param token 带上它就**恢复旧身份**（服务端按 token 找回 userId 与房间）。
   *                不带 = 新身份。
   */
  async hello(name: string, token?: string): Promise<void> {
    this.send({ t: 'hello', name, token });
    await this.waitFor((m) => (m.t === 'session' ? m : null), `${name} 的 session`);
    const session = this.msgs.find((m) => m.t === 'session');
    if (session) {
      this.session = {
        token: String(session.token),
        userId: String(session.userId),
        name: String(session.name),
      };
    }
  }

  /**
   * 已收到的**全部**报文。
   *
   * 用来判「某个字段有没有发给别人」——
   * 比如座位凭证绝不能出现在对手收到的报文里。
   */
  allMessages(): Array<Record<string, any>> {
    return [...this.msgs];
  }

  async waitFor<T>(
    pred: (m: Record<string, any>) => T | null,
    label: string,
    timeoutMs = 15000,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const m of this.msgs) {
        const v = pred(m);
        if (v !== null && v !== undefined) return v;
      }
      await sleep(100);
    }
    throw new Error(`等待「${label}」超时`);
  }

  /** 最新一份房间快照 */
  latestRoom(): RoomSnapshot | null {
    for (let i = this.msgs.length - 1; i >= 0; i -= 1) {
      const m = this.msgs[i];
      if (m.t === 'room' && m.state) return m.state as RoomSnapshot;
    }
    return null;
  }

  /**
   * 最新一份大厅快照。
   *
   * 为什么需要它：`waitFor` 是**从最早**开始扫的 ——
   * 想等「大厅里出现了某个房间」必须自己轮询最新那份，
   * 否则拿到的是建房**之前**的那份快照（里面当然没有那个房间）。
   */
  latestLobby(): { rooms?: Array<Record<string, any>> } | null {
    for (let i = this.msgs.length - 1; i >= 0; i -= 1) {
      const m = this.msgs[i];
      if (m.t === 'lobby' && m.state) return m.state as { rooms?: Array<Record<string, any>> };
    }
    return null;
  }

  /** 最新一条带身份视角的房间报文（`role` / `color` 只在这条里） */
  latestRoomWithRole(): { state: RoomSnapshot; role: string; color?: string } | null {
    for (let i = this.msgs.length - 1; i >= 0; i -= 1) {
      const m = this.msgs[i];
      if (m.t === 'room' && m.state) {
        return {
          state: m.state as RoomSnapshot,
          role: String(m.role ?? ''),
          color: m.color as string | undefined,
        };
      }
    }
    return null;
  }

  /** 已收到的报文条数（用来只等「之后」的那几条） */
  get msgCount(): number {
    return this.msgs.length;
  }

  /**
   * 等一条**下标 >= since** 的房间消息。
   *
   * 为什么不能直接用 `waitFor`：那个是**从最早**开始扫的，
   * 于是第二次建房时拿到的是**上一次的**房间快照 —— 房间码是旧的，
   * 浏览器被导航回上一局，后面的门禁全在错的局面上跑。
   */
  async waitForRoomSince(
    since: number,
    label: string,
    timeoutMs = 15000,
    pred?: (s: RoomSnapshot) => boolean,
  ): Promise<RoomSnapshot> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (let i = since; i < this.msgs.length; i += 1) {
        const m = this.msgs[i];
        if (m.t !== 'room' || !m.state) continue;
        const state = m.state as RoomSnapshot;
        if (!pred || pred(state)) return state;
      }
      await sleep(100);
    }
    throw new Error(`等待「${label}」超时`);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 「抽签 + 准备」这套新规则的公共助手                                  */
/* ------------------------------------------------------------------ */

/**
 * 某个 userId 在这局里是不是**执白方**。
 *
 * ## 为什么需要
 *
 * 黑白现在是**抽签**定的 —— 「谁先进房谁执白」的老假设在门禁里**不再成立**。
 * 门禁必须先问一句「浏览器到底是白还是黑」，再决定用哪一套着法
 * （拖白兵 d2→d4 还是拖黑兵 d7→d5）。
 *
 * @param room   房间快照（用 `latestRoom()` 取）
 * @param userId 要判断的人的 userId
 */
export function sideOf(
  room: RoomSnapshot | null,
  userId: string | undefined,
): 'w' | 'b' | undefined {
  if (!room || !userId) return undefined;
  if (room.seats.w?.userId === userId) return 'w';
  if (room.seats.b?.userId === userId) return 'b';
  return undefined;
}

/**
 * 按**名字**找某一方的执色。
 *
 * 门禁里浏览器的用户名是写死的（例如「箭头验收员」），
 * 而房间快照里的座位带 `name` —— 比 userId 好用（不用去翻浏览器的 token）。
 */
export function sideOfName(
  room: RoomSnapshot | null,
  name: string,
): 'w' | 'b' | undefined {
  if (!room) return undefined;
  if (room.seats.w?.name === name) return 'w';
  if (room.seats.b?.name === name) return 'b';
  return undefined;
}

/**
 * 等**抽签完成**（房间进入「准备中」）。
 *
 * 真人对局现在是「两人到齐 → 抽签定黑白 → **双方都点准备** → 才开始走子」。
 * 所以门禁里凡是「两个人进房就能走子」的地方，都得补上这一步。
 *
 * @param since 只看这之后收到的房间快照（`msgCount` 取的起点）
 */
export async function waitPreparing(
  c: GameClient,
  since = 0,
  timeoutMs = 15000,
): Promise<RoomSnapshot> {
  return c.waitForRoomSince(
    since,
    '等待抽签完成（房间进入准备中）',
    timeoutMs,
    (s) => s.status === 'preparing',
  );
}

/**
 * 等**开局**（房间进入「playing」）。
 *
 * @param since 只看这之后收到的房间快照
 */
export async function waitPlaying(
  c: GameClient,
  since = 0,
  timeoutMs = 15000,
): Promise<RoomSnapshot> {
  return c.waitForRoomSince(since, '等待开局', timeoutMs, (s) => s.status === 'playing');
}
