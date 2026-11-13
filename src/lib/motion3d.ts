/**
 * 3D 走子动画的插值数学 —— 抽成纯函数以便单测断言。
 *
 * 为什么单独抽：3D 视角的核心差异是「棋子**立体**位移」——
 * 走子途中棋子会离开发棋面，形成一条抛物线弧，再落到目标格。
 * 这段逻辑若只写在 `useFrame` 里就没有办法断言，
 * 只能靠肉眼在动画中某一帧去截，证据不可复现。
 *
 * 对照 2D：2D 走子是一条**平面**位移（CSS transition，y 恒为 0），
 * 棋子在棋面上滑动，绝不离开棋面。两条路径在这里共用同一组时间参数，
 * 保证 2D / 3D 两端看到的是**同一步棋**（§9 D4、D5）。
 */

/** 每秒推进的归一化进度。渲染循环按 delta 累加进度。 */
export const MOVE_SPEED = 2.8;

/** 走子动画总时长（秒）。由 MOVE_SPEED 推导，避免两处真相源。 */
export const MOVE_DURATION_SECONDS = 1 / MOVE_SPEED;

/** 抬升最高点（世界单位）。0.55 相对于 1 单位的棋格宽度，是一个清晰可见但不夸张的弧高。 */
export const LIFT_HEIGHT = 0.55;

/**
 * 缓动：两端慢、中间快（ease-in-out quadratic）。
 * 与 CSS `cubic-bezier` 不同，但两端导数为 0，起止都不会「弹」。
 */
export function easeInOutQuad(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

/**
 * 抬升弧线：正弦半波。
 *
 * - t = 0 → 0（起跳，在棋面上）
 * - t = 0.5 → LIFT_HEIGHT（最高点，离开发棋面）
 * - t = 1 → 0（落回棋面）
 * - 0 < t < 1 时恒 > 0 —— 这是「立体位移」与「平面位移」的唯一分界。
 */
export function liftArc(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * Math.PI) * LIFT_HEIGHT;
}

/**
 * 走子过程中的完整位置插值。
 *
 * @param t 归一化进度 [0, 1]
 * @param from 起点（世界坐标 x/z）
 * @param to 终点（世界坐标 x/z）
 * @param boardTop 棋面高度（世界坐标 y）
 * @returns { x, y, z } —— y = boardTop + liftArc(t)，中途必然高于棋面
 */
export function arcPosition(
  t: number,
  from: { x: number; z: number },
  to: { x: number; z: number },
  boardTop: number,
): { x: number; y: number; z: number } {
  const eased = easeInOutQuad(t);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: boardTop + liftArc(t),
    z: from.z + (to.z - from.z) * eased,
  };
}
