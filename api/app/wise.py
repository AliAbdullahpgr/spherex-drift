"""WISE/NEOWISE time-resolved epochs for the SPHEREx Drift timeline.

Data source: the WiseView ("Backyard Worlds") backend, byw.tools -> AWS Lambda `png-animation`.
It serves the unWISE/unTimely time-resolved coadds (one W1 / W2 coadd per ~6-month epoch, 2010-2024,
23 epochs) as 8-bit PNG cutouts on the 2.75"/px unWISE tile grid, plus a WCS and epoch MJDs.
PNG pixels are a *linear* map of flux between the requested minbright/maxbright, so we request two
brightness ranges (faint-detail and bright-saturation) and merge them into a float image.
See the module notes at the bottom of this docstring for why this source was chosen.

Why not the alternatives (probed live, 2026-11-14):
  * unwise.me cutout_fits: works and gives true FITS, but only cumulative (neo1..neo7) / full-depth
    coadds, no per-epoch images.
  * NERSC time-resolved tiles: no public directory found; unTimely only exposes the catalog.
  * IRSA IBE NEOWISE single-exposure: metadata queries timed out (>100 s) repeatedly, and it would
    need per-epoch co-adding of dozens of frames per band.

Endpoints: GET /wise/frames, GET /wise/image/{frame_id}.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import time
import os
from pathlib import Path

import httpx
import numpy as np
from astropy.time import Time
from fastapi import APIRouter, HTTPException, Query, Response
from PIL import Image

from . import config
from . import wise_grid as G

LAMBDA_URL = os.environ.get("WISE_LAMBDA_URL", "https://moo23y1au0.execute-api.us-west-2.amazonaws.com/default/png-animation")
S3_BASE = os.environ.get("WISE_S3_BASE", "https://amnh-citsci-public.s3-us-west-2.amazonaws.com/")
CACHE_DIR = Path(os.environ.get("WISE_CACHE_DIR", config.CACHE_DIR / "wise"))
PREPARED = config.API_ROOT / "prepared" / "wise"
BANDS = {1: 3.4, 2: 4.6}
# PNG value = 255*(flux-min)/(max-min); flux in unWISE "Vega nanomaggies"-like counts.
RANGES = {"lo": (-30.0, 225.0), "hi": (-300.0, 30000.0)}
MAX_SRC_PX = 600
EPOCH_GAP_DAYS = 90.0

router = APIRouter(prefix="/wise")

_sems: dict = {}
_locks: dict = {}


def _prepared_dir(ra, dec, fov):
    if abs(fov - 5) > 1e-6:
        return None
    for t in config.TARGETS:
        if abs(t["ra"] - ra) < 1e-5 and abs(t["dec"] - dec) < 1e-5:
            directory = PREPARED / t["id"]
            if (directory / "frames.json").exists():
                return directory
    return None


def _sem(name: str, n: int) -> asyncio.Semaphore:
    key = (id(asyncio.get_running_loop()), name)
    if key not in _sems:
        _sems[key] = asyncio.Semaphore(n)
    return _sems[key]


def _lock(key: str) -> asyncio.Lock:
    k = (id(asyncio.get_running_loop()), key)
    if k not in _locks:
        _locks[k] = asyncio.Lock()
    return _locks[k]


def _h(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:16]


def _src_size(fov: float) -> int:
    return int(min(MAX_SRC_PX, max(40, math.ceil(fov * 60.0 / G.WISE_PIX_ARCSEC * 1.2) + 8)))


async def _get(client: httpx.AsyncClient, url: str, params=None, sem="s3", n=8, tries=4) -> httpx.Response:
    last = None
    for i in range(tries):
        try:
            async with _sem(sem, n):
                r = await client.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code}: {r.text[:120]}")
            if r.status_code < 500 and r.status_code != 429:
                break
        except (httpx.TransportError, httpx.TimeoutException) as e:
            last = e
        await asyncio.sleep(0.6 * (2 ** i))
    raise HTTPException(502, f"WISE upstream failure: {last}")


async def _meta(client, ra, dec, fov, band, rng_name) -> dict | None:
    """Lambda call for all epochs of one band/range; disk cached. None if no coverage."""
    size = _src_size(fov)
    lo, hi = RANGES[rng_name]
    key = _h("meta", f"{ra:.5f}", f"{dec:.5f}", size, band, lo, hi)
    path = CACHE_DIR / "meta" / f"{key}.json"
    def cached():
        """(hit, value). An empty "no coverage" answer is only trusted for an hour, because the
        upstream service returns the same error for a temporary failure as for no coverage."""
        if not path.exists():
            return False, None
        m = json.loads(path.read_text())
        if not m and time.time() - path.stat().st_mtime > 3600:
            return False, None
        return True, (m or None)

    hit, val = cached()
    if hit:
        return val
    async with _lock(key):
        hit, val = cached()
        if hit:
            return val
        params = dict(ra=ra, dec=dec, band=band, size=size, max_dyr=0, minbright=lo, maxbright=hi,
                      invert=0, stretch=1, diff=0, scandir=0, outer=0, neowise=0, window=0, diff_window=1,
                      unique=1, smooth_scan=0, shift=0, pmx=0, pmy=0)
        try:
            r = await _get(client, LAMBDA_URL, params, sem="lambda", n=4, tries=3)
            m = r.json()
        except HTTPException as e:
            if "HTTP 500" in str(e.detail):  # lambda errors out when there is nothing to build
                m = {}
            else:
                raise
        if not m.get("ims"):
            m = {}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(m))
        tmp.replace(path)
        return m or None


async def _png(client, name: str) -> np.ndarray:
    path = CACHE_DIR / "png" / (name.split("/")[-1] + ".npy")
    if path.exists():
        return np.load(path)
    r = await _get(client, S3_BASE + name)
    a = np.array(Image.open(io.BytesIO(r.content)).convert("L"), dtype=np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp{os.getpid()}.npy")
    np.save(tmp, a)
    tmp.replace(path)
    return a


def _epoch_list(meta: dict) -> list[dict]:
    out = []
    for i, im in enumerate(meta["ims"]):
        mj = meta["mjds"][i] if i < len(meta.get("mjds", [])) else [meta["all_mjds"][i]]
        out.append({"i": i, "im": im, "mjd": float(np.mean(mj)), "mjd0": float(min(mj)), "mjd1": float(max(mj))})
    return out


def _iso(mjd: float) -> str:
    return Time(mjd, format="mjd", scale="utc").utc.strftime("%Y-%m-%dT%H:%M:%SZ")


async def _covered_epochs(client, ra, dec, fov, band) -> tuple[dict | None, list[dict]]:
    meta = await _meta(client, ra, dec, fov, band, "lo")
    if not meta:
        return None, []
    eps = _epoch_list(meta)
    pngs = await asyncio.gather(*[_png(client, e["im"]) for e in eps])
    keep = []
    for e, a in zip(eps, pngs):
        if a.size and a.std() > 0:  # constant image => no coverage in this epoch
            keep.append(e)
    return meta, keep


def _frame_id(band: int, mjd: float) -> str:
    return f"w{band}e{mjd:.3f}"


def _parse_frame_id(fid: str) -> tuple[int, float]:
    try:
        b, m = fid[1:].split("e")
        band = int(b)
        if fid[0] != "w" or band not in BANDS:
            raise ValueError
        return band, float(m)
    except ValueError:
        raise HTTPException(404, f"unknown WISE frame id {fid!r}")


def _check(ra, dec, fov):
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise HTTPException(422, "ra/dec out of range")
    if not (0 < fov <= 30):
        raise HTTPException(422, "fov must be in (0, 30] arcmin")


@router.get("/frames")
async def wise_frames(ra: float, dec: float, fov: float = 5.0, size: int = 256):
    _check(ra, dec, fov)
    prepared = _prepared_dir(ra, dec, fov)
    if prepared:
        return json.loads((prepared / "frames.json").read_text())
    async with httpx.AsyncClient() as client:
        res = await asyncio.gather(*[_covered_epochs(client, ra, dec, fov, b) for b in BANDS])
    rows = []
    for band, (meta, eps) in zip(BANDS, res):
        for e in eps:
            rows.append((e["mjd"], band, e))
    rows.sort(key=lambda t: (t[0], t[1]))
    # cluster band-epochs into ~6-month passes
    pass_of, p, last = {}, 0, None
    for mjd, band, e in rows:
        if last is None or mjd - last > EPOCH_GAP_DAYS:
            p += 1
        last = mjd
        pass_of[(band, e["i"])] = p
    frames, passes = [], {}
    for mjd, band, e in rows:
        pn = pass_of[(band, e["i"])]
        fid = _frame_id(band, mjd)
        frames.append({
            "id": fid, "survey": "wise", "time": _iso(mjd), "mjd": round(mjd, 4), "detector": None,
            "wavelength_um": BANDS[band], "pass": pn, "flags": [],
            "image_url": f"/wise/image/{fid}?ra={ra}&dec={dec}&fov={fov}&size={size}&stretch=asinh",
        })
        d = passes.setdefault(pn, {"pass": pn, "start": e["mjd0"], "end": e["mjd1"], "n_frames": 0})
        d["start"], d["end"], d["n_frames"] = min(d["start"], e["mjd0"]), max(d["end"], e["mjd1"]), d["n_frames"] + 1
    plist = [{"pass": k, "start": _iso(v["start"]), "end": _iso(v["end"]), "n_frames": v["n_frames"]}
             for k, v in sorted(passes.items())]
    return {"ra": ra, "dec": dec, "fov": fov, "frames": frames, "passes": plist}


def _build_array(ra, dec, fov, size, meta_lo, e_lo, png_lo, png_hi, meta_hi) -> np.ndarray:
    lo0, lo1 = RANGES["lo"]
    hi0, hi1 = RANGES["hi"]
    v_lo = lo0 + png_lo.astype(np.float32) * (lo1 - lo0) / 255.0
    v_hi = hi0 + png_hi.astype(np.float32) * (hi1 - hi0) / 255.0
    sat = png_lo >= 254
    v = np.where(sat, np.maximum(v_hi, lo1), v_lo)
    v = v[::-1, :]  # PNG row 0 is north; WCS convention wants row 0 = south
    swcs = G.source_wcs(meta_lo["CRVAL1"], meta_lo["CRVAL2"], meta_lo["CRPIX1"], meta_lo["CRPIX2"])
    twcs = G.target_wcs(ra, dec, fov, size)
    out = G.reproject_north_up(v.astype(np.float32), swcs, twcs, size, fov)
    return G.subtract_median(out)


async def _frame_array(ra, dec, fov, size, band, mjd) -> np.ndarray:
    prepared = _prepared_dir(ra, dec, fov)
    if prepared and size == 256:
        file = prepared / f"{_frame_id(band, mjd)}.npz"
        if file.exists():
            with np.load(file, allow_pickle=False) as z:
                return z["image"].copy()
    key = _h("img", f"{ra:.5f}", f"{dec:.5f}", f"{fov:.4f}", size, band, f"{mjd:.3f}")
    path = CACHE_DIR / "img" / f"{key}.npy"
    if path.exists():
        return np.load(path)
    async with _lock(key):
        if path.exists():
            return np.load(path)
        async with httpx.AsyncClient() as client:
            meta_lo, meta_hi = await asyncio.gather(_meta(client, ra, dec, fov, band, "lo"),
                                                    _meta(client, ra, dec, fov, band, "hi"))
            if not meta_lo or not meta_hi:
                raise HTTPException(404, "no WISE coverage")
            e_lo = min(_epoch_list(meta_lo), key=lambda e: abs(e["mjd"] - mjd))
            e_hi = min(_epoch_list(meta_hi), key=lambda e: abs(e["mjd"] - mjd))
            if abs(e_lo["mjd"] - mjd) > 1.0 or abs(e_hi["mjd"] - e_lo["mjd"]) > 1.0:
                raise HTTPException(404, "unknown WISE epoch for this position")
            p_lo, p_hi = await asyncio.gather(_png(client, e_lo["im"]), _png(client, e_hi["im"]))
        arr = await asyncio.to_thread(_build_array, ra, dec, fov, size, meta_lo, e_lo, p_lo, p_hi, meta_hi)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".tmp{os.getpid()}.npy")
        np.save(tmp, arr)
        tmp.replace(path)
        return arr


@router.get("/image/{frame_id}")
async def wise_image(frame_id: str, ra: float, dec: float, fov: float = 5.0,
                     size: int = Query(256, ge=16, le=1024),
                     stretch: str = Query("asinh", pattern="^(asinh|linear|log)$"),
                     format: str = Query("png", pattern="^(png|npy)$")):
    _check(ra, dec, fov)
    band, mjd = _parse_frame_id(frame_id)
    arr = await _frame_array(ra, dec, fov, size, band, mjd)
    if format == "npy":
        raw = np.ascontiguousarray(arr.astype("<f4")).tobytes()
        return Response(raw, media_type="application/octet-stream",
                        headers={"X-Shape": f"{arr.shape[0]},{arr.shape[1]}",
                                 "Cache-Control": "public, max-age=3600, s-maxage=86400"})
    png = await asyncio.to_thread(G.to_png, arr, stretch)
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"})
