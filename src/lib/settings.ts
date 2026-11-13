'use client';

/**
 * 本地设置（音效 / 棋盘配色 / 辅助下棋 / 翻转棋盘）。
 *
 * 存在 **localStorage**：这些都是「这台设备、这个人」的偏好，
 * 换台设备就该用默认 —— 跟身份（sessionStorage）分开。
 */

import {
  DEFAULT_PIECE_MATERIAL,
  DEFAULT_PIECE_STYLE,
  getPieceMaterial,
  getPieceStyle,
  isPieceMaterial,
  isPieceStyle,
  type PieceMaterial,
  type PieceStyle,
} from '@/lib/piece-appearance';

export interface GameSettings {
  /** 音效开关 —— **默认关**（用户要求：默认关，开关放设置里） */
  soundEnabled: boolean;
  /** 音量 0..1 */
  soundVolume: number;
  /** 棋盘主题 id（见 board-themes.ts） */
  boardTheme: string;
  /** 辅助下棋：显示推荐下一步（蓝色指引箭头） */
  hintEnabled: boolean;
  /** 手动翻转棋盘（默认跟随自己的执子颜色） */
  flipBoard: boolean;
  /**
   * 棋子**风格**：造型语言（经典 / 卡通 / 像素 / 涂鸦）。
   * 与材质正交 —— 风格管形状，材质管表面。
   */
  pieceStyle: PieceStyle;
  /**
   * 棋子**材质**：表面表现（木质 / 金属 / 塑料）。
   */
  pieceMaterial: PieceMaterial;
}

export const DEFAULT_SETTINGS: GameSettings = {
  soundEnabled: false,
  soundVolume: 0.6,
  boardTheme: 'classic',
  hintEnabled: false,
  flipBoard: false,
  pieceStyle: DEFAULT_PIECE_STYLE,
  pieceMaterial: DEFAULT_PIECE_MATERIAL,
};

export const SETTINGS_KEY = 'lan-chess.settings';

/** 读设置；任何脏数据都回落到默认值（设置坏了不该让页面打不开） */
export function loadSettings(): GameSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      soundEnabled: Boolean(parsed.soundEnabled),
      soundVolume:
        typeof parsed.soundVolume === 'number' && Number.isFinite(parsed.soundVolume)
          ? Math.min(1, Math.max(0, parsed.soundVolume))
          : DEFAULT_SETTINGS.soundVolume,
      boardTheme: typeof parsed.boardTheme === 'string' ? parsed.boardTheme : DEFAULT_SETTINGS.boardTheme,
      hintEnabled: Boolean(parsed.hintEnabled),
      flipBoard: Boolean(parsed.flipBoard),
      // 风格 / 材质要**校验**（不能只看类型）——
      // 脏数据里的 'neon' 之类必须回落默认值，否则棋子会渲染成一团乱码
      pieceStyle: isPieceStyle(parsed.pieceStyle)
        ? parsed.pieceStyle
        : getPieceStyle(DEFAULT_SETTINGS.pieceStyle),
      pieceMaterial: isPieceMaterial(parsed.pieceMaterial)
        ? parsed.pieceMaterial
        : getPieceMaterial(DEFAULT_SETTINGS.pieceMaterial),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写设置 */
export function saveSettings(settings: GameSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore（隐私模式下写不进去也不该崩） */
  }
}
