'use client';

import { PieceGlyph } from '@/components/PieceGlyph';
import { PIECE_STYLES, PIECE_MATERIALS } from '@/lib/piece-appearance';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

/**
 * 自产棋子素材页 —— /pieces
 *
 * 上排是**落盘的静态素材**（public/pieces/*.svg，由 `npm run assets:pieces` 生成），
 * 下排是棋盘实际使用的**内联渲染**（Board2D 里的 PieceGlyph）。
 *
 * 现在棋子有**两条轴**（风格 × 材质），所以这一页是**矩阵**：
 *   ① 静态素材（默认：经典 + 木质）
 *   ② 四种风格 × 六枚棋子
 *   ③ 三种材质 × 六枚棋子
 *
 * 静态素材与内联渲染共用同一个组件，**不可能漂移**。
 */

const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const NAMES: Record<PieceType, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

function Swatch({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: bg, borderRadius: 10, padding: 8, textAlign: 'center' }}>
      {children}
    </div>
  );
}

function StyleRow({
  style,
  material,
}: {
  style: PieceStyle;
  material: PieceMaterial;
}) {
  return (
    <>
      {TYPES.map((t) => (
        <Swatch key={`sw-${style}-${t}`} bg="#e8d5b0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/pieces/style/${style}/${t}-w.svg`} width={96} height={96} alt={`${NAMES[t]} · 经典风格`} />
          <div style={{ color: '#3a352f', fontSize: 12 }}>{NAMES[t]}</div>
        </Swatch>
      ))}
      {TYPES.map((t) => (
        <Swatch key={`sb-${style}-${t}`} bg="#a97c50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/pieces/style/${style}/${t}-b.svg`} width={96} height={96} alt={`${NAMES[t]} · 经典风格`} />
          <div style={{ color: '#f6f3ed', fontSize: 12 }}>{NAMES[t]}</div>
        </Swatch>
      ))}
    </>
  );
}

export default function PiecesPage() {
  return (
    <div style={{ padding: 30, background: '#f2efe9', minHeight: '100vh' }}>
      <h2 style={{ color: '#241f19', marginBottom: 6 }}>自产棋子素材</h2>
      <p style={{ color: '#5d554b', fontSize: 13, marginBottom: 24 }}>
        全部由本项目几何分层构造并自动生成（<code>npm run assets:pieces</code>），未使用任何第三方素材。
      </p>

      <h3 style={{ color: '#5d554b', fontSize: 14, marginBottom: 12 }}>
        ① 落盘素材 public/pieces/*.svg（经典 + 木质）
      </h3>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        {TYPES.map((t) => (
          <Swatch key={`fw-${t}`} bg="#e8d5b0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/pieces/${t}-w.svg`} width={110} height={110} alt={`白方${NAMES[t]}`} />
            <div style={{ color: '#3a352f', fontSize: 12 }}>{NAMES[t]} · 白</div>
          </Swatch>
        ))}
        {TYPES.map((t) => (
          <Swatch key={`fb-${t}`} bg="#a97c50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/pieces/${t}-b.svg`} width={110} height={110} alt={`黑方${NAMES[t]}`} />
            <div style={{ color: '#f6f3ed', fontSize: 12 }}>{NAMES[t]} · 黑</div>
          </Swatch>
        ))}
      </div>

      <h3 style={{ color: '#5d554b', fontSize: 14, margin: '28px 0 12px' }}>
        ② 四种风格（材质统一木质）
      </h3>
      {PIECE_STYLES.map((s) => (
        <div key={s.id} style={{ marginBottom: 18 }}>
          <div style={{ color: '#241f19', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {s.label}
            <span style={{ color: '#7a7168', fontWeight: 400, marginLeft: 8 }}>{s.note}</span>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <StyleRow style={s.id} material="wood" />
          </div>
        </div>
      ))}

      <h3 style={{ color: '#5d554b', fontSize: 14, margin: '28px 0 12px' }}>
        ③ 三种材质（造型统一经典）
      </h3>
      {PIECE_MATERIALS.map((m) => (
        <div key={m.id} style={{ marginBottom: 18 }}>
          <div style={{ color: '#241f19', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {m.label}
            <span style={{ color: '#7a7168', fontWeight: 400, marginLeft: 8 }}>{m.note}</span>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <StyleRow style="classic" material={m.id} />
          </div>
        </div>
      ))}

      <h3 style={{ color: '#5d554b', fontSize: 14, margin: '28px 0 12px' }}>
        ④ 棋盘实际渲染（内联 SVG，48px = 棋盘上的真实显示尺寸）
      </h3>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {TYPES.map((t) => (
          <Swatch key={`iw-${t}`} bg="#e8d5b0">
            <PieceGlyph type={t} color="w" size={48} />
          </Swatch>
        ))}
        {TYPES.map((t) => (
          <Swatch key={`ib-${t}`} bg="#a97c50">
            <PieceGlyph type={t} color="b" size={48} />
          </Swatch>
        ))}
      </div>
    </div>
  );
}
