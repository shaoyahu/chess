import type { Orientation, TimeControlKey } from './constants';

/** 棋子颜色 */
export type Color = 'w' | 'b';

/**
 * 房间可见性。
 *
 * - `public`：出现在大厅房间列表里，别人可以直接点「加入」进来。
 * - `invite`：**不公开房间码**，列表里只能观战；只有拿着房间码的人能加入。
 */
export type RoomVisibility = 'public' | 'invite';

/** 棋子类型 */
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/**
 * AI 难度档。
 *
 * 与搜索引擎里的 `Difficulty` 是同一个字符串联合（结构相同，类型可互换）。
 */
export type Difficulty = 'easy' | 'normal' | 'hard';

/** 难度档的中文名（界面用） */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
};

/** 默认难度 */
export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

/** 一次走子记录 */
export interface MoveRecord {
  from: string;
  to: string;
  piece: PieceType;
  color: Color;
  san: string;
  captured?: PieceType;
  promotion?: PieceType;
  /** chess.js flags：n=普通 b=双吃 e=吃过路兵 k=王车易位 q=皇后易位 */
  flags: string;
  ts: number;
}

/** 终局结果 */
export type ResultReason =
  | 'checkmate'
  | 'stalemate'
  | 'resign'
  | 'timeout'
  | 'draw'
  | 'material'
  | 'fifty'
  | 'threefold'
  | 'abandon';

export interface GameResult {
  winner: Color | 'draw';
  reason: ResultReason;
}

/** 座位 */
export interface Seat {
  userId: string;
  name: string;
  color: Color;
  connected: boolean;
  disconnectedAt?: number;
  isAI: boolean;
  /**
   * **座位凭证** —— 持有它就能在「关掉网页再打开」后认领回这个座位。
   *
   * 为什么需要它（和 token 不是一回事）：
   *  - `token` 是**身份**凭证，存在 `sessionStorage` → **标签页一关就没了**；
   *    同一个浏览器开两个标签页必须是两个玩家（联机测试很常见）。
   *  - `claimKey` 是**座位**凭证，存在 `localStorage` → 关标签页、甚至关浏览器都还在；
   *    但它只对**一个座位**有效，所以两个标签页拿到的是不同的 claimKey。
   *
   * 有了它，「关掉网页再打开」可以带着凭证回来认领原座位，
   * 而不是一个新用户去抢座（抢不到就只能观战）。
   *
   * **只发给座位本人**，绝不广播 —— 广播出去就等于谁都能抢这个座位。
   */
  claimKey?: string;
  /**
   * 是否已准备（只对真人对局有意义 —— AI 不需要准备）。
   *
   * 双方都 `ready` 才开局：随机抽签之后白方先走，
   * 得给白方一点时间看清自己执的是哪一边。
   */
  ready?: boolean;
}

/** 观战者 */
export interface Spectator {
  userId: string;
  name: string;
  connected: boolean;
}

/** 棋钟 */
export interface ClockState {
  /** 白方剩余毫秒 */
  wMs: number;
  /** 黑方剩余毫秒 */
  bMs: number;
  /** 每步增量（毫秒） */
  incrementMs: number;
  /** 上次结算时间戳 */
  lastTickAt: number;
  /** 是否正在计时 */
  running: boolean;
  /** 是否启用棋钟 */
  enabled: boolean;
}

export interface ChatMessage {
  userId: string;
  name: string;
  text: string;
  ts: number;
  /**
   * 这是**快捷聊天**（弹幕），不是打字的聊天。
   *
   * 快捷聊天**只飘弹幕，不进聊天记录** ——
   * 聊天记录里留的全是正经聊的话，弹幕一扫就没，不占地方。
   */
  quick?: boolean;
}

/**
 * 房间状态。
 *
 * - `waiting` —— **等人来**（还没凑齐两个人；颜色也还没抽）
 * - `preparing` —— **人齐了、颜色也抽了，等双方点「准备」**
 * - `playing` —— 对局中
 * - `finished` —— 终局
 *
 * `preparing` 是给「随机抽签」用的 —— 抽签发生在两人到齐的那一刻，
 * 而白方先走，得给白方一点准备时间（见 PLAN 的 AB 段）。
 */
export type RoomStatus = 'waiting' | 'preparing' | 'playing' | 'finished';

/** 待回应的请求（和棋 / 悔棋） */
export interface PendingOffer {
  /** 谁发起的 */
  by: Color;
  /** 超时时间戳（毫秒）—— 超过就自动拒绝 */
  deadline: number;
}

/** 房间完整状态（广播给房内所有连接） */
export interface RoomState {
  code: string;
  status: RoomStatus;
  seats: { w?: Seat; b?: Seat };
  /**
   * **颜色待定**的玩家 —— 还没抽签。
   *
   * 为什么需要它：黑白是**两人到齐时**才抽的（用户拍板），
   * 所以先进来的那个人在这段时间里**还没有颜色**。
   *
   * 这时候他既不是白方也不是黑方，但**仍然是个玩家**（不是观战者）——
   * 前端拿 `pending` 判断「我在这局里」，不能拿 `seats.w/b`。
   */
  pending?: {
    userId: string;
    name: string;
    /** 内部字段：断线重连要靠它。`publicView` 会裁掉，不发给客户端 */
    connected?: boolean;
    disconnectedAt?: number;
    /**
     * **座位凭证**（待抽签阶段的那个槽位也有）。
     *
     * 抽签之后这个凭证会**跟着玩家一起**转到正式座位上（`assignColors`），
     * 这样「等对手时关掉网页 → 重开后认领」也能续上。
     */
    claimKey?: string;
  };
  spectators: Spectator[];
  fen: string;
  moves: MoveRecord[];
  result?: GameResult;
  /**
   * 结果是否**已被超时锁定**。
   *
   * 规则（用户拍板）：**超时判负就定局** —— 之后不管是��死、认输还是和棋，
   * 都不再改写这个结果。它只是**不结束棋局**：双方照样能继续下，
   * 棋钟也照样走（允许走到负数）。
   *
   * 所以「超时」和「终局」在这里是**两件事**：
   *   - 结果：超时那一刻就定了，之后不变；
   *   - 棋局：继续走，直到真的将死/认输/和棋才结束。
   */
  resultLocked?: boolean;
  /**
   * 已经因超时被判负过的一方（两边都超时的话两个都在里面）。
   *
   * 用来做两件事：
   *  - 服务端**不重复播报**（否则每秒都会报一次「超时」）；
   *  - 前端在那一行标一个「已超时」。
   */
  flagged?: Color[];
  /** 当前走子方是否正被将军（服务端算好广播给前端，前端不用自己算） */
  inCheck: boolean;
  clock: ClockState;
  chat: ChatMessage[];
  /** 和棋提议：发起方的颜色（同时是「谁在等回应」） */
  drawOffer?: Color;
  /** 和棋提议的截止时间戳 */
  drawDeadline?: number;
  /** 悔棋请求（发起方 + 截止时间） */
  takebackOffer?: PendingOffer;
  rematchVotes: Color[];
  /** AI 难度档（人机对局用；真人对局也是默认值） */
  difficulty: Difficulty;
  /**
   * 房间可见性 —— 公开房在列表里可直接加入，邀请房只认房间码。
   *
   * 房间**创建后不变**，所以它同时是这个房间「能不能被别人直接点进来」的判据。
   */
  visibility: RoomVisibility;
  createdAt: number;
  updatedAt: number;
}

/** 大厅「在线名单」里的一行 —— 点顶栏「在线 N」看的就是它 */
export interface OnlineUser {
  userId: string;
  name: string;
}

/**
 * 私信的**类型**。
 *
 * - `text` —— 一句快捷短语（私信本来就只能发预设短语）。
 * - `invite` —— **房间邀请**：带着房间码，客户端把它渲染成**可点的卡片**，
 *   对方点一下直接进房。
 */
export type DirectMessageKind = 'text' | 'invite';

/**
 * 一条**私信**（不经过房间，直接点对点）。
 *
 * 聊天消息是房间级的；私信是「我在大厅里看见这个人，给他发一句话」。
 */
export interface DirectMessage {
  id: string;
  /** 发送者 userId */
  from: string;
  fromName: string;
  /** 接收者 userId */
  to: string;
  /** 接收者名字 —— 发送方那边的会话列表要靠它显示「我跟谁聊过」 */
  toName: string;
  text: string;
  at: number;
  /**
   * 消息类型。
   *
   * 旧存档（`localStorage` 里的历史私信）没有这个字段 ——
   * 读出来一律当 `text`（见 `useSocket.loadDmStore`），不用做数据迁移。
   */
  kind?: DirectMessageKind;
  /**
   * 邀请的**房间码**（`kind === 'invite'` 时才有值）。
   *
   * 对方点卡片时用的就是它 —— 没有它就只是一句普通的话。
   */
  roomCode?: string;
}

/**
 * **房间存档**（落盘用）—— 比对外快照多存几样恢复时必须的东西。
 *
 * 为什么不能直接存 `RoomState`：
 *  - `timeControl` 被 `publicView` 剔掉了 —— 恢复后棋钟时限就废了；
 *  - 座位凭证 `claimKey` 也被剔掉了 —— 它是**秘密**，绝不能跟着广播走，
 *    但恢复后必须还在，否则玩家认不回自己的座位。
 *
 * 所以存档是**独立的结构**，只在磁盘上流转，从不下发给客户端。
 */
export interface RoomArchive {
  /** 房间完整状态（对外快照那一套） */
  state: RoomState;
  /** 房间时限（`RoomState` 里没有，但恢复棋钟需要） */
  timeControl: TimeControlKey;
  /**
   * 座位凭证 —— 按颜色存（`w` / `b` / `pending`）。
   *
   * 不放进 `state.seats` 里，是为了保证它**永远不会**被广播出去：
   * `publicView` 剔掉了它，而这里单独存一份，只有落盘/读档用。
   */
  claimKeys?: {
    w?: string;
    b?: string;
    pending?: string;
  };
}

/**
 * 会话存档（落盘用）—— token → 身份。
 *
 * 为什么也要落盘：服务重启后 `sessions` 表就空了，
 * 玩家刷新页面带 token 回来会被当成**新用户** → 座位认不回来。
 * 存下来，重启后照样能认回身份。
 */
export interface SessionArchive {
  token: string;
  userId: string;
  name: string;
  roomCode?: string;
  lastActiveAt: number;
}

/** 大厅房间摘要 */
export interface RoomSummary {
  code: string;
  status: RoomStatus;
  /**
   * 房间可见性。
   *
   * `invite` 的房间**不下发房间码给列表**（虽然摘要里仍有 code ——
   * 那是服务端自己的字段，客户端在邀请房那一行不会把它显示出来）。
   */
  visibility: RoomVisibility;
  /** 房间时限（列表上要显示「时长」） */
  timeControl: TimeControlKey;
  whiteName?: string;
  blackName?: string;
  /**
   * **颜色待定**的玩家名字（还没抽签，所以没有白/黑）。
   *
   * 大厅里显示这一行时用它 —— 否则会显示成「空房间」，
   * 而实际上房里是有人的。
   */
  pendingName?: string;
  spectatorCount: number;
  /**
   * 座位上是否还有人（AI 视为永远在线）。
   * 两个座位都掉线时，房间仍然是「进行中」（在等人重连），
   * 但大厅里必须显示成「等待重连」而不是「进行中」——
   * 否则人已经走了，对局列表却一直挂着，看起来像局没结束。
   */
  playerOnline: boolean;
  updatedAt: number;
}

/** 大厅快照 */
export interface LobbyState {
  rooms: RoomSummary[];
  queueSize: number;
  /** 在线人数 —— **必须等于 onlineUsers.length**（数字与名单对不上就是骗人） */
  online: number;
  /**
   * 当前在线的人（已登录的连接）。
   *
   * 大厅顶栏点「在线 N」弹出的名单、右键发私信要用的 userId，都来自这里。
   */
  onlineUsers: OnlineUser[];
  /** 正在匹配队列中的用户 id（用于让客户端显示「匹配中」） */
  queuedUserIds: string[];
}

/** 视图模式 */
export type { Orientation, ViewMode } from './constants';
