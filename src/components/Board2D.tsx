'use client';

/**
 * 2D 棋盘 —— 正交俯视，棋子用 SVG 绘制，位移过渡实现走子动画。
 *
 * 视角（R4）：
 *  - 白方：白棋在下，rank 8 在顶部。
 *  - 黑方：整个棋盘 180° 翻转，黑棋在下。
 *  - 观战：默认白方视角，可手动翻转。
 *
 * 2D 用户看到的是「格子之间平移」；3D 用户看到的是「立体移动」。
 * 两者消费同一份 FEN，落点完全一致。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { PieceGlyph } from './PieceGlyph';
import { getWoodTexture } from '@/lib/woodTexture';
import { getBoardTheme, type BoardTheme } from '@/lib/board-themes';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import { arrowPolygon, ARROW_2D } from '@/lib/moveArrow';
import { squareUnderPiece } from '@/lib/dragGeometry';
import { useTrackedPieces } from '@/hooks/useTrackedPieces';
import { displayCol, displayRow, squareToIndex } from '@/hooks/useBoardInteraction';
import type { BoardInteraction } from '@/hooks/useBoardInteraction';

/**
 * 「拖」与「点」的分界：指针移动超过这么多像素才算拖动。
 *
 * 小于这个距离就当是普通点击 —— 手指/鼠标轻微抖动不该把棋子弹出去。
 */
const DRAG_THRESHOLD = 4;

export interface Board2DProps {
  fen: string;
  interaction: BoardInteraction;
  /** 观战者可以自由翻转视角 */
  allowFlip?: boolean;
  /** 外部控制翻转 */
  flipped?: boolean;
  onFlipToggle?: () => void;
  /**
   * 上一步走子（起点 → 终点）。
   *
   * 由房间页从服务端的走子记录里取，**不在棋盘内部算** ——
   * 这样 2D / 3D 切换、或中途才进房的人，看到的箭头都是同一根。
   */
  lastMove?: { from: string; to: string } | null;
  /** 棋盘配色主题（设置里选） */
  theme?: BoardTheme;
  /**
   * 推荐下一步（辅助下棋）—— 蓝色指引箭头。
   * 与「上一步的走子箭头」是两回事，所以单独一条。
   */
  hintMove?: { from: string; to: string } | null;
  /**
   * **走错的那一手**（起点 → 终点）—— 起止两格标红。
   *
   * 残局关卡用：走错了要**当场看得见**，
   * 光在面板上写一句「这步不对」不够，得标在棋子上。
   */
  wrongMove?: { from: string; to: string } | null;
  /** 棋子风格（造型语言） */
  pieceStyle?: PieceStyle;
  /** 棋子材质（表面表现） */
  pieceMaterial?: PieceMaterial;
}

export function Board2D({
  fen,
  interaction,
  allowFlip = false,
  flipped,
  onFlipToggle,
  lastMove = null,
  theme,
  hintMove = null,
  wrongMove = null,
  pieceStyle = 'classic',
  pieceMaterial = 'wood',
}: Board2DProps) {
  const { orientation, selected, targetMap, onSquareClick, isMyTurn } = interaction;
  /** 拖拽相关（与 `selected` 分开，见 useBoardInteraction 的注释） */
  const { dragFrom, dragTargetMap } = interaction;
  // 用稳定 id 追踪棋子，保证走子时是「移动」而不是「瞬移」
  const pieces = useTrackedPieces(fen);

  // 观战者可以手动翻转（与自己的执子颜色无关）
  const effectiveOrientation: 'w' | 'b' =
    flipped !== undefined ? (flipped ? 'b' : 'w') : orientation;

  /* ------------------------------------------------------------------ */
  /* 拖拽走子                                                            */
  /* ------------------------------------------------------------------ */
  /** 棋盘内容区（8×8 网格）—— 用来把屏幕坐标换算成格子 */
  const boardRef = useRef<HTMLDivElement>(null);
  /** 正在按下的棋子（还没超过拖动阈值） */
  const pendingRef = useRef<{ square: string; x: number; y: number; dx: number; dy: number } | null>(
    null,
  );
  /** 这次按下到底算不算「拖」 */
  const dragMovedRef = useRef(false);
  /** 按下的那一格能不能起拖（按下时判一次，别在每次移动里反复问引擎） */
  const draggableRef = useRef(false);
  /** 拖完之后要吞掉的下一个 click（拖动的收尾动作不该再触发一次点选） */
  const suppressClickRef = useRef(false);
  /** 拖动中的棋子与指针位移 */
  const [drag, setDrag] = useState<{ from: string; dx: number; dy: number } | null>(null);
  /** interaction 的最新引用（window 事件回调里要用，不能闭包住旧值） */
  const interactionRef = useRef(interaction);
  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const p = pendingRef.current;
      if (!p) return;
      if (!draggableRef.current) return; // 这一格不能拖 → 始终当普通点击
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!dragMovedRef.current) {
        // 还没超过阈值 → 还算「点」，别急着把棋子拽走
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        /*
         * 超过阈值 → **此刻才真的起拖**。
         *
         * 起拖之前不动 `dragFrom`，是为了不出现这种闪烁：
         *   按下（显示落点提示）→ 松手（提示消失）→ click（提示又出现）
         * 也就是「点一下棋子，落点提示会闪一下」。
         * 规则统一成：**动了才算拖，没动就是点**。
         */
        interactionRef.current.beginDrag(p.square);
        dragMovedRef.current = true;
      }
      p.dx = dx;
      p.dy = dy;
      setDrag({ from: p.square, dx, dy });
    };

    /**
     * 结束一次拖动。
     *
     * @param commit true = 正常松手（按落点走子）；false = 手势被取消（**不走子**）。
     *
     * 为什么要有 commit 这个开关：
     *   `pointercancel` 是浏览器**取消**了这次手势（比如系统接管了触摸），
     *   这时候松手的位置**不代表**玩家的意图 —— 照着它走子就是乱走。
     */
    const finish = (commit: boolean): void => {
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      const moved = dragMovedRef.current;
      dragMovedRef.current = false;
      draggableRef.current = false;
      if (!moved) {
        // 没拖动 → 什么都不用做，剩下的交给 click（点选流程原样保留）
        return;
      }
      /*
       * 落点 = **棋子中心**所在的格（不是光标所在的格）。
       *
       * 抓着棋子边角拖动时，光标和棋子中心差着半格；
       * 按光标判定会「棋子看着在 A 格、却下到 B 格」。
       * 规则统一成：**看到棋子在哪，就下到哪**（3D 同一条）。
       */
      const el = boardRef.current;
      const square = el
        ? squareUnderPiece(
            el.getBoundingClientRect(),
            displayCol(p.square, effectiveOrientation),
            displayRow(p.square, effectiveOrientation),
            p.dx,
            p.dy,
            effectiveOrientation,
          )
        : null;
      setDrag(null);
      // 拖完不要再触发一次点选：松手之后浏览器还会派发 click
      // （被取消的手势不会派发 click，所以不用吞）
      suppressClickRef.current = commit;
      interactionRef.current.endDrag(commit ? square : null);
    };

    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [effectiveOrientation]);

  /*
   * 吞掉「拖完之后那一下 click」。
   *
   * 浏览器在 pointerup 之后还会派发一次 click（pointerdown / pointerup 在同一个元素上时）。
   * 那一下 click 会走到格子的 onClick → 走「点选」流程 → 刚拖完的棋子又被选中。
   * 所以在 **window 捕获阶段**拦一次：拦住就不会走到格子的处理器，
   * 而且这一次拦完就复位，下一次正常点击不受影响。
   */
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  /** 按下某一格：自己的子且有合法着 → 允许起拖（起拖与否要等移动超过阈值） */
  const onPointerDown = (square: string, e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return; // 只认左键
    pendingRef.current = { square, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    dragMovedRef.current = false;
    // 不是自己的子 / 没有合法着 → 走原来的点选流程
    draggableRef.current = interactionRef.current.canDragFrom(square);
  };

  /*
   * 棋盘配色主题。
   *
   * 默认是**纯色**方块（`--wood-*: none`）——
   * 原来叠着木纹贴图，格子看上去不是纯色、深浅还会随纹理起伏。
   * 想看木纹的话在设置里切到「胡桃木纹」主题。
   */
  const activeTheme = useMemo(() => theme ?? getBoardTheme(undefined), [theme]);
  const boardStyle = useMemo(
    () =>
      ({
        '--bg-board-light': activeTheme.light,
        '--bg-board-dark': activeTheme.dark,
        '--board-frame': activeTheme.frame,
        '--wood-light': activeTheme.wood ? `url(${getWoodTexture('light')})` : 'none',
        '--wood-dark': activeTheme.wood ? `url(${getWoodTexture('dark')})` : 'none',
      }) as React.CSSProperties,
    [activeTheme],
  );

  // 被将军的王：红色高亮
  const checkedKing = useMemo(() => {
    try {
      const game = new Chess(fen);
      if (!game.inCheck()) return null;
      const turn = game.turn();
      const board = game.board();
      for (const row of board) {
        for (const cell of row) {
          if (cell && cell.type === 'k' && cell.color === turn) return cell.square;
        }
      }
      return null;
    } catch {
      return null;
    }
  }, [fen]);

  const squares = useMemo(() => {
    const list: Array<{ square: string; col: number; row: number }> = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        // 从显示坐标反推真实格名
        const fileIndex = effectiveOrientation === 'w' ? col : 7 - col;
        const rankNumber = effectiveOrientation === 'w' ? 8 - row : row + 1;
        const fileChar = String.fromCharCode(97 + fileIndex);
        list.push({ square: `${fileChar}${rankNumber}`, col, row });
      }
    }
    return list;
  }, [effectiveOrientation]);

  /**
   * 上一步的走子箭头（棋盘单位：一个 viewBox 单位 = 一格）。
   *
   * 起点是棋子**原来**待的格（走完就空了），箭头尖落在**现在**待的格心 ——
   * 一根箭头同时说明「谁走的」和「走到哪」。
   *
   * 2D 不用退尖端（ARROW_2D.tipInset = 0）：2D 棋子是侧视剪影，
   * 美术只占格子 ~28% 宽、底座还压在格子底部，**格心是空的** ——
   * 箭尖正好落在终点格心，完全露在外面。
   */
  const arrowPoints = useMemo(() => {
    if (!lastMove) return null;
    const poly = arrowPolygon(
      {
        x: displayCol(lastMove.from, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.from, effectiveOrientation) + 0.5,
      },
      {
        x: displayCol(lastMove.to, effectiveOrientation) + 0.5,
        y: displayRow(lastMove.to, effectiveOrientation) + 0.5,
      },
      ARROW_2D,
    );
    return poly.length ? poly : null;
  }, [lastMove, effectiveOrientation]);

  /**
   * 推荐下一步的**指引箭头**（辅助下棋）。
   *
   * 几何与「上一步走子箭头」完全一样，只是换了个颜色（蓝）、
   * 单独一层 SVG —— 两者可以同时出现，颜色一深一浅不会看混。
   */
  const hintPoints = useMemo(() => {
    if (!hintMove) return null;
    const poly = arrowPolygon(
      {
        x: displayCol(hintMove.from, effectiveOrientation) + 0.5,
        y: displayRow(hintMove.from, effectiveOrientation) + 0.5,
      },
      {
        x: displayCol(hintMove.to, effectiveOrientation) + 0.5,
        y: displayRow(hintMove.to, effectiveOrientation) + 0.5,
      },
      ARROW_2D,
    );
    return poly.length ? poly : null;
  }, [hintMove, effectiveOrientation]);

  return (
    <div className="board-frame" style={boardStyle}>
      <div className="board2d" ref={boardRef}>
        {squares.map(({ square, col, row }) => {
          const { col: _c, row: _r } = squareToIndex(square);
          const isLight = (_c + _r) % 2 === 0;
          /*
           * 拖动时的落点提示走**拖动的那枚棋子**的合法着，
           * 点选时的提示走 `selected` 的合法着 ——
           * 两者不能同时显示（旧选中的提示会跟新拖动的提示混在一起）。
           */
          const shownTargets = dragFrom ? dragTargetMap : targetMap;
          const isTarget = shownTargets.has(square);
          const target = shownTargets.get(square);
          // 原格在拖动时也高亮 —— 让人知道「是从这儿拿起来的」
          const isSelected = selected === square || dragFrom === square;
          const isLast = lastMove?.from === square || lastMove?.to === square;
          const isWrong = wrongMove?.from === square || wrongMove?.to === square;
          const isChecked = checkedKing === square;
          const canClick = isMyTurn || Boolean(target);

          return (
            <div
              key={square}
              data-square={square}
              className={[
                'square',
                isLight ? 'light' : 'dark',
                canClick ? 'clickable' : '',
                isLast ? 'lastmove' : '',
                isWrong ? 'wrongmove' : '',
                isChecked ? 'checked' : '',
                isSelected ? 'selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                gridColumn: col + 1,
                gridRow: row + 1,
                // 每格取不同的木纹偏移，避免整块棋盘出现重复纹理
                ['--tex-pos' as string]: `${(col * 37) % 100}% ${(row * 53) % 100}%`,
              }}
              onPointerDown={(e) => onPointerDown(square, e)}
              onClick={() => onSquareClick(square)}
            >
              {/* 坐标标注：只在最外圈显示 */}
              {row === 7 && (
                <span className="coord file">
                  {String.fromCharCode(97 + (effectiveOrientation === 'w' ? col : 7 - col))}
                </span>
              )}
              {col === 0 && (
                <span className="coord rank">
                  {effectiveOrientation === 'w' ? 8 - row : row + 1}
                </span>
              )}

              {/* 合法落点提示 */}
              {isTarget && !target?.capture && <span className="hint-dot" />}
              {isTarget && target?.capture && <span className="hint-ring" />}
            </div>
          );
        })}

        {/*
          走子箭头：**垫在棋子下面**（z-index 1，棋子层是 2）——
          箭头不遮挡棋子，棋子压在箭头上的那截正好指向它的来路。
        */}
        {arrowPoints && (
          <svg
            className="move-arrow"
            viewBox="0 0 8 8"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon points={arrowPoints.map(([x, y]) => `${x},${y}`).join(' ')} />
          </svg>
        )}

        {/* 推荐下一步的指引箭头（蓝色，辅助下棋） */}
        {hintPoints && (
          <svg
            className="hint-arrow"
            viewBox="0 0 8 8"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon points={hintPoints.map(([x, y]) => `${x},${y}`).join(' ')} />
          </svg>
        )}

        {/* 棋子层：绝对定位，走子时用 CSS transition 平移 */}
        <div className="piece-layer">
          {pieces.map((piece) => {
            const col = displayCol(piece.square, effectiveOrientation);
            const row = displayRow(piece.square, effectiveOrientation);
            /*
             * 拖动中的棋子：跟着指针走。
             *
             * 位移就是「指针从按下点移动了多远」——
             * 这样抓棋子时的那点偏移会**原样保留**（抓着左上角就一直是左上角，
             * 棋子不会突然跳到鼠标中心）。
             * 原格因此自然空出来。
             */
            const dragging = drag && drag.from === piece.square ? drag : null;
            return (
              <div
                key={piece.id}
                className={`piece ${piece.color}${dragging ? ' dragging' : ''}`}
                style={{
                  left: `${col * 12.5}%`,
                  top: `${row * 12.5}%`,
                  transform: dragging ? `translate(${dragging.dx}px, ${dragging.dy}px)` : undefined,
                }}
              >
                <PieceGlyph
                  type={piece.type}
                  color={piece.color}
                  size={70}
                  style={pieceStyle}
                  material={pieceMaterial}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
