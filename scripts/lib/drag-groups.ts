/**
 * **「拖拽走子」门禁（`scripts/verify-drag.ts`）的分组表。**
 *
 * 分组原则见 `scripts/lib/gate-groups.ts`。这一套的门禁编号是 `D1`~`D10`。
 *
 * ## 为什么按「棋盘形态」分
 *
 * 拖拽走子在 2D 与 3D 上是**两套实现**（DOM 网格 vs 射线投影），
 * 判据也完全不同：
 *
 * - 2D 能直接读 DOM（`.square[data-square]`、`.hint-dot`、`.selected`）；
 * - 3D 读不到 DOM，只能读世界坐标（`window.__chessDrag`）与机位（`window.__chessCam`）。
 *
 * 所以分成两组，各自带一套变异守着。
 *
 * ## 组内顺序
 *
 * - `drag2d` 组里 `D1` 必须先跑（它真的走了一步棋，之后的局面对不上就得重开）；
 * - `D2`~`D4` 都是「拖了但不该走子」的着，**不改变回合**，所以彼此不依赖；
 * - `D5` 是回归项（2D 点选走子仍然可用），放最后；
 * - `D10` 是 3D 组的回归项（3D 点选走子仍然可用），同样放最后。
 */
import type { GroupTable } from './gate-groups';

export const DRAG_GROUPS: GroupTable = {
  /** 2D 拖拽：走子 / 非法落点 / 落点提示 / 不误触发点选 / 点选回归 */
  drag2d: ['D1', 'D2', 'D3', 'D4', 'D5'],
  /** 3D 拖拽：走子 / 抬起 / 不转视角 / 空白处仍能转视角 / 点选回归 */
  drag3d: ['D6', 'D7', 'D8', 'D9', 'D10'],
};
