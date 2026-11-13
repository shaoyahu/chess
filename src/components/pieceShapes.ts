'use client';

/**
 * 棋子的**造型**层 —— 风格改形状，材质改表面（材质在 PieceGlyph 里渲染）。
 *
 * 四种风格各自的语言：
 *
 *   classic 经典 —— Staunton 的写实比例：底座 / 领圈 / 收腰 / 特征件，层层收上去。
 *   cartoon 卡通 —— 圆胖「团子」：宽扁的托盘底座 + 矮胖的身子 + **大脑袋**，
 *                  再加一对大眼睛和腮红（这对眼睛是「卡通」两个字的全部答案）。
 *   pixel   像素 —— **位图精灵**，硬边、三色调。位图**不是**从 classic 降采样来的，
 *                  而是像素风有**自己的造型语言**（见 pixelShapes.ts）——
 *                  因为降采样会把象的顶珠、后的冠尖、王的十字全磨没，六子会撞成一样。
 *   doodle  涂鸦 —— 同样一副骨架，但每条线都被**抖歪**了（见 wobblePath），
 *                  配双描边和排线填充，像马克笔随手画的。
 *
 * 真源关系：
 *   2D 直接把这里的 `d` 交给 SVG；
 *   3D 通过 pieceGeometry.ts 拿同一批数据（马的侧脸、象的裂口）；
 *   像素版再往下派生一体素模型 —— 一张位图，三处用（2D 精灵 / 3D 体素 / 素材文件）。
 */

import { parseSvgPath } from '@/lib/svg-path';
import { pixelGrid } from './pixelShapes';
import type { PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

/** 画布坐标约定：viewBox 0 0 100 100，底座落在 y=92，中心线 x=50 */
export const BASE_Y = 92;

/**
 * 色调 —— 决定这块图形用**哪套颜色**画。
 *
 *   body   棋子本体：本体色填充 + 描边色描边
 *   detail 刻线 / 凹槽：直接用描边色填充（白棋深槽、黑棋亮槽）
 *   eye    眼白：固定白色（卡通 / 涂鸦的眼睛，两色棋子都一样）
 *   pupil  瞳孔：固定深色
 *   blush  腮红：固定淡红
 */
export type Tone = 'body' | 'detail' | 'eye' | 'pupil' | 'blush';

/**
 * 几何图元。
 *
 * 2D 直接把 `d` 交给 SVG 渲染；3D 则通过 `pieceDetailShapes()` 拿同一批数据
 * —— **同一份真源，2D/3D 不会各画各的**。
 */
export type PieceShape =
  | { kind: 'path'; d: string; tone?: Tone }
  | { kind: 'circle'; cx: number; cy: number; r: number; tone?: Tone }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; tone?: Tone };

type Shape = PieceShape;

/* ------------------------------------------------------------------ */
/* 经典（Staunton 比例）                                               */
/* ------------------------------------------------------------------ */

/**
 * 底座：两层台阶（宽脚 + 窄腰），六个棋子共用，保证整体风格统一。
 * hw 表示底座半宽。
 */
function plinth(hw: number): Shape[] {
  return [
    // 下层（宽脚，带一点圆角）
    {
      kind: 'path',
      d: `M${50 - hw} ${BASE_Y} C${50 - hw} ${BASE_Y - 3} ${50 - hw + 1} ${BASE_Y - 6} ${
        50 - hw + 5
      } ${BASE_Y - 6.6} L${50 + hw - 5} ${BASE_Y - 6.6} C${50 + hw - 1} ${BASE_Y - 6} ${50 + hw} ${
        BASE_Y - 3
      } ${50 + hw} ${BASE_Y} Z`,
    },
    // 上层（窄腰）
    {
      kind: 'path',
      d: `M${50 - hw + 4} ${BASE_Y - 6.6} L${50 - hw + 8} ${BASE_Y - 14} L${50 + hw - 8} ${
        BASE_Y - 14
      } L${50 + hw - 4} ${BASE_Y - 6.6} Z`,
    },
  ];
}

/** 领圈（椭圆） */
function collar(cy: number, rx: number): Shape {
  return { kind: 'ellipse', cx: 50, cy, rx, ry: rx * 0.3 };
}

/** 经典造型的各棋子几何构成 */
function buildClassicShapes(type: PieceType): Shape[] {
  switch (type) {
    case 'p': {
      // 兵：底座 + 收腰柱 + 领圈 + 颈 + 大球头
      return [
        ...plinth(17),
        { kind: 'path', d: 'M40 78 C40 68 42 60 45 53 L55 53 C58 60 60 68 60 78 Z' },
        collar(53, 9),
        { kind: 'path', d: 'M46.5 53 L46.5 45 L53.5 45 L53.5 53 Z' },
        { kind: 'circle', cx: 50, cy: 38.5, r: 8.5 },
      ];
    }

    case 'r': {
      // 车：底座 + 塔身 + 腰箍 + 城垛冠（4 个城垛，缝要够宽，小图才读得出）
      const merlons: Shape[] = [];
      const top = 18;
      const bandTop = 30;
      const width = 5.5;
      const gap = 3;
      let x = 34.5;
      for (let i = 0; i < 4; i += 1) {
        merlons.push({
          kind: 'path',
          d: `M${x} ${bandTop} L${x} ${top} L${x + width} ${top} L${x + width} ${bandTop} Z`,
        });
        x += width + gap;
      }
      return [
        ...plinth(19),
        // 塔身（上窄下宽）
        { kind: 'path', d: 'M37.5 78 L39 40 L61 40 L62.5 78 Z' },
        // 腰箍
        { kind: 'path', d: 'M37 70 L63 70 L62.5 76 L37.5 76 Z' },
        // 冠部横带
        { kind: 'path', d: 'M34.5 40 L65.5 40 L65.5 30 L34.5 30 Z' },
        ...merlons,
      ];
    }

    case 'n': {
      // 马：底座 + 侧影（颈与头连成一条连续轮廓，口鼻朝左）
      //
      // 口鼻要**够长够低**：3D 里相机是 52° 俯角，竖直方向会被压扁 0.62 倍，
      // 短口鼻一压扁就变成一把斧头；把鼻梁拉长、吻部下压，剪影才立得住。
      return [
        ...plinth(19),
        {
          kind: 'path',
          d: [
            // 从颈根右侧起笔：右边缘向上
            'M64 78',
            'C66 66 67 56 65 46',
            // 颈背向上收，抵达头顶后脑
            'C63 37 59 31 53 27',
            // 耳朵：一个小三角尖
            'L50 14',
            'L44 23',
            // 头顶额部向左下
            'C40 27 36.5 31.5 32.5 36',
            // 口鼻：向左伸出，带圆润鼻头
            'C28 40 21 43.5 16 46.5',
            'C13.5 49.5 16.5 53 21.5 52.5',
            'C25 52 27 51 29.5 49.5',
            // 下颌回到颈根
            'C34.5 48 39 46.5 42 43.5',
            'C40 51 39 60 39 67',
            'C39 72 39.5 75.5 40.5 78',
            'Z',
          ].join(' '),
        },
        // 鬃毛：后颈上的一道月牙刻线，让「马」一眼成立
        {
          kind: 'path',
          d: 'M57.5 29 C60.5 38 60.5 49 58.5 59.5 L54.5 57.5 C56.5 48 56.5 38.5 54.5 30 Z',
          tone: 'detail',
        },
        // 眼睛
        { kind: 'circle', cx: 40.5, cy: 34.5, r: 2.4, tone: 'detail' },
      ];
    }

    case 'b': {
      // 象：底座 + 领圈 + 胖水滴身 + 主教冠（含斜裂口）+ 顶珠
      return [
        ...plinth(18),
        { kind: 'path', d: 'M39.5 78 C39.5 69 41.5 62 44.5 57 L55.5 57 C58.5 62 60.5 69 60.5 78 Z' },
        collar(57, 10.5),
        // 主教冠：上尖下胖的「水滴」，是象最重要的识别特征
        { kind: 'path', d: 'M50 23 C60 31 64 42 58 51.5 C55 57 45 57 42 51.5 C36 42 40 31 50 23 Z' },
        // 裂口：斜切一道深槽（白棋深槽 / 黑棋亮槽）
        { kind: 'path', d: 'M44 33 L48 28 L58 47 L54 52 Z', tone: 'detail' },
        // 顶珠
        { kind: 'circle', cx: 50, cy: 18.5, r: 4.6 },
      ];
    }

    case 'q': {
      // 后：底座 + 外扩身 + 五尖冠（每个尖顶一颗珠）
      return [
        ...plinth(20),
        { kind: 'path', d: 'M38.5 78 C39.5 69 42 61 45 55 L55 55 C58 61 60.5 69 61.5 78 Z' },
        collar(55, 12),
        // 冠体：五个尖，尖间是谷
        {
          kind: 'path',
          d:
            'M37 55 L37 32 L38.5 25 L41.5 34 L44.5 19 L47.5 33 L50 14 L52.5 33 ' +
            'L55.5 19 L58.5 34 L61.5 25 L63 32 L63 55 Z',
        },
        // 冠珠
        { kind: 'circle', cx: 38.5, cy: 25, r: 2.6 },
        { kind: 'circle', cx: 44.5, cy: 19, r: 2.8 },
        { kind: 'circle', cx: 50, cy: 14, r: 3.4 },
        { kind: 'circle', cx: 55.5, cy: 19, r: 2.8 },
        { kind: 'circle', cx: 61.5, cy: 25, r: 2.6 },
      ];
    }

    case 'k': {
      // 王：底座 + 身 + 冠碗 + 十字架
      return [
        ...plinth(20),
        { kind: 'path', d: 'M38 78 C39 69 41.5 61 44.5 55 L55.5 55 C58.5 61 61 69 62 78 Z' },
        collar(55, 13),
        // 冠碗
        { kind: 'path', d: 'M38 55 L38 38 C38 31 43 27 50 27 C57 27 62 31 62 38 L62 55 Z' },
        // 十字架（一整条路径，内部没有多余接缝）
        {
          kind: 'path',
          d:
            'M47 30 L47 19.5 L38.5 19.5 L38.5 13 L47 13 L47 6 L53 6 L53 13 ' +
            'L61.5 13 L61.5 19.5 L53 19.5 L53 30 Z',
        },
      ];
    }

    default:
      return plinth(14);
  }
}

/* ------------------------------------------------------------------ */
/* 卡通（圆胖团子 + 大眼睛）                                           */
/* ------------------------------------------------------------------ */

/** 卡通的托盘底座：又宽又扁的碟子 */
function cartoonSaucer(): Shape[] {
  return [
    {
      kind: 'path',
      d: 'M25 92 C25 85 29 80 37 79 L63 79 C71 80 75 85 75 92 Z',
    },
  ];
}

/** 卡通的身子：矮胖的水滴（比经典矮、比经典宽） */
function cartoonBody(topY = 58): Shape {
  return {
    kind: 'path',
    d: `M33 80 C34 69 38 62 43 ${topY} L57 ${topY} C62 62 66 69 67 80 Z`,
  };
}

/** 一对卡通眼睛（眼白 + 瞳孔 + 高光点） */
function cartoonEyes(cx1: number, cx2: number, cy: number, r: number): Shape[] {
  const out: Shape[] = [];
  for (const cx of [cx1, cx2]) {
    out.push({ kind: 'circle', cx, cy, r, tone: 'eye' });
    out.push({ kind: 'circle', cx: cx + r * 0.12, cy: cy + r * 0.1, r: r * 0.52, tone: 'pupil' });
  }
  return out;
}

/** 腮红 */
function cartoonBlush(cx1: number, cx2: number, cy: number): Shape[] {
  return [
    { kind: 'ellipse', cx: cx1, cy, rx: 3.6, ry: 2.4, tone: 'blush' },
    { kind: 'ellipse', cx: cx2, cy, rx: 3.6, ry: 2.4, tone: 'blush' },
  ];
}

/** 卡通造型：每个棋子都「圆胖 + 大眼睛 + 特征件放大」 */
function buildCartoonShapes(type: PieceType): Shape[] {
  switch (type) {
    case 'p': {
      // 兵：小圆球头 + 领圈 + 矮身子
      return [
        ...cartoonSaucer(),
        cartoonBody(60),
        { kind: 'ellipse', cx: 50, cy: 60, rx: 10.5, ry: 3.2 },
        { kind: 'circle', cx: 50, cy: 45, r: 14.5 },
        ...cartoonEyes(45, 55, 44, 4.6),
        ...cartoonBlush(40.5, 59.5, 50),
      ];
    }

    case 'r': {
      // 车：三个大城垛的方脑袋 + 矮胖塔身
      const teeth = [33.5, 45.5, 57.5];
      const merlons: Shape[] = teeth.map((x) => ({
        kind: 'path',
        d: `M${x} 44 L${x} 26 L${x + 9} 26 L${x + 9} 44 Z`,
      }));
      return [
        ...cartoonSaucer(),
        cartoonBody(56),
        // 塔身（比身子略窄，方一点）
        { kind: 'path', d: 'M35 78 L36 44 L64 44 L65 78 Z' },
        // 冠部横带
        { kind: 'path', d: 'M32 44 L68 44 L68 36 L32 36 Z' },
        ...merlons,
        ...cartoonEyes(43, 57, 62, 4.4),
        ...cartoonBlush(38.5, 61.5, 68),
      ];
    }

    case 'n': {
      // 马：圆脸侧影（短口鼻 + 立耳 + 鬃毛撮）
      return [
        ...cartoonSaucer(),
        {
          kind: 'path',
          d: [
            'M63 80',
            'C65 68 66 57 63 48',
            'C60 39 54 32 46 28',
            // 耳朵：朝后上方立起
            'L48 12',
            'L38 22',
            // 额头向左下
            'C33 27 29 32 26 37',
            // 口鼻：短短一截、圆头
            'C20 40 15 43 12.5 48',
            'C10.5 52.5 16 55.5 21 53.5',
            'C25 52 28 50 31 47.5',
            // 下颌回到颈根
            'C29.5 57 29 68 30 80',
            'Z',
          ].join(' '),
        },
        // 鬃毛：三撮小尖
        {
          kind: 'path',
          d: 'M56 30 C58 38 58 48 56.5 57 L52 55.5 C54 47 54 38 52.5 31.5 Z',
          tone: 'detail',
        },
        // 眼睛：侧脸只画一只，但画大
        { kind: 'circle', cx: 37, cy: 34, r: 5.4, tone: 'eye' },
        { kind: 'circle', cx: 38, cy: 35, r: 2.8, tone: 'pupil' },
        // 鼻孔
        { kind: 'circle', cx: 17.5, cy: 48, r: 1.9, tone: 'detail' },
      ];
    }

    case 'b': {
      // 象：胖蛋形主教冠 + 大斜缝 + 顶珠
      return [
        ...cartoonSaucer(),
        cartoonBody(58),
        { kind: 'ellipse', cx: 50, cy: 58, rx: 11, ry: 3.4 },
        // 胖蛋冠
        { kind: 'path', d: 'M50 24 C61 32 65 44 60 54 C56 60 44 60 40 54 C35 44 39 32 50 24 Z' },
        // 斜缝（比经典粗得多，一眼能看见）
        { kind: 'path', d: 'M42 34 L47 29 L59 49 L54 54 Z', tone: 'detail' },
        // 顶珠
        { kind: 'circle', cx: 50, cy: 20, r: 5.4 },
        ...cartoonEyes(43, 57, 68, 4.4),
        ...cartoonBlush(38.5, 61.5, 73),
      ];
    }

    case 'q': {
      // 后：三个大尖的皇冠 + 每尖一颗大珠
      return [
        ...cartoonSaucer(),
        cartoonBody(56),
        { kind: 'ellipse', cx: 50, cy: 56, rx: 12, ry: 3.6 },
        // 冠箍
        { kind: 'path', d: 'M34 56 L34 44 L66 44 L66 56 Z' },
        // 三个大尖
        {
          kind: 'path',
          d: 'M34 46 L36 30 L42 40 L50 22 L58 40 L64 30 L66 46 Z',
        },
        // 冠珠
        { kind: 'circle', cx: 36, cy: 29, r: 3.6 },
        { kind: 'circle', cx: 50, cy: 20, r: 4.4 },
        { kind: 'circle', cx: 64, cy: 29, r: 3.6 },
        ...cartoonEyes(43, 57, 66, 4.4),
        ...cartoonBlush(38.5, 61.5, 71),
      ];
    }

    case 'k': {
      // 王：圆头 + 宽十字
      return [
        ...cartoonSaucer(),
        cartoonBody(56),
        // 圆脑袋
        { kind: 'circle', cx: 50, cy: 44, r: 13.5 },
        // 宽十字（比经典的粗壮）
        {
          kind: 'path',
          d:
            'M45.5 34 L45.5 24 L38 24 L38 17.5 L45.5 17.5 L45.5 8 L54.5 8 ' +
            'L54.5 17.5 L62 17.5 L62 24 L54.5 24 L54.5 34 Z',
        },
        ...cartoonEyes(44.5, 55.5, 44, 4.8),
        ...cartoonBlush(39.5, 60.5, 50),
      ];
    }

    default:
      return cartoonSaucer();
  }
}

/* ------------------------------------------------------------------ */
/* 涂鸦：把线条抖歪                                                    */
/* ------------------------------------------------------------------ */

/**
 * **空间平滑**的噪声：输入坐标，输出 [-1, 1]。
 *
 * 为什么不能「按序号取噪声」（hash(seed, index) 那种）：
 *   路径上的点挨得很近（王冠的锯齿、相邻的控制点只差一两个单位），
 *   按序号取噪声 → 每个点往不同方向乱跳 → 线条变成一堆尖刺，
 *   原本的「锯齿」被抖成了锯毛。
 *   按**坐标**取噪声 → 挨得近的点位移也相近 → 整条线是**平滑地弯**，
 *   这才是手绘该有的样子。
 */
function smoothNoise(seed: number, x: number, y: number): number {
  return (
    Math.sin((x * 0.37 + y * 0.21 + seed) * 1.7) * 0.5 +
    Math.sin((x * 0.13 - y * 0.29 + seed * 1.7) * 2.3) * 0.3 +
    Math.sin((x * 0.71 + y * 0.53 + seed * 2.3) * 3.1) * 0.2
  );
}

/**
 * 把一条路径的每个坐标都抖一点 —— 手绘感就来自这里。
 *
 * 抖的是**控制点**，不是采样点：贝塞尔曲线被抖歪之后，
 * 整条线会呈现出「手抖」的不规则感，而不是「毛刺」。
 */
function wobblePath(d: string, seed: number, amp: number): string {
  const cmds = parseSvgPath(d);
  const out: string[] = [];
  const j = (x: number, y: number): number => smoothNoise(seed, x, y) * amp;
  const n = (v: number): string => v.toFixed(2);
  for (const c of cmds) {
    switch (c.op) {
      case 'M':
        out.push(`M${n(c.x + j(c.x, c.y))} ${n(c.y + j(c.y + 11, c.x))}`);
        break;
      case 'L':
        out.push(`L${n(c.x + j(c.x, c.y))} ${n(c.y + j(c.y + 11, c.x))}`);
        break;
      case 'C':
        out.push(
          `C${n(c.c1x + j(c.c1x, c.c1y))} ${n(c.c1y + j(c.c1y + 11, c.c1x))} ` +
            `${n(c.c2x + j(c.c2x, c.c2y))} ${n(c.c2y + j(c.c2y + 11, c.c2x))} ` +
            `${n(c.x + j(c.x, c.y))} ${n(c.y + j(c.y + 11, c.x))}`,
        );
        break;
      case 'Q':
        out.push(
          `Q${n(c.cx + j(c.cx, c.cy))} ${n(c.cy + j(c.cy + 11, c.cx))} ` +
            `${n(c.x + j(c.x, c.y))} ${n(c.y + j(c.y + 11, c.x))}`,
        );
        break;
      case 'Z':
        out.push('Z');
        break;
    }
  }
  return out.join(' ');
}

/** 圆 / 椭圆抖成一个手画的多边形 */
function wobbleCircle(cx: number, cy: number, r: number, seed: number, amp: number): Shape {
  const n = 16;
  const pts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const rr = r * (1 + smoothNoise(seed, ux * 3, uy * 3) * 0.07);
    pts.push(
      `${(cx + ux * rr + smoothNoise(seed + 7, ux * 5, uy * 5) * amp).toFixed(2)} ` +
        `${(cy + uy * rr + smoothNoise(seed + 13, ux * 5, uy * 5) * amp).toFixed(2)}`,
    );
  }
  return { kind: 'path', d: `M${pts.join(' L')} Z` };
}

/** 椭圆抖成手画的多边形 */
function wobbleEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  amp: number,
): Shape {
  const n = 16;
  const pts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const jx = 1 + smoothNoise(seed, ux * 3, uy * 3) * 0.08;
    const jy = 1 + smoothNoise(seed + 5, ux * 3, uy * 3) * 0.08;
    pts.push(
      `${(cx + ux * rx * jx + smoothNoise(seed + 7, ux * 5, uy * 5) * amp).toFixed(2)} ` +
        `${(cy + uy * ry * jy + smoothNoise(seed + 13, ux * 5, uy * 5) * amp).toFixed(2)}`,
    );
  }
  return { kind: 'path', d: `M${pts.join(' L')} Z` };
}

/** 涂鸦造型：骨架同经典，但每条线都抖歪，再加一对斗鸡眼 */
function buildDoodleShapes(type: PieceType): Shape[] {
  const src = buildClassicShapes(type);
  const seed = type.charCodeAt(0) * 31 + 7;
  const out: Shape[] = src.map((s, i) => {
    if (s.kind === 'path') {
      return { kind: 'path', d: wobblePath(s.d, seed + i * 17, 2.3), tone: s.tone };
    }
    if (s.kind === 'circle') {
      return { ...wobbleCircle(s.cx, s.cy, s.r, seed + i * 17, 1.6), tone: s.tone } as Shape;
    }
    return { ...wobbleEllipse(s.cx, s.cy, s.rx, s.ry, seed + i * 17, 1.6), tone: s.tone } as Shape;
  });

  /*
   * 斗鸡眼 —— 手绘涂鸦里最认得出的两个点。
   *
   * 位置按棋子自己的**脸**放：兵是那颗小圆头，马是侧脸，
   * 象/后/车/王都放在**身子**上（象的头是主教冠，脸不该长在冠上）。
   */
  const eyes: Record<PieceType, { x: number; y: number; r: number; spread: number }> = {
    p: { x: 50, y: 38, r: 3.1, spread: 4.2 },
    n: { x: 39, y: 33, r: 4.4, spread: 0 },
    b: { x: 50, y: 67, r: 3.6, spread: 5.2 },
    r: { x: 50, y: 62, r: 3.6, spread: 5.2 },
    q: { x: 50, y: 66, r: 3.6, spread: 5.2 },
    k: { x: 50, y: 42, r: 3.8, spread: 5.4 },
  };
  const e = eyes[type] ?? { x: 50, y: 45, r: 3.6, spread: 5 };
  if (e.spread === 0) {
    // 马是侧脸，只画一只
    out.push({ kind: 'circle', cx: e.x, cy: e.y, r: e.r, tone: 'eye' });
    out.push({ kind: 'circle', cx: e.x + 0.9, cy: e.y + 0.9, r: e.r * 0.5, tone: 'pupil' });
  } else {
    out.push({ kind: 'circle', cx: e.x - e.spread, cy: e.y, r: e.r, tone: 'eye' });
    out.push({ kind: 'circle', cx: e.x + e.spread, cy: e.y, r: e.r, tone: 'eye' });
    // 瞳孔往内偏 —— 这就是「斗鸡」
    out.push({ kind: 'circle', cx: e.x - e.spread + 0.9, cy: e.y + 0.7, r: e.r * 0.5, tone: 'pupil' });
    out.push({ kind: 'circle', cx: e.x + e.spread - 0.9, cy: e.y + 0.7, r: e.r * 0.5, tone: 'pupil' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 像素：把经典造型光栅化成位图                                        */
/* ------------------------------------------------------------------ */

/**
 * 像素风已经搬去 `pixelShapes.ts` 了 —— 它现在有**自己的造型语言**
 * （不再从经典造型降采样，理由见那个文件头的注释）。
 *
 * 这里**重导出**而不是让调用方改 import：
 *   PieceGlyph / pieceGeometry / 脚本 / 测试都从本文件拿 PixelCell，
 *   保持一条路径，以后拆文件也不用到处改。
 */
export {
  PixelCell,
  pixelGrid,
  pixelSilhouette,
  downscaleSilhouette,
  silhouetteIou,
  PIXEL_SIZE,
  type PixelCellValue,
  type PixelGrid,
} from './pixelShapes';

/** 一条路径的包围盒（用来分辨「哪条才是主轮廓」） */
function pathBounds(d: string): { area: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of parseSvgPath(d)) {
    const pts: Array<[number, number]> = [];
    if (c.op === 'M' || c.op === 'L') pts.push([c.x, c.y]);
    else if (c.op === 'C') pts.push([c.c1x, c.c1y], [c.c2x, c.c2y], [c.x, c.y]);
    else if (c.op === 'Q') pts.push([c.cx, c.cy], [c.x, c.y]);
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { area: 0 };
  return { area: (maxX - minX) * (maxY - minY) };
}

/**
 * 取某种风格下棋子的**主轮廓**路径。
 *
 * 马是唯一需要它的棋子：3D 的马头就是这条侧影挤出来的。
 *
 * 为什么按**包围盒面积**挑，而不是「第一条本体路径」——
 *   因为马的第一条本体路径是**底座**（只占很小一块），
 *   照第一条取会挤出一坨底座 —— 3D 里就变成「一个圆盘」，马不见了。
 */
export function pieceOutlinePath(type: PieceType, style: PieceStyle = 'classic'): string {
  let best = '';
  let bestArea = -1;
  for (const s of buildShapes(type, style)) {
    if (s.kind !== 'path') continue;
    if (s.tone !== undefined && s.tone !== 'body') continue;
    const { area } = pathBounds(s.d);
    if (area > bestArea) {
      bestArea = area;
      best = s.d;
    }
  }
  return best;
}

/**
 * 某种风格下棋子的**渲染签名** —— 用来判断「风格是不是真的换了画法」。
 *
 * 像素版是特例：它不画矢量路径，而是画**位图**，
 * 所以签名必须取自位图本身（否则像素版和经典版会算出同一个签名，
 * 「风格开关等于没做」这条判据就抓不到它）。
 */
export function pieceStyleSignature(type: PieceType, style: PieceStyle = 'classic'): string {
  if (style === 'pixel') {
    const grid = pixelGrid(type);
    return grid.cells.join('');
  }
  return buildShapes(type, style)
    .map((s) => {
      if (s.kind === 'path') return s.d;
      if (s.kind === 'circle') return `c${s.cx},${s.cy},${s.r}`;
      return `e${s.cx},${s.cy},${s.rx},${s.ry}`;
    })
    .join('|');
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取某种风格下某枚棋子的图形。
 *
 * @param type  棋子
 * @param style 风格
 */
export function buildShapes(type: PieceType, style: PieceStyle = 'classic'): Shape[] {
  switch (style) {
    case 'cartoon':
      return buildCartoonShapes(type);
    case 'doodle':
      return buildDoodleShapes(type);
    case 'pixel':
      // 像素版由位图渲染（见 PieceGlyph），这里仍然返回经典骨架，
      // 好让 3D 与素材脚本有一份统一的「形状」概念。
      return buildClassicShapes(type);
    case 'classic':
    default:
      return buildClassicShapes(type);
  }
}

/**
 * 取某种风格下某枚棋子的**细节件**（tone = 'detail'）。
 *
 * 细节件就是「刻线 / 凹槽」：象的裂口、马的鬃毛与眼睛、后冠上的沟。
 * 2D 里它们用描边色填充（白棋深槽、黑棋亮槽）；
 * 3D 里同样的形状会被贴到棋子表面（见 pieceGeometry.ts 的 pieceDetailGeometry），
 * 用**对比色**渲染 —— 于是白棋有深色刻线、黑棋有亮色刻线，
 * 无论落在浅格还是深格上都读得出结构。
 *
 * 卡通风格没有「刻线」这套语言（它的识别特征是大眼睛），
 * 所以这里只保留真正属于该风格的细节件。
 */
export function pieceDetailShapes(type: PieceType, style: PieceStyle = 'classic'): PieceShape[] {
  if (style === 'cartoon') {
    // 卡通的「马鬃 / 象缝」仍然保留为刻线（它们是识别特征，不是装饰）
    return buildCartoonShapes(type).filter((s) => s.tone === 'detail');
  }
  if (style === 'doodle') {
    return buildDoodleShapes(type).filter((s) => s.tone === 'detail');
  }
  return buildClassicShapes(type).filter((s) => s.tone === 'detail');
}

/**
 * 某种风格的描边粗细（画布单位）。
 *
 * 描边太细，棋盘 48px 下会发虚（这正是项目里 PIECE_STROKE 存在的理由）。
 * 卡通要「粗墨线」，涂鸦要「马克笔」，像素**不描边**（0 = 靠位图自己的暗边）。
 */
export function pieceStrokeWidth(style: PieceStyle): number {
  switch (style) {
    case 'cartoon':
      return 3.4;
    case 'doodle':
      return 2.4;
    case 'pixel':
      return 0;
    case 'classic':
    default:
      return 2.6;
  }
}
