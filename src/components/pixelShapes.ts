/**
 * 像素风（pixel）的**专属造型语言**。
 *
 * 为什么不再从经典造型光栅化：
 *   原来的做法是「把经典的 Staunton 剪影降采样成 32×32」，想靠同一副骨架保证辨识度。
 *   实测行不通 —— 降采样把**标志性特征**全磨没了：
 *   象的顶珠只剩 1 格、后的五尖冠被谷切成了离散单像素、王的十字横臂只有 2 格。
 *   六子的下半部分（统一底座 + 5~6 格宽的柱体）却**一模一样**，
 *   于是缩到棋盘实际尺寸后两两 IoU 高达 73.7%（王 vs 后）—— 肉眼就是「都长一样」。
 *
 *   而且把分辨率从 32×32 提到 48×48 **只会更糟**（王 vs 后 73.6% → 81.9%）：
 *   分辨率越高，六子共用的「柱体 + 底座」保真度越高，越像。
 *   → **光栅化分辨率不是解药，造型语言才是。**
 *
 * 这套语言的原则（按重要性排序）：
 *   ① **轮廓分叉**：六子的宽 / 高 / 底座各不相同，光看剪影就能分开。
 *      宽度档：马 18 > 王 18(横臂) > 后 16 > 车 14 > 象 10 = 兵 10
 *      高度档：王 26 行 > 后 24 > 马 22 > 象 21 > 车 19 > 兵 16
 *   ② **特征做宽、做到 ≥3 格**：像素风里 1~2 格的特征等于没有。
 *      横向尤其重要 —— 3D 是 38° 俯视，竖直方向会被压扁 0.62 倍，
 *      纯竖直的特征（细高王冠）在 3D 里会消失，横向特征（垛口、冠尖、斜切口）才立得住。
 *   ③ **去掉统一底座**：原来六子共用一个底座，是撞脸的帮凶。现在底座宽度按棋子分档。
 *
 * 画法全部是**代码生成**（矩形 / 梯形 / 圆盘 / 斜线的组合），
 * 不是手绘位图，也不需要任何第三方素材。
 *
 * 与 3D 的关系：3D 像素几何就是把这里的网格**按行挤成体素**
 * （见 pieceGeometry.ts 的 pixelGeometries）—— 同一张图，所以改这里两边同步生效。
 */
import type { PieceType } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* 像素画布                                                            */
/* ------------------------------------------------------------------ */

/** 画布边长（格）。造型全部按 32×32 设计。 */
export const PIXEL_SIZE = 32;

/**
 * 一格像素的色调。
 *
 * ⚠️ **数值顺序与旧版保持一致**（Empty 0 / Body 1 / Highlight 2 / Outline 3 / Detail 4）——
 * 素材生成脚本、预览脚本可能按数值写死过，别在这上面改主意。
 *
 * 与经典版同名同义，渲染层（PieceGlyph 的 PixelSprite、3D 的体素合并）不用改。
 */
export const PixelCell = {
  /** 留空 */
  Empty: 0,
  /** 本体 */
  Body: 1,
  /** 左上受光带 */
  Highlight: 2,
  /** 剪影边缘（描边色） */
  Outline: 3,
  /** 刻线（象的裂口、马的鬃毛） */
  Detail: 4,
} as const;

export type PixelCellValue = (typeof PixelCell)[keyof typeof PixelCell];

export interface PixelGrid {
  /** 画布边长 */
  size: number;
  /** 逐格色调，行优先 */
  cells: PixelCellValue[];
}

/**
 * 可编程的像素画布 —— 像素风造型的唯一工具。
 *
 * 为什么不用多边形 + 采样（经典版那套）：
 *   多边形在 32 格上会把斜线走样成锯齿，而且「斜切口」这种特征要靠多边形相交去凑。
 *   直接用矩形 / 梯形 / 圆盘拼，**每一格都是算出来的**，没有半格、没有抗锯齿 ——
 *   这才是像素风该有的「硬边」。
 */
class PixelCanvas {
  readonly size: number;
  private readonly body: Uint8Array;
  private readonly detailMask: Uint8Array;

  constructor(size: number = PIXEL_SIZE) {
    this.size = size;
    this.body = new Uint8Array(size * size);
    this.detailMask = new Uint8Array(size * size);
  }

  private set(row: number, col: number): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.body[row * this.size + col] = 1;
  }

  /** 实心矩形：左上角 (row, col)，高 height、宽 width */
  rect(row: number, col: number, height: number, width: number): this {
    for (let r = row; r < row + height; r += 1) {
      for (let c = col; c < col + width; c += 1) this.set(r, c);
    }
    return this;
  }

  /** 以 center 为中轴的梯形：共 height 行，顶宽 widthTop、底宽 widthBottom */
  taper(
    row: number,
    height: number,
    center: number,
    widthTop: number,
    widthBottom: number,
  ): this {
    for (let i = 0; i < height; i += 1) {
      const w = Math.round(
        widthTop + ((widthBottom - widthTop) * i) / Math.max(1, height - 1),
      );
      const left = Math.round(center - w / 2);
      this.rect(row + i, left, 1, w);
    }
    return this;
  }

  /** 圆盘（整像素，不抗锯齿） */
  disc(centerRow: number, centerCol: number, radius: number): this {
    for (let r = Math.floor(centerRow - radius); r <= Math.ceil(centerRow + radius); r += 1) {
      for (let c = Math.floor(centerCol - radius); c <= Math.ceil(centerCol + radius); c += 1) {
        const dr = r - centerRow;
        const dc = c - centerCol;
        // +0.35 是为了让 5×5 这种小圆盘填得实一点（半径 2 → 直径 5 而不是 4）
        if (dr * dr + dc * dc <= radius * radius + radius * 0.35) this.set(r, c);
      }
    }
    return this;
  }

  /** 斜线（Bresenham，1 格宽） */
  slash(row0: number, col0: number, row1: number, col1: number): this {
    let r = row0;
    let c = col0;
    const dr = Math.abs(row1 - row0);
    const dc = Math.abs(col1 - col0);
    const sr = row1 > row0 ? 1 : -1;
    const sc = col1 > col0 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      this.set(r, c);
      if (r === row1 && c === col1) break;
      const e2 = 2 * err;
      if (e2 > -dr) {
        err -= dr;
        c += sc;
      }
      if (e2 < dc) {
        err += dc;
        r += sr;
      }
    }
    return this;
  }

  /** 把已有的本体格标成刻线（detail）—— 不会新增格子 */
  markDetail(row: number, col: number, height: number, width: number): this {
    for (let r = row; r < row + height; r += 1) {
      for (let c = col; c < col + width; c += 1) {
        if (r < 0 || c < 0 || r >= this.size || c >= this.size) continue;
        this.detailMask[r * this.size + c] = 1;
      }
    }
    return this;
  }

  /** 把一条斜线标成刻线 */
  markSlash(row0: number, col0: number, row1: number, col1: number): this {
    let r = row0;
    let c = col0;
    const dr = Math.abs(row1 - row0);
    const dc = Math.abs(col1 - col0);
    const sr = row1 > row0 ? 1 : -1;
    const sc = col1 > col0 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      this.markDetail(r, c, 1, 1);
      if (r === row1 && c === col1) break;
      const e2 = 2 * err;
      if (e2 > -dr) {
        err -= dr;
        c += sc;
      }
      if (e2 < dc) {
        err += dc;
        r += sr;
      }
    }
    return this;
  }

  /**
   * 烘成最终网格：本体 → 刻线 → 描边 → 受光带。
   *
   * 描边和受光带是**从剪影自动算**的（不是画上去的），
   * 所以造型一改，描边自动跟着走 —— 不会出现「轮廓改了但描边还是旧的」。
   */
  toGrid(): PixelGrid {
    const { size } = this;
    const cells = new Array<PixelCellValue>(size * size).fill(PixelCell.Empty);
    const at = (row: number, col: number): boolean => {
      if (row < 0 || col < 0 || row >= size || col >= size) return false;
      return this.body[row * size + col] === 1;
    };

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const i = row * size + col;
        if (!at(row, col)) continue;
        if (this.detailMask[i]) {
          cells[i] = PixelCell.Detail;
          continue;
        }
        // 剪影边缘：上下左右只要有一格是空的
        const edge = !at(row - 1, col) || !at(row + 1, col) || !at(row, col - 1) || !at(row, col + 1);
        if (edge) {
          cells[i] = PixelCell.Outline;
          continue;
        }
        // 左上受光带：左上角斜着两格之外是空的，就算受光
        const lit = !at(row - 2, col - 2);
        cells[i] = lit ? PixelCell.Highlight : PixelCell.Body;
      }
    }

    return { size, cells };
  }
}

/* ------------------------------------------------------------------ */
/* 六子造型                                                            */
/* ------------------------------------------------------------------ */

/** 画布中轴（col 15 与 16 之间） */
const CX = 15.5;
/** 棋子底边所在行 —— 所有棋子底部对齐（2D 里 y≈93.75，正好压在接地投影上） */
const BOTTOM = 29;

/**
 * 六子的**体量编码表** —— 造型不是逐个拍脑袋画的，是按这张表系统性分配的。
 *
 * 两条轴（宽 / 高）先拉开，再在各自的顶部安排**异构的特征**：
 *
 *   棋子  顶行  总高   最宽   底部形态          顶部特征
 *   王     2    28 行  24    直筒微张          粗十字（横杠 24 宽，最外扩）
 *   后     4    26 行  20    细腰外撇          中央宽大尖 + 两侧矮翼
 *   象     8    22 行  11    胖水滴            斜顶水滴（左肩高右肩圆）
 *   马     8    22 行  19    偏右细腿          向左伸出的马头口鼻
 *   车     8    22 行  16    宽墩（上窄下宽）  三个**平顶**方垛
 *   兵    16    14 行  10    细柄微张          正圆球头
 *
 * 为什么**没有底座**：
 *   原来六子共用一个矩形底座，是重叠的最大来源（底座那几行几乎 100% 重合）。
 *   去掉之后，每个棋子的下部本身就是造型的一部分 ——
 *   兵是纺锤、车是墩子、后是沙漏、王是直筒、象是胖身、马是细腿。
 *
 * 为什么**特征要异构**，不能只靠「形状不同」：
 *   后和车都做过「三个突起」，缩到棋盘尺寸后尖顶的收窄会被平滑掉，
 *   两者剪影 IoU 一度高达 71.6%（比改造前还差）。
 *   所以后改成「中央一个又宽又高的大尖 + 两侧矮翼」，车保持「三平垛」——
 *   一个是**中心块**、一个是**梳齿**，缩放后完全两样。
 */

/** 兵：纺锤形 —— 正圆球头 + 细颈 + 微张的柄（全画布最窄） */
function paintPawn(c: PixelCanvas): void {
  // 球头（小而圆 —— 兵是六子里最小的，太胖会被象整个罩住）
  c.disc(17, CX, 3.6);
  // 颈
  c.rect(20, 14, 2, 3);
  // 柄：微微外张，直接落到画布底
  c.taper(22, BOTTOM - 22 + 1, CX, 3, 5);
}

/**
 * 车：宽墩 —— 三个**平顶**方垛 + 横带 + 一路宽到底的塔身。
 *
 * 下宽上窄（倒梯形），最宽处在**底部**。
 */
function paintRook(c: PixelCanvas): void {
  // 三个方垛口（平顶）：8-11 / 14-17 / 20-23，缝 2 格
  c.rect(8, 8, 6, 4);
  c.rect(8, 14, 6, 4);
  c.rect(8, 20, 6, 4);
  // 冠部横带
  c.rect(14, 8, 3, 16);
  // 塔身（上窄下宽）
  c.taper(17, 9, CX, 9, 13);
  // 基座裙边：底部外撇的一圈 —— 塔有基座，也让车有**独有的体积**（不跟象的细身重叠）
  c.taper(26, BOTTOM - 26 + 1, CX, 13, 18);
}

/**
 * 马：**唯一横向不对称**的棋子 —— 口鼻向左伸出。
 *
 * 剪影是「S 形侧脸」：右边是颈和偏右的细腿，左边伸出一截口鼻。
 * 上下左右没有任何一个棋子是这么长的。
 */
function paintKnight(c: PixelCanvas): void {
  // 耳朵
  c.rect(8, 13, 2, 3);
  // 头骨
  c.rect(10, 11, 6, 9);
  // 口鼻向左伸出（横向特征 —— 3D 俯视压扁竖直方向时，靠它认人）
  c.rect(12, 3, 5, 9);
  // 颈
  c.rect(15, 17, 8, 4);
  // 偏右的细腿
  c.taper(22, BOTTOM - 22 + 1, 17, 5, 8);
  // 鬃毛（刻线）：后颈的一道斜槽
  c.markSlash(11, 19, 21, 20);
}

/**
 * 象：胖身 —— 斜顶水滴 + 领圈 + 一路胖到底的身子。
 *
 * 头不是正圆（正圆是兵），而是**左肩高、右肩圆**的斜水滴 ——
 * 逐行给「宽度 + 中轴」，做出一个明显歪斜的轮廓。
 */
function paintBishop(c: PixelCanvas): void {
  // 斜顶水滴：逐行给宽度和中轴（左上尖、右下圆）
  const head: Array<[number, number, number]> = [
    [8, 11, 4],
    [9, 11.5, 5],
    [10, 12, 7],
    [11, 13, 8],
    [12, 14, 9],
    [13, 15, 10],
    [14, 15.5, 10],
    [15, 16, 10],
    [16, 16, 10],
  ];
  for (const [row, center, width] of head) {
    const left = Math.round(center - width / 2);
    c.rect(row, left, 1, width);
  }
  // 领圈
  c.rect(17, 10, 2, 11);
  // 胖身（**刻意收窄**：象靠头上那个斜水滴认人，身太宽会跟车的宽塔身撞）
  c.taper(19, BOTTOM - 19 + 1, CX, 6, 9);
  // 斜切口（刻线）：从左上到右下贯穿整个冠
  c.markSlash(9, 13, 16, 18);
}

/**
 * 后：沙漏 —— 中央一个**又宽又高**的大尖 + 两侧矮翼。
 *
 * 与车（三个平顶方垛）**异构**：一个是中心块，一个是梳齿，
 * 缩到棋盘尺寸后完全两样（这一对曾经是 IoU 最高的一对，71.6%）。
 */
function paintQueen(c: PixelCanvas): void {
  // 中央宽大尖（row 4 起，顶宽 4 → 底宽 8）
  c.taper(4, 13, 15.5, 4, 8);
  // 两侧矮翼（row 9 起，加宽加高 —— 1~2 格的孤立小块缩放到棋盘尺寸就没了）
  c.taper(9, 8, 8, 3, 6);
  c.taper(9, 8, 23, 3, 6);
  // 冠带
  c.rect(17, 9, 3, 13);
  // 细腰外撇（**细腰**：与象的胖身、马的细腿拉开）
  c.taper(20, BOTTOM - 20 + 1, CX, 4, 7);
}

/**
 * 王：直筒 + **粗十字** —— 横杠 24 格宽，比整枚棋子都宽。
 *
 * 横杠在**最顶部**（车在底部、后是尖），一眼就认得出。
 */
function paintKing(c: PixelCanvas): void {
  // 竖臂（从横杠上方露出）
  c.rect(2, 14, 8, 4);
  // 横杠：24 格宽
  c.rect(6, 4, 4, 24);
  // 直筒（刻意收窄：太宽会把象、马整条盖住，剪影就分不开了）
  c.taper(10, BOTTOM - 10 + 1, CX, 9, 11);
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

const PAINTERS: Record<PieceType, (c: PixelCanvas) => void> = {
  p: paintPawn,
  r: paintRook,
  n: paintKnight,
  b: paintBishop,
  q: paintQueen,
  k: paintKing,
};

/**
 * 某种棋子的像素位图。
 *
 * 缓存：2D 棋盘上有 32 枚棋子、每次切风格都要重算，缓存一下省掉重复光栅化。
 */
const gridCache = new Map<PieceType, PixelGrid>();

export function pixelGrid(type: PieceType, size: number = PIXEL_SIZE): PixelGrid {
  const cached = size === PIXEL_SIZE ? gridCache.get(type) : undefined;
  if (cached) return cached;
  const canvas = new PixelCanvas(size);
  PAINTERS[type](canvas);
  const grid = canvas.toGrid();
  if (size === PIXEL_SIZE) gridCache.set(type, grid);
  return grid;
}

/**
 * 剪影（二值）：非空格算实心。
 *
 * 给「辨识度门禁」用 —— 它要比的不是颜色，是**只看轮廓能不能分开**。
 */
export function pixelSilhouette(type: PieceType): boolean[][] {
  const grid = pixelGrid(type);
  const out: boolean[][] = [];
  for (let row = 0; row < grid.size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < grid.size; col += 1) {
      line.push(grid.cells[row * grid.size + col] !== PixelCell.Empty);
    }
    out.push(line);
  }
  return out;
}

/**
 * 把剪影缩到 n×n（**box filter 面积加权**，实心占比 ≥ 50% 算实心）。
 *
 * 为什么用面积加权，而不是「有一格实心就算实心」：
 *   后者等于**极限模糊**—— 垛口之间那 1~2 格的缝会被整个填平，
 *   于是「三个方垛」在缩放后变成「一整块」，测的其实是一张糊掉的图，
 *   既高估了撞脸、又抹掉了特征（实测同一套造型，两种口径差了 10+ 个百分点）。
 *   面积加权才接近浏览器把 32 格位图缩到 70px 时的**抗锯齿渲染**结果。
 *
 * 判据要模拟**真实观看尺寸**：棋盘上棋子固定渲染 70px（Board2D.tsx 的 size={70}），
 * 这里用 56px —— 比真实更小，判据更严。
 */
export function downscaleSilhouette(src: boolean[][], n: number): boolean[][] {
  const s = src.length;
  const out: boolean[][] = [];
  for (let r = 0; r < n; r += 1) {
    const line: boolean[] = [];
    const y0 = (r * s) / n;
    const y1 = ((r + 1) * s) / n;
    for (let c = 0; c < n; c += 1) {
      const x0 = (c * s) / n;
      const x1 = ((c + 1) * s) / n;
      let solidArea = 0;
      let totalArea = 0;
      for (let sr = 0; sr < s; sr += 1) {
        const oy = Math.min(y1, sr + 1) - Math.max(y0, sr);
        if (oy <= 0) continue;
        for (let sc = 0; sc < s; sc += 1) {
          const ox = Math.min(x1, sc + 1) - Math.max(x0, sc);
          if (ox <= 0) continue;
          const area = ox * oy;
          totalArea += area;
          if (src[sr][sc]) solidArea += area;
        }
      }
      line.push(totalArea > 0 && solidArea / totalArea >= 0.5);
    }
    out.push(line);
  }
  return out;
}

/** 两张二值剪影的 IoU（交并比）—— 1 = 完全一样，0 = 毫无重叠 */
export function silhouetteIou(a: boolean[][], b: boolean[][]): number {
  let inter = 0;
  let union = 0;
  for (let r = 0; r < a.length; r += 1) {
    for (let c = 0; c < a.length; c += 1) {
      if (a[r][c] && b[r][c]) inter += 1;
      if (a[r][c] || b[r][c]) union += 1;
    }
  }
  return union === 0 ? 1 : inter / union;
}
