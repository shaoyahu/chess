import { describe, expect, it } from 'vitest';
import { copyText } from '../src/lib/clipboard';

/**
 * `copyText` 的契约测试。
 *
 * 为什么要有这层：**浏览器门禁验不了这一段**。
 *   headless Chromium 不支持 `document.execCommand('copy')` ——
 *   实测五种写法全部返回 false（只读 / 可编辑 / 透明 / 可见 / Range 选区）。
 *   所以门禁那边把 execCommand 换成「记录内容并返回 true」的桩，验的是**接线**；
 *   函数本身的契约（走哪条路、复制出去的是什么、返回什么）由这里守住。
 *
 * 这层最要紧的一条：**局域网 http 页面没有 navigator.clipboard**，
 * 复制必须走「临时 textarea + execCommand」那条老路（用户报的就是这个故障）。
 */
interface FakeState {
  /** execCommand 被调用时收到的命令 */
  execCalls: string[];
  /** 兜底复制时，临时 textarea 里装的内容 */
  copiedText: string | null;
  /** 临时 textarea 的 style（用来盯「必须放在视口内但不可见」） */
  style: Record<string, string> | null;
  /** 临时 textarea 有没有被从 DOM 里摘掉 */
  removed: boolean;
  /** 现代 API 收到的内容 */
  modernText: string | null;
}

interface Fake {
  state: FakeState;
  restore: () => void;
}

/**
 * 装一套假的 navigator / document。
 *
 * @param opts.clipboard 传 undefined = **没有** navigator.clipboard（局域网 http 的样子）
 * @param opts.execResult execCommand 的返回值（false = 复制失败）
 * @param opts.modernThrows 现代 API 抛异常（浏览器拒绝了权限）
 */
function install(opts: {
  clipboard?: { writeText: (text: string) => Promise<void> } | undefined;
  execResult?: boolean;
  modernThrows?: boolean;
}): Fake {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
  const prevDocument = Object.getOwnPropertyDescriptor(g, 'document');

  const state: FakeState = {
    execCalls: [],
    copiedText: null,
    style: null,
    removed: false,
    modernText: null,
  };
  let lastTa: { value: string } | null = null;

  const fakeDocument = {
    createElement: () => {
      const ta = {
        value: '',
        style: {} as Record<string, string>,
        parentNode: null as unknown,
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
      };
      lastTa = ta;
      state.style = ta.style;
      return ta;
    },
    body: {
      appendChild: (el: { parentNode: unknown }) => {
        el.parentNode = fakeDocument.body;
      },
      removeChild: () => {
        state.removed = true;
      },
    },
    execCommand: (cmd: string) => {
      state.execCalls.push(cmd);
      if (cmd === 'copy') state.copiedText = lastTa ? lastTa.value : null;
      return opts.execResult !== false;
    },
  };

  Object.defineProperty(g, 'navigator', {
    value: {
      clipboard: opts.clipboard
        ? {
            writeText: async (text: string) => {
              state.modernText = text;
              if (opts.modernThrows) throw new Error('NotAllowedError');
            },
          }
        : undefined,
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(g, 'document', { value: fakeDocument, configurable: true, writable: true });

  return {
    state,
    restore: () => {
      if (prevNavigator) Object.defineProperty(g, 'navigator', prevNavigator);
      else delete g.navigator;
      if (prevDocument) Object.defineProperty(g, 'document', prevDocument);
      else delete g.document;
    },
  };
}

describe('copyText', () => {
  it('有 navigator.clipboard 时走现代 API（安全上下文：https / localhost）', async () => {
    const fake = install({ clipboard: { writeText: async () => {} } });
    try {
      const ok = await copyText('  一段文字  ');
      expect(ok).toBe(true);
      expect(fake.state.modernText).toBe('一段文字');
      // 现代 API 成了就不该再走老路
      expect(fake.state.execCalls).toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it('**没有 navigator.clipboard 时走兜底**（局域网 http 页面就是这么回事）', async () => {
    const fake = install({ clipboard: undefined });
    try {
      const ok = await copyText('PGN 内容');
      expect(ok).toBe(true);
      expect(fake.state.execCalls).toEqual(['copy']);
      // 复制出去的**就是**那段文字（不是空的、不是别的东西）
      expect(fake.state.copiedText).toBe('PGN 内容');
      // 用完的临时 textarea 要摘掉，不能留在页面上
      expect(fake.state.removed).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it('现代 API 抛异常时也要落到兜底（不能直接失败）', async () => {
    const fake = install({
      clipboard: { writeText: async () => {} },
      modernThrows: true,
    });
    try {
      const ok = await copyText('PGN 内容');
      expect(ok).toBe(true);
      expect(fake.state.execCalls).toEqual(['copy']);
      expect(fake.state.copiedText).toBe('PGN 内容');
    } finally {
      fake.restore();
    }
  });

  it('兜底也失败时返回 false（调用方据此提示「复制失败」）', async () => {
    const fake = install({ clipboard: undefined, execResult: false });
    try {
      const ok = await copyText('PGN 内容');
      expect(ok).toBe(false);
      // 临时 textarea 仍然要摘掉（失败也别留在页面上）
      expect(fake.state.removed).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it('空内容直接返回 false，一次复制命令都不发', async () => {
    const fake = install({ clipboard: undefined });
    try {
      expect(await copyText('')).toBe(false);
      expect(await copyText('   \n  ')).toBe(false);
      expect(fake.state.execCalls).toEqual([]);
      expect(fake.state.modernText).toBe(null);
    } finally {
      fake.restore();
    }
  });

  it('兜底的临时 textarea **必须在视口内但不可见**（放到屏幕外会静默失败）', async () => {
    const fake = install({ clipboard: undefined });
    try {
      await copyText('x');
      const style = fake.state.style ?? {};
      expect(style.position).toBe('fixed');
      expect(style.top).toBe('0');
      expect(style.left).toBe('0');
      expect(style.opacity).toBe('0');
      // 不能是 left:-9999px 那种「挪到屏幕外」的位置
      expect(Number(style.left)).toBeGreaterThanOrEqual(0);
    } finally {
      fake.restore();
    }
  });
});
