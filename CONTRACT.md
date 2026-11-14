# API contract (shared by /api and /web)

Backend: FastAPI at http://localhost:8000, CORS open to http://localhost:3000.
Frontend: Next.js at http://localhost:3000, reads backend base URL from NEXT_PUBLIC_API_URL.

All coordinates are ICRS decimal degrees. `fov` is the cutout width in arcminutes (default 5, max 30).

## GET /targets
The five required test targets.
```json
[{"id":"wise0855","name":"WISE 0855","ra":133.795129,"dec":-7.245147,"note":"fast-moving brown dwarf"}]
```
ids: barnard, epsindib, wise0855, rwaur, rdra

## GET /frames?ra&dec&fov&group=detector|band&survey=spherex
Lists the image frames covering the position, oldest first. Does NOT return pixels.
```json
{
  "ra": 133.79, "dec": -7.24, "fov": 5,
  "frames": [
    {
      "id": "opaque-string",
      "survey": "spherex",          // or "wise"
      "time": "2025-11-02T10:11:12Z",
      "mjd": 60981.42,
      "detector": 3,                 // 1..6 for spherex, null for wise
      "wavelength_um": 2.1,          // central wavelength at this position
      "pass": 1,                     // which sky pass / epoch index, starting at 1
      "flags": ["contaminated"],     // quality flags, may be empty
      "image_url": "/image/opaque-string?ra=..&dec=..&fov=..&stretch=asinh"
    }
  ],
  "passes": [{"pass":1,"start":"2025-05-..","end":"2025-11-..","n_frames":42}]
}
```

## GET /image/{frame_id}?ra&dec&fov&stretch=asinh|linear|log&size=256&format=png|npy
PNG cutout, north up, east left, centred on ra/dec. Grayscale 8-bit.
`format=npy` returns raw float32 array bytes (little-endian, size x size) with header
`X-Shape: 256,256`, used by the browser for difference and colour composites.

## GET /stack?ra&dec&fov&pass=1&detector=3&size=256&format=png|npy
Co-added image of all frames from one detector in one pass (better signal to noise).

## GET /spectrum?ra&dec&radius_arcsec=6
```json
{"points":[{"wavelength_um":0.75,"flux_mjy_sr":1.2,"err":0.1,"time":"...","pass":1,"detector":1,"flags":[]}]}
```

## GET /wise/frames?ra&dec&fov   and   GET /wise/image/{frame_id}?ra&dec&fov&size&format
Same shapes as /frames and /image, survey = "wise", one frame per WISE epoch (2010 onward),
`wavelength_um` 3.4 (W1) or 4.6 (W2).

## GET /health
`{"ok": true}`

Errors: JSON `{"detail": "..."}` with 4xx/5xx. No coverage returns 200 with `"frames": []`.

## Additions
Added by the SPHEREx backend (api/). Existing shapes are unchanged; everything below is additive.

- **Array orientation (`format=npy`)**: float32 little-endian, row-major, **row 0 is the north edge** and
  column 0 the east edge (i.e. the array already matches how a PNG/canvas is drawn: north up, east left).
  Unit is MJy/sr (surface brightness), background (per-frame median) subtracted. Pixels flagged bad in the
  SPHEREx FLAGS plane (cosmic-ray transients, overflow/saturation, bloom, snowball, halo, dead/hot/cold,
  outliers, streaks, ...) and everything off the detector are **NaN**; the PNG renders NaN as 0 (black) and valid
  pixels as 1..255. Extra response headers: `X-Unit`, `X-Frame-Id` (/image), `X-N-Frames` and
  `X-Wavelength-Um` ("min,max") (/stack).
- **/frames**: each frame also has `band_um` ([min,max] of the detector band) and `wavelength_approx`
  (true only if the per-position wavelength could not be read; then `wavelength_um` is the band centre).
  `flags` are lower-case names (e.g. `transient`, `overflow`, `nonfunc`, `halo`, `persist`, `outlier`,
  `shuttle_glow`, `l2_dqa_fail`, `poor_astrometry`) for the ~7x7 native pixels around the position.
  `time`/`mjd` are the exposure start from SIA `t_min`. `pass` is a cluster of observation times (a gap of more
  than 45 days starts a new pass). Optional query `probe=false` skips the per-frame metadata (fast, but then
  `wavelength_um` is the band centre and `flags` is empty). Optional `group=detector|band` adds a `groups`
  summary and never reorders frames. Frames whose footprint does not actually contain the position are dropped.
- **/stack**: `detector` is required; optional `wmin`, `wmax` (um) restrict which exposures enter the stack
  (by their wavelength at the position). Sigma-clipped (3 sigma) mean of the aligned, background-subtracted
  cutouts of that detector within that pass; the exposures are at *different wavelengths inside the detector's
  band* (use wmin/wmax to narrow). 404 if nothing matches.
- **/spectrum**: response also has `unit` ("MJy/sr"), `radius_arcsec`, `n_frames`, `n_points`, `n_excluded`.
  `flux_mjy_sr` is the mean surface brightness inside the aperture minus a local annulus background, in **MJy/sr**
  (the unit of the L2 files; despite the key name it is not mJy/sr). Each point also has `flux_mjy`
  (integrated aperture flux in mJy) and `saturated` (true if an aperture pixel hit the OVERFLOW flag: the
  flux is then a lower limit; bright stars such as Barnard's Star saturate). `err` is the annulus scatter
  divided by sqrt(aperture pixels), in MJy/sr.
- **Coordinates of movers**: `/targets` positions of fast movers are for epoch ~2026.0 (Barnard's Star,
  eps Indi B, RW Aur, R Dra: Gaia DR3 propagated). WISE 0855 uses the position given in CHALLENGE.md (older
  epoch); it moves ~8 arcsec/yr, so it sits ~2 arcmin west of that position in SPHEREx data, still inside a 5' field.
- **Timing**: first request for a position is slow (IRSA SIA query + one small S3 range read per frame,
  ~20-40 s for /frames with 250-550 frames); everything afterwards is served from the disk cache in
  well under a second. Run `api/scripts/precache.py` before a demo.
