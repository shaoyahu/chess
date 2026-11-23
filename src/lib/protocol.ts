/**
 * WebSocket 协议定义 —— 客户端与服务端共用。
 * 所有入站消息用 zod 校验，未知/非法消息一律丢弃并回 toast。
 */
import { z } from 'zod';
import type { Color, LobbyState, RoomState } from './types';

const colorSchema = z.enum(['w', 'b']);
const pieceSchema = z.enum(['p', 'n', 'b', 'r', 'q', 'k']);
/** 升变只可能是后/车/象/马 */
const promotionSchema = z.enum(['q', 'r', 'b', 'n']);

/** 客户端 → 服务端 */
export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    name: z.string().min(1).max(20),
    token: z.string().max(64).optional(),
  }),
  z.object({
    t: z.literal('queue.join'),
    /**
     * 期望的时限。`'any'` = **任意时间**都能接受。
     * 缺省 = 默认时限。
     */
    timeControl: z.string().max(16).optional(),
  }),
  z.object({ t: z.literal('queue.leave') }),
  z.object({
    t: z.literal('room.create'),
    timeControl: z.string().max(16).optional(),
    withAI: z.boolean().optional(),
    /** AI 难度档（只在 withAI 时有意义） */
    difficulty: z.enum(['easy', 'normal', 'hard']).optional(),
    /**
     * 人机对局时**玩家执什么颜色**。
     *
     * `'random'` = 服务端抽签；`'w'` / `'b'` = 玩家自己挑。
     * 缺省 = `'random'`（老客户端没有这个字段）。
     */
    color: z.enum(['random', 'w', 'b']).optional(),
    /**
     * 房间可见性：公开房在列表里可直接加入，邀请房只认房间码。
     * 缺省 = 公开（老客户端没有这个字段）。
     */
    visibility: z.enum(['public', 'invite']).optional(),
  }),
  z.object({
    t: z.literal('room.join'),
    code: z.string().length(4),
    mode: z.enum(['play', 'spectate']).default('spectate'),
  }),
  z.object({ t: z.literal('room.leave') }),
  /**
   * **认领座位** —— 「关掉网页再打开」之后，凭座位凭证坐回原座。
   *
   * 为什么需要它（和 `room.join` 不是一回事）：
   *  - `room.join` 是**进一个房间**（抢空座 / 观战），凭证是「你在这个房间里是谁」；
   *  - `room.claim` 是**坐回原来那个座位**，凭证是「这个座位是你的」。
   *
   * 关键差别：`sessionStorage` 里的 token 一关标签页就没了，
   * 所以重开后客户端是**新身份**（新 userId）——
   * 拿新身份 `room.join` 只会变成观战。
   * 而座位凭证存在 `localStorage` 里，关标签页、关浏览器都还在，
   * 凭它才能把座位**转**给新身份。
   *
   * 凭证由服务端在分配座位时生成，**只发给座位本人**。
   */
  z.object({
    t: z.literal('room.claim'),
    code: z.string().length(4),
    /** 座位凭证（服务端生成的那串） */
    claimKey: z.string().min(8).max(64),
  }),
  /**
   * 「我准备好了」—— 真人对局在抽签之后、正式开局之前，双方各点一次。
   *
   * **双方都点了才开局**（白方先走）。
   * 人机对局不走这一步（AI 不需要准备），所以这条消息在人机房里会被忽略。
   */
  z.object({ t: z.literal('ready') }),
  /**
   * **人机对局**的「撤回」：撤销自己上一步走的那手棋。
   *
   * 只有人机局有这条 —— 真人对局里撤回要走「请求 / 同意」那一套。
   */
  z.object({ t: z.literal('ai.undo') }),
  z.object({
    t: z.literal('move'),
    from: z.string().length(2),
    to: z.string().length(2),
    promotion: promotionSchema.optional(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().min(1).max(200) }),
  /**
   * 私信（点对点，不经过房间）。
   *
   * `to` 是**对方的 userId** —— 从大厅「在线 N」名单里右键某人拿到的。
   */
  z.object({
    t: z.literal('dm.send'),
    to: z.string().min(1).max(64),
    text: z.string().min(1).max(200),
  }),
  /**
   * **房间邀请**（私信的一种）。
   *
   * 为什么和 `dm.send` 分开走：邀请**不是一句话**，是一条带房间码的
   * 结构化消息 —— 客户端要把它渲染成**可点的卡片**（点一下直接进房）。
   *
   * 走 `dm.send` 是塞不下的：那条消息的正文只能是 `DM_QUICK_CHATS`
   * 里的预设短语，服务端会按白名单拒收。
   */
  z.object({
    t: z.literal('dm.invite'),
    to: z.string().min(1).max(64),
    /** 被邀请的房间码（4 位） */
    roomCode: z.string().length(4),
  }),
  // 快捷聊天（弹幕）：预设文本，飘过屏幕，不进聊天记录
  z.object({ t: z.literal('chat.quick'), text: z.string().min(1).max(60) }),
  z.object({ t: z.literal('resign') }),
  z.object({ t: z.literal('draw.offer') }),
  z.object({ t: z.literal('draw.accept') }),
  /** 拒绝和棋提议（超时也会自动拒绝） */
  z.object({ t: z.literal('draw.decline') }),
  /** 发起悔棋请求（对方同意后撤销自己的那一步） */
  z.object({ t: z.literal('takeback.offer') }),
  z.object({ t: z.literal('takeback.accept') }),
  z.object({ t: z.literal('takeback.decline') }),
  z.object({ t: z.literal('rematch') }),
  z.object({ t: z.literal('rematch.accept') }),
  /**
   * 请求「推荐下一步」（辅助下棋）。
   *
   * 服务端用引擎算一遍再回给**发起者一个人**（不广播 —— 提示是私人的）。
   */
  z.object({ t: z.literal('hint.request') }),
  z.object({ t: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** 服务端 → 客户端 */
export type ServerMessage =
  | { t: 'session'; token: string; userId: string; name: string }
  | { t: 'lobby'; state: LobbyState }
  | {
      t: 'room';
      state: RoomState;
      /** 你在该房间中的身份视角 */
      role: 'player' | 'spectator';
      color?: Color;
      /**
       * **座位凭证** —— 只在「你是棋手」时才有，**只发给你本人**。
       *
       * 客户端把它存进 `localStorage`：「关掉网页再打开」之后，
       * `sessionStorage` 里的身份凭证已经没了（标签页一关就没），
       * 靠这个凭证才能坐回原来那个座位，而不是变成一个观战者。
       *
       * 服务端**绝不广播**它 —— 广播出去就等于谁都能抢这个座位。
       */
      claimKey?: string;
    }
  /**
   * 一条聊天消息。
   *
   * **打字的和点快捷按钮的走同一种消息** ——
   * 客户端收到后会既写进聊天记录、又飘一条弹幕。
   */
  | { t: 'chat'; message: import('./types').ChatMessage }
  /**
   * 一条私信。
   *
   * **双方都会收到这一条**（发送方也收，这样自己看得到自己发了什么）。
   */
  | { t: 'dm'; message: import('./types').DirectMessage }
  /**
   * 私信的**剩余额度** —— 「我现在还能给谁发几条」。
   *
   * 为什么要有这条消息：私信的**互惠限流**（连发 3 条后要等对方回一条）
   * 的**判定权在服务端**（`DM_MAX_UNANSWERED`），
   * 但客户端得知道「现在发不了」才能把按钮变灰。
   *
   * 为什么是服务端**推**给客户端，而不是客户端自己数：
   *   - 客户端手里只有**自己那台机器上**的私信存档，
   *     换个设备、或者服务端重启过，两边就会对不上；
   *   - 客户端自己数出来的「锁定」一旦和服务端不一致，
   *     表现就是「按钮一直灰着，怎么都发不出去」—— 界面在骗人。
   *
   * 所以：**服务端是唯一的事实来源**，客户端只负责把它显示出来。
   *
   * `states` 是**增量**（合并，不是替换）：一次只带跟这次相关的对话。
   * 重新登录时服务端会推一份全量的（见 ws-hub 的 `pushDmAllState`）。
   */
  | {
      t: 'dm.state';
      states: {
        /** 对方的 userId */
        peer: string;
        /** 我还能给他发几条（0 = 被锁住，等对方回一条） */
        remaining: number;
      }[];
    }
  | { t: 'toast'; kind: 'info' | 'error' | 'success'; message: string }
  /**
   * 「推荐下一步」的结果（只发给请求者本人）。
   *
   * `move` 为空表示算不出来（局面已终局 / 引擎超时）。
   */
  | { t: 'hint.result'; move?: { from: string; to: string }; error?: string }
  | { t: 'pong' }
  /**
   * 服务端拒绝了本次请求。
   *
   * 目前只有一处用：**进入房间失败**（房间不存在 / 对局已结束 / 观战人数已满）。
   *
   * 为什么不能只回一个 toast：toast 3.5 秒就消失，而「进不去房间」是个
   * **需要一直看得见**的状态 —— 客户端要靠这条消息把「正在进入房间…」
   * 换成**写明原因的错误卡片**。否则页面会永远停在那张卡上：
   * 用户既不知道为什么进不去，也找不到出口（刷新后卡死的真实原因）。
   *
   * `code` 是**这个错误说的是哪个房间** —— 失败可能发生在别的页面
   * （比如从私信的邀请卡片点进来时，失败发生在大厅页），
   * 对局页是之后才挂上的，它得靠这个字段判断「这条错跟我有没有关系」。
   */
  | { t: 'error'; message: string; code?: string };

/** 解析客户端消息；失败返回 null */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const json = JSON.parse(raw);
    const parsed = clientMessageSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
