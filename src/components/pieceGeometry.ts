'use client';

/**
 * 3D 棋子几何 —— 用 Lathe（回转体）+ Extrude（挤出）程序化生成，不是平面贴图。
 *
 * 这样 3D 用户看到的是**真正的立体棋子**：有体积、有高光、有阴影，
 * 走子时棋子离开棋面、跨越中线、落回 —— 与 2D 的「格子间平移」形成对比，
 * 但两者落点坐标完全一致（同一份 FEN）。
 *
 * 造型与 2D 的 SVG（PieceGlyph.tsx）保持同一套设计语言：
 * 底座 → 领圈 → 收腰柱 → 头部，各部件比例一一对应。
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-11-11 重做：辨识度优先
 *
 * 旧版的病根是**所有棋子都是同一个回转体**：
 *   兵/象/后/王只是剖面上几个半径不同，剪影几乎一样 —— 远看全是「瓶子」；
 *   唯一的例外件（马的挤出头、王的十字、车的城垛）又做得太小，
 *   在 3D 的斜视角下小到只剩一个疙瘩，于是「看不出来到底是什么棋子」。
 *
 * 这一版给每种棋子一个**一眼可辨的剪影特征**：
 *   兵 —— 大球头 + 领圈 + 细颈
 *   车 —— 六个城垛围成的垛口（从上方看最清楚）
 *   象 —— 胖水滴主教冠 + **斜切裂口** + 顶珠
 *   后 —— 五/六尖冠 + 每尖一颗珠
 *   王 —— 大十字
 *   马 —— 侧脸马头 + 鬃毛（**侧脸朝向镜头**，正面看才是马）
 * ─────────────────────────────────────────────────────────────
 *
 * 2026-11-12 加了**风格**这一维（材质是另一维，见 pieceMaterial）：
 *
 *   classic 经典 —— 就是上面这一套（保持不变）
 *   cartoon 卡通 —— 重新捏一套**圆胖**的剖面：宽身子、大脑袋，
 *                   再加一对大眼睛（卡通的识别特征就靠它）
 *   pixel   像素 —— 把 2D 的位图精灵**挤成体素**：逐行长条合并成盒子，
 *                   于是 2D 与 3D 用的是同一张图（见 pieceShapes.pixelGrid）
 *   doodle  涂鸦 —— 骨架同经典，但每个顶点按位置做**确定性抖动**，
 *                   看起来像手捏出来的（抖的是位置而不是序号，
 *                   这样相邻部件不会裂开）
 */
import * as THREE from 'three';
import { pieceDetailShapes } from '@/components/PieceGlyph';
import { pieceOutlinePath, pixelGrid, PixelCell, type PixelCellValue } from '@/components/pieceShapes';
import { parseSvgPath } from '@/lib/svg-path';
import { piecePalette, type PieceMaterial, type PieceStyle } from '@/lib/piece-appearance';
import { generateWoodCanvas } from '@/lib/woodTexture';
import type { PieceType } from '@/lib/types';

/** 棋盘格边长（世界单位） */
export const SQUARE_SIZE = 1;

/**
 * 棋子最大高度（世界单位），与 2D 的 SVG 比例对应。
 *
 * 上限受取景模型约束：frame3d.ts 的 PIECE_TOP = 1.04（棋面 0.05 + 0.99），
 * 超过它棋子就会被画布上沿裁掉，所以最高的王取 0.96。
 */
export const PIECE_HEIGHT: Record<PieceType, number> = {
  p: 0.62,
  n: 0.78,
  b: 0.78,
  r: 0.76,
  q: 0.88,
  k: 0.96,
};

/** 棋子底座半径 */
const BASE_RADIUS: Record<PieceType, number> = {
  p: 0.185,
  n: 0.195,
  b: 0.195,
  r: 0.205,
  q: 0.215,
  k: 0.215,
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 回转体：由「半径 / 高度」序列生成（点必须按 y 从小到大排） */
function lathe(profile: Array<[number, number]>, segments = 56): THREE.BufferGeometry {
  const pts = profile.map(([x, y]) => new THREE.Vector2(Math.max(x, 0.0001), y));
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 底座（宽脚 + 窄腰）—— 六个棋子共用。
 * 几何特征与 2D 的 plinth() 一一对应。
 */
function plinthProfile(r0: number): Array<[number, number]> {
  return [
    [0, 0],
    [r0, 0],
    [r0, 0.016],
    [r0 * 0.94, 0.027],
    [r0 * 0.94, 0.044],
    [r0 * 0.87, 0.056],
    [r0 * 0.85, 0.062],
  ];
}

/* ------------------------------------------------------------------ */
/* 各棋子的构造                                                        */
/* ------------------------------------------------------------------ */

/** 兵：底座 + 收腰柱 + 领圈 + 颈 + 大球头 */
function pawnGeometry(): THREE.BufferGeometry {
  const r0 = BASE_RADIUS.p;
  const body = lathe([
    ...plinthProfile(r0),
    [r0 * 0.6, 0.125],
    [0.082, 0.215],
    [0.066, 0.3],
    [0.058, 0.35],
    [0.092, 0.362], // 领圈外扩（比杆身宽出一圈，小图才看得出「兵有领子」）
    [0.092, 0.392],
    [0.048, 0.404], // 收到颈
    [0.042, 0.45],
    [0, 0.458],
  ]);
  const head = new THREE.SphereGeometry(0.092, 32, 24);
  head.translate(0, 0.53, 0);
  return mergeGeometries([body, head]);
}

/** 车：底座 + 塔身 + 冠部环 + 六个城垛 */
function rookGeometry(): THREE.BufferGeometry {
  const r0 = BASE_RADIUS.r;
  const body = lathe([
    ...plinthProfile(r0),
    [r0 * 0.72, 0.1],
    [0.142, 0.2],
    [0.138, 0.33],
    [0.14, 0.45],
    [0.146, 0.545],
    [0.156, 0.59],
    [0.156, 0.628], // 冠部环
    [0.148, 0.645],
    [0, 0.648],
  ]);

  // 六个城垛围成一圈 —— 从上往下看是「一圈齿」，这是车最强的识别特征
  const parts: THREE.BufferGeometry[] = [body];
  const count = 6;
  const ring = 0.118;
  const merlonW = 0.095;
  const merlonH = 0.145;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    const g = new THREE.BoxGeometry(merlonW, merlonH, merlonW);
    g.translate(0, merlonH / 2, 0);
    g.rotateY(-a);
    g.translate(ring * Math.cos(a), 0.628, ring * Math.sin(a));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/**
 * 主教冠剖面（半径, 高度）—— **胖水滴**。
 *
 * 为什么必须胖：
 *   旧版是一根细锥（最宽处半径 0.1、高 0.4），52° 俯角再把竖直压扁 0.62 倍，
 *   远看就是**一根尖锥** —— 和「兵」「后」完全分不开。
 *   经典 Staunton 的主教冠是上尖下胖的**水滴**，宽高比接近 1:1，
 *   压扁之后仍然是个胖三角，一眼就是主教冠。
 */
const BISHOP_MITRE: Array<[number, number]> = [
  [0.114, 0.325],
  [0.128, 0.37],
  [0.132, 0.425],
  [0.126, 0.48],
  [0.112, 0.535],
  [0.09, 0.59],
  [0.062, 0.638],
  [0.032, 0.672],
  [0, 0.688],
];

/** 在剖面上按高度线性插值取半径 */
function radiusAt(profile: Array<[number, number]>, y: number): number {
  if (y <= profile[0][1]) return profile[0][0];
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    if (y <= y1) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * t;
    }
  }
  return profile[profile.length - 1][0];
}

/**
 * 象：底座 + 领圈 + **胖水滴主教冠** + 斜裂口 + 顶珠。
 *
 * 裂口（象的灵魂）：旧版靠「顶点位移」在回转体上刻一道槽，
 *   槽壁只靠法线变化变暗 —— 在 52° 俯角 + 真实距离下几乎看不见，
 *   结果象还是跟「后」长得一样。
 *   现在改成**对比色斜条**（bishopSlitGeometry）：
 *   白棋是深色斜条、黑棋是亮色斜条，与 2D 的 detail 刻线同一套语言，
 *   在任何格色、任何距离上都读得出「这是一只象」。
 */
function bishopGeometry(): THREE.BufferGeometry {
  const r0 = BASE_RADIUS.b;
  const body = lathe(
    [
      ...plinthProfile(r0),
      [r0 * 0.58, 0.115],
      [0.09, 0.18],
      [0.08, 0.24],
      [0.104, 0.255], // 领圈
      [0.104, 0.285],
      [0.096, 0.3],
      ...BISHOP_MITRE,
    ],
    96,
  );

  const finial = new THREE.SphereGeometry(0.045, 24, 18);
  finial.translate(0, 0.72, 0);
  return mergeGeometries([body, finial]);
}

/**
 * 象的裂口：**贴着主教冠表面的一条斜带**。
 *
 * 用「剖面半径插值 + 角度」把一条带子弯在回转体上：
 *   - 下端 y=0.365、上端 y=0.605（对应 2D 里裂口的上下位置）；
 *   - 角度从 π/2 - 0.4 扫到 π/2 + 0.4 —— 于是是一条**斜着**的带子，
 *     和 2D 的「左上到右下」那道斜口一个方向；
 *   - 半宽固定 0.17 弧度，所以带宽随头部变窄而自然收细。
 *
 * 卡通风格的主教冠是另一套剖面，所以剖面和上下位置都做成参数。
 */
function bishopSlitGeometry(
  profile: Array<[number, number]> = BISHOP_MITRE,
  y0 = 0.355,
  y1 = 0.655,
  sweep = 0.95, // 整条斜带的角度跨度（弧度）
  half = 0.12, // 半宽（弧度）
): THREE.BufferGeometry {
  const N = 22;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = y0 + (y1 - y0) * t;
    const r = radiusAt(profile, y) + 0.002;
    const ang = Math.PI / 2 + sweep * (t - 0.5);
    for (const s of [-1, 1]) {
      const a = ang + s * half;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 后：底座 + 喇叭身 + 领圈 + 冠箍 + 六个尖 + 每尖一颗珠 */
function queenGeometry(): THREE.BufferGeometry {
  const r0 = BASE_RADIUS.q;
  const body = lathe([
    ...plinthProfile(r0),
    [r0 * 0.74, 0.115],
    [0.14, 0.19],
    [0.122, 0.28],
    [0.108, 0.37],
    [0.1, 0.44],
    [0.1, 0.49],
    [0.122, 0.505], // 领圈
    [0.122, 0.535],
    [0.098, 0.548],
    [0.096, 0.575],
    [0.128, 0.592], // 冠箍外扩
    [0.128, 0.64],
    [0.118, 0.652],
    [0, 0.658],
  ]);

  const parts: THREE.BufferGeometry[] = [body];
  const count = 6;
  const ring = 0.112;
  const coneH = 0.2;
  const coneR = 0.048;
  const tilt = 0.24; // 尖微微外撇
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    const cone = new THREE.ConeGeometry(coneR, coneH, 20);
    cone.translate(0, coneH / 2, 0);
    cone.rotateX(tilt);
    cone.rotateY(Math.PI / 2 - a);
    cone.translate(ring * Math.cos(a), 0.64, ring * Math.sin(a));
    parts.push(cone);

    // 冠珠：坐在尖顶上
    const tipR = ring + coneH * Math.sin(tilt);
    const tipY = 0.64 + coneH * Math.cos(tilt);
    const pearl = new THREE.SphereGeometry(0.036, 20, 14);
    pearl.translate(tipR * Math.cos(a), tipY, tipR * Math.sin(a));
    parts.push(pearl);
  }
  return mergeGeometries(parts);
}

/** 王：底座 + 身 + 领圈 + 冠碗 + 大十字 */
function kingGeometry(): THREE.BufferGeometry {
  const r0 = BASE_RADIUS.k;
  const body = lathe([
    ...plinthProfile(r0),
    [r0 * 0.76, 0.115],
    [0.146, 0.195],
    [0.13, 0.29],
    [0.118, 0.385],
    [0.112, 0.46],
    [0.112, 0.51],
    [0.134, 0.525], // 领圈
    [0.134, 0.555],
    [0.11, 0.568],
    [0.108, 0.6],
    [0.14, 0.62], // 冠碗
    [0.148, 0.665],
    [0.142, 0.71],
    [0.12, 0.745],
    [0.085, 0.765],
    [0.04, 0.775],
    [0, 0.78],
  ]);

  /**
   * 十字架：**一整块**挤出的十字（两块盒子相交会在交点留下接缝和描边毛刺）。
   *
   * 尺寸是按**对局视角**定的：在 52° 的俯角下，十字的横臂会被压扁，
   * 做得太小的结果就是「王顶上一个小疙瘩」—— 完全认不出是王。
   * 所以横臂要够宽（0.25）、竖臂要够高（露出冠顶 0.2）。
   */
  const crossShape = new THREE.Shape();
  const stemW = 0.05;
  const armW = 0.05;
  const armHalf = 0.14;
  const armLo = 0.092;
  const armHi = 0.092 + armW;
  const top = 0.255;
  crossShape.moveTo(-stemW, 0);
  crossShape.lineTo(stemW, 0);
  crossShape.lineTo(stemW, armLo);
  crossShape.lineTo(armHalf, armLo);
  crossShape.lineTo(armHalf, armHi);
  crossShape.lineTo(stemW, armHi);
  crossShape.lineTo(stemW, top);
  crossShape.lineTo(-stemW, top);
  crossShape.lineTo(-stemW, armHi);
  crossShape.lineTo(-armHalf, armHi);
  crossShape.lineTo(-armHalf, armLo);
  crossShape.lineTo(-stemW, armLo);
  crossShape.closePath();
  const cross = new THREE.ExtrudeGeometry(crossShape, {
    depth: 0.07,
    bevelEnabled: true,
    bevelThickness: 0.009,
    bevelSize: 0.009,
    bevelSegments: 2,
    curveSegments: 4,
  });
  cross.translate(0, 0.72, -0.04);
  cross.computeVertexNormals();

  const parts: THREE.BufferGeometry[] = [body, cross];
  return mergeGeometries(parts);
}

/**
 * 马：**复用 2D 的马侧影轮廓**（PieceGlyph.tsx 里 case 'n' 的同一组坐标），
 * 沿 z 挤成实体 —— 于是 2D 与 3D 的马是**同一个造型**，不会各画各的。
 *
 * 为什么不用「圆柱脖子 + 挤出头」那套：
 *   那样拼出来的马头是一块楔形板，远看像斧子，不认得出是马。
 *   真正的识别点是**侧脸的剪影**：额头、鼻子、嘴、下颌、耳朵，一样都不能少。
 *   2D 那条轮廓已经把这些都画对了（/pieces 页面肉眼可验），直接拿来挤最省事也最准。
 *
 * 挤出体保留倒角，于是马不是一张纸片，而是有厚度、有棱的「车出来的木雕」。
 *
 * ── 二次迭代（2026-11-11）──────────────────────────────
 * 旧版把「鬃毛」做成一块**往外凸**的挤出脊。后果：
 *   从背面看时，鬃毛正好挡在镜头前面，把马脸整个盖掉 —— 远看就是一把斧刃。
 *   （而黑白棋朝向规则又恰好让其中一色的马背对观众，于是实拍里真的出现了斧头。）
 * 现在：剪影只保留干净的**马侧脸**，鬃毛和眼睛改成
 *   **贴在侧面的对比色刻线**（knightDetailGeometry）——
 *   剪影不再被破坏，翻到哪一面都还是马。
 */

/** 2D 画布 → 3D 世界单位的换算（马专用）：整只马高 0.78，耳尖在画布 y=14 */
const KNIGHT_SCALE = 0.78 / 77;

/**
 * 取某种风格下马头的参数。
 *
 * 马是唯一一种**必须用侧影**才认得出的棋子，所以 3D 直接复用 2D 的那条轮廓
 * （而不是另捏一个回转体）。于是这里只有一件事要做：把画布坐标换算成世界坐标。
 *
 *   scale        画布 → 世界的比例
 *   pivotCanvasY 脖子根部在画布上的 y（决定马头绕哪儿后仰）
 *   depth        挤出厚度（卡通更厚实）
 *   bevel        倒角（卡通倒角大一点，边缘更圆润）
 */
function knightSpec(style: PieceStyle): {
  d: string;
  scale: number;
  pivotCanvasY: number;
  depth: number;
  bevel: number;
} {
  if (style === 'cartoon') {
    // 卡通马的画布高度是 80（耳尖 y=12，颈根 y=80），底座占 13 个画布单位
    return {
      d: bodyPathOf('n', 'cartoon'),
      scale: 0.142 / 13,
      pivotCanvasY: 80,
      depth: 0.2,
      bevel: 0.02,
    };
  }
  if (style === 'doodle') {
    // 涂鸦马的骨架就是经典的（只是线条歪了），所以沿用经典的换算
    return {
      d: bodyPathOf('n', 'doodle'),
      scale: KNIGHT_SCALE,
      pivotCanvasY: 78,
      depth: 0.16,
      bevel: 0.014,
    };
  }
  return {
    d: bodyPathOf('n', 'classic'),
    scale: KNIGHT_SCALE,
    pivotCanvasY: 78,
    depth: 0.16,
    bevel: 0.014,
  };
}

/**
 * 取某种风格下棋子的**主轮廓**（面积最大的那条本体路径）。
 *
 * 卡通与涂鸦的马身就是靠它挤出来的 ——
 * 2D 与 3D 因此是**同一条线**，不会一个像马、一个像斧头。
 */
function bodyPathOf(type: PieceType, style: PieceStyle): string {
  return pieceOutlinePath(type, style);
}

/** 把 SVG path 字符串变成 THREE.Shape（画布坐标） */
function shapeFromPath(d: string): THREE.Shape {
  const shape = new THREE.Shape();
  for (const c of parseSvgPath(d)) {
    switch (c.op) {
      case 'M':
        shape.moveTo(c.x, c.y);
        break;
      case 'L':
        shape.lineTo(c.x, c.y);
        break;
      case 'C':
        shape.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x, c.y);
        break;
      case 'Q':
        shape.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
        break;
      case 'Z':
        shape.closePath();
        break;
    }
  }
  return shape;
}

/**
 * 马头（挤出的侧脸）**向后仰**的角度（弧度，绕局部 x 轴）。
 *
 * ── 为什么必须仰 ──
 * 对局相机俯角约 52°（极角 38°），而马的侧脸是一块**竖直**的板：
 * 竖直平面被从上方 52° 看过去，轮廓沿竖直方向被压掉近四成
 * （平面的「张开度」= |视线方向 · 平面法线| = cos52° ≈ 0.62）。
 * 结果就是「马」被压成一张横着的卡片 —— 再叠加棋盘两侧各约 30° 的
 * 透视倾斜（棋盘 8.4 宽、相机只有 9.34 远，边缘棋子歪得厉害），
 * 靠边的马直接变成一块四边形板，彻底读不出来。
 *
 * 把头**向后仰 25°**，侧脸就转成「斜朝上」，张开度回到 0.89 ——
 * 剪影完整保留，而且这个仰角对黑白两色是对称的
 * （局部 +z 面永远正对当前观看方，见 Board3D 的 yaw 规则）。
 * 顺带的好处：后仰的马头朝对手方向看，和真实棋子摆法一致。
 */
const KNIGHT_HEAD_TILT = -0.44;

/** 仰角的支点：脖子根部（世界 y = 0.1418 = 2D 画布的 y=78） */
const KNIGHT_HEAD_PIVOT = 0.1418;

/** 马侧脸在**仰角之后**的法线（局部坐标）—— 朝上、朝 +z，正对当前观看方 */
export function knightFaceNormal(): THREE.Vector3 {
  return new THREE.Vector3(
    0,
    -Math.sin(KNIGHT_HEAD_TILT),
    Math.cos(KNIGHT_HEAD_TILT),
  ).normalize();
}

export { KNIGHT_HEAD_TILT, KNIGHT_HEAD_PIVOT };

/** 把马头绕脖子根部后仰 */
function tiltHeadBack(geo: THREE.BufferGeometry, pivot: number): THREE.BufferGeometry {
  geo.translate(0, -pivot, 0);
  geo.rotateX(KNIGHT_HEAD_TILT);
  geo.translate(0, pivot, 0);
  return geo;
}

/**
 * 把 SVG path 字符串变成 THREE.Shape，**并同时完成画布 → 世界的换算**。
 *
 * 换算：x' = (x - 50) · S，y' = (92 - y) · S
 *   （画布原点在左上、y 向下；世界原点在底座中心、y 向上）
 *
 * 与 shapeFromPath 的区别：那个函数原样保留画布坐标，
 * 换算交给后面的 scale/translate 做（细节贴片走那条路）。
 */
function shapeFromCanvasPath(d: string, S: number): THREE.Shape {
  const shape = new THREE.Shape();
  const px = (x: number): number => (x - 50) * S;
  const py = (y: number): number => (92 - y) * S;
  for (const c of parseSvgPath(d)) {
    switch (c.op) {
      case 'M':
        shape.moveTo(px(c.x), py(c.y));
        break;
      case 'L':
        shape.lineTo(px(c.x), py(c.y));
        break;
      case 'C':
        shape.bezierCurveTo(px(c.c1x), py(c.c1y), px(c.c2x), py(c.c2y), px(c.x), py(c.y));
        break;
      case 'Q':
        shape.quadraticCurveTo(px(c.cx), py(c.cy), px(c.x), py(c.y));
        break;
      case 'Z':
        shape.closePath();
        break;
    }
  }
  return shape;
}

/**
 * 把 UV 改成**平面投影**（按包围盒归一化）。
 *
 * 谁需要它：挤出来的马头。
 * ExtrudeGeometry 的 UV 是「顶面用形状坐标、侧壁用另一套」，
 * 数值是画布单位（十几到六十几），套上木纹贴图会重复上百次 —— 变成噪点。
 * 统一改成平面投影之后，木纹的疏密就和回转体棋子一致了。
 */
function planarUV(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return geo;
  const w = Math.max(1e-6, box.max.x - box.min.x);
  const h = Math.max(1e-6, box.max.y - box.min.y);
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    uv[i * 2] = (pos.getX(i) - box.min.x) / w;
    uv[i * 2 + 1] = (pos.getY(i) - box.min.y) / h;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * 马头（挤出的侧脸）—— 未仰角，调用方决定要不要仰。
 *
 * 轮廓**直接取 2D 的那条路径**（经典 / 卡通 / 涂鸦各取各的），
 * 于是同一个风格下 2D 与 3D 的马是同一条线。
 */
function knightHeadGeometry(style: PieceStyle): THREE.BufferGeometry {
  const spec = knightSpec(style);
  const S = spec.scale;

  const shape = shapeFromCanvasPath(spec.d, S);

  const head = new THREE.ExtrudeGeometry(shape, {
    // 薄一点、倒角小一点：厚板 + 大倒角会让侧脸糊成一坨，侧影就不像马了
    depth: spec.depth,
    bevelEnabled: true,
    bevelThickness: spec.bevel,
    bevelSize: spec.bevel,
    bevelSegments: 3,
    curveSegments: 16,
  });
  head.translate(0, 0, -spec.depth / 2);
  planarUV(head);
  head.computeVertexNormals();
  return head;
}

/** 马：底座 + 马头 */
function knightGeometry(style: PieceStyle): THREE.BufferGeometry {
  // 底座：两层台阶，顶面正好托住马身（世界 y = 0.1418 = 2D 的 78）
  const r0 = 0.1925;
  const base = lathe([
    [0, 0],
    [r0, 0],
    [r0, 0.028],
    [0.178, 0.048],
    [0.147, 0.067],
    [0.147, 0.1],
    [0.112, 0.142],
  ]);

  const spec = knightSpec(style);
  const pivot = (92 - spec.pivotCanvasY) * spec.scale;
  return mergeGeometries([base, tiltHeadBack(knightHeadGeometry(style), pivot)]);
}

/**
 * 马的细节件：**眼睛 + 鬃毛**，贴在马侧脸的 +z 面上。
 *
 * 直接取 2D 的 detail 图形（pieceDetailShapes('n', style)），
 * 于是 2D 的眼睛和鬃毛**和 3D 是同一条曲线**，两边不会走样。
 *
 * 位置：贴在挤出体的最外端（z = 侧脸平面），并凸出 0.0025 避免和本体 z-fighting。
 * 然后**跟着马头一起后仰** —— 否则贴片会从仰起的侧脸上脱开。
 */
function knightDetailGeometry(style: PieceStyle): THREE.BufferGeometry {
  const spec = knightSpec(style);
  const parts: THREE.BufferGeometry[] = [];
  for (const shape of pieceDetailShapes('n', style)) {
    if (shape.kind === 'path') {
      parts.push(new THREE.ShapeGeometry(shapeFromPath(shape.d), 16));
    } else if (shape.kind === 'circle') {
      const g = new THREE.CircleGeometry(shape.r, 24);
      g.translate(shape.cx, shape.cy, 0);
      parts.push(g);
    }
  }
  const merged = mergeGeometries(parts);

  // 画布坐标 → 世界坐标（和 knightHeadGeometry 用同一套换算）
  merged.scale(spec.scale, -spec.scale, 1);
  merged.translate(-50 * spec.scale, 92 * spec.scale, 0);

  // 贴到 +z 侧面（局部 +z 面永远正对当前观看方，见 Board3D 的 yaw 规则）
  const head = knightHeadGeometry(style);
  head.computeBoundingBox();
  const faceZ = head.boundingBox ? head.boundingBox.max.z : 0.094;
  merged.translate(0, 0, faceZ + 0.0025);
  // 与马头同步后仰（贴片先贴平、再一起转，位置才对得上）
  tiltHeadBack(merged, (92 - spec.pivotCanvasY) * spec.scale);
  merged.computeVertexNormals();
  return merged;
}

/* ------------------------------------------------------------------ */
/* 卡通：圆胖团子 + 大眼睛                                            */
/* ------------------------------------------------------------------ */

/**
 * 卡通的主教冠剖面（半径, 高度）。
 *
 * 比经典的**更胖**：卡通的一切特征件都要「大一号」才看得出是玩具而不是真棋子。
 */
const CARTOON_MITRE: Array<[number, number]> = [
  [0.1, 0.415],
  [0.12, 0.46],
  [0.128, 0.52],
  [0.122, 0.57],
  [0.1, 0.615],
  [0.07, 0.65],
  [0.035, 0.675],
  [0, 0.685],
];

/** 卡通兵：宽底座 + 矮胖身子 + 大球头 */
function cartoonPawnGeometry(): THREE.BufferGeometry {
  const body = lathe([
    ...plinthProfile(0.2),
    [0.16, 0.062],
    [0.152, 0.13],
    [0.138, 0.21],
    [0.118, 0.29],
    [0.1, 0.35],
    [0.108, 0.37], // 领圈（比杆身宽出一圈）
    [0.108, 0.395],
    [0.075, 0.41],
    [0.05, 0.415],
    [0.045, 0.45],
    [0, 0.458],
  ]);
  const head = new THREE.SphereGeometry(0.128, 32, 24);
  head.translate(0, 0.545, 0);
  return mergeGeometries([body, head]);
}

/** 卡通车：矮胖塔身 + 三个大城垛 */
function cartoonRookGeometry(): THREE.BufferGeometry {
  const body = lathe([
    ...plinthProfile(0.21),
    [0.155, 0.062],
    [0.15, 0.16],
    [0.145, 0.3],
    [0.15, 0.42],
    [0.165, 0.47],
    [0.165, 0.5],
    [0.15, 0.512],
    [0, 0.515],
  ]);
  const parts: THREE.BufferGeometry[] = [body];
  const count = 3;
  const ring = 0.108;
  const merlonW = 0.105;
  const merlonH = 0.135;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + Math.PI / 6;
    const g = new THREE.BoxGeometry(merlonW, merlonH, merlonW);
    g.translate(0, merlonH / 2, 0);
    g.rotateY(-a);
    g.translate(ring * Math.cos(a), 0.515, ring * Math.sin(a));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/** 卡通象：胖蛋冠 + 顶珠 */
function cartoonBishopGeometry(): THREE.BufferGeometry {
  const body = lathe([
    ...plinthProfile(0.205),
    [0.16, 0.062],
    [0.15, 0.14],
    [0.135, 0.22],
    [0.12, 0.3],
    [0.11, 0.36],
    [0.118, 0.375],
    [0.118, 0.4],
    [0.09, 0.415],
    ...CARTOON_MITRE,
  ]);
  const finial = new THREE.SphereGeometry(0.048, 24, 18);
  finial.translate(0, 0.712, 0);
  return mergeGeometries([body, finial]);
}

/** 卡通后：矮胖身子 + 三个大尖的皇冠 */
function cartoonQueenGeometry(): THREE.BufferGeometry {
  const body = lathe([
    ...plinthProfile(0.215),
    [0.165, 0.062],
    [0.155, 0.14],
    [0.14, 0.23],
    [0.125, 0.31],
    [0.115, 0.37],
    [0.125, 0.385],
    [0.125, 0.41],
    [0.095, 0.425],
    [0.1, 0.425],
    [0.145, 0.45],
    [0.145, 0.49],
    [0.1, 0.505],
    [0, 0.51],
  ]);
  const parts: THREE.BufferGeometry[] = [body];
  const count = 3;
  const ring = 0.1;
  const coneH = 0.17;
  const coneR = 0.055;
  const tilt = 0.2;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + Math.PI / 6;
    const cone = new THREE.ConeGeometry(coneR, coneH, 20);
    cone.translate(0, coneH / 2, 0);
    cone.rotateX(tilt);
    cone.rotateY(Math.PI / 2 - a);
    cone.translate(ring * Math.cos(a), 0.505, ring * Math.sin(a));
    parts.push(cone);

    const tipR = ring + coneH * Math.sin(tilt);
    const tipY = 0.505 + coneH * Math.cos(tilt);
    const pearl = new THREE.SphereGeometry(0.042, 20, 14);
    pearl.translate(tipR * Math.cos(a), tipY, tipR * Math.sin(a));
    parts.push(pearl);
  }
  return mergeGeometries(parts);
}

/** 卡通王：圆脑袋 + 宽十字 */
function cartoonKingGeometry(): THREE.BufferGeometry {
  const body = lathe([
    ...plinthProfile(0.215),
    [0.165, 0.062],
    [0.155, 0.14],
    [0.14, 0.23],
    [0.125, 0.31],
    [0.115, 0.37],
    [0.125, 0.385],
    [0.125, 0.41],
    [0.095, 0.425],
    [0.1, 0.425],
    [0.13, 0.45],
    [0.13, 0.5],
    [0, 0.51],
  ]);
  const head = new THREE.SphereGeometry(0.135, 32, 24);
  head.translate(0, 0.55, 0);

  const crossShape = new THREE.Shape();
  const stemW = 0.058;
  const armW = 0.058;
  const armHalf = 0.155;
  const armLo = 0.1;
  const armHi = 0.1 + armW;
  const top = 0.28;
  crossShape.moveTo(-stemW, 0);
  crossShape.lineTo(stemW, 0);
  crossShape.lineTo(stemW, armLo);
  crossShape.lineTo(armHalf, armLo);
  crossShape.lineTo(armHalf, armHi);
  crossShape.lineTo(stemW, armHi);
  crossShape.lineTo(stemW, top);
  crossShape.lineTo(-stemW, top);
  crossShape.lineTo(-stemW, armHi);
  crossShape.lineTo(-armHalf, armHi);
  crossShape.lineTo(-armHalf, armLo);
  crossShape.lineTo(-stemW, armLo);
  crossShape.closePath();
  const cross = new THREE.ExtrudeGeometry(crossShape, {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 4,
  });
  cross.translate(0, 0.63, -0.045);
  cross.computeVertexNormals();

  return mergeGeometries([body, head, cross]);
}

/** 卡通的一套几何 */
function cartoonGeometry(type: PieceType): THREE.BufferGeometry {
  switch (type) {
    case 'p':
      return cartoonPawnGeometry();
    case 'r':
      return cartoonRookGeometry();
    case 'b':
      return cartoonBishopGeometry();
    case 'q':
      return cartoonQueenGeometry();
    case 'k':
      return cartoonKingGeometry();
    case 'n':
      return knightGeometry('cartoon');
    default:
      return lathe(plinthProfile(0.2));
  }
}

/* ------------------------------------------------------------------ */
/* 像素：把 2D 的位图精灵挤成体素                                      */
/* ------------------------------------------------------------------ */

/**
 * 像素棋子 —— **同一张位图**在 3D 里变成体素。
 *
 * 做法：位图逐行扫描，每一行里**颜色相同的连续格**合并成一个长条盒子。
 * 于是「一格 = 一个体素」，但顶点数只有几十个（逐格一个盒子的话一枚棋子要几百个）。
 *
 * 高度按经典版的目标高度归一（PIECE_HEIGHT），
 * 所以换风格不会让棋子忽大忽小，取景模型也不用改。
 */
export interface PixelGeometries {
  /** 本体格 */
  body: THREE.BufferGeometry | null;
  /** 描边格 / 刻线格 */
  accent: THREE.BufferGeometry | null;
  /** 高光格 */
  gloss: THREE.BufferGeometry | null;
  /** 三块合起来（给轮廓壳用） */
  all: THREE.BufferGeometry | null;
}

function pixelGeometries(type: PieceType): PixelGeometries {
  const grid = pixelGrid(type);
  const cellCanvas = 100 / grid.size;

  let minRow = grid.size;
  let maxRow = -1;
  let minCol = grid.size;
  let maxCol = -1;
  for (let r = 0; r < grid.size; r += 1) {
    for (let c = 0; c < grid.size; c += 1) {
      if (grid.cells[r * grid.size + c] === PixelCell.Empty) continue;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
  }
  if (maxRow < 0) {
    return { body: null, accent: null, gloss: null, all: null };
  }

  const rows = maxRow - minRow + 1;
  const cols = maxCol - minCol + 1;
  const scale = PIECE_HEIGHT[type] / (rows * cellCanvas);
  const cellW = cellCanvas * scale;
  /*
   * 深度 = **一格多一点**，不是「整枚棋子宽度的一半」。
   *
   * 为什么：像素几何是**一行一个盒子**堆起来的 —— 上面一行比下面窄的地方，
   * 会露出下面那行的**顶面**。顶面从 38° 俯角看过去，投影高度 ≈ 深度 × sin38°。
   * 深度要是 5.5 格，露出来的顶面就有一整行那么高 → 剪影被压成一堆阶梯楔块，
   * 根本不像棋子（实测截图确认过）。
   *
   * 压到一格多之后：顶面只剩细细一条，正好当成 2D 里那条深色描边 ——
   * 于是 3D 的像素棋子 = 「2D 的像素图 + 一圈深色阶梯边」，两个视角是同一套语言。
   */
  const depth = cellW * 1.25;

  const bodyParts: THREE.BufferGeometry[] = [];
  const accentParts: THREE.BufferGeometry[] = [];
  const glossParts: THREE.BufferGeometry[] = [];

  for (let row = maxRow; row >= minRow; row -= 1) {
    const level = maxRow - row;
    let c = minCol;
    while (c <= maxCol) {
      const v = grid.cells[row * grid.size + c];
      if (v === PixelCell.Empty) {
        c += 1;
        continue;
      }
      let c2 = c;
      while (c2 + 1 <= maxCol && grid.cells[row * grid.size + c2 + 1] === v) c2 += 1;
      const w = (c2 - c + 1) * cellW;
      const xCenter = (((c + c2 + 1) / 2) * cellCanvas - 50) * scale;
      const box = new THREE.BoxGeometry(w, cellW, depth);
      box.translate(xCenter, level * cellW + cellW / 2, 0);
      if (v === PixelCell.Outline || v === PixelCell.Detail) accentParts.push(box);
      else if (v === PixelCell.Highlight) glossParts.push(box);
      else bodyParts.push(box);
      c = c2 + 1;
    }
  }

  const build = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null =>
    parts.length ? mergeGeometries(parts) : null;

  const body = build(bodyParts);
  const accent = build(accentParts);
  const gloss = build(glossParts);
  const all = build([...bodyParts, ...accentParts, ...glossParts]);

  return { body, accent, gloss, all };
}

/** 像素几何的缓存（按棋子类型） */
const pixelGeometryCache = new Map<PieceType, PixelGeometries>();

/** 取某种棋子的像素几何（本体 / 描边 / 高光，三件） */
export function piecePixelGeometries(type: PieceType): PixelGeometries {
  const cached = pixelGeometryCache.get(type);
  if (cached) return cached;
  const built = pixelGeometries(type);
  pixelGeometryCache.set(type, built);
  return built;
}

/* ------------------------------------------------------------------ */
/* 涂鸦：顶点抖动                                                      */
/* ------------------------------------------------------------------ */

/** 位置的确定性噪声（同一个位置永远同一个值 → 相邻部件不会裂开） */
function posNoise(seed: number, x: number, y: number, z: number): number {
  const k = Math.sin(seed * 12.9898 + x * 78.233 + y * 37.719 + z * 19.913) * 43758.5453;
  return (k - Math.floor(k)) * 2 - 1;
}

/**
 * 把几何体的每个顶点按**位置**抖一点 —— 手捏出来的感觉。
 *
 * 关键：抖动的输入是**坐标**（量化到 0.01），不是顶点序号。
 *   按序号抖 → 相邻两个部件的接缝会裂开（序号不同 → 抖动不同）；
 *   按坐标抖 → 同一个空间位置永远抖一样的量 → 接缝不动。
 */
function jitterGeometry(geo: THREE.BufferGeometry, seed: number, amp: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const qx = Math.round(x * 100) / 100;
    const qy = Math.round(y * 100) / 100;
    const qz = Math.round(z * 100) / 100;
    pos.setXYZ(
      i,
      x + posNoise(seed, qx, qy, qz) * amp,
      y + posNoise(seed + 11, qx, qy, qz) * amp,
      z + posNoise(seed + 23, qx, qy, qz) * amp,
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* 合并 / 缓存                                                          */
/* ------------------------------------------------------------------ */

/** 合并多个几何体（避免依赖 BufferGeometryUtils 的导入路径差异） */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const geo of list) {
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < pos.count; i += 1) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
    }
    const index = geo.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + vertexOffset);
    } else {
      for (let i = 0; i < pos.count; i += 1) indices.push(i + vertexOffset);
    }
    vertexOffset += pos.count;
    geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  }
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices);
  return merged;
}

/** 经典几何（每次新建 —— 涂鸦要拿到一份**未被抖动过**的原始几何） */
function classicGeometry(type: PieceType): THREE.BufferGeometry {
  switch (type) {
    case 'p':
      return pawnGeometry();
    case 'r':
      return rookGeometry();
    case 'b':
      return bishopGeometry();
    case 'q':
      return queenGeometry();
    case 'k':
      return kingGeometry();
    case 'n':
      return knightGeometry('classic');
    default:
      return lathe(plinthProfile(BASE_RADIUS.p));
  }
}

/** 缓存生成的几何体，避免每次渲染重建 */
const geometryCache = new Map<string, THREE.BufferGeometry>();

/**
 * 整枚棋子的几何体（底座 + 躯干 + 特征件，已合并成一个 mesh）。
 *
 * 合并成一件的好处：轮廓描边（inverted hull）也能一次覆盖所有特征件，
 * 不会出现「十字没有描边、身子有描边」的割裂感。
 *
 * 像素风格是**例外**：它的本体 / 描边 / 高光是三块独立的网格
 * （颜色不同），本体件用 `piecePixelGeometries()` 取。
 */
export function pieceGeometry(type: PieceType, style: PieceStyle = 'classic'): THREE.BufferGeometry {
  const key = `piece-${type}-${style}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;
  let geo: THREE.BufferGeometry;
  switch (style) {
    case 'cartoon':
      geo = cartoonGeometry(type);
      break;
    case 'pixel': {
      const px = piecePixelGeometries(type);
      geo = px.all ?? lathe(plinthProfile(BASE_RADIUS.p));
      break;
    }
    case 'doodle':
      // 骨架同经典，但每个顶点按位置抖一点 —— 手捏出来的感觉
      geo = jitterGeometry(classicGeometry(type), type.charCodeAt(0) * 13 + 5, 0.007);
      /*
       * 抖完再**压扁 1.5%**。
       *
       * 为什么必须压：经典的王本来就顶到 0.984（取景上限 0.99），
       * 抖动再往上顶一点就越界了 —— 棋子会被画布上沿裁掉。
       * 压 1.5% 在视觉上完全看不出来，但能给抖动留出余量。
       */
      geo.scale(1, 0.985, 1);
      break;
    case 'classic':
    default:
      geo = classicGeometry(type);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geometryCache.set(key, geo);
  return geo;
}

/** 棋子实际高度（含特征件）—— 取景与测试用 */
export function pieceHeight(type: PieceType, style: PieceStyle = 'classic'): number {
  const box = pieceGeometry(type, style).boundingBox;
  return box ? box.max.y : PIECE_HEIGHT[type];
}

/* ------------------------------------------------------------------ */
/* 细节件（对比色刻线）                                                */
/* ------------------------------------------------------------------ */

/**
 * 细节件几何 —— 「刻线 / 凹槽」一类的小特征。
 *
 * 与 2D 的 `tone: 'detail'` 是**同一套语言**：
 *   马 —— 眼睛 + 鬃毛（贴在侧脸 +z 面上）
 *   象 —— 主教冠上的斜裂口
 *
 * 为什么要单独一层：
 *   这类特征如果只用「同色凹凸」来做，靠的全是法线变化 ——
 *   在 52° 俯角、真实距离、光照还不均匀时几乎看不见（象的裂口就是这么丢的）。
 *   改成**对比色**（白棋深色 / 黑棋浅色，与 2D 的 PALETTE 完全一致）之后，
 *   无论落在浅格还是深格、哪个角度，都一眼读得出。
 *
 * 返回 null 表示这种棋子没有需要「刻线才能认出来」的特征。
 *
 * 像素风格例外：刻线已经**烤进位图**里了（深色格子），不需要额外的网格。
 */
export function pieceDetailGeometry(
  type: PieceType,
  style: PieceStyle = 'classic',
): THREE.BufferGeometry | null {
  if (style === 'pixel') return null;
  switch (type) {
    case 'n':
      return knightDetailGeometry(style);
    case 'b':
      return style === 'cartoon'
        ? bishopSlitGeometry(CARTOON_MITRE, 0.44, 0.65, 0.85, 0.13)
        : bishopSlitGeometry();
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* 材质                                                                */
/* ------------------------------------------------------------------ */

/**
 * 木纹贴图（3D 用）。
 *
 * 贴图是**亮度调制**（接近白色的底 + 深浅年轮），
 * 所以同一张贴图既能配枫木、也能配乌木 —— 颜色由材质的 color 决定。
 *
 * 为什么不用 TextureLoader：load 是异步的，棋子第一帧会没有贴图（闪一下）。
 * CanvasTexture 是同步的，建好就能用。
 */
let pieceWoodTexture: THREE.Texture | null = null;

function getPieceWoodTexture(): THREE.Texture | null {
  // 测试环境（vitest node）没有 document —— 没有贴图也照样能跑
  if (typeof document === 'undefined') return null;
  if (pieceWoodTexture) return pieceWoodTexture;
  const canvas = generateWoodCanvas({
    base: [255, 250, 240],
    contrast: 0.2,
    seed: 20241112,
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  pieceWoodTexture = tex;
  return tex;
}

/** 材质配方（三种材质的差异全写在这里） */
interface MaterialRecipe {
  roughness: number;
  metalness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  envMapIntensity: number;
  map?: THREE.Texture | null;
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * 三种材质的物理配方。
 *
 *   木质 —— 粗糙度 0.78、无金属感、叠木纹贴图：哑光、暖、不反光
 *   金属 —— 金属度 0.92、粗糙度 0.24：**必须有环境贴图**，否则金属只剩黑
 *   塑料 —— 金属度 0、清漆 0.65：底色饱和、高光是软的
 */
function materialRecipe(
  material: PieceMaterial,
  color: 'w' | 'b',
  style: PieceStyle,
  env: THREE.Texture | null,
): MaterialRecipe {
  const flat = style === 'doodle';
  switch (material) {
    case 'metal':
      return {
        roughness: 0.24,
        metalness: 0.92,
        envMapIntensity: 1.15,
        flatShading: flat,
      } as MaterialRecipe;
    case 'plastic':
      return {
        roughness: 0.32,
        metalness: 0.0,
        clearcoat: 0.65,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.55,
        // 深色塑料在背光面容易死黑，抬一点点底
        emissive: color === 'b' ? '#141824' : undefined,
        emissiveIntensity: color === 'b' ? 0.35 : 0,
        flatShading: flat,
      } as MaterialRecipe;
    case 'wood':
    default:
      return {
        roughness: 0.78,
        metalness: 0.02,
        envMapIntensity: 0.25,
        map: getPieceWoodTexture(),
        emissive: color === 'b' ? '#1a120b' : undefined,
        emissiveIntensity: color === 'b' ? 0.3 : 0,
        flatShading: flat,
      } as MaterialRecipe;
  }
}

/**
 * 棋子材质。
 *
 * 颜色与 2D 共用 piece-appearance 的调色板，保证两个视角的棋子长得一样。
 *
 * 黑棋之前是「近黑 + 高金属度 + 低粗糙度 + 强自发光」→
 * 镜面反射为主、漫反射被压掉，背光面死黑，落在深色格上完全看不出是什么子。
 * 现在改成：石墨色 + 低金属度 + **几乎不要自发光**（只留一点点抬暗部），
 * 让方向光在球头/城垛/冠珠上打出**高光**—— 高光才是「这是个球 / 这是颗珠」的证据。
 *
 * @param color    白 / 黑
 * @param material 木质 / 金属 / 塑料
 * @param style    风格（涂鸦用平面着色，像手捏的）
 * @param env      环境贴图（**金属必须有**，否则金属渲染出来是黑的）
 */
export function pieceMaterial(
  color: 'w' | 'b',
  material: PieceMaterial = 'wood',
  style: PieceStyle = 'classic',
  env: THREE.Texture | null = null,
): THREE.Material {
  const palette = piecePalette(material, color);
  const recipe = materialRecipe(material, color, style, env);
  if (material === 'metal') {
    return new THREE.MeshStandardMaterial({
      color: palette.fill,
      roughness: recipe.roughness,
      metalness: recipe.metalness,
      envMap: env,
      envMapIntensity: recipe.envMapIntensity,
      flatShading: style === 'doodle',
    });
  }
  if (material === 'plastic') {
    return new THREE.MeshPhysicalMaterial({
      color: palette.fill,
      roughness: recipe.roughness,
      metalness: recipe.metalness,
      clearcoat: recipe.clearcoat ?? 0,
      clearcoatRoughness: recipe.clearcoatRoughness ?? 0,
      envMap: env,
      envMapIntensity: recipe.envMapIntensity,
      emissive: recipe.emissive ? new THREE.Color(recipe.emissive) : new THREE.Color('#000000'),
      emissiveIntensity: recipe.emissiveIntensity ?? 0,
      flatShading: style === 'doodle',
    });
  }
  return new THREE.MeshStandardMaterial({
    color: palette.fill,
    roughness: recipe.roughness,
    metalness: recipe.metalness,
    map: recipe.map ?? null,
    envMap: env,
    envMapIntensity: recipe.envMapIntensity,
    emissive: recipe.emissive ? new THREE.Color(recipe.emissive) : new THREE.Color('#000000'),
    emissiveIntensity: recipe.emissiveIntensity ?? 0,
    flatShading: style === 'doodle',
  });
}

/**
 * 像素风格的**描边格**材质 —— 颜色是描边色，物理参数跟本体一致。
 *
 * 为什么单独一个材质：位图里的描边格、刻线格颜色都和本体不同，
 * 合成一件就没法上两种颜色了。物理参数必须一致，
 * 否则「金属棋子」会出现一圈不金属的黑边（看着像贴纸）。
 */
export function pieceAccentMaterial(
  color: 'w' | 'b',
  material: PieceMaterial = 'wood',
  style: PieceStyle = 'classic',
  env: THREE.Texture | null = null,
): THREE.Material {
  const palette = piecePalette(material, color);
  const recipe = materialRecipe(material, color, style, env);
  return new THREE.MeshStandardMaterial({
    color: palette.stroke,
    roughness: recipe.roughness,
    metalness: recipe.metalness,
    map: recipe.map ?? null,
    envMap: env,
    envMapIntensity: recipe.envMapIntensity,
    flatShading: style === 'doodle',
  });
}

/** 像素风格的**高光格**材质 */
export function pieceGlossMaterial(
  color: 'w' | 'b',
  material: PieceMaterial = 'wood',
  style: PieceStyle = 'classic',
  env: THREE.Texture | null = null,
): THREE.Material {
  const palette = piecePalette(material, color);
  const recipe = materialRecipe(material, color, style, env);
  return new THREE.MeshStandardMaterial({
    color: palette.highlight,
    roughness: Math.max(0.15, recipe.roughness - 0.15),
    metalness: recipe.metalness,
    envMap: env,
    envMapIntensity: recipe.envMapIntensity * 1.2,
    flatShading: style === 'doodle',
  });
}

/**
 * 细节件材质 —— 对比色（白棋深色 / 黑棋浅色）。
 *
 * 取的就是调色板的 stroke 色 —— 也就是 2D 里 detail 刻线用的那个颜色，
 * 于是 2D 和 3D 的「刻线」在颜色上完全一致。
 *
 * 加一点自发光：刻线很细，背光面不吃光就会彻底消失；
 * 0.25 的自发光让它在阴影里也留得住，又不会变成「贴纸」。
 */
export function detailMaterial(color: 'w' | 'b', material: PieceMaterial = 'wood'): THREE.MeshStandardMaterial {
  const palette = piecePalette(material, color);
  const hex = palette.stroke;
  return new THREE.MeshStandardMaterial({
    color: hex,
    roughness: 0.55,
    metalness: 0,
    emissive: new THREE.Color(hex),
    emissiveIntensity: 0.25,
    // 侧脸贴片翻转过（画布 y 轴向下），法线方向不保证一致 —— 双面最省心
    side: THREE.DoubleSide,
  });
}

/**
 * 轮廓壳材质 —— 棋子外缘的一圈描边。
 *
 * 做法（inverted hull）：沿顶点法线把几何体向外推一点点，只渲染**背面**，
 * 于是棋子轮廓外侧多出一圈同色描边。描边粗细按**世界单位**算，
 * 不会因为棋子大小不同而忽粗忽细。
 *
 * 描边颜色取自调色板的 stroke（白棋深边、黑棋浅边），与 2D 完全一致。
 */
export function outlineMaterial(color: string, width = 0.014): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       transformed += normalize( normal ) * ${width.toFixed(4)};`,
    );
  };
  return mat;
}

/**
 * 卡通风格的**眼睛**几何（眼白 + 瞳孔分开两件）。
 *
 * 卡通的识别特征就靠这对眼睛，所以它必须**独立于本体材质**：
 * 眼睛不能是「木头眼睛」或「金属眼睛」。
 */
export function pieceFaceGeometries(
  type: PieceType,
): { white: THREE.BufferGeometry | null; pupil: THREE.BufferGeometry | null } {
  const spec = CARTOON_EYES[type];
  if (!spec) return { white: null, pupil: null };
  const whiteParts: THREE.BufferGeometry[] = [];
  const pupilParts: THREE.BufferGeometry[] = [];
  for (const e of spec) {
    const w = new THREE.SphereGeometry(e.r, 18, 14);
    w.translate(e.x, e.y, e.z);
    whiteParts.push(w);
    const p = new THREE.SphereGeometry(e.r * 0.52, 14, 10);
    p.translate(e.x + e.r * 0.1, e.y - e.r * 0.06, e.z + e.r * 0.62);
    pupilParts.push(p);
  }
  return {
    white: whiteParts.length ? mergeGeometries(whiteParts) : null,
    pupil: pupilParts.length ? mergeGeometries(pupilParts) : null,
  };
}

/** 卡通眼睛的位置（世界坐标）—— 每种棋子把眼睛放在自己的「脸」上 */
const CARTOON_EYES: Partial<
  Record<PieceType, Array<{ x: number; y: number; z: number; r: number }>>
> = {
  // 兵：大球头正面
  p: [
    { x: -0.048, y: 0.555, z: 0.108, r: 0.036 },
    { x: 0.048, y: 0.555, z: 0.108, r: 0.036 },
  ],
  // 车：塔身正面
  r: [
    { x: -0.05, y: 0.25, z: 0.135, r: 0.034 },
    { x: 0.05, y: 0.25, z: 0.135, r: 0.034 },
  ],
  // 象：身子正面
  b: [
    { x: -0.05, y: 0.21, z: 0.12, r: 0.034 },
    { x: 0.05, y: 0.21, z: 0.12, r: 0.034 },
  ],
  // 后：身子正面
  q: [
    { x: -0.05, y: 0.22, z: 0.12, r: 0.034 },
    { x: 0.05, y: 0.22, z: 0.12, r: 0.034 },
  ],
  // 王：圆脑袋正面
  k: [
    { x: -0.048, y: 0.555, z: 0.112, r: 0.036 },
    { x: 0.048, y: 0.555, z: 0.112, r: 0.036 },
  ],
};

/** 把格名转成棋盘上的世界坐标（a8 在左后，标准国际象棋坐标） */
export function squareToWorld(square: string): { x: number; z: number } {
  const file = square.charCodeAt(0) - 97; // a=0
  const rank = Number(square[1]); // 1..8
  return {
    x: file - 3.5,
    /**
     * rank 8 在 z = -3.5（远端），rank 1 在 z = +3.5（近端）。
     *
     * 这里的常数必须是 **4.5**：`4.5 - rank` 才能让 rank 1..8 落在 ±3.5，
     * 也就是 8 个格子以棋盘中心对称（和 x 的 `file - 3.5` 一致）。
     * 写成 `3.5 - rank` 会让整个棋盘朝 -z 偏一格：
     * rank 8 落到 z=-4.5、跑到边框（±4.2）外面，
     * 近端一排棋子会「悬在棋盘外」并被画布下沿切掉。
     */
    z: 4.5 - rank,
  };
}
