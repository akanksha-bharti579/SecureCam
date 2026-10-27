"""Adaptive-attacker test on VISION test-split photos (the attacker knows how the fingerprint works).

Attacks, each followed by the WhatsApp-like re-encoding (1600 px, JPEG q75):
  size_<s>   a patch of s x s fingerprint cells copied from elsewhere in the same photo (unaligned): how small an
             edit can the comparison see?
  paste_<s>  an s x s-cell region replaced by content from another photo (aligned to the cell grid), no correction
  meanfix_<s> the same paste, then every cell is shifted so that its mean R, G and B equal the original's:
             the fingerprint (cell means) is preserved by construction, the content is not.

Usage: python attack_vision.py <VISION dir> <VISION_out dir> [photos=300] [workers=6]
Writes <VISION_out>/attack/attack_jobs.json and thumbnails; score with attack_score.js.
"""
import hashlib
import io
import json
import os
import random
import struct
import subprocess
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageOps

SRC, OUT = sys.argv[1], sys.argv[2]
PHOTOS = int(sys.argv[3]) if len(sys.argv) > 3 else 300
WORKERS = int(sys.argv[4]) if len(sys.argv) > 4 else 6
ADIR = os.path.join(OUT, "attack")
N = 128
_node = None


def thumbnails(img):
    """scfp1 thumbnail via securecam-core.js (thumb_server.js), as in make_vision.py."""
    global _node
    if _node is None:
        _node = subprocess.Popen(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumb_server.js")],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    w, h = img.size
    _node.stdin.write(struct.pack("<II", w, h))
    _node.stdin.write(img.convert("RGBA").tobytes())
    _node.stdin.flush()
    out = _node.stdout.read(18432)
    if len(out) != 18432:
        raise RuntimeError("thumb_server.js stopped")
    return out


def whatsapp_like(img):
    w, h = img.size
    s = min(1.0, 1600 / max(w, h))
    if s < 1:
        img = img.resize((round(w * s), round(h * s)), Image.BICUBIC)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=75)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


def cell_edges(n_px):
    """Pixel x belongs to cell floor(128 x / W), as in the fingerprint."""
    return [next(x for x in range(n_px) if (x * N) // n_px >= c) for c in range(N)] + [n_px]


def visible(a, b, box):
    A = np.asarray(a.crop(box)).astype(np.int32)
    B = np.asarray(b.crop(box)).astype(np.int32)
    ya = (19595 * A[..., 0] + 38470 * A[..., 1] + 7471 * A[..., 2]) >> 16
    yb = (19595 * B[..., 0] + 38470 * B[..., 1] + 7471 * B[..., 2]) >> 16
    return float(np.abs(ya - yb).mean()), float(np.abs(A - B).mean())


def process(job):
    o, other = job
    rng = random.Random(int(hashlib.sha256(o["id"].encode()).hexdigest()[:12], 16))
    img = ImageOps.exif_transpose(Image.open(os.path.join(SRC, o["file"]))).convert("RGB")
    W, H = img.size
    xs, ys = cell_edges(W), cell_edges(H)
    base = np.asarray(img).astype(np.float64)
    oth = ImageOps.exif_transpose(Image.open(os.path.join(SRC, other))).convert("RGB")
    rows = []

    def emit(name, cells, edited, box, extra=None):
        magY, magRGB = visible(img, edited, box)
        tid = f"{o['id']}_{name}"
        with open(os.path.join(ADIR, tid + ".bin"), "wb") as f:
            f.write(thumbnails(whatsapp_like(edited)))
        r = {"id": tid, "ref": o["id"], "attack": name.rsplit("_", 1)[0], "cells": cells, "magY": magY, "magRGB": magRGB, "thumb": tid}
        r.update(extra or {})
        rows.append(r)

    # 1. copy-move patches of s x s cells (not aligned), from a random other place in the photo
    cw, ch = W / N, H / N
    for s in (1, 2, 4, 8):
        pw, ph = max(1, round(s * cw)), max(1, round(s * ch))
        x0, y0 = rng.randrange(0, W - pw), rng.randrange(0, H - ph)
        sx, sy = rng.randrange(0, W - pw), rng.randrange(0, H - ph)
        e = img.copy()
        e.paste(img.crop((sx, sy, sx + pw, sy + ph)), (x0, y0))
        emit(f"size_{s}", s, e, (x0, y0, x0 + pw, y0 + ph))

    # 2. paste from another photo on an aligned s x s cell block; 3. the same with per-cell mean correction
    for s in (4, 8):
        c0, r0 = rng.randrange(0, N - s), rng.randrange(0, N - s)
        bx0, by0, bx1, by1 = xs[c0], ys[r0], xs[c0 + s], ys[r0 + s]
        patch = np.asarray(oth.resize((bx1 - bx0, by1 - by0), Image.BICUBIC)).astype(np.float64)
        e = base.copy()
        e[by0:by1, bx0:bx1] = patch
        emit(f"paste_{s}", s, Image.fromarray(e.round().clip(0, 255).astype(np.uint8)), (bx0, by0, bx1, by1))
        clipped = 0
        for r in range(r0, r0 + s):
            for c in range(c0, c0 + s):
                ya, yb, xa, xb = ys[r], ys[r + 1], xs[c], xs[c + 1]
                blk = e[ya:yb, xa:xb]
                shifted = blk + (base[ya:yb, xa:xb].mean(axis=(0, 1)) - blk.mean(axis=(0, 1)))
                clipped += int(((shifted < 0) | (shifted > 255)).any(axis=2).sum())
                e[ya:yb, xa:xb] = shifted
        emit(f"meanfix_{s}", s, Image.fromarray(e.round().clip(0, 255).astype(np.uint8)), (bx0, by0, bx1, by1),
             {"clippedPixels": clipped, "areaPixels": (bx1 - bx0) * (by1 - by0)})
    return rows


def main():
    os.makedirs(ADIR, exist_ok=True)
    jobs = json.load(open(os.path.join(OUT, "jobs.json"), encoding="utf-8"))
    files = {e["id"]: e["files"]["nat"] for e in json.load(open(os.path.join(SRC, "index.json"), encoding="utf-8"))}
    per, test = {}, []
    for o in jobs["originals"]:  # same split rule as analyze_vision.js
        i = per.get(o["device"], 0)
        per[o["device"]] = i + 1
        if i % 10 >= 3:
            test.append(o)
    step = max(1, len(test) // PHOTOS)
    chosen = test[::step][:PHOTOS]
    work = [({"id": o["id"], "file": files[o["id"]]}, files[chosen[(k + len(chosen) // 2) % len(chosen)]["id"]])
            for k, o in enumerate(chosen)]
    rows = []
    with Pool(WORKERS) as pool:
        for k, r in enumerate(pool.imap_unordered(process, work)):
            rows += r
            if k % 25 == 0:
                print(f"{k + 1}/{len(work)} photos", flush=True)
    json.dump({"photos": [w[0]["id"] for w in work], "variants": rows}, open(os.path.join(ADIR, "attack_jobs.json"), "w"))
    print("wrote", len(rows), "attacked copies")


if __name__ == "__main__":
    main()
