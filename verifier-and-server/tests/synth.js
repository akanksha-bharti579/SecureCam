// Deterministic synthetic image generator. The Kotlin twin lives in
// SecureCam/app/src/test/java/com/example/securecam/ProvenanceTest.kt (synth()).
'use strict';

function synth(w, h, seed) {
  let x = seed | 0;
  const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x; };
  const rgba = new Uint8Array(w * h * 4);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      rgba[i] = Math.floor((px * 255) / (w - 1));
      rgba[i + 1] = Math.floor((py * 255) / (h - 1));
      rgba[i + 2] = Math.floor(((px + py) * 255) / (w + h - 2));
      rgba[i + 3] = 255;
    }
  for (let k = 0; k < 12; k++) {
    const rx = (next() >>> 0) % w, ry = (next() >>> 0) % h;
    const rw = 1 + ((next() >>> 0) % Math.floor(w / 3)), rh = 1 + ((next() >>> 0) % Math.floor(h / 3));
    const col = next();
    for (let py = ry; py < Math.min(h, ry + rh); py++)
      for (let px = rx; px < Math.min(w, rx + rw); px++) {
        const i = (py * w + px) * 4;
        rgba[i] = (col >>> 16) & 255; rgba[i + 1] = (col >>> 8) & 255; rgba[i + 2] = col & 255;
      }
  }
  const cl = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let p = 0; p < w * h; p++) {
    const n = next(), i = p * 4;
    rgba[i] = cl(rgba[i] + (n & 15) - 8);
    rgba[i + 1] = cl(rgba[i + 1] + ((n >>> 4) & 15) - 8);
    rgba[i + 2] = cl(rgba[i + 2] + ((n >>> 8) & 15) - 8);
  }
  return rgba;
}

module.exports = { synth };
