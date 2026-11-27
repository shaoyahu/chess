'use client';

/**
 * 大厅 —— 登录 / 开局 / 房间列表。
 *
 * 布局是「工作台」形态（不是落地页）：左「开始一局」右「正在进行的对局」，
 * 一屏能干活，不用滚动。
 *
 * 「开始一局」这块是**四种开局方式**（用户拍板）：
 *   快速匹配 / 人机对弈 / 创建房间 / 加入房间。
 * 点开任意一种，下面那块变成对应的表单（返回 + 字段 + 确定）——
 * 每种方式要的东西不一样，摊在一张卡上只会让人以为「选了时间就能加别人的房」。
 *
 * **页面上不写解释性文字**（用户 2026-11-12 拍板）：
 *   说明一旦印在界面上，界面就等于没设计好。所以：
 *   - 四种开局方式靠**图标 + 名字**自解释，没选时不占地方、不放提示句；
 *   - 「怎么发消息」靠**名单行尾那枚气泡按钮**自解释，不靠一句「右键某人 →」；
 *   - 登录卡片只留「用户名 + 进入大厅」，没有开场白。
 *
 * 视觉规范见 docs/design.md；这里只管结构。
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Castle,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Eye,
  GraduationCap,
  KeyRound,
  LogIn,
  Plus,
  Settings,
  Zap,
} from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { useSettings } from '@/hooks/useSettings';
import { SettingsDialog } from '@/components/SettingsDialog';
import { DmButton } from '@/components/DmButton';
import { OnlineUsersMenu } from '@/components/OnlineUsersMenu';
import { DirectMessagePanel, type DmPeer } from '@/components/DirectMessagePanel';
import { Picker, type PickerOption } from '@/components/Picker';
import { MATCH_TIME_ANY, TIME_CONTROLS, type TimeControlKey } from '@/lib/constants';
import {
  DIFFICULTY_LABEL,
  DEFAULT_DIFFICULTY,
  type Color,
  type Difficulty,
  type RoomVisibility,
} from '@/lib/types';

/** 开局方式 */
type LobbyMode = 'menu' | 'quick' | 'ai' | 'create' | 'join';

/** 时限选项（不含「任意」） */
const TIME_OPTIONS: PickerOption<TimeControlKey>[] = Object.entries(TIME_CONTROLS).map(
  ([value, cfg]) => ({ value: value as TimeControlKey, label: cfg.label }),
);

/** 快速匹配的时限选项：多一个「任意」（愿意跟任何时限的人配对） */
const QUICK_TIME_OPTIONS: PickerOption<TimeControlKey | typeof MATCH_TIME_ANY>[] = [
  ...TIME_OPTIONS,
  { value: MATCH_TIME_ANY, label: '任意' },
];

const DIFFICULTY_OPTIONS: PickerOption<Difficulty>[] = [
  { value: 'easy', label: DIFFICULTY_LABEL.easy, hint: '随手练练' },
  { value: 'normal', label: DIFFICULTY_LABEL.normal, hint: '正常对局' },
  { value: 'hard', label: DIFFICULTY_LABEL.hard, hint: '全力以赴' },
];

/**
 * 人机对战时**玩家执什么颜色**。
 *
 * `'random'` = 服务端抽签（各 50%）。
 * 注意：**不提前显示抽签结果** —— 结果要在对局里才揭晓（见 PLAN 的 AB 段）。
 */
const AI_COLOR_OPTIONS: PickerOption<'random' | Color>[] = [
  { value: 'random', label: '随机', hint: '开局抽签' },
  { value: 'w', label: '我执白', hint: '白方先走' },
  { value: 'b', label: '我执黑', hint: '黑方后走' },
];

const VISIBILITY_OPTIONS: PickerOption<RoomVisibility>[] = [
  { value: 'public', label: '公开', hint: '列表里可见' },
  { value: 'invite', label: '邀请', hint: '只认房间码' },
];

export default function LobbyPage() {
  const { session, lobby, room, connected, status, send, joinRoom, login, pushToast, dmUnread } =
    useSocket();
  const { settings, uiPrefs, updateSettings, updateUiPrefs } = useSettings();
  const queued = Boolean(session && lobby.queuedUserIds.includes(session.userId));
  const router = useRouter();
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  /**
   * 房间码的**字段级**校验错误 —— 常驻显示在输入框下面。
   *
   * 原来这里弹的是全局 toast：toast 挂在根布局上、状态在模块级单例里，
   * 于是这条「房间码为 4 位字符」会跟着用户一起飘到对局页右上角，
   * 正好压在棋盘上方。表单校验错在哪一行，就该在那一行说清楚。
   */
  const [roomCodeError, setRoomCodeError] = useState<string | null>(null);
  /** 当前打开的开局方式 */
  const [mode, setMode] = useState<LobbyMode>('menu');
  /** 快速匹配期望的时限（'any' = 任意） */
  const [quickTime, setQuickTime] = useState<TimeControlKey | typeof MATCH_TIME_ANY>(MATCH_TIME_ANY);
  /** 人机 / 创建房间用的时限 */
  const [timeControl, setTimeControl] = useState<TimeControlKey>('10+0');
  /** AI 难度 */
  const [difficulty, setDifficulty] = useState<Difficulty>(DEFAULT_DIFFICULTY);
  /** 人机对战时玩家执什么颜色（`'random'` = 服务端抽签） */
  const [aiColor, setAiColor] = useState<'random' | Color>('random');
  /** 房间类型 */
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 私信面板开着没有 */
  const [dmOpen, setDmOpen] = useState(false);
  /** 私信面板当前对话对象（null = 展示会话列表） */
  const [dmPeer, setDmPeer] = useState<DmPeer | null>(null);

  // 记住上次使用的用户名
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('lan-chess.name');
      if (saved) setName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * 一旦拿到**新的**房间快照就跳转到对局页。
   *
   * 只在房间码「发生了变化」时跳转：如果玩家是对局页点「离开」回到大厅的，
   * socket 里可能还残留着上一个房间的快照（服务端要等下一条广播才会更新），
   * 这里若无条件跳转，玩家刚离开就会被立刻弹回对局页。
   */
  const roomCodeAtMount = useRef<string | null>(null);
  useEffect(() => {
    if (roomCodeAtMount.current === null) {
      roomCodeAtMount.current = room?.state.code ?? '';
      return;
    }
    const code = room?.state.code;
    if (code && code !== roomCodeAtMount.current) {
      router.push(`/room/${code}`);
    }
  }, [room?.state.code, router]);

  const handleLogin = (): void => {
    if (!name.trim()) {
      pushToast('error', '请输入用户名');
      return;
    }
    /*
     * **服务器连不上时，点了必须给反馈。**
     *
     * 原症状（2026-11-27，服务器僵死）：点「进入大厅」毫无反应 ——
     * 因为浏览器把 socket 永远挂在 CONNECTING，登录逻辑在等 onopen，
     * 于是这一次点击**什么都没有发生**，玩家只能反复点、以为是自己坏了。
     *
     * 现在：身份照样记下（服务器一恢复就自动进大厅，不用再点一次），
     * 同时明确告诉玩家「连不上服务器」—— 这是**状态**，不是解释文字。
     */
    if (status === 'failed') {
      pushToast('error', '连不上服务器，正在重连');
    }
    login(name);
  };

  /**
   * 换开局方式。
   *
   * 匹配队列是**「快速匹配」这一种方式**的一部分 ——
   * **离开这块面板 = 放弃这次匹配**，所以先把队列退了。
   * （否则人在「创建房间」面板上等着，突然被匹配进别人的局；
   *  或者回到菜单还挂在后台排着队，自己都看不出来。）
   */
  const selectMode = (target: LobbyMode): void => {
    // 再点一次当前这一种 = 退回菜单
    const next = mode === target ? 'menu' : target;
    if (mode === 'quick' && next !== 'quick' && queued) {
      send({ t: 'queue.leave' });
    }
    setMode(next);
  };

  /** 匹配中：把队列退掉，面板回到可再次发起的状态 */
  const cancelQueue = (): void => {
    send({ t: 'queue.leave' });
  };

  const startQuickMatch = (): void => {
    if (!session) {
      pushToast('error', '请先输入用户名');
      return;
    }
    send({
      t: 'queue.join',
      timeControl: quickTime === MATCH_TIME_ANY ? MATCH_TIME_ANY : quickTime,
    });
  };

  const startVsAI = (): void => {
    if (!session) {
      pushToast('error', '请先输入用户名');
      return;
    }
    send({ t: 'room.create', timeControl, withAI: true, difficulty, color: aiColor });
  };

  const startCreateRoom = (): void => {
    if (!session) {
      pushToast('error', '请先输入用户名');
      return;
    }
    send({ t: 'room.create', timeControl, visibility });
  };

  const startJoin = (): void => {
    const code = roomCode.trim().toUpperCase();
    if (code.length !== 4) {
      setRoomCodeError('房间码为 4 位字符');
      return;
    }
    setRoomCodeError(null);
    if (!session) {
      pushToast('error', '请先输入用户名');
      return;
    }
    // 走 joinRoom：有座位凭证就认领回原座位，没有才普通加入
    joinRoom(code, 'play');
  };

  /** 从房间列表直接进：公开房可以直接入座，邀请房只能观战 */
  const enterRoom = (code: string, mode: 'play' | 'spectate'): void => {
    if (!session) {
      pushToast('error', '请先输入用户名');
      return;
    }
    joinRoom(code, mode);
  };

  /** 当前面板的「确定」按钮 */
  const confirm = (): void => {
    if (mode === 'quick') startQuickMatch();
    else if (mode === 'ai') startVsAI();
    else if (mode === 'create') startCreateRoom();
    else if (mode === 'join') startJoin();
  };

  /** 匹配中的状态读数：队列里几个人 + 当前选的时限（**是状态，不是说明书**） */
  const queueHint =
    quickTime === MATCH_TIME_ANY
      ? '时限 任意'
      : `时限 ${TIME_CONTROLS[quickTime].label}`;

  return (
    <div className="page">
      <header className="topbar container">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <Castle size={17} />
          </span>
          <span className="brand-text">
            <span>局域网国际象棋</span>
            <small>LAN Chess</small>
          </span>
        </div>
        <div className="topbar-actions">
          {/*
            「已连接 · 在线 N」是个**按钮**：点开就是在线的人。
            数字与名单长度永远一致（服务端同源计算）—— 对不上就是骗人。
          */}
          <OnlineUsersMenu
            connected={connected}
            status={status}
            online={lobby.online}
            users={lobby.onlineUsers}
            selfId={session?.userId}
            onMessage={(peer) => {
              setDmPeer(peer);
              setDmOpen(true);
            }}
          />
          <DmButton unread={dmUnread} onClick={() => setDmOpen(true)} />
          <button
            className="btn small ghost icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="设置"
          >
            <Settings size={19} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="container" style={{ paddingBottom: 48, flex: 1 }}>
        {!session ? (
          <div className="card" style={{ maxWidth: 440, margin: '40px auto' }}>
            <div className="section-head">
              <div className="section-title">
                <span className="eyebrow">Welcome</span>
                <span className="zh">取个名字，加入棋局</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="username">用户名</label>
              <input
                id="username"
                className="input"
                value={name}
                maxLength={20}
                placeholder="例如：球球"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLogin();
                }}
              />
            </div>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={handleLogin}>
                <LogIn size={15} aria-hidden="true" />
                进入大厅
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="lobby-grid">
              {/* ---------- 开始一局 ---------- */}
              <div className="card">
                <div className="section-head">
                  <div className="section-title">
                    <span className="eyebrow">New Game</span>
                    <span className="zh">开始一局</span>
                  </div>
                  <span className="section-meta">你好，{session.name}</span>
                </div>

                {/* 四个开局方式 */}
                <div className="mode-bar">
                  <button
                    className={`btn${mode === 'quick' ? ' active' : ''}`}
                    onClick={() => selectMode('quick')}
                    aria-pressed={mode === 'quick'}
                  >
                    <Zap size={15} aria-hidden="true" />
                    快速匹配
                  </button>
                  <button
                    className={`btn${mode === 'ai' ? ' active' : ''}`}
                    onClick={() => selectMode('ai')}
                    aria-pressed={mode === 'ai'}
                  >
                    <Cpu size={15} aria-hidden="true" />
                    人机对弈
                  </button>
                  <button
                    className={`btn${mode === 'create' ? ' active' : ''}`}
                    onClick={() => selectMode('create')}
                    aria-pressed={mode === 'create'}
                  >
                    <Plus size={15} aria-hidden="true" />
                    创建房间
                  </button>
                  <button
                    className={`btn${mode === 'join' ? ' active' : ''}`}
                    onClick={() => selectMode('join')}
                    aria-pressed={mode === 'join'}
                  >
                    <KeyRound size={15} aria-hidden="true" />
                    加入房间
                  </button>
                </div>

                {/* 当前方式的面板（没选方式时**不占地方** —— 四枚按钮自己就是说明） */}
                {mode !== 'menu' && (
                  <div className="mode-panel">
                    {mode === 'quick' &&
                      (queued ? (
                        <div className="queue-state">
                          <div className="queue-title">匹配中…</div>
                          <div className="queue-meta">
                            队列 {lobby.queueSize} 人 · {queueHint}
                          </div>
                        </div>
                      ) : (
                        <div className="mode-fields">
                          <div className="field">
                            <label htmlFor="quick-tc">时限</label>
                            <Picker
                              id="quick-tc"
                              value={quickTime}
                              options={QUICK_TIME_OPTIONS}
                              onChange={setQuickTime}
                              ariaLabel="快速匹配时限"
                            />
                          </div>
                        </div>
                      ))}

                    {mode === 'ai' && (
                      <div className="mode-fields">
                        <div className="field">
                          <label htmlFor="ai-tc">时限</label>
                          <Picker
                            id="ai-tc"
                            value={timeControl}
                            options={TIME_OPTIONS}
                            onChange={setTimeControl}
                            ariaLabel="人机对弈时限"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="ai-diff">难度</label>
                          <Picker
                            id="ai-diff"
                            value={difficulty}
                            options={DIFFICULTY_OPTIONS}
                            onChange={setDifficulty}
                            ariaLabel="电脑难度"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="ai-color">执子</label>
                          <Picker
                            id="ai-color"
                            value={aiColor}
                            options={AI_COLOR_OPTIONS}
                            onChange={setAiColor}
                            ariaLabel="你执什么颜色"
                          />
                        </div>
                      </div>
                    )}

                    {mode === 'create' && (
                      <div className="mode-fields">
                        <div className="field">
                          <label htmlFor="create-tc">时限</label>
                          <Picker
                            id="create-tc"
                            value={timeControl}
                            options={TIME_OPTIONS}
                            onChange={setTimeControl}
                            ariaLabel="房间时限"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="create-vis">房间类型</label>
                          <Picker
                            id="create-vis"
                            value={visibility}
                            options={VISIBILITY_OPTIONS}
                            onChange={setVisibility}
                            ariaLabel="房间类型"
                          />
                        </div>
                      </div>
                    )}

                    {mode === 'join' && (
                      <div className="mode-fields">
                        <div className="field">
                          <label htmlFor="roomcode">房间码</label>
                          <input
                            id="roomcode"
                            className="input"
                            value={roomCode}
                            maxLength={4}
                            placeholder="4 位"
                            aria-invalid={roomCodeError ? true : undefined}
                            aria-describedby={roomCodeError ? 'roomcode-error' : undefined}
                            style={{ width: 130, letterSpacing: 3 }}
                            onChange={(e) => {
                              setRoomCode(e.target.value.toUpperCase());
                              // 边改边把错误撤掉：用户已经在纠正了，不用再提醒他错在哪
                              if (roomCodeError) setRoomCodeError(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') startJoin();
                            }}
                          />
                          {roomCodeError && (
                            <span className="field-error" id="roomcode-error" role="alert">
                              {roomCodeError}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mode-actions">
                      <button className="btn ghost" onClick={() => selectMode('menu')}>
                        <ChevronLeft size={15} aria-hidden="true" />
                        返回
                      </button>
                      {mode === 'quick' && queued ? (
                        <button className="btn" onClick={cancelQueue}>
                          取消匹配
                        </button>
                      ) : (
                        <button className="btn primary" onClick={confirm}>
                          确定
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ---------- 房间列表 ---------- */}
              <div className="card">
                <div className="section-head">
                  <div className="section-title">
                    <span className="eyebrow">Rooms</span>
                    <span className="zh">正在进行的对局</span>
                  </div>
                  <span className="section-meta">{lobby.rooms.length} 局</span>
                </div>
                <div className="room-list">
                  {lobby.rooms.length === 0 ? (
                    <div className="empty">暂无对局</div>
                  ) : (
                    lobby.rooms.map((room) => {
                      const invite = room.visibility === 'invite';
                      const names = [room.whiteName, room.blackName].filter(
                        (n): n is string => Boolean(n),
                      );
                      const statusText =
                        room.status === 'playing'
                          ? room.playerOnline
                            ? '进行中'
                            : '等待重连'
                          : room.status === 'finished'
                            ? '已结束'
                            : room.status === 'preparing'
                              ? '准备中'
                              : '等待对手';
                      return (
                        <div className="room-row" key={room.code}>
                          <div className="room-main">
                            <div className="room-who">
                              {names.length === 2 ? (
                                <>
                                  <span className="who-name">{names[0]}</span>
                                  <span className="who-vs">VS</span>
                                  <span className="who-name">{names[1]}</span>
                                </>
                              ) : (
                                /*
                                 * 只显示一个名字 —— 要么是待抽签的那位（黑白还没定），
                                 * 要么就是真的空房间。
                                 */
                                <span className="who-name">{names[0] ?? room.pendingName ?? '空房间'}</span>
                              )}
                            </div>
                            <div className="room-meta">
                              <span className={`room-tag${invite ? ' invite' : ''}`}>
                                {invite ? '邀请' : '公开'}
                              </span>
                              <span>{TIME_CONTROLS[room.timeControl]?.label ?? '不限时'}</span>
                              <span>{statusText}</span>
                              {room.spectatorCount > 0 && (
                                <span>{room.spectatorCount} 人观战</span>
                              )}
                              {/* 邀请房的房间码不对外展示 */}
                              {!invite && <span className="room-code">{room.code}</span>}
                            </div>
                          </div>
                          <div className="room-actions">
                            {!invite && (
                              <button
                                className="btn small primary"
                                onClick={() => enterRoom(room.code, 'play')}
                              >
                                加入
                              </button>
                            )}
                            <button
                              className="btn small ghost"
                              onClick={() => enterRoom(room.code, 'spectate')}
                            >
                              <Eye size={14} aria-hidden="true" />
                              观战
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/*
              「教学练习」入口 —— **单独一行**，不塞进上面那四种开局方式里。
              那四枚按钮点开的是「开一局棋」的表单，
              教学练习是**另一个页面**（看开局课 / 自己摆残局下），
              混在同一排里会让人以为点它会开一局新对局。
            */}
            <button className="entry-row" onClick={() => router.push('/practice')}>
              <span className="entry-row-mark" aria-hidden="true">
                <GraduationCap size={18} />
              </span>
              <span className="entry-row-label">教学练习</span>
              <ChevronRight className="entry-row-arrow" size={18} aria-hidden="true" />
            </button>
          </>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        uiPrefs={uiPrefs}
        onChange={updateSettings}
        onUiPrefsChange={updateUiPrefs}
        onClose={() => setSettingsOpen(false)}
      />

      <DirectMessagePanel
        open={dmOpen}
        onClose={() => setDmOpen(false)}
        peer={dmPeer}
        onSelectPeer={setDmPeer}
      />
    </div>
  );
}
