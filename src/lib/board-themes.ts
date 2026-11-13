/**
 * 棋盘配色主题 —— 用户可在「设置」里挑。
 *
 * 为什么默认是**纯色**：
 *   原来的棋盘是「木纹贴图 + 底色」叠出来的，格子看上去**不是纯色**，
 *   远近格子的明暗还会随纹理起伏变化，看久了容易把深浅格看串。
 *   所以默认改成纯色块（`wood: false`），木纹降级成一个**可选主题**。
 *
 * 两套颜色（2D / 3D）分开给：
 *   3D 棋面要吃光照（漫反射 + 高光），同一个色值在 3D 上会显得更暗，
 *   所以每套主题额外给一档「3D 色」，让 2D / 3D 看起来是同一个配色。
 */

export interface BoardTheme {
  id: string;
  /** 设置面板里显示的名字 */
  label: string;
  /** 2D 浅格底色 */
  light: string;
  /** 2D 深格底色 */
  dark: string;
  /** 3D 浅格色（受打光影响，比 2D 深一点） */
  light3d: string;
  /** 3D 深格色 */
  dark3d: string;
  /** 棋盘边框色 */
  frame: string;
  /** 是否叠加木纹贴图 */
  wood: boolean;
}

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: 'classic',
    label: '原木（纯色）',
    light: '#e8d5b0',
    dark: '#a97c50',
    light3d: '#e3cfa6',
    dark3d: '#9c7346',
    frame: '#5c4632',
    wood: false,
  },
  {
    id: 'ocean',
    label: '蓝白',
    light: '#dbe7f6',
    dark: '#4d7fbe',
    light3d: '#d3e2f4',
    dark3d: '#4a78b4',
    frame: '#2f4a6d',
    wood: false,
  },
  {
    id: 'meadow',
    label: '绿白',
    light: '#e2efdc',
    dark: '#5f9450',
    light3d: '#dcead5',
    dark3d: '#5b8d4c',
    frame: '#3d5c34',
    wood: false,
  },
  {
    id: 'mono',
    label: '灰白',
    light: '#ececec',
    dark: '#787878',
    light3d: '#e6e6e6',
    dark3d: '#727272',
    frame: '#444444',
    wood: false,
  },
  {
    id: 'walnut',
    label: '胡桃木纹',
    light: '#e8d5b0',
    dark: '#a97c50',
    light3d: '#e3cfa6',
    dark3d: '#9c7346',
    frame: '#5c4632',
    wood: true,
  },
];

export const DEFAULT_BOARD_THEME_ID = 'classic';

/** 按 id 取主题；取不到就回落到默认主题（不抛错 —— 设置里的脏数据不该让棋盘崩） */
export function getBoardTheme(id: string | undefined | null): BoardTheme {
  const found = BOARD_THEMES.find((t) => t.id === id);
  return found ?? BOARD_THEMES.find((t) => t.id === DEFAULT_BOARD_THEME_ID)!;
}
