# SPHEREx Drift

Entry for the NASA Space Apps Challenge 2026, challenge **"Planet X and SPHEREx"**.

A public web tool: enter a sky position and watch SPHEREx infrared images of that patch play over time, so objects that move or change stand out.

The application includes a Next.js frontend and a FastAPI backend. See:

- [CHALLENGE.md](CHALLENGE.md) — the official challenge, required test targets and optional extras
- [PLAN.md](PLAN.md) — architecture, what makes this entry different, and the build briefs
- [CONTRACT.md](CONTRACT.md) — the API between the backend and the frontend

## Layout

```
api/   FastAPI backend (Python): finds SPHEREx/WISE images, serves aligned cutouts, stacks, spectra
web/   Next.js frontend (TypeScript): time-lapse player, rainbow trail, difference view, spectrum
```

## Stack

- Backend: Python 3.12, FastAPI, astropy, astroquery, reproject. Data from NASA/IPAC IRSA.
- Frontend: Next.js (App Router), canvas rendering from raw float32 pixel arrays.

## Deploy to Vercel

Run from the repository root. The Vercel projects use Root Directory `web` and `api`;
uploading only an app folder causes a "Root Directory does not exist" build failure.
The deployment script always uploads the full repository and selects the project explicitly.

```powershell
./scripts/deploy.ps1 -App web -Dry     # inspect source files without deploying
./scripts/deploy.ps1 -App web          # preview
./scripts/deploy.ps1 -App api          # preview
./scripts/deploy.ps1 -App web -Production
./scripts/deploy.ps1 -App api -Production
```

On Vercel, the frontend's `/api/*` proxy uses `https://spherex-drift-api.vercel.app`.
Set server-side `SPHEREX_API_ORIGIN` to override it. Locally it uses `http://127.0.0.1:8000`.
`NEXT_PUBLIC_API_URL` can optionally point the browser directly at an API with suitable CORS.
The backend defaults to temporary cache storage on Vercel and `api/cache/` locally;
`SPHEREX_CACHE_DIR`, `WISE_CACHE_DIR`, and `OVERLAY_CACHE_DIR` can override cache paths.
Temporary caches are local to an instance and are recreated after cold starts.

## Hackathon demo

The five preset fields ship with prepared **real WISE observations** and calibrated
**SPHEREx DR1 spectral mosaics**. They open without depending on IRSA's search service.
Data provenance, processing, and the scientific limits are in [api/prepared/README.md](api/prepared/README.md).
Custom sky positions still query live services and can take longer.

Suggested three-minute walkthrough:

1. Open WISE 0855. Play the dates, then choose Trail to reveal the moving source.
2. Open Analysis → Motion → Find movers. The real WISE data recovers about 8.2″/year west.
3. Choose Difference to separate changing sources from the static background.
4. Open RW Aurigae or R Draconis → Brightness for a relative WISE brightness trend.
   The very bright R Draconis uses an outer-halo aperture when its core clips.
5. Choose Spectrum and click a point in the image for the SPHEREx spectral view.
   Masked channels are excluded; the masked core of a bright star can use its halo.

The DR1 mosaic combines dates, has 12.9″ native pixels, and is not time-resolved.
WISE preview brightness is a quick-look trend rather than precision photometry.
Asteroid matching requires dated individual SPHEREx exposures and is disabled for mosaics.
The Simulate tool and offline synthetic demo remain explicitly labelled.

Acceptance checks against a running app or deployment:

```powershell
$env:BASE = 'https://spherex-drift.vercel.app'
$env:OUT = 'D:\tmp\spherex-hackathon-check'
$env:PW_CHANNEL = 'chrome' # omit when using Playwright's installed Chromium
cd web
node e2e/hackathon.mjs
```

The script uses real data and saves screenshots, measured load times, accessibility
findings, and an HTML report. A passing build alone does not verify archive requests.
