/** 全局共享常量（客户端 / 服务端 / 测试同源） */

/** 棋盘列 a-h */
export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
/** 棋盘行 8-1（rank 8 在数组首位） */
export const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'] as const;

/** 初始局面 FEN */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** 房间码字符集：去掉易混淆的 0/O/1/I */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

/**
 * 断线保留座位时长：**5 分钟**。
 *
 * 期间对方可以重连回来接着下；超时则判对方胜（reason = abandon）。
 *
 * 为什么是 5 分钟而不是原来的 60 秒（实测推出来的）：
 * 浏览器对「断网」的感知**很慢** —— 拔网线、切 Wi-Fi、手机息屏之后，
 * WebSocket 的 close 事件可能几十秒后才触发；服务端还要等
 * 45 秒心跳超时才主动 terminate。两段叠加，**实际从断网到判负
 * 可能超过 100 秒**，60 秒的宽限期根本不够 —— 玩家只是网断了一下，
 * 回来发现局已经判负了。
 *
 * 5 分钟覆盖了「手机切个 Wi-Fi / 电梯里 / 短暂断网」这些真实场景。
 * 代价是僵尸房间在大厅里多挂 5 分钟（对方看到的是「等待重连」，
 * 不是「进行中」），这个代价换来玩家能真的回来，值得。
 */
export const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

/** 聊天单条最大长度 */
export const CHAT_MAX_LEN = 200;
/** 聊天最小间隔（ms），防刷屏 */
export const CHAT_MIN_INTERVAL_MS = 800;
/** 快捷聊天（弹幕）单条最大长度 —— 预设短语，短一点才像弹幕 */
export const QUICK_CHAT_MAX_LEN = 60;
/** 快捷聊天最小间隔（ms）—— 单独计时，不占用普通聊天的限频 */
export const QUICK_CHAT_MIN_INTERVAL_MS = 700;

/** 每个房间最大观战人数 */
export const MAX_SPECTATORS = 20;

/**
 * **私信**的快捷短语（大厅里给人发消息时用的那几颗按钮）。
 *
 * 私信**不能自己打字**，只能从这里挑一句发出去。
 *
 * 为什么和房间里的快捷聊天是**两套**：
 * 房间里说的是「这盘棋的事」（好棋 / 手滑了 / 想静静），
 * 私信里说的是「要不要一起下一盘」（来一盘？ / 缺个对手）——
 * 场景不同，话也得不同。共用一套会出戏（在私信里喊「手滑了」很奇怪）。
 *
 * 这份名单**同时是服务端的校验依据**（见 ws-hub.handleDmSend）：
 * 不在名单里的私信一律拒收 —— 规则要落在服务端，不能只做一层 UI 皮。
 */
export const DM_QUICK_CHATS = [
  '来一盘？',
  '房间还开着？',
  '缺个对手',
  '马上到',
  '先占个位',
  '下次一定',
] as const;

/** 私信白名单（服务端据此判断一条私信是不是合法快捷短语） */
export const DM_QUICK_TEXT_SET: ReadonlySet<string> = new Set(DM_QUICK_CHATS);

/**
 * **私信**的最小发送间隔（毫秒）。
 *
 * 为什么私信要单独限频（房间里那套 `QUICK_CHAT_MIN_INTERVAL_MS` 管不到它）：
 *   房间里的快捷聊天是**飘弹幕**，不落地、不给对面弹提示；
 *   而私信每一条都会**在对方面板上弹一条提示**。
 *   于是「按住那颗快捷短语连点」在房间里只是多几条弹幕，
 *   在私信里却能把对面顶栏糊成**一整列提示条**（用户反馈）。
 *
 * 所以私信有自己的、更宽松一点的间隔：**1.2 秒**一条。
 *   - 够挡住「手速爆点」和脚本轰炸；
 *   - 又不至于让正常的一问一答觉得卡。
 *
 * **限频按发送方算**（不是按「发给谁」算）：一个人一口气只能发一条，
 * 换个人发也不行 —— 否则「群发骚扰」这条路是通的。
 *
 * 客户端（按钮冷却）与服务端（拒收）用**同一个值**：
 * 客户端那层是给手快的自己看的，服务端那层才是规则本身。
 */
export const DM_SEND_MIN_INTERVAL_MS = 1200;

/**
 * 私信的**互惠限流**：连着发多少条之后，必须等**对方回一条**才能继续发。
 *
 * ## 为什么要有这条
 *
 * 上面那个 1.2 秒间隔挡的是「**手速**」，挡不住「**骚扰**」：
 * 一个人只要愿意等，每隔 1.3 秒发一条，就能把对面淹没 ——
 * 对面只要不回，他就一直能发。这条规则堵的就是这条路：
 *
 *   - 我给某人连发 **3 条** → 第 4 条起**发不出去**；
 *   - 除非**对方回了我一条** → 我的额度重置，又能发 3 条；
 *   - **对方也一样**：他回了我之后，他自己也只能连发 3 条。
 *
 * 也就是说：**能不能继续说，取决于对方有没有理你**。
 * 一问一答能正常聊；单方面刷屏聊不下去。
 *
 * ## 计数怎么记
 *
 * 每个**方向**各记一个数：「我发了多少条、对方还没回」。
 * 对方一回，那条数就归零 —— 因为「对方回应了」本身就是解锁信号。
 *
 * **私信文字与房间邀请共用这一个数**：邀请在对方面板上也长得像一条私信，
 * 分成两个桶就等于留了一条「先用邀请刷屏」的绕路。
 *
 * 规则落在**服务端**（客户端只负责把按钮变灰）。
 */
export const DM_MAX_UNANSWERED = 3;

/**
 * 和棋 / 悔棋请求的**回应时限**（毫秒）。
 *
 * 超时 = **自动拒绝**（用户要求：「设定超时自动反对」）。
 * 服务端用 1 秒一次的 tick 判定，所以实际生效时间在时限 +1 秒内。
 */
export const OFFER_TIMEOUT_MS = 30 * 1000;

/** 心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 15000;
/** 服务端判定客户端失联的宽限 */
export const HEARTBEAT_TIMEOUT_MS = 45000;

/**
 * **客户端心跳间隔**（毫秒）—— 客户端主动发 `ping` 的频率。
 *
 * 为什么客户端也要有心跳（服务端不是已经在 ping 了吗）：
 * 服务端的心跳只能让**服务端**发现「这个客户端没了」，
 * 它管不了**客户端**什么时候发现自己没了。
 *
 * 浏览器对断网的感知很慢 —— 拔网线、切 Wi-Fi、手机息屏之后，
 * WebSocket 的 `close` 事件可能几十秒后才触发。那段时间里
 * 客户端以为自己还连着，什么都不做，重连自然也起不来。
 *
 * 客户端自己主动探测，才能在断网后**十几秒内**就重连。
 */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 5000;

/**
 * 客户端多久收不到服务端消息就认定「连接已死」（毫秒）。
 *
 * 取 2 倍心跳间隔 —— 允许丢一个包，但不容忍连丢两个。
 * 宁可多重连一次（重连很快，1.5 秒），也不要卡在半开连接上几分钟。
 */
export const CLIENT_HEARTBEAT_TIMEOUT_MS = 10000;

/** 棋钟刷新广播间隔 */
export const CLOCK_TICK_MS = 1000;

/** 时限预设：ms + 增量 ms */
export const TIME_CONTROLS = {
  none: { label: '不限时', initialMs: 0, incrementMs: 0 },
  '5+0': { label: '5 分钟', initialMs: 5 * 60_000, incrementMs: 0 },
  '10+0': { label: '10 分钟', initialMs: 10 * 60_000, incrementMs: 0 },
  '15+10': { label: '15 分钟 + 10 秒', initialMs: 15 * 60_000, incrementMs: 10_000 },
  '30+0': { label: '30 分钟', initialMs: 30 * 60_000, incrementMs: 0 },
} as const;

export type TimeControlKey = keyof typeof TIME_CONTROLS;

/**
 * 快速匹配里的「**任意**时限」标记。
 *
 * 选了它的人**愿意跟任何时限的人配对**；没选的人只跟时限相同的人配对。
 */
export const MATCH_TIME_ANY = 'any';

/** 默认时限 */
export const DEFAULT_TIME_CONTROL: TimeControlKey = '10+0';

/**
 * 把客户端传来的时限字符串收敛成合法键。
 *
 * 非法值一律落到默认时限 —— 客户端传什么都不能造出一个不存在的棋钟配置。
 */
export function normalizeTimeControl(raw?: string): TimeControlKey {
  if (!raw) return DEFAULT_TIME_CONTROL;
  if (Object.prototype.hasOwnProperty.call(TIME_CONTROLS, raw)) return raw as TimeControlKey;
  return DEFAULT_TIME_CONTROL;
}

/** 视图模式 */
export type ViewMode = '2d' | '3d';
/** 默认视图（需求：默认 2D） */
export const DEFAULT_VIEW_MODE: ViewMode = '2d';

/** 视角：按自己执子颜色决定棋盘朝向 */
export type Orientation = 'w' | 'b';
