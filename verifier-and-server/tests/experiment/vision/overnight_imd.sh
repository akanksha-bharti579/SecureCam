#!/bin/sh
# IMD2020 real-life set, offline: waits for the download, checks and unpacks it, builds and scores the copies, measures
# localization, then writes the localization summary over every dataset that is ready.
cd "$(dirname "$0")/../../.." || exit 1
DS=../SecureCam_datasets
Z=$DS/IMD2020/IMD2020.zip
while [ "$(stat -c %s $Z 2>/dev/null)" != "592836398" ]; do sleep 60; done
sleep 20
echo "download complete $(date +%H:%M)"
python - <<'PY' || exit 1
import zipfile, os
z = zipfile.ZipFile("../SecureCam_datasets/IMD2020/IMD2020.zip")
bad = z.testzip()
if bad: raise SystemExit("zip CRC failure: " + bad)
names = z.namelist()
if any(n.startswith("/") or ".." in n.split("/") for n in names): raise SystemExit("unsafe path in zip")
z.extractall("../SecureCam_datasets/IMD2020/data")
print("zip OK,", len(names), "entries")
PY
SRCD=$DS/IMD2020/data
[ -d $SRCD/IMD2020 ] && SRCD=$SRCD/IMD2020
python tests/experiment/vision/make_imd.py $SRCD $DS/IMD2020_out 3 || exit 1
echo "built $(date +%H:%M)"
DECISIONS=$DS/IMD2020_out/decisions.json node --max-old-space-size=5000 tests/experiment/vision/analyze_vision.js $DS/IMD2020_out \
  tests/experiment/vision/results_imd2020.md tests/experiment/vision/results_imd2020.json > $DS/IMD2020_out/analyze.log 2>&1
echo "scored exit $? $(date +%H:%M)"
python tests/experiment/vision/localize.py IMD2020 $DS/IMD2020_out $SRCD
while [ ! -f $DS/VISION_out/localize_report.log ]; do sleep 60; done
L=""
for d in VISION Korus COVERAGE IMD2020; do [ -f $DS/${d}_out/localize.json ] && L="$L $DS/${d}_out/localize.json"; done
python tests/experiment/vision/localize.py --report $L > $DS/IMD2020_out/localize_report.log 2>&1
echo "done $(date +%H:%M)"
