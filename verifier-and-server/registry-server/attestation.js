// Android Key Attestation verification (hardware proof that the signing key
// lives in a TEE/StrongBox of a genuine, locked, verified-boot device).
// Reference: https://developer.android.com/privacy-and-security/security-key-attestation
'use strict';
const crypto = require('crypto');
const { readTLV, children, intValue, bytes, hex, findExtension } = require('./der');

const KEY_DESCRIPTION_OID = '2b06010401d679020111'; // 1.3.6.1.4.1.11129.2.1.17
const SECURITY = { 0: 'Software', 1: 'TrustedEnvironment', 2: 'StrongBox' };
const BOOT = { 0: 'Verified', 1: 'SelfSigned', 2: 'Unverified', 3: 'Failed' };

const text = (buf, tlv) => Buffer.from(bytes(buf, tlv)).toString('utf8');

// Short description of a certificate name for display: organisation and common name / title.
function nameOf(dn) {
  const f = {};
  for (const line of String(dn).split('\n')) { const i = line.indexOf('='); if (i > 0) f[line.slice(0, i)] = line.slice(i + 1); }
  return { org: f.O || '', name: f.CN || f.title || f.serialNumber || '', text: String(dn).replace(/\n/g, ', ') };
}

function parseSetOfInts(buf, tlv) { return children(buf, tlv).map(c => Number(intValue(buf, c))); }

function parseAppId(buf) {
  const seq = readTLV(buf, 0);
  const [pkgSet, sigSet] = children(buf, seq);
  const packages = children(buf, pkgSet).map(p => {
    const [name, version] = children(buf, p);
    return { name: Buffer.from(bytes(buf, name)).toString('utf8'), version: Number(intValue(buf, version)) };
  });
  const signatureDigests = sigSet ? children(buf, sigSet).map(s => hex(bytes(buf, s))) : [];
  return { packages, signatureDigests };
}

function parseAuthList(buf, seq) {
  const out = {};
  for (const item of children(buf, seq)) {
    const inner = children(buf, item)[0];
    if (!inner) continue;
    switch (item.tag) {
      case 1: out.purpose = parseSetOfInts(buf, inner); break;
      case 2: out.algorithm = Number(intValue(buf, inner)); break;
      case 3: out.keySize = Number(intValue(buf, inner)); break;
      case 5: out.digest = parseSetOfInts(buf, inner); break;
      case 10: out.ecCurve = Number(intValue(buf, inner)); break;
      case 702: out.origin = Number(intValue(buf, inner)); break;
      case 704: {
        const f = children(buf, inner);
        out.rootOfTrust = {
          verifiedBootKey: hex(bytes(buf, f[0])),
          deviceLocked: buf[f[1].start] !== 0,
          verifiedBootState: Number(intValue(buf, f[2]))
        };
        break;
      }
      case 705: out.osVersion = Number(intValue(buf, inner)); break;
      case 706: out.osPatchLevel = Number(intValue(buf, inner)); break;
      case 709: out.attestationApplicationId = parseAppId(Buffer.from(bytes(buf, inner))); break;
      // Device identity, present only when the app asked for it (setDevicePropertiesAttestationIncluded).
      case 710: out.idBrand = text(buf, inner); break;
      case 711: out.idDevice = text(buf, inner); break;
      case 712: out.idProduct = text(buf, inner); break;
      case 716: out.idManufacturer = text(buf, inner); break;
      case 717: out.idModel = text(buf, inner); break;
      default: break;
    }
  }
  return out;
}

function parseKeyDescription(ext) {
  const buf = Buffer.from(ext);
  const f = children(buf, readTLV(buf, 0));
  if (f.length < 8) throw new Error('KeyDescription has too few fields');
  return {
    attestationVersion: Number(intValue(buf, f[0])),
    attestationSecurityLevel: Number(intValue(buf, f[1])),
    keyMintVersion: Number(intValue(buf, f[2])),
    keyMintSecurityLevel: Number(intValue(buf, f[3])),
    challenge: Buffer.from(bytes(buf, f[4])),
    softwareEnforced: parseAuthList(buf, f[6]),
    hardwareEnforced: parseAuthList(buf, f[7])
  };
}

const normSerial = s => s.toLowerCase().replace(/^0+/, '');

/**
 * @param {Buffer[]} chainDer  leaf first, root last
 * @param {object} opts {
 *   trustedRootSpkis: Set<string>  hex SPKI DER of trusted roots,
 *   revokedSerials: Set<string>|null  normalised hex serials (null = list unavailable),
 *   expectedChallenge: Buffer, packageName: string, expectedSpki: Buffer,
 *   signatureDigests?: Set<string>  optional pin of the app signing certificate digest(s),
 *   now?: Date }
 * @returns {{ok: boolean, reasons: string[], warnings: string[], details: object}}
 */
function verifyAttestation(chainDer, opts) {
  const reasons = [], warnings = [];
  const details = { chainLength: chainDer.length };
  const fail = r => { reasons.push(r); return { ok: false, reasons, warnings, details }; };
  if (!Array.isArray(chainDer) || chainDer.length < 2) return fail('attestation chain missing or too short');

  let certs;
  try { certs = chainDer.map(d => new crypto.X509Certificate(d)); } catch (e) { return fail('attestation chain contains an unparsable certificate'); }

  for (let i = 0; i < certs.length - 1; i++)
    if (!certs[i].verify(certs[i + 1].publicKey)) reasons.push(`certificate ${i} is not signed by certificate ${i + 1}`);
  const root = certs[certs.length - 1];
  const rootSpki = root.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  details.root = root.subject.replace(/\n/g, ', ');
  if (!opts.trustedRootSpkis.has(rootSpki)) reasons.push('chain does not end in a trusted Google hardware attestation root');
  else if (!root.verify(root.publicKey)) reasons.push('root certificate is not self-signed');

  // Who vouches for whom, from the root down to the key (shown by the verifier).
  details.chain = certs.map((c, i) => Object.assign(nameOf(c.subject), {
    issuer: nameOf(c.issuer).text, role: i === 0 ? 'key' : i === certs.length - 1 ? 'root' : 'intermediate'
  })).reverse();

  // Validity of the intermediates. The root is trusted by its key (it matched a pinned Google root above), not by the
  // dates on the copy the phone sends: older devices carry Google's original root certificate, whose validity has
  // ended, while Google re-issued the same root key with a later expiry.
  const now = opts.now || new Date();
  details.chain.forEach((c, k) => { const cert = certs[certs.length - 1 - k]; c.validFrom = cert.validFrom; c.validTo = cert.validTo; });
  for (let i = 1; i < certs.length - 1; i++)
    if (new Date(certs[i].validFrom) > now || new Date(certs[i].validTo) < now) reasons.push(`certificate ${i} is outside its validity period`);
  if (new Date(root.validTo) < now && opts.trustedRootSpkis.has(rootSpki))
    warnings.push(`the device sent an expired copy of the Google root (valid to ${root.validTo}); trusted by its key`);

  if (opts.revokedSerials) {
    details.revocationChecked = true;
    certs.forEach((c, i) => { if (opts.revokedSerials.has(normSerial(c.serialNumber))) reasons.push(`certificate ${i} is revoked by Google`); });
  } else {
    details.revocationChecked = false;
    warnings.push('revocation list unavailable; revocation not checked');
  }

  const leafSpki = certs[0].publicKey.export({ type: 'spki', format: 'der' });
  if (!opts.expectedSpki || !leafSpki.equals(Buffer.from(opts.expectedSpki))) reasons.push('attested key is not the key that signed the photo');

  const ext = findExtension(chainDer[0], KEY_DESCRIPTION_OID);
  if (!ext) return fail('leaf certificate has no key attestation extension (key generated without an attestation challenge?)');
  let kd;
  try { kd = parseKeyDescription(ext); } catch (e) { return fail('key attestation extension is malformed: ' + e.message); }

  const hw = kd.hardwareEnforced, sw = kd.softwareEnforced;
  Object.assign(details, {
    attestationVersion: kd.attestationVersion,
    securityLevel: SECURITY[kd.attestationSecurityLevel] || String(kd.attestationSecurityLevel),
    keyMintSecurityLevel: SECURITY[kd.keyMintSecurityLevel] || String(kd.keyMintSecurityLevel),
    osVersion: hw.osVersion, osPatchLevel: hw.osPatchLevel
  });
  const brand = hw.idBrand || sw.idBrand, model = hw.idModel || sw.idModel;
  if (brand || model) Object.assign(details, {
    deviceBrand: brand, deviceModel: model, deviceManufacturer: hw.idManufacturer || sw.idManufacturer,
    deviceProduct: hw.idProduct || sw.idProduct, deviceIdsHardwareEnforced: !!(hw.idBrand || hw.idModel)
  });
  if (!kd.challenge.equals(Buffer.from(opts.expectedChallenge))) reasons.push('attestation challenge does not match');
  if (kd.attestationSecurityLevel < 1 || kd.keyMintSecurityLevel < 1) reasons.push(`key is not hardware-backed (security level ${details.securityLevel})`);
  if (hw.origin !== undefined && hw.origin !== 0) reasons.push('key was imported, not generated inside secure hardware');
  if (hw.purpose && !hw.purpose.includes(2)) reasons.push('key is not restricted to signing');

  const rot = hw.rootOfTrust;
  if (!rot) reasons.push('attestation has no hardware root of trust');
  else {
    details.verifiedBootState = BOOT[rot.verifiedBootState] || String(rot.verifiedBootState);
    details.deviceLocked = rot.deviceLocked;
    if (rot.verifiedBootState !== 0) reasons.push(`verified boot state is ${details.verifiedBootState} (device may be rooted or running custom firmware)`);
    if (!rot.deviceLocked) reasons.push('bootloader is unlocked');
  }

  const appId = sw.attestationApplicationId || hw.attestationApplicationId;
  if (!appId) reasons.push('attestation has no application id');
  else {
    details.packages = appId.packages.map(p => p.name);
    details.signatureDigests = appId.signatureDigests;
    if (!details.packages.includes(opts.packageName)) reasons.push(`key belongs to ${details.packages.join(', ') || 'no package'}, not ${opts.packageName}`);
    if (opts.signatureDigests && opts.signatureDigests.size && !appId.signatureDigests.some(d => opts.signatureDigests.has(d)))
      reasons.push('app signing certificate is not the pinned SecureCam certificate');
  }

  return { ok: reasons.length === 0, reasons, warnings, details };
}

// Trusted roots come as PEM strings (the format of https://android.googleapis.com/attestation/root).
function rootSpkisFromPems(pems) {
  const set = new Set();
  for (const pem of pems) set.add(new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }).toString('hex'));
  return set;
}

function revokedFromStatusJson(json) {
  const set = new Set();
  for (const k of Object.keys((json && json.entries) || {})) set.add(normSerial(k));
  return set;
}

module.exports = { verifyAttestation, parseKeyDescription, rootSpkisFromPems, revokedFromStatusJson, KEY_DESCRIPTION_OID };
