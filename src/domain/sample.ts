/**
 * 测量与人工修订：
 *  - 识别结果（像素坐标）→ 毫米距离与年宽（0.01 mm 精度）
 *  - 人工在图上新增 / 删除 / 移动边界后，重算全部年轮测量
 *  - CoreSample → RingWidthSeries（定年前 endYear=null）
 * 早材/晚材分割沿用识别阶段的晚材隶属度，边界移动时按新区间重切。
 */
import { detectBoundaries, type DetectionResult, type DetectedRing } from './boundary-detection';
import { roundWidth } from './math';
import type {
  CoreSample,
  RingBoundary,
  RingMeasurement,
  RingWidthSeries,
} from './types';

let manualId = 0;
function newBoundaryId(): string {
  manualId += 1;
  return `m-${manualId.toString(36)}`;
}

/** 像素距离 → 毫米 */
export function pxToMm(sample: CoreSample, px: number): number {
  return roundWidth(px * sample.scaleMmPerPx + sample.offsetMm);
}

/** 毫米 → 像素 */
export function mmToPx(sample: CoreSample, mm: number): number {
  return (mm - sample.offsetMm) / sample.scaleMmPerPx;
}

/** 对样本的灰度剖面跑识别，返回写好毫米距离的新样本、检测中间量与测量值 */
export function runDetectionOnSample(
  sample: CoreSample,
  profile: number[],
  options?: Parameters<typeof detectBoundaries>[1],
): { sample: CoreSample; detection: DetectionResult; measurements: RingMeasurement[] } {
  const detection = detectBoundaries(profile, options);

  const boundaries: RingBoundary[] = detection.boundaries.map((b, i) => ({
    ...b,
    distance: pxToMm(sample, detection.peakPositions[i]),
  }));

  const measurements = measurementsFromDetection(sample, detection, boundaries);
  const next: CoreSample = { ...sample, boundaries };
  return { sample: next, detection, measurements };
}

function measurementsFromDetection(
  sample: CoreSample,
  detection: DetectionResult,
  boundaries: RingBoundary[],
): RingMeasurement[] {
  const out: RingMeasurement[] = [];
  for (let k = 0; k < boundaries.length; k++) {
    const loPx = k === 0 ? 0 : detection.peakPositions[k - 1];
    const hiPx = detection.peakPositions[k];
    const ring = detection.rings[k];
    const totalWidth = roundWidth((hiPx - loPx) * sample.scaleMmPerPx);
    let latewoodWidth = 0;
    if (ring?.latewoodRange) {
      latewoodWidth = roundWidth(
        (ring.latewoodRange.end - ring.latewoodRange.start + 1) * sample.scaleMmPerPx,
      );
    }
    const earlywoodWidth = roundWidth(Math.max(0, totalWidth - latewoodWidth));
    out.push({
      index: k,
      innerBoundaryId: k === 0 ? 'pith' : boundaries[k - 1].id,
      outerBoundaryId: boundaries[k].id,
      totalWidth,
      earlywoodWidth,
      latewoodWidth,
      latewoodRatio: totalWidth > 0 ? latewoodWidth / totalWidth : 0,
      year: boundaries[k].year,
      flags: ring?.flags ?? [],
    });
  }
  return out;
}

/** 由当前边界（毫米）重算全部年轮测量；晚材比例沿用上次测量，边界移动后总宽立即更新 */
export function recomputeMeasurements(
  sample: CoreSample,
  previous?: RingMeasurement[],
): RingMeasurement[] {
  const sorted = [...sample.boundaries].sort((a, b) => a.distance - b.distance);
  const prevMap = new Map(previous?.map((m) => [m.outerBoundaryId, m]) ?? []);
  return sorted.map((b, k) => {
    const inner = k === 0 ? sample.pithDistanceMm : sorted[k - 1].distance;
    const totalWidth = roundWidth(b.distance - inner);
    const prev = prevMap.get(b.id);
    const ratio = prev && prev.totalWidth > 0 ? prev.latewoodRatio : 0.35;
    const latewoodWidth = roundWidth(totalWidth * ratio);
    const earlywoodWidth = roundWidth(Math.max(0, totalWidth - latewoodWidth));
    return {
      index: k,
      innerBoundaryId: k === 0 ? 'pith' : sorted[k - 1].id,
      outerBoundaryId: b.id,
      totalWidth,
      earlywoodWidth,
      latewoodWidth,
      latewoodRatio: totalWidth > 0 ? latewoodWidth / totalWidth : 0,
      year: b.year,
      flags: b.flags,
    };
  });
}

/** 人工新增边界（毫米距离），标 manual */
export function addBoundary(sample: CoreSample, distanceMm: number): CoreSample {
  const b: RingBoundary = {
    id: newBoundaryId(),
    distance: roundWidth(distanceMm),
    year: null,
    confidence: 1,
    origin: 'manual',
    flags: [],
  };
  return { ...sample, boundaries: [...sample.boundaries, b].sort((a, z) => a.distance - z.distance) };
}

/** 人工删除边界 */
export function removeBoundary(sample: CoreSample, boundaryId: string): CoreSample {
  return { ...sample, boundaries: sample.boundaries.filter((b) => b.id !== boundaryId) };
}

/** 人工移动边界 */
export function moveBoundary(sample: CoreSample, boundaryId: string, distanceMm: number): CoreSample {
  return {
    ...sample,
    boundaries: sample.boundaries
      .map((b) =>
        b.id === boundaryId
          ? { ...b, distance: roundWidth(distanceMm), origin: 'adjusted' as const }
          : b,
      )
      .sort((a, z) => a.distance - z.distance),
  };
}

/** 样本 → 年宽序列（未定年） */
export function sampleToSeries(
  sample: CoreSample,
  measurements: RingMeasurement[],
): RingWidthSeries {
  const ordered = [...measurements].sort((a, b) => a.index - b.index);
  return {
    id: `series-${sample.id}`,
    treeId: sample.treeId,
    plotId: sample.plotId,
    sampleName: sample.name,
    endYear: null,
    widths: ordered.map((m) => m.totalWidth),
    flags: ordered.map((m) => {
      const f = m.flags.find(
        (x) => x.type === 'false-ring' || x.type === 'missing-ring',
      );
      return f ? f.type : null;
    }),
  };
}

/** 定年后把年份回写到测量（从内到外递增） */
export function assignYearsToMeasurements(
  measurements: RingMeasurement[],
  endYear: number,
): RingMeasurement[] {
  const n = measurements.length;
  return [...measurements]
    .sort((a, b) => a.index - b.index)
    .map((m, i) => ({ ...m, year: endYear - n + 1 + i }));
}

export type { DetectedRing };
