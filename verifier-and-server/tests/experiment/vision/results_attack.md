# Adaptive-attack test (300 VISION test photos, WhatsApp-like re-encoding)

| attack | size (cells) | copies | visible | visible copies accepted: standard | strict |
|---|---|---|---|---|---|
| Copy-move patch | 1 × 1 | 300 | 275 (mean luma change 67.3) | 275 (100.0%) | 231 (84.0%) |
| Copy-move patch | 2 × 2 | 300 | 272 (mean luma change 66.5) | 263 (96.7%) | 161 (59.2%) |
| Copy-move patch | 4 × 4 | 300 | 288 (mean luma change 63.2) | 192 (66.7%) | 64 (22.2%) |
| Copy-move patch | 8 × 8 | 300 | 287 (mean luma change 63.4) | 72 (25.1%) | 3 (1.0%) |
| Paste from another photo | 4 × 4 | 300 | 300 (mean luma change 73.8) | 153 (51.0%) | 15 (5.0%) |
| Paste, cell means preserved (adaptive) | 4 × 4 | 300 | 297 (mean luma change 29.2) | 297 (100.0%) | 286 (96.3%) |
| Paste from another photo | 8 × 8 | 300 | 300 (mean luma change 73.2) | 16 (5.3%) | 0 (0.0%) |
| Paste, cell means preserved (adaptive) | 8 × 8 | 300 | 296 (mean luma change 24.7) | 295 (99.7%) | 265 (89.5%) |

A cell is 1/128 of the image width and height. "Visible": mean change inside the edited area of at least 10 levels.
Mean correction had to clip 11.2% of the pixels it changed.
