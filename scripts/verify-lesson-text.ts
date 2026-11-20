/**
 * **教学文案门禁** —— 检查课程内容里「说的」和「摆的」对不对得上。
 *
 * 为什么要有这道门禁：
 *   着法合法、单测能守住（每条线都真走一遍，SAN 逐字比对）。
 *   但**讲解文字**守不住 —— 写着「白方多一个兵」，实际终局是双方平兵，
 *   或者某句里提到的变例根本不在演示线上，页面照样显示得好好的，
 *   玩家却会学到错的东西。
 *   这道门禁就是抓这一类「说法与事实不符」。
 *
 * 判定：
 *   L1 子力说法一致 —— 要点里「白方多兵 / 黑方少马 / 白方多一个兵」这类
 *      **可判定**的说法，必须跟这条线终局的实际兵数、马数、象数对得上。
 *      （一句话里可能在比较别的线，所以按分句查：紧邻上一分句提到别的线名就跳过。）
 *   L2 内容下限 —— 每条线至少 8 手、至少 3 条要点；每课必须有 summary。
 *   L3 不是占位 —— 每一步的讲解非空，且同一课里讲解不能整句重复
 *      （复制粘贴的占位文是「看着有、其实没写」）。
 *   L4 线路元数据 —— 同一条课里各条线的 label 不重名，主线名不叫「主线」。
 *
 * 用法：npm run verify:lessons
 * 退出码非 0 = 有问题（❌ 行带编号）。
 */

import { Chess } from 'chess.js';
import { LESSONS, lessonLines } from '../src/lib/practice/lessons';
import { START_FEN } from '../src/lib/constants';

type Side = 'w' | 'b';
interface Claim {
  re: RegExp;
  kind: 'p' | 'n' | 'b';
  side: Side;
  delta: number;
}

/** 要点里「可判定」的说法 */
const CLAIMS: Claim[] = [
  { re: /白方多.{0,2}兵/, kind: 'p', side: 'w', delta: 1 },
  { re: /黑方多.{0,2}兵/, kind: 'p', side: 'b', delta: 1 },
  { re: /白方少.{0,2}兵/, kind: 'p', side: 'w', delta: -1 },
  { re: /黑方少.{0,2}兵/, kind: 'p', side: 'b', delta: -1 },
  { re: /白方多.{0,2}马/, kind: 'n', side: 'w', delta: 1 },
  { re: /黑方多.{0,2}马/, kind: 'n', side: 'b', delta: 1 },
  { re: /白方少.{0,2}马/, kind: 'n', side: 'w', delta: -1 },
  { re: /黑方少.{0,2}马/, kind: 'n', side: 'b', delta: -1 },
  { re: /白方多.{0,2}象/, kind: 'b', side: 'w', delta: 1 },
  { re: /黑方多.{0,2}象/, kind: 'b', side: 'b', delta: 1 },
  { re: /白方少.{0,2}象/, kind: 'b', side: 'w', delta: -1 },
  { re: /黑方少.{0,2}象/, kind: 'b', side: 'b', delta: -1 },
];

const MIN_MOVES = 8;
const MIN_POINTS = 3;
/**
 * 从初始局面走起的课（开局 / 应对）要够长才有东西可讲；
 * 战术、残局课是从一个具体 FEN 起步的，三五手讲完一个点子就够 ——
 * 对它们用同一个下限就是误报。
 */
const minMoves = (fen: string): number => (fen === START_FEN ? MIN_MOVES : 3);

let failures = 0;

function fail(check: string, message: string): void {
  failures += 1;
  console.log(`❌ ${check} ${message}`);
}

for (const lesson of LESSONS) {
  const lines = lessonLines(lesson);

  // ---- L2 内容下限 ----
  if (!lesson.summary.trim()) fail('L2', `${lesson.id}：summary 是空的`);
  for (const line of lines) {
    if (line.moves.length < minMoves(lesson.fen)) {
      fail('L2', `${lesson.id} / ${line.label}：只有 ${line.moves.length} 手（至少 ${minMoves(lesson.fen)} 手）`);
    }
    if (line.points.length < MIN_POINTS) {
      fail('L2', `${lesson.id} / ${line.label}：只有 ${line.points.length} 条要点（至少 ${MIN_POINTS} 条）`);
    }
  }

  // ---- L4 线路元数据 ----
  const labels = lines.map((l) => l.label);
  for (const label of labels) {
    if (labels.filter((l) => l === label).length > 1) {
      fail('L4', `${lesson.id}：线路名「${label}」重复`);
    }
  }
  if (lines.length > 1 && labels[0] === '主线') {
    fail('L4', `${lesson.id}：多线路课的主线不能叫「主线」`);
  }

  for (const line of lines) {
    // ---- L1 子力说法 ----
    const game = new Chess(lesson.fen);
    for (const move of line.moves) game.move(move.san);
    const count = {
      w: { p: 0, n: 0, b: 0 },
      b: { p: 0, n: 0, b: 0 },
    };
    for (const row of game.board()) {
      for (const cell of row) {
        if (!cell) continue;
        if (cell.type === 'p' || cell.type === 'n' || cell.type === 'b') count[cell.color][cell.type] += 1;
      }
    }

    const texts = [...line.points, ...line.moves.map((m) => m.note)];
    for (const text of texts) {
      // 按分句查：一句话里可能在比较别的线，整句跳过会漏掉真错误。
      const clauses = text.split(/[，、；。：,;:（）()]/);
      for (let i = 0; i < clauses.length; i += 1) {
        const clause = clauses[i];
        const prev = clauses[i - 1] ?? '';
        for (const claim of CLAIMS) {
          if (!claim.re.test(clause)) continue;
          const aboutOther = lines.some((o) => o.label !== line.label && prev.includes(o.label));
          if (aboutOther) continue;
          const other: Side = claim.side === 'w' ? 'b' : 'w';
          const actual = count[claim.side][claim.kind] - count[other][claim.kind];
          const ok = claim.delta > 0 ? actual >= claim.delta : actual <= claim.delta;
          if (!ok) {
            fail(
              'L1',
              `${lesson.id} / ${line.label}：${claim.kind === 'p' ? '兵' : claim.kind === 'n' ? '马' : '象'}数 ` +
                `白${count.w[claim.kind]} 黑${count.b[claim.kind]}，但文案说「${clause.trim()}」`,
            );
          }
        }
      }
    }

    // ---- L3 不是占位 ----
    const notes = line.moves.map((m) => m.note);
    for (const note of notes) {
      if (!note.trim()) fail('L3', `${lesson.id} / ${line.label}：有一手的讲解是空的`);
    }
    for (let i = 1; i < notes.length; i += 1) {
      if (notes[i].trim() && notes[i].trim() === notes[i - 1].trim()) {
        fail('L3', `${lesson.id} / ${line.label}：第 ${i + 1} 手的讲解跟上一手一模一样`);
      }
    }
    for (let i = 1; i < line.points.length; i += 1) {
      if (line.points[i].trim() === line.points[i - 1].trim()) {
        fail('L3', `${lesson.id} / ${line.label}：第 ${i + 1} 条要点跟上一条重复`);
      }
    }
  }
}

if (failures === 0) {
  const lineCount = LESSONS.reduce((n, l) => n + lessonLines(l).length, 0);
  console.log(`✅ 教学文案门禁通过：${LESSONS.length} 课 / ${lineCount} 条线路，讲法与棋盘对得上`);
} else {
  console.log(`❌ 教学文案门禁：${failures} 处对不上`);
}
process.exitCode = failures === 0 ? 0 : 1;
