/**
 * 3D 取景模型（src/lib/frame3d.ts）的单元测试。
 *
 * 这个模块是「棋盘在画布里长什么样」的唯一算法来源：
 *   - Board3D.tsx 用它做旋转时的自动退镜头；
 *   - scripts/solve-3d-camera.ts 用它离线求解默认机位。
 *
 * 所以它的正确性必须被守住 —— 尤其是「内容有没有出画」这条判据，
 * 写错一次就会让棋盘在旋转时被裁掉一块。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BASE_BOTTOM,
  BASE_TOP,
  CLIP_MARGIN,
  FILL,
  FOV,
  HALF_FOV,
  PIECE_TOP,
  boardExtent,
  contentExtent,
  contentPoints,
  extentOf,
  extentStats,
  fitsCanvas,
  safeDistance,
  solveFraming,
  solveTargetZ,
} from '@/lib/frame3d';

const D = Math.PI / 180;
/** 线上默认机位（与 Board3D.tsx 的常量保持一致） */
const DEFAULT_THETA = 38.0518 * D;
const DEFAULT_R = 9.3407;
const DEFAULT_TARGET_Z = 0.8181;
const DEFAULT_ASPECT = 1.5579;

describe('frame3d：内容点集', () => {
  it('底板角点覆盖 8.4 见方的边框', () => {
    const bottom = contentPoints().filter((p) => p.y === BASE_BOTTOM);
    const top = contentPoints().filter((p) => p.y === BASE_TOP);
    // 底面 4 个角 + 顶面 4 个角
    expect(bottom.length).toBe(4);
    expect(top.length).toBe(4);
    const board = [...bottom, ...top];
    const xs = board.map((p) => p.x);
    const zs = board.map((p) => p.z);
    expect(Math.min(...xs)).toBeCloseTo(-4.2, 6);
    expect(Math.max(...xs)).toBeCloseTo(4.2, 6);
    expect(Math.min(...zs)).toBeCloseTo(-4.2, 6);
    expect(Math.max(...zs)).toBeCloseTo(4.2, 6);
  });

  it('棋子按「每格都可能站最高的王」建模（最坏情况）', () => {
    const pieces = contentPoints().filter((p) => p.y === PIECE_TOP);
    // 64 格 × 12 个采样点
    expect(pieces.length).toBe(64 * 12);
    // 最高的王：十字冠顶端
    expect(Math.max(...pieces.map((p) => p.y))).toBeCloseTo(PIECE_TOP, 6);
  });
});

describe('frame3d：投影与 three.js 一致', () => {
  it('手写投影与 three.js 的 PerspectiveCamera 误差在浮点精度内', () => {
    const pose = { r: DEFAULT_R, theta: DEFAULT_THETA, phi: 0, targetZ: DEFAULT_TARGET_Z };
    const mine = contentExtent(pose);

    const cam = new THREE.PerspectiveCamera(FOV, DEFAULT_ASPECT, 0.1, 500);
    cam.position.set(
      pose.r * Math.sin(pose.theta) * Math.sin(pose.phi),
      pose.r * Math.cos(pose.theta),
      pose.targetZ + pose.r * Math.sin(pose.theta) * Math.cos(pose.phi),
    );
    cam.lookAt(0, 0, pose.targetZ);
    cam.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();

    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    const p = new THREE.Vector3();
    for (const point of contentPoints()) {
      p.set(point.x, point.y, point.z).applyMatrix4(inv);
      const depth = -p.z;
      const u = p.x / depth / HALF_FOV;
      const v = p.y / depth / HALF_FOV;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    expect(mine.u0).toBeCloseTo(u0, 10);
    expect(mine.u1).toBeCloseTo(u1, 10);
    expect(mine.v0).toBeCloseTo(v0, 10);
    expect(mine.v1).toBeCloseTo(v1, 10);
  });
});

describe('frame3d：投影方向', () => {
  it('棋盘左侧落在画面左侧（投影没有左右镜像）', () => {
    const pose = { r: DEFAULT_R, theta: DEFAULT_THETA, phi: 0, targetZ: DEFAULT_TARGET_Z };
    const left = extentOf([{ x: -4.2, y: -0.12, z: 4.2 }], pose);
    const right = extentOf([{ x: 4.2, y: -0.12, z: 4.2 }], pose);
    expect(left.u0).toBeLessThan(0);
    expect(right.u1).toBeGreaterThan(0);
    // 近端比远端宽（透视）—— 顺手确认深度方向也没搞反
    const near = extentOf([{ x: 4.2, y: -0.12, z: 4.2 }], pose);
    const far = extentOf([{ x: 4.2, y: -0.12, z: -4.2 }], pose);
    expect(Math.abs(near.u1)).toBeGreaterThan(Math.abs(far.u1));
  });
});

describe('frame3d：默认取景', () => {
  const framing = solveFraming(DEFAULT_THETA);

  it('解出的机位与线上常量一致（改动 Board3D.tsx 时必须同步）', () => {
    expect(framing.r).toBeCloseTo(DEFAULT_R, 2);
    expect(framing.targetZ).toBeCloseTo(DEFAULT_TARGET_Z, 2);
    expect(framing.aspect).toBeCloseTo(DEFAULT_ASPECT, 3);
  });

  it('内容纵向恰好占满 FILL 且上下居中', () => {
    const e = contentExtent({
      r: framing.r,
      theta: DEFAULT_THETA,
      phi: 0,
      targetZ: framing.targetZ,
    });
    expect(e.v0).toBeCloseTo(-FILL, 6);
    expect(e.v1).toBeCloseTo(FILL, 6);
    expect(extentStats(e).vMid).toBeCloseTo(0, 6);
  });

  it('横向占比与纵向占比相等（画布与棋盘形状贴合，不留白）', () => {
    const e = contentExtent({
      r: framing.r,
      theta: DEFAULT_THETA,
      phi: 0,
      targetZ: framing.targetZ,
    });
    const s = extentStats(e);
    expect(s.uSpan / framing.aspect).toBeCloseTo(s.vSpan, 6);
  });

  it('默认机位下内容完整落在画布里（没有棋子被裁）', () => {
    const e = contentExtent({
      r: framing.r,
      theta: DEFAULT_THETA,
      phi: 0,
      targetZ: framing.targetZ,
    });
    expect(fitsCanvas(e, framing.aspect)).toBe(true);
  });

  it('底板比内容矮（差值就是远处棋子顶出去的高度）', () => {
    const pose = { r: framing.r, theta: DEFAULT_THETA, phi: 0, targetZ: framing.targetZ };
    const content = extentStats(contentExtent(pose));
    const board = extentStats(boardExtent(pose));
    expect(content.vSpan).toBeGreaterThan(board.vSpan);
    // 但底板的横向范围与内容一致（边框角点决定横向）
    expect(board.uSpan).toBeCloseTo(content.uSpan, 6);
  });

  it('看向点求解是单调的（内容纵向中心随 targetZ 单调上移）', () => {
    let prev = -Infinity;
    for (let t = -1; t <= 3; t += 0.25) {
      const e = contentExtent({ r: DEFAULT_R, theta: DEFAULT_THETA, phi: 0, targetZ: t });
      const mid = extentStats(e).vMid;
      expect(mid).toBeGreaterThan(prev);
      prev = mid;
    }
    expect(solveTargetZ(DEFAULT_R, DEFAULT_THETA, 0)).toBeCloseTo(DEFAULT_TARGET_Z, 2);
  });
});

describe('frame3d：出画判定', () => {
  it('跨度小但中心偏出去，也必须判定为出画', () => {
    // 这是真实踩过的坑：内容纵向 [-1.045, 0.769]，
    // 跨度 1.815 看着没超 2，中心只偏 0.138 看着也在范围内，
    // 但下端已经越过 -1 被画布裁掉了。
    const e = { u0: -0.5, u1: 0.5, v0: -1.045, v1: 0.769 };
    expect(fitsCanvas(e, DEFAULT_ASPECT)).toBe(false);
  });

  it('端点正好在画布边界上算作贴边（不允许）', () => {
    const e = { u0: -0.5, u1: 0.5, v0: -1, v1: 0.5 };
    expect(fitsCanvas(e, DEFAULT_ASPECT)).toBe(false);
  });

  it('留有 CLIP_MARGIN 余量时才算通过', () => {
    const inside = { u0: -0.5, u1: 0.5, v0: -CLIP_MARGIN, v1: CLIP_MARGIN };
    expect(fitsCanvas(inside, DEFAULT_ASPECT)).toBe(true);
    const outside = { u0: -0.5, u1: 0.5, v0: -CLIP_MARGIN - 0.01, v1: CLIP_MARGIN };
    expect(fitsCanvas(outside, DEFAULT_ASPECT)).toBe(false);
  });

  it('横向按画布比例折算后判定', () => {
    // u 是「除以 aspect 之前」的口径：u/aspect 才是真正的 NDC 横向范围
    const wide = { u0: -1.6, u1: 1.6, v0: -0.5, v1: 0.5 };
    expect(fitsCanvas(wide, DEFAULT_ASPECT)).toBe(false);
    expect(fitsCanvas(wide, 4)).toBe(true);
  });
});

describe('frame3d：旋转时的安全距离（自动退镜头）', () => {
  it('默认方位角下，安全距离≈默认机位（略小，因为默认取景留了 1.5% 余量）', () => {
    const safe = safeDistance(DEFAULT_THETA, 0, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
    // 默认机位本身就在安全距离之内 → 自动退镜头不会改动它
    expect(safe).toBeLessThanOrEqual(DEFAULT_R);
    expect(safe).toBeCloseTo(DEFAULT_R, 0);
    const e = contentExtent({
      r: DEFAULT_R,
      theta: DEFAULT_THETA,
      phi: 0,
      targetZ: DEFAULT_TARGET_Z,
    });
    expect(fitsCanvas(e, DEFAULT_ASPECT)).toBe(true);
  });

  it('转得越远，需要的安全距离越大', () => {
    const at0 = safeDistance(DEFAULT_THETA, 0, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
    const at20 = safeDistance(DEFAULT_THETA, 20 * D, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
    const at60 = safeDistance(DEFAULT_THETA, 60 * D, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
    expect(at20).toBeGreaterThan(at0);
    expect(at60).toBeGreaterThan(at20);
  });

  it('安全距离处，内容完整落在画布里（这正是自动退镜头的保证）', () => {
    for (const deg of [0, 10, 30, 50, 68]) {
      const safe = safeDistance(DEFAULT_THETA, deg * D, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
      const e = contentExtent({
        r: safe,
        theta: DEFAULT_THETA,
        phi: deg * D,
        targetZ: DEFAULT_TARGET_Z,
      });
      expect(fitsCanvas(e, DEFAULT_ASPECT)).toBe(true);
    }
  });

  it('比安全距离更近时，内容一定会出画（说明这个距离是必要的）', () => {
    const deg = 40;
    const safe = safeDistance(DEFAULT_THETA, deg * D, DEFAULT_TARGET_Z, DEFAULT_ASPECT);
    const e = contentExtent({
      r: safe * 0.9,
      theta: DEFAULT_THETA,
      phi: deg * D,
      targetZ: DEFAULT_TARGET_Z,
    });
    expect(fitsCanvas(e, DEFAULT_ASPECT)).toBe(false);
  });

  it('黑方视角（targetZ 取负）与白方镜像等价', () => {
    const white = contentExtent({
      r: DEFAULT_R,
      theta: DEFAULT_THETA,
      phi: 30 * D,
      targetZ: DEFAULT_TARGET_Z,
    });
    // 黑方视角 = 白方沿 z 镜像：方位角 φ → π - φ
    const black = contentExtent({
      r: DEFAULT_R,
      theta: DEFAULT_THETA,
      phi: Math.PI - 30 * D,
      targetZ: -DEFAULT_TARGET_Z,
    });
    expect(black.v0).toBeCloseTo(white.v0, 6);
    expect(black.v1).toBeCloseTo(white.v1, 6);
    // z 镜像会让坐标系 handedness 翻转 → 横向范围左右对调
    expect(black.u0).toBeCloseTo(-white.u1, 6);
    expect(black.u1).toBeCloseTo(-white.u0, 6);
  });
});
