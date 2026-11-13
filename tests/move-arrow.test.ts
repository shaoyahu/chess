import { describe, expect, it } from 'vitest';
import {
  ARROW_2D,
  ARROW_3D,
  DEFAULT_ARROW,
  arrowCenter,
  arrowPolygon,
} from '../src/lib/moveArrow';

describe('moveArrow：走子箭头几何', () => {
  it('返回 7 个顶点（杆 4 + 肩 2 + 尖 1）', () => {
    const poly = arrowPolygon({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(poly).toHaveLength(7);
  });

  it('箭头尖落在终点格心上', () => {
    const to = { x: 3, y: 4 };
    const poly = arrowPolygon({ x: 0, y: 0 }, to);
    expect(poly[3][0]).toBeCloseTo(to.x, 10);
    expect(poly[3][1]).toBeCloseTo(to.y, 10);
  });

  it('杆的起点落在起点格心上（后端两个顶点对称）', () => {
    const from = { x: 1, y: 2 };
    const poly = arrowPolygon(from, { x: 4, y: 2 });
    // 起点处两个顶点在 from 两侧，法线方向对称
    const [a, , , , , , g] = poly;
    expect((a[0] + g[0]) / 2).toBeCloseTo(from.x, 10);
    expect((a[1] + g[1]) / 2).toBeCloseTo(from.y, 10);
    // 垂直于连线
    expect(Math.abs(a[1] - g[1])).toBeCloseTo(DEFAULT_ARROW.shaftHalfWidth * 2, 10);
  });

  it('箭头宽度不超出一格（不会糊到相邻格）', () => {
    const poly = arrowPolygon({ x: 0, y: 0 }, { x: 5, y: 0 });
    const ys = poly.map((p) => p[1]);
    const maxAbs = Math.max(...ys.map(Math.abs));
    expect(maxAbs).toBeLessThan(0.5);
    expect(maxAbs).toBeCloseTo(DEFAULT_ARROW.headHalfWidth, 10);
  });

  it('方向相反时箭头也反向（法线翻转）', () => {
    const fwd = arrowPolygon({ x: 0, y: 0 }, { x: 2, y: 0 });
    const back = arrowPolygon({ x: 2, y: 0 }, { x: 0, y: 0 });
    // 两个箭头的尖分别落在对方的终点
    expect(fwd[3][0]).toBeCloseTo(2, 10);
    expect(back[3][0]).toBeCloseTo(0, 10);
    // 杆的后端分别在各自起点
    expect(fwd[0][0]).toBeCloseTo(0, 10);
    expect(back[0][0]).toBeCloseTo(2, 10);
  });

  it('起点终点重合时不画（返回空数组，不除零）', () => {
    expect(arrowPolygon({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });

  it('斜向箭头的尖依然精确落在终点', () => {
    const to = { x: -2.5, y: 1.5 };
    const poly = arrowPolygon({ x: 0.5, y: -1 }, to);
    expect(poly[3][0]).toBeCloseTo(to.x, 10);
    expect(poly[3][1]).toBeCloseTo(to.y, 10);
  });

  it('中心是起点与终点的中点', () => {
    const c = arrowCenter({ x: 0, y: 0 }, { x: 4, y: -2 });
    expect(c.x).toBeCloseTo(2, 10);
    expect(c.y).toBeCloseTo(-1, 10);
  });

  it('自定义尺寸生效（箭头更长更宽）', () => {
    const poly = arrowPolygon(
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { shaftHalfWidth: 0.1, headLength: 0.5, headHalfWidth: 0.25 },
    );
    const ys = poly.map((p) => p[1]);
    expect(Math.max(...ys.map(Math.abs))).toBeCloseTo(0.25, 10);
    // 根部平面退让了 0.5
    expect(poly[1][0]).toBeCloseTo(1.5, 10);
  });

  describe('尖端回退（tipInset）', () => {
    it('tipInset=0 时箭尖精确落在终点格心', () => {
      const poly = arrowPolygon({ x: 0, y: 0 }, { x: 4, y: 0 }, { tipInset: 0 });
      expect(poly[3][0]).toBeCloseTo(4, 10);
      expect(poly[3][1]).toBeCloseTo(0, 10);
    });

    it('tipInset=0.3 时箭尖沿箭头方向从终点回退 0.3 格', () => {
      const to = { x: 4, y: 0 };
      const poly = arrowPolygon({ x: 0, y: 0 }, to, { tipInset: 0.3 });
      expect(poly[3][0]).toBeCloseTo(3.7, 10);
      expect(poly[3][1]).toBeCloseTo(0, 10);
    });

    it('斜向回退也沿连线方向（不是简单减 x）', () => {
      // 起点 (0,0) → 终点 (3,4)，单位方向 u = (0.6, 0.8)
      const poly = arrowPolygon({ x: 0, y: 0 }, { x: 3, y: 4 }, { tipInset: 0.5 });
      expect(poly[3][0]).toBeCloseTo(3 - 0.6 * 0.5, 10);
      expect(poly[3][1]).toBeCloseTo(4 - 0.8 * 0.5, 10);
    });

    it('回退后整根箭头仍然指向终点（尖到终点的距离 == tipInset）', () => {
      const to = { x: 3, y: 4 };
      const poly = arrowPolygon({ x: 0, y: 0 }, to, { tipInset: 0.3 });
      const d = Math.hypot(poly[3][0] - to.x, poly[3][1] - to.y);
      expect(d).toBeCloseTo(0.3, 10);
    });
  });

  describe('2D / 3D 尺寸不变量', () => {
    it('2D 箭尖不退回（语义最强：正好落在终点格心）', () => {
      expect(ARROW_2D.tipInset).toBe(0);
    });

    it('2D 箭头头部比 2D 棋子底座宽（箭头头能从棋子两侧露出来）', () => {
      // 2D 棋子美术宽度约 0.28 格 → 底座半宽约 0.14
      expect(ARROW_2D.headHalfWidth).toBeGreaterThan(0.14);
    });

    it('3D 箭尖退回 0.3 格（避开底座半径 0.22 + 塔身遮挡）', () => {
      expect(ARROW_3D.tipInset).toBeGreaterThan(0.22);
      expect(ARROW_3D.tipInset).toBeLessThanOrEqual(0.35);
    });

    it('3D 箭头头部比棋子底座半径宽（头部两角一定能探出棋子）', () => {
      // 3D 底座半径最大 0.22（王/后）
      expect(ARROW_3D.headHalfWidth).toBeGreaterThan(0.22);
    });

    it('两套尺寸的箭头都不会宽过一格（不糊到相邻格）', () => {
      for (const opt of [ARROW_2D, ARROW_3D]) {
        expect(opt.headHalfWidth).toBeLessThan(0.5);
        expect(opt.shaftHalfWidth).toBeLessThan(0.5);
      }
    });

    it('3D 箭头比 2D 更粗更长（斜视角需要更强的存在感）', () => {
      expect(ARROW_3D.shaftHalfWidth).toBeGreaterThan(ARROW_2D.shaftHalfWidth);
      expect(ARROW_3D.headHalfWidth).toBeGreaterThan(ARROW_2D.headHalfWidth);
      expect(ARROW_3D.headLength).toBeGreaterThan(ARROW_2D.headLength);
    });

    it('最短的一格棋（1 格）也画得出箭头：杆长为正', () => {
      // 退 0.3 + 头 0.38 < 1 格，箭头不会退化成一个点
      expect(1 - ARROW_3D.tipInset - ARROW_3D.headLength).toBeGreaterThan(0);
    });
  });
});
