// Scores the VISION-based dataset from make_vision.py with the real securecam-core.js code.
// Photos are split per device into a calibration set (30%) and a test set (70%).
// Thresholds are chosen on the calibration set only; all reported rates are test-set rates.
// Usage: node analyze_vision.js <out_dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_vision.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_vision.json');
// JOBS: a partial merge of meta/*.json, for interim checks while make_vision.py is still running
const jobs = JSON.parse(fs.readFileSync(process.env.JOBS || path.join(OUT, 'jobs.json'), 'utf8'));
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));
const D = SC.DEFAULTS;

// 1. The NumPy port must match the JavaScript implementation exactly.
for (const p of jobs.parity) {
  const rgba = new Uint8Array(fs.readFileSync(path.join(OUT, p.raw)));
  const js = SC.thumbBytes(SC.thumbnailsFromRGBA(rgba, p.w, p.h));
  const py = new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', p.thumb + '.bin')));
  if (Buffer.compare(Buffer.from(js), Buffer.from(py)) !== 0) { console.error('PARITY FAILURE', p.thumb); process.exit(1); }
}

// 2. Split: within each device, photos 0,1,2 of every 10 go to calibration.
const perDev = {};
for (const o of jobs.originals) { const i = (perDev[o.device] = (perDev[o.device] || 0) + 1) - 1; o.split = i % 10 < 3 ? 'cal' : 'test'; }

// 3. Registry records = what the phone registers. Hashes also kept as 32-bit words for speed.
const words = hex => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8), 16) >>> 0];
const pop = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const refs = jobs.originals.map((o, i) => {
  const t = readThumb(o.phoneThumb);
  return { i, id: o.id, meta: o, thumbs: t, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y), full: readThumb(o.fullThumb) };
});
const n = refs.length;
const RH = new Uint32Array(n * 10);
refs.forEach((r, i) => [r.phash, ...r.quads].forEach((h, k) => { const w = words(h); RH[i * 10 + 2 * k] = w[0]; RH[i * 10 + 2 * k + 1] = w[1]; }));
const refIndex = Object.fromEntries(refs.map(r => [r.id, r.i]));
{ // self-check of the fast Hamming distance against the library one
  const a = refs[0], b = refs[n - 1], wa = words(a.phash), wb = words(b.phash);
  if (pop(wa[0] ^ wb[0]) + pop(wa[1] ^ wb[1]) !== SC.hamming(a.phash, b.phash)) throw new Error('hamming mismatch');
}

const phoneVsFull = refs.map(r => {
  const c = SC.compareThumbs(r.thumbs, r.full);
  return { d: SC.hamming(r.phash, SC.phashFromY(r.full.y)), maxLuma: c.maxLuma, maxChroma: c.maxChroma };
});

// Distinct photos: closest pairs of registered records.
const pairHist = new Array(65).fill(0);
const closePairs = [];
for (let i = 0; i < n; i++)
  for (let j = i + 1; j < n; j++) {
    const d = pop(RH[i * 10] ^ RH[j * 10]) + pop(RH[i * 10 + 1] ^ RH[j * 10 + 1]);
    pairHist[d]++;
    if (d <= D.lookupMaxDistance) closePairs.push({ a: refs[i].id, b: refs[j].id, d });
  }

// 4. Score each copy once against its own record and against every other record.
const GEN = { dist: 18, quad: 9 }; // generous lookup bound: anything outside can never be a candidate
function lookupAll(queries, ri) {
  // per orientation: [global distance, 4 quadrant distances]
  return queries.map(q => {
    const out = new Uint8Array(5);
    for (let k = 0; k < 5; k++) out[k] = pop(q.w[2 * k] ^ RH[ri * 10 + 2 * k]) + pop(q.w[2 * k + 1] ^ RH[ri * 10 + 2 * k + 1]);
    return out;
  });
}
// Per-region differences against one record, plus the regional SSIM that strict mode adds (SC.regionalSsim).
const tilesOf = (ref, cand, deg) => {
  const rc = SC.rotateThumbs(cand, deg), c = SC.compareThumbs(ref.thumbs, rc);
  return { luma: Float32Array.from(c.luma), chroma: Float32Array.from(c.chroma), ssim: Float32Array.from(SC.regionalSsim(ref.thumbs.y, rc.y).tiles) };
};
const bestDeg = per => { let b = 0; for (let k = 1; k < 4; k++) if (per[k][0] < per[b][0]) b = k; return b; };

// Baseline on the same stored data as scfp1: SSIM (8x8 windows) between the signed 128x128 luma
// thumbnail and the copy's thumbnail, averaged per region of a 16x16 grid; score = worst region.
function ssimThumb(a, b) {
  const N = SC.N, W = 8, m = N - W + 1, n1 = N + 1;
  const I = [0, 1, 2, 3, 4].map(() => new Float64Array(n1 * n1));
  for (let r = 0; r < N; r++) {
    const row = [0, 0, 0, 0, 0];
    for (let c = 0; c < N; c++) {
      const x = a[r * N + c], y = b[r * N + c];
      row[0] += x; row[1] += y; row[2] += x * x; row[3] += y * y; row[4] += x * y;
      for (let k = 0; k < 5; k++) I[k][(r + 1) * n1 + c + 1] = I[k][r * n1 + c + 1] + row[k];
    }
  }
  const box = (k, r, c) => I[k][(r + W) * n1 + c + W] - I[k][r * n1 + c + W] - I[k][(r + W) * n1 + c] + I[k][r * n1 + c];
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2, T = SC.TILES, cnt = W * W;
  const sum = new Float64Array(T * T), num = new Float64Array(T * T);
  let total = 0;
  for (let r = 0; r < m; r++)
    for (let c = 0; c < m; c++) {
      const ma = box(0, r, c) / cnt, mb = box(1, r, c) / cnt;
      const va = box(2, r, c) / cnt - ma * ma, vb = box(3, r, c) / cnt - mb * mb, cov = box(4, r, c) / cnt - ma * mb;
      const v = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      const t = Math.floor((r * T) / m) * T + Math.floor((c * T) / m);
      sum[t] += v; num[t]++; total += v;
    }
  let min = 1;
  for (let t = 0; t < T * T; t++) min = Math.min(min, sum[t] / num[t]);
  return { min, mean: total / (m * m) };
}

const t0 = Date.now();
const scored = jobs.variants.map((v, vi) => {
  const cand = readThumb(v.thumb);
  const queries = SC.lookupQueries(cand).map(q => ({ deg: q.deg, w: [q.phash, ...q.quads].flatMap(words) }));
  const ri = refIndex[v.ref];
  const own = lookupAll(queries, ri);
  const deg = queries[bestDeg(own)].deg;
  const others = [];
  for (let j = 0; j < n; j++) {
    if (j === ri) continue;
    const per = lookupAll(queries, j);
    let gen = false;
    for (const p of per) if (p[0] <= GEN.dist || (p[1] <= GEN.quad) + (p[2] <= GEN.quad) + (p[3] <= GEN.quad) + (p[4] <= GEN.quad) >= 2) gen = true;
    if (gen) others.push({ id: refs[j].id, per, tiles: tilesOf(refs[j], cand, queries[bestDeg(per)].deg) });
  }
  if (vi % 2000 === 0) console.error(`scored ${vi}/${jobs.variants.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const ownTiles = tilesOf(refs[ri], cand, deg);
  const ssimT = { min: Math.min(...ownTiles.ssim) }; // same value as ssimThumb() above, now from the verifier's own code
  return { v, split: refs[ri].meta.split, own, ownDeg: deg, ownTiles, ssimT, others };
});

// 5. Decision exactly as the verifier makes it, for a given threshold set.
function isCandidate(per, th) {
  for (const p of per) {
    if (p[0] <= th.lookupMaxDistance) return true;
    if ((p[1] <= th.quadMaxDistance) + (p[2] <= th.quadMaxDistance) + (p[3] <= th.quadMaxDistance) + (p[4] <= th.quadMaxDistance) >= th.quadMinCount) return true;
  }
  return false;
}
function tileVerdict(t, th) {
  const changed = [];
  for (let i = 0; i < t.luma.length; i++) if (t.luma[i] > th.tileLuma || t.chroma[i] > th.tileChroma || (th.strict && t.ssim[i] < th.ssimMin)) changed.push(i);
  if (!changed.length) return { label: 'MATCH', changed };
  return { label: changed.length / t.luma.length > th.maxChangedFraction ? 'DIFFERENT' : 'MODIFIED', changed };
}
function decide(s, th) {
  const cands = [];
  if (isCandidate(s.own, th)) cands.push({ id: s.v.ref, r: tileVerdict(s.ownTiles, th) });
  for (const o of s.others) if (isCandidate(o.per, th)) cands.push({ id: o.id, r: tileVerdict(o.tiles, th) });
  const match = cands.find(c => c.r.label === 'MATCH');
  if (match) return { label: 'AUTHENTIC_COPY', id: match.id, changed: [] };
  const mod = cands.filter(c => c.r.label === 'MODIFIED').sort((a, b) => a.r.changed.length - b.r.changed.length)[0];
  if (mod) return { label: 'MODIFIED', id: mod.id, changed: mod.r.changed };
  return { label: 'UNVERIFIED', id: null, changed: [] };
}
function tilesInBox(box, margin) {
  const set = new Set(), T = SC.TILES, m = margin / T;
  for (let tr = 0; tr < T; tr++)
    for (let tc = 0; tc < T; tc++) {
      const x0 = tc / T, x1 = (tc + 1) / T, y0 = tr / T, y1 = (tr + 1) / T;
      if (x1 > box[0] - m && x0 < box[2] + m && y1 > box[1] - m && y0 < box[3] + m) set.add(tr * T + tc);
    }
  return set;
}
const VISIBLE = s => s.v.magY >= 10 || s.v.magRGB >= 10;
function evaluate(th, set) {
  const r = { clean: 0, cleanOk: 0, falseAccept: 0, vis: 0, caught: 0, modifiedOwn: 0, localized: 0 };
  for (const s of set) {
    const d = decide(s, th);
    if (d.label === 'AUTHENTIC_COPY' && d.id !== s.v.ref) r.falseAccept++;
    if (s.v.kind === 'clean') {
      r.clean++;
      if (d.label === 'AUTHENTIC_COPY' && d.id === s.v.ref) r.cleanOk++;
    } else if (VISIBLE(s)) {
      r.vis++;
      if (d.label !== 'AUTHENTIC_COPY') r.caught++;
      if (d.label === 'MODIFIED' && d.id === s.v.ref) {
        r.modifiedOwn++;
        const inBox = tilesInBox(s.v.box, 1);
        if (d.changed.some(t => inBox.has(t))) r.localized++;
      }
    }
  }
  return r;
}

const cal = scored.filter(s => s.split === 'cal'), test = scored.filter(s => s.split === 'test');
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const pct2 = (a, b) => (b ? ((100 * a) / b).toFixed(2) + '%' : 'n/a');
function wilson(k, m) { // 95% interval, in percent
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, den = 1 + (z * z) / m, c = p + (z * z) / (2 * m), h = z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m));
  return [(100 * (c - h)) / den, (100 * (c + h)) / den];
}
const ci = (k, m) => { const w = wilson(k, m); return `${w[0].toFixed(1)}-${w[1].toFixed(1)}%`; };
const lines = [];
const log = s => { lines.push(s); console.log(s); };
const max = a => a.reduce((m, x) => (x > m ? x : m), -Infinity);
const quantile = (a, q) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const maxOf = arr => { let m = 0; for (const x of arr) if (x > m) m = x; return m; };
const out = {};

const devices = [...new Set(refs.map(r => r.meta.device))];
log('# scfp1 robustness experiment on real smartphone photos\n');
log(`Generated by \`tests/experiment/vision\` (make_vision.py, analyze_vision.js). Photos: ${n} from ${devices.length} device(s) ` +
    `(${refs.filter(r => r.meta.exifDeg).length} stored rotated with an EXIF orientation flag). Copies scored: ${scored.length}. ` +
    `Fingerprints and all scoring use securecam-core.js (thumbnails re-checked on ${jobs.parity.length} images).\n`);
log(`Split per device: calibration ${refs.filter(r => r.meta.split === 'cal').length} photos (${cal.length} copies), test ${refs.filter(r => r.meta.split === 'test').length} photos (${test.length} copies).\n`);
const sizes = refs.map(r => (r.meta.stored[0] * r.meta.stored[1]) / 1e6);
const aspects = [...new Set(refs.map(r => (Math.max(...r.meta.stored) / Math.min(...r.meta.stored)).toFixed(2)))].sort();
log(`Photo sizes: ${Math.min(...sizes).toFixed(1)} to ${Math.max(...sizes).toFixed(1)} megapixels; aspect ratios: ${aspects.join(', ')}.\n`);
out.photos = n; out.devices = devices.length; out.copies = scored.length; out.rotated = refs.filter(r => r.meta.exifDeg).length;
out.split = { calPhotos: refs.filter(r => r.meta.split === 'cal').length, testPhotos: refs.filter(r => r.meta.split === 'test').length, calCopies: cal.length, testCopies: test.length };
out.megapixels = [Math.min(...sizes), Math.max(...sizes)]; out.aspects = aspects;
out.models = [...new Set(refs.map(r => r.meta.model))];
out.counts = { clean: scored.filter(s => s.v.kind === 'clean').length, cleanReal: scored.filter(s => s.v.kind === 'clean' && s.v.real).length,
               edits: scored.filter(s => s.v.kind === 'edit').length, visible: scored.filter(s => s.v.kind === 'edit' && VISIBLE(s)).length };

log('## Same file, phone decode vs full decode\n');
log(`Max pHash difference ${max(phoneVsFull.map(x => x.d))} bits, max region difference luma ${max(phoneVsFull.map(x => x.maxLuma)).toFixed(2)} / chroma ${max(phoneVsFull.map(x => x.maxChroma)).toFixed(2)}.\n`);
out.phoneVsFull = { maxBits: max(phoneVsFull.map(x => x.d)), maxLuma: max(phoneVsFull.map(x => x.maxLuma)), maxChroma: max(phoneVsFull.map(x => x.maxChroma)) };

log('## Distinct photos\n');
const totalPairs = (n * (n - 1)) / 2;
log(`${totalPairs} pairs of different photos. pHash distance: minimum ${pairHist.findIndex(x => x > 0)} bits; pairs within the lookup threshold (at most ${D.lookupMaxDistance} bits): ${closePairs.length}.\n`);
out.pairs = { total: totalPairs, hist: pairHist, close: closePairs.length, min: pairHist.findIndex(x => x > 0) };

// ---- Shipped defaults: fixed before this dataset was seen, so every photo here is held out ----
function report(th, set) {
  const r = evaluate(th, set);
  log(`- Unedited copies recognised as authentic copies: **${r.cleanOk}/${r.clean} (${pct2(r.cleanOk, r.clean)}; 95% CI ${ci(r.cleanOk, r.clean)})**`);
  log(`- False accepts (a copy called an authentic copy of a different photo): **${r.falseAccept}**`);
  log(`- Visible edits rejected (MODIFIED or UNVERIFIED): **${r.caught}/${r.vis} (${pct(r.caught, r.vis)}; 95% CI ${ci(r.caught, r.vis)})**; shown as MODIFIED: ${r.modifiedOwn}, heatmap covering the edit: ${r.localized}`);
  r.cleanCI = wilson(r.cleanOk, r.clean); r.caughtCI = wilson(r.caught, r.vis);
  return r;
}
log('## Shipped defaults on all photos\n');
log(`lookup at most ${D.lookupMaxDistance} bits or ${D.quadMinCount} quadrants within ${D.quadMaxDistance}; region luma ${D.tileLuma}, chroma ${D.tileChroma}. These values were fixed on the earlier 22-image experiment, before this dataset was used, so all ${n} photos are unseen data for them.\n`);
out.defaultsAll = report(D, scored);
log('\nTest split only:\n');
out.defaultsTest = report(D, test);

// ---- Calibration: choose region thresholds on the calibration split only ----
log('\n## Thresholds calibrated on the calibration split\n');
const grid = [];
for (let tl = 5; tl <= 16; tl += 0.5) for (let tc = 4; tc <= 14; tc += 0.5) grid.push({ ...D, tileLuma: tl, tileChroma: tc });
const calRes = grid.map(th => ({ th, r: evaluate(th, cal) }));
out.calibration = [];
log('Rule: among settings with no false accept and at least the target share of unedited calibration copies accepted, take the one that rejects most visible edits (ties: lower thresholds).\n');
log('| target (calibration) | region luma | region chroma | calibration: unedited accepted | calibration: edits rejected | TEST: unedited accepted | TEST: false accepts | TEST: edits rejected |');
log('|---|---|---|---|---|---|---|---|');
for (const target of [1.0, 0.999, 0.995, 0.99]) {
  const ok = calRes.filter(x => x.r.falseAccept === 0 && x.r.cleanOk / x.r.clean >= target);
  if (!ok.length) { log(`| ${(100 * target).toFixed(1)}% | none | | | | | | |`); continue; }
  ok.sort((a, b) => b.r.caught - a.r.caught || a.th.tileLuma + a.th.tileChroma - (b.th.tileLuma + b.th.tileChroma));
  const pick = ok[0], t = evaluate(pick.th, test);
  log(`| ${(100 * target).toFixed(1)}% | ${pick.th.tileLuma} | ${pick.th.tileChroma} | ${pick.r.cleanOk}/${pick.r.clean} (${pct2(pick.r.cleanOk, pick.r.clean)}) | ${pick.r.caught}/${pick.r.vis} (${pct(pick.r.caught, pick.r.vis)}) | ${t.cleanOk}/${t.clean} (${pct2(t.cleanOk, t.clean)}) | ${t.falseAccept} | ${t.caught}/${t.vis} (${pct(t.caught, t.vis)}) |`);
  out.calibration.push({ target, tileLuma: pick.th.tileLuma, tileChroma: pick.th.tileChroma, cal: pick.r, test: t });
}

// ---- Per platform (unedited copies, shipped defaults, all photos) ----
log('\n## Unedited copies by platform (shipped defaults, all photos)\n');
log('| platform | real transfer | copies | accepted | max pHash change (bits) | region luma diff: 99th pct / max | region chroma diff: 99th pct / max | median size |');
log('|---|---|---|---|---|---|---|---|');
out.platforms = [];
const cleanAll = scored.filter(s => s.v.kind === 'clean');
const acceptedOwn = s => { const d = decide(s, D); return d.label === 'AUTHENTIC_COPY' && d.id === s.v.ref; };
for (const p of [...new Set(cleanAll.map(s => s.v.platform))]) {
  const g = cleanAll.filter(s => s.v.platform === p);
  const okc = g.filter(acceptedOwn).length;
  const dist = g.map(s => Math.min(...s.own.map(o => o[0])));
  const ml = g.map(s => maxOf(s.ownTiles.luma)), mc = g.map(s => maxOf(s.ownTiles.chroma));
  const px = g.map(s => Math.max(...s.v.size)).sort((a, b) => a - b)[g.length >> 1];
  const row = { platform: p, real: !!g[0].v.real, copies: g.length, accepted: okc, maxBits: max(dist), luma99: quantile(ml, 0.99), lumaMax: max(ml), chroma99: quantile(mc, 0.99), chromaMax: max(mc), medianLongSide: px };
  out.platforms.push(row);
  log(`| ${p} | ${row.real ? 'yes' : 'simulated'} | ${g.length} | ${okc} (${pct2(okc, g.length)}) | ${row.maxBits} | ${row.luma99.toFixed(2)} / ${row.lumaMax.toFixed(2)} | ${row.chroma99.toFixed(2)} / ${row.chromaMax.toFixed(2)} | ${px}px long side |`);
}
const missedClean = cleanAll.filter(s => !acceptedOwn(s));
log(`\nUnedited copies not accepted: ${missedClean.length} (from ${new Set(missedClean.map(s => s.v.ref)).size} photos).`);
out.missedClean = missedClean.map(s => {
  const d = decide(s, D);
  return { id: s.v.id, platform: s.v.platform, size: s.v.size, label: d.label, changed: d.changed.length, dist: Math.min(...s.own.map(o => o[0])),
           maxLuma: maxOf(s.ownTiles.luma), maxChroma: maxOf(s.ownTiles.chroma), ref: refs[refIndex[s.v.ref]].meta.display };
});
out.missedCleanPhotos = new Set(missedClean.map(s => s.v.ref)).size;
out.missedCleanLabels = out.missedClean.reduce((a, m) => { a[m.label] = (a[m.label] || 0) + 1; return a; }, {});
for (const m of out.missedClean.slice(0, 40)) log(`- ${m.id} ${m.size.join('x')} (original ${m.ref.join('x')}): ${m.label}, ${m.changed} regions, pHash distance ${m.dist}, max luma ${m.maxLuma.toFixed(1)}, max chroma ${m.maxChroma.toFixed(1)}`);

// ---- Per edit type (test split, shipped defaults) ----
log('\n## Edits by type (test split, shipped defaults)\n');
log('| edit | area of photo | then | visible copies | rejected | MODIFIED + heatmap on edit |');
log('|---|---|---|---|---|---|');
out.edits = [];
const testEdits = test.filter(s => s.v.kind === 'edit');
const editKeys = [...new Set(testEdits.map(s => s.v.edit + ' ' + s.v.frac))];
for (const k of editKeys)
  for (const p of [...new Set(testEdits.map(s => s.v.platform))]) {
    const g = testEdits.filter(s => s.v.edit + ' ' + s.v.frac === k && s.v.platform === p && VISIBLE(s));
    const ds = g.map(s => decide(s, D));
    const loc = g.filter((s, i) => ds[i].label === 'MODIFIED' && ds[i].id === s.v.ref && ds[i].changed.some(t => tilesInBox(s.v.box, 1).has(t))).length;
    const rej = ds.filter(x => x.label !== 'AUTHENTIC_COPY').length;
    out.edits.push({ edit: k.split(' ')[0], frac: +k.split(' ')[1], platform: p, visible: g.length, rejected: rej, localized: loc });
    log(`| ${k.split(' ')[0]} | ${(+k.split(' ')[1] * 100).toFixed(1)}% | ${p.replace('_', ' ')} | ${g.length} | ${rej} (${pct(rej, g.length)}) | ${loc} |`);
  }
const invisible = testEdits.filter(s => !VISIBLE(s)).length;
log(`\n"Visible" = mean change inside the edited area of at least 10 levels (0-255) in luma or RGB. ${invisible} edited test copies were below that and are excluded.`);
out.invisibleTest = invisible;

// ---- ROC: unedited copies (accept) vs visible edits (reject), test split ----
// Score: lower = more similar. Ours: largest region difference relative to the default thresholds.
const ourScore = s => {
  if (!isCandidate(s.own, D)) return Infinity;
  let m = 0;
  for (let i = 0; i < s.ownTiles.luma.length; i++) m = Math.max(m, s.ownTiles.luma[i] / D.tileLuma, s.ownTiles.chroma[i] / D.tileChroma);
  return m;
};
const METHODS = {
  'scfp1 regions (this work)': ourScore,
  'pHash 64-bit': s => Math.min(...s.own.map(o => o[0])),
  'aHash 64-bit': s => s.v.base.ahash,
  'dHash 64-bit': s => s.v.base.dhash,
  'BlockHash 256-bit': s => s.v.base.bhash,
  'SSIM regions on signed thumbnail': s => 1 - s.ssimT.min,
  'SSIM (global)': s => 1 - s.v.base.ssim,
  'SSIM (min of 256 regions)': s => 1 - s.v.base.ssimMin,
  'PSNR': s => -s.v.base.psnr,
};
const KEPT = { 'scfp1 regions (this work)': '18,432 bytes', 'pHash 64-bit': '8 bytes', 'aHash 64-bit': '8 bytes', 'dHash 64-bit': '8 bytes', 'BlockHash 256-bit': '32 bytes',
               'SSIM regions on signed thumbnail': '16,384 bytes', 'SSIM (global)': '65,536 bytes', 'SSIM (min of 256 regions)': '65,536 bytes', 'PSNR': '65,536 bytes' };
function roc(pos, neg) { // pos = scores of unedited copies, neg = scores of edits
  const all = [...pos.map(x => [x, 1]), ...neg.map(x => [x, 0])].sort((a, b) => a[0] - b[0]);
  const pts = [[0, 0]];
  let tp = 0, fp = 0, auc = 0, i = 0;
  while (i < all.length) {
    let j = i, dtp = 0, dfp = 0;
    while (j < all.length && all[j][0] === all[i][0]) { if (all[j][1]) dtp++; else dfp++; j++; }
    if (all[i][0] === Infinity) break; // never accepted
    auc += (dfp / neg.length) * ((tp + dtp / 2) / pos.length);
    tp += dtp; fp += dfp;
    pts.push([fp / neg.length, tp / pos.length]);
    i = j;
  }
  auc += (1 - fp / neg.length) * (tp / pos.length + 1) / 2; // straight line to (1,1)
  pts.push([1, 1]);
  return { pts, auc };
}
const tprAt = (pts, far) => { let b = 0; for (const [f, t] of pts) if (f <= far && t > b) b = t; return b; };
const eer = pts => { let best = 1; for (const [f, t] of pts) best = Math.min(best, Math.max(f, 1 - t)); return best; };
log('\n## Comparison with baselines (test split)\n');
log('Task: accept unedited platform copies, reject visibly edited copies of the same photo. FAR = share of edited copies accepted; FRR = share of unedited copies rejected. Each threshold is chosen on the calibration split so that at least 99.5% of unedited calibration copies are accepted.\n');
log('| method | data kept per photo | AUC | equal error rate | edits rejected at calibrated threshold | unedited accepted at that threshold | unedited accepted at FAR 1% | at FAR 5% |');
log('|---|---|---|---|---|---|---|---|');
out.roc = {};
const tClean = test.filter(s => s.v.kind === 'clean'), tEdit = test.filter(s => s.v.kind === 'edit' && VISIBLE(s));
const cClean = cal.filter(s => s.v.kind === 'clean');
for (const [name, f] of Object.entries(METHODS)) {
  const r = roc(tClean.map(f), tEdit.map(f));
  const calScores = cClean.map(f).sort((a, b) => a - b);
  const thr = calScores[Math.ceil(0.995 * calScores.length) - 1];
  const rej = tEdit.filter(s => f(s) > thr).length, acc = tClean.filter(s => f(s) <= thr).length;
  const step = Math.max(1, Math.floor(r.pts.length / 400)); // thin the curve for the figure
  out.roc[name] = { kept: KEPT[name], auc: r.auc, eer: eer(r.pts), thr: Number.isFinite(thr) ? thr : null, rejected: rej, edits: tEdit.length, accepted: acc, clean: tClean.length,
                    tpr1: tprAt(r.pts, 0.01), tpr5: tprAt(r.pts, 0.05), pts: r.pts.filter((_, i) => i % step === 0 || i === r.pts.length - 1) };
  log(`| ${name} | ${KEPT[name]} | ${r.auc.toFixed(4)} | ${(100 * eer(r.pts)).toFixed(2)}% | ${rej}/${tEdit.length} (${pct(rej, tEdit.length)}) | ${acc}/${tClean.length} (${pct2(acc, tClean.length)}) | ${(100 * tprAt(r.pts, 0.01)).toFixed(1)}% | ${(100 * tprAt(r.pts, 0.05)).toFixed(1)}% |`);
}

// ---- Bootstrap over photos (copies of one photo are not independent): 95% intervals for every AUC and for its
// difference to the region comparison. Fixed seed, so the intervals are reproducible.
{
  const B = 200;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = [...new Set(test.map(s => s.v.ref))];
  const byPhoto = new Map(ids.map(id => [id, { c: [], e: [] }]));
  for (const s of tClean) byPhoto.get(s.v.ref).c.push(s);
  for (const s of tEdit) byPhoto.get(s.v.ref).e.push(s);
  const names = Object.keys(METHODS);
  const per = Object.fromEntries(names.map(nm => [nm, new Map(ids.map(id => [id, { c: byPhoto.get(id).c.map(METHODS[nm]), e: byPhoto.get(id).e.map(METHODS[nm]) }]))]));
  const samples = Object.fromEntries(names.map(nm => [nm, []]));
  for (let b = 0; b < B; b++) {
    const pick = ids.map(() => ids[Math.floor(rnd() * ids.length)]);
    for (const nm of names) {
      const pos = [], neg = [];
      for (const id of pick) { const s = per[nm].get(id); for (const x of s.c) pos.push(x); for (const x of s.e) neg.push(x); }
      samples[nm].push(roc(pos, neg).auc);
    }
  }
  const qnt = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const ours = samples['scfp1 regions (this work)'];
  out.aucCI = {};
  log(`\n## AUC with 95% bootstrap intervals (${B} resamples of the ${ids.length} test photos)\n`);
  log('| method | AUC | 95% interval | difference to the region comparison (95% interval) |');
  log('|---|---|---|---|');
  for (const nm of names) {
    const diff = samples[nm].map((x, i) => x - ours[i]);
    out.aucCI[nm] = { lo: qnt(samples[nm], 0.025), hi: qnt(samples[nm], 0.975), diffLo: qnt(diff, 0.025), diffHi: qnt(diff, 0.975) };
    const c = out.aucCI[nm];
    log(`| ${nm} | ${out.roc[nm].auc.toFixed(3)} | ${c.lo.toFixed(3)}-${c.hi.toFixed(3)} | ${nm.startsWith('scfp1') ? '-' : `${c.diffLo >= 0 ? '+' : ''}${c.diffLo.toFixed(3)} to ${c.diffHi >= 0 ? '+' : ''}${c.diffHi.toFixed(3)}`} |`);
  }
}

// ---- Combination: scfp1 regions at the shipped thresholds AND regional SSIM on the same signed thumbnail ----
{
  const ss = s => 1 - s.ssimT.min;
  const calS = cClean.map(ss).sort((a, b) => a - b);
  const thr = calS[Math.ceil(0.995 * calS.length) - 1];
  const kinds = [...new Set(tEdit.map(s => s.v.edit))];
  const rules = { 'scfp1 regions': s => acceptedOwn(s), 'regional SSIM': s => ss(s) <= thr, 'both': s => acceptedOwn(s) && ss(s) <= thr };
  log('\n## Combining the region check with regional SSIM on the same signed thumbnail (test split)\n');
  log(`A copy is accepted only if it passes both checks. SSIM threshold from calibration (99.5% of unedited calibration copies accepted): worst-region SSIM at least ${(1 - thr).toFixed(3)}.\n`);
  log('| rule | unedited accepted | visible edits rejected | ' + kinds.join(' | ') + ' |');
  log('|---|---|---|' + kinds.map(() => '---').join('|') + '|');
  out.combined = { ssimThreshold: 1 - thr, kinds, rules: {} };
  for (const [name, acc] of Object.entries(rules)) {
    const a = tClean.filter(acc).length, r = tEdit.filter(s => !acc(s)).length;
    const per = Object.fromEntries(kinds.map(k => { const g = tEdit.filter(s => s.v.edit === k); return [k, [g.filter(s => !acc(s)).length, g.length]]; }));
    out.combined.rules[name] = { accepted: a, clean: tClean.length, rejected: r, edits: tEdit.length, per };
    log(`| ${name} | ${a}/${tClean.length} (${pct2(a, tClean.length)}) | ${r}/${tEdit.length} (${pct(r, tEdit.length)}) | ` + kinds.map(k => `${per[k][0]}/${per[k][1]}`).join(' | ') + ' |');
  }
}

// ---- Strict mode as implemented in the verifier (SC.DEFAULTS with strict: true), full decision path ----
{
  const S = { ...D, strict: true };
  log(`\n## Strict mode as implemented (regions AND regional SSIM >= ${D.ssimMin} in every region; full verifier decision)\n`);
  log('All photos:\n');
  out.strictAll = report(S, scored);
  log('\nTest split only:\n');
  out.strictTest = report(S, test);
  const kinds = [...new Set(tEdit.map(s => s.v.edit))];
  out.strictPerEdit = {};
  out.standardPerEdit = {};
  for (const k of kinds) {
    const g = tEdit.filter(s => s.v.edit === k);
    out.strictPerEdit[k] = [g.filter(s => decide(s, S).label !== 'AUTHENTIC_COPY').length, g.length];
    out.standardPerEdit[k] = [g.filter(s => decide(s, D).label !== 'AUTHENTIC_COPY').length, g.length];
  }
  log('\n| edit | standard: rejected | strict: rejected |');
  log('|---|---|---|');
  for (const k of kinds) log(`| ${k} | ${out.standardPerEdit[k][0]}/${out.standardPerEdit[k][1]} (${pct(...out.standardPerEdit[k])}) | ${out.strictPerEdit[k][0]}/${out.strictPerEdit[k][1]} (${pct(...out.strictPerEdit[k])}) |`);
  const realClean = scored.filter(s => s.v.kind === 'clean' && s.v.real);
  out.strictReal = [realClean.filter(s => { const d = decide(s, S); return d.label === 'AUTHENTIC_COPY' && d.id === s.v.ref; }).length, realClean.length];
  log(`\nReal platform files accepted in strict mode: ${out.strictReal[0]}/${out.strictReal[1]}.`);
}

// FAR / FRR against the region threshold scale (for the figure)
out.farFrr = [];
const oc = tClean.map(ourScore), oe = tEdit.map(ourScore);
for (let a = 0.3; a <= 2.5001; a += 0.05) out.farFrr.push({ scale: +a.toFixed(2), luma: +(a * D.tileLuma).toFixed(2), chroma: +(a * D.tileChroma).toFixed(2), frr: oc.filter(x => x > a).length / oc.length, far: oe.filter(x => x <= a).length / oe.length });

// Per-edit verifier decisions (label, record, changed regions) in both modes, for localize.py.
if (process.env.DECISIONS) {
  const S = { ...D, strict: true }, dec = {};
  for (const s of scored) if (s.v.kind === 'edit') {
    const a = decide(s, D), b = decide(s, S);
    dec[s.v.id] = { ref: s.v.ref, split: s.split, visible: VISIBLE(s), standard: { label: a.label, id: a.id, changed: a.changed }, strict: { label: b.label, id: b.id, changed: b.changed } };
  }
  fs.writeFileSync(process.env.DECISIONS, JSON.stringify(dec));
}

fs.writeFileSync(REPORT, lines.join('\n') + '\n');
fs.writeFileSync(JSON_OUT, JSON.stringify(out));
console.log('\nwrote', REPORT, JSON_OUT);
