"""Edits made by people on the Internet: the real-life part of IMD2020 (Novozamsky et al., WACVW 2020): about 2,000
manipulated images collected online, each with the original it was made from and a hand-drawn mask.
Layout: <folder>/<folder>_orig.<ext> and, per manipulation, <name>_0.<ext> with <name>_0_mask.png.

Output in the format of make_vision.py (jobs.json), so analyze_vision.js scores it with the real verifier code:
  * record: the original, fingerprinted as the phone would,
  * unedited copies: the original through the simulated platform profiles,
  * edits: every manipulated file as found, saved by an editor (JPEG 92), and that file through the WhatsApp-like profile.
Many manipulations were resized or cropped by their makers. `geometry` records this: "same" (same size as the
original), "resized" (same aspect ratio within 1%), "cropped" (different aspect ratio). Mask and visibility are
measured at the manipulated file's size, with the original resized to it.

Usage: python make_imd.py <IMD2020 dir> <out_dir> [workers=3]
"""
import glob
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = sys.argv[1], sys.argv[2]
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
sys.path.insert(0, HERE)
_argv, sys.argv = sys.argv, [sys.argv[0], SRC, OUT]  # make_vision reads its paths from argv on import
import make_vision as mv  # noqa: E402
sys.argv = _argv

PLATFORMS = list(mv.PLATFORMS) + ["wa_then_telegram"]
EDIT_PLATFORMS = ["as_is", "editor_save", "whatsapp_std"]
T = 16


def find_sets():
    out = []
    for d in sorted(glob.glob(os.path.join(SRC, "*", ""))):
        name = os.path.basename(os.path.dirname(d))
        orig = glob.glob(os.path.join(d, name + "_orig.*"))
        if len(orig) != 1:
            continue
        fakes = []
        for m in sorted(glob.glob(os.path.join(d, "*_mask.*"))):
            stem = os.path.basename(m)[:-len("_mask") - len(os.path.splitext(m)[1])]
            f = [x for x in glob.glob(os.path.join(d, stem + ".*")) if x != m]
            if len(f) == 1:
                fakes.append((f[0], m))
        if fakes:
            out.append((orig[0], fakes))
    return out


def load(path):
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def process(job):
    i, (orig_path, fakes) = job
    oid = f"I{i:04d}"
    meta_path = os.path.join(mv.META, oid + ".json")
    if os.path.exists(meta_path):
        return oid
    display = load(orig_path)
    pt, deg, stored = mv.phone_thumb(orig_path)
    g = mv.grey256(display)
    ref = {"g": g, "ahash": mv.ahash(g), "dhash": mv.dhash(g), "bhash": mv.blockhash(g)}
    out = {"original": {"id": oid, "device": "IMD2020", "model": "IMD2020", "stored": stored, "exifDeg": deg, "display": display.size,
                        "bytes": os.path.getsize(orig_path), "file": os.path.relpath(orig_path, SRC),
                        "phoneThumb": mv.save_thumb(oid + "_phone", pt), "fullThumb": mv.save_thumb(oid + "_full", mv.thumbnails(display)),
                        "ahash": mv.bits_hex(ref["ahash"]), "dhash": mv.bits_hex(ref["dhash"]), "bhash": mv.bits_hex(ref["bhash"])},
           "variants": [], "parity": [], "skipped": []}

    def add(vid, im, extra):
        v = {"id": vid, "ref": oid, "size": im.size, "thumb": mv.save_thumb(vid, mv.thumbnails(im)), "base": mv.baseline(ref, im)}
        v.update(extra)
        out["variants"].append(v)

    for pname in PLATFORMS:
        data = mv.platform(display, pname)
        add(f"{oid}_{pname}", mv.decode(data), {"kind": "clean", "real": False, "platform": pname, "bytes": len(data)})

    W0, H0 = display.size
    for k, (fake_path, mask_path) in enumerate(fakes):
        try:
            forged = load(fake_path)
            mask = np.asarray(Image.open(mask_path).convert("L")) >= 128
        except Exception as e:  # unreadable file: record it and go on
            out["skipped"].append({"file": os.path.relpath(fake_path, SRC), "reason": f"{type(e).__name__}: {e}"})
            continue
        W, H = forged.size
        if mask.shape[::-1] != forged.size or not mask.any():
            out["skipped"].append({"file": os.path.relpath(fake_path, SRC), "reason": "mask size differs or empty"})
            continue
        geometry = "same" if (W, H) == (W0, H0) else "resized" if abs(W / H - W0 / H0) <= 0.01 * (W0 / H0) else "cropped"
        base = display if geometry == "same" else display.resize((W, H), Image.BICUBIC)
        A, B = np.asarray(base, np.int32)[mask], np.asarray(forged, np.int32)[mask]
        ya = (19595 * A[:, 0] + 38470 * A[:, 1] + 7471 * A[:, 2]) >> 16
        yb = (19595 * B[:, 0] + 38470 * B[:, 1] + 7471 * B[:, 2]) >> 16
        ys, xs = np.nonzero(mask)
        nbox = [int(xs.min()) / W, int(ys.min()) / H, (int(xs.max()) + 1) / W, (int(ys.max()) + 1) / H]
        frac = float(mask.mean())
        size_class = "small" if frac < 0.01 else "medium" if frac < 0.05 else "large"
        saved = mv.encode(forged, 92)
        for pname in EDIT_PLATFORMS:
            im = forged if pname == "as_is" else mv.decode(saved if pname == "editor_save" else mv.platform(mv.decode(saved), pname))
            add(f"{oid}_f{k}_{pname}", im, {"kind": "edit", "real": False, "edit": size_class, "frac": 0, "areaFrac": round(frac, 5),
                                            "platform": pname, "box": nbox, "geometry": geometry, "maskSource": "ground truth",
                                            "magY": round(float(np.abs(ya - yb).mean()), 3), "magRGB": round(float(np.abs(A - B).mean()), 3),
                                            "file": os.path.relpath(fake_path, SRC), "mask": os.path.relpath(mask_path, SRC)})
    with open(meta_path + ".part", "w") as f:
        json.dump(out, f)
    os.replace(meta_path + ".part", meta_path)
    return oid


def safe_process(job):
    try:
        return process(job)
    except Exception as e:  # one bad original must not stop the run
        print(f"original {job[0]} failed: {type(e).__name__}: {e}", flush=True)
        return None


def main():
    os.makedirs(mv.THUMBS, exist_ok=True)
    os.makedirs(mv.META, exist_ok=True)
    sets = find_sets()
    print(len(sets), "originals,", sum(len(f) for _, f in sets), "manipulated images", flush=True)
    jobs = list(enumerate(sets))
    if os.environ.get("LIMIT"):
        jobs = jobs[:int(os.environ["LIMIT"])]
    with Pool(WORKERS) as pool:
        for k, _ in enumerate(pool.imap_unordered(safe_process, jobs), 1):
            if k % 50 == 0 or k == len(jobs):
                print(f"{k}/{len(jobs)}", flush=True)
    merged = {"originals": [], "variants": [], "parity": [], "skipped": []}
    for i, _ in jobs:
        if not os.path.exists(os.path.join(mv.META, f"I{i:04d}.json")):
            merged["skipped"].append({"original": i, "reason": "failed, see log"})
            continue
        m = json.load(open(os.path.join(mv.META, f"I{i:04d}.json")))
        merged["originals"].append(m["original"])
        merged["variants"] += m["variants"]
        merged["skipped"] += m["skipped"]
    with open(os.path.join(OUT, "jobs.json"), "w") as f:
        json.dump(merged, f)
    print("originals:", len(merged["originals"]), "variants:", len(merged["variants"]), "skipped:", len(merged["skipped"]))


if __name__ == "__main__":
    main()
