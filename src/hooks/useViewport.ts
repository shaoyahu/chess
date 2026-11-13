'use client';

/**
 * 视口尺寸 —— **全站唯一的视口来源**。
 *
 * 为什么要专门一个 hook：
 *   - 直接在各处读 `window.innerWidth` 会得到「每个人各自一份」的判断，
 *     而且 SSR 阶段根本没有 window（首屏渲染与服务端首帧不一致 → 水合警告）；
 *   - 这里统一在客户端测量，SSR 阶段给一个安全的默认值（narrow）。
 *
 * 断点约定（三档，与 globals.css 的媒体查询一一对应）：
 *   narrow  < 900
 *   medium  900 ~ 1199
 *   wide    ≥ 1200
 */
import { useEffect, useState } from 'react';

export type Breakpoint = 'narrow' | 'medium' | 'wide';

export const BREAKPOINT_NARROW = 900;
export const BREAKPOINT_WIDE = 1200;

export interface Viewport {
  /** 视口宽（CSS px） */
  width: number;
  /** 视口高（CSS px） */
  height: number;
  breakpoint: Breakpoint;
  /** 视口是不是「比高宽」（正方形视口算 false —— 用户明确要求正方形按窄屏处理） */
  landscape: boolean;
}

export function breakpointOf(width: number): Breakpoint {
  if (width < BREAKPOINT_NARROW) return 'narrow';
  if (width < BREAKPOINT_WIDE) return 'medium';
  return 'wide';
}

/** SSR / 首帧的默认值：按最窄处理（宁可窄一点，也不要先撑开再抖） */
const INITIAL: Viewport = {
  width: 430,
  height: 800,
  breakpoint: 'narrow',
  landscape: false,
};

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(INITIAL);

  useEffect(() => {
    const measure = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setVp((prev) => {
        if (prev.width === width && prev.height === height) return prev;
        return {
          width,
          height,
          breakpoint: breakpointOf(width),
          landscape: width > height,
        };
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  return vp;
}
