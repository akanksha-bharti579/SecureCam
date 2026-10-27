// Test helpers: a "phone simulator" that produces exactly what the Android app
// produces (manifest, raw ECDSA signature, v2 trailer, registry payload).
'use strict';
const crypto = require('crypto');
const SC = require('../securecam-core.js');

function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey;
}

function keyFromPem(pem) { return crypto.createPrivateKey(pem); }

function spkiOf(privateKey) {
  return new Uint8Array(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
}

function manifestJson(o) {
  return `{"v":2,"app":"${o.app || 'com.example.securecam'}","captured":"${o.captured || '2026-09-27T10:15:30.123Z'}",` +
    `"file_sha256":"${o.fileSha256}","fp":{"alg":"scfp1","phash":"${o.phash}","thumb_sha256":"${o.thumbSha256}","w":${o.w},"h":${o.h}},` +
    `"key":"${o.keyId}","sec":"${o.sec || 'StrongBox'}"}`;
}

/**
 * Signs a capture the way MainActivity does.
 * @param {object} p { key, rgba, w, h, rot?, fileBytes?, chain?, overrides? }
 */
async function capture(p) {
  const thumbs = SC.rotateThumbs(SC.thumbnailsFromRGBA(p.rgba, p.w, p.h), p.rot || 0);
  const thumb = SC.thumbBytes(thumbs);
  const fileBytes = p.fileBytes || new Uint8Array([0xff, 0xd8, ...crypto.randomBytes(4000), 0xff, 0xd9]);
  const spki = spkiOf(p.key);
  const fields = Object.assign({
    fileSha256: await SC.sha256Hex(fileBytes), phash: SC.phashFromY(thumbs.y), thumbSha256: await SC.sha256Hex(thumb),
    w: p.w, h: p.h, keyId: await SC.sha256Hex(spki)
  }, p.overrides || {});
  const manifest = new TextEncoder().encode(manifestJson(fields));
  const sig = new Uint8Array(crypto.sign('sha256', manifest, { key: p.key, dsaEncoding: 'ieee-p1363' }));
  const trailer = SC.buildTrailerV2(manifest, sig, spki, thumb);
  const file = new Uint8Array(fileBytes.length + trailer.length);
  file.set(fileBytes, 0); file.set(trailer, fileBytes.length);
  const payload = { manifest: SC.b64encode(manifest), sig: SC.b64encode(sig), pub: SC.b64encode(spki), thumb: SC.b64encode(thumb), chain: p.chain || [] };
  return { thumbs, thumb, manifest, sig, spki, file, fileBytes, payload, phash: fields.phash };
}

// Box-downscale by an integer factor with deterministic noise: a stand-in for a
// platform re-encode in tests that do not decode JPEG.
function degrade(rgba, w, h, f, noise = 3, seed = 9) {
  const W = Math.floor(w / f), H = Math.floor(h / f);
  const out = new Uint8Array(W * H * 4);
  let x = seed;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % (2 * noise + 1)) - noise; };
  for (let y = 0; y < H; y++)
    for (let c = 0; c < W; c++)
      for (let ch = 0; ch < 3; ch++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += rgba[((y * f + dy) * w + c * f + dx) * 4 + ch];
        out[(y * W + c) * 4 + ch] = Math.max(0, Math.min(255, Math.round(s / (f * f)) + rnd()));
      }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { rgba: out, w: W, h: H };
}

function paintRect(rgba, w, x0, y0, x1, y1, color) {
  const out = rgba.slice();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4;
    out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2];
  }
  return out;
}

function rotateRGBA90(rgba, w, h) { // clockwise
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < w; r++) for (let c = 0; c < h; c++) {
    const src = ((h - 1 - c) * w + r) * 4, dst = (r * h + c) * 4;
    out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2]; out[dst + 3] = 255;
  }
  return { rgba: out, w: h, h: w };
}

module.exports = { newKey, keyFromPem, spkiOf, capture, degrade, paintRect, rotateRGBA90, manifestJson };
