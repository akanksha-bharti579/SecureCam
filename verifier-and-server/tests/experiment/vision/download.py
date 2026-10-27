"""Downloads a fixed, evenly spread subset of the VISION dataset (Shullani et al., 2017).

For each of the 35 devices it takes evenly spaced native photos ("nat") that also
have a real WhatsApp copy ("natWA") and real Facebook high/low quality copies
("natFBH", "natFBL"), until TOTAL photos are selected. The choice is deterministic.

Usage: python download.py <VISION_files.txt> <out_dir> [total=1000]
"""
import collections
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

LIST, OUT = sys.argv[1], sys.argv[2]
TOTAL = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
KINDS = ("nat", "natWA", "natFBH", "natFBL")
PAT = re.compile(r"/dataset/(D\d\d)_([^/]+)/images/(nat|natWA|natFBH|natFBL)/D\d\d_I_\w+?_(\d{4})\.jpg$")

urls = collections.defaultdict(dict)  # (device, index) -> kind -> url
names = {}
for line in open(LIST):
    m = PAT.search(line.strip())
    if m:
        dev, name, kind, idx = m.groups()
        urls[(dev, idx)][kind] = line.strip()
        names[dev] = name

by_dev = collections.defaultdict(list)
for (dev, idx), k in sorted(urls.items()):
    if all(x in k for x in KINDS):
        by_dev[dev].append(idx)

devs = sorted(by_dev)
per = -(-TOTAL // len(devs))
chosen = []
for d in devs:
    ids = by_dev[d]
    n = min(per, len(ids))
    chosen += [(d, ids[(i * len(ids)) // n]) for i in range(n)]
# Trim round-robin from the end of each device's list so devices stay balanced.
while len(chosen) > TOTAL:
    for d in reversed(devs):
        if len(chosen) <= TOTAL:
            break
        last = max(i for i, c in enumerate(chosen) if c[0] == d)
        chosen.pop(last)

os.makedirs(OUT, exist_ok=True)
tasks = []
index = []
for dev, idx in chosen:
    entry = {"id": f"{dev}_{idx}", "device": dev, "model": names[dev], "files": {}}
    for k in KINDS:
        path = os.path.join(OUT, f"{dev}_{idx}_{k}.jpg")
        entry["files"][k] = os.path.basename(path)
        tasks.append((urls[(dev, idx)][k], path))
    index.append(entry)
with open(os.path.join(OUT, "index.json"), "w") as f:
    json.dump(index, f, indent=1)


def fetch(t):
    url, path = t
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    for attempt in range(40):  # the network may drop for minutes: wait and retry
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            with open(path + ".part", "wb") as f:
                f.write(data)
            os.replace(path + ".part", path)
            return True
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(min(60, 5 * (attempt + 1)))
    print("FAILED", url, err, flush=True)
    return False


if os.environ.get("REVERSE"):
    tasks.reverse()
done = 0
with ThreadPoolExecutor(8) as ex:
    for ok in ex.map(fetch, tasks):
        done += 1
        if done % 200 == 0:
            print(f"{done}/{len(tasks)}", flush=True)
print("photos:", len(index), "files:", len(tasks))
