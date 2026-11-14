"""Acceptance test for the WISE epochs module.

For Barnard's Star (W1) and WISE 0855 (W2): fetch the first and last epoch, measure the centroid shift
between them and compare with the known proper motion x time baseline.  Also prints epoch availability
for the five required targets and cold/warm timings, and saves PNGs to cache/wise/acceptance/.

Run:  .venv/bin/python scripts/wise_acceptance.py [--coverage-only] [--fov 6]
"""
import argparse
import io
import math
import sys
import time
from pathlib import Path

import numpy as np
from astropy.time import Time
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.wise import router  # noqa: E402
from app import wise_grid as G  # noqa: E402

app = FastAPI()
app.include_router(router)
client = TestClient(app)

SIZE = 256
J2000_MJD = 51544.5

# name, band, ra, dec (at epoch ref_year), ref_year, pmra*cosdec ("/yr), pmdec ("/yr)
TARGETS = {
    # Barnard's Star, J2000 position (task spec), Gaia DR3 proper motion
    "barnard": dict(band=1, ra=269.452, dec=4.6934, ref=2000.0, pmra=-0.8028, pmdec=10.3625, sig=4.0, rad=12, tol=4.0),
    # WISE 0855-0714 (Luhman & Esteves 2014 / Kirkpatrick+2019): pm ~ (-8.1, +0.7) "/yr; position ~epoch 2014.2
    "wise0855": dict(band=2, ra=133.795129, dec=-7.245147, ref=2014.2, pmra=-8.10, pmdec=0.70, sig=1.5, rad=5, tol=3.0),
}
FIVE = {  # positions from api/app/config.py (epoch 2026.0 where the object moves)
    "barnard": (269.446268, 4.768204), "epsindib": (331.096653, -56.800663),
    "wise0855": (133.795129, -7.245147), "rwaur": (76.956560, 30.401248), "rdra": (248.167233, 66.755024),
}


def year_of_mjd(m):
    return Time(m, format="mjd").jyear


def pos_at(t, year):
    dt = year - t["ref"]
    return (t["ra"] + t["pmra"] * dt / 3600.0 / math.cos(math.radians(t["dec"])), t["dec"] + t["pmdec"] * dt / 3600.0)


def get_npy(frame, ra, dec, fov):
    url = frame["image_url"].replace("/wise/image/", "/wise/image/")
    base = url.split("?")[0]
    r = client.get(base, params=dict(ra=ra, dec=dec, fov=fov, size=SIZE, format="npy"))
    r.raise_for_status()
    shape = tuple(int(x) for x in r.headers["X-Shape"].split(","))
    return np.frombuffer(r.content, dtype="<f4").reshape(shape).copy()


def _smooth(arr, sig):
    from scipy.ndimage import gaussian_filter
    sm = gaussian_filter(np.nan_to_num(arr, nan=0.0), sig)
    return sm, 1.4826 * np.median(np.abs(sm - np.median(sm)))


def refine(arr, px, py, sig, rad):
    """Sub-pixel centroid: weights = smoothed image above half of the local smoothed peak, within rad px."""
    sm, _ = _smooth(arr, sig)
    yy, xx = np.mgrid[:sm.shape[0], :sm.shape[1]]
    cx, cy = float(px), float(py)
    for _ in range(4):
        m = (xx - cx) ** 2 + (yy - cy) ** 2 <= rad ** 2
        pk = sm[m].max()
        w = np.where(m & (sm > 0.5 * pk), sm, 0.0)
        cx, cy = (xx * w).sum() / w.sum(), (yy * w).sum() / w.sum()
    return cx, cy


def find_mover(a1, a2, shift_px, sig, border=12):
    """Blind mover search that only uses the proper-motion *displacement* (not the absolute position):
    for each local maximum in epoch 1, look for a peak at (position + shift) in epoch 2; best min-S/N wins."""
    from scipy.ndimage import maximum_filter
    s1, n1 = _smooth(a1, sig)
    s2, n2 = _smooth(a2, sig)
    H, W_ = s1.shape
    mx = (s1 == maximum_filter(s1, 7)) & (s1 > 4 * n1)
    best = None
    for j, i in zip(*np.nonzero(mx)):
        j2, i2 = j + shift_px[1], i + shift_px[0]
        if not (border <= i2 < W_ - border and border <= j2 < H - border):
            continue
        jj, ii = int(round(j2)), int(round(i2))
        loc = s2[jj - 2:jj + 3, ii - 2:ii + 3]
        k, l = np.unravel_index(np.argmax(loc), loc.shape)
        sc = min(s1[j, i] / n1, loc.max() / n2)
        if best is None or sc > best[0]:
            best = (sc, (i, j), (ii + l - 2, jj + k - 2), s1[j, i] / n1, loc.max() / n2)
    return best


def px_to_sky(w, x, y):
    # array row 0 = north -> WCS y index (0-based, row 0 = south) is size-1-row
    r, d = w.all_pix2world(x, SIZE - 1 - y, 0)
    return float(r), float(d)


def sky_to_px(w, ra, dec):
    x, yw = w.all_world2pix(ra, dec, 0)
    return float(x), SIZE - 1 - float(yw)


def run_target(name, t, fov, results):
    sm_sig, rad = t["sig"], t["rad"]
    band_um = {1: 3.4, 2: 4.6}[t["band"]]
    print(f"\n=== {name} (band W{t['band']}) ===")
    t0 = time.time()
    r = client.get("/wise/frames", params=dict(ra=t["ra"], dec=t["dec"], fov=fov))
    r.raise_for_status()
    fr0 = [f for f in r.json()["frames"] if abs(f["wavelength_um"] - band_um) < 0.01]
    print(f"frames: {len(fr0)} epochs in W{t['band']} ({time.time()-t0:.1f}s); {fr0[0]['time'][:10]} .. {fr0[-1]['time'][:10]}")
    y1, y2 = year_of_mjd(fr0[0]["mjd"]), year_of_mjd(fr0[-1]["mjd"])
    # centre the field on the mid-baseline predicted position so both epochs fit inside it
    cra, cdec = pos_at(t, (y1 + y2) / 2)
    r = client.get("/wise/frames", params=dict(ra=cra, dec=cdec, fov=fov))
    frames = [f for f in r.json()["frames"] if abs(f["wavelength_um"] - band_um) < 0.01]
    f1, f2 = frames[0], frames[-1]
    y1, y2 = year_of_mjd(f1["mjd"]), year_of_mjd(f2["mjd"])
    w = G.target_wcs(cra, cdec, fov, SIZE)
    arrs = []
    for f in (f1, f2):
        t1 = time.time()
        arrs.append(get_npy(f, cra, cdec, fov))
        print(f"  fetched {f['time'][:10]} npy in {time.time()-t1:.1f}s")
        png = client.get(f["image_url"].split("?")[0], params=dict(ra=cra, dec=cdec, fov=fov, size=SIZE, stretch="asinh"))
        out = ROOT / "cache" / "wise" / "acceptance"
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{name}_{f['time'][:10]}_W{t['band']}.png").write_bytes(png.content)
    # expected displacement in array px (x right, row down) from proper motion alone
    p1x, p1y = sky_to_px(w, *pos_at(t, y1))
    p2x, p2y = sky_to_px(w, *pos_at(t, y2))
    best = find_mover(arrs[0], arrs[1], (p2x - p1x, p2y - p1y), sm_sig)
    if best is None:
        print("  no mover found"); results.append(False); return
    sc, c1, c2, s1, s2 = best
    print(f"  blind mover search (uses PM displacement only): epoch-1 peak S/N {s1:.0f}, epoch-2 peak S/N {s2:.0f}")
    (x1, yy1), (x2, yy2) = [refine(a, *c, sm_sig, rad) for a, c in zip(arrs, (c1, c2))]
    dpx = ((x2 - x1), (yy2 - yy1))
    scale = fov * 60.0 / SIZE  # arcsec per grid pixel; east is left, row 0 is north
    # use WCS for exact tangent-plane offsets
    ra1, de1 = px_to_sky(w, x1, yy1)
    ra2, de2 = px_to_sky(w, x2, yy2)
    dx = (ra2 - ra1) * math.cos(math.radians(cdec)) * 3600
    dy = (de2 - de1) * 3600
    dtyr = y2 - y1
    exp_dx, exp_dy = t["pmra"] * dtyr, t["pmdec"] * dtyr
    m_tot, e_tot = math.hypot(dx, dy), math.hypot(exp_dx, exp_dy)
    print(f"  centroids (px): epoch1 ({x1:.1f},{yy1:.1f})  epoch2 ({x2:.1f},{yy2:.1f})")
    print(f"  baseline {dtyr:.2f} yr")
    print(f"  measured shift: dRA*cosD={dx:+.1f}\"  dDec={dy:+.1f}\"  total {m_tot:.1f}\" ({m_tot/dtyr:.2f} \"/yr)")
    print(f"  expected shift: dRA*cosD={exp_dx:+.1f}\"  dDec={exp_dy:+.1f}\"  total {e_tot:.1f}\" ({e_tot/dtyr:.2f} \"/yr)")
    err = math.hypot(dx - exp_dx, dy - exp_dy)
    ok = err < t["tol"]
    print(f"  difference {err:.1f}\" (limit {t['tol']:.0f}\"; WISE pixel = 2.75\"; {err/dtyr*1000:.0f} mas/yr)  -> {'PASS' if ok else 'FAIL'}")
    results.append(ok)


def coverage(fov):
    print("\n=== epoch availability (fov %.1f') ===" % fov)
    for name, (ra, dec) in FIVE.items():
        t0 = time.time()
        r = client.get("/wise/frames", params=dict(ra=ra, dec=dec, fov=fov))
        r.raise_for_status()
        j = r.json()
        fr = j["frames"]
        per = {b: [f for f in fr if abs(f["wavelength_um"] - b) < 0.01] for b in (3.4, 4.6)}
        span = f"{fr[0]['time'][:10]}..{fr[-1]['time'][:10]}" if fr else "none"
        print(f"{name:9s} W1:{len(per[3.4]):2d} W2:{len(per[4.6]):2d} passes:{len(j['passes']):2d} {span} ({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fov", type=float, default=6.0)
    ap.add_argument("--coverage-only", action="store_true")
    a = ap.parse_args()
    results = []
    if not a.coverage_only:
        for n, t in TARGETS.items():
            run_target(n, t, a.fov, results)
    coverage(5.0)
    sys.exit(0 if all(results) else 1)
