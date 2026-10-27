// Ablation study: which parts of the copy check matter? Each variant switches off one design choice of
// compareThumbs()/lookup and is scored on the same VISION copies as analyze_vision.js (test split).
// Usage: node --max-old-space-size=6000 ablation_vision.js <out_dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_ablation.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_ablation.json');
const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'));
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));
const D = SC.DEFAULTS, N = SC.N, NC = SC.NC, T = SC.TILES, TILE = N / T, CTILE = NC / T;

// Same split and records as analyze_vision.js.
const perDev = {};
for (const o of jobs.originals) { const i = (perDev[o.device] = (perDev[o.device] || 0) + 1) - 1; o.split = i % 10 < 3 ? 'cal' : 'test'; }
const words = hex => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8), 16) >>> 0];
const pop = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const refs = jobs.originals.map((o, i) => { const t = readThumb(o.phoneThumb); return { i, id: o.id, split: o.split, thumbs: t, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y) }; });
const n = refs.length, RH = new Uint32Array(n * 10);
refs.forEach((r, i) => [r.phash, ...r.quads].forEach((h, k) => { const w = words(h); RH[i * 10 + 2 * k] = w[0]; RH[i * 10 + 2 * k + 1] = w[1]; }));
const refIndex = Object.fromEntries(refs.map(r => [r.id, r.i]));
const lookup = (q, ri) => q.map(w => { const o = new Uint8Array(5); for (let k = 0; k < 5; k++) o[k] = pop(w[2 * k] ^ RH[ri * 10 + 2 * k]) + pop(w[2 * k + 1] ^ RH[ri * 10 + 2 * k + 1]); return o; });

// compareThumbs() with switches. Defaults reproduce the library exactly (checked below).
function tiles(ref, cand, { neigh = true, norm = true } = {}) {
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a, m) => Math.sqrt(Math.max(a.reduce((s, x) => s + x * x, 0) / a.length - m * m, 1e-6));
  let cy = Float64Array.from(cand.y), cb = Float64Array.from(cand.cb), cr = Float64Array.from(cand.cr);
  if (norm) {
    const ma = mean(ref.y), mb = mean(cand.y), k = sd(ref.y, ma) / sd(cand.y, mb);
    cy = cy.map(v => (v - mb) * k + ma);
    const dCb = mean(cand.cb) - mean(ref.cb), dCr = mean(cand.cr) - mean(ref.cr);
    cb = cb.map(v => v - dCb); cr = cr.map(v => v - dCr);
  }
  const diff = (r, c, nn, i, j) => {
    if (!neigh) return Math.abs(r[i * nn + j] - c[i * nn + j]);
    let best = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < nn && jj < nn) best = Math.min(best, Math.abs(r[ii * nn + jj] - c[i * nn + j]));
    }
    return best;
  };
  const luma = new Float32Array(T * T), chroma = new Float32Array(T * T);
  for (let tr = 0; tr < T; tr++) for (let tc = 0; tc < T; tc++) {
    let sl = 0, sc = 0;
    for (let r = tr * TILE; r < (tr + 1) * TILE; r++) for (let c = tc * TILE; c < (tc + 1) * TILE; c++) sl += diff(ref.y, cy, N, r, c);
    for (let r = tr * CTILE; r < (tr + 1) * CTILE; r++) for (let c = tc * CTILE; c < (tc + 1) * CTILE; c++) sc += (diff(ref.cb, cb, NC, r, c) + diff(ref.cr, cr, NC, r, c)) / 2;
    luma[tr * T + tc] = sl / (TILE * TILE); chroma[tr * T + tc] = sc / (CTILE * CTILE);
  }
  return { luma, chroma };
}
{ // the unswitched version must equal the library
  const a = refs[0].thumbs, b = readThumb(jobs.variants[0].thumb), lib = SC.compareThumbs(a, b), mine = tiles(a, b);
  for (let t = 0; t < T * T; t++) if (Math.abs(lib.luma[t] - mine.luma[t]) > 1e-3 || Math.abs(lib.chroma[t] - mine.chroma[t]) > 1e-3) throw new Error('tiles() differs from compareThumbs at tile ' + t);
}

const MODES = { full: {}, noNeigh: { neigh: false }, noNorm: { norm: false } };
const GEN = { dist: 18, quad: 9 };
const VISIBLE = v => v.magY >= 10 || v.magRGB >= 10;
const t0 = Date.now();
const scored = jobs.variants.map((v, vi) => {
  const cand = readThumb(v.thumb);
  const qs = SC.lookupQueries(cand);
  const q = qs.map(x => [x.phash, ...x.quads].flatMap(words));
  const ri = refIndex[v.ref];
  const recFor = (j, per) => {
    let b = 0; for (let k = 1; k < 4; k++) if (per[k][0] < per[b][0]) b = k;
    const c = SC.rotateThumbs(cand, qs[b].deg);
    return Object.fromEntries(Object.entries(MODES).map(([m, o]) => [m, tiles(refs[j].thumbs, c, o)]));
  };
  const own = lookup(q, ri);
  const others = [];
  for (let j = 0; j < n; j++) {
    if (j === ri) continue;
    const per = lookup(q, j);
    if (per.some(p => p[0] <= GEN.dist || (p[1] <= GEN.quad) + (p[2] <= GEN.quad) + (p[3] <= GEN.quad) + (p[4] <= GEN.quad) >= 2))
      others.push({ per, t: recFor(j, per) });
  }
  if (vi % 3000 === 0) console.error(`scored ${vi}/${jobs.variants.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return { v, split: refs[ri].split, own, ownT: recFor(ri, own), others };
});

// Candidate test, with or without the quadrant hashes.
const cand = (per, quads) => per.some(p => p[0] <= D.lookupMaxDistance ||
  (quads && (p[1] <= D.quadMaxDistance) + (p[2] <= D.quadMaxDistance) + (p[3] <= D.quadMaxDistance) + (p[4] <= D.quadMaxDistance) >= D.quadMinCount));
// Score of one record: largest region difference relative to the thresholds (<= 1 means MATCH).
const score = (t, chroma) => { let m = 0; for (let i = 0; i < t.luma.length; i++) m = Math.max(m, t.luma[i] / D.tileLuma, chroma ? t.chroma[i] / D.tileChroma : 0); return m; };

const VARIANTS = {
  'Full system': { mode: 'full', chroma: true, quads: true },
  'Without chroma check': { mode: 'full', chroma: false, quads: true },
  'Without quadrant lookup': { mode: 'full', chroma: true, quads: false },
  'Without neighbourhood tolerance': { mode: 'noNeigh', chroma: true, quads: true },
  'Without contrast/brightness adjustment': { mode: 'noNorm', chroma: true, quads: true },
};
// Decision at a threshold scale a: own record matches => correct; else another record matches => false accept.
function decide(s, V, a) {
  const ownOk = cand(s.own, V.quads) && score(s.ownT[V.mode], V.chroma) <= a;
  if (ownOk) return 'own';
  for (const o of s.others) if (cand(o.per, V.quads) && score(o.t[V.mode], V.chroma) <= a) return 'other';
  return cand(s.own, V.quads) ? 'modified' : 'unverified';
}
function rates(set, V, a) {
  let clean = 0, cleanOk = 0, vis = 0, caught = 0, fa = 0, found = 0;
  for (const s of set) {
    const d = decide(s, V, a);
    if (d === 'other') fa++;
    if (s.v.kind === 'clean') { clean++; if (d === 'own') cleanOk++; }
    else if (VISIBLE(s.v)) { vis++; if (d !== 'own' && d !== 'other') caught++; if (d === 'modified') found++; }
  }
  return { clean, cleanOk, vis, caught, falseAccept: fa, modifiedOwn: found };
}
function auc(pos, neg) { // P(score of unedited < score of edited), ties counted half
  const all = [...pos.map(x => [x, 1]), ...neg.map(x => [x, 0])].sort((p, q) => p[0] - q[0]);
  let below = 0, sum = 0, i = 0;
  while (i < all.length) {
    let j = i, p = 0, q = 0;
    while (j < all.length && all[j][0] === all[i][0]) { if (all[j][1]) p++; else q++; j++; }
    sum += q * (below + p / 2); below += p; i = j;
  }
  return sum / (pos.length * neg.length);
}

const cal = scored.filter(s => s.split === 'cal'), test = scored.filter(s => s.split === 'test');
const pct = (a, b, d = 1) => (100 * a / b).toFixed(d) + '%';
const lines = [], out = { variants: {} };
const log = s => { lines.push(s); console.log(s); };
log('# Ablation study (VISION, test split)\n');
log('Each row switches off one design choice. "Frozen" uses the system thresholds (luma 9, chroma 7); "calibrated" rescales the thresholds so that 99.5% of unedited calibration copies are accepted, as for the baselines.\n');
log('| variant | AUC | frozen: unedited accepted | frozen: edits rejected | frozen: false accepts | calibrated: unedited accepted | calibrated: edits rejected | calibrated: false accepts | edits shown as MODIFIED | edits rejected at 99.9% / 99.5% / 99.0% unedited accepted (test) |');
log('|---|---|---|---|---|---|---|---|---|---|');
for (const [name, V] of Object.entries(VARIANTS)) {
  const ownScore = s => (cand(s.own, V.quads) ? score(s.ownT[V.mode], V.chroma) : Infinity);
  const tc = test.filter(s => s.v.kind === 'clean'), te = test.filter(s => s.v.kind === 'edit' && VISIBLE(s.v));
  const A = auc(tc.map(ownScore), te.map(ownScore));
  const cs = cal.filter(s => s.v.kind === 'clean').map(ownScore).sort((x, y) => x - y);
  const scale = cs[Math.ceil(0.995 * cs.length) - 1];
  const fr = rates(test, V, 1), cr = rates(test, V, scale);
  // Same operating point for every variant (descriptive, read off the test ROC): edits rejected when a given
  // share of unedited test copies is accepted.
  const tcs = tc.map(ownScore).sort((x, y) => x - y), tes = te.map(ownScore);
  const at = q => { const thr = tcs[Math.ceil(q * tcs.length) - 1]; return tes.filter(x => x > thr).length / tes.length; };
  const op = { 0.999: at(0.999), 0.995: at(0.995), 0.99: at(0.99) };
  out.variants[name] = { auc: A, scale, frozen: fr, calibrated: cr, operatingPoints: op };
  log(`| ${name} | ${A.toFixed(3)} | ${pct(fr.cleanOk, fr.clean, 2)} | ${pct(fr.caught, fr.vis)} | ${fr.falseAccept} | ${pct(cr.cleanOk, cr.clean, 2)} | ${pct(cr.caught, cr.vis)} | ${cr.falseAccept} | ${pct(fr.modifiedOwn, fr.vis)} | ${(100 * op[0.999]).toFixed(1)}% / ${(100 * op[0.995]).toFixed(1)}% / ${(100 * op[0.99]).toFixed(1)}% |`);
}
// Lookup only: accept if the nearest record (any orientation) is within 12 bits; no region comparison.
{
  let clean = 0, cleanOk = 0, vis = 0, caught = 0, fa = 0;
  for (const s of test) {
    const ownD = Math.min(...s.own.map(p => p[0]));
    const othD = Math.min(Infinity, ...s.others.map(o => Math.min(...o.per.map(p => p[0]))));
    const best = Math.min(ownD, othD), acc = best <= D.lookupMaxDistance, ownWins = acc && ownD <= othD;
    if (acc && !ownWins) fa++;
    if (s.v.kind === 'clean') { clean++; if (ownWins) cleanOk++; } else if (VISIBLE(s.v)) { vis++; if (!acc) caught++; }
  }
  out.lookupOnly = { clean, cleanOk, vis, caught, falseAccept: fa };
  log(`| pHash lookup only (no region check) | - | ${pct(cleanOk, clean, 2)} | ${pct(caught, vis)} | ${fa} | - | - | - | - |`);
}
fs.writeFileSync(REPORT, lines.join('\n') + '\n');
fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log('\nwrote', REPORT, JSON_OUT);
