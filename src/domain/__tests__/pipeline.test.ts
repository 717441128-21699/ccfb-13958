import { describe, it, expect } from 'vitest';
import { generateSyntheticPlot, generateClimateSignal, type SyntheticCore } from '../synthetic';
import { mulberry32 } from '../math';
import { extractProfile, detectBoundaries } from '../boundary-detection';
import { runDetectionOnSample } from '../sample';
import { crossdate } from '../crossdating';
import { buildChronology, mergeCoresToTree, chronologyStats } from '../chronology';
import type { CoreSample, RingWidthSeries } from '../types';

const OPTS = {
  plotId: 'P01',
  startYear: 1950,
  endYear: 2020,
  treeCount: 5,
  coresPerTree: 2,
  missingRingsPerCore: 1,
  falseRingsPerCore: 2,
  seed: 20240101,
};

function toSample(plotId: string, treeId: string, name: string, c: SyntheticCore): CoreSample {
  return {
    id: name,
    treeId,
    plotId,
    name,
    imageWidthPx: c.width,
    imageHeightPx: c.height,
    scaleMmPerPx: c.scaleMmPerPx,
    offsetMm: 0,
    pathY: c.height / 2,
    bandHalfHeightPx: c.height / 4,
    boundaries: [],
    pithDistanceMm: 0,
    barkDistanceMm: Math.round(c.width * c.scaleMmPerPx * 100) / 100,
    createdAt: '2026-11-21',
  };
}

describe('合成 → 识别 → 定年 → 年表 全链路', () => {
  const plot = generateSyntheticPlot(OPTS);

  it('每根芯都注入了约定数量的缺轮/伪轮真值', () => {
    for (const { core } of plot.cores) {
      const miss = core.anomalies.filter((a) => a.type === 'missing-ring').length;
      const fr = core.anomalies.filter((a) => a.type === 'false-ring').length;
      expect(miss).toBe(OPTS.missingRingsPerCore);
      expect(fr).toBe(OPTS.falseRingsPerCore);
    }
  });

  it('全部芯识别边界召回率 ≥ 97%，误检峰每芯 ≤1，伪轮不被系统性误判', () => {
    let hit = 0;
    let total = 0;
    for (const { core } of plot.cores) {
      const p = extractProfile(core.gray, core.width, core.height, core.height / 2, core.height / 4);
      const res = detectBoundaries(p);
      // 有序最近邻匹配（容差 6px），一次漏检不会让后续全部错位
      let ti = 0;
      let di = 0;
      while (ti < core.trueBoundaryX.length && di < res.peakPositions.length) {
        const d = Math.abs(core.trueBoundaryX[ti] - res.peakPositions[di]);
        if (d <= 6) {
          hit++;
          ti++;
          di++;
        } else if (core.trueBoundaryX[ti] < res.peakPositions[di]) ti++;
        else di++;
      }
      total += core.trueBoundaryX.length;
      expect(res.peakPositions.length - core.trueBoundaryX.length).toBeLessThanOrEqual(1);
    }
    expect(hit / total).toBeGreaterThanOrEqual(0.97);
  });

  it('盲测芯：识别准确；缺轮未补时定年系统性偏早，补回缺轮后锁到真实端点年', () => {
    const { blindCore } = plot;
    const c = blindCore.core;
    const sample = toSample(OPTS.plotId, blindCore.treeId, blindCore.coreName, c);
    const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
    const { sample: measured, measurements } = runDetectionOnSample(sample, profile);
    const missingYears = c.anomalies.filter((a) => a.type === 'missing-ring').map((a) => a.year);
    expect(measured.boundaries.length).toBe(c.trueBoundaryX.length);
    expect(c.trueBoundaryX.length).toBe(OPTS.endYear - OPTS.startYear + 1 - missingYears.length);

    const makeSeries = (widths: number[]): RingWidthSeries => ({
      id: 'blind',
      treeId: blindCore.treeId,
      plotId: OPTS.plotId,
      sampleName: blindCore.coreName,
      endYear: null,
      widths,
      flags: widths.map(() => null),
    });
    const ref = { years: plot.climate.years, widths: plot.climate.signal };

    // 第一阶段：缺轮未补，定年端点偏早，偏量恰好等于缺轮数
    const raw = crossdate(makeSeries(measurements.map((m) => m.totalWidth)), ref);
    expect(raw.best.endYear).toBe(OPTS.endYear - missingYears.length);
    expect(raw.best.t).toBeGreaterThan(3.5);

    // 第二阶段：人工按缺轮提示补轮——在每个缺轮年位置插入一条估算宽度，
    // 并把被合并的宽轮拆回两段（这里用合成器记录的「理想年宽」模拟人工修订结果）
    const correctedWidths = c.calendarIdealWidthsMm;
    expect(correctedWidths.length).toBe(OPTS.endYear - OPTS.startYear + 1);
    const fixed = crossdate(makeSeries(correctedWidths), ref);
    expect(fixed.best.endYear).toBe(OPTS.endYear);
    expect(fixed.best.r).toBeGreaterThan(0.6);
    expect(fixed.best.t).toBeGreaterThan(3.5);
  });

  it('同树双芯合并、样地年表构建成功，年表覆盖全部年份', () => {
    const treeSeries: RingWidthSeries[] = [];
    const byTree = new Map<string, RingWidthSeries[]>();
    for (const { treeId, coreName, core } of plot.cores) {
      const sample = toSample(OPTS.plotId, treeId, coreName, core);
      const profile = extractProfile(core.gray, core.width, core.height, core.height / 2, core.height / 4);
      const { measurements } = runDetectionOnSample(sample, profile);
      const series: RingWidthSeries = {
        id: coreName,
        treeId,
        plotId: OPTS.plotId,
        sampleName: coreName,
        endYear: OPTS.endYear,
        widths: measurements.map((m) => m.totalWidth),
        flags: measurements.map(() => null),
      };
      const arr = byTree.get(treeId) ?? [];
      arr.push(series);
      byTree.set(treeId, arr);
    }
    for (const [treeId, list] of byTree) {
      treeSeries.push(mergeCoresToTree(treeId, list.map((s) => ({ series: s }))));
    }
    const chrono = buildChronology(OPTS.plotId, '测试年表', treeSeries);
    expect(chrono.years[0]).toBeLessThanOrEqual(OPTS.startYear + 4);
    expect(chrono.years[chrono.years.length - 1]).toBe(OPTS.endYear);
    expect(chrono.sampleDepth.every((d) => d >= 1)).toBe(true);
    const stats = chronologyStats(chrono);
    expect(stats.meanIndex).toBeGreaterThan(0.5);
    expect(stats.maxDepth).toBe(OPTS.treeCount);
  });

  it('气候信号可复现：同种子两次生成完全一致', () => {
    const a = generateClimateSignal(1950, 2000, mulberry32(7));
    const b = generateClimateSignal(1950, 2000, mulberry32(7));
    expect(a.signal).toEqual(b.signal);
  });
});
