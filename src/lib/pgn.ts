/**
 * 棋谱导出 —— PGN（Portable Game Notation）。
 *
 * PGN 是国际象棋界通用的棋谱格式，任何棋谱软件都能导入。
 * 服务端每一步都记了 chess.js 生成的**标准 SAN**（`Nf3`、`exd5`、`O-O`、`e8=Q`、`Qh4#`），
 * 所以拼 PGN 不需要重新推导什么 —— 直接按回合号排好就行。
 */

import type { GameResult, MoveRecord } from './types';

export interface PgnInput {
  moves: MoveRecord[];
  whiteName: string;
  blackName: string;
  result?: GameResult;
  /** 时限标签（如 '10+0'），写进 [TimeControl] 头标签 */
  timeControl?: string;
  date?: Date;
}

/** 结果 → PGN 的结果串 */
export function pgnResultString(result?: GameResult): string {
  if (!result) return '*';
  if (result.winner === 'draw') return '1/2-1/2';
  return result.winner === 'w' ? '1-0' : '0-1';
}

/** 日期 → PGN 的 YYYY.MM.DD */
export function pgnDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

/** 一行棋谱（回合号 + 白着 + 黑着） */
export interface MovePair {
  no: number;
  white?: string;
  black?: string;
}

/** 把着法按「回合号」两两配对（黑方没走时黑着为空） */
export function pairMoves(moves: MoveRecord[]): MovePair[] {
  const pairs: MovePair[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const a = moves[i];
    const b = moves[i + 1];
    const pair: MovePair = { no: i / 2 + 1 };
    if (a) pair[a.color === 'w' ? 'white' : 'black'] = a.san;
    if (b) pair[b.color === 'w' ? 'white' : 'black'] = b.san;
    pairs.push(pair);
  }
  return pairs;
}

/** 生成一份 PGN 文本 */
export function buildPgn(input: PgnInput): string {
  const { moves, whiteName, blackName, result, timeControl, date } = input;
  const headers = [
    '[Event "局域网国际象棋"]',
    '[Site "LAN"]',
    `[Date "${pgnDate(date ?? new Date())}"]`,
    '[Round "-"]',
    `[White "${whiteName}"]`,
    `[Black "${blackName}"]`,
    `[Result "${pgnResultString(result)}"]`,
  ];
  if (timeControl) headers.push(`[TimeControl "${timeControl}"]`);
  headers.push('[ECO "?"]');
  headers.push('[Opening "?"]');

  // 着法正文：按回合排，空格分隔
  const body: string[] = [];
  for (const pair of pairMoves(moves)) {
    body.push(`${pair.no}.`);
    if (pair.white) body.push(pair.white);
    if (pair.black) body.push(pair.black);
  }
  body.push(pgnResultString(result));

  return `${headers.join('\n')}\n\n${body.join(' ')}\n`;
}
