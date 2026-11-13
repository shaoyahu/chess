/**
 * 棋子身份追踪 —— **纯函数**版本（无 React 依赖，可直接单测）。
 *
 * 为什么需要：走子动画要求「同一个 DOM 节点 / 同一个 three.js 对象」从旧格移动到新格。
 * 如果每次都用格子名当 key，走子时 React 会销毁旧节点、创建新节点，
 * 过渡动画就不会发生（表现为「瞬移」而不是「移动」）。
 *
 * 做法：维护一份带稳定 id 的棋子列表，用 FEN 差分（diffMove）更新位置。
 * 为了绝对可靠，每次更新后会校验「追踪结果」与「实际棋盘」是否一致，
 * 不一致就整体重建（应对重开、和棋重置等局面突变）。
 *
 * 关键：**吃子时必须移除被吃的棋子**。
 * 否则目标格会出现两个子 → 一致性校验失败 → 整盘重建 → 所有 id 变化 →
 * 走子动画（尤其是吃子的移动动画）全部失效。
 */
import { Chess } from 'chess.js';
import { diffMove } from '@/lib/chess-engine';
import type { Color, PieceType } from '@/lib/types';

export interface TrackedPiece {
  /** 稳定 id，跨帧不变 */
  id: string;
  type: PieceType;
  color: Color;
  square: string;
}

let idCounter = 0;

/** 读出 FEN 上的全部棋子 */
export function readBoard(fen: string): Map<string, { type: PieceType; color: Color }> {
  const game = new Chess(fen);
  const map = new Map<string, { type: PieceType; color: Color }>();
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell) continue;
      map.set(cell.square, { type: cell.type as PieceType, color: cell.color as Color });
    }
  }
  return map;
}

/** 按 FEN 重建一份追踪表（id 全新） */
export function buildFromFen(fen: string): TrackedPiece[] {
  const board = readBoard(fen);
  const out: TrackedPiece[] = [];
  for (const [square, piece] of board) {
    idCounter += 1;
    out.push({ id: `p${idCounter}`, type: piece.type, color: piece.color, square });
  }
  return out;
}

/**
 * 把一次走子应用到追踪表上。
 *
 * @returns 更新后的追踪表；如果无法保证与真实棋盘一致，返回 null（调用方应整体重建）
 */
export function applyMove(
  current: TrackedPiece[],
  before: string,
  after: string,
): TrackedPiece[] | null {
  const board = readBoard(after);
  const diff = diffMove(before, after);

  let next: TrackedPiece[] = current.map((piece) => ({ ...piece }));

  if (diff) {
    // ① 吃子：先把被吃的子移除（否则目标格会有两个子，触发整体重建，动画失效）
    if (diff.capturedSquare) {
      next = next.filter(
        (p) => !(p.square === diff.capturedSquare && p.color !== diff.color),
      );
    }
    // ② 主棋子移动
    const mover = next.find((p) => p.square === diff.from);
    if (mover) {
      mover.square = diff.to;
      if (diff.promotion) mover.type = diff.promotion;
    }
    // ③ 王车易位时车也移动
    if (diff.rookFrom && diff.rookTo) {
      const rook = next.find((p) => p.square === diff.rookFrom);
      if (rook) rook.square = diff.rookTo;
    }
  }

  // ④ 一致性校验：追踪结果必须与真实棋盘完全一致
  const matched = new Map<string, { type: PieceType; color: Color }>();
  for (const piece of next) {
    // 同一格出现两个棋子说明追踪出错
    if (matched.has(piece.square)) return null;
    matched.set(piece.square, { type: piece.type, color: piece.color });
  }
  if (matched.size !== board.size) return null;
  for (const [square, piece] of board) {
    const tracked = matched.get(square);
    if (!tracked || tracked.type !== piece.type || tracked.color !== piece.color) {
      return null;
    }
  }
  return next;
}
