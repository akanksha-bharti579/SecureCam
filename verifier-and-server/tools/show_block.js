// Demo helper: prints what is inside a SecureCam photo's signature block and checks it.
// Usage: node tools/show_block.js <photo.jpg>
'use strict';
const fs = require('fs');
const SC = require('../securecam-core.js');

(async () => {
  const file = process.argv[2];
  if (!file) { console.log('Usage: node tools/show_block.js <photo.jpg>'); process.exit(1); }
  const bytes = new Uint8Array(fs.readFileSync(file));
  const tr = SC.parseTrailer(bytes);
  if (!tr) { console.log('No SecureCam block in this file (e.g. it was re-encoded by WhatsApp) -> use the verifier/registry.'); return; }
  if (tr.malformed) { console.log('A SecureCam block is present but damaged.'); return; }
  console.log(`File size          : ${bytes.length.toLocaleString()} bytes`);
  console.log(`JPEG image data    : ${tr.offset.toLocaleString()} bytes (ends with FF D9)`);
  console.log(`SecureCam block    : ${(bytes.length - tr.offset).toLocaleString()} bytes, format v${tr.version}`);
  if (tr.version === 1) {
    const r = await SC.verifyTrailerV1(bytes, tr);
    console.log(`Result             : ${r.status} (v1 has no manifest or device proof)`);
    return;
  }
  const r = await SC.verifyTrailerV2(bytes, tr);
  console.log('\nParts of the block:');
  console.log(`  M (manifest)     : ${tr.manifest.length} bytes of JSON, signed`);
  console.log(`  S (signature)    : ${tr.sig.length} bytes, ECDSA P-256 raw r||s`);
  console.log(`  P (public key)   : ${tr.pub.length} bytes, X.509 SubjectPublicKeyInfo`);
  console.log(`  T (thumbnail)    : ${tr.thumb.length} bytes = 128x128 grey + 2 x 32x32 colour`);
  console.log('\nManifest:');
  console.log(JSON.stringify(JSON.parse(new TextDecoder().decode(tr.manifest)), null, 2));
  console.log(`\nSHA-256 of image data now : ${r.fileSha256}`);
  console.log(`Signature over manifest   : ${r.signatureValid ? 'VALID' : 'INVALID'}`);
  console.log(`Result (offline check)    : ${r.status}${r.reason ? ' - ' + r.reason : ''}`);
  console.log('Device genuineness needs the registry: open the verifier page.');
})();
