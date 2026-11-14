#!/usr/bin/env python
"""Warm the disk cache for the five test targets and print coverage.

    cd api && .venv/bin/python scripts/precache.py [--fov 5] [--size 256] [--targets barnard,wise0855]

For each target: frame list (SIA + per-frame probes), the spectrum, and one stack
per (pass, detector). Safe to re-run; everything already cached is instant.
"""
import argparse
import collections
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, spherex  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fov", type=float, default=config.DEFAULT_FOV_ARCMIN)
    ap.add_argument("--size", type=int, default=config.DEFAULT_SIZE)
    ap.add_argument("--targets", default="")
    ap.add_argument("--no-stacks", action="store_true")
    args = ap.parse_args()
    want = {t for t in args.targets.split(",") if t}
    for t in config.TARGETS:
        if want and t["id"] not in want:
            continue
        t0 = time.time()
        recs, info = spherex.frame_list(t["ra"], t["dec"])
        passes = spherex.pass_summary(recs)
        print(f"[{t['id']}] {len(recs)} frames, {len(passes)} passes "
              f"({time.time() - t0:.1f}s)  collections={dict(collections.Counter(r['collection'] for r in recs))}")
        for p in passes:
            print(f"    pass {p['pass']}: {p['start'][:10]} .. {p['end'][:10]}  {p['n_frames']} frames")
        t1 = time.time()
        pts, n = spherex.spectrum(t["ra"], t["dec"], 6.0)
        print(f"    spectrum: {len(pts)}/{n} points ({time.time() - t1:.1f}s)")
        if not args.no_stacks:
            t2 = time.time()
            combos = sorted({(r["pass"], r["detector"]) for r in recs})
            for p, d in combos:
                spherex.stack_cutouts(t["ra"], t["dec"], args.fov, args.size, p, d)
            print(f"    {len(combos)} stacks ({time.time() - t2:.1f}s)")


if __name__ == "__main__":
    main()
