"""Demo helper: the attack that device attestation stops.

A "hacker" takes any photo (for example one edited in Photoshop), removes any
SecureCam block, signs it with a key generated on this laptop, and appends a
perfectly well-formed SecureCam v2 block that even claims "StrongBox".

  * The verifier: the signature is mathematically valid, but the key was never
    attested, so it shows SIGNATURE VALID - DEVICE NOT VERIFIED (never AUTHENTIC).
  * With --register, the registry refuses the record (HTTP 403, no attestation).

Usage: python tools/hacker_resign.py <in.jpg> <out.jpg> [--register http://localhost:8787]
Needs: pip install pillow numpy cryptography
"""
import base64
import datetime as dt
import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request

import numpy as np
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from PIL import Image, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests", "experiment"))
from scfp import N, thumbnails  # noqa: E402

# Same integer DCT basis as securecam-core.js / Provenance.kt (JS Math.round semantics).
COS = np.array([[math.floor(4096 * math.cos((2 * x + 1) * u * math.pi / 64) + 0.5) for x in range(32)] for u in range(8)],
               dtype=np.int64)


def phash(y_bytes):
    y = np.frombuffer(y_bytes, np.uint8).astype(np.int64).reshape(N, N)
    p = y.reshape(32, 4, 32, 4).sum(axis=(1, 3))
    d = (COS @ (p @ COS.T)).ravel()  # d[v*8+u]
    s = np.sort(d)
    m2 = s[31] + s[32]
    bits = (2 * d > m2).astype(np.uint8)
    return bytes(np.packbits(bits)).hex()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    register = sys.argv[sys.argv.index("--register") + 1] if "--register" in sys.argv else None

    data = open(src, "rb").read()
    cut = max(data.rfind(b"||SECURECAM_V2||"), data.rfind(b"||SECURECAM_START||"))
    image = data[:cut] if cut >= 0 else data
    disp = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    thumb = thumbnails(np.asarray(disp))

    key = ec.generate_private_key(ec.SECP256R1())  # made on this laptop, not in any phone
    spki = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    manifest = json.dumps({
        "v": 2, "app": "com.example.securecam",
        "captured": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "file_sha256": hashlib.sha256(image).hexdigest(),
        "fp": {"alg": "scfp1", "phash": phash(thumb[:N * N]), "thumb_sha256": hashlib.sha256(thumb).hexdigest(),
               "w": disp.size[0], "h": disp.size[1]},
        "key": hashlib.sha256(spki).hexdigest(), "sec": "StrongBox",  # a lie the verifier does not trust
    }, separators=(",", ":")).encode()
    r, s = decode_dss_signature(key.sign(manifest, ec.ECDSA(hashes.SHA256())))
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    b64 = lambda b: base64.b64encode(b).decode()
    trailer = f"||SECURECAM_V2||M:{b64(manifest)}|S:{b64(sig)}|P:{b64(spki)}|T:{b64(thumb)}||SECURECAM_END||".encode()
    open(dst, "wb").write(image + trailer)
    print(f"Wrote {dst}: signed with a laptop key {hashlib.sha256(spki).hexdigest()[:16]}... (claims StrongBox)")

    if register:
        body = json.dumps({"manifest": b64(manifest), "sig": b64(sig), "pub": b64(spki), "thumb": b64(thumb), "chain": []}).encode()
        req = urllib.request.Request(register.rstrip("/") + "/api/records", data=body, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                print("Registry answered", res.status, res.read().decode())
        except urllib.error.HTTPError as e:
            print("Registry answered", e.code, e.read().decode())


if __name__ == "__main__":
    main()
