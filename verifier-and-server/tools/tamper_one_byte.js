// Demo helper: copies a SecureCam photo and changes ONE byte of the image data,
// leaving the signature block intact. The verifier must then say TAMPERED.
//
// Usage: node tools/tamper_one_byte.js <photo.jpg> [output.jpg]
'use strict';
const fs = require('fs');
const SC = require('../securecam-core.js');

const input = process.argv[2];
if (!input) {
  console.log('Usage: node tools/tamper_one_byte.js <photo.jpg> [output.jpg]');
  process.exit(1);
}
const output = process.argv[3] || input.replace(/(\.[^.\\/]+)?$/, '_tampered$1');
const bytes = fs.readFileSync(input);
const tr = SC.parseTrailer(new Uint8Array(bytes));
if (!tr) console.log('Note: this file has no SecureCam block, so the verifier will say UNVERIFIED, not TAMPERED.');
const imageEnd = tr ? tr.offset : bytes.length;
const at = Math.floor(imageEnd * 0.6);
const before = bytes[at];
bytes[at] ^= 0x04; // flip one bit of one byte
fs.writeFileSync(output, bytes);
console.log(`Changed byte ${at.toLocaleString()} of ${imageEnd.toLocaleString()} image bytes ` +
  `(0x${before.toString(16).padStart(2, '0')} -> 0x${bytes[at].toString(16).padStart(2, '0')}); signature block untouched.`);
console.log('Wrote', output);
