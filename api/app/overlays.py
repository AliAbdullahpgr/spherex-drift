"""Catalogue overlays and context for SPHEREx Drift: Gaia stars, known solar-system objects,
an optical/infrared context picture, and look-up links.

Services (probed live 2026-11-14 from this machine):
  * Gaia DR3: ESA Gaia archive TAP sync (gea.esac.esa.int) answers a cone query in ~2 s and is the
    primary when it is up, but it stopped answering later the same day. Fallbacks in order: the VizieR
    mirror at Harvard CfA (I/355/gaiadr3, ~1.5 s, reliable all day), IRSA's copy (gaia_dr3_source; timed
    out or 502 on the day) and VizieR TAP at CDS (down on the day).
  * Known objects: IMCCE SkyBoT cone search. The production endpoint is
    https://ssp.imcce.fr/webservices/skybot/api/conesearch.php (the old vo.imcce.fr host answers 403).
    Observer = geocentre (500). SkyBoT only takes IAU observatory codes and SPHEREx has none; from low
    Earth orbit the parallax against the geocentre is about 6 arcsec for an asteroid 1.5 au away (one
    SPHEREx pixel) and grows for nearer objects.
  * Context picture, first with coverage wins: Legacy Surveys DR10 (g r i z), Pan-STARRS1 (g r i),
    DSS2 colour via CDS hips2fits, then unWISE (infrared, whole sky) so there is always something.

Endpoints: GET /gaia, /known, /context, /context/info, /links. Every upstream answer is cached on disk
under cache/overlays/. A service being down gives 200 with an empty list and a `note`, never a 500.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote, urlencode

import httpx
import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from PIL import Image

from . import config

CACHE_DIR = Path(os.environ.get("OVERLAY_CACHE_DIR", config.CACHE_DIR / "overlays"))
UA = "spherex-drift-overlays/0.1 (python-httpx)"

ESA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
VIZIER_TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
VIZIER_CFA = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"   # VizieR mirror at Harvard CfA
SKYBOT_URL = os.environ.get("SKYBOT_URL", "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php")
LEGACY_CUTOUT = "https://www.legacysurvey.org/viewer/cutout.jpg"
PS1_FILENAMES = "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py"
PS1_FITSCUT = "https://ps1images.stsci.edu/cgi-bin/fitscut.cgi"
HIPS2FITS = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"

GAIA_MAX = 300            # brightest stars returned
GAIA_FAST_MAX = 60        # plus every fast mover, however faint
GAIA_FAST_PM = 150.0      # mas/yr
GAIA_MARGIN_ARCMIN = 1.0  # so a star that has moved into the field since 2016 is still found
GAIA_FAST_MARGIN_ARCMIN = 3.0
KNOWN_MAX_TIMES = 48
KNOWN_MARGIN_ARCMIN = 2.0  # asteroids drift ~0.5 arcmin/hour; lets the browser extrapolate a little
SKYBOT_CONCURRENCY = 2
DOWN_TTL_S = 90.0        # a service that just failed is skipped for this long

router = APIRouter()

_sems: dict = {}
_locks: dict = {}
_down: dict = {}


def _sem(name: str, n: int) -> asyncio.Semaphore:
    key = (id(asyncio.get_running_loop()), name)
    if key not in _sems:
        _sems[key] = asyncio.Semaphore(n)
    return _sems[key]


def _lock(key: str) -> asyncio.Lock:
    k = (id(asyncio.get_running_loop()), key)
    if k not in _locks:
        _locks[k] = asyncio.Lock()
    return _locks[k]


# ----------------------------------------------------------------------------- cache
def _h(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:20]


def _cpath(kind: str, key: str, ext: str) -> Path:
    d = CACHE_DIR / kind
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{key}.{ext}"


def _read_json(kind: str, key: str):
    try:
        return json.loads(_cpath(kind, key, "json").read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _write_bytes(p: Path, data: bytes):
    tmp = p.with_name(p.name + f".tmp{os.getpid()}_{time.monotonic_ns()}")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def _write_json(kind: str, key: str, obj):
    _write_bytes(_cpath(kind, key, "json"), json.dumps(obj).encode())


# ----------------------------------------------------------------------------- http
async def _request(method: str, url: str, *, params=None, data=None, timeout=30.0, tries=2,
                   sem="overlay", n=6, ok=(200,)) -> httpx.Response:
    """GET/POST with retries on network errors and 5xx. Raises on the last failure."""
    last: Exception | None = None
    for i in range(tries):
        try:
            async with _sem(sem, n):
                async with httpx.AsyncClient(follow_redirects=True, headers={"User-Agent": UA}) as c:
                    r = await c.request(method, url, params=params, data=data, timeout=timeout)
            if r.status_code in ok:
                return r
            last = RuntimeError(f"HTTP {r.status_code} from {httpx.URL(url).host}")
            if r.status_code < 500 and r.status_code != 429:
                break
        except (httpx.HTTPError, OSError) as e:
            last = RuntimeError(f"{type(e).__name__} from {httpx.URL(url).host}")
        if i + 1 < tries:
            await asyncio.sleep(0.8 * (i + 1))
    raise last or RuntimeError("request failed")


def _is_down(name: str) -> bool:
    return time.monotonic() - _down.get(name, -1e9) < DOWN_TTL_S


def _mark_down(name: str):
    _down[name] = time.monotonic()


# ----------------------------------------------------------------------------- validation
def _check(ra: float, dec: float, fov: Optional[float] = None):
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise HTTPException(400, "ra must be in [0,360), dec in [-90,90]")
    if fov is not None and not (0 < fov <= config.MAX_FOV_ARCMIN):
        raise HTTPException(400, f"fov must be in (0, {config.MAX_FOV_ARCMIN}] arcmin")


def _half_diag_arcmin(fov: float) -> float:
    return fov * math.sqrt(2) / 2


def _fnum(v) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


# ============================================================================= Gaia
_GAIA_COLS = ["source_id", "ra", "dec", "pmra", "pmdec", "gmag", "ref_epoch"]


def gaia_adql(service: str, ra: float, dec: float, radius_deg: float, top: int, min_pm: Optional[float] = None) -> str:
    """ADQL for one service; every service returns the same column names."""
    if service == "vizier":
        sel = ("Source AS source_id, RA_ICRS AS ra, DE_ICRS AS dec, pmRA AS pmra, pmDE AS pmdec, "
               "Gmag AS gmag, 2016.0 AS ref_epoch")
        table, cra, cdec, pm, mag = '"I/355/gaiadr3"', "RA_ICRS", "DE_ICRS", "PM", "Gmag"
    else:
        sel = "source_id, ra, dec, pmra, pmdec, phot_g_mean_mag AS gmag, ref_epoch"
        table = "gaiadr3.gaia_source" if service == "esa" else "gaia_dr3_source"
        cra, cdec, pm, mag = "ra", "dec", "pm", "phot_g_mean_mag"
    q = (f"SELECT TOP {int(top)} {sel} FROM {table} WHERE 1=CONTAINS(POINT('ICRS',{cra},{cdec}),"
         f"CIRCLE('ICRS',{ra:.7f},{dec:.7f},{radius_deg:.6f}))")
    if min_pm is not None:
        q += f" AND {pm} > {min_pm:g}"
    return q + f" ORDER BY {mag} ASC"


def parse_gaia_csv(text: str) -> list[dict]:
    """TAP CSV -> list of sources. source_id stays a string (it does not fit a JavaScript number)."""
    rows = list(csv.reader(io.StringIO(text.strip())))
    if not rows:
        return []
    head = [h.strip().strip('"').lower() for h in rows[0]]
    if "source_id" not in head or "ra" not in head or "dec" not in head:
        raise ValueError("unexpected Gaia table columns: " + ",".join(head)[:120])
    ix = {c: head.index(c) for c in _GAIA_COLS if c in head}
    out = []
    for r in rows[1:]:
        if len(r) < len(head):
            continue
        g = lambda c: r[ix[c]].strip() if c in ix else ""  # noqa: E731
        ra, dec = _fnum(g("ra")), _fnum(g("dec"))
        if ra is None or dec is None:
            continue
        out.append({"source_id": g("source_id").strip('"'), "ra": ra, "dec": dec,
                    "pmra": _fnum(g("pmra")), "pmdec": _fnum(g("pmdec")), "gmag": _fnum(g("gmag")),
                    "ref_epoch": _fnum(g("ref_epoch")) or 2016.0})
    return out


def merge_gaia(bright: list[dict], fast: list[dict], cap: int = GAIA_MAX) -> list[dict]:
    """Brightest `cap` stars plus any fast movers not among them, brightest first, no duplicates."""
    seen, out = set(), []
    for s in bright[:cap] + fast:
        if s["source_id"] in seen:
            continue
        seen.add(s["source_id"])
        out.append(s)
    out.sort(key=lambda s: 99.0 if s["gmag"] is None else s["gmag"])
    return out


def parse_vizier_tsv(text: str) -> list[dict]:
    """VizieR asu-tsv answer (comment lines, header, units, dashes, rows) -> list of sources."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines:
        return []
    head = [h.strip() for h in lines[0].split("\t")]
    if "Source" not in head or "RA_ICRS" not in head:
        raise ValueError("unexpected VizieR columns: " + ",".join(head)[:120])
    out = []
    for ln in lines[1:]:
        p = [x.strip() for x in ln.split("\t")]
        if len(p) != len(head) or not p[0].isdigit():
            continue
        r = dict(zip(head, p))
        ra, dec = _fnum(r["RA_ICRS"]), _fnum(r["DE_ICRS"])
        if ra is None or dec is None:
            continue
        out.append({"source_id": r["Source"], "ra": ra, "dec": dec, "pmra": _fnum(r.get("pmRA")),
                    "pmdec": _fnum(r.get("pmDE")), "gmag": _fnum(r.get("Gmag")), "ref_epoch": 2016.0})
    return out


def vizier_params(ra: float, dec: float, radius_arcmin: float, top: int, min_pm: Optional[float] = None) -> dict:
    p = {"-source": "I/355/gaiadr3", "-c": f"{ra:.7f} {dec:+.7f}", "-c.rm": f"{radius_arcmin:.4f}",
         "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag", "-sort": "Gmag", "-out.max": str(int(top))}
    if min_pm is not None:
        p["PM"] = f">{min_pm:g}"
    return p


_GAIA_SERVICES = [  # name, url, extra form fields, timeout
    ("esa", ESA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv"}, 15.0),
    ("cfa", VIZIER_CFA, None, 25.0),
    ("irsa", IRSA_TAP, {"FORMAT": "CSV"}, 40.0),
    ("vizier", VIZIER_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv"}, 20.0),
]
_GAIA_LABEL = {"esa": "ESA Gaia archive", "cfa": "VizieR I/355/gaiadr3 (CfA mirror)",
               "irsa": "IRSA copy of Gaia DR3", "vizier": "VizieR I/355/gaiadr3"}


async def _gaia_from(service, url, form, timeout, ra, dec, fov) -> list[dict]:
    r_bright = (_half_diag_arcmin(fov) + GAIA_MARGIN_ARCMIN) / 60.0
    r_fast = (_half_diag_arcmin(fov) + GAIA_FAST_MARGIN_ARCMIN) / 60.0

    if service == "cfa":
        async def viz(radius_deg, top, min_pm=None):
            r = await _request("GET", url, params=vizier_params(ra, dec, radius_deg * 60.0, top, min_pm),
                               timeout=timeout, tries=1, sem="tap", n=4)
            return parse_vizier_tsv(r.text)
        bright, fast = await asyncio.gather(viz(r_bright, GAIA_MAX), viz(r_fast, GAIA_FAST_MAX, GAIA_FAST_PM))
        return merge_gaia(bright, fast)

    async def run(adql):
        r = await _request("POST", url, data={**form, "QUERY": adql}, timeout=timeout, tries=1, sem="tap", n=4)
        return parse_gaia_csv(r.text)

    bright, fast = await asyncio.gather(
        run(gaia_adql(service, ra, dec, r_bright, GAIA_MAX)),
        run(gaia_adql(service, ra, dec, r_fast, GAIA_FAST_MAX, GAIA_FAST_PM)))
    return merge_gaia(bright, fast)


@router.get("/gaia")
async def gaia(ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN):
    """Gaia DR3 stars in the field (positions at `ref_epoch`, proper motions in mas/yr)."""
    _check(ra, dec, fov)
    key = _h("gaia", f"{ra:.5f}", f"{dec:.5f}", f"{fov:.3f}")
    base = {"ra": ra, "dec": dec, "fov": fov}
    async with _lock("gaia" + key):
        hit = _read_json("gaia", key)
        if hit is not None:
            return {**base, **hit, "cached": True}
        errors = []
        if all(_is_down(n) for n, *_ in _GAIA_SERVICES):  # nothing left to try: start over
            for n, *_ in _GAIA_SERVICES:
                _down.pop(n, None)
        for name, url, form, timeout in _GAIA_SERVICES:
            if _is_down(name):
                errors.append(f"{name}: skipped (failed recently)")
                continue
            try:
                src = await _gaia_from(name, url, form, timeout, ra, dec, fov)
            except Exception as e:  # noqa: BLE001 - try the next service
                _mark_down(name)
                errors.append(f"{name}: {e}"[:160])
                continue
            res = {"sources": src, "n": len(src), "service": _GAIA_LABEL[name], "catalogue": "Gaia DR3"}
            _write_json("gaia", key, res)
            return {**base, **res, "cached": False}
    return {**base, "sources": [], "n": 0, "service": None, "catalogue": "Gaia DR3",
            "note": "No Gaia service answered (" + "; ".join(errors) + "). Try again in a few minutes."}


# ============================================================================= SkyBoT
def parse_time(s: str) -> datetime:
    t = s.strip().replace(" ", "T")
    if t.endswith("Z") or t.endswith("z"):
        t = t[:-1] + "+00:00"
    d = datetime.fromisoformat(t)
    d = d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)
    return d


def round_minute(d: datetime) -> datetime:
    d = d.replace(microsecond=0)
    sec = d.second
    d = d.replace(second=0)
    if sec >= 30:
        d = datetime.fromtimestamp(d.timestamp() + 60, tz=timezone.utc)
    return d


def iso_z(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def sexa_to_deg(s: str, hours: bool = False) -> Optional[float]:
    """'08 55 22.1279' (hours) or '-07 14 42.5' (degrees) -> decimal degrees."""
    t = str(s).replace(":", " ").split()
    if not t:
        return None
    try:
        neg = t[0].startswith("-")
        p = [abs(float(x)) for x in t[:3]] + [0.0, 0.0]
        v = p[0] + p[1] / 60 + p[2] / 3600
    except ValueError:
        return None
    v = -v if neg else v
    return v * 15 if hours else v


def parse_skybot(payload, when: str) -> list[dict]:
    """SkyBoT JSON (-mime=json -output=obs) -> our objects. Tolerates the short -output=object form."""
    if isinstance(payload, dict):
        payload = payload.get("data") or []
    out = []
    for o in payload or []:
        if not isinstance(o, dict):
            continue
        ra = sexa_to_deg(o.get("RA (hms)", ""), hours=True)
        dec = sexa_to_deg(o.get("DEC (dms)", ""))
        if ra is None or dec is None:
            continue
        dra, ddec = _fnum(o.get("dRA (arcsec/h)")), _fnum(o.get("dDEC (arcsec/h)"))
        num = o.get("Num")
        try:
            num = int(num) if num not in (None, "", "-") else None
        except (TypeError, ValueError):
            num = None
        out.append({
            "time": when, "name": str(o.get("Name", "")).strip(), "number": num, "ra": round(ra, 6),
            "dec": round(dec, 6), "vmag": _fnum(o.get("VMag (mag)")), "class": o.get("Class"),
            "motion_arcsec_hr": None if dra is None or ddec is None else round(math.hypot(dra, ddec), 3),
            # components on the sky (east and north), so the browser can move the marker between times
            "dra_arcsec_hr": dra, "ddec_arcsec_hr": ddec,
            "err_arcsec": _fnum(o.get("Err (arcsec)")), "dist_au": _fnum(o.get("dg (ua)")),
        })
    out.sort(key=lambda x: 99.0 if x["vmag"] is None else x["vmag"])
    return out


async def _skybot_one(ra: float, dec: float, fov: float, d: datetime) -> tuple[list[dict], Optional[str]]:
    when = iso_z(d)
    key = _h("skybot", f"{ra:.4f}", f"{dec:.4f}", f"{fov:.3f}", when)
    async with _lock("sb" + key):
        hit = _read_json("skybot", key)
        if hit is not None:
            return hit["objects"], None
        if _is_down("skybot"):
            return [], "SkyBoT did not answer a moment ago; not asked again yet"
        params = {"-ep": d.strftime("%Y-%m-%dT%H:%M:%S"), "-ra": f"{ra:.6f}", "-dec": f"{dec:.6f}",
                  "-rd": f"{(_half_diag_arcmin(fov) + KNOWN_MARGIN_ARCMIN) / 60.0:.5f}", "-mime": "json",
                  "-output": "obs", "-loc": "500", "-filter": "120", "-objFilter": "111",
                  "-from": "SPHERExDrift"}
        try:
            r = await _request("GET", SKYBOT_URL, params=params, timeout=45.0, tries=2,
                               sem="skybot", n=SKYBOT_CONCURRENCY, ok=(200, 204))
            objs = [] if r.status_code == 204 or not r.content.strip() else parse_skybot(r.json(), when)
        except Exception as e:  # noqa: BLE001
            _mark_down("skybot")
            return [], f"SkyBoT: {e}"[:160]
        _write_json("skybot", key, {"objects": objs})
        return objs, None


def collect_times(time_: Optional[List[str]], times: Optional[str]) -> list[datetime]:
    raw = list(time_ or []) + [t for t in (times or "").split(",") if t.strip()]
    out, seen = [], set()
    for s in raw:
        try:
            d = round_minute(parse_time(s))
        except ValueError:
            raise HTTPException(400, f"time '{s[:40]}' is not an ISO date-time") from None
        if d not in seen:
            seen.add(d)
            out.append(d)
    return sorted(out)


@router.get("/known")
async def known(ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN,
                time_: Optional[List[str]] = Query(None, alias="time"), times: Optional[str] = None):
    """Known asteroids, comets and planets in the field at each requested time (IMCCE SkyBoT)."""
    _check(ra, dec, fov)
    ds = collect_times(time_, times)
    if not ds:
        raise HTTPException(400, "give at least one time=<ISO date-time> (or times=a,b,c)")
    if len(ds) > KNOWN_MAX_TIMES:
        raise HTTPException(400, f"at most {KNOWN_MAX_TIMES} times per request")
    res = await asyncio.gather(*[_skybot_one(ra, dec, fov, d) for d in ds])
    objects = [o for objs, _ in res for o in objs]
    notes = sorted({n for _, n in res if n})
    out = {"ra": ra, "dec": dec, "fov": fov, "times": [iso_z(d) for d in ds], "objects": objects,
           "n": len(objects), "observer": "geocentre (500)", "service": "IMCCE SkyBoT"}
    if notes:
        out["note"] = "Known-object lookup incomplete: " + "; ".join(notes)
    return out


# ============================================================================= context picture
SURVEYS = {
    "ls-dr10": {"label": "Legacy Surveys DR10", "kind": "visible",
                "about": "Ground telescopes, visible and near-infrared light (g, r, i, z filters)."},
    "ps1": {"label": "Pan-STARRS1", "kind": "visible",
            "about": "Ground telescope in Hawaii, visible light (g, r, i filters)."},
    "dss2": {"label": "Digitized Sky Survey 2", "kind": "visible",
             "about": "Photographic plates from the 1980s and 1990s, visible light."},
    "unwise": {"label": "unWISE (WISE W1 and W2)", "kind": "infrared",
               "about": "WISE space telescope, infrared light at 3.4 and 4.6 micrometres."},
}
CONTEXT_ORDER = ["ls-dr10", "ps1", "dss2", "unwise"]


def blank_fraction(jpeg: bytes) -> float:
    """Share of the picture that is one flat colour (how surveys paint 'no data'). 1.0 if unreadable."""
    try:
        a = np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB"), dtype=np.int16)
    except Exception:  # noqa: BLE001
        return 1.0
    flat = (a.max(axis=2) - a.min(axis=2)) <= 2
    lum = a[..., 1]
    vals, counts = np.unique(lum[flat], return_counts=True)
    if not len(vals):
        return 0.0
    mode = int(vals[np.argmax(counts)])
    return float((flat & (np.abs(lum - mode) <= 1)).mean())


def has_coverage(jpeg: bytes) -> bool:
    return blank_fraction(jpeg) < 0.5


def legacy_url(layer: str, ra: float, dec: float, fov: float, size: int) -> str:
    return LEGACY_CUTOUT + "?" + urlencode({"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "layer": layer,
                                            "pixscale": f"{fov * 60.0 / size:.5f}", "size": size})


def ps1_url(files: dict, ra: float, dec: float, fov: float, size: int) -> str:
    """fitscut colour cutout: i -> red, r -> green, g -> blue. PS1 pixels are 0.25 arcsec."""
    return PS1_FITSCUT + "?" + urlencode({
        "red": files["i"], "green": files["r"], "blue": files["g"], "ra": f"{ra:.6f}", "dec": f"{dec:.6f}",
        "size": int(round(fov * 60.0 / 0.25)), "output_size": size, "format": "jpg", "autoscale": "99.5"})


def parse_ps1_filenames(text: str) -> dict:
    out = {}
    lines = text.strip().splitlines()
    if len(lines) < 2:
        return out
    head = lines[0].split()
    for ln in lines[1:]:
        p = ln.split()
        if len(p) == len(head):
            row = dict(zip(head, p))
            out[row["filter"]] = row["filename"]
    return out


def hips_url(ra: float, dec: float, fov: float, size: int) -> str:
    return HIPS2FITS + "?" + urlencode({"hips": "CDS/P/DSS2/color", "width": size, "height": size,
                                        "fov": f"{fov / 60.0:.6f}", "projection": "TAN", "coordsys": "icrs",
                                        "ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "format": "jpg"})


async def _fetch_context(source: str, ra: float, dec: float, fov: float, size: int) -> Optional[bytes]:
    """JPEG bytes from one survey, or None when it has no data here. Raises when the service is down."""
    if source in ("ls-dr10", "unwise"):
        layer = "ls-dr10" if source == "ls-dr10" else "unwise-neo7"
        r = await _request("GET", legacy_url(layer, ra, dec, fov, size), timeout=40.0)
        return r.content if has_coverage(r.content) else None
    if source == "ps1":
        if dec < -30.5:
            return None
        r = await _request("GET", PS1_FILENAMES, params={"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "filters": "gri"},
                           timeout=25.0)
        files = parse_ps1_filenames(r.text)
        if not all(b in files for b in "gri"):
            return None
        r = await _request("GET", ps1_url(files, ra, dec, fov, size), timeout=60.0)
        return r.content if has_coverage(r.content) else None
    if source == "dss2":
        r = await _request("GET", hips_url(ra, dec, fov, size), timeout=40.0)
        return r.content if has_coverage(r.content) else None
    raise ValueError(source)


async def _context(ra: float, dec: float, fov: float, size: int):
    """-> (jpeg bytes | None, meta). Cached; only a definite answer (every survey replied) caches a miss."""
    key = _h("ctx", f"{ra:.5f}", f"{dec:.5f}", f"{fov:.3f}", size)
    img_p = _cpath("context", key, "jpg")
    async with _lock("ctx" + key):
        meta = _read_json("context", key)
        if meta is not None:
            if meta.get("source") is None:
                return None, meta
            try:
                return img_p.read_bytes(), meta
            except OSError:
                pass
        errors = []
        for source in CONTEXT_ORDER:
            host = "legacysurvey" if source in ("ls-dr10", "unwise") else source
            if _is_down(host):
                errors.append(f"{source}: skipped (failed recently)")
                continue
            try:
                data = await _fetch_context(source, ra, dec, fov, size)
            except Exception as e:  # noqa: BLE001
                _mark_down(host)
                errors.append(f"{source}: {e}"[:140])
                continue
            if data is None:
                continue
            meta = {"source": source, **SURVEYS[source], "size": size}
            if errors:  # a preferred survey was unreachable: serve this one but look again later
                return data, {**meta, "note": "; ".join(errors)}
            _write_bytes(img_p, data)
            _write_json("context", key, meta)
            return data, meta
        meta = {"source": None, "size": size}
        if errors:
            return None, {**meta, "note": "Picture services not answering: " + "; ".join(errors)}
        _write_json("context", key, meta)
        return None, meta


def _ctx_size(size: int) -> int:
    if not (64 <= size <= 1024):
        raise HTTPException(400, "size must be in [64, 1024]")
    return size


@router.get("/context")
async def context(ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN, size: int = 512):
    """Colour picture of the same field from another survey (JPEG, north up, east left)."""
    _check(ra, dec, fov); _ctx_size(size)
    data, meta = await _context(ra, dec, fov, size)
    if data is None:
        raise HTTPException(404, meta.get("note") or "no survey has a picture of this spot")
    return Response(data, media_type="image/jpeg", headers={
        "X-Context-Source": meta["source"], "X-Context-Label": meta["label"], "X-Context-Kind": meta["kind"],
        "Cache-Control": "public, max-age=86400"})


@router.get("/context/info")
async def context_info(ra: float, dec: float, fov: float = config.DEFAULT_FOV_ARCMIN, size: int = 512):
    """Which survey /context will show for this field (a browser <img> cannot read response headers)."""
    _check(ra, dec, fov); _ctx_size(size)
    data, meta = await _context(ra, dec, fov, size)
    q = urlencode({"ra": ra, "dec": dec, "fov": fov, "size": size})
    return {"available": data is not None, "source": meta.get("source"), "label": meta.get("label"),
            "kind": meta.get("kind"), "about": meta.get("about"), "note": meta.get("note"),
            "image_url": f"/context?{q}" if data is not None else None}


# ============================================================================= links
def build_links(ra: float, dec: float) -> list[dict]:
    c = f"{ra:.6f} {dec:+.6f}"
    cq = quote(c)
    return [
        {"id": "simbad", "label": "SIMBAD", "about": "Named objects within 2 arcmin",
         "url": f"https://simbad.cds.unistra.fr/simbad/sim-coo?Coord={cq}&CooFrame=ICRS&Radius=2&Radius.unit=arcmin"},
        {"id": "vizier", "label": "VizieR", "about": "Every published catalogue, within 30 arcsec",
         "url": f"https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-c={cq}&-c.rs=30"},
        {"id": "legacy", "label": "Legacy Survey viewer", "about": "Deep visible-light sky map",
         "url": f"https://www.legacysurvey.org/viewer?ra={ra:.6f}&dec={dec:.6f}&layer=ls-dr10&zoom=14&mark={ra:.6f},{dec:.6f}"},
        {"id": "wiseview", "label": "WiseView", "about": "WISE infrared images since 2010 as a blink movie",
         "url": f"https://byw.tools/wiseview#ra={ra:.6f}&dec={dec:.6f}&size=176&band=2"},
        {"id": "finderchart", "label": "IRSA finder chart", "about": "The same spot in DSS, SDSS, 2MASS and WISE",
         "url": "https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api?mode=getResult&locstr="
                f"{ra:.6f}+{quote(f'{dec:+.6f}')}&subsetsize=5.0"},
    ]


@router.get("/links")
def links(ra: float, dec: float):
    _check(ra, dec)
    return {"ra": ra, "dec": dec, "links": build_links(ra, dec)}
