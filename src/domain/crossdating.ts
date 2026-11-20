/**
 * 交叉定年（crossdating）。
 *
 * 按 COFECHA 惯例实现：
 *  - 对重叠段做一阶差分后计算 Pearson 相关 r；
 *  - t = r · sqrt((n-2)/(1-r²))，n 为差分样本数；
 *  - GLK（Gleichläufigkeit）：逐年宽窄变化方向一致百分率；
 *  - 50 年窗口、25 年步进的分段 t，定位对不上的时段；
 *  - 最佳错位下用差分标准化偏离标出对不上的具体年份。
 *
 * 纯函数，参考年表与待测序列都只是 {years, widths} 数据。
 */
import { mean, std, pearson, simpleDifference } from './math';
import type { DatingLag, DatingResult, RingFlagType, RingWidthSeries } from './types';

export interface ReferenceChronologyLike {
  years: number[];
  /** 年表值或平均年宽均可，定年只用年际变化 */
  widths: number[];
}

export interface CrossdateOptions {
  /** 候选错位搜索半宽（年），默认 80 */
  maxLagYears?: number;
  /** 有效匹配要求的最小重叠年数 */
  minOverlap?: number;
  /** 标记异常年份的标准化偏离阈值 */
  mismatchZThreshold?: number;
  /** 分段窗口/步进 */
  segmentWindow?: number;
  segmentStep?: number;
}

/** COFECHA 风格 t 值变换 */
export function tFromR(r: number, nDiff: number): number {
  if (nDiff <= 2) return 0;
  const r2 = Math.min(0.999999, r * r);
  return r * Math.sqrt((nDiff - 2) / (1 - r2));
}

/** GLK：两组差分符号一致率（0..100），0 差分按半次计 */
export function gleichlaeufigkeit(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let score = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === 0 || b[i] === 0) {
      score += 0.5;
    } else if (Math.sign(a[i]) === Math.sign(b[i])) {
      score += 1;
    }
  }
  return (score / n) * 100;
}

interface OverlapData {
  years: number[];
  sample: number[];
  ref: number[];
}

/** 按候选端点年份把样本与参考序列对齐，取共同年份区间 */
function overlapAt(
  sample: number[],
  ref: ReferenceChronologyLike,
  endYear: number,
): OverlapData | null {
  const n = sample.length;
  const startYear = endYear - n + 1;
  const refMap = new Map<number, number>();
  ref.years.forEach((y, i) => refMap.set(y, ref.widths[i]));
  const years: number[] = [];
  const sv: number[] = [];
  const rv: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = startYear + i;
    const rvv = refMap.get(y);
    if (rvv !== undefined) {
      years.push(y);
      sv.push(sample[i]);
      rv.push(rvv);
    }
  }
  if (years.length < 3) return null;
  return { years, sample: sv, ref: rv };
}

function evaluateLag(sample: number[], ref: ReferenceChronologyLike, endYear: number,
  segWindow: number, segStep: number): DatingLag | null {
  const ov = overlapAt(sample, ref, endYear);
  if (!ov) return null;
  const ds = simpleDifference(ov.sample);
  const dr = simpleDifference(ov.ref);
  const nDiff = ds.length;
  const r = pearson(ds, dr);
  const t = tFromR(r, nDiff);
  const glk = gleichlaeufigkeit(ds, dr);

  const segmentTs: DatingLag['segmentTs'] = [];
  const firstYear = ov.years[0];
  const lastYear = ov.years[ov.years.length - 1];
  for (let ys = firstYear; ys + segWindow - 1 <= lastYear; ys += segStep) {
    const ye = ys + segWindow - 1;
    const idx: number[] = [];
    ov.years.forEach((y, i) => {
      if (y >= ys && y <= ye) idx.push(i);
    });
    if (idx.length < 12) continue;
    const sa = idx.map((i) => ov.sample[i]);
    const ra = idx.map((i) => ov.ref[i]);
    const dsa = simpleDifference(sa);
    const dra = simpleDifference(ra);
    const rr = pearson(dsa, dra);
    segmentTs.push({
      startYear: ys,
      endYear: ye,
      n: dsa.length,
      r: rr,
      t: tFromR(rr, dsa.length),
    });
  }

  return { endYear, overlap: ov.years.length, r, t, glk, segmentTs };
}

/** 主入口：扫描所有候选错位，按 t（再按 r、重叠长度）排序 */
export function crossdate(
  series: RingWidthSeries,
  reference: ReferenceChronologyLike,
  options: CrossdateOptions = {},
): DatingResult {
  const maxLag = options.maxLagYears ?? 80;
  const minOverlap = options.minOverlap ?? 20;
  const zThr = options.mismatchZThreshold ?? 1.5;
  const segWindow = options.segmentWindow ?? 50;
  const segStep = options.segmentStep ?? 25;

  const refLast = reference.years[reference.years.length - 1];
  const refFirst = reference.years[0];
  const candidates: DatingLag[] = [];
  const baseEnd = series.endYear ?? refLast;
  for (let endYear = baseEnd - maxLag; endYear <= baseEnd + maxLag; endYear++) {
    if (endYear - series.widths.length + 1 > refLast) continue;
    if (endYear < refFirst) continue;
    const lag = evaluateLag(series.widths, reference, endYear, segWindow, segStep);
    if (lag && lag.overlap >= minOverlap) candidates.push(lag);
  }
  candidates.sort((a, b) => b.t - a.t || b.r - a.r || b.overlap - a.overlap);
  const best = candidates[0];
  if (!best) {
    throw new Error('重叠年数不足，无法定年：请扩大搜索范围或检查参考年表');
  }

  // 最佳错位下的逐年偏离
  const ov = overlapAt(series.widths, reference, best.endYear)!;
  const ds = simpleDifference(ov.sample);
  const dr = simpleDifference(ov.ref);
  const ms = mean(ds);
  const ss = std(ds) || 1;
  const mr = mean(dr);
  const sr = std(dr) || 1;
  const mismatchedYears: DatingResult['mismatchedYears'] = [];
  for (let i = 0; i < ds.length; i++) {
    const zs = (ds[i] - ms) / ss;
    const zr = (dr[i] - mr) / sr;
    const opposite = Math.sign(ds[i]) !== Math.sign(dr[i]) && ds[i] !== 0 && dr[i] !== 0;
    const zDeviation = Math.abs(zs - zr);
    if (opposite && zDeviation >= zThr) {
      mismatchedYears.push({
        year: ov.years[i + 1],
        zDeviation: Math.round(zDeviation * 100) / 100,
        message: `${ov.years[i + 1]} 年宽窄变化与参考年表反向且偏离 ${zDeviation.toFixed(2)}σ，核对缺轮/伪轮`,
      });
    }
  }

  // 图像侧告警映射到年份
  const startYear = best.endYear - series.widths.length + 1;
  const anomalyWarnings: DatingResult['anomalyWarnings'] = [];
  const warnedYears = new Set<number>();
  const map: Record<RingFlagType, string> = {
    'false-ring': '伪年轮',
    'missing-ring': '缺轮',
    'weak-boundary': '弱边界',
    'dating-mismatch': '定年不符',
  };
  series.flags.forEach((f, i) => {
    if (f === 'false-ring' || f === 'missing-ring') {
      const year = startYear + i;
      warnedYears.add(year);
      anomalyWarnings.push({
        year,
        flag: f,
        message: `${year} 年图像识别提示${map[f]}，请结合定年曲线确认`,
      });
    }
  });

  // 定年侧缺轮推断：缺轮会让相邻两年宽度合并成一个异常宽轮。
  // 若某轮宽度显著高于该序列上四分位、而参考年表对应年并无同步宽年，则提示缺轮。
  // 注意：在缺轮尚未补回时整条序列按缺轮数错位，提示年份是「当前定年下的合并轮位置」，
  // 与真实缺轮年相差恰好等于累计缺轮数——人工补轮后重算即自动归位。
  const sw = [...series.widths].sort((a, b) => a - b);
  const q80 = sw[Math.floor(sw.length * 0.8)] ?? Infinity;
  const refVals = ov.ref;
  const refMean = mean(refVals);
  const refStd = std(refVals) || 1;
  ov.sample.forEach((w, i) => {
    const year = ov.years[i];
    if (warnedYears.has(year)) return;
    const refZ = (refVals[i] - refMean) / refStd;
    if (w >= q80 * 1.15 && refZ < 0.5) {
      warnedYears.add(year);
      anomalyWarnings.push({
        year,
        flag: 'missing-ring',
        message: `当前定年下 ${year} 年实测宽度异常偏大、参考年表却无对应宽年，推断该处夹有缺轮（缺轮未补时年份随整体错位），请在图上核对补轮后重算`,
      });
    }
  });
  anomalyWarnings.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

  return {
    seriesId: series.id,
    referenceId: 'reference',
    best,
    candidates: candidates.slice(0, 8),
    mismatchedYears,
    anomalyWarnings,
  };
}

/** 按定年结果给序列每一轮赋年份，返回带年份的副本 */
export function assignYears(series: RingWidthSeries, endYear: number): RingWidthSeries {
  return { ...series, endYear };
}
