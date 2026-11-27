'use client';

/**
 * 棋盘交互逻辑 —— 2D 与 3D 共用同一套语义。
 *
 * 关键点（R4）：
 *  - 视角由「自己执什么颜色」决定，白方看白棋在下，黑方看黑棋在下。
 *  - 选子 → 高亮合法落点；点合法落点 → 发起走子。
 *  - 升变：兵到底线时弹出选择（后/车/象/马）。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { legalTargets, pieceAt, type LegalTarget } from '@/lib/chess-engine';
import { freeTargets } from '@/lib/replay';
import type { Color, PieceType, RoomState } from '@/lib/types';

/** 坐标变换：棋盘格 ↔ 屏幕位置 */
export function squareToIndex(square: string): { col: number; row: number } {
  const file = square.charCodeAt(0) - 97; // a=0
  const rank = Number(square[1]); // 1..8
  return { col: file, row: 8 - rank }; // row 0 = rank 8
}

export interface BoardInteraction {
  /** 视图朝向：白方或黑方 */
  orientation: Orientation;
  /** 当前选中的格子 */
  selected: string | null;
  /** 合法落点 */
  targets: LegalTarget[];
  /** 目标格集合（便于查表） */
  targetMap: Map<string, LegalTarget>;
  /** 选中格是否有合法着 */
  canMoveSelected: boolean;
  /** 点击某个格子 */
  onSquareClick: (square: string) => void;
  /** 取消选择 */
  clearSelection: () => void;
  /** 是否轮到我走 */
  isMyTurn: boolean;
  /** 我的颜色 */
  myColor: Color | undefined;
  /** 待确认的升变（兵到底线） */
  pendingPromotion: { from: string; to: string } | null;
  /** 选择升变棋子 */
  choosePromotion: (piece: 'q' | 'r' | 'b' | 'n') => void;
  /** 取消升变 */
  cancelPromotion: () => void;
  /** 正在被拖动的原格（null = 没在拖） */
  dragFrom: string | null;
  /** 拖动过程中的合法落点（用来高亮「能落到哪」） */
  dragTargets: LegalTarget[];
  /** 拖动目标格集合（便于查表） */
  dragTargetMap: Map<string, LegalTarget>;
  /** 这一格能不能起拖（自己的子 + 至少有一个合法着） */
  canDragFrom: (square: string) => boolean;
  /** 开始拖动；不能拖就返回 false */
  beginDrag: (square: string) => boolean;
  /** 结束拖动：落在合法落点就走子，否则什么都不做（棋子弹回原位） */
  endDrag: (square: string | null) => void;
}

export type Orientation = 'w' | 'b';

export interface UseBoardInteractionOptions {
  room: RoomState | null;
  myColor: Color | undefined;
  /** 发起走子 */
  onMove: (from: string, to: string, promotion?: PieceType) => void;
  /**
   * **复盘（自由走棋）模式**。
   *
   * 传了它，棋盘就用**复盘的局面**（而不是房间的 FEN），
   * 而且**双方棋子都能动** —— 不受「轮到谁走」的限制。
   *
   * 传 null = 正常对局，规则不变。
   *
   * `onlyColor` 限定「只有这一方的子能动」——
   * 残局关卡用得到：玩家只走自己的子，对手那手由题库自动走掉。
   */
  free?: { fen: string; onlyColor?: Color } | null;
}

export function useBoardInteraction({
  room,
  myColor,
  onMove,
  free = null,
}: UseBoardInteractionOptions): BoardInteraction {
  const [selected, setSelected] = useState<string | null>(null);
  /** 升变选择：{from, to} */
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  /**
   * 正在被拖动的原格。
   *
   * **和 `selected` 分开** —— 两者语义不同：
   *   - `selected` 是「点选」出来的状态（点一下选中、再点一下取消）；
   *   - `dragFrom` 是「按住拖」出来的状态（松手就结束）。
   * 用同一个量表达两件事，就会出现「拖完顺手把选中的也取消了」。
   */
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  /** 拖动原格的镜像（给 DOM 事件回调用，避免闭包读到旧值） */
  const dragFromRef = useRef<string | null>(null);

  const orientation: Orientation = myColor ?? 'w';
  const turn = room ? (room.fen.split(' ')[1] === 'b' ? 'b' : 'w') : 'w';
  /*
   * 复盘模式：局面是复盘给的，**双方的子都能动**。
   *
   * `isMyTurn` 在这里表示「棋盘接不接输入」——
   * 2D 棋盘用它决定格子可不可点（见 Board2D 的 canClick）。
   * 复盘里没有「轮到谁走」这回事，所以直接给 true。
   */
  const freeFen = free?.fen ?? null;
  /** 复盘模式下只允许这一方动子（残局关卡用；不限定就是双方都能动） */
  const freeOnlyColor = free?.onlyColor ?? null;
  const isFree = freeFen !== null;
  const isMyTurn = isFree
    ? true
    : Boolean(myColor && turn === myColor && room?.status === 'playing');

  /**
   * 复盘模式下某一格的合法落点。
   *
   * `onlyColor` 存在时，**对方的子一律不能动**（落点直接给空）——
   * 残局关卡里玩家只走自己的子，对手那手由题库自动走。
   */
  const freeTargetsOf = useCallback(
    (square: string): LegalTarget[] => {
      if (freeFen === null) return [];
      const targets = freeTargets(freeFen, square);
      if (!freeOnlyColor) return targets;
      const piece = pieceAt(freeFen, square);
      if (!piece || piece.color !== freeOnlyColor) return [];
      return targets;
    },
    [freeFen, freeOnlyColor],
  );

  /** 这一格的合法落点（复盘模式下**不区分是哪一方的子**） */
  const targetsOf = useCallback(
    (square: string): LegalTarget[] => {
      if (freeFen !== null) return freeTargetsOf(square);
      if (!room || !myColor || !isMyTurn) return [];
      return legalTargets(room.fen, square, myColor);
    },
    [freeFen, freeOnlyColor, room, myColor, isMyTurn, freeTargetsOf],
  );

  const targets = useMemo(() => {
    if (!selected) return [];
    return targetsOf(selected);
  }, [selected, targetsOf]);

  const targetMap = useMemo(() => {
    const map = new Map<string, LegalTarget>();
    for (const t of targets) map.set(t.to, t);
    return map;
  }, [targets]);

  /** 拖动过程中的合法落点（跟 `targets` 同源，只是触发条件不同） */
  const dragTargets = useMemo(() => {
    if (!dragFrom) return [];
    return targetsOf(dragFrom);
  }, [dragFrom, targetsOf]);

  const dragTargetMap = useMemo(() => {
    const map = new Map<string, LegalTarget>();
    for (const t of dragTargets) map.set(t.to, t);
    return map;
  }, [dragTargets]);

  /** 这一格能不能起拖 —— 规则跟「点选」完全一样：自己的子 + 至少有一个合法着 */
  const canDragFrom = useCallback(
    (square: string) => {
      if (freeFen !== null) return freeTargetsOf(square).length > 0;
      if (!room || !myColor || !isMyTurn) return false;
      return legalTargets(room.fen, square, myColor).length > 0;
    },
    [freeFen, freeTargetsOf, room, myColor, isMyTurn],
  );

  /** 开始拖动 */
  const beginDrag = useCallback(
    (square: string) => {
      if (!canDragFrom(square)) return false;
      dragFromRef.current = square;
      setDragFrom(square);
      return true;
    },
    [canDragFrom],
  );

  /**
   * 真正走子 —— 「点击流」与「拖拽流」共用这一段。
   *
   * 两条路必须走**同一套**判定与升变处理，
   * 否则就会出现「点得动、拖不动」或者「拖过去能吃，点过去不能吃」这种分裂。
   */
  const commitMove = useCallback(
    (from: string, target: LegalTarget) => {
      if (target.promotionRequired) {
        // 兵到底线：等玩家选升变棋子
        setPendingPromotion({ from, to: target.to });
        setSelected(null);
        return;
      }
      onMove(from, target.to);
      setSelected(null);
    },
    [onMove],
  );

  /** 结束拖动：落在合法落点就走子，否则不动 */
  const endDrag = useCallback(
    (square: string | null) => {
      const from = dragFromRef.current;
      dragFromRef.current = null;
      setDragFrom(null);
      if (!from || !square) return;
      const target = dragTargetMap.get(square);
      if (!target) return; // 非法落点 → 什么都不做，棋子弹回原位
      commitMove(from, target);
    },
    [dragTargetMap, commitMove],
  );

  const onSquareClick = useCallback(
    (square: string) => {
      /*
       * 复盘（自由走棋）：**双方的棋子都能点**。
       *
       * 规则跟正常对局一样（选中 → 点合法落点 → 走子），
       * 只是不限制「只能点自己的子」。
       */
      if (freeFen !== null) {
        const target = targetMap.get(square);
        if (selected && target) {
          commitMove(selected, target);
          return;
        }
        if (freeTargetsOf(square).length > 0) {
          setSelected((prev) => (prev === square ? null : square));
          return;
        }
        setSelected(null);
        return;
      }

      if (!room || !myColor || !isMyTurn) return;

      // 点已选中的合法落点 → 走子
      const target = targetMap.get(square);
      if (selected && target) {
        commitMove(selected, target);
        return;
      }

      // 点自己的棋子 → 选中（或取消）
      const piece = legalTargets(room.fen, square, myColor);
      if (piece.length > 0) {
        setSelected((prev) => (prev === square ? null : square));
        return;
      }

      // 点空处 → 取消选择
      setSelected(null);
    },
    [freeFen, freeTargetsOf, room, myColor, isMyTurn, targetMap, selected, commitMove],
  );

  /** 确认升变棋子 */
  const choosePromotion = useCallback(
    (piece: 'q' | 'r' | 'b' | 'n') => {
      if (!pendingPromotion) return;
      onMove(pendingPromotion.from, pendingPromotion.to, piece);
      setPendingPromotion(null);
    },
    [pendingPromotion, onMove],
  );

  const cancelPromotion = useCallback(() => setPendingPromotion(null), []);

  return {
    orientation,
    selected,
    targets,
    targetMap,
    canMoveSelected: targets.length > 0,
    onSquareClick,
    clearSelection: () => setSelected(null),
    isMyTurn,
    myColor,
    pendingPromotion,
    choosePromotion,
    cancelPromotion,
    dragFrom,
    dragTargets,
    dragTargetMap,
    canDragFrom,
    beginDrag,
    endDrag,
  };
}

/** 视角变换后的显示坐标：白方 col=file, 黑方 col=7-file */
export function displayCol(square: string, orientation: Orientation): number {
  const { col } = squareToIndex(square);
  return orientation === 'w' ? col : 7 - col;
}

/** 视角变换后的显示行：白方 row=0 在上，黑方翻转 */
export function displayRow(square: string, orientation: Orientation): number {
  const { row } = squareToIndex(square);
  return orientation === 'w' ? row : 7 - row;
}
