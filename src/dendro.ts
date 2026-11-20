// 树轮年代学核心:去趋势、交叉定年、缺轮诊断、年表合成
import { pearson, biweightMean, median, mean, std } from './util';

export type DetrendMethod = 'diff' | 'ma11' | 'gauss32';

export interface IndexSeries { years: number[]; idx: number[]; }
export interface Chronology extends IndexSeries { depth: number[]; }

export const METHOD_NAMES: Record<DetrendMethod, string> = {
  diff: '对数一阶差分 (Baillie-Pilcher 惯例)',
  ma11: '11 年滑动平均比值',
  gauss32: '32 年高斯趋势比值',
};

function movingAvgShrink(w: number[], k: number): number[] {
  const n = w.length, h = (k - 1) / 2, out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { s += w[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

function gaussTrend(w: number[], sigma: number): number[] {
  const n = w.length, r = Math.ceil(sigma * 3), out = new Array<number>(n);
  const ker: number[] = [];
  for (let i = -r; i <= r; i++) ker.push(Math.exp(-i * i / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) {
      const k = i + j;
      if (k < 0 || k >= n) continue;
      const wgt = ker[j + r]; s += w[k] * wgt; ws += wgt;
    }
    out[i] = s / ws;
  }
  return out;
}

/** 轮宽序列 → 标准化指数序列(年份与指数对齐) */
export function buildIndex(widths: number[], firstYear: number, method: DetrendMethod): IndexSeries {
  const n = widths.length;
  if (method === 'diff') {
    // Baillie & Pilcher (1973) 原始做法:取对数后一阶差分
    const years: number[] = [], idx: number[] = [];
    for (let i = 1; i < n; i++) {
      years.push(firstYear + i);
      idx.push(Math.log(Math.max(widths[i], 1e-6)) - Math.log(Math.max(widths[i - 1], 1e-6)));
    }
    return { years, idx };
  }
  const trend = method === 'ma11' ? movingAvgShrink(widths, 11) : gaussTrend(widths, 8);
  const years: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = trend[i];
    if (!(t > 0)) continue;
    years.push(firstYear + i);
    idx.push(widths[i] / t);
  }
  return { years, idx };
}

/** Baillie-Pilcher t 值(与学生 t 同形,行里通称 t_BP) */
export function tBP(r: number, n: number): number {
  if (n < 4) return 0;
  const v = 1 - r * r;
  if (v <= 1e-12) return r > 0 ? 999 : -999;
  return r * Math.sqrt((n - 2) / v);
}

function alignPairs(sample: IndexSeries, mMap: Map<number, number>): { s: number[]; m: number[]; years: number[] } {
  const s: number[] = [], m: number[] = [], years: number[] = [];
  for (let i = 0; i < sample.years.length; i++) {
    const mv = mMap.get(sample.years[i]);
    if (mv !== undefined) { s.push(sample.idx[i]); m.push(mv); years.push(sample.years[i]); }
  }
  return { s, m, years };
}

/** Gleichläufigkeit(符号一致率)及其近似正态 z 值。
 *  差分法的指数本身已是逐年变化量,直接比符号;比值法取一阶差分比符号。 */
function glkOf(s: number[], m: number[], alreadyDiff: boolean): { glk: number; z: number } {
  let agree = 0, cnt = 0;
  if (alreadyDiff) {
    for (let i = 0; i < s.length; i++) {
      cnt++;
      if (s[i] === 0 || m[i] === 0) { agree += 0.5; continue; }
      if (Math.sign(s[i]) === Math.sign(m[i])) agree++;
    }
  } else {
    for (let i = 1; i < s.length; i++) {
      const ds = s[i] - s[i - 1], dm = m[i] - m[i - 1];
      cnt++;
      if (ds === 0 || dm === 0) { agree += 0.5; continue; }
      if (Math.sign(ds) === Math.sign(dm)) agree++;
    }
  }
  if (!cnt) return { glk: 0, z: 0 };
  return { glk: agree / cnt, z: (agree - cnt / 2) / Math.sqrt(cnt / 4) };
}

/** 让标准年表与样本走同一种变换,保证 r / t / GLK 是同类指数之间的比较 */
function masterForMethod(master: IndexSeries, method: DetrendMethod): IndexSeries {
  if (method !== 'diff') return master;
  const years: number[] = [], idx: number[] = [];
  for (let i = 1; i < master.years.length; i++) {
    if (master.years[i] !== master.years[i - 1] + 1) continue;
    years.push(master.years[i]);
    idx.push(Math.log(Math.max(master.idx[i], 1e-6)) - Math.log(Math.max(master.idx[i - 1], 1e-6)));
  }
  return { years, idx };
}

export interface CrossMatch {
  firstYear: number; overlap: number; r: number; t: number; glk: number; glkZ: number;
}

/** 滑动交叉定年:让样本序列沿标准年表滑动,返回 t 值最高的若干候选起始年 */
export function crossdateWidths(
  widths: number[], master: IndexSeries, method: DetrendMethod, minOverlap = 30, topN = 10,
): CrossMatch[] {
  const n = widths.length;
  const mast = masterForMethod(master, method);
  const mMap = new Map<number, number>();
  mast.years.forEach((y, i) => mMap.set(y, mast.idx[i]));
  const mStart = mast.years[0], mEnd = mast.years[mast.years.length - 1];
  const out: CrossMatch[] = [];
  for (let fy = mStart - n + minOverlap; fy <= mEnd - minOverlap + 1; fy++) {
    const sample = buildIndex(widths, fy, method);
    const { s, m } = alignPairs(sample, mMap);
    if (s.length < minOverlap) continue;
    const r = pearson(s, m);
    const { glk, z } = glkOf(s, m, method === 'diff');
    out.push({ firstYear: fy, overlap: s.length, r, t: tBP(r, s.length), glk, glkZ: z });
  }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, topN);
}

export interface YearRes { year: number; s: number; m: number; res: number; flagged: boolean; }

/** 在既定定年下逐年比对,|残差|>2σ 的年份标为对不上 */
export function residualsAt(widths: number[], firstYear: number, master: IndexSeries, method: DetrendMethod): YearRes[] {
  const mast = masterForMethod(master, method);
  const mMap = new Map<number, number>();
  mast.years.forEach((y, i) => mMap.set(y, mast.idx[i]));
  const sample = buildIndex(widths, firstYear, method);
  const { s, m, years } = alignPairs(sample, mMap);
  const res = s.map((v, i) => v - m[i]);
  const mu = mean(res), sd = std(res) || 1e-9;
  return years.map((y, i) => ({ year: y, s: s[i], m: m[i], res: res[i], flagged: Math.abs(res[i] - mu) > 2 * sd }));
}

function tAt(widths: number[], fy: number, mMap: Map<number, number>, method: DetrendMethod, minOverlap: number): number {
  const sample = buildIndex(widths, fy, method);
  const { s, m } = alignPairs(sample, mMap);
  if (s.length < minOverlap) return -999;
  return tBP(pearson(s, m), s.length);
}

function masterMap(master: IndexSeries, method: DetrendMethod): Map<number, number> {
  const mast = masterForMethod(master, method);
  const mMap = new Map<number, number>();
  mast.years.forEach((y, i) => mMap.set(y, mast.idx[i]));
  return mMap;
}

export interface EditSug { pos: number; year: number; count: number; tBefore: number; tAfter: number; delta: number; }

/** 缺轮/断轮扫描:逐个位置试插 1~2 轮(覆盖连续缺轮),t 值跃升的位置即疑似缺轮 */
export function scanInsertions(
  widths: number[], fy: number, master: IndexSeries, method: DetrendMethod, minOverlap = 25,
): EditSug[] {
  const mMap = masterMap(master, method);
  // 基线同样取 fy±1 最优,否则"整体平移一年"会被误算成每个插入位置的收益
  const base = Math.max(
    tAt(widths, fy - 1, mMap, method, minOverlap),
    tAt(widths, fy, mMap, method, minOverlap),
    tAt(widths, fy + 1, mMap, method, minOverlap));
  const out: EditSug[] = [];
  for (let p = 6; p <= widths.length - 6; p++) {
    const nb = (widths[p - 1] + widths[p]) / 2;
    for (const k of [1, 2] as const) {
      const w2 = [...widths.slice(0, p), ...Array<number>(k).fill(nb), ...widths.slice(p)];
      const t2 = Math.max(tAt(w2, fy - 1, mMap, method, minOverlap), tAt(w2, fy, mMap, method, minOverlap), tAt(w2, fy + 1, mMap, method, minOverlap));
      out.push({ pos: p, year: fy + p, count: k, tBefore: base, tAfter: t2, delta: t2 - base });
    }
  }
  return out.filter(s => s.delta >= 0.6 && s.tAfter >= 3.5)
    .sort((a, b) => b.delta - a.delta)
    .filter((s, i, arr) => arr.findIndex(o => Math.abs(o.pos - s.pos) <= 1) === i) // 相邻位置去重
    .slice(0, 12);
}

/** 伪年轮/多轮扫描:逐个位置试删一轮,t 值显著跃升的位置即疑似多出的轮 */
export function scanDeletions(
  widths: number[], fy: number, master: IndexSeries, method: DetrendMethod, minOverlap = 25,
): EditSug[] {
  const mMap = masterMap(master, method);
  const base = Math.max(
    tAt(widths, fy - 1, mMap, method, minOverlap),
    tAt(widths, fy, mMap, method, minOverlap),
    tAt(widths, fy + 1, mMap, method, minOverlap));
  const out: EditSug[] = [];
  for (let p = 6; p < widths.length - 6; p++) {
    const w2 = [...widths.slice(0, p), ...widths.slice(p + 1)];
    const t2 = Math.max(tAt(w2, fy - 1, mMap, method, minOverlap), tAt(w2, fy, mMap, method, minOverlap), tAt(w2, fy + 1, mMap, method, minOverlap));
    out.push({ pos: p, year: fy + p, count: 1, tBefore: base, tAfter: t2, delta: t2 - base });
  }
  return out.filter(s => s.delta >= 0.6 && s.tAfter >= 3.5)
    .sort((a, b) => b.delta - a.delta)
    .filter((s, i, arr) => arr.findIndex(o => Math.abs(o.pos - s.pos) <= 1) === i)
    .slice(0, 12);
}

/** 样地年表合成:各序列指数化后按年取 Tukey 双权稳健均值 */
export function combineChronology(
  series: { widths: number[]; firstYear: number }[], method: DetrendMethod,
): Chronology {
  const per = new Map<number, number[]>();
  for (const s of series) {
    const idx = buildIndex(s.widths, s.firstYear, method);
    for (let i = 0; i < idx.years.length; i++) {
      const y = idx.years[i];
      if (!per.has(y)) per.set(y, []);
      per.get(y)!.push(idx.idx[i]);
    }
  }
  const years = [...per.keys()].sort((a, b) => a - b);
  return {
    years,
    idx: years.map(y => biweightMean(per.get(y)!)),
    depth: years.map(y => per.get(y)!.length),
  };
}

/** 同一棵树的几根芯按定年对齐后合成一条树序列(内部空缺线性插值) */
export function mergeTreeSeries(cores: { widths: number[]; firstYear: number }[]): { widths: number[]; firstYear: number } {
  const fy = Math.min(...cores.map(c => c.firstYear));
  const ey = Math.max(...cores.map(c => c.firstYear + c.widths.length - 1));
  const widths: number[] = [];
  for (let y = fy; y <= ey; y++) {
    const vals: number[] = [];
    for (const c of cores) {
      const i = y - c.firstYear;
      if (i >= 0 && i < c.widths.length) vals.push(c.widths[i]);
    }
    widths.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN);
  }
  for (let i = 0; i < widths.length; i++) {
    if (isFinite(widths[i])) continue;
    let lo = i - 1; while (lo >= 0 && !isFinite(widths[lo])) lo--;
    let hi = i + 1; while (hi < widths.length && !isFinite(widths[hi])) hi++;
    if (lo >= 0 && hi < widths.length) widths[i] = widths[lo] + (widths[hi] - widths[lo]) * (i - lo) / (hi - lo);
    else widths[i] = median(widths.filter(isFinite));
  }
  return { widths, firstYear: fy };
}
