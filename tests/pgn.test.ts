import { describe, expect, it } from 'vitest';
import { buildPgn, pairMoves, pgnDate, pgnResultString } from '../src/lib/pgn';
import type { MoveRecord } from '../src/lib/types';

/** 造一条着法记录（只需要 PGN 用到的字段） */
function mv(
  color: 'w' | 'b',
  san: string,
  from = 'a1',
  to = 'a2',
): MoveRecord {
  return {
    from,
    to,
    piece: 'p',
    color,
    san,
    flags: 'n',
    ts: 0,
  };
}

describe('pairMoves', () => {
  it('空棋谱返回空数组', () => {
    expect(pairMoves([])).toEqual([]);
  });

  it('白黑两着配成一个回合', () => {
    const pairs = pairMoves([mv('w', 'e4'), mv('b', 'e5')]);
    expect(pairs).toEqual([{ no: 1, white: 'e4', black: 'e5' }]);
  });

  it('黑方还没走时黑着为空', () => {
    const pairs = pairMoves([mv('w', 'e4')]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].white).toBe('e4');
    expect(pairs[0].black).toBeUndefined();
  });

  it('回合号连续递增', () => {
    const pairs = pairMoves([
      mv('w', 'e4'),
      mv('b', 'e5'),
      mv('w', 'Nf3'),
      mv('b', 'Nc6'),
      mv('w', 'Bb5'),
    ]);
    expect(pairs.map((p) => p.no)).toEqual([1, 2, 3]);
    expect(pairs[2].white).toBe('Bb5');
  });
});

describe('pgnResultString', () => {
  it('无结果 → *', () => {
    expect(pgnResultString(undefined)).toBe('*');
  });

  it('和棋 → 1/2-1/2', () => {
    expect(pgnResultString({ winner: 'draw', reason: 'draw' })).toBe('1/2-1/2');
  });

  it('白胜 → 1-0，黑胜 → 0-1', () => {
    expect(pgnResultString({ winner: 'w', reason: 'resign' })).toBe('1-0');
    expect(pgnResultString({ winner: 'b', reason: 'resign' })).toBe('0-1');
  });
});

describe('pgnDate', () => {
  it('补零成 YYYY.MM.DD', () => {
    expect(pgnDate(new Date(2026, 0, 5))).toBe('2026.01.05');
    expect(pgnDate(new Date(2026, 10, 30))).toBe('2026.11.30');
  });
});

describe('buildPgn', () => {
  it('包含标准头标签与着法正文', () => {
    const pgn = buildPgn({
      moves: [mv('w', 'e4'), mv('b', 'e5')],
      whiteName: '白方',
      blackName: '黑方',
      date: new Date(2026, 0, 5),
    });
    expect(pgn).toContain('[Event "局域网国际象棋"]');
    expect(pgn).toContain('[White "白方"]');
    expect(pgn).toContain('[Black "黑方"]');
    expect(pgn).toContain('[Date "2026.01.05"]');
    expect(pgn).toContain('1. e4 e5');
    // 未结束的对局结果串是 *
    expect(pgn.trimEnd().endsWith('*')).toBe(true);
  });

  it('带时限标签与结果', () => {
    const pgn = buildPgn({
      moves: [mv('w', 'e4')],
      whiteName: 'A',
      blackName: 'B',
      timeControl: '10+0',
      result: { winner: 'w', reason: 'resign' },
      date: new Date(2026, 0, 5),
    });
    expect(pgn).toContain('[TimeControl "10+0"]');
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn.trimEnd().endsWith('1-0')).toBe(true);
  });

  it('空棋谱也产出合法头标签', () => {
    const pgn = buildPgn({
      moves: [],
      whiteName: 'A',
      blackName: 'B',
      date: new Date(2026, 0, 5),
    });
    expect(pgn).toContain('[White "A"]');
    expect(pgn.trimEnd().endsWith('*')).toBe(true);
  });
});
