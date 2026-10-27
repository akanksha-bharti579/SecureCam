"""Edits made by other people: the Realistic Tampering dataset of Korus and Huang (220 hand-made forgeries in GIMP /
Affinity Photo, each with its original and a ground-truth map). Produces <out_dir>/jobs.json in the format of
make_vision.py, so analyze_vision.js scores it with the real verifier code:

  * record: the original, fingerprinted as the phone would (make_vision.phone_thumb),
  * unedited copies: the original through the simulated platform profiles of make_vision.py,
  * edits: the dataset's forgery as delivered (lossless), saved by an editor (JPEG quality 92), and that file sent
    through the WhatsApp-like profile.

The edited area is the "semantic change" class of the ground-truth map; its bounding box is stored as `box` (used by
analyze_vision.js for the heatmap check) and the 16 x 16 grid cells it covers as `maskTiles`.

The same script handles COVERAGE (Wen et al., ICIP 2016: 100 copy-move forgeries of objects similar to genuine ones
in the same photo), detected from its layout image/<n>.tif, image/<n>t.tif, mask/<n>forged.tif.

Usage: python make_korus.py <korus data-images dir | COVERAGE dir> <out_dir> [workers=4]
"""
import glob
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = sys.argv[1], sys.argv[2]
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
sys.path.insert(0, HERE)
_argv, sys.argv = sys.argv, [sys.argv[0], SRC, OUT]  # make_vision reads its paths from argv on import
import make_vision as mv  # noqa: E402
sys.argv = _argv

PLATFORMS = list(mv.PLATFORMS) + ["wa_then_telegram"]
EDIT_PLATFORMS = ["as_is", "editor_save", "whatsapp_std"]


COVERAGE = os.path.isdir(os.path.join(SRC, "image")) and os.path.isdir(os.path.join(SRC, "mask"))
PREFIX = "C" if COVERAGE else "K"


def find_pairs():
    if COVERAGE:
        out = []
        for n in range(1, 101):
            files = [os.path.join(SRC, "image", f"{n}.tif"), os.path.join(SRC, "image", f"{n}t.tif"), os.path.join(SRC, "mask", f"{n}forged.tif")]
            if not all(os.path.exists(f) for f in files):
                raise RuntimeError(f"COVERAGE pair {n} incomplete")
            out.append(("COVERAGE", *files))
        return out
    """(camera, original, forgery, ground truth) for every forgery: <camera>/pristine/<name>.TIF,
    <camera>/tampered-realistic/<name>.TIF and <camera>/ground-truth/<name>.PNG."""
    out = []
    for tam in sorted(glob.glob(os.path.join(SRC, "*", "tampered-realistic", "*.TIF"))):
        cam_dir = os.path.dirname(os.path.dirname(tam))
        stem = os.path.splitext(os.path.basename(tam))[0]
        orig = glob.glob(os.path.join(cam_dir, "pristine", stem + ".TIF"))
        gt = glob.glob(os.path.join(cam_dir, "ground-truth", stem + ".PNG"))
        if len(orig) != 1 or len(gt) != 1:
            raise RuntimeError(f"{tam}: original {orig}, ground truth {gt}")
        out.append((os.path.basename(cam_dir), orig[0], tam, gt[0]))
    return out


def semantic_mask(path, size):
    """Ground-truth map -> boolean mask of the semantic change (white, 255; collateral damage is grey, 128)."""
    g = np.asarray(Image.open(path).convert("L"))
    if g.shape[::-1] != size:
        return None
    return g >= 192


def process(job):
    i, (cam, orig_path, tam_path, gt_path) = job
    oid = f"{PREFIX}{i:03d}"
    meta_path = os.path.join(mv.META, oid + ".json")
    if os.path.exists(meta_path):
        return oid
    display = Image.open(orig_path).convert("RGB")
    forged = Image.open(tam_path).convert("RGB")
    if forged.size != display.size:
        raise RuntimeError(f"{tam_path}: size {forged.size} vs original {display.size}")
    W, H = display.size
    mask, mask_source = semantic_mask(gt_path, display.size), "ground truth"
    if mask is None:  # 9 COVERAGE maps have the wrong size: use the pixels that differ from the original instead
        if not COVERAGE:
            raise RuntimeError(f"{gt_path}: map size differs from the image")
        mask = np.abs(np.asarray(display, np.int32) - np.asarray(forged, np.int32)).max(axis=2) > 20
        mask_source = "difference"
    ys, xs = np.nonzero(mask)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    nbox = [box[0] / W, box[1] / H, box[2] / W, box[3] / H]
    T = 16
    cover = mask[: H // T * T, : W // T * T].reshape(T, H // T, T, W // T).mean(axis=(1, 3))
    mask_tiles = [int(t) for t in np.nonzero(cover.ravel() >= 0.05)[0]]  # cells at least 5% covered
    A, B = np.asarray(display, np.int32)[mask], np.asarray(forged, np.int32)[mask]
    ya = (19595 * A[:, 0] + 38470 * A[:, 1] + 7471 * A[:, 2]) >> 16
    yb = (19595 * B[:, 0] + 38470 * B[:, 1] + 7471 * B[:, 2]) >> 16
    magY, magRGB = float(np.abs(ya - yb).mean()), float(np.abs(A - B).mean())

    pt, deg, stored = mv.phone_thumb(orig_path)
    g = mv.grey256(display)
    ref = {"g": g, "ahash": mv.ahash(g), "dhash": mv.dhash(g), "bhash": mv.blockhash(g)}
    out = {"original": {"id": oid, "device": cam, "model": cam, "stored": stored, "exifDeg": deg, "display": display.size,
                        "bytes": os.path.getsize(orig_path), "file": os.path.relpath(orig_path, SRC),
                        "phoneThumb": mv.save_thumb(oid + "_phone", pt), "fullThumb": mv.save_thumb(oid + "_full", mv.thumbnails(display)),
                        "ahash": mv.bits_hex(ref["ahash"]), "dhash": mv.bits_hex(ref["dhash"]), "bhash": mv.bits_hex(ref["bhash"])},
           "variants": [], "parity": []}

    def add(vid, im, extra):
        v = {"id": vid, "ref": oid, "size": im.size, "thumb": mv.save_thumb(vid, mv.thumbnails(im)), "base": mv.baseline(ref, im)}
        v.update(extra)
        out["variants"].append(v)

    for pname in PLATFORMS:
        data = mv.platform(display, pname)
        add(f"{oid}_{pname}", mv.decode(data), {"kind": "clean", "real": False, "platform": pname, "bytes": len(data)})
    frac = float(mask.mean())
    size_class = "small" if frac < 0.01 else "medium" if frac < 0.05 else "large"
    saved = mv.encode(forged, 92)
    for pname in EDIT_PLATFORMS:
        im = forged if pname == "as_is" else mv.decode(saved if pname == "editor_save" else mv.platform(mv.decode(saved), pname))
        add(f"{oid}_forgery_{pname}", im, {"kind": "edit", "real": False, "edit": size_class, "frac": 0, "areaFrac": round(frac, 5),
                                           "platform": pname, "box": nbox, "maskTiles": mask_tiles, "maskSource": mask_source,
                                           "magY": round(magY, 3), "magRGB": round(magRGB, 3), "file": os.path.relpath(tam_path, SRC)})
    with open(meta_path + ".part", "w") as f:
        json.dump(out, f)
    os.replace(meta_path + ".part", meta_path)
    return oid


def main():
    os.makedirs(mv.THUMBS, exist_ok=True)
    os.makedirs(mv.META, exist_ok=True)
    pairs = find_pairs()
    print(len(pairs), "forgeries;", {c: sum(p[0] == c for p in pairs) for c in sorted({p[0] for p in pairs})}, flush=True)
    jobs = list(enumerate(pairs))
    if os.environ.get("LIMIT"):
        jobs = jobs[:int(os.environ["LIMIT"])]
    with Pool(WORKERS) as pool:
        for k, _ in enumerate(pool.imap_unordered(process, jobs), 1):
            if k % 20 == 0 or k == len(jobs):
                print(f"{k}/{len(jobs)}", flush=True)
    merged = {"originals": [], "variants": [], "parity": []}
    for i, _ in jobs:
        m = json.load(open(os.path.join(mv.META, f"{PREFIX}{i:03d}.json")))
        merged["originals"].append(m["original"])
        merged["variants"] += m["variants"]
    with open(os.path.join(OUT, "jobs.json"), "w") as f:
        json.dump(merged, f)
    print("originals:", len(merged["originals"]), "variants:", len(merged["variants"]))


if __name__ == "__main__":
    main()
