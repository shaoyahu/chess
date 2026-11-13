import { describe, expect, it } from 'vitest';
import {
  applyMove,
  diffMove,
  isLegalMove,
  isChecked,
  legalTargets,
  allLegalMoves,
  pieceAt,
  statusOf,
  turnOf,
  isValidFen,
  IllegalMoveError,
} from '@/lib/chess-engine';
import { START_FEN } from '@/lib/constants';
import { Chess } from 'chess.js';

describe('合法着目标（选中棋子显示可到达点位）', () => {
  it('开局兵的落点只有 e3/e4', () => {
    const targets = legalTargets(START_FEN, 'e2');
    expect(targets.map((t) => t.to).sort()).toEqual(['e3', 'e4']);
  });

  it('开局马各有两个落点', () => {
    expect(legalTargets(START_FEN, 'b1')).toHaveLength(2);
    expect(legalTargets(START_FEN, 'g1')).toHaveLength(2);
  });

  it('开局后白方共有 20 个合法着', () => {
    let count = 0;
    for (const sq of [
      'a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1',
      'a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2',
    ]) {
      count += legalTargets(START_FEN, sq).length;
    }
    expect(count).toBe(20);
  });

  it('不能选中对方棋子作为自己的走子起点', () => {
    expect(legalTargets(START_FEN, 'e7', 'w')).toHaveLength(0);
  });

  it('空格没有落点', () => {
    expect(legalTargets(START_FEN, 'e4')).toHaveLength(0);
  });

  it('吃子落点带 capture 标记', () => {
    // 白车 e5 可以吃 d5 的黑兵
    const fen = '4k3/8/8/3pR3/8/8/8/4K3 w - - 0 1';
    const targets = legalTargets(fen, 'e5');
    expect(targets.some((t) => t.to === 'd5' && t.capture && t.capturedPiece === 'p')).toBe(
      true,
    );
  });
});

describe('走子合法性（服务端权威裁决）', () => {
  it('正常走子生效', () => {
    const out = applyMove(START_FEN, { from: 'e2', to: 'e4' });
    expect(out.san).toBe('e4');
    expect(out.fen.split(' ')[1]).toBe('b');
  });

  it('跳过中间棋子被拒绝', () => {
    expect(() => applyMove(START_FEN, { from: 'e2', to: 'e5' })).toThrow(IllegalMoveError);
  });

  it('斜着走兵被拒绝', () => {
    expect(() => applyMove(START_FEN, { from: 'e2', to: 'd3' })).toThrow(IllegalMoveError);
  });

  it('走到自己棋子占据的格子被拒绝', () => {
    expect(() => applyMove(START_FEN, { from: 'e2', to: 'e2' })).toThrow(IllegalMoveError);
  });

  it('送王被拒绝：白王被黑车照着时不能停在 e 线上', () => {
    // 黑车 e8 照着 e 线，白王 e1 被将军，必须离开 e 线
    const fen = '4r2k/8/8/8/8/8/8/4K3 w - - 0 1';
    expect(isLegalMove(fen, { from: 'e1', to: 'e2' })).toBe(false);
    expect(isLegalMove(fen, { from: 'e1', to: 'd1' })).toBe(true);
    expect(isLegalMove(fen, { from: 'e1', to: 'f1' })).toBe(true);
  });

  it('不是自己回合时不能走', () => {
    // 黑方回合，白车 d1 走子必须被拒
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
    expect(isLegalMove(fen, { from: 'd1', to: 'd2' })).toBe(false);
  });
});

describe('特殊规则', () => {
  it('王车易位：白方短易位', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const targets = legalTargets(fen, 'e1');
    // 王车易位的落点 c1 / g1 必须在列表里（另有王的普通走法）
    expect(targets.map((t) => t.to)).toContain('c1');
    expect(targets.map((t) => t.to)).toContain('g1');
    const out = applyMove(fen, { from: 'e1', to: 'g1' });
    expect(out.san).toBe('O-O');
    // 车也动了：h1 的车到了 f1
    expect(out.fen.split(' ')[0]).toContain('R4RK1');
  });

  it('长易位同样可用', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const out = applyMove(fen, { from: 'e1', to: 'c1' });
    expect(out.san).toBe('O-O-O');
    expect(out.fen.split(' ')[0]).toContain('2KR3R');
  });

  it('吃过路兵', () => {
    // 白兵 e5，黑刚走 d7-d5，白兵可以吃 d6
    const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
    const targets = legalTargets(fen, 'e5');
    expect(targets.map((t) => t.to)).toContain('d6');
    const out = applyMove(fen, { from: 'e5', to: 'd6' });
    expect(out.san).toBe('exd6');
    // 黑兵 d5 被吃掉了
    expect(out.fen.split(' ')[0]).not.toContain('p');
  });

  it('升变：兵到底线可以升变成 4 种棋子', () => {
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    const targets = legalTargets(fen, 'a7');
    expect(targets).toHaveLength(4);
    expect(targets.every((t) => t.promotionRequired)).toBe(true);
    expect(targets.map((t) => t.san).sort()).toEqual(['a8=B', 'a8=N', 'a8=Q+', 'a8=R+']);
  });

  it('升变可选马', () => {
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    const out = applyMove(fen, { from: 'a7', to: 'a8', promotion: 'n' });
    expect(out.san).toBe('a8=N');
    expect(pieceAt(out.fen, 'a8')).toEqual({ type: 'n', color: 'w' });
  });

  it('升变默认后', () => {
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    const out = applyMove(fen, { from: 'a7', to: 'a8' });
    expect(out.san).toBe('a8=Q+');
    expect(pieceAt(out.fen, 'a8')).toEqual({ type: 'q', color: 'w' });
  });

  it('黑方升变：兵走到第 1 行升变，4 种子力都可选', () => {
    // 黑兵 a2 即将走到 a1；白王 e1 在同一行，后/车升变会将军
    const fen = '4k3/8/8/8/8/8/p7/4K3 b - - 0 1';
    const targets = legalTargets(fen, 'a2');
    expect(targets).toHaveLength(4);
    expect(targets.every((t) => t.promotionRequired)).toBe(true);
    expect(targets.map((t) => t.san).sort()).toEqual(['a1=B', 'a1=N', 'a1=Q+', 'a1=R+']);
  });

  it('黑方升变选后（underpromotion to knight）', () => {
    const fen = '4k3/8/8/8/8/8/p7/4K3 b - - 0 1';
    const out = applyMove(fen, { from: 'a2', to: 'a1', promotion: 'n' });
    expect(out.san).toBe('a1=N');
    expect(pieceAt(out.fen, 'a1')).toEqual({ type: 'n', color: 'b' });
    // 升变后是黑方的马，颜色不能错
    expect(pieceAt(out.fen, 'a1')?.color).toBe('b');
  });

  it('黑方吃过路兵', () => {
    // 白兵 e4 刚走了 e2-e4，黑兵 d4 可以吃 e3
    const fen = '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1';
    const targets = legalTargets(fen, 'd4');
    expect(targets.map((t) => t.to)).toContain('e3');
    const out = applyMove(fen, { from: 'd4', to: 'e3' });
    expect(out.san).toBe('dxe3');
    // 被吃的白兵在 e4，不在 e3
    expect(pieceAt(out.fen, 'e4')).toBeNull();
    expect(pieceAt(out.fen, 'e3')).toEqual({ type: 'p', color: 'b' });
  });
});

/**
 * 双将（double check）。
 *
 * 规则要点：一旦形成双将，**除了王以外任何棋子都不能解将** ——
 * 因为一枚棋子不可能同时挡开两条将军线。
 * 引擎若把这步棋放行，就是把非法着法判成合法。
 */
describe('双将边界', () => {
  // 白车 h2 滑到 h8 后，黑王 e8 同时被白车（横线 h8→e8）和白马 c7（跳 e8）将军
  const BEFORE = '4k3/2N5/8/8/8/8/7R/6RK w - - 0 1';

  it('一步走子可以形成双将', () => {
    const targets = legalTargets(BEFORE, 'h2');
    expect(targets.map((t) => t.to)).toContain('h8');

    const out = applyMove(BEFORE, { from: 'h2', to: 'h8' });
    // 走后黑王 e8 处于双将
    expect(isChecked(out.fen, 'b')).toBe(true);
    // 双将必须来自两枚不同的子：白车在 h8、白马在 c7
    expect(pieceAt(out.fen, 'h8')).toEqual({ type: 'r', color: 'w' });
    expect(pieceAt(out.fen, 'c7')).toEqual({ type: 'n', color: 'w' });
  });

  it('双将时黑方除了走王没有任何合法着法', () => {
    const after = applyMove(BEFORE, { from: 'h2', to: 'h8' }).fen;
    const moves = allLegalMoves(after);

    expect(moves.length).toBeGreaterThan(0);
    // 唯一能动的子必须是王
    const kingTargets = moves.filter((m) => m.to);
    expect(kingTargets.length).toBeGreaterThan(0);
    // allLegalMoves 只给落点，这里直接确认没有「非王」的着法可用：
    // 用 chess.js 的完整着法列表核对
    const verbose = new Chess(after).moves({ verbose: true });
    expect(verbose.every((m) => m.piece === 'k')).toBe(true);
  });

  it('双将局面里黑方走王后不再是将军状态', () => {
    const after = applyMove(BEFORE, { from: 'h2', to: 'h8' }).fen;
    const escapes = allLegalMoves(after);
    expect(escapes.length).toBeGreaterThan(0);

    // 随便挑一个合法落点走一步，必须合法且不再被将
    const target = escapes[0].to;
    expect(isLegalMove(after, { from: 'e8', to: target })).toBe(true);
    const out = applyMove(after, { from: 'e8', to: target });
    expect(isChecked(out.fen, 'b')).toBe(false);
  });
});

describe('终局判定', () => {
  it('将死：黑方被将死', () => {
    // 后 g7 将军，黑王 h8 无处可逃
    const fen = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
    const status = statusOf(fen);
    expect(status.over).toBe(true);
    expect(status.result).toEqual({ winner: 'w', reason: 'checkmate' });
  });

  it('逼和：白方无子可动但未被将', () => {
    const fen = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
    const status = statusOf(fen);
    expect(status.over).toBe(true);
    expect(status.result?.reason).toBe('stalemate');
  });

  it('双方只剩王时子力不足判和', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const status = statusOf(fen);
    expect(status.over).toBe(true);
    expect(status.result?.reason).toBe('material');
  });

  it('王加象对王也判子力不足', () => {
    const fen = '4k3/8/8/8/8/8/8/3BK3 w - - 0 1';
    expect(statusOf(fen).result?.reason).toBe('material');
  });

  it('将军状态可被识别', () => {
    const fen = '4k3/8/8/8/8/8/4R3/4K3 b - - 0 1';
    const status = statusOf(fen);
    expect(status.over).toBe(false);
    expect(status.inCheck).toBe(true);
  });

  it('普通局面未结束', () => {
    const status = statusOf(START_FEN);
    expect(status.over).toBe(false);
    expect(status.inCheck).toBe(false);
  });
});

describe('FEN 与差分', () => {
  it('合法 FEN 校验', () => {
    expect(isValidFen(START_FEN)).toBe(true);
    expect(isValidFen('garbage')).toBe(false);
  });

  it('走子方解析', () => {
    expect(turnOf(START_FEN)).toBe('w');
    const out = applyMove(START_FEN, { from: 'e2', to: 'e4' });
    expect(turnOf(out.fen)).toBe('b');
  });

  it('差分：普通走子', () => {
    const after = applyMove(START_FEN, { from: 'e2', to: 'e4' }).fen;
    const diff = diffMove(START_FEN, after);
    expect(diff).toMatchObject({ from: 'e2', to: 'e4', piece: 'p', color: 'w' });
  });

  it('差分：王车易位能识别出车的位移', () => {
    const before = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const after = applyMove(before, { from: 'e1', to: 'g1' }).fen;
    const diff = diffMove(before, after);
    expect(diff).toMatchObject({ from: 'e1', to: 'g1' });
    expect(diff?.rookFrom).toBe('h1');
    expect(diff?.rookTo).toBe('f1');
  });

  it('差分：吃子能识别被吃的棋子', () => {
    const before = '4k3/8/8/3pR3/8/8/8/4K3 w - - 0 1';
    const after = applyMove(before, { from: 'e5', to: 'd5' }).fen;
    const diff = diffMove(before, after);
    expect(diff?.captured).toBe('p');
    expect(diff).toMatchObject({ from: 'e5', to: 'd5', piece: 'r' });
  });

  it('差分：升变能识别出升变后的棋子', () => {
    const before = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    const after = applyMove(before, { from: 'a7', to: 'a8', promotion: 'n' }).fen;
    const diff = diffMove(before, after);
    expect(diff?.promotion).toBe('n');
    expect(diff?.piece).toBe('n');
  });
});
