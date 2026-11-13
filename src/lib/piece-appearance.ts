'use client';

/**
 * 棋子外观配置 —— **两条正交的轴**。
 *
 *   · **风格（style）** 改的是**造型**：形状、比例、线条怎么画。
 *     经典 = Staunton 的写实比例；卡通 = 圆胖团子 + 大眼睛；
 *     像素 = 位图精灵；涂鸦 = 手绘马克笔。
 *   · **材质（material）** 改的是**表面**：颜色、光泽、纹理怎么表现。
 *     木质 = 暖木色 + 木纹 + 哑光；金属 = 冷灰 + 硬边高光 + 强反射；
 *     塑料 = 亮面 + 柔和高光 + 圆润。
 *
 * 为什么必须是两条轴而不是六个选项：
 *   风格管「它长什么样」，材质管「它是什么做的」——
 *   两者正交，4 × 3 = 12 种组合，用户想要「卡通的塑料兵」或「像素的木质王」都能拿到。
 *   如果做成互斥的六个选项，就再也拼不出这种组合。
 *
 * 配色的一条硬规矩（沿用项目既有约定）：
 *   **描边反着配** —— 白方配深描边（浅色棋格上不糊），黑方配浅描边（深色棋格上不糊）。
 *   材质换了，这条规矩也不换。
 */

import type { PieceType } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* 风格                                                                */
/* ------------------------------------------------------------------ */

export type PieceStyle = 'classic' | 'cartoon' | 'pixel' | 'doodle';

export interface PieceStyleDef {
  id: PieceStyle;
  /** 设置面板里显示的名字 */
  label: string;
  /** 一句话说清这个风格的核心 —— 只用在素材页/文档里，置面板不写 */
  note: string;
}

export const PIECE_STYLES: PieceStyleDef[] = [
  {
    id: 'classic',
    label: '经典',
    note: 'Staunton 的写实比例：底座、领圈、收腰、特征件层层收上去。',
  },
  {
    id: 'cartoon',
    label: '卡通',
    note: '圆胖团子造型，脑袋大、身子短，配一双大眼睛和腮红。',
  },
  {
    id: 'pixel',
    label: '像素',
    note: '位图精灵：硬边方块、三色调（描边 / 本体 / 高光），3D 里是同一张图的体素挤出。',
  },
  {
    id: 'doodle',
    label: '涂鸦',
    note: '马克笔手绘：线条歪扭、双描边、斜线排线填充，配一双斗鸡眼。',
  },
];

export const DEFAULT_PIECE_STYLE: PieceStyle = 'classic';

/* ------------------------------------------------------------------ */
/* 材质                                                                */
/* ------------------------------------------------------------------ */

export type PieceMaterial = 'wood' | 'metal' | 'plastic';

export interface PieceMaterialDef {
  id: PieceMaterial;
  label: string;
  note: string;
}

export const PIECE_MATERIALS: PieceMaterialDef[] = [
  {
    id: 'wood',
    label: '木质',
    note: '枫木 / 乌木：暖色、哑光，表面有顺着走势的木纹。',
  },
  {
    id: 'metal',
    label: '金属',
    note: '银 / 发黑钢：冷灰、高反射，一道硬边高光带划过身侧。',
  },
  {
    id: 'plastic',
    label: '塑料',
    note: '亮面塑料：带色的冷调白与深靛蓝，高光是软的圆斑。',
  },
];

export const DEFAULT_PIECE_MATERIAL: PieceMaterial = 'wood';

/* ------------------------------------------------------------------ */
/* 调色板                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一套材质在某一方的全部颜色。
 *
 * 字段分工：
 *   fill      本体色
 *   stroke    描边色（**反着配**：白方深描边、黑方浅描边）
 *   highlight 高光色（塑料是柔和圆斑，金属是硬边亮带，木质是木纹高光）
 *   shade     暗部色（压在本体下缘的暗带）
 *   gloss     高光叠加层的颜色 + 透明度（2D 用）
 *   shadow    接地投影
 */
export interface PiecePalette {
  fill: string;
  stroke: string;
  highlight: string;
  shade: string;
  gloss: string;
  shadow: string;
  /** 木纹线的颜色（只有木质用得上，其余材质忽略） */
  grain: string;
}

const WOOD: Record<'w' | 'b', PiecePalette> = {
  w: {
    fill: '#f0dcb4',
    stroke: '#4a3418',
    highlight: '#fff4dc',
    shade: '#c6a473',
    gloss: 'rgba(255, 248, 226, 0.5)',
    shadow: 'rgba(74, 52, 24, 0.32)',
    grain: 'rgba(120, 78, 34, 0.34)',
  },
  b: {
    fill: '#3c2f25',
    stroke: '#e6d4b4',
    highlight: '#7a6552',
    shade: '#221a13',
    gloss: 'rgba(255, 236, 200, 0.24)',
    shadow: 'rgba(0, 0, 0, 0.48)',
    grain: 'rgba(20, 14, 9, 0.55)',
  },
};

const METAL: Record<'w' | 'b', PiecePalette> = {
  w: {
    fill: '#d7dce3',
    stroke: '#2a3038',
    highlight: '#ffffff',
    shade: '#949dab',
    gloss: 'rgba(255, 255, 255, 0.72)',
    shadow: 'rgba(30, 40, 52, 0.34)',
    grain: 'rgba(120, 132, 148, 0.28)',
  },
  b: {
    fill: '#4b515a',
    stroke: '#e4ebf3',
    highlight: '#aeb7c1',
    shade: '#2b3037',
    gloss: 'rgba(226, 236, 248, 0.4)',
    shadow: 'rgba(0, 0, 0, 0.5)',
    grain: 'rgba(16, 20, 26, 0.5)',
  },
};

const PLASTIC: Record<'w' | 'b', PiecePalette> = {
  w: {
    fill: '#eef3fb',
    stroke: '#2b4d86',
    highlight: '#ffffff',
    shade: '#c3cfe2',
    gloss: 'rgba(255, 255, 255, 0.85)',
    shadow: 'rgba(28, 44, 76, 0.3)',
    grain: 'rgba(43, 77, 134, 0.18)',
  },
  b: {
    fill: '#2b3350',
    stroke: '#9fd0ff',
    highlight: '#5f7099',
    shade: '#171c30',
    gloss: 'rgba(190, 226, 255, 0.42)',
    shadow: 'rgba(0, 0, 0, 0.52)',
    grain: 'rgba(159, 208, 255, 0.16)',
  },
};

const PALETTES: Record<PieceMaterial, Record<'w' | 'b', PiecePalette>> = {
  wood: WOOD,
  metal: METAL,
  plastic: PLASTIC,
};

/**
 * 取一套调色板。
 *
 * 材质未知就回落到木质（设置里的脏数据不该让棋盘崩）。
 */
export function piecePalette(material: PieceMaterial, color: 'w' | 'b'): PiecePalette {
  const byColor = PALETTES[material] ?? PALETTES.wood;
  return byColor[color] ?? byColor.w;
}

/**
 * 经典外观的调色板（历史遗留的导出名）。
 *
 * 2D 棋子原本就是「象牙白 + 石墨黑 + 反着描边」，现在这套配色归到**木质**下面。
 * 保留这个导出是为了让既有引用（3D 描边、素材生成脚本）继续能用。
 */
export const PALETTE = {
  w: {
    fill: WOOD.w.fill,
    stroke: WOOD.w.stroke,
    highlight: WOOD.w.highlight,
    shadow: WOOD.w.shadow,
  },
  b: {
    fill: WOOD.b.fill,
    stroke: WOOD.b.stroke,
    highlight: WOOD.b.highlight,
    shadow: WOOD.b.shadow,
  },
};

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 设置里的值是不是一个合法风格 */
export function isPieceStyle(value: unknown): value is PieceStyle {
  return typeof value === 'string' && PIECE_STYLES.some((s) => s.id === value);
}

/** 设置里的值是不是一个合法材质 */
export function isPieceMaterial(value: unknown): value is PieceMaterial {
  return typeof value === 'string' && PIECE_MATERIALS.some((m) => m.id === value);
}

/** 按 id 取风格；取不到就回落默认 */
export function getPieceStyle(id: string | undefined | null): PieceStyle {
  return isPieceStyle(id) ? id : DEFAULT_PIECE_STYLE;
}

/** 按 id 取材质；取不到就回落默认 */
export function getPieceMaterial(id: string | undefined | null): PieceMaterial {
  return isPieceMaterial(id) ? id : DEFAULT_PIECE_MATERIAL;
}

/**
 * 设置面板预览用的棋子。
 *
 * 四个风格、四种材质**都用同一枚棋子**（王）——
 * 预览要能横向比较，换棋子就比不出来了。
 */
export const PREVIEW_PIECE: PieceType = 'k';
