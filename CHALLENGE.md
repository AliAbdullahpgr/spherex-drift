# Planet X and SPHEREx — NASA Space Apps 2026

Source: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/
Event: Nov 14–15, 2026 · Difficulty: Advanced · Subjects: Astrophysics, Planets & Moons, Software

## Objective
Build a public-facing web tool that displays SPHEREx sky images so anyone can quickly see how the sky changes over time.
- User enters RA/Dec of a patch of sky.
- Tool shows a series of images of that patch like a short video (blink/animation) so moving objects are easy to spot.

## Required test targets
- Barnard's Star
- Epsilon Indi B (brown dwarf pair orbiting a star)
- WISE 0855 — RA 08h55m10.831s, Dec -07d14m42.53s (fast-moving brown dwarf)
- RW Aurigae (variable star)
- R Draconis (variable star)

## Optional considerations (bonus points)
- Easy to update as new SPHEREx data releases arrive.
- Creative use of the 102 bands, e.g. co-add per detector array (6 arrays) for S/N; generate spectra on the fly (extra kudos).
- Add / subtract images from different epochs.
- User-selectable field of view.
- Overlays from Gaia / WISE.
- Coordinates in the URL (embeddable / shareable).
- Show metadata such as contamination flags.
- Reuse existing tools: Astropy, CDS Aladin.

## Background
SPHEREx (since May 2025) maps the whole sky every 6 months in 102 near-IR bands; >1 billion objects.
Moving objects (asteroids, comets, nearby stars, brown dwarfs) shift between epochs; Pluto was found this way.
Citizen-science precedent: backyardworlds.org (WiseView).

## Resources (from Resources tab)
NASA:
- IRSA SPHEREx — https://irsa.ipac.caltech.edu/Missions/spherex.html
- SPHEREx tutorial notebooks — https://caltech-ipac.github.io/irsa-tutorials/spherex/
- WiseView — http://byw.tools/wiseview
- Gaia — https://archive.stsci.edu/missions-and-data/gaia
CSA:
- NEOSSat — https://www.asc-csa.gc.ca/eng/satellites/neossat/
- CADC — https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/
- NEOSSat tutorial — https://github.com/asc-csa/NEOSSAT_Tutorial
- NEOSSat dataset — https://data.asc-csa.gc.ca/dataset/neossat
