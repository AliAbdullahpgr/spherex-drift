# SPHEREx Drift references and acknowledgements

## NASA data and resources

### SPHEREx DR1 spectral all-sky cube

Used for calibrated infrared band images and spectra in the prepared fields and the direct-S3 mosaic pathway. The data contains 102 spectral channels; two documented blank dichroic channels remain masked. The mosaic combines observations and is not used as a set of temporal measurements.

- Dataset DOI: [10.26131/IRSA679](https://doi.org/10.26131/IRSA679).
- [IRSA SPHEREx mission and archive](https://irsa.ipac.caltech.edu/Missions/spherex.html).
- [Official data-product documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- [Official HiPS cube tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/).
- [NASA/IPAC IRSA S3 mirror](https://nasa-irsa-spherex.s3.amazonaws.com/index.html); the prepared cutouts retain the exact original FITS URLs under `dr1/hips5_cube/hips_20261026/`.

The implemented native-exposure pathway also queries SPHEREx DR1 and QR3 through IRSA SIA2 when that service is available. It is distinct from the prepared mosaic demonstration. [Official data-access documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/).

### WISE and NEOWISE observations through unWISE and WiseView

Used for the dated infrared images, motion demonstration and relative brightness trends. The application calls the WiseView image service and processes its linear PNG brightness ranges; it does not use the unWISE Time-Domain Catalog as its measurement source.

- [WISE and NEOWISE archive information](https://irsa.ipac.caltech.edu/Missions/wise.html).
- [IRSA unWISE overview and citation instructions](https://irsa.ipac.caltech.edu/data/WISE/unWISE/overview.html).
- [unWISE project](https://unwise.me/).
- [WiseView](https://byw.tools/wiseview) and [WiseView source and description](https://github.com/backyardworlds/wiseview).
- Actual image archive: [AMNH public cutouts on S3](https://amnh-citsci-public.s3-us-west-2.amazonaws.com/).
- Exact metadata endpoint, capture timestamps and processing notes are included in each prepared field's `frames.json`.

The IRSA unWISE image citation instructions identify Lang (2014), Meisner, Lang and Schlegel (2017a), Meisner, Lang and Schlegel (2017b), and dataset DOI [10.26131/IRSA524](https://doi.org/10.26131/IRSA524). The project's actual epoch images come through the WiseView service described above; the source manifests identify that access path rather than claiming a Time-Domain Catalog download.

## Supporting catalogues and image services

- [ESA Gaia DR3](https://www.cosmos.esa.int/web/gaia/data-release-3): catalogue positions and proper-motion context. The implementation queries the ESA archive and can fall back to VizieR/IRSA mirrors. [Gaia DR3 credit instructions](https://gea.esac.esa.int/archive/documentation/GDR3/Miscellaneous/sec_credit_and_citation_instructions/).
- [CDS VizieR](https://vizier.cds.unistra.fr/): catalogue access and external lookup links; a Harvard CfA mirror supports the Gaia fallback.
- [CDS SIMBAD and Sesame](https://simbad.cds.unistra.fr/): object-name resolution and external object lookup.
- [Legacy Surveys](https://www.legacysurvey.org/): optional visible-light reference cutouts when available.
- [Pan-STARRS image service](https://ps1images.stsci.edu/): optional visible-light reference cutouts when available.
- [CDS HiPS2FITS](https://alasky.cds.unistra.fr/hips-image-services/hips2fits): DSS2 reference-image fallback.
- [IMCCE SkyBoT](https://ssp.imcce.fr/webservices/skybot/): implemented known-object lookup for dated individual exposures. It is disabled for combined-date mosaics.

These resources provide supporting context. Their presence in the implementation does not mean every service is queried or contributes an image to every field. The Context panel identifies the survey that supplied its displayed reference image.

## Software and hosting

### Application and scientific processing

- [Python](https://www.python.org/), [FastAPI](https://fastapi.tiangolo.com/) and [Uvicorn](https://www.uvicorn.org/).
- [Astropy](https://www.astropy.org/) and [astropy-healpix](https://astropy-healpix.readthedocs.io/).
- [NumPy](https://numpy.org/), [SciPy](https://scipy.org/), [reproject](https://reproject.readthedocs.io/) and [Photutils](https://photutils.readthedocs.io/).
- [Pillow](https://python-pillow.org/) and [HTTPX](https://www.python-httpx.org/).
- [Astroquery](https://astroquery.readthedocs.io/) and [PyVO](https://pyvo.readthedocs.io/) are included in the astronomy dependency stack. The current SIA discovery request uses a direct, bounded HTTP request.
- [Next.js](https://nextjs.org/), [React](https://react.dev/) and [TypeScript](https://www.typescriptlang.org/); browser Canvas and SVG render the viewer and charts.
- [Vercel](https://vercel.com/) hosts the application and API.

### Testing and fonts

- [pytest](https://docs.pytest.org/), [Vitest](https://vitest.dev/), [Playwright](https://playwright.dev/) and [axe-core](https://github.com/dequelabs/axe-core).
- [Geist and Geist Mono](https://vercel.com/font) and [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif), loaded through Next.js font support.

Direct Python versions are recorded in `api/requirements.txt`. JavaScript dependencies and resolved versions are recorded in `web/package.json` and `web/package-lock.json`.

## Data acknowledgements

This project uses SPHEREx data produced through the mission's science and archive infrastructure, including NASA, JPL/Caltech and KASI, and distributed by NASA/IPAC IRSA. It uses WISE/NEOWISE observations and the unWISE and WiseView processing and access services credited above.

The Gaia context uses data from ESA's Gaia mission processed by the Gaia Data Processing and Analysis Consortium. See the linked Gaia credit instructions for the complete acknowledgement and supporting publication references.

## Project provenance

- [Project source](https://github.com/AliAbdullahpgr/spherex-drift/tree/build).
- [Prepared-data description](https://github.com/AliAbdullahpgr/spherex-drift/blob/build/api/prepared/README.md).
- [Source manifest and SHA-256 checksums](https://github.com/AliAbdullahpgr/spherex-drift/blob/build/api/prepared/manifest.json).

Real observation arrays come from the cited archives and services. AI-edited avatar concepts are separate presentation assets; they are not astronomical data or validation evidence. AI assistance is disclosed separately.
