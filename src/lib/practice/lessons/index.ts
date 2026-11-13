/**
 * **课单总表** —— 把各分类的课按「基本功 → 开局 → 应对 → 残局」拼起来。
 *
 * 顺序即学习顺序：先想明白怎么想（基本功），再学双方怎么开局（开局），
 * 然后学**对方开了这些局我怎么接**（应对），最后是子力少了怎么下（残局）。
 */

import type { Lesson } from './types';
import { BASIC_LESSONS } from './basics';
import { TACTIC_LESSONS } from './tactics';
import { OPENING_LESSONS } from './openings';
import { NEW_OPENING_LESSONS } from './openings-new';
import { COUNTER_LESSONS_A } from './counters-a';
import { COUNTER_LESSONS_B } from './counters-b';
import { COUNTER_LESSONS_C } from './counters-c';
import { ENDGAME_LESSONS } from './endgames';

export * from './types';

export const LESSONS: Lesson[] = [
  ...BASIC_LESSONS,
  ...TACTIC_LESSONS,
  ...OPENING_LESSONS,
  ...NEW_OPENING_LESSONS,
  ...COUNTER_LESSONS_A,
  ...COUNTER_LESSONS_B,
  ...COUNTER_LESSONS_C,
  ...ENDGAME_LESSONS,
];
