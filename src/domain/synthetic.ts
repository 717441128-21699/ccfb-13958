/**
 * 合成树芯扫描图（带真值），用于核对边界识别与交叉定年。
 *
 * 生长模型（年宽 w_t，单位 mm）：
 *   w_t = 负指数年龄趋势 · (1 + β·气候响应_t + ε_t)
 * 气候响应在「样地主年表」里共享（含低频振荡、年际自相关与标志性窄/宽年），
 * 每棵树再叠加个体噪声与小幅相位/增益差异——符合真实样地「共同信号 + 个体差异」。
 *
 * 刻意注入：
 *  - 缺轮：该年不生成晚材边界（宽度并进相邻年），真值里记录年份；
 *  - 伪轮：年内多画一条未贯穿条带的弱晚材线，真值里记录年份与像素位置。
 * 输出灰度位图（Uint8ClampedArray）+ 真值表，浏览器端再编码成 PNG dataURL。
 */
import { mulberry32, gaussian, clamp, roundWidth } from './math';
import type { RingFlagType } from './types';

export interface SyntheticAnomaly {
  /** 该异常对应的日历年（若已给定 endYear） */
  year: number | null;
  /** 年轮序号（从 0，按「实际形成的年」计数，缺轮不占序号） */
  ringIndex: number;
  type: Extract<RingFlagType, 'false-ring' | 'missing-ring'>;
  /** 伪轮在图上的 x 像素位置（缺轮为 null） */
  xPx: number | null;
  message: string;
}

export interface SyntheticCore {
  /** 位图灰度，行优先，长度 width*height */
  gray: Uint8ClampedArray;
  width: number;
  height: number;
  /** 真值边界 x 像素（晚材末端），不含缺轮 */
  trueBoundaryX: number[];
  /** 真值年宽 mm（含被合并的缺轮年份宽度） */
  trueWidthsMm: number[];
  /** 每个「日历年」一格的年宽（缺轮年为 0），用于和主年表严格对齐核对 */
  calendarWidthsMm: number[];
  /** 每个日历年「本应长出」的年宽（缺轮年也非 0），模拟人工补轮时的估算值 */
  calendarIdealWidthsMm: number[];
  /** 完整日历年序列 */
  calendarYears: number[];
  anomalies: SyntheticAnomaly[];
  /** 标定：像素 → 毫米 */
  scaleMmPerPx: number;
  /** 晚材带 x 区间（每轮） */
  latewoodRanges: { start: number; end: number }[];
}

export interface GeneratePlotOptions {
  plotId: string;
  /** 日历年范围 */
  startYear: number;
  endYear: number;
  treeCount: number;
  /** 每棵树取几根芯 */
  coresPerTree: number;
  /** 每根芯注入缺轮数（随机选年，避开标记年） */
  missingRingsPerCore: number;
  /** 每根芯注入伪轮数 */
  falseRingsPerCore: number;
  seed: number;
}

/** 样地共享气候信号（指数，1.0 为平均） */
export function generateClimateSignal(
  startYear: number,
  endYear: number,
  rng: () => number,
): { years: number[]; signal: number[]; markerYears: { year: number; kind: 'narrow' | 'wide' }[] } {
  const years: number[] = [];
  const signal: number[] = [];
  const markerYears: { year: number; kind: 'narrow' | 'wide' }[] = [];
  let ar = 0;
  // 预设标志性年份（行业里交叉定年最依赖的特征年）
  const narrowSet = new Set([startYear + 7, startYear + 18, startYear + 31, startYear + 47]);
  const wideSet = new Set([startYear + 12, startYear + 38]);
  for (let y = startYear; y <= endYear; y++) {
    const t = y - startYear;
    const lowFreq = 0.12 * Math.sin((2 * Math.PI * t) / 27) + 0.08 * Math.sin((2 * Math.PI * t) / 11);
    ar = 0.35 * ar + 0.65 * gaussian(rng);
    let v = 1 + lowFreq + 0.22 * ar;
    if (narrowSet.has(y)) {
      v *= 0.45;
      markerYears.push({ year: y, kind: 'narrow' });
    }
    if (wideSet.has(y)) {
      v *= 1.55;
      markerYears.push({ year: y, kind: 'wide' });
    }
    years.push(y);
    signal.push(clamp(v, 0.25, 2.2));
  }
  return { years, signal, markerYears };
}

/** 单棵树的「理想」日历年宽（mm），含树龄趋势与个体噪声 */
function treeCalendarWidths(
  years: number[],
  climate: number[],
  rng: () => number,
  beta: number,
  baseWidth: number,
): number[] {
  // 髓心年龄从 5 年开始（模拟采样时常缺幼龄段）
  const age0 = 5 + Math.floor(rng() * 8);
  const k = 0.012 + rng() * 0.01;
  return years.map((_, i) => {
    const age = age0 + i;
    const ageTrend = baseWidth * (0.55 * Math.exp(-k * age) + 0.45);
    const noise = 0.12 * gaussian(rng);
    const w = ageTrend * (1 + beta * (climate[i] - 1) + noise);
    return Math.max(0.08, w);
  });
}

/** 生成一根合成芯 */
export function generateSyntheticCore(opts: {
  seed: number;
  startYear: number;
  endYear: number;
  climate: number[];
  beta: number;
  baseWidth: number;
  missingCount: number;
  falseCount: number;
  heightPx?: number;
}): SyntheticCore {
  const rng = mulberry32(opts.seed);
  const years: number[] = [];
  for (let y = opts.startYear; y <= opts.endYear; y++) years.push(y);

  const calendarIdeal = treeCalendarWidths(years, opts.climate, rng, opts.beta, opts.baseWidth);

  // 选缺轮年份（避开标记年的极窄轮，且不相邻、不靠端点）
  const markerGuard = new Set([7, 12, 18, 31, 38, 47].map((d) => opts.startYear + d));
  const missingYears = new Set<number>();
  const candidates = years.slice(3, years.length - 3).filter((y) => !markerGuard.has(y));
  while (missingYears.size < opts.missingCount && candidates.length > 0) {
    const idx = Math.floor(rng() * candidates.length);
    const y = candidates.splice(idx, 1)[0];
    if ([...missingYears].every((m) => Math.abs(m - y) > 2)) missingYears.add(y);
  }

  // 实际形成的年：缺轮年宽度并入前一年（晚材边界缺失）
  const ringYearOf: number[] = [];
  const ringWidthsMm: number[] = [];
  const calendarWidthsMm = new Array<number>(years.length).fill(0);
  for (let i = 0; i < years.length; i++) {
    const w = calendarIdeal[i];
    calendarWidthsMm[i] = missingYears.has(years[i]) ? 0 : roundWidth(w);
    if (missingYears.has(years[i])) {
      if (ringWidthsMm.length > 0) ringWidthsMm[ringWidthsMm.length - 1] = roundWidth(ringWidthsMm[ringWidthsMm.length - 1] + w);
      continue;
    }
    ringYearOf.push(years[i]);
    ringWidthsMm.push(roundWidth(w));
  }

  // 标定：1 mm ≈ 28 px（约 900 DPI 扫描的量级）
  const scale = 1 / 28;
  const totalMm = ringWidthsMm.reduce((s, w) => s + w, 0);
  const marginPx = 24;
  const width = Math.ceil(totalMm / scale) + marginPx * 2;
  const height = opts.heightPx ?? 96;

  // 轮边界（晚材末端）像素位置
  const boundaryX: number[] = [];
  const latewoodRanges: { start: number; end: number }[] = [];
  let cursor = marginPx;
  ringWidthsMm.forEach((w) => {
    const wPx = w / scale;
    const lwRatio = clamp(0.18 + 0.12 * rng(), 0.12, 0.42);
    const lwPx = Math.max(2, Math.round(wPx * lwRatio));
    const endX = Math.round(cursor + wPx);
    boundaryX.push(endX);
    latewoodRanges.push({ start: endX - lwPx, end: endX });
    cursor = endX;
  });

  // 伪轮：选若干轮，在其早材里加一条未贯穿的弱晚材线（比真边界弱、且只覆盖部分行）
  const falseRings: { ringIndex: number; x: number; year: number }[] = [];
  const ringChoices = ringWidthsMm
    .map((w, i) => ({ w, i }))
    .filter((c) => c.w / scale > 26 && !missingYears.has(ringYearOf[c.i]));
  for (let k = 0; k < opts.falseCount && ringChoices.length > 0; k++) {
    const ci = Math.floor(rng() * ringChoices.length);
    const { i } = ringChoices.splice(ci, 1)[0];
    const lo = i === 0 ? marginPx : boundaryX[i - 1];
    const hi = boundaryX[i];
    // 放在早材区段（轮宽的 18%~42%），与外侧真晚材带明确分开
    const x = Math.round(lo + (hi - lo) * (0.18 + rng() * 0.24));
    falseRings.push({ ringIndex: i, x, year: ringYearOf[i] });
  }

  // 绘制灰度图：背景早材浅色渐变，晚材深色带，边界处最暗；加纤维纹理与扫描噪声
  const gray = new Uint8ClampedArray(width * height);
  const rowShade = new Array<number>(height).fill(0).map(() => (rng() - 0.5) * 6);
  for (let x = 0; x < width; x++) {
    // 找 x 所属轮
    let ri = boundaryX.findIndex((b) => x <= b);
    if (ri < 0) ri = boundaryX.length - 1;
    const lw = latewoodRanges[ri];
    let base: number;
    if (lw && x >= lw.start && x <= lw.end) {
      const f = (x - lw.start) / Math.max(1, lw.end - lw.start);
      base = 150 - 55 * Math.sin(Math.PI * f); // 晚材中部最暗
    } else {
      base = 205 + 8 * Math.sin(x * 0.05);
    }
    for (let y = 0; y < height; y++) {
      const fiber = 4 * Math.sin(y * 0.9 + x * 0.02) + 3 * gaussian(rng);
      gray[y * width + x] = clamp(base + rowShade[y] + fiber, 40, 240);
    }
  }
  // 边界暗线（贯穿）
  for (const bx of boundaryX) {
    for (let y = 0; y < height; y++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx;
        if (x >= 0 && x < width) gray[y * width + x] = clamp(gray[y * width + x] - 45, 30, 255);
      }
    }
  }
  // 伪轮暗线：只贯穿中间 60% 行、对比弱于真边界（模拟未完全形成的晚材带）
  for (const fr of falseRings) {
    const y0 = Math.round(height * 0.2);
    const y1 = Math.round(height * 0.8);
    for (let y = y0; y <= y1; y++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = fr.x + dx;
        if (x >= 0 && x < width) gray[y * width + x] = clamp(gray[y * width + x] - 30, 40, 255);
      }
    }
  }

  const anomalies: SyntheticAnomaly[] = [
    ...[...missingYears].map((y) => ({
      year: y,
      ringIndex: ringYearOf.findIndex((ry) => ry > y) - 1,
      type: 'missing-ring' as const,
      xPx: null,
      message: `真值：${y} 年缺轮，宽度并入前一年`,
    })),
    ...falseRings.map((fr) => ({
      year: fr.year,
      ringIndex: fr.ringIndex,
      type: 'false-ring' as const,
      xPx: fr.x,
      message: `真值：${fr.year} 年内伪轮（未贯穿晚材线）`,
    })),
  ];

  return {
    gray,
    width,
    height,
    trueBoundaryX: boundaryX,
    trueWidthsMm: ringWidthsMm,
    calendarWidthsMm,
    calendarIdealWidthsMm: calendarIdeal.map(roundWidth),
    calendarYears: years,
    anomalies,
    scaleMmPerPx: scale,
    latewoodRanges,
  };
}

export interface SyntheticPlot {
  plotId: string;
  climate: { years: number[]; signal: number[] };
  /** 用于建主年表的芯 */
  cores: { treeId: string; coreName: string; core: SyntheticCore }[];
  /** 独立「待测」芯（同气候信号，另抽种子），用来验证定年 */
  blindCore: { treeId: string; coreName: string; core: SyntheticCore };
}

/** 生成一整个样地：多树多芯 + 一根盲测芯 */
export function generateSyntheticPlot(opts: GeneratePlotOptions): SyntheticPlot {
  const climateRng = mulberry32(opts.seed ^ 0x9e3779b9);
  const { years, signal } = generateClimateSignal(opts.startYear, opts.endYear, climateRng);
  const cores: SyntheticPlot['cores'] = [];
  let seed = opts.seed;
  for (let t = 1; t <= opts.treeCount; t++) {
    const treeId = `T${String(t).padStart(2, '0')}`;
    const beta = 0.7 + (mulberry32(seed++)() - 0.5) * 0.3;
    const baseWidth = 1.6 + mulberry32(seed++)() * 0.9;
    for (let c = 1; c <= opts.coresPerTree; c++) {
      const core = generateSyntheticCore({
        seed: seed++,
        startYear: opts.startYear,
        endYear: opts.endYear,
        climate: signal,
        beta,
        baseWidth,
        missingCount: opts.missingRingsPerCore,
        falseCount: opts.falseRingsPerCore,
      });
      cores.push({ treeId, coreName: `${treeId}-${c}`, core });
    }
  }
  const blindCore = generateSyntheticCore({
    seed: seed + 777,
    startYear: opts.startYear,
    endYear: opts.endYear,
    climate: signal,
    beta: 0.85,
    baseWidth: 1.9,
    missingCount: opts.missingRingsPerCore + 1,
    falseCount: opts.falseRingsPerCore,
  });
  return {
    plotId: opts.plotId,
    climate: { years, signal },
    cores,
    blindCore: { treeId: 'T99', coreName: 'BLIND-1', core: blindCore },
  };
}
