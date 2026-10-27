# Large-scale experiment (VISION dataset + photos from the phone)

Answers the reviewer's points: standard dataset, calibration/test split, ROC curves, baselines.

```bash
# 1. data (about 3.7 GB): 1,000 photos from 35 phones + their real WhatsApp/Facebook copies
curl -O https://lesc.dinfo.unifi.it/VISION/VISION_files.txt
python tests/experiment/vision/download.py VISION_files.txt ../SecureCam_datasets/VISION 1000

# 2. copies, edits and fingerprints (about 1.5 h on 8 cores; resumable)
python tests/experiment/vision/make_vision.py ../SecureCam_datasets/VISION ../SecureCam_datasets/VISION_out 7

# 3. scoring with securecam-core.js -> results_vision.md / .json
node --max-old-space-size=6000 tests/experiment/vision/analyze_vision.js ../SecureCam_datasets/VISION_out

# 4. figures for the paper, then the paper itself
python tests/experiment/vision/plot_vision.py tests/experiment/vision/results_vision.json "Research Paper/figures"
cd "Research Paper" && python build_paper.py && powershell -File to_pdf.ps1
```

Photos taken with the app (pulled with `adb pull /sdcard/Pictures/SecureCam`):

```bash
node tests/experiment/vision/device_index.js ../SecureCam_datasets/S23/SecureCam registry-server/data
python tests/experiment/vision/make_vision.py ../SecureCam_datasets/S23/SecureCam ../SecureCam_datasets/S23_out 7
node tests/experiment/vision/analyze_vision.js ../SecureCam_datasets/S23_out tests/experiment/vision/results_device.md tests/experiment/vision/results_device.json
```

Other tools: `tools/capture_benchmark.py` (capture timing over USB), `tools/verify_received.py <folder>`
(checks copies that came back through a real platform against the registry; set `STRICT=1` to use strict mode).

**Further analyses** (after `make_vision.py`; results in this folder):

```
node --max-old-space-size=6000 tests/experiment/vision/ablation_vision.js ../SecureCam_datasets/VISION_out   # results_ablation.*
python tests/experiment/vision/attack_vision.py ../SecureCam_datasets/VISION ../SecureCam_datasets/VISION_out 300 6
node tests/experiment/vision/attack_score.js ../SecureCam_datasets/VISION_out                               # results_attack.*
node --max-old-space-size=6000 tests/experiment/vision/scale_test.js ../SecureCam_datasets/VISION_out        # results_scale.*
```

**Comparison with deployed methods** (C2PA hard binding, Meta's PDQ, Adobe's TrustMark watermark) on the same
copies and edits. It was run in a separate Python 3.12 environment with the same NumPy and Pillow versions.
The rebuilt copies are checked byte-for-byte against `make_vision.py`'s records. About 3 h on 4 workers.

```
py -3.12 -m venv ../SecureCam_datasets/venv_baselines
../SecureCam_datasets/venv_baselines/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
PYTHONUTF8=1 ../SecureCam_datasets/venv_baselines/Scripts/python -m pip install trustmark pdqhash c2pa-python cryptography numpy==2.5.2 pillow==12.3.0
PYTHONUTF8=1 ../SecureCam_datasets/venv_baselines/Scripts/python tests/experiment/vision/baselines_vision.py ../SecureCam_datasets/VISION ../SecureCam_datasets/VISION_out 4
node --max-old-space-size=6000 tests/experiment/vision/compare_vision.js ../SecureCam_datasets/VISION_out    # results_compare.*
```

`analyze_vision.js` also writes 95% bootstrap intervals for every AUC (200 resamples of the test photos).

**Strict mode** (`compareThumbs(..., { strict: true })` in `securecam-core.js`, `?strict=1` on the verifier page):
a region also counts as changed if its SSIM to the signed thumbnail is below `DEFAULTS.ssimMin` (0.869, chosen on
the calibration split). `analyze_vision.js` evaluates it through the same decision path as the standard mode
("Strict mode as implemented" in the results files).

VISION: D. Shullani et al., EURASIP J. Inf. Secur., 2017 (CC BY-SA 4.0). Cite it when using these results.
