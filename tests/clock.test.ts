import { describe, expect, it } from 'vitest';
import { formatClockMs } from '@/lib/clock';

describe('棋钟显示格式化', () => {
  it('正数按「分:秒」显示，秒数补零', () => {
    expect(formatClockMs(0)).toBe('0:00');
    expect(formatClockMs(5_000)).toBe('0:05');
    expect(formatClockMs(65_000)).toBe('1:05');
    expect(formatClockMs(600_000)).toBe('10:00');
  });

  it('负数带负号（已超时多久）', () => {
    expect(formatClockMs(-1_000)).toBe('-0:01');
    expect(formatClockMs(-83_000)).toBe('-1:23');
    expect(formatClockMs(-600_000)).toBe('-10:00');
  });

  it('负数**不能出现秒数 ≥ 60**（向下取整的坑）', () => {
    // Math.floor(-83000 / 1000) = -83 → 朴素写法会显示成 "-0:83"
    expect(formatClockMs(-83_000)).not.toBe('-0:83');
    for (const ms of [-1, -999, -1_000, -59_999, -60_000, -61_000, -83_000, -600_000]) {
      const text = formatClockMs(ms);
      const [, s] = text.split(':');
      expect(Number(s)).toBeLessThan(60);
    }
  });
});
