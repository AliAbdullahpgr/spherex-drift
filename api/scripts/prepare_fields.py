"""Capture reproducible real archive data for the five preset 5-arcminute fields.

These are actual calibrated pixel arrays, never screenshots or generated demo data.
Run from api/: python scripts/prepare_fields.py [--wise-only | --mosaic-only]
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, mosaic, wise


async def prepare_wise(t):
    dest = wise.PREPARED / t["id"]
    if (dest / "frames.json").exists():
        print(f"WISE {t['id']}: already captured", flush=True)
        return
    data = await wise.wise_frames(t["ra"], t["dec"])
    if len(data["frames"]) < 20:
        raise RuntimeError(f"Incomplete WISE coverage for {t['id']}: {len(data['frames'])}")
    dest.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(6)

    async def one(f):
        path = dest / f"{f['id']}.npz"
        if path.exists():
            return
        async with sem:
            band, mjd = wise._parse_frame_id(f["id"])
            a = await wise._frame_array(t["ra"], t["dec"], 5, 256, band, mjd)
            fraction = float(np.isfinite(a).mean())
            if fraction < 0.1:
                f["omit"] = True
                print(f"WISE {t['id']} / {f['id']}: no projected field coverage", flush=True)
                return
            if fraction < 0.95:
                f["flags"].append("partial_coverage")
            np.savez_compressed(path, image=a)

    await asyncio.gather(*(one(f) for f in data["frames"]))
    data["frames"] = [f for f in data["frames"] if not f.pop("omit", False)]
    data["source"] = "unwise-prepared"
    data["note"] = "Prepared real WISE/unWISE observations, 2010–2024; 5 arcmin field."
    data["provenance"] = dict(captured_at=datetime.now(timezone.utc).isoformat(),
        metadata_service=wise.LAMBDA_URL, image_archive=wise.S3_BASE,
        processing="Two linear PNG brightness ranges merged and reprojected to a common TAN grid; see app/wise.py")
    (dest / "frames.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"WISE {t['id']}: {len(data['frames'])} real frames captured", flush=True)


def prepare_mosaic(t):
    dest = mosaic.PREPARED / f"{mosaic._field_key(t['ra'], t['dec'], 5)}.npz"
    if dest.exists():
        print(f"Mosaic {t['id']}: already captured", flush=True)
        return
    d = mosaic.field(t["ra"], t["dec"], 5)
    if not np.isfinite(d["cube"]).any():
        raise RuntimeError("No valid DR1 mosaic pixels")
    dest.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(dest, **d)
    print(f"Mosaic {t['id']}: {d['cube'].shape} real calibrated pixels captured", flush=True)


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wise-only", action="store_true")
    p.add_argument("--mosaic-only", action="store_true")
    p.add_argument("--targets", default="")
    args = p.parse_args()
    for t in config.TARGETS:
        if args.targets and t["id"] not in args.targets.split(","):
            continue
        start = time.monotonic()
        if not args.wise_only:
            await asyncio.to_thread(prepare_mosaic, t)
        if not args.mosaic_only:
            await prepare_wise(t)
        print(f"{t['id']}: {time.monotonic()-start:.1f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
