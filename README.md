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
