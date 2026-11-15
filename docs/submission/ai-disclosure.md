# SPHEREx Drift AI use disclosure

## Short disclosure for the submission form

AI assistance was used during development. OpenAI Codex/ChatGPT and CommandCode assisted with application code, debugging, tests, deployment troubleshooting and documentation. The CommandCode session records the model identifier `deepseek/deepseek-v4.1-flash-fast`. OpenAI ImageGen produced AI-edited app-screenshot concepts for a possible team avatar; these are separate presentation assets. The live scientific views use real WISE and SPHEREx archive pixels, processed with numerical algorithms. Generative AI does not create those observation arrays or perform the live motion detection. Synthetic demo images and injected-object simulations are explicitly labelled. Validation included 82 passing unit/regression tests and 17 passing real-data Playwright checks on the deployed app.

## Detailed disclosure

### OpenAI Codex and ChatGPT

Used as coding and writing assistants for implementation, code changes, debugging, archive-access investigation, data preparation scripts, scientific-source documentation, test automation, deployment checks and submission drafting.

### CommandCode

Used as an earlier coding and deployment assistant in the project workflow. The inspected session log records `deepseek/deepseek-v4.1-flash-fast` as the model identifier. This is an assistance tool used in development, not a model deployed in the scientific analysis pipeline.

### OpenAI ImageGen

Used to edit screenshots into alternative team-avatar concepts, including changes to framing, layout, emphasis, text and graphical presentation. Those edited concepts are AI-generated or AI-modified visual assets. They are not raw screenshots, observed sky data, or evidence that the app produced a scientific result.

### Separation from scientific measurements

The real-data viewer uses archive-derived pixel arrays with source and processing information. WISE preparation merges two linear preview brightness ranges and reprojects them onto a common sky grid. SPHEREx preparation reads calibrated DR1 FITS cube cutouts and their original wavelength tables. These are mathematical data-processing steps, not generative image synthesis.

The motion finder and chart computations use numerical browser code. No language-model call supplies a measured motion, fills a masked spectral measurement, or generates a real observing date. The optional offline demo and artificial-object injection are simulations and are labelled in the app. They must not be presented as observed detections.

### Validation

The deployed version passed 17 real-data Playwright acceptance checks covering the five targets, spectra, six wavelength bands, playback and display modes, motion recovery, relative brightness trends, coordinate validation, name lookup, desktop accessibility checks, mobile use and browser/HTTP errors. The development checks also passed 47 frontend tests and 35 backend tests. These checks test the prototype's behaviour; they do not establish a new astronomical discovery, validate precision photometry, or replace independent scientific review.

## Visual asset note for preparing the submission

Use an untouched app screenshot or a direct screen recording to demonstrate what the app actually displays. If an ImageGen-edited avatar or screenshot concept is included, visibly identify it as AI-generated or AI-edited according to the event's submission guidance. A short caption is: "AI-edited app screenshot for presentation; not an astronomical observation."

The copy above describes assistance established in this development session. Add any other AI tools or external assets used by team members before submitting the final disclosure.
