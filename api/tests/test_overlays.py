"""Tests for app/overlays.py. Offline by default; live checks need SPHEREX_LIVE=1.

Measured from this machine, 2026-11-14/15 (cold = first request, warm = from disk cache):
  /gaia     cold 1.6-2.4 s (ESA or CfA VizieR mirror; +15 s when ESA has to time out first), warm < 10 ms
  /known    cold 5-9 s per time (SkyBoT, 2 at once), warm < 10 ms
  /context  cold 2.3-3.5 s (Legacy Surveys, Pan-STARRS or unWISE), warm < 5 ms
  /links    < 5 ms (no network)
"""
import io
import os
from datetime import timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import overlays as ov
from app.main import app

client = TestClient(app)
live = pytest.mark.skipif(os.environ.get("SPHEREX_LIVE") != "1", reason="set SPHEREX_LIVE=1 for network tests")

GAIA_CSV = """source_id,ra,dec,pmra,pmdec,gmag,ref_epoch
4472832130942575872,269.44850252543836,4.739420051112412,-801.5509783684709,10362.394206546573,8.1939745,2016.0
4472836292758713216,269.443871611535,4.796291416021129,,,11.862574,2016.0
"""
VIZ_TSV = """#
#Column\tSource\t(I19)
Source\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE\tGmag
 \tdeg\tdeg\tmas/yr\tmas/yr\tmag
-------------------\t---------------\t---------------\t---------\t---------\t---------
5756955785394371328\t133.79701301043\t-07.25786230116\t   -2.083\t  -17.433\t13.298080
5756955166919081600\t133.78930616068\t-07.28988297662\t         \t         \t14.058134
"""
SKYBOT = [{"Num": 1, "Name": "Ceres", "RA (hms)": "00 45 17.6414", "DEC (dms)": "-04 09 33.286",
           "Class": "MB>Middle", "VMag (mag)": 8.9, "Err (arcsec)": 0.008, "d (arcsec)": 0.1,
           "dRA (arcsec/h)": 29.8116, "dDEC (arcsec/h)": 22.9165, "dg (ua)": 2.893},
          {"Name": "2014 PJ76", "RA (hms)": "08 55 22.1279", "DEC (dms)": "+17 00 8.875", "Class": "MB>Outer",
           "VMag (mag)": 22.1, "Err (arcsec)": 0, "dRA (arcsec/h)": -26.4625, "dDEC (arcsec/h)": 9.6949}]


def test_parse_gaia_csv():
    s = ov.parse_gaia_csv(GAIA_CSV)
    assert len(s) == 2
    assert s[0]["source_id"] == "4472832130942575872"  # string: too big for a JS number
    assert s[0]["pmdec"] == pytest.approx(10362.39, abs=0.01)
    assert s[1]["pmra"] is None and s[1]["pmdec"] is None
    assert ov.parse_gaia_csv("") == []
    with pytest.raises(ValueError):
        ov.parse_gaia_csv("<html>error</html>")


def test_parse_vizier_tsv():
    s = ov.parse_vizier_tsv(VIZ_TSV)
    assert [x["source_id"] for x in s] == ["5756955785394371328", "5756955166919081600"]
    assert s[0]["dec"] == pytest.approx(-7.2578623) and s[0]["pmdec"] == pytest.approx(-17.433)
    assert s[1]["pmra"] is None and s[1]["ref_epoch"] == 2016.0


def test_gaia_adql_and_merge():
    q = ov.gaia_adql("esa", 10, -5, 0.1, 300)
    assert "gaiadr3.gaia_source" in q and "TOP 300" in q and "ORDER BY phot_g_mean_mag" in q
    assert "gaia_dr3_source" in ov.gaia_adql("irsa", 10, -5, 0.1, 300)
    assert "pm > 150" in ov.gaia_adql("esa", 10, -5, 0.1, 60, 150.0)
    assert "PM > 150" in ov.gaia_adql("vizier", 10, -5, 0.1, 60, 150.0)
    b = [{"source_id": "a", "gmag": 5.0}, {"source_id": "b", "gmag": 9.0}]
    f = [{"source_id": "b", "gmag": 9.0}, {"source_id": "c", "gmag": 7.0}]
    assert [x["source_id"] for x in ov.merge_gaia(b, f)] == ["a", "c", "b"]


def test_times():
    d = ov.parse_time("2026-01-10T01:00:40Z")
    assert d.tzinfo == timezone.utc
    assert ov.iso_z(ov.round_minute(d)) == "2026-01-10T01:01:00Z"
    assert ov.iso_z(ov.round_minute(ov.parse_time("2026-01-10 03:00:10+02:00"))) == "2026-01-10T01:00:00Z"
    ds = ov.collect_times(["2026-01-10T01:00:10Z", "2026-01-10T01:00:20Z"], "2025-06-01T00:00:00Z, ")
    assert [ov.iso_z(x) for x in ds] == ["2025-06-01T00:00:00Z", "2026-01-10T01:00:00Z"]


def test_parse_skybot():
    assert ov.sexa_to_deg("08 55 22.1279", hours=True) == pytest.approx(133.842200, abs=1e-5)
    assert ov.sexa_to_deg("-00 30 00") == pytest.approx(-0.5)
    o = ov.parse_skybot(SKYBOT, "2026-01-10T00:00:00Z")
    assert o[0]["name"] == "Ceres" and o[0]["number"] == 1
    assert o[0]["ra"] == pytest.approx(11.32351, abs=1e-4) and o[0]["dec"] == pytest.approx(-4.15925, abs=1e-4)
    assert o[0]["motion_arcsec_hr"] == pytest.approx(37.60, abs=0.01)
    assert o[1]["number"] is None and o[1]["time"] == "2026-01-10T00:00:00Z"
    assert ov.parse_skybot([], "x") == []


def _jpeg(arr):
    b = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(b, "JPEG", quality=90)
    return b.getvalue()


def test_coverage_detection():
    blank = np.full((64, 64, 3), 32)
    assert not ov.has_coverage(_jpeg(blank))
    rng = np.random.default_rng(1)
    sky = rng.integers(0, 255, (64, 64, 3))
    assert ov.has_coverage(_jpeg(sky))
    half = sky.copy(); half[:40] = 32
    assert not ov.has_coverage(_jpeg(half))
    assert not ov.has_coverage(b"not an image")


def test_urls_and_ps1_parse():
    u = ov.legacy_url("ls-dr10", 133.795129, -7.245147, 5, 512)
    assert "pixscale=0.58594" in u and "size=512" in u and "layer=ls-dr10" in u
    txt = ("projcell subcell ra dec filter mjd type filename shortname badflag\n"
           "2526 66 248.1 66.7 g 0.0 stack /a/g.fits g.fits 0\n2526 66 248.1 66.7 i 0.0 stack /a/i.fits i.fits 0\n"
           "2526 66 248.1 66.7 r 0.0 stack /a/r.fits r.fits 0")
    f = ov.parse_ps1_filenames(txt)
    assert f == {"g": "/a/g.fits", "i": "/a/i.fits", "r": "/a/r.fits"}
    u = ov.ps1_url(f, 248.1, 66.7, 5, 512)
    assert "size=1200" in u and "output_size=512" in u and "red=%2Fa%2Fi.fits" in u
    assert ov.parse_ps1_filenames("projcell subcell ra dec filter mjd type filename shortname badflag") == {}


def test_links_endpoint():
    r = client.get("/links", params={"ra": 133.795129, "dec": -7.245147})
    assert r.status_code == 200
    ids = {x["id"]: x["url"] for x in r.json()["links"]}
    assert set(ids) == {"simbad", "vizier", "legacy", "wiseview", "finderchart"}
    assert ids["wiseview"] == "https://byw.tools/wiseview#ra=133.795129&dec=-7.245147&size=176&band=2"
    assert "133.795129%20-7.245147" in ids["simbad"]
    assert client.get("/links", params={"ra": 400, "dec": 0}).status_code == 400


def test_validation():
    assert client.get("/known", params={"ra": 10, "dec": 0}).status_code == 400
    assert client.get("/known", params={"ra": 10, "dec": 0, "time": "yesterday"}).status_code == 400
    assert client.get("/gaia", params={"ra": 10, "dec": 0, "fov": 99}).status_code == 400
    assert client.get("/context", params={"ra": 10, "dec": 0, "size": 5000}).status_code == 400


def test_services_down_never_500(monkeypatch, tmp_path):
    async def boom(*a, **k):
        raise RuntimeError("ConnectError from nowhere")
    monkeypatch.setattr(ov, "_request", boom)
    monkeypatch.setattr(ov, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(ov, "_down", {})
    r = client.get("/gaia", params={"ra": 1.234, "dec": 5.678, "fov": 5})
    assert r.status_code == 200 and r.json()["sources"] == [] and "note" in r.json()
    r = client.get("/known", params={"ra": 1.234, "dec": 5.678, "time": "2026-01-10T00:00:00Z"})
    assert r.status_code == 200 and r.json()["objects"] == [] and "note" in r.json()
    assert client.get("/context", params={"ra": 1.234, "dec": 5.678}).status_code == 404
    assert client.get("/context/info", params={"ra": 1.234, "dec": 5.678}).json()["available"] is False
    assert not list(tmp_path.rglob("*.json"))  # failures are not cached


@live
def test_live_gaia_barnard():
    j = client.get("/gaia", params={"ra": 269.446268, "dec": 4.768204, "fov": 5}).json()
    fast = [s for s in j["sources"] if (s["pmdec"] or 0) > 10000]
    assert len(fast) == 1
    assert fast[0]["pmra"] == pytest.approx(-801.6, abs=1) and fast[0]["pmdec"] == pytest.approx(10362.4, abs=1)


@live
def test_live_known_ceres():
    # Ceres, geocentric, 2026-01-10 00:00 UT from JPL Horizons: RA 11.32354, Dec -4.15923
    j = client.get("/known", params={"ra": 11.32354, "dec": -4.15923, "fov": 10, "time": "2026-01-10T00:00:00Z"}).json()
    c = [o for o in j["objects"] if o["name"] == "Ceres"]
    assert c and abs(c[0]["ra"] - 11.32354) < 0.001 and abs(c[0]["dec"] + 4.15923) < 0.001


@live
@pytest.mark.parametrize("ra,dec", [(133.795129, -7.245147), (248.167233, 66.755024)])
def test_live_context(ra, dec):
    r = client.get("/context", params={"ra": ra, "dec": dec, "fov": 5})
    assert r.status_code == 200 and r.headers["X-Context-Source"] in ov.SURVEYS
    assert Image.open(io.BytesIO(r.content)).size == (512, 512)
