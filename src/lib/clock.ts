/**
 * 棋钟显示格式化。
 *
 * **负数是合法状态** —— 超时只判负、**不结束棋局**，棋钟会继续往负数走
 * （`-1:23` = 已经超时 1 分 23 秒）。
 *
 * 为什么不能直接 `Math.floor(ms / 1000)`：
 *   负数会被**向下**取整 —— `Math.floor(-83000 / 1000)` = `-83`，
 *   于是 `-1:23` 会被显示成 `-0:83`（秒数比 60 还大，根本不像个时间）。
 *   所以先取绝对值、分出分秒，最后再补负号。
 *
 * 单独抽成函数是为了能**直接测**：这个坑只在负数上出现，
 * 而负数只有超时之后才会跑到 —— 靠肉眼看界面很难发现。
 */
export function formatClockMs(ms: number): string {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}
