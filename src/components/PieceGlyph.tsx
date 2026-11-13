'use client';

/**
 * 棋子 SVG —— 代码生成，不依赖任何外部素材。
 *
 * 为什么要自己画：
 *  - 需求要求素材自产、无版权风险；
 *  - 2D 与 3D 需要**完全一致**的造型语言，SVG 矢量图在任何分辨率下都清晰；
 *  - 3D 场景里同一套造型会被挤出成实体几何（见 pieceGeometry.ts）。
 *
 * 这里有**两条正交的轴**（定义见 src/lib/piece-appearance.ts）：
 *
 *   风格（style）  →  **形状**：形状、比例、线条。
 *     经典 / 卡通 / 像素 / 涂鸦，四种造型语言由 pieceShapes.ts 提供。
 *
 *   材质（material）→  **表面**：颜色、光泽、纹理。
 *     木质（木纹）/ 金属（硬边高光带）/ 塑料（柔和圆斑）。
 *     材质的表现一律画在**被剪裁到棋子轮廓内**的一层里，
 *     所以高光和木纹永远不会溢出到棋盘上。
 *
 * 渲染顺序（每种风格都一样，只是每一层的画法不同）：
 *   ① 接地投影 → ② 轮廓/本体 → ③ 材质层（裁剪在轮廓内）→ ④ 刻线 → ⑤ 卡通五官
 *
 * ⚠️ **单一 return 路径**（曾经的线上事故）：
 *   组件里必须只有**一个** return，且所有 hook 都在它之前无条件执行。
 *   早先像素版写的是 `if (style === 'pixel') return <像素精灵/>`，
 *   后面还跟着木纹的 useMemo —— 从「经典」切到「像素」的那一刻
 *   hook 数量变少，React 抛 "Rendered fewer hooks than expected"，
 *   **整个棋盘直接崩掉消失**（不是渲染异常，是整棵树卸载）。
 *   现在像素版只是同一个 <svg> 里的一个条件分支，hook 序列恒定。
 */
import { useId, useMemo } from 'react';
import {
  buildShapes,
  pieceDetailShapes,
  pieceStrokeWidth,
  PixelCell,
  pixelGrid,
  type PieceShape,
  type PixelCellValue,
} from './pieceShapes';
import {
  piecePalette,
  type PieceMaterial,
  type PieceStyle,
} from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

export interface PieceGlyphProps {
  type: PieceType;
  color: 'w' | 'b';
  size?: number;
  className?: string;
  /** 造型语言（默认经典） */
  style?: PieceStyle;
  /** 表面材质（默认木质） */
  material?: PieceMaterial;
}

/**
 * 描边宽度（画布单位）—— **经典风格**的基准值。
 *
 * 棋盘上棋子只有 48~70px 宽 —— 1.8 的描边在那个尺寸下只有 0.9px，
 * 屏幕上就是「发虚、看不清结构」。2.6 在 48px 下仍有 1.25px，
 * 在 110px 的素材预览下是 2.9px —— 两头都站得住。
 */
export const PIECE_STROKE = 2.6;

/** 内部别名 */
type Shape = PieceShape;

/* ------------------------------------------------------------------ */
/* 渲染小工具                                                          */
/* ------------------------------------------------------------------ */

/** 把一个图元画成 SVG 元素 */
function renderShape(
  shape: Shape,
  key: number,
  props: {
    fill: string;
    stroke: string;
    strokeWidth: number;
    strokeOpacity?: number;
    fillOpacity?: number;
  },
): React.ReactElement {
  const common = {
    fill: props.fill,
    stroke: props.stroke,
    strokeWidth: props.strokeWidth,
    strokeOpacity: props.strokeOpacity ?? 1,
    fillOpacity: props.fillOpacity ?? 1,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  };
  if (shape.kind === 'path') return <path key={key} d={shape.d} {...common} />;
  if (shape.kind === 'circle') {
    return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} {...common} />;
  }
  return (
    <ellipse key={key} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...common} />
  );
}

/** 图元是否属于「本体」（需要参与剪裁与剪影） */
function isBody(shape: Shape): boolean {
  return shape.tone === undefined || shape.tone === 'body';
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

export function PieceGlyph({
  type,
  color,
  size = 100,
  className,
  style = 'classic',
  material = 'wood',
}: PieceGlyphProps) {
  const palette = piecePalette(material, color);
  const strokeWidth = pieceStrokeWidth(style);
  const isPixel = style === 'pixel';

  /*
   * 渐变 / 剪裁用的 id 必须：
   *   ① 同一页面里多个棋子不能撞（否则第二个棋子的高光会画到第一个身上）；
   *   ② 服务端渲染与客户端水合后必须一致（否则 React 会报 id 不匹配）。
   * React 的 useId 满足 ②，但它的值里带冒号（`:r0:`）——
   * 冒号在 `url(#...)` 里不合法，所以这里把非法字符剔掉。
   */
  const rawId = useId();
  const uid = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);

  const shapes = useMemo(() => buildShapes(type, style), [type, style]);
  const bodyShapes = useMemo(() => shapes.filter(isBody), [shapes]);
  const detailShapes = useMemo(
    () => (isPixel ? [] : pieceDetailShapes(type, style)),
    [type, style, isPixel],
  );
  const featureShapes = useMemo(
    () =>
      isPixel
        ? []
        : shapes.filter((s) => s.tone === 'eye' || s.tone === 'pupil' || s.tone === 'blush'),
    [shapes, isPixel],
  );

  /* 像素版位图（经典造型光栅化而来，保证同一副骨架） */
  const grid = useMemo(() => pixelGrid(type), [type]);

  /**
   * 木纹：几条顺着走势的细线（裁剪在轮廓内）。
   */
  const grainLines = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const x = 36 + i * 9;
      out.push(`M${x} 18 C${x - 2.5} 40 ${x + 2.5} 62 ${x} 94`);
    }
    return out;
  }, []);

  const clipId = `${uid}-clip`;
  const glossId = `${uid}-gloss`;
  const specId = `${uid}-spec`;
  const hatchId = `${uid}-hatch`;

  const label = `${color === 'w' ? '白' : '黑'}方${
    { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' }[type]
  }`;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering={isPixel ? 'crispEdges' : undefined}
      role="img"
      aria-label={label}
    >
      {isPixel ? (
        /* ---------------- 像素版：位图直接铺方块 ---------------- */
        <>
          <ellipse cx="50" cy="93" rx="17" ry="3.4" fill={palette.shadow} />
          <PixelSprite grid={grid} palette={palette} />
        </>
      ) : (
        /* ---------------- 其余三种风格 ---------------- */
        <>
          {/* 剪裁到棋子轮廓 —— 材质层永远不溢出到棋盘上 */}
          <clipPath id={clipId}>
            {bodyShapes.map((s, i) =>
              renderShape(s, i, { fill: '#000', stroke: 'none', strokeWidth: 0 }),
            )}
          </clipPath>

          {/* 材质层用到的渐变 */}
          <radialGradient id={glossId} cx="38%" cy="30%" r="62%">
            <stop offset="0%" stopColor={palette.gloss} stopOpacity={1} />
            <stop offset="100%" stopColor={palette.gloss} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={specId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={palette.gloss} stopOpacity={0} />
            <stop offset="38%" stopColor={palette.gloss} stopOpacity={1} />
            <stop offset="62%" stopColor={palette.gloss} stopOpacity={1} />
            <stop offset="100%" stopColor={palette.gloss} stopOpacity={0} />
          </linearGradient>
          {style === 'doodle' && (
            <pattern
              id={hatchId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(22)"
            >
              {/*
               * 排线用**描边色**：白棋是深棕线、黑棋是浅木色线 ——
               * 和「反着配色」同一条规矩，两种底色上都看得见。
               * 用 grain 色（本来就是半透明的）会淡到看不见 —— 那就等于没画。
               */}
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke={palette.stroke}
                strokeOpacity="0.34"
                strokeWidth="1.3"
              />
            </pattern>
          )}

          {/* 接地投影，让棋子有重量感 */}
          <ellipse cx="50" cy="93" rx="17" ry="3.4" fill={palette.shadow} />

          {/* ---------- ① 本体 ---------- */}
          {style === 'cartoon' ? (
            <>
              {/*
               * 卡通：两遍画法 —— 先用描边色把轮廓**撑粗**一圈，
               * 再用本体色把内部盖回去，剩下的就是一圈干净的粗墨线。
               * （逐块描边会在身上留下一堆内部结构线，不好看。）
               */}
              {bodyShapes.map((s, i) =>
                renderShape(s, i, {
                  fill: palette.stroke,
                  stroke: palette.stroke,
                  strokeWidth: strokeWidth * 2,
                }),
              )}
              {bodyShapes.map((s, i) =>
                renderShape(s, i, {
                  fill: palette.fill,
                  stroke: 'none',
                  strokeWidth: 0,
                }),
              )}
            </>
          ) : (
            bodyShapes.map((s, i) =>
              renderShape(s, i, {
                fill: palette.fill,
                stroke: palette.stroke,
                strokeWidth,
              }),
            )
          )}

          {/* 涂鸦的第二道描边：偏一点、半透明 —— 手绘的「双线感」 */}
          {style === 'doodle' &&
            bodyShapes.map((s, i) =>
              renderShape(s, i, {
                fill: 'none',
                stroke: palette.stroke,
                strokeWidth: strokeWidth * 0.55,
                strokeOpacity: 0.4,
              }),
            )}

          {/* ---------- ② 材质层（裁剪在轮廓内） ---------- */}
          <g clipPath={`url(#${clipId})`}>
            {material === 'wood' && (
              <>
                {grainLines.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={palette.grain}
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                ))}
              </>
            )}

            {material === 'metal' && (
              <>
                {/* 一道斜切的高光带：金属的招牌 */}
                <path d="M30 16 L46 16 L58 96 L40 96 Z" fill={`url(#${specId})`} />
                {/* 高光带里最亮的一根硬边 */}
                <path d="M35 16 L39 16 L52 96 L47 96 Z" fill="#ffffff" fillOpacity="0.35" />
                {/* 底部暗面 */}
                <rect x="0" y="78" width="100" height="22" fill={palette.shade} fillOpacity="0.35" />
              </>
            )}

            {material === 'plastic' && (
              <>
                {/* 柔和高光：一个圆斑（塑料的高光是软的，金属是硬的） */}
                <ellipse cx="40" cy="40" rx="17" ry="21" fill={`url(#${glossId})`} />
                {/* 底部环境反光 */}
                <rect x="0" y="74" width="100" height="26" fill={palette.highlight} fillOpacity="0.22" />
              </>
            )}

            {/* 涂鸦：斜线排线填充 */}
            {style === 'doodle' && (
              <rect x="0" y="0" width="100" height="100" fill={`url(#${hatchId})`} />
            )}
          </g>

          {/* ---------- ③ 刻线 / 凹槽 ---------- */}
          {detailShapes.map((s, i) =>
            renderShape(s, i, {
              fill: palette.stroke,
              stroke: palette.stroke,
              strokeWidth: strokeWidth * 0.6,
            }),
          )}

          {/* ---------- ④ 卡通五官 ---------- */}
          {featureShapes.map((s, i) => {
            if (s.tone === 'eye') {
              return renderShape(s, i, {
                fill: '#ffffff',
                stroke: '#2b3140',
                strokeWidth: 1.1,
              });
            }
            if (s.tone === 'pupil') {
              return renderShape(s, i, {
                fill: '#232a3a',
                stroke: 'none',
                strokeWidth: 0,
              });
            }
            return renderShape(s, i, {
              fill: '#ff8a8a',
              stroke: 'none',
              strokeWidth: 0,
              fillOpacity: 0.5,
            });
          })}
        </>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 像素精灵                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把位图铺成方块。
 *
 * 每种色调合成**一条** path（而不是每格一个 rect）——
 * 一枚棋子最多几百格，逐格渲染会拖垮 2D 棋盘（有 32 枚棋子）。
 */
function PixelSprite({
  grid,
  palette,
}: {
  grid: ReturnType<typeof pixelGrid>;
  palette: ReturnType<typeof piecePalette>;
}): React.ReactElement {
  const tones: Array<{ cell: PixelCellValue; fill: string }> = [
    { cell: PixelCell.Outline, fill: palette.stroke },
    { cell: PixelCell.Detail, fill: palette.stroke },
    { cell: PixelCell.Highlight, fill: palette.highlight },
    { cell: PixelCell.Body, fill: palette.fill },
  ];

  const cell = 100 / grid.size;
  const paths = tones.map(({ cell: kind, fill }) => {
    const d: string[] = [];
    for (let row = 0; row < grid.size; row += 1) {
      for (let col = 0; col < grid.size; col += 1) {
        if (grid.cells[row * grid.size + col] !== kind) continue;
        const x = col * cell;
        const y = row * cell;
        d.push(`M${x} ${y}h${cell}v${cell}h-${cell}z`);
      }
    }
    if (!d.length) return null;
    return <path key={kind} d={d.join('')} fill={fill} />;
  });

  return <>{paths}</>;
}

export { buildShapes as buildPieceShapes };
export { pieceDetailShapes };
export { PALETTE } from '@/lib/piece-appearance';
