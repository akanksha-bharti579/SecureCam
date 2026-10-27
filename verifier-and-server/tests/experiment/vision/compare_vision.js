// Scores baselines_vision.py (C2PA hard binding, PDQ, TrustMark) against SecureCam on the same copies and edits,
// with the same calibration/test split, the same "visible edit" rule and the same bootstrap as analyze_vision.js.
// The SecureCam numbers are recomputed here and checked against results_vision.json before anything is reported.
// Usage: node compare_vision.js <out_dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_compare.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_compare.json');
const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'));
const VR = JSON.parse(fs.readFileSync(path.join(__dirname, 'results_vision.json'), 'utf8'));
let B;
if (fs.existsSync(path.join(OUT, 'baselines.json')) && !process.env.PARTIAL) B = JSON.parse(fs.readFileSync(path.join(OUT, 'baselines.json'), 'utf8'));
else { // interim check while baselines_vision.py is still running
  B = {};
  for (const f of fs.readdirSync(path.join(OUT, 'baselines'))) if (/^D\d+_\d+\.json$/.test(f)) { const m = JSON.parse(fs.readFileSync(path.join(OUT, 'baselines', f), 'utf8')); B[m.id] = m; }
}
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));
const D = SC.DEFAULTS;
const PDQ_META = 31; // ThreatExchange's recommended PDQ match threshold (Hamming distance at most 31 of 256 bits)

// Same split and visibility rule as analyze_vision.js.
const perDev = {};
for (const o of jobs.originals) { const i = (perDev[o.device] = (perDev[o.device] || 0) + 1) - 1; o.split = i % 10 < 3 ? 'cal' : 'test'; }
const VISIBLE = v => v.magY >= 10 || v.magRGB >= 10;
const complete = !Object.keys(B).length ? false : jobs.originals.every(o => B[o.id]);
const originals = jobs.originals.filter(o => B[o.id]);
const orig = Object.fromEntries(originals.map(o => [o.id, o]));

// SecureCam score against the photo's own record, exactly as analyze_vision.js (ourScore).
const refs = Object.fromEntries(originals.map(o => { const t = readThumb(o.phoneThumb); return [o.id, { thumbs: t, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y) }]; }));
function ourScore(v) {
  const r = refs[v.ref], cand = readThumb(v.thumb);
  const per = SC.lookupQueries(cand).map(q => ({ deg: q.deg, g: SC.hamming(q.phash, r.phash), q: q.quads.map((h, k) => SC.hamming(h, r.quads[k])) }));
  const cand_ = per.some(p => p.g <= D.lookupMaxDistance || p.q.filter(x => x <= D.quadMaxDistance).length >= D.quadMinCount);
  if (!cand_) return Infinity;
  let b = per[0]; for (const p of per) if (p.g < b.g) b = p;
  const c = SC.compareThumbs(r.thumbs, SC.rotateThumbs(cand, b.deg));
  const luma = Float32Array.from(c.luma), chroma = Float32Array.from(c.chroma); // stored as 32-bit, as in analyze_vision.js
  let m = 0;
  for (let i = 0; i < luma.length; i++) m = Math.max(m, luma[i] / D.tileLuma, chroma[i] / D.tileChroma);
  return m;
}

const rows = jobs.variants.filter(v => orig[v.ref]).map(v => ({ v, split: orig[v.ref].split, b: B[v.ref].variants[v.id], ours: ourScore(v) }));
for (const r of rows) if (!r.b) throw new Error('no baseline result for ' + r.v.id);
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
function wilson(k, m) {
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, den = 1 + (z * z) / m, c = p + (z * z) / (2 * m), h = z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m));
  return [(100 * (c - h)) / den, (100 * (c + h)) / den];
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const pct2 = (a, b) => (b ? ((100 * a) / b).toFixed(2) + '%' : 'n/a');
const ci = (k, m) => { const w = wilson(k, m); return `${w[0].toFixed(1)}-${w[1].toFixed(1)}%`; };
const lines = [], log = s => { lines.push(s); console.log(s); };
const out = { complete, photos: originals.length, testPhotos: originals.filter(o => o.split === 'test').length, clean: tClean.length, visible: tEdit.length };

// ---- 0. Consistency with analyze_vision.js ----
const SCORES = { ours: r => r.ours, pdq: r => r.b.pdq };
const ourRoc = roc(tClean.map(SCORES.ours), tEdit.map(SCORES.ours));
const ref = VR.roc['scfp1 regions (this work)'];
out.check = { aucHere: ourRoc.auc, aucResultsVision: ref.auc, cleanHere: tClean.length, cleanResultsVision: ref.clean, editsHere: tEdit.length, editsResultsVision: ref.edits };
if (complete && (Math.abs(ourRoc.auc - ref.auc) > 1e-12 || tClean.length !== ref.clean || tEdit.length !== ref.edits)) {
  console.error('MISMATCH with results_vision.json', out.check); process.exit(1);
}

log('# Comparison with deployed provenance methods (VISION, test split)\n');
log(`Generated by \`baselines_vision.py\` + \`compare_vision.js\`. ${originals.length} photos${complete ? '' : ' (INTERIM: not all photos processed yet)'}; ` +
    `test split: ${out.testPhotos} photos, ${tClean.length} unedited copies, ${tEdit.length} visible edits. Every copy and edit was rebuilt by ` +
    `the code of make_vision.py and checked against its stored record (same file size, same edit box). SecureCam score recomputed here: ` +
    `AUC ${ourRoc.auc.toFixed(6)} (results_vision.json: ${ref.auc.toFixed(6)}).\n`);

// ---- 1. C2PA hard binding ----
const all = Object.values(B).filter(m => orig[m.id]);
const cnt = (arr, f) => arr.filter(f).length;
const c2 = {
  signedTrusted: cnt(all, m => m.c2paSigned === 'Trusted'), unsignedNone: cnt(all, m => m.c2paUnsigned === 'none'),
  manifestBytes: all.map(m => m.c2paManifestBytes).sort((a, b) => a - b),
};
const keptC = tClean.filter(r => r.b.c2paKept), keptE = tEdit.filter(r => r.b.c2paKept);
const states = arr => arr.reduce((a, r) => { a[r.b.c2paKept] = (a[r.b.c2paKept] || 0) + 1; return a; }, {});
c2.cleanKept = { n: keptC.length, valid: cnt(keptC, r => /^(Trusted|Valid)$/.test(r.b.c2paKept)), states: states(keptC) };
c2.editKept = { n: keptE.length, valid: cnt(keptE, r => /^(Trusted|Valid)$/.test(r.b.c2paKept)), states: states(keptE) };
const real = rows.filter(r => r.v.real);
c2.real = { n: real.length, keepExif: cnt(real, r => r.b.segments.includes('0xe1')), keepApp11: cnt(real, r => r.b.segments.includes('0xeb')),
            segments: real.reduce((a, r) => { const k = r.v.platform + ' ' + r.b.segments.join('+'); a[k] = (a[k] || 0) + 1; return a; }, {}) };
out.c2pa = c2;
log('## C2PA hard binding (c2pa-python, test certificate)\n');
log(`- Signed originals: **${c2.signedTrusted}/${all.length} Trusted** (manifest ${c2.manifestBytes[0]}-${c2.manifestBytes[c2.manifestBytes.length - 1]} bytes); unsigned originals: ${c2.unsignedNone} with no manifest.`);
log(`- Real platform files of VISION (${c2.real.n}: WhatsApp, Facebook high/low): EXIF kept in ${c2.real.keepExif}, APP11 (where C2PA is stored) kept in ${c2.real.keepApp11}. ` +
    `Segments kept: ${Object.entries(c2.real.segments).map(([k, v]) => `${k} (${v})`).join('; ')}. So on these platforms a C2PA manifest is removed and the copy has no credentials, edited or not.`);
log(`- Best case for C2PA, the manifest put back into each JPEG copy: unedited copies valid **${c2.cleanKept.valid}/${c2.cleanKept.n}** ` +
    `(${Object.entries(c2.cleanKept.states).map(([k, v]) => `${k}: ${v}`).join(', ')}); visible edits valid ${c2.editKept.valid}/${c2.editKept.n} ` +
    `(${Object.entries(c2.editKept.states).map(([k, v]) => `${k}: ${v}`).join(', ')}). The hash binding cannot tell a recompressed copy from an edit, and does not say where a change is.\n`);

// ---- 2. PDQ ----
const pdqRoc = roc(tClean.map(SCORES.pdq), tEdit.map(SCORES.pdq));
const calP = cClean.map(SCORES.pdq).sort((a, b) => a - b), pdqCal = calP[Math.ceil(0.995 * calP.length) - 1];
const pdq = { auc: pdqRoc.auc, tpr1: tprAt(pdqRoc.pts, 0.01), tpr5: tprAt(pdqRoc.pts, 0.05), calThreshold: pdqCal, thresholds: {} };
for (const [name, t] of [['meta', PDQ_META], ['calibrated', pdqCal]]) {
  const acc = cnt(tClean, r => r.b.pdq <= t), rej = cnt(tEdit, r => r.b.pdq > t);
  pdq.thresholds[name] = { t, accepted: acc, rejected: rej, acceptedCI: wilson(acc, tClean.length), rejectedCI: wilson(rej, tEdit.length) };
}
// Matches to a different photo: every test copy against every registered photo's PDQ.
const hexBits = h => Uint8Array.from(Buffer.from(h, 'hex'));
const pop8 = new Uint8Array(256).map((_, i) => { let c = 0, x = i; while (x) { c += x & 1; x >>= 1; } return c; });
const hd = (a, b) => { let d = 0; for (let i = 0; i < 32; i++) d += pop8[a[i] ^ b[i]]; return d; };
const refPdq = all.map(m => ({ id: m.id, h: hexBits(m.pdqHash) }));
let wrongMatch = 0, wrongCopies = 0, minOther = 256;
for (const r of test) {
  const h = hexBits(r.b.pdqHash);
  let any = false;
  for (const p of refPdq) { if (p.id === r.v.ref) continue; const d = hd(h, p.h); if (d < minOther) minOther = d; if (d <= PDQ_META) { wrongMatch++; any = true; } }
  if (any) wrongCopies++;
}
let closePairs = 0, minPair = 256;
for (let i = 0; i < refPdq.length; i++) for (let j = i + 1; j < refPdq.length; j++) { const d = hd(refPdq[i].h, refPdq[j].h); minPair = Math.min(minPair, d); if (d <= PDQ_META) closePairs++; }
Object.assign(pdq, { wrongMatch, wrongCopies, minOther, closePairs, minPair, testCopies: test.length });
out.pdq = pdq;
log('## PDQ (Meta, 256-bit perceptual hash)\n');
for (const [name, x] of Object.entries(pdq.thresholds))
  log(`- Threshold ${x.t} bits (${name === 'meta' ? 'ThreatExchange recommendation' : 'calibrated: 99.5% of unedited calibration copies'}): unedited accepted **${x.accepted}/${tClean.length} (${pct2(x.accepted, tClean.length)})**, visible edits rejected **${x.rejected}/${tEdit.length} (${pct(x.rejected, tEdit.length)}; 95% CI ${ci(x.rejected, tEdit.length)})**`);
log(`- AUC ${pdq.auc.toFixed(4)}; unedited accepted at 1% / 5% of edits accepted: ${(100 * pdq.tpr1).toFixed(1)}% / ${(100 * pdq.tpr5).toFixed(1)}%.`);
log(`- Different photos: ${closePairs} of ${(refPdq.length * (refPdq.length - 1)) / 2} pairs of originals within ${PDQ_META} bits (closest ${minPair}); ` +
    `${wrongCopies} of ${test.length} test copies within ${PDQ_META} bits of another photo (closest ${minOther}). PDQ gives no location for a change.\n`);

// ---- 3. TrustMark ----
const tmC = tClean.filter(r => r.b.tm), tmE = tEdit.filter(r => r.b.tm);
const tally = arr => ({ n: arr.length, ok: cnt(arr, r => r.b.tm === 'ok'), wrong: cnt(arr, r => r.b.tm === 'wrong'), none: cnt(arr, r => r.b.tm === 'none') });
const psnr = all.map(m => m.tmPsnr).sort((a, b) => a - b);
const tm = { clean: tally(tmC), edit: tally(tmE), self: cnt(all, m => m.tmSelf === 'ok'), unmarkedFound: cnt(all, m => m.tmUnmarked !== 'none'),
             psnrMean: psnr.reduce((a, b) => a + b, 0) / psnr.length, psnrMin: psnr[0], psnrMax: psnr[psnr.length - 1] };
out.trustmark = tm;
log('## TrustMark (Adobe, C2PA soft-binding watermark; model Q, BCH_5, 61-bit payload)\n');
log(`- Watermarking changes the pixels: PSNR ${tm.psnrMean.toFixed(1)} dB on average (${tm.psnrMin.toFixed(1)}-${tm.psnrMax.toFixed(1)}). Read back from the watermarked file: ${tm.self}/${all.length}; found in unwatermarked originals: ${tm.unmarkedFound}/${all.length}.`);
log(`- Unedited simulated copies: payload recovered **${tm.clean.ok}/${tm.clean.n} (${pct2(tm.clean.ok, tm.clean.n)})**, wrong payload ${tm.clean.wrong}, not found ${tm.clean.none}. (Real platform files cannot be used: they were made from the unwatermarked photo.)`);
log(`- Visible edits: payload recovered **${tm.edit.ok}/${tm.edit.n} (${pct(tm.edit.ok, tm.edit.n)})**, i.e. linked to the original's credentials with no sign of the edit; wrong payload ${tm.edit.wrong}; not found ${tm.edit.none} (${pct(tm.edit.none, tm.edit.n)}).\n`);

// ---- 4. Bootstrap AUC (same resampling as analyze_vision.js) ----
{
  const Bn = 200;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = [...new Set(test.map(r => r.v.ref))];
  const by = new Map(ids.map(id => [id, { c: [], e: [] }]));
  for (const r of tClean) by.get(r.v.ref).c.push(r);
  for (const r of tEdit) by.get(r.v.ref).e.push(r);
  const s = { ours: [], pdq: [] };
  for (let b = 0; b < Bn; b++) {
    const pick = ids.map(() => ids[Math.floor(rnd() * ids.length)]);
    for (const k of Object.keys(s)) {
      const pos = [], neg = [];
      for (const id of pick) { const g = by.get(id); for (const r of g.c) pos.push(SCORES[k](r)); for (const r of g.e) neg.push(SCORES[k](r)); }
      s[k].push(roc(pos, neg).auc);
    }
  }
  const q = (a, p) => { const x = [...a].sort((u, v) => u - v); return x[Math.min(x.length - 1, Math.floor(p * x.length))]; };
  const diff = s.pdq.map((x, i) => x - s.ours[i]);
  out.aucCI = { ours: [q(s.ours, 0.025), q(s.ours, 0.975)], pdq: [q(s.pdq, 0.025), q(s.pdq, 0.975)], pdqMinusOurs: [q(diff, 0.025), q(diff, 0.975)] };
  if (complete) {
    const v = VR.aucCI['scfp1 regions (this work)'];
    if (Math.abs(v.lo - out.aucCI.ours[0]) > 1e-12 || Math.abs(v.hi - out.aucCI.ours[1]) > 1e-12) { console.error('bootstrap differs from results_vision.json'); process.exit(1); }
  }
  log(`## AUC with 95% bootstrap intervals (${Bn} resamples of the test photos, as in results_vision)\n`);
  log(`- SecureCam regions: ${ourRoc.auc.toFixed(3)} (${out.aucCI.ours.map(x => x.toFixed(3)).join('-')})`);
  log(`- PDQ: ${pdq.auc.toFixed(3)} (${out.aucCI.pdq.map(x => x.toFixed(3)).join('-')}); PDQ minus SecureCam: ${out.aucCI.pdqMinusOurs.map(x => x.toFixed(3)).join(' to ')}\n`);
}

// ---- 5. Summary table ----
const S = VR.defaultsTest, St = VR.strictTest;
out.summary = [
  { method: 'C2PA hard binding, platform removes the manifest (WhatsApp, Facebook)', pixels: 'unchanged', accepted: [0, tClean.length], rejected: null, where: 'no' },
  { method: 'C2PA hard binding, manifest kept', pixels: 'unchanged', accepted: [c2.cleanKept.valid, c2.cleanKept.n], rejected: [c2.editKept.n - c2.editKept.valid, c2.editKept.n], where: 'no' },
  { method: 'TrustMark watermark (C2PA soft binding)', pixels: `PSNR ${tm.psnrMean.toFixed(1)} dB`, accepted: [tm.clean.ok, tm.clean.n], rejected: [tm.edit.n - tm.edit.ok, tm.edit.n], where: 'no' },
  { method: `PDQ, threshold ${PDQ_META}`, pixels: 'unchanged', accepted: [pdq.thresholds.meta.accepted, tClean.length], rejected: [pdq.thresholds.meta.rejected, tEdit.length], where: 'no' },
  { method: `PDQ, calibrated threshold ${pdqCal}`, pixels: 'unchanged', accepted: [pdq.thresholds.calibrated.accepted, tClean.length], rejected: [pdq.thresholds.calibrated.rejected, tEdit.length], where: 'no' },
  { method: 'SecureCam, standard', pixels: 'unchanged', accepted: [S.cleanOk, S.clean], rejected: [S.caught, S.vis], where: `${S.localized} of ${S.vis}` },
  { method: 'SecureCam, strict', pixels: 'unchanged', accepted: [St.cleanOk, St.clean], rejected: [St.caught, St.vis], where: `${St.localized} of ${St.vis}` },
];
log('## Summary (test split)\n');
log('| method | photo pixels | unedited copies accepted | visible edits rejected | shows where |');
log('|---|---|---|---|---|');
for (const r of out.summary)
  log(`| ${r.method} | ${r.pixels} | ${r.accepted[0]}/${r.accepted[1]} (${pct2(...r.accepted)}) | ${r.rejected ? `${r.rejected[0]}/${r.rejected[1]} (${pct(...r.rejected)})` : 'no credentials either way'} | ${r.where} |`);
log('\nSecureCam rows are the full verifier decision from results_vision.json (defaultsTest / strictTest).');

// ---- 6. Per edit type and per platform ----
const kinds = [...new Set(tEdit.map(r => r.v.edit))];
out.perEdit = {};
log('\n## Visible edits rejected, by edit type (test split)\n');
log('| edit | copies | PDQ ≤31 | PDQ calibrated | TrustMark (not linked) | SecureCam standard | SecureCam strict |');
log('|---|---|---|---|---|---|---|');
for (const k of kinds) {
  const g = tEdit.filter(r => r.v.edit === k);
  const e = { n: g.length, pdqMeta: cnt(g, r => r.b.pdq > PDQ_META), pdqCal: cnt(g, r => r.b.pdq > pdqCal), tm: cnt(g, r => r.b.tm !== 'ok'),
              ours: VR.standardPerEdit[k][0], strict: VR.strictPerEdit[k][0] };
  if (VR.standardPerEdit[k][1] !== g.length && complete) throw new Error('edit count differs for ' + k);
  out.perEdit[k] = e;
  log(`| ${k} | ${e.n} | ${pct(e.pdqMeta, e.n)} | ${pct(e.pdqCal, e.n)} | ${pct(e.tm, e.n)} | ${pct(e.ours, VR.standardPerEdit[k][1])} | ${pct(e.strict, VR.strictPerEdit[k][1])} |`);
}
out.perPlatform = {};
log('\n## Unedited copies accepted, by platform (test split)\n');
log('| platform | copies | PDQ ≤31 | TrustMark payload recovered | C2PA (manifest kept) valid |');
log('|---|---|---|---|---|');
for (const p of [...new Set(tClean.map(r => r.v.platform))]) {
  const g = tClean.filter(r => r.v.platform === p), t = g.filter(r => r.b.tm), c = g.filter(r => r.b.c2paKept);
  const e = { n: g.length, pdq: cnt(g, r => r.b.pdq <= PDQ_META), tm: t.length ? [cnt(t, r => r.b.tm === 'ok'), t.length] : null, c2pa: c.length ? [cnt(c, r => /^(Trusted|Valid)$/.test(r.b.c2paKept)), c.length] : null };
  out.perPlatform[p] = e;
  log(`| ${p} | ${e.n} | ${pct2(e.pdq, e.n)} | ${e.tm ? pct2(...e.tm) : 'n/a (real file)'} | ${e.c2pa ? `${e.c2pa[0]}/${e.c2pa[1]}` : 'n/a (not JPEG)'} |`);
}

fs.writeFileSync(REPORT, lines.join('\n') + '\n');
fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log('\nwrote', REPORT, JSON_OUT);
