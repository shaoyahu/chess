'use client';

/**
 * **摆棋用的棋盘** —— 自由练习的「自己摆放双方棋子」阶段。
 *
 * 为什么单独一个组件，而不是给 `Board2D` 加一个「摆棋模式」：
 *   `Board2D` 的语义是「走棋」—— 它的每一格都会去问引擎「这格能不能走」，
 *   而摆棋阶段要问的是「这格现在放什么」—— 两者是**相反**的问题。
 *   硬塞进一个组件里，条件分支会糊在渲染路径上（走子 / 摆子 / 高亮 / 箭头）。
 *   这里只复用 `Board2D` 的**外观**（同一套 CSS class），语义各自干净。
 *
 * 摆法的事实来源是 `Placement`（格 → 棋子），不是 FEN：
 *   摆到一半的局面可能缺王，而 FEN 是被 chess.js 严格校验的格式（见 lib/practice/setup.ts）。
 */
import { useMemo } from 'react';
import { PieceGlyph } from './PieceGlyph';
import { getWoodTexture } from '@/lib/woodTexture';
import { getBoardTheme, type BoardTheme } from '@/lib/board-themes';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import { squareToIndex } from '@/hooks/useBoardInteraction';
import type { Placement } from '@/lib/practice/setup';

export interface SetupBoardProps {
  /** 摆法表 */
  placement: Placement;
  /** 点一格做什么（由上层决定：放子 / 拿走） */
  onSquareClick: (square: string) => void;
  /** 棋盘朝向（true = 黑方视角） */
  flipped: boolean;
  /** 棋盘配色主题 */
  theme?: BoardTheme;
  /** 棋子风格 */
  pieceStyle?: PieceStyle;
  /** 棋子材质 */
  pieceMaterial?: PieceMaterial;
}

export function SetupBoard({
  placement,
  onSquareClick,
  flipped,
  theme,
  pieceStyle = 'classic',
  pieceMaterial = 'wood',
}: SetupBoardProps) {
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

  /** 64 个格子（显示坐标 → 格名） */
  const squares = useMemo(() => {
    const list: Array<{ square: string; col: number; row: number }> = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const fileIndex = flipped ? 7 - col : col;
        const rankNumber = flipped ? row + 1 : 8 - row;
        list.push({
          square: `${String.fromCharCode(97 + fileIndex)}${rankNumber}`,
          col,
          row,
        });
      }
    }
    return list;
  }, [flipped]);

  /** 棋子按显示坐标摆位 */
  const pieces = useMemo(() => {
    const list: Array<{ square: string; type: string; color: 'w' | 'b'; col: number; row: number }> = [];
    for (const [square, piece] of placement) {
      const { col, row } = squareToIndex(square);
      list.push({
        square,
        type: piece.type,
        color: piece.color,
        col: flipped ? 7 - col : col,
        row: flipped ? 7 - row : row,
      });
    }
    return list;
  }, [placement, flipped]);

  return (
    <div className="board-frame" style={boardStyle}>
      <div className="board2d">
        {squares.map(({ square, col, row }) => {
          const { col: _c, row: _r } = squareToIndex(square);
          const isLight = (_c + _r) % 2 === 0;
          return (
            <div
              key={square}
              data-square={square}
              className={`square ${isLight ? 'light' : 'dark'} clickable`}
              style={{
                gridColumn: col + 1,
                gridRow: row + 1,
                ['--tex-pos' as string]: `${(col * 37) % 100}% ${(row * 53) % 100}%`,
              }}
              onClick={() => onSquareClick(square)}
            >
              {row === 7 && (
                <span className="coord file">
                  {String.fromCharCode(97 + (flipped ? 7 - col : col))}
                </span>
              )}
              {col === 0 && <span className="coord rank">{flipped ? row + 1 : 8 - row}</span>}
            </div>
          );
        })}

        <div className="piece-layer">
          {pieces.map((piece) => (
            <div
              key={piece.square}
              className={`piece ${piece.color}`}
              style={{
                left: `${piece.col * 12.5}%`,
                top: `${piece.row * 12.5}%`,
              }}
            >
              <PieceGlyph
                type={piece.type as Parameters<typeof PieceGlyph>[0]['type']}
                color={piece.color}
                size={70}
                style={pieceStyle}
                material={pieceMaterial}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SetupBoard;
