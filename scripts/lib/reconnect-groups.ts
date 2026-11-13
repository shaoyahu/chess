/**
 * **「重连 / 恢复」门禁（`scripts/verify-reconnect.ts`）的分组表。**
 *
 * 分组原则见 `scripts/lib/gate-groups.ts`。这一套的门禁编号是 `R1`~`R4`。
 *
 * ## 为什么按「恢复路径」分
 *
 * 三条路径是**三套机制**，互不重叠：
 *
 * - `claim` —— 关掉网页再打开：靠**座位凭证**认领回原座位；
 * - `offline` —— 断网：靠**客户端心跳**察觉并自动重连；
 * - `restart` —— 服务重启：靠**磁盘存档**把房间和会话恢复出来。
 *
 * ## 组内顺序
 *
 * - `claim` 组里 `R2` 必须在 `R1` 之后 —— 它判的是「**对手**收到的报文里
 *   没有座位凭证」，而那个「对手收到的报文」正是 `R1` 跑出来的。
 *   拆开跑 `R2` 就没有可查的报文流水了。
 */
import type { GroupTable } from './gate-groups';

export const RECONNECT_GROUPS: GroupTable = {
  /** 关掉网页再打开：认领回原座位 + 凭证不外泄 */
  claim: ['R1', 'R2'],
  /** 断网：客户端自己察觉并重连，座位不变 */
  offline: ['R3'],
  /** 服务重启：房间和座位都还在 */
  restart: ['R4'],
};
