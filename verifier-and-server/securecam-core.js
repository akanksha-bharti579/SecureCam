/*
 * SecureCam v2 core — shared by the browser verifier (index.html), the registry
 * server (registry-server/) and the tests.
 *
 * Two independent proofs are supported:
 *   1. Exact proof   — the signed trailer after the JPEG's FF D9 marker is intact,
 *                      so SHA-256 of the file bytes must match the signed manifest.
 *   2. Visual proof  — platforms (WhatsApp, Instagram, ...) re-encode the photo and
 *                      delete the trailer. The signed manifest also commits to a
 *                      visual fingerprint ("scfp1") that is stored in the registry,
 *                      so a recompressed copy can still be matched and checked
 *                      region by region.
 *
 * The fingerprint must come out bit-identical in Kotlin (Provenance.kt) and here,
 * so every step that feeds a hash uses integer arithmetic only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SecureCam = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── FINGERPRINT (scfp1) ──────────────────────────────────────────────────

  const FP_ALG = 'scfp1';
  const N = 128;                          // luma thumbnail: N x N cells
  const NC = 32;                          // chroma thumbnails: NC x NC cells
  const THUMB_BYTES = N * N + 2 * NC * NC; // Y | Cb | Cr = 18432 bytes
  const MIN_SIDE = N;                     // smaller images cannot be fingerprinted

  // DCT basis for the 8 lowest frequencies over 32 samples, scaled to integers
  // so the pHash is exact in both languages.
  const COS = (() => {
    const t = new Int32Array(8 * 32);
    for (let u = 0; u < 8; u++)
      for (let x = 0; x < 32; x++)
        t[u * 32 + x] = Math.round(4096 * Math.cos(((2 * x + 1) * u * Math.PI) / 64));
    return t;
  })();

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  // Area-average an RGBA image (already in display orientation) into the
  // Y/Cb/Cr thumbnails. Cell (r, c) covers the pixels with floor(y*N/h) == r
  // and floor(x*N/w) == c.
  function thumbnailsFromRGBA(rgba, w, h) {
    if (w < MIN_SIDE || h < MIN_SIDE) throw new Error(`image too small to fingerprint (${w}x${h})`);
    const colCell = new Int32Array(w);
    for (let x = 0; x < w; x++) colCell[x] = Math.floor((x * N) / w);
    const sY = new Int32Array(N * N), sCb = new Int32Array(N * N), sCr = new Int32Array(N * N), cnt = new Int32Array(N * N);
    for (let yy = 0; yy < h; yy++) {
      const rowBase = Math.floor((yy * N) / h) * N;
      let i = yy * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
        const cell = rowBase + colCell[x];
        sY[cell] += (19595 * R + 38470 * G + 7471 * B + 32768) >> 16;
        sCb[cell] += clamp255(((-11059 * R - 21709 * G + 32768 * B + 32768) >> 16) + 128);
        sCr[cell] += clamp255(((32768 * R - 27439 * G - 5329 * B + 32768) >> 16) + 128);
        cnt[cell]++;
      }
    }
    return thumbnailsFromSums(sY, sCb, sCr, cnt);
  }

  function thumbnailsFromSums(sY, sCb, sCr, cnt) {
    const y = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) y[c] = Math.floor((2 * sY[c] + cnt[c]) / (2 * cnt[c]));
    const cb = new Uint8Array(NC * NC), cr = new Uint8Array(NC * NC);
    const f = N / NC;
    for (let a = 0; a < NC; a++) {
      for (let b = 0; b < NC; b++) {
        let tb = 0, tr = 0, tn = 0;
        for (let r = a * f; r < (a + 1) * f; r++)
          for (let c = b * f; c < (b + 1) * f; c++) {
            const k = r * N + c;
            tb += sCb[k]; tr += sCr[k]; tn += cnt[k];
          }
        cb[a * NC + b] = Math.floor((2 * tb + tn) / (2 * tn));
        cr[a * NC + b] = Math.floor((2 * tr + tn) / (2 * tn));
      }
    }
    return { y, cb, cr };
  }

  // Grid of the image rotated clockwise by `deg` (0/90/180/270).
  function rotateGrid(g, n, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg === 0) return g.slice();
    const out = new Uint8Array(n * n);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        let v;
        if (deg === 90) v = g[(n - 1 - c) * n + r];
        else if (deg === 180) v = g[(n - 1 - r) * n + (n - 1 - c)];
        else if (deg === 270) v = g[c * n + (n - 1 - r)];
        else throw new Error('rotation must be a multiple of 90');
        out[r * n + c] = v;
      }
    return out;
  }

  function rotateThumbs(t, deg) {
    return { y: rotateGrid(t.y, N, deg), cb: rotateGrid(t.cb, NC, deg), cr: rotateGrid(t.cr, NC, deg) };
  }

  // 64-bit DCT perceptual hash of the luma thumbnail, as 16 hex chars.
  function phashFromY(y) {
    const p = new Int32Array(32 * 32);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) p[(r >> 2) * 32 + (c >> 2)] += y[r * N + c];
    return phash32(p);
  }

  // pHashes of the four quadrants (TL, TR, BL, BR). Used only for registry
  // lookup, so a local edit in one part of the photo still finds the record;
  // the server derives them from the signed thumbnail (not part of the manifest).
  function quadrantPhashes(y) {
    const h = N / 2, out = [];
    for (const [r0, c0] of [[0, 0], [0, h], [h, 0], [h, h]]) {
      const p = new Int32Array(32 * 32);
      for (let r = 0; r < h; r++)
        for (let c = 0; c < h; c++) p[(r >> 1) * 32 + (c >> 1)] += y[(r0 + r) * N + c0 + c];
      out.push(phash32(p));
    }
    return out;
  }

  function phash32(p) {
    const T = new Float64Array(32 * 8); // exact: |T| <= 4080*4096*32 < 2^31
    for (let r = 0; r < 32; r++)
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let x = 0; x < 32; x++) s += p[r * 32 + x] * COS[u * 32 + x];
        T[r * 8 + u] = s;
      }
    const D = new Array(64); // exact: |D| < 2^47
    for (let v = 0; v < 8; v++)
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let r = 0; r < 32; r++) s += COS[v * 32 + r] * T[r * 8 + u];
        D[v * 8 + u] = s;
      }
    const sorted = D.slice().sort((a, b) => a - b);
    const m2 = sorted[31] + sorted[32];
    const bytes = new Uint8Array(8);
    for (let k = 0; k < 64; k++) if (2 * D[k] > m2) bytes[k >> 3] |= 1 << (7 - (k & 7));
    return toHex(bytes);
  }

  function thumbBytes(t) {
    const out = new Uint8Array(THUMB_BYTES);
    out.set(t.y, 0);
    out.set(t.cb, N * N);
    out.set(t.cr, N * N + NC * NC);
    return out;
  }

  function splitThumbBytes(b) {
    if (b.length !== THUMB_BYTES) throw new Error(`thumbnail must be ${THUMB_BYTES} bytes, got ${b.length}`);
    return { y: b.slice(0, N * N), cb: b.slice(N * N, N * N + NC * NC), cr: b.slice(N * N + NC * NC) };
  }

  const POP = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]; return t; })();
  function hamming(hexA, hexB) {
    let d = 0;
    for (let i = 0; i < 16; i += 2) d += POP[parseInt(hexA.substr(i, 2), 16) ^ parseInt(hexB.substr(i, 2), 16)];
    return d;
  }

  // ─── REGION COMPARISON ────────────────────────────────────────────────────
  //
  // The received copy is compared with the signed thumbnail tile by tile
  // (16 x 16 tiles, each 8 x 8 luma cells + 2 x 2 chroma cells). Global
  // brightness/contrast drift from re-encoding is removed first. Each cell may
  // also match its signed neighbours within one cell, which absorbs the small
  // grid misalignment caused by resizing; genuine edits change whole areas and
  // survive that allowance. Thresholds were set from tests/experiment.

  const TILES = 16;
  const TILE = N / TILES;          // 8 luma cells per tile side
  const CTILE = NC / TILES;        // 2 chroma cells per tile side
  const DEFAULTS = {
    lookupMaxDistance: 12,  // pHash bits: a registry record is a candidate below this
    quadMaxDistance: 6,     // ...or when at least quadMinCount quadrant pHashes are this close
    quadMinCount: 2,
    tileLuma: 9.0,          // mean |ΔY| per tile (0-255 scale) above which a tile counts as changed
    tileChroma: 7.0,        // mean |ΔCb|+|ΔCr| / 2 per tile above which a tile counts as changed
    maxChangedFraction: 0.5, // more than this many tiles changed => treat as a different photo
    strict: false,          // strict mode: a tile also counts as changed if its structure differs (SSIM)
    ssimMin: 0.869          // ...i.e. its mean SSIM is below this (chosen on the calibration photos)
  };

  function meanStd(a) {
    let s = 0, s2 = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; s2 += a[i] * a[i]; }
    const m = s / a.length;
    return { m, sd: Math.sqrt(Math.max(s2 / a.length - m * m, 1e-6)) };
  }

  // Per-cell difference to the closest of the signed cell and its 8 neighbours.
  function neighbourDiff(ref, cand, n, r, c) {
    const v = cand[r * n + c];
    let best = Infinity;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const d = Math.abs(ref[rr * n + cc] - v);
        if (d < best) best = d;
      }
    return best;
  }

  // Structural similarity (SSIM, 8x8 windows, 0-255 constants) between two 128x128 luma thumbnails,
  // averaged per tile of the 16x16 grid. Averages miss blur, clones of similar texture and fills;
  // structure catches most of them, so strict mode checks both. Returns per-tile values and the minimum.
  function regionalSsim(a, b) {
    const W = 8, m = N - W + 1, n1 = N + 1;
    const I = [0, 1, 2, 3, 4].map(() => new Float64Array(n1 * n1)); // integral images of x, y, x², y², xy
    for (let r = 0; r < N; r++) {
      const row = [0, 0, 0, 0, 0];
      for (let c = 0; c < N; c++) {
        const x = a[r * N + c], y = b[r * N + c];
        row[0] += x; row[1] += y; row[2] += x * x; row[3] += y * y; row[4] += x * y;
        for (let k = 0; k < 5; k++) I[k][(r + 1) * n1 + c + 1] = I[k][r * n1 + c + 1] + row[k];
      }
    }
    const box = (k, r, c) => I[k][(r + W) * n1 + c + W] - I[k][r * n1 + c + W] - I[k][(r + W) * n1 + c] + I[k][r * n1 + c];
    const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2, cnt = W * W;
    const sum = new Float64Array(TILES * TILES), num = new Float64Array(TILES * TILES);
    for (let r = 0; r < m; r++)
      for (let c = 0; c < m; c++) {
        const ma = box(0, r, c) / cnt, mb = box(1, r, c) / cnt;
        const va = box(2, r, c) / cnt - ma * ma, vb = box(3, r, c) / cnt - mb * mb, cov = box(4, r, c) / cnt - ma * mb;
        const t = Math.floor((r * TILES) / m) * TILES + Math.floor((c * TILES) / m);
        sum[t] += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
        num[t]++;
      }
    const tiles = new Float64Array(TILES * TILES);
    let min = 1;
    for (let t = 0; t < tiles.length; t++) { tiles[t] = sum[t] / num[t]; min = Math.min(min, tiles[t]); }
    return { tiles, min };
  }

  function compareThumbs(ref, cand, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const ssim = o.strict ? regionalSsim(ref.y, cand.y) : null;
    // Luma: match the candidate's global mean/contrast to the reference.
    const a = meanStd(ref.y), b = meanStd(cand.y);
    const k = a.sd / b.sd;
    const cy = new Float64Array(N * N);
    for (let i = 0; i < cy.length; i++) cy[i] = (cand.y[i] - b.m) * k + a.m;
    // Chroma: remove a global shift only.
    const shift = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += y[i] - x[i]; return s / x.length; };
    const dCb = shift(ref.cb, cand.cb), dCr = shift(ref.cr, cand.cr);
    const ccb = Float64Array.from(cand.cb, v => v - dCb), ccr = Float64Array.from(cand.cr, v => v - dCr);

    const luma = new Float64Array(TILES * TILES), chroma = new Float64Array(TILES * TILES);
    const changed = [];
    for (let tr = 0; tr < TILES; tr++)
      for (let tc = 0; tc < TILES; tc++) {
        let sl = 0;
        for (let r = tr * TILE; r < (tr + 1) * TILE; r++)
          for (let c = tc * TILE; c < (tc + 1) * TILE; c++) sl += neighbourDiff(ref.y, cy, N, r, c);
        let sc = 0;
        for (let r = tr * CTILE; r < (tr + 1) * CTILE; r++)
          for (let c = tc * CTILE; c < (tc + 1) * CTILE; c++)
            sc += (neighbourDiff(ref.cb, ccb, NC, r, c) + neighbourDiff(ref.cr, ccr, NC, r, c)) / 2;
        const t = tr * TILES + tc;
        luma[t] = sl / (TILE * TILE);
        chroma[t] = sc / (CTILE * CTILE);
        if (luma[t] > o.tileLuma || chroma[t] > o.tileChroma || (ssim && ssim.tiles[t] < o.ssimMin)) changed.push(t);
      }
    let maxLuma = 0, maxChroma = 0;
    for (let t = 0; t < luma.length; t++) { maxLuma = Math.max(maxLuma, luma[t]); maxChroma = Math.max(maxChroma, chroma[t]); }
    return {
      luma, chroma, changed, maxLuma, maxChroma, ssimMin: ssim ? ssim.min : null,
      changedFraction: changed.length / (TILES * TILES),
      contrastScale: k,
      verdict: changed.length === 0 ? 'MATCH' : changed.length / (TILES * TILES) > o.maxChangedFraction ? 'DIFFERENT' : 'MODIFIED'
    };
  }

  // Lookup keys for the four orientations of a received image.
  function lookupQueries(thumbs) {
    return [0, 90, 180, 270].map(deg => {
      const y = rotateGrid(thumbs.y, N, deg);
      return { deg, phash: phashFromY(y), quads: quadrantPhashes(y) };
    });
  }

  // Is a stored record ({phash, quads}) a candidate for a query?
  function lookupMatch(query, rec, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const distance = hamming(query.phash, rec.phash);
    const quadDistances = query.quads.map((q, i) => hamming(q, rec.quads[i]));
    const closeQuads = quadDistances.filter(d => d <= o.quadMaxDistance).length;
    return { distance, quadDistances, closeQuads, match: distance <= o.lookupMaxDistance || closeQuads >= o.quadMinCount };
  }

  // Try the four orientations of a received image against one signed record.
  function bestOrientation(candThumbs, refPhash) {
    let best = null;
    for (const deg of [0, 90, 180, 270]) {
      const t = rotateThumbs(candThumbs, deg);
      const ph = phashFromY(t.y);
      const d = hamming(ph, refPhash);
      if (!best || d < best.distance) best = { deg, thumbs: t, phash: ph, distance: d };
    }
    return best;
  }

  // ─── TRAILER (the block appended after the JPEG's FF D9) ─────────────────

  const MARK_V1 = '||SECURECAM_START||';
  const MARK_V2 = '||SECURECAM_V2||';
  const V1_RE = /^\|\|SECURECAM_START\|\|SIG:([A-Za-z0-9+/=]+)\|PUB:([A-Za-z0-9+/=]+)\|\|SECURECAM_END\|\|/;
  const V2_RE = /^\|\|SECURECAM_V2\|\|M:([A-Za-z0-9+/=]+)\|S:([A-Za-z0-9+/=]+)\|P:([A-Za-z0-9+/=]+)\|T:([A-Za-z0-9+/=]+)\|\|SECURECAM_END\|\|/;

  function lastIndexOfBytes(hay, needle) {
    outer: for (let i = hay.length - needle.length; i >= 0; i--) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  // Returns null when no SecureCam block exists, otherwise
  // { version, offset, malformed, trailingBytes, sig, pub, manifest?, thumb? }.
  function parseTrailer(bytes) {
    const at = Math.max(lastIndexOfBytes(bytes, asciiBytes(MARK_V1)), lastIndexOfBytes(bytes, asciiBytes(MARK_V2)));
    if (at < 0) return null;
    const text = latin1(bytes.subarray(at));
    let m = V2_RE.exec(text);
    if (m) {
      return {
        version: 2, offset: at, malformed: false, trailingBytes: text.length - m[0].length,
        manifest: b64decode(m[1]), sig: b64decode(m[2]), pub: b64decode(m[3]), thumb: b64decode(m[4])
      };
    }
    m = V1_RE.exec(text);
    if (m) return { version: 1, offset: at, malformed: false, trailingBytes: text.length - m[0].length, sig: b64decode(m[1]), pub: b64decode(m[2]) };
    return { version: 0, offset: at, malformed: true };
  }

  function buildTrailerV2(manifestBytes, rawSig, spki, thumb) {
    return asciiBytes(`||SECURECAM_V2||M:${b64encode(manifestBytes)}|S:${b64encode(rawSig)}|P:${b64encode(spki)}|T:${b64encode(thumb)}||SECURECAM_END||`);
  }

  function parseManifest(manifestBytes) {
    const m = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (m.v !== 2 || !m.fp || m.fp.alg !== FP_ALG) throw new Error('unsupported manifest');
    for (const [k, re] of [['file_sha256', /^[0-9a-f]{64}$/], ['key', /^[0-9a-f]{64}$/]])
      if (!re.test(m[k])) throw new Error(`manifest.${k} is invalid`);
    if (!/^[0-9a-f]{16}$/.test(m.fp.phash) || !/^[0-9a-f]{64}$/.test(m.fp.thumb_sha256)) throw new Error('manifest.fp is invalid');
    return m;
  }

  // ─── CRYPTO (WebCrypto: browser and Node >= 20) ─────────────────────────

  const subtle = () => {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error('WebCrypto is unavailable (open the verifier via file:// or http://localhost)');
    return c.subtle;
  };

  async function sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', bytes)); }
  async function sha256Hex(bytes) { return toHex(await sha256(bytes)); }

  // ECDSA P-256 over SHA-256(data); signature is raw r||s (64 bytes).
  async function verifyEcdsa(spki, rawSig, data) {
    try {
      const key = await subtle().importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, data);
    } catch (e) {
      return false;
    }
  }

  // Checks everything that can be checked offline for a v2 trailer.
  // result.status: AUTHENTIC | TAMPERED | FORGED_BLOCK | INVALID
  async function verifyTrailerV2(fileBytes, tr) {
    const out = { version: 2 };
    let manifest;
    try { manifest = parseManifest(tr.manifest); } catch (e) { return Object.assign(out, { status: 'INVALID', reason: e.message }); }
    out.manifest = manifest;
    out.keyId = await sha256Hex(tr.pub);
    const sigOk = await verifyEcdsa(tr.pub, tr.sig, tr.manifest);
    const keyOk = out.keyId === manifest.key;
    const thumbOk = tr.thumb.length === THUMB_BYTES && (await sha256Hex(tr.thumb)) === manifest.fp.thumb_sha256;
    out.fileSha256 = await sha256Hex(fileBytes.subarray(0, tr.offset));
    out.signatureValid = sigOk && keyOk && thumbOk;
    if (!out.signatureValid) return Object.assign(out, { status: 'FORGED_BLOCK', reason: !sigOk ? 'signature does not verify' : !keyOk ? 'key id mismatch' : 'thumbnail hash mismatch' });
    out.thumbs = splitThumbBytes(tr.thumb);
    out.status = out.fileSha256 === manifest.file_sha256 ? 'AUTHENTIC' : 'TAMPERED';
    return out;
  }

  async function verifyTrailerV1(fileBytes, tr) {
    const ok = await verifyEcdsa(tr.pub, tr.sig, fileBytes.subarray(0, tr.offset));
    return { version: 1, status: ok ? 'AUTHENTIC' : 'TAMPERED', keyId: await sha256Hex(tr.pub), fileSha256: await sha256Hex(fileBytes.subarray(0, tr.offset)) };
  }

  // Verifies one registry record (as returned by the server) independently of
  // the server: the record is only trusted if its signature checks out here.
  async function verifyRegistryRecord(rec) {
    const manifestBytes = b64decode(rec.manifest), sig = b64decode(rec.sig), pub = b64decode(rec.pub), thumb = b64decode(rec.thumb);
    const manifest = parseManifest(manifestBytes);
    const ok = (await verifyEcdsa(pub, sig, manifestBytes)) &&
      (await sha256Hex(pub)) === manifest.key &&
      thumb.length === THUMB_BYTES && (await sha256Hex(thumb)) === manifest.fp.thumb_sha256 &&
      phashFromY(thumb.subarray(0, N * N)) === manifest.fp.phash;
    return { ok, manifest, thumbs: ok ? splitThumbBytes(thumb) : null };
  }

  // ─── SMALL UTILITIES ─────────────────────────────────────────────────────

  function toHex(b) { let s = ''; for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function asciiBytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; }
  function latin1(b) { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; }
  function b64decode(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function b64encode(b) { return btoa(latin1(b)); }

  return {
    FP_ALG, N, NC, THUMB_BYTES, TILES, DEFAULTS, COS,
    thumbnailsFromRGBA, thumbnailsFromSums, rotateGrid, rotateThumbs, phashFromY, quadrantPhashes, thumbBytes, splitThumbBytes,
    hamming, compareThumbs, regionalSsim, bestOrientation, lookupQueries, lookupMatch,
    parseTrailer, buildTrailerV2, parseManifest, verifyTrailerV1, verifyTrailerV2, verifyRegistryRecord,
    sha256, sha256Hex, verifyEcdsa, toHex, b64decode, b64encode, asciiBytes
  };
});
