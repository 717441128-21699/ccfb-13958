// 无浏览器端到端自检:合成样地 → 密度剖面 → 边界识别 → 交叉定年 → 缺轮诊断
import { generateSite, synthProfile, mulberry32, defaultSynthParams, CoreModel } from '../src/synth';
import { detectRings, DetRing, scanFalseBands } from '../src/detect';
import { crossdateWidths, scanInsertions, tBP, combineChronology, buildIndex } from '../src/dendro';

let fails = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`);
  if (!cond) fails++;
}

// ---------- 1. t_BP 公式 ----------
{
  const t = tBP(0.6, 50); // 0.6*sqrt(48/0.64)=5.196
  check('t_BP 数值', Math.abs(t - 5.196) < 0.01, `t=${t.toFixed(3)}`);
}

// ---------- 2. 合成 → 检测 ----------
const P = { ...defaultSynthParams, trees: 4, coresPerTree: 2, falsePerCore: 3, missingPerCore: 2, seed: 7 };
const site = generateSite(P);
console.log(`合成样地: ${site.cores.length} 根芯, 标准年表 ${site.master.years[0]}–${site.master.years[site.master.years.length - 1]}`);

interface CoreResult {
  core: CoreModel; rings: DetRing[]; eff: DetRing[];
  detCumMm: number[]; trueCumMm: number[];
  offset: number; // 检测累积位置相对真值的平移
}

const results: CoreResult[] = [];
let sumRingsTrue = 0, sumRingsDet = 0;
let falseTP = 0, falseFP = 0, falseFN = 0;
let maeSum = 0, maeCnt = 0, maeMax = 0;

for (const core of site.cores) {
  const rng = mulberry32(1234);
  const prof = synthProfile(core, site.pxPerMm, rng);
  const rings = detectRings(prof, {
    minWidthS: 0.06 * site.pxPerMm, smoothSigma: 1.5, threshK: 3.5, falseK: 0.5,
  });
  const eff = rings.filter(r => !r.falseRing);
  // 真值累积边界位置(mm)
  const trueCum: number[] = [];
  let acc = 0;
  for (const w of core.widthsMm) { acc += w; trueCum.push(acc); }
  const detCum: number[] = [];
  acc = 0;
  for (const r of eff) { acc += (r.endS - r.startS) / site.pxPerMm; detCum.push(acc); }
  // 两遍对齐:先粗配估平移,再按平移精配(容差 0.15mm)
  function align(tol: (i: number) => number, off: number): [number, number][] {
    const pairs: [number, number][] = [];
    let i = 0, j = 0;
    while (i < trueCum.length && j < detCum.length) {
      const d = trueCum[i] - detCum[j] - off;
      if (Math.abs(d) < tol(i)) { pairs.push([i, j]); i++; j++; }
      else if (d > 0) j++; else i++;
    }
    return pairs;
  }
  let pairs = align(i => 0.35 * core.widthsMm[Math.min(i, core.widthsMm.length - 1)] + 0.15, 0);
  const offs = pairs.map(([a, b]) => trueCum[a] - detCum[b]).sort((x, y) => x - y);
  const offset = offs.length ? offs[offs.length >> 1] : 0;
  pairs = align(() => 0.08, offset);
  // 边界误差
  for (const [a, b] of pairs) {
    const e = Math.abs(trueCum[a] - detCum[b] - offset);
    maeSum += e; maeCnt++; if (e > maeMax) maeMax = e;
  }
  // 伪年轮核对:植入伪轮所在真轮的累积区间内,是否有被标 false 的边界或轮内标记。
  // 误报的定义:被标 false 的边界与某条真边界重合(真边界被错误合并),或轮内标记不在任何植入伪轮区间内。
  const bandMarks = scanFalseBands(prof, eff, 1.0).map(mk => mk.pos / site.pxPerMm + offset);
  const flaggedBounds = rings.filter(r => r.falseRing).map(r => r.endS / site.pxPerMm + offset);
  const allMarks = [...flaggedBounds, ...bandMarks];
  const frMatched = new Set<number>();
  for (const f of core.falseRings) {
    const k = core.years.indexOf(f.year);
    if (k < 0) continue;
    const lo = k === 0 ? 0 : trueCum[k - 1], hi = trueCum[k];
    const hit = allMarks.findIndex(x => x > lo - 0.1 && x < hi + 0.1);
    if (hit >= 0) { falseTP++; frMatched.add(hit); } else falseFN++;
  }
  // 边界级误报:被标 false 的边界落在真边界 ±0.08mm 内(真边界被错杀)
  for (const fb of flaggedBounds) {
    if (trueCum.some(tc => Math.abs(tc - fb) < 0.08)) falseFP++;
  }
  // 轮内标记误报:不在任何植入伪轮区间内
  for (const bm of bandMarks) {
    const inPlanted = core.falseRings.some(f => {
      const k = core.years.indexOf(f.year);
      if (k < 0) return false;
      const lo = k === 0 ? 0 : trueCum[k - 1], hi = trueCum[k];
      return bm > lo - 0.1 && bm < hi + 0.1;
    });
    if (!inPlanted) falseFP++;
  }
  sumRingsTrue += core.years.length;
  sumRingsDet += eff.length;
  results.push({ core, rings, eff, detCumMm: detCum, trueCumMm: trueCum, offset });
}

console.log(`轮数: 真 ${sumRingsTrue} / 检出 ${sumRingsDet}`);
console.log(`边界误差: MAE ${(maeSum / Math.max(1, maeCnt)).toFixed(3)} mm, 最大 ${maeMax.toFixed(3)} mm`);
console.log(`伪年轮: 检出 ${falseTP}, 漏报 ${falseFN}, 误报 ${falseFP}`);
check('轮数偏差 < 3%', Math.abs(sumRingsDet - sumRingsTrue) < sumRingsTrue * 0.03, `${sumRingsDet}/${sumRingsTrue}`);
check('边界 MAE < 0.03 mm', maeSum / Math.max(1, maeCnt) < 0.03);
check('伪年轮召回 ≥ 60%', falseTP / Math.max(1, falseTP + falseFN) >= 0.6, `${falseTP}/${falseTP + falseFN}`);
check('伪年轮误报 ≤ 漏报+检出 的 35%', falseFP <= 0.35 * (falseTP + falseFN) + 1, `FP=${falseFP}`);

// ---------- 3. 交叉定年(用检出的轮宽) ----------
let dateOK = 0, dateTot = 0;
for (const r of results) {
  const widths = r.eff.map(g => (g.endS - g.startS) / site.pxPerMm);
  const matches = crossdateWidths(widths, site.master, 'diff', 30, 5);
  if (!matches.length) continue;
  dateTot++;
  const err = Math.abs(matches[0].firstYear - r.core.firstYear);
  if (err <= 1) dateOK++;
  if (results.indexOf(r) < 3) {
    console.log(`  ${r.core.name}: 定年 ${matches[0].firstYear} (真 ${r.core.firstYear}), t=${matches[0].t.toFixed(1)}, r=${matches[0].r.toFixed(2)}, GLK=${(matches[0].glk * 100).toFixed(0)}%`);
  }
}
console.log(`定年命中率(±1年): ${dateOK}/${dateTot}`);
check('交叉定年命中 ≥ 70%', dateOK / Math.max(1, dateTot) >= 0.7, `${dateOK}/${dateTot}`);

// ---------- 4. 缺轮扫描(迭代:应用最佳建议后重扫,最多 4 轮) ----------
// 命中判定:植入年份出现在任意一轮的建议列表中即算命中(实际工作中由人从这个列表里挑);
// 容差 ±2 年:定年偏移 1 年、上游边界合并/伪轮误判都会让建议位置平移 1~2 年,
// 建议的意义是"提示人到这一段图上去看",不是替代人下结论。
let missHit = 0, missTot = 0;
for (const r of results) {
  let widths = r.eff.map(g => (g.endS - g.startS) / site.pxPerMm);
  const matches = crossdateWidths(widths, site.master, 'diff', 30, 1);
  if (!matches.length) continue;
  const fy = matches[0].firstYear;
  const sugYears = new Set<number>();
  for (let round = 0; round < 4; round++) {
    const sugs = scanInsertions(widths, fy, site.master, 'diff', 25);
    for (const s of sugs) sugYears.add(s.year);
    if (!sugs.length) break;
    const best = sugs[0];
    const nb = best.pos === 0 ? widths[0] : best.pos >= widths.length ? widths[widths.length - 1] : (widths[best.pos - 1] + widths[best.pos]) / 2;
    widths = [...widths.slice(0, best.pos), ...Array<number>(best.count).fill(nb), ...widths.slice(best.pos)];
  }
  for (const my of r.core.missingYears) {
    missTot++;
    if ([my - 2, my - 1, my, my + 1, my + 2].some(y => sugYears.has(y))) missHit++;
  }
}
console.log(`缺轮提示命中: ${missHit}/${missTot}`);
check('缺轮提示命中 ≥ 50%', missHit / Math.max(1, missTot) >= 0.5, `${missHit}/${missTot}`);

// ---------- 5. 年表合成 ----------
{
  const chr = combineChronology(
    site.cores.map(c => ({ widths: c.trueWidthsMm, firstYear: c.firstYear })), 'ma11');
  check('年表年份连续', chr.years.length === P.endYear - P.startYear + 1);
  check('年表样本深度正确', Math.max(...chr.depth) === site.cores.length, `maxDepth=${Math.max(...chr.depth)}`);
  const idx = buildIndex([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2], 1900, 'diff');
  check('指数年份对齐', idx.years[0] === 1901 && idx.years.length === 31);
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
