# SPHEREx Drift

Entry for the NASA Space Apps Challenge 2026, challenge **"Planet X and SPHEREx"**.

A public web tool: enter a sky position and watch SPHEREx infrared images of that patch play over time, so objects that move or change stand out.

**Status: planning complete, no application code yet.** See:

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
