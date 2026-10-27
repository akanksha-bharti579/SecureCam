// Verifies files produced by the Kotlin code (ProvenanceTest.writesInteropSampleForJavaScript)
// with the JavaScript verifier and the registry server.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SC = require('../securecam-core.js');
const { createServer } = require('../registry-server/server.js');

const DIR = path.join(__dirname, '..', '..', 'SecureCam', 'app', 'build', 'interop');
const SAMPLE = path.join(DIR, 'kotlin_v2_sample.bin');
const skip = !fs.existsSync(SAMPLE) && 'run the Android unit tests first (gradlew :app:testDebugUnitTest)';

test('a file signed by the Kotlin code verifies in the JavaScript verifier', { skip }, async () => {
  const file = new Uint8Array(fs.readFileSync(SAMPLE));
  const tr = SC.parseTrailer(file);
  assert.strictEqual(tr.version, 2);
  const r = await SC.verifyTrailerV2(file, tr);
  assert.strictEqual(r.status, 'AUTHENTIC', r.reason);
  file[100] ^= 1;
  assert.strictEqual((await SC.verifyTrailerV2(file, SC.parseTrailer(file))).status, 'TAMPERED');
});

test('the Kotlin registry payload is accepted by the server (unattested mode)', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'securecam-kt-'));
  const roots = path.join(dir, 'roots.json');
  fs.writeFileSync(roots, fs.readFileSync(path.join(__dirname, '..', 'registry-server', 'google-roots.json')));
  const server = createServer({ data: path.join(dir, 'data'), roots, allowUnattested: true, log: () => {} });
  await server.init();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const body = fs.readFileSync(path.join(DIR, 'kotlin_v2_registry_payload.json'), 'utf8');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const json = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(json));
    assert.strictEqual(json.key.attested, false); // a JVM key cannot be hardware-attested
  } finally {
    await new Promise(r => server.close(r));
  }
});
