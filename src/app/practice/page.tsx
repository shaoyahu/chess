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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  Castle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Disc,
  Eraser,
  FlipHorizontal2,
  Grid2x2,
  Lightbulb,
  RotateCcw,
  Settings,
  Star,
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
  positionAt,
  pushStep,
  type PracticeStep,
} from '@/lib/practice/history';
import {
  LESSONS,
  LESSON_TAGS,
  formationPosition,
  lessonLines,
  lessonSteps,
  resolveLine,
  type Lesson,
  type LessonTag,
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
import {
  PUZZLES,
  applyPlayerMove,
  emptyProgress,
  hintFor,
  loadProgress,
  markCurrent,
  markSolved,
  playerMoveCount,
  saveProgress,
  sessionPosition,
  startSession,
  themeLabel,
  type Puzzle,
  type PuzzleProgress,
  type PuzzleSession,
} from '@/lib/practice/puzzles';

/** 三个分区 */
type Tab = 'lesson' | 'puzzle' | 'free';

/** 自由练习的两个阶段 */
type Phase = 'setup' | 'play';

/** 摆棋时手里的「笔」：某色的某个子，或者橡皮 */
type Brush = { kind: 'piece'; type: PieceType; color: Color } | { kind: 'erase' };

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

/**
 * 关卡目标的中文文案。
 *
 * 这是**任务状态**，不是解释性文字 —— 玩家得知道这一关要达成什么。
 */
function puzzleGoalText(puzzle: Puzzle): string {
  const side = puzzle.side === 'w' ? '白方' : '黑方';
  if (puzzle.goal === 'mate') return `${side} ${puzzle.mateIn ?? 1} 手内将死`;
  if (puzzle.goal === 'win') return `${side}取胜`;
  if (puzzle.goal === 'draw') return `${side}守和`;
  return `${side}升变取胜`;
}

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
  /** 课程分类筛选（null = 全部） */
  const [tagFilter, setTagFilter] = useState<LessonTag | null>(null);
  /**
   * 当前看的是哪条线路（null = 主线）。
   *
   * 「应对」类课程一课有 2~3 条线路（对方有几种正经应手），
   * 切线路就是切到另一条演示线 —— 局面、讲解、要点整套换掉。
   */
  const [lineId, setLineId] = useState<string | null>(null);

  const lesson: Lesson = useMemo(
    () => LESSONS.find((l) => l.id === lessonId) ?? LESSONS[0],
    [lessonId],
  );
  /** 这一课当前显示的线路（主线或选中的备用线） */
  const activeLine = useMemo(() => resolveLine(lesson, lineId), [lesson, lineId]);
  /** 演示线的每一步（含局面与着法来源） */
  const steps = useMemo(() => lessonSteps(lesson, lineId), [lesson, lineId]);
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
  /** 筛选后的课单 */
  const visibleLessons = useMemo(
    () => (tagFilter ? LESSONS.filter((l) => l.tag === tagFilter) : LESSONS),
    [tagFilter],
  );
  /** 各类有几课（筛选按钮上的数字） */
  const tagCounts = useMemo(() => {
    const counts = new Map<LessonTag, number>();
    for (const l of LESSONS) counts.set(l.tag, (counts.get(l.tag) ?? 0) + 1);
    return counts;
  }, []);

  const selectLesson = useCallback((id: string) => {
    setLessonId(id);
    setStepIndex(0);
    setLessonView('moves');
    // 换课就回到主线：上一课的线路 id 在新课程里多半不存在
    setLineId(null);
  }, []);

  /* ---------------- 残局关卡 ---------------- */
  /** 当前关卡 id */
  const [puzzleId, setPuzzleId] = useState<string>(PUZZLES[0]?.id ?? '');
  /** 当前这一局的解题状态（局面由它算出来，不单独存） */
  const [session, setSession] = useState<PuzzleSession | null>(null);
  /** 通关记录（从 localStorage 读，写进 localStorage） */
  const [progress, setProgress] = useState<PuzzleProgress>(() => emptyProgress());
  /** 关卡棋盘的视角（玩家执黑时默认翻转） */
  const [puzzleFlipped, setPuzzleFlipped] = useState(false);
  /** 提示箭头（点了「提示」才出现） */
  const [hintMove, setHintMove] = useState<{ from: string; to: string } | null>(null);
  /** 走错的那一手（棋盘上标红） */
  const [wrongMove, setWrongMove] = useState<{ from: string; to: string } | null>(null);

  // 存档在挂载后读 —— 服务端渲染时 localStorage 还没有
  useEffect(() => {
    const loaded = loadProgress();
    setProgress(loaded);
    const last = loaded.lastId ? PUZZLES.find((p) => p.id === loaded.lastId) : null;
    const target = last ?? PUZZLES[0];
    if (target) {
      setPuzzleId(target.id);
      setSession(startSession(target));
      setPuzzleFlipped(target.side === 'b');
    }
  }, []);

  /** 当前关卡 */
  const puzzle = useMemo(
    () => PUZZLES.find((p) => p.id === puzzleId) ?? PUZZLES[0] ?? null,
    [puzzleId],
  );
  /** 棋盘该显示的局面 */
  const puzzleFen = session ? sessionPosition(session) : '';
  /** 上一步的箭头（对手那手自动走掉时也画） */
  const lastPuzzleStep = session && session.ply > 0 ? session.puzzle.line[session.ply - 1] : null;
  const lastPuzzleMove =
    lastPuzzleStep && lastPuzzleStep.from && lastPuzzleStep.to
      ? { from: lastPuzzleStep.from, to: lastPuzzleStep.to }
      : null;

  /** 换一关 */
  const selectPuzzle = useCallback((id: string) => {
    const target = PUZZLES.find((p) => p.id === id);
    if (!target) return;
    setPuzzleId(id);
    setSession(startSession(target));
    setPuzzleFlipped(target.side === 'b');
    setHintMove(null);
    setWrongMove(null);
    setProgress((prev) => {
      const next = markCurrent(prev, id);
      saveProgress(next);
      return next;
    });
  }, []);

  /** 走子：走对了推进，走错了标红但不推进 */
  const handlePuzzleMove = useCallback(
    (from: string, to: string, promotion?: PieceType) => {
      if (!session) return;
      const result = applyFreeMove(puzzleFen, from, to, promotion);
      if (!result) return;
      const next = applyPlayerMove(session, result.step.san);
      setWrongMove(next.ok ? null : { from, to });
      setHintMove(null);
      if (!next.ok) {
        // 走错了：局面不动，只把错的着法记下来
        setSession(next.session);
        return;
      }
      setSession(next.session);
      if (next.session.solved) {
        setProgress((prev) => {
          const updated = markSolved(prev, session.puzzle.id);
          saveProgress(updated);
          return updated;
        });
      }
    },
    [session, puzzleFen],
  );

  const puzzleInteraction = useBoardInteraction({
    room: null,
    myColor: session?.puzzle.side,
    onMove: handlePuzzleMove,
    // 只有玩家自己的子能动 —— 对手那手由题库自动走
    free: session ? { fen: puzzleFen, onlyColor: session.puzzle.side } : null,
  });

  /** 提示：把该走的那一步高亮出来 */
  const showPuzzleHint = useCallback(() => {
    if (!session) return;
    const step = hintFor(session);
    if (!step) return;
    setHintMove({ from: step.from, to: step.to });
    setWrongMove(null);
  }, [session]);

  /** 重来：这一关从头开始 */
  const resetPuzzle = useCallback(() => {
    if (!session) return;
    setSession(startSession(session.puzzle));
    setHintMove(null);
    setWrongMove(null);
  }, [session]);

  /** 下一关 */
  const nextPuzzle = useCallback(() => {
    const idx = PUZZLES.findIndex((p) => p.id === puzzleId);
    const next = PUZZLES[idx + 1];
    if (next) selectPuzzle(next.id);
  }, [puzzleId, selectPuzzle]);

  /* ---------------- 自由练习 ---------------- */
  const [phase, setPhase] = useState<Phase>('setup');
  const [placement, setPlacement] = useState<Placement>(() => standardPlacement());
  const [brush, setBrush] = useState<Brush>({ kind: 'piece', type: 'p', color: 'w' });
  const [startTurn, setStartTurn] = useState<Color>('w');
  const [setupError, setSetupError] = useState<string | null>(null);
  /** 练习的**起始局面**（摆棋定下来的那个） */
  const [practiceStartFen, setPracticeStartFen] = useState<string>(START_FEN);
  /** 练习的棋谱（每一步带着走完之后的局面） */
  const [practiceSteps, setPracticeSteps] = useState<PracticeStep[]>([]);
  /**
   * **棋谱游标**：已经走了几手（0 = 起始局面）。
   *
   * 棋盘显示的局面由「起始局面 + 棋谱 + 游标」算出来，
   * 不单独存 —— 存两份迟早会对不上。
   */
  const [practiceCursor, setPracticeCursor] = useState(0);
  const [flipped, setFlipped] = useState(false);

  /** 棋盘该显示的局面（跟着游标走） */
  const practiceFen = useMemo(
    () => positionAt(practiceStartFen, practiceSteps, practiceCursor),
    [practiceStartFen, practiceSteps, practiceCursor],
  );

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
    setPracticeStartFen(result.fen);
    setPracticeSteps([]);
    setPracticeCursor(0);
    setPhase('play');
  }, [placement, startTurn]);

  /** 走子：双方都能走（与「复盘 · 自由走棋」同一套语义） */
  const handlePracticeMove = useCallback(
    (from: string, to: string, promotion?: PieceType) => {
      const result = applyFreeMove(practiceFen, from, to, promotion);
      if (!result) return;
      /*
       * 落新的一手 = **换了一条线**：游标之后的旧着法作废（`pushStep` 截断）。
       * 截断之后游标正好落在最后 —— 棋谱又和局面一一对应了。
       */
      setPracticeSteps((prev) =>
        pushStep(prev, practiceCursor, {
          san: result.step.san,
          color: result.step.color,
          from,
          to,
          fen: result.fen,
        }),
      );
      setPracticeCursor(practiceCursor + 1);
    },
    [practiceFen, practiceCursor],
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

  /** 棋谱按「回合号 白着 黑着」分行；每一手记下自己的序号（高亮当前手用） */
  const notation = useMemo(() => {
    const rows: Array<{
      no: number;
      white?: string;
      black?: string;
      whiteIdx?: number;
      blackIdx?: number;
    }> = [];
    practiceSteps.forEach((step, index) => {
      const no = Math.floor(index / 2) + 1;
      let row = rows[no - 1];
      if (!row) {
        row = { no };
        rows[no - 1] = row;
      }
      if (step.color === 'w') {
        row.white = step.san;
        row.whiteIdx = index;
      } else {
        row.black = step.san;
        row.blackIdx = index;
      }
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
      <header className="topbar container wide">
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

      <main className="container wide" style={{ paddingBottom: 40, flex: 1 }}>
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
            className={`btn${tab === 'puzzle' ? ' active' : ''}`}
            onClick={() => setTab('puzzle')}
            aria-pressed={tab === 'puzzle'}
          >
            <Grid2x2 size={15} aria-hidden="true" />
            残局关卡
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
              {/* 分类筛选 —— 三十多课平铺太长，按「基本功/开局/应对/残局」分桶 */}
              <div className="lesson-filter">
                <button
                  className={`lesson-filter-chip${tagFilter === null ? ' active' : ''}`}
                  onClick={() => setTagFilter(null)}
                  aria-pressed={tagFilter === null}
                >
                  全部
                  <span className="lesson-filter-count">{LESSONS.length}</span>
                </button>
                {LESSON_TAGS.map((tag) => (
                  <button
                    key={tag}
                    className={`lesson-filter-chip${tagFilter === tag ? ' active' : ''}`}
                    onClick={() => setTagFilter(tag)}
                    aria-pressed={tagFilter === tag}
                  >
                    {tag}
                    <span className="lesson-filter-count">{tagCounts.get(tag) ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="lesson-list">
                {visibleLessons.map((item) => (
                  <button
                    key={item.id}
                    className={`lesson-row${item.id === lesson.id ? ' active' : ''}`}
                    onClick={() => selectLesson(item.id)}
                    aria-pressed={item.id === lesson.id}
                  >
                    <span className="lesson-row-tag">{item.tag}</span>
                    {/*
                     * 侧别：白方 = 空心圈、黑方 = 实心圈 —— 国际象棋通用约定。
                     * 不用棋子图形：白车画在纸色底上几乎看不见。
                     */}
                    {item.side && (
                      <span className={`lesson-row-side side-${item.side}`}>
                        {item.side === 'b' ? (
                          <Disc size={13} aria-hidden="true" />
                        ) : (
                          <Circle size={13} aria-hidden="true" />
                        )}
                      </span>
                    )}
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

              {/* 线路切换 —— 一课有多条线路时（应对课：对方有几种正经应手） */}
              {lesson.lines && lesson.lines.length > 0 && (
                <div className="lesson-lines">
                  {lessonLines(lesson).map((line) => (
                    <button
                      key={line.id}
                      className={`lesson-line-chip${line.id === activeLine.id ? ' active' : ''}`}
                      onClick={() => {
                        setLineId(line.id === activeLine.id ? null : line.id);
                        setStepIndex(0);
                      }}
                      aria-pressed={line.id === activeLine.id}
                    >
                      {line.label}
                    </button>
                  ))}
                </div>
              )}

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
                        {stepIndex} / {activeLine.moves.length}
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
                    {activeLine.points.map((point) => (
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
        ) : tab === 'puzzle' ? (
          /* ================= 残局关卡 ================= */
          <div className="practice-grid tab-puzzle">
            {/* 关卡列表 */}
            <div className="card practice-col-left">
              <div className="section-head">
                <div className="section-title">
                  <span className="eyebrow">Endgame</span>
                  <span className="zh">残局关卡</span>
                </div>
                <span className="section-meta">
                  {progress.solved.length} / {PUZZLES.length}
                </span>
              </div>
              <div className="puzzle-list">
                {PUZZLES.map((item, i) => (
                  <button
                    key={item.id}
                    className={`puzzle-row${item.id === puzzleId ? ' active' : ''}`}
                    onClick={() => selectPuzzle(item.id)}
                    aria-pressed={item.id === puzzleId}
                  >
                    <span className="puzzle-row-no">{i + 1}</span>
                    <span className="puzzle-row-main">
                      <span className="puzzle-row-name">{themeLabel(item.theme)}</span>
                      <span className="puzzle-row-goal">{puzzleGoalText(item)}</span>
                    </span>
                    <span
                      className="puzzle-row-stars"
                      aria-label={`难度 ${item.difficulty} / 5`}
                      title={`难度 ${item.difficulty} / 5`}
                    >
                      {Array.from({ length: 5 }, (_, k) => (
                        <Star
                          key={k}
                          size={11}
                          fill={k < item.difficulty ? 'currentColor' : 'none'}
                          aria-hidden="true"
                        />
                      ))}
                    </span>
                    {progress.solved.includes(item.id) && (
                      <span className="puzzle-row-done">
                        <Check size={13} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* 棋盘 */}
            <div className="practice-col-board">
              <div className="board-area practice-board-area">
                <div className="board-panel">
                  {session && (
                    <>
                      <Board2D
                        fen={puzzleFen}
                        interaction={puzzleInteraction}
                        flipped={puzzleFlipped}
                        lastMove={lastPuzzleMove}
                        hintMove={hintMove}
                        wrongMove={wrongMove}
                        theme={boardTheme}
                        pieceStyle={settings.pieceStyle}
                        pieceMaterial={settings.pieceMaterial}
                      />
                      {puzzleInteraction.pendingPromotion && (
                        <div className="overlay" onClick={puzzleInteraction.cancelPromotion}>
                          <div className="promotion-box" onClick={(e) => e.stopPropagation()}>
                            <p>兵升变为</p>
                            <div className="promotion-options">
                              {(['q', 'r', 'b', 'n'] as const).map((pp) => (
                                <button key={pp} onClick={() => puzzleInteraction.choosePromotion(pp)}>
                                  <PieceGlyph
                                    type={pp}
                                    color={
                                      (pieceAt(puzzleFen, puzzleInteraction.pendingPromotion?.from ?? '')
                                        ?.color ?? 'w') as Color
                                    }
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

            {/* 状态与操作 */}
            <div className="card practice-col-right">
              {puzzle && session && (
                <>
                  <div className="section-head">
                    <div className="section-title">
                      <span className="eyebrow">
                        Level {PUZZLES.findIndex((x) => x.id === puzzle.id) + 1}
                      </span>
                      <span className="zh">{themeLabel(puzzle.theme)}</span>
                    </div>
                    <span className="section-meta">{puzzle.en}</span>
                  </div>

                  <div className="practice-readout">
                    <span className="practice-readout-label">目标</span>
                    <span className="practice-readout-value">{puzzleGoalText(puzzle)}</span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">执子</span>
                    <span className="practice-readout-value">
                      {puzzle.side === 'w' ? '白方' : '黑方'}
                    </span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">步数</span>
                    <span className="practice-readout-value">
                      {session.playerMoves.length} / {playerMoveCount(puzzle)}
                    </span>
                  </div>

                  {/* 状态反馈：走错了 / 通关了 */}
                  {session.lastWrong && !session.solved && (
                    <div className="puzzle-status wrong" role="status">
                      这一步不对
                    </div>
                  )}
                  {session.solved && (
                    <div className="puzzle-status done" role="status">
                      通关
                    </div>
                  )}

                  <div className="btn-row">
                    <button
                      className="btn small"
                      onClick={showPuzzleHint}
                      disabled={session.solved}
                      title="提示"
                    >
                      <Lightbulb size={15} aria-hidden="true" />
                      提示
                    </button>
                    <button className="btn small ghost" onClick={resetPuzzle} title="重来">
                      <RotateCcw size={15} aria-hidden="true" />
                      重来
                    </button>
                  </div>
                  <div className="btn-row" style={{ marginTop: 'var(--sp-3)' }}>
                    <button
                      className="btn small ghost"
                      onClick={() => setPuzzleFlipped((f) => !f)}
                      title="翻转棋盘"
                    >
                      <FlipHorizontal2 size={15} aria-hidden="true" />
                      翻转
                    </button>
                    {session.solved && (
                      <button className="btn primary" onClick={nextPuzzle} style={{ flex: 1 }}>
                        下一关
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  {/* 通关后才显示的教学要点 —— 提前印出来就把题做完了 */}
                  {session.solved && (
                    <ul className="lesson-points">
                      {puzzle.points.map((pt) => (
                        <li key={pt}>{pt}</li>
                      ))}
                    </ul>
                  )}
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
                        <span
                          className={`san${row.white ? '' : ' empty'}${
                            row.whiteIdx === practiceCursor - 1 ? ' current' : ''
                          }`}
                        >
                          {row.white ?? ''}
                        </span>
                        <span
                          className={`san${row.black ? '' : ' empty'}${
                            row.blackIdx === practiceCursor - 1 ? ' current' : ''
                          }`}
                        >
                          {row.black ?? ''}
                        </span>
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
                      onClick={() => {
                        // 棋谱清空 → 游标也回起点（不然「手数」会显示成 3 / 0 这种鬼话）
                        setPracticeSteps([]);
                        setPracticeCursor(0);
                      }}
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
                    <span className="practice-readout-value">
                      {practiceCursor} / {practiceSteps.length}
                    </span>
                  </div>
                  <div className="practice-readout">
                    <span className="practice-readout-label">视角</span>
                    <span className="practice-readout-value">
                      {flipped ? '黑方在下' : '白方在下'}
                    </span>
                  </div>
                  {/*
                   * **上一步 / 下一步** —— 走错了不用重开：
                   * 退回去改一步再继续下；在中间落新的一手，后面的旧着法自动作废。
                   */}
                  <div className="btn-row practice-history">
                    <button
                      className="btn small"
                      onClick={() => setPracticeCursor((c) => Math.max(0, c - 1))}
                      disabled={practiceCursor === 0}
                      title="上一步"
                    >
                      <ChevronLeft size={15} aria-hidden="true" />
                      上一步
                    </button>
                    <button
                      className="btn small"
                      onClick={() =>
                        setPracticeCursor((c) => Math.min(practiceSteps.length, c + 1))
                      }
                      disabled={practiceCursor >= practiceSteps.length}
                      title="下一步"
                    >
                      下一步
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
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
