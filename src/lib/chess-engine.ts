/**
 * 棋规引擎封装 —— 客户端与服务端**同源**共用。
 *
 * 唯一裁判是 chess.js (BSD-2-Clause)。本模块只做两件事：
 *  1. 把 chess.js 的 API 包装成对 UI 友好的结构（合法落点、走子记录、终局判定）；
 *  2. 在客户端仅用于「显示提示」，在服务端用于「权威裁决」。
 *
 * 客户端即使被篡改也无法改变服务端接受的着法，因为服务端会用自己的 Chess 实例重放校验。
 */
import { Chess, SQUARES, type Move } from 'chess.js';
import { START_FEN } from './constants';
import type { Color, GameResult, MoveRecord, PieceType, ResultReason } from './types';

/** chess.js 的 Square 类型是字面量联合，这里做安全转换 */
function toSquare(square: string): (typeof SQUARES)[number] {
  const found = SQUARES.find((s) => s === square);
  if (!found) throw new Error(`非法格名: ${square}`);
  return found;
}

/** 一个候选落点 */
export interface LegalTarget {
  to: string;
  /** 该落点为吃子 */
  capture: boolean;
  /** 被吃的棋子类型 */
  capturedPiece?: PieceType;
  /** 该落点是否需要升变（兵到底线） */
  promotionRequired: boolean;
  /** SAN 记谱 */
  san: string;
}

/** 终局状态 */
export interface StatusInfo {
  over: boolean;
  /** 当前局面 FEN（原地不动） */
  result?: GameResult;
  /** 当前方是否被将军 */
  inCheck: boolean;
  /** 可用升变棋子（升变时非空） */
  promotionPieces: PieceType[];
}

export class IllegalMoveError extends Error {
  constructor(message = '非法着法') {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

/** 校验 FEN 是否合法 */
export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

/** 创建引擎实例 */
export function createGame(fen: string = START_FEN): Chess {
  return new Chess(fen);
}

/**
 * 某个格子上的所有合法落点。
 * @param fen 当前局面
 * @param square 起点，如 'e2'
 * @param forColor 只返回该颜色棋子可走的落点（默认当前走子方）
 */
export function legalTargets(fen: string, square: string, forColor?: Color): LegalTarget[] {
  const game = new Chess(fen);
  let sq: (typeof SQUARES)[number];
  try {
    sq = toSquare(square);
  } catch {
    return [];
  }
  const piece = game.get(sq);
  if (!piece) return [];
  if (forColor && piece.color !== forColor) return [];
  if (forColor && forColor !== game.turn()) return [];

  const moves = game.moves({ square: sq, verbose: true }) as Move[];
  return moves.map((m) => ({
    to: m.to,
    capture: Boolean(m.captured),
    capturedPiece: m.captured,
    promotionRequired: Boolean(m.promotion),
    san: m.san,
  }));
}

/** 棋盘上全部合法着（AI 与验证用） */
export function allLegalMoves(fen: string): LegalTarget[] {
  const game = new Chess(fen);
  const moves = game.moves({ verbose: true }) as Move[];
  return moves.map((m) => ({
    to: m.to,
    capture: Boolean(m.captured),
    capturedPiece: m.captured,
    promotionRequired: Boolean(m.promotion),
    san: m.san,
  }));
}

/** 走子输入 */
export interface MoveInput {
  from: string;
  to: string;
  promotion?: PieceType;
}

/** 走子结果 */
export interface MoveOutcome {
  fen: string;
  san: string;
  record: Omit<MoveRecord, 'ts'>;
  /** 走完后是否升变 */
  promoted: boolean;
}

/**
 * 在**已有的** Chess 实例上执行一次走子（**权威校验**）。
 *
 * 为什么要有这个「带实例」的版本：
 *   `chess.js` 的三次重复局面检测靠的是**实例内部维护的局面出现次数**，
 *   而这个计数是**走子历史**的产物 —— 只拿一个当前 FEN 新建实例，
 *   历史就丢了，`isThreefoldRepetition()` 恒为 false。
 *   所以服务端必须持有一个**活着的** Chess 实例（见 room-manager 的 `room.game`），
 *   走子、悔棋都在同一个实例上做，重复局面的计数才不会断。
 */
export function applyMoveToGame(game: Chess, input: MoveInput): MoveOutcome {
  let move: Move;
  try {
    move = game.move({
      from: input.from,
      to: input.to,
      // 未指定升变棋子时默认后（后是绝大多数局面下的最优选择）
      promotion: input.promotion ?? 'q',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IllegalMoveError(msg || '非法着法');
  }

  const record: Omit<MoveRecord, 'ts'> = {
    from: move.from,
    to: move.to,
    piece: move.piece,
    color: move.color,
    san: move.san,
    captured: move.captured,
    promotion: move.promotion,
    flags: move.flags,
  };

  return { fen: game.fen(), san: move.san, record, promoted: Boolean(move.promotion) };
}

/**
 * 执行一次走子（**权威校验**）。非法着法抛 IllegalMoveError。
 *
 * 纯函数版本：自己新建实例，所以**只能**用当前 FEN 判断合法性，
 * 检测不了三次重复（那需要历史）。服务端请用 `applyMoveToGame`。
 */
export function applyMove(fen: string, input: MoveInput): MoveOutcome {
  return applyMoveToGame(new Chess(fen), input);
}

/** 不改变局面地检测某步是否合法 */
export function isLegalMove(fen: string, input: MoveInput): boolean {
  try {
    applyMove(fen, input);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断局面是否终局
 *
 * @param fen 当前局面（必须与 `liveGame` 对应的局面一致）
 * @param liveGame **可选**的活实例。传了就用它的历史来判三次重复 ——
 *   只传 FEN 的话，`new Chess(fen)` 没有任何历史，三次重复永远判不出来。
 */
export function statusOf(fen: string, liveGame?: Chess): StatusInfo {
  const game = liveGame ?? new Chess(fen);
  const inCheck = game.inCheck();

  if (game.isCheckmate()) {
    // 被将死的一方输，胜方是当前走子方的对手
    const loser = game.turn();
    const winner: Color = loser === 'w' ? 'b' : 'w';
    return { over: true, inCheck, result: { winner, reason: 'checkmate' }, promotionPieces: [] };
  }
  if (game.isStalemate()) {
    return { over: true, inCheck, result: { winner: 'draw', reason: 'stalemate' }, promotionPieces: [] };
  }
  if (game.isInsufficientMaterial()) {
    return { over: true, inCheck, result: { winner: 'draw', reason: 'material' }, promotionPieces: [] };
  }
  if (game.isThreefoldRepetition()) {
    return { over: true, inCheck, result: { winner: 'draw', reason: 'threefold' }, promotionPieces: [] };
  }
  if (game.isDrawByFiftyMoves()) {
    return { over: true, inCheck, result: { winner: 'draw', reason: 'fifty' }, promotionPieces: [] };
  }
  if (game.isDraw()) {
    return { over: true, inCheck, result: { winner: 'draw', reason: 'draw' }, promotionPieces: [] };
  }

  return { over: false, inCheck, promotionPieces: [] };
}

/** 当前走子方 */
export function turnOf(fen: string): Color {
  return new Chess(fen).turn();
}

/** 某方是否正被将军 */
export function isChecked(fen: string, color?: Color): boolean {
  const game = new Chess(fen);
  if (color) {
    // isAttacked(target, attackedBy) 语义：传入对方颜色，检查该方是否攻击了目标
    const kingSquare = findKingSquare(game.board(), color);
    if (!kingSquare) return false;
    const opponent: Color = color === 'w' ? 'b' : 'w';
    return game.isAttacked(toSquare(kingSquare), opponent);
  }
  return game.inCheck();
}

/** 在棋盘快照中找某方国王所在格 */
export function findKingSquare(
  board: ({ square: string; type: string; color: string } | null)[][],
  color: Color,
): string | null {
  for (const row of board) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

/** 某个格子上的棋子（UI 用） */
export function pieceAt(
  fen: string,
  square: string,
): { type: PieceType; color: Color } | null {
  let sq: (typeof SQUARES)[number];
  try {
    sq = toSquare(square);
  } catch {
    return null;
  }
  const piece = new Chess(fen).get(sq);
  if (!piece) return null;
  return { type: piece.type as PieceType, color: piece.color as Color };
}

/** FEN 中的走子方（第 2 个字段） */
export function fenTurn(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** 依据 FEN 差分推导出一次走子的可视化信息，供 2D/3D 做动画 */
export interface MoveVisual {
  from: string;
  to: string;
  piece: PieceType;
  color: Color;
  captured?: PieceType;
  /** 被吃的棋子**原来所在的格子**（吃子时 = to；吃过路兵时是另一个消失格） */
  capturedSquare?: string;
  promotion?: PieceType;
  /** 是否为王车易位（rook 也移动了） */
  rookFrom?: string;
  rookTo?: string;
}

/**
 * 从 FEN 序列差分出一手棋的可视化信息。
 * @param before 走子前 FEN
 * @param after  走子后 FEN
 */
export function diffMove(before: string, after: string): MoveVisual | null {
  const b = new Chess(before);
  const a = new Chess(after);
  const bMap = new Map<string, { type: string; color: string }>();
  const aMap = new Map<string, { type: string; color: string }>();
  for (const row of b.board()) for (const c of row) if (c) bMap.set(c.square, c);
  for (const row of a.board()) for (const c of row) if (c) aMap.set(c.square, c);

  /** 棋子消失的格（走子起点，或被吃掉的棋子） */
  const disappeared: string[] = [];
  for (const sq of bMap.keys()) if (!aMap.has(sq)) disappeared.push(sq);
  /** 新出现棋子的格（走子终点，原本为空） */
  const appeared: string[] = [];
  for (const sq of aMap.keys()) if (!bMap.has(sq)) appeared.push(sq);
  /** 前后都有棋子但类型/颜色不同（吃子：目标格被换成了自己的棋子） */
  const changed: string[] = [];
  for (const sq of bMap.keys()) {
    const after = aMap.get(sq);
    if (!after) continue;
    const beforePiece = bMap.get(sq)!;
    if (after.type !== beforePiece.type || after.color !== beforePiece.color) changed.push(sq);
  }

  // 王车易位：2 移 2（王 + 车）
  if (disappeared.length === 2 && appeared.length === 2) {
    const kingFrom = disappeared.find((sq) => bMap.get(sq)!.type === 'k');
    const kingTo = appeared.find((sq) => aMap.get(sq)!.type === 'k');
    const rookFrom = disappeared.find((sq) => bMap.get(sq)!.type === 'r');
    const rookTo = appeared.find((sq) => aMap.get(sq)!.type === 'r');
    if (kingFrom && kingTo && rookFrom && rookTo) {
      return {
        from: kingFrom,
        to: kingTo,
        piece: 'k',
        color: bMap.get(kingFrom)!.color as Color,
        rookFrom,
        rookTo,
      };
    }
  }

  // 终点：优先取「新出现」；吃子时目标格前后都有棋，取「类型变了」的格
  const to = appeared.length === 1 ? appeared[0] : changed.length === 1 ? changed[0] : null;
  if (!to) return null;
  const landed = aMap.get(to);
  if (!landed) return null;

  // 起点：消失格中，颜色与落子棋子相同的那一个
  // （升变时类型会变，所以按颜色匹配而不是类型）
  let from = disappeared.find((sq) => bMap.get(sq)!.color === landed.color);
  if (!from) from = disappeared[0];
  if (!from) return null;

  // 被吃的棋子：吃子时是目标格原来的棋子；吃过路兵时是另一个消失格
  let captured: PieceType | undefined;
  let capturedSquare: string | undefined;
  if (changed.includes(to)) {
    captured = bMap.get(to)!.type as PieceType;
    capturedSquare = to;
  } else {
    const other = disappeared.find((sq) => sq !== from);
    if (other) {
      captured = bMap.get(other)!.type as PieceType;
      capturedSquare = other;
    }
  }

  const movedType = bMap.get(from)!.type as PieceType;
  const promotion =
    movedType === 'p' && landed.type !== 'p' ? (landed.type as PieceType) : undefined;

  return {
    from,
    to,
    piece: landed.type as PieceType,
    color: landed.color as Color,
    captured,
    capturedSquare,
    promotion,
  };
}

/** 结果文案 */
export function describeResult(result: GameResult): string {
  const map: Record<ResultReason, string> = {
    checkmate: '将死',
    stalemate: '逼和（僵局）',
    resign: '认输',
    timeout: '超时',
    draw: '和棋',
    material: '子力不足',
    fifty: '五十回合规则',
    threefold: '三次重复局面',
    abandon: '对手离开',
  };
  if (result.winner === 'draw') return `和棋 · ${map[result.reason]}`;
  const who = result.winner === 'w' ? '白方胜利' : '黑方胜利';
  return `${who} · ${map[result.reason]}`;
}
