/**
 * 可复现随机数与基础统计。所有合成数据走种子化 RNG，保证测试与演示可重复。
 */

/** mulberry32 —— 轻量可复现 PRNG，返回 [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串哈希到 32 位整数（给样地/树名生成稳定种子） */
export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 标准正态近似（Box–Muller），基于给定均匀 RNG */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function std(xs: number[], ddof = 1): number {
  const n = xs.length;
  if (n <= ddof) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - ddof));
}

/** Pearson 相关系数；常量序列返回 0 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** 一维高斯平滑（边界反射填充），sigma 单位为采样点 */
export function gaussianSmooth(xs: number[], sigma: number): number[] {
  if (sigma <= 0) return xs.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let norm = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    norm += w;
  }
  const out = new Array<number>(xs.length);
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      let j = i + k;
      if (j < 0) j = -j - 1;
      if (j >= n) j = 2 * n - j - 1;
      acc += xs[Math.max(0, Math.min(n - 1, j))] * kernel[k + radius];
    }
    out[i] = acc / norm;
  }
  return out;
}

/** 中心化一阶差分（COFECHA 风格：x[t+1]-x[t-1]），长度 n-2 */
export function firstDifference(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length - 1; i++) out.push(xs[i + 1] - xs[i - 1]);
  return out;
}

/** 普通一阶差分（x[t]-x[t-1]），长度 n-1，用于 GLK */
export function simpleDifference(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i] - xs[i - 1]);
  return out;
}

/** 数值保留到 0.01 mm（行业惯例：量到百分之一毫米） */
export function roundWidth(xMm: number): number {
  return Math.round(xMm * 100) / 100;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function linspace(start: number, end: number, n: number): number[] {
  if (n <= 1) return [start];
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}
