#!/bin/sh
# Runs after baselines_vision.py has finished (it waits for baselines.json): the comparison with C2PA / PDQ /
# TrustMark, the verifier decisions on VISION, and the localization summary over all datasets. Offline.
cd "$(dirname "$0")/../../.." || exit 1
DS=../SecureCam_datasets
while [ ! -f $DS/VISION_out/baselines.json ]; do sleep 60; done
sleep 30
echo "start $(date +%H:%M)"
node --max-old-space-size=6000 tests/experiment/vision/compare_vision.js $DS/VISION_out > $DS/VISION_out/compare.log 2>&1
echo "compare exit $? $(date +%H:%M)"
# decisions only: the report goes to a separate file so results_vision.* stay as they are
DECISIONS=$DS/VISION_out/decisions.json node --max-old-space-size=6000 tests/experiment/vision/analyze_vision.js $DS/VISION_out \
  $DS/VISION_out/rerun_vision.md $DS/VISION_out/rerun_vision.json > $DS/VISION_out/rerun.log 2>&1
echo "decisions exit $? $(date +%H:%M)"
python tests/experiment/vision/localize.py VISION $DS/VISION_out
L="$DS/VISION_out/localize.json $DS/Korus_out/localize.json $DS/COVERAGE_out/localize.json"
[ -f $DS/IMD2020_out/localize.json ] && L="$L $DS/IMD2020_out/localize.json"
python tests/experiment/vision/localize.py --report $L > $DS/VISION_out/localize_report.log 2>&1
echo "done $(date +%H:%M)"
