"""Figures for the paper from results_vision.json (written by analyze_vision.js).

Usage: python plot_vision.py <results_vision.json> <figures_dir>
"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

R = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
plt.rcParams.update({"font.family": "Times New Roman", "font.size": 9, "axes.linewidth": 0.6})

STYLE = {  # result key: (legend label, colour, line style, width)
    "scfp1 regions (this work)": ("Region comparison (this work)", "#c0392b", "-", 2.0),
    "SSIM regions on signed thumbnail": ("Regional SSIM, signed thumbnail", "#e67e22", "-", 1.3),
    "SSIM (min of 256 regions)": ("Regional SSIM, 256 x 256 image", "#2c3e50", "--", 1.3),
    "PSNR": ("PSNR", "#7f8c8d", "-.", 1.1),
    "SSIM (global)": ("Global SSIM", "#2980b9", "--", 1.1),
    "pHash 64-bit": ("DCT hash (pHash)", "#27ae60", "-", 1.1),
    "BlockHash 256-bit": ("Block mean hash", "#8e44ad", ":", 1.3),
    "aHash 64-bit": ("Average hash", "#d35400", ":", 1.1),
    "dHash 64-bit": ("Difference hash", "#16a085", "-.", 1.1),
}

# ROC: share of unedited copies accepted against share of edited copies accepted
fig, ax = plt.subplots(figsize=(3.5, 4.1), dpi=300)
for name, (label, col, ls, lw) in STYLE.items():
    r = R["roc"][name]
    xs = [max(p[0], 1e-4) for p in r["pts"]]
    ys = [p[1] for p in r["pts"]]
    ax.plot(xs, ys, color=col, linestyle=ls, linewidth=lw, label=f"{label} (AUC {r['auc']:.3f})")
ax.set_xscale("log")
ax.set_xlim(1e-3, 1)
ax.set_ylim(0, 1.01)
ax.set_xlabel("False acceptance rate (edited copies accepted)")
ax.set_ylabel("Unedited copies accepted (1 - FRR)")
ax.grid(True, which="both", linewidth=0.3, alpha=0.5)
ax.legend(fontsize=6.5, loc="upper center", bbox_to_anchor=(0.45, -0.2), ncol=1, frameon=False)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "masan3.png"))

# FAR and FRR against the region threshold
fig, ax = plt.subplots(figsize=(3.5, 2.5), dpi=300)
xs = [p["luma"] for p in R["farFrr"]]
ax.plot(xs, [100 * p["far"] for p in R["farFrr"]], color="#c0392b", linewidth=1.6, label="FAR: edited copies accepted")
ax.plot(xs, [100 * p["frr"] for p in R["farFrr"]], color="#2c3e50", linewidth=1.6, linestyle="--", label="FRR: unedited copies rejected")
ax.axvline(9.0, color="#7f8c8d", linewidth=0.8, linestyle=":")
ax.text(9.3, 36, "threshold used\nby the system", fontsize=6.5, color="#555", va="top")
ax.set_xlabel("Region luma threshold (chroma threshold scaled with it)")
ax.set_ylabel("Error rate (%)")
ax.grid(True, linewidth=0.3, alpha=0.5)
ax.legend(fontsize=6.5, loc="upper right", bbox_to_anchor=(1.0, 0.6))
fig.tight_layout()
fig.savefig(os.path.join(OUT, "masan2.png"))
print("wrote masan2.png (FAR/FRR), masan3.png (ROC)")
