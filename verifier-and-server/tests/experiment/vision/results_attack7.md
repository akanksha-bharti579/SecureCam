# Stronger adaptive attacker (150 VISION test photos, WhatsApp-like re-encoding)

| attack | block (cells) | copies | visible | accepted: standard | accepted: strict | mean luma change | content kept (SSIM gain) |
|---|---|---|---|---|---|---|---|
| Paste, no correction | 8 × 8 | 150 | 150 | 11/150 (7.3%) | 0/150 (0.0%) | 72.5 | 0.847 |
| Paste, no correction | 16 × 16 | 150 | 150 | 1/150 (0.7%) | 0/150 (0.0%) | 75.6 | 0.860 |
| Paste, no correction | 32 × 32 | 150 | 150 | 0/150 (0.0%) | 0/150 (0.0%) | 73.9 | 0.867 |
| Cell means corrected once | 8 × 8 | 150 | 147 | 147/147 (100.0%) | 137/147 (93.2%) | 26.6 | 0.486 |
| Cell means corrected once | 16 × 16 | 150 | 145 | 142/145 (97.9%) | 128/145 (88.3%) | 23.4 | 0.417 |
| Cell means corrected once | 32 × 32 | 150 | 147 | 143/147 (97.3%) | 119/147 (81.0%) | 21.7 | 0.315 |
| Cell means matched (repeated) | 8 × 8 | 150 | 144 | 144/144 (100.0%) | 143/144 (99.3%) | 25.9 | 0.478 |
| Cell means matched (repeated) | 16 × 16 | 150 | 144 | 144/144 (100.0%) | 144/144 (100.0%) | 22.7 | 0.405 |
| Cell means matched (repeated) | 32 × 32 | 150 | 144 | 144/144 (100.0%) | 141/144 (97.9%) | 21.4 | 0.309 |
| Matched, corrected for re-encoding | 8 × 8 | 150 | 144 | 144/144 (100.0%) | 144/144 (100.0%) | 25.8 | 0.471 |
| Matched, corrected for re-encoding | 16 × 16 | 150 | 144 | 144/144 (100.0%) | 144/144 (100.0%) | 22.6 | 0.395 |
| Matched, corrected for re-encoding | 32 × 32 | 150 | 144 | 144/144 (100.0%) | 144/144 (100.0%) | 21.4 | 0.296 |
| Blend weakened where the verifier flags it | 8 × 8 | 150 | 93 | 93/93 (100.0%) | 64/93 (68.8%) | 18.3 | 0.262 |
| Blend weakened where the verifier flags it | 16 × 16 | 150 | 69 | 69/69 (100.0%) | 40/69 (58.0%) | 13.8 | 0.167 |
| Blend weakened where the verifier flags it | 32 × 32 | 150 | 68 | 68/68 (100.0%) | 38/68 (55.9%) | 12.9 | 0.143 |

Visible: mean change in the block of at least 10 levels. Content kept: SSIM(block, inserted patch) minus SSIM(original block, inserted patch), on a 128 x 128 greyscale reduction of the block.
