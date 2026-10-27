#!/usr/bin/env node
// SecureCam registry server — stores signed capture records so a photo can be
// verified even after WhatsApp/Instagram/etc. have re-encoded it and removed
// the embedded signature block. Zero dependencies (Node >= 20).
//
//   node registry-server/server.js [--port 8787] [--data ./registry-server/data]
//                                  [--allow-unattested] [--roots file.json]
//
// It also serves the verifier (index.html) at http://localhost:<port>/.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const SC = require('../securecam-core.js');
const { verifyAttestation, rootSpkisFromPems, revokedFromStatusJson } = require('./attestation');

const ROOT_URL = 'https://android.googleapis.com/attestation/root';
const STATUS_URL = 'https://android.googleapis.com/attestation/status';
const WEB_DIR = path.join(__dirname, '..');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/securecam-core.js': 'securecam-core.js' };
const MAX_BODY = 256 * 1024;

function parseArgs(argv) {
  const a = { port: 8787, data: path.join(__dirname, 'data'), allowUnattested: false, roots: null, offline: false, host: '0.0.0.0', signatureDigests: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = +argv[++i];
    // Pin the app's signing certificate (SHA-256 hex, shown in /api/keys/<id> details) so a
    // re-packaged app with the same package name is refused. Repeatable.
    else if (k === '--app-signature') a.signatureDigests.push(argv[++i]);
    else if (k === '--data') a.data = argv[++i];
    else if (k === '--roots') a.roots = argv[++i];
    else if (k === '--host') a.host = argv[++i];
    else if (k === '--allow-unattested') a.allowUnattested = true;
    else if (k === '--offline') a.offline = true;
    else throw new Error('unknown option ' + k);
  }
  return a;
}

async function fetchJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Loads trust anchors: Google's live list when reachable, otherwise the cached copy.
async function loadTrust(opts, log) {
  const cache = f => path.join(opts.data, f);
  let pems, status = null;
  if (opts.roots) pems = JSON.parse(fs.readFileSync(opts.roots, 'utf8'));
  else {
    try {
      if (opts.offline) throw new Error('offline mode');
      pems = await fetchJson(ROOT_URL, 8000);
      fs.writeFileSync(cache('google-roots.json'), JSON.stringify(pems, null, 1));
    } catch (e) {
      const f = fs.existsSync(cache('google-roots.json')) ? cache('google-roots.json') : path.join(__dirname, 'google-roots.json');
      pems = JSON.parse(fs.readFileSync(f, 'utf8'));
      log(`attestation roots: using cached copy (${e.message})`);
    }
  }
  if (opts.revokedFile) status = JSON.parse(fs.readFileSync(opts.revokedFile, 'utf8'));
  else if (!opts.roots) {
    try {
      if (opts.offline) throw new Error('offline mode');
      status = await fetchJson(STATUS_URL, 8000);
      fs.writeFileSync(cache('revocation-status.json'), JSON.stringify(status));
    } catch (e) {
      if (fs.existsSync(cache('revocation-status.json'))) status = JSON.parse(fs.readFileSync(cache('revocation-status.json'), 'utf8'));
      log(`revocation list: ${status ? 'using cached copy' : 'unavailable'} (${e.message})`);
    }
  }
  return { rootSpkis: rootSpkisFromPems(pems), revoked: status ? revokedFromStatusJson(status) : null };
}

function createServer(opts) {
  const log = opts.log || (m => console.log(`[${new Date().toISOString()}] ${m}`));
  fs.mkdirSync(opts.data, { recursive: true });
  const recordsFile = path.join(opts.data, 'records.jsonl');
  const keysFile = path.join(opts.data, 'keys.json');
  const records = [];
  const byRid = new Map();
  if (fs.existsSync(recordsFile))
    for (const line of fs.readFileSync(recordsFile, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); records.push(r); byRid.set(r.rid, r); }
  const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {};
  let trust = { rootSpkis: new Set(), revoked: null };
  const challenge = Buffer.from(opts.challenge || 'SecureCam-v2-attestation', 'utf8');
  const packageName = opts.packageName || 'com.example.securecam';
  const pinnedDigests = new Set((opts.signatureDigests || []).map(s => s.toLowerCase()));
  const hits = new Map(); // ip -> [count, windowStart]

  const publicKeyStatus = keyId => {
    const k = keys[keyId];
    if (!k) return { attested: false, known: false };
    return { known: true, attested: k.ok, reasons: k.reasons, warnings: k.warnings, details: k.details, checkedAt: k.checkedAt };
  };
  const publicRecord = r => ({
    rid: r.rid, manifest: r.manifest, sig: r.sig, pub: r.pub, thumb: r.thumb, receivedAt: r.receivedAt,
    key: publicKeyStatus(r.keyId)
  });

  async function register(body) {
    const need = ['manifest', 'sig', 'pub', 'thumb'];
    for (const f of need) if (typeof body[f] !== 'string') return [400, { error: `missing field ${f}` }];
    let manifestBytes, sig, pub, thumb, chain;
    try {
      manifestBytes = SC.b64decode(body.manifest); sig = SC.b64decode(body.sig); pub = SC.b64decode(body.pub); thumb = SC.b64decode(body.thumb);
      chain = (Array.isArray(body.chain) ? body.chain : []).slice(0, 8).map(c => Buffer.from(SC.b64decode(c)));
    } catch (e) { return [400, { error: 'invalid base64' }]; }
    if (manifestBytes.length > 4096 || sig.length !== 64 || pub.length > 256 || thumb.length !== SC.THUMB_BYTES)
      return [400, { error: 'field sizes are invalid' }];
    let manifest;
    try { manifest = SC.parseManifest(manifestBytes); } catch (e) { return [400, { error: e.message }]; }
    if (manifest.app !== packageName) return [400, { error: 'manifest is not from ' + packageName }];
    const keyId = await SC.sha256Hex(pub);
    if (keyId !== manifest.key) return [400, { error: 'public key does not match manifest.key' }];
    if (!(await SC.verifyEcdsa(pub, sig, manifestBytes))) return [400, { error: 'signature does not verify' }];
    if ((await SC.sha256Hex(thumb)) !== manifest.fp.thumb_sha256) return [400, { error: 'thumbnail does not match manifest' }];
    if (SC.phashFromY(thumb.subarray(0, SC.N * SC.N)) !== manifest.fp.phash) return [400, { error: 'pHash does not match thumbnail' }];

    let key = keys[keyId];
    // Re-check when a chain arrives for a key that failed, or for an attested key saved before the
    // chain summary was kept (so the verifier can show the chain of trust).
    if (!key || (chain.length && (!key.ok || !(key.details && key.details.chain)))) {
      if (!chain.length) key = { ok: false, reasons: ['no attestation chain supplied'], warnings: [], details: {} };
      else {
        const res = verifyAttestation(chain, {
          trustedRootSpkis: trust.rootSpkis, revokedSerials: trust.revoked, expectedChallenge: challenge,
          packageName, expectedSpki: Buffer.from(pub), signatureDigests: pinnedDigests
        });
        key = { ok: res.ok, reasons: res.reasons, warnings: res.warnings, details: res.details };
      }
      key.checkedAt = new Date().toISOString();
      keys[keyId] = key;
      fs.writeFileSync(keysFile, JSON.stringify(keys, null, 1));
      log(`key ${keyId.slice(0, 12)} attestation ${key.ok ? 'OK' : 'FAILED: ' + key.reasons.join('; ')}`);
    }
    if (!key.ok && !opts.allowUnattested) return [403, { error: 'device attestation failed', reasons: key.reasons }];

    const rid = (await SC.sha256Hex(manifestBytes)).slice(0, 32);
    if (byRid.has(rid)) return [200, { rid, duplicate: true, key: publicKeyStatus(keyId) }];
    const rec = { rid, keyId, phash: manifest.fp.phash, manifest: body.manifest, sig: body.sig, pub: body.pub, thumb: body.thumb, receivedAt: new Date().toISOString() };
    records.push(rec); byRid.set(rid, rec);
    fs.appendFileSync(recordsFile, JSON.stringify(rec) + '\n');
    log(`record ${rid} registered (key ${keyId.slice(0, 12)}, attested=${key.ok})`);
    return [201, { rid, key: publicKeyStatus(keyId) }];
  }

  // Lookup keys of a stored record: its signed pHash plus quadrant pHashes derived from its signed thumbnail.
  const quadCache = new Map();
  const recordKeys = r => {
    let q = quadCache.get(r.rid);
    if (!q) { q = SC.quadrantPhashes(SC.b64decode(r.thumb).subarray(0, SC.N * SC.N)); quadCache.set(r.rid, q); }
    return { phash: r.phash, quads: q };
  };
  const HEX16 = /^[0-9a-f]{16}$/;

  // body.queries: [{ phash, quads: [4] }] — one per orientation of the received image (max 4).
  function lookup(body) {
    const qs = Array.isArray(body.queries) ? body.queries.slice(0, 4) : [];
    if (!qs.length || !qs.every(q => q && HEX16.test(q.phash) && Array.isArray(q.quads) && q.quads.length === 4 && q.quads.every(h => HEX16.test(h))))
      return [400, { error: 'queries must be 1-4 objects {phash, quads[4]} of 16-hex-digit pHashes' }];
    const hitsOut = [];
    for (const r of records) {
      const keys = recordKeys(r);
      let best = null;
      qs.forEach((q, i) => {
        const m = SC.lookupMatch(q, keys);
        if (m.match && (!best || m.distance < best.distance)) best = { distance: m.distance, closeQuads: m.closeQuads, query: i };
      });
      if (best) hitsOut.push(Object.assign(best, { record: publicRecord(r) }));
    }
    hitsOut.sort((a, b) => a.distance - b.distance || b.closeQuads - a.closeQuads);
    return [200, { candidates: hitsOut.slice(0, 8) }];
  }

  function send(res, code, obj, headers) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'content-length': body.length }, headers || {}));
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    // CORS so index.html also works when opened by double-click (file://).
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://x');
      const ip = req.socket.remoteAddress || '?';
      const now = Date.now();
      const h = hits.get(ip) || [0, now];
      if (now - h[1] > 60000) { h[0] = 0; h[1] = now; }
      if (++h[0] > (opts.rateLimit || 300)) return send(res, 429, { error: 'too many requests' });
      hits.set(ip, h);

      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const f = path.join(WEB_DIR, STATIC[url.pathname]);
        const data = fs.readFileSync(f);
        res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(data);
      }
      if (req.method === 'GET' && url.pathname === '/api/health')
        return send(res, 200, { ok: true, records: records.length, keys: Object.keys(keys).length, trustedRoots: trust.rootSpkis.size, revocationList: !!trust.revoked, allowUnattested: !!opts.allowUnattested });
      let m;
      if (req.method === 'GET' && (m = /^\/api\/records\/([0-9a-f]{32})$/.exec(url.pathname))) {
        const r = byRid.get(m[1]);
        return r ? send(res, 200, publicRecord(r)) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && (m = /^\/api\/keys\/([0-9a-f]{64})$/.exec(url.pathname)))
        return send(res, 200, publicKeyStatus(m[1]));
      if (req.method === 'POST' && (url.pathname === '/api/records' || url.pathname === '/api/lookup')) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) return send(res, 413, { error: 'body too large' });
          chunks.push(c);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
        const [code, out] = url.pathname === '/api/records' ? await register(body) : lookup(body);
        return send(res, code, out);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      log('error: ' + e.stack);
      send(res, 500, { error: 'internal error' });
    }
  });

  server.init = async () => { trust = await loadTrust(opts, log); log(`trusted attestation roots: ${trust.rootSpkis.size}; revocation list: ${trust.revoked ? trust.revoked.size + ' entries' : 'unavailable'}`); };
  return server;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const server = createServer(opts);
  server.init().then(() => server.listen(opts.port, opts.host, () => {
    console.log(`SecureCam registry listening on http://localhost:${opts.port}  (verifier at http://localhost:${opts.port}/)`);
    if (opts.allowUnattested) console.log('WARNING: --allow-unattested is on; records from unverified devices are accepted and flagged.');
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`Phone app server URL: http://${n.address}:${opts.port}`);
  }));
}

module.exports = { createServer, parseArgs };
