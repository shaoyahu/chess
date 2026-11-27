/**
 * **对手着法的解说** —— 把离线算好的事实拼成一句人话。
 *
 * ## 为什么解说放在这里而不是生成器里
 *
 * 生成器（`scripts/generate-endgame-puzzles.ts`）是离线最贵的一步 ——
 * 每关都要跑引擎。跑一次要几十分钟。
 *
 * 而解说的**说法**是要打磨的：同一件事可以写成
 * 「对手只剩这一手可走」或「对手没有别的选择」——
 * 前者更准确，后者更啰嗦。改一句话不该重跑引擎。
 *
 * 所以：**引擎只负责算出事实，文案在这里拼**。
 *
 * ## 解说说什么、不说什么
 *
 * 说：
 *   - 局面性质（对手已经必败 / 还在拉锯）；
 *   - 着法性质（唯一合法 / 引擎最优 / 弃子换时间）；
 *   - 跟其它着法的**量化对比**（少拖了几手、差了多少分）。
 *
 * 不说：
 *   - 「对手很弱」「对手在犯错」这类评价性的话；
 *   - 引擎内部实现细节（哈希表、搜索深度之类）；
 *   - **还没发生的局面**（不能剧透对手下一步会走哪）。
 *
 * 最后一条是硬约束：界面不提前摊开系统的内部状态。
 * 解说只解释**已经走过的那一手**，不预告下一手。
 */
import type { PuzzleOpponentNote } from './types';

/** 子力换算：棋子价值（厘兵） */
const PIECE_VALUE_CP: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
};

/**
 * 把局面里某一方的总子力（厘兵）。
 *
 * 用来算「这一手牺牲了多少」——
 * 走完这手之后对手的子力比走之前少了多少。
 */
export function materialCp(fen: string, color: 'w' | 'b'): number {
  let total = 0;
  const parts = fen.split(' ');
  const rows = parts[0]?.split('/') ?? [];
  for (const row of rows) {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const isWhite = ch === ch.toUpperCase();
      const piece = ch.toLowerCase();
      if ((isWhite ? 'w' : 'b') === color) {
        total += PIECE_VALUE_CP[piece] ?? 0;
      }
      file += 1;
    }
  }
  return total;
}

/**
 * 把子力差距写成一句人话。
 *
 * 残局里说「丢了 3.2 个兵」不自然 —— 棋手说的是「丢了车」「丢了一车一马」。
 * 所以优先按**棋子**说，实在凑不出整数件才退回「约 N 个兵」。
 */
function materialText(cp: number): string {
  const pieces: { type: string; name: string; value: number }[] = [
    { type: 'q', name: '后', value: 900 },
    { type: 'r', name: '车', value: 500 },
    { type: 'b', name: '象', value: 330 },
    { type: 'n', name: '马', value: 320 },
    { type: 'p', name: '兵', value: 100 },
  ];
  let left = Math.abs(cp);
  const got: string[] = [];
  for (const p of pieces) {
    const n = Math.floor(left / p.value);
    if (n > 0) {
      got.push(`${n === 1 ? '一' : n}${p.name}`);
      left -= n * p.value;
    }
  }
  if (got.length > 0) return got.join('、');
  return `约 ${Math.round(Math.abs(cp) / 100 * 10) / 10} 个兵`;
}

/**
 * 把厘兵写成「约等于几个兵」的说法（用于分值差距）。
 */
function pawnsText(cp: number): string {
  const pawns = Math.abs(cp) / 100;
  if (pawns < 0.5) return '几乎不差';
  const rounded = Math.round(pawns * 10) / 10;
  return `${rounded} 个兵`;
}

/**
 * 生成对手这一手的解说。
 *
 * @param note 离线算好的事实
 * @returns 一到两句中文；事实不足时返回 null（不硬凑）
 */
export function opponentNoteText(note: PuzzleOpponentNote): string | null {
  const parts: string[] = [];

  // ---- 局面性质：先说清「对手处境如何」 ----
  if (note.hopeless) {
    // 分两种：被杀棋 = 无解；子力大劣 = 已经输定
    const isMateLine = note.mateInAfter !== null;
    parts.push(isMateLine ? '对手这局已经无解' : '对手这局已经输定了');
  }

  // ---- 着法性质：这手是什么性质 ----
  if (note.legalCount === 1) {
    // 唯一合法着法 —— 最强的一种「没有选择」
    parts.push('它只有这一着可走');
  } else if (note.isBest) {
    if (note.hopeless && note.mateInAfter !== null) {
      // 杀棋线上的已败局面：最优应手 = 把杀棋拖最久
      parts.push('这一手是引擎能想到的最能拖的走法');
    } else if (note.hopeless) {
      // 子力已败：最优应手 = 把损失降到最小
      parts.push('这一手是引擎能想到的最能撑的走法');
    } else {
      parts.push('这一手是此刻最强的一着');
    }
  } else {
    // 不是最优 —— 老实说
    parts.push('这一手不是最优');
  }

  let text = parts.join('，') + '。';

  // ---- 量化对比：跟别的选择比，差在哪 ----
  const details: string[] = [];

  // 不是最优时，直接告诉玩家「更好的选择是什么」—— 不说等于没说
  if (!note.isBest && note.bestSan) {
    details.push(`更好的走法是 ${note.bestSan}`);
  }

  // 杀棋距离对比：这手让杀棋晚了/早了几手
  if (
    note.mateInAfter !== null &&
    note.bestMateInAfter !== null &&
    note.mateInAfter !== note.bestMateInAfter
  ) {
    const diff = note.mateInAfter - note.bestMateInAfter;
    if (diff > 0) {
      details.push(`换最好的走法 ${note.bestMateInAfter} 手就能杀，这手拖到了 ${note.mateInAfter} 手`);
    } else {
      details.push(`最好的走法还要拖 ${note.bestMateInAfter} 手，这手只值 ${note.mateInAfter} 手`);
    }
  }

  // 子力牺牲：弃子换时间
  if (note.sacrificedCp >= 300) {
    details.push(`代价是丢了${materialText(note.sacrificedCp)}`);
  }

  /*
   * 分值对比 —— **只在「不是最优」时才说**。
   *
   * 为什么：这一手已经是最优时，说「比最好的时候差 X」是自相矛盾的
   * （「最好」就是它自己）。
   *
   * 差多少用**与最优着法的分值差**来算，而不是与自己的分值比。
   */
  if (
    !note.isBest &&
    note.scoreAfter !== null &&
    note.bestScoreAfter !== null &&
    note.bestScoreAfter !== note.scoreAfter
  ) {
    const gap = Math.abs(note.scoreAfter - note.bestScoreAfter);
    if (gap >= 100) {
      details.push(`局面比最好的走法差 ${pawnsText(gap)}`);
    }
  }

  if (details.length > 0) {
    text += details.join('；') + '。';
  }

  return text;
}
