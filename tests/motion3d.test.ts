import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  arcPosition,
  easeInOutQuad,
  liftArc,
  LIFT_HEIGHT,
  MOVE_DURATION_SECONDS,
  MOVE_SPEED,
} from '@/lib/motion3d';

/**
 * §9 D5：3D 走子为**立体位移**（含抬升弧线），2D 为**平面位移**。
 *
 * 3D 的判定不靠肉眼截图（不可复现），而是直接断言插值函数：
 * 走子途中棋子的 y 必须**高于**棋面。
 */

const BOARD_TOP = 0.05;

describe('3D 抬升弧线', () => {
  it('起点与终点都贴在棋面上', () => {
    expect(liftArc(0)).toBe(0);
    expect(liftArc(1)).toBe(0);
    // 越界也必须贴面，不能算出负高度把棋子沉进棋盘
    expect(liftArc(-0.5)).toBe(0);
    expect(liftArc(1.5)).toBe(0);
  });

  it('中段抬到最高点 LIFT_HEIGHT', () => {
    expect(liftArc(0.5)).toBeCloseTo(LIFT_HEIGHT, 10);
  });

  it('走子途中恒高于棋面 —— 这是 3D 与 2D 的唯一分界', () => {
    for (let i = 1; i < 40; i += 1) {
      const t = i / 40;
      expect(liftArc(t)).toBeGreaterThan(0);
    }
  });

  it('弧线单峰：先升后降，没有第二个极值', () => {
    let prev = liftArc(0);
    let rising = true;
    for (let i = 1; i <= 40; i += 1) {
      const v = liftArc(i / 40);
      if (v < prev - 1e-9) rising = false;
      else if (v > prev + 1e-9) expect(rising).toBe(true);
      prev = v;
    }
    expect(prev).toBeCloseTo(0, 10);
  });
});

describe('缓动', () => {
  it('端点为 0 / 1 且中间单调不减', () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 50; i += 1) {
      const v = easeInOutQuad(i / 50);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('两端速度为 0（起止不弹跳）', () => {
    expect(easeInOutQuad(0.001)).toBeCloseTo(0.000002, 9);
    expect(easeInOutQuad(0.999)).toBeCloseTo(0.999998, 6);
  });
});

describe('arcPosition：立体位移的完整位置', () => {
  const from = { x: -3.5, z: 3.5 };
  const to = { x: -3.5, z: 1.5 };

  it('起止 y 等于棋面高度（棋子站在棋面上，不陷进去）', () => {
    expect(arcPosition(0, from, to, BOARD_TOP).y).toBeCloseTo(BOARD_TOP, 10);
    expect(arcPosition(1, from, to, BOARD_TOP).y).toBeCloseTo(BOARD_TOP, 10);
  });

  it('途中 y 高于棋面', () => {
    for (let i = 1; i < 20; i += 1) {
      const p = arcPosition(i / 20, from, to, BOARD_TOP);
      expect(p.y).toBeGreaterThan(BOARD_TOP);
    }
  });

  it('水平坐标从起点插值到终点', () => {
    expect(arcPosition(0, from, to, BOARD_TOP).z).toBeCloseTo(from.z, 10);
    expect(arcPosition(1, from, to, BOARD_TOP).z).toBeCloseTo(to.z, 10);
    expect(arcPosition(0, from, to, BOARD_TOP).x).toBeCloseTo(from.x, 10);
    expect(arcPosition(1, from, to, BOARD_TOP).x).toBeCloseTo(to.x, 10);
    // 水平位移始终不超过起终点范围
    for (let i = 0; i <= 20; i += 1) {
      const p = arcPosition(i / 20, from, to, BOARD_TOP);
      expect(p.z).toBeGreaterThanOrEqual(to.z - 1e-9);
      expect(p.z).toBeLessThanOrEqual(from.z + 1e-9);
    }
  });

  it('动画时长与推进速度自洽（约 357ms 走完一步）', () => {
    expect(MOVE_DURATION_SECONDS).toBeCloseTo(1 / MOVE_SPEED, 10);
    expect(MOVE_DURATION_SECONDS).toBeGreaterThan(0.3);
    expect(MOVE_DURATION_SECONDS).toBeLessThan(0.4);
  });
});

describe('2D 是平面位移（对照组）', () => {
  const css = readFileSync(resolve(__dirname, '../src/app/globals.css'), 'utf8');
  const pieceRule = css.slice(css.indexOf('.piece {'), css.indexOf('.piece.animating'));

  it('2D 棋子只做 left/top 平移，不改变任何"高度"量', () => {
    expect(pieceRule).toMatch(/transition:\s*[^;]*left[^;]*top/s);
    // 允许出现的属性里不能有会抬离棋面的量
    expect(pieceRule).not.toMatch(/transition:\s*[^;]*\b(height|bottom|translateZ|margin-top)\b/s);
    // 2D 走子期间不应改变 transform 的 Z 分量
    expect(pieceRule).not.toMatch(/translateZ/);
  });
});
