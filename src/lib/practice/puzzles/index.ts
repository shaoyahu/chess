/**
 * **残局关卡** —— 数据与判定的对外入口。
 *
 * 内容分三层：
 *   - `types.ts`   数据形状（题目长什么样）；
 *   - `data.ts`    题库本体（**生成的**，别手改）；
 *   - `session.ts` 判定逻辑（走对了没、提示是什么）；
 *   - `progress.ts` 进度存档（通关记录）。
 */
export * from './types';
export * from './themes';
export * from './session';
export * from './progress';
export * from './notes';
export { PUZZLES } from './data';
