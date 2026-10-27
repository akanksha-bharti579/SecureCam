"""Collects SecureCam TIMING lines by reading the phone's log buffer every 2 s (for phones whose firmware breaks a
long-running `adb logcat` stream). Stops at N captures or after 3 minutes without a new one, then writes the same CSV
format as capture_benchmark.py and prints the summary.

Usage: python tools/poll_timing.py <serial> [N=100] [out.csv] [seed_file_with_earlier_lines]
"""
import csv
import re
import statistics
import subprocess
import sys
import time

ADB = r"C:\SDK\platform-tools\adb.exe"
SERIAL, N = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 100
OUT = sys.argv[3] if len(sys.argv) > 3 else "capture_timing.csv"
SEED = sys.argv[4] if len(sys.argv) > 4 else None
FIELDS = ["hash", "fingerprint", "sign", "save", "total", "bytes", "w", "h"]
LINE = re.compile(r"^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+ I SecureCam: TIMING (.*)$")

seen = {}  # timestamp -> fields


def take(text):
    for line in text.splitlines():
        m = LINE.match(line.strip())
        if m and m.group(1) not in seen:
            kv = dict(p.split("=") for p in m.group(2).split())
            seen[m.group(1)] = {k: float(kv[k]) for k in FIELDS}


if SEED:
    take(open(SEED, encoding="utf-8", errors="replace").read())
last_new, count = time.time(), len(seen)
print(f"start: {count} captures already known", flush=True)
while len(seen) < N and time.time() - last_new < 180:
    out = subprocess.run([ADB, "-s", SERIAL, "logcat", "-d"], capture_output=True, text=True, errors="replace").stdout
    take(out)
    if len(seen) > count:
        count, last_new = len(seen), time.time()
        print(f"capture {count}/{N}", flush=True)
    time.sleep(2)

rows = [seen[k] for k in sorted(seen)][:N]
with open(OUT, "w", newline="") as f:
    w = csv.DictWriter(f, ["n", "battery_temp_c"] + FIELDS)
    w.writeheader()
    for i, r in enumerate(rows):
        w.writerow({"n": i + 1, "battery_temp_c": "", **r})
print(f"\n{len(rows)} captures recorded -> {OUT}")
if rows:
    print(f"image sizes: {sorted({(int(r['w']), int(r['h'])) for r in rows})}; "
          f"file size {min(r['bytes'] for r in rows) / 1e6:.2f}-{max(r['bytes'] for r in rows) / 1e6:.2f} MB")
    print(f"{'step':12s} {'mean':>8s} {'sd':>8s} {'median':>8s} {'p95':>8s} {'min':>8s} {'max':>8s}  (ms)")
    for k in FIELDS[:5]:
        v = sorted(r[k] for r in rows)
        p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
        sd = statistics.stdev(v) if len(v) > 1 else 0.0
        print(f"{k:12s} {statistics.mean(v):8.1f} {sd:8.1f} {statistics.median(v):8.1f} {p95:8.1f} {v[0]:8.1f} {v[-1]:8.1f}")
