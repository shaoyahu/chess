/**
 * **关卡目标的那行字** —— 说什么，必须和真实发生的事对上。
 *
 * ## 为什么单独一个模块
 *
 * 这行字是「卡面承诺」：玩家照着它下，下完看到「通关」，
 * 就会拿它跟棋盘对账。**对不上就是骗人**。
 *
 * 之前只有一句「{方}取胜」，于是出现这种场面：
 * 目标写着「黑方取胜」，走完却是 `Qg1+ Kf5 Qxg8` ——
 * 白后被吃了、白王好好站着、**根本没有将死**，
 * 玩家只会觉得「这关判错了」。
 *
 * ## 「取胜」这关到底赢在哪
 *
 * 实测 168 关「取胜」题（引擎逐关复核终局）：
 *
 *   - **没有一关是将死**（99 关大优 +556 厘兵以上，68 关明显占优，1 关略占优）；
 *   - 收尾方式：吃掉对方的后 15、吃掉车 15、升变 22、
 *     吃掉象/马/兵 7、**最后一手不吃子** 73（把对方的路堵死，让优势变成胜势）。
 *
 * 所以这行字要**按真实收尾**分情况说：
 * 吃后就说「赢下对方的后」，升变就说「升变取胜」，
 * 什么都没吃就说「把优势变成胜势」——
 * 宁可具体，也不要笼统。
 */
import { Chess } from 'chess.js';
import type { Puzzle } from './types';

/** 棋子类型 → 中文名（跟棋手说话的说法） */
const PIECE_NAME: Record<string, string> = {
  q: '后',
  r: '车',
  b: '象',
  n: '马',
  p: '兵',
};

/**
 * 这一关里**玩家的最后一手**。
 *
 * 为什么不直接取最后一手：理论上线可能以对手的着法收尾
 * （那样「吃掉了什么」就是对手的战果，不能算成玩家的）。
 * 现在 300 关全部以玩家着法结尾，但这里按事实去找，不靠假设。
 */
function playerLastPly(puzzle: Puzzle) {
  for (let i = puzzle.line.length - 1; i >= 0; i -= 1) {
    const ply = puzzle.line[i];
    if (ply && ply.color === puzzle.side) return { ply, index: i };
  }
  return null;
}

/**
 * 这一关**玩家最后一手吃掉了什么棋子**。
 *
 * 怎么找的：
 *   - 吃子着法的落点就是被吃棋子的原位（`ply.to`）；
 *   - 那一格在**走之前**摆着什么 —— 走之前的局面就是上一手的 `fen`；
 *   - 用 chess.js 读那一格的棋子类型。
 *
 * @returns 棋子类型（'q' / 'r' / 'b' / 'n' / 'p'）；没吃子返回 null
 */
export function lastCapture(puzzle: Puzzle): string | null {
  const found = playerLastPly(puzzle);
  if (!found) return null;
  const { ply, index } = found;
  if (!ply.san.includes('x')) return null;
  const prev = puzzle.line[index - 1];
  const beforeFen = prev ? prev.fen : puzzle.fen;
  try {
    // chess.js 的 get() 要 Square 类型，这里落点本来就来自棋盘数据
    const square = ply.to as Parameters<Chess['get']>[0];
    const piece = new Chess(beforeFen).get(square);
    return piece?.type ?? null;
  } catch {
    return null;
  }
}

/** 这一关**玩家最后一手是不是升变** */
export function endsWithPromotion(puzzle: Puzzle): boolean {
  const found = playerLastPly(puzzle);
  return !!found && found.ply.san.includes('=');
}

/**
 * 目标那行字。
 *
 * @param puzzle 关卡
 * @returns 一句话，说清这一关要达成什么
 */
export function puzzleGoalText(puzzle: Puzzle): string {
  const side = puzzle.side === 'w' ? '白方' : '黑方';

  if (puzzle.goal === 'mate') return `${side} ${puzzle.mateIn ?? 1} 手内将死`;
  if (puzzle.goal === 'draw') return `${side}守和`;
  if (puzzle.goal === 'promote') return `${side}升变取胜`;

  /*
   * 「取胜」这关要**说清赢在哪** ——
   * 光说「取胜」，玩家看到对方王还站着、局面也没终，就以为判错了。
   */
  if (endsWithPromotion(puzzle)) return `${side}升变取胜`;

  const captured = lastCapture(puzzle);
  if (captured === 'q') return `${side}赢下对方的后`;
  if (captured === 'r') return `${side}赢下对方的车`;
  if (captured === 'b') return `${side}赢下对方的象`;
  if (captured === 'n') return `${side}赢下对方的马`;
  if (captured === 'p') return `${side}赢子取胜`;

  // 最后一手不吃子：靠的是把对方的路堵死，让子力优势变成胜势
  return `${side}把优势变成胜势`;
}
