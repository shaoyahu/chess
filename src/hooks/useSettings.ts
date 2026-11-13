'use client';

/**
 * 设置（音效 / 棋盘配色 / 辅助下棋 / 翻转）+ 界面偏好（字号 / 密度 / 圆角）。
 *
 * 为什么单独一个 hook：大厅页与对局页都要读设置、都要能改，
 * 各写一份就会「大厅改了、对局页没跟上」这种漂移。
 *
 * 分层（个人偏好 vs 系统配置）：
 *   - 这里管的都是**个人偏好**，一律存 localStorage，换设备重置；
 *   - 房间属性（时限、AI 难度）属于系统配置，走服务端，不在这里。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type GameSettings,
} from '@/lib/settings';
import {
  DEFAULT_UI_PREFS,
  applyUiPrefs,
  loadUiPrefs,
  saveUiPrefs,
  type UiPrefs,
} from '@/lib/ui-prefs';

export interface UseSettingsResult {
  settings: GameSettings;
  uiPrefs: UiPrefs;
  updateSettings: (next: GameSettings) => void;
  updateUiPrefs: (next: UiPrefs) => void;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(DEFAULT_UI_PREFS);

  // 挂载后从 localStorage 读一次（放在 effect 里，避免 SSR 阶段碰 window）
  useEffect(() => {
    setSettings(loadSettings());
    const prefs = loadUiPrefs();
    setUiPrefs(prefs);
    // 立刻生效：刷新后不改任何设置，界面也应该是上次那套字号 / 密度 / 圆角
    applyUiPrefs(prefs);
  }, []);

  const updateSettings = useCallback((next: GameSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const updateUiPrefs = useCallback((next: UiPrefs) => {
    setUiPrefs(next);
    saveUiPrefs(next);
    // 实时生效：拖滑块时页面立刻跟着变
    applyUiPrefs(next);
  }, []);

  return { settings, uiPrefs, updateSettings, updateUiPrefs };
}
