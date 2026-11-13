/**
 * 拖拽走子的**纯几何** —— 2D / 3D 共用「这个点在哪个格子上」。
 *
 * 为什么单独抽出来：
 *   「松手落在哪一格」是这套交互里**最容易算错**的一步 ——
 *   差半个格子就会走错格，而走错格是要发到服务端的真走子。
 *   抽成纯函数后可以直接单测，不用起浏览器。
 *
 * 两个坐标系：
 *   - **2D**：棋盘是 8×8 的正方形网格，格子按**显示方向**排（黑方视角整个翻转）。
 *     所以要先把「显示的列/行」换算回**真实格名**。
 *   - **3D**：棋盘在 XZ 平面上（`squareToWorld` 的映射），反过来要由世界坐标
 *     算回格名。
 */

/** 棋盘边长（格数） */
export const BOARD_SIZE = 8;

/**
 * 2D：屏幕点 → 显示的列/行（可能落在棋盘外 → null）。
 *
 * @param rect   棋盘内容区（`.board2d`）的矩形
 * @param clientX/clientY 视口坐标
 */
export function displayCellAtPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { col: number; row: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = ((clientX - rect.left) / rect.width) * BOARD_SIZE;
  const fy = ((clientY - rect.top) / rect.height) * BOARD_SIZE;
  // 落在棋盘外（拖到外面松手）→ 没有落点
  if (fx < 0 || fx >= BOARD_SIZE || fy < 0 || fy >= BOARD_SIZE) return null;
  return { col: Math.floor(fx), row: Math.floor(fy) };
}

/**
 * 2D：显示的列/行 → 真实格名。
 *
 * 与 `Board2D` 里 `squares` 那段用的是**同一套换算**（白方 col=file 不翻转，
 * 黑方整个 180° 翻转）—— 两处必须一致，否则黑方视角拖拽会走错格。
 */
export function displayCellToSquare(
  col: number,
  row: number,
  orientation: 'w' | 'b',
): string {
  const fileIndex = orientation === 'w' ? col : BOARD_SIZE - 1 - col;
  const rankNumber = orientation === 'w' ? BOARD_SIZE - row : row + 1;
  return `${String.fromCharCode(97 + fileIndex)}${rankNumber}`;
}

/**
 * 2D：**棋子中心**落在哪一格 —— 落点判定用这个。
 *
 * ## 为什么不是「光标在哪一格」
 *
 * 抓着棋子**边角**拖动时，光标和棋子中心不是同一个点。
 * 按光标判定就会出现「棋子看着压在 A 格，棋却下到了 B 格」——
 * 玩家看到的是**棋子**，不是光标，所以落点必须跟着棋子走。
 *
 * 于是规则统一成一句话：**看到棋子在哪，就下到哪**（2D / 3D 同一条）。
 *
 * @param rect    棋盘内容区（`.board2d`）的矩形
 * @param fromCol 起点格的**显示列**（0..7）
 * @param fromRow 起点格的**显示行**（0..7）
 * @param dx      拖动过程中棋子的水平位移（屏幕像素）
 * @param dy      拖动过程中棋子的垂直位移（屏幕像素）
 */
export function squareUnderPiece(
  rect: { left: number; top: number; width: number; height: number },
  fromCol: number,
  fromRow: number,
  dx: number,
  dy: number,
  orientation: 'w' | 'b',
): string | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const cx = rect.left + ((fromCol + 0.5) * rect.width) / BOARD_SIZE + dx;
  const cy = rect.top + ((fromRow + 0.5) * rect.height) / BOARD_SIZE + dy;
  const cell = displayCellAtPoint(rect, cx, cy);
  if (!cell) return null;
  return displayCellToSquare(cell.col, cell.row, orientation);
}

/**
 * 3D：世界坐标（XZ 平面）→ 真实格名；落在棋盘外 → null。
 *
 * 与 `squareToWorld` 严格互逆：
 *   `squareToWorld`：`x = file - 3.5`、`z = 4.5 - rank`（格**中心**）
 *   → 格子边界落在整数上，于是两个方向都是 `floor(坐标 + 4)`：
 *       file = floor(x + 4)   （a 列 x ∈ [-4,-3]、h 列 x ∈ [3,4]）
 *       row  = floor(z + 4)   （row 0 = rank 8，在 z ∈ [-4,-3]）
 *
 * 注意别写成 `floor(x + 3.5)`：那样 a 列（x ∈ [-4,-3]）会算成 file = -1，
 * h8 那一格会直接算出 null。
 */
export function worldToSquare(x: number, z: number): string | null {
  const half = BOARD_SIZE / 2;
  const file = Math.floor(x + half);
  const row = Math.floor(z + half);
  if (file < 0 || file >= BOARD_SIZE || row < 0 || row >= BOARD_SIZE) return null;
  const rank = BOARD_SIZE - row; // row 0 = rank 8
  return `${String.fromCharCode(97 + file)}${rank}`;
}
