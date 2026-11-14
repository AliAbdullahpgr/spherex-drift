"""Common output grid, background subtraction, sigma-clipped stacking, PNG rendering."""
import io

import numpy as np
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp


def target_wcs(ra, dec, fov_arcmin, size):
    """TAN grid centred on (ra, dec); north up, east left; pixel = fov/size.

    Array row 0 is the SOUTH edge as reproject returns it; `to_north_up` flips it.
    """
    scale = fov_arcmin * 60.0 / size / 3600.0
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crpix = [(size + 1) / 2.0, (size + 1) / 2.0]
    w.wcs.cdelt = [-scale, scale]
    w.wcs.crval = [ra, dec]
    return w


def sky_square(ra, dec, half_arcsec, n=7):
    """n x n sky points covering a north-up square of half-width half_arcsec around (ra, dec)."""
    w = target_wcs(ra, dec, 2 * half_arcsec / 60.0, 100)  # 100 px across
    g = np.linspace(0.5, 99.5, n)
    xx, yy = np.meshgrid(g, g)
    r, d = w.all_pix2world(xx.ravel(), yy.ravel(), 0)
    return r, d


def reproject_to_grid(img, src_wcs, twcs, size):
    """Bilinear resample (surface brightness) -> float32 (size,size), row 0 = north."""
    out, _ = reproject_interp((img, src_wcs), twcs, shape_out=(size, size),
                              order="bilinear", return_footprint=True)
    return np.ascontiguousarray(out[::-1, :].astype(np.float32))


def subtract_background(arr):
    fin = arr[np.isfinite(arr)]
    if fin.size < 10:
        return arr
    return (arr - np.float32(np.median(fin))).astype(np.float32)


def sigma_clipped_mean(cube, sigma=3.0, iters=3):
    """Per-pixel sigma-clipped mean of a (n, h, w) NaN-padded stack.

    The clip scale is max(per-pixel MAD sigma, median of those sigmas) so a pixel
    with a lucky tiny scatter cannot clip real signal. n<=2: plain mean;
    n==3: median.
    """
    cube = np.asarray(cube, dtype=np.float32)
    n = cube.shape[0]
    if n == 1:
        return cube[0].copy()
    if n <= 2:
        return np.nanmean(cube, axis=0).astype(np.float32)
    if n == 3:
        return np.nanmedian(cube, axis=0).astype(np.float32)
    work = cube.copy()
    for _ in range(iters):
        med = np.nanmedian(work, axis=0)
        sd = 1.4826 * np.nanmedian(np.abs(work - med), axis=0)
        floor = np.nanmedian(sd[np.isfinite(sd)]) if np.isfinite(sd).any() else 0.0
        sd = np.maximum(sd, floor)
        bad = np.abs(work - med) > sigma * sd
        if not bad.any():
            break
        work[bad] = np.nan
    return np.nanmean(work, axis=0).astype(np.float32)


def to_png(arr, stretch="asinh"):
    """8-bit grayscale PNG. NaN -> 0 (black); valid pixels are mapped to 1..255."""
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
    Image.fromarray(a, mode="L").save(buf, format="PNG", optimize=False)
    return buf.getvalue()
