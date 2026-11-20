/**
 * 年表构建：同树多芯先合并成树序列，样地内多树再合成年表。
 * 去趋势采用负指数曲线（拟合失败退化为水平直线 = 均值），
 * 年表值为去趋势指数的双权重稳健均值，并给出每年样本深度。
 */
import { mean, std } from './math';
import type { Chronology, RingWidthSeries, SeriesMergeItem } from './types';

/** 负指数拟合 y = a*exp(-k*x) + c，用网格 + 解析线性最小二乘做稳健简化拟合 */
function fitNegativeExponential(w: number[]): number[] {
  const n = w.length;
  const x = w.map((_, i) => i);
  const cFloor = Math.max(0, Math.min(...w) * 0.5);
  let best: { k: number; a: number; c: number; sse: number } | null = null;
  // k 按 1/序列长度 的尺度做对数网格
  const kGrid: number[] = [];
  for (let p = -4; p <= 2; p += 0.25) kGrid.push((Math.pow(10, p) * 4) / n);

  for (const k of kGrid) {
    // 对固定 k，模型 w = a*E + c，E=exp(-k x)，做线性最小二乘
    const E = x.map((xi) => Math.exp(-k * xi));
    const sE = E.reduce((s, v) => s + v, 0);
    const s1 = n;
    const sEE = E.reduce((s, v) => s + v * v, 0);
    const sW = w.reduce((s, v) => s + v, 0);
    const sEW = E.reduce((s, v, i) => s + v * w[i], 0);
    const det = sEE * s1 - sE * sE;
    if (Math.abs(det) < 1e-12) continue;
    const a = (sEW * s1 - sE * sW) / det;
    const c = (sEE * sW - sE * sEW) / det;
    if (a < 0 || c < cFloor) continue;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = w[i] - (a * E[i] + c);
      sse += r * r;
    }
    if (!best || sse < best.sse) best = { k, a, c, sse };
  }
  if (!best) return x.map(() => mean(w));
  return x.map((xi) => best!.a * Math.exp(-best!.k * xi) + best!.c);
}

/** 双权重（biweight）稳健均值 */
function biweightMean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  if (xs.length === 1) return xs[0];
  const m = median(xs);
  const mad = median(xs.map((v) => Math.abs(v - m))) || 1e-9;
  let num = 0;
  let den = 0;
  for (const v of xs) {
    const u = (v - m) / (9 * mad);
    if (Math.abs(u) >= 1) continue;
    const w = (1 - u * u) * (1 - u * u);
    num += w * v;
    den += w;
  }
  return den === 0 ? m : num / den;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 把若干已对齐（同年份）的序列按年聚合成一条序列 */
function aggregateByYear(items: SeriesMergeItem[]): { years: number[]; values: number[][]; raw: number[][] } {
  const map = new Map<number, { idx: number[]; w: number[] }>();
  for (const item of items) {
    const { series, weight = 1 } = item;
    if (series.endYear == null) {
      throw new Error(`序列 ${series.sampleName} 尚未定年，不能合并`);
    }
    const start = series.endYear - series.widths.length + 1;
    series.widths.forEach((w, i) => {
      const y = start + i;
      const cell = map.get(y) ?? { idx: [], w: [] };
      for (let k = 0; k < weight; k++) {
        cell.idx.push(i);
        cell.w.push(w);
      }
      map.set(y, cell);
    });
  }
  const years = [...map.keys()].sort((a, b) => a - b);
  return {
    years,
    values: years.map((y) => map.get(y)!.w),
    raw: years.map((y) => map.get(y)!.w),
  };
}

/** 同一棵树的多根芯 → 一条树序列（逐年平均年宽） */
export function mergeCoresToTree(treeId: string, items: SeriesMergeItem[]): RingWidthSeries {
  const agg = aggregateByYear(items);
  const widths = agg.values.map((v) => round2(mean(v)));
  const years = agg.years;
  const flags = widths.map(() => null);
  return {
    id: `tree-${treeId}`,
    treeId,
    plotId: items[0].series.plotId,
    sampleName: `树 ${treeId}（${items.length} 芯均值）`,
    endYear: years[years.length - 1],
    widths,
    flags,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 样地内多条树序列 → 年表（负指数去趋势 + biweight 指数均值） */
export function buildChronology(
  plotId: string,
  name: string,
  treeSeries: RingWidthSeries[],
): Chronology {
  if (treeSeries.length === 0) throw new Error('没有可构建年表的树序列');
  const items: SeriesMergeItem[] = treeSeries.map((series) => ({ series }));
  const agg = aggregateByYear(items);

  // 每条树序列各自去趋势，再按年汇总指数
  const indexByYear = new Map<number, number[]>();
  for (const s of treeSeries) {
    const start = s.endYear! - s.widths.length + 1;
    const trend = fitNegativeExponential(s.widths);
    s.widths.forEach((w, i) => {
      const y = start + i;
      const idx = trend[i] > 0 ? w / trend[i] : 1;
      const arr = indexByYear.get(y) ?? [];
      arr.push(idx);
      indexByYear.set(y, arr);
    });
  }

  const years = agg.years;
  const indices: number[] = [];
  const sampleDepth: number[] = [];
  const meanWidths: number[] = [];
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const idxs = indexByYear.get(y)!;
    indices.push(round2(biweightMean(idxs)));
    sampleDepth.push(agg.values[i].length);
    meanWidths.push(round2(mean(agg.values[i])));
  }

  return {
    id: `chrono-${plotId}`,
    plotId,
    name,
    years,
    indices,
    sampleDepth,
    meanWidths,
  };
}

/** 年表质量摘要（EPS 近似、平均相关、平均敏感度），便于汇报 */
export function chronologyStats(c: Chronology): {
  meanSensitivity: number;
  meanIndex: number;
  stdIndex: number;
  maxDepth: number;
} {
  const msVals: number[] = [];
  for (let i = 1; i < c.indices.length; i++) {
    msVals.push(Math.abs(c.indices[i] - c.indices[i - 1]) / ((c.indices[i] + c.indices[i - 1]) / 2));
  }
  return {
    meanSensitivity: round2(mean(msVals)),
    meanIndex: round2(mean(c.indices)),
    stdIndex: round2(std(c.indices)),
    maxDepth: Math.max(...c.sampleDepth),
  };
}
