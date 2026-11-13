/**
 * **课程类型与推导逻辑** —— 「国际象棋教学」的数据形状。
 *
 * 一课 = 四块东西：
 *  1. `moves`  —— 一条**能走通的演示线**，每一手配一句讲解；
 *  2. `points` —— 这条线的要点清单（讲道理，不讲具体着法）；
 *  3. `formation`（可选）—— 这一课**典型怎么摆**（局面由着法推导，不手写 FEN）；
 *  4. `lines`（可选）—— **同一课的其它线路**。应对类课程天生需要：
 *     对方走完某个开局后往往有几条正经应手（「对付后翼弃兵」里黑方有
 *     斯拉夫 / 半斯拉夫 / 接受变例三条路），一课里能切着看，
 *     才知道「怎么选」，而不是背三条互不相干的谱。
 *
 * 为什么局面由**着法推导**而不是直接写 FEN：
 *   手写 FEN 一定有写错的一天（少一个空格、王站错格），而且错了之后
 *   棋盘会画出一个「看起来能下、其实下不了」的局面。
 *   用着法推导 = 局面与讲解永远自洽：讲解说「车到第七横线」，
 *   棋盘上就一定真的是车在第七横线。
 *
 * 着法合法性由 `tests/practice.test.ts` 守着（每一手都真走一遍）。
 */
import { Chess, type Move } from 'chess.js';

/** 一手（SAN + 讲解） */
export interface LessonMove {
  /** 标准记谱 */
  san: string;
  /** 这一手在讲什么 */
  note: string;
}

/**
 * 一条**线路** —— 一条能走通的着法序列 + 它的要点。
 *
 * 用于「同一课有多条线路」的场景（应对类课程）。
 */
export interface LessonLine {
  /** 线路标识（同一课内唯一） */
  id: string;
  /** 线路名，如「斯拉夫」「半斯拉夫」「接受变例」 */
  label: string;
  /** 这一条线的着法 */
  moves: LessonMove[];
  /** 这一条线的要点 */
  points: string[];
}

/** 「典型摆法」—— 这一课推荐的布局 */
export interface LessonFormation {
  /** 到达该摆法的着法（从本课的起始局面起算） */
  moves: string[];
  /** 摆法的名字 */
  label: string;
  /** 每个子摆在哪、为什么摆那 */
  points: string[];
}

/** 课程分类 */
export const LESSON_TAGS = ['基本功', '开局', '应对', '残局'] as const;

/** 课程分类 */
export type LessonTag = (typeof LESSON_TAGS)[number];

/** 这一课站在哪一方讲 */
export type LessonSide = 'w' | 'b';

/** 一课 */
export interface Lesson {
  id: string;
  /** 中文名 */
  name: string;
  /** 英文名 / 别名 */
  en: string;
  /** 分类 */
  tag: LessonTag;
  /**
   * 这一课是站在哪一方讲的。
   *
   * 开局课大多有天然的方向（伦敦、后翼弃兵是白方；卡罗康、法国是黑方），
   * 但**应对课一定是「站在对手的对面」** —— 「对付后翼弃兵」是黑方的课。
   * 界面上用一个黑白车的小棋子表示，不写字。
   */
  side?: LessonSide;
  /** 一句话定位 */
  summary: string;
  /** 起始局面 */
  fen: string;
  /** 主线着法 */
  moves: LessonMove[];
  /** 主线要点 */
  points: string[];
  /** 典型摆法（可选） */
  formation?: LessonFormation;
  /**
   * 主线在多线路课里的名字（如「斯拉夫」）。
   *
   * 只有 `lines` 非空时才有意义 —— 那时界面会渲染一排线路切换按钮，
   * 主线也得有个名字，不能写成「主线」糊弄过去。
   */
  mainLabel?: string;
  /** 其它可切换的线路（不含主线） */
  lines?: LessonLine[];
}

/** 主线的内部 id（`lines` 里不会出现这个 id） */
export const MAIN_LINE_ID = '__main';

/**
 * 取一课当前要显示的线路。
 *
 * @param lineId 选中的线路 id；`null` / 找不到 → 回主线。
 */
export function resolveLine(lesson: Lesson, lineId: string | null): LessonLine {
  if (lineId) {
    const found = lesson.lines?.find((line) => line.id === lineId);
    if (found) return found;
  }
  return {
    id: MAIN_LINE_ID,
    label: lesson.mainLabel ?? '主线',
    moves: lesson.moves,
    points: lesson.points,
  };
}

/** 一课的全部线路（主线 + 其它线路），顺序即界面上的顺序 */
export function lessonLines(lesson: Lesson): LessonLine[] {
  return [resolveLine(lesson, null), ...(lesson.lines ?? [])];
}

/**
 * 演示到第 n 手之后的局面（`positions[0]` = 起始局面）。
 *
 * 用 chess.js 自己重放 SAN —— 它给出的 `from` / `to` 正好用来画
 * 「上一步」的箭头，跟对局页的棋谱箭头是同一套几何。
 */
export function lessonPositions(lesson: Lesson, lineId: string | null = null): string[] {
  return lessonSteps(lesson, lineId).map((step) => step.fen);
}

/** 演示的每一步（含着法来源） */
export interface LessonStep {
  /** 这一步之后的局面 */
  fen: string;
  /** 这一手的 SAN（第一步没有） */
  san?: string;
  /** 这一手的讲解（第一步没有） */
  note?: string;
  /** 起点（第一步没有） */
  from?: string;
  /** 终点（第一步没有） */
  to?: string;
}

/** 把一课的一条线路走一遍，得到每一步的局面 */
export function lessonSteps(lesson: Lesson, lineId: string | null = null): LessonStep[] {
  const line = resolveLine(lesson, lineId);
  const game = new Chess(lesson.fen);
  const steps: LessonStep[] = [{ fen: game.fen() }];
  for (const move of line.moves) {
    let played: Move;
    try {
      played = game.move(move.san);
    } catch {
      // 着法写错 —— 停在能走通的地方，绝不硬编
      break;
    }
    steps.push({
      fen: game.fen(),
      san: move.san,
      note: move.note,
      from: played.from,
      to: played.to,
    });
  }
  return steps;
}

/** 「典型摆法」的局面（由着法推导） */
export function formationPosition(lesson: Lesson): string | null {
  const formation = lesson.formation;
  if (!formation) return null;
  const game = new Chess(lesson.fen);
  for (const san of formation.moves) {
    try {
      game.move(san);
    } catch {
      return null;
    }
  }
  return game.fen();
}
