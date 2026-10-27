"""Per-forgery summary of the public tampering sets (Korus, COVERAGE, IMD2020) for the paper.

Every forgery was checked through three paths (as found, editor save, editor save + WhatsApp-like profile). The
three copies of one forgery are not independent, so the paper counts forgeries: a forgery is rejected if the verifier
rejected it (MODIFIED or UNVERIFIED) on all three paths. Reads <dataset>_out/decisions.json and jobs.json written
by analyze_vision.js / make_korus.py / make_imd.py, and results_<name>.json. Writes results_external.json.

Usage: python external_summary.py <datasets dir>
"""
import collections
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DS = sys.argv[1]


def wilson(k, n, z=1.96):
    if not n:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [100 * (c - h) / d, 100 * (c + h) / d]


out = {}
for name, folder, res in (("Korus", "Korus_out", "korus"), ("COVERAGE", "COVERAGE_out", "coverage"), ("IMD2020", "IMD2020_out", "imd2020")):
    dec = json.load(open(os.path.join(DS, folder, "decisions.json")))
    jobs = json.load(open(os.path.join(DS, folder, "jobs.json")))
    R = json.load(open(os.path.join(HERE, f"results_{res}.json")))
    var = {v["id"]: v for v in jobs["variants"]}
    forg = collections.defaultdict(list)
    for vid, d in dec.items():
        forg[vid.rsplit("_", 2)[0]].append((vid, d))
    allf = len(forg)
    vis = {k: v for k, v in forg.items() if all(d["visible"] for _, d in v)}
    if any(len(v) != 3 for v in forg.values()):
        raise SystemExit(f"{name}: a forgery without three paths")
    e = {"originals": R["photos"], "forgeries": allf, "visibleForgeries": len(vis), "copies": R["counts"]["edits"],
         "visibleCopies": R["counts"]["visible"], "cleanCopies": R["counts"]["clean"], "modes": {}}
    for mode, key in (("standard", "defaultsAll"), ("strict", "strictAll")):
        rej = lambda d: d[mode]["label"] != "AUTHENTIC_COPY"
        allp = sum(all(rej(d) for _, d in v) for v in vis.values())
        some = sum(any(rej(d) for _, d in v) for v in vis.values()) - allp
        marked = sum(all(d[mode]["label"] == "MODIFIED" and d[mode]["id"] == d["ref"] for _, d in v) for v in vis.values())
        e["modes"][mode] = {"rejectedAllPaths": allp, "rejectedSomePaths": some, "ci": wilson(allp, len(vis)),
                            "markedAllPaths": marked, "cleanAccepted": R[key]["cleanOk"], "clean": R[key]["clean"],
                            "falseAccepts": R[key]["falseAccept"], "copiesRejected": R[key]["caught"]}
    # forgeries the standard mode missed (not rejected on every path), by share of the image changed; crops excluded
    miss, tot = collections.Counter(), collections.Counter()
    for v in vis.values():
        x = var[v[0][0]]
        if x.get("geometry") == "cropped":
            continue
        c = "under1" if x["areaFrac"] < 0.01 else "1to5" if x["areaFrac"] < 0.05 else "over5"
        tot[c] += 1
        miss[c] += not all(d["standard"]["label"] != "AUTHENTIC_COPY" for _, d in v)
    e["standardMissedByArea"] = {c: [miss[c], tot[c]] for c in ("under1", "1to5", "over5")}
    e["ssimRegionsAuc"] = R["roc"]["SSIM regions on signed thumbnail"]["auc"]
    e["oursAuc"] = R["roc"]["scfp1 regions (this work)"]["auc"]
    if name == "IMD2020":
        geo = {}
        for g in ("same", "resized", "cropped"):
            fs = {k: v for k, v in vis.items() if var[v[0][0]]["geometry"] == g}
            row = {"forgeries": len(fs)}
            for mode in ("standard", "strict"):
                labels = collections.Counter(d[mode]["label"] for v in fs.values() for _, d in v)
                row[mode] = {"rejectedAllPaths": sum(all(d[mode]["label"] != "AUTHENTIC_COPY" for _, d in v) for v in fs.values()),
                             "markedAllPaths": sum(all(d[mode]["label"] == "MODIFIED" and d[mode]["id"] == d["ref"] for _, d in v) for v in fs.values()),
                             "copyLabels": dict(labels)}
            geo[g] = row
        e["geometry"] = geo
        e["allForgeriesInDataset"] = len(forg)
    out[name] = e
    print(name, json.dumps({k: v for k, v in e.items() if k != "geometry"}, indent=None)[:400])
json.dump(out, open(os.path.join(HERE, "results_external.json"), "w"), indent=1)
print("wrote results_external.json")
