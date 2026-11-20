import { describe, it, expect } from 'vitest';
import { generateSyntheticPlot } from '../synthetic';
import { extractProfile } from '../boundary-detection';
import { runDetectionOnSample, sampleToSeries } from '../sample';
import { crossdate } from '../crossdating';
import type { CoreSample } from '../types';

const OPTS = {
  plotId: 'P01', startYear: 1950, endYear: 2020, treeCount: 5, coresPerTree: 2,
  missingRingsPerCore: 1, falseRingsPerCore: 2, seed: 20240101,
};

describe('缺轮在交叉定年中的表现（合成盲芯）', () => {
  const plot = generateSyntheticPlot(OPTS);
  const c = plot.blindCore.core;
  const sample: CoreSample = {
    id: 'b', treeId: 'T99', plotId: 'P01', name: 'BLIND-1',
    imageWidthPx: c.width, imageHeightPx: c.height, scaleMmPerPx: c.scaleMmPerPx, offsetMm: 0,
    pathY: c.height / 2, bandHalfHeightPx: c.height / 4, boundaries: [],
    pithDistanceMm: 0, barkDistanceMm: c.width * c.scaleMmPerPx, createdAt: '',
  };
  const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
  const { sample: measured, measurements } = runDetectionOnSample(sample, profile);
  const series = sampleToSeries(measured, measurements);
  const ref = { years: plot.climate.years, widths: plot.climate.signal };
  const trueMissing = c.anomalies.filter((a) => a.type === 'missing-ring').map((a) => a.year) as number[];

  it('识别边界数 = 日历年数 − 缺轮数', () => {
    expect(measured.boundaries.length).toBe(c.calendarYears.length - trueMissing.length);
    expect(measurements.length).toBe(c.trueBoundaryX.length);
  });

  it('缺轮未补：最佳端点年比真实端点早，偏量恰好等于缺轮数', () => {
    const r = crossdate(series, ref);
    expect(OPTS.endYear - r.best.endYear).toBe(trueMissing.length);
    expect(r.best.t).toBeGreaterThan(3.5);
  });

  it('定年侧至少对一个真缺轮给出缺轮告警（允许随错位偏移）', () => {
    const r = crossdate(series, ref);
    const missingWarnings = r.anomalyWarnings.filter((w) => w.flag === 'missing-ring');
    expect(missingWarnings.length).toBeGreaterThan(0);
    // 告警年份与任一真缺轮年的差距不超过累计缺轮数
    const ok = missingWarnings.some((w) =>
      trueMissing.some((y) => Math.abs((w.year ?? 0) - y) <= trueMissing.length),
    );
    expect(ok).toBe(true);
  });

  it('人工补轮（用理想年宽）后：端点归位、相关性显著提升', () => {
    const before = crossdate(series, ref);
    const fixed = crossdate({ ...series, widths: c.calendarIdealWidthsMm }, ref);
    expect(fixed.best.endYear).toBe(OPTS.endYear);
    expect(fixed.best.r).toBeGreaterThan(before.best.r);
    expect(fixed.best.t).toBeGreaterThan(before.best.t);
  });
});
