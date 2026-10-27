// Scores the dataset from make_dataset.py with the real securecam-core.js code.
// Usage: node analyze.js <out_dir> [results.md]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../securecam-core.js');

const OUT = process.argv[2];
const REPORT = process.argv[3] || path.join(__dirname, 'results.md');
const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'));
const readThumb = id => SC.splitThumbBytes(new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', id + '.bin'))));

// 1. The NumPy port must match the JavaScript implementation exactly.
for (const p of jobs.parity) {
  const rgba = new Uint8Array(fs.readFileSync(p.raw));
  const js = SC.thumbBytes(SC.thumbnailsFromRGBA(rgba, p.w, p.h));
  const py = new Uint8Array(fs.readFileSync(path.join(OUT, 'thumbs', p.thumb + '.bin')));
  if (Buffer.compare(Buffer.from(js), Buffer.from(py)) !== 0) {
    console.error('PARITY FAILURE: NumPy and JS thumbnails differ for', p.thumb);
    process.exit(1);
  }
}

// 2. Registry records = what the phone registers.
const refs = jobs.originals.map(o => {
  const t = readThumb(o.phoneThumb);
  return { id: o.id, meta: o, thumbs: t, phash: SC.phashFromY(t.y), quads: SC.quadrantPhashes(t.y), full: readThumb(o.fullThumb) };
});
const refById = Object.fromEntries(refs.map(r => [r.id, r]));

const phoneVsFull = refs.map(r => {
  const c = SC.compareThumbs(r.thumbs, r.full);
  return { d: SC.hamming(r.phash, SC.phashFromY(r.full.y)), maxLuma: c.maxLuma, maxChroma: c.maxChroma };
});

// 3. Score each copy once against its own record and against every other record.
function againstRecord(queries, ref) {
  // Per orientation: lookup distances + tile scores for that orientation.
  return queries.map(q => ({ deg: q.deg, lm: SC.lookupMatch(q, ref, { lookupMaxDistance: 0, quadMaxDistance: 0, quadMinCount: 9 }) }));
}
const scored = jobs.variants.map(v => {
  const cand = readThumb(v.thumb);
  const queries = SC.lookupQueries(cand);
  const tiles = (ref, deg) => { const c = SC.compareThumbs(ref.thumbs, SC.rotateThumbs(cand, deg)); return { luma: Array.from(c.luma), chroma: Array.from(c.chroma) }; };
  const own = againstRecord(queries, refById[v.ref]);
  const ownBest = own.reduce((a, b) => (b.lm.distance < a.lm.distance ? b : a));
  const others = [];
  for (const r of refs) {
    if (r.id === v.ref) continue;
    const per = againstRecord(queries, r);
    const best = per.reduce((a, b) => (b.lm.distance < a.lm.distance ? b : a));
    const minQuad = Math.min(...per.map(p => Math.min(...p.lm.quadDistances)));
    // Only keep what a generous lookup could ever return, to bound work.
    if (best.lm.distance <= 20 || minQuad <= 10) others.push({ id: r.id, per, tiles: tiles(r, best.deg) });
  }
  return { v, own, ownTiles: tiles(refById[v.ref], ownBest.deg), others };
});

// 4. Decision exactly as the verifier makes it, for a given threshold set.
function isCandidate(per, th) {
  return per.some(p => p.lm.distance <= th.lookupMaxDistance || p.lm.quadDistances.filter(d => d <= th.quadMaxDistance).length >= th.quadMinCount);
}
function tileVerdict(t, th) {
  const changed = [];
  for (let i = 0; i < t.luma.length; i++) if (t.luma[i] > th.tileLuma || t.chroma[i] > th.tileChroma) changed.push(i);
  if (!changed.length) return { label: 'MATCH', changed };
  return { label: changed.length / t.luma.length > th.maxChangedFraction ? 'DIFFERENT' : 'MODIFIED', changed };
}
// Result for one copy: the verifier checks every candidate and prefers a MATCH, then the
// MODIFIED candidate with the fewest changed tiles.
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
function evaluate(th) {
  const r = { clean: 0, cleanOk: 0, falseAccept: 0, vis: 0, caught: 0, modifiedOwn: 0, localized: 0, falseTiles: 0, cleanWrongPhoto: 0 };
  for (const s of scored) {
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
        r.falseTiles += d.changed.filter(t => !inBox.has(t)).length;
      }
    }
  }
  return r;
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const lines = [];
const log = s => { lines.push(s); console.log(s); };
const max = a => Math.max(...a);

log('# scfp1 robustness experiment\n');
log(`Generated by \`tests/experiment\` (make_dataset.py + analyze.js). Photos: ${refs.length} distinct 4000x3000 JPEGs (q95, simulated sensor noise; ` +
    `${refs.filter(r => r.meta.portrait).length} stored sideways with EXIF orientation 6, like portrait phone photos). Copies scored: ${scored.length}. ` +
    `Fingerprints computed with securecam-core.js; the NumPy port used to generate them was verified byte-identical on ${jobs.parity.length} images.\n`);
log('Source photos are Windows wallpapers (landscapes, cities, abstract theme art), including sets of colour variants of the same picture — a hard case for a brightness-based fingerprint.\n');

log('## Same file, phone decode vs full decode\n');
log(`The phone fingerprints a reduced-size decode (like Android's inSampleSize); a verifier decodes at full size. Max pHash difference ${max(phoneVsFull.map(x => x.d))} bits, max tile difference luma ${max(phoneVsFull.map(x => x.maxLuma)).toFixed(2)} / chroma ${max(phoneVsFull.map(x => x.maxChroma)).toFixed(2)}.\n`);

log('## Clean copies (no edits) — how much each platform changes the fingerprint\n');
log('| platform | copies | max pHash change (bits) | max tile luma diff | max tile chroma diff |');
log('|---|---|---|---|---|');
for (const p of [...new Set(scored.filter(s => s.v.kind === 'clean').map(s => s.v.platform))]) {
  const g = scored.filter(s => s.v.kind === 'clean' && s.v.platform === p);
  log(`| ${p} | ${g.length} | ${max(g.map(s => Math.min(...s.own.map(o => o.lm.distance))))} | ${max(g.map(s => max(s.ownTiles.luma))).toFixed(2)} | ${max(g.map(s => max(s.ownTiles.chroma))).toFixed(2)} |`);
}

log('\n## Threshold sweep (settings with zero false accepts and every clean copy accepted, best edit detection first)\n');
log('| lookup | quad | tile luma | tile chroma | clean accepted | false accepts | visible edits caught | shown as MODIFIED with heatmap | heatmap on the edit |');
log('|---|---|---|---|---|---|---|---|---|');
const results = [];
for (const lookupMaxDistance of [10, 12, 14])
  for (const [quadMaxDistance, quadMinCount] of [[0, 9], [4, 2], [6, 2], [8, 2], [6, 1]])
    for (const tileLuma of [7, 8, 9, 10, 12])
      for (const tileChroma of [4, 5, 6, 7, 8]) {
        const th = { lookupMaxDistance, quadMaxDistance, quadMinCount, tileLuma, tileChroma, maxChangedFraction: 0.5 };
        results.push({ th, r: evaluate(th) });
      }
const ok = results.filter(x => x.r.cleanOk === x.r.clean && x.r.falseAccept === 0);
ok.sort((a, b) => b.r.caught - a.r.caught || b.r.localized - a.r.localized || a.r.falseTiles - b.r.falseTiles);
const quadLabel = th => (th.quadMinCount > 4 ? 'off' : `${th.quadMinCount}×≤${th.quadMaxDistance}`);
for (const x of ok.slice(0, 10))
  log(`| ≤${x.th.lookupMaxDistance} | ${quadLabel(x.th)} | ${x.th.tileLuma} | ${x.th.tileChroma} | ${x.r.cleanOk}/${x.r.clean} | ${x.r.falseAccept} | ${x.r.caught}/${x.r.vis} (${pct(x.r.caught, x.r.vis)}) | ${x.r.modifiedOwn} | ${x.r.localized} |`);
const worst = results.filter(x => x.r.falseAccept > 0).length;
log(`\n${results.length} settings tried; ${ok.length} had zero false accepts with every clean copy accepted; ${worst} produced at least one false accept.`);

const d = SC.DEFAULTS;
const cur = evaluate(d);
log('\n## Shipped defaults (securecam-core.js)\n');
log(`lookup ≤${d.lookupMaxDistance} bits or ${d.quadMinCount} quadrants ≤${d.quadMaxDistance}; tile luma ${d.tileLuma}, chroma ${d.tileChroma}.\n`);
log('The tile thresholds are deliberately above the best sweep row: in an earlier run that still included Windows\' img0 wallpaper (very sharp high-contrast edges), clean screenshot/Instagram copies reached a tile luma difference of 7.65. A threshold of 9 keeps a safety margin for such photos at a cost of well under 1% edit detection.\n');
log(`- Clean platform copies recognised as authentic copies: **${cur.cleanOk}/${cur.clean} (${pct(cur.cleanOk, cur.clean)})**`);
log(`- False accepts (a copy called an authentic copy of a different photo): **${cur.falseAccept}**`);
log(`- Visible edits rejected (MODIFIED or UNVERIFIED): **${cur.caught}/${cur.vis} (${pct(cur.caught, cur.vis)})**; shown as MODIFIED with a heatmap: ${cur.modifiedOwn}, heatmap covering the edit: ${cur.localized}`);

log('\n| edit | area of photo | then | visible copies | rejected | MODIFIED + heatmap on edit |');
log('|---|---|---|---|---|---|');
const editKeys = [...new Set(scored.filter(s => s.v.kind === 'edit').map(s => s.v.edit + ' ' + s.v.frac))];
for (const k of editKeys)
  for (const p of ['editor_save', 'whatsapp_std', 'whatsapp_hd']) {
    const g = scored.filter(s => s.v.kind === 'edit' && s.v.edit + ' ' + s.v.frac === k && s.v.platform === p && VISIBLE(s));
    const ds = g.map(s => decide(s, d));
    const loc = g.filter((s, i) => ds[i].label === 'MODIFIED' && ds[i].id === s.v.ref && ds[i].changed.some(t => tilesInBox(s.v.box, 1).has(t))).length;
    log(`| ${k.split(' ')[0]} | ${(+k.split(' ')[1] * 100).toFixed(1)}% | ${p.replace('_', ' ')} | ${g.length} | ${ds.filter(x => x.label !== 'AUTHENTIC_COPY').length} | ${loc} |`);
  }

const missed = scored.filter(s => s.v.kind === 'edit' && VISIBLE(s) && decide(s, d).label === 'AUTHENTIC_COPY');
log(`\nVisible edits that passed as authentic copies: ${missed.length}.` + (missed.length ? ' Examples: ' + missed.slice(0, 9).map(s => `${s.v.edit} ${(s.v.frac * 100).toFixed(1)}% (mean change in the edited area: luma ${s.v.magY.toFixed(1)}, RGB ${s.v.magRGB.toFixed(1)})`).join('; ') : ''));
const invisible = scored.filter(s => s.v.kind === 'edit' && !VISIBLE(s)).length;
log(`\n"Visible" = mean change inside the edited area ≥ 10 levels (0-255) in luma or RGB. ${invisible} edited copies were below that (e.g. a patch cloned from a similar-looking area) and are excluded from detection rates.`);
log('\n## Known limits\n');
log('- **Blur and smoothing** of a region keep its average colour, which is what the fingerprint records, so they are not detected by the visual check. A per-region texture measure was prototyped and rejected: recompression alone changed regional texture more than a real blur did. The exact byte check still catches any blur on an original file.');
log('- **Very small edits** (well under 1% of the photo) and edits that keep the average colour of the area (a flat fill with the area\'s own median colour) can pass.');
log('- **Crops and aspect-ratio changes** (e.g. Instagram 4:5) change the grid; such copies are reported as UNVERIFIED, not as authentic.');
log('- Test photos are wallpapers with simulated sensor noise, not real phone captures. Repeat the run with real SecureCam photos (see README) before quoting final numbers.');

fs.writeFileSync(REPORT, lines.join('\n') + '\n');
console.log('\nwrote', REPORT);
