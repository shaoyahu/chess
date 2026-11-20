/**
 * 房间管理器 —— 服务端的对局权威。
 *
 * 职责：
 *  - 房间生命周期（创建 / 加入 / 离开 / 观战）
 *  - 权威走子校验（chess.js）
 *  - 棋钟计时与超时判负
 *  - 聊天、认输、和棋、再来一局
 *  - 断线宽限与判负
 *  - AI 对手（服务端执行，与人类同一路径）
 */
import { randomInt, randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import {
  CHAT_MIN_INTERVAL_MS,
  CHAT_MAX_LEN,
  CLOCK_TICK_MS,
  DEFAULT_TIME_CONTROL,
  DISCONNECT_GRACE_MS,
  MAX_SPECTATORS,
  OFFER_TIMEOUT_MS,
  QUICK_CHAT_MAX_LEN,
  QUICK_CHAT_MIN_INTERVAL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  START_FEN,
  TIME_CONTROLS,
  type TimeControlKey,
} from '../lib/constants';
import { applyMoveToGame, describeResult, statusOf, turnOf } from '../lib/chess-engine';
import { isRuleEnd } from '../lib/takeback';
import { analyzePosition } from '../lib/engine/analysis';
import type {
  ChatMessage,
  ClockState,
  Color,
  Difficulty,
  GameResult,
  MoveRecord,
  RoomArchive,
  RoomState,
  RoomVisibility,
  Seat,
  Spectator,
} from '../lib/types';
import { DEFAULT_DIFFICULTY } from '../lib/types';

/** 一个已连接的用户（由 ws-hub 持有，这里只存逻辑身份） */
export interface PlayerIdentity {
  userId: string;
  name: string;
}

/**
 * tick（每秒）产生的事件。
 *
 * `offer-expired` = 请求超时被**自动拒绝**（和棋 / 悔棋）。
 */
export type RoomEvent =
  | { room: RoomInternal; event: 'timeout' | 'abandon' }
  | { room: RoomInternal; event: 'offer-expired'; kind: 'draw' | 'takeback'; by: Color };

/** 房间内部结构（比对外快照多存一些运行时字段） */
export interface RoomInternal extends RoomState {
  /** 时限配置键 */
  timeControl: TimeControlKey;
  /**
   * **活着的** Chess 实例 —— 房间局面的唯一权威。
   *
   * 为什么不能只存 FEN：
   *   `chess.js` 判「三次重复局面」靠的是实例内部维护的**局面出现次数**，
   *   那是走子历史的产物。只存 FEN 的话，每次都用 `new Chess(fen)` 重建，
   *   历史就断了 —— `isThreefoldRepetition()` 永远返回 false，
   *   反复捉子的对局永远下不完。
   *
   * 所以：**走子、悔棋都在同一个实例上做**，`room.fen` 只是它的镜像（给前端用）。
   */
  game: Chess;
  /** 最近一次聊天时间，用于限频 */
  lastChatAt: number;
  /**
   * 最近一次**快捷聊天**（弹幕）时间，用于限频。
   *
   * 单独一个计时器：快捷聊天和普通聊天是两件事，
   * 共用一个限频会让「刚发过弹幕就打不了字」。
   */
  lastQuickChatAt: number;
  /** AI 思考是否已排期 */
  aiScheduled: boolean;
  /**
   * AI 落子排期的**代号**。
   *
   * 每次排期 +1，回调带着自己的代号回来落地 —— 对不上就说明这次排期
   * 已经被**作废**（比如玩家在 AI 想的时候点了「撤回」），直接放弃这一手。
   *
   * 为什么不能只看 `aiScheduled`：撤回之后玩家可能马上又走一步，
   * 那时新的 AI 排期已经开始了，老的回调才刚返回 ——
   * 只看 `aiScheduled` 会把新排期的「正在想」标记抹掉，
   * 于是下一次落子又排一次，AI 会在同一回合连走两步。
   */
  aiScheduleId: number;
  /** 是否已经被移除（延迟清理） */
  dead: boolean;
}

function randomRoomCode(): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function emptyClock(key: TimeControlKey): ClockState {
  const cfg = TIME_CONTROLS[key] ?? TIME_CONTROLS[DEFAULT_TIME_CONTROL];
  return {
    wMs: cfg.initialMs,
    bMs: cfg.initialMs,
    incrementMs: cfg.incrementMs,
    lastTickAt: Date.now(),
    running: false,
    enabled: cfg.initialMs > 0,
  };
}

export interface CreateRoomOptions {
  timeControl?: TimeControlKey;
  withAI?: boolean;
  /** AI 难度档（人机对局用） */
  difficulty?: Difficulty;
  /** 房间可见性：公开房在列表里可直接加入，邀请房只认房间码 */
  visibility?: RoomVisibility;
}

/**
 * **旧格式存档** —— 本次「断线/关网页/服务重启恢复」上线**之前**写下的存档。
 *
 * 当时 `.data/rooms.json` 里直接躺着一份房间快照本身（`code` / `seats` / `moves` / `clock` …），
 * 没有后来加的 `state` / `timeControl` / `claimKeys` 这层外壳。
 *
 * 为什么必须专门兼容：
 *  - 存档是**跨版本**存在的东西 —— 用户升级代码后，磁盘上还是老文件。
 *    直接忽略老格式，就等于把人家下到一半的棋局**默默抹掉**；
 *  - 但旧格式**没有座位凭证**，也没有落盘的会话档案。
 *    所以迁移只能保住「棋局本身」（走子、棋钟、聊天、回合方、座位归属），
 *    至于「座位主人关掉网页后还能不能认领回来」——
 *    取决于他浏览器里有没有那张凭证，旧存档里**根本没有这份信息**，迁移补不出来。
 *    这是旧存档的固有限制，不是迁移做得不够。
 */
type LegacyRoomState = Partial<RoomState> & { code?: string };

/**
 * **把磁盘上读回来的东西认成标准存档** —— 认不出就返回 undefined。
 *
 * 两种形态都收：
 *  - **新格式** `{ state, timeControl, claimKeys }` —— 原样使用；
 *  - **旧格式** 一份裸的房间快照 —— 补齐缺的字段，标成「迁移来的」。
 *
 * 为什么要在这里做（而不是 store.ts）：
 *  存档的**结构知识**归房间管理器（它是存的东西的主人），
 *  store 只负责「把字节读成 JSON」—— 不该知道存档长什么样。
 */
export function normalizeArchive(raw: unknown): { archive: RoomArchive; legacy: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  /*
   * **新格式**：有 `state` 外壳。
   */
  if (obj.state && typeof obj.state === 'object') {
    const state = obj.state as RoomState;
    if (typeof state.code !== 'string' || !state.code) return undefined;
    const claimKeys = (obj.claimKeys ?? {}) as Partial<NonNullable<RoomArchive['claimKeys']>>;
    return {
      archive: {
        state,
        timeControl: (obj.timeControl as TimeControlKey) ?? DEFAULT_TIME_CONTROL,
        claimKeys: { w: claimKeys.w, b: claimKeys.b, pending: claimKeys.pending },
      },
      legacy: false,
    };
  }

  /*
   * **旧格式**：文件里直接就是房间快照。
   */
  const legacy = obj as LegacyRoomState;
  if (typeof legacy.code !== 'string' || !legacy.code) return undefined;
  const moves = legacy.moves ?? [];
  const state: RoomState = {
    ...(legacy as RoomState),
    code: legacy.code,
    seats: legacy.seats ?? {},
    spectators: legacy.spectators ?? [],
    moves,
    chat: legacy.chat ?? [],
    rematchVotes: legacy.rematchVotes ?? [],
    inCheck: legacy.inCheck ?? false,
    fen: legacy.fen ?? START_FEN,
    clock: legacy.clock ?? {
      wMs: 0,
      bMs: 0,
      incrementMs: 0,
      lastTickAt: Date.now(),
      running: false,
      enabled: false,
    },
  };
  return {
    archive: {
      state,
      timeControl: inferLegacyTimeControl(state.clock, moves),
      // 旧格式没有凭证这一层；但万一有（万一某次手改过文件），别把它丢了
      claimKeys: {
        w: legacy.seats?.w?.claimKey,
        b: legacy.seats?.b?.claimKey,
        pending: legacy.pending?.claimKey,
      },
    },
    legacy: true,
  };
}

/**
 * **从旧存档的棋钟反推房间时限**。
 *
 * 旧格式没存时限，只存了「还剩多少毫秒」和「每步增量」——
 * 所以只能**反推**：走子记录里能数出每一方走了多少步，
 * 加上增量就能估出「当初的初始时长」，再拿它去 `TIME_CONTROLS` 里对号入座。
 *
 * 为什么值得做：时限只是**显示用的标签**（恢复后的棋钟用的是快照里剩下的时间），
 * 猜错不影响对局 —— 但标签写着「不限时」而实际是 10 分钟，对用户是骗人。
 */
function inferLegacyTimeControl(clock: ClockState | undefined, moves: MoveRecord[]): TimeControlKey {
  // 旧存档里 `enabled=false` 就是「不限时」
  if (!clock || !clock.enabled) return 'none';
  const increment = clock.incrementMs ?? 0;
  const perColor = { w: 0, b: 0 };
  for (const move of moves) {
    if (move.color === 'w' || move.color === 'b') perColor[move.color] += 1;
  }
  const need = Math.max(
    (clock.wMs ?? 0) + perColor.w * increment,
    (clock.bMs ?? 0) + perColor.b * increment,
  );
  const candidates = Object.entries(TIME_CONTROLS)
    // 'none' 的增量也是 0，但它表示「不限时」—— 旧存档说启用着棋钟，就排除它
    .filter(([key, value]) => key !== 'none' && value.incrementMs === increment && value.initialMs >= need)
    .sort((a, b) => a[1].initialMs - b[1].initialMs);
  if (candidates.length > 0) return candidates[0][0] as TimeControlKey;
  return DEFAULT_TIME_CONTROL;
}

export class RoomManager {
  /**
   * **抽签用的随机源**。
   *
   * 默认是 `crypto.randomInt(0, 2)` —— 不可预测，这是分配「谁执白」的公平性基础。
   *
   * 为什么要能注入：抽签是**随机**的，所以「谁执白」这件事在测试里
   * 天然不可预测。注入一个确定性源，测试就能断言「先进的人执白」这类
   * 具体结果；反过来，要测「抽签真的会换边」时，喂一个
   * 「先 0 后 1」的序列源就行。
   */
  private readonly drawSource: () => number;

  constructor(drawSource: () => number = () => randomInt(0, 2)) {
    this.drawSource = drawSource;
  }

  private rooms = new Map<string, RoomInternal>();

  /** 创建房间 */
  createRoom(options: CreateRoomOptions = {}): RoomInternal {
    const timeControl = options.timeControl ?? DEFAULT_TIME_CONTROL;
    let code = randomRoomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard < 100) {
      code = randomRoomCode();
      guard += 1;
    }
    const now = Date.now();
    const room: RoomInternal = {
      code,
      status: 'waiting',
      seats: {},
      spectators: [],
      fen: START_FEN,
      moves: [],
      inCheck: false,
      resultLocked: false,
      flagged: [],
      clock: emptyClock(timeControl),
      chat: [],
      rematchVotes: [],
      createdAt: now,
      updatedAt: now,
      timeControl,
      difficulty: options.difficulty ?? DEFAULT_DIFFICULTY,
      visibility: options.visibility ?? 'public',
      game: new Chess(START_FEN),
      lastChatAt: 0,
      lastQuickChatAt: 0,
      aiScheduled: false,
      aiScheduleId: 0,
      dead: false,
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): RoomInternal | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  allRooms(): RoomInternal[] {
    return [...this.rooms.values()];
  }

  /** 对外可见的房间快照（剔除运行时字段） */
  publicView(room: RoomInternal): RoomState {
    const {
      lastChatAt: _l,
      aiScheduled: _a,
      aiScheduleId: _s,
      dead: _d,
      timeControl: _t,
      game: _g,
      ...view
    } = room;
    /*
     * **座位凭证必须从广播里剔掉。**
     *
     * 凭证是「这个座位是我的」的证明 —— 一旦广播给房里的所有人，
     * 任何人都能拿它把座位抢走（哪怕那个座位的主人一秒前还在线）。
     *
     * 所以它**不走公共快照**，而是走 `sendRoom` 单独发给座位本人
     * （见 ws-hub 的 sendRoom）。
     */
    const stripClaim = (seat: Seat | undefined): Seat | undefined =>
      seat
        ? {
            userId: seat.userId,
            name: seat.name,
            color: seat.color,
            connected: seat.connected,
            disconnectedAt: seat.disconnectedAt,
            isAI: seat.isAI,
            ready: seat.ready,
          }
        : undefined;
    return {
      ...view,
      seats: { w: stripClaim(room.seats.w), b: stripClaim(room.seats.b) },
      // 待抽签的玩家：只把「身份」发出去，连接状态是内部字段
      pending: room.pending
        ? { userId: room.pending.userId, name: room.pending.name }
        : undefined,
      spectators: room.spectators.map((s) => ({ ...s })),
      moves: room.moves.map((m) => ({ ...m })),
      chat: room.chat.slice(-100),
      clock: { ...room.clock },
      rematchVotes: [...room.rematchVotes],
      // 超时锁定标记与已超时方 —— 前端要靠它显示「已超时」和「再来一局」
      resultLocked: Boolean(room.resultLocked),
      flagged: [...(room.flagged ?? [])],
    };
  }

  /**
   * 某个身份在这个房间里的**座位凭证**（只给他本人）。
   *
   * 正式座位看 `seats.w/b`，待抽签的槽位看 `pending`。
   */
  claimKeyOf(room: RoomInternal, userId: string): string | undefined {
    const seat = this.findSeat(room, userId);
    if (seat) return seat.claimKey;
    if (room.pending?.userId === userId) return room.pending.claimKey;
    return undefined;
  }

  /**
   * 凭凭证找出**座位原主人**的 userId。
   *
   * 必须在**认领之前**调用 —— 认领之后座位就换成新身份了，
   * 原主人再也找不回来。
   */
  ownerOfClaim(room: RoomInternal, claimKey: string): string | undefined {
    if (room.pending?.claimKey === claimKey) return room.pending.userId;
    for (const color of ['w', 'b'] as Color[]) {
      const seat = room.seats[color];
      if (seat && seat.claimKey === claimKey) return seat.userId;
    }
    return undefined;
  }

  /**
   * **存档视图**（落盘用）—— 在对外快照之外，多存恢复时必须的东西。
   *
   * 两样东西是 `publicView` **故意不给**的：
   *  - `timeControl` —— 房间时限。恢复后没它，棋钟的初始时长就废了；
   *  - `claimKey` —— 座位凭证。恢复后没它，玩家认不回自己的座位。
   *
   * 它们只进磁盘，不进任何广播。
   */
  archiveView(room: RoomInternal): RoomArchive {
    return {
      state: this.publicView(room),
      timeControl: room.timeControl,
      claimKeys: {
        w: room.seats.w?.claimKey,
        b: room.seats.b?.claimKey,
        pending: room.pending?.claimKey,
      },
    };
  }

  /** 加入房间：mode='play' 抢空座；mode='spectate' 观战 */
  joinRoom(
    code: string,
    identity: PlayerIdentity,
    mode: 'play' | 'spectate',
  ): { ok: true; room: RoomInternal } | { ok: false; message: string } {
    const room = this.getRoom(code);
    if (!room) return { ok: false, message: '房间不存在' };

    // 加入前先结算断线超时的座位：
    // 否则新玩家会坐进一个「对方早就该被判负」的房间，刚坐下就被判负（开局即终局）。
    this.settleExpiredSeats(room);
    if (room.status === 'finished') {
      return { ok: false, message: '对局已结束' };
    }

    // 已在房中
    const existingSeat = this.findSeat(room, identity.userId);
    if (existingSeat) {
      existingSeat.connected = true;
      delete existingSeat.disconnectedAt;
      return { ok: true, room };
    }
    const existingSpec = room.spectators.find((s) => s.userId === identity.userId);
    if (existingSpec) {
      existingSpec.connected = true;
      return { ok: true, room };
    }

    if (mode === 'play') {
      // 两方都坐满了 → 只能观战
      if (room.seats.w && room.seats.b) {
        if (room.spectators.length >= MAX_SPECTATORS) {
          return { ok: false, message: '观战人数已满' };
        }
        room.spectators.push({ userId: identity.userId, name: identity.name, connected: true });
        return { ok: true, room };
      }

      // 已经在「待抽签」名单里（重连）
      if (room.pending?.userId === identity.userId) {
        room.pending.connected = true;
        delete room.pending.disconnectedAt;
        return { ok: true, room };
      }

      /*
       * **第二个人到了 → 抽签**。
       *
       * 抽签在这里（而不是「谁先进来谁定」）才有意义：
       * 先进来的那位如果一进房就定好了边，观感上像是他自己挑的；
       * 等对手到齐再由服务端一次性掷，才是真中立。
       */
      if (room.pending) {
        /*
         * 抽签：先进来的那位（pending）拿到一个正式座位。
         *
         * **凭证跟着人一起转** —— pending 的 claimKey 传进 assignColors，
         * 落到正式座位上。否则「等对手时关掉网页 → 对手来了 → 抽签 →
         * 再关掉网页 → 重开」这条链上，凭证会在抽签那一步丢掉。
         */
        this.assignColors(room, room.pending, {
          userId: identity.userId,
          name: identity.name,
          connected: true,
          claimKey: randomUUID(),
        });
        return { ok: true, room };
      }

      /*
       * 房间是空的 → 先进来的人**颜色待定**。
       *
       * 注意他**仍然是个玩家**（不是观战者）——
       * 前端拿 `room.pending` 判断自己在不在局里。
       */
      room.pending = {
        userId: identity.userId,
        name: identity.name,
        connected: true,
        // 座位凭证：等对手时关掉网页，重开后还能认领这个槽位
        claimKey: randomUUID(),
      };
      room.status = 'waiting';
      this.maybeStart(room);
      return { ok: true, room };
    }

    if (room.spectators.length >= MAX_SPECTATORS) {
      return { ok: false, message: '观战人数已满' };
    }
    room.spectators.push({ userId: identity.userId, name: identity.name, connected: true });
    return { ok: true, room };
  }

  /**
   * **抽签**：决定谁执白。
   *
   * 用 `crypto.randomInt` 而不是 `Math.random()` ——
   * 后者可预测（能被算出来），前者不可预测。
   * 这是分配「谁执白」的公平性基础，不能用可预测的源。
   */
  private drawWhite(): 'first' | 'second' {
    return this.drawColor() === 'w' ? 'first' : 'second';
  }

  /** 随机抽一个颜色（各 50%） */
  private drawColor(): Color {
    return this.drawSource() < 1 ? 'w' : 'b';
  }

  /**
   * **抽签定黑白**，并让房间进入「准备」阶段。
   *
   * @param first 先进来的那位（颜色待定的那位）
   * @param second 后进来的那位
   */
  private assignColors(
    room: RoomInternal,
    first: { userId: string; name: string; connected?: boolean; claimKey?: string },
    second: { userId: string; name: string; connected?: boolean; claimKey?: string },
  ): void {
    const firstIsWhite = this.drawWhite() === 'first';
    const white = firstIsWhite ? first : second;
    const black = firstIsWhite ? second : first;
    room.seats.w = {
      userId: white.userId,
      name: white.name,
      color: 'w',
      connected: white.connected ?? true,
      isAI: false,
      ready: false,
      // 座位凭证：认领用的那一串。**已存在就沿用** ——
      // 待抽签阶段就拿到了凭证的玩家，抽签后凭证不变（他认的还是同一个座位）。
      claimKey: white.claimKey ?? randomUUID(),
    };
    room.seats.b = {
      userId: black.userId,
      name: black.name,
      color: 'b',
      connected: black.connected ?? true,
      isAI: false,
      ready: false,
      claimKey: black.claimKey ?? randomUUID(),
    };
    room.pending = undefined;
    room.status = 'preparing';
    this.maybeStart(room);
  }

  /**
   * 「我准备好了」—— 真人对局在抽签之后、正式开局之前，双方各点一次。
   *
   * **双方都点了才开局**（白方先走）。
   */
  markReady(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (room.status !== 'preparing') return { ok: false, message: '当前不是准备阶段' };
    if (seat.isAI) return { ok: false, message: 'AI 不需要准备' };
    seat.ready = true;
    this.maybeStart(room);
    return { ok: true };
  }

  /** 放置 AI 座位 */
  placeAI(room: RoomInternal, color: Color): void {
    room.seats[color] = {
      userId: `ai-${randomUUID().slice(0, 8)}`,
      name: '电脑',
      color,
      connected: true,
      isAI: true,
    };
    this.maybeStart(room);
  }

  /**
   * 配对开局：落座两名真人并开始对局。
   * 走这条路而不是在外部直接改 seats，是为了保证匹配产生的房间
   * 与「创建房间」产生的房间行为一致（棋钟启用、局面重置、状态正确）。
   */
  setupMatch(room: RoomInternal, first: PlayerIdentity, second: PlayerIdentity): void {
    // 快速匹配同样**抽签** —— 先进队列不等于执白
    this.assignColors(
      room,
      { ...first, connected: true, claimKey: randomUUID() },
      { ...second, connected: true, claimKey: randomUUID() },
    );
  }

  /** 人机开局：玩家坐指定颜色，AI 坐另一方 */
  setupVsAI(room: RoomInternal, human: PlayerIdentity, humanColor: 'random' | Color): void {
    /*
     * 玩家执什么颜色：
     *   · `'random'` → 服务端抽签（各 50%）
     *   · `'w'` / `'b'` → 玩家自己挑
     */
    const color: Color = humanColor === 'random' ? this.drawColor() : humanColor;
    const humanColorResolved = color;
    const aiColor: Color = humanColorResolved === 'w' ? 'b' : 'w';
    room.seats[aiColor] = {
      userId: `ai-${randomUUID().slice(0, 8)}`,
      name: '电脑',
      color: aiColor,
      connected: true,
      isAI: true,
      // AI 视为「已准备」—— 人机对局不走准备环节
      ready: true,
    };
    room.seats[humanColorResolved] = {
      userId: human.userId,
      name: human.name,
      color: humanColorResolved,
      ready: true,
      connected: true,
      isAI: false,
      // 座位凭证：人机局关掉网页再打开，也要能坐回原位
      claimKey: randomUUID(),
    };
    this.maybeStart(room);
  }

  /** 离开房间 */
  leaveRoom(room: RoomInternal, identity: PlayerIdentity): void {
    // 待抽签的玩家离开 → 房间重新变成「等人来」
    if (room.pending?.userId === identity.userId) {
      room.pending = undefined;
      room.status = 'waiting';
    }
    const seat = this.findSeat(room, identity.userId);
    if (seat) {
      /*
       * 玩家主动离开：直接判负（若对局已开始）。
       *
       * 注意「判负」之后**不能再把房间改回 waiting** ——
       * 那会把刚刚定下的胜负抹掉：对手那边看到的应该是
       * 「对局结束、我方判负」，而不是「空房间」。
       */
      const decided = room.status === 'playing' || room.status === 'finished';
      if (room.status === 'playing') {
        const winner: Color = seat.color === 'w' ? 'b' : 'w';
        this.finish(room, { winner, reason: 'abandon' });
      }
      delete room.seats[seat.color];
      if (!decided) {
        /*
         * 另一方**退回「颜色待定」** ——
         * 颜色只在开局那一刻定；剩下的人换对手了，就得跟新对手重抽。
         * （不做这个的话，就会出现「后进的人接着用上一局的颜色」的破事。）
         *
         * **对局已经分出胜负时不退** ——
         * 输了的人没有「换对手重抽」这回事，对手也得留在座位上，
         * 否则胜负记录就跟着空座位一起没了。
         */
        const other = seat.color === 'w' ? room.seats.b : room.seats.w;
        if (other && !other.isAI) {
          room.pending = {
            userId: other.userId,
            name: other.name,
            connected: other.connected,
          };
          delete room.seats[other.color];
        }
        room.status = 'waiting';
      }
      room.clock.running = false;
      room.rematchVotes = [];
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      room.takebackOffer = undefined;
    }
    room.spectators = room.spectators.filter((s) => s.userId !== identity.userId);
    this.maybeStart(room);
  }

  /** 断开连接（保留座位，等待重连） */
  disconnect(room: RoomInternal, identity: PlayerIdentity): void {
    if (room.pending?.userId === identity.userId) {
      room.pending.connected = false;
      room.pending.disconnectedAt = Date.now();
    }
    const seat = this.findSeat(room, identity.userId);
    if (seat) {
      seat.connected = false;
      seat.disconnectedAt = Date.now();
      // 对方掉线时暂停棋钟
      this.syncClockRunning(room);
    }
    const spec = room.spectators.find((s) => s.userId === identity.userId);
    if (spec) spec.connected = false;
  }

  /** 重连 */
  reconnect(room: RoomInternal, identity: PlayerIdentity): void {
    if (room.pending?.userId === identity.userId) {
      room.pending.connected = true;
      delete room.pending.disconnectedAt;
    }
    const seat = this.findSeat(room, identity.userId);
    if (seat) {
      seat.connected = true;
      delete seat.disconnectedAt;
    }
    const spec = room.spectators.find((s) => s.userId === identity.userId);
    if (spec) spec.connected = true;
    this.syncClockRunning(room);
  }

  /**
   * **认领座位** —— 凭座位凭证把座位转给新身份。
   *
   * 这是「关掉网页再打开」的恢复路径：
   *  - `sessionStorage` 里的 token 随标签页一起没了 → 重开后是**新身份**；
   *  - 但座位凭证存在 `localStorage` 里 → 还在；
   *  - 凭它就能把**原来那个座位**转给新身份，而不是变成一个观战者。
   *
   * 规则（只有一条，不搞例外）：
   *  - 凭证对得上 **且原主人已断线** → 座位**转**给新身份
   *    （旧的 userId 换掉，棋钟/走子记录全保留）；
   *  - 否则 → 拒绝。
   *
   * **「原主人已断线」是硬条件** —— 没有它，任何人只要拿到凭证
   * 就能在原主人正连着的时候把座位抢走，棋直接被打断。
   * 凭证只发给座位本人，而它只会在「关掉网页」这一种场景下被用，
   * 那时原主人必然已经断线。
   *
   * @param claimKey 座位凭证
   * @param identity 新身份（重连后的那个）
   * @returns 认领到的颜色（'w' / 'b' / 'pending'），没认领到返回 undefined
   */
  claimSeat(
    room: RoomInternal,
    claimKey: string,
    identity: PlayerIdentity,
  ): Color | 'pending' | undefined {
    // 待抽签的槽位（颜色还没定）
    if (room.pending && room.pending.claimKey === claimKey) {
      // 原主人还连着 → 不给抢
      if (room.pending.connected) return undefined;
      room.pending.userId = identity.userId;
      room.pending.name = identity.name;
      room.pending.connected = true;
      delete room.pending.disconnectedAt;
      this.syncClockRunning(room);
      return 'pending';
    }
    // 正式座位
    for (const color of ['w', 'b'] as Color[]) {
      const seat = room.seats[color];
      if (!seat || seat.claimKey !== claimKey) continue;
      // 原主人还连着 → 不给抢
      if (seat.connected) return undefined;
      // 座位转给新身份：换 userId，但**保留**颜色、准备状态、走子记录
      seat.userId = identity.userId;
      seat.name = identity.name;
      seat.connected = true;
      delete seat.disconnectedAt;
      this.syncClockRunning(room);
      return color;
    }
    return undefined;
  }

  /**
   * 这个座位凭证是不是**还被人占着**（原主人还连着）。
   *
   * 用途：分辨「坐不回去」的两种原因 ——
   *  - **座位还被人占着** → 多半是**同一个浏览器的另一个标签页**拿着凭证
   *    （凭证存在 `localStorage` 里，而标签页之间是共享的）。
   *    这种情况下**不能把人卡在门外**：按普通加入处理就行
   *    （换个设备打开同一个房间，走的也是这一条）。
   *  - **座位已经不在了**（对局结束 / 凭证失效）→ 明确告诉玩家，
   *    别让他在一个「座位早就没了」的房间里当观众。
   */
  claimHeldByLiveOwner(room: RoomInternal, claimKey: string): boolean {
    if (room.pending && room.pending.claimKey === claimKey) {
      return Boolean(room.pending.connected);
    }
    for (const color of ['w', 'b'] as Color[]) {
      const seat = room.seats[color];
      if (seat && seat.claimKey === claimKey) return Boolean(seat.connected);
    }
    return false;
  }

  /**
   * **从存档重建房间** —— 服务重启后把没下完的对局恢复出来。
   *
   * 关键点：**必须重放走子重建 `Chess` 实例**，不能直接 `new Chess(fen)`。
   *
   * 为什么：`chess.js` 判「三次重复局面」靠的是实例内部维护的**局面出现次数**，
   * 那是走子历史的产物。只拿当前 FEN 新建实例的话历史就断了 ——
   * `isThreefoldRepetition()` 永远返回 false，反复捉子的对局永远下不完。
   *
   * 存档里存了完整的 `moves`（每一步的 from/to/升变），
   * 所以能**一步一步重放**重建出等价的历史。
   *
   * 恢复后的房间一律标记为「**全部断线**」——
   * 重启后没有任何人是连着的（连接都断了），
   * 于是走「断线宽限期」那条路：玩家回来（凭 token 或座位凭证）就能续上，
   * 超时才判负。跟「服务没重启、但所有人同时断线」是同一种情形。
   */
  restoreRoom(raw: unknown): RoomInternal | undefined {
    /*
     * 先把磁盘上的东西认成标准存档 —— 新旧两种格式都收（见 `normalizeArchive`）。
     *
     * 认不出 → 这个房间救不回来，直接放弃它 —— 一个坏房间留在服务里比没有更糟。
     */
    const normalized = normalizeArchive(raw);
    if (!normalized) return undefined;
    const archive = normalized.archive;
    const snapshot = archive.state;
    if (this.rooms.has(snapshot.code)) return this.rooms.get(snapshot.code);

    const game = new Chess(START_FEN);
    /*
     * 重放走子。
     *
     * 用 `applyMoveToGame` 而不是 `game.move()` ——
     * 前者会做升变处理（`promotion` 默认后），跟实战落子走同一条路径，
     * 重放出来的实例和当初那个**行为一致**。
     *
     * 任何一步重放失败（存档损坏 / 版本不兼容）→ 这个房间救不回来，
     * 直接放弃它 —— 一个坏房间留在服务里比没有更糟。
     */
    for (const move of snapshot.moves ?? []) {
      try {
        applyMoveToGame(game, { from: move.from, to: move.to, promotion: move.promotion });
      } catch {
        return undefined;
      }
    }

    const now = Date.now();
    const claimKeys = archive.claimKeys ?? {};
    const room: RoomInternal = {
      code: snapshot.code,
      status: snapshot.status,
      seats: {
        w: snapshot.seats?.w
          ? {
              ...snapshot.seats.w,
              // 座位凭证还原回来 —— 否则玩家认不回自己的座位
              claimKey: claimKeys.w,
              // 重启后没人在线 —— 座位进入「断线等重连」状态
              connected: false,
              disconnectedAt: now,
            }
          : undefined,
        b: snapshot.seats?.b
          ? {
              ...snapshot.seats.b,
              claimKey: claimKeys.b,
              connected: false,
              disconnectedAt: now,
            }
          : undefined,
      },
      pending: snapshot.pending
        ? {
            userId: snapshot.pending.userId,
            name: snapshot.pending.name,
            claimKey: claimKeys.pending,
            connected: false,
            disconnectedAt: now,
          }
        : undefined,
      spectators: (snapshot.spectators ?? []).map((s) => ({
        ...s,
        connected: false,
      })),
      fen: snapshot.fen,
      moves: (snapshot.moves ?? []).map((m) => ({ ...m })),
      result: snapshot.result,
      // 超时锁定状态要一起恢复 —— 否则重启后锁定的结果会被后来的终局改写
      resultLocked: Boolean(snapshot.resultLocked),
      flagged: [...(snapshot.flagged ?? [])],
      inCheck: snapshot.inCheck,
      clock: { ...snapshot.clock, running: false, lastTickAt: now },
      chat: (snapshot.chat ?? []).map((m) => ({ ...m })),
      rematchVotes: [...(snapshot.rematchVotes ?? [])],
      difficulty: snapshot.difficulty,
      visibility: snapshot.visibility,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      timeControl: archive.timeControl,
      game,
      lastChatAt: 0,
      lastQuickChatAt: 0,
      aiScheduled: false,
      aiScheduleId: 0,
      dead: false,
    };
    this.rooms.set(room.code, room);
    return room;
  }

  /**
   * **批量恢复** —— 返回「恢复了几个」和「其中几个是从旧格式迁移来的」。
   *
   * 为什么要分开报：
   *  - 「读到了 N 个存档」和「真的恢复了 N 个房间」不是一回事 ——
   *    认不出的、房间号撞了的，都恢复不了。只报前者会**说谎**；
   *  - 迁移来的数量要单独报，因为那是**需要人知道的事**：
   *    旧格式的存档没有凭证，玩家能不能认回座位跟新格式不一样。
   */
  restoreRooms(raws: unknown[]): { restored: number; migrated: number } {
    let restored = 0;
    let migrated = 0;
    for (const raw of raws) {
      const normalized = normalizeArchive(raw);
      if (!normalized) continue;
      const code = normalized.archive.state.code;
      /*
       * 房间号撞了 → 这份存档用不上（先到的那个房间已经在内存里）。
       *
       * 要**在这里**就跳过，不能交给 `restoreRoom` 返回「已存在的房间」——
       * 那样会被当成「恢复了」计数，**报的数比真的多**。
       */
      if (this.rooms.has(code)) continue;
      const room = this.restoreRoom(raw);
      if (!room) continue;
      restored += 1;
      if (normalized.legacy) migrated += 1;
    }
    return { restored, migrated };
  }

  findSeat(room: RoomInternal, userId: string): Seat | undefined {
    return room.seats.w?.userId === userId ? room.seats.w : room.seats.b?.userId === userId ? room.seats.b : undefined;
  }

  /** 当前轮到谁走 */
  turnOfRoom(room: RoomInternal): Color {
    return turnOf(room.fen);
  }

  /** 座位是否坐满 */
  isFull(room: RoomInternal): boolean {
    return Boolean(room.seats.w && room.seats.b);
  }

  /** 双方到齐则开局 */
  private maybeStart(room: RoomInternal): void {
    if (room.status === 'finished') return;
    if (!this.isFull(room)) {
      room.status = 'waiting';
      room.clock.running = false;
      return;
    }
    /*
     * **真人对局要双方都「准备」才开局** ——
     * 抽签之后白方先走，得给他一点时间看清自己执的是哪一边。
     *
     * 人机对局不等：AI 不需要准备，玩家点完就开。
     */
    const hasAI = Boolean(room.seats.w?.isAI || room.seats.b?.isAI);
    const allReady = Boolean(room.seats.w?.ready) && Boolean(room.seats.b?.ready);
    if (!hasAI && !allReady) {
      room.status = 'preparing';
      room.clock.running = false;
      return;
    }
    if (room.status === 'waiting' || room.status === 'preparing') {
      room.status = 'playing';
      room.game = new Chess(START_FEN);
      room.fen = START_FEN;
      room.moves = [];
      room.result = undefined;
      // 新的一局：超时锁定和「已超时」标记一并清掉
      room.resultLocked = false;
      room.flagged = [];
      room.inCheck = false;
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      room.takebackOffer = undefined;
      room.rematchVotes = [];
      room.clock = emptyClock(this.timeControlOf(room));
      room.clock.running = room.clock.enabled;
      room.clock.lastTickAt = Date.now();
    }
  }

  private timeControlOf(room: RoomInternal): TimeControlKey {
    return room.timeControl;
  }

  /** 提交走子 —— 权威校验 */
  submitMove(
    room: RoomInternal,
    identity: PlayerIdentity,
    move: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' },
  ): { ok: true } | { ok: false; message: string } {
    if (room.status !== 'playing') return { ok: false, message: '当前无法走子' };
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };

    const turn = turnOf(room.fen);
    if (seat.color !== turn) return { ok: false, message: '还没轮到你走' };

    let outcome;
    try {
      // 在**活实例**上走：这样局面历史（含三次重复计数）才不会被切断
      outcome = applyMoveToGame(room.game, move);
    } catch {
      return { ok: false, message: '非法着法' };
    }

    // 结算棋钟（走完这一步 → 拿到本方增量）
    this.settleClock(room, seat.color, { increment: true });

    const record: MoveRecord = { ...outcome.record, ts: Date.now() };
    room.fen = outcome.fen;
    room.moves.push(record);
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    room.takebackOffer = undefined;
    room.updatedAt = Date.now();

    // 终局判定
    const status = statusOf(room.fen, room.game);
    room.inCheck = status.inCheck;
    if (status.over && status.result) {
      this.finish(room, status.result);
    } else {
      this.syncClockRunning(room);
    }
    return { ok: true };
  }

  /**
   * AI 走一步（走人类同一条路径）。
   *
   * @param move 引擎给出的着法。**不传**时用同进程内的同步搜索兜底
   *             （测试用；生产路径一律走引擎池的子进程，见 ws-hub）。
   */
  submitAiMove(
    room: RoomInternal,
    move?: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' },
  ): { ok: true } | { ok: false; message: string } {
    const aiSeat = room.seats.w?.isAI ? room.seats.w : room.seats.b?.isAI ? room.seats.b : undefined;
    if (!aiSeat || room.status !== 'playing') return { ok: false, message: 'AI 不可走' };
    const turn = turnOf(room.fen);
    if (aiSeat.color !== turn) return { ok: false, message: '还没轮到 AI' };

    const chosen =
      move ??
      analyzePosition(room.fen, aiSeat.color, {
        difficulty: room.difficulty,
      });
    if (!chosen) return { ok: false, message: 'AI 无着可走' };

    const outcome = applyMoveToGame(room.game, {
      from: chosen.from,
      to: chosen.to,
      promotion: chosen.promotion,
    });
    this.settleClock(room, aiSeat.color, { increment: true });
    room.fen = outcome.fen;
    room.moves.push({ ...outcome.record, ts: Date.now() });
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    room.takebackOffer = undefined;
    room.updatedAt = Date.now();

    const status = statusOf(room.fen, room.game);
    room.inCheck = status.inCheck;
    if (status.over && status.result) this.finish(room, status.result);
    else this.syncClockRunning(room);
    return { ok: true };
  }

  /** 认输 */
  resign(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (room.status !== 'playing') return { ok: false, message: '当前无法认输' };
    const winner: Color = seat.color === 'w' ? 'b' : 'w';
    this.finish(room, { winner, reason: 'resign' });
    return { ok: true };
  }

  /** 发起和棋 */
  offerDraw(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (room.status !== 'playing') return { ok: false, message: '当前无法提议和棋' };
    // 已经有待回应的请求了（和棋或悔棋）→ 不重复发起
    if (room.drawOffer || room.takebackOffer) return { ok: false, message: '已有待回应的请求' };
    // 电脑没有「同意/反对」这个交互 → 直接拒绝，不让发起方干等 30 秒
    const opponent = seat.color === 'w' ? room.seats.b : room.seats.w;
    if (opponent?.isAI) return { ok: false, message: '电脑拒绝了和棋提议' };
    room.drawOffer = seat.color;
    room.drawDeadline = Date.now() + OFFER_TIMEOUT_MS;
    return { ok: true };
  }

  /** 接受和棋 */
  acceptDraw(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (room.status !== 'playing' || !room.drawOffer) return { ok: false, message: '没有待接受的和棋提议' };
    if (room.drawOffer === seat.color) return { ok: false, message: '不能接受自己的和棋提议' };
    // 超时的请求一律作废（服务端每秒 tick 会清掉，这里再兜一次底）
    if (room.drawDeadline && Date.now() > room.drawDeadline) {
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      return { ok: false, message: '和棋请求已超时' };
    }
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    this.finish(room, { winner: 'draw', reason: 'draw' });
    return { ok: true };
  }

  /** 拒绝和棋（对方点了「反对」，或超时自动拒绝） */
  declineDraw(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (!room.drawOffer) return { ok: false, message: '没有待回应的和棋提议' };
    if (room.drawOffer === seat.color) return { ok: false, message: '不能拒绝自己的和棋提议' };
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    room.updatedAt = Date.now();
    return { ok: true };
  }

  /**
   * 发起悔棋。
   *
   * **两种模式**（用户 2026-11-20 拍板）：
   *
   *  - **A. 我刚走完、对方还没回应** → **直接撤**我那一步，不用问对方。
   *    对方的着法还没建立在这一步上，撤掉它不影响任何人，直接撤最省事。
   *
   *  - **B. 对方已经回应** → **申请**；对方同意后撤**两步**
   *    （对方的应手 + 我的那一步），撤完**轮回到我**重走。
   *    为什么必须撤两步：对方的应手是踩在我那一步上算的，
   *    单独撤掉我那一步在规则上无解（撤完轮次也对不上）。
   *
   * **棋钟不回退**（沿用 2026-11-10 拍板）：时间照常走，悔棋者重新开始计时。
   *
   * **终局也能悔**（2026-11-20 拍板）：自己那一步直接把对方将死/逼和了，
   * 照样能撤 —— 但**只有「棋盘规则」判出来的终局**能悔。
   * 认输 / 双方同意和棋 / 超时判负 / 弃权都是**人的决定**，撤一步改不了它。
   *
   * 对方是 AI 时视为**自动同意**（AI 没有「同意/反对」这个交互）。
   */
  offerTakeback(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true; autoAccepted: boolean; direct: boolean } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    if (room.drawOffer || room.takebackOffer) return { ok: false, message: '已有待回应的请求' };
    if (room.moves.length === 0) return { ok: false, message: '还没有可以悔的棋' };
    // 必须**自己走过棋**才有得可悔
    if (!room.moves.some((m) => m.color === seat.color)) {
      return { ok: false, message: '你还没有走过棋' };
    }
    /*
     * 终局：只有**棋盘规则**判出来的终局能悔。
     *
     * 认输 / 双方同意和棋 / 超时判负 / 弃权 —— 这些是**人做出来的决定**，
     * 撤掉一步棋改不了它（对方认输了，你把棋退回去，这局算什么？）。
     */
    if (room.status !== 'playing' && !isRuleEnd(room.result?.reason)) {
      return { ok: false, message: '对局已经结束，不能悔棋' };
    }

    const lastMove = room.moves[room.moves.length - 1];
    if (lastMove.color === seat.color) {
      // **A：对方还没回应** → 直接撤，不用问对方
      const done = this.applyTakeback(room, seat.color);
      if (!done.ok) return { ok: false, message: done.message };
      return { ok: true, autoAccepted: true, direct: true };
    }

    // **B：对方已经回应** → 需要对方同意
    const opponent = seat.color === 'w' ? room.seats.b : room.seats.w;
    if (opponent?.isAI) {
      const done = this.applyTakeback(room, seat.color);
      if (!done.ok) return { ok: false, message: done.message };
      return { ok: true, autoAccepted: true, direct: false };
    }
    room.takebackOffer = { by: seat.color, deadline: Date.now() + OFFER_TIMEOUT_MS };
    return { ok: true, autoAccepted: false, direct: false };
  }

  /** 同意悔棋 → 真的撤销那一步 */
  acceptTakeback(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    const offer = room.takebackOffer;
    if (!offer) return { ok: false, message: '没有待回应的悔棋请求' };
    if (offer.by === seat.color) return { ok: false, message: '不能同意自己的悔棋请求' };
    // 超时的请求一律作废
    if (Date.now() > offer.deadline) {
      room.takebackOffer = undefined;
      return { ok: false, message: '悔棋请求已超时' };
    }
    room.takebackOffer = undefined;
    const done = this.applyTakeback(room, offer.by);
    if (!done.ok) return { ok: false, message: done.message };
    return { ok: true };
  }

  /** 拒绝悔棋 */
  declineTakeback(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    const offer = room.takebackOffer;
    if (!offer) return { ok: false, message: '没有待回应的悔棋请求' };
    if (offer.by === seat.color) return { ok: false, message: '不能拒绝自己的悔棋请求' };
    room.takebackOffer = undefined;
    room.updatedAt = Date.now();
    return { ok: true };
  }

  /**
   * **人机对局的「撤回」**：撤销玩家上一步走的那手棋。
   *
   * 规则（用户 2026-11-12 拍板）：
   *   - 一次撤回 = 回到**上一次轮到玩家走子**的局面。
   *     玩家的那手**连同其后 AI 的应手**一起撤掉 —— 只撤玩家那手是**留不下的**：
   *     AI 的应手是踩在玩家那步上算出来的，少了前一步它就不存在了
   *     （棋谱是栈，只能从末尾撤）。玩家看到的当然是「我的棋子回到原位」。
   *   - **可以连点**：一路撤回到开局。
   *     玩家的手都撤完之后，再点一次就把 AI 的开局也撤掉 → 回到初始局面，
   *     AI 会重新走第一步。
   *   - **棋钟不回退**（和「悔棋」同一条规矩）：时间照走，撤回者重新开始计时。
   *
   * @param humanColor 玩家执的颜色（撤回的是**他**走的那一步）
   */
  undoAiMove(
    room: RoomInternal,
    humanColor: Color,
  ): { ok: true; undone: number } | { ok: false; message: string } {
    // 玩家最后走的那一步
    let idx = -1;
    for (let i = room.moves.length - 1; i >= 0; i -= 1) {
      if (room.moves[i].color === humanColor) {
        idx = i;
        break;
      }
    }
    // 玩家没有棋了 → 还能把 AI 的开局也撤掉，一路回到开局
    const cut = idx >= 0 ? idx : 0;
    if (room.moves.length <= cut) return { ok: false, message: '还没有可以撤回的棋' };

    /*
     * 棋钟**不回退**：先把「这一段等待」结算给该算的人（撤回者重新开始计时）。
     * 结算完 lastTickAt 会刷新成现在，撤回者接下来思考的时间算他自己的。
     */
    if (room.clock.running) this.settleClock(room, turnOf(room.fen));

    let undone = 0;
    while (room.moves.length > cut) {
      /*
       * 用**活实例的 undo()**（和悔棋同一条路）：
       * 三次重复的计数、吃路兵目标格、50 回合计数都跟着一起退回去。
       */
      if (!room.game.undo()) return { ok: false, message: '棋谱与局面记录不一致' };
      room.moves.pop();
      undone += 1;
    }
    room.fen = room.game.fen();
    // 锁定的结果（超时判负）不清 —— 撤回不动棋钟，超时那笔账也不该被抹掉
    if (!room.resultLocked) room.result = undefined;
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    room.takebackOffer = undefined;
    room.rematchVotes = [];
    room.updatedAt = Date.now();

    const status = statusOf(room.fen, room.game);
    room.inCheck = status.inCheck;
    this.syncClockRunning(room);
    return { ok: true, undone };
  }

  /**
   * 真正执行悔棋：撤掉**请求方自己那一步**，轮次回到请求方。
   *
   * 规则（用户 2026-11-20 拍板）：
   *   - **对方还没回应**（最后一步是请求方的）→ 撤**一步**；
   *   - **对方已经回应**（最后一步是对方的）→ 撤**两步**
   *     （对方的应手 + 请求方那一步）—— 对方的应手是踩在请求方那步上算的，
   *     单独撤掉请求方那一步在规则上无解。撤完两步，轮次正好回到请求方。
   *   - **棋钟不回退**：时间照常走，悔棋者重新开始计时。
   *
   * @param requester 发起悔棋的一方（撤销的是**他**走的那一步）
   */
  private applyTakeback(
    room: RoomInternal,
    requester: Color,
  ): { ok: true; undone: number } | { ok: false; message: string } {
    const moves = room.moves;
    if (moves.length === 0) return { ok: false, message: '还没有可以悔的棋' };
    const last = moves[moves.length - 1];
    if (!last) return { ok: false, message: '棋谱与局面记录不一致' };

    /*
     * 撤几步：
     *  - 最后一步是请求方的 → 撤**一步**（对方还没回应）；
     *  - 最后一步是对方的 → 撤**两步**（对方的应手 + 请求方那一步）。
     *
     * 撤两步的原因：对方的应手是踩在请求方那一步上算出来的，
     * 单独撤掉请求方那一步，棋局在规则上无解（轮次也对不上）。
     * 撤完两步，轮次正好回到请求方 —— 轮到他重走。
     */
    let plies = 1;
    if (last.color !== requester) {
      const prev = moves[moves.length - 2];
      if (!prev || prev.color !== requester) {
        return { ok: false, message: '只能悔自己走的那一步' };
      }
      plies = 2;
    }

    /*
     * 棋钟**不回退**，但这一段等待要算**该算的人**的：
     *  - 撤一步时（对方还没回应）：轮到的是**对方** → 这段时间算对方的，
     *    撤完轮次交回请求方。否则这段时间会被算到请求方头上 ——
     *    等于让对方替他付账。
     *  - 撤两步时（对方已经回应）：轮到的是**请求方自己** → 算他的。
     */
    if (room.clock.running) this.settleClock(room, turnOf(room.fen));

    /*
     * 撤掉那一步（或那两步）。
     *
     * 用**活实例的 undo()**，而不是「拿一个旧 FEN 覆盖回去」：
     *  - undo() 会连带把 chess.js 内部的**局面出现次数**退回去，
     *    三次重复的计数才不会错位；
     *  - undo() 顺带把吃路兵目标格、50 回合计数、回合数一并还原。
     */
    let undone = 0;
    for (let i = 0; i < plies; i += 1) {
      const popped = room.game.undo();
      if (!popped) return { ok: false, message: '棋谱与局面记录不一致' };
      moves.pop();
      undone += 1;
    }
    room.fen = room.game.fen();
    room.clock.lastTickAt = Date.now();

    // 撤销的可能是一步杀棋 → 局面重新判定（回到「进行中」）
    const status = statusOf(room.fen, room.game);
    room.inCheck = status.inCheck;
    if (status.over && status.result) {
      room.status = 'finished';
      // 锁定的结果（超时判负）不被改写
      if (!room.resultLocked) room.result = status.result;
      room.clock.running = false;
    } else {
      room.status = 'playing';
      // 锁定的结果**不清** —— 它跟局面无关，是超时那一刻定下的
      if (!room.resultLocked) room.result = undefined;
      this.syncClockRunning(room);
    }
    room.drawOffer = undefined;
    room.drawDeadline = undefined;
    room.takebackOffer = undefined;
    // 局面变了，之前攒的「再来一局」票也作废（这局还没完）
    room.rematchVotes = [];
    room.updatedAt = Date.now();
    return { ok: true, undone };
  }

  /** 申请再来一局 */
  requestRematch(
    room: RoomInternal,
    identity: PlayerIdentity,
  ): { ok: true } | { ok: false; message: string } {
    const seat = this.findSeat(room, identity.userId);
    if (!seat) return { ok: false, message: '你不在该对局中' };
    /*
     * 「再来一局」在两种情况下可申请：
     *  - 对局真的结束了（将死 / 认输 / 和棋）；
     *  - **超时判负了，但棋局还在继续** —— 结果已经定了，
     *    不该让玩家卡在「想换局却没按钮」的状态。
     */
    if (room.status !== 'finished' && !room.resultLocked) {
      return { ok: false, message: '对局尚未结束' };
    }
    if (!room.rematchVotes.includes(seat.color)) room.rematchVotes.push(seat.color);
    const votes = new Set(room.rematchVotes);
    // 对方是 AI 时视为自动同意；真人对局需双方都同意
    const aiAgrees = Boolean(room.seats.w?.isAI || room.seats.b?.isAI);
    const bothAgreed = aiAgrees || (votes.has('w') && votes.has('b'));
    if (bothAgreed) {
      /*
       * **重新抽签** ——
       * 「连着几局都是同一边」的解法就在这里。
       *
       * 人机局不抽（颜色是玩家自己挑的，见 `setupVsAI`）。
       */
      const w = room.seats.w;
      const b = room.seats.b;
      if (w && b && !aiAgrees) {
        if (this.drawWhite() === 'second') {
          room.seats.w = { ...b, color: 'w', ready: false };
          room.seats.b = { ...w, color: 'b', ready: false };
        } else {
          w.ready = false;
          b.ready = false;
        }
      }
      room.game = new Chess(START_FEN);
      room.fen = START_FEN;
      room.moves = [];
      room.result = undefined;
      // 新的一局：超时锁定和「已超时」标记一并清掉
      room.resultLocked = false;
      room.flagged = [];
      room.inCheck = false;
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      room.takebackOffer = undefined;
      room.rematchVotes = [];
      // 人机局直接开；真人局回到「准备」阶段（双方再点一次准备）
      room.status = aiAgrees ? 'playing' : 'preparing';
      room.clock = emptyClock(this.timeControlOf(room));
      room.clock.running = aiAgrees ? room.clock.enabled : false;
      room.clock.lastTickAt = Date.now();
    }
    return { ok: true };
  }

  /** 聊天 */
  chat(
    room: RoomInternal,
    identity: PlayerIdentity,
    text: string,
  ): { ok: true; message: ChatMessage } | { ok: false; message: string } {
    const now = Date.now();
    if (now - room.lastChatAt < CHAT_MIN_INTERVAL_MS) {
      return { ok: false, message: '发送太快了，稍等一下' };
    }
    const clean = text.trim().slice(0, CHAT_MAX_LEN);
    if (!clean) return { ok: false, message: '消息不能为空' };
    room.lastChatAt = now;
    const msg: ChatMessage = { userId: identity.userId, name: identity.name, text: clean, ts: now };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat = room.chat.slice(-200);
    return { ok: true, message: msg };
  }

  /**
   * 快捷聊天。
   *
   * 和普通聊天的区别有两条：
   *   1. **限频各走各的**（互不拖累：共用一个限频会让「刚点过弹幕就打不了字」）；
   *   2. **不留底** —— 不写进 `room.chat`。
   *
   * 留不留底是**产品定的规矩**（用户要求：「快捷聊天不出现在聊天记录中」）：
   * 聊天记录里留的全是正经聊的话；弹幕一扫就没，不占地方。
   * 所以这里**只产出消息**，不往记录里塞。
   *
   * 消息上的 `quick: true` 是给下游的标记（客户端据此决定「只飘弹幕，不进记录」）。
   */
  quickChat(
    room: RoomInternal,
    identity: PlayerIdentity,
    text: string,
  ): { ok: true; message: ChatMessage } | { ok: false; message: string } {
    const now = Date.now();
    if (now - room.lastQuickChatAt < QUICK_CHAT_MIN_INTERVAL_MS) {
      return { ok: false, message: '点太快了，稍等一下' };
    }
    const clean = text.trim().slice(0, QUICK_CHAT_MAX_LEN);
    if (!clean) return { ok: false, message: '消息不能为空' };
    room.lastQuickChatAt = now;
    const msg: ChatMessage = {
      userId: identity.userId,
      name: identity.name,
      text: clean,
      ts: now,
      quick: true,
    };
    return { ok: true, message: msg };
  }

  /**
   * 结算棋钟：扣除已用时间，可选地加上本方增量。
   *
   * **剩余时间允许变成负数。**
   * 超时只判负、不结束棋局（见 `tick()`），所以这一方的计时要**继续往下走**
   * —— 负数就是「已经超时多久了」。前端照原样显示成 `-1:23`。
   *
   * @param increment 是否发放增量秒。
   *   **只有真正走完一步才发** —— 增量是「走一步的奖励」，
   *   悔棋时结算对方思考时间是**不发增量**的（对方没走棋）。
   *
   *   判负之后**照发**（规则统一，不给判负方开特例）——
   *   所以负数有可能被增量拉回正数；结果早就在超时那一刻锁定了，不受影响。
   */
  private settleClock(
    room: RoomInternal,
    color: Color,
    opts?: { increment?: boolean },
  ): void {
    if (!room.clock.enabled) return;
    const now = Date.now();
    const elapsed = Math.max(0, now - room.clock.lastTickAt);
    const key = color === 'w' ? 'wMs' : 'bMs';
    // 不做下限截断 —— 负数是合法状态（超时之后还在走）
    room.clock[key] = room.clock[key] - elapsed;
    if (opts?.increment) {
      room.clock[key] += room.clock.incrementMs;
    }
    room.clock.lastTickAt = now;
  }

  /** 根据连接状态决定棋钟是否走 */
  private syncClockRunning(room: RoomInternal): void {
    if (!room.clock.enabled) {
      room.clock.running = false;
      return;
    }
    if (room.status !== 'playing') {
      room.clock.running = false;
      return;
    }
    const allConnected = Boolean(
      room.seats.w && room.seats.b && room.seats.w.connected && room.seats.b.connected,
    );
    if (allConnected) {
      if (!room.clock.running) {
        room.clock.running = true;
        room.clock.lastTickAt = Date.now();
      }
    } else {
      room.clock.running = false;
    }
  }

  /**
   * 终局。
   *
   * **锁定的结果不会被改写。**
   * 超时判负那一刻结果就定了（用户拍板：超时即定局），
   * 之后不管是��死、认输还是和棋，都只改 `status`，不动 `result`。
   */
  private finish(room: RoomInternal, result: GameResult): void {
    room.status = 'finished';
    if (!room.resultLocked) room.result = result;
    room.clock.running = false;
    room.updatedAt = Date.now();
  }

  /**
   * 结算「断线超时」的座位。
   *
   * 必须在**两处**调用：
   *   1. `tick()` —— 定时结算，让没人回来的对局自动结束；
   *   2. `joinRoom()` —— 加入前先结算。否则新玩家会坐进一个
   *      「对方早就该被判负」的房间，刚坐下就被 `tick` 立刻判负（开局即终局）。
   *
   * @returns 是否发生了判负（true = 对局已结束）
   */
  settleExpiredSeats(room: RoomInternal): boolean {
    const now = Date.now();
    /*
     * **待抽签的玩家断线超时** → 把他清掉，房间回到「等人来」。
     *
     * 不清的话房间会一直挂着这个「僵死的待抽签玩家」，
     * 后来的新玩家进不来（pending 槽位被占着）。
     */
    if (
      room.pending &&
      !room.pending.connected &&
      room.pending.disconnectedAt &&
      now - room.pending.disconnectedAt > DISCONNECT_GRACE_MS
    ) {
      room.pending = undefined;
      room.status = 'waiting';
      room.clock.running = false;
    }
    const expired: Color[] = [];
    for (const color of ['w', 'b'] as Color[]) {
      const seat = room.seats[color];
      if (!seat || seat.connected || seat.isAI) continue;
      if (seat.disconnectedAt && now - seat.disconnectedAt > DISCONNECT_GRACE_MS) {
        expired.push(color);
      }
    }
    if (expired.length === 0) return false;

    // 房间还没开始（waiting）：断线超时的人直接移除，房间继续等人来
    if (room.status !== 'playing') {
      for (const color of expired) delete room.seats[color];
      room.clock.running = false;
      room.rematchVotes = [];
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      room.takebackOffer = undefined;
      room.updatedAt = now;
      return false;
    }

    // 双方都断线超时：没有对局可言，把僵死座位清掉，房间回到「等待对手」
    if (expired.length === 2) {
      for (const color of expired) delete room.seats[color];
      room.status = 'waiting';
      room.clock.running = false;
      room.rematchVotes = [];
      room.drawOffer = undefined;
      room.drawDeadline = undefined;
      room.takebackOffer = undefined;
      room.updatedAt = now;
      return false;
    }

    // 一方断线超时：判对方胜
    const gone = expired[0];
    const winner: Color = gone === 'w' ? 'b' : 'w';
    this.finish(room, { winner, reason: 'abandon' });
    return true;
  }

  /** 每秒调用：推进棋钟、检查超时、检查断线判负、让超时的请求自动作废 */
  tick(): RoomEvent[] {
    const events: RoomEvent[] = [];
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.dead) continue;

      /*
       * 请求超时 → **自动拒绝**（用户要求：「设定超时自动反对」）。
       *
       * 必须在这里做，而不是靠客户端计时器 ——
       * 客户端计时器会因刷新/断线而失灵，权威判定只能在服务端。
       */
      if (room.drawOffer && room.drawDeadline && now > room.drawDeadline) {
        const by = room.drawOffer;
        room.drawOffer = undefined;
        room.drawDeadline = undefined;
        room.updatedAt = now;
        events.push({ room, event: 'offer-expired', kind: 'draw', by });
      }
      if (room.takebackOffer && now > room.takebackOffer.deadline) {
        const by = room.takebackOffer.by;
        room.takebackOffer = undefined;
        room.updatedAt = now;
        events.push({ room, event: 'offer-expired', kind: 'takeback', by });
      }

      // 断线超时判负
      if (room.status === 'playing') {
        if (this.settleExpiredSeats(room)) {
          events.push({ room, event: 'abandon' });
        }
      }

      // 棋钟超时：**判负，但不结束对局**
      //
      // 规则（用户拍板）：超时就只是「提示一下谁赢了」——
      //  - 结果照旧记下来并**锁定**：之后将死/认输都不再改写它；
      //  - 但房间状态**保持 playing**：双方照样能走棋，棋钟也照样走（走成负数）；
      //  - 每一方只播报一次（否则每秒都会报一次「超时」）。
      if (room.status === 'playing' && room.clock.enabled && room.clock.running) {
        const turn = turnOf(room.fen);
        const elapsed = Date.now() - room.clock.lastTickAt;
        const remaining = (turn === 'w' ? room.clock.wMs : room.clock.bMs) - elapsed;
        if (remaining <= 0) {
          const winner: Color = turn === 'w' ? 'b' : 'w';
          // 已经报过这一方 → 不重复播报（时间还在继续往负数走）
          if (!room.flagged?.includes(turn)) {
            room.flagged = [...(room.flagged ?? []), turn];
            if (!room.resultLocked) {
              room.result = { winner, reason: 'timeout' };
              room.resultLocked = true;
            }
            room.updatedAt = now;
            events.push({ room, event: 'timeout' });
          }
        }
      }
    }
    return events;
  }

  /**
   * 清理没人要的房间。
   *
   * 「没人要」= 既没有**在线**玩家，也没有**在线**观战者。
   *
   * 只看「座位数」是不够的：断线后座位仍然保留（等重连），
   * 一个玩家建完房就关掉页面的房间，座位还在、房间却再也没人会回来，
   * 就会永远挂在大厅列表里（这跟「人走了局还挂着」是同一类问题）。
   *
   * 刚断线的留一个重连宽限期，超过宽限仍未回来才删。
   *
   * @returns 是否真的删掉了房间。
   * 调用方必须据此广播大厅 —— 否则客户端手里还留着那张已经不存在的房间卡，
   * 表现为「人走了，房间还一直挂在大厅列表里」。
   */
  cleanup(): boolean {
    const now = Date.now();
    let removed = false;
    for (const [code, room] of this.rooms) {
      if (room.dead) continue;
      const seats = [room.seats.w, room.seats.b].filter((s): s is Seat => Boolean(s));
      /*
       * **待抽签的玩家也是房间里的人** ——
       * 他已经坐在房里了，只是黑白还没定。
       *
       * 不把他算进来的话：一个刚创建、对手还没来的房间，
       * 房主一断线就会被当成「没人要的房间」直接删掉 ——
       * 他明明还在宽限期里、还可能回来。
       */
      const occupants: Array<{ connected: boolean; disconnectedAt?: number }> = [
        ...seats,
        ...(room.pending
          ? [
              {
                connected: Boolean(room.pending.connected),
                disconnectedAt: room.pending.disconnectedAt,
              },
            ]
          : []),
      ];
      /*
       * 「有人要这个房间」= 有**在线真人**。
       *
       * AI 座位不算 —— 人机房间不出现在大厅列表里（用户拍板），
       * 人一走它就成了没人要的空房，得跟着真人房间一起回收，
       * 否则服务器上会堆一堆没人碰过的人机局。
       */
      const hasOnlinePlayer = occupants.some((s) => s.connected);
      const hasOnlineSpectator = room.spectators.some((s) => s.connected);

      if (hasOnlinePlayer || hasOnlineSpectator) continue;

      // 没有任何人在：刚断线的等一个重连宽限期，超时仍未回来 → 删掉
      const lastGone = occupants.reduce((max, s) => Math.max(max, s.disconnectedAt ?? 0), 0);
      if (occupants.length === 0 || now - lastGone > DISCONNECT_GRACE_MS) {
        room.dead = true;
        this.rooms.delete(code);
        removed = true;
      }
    }
    return removed;
  }

  /** 房间里所有观战者 */
  spectatorList(room: RoomInternal): Spectator[] {
    return room.spectators;
  }
}

export { describeResult };
