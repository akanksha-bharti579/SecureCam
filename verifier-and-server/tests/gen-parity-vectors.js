// Writes the JS reference fingerprints that the Android unit test must reproduce.
// Usage: node tests/gen-parity-vectors.js [output.json]
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../securecam-core.js');
const { synth } = require('./synth.js');

const CASES = [
  { w: 257, h: 193, seed: 1, rot: 0 },
  { w: 640, h: 480, seed: 42, rot: 90 },
  { w: 130, h: 901, seed: 7, rot: 270 },
  { w: 128, h: 128, seed: 99, rot: 180 },
  { w: 1000, h: 750, seed: 2024, rot: 0 },
  { w: 333, h: 1024, seed: -123456789, rot: 90 },
];

async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'SecureCam', 'app', 'src', 'test', 'resources', 'scfp1_vectors.json'));
  const cosSum = SC.COS.reduce((a, b) => a + b, 0);
  const vectors = [];
  for (const c of CASES) {
    const t = SC.rotateThumbs(SC.thumbnailsFromRGBA(synth(c.w, c.h, c.seed), c.w, c.h), c.rot);
    vectors.push(Object.assign({}, c, { phash: SC.phashFromY(t.y), thumbSha256: await SC.sha256Hex(SC.thumbBytes(t)) }));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ alg: SC.FP_ALG, cosSum, vectors }, null, 2) + '\n');
  console.log(`wrote ${vectors.length} vectors to ${out}`);
}

main();
