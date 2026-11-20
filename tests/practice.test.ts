/**
 * 「教学练习」的纯逻辑守卫。
 *
 * 重点守三件事：
 *  1. **每一课的着法都真能走**（写错 SAN 是这类内容最容易出的错）；
 *  2. **摆法与讲解自洽**（摆法局面由着法推导，不手写 FEN，就不可能对不上）；
 *  3. **摆棋的合法性判据与 chess.js 一致**（少王、多王、兵站错排都要拦住）。
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { START_FEN } from '@/lib/constants';
import {
  LESSONS,
  LESSON_TAGS,
  formationPosition,
  lessonLines,
  lessonPositions,
  lessonSteps,
  resolveLine,
} from '@/lib/practice/lessons';
import { positionAt, pushStep, type PracticeStep } from '@/lib/practice/history';
import {
  buildPracticeFen,
  emptyPlacement,
  placementFromFen,
  placementToFen,
  placePiece,
  removePiece,
  standardPlacement,
  validatePlacement,
} from '@/lib/practice/setup';

describe('教学课程', () => {
  it('每一课每条线路的着法都合法，且 SAN 与讲解一一对应', () => {
    for (const lesson of LESSONS) {
      // 一课可能有多条线路（应对课：对方有几种正经应手），每条都要真能走通
      for (const line of lessonLines(lesson)) {
        const game = new Chess(lesson.fen);
        for (const move of line.moves) {
          let played;
          try {
            played = game.move(move.san);
          } catch {
            throw new Error(`课程「${lesson.name}」(${line.label}) 的着法 ${move.san} 不合法`);
          }
          // SAN 必须和棋谱生成的一致（否则讲解里写的和棋盘上走的不是同一手）
          expect(played.san, `课程「${lesson.name}」(${line.label}) 的 ${move.san}`).toBe(move.san);
          expect(move.note.trim().length, `课程「${lesson.name}」(${line.label}) 的 ${move.san} 缺讲解`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('每一课的起始局面都是合法 FEN', () => {
    for (const lesson of LESSONS) {
      expect(() => new Chess(lesson.fen), `课程「${lesson.name}」起始局面非法`).not.toThrow();
    }
  });

  it('演示线的每一步都是合法局面，且步数与讲解条数一致', () => {
    for (const lesson of LESSONS) {
      const steps = lessonSteps(lesson);
      expect(steps.length, `课程「${lesson.name}」演示线被截断了`).toBe(lesson.moves.length + 1);
      for (const step of steps) {
        expect(() => new Chess(step.fen)).not.toThrow();
      }
      // 起始局面 + 每走一手局面
      expect(lessonPositions(lesson).length).toBe(lesson.moves.length + 1);
      // 每一步都要有起点与终点（棋盘要画「上一步」箭头）
      for (const step of steps.slice(1)) {
        expect(step.from).toBeTruthy();
        expect(step.to).toBeTruthy();
      }
    }
  });

  it('「典型摆法」的着法合法，且摆法局面与讲解同源', () => {
    for (const lesson of LESSONS) {
      if (!lesson.formation) continue;
      const fen = formationPosition(lesson);
      expect(fen, `课程「${lesson.name}」的摆法走不通`).toBeTruthy();
      expect(() => new Chess(fen as string)).not.toThrow();
      expect(lesson.formation.points.length, `课程「${lesson.name}」的摆法缺要点`).toBeGreaterThan(0);
      expect(lesson.formation.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('每一课都有名字、定位与要点', () => {
    const ids = new Set<string>();
    for (const lesson of LESSONS) {
      expect(lesson.id.trim().length).toBeGreaterThan(0);
      expect(ids.has(lesson.id), `课程 id 重复：${lesson.id}`).toBe(false);
      ids.add(lesson.id);
      expect(lesson.name.trim().length).toBeGreaterThan(0);
      expect(lesson.summary.trim().length).toBeGreaterThan(0);
      expect(lesson.points.length, `课程「${lesson.name}」缺要点`).toBeGreaterThan(0);
      expect(lesson.moves.length, `课程「${lesson.name}」没有演示着法`).toBeGreaterThan(0);
    }
  });

  it('课程 id 唯一（页面用它做 URL 锚点与选中态）', () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('多线路课（应对类）', () => {
  it('每一课每条线路都能走到终局，且步数与着法条数一致', () => {
    for (const lesson of LESSONS) {
      for (const line of lessonLines(lesson)) {
        const steps = lessonSteps(lesson, line.id === '__main' ? null : line.id);
        expect(
          steps.length,
          `课程「${lesson.name}」(${line.label}) 的演示线被截断了`,
        ).toBe(line.moves.length + 1);
        for (const step of steps) {
          expect(() => new Chess(step.fen)).not.toThrow();
        }
        for (const step of steps.slice(1)) {
          expect(step.from).toBeTruthy();
          expect(step.to).toBeTruthy();
        }
      }
    }
  });

  it('切线路会换掉整套演示线（局面与要点都跟着变）', () => {
    for (const lesson of LESSONS) {
      for (const line of lesson.lines ?? []) {
        const main = lessonSteps(lesson, null);
        const alt = lessonSteps(lesson, line.id);
        expect(alt.length, `课程「${lesson.name}」切到 ${line.label} 后步数不对`).toBe(line.moves.length + 1);
        // 每一步的局面都得和主线不一样 —— 否则「切线路」只是个摆设
        const mainFens = main.map((s) => s.fen);
        const altFens = alt.map((s) => s.fen);
        expect(altFens).not.toEqual(mainFens);
        expect(altFens[0]).toBe(mainFens[0]);
      }
    }
  });

  it('多线路课的元数据完整：主线有名字、线路 id 不重名、每条都有要点', () => {
    for (const lesson of LESSONS) {
      if (!lesson.lines || lesson.lines.length === 0) continue;
      expect(
        lesson.mainLabel?.trim().length,
        `课程「${lesson.name}」是多线路课，必须给主线起个名字`,
      ).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const line of lesson.lines) {
        expect(ids.has(line.id), `课程「${lesson.name}」的线路 id 重复：${line.id}`).toBe(false);
        ids.add(line.id);
        expect(line.label.trim().length, `课程「${lesson.name}」有条线路没名字`).toBeGreaterThan(0);
        expect(line.moves.length, `课程「${lesson.name}」的 ${line.label} 没有着法`).toBeGreaterThan(0);
        expect(line.points.length, `课程「${lesson.name}」的 ${line.label} 缺要点`).toBeGreaterThan(0);
      }
      // 所有线路的名字不能重名，否则切换按钮分不清
      const labels = lessonLines(lesson).map((l) => l.label);
      expect(new Set(labels).size, `课程「${lesson.name}」的线路名重复`).toBe(labels.length);
    }
  });

  it('找不到线路时回主线（不会崩，也不会显示空气）', () => {
    for (const lesson of LESSONS) {
      const fallback = resolveLine(lesson, '不存在的线路');
      expect(fallback.id).toBe('__main');
      expect(fallback.moves).toBe(lesson.moves);
      expect(fallback.points).toBe(lesson.points);
    }
  });

  it('「应对」课必须标明是站在哪一方讲的', () => {
    const counters = LESSONS.filter((l) => l.tag === '应对');
    expect(counters.length, '一节「应对」课都没有').toBeGreaterThan(0);
    for (const lesson of counters) {
      expect(
        lesson.side,
        `课程「${lesson.name}」是对付某开局的课，必须写清是白方还是黑方`,
      ).toBeTruthy();
      // 应对课讲的是「对方开了这个局我方怎么接」，所以线要从第 1 步开始
      expect(lesson.fen, `课程「${lesson.name}」的起始局面不是初始局面`).toBe(START_FEN);
    }
  });

  it('「应对」课至少两条线路（只有一条的话，切线路就是摆设）', () => {
    const counters = LESSONS.filter((l) => l.tag === '应对');
    expect(counters.length, '一节「应对」课都没有').toBeGreaterThan(0);
    for (const lesson of counters) {
      /*
       * 至少两条线路（主线 + 至少一条备用）——
       * 只有一条线的话，「切线路」这个功能对它就是摆设，
       * 而上面那条「切线路会换掉整套演示线」会因为没有备用线而**空转通过**。
       */
      expect(
        lessonLines(lesson).length,
        `课程「${lesson.name}」只有一条线路，切换功能对它没意义`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('每一课都属于某个已知分类，且分类名不重复', () => {
    for (const lesson of LESSONS) {
      expect(LESSON_TAGS as readonly string[]).toContain(lesson.tag);
    }
  });
});

describe('摆棋', () => {
  it('标准摆法能原样转回初始 FEN', () => {
    const placement = standardPlacement();
    expect(placementToFen(placement, 'w')).toBe(START_FEN);
  });

  it('摆法 → FEN → 摆法 能往返', () => {
    const original = standardPlacement();
    const fen = placementToFen(original, 'b');
    const back = placementFromFen(fen);
    expect(back.size).toBe(original.size);
    for (const [square, piece] of original) {
      expect(back.get(square)).toEqual(piece);
    }
  });

  it('黑方先走时，FEN 的第二段是 b', () => {
    const fen = placementToFen(standardPlacement(), 'b');
    expect(fen.split(' ')[1]).toBe('b');
  });

  it('王离开起始格就没有易位权', () => {
    const withoutKing = removePiece(standardPlacement(), 'e1');
    const moved = placePiece(withoutKing, 'f1', { type: 'k', color: 'w' });
    expect(placementToFen(moved, 'w').split(' ')[2]).not.toContain('K');
  });

  it('缺王 / 多王 / 兵站外圈都要拦住', () => {
    const noKing = removePiece(standardPlacement(), 'e1');
    expect(validatePlacement(noKing)).toBe('白方缺一个王');

    const twoKings = placePiece(standardPlacement(), 'a4', { type: 'k', color: 'w' });
    expect(validatePlacement(twoKings)).toBe('白方不能有两个王');

    const pawnOnBackRank = placePiece(standardPlacement(), 'a1', { type: 'p', color: 'w' });
    expect(validatePlacement(pawnOnBackRank)).toBe('兵不能站在第一排或第八排');

    expect(validatePlacement(standardPlacement())).toBeNull();
  });

  it('开始练习前拼出的 FEN 一定能被 chess.js 接受', () => {
    const ok = buildPracticeFen(standardPlacement(), 'w');
    expect(ok.error).toBeNull();
    expect(ok.fen).toBe(START_FEN);
    expect(() => new Chess(ok.fen as string)).not.toThrow();

    const bad = buildPracticeFen(emptyPlacement(), 'w');
    expect(bad.fen).toBeNull();
    expect(bad.error).toBeTruthy();
  });

  it('摆棋过程中的中间状态（还没摆完）不会崩', () => {
    // 摆到一半：只有白方的子 —— 校验要报错，但不能抛异常
    const half = removePiece(removePiece(standardPlacement(), 'e8'), 'e1');
    expect(validatePlacement(half)).toBeTruthy();
  });
});


/* ------------------------------------------------------------------ */
/* 自由练习的历史游标（上一步 / 下一步）                               */
/* ------------------------------------------------------------------ */

describe('自由练习的历史游标', () => {
  /** 造一步练习记录（局面由 chess.js 推出来，不手写） */
  const step = (fen: string, san: string, color: 'w' | 'b'): PracticeStep => ({
    san,
    color,
    from: 'e2',
    to: 'e4',
    fen,
  });

  it('游标 0 = 起始局面', () => {
    expect(positionAt(START_FEN, [], 0)).toBe(START_FEN);
  });

  it('局面跟着游标走：第 n 手之后 = steps[n-1] 的局面', () => {
    const steps = [step('fen-1', 'e4', 'w'), step('fen-2', 'e5', 'b')];
    expect(positionAt(START_FEN, steps, 1)).toBe('fen-1');
    expect(positionAt(START_FEN, steps, 2)).toBe('fen-2');
  });

  it('游标超出棋谱长度时退回最后一手（不越界）', () => {
    const steps = [step('fen-1', 'e4', 'w')];
    expect(positionAt(START_FEN, steps, 5)).toBe('fen-1');
    expect(positionAt(START_FEN, steps, -3)).toBe(START_FEN);
  });

  it('在中间落新的一手 → 后面的旧着法被截断', () => {
    const steps = [step('fen-1', 'e4', 'w'), step('fen-2', 'e5', 'b'), step('fen-3', 'Nf3', 'w')];
    // 游标在 1（刚走完 e4），此时落一手 → 只剩 e4 + 新的一手
    const next = pushStep(steps, 1, step('fen-new', 'Nc3', 'w'));
    expect(next).toHaveLength(2);
    expect(next[1].san).toBe('Nc3');
    // 原来的 e5 / Nf3 没了 —— 换了一条线，后面的着法不再成立
    expect(next.map((x) => x.san)).toEqual(['e4', 'Nc3']);
  });

  it('在末尾落新的一手 → 只是追加', () => {
    const steps = [step('fen-1', 'e4', 'w'), step('fen-2', 'e5', 'b')];
    const next = pushStep(steps, 2, step('fen-3', 'Nf3', 'w'));
    expect(next).toHaveLength(3);
    expect(next[2].san).toBe('Nf3');
  });

  it('游标在末尾时落子不会丢棋谱', () => {
    const steps = [step('fen-1', 'e4', 'w')];
    const next = pushStep(steps, 1, step('fen-2', 'e5', 'b'));
    expect(next.map((x) => x.san)).toEqual(['e4', 'e5']);
  });
});
