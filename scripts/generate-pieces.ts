/**
 * 棋子素材生成器 —— 把棋子的几何定义导出成**静态 SVG 文件**。
 *
 * 为什么要落盘成文件（PLAN.md §7 / C1）：
 *  - 需求要求「图片资源由本项目自己生成」——生成过程必须可见、可复现、可分发；
 *  - 落盘后棋子素材就是一份实实在在的自产资产（public/pieces/*.svg），
 *    可以单独打开查看、随项目分发、用于印刷/截图等二次用途；
 *  - 棋盘**运行时仍然用内联 SVG** 渲染（见 Board2D），
 *    因为内联矢量在任何分辨率下都清晰，且省掉 12 次网络请求。
 *
 * 素材现在有**两条轴**（风格 × 材质），所以落盘也分两组：
 *   public/pieces/style/{风格}/{棋子}-{方}.svg     造型变了，材质统一木质
 *   public/pieces/material/{材质}/{棋子}-{方}.svg  材质变了，造型统一经典
 *   public/pieces/{棋子}-{方}.svg                  经典 + 木质（默认，保持旧路径不变）
 *
 * 关键：**直接渲染 PieceGlyph 本体**（而不是在这里重画一遍几何）。
 *   以前这里是「照着 PieceGlyph 的几何另写一份 SVG」——
 *   造型一改，素材就会和实现悄悄漂移。
 *   现在两边是同一段代码，**不可能漂移**。
 *
 * 用法：npm run assets:pieces
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PieceGlyph } from '@/components/PieceGlyph';
import { PIECE_STYLES, PIECE_MATERIALS } from '@/lib/piece-appearance';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

const OUT_DIR = join(process.cwd(), 'public', 'pieces');

const TYPES: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const NAMES: Record<PieceType, string> = {
  p: '兵',
  n: '马',
  b: '象',
  r: '车',
  q: '后',
  k: '王',
};

interface ManifestEntry {
  file: string;
  type: PieceType;
  color: 'w' | 'b';
  label: string;
  style: PieceStyle;
  material: PieceMaterial;
}

function svgFor(type: PieceType, color: 'w' | 'b', style: PieceStyle, material: PieceMaterial): string {
  const markup = renderToStaticMarkup(
    createElement(PieceGlyph, { type, color, size: 100, style, material }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 本项目原创棋子素材，由 scripts/generate-pieces.ts 自动生成，请勿手工编辑 -->
<!-- 造型：几何分层构造（底座 / 领圈 / 躯干 / 头部），未使用任何第三方素材 -->
<!-- 风格：${style} · 材质：${material} -->
${markup}
`;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: ManifestEntry[] = [];

  const emit = (dir: string, style: PieceStyle, material: PieceMaterial): void => {
    mkdirSync(join(OUT_DIR, dir), { recursive: true });
    for (const type of TYPES) {
      for (const color of ['w', 'b'] as const) {
        const file = `${type}-${color}.svg`;
        writeFileSync(join(OUT_DIR, dir, file), svgFor(type, color, style, material), 'utf8');
        manifest.push({
          file: join(dir, file),
          type,
          color,
          label: `${color === 'w' ? '白' : '黑'}方${NAMES[type]}`,
          style,
          material,
        });
      }
    }
  };

  // 默认（经典 + 木质）—— 保持旧路径不变，老引用不会断
  for (const type of TYPES) {
    for (const color of ['w', 'b'] as const) {
      const file = `${type}-${color}.svg`;
      writeFileSync(join(OUT_DIR, file), svgFor(type, color, 'classic', 'wood'), 'utf8');
      manifest.push({
        file,
        type,
        color,
        label: `${color === 'w' ? '白' : '黑'}方${NAMES[type]}`,
        style: 'classic',
        material: 'wood',
      });
    }
  }

  // 风格组：造型变，材质统一木质
  for (const s of PIECE_STYLES) {
    emit(join('style', s.id), s.id, 'wood');
  }
  // 材质组：材质变，造型统一经典
  for (const m of PIECE_MATERIALS) {
    emit(join('material', m.id), 'classic', m.id);
  }

  writeFileSync(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        generator: 'scripts/generate-pieces.ts',
        note: '本项目原创素材；直接渲染 PieceGlyph 本体，与棋盘运行时不可能漂移',
        axes: {
          style: PIECE_STYLES.map((s) => ({ id: s.id, label: s.label })),
          material: PIECE_MATERIALS.map((m) => ({ id: m.id, label: m.label })),
        },
        pieces: manifest,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`✓ 已生成 ${manifest.length} 个棋子 SVG → public/pieces/`);
  console.log('  并写入 public/pieces/manifest.json');
}

main();
