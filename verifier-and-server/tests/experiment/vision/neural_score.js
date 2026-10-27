// Scores neural_vision.py (DINOv2 descriptor, and a 96-bit LSH hash of it) against SecureCam on the same copies and edits,
// with the same calibration/test split, visibility rule, threshold rule and bootstrap as analyze_vision.js / compare_vision.js.
// The SecureCam numbers are recomputed here and checked against results_vision.json before anything is reported.
// Usage: node neural_score.js <out_dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_neural.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_neural.json');
const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'));
const VR = JSON.parse(fs.readFileSync(path.join(__dirname, 'results_vision.json'), 'utf8'));
const N = JSON.parse(fs.readFileSync(path.join(OUT, 'neural.json'), 'utf8'));
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));
const D = SC.DEFAULTS;

// Same split and visibility rule as analyze_vision.js.
const perDev = {};
for (const o of jobs.originals) { const i = (perDev[o.device] = (perDev[o.device] || 0) + 1) - 1; o.split = i % 10 < 3 ? 'cal' : 'test'; }
const VISIBLE = v => v.magY >= 10 || v.magRGB >= 10;
const orig = Object.fromEntries(jobs.originals.map(o => [o.id, o]));

// SecureCam score against the photo's own record, exactly as analyze_vision.js (ourScore).
const refs = Object.fromEntries(jobs.originals.map(o => { const t = readThumb(o.phoneThumb); return [o.id, { thumbs: t, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y) }]; }));
function ourScore(v) {
  const r = refs[v.ref], cand = readThumb(v.thumb);
  const per = SC.lookupQueries(cand).map(q => ({ deg: q.deg, g: SC.hamming(q.phash, r.phash), q: q.quads.map((h, k) => SC.hamming(h, r.quads[k])) }));
  const cand_ = per.some(p => p.g <= D.lookupMaxDistance || p.q.filter(x => x <= D.quadMaxDistance).length >= D.quadMinCount);
  if (!cand_) return Infinity;
  let b = per[0]; for (const p of per) if (p.g < b.g) b = p;
  const c = SC.compareThumbs(r.thumbs, SC.rotateThumbs(cand, b.deg));
  const luma = Float32Array.from(c.luma), chroma = Float32Array.from(c.chroma);
  let m = 0;
  for (let i = 0; i < luma.length; i++) m = Math.max(m, luma[i] / D.tileLuma, chroma[i] / D.tileChroma);
  return m;
}

const rows = jobs.variants.map(v => ({ v, split: orig[v.ref].split, n: N.variants[v.id], ours: ourScore(v) }));
for (const r of rows) if (!r.n) throw new Error('no neural result for ' + r.v.id);
const test = rows.filter(r => r.split === 'test'), cal = rows.filter(r => r.split === 'cal');
const tClean = test.filter(r => r.v.kind === 'clean'), tEdit = test.filter(r => r.v.kind === 'edit' && VISIBLE(r.v));
const cClean = cal.filter(r => r.v.kind === 'clean');

function roc(pos, neg) { // identical to analyze_vision.js
  const all = [...pos.map(x => [x, 1]), ...neg.map(x => [x, 0])].sort((a, b) => a[0] - b[0]);
  let tp = 0, fp = 0, auc = 0, i = 0;
  const pts = [[0, 0]];
  while (i < all.length) {
    let j = i, dtp = 0, dfp = 0;
    while (j < all.length && all[j][0] === all[i][0]) { if (all[j][1]) dtp++; else dfp++; j++; }
    if (all[i][0] === Infinity) break;
    auc += (dfp / neg.length) * ((tp + dtp / 2) / pos.length);
    tp += dtp; fp += dfp;
    pts.push([fp / neg.length, tp / pos.length]);
    i = j;
  }
  auc += (1 - fp / neg.length) * (tp / pos.length + 1) / 2;
  pts.push([1, 1]);
  return { auc, pts };
}
const tprAt = (pts, far) => { let b = 0; for (const [f, t] of pts) if (f <= far && t > b) b = t; return b; };
const eer = pts => { let best = 1; for (const [f, t] of pts) best = Math.min(best, Math.max(f, 1 - t)); return best; };
function wilson(k, m) {
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, den = 1 + (z * z) / m, c = p + (z * z) / (2 * m), h = z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m));
  return [(100 * (c - h)) / den, (100 * (c + h)) / den];
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const pct2 = (a, b) => (b ? ((100 * a) / b).toFixed(2) + '%' : 'n/a');
const cnt = (arr, f) => arr.filter(f).length;
const lines = [], log = s => { lines.push(s); console.log(s); };
const out = { model: N.model, lshBits: N.lshBits, photos: jobs.originals.length, testPhotos: jobs.originals.filter(o => o.split === 'test').length,
              clean: tClean.length, visible: tEdit.length, pairs: N.pairs };

// ---- 0. Consistency with analyze_vision.js ----
const SCORES = { ours: r => r.ours, cos: r => r.n.cos, h96: r => r.n.h96 };
const OTHER = { cos: r => r.n.otherCos, h96: r => r.n.otherH96 };
const ourRoc = roc(tClean.map(SCORES.ours), tEdit.map(SCORES.ours));
const ref = VR.roc['scfp1 regions (this work)'];
out.check = { aucHere: ourRoc.auc, aucResultsVision: ref.auc };
if (Math.abs(ourRoc.auc - ref.auc) > 1e-12 || tClean.length !== ref.clean || tEdit.length !== ref.edits) {
  console.error('MISMATCH with results_vision.json', out.check, tClean.length, ref.clean, tEdit.length, ref.edits); process.exit(1);
}

log('# Neural perceptual hash baseline (VISION, test split)\n');
log(`Generated by \`neural_vision.py\` + \`neural_score.js\`. Descriptor: ${N.model}; hash: ${N.lshBits}-bit random-hyperplane LSH of the descriptor ` +
    `(seed ${N.lshSeed}, the NeuralHash construction). ${out.photos} photos; test split: ${out.testPhotos} photos, ${tClean.length} unedited copies, ` +
    `${tEdit.length} visible edits. Copies and edits rebuilt by the code of make_vision.py and checked against its record. SecureCam AUC recomputed here: ` +
    `${ourRoc.auc.toFixed(6)} (results_vision.json: ${ref.auc.toFixed(6)}). Thresholds: 99.5% of unedited calibration copies accepted, as for every baseline.\n`);

// ---- 1. ROC, calibrated threshold, matches to a different photo ----
const NAMES = { cos: `DINOv2 descriptor, cosine distance (${384 * 4} bytes)`, h96: `Neural hash, ${N.lshBits}-bit (${N.lshBits / 8} bytes)` };
out.methods = {};
log('| method | AUC | EER | threshold | unedited accepted | visible edits rejected | test copies within threshold of another photo | unedited accepted at FAR 1% / 5% |');
log('|---|---|---|---|---|---|---|---|');
for (const k of ['cos', 'h96']) {
  const f = SCORES[k], r = roc(tClean.map(f), tEdit.map(f));
  const cs = cClean.map(f).sort((a, b) => a - b), thr = cs[Math.ceil(0.995 * cs.length) - 1];
  const acc = cnt(tClean, x => f(x) <= thr), rej = cnt(tEdit, x => f(x) > thr), wrong = cnt(test, x => OTHER[k](x) <= thr);
  const minOther = Math.min(...test.map(OTHER[k]));
  const m = { auc: r.auc, eer: eer(r.pts), thr, accepted: acc, rejected: rej, acceptedCI: wilson(acc, tClean.length), rejectedCI: wilson(rej, tEdit.length),
              wrongCopies: wrong, testCopies: test.length, minOther, tpr1: tprAt(r.pts, 0.01), tpr5: tprAt(r.pts, 0.05), perEdit: {} };
  for (const e of [...new Set(tEdit.map(x => x.v.edit))]) { const g = tEdit.filter(x => x.v.edit === e); m.perEdit[e] = [cnt(g, x => f(x) > thr), g.length]; }
  out.methods[k] = m;
  log(`| ${NAMES[k]} | ${r.auc.toFixed(4)} | ${(100 * m.eer).toFixed(2)}% | ${k === 'cos' ? thr.toFixed(5) : thr} | ${acc}/${tClean.length} (${pct2(acc, tClean.length)}) | ` +
      `**${rej}/${tEdit.length} (${pct(rej, tEdit.length)})** | ${wrong}/${test.length} (closest ${k === 'cos' ? minOther.toFixed(4) : minOther}) | ${(100 * m.tpr1).toFixed(1)}% / ${(100 * m.tpr5).toFixed(1)}% |`);
}
log(`| SecureCam regions (results_vision.json) | ${ref.auc.toFixed(4)} | ${(100 * ref.eer).toFixed(2)}% | | ${ref.accepted}/${ref.clean} (${pct2(ref.accepted, ref.clean)}) | ` +
    `**${ref.rejected}/${ref.edits} (${pct(ref.rejected, ref.edits)})** | 0 | ${(100 * ref.tpr1).toFixed(1)}% / ${(100 * ref.tpr5).toFixed(1)}% |`);
log(`\nDifferent originals: closest pair at cosine distance ${N.pairs.minCos.toFixed(4)}, ${N.pairs.minH96} of ${N.lshBits} hash bits.\n`);

// ---- 2. Bootstrap AUC (same resampling as analyze_vision.js) ----
{
  const Bn = 200;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = [...new Set(test.map(r => r.v.ref))];
  const by = new Map(ids.map(id => [id, { c: [], e: [] }]));
  for (const r of tClean) by.get(r.v.ref).c.push(r);
  for (const r of tEdit) by.get(r.v.ref).e.push(r);
  const s = { ours: [], cos: [], h96: [] };
  for (let b = 0; b < Bn; b++) {
    const pick = ids.map(() => ids[Math.floor(rnd() * ids.length)]);
    for (const k of Object.keys(s)) {
      const pos = [], neg = [];
      for (const id of pick) { const g = by.get(id); for (const r of g.c) pos.push(SCORES[k](r)); for (const r of g.e) neg.push(SCORES[k](r)); }
      s[k].push(roc(pos, neg).auc);
    }
  }
  const q = (a, p) => { const x = [...a].sort((u, v) => u - v); return x[Math.min(x.length - 1, Math.floor(p * x.length))]; };
  const v = VR.aucCI['scfp1 regions (this work)'];
  if (Math.abs(v.lo - q(s.ours, 0.025)) > 1e-12 || Math.abs(v.hi - q(s.ours, 0.975)) > 1e-12) { console.error('bootstrap differs from results_vision.json'); process.exit(1); }
  out.aucCI = {};
  log(`## AUC with 95% bootstrap intervals (${Bn} resamples of the test photos, as in results_vision)\n`);
  for (const k of ['cos', 'h96']) {
    const diff = s[k].map((x, i) => x - s.ours[i]);
    out.aucCI[k] = { lo: q(s[k], 0.025), hi: q(s[k], 0.975), minusOurs: [q(diff, 0.025), q(diff, 0.975)] };
    log(`- ${NAMES[k]}: ${out.methods[k].auc.toFixed(3)} (${out.aucCI[k].lo.toFixed(3)}-${out.aucCI[k].hi.toFixed(3)}); minus SecureCam: ${out.aucCI[k].minusOurs.map(x => x.toFixed(3)).join(' to ')}`);
  }
  log(`- SecureCam regions: ${ourRoc.auc.toFixed(3)} (${v.lo.toFixed(3)}-${v.hi.toFixed(3)})\n`);
}

// ---- 3. Per edit type ----
log('## Visible edits rejected at the calibrated threshold, by edit type (test split)\n');
log('| edit | copies | DINOv2 cosine | neural hash 96-bit | SecureCam standard | SecureCam strict |');
log('|---|---|---|---|---|---|');
for (const e of Object.keys(out.methods.cos.perEdit)) {
  const c = out.methods.cos.perEdit[e], h = out.methods.h96.perEdit[e];
  log(`| ${e} | ${c[1]} | ${pct(...c)} | ${pct(...h)} | ${pct(...VR.standardPerEdit[e])} | ${pct(...VR.strictPerEdit[e])} |`);
}
log('\nNeither neural score says where a change is.');

fs.writeFileSync(REPORT, lines.join('\n') + '\n');
fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log('\nwrote', REPORT, JSON_OUT);
