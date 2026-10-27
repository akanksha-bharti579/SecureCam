"""Neural perceptual hash baseline on exactly the same copies and edits as make_vision.py.

The descriptor is DINOv2 ViT-S/14 (Meta, self-supervised): the class token of the whole photo resized to 224 x 224
(no crop, so an edit near the border is still seen), L2-normalised. Two scores are kept for every copy:

  * cos:  cosine distance between the copy's descriptor and the original's (the best case for a neural descriptor);
  * h96:  Hamming distance of a 96-bit hash made from the descriptor by random-hyperplane LSH with a fixed seed
          (the construction NeuralHash uses: a neural embedding projected and binarised to 96 bits).

Copies and edits are rebuilt with the code of make_vision.py (same random seed) and checked against its stored record
(same file size, same edit box), as in baselines_vision.py. Real WhatsApp/Facebook files are scored in the best of four
rotations, as PDQ is. After all photos are done, every copy is also compared with every other original, to count
matches to a different photo.

Needs the environment of baselines_vision.py (torch CPU, numpy==2.5.2, pillow==12.3.0) and the DINOv2 hub code and
ViT-S/14 weights in the torch hub cache.

Usage: python neural_vision.py <vision_dir> <out_dir> [workers=3]   (resumable; writes <out_dir>/neural/, then
<out_dir>/neural.json). neural_score.js scores the result.
"""
import base64
import hashlib
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
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
sys.path.insert(0, HERE)
_argv, sys.argv = sys.argv, [sys.argv[0], SRC, OUT]  # make_vision reads its paths from argv on import
import make_vision as mv  # noqa: E402
sys.argv = _argv

BASE = os.path.join(OUT, "neural")
HUB = os.path.expanduser("~/.cache/torch/hub/facebookresearch_dinov2_main")
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)
LSH_BITS, LSH_SEED = 96, 2026
MODEL = None


def init_worker():
    global MODEL
    warnings.filterwarnings("ignore")
    import torch
    torch.set_num_threads(2)
    MODEL = torch.hub.load(HUB, "dinov2_vits14", source="local", verbose=False).eval()


def embed(imgs):
    import torch
    x = np.stack([(np.asarray(im.convert("RGB").resize((224, 224), Image.BICUBIC), np.float32) / 255 - MEAN) / STD for im in imgs])
    with torch.inference_mode():
        e = MODEL(torch.from_numpy(x.transpose(0, 3, 1, 2).copy())).numpy().astype(np.float32)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


b64 = lambda e: base64.b64encode(e.astype(np.float32).tobytes()).decode()
unb64 = lambda s: np.frombuffer(base64.b64decode(s), np.float32)


def process(job):
    entry, other_path = job
    oid = entry["id"]
    dest = os.path.join(BASE, oid + ".json")
    if os.path.exists(dest):
        return oid
    meta = json.load(open(os.path.join(OUT, "meta", oid + ".json")))
    stored = {v["id"]: v for v in meta["variants"]}
    nat = os.path.join(SRC, entry["files"]["nat"])
    display = ImageOps.exif_transpose(Image.open(nat)).convert("RGB")
    W, H = display.size
    ref = embed([display])[0]
    res = {"id": oid, "emb": b64(ref), "variants": {}}

    def score(vid, im, rot=False):
        if vid not in stored:
            raise RuntimeError(f"{vid}: not in make_vision's record")
        ims = [im.rotate(90 * k, expand=True) for k in range(4)] if rot else [im]
        es = embed(ims)
        k = int(np.argmax(es @ ref))
        res["variants"][vid] = {"emb": b64(es[k]), "rot": 90 * k}

    for key, pname in mv.REAL.items():
        if key in entry["files"]:
            score(f"{oid}_{pname}", ImageOps.exif_transpose(Image.open(os.path.join(SRC, entry["files"][key]))).convert("RGB"), rot=True)

    for pname in list(mv.PLATFORMS) + ["wa_then_telegram"]:
        vid = f"{oid}_{pname}"
        data = mv.platform(display, pname)
        if len(data) != stored[vid]["bytes"]:
            raise RuntimeError(f"{vid}: rebuilt copy differs from make_vision's ({len(data)} vs {stored[vid]['bytes']} bytes)")
        score(vid, mv.decode(data))

    rng = random.Random(int(hashlib.sha256(oid.encode()).hexdigest()[:12], 16))
    for kind, frac in mv.EDITS:
        edited, box = mv.apply_edit(rng, display, kind, frac, other_path)
        nbox = [box[0] / W, box[1] / H, box[2] / W, box[3] / H]
        if max(abs(x - y) for x, y in zip(nbox, stored[f"{oid}_{kind}{frac}_editor_save"]["box"])) > 1e-12:
            raise RuntimeError(f"{oid} {kind}{frac}: edit box differs from make_vision's")
        saved = mv.encode(edited, 92)
        for pname in mv.EDIT_PLATFORMS:
            data = saved if pname == "editor_save" else mv.platform(mv.decode(saved), pname)
            score(f"{oid}_{kind}{frac}_{pname}", mv.decode(data))

    missing = set(stored) - set(res["variants"])
    if missing:
        raise RuntimeError(f"{oid}: {len(missing)} copies not rebuilt")
    with open(dest + ".part", "w") as f:
        json.dump(res, f)
    os.replace(dest + ".part", dest)
    return oid


def merge(ids):
    """Scores against the own original, and the closest other original, for every copy."""
    P = np.random.default_rng(LSH_SEED).standard_normal((384, LSH_BITS)).astype(np.float32)
    bits = lambda e: (e @ P) > 0
    recs = [json.load(open(os.path.join(BASE, i + ".json"))) for i in ids]
    R = np.stack([unb64(r["emb"]) for r in recs])
    RB = bits(R)
    out = {"model": "DINOv2 ViT-S/14, class token, 224x224 no crop", "lshBits": LSH_BITS, "lshSeed": LSH_SEED, "variants": {}}
    out["pairs"] = {"minCos": float(1 - (R @ R.T - 2 * np.eye(len(R))).max()),
                    "minH96": int(min((RB[i] != RB[j]).sum() for i in range(len(R)) for j in range(i + 1, len(R))))}
    for i, r in enumerate(recs):
        vids = list(r["variants"])
        E = np.stack([unb64(r["variants"][v]["emb"]) for v in vids])
        C = 1 - E @ R.T
        Hd = (bits(E)[:, None, :] != RB[None, :, :]).sum(2)
        C[:, i] = Hd[:, i] = 10 ** 9  # mask the own original for the "other photo" columns
        own_c, own_h = 1 - E @ R[i], (bits(E) != RB[i]).sum(1)
        for k, v in enumerate(vids):
            out["variants"][v] = {"cos": round(float(own_c[k]), 6), "h96": int(own_h[k]), "otherCos": round(float(C[k].min()), 6),
                                  "otherH96": int(Hd[k].min()), "rot": r["variants"][v]["rot"]}
    json.dump(out, open(os.path.join(OUT, "neural.json"), "w"))
    print("photos:", len(recs), "copies:", len(out["variants"]))


def main():
    os.makedirs(BASE, exist_ok=True)
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
    merge([e["id"] for e, _ in jobs])


if __name__ == "__main__":
    main()
