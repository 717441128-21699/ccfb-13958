/**
 * 端到端冒烟（Node 端，不依赖 DOM）：
 * 合成样地 → 逐芯识别 → 交叉定年 → 同树合并 → 样地年表，打印关键指标。
 * 运行：npx tsx scripts/e2e-smoke.ts
 */
import { generateSyntheticPlot } from '../src/domain/synthetic';
import { extractProfile, detectBoundaries } from '../src/domain/boundary-detection';
import { runDetectionOnSample, sampleToSeries } from '../src/domain/sample';
import { crossdate } from '../src/domain/crossdating';
import { mergeCoresToTree, buildChronology, chronologyStats } from '../src/domain/chronology';
import type { CoreSample, RingWidthSeries } from '../src/domain/types';

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

function matchOrdered(trueX: number[], detX: number[], tol: number) {
  let ti = 0;
  let di = 0;
  let matched = 0;
  let distSum = 0;
  while (ti < trueX.length && di < detX.length) {
    const d = Math.abs(trueX[ti] - detX[di]);
    if (d <= tol) {
      matched++;
      distSum += d;
      ti++;
      di++;
    } else if (trueX[ti] < detX[di]) ti++;
    else di++;
  }
  return { matched, meanDist: matched ? distSum / matched : 0 };
}

const plot = generateSyntheticPlot(OPTS);
const ref = { years: plot.climate.years, widths: plot.climate.signal };

console.log('=== 1. 逐芯识别 ===');
let totalMatched = 0;
let totalTrue = 0;
let falseFlags = 0;
let missFlags = 0;
const byTree = new Map<string, RingWidthSeries[]>();

for (const { treeId, coreName, core } of plot.cores) {
  const sample: CoreSample = {
    id: coreName, treeId, plotId: OPTS.plotId, name: coreName,
    imageWidthPx: core.width, imageHeightPx: core.height,
    scaleMmPerPx: core.scaleMmPerPx, offsetMm: 0,
    pathY: core.height / 2, bandHalfHeightPx: core.height / 4,
    boundaries: [], pithDistanceMm: 0,
    barkDistanceMm: core.width * core.scaleMmPerPx, createdAt: '2026-11-21',
  };
  const profile = extractProfile(core.gray, core.width, core.height, core.height / 2, core.height / 4);
  const { measurements } = runDetectionOnSample(sample, profile);
  const det = detectBoundaries(profile);
  const m = matchOrdered(core.trueBoundaryX, det.peakPositions, 6);
  totalMatched += m.matched;
  totalTrue += core.trueBoundaryX.length;
  falseFlags += measurements.filter((x) => x.flags.some((f) => f.type === 'false-ring')).length;
  missFlags += measurements.filter((x) => x.flags.some((f) => f.type === 'missing-ring')).length;

  const series = sampleToSeries(sample, measurements);
  const dated: RingWidthSeries = { ...series, endYear: OPTS.endYear };
  const arr = byTree.get(treeId) ?? [];
  arr.push(dated);
  byTree.set(treeId, arr);
  console.log(
    coreName.padEnd(6),
    `召回 ${m.matched}/${core.trueBoundaryX.length}`,
    `平均误差 ${m.meanDist.toFixed(2)}px`,
    `伪轮提示 ${measurements.filter((x) => x.flags.some((f) => f.type === 'false-ring')).length}`,
    `缺轮提示 ${measurements.filter((x) => x.flags.some((f) => f.type === 'missing-ring')).length}`,
  );
}
console.log(`总体边界召回率: ${(totalMatched / totalTrue * 100).toFixed(2)}%`);
console.log(`伪轮提示总数 ${falseFlags}（真值 ${OPTS.coresPerTree * OPTS.treeCount * OPTS.falseRingsPerCore}）`);
console.log(`缺轮提示总数 ${missFlags}（真值 ${OPTS.coresPerTree * OPTS.treeCount * OPTS.missingRingsPerCore}）`);

console.log('\n=== 2. 盲测芯交叉定年（缺轮未补）===');
{
  const c = plot.blindCore.core;
  const sample: CoreSample = {
    id: 'blind', treeId: plot.blindCore.treeId, plotId: OPTS.plotId, name: plot.blindCore.coreName,
    imageWidthPx: c.width, imageHeightPx: c.height, scaleMmPerPx: c.scaleMmPerPx, offsetMm: 0,
    pathY: c.height / 2, bandHalfHeightPx: c.height / 4, boundaries: [],
    pithDistanceMm: 0, barkDistanceMm: c.width * c.scaleMmPerPx, createdAt: '2026-11-21',
  };
  const profile = extractProfile(c.gray, c.width, c.height, c.height / 2, c.height / 4);
  const { measurements } = runDetectionOnSample(sample, profile);
  const series: RingWidthSeries = sampleToSeries(sample, measurements);
  const r = crossdate(series, ref);
  const missing = c.anomalies.filter((a) => a.type === 'missing-ring').length;
  console.log(`识别边界 ${measurements.length}，真值边界 ${c.trueBoundaryX.length}（缺轮 ${missing}）`);
  console.log(`定年端点 ${r.best.endYear}（期望 ${OPTS.endYear - missing}）  r=${r.best.r.toFixed(3)} t=${r.best.t.toFixed(2)} GLK=${r.best.glk.toFixed(1)}%`);
  const fixed = crossdate({ ...series, widths: c.calendarIdealWidthsMm }, ref);
  console.log(`人工补轮后定年端点 ${fixed.best.endYear}（期望 ${OPTS.endYear}）  r=${fixed.best.r.toFixed(3)} t=${fixed.best.t.toFixed(2)}`);
  console.log(`异常年份提示 ${r.mismatchedYears.length} 个，图像异常告警 ${r.anomalyWarnings.length} 条`);
}

console.log('\n=== 3. 同树合并 → 样地年表 ===');
const treeSeries = [...byTree.entries()].map(([treeId, list]) =>
  mergeCoresToTree(treeId, list.map((series) => ({ series }))),
);
const chrono = buildChronology(OPTS.plotId, 'P01 年表', treeSeries);
const stats = chronologyStats(chrono);
console.log(`年表覆盖 ${chrono.years[0]}–${chrono.years[chrono.years.length - 1]}，共 ${chrono.years.length} 年`);
console.log(`平均敏感度 ${stats.meanSensitivity}，指数均值 ${stats.meanIndex}，最大样本深度 ${stats.maxDepth}`);
console.log('前 5 年指数:', chrono.indices.slice(0, 5).map((v) => v.toFixed(3)).join(', '));
console.log('\n冒烟通过 ✔');
