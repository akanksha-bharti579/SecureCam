'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('../securecam-core.js');
const { synth } = require('./synth.js');
const H = require('./helpers.js');

const VECTORS = path.join(__dirname, '..', '..', 'SecureCam', 'app', 'src', 'test', 'resources', 'scfp1_vectors.json');

test('Android parity vectors are up to date with this implementation', { skip: !fs.existsSync(VECTORS) && 'SecureCam project not found' }, async () => {
  const file = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  for (const v of file.vectors) {
    const t = SC.rotateThumbs(SC.thumbnailsFromRGBA(synth(v.w, v.h, v.seed), v.w, v.h), v.rot);
    assert.strictEqual(SC.phashFromY(t.y), v.phash);
    assert.strictEqual(await SC.sha256Hex(SC.thumbBytes(t)), v.thumbSha256);
  }
});

test('rotating the thumbnail grid equals fingerprinting the rotated image (aligned size)', () => {
  const img = synth(256, 384, 3);
  const r = H.rotateRGBA90(img, 256, 384);
  const a = SC.thumbBytes(SC.rotateThumbs(SC.thumbnailsFromRGBA(img, 256, 384), 90));
  const b = SC.thumbBytes(SC.thumbnailsFromRGBA(r.rgba, r.w, r.h));
  assert.deepStrictEqual(Buffer.from(a), Buffer.from(b));
});

test('rotations compose: 90 four times is the identity', () => {
  const t = SC.thumbnailsFromRGBA(synth(300, 200, 11), 300, 200);
  let r = t;
  for (let i = 0; i < 4; i++) r = SC.rotateThumbs(r, 90);
  assert.deepStrictEqual(Buffer.from(SC.thumbBytes(r)), Buffer.from(SC.thumbBytes(t)));
});

test('images smaller than 128 px are rejected', () => {
  assert.throws(() => SC.thumbnailsFromRGBA(new Uint8Array(127 * 200 * 4), 127, 200), /too small/);
});

test('hamming distance', () => {
  assert.strictEqual(SC.hamming('0000000000000000', '0000000000000000'), 0);
  assert.strictEqual(SC.hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.strictEqual(SC.hamming('8000000000000001', '0000000000000000'), 2);
});

test('v2 trailer: untouched file is AUTHENTIC', async () => {
  const key = H.newKey();
  const cap = await H.capture({ key, rgba: synth(640, 480, 1), w: 640, h: 480 });
  const tr = SC.parseTrailer(cap.file);
  assert.strictEqual(tr.version, 2);
  const r = await SC.verifyTrailerV2(cap.file, tr);
  assert.strictEqual(r.status, 'AUTHENTIC');
  assert.strictEqual(r.manifest.fp.phash, cap.phash);
});

test('v2 trailer: one changed image byte is TAMPERED (and the signed thumbnail is still available)', async () => {
  const cap = await H.capture({ key: H.newKey(), rgba: synth(640, 480, 2), w: 640, h: 480 });
  const f = cap.file.slice();
  f[1000] ^= 0x01;
  const r = await SC.verifyTrailerV2(f, SC.parseTrailer(f));
  assert.strictEqual(r.status, 'TAMPERED');
  assert.ok(r.thumbs && r.thumbs.y.length === SC.N * SC.N);
});

test('v2 trailer: edited manifest or swapped thumbnail is FORGED_BLOCK', async () => {
  const cap = await H.capture({ key: H.newKey(), rgba: synth(640, 480, 3), w: 640, h: 480 });
  // Re-sign nothing, but change the capture time inside the manifest.
  const forgedManifest = new TextEncoder().encode(new TextDecoder().decode(cap.manifest).replace('2026-09-27', '2020-01-01'));
  const t1 = SC.buildTrailerV2(forgedManifest, cap.sig, cap.spki, cap.thumb);
  const f1 = new Uint8Array([...cap.fileBytes, ...t1]);
  assert.strictEqual((await SC.verifyTrailerV2(f1, SC.parseTrailer(f1))).status, 'FORGED_BLOCK');
  const other = SC.thumbBytes(SC.thumbnailsFromRGBA(synth(640, 480, 4), 640, 480));
  const t2 = SC.buildTrailerV2(cap.manifest, cap.sig, cap.spki, other);
  const f2 = new Uint8Array([...cap.fileBytes, ...t2]);
  assert.strictEqual((await SC.verifyTrailerV2(f2, SC.parseTrailer(f2))).status, 'FORGED_BLOCK');
});

test('v1 trailers from the Review-2 app still verify', async () => {
  const key = H.newKey();
  const body = new Uint8Array([0xff, 0xd8, ...crypto.randomBytes(3000), 0xff, 0xd9]);
  const sig = crypto.sign('sha256', body, { key, dsaEncoding: 'ieee-p1363' });
  const pub = H.spkiOf(key);
  const block = SC.asciiBytes(`||SECURECAM_START||SIG:${SC.b64encode(sig)}|PUB:${SC.b64encode(pub)}||SECURECAM_END||`);
  const file = new Uint8Array([...body, ...block]);
  const tr = SC.parseTrailer(file);
  assert.strictEqual(tr.version, 1);
  assert.strictEqual((await SC.verifyTrailerV1(file, tr)).status, 'AUTHENTIC');
  file[10] ^= 0xff;
  assert.strictEqual((await SC.verifyTrailerV1(file, SC.parseTrailer(file))).status, 'TAMPERED');
});

test('no trailer and malformed trailers are detected', () => {
  assert.strictEqual(SC.parseTrailer(new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])), null);
  const bad = new Uint8Array([0xff, 0xd9, ...SC.asciiBytes('||SECURECAM_V2||M:###')]);
  assert.strictEqual(SC.parseTrailer(bad).malformed, true);
});

test('recompressed copy MATCHES; painted region is MODIFIED and localized', () => {
  const img = synth(1024, 768, 21);
  const ref = SC.thumbnailsFromRGBA(img, 1024, 768);
  const d = H.degrade(img, 1024, 768, 2, 3);
  const c1 = SC.compareThumbs(ref, SC.thumbnailsFromRGBA(d.rgba, d.w, d.h));
  assert.strictEqual(c1.verdict, 'MATCH', `max luma ${c1.maxLuma}, chroma ${c1.maxChroma}`);
  const edited = H.paintRect(img, 1024, 600, 300, 700, 380, [250, 20, 200]);
  const e = H.degrade(edited, 1024, 768, 2, 3);
  const c2 = SC.compareThumbs(ref, SC.thumbnailsFromRGBA(e.rgba, e.w, e.h));
  assert.strictEqual(c2.verdict, 'MODIFIED');
  for (const t of c2.changed) {
    const tr = Math.floor(t / SC.TILES), tc = t % SC.TILES;
    // Edit covers x 600-700 (tiles 9-10), y 300-380 (tiles 6-7); allow one tile of spread.
    assert.ok(tc >= 8 && tc <= 11 && tr >= 5 && tr <= 8, `unexpected changed tile ${tr},${tc}`);
  }
});

test('strict mode: a recompressed copy still MATCHES, a blurred region is MODIFIED', () => {
  const W = 1024, Hh = 768;
  const img = synth(W, Hh, 21);
  const ref = SC.thumbnailsFromRGBA(img, W, Hh);
  const d = H.degrade(img, W, Hh, 2, 3);
  const copy = SC.compareThumbs(ref, SC.thumbnailsFromRGBA(d.rgba, d.w, d.h), { strict: true });
  assert.strictEqual(copy.verdict, 'MATCH', `worst tile SSIM ${copy.ssimMin}`);
  // Strong box blur (radius 16, sampled every 2 px) of a 160 x 120 region: its average colour stays, its texture goes.
  const blurred = Uint8ClampedArray.from(img);
  const x0 = 300, y0 = 200, x1 = 460, y1 = 320, R = 16;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let ch = 0; ch < 3; ch++) {
        let s = 0, n = 0;
        for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { s += img[((y + dy) * W + x + dx) * 4 + ch]; n++; }
        blurred[(y * W + x) * 4 + ch] = s / n;
      }
  const b = H.degrade(blurred, W, Hh, 2, 3);
  const cand = SC.thumbnailsFromRGBA(b.rgba, b.w, b.h);
  const standard = SC.compareThumbs(ref, cand);
  const strict = SC.compareThumbs(ref, cand, { strict: true });
  assert.strictEqual(standard.verdict, 'MATCH', 'the average-based check alone does not see this blur');
  assert.ok(strict.ssimMin < SC.DEFAULTS.ssimMin, `worst tile SSIM ${strict.ssimMin}`);
  assert.strictEqual(strict.verdict, 'MODIFIED');
  assert.ok(strict.changed.length >= standard.changed.length);
  for (const t of strict.changed) {
    const tr = Math.floor(t / SC.TILES), tc = t % SC.TILES;
    // Blur covers x 300-460 (tiles 4-7), y 200-320 (tiles 4-6); allow one tile of spread.
    assert.ok(tc >= 3 && tc <= 8 && tr >= 3 && tr <= 7, `unexpected changed tile ${tr},${tc}`);
  }
});

test('bestOrientation finds a copy that was rotated by a platform', () => {
  const img = synth(800, 600, 31);
  const ref = SC.thumbnailsFromRGBA(img, 800, 600);
  const r = H.rotateRGBA90(img, 800, 600);
  const best = SC.bestOrientation(SC.thumbnailsFromRGBA(r.rgba, r.w, r.h), SC.phashFromY(ref.y));
  assert.strictEqual(best.deg, 270);
  assert.strictEqual(best.distance, 0);
});
