'use client';

/**
 * 棋子身份追踪 —— React 包装层。
 *
 * 真正的逻辑在 `@/lib/pieceTracker`（纯函数，可单测），这里只负责把
 * FEN 的变化接到 React state 上。
 */
import { useEffect, useRef, useState } from 'react';
import { applyMove, buildFromFen, type TrackedPiece } from '@/lib/pieceTracker';

export type { TrackedPiece } from '@/lib/pieceTracker';

export function useTrackedPieces(fen: string): TrackedPiece[] {
  const [pieces, setPieces] = useState<TrackedPiece[]>(() => buildFromFen(fen));
  const prevFen = useRef(fen);

  useEffect(() => {
    if (prevFen.current === fen) return;
    const before = prevFen.current;
    prevFen.current = fen;

    setPieces((current) => {
      const updated = applyMove(current, before, fen);
      // 追踪失败（局面突变 / 重开 / 和棋重置）→ 整体重建
      return updated ?? buildFromFen(fen);
    });
  }, [fen]);

  return pieces;
}
