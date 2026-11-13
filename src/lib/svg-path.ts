/**
 * 极简 SVG path 解析器。
 *
 * 只支持本项目实际用到的子集（**全部是绝对坐标**）：
 *   M —— 移动到      L —— 直线到
 *   C —— 三次贝塞尔    Q —— 二次贝塞尔
 *   Z —— 闭合路径
 *
 * 为什么需要它：
 *   2D 的棋子轮廓写在 PieceGlyph.tsx 里（就是 SVG 的 `d` 字符串），
 *   而 3D 要**复用同一份轮廓**（马侧影、象的裂口、眼睛、鬃毛），
 *   就得把 `d` 字符串解析成几何命令。
 *   这样 2D 和 3D 的马永远长一个样 —— 不会出现「2D 是马、3D 是斧头」。
 *
 * 为什么自己写而不是引第三方：
 *   - 只为解析自家固定写法的路径，需求极窄，第三方库是杀鸡用牛刀；
 *   - 依赖越少，licenses 门禁越干净（见 scripts/check-licenses.ts）。
 */

/** 一条路径命令 */
export type PathCommand =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number }
  | { op: 'Z' };

/** 命令字母 */
const CMD = /^[MLCQZ]$/;
/** 数字（支持小数、负号、科学计数法） */
const NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

/**
 * 把 SVG path 字符串解析成命令列表。
 *
 * @param d SVG `d` 属性（只含绝对坐标的 M/L/C/Q/Z）
 */
export function parseSvgPath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  const tokens = d.match(/[MLCQZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];

  let i = 0;
  let op = '';
  const num = (): number => {
    const t = tokens[i] ?? '0';
    i += 1;
    return Number(t);
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (t && CMD.test(t)) {
      op = t;
      i += 1;
    } else if (!op) {
      // 没有命令字母就无法解析，丢弃这个 token 继续
      i += 1;
      continue;
    }

    switch (op) {
      case 'M':
        out.push({ op: 'M', x: num(), y: num() });
        break;
      case 'L':
        out.push({ op: 'L', x: num(), y: num() });
        break;
      case 'C':
        out.push({
          op: 'C',
          c1x: num(),
          c1y: num(),
          c2x: num(),
          c2y: num(),
          x: num(),
          y: num(),
        });
        break;
      case 'Q':
        out.push({ op: 'Q', cx: num(), cy: num(), x: num(), y: num() });
        break;
      case 'Z':
        out.push({ op: 'Z' });
        break;
      default:
        // 未知命令：跳到下一个命令字母
        i += 1;
        break;
    }
  }
  return out;
}
