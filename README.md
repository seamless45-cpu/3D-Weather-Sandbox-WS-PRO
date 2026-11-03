# 3D-Weather-Sandbox-WS-PRO

**ATMOS//SIM** — a real-time, browser-based 3-D convective weather sandbox.

A headless anelastic (Ogura–Phillips) atmospheric solver runs in a Web Worker and feeds a
ray-marched volumetric cloud renderer built on three.js. Weather starts from a clear-sky
sounding and has to *earn* its storms: surface heating builds CAPE, convection initiates when
the environment allows it, and cold pools, gust fronts, hail, lightning and thunder emerge from
the simulation rather than from scripted animation.

## Live site

**https://seamless45-cpu.github.io/3D-Weather-Sandbox-WS-PRO/**

GitHub Pages is a plain static host, so it cannot run `src/main.tsx`. Pages is therefore served
from the `docs/` folder of `main`, which contains the prebuilt single-file app
(`docs/index.html`, produced by `npm run build:standalone`).

When the *source* `index.html` is opened on any static host instead, it notices that Vite is
absent and redirects itself to `atmos-sim-standalone.html` next to it, so a branch-root Pages
deployment also works.

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

### Render quality (phones and integrated GPUs)

The renderer picks a quality tier from the GPU string: `high` for desktop GPUs, `mid` for
mid-range mobile/Apple/integrated parts, and `low` for entry-level mobile (Adreno 6xx and older,
Mali-T/G5x and similar). The menu shows the detected GPU next to `RENDER QUALITY` and lets you
override it with **auto / low / mid / high**; the choice is stored in `localStorage`.

On the `low` tier every shader compiles a cut-down variant (`#ifdef LOWQ`): a 26-step cloud march
with one-tap sun transmittance and one-octave detail, single-tap cloud shading on terrain, water
and trees, no splash crowns, fewer trees and particles, no MSAA and a reduced pixel ratio.
Whatever the tier, the renderer also degrades at runtime — first to a cheap dense-march path,
then by coarsening steps, cloud buffer and finally screen resolution — and recovers when frames
are comfortable again. Recovery works on 60 Hz displays as well as high-refresh ones. The `ⓘ`
panel reports tier, measured fps, pixel ratio and cloud scale, which is the quickest way to see
what the device settled on.

The cloud pass writes a second (MRT) attachment holding the scattering depth of every pixel.
That buffer does two jobs: it reprojects the temporal history at the distance the cloud actually
sits at (a fixed 9 km reprojection point smeared badly once a cloud came close to the camera),
and it drives an edge-aware upsample of the reduced-resolution cloud buffer, so silhouettes stay
crisp instead of blocky. The renderer also watches the condensate at the camera's own altitude:
when a cloud base engulfs the viewer it skips the entry search, halves the march budget, drops
the history blend and switches terrain/water/vegetation to a cheap shadow path — the case that
used to cost the most frames.

The solver grid is chosen from CPU headroom, not the GPU tier alone: touch devices and machines
with fewer than six logical cores run 32×32×36, desktop `mid` runs 64×64×36, and desktop `high`
runs 64×64×48. All of them feed the same 48-layer cloud texture. Auto-detected phones also get
capped pixel/cloud buffers, march length and precipitation counts; an explicit `?perf=high`
override can still request the full render shader. Hard pixel budgets (`maxPixels` /
`maxCloudPixels`) stop a 4K or retina window from multiplying the cost by four. When
`EXT_disjoint_timer_query_webgl2` is available the HUD reports GPU time per pass; without timer
data the adaptive path assumes the volumetric cloud pass is the bottleneck rather than shrinking
the whole screen first.

### Multicell / MCS stage

The storm transition used to add several costs at once: the solver starts advecting seven extra
condensate/charge fields, electrified columns add a second FFT solve, rain shafts and particles
appear over much of the screen, and a lightning burst can fire several times per second. The
worker now solves electrostatics every fourth step, caps channel growth, keeps only the nearest
flash from each burst, returns snapshot buffers to a small pool and decimates/time-throttles the
CAPE diagnostic. The renderer estimates storm load from cloud fraction, core count and rain:
it thins rain/shaft instances, reduces dense-march steps and step length, and can switch to
one-tap cloud shadows, a single-tap sun-transmittance estimate and four-neighbour cloud
upsampling during a stall.

Thunder synthesis was the largest main-thread stall: each flash generated up to a 40-second
waveform with per-sample `exp()` and `Math.random()` calls. It now uses at most 48 bounded grains,
reused noise, recurrence-based filters/envelopes, a 10-second maximum buffer and a 180 ms rate
limit, so a lightning burst no longer freezes the render loop.

Diagnostics: append `?perf=low|mid|high` to force a tier, `&noadapt=1` to freeze runtime
degradation and `&profile=1` to enable GPU timer queries (useful when profiling).

### "I just get a white / blank screen"

The source `index.html` at the repository root **only works through Vite** — it loads
`/src/main.tsx`, which a browser cannot execute. If you open it from disk, from GitHub's file
view, or from a plain static server, nothing can mount. Instead:

* use the dev server (`npm run dev` → http://localhost:5173), or
* open the prebuilt `atmos-sim-standalone.html`.

Since the sources cannot boot that way, such a page shows a dark **"ATMOS//SIM COULD NOT
BOOT"** panel with the exact reason (for example `failed to load …/src/main.tsx`) instead of a
blank white page. The same panel appears if a runtime error or worker/WebGL failure prevents
the app from mounting.

If that panel appears on the live preview, the dev server is simply not running — it stops
whenever the sandbox restarts. Start it again (`npm run dev`) and the open page reloads itself:
the panel polls the failed script every 3 seconds and reloads as soon as the server answers
(there is also a **↻ retry** button).

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (HMR) |
| `npm run build` | Production build → `dist/index.html` (single self-contained file) |
| `npm run build:standalone` | Build + copy to `atmos-sim-standalone.html` and `docs/index.html` |
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
