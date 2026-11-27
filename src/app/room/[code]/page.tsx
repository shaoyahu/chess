'use client';

/**
 * 对局页 —— 2D / 3D 双视角、实时同步、观战、聊天、棋钟。
 *
 * 布局（用户验收后定稿）：
 *  - **没有侧栏**。对局信息（双方、棋钟、认输/和棋）放在**HUD 卡**里；
 *  - **走子记录列表取消**。改成在棋盘上画**上一步的走子箭头**
 *    （2D 是棋盘上的箭头，3D 是贴棋面的箭头），一眼就知道谁走的、走到哪；
 *  - **聊天常驻**：聊天记录 + 输入框一直看得见，不用点开；
 *  - **快捷聊天**（预设文本）在聊天块里，点击后飘弹幕。
 *
 * 舞台有**两种布局**，按视口形状自动切换（用户需求）：
 *  - **宽屏**（视口比高宽，左右有余量）：HUD 在棋盘**左边**，聊天在棋盘**右边**。
 *    棋盘是正方形，宽屏的左右余量本来就是浪费的 —— 让给 HUD 和聊天。
 *  - **窄屏**（视口不够宽，**正方形视口也算窄屏**）：HUD 在棋盘**上面**，
 *    聊天在棋盘**下面**，棋盘相应缩小，把上下空间让出来。
 *
 * 顶栏和大厅是**同一套**（在线名单 / 私信 / 设置）——
 * 人在棋盘上也要能看见谁在线、能翻出私信（用户 2026-11-12 拍板）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  BookOpen,
  Castle,
  ChevronLeft,
  ChevronRight,
  Flag,
  Handshake,
  History,
  LogOut,
  MessageSquare,
  RotateCcw,
  Settings,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { useSettings } from '@/hooks/useSettings';
import { useViewport } from '@/hooks/useViewport';
import { useBoardInteraction } from '@/hooks/useBoardInteraction';
import { useReplay } from '@/hooks/useReplay';
import { Board2D } from '@/components/Board2D';
import { PieceGlyph } from '@/components/PieceGlyph';
import { SidePrompt, type SidePromptProps } from '@/components/SidePrompt';
import { SettingsDialog } from '@/components/SettingsDialog';
import { DmButton } from '@/components/DmButton';
import { OnlineUsersMenu } from '@/components/OnlineUsersMenu';
import { DirectMessagePanel, type DmPeer } from '@/components/DirectMessagePanel';
import { ShareMenu } from '@/components/ShareMenu';
import { describeResult, pieceAt } from '@/lib/chess-engine';
import { formatClockMs } from '@/lib/clock';
import { copyText } from '@/lib/clipboard';
import { DEFAULT_VIEW_MODE, type ViewMode } from '@/lib/constants';
import { getBoardTheme } from '@/lib/board-themes';
import { playSound, resumeAudio } from '@/lib/sound';
import { buildPgn, pairMoves } from '@/lib/pgn';
import { isRuleEnd } from '@/lib/takeback';
import type { Color, PieceType } from '@/lib/types';

// 3D 依赖 three.js，按需加载，避免大厅首屏变慢
const Board3D = dynamic(() => import('@/components/Board3D').then((m) => m.Board3D), {
  ssr: false,
  loading: () => <div className="board3d-wrap" style={{ display: 'grid', placeItems: 'center' }}>加载 3D 引擎…</div>,
});

const VIEW_KEY = 'lan-chess.view';

/**
 * 快捷聊天的预设文本。
 *
 * 点一下就发出去，对方屏幕上飘一条弹幕 —— 不用打字、不用开聊天框。
 * 文本要短（弹幕一眼看完）、要好懂（都是下棋时真会说的话）。
 */
const QUICK_CHATS = ['你好！', '好棋', '手滑了', '快点吧', '想静静', '再来一局'];

/** 弹幕存活时长（毫秒） */
const DANMAKU_LIFE_MS = 6000;
/** 同时最多几条弹幕（超过就复用轨道） */
const DANMAKU_LANES = 4;
/**
 * 弹幕里显示的名字最多几个字。
 *
 * 弹幕是「一眼看完」的媒介，名字太长就把正文挤没了。
 * 完整名字在聊天记录里看得到。
 */
const DANMAKU_NAME_MAX = 8;
/**
 * 弹幕里显示的正文最多几个字（超了加省略号）。
 *
 * 聊天正文可以到 200 字，原样飘过去就是一条糊住半个屏幕的横条。
 * 完整内容在聊天记录里 —— 弹幕只负责「有人说了话」这一眼。
 */
const DANMAKU_TEXT_MAX = 20;

/** 截断到指定字数（超了加省略号） */
function clipText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
/* ------------------------------------------------------------------ */
/* 舞台布局判定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 舞台有两种布局，判定依据是「视口形状 + 棋盘能不能因此变大」。
 *
 *   wide（左右分列）：HUD 在棋盘左边，聊天在棋盘右边。
 *     棋盘是正方形，宽屏的左右余量本来就是**浪费**的 —— 让给 HUD 和聊天，
 *     棋盘还能因此变大（少了上下两块，棋盘能吃满可用高度）。
 *
 *   narrow（上下堆叠）：HUD 在棋盘上面，聊天在棋盘下面，
 *     棋盘相应**缩小**，把上下空间让出来。
 *
 * 判定规则（三条同时成立才用宽屏）：
 *   ① 视口确实「比高宽」（`stageW > viewH`）——
 *      **正方形视口落到窄屏**（用户明确要求：「屏幕刚好是正方形就当窄屏」）。
 *   ② 左右分列后，中间留给棋盘的宽度还够（2D ≥ 440px / 3D ≥ 620px）。
 *   ③ 左右分列**不会让棋盘变小** —— 宽屏布局必须真的换来更大的棋盘，
 *      否则老老实实退回上下堆叠。
 *
 * 这些数字必须与 globals.css 里的列宽 / 间距保持一致。
 */
const LAYOUT_GAP = 20;
const SIDE_HUD_W = 260;
const SIDE_CHAT_W = 300;
/** 顶栏 + 底部留白（棋盘之外页面自己占掉的高度） */
const CHROME_H = 140;
/** 窄屏时上下两块占掉的高度：HUD 条 + 间距 + 聊天块 + 间距 */
const STACK_EXTRA_H = 154;
/** 3D 画布的宽:高比（与 globals.css 的 --board3d-aspect 一致） */
const BOARD3D_ASPECT = 1.5579;

/** 舞台布局 */
type StageLayout = 'wide' | 'narrow';

/**
 * 算出这个视口该用哪种布局。
 *
 * @param stageW 舞台（= 页面内容区）的宽度
 * @param viewW  视口宽度
 * @param viewH  视口高度
 * @param mode   2D / 3D（3D 画布更扁，放宽列的门槛也更高）
 */
function planStageLayout(
  stageW: number,
  viewW: number,
  viewH: number,
  mode: ViewMode,
): StageLayout {
  const aspect = mode === '3d' ? BOARD3D_ASPECT : 1;

  // 宽屏：左右分列后，棋盘那一列还剩多宽
  const colW = stageW - SIDE_HUD_W - SIDE_CHAT_W - LAYOUT_GAP * 2;
  // 宽屏下棋盘能占的宽度（纵向只剩视口高度这一条约束）
  const wideW = Math.min(colW, (viewH - CHROME_H) * aspect);

  // 窄屏：上下堆叠后，棋盘能占的边长
  const stackH = viewH - CHROME_H - STACK_EXTRA_H;
  const narrowW = Math.min(stageW, stackH * aspect);

  // ① 视口不是「比高宽」（**正方形视口算窄屏**，用户明确要求）→ 窄屏
  if (viewW <= viewH) return 'narrow';
  // ② 中间列太窄，棋盘放不下 → 窄屏
  if (colW < (mode === '3d' ? 620 : 440)) return 'narrow';
  // ③ 左右分列必须让棋盘**变大**（或至少不变小）
  return wideW >= narrowW ? 'wide' : 'narrow';
}

/** 一条弹幕 */
interface DanmakuItem {
  id: string;
  name: string;
  text: string;
  /** 轨道号：决定它落在屏幕上方第几行，避免互相压住 */
  lane: number;
}

/** 一行着法（回合号 + 白着 + 黑着） */
interface NotationRowData {
  no: number;
  white?: string;
  black?: string;
}

/**
 * 棋谱的**着法列表** —— 记谱卡（宽屏）与底部弹层（窄屏）共用同一份内容。
 *
 * 两种形态只差外框，里面这一份必须一致：不然宽窄屏看到的棋谱会不一样。
 */
function NotationRows({ rows }: { rows: NotationRowData[] }) {
  return (
    <div className="notation-list">
      {rows.length === 0 && <div className="notation-empty">还没有走子。</div>}
      {rows.map((row) => (
        <div className="notation-row" key={row.no}>
          <span className="no">{row.no}.</span>
          <span className={`san${row.white ? '' : ' empty'}`}>{row.white ?? ''}</span>
          <span className={`san${row.black ? '' : ' empty'}`}>{row.black ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = (params?.code ?? '').toUpperCase();
  const {
    session,
    lobby,
    room,
    connected,
    status,
    send,
    subscribe,
    joinRoom,
    leaveRoom,
    abandonRoom,
    pushToast,
    dmUnread,
    autoLogin,
    login,
    joinError: socketJoinError,
    clearJoinError,
  } = useSocket();

  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const [spectatorFlip, setSpectatorFlip] = useState(false);

  /*
   * 视口尺寸 —— 全站唯一来源（`useViewport`）。
   *
   * 这里**不直接读 `window.innerWidth`**：SSR 阶段没有 window，
   * 首帧与服务端不一致会出水合警告；而且各处各读各的会得到多份判断。
   */
  const viewport = useViewport();
  const [chatText, setChatText] = useState('');
  const [chatLog, setChatLog] = useState<Array<{ userId: string; name: string; text: string }>>(
    [],
  );
  const [now, setNow] = useState(Date.now());
  /** 正在飘的弹幕 */
  const [danmaku, setDanmaku] = useState<DanmakuItem[]>([]);
  /** 聊天输入框（右侧「聊天」按钮点一下直接聚焦到这里） */
  const chatInputRef = useRef<HTMLInputElement>(null);
  /** 聊天记录区（新消息进来自动滚到底） */
  const chatLogRef = useRef<HTMLDivElement>(null);
  /** 弹层里的聊天记录区（展开时新消息也要滚到底） */
  const chatPanelLogRef = useRef<HTMLDivElement>(null);
  /**
   * 聊天记录框是否展开。
   *
   * 窄屏下聊天记录**不常驻**（下面那条只有一行，装不下记录、输入框和发送按钮），
   * 点「💬 聊天」才弹出大框：历史聊天 + 输入框 + 发送按钮都在里面。
   * 宽屏右列本来就有一个 300×525 的大框，保持常驻即可（消息改成换行完整显示）。
   */
  const [chatOpen, setChatOpen] = useState(false);
  /**
   * 未读消息数（角标）。
   *
   * 只在**窄屏**有意义 —— 宽屏记录一直看得见。
   * 打开聊天框就清零。
   */
  const [chatUnread, setChatUnread] = useState(0);
  /**
   * **进入房间失败**的原因（服务端原话，如「对局已结束」）。
   *
   * 为什么要有它：进入失败以前只回一个 3.5 秒的 toast，
   * 客户端拿不到房间状态 → 页面永远停在「正在进入房间…」那张卡上，
   * 用户既不知道为什么进不去，也找不到出口（刷新后卡死的真实原因）。
   * 现在服务端会另外回一条 error，页面据此换成**写明原因的错误卡片**。
   *
   * 原因放在 **socket 的全局状态**里，而不是本页的本地 state ——
   * 失败可能发生在**别的页面**：从私信的邀请卡片点进来时，请求是大厅页发的，
   * 对局页是之后才挂上的。放本地的话，那条错误会被丢掉，
   * 页面就永远停在「正在进入房间…」。
   */
  const joinError =
    socketJoinError && (!socketJoinError.code || socketJoinError.code === code)
      ? socketJoinError.message
      : null;
  /**
   * **记住的用户名** —— 有它才可能「自动回来」。
   *
   * 没有它 → 页面老老实实显示「需要先登录」，让人自己去大厅填名字。
   * 有它 → 对局页会用这个名字自动建立身份，然后去认领座位
   * （「关掉网页再打开」就是靠这条回来的）。
   *
   * 为什么用 state 而不是渲染时直接读 `localStorage`：
   * SSR 阶段没有 window，直接读会造成**水合不一致**（服务端渲染「需要先登录」，
   * 客户端首帧却是「正在回来」）。先渲染中性的一版，挂载后再更新。
   */
  const [savedName, setSavedName] = useState<string | null>(null);
  useEffect(() => {
    try {
      setSavedName(window.localStorage.getItem('lan-chess.name'));
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * **分享链接进来时现取的名字**。
   *
   * 别人点开分享链接，浏览器里没记住过用户名 —— 那就先问他叫什么，
   * 填完**直接进这局**（不回大厅、不再走一遍大厅的登录卡片）。
   */
  const [joinName, setJoinName] = useState('');

  /** 取名 → 建立身份 → 下面的「进入房间」effect 会自动把这局接上 */
  const submitJoinName = (): void => {
    const clean = joinName.trim();
    if (!clean) {
      pushToast('error', '请输入用户名');
      return;
    }
    login(clean);
  };

  /**
   * **自动登录** —— 「关掉网页再打开」的入口。
   *
   * 关掉网页 → `sessionStorage` 里的身份凭证没了 → 页面认不出自己是谁
   * → 也就没资格去认领座位。所以这里先用「上次用的用户名」把身份建起来，
   * 后面的「进入房间」effect 才会发出 `room.claim`。
   *
   * 没有记住的用户名 → `autoLogin()` 什么都不做，页面照旧请人登录。
   */
  useEffect(() => {
    if (session) return;
    autoLogin();
  }, [session, autoLogin]);
  /**
   * 「认输」的**二次确认**是否打开。
   *
   * 认输是**不可逆**的（一步就结束对局），手误点一下就白输一局，
   * 所以必须先弹一个确认框，确认后才真的发 resign。
   */
  const [resignAsk, setResignAsk] = useState(false);
  /**
   * 「离开房间」的**二次确认**是否打开。
   *
   * 对局进行中点「离开」= 直接判负（服务端 leaveRoom 会判对方胜），
   * 这跟「认输」是同一个后果 —— 认输要二次确认，离开也必须要有，
   * 否则「离开」就是一个绕过确认的认输按钮。
   */
  const [leaveAsk, setLeaveAsk] = useState(false);
  /**
   * 棋谱的两种形态 —— **都不是弹窗**（宽屏）。
   *
   * - **宽屏**：左栏**常驻一张记谱卡**（`.notation-card`），默认展开。
   *   棋谱是「边下边看」的参照信息：做成弹窗就会压暗整页、盖住聊天、挡住棋盘，
   *   恰恰在最想看它的时候最挡事（用户原话：「是不是就不适合做成弹窗」）。
   * - **窄屏**：左栏变成顶部一整条，常驻卡会把棋盘挤没 → 走**底部弹层**，
   *   跟聊天弹层同一套（点「♟ 棋谱」才弹出来）。
   *
   * 两个状态分开：宽屏默认展开（常驻），窄屏默认关闭（不点不开）。
   */
  const [notationCardOpen, setNotationCardOpen] = useState(true);
  const [notationSheetOpen, setNotationSheetOpen] = useState(false);
  /**
   * 辅助下棋的推荐着法（蓝色指引箭头）。
   *
   * 由服务端引擎算出 —— 只发给请求者本人。
   */
  const [hintMove, setHintMove] = useState<{ from: string; to: string } | null>(null);
  /** 提示是否正在算（算的时候按钮上转圈/提示「思考中」） */
  const [hintPending, setHintPending] = useState(false);
  /**
   * 「再来一局」我已经点过一次了。
   *
   * 服务端会按颜色去重，但**本地也要立刻锁一次** ——
   * 不然从点下去到服务端广播回来之间，手快的话还能再点一下。
   * 局终了（新局开始）就解锁。
   */
  const [rematchSent, setRematchSent] = useState(false);
  /** 供 subscribe 回调读（不能直接依赖 state，否则会反复重订阅） */
  const chatOpenRef = useRef(false);
  /**
   * 当前房间码（给 subscribe 回调用）。
   *
   * 同 myUserIdRef 的理由：subscribe 只注册一次，回调里拿到的是**首次注册时**
   * 的房间码。路由在 /room/A → /room/B 之间切换时组件不会重挂载，
   * 闭包里的 code 会过期 —— 拿它去比对「这条 room 消息是不是我要进的那个房间」
   * 就比错了。
   */
  const codeRef = useRef(code);
  codeRef.current = code;
  const isNarrowRef = useRef(false);
  /**
   * 自己的 userId，给 subscribe 回调判断「这条是不是我发的」。
   *
   * 不能直接用 subscribe 回调闭包里的 `session` ——
   * subscribe 只在挂载时注册一次，那时 session 可能还是 null
   * （刷新进房间页时是握手之后才拿到的），
   * 那样 `session?.userId` 永远是 undefined，**自己发的消息也会被算成未读**。
   */
  const myUserIdRef = useRef<string | null>(null);

  // 恢复视图偏好（默认 2D）
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === '2d' || saved === '3d') setViewMode(saved);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * 已经**明确离开**过的房间码。
   *
   * 「离开」会把本地房间快照清空（`leaveRoom()`），
   * 而下面那个「进入房间」的 effect 恰恰是靠「本地没有快照」来判断要不要加入的 ——
   * 于是「刚离开 → 快照被清空 → effect 又发一次 room.join → 服务端重新把你放进房间」。
   *
   * 表现就是用户报的这条：**进入房间后离不掉**（人还在座位上，对局还在跑，
   * 大厅里那个房间也一直挂着你的名字）。
   *
   * 所以这里记一笔：这个房间我已经主动离开了，**别再自动把我塞回去**。
   */
  const leftRoomRef = useRef<string | null>(null);

  // 进入房间：如果当前还不在这个房间里，才发起加入。
  // 已经在大厅里点了「加入对局/观战」或刚匹配成功时，房间状态已经在手上，
  // 此时再发一次 join 反而可能把玩家从座位上挤掉（变成观战）。
  useEffect(() => {
    if (!session || !code) return;
    // 已经明确离开过这个房间 → 不要再自动加入（否则「离开」等于没离开）
    if (leftRoomRef.current === code) return;
    if (room?.state.code === code) return;
    // 已经在别的房间里 → 先离开
    if (room?.state.code && room.state.code !== code) {
      send({ t: 'room.leave' });
    }
    // 重新发起加入 → 之前那次的失败原因作废
    clearJoinError();
    /*
     * 走 `joinRoom` 而不是直接 `room.join` ——
     * 它会先看本地有没有这个房间的**座位凭证**：
     * 有就**认领**回原座位（「关掉网页再打开」靠这条回来），
     * 没有才走普通加入。
     */
    joinRoom(code, 'play');
  }, [session, code, room?.state.code, joinRoom, clearJoinError]);

  /**
   * 订阅聊天消息。
   *
   * **所有聊天消息只有一种**（打字的和点快捷按钮的，服务端走同一条广播路径），
   * 差别看消息上的 `quick` 标记：
   *   - 普通聊天 → 进聊天记录（留底，可回看）+ 飘一条弹幕；
   *   - 快捷聊天 → **只飘弹幕，不进聊天记录**
   *     （用户要求：「快捷聊天不出现在聊天记录中」——
   *      记录里留的全是正经聊的话，弹幕一扫就没，不占地方）。
   *
   * 弹幕对两者一视同仁 —— 对方屏幕上方扫一眼，看到就行。
   */
  const danmakuSeq = useRef(0);
  const danmakuTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  /** 飘一条弹幕（名字 + 正文都限长） */
  const pushDanmaku = useCallback((name: string, text: string) => {
    const lane = danmakuSeq.current % DANMAKU_LANES;
    danmakuSeq.current += 1;
    const item: DanmakuItem = {
      id: `${Date.now()}-${danmakuSeq.current}`,
      name: clipText(name, DANMAKU_NAME_MAX),
      text: clipText(text, DANMAKU_TEXT_MAX),
      lane,
    };
    setDanmaku((prev) => [...prev, item]);
    const timer = setTimeout(() => {
      setDanmaku((prev) => prev.filter((d) => d.id !== item.id));
    }, DANMAKU_LIFE_MS);
    danmakuTimers.current.push(timer);
  }, []);

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.t === 'chat') {
          /*
           * 快捷聊天**只飘弹幕，不进聊天记录**（`quick` 标记）。
           *
           * 未读角标也只算记录里的消息 —— 快捷聊天压根没进记录，
           * 而且弹幕已经当众飘过了，再顶个「未读」是重复提醒。
           */
          if (!msg.message.quick) {
            setChatLog((prev) => [...prev.slice(-80), msg.message]);
            /*
             * 未读角标：只有**对方**发来的、而且聊天框**没打开**时才计数。
             * - 自己发的消息不算未读（自己当然看过）；
             * - 宽屏不用角标（记录本来就常驻在右栏，一直看得见）；
             * - 弹层开着时也不算（正在看）。
             *
             * 用 ref 读这两个状态：subscribe 的回调不能依赖它们（依赖了就要重新订阅，
             * 反而会把正在处理的消息漏掉）。
             */
            if (
              msg.message.userId !== myUserIdRef.current &&
              isNarrowRef.current &&
              !chatOpenRef.current
            ) {
              setChatUnread((n) => n + 1);
            }
          }
          // 聊天记录之外，再飘一条弹幕（自己发的也飘 —— 发送方要看到「话已经出去了」）
          pushDanmaku(msg.message.name, msg.message.text);
        } else if (msg.t === 'room') {
          /*
           * 进房成功 → 之前的失败原因作废。
           *
           * 必须比对房间码：**别的**房间的快照（例如从人机局切过来时
           * 服务端补发的那条）不能把错误卡片冲掉，否则页面会从
           * 「进不去这个房间」跳回棋盘，人更懵了。
           */
          /*
           * 进房成功 → 之前那条「进不去」的原因作废。
           *
           * 真正清错误的地方在 socket 里（它知道错误说的是哪个房间），
           * 这里不再重复 —— 两处各清一次的话，会出现「A 房间的错误被 B 房间清掉」。
           */
        } else if (msg.t === 'hint.result') {
          // 服务端只把提示发给**请求者本人**，所以这里直接用
          setHintPending(false);
          setHintMove(msg.move ?? null);
          if (!msg.move && msg.error) pushToast('error', msg.error);
        }
      }),
    [subscribe],
  );

  // 卸载时清掉弹幕的定时器，避免对已卸载组件 setState
  useEffect(() => {
    const timers = danmakuTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };
  }, []);

  // 本地时钟推进，用于棋钟显示
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  // 新消息进来，聊天记录自动滚到底（常驻的记录区 + 展开的弹层，两个都要滚）
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    const panel = chatPanelLogRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [chatLog.length]);

  // 弹层打开时也滚到底（可能是打开后才来的消息），并把未读角标清零
  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (!chatOpen) return;
    setChatUnread(0);
    const panel = chatPanelLogRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [chatOpen]);

  // Esc 关掉聊天框
  useEffect(() => {
    if (!chatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen]);

  // Esc 关掉棋谱浮层（窄屏那个；宽屏是常驻卡，没有浮层可关）
  useEffect(() => {
    if (!notationSheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotationSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notationSheetOpen]);

  const roomState = room?.state ?? null;
  const myColor = room?.color;
  const isSpectator = room?.role === 'spectator';

  /*
   * **复盘** —— 纯本地状态机，**不上报服务端**。
   *
   * 棋局已经结束了，复盘只是「一个人翻这盘棋的旧账」，
   * 所以它**天然是各看各的**：谁点了复盘，谁的棋盘就走自己的进度，
   * 对方不受任何影响（对方没点复盘，棋盘就还停在终局局面）。
   *
   * 复盘里可以**自由走棋**（双方棋子都能动），那部分也只在本机算。
   */
  const replay = useReplay(
    roomState?.moves ?? [],
    /*
     * 复盘**只在这一局刚刚结束的时候成立**。
     *
     * `status === 'finished'` = 真正终局（将死 / 认输 / 和棋）。
     * （超时判负**不算** —— 那时 `status` 保持 `playing`，这局还在下。）
     *
     * 这一条由 hook 自己管（`useReplay` 内部会在 `canReplay` 变 false 时复位），
     * 页面这边只需要把「这一局结束了没有」告诉它。
     */
    roomState?.status === 'finished',
  );
  const replayActive = replay.active;
  /** 现在在自由走棋的沙盒里（此时「上一步/下一步」是藏起来的） */
  const replayFree = replay.free;

  /* ---------------- 本地设置（音效 / 配色 / 辅助下棋 / 翻转） ---------------- */

  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 私信面板开着没有（在大厅里被人发消息时，人可能正在棋盘上） */
  const [dmOpen, setDmOpen] = useState(false);
  /** 私信面板当前对话对象（null = 展示会话列表） */
  const [dmPeer, setDmPeer] = useState<DmPeer | null>(null);

  /*
   * 设置统一走 `useSettings()` hook —— 大厅页和对局页共用同一份读写，
   * 免得「大厅改了、对局页没跟上」这种漂移。
   *
   * 它同时管界面偏好（字号 / 密度 / 圆角），那三个偏好是**个人偏好**，
   * 存在 localStorage、换设备重置；房间属性（时限、AI 难度）走服务端，不在这里。
   */
  const { settings, uiPrefs, updateSettings, updateUiPrefs } = useSettings();

  const boardTheme = useMemo(() => getBoardTheme(settings.boardTheme), [settings.boardTheme]);

  /**
   * 棋盘要不要翻转（`flipped` prop 传 undefined = 用 interaction 自带的朝向）。
   *
   * 规则（用户拍板）：
   *  - **玩家**：默认按自己的执子颜色朝向（白方视角白棋在下）；
   *    设置里勾「翻转棋盘」就转 180°；
   *  - **观战者**：用顶栏的「翻转视角」按钮自由翻。
   *
   * 翻转是**用户显式调过的量**，所以这里不跟别的逻辑抢 ——
   * 用户翻了就翻了，系统不自动翻回去（见用户对「自动退镜头」的态度）。
   */
  const flippedForBoard = useMemo<boolean | undefined>(() => {
    if (isSpectator) return spectatorFlip;
    if (!myColor) return undefined;
    const base = myColor === 'w' ? false : true;
    return settings.flipBoard ? !base : base;
  }, [isSpectator, spectatorFlip, myColor, settings.flipBoard]);


  /**
   * 音效触发 —— 跟着**服务端下发的着法**走，而不是本地猜。
   *
   * 只有真正的新着法 / 新终局才响。
   *
   * 注意**首次拿到房间快照时不能响**：
   * 中途刷新进房（对局已经走了几十步）时，第一帧的 moves.length 就已经很大，
   * 不做初始化就会把历史着法一次性「播」一遍。所以第一次只对齐基线，不出声。
   */
  const soundReady = useRef(false);
  const lastSoundMove = useRef(0);
  const lastSoundStatus = useRef<string>('');
  useEffect(() => {
    if (!settings.soundEnabled || !roomState) return;
    const moveCount = roomState.moves.length;
    if (!soundReady.current) {
      // 第一次：只记基线（不回放历史）
      soundReady.current = true;
      lastSoundMove.current = moveCount;
      lastSoundStatus.current = roomState.status;
      return;
    }
    if (moveCount > lastSoundMove.current) {
      const m = roomState.moves[moveCount - 1];
      lastSoundMove.current = moveCount;
      // 吃子：走子记录里有被吃的棋子
      if (m.captured) playSound('capture', settings.soundVolume);
      else playSound('move', settings.soundVolume);
      // 将军：同一手之后局面进入将军状态
      if (roomState.inCheck) playSound('check', settings.soundVolume);
      return;
    }
    if (roomState.status !== lastSoundStatus.current) {
      const prev = lastSoundStatus.current;
      lastSoundStatus.current = roomState.status;
      if (roomState.status === 'finished' && prev === 'playing') {
        const r = roomState.result;
        if (!r || r.winner === 'draw') playSound('draw', settings.soundVolume);
        else if (myColor && r.winner === myColor) playSound('win', settings.soundVolume);
        else playSound('lose', settings.soundVolume);
      }
    }
  }, [roomState, settings.soundEnabled, settings.soundVolume, myColor]);

  /**
   * **超时提示**。
   *
   * 超时只判负、**不结束棋局** —— 房间状态还是 `playing`，
   * 所以上面那段终局音效（盯着 `status` 变 `finished`）不会响。
   * 得单独提示一次，否则玩家只看到对方的时间变成负数，
   * 不知道这一局其实已经定了。
   *
   * **第一份快照只对齐基线** —— 进门之前就发生的事（进房前对方就已经超时了）
   * 不该当成新消息弹一遍（跟终局音效一个规矩）。
   */
  const lastResultKey = useRef<string | null>(null);
  const seenSnapshot = useRef(false);
  useEffect(() => {
    if (!roomState) return;
    const r = roomState.result;
    const key = r ? `${r.winner}-${r.reason}` : '';
    if (!seenSnapshot.current) {
      seenSnapshot.current = true;
      lastResultKey.current = key;
      return;
    }
    if (key === lastResultKey.current) return;
    lastResultKey.current = key;
    if (r?.reason !== 'timeout') return;
    const iWon = Boolean(myColor && r.winner === myColor);
    pushToast(
      'info',
      myColor
        ? iWon
          ? '对手超时，判你胜 —— 可以继续下'
          : '你超时了，判负 —— 可以继续下'
        : '一方超时判负 —— 可以继续下',
    );
    if (settings.soundEnabled) {
      playSound(iWon ? 'win' : 'lose', settings.soundVolume);
    }
  }, [roomState, pushToast, myColor, settings.soundEnabled, settings.soundVolume]);

  /**
   * 「悔棋」能不能点。
   *
   * 规则（用户 2026-11-20 拍板）：
   *  - **我刚走完、对方还没回应** → 点下去**直接撤回**我那一步，不用问对方；
   *  - **对方已经回应** → 点下去是**申请**，对方同意后撤那两步、轮到我重走；
   *  - **我一步都没走过** → 没有可悔的，按钮置灰。
   *
   * 终局（自己那一步把对方将死了）**也能悔** ——
   * 但只有「棋盘规则」判出来的终局才悔得动（认输/和棋/超时是人的决定，撤一步改不了）。
   */
  const lastMoveColor = roomState?.moves[roomState.moves.length - 1]?.color;
  const hasPendingOffer = Boolean(roomState?.drawOffer || roomState?.takebackOffer);
  /** 我自己走过棋没有（没走过就没有可悔的） */
  const iHaveMoved = Boolean(myColor && roomState?.moves.some((m) => m.color === myColor));
  /** 对局是不是还在下（终局时只有「棋盘规则」判出来的才能悔） */
  const endAllowsTakeback =
    roomState?.status === 'playing' || isRuleEnd(roomState?.result?.reason);
  const canOfferTakeback = Boolean(
    myColor && !isSpectator && !hasPendingOffer && iHaveMoved && lastMoveColor && endAllowsTakeback,
  );
  /**
   * 悔棋走哪条路：
   *  - `direct` = 最后一步是我走的 → 直接撤回；
   *  - `ask`   = 最后一步是对方走的 → 要对方点头。
   */
  const takebackMode: 'direct' | 'ask' | null = !canOfferTakeback
    ? null
    : lastMoveColor === myColor
      ? 'direct'
      : 'ask';
  /** 悔棋按钮的说明（两种模式：直接撤 / 要对方点头） */
  const takebackTitle = (() => {
    if (takebackMode === 'direct') return '撤掉你刚走的那一步（直接撤回，轮到你重走）';
    if (takebackMode === 'ask') return '请求对方同意，撤掉你上一步的棋';
    if (hasPendingOffer) return '已有待回应的请求';
    if (!iHaveMoved) return '你还没有走过棋';
    return '对局已经结束，不能悔棋';
  })();

  /**
   * 这是不是**人机局**。
   *
   * 人机局里电脑是对手，它没有「同意 / 反对」这个交互 ——
   * 和棋它只会拒绝，悔棋它只会秒同意（用户嫌这个别扭）。
   * 所以人机局**不摆和棋和悔棋**，只给一个「撤回」（用户拍板）。
   */
  const isAiGame = Boolean(roomState?.seats.w?.isAI || roomState?.seats.b?.isAI);

  /**
   * 「撤回」能不能点：局里**还有棋**就能撤。
   *
   * 玩家的手都撤完之后还能再撤一次 —— 那一次把 AI 的开局也撤掉，回到初始局面。
   * 一手棋都没有的时候（刚开局、AI 还没走）就没得撤了。
   */
  const canUndo = (roomState?.moves.length ?? 0) > 0;

  /**
   * 舞台布局判定：宽屏（左右分列）/ 窄屏（上下堆叠）。
   *
   * 判据见 planStageLayout 的注释。要点：
   *  - 视口比高宽 → HUD 左、聊天右；
   *  - 视口不够宽（**正方形视口也算**）→ HUD 上、聊天下，棋盘缩小。
   *
   * 舞台宽度与布局无关（始终是页面内容区的宽度），所以测量不会自激。
   */
  /**
   * 舞台宽度测量用的元素。
   *
   * 用 **state + 回调 ref**，不是 `useRef`：
   *   首次加载房间链接时，身份还没握手回来，组件先渲染「需要先登录 / 正在进入房间」，
   *   **`.stage` 根本不在 DOM 里**。如果用 `useRef` + 挂载时测一次，
   *   那次测量会因为「取不到元素」直接放弃，之后再也不会重测 ——
   *   宽屏就会**永远卡在窄屏布局**（HUD 在上、聊天在下、棋盘变小）。
   *   回调 ref 会在 `.stage` 真正出现时把元素交进来，测量因此能重跑。
   */
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<StageLayout>('narrow');
  useEffect(() => {
    if (!stageEl) return;
    const measure = (): void => {
      const w = stageEl.getBoundingClientRect().width;
      if (w <= 0) return;
      setLayout(planStageLayout(w, viewport.width, viewport.height, viewMode));
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(stageEl);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [viewMode, stageEl, viewport.width, viewport.height]);

  /** 窄屏（上下堆叠）—— 聊天记录不常驻，靠「聊天」按钮 + 弹层 */
  const isNarrow = layout === 'narrow';

  /*
   * 把「是否窄屏」「我是谁」同步到 ref，供 subscribe 回调判断未读角标
   * （回调里不能用 state，依赖了就会重新订阅）。
   */
  useEffect(() => {
    isNarrowRef.current = isNarrow;
  }, [isNarrow]);

  /*
   * 变回宽屏 → 把窄屏的棋谱浮层收掉。
   *
   * 不收的话：窄屏开着浮层 → 拉宽成宽屏（浮层没了，状态还留着「开着」）
   * → 再缩回窄屏，浮层**自己弹了出来** —— 没人点它，它却出现了。
   */
  useEffect(() => {
    if (!isNarrow) setNotationSheetOpen(false);
  }, [isNarrow]);

  useEffect(() => {
    myUserIdRef.current = session?.userId ?? null;
  }, [session?.userId]);

  /*
   * 新局开始（不再是终局）就把「我再点过一次」的锁解开 ——
   * 否则第二局结束后按钮还是点不动。
   */
  useEffect(() => {
    if (roomState?.status !== 'finished') setRematchSent(false);
  }, [roomState?.status]);

  const handleMove = useCallback(
    (from: string, to: string, promotion?: PieceType) => {
      /*
       * 复盘里的走子**只在本机算** —— 不发服务端。
       * 棋局已经结束了，这一步只是「我在自己的棋盘上摆一手试试」。
       */
      if (replayActive) {
        replay.move(from, to, promotion);
        return;
      }
      send({ t: 'move', from, to, promotion });
    },
    [send, replayActive, replay.move],
  );

  const interaction = useBoardInteraction({
    room: roomState,
    myColor,
    onMove: handleMove,
    // 复盘开着 → 棋盘用复盘的局面，而且**双方棋子都能动**
    free: replayActive ? { fen: replay.fen } : null,
  });

  /**
   * 辅助下棋：轮到我走时向服务端要一次「推荐下一步」。
   *
   * 服务端用**同一套引擎**（AI 用的那套）算，算完只回给**我一个人** ——
   * 提示是私人的，不广播（对手不该看见我的推荐）。
   *
   * 触发时机：设置里开着「辅助下棋」+ 轮到我走 + 局面变了 → 重新要一次。
   * 局面没变就不重复要（省算力）。
   *
   * ⚠️ **绝对不能一进 effect 就清箭头**：
   *   服务端**每秒**广播一次房间快照（棋钟刷新），`roomState` 的对象身份每秒都变，
   *   这个 effect 也就每秒重跑一次 —— 箭头刚出现就被自己抹掉，
   *   实测「辅助下棋」几乎永远看不见（提示算回来 12ms 后就被清掉了）。
   *   所以只有「局面真的变了 / 关掉提示 / 轮不到我走」才清箭头；
   *   同一个局面重复跑到，直接返回，箭头留着。
   *
   * （这个 effect 放在 `interaction` 之后 —— 它要用 `interaction.isMyTurn`。）
   */
  const hintFenRef = useRef<string>('');
  useEffect(() => {
    if (!settings.hintEnabled) {
      hintFenRef.current = '';
      setHintMove(null);
      return;
    }
    if (!roomState || roomState.status !== 'playing') return;
    if (!myColor || isSpectator) {
      setHintMove(null);
      return;
    }
    if (!interaction.isMyTurn) {
      // 轮不到我走了 → 上一局的推荐已经过时，收起来
      hintFenRef.current = '';
      setHintMove(null);
      return;
    }
    /*
     * **局面变了** → 旧的推荐过时了，收起来。
     *
     * ⚠️ 必须比 **FEN**，不能比 `roomState` 的对象身份：
     * 服务端**每秒**广播一次房间快照（棋钟刷新），`roomState` 的身份每秒都变 ——
     * 按身份判的话，箭头刚出现就被自己抹掉（实测「几乎永远看不见」）。
     */
    if (hintFenRef.current && hintFenRef.current !== roomState.fen) {
      setHintMove(null);
    }
    hintFenRef.current = roomState.fen;
  }, [settings.hintEnabled, roomState, myColor, isSpectator, interaction.isMyTurn]);

  /** 提示算完了（或失败）：清掉「正在算」 */
  useEffect(() => {
    if (!hintPending) return;
    const timer = setTimeout(() => setHintPending(false), 8000);
    return () => clearTimeout(timer);
  }, [hintPending]);

  // 离开房间：必须先让服务端摘掉座位，并清掉本地房间快照，
  // 否则回到大厅后会被「拿到房间快照就跳转」的逻辑立刻弹回来。
  const doLeave = useCallback(() => {
    // 先记「我已经离开这个房间」—— 否则本地快照被清空之后，
    // 上面那个「进入房间」的 effect 会立刻又发一次 room.join，把自己拉回去。
    leftRoomRef.current = code;
    leaveRoom();
    router.push('/');
  }, [leaveRoom, router, code]);

  /**
   * 顶栏的「离开」按钮。
   *
   * **对局进行中要点确认** —— 服务端 leaveRoom 会直接判对方胜（reason=abandon），
   * 也就是「离开」在实质上就是「认输」；认输都有二次确认，离开不能绕过它。
   */
  const handleLeave = useCallback(() => {
    /*
     * 二次确认只在「**离开真的等于判负**」的时候才要。
     *
     * - 对局进行中 + 自己是棋手 → 离开=判负 → 必须确认（用户拍板的规矩）。
     * - **观战者** → 离开不影响对局，没有要确认的理由。
     *   原来这里只判 status，于是观战者点「离开」会置上一个**永远不显示**的
     *   确认标记（离开的浮层只对棋手渲染）→ 点了没反应，人被卡在房间里出不来。
     */
    if (roomState?.status === 'playing' && myColor && !isSpectator) {
      setLeaveAsk(true);
      return;
    }
    doLeave();
  }, [roomState?.status, myColor, isSpectator, doLeave]);

  /**
   * 「返回大厅」。
   *
   * 关键：**先放弃这个房间**再跳转 ——
   * 加入请求可能还在飞，服务端的房间快照晚到一步会把人又拽回对局页
   * （表现是「点了返回大厅，一秒后又被拽回棋盘」）。
   */
  const backToLobby = useCallback(() => {
    /*
     * 手上还持着房间快照 → 先把座位摘掉（服务端那边可能还把我们算在房里）。
     * 不摘的话，对方面对一个幽灵，棋钟还在替我们走。
     * 再标记「已放弃」→ 之后迟到的房间快照（加入结果 / 重连自动恢复）一律丢弃。
     */
    leftRoomRef.current = code;
    leaveRoom();
    abandonRoom();
    router.push('/');
  }, [leaveRoom, abandonRoom, router, code]);

  // 视角切换持久化
  const changeView = (mode: ViewMode): void => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* ignore */
    }
  };

  /**
   * 上一步走子 —— 走子箭头就画它。
   *
   * 数据直接取自**服务端的走子记录**（不是本地 diff），
   * 所以中途才进房的人、2D/3D 来回切的人，看到的箭头都是同一根。
   */
  const lastMove = useMemo(() => {
    const moves = roomState?.moves;
    if (!moves || moves.length === 0) return null;
    const m = moves[moves.length - 1];
    return { from: m.from, to: m.to };
  }, [roomState?.moves]);

  /*
   * **棋盘显示哪个局面**。
   *
   * 复盘开着 → 复盘的局面（可能是棋谱中间某一手，也可能是自由走棋的沙盒）；
   * 没开 → 房间的局面。
   */
  const boardFen = replayActive ? replay.fen : (roomState?.fen ?? '');

  /**
   * 走子箭头画哪一步。
   *
   * 复盘时跟着**复盘走到的那一步**（棋谱中间的一手，或沙盒里那一步），
   * 没开复盘才画棋局的最后一步。
   */
  const boardLastMove = useMemo(() => {
    if (replayActive) {
      const step = replay.lastStep;
      return step ? { from: step.from, to: step.to } : null;
    }
    return lastMove;
  }, [replayActive, replay.lastStep, lastMove]);

  /**
   * 升变弹窗里棋子的颜色。
   *
   * 正常对局：升变的一定是**自己的兵** → 用自己的执色。
   * 复盘（自由走棋）：**双方的兵都能升变** → 得看升的是哪一方的兵，
   * 否则会出现「黑兵升变，弹窗里却画着一颗白后」。
   */
  const promotionColor =
    interaction.pendingPromotion && boardFen
      ? (pieceAt(boardFen, interaction.pendingPromotion.from)?.color ?? myColor ?? 'w')
      : (myColor ?? 'w');

  /**
   * 棋谱（按回合配对）。
   *
   * 服务端每一步都记了 chess.js 生成的标准 SAN，所以这里只是排版，
   * 不用重新推导任何东西。
   */
  const notation = useMemo(() => pairMoves(roomState?.moves ?? []), [roomState?.moves]);

  /** 复制 PGN —— 能直接粘进任何棋谱软件 */
  const copyPgn = useCallback(async () => {
    if (!roomState) return;
    const pgn = buildPgn({
      moves: roomState.moves,
      whiteName: roomState.seats.w?.name ?? '白方',
      blackName: roomState.seats.b?.name ?? '黑方',
      result: roomState.result,
    });
    /*
     * 走 `copyText` 而不是直接 `navigator.clipboard.writeText` ——
     * 局域网里跑的是 `http://192.168.x.x`，**不是安全上下文**，
     * 那儿 `navigator.clipboard` 压根是 `undefined`，直接调必抛异常。
     * `copyText` 自带「临时 textarea + execCommand」的兜底（http 下也能用）。
     */
    const ok = await copyText(pgn);
    if (ok) {
      pushToast('success', 'PGN 已复制到剪贴板');
    } else {
      pushToast('error', '复制失败，请手动选择棋谱文字复制');
    }
  }, [roomState, pushToast]);

  /**
   * **分享**的复制结果提示。
   *
   * 复制失败也提示 —— 局域网里走的是 http，`navigator.clipboard`
   * 在那儿不一定可用（有兜底，但兜底也可能被浏览器策略挡掉）。
   * 失败时至少让人知道「没复制上」，可以手动把房间码报给对面。
   */
  const handleShareCopy = useCallback(
    (what: 'link' | 'code', ok: boolean): void => {
      if (!ok) {
        pushToast('error', '复制失败，请手动记下房间码');
        return;
      }
      pushToast('success', what === 'link' ? '房间链接已复制' : '房间码已复制');
    },
    [pushToast],
  );

  // 棋钟剩余时间（客户端根据服务端快照 + 本地经过时间估算）
  const clockInfo = useMemo(() => {
    if (!roomState) return null;
    const { clock, fen } = roomState;
    if (!clock.enabled) return null;
    const turn: Color = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const elapsed = clock.running ? Math.max(0, now - clock.lastTickAt) : 0;
    /*
     * **不做下限截断** —— 超时只判负、不结束棋局，棋钟会继续往负数走。
     * 负数就是「已经超时多久」，直接显示成 `-1:23`。
     */
    const wMs = clock.wMs - (turn === 'w' ? elapsed : 0);
    const bMs = clock.bMs - (turn === 'b' ? elapsed : 0);
    return { wMs, bMs, turn, running: clock.running };
  }, [roomState, now]);

  const sendChat = (): void => {
    const text = chatText.trim();
    if (!text) return;
    send({ t: 'chat', text });
    setChatText('');
  };

  /**
   * 快捷聊天：发一条预设消息。
   *
   * 和打字聊天**走同一条路**（服务端统一广播 `t: 'chat'`），
   * 所以它同样既进聊天记录、又飘弹幕。
   */
  const sendQuickChat = useCallback(
    (text: string) => {
      send({ t: 'chat.quick', text });
    },
    [send],
  );

  // 结果文案
  const resultText = roomState?.result ? describeResult(roomState.result) : null;
  /**
   * **终局结果卡要不要浮在棋盘上。**
   *
   * 三个条件同时成立才浮：
   *  - 这一局真的**结束了**（`status === 'finished'`）——
   *    「超时判负但棋还能继续下」不是终局，不浮（免得挡住还在下的棋）；
   *  - 有结果文案；
   *  - **没在复盘** —— 复盘时这张卡让位给棋盘本身。
   */
  const showResultCard =
    Boolean(resultText) && roomState?.status === 'finished' && !replayActive;

  /*
   * 「正在进入房间…」这张卡。
   *
   * 两种情况共用它：
   *  - 身份还没建起来（正在自动登录）；
   *  - 身份有了，但房间快照还没到（正在等服务端回房间）。
   *
   * 为什么合成一张：这两件事对用户来说是**同一件事**——
   * 「我正在回到这局棋，只是还没到」。
   * 分成两张卡反而会让人以为卡住了。
   */
  const enteringCard = (
    <div className="page">
      <div className="container" style={{ paddingTop: 80, textAlign: 'center' }}>
        <div className="card" style={{ maxWidth: 420, margin: '0 auto' }}>
          <h2>正在进入房间…</h2>
          <p className="hint">
            房间码 <strong>{code}</strong>
            {!connected && '（与服务器断开，正在重连…）'}
          </p>
          {/* 还在加载也要给个出口 —— 万一一直等不到结果，不至于卡死 */}
          <button className="btn primary" onClick={backToLobby}>
            返回大厅
          </button>
        </div>
      </div>
    </div>
  );

  if (!session) {
    /*
     * 有记住的用户名 → 正在**自动回来**（身份马上就建好），
     * 所以显示「正在进入房间…」，而不是「需要先登录」。
     *
     * 显示错的后果很具体：用户看到「需要先登录」会以为回不来了，
     * 于是跑去大厅重新走一遍 —— 那样即使后面能认领，也已经把人劝退了。
     */
    if (savedName) return enteringCard;
    /*
     * **没有记住的用户名** → 现取一个，填完直接进这局。
     *
     * 这是**分享链接进来的那条路**：别人点开链接，第一眼看到的就是这个卡片，
     * 取个名字就落到棋盘上 —— 不用回大厅、不用再点一次「加入房间」。
     * （旧版这里是「需要先登录 + 返回大厅」，等于把分享链接的用处砍掉一半。）
     */
    return (
      <div className="page">
        <div className="container" style={{ paddingTop: 80, textAlign: 'center' }}>
          <div className="card" style={{ maxWidth: 420, margin: '0 auto' }}>
            <h2>取个名字，进这局</h2>
            <p className="hint">房间码 {code}</p>
            <div className="field" style={{ textAlign: 'left' }}>
              <label htmlFor="join-name">用户名</label>
              <input
                id="join-name"
                className="input"
                value={joinName}
                maxLength={20}
                autoFocus
                placeholder="例如：球球"
                onChange={(e) => setJoinName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitJoinName();
                }}
              />
            </div>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={submitJoinName}>
                进入房间
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /*
   * 进不去这个房间（对局已结束 / 房间不存在 / 观战人数已满）。
   *
   * 这张卡片要**把原因写出来** —— 服务端的原话，不做二次演绎。
   * 以前只有一闪而过的 toast，页面永远停在下面那张「正在进入房间…」的卡上，
   * 人卡在那里出不来（刷新后的真实故障）。
   */
  if (joinError) {
    return (
      <div className="page">
        <div className="container" style={{ paddingTop: 80, textAlign: 'center' }}>
          <div className="card" style={{ maxWidth: 420, margin: '0 auto' }}>
            <h2>进不去这个房间</h2>
            <p className="hint">原因：{joinError}</p>
            <button className="btn primary" onClick={backToLobby}>
              返回大厅
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!roomState) {
    return enteringCard;
  }

  const whiteSeat = roomState.seats.w;
  const blackSeat = roomState.seats.b;

  /** 玩家行：棋子图标 + 名字 + 剩余时间（+「再来一局」） */
  const renderPlayer = (color: Color) => {
    const seat = color === 'w' ? whiteSeat : blackSeat;
    const isTurn = roomState.fen.split(' ')[1] === color && roomState.status === 'playing';
    const ms = clockInfo ? (color === 'w' ? clockInfo.wMs : clockInfo.bMs) : null;
    const low = ms !== null && ms < 30_000;
    /** 已经超时（剩余时间是负数）—— 这一方已经判负，但棋还能继续下 */
    const over = ms !== null && ms < 0;
    /*
     * 「再来一局」按**人**显示，不是 HUD 里一个全局按钮 ——
     * 用户原话：「既然这里都显示两个用户，那这里点击再来一局就在点击的用户这里显示再来一局，
     * 然后就不让重复点击再来一局了」。
     *
     * 所以：
     *   - 可点的按钮只出现在**自己那一行**（我只能替自己点）；
     *   - 点过之后那一行变成「已申请」，**不能再点**（本地立刻锁一次，
     *     服务端那边也按 color 去重，双保险）；
     *   - 对方申请了，**他那一行**显示「已申请」，我一眼能看出还差谁。
     * 两个人都申请 → 服务端直接开新局。
     */
    const rematchOpen = roomState.status === 'finished' || Boolean(roomState.resultLocked);
    const voted = rematchOpen && roomState.rematchVotes.includes(color);
    const canRematch = rematchOpen && myColor === color && !isSpectator && !voted && !rematchSent;
    /*
     * **战利品**：这一方**吃掉的对方棋子**。
     *
     * 归属按国际象棋界面的惯例：显示在**吃子方自己那一行**的下方 ——
     * 「电脑」行下面 = 电脑吃掉的白子；我这一行下面 = 我吃掉的对方的子。
     * 两行合起来就是「双方吃子的情况」。
     *
     * 数据来自棋谱：每一步都记了 `captured`（被吃棋子的类型）。
     * 顺序按吃掉的先后（棋谱顺序），一眼能看出「他先吃了我的兵」。
     */
    const captured = roomState.moves
      .filter((m) => m.color === color && m.captured)
      .map((m) => m.captured as PieceType);
    /** 战利品的颜色 = 对方的颜色（白方吃的是黑子） */
    const capturedColor: 'w' | 'b' = color === 'w' ? 'b' : 'w';
    return (
      <div className={`player-row ${isTurn ? 'turn' : ''}`} key={color}>
        <div className="row-main">
          <div className="who">
            <span className={`piece-dot${color === 'b' ? ' dark' : ''}`} aria-hidden="true" />
            <span className="name">
              {seat?.name ??
                (roomState.pending && color === bottomColor ? roomState.pending.name : '等待玩家…')}
            </span>
            {seat?.isAI && <span className="badge">电脑</span>}
            {/*
             * 待抽签的标记 —— 黑白还没定，所以这一行**不是**白方或黑方，
             * 只是「人在这局里」。
             */}
            {!seat && roomState.pending && color === bottomColor && (
              <span className="badge">待抽签</span>
            )}
            {/* 已准备标记（抽签之后、正式开局之前） */}
            {roomState.status === 'preparing' && seat?.ready && (
              <span className="badge">已准备</span>
            )}
            {/*
              已经超时判负 —— **结果定了，但棋还能继续下**。
              所以这里标的是状态，不是「这局结束了」。
            */}
            {roomState.flagged?.includes(color) && <span className="badge timeout">已超时</span>}
            {seat && !seat.connected && <span className="offline">掉线中…</span>}
          </div>
          <div className="row-tail">
          {ms !== null && (
            <span
              className={`clock ${low ? 'low' : ''} ${over ? 'over' : ''} ${clockInfo?.running && isTurn ? 'running' : ''}`}
            >
              {formatClockMs(ms)}
            </span>
          )}
          {canRematch && (
            <button
              className="btn small primary rematch-btn"
              onClick={() => {
                setRematchSent(true);
                send({ t: 'rematch' });
              }}
            >
              再来一局
            </button>
          )}
            {voted && <span className="rematch-voted">已申请</span>}
  
          </div>
        </div>
        {/*
         * 战利品带：该玩家吃掉的对方棋子。
         *
         * 一颗都没有就不渲染 —— 否则每个玩家行下方都挂一条空行，HUD 白白高一块。
         */}
        {captured.length > 0 && (
          <div
            className="captured-strip"
            aria-label={`${seat?.name ?? '这一方'}吃掉的对方棋子`}
          >
            {captured.map((type, i) => (
              <PieceGlyph
                key={`${type}-${i}`}
                type={type}
                color={capturedColor}
                size={20}
                className="cap"
                style={settings.pieceStyle}
                material={settings.pieceMaterial}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // 自己的棋子排在下面：白方视角 → 白在下，黑方视角 → 黑在下。
  // 观战者没有自己的颜色，默认按白方视角显示（上方白方、下方黑方）。
  const bottomColor: Color = myColor === 'b' ? 'b' : 'w';
  const topColor: Color = bottomColor === 'w' ? 'b' : 'w';

  /**
   * 我是不是**还在等抽签**（房间里只有我一个人，黑白还没定）。
   *
   * 服务端把「待抽签的玩家」单独放在 `room.pending` 里 ——
   * 他已经在这局中了，只是还没有颜色。
   */
  const isPendingPlayer = !isSpectator && !myColor && Boolean(roomState.pending);
  /**
   * **能不能分享这个房间**。
   *
   * 判据与「房间码给谁看」完全一致：
   *  - 必须是**对局方**（观战者看不到房间码，也就不该能把它分享出去）；
   *  - 必须是**真人对局** —— 人机局没有「对手」可抢，
   *    分享出去的链接只能让别人看，不能一起下（与私聊邀请同一条规矩）。
   */
  const canShare =
    Boolean(myColor || isPendingPlayer) &&
    !roomState.seats.w?.isAI &&
    !roomState.seats.b?.isAI;
  /** 我自己那个座位准备好了没（只对真人对局有意义） */
  const mySeat = myColor ? roomState.seats[myColor] : undefined;
  const iAmReady = Boolean(mySeat?.ready);
  /** 对方准备好了没 */
  const otherColor: Color | undefined = myColor === 'w' ? 'b' : myColor === 'b' ? 'w' : undefined;
  const otherReady = Boolean(otherColor ? roomState.seats[otherColor]?.ready : false);

  /**
   * 我这一局执哪边（观战者没有这个值）。
   *
   * 人机局**不走「准备」环节**，玩家没机会在 preparing 里看到
   * 「本局你执白/黑」；开局后如果也不说，他就不知道自己拿的是哪边 ——
   * 棋盘虽然按自己执色翻转了，但那是视觉暗示，不是明确告知。
   */
  const myColorLabel = myColor === 'w' ? '你执白' : myColor === 'b' ? '你执黑' : '';
  /** 给状态文案加执色前缀（观战者不加） */
  const withColor = (s: string) => (myColorLabel ? myColorLabel + ' · ' + s : s);

  /** 对局状态一句话 */
  const baseStatusText =
    roomState.status === 'waiting'
      ? isPendingPlayer
        ? '等待对手加入…（两人到齐后抽签定黑白）'
        : '等待对手加入…'
      : roomState.status === 'preparing'
        ? myColor === 'w'
          ? iAmReady
            ? '本局你执白 · 已准备，等对方准备'
            : '本局你执白 · 点「准备」开始'
          : myColor === 'b'
            ? iAmReady
              ? '本局你执黑 · 已准备，等对方准备'
              : '本局你执黑 · 点「准备」开始'
            : '抽签中…'
        : roomState.status === 'finished'
        ? myColor && roomState.rematchVotes.includes(myColor)
          ? '已申请，等对方再来一局'
          : '对局已结束'
        : /*
           * 将军要**单独说** —— 它是国际象棋里最要紧的一条状态信息，
           * 混在「轮到你走」里等于没告诉玩家。
           * inCheck 指的是**当前走子方**被将军，所以：
           *   轮到我走 → 我被将军，必须应将；
           *   轮到对方 → 对方被将军（我占优）。
           *
           * 前面挂上自己的执色 —— 人机局没有 preparing 那段提示，
           * 开局后就得一直让玩家看得见自己是白还是黑。
           */
          roomState.inCheck
          ? interaction.isMyTurn
            ? withColor('将军！你必须应将')
            : withColor('将军！对方正在被将军')
          : interaction.isMyTurn
            ? withColor('轮到你走')
            : withColor('等待对手走棋');

  /** 复盘时状态行说「复盘中」—— 这一行本来就是放**当前状态**的 */
  const statusText = replayActive ? '复盘中' : baseStatusText;

  /**
   * 右侧浮层提示（认输二次确认 / 求和 / 悔棋）。
   *
   * 全部是**浮层**，不占文档流 —— 页面高度不受影响（不会顶出整页滚动条）。
   * 「谁该回应」由服务端状态决定：
   *   - `drawOffer` 是发起方的颜色：不是我 = 我要回应；是我 = 我在等；
   *   - `takebackOffer.by` 同理。
   */
  const prompts: SidePromptProps[] = [];
  if (myColor && !isSpectator) {
    if (resignAsk) {
      prompts.push({
        id: 'resign',
        title: '确认认输？',
        body: '认输后本局立即结束、对方获胜，不能反悔。',
        tone: 'danger',
        now,
        actions: [
          { label: '取消', onClick: () => setResignAsk(false) },
          {
            label: '确认认输',
            tone: 'danger',
            onClick: () => {
              setResignAsk(false);
              send({ t: 'resign' });
            },
          },
        ],
      });
    }

    if (leaveAsk) {
      prompts.push({
        id: 'leave',
        title: '对局中离开？',
        body: '现在离开会判你输（对方直接获胜）。确定要离开吗？',
        tone: 'danger',
        now,
        actions: [
          { label: '取消', onClick: () => setLeaveAsk(false) },
          {
            label: '确认离开',
            tone: 'danger',
            onClick: () => {
              setLeaveAsk(false);
              doLeave();
            },
          },
        ],
      });
    }

    const drawOffer = roomState.drawOffer;
    if (drawOffer) {
      if (drawOffer === myColor) {
        prompts.push({
          id: 'draw-waiting',
          title: '等待对方回应',
          body: '你已提议和棋。对方同意即成和棋；超时（30 秒）自动拒绝。',
          deadline: roomState.drawDeadline,
          now,
          actions: [{ label: '取消请求', onClick: () => send({ t: 'draw.decline' }) }],
        });
      } else {
        prompts.push({
          id: 'draw-incoming',
          title: '对方提议和棋',
          body: '对方想和你下成和棋。',
          deadline: roomState.drawDeadline,
          now,
          actions: [
            { label: '反对', onClick: () => send({ t: 'draw.decline' }) },
            { label: '同意', tone: 'primary', onClick: () => send({ t: 'draw.accept' }) },
          ],
        });
      }
    }

    const takeback = roomState.takebackOffer;
    if (takeback) {
      if (takeback.by === myColor) {
        prompts.push({
          id: 'takeback-waiting',
          title: '等待对方回应',
          body: '已发出悔棋请求。对方同意后撤销你上一步的棋（连同对方的应手一起撤掉）、轮到你重走（棋钟不回退）；超时（30 秒）自动拒绝。',
          deadline: takeback.deadline,
          now,
          actions: [{ label: '取消请求', onClick: () => send({ t: 'takeback.decline' }) }],
        });
      } else {
        prompts.push({
          id: 'takeback-incoming',
          title: '对方请求悔棋',
          body: '对方想悔掉他自己上一步的棋。同意后连同你这边的应手一起撤掉，轮到他重走（棋钟不回退）。',
          deadline: takeback.deadline,
          now,
          actions: [
            { label: '反对', onClick: () => send({ t: 'takeback.decline' }) },
            { label: '同意', tone: 'primary', onClick: () => send({ t: 'takeback.accept' }) },
          ],
        });
      }
    }
  }

  return (
    <div className="page">
      <header className="topbar container wide">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <Castle size={18} />
          </span>
          房间 {code}
          {isSpectator && <span className="spec-tag" style={{ marginLeft: 10 }}>观战中</span>}
        </div>
        <div className="topbar-actions">
          <div className="view-toggle">
            <button
              className={viewMode === '2d' ? 'active' : ''}
              onClick={() => changeView('2d')}
            >
              2D
            </button>
            <button
              className={viewMode === '3d' ? 'active' : ''}
              onClick={() => changeView('3d')}
            >
              3D
            </button>
          </div>
          {isSpectator && (
            <button className="btn small ghost" onClick={() => setSpectatorFlip((v) => !v)}>
              <RotateCcw size={15} aria-hidden="true" />
              翻转视角
            </button>
          )}
          {/*
            在线名单 —— **对局页也有**（和大厅同一套）。
            上一版这里只有一个「已连接」圆点：人在棋盘上时想看还有谁在线，
            只能退回大厅 —— 顶栏本来就是全局入口，不该按页面分裂。
          */}
          <OnlineUsersMenu
            connected={connected}
            status={status}
            online={lobby.online}
            users={lobby.onlineUsers}
            selfId={session?.userId}
            offlineLabel="重连中…"
            onMessage={(peer) => {
              setDmPeer(peer);
              setDmOpen(true);
            }}
          />
          {/* 私信：大厅里也能收到，进来下棋的人也得能翻出来 */}
          <DmButton unread={dmUnread} onClick={() => setDmOpen(true)} />
          {/*
            分享 —— 复制房间链接（对方点开就进这局）或房间码。
            只给**对局方**：观战者看不到房间码，人机局也没有「一起下」这回事。
          */}
          {canShare && <ShareMenu code={roomState.code} onCopy={handleShareCopy} />}
          <button
            className="btn small ghost icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="设置"
          >
            <Settings size={19} aria-hidden="true" />
          </button>
          <button className="btn small ghost" onClick={handleLeave}>
            <LogOut size={15} aria-hidden="true" />
            离开
          </button>
        </div>
      </header>

      <main className="container wide game-layout" style={{ paddingBottom: 40 }}>
        {/*
          棋盘舞台。

          三块内容（全是**流内**的，永远不压棋盘）：
            1. HUD   —— 状态 + 双方 + 棋钟 + 认输/和棋，常驻；
            2. 棋盘  —— 居中；
            3. 聊天  —— 聊天记录 + 输入框 + 快捷聊天，常驻。

          它们的**方位**由 layout 决定（见 planStageLayout）：
            宽屏 → HUD 在左、棋盘在中、聊天在右（三列）；
            窄屏 → HUD 在上、棋盘在中、聊天在下（三行）。
          两种排法共用这一份 DOM，只换 CSS grid。
        */}
        <div ref={setStageEl} className={`stage stage-${viewMode} layout-${layout}`}>
          {/*
            左列（宽屏）/ 上方（窄屏）：HUD —— 状态 + 双方 + 棋钟 + 认输/和棋。
            整块都在文档流里，永远不压棋盘。
          */}
          <div className="col-hud">
            <div className="hud">
              <div className={`hud-status${roomState.inCheck ? ' check' : ''}`}>{statusText}</div>
              {/*
               * 房间码 —— **只给对局双方看**，观战者看不到。
               *
               * 邀请房（visibility = 'invite'）的码在大厅列表里是不显示的，
               * 房主要把码告诉对手，只能在这儿看 —— 所以它必须常驻，
               * 不能只靠建房时那条几秒钟就消失的 toast。
               */}
              {(myColor || isPendingPlayer) && !isSpectator && (
                <div className="hud-code">
                  <span>房间码</span>
                  <strong>{roomState.code}</strong>
                </div>
              )}
              <div className="hud-players">
                {renderPlayer(topColor)}
                {renderPlayer(bottomColor)}
              </div>
              <div className="hud-actions">
                {/*
                 * **准备按钮** —— 抽签之后、正式开局之前，双方各点一次。
                 *
                 * 为什么要这一步：抽签之后**白方先走**，得给白方一点时间
                 * 看清自己执的是哪一边（棋盘朝向也是按执子颜色定的）。
                 * 人机对局不走这一步（AI 不需要准备）。
                 */}
                {myColor && !isSpectator && roomState.status === 'preparing' && (
                  <button
                    className={`btn small${iAmReady ? '' : ' primary'}`}
                    onClick={() => send({ t: 'ready' })}
                    disabled={iAmReady}
                    title={
                      iAmReady
                        ? '你已经准备好了，等对方也点准备'
                        : '准备好了就点这里，双方都准备才开局'
                    }
                  >
                    {iAmReady ? '已准备' : '准备'}
                  </button>
                )}
                {myColor && !isSpectator && roomState.status === 'playing' && (
                  <>
                    <button className="btn small" onClick={() => setResignAsk(true)}>
                      <Flag size={15} aria-hidden="true" />
                      认输
                    </button>
                    {/*
                     * 人机局：**不摆和棋和悔棋**，只给一个「撤回」。
                     *
                     * 电脑是对手，它没有「同意 / 反对」这个交互 ——
                     * 和棋它只会拒绝，悔棋它只会秒同意，两个按钮在人机局里都是废的。
                     * 撤回是**单方面**的：一步一手棋，可以一直点，一路撤回到开局。
                     */}
                    {isAiGame ? (
                      <button
                        className="btn small"
                        onClick={() => send({ t: 'ai.undo' })}
                        disabled={!canUndo}
                        title={
                          canUndo
                            ? '撤回你上一步走的棋（可以一直点，一路撤回到开局）'
                            : '还没有可以撤回的棋'
                        }
                      >
                        <Undo2 size={15} aria-hidden="true" />
                        撤回
                      </button>
                    ) : (
                      <>
                        <button className="btn small" onClick={() => send({ t: 'draw.offer' })}>
                          <Handshake size={15} aria-hidden="true" />
                          提议和棋
                        </button>
                        <button
                          className="btn small"
                          onClick={() => send({ t: 'takeback.offer' })}
                          disabled={!canOfferTakeback}
                          title={takebackTitle}
                        >
                          <Undo2 size={15} aria-hidden="true" />
                          悔棋
                        </button>
                      </>
                    )}
                    {/*
                      「提示」按钮 —— **辅助下棋开着才出现，点它才显示下一步**。

                      用户要求：「打开辅助下棋之后，不要自动显示下一步怎么走」，
                      改成**点一下才显示**。

                      为什么不让它一直显示：推荐着法等于把答案摊开，
                      自动弹出来等于「没辅助下棋也等于开着」。要提示的时候才提示。

                      行为：
                      - 还没显示 → 请求服务端算一步（蓝色箭头）
                      - 已经显示 → 再点一次是**收起**（不是重算 —— 局面变了会自动失效）
                      - 没轮到你走 → 置灰（服务端也只给「轮到你」的人算）
                      - 关掉辅助下棋 → 按钮和箭头一起消失
                    */}
                    {settings.hintEnabled && (
                      <button
                        className={`btn small${hintMove ? ' active' : ''}`}
                        onClick={() => {
                          if (hintMove) {
                            setHintMove(null);
                            return;
                          }
                          setHintPending(true);
                          send({ t: 'hint.request' });
                        }}
                        disabled={hintPending || !interaction.isMyTurn}
                        title={
                          hintPending
                            ? '正在算推荐着法…'
                            : hintMove
                              ? '收起推荐的下一步'
                              : interaction.isMyTurn
                                ? '算一步推荐着法（蓝色箭头）'
                                : '还没轮到你走'
                        }
                      >
                        <Sparkles size={15} aria-hidden="true" />
                        {hintPending ? '思考中…' : hintMove ? '收起提示' : '提示'}
                      </button>
                    )}
                  </>
                )}
                {/*
                  「再来一局」**不在这里** ——
                  它按人显示在各自那一行（见 renderPlayer）：
                  HUD 里挂一个全局按钮，两个人看过去分不清是谁点的。
                */}
                {/*
                  **复盘** —— 终局之后给**双方**各一个按钮。
                  （不是只给赢家 —— 输的那方同样想复盘这盘棋。）

                  点开之后，这一排按钮换成**复盘控制器**：
                    还原 / 上一步 / 下一步 + 退出复盘。

                  三个按钮的规则（用户拍板）：
                    - 上一步 / 下一步：沿**棋谱**前后走；
                    - 还原：没自由走棋时回到**开局**，
                      自由走棋之后回到**自由走棋之前**的棋盘；
                    - **自由走棋之后，上一步/下一步直接藏掉** ——
                      沙盒里的局面不在棋谱上，让「下一步」接着走棋谱，
                      棋盘会从「我随手走的一步」硬跳到「棋谱的下一手」，
                      两边根本不是相邻的两步。只有「还原」能出沙盒，
                      出了沙盒这两个键才重新出现。
                */}
                {myColor && !isSpectator && roomState.status === 'finished' && (
                  <>
                    {/*
                     * **终局也能悔棋**（2026-11-20 拍板）——
                     * 自己那一步把对方将死/逼和了，照样能撤回那一步。
                     *
                     * 只有「棋盘规则」判出来的终局才悔得动
                     * （认输/双方同意和棋/超时是**人的决定**，撤一步改不了它），
                     * 这道判断在 `canOfferTakeback` 里。
                     */}
                    {canOfferTakeback && !isAiGame && (
                      <button
                        className="btn small"
                        onClick={() => send({ t: 'takeback.offer' })}
                        title={takebackTitle}
                      >
                        <Undo2 size={15} aria-hidden="true" />
                        悔棋
                      </button>
                    )}
                    {replayActive ? (
                      <>
                      <button
                      className="btn small"
                      onClick={replay.reset}
                      title={
                      replayFree
                      ? '回到自由走棋之前的棋盘'
                      : '回到开局局面，重新看一遍'
                      }
                      >
                      <RotateCcw size={15} aria-hidden="true" />
                      还原
                      </button>
                      {!replayFree && (
                      <>
                      <button
                      className="btn small"
                      onClick={replay.prev}
                      disabled={!replay.canPrev}
                      title="上一步"
                      >
                      <ChevronLeft size={15} aria-hidden="true" />
                      上一步
                      </button>
                      <button
                      className="btn small"
                      onClick={replay.next}
                      disabled={!replay.canNext}
                      title="下一步"
                      >
                      下一步
                      <ChevronRight size={15} aria-hidden="true" />
                      </button>
                      </>
                      )}
                      <button
                      className="btn small ghost"
                      onClick={replay.stop}
                      title="退出复盘，回到终局局面"
                      >
                      <X size={15} aria-hidden="true" />
                      退出复盘
                      </button>
                      </>
                  ) : (
                      <button
                      className="btn small"
                      onClick={replay.start}
                      title="按棋谱回放这盘棋（只有你自己看得到进度）"
                    >
                      <History size={15} aria-hidden="true" />
                      复盘
                    </button>
                  )}
                  </>
                )}
              </div>
            </div>

            {/*
              **记谱卡**（宽屏）—— 棋谱常驻左栏，不是弹窗。

              为什么不做成弹窗：
                棋谱是「边下边看」的参照信息。做成弹窗就要压暗整页、盖住右边的
                聊天、还会挡住棋盘 —— 恰恰在最想看棋谱的时候最挡事
                （用户原话：「这个棋谱的弹窗的样式有点问题…是不是就不适合做成弹窗」）。

              为什么它放左列：
                左列本来就空着一大片（HUD 卡只占上面一截），
                记谱纸摆在棋盘旁边也是线下的老位置。

              窄屏不常驻：左栏变成顶部一整条，卡常驻会把棋盘挤没 →
              窄屏走底部弹层（见页面下方 `.notation-overlay`）。
            */}
            {!isNarrow && notationCardOpen && (
              <div className="notation-card">
                <div className="notation-head">
                  <span>棋谱</span>
                </div>
                <NotationRows rows={notation} />
                <div className="notation-foot">
                  <button
                    className="btn small primary"
                    style={{ flex: 1 }}
                    onClick={copyPgn}
                    disabled={roomState.moves.length === 0}
                  >
                    复制 PGN
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 中列：棋盘 */}
          <div className="board-area">
            <div className="board-panel">
              {/*
                **终局结果卡** —— 浮在棋盘正中。
                为什么浮着而不是插在棋盘**上面**：
                  插在文档流里的话，它一出现就把棋盘**往下顶**，
                  棋盘、HUD、聊天全被挪了位置（用户原话：
                  「这个将死的提示是突然出现的，会导致页面中其他元素的位置发生改变」）。
                所以这里用 `position: absolute`（脱离文档流）：
                  出现的时候**什么都不动**，只有这张卡自己冒出来。
                它也不吃鼠标事件（pointer-events: none）—— 想点棋盘照样能点。

                放在 `.board-panel` 里（而不是 `.board-area` 里）是有意的：
                  `.board-panel` **不是**定位容器，所以这张绝对定位的卡
                  参照的仍然是 `.board-area`（position: relative）——
                  位置效果完全一样，但「一旦有人把绝对定位去掉」，
                  它就会**掉回 .board-panel 的文档流里、把棋盘顶下去**
                  （这正是老代码的毛病，门禁 R1 的差分判据就是抓这个）。
              */}
              {showResultCard && (
                <div className="result-overlay">
                  <div className="result-card">{resultText}</div>
                </div>
              )}

              {viewMode === '2d' ? (
                <Board2D
                  fen={boardFen}
                  interaction={interaction}
                  flipped={flippedForBoard}
                  lastMove={boardLastMove}
                  theme={boardTheme}
                  hintMove={hintMove}
                  pieceStyle={settings.pieceStyle}
                  pieceMaterial={settings.pieceMaterial}
                />
              ) : (
                <Board3D
                  fen={boardFen}
                  interaction={interaction}
                  flipped={flippedForBoard}
                  lastMove={boardLastMove}
                  theme={boardTheme}
                  hintMove={hintMove}
                  pieceStyle={settings.pieceStyle}
                  pieceMaterial={settings.pieceMaterial}
                />
              )}

              {interaction.pendingPromotion && (
                <div className="overlay" onClick={interaction.cancelPromotion}>
                  <div className="promotion-box" onClick={(e) => e.stopPropagation()}>
                    <p>兵升变为</p>
                    <div className="promotion-options">
                      {(['q', 'r', 'b', 'n'] as const).map((p) => (
                        <button key={p} onClick={() => interaction.choosePromotion(p)}>
                          <PieceGlyph
                            type={p}
                            color={promotionColor}
                            size={52}
                            style={settings.pieceStyle}
                            material={settings.pieceMaterial}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/*
                和棋 / 悔棋的请求**不再**往页面里插文字条 ——
                那种「突兀增加文本」会把页面内容往下顶，消息一多就顶出整页滚动条。
                现在统一走右侧浮层（见 .side-prompts）。
              */}
            </div>

            {/*
              弹幕层：快捷聊天从上方飘过去。
              放在**棋盘区**里（而不是页面最外层）——
              这样它只会飘过棋盘，不会跑到 HUD / 聊天块背后去。
            */}
            <div className="danmaku-layer" aria-hidden="true">
              {danmaku.map((d) => (
                <div key={d.id} className="danmaku-item" style={{ top: `${6 + d.lane * 12}%` }}>
                  <b>{d.name}</b>
                  <span>{d.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/*
            右列（宽屏）/ 下方（窄屏）：聊天块。

            两种排法不一样：
            - **宽屏**：右列有一个 300×525 的大框，聊天记录**常驻**，
              每条消息换行完整显示（长消息不再被省略号截断）。
            - **窄屏**：下面只留**一行** —— 「💬 聊天」按钮 + 快捷聊天。
              历史记录、输入框、发送按钮**全在弹窗里**，点「聊天」才出来；
              对方发来新消息时，「聊天」按钮右上角挂一个**角标**提醒。

            「聊天」按钮：宽屏点它直接聚焦输入框；窄屏点它展开聊天框。
          */}
          <div className="col-chat">
            <button
              className="rail-chat"
              onClick={() => {
                // 宽屏：记录就在旁边，点按钮直接打字
                // 窄屏：记录不在这里，点按钮展开聊天框
                if (isNarrow) setChatOpen(true);
                // 观战者没有输入框（不能打字），点按钮什么也不做
                else if (!isSpectator) chatInputRef.current?.focus();
              }}
              title={
                isSpectator
                  ? '聊天（观战只能发快捷聊天，不能打字）'
                  : isNarrow
                    ? '聊天（点这里展开聊天记录）'
                    : '聊天（点这里直接打字）'
              }
            >
              <span className="rail-icon" aria-hidden="true">
                <MessageSquare size={16} />
              </span>
              <span>聊天</span>
              {/* 未读角标：对方发来新消息、而聊天框没打开时计数 */}
              {chatUnread > 0 && (
                <span className="chat-badge" aria-label={`${chatUnread} 条新消息`}>
                  {chatUnread > 99 ? '99+' : chatUnread}
                </span>
              )}
            </button>

            {/* 宽屏常驻的记录区 + 输入框（窄屏整块隐藏 —— 都在弹窗里） */}
            <div className="chat-strip">
              <div className="chat-log" ref={chatLogRef}>
                {chatLog.length === 0 && <div className="msg sys">对局中的消息会显示在这里。</div>}
                {chatLog.map((m, i) => (
                  <div className="msg" key={i}>
                    <b>{m.name}</b>
                    {m.text}
                  </div>
                ))}
              </div>
              {/*
                观战者**没有输入框** —— 只能发快捷聊天（服务端也拒收打字消息）。
                记录照常看得见：棋手打的字，观战的人一样能读。
              */}
              {isSpectator ? (
                <div className="chat-spectator-note">观战只能发快捷聊天，不能打字</div>
              ) : (
                <div className="chat-input-row">
                  <input
                    ref={chatInputRef}
                    className="input"
                    value={chatText}
                    maxLength={200}
                    placeholder="说点什么…"
                    onChange={(e) => setChatText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') sendChat();
                    }}
                  />
                  <button className="btn small" onClick={sendChat}>
                    发送
                  </button>
                </div>
              )}
            </div>

            {/*
              快捷聊天 + 「♟ 棋谱」按钮。
              棋谱按钮在**快捷聊天的右边**（用户拍板）。
            */}
            <div className="rail-quick-row">
              <div className="rail-quick">
                {QUICK_CHATS.map((t) => (
                  <button key={t} className="rail-quick-btn" onClick={() => sendQuickChat(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <button
                className={`rail-notation-btn${(isNarrow ? notationSheetOpen : notationCardOpen) ? ' open' : ''}`}
                onClick={() => {
                  // 宽屏：收起/展开左栏的记谱卡（不弹任何东西）
                  // 窄屏：左栏放不下常驻卡 → 弹底部浮层（跟「聊天」一个规矩）
                  if (isNarrow) setNotationSheetOpen(true);
                  else setNotationCardOpen((v) => !v);
                }}
                title={isNarrow ? '棋谱（点这里展开棋谱）' : '棋谱（点击收起/展开记谱卡）'}
                aria-expanded={isNarrow ? notationSheetOpen : notationCardOpen}
              >
                <span aria-hidden="true">
                  <BookOpen size={15} />
                </span>
                <span>棋谱</span>
                {roomState.moves.length > 0 && (
                  <span className="notation-count">{roomState.moves.length}</span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/*
          聊天记录弹层（窄屏点「聊天」展开）。

          窄屏下面只留**一行**（「💬 聊天」按钮 + 快捷聊天），
          历史记录、输入框、发送按钮全在这个弹层里 ——
          不点「聊天」按钮，下面那行永远看不到这三样东西。

          这是**主动点击才出现**的临时浮层，会盖住部分棋盘；
          和「常驻面板一律不压棋盘」那条规矩不冲突 —— 那条管的是常驻元素。
        */}
        {chatOpen && (
          <div className="overlay chat-overlay" onClick={() => setChatOpen(false)}>
            <div className="chat-panel" onClick={(e) => e.stopPropagation()}>
              <div className="chat-panel-head">
                <span>聊天记录</span>
                <button className="btn small ghost" onClick={() => setChatOpen(false)}>
                  收起
                </button>
              </div>
              <div className="chat-panel-log" ref={chatPanelLogRef}>
                {chatLog.length === 0 && <div className="msg sys">还没有消息。</div>}
                {chatLog.map((m, i) => (
                  <div className="msg" key={i}>
                    <b>{m.name}</b>
                    {m.text}
                  </div>
                ))}
              </div>
              {/*
                观战者**没有输入框** —— 只能发快捷聊天（服务端也拒收打字消息）。
              */}
              {isSpectator ? (
                <div className="chat-spectator-note">观战只能发快捷聊天，不能打字</div>
              ) : (
                <div className="chat-panel-foot">
                  <input
                    className="input"
                    value={chatText}
                    maxLength={200}
                    placeholder="说点什么…"
                    onChange={(e) => setChatText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') sendChat();
                    }}
                  />
                  <button className="btn small primary" onClick={sendChat}>
                    发送
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {/*
          棋谱（**窄屏专用**）—— 底部浮层，跟聊天弹层同一套。

          宽屏不需要它：宽屏棋谱是左栏常驻的记谱卡（`.notation-card`），
          不压棋盘、不遮聊天。窄屏左栏是顶部一整条，常驻卡会把棋盘挤没，
          所以窄屏才退回到浮层 —— 这跟聊天弹层是同一个理由。
        */}
        {isNarrow && notationSheetOpen && (
          <div className="overlay notation-overlay" onClick={() => setNotationSheetOpen(false)}>
            <div className="notation-panel" onClick={(e) => e.stopPropagation()}>
              <div className="notation-head">
                <span>棋谱</span>
                <button className="btn small ghost" onClick={() => setNotationSheetOpen(false)}>
                  收起
                </button>
              </div>
              <NotationRows rows={notation} />
              <div className="notation-foot">
                <button
                  className="btn small primary"
                  style={{ flex: 1 }}
                  onClick={copyPgn}
                  disabled={roomState.moves.length === 0}
                >
                  复制 PGN
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 设置弹窗（顶栏齿轮点开） */}
        <SettingsDialog
          open={settingsOpen}
          settings={settings}
          onChange={updateSettings}
          uiPrefs={uiPrefs}
          onUiPrefsChange={updateUiPrefs}
          onClose={() => setSettingsOpen(false)}
        />

        {/* 私信面板（和大厅共用一套） */}
        <DirectMessagePanel
          open={dmOpen}
          onClose={() => setDmOpen(false)}
          peer={dmPeer}
          onSelectPeer={setDmPeer}
        />

        {/*
          右侧浮层提示（认输确认 / 求和 / 悔棋）。

          `position: fixed` —— **不占文档流**，所以它既不会把棋盘往下顶，
          也不会因为多出一条提示文字就把页面撑出滚动条。
        */}
        <div className="side-prompts">
          {prompts.map((p) => (
            <SidePrompt key={p.id} {...p} />
          ))}
        </div>
      </main>

    </div>
  );
}
