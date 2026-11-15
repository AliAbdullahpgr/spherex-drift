"""SPHEREx Drift API - implements CONTRACT.md."""
import io
from typing import Optional
from urllib.parse import urlencode

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from . import config, imaging, spherex, mosaic

app = FastAPI(title="SPHEREx Drift API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"],
                   allow_headers=["*"], expose_headers=["X-Shape", "X-Frame-Id", "X-Wavelength-Um",
                                                         "X-Flags", "X-N-Frames", "X-Unit"])

try:  # WISE router is owned by another module; optional here
    from .wise import router as wise_router
    app.include_router(wise_router)
except ImportError:
    pass

try:  # Gaia / known-object / context overlays (app/overlays.py)
    from .overlays import router as overlays_router
    app.include_router(overlays_router)
except ImportError:
    pass


def _clean(obj):
    """Replace NaN/inf floats with None so the response is valid JSON."""
    if isinstance(obj, float):
        return obj if np.isfinite(obj) else None
    if isinstance(obj, np.floating):
        return float(obj) if np.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def _fov(fov):
    if not (0 < fov <= config.MAX_FOV_ARCMIN):
        raise HTTPException(400, f"fov must be in (0, {config.MAX_FOV_ARCMIN}] arcmin")
    return fov


def _size(size):
    if not (8 <= size <= config.MAX_SIZE):
        raise HTTPException(400, f"size must be in [8, {config.MAX_SIZE}]")
    return size


def _pos(ra, dec):
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise HTTPException(400, "ra must be in [0,360), dec in [-90,90]")


def _upstream(fn):
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream data error: {e!r}"[:300])


def _array_response(arr, fmt, stretch, headers):
    if fmt == "npy":
        a = np.ascontiguousarray(arr, dtype="<f4")
        headers["X-Shape"] = f"{a.shape[0]},{a.shape[1]}"
        return Response(a.tobytes(), media_type="application/octet-stream", headers=headers)
    if fmt == "png":
        return Response(imaging.to_png(arr, stretch), media_type="image/png", headers=headers)
    raise HTTPException(400, "format must be png or npy")


def _check_stretch(stretch):
    if stretch not in ("asinh", "linear", "log"):
        raise HTTPException(400, "stretch must be asinh, linear or log")


_resolve_cache: dict = {}


@app.get("/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=80)):
    """Look up an object name (star, galaxy, nebula...) with the CDS Sesame name service."""
    key = " ".join(name.split()).lower()
    if key not in _resolve_cache:
        from astropy.coordinates import SkyCoord
        from astropy.coordinates.name_resolve import NameResolveError
        try:
            c = SkyCoord.from_name(name)
            _resolve_cache[key] = {"name": name.strip(), "ra": float(c.ra.deg), "dec": float(c.dec.deg)}
        except NameResolveError:
            _resolve_cache[key] = None
        except Exception as e:  # noqa: BLE001 - network trouble: do not cache
            raise HTTPException(502, f"name lookup service unavailable: {e}") from e
    hit = _resolve_cache[key]
    if hit is None:
        raise HTTPException(404, f"no object called '{name.strip()}' was found")
    return hit


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/targets")
def targets():
    return config.TARGETS


@app.get("/frames")
def frames(ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN,
           group: Optional[str] = None, survey: str = "spherex",
           size: int = config.DEFAULT_SIZE, stretch: str = "asinh", probe: bool = True):
    _pos(ra, dec); _fov(fov); _size(size); _check_stretch(stretch)
    if group not in (None, "detector", "band"):
        raise HTTPException(400, "group must be detector or band")
    if survey != "spherex":
        return {"ra": ra, "dec": dec, "fov": fov, "frames": [], "passes": []}
    if (mosaic.PREPARED / f"{mosaic._field_key(ra, dec, fov)}.npz").exists():
        return _clean(mosaic.frames(ra, dec, fov, size))
    try:
        recs, info = spherex.frame_list(ra, dec, do_probe=probe)
    except Exception:
        # The independently hosted DR1 FITS cube remains usable during an SIA outage.
        return _clean(_upstream(lambda: mosaic.frames(ra, dec, fov, size)))
    q = urlencode({"ra": ra, "dec": dec, "fov": fov, "stretch": stretch, "size": size})
    out = []
    for r, i in zip(recs, info):
        out.append({
            "id": r["id"], "survey": "spherex", "time": spherex._iso(r["mjd"]), "mjd": round(r["mjd"], 6),
            "detector": r["detector"], "wavelength_um": i["wavelength_um"], "pass": r["pass"],
            "flags": i["flags"], "image_url": f"/image/{r['id']}?{q}",
            # additions (see CONTRACT.md "Additions")
            "band_um": r["band_um"], "wavelength_approx": i["wavelength_approx"],
        })
    # `out` is in time order already; group=* only adds a summary, never reorders.
    res = {"ra": ra, "dec": dec, "fov": fov, "frames": out, "passes": spherex.pass_summary(recs)}
    if group:
        key = "detector" if group == "detector" else "band"
        counts = {}
        for f in out:
            g = f["detector"]
            counts[g] = counts.get(g, 0) + 1
        res["groups"] = {"by": key, "counts": {str(k): v for k, v in sorted(counts.items())}}
    return _clean(res)


@app.get("/mosaic/image/{band}")
def mosaic_image(band: int, ra: float, dec: float, fov: float = 5,
                 size: int = config.DEFAULT_SIZE, format: str = "png", stretch: str = "asinh"):
    _pos(ra, dec); _fov(fov); _size(size); _check_stretch(stretch)
    if not 1 <= band <= 6:
        raise HTTPException(400, "mosaic band must be 1..6")
    arr = _upstream(lambda: mosaic.image(ra, dec, fov, size, band))
    return _array_response(arr, format, stretch, {"X-Unit": "MJy/sr",
                           "Cache-Control": "public, max-age=3600, s-maxage=86400"})


@app.get("/image/{frame_id}")
def image(frame_id: str, ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN,
          stretch: str = "asinh", size: int = config.DEFAULT_SIZE, format: str = "png"):
    _pos(ra, dec); _fov(fov); _size(size); _check_stretch(stretch)

    def work():
        rec = spherex.find_frame(frame_id, ra, dec)
        if rec is None:
            raise HTTPException(404, "frame not found at this position")
        arr = spherex.processed_cutout(rec, ra, dec, fov, size)
        return rec, arr

    rec, arr = _upstream(work)
    return _array_response(arr, format, stretch, {"X-Frame-Id": frame_id, "X-Unit": spherex.UNIT,
                                                  "Cache-Control": "public, max-age=3600"})


@app.get("/stack")
def stack(ra: float, dec: float, detector: int, fov: float = config.DEFAULT_FOV_ARCMIN,
          pass_: int = Query(1, alias="pass"), size: int = config.DEFAULT_SIZE,
          format: str = "png", stretch: str = "asinh",
          wmin: Optional[float] = None, wmax: Optional[float] = None):
    _pos(ra, dec); _fov(fov); _size(size); _check_stretch(stretch)
    if not 1 <= detector <= 6:
        raise HTTPException(400, "detector must be 1..6")
    prepared_mosaic = mosaic.PREPARED / f"{mosaic._field_key(ra, dec, fov)}.npz"
    if prepared_mosaic.exists():
        if pass_ != 1:
            raise HTTPException(404, "The DR1 mosaic is a coadd, not a set of observing passes")
        arr = _upstream(lambda: mosaic.image(ra, dec, fov, size, detector))
        return _array_response(arr, format, stretch, {"X-N-Frames": "17", "X-Unit": "MJy/sr",
              "Cache-Control": "public, max-age=3600, s-maxage=86400"})
    res = _upstream(lambda: spherex.stack_cutouts(ra, dec, fov, size, pass_, detector, wmin, wmax))
    if res is None:
        raise HTTPException(404, "no frames for this pass/detector/wavelength range at this position")
    arr, meta = res
    return _array_response(arr, format, stretch, {
        "X-N-Frames": str(meta["n_frames"]), "X-Unit": spherex.UNIT,
        "X-Wavelength-Um": f"{meta['wavelength_um'][0]:.4f},{meta['wavelength_um'][1]:.4f}",
        "Cache-Control": "public, max-age=3600"})


@app.get("/spectrum")
def spectrum(ra: float, dec: float, radius_arcsec: float = 6.0,
             cra: Optional[float] = None, cdec: Optional[float] = None,
             source: Optional[str] = None, fov: float = 5):
    _pos(ra, dec)
    if not 1 <= radius_arcsec <= 60:
        raise HTTPException(400, "radius_arcsec must be in [1, 60]")
    _fov(fov)
    if cra is not None and cdec is not None:
        _pos(cra, cdec)
    center_ra, center_dec = cra if cra is not None else ra, cdec if cdec is not None else dec
    prepared_mosaic = mosaic.PREPARED / f"{mosaic._field_key(center_ra, center_dec, fov)}.npz"
    if source == "dr1-mosaic" or (source != "native" and prepared_mosaic.exists()):
        return _clean(_upstream(lambda: mosaic.spectrum(ra, dec, cra if cra is not None else ra,
                                  cdec if cdec is not None else dec, fov, radius_arcsec)))
    pts, n = _upstream(lambda: spherex.spectrum(ra, dec, radius_arcsec, cra, cdec))
    return _clean({"points": pts, "unit": spherex.UNIT, "radius_arcsec": radius_arcsec,
            "n_frames": n, "n_points": len(pts), "n_excluded": n - len(pts),
            "note": "flux_mjy_sr is mean surface brightness in the aperture minus a local annulus "
                    "background, in MJy/sr (the unit of the SPHEREx L2 files; despite the key name "
                    "it is NOT mJy/sr). flux_mjy is the integrated aperture flux in mJy."})
