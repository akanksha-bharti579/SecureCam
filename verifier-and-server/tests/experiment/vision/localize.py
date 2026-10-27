"""How well the regions that the verifier marks as changed cover the edited area (pixel- and region-level F1 / IoU).

Input: a dataset folder from make_vision.py or make_korus.py, with decisions.json written by analyze_vision.js
(DECISIONS=<out_dir>/decisions.json). Ground truth:
  * Korus: the "semantic change" class of the map (white). Collateral damage (grey) is ignored: it counts neither as
    a hit nor as a false alarm.
  * COVERAGE: the forged (pasted) region mask; for the 9 maps of the wrong size, the pixels that differ from the original.
  * VISION (synthetic edits): the edit rectangle. For text overlays the rectangle is larger than the letters.

Prediction: the union of the 16 x 16 grid regions that the verifier marked, for copies it reported as MODIFIED
against the photo's own record; any other verdict predicts nothing (F1 = IoU = 0), as is usual when averaging over
all forged images. Region level: a region is edited if at least 10% of it is ground truth, authentic if none of it
is, and ignored in between.

Usage: python localize.py <name> <out_dir> [src_dir]   -> <out_dir>/localize.json; summarise with localize.py --report
"""
import json
import os
import sys

import numpy as np
from PIL import Image

T = 16


def tile_mask(changed, h, w):
    m = np.zeros((h, w), bool)
    for t in changed:
        r, c = divmod(t, T)
        m[r * h // T:(r + 1) * h // T, c * w // T:(c + 1) * w // T] = True
    return m


def scores(pred, gt, ignore):
    keep = ~ignore
    p, g = pred & keep, gt & keep
    tp = int((p & g).sum()); fp = int((p & ~g).sum()); fn = int((~p & g).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
    iou = tp / (tp + fp + fn) if tp else 0.0
    return prec, rec, f1, iou


def region_level(pred_tiles, gt, ignore):
    h, w = gt.shape
    pos, neg = set(), set()
    for t in range(T * T):
        r, c = divmod(t, T)
        sl = (slice(r * h // T, (r + 1) * h // T), slice(c * w // T, (c + 1) * w // T))
        k = ~ignore[sl]
        cover = (gt[sl] & k).sum() / max(1, k.sum())
        if cover >= 0.10:
            pos.add(t)
        elif cover == 0:
            neg.add(t)
    pred = set(pred_tiles)
    tp, fp, fn = len(pred & pos), len(pred & neg), len(pos - pred)
    return (2 * tp / (2 * tp + fp + fn) if tp else 0.0), (tp / (tp + fp + fn) if tp else 0.0)


def ground_truth(name, v, orig, src):
    """(gt, ignore) boolean arrays at the photo's display size, or a normalised 1024 x 1024 grid for VISION boxes."""
    if name == "VISION":
        n = 1024
        gt = np.zeros((n, n), bool)
        x0, y0, x1, y1 = v["box"]
        gt[int(round(y0 * n)):int(round(y1 * n)), int(round(x0 * n)):int(round(x1 * n))] = True
        return gt, np.zeros_like(gt)
    if name == "IMD2020":  # hand-drawn mask at the manipulated file's size
        g = np.asarray(Image.open(os.path.join(src, v["mask"])).convert("L"))
        return g >= 128, np.zeros(g.shape, bool)
    tam = os.path.join(src, v["file"])
    if v.get("maskSource") == "difference":
        a = np.asarray(Image.open(os.path.join(src, orig["file"])).convert("RGB"), np.int32)
        b = np.asarray(Image.open(tam).convert("RGB"), np.int32)
        gt = np.abs(a - b).max(axis=2) > 20
        return gt, np.zeros_like(gt)
    if name == "Korus":
        g = np.asarray(Image.open(tam.replace("tampered-realistic", "ground-truth")[:-4] + ".PNG").convert("L"))
        return g >= 192, (g > 0) & (g < 192)
    stem = os.path.basename(tam)[:-5]  # COVERAGE image/<n>t.tif -> mask/<n>forged.tif
    g = np.asarray(Image.open(os.path.join(src, "mask", stem + "forged.tif")).convert("L"))
    return g >= 128, np.zeros(g.shape, bool)


def run(name, out_dir, src):
    jobs = json.load(open(os.path.join(out_dir, "jobs.json")))
    dec = json.load(open(os.path.join(out_dir, "decisions.json")))
    origs = {o["id"]: o for o in jobs["originals"]}
    cache, rows = {}, []
    for v in jobs["variants"]:
        if v["kind"] != "edit" or not dec[v["id"]]["visible"]:
            continue
        d = dec[v["id"]]
        key = v.get("file") or v["id"].rsplit("_", 1)[0]  # the same edit through several paths shares its ground truth
        if key not in cache:
            cache = {key: ground_truth(name, v, origs[v["ref"]], src)}
        gt, ign = cache[key]
        row = {"id": v["id"], "split": d["split"], "edit": v.get("edit"), "platform": v["platform"], "area": float(gt.mean()),
               "geometry": v.get("geometry")}
        for mode in ("standard", "strict"):
            m = d[mode]
            flagged = m["label"] == "MODIFIED" and m["id"] == v["ref"]
            pred = tile_mask(m["changed"], *gt.shape) if flagged else np.zeros_like(gt)
            p, r, f1, iou = scores(pred, gt, ign)
            rf1, riou = region_level(m["changed"] if flagged else [], gt, ign)
            row[mode] = {"flagged": flagged, "label": m["label"], "precision": p, "recall": r, "f1": f1, "iou": iou, "rf1": rf1, "riou": riou}
        rows.append(row)
    json.dump({"name": name, "rows": rows}, open(os.path.join(out_dir, "localize.json"), "w"))
    print(name, len(rows), "visible edited copies")


def report(paths, md, js):
    out, lines = {}, []
    lines.append("# Localization of the marked regions\n")
    lines.append("Generated by `localize.py`. Mean over visibly edited copies; copies not reported as MODIFIED count as 0. "
                 "\"flagged\" = mean over the copies reported as MODIFIED. Region level: 16 x 16 grid, a region is edited "
                 "if at least 10% of it is ground truth.\n")
    lines.append("| dataset | part | mode | copies | flagged | pixel F1 | pixel IoU | pixel F1 (flagged) | precision (flagged) | recall (flagged) | region F1 | region IoU |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    mean = lambda a: float(np.mean(a)) if len(a) else 0.0
    for p in paths:
        L = json.load(open(p))
        groups = [("all", L["rows"])]
        if L["name"] == "IMD2020":
            for gm in ("same", "resized", "cropped"):
                groups.append((gm + " size", [r for r in L["rows"] if r["geometry"] == gm]))
        if L["name"] == "VISION":
            groups = [("test", [r for r in L["rows"] if r["split"] == "test"])]
            for e in sorted({r["edit"] for r in groups[0][1]}):
                groups.append(("test, " + e, [r for r in groups[0][1] if r["edit"] == e]))
        for gname, rows in groups:
            for mode in ("standard", "strict"):
                fl = [r[mode] for r in rows if r[mode]["flagged"]]
                s = {"copies": len(rows), "flagged": len(fl), "f1": mean([r[mode]["f1"] for r in rows]), "iou": mean([r[mode]["iou"] for r in rows]),
                     "f1Flagged": mean([x["f1"] for x in fl]), "precisionFlagged": mean([x["precision"] for x in fl]), "recallFlagged": mean([x["recall"] for x in fl]),
                     "rf1": mean([r[mode]["rf1"] for r in rows]), "riou": mean([r[mode]["riou"] for r in rows]), "area": mean([r["area"] for r in rows])}
                out[f"{L['name']}|{gname}|{mode}"] = s
                lines.append(f"| {L['name']} | {gname} | {mode} | {s['copies']} | {s['flagged']} | {s['f1']:.3f} | {s['iou']:.3f} | {s['f1Flagged']:.3f} | "
                             f"{s['precisionFlagged']:.3f} | {s['recallFlagged']:.3f} | {s['rf1']:.3f} | {s['riou']:.3f} |")
    open(md, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    json.dump(out, open(js, "w"), indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    if sys.argv[1] == "--report":
        here = os.path.dirname(os.path.abspath(__file__))
        report(sys.argv[2:], os.path.join(here, "results_localize.md"), os.path.join(here, "results_localize.json"))
    else:
        run(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
