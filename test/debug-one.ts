// 调试:误报来源 + 缺轮扫描逐轮情况
import { generateSite, synthProfile, mulberry32, defaultSynthParams } from '../src/synth';
import { detectRings, scanFalseBands } from '../src/detect';
import { crossdateWidths, scanInsertions } from '../src/dendro';

const P = { ...defaultSynthParams, trees: 4, coresPerTree: 2, falsePerCore: 3, missingPerCore: 2, seed: 7 };
const site = generateSite(P);
const pxPerMm = site.pxPerMm;

for (const core of site.cores) {
  const rng = mulberry32(1234);
  const prof = synthProfile(core, pxPerMm, rng);
  const rings = detectRings(prof, { minWidthS: 0.06 * pxPerMm, smoothSigma: 1.5, threshK: 3.5, falseK: 0.5 });
  const eff = rings.filter(r => !r.falseRing);
  const trueCum: number[] = [];
  let acc = 0;
  for (const w of core.widthsMm) { acc += w; trueCum.push(acc); }
  // 平移估计(粗)
  const detCum: number[] = [];
  acc = 0;
  for (const r of eff) { acc += (r.endS - r.startS) / pxPerMm; detCum.push(acc); }
  let off = 0;
  {
    const diffs: number[] = [];
    for (let i = 0; i < Math.min(trueCum.length, detCum.length); i++) diffs.push(trueCum[i] - detCum[i]);
    diffs.sort((a, b) => a - b);
    off = diffs[diffs.length >> 1] || 0;
  }
  const flagged = rings.filter(r => r.falseRing).map(r => ({ pos: r.endS / pxPerMm + off, score: r.falseScore }));
  const realKilled = flagged.filter(f => trueCum.some(tc => Math.abs(tc - f.pos) < 0.08));
  const bandMarks = scanFalseBands(prof, eff, 1.5).map(m => m.pos / pxPerMm + off);
  const bandFP = bandMarks.filter(bm => !core.falseRings.some(f => {
    const k = core.years.indexOf(f.year);
    if (k < 0) return false;
    const lo = k === 0 ? 0 : trueCum[k - 1], hi = trueCum[k];
    return bm > lo - 0.1 && bm < hi + 0.1;
  }));
  console.log(`${core.name}: 真${core.years.length} 有效${eff.length} 标伪${flagged.length}(杀真边界${realKilled.length}) 轮内标记${bandMarks.length}(误${bandFP.length}) 缺轮${core.missingYears.join(',')}`);
  if (realKilled.length) console.log(`   被杀的真边界: ${realKilled.map(f => f.pos.toFixed(2) + '(s=' + f.score.toFixed(2) + ')').join(' ')}`);
  if (bandFP.length) console.log(`   轮内误报: ${bandFP.map(x => x.toFixed(2)).join(' ')}`);
  // 缺轮逐轮
  let widths = eff.map(g => (g.endS - g.startS) / pxPerMm);
  const matches = crossdateWidths(widths, site.master, 'diff', 30, 1);
  if (!matches.length) { console.log('   定年失败'); continue; }
  const fy = matches[0].firstYear;
  process.stdout.write(`   定年${fy}(真${core.firstYear}) 建议轮次: `);
  for (let round = 0; round < 4; round++) {
    const sugs = scanInsertions(widths, fy, site.master, 'diff', 25);
    if (!sugs.length) { process.stdout.write('(无)'); break; }
    const best = sugs[0];
    process.stdout.write(`[${best.year}×${best.count} Δt=${best.delta.toFixed(1)}] `);
    const nb = best.pos === 0 ? widths[0] : best.pos >= widths.length ? widths[widths.length - 1] : (widths[best.pos - 1] + widths[best.pos]) / 2;
    widths = [...widths.slice(0, best.pos), ...Array<number>(best.count).fill(nb), ...widths.slice(best.pos)];
  }
  console.log();
}
