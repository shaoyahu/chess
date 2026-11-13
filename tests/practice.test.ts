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
  formationPosition,
  lessonPositions,
  lessonSteps,
} from '@/lib/practice/lessons';
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
  it('每一课的着法都合法，且 SAN 与讲解一一对应', () => {
    for (const lesson of LESSONS) {
      const game = new Chess(lesson.fen);
      for (const move of lesson.moves) {
        let played;
        try {
          played = game.move(move.san);
        } catch {
          throw new Error(`课程「${lesson.name}」的着法 ${move.san} 不合法`);
        }
        // SAN 必须和棋谱生成的一致（否则讲解里写的和棋盘上走的不是同一手）
        expect(played.san, `课程「${lesson.name}」的 ${move.san}`).toBe(move.san);
        expect(move.note.trim().length, `课程「${lesson.name}」的 ${move.san} 缺讲解`).toBeGreaterThan(0);
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
