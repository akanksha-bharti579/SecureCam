"""Comparison with deployed provenance / matching methods on exactly the same copies and edits as make_vision.py.

For every photo it rebuilds the copies and edits of make_vision.py (same code, same random seed; each rebuilt copy is
checked against the stored record: identical file size for the simulated platform copies, identical edit box) and
scores three methods:

  * C2PA hard binding (c2pa-python): the original file is signed with a test certificate. A copy is checked with the
    manifest put back into it (best case for C2PA: a platform that keeps the metadata), so the content hash is checked
    against the new bytes. Which metadata segments the real WhatsApp/Facebook files of VISION keep is also recorded.
  * PDQ (Meta, pdqhash): 256-bit perceptual hash; Hamming distance between the copy and the original.
  * TrustMark (Adobe, the C2PA soft-binding watermark; model Q, BCH_5, 61-bit payload): the original is watermarked,
    the same copies and edits are made from the watermarked photo, and the payload is decoded from each. Real
    platform files cannot be used here (they were made from the unwatermarked photo).

Needs a separate environment (Python 3.12): pip install torch --index-url https://download.pytorch.org/whl/cpu;
pip install trustmark pdqhash c2pa-python cryptography numpy==2.5.2 pillow==12.3.0 (the same Pillow and NumPy as
make_vision.py, so the rebuilt copies are byte-identical).

Usage: python baselines_vision.py <vision_dir> <out_dir> [workers=4]   (resumable; writes <out_dir>/baselines/)
compare_vision.js scores the result.
"""
import datetime
import hashlib
import io
import json
import os
import random
import sys
import warnings
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = sys.argv[1], sys.argv[2]
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
sys.path.insert(0, HERE)
_argv, sys.argv = sys.argv, [sys.argv[0], SRC, OUT]  # make_vision reads its paths from argv on import
import make_vision as mv  # noqa: E402
sys.argv = _argv

BASE = os.path.join(OUT, "baselines")
TM = None
SIGNER = None


def jpeg_segments(d):
    """(marker, bytes) of the segments before the image data."""
    i, out = 2, []
    while i + 4 <= len(d) and d[i] == 0xFF and d[i + 1] != 0xDA:
        n = int.from_bytes(d[i + 2:i + 4], "big")
        out.append((d[i + 1], d[i:i + 2 + n]))
        i += 2 + n
    return out


def test_certificates():
    """A test CA and an ES256 signing certificate (C2PA profile: digitalSignature, emailProtection EKU)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    now = datetime.datetime.now(datetime.timezone.utc)
    name = lambda cn: x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SecureCam test")])
    rk, lk = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    root = (x509.CertificateBuilder().subject_name(name("Test C2PA Root")).issuer_name(name("Test C2PA Root"))
            .public_key(rk.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(rk.public_key()), critical=False)
            .sign(rk, hashes.SHA256()))
    leaf = (x509.CertificateBuilder().subject_name(name("Test C2PA Signer")).issuer_name(name("Test C2PA Root"))
            .public_key(lk.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(lk.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(rk.public_key()), critical=False)
            .sign(rk, hashes.SHA256()))
    pem = lambda c: c.public_bytes(serialization.Encoding.PEM).decode()
    key = lk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    return {"root": pem(root), "chain": pem(leaf) + pem(root), "key": key}


def init_worker():
    global TM, SIGNER
    warnings.filterwarnings("ignore")
    import torch
    torch.set_num_threads(2)
    import c2pa
    from trustmark import TrustMark
    certs = json.load(open(os.path.join(BASE, "c2pa_test_certs.json")))
    c2pa.load_settings({"verify": {"verify_trust": True}, "trust": {"trust_anchors": certs["root"]}})
    SIGNER = c2pa.Signer.from_info(c2pa.C2paSignerInfo(c2pa.C2paSigningAlg.ES256, certs["chain"].encode(), certs["key"].encode(), None))
    TM = TrustMark(verbose=False, model_type="Q", encoding_type=TrustMark.Encoding.BCH_5, loadRemover=False)


def c2pa_sign(data, title):
    import c2pa
    manifest = {"claim_generator_info": [{"name": "SecureCam baseline", "version": "1"}], "title": title,
                "assertions": [{"label": "c2pa.actions", "data": {"actions": [{"action": "c2pa.created",
                                "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"}]}}]}
    out = io.BytesIO()
    with c2pa.Builder(manifest) as b:
        b.sign(SIGNER, "image/jpeg", io.BytesIO(data), out)
    return out.getvalue()


def c2pa_check(data):
    """'Trusted' / 'Valid' / 'Invalid:<codes>' / 'none' (no manifest)."""
    import c2pa
    try:
        with c2pa.Reader("image/jpeg", io.BytesIO(data)) as r:
            st = r.get_validation_state() or "?"
            vr = r.get_validation_results() or {}
            codes = sorted({x["code"] for x in vr.get("activeManifest", {}).get("failure", [])})
            return st if not codes else st + ":" + ",".join(codes)
    except Exception as e:
        return "none" if "ManifestNotFound" in type(e).__name__ else "error:" + type(e).__name__


def with_manifest(data, app11):
    """The copy with the original's C2PA manifest (APP11 segments) put back after SOI."""
    return data[:2] + app11 + data[2:]


def pdq(img):
    import pdqhash
    h, q = pdqhash.compute(np.ascontiguousarray(np.asarray(img.convert("RGB"))))
    return h.astype(bool), int(q)


def pdq_rot(img):
    """PDQ of the four rotations (real files may be stored in another orientation; as make_vision's baselines)."""
    import pdqhash
    hs, q = pdqhash.compute_dihedral(np.ascontiguousarray(np.asarray(img.convert("RGB"))))
    return [h.astype(bool) for h in hs[:4]], int(q)


def tm_read(img, bits):
    s, found, _ = TM.decode(img, MODE="binary")
    return "none" if not found else ("ok" if s == bits else "wrong")


def process(job):
    entry, other_path = job
    oid = entry["id"]
    dest = os.path.join(BASE, oid + ".json")
    if os.path.exists(dest):
        return oid
    meta = json.load(open(os.path.join(OUT, "meta", oid + ".json")))
    stored = {v["id"]: v for v in meta["variants"]}
    nat = os.path.join(SRC, entry["files"]["nat"])
    raw = open(nat, "rb").read()
    display = ImageOps.exif_transpose(Image.open(nat)).convert("RGB")
    W, H = display.size

    ref_pdq, ref_q = pdq(display)
    signed = c2pa_sign(raw, oid + ".jpg")
    app11 = b"".join(s for m, s in jpeg_segments(signed) if m == 0xEB)
    bits = "".join(str(b) for b in np.unpackbits(np.frombuffer(hashlib.sha256(oid.encode()).digest(), np.uint8))[:TM.schemaCapacity()])
    wm = TM.encode(display, bits, MODE="binary")
    a, b = np.asarray(display, np.float32), np.asarray(wm, np.float32)
    mse = float(((a - b) ** 2).mean())
    res = {"id": oid, "pdqHash": np.packbits(ref_pdq).tobytes().hex(), "pdqQuality": ref_q, "c2paSigned": c2pa_check(signed), "c2paUnsigned": c2pa_check(raw),
           "c2paManifestBytes": len(app11), "tmPsnr": round(10 * np.log10(255 ** 2 / mse), 3) if mse else 99.0,
           "tmSelf": tm_read(wm, bits), "tmUnmarked": tm_read(display, bits), "variants": {}}

    def score(vid, im, data, wm_im=None, rot=False):
        if vid not in stored:
            raise RuntimeError(f"{vid}: not in make_vision's record")
        hs = pdq_rot(im)[0] if rot else [pdq(im)[0]]
        k = min(range(len(hs)), key=lambda i: int((hs[i] != ref_pdq).sum()))
        r = {"pdq": int((hs[k] != ref_pdq).sum()), "pdqHash": np.packbits(hs[k]).tobytes().hex()}
        if data is not None and data[:2] == b"\xff\xd8":
            r["c2paKept"] = c2pa_check(with_manifest(data, app11))
        if wm_im is not None:
            r["tm"] = tm_read(wm_im, bits)
        res["variants"][vid] = r
        return r

    for key, pname in mv.REAL.items():
        if key not in entry["files"]:
            continue
        path = os.path.join(SRC, entry["files"][key])
        data = open(path, "rb").read()
        r = score(f"{oid}_{pname}", ImageOps.exif_transpose(Image.open(path)).convert("RGB"), data, rot=True)
        r["segments"] = sorted({hex(m) for m, _ in jpeg_segments(data) if 0xE0 <= m <= 0xEF})

    for pname in list(mv.PLATFORMS) + ["wa_then_telegram"]:
        vid = f"{oid}_{pname}"
        data = mv.platform(display, pname)
        if len(data) != stored[vid]["bytes"]:
            raise RuntimeError(f"{vid}: rebuilt copy differs from make_vision's ({len(data)} vs {stored[vid]['bytes']} bytes)")
        score(vid, mv.decode(data), data, mv.decode(mv.platform(wm, pname)))

    seed = int(hashlib.sha256(oid.encode()).hexdigest()[:12], 16)
    rng, rng_wm = random.Random(seed), random.Random(seed)
    for kind, frac in mv.EDITS:
        edited, box = mv.apply_edit(rng, display, kind, frac, other_path)
        edited_wm, box_wm = mv.apply_edit(rng_wm, wm, kind, frac, other_path)
        nbox = [box[0] / W, box[1] / H, box[2] / W, box[3] / H]
        if box_wm != box or max(abs(x - y) for x, y in zip(nbox, stored[f"{oid}_{kind}{frac}_editor_save"]["box"])) > 1e-12:
            raise RuntimeError(f"{oid} {kind}{frac}: edit box differs from make_vision's")
        saved, saved_wm = mv.encode(edited, 92), mv.encode(edited_wm, 92)
        for pname in mv.EDIT_PLATFORMS:
            data = saved if pname == "editor_save" else mv.platform(mv.decode(saved), pname)
            data_wm = saved_wm if pname == "editor_save" else mv.platform(mv.decode(saved_wm), pname)
            score(f"{oid}_{kind}{frac}_{pname}", mv.decode(data), data, mv.decode(data_wm))

    missing = set(stored) - set(res["variants"])
    if missing:
        raise RuntimeError(f"{oid}: {len(missing)} copies not rebuilt")
    with open(dest + ".part", "w") as f:
        json.dump(res, f)
    os.replace(dest + ".part", dest)
    return oid


def main():
    os.makedirs(BASE, exist_ok=True)
    cert_file = os.path.join(BASE, "c2pa_test_certs.json")
    if not os.path.exists(cert_file):
        json.dump(test_certificates(), open(cert_file, "w"))
    # Same photo list and splice donors as make_vision.py.
    index = json.load(open(os.path.join(SRC, "index.json")))
    index = [e for e in index if all(os.path.exists(os.path.join(SRC, f)) for f in e["files"].values())]
    n = len(index)
    jobs = [(e, os.path.join(SRC, index[(i + n // 2 + 7) % n]["files"]["nat"])) for i, e in enumerate(index)]
    if os.environ.get("LIMIT"):
        jobs = jobs[:int(os.environ["LIMIT"])]
    done = 0
    with Pool(WORKERS, initializer=init_worker) as pool:
        for _ in pool.imap_unordered(process, jobs):
            done += 1
            if done % 10 == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)}", flush=True)
    merged = {}
    for e, _ in jobs:
        merged[e["id"]] = json.load(open(os.path.join(BASE, e["id"] + ".json")))
    json.dump(merged, open(os.path.join(OUT, "baselines.json"), "w"))
    print("photos:", len(merged), "copies:", sum(len(m["variants"]) for m in merged.values()))


if __name__ == "__main__":
    main()
