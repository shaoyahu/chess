'use client';

/**
 * 「私信」面板 —— 大厅与对局页**共用同一套**。
 *
 * 为什么共用：收到私信的人可能在大厅、也可能在棋盘上，
 * 两边都要能翻出历史、都能回复 —— 同一件事不做两份。
 *
 * 形态（用户拍板）：
 *   - 消息落地成**私信记录**（有历史），不是一次性提示；
 *   - 入口在**顶栏**（「私信」按钮 + 未读角标）；
 *   - 收信时**弹一条提示**（ToastHost 统一管），让人知道有人找自己。
 *
 * 面板是单列两态：
 *   - **会话列表**：有过往来的人各一行（名字 + 最后一条 + 时间）；
 *   - **某个对话**：消息记录 + 快捷聊天按钮。
 * 从顶栏「在线 N」名单里点某人进来时，直接落在第二个态
 * （左键点、右键菜单点，都是同一个出口）。
 *
 * **私信不能自己打字**（用户拍板）：底部只有几颗快捷短语，
 * 选一句发出去。短语表在 `DM_QUICK_CHATS`（客户端和服务端同源）——
 * 服务端按同一份名单校验，所以这条规矩不是只做在 UI 上。
 *
 * **房间邀请**是私信的第二种形态（用户拍板）：
 *   - 我在房间里时，底部多一颗「邀请来这局 · 房间码」按钮；
 *   - 发出去的是一条**带房间码的消息**，渲染成**可点的卡片**，
 *     对方点一下直接进房（不用复制房间码、也不用回大厅）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Swords, X } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { DM_MAX_UNANSWERED, DM_QUICK_CHATS, DM_SEND_MIN_INTERVAL_MS } from '@/lib/constants';
import type { DirectMessage } from '@/lib/types';

/** 一个对话对象 */
export interface DmPeer {
  userId: string;
  name: string;
}

/**
 * 客户端的冷却时长 —— **比服务端多等 200ms**。
 *
 * 为什么要多等这一点：服务端的计时是从「**收到**」那一刻起算的，
 * 而客户端是从「**发出**」那一刻起算的 —— 中间隔着网络，
 * 服务端那边的窗口比客户端的**晚**结束几十毫秒。
 * 两边用同一个数，边界上就会出现「按钮刚亮就发 → 被服务端拒」的尴尬。
 */
const CLIENT_COOLDOWN_MS = DM_SEND_MIN_INTERVAL_MS + 200;

interface DirectMessagePanelProps {
  open: boolean;
  onClose: () => void;
  /** 当前对话对象；null = 展示会话列表 */
  peer: DmPeer | null;
  onSelectPeer: (peer: DmPeer | null) => void;
}

interface Conversation extends DmPeer {
  last: DirectMessage;
}

export function DirectMessagePanel({ open, onClose, peer, onSelectPeer }: DirectMessagePanelProps) {
  const {
    dms,
    dmUnread,
    dmRemaining,
    session,
    room,
    sendDm,
    sendDmInvite,
    markDmRead,
    joinRoom,
    leaveRoom,
  } = useSocket();
  const router = useRouter();
  const logRef = useRef<HTMLDivElement>(null);
  const myId = session?.userId ?? '';
  /**
   * 要加入的房间码 —— 已经点了邀请、但**正在另一局里**，等着二次确认。
   *
   * 为什么要有确认：离开一局 = 判负（对方直接获胜）。
   * 点一下别人的邀请就静默把当前这局判掉，是不可接受的。
   */
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);

  /**
   * **发送冷却** —— 挡住「按住快捷短语连点」的私信轰炸。
   *
   * 为什么要冷一把：私信每发一条，**对面**就会弹一条提示。
   * 不限频的话，对面的顶栏会被糊成**一整列提示条**（用户反馈）。
   *
   * 冷却按钮 + 服务端限频是**两层**：
   *   - 这一层（按钮变灰、按不动）是给手快的**自己**看的 ——
   *     按不动，就不会以为「我按了怎么没发出去」；
   *   - 服务端那层（`DM_SEND_MIN_INTERVAL_MS`）才是规则本身。
   *
   * **不写任何提示文字**：按钮灰了就是「现在发不了」，
   * 再补一句「冷却 N 秒」是**多此一举**——
   * 用户要的是「按不动」，不是「读一句话再知道按不动」。
   *
   * 快捷短语和房间邀请**共用一个冷却** —— 它们在对方面板上长得一样，
   * 分成两个就等于留了一条绕路（用邀请刷屏）。
   */
  const [cooldownUntil, setCooldownUntil] = useState(0);

  /** 冷却中（按钮按不动） */
  const cooling = cooldownUntil > 0;

  /*
   * **互惠限流**：连着发满 3 条之后，必须等**对方回一条**才能继续。
   *
   * 这份额度是**服务端推来的**（`dm.state`）—— 客户端不自己数。
   * 表里没有这个人 = 额度是满的（默认能发）。
   */
  const remaining = peer ? (dmRemaining[peer.userId] ?? DM_MAX_UNANSWERED) : DM_MAX_UNANSWERED;
  /** 被锁住了：按钮按不动 */
  const blocked = remaining <= 0;

  /*
   * 冷却结束就把状态清掉（按钮恢复可点）。
   *
   * 用一个 **setTimeout** 而不是轮询时钟：
   * 页面上**不显示倒计时**，所以根本不需要「每秒刷新一次剩下的秒数」——
   * 轮询是给一个没人看的数字做的功。
   */
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const timer = window.setTimeout(
      () => setCooldownUntil(0),
      Math.max(0, cooldownUntil - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [cooldownUntil]);

  /*
   * 打开面板 = 看过未读了。
   *
   * 依赖里要带上 `dmUnread`：面板**开着**的时候来了新消息，
   * 未读数照样 +1 —— 但这会儿人正看着它，
   * 角标却还挂在顶栏按钮上（看着像「还没看」）。
   * 所以未读数一变就再跑一次，把这个错位抹平。
   */
  useEffect(() => {
    if (open && dmUnread > 0) markDmRead();
  }, [open, dmUnread, markDmRead]);

  /*
   * 会话列表：按「对方」分组，最近说话的排前面。
   *
   * 注意 `toName` —— 对方发来的消息里只有 `fromName`，
   * 没有对方的名字；要显示「我跟谁聊过」，必须让**发送方**那条也带上收件人名字。
   */
  const conversations = useMemo<Conversation[]>(() => {
    const map = new Map<string, Conversation>();
    for (const m of dms) {
      const mine = m.from === myId;
      const peerId = mine ? m.to : m.from;
      const name = mine ? m.toName : m.fromName;
      map.set(peerId, { userId: peerId, name, last: m });
    }
    return [...map.values()].sort((a, b) => b.last.at - a.last.at);
  }, [dms, myId]);

  /** 当前对话的消息（按时间序） */
  const thread = useMemo(
    () => dms.filter((m) => (m.from === myId ? m.to : m.from) === peer?.userId),
    [dms, myId, peer?.userId],
  );

  // 新消息进来滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length, peer?.userId, open]);

  /**
   * **我能邀请的房间** —— 有座位、而且对面不是电脑。
   *
   * 判据与服务端 `handleDmInvite` 完全一致：
   *  - `role === 'player'`：我在这局里（待抽签的玩家也算）；
   *  - 没有 AI 座位：人机局没有「对手」可抢，邀请进来只能当观众。
   *
   * 两处必须一致 —— UI 上给得出、服务端却拒收，就是骗人。
   */
  const inviteRoom = useMemo(() => {
    if (!room || room.role !== 'player') return null;
    const { w, b } = room.state.seats;
    if (w?.isAI || b?.isAI) return null;
    return room.state;
  }, [room]);

  if (!open) return null;

  /** 发一条快捷私信（没有输入框，只能挑一句） */
  const sendQuick = (body: string): void => {
    if (!peer) return;
    /* 冷却中：直接不发（按钮已经是灰的，这里是第二道保险） */
    if (Date.now() < cooldownUntil) return;
    /* 被锁住：对方还没回消息，发了也会被服务端拒（这里同样不费那个请求） */
    if (blocked) return;
    sendDm(peer.userId, body);
    setCooldownUntil(Date.now() + CLIENT_COOLDOWN_MS);
  };

  /** 把当前房间的邀请发给对方 */
  const sendInvite = (): void => {
    if (!peer || !inviteRoom) return;
    if (Date.now() < cooldownUntil) return;
    /* 邀请和私信共用一个额度桶 */
    if (blocked) return;
    sendDmInvite(peer.userId, inviteRoom.code);
    setCooldownUntil(Date.now() + CLIENT_COOLDOWN_MS);
  };

  /** 真正加入一个房间（离开当前房间 → 加入 → 跳转） */
  const doJoin = (code: string): void => {
    setPendingJoin(null);
    const current = room?.state.code;
    if (current && current !== code) {
      /*
       * 离开当前房间 = 判负 —— 这是有代价的，所以上面先问过一次。
       * 代价照算，不替玩家抹平（也不偷偷加一条「温和」的例外路径）。
       */
      leaveRoom();
    }
    joinRoom(code, 'play');
    onClose();
    router.push(`/room/${code}`);
  };

  /** 点邀请卡片：不在别的局里就直接进，在别的局里先确认 */
  const joinInvite = (code: string): void => {
    const current = room?.state.code;
    if (current === code) {
      // 已经在这局里了 —— 不用再进一次
      onClose();
      return;
    }
    if (current) {
      setPendingJoin(code);
      return;
    }
    doJoin(code);
  };

  return (
    <>
      <div className="dm-overlay" onClick={onClose} aria-hidden="true" />
      <aside className="dm-panel" role="dialog" aria-label="私信">
        <div className="dm-head">
          {peer ? (
            <button
              className="btn small ghost dm-back"
              onClick={() => onSelectPeer(null)}
              title="回到会话列表"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              会话
            </button>
          ) : (
            <span className="dm-title">私信</span>
          )}
          {peer && <span className="dm-title">{peer.name}</span>}
          <button className="btn small ghost dm-close" onClick={onClose} aria-label="关闭私信">
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        {peer ? (
          <>
            <div className="dm-log" ref={logRef}>
              {thread.length === 0 && <div className="msg sys">还没有消息。</div>}
              {thread.map((m) => {
                const mine = m.from === myId;
                const isInvite = m.kind === 'invite' && Boolean(m.roomCode);
                return (
                  <div className={`dm-msg ${mine ? 'me' : 'them'}`} key={m.id}>
                    <span className="dm-msg-name">{mine ? '我' : m.fromName}</span>
                    {isInvite ? (
                      /*
                       * 邀请 = **可点的卡片**，不是一句话。
                       *
                       * 对方点一下就进房 —— 不用复制房间码、也不用回大厅。
                       */
                      <button
                        className="dm-invite-card"
                        onClick={() => joinInvite(m.roomCode!)}
                        title={`加入房间 ${m.roomCode}`}
                      >
                        <span className="dm-invite-code">{m.roomCode}</span>
                        <span className="dm-invite-act">加入房间</span>
                      </button>
                    ) : (
                      <span className="dm-msg-text">{m.text}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {/*
              底部只有快捷短语，**没有输入框**（用户拍板：私信不能自己打字）。
              短语表和房间里的**不是一套** —— 房间里说的是「这盘棋的事」，
              这里说的是「要不要一起下一盘」。
            */}
            <div className="dm-foot">
              {/*
                房间邀请按钮 —— **只在我在这局里时**出现。
                没有房间可邀请时不占地方（不写一句「先建房再来邀请」）。
              */}
              {inviteRoom && (
                <button
                  className="btn small dm-invite-send"
                  onClick={sendInvite}
                  disabled={cooling || blocked}
                >
                  <Swords size={14} aria-hidden="true" />
                  邀请来这局 · {inviteRoom.code}
                </button>
              )}
              {/*
                跨房间的二次确认：离开当前对局 = 判负，
                所以代价要先摆在眼前（与「认输 / 离开」的二次确认同一套规矩）。
              */}
              {pendingJoin && (
                <div className="dm-confirm" role="alertdialog" aria-label="确认离开当前对局">
                  <span className="dm-confirm-text">
                    离开当前对局（会判你输）并加入 {pendingJoin}？
                  </span>
                  <div className="dm-confirm-actions">
                    <button className="btn small ghost" onClick={() => setPendingJoin(null)}>
                      取消
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => doJoin(pendingJoin)}
                    >
                      离开并加入
                    </button>
                  </div>
                </div>
              )}
              <div className="dm-quick">
                {DM_QUICK_CHATS.map((t) => (
                  <button
                    key={t}
                    className="rail-quick-btn"
                    onClick={() => sendQuick(t)}
                    disabled={cooling || blocked}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="dm-list">
            {conversations.length === 0 && <div className="msg sys">还没有私信。</div>}
            {conversations.map((c) => (
              <button
                className="dm-conv"
                key={c.userId}
                onClick={() => onSelectPeer({ userId: c.userId, name: c.name })}
              >
                <span className="dm-conv-name">{c.name}</span>
                <span className="dm-conv-last">
                  {c.last.kind === 'invite' && c.last.roomCode
                    ? `邀请你下棋 · 房间 ${c.last.roomCode}`
                    : `${c.last.from === myId ? '我：' : ''}${c.last.text}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
