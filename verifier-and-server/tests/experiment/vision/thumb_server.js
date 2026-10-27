// Fingerprint helper for make_vision.py: computes scfp1 thumbnails with the real
// securecam-core.js code. Protocol on stdin: uint32le width, uint32le height, then
// width*height*4 RGBA bytes; reply on stdout: 18432 thumbnail bytes. Repeats until EOF.
'use strict';
const SC = require('../../../securecam-core.js');

let chunks = [], have = 0;
function take(nBytes) {
  const buf = Buffer.concat(chunks, have);
  chunks = [buf.subarray(nBytes)];
  have -= nBytes;
  return buf.subarray(0, nBytes);
}
let need = null; // {w, h} once the header is read
process.stdin.on('data', c => {
  chunks.push(c); have += c.length;
  for (;;) {
    if (!need) {
      if (have < 8) return;
      const h = take(8);
      need = { w: h.readUInt32LE(0), h: h.readUInt32LE(4) };
    }
    const size = need.w * need.h * 4;
    if (have < size) return;
    const rgba = take(size);
    process.stdout.write(Buffer.from(SC.thumbBytes(SC.thumbnailsFromRGBA(rgba, need.w, need.h))));
    need = null;
  }
});
