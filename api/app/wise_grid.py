"""Grid / rendering helpers for the WISE module (self-contained; mirrors the SPHEREx grid convention).

Grid: TAN centred on (ra, dec), north up (row 0 = north), east left, pixel = fov/size.
"""
import io

import numpy as np
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_adaptive, reproject_interp

WISE_PIX_ARCSEC = 2.75


def target_wcs(ra, dec, fov_arcmin, size):
    scale = fov_arcmin * 60.0 / size / 3600.0
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crpix = [(size + 1) / 2.0, (size + 1) / 2.0]
    w.wcs.cdelt = [-scale, scale]
    w.wcs.crval = [ra, dec]
    return w


def source_wcs(crval1, crval2, crpix1, crpix2):
    """unWISE tile-style TAN WCS (2.75"/px, north up, east left); array y increases to the north."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crval = [crval1, crval2]
    w.wcs.crpix = [crpix1, crpix2]
    s = WISE_PIX_ARCSEC / 3600.0
    w.wcs.cdelt = [-s, s]
    return w


def reproject_north_up(img, swcs, twcs, size, fov_arcmin):
    """img has row 0 = south (WCS convention). Returns float32 (size,size), row 0 = north."""
    ratio = (fov_arcmin * 60.0 / size) / WISE_PIX_ARCSEC
    if ratio > 1.5:  # downsampling: flux-conserving-ish smoothing to avoid aliasing
        out, _ = reproject_adaptive((img, swcs), twcs, shape_out=(size, size),
                                    conserve_flux=False, return_footprint=True)
    else:
        out, _ = reproject_interp((img, swcs), twcs, shape_out=(size, size),
                                  order="bilinear", return_footprint=True)
    return np.ascontiguousarray(out[::-1, :].astype(np.float32))


def subtract_median(arr):
    fin = arr[np.isfinite(arr)]
    if fin.size < 10:
        return arr
    return (arr - np.float32(np.median(fin))).astype(np.float32)


def to_png(arr, stretch="asinh"):
    """8-bit grayscale PNG; NaN -> 0 (black), valid pixels 1..255."""
    fin = np.isfinite(arr)
    if fin.sum() < 10:
        return _png(np.zeros(arr.shape, np.uint8))
    lo, hi = np.percentile(arr[fin], [1.0, 99.7])
    if hi <= lo:
        hi = lo + 1e-9
    x = np.clip((np.where(fin, arr, lo) - lo) / (hi - lo), 0, 1)
    if stretch == "asinh":
        x = np.arcsinh(x * 10.0) / np.arcsinh(10.0)
    elif stretch == "log":
        x = np.log10(1.0 + x * 1000.0) / 3.0
    img = (1 + x * 254).astype(np.uint8)
    img[~fin] = 0
    return _png(img)


def _png(a):
    buf = io.BytesIO()
    Image.fromarray(a, mode="L").save(buf, format="PNG")
    return buf.getvalue()
