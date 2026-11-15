"""SPHEREx data access: SIA discovery, frame/pass bookkeeping, cutouts, stacks, spectra."""
import io
import json
import re
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from astropy.wcs import WCS
from photutils.aperture import CircularAperture, aperture_photometry

from . import cache, config, imaging, s3fits

import logging
logging.getLogger("astropy").setLevel(logging.ERROR)
warnings.filterwarnings("ignore", message="(?s).*SIP.*")
warnings.filterwarnings("ignore", category=UserWarning, module="astropy")

PIXEL_SCALE_ARCSEC = 6.15
UNIT = "MJy/sr"

# Level-2 FLAGS bit names (SPHEREx Explanatory Supplement, Table 16).
FLAG_BITS = {0: "transient", 1: "overflow", 2: "sur_error", 6: "nonfunc", 7: "dichroic",
             9: "missing_data", 10: "hot", 11: "cold", 14: "phanmiss", 15: "nonlinear",
             17: "persist", 19: "outlier", 20: "crosstalk", 22: "ghost", 24: "ghost_ext",
             25: "streak", 26: "bloom", 27: "snowball", 28: "halo", 29: "satellite_halo"}
# Bits whose pixels are set to NaN. (12 FULLSAMPLE and 21 SOURCE are informational;
# 20 CROSSTALK / 22-24 GHOST are reported in `flags` but not masked.)
MASK_BITS = (0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 25, 26, 27, 28, 29)
BAD_MASK = int(sum(1 << b for b in MASK_BITS))
# Photometry is more forgiving: a saturated star is the target, so OVERFLOW/BLOOM pixels are kept
# (the point is reported with saturated=True: a lower limit). HARD bits are always dropped;
# SOFT bits are dropped unless the pixel is also saturation-flagged.
SAT_BITS = (1 << 1) | (1 << 26)
HARD_BITS = int(sum(1 << b for b in (6, 7, 9, 10, 11, 14, 25, 29)))
SOFT_BITS = int(sum(1 << b for b in (0, 2, 15, 17, 19, 27, 28)))

_frame_pool = ThreadPoolExecutor(max_workers=config.MAX_FRAME_WORKERS, thread_name_prefix="frame")


def pmap(fn, items):
    """Run fn over items in the shared frame pool (bounded concurrency); keep order."""
    futs = [_frame_pool.submit(fn, it) for it in items]
    return [f.result() for f in futs]


# ---------------------------------------------------------------------------
# SIA discovery
# ---------------------------------------------------------------------------
def _iso(mjd):
    return Time(mjd, format="mjd").isot[:19] + "Z"


def _parse_row(row):
    coll = str(row["obs_collection"])
    det = int(re.search(r"D(\d)", str(row["energy_bandpassname"])).group(1))
    obs_id = str(row["obs_id"])
    key = None
    try:
        key = json.loads(str(row["cloud_access"]))["aws"]["key"]
    except Exception:  # noqa: BLE001
        pass
    nums = [float(x) for x in str(row["s_region"]).split()[2:]]
    poly = list(zip(nums[0::2], nums[1::2]))
    return {
        "id": f"{coll}.{obs_id}.D{det}", "collection": coll, "obs_id": obs_id, "detector": det,
        "mjd": float(row["t_min"]), "mjd_end": float(row["t_max"]),
        "key": key, "url": str(row["access_url"]),
        "band_um": [round(float(row["em_min"]) * 1e6, 4), round(float(row["em_max"]) * 1e6, 4)],
        "poly": poly,
    }


def _sia_query(ra, dec):
    from astropy.table import Table
    last = None
    # Avoid PyVO service discovery and its unbounded retries on an archive outage.
    # A direct SIA2 request has the same collection/position semantics.
    params = [("COLLECTION", c) for c in config.COLLECTIONS]
    params.append(("POS", f"CIRCLE {ra} {dec} {config.SIA_RADIUS_ARCMIN / 60}"))
    for i in range(2):
        try:
            r = httpx.get("https://irsa.ipac.caltech.edu/SIA", params=params,
                          timeout=httpx.Timeout(6, connect=3), follow_redirects=True)
            r.raise_for_status()
            res = Table.read(io.BytesIO(r.content), format="votable")
            return [_parse_row(r) for r in res]
        except Exception as e:  # noqa: BLE001  (IRSA throws transient 502/503)
            last = e
            if i == 0:
                time.sleep(0.25)
    raise RuntimeError(f"IRSA SIA query failed: {last!r}"[:300])


def sia_records(ra, dec):
    """All SIA records near (ra, dec), disk-cached. Deduplicated by (obs_id, detector)."""
    k = cache.key_hash("sia", ",".join(config.COLLECTIONS), f"{ra:.4f}", f"{dec:.4f}")
    with cache.key_lock(k):
        hit = cache.read_json("sia", k)
        if hit and time.time() - hit["t"] < config.SIA_TTL_S:
            return hit["records"]
        recs = _sia_query(ra, dec)
        order = {c: i for i, c in enumerate(config.COLLECTIONS)}
        best = {}
        for r in recs:  # later-listed collection wins for the same exposure
            kk = (r["obs_id"], r["detector"])
            if kk not in best or order.get(r["collection"], 0) >= order.get(best[kk]["collection"], 0):
                best[kk] = r
        recs = list(best.values())
        cache.write_json("sia", k, {"t": time.time(), "records": recs})
        return recs


def _in_polygon(poly, ra0, dec0):
    c = np.cos(np.deg2rad(dec0))
    pts = [(((p[0] - ra0 + 180) % 360 - 180) * c, p[1] - dec0) for p in poly]
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > 0) != (yj > 0) and 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def covering_frames(ra, dec):
    """Frames whose footprint contains (ra, dec), oldest first, with `pass` assigned."""
    recs = [r for r in sia_records(ra, dec) if _in_polygon(r["poly"], ra, dec)]
    recs.sort(key=lambda r: (r["mjd"], r["detector"]))
    p, last = 0, None
    for r in recs:
        if last is None or r["mjd"] - last > config.PASS_GAP_DAYS:
            p += 1
        r["pass"] = p
        last = r["mjd"]
    return recs


def find_frame(frame_id, ra, dec):
    for r in covering_frames(ra, dec):
        if r["id"] == frame_id:
            return r
    return None


def pass_summary(recs):
    out = {}
    for r in recs:
        out.setdefault(r["pass"], []).append(r["mjd"])
    return [{"pass": p, "start": _iso(min(m)), "end": _iso(max(m)), "n_frames": len(m)}
            for p, m in sorted(out.items())]


# ---------------------------------------------------------------------------
# Native cutouts (S3 range reads, IRSA cutout service as fallback)
# ---------------------------------------------------------------------------
def _flag_names(flags_box):
    allbits = int(np.bitwise_or.reduce(flags_box.ravel())) if flags_box.size else 0
    return [n for b, n in FLAG_BITS.items() if allbits & (1 << b)]


def _header_flags(h):
    out = []
    if str(h.get("L2DQAFLG", "Pass")).strip() != "Pass":
        out.append("l2_dqa_fail")
    if int(h.get("FINAST", 0) or 0) > 0:
        out.append("poor_astrometry")
    if h.get("SHUTTLE_GLOW_CONT") is True:
        out.append("shuttle_glow")
    if h.get("AURORA_CONT") is True:
        out.append("aurora")
    return out


def _make_native(hdr, x0, y0, img, flags, wave_hdul, ra, dec, source):
    wcs_full = WCS(s3fits.trim_wcs_header(hdr))
    px, py = (float(v) for v in wcs_full.all_world2pix(ra, dec, 0))
    nx = int(hdr.get("NAXIS1", 2040)); ny = int(hdr.get("NAXIS2", 2040))
    wave = s3fits.wavelength_at(hdr, wave_hdul, px, py)
    cx, cy = int(round(px)) - x0, int(round(py)) - y0
    box = flags[max(cy - 3, 0):cy + 4, max(cx - 3, 0):cx + 4]
    on_frame = 2 <= px <= nx - 3 and 2 <= py <= ny - 3
    meta = {
        "x0": x0, "y0": y0, "px": px, "py": py, "on_frame": bool(on_frame),
        "wcs": s3fits.trim_wcs_header(hdr).tostring(), "wavelength_um": wave,
        "detector": int(hdr.get("DETECTOR", 0)), "bunit": str(hdr.get("BUNIT", "MJy / sr")),
        "omega_arcsec2": float(hdr.get("OMEGA_MEDIAN", PIXEL_SCALE_ARCSEC ** 2)),
        "flags": _header_flags(hdr) + (_flag_names(box) if box.size else []),
        "source": source,
    }
    return meta


def _fetch_irsa(rec, ra, dec, half_arcsec):
    """Fallback: IRSA server-side cutout (slow, ~10 s)."""
    url = f"{rec['url']}?center={ra},{dec}d&size={2 * half_arcsec / 3600.0:.5f}"
    last = None
    for i in range(5):
        try:
            r = httpx.get(url, timeout=180.0, follow_redirects=True)
            if r.status_code == 200:
                hdul = fits.open(io.BytesIO(r.content))
                hdr = hdul["IMAGE"].header
                img = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
                flags = np.asarray(hdul["FLAGS"].data, dtype=np.int32)
                w = WCS(hdr)
                px, py = (float(v) for v in w.all_world2pix(ra, dec, 0))
                wave = s3fits.wavelength_at(hdr, hdul, px, py)
                cx, cy = int(round(px)), int(round(py))
                box = flags[max(cy - 3, 0):cy + 4, max(cx - 3, 0):cx + 4]
                meta = {
                    "x0": 0, "y0": 0, "px": px, "py": py,
                    "on_frame": bool(2 <= px <= img.shape[1] - 3 and 2 <= py <= img.shape[0] - 3),
                    "wcs": s3fits.trim_wcs_header(hdr).tostring(), "wavelength_um": wave,
                    "detector": int(hdr.get("DETECTOR", 0)), "bunit": str(hdr.get("BUNIT", "MJy / sr")),
                    "omega_arcsec2": float(hdr.get("OMEGA_MEDIAN", PIXEL_SCALE_ARCSEC ** 2)),
                    "flags": _header_flags(hdr) + (_flag_names(box) if box.size else []),
                    "source": "irsa",
                }
                return meta, img, flags
            last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = repr(e)[:100]
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"IRSA cutout failed: {last}")


def _fetch_s3(rec, ra, dec, half_arcsec):
    url = f"{config.S3_HTTP_BASE}/{rec['key']}"
    pr, pd = imaging.sky_square(ra, dec, half_arcsec)

    def bbox(ihdr):
        w = WCS(s3fits.trim_wcs_header(ihdr))
        xs, ys = w.all_world2pix(pr, pd, 0)
        nx, ny = ihdr["NAXIS1"], ihdr["NAXIS2"]
        x0 = max(int(np.floor(xs.min())) - 3, 0); x1 = min(int(np.ceil(xs.max())) + 4, nx)
        y0 = max(int(np.floor(ys.min())) - 3, 0); y1 = min(int(np.ceil(ys.max())) + 4, ny)
        return (x0, x1, y0, y1) if x1 - x0 > 1 and y1 - y0 > 1 else None

    slab = s3fits.read_slab(url, bbox)
    if slab is None:
        return None
    hd = s3fits.wave_hdul_from_bytes(slab["wave_bytes"])
    meta = _make_native(slab["header"], slab["x0"], slab["y0"], slab["img"], slab["flags"], hd, ra, dec, "s3")
    return meta, slab["img"], slab["flags"]


def _native_key(rec, ra, dec, half):
    return cache.key_hash("native", rec["id"], f"{ra:.5f}", f"{dec:.5f}", f"{half:.1f}")


def get_native(rec, ra, dec, half_arcsec, arrays=True):
    """Return (meta, img, flags) for a native-pixel cutout, from cache when possible.

    meta only (img/flags None) when arrays=False and the meta JSON is cached.
    Returns None if the cutout box misses the detector entirely.
    """
    k = _native_key(rec, ra, dec, half_arcsec)
    meta = cache.read_json("native_meta", k)
    if meta is not None:
        if meta.get("miss"):
            return None
        if not arrays:
            return meta, None, None
        z = cache.read_npz("native", k)
        if z is not None:
            return meta, z["img"], z["flags"]
    with cache.key_lock(k):
        meta = cache.read_json("native_meta", k)
        if meta is not None and not meta.get("miss"):
            z = cache.read_npz("native", k)
            if z is not None:
                return meta, z["img"], z["flags"]
        res = None
        err = None
        if config.USE_S3 and rec.get("key"):
            try:
                res = _fetch_s3(rec, ra, dec, half_arcsec)
                if res is None:
                    cache.write_json("native_meta", k, {"miss": True})
                    return None
            except Exception as e:  # noqa: BLE001
                err = e
        if res is None:
            res = _fetch_irsa(rec, ra, dec, half_arcsec)
        meta, img, flags = res
        cache.write_npz("native", k, img=img, flags=flags)
        cache.write_json("native_meta", k, meta)
        return meta, img, flags


def probe(rec, ra, dec):
    """Cheap per-frame metadata at the position: wavelength, central flags. None if off-detector."""
    try:
        res = get_native(rec, ra, dec, config.PROBE_HALF_ARCSEC, arrays=False)
    except Exception:  # noqa: BLE001
        return {"failed": True}
    if res is None or not res[0]["on_frame"]:
        return None
    return res[0]


def frame_list(ra, dec, do_probe=True):
    recs = covering_frames(ra, dec)
    metas = pmap(lambda r: probe(r, ra, dec), recs) if do_probe else [{}] * len(recs)
    out, kept = [], []
    for r, m in zip(recs, metas):
        if do_probe and m is None:
            continue  # footprint polygon contains the point but it falls on a masked edge
        failed = (not do_probe) or m.get("failed")
        wl = (r["band_um"][0] + r["band_um"][1]) / 2 if failed else m["wavelength_um"]
        kept.append(r)
        out.append({"rec": r, "wavelength_um": round(wl, 4), "flags": [] if failed else m["flags"],
                    "wavelength_approx": bool(failed)})
    return kept, out


# ---------------------------------------------------------------------------
# Processed cutouts
# ---------------------------------------------------------------------------
def processed_cutout(rec, ra, dec, fov, size):
    """Reprojected, background-subtracted, masked float32 (size,size), row 0 = north."""
    k = cache.key_hash("img", rec["id"], f"{ra:.6f}", f"{dec:.6f}", f"{fov:.4f}", size)
    arr = cache.read_npy("img", k)
    if arr is not None:
        return arr
    with cache.key_lock(k):
        arr = cache.read_npy("img", k)
        if arr is not None:
            return arr
        half = fov * 30.0 + 2 * PIXEL_SCALE_ARCSEC
        res = get_native(rec, ra, dec, half)
        if res is None:
            arr = np.full((size, size), np.nan, np.float32)
        else:
            meta, img, flags = res
            data = img.copy()
            data[(flags & BAD_MASK) != 0] = np.nan
            wcs = WCS(fits.Header.fromstring(meta["wcs"]))
            sub = wcs.slice((slice(meta["y0"], meta["y0"] + img.shape[0]),
                             slice(meta["x0"], meta["x0"] + img.shape[1])))
            arr = imaging.reproject_to_grid(data, sub, imaging.target_wcs(ra, dec, fov, size), size)
            arr = imaging.subtract_background(arr)
        cache.write_npy("img", k, arr)
        return arr


def stack_cutouts(ra, dec, fov, size, pass_no, detector, wmin=None, wmax=None):
    recs, info = frame_list(ra, dec)
    sel = [(r, i) for r, i in zip(recs, info)
           if r["pass"] == pass_no and r["detector"] == detector
           and (wmin is None or i["wavelength_um"] >= wmin) and (wmax is None or i["wavelength_um"] <= wmax)]
    if not sel:
        return None
    k = cache.key_hash("stack", f"{ra:.6f}", f"{dec:.6f}", f"{fov:.4f}", size,
                       ",".join(sorted(r["id"] for r, _ in sel)))
    hit = cache.read_npy("stack", k)
    wl = [i["wavelength_um"] for _, i in sel]
    meta = {"n_frames": len(sel), "wavelength_um": [min(wl), max(wl)],
            "time": _iso(float(np.mean([r["mjd"] for r, _ in sel])))}
    if hit is not None:
        return hit, meta
    cuts = pmap(lambda ri: processed_cutout(ri[0], ra, dec, fov, size), sel)
    good = [c for c in cuts if np.isfinite(c).mean() > 0.2]
    if not good:
        good = cuts
    meta["n_used"] = len(good)
    arr = imaging.sigma_clipped_mean(np.stack(good))
    cache.write_npy("stack", k, arr)
    return arr, meta


# ---------------------------------------------------------------------------
# Spectrum
# ---------------------------------------------------------------------------
def aperture_point(meta, img, flags, radius_arcsec, xy=None):
    """Aperture photometry on native pixels with a local sigma-clipped background annulus.

    xy: optional (x, y) position inside the cutout; defaults to the cutout's own target position.
    """
    ny, nx = img.shape
    cx, cy = xy if xy is not None else (meta["px"] - meta["x0"], meta["py"] - meta["y0"])
    sat = (flags & SAT_BITS) != 0
    bad = ~np.isfinite(img) | ((flags & HARD_BITS) != 0) | (((flags & SOFT_BITS) != 0) & ~sat)
    r = max(radius_arcsec / PIXEL_SCALE_ARCSEC, 0.5)
    ap = CircularAperture((cx, cy), r)
    tot = float(aperture_photometry(np.where(bad, 0.0, img), ap, method="exact")["aperture_sum"][0])
    area = float(ap.area_overlap(img, mask=bad, method="exact"))
    if area < 0.5 * np.pi * r * r:
        return None
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.hypot(xx - cx, yy - cy)
    r_in = max(2.0 * r, 2.5); r_out = r_in + 3.0
    ann = (d >= r_in) & (d < r_out) & ~bad
    if ann.sum() < 8:
        return None
    _, bg, sd = sigma_clipped_stats(img[ann], sigma=3.0, maxiters=5)
    sb = tot / area - float(bg)
    in_ap = np.hypot(np.mgrid[0:ny, 0:nx][1] - cx, np.mgrid[0:ny, 0:nx][0] - cy) <= r + 0.5
    saturated = bool((flags[in_ap] & (1 << 1)).any())
    omega_sr = meta["omega_arcsec2"] * (np.pi / 180 / 3600) ** 2
    return {"flux_mjy_sr": sb, "err": float(sd) / np.sqrt(max(area, 1.0)),
            "flux_mjy": sb * area * omega_sr * 1e9, "background_mjy_sr": float(bg),
            "aperture_pix": area, "saturated": saturated}


def halo_point(meta, img, flags, xy=None):
    """Brightness of a star's outer halo, for stars whose core is saturated.

    A saturated core cannot be measured, but the light the telescope spreads into a ring a few
    pixels out scales with the star's true brightness. Returns the median surface brightness in a
    ring 4-7 native pixels from the star minus the median in a ring 10-13 pixels out (MJy/sr), or
    None when too few clean pixels are available.
    """
    ny, nx = img.shape
    cx, cy = xy if xy is not None else (meta["px"] - meta["x0"], meta["py"] - meta["y0"])
    sat = (flags & SAT_BITS) != 0
    bad = ~np.isfinite(img) | sat | ((flags & HARD_BITS) != 0)
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.hypot(xx - cx, yy - cy)
    ring = (d >= 4.0) & (d < 7.0) & ~bad
    sky = (d >= 10.0) & (d < 13.0) & ~bad
    if ring.sum() < 25 or sky.sum() < 40:
        return None
    return float(np.median(img[ring]) - np.median(img[sky]))


def spectrum(ra, dec, radius_arcsec, cra=None, cdec=None):
    """One photometry point per exposure.

    If (cra, cdec) is the centre of a field whose probe cutouts are already cached and (ra, dec)
    lies well inside those cutouts, the cached pixels are reused (about 1 s) instead of fetching a
    new cutout from every exposure (30-60 s).
    """
    reuse = False
    if cra is not None and cdec is not None:
        sep = np.hypot((ra - cra) * np.cos(np.radians(dec)), dec - cdec) * 3600.0
        r_pix = max(radius_arcsec / PIXEL_SCALE_ARCSEC, 0.5)
        need = (max(2.0 * r_pix, 2.5) + 3.5) * PIXEL_SCALE_ARCSEC  # outer edge of the background annulus
        reuse = sep + need <= config.PROBE_HALF_ARCSEC
    fra, fdec = (cra, cdec) if reuse else (ra, dec)
    recs, info = frame_list(fra, fdec)

    def one(ri):
        r, i = ri
        if i["wavelength_approx"]:
            return None
        res = get_native(r, fra, fdec, config.PROBE_HALF_ARCSEC)
        if res is None:
            return None
        meta, img, flags = res
        xy = None
        if reuse:
            wcs = WCS(fits.Header.fromstring(meta["wcs"]))
            x, y = wcs.all_world2pix(ra, dec, 0)
            xy = (float(x) - meta["x0"], float(y) - meta["y0"])
            if not (0 <= xy[0] < img.shape[1] and 0 <= xy[1] < img.shape[0]):
                return None
        p = aperture_point(meta, img, flags, radius_arcsec, xy)
        halo = halo_point(meta, img, flags, xy)
        if p is None and halo is None:
            return None
        return {"wavelength_um": round(meta["wavelength_um"], 5),
                "flux_mjy_sr": p["flux_mjy_sr"] if p else None, "err": p["err"] if p else None,
                "flux_mjy": p["flux_mjy"] if p else None, "halo_mjy_sr": halo,
                "time": _iso(r["mjd"]), "pass": r["pass"], "detector": r["detector"],
                "flags": meta["flags"], "saturated": p["saturated"] if p else True}

    pts = [p for p in pmap(one, list(zip(recs, info))) if p]
    pts.sort(key=lambda p: p["wavelength_um"])
    return pts, len(recs)
