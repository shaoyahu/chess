/**
 * 棋子外观对照表 —— 把 **4 种风格 × 3 种材质 × 6 枚棋子** 渲染成一张 HTML。
 *
 * 为什么要有这个脚本：
 *   风格与材质是**正交**的，组合有 12 种；再加 6 枚棋子、黑白两方，
 *   一次要核对的东西太多，靠翻棋盘一格一格看根本看不过来。
 *   这张表把 2D 的实际渲染结果**平铺**出来，一眼就能看出：
 *     ① 哪种风格在 48px 下还认得出棋子；
 *     ② 材质的高光/木纹有没有溢出棋子轮廓；
 *     ③ 黑白两方在浅格 / 深格上是否都读得出。
 *
 * 它渲染的是 **PieceGlyph 本体**（不是另画一遍），
 * 所以这张表和棋盘上的东西**一定是同一份**。
 *
 * ⚠️ 必须**一次性渲染整棵树**（一个 React 根）：
 *   PieceGlyph 里的剪裁 / 渐变 id 来自 useId，
 *   而 useId 是**按 React 根**编号的 ——
 *   分多次 renderToStaticMarkup 会让每一根都从 R0 开始，
 *   于是几十枚棋子共用同一个 clipPath，材质层会串到别的棋子身上
 *   （表现为「排线飘到棋子外面」这种怪现象）。
 *
 * 用法：npm run preview:appearance
 *   → artifacts/piece-appearance/index.html  （对照表，64px）
 *   → artifacts/piece-appearance/detail.html （细节，128px）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PieceGlyph } from '@/components/PieceGlyph';
import { PIECE_STYLES, PIECE_MATERIALS } from '@/lib/piece-appearance';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

const OUT_DIR = join(process.cwd(), 'artifacts', 'piece-appearance');
const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];

/** 棋盘的浅格 / 深格色 —— 棋子真正的落脚点 */
const LIGHT = '#e8d5b0';
const DARK = '#a97c50';

function cell(
  style: PieceStyle,
  material: PieceMaterial,
  type: PieceType,
  color: 'w' | 'b',
  size: number,
): ReactElement {
  return createElement(
    'div',
    { className: 'cell', key: `${style}-${material}-${type}-${color}` },
    createElement(
      'div',
      { className: `board ${color === 'w' ? 'light' : 'dark'}` },
      createElement(PieceGlyph, { type, color, size, style, material }),
    ),
  );
}

function row(
  label: string,
  style: PieceStyle,
  material: PieceMaterial,
  size: number,
): ReactElement {
  return createElement(
    'div',
    { className: 'row', key: `${label}` },
    createElement('div', { className: 'row-label' }, label),
    createElement(
      'div',
      { className: 'cells' },
      ...TYPES.map((t) => cell(style, material, t, 'w', size)),
      ...TYPES.map((t) => cell(style, material, t, 'b', size)),
    ),
  );
}

function page(title: string, sub: string, body: ReactElement, size: number): string {
  /*
   * ⚠️ 整页内容**只渲染一次**：
   *   PieceGlyph 的剪裁 / 渐变 id 来自 useId，而 useId 是**按 React 根**编号的。
   *   分多次渲染 → 每根都从 R0 开始 → 几十枚棋子共用一个 clipPath，
   *   材质层会串到别的棋子身上（排线会飘到棋子外面）。
   */
  const bodyHtml = renderToStaticMarkup(body);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { margin: 0; padding: 24px; background: #f2efe9; color: #241f19;
         font-family: -apple-system, "PingFang SC", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5d554b; font-size: 13px; margin-bottom: 20px; }
  h2 { font-size: 15px; margin: 22px 0 10px; }
  h2 small { font-weight: 400; color: #5d554b; margin-left: 10px; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .row-label { flex: 0 0 ${size === 64 ? 56 : 130}px; font-size: 13px; font-weight: 600; }
  .cells { display: flex; gap: ${size === 64 ? 6 : 8}px; flex-wrap: wrap; }
  .board { width: ${size + 4}px; height: ${size + 4}px; display: flex; align-items: center;
           justify-content: center; border-radius: 6px; overflow: hidden; }
  .board.light { background: ${LIGHT}; }
  .board.dark { background: ${DARK}; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="sub">${sub}</div>
${bodyHtml}
</body>
</html>`;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  /*
   * 一次性渲染整棵 React 树 → useId 唯一 → 剪裁 / 渐变不会串。
   */
  const overviewRows: ReactElement[] = [];
  for (const material of PIECE_MATERIALS) {
    overviewRows.push(
      createElement(
        'section',
        { key: material.id },
        createElement(
          'h2',
          null,
          `材质：${material.label}`,
          createElement('small', null, material.note),
        ),
        ...PIECE_STYLES.map((s) => row(s.label, s.id, material.id, 64)),
      ),
    );
  }
  const overview = createElement(
    'div',
    null,
    ...overviewRows.map((r) => createElement('div', { key: String(r.key) }, r)),
  );
  writeFileSync(
    join(OUT_DIR, 'index.html'),
    page(
      '棋子外观对照表',
      '4 种风格 × 3 种材质 × 6 枚棋子 × 黑白两方 —— 渲染的是 PieceGlyph 本体',
      overview,
      64,
    ),
    'utf8',
  );

  const detailRows: ReactElement[] = [];
  for (const style of PIECE_STYLES) {
    for (const material of PIECE_MATERIALS) {
      detailRows.push(row(`${style.label} · ${material.label}`, style.id, material.id, 128));
    }
  }
  const detail = createElement('div', null, ...detailRows);
  writeFileSync(
    join(OUT_DIR, 'detail.html'),
    page('棋子外观 · 细节（128px）', '放大看排线、五官这些细节', detail, 128),
    'utf8',
  );

  console.log('✓ 已生成 artifacts/piece-appearance/index.html');
  console.log('✓ 已生成 artifacts/piece-appearance/detail.html');
}

main();
