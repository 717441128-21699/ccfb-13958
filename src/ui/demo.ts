/**
 * 演示数据装配：生成样地合成芯 → 编码 PNG → 注册到 store → 建参考年表。
 * 真实使用时扫描图走「导入图片」，流程与这里完全一致。
 */
import { generateSyntheticPlot, type SyntheticCore } from '../domain/synthetic';
import { grayToPngDataUrl } from '../lib/image';
import { registerSample, setReference, type AppState } from '../domain/store';
import type { CoreSample } from '../domain/types';

export const DEMO_OPTIONS = {
  plotId: 'P01',
  startYear: 1950,
  endYear: 2020,
  treeCount: 5,
  coresPerTree: 2,
  missingRingsPerCore: 1,
  falseRingsPerCore: 2,
  seed: 20240101,
};

function coreToSample(
  plotId: string,
  treeId: string,
  name: string,
  core: SyntheticCore,
  dataUrl: string,
): CoreSample {
  return {
    id: name,
    treeId,
    plotId,
    name,
    imageDataUrl: dataUrl,
    imageWidthPx: core.width,
    imageHeightPx: core.height,
    scaleMmPerPx: core.scaleMmPerPx,
    offsetMm: 0,
    pathY: core.height / 2,
    bandHalfHeightPx: Math.round(core.height / 4),
    boundaries: [],
    pithDistanceMm: 0,
    barkDistanceMm: Math.round(core.width * core.scaleMmPerPx * 100) / 100,
    createdAt: new Date(0).toISOString(),
  };
}

/** 生成整套演示数据并装入 store；返回盲测芯 id 与真值，便于页面核对 */
export function buildDemoDataset(state: AppState): {
  blindSampleId: string;
  truth: {
    anomalies: SyntheticCore['anomalies'];
    trueBoundaryX: number[];
    calendarYears: number[];
  };
} {
  const plot = generateSyntheticPlot(DEMO_OPTIONS);

  for (const item of plot.cores) {
    const url = grayToPngDataUrl(item.core.gray, item.core.width, item.core.height);
    const sample = coreToSample(DEMO_OPTIONS.plotId, item.treeId, item.coreName, item.core, url);
    registerSample(state, sample, item.core.gray);
  }
  const blindUrl = grayToPngDataUrl(
    plot.blindCore.core.gray,
    plot.blindCore.core.width,
    plot.blindCore.core.height,
  );
  const blindSample = coreToSample(
    DEMO_OPTIONS.plotId,
    plot.blindCore.treeId,
    plot.blindCore.coreName,
    plot.blindCore.core,
    blindUrl,
  );
  registerSample(state, blindSample, plot.blindCore.core.gray);

  // 参考年表：样地气候信号（实际工作中换成所里的标准年表文件）
  setReference(state, {
    years: plot.climate.years,
    widths: plot.climate.signal,
  });

  return {
    blindSampleId: blindSample.id,
    truth: {
      anomalies: plot.blindCore.core.anomalies,
      trueBoundaryX: plot.blindCore.core.trueBoundaryX,
      calendarYears: plot.blindCore.core.calendarYears,
    },
  };
}
