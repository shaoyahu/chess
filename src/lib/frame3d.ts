/**
 * 3D 取景模型 —— 棋盘 + 棋子在相机下的**解析投影**。
 *
 * 这是 Board3D.tsx（运行时相机）与 scripts/solve-3d-camera.ts（离线求解器）
 * 的**唯一**算法来源：两边共用同一套公式，改一处不会漏改另一处。
 *
 * 坐标系（three.js 世界坐标）：
 *   x = 文件方向（a..h → -3.5..3.5）
 *   y = 高度（棋面在 y = 0.05）
 *   z = 进深方向（rank1 → +3.5，rank8 → -3.5）
 *
 * 相机用 OrbitControls 的球坐标描述（和 OrbitControls 内部完全一致）：
 *   看向点 target = (0, 0, ±targetZ)
 *   相机位置 = target + r · (sinθ·sinφ, cosθ, sinθ·cosφ)
 *     r   = 相机到看向点的距离（= OrbitControls 的 distance）
 *     θ   = 极角，从 +Y 轴量起（= OrbitControls 的 polar）
 *     φ   = 方位角，绕 Y 轴，0 = 从 +z 侧俯视（= OrbitControls 的 azimuth）
 *
 * 投影口径（与 three.js 的 PerspectiveCamera 一致）：
 *   NDC_x = u / aspect，NDC_y = v
 *   u = (x_cam / depth) / tan(fov/2)，v = (y_cam / depth) / tan(fov/2)
 * three.js 的 fov 是**垂直**视场角，aspect 只影响横向缩放，
 * 所以把 aspect 单独摘出来，才能把「内容长什么样」和「画布多宽」两个问题解耦。
 */

/* ------------------------------------------------------------------ */
/* 场景常量（必须与 pieceGeometry.ts / Board3D.tsx 保持一致）            */
/* ------------------------------------------------------------------ */

/** 底板半宽（8.4 见方） */
export const FRAME_HALF = 4.2;
/** 棋格半宽（8 格 = 8.0 见方） */
export const SQUARE_HALF = 3.5;
/** 底板底面 / 顶面高度 */
export const BASE_BOTTOM = -0.12;
export const BASE_TOP = 0.02;
/** 棋格平面高度 */
export const PLANE_Y = 0.05;
/** 棋子底座最大半径（王的底座 0.22） */
export const PIECE_RADIUS = 0.22;
/** 棋子最高点（王的十字冠顶端）绝对高度 */
export const PIECE_TOP = 1.04;
/** 垂直视场角（度） */
export const FOV = 42;
/** tan(fov/2) */
export const HALF_FOV = Math.tan((FOV * Math.PI) / 360);
/**
 * 内容在画布里允许占的最大比例。
 * 1 = 正好贴边（会被裁），留一点余量才安全。
 */
export const FILL = 0.97;
/**
 * 自动退镜头时，内容必须落在画布的哪个范围内。
 *
 * 比 FILL 略宽一点：FILL 是「默认取景占多少」，CLIP_MARGIN 是「旋转时最多能碰边到哪」，
 * 两者留一点重叠，保证默认机位本身也满足自动退镜头的条件。
 */
export const CLIP_MARGIN = 0.98;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** NDC 范围（u 为「除以 aspect 之前」的横向口径） */
export interface Extent {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** 相机位姿（球坐标 + 看向点） */
export interface Pose {
  /** 相机到看向点的距离 */
  r: number;
  /** 极角（弧度，从 +Y 轴量起） */
  theta: number;
  /** 方位角（弧度，绕 Y 轴） */
  phi: number;
  /** 看向点的 z 坐标（黑方视角取负） */
  targetZ: number;
}

/* ------------------------------------------------------------------ */
/* 内容点集                                                            */
/* ------------------------------------------------------------------ */

/** 圆柱采样点数：圆柱投影的极值必然出现在上下两圈上，12 点足够贴近真实轮廓 */
const CIRCLE_SAMPLES = 12;

/** 底板 + 棋格平面的角点 */
export function boardPoints(): Vec3[] {
  const pts: Vec3[] = [];
  for (const x of [-FRAME_HALF, FRAME_HALF]) {
    for (const z of [-FRAME_HALF, FRAME_HALF]) {
      pts.push({ x, y: BASE_BOTTOM, z });
      pts.push({ x, y: BASE_TOP, z });
    }
  }
  for (const x of [-SQUARE_HALF, SQUARE_HALF]) {
    for (const z of [-SQUARE_HALF, SQUARE_HALF]) {
      pts.push({ x, y: PLANE_Y, z });
    }
  }
  return pts;
}

/**
 * 棋子点集：**按「每个格子上都可能有最高的王」建模**。
 *
 * 这样算出来的机位，保证任何局面、任何子力分布都不会被画布裁掉 ——
 * 而不是为了「开局摆好的那 32 枚棋子」量身定做的取景。
 */
export function piecePoints(): Vec3[] {
  const pts: Vec3[] = [];
  for (let file = 0; file < 8; file += 1) {
    for (let rank = 1; rank <= 8; rank += 1) {
      const cx = file - 3.5;
      const cz = 4.5 - rank;
      for (let i = 0; i < CIRCLE_SAMPLES; i += 1) {
        const a = (i / CIRCLE_SAMPLES) * Math.PI * 2;
        const px = cx + Math.cos(a) * PIECE_RADIUS;
        const pz = cz + Math.sin(a) * PIECE_RADIUS;
        pts.push({ x: px, y: PLANE_Y, z: pz });
        pts.push({ x: px, y: PIECE_TOP, z: pz });
      }
    }
  }
  return pts;
}

let cachedContent: Vec3[] | null = null;
let cachedBoard: Vec3[] | null = null;

/** 内容点集（底板 + 全部棋子），模块内缓存 */
export function contentPoints(): Vec3[] {
  if (!cachedContent) cachedContent = [...boardPoints(), ...piecePoints()];
  return cachedContent;
}

/** 底板点集（不含棋子），模块内缓存 */
export function baseBoardPoints(): Vec3[] {
  if (!cachedBoard) cachedBoard = boardPoints();
  return cachedBoard;
}

/* ------------------------------------------------------------------ */
/* 投影                                                                */
/* ------------------------------------------------------------------ */

/** 相机正交基（x = 右，y = 上，z = 从看向点指向相机） */
interface Basis {
  pos: Vec3;
  ax: Vec3;
  ay: Vec3;
  az: Vec3;
}

function basisOf(pose: Pose): Basis {
  const { r, theta, phi, targetZ } = pose;
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const target: Vec3 = { x: 0, y: 0, z: targetZ };
  const pos: Vec3 = {
    x: target.x + r * st * sp,
    y: target.y + r * ct,
    z: target.z + r * st * cp,
  };
  // z 轴 = 从看向点指向相机
  const az: Vec3 = {
    x: (pos.x - target.x) / r,
    y: (pos.y - target.y) / r,
    z: (pos.z - target.z) / r,
  };
  // x 轴 = normalize(cross(worldUp, z))，worldUp = (0,1,0)
  let ax: Vec3 = { x: az.z, y: 0, z: -az.x };
  const al = Math.hypot(ax.x, ax.y, ax.z) || 1;
  ax = { x: ax.x / al, y: ax.y / al, z: ax.z / al };
  // y 轴 = cross(z, x)
  const ay: Vec3 = {
    x: az.y * ax.z - az.z * ax.y,
    y: az.z * ax.x - az.x * ax.z,
    z: az.x * ax.y - az.y * ax.x,
  };
  return { pos, ax, ay, az };
}

/** 把一组世界坐标点投影，取 NDC 包围范围 */
export function extentOf(points: Vec3[], pose: Pose): Extent {
  const { pos, ax, ay, az } = basisOf(pose);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of points) {
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    const depth = -(dx * az.x + dy * az.y + dz * az.z);
    if (depth <= 0.05) continue;
    const cx = dx * ax.x + dy * ax.y + dz * ax.z;
    const cy = dx * ay.x + dy * ay.y + dz * ay.z;
    const u = cx / depth / HALF_FOV;
    const v = cy / depth / HALF_FOV;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  return { u0, u1, v0, v1 };
}

/** 内容（底板 + 棋子）的投影范围 */
export function contentExtent(pose: Pose): Extent {
  return extentOf(contentPoints(), pose);
}

/** 底板的投影范围 */
export function boardExtent(pose: Pose): Extent {
  return extentOf(baseBoardPoints(), pose);
}

/** 范围的中点与跨度 */
export function extentStats(e: Extent): {
  uMid: number;
  vMid: number;
  uSpan: number;
  vSpan: number;
} {
  return {
    uMid: (e.u0 + e.u1) / 2,
    vMid: (e.v0 + e.v1) / 2,
    uSpan: e.u1 - e.u0,
    vSpan: e.v1 - e.v0,
  };
}

/**
 * 内容是否完整落在画布里（既没被裁，也没偏出画面）。
 *
 * 判据就是「内容的两端都在 NDC 的 [-margin, margin] 之内」。
 *
 * 注意：不能写成「跨度 ≤ 2·margin 且 中心偏移 ≤ margin」——
 * 那两个条件**各自成立不代表合起来成立**：
 * 中心偏 0.138、跨度 1.815 时内容是 [-1.045, 0.769]，已经越过 -1 被裁掉了，
 * 但两个条件却都满足。踩过这个坑，所以这里老老实实按两端判。
 */
export function fitsCanvas(e: Extent, aspect: number, margin = CLIP_MARGIN): boolean {
  return (
    e.u0 / aspect >= -margin &&
    e.u1 / aspect <= margin &&
    e.v0 >= -margin &&
    e.v1 <= margin
  );
}

/* ------------------------------------------------------------------ */
/* 求解                                                                */
/* ------------------------------------------------------------------ */

/**
 * 给定距离 r，二分出「让内容纵向居中」的看向点 targetZ。
 *
 * 看向点往近端挪 → 相机俯得更低 → 内容整体上移，
 * 所以 v 中心随 targetZ 单调递增，可以二分。
 */
export function solveTargetZ(r: number, theta: number, phi: number): number {
  let lo = -4;
  let hi = 6;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const e = contentExtent({ r, theta, phi, targetZ: mid });
    if (extentStats(e).vMid > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 给定距离 r（此时 targetZ 已让内容居中），返回内容纵向投影高度。
 * 距离越大 → 投影越小 → 单调递减，可以二分。
 */
export function contentHeight(r: number, theta: number, phi: number): number {
  const targetZ = solveTargetZ(r, theta, phi);
  return extentStats(contentExtent({ r, theta, phi, targetZ })).vSpan;
}

/**
 * 主求解：让内容撑满画布（纵向占 FILL、居中），并让横向也刚好撑满。
 *
 * 返回的 aspect 就是「棋盘在该机位下的投影宽高比」，
 * 把它写进 CSS 的 --board3d-aspect，画布与棋盘形状一致，一点空间都不浪费。
 */
export function solveFraming(theta: number): {
  r: number;
  targetZ: number;
  aspect: number;
} {
  const target = 2 * FILL;
  let lo = 2;
  let hi = 40;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (contentHeight(mid, theta, 0) > target) lo = mid;
    else hi = mid;
  }
  const r = (lo + hi) / 2;
  const targetZ = solveTargetZ(r, theta, 0);
  const stats = extentStats(contentExtent({ r, theta, phi: 0, targetZ }));
  return { r, targetZ, aspect: stats.uSpan / stats.vSpan };
}

/**
 * 安全距离的缓存。
 *
 * 求解一次要遍历全部内容点（1500+ 个）跑 24 轮二分，
 * 而拖拽时每帧角度都在变 —— 按「极角 / 看向点 / 方位角分桶 / 画布比例」缓存，
 * 同一桶内复用结果（桶内取**最坏**角度算，保证不会低估）。
 */
const safeCache = new Map<string, number>();

/**
 * 「棋盘完整可见」所需的安全距离 —— **参考模型，运行时不再调用**。
 *
 * 旋转视角时，棋盘靠近相机的那一角会被透视拉出画面，
 * 这个函数给出当前姿态下**内容仍能完整落在画布内**的最小距离。
 *
 * 以前 Board3D 的 auto-frame 会用它把相机自动退后一点（棋盘因此自己缩小），
 * 现在按用户要求**取消了这个自动缩放**（棋盘转过来就转过来），
 * 所以这个函数只剩两个用途：
 *   ① 单测（保证这段几何推导本身没写错）；
 *   ② `npm run verify:3d` 的诊断输出 —— 告诉你「此刻若要不裁，得退到多远」。
 *
 * 为什么取消之后棋盘一定会被裁（几何上回避不掉）：
 * 棋盘是平铺在地面上的**正方形**，转到接近对角线方向时它在画面里会变得更高
 * （沿对角线看过去，纵深从 8.4 变成 8.4·√2），
 * 而画布高度是固定的 → 棋盘占画布的比例只跟姿态有关，跟画布多大无关。
 * 唯一能救的两条路：把相机推远（= 被否掉的自动缩放）或把画布加高（布局不允许）。
 *
 * @param theta   极角（弧度）
 * @param phi     方位角（弧度）
 * @param targetZ 看向点 z
 * @param aspect  画布宽高比
 */
export function safeDistance(
  theta: number,
  phi: number,
  targetZ: number,
  aspect: number,
): number {
  // 方位角按 2° 分桶，桶内用最大角度求解（保守，不会低估安全距离）
  const bucket = Math.ceil((Math.abs(phi) * 180) / Math.PI / 2);
  const bucketPhi = (bucket * 2 * Math.PI) / 180;
  const key = `${theta.toFixed(4)}|${targetZ.toFixed(4)}|${bucket}|${aspect.toFixed(3)}`;
  const cached = safeCache.get(key);
  if (cached !== undefined) return cached;

  // 纵向约束与 aspect 无关 → 先按纵向解，再补横向
  let lo = 2;
  let hi = 40;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const e = contentExtent({ r: mid, theta, phi: bucketPhi, targetZ });
    if (fitsCanvas(e, aspect)) hi = mid;
    else lo = mid;
  }
  let r = hi;
  for (let i = 0; i < 60 && r < 40; i += 1) {
    const e = contentExtent({ r, theta, phi: bucketPhi, targetZ });
    if (fitsCanvas(e, aspect)) break;
    r *= 1.03;
  }
  safeCache.set(key, r);
  return r;
}
