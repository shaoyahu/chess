/**
 * **悔棋**的共享规则 —— 客户端与服务端共用一份。
 *
 * ## 为什么要有这个文件
 *
 * 悔棋能不能用，取决于两件事：
 *  1. 对局是不是**已经结束**；
 *  2. 这个终局是**谁做出来的**。
 *
 * 第 2 条是关键：**只有「棋盘规则」判出来的终局才悔得动**。
 *
 *  - 将死 / 逼和 / 三次重复 / 五十回合 / 子力不足 —— 这些是**棋盘上的事实**，
 *    撤回导致它的那一步，终局就撤销了（2026-11-20 用户拍板：终局也能悔棋）。
 *  - 认输 / 双方同意和棋 / 超时判负 / 弃权 —— 这些是**人做出来的决定**，
 *    撤一步棋改不了它（对方都认输了，你把棋退回去，这局算什么？）。
 *
 * 客户端和服务端必须用**同一份**判断，否则会出现
 * 「按钮亮着但服务端拒绝」或者「按钮灰着其实能悔」。
 */
import type { ResultReason } from './types';

/**
 * 「棋盘规则」判出来的终局原因。
 *
 * 注意 `draw` **不在**里面 —— 它在项目里指的是**双方同意和棋**
 * （`acceptDraw`），那是人的决定，不是棋盘规则。
 */
export const RULE_END_REASONS: readonly ResultReason[] = [
  'checkmate',
  'stalemate',
  'material',
  'fifty',
  'threefold',
];

/**
 * 这个终局是不是「棋盘规则」判出来的。
 *
 * @param reason 终局原因（undefined = 还没终局）
 */
export function isRuleEnd(reason: ResultReason | undefined): boolean {
  return reason !== undefined && RULE_END_REASONS.includes(reason);
}
