// 年轮边界自动识别:密度剖面 → 边界 → 早材/晚材划分 → 伪年轮判别
import { gaussianSmooth, median, mad } from './util';

export interface DetectOptions {
  minWidthS: number;   // 最小轮宽(采样点)
  smoothSigma: number; // 高斯平滑 σ(采样点)
  threshK: number;     // 边界导数阈值系数(稳健σ倍数)
  falseK: number;      // 伪年轮灵敏度 0..1,越大越敏感
}

export interface DetRing {
  startS: number; endS: number; ewEndS: number;
  falseRing: boolean; falseScore: number;
}

export interface SegFeat { ewEnd: number; lwMax: number; ewMin: number; }

export interface FalseBandMark { pos: number; score: number; }

/**
 * 轮内伪年轮扫描:在有效年轮的早材区内找"密度鼓包",
 * 用于捕捉弱到不足以形成边界候选的伪年轮(只做标记提醒,不改轮数)。
 */
export function scanFalseBands(
  profile: ArrayLike<number>, rings: { startS: number; endS: number; ewEndS: number }[],
  smoothSigma = 2,
): FalseBandMark[] {
  const s = gaussianSmooth(profile, smoothSigma);
  const marks: FalseBandMark[] = [];
  for (const r of rings) {
    const a = r.startS, b = r.ewEndS;
    const len = r.endS - r.startS;
    if (b - a < 6) continue;
    const i0 = Math.ceil(a + 0.12 * len), i1 = Math.floor(b - 0.03 * len);
    if (i1 - i0 < 4) continue;
    const f = segFeatures(s, r.startS, r.endS);
    const ringContrast = f.lwMax - f.ewMin;
    if (ringContrast <= 0) continue;
    // 早材区最高峰及其后的谷
    let peak = -1e9, peakPos = i0;
    for (let i = i0; i <= i1; i++) if (s[i] > peak) { peak = s[i]; peakPos = i; }
    let minAfter = 1e9;
    for (let i = peakPos; i <= i1; i++) minAfter = Math.min(minAfter, s[i]);
    const contrast = peak - minAfter;
    const level = peak - f.ewMin;
    if (contrast >= 0.15 * ringContrast && level >= 0.20 * ringContrast) {
      marks.push({ pos: peakPos, score: Math.min(1, contrast / ringContrast) });
    }
  }
  return marks;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 计算一段 [a,b] 的特征:早材/晚材分界、晚材峰值密度、早材谷值密度(在平滑剖面上) */
export function segFeatures(s: ArrayLike<number>, a: number, b: number): SegFeat {
  const n = s.length;
  const i0 = Math.max(0, Math.ceil(a)), i1 = Math.min(n - 1, Math.floor(b));
  if (i1 - i0 < 2) return { ewEnd: (a + b) / 2, lwMax: 0, ewMin: 0 };
  const outer = i0 + Math.floor((i1 - i0) * 0.4);
  let lwMax = -1e9, maxPos = outer;
  for (let i = outer; i <= i1; i++) if (s[i] > lwMax) { lwMax = s[i]; maxPos = i; }
  let ewMin = 1e9;
  for (let i = i0; i <= Math.max(i0, maxPos); i++) ewMin = Math.min(ewMin, s[i]);
  const thr = ewMin + 0.5 * (lwMax - ewMin);
  let p = i0;
  for (let i = maxPos; i >= i0; i--) { if (s[i] < thr) { p = i; break; } }
  let ewEnd = p;
  if (p + 1 <= i1) {
    const f = (thr - s[p]) / ((s[p + 1] - s[p]) || 1e-9);
    ewEnd = p + clamp01(f);
  }
  return { ewEnd, lwMax, ewMin };
}

/**
 * 自动识别年轮边界。
 * 沿生长方向(髓心→树皮),晚材密度高、早材密度低,
 * 年轮边界 = 密度的陡降沿(负向导数极值),亚采样抛物线细化到亚像素。
 */
export function detectRings(profile: ArrayLike<number>, o: DetectOptions): DetRing[] {
  const n = profile.length;
  if (n < 8) return [];
  const s = gaussianSmooth(profile, o.smoothSigma);
  // 密度下降幅度(中心差分取负)
  const neg = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) neg[i] = (s[i - 1] - s[i + 1]) / 2;
  const med = median(neg), sc = 1.4826 * mad(neg) || 1e-6;
  const thr = med + o.threshK * sc;
  // 候选边界:局部极大且超阈
  const cand: { pos: number; str: number }[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (neg[i] > thr && neg[i] >= neg[i - 1] && neg[i] >= neg[i + 1] && neg[i] > neg[i - 2] && neg[i] > neg[i + 2]) {
      const y0 = neg[i - 1], y1 = neg[i], y2 = neg[i + 1];
      const den = y0 - 2 * y1 + y2;
      const off = den !== 0 ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den)) : 0;
      cand.push({ pos: i + off, str: y1 });
    }
  }
  // 最小轮宽约束:按强度贪心保留
  cand.sort((a, b) => b.str - a.str);
  const kept: { pos: number; str: number }[] = [];
  for (const c of cand) if (kept.every(k => Math.abs(k.pos - c.pos) >= o.minWidthS)) kept.push(c);
  kept.sort((a, b) => a.pos - b.pos);

  const edges = [0, ...kept.map(k => k.pos), n - 1];
  // 特征用更轻的平滑:重平滑会把窄轮的晚材峰与邻轮早材谷糊在一起,导致真边界被误杀
  const sFeat = gaussianSmooth(profile, Math.min(0.8, o.smoothSigma * 0.5));
  interface Seg extends SegFeat { a: number; b: number; lwW: number; ewW: number; }
  const segs: Seg[] = [];
  for (let j = 0; j < edges.length - 1; j++) {
    const a = edges[j], b = edges[j + 1];
    if (b - a < 2) continue;
    const f = segFeatures(sFeat, a, b);
    segs.push({ a, b, ...f, lwW: b - f.ewEnd, ewW: f.ewEnd - a });
  }
  if (!segs.length) return [];

  // 伪年轮判别:伪年轮是早材内的密度波动,被误分成"一轮"后,
  // 其"晚材"不够黑、边界跌得不深;且伪边界之后几乎没有正常早材相
  // (紧跟着就进入真晚材)——早材宽度与局部(±8 轮)中位数比较,避免误杀老树的窄轮。
  const lwTyp = median(segs.map(g => g.lwMax));
  const drops: number[] = [];
  for (let j = 0; j < segs.length - 1; j++) drops.push(segs[j].lwMax - segs[j + 1].ewMin);
  const dropTyp = median(drops) || 1e-9;
  const theta = 0.55 - 0.3 * clamp01(o.falseK); // 灵敏度越高阈值越低

  return segs.map((g, j) => {
    let score = 0;
    if (j < segs.length - 1) {
      const lo = Math.max(0, j - 8), hi = Math.min(segs.length - 1, j + 8);
      const localEwTyp = median(segs.slice(lo, hi + 1).map(x => x.ewW));
      const drop = g.lwMax - segs[j + 1].ewMin;
      const f1 = lwTyp > 0 ? clamp01((0.85 - g.lwMax / lwTyp) / 0.3) : 0; // 晚材不够黑
      const f2 = clamp01((0.8 - drop / dropTyp) / 0.35);                  // 跌得不够深
      const f3 = localEwTyp > 0 ? clamp01(1 - segs[j + 1].ewW / (0.55 * localEwTyp)) : 0; // 下段早材缺失
      score = 0.40 * f1 + 0.40 * f2 + 0.20 * f3;
    }
    return {
      startS: g.a, endS: g.b, ewEndS: g.ewEnd,
      falseRing: score > theta, falseScore: score,
    };
  });
}
