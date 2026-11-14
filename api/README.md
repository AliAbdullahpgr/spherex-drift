# SPHEREx Drift API

FastAPI backend implementing `../CONTRACT.md` (see its "Additions" section for extras).

## Run
```bash
cd api
.venv/bin/uvicorn app.main:app --port 8000        # CORS open to http://localhost:3000
.venv/bin/python scripts/precache.py              # warm the cache for the five targets (do this before a demo)
.venv/bin/python -m pytest -q tests               # offline tests; SPHEREX_LIVE=1 adds network tests
```
Python 3.12+ works (developed on 3.14). `pip install -r requirements.txt`.

## How it works
1. **Discovery**: IRSA SIA (`astroquery.ipac.irsa.Irsa.query_sia`) for the collections in `app/config.py`
   (`COLLECTIONS`, env `SPHEREX_COLLECTIONS`; currently `spherex_dr1`, `spherex_qr3`). A new data release is a
   one-line change there. Results are cached on disk for 12 h. The footprint polygon (`s_region`) is tested
   locally so only exposures that really contain the position are kept (each of the six detectors has its own
   footprint). Observation time is SIA `t_min` (the FITS `DATE` header is processing time).
2. **Pixels**: from the public S3 mirror (`nasa-irsa-spherex`, key from the SIA `cloud_access` column) with HTTP
   Range requests (`app/s3fits.py`): the IMAGE header, the last 5760 bytes (per-pixel wavelength table), only the
   IMAGE rows needed, and only the needed rows of the RICE-compressed FLAGS table. ~1 s per frame cold, instead of
   66 MB. If S3 fails, falls back to the IRSA server-side cutout service (~5-10 s per frame; verified to give the
   same image). `SPHEREX_USE_S3=0` forces the fallback.
3. **Common grid**: every cutout is bilinearly resampled onto one TAN grid centred on ra/dec, north up, east left,
   pixel = fov/size; the per-frame median is subtracted; FLAGS-bad pixels (and everything off-detector) are NaN.
4. **Passes**: observation times of the frames covering the position are clustered; a gap > 45 days starts a new
   pass (`PASS_GAP_DAYS`).
5. **Spectrum**: per exposure, aperture photometry (photutils exact aperture) on native pixels with a
   sigma-clipped local annulus background; unit MJy/sr (as in the files); sorted by wavelength.
6. **Cache** (`api/cache/`, gitignored): SIA results, native cutouts, processed cutouts, stacks. Concurrency is
   bounded (`SPHEREX_FRAME_WORKERS`, `SPHEREX_HTTP_CONNECTIONS`) and identical in-flight work is de-duplicated.

## Known limitations
- Cold `/frames` for a position takes 20-40 s (one probe per exposure to read wavelength + flags); later calls
  are instant. Use `probe=false` for an instant, approximate list.
- A stack averages exposures at different wavelengths within one detector band (use `wmin`/`wmax`).
- Very bright stars (Barnard's Star) saturate; saturated pixels are NaN in images and flagged in the spectrum.
- Movers: pass the position for the epoch you care about; `/targets` coordinates are for ~2026.0.
