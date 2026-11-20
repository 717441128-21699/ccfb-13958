import { describe, it, expect } from 'vitest';
import { pearson } from '../math';
import { tFromR, gleichlaeufigkeit, crossdate } from '../crossdating';
import type { RingWidthSeries } from '../types';

describe('COFECHA 惯例统计量', () => {
  it('Pearson 相关：完全正相关为 1、反相关为 -1', () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('t 值随 r 与样本量增大而增大，r=0 时 t=0', () => {
    expect(tFromR(0, 50)).toBe(0);
    const t1 = tFromR(0.5, 30);
    const t2 = tFromR(0.5, 60);
    expect(t2).toBeGreaterThan(t1);
    expect(t1).toBeCloseTo(3.055, 1); // 0.5*sqrt(28/0.75)
  });

  it('GLK 统计符号一致率，零差算半次', () => {
    // a=[+,+,-], b=[+,-,-]：第 1、3 个一致，第 2 个反向 → 2/3
    expect(gleichlaeufigkeit([1, 1, -1], [1, -1, -1])).toBeCloseTo((2 / 3) * 100, 5);
    // 含零差：[+,0,-] 对 [+,+,-] → 1 + 0.5 + 1 = 2.5/3
    expect(gleichlaeufigkeit([1, 0, -1], [1, 1, -1])).toBeCloseTo((2.5 / 3) * 100, 5);
  });

  it('错位序列能在正确端点年份取得最佳 t', () => {
    const years = Array.from({ length: 80 }, (_, i) => 1940 + i);
    const rng = mulberryLike(42);
    const ref = years.map((_, i) => 2 + Math.sin(i / 3) + rng() * 0.3);
    // 样本取参考序列 1950-2005 的 56 年，加少量噪声
    const sampleWidths = years.map((_, i) => ref[i] * (0.95 + rng() * 0.1)).slice(10, 66);
    const series: RingWidthSeries = {
      id: 's',
      treeId: 't',
      plotId: 'p',
      sampleName: 's',
      endYear: 1980, // 故意给个错的初值，搜索应纠正
      widths: sampleWidths,
      flags: sampleWidths.map(() => null),
    };
    const result = crossdate(series, { years, widths: ref }, { maxLagYears: 40, minOverlap: 30 });
    expect(result.best.endYear).toBe(2005);
    expect(result.best.r).toBeGreaterThan(0.9);
    expect(result.best.t).toBeGreaterThan(3.5);
  });
});

// 简单确定性伪随机，保证测试可重复
function mulberryLike(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
