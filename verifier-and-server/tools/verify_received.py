"""Checks a folder of received images (e.g. copies that came back through WhatsApp,
Telegram, Signal, Instagram) against the registry records, the same way the verifier does:
perceptual-hash lookup, then the 256-region comparison. Prints one line per file and a summary.

Usage: python tools/verify_received.py <folder> [label] [results.csv]
The registry data is read from registry-server/data/records.jsonl.
"""
import csv
import json
import os
import struct
import subprocess
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOLDER = sys.argv[1]
LABEL = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(os.path.normpath(FOLDER))
OUT = sys.argv[3] if len(sys.argv) > 3 else None

thumb = subprocess.Popen(["node", os.path.join(ROOT, "tests", "experiment", "vision", "thumb_server.js")],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
items = []
for name in sorted(os.listdir(FOLDER)):
    if not name.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        continue
    path = os.path.join(FOLDER, name)
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    thumb.stdin.write(struct.pack("<II", *im.size))
    thumb.stdin.write(im.convert("RGBA").tobytes())
    thumb.stdin.flush()
    t = thumb.stdout.read(18432)
    items.append({"file": name, "w": im.size[0], "h": im.size[1], "bytes": os.path.getsize(path), "thumb": t.hex()})
thumb.stdin.close()

res = subprocess.run(["node", os.path.join(ROOT, "tools", "verify_received.js"), os.path.join(ROOT, "registry-server", "data")],
                     input=json.dumps(items), capture_output=True, text=True)
if res.returncode:
    sys.exit(res.stderr)
rows = json.loads(res.stdout)
counts = {}
for r in rows:
    counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    print(f"{r['file'][:44]:44s} {r['w']}x{r['h']:<5d} {r['bytes'] / 1024:7.0f} kB  {r['verdict']:15s} "
          f"pHash {r['distance'] if r['distance'] is not None else '-':>2}  regions changed {r['changed']:>3}  max luma {r['maxLuma']:.2f}  "
          f"captured {r['captured'] or '-'}")
print(f"\n{LABEL}: {len(rows)} files -> " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
if OUT:
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, ["label"] + list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            w.writerow({"label": LABEL, **r})
