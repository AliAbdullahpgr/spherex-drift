# Build plan

Read [CHALLENGE.md](CHALLENGE.md) first, then [CONTRACT.md](CONTRACT.md).

## What we are building

A Next.js website plus a FastAPI backend. The user enters RA/Dec; the site plays SPHEREx images of that patch across time. Event dates: 14–15 November 2026.

## The problem that shapes the design

- SPHEREx started surveying in May 2025 and covers the sky about once every six months, so there are only about three passes so far. (Not yet verified per target — see "Open questions".)
- SPHEREx pixels are about 6.15 arcsec. Fast movers shift only a pixel or two across all passes: Barnard's Star moves about 10.4 arcsec/yr, WISE 0855 about 8.1 arcsec/yr.
- Each exposure sees a given sky position at one wavelength (linear variable filters on 6 detectors). The "102 bands" come from many exposures, so one position has many frames per pass, each at a different wavelength between 0.75 and 5 µm.

A plain "play three frames" viewer therefore shows almost nothing. The features below exist to beat that.

## What makes this entry different (priority order)

1. **Rainbow trail** — composite all epochs into one image, earliest tinted blue, latest red. Stationary sources come out white; movers show as a coloured streak. Motion visible in a single still.
2. **WISE prepended to the timeline** — WISE/NEOWISE epochs from 2010 to 2024 followed by SPHEREx, so a one-pixel shift becomes a 15-year march.
3. **Time × wavelength pad** — one 2D control: horizontal is pass/time, vertical is wavelength/detector. Shows what data exists and lets the user drag through it.
4. **Difference view** — epoch B minus epoch A; a mover appears as a dark/bright pair.
5. **Click-for-spectrum** with markers at water ice (~3.0 µm), CO2 (~4.27 µm) and CO (~4.67 µm), coloured by pass so variability shows.
6. **Gaia proper-motion arrows** — "moves but has no arrow" is the thing to look for.
7. Smaller: coordinates in the URL, `?embed=1` iframe mode, quality-flag badges, a short walkthrough on WISE 0855.

Get the basic player plus 1 and 4 solid before the rest. A broken extra is worse than a missing one.

## Architecture

```
Next.js (Vercel)                      FastAPI (always-on host)
/?ra=..&dec=..&fov=..   ──fetch──►   /frames  /image  /stack  /spectrum  /targets
  canvas rendering from             /wise/frames  /wise/image
  float32 arrays (format=npy)         └─ astroquery / IRSA cutouts, disk cache
```

- The browser does stretching, differencing and compositing from raw float32 arrays. PNGs are for thumbnails only.
- All cutouts are reprojected to the same grid: tangent projection centred on the requested RA/Dec, north up, east left, pixel scale = fov / size. This is what makes frames from different exposures and from WISE line up.
- Subtract a per-frame median background before display. Zodiacal light varies a lot between exposures and the blink flickers otherwise.

## Performance

The maths is trivial. The wait is fetching cutouts from the archive: a position can have dozens to hundreds of exposures. Not yet measured. Mitigations:

- disk cache keyed by frame + position + fov
- parallel fetches with a concurrency limit
- return the frame list first, load images progressively
- pre-load the five test targets before the demo
- small default field of view (5 arcmin)

## Build briefs

Three pieces that can be built in parallel against CONTRACT.md.

### 1. SPHEREx backend — `api/app/main.py`, `api/app/spherex.py`

- Start from the IRSA tutorials: https://caltech-ipac.github.io/irsa-tutorials/spherex/
- Find the current public SPHEREx collection in IRSA and make its name a config value, so a new data release is a one-line change.
- Prefer IRSA's server-side cutout service over downloading full images.
- "pass" = which ~6-month sky pass an exposure belongs to; derive it by clustering observation times for the position.
- Mask flagged pixels to NaN in npy output; NaN becomes black in PNG. Report per-frame flags for the central region.
- `/spectrum`: one point per exposure, aperture photometry with a local background annulus, sorted by wavelength. Name the unit the files actually use.
- `/stack`: sigma-clipped mean of aligned cutouts for one detector within one pass.
- `main.py` includes the WISE router inside `try/except ImportError`.
- Done when all endpoints have been run against real data for WISE 0855 and Barnard's Star, an output PNG has been looked at, and coverage has been checked for all five targets.

### 2. WISE epochs — `api/app/wise.py`

- Exposes `router = APIRouter(prefix="/wise")`.
- One frame per epoch per band (W1 3.4 µm, W2 4.6 µm), same JSON shape as SPHEREx frames.
- Data source not yet chosen. Candidates: the WiseView backend's cutout API (http://byw.tools/wiseview), unWISE time-resolved coadds, IRSA image services.
- Acceptance test: measure the centroid shift of Barnard's Star or WISE 0855 between the first and last epoch and compare with the known proper motion.

### 3. Frontend — `web/`

- Next.js App Router, TypeScript, light dependencies.
- All backend access in one module (`lib/api.ts`) with a mock mode (`?mock=1` or no `NEXT_PUBLIC_API_URL`) that generates a synthetic starfield with one moving and one variable star, so the UI can be built before the backend exists.
- All view state in the URL. Coordinate input accepts decimal degrees and sexagesimal.
- Player: per-pass stacks, play/pause/step/speed, timeline with honest date spacing, crosshair, compass, scale bar, RA/Dec readout, stretch controls.
- Dark, instrument-like design; the image is the hero; works at phone width; colour-blind-safe difference map; plain-language copy.

## Open questions

- How many SPHEREx passes actually cover each of the five test targets?
- Real cold and cached response times.
- Which WISE data source is fastest and most reliable.
- Whether the SPHEREx data is also available from a cloud mirror that would be faster from a server.

## Environment notes

- Use Python 3.12 on the server. (The original dev PC had Python 3.14, where astronomy package wheels may be missing.)
- Do not disable TLS verification to work around certificate errors.
- Hosting: frontend on Vercel; backend on an always-on host (VPS, Render, Railway). A batch-job platform is only useful for pre-loading the cache.
