/**
 * 主控制器：装配 store、画布查看器与各面板，订阅状态变化整体重渲染。
 */
import {
  createStore,
  subscribe,
  getCurrent,
  registerSample,
  runDetection,
  dateSample,
  buildPlotChronology,
  userAddBoundary,
  userRemoveBoundary,
  userMoveBoundary,
  type AppState,
} from './domain/store';
import { CoreCanvasViewer } from './ui/canvas-viewer';
import { buildDemoDataset } from './ui/demo';
import { loadImageFile } from './lib/image';
import { chronologyStats } from './domain/chronology';
import type { CoreSample, RingFlag } from './domain/types';

const state: AppState = createStore('P01');
const canvas = document.getElementById('coreCanvas') as HTMLCanvasElement;
const viewer = new CoreCanvasViewer(canvas, {
  onMoveBoundary: (id, mm) => state.currentSampleId && userMoveBoundary(state, state.currentSampleId, id, mm),
  onAddBoundary: (mm) => state.currentSampleId && userAddBoundary(state, state.currentSampleId, mm),
  onRemoveBoundary: (id) => state.currentSampleId && userRemoveBoundary(state, state.currentSampleId, id),
  onSelect: (id) => {
    selectedBoundaryId = id;
    renderMeasureTable();
  },
});

let selectedBoundaryId: string | null = null;
const imageCache = new Map<string, HTMLImageElement>();
let demoTruth: ReturnType<typeof buildDemoDataset>['truth'] | null = null;

// ---------- 顶部按钮 ----------
function loadDemo(): void {
  const fresh = createStore('P01');
  Object.assign(state, fresh);
  state.listeners = new Set();
  subscribe(state, render);
  const built = buildDemoDataset(state);
  demoTruth = built.truth;
  setStatus(`已载入合成样地：${Object.keys(state.samples).length} 根芯（含盲测芯 ${built.blindSampleId}），每芯含 1 缺轮 + 2 伪轮真值`);
  render();
}
document.getElementById('demoBtn')!.addEventListener('click', loadDemo);

document.getElementById('detectBtn')!.addEventListener('click', () => {
  if (state.currentSampleId) {
    runDetection(state, state.currentSampleId);
    setStatus('边界识别完成：请核对伪轮/缺轮提示，可直接在图上增删拖动');
  }
});

document.getElementById('dateBtn')!.addEventListener('click', () => {
  if (!state.currentSampleId) return;
  if (!state.reference) {
    setStatus('缺少参考年表：请先载入演示数据或导入标准年表');
    return;
  }
  const r = dateSample(state, state.currentSampleId);
  if (r) setStatus(`定年完成：最佳端点年 ${r.best.endYear}，r=${r.best.r.toFixed(3)}，t=${r.best.t.toFixed(2)}`);
});

document.getElementById('chronoBtn')!.addEventListener('click', () => {
  const ids = Object.keys(state.samples).filter((id) => state.samples[id].sample.name !== 'BLIND-1');
  const c = buildPlotChronology(state, ids);
  if (c) setStatus(`年表构建完成：${c.years.length} 年（${c.years[0]}–${c.years[c.years.length - 1]}），最大样本深度 ${Math.max(...c.sampleDepth)} 条序列`);
});

document.getElementById('fileInput')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  for (const file of Array.from(input.files)) {
    const img = await loadImageFile(file);
    const id = `img-${Date.now()}-${Math.round(Math.random() * 1e4)}`;
    const sample: CoreSample = {
      id,
      treeId: id,
      plotId: state.plotId,
      name: file.name.replace(/\.[^.]+$/, ''),
      imageDataUrl: img.dataUrl,
      imageWidthPx: img.width,
      imageHeightPx: img.height,
      // 默认标定：导入后可在真实工作中按标尺修改；这里给 900 DPI 等效值
      scaleMmPerPx: 25.4 / 900,
      offsetMm: 0,
      pathY: img.height / 2,
      bandHalfHeightPx: Math.round(img.height / 4),
      boundaries: [],
      pithDistanceMm: 0,
      barkDistanceMm: Math.round(img.width * (25.4 / 900) * 100) / 100,
      createdAt: new Date().toISOString(),
    };
    registerSample(state, sample, img.gray);
    const htmlImg = new Image();
    htmlImg.src = img.dataUrl;
    imageCache.set(id, htmlImg);
  }
  setStatus(`已导入 ${input.files?.length ?? 0} 张扫描图，点击「自动识别边界」开始`);
  render();
  input.value = '';
});

// ---------- 标签页 ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${(tab as HTMLElement).dataset.tab}`)!.classList.add('active');
  });
});

// ---------- 渲染 ----------
function setStatus(msg: string): void {
  (document.getElementById('statusText') as HTMLElement).textContent = msg;
}

function render(): void {
  renderSampleList();
  renderCanvas();
  renderMeasureTable();
  renderDating();
  renderChronology();
  renderTruth();
  const has = getCurrent(state) !== null;
  (document.getElementById('detectBtn') as HTMLButtonElement).disabled = !has;
  (document.getElementById('dateBtn') as HTMLButtonElement).disabled = !has;
  (document.getElementById('chronoBtn') as HTMLButtonElement).disabled = Object.values(state.samples)
    .every((s) => s.series?.endYear == null);
}

function renderSampleList(): void {
  const ul = document.getElementById('sampleList') as HTMLUListElement;
  ul.innerHTML = '';
  for (const [id, st] of Object.entries(state.samples)) {
    const li = document.createElement('li');
    if (id === state.currentSampleId) li.classList.add('active');
    const warnCount = st.sample.boundaries.reduce((n, b) => n + b.flags.length, 0);
    li.innerHTML = `<span>${st.sample.name}</span><span class="badge ${warnCount ? 'warn' : ''}">${
      st.sample.boundaries.length ? `${st.sample.boundaries.length}轮` : '未识别'
    }${warnCount ? ` · ${warnCount}警` : ''}</span>`;
    li.addEventListener('click', () => {
      state.currentSampleId = id;
      selectedBoundaryId = null;
      render();
    });
    ul.appendChild(li);
  }
}

function renderCanvas(): void {
  const st = getCurrent(state);
  if (!st) return;
  let img = imageCache.get(st.sample.id);
  if (!img && st.sample.imageDataUrl) {
    img = new Image();
    img.src = st.sample.imageDataUrl;
    imageCache.set(st.sample.id, img);
  }
  if (!img) return;
  const draw = () => {
    const ranges = st.detection?.rings.map((r) => r.latewoodRange).filter(Boolean) as
      | { start: number; end: number }[]
      | undefined;
    viewer.setData(st.sample, img!, ranges ?? []);
    viewer.setSelected(selectedBoundaryId);
  };
  if (img.complete) draw();
  else img.onload = draw;
}

function flagChips(flags: RingFlag[]): string {
  return flags
    .map((f) => `<span class="flag-chip flag-${f.type}" title="${f.message}">${flagLabel(f.type)}</span>`)
    .join('');
}
function flagLabel(t: string): string {
  return { 'false-ring': '伪轮', 'missing-ring': '缺轮', 'weak-boundary': '弱边界', 'dating-mismatch': '定年不符' }[t] ?? t;
}

function renderMeasureTable(): void {
  const st = getCurrent(state);
  const tbody = document.querySelector('#measureTable tbody') as HTMLTableSectionElement;
  if (!st || st.measurements.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b7686">暂无测量数据</td></tr>';
    return;
  }
  const bMap = new Map(st.sample.boundaries.map((b) => [b.id, b]));
  tbody.innerHTML = st.measurements
    .map((m) => {
      const b = bMap.get(m.outerBoundaryId);
      const danger = m.flags.some((f) => f.type === 'missing-ring');
      const warn = m.flags.length > 0 && !danger;
      return `<tr class="${m.outerBoundaryId === selectedBoundaryId ? 'selected' : ''} ${
        danger ? 'row-danger' : warn ? 'row-warn' : ''
      }">
        <td>${m.index + 1}</td>
        <td>${m.year ?? '—'}</td>
        <td>${m.totalWidth.toFixed(2)}</td>
        <td>${m.earlywoodWidth.toFixed(2)}</td>
        <td>${m.latewoodWidth.toFixed(2)}</td>
        <td>${(m.latewoodRatio * 100).toFixed(1)}%</td>
        <td>${b ? b.confidence.toFixed(2) : '—'}</td>
        <td>${b ? originLabel(b.origin) : '—'}</td>
        <td>${flagChips(m.flags)}</td>
      </tr>`;
    })
    .join('');
}
function originLabel(o: string): string {
  return { auto: '自动', manual: '新增', adjusted: '移动' }[o] ?? o;
}

function renderDating(): void {
  const st = getCurrent(state);
  const el = document.getElementById('datingContent') as HTMLElement;
  if (!st?.dating) {
    el.className = 'dating-empty';
    el.textContent = '尚未定年：识别边界后点击「交叉定年」。';
    return;
  }
  const d = st.dating;
  el.className = '';
  el.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="k">最佳端点年份</div><div class="v">${d.best.endYear}</div></div>
      <div class="metric"><div class="k">相关系数 r</div><div class="v ${d.best.r >= 0.5 ? 'good' : 'bad'}">${d.best.r.toFixed(3)}</div></div>
      <div class="metric"><div class="k">t 值（COFECHA）</div><div class="v ${d.best.t >= 3.5 ? 'good' : 'bad'}">${d.best.t.toFixed(2)}</div></div>
      <div class="metric"><div class="k">GLK 一致率</div><div class="v">${d.best.glk.toFixed(1)}%</div></div>
      <div class="metric"><div class="k">重叠年数</div><div class="v">${d.best.overlap}</div></div>
    </div>
    <h3>候选错位（前 8）</h3>
    <div class="table-wrap"><table class="cand-table"><thead><tr>
      <th>端点年</th><th>重叠</th><th>r</th><th>t</th><th>GLK</th><th>分段 t（50 年窗口/25 年步进）</th>
    </tr></thead><tbody>
      ${d.candidates
        .map(
          (c) => `<tr ${c.endYear === d.best.endYear ? 'style="font-weight:700;background:#e8f0fe"' : ''}>
            <td>${c.endYear}</td><td>${c.overlap}</td><td>${c.r.toFixed(3)}</td><td>${c.t.toFixed(2)}</td>
            <td>${c.glk.toFixed(1)}%</td>
            <td>${c.segmentTs.map((s) => `${s.startYear}-${s.endYear}: t=${s.t.toFixed(2)}`).join('；') || '—'}</td>
          </tr>`,
        )
        .join('')}
    </tbody></table></div>
    <h3>对不上的年份（差分反向且偏离 ≥1.5σ）</h3>
    ${
      d.mismatchedYears.length === 0
        ? '<p>无显著异常年份。</p>'
        : d.mismatchedYears
            .map((m) => `<div class="callout danger"><b>${m.year} 年</b>：${m.message}</div>`)
            .join('')
    }
    <h3>图像侧异常提示（伪轮/缺轮）</h3>
    ${
      d.anomalyWarnings.length === 0
        ? '<p>无。</p>'
        : d.anomalyWarnings
            .map((w) => `<div class="callout"><b>${w.year ?? ''} 年 · ${flagLabel(w.flag)}</b>：${w.message}</div>`)
            .join('')
    }`;
}

function renderChronology(): void {
  const el = document.getElementById('chronoContent') as HTMLElement;
  const c = state.chronology;
  if (!c) {
    el.className = 'dating-empty';
    el.textContent = '尚未构建年表：先完成各芯定年，再点击「构建样地年表」。';
    return;
  }
  el.className = '';
  const stats = chronologyStats(c);
  el.innerHTML = `
    <div class="callout">演示数据每根芯刻意注入了缺轮；若未在图上人工补轮就直接定年，序列按缺轮数整体错位，年表两端会相应外扩（真值范围 1950–2020）。实际工作中应先按定年告警补回缺轮、重算后再建年表。</div>
    <div class="metric-grid">
      <div class="metric"><div class="k">覆盖年份</div><div class="v">${c.years[0]}–${c.years[c.years.length - 1]}</div></div>
      <div class="metric"><div class="k">年数</div><div class="v">${c.years.length}</div></div>
      <div class="metric"><div class="k">平均敏感度</div><div class="v">${stats.meanSensitivity}</div></div>
      <div class="metric"><div class="k">指数均值 / 标准差</div><div class="v">${stats.meanIndex} / ${stats.stdIndex}</div></div>
      <div class="metric"><div class="k">最大样本深度</div><div class="v">${stats.maxDepth}</div></div>
    </div>
    <canvas class="chrono-chart" id="chronoChart"></canvas>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr>
      <th>年份</th><th>年表指数</th><th>平均年宽 mm</th><th>样本深度</th>
    </tr></thead><tbody>
      ${c.years
        .map(
          (y, i) => `<tr><td>${y}</td><td>${c.indices[i].toFixed(3)}</td>
            <td>${c.meanWidths[i].toFixed(2)}</td><td>${c.sampleDepth[i]}</td></tr>`,
        )
        .join('')}
    </tbody></table></div>`;
  requestAnimationFrame(() => drawChronoChart(c.years, c.indices, c.sampleDepth));
}

function drawChronoChart(years: number[], indices: number[], depth: number[]): void {
  const cv = document.getElementById('chronoChart') as HTMLCanvasElement | null;
  if (!cv) return;
  const ctx = cv.getContext('2d')!;
  const w = (cv.width = cv.clientWidth);
  const h = (cv.height = cv.clientHeight);
  ctx.clearRect(0, 0, w, h);
  const pad = 34;
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  const x = (i: number) => pad + (i / (years.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  ctx.strokeStyle = '#e3e8ef';
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
  ctx.strokeStyle = '#1f6feb';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  indices.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.stroke();
  // 样本深度柱
  const maxDepth = Math.max(...depth);
  ctx.fillStyle = 'rgba(31,111,235,0.18)';
  const bw = Math.max(1, (w - pad * 2) / years.length);
  depth.forEach((d, i) => ctx.fillRect(x(i) - bw / 2, h - pad - (d / maxDepth) * 26, bw, (d / maxDepth) * 26));
  ctx.fillStyle = '#6b7686';
  ctx.font = '11px system-ui';
  ctx.fillText(String(years[0]), pad, h - 12);
  ctx.fillText(String(years[years.length - 1]), w - pad - 30, h - 12);
  ctx.fillText(max.toFixed(2), 4, 14);
  ctx.fillText(min.toFixed(2), 4, h - pad);
}

function renderTruth(): void {
  const el = document.getElementById('truthContent') as HTMLElement;
  if (!demoTruth) {
    el.className = 'dating-empty';
    el.textContent = '载入合成演示数据后，这里显示盲测芯的真值与识别结果对照。';
    return;
  }
  const blind = Object.values(state.samples).find((s) => s.sample.name === 'BLIND-1');
  if (!blind) return;
  el.className = '';
  const trueMiss = demoTruth.anomalies.filter((a) => a.type === 'missing-ring').length;
  const trueFalse = demoTruth.anomalies.filter((a) => a.type === 'false-ring').length;
  const detMiss = blind.measurements.filter((m) => m.flags.some((f) => f.type === 'missing-ring')).length;
  const detFalse = blind.measurements.filter((m) => m.flags.some((f) => f.type === 'false-ring')).length;
  // 位置误差（有序匹配，容差 6px）
  let matched = 0;
  let distSum = 0;
  if (blind.detection) {
    const det = blind.detection.peakPositions;
    const tru = demoTruth.trueBoundaryX;
    let ti = 0;
    let di = 0;
    while (ti < tru.length && di < det.length) {
      const dd = Math.abs(tru[ti] - det[di]);
      if (dd <= 6) {
        matched++;
        distSum += dd;
        ti++;
        di++;
      } else if (tru[ti] < det[di]) ti++;
      else di++;
    }
  }
  const recall = demoTruth.trueBoundaryX.length
    ? (matched / demoTruth.trueBoundaryX.length) * 100
    : 0;
  el.innerHTML = `
    <p style="color:#6b7686">盲测芯 BLIND-1 与建年表的 10 根芯同源但独立采样，用于客观考核识别与定年。</p>
    <div class="truth-grid">
      <div class="truth-item"><div class="k">真值边界数 / 识别边界数</div><div class="v">${demoTruth.trueBoundaryX.length} / ${blind.sample.boundaries.length}</div></div>
      <div class="truth-item"><div class="k">边界召回率（容差 6px）</div><div class="v ${recall >= 97 ? 'good' : 'bad'}" style="color:${recall >= 97 ? 'var(--ok)' : 'var(--danger)'}">${recall.toFixed(1)}%</div></div>
      <div class="truth-item"><div class="k">匹配边界平均位置误差</div><div class="v">${matched ? (distSum / matched).toFixed(2) : '—'} px</div></div>
      <div class="truth-item"><div class="k">缺轮 真值 / 提示</div><div class="v">${trueMiss} / ${detMiss}</div></div>
      <div class="truth-item"><div class="k">伪轮 真值 / 提示</div><div class="v">${trueFalse} / ${detFalse}</div></div>
      <div class="truth-item"><div class="k">定年端点（补轮前后）</div><div class="v">${blind.dating ? blind.dating.best.endYear : '未定年'} / 真值 ${demoTruth.calendarYears[demoTruth.calendarYears.length - 1]}</div></div>
    </div>
    <h3>注入异常真值明细</h3>
    <div class="table-wrap"><table><thead><tr><th>日历年</th><th>类型</th><th>说明</th></tr></thead><tbody>
      ${demoTruth.anomalies
        .map((a) => `<tr><td>${a.year ?? '—'}</td><td>${flagLabel(a.type)}</td><td style="text-align:left">${a.message}</td></tr>`)
        .join('')}
    </tbody></table></div>`;
}

subscribe(state, render);
render();

// ?autodemo=1：自动跑通「合成 → 识别 → 定年 → 年表」，用于自检与无头验证
if (new URLSearchParams(location.search).has('autodemo')) {
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  loadDemo();
  const sampleIds = Object.keys(state.samples);
  // 建年表的芯逐根识别+定年；盲测芯(BLIND-1)独立走识别+定年用于核对，不并入年表
  for (const id of sampleIds) {
    runDetection(state, id);
    dateSample(state, id);
  }
  // 年表只由常规芯（非 BLIND）构建，避免盲芯缺轮拉宽年份范围
  const blindIdNow = sampleIds.find((id) => state.samples[id].sample.name === 'BLIND-1');
  const chronoIds = sampleIds.filter((id) => id !== blindIdNow);
  buildPlotChronology(state, chronoIds);
  // 切到盲测芯便于人工查看定年核对
  if (blindIdNow) state.currentSampleId = blindIdNow;
  render();
  // 查询参数指定初始标签页（无头验证用）
  const tab = new URLSearchParams(location.search).get('tab');
  if (tab) {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`) as HTMLElement | null;
    btn?.click();
  }
  setTimeout(() => {
    const root = document.documentElement;
    root.dataset.autodemo = errors.length ? 'error' : 'done';
    root.dataset.autodemoErrors = errors.join(' | ');
    root.dataset.sampleCount = String(sampleIds.length);
    root.dataset.chronoYears = String(state.chronology?.years.length ?? 0);
  }, 300);
}
