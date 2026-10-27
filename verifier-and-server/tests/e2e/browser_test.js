// Real-browser end-to-end test of index.html using headless Chrome/Edge over the
// DevTools protocol (no extra packages). Each file is put into the page's file input
// exactly as if a user picked it; the verdict shown on the page is checked.
//
// Usage: node browser_test.js <files_dir> <page_url> <screenshot_dir>
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [DIR, PAGE_URL, SHOTS, MODE] = process.argv.slice(2);
const OFFLINE = MODE === 'offline'; // registry pointed at a dead address
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

// CASES_JSON=<file> replaces the built-in cases with [[file, expectedBadge], ...].
const CASES = process.env.CASES_JSON ? JSON.parse(fs.readFileSync(process.env.CASES_JSON, 'utf8')) : [
  ['A_original_signed.jpg', 'AUTHENTIC'],
  ['A2_portrait_original_signed.jpg', 'AUTHENTIC'],
  ['B_tampered_one_byte.jpg', 'TAMPERED'],
  ['C_whatsapp_copy.jpg', 'AUTHENTIC COPY'],
  ['D_portrait_whatsapp_copy.jpg', 'AUTHENTIC COPY'],
  ['E_edited_then_whatsapp.jpg', 'MODIFIED'],
  ['F_unrelated_photo.jpg', 'UNVERIFIED'],
  ['G_instagram_crop.jpg', 'UNVERIFIED'],
  ['H_signed_by_unregistered_key.jpg', 'SIGNATURE VALID — DEVICE NOT VERIFIED'],
  ['I_legacy_v1_signed.jpg', 'SIGNATURE VALID (v1)'],
];
// Without the registry: originals still verify byte-for-byte but the device cannot be
// confirmed; copies without a signature block cannot be verified at all.
const OFFLINE_EXPECT = {
  'A_original_signed.jpg': 'SIGNATURE VALID — DEVICE NOT VERIFIED', 'A2_portrait_original_signed.jpg': 'SIGNATURE VALID — DEVICE NOT VERIFIED',
  'C_whatsapp_copy.jpg': 'UNVERIFIED', 'D_portrait_whatsapp_copy.jpg': 'UNVERIFIED', 'E_edited_then_whatsapp.jpg': 'UNVERIFIED'
};
if (OFFLINE) for (const c of CASES) if (OFFLINE_EXPECT[c[0]]) c[1] = OFFLINE_EXPECT[c[0]];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  }
}

async function main() {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('no Chrome/Edge found');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-browser-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  fs.mkdirSync(SHOTS, { recursive: true });
  let page;
  try {
    for (let i = 0; i < 50 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { await sleep(200); }
    }
    if (!page) throw new Error('browser did not start');
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1300, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: PAGE_URL });
    for (let i = 0; i < 100; i++) { if (await cdp.eval('document.readyState === "complete" && !!window.SecureCam')) break; await sleep(100); }
    if (OFFLINE) await cdp.eval(`(() => { const i = document.getElementById('reg-url'); i.value = 'http://127.0.0.1:9'; i.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    for (let i = 0; i < 80; i++) { if (!/checking/.test(await cdp.eval('document.getElementById("reg-status").textContent'))) break; await sleep(100); }
    console.log(`browser: ${path.basename(exe)} | page: ${PAGE_URL} | ${await cdp.eval('document.getElementById("reg-status").textContent')}`);

    const results = [];
    // REPEAT=n checks every file n times (verification timing); the page records the moment the verdict appears.
    const REPEAT = +(process.env.REPEAT || 1);
    for (const [file, expected] of CASES.flatMap(c => Array(REPEAT).fill(c))) {
      await cdp.eval('document.getElementById("result").innerHTML = ""');
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
      await cdp.eval(`window.__verdictMs = null; window.__t0 = performance.now();
        new MutationObserver((m, o) => { if (document.querySelector('#result .card:not(.busy)')) { window.__verdictMs = performance.now() - window.__t0; o.disconnect(); } })
          .observe(document.getElementById('result'), { childList: true, subtree: true }); true`);
      const t0 = Date.now();
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.join(DIR, file)] });
      let out = null;
      for (let i = 0; i < 300 && !out; i++) {
        out = await cdp.eval(`(() => { const c = document.querySelector('#result .card:not(.busy)'); if (!c) return null;
          const fig = c.querySelector('figure canvas');
          return { badge: c.querySelector('.badge').textContent, title: c.querySelector('h2').textContent,
                   checks: [...c.querySelectorAll('.checks li')].map(li => li.className + ': ' + li.textContent),
                   details: [...c.querySelectorAll('.grid > div')].map(d => d.children[0].textContent + ' = ' + d.children[1].textContent),
                   preview: !!fig, heatmap: !!c.querySelector('figcaption') }; })()`);
        if (!out) await sleep(100);
      }
      const ms = Date.now() - t0;
      const verdictMs = await cdp.eval('window.__verdictMs');
      // Wait for the preview canvas, then screenshot the page.
      for (let i = 0; i < 30; i++) { if (await cdp.eval('!!document.querySelector("#result figure canvas")')) break; await sleep(100); }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(SHOTS, file.replace(/\.jpg$/, '.png')), Buffer.from(shot.data, 'base64'));
      const pass = !!out && out.badge === expected;
      results.push({ file, expected, got: out && out.badge, pass, ms, verdictMs, out });
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${file.padEnd(36)} expected ${expected.padEnd(38)} got ${out ? out.badge : 'nothing'}  (${verdictMs !== null ? verdictMs.toFixed(0) : ms} ms)`);
      if (out && REPEAT === 1) for (const c of out.checks) console.log('        ' + c);
    }
    fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1));
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} browser cases passed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    proc.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
