/**
 * 年轮边界识别。
 *
 * 输入沿测量条带平均出的灰度剖面（0..255，值越大越亮；针叶树晚材色深），
 * 输出带置信度与告警的边界列表。处理链：
 *   1. 基线校正（高通，去掉光照不均）+ 高斯平滑
 *   2. 梯度计算，晚材→早材过渡处为强正梯度（暗→亮）
 *   3. 自适应阈值的峰值检测，合并过近候选，得到「真边界」候选
 *   4. 两条边界之间定位晚材带（局部最暗区段），算早/晚材宽度
 *   5. 年内次级暗带 → 伪年轮提示；异常宽轮 + 弱内部结构 → 缺轮提示
 *
 * 纯函数、不碰 DOM，扫描图与合成图共用同一条管线，方便拿合成图的真值核对。
 */
import { gaussianSmooth, mean, std, clamp, roundWidth } from './math';
import type { RingBoundary, RingFlag } from './types';

export interface DetectionOptions {
  /** 平滑强度（采样点），默认按剖面长度自适应 */
  smoothSigma?: number;
  /** 梯度阈值（以梯度标准差的倍数计） */
  gradientThresholdZ?: number;
  /** 两个边界之间允许的最小间距（采样点） */
  minPeakDistance?: number;
  /** 判缺轮：宽度超过局地中位宽的倍数 */
  missingWidthFactor?: number;
  /** 判伪轮：次级暗带的相对深度阈值 0..1 */
  falseRingDepthRatio?: number;
}

export interface DetectionResult {
  boundaries: RingBoundary[];
  /** 每条边界在剖面上的采样点下标（与 boundaries 等长、同序） */
  peakPositions: number[];
  /** 处理后的灰度剖面（调试/绘图用） */
  profile: number[];
  /** 梯度剖面 */
  gradient: number[];
  /** 每个采样点的晚材隶属度 0..1（用于早晚材分割与绘图） */
  latewoodMembership: number[];
  /** 年轮级测量（不含年份，定年前 year=null） */
  rings: DetectedRing[];
}

export interface DetectedRing {
  index: number;
  innerBoundaryId: string;
  outerBoundaryId: string;
  totalWidth: number;
  earlywoodWidth: number;
  latewoodWidth: number;
  latewoodRatio: number;
  /** 晚材带在剖面上的位置（采样点区间） */
  latewoodRange: { start: number; end: number } | null;
  flags: RingFlag[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}
/** 供测试重置 id */
export function resetIdCounter(): void {
  idCounter = 0;
}

/** 从图像条带提取平均灰度剖面。gray 为行优先灰度数组 */
export function extractProfile(
  gray: Uint8ClampedArray | number[],
  width: number,
  height: number,
  centerY: number,
  bandHalfHeight: number,
): number[] {
  const y0 = Math.max(0, Math.round(centerY - bandHalfHeight));
  const y1 = Math.min(height - 1, Math.round(centerY + bandHalfHeight));
  const profile = new Array<number>(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let cnt = 0;
    for (let y = y0; y <= y1; y++) {
      sum += gray[y * width + x];
      cnt++;
    }
    profile[x] = sum / cnt;
  }
  return profile;
}

/** 高通基线：减去大尺度平滑分量，消除扫描光照不均；再整体抬到非负 */
function baselineCorrect(p: number[], sigma: number): number[] {
  const base = gaussianSmooth(p, sigma);
  const out = p.map((v, i) => v - base[i]);
  const m = mean(out);
  return out.map((v) => v - m + 128);
}

/** 中心化差分梯度 */
function gradient(p: number[]): number[] {
  const g = new Array<number>(p.length).fill(0);
  for (let i = 1; i < p.length - 1; i++) g[i] = (p[i + 1] - p[i - 1]) / 2;
  return g;
}

/** 在正梯度序列上做自适应阈值峰值检测，返回峰值采样点下标（升序） */
function findPeaks(g: number[], thresholdZ: number, minDist: number): number[] {
  const gm = mean(g);
  const gs = std(g) || 1;
  const thr = gm + thresholdZ * gs;
  const candidates: { i: number; v: number }[] = [];
  for (let i = 1; i < g.length - 1; i++) {
    if (g[i] > thr && g[i] >= g[i - 1] && g[i] >= g[i + 1]) {
      candidates.push({ i, v: g[i] });
    }
  }
  candidates.sort((a, b) => b.v - a.v);
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.every((j) => Math.abs(j - c.i) >= minDist)) picked.push(c.i);
  }
  picked.sort((a, b) => a - b);
  return picked;
}

/**
 * 周期性先验检测（年轮的本质是准周期结构）。
 * 顺序跟踪：先由强种子峰的间距中位数估出年轮周期 T，
 * 从第一个强峰出发每个周期开搜索窗，窗内选梯度最强的局部峰，
 * 并用实测间距做指数平滑更新周期——弱边界靠周期约束被找回，
 * 伪轮暗带处于两轮之间且梯度弱于真边界，不会落峰。
 */
function findPeriodicPeaks(g: number[], minDist: number, seedPeaks: number[]): number[] {
  const n = g.length;
  if (seedPeaks.length === 0) return seedPeaks;

  // 周期估计：强种子峰相邻间距的中位数（对漏检导致的倍间距稳健）
  const sortedSeeds = [...seedPeaks].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedSeeds.length; i++) gaps.push(sortedSeeds[i] - sortedSeeds[i - 1]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  let bestT: number;
  if (sortedGaps.length >= 3) {
    bestT = sortedGaps[Math.floor(sortedGaps.length / 2)];
  } else {
    // 种子太少时用归一化自相关兜底（先中心化，避免低频包络主导）
    const gm = mean(g);
    const gc = g.map((v) => v - gm);
    let bestAc = -Infinity;
    bestT = minDist * 4;
    for (let t = minDist * 2; t < n / 4; t++) {
      let s = 0;
      let cnt = 0;
      for (let i = 0; i + t < n; i += 2) {
        s += gc[i] * gc[i + t];
        cnt++;
      }
      const ac = s / cnt;
      if (ac > bestAc) {
        bestAc = ac;
        bestT = t;
      }
    }
  }
  if (bestT <= minDist) return seedPeaks;

  const minGap = Math.max(minDist, Math.round(bestT * 0.45));
  const maxGap = Math.round(bestT * 1.9);

  const localPeak = (lo: number, hi: number): { i: number; v: number } | null => {
    let best: { i: number; v: number } | null = null;
    for (let i = Math.max(1, lo); i <= Math.min(n - 2, hi); i++) {
      if (g[i] >= g[i - 1] && g[i] >= g[i + 1] && (!best || g[i] > best.v)) {
        best = { i, v: g[i] };
      }
    }
    return best;
  };

  const picked: number[] = [];
  const pushPeak = (i: number): boolean => {
    if (picked.length === 0 || i - picked[picked.length - 1] >= minGap) {
      picked.push(i);
      return true;
    }
    return false;
  };

  // 起点：最靠左的强种子峰
  const firstSeed = sortedSeeds[0];

  // 向左（髓心方向）补齐，单窗失败时放宽一次再放弃
  const leftPart: number[] = [];
  let period = bestT;
  let cursor = firstSeed;
  for (let guard = 0; guard < n; guard++) {
    const expect = cursor - period;
    if (expect < 1) break;
    let peak = localPeak(expect - Math.round(period * 0.4), expect + Math.round(period * 0.4));
    if (!peak || cursor - peak.i < minGap || cursor - peak.i > maxGap) {
      peak = localPeak(expect - Math.round(period * 0.65), expect + Math.round(period * 0.65));
    }
    if (!peak || cursor - peak.i < minGap || cursor - peak.i > maxGap) break;
    leftPart.push(peak.i);
    period = 0.7 * period + 0.3 * (cursor - peak.i);
    cursor = peak.i;
  }
  leftPart.reverse().forEach(pushPeak);
  pushPeak(firstSeed);

  // 向右顺序跟踪：以每个强种子峰为「锚点」，锚点之间靠周期补峰，
  // 任何一段跟丢都能在下一个锚点重新同步，不会整条中断。
  period = bestT;
  cursor = firstSeed;
  const anchors = sortedSeeds.filter((s) => s > firstSeed);
  let anchorIdx = 0;
  for (let guard = 0; guard < n; guard++) {
    const expect = cursor + period;
    if (expect >= n - 1) break;
    let peak = localPeak(expect - Math.round(period * 0.4), expect + Math.round(period * 0.4));
    if (!peak || peak.i - cursor < minGap || peak.i - cursor > maxGap) {
      peak = localPeak(expect - Math.round(period * 0.65), expect + Math.round(period * 0.65));
    }
    // 若下一个锚点就在附近，优先用锚点校正
    if (anchorIdx < anchors.length) {
      const anchor = anchors[anchorIdx];
      if (anchor - cursor <= maxGap && anchor - cursor >= minGap) {
        peak = { i: anchor, v: g[anchor] };
        anchorIdx++;
      } else if (anchor <= expect + period * 0.5) {
        anchorIdx++;
      }
    }
    if (!peak) break;
    const gap = peak.i - cursor;
    if (gap < minGap || gap > maxGap) break;
    if (!pushPeak(peak.i)) break;
    period = 0.7 * period + 0.3 * gap;
    cursor = peak.i;
  }

  // 强种子峰若被跟踪漏掉（异常宽区间），补入后重排
  const merged = new Set(picked);
  for (const s of seedPeaks) {
    if ([...merged].every((p) => Math.abs(p - s) >= minGap)) merged.add(s);
  }
  return [...merged].sort((a, b) => a - b);
}

/**
 * 在一个年轮区间内分割晚材：
 * 晚材是靠外侧（靠近外边界）的暗带。取区间内亮度低于 (均值-k*标准差) 的连续区段，
 * 选紧邻外边界、且占比合理的那一段。
 */
function segmentLatewood(
  profile: number[],
  lo: number,
  hi: number,
): { start: number; end: number; membership: number[] } | null {
  const seg = profile.slice(lo, hi + 1);
  if (seg.length < 4) return null;
  const m = mean(seg);
  const s = std(seg) || 1;
  const cutoff = m - 0.5 * s;
  // 隶属度：越暗越接近 1
  const membership = seg.map((v) => clamp((cutoff - v) / (s + 1e-9) + 0.5, 0, 1));
  // 从外向内收：找到连续晚材区段
  let end = seg.length - 1;
  while (end > 0 && membership[end] < 0.5) end--;
  let start = end;
  while (start > 0 && membership[start - 1] >= 0.5) start--;
  if (end - start < 1) return null;
  // 晚材占整轮比例限制在 5%..80%，异常时夹取，避免把整轮吞掉
  const len = seg.length;
  if (end - start + 1 > 0.8 * len) start = Math.round(hi - lo - 0.8 * len) + lo - lo;
  return { start: lo + start, end: lo + end, membership };
}

/** 主入口：灰度剖面 → 边界 + 年轮测量 */
export function detectBoundaries(
  rawProfile: number[],
  options: DetectionOptions = {},
): DetectionResult {
  const n = rawProfile.length;
  const sigma = options.smoothSigma ?? Math.max(1.5, n / 400);
  const gradZ = options.gradientThresholdZ ?? 0.5;
  const minDist = options.minPeakDistance ?? Math.max(4, Math.round(n / 250));
  const missingFactor = options.missingWidthFactor ?? 2.1;

  const profile = baselineCorrect(rawProfile, sigma * 8);
  const smoothed = gaussianSmooth(profile, sigma);
  // 轻平滑剖面：保留伪轮这类窄暗带，专供伪轮判别
  const fineSmoothed = gaussianSmooth(profile, Math.max(0.8, sigma * 0.35));
  const grad = gradient(smoothed);
  const seedPeaks = findPeaks(grad, gradZ, minDist);
  // 周期性先验补全弱边界；种子峰为强边界骨架
  const peakIdx = findPeriodicPeaks(grad, minDist, seedPeaks);

  // 边界：峰值点即「晚材结束 → 次年早材开始」的位置
  const gm = mean(grad);
  const gs = std(grad) || 1;
  const boundaries: RingBoundary[] = peakIdx.map((i) => {
    const z = (grad[i] - gm) / gs;
    const confidence = clamp(0.5 + z / 6, 0.2, 0.99);
    const flags: RingFlag[] = [];
    if (confidence < 0.62) {
      flags.push({
        type: 'weak-boundary',
        strength: 1 - confidence,
        message: '边界梯度偏弱，建议人工核对',
      });
    }
    return {
      id: nextId('b'),
      distance: 0, // 由调用方按 scaleMmPerPx 回填
      year: null,
      confidence,
      origin: 'auto' as const,
      flags,
    };
  });

  // 晚材分割 + 年轮测量 + 伪轮/缺轮判别
  const rings: DetectedRing[] = [];
  const latewoodMembership = new Array<number>(n).fill(0);
  const bounds = [0, ...peakIdx, n - 1];
  const widthsPx: number[] = [];
  for (let k = 1; k < bounds.length - 1; k++) {
    const lo = bounds[k - 1] === 0 && k === 1 ? 0 : bounds[k];
    const hi = bounds[k + 1];
    widthsPx.push(hi - lo);
  }
  const sortedW = [...widthsPx].sort((a, b) => a - b);
  const medianW = sortedW[Math.floor(sortedW.length / 2)] || minDist * 2;

  let ringIdx = 0;
  for (let k = 0; k < boundaries.length; k++) {
    const lo = k === 0 ? 0 : peakIdx[k - 1];
    const hi = peakIdx[k];
    const flags: RingFlag[] = [];

    // 伪年轮：早材内部出现窄暗谷（一条未贯穿的弱晚材带）。
    // 在轻平滑剖面上、排除外侧真晚材区段后寻找局部极小。
    const lw = segmentLatewood(smoothed, lo, hi);
    if (lw) {
      for (let x = lw.start; x <= lw.end; x++) {
        latewoodMembership[x] = Math.max(latewoodMembership[x], lw.membership[x - lo]);
      }
    }
    const searchEnd = lw ? Math.max(lo + 2, lw.start - 2) : hi - 2;
    // 局部基线：在每个点两侧取小邻域亮度的高位均值（亮的早材背景），
    // 这样晚材整体斜坡不会把 σ 撑大，窄暗谷的对比度才显出来。
    const halfWin = Math.max(3, Math.round((hi - lo) * 0.12));
    let innerValley = false;
    for (let x = lo + halfWin; x < searchEnd; x++) {
      const left = fineSmoothed.slice(Math.max(lo, x - halfWin), x - 1);
      const right = fineSmoothed.slice(x + 2, Math.min(hi, x + halfWin) + 1);
      const neighbors = [...left, ...right].sort((a, b) => b - a);
      const baseline = mean(neighbors.slice(0, Math.max(2, Math.floor(neighbors.length * 0.6))));
      const localNoise = std(neighbors) || 1;
      const dip = baseline - fineSmoothed[x];
      const isLocalMin = fineSmoothed[x] <= fineSmoothed[x - 1] && fineSmoothed[x] <= fineSmoothed[x + 1];
      // 凹陷比局部噪声深 1.5 倍、且至少 3 个亮度单位（抗扫描噪声）
      if (isLocalMin && dip > Math.max(3, 1.5 * localNoise)) {
        innerValley = true;
        break;
      }
    }
    if (innerValley) {
      flags.push({
        type: 'false-ring',
        strength: 0.75,
        message: '早材内存在窄暗带（未贯穿晚材线），疑似伪年轮，请确认是否拆分为两轮',
      });
    }

    const wPx = hi - lo;
    // 第一轮靠髓心、天然偏宽，不参与缺轮判定
    if (k > 0 && wPx > missingFactor * medianW) {
      flags.push({
        type: 'missing-ring',
        strength: clamp((wPx / medianW - 1) / 2, 0.2, 0.95),
        message: `该轮宽度异常（约为中位轮宽的 ${(wPx / medianW).toFixed(1)} 倍），疑似夹有缺轮`,
      });
    }

    const totalWidth = roundWidth(wPx);
    let latewoodWidth = 0;
    let earlywoodWidth = totalWidth;
    let latewoodRange: { start: number; end: number } | null = null;
    if (lw) {
      latewoodRange = { start: lw.start, end: lw.end };
      latewoodWidth = roundWidth(lw.end - lw.start + 1);
      earlywoodWidth = roundWidth(Math.max(0, totalWidth - latewoodWidth));
    }
    rings.push({
      index: ringIdx++,
      innerBoundaryId: k === 0 ? 'pith' : boundaries[k - 1].id,
      outerBoundaryId: boundaries[k].id,
      totalWidth,
      earlywoodWidth,
      latewoodWidth,
      latewoodRatio: totalWidth > 0 ? latewoodWidth / totalWidth : 0,
      latewoodRange,
      flags,
    });

    // 把年轮级告警同步挂到外边界上，UI 点边界即可看到
    for (const f of flags) {
      if (!boundaries[k].flags.some((x) => x.type === f.type)) boundaries[k].flags.push(f);
    }
  }

  return { boundaries, peakPositions: peakIdx, profile: smoothed, gradient: grad, latewoodMembership, rings };
}
