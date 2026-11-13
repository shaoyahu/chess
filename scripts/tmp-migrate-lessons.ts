import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('src/lib/practice/lessons.ts', 'utf8');
const marker = 'export const LESSONS: Lesson[] = [\n';
const start = src.indexOf(marker) + marker.length;
const end = src.lastIndexOf('\n];');
const body = src.slice(start, end);

// 逐行切出每一课（格式固定：'  {' 开，'  },' 闭）
const chunks: string[] = [];
let cur: string | null = null;
for (const line of body.split('\n')) {
  if (cur === null) {
    if (line === '  {') cur = line + '\n';
    continue;
  }
  cur += line + '\n';
  if (line === '  },') {
    chunks.push(cur);
    cur = null;
  }
}
if (cur !== null) throw new Error('最后一课没闭合');
if (chunks.length !== 10) throw new Error(`课数不对：${chunks.length}`);

const SIDE: Record<string, 'w' | 'b' | undefined> = {
  principles: undefined,
  london: 'w',
  italian: 'w',
  sicilian: 'b',
  'queens-gambit': 'w',
  'kings-gambit': 'w',
  'ruy-lopez': 'w',
  french: 'b',
  'caro-kann': 'b',
  'rook-pawn-endgame': 'w',
};

const byId = new Map<string, string>();
for (const chunk of chunks) {
  const id = /id: '([^']+)'/.exec(chunk)?.[1];
  if (!id) throw new Error('找不到 id');
  byId.set(id, chunk);
}

function withSide(chunk: string, side: 'w' | 'b' | undefined): string {
  if (!side) return chunk;
  return chunk.replace(/^(\s*)tag: '([^']+)',$/m, `$1tag: '$2',\n$1side: '${side}',`);
}

const pick = (ids: string[]) => ids.map((id) => withSide(byId.get(id)!, SIDE[id])).join('\n');

const basics = `/**
 * **基本功** —— 开局之前要懂的东西。
 *
 * 这里的课不教某个具体开局，而是教「怎么想」。
 */

import { START_FEN } from '../../constants';
import type { Lesson } from './types';

export const BASIC_LESSONS: Lesson[] = [
${pick(['principles'])}
];
`;

const openings = `/**
 * **开局课** —— 白方与黑方各自的开局体系。
 *
 * 每一课的走法都是**主流变例**，讲解说清「这一手在干什么」，
 * 而不是背谱。局面由着法推导（见 \`types.ts\`），讲解与棋盘永远自洽。
 */

import { START_FEN } from '../../constants';
import type { Lesson } from './types';

export const OPENING_LESSONS: Lesson[] = [
${pick([
  'london',
  'italian',
  'sicilian',
  'queens-gambit',
  'kings-gambit',
  'ruy-lopez',
  'french',
  'caro-kann',
])}
];
`;

const endgames = `/**
 * **残局课** —— 子力少的时候怎么下。
 *
 * 残局的原则和开局相反：不是「先出子」，而是「先让王干活」。
 */

import type { Lesson } from './types';

export const ENDGAME_LESSONS: Lesson[] = [
${pick(['rook-pawn-endgame'])}
];
`;

writeFileSync('src/lib/practice/lessons/basics.ts', basics);
writeFileSync('src/lib/practice/lessons/openings.ts', openings);
writeFileSync('src/lib/practice/lessons/endgames.ts', endgames);
console.log('basics/openings/endgames 写好了，课数：', ['principles'].length, 8, 1);
