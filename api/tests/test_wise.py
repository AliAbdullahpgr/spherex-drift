"""Tests for app.wise. Offline tests monkeypatch the upstream; the live test hits the real service
(skipped when unreachable or WISE_SKIP_LIVE=1)."""
import io
import os
import sys
from pathlib import Path

import numpy as np
import pytest
from astropy.wcs import WCS
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import wise, wise_grid as G  # noqa: E402

RA, DEC, FOV, SIZE = 150.0, 2.0, 5.0, 128
MJDS = [55300.0, 55480.0, 56800.0]


def make_app():
    app = FastAPI()
    app.include_router(wise.router)
    return TestClient(app)


def fake_meta_factory(star_dra_arcsec, star_ddec_arcsec):
    """Synthetic upstream: epoch 1 empty (no coverage), epochs 2,3 contain a star at a sky offset."""
    src = _src_size = wise._src_size(FOV)
    meta = {"ims": ["cutouts/e0", "cutouts/e1", "cutouts/e2"], "all_mjds": MJDS,
            "mjds": [[m] for m in MJDS], "epochs": [[0], [1], [2]],
            "CRVAL1": RA, "CRVAL2": DEC, "CRPIX1": (src + 1) / 2, "CRPIX2": (src + 1) / 2,
            "NAXIS1": src, "NAXIS2": src}
    swcs = G.source_wcs(RA, DEC, (src + 1) / 2, (src + 1) / 2)
    cosd = np.cos(np.radians(DEC))
    sx, sy = swcs.all_world2pix(RA + star_dra_arcsec / 3600 / cosd, DEC + star_ddec_arcsec / 3600, 0)
    yy, xx = np.mgrid[:src, :src]
    flux = 200 * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / 2 / 1.5 ** 2)  # array row 0 = south
    png = np.clip(30 + flux, 0, 254).astype(np.uint8)[::-1]  # PNG row 0 = north
    pngs = {"e0": np.zeros_like(png), "e1": png, "e2": png}

    async def _meta(client, ra, dec, fov, band, rng):
        return meta

    async def _png(client, name):
        return pngs[name.split("/")[-1]]
    return _meta, _png


@pytest.fixture
def offline(tmp_path, monkeypatch):
    monkeypatch.setattr(wise, "CACHE_DIR", tmp_path)
    # star 60" east and 40" north of centre
    m, p = fake_meta_factory(60.0, 40.0)
    monkeypatch.setattr(wise, "_meta", m)
    monkeypatch.setattr(wise, "_png", p)
    return make_app()


def test_frames_shape_and_skip_uncovered(offline):
    j = offline.get("/wise/frames", params=dict(ra=RA, dec=DEC, fov=FOV)).json()
    fr = j["frames"]
    assert len(fr) == 4  # 2 covered epochs x 2 bands; the empty epoch is skipped
    assert [f["mjd"] for f in fr] == sorted(f["mjd"] for f in fr)
    for f in fr:
        assert f["survey"] == "wise" and f["detector"] is None and f["flags"] == []
        assert f["wavelength_um"] in (3.4, 4.6)
        assert f["image_url"].startswith("/wise/image/")
        assert f["time"].endswith("Z")
    assert {f["pass"] for f in fr} == {1, 2}  # 56800 is >90 d after 55480
    assert len(j["passes"]) == 2 and j["passes"][0]["n_frames"] == 2


def test_image_npy_north_up_east_left(offline):
    fr = offline.get("/wise/frames", params=dict(ra=RA, dec=DEC, fov=FOV)).json()["frames"]
    f = fr[0]
    r = offline.get(f["image_url"].split("?")[0], params=dict(ra=RA, dec=DEC, fov=FOV, size=SIZE, format="npy"))
    assert r.status_code == 200
    assert r.headers["X-Shape"] == f"{SIZE},{SIZE}"
    a = np.frombuffer(r.content, dtype="<f4").reshape(SIZE, SIZE)
    assert len(r.content) == SIZE * SIZE * 4
    assert abs(np.median(a)) < 1.0  # median background subtracted
    row, col = np.unravel_index(np.argmax(a), a.shape)
    scale = FOV * 60 / SIZE
    # star is 40" north (row above centre) and 60" east (column left of centre)
    c = (SIZE - 1) / 2
    assert row == pytest.approx(c - 40 / scale, abs=1.5)
    assert col == pytest.approx(c - 60 / scale, abs=1.5)


def test_image_png(offline):
    fr = offline.get("/wise/frames", params=dict(ra=RA, dec=DEC, fov=FOV)).json()["frames"]
    r = offline.get(fr[0]["image_url"].split("?")[0], params=dict(ra=RA, dec=DEC, fov=FOV, size=64, stretch="log"))
    assert r.headers["content-type"] == "image/png"
    im = Image.open(io.BytesIO(r.content))
    assert im.mode == "L" and im.size == (64, 64)


def test_nan_is_black():
    a = np.random.default_rng(0).normal(size=(32, 32)).astype(np.float32)
    a[:4, :4] = np.nan
    im = np.array(Image.open(io.BytesIO(G.to_png(a))))
    assert (im[:4, :4] == 0).all() and (im[8:, 8:] > 0).all()


def test_bad_frame_id_and_args(offline):
    assert offline.get("/wise/image/nonsense", params=dict(ra=RA, dec=DEC, fov=FOV)).status_code == 404
    assert offline.get("/wise/frames", params=dict(ra=RA, dec=99, fov=FOV)).status_code == 422
    assert offline.get("/wise/frames", params=dict(ra=RA, dec=DEC, fov=0)).status_code == 422


def test_no_coverage_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(wise, "CACHE_DIR", tmp_path)

    async def none_meta(*a, **k):
        return None
    monkeypatch.setattr(wise, "_meta", none_meta)
    j = make_app().get("/wise/frames", params=dict(ra=RA, dec=DEC, fov=FOV)).json()
    assert j["frames"] == [] and j["passes"] == []


def test_target_wcs_convention():
    w = G.target_wcs(10.0, 20.0, 5.0, 256)
    x0, y0 = w.all_world2pix(10.0, 20.0, 0)
    assert (x0, y0) == pytest.approx((127.5, 127.5), abs=1e-6)
    xe, _ = w.all_world2pix(10.01, 20.0, 0)
    assert xe < x0  # east (larger RA) is to the left
    assert w.wcs.cdelt[1] * 3600 * 256 == pytest.approx(300.0)


@pytest.mark.skipif(os.environ.get("WISE_SKIP_LIVE") == "1", reason="live test disabled")
def test_live_wise0855(tmp_path, monkeypatch):
    monkeypatch.setattr(wise, "CACHE_DIR", tmp_path)
    c = make_app()
    try:
        j = c.get("/wise/frames", params=dict(ra=133.795129, dec=-7.245147, fov=5)).json()
    except Exception as e:  # pragma: no cover
        pytest.skip(f"upstream unreachable: {e}")
    if r := j.get("detail"):
        pytest.skip(f"upstream error: {r}")
    fr = [f for f in j["frames"] if f["wavelength_um"] == 4.6]
    assert len(fr) >= 15
    assert fr[0]["time"] < "2011" and fr[-1]["time"] > "2023"
    r = c.get(fr[0]["image_url"].split("?")[0], params=dict(ra=133.795129, dec=-7.245147, fov=5, size=128, format="npy"))
    assert r.status_code == 200 and r.headers["X-Shape"] == "128,128"
    a = np.frombuffer(r.content, dtype="<f4").reshape(128, 128)
    assert np.isfinite(a).sum() > 0.5 * a.size and a.max() > 50
