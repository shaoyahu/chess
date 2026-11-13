import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  saveSettings,
} from '../src/lib/settings';

/** 造一个带 localStorage 的假 window（node 环境里没有） */
function withStorage(initial: Record<string, string> = {}): () => void {
  const store: Record<string, string> = { ...initial };
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const hadWindow = 'window' in g;
  const prevWindow = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  };
  return () => {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  };
}

describe('settings', () => {
  it('默认音效是**关**的（用户拍板）', () => {
    expect(DEFAULT_SETTINGS.soundEnabled).toBe(false);
  });

  it('默认辅助下棋是关的、翻转棋盘是关的', () => {
    expect(DEFAULT_SETTINGS.hintEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.flipBoard).toBe(false);
  });

  it('没有 localStorage 时返回默认值', () => {
    const restore = withStorage();
    try {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    } finally {
      restore();
    }
  });

  it('保存后能读回来', () => {
    const restore = withStorage();
    try {
      saveSettings({
        soundEnabled: true,
        soundVolume: 0.3,
        boardTheme: 'ocean',
        hintEnabled: true,
        flipBoard: true,
        pieceStyle: 'pixel',
        pieceMaterial: 'metal',
      });
      expect(loadSettings()).toEqual({
        soundEnabled: true,
        soundVolume: 0.3,
        boardTheme: 'ocean',
        hintEnabled: true,
        flipBoard: true,
        pieceStyle: 'pixel',
        pieceMaterial: 'metal',
      });
    } finally {
      restore();
    }
  });

  it('写到固定的 key 上', () => {
    const restore = withStorage();
    try {
      saveSettings(DEFAULT_SETTINGS);
      const raw = (
        globalThis as unknown as {
          window: { localStorage: { getItem: (k: string) => string | null } };
        }
      ).window.localStorage.getItem(SETTINGS_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).boardTheme).toBe(DEFAULT_SETTINGS.boardTheme);
    } finally {
      restore();
    }
  });

  it('脏数据回落到默认值（不崩）', () => {
    const restore = withStorage({ [SETTINGS_KEY]: '{ 不是 JSON' });
    try {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    } finally {
      restore();
    }
  });

  it('音量被夹在 0..1 之间', () => {
    const restore = withStorage({
      [SETTINGS_KEY]: JSON.stringify({ soundVolume: 5 }),
    });
    try {
      expect(loadSettings().soundVolume).toBe(1);
    } finally {
      restore();
    }
    const restore2 = withStorage({
      [SETTINGS_KEY]: JSON.stringify({ soundVolume: -3 }),
    });
    try {
      expect(loadSettings().soundVolume).toBe(0);
    } finally {
      restore2();
    }
  });

  it('非法的棋盘主题 id 保持原样（由 getBoardTheme 兜底）', () => {
    const restore = withStorage({
      [SETTINGS_KEY]: JSON.stringify({ boardTheme: 'nope' }),
    });
    try {
      expect(loadSettings().boardTheme).toBe('nope');
    } finally {
      restore();
    }
  });

  it('非法的棋子风格 / 材质回落到默认值（脏数据不能把棋子渲染成一团乱码）', () => {
    const restore = withStorage({
      [SETTINGS_KEY]: JSON.stringify({ pieceStyle: 'neon', pieceMaterial: '黄金' }),
    });
    try {
      const loaded = loadSettings();
      expect(loaded.pieceStyle).toBe(DEFAULT_SETTINGS.pieceStyle);
      expect(loaded.pieceMaterial).toBe(DEFAULT_SETTINGS.pieceMaterial);
    } finally {
      restore();
    }
  });

  it('合法的棋子风格 / 材质能存能读', () => {
    const restore = withStorage();
    try {
      saveSettings({ ...DEFAULT_SETTINGS, pieceStyle: 'cartoon', pieceMaterial: 'plastic' });
      const loaded = loadSettings();
      expect(loaded.pieceStyle).toBe('cartoon');
      expect(loaded.pieceMaterial).toBe('plastic');
    } finally {
      restore();
    }
  });
});
