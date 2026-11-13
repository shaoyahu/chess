/**
 * 快速匹配队列：按**时限**配对。
 *
 * 规则（用户拍板）：
 *   - 只允许匹配**选择相同时间**的人；
 *   - 选了「任意」的人**可以和其他时间的人匹配**（他愿意将就，别的时限也能接受他）。
 *
 * 颜色分配按队列序交替，保证双方都能轮到白/黑。
 */
import { DEFAULT_TIME_CONTROL, type TimeControlKey } from '../lib/constants';

export interface QueueEntry {
  userId: string;
  name: string;
  /** 期望的时限（缺省 = 默认时限） */
  timeControl?: TimeControlKey;
  /** 「任意时限」：愿意跟任何时限的人配对 */
  anyTime?: boolean;
}

/** 这个人的期望时限（缺省 = 默认时限） */
export function timeOf(entry: QueueEntry): TimeControlKey {
  return entry.timeControl ?? DEFAULT_TIME_CONTROL;
}

/**
 * 两个人能不能配对。
 *
 * 规则只有一条：**时限相同**，或者**其中一方选了「任意」**。
 */
export function canMatch(a: QueueEntry, b: QueueEntry): boolean {
  if (a.anyTime || b.anyTime) return true;
  return timeOf(a) === timeOf(b);
}

/**
 * 配对成功后，这局用哪个时限。
 *
 * 谁选了**具体**时限就听谁的；两边都是「任意」就用默认时限。
 */
export function resolveMatchTimeControl(a: QueueEntry, b: QueueEntry): TimeControlKey {
  if (!a.anyTime && !b.anyTime) return timeOf(a);
  if (a.anyTime && !b.anyTime) return timeOf(b);
  if (!a.anyTime && b.anyTime) return timeOf(a);
  return DEFAULT_TIME_CONTROL;
}

export class Matchmaker {
  private queue: QueueEntry[] = [];

  /** 入队；返回配对到的对手（若有） */
  push(entry: QueueEntry): QueueEntry | null {
    // 已入队则不重复
    if (this.queue.some((q) => q.userId === entry.userId)) return null;

    /*
     * 找对手的顺序：**先找时限完全相同的**，再退而求其次找「任意」的。
     *
     * 为什么分两档：
     *   队列里同时有一个「10 分钟」和一个「任意」时，
     *   后到的「10 分钟」应该先跟同为「10 分钟」的人配上 ——
     *   否则「任意」的那个人会把具体的时限吃掉，
     *   下一个同时限的人反而要干等。
     */
    const sameTime = this.queue.find(
      (q) => q.userId !== entry.userId && !q.anyTime && !entry.anyTime && timeOf(q) === timeOf(entry),
    );
    const opponent =
      sameTime ?? this.queue.find((q) => q.userId !== entry.userId && canMatch(q, entry));
    if (!opponent) {
      this.queue.push(entry);
      return null;
    }
    this.queue = this.queue.filter((q) => q.userId !== opponent.userId);
    return opponent;
  }

  remove(userId: string): void {
    this.queue = this.queue.filter((q) => q.userId !== userId);
  }

  has(userId: string): boolean {
    return this.queue.some((q) => q.userId === userId);
  }

  get size(): number {
    return this.queue.length;
  }

  list(): QueueEntry[] {
    return [...this.queue];
  }
}
