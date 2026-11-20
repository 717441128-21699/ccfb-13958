"use strict";

// src/util.ts
function median(a) {
  const arr = Array.from(a).sort((x, y) => x - y);
  const n = arr.length;
  if (!n) return 0;
  const m = n >> 1;
  return n % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}
function mad(a) {
  const med = median(a);
  const dev = Array.from(a).map((v) => Math.abs(v - med));
  return median(dev);
}
function pearson(a, b, n = Math.min(a.length, b.length)) {
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const den = Math.sqrt(saa * sbb);
  return den > 0 ? sab / den : 0;
}
function gaussianSmooth(a, sigma) {
  const n = a.length, out = new Float64Array(n);
  if (sigma <= 0.01) {
    for (let i = 0; i < n; i++) out[i] = a[i];
    return out;
  }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= n) continue;
      s += a[idx] * k[j + r];
      w += k[j + r];
    }
    out[i] = s / w;
  }
  return out;
}
function biweightMean(vals) {
  const n = vals.length;
  if (!n) return NaN;
  if (n === 1) return vals[0];
  const med = median(vals);
  const m = mad(vals);
  if (m < 1e-12) return med;
  let sw = 0, swx = 0;
  for (const v of vals) {
    const u = (v - med) / (9 * m);
    if (Math.abs(u) < 1) {
      const w = (1 - u * u) ** 2;
      sw += w;
      swx += w * v;
    }
  }
  return sw > 0 ? swx / sw : med;
}

// src/dendro.ts
function movingAvgShrink(w, k) {
  const n = w.length, h = (k - 1) / 2, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
      s += w[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}
function gaussTrend(w, sigma) {
  const n = w.length, r = Math.ceil(sigma * 3), out = new Array(n);
  const ker = [];
  for (let i = -r; i <= r; i++) ker.push(Math.exp(-i * i / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) {
      const k = i + j;
      if (k < 0 || k >= n) continue;
      const wgt = ker[j + r];
      s += w[k] * wgt;
      ws += wgt;
    }
    out[i] = s / ws;
  }
  return out;
}
function buildIndex(widths, firstYear, method) {
  const n = widths.length;
  if (method === "diff") {
    const years2 = [], idx2 = [];
    for (let i = 1; i < n; i++) {
      years2.push(firstYear + i);
      idx2.push(Math.log(Math.max(widths[i], 1e-6)) - Math.log(Math.max(widths[i - 1], 1e-6)));
    }
    return { years: years2, idx: idx2 };
  }
  const trend = method === "ma11" ? movingAvgShrink(widths, 11) : gaussTrend(widths, 8);
  const years = [], idx = [];
  for (let i = 0; i < n; i++) {
    const t = trend[i];
    if (!(t > 0)) continue;
    years.push(firstYear + i);
    idx.push(widths[i] / t);
  }
  return { years, idx };
}
function tBP(r, n) {
  if (n < 4) return 0;
  const v = 1 - r * r;
  if (v <= 1e-12) return r > 0 ? 999 : -999;
  return r * Math.sqrt((n - 2) / v);
}
function alignPairs(sample, mMap) {
  const s = [], m = [], years = [];
  for (let i = 0; i < sample.years.length; i++) {
    const mv = mMap.get(sample.years[i]);
    if (mv !== void 0) {
      s.push(sample.idx[i]);
      m.push(mv);
      years.push(sample.years[i]);
    }
  }
  return { s, m, years };
}
function glkOf(s, m, alreadyDiff) {
  let agree = 0, cnt = 0;
  if (alreadyDiff) {
    for (let i = 0; i < s.length; i++) {
      cnt++;
      if (s[i] === 0 || m[i] === 0) {
        agree += 0.5;
        continue;
      }
      if (Math.sign(s[i]) === Math.sign(m[i])) agree++;
    }
  } else {
    for (let i = 1; i < s.length; i++) {
      const ds = s[i] - s[i - 1], dm = m[i] - m[i - 1];
      cnt++;
      if (ds === 0 || dm === 0) {
        agree += 0.5;
        continue;
      }
      if (Math.sign(ds) === Math.sign(dm)) agree++;
    }
  }
  if (!cnt) return { glk: 0, z: 0 };
  return { glk: agree / cnt, z: (agree - cnt / 2) / Math.sqrt(cnt / 4) };
}
function masterForMethod(master, method) {
  if (method !== "diff") return master;
  const years = [], idx = [];
  for (let i = 1; i < master.years.length; i++) {
    if (master.years[i] !== master.years[i - 1] + 1) continue;
    years.push(master.years[i]);
    idx.push(Math.log(Math.max(master.idx[i], 1e-6)) - Math.log(Math.max(master.idx[i - 1], 1e-6)));
  }
  return { years, idx };
}
function crossdateWidths(widths, master, method, minOverlap = 30, topN = 10) {
  const n = widths.length;
  const mast = masterForMethod(master, method);
  const mMap = /* @__PURE__ */ new Map();
  mast.years.forEach((y, i) => mMap.set(y, mast.idx[i]));
  const mStart = mast.years[0], mEnd = mast.years[mast.years.length - 1];
  const out = [];
  for (let fy = mStart - n + minOverlap; fy <= mEnd - minOverlap + 1; fy++) {
    const sample = buildIndex(widths, fy, method);
    const { s, m } = alignPairs(sample, mMap);
    if (s.length < minOverlap) continue;
    const r = pearson(s, m);
    const { glk, z } = glkOf(s, m, method === "diff");
    out.push({ firstYear: fy, overlap: s.length, r, t: tBP(r, s.length), glk, glkZ: z });
  }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, topN);
}
function tAt(widths, fy, mMap, method, minOverlap) {
  const sample = buildIndex(widths, fy, method);
  const { s, m } = alignPairs(sample, mMap);
  if (s.length < minOverlap) return -999;
  return tBP(pearson(s, m), s.length);
}
function masterMap(master, method) {
  const mast = masterForMethod(master, method);
  const mMap = /* @__PURE__ */ new Map();
  mast.years.forEach((y, i) => mMap.set(y, mast.idx[i]));
  return mMap;
}
function scanInsertions(widths, fy, master, method, minOverlap = 25) {
  const mMap = masterMap(master, method);
  const base = Math.max(
    tAt(widths, fy - 1, mMap, method, minOverlap),
    tAt(widths, fy, mMap, method, minOverlap),
    tAt(widths, fy + 1, mMap, method, minOverlap)
  );
  const out = [];
  for (let p = 6; p <= widths.length - 6; p++) {
    const nb = (widths[p - 1] + widths[p]) / 2;
    for (const k of [1, 2]) {
      const w2 = [...widths.slice(0, p), ...Array(k).fill(nb), ...widths.slice(p)];
      const t2 = Math.max(tAt(w2, fy - 1, mMap, method, minOverlap), tAt(w2, fy, mMap, method, minOverlap), tAt(w2, fy + 1, mMap, method, minOverlap));
      out.push({ pos: p, year: fy + p, count: k, tBefore: base, tAfter: t2, delta: t2 - base });
    }
  }
  return out.filter((s) => s.delta >= 0.6 && s.tAfter >= 3.5).sort((a, b) => b.delta - a.delta).filter((s, i, arr) => arr.findIndex((o) => Math.abs(o.pos - s.pos) <= 1) === i).slice(0, 12);
}
function combineChronology(series, method) {
  const per = /* @__PURE__ */ new Map();
  for (const s of series) {
    const idx = buildIndex(s.widths, s.firstYear, method);
    for (let i = 0; i < idx.years.length; i++) {
      const y = idx.years[i];
      if (!per.has(y)) per.set(y, []);
      per.get(y).push(idx.idx[i]);
    }
  }
  const years = [...per.keys()].sort((a, b) => a - b);
  return {
    years,
    idx: years.map((y) => biweightMean(per.get(y))),
    depth: years.map((y) => per.get(y).length)
  };
}

// src/synth.ts
var defaultSynthParams = {
  startYear: 1820,
  endYear: 2020,
  trees: 6,
  coresPerTree: 2,
  meanWidthMm: 1.2,
  signal: 0.6,
  falsePerCore: 2,
  missingPerCore: 1,
  dpi: 1200,
  seed: 42
};
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function generateClimate(n, rng) {
  const c = new Array(n);
  let v = 0;
  for (let i2 = 0; i2 < n; i2++) {
    v = 0.45 * v + randn(rng) * 0.16;
    c[i2] = v;
  }
  let i = 10 + Math.floor(rng() * 10);
  while (i < n - 3) {
    const sev = 0.35 + rng() * 0.25;
    c[i] -= sev;
    c[i + 1] -= sev * 0.4;
    i += 12 + Math.floor(rng() * 18);
  }
  return c.map((x) => 1 + x);
}
function generateCore(name, climate, startYear, rng, p, treeSens) {
  const n = climate.length;
  const widths = [], ewF = [], years = [];
  let ar = 0;
  for (let i = 0; i < n; i++) {
    const trend = p.meanWidthMm * (0.35 + 0.65 * Math.exp(-i / 90));
    ar = 0.5 * ar + randn(rng) * 0.12;
    let w = trend * (1 + treeSens * p.signal * (climate[i] - 1) + ar * (1.2 - p.signal));
    widths.push(Math.max(0.06, w));
    ewF.push(0.68 + rng() * 0.15);
    years.push(startYear + i);
  }
  const missIdx = /* @__PURE__ */ new Set();
  const missingYears = [];
  let guard = 0;
  while (missingYears.length < p.missingPerCore && guard++ < 200) {
    const k = 5 + Math.floor(rng() * (n - 10));
    if (missIdx.has(k)) continue;
    missIdx.add(k);
    missingYears.push(years[k]);
  }
  const frIdx = /* @__PURE__ */ new Set();
  const falseRings = [];
  guard = 0;
  while (falseRings.length < p.falsePerCore && guard++ < 200) {
    const k = 5 + Math.floor(rng() * (n - 10));
    if (missIdx.has(k) || frIdx.has(k)) continue;
    frIdx.add(k);
    falseRings.push({ year: years[k], posFrac: 0.25 + rng() * 0.35, depth: 0.5 + rng() * 0.25 });
  }
  const w2 = [], y2 = [], e2 = [];
  for (let i = 0; i < n; i++) {
    if (missIdx.has(i)) continue;
    w2.push(widths[i]);
    y2.push(years[i]);
    e2.push(ewF[i]);
  }
  return {
    name,
    firstYear: startYear,
    years: y2,
    widthsMm: w2,
    ewFrac: e2,
    trueWidthsMm: widths,
    missingYears,
    falseRings
  };
}
function synthProfile(model, pxPerMm, rng) {
  const totalMm = model.widthsMm.reduce((a, b) => a + b, 0);
  const cap = Math.max(8, Math.round(totalMm * pxPerMm) + 4);
  const out = new Float64Array(cap);
  const frByYear = new Map(model.falseRings.map((f) => [f.year, f]));
  const cum = [0];
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
      const local = i / pxPerMm - cum[r];
      let d;
      if (local < ew) {
        d = ewBase + local / ew * 18;
        if (fr) {
          const fc = ew * fr.posFrac;
          const fw = 0.05 + 0.05 * fr.depth;
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
  return out.subarray(0, Math.min(n, cap));
}
function generateSite(p) {
  const rng = mulberry32(p.seed);
  const nY = p.endYear - p.startYear + 1;
  const climate = generateClimate(nY, rng);
  const cores = [];
  for (let t = 0; t < p.trees; t++) {
    const sens = 1 + randn(rng) * 0.12;
    for (let c = 0; c < p.coresPerTree; c++) {
      cores.push(generateCore(`T${t + 1}${String.fromCharCode(65 + c)}`, climate, p.startYear, rng, p, sens));
    }
  }
  const master = combineChronology(
    cores.map((m) => ({ widths: m.trueWidthsMm, firstYear: m.firstYear })),
    "ma11"
  );
  return { cores, master, pxPerMm: p.dpi / 25.4 };
}

// src/detect.ts
function scanFalseBands(profile, rings, smoothSigma = 2) {
  const s = gaussianSmooth(profile, smoothSigma);
  const marks = [];
  for (const r of rings) {
    const a = r.startS, b = r.ewEndS;
    const len = r.endS - r.startS;
    if (b - a < 6) continue;
    const i0 = Math.ceil(a + 0.12 * len), i1 = Math.floor(b - 0.03 * len);
    if (i1 - i0 < 4) continue;
    const f = segFeatures(s, r.startS, r.endS);
    const ringContrast = f.lwMax - f.ewMin;
    if (ringContrast <= 0) continue;
    let peak = -1e9, peakPos = i0;
    for (let i = i0; i <= i1; i++) if (s[i] > peak) {
      peak = s[i];
      peakPos = i;
    }
    let minAfter = 1e9;
    for (let i = peakPos; i <= i1; i++) minAfter = Math.min(minAfter, s[i]);
    const contrast = peak - minAfter;
    const level = peak - f.ewMin;
    if (contrast >= 0.15 * ringContrast && level >= 0.2 * ringContrast) {
      marks.push({ pos: peakPos, score: Math.min(1, contrast / ringContrast) });
    }
  }
  return marks;
}
var clamp01 = (v) => Math.max(0, Math.min(1, v));
function segFeatures(s, a, b) {
  const n = s.length;
  const i0 = Math.max(0, Math.ceil(a)), i1 = Math.min(n - 1, Math.floor(b));
  if (i1 - i0 < 2) return { ewEnd: (a + b) / 2, lwMax: 0, ewMin: 0 };
  const outer = i0 + Math.floor((i1 - i0) * 0.4);
  let lwMax = -1e9, maxPos = outer;
  for (let i = outer; i <= i1; i++) if (s[i] > lwMax) {
    lwMax = s[i];
    maxPos = i;
  }
  let ewMin = 1e9;
  for (let i = i0; i <= Math.max(i0, maxPos); i++) ewMin = Math.min(ewMin, s[i]);
  const thr = ewMin + 0.5 * (lwMax - ewMin);
  let p = i0;
  for (let i = maxPos; i >= i0; i--) {
    if (s[i] < thr) {
      p = i;
      break;
    }
  }
  let ewEnd = p;
  if (p + 1 <= i1) {
    const f = (thr - s[p]) / (s[p + 1] - s[p] || 1e-9);
    ewEnd = p + clamp01(f);
  }
  return { ewEnd, lwMax, ewMin };
}
function detectRings(profile, o) {
  const n = profile.length;
  if (n < 8) return [];
  const s = gaussianSmooth(profile, o.smoothSigma);
  const neg = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) neg[i] = (s[i - 1] - s[i + 1]) / 2;
  const med = median(neg), sc = 1.4826 * mad(neg) || 1e-6;
  const thr = med + o.threshK * sc;
  const cand = [];
  for (let i = 2; i < n - 2; i++) {
    if (neg[i] > thr && neg[i] >= neg[i - 1] && neg[i] >= neg[i + 1] && neg[i] > neg[i - 2] && neg[i] > neg[i + 2]) {
      const y0 = neg[i - 1], y1 = neg[i], y2 = neg[i + 1];
      const den = y0 - 2 * y1 + y2;
      const off = den !== 0 ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den)) : 0;
      cand.push({ pos: i + off, str: y1 });
    }
  }
  cand.sort((a, b) => b.str - a.str);
  const kept = [];
  for (const c of cand) if (kept.every((k) => Math.abs(k.pos - c.pos) >= o.minWidthS)) kept.push(c);
  kept.sort((a, b) => a.pos - b.pos);
  const edges = [0, ...kept.map((k) => k.pos), n - 1];
  const sFeat = gaussianSmooth(profile, Math.min(0.8, o.smoothSigma * 0.5));
  const segs = [];
  for (let j = 0; j < edges.length - 1; j++) {
    const a = edges[j], b = edges[j + 1];
    if (b - a < 2) continue;
    const f = segFeatures(sFeat, a, b);
    segs.push({ a, b, ...f, lwW: b - f.ewEnd, ewW: f.ewEnd - a });
  }
  if (!segs.length) return [];
  const lwTyp = median(segs.map((g) => g.lwMax));
  const drops = [];
  for (let j = 0; j < segs.length - 1; j++) drops.push(segs[j].lwMax - segs[j + 1].ewMin);
  const dropTyp = median(drops) || 1e-9;
  const theta = 0.55 - 0.3 * clamp01(o.falseK);
  return segs.map((g, j) => {
    let score = 0;
    if (j < segs.length - 1) {
      const lo = Math.max(0, j - 8), hi = Math.min(segs.length - 1, j + 8);
      const localEwTyp = median(segs.slice(lo, hi + 1).map((x) => x.ewW));
      const drop = g.lwMax - segs[j + 1].ewMin;
      const f1 = lwTyp > 0 ? clamp01((0.85 - g.lwMax / lwTyp) / 0.3) : 0;
      const f2 = clamp01((0.8 - drop / dropTyp) / 0.35);
      const f3 = localEwTyp > 0 ? clamp01(1 - segs[j + 1].ewW / (0.55 * localEwTyp)) : 0;
      score = 0.4 * f1 + 0.4 * f2 + 0.2 * f3;
    }
    return {
      startS: g.a,
      endS: g.b,
      ewEndS: g.ewEnd,
      falseRing: score > theta,
      falseScore: score
    };
  });
}

// test/run-tests.ts
var fails = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fails++;
}
{
  const t = tBP(0.6, 50);
  check("t_BP \u6570\u503C", Math.abs(t - 5.196) < 0.01, `t=${t.toFixed(3)}`);
}
var P = { ...defaultSynthParams, trees: 4, coresPerTree: 2, falsePerCore: 3, missingPerCore: 2, seed: 7 };
var site = generateSite(P);
console.log(`\u5408\u6210\u6837\u5730: ${site.cores.length} \u6839\u82AF, \u6807\u51C6\u5E74\u8868 ${site.master.years[0]}\u2013${site.master.years[site.master.years.length - 1]}`);
var results = [];
var sumRingsTrue = 0;
var sumRingsDet = 0;
var falseTP = 0;
var falseFP = 0;
var falseFN = 0;
var maeSum = 0;
var maeCnt = 0;
var maeMax = 0;
for (const core of site.cores) {
  let align = function(tol, off) {
    const pairs2 = [];
    let i = 0, j = 0;
    while (i < trueCum.length && j < detCum.length) {
      const d = trueCum[i] - detCum[j] - off;
      if (Math.abs(d) < tol(i)) {
        pairs2.push([i, j]);
        i++;
        j++;
      } else if (d > 0) j++;
      else i++;
    }
    return pairs2;
  };
  align2 = align;
  const rng = mulberry32(1234);
  const prof = synthProfile(core, site.pxPerMm, rng);
  const rings = detectRings(prof, {
    minWidthS: 0.06 * site.pxPerMm,
    smoothSigma: 1.5,
    threshK: 3.5,
    falseK: 0.5
  });
  const eff = rings.filter((r) => !r.falseRing);
  const trueCum = [];
  let acc = 0;
  for (const w of core.widthsMm) {
    acc += w;
    trueCum.push(acc);
  }
  const detCum = [];
  acc = 0;
  for (const r of eff) {
    acc += (r.endS - r.startS) / site.pxPerMm;
    detCum.push(acc);
  }
  let pairs = align((i) => 0.35 * core.widthsMm[Math.min(i, core.widthsMm.length - 1)] + 0.15, 0);
  const offs = pairs.map(([a, b]) => trueCum[a] - detCum[b]).sort((x, y) => x - y);
  const offset = offs.length ? offs[offs.length >> 1] : 0;
  pairs = align(() => 0.08, offset);
  for (const [a, b] of pairs) {
    const e = Math.abs(trueCum[a] - detCum[b] - offset);
    maeSum += e;
    maeCnt++;
    if (e > maeMax) maeMax = e;
  }
  const bandMarks = scanFalseBands(prof, eff, 1).map((mk) => mk.pos / site.pxPerMm + offset);
  const flaggedBounds = rings.filter((r) => r.falseRing).map((r) => r.endS / site.pxPerMm + offset);
  const allMarks = [...flaggedBounds, ...bandMarks];
  const frMatched = /* @__PURE__ */ new Set();
  for (const f of core.falseRings) {
    const k = core.years.indexOf(f.year);
    if (k < 0) continue;
    const lo = k === 0 ? 0 : trueCum[k - 1], hi = trueCum[k];
    const hit = allMarks.findIndex((x) => x > lo - 0.1 && x < hi + 0.1);
    if (hit >= 0) {
      falseTP++;
      frMatched.add(hit);
    } else falseFN++;
  }
  for (const fb of flaggedBounds) {
    if (trueCum.some((tc) => Math.abs(tc - fb) < 0.08)) falseFP++;
  }
  for (const bm of bandMarks) {
    const inPlanted = core.falseRings.some((f) => {
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
var align2;
console.log(`\u8F6E\u6570: \u771F ${sumRingsTrue} / \u68C0\u51FA ${sumRingsDet}`);
console.log(`\u8FB9\u754C\u8BEF\u5DEE: MAE ${(maeSum / Math.max(1, maeCnt)).toFixed(3)} mm, \u6700\u5927 ${maeMax.toFixed(3)} mm`);
console.log(`\u4F2A\u5E74\u8F6E: \u68C0\u51FA ${falseTP}, \u6F0F\u62A5 ${falseFN}, \u8BEF\u62A5 ${falseFP}`);
check("\u8F6E\u6570\u504F\u5DEE < 3%", Math.abs(sumRingsDet - sumRingsTrue) < sumRingsTrue * 0.03, `${sumRingsDet}/${sumRingsTrue}`);
check("\u8FB9\u754C MAE < 0.03 mm", maeSum / Math.max(1, maeCnt) < 0.03);
check("\u4F2A\u5E74\u8F6E\u53EC\u56DE \u2265 60%", falseTP / Math.max(1, falseTP + falseFN) >= 0.6, `${falseTP}/${falseTP + falseFN}`);
check("\u4F2A\u5E74\u8F6E\u8BEF\u62A5 \u2264 \u6F0F\u62A5+\u68C0\u51FA \u7684 35%", falseFP <= 0.35 * (falseTP + falseFN) + 1, `FP=${falseFP}`);
var dateOK = 0;
var dateTot = 0;
for (const r of results) {
  const widths = r.eff.map((g) => (g.endS - g.startS) / site.pxPerMm);
  const matches = crossdateWidths(widths, site.master, "diff", 30, 5);
  if (!matches.length) continue;
  dateTot++;
  const err = Math.abs(matches[0].firstYear - r.core.firstYear);
  if (err <= 1) dateOK++;
  if (results.indexOf(r) < 3) {
    console.log(`  ${r.core.name}: \u5B9A\u5E74 ${matches[0].firstYear} (\u771F ${r.core.firstYear}), t=${matches[0].t.toFixed(1)}, r=${matches[0].r.toFixed(2)}, GLK=${(matches[0].glk * 100).toFixed(0)}%`);
  }
}
console.log(`\u5B9A\u5E74\u547D\u4E2D\u7387(\xB11\u5E74): ${dateOK}/${dateTot}`);
check("\u4EA4\u53C9\u5B9A\u5E74\u547D\u4E2D \u2265 70%", dateOK / Math.max(1, dateTot) >= 0.7, `${dateOK}/${dateTot}`);
var missHit = 0;
var missTot = 0;
for (const r of results) {
  let widths = r.eff.map((g) => (g.endS - g.startS) / site.pxPerMm);
  const matches = crossdateWidths(widths, site.master, "diff", 30, 1);
  if (!matches.length) continue;
  const fy = matches[0].firstYear;
  const sugYears = /* @__PURE__ */ new Set();
  for (let round = 0; round < 4; round++) {
    const sugs = scanInsertions(widths, fy, site.master, "diff", 25);
    for (const s of sugs) sugYears.add(s.year);
    if (!sugs.length) break;
    const best = sugs[0];
    const nb = best.pos === 0 ? widths[0] : best.pos >= widths.length ? widths[widths.length - 1] : (widths[best.pos - 1] + widths[best.pos]) / 2;
    widths = [...widths.slice(0, best.pos), ...Array(best.count).fill(nb), ...widths.slice(best.pos)];
  }
  for (const my of r.core.missingYears) {
    missTot++;
    if ([my - 2, my - 1, my, my + 1, my + 2].some((y) => sugYears.has(y))) missHit++;
  }
}
console.log(`\u7F3A\u8F6E\u63D0\u793A\u547D\u4E2D: ${missHit}/${missTot}`);
check("\u7F3A\u8F6E\u63D0\u793A\u547D\u4E2D \u2265 50%", missHit / Math.max(1, missTot) >= 0.5, `${missHit}/${missTot}`);
{
  const chr = combineChronology(
    site.cores.map((c) => ({ widths: c.trueWidthsMm, firstYear: c.firstYear })),
    "ma11"
  );
  check("\u5E74\u8868\u5E74\u4EFD\u8FDE\u7EED", chr.years.length === P.endYear - P.startYear + 1);
  check("\u5E74\u8868\u6837\u672C\u6DF1\u5EA6\u6B63\u786E", Math.max(...chr.depth) === site.cores.length, `maxDepth=${Math.max(...chr.depth)}`);
  const idx = buildIndex([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2], 1900, "diff");
  check("\u6307\u6570\u5E74\u4EFD\u5BF9\u9F50", idx.years[0] === 1901 && idx.years.length === 31);
}
console.log(fails ? `
${fails} \u9879\u672A\u901A\u8FC7` : "\n\u5168\u90E8\u901A\u8FC7");
process.exit(fails ? 1 : 0);
