// Scoring half of verify_received.py: reads [{file, thumb(hex), ...}] on stdin and decides each
// file against the registry records exactly as the browser verifier does (lookup over four
// orientations, signature and thumbnail re-check of the record, region comparison).
// Usage: node tools/verify_received.js <registry data dir>   (normally run by verify_received.py)
// STRICT=1 in the environment also checks the structure of every region (regional SSIM).
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../securecam-core.js');

const DATA = process.argv[2];
const records = fs.readFileSync(path.join(DATA, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const keys = JSON.parse(fs.readFileSync(path.join(DATA, 'keys.json'), 'utf8'));
const b64 = s => new Uint8Array(Buffer.from(s, 'base64'));

(async () => {
  const recs = [];
  for (const r of records) {
    const v = await SC.verifyRegistryRecord({ manifest: r.manifest, sig: r.sig, pub: r.pub, thumb: r.thumb });
    if (!v || !v.ok) continue; // a record that does not verify is never used
    const thumbs = SC.splitThumbBytes(b64(r.thumb));
    recs.push({ r, thumbs, phash: SC.phashFromY(thumbs.y), quads: SC.quadrantPhashes(thumbs.y),
                attested: !!(keys[r.keyId] && keys[r.keyId].ok), manifest: JSON.parse(Buffer.from(r.manifest, 'base64').toString('utf8')) });
  }
  const items = JSON.parse(fs.readFileSync(0, 'utf8'));
  const out = items.map(it => {
    const cand = SC.splitThumbBytes(new Uint8Array(Buffer.from(it.thumb, 'hex')));
    const queries = SC.lookupQueries(cand);
    const cands = [];
    for (const rec of recs) {
      let best = null;
      for (const q of queries) {
        const lm = SC.lookupMatch(q, rec);
        if (lm.match && (!best || lm.distance < best.lm.distance)) best = { q, lm };
      }
      if (!best) continue;
      const c = SC.compareThumbs(rec.thumbs, SC.rotateThumbs(cand, best.q.deg), { strict: process.env.STRICT === '1' });
      cands.push({ rec, distance: best.lm.distance, c });
    }
    const match = cands.find(x => x.c.verdict === 'MATCH');
    const mod = cands.filter(x => x.c.verdict === 'MODIFIED').sort((a, b) => a.c.changed.length - b.c.changed.length)[0];
    const pick = match || mod;
    const verdict = match ? (match.rec.attested ? 'AUTHENTIC COPY' : 'NOT ATTESTED') : mod ? 'MODIFIED' : 'UNVERIFIED';
    return { file: it.file, w: it.w, h: it.h, bytes: it.bytes, verdict, candidates: cands.length,
             distance: pick ? pick.distance : null, changed: pick ? pick.c.changed.length : 0,
             maxLuma: pick ? +pick.c.maxLuma.toFixed(2) : 0, maxChroma: pick ? +pick.c.maxChroma.toFixed(2) : 0,
             ssimMin: pick && pick.c.ssimMin !== null ? +pick.c.ssimMin.toFixed(4) : null,
             captured: pick ? pick.rec.manifest.captured : null };
  });
  process.stdout.write(JSON.stringify(out));
})().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
