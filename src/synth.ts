// 合成树芯生成器:按真实生长规律(年龄趋势+气候信号+个体噪声)造样地,
// 故意植入伪年轮与缺轮,并给出真值用于核对识别与定年精度。
import { combineChronology, Chronology } from './dendro';

export interface SynthParams {
  startYear: number; endYear: number;
  trees: number; coresPerTree: number;
  meanWidthMm: number;  // 平均轮宽
  signal: number;       // 气候信号强度 0..1
  falsePerCore: number; // 每芯植入伪年轮数
  missingPerCore: number; // 每芯植入缺轮数
  dpi: number;
  seed: number;
}

export const defaultSynthParams: SynthParams = {
  startYear: 1820, endYear: 2020, trees: 6, coresPerTree: 2,
  meanWidthMm: 1.2, signal: 0.6, falsePerCore: 2, missingPerCore: 1,
  dpi: 1200, seed: 42,
};

/** 确定性伪随机数(可复现) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 气候信号:AR(1) 年际波动 + 若干极端干旱指示年 */
export function generateClimate(n: number, rng: () => number): number[] {
  const c = new Array<number>(n);
  let v = 0;
  for (let i = 0; i < n; i++) { v = 0.45 * v + randn(rng) * 0.16; c[i] = v; }
  let i = 10 + Math.floor(rng() * 10);
  while (i < n - 3) {
    const sev = 0.35 + rng() * 0.25;
    c[i] -= sev; c[i + 1] -= sev * 0.4;
    i += 12 + Math.floor(rng() * 18);
  }
  return c.map(x => 1 + x);
}

export interface FalseRingSpec { year: number; posFrac: number; depth: number; }

export interface CoreModel {
  name: string;
  firstYear: number;
  years: number[];        // 实际存在的轮对应的日历年(缺轮已剔除)
  widthsMm: number[];     // 与 years 对齐
  ewFrac: number[];       // 早材占比
  trueWidthsMm: number[]; // 全部年份的真轮宽(含被缺轮剔除的年),用于建标准年表与自检
  missingYears: number[];
  falseRings: FalseRingSpec[];
}

export function generateCore(
  name: string, climate: number[], startYear: number,
  rng: () => number, p: SynthParams, treeSens: number,
): CoreModel {
  const n = climate.length;
  const widths: number[] = [], ewF: number[] = [], years: number[] = [];
  let ar = 0;
  for (let i = 0; i < n; i++) {
    // 年龄趋势:负指数衰减 + 基线
    const trend = p.meanWidthMm * (0.35 + 0.65 * Math.exp(-i / 90));
    ar = 0.5 * ar + randn(rng) * 0.12;
    let w = trend * (1 + treeSens * p.signal * (climate[i] - 1) + ar * (1.2 - p.signal));
    widths.push(Math.max(0.06, w));
    ewF.push(0.68 + rng() * 0.15);
    years.push(startYear + i);
  }
  // 植入缺轮(局部缺轮:该年在此半径上无轮)
  const missIdx = new Set<number>();
  const missingYears: number[] = [];
  let guard = 0;
  while (missingYears.length < p.missingPerCore && guard++ < 200) {
    const k = 5 + Math.floor(rng() * (n - 10));
    if (missIdx.has(k)) continue;
    missIdx.add(k); missingYears.push(years[k]);
  }
  // 植入伪年轮(早材内密度波动)
  const frIdx = new Set<number>();
  const falseRings: FalseRingSpec[] = [];
  guard = 0;
  while (falseRings.length < p.falsePerCore && guard++ < 200) {
    const k = 5 + Math.floor(rng() * (n - 10));
    if (missIdx.has(k) || frIdx.has(k)) continue;
    frIdx.add(k);
    falseRings.push({ year: years[k], posFrac: 0.25 + rng() * 0.35, depth: 0.5 + rng() * 0.25 });
  }
  const w2: number[] = [], y2: number[] = [], e2: number[] = [];
  for (let i = 0; i < n; i++) {
    if (missIdx.has(i)) continue;
    w2.push(widths[i]); y2.push(years[i]); e2.push(ewF[i]);
  }
  return {
    name, firstYear: startYear, years: y2, widthsMm: w2, ewFrac: e2,
    trueWidthsMm: widths, missingYears, falseRings,
  };
}

/**
 * 由模型直接生成 1D 密度剖面(与渲染图像同模型),
 * 供无浏览器环境下测试边界识别与自检。
 */
export function synthProfile(model: CoreModel, pxPerMm: number, rng: () => number): Float64Array {
  const totalMm = model.widthsMm.reduce((a, b) => a + b, 0);
  const cap = Math.max(8, Math.round(totalMm * pxPerMm) + 4);
  const out = new Float64Array(cap);
  const frByYear = new Map(model.falseRings.map(f => [f.year, f]));
  // 累积轮宽 → 各轮起止采样点(一次性量化到采样网格,避免逐轮累积漂移)
  const cum: number[] = [0];
  for (const w of model.widthsMm) cum.push(cum[cum.length - 1] + w);
  let noise = 0;
  for (let r = 0; r < model.years.length; r++) {
    const s0 = Math.round(cum[r] * pxPerMm);
    const s1 = Math.round(cum[r + 1] * pxPerMm);
    const w = model.widthsMm[r];
    const ew = w * model.ewFrac[r];
    const ewBase = 52 + rng() * 10;
    const lwTop = 160 + rng() * 25;
    const fr = frByYear.get(model.years[r]);
    for (let i = s0; i < s1 && i < cap; i++) {
      const local = i / pxPerMm - cum[r]; // mm,轮内位置
      let d: number;
      if (local < ew) {
        d = ewBase + (local / ew) * 18; // 早材缓慢加深
        if (fr) {
          const fc = ew * fr.posFrac;
          const fw = 0.05 + 0.05 * fr.depth; // 伪轮暗带半宽 mm
          const infl = Math.max(0, 1 - Math.abs(local - fc) / fw);
          const target = ewBase + (lwTop - ewBase) * fr.depth;
          d += (target - d) * Math.pow(infl, 1.5) * 0.9;
        }
      } else {
        const f = (local - ew) / Math.max(w - ew, 1e-6);
        d = ewBase + 18 + (lwTop - ewBase - 18) * Math.min(1, f * 2.2);
      }
      noise = 0.6 * noise + randn(rng) * 3;
      out[i] = d + noise + randn(rng) * 2.5;
    }
  }
  const n = Math.round(cum[cum.length - 1] * pxPerMm);
  return out.subarray(0, Math.min(n, cap)) as Float64Array;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** 密度 → 木色(早材浅黄褐 → 晚材深褐) */
function woodColor(d: number): [number, number, number] {
  const t = clamp((d - 45) / 130, 0, 1);
  return [226 + (140 - 226) * t, 198 + (92 - 198) * t, 152 + (50 - 152) * t];
}

/** 渲染合成树芯扫描图(髓心在左,树皮在右,边界带自然波动) */
export function renderCore(model: CoreModel, pxPerMm: number, rng: () => number, heightPx = 720): HTMLCanvasElement {
  const prof = synthProfile(model, pxPerMm, rng);
  const W = prof.length + 40;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = heightPx;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, heightPx);
  const data = img.data;
  const ph1 = rng() * 6.28, ph2 = rng() * 6.28;
  for (let y = 0; y < heightPx; y++) {
    const off = 8 * Math.sin(y / 53 + ph1) + 4 * Math.sin(y / 17 + ph2);
    const illum = 1 + 0.05 * Math.sin(y / 200 + ph1);
    for (let x = 0; x < W; x++) {
      const sx = clamp(Math.round(x - 20 - off), 0, prof.length - 1);
      let d = prof[sx] * illum + (rng() - 0.5) * 9;
      // 早材内管胞斑点
      if (d < 90 && rng() < 0.004) d += 25 * rng();
      const [r, g, b] = woodColor(d);
      const p = (y * W + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export interface SynthSite {
  cores: CoreModel[];
  master: Chronology;   // 用全部真轮宽合成的"所里标准年表"
  pxPerMm: number;
}

export function generateSite(p: SynthParams): SynthSite {
  const rng = mulberry32(p.seed);
  const nY = p.endYear - p.startYear + 1;
  const climate = generateClimate(nY, rng);
  const cores: CoreModel[] = [];
  for (let t = 0; t < p.trees; t++) {
    const sens = 1 + randn(rng) * 0.12;
    for (let c = 0; c < p.coresPerTree; c++) {
      cores.push(generateCore(`T${t + 1}${String.fromCharCode(65 + c)}`, climate, p.startYear, rng, p, sens));
    }
  }
  const master = combineChronology(
    cores.map(m => ({ widths: m.trueWidthsMm, firstYear: m.firstYear })), 'ma11');
  return { cores, master, pxPerMm: p.dpi / 25.4 };
}
