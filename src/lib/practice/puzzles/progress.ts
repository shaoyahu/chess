/**
 * **残局关卡的进度存档** —— localStorage，纯逻辑、不碰 React。
 *
 * 存什么：
 *   - 已经**通关**的关卡 id（关卡列表上打勾）；
 *   - 当前停在哪一关（下次进来接着下）。
 *
 * 为什么不存「每关走了多少手」「试了几次」：
 *   那些是**过程中的噪音**，玩家自己记得。用户 2026-10-09 拍板过
 *   「界面不要提前摊开系统的内部状态」—— 存档也不该替界面暴露内部计时。
 *
 * 存档**坏了不能影响开局**：读不出来就当没通关过，绝不把页面卡死。
 */

/** localStorage 的键 */
const STORAGE_KEY = 'lan-chess.endgame-puzzles.v1';

/** 进度内容 */
export interface PuzzleProgress {
  /** 已通关的关卡 id */
  solved: string[];
  /** 上次停在哪一关（null = 没停过） */
  lastId: string | null;
}

/** 空进度 */
export function emptyProgress(): PuzzleProgress {
  return { solved: [], lastId: null };
}

/**
 * 读进度。
 *
 * @param storage 传入的存储（测试里注入假的；不传用 window.localStorage）
 */
export function loadProgress(storage?: Storage): PuzzleProgress {
  let raw: string | null = null;
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return emptyProgress();
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return emptyProgress(); // 隐私模式 / 存储被禁用
  }
  if (!raw) return emptyProgress();

  try {
    const parsed = JSON.parse(raw) as Partial<PuzzleProgress>;
    return {
      solved: Array.isArray(parsed.solved) ? parsed.solved.filter((x) => typeof x === 'string') : [],
      lastId: typeof parsed.lastId === 'string' ? parsed.lastId : null,
    };
  } catch {
    return emptyProgress(); // 存档坏了就当没存过
  }
}

/** 写进度（写不进去就算了 —— 存档不是功能本身） */
export function saveProgress(progress: PuzzleProgress, storage?: Storage): void {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return;
    store.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* 写不进去就算了 */
  }
}

/** 标记一关已通关（返回新的进度） */
export function markSolved(progress: PuzzleProgress, id: string): PuzzleProgress {
  if (progress.solved.includes(id)) return progress;
  return { ...progress, solved: [...progress.solved, id] };
}

/** 记下「上次停在哪一关」 */
export function markCurrent(progress: PuzzleProgress, id: string | null): PuzzleProgress {
  return { ...progress, lastId: id };
}
