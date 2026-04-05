# AJAMIX

AJAMIX — Offline mathematics education in Ajami for tsangaya students.

## Overview

AJAMIX is a vanilla JavaScript, offline-first Progressive Web App for teaching foundational mathematics to tsangaya learners in Northern Nigeria. It is designed to run device-locally, cache the app shell for low-connectivity use, and deliver learning content from a JSON bundle rather than a backend service.

## Tech stack

- Vanilla HTML, CSS, and JavaScript
- Progressive Web App manifest + service worker
- IndexedDB for local settings, modules, glossary, audio cache metadata, and progress
- Node.js CLI for CSV-to-JSON content bundling

## Local run

Serve the project so the app is available at `/app/`.

```bash
cd ajamix
python3 -m http.server 4173
```

Then open `http://localhost:4173/app/`.

## Content pipeline

The content pipeline turns a CSV file into the JSON bundle consumed by the app shell.

From the `ajamix/tools/` directory:

```bash
node content-pipeline.js --input ../modules.csv --output ../app/content.json
```

From the `ajamix/` project root:

```bash
node tools/content-pipeline.js --input modules.csv --output app/content.json
```

Expected CSV columns include:

- `module_number`, `grade_band`
- `title_en`, `title_ha`, `title_ajami`
- `text_explanation_ha`, `audio_filename`
- `micro_pause_1_ms` through `micro_pause_2_options`
- `quiz_1_template` through `quiz_5_distractor_3`

`micro_pause_*_options` should be pipe-delimited, for example `3|5|7`.

## Notes

- The `app/fonts/` directory is ready for bundled `woff2` font files.
- Audio and image files are referenced as placeholder paths for now.
- `docs/PRD.md` and `docs/TAS.md` were intentionally left untouched outside this subproject scaffold.
