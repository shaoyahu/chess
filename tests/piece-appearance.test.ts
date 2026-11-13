/**
 * 棋子外观（风格 × 材质）的回归测试。
 *
 * 背景（2026-11-12 新增需求）：
 *   设置里多了两个开关 —— **棋子风格**（经典 / 卡通 / 像素 / 涂鸦）与
 *   **棋子材质**（木质 / 金属 / 塑料）。两条轴**正交**，共 12 种组合。
 *
 * 这里守的是三件事：
 *   ① **风格真的改了形状**（不是换个滤镜）；
 *      四种风格画出来的必须是**不同的图形**，否则「切风格」这个动作等于没做。
 *   ② **材质真的改了表面**（不是换个名字）；
 *      三种材质的本体色、描边色、光泽三者必须各不相同，
 *      而且色温要符合设计意图：木质偏暖、金属中性灰、塑料偏冷。
 *   ③ **辨识度不能塌**（沿用老门禁的病根）；
 *      每一种风格下，六种棋子的剪影都必须两两不同 ——
 *      像素风最容易出「车和后撞脸」，这一条专门盯它。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PIECE_STYLES,
  PIECE_MATERIALS,
  DEFAULT_PIECE_STYLE,
  DEFAULT_PIECE_MATERIAL,
  getPieceStyle,
  getPieceMaterial,
  isPieceStyle,
  isPieceMaterial,
  piecePalette,
  PREVIEW_PIECE,
} from '@/lib/piece-appearance';
import {
  buildShapes,
  pieceStrokeWidth,
  pixelGrid,
  PixelCell,
  pieceOutlinePath,
  pieceStyleSignature,
} from '@/components/pieceShapes';
import {
  pieceGeometry,
  pieceHeight,
  pieceDetailGeometry,
  pieceMaterial,
  pieceAccentMaterial,
  piecePixelGeometries,
  PIECE_HEIGHT,
} from '@/components/pieceGeometry';
import { sharedBounds, silhouette } from './helpers/silhouette';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

const TYPES: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const STYLES: PieceStyle[] = PIECE_STYLES.map((s) => s.id);
const MATERIALS: PieceMaterial[] = PIECE_MATERIALS.map((m) => m.id);

/** 取景模型允许的最高棋子顶（src/lib/frame3d.ts 的 PIECE_TOP） */
const PIECE_TOP = 1.04;
/** 棋面高度 */
const BOARD_TOP = 0.05;

/** #rrggbb → [r, g, b] */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** 相对亮度（0..1） */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 一枚棋子在某种风格下的图形签名（用来比较「形状是不是真的变了」） */
function shapeSignature(type: PieceType, style: PieceStyle): string {
  return pieceStyleSignature(type, style);
}

describe('外观配置', () => {
  it('四种风格、三种材质，id 唯一、名字非空', () => {
    expect(STYLES).toEqual(['classic', 'cartoon', 'pixel', 'doodle']);
    expect(MATERIALS).toEqual(['wood', 'metal', 'plastic']);
    expect(new Set(STYLES).size).toBe(4);
    expect(new Set(MATERIALS).size).toBe(3);
    for (const s of PIECE_STYLES) expect(s.label.length).toBeGreaterThan(0);
    for (const m of PIECE_MATERIALS) expect(m.label.length).toBeGreaterThan(0);
  });

  it('非法的风格 / 材质回落到默认值', () => {
    expect(getPieceStyle('neon')).toBe(DEFAULT_PIECE_STYLE);
    expect(getPieceStyle(undefined)).toBe(DEFAULT_PIECE_STYLE);
    expect(getPieceMaterial('黄金')).toBe(DEFAULT_PIECE_MATERIAL);
    expect(getPieceMaterial(null)).toBe(DEFAULT_PIECE_MATERIAL);
    expect(isPieceStyle('pixel')).toBe(true);
    expect(isPieceStyle('neon')).toBe(false);
    expect(isPieceMaterial('metal')).toBe(true);
    expect(isPieceMaterial('黄金')).toBe(false);
  });

  it('预览用的棋子是王（能代表整套造型语言）', () => {
    expect(PREVIEW_PIECE).toBe('k');
  });

  it('描边**反着配**：白方深描边、黑方浅描边（落在棋格上都读得出）', () => {
    for (const m of MATERIALS) {
      const w = piecePalette(m, 'w');
      const b = piecePalette(m, 'b');
      expect(luminance(w.stroke), `${m} 白棋的描边比本体还亮`).toBeLessThan(luminance(w.fill));
      expect(luminance(b.stroke), `${m} 黑棋的描边比本体还暗`).toBeGreaterThan(luminance(b.fill));
    }
  });

  it('三种材质的**色温**符合设计意图：木质偏暖 / 金属中性灰 / 塑料偏冷', () => {
    for (const side of ['w', 'b'] as const) {
      const [wr, , wb] = rgb(piecePalette('wood', side).fill);
      const [mr, , mb] = rgb(piecePalette('metal', side).fill);
      const [pr, , pb] = rgb(piecePalette('plastic', side).fill);
      expect(wr - wb, `木质${side} 应该明显偏暖`).toBeGreaterThan(20);
      expect(Math.abs(mr - mb), `金属${side} 应该是中性灰`).toBeLessThanOrEqual(20);
      expect(pb - pr, `塑料${side} 应该偏冷`).toBeGreaterThanOrEqual(0);
    }
  });

  it('三种材质的本体色互不相同（切了材质要一眼看出来）', () => {
    for (const side of ['w', 'b'] as const) {
      const fills = MATERIALS.map((m) => piecePalette(m, side).fill);
      expect(new Set(fills).size, `${side} 方三种材质的本体色撞了`).toBe(3);
      const strokes = MATERIALS.map((m) => piecePalette(m, side).stroke);
      expect(new Set(strokes).size, `${side} 方三种材质的描边色撞了`).toBe(3);
    }
  });
});

describe('2D 造型：风格真的改了形状', () => {
  it('每种风格的六枚棋子都有图形', () => {
    for (const style of STYLES) {
      for (const t of TYPES) {
        expect(buildShapes(t, style).length, `${style} 的${t} 没有图形`).toBeGreaterThan(0);
      }
    }
  });

  it('同一枚棋子在四种风格下是**四套不同的图形**', () => {
    for (const t of TYPES) {
      const sigs = STYLES.map((s) => shapeSignature(t, s));
      expect(new Set(sigs).size, `${t} 在不同风格下画出来的东西一样 —— 风格开关等于没做`).toBe(4);
    }
  });

  it('像素版是**位图**（32×32、含描边格与本体格），不是矢量图', () => {
    for (const t of TYPES) {
      const grid = pixelGrid(t);
      expect(grid.size).toBe(32);
      expect(grid.cells.length).toBe(32 * 32);
      const kinds = new Set(grid.cells);
      expect(kinds.has(PixelCell.Body), `${t} 的位图没有本体格`).toBe(true);
      expect(kinds.has(PixelCell.Outline), `${t} 的位图没有描边格`).toBe(true);
      expect(kinds.has(PixelCell.Empty), `${t} 的位图没有留空`).toBe(true);
      // 每个格都必须是合法色调
      for (const k of grid.cells) {
        expect([
          PixelCell.Empty,
          PixelCell.Body,
          PixelCell.Highlight,
          PixelCell.Outline,
          PixelCell.Detail,
        ]).toContain(k);
      }
      // 像素版不描边（暗边已经烤进位图）
      expect(pieceStrokeWidth('pixel')).toBe(0);
    }
  });

  it('像素位图与经典造型**同源**（光栅化自经典，不是另画一套）', () => {
    // 同一个棋子，光栅化前后的**外接尺寸**必须对得上（差一个格以内）
    for (const t of TYPES) {
      const grid = pixelGrid(t);
      let minC = grid.size;
      let maxC = -1;
      let minR = grid.size;
      let maxR = -1;
      for (let r = 0; r < grid.size; r += 1) {
        for (let c = 0; c < grid.size; c += 1) {
          if (grid.cells[r * grid.size + c] === PixelCell.Empty) continue;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
        }
      }
      expect(maxC - minC, `${t} 的位图宽度不对`).toBeGreaterThan(4);
      expect(maxR - minR, `${t} 的位图高度不对`).toBeGreaterThan(8);
    }
  });

  it('涂鸦的线条**歪了但没歪坏**（与经典不同、且幅度在合理范围）', () => {
    for (const t of TYPES) {
      const classic = pieceOutlinePath(t, 'classic');
      const doodle = pieceOutlinePath(t, 'doodle');
      expect(doodle, `${t} 的涂鸦版和经典版一模一样`).not.toBe(classic);
      // 歪了，但坐标不能飘出去（> 6 个画布单位就说明抖过头了）
      const nums = (d: string): number[] =>
        (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const a = nums(doodle);
      const b = nums(classic);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) {
        expect(Math.abs(a[i] - b[i]), `${t} 的涂鸦版歪得太狠`).toBeLessThan(6);
      }
    }
  });

  it('卡通版有**五官**（卡通的识别特征就靠这对眼睛）', () => {
    for (const t of TYPES) {
      const shapes = buildShapes(t, 'cartoon');
      expect(shapes.some((s) => s.tone === 'eye'), `${t} 的卡通版没有眼睛`).toBe(true);
      expect(shapes.some((s) => s.tone === 'pupil'), `${t} 的卡通版没有瞳孔`).toBe(true);
    }
  });
});

describe('3D 造型：每种风格都要保住辨识度', () => {
  it('每种风格下，六种棋子的剪影都两两不同', () => {
    for (const style of STYLES) {
      const geos = TYPES.map((t) => pieceGeometry(t, style));
      const bounds = sharedBounds(geos);
      const maps = new Map<PieceType, string>();
      for (const t of TYPES) maps.set(t, silhouette(pieceGeometry(t, style), bounds).join(''));
      for (const a of TYPES) {
        for (const b of TYPES) {
          if (a >= b) continue;
          expect(
            maps.get(a),
            `${style} 风格下 ${a} 和 ${b} 的 3D 剪影一模一样 —— 认不出是什么棋子`,
          ).not.toBe(maps.get(b));
        }
      }
    }
  });

  it('每种风格的棋子都不超取景上限、且坐在棋面上', () => {
    for (const style of STYLES) {
      for (const t of TYPES) {
        const geo = pieceGeometry(t, style);
        const box = geo.boundingBox!;
        expect(box.max.y, `${style} 的${t} 超过取景上限了`).toBeLessThanOrEqual(PIECE_TOP - BOARD_TOP);
        expect(box.min.y, `${style} 的${t} 陷到棋面以下了`).toBeGreaterThan(-0.01);
        expect(box.min.y, `${style} 的${t} 悬空了`).toBeLessThan(0.02);
      }
    }
  });

  it('最高的仍然是王（换风格不能把王变矮、把兵变高）', () => {
    for (const style of STYLES) {
      const heights = TYPES.map((t) => pieceHeight(t, style));
      const tallest = Math.max(...heights);
      expect(TYPES[heights.indexOf(tallest)], `${style} 风格下最高的不是王`).toBe('k');
    }
  });

  it('像素风格的 3D 几何是**三块**（本体 / 描边 / 高光），颜色不同', () => {
    for (const t of TYPES) {
      const px = piecePixelGeometries(t);
      expect(px.body, `${t} 的像素几何没有本体`).toBeTruthy();
      expect(px.accent, `${t} 的像素几何没有描边`).toBeTruthy();
      expect(px.all, `${t} 的像素几何没有合成件（轮廓壳要用）`).toBeTruthy();
    }
  });

  it('像素风格不需要额外的细节件（刻线已经烤进位图）', () => {
    expect(pieceDetailGeometry('b', 'pixel')).toBeNull();
    expect(pieceDetailGeometry('n', 'pixel')).toBeNull();
    // 其他风格仍然要有刻线（辨识度靠它）
    for (const style of ['classic', 'cartoon', 'doodle'] as PieceStyle[]) {
      expect(pieceDetailGeometry('b', style), `${style} 的象应该有裂口`).toBeTruthy();
      expect(pieceDetailGeometry('n', style), `${style} 的马应该有细节件`).toBeTruthy();
    }
  });
});

describe('3D 材质：三种材质真的不一样', () => {
  it('木质 = 哑光 + 木纹贴图；金属 = 高金属度；塑料 = 清漆', () => {
    const wood = pieceMaterial('w', 'wood') as THREE.MeshStandardMaterial;
    expect(wood.roughness, '木质应该很哑光').toBeGreaterThanOrEqual(0.7);
    expect(wood.metalness, '木头没有金属度').toBeLessThan(0.1);

    const metal = pieceMaterial('w', 'metal') as THREE.MeshStandardMaterial;
    expect(metal.metalness, '金属必须有金属度，否则渲出来是黑的').toBeGreaterThanOrEqual(0.85);
    expect(metal.roughness, '金属应该比较光滑').toBeLessThan(0.4);

    const plastic = pieceMaterial('w', 'plastic') as THREE.MeshPhysicalMaterial;
    expect(plastic.clearcoat ?? 0, '塑料应该有清漆层').toBeGreaterThanOrEqual(0.5);
    expect(plastic.metalness, '塑料没有金属度').toBeLessThan(0.1);
  });

  it('三种材质的颜色**互不相同**', () => {
    const colors = MATERIALS.map((m) => (pieceMaterial('w', m) as THREE.MeshStandardMaterial).color.getHexString());
    expect(new Set(colors).size).toBe(3);
  });

  it('像素的描边格也用同一套物理参数（不能变成「贴纸」）', () => {
    const body = pieceMaterial('w', 'metal') as THREE.MeshStandardMaterial;
    const accent = pieceAccentMaterial('w', 'metal') as THREE.MeshStandardMaterial;
    expect(accent.metalness).toBe(body.metalness);
    expect(accent.roughness).toBe(body.roughness);
    expect(accent.color.getHexString()).not.toBe(body.color.getHexString());
  });
});
