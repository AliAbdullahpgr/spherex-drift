"""Offline unit tests plus a few live tests (set SPHEREX_LIVE=1 to run those)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import config, imaging, spherex  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
live = pytest.mark.skipif(os.environ.get("SPHEREX_LIVE") != "1", reason="set SPHEREX_LIVE=1 for network tests")


def test_health_and_targets():
    assert client.get("/health").json() == {"ok": True}
    t = client.get("/targets").json()
    assert [x["id"] for x in t] == ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]
    w = next(x for x in t if x["id"] == "wise0855")
    assert abs(w["ra"] - 133.795129) < 1e-5 and abs(w["dec"] + 7.245147) < 1e-5


def test_collections_are_config():
    assert config.COLLECTIONS and all(c.startswith("spherex_") for c in config.COLLECTIONS)


def test_bad_params():
    assert client.get("/frames?ra=10&dec=95").status_code == 400
    assert client.get("/frames?ra=10&dec=10&fov=99").status_code == 400
    assert client.get("/stack?ra=10&dec=10&detector=9").status_code == 400


def test_polygon_and_passes():
    poly = [(10.0, 10.0), (11.0, 10.0), (11.0, 11.0), (10.0, 11.0)]
    assert spherex._in_polygon(poly, 10.5, 10.5)
    assert not spherex._in_polygon(poly, 12.0, 10.5)
    wrap = [(359.5, 0.0), (0.5, 0.0), (0.5, 1.0), (359.5, 1.0)]
    assert spherex._in_polygon(wrap, 0.1, 0.5)


def test_target_wcs_north_up_east_left():
    w = imaging.target_wcs(100.0, 20.0, 5.0, 256)
    ra_c, dec_c = w.all_pix2world(127.5, 127.5, 0)
    assert abs(ra_c - 100.0) < 1e-9 and abs(dec_c - 20.0) < 1e-9
    r1, d1 = w.all_pix2world(137.5, 127.5, 0)   # +x
    r2, d2 = w.all_pix2world(127.5, 137.5, 0)   # +y (row 0 of raw reproject output is south)
    assert r1 < 100.0          # x increases to the west -> RA decreases (east is left)
    assert d2 > 20.0
    assert abs((d2 - 20.0) * 3600 - 10 * 300 / 256) < 0.05  # pixel scale = fov/size


def test_sigma_clip_removes_cosmic_ray():
    rng = np.random.default_rng(1)
    cube = rng.normal(0, 1, (12, 20, 20)).astype(np.float32)
    cube[3, 5, 5] = 1e4
    out = imaging.sigma_clipped_mean(cube)
    assert abs(out[5, 5]) < 1.5
    assert np.nanmax(np.abs(out)) < 3


def test_png_nan_black():
    a = np.random.default_rng(0).normal(0, 1, (32, 32)).astype(np.float32)
    a[:4, :4] = np.nan
    from io import BytesIO
    from PIL import Image
    im = np.array(Image.open(BytesIO(imaging.to_png(a))))
    assert im.dtype == np.uint8 and (im[:4, :4] == 0).all() and (im[8:, 8:] > 0).all()


def test_flag_names():
    arr = np.zeros((3, 3), np.int32)
    arr[1, 1] = (1 << 1) | (1 << 26)
    assert spherex._flag_names(arr) == ["overflow", "bloom"]


@live
def test_live_wise0855_endpoints():
    ra, dec = 133.795129, -7.245147
    r = client.get("/frames", params={"ra": ra, "dec": dec, "fov": 5})
    assert r.status_code == 200
    d = r.json()
    assert len(d["frames"]) > 200 and len(d["passes"]) >= 3
    f = d["frames"][0]
    assert {"id", "survey", "time", "mjd", "detector", "wavelength_um", "pass", "flags", "image_url"} <= f.keys()
    assert [x["mjd"] for x in d["frames"]] == sorted(x["mjd"] for x in d["frames"])
    img = client.get(f["image_url"] + "&format=npy")
    assert img.headers["x-shape"] == "256,256"
    assert np.frombuffer(img.content, "<f4").size == 256 * 256
    png = client.get(f["image_url"])
    assert png.headers["content-type"] == "image/png"
    st = client.get("/stack", params={"ra": ra, "dec": dec, "pass": 2, "detector": 3, "format": "npy"})
    assert st.status_code == 200 and int(st.headers["x-n-frames"]) > 5
    sp = client.get("/spectrum", params={"ra": ra, "dec": dec}).json()
    w = [p["wavelength_um"] for p in sp["points"]]
    assert w == sorted(w) and sp["unit"] == "MJy/sr" and len(w) > 100
