'use client';

/**
 * 界面偏好（字号 / 密度 / 圆角）—— **纯本地**，存 localStorage。
 *
 * 为什么和 `settings.ts`（音效 / 配色 / 辅助下棋）分开：
 *   - `settings.ts` 是「游戏设置」，跟着人走，但语义上和「这台设备长什么样」是两回事；
 *   - 这里三个都是**连续维度**，界面把它暴露成 `--ui-*` CSS 变量，
 *     用户拖滑块就能改，不走「分段按钮」（分段适合离散选项，不适合连续量）。
 *
 * 为什么不进服务端：
 *   字号 / 密度是「我这张眼睛在这台屏幕上舒服」的偏好，换设备就该重置，
 *   不该跟着账号跑到别人的显示器上。系统级配置（房间属性、AI 难度）才走服务端。
 */

/** 界面偏好 */
export interface UiPrefs {
  /** 字号倍率：0.9 ~ 1.2 */
  scale: number;
  /** 间距密度倍率：0.85 ~ 1.15 */
  density: number;
  /** 圆角：4 ~ 18 px */
  radius: number;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  scale: 1,
  density: 1,
  radius: 10,
};

export const UI_PREFS_KEY = 'lan-chess.ui';

/** 三个维度的取值范围（滑块与钳位共用一份，别写两遍） */
export const UI_PREF_RANGE = {
  scale: { min: 0.9, max: 1.2, step: 0.05 },
  density: { min: 0.85, max: 1.15, step: 0.05 },
  radius: { min: 4, max: 18, step: 1 },
} as const;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 读偏好；脏数据一律回落默认值（偏好坏了不该让页面开不了） */
export function loadUiPrefs(): UiPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_UI_PREFS };
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    const num = (v: unknown, key: keyof typeof UI_PREF_RANGE): number => {
      const r = UI_PREF_RANGE[key];
      return typeof v === 'number' && Number.isFinite(v) ? clamp(v, r.min, r.max) : DEFAULT_UI_PREFS[key];
    };
    return {
      scale: num(parsed.scale, 'scale'),
      density: num(parsed.density, 'density'),
      radius: num(parsed.radius, 'radius'),
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

/** 写偏好 */
export function saveUiPrefs(prefs: UiPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore（隐私模式下写不进去也不该崩） */
  }
}

/**
 * 偏好 → CSS 变量。
 *
 * 写在 `<html>` 的内联样式上：这样**整页**（含 body 背景、棋盘、弹层）都吃到，
 * 而不只是某个组件。
 */
export function uiPrefsToCssVars(prefs: UiPrefs): Record<string, string> {
  return {
    '--ui-scale': String(prefs.scale),
    '--ui-density': String(prefs.density),
    '--ui-radius': `${prefs.radius}px`,
  };
}

/** 把偏好直接应用到 documentElement */
export function applyUiPrefs(prefs: UiPrefs): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  for (const [k, v] of Object.entries(uiPrefsToCssVars(prefs))) {
    el.style.setProperty(k, v);
  }
}
