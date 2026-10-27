// Signs the e2e originals exactly like the Android app (v2 trailer, NONEwithECDSA-equivalent
// signature over the manifest), registers them with a running registry, and writes the
// browser test files. Usage: node sign_and_register.js <e2e_dir> <registry_url>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('../../securecam-core.js');
const H = require('../helpers.js');

const DIR = process.argv[2];
const REG = process.argv[3] || 'http://localhost:8787';
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'attestation.json'), 'utf8'));
const read = f => new Uint8Array(fs.readFileSync(path.join(DIR, f)));
const write = (f, b) => fs.writeFileSync(path.join(DIR, f), b);

async function sign(key, fileBytes, thumb, w, h) {
  const spki = H.spkiOf(key);
  const y = thumb.subarray(0, SC.N * SC.N);
  const manifest = new TextEncoder().encode(H.manifestJson({
    fileSha256: await SC.sha256Hex(fileBytes), phash: SC.phashFromY(y), thumbSha256: await SC.sha256Hex(thumb),
    w, h, keyId: await SC.sha256Hex(spki), captured: new Date().toISOString()
  }));
  const sig = new Uint8Array(crypto.sign('sha256', manifest, { key, dsaEncoding: 'ieee-p1363' }));
  const trailer = SC.buildTrailerV2(manifest, sig, spki, thumb);
  return { file: Buffer.concat([Buffer.from(fileBytes), Buffer.from(trailer)]), manifest, sig, spki };
}

async function main() {
  const job = JSON.parse(fs.readFileSync(path.join(DIR, 'job.json'), 'utf8'));
  const phoneKey = H.keyFromPem(FX.cases.good_strongbox.leafKeyPkcs8Pem);
  for (const o of job.originals) {
    const jpeg = read(o.jpeg), thumb = read(o.thumb);
    const s = await sign(phoneKey, jpeg, thumb, o.w, o.h);
    write(o.label === 'landscape' ? 'A_original_signed.jpg' : 'A2_portrait_original_signed.jpg', s.file);
    const res = await fetch(REG + '/api/records', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: SC.b64encode(s.manifest), sig: SC.b64encode(s.sig), pub: SC.b64encode(s.spki), thumb: SC.b64encode(thumb), chain: FX.cases.good_strongbox.chain })
    });
    console.log(`registered ${o.label}: HTTP ${res.status}`, JSON.stringify(await res.json()).slice(0, 160));
    if (o.label === 'landscape') {
      const t = Buffer.from(s.file);
      const at = Math.floor(jpeg.length * 0.55);
      t[at] ^= 0x10; // one byte inside the image data; the signature block is left intact
      write('B_tampered_one_byte.jpg', t);
    }
  }
  // Signed with a key that was never attested/registered (e.g. made on a laptop).
  const rogue = H.newKey();
  const u = read('unregistered_camera.jpg');
  const uThumb = read('landscape.thumb'); // any valid thumbnail; the exact check is what matters here
  write('H_signed_by_unregistered_key.jpg', (await sign(rogue, u, uThumb, 4000, 3000)).file);
  // Legacy v1 file (Review-2 app format).
  const v1 = read('v1_camera.jpg');
  const v1sig = crypto.sign('sha256', v1, { key: rogue, dsaEncoding: 'ieee-p1363' });
  write('I_legacy_v1_signed.jpg', Buffer.concat([Buffer.from(v1), Buffer.from(`||SECURECAM_START||SIG:${v1sig.toString('base64')}|PUB:${Buffer.from(H.spkiOf(rogue)).toString('base64')}||SECURECAM_END||`, 'ascii')]));
  console.log('files ready in', DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
