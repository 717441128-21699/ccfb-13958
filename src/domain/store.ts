/**
 * 应用状态：集中管理当前样地、树芯、边界、测量、序列与定年结果。
 * 任何人工增删/移动边界后调用 recompute()，年宽与（已定年的）交叉定年立即重算。
 */
import {
  addBoundary,
  moveBoundary,
  recomputeMeasurements,
  removeBoundary,
  runDetectionOnSample,
  sampleToSeries,
  assignYearsToMeasurements,
} from './sample';
import { crossdate, assignYears, type ReferenceChronologyLike, type CrossdateOptions } from './crossdating';
import { extractProfile, type DetectionResult } from './boundary-detection';
import { mergeCoresToTree, buildChronology } from './chronology';
import type {
  Chronology,
  CoreSample,
  DatingResult,
  RingMeasurement,
  RingWidthSeries,
} from './types';

export interface SampleState {
  sample: CoreSample;
  gray: Uint8ClampedArray | null;
  profile: number[];
  detection: DetectionResult | null;
  measurements: RingMeasurement[];
  series: RingWidthSeries | null;
  dating: DatingResult | null;
}

export interface AppState {
  plotId: string;
  samples: Record<string, SampleState>;
  currentSampleId: string | null;
  reference: ReferenceChronologyLike | null;
  chronology: Chronology | null;
  crossdateOptions: CrossdateOptions;
  /** 订阅重渲染 */
  listeners: Set<() => void>;
}

export function createStore(plotId = 'P01'): AppState {
  return {
    plotId,
    samples: {},
    currentSampleId: null,
    reference: null,
    chronology: null,
    crossdateOptions: {},
    listeners: new Set(),
  };
}

function emit(state: AppState): void {
  state.listeners.forEach((l) => l());
}

export function subscribe(state: AppState, l: () => void): () => void {
  state.listeners.add(l);
  return () => state.listeners.delete(l);
}

export function getCurrent(state: AppState): SampleState | null {
  return state.currentSampleId ? state.samples[state.currentSampleId] ?? null : null;
}

/** 注册一根芯（含灰度图），不自动识别 */
export function registerSample(
  state: AppState,
  sample: CoreSample,
  gray: Uint8ClampedArray,
): void {
  state.samples[sample.id] = {
    sample,
    gray,
    profile: [],
    detection: null,
    measurements: [],
    series: null,
    dating: null,
  };
  state.currentSampleId = sample.id;
  emit(state);
}

/** 对当前芯跑自动识别 */
export function runDetection(state: AppState, sampleId: string): void {
  const st = state.samples[sampleId];
  if (!st || !st.gray) return;
  const s = st.sample;
  const profile = extractProfile(
    st.gray,
    s.imageWidthPx!,
    s.imageHeightPx!,
    s.pathY,
    s.bandHalfHeightPx,
  );
  const { sample, detection, measurements } = runDetectionOnSample(s, profile);
  st.sample = sample;
  st.profile = profile;
  st.detection = detection;
  st.measurements = measurements;
  st.series = sampleToSeries(sample, measurements);
  st.dating = null;
  emit(state);
}

/** 人工增删移动后统一重算（测量 → 序列 → 已定年则重新定年） */
export function recompute(state: AppState, sampleId: string): void {
  const st = state.samples[sampleId];
  if (!st) return;
  st.measurements = recomputeMeasurements(st.sample, st.measurements);
  st.series = sampleToSeries(st.sample, st.measurements);
  if (st.dating && state.reference) {
    const endYear = st.dating.best.endYear;
    st.series = assignYears(st.series, endYear);
    st.measurements = assignYearsToMeasurements(st.measurements, endYear);
    st.dating = crossdate(st.series, state.reference, state.crossdateOptions);
  }
  emit(state);
}

export function userAddBoundary(state: AppState, sampleId: string, distanceMm: number): void {
  const st = state.samples[sampleId];
  if (!st) return;
  st.sample = addBoundary(st.sample, distanceMm);
  recompute(state, sampleId);
}

export function userRemoveBoundary(state: AppState, sampleId: string, boundaryId: string): void {
  const st = state.samples[sampleId];
  if (!st) return;
  st.sample = removeBoundary(st.sample, boundaryId);
  recompute(state, sampleId);
}

export function userMoveBoundary(state: AppState, sampleId: string, boundaryId: string, distanceMm: number): void {
  const st = state.samples[sampleId];
  if (!st) return;
  st.sample = moveBoundary(st.sample, boundaryId, distanceMm);
  recompute(state, sampleId);
}

/** 对当前芯执行交叉定年 */
export function dateSample(state: AppState, sampleId: string): DatingResult | null {
  const st = state.samples[sampleId];
  if (!st?.series || !state.reference) return null;
  const result = crossdate(st.series, state.reference, state.crossdateOptions);
  st.dating = result;
  st.series = assignYears(st.series, result.best.endYear);
  st.measurements = assignYearsToMeasurements(st.measurements, result.best.endYear);
  emit(state);
  return result;
}

/** 同树多芯合并 → 树序列；样地全部（或指定 id 集合的）树序列 → 年表 */
export function buildPlotChronology(state: AppState, onlyIds?: string[]): Chronology | null {
  const allow = onlyIds ? new Set(onlyIds) : null;
  const byTree = new Map<string, RingWidthSeries[]>();
  for (const [id, st] of Object.entries(state.samples)) {
    if (allow && !allow.has(id)) continue;
    if (st.series?.endYear != null) {
      const arr = byTree.get(st.series.treeId) ?? [];
      arr.push(st.series);
      byTree.set(st.series.treeId, arr);
    }
  }
  if (byTree.size === 0) return null;
  const treeSeries = [...byTree.entries()].map(([treeId, list]) =>
    mergeCoresToTree(treeId, list.map((series) => ({ series }))),
  );
  state.chronology = buildChronology(state.plotId, `${state.plotId} 样地年表`, treeSeries);
  emit(state);
  return state.chronology;
}

export function setReference(state: AppState, ref: ReferenceChronologyLike): void {
  state.reference = ref;
  emit(state);
}
