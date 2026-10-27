// Verifier oracle for attack7_vision.py: the attacker may run the public verifier code as often as it likes.
// Protocol on stdin: 18432 bytes of the signed record's thumbnail, then 18432 bytes of the candidate copy's thumbnail
// (both in display orientation). Reply: one JSON line {standard: {verdict, changed}, strict: {...}}, where verdict is
// ACCEPTED, REJECTED (MODIFIED or DIFFERENT) or UNVERIFIED (the lookup does not find the record), as attack_score.js.
'use strict';
const SC = require('../../../securecam-core.js');

const B = SC.THUMB_BYTES || 18432;
function verdict(ref, cand, strict) {
  const rec = { phash: SC.phashFromY(ref.y), quads: SC.quadrantPhashes(ref.y) };
  let best = null;
  for (const q of SC.lookupQueries(cand)) {
    const m = SC.lookupMatch(q, rec);
    if (m.match && (!best || m.distance < best.m.distance)) best = { q, m };
  }
  if (!best) return { verdict: 'UNVERIFIED', changed: [] };
  const c = SC.compareThumbs(ref, SC.rotateThumbs(cand, best.q.deg), { strict });
  return { verdict: c.verdict === 'MATCH' ? 'ACCEPTED' : 'REJECTED', changed: c.changed, deg: best.q.deg };
}
let buf = Buffer.alloc(0);
process.stdin.on('data', c => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 2 * B) {
    const ref = SC.splitThumbBytes(new Uint8Array(buf.subarray(0, B))), cand = SC.splitThumbBytes(new Uint8Array(buf.subarray(B, 2 * B)));
    buf = buf.subarray(2 * B);
    process.stdout.write(JSON.stringify({ standard: verdict(ref, cand, false), strict: verdict(ref, cand, true) }) + '\n');
  }
});
