/**
 * 走子箭头几何 —— 2D 与 3D 共用同一套公式。
 *
 * 为什么单独抽出来：
 *  - 2D 用 SVG 多边形画在棋盘上，3D 用 three.js 的 Shape 拉成扁平几何，
 *    两者都要求「同一根箭头」—— 起点在哪、箭头多大、朝哪边，必须完全一致；
 *  - 纯函数、没有依赖，可以直接单测。
 *
 * 坐标系约定：任意 2D 平面，单位 = **一格**。
 *  - 2D：棋盘 8×8，格心在 (col+0.5, row+0.5)，y 轴向下；
 *  - 3D：世界坐标 (x, z)，格心在 squareToWorld() 给出的位置（y 轴向下换成 z 轴）。
 */

/** 二维点 */
export type Point = [number, number];

/** 箭头尺寸参数（单位：格） */
export interface ArrowOptions {
  /** 箭杆半宽 */
  shaftHalfWidth: number;
  /** 箭头长度（沿箭头方向） */
  headLength: number;
  /** 箭头半宽（比箭杆宽，形成「肩」） */
  headHalfWidth: number;
  /**
   * 箭尖沿箭头方向从终点往回退多少格（0 = 落在终点格心上）。
   *
   * 为什么 2D 用 0：
   * 2D 棋子是侧视剪影，美术只占格子的 ~28% 宽，而且**底座在格子底部**、
   * 格心附近是空的 —— 箭尖落在终点格心时**完全露在外面**，不会被压住。
   * 所以 2D 保持「箭尖精确落在终点格心」这个最强语义。
   *
   * 为什么 3D 要退一点：
   * 3D 棋子是实心的立体物，底座半径 0.19~0.22 格，而且斜视角下
   * **塔身会把它身后约 0.45~0.7 格的棋面整个挡住**
   * （遮挡长度 ≈ 棋子高 / tan(52°)）。箭尖压在终点格心时，箭头头
   * 几乎全落在棋子的屏幕投影里，只剩一小截杆（实测截图确认）。
   * 退 0.3 格，箭头头就骑在棋子底座外缘，方向一眼可辨；
   * 「走到了哪」由终点格的 lastmove 琥珀高亮承担（2D/3D 都画了）。
   */
  tipInset: number;
}

/** 默认尺寸：一格棋子的边长为 1 */
export const DEFAULT_ARROW: ArrowOptions = {
  shaftHalfWidth: 0.09,
  headLength: 0.3,
  headHalfWidth: 0.2,
  tipInset: 0,
};

/**
 * 2D 箭头尺寸。
 *
 * 2D 是正交俯视，棋子画在格子里（美术宽度约 0.28 格、底座在格子底部），
 * 箭尖落在终点格心不会被压住 → tipInset = 0，语义最强。
 * 头部半宽 0.24 格 > 棋子底座半宽 0.14 格，所以箭头头会从棋子两侧露出来。
 */
export const ARROW_2D: ArrowOptions = {
  shaftHalfWidth: 0.1,
  headLength: 0.34,
  headHalfWidth: 0.24,
  tipInset: 0,
};

/**
 * 3D 箭头尺寸。
 *
 * 3D 是斜视角（仰角约 52°），终点棋子是实心立体物：
 *   - 底座半径 0.19~0.22 格；
 *   - 塔身把它身后约 0.45~0.7 格的棋面整个挡住（遮挡长度 ≈ 棋子高 / tan(仰角)）。
 * 所以 3D 的箭头要**更粗更长**，并且把箭尖退 0.3 格，
 * 让箭头头骑在棋子底座外缘而不是正下方 —— 实测不这样的话只剩一小截黄杆。
 *
 * 头部半宽 0.30 格 > 底座半径 0.22 格：箭头头的两个角一定能从棋子两侧探出来。
 * 配合终点格的琥珀高亮，「谁走的」和「走到哪」都清楚。
 */
export const ARROW_3D: ArrowOptions = {
  shaftHalfWidth: 0.14,
  headLength: 0.38,
  headHalfWidth: 0.3,
  tipInset: 0.3,
};

/**
 * 计算从 `from` 指向 `to` 的箭头轮廓。
 *
 * 返回 7 个顶点，顺序为：
 *   杆后端(+法线) → 杆前端(+法线) → 箭头根部(+法线) → 箭头尖 → 箭头根部(-法线)
 *   → 杆前端(-法线) → 杆后端(-法线)
 *
 * 起点与终点**都在格心上**：
 *  - 起点是棋子**原来**待的格子（走完就空了），箭头从那里出发；
 *  - 终点是棋子**现在**待的格子，箭头尖正好落在格心。
 * 一根箭头同时说明「谁走的」和「走到哪」。
 *
 * 起点终点重合时返回空数组（不画），避免除零。
 */
export function arrowPolygon(
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: Partial<ArrowOptions> = {},
): Point[] {
  const { shaftHalfWidth, headLength, headHalfWidth, tipInset } = {
    ...DEFAULT_ARROW,
    ...options,
  };

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [];

  // 单位方向 u 与其左法线 n
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  /*
   * 箭尖位置：默认落在终点格心，但允许沿箭头方向回退 tipInset 格。
   * 回退后箭头仍然明确指向终点（终点格另有 lastmove 高亮），
   * 而箭头头不会被终点棋子的底座整个吞掉。
   */
  const tipX = to.x - ux * tipInset;
  const tipY = to.y - uy * tipInset;

  // 箭头的「根部平面」：从箭头尖往回退 headLength
  const baseX = tipX - ux * headLength;
  const baseY = tipY - uy * headLength;

  return [
    [from.x + nx * shaftHalfWidth, from.y + ny * shaftHalfWidth],
    [baseX + nx * shaftHalfWidth, baseY + ny * shaftHalfWidth],
    [baseX + nx * headHalfWidth, baseY + ny * headHalfWidth],
    [tipX, tipY],
    [baseX - nx * headHalfWidth, baseY - ny * headHalfWidth],
    [baseX - nx * shaftHalfWidth, baseY - ny * shaftHalfWidth],
    [from.x - nx * shaftHalfWidth, from.y - ny * shaftHalfWidth],
  ];
}

/**
 * 箭头多边形的中心（用于 3D 里把几何摆到两格之间的中点）。
 */
export function arrowCenter(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}
