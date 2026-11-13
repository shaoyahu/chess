/**
 * 剪影计算（测试专用）—— 把 3D 几何体投影到**对局视角**并栅格化成占用图。
 *
 * 为什么单独抽出来：
 *   「六种棋子的剪影两两不同」这条判据要被**多个测试文件**用到
 *   （经典版一次、每种新风格各一次）。
 *   复制一份就会漂移 —— 改了一处忘了另一处，判据就名存实亡。
 *
 * 投影基（与对局相机一致）：
 *   u = x（相机的右轴，相机在 y-z 平面上）
 *   v = y·sin(polar) - z·cos(polar)（相机的上轴）
 */
import * as THREE from 'three';

/** 对局相机的极角（与 Board3D / frame3d 一致） */
export const POLAR = (38.0518 * Math.PI) / 180;

/** 把几何体投影到对局视角 */
export function project(geo: THREE.BufferGeometry): Array<[number, number]> {
  const pos = geo.getAttribute('position');
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const vi = index ? index.getX(i) : i;
    const x = pos.getX(vi);
    const y = pos.getY(vi);
    const z = pos.getZ(vi);
    out.push([x, y * Math.sin(POLAR) - z * Math.cos(POLAR)]);
  }
  return out;
}

/** 共享的投影范围（覆盖全部棋子） */
export function sharedBounds(geos: THREE.BufferGeometry[]): {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
} {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const geo of geos) {
    for (const [u, v] of project(geo)) {
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  return { minU, maxU, minV, maxV };
}

/**
 * 栅格化成占用图（'#' = 有料，'.' = 空）。
 *
 * ⚠️ 六个棋子必须**共用同一套投影范围**（bounds）——
 *   否则每个棋子都被归一化到自己的包围盒里，兵和车一样高、一样宽，
 *   比例信息全丢，测试就成了摆设。
 */
export function silhouette(
  geo: THREE.BufferGeometry,
  bounds: { minU: number; maxU: number; minV: number; maxV: number },
  cells = 32,
): string[] {
  const index = geo.getIndex();
  const count = index ? index.count : geo.getAttribute('position').count;
  const uvs = project(geo);

  const { minU, minV } = bounds;
  const spanU = Math.max(bounds.maxU - minU, 1e-6);
  const spanV = Math.max(bounds.maxV - minV, 1e-6);
  const grid = new Set<string>();

  const cellOf = (u: number, v: number): [number, number] => [
    Math.min(cells - 1, Math.max(0, Math.floor(((u - minU) / spanU) * cells))),
    Math.min(cells - 1, Math.max(0, Math.floor(((v - minV) / spanV) * cells))),
  ];

  /**
   * 点在三角形内（标准叉积符号判定，对顺/逆时针都成立）。
   *
   * ⚠️ 三个叉积必须**沿同一条边序**（AB、BC、CA）算，
   *    混用顶点顺序会让符号永远不一致 —— 结果是**一个格子都命中不了**，
   *    剪影图全空、六个棋子看起来「一模一样」。
   */
  const cross = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    px: number,
    py: number,
  ): number => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

  const inside = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): boolean => {
    const d1 = cross(ax, ay, bx, by, px, py);
    const d2 = cross(bx, by, cx, cy, px, py);
    const d3 = cross(cx, cy, ax, ay, px, py);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  for (let t = 0; t + 2 < count; t += 3) {
    const [ax, ay] = uvs[t];
    const [bx, by] = uvs[t + 1];
    const [cx, cy] = uvs[t + 2];
    const c0 = cellOf(ax, ay);
    const c1 = cellOf(bx, by);
    const c2 = cellOf(cx, cy);
    const loX = Math.min(c0[0], c1[0], c2[0]);
    const hiX = Math.max(c0[0], c1[0], c2[0]);
    const loY = Math.min(c0[1], c1[1], c2[1]);
    const hiY = Math.max(c0[1], c1[1], c2[1]);
    for (let gx = loX; gx <= hiX; gx += 1) {
      for (let gy = loY; gy <= hiY; gy += 1) {
        // 格子中心在投影三角形内 → 占用
        const u = minU + ((gx + 0.5) / cells) * spanU;
        const v = minV + ((gy + 0.5) / cells) * spanV;
        if (inside(u, v, ax, ay, bx, by, cx, cy)) grid.add(`${gx},${gy}`);
      }
    }
  }

  const out: string[] = [];
  for (let gy = 0; gy < cells; gy += 1) {
    for (let gx = 0; gx < cells; gx += 1) out.push(grid.has(`${gx},${gy}`) ? '#' : '.');
  }
  return out;
}
