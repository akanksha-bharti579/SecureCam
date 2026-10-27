#!/bin/sh
# Runs compare_vision.js once baselines_vision.py has merged all 1,000 photos into baselines.json. Offline.
cd "$(dirname "$0")/../../.." || exit 1
DS=../SecureCam_datasets
until python -c "import json,sys; sys.exit(0 if len(json.load(open('$DS/VISION_out/baselines.json')))==1000 else 1)" 2>/dev/null; do sleep 60; done
sleep 10
echo "start $(date +%H:%M)"
node --max-old-space-size=6000 tests/experiment/vision/compare_vision.js $DS/VISION_out > $DS/VISION_out/compare.log 2>&1
echo "compare exit $? $(date +%H:%M)"
