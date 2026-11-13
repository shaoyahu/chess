/**
 * **像素风的辨识度门禁** —— 防止棋子又长成「六子一个样」。
 *
 * 背景（这个项目的老病根）：
 *   像素风格最初是「把经典造型降采样成 32×32」，想靠同一副骨架保证辨识度。
 *   实测完全失败：降采样把标志性特征全磨没了（象的顶珠只剩 1 格、后的五尖冠
 *   被切成离散单像素、王的十字横臂只有 2 格），而六子的下半部分一模一样，
 *   于是缩到棋盘实际尺寸后两两 IoU 高达 **73.7%**（王 vs 后）—— 肉眼就是「都长一样」。
 *
 *   而且把分辨率提到 48×48 **只会更糟**（王 vs 后 81.9%）：
 *   分辨率越高，六子共用的「柱体 + 底座」保真度越高，越像。
 *   → 光栅化分辨率不是解药，**造型语言**才是。
 *
 * 判据：
 *   把每枚棋子的剪影用 box filter 缩到 **56px**（棋盘上棋子实际渲染 70px，
 *   判据取更小的值 = 更严），两两算 IoU，**任一对不得 > 60%**。
 *
 * 为什么要有这道门禁：
 *   「辨识度」这种主观感受一旦没有可执行判据，下一轮改造型就会退化回去。
 *   这里把它变成一条会红的断言。
 */
import { describe, it, expect } from 'vitest';
import {
  pixelSilhouette,
  downscaleSilhouette,
  silhouetteIou,
  pixelGrid,
  PIXEL_SIZE,
} from '@/components/pixelShapes';
import type { PieceType } from '@/lib/types';

const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const NAMES: Record<PieceType, string> = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' };

/** 判据用的观看尺寸（棋盘上棋子渲染 70px，这里取更小的 56px —— 更严） */
const VIEW_PX = 56;
/** 两两 IoU 上限 */
const MAX_IOU = 0.6;

/** 缩到观看尺寸后的剪影 */
const scaled = new Map<PieceType, boolean[][]>(
  TYPES.map((t) => [t, downscaleSilhouette(pixelSilhouette(t), VIEW_PX)]),
);

describe('像素风 · 辨识度', () => {
  it(`缩到 ${VIEW_PX}px 后，任意两枚棋子的剪影 IoU ≤ ${MAX_IOU * 100}%`, () => {
    for (let i = 0; i < TYPES.length; i += 1) {
      for (let j = i + 1; j < TYPES.length; j += 1) {
        const a = TYPES[i];
        const b = TYPES[j];
        const iou = silhouetteIou(scaled.get(a)!, scaled.get(b)!);
        expect(
          iou,
          `${NAMES[a]} 与 ${NAMES[b]} 的剪影太像了（IoU ${(iou * 100).toFixed(1)}% > ${MAX_IOU * 100}%）—— ` +
            `像素棋子必须光看轮廓就能分开，不是靠颜色`,
        ).toBeLessThanOrEqual(MAX_IOU);
      }
    }
  });

  it('六子的**体量**分得开：宽 / 高都不止一档（不能全是同一副骨架缩放出来的）', () => {
    // 每个棋子量三个量：顶行（高度）、最大宽度、占用行数
    const stats = TYPES.map((t) => {
      const grid = pixelGrid(t);
      let minRow = grid.size;
      let maxRow = -1;
      let minCol = grid.size;
      let maxCol = -1;
      for (let r = 0; r < grid.size; r += 1) {
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] === 0) continue;
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
          if (c < minCol) minCol = c;
          if (c > maxCol) maxCol = c;
        }
      }
      return { type: t, top: minRow, width: maxCol - minCol + 1, rows: maxRow - minRow + 1 };
    });

    for (const s of stats) {
      expect(s.rows, `${NAMES[s.type]} 的高度不对`).toBeGreaterThan(8);
      expect(s.width, `${NAMES[s.type]} 的宽度不对`).toBeGreaterThan(4);
    }

    // 王最高、兵最矮（棋子本来就该有高矮之分）
    const king = stats.find((s) => s.type === 'k')!;
    const pawn = stats.find((s) => s.type === 'p')!;
    expect(king.top, '王应该比兵高').toBeLessThan(pawn.top);

    // 宽度必须有明显分档：最宽的比最窄的至少宽 1.4 倍
    const widths = stats.map((s) => s.width);
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.4);
  });

  it('每个棋子的**识别特征**都在上面（上部 1/3 里有一条 ≥4 格的连续实心带）', () => {
    // 为什么测「连续实心段」而不是「整行总宽」：
    //   后的两侧矮翼是**分开的**两块，整行加起来最宽，但真正认人的是中间那根宽尖；
    //   车的塔身在底部最宽，但认人的是顶部那三个方垛。
    //   只有「连续实心段的宽度」才对应「这块特征缩到棋盘尺寸后还剩得下」。
    for (const t of TYPES) {
      const grid = pixelGrid(t);
      let minRow = grid.size;
      let maxRow = -1;
      for (let r = 0; r < grid.size; r += 1) {
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] === 0) continue;
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
        }
      }
      const rows = maxRow - minRow + 1;
      const upperLimit = minRow + Math.floor(rows / 3);

      // 上部 1/3 里最长的一段连续实心
      let best = 0;
      for (let r = minRow; r <= upperLimit; r += 1) {
        let run = 0;
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] !== 0) {
            run += 1;
            if (run > best) best = run;
          } else {
            run = 0;
          }
        }
      }
      expect(
        best,
        `${NAMES[t]} 的上部没有 ≥4 格的连续特征带（最长 ${best} 格）—— ` +
          `特征块太碎，缩到棋盘尺寸就没了`,
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it('六子的**特征结构**符合规格（段数 / 最宽段下限）', () => {
    // 为什么要有这条：
    //   IoU 是**单一维度**，它只看整枚棋子的重叠 —— 局部特征退化（垛缝消失、
    //   横杠被削窄）可能完全不改变 IoU 判定，守卫就成了盲区。
    //   这条按「设计时定下的规格」逐枚核对特征结构，补上那个盲区。
    //
    //   规格怎么来的：量各棋子上部 1/3 特征带的实际段数与最宽段，再往下留一点余量。
    const spec: Record<PieceType, { minSegments: number; minWidest: number; why: string }> = {
      k: { minSegments: 1, minWidest: 14, why: '十字横杠（一条，不能被削窄）' },
      q: { minSegments: 3, minWidest: 5, why: '中央大尖 + 两侧矮翼 = 3 段' },
      r: { minSegments: 3, minWidest: 4, why: '三个方垛 = 3 段' },
      b: { minSegments: 1, minWidest: 8, why: '斜顶水滴（一整块）' },
      n: { minSegments: 1, minWidest: 12, why: '马头口鼻（一整块）' },
      p: { minSegments: 1, minWidest: 6, why: '圆球头（一整块）' },
    };

    for (const t of TYPES) {
      const grid = pixelGrid(t);
      let minRow = grid.size;
      let maxRow = -1;
      for (let r = 0; r < grid.size; r += 1) {
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] === 0) continue;
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
        }
      }
      const rows = maxRow - minRow + 1;
      const upperLimit = minRow + Math.floor(rows / 3);

      let maxSegments = 0;
      let widest = 0;
      for (let r = minRow; r <= upperLimit; r += 1) {
        let run = 0;
        let segs = 0;
        for (let c = 0; c <= grid.size; c += 1) {
          const solid = c < grid.size && grid.cells[r * grid.size + c] !== 0;
          if (solid) {
            if (run === 0) segs += 1;
            run += 1;
            if (run > widest) widest = run;
          } else {
            run = 0;
          }
        }
        if (segs > maxSegments) maxSegments = segs;
      }

      expect(
        maxSegments,
        `${NAMES[t]} 的特征只剩 ${maxSegments} 段，规格要求 ≥ ${spec[t].minSegments} 段（${spec[t].why}）`,
      ).toBeGreaterThanOrEqual(spec[t].minSegments);
      expect(
        widest,
        `${NAMES[t]} 的特征最宽段只有 ${widest} 格，规格要求 ≥ ${spec[t].minWidest} 格（${spec[t].why}）`,
      ).toBeGreaterThanOrEqual(spec[t].minWidest);
    }
  });

  it('象的头是**歪**的（斜顶主教冠：上下行的实心中心要错开 ≥3 格）', () => {
    // 象的识别特征就是那道斜切口 —— 头是正圆的话，它就和兵的圆球头同源了。
    // 判据：特征带最上行与最下行的实心中心必须有明显横向偏移。
    const grid = pixelGrid('b');
    const size = grid.size;
    const solid = (r: number, c: number) => grid.cells[r * size + c] !== 0;

    // 特征带 = 从最上面一行起的前 9 行（象的头就在那里）
    let top = size;
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (solid(r, c)) {
          top = r;
          break;
        }
      }
      if (top < size) break;
    }

    const centerOf = (row: number): number | null => {
      let first = -1;
      let last = -1;
      for (let c = 0; c < size; c += 1) {
        if (!solid(row, c)) continue;
        if (first < 0) first = c;
        last = c;
      }
      return first < 0 ? null : (first + last) / 2;
    };

    const centers: number[] = [];
    for (let r = top; r < top + 9; r += 1) {
      const c = centerOf(r);
      if (c !== null) centers.push(c);
    }
    expect(centers.length, '象的头部没有实心').toBeGreaterThan(2);
    const shift = Math.max(...centers) - Math.min(...centers);
    expect(
      shift,
      `象的头是正的（上下中心只错开 ${shift.toFixed(1)} 格）—— 斜顶主教冠的特征丢了`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('棋子**高矮次序**符合直觉（王 > 后 > 象 ≈ 马 > 车 > 兵）', () => {
    // 为什么单独判：
    //   「中央尖被削平」这种改动不会让 IoU 超标（后还是三段特征），
    //   但后就不再比车高了 —— 高矮次序是玩家认棋子的**隐含线索**，
    //   削掉了就是退化。IoU 看不见，得单独钉住。
    const topOf = (t: PieceType): number => {
      const grid = pixelGrid(t);
      for (let r = 0; r < grid.size; r += 1) {
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] !== 0) return r;
        }
      }
      return grid.size;
    };

    const king = topOf('k');
    const queen = topOf('q');
    const bishop = topOf('b');
    const knight = topOf('n');
    const rook = topOf('r');
    const pawn = topOf('p');

    expect(king, '王应该最高').toBeLessThan(queen);
    expect(queen, '后应该比车高').toBeLessThan(rook);
    expect(bishop, '象不该比车矮').toBeLessThanOrEqual(rook);
    expect(knight, '马不该比车矮').toBeLessThanOrEqual(rook);
    expect(rook, '车应该比兵高').toBeLessThan(pawn);
  });

  it('画布是 32×32，且每枚棋子都真的画出了东西', () => {
    for (const t of TYPES) {
      const grid = pixelGrid(t);
      expect(grid.size).toBe(PIXEL_SIZE);
      expect(grid.cells.length).toBe(PIXEL_SIZE * PIXEL_SIZE);
      const filled = grid.cells.filter((c) => c !== 0).length;
      expect(filled, `${NAMES[t]} 的位图是空的`).toBeGreaterThan(40);
    }
  });
});
