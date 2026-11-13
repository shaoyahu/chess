'use client';

/**
 * **教学练习页** —— /practice
 *
 * 两个分区（顶部的两枚按钮切换）：
 *
 *  1. **教学**：一课一条演示线，每手配一句讲解；还能切到「典型摆法」看这一课
 *     推荐的布局（这才是「教你如何摆伦敦开局」的那一半）。
 *  2. **自由练习**：不限时。自己摆好双方棋子 → 点「开始练习」→ 自己扮演双方对弈。
 *
 * 两条原则贯穿全页：
 *
 *  - **页面上不写解释性文字**（用户 2026-11-12 拍板）：
 *    教学里的讲解文字是**课程内容**，不是「教你点哪里」；
 *    交互本身靠图标与结构自解释，不加「点击棋子可以移动」这类说明。
 *  - **棋盘是唯一的裁判**：走法合法性、终局判定都交给 chess.js，
 *    页面不自己另立一套规则。
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  Castle,
  ChevronLeft,
  ChevronRight,
  Eraser,
  FlipHorizontal2,
  Grid2x2,
  RotateCcw,
  Settings,
  Trash2,
} from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { useSettings } from '@/hooks/useSettings';
import { SettingsDialog } from '@/components/SettingsDialog';
import { DmButton } from '@/components/DmButton';
import { OnlineUsersMenu } from '@/components/OnlineUsersMenu';
import { DirectMessagePanel, type DmPeer } from '@/components/DirectMessagePanel';
import { Picker, type PickerOption } from '@/components/Picker';
import { PieceGlyph } from '@/components/PieceGlyph';
import { Board2D } from '@/components/Board2D';
import { SetupBoard } from '@/components/SetupBoard';
import { useBoardInteraction, type BoardInteraction } from '@/hooks/useBoardInteraction';
import { getBoardTheme } from '@/lib/board-themes';
import { START_FEN } from '@/lib/constants';
import { pieceAt, statusOf } from '@/lib/chess-engine';
import { applyFreeMove } from '@/lib/replay';
import type { Color, PieceType } from '@/lib/types';
import {
  LESSONS,
  formationPosition,
  lessonSteps,
  type Lesson,
} from '@/lib/practice/lessons';
import {
  PIECE_LABEL,
  PIECE_TYPES,
  buildPracticeFen,
  placePiece,
  placementFromFen,
  removePiece,
  standardPlacement,
  type Placement,
} from '@/lib/practice/setup';

/** 两个分区 */
type Tab = 'lesson' | 'free';

/** 自由练习的两个阶段 */
type Phase = 'setup' | 'play';

/** 摆棋时手里的「笔」：某色的某个子，或者橡皮 */
type Brush = { kind: 'piece'; type: PieceType; color: Color } | { kind: 'erase' };

/** 自由练习记下的一手 */
interface PracticeStep {
  san: string;
  color: Color;
  from: string;
  to: string;
}

/** 先走方 */
const TURN_OPTIONS: PickerOption<Color>[] = [
  { value: 'w', label: '白方先行' },
  { value: 'b', label: '黑方先行' },
];

/**
 * 教学棋盘是**只读**的 —— 它没有「走子」语义，只展示局面。
 * 所以这里给一份「什么都不做」的交互对象，而不是给 Board2D 加一个只读开关。
 */
const READ_ONLY_INTERACTION: BoardInteraction = {
  orientation: 'w',
  selected: null,
  targets: [],
  targetMap: new Map(),
  canMoveSelected: false,
  onSquareClick: () => {},
  clearSelection: () => {},
  isMyTurn: false,
  myColor: undefined,
  pendingPromotion: null,
  choosePromotion: () => {},
  cancelPromotion: () => {},
  dragFrom: null,
  dragTargets: [],
  dragTargetMap: new Map(),
  canDragFrom: () => false,
  beginDrag: () => false,
  endDrag: () => {},
};

/** 自由练习的终局文案：两个人都是玩家，所以只说「谁被将死」，不说谁赢 */
function practiceResultText(fen: string): string | null {
  const status = statusOf(fen);
  if (!status.over || !status.result) return null;
  const { winner, reason } = status.result;
  if (winner === 'draw') {
    if (reason === 'stalemate') return '逼和 · 僵局';
    if (reason === 'material') return '和棋 · 子力不足';
    if (reason === 'fifty') return '和棋 · 五十回合规则';
    if (reason === 'threefold') return '和棋 · 三次重复局面';
    return '和棋';
  }
  return `${winner === 'w' ? '白方' : '黑方'}被将死`;
}

export default function PracticePage() {
  const { lobby, connected, dmUnread } = useSocket();
  const { settings, uiPrefs, updateSettings, updateUiPrefs } = useSettings();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('lesson');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 私信面板开着没有 */
  const [dmOpen, setDmOpen] = useState(false);
  /** 私信面板当前对话对象（null = 展示会话列表） */
  const [dmPeer, setDmPeer] = useState<DmPeer | null>(null);

  /* ---------------- 教学 ---------------- */
  const [lessonId, setLessonId] = useState<string>(LESSONS[0].id);
  const [stepIndex, setStepIndex] = useState(0);
  /** 看「走法演示」还是看「典型摆法」 */
  const [lessonView, setLessonView] = useState<'moves' | 'formation'>('moves');

  const lesson: Lesson = useMemo(
    () => LESSONS.find((l) => l.id === lessonId) ?? LESSONS[0],
    [lessonId],
  );
  /** 演示线的每一步（含局面与着法来源） */
  const steps = useMemo(() => lessonSteps(lesson), [lesson]);
  /** 「典型摆法」的局面 */
  const formationFen = useMemo(() => formationPosition(lesson), [lesson]);
  /**
   * 棋盘当前该显示的局面。
   *
   * 「典型摆法」时显示**摆法局面**，不是演示线停在哪一步 ——
   * 否则点了「典型摆法」却还是演示的局面，等于没切。
   */
  const boardFen =
    lessonView === 'formation' ? (formationFen ?? lesson.fen) : (steps[Math.min(stepIndex, steps.length - 1)]?.fen ?? lesson.fen);
  /** 当前这一步的着法（第一步没有着法） */
  const currentMove = stepIndex > 0 ? steps[stepIndex] : undefined;

  const selectLesson = useCallback((id: string) => {
    setLessonId(id);
    setStepIndex(0);
    setLessonView('moves');
  }, []);

  /* ---------------- 自由练习 ---------------- */
  const [phase, setPhase] = useState<Phase>('setup');
  const [placement, setPlacement] = useState<Placement>(() => standardPlacement());
  const [brush, setBrush] = useState<Brush>({ kind: 'piece', type: 'p', color: 'w' });
  const [startTurn, setStartTurn] = useState<Color>('w');
  const [setupError, setSetupError] = useState<string | null>(null);
  /** 练习中的局面 */
  const [practiceFen, setPracticeFen] = useState<string>(START_FEN);
  const [practiceSteps, setPracticeSteps] = useState<PracticeStep[]>([]);
  const [flipped, setFlipped] = useState(false);

  const boardTheme = useMemo(() => getBoardTheme(settings.boardTheme), [settings.boardTheme]);

  /** 点一格：放子或拿走 */
  const handleSetupSquare = useCallback(
    (square: string) => {
      setPlacement((current) => {
        if (brush.kind === 'erase') return removePiece(current, square);
        return placePiece(current, square, { type: brush.type, color: brush.color });
      });
      // 摆法一改，之前那条校验错误就不再成立
      setSetupError(null);
    },
    [brush],
  );

  /** 开始练习：摆法 → FEN（先过校验） */
  const startPractice = useCallback(() => {
    const result = buildPracticeFen(placement, startTurn);
    if (result.error || !result.fen) {
      setSetupError(result.error ?? '这个摆法不是合法局面');
      return;
    }
    setSetupError(null);
    setPracticeFen(result.fen);
    setPracticeSteps([]);
    setPhase('play');
  }, [placement, startTurn]);

  /** 走子：双方都能走（与「复盘 · 自由走棋」同一套语义） */
  const handlePracticeMove = useCallback(
    (from: string, to: string, promotion?: PieceType) => {
      const result = applyFreeMove(practiceFen, from, to, promotion);
      if (!result) return;
      setPracticeFen(result.fen);
      setPracticeSteps((prev) => [
        ...prev,
        { san: result.step.san, color: result.step.color, from, to },
      ]);
    },
    [practiceFen],
  );

  const interaction = useBoardInteraction({
    room: null,
    myColor: 'w',
    onMove: handlePracticeMove,
    free: { fen: practiceFen },
  });

  /** 重新摆棋：把现在的局面带回摆棋阶段继续改 */
  const backToSetup = useCallback(() => {
    setPlacement(placementFromFen(practiceFen));
    setSetupError(null);
    setPhase('setup');
  }, [practiceFen]);

  /** 棋谱按「回合号 白着 黑着」分行 */
  const notation = useMemo(() => {
    const rows: Array<{ no: number; white?: string; black?: string }> = [];
    practiceSteps.forEach((step, index) => {
      const no = Math.floor(index / 2) + 1;
      let row = rows[no - 1];
      if (!row) {
        row = { no };
        rows[no - 1] = row;
      }
      if (step.color === 'w') row.white = step.san;
      else row.black = step.san;
    });
    return rows;
  }, [practiceSteps]);

  const lastStep = practiceSteps[practiceSteps.length - 1] ?? null;
  const practiceResult = practiceResultText(practiceFen);
  /** 轮到谁走（自由练习里双方都是玩家，只报个状态） */
  const sideToMove = practiceFen.split(' ')[1] === 'b' ? '黑方' : '白方';
  /** 升变的那枚子是哪一方的 */
  const promotionColor =
    interaction.pendingPromotion
      ? (pieceAt(practiceFen, interaction.pendingPromotion.from)?.color ?? 'w')
      : 'w';

  return (
    <div className="page">
      <header className="topbar container">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <Castle size={17} />
          </span>
          <span className="brand-text">
            <span>教学练习</span>
            <small>Practice</small>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="btn small ghost" onClick={() => router.push('/')}>
            <ChevronLeft size={15} aria-hidden="true" />
            大厅
          </button>
          <OnlineUsersMenu
            connected={connected}
            online={lobby.online}
            users={lobby.onlineUsers}
            selfId={undefined}
            onMessage={(peer) => {
              setDmPeer(peer);
              setDmOpen(true);
            }}
          />
          <DmButton
            unread={dmUnread}
            onClick={() => {
              setDmPeer(null);
              setDmOpen(true);
            }}
          />
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

      <main className="container" style={{ paddingBottom: 40, flex: 1 }}>
        <div className="mode-bar practice-tabs">
          <button
            className={`btn${tab === 'lesson' ? ' active' : ''}`}
            onClick={() => setTab('lesson')}
            aria-pressed={tab === 'lesson'}
          >
            <BookOpen size={15} aria-hidden="true" />
            教学
          </button>
          <button
            className={`btn${tab === 'free' ? ' active' : ''}`}
            onClick={() => setTab('free')}
            aria-pressed={tab === 'free'}
          >
            <Grid2x2 size={15} aria-hidden="true" />
            自由练习
          </button>
        </div>

        {tab === 'lesson' ? (
          /* ================= 教学 ================= */
          <div className="practice-grid tab-lesson">
            {/* 课程列表 */}
            <div className="card practice-col-left">
              <div className="section-head">
                <div className="section-title">
                  <span className="eyebrow">Lessons</span>
                  <span className="zh">课程</span>
                </div>
                <span className="section-meta">{LESSONS.length} 课</span>
              </div>
              <div className="lesson-list">
                {LESSONS.map((item) => (
                  <button
                    key={item.id}
                    className={`lesson-row${item.id === lesson.id ? ' active' : ''}`}
                    onClick={() => selectLesson(item.id)}
                    aria-pressed={item.id === lesson.id}
                  >
                    <span className="lesson-row-tag">{item.tag}</span>
                    <span className="lesson-row-main">
                      <span className="lesson-row-name">{item.name}</span>
                      <span className="lesson-row-en">{item.en}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* 棋盘 */}
            <div className="practice-col-board">
              <div className="board-area practice-board-area">
                <div className="board-panel">
                  <Board2D
                    fen={boardFen}
                    interaction={READ_ONLY_INTERACTION}
                    flipped={flipped}
                    /*
                     * 「典型摆法」时**不画上一步箭头** ——
                     * 那个箭头指的是演示线的最后一步，和摆法局面不是同一手棋，
                     * 画出来会指错地方。
                     */
                    lastMove={
                      lessonView === 'moves' && currentMove?.from && currentMove?.to
                        ? { from: currentMove.from, to: currentMove.to }
                        : null
                    }
                    theme={boardTheme}
                    pieceStyle={settings.pieceStyle}
                    pieceMaterial={settings.pieceMaterial}
                  />
                </div>
              </div>
            </div>

            {/* 讲解 */}
            <div className="card practice-col-right">
              <div className="section-head">
                <div className="section-title">
                  <span className="eyebrow">{lesson.tag}</span>
                  <span className="zh">{lesson.name}</span>
                </div>
                <span className="section-meta">{lesson.en}</span>
              </div>

              {lesson.formation && (
                <div className="view-toggle lesson-toggle">
                  <button
                    className={lessonView === 'moves' ? 'active' : ''}
                    onClick={() => setLessonView('moves')}
                    aria-pressed={lessonView === 'moves'}
                  >
                    走法演示
                  </button>
                  <button
                    className={lessonView === 'formation' ? 'active' : ''}
                    onClick={() => setLessonView('formation')}
                    aria-pressed={lessonView === 'formation'}
                  >
                    典型摆法
                  </button>
                </div>
              )}

              {lessonView === 'moves' ? (
                <>
                  <div className="lesson-step">
                    <div className="lesson-step-head">
                      <span className="lesson-san">{currentMove?.san ?? '开局'}</span>
                      <span className="lesson-progress">
                        {stepIndex} / {lesson.moves.length}
                      </span>
                    </div>
                    <p className="lesson-note">
                      {currentMove?.note ?? lesson.summary}
                    </p>
                  </div>
                  <div className="lesson-controls">
                    <button
                      className="btn small"
                      onClick={() => setStepIndex((n) => Math.max(0, n - 1))}
                      disabled={stepIndex === 0}
                      title="上一步"
                    >
                      <ChevronLeft size={15} aria-hidden="true" />
                      上一步
                    </button>
                    <button
                      className="btn small"
                      onClick={() => setStepIndex((n) => Math.min(steps.length - 1, n + 1))}
                      disabled={stepIndex >= steps.length - 1}
                      title="下一步"
                    >
                      下一步
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => setStepIndex(0)}
                      title="回到开局"
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      重来
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => setFlipped((f) => !f)}
                      title="翻转棋盘"
                      aria-label="翻转棋盘"
                    >
                      <FlipHorizontal2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <ul className="lesson-points">
                    {lesson.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <div className="lesson-step">
                    <div className="lesson-step-head">
                      <span className="lesson-san">{lesson.formation?.label}</span>
                    </div>
                    <p className="lesson-note">{lesson.summary}</p>
                  </div>
                  <ul className="lesson-points">
                    {lesson.formation?.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        ) : (
          /* ================= 自由练习 ================= */
          <div className="practice-grid tab-free">
            {/* 左：摆棋工具 / 棋谱 */}
            <div className="card practice-col-left">
              {phase === 'setup' ? (
                <>
                  <div className="section-head">
                    <div className="section-title">
                      <span className="eyebrow">Setup</span>
                      <span className="zh">摆棋</span>
                    </div>
                    <span className="section-meta">{placement.size} 子</span>
                  </div>

                  <div className="palette">
                    {(['w', 'b'] as Color[]).map((color) => (
                      <div className="palette-row" key={color}>
                        <span className="palette-label">{color === 'w' ? '白方' : '黑方'}</span>
                        <div className="palette-chips">
                          {PIECE_TYPES.map((type) => {
                            const active =
                              brush.kind === 'piece' &&
                              brush.type === type &&
                              brush.color === color;
                            return (
                              <button
                                key={type}
                                className={`palette-chip ${color}${active ? ' active' : ''}`}
                                onClick={() => setBrush({ kind: 'piece', type, color })}
                                aria-pressed={active}
                                title={PIECE_LABEL[type]}
                                /*
                                 * 底色跟**棋盘**走（浅格 / 深格）——
                                 * 白棋落在白底上会糊成一团，看不清是不是王。
                                 */
                                style={{
                                  background: color === 'w' ? boardTheme.light : boardTheme.dark,
                                }}
                              >
                                <PieceGlyph
                                  type={type}
                                  color={color}
                                  size={34}
                                  style={settings.pieceStyle}
                                  material={settings.pieceMaterial}
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="palette-row">
                      <span className="palette-label">工具</span>
                      <div className="palette-chips">
                        <button
                          className={`palette-chip tool${brush.kind === 'erase' ? ' active' : ''}`}
                          onClick={() => setBrush({ kind: 'erase' })}
                          aria-pressed={brush.kind === 'erase'}
                          title="拿走棋子"
                        >
                          <Eraser size={18} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="practice-turn">先走方</label>
                    <Picker
                      id="practice-turn"
                      value={startTurn}
                      options={TURN_OPTIONS}
                      onChange={setStartTurn}
                      ariaLabel="谁先走"
                    />
                  </div>

                  <div className="btn-row">
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        setPlacement(new Map());
                        setSetupError(null);
                      }}
                      title="清空棋盘"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      清空
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        setPlacement(standardPlacement());
                        setSetupError(null);
                      }}
                    >
                      初始摆法
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => setFlipped((f) => !f)}
                      title="翻转棋盘"
                    >
                      <FlipHorizontal2 size={15} aria-hidden="true" />
                      翻转
                    </button>
                  </div>

                  <div className="btn-row" style={{ marginTop: 'var(--sp-3)' }}>
                    <button className="btn primary" style={{ flex: 1 }} onClick={startPractice}>
                      开始练习
                    </button>
                  </div>
                  {setupError && (
                    <span className="field-error" role="alert">
                      {setupError}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <div className="section-head">
                    <div className="section-title">
                      <span className="eyebrow">Notation</span>
                      <span className="zh">棋谱</span>
                    </div>
                    <span className="section-meta">{practiceSteps.length} 手</span>
                  </div>
                  <div className="notation-list practice-notation">
                    {notation.length === 0 && <div className="notation-empty">还没有走子。</div>}
                    {notation.map((row) => (
                      <div className="notation-row" key={row.no}>
                        <span className="no">{row.no}.</span>
                        <span className={`san${row.white ? '' : ' empty'}`}>{row.white ?? ''}</span>
                        <span className={`san${row.black ? '' : ' empty'}`}>{row.black ?? ''}</span>
                      </div>
                    ))}
                  </div>
                  <div className="btn-row">
                    <button className="btn small ghost" onClick={backToSetup} style={{ flex: 1 }}>
                      <RotateCcw size={15} aria-hidden="true" />
                      重新摆棋
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => setPracticeSteps([])}
                      disabled={practiceSteps.length === 0}
                    >
                      清空棋谱
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* 棋盘 */}
            <div className="practice-col-board">
              <div className="board-area practice-board-area">
                <div className="board-panel">
                  {phase === 'setup' ? (
                    <SetupBoard
                      placement={placement}
                      onSquareClick={handleSetupSquare}
                      flipped={flipped}
                      theme={boardTheme}
                      pieceStyle={settings.pieceStyle}
                      pieceMaterial={settings.pieceMaterial}
                    />
                  ) : (
                    <>
                      {practiceResult && (
                        <div className="result-overlay">
                          <div className="result-card">{practiceResult}</div>
                        </div>
                      )}
                      <Board2D
                        fen={practiceFen}
                        interaction={interaction}
                        flipped={flipped}
                        lastMove={lastStep ? { from: lastStep.from, to: lastStep.to } : null}
                        theme={boardTheme}
                        pieceStyle={settings.pieceStyle}
                        pieceMaterial={settings.pieceMaterial}
                      />
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
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 右：状态 */}
            <div className="card practice-col-right">
              {phase === 'setup' ? (
                <>
                  <div className="section-head">
                    <div className="section-title">
                      <span className="eyebrow">Position</span>
                      <span className="zh">局面</span>
                    </div>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">先走</span>
                    <span className="practice-readout-value">
                      {startTurn === 'w' ? '白方' : '黑方'}
                    </span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">棋子</span>
                    <span className="practice-readout-value">{placement.size}</span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">王</span>
                    <span className="practice-readout-value">
                      {(() => {
                        let w = 0;
                        let b = 0;
                        for (const piece of placement.values()) {
                          if (piece.type !== 'k') continue;
                          if (piece.color === 'w') w += 1;
                          else b += 1;
                        }
                        return `白 ${w} · 黑 ${b}`;
                      })()}
                    </span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">视角</span>
                    <span className="practice-readout-value">
                      {flipped ? '黑方在下' : '白方在下'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="section-head">
                    <div className="section-title">
                      <span className="eyebrow">Practice</span>
                      <span className="zh">练习中</span>
                    </div>
                    <span className="section-meta">不限时</span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">轮到</span>
                    <span className="practice-readout-value">{sideToMove}</span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">手数</span>
                    <span className="practice-readout-value">{practiceSteps.length}</span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">视角</span>
                    <span className="practice-readout-value">
                      {flipped ? '黑方在下' : '白方在下'}
                    </span>
                  </div>
                  <div className="btn-row" style={{ marginTop: 'var(--sp-3)' }}>
                    <button
                      className="btn small ghost"
                      onClick={() => setFlipped((f) => !f)}
                      title="翻转棋盘"
                    >
                      <FlipHorizontal2 size={15} aria-hidden="true" />
                      翻转棋盘
                    </button>
                    <button className="btn small ghost" onClick={backToSetup} style={{ flex: 1 }}>
                      重新摆棋
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
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

      {/* 私信面板（和大厅共用一套） */}
      <DirectMessagePanel
        open={dmOpen}
        onClose={() => setDmOpen(false)}
        peer={dmPeer}
        onSelectPeer={setDmPeer}
      />
    </div>
  );
}
