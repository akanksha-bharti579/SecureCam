"""Capture-time benchmark on a real phone over USB (adb).

Opens SecureCam, presses the shutter N times and reads the per-capture timing line
the app writes to logcat ("TIMING hash=.. fingerprint=.. sign=.. save=.. total=..").
Writes a CSV and prints mean, standard deviation, median and 95th percentile.

Usage: python tools/capture_benchmark.py [N=100] [gap_seconds=2.0] [out.csv]
Point the phone at different scenes / lighting while it runs.
ADB_SERIAL=<serial> picks one phone when several are connected. LISTEN=1 does not tap the shutter (for phones that
block input injection over adb): you press TAKE PHOTO yourself, and every capture is recorded from logcat.
"""
import csv
import re
import statistics
import subprocess
import threading
import sys
import os
import time

ADB = r"C:\SDK\platform-tools\adb.exe"
SERIAL = ["-s", os.environ["ADB_SERIAL"]] if os.environ.get("ADB_SERIAL") else []
LISTEN = os.environ.get("LISTEN") == "1"
PKG = "com.example.securecam"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 100
GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
OUT = sys.argv[3] if len(sys.argv) > 3 else "capture_timing.csv"
FIELDS = ["hash", "fingerprint", "sign", "save", "total", "bytes", "w", "h"]


def adb(*args, timeout=30):
    return subprocess.run([ADB, *SERIAL, *args], capture_output=True, text=True, timeout=timeout, errors="replace").stdout


def battery_temp():
    m = re.search(r"temperature: (\d+)", adb("shell", "dumpsys", "battery"))
    return int(m.group(1)) / 10 if m else None


def shutter_xy():
    adb("shell", "uiautomator", "dump", "/sdcard/sc_ui.xml")
    xml = adb("shell", "cat", "/sdcard/sc_ui.xml")
    m = re.search(r'resource-id="%s:id/captureButton"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"' % PKG, xml)
    if not m:
        sys.exit("capture button not found - is the app open and the camera permission granted?")
    x0, y0, x1, y1 = map(int, m.groups())
    return (x0 + x1) // 2, (y0 + y1) // 2


ROWS = []


def reader(proc):
    """Collects TIMING lines as they arrive (a one-off dump would lose lines when the log buffer wraps)."""
    for line in proc.stdout:
        if "TIMING" in line:
            kv = dict(p.split("=") for p in line.split("TIMING", 1)[1].split())
            ROWS.append({k: float(kv[k]) for k in FIELDS})


def timings():
    return list(ROWS)


if not LISTEN:
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    adb("shell", "svc", "power", "stayon", "usb")
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(4)
    x, y = shutter_xy()
adb("logcat", "-c")
log = subprocess.Popen([ADB, *SERIAL, "logcat", "-s", "SecureCam:I"], stdout=subprocess.PIPE, text=True, errors="replace")
threading.Thread(target=reader, args=(log,), daemon=True).start()
temps = []
if LISTEN:
    print(f"Listening: press TAKE PHOTO on the phone {N} times (about every {GAP:.0f} s).", flush=True)
    seen, idle = 0, time.time()
    while len(timings()) < N and time.time() - idle < 600:  # stop after 10 minutes without a new capture
        if len(timings()) > seen:
            seen, idle = len(timings()), time.time()
            temps.append(battery_temp())
            print(f"capture {seen}/{N}", flush=True)
        time.sleep(0.2)
for i in range(0 if LISTEN else N):
    before = len(timings())
    temps.append(battery_temp())
    adb("shell", "input", "tap", str(x), str(y))
    deadline = time.time() + 15
    while len(timings()) == before and time.time() < deadline:
        time.sleep(0.1)
    print(f"capture {i + 1}/{N}", flush=True)
    time.sleep(GAP)

time.sleep(2)
rows = timings()
log.terminate()
with open(OUT, "w", newline="") as f:
    w = csv.DictWriter(f, ["n", "battery_temp_c"] + FIELDS)
    w.writeheader()
    for i, r in enumerate(rows):
        w.writerow({"n": i + 1, "battery_temp_c": temps[i] if i < len(temps) else "", **r})

print(f"\n{len(rows)} captures recorded -> {OUT}")
if rows:
    print(f"image sizes: {sorted({(int(r['w']), int(r['h'])) for r in rows})}; "
          f"file size {min(r['bytes'] for r in rows) / 1e6:.2f}-{max(r['bytes'] for r in rows) / 1e6:.2f} MB; "
          + (f"battery {min(t for t in temps if t)}-{max(t for t in temps if t)} C" if any(temps) else "battery temperature not readable"))
    print(f"{'step':12s} {'mean':>8s} {'sd':>8s} {'median':>8s} {'p95':>8s} {'min':>8s} {'max':>8s}  (ms)")
    for k in FIELDS[:5]:
        v = sorted(r[k] for r in rows)
        p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
        sd = statistics.stdev(v) if len(v) > 1 else 0.0
        print(f"{k:12s} {statistics.mean(v):8.1f} {sd:8.1f} {statistics.median(v):8.1f} {p95:8.1f} {v[0]:8.1f} {v[-1]:8.1f}")
