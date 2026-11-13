import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { applyMove, buildFromFen } from '@/lib/pieceTracker';
import { diffMove } from '@/lib/chess-engine';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * 按 SAN 序列走出若干步，返回每一步前后的 FEN。
 * 局面全部由 chess.js 构造，避免手写 FEN 出错（写错会让断言测的东西完全不是它）。
 */
function history(sans: string[]): Array<{ before: string; after: string; san: string }> {
  const game = new Chess();
  const out: Array<{ before: string; after: string; san: string }> = [];
  for (const san of sans) {
    const before = game.fen();
    game.move(san);
    out.push({ before, after: game.fen(), san });
  }
  return out;
}

describe('棋子身份追踪（pieceTracker）', () => {
  it('普通走子：走子方保留同一个 id', () => {
    const { before, after } = history(['e4'])[0];
    const tracked = buildFromFen(before);
    const pawn = tracked.find((p) => p.square === 'e2')!;

    const next = applyMove(tracked, before, after)!;
    const moved = next.find((p) => p.id === pawn.id)!;
    expect(moved.square).toBe('e4');
    expect(next).toHaveLength(32);
  });

  it('吃子：被吃的子必须被移除，且走子方保留 id（否则动画会失效）', () => {
    const { before, after } = history(['e4', 'e5', 'd4', 'exd4'])[3];
    const tracked = buildFromFen(before);

    const capturer = tracked.find((p) => p.square === 'e5')!;
    const victim = tracked.find((p) => p.square === 'd4')!;
    expect(victim).toBeDefined();
    expect(victim.color).toBe('w');

    const next = applyMove(tracked, before, after)!;
    // 被吃的子消失
    expect(next.find((p) => p.id === victim.id)).toBeUndefined();
    // 走子方保留 id 并落到目标格
    const moved = next.find((p) => p.id === capturer.id)!;
    expect(moved.square).toBe('d4');
    expect(moved.color).toBe('b');
    expect(next).toHaveLength(31);
  });

  it('吃子：diffMove 能给出被吃棋子的所在格', () => {
    const { before, after } = history(['e4', 'e5', 'd4', 'exd4'])[3];
    const diff = diffMove(before, after)!;
    expect(diff.from).toBe('e5');
    expect(diff.to).toBe('d4');
    expect(diff.captured).toBe('p');
    expect(diff.capturedSquare).toBe('d4');
  });

  it('吃过路兵：被吃的兵在另一个格，也要被正确移除', () => {
    // 白 f2-f4（双步），黑 g4xf3 吃过路兵：黑兵吃掉 f4 的白兵，落到 f3
    const game = new Chess('4k3/8/8/8/6p1/8/5P2/4K3 w - - 0 1');
    game.move('f4');
    const before = game.fen();
    game.move('gxf3');
    const after = game.fen();
    const tracked = buildFromFen(before);

    const victim = tracked.find((p) => p.square === 'f4')!;
    const mover = tracked.find((p) => p.square === 'g4')!;
    expect(victim).toBeDefined();

    const diff = diffMove(before, after)!;
    expect(diff.capturedSquare).toBe('f4');

    const next = applyMove(tracked, before, after)!;
    expect(next.find((p) => p.id === victim.id)).toBeUndefined();
    expect(next.find((p) => p.id === mover.id)!.square).toBe('f3');
    // 这个残局只有 4 枚子（双王 + 2 兵），吃子后剩 3 枚
    expect(next).toHaveLength(3);
  });

  it('升变：id 保持不变、类型改变', () => {
    // 白兵从 b7 走到 b8 升变（用 SAN 走一步到 b8 再手动换类型比较繁琐，
    // 这里直接用 chess.js 的合法着法序列）
    const game = new Chess('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    const before = game.fen();
    game.move('b8=Q');
    const after = game.fen();

    const tracked = buildFromFen(before);
    const pawn = tracked.find((p) => p.square === 'b7')!;

    const next = applyMove(tracked, before, after)!;
    const promoted = next.find((p) => p.id === pawn.id)!;
    expect(promoted.type).toBe('q');
    expect(promoted.square).toBe('b8');
    expect(next).toHaveLength(3);
  });

  it('黑方升变：id 保持不变、类型与颜色都对', () => {
    // 黑兵 b2 走到 b1 升变
    const game = new Chess('4k3/8/8/8/8/8/1p6/4K3 b - - 0 1');
    const before = game.fen();
    game.move('b1=N');
    const after = game.fen();

    const tracked = buildFromFen(before);
    const pawn = tracked.find((p) => p.square === 'b2')!;
    expect(pawn.color).toBe('b');

    const next = applyMove(tracked, before, after)!;
    const promoted = next.find((p) => p.id === pawn.id)!;
    expect(promoted.type).toBe('n');
    expect(promoted.color).toBe('b');
    expect(promoted.square).toBe('b1');
  });

  it('升变并吃子：被吃的子与升变子都要处理对', () => {
    const game = new Chess('r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    const before = game.fen();
    game.move('bxa8=Q');
    const after = game.fen();

    const tracked = buildFromFen(before);
    const pawn = tracked.find((p) => p.square === 'b7')!;
    const rook = tracked.find((p) => p.square === 'a8')!;

    const next = applyMove(tracked, before, after)!;
    expect(next.find((p) => p.id === rook.id)).toBeUndefined();
    const promoted = next.find((p) => p.id === pawn.id)!;
    expect(promoted.type).toBe('q');
    expect(promoted.square).toBe('a8');
    expect(next).toHaveLength(3);
  });

  it('王车易位：王与车都保留 id', () => {
    const { before, after } = history(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'])[6];
    const tracked = buildFromFen(before);
    const king = tracked.find((p) => p.square === 'e1')!;
    const rook = tracked.find((p) => p.square === 'h1')!;

    const next = applyMove(tracked, before, after)!;
    expect(next.find((p) => p.id === king.id)!.square).toBe('g1');
    expect(next.find((p) => p.id === rook.id)!.square).toBe('f1');
    expect(next).toHaveLength(32);
  });

  it('局面突变（重开）时返回 null，交由调用方整体重建', () => {
    const tracked = buildFromFen(START);
    // 一个完全不同的合法局面（只剩两个王）→ 差分推不出「一步棋」→ 一致性校验失败 → 返回 null
    const other = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    expect(applyMove(tracked, START, other)).toBeNull();
  });

  it('tracked 结果永远与 FEN 一致（随机对局回归）', () => {
    const sans = [
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
      'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Nb8', 'd4', 'Nbd7',
    ];
    let tracked = buildFromFen(START);
    for (const step of history(sans)) {
      const next = applyMove(tracked, step.before, step.after);
      expect(next, `第 ${step.san} 手之后追踪结果应保持一致`).not.toBeNull();
      tracked = next!;
      const board = new Chess(step.after).board().flat().filter(Boolean);
      expect(tracked).toHaveLength(board.length);
      for (const piece of tracked) {
        const real = new Chess(step.after).get(piece.square as never);
        expect(real).not.toBeNull();
        expect(real!.type).toBe(piece.type);
        expect(real!.color).toBe(piece.color);
      }
    }
  });
});
