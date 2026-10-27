// Minimal DER reader — just enough to walk X.509 certificates and the Android
// key attestation extension (KeyDescription). No external dependencies.
'use strict';

class DerError extends Error {}

// Reads one TLV at `off`. Returns { cls, constructed, tag, start, end, next }
// where [start, end) is the value.
function readTLV(buf, off) {
  if (off + 2 > buf.length) throw new DerError('truncated TLV');
  const b0 = buf[off];
  const cls = b0 >> 6;
  const constructed = (b0 & 0x20) !== 0;
  let tag = b0 & 0x1f;
  let p = off + 1;
  if (tag === 0x1f) { // high tag number, base-128
    tag = 0;
    let b;
    do {
      if (p >= buf.length) throw new DerError('truncated tag');
      b = buf[p++];
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (p >= buf.length) throw new DerError('truncated length');
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError('unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const end = p + len;
  if (end > buf.length) throw new DerError('length exceeds buffer');
  return { cls, constructed, tag, start: p, end, next: end, headerStart: off };
}

function children(buf, tlv) {
  const out = [];
  let p = tlv.start;
  while (p < tlv.end) {
    const c = readTLV(buf, p);
    out.push(c);
    p = c.next;
  }
  return out;
}

function intValue(buf, tlv) {
  let v = 0n;
  for (let i = tlv.start; i < tlv.end; i++) v = (v << 8n) | BigInt(buf[i]);
  if (tlv.end > tlv.start && buf[tlv.start] & 0x80) v -= 1n << BigInt(8 * (tlv.end - tlv.start));
  return v;
}

const bytes = (buf, tlv) => buf.subarray(tlv.start, tlv.end);
const hex = b => Buffer.from(b).toString('hex');

// Returns the raw extnValue (OCTET STRING contents) of `oidHex` in a certificate, or null.
function findExtension(certDer, oidHex) {
  const cert = readTLV(certDer, 0);
  const tbs = children(certDer, cert)[0];
  for (const f of children(certDer, tbs)) {
    if (f.cls === 2 && f.tag === 3) { // [3] extensions
      const exts = children(certDer, f)[0];
      for (const e of children(certDer, exts)) {
        const parts = children(certDer, e);
        if (hex(bytes(certDer, parts[0])) === oidHex) return bytes(certDer, parts[parts.length - 1]);
      }
    }
  }
  return null;
}

module.exports = { DerError, readTLV, children, intValue, bytes, hex, findExtension };
