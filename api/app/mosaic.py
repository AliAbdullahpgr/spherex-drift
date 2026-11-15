"""Direct-S3 SPHEREx DR1 mosaic fallback. These are spectral coadds, not epochs.

Published product: https://doi.org/10.26131/IRSA679 (102 channels, 12.9 arcsec pixels).
Read only small FITS row ranges around the field; never download entire all-sky cubes.
"""
import io
import hashlib
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import astropy.units as u
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy_healpix import HEALPix
import httpx
import numpy as np

from . import config, imaging

BASE = "https://nasa-irsa-spherex.s3.amazonaws.com/dr1/hips5_cube/hips_20261026/Norder5"
PREPARED = config.API_ROOT / "prepared" / "mosaic"
NOTE = ("SPHEREx DR1 all-sky mosaic · 102 spectral channels, 12.9″ pixels. "
        "This coadd combines observations; it is not a separate observing date. "
        "WISE dates remain available for motion and variability. DOI: 10.26131/IRSA679.")
_http = httpx.Client(timeout=httpx.Timeout(12, connect=4), limits=httpx.Limits(max_connections=12))


def _range(url, start, length, allow_short=False, deadline=None):
    import os
    import threading
    key = hashlib.sha256(f"{url}|{start}|{length}".encode()).hexdigest()
    path = config.CACHE_DIR / "mosaic-ranges" / f"{key}.bin"
    if path.exists():
        return path.read_bytes()
    for attempt in range(3):
        remaining = (deadline - time.monotonic()) if deadline is not None else 12
        if remaining <= 0:
            raise TimeoutError("The live DR1 archive did not finish this field in time; retry the field")
        try:
            r = _http.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"},
                          timeout=min(12, remaining))
            r.raise_for_status()
            if (r.status_code != 206 or not r.headers.get("content-range", "").startswith(f"bytes {start}-")
                    or (not allow_short and len(r.content) != length)):
                raise RuntimeError("Archive did not honor the FITS byte range")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_bytes(r.content)
            tmp.replace(path)
            return r.content
        except httpx.HTTPError:
            if attempt == 2:
                raise


def _header(url, offset, deadline=None):
    # The FLAGS extension includes many bit descriptions and needs four blocks.
    raw = _range(url, offset, 17280, allow_short=True, deadline=deadline)
    for pos in range(0, len(raw), 80):
        if raw[pos:pos + 8] == b"END     ":
            length = math.ceil((pos + 80) / 2880) * 2880
            return fits.Header.fromstring(raw[:length].decode("ascii")), length
    raise RuntimeError("Invalid DR1 cube header")


def _data_size(h):
    n = int(h.get("NAXIS", 0))
    pixels = math.prod(int(h[f"NAXIS{i}"]) for i in range(1, n + 1)) if n else 0
    return (pixels * abs(int(h["BITPIX"])) // 8 + int(h.get("PCOUNT", 0))) * int(h.get("GCOUNT", 1))


@lru_cache(maxsize=64)
def _info(tile):
    url = f"{BASE}/Dir{tile // 10000 * 10000}/Npix{tile}_cube.fits"
    offset, image, waves, primary = 0, None, None, None
    deadline = time.monotonic() + 20
    for _ in range(12):
        h, hlen = _header(url, offset, deadline=deadline)
        if primary is None:
            primary = h
        nbytes = _data_size(h)
        ext = h.get("EXTNAME", "").strip()
        if ext == "IMAGE":
            image = (h, offset + hlen)
        if ext == "WCS-WAVE":
            raw = _range(url, offset + hlen, math.ceil(nbytes / 2880) * 2880, deadline=deadline)
            with fits.open(io.BytesIO(fits.PrimaryHDU().header.tostring().encode() +
                                     h.tostring().encode() + raw)) as hdus:
                waves = np.array(hdus[1].data["WAVELENGTHS"][0], dtype=float).ravel()
            break
        offset += hlen + math.ceil(nbytes / 2880) * 2880
    if image is None or waves is None or len(waves) != 102:
        raise RuntimeError("Missing calibrated wavelength table in DR1 cube")
    h, data_offset = image
    # Strip the tabular spectral axis before constructing the celestial WCS.
    wh = fits.Header()
    for key in h:
        if (re.match(r"^(CRPIX|CRVAL|CTYPE|CUNIT|CDELT)[12]$|^PC[12]_[12]$|^PV2_[12]$", key)
                or key in ("LONPOLE", "LATPOLE", "RADESYS")):
            wh[key] = h[key]
    return url, data_offset, wh, waves, dict(start=primary["DATE-BEG"], end=primary["DATE-END"])


def _field_key(ra, dec, fov):
    return f"{ra:.5f}_{dec:.5f}_{fov:.2f}"


@lru_cache(maxsize=16)
def field(ra, dec, fov):
    key = _field_key(ra, dec, fov)
    prepared = PREPARED / f"{key}.npz"
    local = config.CACHE_DIR / "mosaic" / f"{key}.npz"
    for path in (prepared, local):
        if path.exists():
            with np.load(path, allow_pickle=False) as z:
                return {k: z[k].copy() for k in z.files}
    hp = HEALPix(nside=32, order="nested", frame="icrs")
    tile = int(hp.lonlat_to_healpix(ra * u.deg, dec * u.deg))
    url, offset, header, waves, dates = _info(tile)
    wcs = WCS(header)
    rr, dd = imaging.sky_square(ra, dec, fov * 30 + 65, n=9)
    xx, yy = wcs.all_world2pix(rr, dd, 0)
    x0, x1 = max(0, int(np.floor(xx.min()))), min(512, int(np.ceil(xx.max())) + 1)
    y0, y1 = max(0, int(np.floor(yy.min()))), min(512, int(np.ceil(yy.max())) + 1)
    if x0 >= x1 or y0 >= y1:
        raise RuntimeError("Field lies outside its DR1 tile")
    deadline = time.monotonic() + 25

    def plane(i):
        raw = _range(url, offset + (i * 512 + y0) * 512 * 4, (y1 - y0) * 512 * 4, deadline=deadline)
        return np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, 512)[:, x0:x1].astype("f4")

    with ThreadPoolExecutor(max_workers=10) as pool:
        cube = np.stack(list(pool.map(plane, range(102))))
    header["CRPIX1"] -= x0
    header["CRPIX2"] -= y0
    data = dict(cube=cube, waves=waves, header=np.array(header.tostring()),
                source=np.array(url), start=np.array(dates["start"]), end=np.array(dates["end"]))
    local.parent.mkdir(parents=True, exist_ok=True)
    # This cache can be regenerated. Use an atomic replace for simultaneous readers.
    import os
    import threading
    tmp = local.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp.npz")
    np.savez_compressed(tmp, **data)
    tmp.replace(local)
    return data


def frames(ra, dec, fov, size=256):
    d = field(ra, dec, fov)
    mid = (Time(str(d["start"])).mjd + Time(str(d["end"])).mjd) / 2
    time = Time(mid, format="mjd").isot + "Z"
    out = []
    for band in range(1, 7):
        out.append(dict(id=f"dr1mosaic.{band}", survey="spherex", time=time, mjd=float(mid),
                        detector=band, wavelength_um=float(np.mean(d["waves"][(band - 1)*17:band*17])),
                        **{"pass": 1}, flags=["dr1_mosaic"],
                        image_url=f"/mosaic/image/{band}?ra={ra}&dec={dec}&fov={fov}&size={size}"))
    return dict(ra=ra, dec=dec, fov=fov, frames=out, source="dr1-mosaic", note=NOTE,
                provenance=dict(url=str(d["source"]), doi="10.26131/IRSA679"),
                passes=[{"pass": 1, "start": str(d["start"]) + "Z", "end": str(d["end"]) + "Z", "n_frames": 102}])


def image(ra, dec, fov, size, band):
    d = field(ra, dec, fov)
    with np.errstate(invalid="ignore"):
        arr = np.nanmedian(d["cube"][(band - 1)*17:band*17], axis=0)
    return imaging.subtract_background(imaging.reproject_to_grid(
        arr, WCS(fits.Header.fromstring(str(d["header"]))), imaging.target_wcs(ra, dec, fov, size), size))


def spectrum(ra, dec, cra, cdec, fov=5, radius_arcsec=6):
    d = field(cra, cdec, fov)
    w = WCS(fits.Header.fromstring(str(d["header"])))
    x, y = w.all_world2pix(ra, dec, 0)
    height, width = d["cube"].shape[1:]
    if not (0 <= x < width and 0 <= y < height):
        raise ValueError("Selected point is outside this prepared mosaic field")
    yy, xx = np.mgrid[:height, :width]
    radius = np.hypot(xx - x, yy - y)
    aperture = radius <= max(0.8, radius_arcsec / 12.9)
    sky = (radius >= 2.5) & (radius <= 4.5)
    halo = (radius >= 1.25) & (radius <= 2.25)
    pts = []
    for i, (wl, a) in enumerate(zip(d["waves"], d["cube"])):
        obj, bg, wing = a[aperture], a[sky], a[halo]
        obj, bg, wing = obj[np.isfinite(obj)], bg[np.isfinite(bg)], wing[np.isfinite(wing)]
        if bg.size < 5 or (not obj.size and wing.size < 3):
            continue
        val = float(np.mean(obj) - np.median(bg)) if obj.size else None
        err = float(1.4826 * np.median(np.abs(bg - np.median(bg))) / np.sqrt(obj.size)) if obj.size else None
        pts.append(dict(wavelength_um=float(wl), flux_mjy_sr=val, err=err,
                        halo_mjy_sr=float(np.median(wing) - np.median(bg)) if wing.size >= 3 else None,
                        saturated=not bool(obj.size),
                        detector=i // 17 + 1, **{"pass": 1}, flags=["dr1_mosaic"]))
    return dict(points=pts, unit="MJy/sr", source="dr1-mosaic", note=NOTE,
                radius_arcsec=max(radius_arcsec, 12.9 * 0.8),
                n_frames=102, n_points=len(pts), n_excluded=102-len(pts))
