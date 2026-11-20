// 基础统计与信号处理工具
export function mean(a: ArrayLike<number>): number {
  let s = 0; const n = a.length;
  for (let i = 0; i < n; i++) s += a[i];
  return n ? s / n : 0;
}

export function std(a: ArrayLike<number>, ddof = 1): number {
  const n = a.length; if (n <= ddof) return 0;
  const m = mean(a); let s = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / (n - ddof));
}

export function median(a: ArrayLike<number>): number {
  const arr = Array.from(a).sort((x, y) => x - y);
  const n = arr.length; if (!n) return 0;
  const m = n >> 1;
  return n % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

export function mad(a: ArrayLike<number>): number {
  const med = median(a);
  const dev = Array.from(a).map(v => Math.abs(v - med));
  return median(dev);
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>, n = Math.min(a.length, b.length)): number {
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  const den = Math.sqrt(saa * sbb);
  return den > 0 ? sab / den : 0;
}

export function gaussianSmooth(a: ArrayLike<number>, sigma: number): Float64Array {
  const n = a.length, out = new Float64Array(n);
  if (sigma <= 0.01) { for (let i = 0; i < n; i++) out[i] = a[i]; return out; }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= n) continue;
      s += a[idx] * k[j + r]; w += k[j + r];
    }
    out[i] = s / w;
  }
  return out;
}

/** Tukey 双权稳健均值 —— 年表合成的行里惯例 */
export function biweightMean(vals: number[]): number {
  const n = vals.length;
  if (!n) return NaN;
  if (n === 1) return vals[0];
  const med = median(vals);
  const m = mad(vals);
  if (m < 1e-12) return med;
  let sw = 0, swx = 0;
  for (const v of vals) {
    const u = (v - med) / (9 * m);
    if (Math.abs(u) < 1) { const w = (1 - u * u) ** 2; sw += w; swx += w * v; }
  }
  return sw > 0 ? swx / sw : med;
}
