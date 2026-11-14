# API contract (shared by /api and /web)

Backend: FastAPI at http://localhost:8000, CORS open to http://localhost:3000.
Frontend: Next.js at http://localhost:3000, reads backend base URL from NEXT_PUBLIC_API_URL.

All coordinates are ICRS decimal degrees. `fov` is the cutout width in arcminutes (default 5, max 30).

## GET /targets
The five required test targets.
```json
[{"id":"wise0855","name":"WISE 0855","ra":133.795129,"dec":-7.245147,"note":"fast-moving brown dwarf"}]
```
ids: barnard, epsindib, wise0855, rwaur, rdra

## GET /frames?ra&dec&fov&group=detector|band&survey=spherex
Lists the image frames covering the position, oldest first. Does NOT return pixels.
```json
{
  "ra": 133.79, "dec": -7.24, "fov": 5,
  "frames": [
    {
      "id": "opaque-string",
      "survey": "spherex",          // or "wise"
      "time": "2025-11-02T10:11:12Z",
      "mjd": 60981.42,
      "detector": 3,                 // 1..6 for spherex, null for wise
      "wavelength_um": 2.1,          // central wavelength at this position
      "pass": 1,                     // which sky pass / epoch index, starting at 1
      "flags": ["contaminated"],     // quality flags, may be empty
      "image_url": "/image/opaque-string?ra=..&dec=..&fov=..&stretch=asinh"
    }
  ],
  "passes": [{"pass":1,"start":"2025-05-..","end":"2025-11-..","n_frames":42}]
}
```

## GET /image/{frame_id}?ra&dec&fov&stretch=asinh|linear|log&size=256&format=png|npy
PNG cutout, north up, east left, centred on ra/dec. Grayscale 8-bit.
`format=npy` returns raw float32 array bytes (little-endian, size x size) with header
`X-Shape: 256,256`, used by the browser for difference and colour composites.

## GET /stack?ra&dec&fov&pass=1&detector=3&size=256&format=png|npy
Co-added image of all frames from one detector in one pass (better signal to noise).

## GET /spectrum?ra&dec&radius_arcsec=6
```json
{"points":[{"wavelength_um":0.75,"flux_mjy_sr":1.2,"err":0.1,"time":"...","pass":1,"detector":1,"flags":[]}]}
```

## GET /wise/frames?ra&dec&fov   and   GET /wise/image/{frame_id}?ra&dec&fov&size&format
Same shapes as /frames and /image, survey = "wise", one frame per WISE epoch (2010 onward),
`wavelength_um` 3.4 (W1) or 4.6 (W2).

## GET /health
`{"ok": true}`

Errors: JSON `{"detail": "..."}` with 4xx/5xx. No coverage returns 200 with `"frames": []`.
