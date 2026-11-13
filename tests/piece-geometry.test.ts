/**
 * 3D 棋盘坐标的回归测试。
 *
 * 曾经的真实 bug：`squareToWorld` 的 z 映射写成了 `3.5 - rank`，
 * 导致整个 3D 棋盘朝 -z 偏了**一格**：
 *   - rank 8 落到 z = -4.5，跑出了边框（±4.2）；
 *   - 近端一排棋子「悬在棋盘外」，被画布下沿切掉；
 *   - 边框一侧只剩 0.2 的窄边、另一侧空了 1.2，视觉上明显不对称。
 *
 * 这里的断言把「棋盘以中心对称、且整体在边框内」钉死。
 */
import { describe, expect, it } from 'vitest';
import { squareToWorld, SQUARE_SIZE } from '@/components/pieceGeometry';

/** 边框底板是 8.4 × 8.4（src/components/Board3D.tsx） */
const FRAME_HALF = 8.4 / 2;

function allSquares(): string[] {
  const out: string[] = [];
  for (let r = 1; r <= 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      out.push(`${String.fromCharCode(97 + f)}${r}`);
    }
  }
  return out;
}

describe('3D 棋盘坐标', () => {
  it('a8 在左后、h1 在右前，两端都落在 ±3.5', () => {
    expect(squareToWorld('a8')).toEqual({ x: -3.5, z: -3.5 });
    expect(squareToWorld('h1')).toEqual({ x: 3.5, z: 3.5 });
    expect(squareToWorld('a1')).toEqual({ x: -3.5, z: 3.5 });
    expect(squareToWorld('h8')).toEqual({ x: 3.5, z: -3.5 });
  });

  it('64 个格子的中心以棋盘中心对称（重心为原点）', () => {
    const pts = allSquares().map(squareToWorld);
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    expect(cx).toBeCloseTo(0, 10);
    expect(cz).toBeCloseTo(0, 10);
  });

  it('整块棋盘（含格子边角）都在边框底板内，不会悬在棋盘外', () => {
    const half = SQUARE_SIZE / 2;
    for (const square of allSquares()) {
      const p = squareToWorld(square);
      expect(Math.abs(p.x) + half).toBeLessThan(FRAME_HALF);
      expect(Math.abs(p.z) + half).toBeLessThan(FRAME_HALF);
    }
  });

  it('rank 与 z 的映射是线性递减（rank8 → -3.5 … rank1 → +3.5）', () => {
    for (let rank = 1; rank <= 8; rank += 1) {
      expect(squareToWorld(`a${rank}`).z).toBeCloseTo(4.5 - rank, 10);
    }
  });
});
