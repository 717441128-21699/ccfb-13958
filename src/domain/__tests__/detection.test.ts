import { describe, it, expect } from 'vitest';
import { detectBoundaries, extractProfile } from '../boundary-detection';
import { generateSyntheticCore } from '../synthetic';

function core(seed: number, missing = 2, falseR = 2) {
  const climate = Array.from({ length: 66 }, (_, i) =>
    1 + 0.25 * Math.sin(i / 4) + 0.1 * Math.cos(i / 9),
  );
  return generateSyntheticCore({
    seed,
    startYear: 1950,
    endYear: 2015,
    climate,
    beta: 0.8,
    baseWidth: 1.8,
    missingCount: missing,
    falseCount: falseR,
  });
}

describe('边界识别（以合成图真值核对）', () => {
  it('识别出的边界数与真值（缺轮后）一致，有序匹配位置误差不超过 6 像素', () => {
    const c = core(101, 1, 0);
    const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
    const res = detectBoundaries(profile);
    expect(Math.abs(res.peakPositions.length - c.trueBoundaryX.length)).toBeLessThanOrEqual(1);
    let maxErr = 0;
    let matched = 0;
    let ti = 0;
    let di = 0;
    while (ti < c.trueBoundaryX.length && di < res.peakPositions.length) {
      const d = Math.abs(c.trueBoundaryX[ti] - res.peakPositions[di]);
      if (d <= 6) {
        maxErr = Math.max(maxErr, d);
        matched++;
        ti++;
        di++;
      } else if (c.trueBoundaryX[ti] < res.peakPositions[di]) ti++;
      else di++;
    }
    expect(matched / c.trueBoundaryX.length).toBeGreaterThanOrEqual(0.97);
    expect(maxErr).toBeLessThanOrEqual(6);
  });

  it('缺轮导致真值边界减少，识别结果同样减少且给出 missing-ring 提示', () => {
    const c0 = core(202, 0, 0);
    const c1 = core(202, 2, 0);
    const p0 = extractProfile(c0.gray, c0.width, c0.height, c0.height / 2, c0.height / 4);
    const p1 = extractProfile(c1.gray, c1.width, c1.height, c1.height / 2, c1.height / 4);
    const n0 = detectBoundaries(p0).peakPositions.length;
    const r1 = detectBoundaries(p1);
    expect(n0 - r1.peakPositions.length).toBe(2);
    expect(r1.rings.some((r) => r.flags.some((f) => f.type === 'missing-ring'))).toBe(true);
  });

  it('伪轮被标记为 false-ring，且基本不被误当成真边界（误检 ≤1）', () => {
    const c = core(303, 0, 3);
    const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
    const res = detectBoundaries(profile);
    expect(res.peakPositions.length - c.trueBoundaryX.length).toBeLessThanOrEqual(1);
    const flagged = res.rings.filter((r) => r.flags.some((f) => f.type === 'false-ring'));
    expect(flagged.length).toBeGreaterThanOrEqual(2);
  });

  it('每个年轮都给出早材/晚材宽度，且二者之和≈总宽', () => {
    const c = core(404, 0, 0);
    const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
    const res = detectBoundaries(profile);
    for (const r of res.rings) {
      expect(r.totalWidth).toBeGreaterThan(0);
      expect(r.earlywoodWidth + r.latewoodWidth).toBeGreaterThan(r.totalWidth * 0.9);
      expect(r.latewoodRatio).toBeGreaterThan(0);
      expect(r.latewoodRatio).toBeLessThan(0.85);
    }
  });
});
