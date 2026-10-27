# Registry and verifier scalability

## 1. Time of one lookup (four orientations), random registry contents

| records | current code (hex strings), ms | packed 32-bit words, ms |
|---|---|---|
| 1,000 | 21.9 | 0.25 |
| 10,000 | 195.3 | 1.39 |
| 100,000 | 1675.6 | 13.13 |
| 1,000,000 | (not run) | 139.86 |

## 2. Wrong candidates

Each of the 1000 real records queried against the other 999 in all four orientations: 999,000 ordered pairs, 34 candidates by the global hash, 2 by the quadrant hashes, 34 in total (rate 3.40e-5 per record).

| records in the registry | expected wrong candidates per lookup |
|---|---|
| 1,000 | 0.03 |
| 10,000 | 0.34 |
| 100,000 | 3 |
| 1,000,000 | 34 |
| 10,000,000 | 340 |

## 3. Verifier work per candidate record

Signature check 0.26 ms; region comparison 1.00 ms (strict 1.96 ms). With 34 wrong candidates at one million records, a lookup adds about 76 ms of verification in strict mode.
