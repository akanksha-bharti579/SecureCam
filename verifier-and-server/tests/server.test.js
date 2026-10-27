'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SC = require('../securecam-core.js');
const { createServer } = require('../registry-server/server.js');
const { synth } = require('./synth.js');
const H = require('./helpers.js');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'attestation.json'), 'utf8'));

async function startServer(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'securecam-'));
  const rootsFile = path.join(dir, 'roots.json');
  const statusFile = path.join(dir, 'status.json');
  fs.writeFileSync(rootsFile, JSON.stringify([FX.testRootPem]));
  fs.writeFileSync(statusFile, JSON.stringify(FX.revocationStatus));
  const opts = Object.assign({ data: path.join(dir, 'data'), roots: rootsFile, revokedFile: statusFile, log: () => {} }, extra || {});
  const server = createServer(opts);
  await server.init();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const get = async p => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
  return { server, base, post, get, dir, opts, close: () => new Promise(r => server.close(r)) };
}

const attested = name => ({ key: H.keyFromPem(FX.cases[name].leafKeyPkcs8Pem), chain: FX.cases[name].chain });

test('registry end to end', async t => {
  const S = await startServer();
  t.after(() => S.close());
  const img = synth(1200, 900, 5);
  const { key, chain } = attested('good_strongbox');
  const cap = await H.capture({ key, chain, rgba: img, w: 1200, h: 900 });

  await t.test('serves the verifier page and core script', async () => {
    const page = await S.get('/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /SecureCam/);
    assert.strictEqual((await S.get('/securecam-core.js')).status, 200);
    assert.strictEqual((await S.get('/../registry-server/server.js')).status, 404);
  });

  let rid;
  await t.test('accepts a record from an attested StrongBox key', async () => {
    const r = await S.post('/api/records', cap.payload);
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.key.attested, true);
    assert.strictEqual(r.json.key.details.securityLevel, 'StrongBox');
    rid = r.json.rid;
  });

  await t.test('duplicate upload is idempotent', async () => {
    const r = await S.post('/api/records', cap.payload);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.duplicate, true);
  });

  await t.test('later records from the same key need no chain', async () => {
    const cap2 = await H.capture({ key, rgba: synth(800, 600, 6), w: 800, h: 600 });
    assert.strictEqual((await S.post('/api/records', cap2.payload)).status, 201);
  });

  await t.test('record and key can be fetched', async () => {
    const r = await S.get('/api/records/' + rid);
    assert.strictEqual(r.status, 200);
    const rec = JSON.parse(r.text);
    const v = await SC.verifyRegistryRecord(rec);
    assert.ok(v.ok);
    const k = JSON.parse((await S.get('/api/keys/' + (await SC.sha256Hex(cap.spki)))).text);
    assert.strictEqual(k.attested, true);
  });

  await t.test('lookup finds the recompressed copy, and the copy MATCHES region by region', async () => {
    const d = H.degrade(img, 1200, 900, 3, 3);
    const thumbs = SC.thumbnailsFromRGBA(d.rgba, d.w, d.h);
    const r = await S.post('/api/lookup', { queries: SC.lookupQueries(thumbs) });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.candidates.length >= 1);
    const c = r.json.candidates[0];
    assert.strictEqual(c.record.rid, rid);
    assert.strictEqual(c.query, 0);
    const v = await SC.verifyRegistryRecord(c.record);
    assert.ok(v.ok);
    assert.strictEqual(SC.compareThumbs(v.thumbs, thumbs).verdict, 'MATCH');
  });

  await t.test('lookup of an edited copy returns the original and reports MODIFIED', async () => {
    const edited = H.paintRect(img, 1200, 100, 100, 260, 220, [10, 240, 30]);
    const d = H.degrade(edited, 1200, 900, 3, 3);
    const thumbs = SC.thumbnailsFromRGBA(d.rgba, d.w, d.h);
    const r = await S.post('/api/lookup', { queries: SC.lookupQueries(thumbs) });
    assert.ok(r.json.candidates.length >= 1, 'edited copy should still find its record (quadrant lookup)');
    assert.strictEqual(r.json.candidates[0].record.rid, rid);
    const v = await SC.verifyRegistryRecord(r.json.candidates[0].record);
    assert.strictEqual(SC.compareThumbs(v.thumbs, thumbs).verdict, 'MODIFIED');
  });

  await t.test('unrelated photo has no candidates', async () => {
    const other = SC.thumbnailsFromRGBA(synth(900, 900, 777), 900, 900);
    const r = await S.post('/api/lookup', { queries: SC.lookupQueries(other) });
    assert.strictEqual(r.json.candidates.length, 0);
  });

  await t.test('rejects a manifest that was changed after signing', async () => {
    const bad = Object.assign({}, cap.payload, { manifest: SC.b64encode(new TextEncoder().encode(new TextDecoder().decode(cap.manifest).replace('10:15', '11:15'))) });
    const r = await S.post('/api/records', bad);
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /signature/);
  });

  await t.test('rejects a thumbnail that is not the signed one', async () => {
    const other = SC.thumbBytes(SC.thumbnailsFromRGBA(synth(400, 300, 8), 400, 300));
    const r = await S.post('/api/records', Object.assign({}, cap.payload, { thumb: SC.b64encode(other) }));
    assert.strictEqual(r.status, 400);
  });

  await t.test('rejects a signed manifest whose pHash does not match its thumbnail', async () => {
    const lie = await H.capture({ key, rgba: synth(800, 600, 9), w: 800, h: 600, overrides: { phash: '0123456789abcdef' } });
    const r = await S.post('/api/records', lie.payload);
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /pHash/);
  });

  await t.test('rejects oversized and malformed bodies', async () => {
    assert.strictEqual((await S.post('/api/records', '{"x":"' + 'a'.repeat(300 * 1024) + '"}')).status, 413);
    assert.strictEqual((await S.post('/api/records', 'not json')).status, 400);
    assert.strictEqual((await S.post('/api/lookup', { queries: [{ phash: 'zz', quads: [] }] })).status, 400);
    assert.strictEqual((await S.post('/api/lookup', { phashes: ['0123456789abcdef'] })).status, 400);
  });

  await t.test('records survive a restart', async () => {
    const again = createServer(Object.assign({}, S.opts));
    await again.init();
    await new Promise(r => again.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${again.address().port}/api/records/${rid}`);
    assert.strictEqual(r.status, 200);
    await new Promise(r2 => again.close(r2));
  });
});

test('attestation is enforced for every failure mode', async t => {
  const S = await startServer();
  t.after(() => S.close());
  const expected = {
    wrong_challenge: /challenge/, software_key: /not hardware-backed/, unverified_boot: /verified boot/,
    unlocked_bootloader: /unlocked/, wrong_package: /com\.evil\.fakecam/, imported_key: /imported/,
    untrusted_root: /trusted Google/, broken_chain: /not signed by/, revoked_intermediate: /revoked/, no_extension: /no key attestation extension/
  };
  for (const [name, re] of Object.entries(expected)) {
    await t.test(name, async () => {
      const { key, chain } = attested(name);
      const cap = await H.capture({ key, chain, rgba: synth(640, 480, 40), w: 640, h: 480 });
      const r = await S.post('/api/records', cap.payload);
      assert.strictEqual(r.status, 403, JSON.stringify(r.json));
      assert.ok(r.json.reasons.some(x => re.test(x)), r.json.reasons.join('; '));
    });
  }
  await t.test('a key with no chain at all is refused', async () => {
    const cap = await H.capture({ key: H.newKey(), rgba: synth(640, 480, 41), w: 640, h: 480 });
    assert.strictEqual((await S.post('/api/records', cap.payload)).status, 403);
  });
  await t.test('TEE-backed keys are accepted', async () => {
    const { key, chain } = attested('good_tee');
    const cap = await H.capture({ key, chain, rgba: synth(640, 480, 42), w: 640, h: 480 });
    const r = await S.post('/api/records', cap.payload);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.key.details.securityLevel, 'TrustedEnvironment');
  });
});

test('--allow-unattested accepts but flags unverified devices', async t => {
  const S = await startServer({ allowUnattested: true });
  t.after(() => S.close());
  const cap = await H.capture({ key: H.newKey(), rgba: synth(640, 480, 50), w: 640, h: 480 });
  const r = await S.post('/api/records', cap.payload);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.key.attested, false);
  const h = JSON.parse((await S.get('/api/health')).text);
  assert.strictEqual(h.allowUnattested, true);
});
