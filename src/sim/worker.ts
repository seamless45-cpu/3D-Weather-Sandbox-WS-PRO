/// <reference lib="webworker" />
import { Atmosphere } from './atmosphere';
import { runValidation } from './thermo';
import { DEFAULT_PARAMS, SimParams, clampParams } from './params';
import { Terrain } from './terrain';
import { DOMAIN, ZTOP, T0 } from './consts';
import { localSounding, capeMap, stormMode, diagSlice, DiagField } from './diagnostics';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const NZR = 48; // layers of the uniform-height cloud texture sent to the renderer

let atm: Atmosphere | null = null;
let paused = false, speed = 30;
let cam = { x: DOMAIN / 2, z: DOMAIN / 2 };
let diag: { field: DiagField; mode: 'h' | 'v'; level: number; enabled: boolean } = { field: 'w', mode: 'h', level: 6, enabled: false };
let budget = 0, lastT = 0, lastSnap = 0, simAdv = 0, realAcc = 0, actualSpeed = 0, stepMs = 0, lastStepMs = 0;
let capeM: ReturnType<typeof capeMap> | null = null;
let lastCape = -1, lastCapeReal = 0, capeStride = 4;
let lastFlashPost = 0;
let showCharges = false;
let windOff = new Float32Array(32);
let lastSnapSimTime = 0;
let emptyTex = false;
let cloudBytes = 0, surfBytes = 0;
let layerK0 = new Int32Array(NZR), layerW = new Float32Array(NZR);

// Snapshot buffers are recycled by the main thread after the GPU copy. A storm used to allocate
// and transfer ~800 kB of cloud texture plus diagnostics four times a second, causing GC hitches.
const cloudPool: ArrayBuffer[] = [], surfPool: ArrayBuffer[] = [];
const windW = new Float64Array(16), windU = new Float64Array(16), windV = new Float64Array(16);

function takeBuffer(pool: ArrayBuffer[], bytes: number): ArrayBuffer {
  while (pool.length) {
    const b = pool.pop()!;
    if (b.byteLength === bytes) return b;
  }
  return new ArrayBuffer(bytes);
}

/** Height of the user's precipitation-type threshold (below it, precipitation falls frozen). */
function precipTypeHeight(a: Atmosphere): number {
  const thresh = T0 + a.params.precipTempC;
  const T = a.prof.T, z = a.prof.z;
  for (let k = 1; k < a.nz; k++) {
    if (T[k] < thresh) {
      if (T[k - 1] === T[k]) return z[k];
      const f = (T[k - 1] - thresh) / (T[k - 1] - T[k]);
      return z[k - 1] + f * (z[k] - z[k - 1]);
    }
  }
  return ZTOP;
}

function setupLayers(a: Atmosphere) {
  for (let m = 0; m < NZR; m++) {
    const z = ((m + 0.5) * ZTOP) / NZR;
    let k = 0;
    while (k < a.nz - 2 && a.g.zc[k + 1] < z) k++;
    layerK0[m] = k;
    layerW[m] = Math.min(1, Math.max(0, (z - a.g.zc[k]) / (a.g.zc[k + 1] - a.g.zc[k])));
  }
}

/** Build the renderer's RGBA cloud volume. Clamped arrays remove four clamp+round calls per texel. */
function buildClouds(a: Atmosphere): Uint8ClampedArray {
  const { nxy } = a;
  const out = new Uint8ClampedArray(takeBuffer(cloudPool, cloudBytes));
  out.fill(0);
  if (!a.anyHydro) { emptyTex = true; return out; }
  emptyTex = false;
  const qc = a.qc, qi = a.qi, qs = a.qs, qr = a.qr, qg = a.qg, w = a.w, col = a.colHydro;
  for (let ij = 0; ij < nxy; ij++) {
    if (!col[ij]) continue;
    for (let m = 0; m < NZR; m++) {
      const k0 = layerK0[m], f = layerW[m], inv = 1 - f;
      const c0 = k0 * nxy + ij, c1 = c0 + nxy;
      const vqc = qc[c0] * inv + qc[c1] * f;
      const vqi = qi[c0] * inv + qi[c1] * f;
      const vqs = qs[c0] * inv + qs[c1] * f;
      const vqr = qr[c0] * inv + qr[c1] * f;
      const vqg = qg[c0] * inv + qg[c1] * f;
      const cond = vqc + vqi + 0.25 * vqs;
      const pr = vqr + 0.6 * vqg + 0.15 * vqs;
      if (cond < 1e-7 && pr < 1e-7) continue;
      const vw = 0.25 * (w[c0] + w[c0 + nxy]) * inv + 0.25 * (w[c1] + w[c1 + nxy]) * f;
      const o = (m * nxy + ij) * 4;
      out[o] = 255 * (cond / 0.0035);
      // Companding keeps the 8-bit precipitation channel monotonic through violent rain/hail
      // cores instead of clipping everything above ~4 g/kg to the same value.
      out[o + 1] = 255 * (1 - Math.exp(-pr / 0.0055));
      out[o + 2] = 255 * ((vqi + vqs + vqg) / (vqc + vqi + vqs + vqg + 1e-9));
      out[o + 3] = 255 * (0.5 + (2 * vw) / 30);
    }
  }
  return out;
}

function buildSurf(a: Atmosphere): Uint8ClampedArray {
  const { nxy } = a;
  const out = new Uint8ClampedArray(takeBuffer(surfPool, surfBytes));
  let mean = 0;
  for (let ij = 0; ij < nxy; ij++) mean += a.th[ij];
  mean /= nxy;
  for (let ij = 0; ij < nxy; ij++) {
    out[ij * 4] = 255 * a.soilM[ij];
    // Soft-knee encoding: 25 mm/h ~0.43, 80 mm/h ~0.83, 150 mm/h ~0.96.
    out[ij * 4 + 1] = 255 * (1 - Math.exp(-a.rainRate[ij] / 45));
    out[ij * 4 + 2] = (a.surfW[ij] / 3) * 255;
    out[ij * 4 + 3] = 255 * ((mean - a.th[ij]) / 4);
  }
  return out;
}

/**
 * Decimated charge-particle field for the show-charges toggle: one point per significant
 * charge pocket riding on hydrometeors, 5 floats each (x, y, z, signed magnitude, phase).
 * Built only while the toggle is on, so the normal snapshot stays lean.
 */
function buildCharges(a: Atmosphere): Float32Array {
  const { nx, nz, nxy } = a;
  const g = a.g;
  const qh = a.qh, ql = a.ql;
  const cellOk = (c: number, q: number) =>
    q !== 0 && a.qc[c] + a.qi[c] + a.qs[c] + a.qg[c] + a.qr[c] > 1e-7;
  // Pass 1: count pockets and find the peak |q| so the magnitude scale adapts to storm stage.
  let count = 0, maxQ = 1e-12;
  for (let k = 0; k < nz; k++) for (let ij = 0; ij < nxy; ij++) {
    const c = k * nxy + ij;
    const q = qh[c] + ql[c];
    if (!cellOk(c, q)) continue;
    const aq = Math.abs(q);
    if (aq < 2e-10) continue;
    count++; if (aq > maxQ) maxQ = aq;
  }
  const MAXCH = 6000;
  const stride = Math.max(1, Math.ceil(count / MAXCH));
  const out = new Float32Array(Math.ceil(count / stride) * 5);
  let n = 0, seen = 0;
  for (let k = 0; k < nz && n * 5 < out.length; k++) {
    for (let ij = 0; ij < nxy && n * 5 < out.length; ij++) {
      const c = k * nxy + ij;
      const q = qh[c] + ql[c];
      if (!cellOk(c, q)) continue;
      const aq = Math.abs(q);
      if (aq < 2e-10) continue;
      if ((seen++ % stride) !== 0) continue;
      const i = ij % nx, j = (ij / nx) | 0;
      const o = n * 5;
      out[o] = (i + 0.15 + 0.7 * Math.random()) * g.dx;
      out[o + 1] = g.zc[k];
      out[o + 2] = (j + 0.15 + 0.7 * Math.random()) * g.dy;
      out[o + 3] = (q > 0 ? 1 : -1) * Math.min(1, aq / maxQ);
      out[o + 4] = Math.random();
      n++;
    }
  }
  return out.subarray(0, n * 5);
}

function updateWindOffsets(a: Atmosphere, dtSim: number) {
  const { nxy } = a;
  const B = 16;
  windW.fill(0); windU.fill(0); windV.fill(0);
  if (a.anyHydro) {
    for (let k = 0; k < a.nz; k++) {
      const b = Math.min(B - 1, Math.floor((a.g.zc[k] / ZTOP) * B));
      for (let ij = 0; ij < nxy; ij++) {
        if (!a.colHydro[ij]) continue;
        const c = k * nxy + ij;
        const w = a.qc[c] + a.qi[c] + 0.25 * a.qs[c];
        if (w > 1e-6) { windW[b] += w; windU[b] += w * a.uc0[c]; windV[b] += w * a.vc0[c]; }
      }
    }
  }
  for (let b = 0; b < B; b++) {
    const k = Math.min(a.nz - 1, Math.floor((b + 0.5) / B * a.nz));
    const u = windW[b] > 1e-4 ? windU[b] / windW[b] : a.prof.u[k];
    const v = windW[b] > 1e-4 ? windV[b] / windW[b] : a.prof.v[k];
    // Deliberately NOT wrapped: windOffAt() interpolates between these bands, and bands that
    // each wrap into [0, DOMAIN) independently straddle the 32 km seam — the mix then lands
    // tens of kilometres off and every crossing shifts the cloud layers. The shader's texture
    // wraps naturally, so unbounded offsets are both correct and invisible.
    windOff[b * 2] += u * dtSim;
    windOff[b * 2 + 1] += v * dtSim;
  }
}

function snapshot() {
  const a = atm!;
  const ci = Math.min(a.nx - 1, Math.max(0, Math.floor(cam.x / a.g.dx))), cj = Math.min(a.ny - 1, Math.max(0, Math.floor(cam.z / a.g.dy)));
  updateWindOffsets(a, a.time - lastSnapSimTime); lastSnapSimTime = a.time;
  const cloud = buildClouds(a);
  const surf = buildSurf(a);
  const snd = localSounding(a, ci, cj);
  // CAPE parcels are the most expensive per-column diagnostic. Four-times decimation and a
  // real-time throttle keep a 64x64 storm from running ~600k saturation solves every few steps.
  const nowReal = performance.now();
  if (!capeM || (nowReal - lastCapeReal > 2500 && a.step_n - lastCape >= 8)) {
    capeM = capeMap(a, capeStride); lastCape = a.step_n; lastCapeReal = nowReal;
  }
  const mode = stormMode(a, snd);
  a.stats.maxCape = capeM.max;
  const d = diag.enabled ? diagSlice(a, diag.field, diag.mode, diag.level, ci, cj, capeM) : null;
  const ij = cj * a.nx + ci;
  const sfcU = 0.5 * (a.u[ij] + a.u[cj * a.nx + (ci + 1) % a.nx]), sfcV = 0.5 * (a.v[ij] + a.v[((cj + 1) % a.ny) * a.nx + ci]);
  const msg: any = {
    type: 'snap', time: a.time, speed: actualSpeed, stepMs, dt: a.dt, paused,
    cloud, surf, windOff: windOff.slice(), stats: { ...a.stats }, sounding: snd, mode, capeMean: capeM.mean, capeMax: capeM.max,
    diag: d, local: { u: sfcU, v: sfcV, rain: a.rainRate[ij], T: snd.surfT, rh: snd.surfRH, tau: snd.tauColumn, wetness: a.soilM[ij], surfW: a.surfW[ij] },
    tornado: a.tornado.snapshot(cam.x, cam.z), charge: { ...a.chargeDiag },
    heavyRain: Math.min(1, a.stats.maxRain / 55),
    sunSin: a.sunSin, empty: emptyTex, snowLevel: precipTypeHeight(a), params: a.params, envCape: a.env.cape,
  };
  const transfer: Transferable[] = [cloud.buffer as ArrayBuffer, surf.buffer as ArrayBuffer];
  if (d) transfer.push(d.data.buffer as ArrayBuffer, d.ua.buffer as ArrayBuffer, d.va.buffer as ArrayBuffer);
  if (showCharges) {
    const ch = buildCharges(a);
    if (ch.length) { msg.charges = ch; transfer.push(ch.buffer as ArrayBuffer); }
  }
  ctx.postMessage(msg, transfer);
}

/** Keep the nearest flash from a burst; the solver still handles every breakdown event. */
function postFlashEvents() {
  const events = atm!.flashEvents;
  if (!events.length) return;
  const nowReal = performance.now();
  if (nowReal - lastFlashPost > 180) {
    let pick = events[0], bestD2 = Infinity;
    for (const e of events) {
      const x = ((e.init[0] % DOMAIN) + DOMAIN) % DOMAIN;
      const z = ((e.init[2] % DOMAIN) + DOMAIN) % DOMAIN;
      let dx = Math.abs(x - cam.x), dz = Math.abs(z - cam.z);
      dx = Math.min(dx, DOMAIN - dx); dz = Math.min(dz, DOMAIN - dz);
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; pick = e; }
    }
    ctx.postMessage({ type: 'flash', event: pick }, [pick.segs.buffer as ArrayBuffer]);
    lastFlashPost = nowReal;
  }
  events.length = 0;
}

function loop() {
  const now = performance.now();
  if (atm) {
    const realDt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    if (!paused) {
      budget += realDt * speed;
      const t0 = performance.now();
      while (budget >= atm.dt && performance.now() - t0 < 25) {
        const s0 = performance.now();
        atm.step();
        lastStepMs = performance.now() - s0;
        stepMs = 0.9 * stepMs + 0.1 * lastStepMs;
        budget -= atm.dt; simAdv += atm.dt;
      }
      if (budget > atm.dt * 2) budget = atm.dt;
      postFlashEvents();
      realAcc += realDt;
      if (realAcc > 1) { actualSpeed = simAdv / realAcc; simAdv = 0; realAcc = 0; }
    }
    // Under a heavy storm each step can exceed the 25 ms work budget; coarsen snapshots so the
    // worker still has time to answer controls and return recycled buffers.
    const snapInterval = stepMs > 35 || lastStepMs > 50 ? 350 : 250;
    if (now - lastSnap > snapInterval) { lastSnap = now; snapshot(); }
  }
  setTimeout(loop, 8);
}

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      const terr = new Terrain(256);
      const params: SimParams = clampParams(m.params || DEFAULT_PARAMS);
      atm = new Atmosphere(m.n, m.nz, params, terr, m.seed || 7);
      setupLayers(atm);
      cloudBytes = atm.nxy * NZR * 4; surfBytes = atm.nxy * 4;
      cloudPool.length = 0; surfPool.length = 0;
      windOff = new Float32Array(32);
      lastSnapSimTime = atm.time; capeM = null; lastCape = -1; lastCapeReal = 0; lastFlashPost = 0;
      ctx.postMessage({
        type: 'ready',
        info: { n: atm.nx, nz: atm.nz, zf: Array.from(atm.g.zf), zc: Array.from(atm.g.zc), NZR, domain: DOMAIN, ztop: ZTOP, params: atm.params, envCape: atm.env.cape },
        checks: runValidation(),
      });
      lastT = performance.now();
      loop();
      break;
    }
    case 'params': {
      if (!atm) break;
      const p = atm.setParams(m.params || {});
      capeM = null;
      ctx.postMessage({ type: 'params', params: p, envCape: atm.env.cape });
      break;
    }
    case 'cfg': if (m.paused !== undefined) paused = m.paused; if (m.speed !== undefined) speed = m.speed; break;
    case 'charges': showCharges = !!m.enabled; break;
    case 'cam': cam = { x: m.x, z: m.z }; break;
    case 'diag': {
      const nextStride = m.field === 'cape' ? 2 : 4;
      if (nextStride !== capeStride) { capeStride = nextStride; capeM = null; lastCape = -1; }
      diag = { field: m.field, mode: m.mode, level: m.level, enabled: m.enabled !== false };
      break;
    }
    case 'recycle': {
      if (m.cloud?.byteLength === cloudBytes && cloudPool.length < 3) cloudPool.push(m.cloud as ArrayBuffer);
      if (m.surf?.byteLength === surfBytes && surfPool.length < 3) surfPool.push(m.surf as ArrayBuffer);
      break;
    }
    case 'reset': {
      if (!atm) break;
      atm.reset(m.params ? clampParams(m.params) : atm.params);
      atm.flashEvents.length = 0;
      windOff = new Float32Array(32); lastSnapSimTime = atm.time; capeM = null; lastCape = -1; lastCapeReal = 0;
      lastFlashPost = 0; budget = 0; stepMs = 0; lastStepMs = 0;
      ctx.postMessage({ type: 'reset', params: atm.params, envCape: atm.env.cape });
      break;
    }
  }
};
