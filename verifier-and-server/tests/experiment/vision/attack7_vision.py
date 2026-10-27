"""Stronger adaptive attacker (extends attack_vision.py). The attacker knows the fingerprint, can run the verifier as
often as it likes (verify_server.js), and wants to put content from another photograph into an aligned block of
s x s fingerprint cells (s = 8, 16, 32; a block of 32 x 32 cells is 1/16 of the image) of a signed photo, so that
the copy sent through the WhatsApp-like profile is still accepted. Attacks:

  paste      the block replaced, no correction (reference)
  meanfix    every cell shifted once so its mean R, G, B equal the original's (as attack_vision.py; clipping breaks it)
  project    the same, repeated until the cell means match despite clipping (alternating projection, <= 30 rounds)
  reencode   project, then corrected for the re-encoding: the copy is sent through the profile, its fingerprint is
             compared with the signed one, and the cell targets are moved against the error (3 rounds)
  oracle     a natural blend original + a (paste - original), no mean correction; the verifier (strict mode) is
             queried and a is halved in every flagged region, until accepted or 10 queries

For each attacked copy: verdict in the standard and the strict mode, the visible change (mean luma change in the
block, as everywhere else), and how much of the inserted content survives: SSIM between the block and the inserted
patch, minus the SSIM between the original block and the patch (0 = nothing of the patch is visible, as for the
original; for the plain paste it is the largest possible value).

Usage: python attack7_vision.py <VISION dir> <VISION_out dir> [photos=150] [workers=3]  -> results_attack7.md / .json
"""
import hashlib
import json
import os
import random
import subprocess
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = sys.argv[1], sys.argv[2]
PHOTOS = int(sys.argv[3]) if len(sys.argv) > 3 else 150
WORKERS = int(sys.argv[4]) if len(sys.argv) > 4 else 3
sys.path.insert(0, HERE)
_argv, sys.argv = sys.argv, [sys.argv[0], SRC, OUT]
import attack_vision as av  # noqa: E402  (thumbnails, whatsapp_like, cell_edges, visible)
import make_vision as mv  # noqa: E402  (ssim_map)
sys.argv = _argv

N, TILES = 128, 16
SIZES = (8, 16, 32)
_oracle = None


def oracle(ref_bytes, img):
    """Verdicts of the real verifier for the copy of img sent through the WhatsApp-like profile."""
    global _oracle
    if _oracle is None:
        _oracle = subprocess.Popen(["node", os.path.join(HERE, "verify_server.js")], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    cand = av.thumbnails(av.whatsapp_like(img))
    _oracle.stdin.write(ref_bytes + cand)
    _oracle.stdin.flush()
    return json.loads(_oracle.stdout.readline()), cand


def grey128(a):
    return np.asarray(Image.fromarray(a.round().clip(0, 255).astype(np.uint8)).convert("L").resize((128, 128), Image.BOX), np.float64)


def ssim(a, b):
    return float(mv.ssim_map(grey128(a), grey128(b)).mean())


def process(job):
    o, other = job
    rng = random.Random(int(hashlib.sha256((o["id"] + "attack7").encode()).hexdigest()[:12], 16))
    img = ImageOps.exif_transpose(Image.open(os.path.join(SRC, o["file"]))).convert("RGB")
    W, H = img.size
    xs, ys = av.cell_edges(W), av.cell_edges(H)
    base = np.asarray(img).astype(np.float64)
    ref_bytes = open(os.path.join(OUT, "thumbs", o["id"] + "_phone.bin"), "rb").read()
    ref_y = np.frombuffer(ref_bytes[:N * N], np.uint8).reshape(N, N).astype(np.float64)
    oth = ImageOps.exif_transpose(Image.open(os.path.join(SRC, other))).convert("RGB")
    rows = []
    for s in SIZES:
        c0, r0 = rng.randrange(0, N - s + 1), rng.randrange(0, N - s + 1)
        bx0, by0, bx1, by1 = xs[c0], ys[r0], xs[c0 + s], ys[r0 + s]
        box = (bx0, by0, bx1, by1)
        patch = np.asarray(oth.resize((bx1 - bx0, by1 - by0), Image.BICUBIC)).astype(np.float64)
        cells = [(r, c) for r in range(r0, r0 + s) for c in range(c0, c0 + s)]
        sl = {rc: (slice(ys[rc[0]], ys[rc[0] + 1]), slice(xs[rc[1]], xs[rc[1] + 1])) for rc in cells}
        target = {rc: base[sl[rc]].mean(axis=(0, 1)) for rc in cells}
        ssim_orig = ssim(base[by0:by1, bx0:bx1], patch)
        pasted = base.copy()
        pasted[by0:by1, bx0:bx1] = patch

        def emit(name, e, extra=None):
            e8 = Image.fromarray(e.round().clip(0, 255).astype(np.uint8))
            v, _ = oracle(ref_bytes, e8)
            magY, magRGB = av.visible(img, e8, box)
            r = {"id": f"{o['id']}_{name}_{s}", "ref": o["id"], "attack": name, "cells": s, "standard": v["standard"]["verdict"],
                 "strict": v["strict"]["verdict"], "magY": magY, "magRGB": magRGB,
                 "content": ssim(np.asarray(e8, np.float64)[by0:by1, bx0:bx1], patch) - ssim_orig}
            r.update(extra or {})
            rows.append(r)

        def project(e, tgt, rounds=30):
            for k in range(rounds):
                err = 0.0
                for rc in cells:
                    blk = e[sl[rc]]
                    blk += tgt[rc] - blk.mean(axis=(0, 1))
                    np.clip(blk, 0, 255, out=blk)
                    err = max(err, float(np.abs(tgt[rc] - blk.mean(axis=(0, 1))).max()))
                if err < 0.3:
                    return k + 1, err
            return rounds, err

        emit("paste", pasted)
        e = pasted.copy()
        project(e, target, rounds=1)
        emit("meanfix", e)
        e = pasted.copy()
        k, err = project(e, target)
        emit("project", e, {"rounds": k, "residual": err})
        tgt = dict(target)
        for _ in range(3):
            _, cand = oracle(ref_bytes, Image.fromarray(e.round().clip(0, 255).astype(np.uint8)))
            cy = np.frombuffer(cand[:N * N], np.uint8).reshape(N, N).astype(np.float64)
            for rc in cells:
                tgt[rc] = tgt[rc] - (cy[rc] - ref_y[rc])  # move the cell target against the luma error after re-encoding
            project(e, tgt)
        emit("reencode", e)
        alpha = {rc: 1.0 for rc in cells}
        queries = 0
        while True:
            e = base.copy()
            for rc in cells:
                e[sl[rc]] = base[sl[rc]] + alpha[rc] * (pasted[sl[rc]] - base[sl[rc]])
            v, _ = oracle(ref_bytes, Image.fromarray(e.round().clip(0, 255).astype(np.uint8)))
            queries += 1
            if v["strict"]["verdict"] == "ACCEPTED" or queries >= 10:
                break
            flagged = set(v["strict"]["changed"])
            hit = [rc for rc in cells if (rc[0] // (N // TILES)) * TILES + rc[1] // (N // TILES) in flagged]
            if not hit:  # rejected without a flagged region in the block (e.g. the lookup failed): weaken everywhere
                hit = cells
            for rc in hit:
                alpha[rc] *= 0.5
        emit("oracle", e, {"queries": queries, "meanAlpha": float(np.mean(list(alpha.values())))})
    return rows


def safe_process(job):
    try:
        return process(job)
    except Exception as e:  # one bad photo must not stop the run
        print(f"{job[0]['id']} failed: {type(e).__name__}: {e}", flush=True)
        return []


def main():
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
    work = [({"id": o["id"], "file": files[o["id"]]}, files[chosen[(k + len(chosen) // 2) % len(chosen)]["id"]]) for k, o in enumerate(chosen)]
    if os.environ.get("LIMIT"):
        work = work[:int(os.environ["LIMIT"])]
    rows = []
    with Pool(WORKERS) as pool:
        for k, r in enumerate(pool.imap_unordered(safe_process, work), 1):
            rows += r
            if k % 10 == 0 or k == len(work):
                print(f"{k}/{len(work)} photos", flush=True)
    json.dump({"photos": [w[0]["id"] for w in work], "rows": rows}, open(os.path.join(OUT, "attack7.json"), "w"))
    vis = lambda r: r["magY"] >= 10 or r["magRGB"] >= 10
    names = {"paste": "Paste, no correction", "meanfix": "Cell means corrected once", "project": "Cell means matched (repeated)",
             "reencode": "Matched, corrected for re-encoding", "oracle": "Blend weakened where the verifier flags it"}
    lines = [f"# Stronger adaptive attacker ({len(work)} VISION test photos, WhatsApp-like re-encoding)\n",
             "| attack | block (cells) | copies | visible | accepted: standard | accepted: strict | mean luma change | content kept (SSIM gain) |",
             "|---|---|---|---|---|---|---|---|"]
    out = {"photos": len(work), "summary": []}
    for a in names:
        for s in SIZES:
            g = [r for r in rows if r["attack"] == a and r["cells"] == s]
            v = [r for r in g if vis(r)]
            row = {"attack": a, "cells": s, "copies": len(g), "visible": len(v),
                   "acceptedStandard": sum(r["standard"] == "ACCEPTED" for r in v), "acceptedStrict": sum(r["strict"] == "ACCEPTED" for r in v),
                   "magY": float(np.mean([r["magY"] for r in v])) if v else 0.0, "content": float(np.mean([r["content"] for r in v])) if v else 0.0}
            if a == "oracle":
                row["queries"] = float(np.mean([r["queries"] for r in g])); row["meanAlpha"] = float(np.mean([r["meanAlpha"] for r in g]))
            out["summary"].append(row)
            pc = lambda k: f"{k}/{row['visible']} ({100 * k / max(1, row['visible']):.1f}%)"
            lines.append(f"| {names[a]} | {s} × {s} | {len(g)} | {len(v)} | {pc(row['acceptedStandard'])} | {pc(row['acceptedStrict'])} | "
                         f"{row['magY']:.1f} | {row['content']:.3f} |")
    lines.append("\nVisible: mean change in the block of at least 10 levels. Content kept: SSIM(block, inserted patch) minus "
                 "SSIM(original block, inserted patch), on a 128 x 128 greyscale reduction of the block.")
    open(os.path.join(HERE, "results_attack7.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    json.dump(out, open(os.path.join(HERE, "results_attack7.json"), "w"), indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
