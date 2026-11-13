import { describe, expect, it } from 'vitest';
import {
  displayCellAtPoint,
  displayCellToSquare,
  squareUnderPiece,
  worldToSquare,
} from '../src/lib/dragGeometry';
import { squareToWorld } from '../src/components/pieceGeometry';

const FILES = 'abcdefgh';

describe('拖拽落点几何', () => {
  describe('2D：屏幕点 → 显示格', () => {
    const rect = { left: 100, top: 50, width: 400, height: 400 };

    it('左上角落在第 0 行第 0 列', () => {
      expect(displayCellAtPoint(rect, 101, 51)).toEqual({ col: 0, row: 0 });
    });

    it('每格中心落在对应的那一格', () => {
      // 第 3 列第 3 行的中心 = 左上角 + (3.5 格, 3.5 格)，每格 50px
      expect(displayCellAtPoint(rect, 100 + 3.5 * 50, 50 + 3.5 * 50)).toEqual({
        col: 3,
        row: 3,
      });
    });

    it('每格边界算在「下一格」（不含边界的那一格）', () => {
      // 第 4 列的左边界 x = 100 + 4*50 = 300
      expect(displayCellAtPoint(rect, 300, 100)).toEqual({ col: 4, row: 1 });
    });

    it('棋盘外 → null（拖到外面松手 = 没有落点）', () => {
      expect(displayCellAtPoint(rect, 99, 100)).toBeNull();
      expect(displayCellAtPoint(rect, 500, 100)).toBeNull();
      expect(displayCellAtPoint(rect, 100, 49)).toBeNull();
      expect(displayCellAtPoint(rect, 100, 450)).toBeNull();
    });

    it('棋盘尺寸为 0 时不崩', () => {
      expect(displayCellAtPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull();
    });
  });

  describe('2D：显示格 → 真实格名', () => {
    it('白方视角：列=文件，行=rank 8 在上', () => {
      expect(displayCellToSquare(0, 0, 'w')).toBe('a8');
      expect(displayCellToSquare(7, 7, 'w')).toBe('h1');
      expect(displayCellToSquare(4, 3, 'w')).toBe('e5');
    });

    it('黑方视角：整个棋盘 180° 翻转', () => {
      expect(displayCellToSquare(0, 0, 'b')).toBe('h1');
      expect(displayCellToSquare(7, 7, 'b')).toBe('a8');
      expect(displayCellToSquare(3, 4, 'b')).toBe('e5');
    });

    it('两个视角互为 180° 旋转（同一格的两个位置）', () => {
      for (let col = 0; col < 8; col += 1) {
        for (let row = 0; row < 8; row += 1) {
          const w = displayCellToSquare(col, row, 'w');
          const b = displayCellToSquare(7 - col, 7 - row, 'b');
          expect(b).toBe(w);
        }
      }
    });
  });

  describe('2D：落点按「棋子中心」判定（不是光标）', () => {
    const rect = { left: 100, top: 50, width: 400, height: 400 };
    /** 每格 50px */
    const CELL = 50;

    it('没拖动 → 落回原格', () => {
      // d7 在白方视角：col=3、row=1
      expect(squareUnderPiece(rect, 3, 1, 0, 0, 'w')).toBe('d7');
    });

    it('向下拖一格 → 落到下一行', () => {
      // 白方视角向下一行 = rank 减一
      expect(squareUnderPiece(rect, 3, 1, 0, CELL, 'w')).toBe('d6');
    });

    it('向左拖一格 → 落到相邻文件', () => {
      expect(squareUnderPiece(rect, 3, 1, -CELL, 0, 'w')).toBe('c7');
    });

    it('黑方视角：同一个显示格是另一个真实格', () => {
      // 黑方视角 d7 在 col=4、row=6
      expect(squareUnderPiece(rect, 4, 6, 0, 0, 'b')).toBe('d7');
      // 黑方视角里向屏幕下方拖 = 往 rank 8 走（整盘 180° 翻转）
      expect(squareUnderPiece(rect, 4, 6, 0, CELL, 'b')).toBe('d8');
      // 黑方视角里向屏幕右方拖 = 往 a 文件走（所以是 c，不是 e）
      expect(squareUnderPiece(rect, 4, 6, CELL, 0, 'b')).toBe('c7');
    });

    it('拖出棋盘外 → null（没有落点 = 不走子）', () => {
      expect(squareUnderPiece(rect, 3, 1, 400, 0, 'w')).toBeNull();
      expect(squareUnderPiece(rect, 3, 1, 0, -400, 'w')).toBeNull();
    });

    it('棋盘尺寸为 0 时不崩', () => {
      expect(squareUnderPiece({ left: 0, top: 0, width: 0, height: 0 }, 3, 1, 0, 0, 'w')).toBeNull();
    });
  });

  describe('3D：世界坐标 → 真实格名', () => {
    it('与 squareToWorld 严格互逆（64 格全对）', () => {
      for (const file of FILES) {
        for (let rank = 1; rank <= 8; rank += 1) {
          const square = `${file}${rank}`;
          const w = squareToWorld(square);
          expect(worldToSquare(w.x, w.z)).toBe(square);
        }
      }
    });

    it('格心落在正确的那一格', () => {
      // a1 在近端（z = +3.5），h8 在远端（z = -3.5）
      expect(worldToSquare(-3.5, 3.5)).toBe('a1');
      expect(worldToSquare(3.5, -3.5)).toBe('h8');
      expect(worldToSquare(0, 0)).toBe('e4');
    });

    it('棋盘外 → null', () => {
      expect(worldToSquare(-4.5, 0)).toBeNull();
      expect(worldToSquare(4.5, 0)).toBeNull();
      expect(worldToSquare(0, -4.5)).toBeNull();
      expect(worldToSquare(0, 4.5)).toBeNull();
    });

    it('a 列与 h 列不会算成 -1 或 8（边界偏移最容易错的地方）', () => {
      // a 列中心 x=-3.5、h 列中心 x=3.5
      expect(worldToSquare(-3.5, 0)).toBe('a4');
      expect(worldToSquare(3.5, 0)).toBe('h4');
      // rank 8 的中心 z=-3.5、rank 1 的中心 z=3.5
      expect(worldToSquare(0, -3.5)).toBe('e8');
      expect(worldToSquare(0, 3.5)).toBe('e1');
    });
  });

  describe('2D 与 3D 落在同一格时要给出同一个格名', () => {
    it('同一个格子在两套坐标系里算出来的名字一致', () => {
      for (const file of FILES) {
        for (let rank = 1; rank <= 8; rank += 1) {
          const square = `${file}${rank}`;
          const w = squareToWorld(square);
          // 2D：这一格在白方视角下的显示位置
          const col = FILES.indexOf(file);
          const row = 8 - rank;
          expect(displayCellToSquare(col, row, 'w')).toBe(square);
          // 3D：同一格的世界坐标
          expect(worldToSquare(w.x, w.z)).toBe(square);
        }
      }
    });
  });
});
