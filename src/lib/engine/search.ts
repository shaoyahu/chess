/**
 * 高性能国际象棋搜索引擎（纯同步、零额外依赖）。
 *
 * 为什么自己写一套棋盘表示，而不是直接用 chess.js 走子：
 *  - chess.js 每次 moves() 都要重建内部状态，实测节点率只有 ~1.8 万/秒，
 *    连深度 4 都跑不满时间预算，达不到「强力算法」的要求；
 *  - 这里用 0x88 邮箱棋盘 + 增量 Zobrist，节点率能到几十万/秒，
 *    才有余量做迭代加深 + 置换表 + 静态搜索（quiescence）。
 *
 * 引擎内部只保证「生成的着法与 chess.js 一致」（用 perft 对拍验证，见 tests/engine.test.ts），
 * 对外 API 层还会再用 chess.js 复核一次（见 analysis.ts），双保险。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 白方 = 0，黑方 = 1 */
export const WHITE = 0;
export const BLACK = 1;

/** 棋子类型（低 3 位） */
const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

/** 棋子码 = 类型 | (颜色 << 3)；低 3 位是类型，第 3 位是颜色位 */
const typeOf = (p: number): number => p & 7;
const colorOf = (p: number): number => (p >> 3) & 1;

/** 子力价值（厘兵）；王不参与子力统计 */
const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];

/** 走法编码（32 位整数，避免每个节点分配对象）
 *  bit 0-6   : from 格（0x88 索引）
 *  bit 7-13  : to 格
 *  bit 14-16 : 升变后的棋子类型（0 = 不升变）
 *  bit 17    : 吃子
 *  bit 18    : 吃过路兵
 *  bit 19    : 王车易位
 *  bit 20    : 兵两格推进（用于设置吃过路兵格）
 *  bit 21    : 升变
 *  bit 22-24 : 被吃棋子类型
 *  bit 25    : 被吃棋子是白子（1）/ 黑子（0）
 */
const F_CAPTURE = 1 << 17;
const F_EP = 1 << 18;
const F_CASTLE = 1 << 19;
const F_DOUBLE = 1 << 20;
const F_PROMO = 1 << 21;

function encodeMove(
  from: number,
  to: number,
  flags: number,
  promo: number,
  captured: number,
): number {
  // 各字段互不重叠：from/to 用 0-13 位，promo 用 14-16 位，flags 用 17-21 位
  return (
    (from & 0x7f) |
    ((to & 0x7f) << 7) |
    ((promo & 7) << 14) |
    (flags & 0x3e0000) |
    ((captured & 7) << 22) |
    (((captured >> 3) & 1) << 25)
  );
}

const moveFrom = (m: number): number => m & 0x7f;
const moveTo = (m: number): number => (m >> 7) & 0x7f;

/* ------------------------------------------------------------------ *
 * 0x88 棋盘
 * ------------------------------------------------------------------ */

/** 0x88 索引是否在棋盘内（同时防负数下标） */
function onBoard(sq: number): boolean {
  return sq >= 0 && sq < 128 && (sq & 0x88) === 0;
}

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];
const BISHOP_DIRS = [-17, -15, 15, 17];
const ROOK_DIRS = [-16, -1, 1, 16];
const QUEEN_DIRS = [-17, -16, -15, -1, 1, 15, 16, 17];

/** 王车易位权利位 */
const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

interface Position {
  board: Int8Array;
  turn: number;
  castling: number;
  /** 吃过路兵的目标格，-1 表示无 */
  ep: number;
  halfmove: number;
  fullmove: number;
  kingSq: Int32Array;
  h1: number;
  h2: number;
  /**
   * 增量维护的评估累加器（下标固定）：
   *  0/1 = 白/黑中局子力，2/3 = 白/黑中局 PST，
   *  4/5 = 白/黑残局子力，6/7 = 白/黑残局 PST，8 = 局面阶段
   * 有了它，「子力 + 位置权重」这部分评估就是 O(1)，可以做懒惰评估。
   */
  acc: Int32Array;
}

const FEN_PIECE: Record<string, number> = {
  p: PAWN,
  n: KNIGHT,
  b: BISHOP,
  r: ROOK,
  q: QUEEN,
  k: KING,
};

/** 解析 FEN；非法 FEN 直接抛错（由上层转成协议里的 error 字段） */
function parseFen(fen: string): Position {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error(`FEN 不完整: ${fen}`);
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error(`FEN 棋盘必须是 8 行: ${fen}`);

  const board = new Int8Array(128);
  for (let i = 0; i < 8; i++) {
    // FEN 第 1 行是第 8 横线；内部 rank 索引 0 = 第 1 横线
    const rank = 7 - i;
    let file = 0;
    for (const ch of rows[i]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      const type = FEN_PIECE[lower];
      if (!type) throw new Error(`FEN 含非法字符: ${ch}`);
      if (file > 7) throw new Error(`FEN 第 ${i + 1} 横线溢出: ${rows[i]}`);
      board[rank * 16 + file] = type | (ch === lower ? BLACK << 3 : WHITE << 3);
      file++;
    }
    if (file !== 8) throw new Error(`FEN 第 ${i + 1} 横线不是 8 格: ${rows[i]}`);
  }

  const turn = parts[1] === 'b' ? BLACK : WHITE;

  let castling = 0;
  for (const ch of parts[2]) {
    if (ch === 'K') castling |= CASTLE_WK;
    else if (ch === 'Q') castling |= CASTLE_WQ;
    else if (ch === 'k') castling |= CASTLE_BK;
    else if (ch === 'q') castling |= CASTLE_BQ;
  }

  let ep = -1;
  if (parts[3] && parts[3] !== '-') {
    const f = parts[3].charCodeAt(0) - 97;
    const r = Number(parts[3][1]) - 1;
    if (f >= 0 && f <= 7 && r >= 0 && r <= 7) ep = r * 16 + f;
  }

  const pos: Position = {
    board,
    turn,
    castling,
    ep,
    halfmove: parts[5] ? Number(parts[5]) || 0 : 0,
    fullmove: parts[6] ? Number(parts[6]) || 0 : 1,
    kingSq: new Int32Array(2),
    h1: 0,
    h2: 0,
    acc: new Int32Array(9),
  };

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = rank * 16 + file;
      if (board[sq] === (KING | (WHITE << 3))) pos.kingSq[WHITE] = sq;
      if (board[sq] === (KING | (BLACK << 3))) pos.kingSq[BLACK] = sq;
    }
  }
  if (pos.kingSq[WHITE] < 0 || pos.kingSq[BLACK] < 0) {
    throw new Error('FEN 缺少国王');
  }

  computeHash(pos);
  computeAccumulators(pos);
  return pos;
}

/* ------------------------------------------------------------------ *
 * 增量评估累加器（子力 + 位置权重 + 阶段）
 * ------------------------------------------------------------------ */

/** 某个棋子在位置权重表里的下标（白方看第 8 横线为第 0 行） */
function pstIndex(color: number, sq: number): number {
  const rank = sq >> 4;
  const file = sq & 7;
  return color === WHITE ? (7 - rank) * 8 + file : rank * 8 + (7 - file);
}

/** 棋子的阶段权重：马/象 1，车/后 2 */
function phaseOf(type: number): number {
  if (type === KNIGHT || type === BISHOP) return 1;
  if (type === ROOK || type === QUEEN) return 2;
  return 0;
}

/** 扫描一遍棋盘，把子力 / PST / 阶段累加器初始化好 */
function computeAccumulators(pos: Position): void {
  const acc = pos.acc;
  acc.fill(0);
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = rank * 16 + file;
      const piece = pos.board[sq];
      if (piece === 0) continue;
      const type = typeOf(piece);
      const color = colorOf(piece);
      const idx = pstIndex(color, sq);
      const base = color === WHITE ? 0 : 1;
      acc[base] += MG_VALUE[type];
      acc[base + 2] += MG_TABLE[type][idx];
      acc[base + 4] += EG_VALUE[type];
      acc[base + 6] += EG_TABLE[type][idx];
      acc[8] += phaseOf(type);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Zobrist 哈希（增量更新，配合置换表）
 * ------------------------------------------------------------------ */

/** 固定种子的 xorshift，保证同样的局面永远得到同样的哈希（便于复现） */
let rngState = 0x1a2b3c4d;
function nextRandom(): number {
  rngState ^= rngState << 13;
  rngState |= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState |= 0;
  return rngState;
}

/** 下标：棋子码 * 128 + 格 */
const Z1 = new Int32Array(16 * 128);
const Z2 = new Int32Array(16 * 128);
const Z_CASTLE1 = new Int32Array(16);
const Z_CASTLE2 = new Int32Array(16);
const Z_EP1 = new Int32Array(8);
const Z_EP2 = new Int32Array(8);
let Z_SIDE1 = 0;
let Z_SIDE2 = 0;

(function initZobrist(): void {
  for (let i = 0; i < Z1.length; i++) {
    Z1[i] = nextRandom();
    Z2[i] = nextRandom();
  }
  for (let i = 0; i < 16; i++) {
    Z_CASTLE1[i] = nextRandom();
    Z_CASTLE2[i] = nextRandom();
  }
  for (let i = 0; i < 8; i++) {
    Z_EP1[i] = nextRandom();
    Z_EP2[i] = nextRandom();
  }
  Z_SIDE1 = nextRandom();
  Z_SIDE2 = nextRandom();
})();

function xorPiece(pos: Position, sq: number, piece: number): void {
  const idx = piece * 128 + sq;
  pos.h1 ^= Z1[idx];
  pos.h2 ^= Z2[idx];
}

function computeHash(pos: Position): void {
  pos.h1 = 0;
  pos.h2 = 0;
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = rank * 16 + file;
      const p = pos.board[sq];
      if (p) xorPiece(pos, sq, p);
    }
  }
  pos.h1 ^= Z_CASTLE1[pos.castling];
  pos.h2 ^= Z_CASTLE2[pos.castling];
  if (pos.ep >= 0) {
    pos.h1 ^= Z_EP1[pos.ep & 7];
    pos.h2 ^= Z_EP2[pos.ep & 7];
  }
  if (pos.turn === BLACK) {
    pos.h1 ^= Z_SIDE1;
    pos.h2 ^= Z_SIDE2;
  }
}

/* ------------------------------------------------------------------ *
 * 攻击判定
 * ------------------------------------------------------------------ */

/** sq 是否被 byColor 方攻击 */
function isAttacked(pos: Position, sq: number, byColor: number): boolean {
  const board = pos.board;
  const file = sq & 7;
  const rank = sq >> 4;

  // 兵：白兵从下方斜吃（sq-17 是左邻兵、sq-15 是右邻兵），黑兵对称
  if (byColor === WHITE) {
    if (rank > 0) {
      if (file > 0 && board[sq - 17] === PAWN) return true;
      if (file < 7 && board[sq - 15] === PAWN) return true;
    }
  } else {
    if (rank < 7) {
      if (file > 0 && board[sq + 15] === (PAWN | (BLACK << 3))) return true;
      if (file < 7 && board[sq + 17] === (PAWN | (BLACK << 3))) return true;
    }
  }

  // 马
  const knightCode = KNIGHT | (byColor << 3);
  for (let i = 0; i < 8; i++) {
    const t = sq + KNIGHT_OFFSETS[i];
    if (onBoard(t) && board[t] === knightCode) return true;
  }

  // 王
  const kingCode = KING | (byColor << 3);
  for (let i = 0; i < 8; i++) {
    const t = sq + KING_OFFSETS[i];
    if (onBoard(t) && board[t] === kingCode) return true;
  }

  // 车 / 后（正交）
  for (let i = 0; i < 4; i++) {
    const d = ROOK_DIRS[i];
    let t = sq + d;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== 0) {
        if (colorOf(p) === byColor) {
          const t2 = typeOf(p);
          if (t2 === ROOK || t2 === QUEEN) return true;
        }
        break;
      }
      t += d;
    }
  }

  // 象 / 后（斜向）
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_DIRS[i];
    let t = sq + d;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== 0) {
        if (colorOf(p) === byColor) {
          const t2 = typeOf(p);
          if (t2 === BISHOP || t2 === QUEEN) return true;
        }
        break;
      }
      t += d;
    }
  }

  return false;
}

/** 当前走子方是否被将军 */
function inCheck(pos: Position): boolean {
  return isAttacked(pos, pos.kingSq[pos.turn], pos.turn ^ 1);
}

/* ------------------------------------------------------------------ *
 * 着法生成
 * ------------------------------------------------------------------ */

const MAX_PLY = 128;
const MOVES_PER_PLY = 320;

/** 每层着法缓冲（避免每个节点都分配数组） */
const MOVE_BUF = new Int32Array(MAX_PLY * MOVES_PER_PLY);
const SCORE_BUF = new Int32Array(MAX_PLY * MOVES_PER_PLY);

const PROMO_TYPES = [QUEEN, ROOK, BISHOP, KNIGHT];

function addPromotions(
  out: Int32Array,
  off: number,
  n: number,
  from: number,
  to: number,
  captured: number,
): number {
  for (const p of PROMO_TYPES) {
    out[off + n] = encodeMove(from, to, F_PROMO, p, captured);
    n++;
  }
  return n;
}

/**
 * 生成伪合法着法写入 out[off..]，返回数量。
 * capturesOnly = true 时只生成吃子（静态搜索用）。
 */
function genMoves(pos: Position, out: Int32Array, off: number, capturesOnly: boolean): number {
  const board = pos.board;
  const us = pos.turn;
  const them = us ^ 1;
  const ourBit = us << 3;
  const theirBit = them << 3;
  const promoRank = us === WHITE ? 7 : 0;
  const startRank = us === WHITE ? 1 : 6;
  const dir = us === WHITE ? 16 : -16;
  let n = 0;

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = rank * 16 + file;
      const piece = board[sq];
      if (piece === 0 || (piece & 8) !== ourBit) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        // 升变看的是「目标格所在横线」：白兵推到第 8 横线、黑兵推到第 1 横线
        const destPromoRank = us === WHITE ? rank + 1 : rank - 1;
        // 直进
        const one = sq + dir;
        if (!capturesOnly && board[one] === 0) {
          if (destPromoRank === promoRank) {
            n = addPromotions(out, off, n, sq, one, 0);
          } else {
            out[off + n] = encodeMove(sq, one, 0, 0, 0);
            n++;
            const two = sq + dir * 2;
            if (rank === startRank && board[two] === 0) {
              out[off + n] = encodeMove(sq, two, F_DOUBLE, 0, 0);
              n++;
            }
          }
        }
        // 斜吃 + 吃过路兵
        const c1 = file > 0 ? sq + dir - 1 : -1;
        const c2 = file < 7 ? sq + dir + 1 : -1;
        for (let k = 0; k < 2; k++) {
          const t = k === 0 ? c1 : c2;
          if (t < 0) continue;
          const tgt = board[t];
          if (tgt !== 0) {
            if ((tgt & 8) !== theirBit) continue;
            if (destPromoRank === promoRank) {
              n = addPromotions(out, off, n, sq, t, tgt);
            } else {
              out[off + n] = encodeMove(sq, t, F_CAPTURE, 0, tgt);
              n++;
            }
          } else if (t === pos.ep) {
            // 吃过路兵：被吃的兵在 sq + dir
            const captured = PAWN | (them << 3);
            out[off + n] = encodeMove(sq, t, F_CAPTURE | F_EP, 0, captured);
            n++;
          }
        }
      } else if (type === KNIGHT) {
        for (let i = 0; i < 8; i++) {
          const t = sq + KNIGHT_OFFSETS[i];
          if (!onBoard(t)) continue;
          const tgt = board[t];
          if (tgt === 0) {
            if (!capturesOnly) {
              out[off + n] = encodeMove(sq, t, 0, 0, 0);
              n++;
            }
          } else if ((tgt & 8) === theirBit) {
            out[off + n] = encodeMove(sq, t, F_CAPTURE, 0, tgt);
            n++;
          }
        }
      } else if (type === KING) {
        for (let i = 0; i < 8; i++) {
          const t = sq + KING_OFFSETS[i];
          if (!onBoard(t)) continue;
          const tgt = board[t];
          if (tgt === 0) {
            if (!capturesOnly) {
              out[off + n] = encodeMove(sq, t, 0, 0, 0);
              n++;
            }
          } else if ((tgt & 8) === theirBit) {
            out[off + n] = encodeMove(sq, t, F_CAPTURE, 0, tgt);
            n++;
          }
        }
      } else {
        const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : QUEEN_DIRS;
        for (let i = 0; i < dirs.length; i++) {
          const d = dirs[i];
          let t = sq + d;
          while (onBoard(t)) {
            const tgt = board[t];
            if (tgt === 0) {
              if (!capturesOnly) {
                out[off + n] = encodeMove(sq, t, 0, 0, 0);
                n++;
              }
            } else {
              if ((tgt & 8) === theirBit) {
                out[off + n] = encodeMove(sq, t, F_CAPTURE, 0, tgt);
                n++;
              }
              break;
            }
            t += d;
          }
        }
      }
    }
  }

  // 王车易位
  if (!capturesOnly) {
    if (us === WHITE) {
      if (
        (pos.castling & CASTLE_WK) !== 0 &&
        board[4] === (KING | (WHITE << 3)) &&
        board[7] === (ROOK | (WHITE << 3)) &&
        board[5] === 0 &&
        board[6] === 0 &&
        !isAttacked(pos, 4, BLACK) &&
        !isAttacked(pos, 5, BLACK) &&
        !isAttacked(pos, 6, BLACK)
      ) {
        out[off + n] = encodeMove(4, 6, F_CASTLE, 0, 0);
        n++;
      }
      if (
        (pos.castling & CASTLE_WQ) !== 0 &&
        board[4] === (KING | (WHITE << 3)) &&
        board[0] === (ROOK | (WHITE << 3)) &&
        board[1] === 0 &&
        board[2] === 0 &&
        board[3] === 0 &&
        !isAttacked(pos, 4, BLACK) &&
        !isAttacked(pos, 3, BLACK) &&
        !isAttacked(pos, 2, BLACK)
      ) {
        out[off + n] = encodeMove(4, 2, F_CASTLE, 0, 0);
        n++;
      }
    } else {
      if (
        (pos.castling & CASTLE_BK) !== 0 &&
        board[116] === (KING | (BLACK << 3)) &&
        board[119] === (ROOK | (BLACK << 3)) &&
        board[117] === 0 &&
        board[118] === 0 &&
        !isAttacked(pos, 116, WHITE) &&
        !isAttacked(pos, 117, WHITE) &&
        !isAttacked(pos, 118, WHITE)
      ) {
        out[off + n] = encodeMove(116, 118, F_CASTLE, 0, 0);
        n++;
      }
      if (
        (pos.castling & CASTLE_BQ) !== 0 &&
        board[116] === (KING | (BLACK << 3)) &&
        board[112] === (ROOK | (BLACK << 3)) &&
        board[113] === 0 &&
        board[114] === 0 &&
        board[115] === 0 &&
        !isAttacked(pos, 116, WHITE) &&
        !isAttacked(pos, 115, WHITE) &&
        !isAttacked(pos, 114, WHITE)
      ) {
        out[off + n] = encodeMove(116, 114, F_CASTLE, 0, 0);
        n++;
      }
    }
  }

  return n;
}

/* ------------------------------------------------------------------ *
 * 走子 / 悔子
 * ------------------------------------------------------------------ */

/** 撤销信息按层存放，避免每个节点分配对象 */
const UND_MOVE = new Int32Array(MAX_PLY);
const UND_FROM_PIECE = new Int32Array(MAX_PLY);
const UND_CAPTURED = new Int32Array(MAX_PLY);
const UND_CAPT_SQ = new Int32Array(MAX_PLY);
const UND_CASTLING = new Int32Array(MAX_PLY);
const UND_EP = new Int32Array(MAX_PLY);
const UND_HALF = new Int32Array(MAX_PLY);
const UND_KING = new Int32Array(MAX_PLY);
const UND_H1 = new Int32Array(MAX_PLY);
const UND_H2 = new Int32Array(MAX_PLY);
/** 撤销信息：评估累加器（每层 7 个） */
const UND_ACC = new Int32Array(MAX_PLY * 9);

/**
 * 执行走子。返回 false 表示走完之后自己的王被攻击（非法着法），
 * 此时棋盘已经被回滚，调用方可以直接跳过这个着法。
 */
function makeMove(pos: Position, m: number, ply: number): boolean {
  const board = pos.board;
  const from = moveFrom(m);
  const to = moveTo(m);
  const us = pos.turn;
  const them = us ^ 1;
  const piece = board[from];
  const type = typeOf(piece);

  UND_MOVE[ply] = m;
  UND_FROM_PIECE[ply] = piece;
  UND_CASTLING[ply] = pos.castling;
  UND_EP[ply] = pos.ep;
  UND_HALF[ply] = pos.halfmove;
  UND_KING[ply] = pos.kingSq[us];
  UND_H1[ply] = pos.h1;
  UND_H2[ply] = pos.h2;
  const acc = pos.acc;
  const accBase = ply * 9;
  for (let i = 0; i < 9; i++) UND_ACC[accBase + i] = acc[i];

  // 被吃棋子
  let captured = 0;
  let captSq = -1;
  if ((m & F_EP) !== 0) {
    captSq = us === WHITE ? to - 16 : to + 16;
    captured = PAWN | (them << 3);
  } else if (board[to] !== 0) {
    captured = board[to];
    captSq = to;
  }
  UND_CAPTURED[ply] = captured;
  UND_CAPT_SQ[ply] = captSq;

  // 哈希：移走原棋子 / 移入新棋子 / 拿走被吃棋子
  xorPiece(pos, from, piece);
  if (captSq >= 0) xorPiece(pos, captSq, captured);

  // 升变
  let placed = piece;
  if ((m & F_PROMO) !== 0) {
    placed = ((m >> 14) & 7) | (us << 3);
  }
  board[from] = 0;
  board[to] = placed;
  if (captSq >= 0 && captSq !== to) board[captSq] = 0;
  xorPiece(pos, to, placed);

  // 增量评估累加器：挪走 from 的棋子、放到 to 的棋子、拿走被吃棋子
  {
    const acc = pos.acc;
    const base = us === WHITE ? 0 : 1;
    const themBase = them === WHITE ? 0 : 1;
    const placedType = typeOf(placed);
    const fromIdx = pstIndex(us, from);
    const toIdx = pstIndex(us, to);
    acc[base] -= MG_VALUE[type];
    acc[base + 2] -= MG_TABLE[type][fromIdx];
    acc[base + 4] -= EG_VALUE[type];
    acc[base + 6] -= EG_TABLE[type][fromIdx];
    acc[base] += MG_VALUE[placedType];
    acc[base + 2] += MG_TABLE[placedType][toIdx];
    acc[base + 4] += EG_VALUE[placedType];
    acc[base + 6] += EG_TABLE[placedType][toIdx];
    acc[8] -= phaseOf(type);
    acc[8] += phaseOf(placedType);
    if (captSq >= 0) {
      const ct = typeOf(captured);
      const cIdx = pstIndex(them, captSq);
      acc[themBase] -= MG_VALUE[ct];
      acc[themBase + 2] -= MG_TABLE[ct][cIdx];
      acc[themBase + 4] -= EG_VALUE[ct];
      acc[themBase + 6] -= EG_TABLE[ct][cIdx];
      acc[8] -= phaseOf(ct);
    }
  }

  // 易位时同步挪车（王到 g1 = 长易位，王到 c1 = 短易位）
  if ((m & F_CASTLE) !== 0) {
    const acc = pos.acc;
    const base = us === WHITE ? 0 : 1;
    const rookCode = ROOK | (us << 3);
    let rookFrom = 0;
    let rookTo = 0;
    if (us === WHITE) {
      if (to === 6) {
        board[7] = 0;
        board[5] = ROOK | (WHITE << 3);
        xorPiece(pos, 7, ROOK | (WHITE << 3));
        xorPiece(pos, 5, ROOK | (WHITE << 3));
        rookFrom = 7;
        rookTo = 5;
      } else {
        board[0] = 0;
        board[3] = ROOK | (WHITE << 3);
        xorPiece(pos, 0, ROOK | (WHITE << 3));
        xorPiece(pos, 3, ROOK | (WHITE << 3));
        rookFrom = 0;
        rookTo = 3;
      }
    } else if (to === 118) {
      board[119] = 0;
      board[117] = ROOK | (BLACK << 3);
      xorPiece(pos, 119, ROOK | (BLACK << 3));
      xorPiece(pos, 117, ROOK | (BLACK << 3));
      rookFrom = 119;
      rookTo = 117;
    } else {
      board[112] = 0;
      board[115] = ROOK | (BLACK << 3);
      xorPiece(pos, 112, ROOK | (BLACK << 3));
      xorPiece(pos, 115, ROOK | (BLACK << 3));
      rookFrom = 112;
      rookTo = 115;
    }
    void rookCode;
    // 车换了格子：位置权重跟着调整（子力与阶段不变）
    acc[base + 2] += MG_TABLE[ROOK][pstIndex(us, rookTo)] - MG_TABLE[ROOK][pstIndex(us, rookFrom)];
    acc[base + 6] += EG_TABLE[ROOK][pstIndex(us, rookTo)] - EG_TABLE[ROOK][pstIndex(us, rookFrom)];
  }

  if (type === KING) pos.kingSq[us] = to;

  // 易位权利：国王动过 / 车动过 / 对方车被吃
  let castling = pos.castling;
  if (type === KING) castling &= us === WHITE ? ~CASTLE_WK & ~CASTLE_WQ : ~CASTLE_BK & ~CASTLE_BQ;
  else if (type === ROOK) {
    if (from === 7) castling &= ~CASTLE_WK;
    else if (from === 0) castling &= ~CASTLE_WQ;
    else if (from === 119) castling &= ~CASTLE_BK;
    else if (from === 112) castling &= ~CASTLE_BQ;
  }
  if (captSq >= 0) {
    if (captSq === 7) castling &= ~CASTLE_WK;
    else if (captSq === 0) castling &= ~CASTLE_WQ;
    else if (captSq === 119) castling &= ~CASTLE_BK;
    else if (captSq === 112) castling &= ~CASTLE_BQ;
  }
  if (castling !== pos.castling) {
    pos.h1 ^= Z_CASTLE1[pos.castling] ^ Z_CASTLE1[castling];
    pos.h2 ^= Z_CASTLE2[pos.castling] ^ Z_CASTLE2[castling];
    pos.castling = castling;
  }

  // 吃过路兵格
  const newEp = (m & F_DOUBLE) !== 0 ? (from + to) >> 1 : -1;
  if (pos.ep >= 0) {
    pos.h1 ^= Z_EP1[pos.ep & 7];
    pos.h2 ^= Z_EP2[pos.ep & 7];
  }
  pos.ep = newEp;
  if (newEp >= 0) {
    pos.h1 ^= Z_EP1[newEp & 7];
    pos.h2 ^= Z_EP2[newEp & 7];
  }

  // 半回合计数（和棋判定用）
  pos.halfmove = type === PAWN || captured !== 0 ? 0 : pos.halfmove + 1;

  // 换边
  pos.turn = them;
  pos.h1 ^= Z_SIDE1;
  pos.h2 ^= Z_SIDE2;

  // 合法性：走完之后自己的王不能被攻击
  if (isAttacked(pos, pos.kingSq[us], them)) {
    unmakeMove(pos, ply);
    return false;
  }
  return true;
}

/** 回滚一步走子 */
function unmakeMove(pos: Position, ply: number): void {
  const board = pos.board;
  const m = UND_MOVE[ply];
  const from = moveFrom(m);
  const to = moveTo(m);
  const us = pos.turn ^ 1;

  board[to] = 0;
  const captSq = UND_CAPT_SQ[ply];
  if (captSq >= 0) board[captSq] = UND_CAPTURED[ply];
  board[from] = UND_FROM_PIECE[ply];

  if ((m & F_CASTLE) !== 0) {
    if (us === WHITE) {
      if (to === 6) {
        board[5] = 0;
        board[7] = ROOK | (WHITE << 3);
      } else {
        board[3] = 0;
        board[0] = ROOK | (WHITE << 3);
      }
    } else if (to === 118) {
      board[117] = 0;
      board[119] = ROOK | (BLACK << 3);
    } else {
      board[115] = 0;
      board[112] = ROOK | (BLACK << 3);
    }
  }

  pos.kingSq[us] = UND_KING[ply];
  pos.castling = UND_CASTLING[ply];
  pos.ep = UND_EP[ply];
  pos.halfmove = UND_HALF[ply];
  pos.h1 = UND_H1[ply];
  pos.h2 = UND_H2[ply];
  pos.turn = us;
  // 评估累加器整体还原（易位挪车等复杂情况也就自动正确了）
  const accBase = ply * 9;
  for (let i = 0; i < 9; i++) pos.acc[i] = UND_ACC[accBase + i];
}

/* ------------------------------------------------------------------ *
 * 评估函数
 * ------------------------------------------------------------------ */

/**
 * 位置权重表：白方视角，第 0 行 = 第 8 横线。
 * 用「8 行 × 8 列」写，展开时校验必须是 64 项——
 * 手写扁平数组很容易少写一个，那会让评估函数算出 NaN，进而污染整棵搜索树。
 */
function flattenPst(name: string, rows: number[][]): number[] {
  const flat: number[] = [];
  for (const row of rows) flat.push(...row);
  if (flat.length !== 64) {
    throw new Error(`位置权重表 \${name} 长度应为 64，实际 \${flat.length}`);
  }
  return flat;
}

const MG_PAWN = flattenPst('MG_PAWN', [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 25, 25, 10, 5, 5],
  [0, 0, 0, 20, 20, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -20, -20, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
]);
const MG_KNIGHT = flattenPst('MG_KNIGHT', [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
]);
const MG_BISHOP = flattenPst('MG_BISHOP', [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
]);
const MG_ROOK = flattenPst('MG_ROOK', [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
]);
const MG_QUEEN = flattenPst('MG_QUEEN', [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
]);
const MG_KING = flattenPst('MG_KING', [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
]);

const EG_PAWN = flattenPst('EG_PAWN', [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 5, 5, 5, 5, 5, 5, 5],
  [15, 15, 15, 15, 15, 15, 15, 15],
  [30, 30, 30, 30, 30, 30, 30, 30],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [70, 70, 70, 70, 70, 70, 70, 70],
  [90, 90, 90, 90, 90, 90, 90, 90],
  [0, 0, 0, 0, 0, 0, 0, 0],
]);
const EG_KNIGHT = flattenPst('EG_KNIGHT', [
  [-40, -30, -20, -15, -15, -20, -30, -40],
  [-25, -15, -5, 0, 0, -5, -15, -25],
  [-10, 0, 10, 15, 15, 10, 0, -10],
  [-5, 5, 15, 20, 20, 15, 5, -5],
  [-5, 5, 15, 20, 20, 15, 5, -5],
  [-10, 0, 10, 15, 15, 10, 0, -10],
  [-25, -15, -5, 0, 0, -5, -15, -25],
  [-40, -30, -20, -15, -15, -20, -30, -40],
]);
const EG_BISHOP = flattenPst('EG_BISHOP', [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
]);
const EG_ROOK = flattenPst('EG_ROOK', [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [12, 12, 12, 12, 12, 12, 12, 12],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [4, 4, 4, 4, 4, 4, 4, 4],
  [6, 6, 6, 6, 6, 6, 6, 6],
  [4, 4, 4, 4, 4, 4, 4, 4],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 6, 6, 0, 0, 0],
]);
const EG_QUEEN = flattenPst('EG_QUEEN', [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
]);
const EG_KING = flattenPst('EG_KING', [
  [-50, -30, -20, -15, -15, -20, -30, -50],
  [-30, -15, 0, 5, 5, 0, -15, -30],
  [-25, 5, 15, 20, 20, 15, 5, -25],
  [-15, 10, 20, 30, 30, 20, 10, -15],
  [-10, 15, 25, 35, 35, 25, 15, -10],
  [-15, 10, 20, 30, 30, 20, 10, -15],
  [-30, -15, 0, 5, 5, 0, -15, -30],
  [-50, -40, -30, -20, -20, -30, -40, -50],
]);

const MG_TABLE: number[][] = [[], MG_PAWN, MG_KNIGHT, MG_BISHOP, MG_ROOK, MG_QUEEN, MG_KING];
const EG_TABLE: number[][] = [[], EG_PAWN, EG_KNIGHT, EG_BISHOP, EG_ROOK, EG_QUEEN, EG_KING];

/** 通路兵奖励（按推进程度） */
const PASSED_BONUS = [0, 5, 10, 20, 40, 70, 120, 150];

/** 评估用的临时计数（复用，避免每次分配） */
const pawnCountW = new Int32Array(8);
const pawnCountB = new Int32Array(8);
/** 每条线上最靠近升变的兵：白方取最大 rank，黑方取最小 rank（用于通路兵判定） */
const maxWhitePawnRank = new Int32Array(8);
const minBlackPawnRank = new Int32Array(8);

/** 统计一个棋子的机动性（能走到多少格，粗略但便宜） */
function countMobility(board: Int8Array, sq: number, type: number): number {
  if (type === KNIGHT) {
    let c = 0;
    for (let i = 0; i < 8; i++) if (onBoard(sq + KNIGHT_OFFSETS[i])) c++;
    return c;
  }
  if (type === KING) {
    let c = 0;
    for (let i = 0; i < 8; i++) if (onBoard(sq + KING_OFFSETS[i])) c++;
    return c;
  }
  if (type === PAWN) {
    const dir = colorOf(board[sq]) === WHITE ? 16 : -16;
    let c = 0;
    if (board[sq + dir] === 0) c++;
    const file = sq & 7;
    if (file > 0 && board[sq + dir - 1] !== 0) c++;
    if (file < 7 && board[sq + dir + 1] !== 0) c++;
    return c;
  }
  const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : QUEEN_DIRS;
  let c = 0;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    let t = sq + d;
    while (onBoard(t)) {
      c++;
      if (board[t] !== 0) break;
      t += d;
    }
  }
  return c;
}

/**
 * 便宜评估（O(1)）：子力 + 位置权重，走子方视角。
 * 数据来自增量维护的累加器，所以不用扫棋盘。
 * 用途：静态搜索里的「懒惰评估」——先用它判断能不能直接剪枝，
 * 只有在局面「咬得很紧」时才算昂贵的完整评估。
 */
function evaluateTier1(pos: Position): number {
  const white = evaluateTier1White(pos);
  return pos.turn === WHITE ? white : -white;
}

/** 同上，但返回白方视角的分值 */
function evaluateTier1White(pos: Position): number {
  const acc = pos.acc;
  const ph = Math.min(1, acc[8] / 20);
  const mg = acc[0] + acc[2] - acc[1] - acc[3];
  const eg = acc[4] + acc[6] - acc[5] - acc[7];
  return mg * ph + eg * (1 - ph) + (pos.turn === WHITE ? 10 : -10);
}

/**
 * 完整静态评估：子力 + 位置权重 + 机动性 + 王安全 + 通路兵（走子方视角）。
 * 子力与位置权重直接取增量累加器，这里只补上「局面结构」那几项。
 */
function evaluate(pos: Position): number {
  const board = pos.board;
  pawnCountW.fill(0);
  pawnCountB.fill(0);
  // 每条线上「最靠近升变」的兵：白方取最大 rank，黑方取最小 rank
  maxWhitePawnRank.fill(-1);
  minBlackPawnRank.fill(8);

  let extra = 0;
  let bishopsW = 0;
  let bishopsB = 0;
  let wMob = 0;
  let bMob = 0;

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = rank * 16 + file;
      const piece = board[sq];
      if (piece === 0) continue;
      const type = typeOf(piece);
      const color = colorOf(piece);
      const sign = color === WHITE ? 1 : -1;

      if (type === PAWN) {
        if (color === WHITE) {
          pawnCountW[file]++;
          if (rank > maxWhitePawnRank[file]) maxWhitePawnRank[file] = rank;
        } else {
          pawnCountB[file]++;
          if (rank < minBlackPawnRank[file]) minBlackPawnRank[file] = rank;
        }
      } else if (type === KING) {
        // 王的位置权重已经在累加器里
      } else {
        // 机动性：马/象/车/后能走到的格子数
        const mob = countMobility(board, sq, type);
        if (color === WHITE) wMob += mob;
        else bMob += mob;
        if (type === BISHOP) {
          if (color === WHITE) bishopsW++;
          else bishopsB++;
        }
      }
    }
  }

  // 双象
  if (bishopsW >= 2) extra += 30;
  if (bishopsB >= 2) extra -= 30;

  // 机动性（白方占优为正）
  const mobDiff = wMob - bMob;
  extra += mobDiff * 2;

  // 叠兵 / 孤兵
  for (let file = 0; file < 8; file++) {
    if (pawnCountW[file] > 1) extra -= 12 * (pawnCountW[file] - 1);
    if (pawnCountB[file] > 1) extra += 12 * (pawnCountB[file] - 1);
  }
  for (let file = 0; file < 8; file++) {
    if (pawnCountW[file] > 0) {
      const left = file > 0 ? pawnCountW[file - 1] : 0;
      const right = file < 7 ? pawnCountW[file + 1] : 0;
      if (left === 0 && right === 0) extra -= 14;
    }
    if (pawnCountB[file] > 0) {
      const left = file > 0 ? pawnCountB[file - 1] : 0;
      const right = file < 7 ? pawnCountB[file + 1] : 0;
      if (left === 0 && right === 0) extra += 14;
    }
  }

  // 通路兵：白兵前方（相邻三线）没有更靠前的黑兵即算通路
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 16 + file];
      if (piece === 0 || typeOf(piece) !== PAWN) continue;
      const color = colorOf(piece);
      let passed = true;
      if (color === WHITE) {
        for (let df = -1; df <= 1; df++) {
          const f = file + df;
          if (f < 0 || f > 7) continue;
          if (minBlackPawnRank[f] < rank) {
            passed = false;
            break;
          }
        }
        if (passed) {
          const bonus = PASSED_BONUS[Math.min(7, rank)];
          extra += Math.floor(bonus * 0.6);
        }
      } else {
        for (let df = -1; df <= 1; df++) {
          const f = file + df;
          if (f < 0 || f > 7) continue;
          if (maxWhitePawnRank[f] > rank) {
            passed = false;
            break;
          }
        }
        if (passed) {
          const bonus = PASSED_BONUS[Math.min(7, 7 - rank)];
          extra -= Math.floor(bonus * 0.6);
        }
      }
    }
  }

  // 王安全：己方王前方的兵/马掩护
  for (let color = 0; color < 2; color++) {
    const sign = color === WHITE ? 1 : -1;
    const ksq = pos.kingSq[color];
    const kfile = ksq & 7;
    const krank = ksq >> 4;
    let shield = 0;
    for (let df = -1; df <= 1; df++) {
      const f = kfile + df;
      if (f < 0 || f > 7) continue;
      for (let dr = 1; dr <= 2; dr++) {
        const r = color === WHITE ? krank + dr : krank - dr;
        if (r < 0 || r > 7) continue;
        const p = board[r * 16 + f];
        if (p === 0) continue;
        const pt = typeOf(p);
        if (colorOf(p) === color && (pt === PAWN || pt === KNIGHT)) shield++;
      }
    }
    extra += sign * shield * 8;
  }

  // 走子方视角
  const white = evaluateTier1White(pos) + extra;
  return pos.turn === WHITE ? white : -white;
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

/** 懒惰评估的余量：粗评与完整评估之间的安全差 */
const LAZY_MARGIN = 250;

const INF = 1_000_000;
const MATE_SCORE = 100_000;
const MATE_BOUND = 99_000;

/**
 * 从搜索分值里还原**杀棋距离**（单位：手，走子方视角）。
 *
 * 自研引擎把杀棋编码进分值里（`±MATE_SCORE ± ply`），
 * UCI 引擎则直接给 `score mate N`（N 就是手数）——
 * 两者在这里统一成同一个口径：**手数**。
 *
 * @returns > 0 = 走子方 N 手内将死；< 0 = 走子方 N 手内被将死；null = 不是杀棋局面
 */
export function mateDistanceFromScore(score: number): number | null {
  if (score > MATE_BOUND) {
    const plies = MATE_SCORE - score;
    return plies > 0 ? Math.ceil(plies / 2) : null;
  }
  if (score < -MATE_BOUND) {
    const plies = score + MATE_SCORE;
    return plies > 0 ? -Math.ceil(plies / 2) : null;
  }
  return null;
}

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

interface TTEntry {
  h2: number;
  depth: number;
  score: number;
  flag: number;
  move: number;
}

/** 置换表：键是哈希高位，条目里再存低位做二次校验（避免哈希碰撞导致错分） */
const tt = new Map<number, TTEntry>();

/** 每层两个 killer 着法 */
const killers = new Int32Array(MAX_PLY * 2);

/** 历史启发：安静着法按「出现过但没成功」逐渐升序 */
const history = new Int32Array(2 * 16384);

/** 路径哈希（用于三次重复判和） */
const pathH1 = new Int32Array(MAX_PLY);
const pathH2 = new Int32Array(MAX_PLY);

let nodes = 0;
let deadline = 0;
let aborted = false;

/** 超时用异常中断搜索（比到处检查标志位更干净） */
const TIMEOUT = Symbol('engine-timeout');

function timeUp(): boolean {
  return Date.now() >= deadline;
}

function checkTime(): void {
  nodes++;
  if ((nodes & 1023) === 0 && timeUp()) {
    aborted = true;
    throw TIMEOUT;
  }
}

/** 着法排序打分：置换表着法 > 吃子(MVV-LVA) > 升变 > killer > 历史启发 */
function moveScore(pos: Position, m: number, ttMove: number, ply: number): number {
  if (m === ttMove) return 2_000_000;
  if ((m & F_CAPTURE) !== 0) {
    const victim = MG_VALUE[(m >> 22) & 7];
    const attacker = MG_VALUE[typeOf(pos.board[moveFrom(m)])];
    // MVV-LVA：优先吃价值高的、且用便宜子吃
    return 1_000_000 + victim * 16 - attacker;
  }
  if ((m & F_PROMO) !== 0) return 900_000;
  const key = ((moveFrom(m) & 0x7f) << 7) | (moveTo(m) & 0x7f);
  if (killers[ply * 2] === m) return 800_000;
  if (killers[ply * 2 + 1] === m) return 790_000;
  return history[pos.turn * 16384 + key];
}

/** 插入排序（着法数量不多，插入排序比通用排序更快） */
function sortMoves(moves: Int32Array, scores: Int32Array, off: number, n: number): void {
  for (let i = off + 1; i < off + n; i++) {
    const m = moves[i];
    const s = scores[i];
    let j = i - 1;
    while (j >= off && scores[j] < s) {
      moves[j + 1] = moves[j];
      scores[j + 1] = scores[j];
      j--;
    }
    moves[j + 1] = m;
    scores[j + 1] = s;
  }
}

/**
 * 静态搜索：只搜吃子，避免「吃一半被吃」的 horizon 效应。
 *
 * 【关键约定】返回值必须是**本节点自己的分值**（站桩分，或某条吃子线的分值），
 * 绝不能返回从窗口继承来的 alpha / beta。
 *
 * 原因：alpha 是一个「界」而不是真值。父节点拿它当本节点的真值继续往上算，
 * 界就会一层层翻转、被当成事实，最终整棵搜索树的分值被污染。
 * 曾经就因为这里 `return alpha`，导致根节点二十来个着法算出同一个分值
 * （窗口边界 10 被当成了每个局面的真实评估），引擎等于只会走第一着。
 *
 * 同理，剪枝（fail-high）返回的是下界，只能原样返回给上层，
 * 不能写进本节点的 value 里——否则 value 会变成一个偏高的假值。
 */
function quiescence(pos: Position, alpha: number, beta: number, ply: number): number {
  checkTime();
  if (ply >= MAX_PLY - 2) {
    const s = evaluate(pos);
    return pos.turn === WHITE ? s : -s;
  }

  const checked = inCheck(pos);
  const off = ply * MOVES_PER_PLY;

  if (checked) {
    // 被将军时必须应将（否则会漏掉解将着法 / 误判将死）
    const n = genMoves(pos, MOVE_BUF, off, false);
    let best = -INF;
    for (let i = 0; i < n; i++) {
      const m = MOVE_BUF[off + i];
      if (!makeMove(pos, m, ply)) continue;
      const score = -quiescence(pos, -beta, -alpha, ply + 1);
      unmakeMove(pos, ply);
      // 剪枝：返回的是下界，原样上抛，不要写进 best
      if (score >= beta) return score;
      if (score > best) best = score;
      if (score > alpha) alpha = score;
    }
    if (best === -INF) return -MATE_SCORE + ply;
    return best;
  }

  // 站桩（stand pat）：不吃子也认当前局面的分值。
  // 这里必须用**完整评估**：粗评（子力 + 位置权重）缺少机动性 / 王安全 / 通路兵，
  // 与完整评估能差出上百厘兵，把它当本节点分值会让上层拿到一个假分。
  const stand = evaluate(pos);
  if (stand >= beta) return stand;
  let value = stand;
  if (value > alpha) alpha = value;

  const n = genMoves(pos, MOVE_BUF, off, true);
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[off + i];
    const s = moveScore(pos, m, 0, ply);
    SCORE_BUF[off + i] = s;
  }
  sortMoves(MOVE_BUF, SCORE_BUF, off, n);

  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[off + i];
    if (!makeMove(pos, m, ply)) continue;
    const score = -quiescence(pos, -beta, -alpha, ply + 1);
    unmakeMove(pos, ply);
    // 剪枝：返回的是下界，原样上抛，不要写进 value
    if (score >= beta) return score;
    if (score > value) value = score;
    if (value > alpha) alpha = value;
  }
  // 返回本节点自己的分值（不是继承来的 alpha）
  return value;
}

/** negamax + alpha-beta */
function negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number): number {
  checkTime();

  pathH1[ply] = pos.h1;
  pathH2[ply] = pos.h2;

  // 三次重复 → 和棋
  let repeats = 0;
  for (let i = 0; i < ply; i++) {
    if (pathH1[i] === pos.h1 && pathH2[i] === pos.h2) repeats++;
    if (repeats >= 2) return 0;
  }

  if (depth <= 0) return quiescence(pos, alpha, beta, ply);

  // 五十回合规则
  if (pos.halfmove >= 100) return 0;

  // 置换表探测
  let ttMove = 0;
  const entry = tt.get(pos.h1);
  if (entry !== undefined && entry.h2 === pos.h2) {
    ttMove = entry.move;
    if (entry.depth >= depth) {
      let s = entry.score;
      if (s > MATE_BOUND) s -= ply;
      else if (s < -MATE_BOUND) s += ply;
      if (entry.flag === TT_EXACT) return s;
      if (entry.flag === TT_LOWER && s > alpha) alpha = s;
      else if (entry.flag === TT_UPPER && s < beta) beta = s;
      if (alpha >= beta) return s;
    }
  }

  const off = ply * MOVES_PER_PLY;
  const n = genMoves(pos, MOVE_BUF, off, false);
  for (let i = 0; i < n; i++) SCORE_BUF[off + i] = moveScore(pos, MOVE_BUF[off + i], ttMove, ply);
  sortMoves(MOVE_BUF, SCORE_BUF, off, n);

  // 进入节点时的 alpha（循环里 alpha 会被抬高，写置换表标志时要用这一份）
  const alphaOrig = alpha;
  let best = -INF;
  let bestMove = 0;
  let legal = 0;

  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[off + i];
    if (!makeMove(pos, m, ply)) continue;
    legal++;
    const score = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
    unmakeMove(pos, ply);

    if (score > best) {
      best = score;
      bestMove = m;
    }
    if (score > alpha) {
      alpha = score;
      if (alpha >= beta) {
        // beta 截断：记录 killer / 历史启发
        if ((m & F_CAPTURE) === 0 && (m & F_PROMO) === 0) {
          if (killers[ply * 2] !== m) {
            killers[ply * 2 + 1] = killers[ply * 2];
            killers[ply * 2] = m;
          }
          const key = ((moveFrom(m) & 0x7f) << 7) | (moveTo(m) & 0x7f);
          const hidx = pos.turn * 16384 + key;
          history[hidx] += depth * depth;
          if (history[hidx] > 1_000_000) {
            for (let h = 0; h < history.length; h++) history[h] = Math.floor(history[h] / 2);
          }
        }
        break;
      }
    }
  }

  if (legal === 0) {
    // 无子可走：被将死则负分，否则逼和记 0
    return inCheck(pos) ? -MATE_SCORE + ply : 0;
  }

  // 置换表写入
  let storeScore = best;
  if (storeScore > MATE_BOUND) storeScore += ply;
  else if (storeScore < -MATE_BOUND) storeScore -= ply;
  const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
  if (tt.size > 400_000) tt.clear();
  tt.set(pos.h1, { h2: pos.h2, depth, score: storeScore, flag, move: bestMove });

  return best;
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/** 引擎输出的着法（SAN 无关，只给 from/to/promotion） */
export interface UciMove {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/** 带分数的候选着法 */
export interface RankedMove {
  move: UciMove;
  score: number;
}

export interface SearchOutcome {
  /** 推荐着法；无着可走为 null */
  best: UciMove | null;
  /** 根节点全部合法着法及其分数（已按分数降序） */
  moves: RankedMove[];
  /** 最佳着法的分数（走子方视角，厘兵） */
  score: number;
  /** 实际完成的迭代加深深度 */
  depth: number;
  /** 搜索节点数 */
  nodes: number;
  /** 实际耗时（毫秒） */
  elapsedMs: number;
  /** 是否因时间预算耗尽而中断 */
  timedOut: boolean;
}

export interface SearchOptions {
  /** 时间预算（毫秒） */
  timeMs: number;
  /**
   * 根节点是否对每个着法都独立做全窗口搜索。
   *
   * 默认 false：根节点用 PVS（空窗试探 + 命中后重搜），快，但排在后面的
   * 着法拿到的是**上界**而不是精确分，moves 列表的排序只能作参考。
   *
   * 传 true 时每个根着法的分值都精确可比，代价是慢很多——只在
   * 深度很浅、且确实要靠 moves 排序挑次优着法的场合用（easy 档）。
   */
  exactRootScores?: boolean;
  /** 最大深度；不传则一直加深到时间耗尽 */
  maxDepth?: number;
}

/** 0x88 格号 → 通用格名（如 'e4'） */
function squareName(sq: number): string {
  const file = String.fromCharCode(97 + (sq & 7));
  const rank = String((sq >> 4) + 1);
  return file + rank;
}

/** 走法编码 → UciMove */
function toUciMove(m: number): UciMove {
  const promo = (m >> 14) & 7;
  const out: UciMove = { from: squareName(moveFrom(m)), to: squareName(moveTo(m)) };
  if ((m & F_PROMO) !== 0) {
    if (promo === QUEEN) out.promotion = 'q';
    else if (promo === ROOK) out.promotion = 'r';
    else if (promo === BISHOP) out.promotion = 'b';
    else if (promo === KNIGHT) out.promotion = 'n';
  }
  return out;
}

/**
 * 搜索局面。
 * @param fen 局面
 * @param opts 时间预算与最大深度
 */
export function searchPosition(fen: string, opts: SearchOptions): SearchOutcome {
  const pos = parseFen(fen);
  const start = Date.now();
  deadline = start + Math.max(1, opts.timeMs);
  const maxDepth = opts.maxDepth ?? 64;

  nodes = 0;
  aborted = false;
  tt.clear();
  killers.fill(0);
  history.fill(0);

  // 根节点合法着法（用 make/unmake 顺便做一次合法性过滤）
  const rootMoves: number[] = [];
  const n = genMoves(pos, MOVE_BUF, 0, false);
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[i];
    if (makeMove(pos, m, 0)) {
      unmakeMove(pos, 0);
      rootMoves.push(m);
    }
  }

  if (rootMoves.length === 0) {
    return {
      best: null,
      moves: [],
      score: 0,
      depth: 0,
      nodes,
      elapsedMs: Date.now() - start,
      timedOut: false,
    };
  }

  // exactRoot：每个根着法都独立用全窗口搜，分值精确可比，但慢。
  // 深度浅（easy 档 depth<=2）时开启——easy 档要靠 moves 的排序挑「次优着法」，
  // 分值必须是真值，不能是 alpha-beta 的界。
  const exactRoot = opts.exactRootScores === true;

  let bestMove = rootMoves[0];
  let bestScore = 0;
  let completedDepth = 0;
  let ranked: { m: number; s: number }[] = [];
  let timedOut = false;

  // 迭代加深：每一层完整搜完才接受该层结果（超时则保留上一层）
  // 根着法顺序：先用生成顺序，深一层后按上一层的名次重排（最好的先搜，剪枝最省）
  let order = rootMoves.slice();
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      let alpha = -INF;
      let localBest = 0;
      let localScore = -INF;
      const layer: { m: number; s: number }[] = [];

      for (const m of order) {
        if (!makeMove(pos, m, 0)) continue;

        // 【PVS / 主变例搜索】根节点用 alpha-beta 的窗口共享 + 空窗试探：
        //   第一个着法、或者 exactRoot 模式 → 全窗口（-INF, INF）
        //   其余着法 → 先用零宽窗口试探，只有「可能超过 alpha」才重搜精确分
        //
        // 【为什么试探后必须重搜】空窗试探返回的只是**界**，不是这个着法的真实分值。
        //   曾经漏掉重搜，根节点二十来个着法拿到的全是界（分值挤在 24~25），
        //   排序完全失真，引擎等于只会走第一着。
        let score: number;
        if (exactRoot || alpha === -INF) {
          score = -negamax(pos, depth - 1, -INF, INF, 1);
        } else {
          // 零宽窗口：根帧 (alpha, alpha+1) → 子帧 (-alpha-1, -alpha)
          score = -negamax(pos, depth - 1, -alpha - 1, -alpha, 1);
          if (score > alpha) {
            // 试探说它可能更好 → 用根帧 (-INF, -alpha) 重搜，拿精确分
            score = -negamax(pos, depth - 1, -INF, -alpha, 1);
          }
        }
        unmakeMove(pos, 0);

        layer.push({ m, s: score });
        if (score > localScore) {
          localScore = score;
          localBest = m;
        }
        // 只有精确分才能推进 alpha：界值推进 alpha 会把窗口卡死在错误的界上
        if (score > alpha) alpha = score;
      }

      if (localBest !== 0) {
        completedDepth = depth;
        layer.sort((a, b) => b.s - a.s);
        ranked = layer;
        order = layer.map((r) => r.m);

        // 【关键】本层搜完就立刻定下 bestMove / bestScore。
        // 曾经把这件事放到「全部迭代加深结束后」的精评段里做，
        // 而那段是在时间预算耗尽之后才跑的，一进 checkTime() 就抛 TIMEOUT，
        // 结果 bestMove 从未被赋值 → best 落回 rootMoves[0]、score 恒为 0。
        bestMove = localBest;
        bestScore = localScore;
      }
    } catch (err) {
      if (err === TIMEOUT) {
        timedOut = true;
        break;
      }
      throw err;
    }

    if (timeUp()) {
      timedOut = true;
      break;
    }
  }

  return {
    best: toUciMove(bestMove),
    moves: ranked.map((r) => ({ move: toUciMove(r.m), score: r.s })),
    score: bestScore,
    depth: completedDepth,
    nodes,
    elapsedMs: Date.now() - start,
    timedOut,
  };
}

/**
 * 静态评估（走子方视角，厘兵）。调试 / 测试用。
 * 注意：返回的是「当前走子方」的分值，不是固定白方视角。
 */
export function evaluatePosition(fen: string): number {
  return evaluate(parseFen(fen));
}

/**
 * 列出当前局面的全部合法着法（调试 / 与 chess.js 对拍用）。
 * 返回的是 'e2e4' / 'e7e8q' 这种紧凑写法。
 */
export function legalMoveList(fen: string): string[] {
  const pos = parseFen(fen);
  const n = genMoves(pos, MOVE_BUF, 0, false);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[i];
    if (!makeMove(pos, m, 0)) continue;
    unmakeMove(pos, 0);
    const u = toUciMove(m);
    out.push(u.promotion ? `${u.from}${u.to}${u.promotion}` : `${u.from}${u.to}`);
  }
  return out;
}

/**
 * 列出当前局面的**全部吃子着法**（静态搜索 quiescence 用的那条路径）。
 *
 * 为什么要单独导出：legalMoveList 走的是 capturesOnly=false 的普通路径，
 * 而 quiescence 走的是 capturesOnly=true 的「只生成吃子」路径。
 * 这是引擎里两段独立代码，只测过一段就会漏掉另一条——
 * 之前的对拍用例全是「没有子可吃」的局面，等于完全没测过吃子生成。
 *
 * 返回 'e2e4' / 'a7a8q' 这种紧凑写法（升变带后缀字母）。
 */
export function captureMoveList(fen: string): string[] {
  const pos = parseFen(fen);
  const n = genMoves(pos, MOVE_BUF, 0, true);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[i];
    if (!makeMove(pos, m, 0)) continue;
    unmakeMove(pos, 0);
    const u = toUciMove(m);
    out.push(u.promotion ? `${u.from}${u.to}${u.promotion}` : `${u.from}${u.to}`);
  }
  return out;
}

/**
 * perft 分项：返回每个根着法对应的子节点数（定位 perft 差异时用）。
 */
export function perftDivide(fen: string, depth: number): { move: string; count: number }[] {
  const pos = parseFen(fen);
  const off = 0;
  const n = genMoves(pos, MOVE_BUF, off, false);
  const out: { move: string; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[off + i];
    if (!makeMove(pos, m, 0)) continue;
    const count = depth === 1 ? 1 : perftAt(pos, depth - 1, 1);
    unmakeMove(pos, 0);
    const u = toUciMove(m);
    out.push({ move: u.promotion ? `${u.from}${u.to}${u.promotion}` : `${u.from}${u.to}`, count });
  }
  return out;
}

/**
 * 校验增量维护的状态是否正确（Zobrist 哈希 + 评估累加器）。
 * 哈希错了，置换表会把别的局面的分数当成当前局面的分数；累加器错了，
 * 评估会悄悄失真——这两种错误都不会崩，但会让引擎走臭棋，所以必须单独验一次。
 *
 * @param fen 起始局面
 * @param uciMoves 依次走的着法（'e2e4' 这种写法）
 */
export function verifyIncrementalHash(fen: string, uciMoves: string[]): boolean {
  const pos = parseFen(fen);
  for (const uci of uciMoves) {
    const n = genMoves(pos, MOVE_BUF, 0, false);
    let chosen = -1;
    for (let i = 0; i < n; i++) {
      const m = MOVE_BUF[i];
      if (!makeMove(pos, m, 0)) continue;
      unmakeMove(pos, 0);
      const u = toUciMove(m);
      const text = u.promotion ? `${u.from}${u.to}${u.promotion}` : `${u.from}${u.to}`;
      if (text === uci) {
        chosen = m;
        break;
      }
    }
    if (chosen < 0) return false;
    makeMove(pos, chosen, 0);
  }
  const h1 = pos.h1;
  const h2 = pos.h2;
  const accBefore = Array.from(pos.acc);
  computeHash(pos);
  const accAfter = Array.from(pos.acc);
  computeAccumulators(pos);
  const accOk = accBefore.every((v, i) => v === pos.acc[i]);
  return h1 === pos.h1 && h2 === pos.h2 && accOk;
}

/**
 * perft：合法着法树的节点数，用于和 chess.js 对拍验证走法生成是否正确。
 * 只在测试里用。
 */
export function perft(fen: string, depth: number): number {
  const pos = parseFen(fen);
  return perftAt(pos, depth, 0);
}

/** 递归实现：每层用不同的着法缓冲偏移，否则内层会把外层的着法列表覆盖掉 */
function perftAt(pos: Position, depth: number, ply: number): number {
  if (depth === 0) return 1;
  const off = ply * MOVES_PER_PLY;
  const n = genMoves(pos, MOVE_BUF, off, false);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const m = MOVE_BUF[off + i];
    if (!makeMove(pos, m, ply)) continue;
    total += depth === 1 ? 1 : perftAt(pos, depth - 1, ply + 1);
    unmakeMove(pos, ply);
  }
  return total;
}
