# 3D-Weather-Sandbox-WS-PRO

**ATMOS//SIM** — a real-time, browser-based 3-D convective weather sandbox.

A headless anelastic (Ogura–Phillips) atmospheric solver runs in a Web Worker and feeds a
ray-marched volumetric cloud renderer built on three.js. Weather starts from a clear-sky
sounding and has to *earn* its storms: surface heating builds CAPE, convection initiates when
the environment allows it, and cold pools, gust fronts, hail, lightning and thunder emerge from
the simulation rather than from scripted animation.

## Quick start

**Option A — dev server (recommended):**

```bash
npm ci          # install dependencies
npm run dev     # dev server on http://localhost:5173 (also bound to 0.0.0.0)
```

**Option B — zero setup:** open [`atmos-sim-standalone.html`](atmos-sim-standalone.html) in a
modern browser. It is the whole app inlined into one file and runs straight from disk
(`file://`) or any static host. Rebuild it with `npm run build:standalone`.

Then pick an initial environment and press **▶ enter simulation**. The first storms typically
appear after ~3 simulated hours of daytime heating, so run at a time-lapse speed of ×15 or
higher if you do not want to wait in real time.

### "I just get a white / blank screen"

The source `index.html` at the repository root **only works through Vite** — it loads
`/src/main.tsx`, which a browser cannot execute. If you open it from disk, from GitHub's file
view, or from a plain static server, nothing can mount. Instead:

* use the dev server (`npm run dev` → http://localhost:5173), or
* open the prebuilt `atmos-sim-standalone.html`.

Since the sources cannot boot that way, such a page now shows a dark "ATMOS//SIM COULD NOT
BOOT" panel with the reason (for example `failed to load …/src/main.tsx`) instead of a blank
white page. The same panel appears if a runtime error or worker/WebGL failure prevents the app
from mounting.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (HMR) |
| `npm run build` | Production build → `dist/index.html` (single self-contained file) |
| `npm run build:standalone` | Build + copy to `atmos-sim-standalone.html` (openable from disk) |
| `npm run preview` | Serve the production build on http://localhost:4173 |
| `npm run typecheck` | TypeScript project check (app + scripts) |
| `npm test` | Headless simulation smoke test (see below) |

## Simulation smoke test

`scripts/simtest.ts` runs the analytical validation suite (Bolton `e_s`, Espy LCL,
Weisman–Klemp CAPE/EL) and then integrates the full 3-D model, printing diagnostics every
30 simulated minutes and every lightning flash.

```bash
npm test                          # preset=pulse, 64x64x36, 4 simulated hours
npm test -- super 32 36 4.5       # preset, N, NZ, hours
```

Valid presets: `capped`, `fairwx`, `pulse`, `squall`, `super`.

The script exits non-zero if a validation check fails, the preset is unknown, or the solution
blows up, so it is safe to use in CI. A passing run looks like:

```
validation: 6/6 passed
...
t=13.00h ... maxW=25.8/-10.5 qc=1.86 ... fl=4 ... E=50kV/m
RESULT: PASS
```

The horizontal grid is a square, **power-of-two** grid (the pressure solve is a radix-2 FFT),
so `N` must be 8, 16, 32, 64, 128, … The app uses 64 (desktop) or 32 (mobile/coarse pointer).

## What is modelled

* **Dynamics** — anelastic Navier–Stokes on a periodic 32 km × 32 km × 15 km MAC grid with
  vertical stretching; mass-weighted TVD (van Leer) advection of momentum, θ, water vapour,
  5 hydrometeor species and 2 charge species; exact FFT/tridiagonal variable-density pressure
  projection (divergence removed to round-off).
* **Physics** — Deardorff 1.5-order TKE sub-grid closure, surface energy balance (shortwave
  with slope/cloud shading, longwave, sensible and latent fluxes, soil moisture, runoff),
  roughness drag, terrain lifting at the lower boundary, bulk microphysics (Kessler warm rain,
  Bergeron/WBF, riming, graupel, melting/freezing, evaporation, sedimentation), Saunders-type
  non-inductive charging and dielectric-breakdown-model lightning with branched channels.
* **Rendering** — volumetric ray-marched clouds with light shafts, terrain, water, vegetation,
  rain streaks, lightning channel geometry and synthesised thunder.

## Notes

* Requires a WebGL2-capable browser (software rendering such as SwiftShader also works).
* The UI has been smoke-tested headlessly in Chromium: the dev server, the production build and
  the standalone file all mount, initialise the worker and render the volumetric scene.
* The terrain and solver are periodic and flat-level; nothing smaller than ~1.5 km is resolved.
* `3d-atmospheric-weather-simulation (2).zip` is the original uploaded archive; the extracted
  sources at the repository root are the working copy.
