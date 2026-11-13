import { describe, expect, it } from 'vitest';
import {
  BOARD_THEMES,
  DEFAULT_BOARD_THEME_ID,
  getBoardTheme,
} from '../src/lib/board-themes';

describe('board themes', () => {
  it('至少提供 4 套配色（含蓝白、绿白）', () => {
    expect(BOARD_THEMES.length).toBeGreaterThanOrEqual(4);
    const ids = BOARD_THEMES.map((t) => t.id);
    expect(ids).toContain('ocean');
    expect(ids).toContain('meadow');
  });

  it('默认主题是纯色（不吃木纹贴图）', () => {
    const def = getBoardTheme(DEFAULT_BOARD_THEME_ID);
    expect(def.wood).toBe(false);
  });

  it('id 唯一、label 非空', () => {
    const ids = BOARD_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of BOARD_THEMES) expect(t.label.length).toBeGreaterThan(0);
  });

  it('每套主题都有合法 hex 色（浅格/深格/3D 两色/边框）', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const t of BOARD_THEMES) {
      expect(t.light).toMatch(hex);
      expect(t.dark).toMatch(hex);
      expect(t.light3d).toMatch(hex);
      expect(t.dark3d).toMatch(hex);
      expect(t.frame).toMatch(hex);
    }
  });

  it('浅格与深格**不是同一个色**（否则棋盘看不出格子）', () => {
    for (const t of BOARD_THEMES) {
      expect(t.light.toLowerCase()).not.toBe(t.dark.toLowerCase());
      expect(t.light3d.toLowerCase()).not.toBe(t.dark3d.toLowerCase());
    }
  });

  it('取不到 id 时回落到默认主题（脏数据不该让棋盘崩）', () => {
    expect(getBoardTheme('不存在的配色').id).toBe(DEFAULT_BOARD_THEME_ID);
    expect(getBoardTheme(undefined).id).toBe(DEFAULT_BOARD_THEME_ID);
    expect(getBoardTheme(null).id).toBe(DEFAULT_BOARD_THEME_ID);
  });
});
