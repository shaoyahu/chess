'use client';

/**
 * WebSocket 连接 —— **全局单例**。
 *
 * 为什么必须是单例：
 *  - 大厅页与房间页是两个不同的路由组件，各自调用 useSocket()。
 *    如果每次调用都新建连接，同一个标签页会开出两条 WebSocket，
 *    服务端会把它们当成两个用户（座位错乱、在线人数虚高）。
 *  - 单例保证：整个标签页只有一条连接、只有一份身份。
 *
 * 状态通过 useSyncExternalStore 订阅，组件卸载不会断开连接，
 * 路由切换（大厅 ↔ 房间）时连接保持不断。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ServerMessage } from '@/lib/protocol';
import type { Color, ConnectionStatus, DirectMessage, LobbyState, RoomState } from '@/lib/types';
import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  CLIENT_HEARTBEAT_TIMEOUT_MS,
} from '@/lib/constants';
import { resolveWsUrl } from '@/lib/ws-url';

export interface Session {
  token: string;
  userId: string;
  name: string;
}

export interface RoomView {
  state: RoomState;
  role: 'player' | 'spectator';
  color?: Color;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
  /**
   * **合并键** —— 有键的提示会跟**同一个键**的那条合并成一条。
   *
   * 用途：同一个人的连续私信合并成一条「xx 给你发来 N 条消息」，
   * 而不是糊出一整列一模一样的提示（用户反馈：私信轰炸把顶栏盖满了）。
   */
  mergeKey?: string;
  /** 合并后累计的条数（1 = 就这一条） */
  count?: number;
  /**
   * **内容版本** —— 文案变了就 +1。
   *
   * 用来让计时**重新开始**：合并进来的新消息要重新给阅读时间，
   * 否则那条提示可能刚合并完就消失（「给你发来 3 条」只显示了 0.5 秒）。
   */
  version: number;
}

/**
 * **连接状态 —— 三态，不是一个 bool。**
 *
 * 定义放在 `@/lib/types`（组件和 hook 共用），这里再导出一次是为了
 * 让「只想拿连接状态」的调用方有个就近的入口。
 */
export type { ConnectionStatus };

export interface SocketState {
  session: Session | null;
  lobby: LobbyState;
  room: RoomView | null;
  connected: boolean;
  /**
   * **连接状态**（三态）。
   *
   * `connected` 是它的快捷写法（`status === 'open'`），
   * 保留是为了不改动所有已有调用点 —— 但**只判断「连没连上」的界面应该改用 `status`**，
   * 否则「正在连」和「连不上」又混成一种显示。
   */
  status: ConnectionStatus;
  toasts: Toast[];
  /** 私信记录（按时间序，双方各存自己收到/发出的那些） */
  dms: DirectMessage[];
  /** 私信未读数（对方发来、而「私信」面板没打开过） */
  dmUnread: number;
  /**
   * 私信的**剩余额度**：对方的 userId → 我还能给他发几条。
   *
   * 0 = 被锁住（连着发满 3 条、对方还没回）—— 界面据此把发送按钮变灰。
   *
   * 这份状态**由服务端推来**（`dm.state`），客户端不自己数：
   * 自己数会和服务端对不上（换设备 / 服务端重启过），
   * 对不上的后果是「按钮一直灰着，怎么都发不出去」。
   *
   * 表里**没有**的人 = 额度是满的（默认能发）。
   */
  dmRemaining: Record<string, number>;
  /**
   * **最近一次「进不去房间」的原因**（null = 没有）。
   *
   * 为什么放在这里而不是对局页的本地 state：
   *   失败可能发生在**别的页面** —— 比如从私信的邀请卡片点进来时，
   *   请求是大厅页发的，而对局页是**之后**才挂上的。
   *   错误只放在对局页的本地 state 里的话，那条错误就被丢掉了，
   *   页面永远停在「正在进入房间…」（既不知道为什么进不去，也找不到出口）。
   *
   * `code` 是它说的是哪个房间 —— 对局页靠它判断「这条错跟我有没有关系」。
   */
  joinError: { message: string; code?: string } | null;
}

/**
 * token 存 sessionStorage 而非 localStorage：
 *  - sessionStorage 按**标签页**隔离，同一台电脑开两个标签就能当两个玩家（联机测试很常见）
 *  - 刷新页面时 sessionStorage 保留 → 身份与座位仍然续上（需求 B5）
 *  - localStorage 会被同浏览器所有标签共享，两个标签会抢同一个身份
 */
const TOKEN_KEY = 'lan-chess.token';
const NAME_KEY = 'lan-chess.name';

/**
 * **座位凭证的本地存档**（`localStorage`）。
 *
 * 存的是「房间码 → 座位凭证」的映射，**一个房间一条**。
 *
 * 为什么存 `localStorage` 而不是 `sessionStorage`：
 *  - `sessionStorage` 随标签页一起消失 → 关掉网页再打开就没了，
 *    那正是我们要解决的场景；
 *  - `localStorage` 跨标签页、跨浏览器重启都在 → 关掉网页再打开还在。
 *
 * 为什么按**房间码**存、而不是「当前这一张」：
 *  - 一个浏览器可能同时开多个标签页下棋（联机测试很常见）；
 *  - 每个标签页进不同的房间，各自的凭证互不干扰；
 *  - 回到某个房间时，用那个房间码取回对应凭证。
 *
 * 只存**一个房间一条**：凭证太多会让「认领」变得不确定
 * （到底该认领哪个座位？）。多开局的场景让旧凭证自然过期即可。
 */
const CLAIM_KEY = 'lan-chess.claim';

interface ClaimStore {
  /** 房间码 → 座位凭证 */
  [roomCode: string]: string;
}

/** 读座位凭证存档 */
function loadClaimStore(): ClaimStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CLAIM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ClaimStore = {};
    for (const [code, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof code === 'string' && typeof key === 'string' && key.length > 0) out[code] = key;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写座位凭证存档 */
function saveClaimStore(store: ClaimStore): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CLAIM_KEY, JSON.stringify(store));
  } catch {
    /* 存不进去就算了 —— 认领只是锦上添花，存不下不影响正常对局 */
  }
}

/**
 * 私信记录的本地存档（`localStorage`）。
 *
 * 为什么存：私信抽屉的语义是「**有历史、能接着聊**」（用户拍板）。
 * 记录只在内存里的话，**刷新一次就没了** —— 手机息屏、切 Wi-Fi、
 * 手滑刷新都会把刚才的对话抹掉，等于承诺没兑现。
 *
 * 记的是两样：**记录** + **未读数**。
 * 未读数也要存 —— 否则刷新之后记录还在、角标却没了，
 * 那条没看过的消息就永远「看不见但存在」（卡面和真实状态对不上）。
 *
 * 按 **userId 分桶**：换个人登录（同一个浏览器）看到的应该是那个人自己的记录，
 * 不是上一个人的。最多留 300 条，再多就把最老的挤掉。
 */
const DM_STORE_KEY = 'lan-chess.dms';
const DM_STORE_MAX = 300;

interface DmStore {
  dms: DirectMessage[];
  unread: number;
}

/** 读私信存档（按身份分桶） */
function loadDmStore(userId: string): DmStore {
  const empty: DmStore = { dms: [], unread: 0 };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(DM_STORE_KEY);
    if (!raw) return empty;
    const all = JSON.parse(raw) as Record<string, unknown>;
    const bucket = all?.[userId] as Partial<DmStore> | undefined;
    if (!bucket || !Array.isArray(bucket.dms)) return empty;
    return {
      dms: bucket.dms.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string'),
      unread: typeof bucket.unread === 'number' && bucket.unread > 0 ? bucket.unread : 0,
    };
  } catch {
    /* 存档坏了就当没有 —— 不能因为一条脏数据把整个私信面板搞崩 */
    return empty;
  }
}

/** 写私信存档（按身份分桶） */
function saveDmStore(userId: string, dms: DirectMessage[], unread: number): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(DM_STORE_KEY);
    const all = (raw ? (JSON.parse(raw) as Record<string, unknown>) : {}) as Record<string, unknown>;
    all[userId] = { dms: dms.slice(-DM_STORE_MAX), unread: Math.max(0, unread) };
    window.localStorage.setItem(DM_STORE_KEY, JSON.stringify(all));
  } catch {
    /* 存不进去就算了 —— 私信本身还能用，只是刷新后没有历史 */
  }
}

/**
 * **连接超时**：多久还连不上，就判定这次尝试失败（毫秒）。
 *
 * 为什么必须有 —— **服务器僵死时的真实形态**：
 *   TCP 握手**会成功**（内核还在应答 SYN，所以 `nc -z` 看着是通的），
 *   但 TLS / WebSocket 握手**永远不会完成**（用户态拿不到 CPU）。
 *   浏览器于是把这个 socket 一直挂在 CONNECTING，既不 open 也不 error。
 *
 *   不主动掐掉，两个后果：
 *   ① 界面永远显示「连接中…」—— 玩家以为是自己卡了；
 *   ② 这个半开的连接会一直堆在服务端的 accept backlog 里（每个几十 KB），
 *      而重试又会再堆一批 —— **客户端自己给服务器加压**。
 *
 *   所以超时既让界面说实话，也把这堆半开连接放掉。
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** 重连退避：起始间隔 */
const RECONNECT_BASE_MS = 1_500;
/** 重连退避：上限（再久玩家会以为页面坏了） */
const RECONNECT_MAX_MS = 30_000;

/** 全局连接管理器（模块级单例） */
class SocketManager {
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private msgListeners = new Set<(msg: ServerMessage) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连接超时定时器（掐掉卡在 CONNECTING 的 socket） */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * **重连退避**：连续失败越多，等得越久（上限 `RECONNECT_MAX_MS`）。
   *
   * 为什么要有退避：
   *   服务器挂掉时，每个还开着的标签页都会 1.5 秒重连一次 ——
   *   服务器一恢复就是一波连接风暴（而它恰好是最虚弱的时候）。
   *   退避把重试摊开：1.5s → 3s → 6s → 12s → 24s → 30s（封顶）。
   *   一旦连上就立刻复位（网络恢复时不该让人等）。
   */
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private shouldReconnect = true;
  private identity: { name: string; token?: string } | null = null;
  private toastId = 0;
  /**
   * 用户**明确表示不在这局里了**（在对局页点了「返回大厅」/「离开」）。
   *
   * 之后服务端再下发房间快照一律丢弃 —— 否则已经回到大厅的人会被又拽回对局页
   * （表现是「点了返回大厅，一秒后又回到棋盘」）。
   *
   * 迟到的快照有两种来源：
   *  ① 加入请求的结果（发出去时还没返回）；
   *  ② **重连时服务端的自动恢复房间**（按 token 里的房间码把房间推回来）——
   *     这一种推回来的可能是**另一个房间**，所以不能只按房间码匹配，得整个丢弃。
   *
   * 用户主动 join / create 会清掉这个标记 —— 那是新的意图。
   */
  private abandoned = false;

  /**
   * **客户端心跳** —— 主动探测「连接还活着吗」。
   *
   * 为什么必须有它：
   * 浏览器对「断网」的感知**很慢** —— 拔网线、切 Wi-Fi、手机息屏之后，
   * WebSocket 的 `close` 事件可能**几十秒后**才触发。
   * 在那之前，客户端以为自己还连着，什么都不做。
   *
   * 于是重连要等：① 浏览器的 close（可能几十秒）→ ② 服务端心跳超时（45 秒）
   * → ③ 客户端 1.5 秒后重连。实测下来断网到重连可能超过 1 分钟，
   * 而 60 秒的宽限期根本不够。
   *
   * 现在客户端自己每 5 秒发一个 `ping`，**10 秒内收不到 `pong`** 就认定连接已死，
   * 主动断开并重连 —— 把「断网 → 重连」压到 10 秒以内。
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次收到服务端消息的时间 */
  private lastPongAt = 0;

  /** 启动心跳探测 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) return;
      // 超时没收到任何回应 → 连接已经是死的，主动断开触发重连
      if (Date.now() - this.lastPongAt > CLIENT_HEARTBEAT_TIMEOUT_MS) {
        this.dropDeadSocket();
        return;
      }
      try {
        socket.send(JSON.stringify({ t: 'ping' }));
      } catch {
        /* ignore */
      }
    }, CLIENT_HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /**
   * **掐掉一条已经死了的连接**（半开连接），并自己起重连。
   *
   * ## 为什么不能「`close()` 完等 close 事件」
   *
   * 半开连接（网络断了、但 TCP 没断）时，关闭握手发不出去 ——
   * 浏览器在**等对方的关闭帧**，而那个帧永远来不了。
   * 于是 close 事件可能**永远不来**，
   * 「等 close 事件再重连」就变成了「永远不重连」。
   *
   * 这正是「拔网线之后页面一直卡着」的机制性原因：
   * 浏览器以为连接还在，服务端也以为连接还在（服务端要等 45 秒心跳超时），
   * 两边都干等着，谁都不动。
   *
   * 所以这里**不等它**：自己把连接摘掉、自己起重连。
   * 摘掉之后那条旧连接的 close 事件会被 `onclose` 里的
   * 「`this.socket !== socket` 就忽略」挡掉，不会触发第二次重连。
   */
  private dropDeadSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    // 先摘掉 —— 后来的 close 事件就不该再触发一次重连
    this.socket = null;
    this.stopHeartbeat();
    /*
     * **界面要立刻说实话。**
     *
     * 连接已经死了，却还写着「已连接」—— 玩家看着一个不动的棋盘，
     * 以为是自己卡了，以为要刷新页面。
     *
     * 这条 `setState` 不能省：换连接的那几秒里，
     * 顶栏必须显示「重连中…」，人就知道「是我这边断了，正在自己接回来」。
     */
    this.setState({ connected: false, status: 'connecting' });
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // 快速重试：网络恢复了就别让玩家等那一秒半
    this.reconnectTimer = setTimeout(() => this.connect(), 500);
  }

  /** 停掉心跳探测 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private state: SocketState = {
    session: null,
    lobby: { rooms: [], queueSize: 0, online: 0, onlineUsers: [], queuedUserIds: [] },
    room: null,
    connected: false,
    status: 'connecting',
    toasts: [],
    dms: [],
    dmUnread: 0,
    dmRemaining: {},
    joinError: null,
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SocketState => this.state;

  private setState(patch: Partial<SocketState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** 订阅服务端消息（聊天等局部更新） */
  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.msgListeners.add(listener);
    return () => {
      this.msgListeners.delete(listener);
    };
  }

  /**
   * 收一条 toast。
   *
   * **这里不再自带消失定时器** —— 消失逻辑归 `ToastHost` 管（它要支持
   * 「悬停暂停」和「错误类留 8 秒」，这些都需要操作那条 toast 本身）。
   * 这里只负责入队 + 提供 dismissToast。
   *
   * **合并**（可选）：带 `mergeKey` 的提示会跟同键的那条**合并**，
   * 而不是再排一条新的。`describe` 负责写出合并后的文案
   * （第一条走 `message`，第二条起用 `describe(条数)`）。
   */
  pushToast(
    kind: Toast['kind'],
    message: string,
    mergeKey?: string,
    describe?: (count: number) => string,
  ): void {
    if (mergeKey) {
      const existing = this.state.toasts.find((t) => t.mergeKey === mergeKey);
      if (existing) {
        const count = (existing.count ?? 1) + 1;
        const text = describe ? describe(count) : existing.message;
        this.setState({
          toasts: this.state.toasts.map((t) =>
            t.id === existing.id ? { ...t, message: text, count, version: t.version + 1 } : t,
          ),
        });
        return;
      }
    }
    this.toastId += 1;
    const id = this.toastId;
    const toast: Toast = {
      id,
      kind,
      message,
      mergeKey,
      count: mergeKey ? 1 : undefined,
      version: 0,
    };
    this.setState({ toasts: [...this.state.toasts, toast] });
  }

  /** 关掉一条 toast（用户点了关闭，或 ToastHost 的计时器到期） */
  dismissToast(id: number): void {
    if (!this.state.toasts.some((t) => t.id === id)) return;
    this.setState({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  /**
   * 一次性清空所有 toast —— **换页面时用**。
   *
   * toast 的状态在模块级单例里，而 `ToastHost` 挂在**根布局**上（不在房间里
   * 也得能看见失败提示）。于是大厅页的一次输入校验失败，会跟着用户一起
   * 飘到对局页右上角 —— 「房间码为 4 位字符」出现在棋盘旁边，既是上一个
   * 页面的遗留，又盖住了真正要看的东西。
   *
   * 所以：**路由一变就把上一页的 toast 全部收掉**。toast 的语义本来就是
   * 「刚刚发生的事」，跨页就不该继续存在。
   */
  clearToasts(): void {
    if (this.state.toasts.length === 0) return;
    this.setState({ toasts: [] });
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    if (this.socket && this.socket.readyState <= 1) return;

    /*
     * 连哪里：
     *  - 默认**同源**（`ws(s)://<当前 host>/ws`）—— 本地 / 局域网 / 整站一台机器；
     *  - 配了 `NEXT_PUBLIC_WS_URL` 就连那个（混合部署：页面在 Vercel，
     *    实时服务在另一台机器）。
     *
     * ⚠️ 这里必须是 `process.env.NEXT_PUBLIC_WS_URL` 的**静态成员访问**：
     * Next.js 只对这种写法做构建期内联，写成 `process.env[key]` 或先解构
     * 再取值就替换不掉，浏览器里拿到的是 undefined（静默退回同源，
     * 表现是「页面在 Vercel，但连的还是 vercel.app/ws」）。
     */
    const socket = new WebSocket(
      resolveWsUrl(
        process.env.NEXT_PUBLIC_WS_URL,
        window.location.protocol,
        window.location.host,
      ),
    );
    this.socket = socket;

    /*
     * 状态先说「正在连」。
     * 之前这里什么都不设，于是「连不上」和「正在连」都显示成同一句「连接中…」——
     * 服务器僵死时那个提示会一直挂到天荒地老。
     *
     * 但**已经判定「连不上」就别再退回「正在连」**：
     * 重试是内部细节，玩家只需要知道「现在连不上」这一件事。
     * 来回闪的话，状态灯每隔十几秒变一次色，读起来像在装。
     */
    if (this.state.status !== 'failed') {
      this.setState({ connected: false, status: 'connecting' });
    }

    /*
     * **连接超时**：掐掉卡在 CONNECTING 的 socket。
     *
     * 服务器僵死时的形态就是「TCP 握上了、TLS 握手永远不完成」——
     * 浏览器既不 open 也不 error，socket 就一直挂在 CONNECTING。
     * 这里到点就把它关掉：界面从「连接中…」变成「无法连接」，
     * 同时把这条半开连接从服务端的 backlog 里放掉。
     */
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.setState({ connected: false, status: 'failed' });
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }, CONNECT_TIMEOUT_MS);
    if (typeof this.connectTimer.unref === 'function') this.connectTimer.unref();

    socket.onopen = () => {
      this.clearConnectTimeout();
      this.setState({ connected: true, status: 'open' });
      // 连上了 → 退避复位（网络恢复时不该让人等）
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.lastPongAt = Date.now();
      this.startHeartbeat();
      // 恢复身份：优先用本次会话内的 identity；
      // 若是刷新/重连（identity 还没建立），则用浏览器里存的 token + 用户名自动恢复。
      let identity = this.identity;
      if (!identity) {
        try {
          const token = window.sessionStorage.getItem(TOKEN_KEY);
          const name = window.localStorage.getItem(NAME_KEY);
          if (token && name) identity = { name, token };
        } catch {
          identity = null;
        }
      }
      if (identity) {
        this.identity = identity;
        socket.send(
          JSON.stringify({ t: 'hello', name: identity.name, token: identity.token }),
        );
      }
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      /*
       * **收到任何消息都算「连接还活着」** ——
       * 心跳的判据是「多久没收到服务端的东西」，不是「有没有收到 pong」。
       * 这样服务端正常推送房间状态时，心跳就只是顺带保活。
       */
      this.lastPongAt = Date.now();
      switch (msg.t) {
        case 'session': {
          /*
           * 恢复私信历史（刷新后要还能接着聊）。
           *
           * 只在内存里**一条都没有**时才恢复 ——
           * 断线重连也会收到 session，那时内存里的记录才是最新的，
           * 用存档去覆盖它等于把刚才的消息弄丢。
           */
          const restored = this.state.dms.length > 0 ? null : loadDmStore(msg.userId);
          /*
           * **身份变了 → 手里那份房间快照不再是我的**。
           *
           * 什么时候会变：服务端重启且会话档案没恢复回来（存档丢了 / 换机器 / 存档目录换了）
           * → 客户端带着旧 token 回来，服务端认不出它 → **签发新身份**。
           *
           * 这时候如果不把旧快照丢掉，对局页的「进入房间」effect 会因为
           * 「本地已经有这个房间的快照」而**不再重新加入** ——
           * 玩家就卡在一个早就没人了的棋盘上，什么都做不了。
           *
           * 丢掉它 → effect 重跑 → 凭**座位凭证**认领回原座位（凭证在 localStorage 里，
           * 服务端重启不影响它）。这正是「座位凭证」这条路的兜底价值：
           * 身份丢了，座位还能凭凭证找回来。
           */
          const identityChanged =
            this.state.session !== null && this.state.session.userId !== msg.userId;
          this.setState({
            session: { token: msg.token, userId: msg.userId, name: msg.name },
            dms: restored ? restored.dms : this.state.dms,
            dmUnread: restored ? restored.unread : this.state.dmUnread,
            /*
             * **私信的额度状态清空**，等服务端推新的过来。
             *
             * 为什么登录/重连时要清：手里那份可能是**旧的** ——
             * 比如服务端重启过（计数清零、其实能发了），客户端还留着
             * 「发不了」的旧状态 → 按钮一直灰着，界面在骗人。
             *
             * 服务端紧接着会推一份**全量**（`dm.state`），两边就对齐了。
             */
            dmRemaining: {},
            ...(identityChanged ? { room: null } : {}),
          });
          try {
            // token 按标签页隔离；用户名用 localStorage 便于下次填写
            window.sessionStorage.setItem(TOKEN_KEY, msg.token);
            window.localStorage.setItem(NAME_KEY, msg.name);
          } catch {
            /* ignore */
          }
          break;
        }
        case 'lobby':
          // 防御性处理：服务端可能下发旧格式快照（缺 queuedUserIds）
          this.setState({
            lobby: {
              rooms: msg.state.rooms ?? [],
              queueSize: msg.state.queueSize ?? 0,
              online: msg.state.online ?? 0,
              onlineUsers: msg.state.onlineUsers ?? [],
              queuedUserIds: msg.state.queuedUserIds ?? [],
            },
          });
          break;
        case 'room':
          /*
           * 用户已经明确退出 → 丢弃**迟到的**快照。
           *
           * 顺手发一条 room.leave：快照能到，说明服务端那边还把我们算在房里。
           * 不释放座位的话，对方面对一个幽灵，**棋钟还在替我们走**。
           */
          if (this.abandoned) {
            this.send({ t: 'room.leave' });
            break;
          }
          /*
           * **座位凭证**（只有「我是棋手」时才有）—— 存进 localStorage。
           *
           * 有了它，「关掉网页再打开」时就能凭它认领回原来那个座位
           * （`sessionStorage` 里的身份凭证那会儿已经没了）。
           *
           * 服务端只发给座位本人 —— 别人拿不到，也就没法抢座位。
           */
          if (msg.claimKey && msg.state.code) {
            const store = loadClaimStore();
            if (store[msg.state.code] !== msg.claimKey) {
              store[msg.state.code] = msg.claimKey;
              saveClaimStore(store);
            }
          }
          this.setState({
            room: { state: msg.state, role: msg.role, color: msg.color },
            /*
             * 进房成功了 → 之前那条「进不去」的原因作废。
             *
             * 只清**说的是这个房间**的那条 —— 别的房间的失败原因跟这里无关。
             */
            ...(this.state.joinError &&
            (!this.state.joinError.code || this.state.joinError.code === msg.state.code)
              ? { joinError: null }
              : {}),
          });
          break;
        case 'error':
          /*
           * 「进不去房间」的原因。
           *
           * 存进**全局状态**而不是某个页面的本地 state ——
           * 失败可能发生在别的页面（比如从私信的邀请卡片点进来时，
           * 请求是大厅页发的，对局页之后才挂上），放在本地就丢了。
           */
          this.setState({ joinError: { message: msg.message, code: msg.code } });
          break;
        case 'dm': {
          /*
           * 一条私信。
           *
           * **双方都会收到这一条**（服务端给发送方也回一份），
           * 所以「我发出去的」和「对方发给我的」在同一条记录里 —— 时间序不会乱。
           *
           * 对方发来的要：① 记进私信记录；② 未读数 +1；③ 弹一条提示。
           */
          const dm = msg.message;
          const mine = dm.from === this.state.session?.userId;
          const next = [...this.state.dms, dm];
          const nextUnread = mine ? this.state.dmUnread : this.state.dmUnread + 1;
          this.setState({
            dms: next,
            dmUnread: nextUnread,
          });
          // 落盘：刷新后还能接着聊（未读数一起存 —— 角标要跟真实状态对得上）
          const uid = this.state.session?.userId;
          if (uid) saveDmStore(uid, next, nextUnread);
          /*
           * 提示语按**消息类型**分：邀请说的是「邀请你下棋」，
           * 跟「给你发来一条消息」不是一回事 —— 后者让人不知道要不要点开看。
           *
           * **同一个人的连续私信合并成一条**：
           * 私信每条都会弹一条提示，不合并的话，
           * 对方点几下就把顶栏糊成**一整列一模一样的提示条**。
           * 合并键带上房间码 —— 不同房间的邀请是**两件事**，不能并成一句。
           */
          if (!mine) {
            const isInvite = dm.kind === 'invite' && Boolean(dm.roomCode);
            if (isInvite) {
              this.pushToast(
                'info',
                `${dm.fromName} 邀请你下棋（房间 ${dm.roomCode}）`,
                `dm:${dm.from}:invite:${dm.roomCode}`,
                (n) => `${dm.fromName} 邀请你下棋 ${n} 次（房间 ${dm.roomCode}）`,
              );
            } else {
              this.pushToast(
                'info',
                `${dm.fromName} 给你发来一条消息`,
                `dm:${dm.from}`,
                (n) => `${dm.fromName} 给你发来 ${n} 条消息`,
              );
            }
          }
          break;
        }
        case 'dm.state': {
          /*
           * 服务端告诉我「我还能给谁发几条私信」（互惠限流）。
           *
           * **服务端是唯一的事实来源** —— 客户端不自己数：
           * 自己数出来的「锁定」一旦和服务端对不上，
           * 表现就是「按钮一直灰着，怎么都发不出去」（界面在骗人）。
           *
           * 这是**增量**：合并进现有的表，不是整张替换。
           */
          const next = { ...this.state.dmRemaining };
          for (const s of msg.states) next[s.peer] = s.remaining;
          this.setState({ dmRemaining: next });
          break;
        }
        case 'toast':
          this.pushToast(msg.kind, msg.message);
          break;
        default:
          break;
      }
      for (const listener of this.msgListeners) listener(msg);
    };

    socket.onclose = () => {
      // 只有当关闭的正是当前 socket 时才处理。
      // 否则旧 socket 的 onclose（在新 socket 建好后才触发）会误发起一次重连，
      // 导致同一个标签页出现多条连接，服务端在线人数虚高。
      if (this.socket !== socket) return;
      this.clearConnectTimeout();
      /*
       * 状态要说真话：
       *  - 这次连接**曾经打开过**（正常掉线）→ 「正在重连」；
       *  - 这次连接**从头到尾没打开过**（连不上）→ 「无法连接」。
       */
      const wasOpen = this.state.status === 'open';
      this.setState({ connected: false, status: wasOpen ? 'connecting' : 'failed' });
      this.socket = null;
      this.stopHeartbeat();
      if (!this.shouldReconnect) return;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // 出错了 → 明确判成「连不上」，别再显示「连接中…」
      this.setState({ connected: false, status: 'failed' });
      socket.close();
    };
  }

  /** 掐掉连接超时定时器 */
  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /**
   * **安排一次重连**（带退避）。
   *
   * 退避的意义：服务器挂掉时，每个还开着的标签页都在不停重连 ——
   * 服务器刚好是最虚弱的时候，却要接这一波波连接。
   * 间隔 1.5s → 3s → 6s → 12s → 24s → 30s（封顶），连上就复位。
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, Math.round(delay * 2));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * **进入一个房间** —— 认领优先。
   *
   * 这是「关掉网页再打开」的客户端入口：
   *  - 身份凭证（token）在 `sessionStorage` 里，**标签页一关就没了**；
   *  - 座位凭证（claimKey）在 `localStorage` 里，**还在**。
   *
   * 所以进房间时先问一句「这个房间我有凭证吗」：
   *  - 有 → 发 `room.claim` 认领回原座位（服务端会把座位转给当前身份）；
   *  - 没有 → 走普通 `room.join`。
   *
   * 认领失败（凭证过期 / 座位已经判负）时**不重试普通加入** ——
   * 那会让玩家在一个「座位早就没了」的房间里变成观战者，
   * 而正确的结果是告诉他「你的座位已经不在了」。
   */
  joinRoom(code: string, mode: 'play' | 'spectate' = 'play'): boolean {
    /*
     * **主动加入 = 新的意图** → 清掉「放弃这个房间」的标记。
     *
     * 为什么必须在这里清（而不是只靠 `send()` 里那条 `room.join` 分支）：
     * 认领那条路（`room.claim`）也会走到这里，而 `send()` 只认 `room.join`
     * / `room.create` 两种消息 —— 认领时标记留在「已放弃」上，
     * 服务端回的房间快照会被当成「迟到的快照」丢掉，
     * 页面就永远停在「正在进入房间…」。
     */
    this.abandoned = false;
    const claimKey = loadClaimStore()[code];
    if (claimKey) {
      return this.send({ t: 'room.claim', code, claimKey });
    }
    return this.send({ t: 'room.join', code, mode });
  }

  /** 发送消息 */
  send(payload: Record<string, unknown>): boolean {
    /*
     * 主动加入 / 创建房间 = 新的意图 → 清掉之前「放弃这个房间」的标记。
     * 不清的话，用户在大厅里重新点进同一个房间，快照会被自己的标记吃掉。
     */
    if (payload.t === 'room.join' || payload.t === 'room.create') {
      this.abandoned = false;
    }
    if (!this.socket || this.socket.readyState !== 1) {
      this.pushToast('error', '连接已断开，正在重连…');
      return false;
    }
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  /**
   * 登录（建立身份）
   *
   * 三种连接状态都要处理对：
   *  - **没连上 / 已关闭** → 重新连（`connect()` 的 `onopen` 会带着 identity 发 hello）；
   *  - **正在连（CONNECTING）** → **不能 send**（会抛 InvalidStateError），
   *    但 `onopen` 会自动带 identity 发 hello，所以这里什么都不用做；
   *  - **已连接（OPEN）** → 直接发 hello。
   */
  login(name: string): void {
    const clean = name.trim().slice(0, 20);
    if (!clean) {
      this.pushToast('error', '请输入用户名');
      return;
    }
    let token: string | undefined;
    try {
      token = window.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      token = undefined;
    }
    this.identity = { name: clean, token };
    const socket = this.socket;
    if (!socket || socket.readyState > 1) {
      /*
       * 用户点了「进入大厅」而服务器连不上 → **立刻再试一次**，
       * 别让玩家对着退避计时干等（退避是为了省服务器，不是为了惩罚玩家）。
       */
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect();
      return;
    }
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ t: 'hello', name: clean, token }));
    }
    // CONNECTING：等 onopen（它会带着刚设好的 identity 发 hello）
  }

  /**
   * **自动登录** —— 用「上次用的用户名」悄悄把身份建起来。
   *
   * 为什么需要它：
   *  「关掉网页再打开」时，`sessionStorage` 里的身份凭证没了，
   *  但 `localStorage` 里的**用户名**还在。
   *
   *  而**对局页需要身份才会去认领座位** ——
   *  没有身份 → 页面停在「需要先登录」→ 认领永远不发生 →
   *  「关掉网页再打开能回来」这件事就只是**协议层能做到，界面层做不到**。
   *
   * 所以对局页会调它：有记住的名字就自动登录，然后走认领那条路。
   *
   * 为什么**不带 token**：
   *  新标签页的 sessionStorage 是空的，本来就没有 token 可带。
   *  带了反而会走到「恢复旧身份」那条路 —— 那是刷新页面用的，不是关掉网页用的。
   */
  autoLogin(): void {
    if (this.identity) return;
    let name: string | null = null;
    try {
      name = window.localStorage.getItem(NAME_KEY);
    } catch {
      name = null;
    }
    if (!name) return;
    this.login(name);
  }

  /** 断开（仅用于页面卸载） */
  dispose(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearConnectTimeout();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /**
   * 主动放弃进入某个房间（用户在对局页点了「返回大厅」）。
   *
   * 做两件事：
   *  1. 清掉本地房间快照 —— 大厅「拿到房间快照就跳对局页」那条逻辑不能被它触发；
   *  2. 记下这个房间码 —— 之后服务端再下发它的快照一律丢弃（见字段注释）。
   *
   * **不发 room.leave**：此刻我们可能压根没进房（进入失败），
   * 也可能正在等加入结果。让服务端按正常断线宽限期处理，
   * 后果和「直接关标签页」一样 —— 不在这个按钮上偷偷加一条新的判负规则。
   */
  abandonRoom(): void {
    this.abandoned = true;
    this.setState({ room: null });
  }

  /**
   * 发一条私信（点对点，不经过房间）。
   *
   * `to` 是对方的 userId —— 从大厅「在线 N」名单里右键某人拿到的。
   */
  sendDm(to: string, text: string): boolean {
    const body = text.trim();
    if (!body) return false;
    return this.send({ t: 'dm.send', to, text: body.slice(0, 200) });
  }

  /**
   * 发一条**房间邀请**（私信的一种）。
   *
   * 和 `sendDm` 分开：邀请不是一句话，是一条带房间码的结构化消息，
   * 客户端要把它渲染成可点的卡片（点一下直接进房）。
   *
   * 服务端会再校验一遍「发送者确实在这个房间里」——
   * 客户端给的房间码只是个申请，不是通行证。
   */
  sendDmInvite(to: string, roomCode: string): boolean {
    const code = roomCode.trim().toUpperCase();
    if (!to || code.length !== 4) return false;
    return this.send({ t: 'dm.invite', to, roomCode: code });
  }

  /** 私信面板打开了 → 未读数清零 */
  markDmRead(): void {
    if (this.state.dmUnread === 0) return;
    this.setState({ dmUnread: 0 });
    // 未读数也落盘 —— 否则刷新之后角标又冒出来了（明明刚看过）
    const uid = this.state.session?.userId;
    if (uid) saveDmStore(uid, this.state.dms, 0);
  }

  /** 主动清掉「进不去房间」的原因（重新发起进房时用） */
  clearJoinError(): void {
    if (this.state.joinError === null) return;
    this.setState({ joinError: null });
  }

  /**
   * 主动离开房间。
   *
   * 必须**同时**做两件事：
   *  1. 通知服务端把座位/观战身份摘掉；
   *  2. 把本地 room 快照清空。
   * 只做第 1 步的话，本地还留着旧房间码，回到大厅时会被「拿到房间快照就跳对局页」
   * 的逻辑立刻弹回房间 —— 表现为「点离开没反应」。
   */
  leaveRoom(): void {
    const code = this.state.room?.state.code;
    if (this.state.room) {
      this.send({ t: 'room.leave' });
    }
    /*
     * **清掉这个房间的座位凭证**。
     *
     * 主动离开 = 这局不玩了 → 那个座位已经判负（或已被释放），
     * 凭证留着也没用；下次再进这个房间时它会让客户端**去认领一个已经没了的座位**，
     * 结果是玩家卡在「进不去这个房间」的错误卡片里。
     */
    if (code) {
      const store = loadClaimStore();
      if (store[code]) {
        delete store[code];
        saveClaimStore(store);
      }
    }
    // 主动离开 = 明确表示不在这局里了 → 之后迟到的房间快照一律丢弃
    this.abandoned = true;
    this.setState({ room: null });
  }
}

/** 模块级单例：整个标签页共用一条连接 */
const manager = new SocketManager();

export function useSocket() {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);

  // 首次挂载时建立连接；组件卸载**不**断开（否则路由切换会断线）
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    manager.connect();
  }, []);

  // 页面卸载时彻底关闭
  useEffect(() => {
    const handler = (): void => manager.dispose();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const subscribe = useCallback((listener: (msg: ServerMessage) => void) => {
    return manager.onMessage(listener);
  }, []);

  const send = useCallback((payload: Record<string, unknown>) => manager.send(payload), []);

  const joinRoom = useCallback(
    (code: string, mode: 'play' | 'spectate' = 'play') => manager.joinRoom(code, mode),
    [],
  );

  const login = useCallback((name: string) => manager.login(name), []);

  const autoLogin = useCallback(() => manager.autoLogin(), []);

  const pushToast = useCallback(
    (kind: Toast['kind'], message: string) => manager.pushToast(kind, message),
    [],
  );

  const dismissToast = useCallback((id: number) => manager.dismissToast(id), []);

  const clearToasts = useCallback(() => manager.clearToasts(), []);

  const leaveRoom = useCallback(() => manager.leaveRoom(), []);

  const abandonRoom = useCallback(() => manager.abandonRoom(), []);

  const sendDm = useCallback((to: string, text: string) => manager.sendDm(to, text), []);

  const sendDmInvite = useCallback(
    (to: string, roomCode: string) => manager.sendDmInvite(to, roomCode),
    [],
  );

  const markDmRead = useCallback(() => manager.markDmRead(), []);

  const clearJoinError = useCallback(() => manager.clearJoinError(), []);

  return useMemo(
    () => ({
      ...state,
      queued: false,
      send,
      joinRoom,
      login,
      autoLogin,
      subscribe,
      pushToast,
      dismissToast,
      clearToasts,
      leaveRoom,
      abandonRoom,
      sendDm,
      sendDmInvite,
      markDmRead,
      clearJoinError,
    }),
    [
      state,
      send,
      joinRoom,
      login,
      autoLogin,
      subscribe,
      pushToast,
      dismissToast,
      clearToasts,
      leaveRoom,
      abandonRoom,
      sendDm,
      sendDmInvite,
      markDmRead,
      clearJoinError,
    ],
  );
}
