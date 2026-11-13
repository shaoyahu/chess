import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  applyFreeMove,
  buildReplaySteps,
  flipSideToMove,
  freeCanDragFrom,
  freeTargets,
  positionAt,
} from '@/lib/replay';
import { START_FEN } from '@/lib/constants';
import type { MoveRecord } from '@/lib/types';

/**
 * 用真实对局造一条棋谱（走法交给 chess.js 生成 SAN 与记录）。
 *
 * 复盘是**按棋谱重放**的，所以棋谱必须是真的 —— 手写的 SAN
 * 会把「消歧」之类的细节写错，测的就不是复盘而是手写 SAN 对不对了。
 */
function recordMoves(sans: string[]): MoveRecord[] {
  const game = new Chess(START_FEN);
  const out: MoveRecord[] = [];
  for (const san of sans) {
    const move = game.move(san);
    out.push({
      from: move.from,
      to: move.to,
      piece: move.piece,
      color: move.color,
      san: move.san,
      captured: move.captured,
      promotion: move.promotion,
      flags: move.flags,
      ts: out.length,
    });
  }
  return out;
}

describe('buildReplaySteps：按棋谱重放', () => {
  it('空棋谱 → 没有步骤', () => {
    expect(buildReplaySteps([])).toEqual([]);
  });

  it('每一步都带上「走完之后」的局面', () => {
    const steps = buildReplaySteps(recordMoves(['e4', 'e5']));
    expect(steps).toHaveLength(2);
    expect(steps[0].san).toBe('e4');
    expect(steps[0].fen).toContain(' b ');
    expect(steps[1].san).toBe('e5');
    expect(steps[1].fen).toContain(' w ');
  });

  it('第 n 手之后的局面 == positionAt', () => {
    const steps = buildReplaySteps(recordMoves(['e4', 'e5', 'Nf3']));
    expect(positionAt(steps, 0)).toBe(START_FEN);
    expect(positionAt(steps, 1)).toBe(steps[0].fen);
    expect(positionAt(steps, 3)).toBe(steps[2].fen);
  });

  it('重放出来的局面和真的走一遍一致（将军、易位、吃过路兵）', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'];
    const steps = buildReplaySteps(recordMoves(sans));
    const live = new Chess(START_FEN);
    for (const san of sans) live.move(san);
    expect(steps[steps.length - 1].fen).toBe(live.fen());
  });

  it('升变也能重放（白兵一路吃到 a8 升后）', () => {
    const sans = ['e4', 'd5', 'exd5', 'c6', 'dxc6', 'Nf6', 'cxb7', 'Bd7', 'bxa8=Q'];
    const steps = buildReplaySteps(recordMoves(sans));
    expect(steps).toHaveLength(sans.length);
    expect(steps[steps.length - 1].promotion).toBe('q');
    const live = new Chess(START_FEN);
    for (const san of sans) live.move(san);
    expect(steps[steps.length - 1].fen).toBe(live.fen());
  });

  it('棋谱跟初始局面对不上时**到此为止**（不硬编）', () => {
    const bogus: MoveRecord[] = [
      {
        from: 'a1', to: 'a5', piece: 'r', color: 'w', san: 'a5', flags: 'n', ts: 0,
      },
    ];
    expect(buildReplaySteps(bogus)).toEqual([]);
  });
});

describe('flipSideToMove：翻转走子方', () => {
  it('走子方 w ↔ b', () => {
    expect(flipSideToMove(START_FEN).split(' ')[1]).toBe('b');
    expect(flipSideToMove(flipSideToMove(START_FEN)).split(' ')[1]).toBe('w');
  });

  it('吃过路兵格被清掉（留着会造出根本不存在的吃过路兵）', () => {
    // 白兵 e2-e4，黑兵在 d4 —— 这时**真的**有吃过路兵，chess.js 才会记下 ep 格
    const g = new Chess('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1');
    g.move('e4');
    expect(g.fen().split(' ')[3]).toBe('e3');
    expect(flipSideToMove(g.fen()).split(' ')[3]).toBe('-');
  });

  it('别的段（王车易位权、半回合数）原样保留', () => {
    const g = new Chess(START_FEN);
    g.move('e4');
    g.move('e5');
    g.move('Nf3');
    g.move('Nc6');
    g.move('Bc4');
    g.move('Bc5');
    g.move('O-O');
    const flipped = flipSideToMove(g.fen()).split(' ');
    const orig = g.fen().split(' ');
    expect(flipped[2]).toBe(orig[2]);
    expect(flipped[4]).toBe(orig[4]);
    expect(flipped[5]).toBe(orig[5]);
  });
});

describe('applyFreeMove：自由走棋（双方棋子都能动）', () => {
  it('走**对方**的子也合法 —— chess.js 本来只给走子方生成着法', () => {
    // 轮到白方，但让黑方的马走
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const result = applyFreeMove(fen, 'b8', 'c6');
    expect(result).not.toBeNull();
    expect(result!.step.color).toBe('b');
    expect(result!.step.san).toBe('Nc6');
  });

  it('走完之后轮到「走子方的对手」', () => {
    const fen = START_FEN;
    // 白方走 → 轮到黑方
    const white = applyFreeMove(fen, 'e2', 'e4')!;
    expect(white.fen.split(' ')[1]).toBe('b');
    // 黑方走（此时轮到黑方）→ 轮到白方
    const black = applyFreeMove(white.fen, 'e7', 'e5')!;
    expect(black.fen.split(' ')[1]).toBe('w');
  });

  it('轮到白方时让黑方的子走 → 走完仍然轮到白方（走子方的对手 = 白方）', () => {
    const fen = START_FEN;
    const blackMoves = applyFreeMove(fen, 'e7', 'e5')!;
    expect(blackMoves.step.color).toBe('b');
    expect(blackMoves.fen.split(' ')[1]).toBe('w');
  });

  it('非法着法返回 null（不改局面）', () => {
    expect(applyFreeMove(START_FEN, 'e2', 'e5')).toBeNull();
    expect(applyFreeMove(START_FEN, 'e7', 'e4')).toBeNull();
    expect(applyFreeMove(START_FEN, 'e2', 'e2')).toBeNull();
  });

  it('空格不能起走', () => {
    expect(applyFreeMove(START_FEN, 'e4', 'e5')).toBeNull();
  });

  it('吃子合法（走子方吃对方的子）', () => {
    const fen = '4k3/8/8/3pR3/8/8/8/4K3 w - - 0 1';
    const result = applyFreeMove(fen, 'e5', 'd5')!;
    expect(result.step.captured).toBe('p');
    expect(result.step.san).toBe('Rxd5');
  });

  it('不能走进自己王被将军的死局 —— 棋规照常管', () => {
    // 白王在 e1，黑车在 e8 压着 e 线，白车在 e2 挡着；
    // 白车一离开 e2，白王就被将军 —— 这步不合法
    const fen = '4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1';
    const result = applyFreeMove(fen, 'e2', 'f2');
    expect(result).toBeNull();
  });

  it('升变：兵到底线默认升后', () => {
    const fen = '8/4P3/8/8/8/8/8/k5K1 w - - 0 1';
    const result = applyFreeMove(fen, 'e7', 'e8')!;
    expect(result.step.promotion).toBe('q');
    expect(result.fen).toContain('Q');
  });
});

describe('freeTargets：自由走棋的落点提示', () => {
  it('对方的子也有落点提示', () => {
    const targets = freeTargets(START_FEN, 'b8').map((t) => t.to);
    expect(targets.sort()).toEqual(['a6', 'c6']);
  });

  it('自己的子照常有落点', () => {
    const targets = freeTargets(START_FEN, 'e2').map((t) => t.to);
    expect(targets.sort()).toEqual(['e3', 'e4']);
  });

  it('空格没有落点', () => {
    expect(freeTargets(START_FEN, 'e4')).toEqual([]);
  });

  it('不能起拖的格子（没子 / 没着）判 false', () => {
    expect(freeCanDragFrom(START_FEN, 'b8')).toBe(true);
    expect(freeCanDragFrom(START_FEN, 'e4')).toBe(false);
  });

  it('轮到黑方时，白方的子照样有落点（自由走棋不挑边）', () => {
    const g = new Chess(START_FEN);
    g.move('e4');
    expect(freeTargets(g.fen(), 'e2')).toEqual([]);
    // 白方的 e2 兵已经走了，d2 还在
    const targets = freeTargets(g.fen(), 'd2').map((t) => t.to);
    expect(targets.sort()).toEqual(['d3', 'd4']);
  });
});
