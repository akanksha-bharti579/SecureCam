// Scores the adaptive-attack copies from attack_vision.py against their own signed record, as the verifier does
// (lookup over four orientations, then the region comparison), in the standard and the strict mode.
// Usage: node attack_score.js <VISION_out dir> [results.md] [results.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results_attack.md');
const JSON_OUT = process.argv[4] || path.join(__dirname, 'results_attack.json');
const A = JSON.parse(fs.readFileSync(path.join(OUT, 'attack', 'attack_jobs.json'), 'utf8'));
const thumb = (dir, id) => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, dir, id + '.bin'))));
const VISIBLE = v => v.magY >= 10 || v.magRGB >= 10;

function verdict(ref, cand, strict) {
  const rec = { phash: SC.phashFromY(ref.y), quads: SC.quadrantPhashes(ref.y) };
  let best = null;
  for (const q of SC.lookupQueries(cand)) {
    const m = SC.lookupMatch(q, rec);
    if (m.match && (!best || m.distance < best.m.distance)) best = { q, m };
  }
  if (!best) return 'UNVERIFIED';
  return SC.compareThumbs(ref, SC.rotateThumbs(cand, best.q.deg), { strict }).verdict === 'MATCH' ? 'ACCEPTED' : 'REJECTED';
}

const groups = {};
for (const v of A.variants) {
  const ref = thumb('thumbs', v.ref + '_phone'), cand = thumb('attack', v.thumb);
  v.standard = verdict(ref, cand, false);
  v.strict = verdict(ref, cand, true);
  const key = `${v.attack} ${v.cells}`;
  (groups[key] = groups[key] || []).push(v);
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');
const lines = [];
const log = s => { lines.push(s); console.log(s); };
const NAMES = { size: 'Copy-move patch', paste: 'Paste from another photo', meanfix: 'Paste, cell means preserved (adaptive)' };
log(`# Adaptive-attack test (${A.photos.length} VISION test photos, WhatsApp-like re-encoding)\n`);
log('| attack | size (cells) | copies | visible | visible copies accepted: standard | strict |');
log('|---|---|---|---|---|---|');
const out = { photos: A.photos.length, rows: [] };
for (const [key, g] of Object.entries(groups)) {
  const [attack, cells] = key.split(' ');
  const vis = g.filter(VISIBLE);
  const row = { attack, cells: +cells, copies: g.length, visible: vis.length,
                acceptedStandard: vis.filter(v => v.standard === 'ACCEPTED').length, acceptedStrict: vis.filter(v => v.strict === 'ACCEPTED').length,
                meanMagY: vis.reduce((s, v) => s + v.magY, 0) / Math.max(1, vis.length) };
  if (attack === 'meanfix') row.clippedShare = g.reduce((s, v) => s + v.clippedPixels, 0) / g.reduce((s, v) => s + v.areaPixels, 0);
  out.rows.push(row);
  log(`| ${NAMES[attack]} | ${cells} × ${cells} | ${g.length} | ${vis.length} (mean luma change ${row.meanMagY.toFixed(1)}) | ${row.acceptedStandard} (${pct(row.acceptedStandard, vis.length)}) | ${row.acceptedStrict} (${pct(row.acceptedStrict, vis.length)}) |`);
}
log('\nA cell is 1/128 of the image width and height. "Visible": mean change inside the edited area of at least 10 levels.');
const mf = out.rows.filter(r => r.attack === 'meanfix');
if (mf.length) log(`Mean correction had to clip ${(100 * mf.reduce((s, r) => s + r.clippedShare, 0) / mf.length).toFixed(1)}% of the pixels it changed.`);
fs.writeFileSync(REPORT, lines.join('\n') + '\n');
fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
