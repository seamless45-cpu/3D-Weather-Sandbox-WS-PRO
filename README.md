# 3D-Weather-Sandbox-WS-PRO

**ATMOS//SIM** — a real-time, browser-based 3-D convective weather sandbox.

A headless anelastic (Ogura–Phillips) atmospheric solver runs in a Web Worker and feeds a
ray-marched volumetric cloud renderer built on three.js. Weather starts from a clear-sky
sounding and has to *earn* its storms: surface heating builds CAPE, convection initiates when
the environment allows it, and cold pools, gust fronts, hail, lightning and thunder emerge from
the simulation rather than from scripted animation. A coupled sub-grid vortex, mixed-phase
charge separation, heavier rain cores and a player-drivable intercept vehicle now build on the
same solved fields.

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

Then pick an initial environment and press **▶ enter simulation**. Press **V** in the simulation to
enter or leave the intercept vehicle; **W/S** throttle, **A/D** steer, **Space** is the handbrake and
**P** deploys the roof probe. The first storms typically
appear after ~3 simulated hours of daytime heating, so run at a time-lapse speed of ×15 or
higher if you do not want to wait in real time.

### Render quality (phones and integrated GPUs)

The renderer picks a quality tier from the GPU string: `high` for desktop GPUs, `mid` for
mid-range mobile/Apple/integrated parts, and `low` for entry-level mobile (Adreno 6xx and older,
Mali-T/G5x and similar). The menu shows the detected GPU next to `RENDER QUALITY` and lets you
override it with **auto / low / mid / high**; the choice is stored in `localStorage`.

On the `low` tier every shader compiles a cut-down variant (`#ifdef LOWQ`) with fewer march
steps, one-tap sun transmittance, simpler cloud shading and reduced buffers. The project now
prioritises maximum realism: the `low`/`mid`/`high` budgets were raised (up to 14,000 near-camera
drops, 32×32 rainshaft columns, 96 cloud steps and 2.2 M cloud pixels on `high`), heavy rain
increases precipitation density instead of thinning it, and adaptive degradation only engages on
sustained stalls. The multicell/MCS performance fixes are retained, but frame rate is deliberately
secondary to physical and visual fidelity on mid/low devices. Recovery works on 60 Hz displays as well as high-refresh ones. The `ⓘ`
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

### Cloud, precipitation and lightning visuals

Cloud shape is no longer a direct copy of the 500 m solver cells. The renderer combines the simulated
condensate, ice fraction, rain and updraft with an advected **domain-periodic** Perlin-Worley volume:
6 broad tiles, 32 billow tiles and 128 detail tiles per 32 km domain. Every noise scale divides the
solver box by an integer, so wrapping camera/wind coordinates no longer produces a seam or a sudden
replacement of one cloud structure by another. Coherent low-level bands, upright updraft towers and
flattened ice anvils replace the old uniform noise-blob coverage. Smooth vertical and horizon
extinction replaces the hard 15 km lid / 45 km ray-march box, and the engulfed-camera branch is
continuous instead of a binary switch. A lower history blend prevents obsolete cloud fields from
ghosting back into view; reprojection still suppresses grain. Lighting adds rim-lit silver edges,
darker rainy bases, warmer low-sun tones and a broad flash glow through the whole cloud body.

Precipitation is split into individually sized drops and crystals near the camera and six
fixed-azimuth, wind-sheared planes per distant column that overlap into cylindrical rainshafts
rather than camera-facing billboards. The solver now defaults to `precipEfficiency = 4.2` and
`evaporation = 0.28`, the worker's 8-bit rain channels use a soft-knee companding curve, and
`heavyRain` reaches full strength at 55 mm/h rather than 95 mm/h. Drop, splash and shaft budgets
are roughly doubled, `uPrecipDensity` no longer culls particles during a storm, local rain intensity
uses an exponential response instead of a 45 mm/h linear scale, and fog shortens more under heavy
rain. Distant curtains are wider, brighter and visible from about 20 m out to 28 km: the old
120–650 m near fade that erased shafts directly under the storm has been removed. Shaft noise uses
integer domain tiles, and the obsolete shaft geometry bounding sphere is gone. Drops follow a
skewed size distribution (many small, a few large), fall at size-dependent speeds, drift differently
with wind, and render as tapered teardrops with a refracted highlight rather than uniform white
lines. Frozen particles become six-arm crystals; splashes get irregular crowns and secondary
droplets. The distant veils use advected 3-D noise plus anisotropic falling filaments and soft
multi-lobe edges, so the billboard outline does not read as a grey card.

### Tornadoes, charge separation and intercept vehicle

Tornadogenesis is a **physics-driven parameterization**, not a scripted effect or a nested LES.
`src/sim/tornado.ts` scores the smoothed low-level rotating updraft from the solved vorticity,
convergence and vertical velocity, then combines 2–5 km updraft helicity with a storm-local
0–1 km hodograph (shear and helicity), CAPE, LCL and cold-pool strength. Persistence gates genesis;
the active vortex follows the rotating-updraft maximum and feeds a bounded Rankine tangential wind
plus frictional inflow back into the lowest solver levels before the pressure projection. Core
radius, EF-like 3-second gust, cyclostrophic pressure deficit, condensation-funnel height and debris
load are derived from that state and the simulated cloud base. The renderer adds a wall-cloud
lowering, a helical condensation funnel, a debris annulus, hook-echo rain wrapping and a dry inflow
notch in the rainshafts.

Electrification replaces the old single-coefficient source with `src/sim/charging.ts`: LWC-dependent
Saunders-type charge-sign reversal, collision-rate scaling from graupel/ice and relative fall speed,
inductive charging in the solved vertical field, a relaxed upper-positive / mid-negative /
lower-positive tripole with screening layers, charge carried on both heavy and light hydrometeors,
and conductivity decay. The charge-separation rate, tripole index, upper/mid/lower charge reservoirs
and flash-energy proxy are exposed in the snapshot. A separate `chargeRate` slider scales the whole
electrification system.

Cloud grain is attacked from three directions at once: a mostly static per-pixel ray-march offset
plus reduced temporal jitter, neighbourhood-min/max clamping of the reprojected history, a 16-tap
depth/transmittance-weighted upsample, and a small bilateral radiance filter in the composite. The
fixed step hash no longer varies per frame, fine erosion is damped, and `uDenoise` raises the
history blend while suppressing speckle/flicker/blocky cloud patches. The main history weight is
0.92 rather than 0.955 so a changed condensate snapshot cannot leave a stale formation behind.
The renderer still uses MRT scattering depth for temporal reprojection and edge-aware upsampling.

The intercept vehicle is player-driven (`src/controls.ts`): a bicycle-model truck with throttle,
braking, drag, steering, handbrake, terrain-slope traction limits, suspension roll and a deployable
probe. The solver's vortex state supplies Rankine wind drag, pressure deficit, debris damage and
distance/bearing telemetry. The vehicle mesh, funnel and debris are all rendered with the same sky,
fog, sun and flash lighting as the rest of the scene.

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
npm test -- 2600 16 28 1          # CAPE J/kg, horizontal N, vertical NZ, simulated hours
npm test -- 2600 32 36 4 --eff=2.8 --charge=1
```

Optional flags: `--lake=`, `--land=`, `--spawn=`, `--freeze=`, `--evap=`, `--eff=`, `--charge=`,
`--melt=`, `--precipT=`. The long run now also prints tornado intensity/EF, charge-separation rate
and tripole diagnostics.

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
  Bergeron/WBF, riming, graupel, melting/freezing, evaporation, sedimentation with
  adjustable precipitation efficiency), f-plane Coriolis, LWC-dependent non-inductive/inductive
  charge separation with tripole screening, and dielectric-breakdown-model lightning with branched
  channels.
* **Rendering** — ray-marched clouds with advected Perlin-Worley billows, ice/updraft-aware towers
  and anvils, soft cloud illumination, size-distributed raindrops and snow crystals, wind-sheared
  six-plane cylindrical rainshafts, denoised/reprojected cloud upsampling, helical
  condensation funnel and debris, player-driven intercept vehicle, mitered/tapered lightning
  ribbons, terrain, water and synthesised thunder.

## Notes

* Requires a WebGL2-capable browser (software rendering such as SwiftShader also works).
* The UI has been smoke-tested headlessly in Chromium: the dev server, the production build and
  the standalone file all mount, initialise the worker and render the volumetric scene.
* The terrain and solver are periodic and flat-level; nothing smaller than ~1.5 km is resolved.
  The tornado core is a coupled sub-grid parameterization, not a nested metre-scale LES.
* Realism is prioritised over frame rate: mid/low devices may drop FPS in mature storms. Use
  `?perf=low&noadapt=0` to let the adaptive path recover frames.
* `3d-atmospheric-weather-simulation (2).zip` is the original uploaded archive; the extracted
  sources at the repository root are the working copy.
