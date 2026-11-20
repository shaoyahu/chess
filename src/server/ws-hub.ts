/**
 * WebSocket 中枢：连接管理、消息路由、广播。
 *
 * 连接生命周期：
 *   connect → 等待 hello（完成身份建立）→ 之后可收发业务消息
 *   close  → 标记座位断线（保留 5 分钟等待重连）
 */
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { parseClientMessage, type ServerMessage } from '../lib/protocol';
import {
  CHAT_MAX_LEN,
  DEFAULT_TIME_CONTROL,
  DM_QUICK_TEXT_SET,
  DM_SEND_MIN_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MATCH_TIME_ANY,
  TIME_CONTROLS,
  normalizeTimeControl,
} from '../lib/constants';
import type {
  Color,
  Difficulty,
  DirectMessage,
  LobbyState,
  RoomArchive,
  RoomState,
  RoomVisibility,
  SessionArchive,
} from '../lib/types';
import { DEFAULT_DIFFICULTY } from '../lib/types';
import { Matchmaker, resolveMatchTimeControl, type QueueEntry } from './matchmaking';
import { RoomManager, type PlayerIdentity, type RoomInternal } from './room-manager';
import { createEnginePool, type EnginePool } from './engine-pool';
import { scheduleSave, scheduleSaveSessions, loadRooms, loadSessions, flush } from './store';

interface Client {
  id: string;
  socket: WebSocket;
  /** 身份建立后才有值 */
  identity?: PlayerIdentity;
  /** 会话 token（用于重连） */
  token?: string;
  /** 当前所在房间 */
  roomCode?: string;
  /** 是否在匹配队列 */
  queued: boolean;
  /** 心跳 */
  alive: boolean;
  /**
   * 最近一次收到该连接**任何**数据的时间。
   * 超过 HEARTBEAT_TIMEOUT_MS 没有任何回音 → 判定失联并主动断开。
   */
  lastActiveAt: number;
  /**
   * 最近一次**发出私信**（消息或邀请）的时间。
   *
   * 私信不像房间聊天那样有个房间来记限频状态 —— 它是点对点的，
   * 所以限频记在**连接**上：同一个人连着发，第二条要被拒掉。
   */
  lastDmAt: number;
  /** AI 走子定时器 */
  aiTimer?: NodeJS.Timeout;
}

/**
 * 会话档案 —— token → 身份。
 *
 * 单独存在的原因：连接断开时「连接」没了，但「身份」必须留着，
 * 否则刷新页面后带同一个 token 回来会被当成新用户，
 * 座位、房间、视角全部丢失。
 */
interface SessionRecord {
  userId: string;
  name: string;
  roomCode?: string;
  queued: boolean;
  /** 最近一次活跃时间，用于清理过期会话 */
  lastActiveAt: number;
}

/** 会话档案保留时长（超过则不再允许恢复身份） */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * AI 的**最短思考时间**（毫秒）。
 *
 * 引擎的时间预算已经决定了「想多久」，但简单难度可能几十毫秒就返回 ——
 * 玩家根本看不出对面是电脑在算。这层下限保证「电脑在思考」这个观感。
 */
const AI_MIN_THINK_MS = 450;

/**
 * 「辅助下棋」提示的计算时间预算（毫秒）。
 *
 * 用户要求提示是「很强力的自动算法」—— 所以直接给到 hard 档的量级。
 * 提示算在**子进程**里，不阻塞服务端。
 */
const HINT_TIME_MS = 2000;

export class WsHub {
  private clients = new Map<string, Client>();
  /** token → 会话档案，断开后仍保留以支持重连恢复身份 */
  private sessions = new Map<string, SessionRecord>();
  private rooms = new RoomManager();
  private matchmaker = new Matchmaker();
  /**
   * 引擎池（常驻子进程）—— AI 落子与「辅助下棋」提示**共用**这一套。
   *
   * 为什么必须放子进程：搜索是 CPU 密集的同步计算，
   * 放在主进程里会把整个服务卡住（实测旧实现一次搜索阻塞 1.85 秒，
   * 期间所有房间的广播、棋钟计时全部停摆）。
   */
  private enginePool: EnginePool;

  /** 心跳间隔（毫秒） */
  private readonly heartbeatIntervalMs: number;
  /** 超过这个时间没有任何回音就判定失联 */
  private readonly heartbeatTimeoutMs: number;
  /** 空房间清理间隔（毫秒） */
  private readonly cleanupIntervalMs: number;

  /**
   * @param opts.heartbeatIntervalMs 心跳间隔（默认 15 秒）
   * @param opts.heartbeatTimeoutMs  失联判定阈值（默认 45 秒）
   * @param opts.cleanupIntervalMs   空房间清理间隔（默认 30 秒）
   *
   * 这几个值可注入，是为了能在测试里把「等 45 秒」压缩成「等 200 毫秒」，
   * 从而真实验证「半开连接会被主动掐掉」这条链路，而不是只测一个纯函数。
   */
  constructor(opts?: {
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    cleanupIntervalMs?: number;
  }) {
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.cleanupIntervalMs = opts?.cleanupIntervalMs ?? 30_000;
    // 引擎池：懒启动子进程（第一次真正需要搜索时才 spawn）
    this.enginePool = createEnginePool();
    // 每秒：推进棋钟、检查超时与断线判负
    setInterval(() => this.onTick(), 1000).unref?.();
    // 给所有连接发心跳 ping，并主动掐掉长时间无回音的连接
    setInterval(() => this.heartbeat(), this.heartbeatIntervalMs).unref?.();
    // 定期清理空房间并落盘
    setInterval(() => {
      const before = this.lobbyFingerprint();
      this.rooms.cleanup();
      this.cleanupSessions();
      // 房间被删掉后必须广播大厅，否则客户端列表里会一直挂着那张已经不存在的卡
      if (before !== this.lobbyFingerprint()) this.broadcastLobby();
      this.persist();
    }, this.cleanupIntervalMs).unref?.();
  }

  get roomManager(): RoomManager {
    return this.rooms;
  }

  /** 新连接接入 */
  handleConnection(socket: WebSocket): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      queued: false,
      alive: true,
      lastActiveAt: Date.now(),
      lastDmAt: 0,
    };
    this.clients.set(client.id, client);

    socket.on('message', (raw: Buffer | string) => {
      client.lastActiveAt = Date.now();
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.onMessage(client, text);
    });

    socket.on('close', () => this.onClose(client));
    socket.on('error', () => this.onClose(client));
    socket.on('pong', () => {
      client.alive = true;
      client.lastActiveAt = Date.now();
    });
  }

  private onMessage(client: Client, text: string): void {
    const msg = parseClientMessage(text);
    if (!msg) {
      this.send(client, { t: 'toast', kind: 'error', message: '无法识别的消息' });
      return;
    }

    if (msg.t === 'ping') {
      this.send(client, { t: 'pong' });
      return;
    }

    if (msg.t === 'hello') {
      this.handleHello(client, msg.name, msg.token);
      return;
    }

    if (!client.identity) {
      this.send(client, { t: 'toast', kind: 'error', message: '请先登录' });
      return;
    }

    switch (msg.t) {
      case 'queue.join':
        this.handleQueueJoin(client, msg.timeControl);
        break;
      case 'queue.leave':
        this.matchmaker.remove(client.identity.userId);
        client.queued = false;
        this.broadcastLobby();
        break;
      case 'room.create':
        this.handleRoomCreate(
          client,
          msg.timeControl,
          msg.withAI,
          msg.difficulty,
          msg.visibility,
          msg.color,
        );
        break;
      case 'room.join':
        this.handleRoomJoin(client, msg.code, msg.mode);
        break;
      case 'room.claim':
        this.handleRoomClaim(client, msg.code, msg.claimKey);
        break;
      case 'room.leave':
        this.handleRoomLeave(client);
        break;
      case 'ready':
        this.handleReady(client);
        break;
      case 'ai.undo':
        this.handleAiUndo(client);
        break;
      case 'move':
        this.handleMove(client, msg.from, msg.to, msg.promotion);
        break;
      case 'chat':
        this.handleChat(client, msg.text);
        break;
      case 'dm.send':
        this.handleDmSend(client, msg.to, msg.text);
        break;
      case 'dm.invite':
        this.handleDmInvite(client, msg.to, msg.roomCode);
        break;
      case 'chat.quick':
        this.handleQuickChat(client, msg.text);
        break;
      case 'resign':
        this.handleResign(client);
        break;
      case 'draw.offer':
        this.handleDrawOffer(client);
        break;
      case 'draw.accept':
        this.handleDrawAccept(client);
        break;
      case 'draw.decline':
        this.handleDrawDecline(client);
        break;
      case 'takeback.offer':
        this.handleTakebackOffer(client);
        break;
      case 'takeback.accept':
        this.handleTakebackAccept(client);
        break;
      case 'takeback.decline':
        this.handleTakebackDecline(client);
        break;
      case 'rematch':
        this.handleRematch(client);
        break;
      case 'rematch.accept':
        this.handleRematch(client);
        break;
      case 'hint.request':
        void this.handleHintRequest(client);
        break;
      default:
        break;
    }
  }

  private handleHello(client: Client, name: string, token?: string): void {
    const cleanName = name.trim().slice(0, 20) || '玩家';
    const record = token ? this.sessions.get(token) : undefined;

    if (record) {
      // 重连：恢复原有身份（userId 不变 → 座位/房间/视角都能续上）
      client.token = token!;
      client.identity = { userId: record.userId, name: cleanName };
      client.roomCode = record.roomCode;
      client.queued = false;
      record.name = cleanName;
      record.lastActiveAt = Date.now();
      record.queued = false;
      client.queued = false;
    } else {
      const newToken = randomUUID();
      client.token = newToken;
      client.identity = { userId: randomUUID(), name: cleanName };
      this.sessions.set(newToken, {
        userId: client.identity.userId,
        name: cleanName,
        queued: false,
        lastActiveAt: Date.now(),
      });
    }

    this.send(client, {
      t: 'session',
      token: client.token!,
      userId: client.identity.userId,
      name: client.identity.name,
    });

    // 恢复房间状态
    if (client.roomCode) {
      const room = this.rooms.getRoom(client.roomCode);
      if (room) {
        this.rooms.reconnect(room, client.identity);
        this.sendRoom(room, client);
      } else {
        this.setRoom(client, undefined);
      }
    }
    this.broadcastLobby();
  }

  /**
   * 进匹配队列。
   *
   * `timeControl` 传 `'any'` = **任意时限**（愿意跟任何时限的人配对）；
   * 传具体时限 = 只跟选同一时限的人配对。
   */
  private handleQueueJoin(client: Client, timeControl?: string): void {
    const identity = client.identity!;
    const anyTime = timeControl === MATCH_TIME_ANY;
    const entry: QueueEntry = {
      userId: identity.userId,
      name: identity.name,
      timeControl: anyTime ? DEFAULT_TIME_CONTROL : normalizeTimeControl(timeControl),
      anyTime,
    };
    const opponent = this.matchmaker.push(entry);
    if (!opponent) {
      client.queued = true;
      this.send(client, {
        t: 'toast',
        kind: 'info',
        message: anyTime
          ? '已进入匹配队列（任意时限），等待对手…'
          : `已进入匹配队列（${this.timeLabel(entry)}），等待对手…`,
      });
      this.broadcastLobby();
      return;
    }

    client.queued = false;
    // 找到对手的连接
    const oppClient = this.findClientByUserId(opponent.userId);
    if (!oppClient) {
      // 对手已掉线：把自己放回队列
      this.matchmaker.push(entry);
      client.queued = true;
      this.broadcastLobby();
      return;
    }

    oppClient.queued = false;
    /*
     * 房间时限由**双方协商**得出：
     *   谁选了具体时限就听谁的；两边都是「任意」就用默认时限。
     */
    const matchedTime = resolveMatchTimeControl(opponent, entry);
    const room = this.rooms.createRoom({ timeControl: matchedTime, visibility: 'public' });
    // 黑白**由服务端抽签**决定 —— 先入队不等于执白（用户拍板）
    this.rooms.setupMatch(
      room,
      { userId: opponent.userId, name: opponent.name },
      { userId: identity.userId, name: identity.name },
    );

    /*
     * **两个人的房间归属都走 `setRoom`** —— 不能只给后进队列的那个设。
     *
     * `setRoom` 除了记 `client.roomCode`，还会把房间码**同步进会话档案**。
     * 会话档案是「断线重连 / 服务重启后回到原房间」的唯一依据 ——
     * 直接写 `client.roomCode` 的话，档案里没有房间码，
     * 那个玩家重连回来就**认不回房间**（只剩一个观众身份）。
     *
     * 这条以前就栽在这里：匹配队列里**先入队**的是 `oppClient`，
     * 当时只给他写了 `client.roomCode`，档案漏了 → 断线重连回不来。
     */
    this.setRoom(oppClient, room.code);
    this.setRoom(client, room.code);
    this.sendRoom(room, oppClient);
    this.sendRoom(room, client);
    this.send(oppClient, { t: 'toast', kind: 'success', message: '匹配成功，对局开始！' });
    this.send(client, { t: 'toast', kind: 'success', message: '匹配成功，对局开始！' });
    this.broadcastLobby();
    this.persist();
  }

  /** 队列里显示用的时限文案 */
  private timeLabel(entry: QueueEntry): string {
    return TIME_CONTROLS[entry.timeControl ?? DEFAULT_TIME_CONTROL].label;
  }

  private handleRoomCreate(
    client: Client,
    timeControl?: string,
    withAI?: boolean,
    difficulty?: Difficulty,
    visibility?: RoomVisibility,
    /** 人机对战时玩家执什么颜色（`'random'` = 服务端抽签） */
    aiColor?: 'random' | Color,
  ): void {
    const key = normalizeTimeControl(timeControl);
    const room = this.rooms.createRoom({
      timeControl: key,
      difficulty: difficulty ?? DEFAULT_DIFFICULTY,
      visibility: visibility ?? 'public',
    });
    if (withAI) {
      /*
       * 人机：玩家执什么颜色由他选（随机 / 我执白 / 我执黑）。
       *
       * 缺省是 `'random'` —— 老客户端没这个字段，不能让它固定执黑。
       */
      this.rooms.setupVsAI(room, client.identity!, aiColor ?? 'random');
    } else {
      // 普通房间：创建者立即入座执白，等对手进来
      this.rooms.joinRoom(room.code, client.identity!, 'play');
    }
    this.setRoom(client, room.code);
    this.sendRoom(room, client);
    const invite = room.visibility === 'invite';
    this.send(client, {
      t: 'toast',
      kind: 'success',
      message: withAI
        ? '人机对局已开始'
        : invite
          ? `邀请房间已创建，房间码 ${room.code}（只有拿到码的人能进来）`
          : `房间已创建，房间码 ${room.code}`,
    });
    this.broadcastLobby();
    this.persist();
    /**
     * 人机对局：**AI 可能是白方，也可能是黑方**（玩家开局前可以选执色）。
     *
     * 这里必须显式排期 —— `scheduleAiMove` 只在「人类落子后」和「复盘」时调用。
     * 如果玩家执黑，初始局面轮到白方（AI），人类根本走不了第一步，
     * 不排期就会卡在「等对手走棋」直到超时。
     *
     * 如果玩家执白，轮到的是玩家 —— 这时**不能**排期：
     * `scheduleAiMove` 内部有「避免重复排期」的标记（`aiScheduled`），
     * 白排的那一次会把标记占着，玩家走完第一步反而排不上 AI 的回应。
     * （`scheduleAiMove` 内部也会再查一次回合，两道网。）
     */
    if (withAI) this.scheduleAiMove(room);
  }

  private handleRoomJoin(client: Client, code: string, mode: 'play' | 'spectate'): void {
    const identity = client.identity!;
    const result = this.rooms.joinRoom(code, identity, mode);
    if (!result.ok) {
      this.rejectJoin(client, result.message, code);
      return;
    }
    this.finishJoin(client, result.room, identity);
  }

  /**
   * **进不去房间**：既有 toast，也有一条 `error`。
   *
   * 为什么两条都要：
   *  - toast 3.5 秒就没了，而「进不去」是个**需要一直看得见**的状态；
   *  - `error` 让对局页把「正在进入房间…」换成**写明原因的错误卡片**。
   *
   * `code` 是给「错误在页面切换时丢了」准备的 ——
   * 失败可能发生在**大厅页**（比如从私信卡片点进来时），
   * 对局页是之后才挂上的，它得知道「这个错说的是哪个房间」。
   */
  private rejectJoin(client: Client, message: string, code: string): void {
    this.send(client, { t: 'toast', kind: 'error', message });
    this.send(client, { t: 'error', message, code });
  }

  /** 进房成功后的收尾（加入 / 认领两条路共用） */
  private finishJoin(client: Client, room: RoomInternal, identity: PlayerIdentity): void {
    this.setRoom(client, room.code);
    this.sendRoom(room, client);
    const isPlayer =
      Boolean(this.rooms.findSeat(room, identity.userId)) ||
      room.pending?.userId === identity.userId;
    this.send(client, {
      t: 'toast',
      kind: 'success',
      message: isPlayer ? '已进入对局' : '正在观战',
    });
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  /**
   * **认领座位** —— 「关掉网页再打开」之后坐回原座。
   *
   * 为什么需要它：
   *  - `token` 存在 `sessionStorage` → **标签页一关就没了**；
   *  - 所以重开后客户端是**新身份**（新 userId）；
   *  - 拿新身份 `room.join` → 座位还挂着旧 userId → 只能观战。
   *
   * 座位凭证存在 `localStorage` → 关标签页、关浏览器都还在，
   * 凭它就能把座位**转**给新身份（棋钟、走子记录、准备状态全保留）。
   *
   * 认领成功后，**旧身份的会话档案要清掉房间指向** ——
   * 否则旧身份再连回来会以为「我还在这个房间里」，
   * 而座位已经换人了（两处都以为自己是棋手）。
   */
  private handleRoomClaim(client: Client, code: string, claimKey: string): void {
    const identity = client.identity!;
    const room = this.rooms.getRoom(code);
    if (!room) {
      this.send(client, { t: 'toast', kind: 'error', message: '房间不存在' });
      return;
    }
    // 房间已结束 → 没有座位可认领
    if (room.status === 'finished') {
      this.send(client, { t: 'toast', kind: 'error', message: '对局已结束' });
      return;
    }

    // 认领前先算一遍断线超时 —— 否则可能认领到一个「早就该被判负」的座位
    this.rooms.settleExpiredSeats(room);

    /*
     * **记下座位原来的主人**（认领之前）。
     *
     * 认领会把 seat.userId 换成新身份，之后就找不到旧主人了。
     * 而旧主人的会话档案必须清掉 —— 否则他再连回来时，
     * 服务端按档案把他塞回这个房间，而座位已经是新身份的了：
     * 两处都以为自己是棋手，座位只有一个。
     */
    const previousOwner = this.rooms.ownerOfClaim(room, claimKey);

    const claimed = this.rooms.claimSeat(room, claimKey, identity);
    if (!claimed) {
      /*
       * **坐不回去** —— 分辨两种原因，处理方式不一样：
       *
       *  - **座位还被人占着**（原主人还连着）→ 多半是**同一个浏览器的另一个标签页**
       *    拿着凭证（凭证存在 `localStorage` 里，标签页之间共享）。
       *    这种情况下**不能把人卡在门外** —— 按普通加入处理：
       *    有空座就坐下，没空座就观战。换个设备打开同一个房间走的也是这一条，
       *    规则统一。
       *  - **座位已经不在了**（对局结束 / 凭证失效）→ 明确告诉玩家。
       */
      if (this.rooms.claimHeldByLiveOwner(room, claimKey)) {
        const fallback = this.rooms.joinRoom(room.code, identity, 'play');
        if (!fallback.ok) {
          this.rejectJoin(client, fallback.message, room.code);
          return;
        }
        this.finishJoin(client, fallback.room, identity);
        return;
      }
      this.rejectJoin(client, '座位凭证无效或已失效', room.code);
      return;
    }

    // 旧身份要让位：把他的会话档案整个删掉
    this.dropSessionOfUser(previousOwner);

    this.setRoom(client, room.code);
    this.sendRoom(room, client);
    this.send(client, {
      t: 'toast',
      kind: 'success',
      message: claimed === 'pending' ? '已坐回原座位' : '已坐回原座位',
    });
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.persist();
  }

  /**
   * 把某个身份的会话档案删掉 —— 座位转手后，他不该再持有这个房间。
   *
   * @param userId 要删除的身份（认领前的座位原主人）
   */
  private dropSessionOfUser(userId: string | undefined): void {
    if (!userId) return;
    for (const [token, record] of this.sessions) {
      if (record.userId === userId) this.sessions.delete(token);
    }
  }

  private handleRoomLeave(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    this.rooms.leaveRoom(room, client.identity!);
    this.setRoom(client, undefined);
    this.send(client, { t: 'toast', kind: 'info', message: '已离开房间' });
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.persist();
  }

  /**
   * 「我准备好了」—— 抽签之后、正式开局之前，双方各点一次。
   *
   * 双方都点了才开局（白方先走）。
   */
  private handleReady(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.markReady(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.persist();
  }

  /**
   * **人机对局的「撤回」**：撤销玩家上一步走的那手棋。
   *
   * 只有人机局有这条 —— 真人对局里撤回要走「请求 / 同意」那一套。
   */
  private handleAiUndo(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) {
      this.send(client, { t: 'toast', kind: 'error', message: '你不在房间里' });
      return;
    }
    const seat = this.rooms.findSeat(room, client.identity!.userId);
    if (!seat) {
      this.send(client, { t: 'toast', kind: 'error', message: '只有对局双方能撤回' });
      return;
    }
    const aiSeat = room.seats.w?.isAI ? room.seats.w : room.seats.b?.isAI ? room.seats.b : undefined;
    if (!aiSeat) {
      this.send(client, { t: 'toast', kind: 'error', message: '这局不是人机对局' });
      return;
    }
    if (room.status !== 'playing') {
      this.send(client, { t: 'toast', kind: 'error', message: '对局不在进行中' });
      return;
    }
    const result = this.rooms.undoAiMove(room, seat.color);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    /*
     * 作废还没落子的 AI 排期（玩家在 AI 想的时候点了撤回）。
     * 不作废的话，那一手会落在**撤回之后**的局面上 —— 局面已经变了，它那一手是无效的。
     */
    this.cancelAiMove(room);
    // 撤回到 AI 该走的时候（撤回到开局）→ 让 AI 重新落子
    if (this.rooms.turnOfRoom(room) === aiSeat.color) this.scheduleAiMove(room);
    this.broadcastRoom(room);
    this.persist();
  }

  private handleMove(
    client: Client,
    from: string,
    to: string,
    promotion?: 'q' | 'r' | 'b' | 'n',
  ): void {
    const room = this.currentRoom(client);
    if (!room) {
      this.send(client, { t: 'toast', kind: 'error', message: '你不在房间中' });
      return;
    }
    const result = this.rooms.submitMove(room, client.identity!, { from, to, promotion });
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
    this.scheduleAiMove(room);
  }

  /**
   * 打字聊天。
   *
   * **只有棋手能打字** —— 观战的人只能用快捷聊天（弹幕）。
   *
   * 观战者照样**看得见**棋手打的字（广播是发给房内所有人的），
   * 只是不能往记录里灌自己的话。
   */
  private handleChat(client: Client, text: string): void {
    const room = this.currentRoom(client);
    if (!room) return;
    if (!this.isPlayer(room, client.identity!.userId)) {
      this.send(client, { t: 'toast', kind: 'error', message: '观战只能用快捷聊天' });
      return;
    }
    const result = this.rooms.chat(room, client.identity!, text.slice(0, CHAT_MAX_LEN));
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcast(room, { t: 'chat', message: result.message });
  }

  /**
   * 快捷聊天。
   *
   * **和普通聊天走同一条广播路径**（`t: 'chat'`）——
   * 客户端只维护一套处理，差别看消息上的 `quick` 标记：
   * 带 `quick` 的**只飘弹幕，不进聊天记录**。
   *
   * 为什么不在协议里单开一个 `t: 'chat.quick'`：
   * 两种消息如果走两条路，客户端就得维护两套处理，
   * 迟早会漏掉一边（比如「快捷聊天飘了但没进记录」这种半吊子状态）。
   * 一条路 + 一个标记 ⇒ 规则统一：聊天只有一种，区别只在留不留底。
   *
   * `quick: true` 在**这里**盖一道 —— 广播出去的消息才是客户端看到的那一条，
   * 标记必须由广播方保证，不能指望下游记得加。
   *
   * 观战者**可以**发快捷聊天（这是他们唯一的发言方式）。
   *
   * 限频时静默丢弃 —— 点的是预设按钮，弹个 toast 反而莫名其妙。
   */
  private handleQuickChat(client: Client, text: string): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.quickChat(room, client.identity!, text);
    if (!result.ok) return;
    this.broadcast(room, { t: 'chat', message: { ...result.message, quick: true } });
  }

  private handleResign(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.resign(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
  }

  private handleDrawOffer(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.offerDraw(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.send(client, { t: 'toast', kind: 'info', message: '已发出和棋请求，等待对方回应' });
  }

  private handleDrawAccept(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.acceptDraw(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
  }

  /** 拒绝和棋（对方点了「反对」） */
  private handleDrawDecline(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const by = room.drawOffer;
    const result = this.rooms.declineDraw(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    if (by) {
      this.sendToColor(room, by, { t: 'toast', kind: 'info', message: '对方拒绝了和棋提议' });
    }
  }

  /** 发起悔棋请求 */
  private handleTakebackOffer(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.offerTakeback(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
    if (result.direct) {
      /*
       * **直接撤回**（对方还没回应）→ 对方那边棋盘上的棋子退了回去，
       * 他自己没动过手，得说一声是谁撤的。
       */
      const seat = this.rooms.findSeat(room, client.identity!.userId);
      const other: Color = seat?.color === 'w' ? 'b' : 'w';
      this.sendToColor(room, other, { t: 'toast', kind: 'info', message: '对方撤回了一步' });
    } else if (result.autoAccepted) {
      this.send(client, { t: 'toast', kind: 'success', message: '电脑同意了悔棋，已撤销上一步' });
    } else {
      this.send(client, { t: 'toast', kind: 'info', message: '已发出悔棋请求，等待对方回应' });
    }
  }

  /** 同意悔棋 */
  private handleTakebackAccept(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const by = room.takebackOffer?.by;
    const result = this.rooms.acceptTakeback(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
    if (by) {
      this.sendToColor(room, by, { t: 'toast', kind: 'success', message: '对方同意悔棋，已撤销你的那一步' });
    }
  }

  /** 拒绝悔棋 */
  private handleTakebackDecline(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const by = room.takebackOffer?.by;
    const result = this.rooms.declineTakeback(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    if (by) {
      this.sendToColor(room, by, { t: 'toast', kind: 'info', message: '对方拒绝了悔棋请求' });
    }
  }

  /** 给房间里执某一方的玩家发一条消息 */
  private sendToColor(room: RoomInternal, color: Color, message: ServerMessage): void {
    const seat = room.seats[color];
    if (!seat) return;
    const client = this.findClientByUserId(seat.userId);
    if (client) this.send(client, message);
  }

  private handleRematch(client: Client): void {
    const room = this.currentRoom(client);
    if (!room) return;
    const result = this.rooms.requestRematch(room, client.identity!);
    if (!result.ok) {
      this.send(client, { t: 'toast', kind: 'error', message: result.message });
      return;
    }
    this.broadcastRoom(room);
    this.persist();
    this.scheduleAiMove(room);
  }

  /**
   * AI 轮到时自动走子。
   *
   * 搜索放在**引擎子进程**里（`EnginePool`），所以这一步是异步的 ——
   * 主进程的事件循环照常跑，其他房间的广播、棋钟计时都不受影响。
   *
   * 「思考延迟」有两层：
   *  1. 引擎自己按难度花时间预算（easy 200ms / normal 800ms / hard 2500ms）；
   *  2. 额外加一点**最短思考时间**（`AI_MIN_THINK_MS`）——
   *     不然简单难度可能 20 毫秒就落子，玩家根本看不出是电脑在想。
   */
  private scheduleAiMove(room: RoomInternal): void {
    const aiSeat = room.seats.w?.isAI ? room.seats.w : room.seats.b?.isAI ? room.seats.b : undefined;
    if (!aiSeat || room.status !== 'playing') return;
    /*
     * **轮到 AI 才排期。**
     *
     * 玩家现在可以执白 —— 那初始局面轮到玩家，AI 这一手是**多余的**。
     * 而它不是无害的：`aiScheduled` 标记会占着，
     * 玩家走完第一步（轮到 AI 了）时排期会被「避免重复排期」挡回去，
     * 于是 AI 永远等不到回应。
     */
    if (this.rooms.turnOfRoom(room) !== aiSeat.color) return;
    // 避免重复排期
    if (room.aiScheduled) return;
    room.aiScheduled = true;
    room.aiScheduleId += 1;
    const scheduleId = room.aiScheduleId;
    const difficulty = room.difficulty;

    void (async () => {
      try {
        const started = Date.now();
        // AI 对局：难度**统一**由 Stockfish 的 UCI_Elo 限强表达
        //（easy 1320 / normal 1900 / hard 2400）。
        // builtin 引擎那套「easy 档 40% 概率故意走次优」不再参与难度控制 ——
        // SF 限强到 1320 本身就会犯低级错，拟人化更自然，而且全档只有一条难度机制。
        const move = await this.enginePool.analyze(room.fen, aiSeat.color, {
          difficulty,
          backend: 'auto',
        });
        // 最短思考时间：让玩家看到「电脑在想」
        const waited = Date.now() - started;
        if (waited < AI_MIN_THINK_MS) {
          await new Promise((r) => setTimeout(r, AI_MIN_THINK_MS - waited));
        }
        /*
         * 排期被**作废**了（玩家在 AI 想的时候点了撤回）→ 这一手作废。
         *
         * 用代号而不是 `aiScheduled` 判断：撤回之后玩家可能马上又走一步，
         * 那时新的排期已经开始，老回调只认自己的代号 —— 不会误伤新的排期。
         */
        if (room.aiScheduleId !== scheduleId) return;
        room.aiScheduled = false;
        if (room.status !== 'playing') return;
        // 排期期间局面可能已经变了（撤回 / 超时判负 / 房间结束）
        if (this.rooms.turnOfRoom(room) !== aiSeat.color) return;
        const result = this.rooms.submitAiMove(room, move ?? undefined);
        if (result.ok) {
          this.broadcastRoom(room);
          this.persist();
        }
      } catch {
        // 引擎挂了：不能让整局卡死 —— 回落到同进程的同步搜索（深度低、够用）
        if (room.aiScheduleId !== scheduleId) return;
        room.aiScheduled = false;
        if (room.status !== 'playing') return;
        const result = this.rooms.submitAiMove(room);
        if (result.ok) {
          this.broadcastRoom(room);
          this.persist();
        }
      }
    })();
  }

  /**
   * 作废还没落子的 AI 排期（人机局的「撤回」用）。
   *
   * 代号 +1 → 正在跑的回调回来时对不上号，直接放弃这一手。
   */
  private cancelAiMove(room: RoomInternal): void {
    room.aiScheduleId += 1;
    room.aiScheduled = false;
  }

  /**
   * 「辅助下棋」：算一步推荐着法，**只回给请求者本人**。
   *
   * 提示是私人的 —— 对手不该看见我在想什么。所以这里绝不走 broadcastRoom。
   */
  private async handleHintRequest(client: Client): Promise<void> {
    const room = this.currentRoom(client);
    if (!room) {
      this.send(client, { t: 'hint.result', error: '你不在房间里' });
      return;
    }
    if (room.status !== 'playing') {
      this.send(client, { t: 'hint.result', error: '对局已结束' });
      return;
    }
    // 只有**轮到自己走**的棋手才需要提示
    const seat = this.rooms.findSeat(room, client.identity!.userId);
    if (!seat) {
      this.send(client, { t: 'hint.result', error: '观战者没有推荐着法' });
      return;
    }
    const turn = this.rooms.turnOfRoom(room);
    if (turn !== seat.color) {
      this.send(client, { t: 'hint.result', error: '还没轮到你走' });
      return;
    }
    try {
      // 提示用**满血引擎**（用户要求「很强力的自动算法」），
      // 时间预算给到 hard 的上限，让推荐真的靠谱。
      //
      // limitStrength: false 是关键：辅助下棋**不能**限强，
      // 否则推荐会被难度档（easy 只有 1320 Elo）的限强拖成平庸着法。
      // 难度只对 AI 对局有意义，这里要的是最强的那一档。
      const move = await this.enginePool.analyze(room.fen, seat.color, {
        difficulty: 'hard',
        timeMs: HINT_TIME_MS,
        backend: 'auto',
        limitStrength: false,
      });
      this.send(client, { t: 'hint.result', move: move ?? undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(client, { t: 'hint.result', error: `推荐失败：${message}` });
    }
  }

  /**
   * 心跳：给每个连接发 protocol-level ping（浏览器会自动回 pong），
   * 并把长时间没有任何回音的连接**主动掐掉**。
   *
   * 为什么必须主动掐 —— 只依赖 TCP 'close' 事件是不够的：
   * 设备休眠、切 WiFi、拔网线这类情况，TCP 连接会变成「半开」，
   * 服务端既收不到 close 也收不到任何数据，连接会一直挂着。
   * 结果是玩家人已经走了，座位却一直算「在线」，
   * 房间永远显示「进行中」，双方既走不掉也结束不了（僵尸房间）。
   */
  private heartbeat(): void {
    const now = Date.now();
    for (const client of [...this.clients.values()]) {
      if (now - client.lastActiveAt > this.heartbeatTimeoutMs) {
        // 判定失联：terminate 会触发 close → onClose → 座位标记为断线 → 宽限后判负
        try {
          client.socket.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        client.socket.ping();
      } catch {
        /* ignore */
      }
    }
  }

  private onTick(): void {
    const before = this.lobbyFingerprint();
    const events = this.rooms.tick();
    for (const ev of events) {
      this.broadcastRoom(ev.room);
      // 请求超时 → 自动拒绝：告诉发起方「对方没在时限内回应」
      if (ev.event === 'offer-expired') {
        const msg =
          ev.kind === 'draw'
            ? '对方没有在时限内回应，和棋请求已自动拒绝'
            : '对方没有在时限内回应，悔棋请求已自动拒绝';
        this.sendToColor(ev.room, ev.by, { t: 'toast', kind: 'info', message: msg });
      }
    }
    // 对局状态变了（判负 / 超时 / 双方都掉线把座位清空）→ 大厅列表与房间存档必须同步刷新，
    // 否则玩家看到的仍是「进行中」，存档也停在旧状态。
    //
    // 注意不能只看 events.length：双方都断线时房间会回落成「等待对手」，
    // 这条路径**不产生** tick 事件，只有靠指纹比对才能发现。
    if (events.length > 0 || before !== this.lobbyFingerprint()) {
      this.broadcastLobby();
      this.persist();
    }
    // 棋钟每秒刷新（仅对进行中的房间）
    for (const room of this.rooms.allRooms()) {
      if (room.status === 'playing' && room.clock.enabled) {
        this.broadcastRoom(room);
      }
    }
  }

  private onClose(client: Client): void {
    this.clients.delete(client.id);
    if (!client.identity) return;

    // 会话档案保留（供重连恢复身份），只更新状态
    if (client.token) {
      const record = this.sessions.get(client.token);
      if (record) {
        record.queued = false;
        record.lastActiveAt = Date.now();
        if (client.roomCode) record.roomCode = client.roomCode;
      }
    }

    this.matchmaker.remove(client.identity.userId);

    // 座位保留，等待重连。
    // 注意竞态：用户刷新页面时，新连接可能已用同一 token 完成重连，
    // 这时旧连接的 close 事件才到达 —— 若此时再标记掉线，会把已恢复的座位又置为断开。
    // 因此先确认没有其他在线连接持有同一身份。
    const stillOnline = [...this.clients.values()].some(
      (c) => c.identity?.userId === client.identity!.userId,
    );
    const room = client.roomCode ? this.rooms.getRoom(client.roomCode) : undefined;
    if (room && !stillOnline) {
      this.rooms.disconnect(room, client.identity);
      this.broadcastRoom(room);
    }
    this.broadcastLobby();
  }

  /** 清理过期会话档案 */
  private cleanupSessions(): void {
    const now = Date.now();
    for (const [token, record] of this.sessions) {
      if (now - record.lastActiveAt > SESSION_TTL_MS) this.sessions.delete(token);
    }
  }

  /** 统一设置客户端所在房间，并同步到会话档案（保证重连能回到原房间） */
  private setRoom(client: Client, roomCode: string | undefined): void {
    client.roomCode = roomCode;
    if (!client.token) return;
    const record = this.sessions.get(client.token);
    if (record) record.roomCode = roomCode;
  }

  private currentRoom(client: Client): RoomInternal | undefined {
    if (!client.roomCode) return undefined;
    return this.rooms.getRoom(client.roomCode);
  }

  private findClientByUserId(userId: string): Client | undefined {
    for (const client of this.clients.values()) {
      if (client.identity?.userId === userId) return client;
    }
    return undefined;
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== 1) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      /* ignore */
    }
  }

  /** 给单个客户端发房间快照（附带其身份视角） */
  private sendRoom(room: RoomInternal, client: Client): void {
    const seat = this.rooms.findSeat(room, client.identity!.userId);
    /*
     * **待抽签的玩家也是 player**（不是观战者）——
     * 他已经在这局里了，只是黑白还没定。
     * 把他当成观战者的话，前端会给他显示「观战」视角。
     */
    const isPending = !seat && room.pending?.userId === client.identity!.userId;
    /*
     * **座位凭证只发给座位本人**（`sendRoom` 是单发，`broadcastRoom` 逐个调用它）。
     *
     * 它是「这个座位是我的」的证明 —— 广播出去就等于谁都能抢座位。
     * 客户端把它存进 `localStorage`，关掉网页再打开时凭它认领回原座。
     */
    const claimKey = this.rooms.claimKeyOf(room, client.identity!.userId);
    this.send(client, {
      t: 'room',
      state: this.rooms.publicView(room),
      role: seat || isPending ? 'player' : 'spectator',
      color: seat?.color,
      ...(claimKey ? { claimKey } : {}),
    });
  }

  /**
   * 这个人在这局里是不是**棋手**（而不是观战者）。
   *
   * 判据和 `sendRoom` 给客户端的 `role` **完全一致**：
   * 有座位算棋手；待抽签的玩家也算棋手（他已经在局里了，只是黑白没定）。
   *
   * 这条判据被两个地方用：
   *   - `sendRoom` → 告诉前端「你是棋手还是观战者」；
   *   - `handleChat` → 观战者不许打字聊天。
   * 写成一处，免得两边的「谁是观战者」对不上。
   */
  private isPlayer(room: RoomInternal, userId: string): boolean {
    if (this.rooms.findSeat(room, userId)) return true;
    return room.pending?.userId === userId;
  }

  /** 广播房间快照给房内所有人 */
  private broadcastRoom(room: RoomInternal): void {
    for (const client of this.clients.values()) {
      if (client.roomCode !== room.code) continue;
      this.sendRoom(room, client);
    }
  }

  /** 广播给房间内所有人 */
  private broadcast(room: RoomInternal, message: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.roomCode !== room.code) continue;
      this.send(client, message);
    }
  }

  /** 大厅快照广播给所有连接 */
  private broadcastLobby(): void {
    const state = this.lobbyState();
    for (const client of this.clients.values()) {
      this.send(client, { t: 'lobby', state });
    }
  }

  /**
   * 大厅列表里**该出现**的房间。
   *
   * 人机房间不出现（用户拍板）：自己跟电脑练的局，不需要出现在别人的列表里。
   */
  private listableRooms(): RoomInternal[] {
    return this.rooms.allRooms().filter((room) => !room.seats.w?.isAI && !room.seats.b?.isAI);
  }

  /**
   * 大厅列表的「指纹」—— 只包含列表上看得见的字段。
   *
   * 用途：判断大厅是否发生了变化，从而决定要不要广播。
   * 广播条件不能只靠「有没有产生事件」，因为很多状态变化不产生事件：
   *   - 双方都断线 → 座位被清空、房间回落「等待对手」（不产生 tick 事件）
   *   - 空房间被清理 → 房间从列表里消失（不产生 tick 事件）
   * 只要指纹变了就必须广播，否则客户端会一直拿着旧列表
   * （典型症状：房间早没了，大厅里那张卡却一直挂着）。
   */
  private lobbyFingerprint(): string {
    return this.listableRooms()
      .map((room) => {
        const online = Boolean(
          room.seats.w?.connected ||
            room.seats.w?.isAI ||
            room.seats.b?.connected ||
            room.seats.b?.isAI,
        );
        return [
          room.code,
          room.status,
          room.visibility,
          online ? '1' : '0',
          room.seats.w?.connected ? 'w1' : 'w0',
          room.seats.b?.connected ? 'b1' : 'b0',
          room.pending?.name ?? '-',
          room.spectators.length,
          room.seats.w?.name ?? '-',
          room.seats.b?.name ?? '-',
        ].join(':');
      })
      .sort()
      .join(';');
  }

  /**
   * **私信限频** —— 挡住「私信轰炸」。
   *
   * 客户端有冷却按钮，但**规则必须落在服务端**：客户端那层只是给人看的
   * 提示，改个协议就能绕过去 —— 绕过去的那种不算规则。
   *
   * 限频按**发送方**算（同一个人连着发，第二条就拒）：
   * 私信每一条都会在对方面板上弹一条提示，不限频的话，
   * 按住一颗快捷短语连点就能把对面顶栏糊成**一整列提示条**。
   *
   * 私信和房间邀请**共用这一个桶** —— 它们在对方那边长得一模一样
   * （都是「某给你发来一条消息」的提示），分成两个桶就等于留了一条
   * 「先用邀请刷屏」的绕路。
   */
  private dmTooFast(client: Client): boolean {
    const now = Date.now();
    if (now - client.lastDmAt < DM_SEND_MIN_INTERVAL_MS) {
      this.send(client, { t: 'toast', kind: 'error', message: '发送太快了，稍等一下' });
      return true;
    }
    client.lastDmAt = now;
    return false;
  }

  /**
   * 私信（点对点）。
   *
   * 不经过房间：大厅「在线 N」名单里右键某人 → 直接发给他。
   * **双方都收到这一条** —— 发送方也收到，这样他自己能看见发了什么
   * （不然「我发了没有」全靠猜）。
   *
   * **私信只能发快捷短语**（`DM_QUICK_CHATS` 里的那几句）：
   * 客户端没有输入框，服务端也**再挡一道** ——
   * 规则要落在服务端，不能只做一层 UI 皮（改个协议就能绕过去的那种不算规则）。
   */
  private handleDmSend(client: Client, to: string, text: string): void {
    const from = client.identity!;
    if (to === from.userId) {
      this.send(client, { t: 'toast', kind: 'error', message: '不能给自己发私信' });
      return;
    }
    const body = text.trim();
    if (!DM_QUICK_TEXT_SET.has(body)) {
      this.send(client, { t: 'toast', kind: 'error', message: '私信只能发快捷消息' });
      return;
    }
    const target = this.findClientByUserId(to);
    if (!target) {
      this.send(client, { t: 'toast', kind: 'error', message: '对方已经不在线了' });
      return;
    }
    /* 限频放在「对方还在不在」之后：没发出去的私信不该占掉发送间隔 */
    if (this.dmTooFast(client)) return;
    const message: DirectMessage = {
      id: randomUUID(),
      from: from.userId,
      fromName: from.name,
      to,
      toName: target.identity!.name,
      text: body,
      at: Date.now(),
    };
    this.send(target, { t: 'dm', message });
    this.send(client, { t: 'dm', message });
  }

  /**
   * **房间邀请**（私信的一种）。
   *
   * 邀请不是一句话，是一条**带房间码的结构化消息** —— 客户端把它渲染成
   * 可点的卡片，对方点一下直接进房。
   *
   * 规则全部在**服务端**把关（不能只做一层 UI 皮）：
   *  - 不能给自己发；
   *  - **发送者必须真的在这个房间里、而且是对局方** ——
   *    否则谁都能拿一个假房间码去骗人点进别人的局；
   *  - **人机对局不开放邀请** —— 对面坐的是电脑，没有「对手」可抢，
   *    邀请进来只能当观众。UI 上也不给这个按钮（两处必须一致）；
   *  - 房间已经结束 → 邀请发出去也没意义，拒收；
   *  - 对方必须在线（私信本来就只发给在线的人）。
   */
  private handleDmInvite(client: Client, to: string, roomCode: string): void {
    const from = client.identity!;
    if (to === from.userId) {
      this.send(client, { t: 'toast', kind: 'error', message: '不能给自己发邀请' });
      return;
    }
    const room = this.rooms.getRoom(roomCode);
    if (!room) {
      this.send(client, { t: 'toast', kind: 'error', message: '房间不存在' });
      return;
    }
    /*
     * 发送者必须是**这个房间的对局方**。
     *
     * 判据与 `sendRoom` 给客户端的 `role` 完全一致：有座位算对局方，
     * 待抽签的玩家（黑白还没定）也算 —— 他已经在这局里了。
     */
    const isPlayer =
      Boolean(this.rooms.findSeat(room, from.userId)) || room.pending?.userId === from.userId;
    if (!isPlayer) {
      this.send(client, { t: 'toast', kind: 'error', message: '你不在这个房间里' });
      return;
    }
    if (room.seats.w?.isAI || room.seats.b?.isAI) {
      this.send(client, { t: 'toast', kind: 'error', message: '人机对局不能邀请别人' });
      return;
    }
    if (room.status === 'finished') {
      this.send(client, { t: 'toast', kind: 'error', message: '对局已结束' });
      return;
    }
    /* 邀请和私信共用一个限频桶（见 dmTooFast 的说明） */
    const target = this.findClientByUserId(to);
    if (!target) {
      this.send(client, { t: 'toast', kind: 'error', message: '对方已经不在线了' });
      return;
    }
    /* 限频放在「对方还在不在」之后：没发出去的邀请不该占掉发送间隔 */
    if (this.dmTooFast(client)) return;
    const message: DirectMessage = {
      id: randomUUID(),
      from: from.userId,
      fromName: from.name,
      to,
      toName: target.identity!.name,
      text: `房间 ${room.code}`,
      at: Date.now(),
      kind: 'invite',
      roomCode: room.code,
    };
    this.send(target, { t: 'dm', message });
    this.send(client, { t: 'dm', message });
  }

  private lobbyState(): LobbyState {
    const rooms = this.listableRooms().map((room) => ({
      code: room.code,
      status: room.status,
      visibility: room.visibility,
      timeControl: room.timeControl,
      whiteName: room.seats.w?.name,
      blackName: room.seats.b?.name,
      // 待抽签的玩家（还没定黑白）—— 大厅里要显示他
      pendingName: room.pending?.name,
      spectatorCount: room.spectators.length,
      // 座位上还有没有人（AI 视为永远在线）
      playerOnline: Boolean(
        room.seats.w?.connected ||
          room.seats.w?.isAI ||
          room.seats.b?.connected ||
          room.seats.b?.isAI,
      ),
      updatedAt: room.updatedAt,
    }));
    /*
     * 在线名单：**只算已登录的连接**。
     *
     * 没登录的连接（刚连上还没发 hello）不算「一个人」——
     * 否则大厅会列出一个没有名字的空壳，右键也发不了私信。
     * `online` 必须等于名单长度：数字和名单对不上就是骗人。
     */
    const onlineUsers = [...this.clients.values()]
      .filter((c) => c.identity)
      .map((c) => ({ userId: c.identity!.userId, name: c.identity!.name }));
    return {
      rooms: rooms.sort((a, b) => b.updatedAt - a.updatedAt),
      queueSize: this.matchmaker.size,
      online: onlineUsers.length,
      onlineUsers,
      queuedUserIds: this.matchmaker.list().map((q) => q.userId),
    };
  }

  private persist(): void {
    scheduleSave(this.roomArchives());
    scheduleSaveSessions(this.sessionArchives());
  }

  /** 房间存档快照（落盘用） */
  private roomArchives(): RoomArchive[] {
    return this.rooms.allRooms().map((r) => this.rooms.archiveView(r));
  }

  /**
   * **立刻把当前状态写盘**（不等节流）。
   *
   * 用途：
   *  - **进程退出前** —— 节流窗口内被杀掉的话，存档会少掉最后几秒；
   *  - **测试里模拟「重启」** —— 要先落盘再造一个 hub 出来读回来。
   *
   * 必须**显式传快照**而不是依赖 store 内部的缓冲：
   * 缓冲只有被 `scheduleSave` 填过之后才有值，
   * 而「立刻写盘」最常见的两个场景里缓冲都可能是空的。
   */
  async flushNow(): Promise<void> {
    await flush(this.roomArchives(), this.sessionArchives());
  }

  /** 会话档案快照（落盘用） */
  private sessionArchives(): SessionArchive[] {
    return [...this.sessions.entries()].map(([token, record]) => ({
      token,
      userId: record.userId,
      name: record.name,
      roomCode: record.roomCode,
      lastActiveAt: record.lastActiveAt,
    }));
  }

  /**
   * **从磁盘恢复**（服务启动时调用）。
   *
   * 恢复两样东西：
   *  - **房间** —— 没下完的对局继续挂着，玩家回来就能接着下；
   *  - **会话档案** —— token → 身份的映射。
   *    这一条最关键：会话表是纯内存的，不存的话，
   *    玩家重启后刷新页面带 token 回来会被当成**新用户** → 座位认不回来。
   *
   * 恢复出来的房间一律是「全员断线」状态 —— 重启后没有任何连接活着，
   * 走的是断线宽限期那条路（回来就续上，超时才判负）。
   */
  async restoreFromDisk(): Promise<void> {
    const [archives, sessions] = await Promise.all([loadRooms(), loadSessions()]);
    const { restored, migrated } = this.rooms.restoreRooms(archives);
    for (const record of sessions) {
      this.sessions.set(record.token, {
        userId: record.userId,
        name: record.name,
        roomCode: record.roomCode,
        queued: false,
        lastActiveAt: record.lastActiveAt,
      });
    }
    if (restored > 0 || sessions.length > 0) {
      /*
       * 报的是「**真的恢复了几个**」，不是「读到了几个」。
       * 认不出的存档、房间号撞了的，都恢复不了 —— 报读到的数量会让人以为都回来了。
       */
      console.log(`[hub] 从存档恢复：${restored} 个房间 / ${sessions.length} 条会话`);
      if (migrated > 0) {
        console.log(
          `[hub] 其中 ${migrated} 个是旧格式存档，已迁移：棋局（走子/棋钟/聊天）保留，` +
            `但旧存档没有座位凭证 —— 座位主人关掉网页后未必认领得回自己的座位`,
        );
      }
    }
    /*
     * 恢复完**立刻落一次盘** —— 顺手把旧格式存档升级成新格式，
     * 下次启动就不用再迁移一遍（迁移是幂等的，但没必要每次都走一遍）。
     */
    if (migrated > 0) await this.flushNow();
  }
}
