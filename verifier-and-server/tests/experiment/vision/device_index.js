// Checks every SecureCam original pulled from the phone and prepares them for make_vision.py.
// For each file: verify the signed block byte for byte, confirm the registry holds the
// same record under an attested key, and save the on-device fingerprint thumbnail (T).
// Usage: node device_index.js <folder with SecureCam_*.jpg> <registry data dir>
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../../../securecam-core.js');

const DIR = process.argv[2], DATA = process.argv[3];
const records = fs.readFileSync(path.join(DATA, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const keys = JSON.parse(fs.readFileSync(path.join(DATA, 'keys.json'), 'utf8'));
const b64 = b => Buffer.from(b).toString('base64');

(async () => {
  const index = [];
  const count = { files: 0, authentic: 0, registered: 0, attested: 0, strongbox: 0 };
  for (const f of fs.readdirSync(DIR).filter(x => /^SecureCam_\d+\.jpg$/.test(x)).sort()) {
    count.files++;
    const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, f)));
    const tr = SC.parseTrailer(bytes);
    if (!tr || tr.malformed || tr.version !== 2) { console.log(f, 'no v2 block - skipped'); continue; }
    const r = await SC.verifyTrailerV2(bytes, tr);
    if (r.status !== 'AUTHENTIC') { console.log(f, r.status, r.reason || ''); continue; }
    count.authentic++;
    const rec = records.find(x => x.manifest === b64(tr.manifest) && x.sig === b64(tr.sig));
    if (rec) count.registered++;
    const key = keys[r.keyId];
    if (rec && key && key.ok) { count.attested++; if (key.details.securityLevel === 'StrongBox') count.strongbox++; } else continue;
    const id = 'S23_' + f.match(/(\d+)/)[1];
    fs.writeFileSync(path.join(DIR, id + '_T.bin'), tr.thumb);
    index.push({ id, device: 'S23', model: 'Samsung_GalaxyS23', files: { nat: f }, trailerThumb: id + '_T.bin', captured: r.manifest.captured });
  }
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(count, '-> index.json with', index.length, 'photos');
})();
