// Real example positions, matching api/app/config.py. Used when only /targets is unavailable.
import type { Target } from "./types";
export const EXAMPLE_TARGETS: Target[] = [
  {
    "id": "barnard",
    "name": "Barnard's Star",
    "ra": 269.446268,
    "dec": 4.768204,
    "kind": "mover",
    "pm_mas_yr": [
      -801.6,
      10362.4
    ],
    "epoch": 2026.0,
    "note": "nearest single star; proper motion 10.4 arcsec/yr (position for epoch 2026.0)"
  },
  {
    "id": "epsindib",
    "name": "Epsilon Indi B",
    "ra": 331.096653,
    "dec": -56.800663,
    "kind": "mover",
    "pm_mas_yr": [
      3982.0,
      -2466.8
    ],
    "epoch": 2026.0,
    "note": "brown dwarf pair orbiting eps Indi A, ~6.7 arcmin from the bright star (epoch 2026.0)"
  },
  {
    "id": "wise0855",
    "name": "WISE 0855",
    "ra": 133.795129,
    "dec": -7.245147,
    "kind": "mover",
    "pm_mas_yr": [
      -8118.0,
      680.0
    ],
    "epoch": 2010.4,
    "note": "fast-moving brown dwarf, ~8 arcsec/yr (position for 2010; it has moved ~2 arcmin west since)"
  },
  {
    "id": "rwaur",
    "name": "RW Aurigae",
    "ra": 76.95656,
    "dec": 30.401248,
    "kind": "variable",
    "note": "variable T Tauri star (epoch 2026.0)"
  },
  {
    "id": "rdra",
    "name": "R Draconis",
    "ra": 248.167233,
    "dec": 66.755024,
    "kind": "variable",
    "note": "Mira-type variable star (epoch 2026.0)"
  }
];
