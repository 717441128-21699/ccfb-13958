/**
 * 领域模型：贯穿「合成 → 识别 → 人工修订 → 交叉定年 → 年表」全流程的数据结构。
 * 距离单位一律为毫米(mm)，序列以年为单位，宽度保留到 0.01 mm。
 */

/** 沿测量路径上的一个边界点（年轮边界 = 晚材末端，即次年早材起点） */
export interface RingBoundary {
  /** 稳定 id（人工增删后仍可追踪） */
  id: string;
  /** 在测量路径上的累积距离，单位 mm（树皮方向递增；pith 在 0 附近） */
  distance: number;
  /** 该边界所属的日历年，未定年前为 null */
  year: number | null;
  /** 识别置信度 0..1 */
  confidence: number;
  /** 来源：算法自动识别 / 人工新增 / 算法识别后人工移动过 */
  origin: 'auto' | 'manual' | 'adjusted';
  /** 该边界上挂的告警 */
  flags: RingFlag[];
}

/** 一个年轮（两条边界之间）的测量结果 */
export interface RingMeasurement {
  /** 年轮序号，从髓心向外 0 起 */
  index: number;
  /** 内侧边界 id */
  innerBoundaryId: string;
  /** 外侧边界 id */
  outerBoundaryId: string;
  /** 全年轮宽度 mm（0.01 精度） */
  totalWidth: number;
  /** 早材宽度 mm */
  earlywoodWidth: number;
  /** 晚材宽度 mm */
  latewoodWidth: number;
  /** 晚材占比 0..1 */
  latewoodRatio: number;
  /** 日历年（未定年为 null） */
  year: number | null;
  flags: RingFlag[];
}

export type RingFlagType =
  | 'false-ring' // 疑似伪年轮（年内有一条额外晚材带，未贯穿或对比度弱）
  | 'missing-ring' // 疑似缺轮（该处局部/整圈没有形成可识别年轮）
  | 'weak-boundary' // 边界对比弱
  | 'dating-mismatch'; // 交叉定年对不上

export interface RingFlag {
  type: RingFlagType;
  /** 0..1，提示的可靠程度 */
  strength: number;
  message: string;
}

/** 一根树芯（或圆盘条带）的扫描图与测量状态 */
export interface CoreSample {
  id: string;
  /** 同一棵树的多根芯共用 treeId */
  treeId: string;
  plotId: string;
  name: string;
  /** 扫描图像（浏览器里是 objectURL / dataURL；合成演示直接给 dataURL） */
  imageDataUrl?: string;
  imageWidthPx?: number;
  imageHeightPx?: number;
  /** 像素 → 毫米标定：scaleMmPerPx 下，distance = px * scaleMmPerPx + offsetMm */
  scaleMmPerPx: number;
  offsetMm: number;
  /** 测量路径（沿 x 轴的条带中心线，y 为图像坐标像素）。先支持水平直路径。 */
  pathY: number;
  /** 条带半高（像素），在该高度内做平均得到灰度剖面 */
  bandHalfHeightPx: number;
  boundaries: RingBoundary[];
  /** 髓心侧端点距离（mm），通常为 0 */
  pithDistanceMm: number;
  /** 树皮侧端点距离（mm）= 芯长 */
  barkDistanceMm: number;
  createdAt: string;
}

/** 一根芯转成的年宽序列（定年之后才有年份） */
export interface RingWidthSeries {
  id: string;
  treeId: string;
  plotId: string;
  sampleName: string;
  /** 端点年份（树皮方向最外一轮的日历年）；未定年为 null */
  endYear: number | null;
  /** 从旧到新排列的年宽，单位 mm（0.01 精度） */
  widths: number[];
  /** 与 widths 等长的标记，记录伪轮/缺轮等 */
  flags: (RingFlagType | null)[];
}

/** 交叉定年的候选错位结果 */
export interface DatingLag {
  /** 候选端点年份（把序列最外一轮对齐到该年） */
  endYear: number;
  /** 重叠年数 */
  overlap: number;
  /** 重叠段 Pearson 相关系数 */
  r: number;
  /** COFECHA 风格 t 值（由 r 变换） */
  t: number;
  /** 一致符号百分率（Gleichläufigkeit, 0..100） */
  glk: number;
  /** 50 年窗口（步进 25 年）分段 t 值 */
  segmentTs: { startYear: number; endYear: number; n: number; r: number; t: number }[];
}

export interface DatingResult {
  seriesId: string;
  referenceId: string;
  /** 最佳候选 */
  best: DatingLag;
  /** 前若干候选，便于人工判断 */
  candidates: DatingLag[];
  /** 最佳错位下，逐年偏差标记：对不上的年份 */
  mismatchedYears: {
    year: number;
    /** 该年一阶差在参考序列中的标准化偏离（绝对值） */
    zDeviation: number;
    message: string;
  }[];
  /** 疑似缺轮/伪轮提示（结合定年错位与图像告警） */
  anomalyWarnings: { year: number | null; flag: RingFlagType; message: string }[];
}

/** 多条序列合并（先树、后样地）的输入项 */
export interface SeriesMergeItem {
  series: RingWidthSeries;
  /** 该序列在整体中的权重，默认 1 */
  weight?: number;
}

export interface Chronology {
  id: string;
  plotId: string;
  name: string;
  /** 日历年，从旧到新 */
  years: number[];
  /** 各样地年表值：去趋势指数的均值（1.0 附近） */
  indices: number[];
  /** 每年参与的序列数 */
  sampleDepth: number[];
  /** 原始平均年宽 mm（去趋势前），便于核对 */
  meanWidths: number[];
}
