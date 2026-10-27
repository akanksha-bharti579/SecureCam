# SecureCam v2 — compression-proof verification

Platforms such as WhatsApp, Instagram and Telegram re-encode photos and delete anything
stored inside the file, including SecureCam's signature block. v2 therefore adds a second
proof that does not live in the file:

1. **Exact proof (unchanged).** The app appends a signed block after the JPEG's `FF D9`.
   An untouched file verifies offline, byte for byte.
2. **Visual proof (new).** At capture the app also computes a *visual fingerprint*
   (`scfp1`: 128×128 brightness + 32×32 colour thumbnail and a 64-bit pHash), puts its
   hash in the signed manifest, and uploads the signed record to this registry. A
   recompressed copy is matched by its fingerprint, the record's signature is re-checked
   in the browser, and the copy is compared region by region (16×16 regions).
3. **Device proof (new).** The signing key is created with Android Key Attestation. The
   registry only accepts records whose key chains to Google's hardware attestation root,
   is StrongBox/TEE-backed, belongs to `com.example.securecam`, and comes from a locked,
   verified-boot device (not rooted). This closes the "anyone can sign with a laptop key" gap.

| Verifier result | Meaning |
|---|---|
| AUTHENTIC | Original file, every byte intact, key attested |
| AUTHENTIC COPY | Re-encoded copy; all 256 regions match a signed, attested capture |
| TAMPERED | Signature block present but the image bytes (or the block) were changed; red regions show where |
| MODIFIED | Re-encoded copy of a signed capture with some regions changed (red) |
| SIGNATURE VALID — DEVICE NOT VERIFIED | Signature checks out but the key is not attested (e.g. made on a computer) |
| UNVERIFIED | No signature and no registry match (not a SecureCam photo, heavily edited, or cropped) |

## Running the demo

Needs Node.js 20+ (no `npm install`; no dependencies).

```bash
node registry-server/server.js
```

The terminal prints the phone URL, e.g. `http://192.168.1.5:8787`.

1. Phone and laptop on the same Wi-Fi. In the app tap **⚙ SERVER** and enter that URL.
2. Take a photo. The status shows `Registry: uploaded ✓` (or how many are waiting, if offline).
3. Open **http://localhost:8787/** on the laptop and drop in:
   - the original file (USB / Drive download) → AUTHENTIC
   - the same photo received through WhatsApp → AUTHENTIC COPY
   - a copy edited before sending → MODIFIED, with the changed area in red

`index.html` also works by double-click; it then talks to `http://localhost:8787`
(editable in the top-right box). Open it via `localhost`, not the LAN IP: browsers only
allow WebCrypto on secure origins.

Data lives in `registry-server/data/` (`records.jsonl`, `keys.json`, cached Google roots and
revocation list). Delete the folder to start fresh.

If a record is rejected, the phone shows the attestation reason (for example "bootloader is
unlocked"). `--allow-unattested` accepts such records but flags them in the verifier; use it
only for testing on emulators or unlocked phones.

## Tests

```bash
node --test "tests/*.test.js"                                  # core, server, attestation, Kotlin interop
cd ../SecureCam && gradlew :app:testDebugUnitTest              # Kotlin: bit-identical fingerprint vs JS
python tests/experiment/make_dataset.py <tmp> && node tests/experiment/analyze.js <tmp>   # robustness numbers
```

`tests/gen-parity-vectors.js` regenerates the JS reference vectors the Kotlin test checks.
`tests/fixtures/make_attestation_fixtures.py` regenerates the synthetic attestation chains
(the tests trust a test root; the server itself only trusts Google's roots).

To measure on real photos, copy SecureCam originals to a folder, add their paths to
`SOURCES` in `make_dataset.py` (skip the 4000×3000 resize and noise), and re-run.

## Privacy

- The phone uploads, per capture: the signed manifest, the signature, its public key, the
  attestation certificates, and the fingerprint thumbnail (128×128 grey + 32×32 colour, about
  18 KB). That thumbnail is a very low-resolution picture of the photo; the full photo is never
  uploaded.
- The verifier sends only fingerprint numbers (pHashes) when looking a copy up. Anyone holding a
  copy of a photo can fetch its record (including the thumbnail) — they already have the photo.

## Limits

- Blur/smoothing that keeps a region's average colour, very small edits (well under 1% of
  the photo), and crops are not detected by the visual check (crops come out UNVERIFIED).
  The exact check still catches any change to an original file.
- The capture time is the phone's clock. The registry's "registered at" time is independent
  but only as early as the upload (records made offline are uploaded later).
- Attestation proves the key lives in a genuine, unrooted phone running this app. It cannot
  prove the scene was real (e.g. photographing a screen).
