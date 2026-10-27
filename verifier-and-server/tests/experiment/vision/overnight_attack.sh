#!/bin/sh
# Stronger adaptive attacker, offline; starts when the VISION comparison and localization (overnight.sh) are done.
cd "$(dirname "$0")/../../.." || exit 1
DS=../SecureCam_datasets
while [ ! -f $DS/VISION_out/localize_report.log ]; do sleep 60; done
echo "start $(date +%H:%M)"
python tests/experiment/vision/attack7_vision.py $DS/VISION $DS/VISION_out 150 3 > $DS/VISION_out/attack7.log 2>&1
echo "attack7 exit $? $(date +%H:%M)"
