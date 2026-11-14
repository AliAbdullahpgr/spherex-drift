"""Partial reads of SPHEREx Level-2 FITS files with HTTP Range requests.

A full file is ~66 MB (IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE). For a
cutout we only need:
  * the IMAGE header (WCS) -> bytes 0..~46k
  * the last 5760 bytes (WCS-WAVE table: per-pixel wavelength)
  * a slab of whole IMAGE rows (rows are contiguous: 8160 B each)
  * FLAGS is a RICE-compressed table with ONE ROW PER IMAGE ROW, so we fetch
    the 16 kB descriptor table plus only the heap bytes of the rows we need
    and re-assemble a tiny valid FITS file in memory for astropy to decode.
Typical cold cost per frame: ~3 sequential rounds of small requests (~1 s).
"""
import io
import math
import re
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from . import config

BLOCK = 2880
_client = httpx.Client(
    timeout=httpx.Timeout(60.0, connect=15.0),
    limits=httpx.Limits(max_connections=config.MAX_HTTP_CONNECTIONS,
                        max_keepalive_connections=config.MAX_HTTP_CONNECTIONS),
    headers={"User-Agent": "spherex-drift/0.1"},
)
_io_pool = ThreadPoolExecutor(max_workers=config.MAX_HTTP_CONNECTIONS, thread_name_prefix="s3io")


class FetchError(RuntimeError):
    pass


def _get(url, start=None, end=None, suffix=None, retries=5):
    rng = f"bytes=-{suffix}" if suffix is not None else f"bytes={start}-{end}"
    last = None
    for i in range(retries):
        try:
            r = _client.get(url, headers={"Range": rng})
            if r.status_code in (200, 206):
                return r.content
            last = f"HTTP {r.status_code}"
            if r.status_code in (403, 404):
                break
        except httpx.HTTPError as e:
            last = repr(e)[:120]
        time.sleep(0.5 * 2 ** i)
    raise FetchError(f"range {rng} failed ({last}): {url}")


def _parallel(*calls):
    futs = [_io_pool.submit(*c) for c in calls]
    return [f.result() for f in futs]


def _pad(n):
    return int(math.ceil(n / BLOCK) * BLOCK)


def _parse_header(buf, offset=0):
    """Return (Header, header_length_bytes) or (None, None) if END not in buf."""
    for i in range(offset, len(buf) - 79, 80):
        if buf[i:i + 8] == b"END     ":
            hlen = _pad(i + 80 - offset)
            if offset + hlen > len(buf):
                return None, None
            return fits.Header.fromstring(buf[offset:offset + hlen].decode("ascii")), hlen
    return None, None


_PRIMARY = fits.PrimaryHDU().header.tostring().encode("ascii")
_WCS_KEEP = re.compile(
    r"^(CRPIX|CRVAL|CTYPE|CUNIT|CDELT)[12]$|^PC[12]_[12]$|^(LONPOLE|LATPOLE|WCSAXES|RADESYS)$|"
    r"^(A|B|AP|BP)_(ORDER|\d_\d)$")


def trim_wcs_header(hdr):
    """Celestial WCS keywords only (primary key, incl. SIP) - small enough to cache."""
    out = fits.Header()
    for k in hdr:
        if _WCS_KEEP.match(k):
            out[k] = hdr[k]
    return out


def wavelength_at(img_hdr, wave_hdul, x, y):
    """Central wavelength (um) at 0-based pixel (x, y) from the spectral lookup-table WCS."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w = WCS(img_hdr, fobj=wave_hdul, key="W")
        xx = float(np.clip(x, 0, 2039)); yy = float(np.clip(y, 0, 2039))
        return float(w.all_pix2world([[xx, yy]], 0)[0][0])


def wave_hdul_from_bytes(wave_bytes):
    return fits.open(io.BytesIO(_PRIMARY + wave_bytes))


def read_slab(url, bbox_fn):
    """Read header, wavelength table, an IMAGE row slab and the matching FLAGS rows.

    bbox_fn(image_header) -> (x0, x1, y0, y1) integer pixel box (half-open, clipped) or None.
    Returns dict(header, wave_bytes, x0, y0, img, flags) or None when the box misses the frame.
    """
    head, wave = _parallel((_get, url, 0, BLOCK * 16 - 1), (_get, url, None, None, 5760))
    phdr, plen = _parse_header(head, 0)
    ihdr, ilen = _parse_header(head, plen)
    if ihdr is None:
        raise FetchError("could not parse IMAGE header")
    nx, ny = ihdr["NAXIS1"], ihdr["NAXIS2"]
    idata = plen + ilen
    if not wave.startswith(b"XTENSION= 'BINTABLE'") or ihdr["BITPIX"] != -32:
        raise FetchError("unexpected SPHEREx file layout")
    box = bbox_fn(ihdr)
    if box is None:
        return None
    x0, x1, y0, y1 = box
    rowb = nx * 4
    flags_hdr_loc = idata + _pad(nx * ny * 4)
    img_bytes, fl_head = _parallel(
        (_get, url, idata + y0 * rowb, idata + y1 * rowb - 1),
        (_get, url, flags_hdr_loc, flags_hdr_loc + 45000 - 1))
    img = np.frombuffer(img_bytes, dtype=">f4").reshape(y1 - y0, nx)[:, x0:x1].astype(np.float32)

    fhdr, flen = _parse_header(fl_head, 0)
    if fhdr is None:
        raise FetchError("could not parse FLAGS header")
    tbl_bytes = fhdr["NAXIS1"] * fhdr["NAXIS2"]
    if flen + tbl_bytes > len(fl_head):
        fl_head = _get(url, flags_hdr_loc, flags_hdr_loc + flen + tbl_bytes - 1)
    desc = np.frombuffer(fl_head[flen:flen + tbl_bytes], dtype=">i4").reshape(fhdr["NAXIS2"], 2)
    sel = desc[y0:y1].astype(np.int64)
    lo = int(sel[:, 1].min()); hi = int((sel[:, 1] + sel[:, 0]).max())
    heap_start = flags_hdr_loc + flen + tbl_bytes
    heap = _get(url, heap_start + lo, heap_start + hi - 1)
    nrows = y1 - y0
    fhdr2 = fhdr.copy()
    fhdr2["NAXIS2"] = nrows
    fhdr2["PCOUNT"] = len(heap)
    fhdr2["ZNAXIS2"] = nrows
    d2 = sel.copy(); d2[:, 1] -= lo
    body = d2.astype(">i4").tobytes() + heap
    body += b"\0" * (_pad(len(body)) - len(body))
    mini = _PRIMARY + fhdr2.tostring().encode("ascii") + body
    with fits.open(io.BytesIO(mini)) as h:
        flags = np.asarray(h[1].data, dtype=np.int32)[:, x0:x1]
    return {"header": ihdr, "wave_bytes": wave, "x0": x0, "y0": y0, "img": img, "flags": flags}
