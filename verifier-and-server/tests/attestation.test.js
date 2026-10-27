// What the registry reports about a device: the chain of trust and, when attested, the phone model.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('../registry-server/attestation.js');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'attestation.json'), 'utf8'));

function check(name) {
  const chain = FX.cases[name].chain.map(b => Buffer.from(b, 'base64'));
  const leaf = new crypto.X509Certificate(chain[0]);
  return A.verifyAttestation(chain, {
    trustedRootSpkis: new Set(A.rootSpkisFromPems([FX.testRootPem])), revokedSerials: new Set(),
    expectedChallenge: Buffer.from(FX.challenge), packageName: FX.package,
    expectedSpki: leaf.publicKey.export({ type: 'spki', format: 'der' })
  });
}

test('the chain of trust is reported from the root down to the key', () => {
  const r = check('good_strongbox');
  assert.ok(r.ok, r.reasons.join('; '));
  assert.deepStrictEqual(r.details.chain.map(c => c.role), ['root', 'intermediate', 'key']);
  assert.strictEqual(r.details.chain[0].name, 'Test Attestation Root');
  assert.strictEqual(r.details.chain[1].issuer, 'CN=Test Attestation Root');
  assert.strictEqual(r.details.deviceModel, undefined, 'no model unless the key attested it');
});

test('an expired copy of a trusted root is accepted by its key; an expired intermediate is refused', () => {
  // Older phones (e.g. a Realme 8) send Google's original root certificate, whose dates have run out, while the
  // same root key has been re-issued; trust comes from the pinned key.
  const r = check('expired_root_copy');
  assert.ok(r.ok, r.reasons.join('; '));
  assert.ok(r.warnings.some(w => w.includes('expired copy of the Google root')), r.warnings.join('; '));
  assert.ok(r.details.chain[0].validTo, 'validity dates are reported');
  const bad = check('expired_intermediate');
  assert.ok(!bad.ok);
  assert.ok(bad.reasons.some(x => x.includes('outside its validity period')), bad.reasons.join('; '));
});

test('brand and model attested by the secure hardware are reported', () => {
  const r = check('good_strongbox_device_ids');
  assert.ok(r.ok, r.reasons.join('; '));
  assert.strictEqual(r.details.deviceBrand, 'samsung');
  assert.strictEqual(r.details.deviceManufacturer, 'samsung');
  assert.strictEqual(r.details.deviceModel, 'SM-S911B');
  assert.strictEqual(r.details.deviceIdsHardwareEnforced, true);
});
