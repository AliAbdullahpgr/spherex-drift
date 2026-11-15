# Prepared real observations

These files contain real observed pixels for the five named, 5-arcminute preset fields.
They are included in the deployment so a judging/demo session does not depend on a
successful external archive search or repeat hundreds of cold downloads.

- `wise/<target>/frames.json`: real WISE/unWISE epoch dates, band metadata, source
  information, and capture timestamp. Each `.npz` contains its corresponding 256×256
  float32, north-up, background-subtracted image. Processing is identical to the live
  `app/wise.py` path: merge two linear brightness ranges and reproject onto a TAN grid.
  The upstream PNG previews are quantized and can saturate. Browser brightness trends
  are explicitly quick-look measurements, not precision photometry.
- `mosaic/*.npz`: small native pixel cutouts from the published SPHEREx DR1 all-sky
  FITS cubes, with the original celestial WCS, calibrated 102-channel wavelength table,
  observing date range, and exact source S3 URL. The two documented blank dichroic
  channels remain NaN. Missing or saturated pixels are not filled in scientific
  measurements. A mosaic combines observing dates and must never be described as an
  individual exposure or used to infer temporal variability.
- `manifest.json`: capture timestamp, sources, file sizes, and SHA-256 checksums.

SPHEREx source: <https://nasa-irsa-spherex.s3.amazonaws.com/dr1/hips5_cube/hips_20261026/>.
Product DOI: <https://doi.org/10.26131/IRSA679>.
Format: <https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/>.
WISE source: <https://amnh-citsci-public.s3-us-west-2.amazonaws.com/> via WiseView's
unWISE time-resolved image service (exact metadata endpoint is in each field manifest).

Refresh using `python scripts/prepare_fields.py` from `api/`, with runtime requirements
installed. Existing captures are reused; preserve a copy before deliberately refreshing
a field. Custom positions and fields of view still use the live archive paths.

This work uses data from SPHEREx, a joint project of the Jet Propulsion Laboratory,
California Institute of Technology, and the Korea Astronomy and Space Science Institute,
funded by the National Aeronautics and Space Administration. WISE is a joint project of
the University of California, Los Angeles, and JPL/Caltech, funded by NASA; NEOWISE is a
project of JPL/Caltech funded by the Planetary Science Division of NASA.
