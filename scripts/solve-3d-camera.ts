/**
 * 3D 相机取景数值求解器。
 *
 * 核心算法在 src/lib/frame3d.ts（运行时与本脚本共用同一套公式），
 * 本脚本只负责「求解 + 打印 + 交叉校验」。
 *
 * 求解目标：
 *   1. 内容（底板 + 棋格 + 全部棋子）在纵向的投影高度 = 画布高度的 FILL 目标；
 *   2. 内容在纵向**居中**（不是一头空一头挤）；
 *   3. 画布宽高比 A = 内容的横向/纵向投影比 → 横向也刚好撑满。
 *
 * 用法：npx tsx scripts/solve-3d-camera.ts
 */

/* eslint-disable no-console */
import * as THREE from 'three';
import {
  BASE_BOTTOM,
  BASE_TOP,
  FILL,
  FOV,
  FRAME_HALF,
  PIECE_TOP,
  PLANE_Y,
  SQUARE_HALF,
  boardExtent,
  contentExtent,
  contentHeight,
  extentStats,
  solveFraming,
  solveTargetZ,
} from '../src/lib/frame3d';
import type { Pose } from '../src/lib/frame3d';

/* ------------------------------------------------------------------ */
/* 交叉校验：手写投影 vs three.js 真实相机                              */
/* ------------------------------------------------------------------ */

/**
 * frame3d.ts 的投影是手写的（要能在没有 WebGL 的环境里跑），
 * 这里用 three.js 的真实 PerspectiveCamera 对同一组点做一次比对 ——
 * 两边不一致就说明手写公式错了，立刻能发现。
 */
function crossCheck(): void {
  const pose: Pose = { r: 9.0891, theta: (40.02 * Math.PI) / 180, phi: 0, targetZ: 0.876 };
  const mine = contentExtent(pose);

  const cam = new THREE.PerspectiveCamera(FOV, 1.6262, 0.1, 500);
  const st = Math.sin(pose.theta);
  const ct = Math.cos(pose.theta);
  cam.position.set(pose.r * st * Math.sin(pose.phi), pose.r * ct, pose.targetZ + pose.r * st * Math.cos(pose.phi));
  cam.lookAt(0, 0, pose.targetZ);
  cam.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();

  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  const p = new THREE.Vector3();
  for (const point of CONTENT_POINTS) {
    p.set(point.x, point.y, point.z).applyMatrix4(inv);
    const depth = -p.z;
    const u = p.x / depth / Math.tan((FOV * Math.PI) / 360);
    const v = p.y / depth / Math.tan((FOV * Math.PI) / 360);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const delta = Math.max(
    Math.abs(u0 - mine.u0),
    Math.abs(u1 - mine.u1),
    Math.abs(v0 - mine.v0),
    Math.abs(v1 - mine.v1),
  );
  console.log(
    `交叉校验（手写 vs three.js）：最大偏差 ${delta.toExponential(2)}` +
      (delta < 1e-9 ? '  ✅ 一致' : '  ❌ 不一致，手写公式有问题'),
  );
}

/** 与 frame3d 相同口径的内容点集（这里独立重建一份，避免用缓存掩盖问题） */
const CONTENT_POINTS = (() => {
  const pts: Array<{ x: number; y: number; z: number }> = [];
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
  for (let file = 0; file < 8; file += 1) {
    for (let rank = 1; rank <= 8; rank += 1) {
      const cx = file - 3.5;
      const cz = 4.5 - rank;
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * 0.22, y: PLANE_Y, z: cz + Math.sin(a) * 0.22 });
        pts.push({ x: cx + Math.cos(a) * 0.22, y: PIECE_TOP, z: cz + Math.sin(a) * 0.22 });
      }
    }
  }
  return pts;
})();

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

/** NDC → 画布像素纵坐标（图像坐标：0 在**上**） */
const toPixelY = (ndc: number, ch: number): number => ((1 - ndc) / 2) * ch;

function report(thetaDeg: number, panelW: number, panelH: number): void {
  const theta = (thetaDeg * Math.PI) / 180;
  const { r, targetZ, aspect } = solveFraming(theta);
  const pose: Pose = { r, theta, phi: 0, targetZ };
  const content = contentExtent(pose);
  const stats = extentStats(content);
  const board = extentStats(boardExtent(pose));

  // 画布在「棋盘所在列」里的实际尺寸：宽取列宽，高由 aspect 推导，再被可用高度兜底
  const canvasW = Math.min(panelW, panelH * aspect);
  const canvasH = canvasW / aspect;

  const posY = r * Math.cos(theta);
  const posZ = targetZ + r * Math.sin(theta);
  const positionPitch = (Math.atan2(posY, posZ) * 180) / Math.PI;
  const viewPitch = (Math.atan2(posY, posZ - targetZ) * 180) / Math.PI;

  console.log(`\n=== 极角 ${thetaDeg}°（位置俯角 ${positionPitch.toFixed(2)}° / 视线俯角 ${viewPitch.toFixed(2)}°）===`);
  console.log(`距离 r（相机→看向点）= ${r.toFixed(4)}`);
  console.log(`相机位置             = (0, ${posY.toFixed(4)}, ${posZ.toFixed(4)})`);
  console.log(`看向点偏移 targetZ   = ${targetZ.toFixed(4)}`);
  console.log(`画布宽高比 A         = ${aspect.toFixed(4)}`);
  console.log(
    `内容纵向 NDC = [${content.v0.toFixed(4)}, ${content.v1.toFixed(4)}]  中心 ${stats.vMid.toFixed(5)}  跨度 ${stats.vSpan.toFixed(4)}`,
  );
  console.log(
    `内容横向 NDC = [${(content.u0 / aspect).toFixed(4)}, ${(content.u1 / aspect).toFixed(4)}]  跨度 ${(stats.uSpan / aspect).toFixed(4)}`,
  );
  console.log(`内容占画布            = 纵向 ${((stats.vSpan / 2) * 100).toFixed(2)}% / 横向 ${((stats.uSpan / aspect / 2) * 100).toFixed(2)}%`);
  console.log(`底板占画布            = 纵向 ${((board.vSpan / 2) * 100).toFixed(2)}% / 横向 ${((board.uSpan / aspect / 2) * 100).toFixed(2)}%`);
  console.log(
    `在 ${panelW}×${panelH} 的列里 → 画布 ${Math.round(canvasW)}×${Math.round(canvasH)}` +
      `，内容 ${Math.round((stats.uSpan / aspect / 2) * canvasW)}×${Math.round((stats.vSpan / 2) * canvasH)} 像素` +
      `，底板 ${Math.round((board.uSpan / aspect / 2) * canvasW)}×${Math.round((board.vSpan / 2) * canvasH)} 像素`,
  );
  console.log(`内容高 / 底板高      = ${(stats.vSpan / board.vSpan).toFixed(4)}（>1 的部分是远处棋子顶出去的高度）`);
}

/** 方位角扫描：旋转时内容会怎么变形（用于判断自动退镜头的效果） */
function scanAzimuth(thetaDeg: number): void {
  const theta = (thetaDeg * Math.PI) / 180;
  const { r, targetZ, aspect } = solveFraming(theta);
  console.log('\n--- 方位角扫描（同一距离下旋转，内容会溢出画布）---');
  console.log('   角度   横向占比   纵向占比   需要的安全距离');
  for (const deg of [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 68]) {
    const phi = (deg * Math.PI) / 180;
    const e = contentExtent({ r, theta, phi, targetZ });
    const s = extentStats(e);
    // 安全距离：保持极角不变，把相机退到内容刚好不溢出（距离越大投影越小）
    let lo = r;
    let hi = 40;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      const m = extentStats(contentExtent({ r: mid, theta, phi, targetZ }));
      if (m.vSpan <= 2 * FILL) hi = mid;
      else lo = mid;
    }
    console.log(
      `  ${String(deg).padStart(4)}°   ${((s.uSpan / aspect / 2) * 100).toFixed(1).padStart(7)}%   ` +
        `${((s.vSpan / 2) * 100).toFixed(1).padStart(7)}%   ${hi.toFixed(2)}（默认 ${r.toFixed(2)}）`,
    );
  }
}

/**
 * 校验：给定机位，预测它在「指定画布尺寸」下的像素表现。
 * 用来跟 verify-3d-viewport.ts 的**实测**数字对账，确认模型和像素口径一致。
 */
function check(
  r: number,
  thetaDeg: number,
  targetZ: number,
  cw: number,
  ch: number,
  phiDeg = 0,
): void {
  const theta = (thetaDeg * Math.PI) / 180;
  const content = contentExtent({ r, theta, phi: (phiDeg * Math.PI) / 180, targetZ });
  const aspect = cw / ch;
  console.log(
    `\n--- 校验 r=${r.toFixed(4)} theta=${thetaDeg.toFixed(4)}° targetZ=${targetZ} phi=${phiDeg}° 画布 ${cw}×${ch}（aspect ${aspect.toFixed(4)}）---`,
  );
  console.log(
    `内容纵向像素：${toPixelY(content.v1, ch).toFixed(1)} ~ ${toPixelY(content.v0, ch).toFixed(1)}` +
      `（画布 0 ~ ${ch}）→ 上沿 ${toPixelY(content.v1, ch).toFixed(1)}px / 下沿 ${(ch - toPixelY(content.v0, ch)).toFixed(1)}px`,
  );
  console.log(
    `内容横向像素：${((((content.u0 / aspect) + 1) / 2) * cw).toFixed(1)} ~ ${((((content.u1 / aspect) + 1) / 2) * cw).toFixed(1)}（画布 0 ~ ${cw}）`,
  );
  console.log(`内容纵向占比 ${(((content.v1 - content.v0) / 2) * 100).toFixed(2)}%`);
}

/** 极角扫描：改变俯仰时，内容会怎么变形（用于核对 OrbitControls 的 polar 限幅） */
function scanPolar(thetaDeg: number): void {
  const base = (thetaDeg * Math.PI) / 180;
  const { r, targetZ, aspect } = solveFraming(base);
  console.log('\n--- 极角扫描（同一距离下改变俯仰）---');
  console.log('   极角   横向占比   纵向占比   需要的安全距离');
  for (const deg of [28.8, 32, 35, 38.0518, 41, 44, 48, 52, 56, 60, 64.8]) {
    const theta = (deg * Math.PI) / 180;
    const e = contentExtent({ r, theta, phi: 0, targetZ });
    const s = extentStats(e);
    let lo = r;
    let hi = 60;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      const m = extentStats(contentExtent({ r: mid, theta, phi: 0, targetZ }));
      if (m.vSpan <= 2 * FILL) hi = mid;
      else lo = mid;
    }
    console.log(
      `  ${deg.toFixed(2).padStart(5)}°   ${((s.uSpan / aspect / 2) * 100).toFixed(1).padStart(7)}%   ` +
        `${((s.vSpan / 2) * 100).toFixed(1).padStart(7)}%   ${hi.toFixed(2)}（默认 ${r.toFixed(2)}）`,
    );
  }
}

console.log('3D 取景求解器');
console.log(`fov=${FOV}°  FILL=${FILL}`);
crossCheck();

// 参考列尺寸：用户的 1920×1350 屏幕（棋盘列约 1468 宽、可用高度 1218）
for (const thetaDeg of [36, 38.0518, 40, 42, 45, 48]) {
  report(thetaDeg, 1468, 1218);
}
scanAzimuth(38.0518);
scanPolar(38.0518);

// 与当前生产机位对账（实测：填充率 89.8% / 93.5%，内容包围盒 875×505，远端棋子被上沿裁掉）
// 生产机位：pos=(0,6.559,-6.333)，target=(0,0,-1.199)（黑方视角）
{
  const pos = { x: 0, y: 6.559, z: -6.333 };
  const target = { x: 0, y: 0, z: -1.199 };
  const off = { x: pos.x - target.x, y: pos.y - target.y, z: pos.z - target.z };
  const r = Math.hypot(off.x, off.y, off.z);
  const theta = Math.acos(off.y / r);
  const phi = Math.atan2(off.x, off.z);
  check(r, (theta * 180) / Math.PI, target.z, 920, 518, (phi * 180) / Math.PI);
  console.log(
    `   （生产机位：r=${r.toFixed(4)} theta=${((theta * 180) / Math.PI).toFixed(4)}° phi=${((phi * 180) / Math.PI).toFixed(2)}°）`,
  );
}

// 顺带验证 solveTargetZ 的单调性假设
{
  const theta = (40 * Math.PI) / 180;
  const r = 9.0891;
  let prev = -Infinity;
  let mono = true;
  for (let t = -1; t <= 3; t += 0.25) {
    const e = contentExtent({ r, theta, phi: 0, targetZ: t });
    const mid = extentStats(e).vMid;
    if (mid <= prev) mono = false;
    prev = mid;
  }
  console.log(`\n看向点单调性（targetZ 越大内容越靠上）：${mono ? '✅ 单调' : '❌ 非单调，二分求解会失效'}`);
  console.log(`解出的 targetZ = ${solveTargetZ(r, theta, 0).toFixed(4)}，此时内容纵向跨度 = ${contentHeight(r, theta, 0).toFixed(4)}`);
}
