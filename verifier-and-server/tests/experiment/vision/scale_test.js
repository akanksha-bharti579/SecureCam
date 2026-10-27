// Scalability of the registry lookup and of the verifier's per-candidate work.
//  1. Time of one lookup (4 orientations) over M records: the registry's current code (SC.lookupMatch on hex
//     strings, as server.js does) and a packed version (64-bit hashes as 32-bit words + popcount).
//  2. Rate of wrong candidates, measured on the 1,000 real VISION records (every record queried against every
//     other one), projected to large registries.
//  3. Verifier cost per candidate: record signature check + region comparison (standard and strict).
// Usage: node scale_test.js <VISION_out dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_scale.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_scale.json');
const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'));
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));
const lines = [], out = {};
const log = s => { lines.push(s); console.log(s); };
const now = () => Number(process.hrtime.bigint()) / 1e6;
const hex16 = () => crypto.randomBytes(8).toString('hex');

// A real query: the WhatsApp copy of the first photo.
const q0 = SC.lookupQueries(readThumb(jobs.variants.find(v => v.platform === 'real_whatsapp').thumb));

// ---- 1. lookup time
const words = h => [parseInt(h.slice(0, 8), 16) >>> 0, parseInt(h.slice(8), 16) >>> 0];
const pop = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const D = SC.DEFAULTS;
function packedScan(RH, M, qs) {
  let hits = 0;
  for (let i = 0; i < M; i++) {
    const b = i * 10;
    for (const q of qs) {
      const d = pop(q[0] ^ RH[b]) + pop(q[1] ^ RH[b + 1]);
      let close = 0;
      for (let k = 1; k < 5; k++) close += pop(q[2 * k] ^ RH[b + 2 * k]) + pop(q[2 * k + 1] ^ RH[b + 2 * k + 1]) <= D.quadMaxDistance;
      if (d <= D.lookupMaxDistance || close >= D.quadMinCount) { hits++; break; }
    }
  }
  return hits;
}
const qPacked = q0.map(q => [q.phash, ...q.quads].flatMap(words));
log('# Registry and verifier scalability\n');
log('## 1. Time of one lookup (four orientations), random registry contents\n');
log('| records | current code (hex strings), ms | packed 32-bit words, ms |');
log('|---|---|---|');
out.lookup = [];
for (const M of [1e3, 1e4, 1e5, 1e6]) {
  const RH = new Uint32Array(M * 10);
  for (let i = 0; i < RH.length; i++) RH[i] = (Math.random() * 2 ** 32) >>> 0;
  let cur = null;
  if (M <= 1e5) {
    const recs = Array.from({ length: M }, () => ({ phash: hex16(), quads: [hex16(), hex16(), hex16(), hex16()] }));
    const reps = M <= 1e4 ? 5 : 2;
    const t = now();
    for (let r = 0; r < reps; r++) for (const rec of recs) for (const q of q0) if (SC.lookupMatch(q, rec).match) break;
    cur = (now() - t) / reps;
  }
  packedScan(RH, M, qPacked); // warm-up
  const reps = M < 1e6 ? 20 : 5, t = now();
  for (let r = 0; r < reps; r++) packedScan(RH, M, qPacked);
  const packed = (now() - t) / reps;
  out.lookup.push({ records: M, currentMs: cur, packedMs: packed });
  log(`| ${M.toLocaleString('en')} | ${cur === null ? '(not run)' : cur.toFixed(1)} | ${packed.toFixed(2)} |`);
}

// ---- 2. wrong candidates per lookup, from the real records
const refs = jobs.originals.map(o => { const t = readThumb(o.phoneThumb); return { id: o.id, y: t.y, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y) }; });
let pairs = 0, byGlobal = 0, byQuads = 0, either = 0;
for (let i = 0; i < refs.length; i++) {
  const qs = SC.lookupQueries({ y: refs[i].y, cb: new Uint8Array(1024), cr: new Uint8Array(1024) });
  for (let j = 0; j < refs.length; j++) {
    if (i === j) continue;
    pairs++;
    let g = false, qd = false;
    for (const q of qs) { const m = SC.lookupMatch(q, refs[j]); if (m.distance <= D.lookupMaxDistance) g = true; if (m.closeQuads >= D.quadMinCount) qd = true; }
    byGlobal += g; byQuads += qd; either += g || qd;
  }
}
const rate = either / pairs;
out.candidates = { pairs, byGlobal, byQuads, either, rate };
log(`\n## 2. Wrong candidates\n`);
log(`Each of the ${refs.length} real records queried against the other ${refs.length - 1} in all four orientations: ${pairs.toLocaleString('en')} ordered pairs, ` +
    `${byGlobal} candidates by the global hash, ${byQuads} by the quadrant hashes, ${either} in total (rate ${rate.toExponential(2)} per record).\n`);
log('| records in the registry | expected wrong candidates per lookup |');
log('|---|---|');
for (const M of [1e3, 1e4, 1e5, 1e6, 1e7]) log(`| ${M.toLocaleString('en')} | ${(rate * M).toFixed(M < 1e5 ? 2 : 0)} |`);

// ---- 3. verifier work per candidate (Node; the browser uses the same code)
(async () => {
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = new Uint8Array(k.publicKey.export({ type: 'spki', format: 'der' }));
  const msg = new TextEncoder().encode('{"v":2,"x":"' + 'a'.repeat(300) + '"}');
  const sig = new Uint8Array(crypto.sign('sha256', msg, { key: k.privateKey, dsaEncoding: 'ieee-p1363' }));
  const n = 200;
  let t = now();
  for (let i = 0; i < n; i++) await SC.verifyEcdsa(spki, sig, msg);
  const verifyMs = (now() - t) / n;
  const a = readThumb(jobs.originals[0].phoneThumb), b = readThumb(jobs.variants[0].thumb);
  t = now(); for (let i = 0; i < n; i++) SC.compareThumbs(a, b); const cmpMs = (now() - t) / n;
  t = now(); for (let i = 0; i < n; i++) SC.compareThumbs(a, b, { strict: true }); const strictMs = (now() - t) / n;
  out.perCandidate = { verifyMs, compareMs: cmpMs, compareStrictMs: strictMs };
  log(`\n## 3. Verifier work per candidate record\n`);
  log(`Signature check ${verifyMs.toFixed(2)} ms; region comparison ${cmpMs.toFixed(2)} ms (strict ${strictMs.toFixed(2)} ms). ` +
      `With ${(rate * 1e6).toFixed(0)} wrong candidates at one million records, a lookup adds about ` +
      `${(rate * 1e6 * (verifyMs + strictMs)).toFixed(0)} ms of verification in strict mode.`);
  fs.writeFileSync(REPORT, lines.join('\n') + '\n');
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
})();
