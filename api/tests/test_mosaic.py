"""Regression checks for real-data fallback semantics and prepared-field loading."""
import json
from pathlib import Path
import sys

import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, imaging, mosaic, spherex, wise
from app.main import app


@pytest.fixture
def cube(monkeypatch):
    w = imaging.target_wcs(10, 20, 6.88, 32)  # native 12.9 arcsec pixels
    yy, xx = np.mgrid[:32, :32]
    source = np.exp(-((xx - 15.5)**2 + (yy - 15.5)**2) / 2)
    arr = np.stack([source * (i + 1) for i in range(102)]).astype("f4")
    arr[50:52] = np.nan  # documented blank dichroic channels
    d = dict(cube=arr, waves=np.linspace(.753, 4.988, 102), header=np.array(w.to_header().tostring()),
             source=np.array("https://nasa-irsa-spherex.s3.amazonaws.com/verified.fits"),
             start=np.array("2025-04-01T00:00:00"), end=np.array("2026-04-01T00:00:00"))
    monkeypatch.setattr(mosaic, "field", lambda *args: d)
    return d


def test_mosaic_frames_are_explicitly_labelled_coadds(cube):
    d = mosaic.frames(10, 20, 5)
    assert d["source"] == "dr1-mosaic" and "not a separate observing date" in d["note"]
    assert len(d["frames"]) == 6
    assert all(f["flags"] == ["dr1_mosaic"] for f in d["frames"])
    assert d["provenance"]["doi"] == "10.26131/IRSA679"


def test_spectrum_uses_calibrated_channels_and_omits_blank_channels(cube):
    d = mosaic.spectrum(10, 20, 10, 20)
    assert len(d["points"]) == 100
    assert d["points"][0]["flux_mjy_sr"] > 0
    assert "time" not in d["points"][0]  # never make a false variability curve
    assert d["points"][0]["wavelength_um"] == pytest.approx(.753)
    assert d["points"][-1]["wavelength_um"] == pytest.approx(4.988)
    assert d["radius_arcsec"] >= 12.9 * .8


def test_band_image_is_finite_and_peaks_at_the_requested_center(cube):
    a = mosaic.image(10, 20, 5, 64, 1)
    assert a.shape == (64, 64)
    y, x = np.unravel_index(np.nanargmax(a), a.shape)
    assert abs(x - 31.5) <= 1 and abs(y - 31.5) <= 1


def test_archive_outage_uses_mosaic_without_claiming_empty_sky(cube, monkeypatch, tmp_path):
    monkeypatch.setattr(mosaic, "PREPARED", tmp_path)
    def unavailable(*a, **kw):
        raise RuntimeError("IRSA search returned HTTP 502")
    monkeypatch.setattr(spherex, "frame_list", unavailable)
    r = TestClient(app).get("/frames?ra=10&dec=20&fov=5&probe=false")
    assert r.status_code == 200 and r.json()["source"] == "dr1-mosaic"
    assert len(r.json()["frames"]) == 6


def test_prepared_wise_images_do_not_query_upstream(monkeypatch, tmp_path):
    monkeypatch.setattr(wise, "PREPARED", tmp_path)
    t = config.TARGETS[0]
    directory = tmp_path / t["id"]
    directory.mkdir()
    (directory / "frames.json").write_text(json.dumps({"frames": [{"id": "w2e55300.000"}]}))
    np.savez_compressed(directory / "w2e55300.000.npz", image=np.ones((256, 256), "f4"))
    async def never(*a, **kw):
        raise AssertionError("prepared WISE image must not query remote metadata")
    monkeypatch.setattr(wise, "_meta", never)
    client = TestClient(app)
    r = client.get(f"/wise/image/w2e55300.000?ra={t['ra']}&dec={t['dec']}&format=npy")
    assert r.status_code == 200 and len(r.content) == 256 * 256 * 4
    assert "s-maxage" in r.headers["cache-control"]


def test_all_five_prepared_fields_have_genuine_valid_arrays():
    for t in config.TARGETS:
        path = mosaic.PREPARED / f"{mosaic._field_key(t['ra'], t['dec'], 5)}.npz"
        with np.load(path, allow_pickle=False) as z:
            assert z["cube"].shape[0] == len(z["waves"]) == 102
            assert np.all(np.diff(z["waves"]) > 0)
            assert np.isnan(z["cube"][50:52]).all()  # documented blank channels
            assert str(z["source"]).startswith(mosaic.BASE)
        d = wise.PREPARED / t["id"]
        data = json.loads((d / "frames.json").read_text(encoding="utf-8"))
        assert data["source"] == "unwise-prepared" and data["provenance"]["captured_at"]
        assert len(data["frames"]) >= 40
        for f in data["frames"]:
            with np.load(d / f"{f['id']}.npz", allow_pickle=False) as z:
                assert z["image"].shape == (256, 256)
                assert np.isfinite(z["image"]).mean() >= .1


def test_expired_archive_deadline_never_starts_network_work(monkeypatch, tmp_path):
    import time
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    with pytest.raises(TimeoutError):
        mosaic._range("https://example.invalid/no-request", 0, 2880, deadline=time.monotonic()-1)
