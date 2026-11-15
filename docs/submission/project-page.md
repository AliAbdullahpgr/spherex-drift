# SPHEREx Drift project submission

## Project name

SPHEREx Drift

## Challenge

Planet X and SPHEREx — NASA Space Apps Challenge 2026

## High Level Project Summary

SPHEREx Drift helps people see what moves and changes in the infrared sky. It combines real WISE observations across years with SPHEREx DR1 spectral mosaics in a public browser app. Blink playback, coloured motion trails and difference images make changes easier to inspect; a motion finder measures candidate tracks, while spectra connect a selected sky position to its infrared brightness across wavelengths. In live testing, it recovered WISE 0855 moving west at about 8.2 arcseconds per year across 23 observing dates. Five prepared fields let judges and learners explore real observations without waiting for an external archive search.

## Short Summary

SPHEREx Drift combines years of real WISE images with SPHEREx infrared spectra in a public web app. Blink, Trail and Difference views reveal changes; the motion finder recovered WISE 0855 moving west at about 8.2 arcseconds per year. Five prepared fields make the core demo independent of archive-search availability.

## Detailed Project Description

### The problem

A moving or variable object can look ordinary in a single sky image. Finding the change requires comparing observations of the same location, keeping their alignment consistent, and understanding what the different dates and wavelengths represent. Those steps can be a barrier for students and citizen scientists who want to explore public infrared observations without first setting up an astronomy software environment.

### The solution

SPHEREx Drift brings that comparison into a browser. Users can select Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae or R Draconis, or enter coordinates or an object name. The viewer provides three complementary ways to inspect the field. Blink plays the observing dates in sequence. Trail assigns colours across time so motion stands out. Difference subtracts comparable images to make changing sources easier to distinguish from the static background.

The timeline and frame thumbnails keep the observations accessible. Users can change the field of view, wavelength band, image stretch and playback settings, then share the current view through its URL. The same viewer works on desktop and mobile.

### How the data becomes an interactive view

The backend obtains real archive pixels and reprojects them onto a common grid with north up and east left. The WISE pathway uses time-resolved unWISE images accessed through the WiseView service. It combines two linear preview brightness ranges before reprojection, retaining the observing dates needed for motion analysis. The SPHEREx pathway uses calibrated DR1 all-sky spectral cube cutouts and their original wavelength tables, with band views across the six detectors and spectra at selected positions.

The five preset fields include prepared copies of real observations, source URLs and checksums. This avoids repeating large downloads during a demonstration and keeps those fields usable when the external archive-search service is unavailable. Other positions still use live services. The backend also retains a native SPHEREx exposure pathway for searches when the archive service is available.

### Analysis and demonstration

The motion finder searches for approximately straight tracks across multiple dates. The WISE 0855 demonstration recovered a westward motion of about 8.2 arcseconds per year over 23 WISE observing dates. This is a demonstration on a known moving source, not a claim of a new discovery.

The Spectrum panel displays calibrated SPHEREx surface brightness across the available channels. The Brightness panel provides relative WISE trends for the variable-star examples. Gaia catalogue positions and proper-motion overlays, survey reference images and external catalogue links help users investigate the surrounding field. An explicitly labelled simulation can add a synthetic moving object to explore detectability without confusing it with an observation.

### Scientific limits

The prepared SPHEREx DR1 mosaics combine observations and have 12.9-arcsecond native pixels. They provide spectral context rather than separate observing epochs; the time-resolved demonstrations use WISE. Blank and masked spectral channels are excluded. For bright targets with unusable cores, an available outer-halo measurement is labelled as such. WISE brightness trends use quantized preview pixels and are quick-look measurements, not precision catalogue photometry. Candidate tracks require further investigation, and a feature marker on the spectrum is not a confirmed chemical detection. Asteroid matching is unavailable for mosaics because it needs individual exposure dates.

### Impact and next steps

The prototype lets a learner move from a familiar star field to evidence of motion, brightness changes and wavelength-dependent emission within one interface. Its useful contribution is the connected workflow: a visible change leads to a measured candidate and then to its observational context, with the sources and limitations kept visible.

Next steps are to expand prepared field coverage, improve persistent caching for arbitrary positions, strengthen quality and saturation handling, and extend the time-resolved SPHEREx experience as archive access and data releases develop. The code separates data access from viewing and analysis so new releases can be incorporated without rebuilding the interface.

## NASA Data and Resources Used

SPHEREx Drift uses NASA's SPHEREx DR1 all-sky spectral cube data, accessed from the NASA/IPAC IRSA S3 mirror, for calibrated spectral images and spectra. The prepared fields retain the original wavelength tables, source URLs and observing-date ranges. The product DOI is 10.26131/IRSA679. It also uses NASA WISE/NEOWISE observations through time-resolved unWISE images served by WiseView for the motion and brightness demonstrations. These are real observations; the app's optional synthetic demo and injected-object simulation are separately labelled. ESA Gaia DR3 supplies supporting catalogue and proper-motion context. Full source and software acknowledgements are in the accompanying References document.

## Technology and Development Approach

The frontend uses Next.js, React, TypeScript and the browser Canvas API. A Python FastAPI backend handles archive access, image reprojection and spectral measurements with Astropy, astropy-healpix, NumPy, SciPy, reproject, Photutils, Pillow and HTTPX. Vercel hosts the frontend and API. Vitest and pytest cover the processing and application logic; Playwright exercises the deployed app with real data, and axe-core checks automated accessibility rules.

AI coding assistants contributed implementation, debugging, test automation and documentation. Their use and the separate AI-edited avatar concepts are disclosed in the accompanying AI Use document.

## Final Project Link

https://spherex-drift.vercel.app

## Source Code Link

https://github.com/AliAbdullahpgr/spherex-drift/tree/build

## Reproducibility Links

- Data provenance and processing: https://github.com/AliAbdullahpgr/spherex-drift/blob/build/api/prepared/README.md
- Prepared-data manifest: https://github.com/AliAbdullahpgr/spherex-drift/blob/build/api/prepared/manifest.json
- Browser acceptance checks: https://github.com/AliAbdullahpgr/spherex-drift/blob/build/web/e2e/hackathon.mjs
- Backend processing tests: https://github.com/AliAbdullahpgr/spherex-drift/tree/build/api/tests

## Project Demonstration Link

Supply the separately hosted demo video or slide-deck URL in the Project Demo field. The live application URL belongs in Final Project Link.
