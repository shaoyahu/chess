/**
 * **课单总表** —— 把各分类的课拼成一张有顺序的课单。
 *
 * 顺序 = 学习顺序：先想明白怎么想（基本功），再学双方怎么开局（开局），
 * 然后学**对方开了这些局我怎么接**（应对），最后是子力少了怎么下（残局）。
 *
 * 顺序由 `TAG_ORDER` 决定，而不是各文件的导入顺序 ——
 * 否则新加一节课放在哪个文件里，就会悄悄决定它出现在课单的哪个位置。
 */

import type { Lesson, LessonTag } from './types';
import { BASIC_LESSONS } from './basics';
import { TACTIC_LESSONS } from './tactics';
import { OPENING_LESSONS } from './openings';
import { NEW_OPENING_LESSONS } from './openings-new';
import { COUNTER_LESSONS_A } from './counters-a';
import { COUNTER_LESSONS_B } from './counters-b';
import { COUNTER_LESSONS_C } from './counters-c';
import { ENDGAME_LESSONS } from './endgames';

export * from './types';

/** 课单里的分类顺序 */
const TAG_ORDER: LessonTag[] = ['基本功', '开局', '应对', '残局'];

/** 所有课（不分顺序） */
const ALL_LESSONS: Lesson[] = [
  ...BASIC_LESSONS,
  ...TACTIC_LESSONS,
  ...OPENING_LESSONS,
  ...NEW_OPENING_LESSONS,
  ...COUNTER_LESSONS_A,
  ...COUNTER_LESSONS_B,
  ...COUNTER_LESSONS_C,
  ...ENDGAME_LESSONS,
];

/**
 * 课单 —— 按分类排序（`sort` 是稳定的，同一类里保持文件里的先后）。
 */
export const LESSONS: Lesson[] = [...ALL_LESSONS].sort(
  (a, b) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag),
);
