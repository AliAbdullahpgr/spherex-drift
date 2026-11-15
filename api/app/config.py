"""Central configuration. Everything release-specific lives here.

To pick up a new SPHEREx data release, add its IRSA SIA collection name to
COLLECTIONS (or set SPHEREX_COLLECTIONS="spherex_dr1,spherex_qr3,spherex_dr2").
Nothing else in the code mentions a release name.
"""
import os
import tempfile
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent

# --- data release -----------------------------------------------------------
# IRSA SIA collection names (verified: "spherex_dr1" and "spherex_qr3";
# "spherex_qr" does not exist). Later duplicates of an exposure win.
COLLECTIONS = [c.strip() for c in os.environ.get(
    "SPHEREX_COLLECTIONS", "spherex_dr1,spherex_qr3").split(",") if c.strip()]

# Public S3 mirror of the archive. Keys come from the SIA `cloud_access`
# column, so no release-specific path logic is needed.
S3_HTTP_BASE = "https://nasa-irsa-spherex.s3.amazonaws.com"
USE_S3 = os.environ.get("SPHEREX_USE_S3", "1") != "0"  # False -> IRSA cutout service only

# --- cache ------------------------------------------------------------------
# Deployed source is read-only on Vercel; only temporary storage is writable.
_DEFAULT_CACHE_DIR = (Path(tempfile.gettempdir()) / "spherex-drift-cache"
                      if os.environ.get("VERCEL") else API_ROOT / "cache")
CACHE_DIR = Path(os.environ.get("SPHEREX_CACHE_DIR", _DEFAULT_CACHE_DIR))
SIA_TTL_S = 12 * 3600          # how long a cached SIA result is trusted

# --- concurrency ------------------------------------------------------------
MAX_FRAME_WORKERS = int(os.environ.get("SPHEREX_FRAME_WORKERS", "24"))   # frames processed at once
MAX_HTTP_CONNECTIONS = int(os.environ.get("SPHEREX_HTTP_CONNECTIONS", "48"))

# --- science ----------------------------------------------------------------
PASS_GAP_DAYS = 45.0           # observations of one position further apart than this start a new pass
PROBE_HALF_ARCSEC = 90.0       # native cutout half-width used by /frames and /spectrum
DEFAULT_FOV_ARCMIN = 5.0
MAX_FOV_ARCMIN = 30.0
DEFAULT_SIZE = 256
MAX_SIZE = 1024
SIA_RADIUS_ARCMIN = 1.0        # SIA cone radius; footprint test is done locally

CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "SPHEREX_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]

# --- targets (ICRS, epoch ~2026.0 for movers so the star is where SPHEREx saw it) ---
# Barnard / eps Indi B / RW Aur / R Dra: Gaia DR3 (epoch 2016.0) propagated
# to 2026.0 with Gaia proper motions. WISE 0855: coordinates from CHALLENGE.md.
# pm_mas_yr = [pm_ra*cos(dec), pm_dec] in mas/yr and epoch = the year the ra/dec above refer to; the
# frontend uses them to mark where a known mover should be in each image. Sources: Barnard's Star
# Gaia DR3; eps Indi B from SIMBAD (pm 3981.98, -2466.83 mas/yr); WISE 0855 Luhman & Esplin
# 2016. The WISE 0855 ra/dec are the challenge's coordinates, which match its position in the first
# WISE epoch (2010.4) - by 2026 it sits ~2 arcmin west of them.
TARGETS = [
    {"id": "barnard", "name": "Barnard's Star", "ra": 269.446268, "dec": 4.768204, "kind": "mover",
     "pm_mas_yr": [-801.6, 10362.4], "epoch": 2026.0,
     "note": "nearest single star; proper motion 10.4 arcsec/yr (position for epoch 2026.0)"},
    {"id": "epsindib", "name": "Epsilon Indi B", "ra": 331.096653, "dec": -56.800663, "kind": "mover",
     "pm_mas_yr": [3982.0, -2466.8], "epoch": 2026.0,
     "note": "brown dwarf pair orbiting eps Indi A, ~6.7 arcmin from the bright star (epoch 2026.0)"},
    {"id": "wise0855", "name": "WISE 0855", "ra": 133.795129, "dec": -7.245147, "kind": "mover",
     "pm_mas_yr": [-8118.0, 680.0], "epoch": 2010.4,
     "note": "fast-moving brown dwarf, ~8 arcsec/yr (position for 2010; it has moved ~2 arcmin west since)"},
    {"id": "rwaur", "name": "RW Aurigae", "ra": 76.956560, "dec": 30.401248, "kind": "variable",
     "note": "variable T Tauri star (epoch 2026.0)"},
    {"id": "rdra", "name": "R Draconis", "ra": 248.167233, "dec": 66.755024, "kind": "variable",
     "note": "Mira-type variable star (epoch 2026.0)"},
]
