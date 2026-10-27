# Ablation study (VISION, test split)

Each row switches off one design choice. "Frozen" uses the system thresholds (luma 9, chroma 7); "calibrated" rescales the thresholds so that 99.5% of unedited calibration copies are accepted, as for the baselines.

| variant | AUC | frozen: unedited accepted | frozen: edits rejected | frozen: false accepts | calibrated: unedited accepted | calibrated: edits rejected | calibrated: false accepts | edits shown as MODIFIED | edits rejected at 99.9% / 99.5% / 99.0% unedited accepted (test) |
|---|---|---|---|---|---|---|---|---|---|
| Full system | 0.977 | 99.99% | 84.9% | 0 | 99.96% | 88.1% | 0 | 84.9% | 88.6% / 89.5% / 90.3% |
| Without chroma check | 0.965 | 99.99% | 78.6% | 0 | 99.96% | 82.1% | 0 | 78.5% | 82.6% / 83.8% / 85.1% |
| Without quadrant lookup | 0.977 | 99.99% | 84.9% | 0 | 99.96% | 88.1% | 0 | 81.7% | 88.6% / 89.5% / 90.3% |
| Without neighbourhood tolerance | 0.993 | 97.22% | 95.2% | 0 | 99.66% | 91.3% | 0 | 95.2% | 90.3% / 92.2% / 93.0% |
| Without contrast/brightness adjustment | 0.977 | 99.99% | 85.0% | 0 | 99.96% | 88.1% | 0 | 84.9% | 88.6% / 89.4% / 90.4% |
| pHash lookup only (no region check) | - | 100.00% | 3.1% | 12 | - | - | - | - |
