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
let diag: { field: DiagField; mode: 'h' | 'v'; level: number } = { field: 'w', mode: 'h', level: 6 };
let budget = 0, lastT = 0, lastSnap = 0, simAdv = 0, realAcc = 0, actualSpeed = 0, stepMs = 0;
let capeM: ReturnType<typeof capeMap> | null = null;
let lastCape = -1;
let windOff = new Float32Array(32);
let lastSnapSimTime = 0;
let emptyTex = false;
let layerK0 = new Int32Array(NZR), layerW = new Float32Array(NZR);

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

function buildClouds(a: Atmosphere): Uint8Array {
  const { nx, ny, nxy } = a;
  const out = new Uint8Array(nx * ny * NZR * 4);
  if (!a.anyHydro) { emptyTex = true; return out; }
  emptyTex = false;
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  for (let ij = 0; ij < nxy; ij++) {
    if (!a.colHydro[ij]) continue;
    for (let m = 0; m < NZR; m++) {
      const k0 = layerK0[m], f = layerW[m];
      const c0 = k0 * nxy + ij, c1 = c0 + nxy;
      const g = (arr: Float32Array) => arr[c0] * (1 - f) + arr[c1] * f;
      const qc = g(a.qc), qi = g(a.qi), qs = g(a.qs), qr = g(a.qr), qg = g(a.qg);
      const cond = qc + qi + 0.25 * qs;
      const pr = qr + 0.6 * qg + 0.15 * qs;
      if (cond < 1e-7 && pr < 1e-7) continue;
      const w = 0.25 * (a.w[c0] + a.w[c0 + nxy]) * (1 - f) + 0.25 * (a.w[c1] + a.w[c1 + nxy]) * f + 0;
      const o = (m * nxy + ij) * 4;
      out[o] = Math.round(255 * cl(cond / 0.0035));
      out[o + 1] = Math.round(255 * cl(pr / 0.004));
      out[o + 2] = Math.round(255 * cl((qi + qs + qg) / (qc + qi + qs + qg + 1e-9)));
      out[o + 3] = Math.round(255 * cl(0.5 + (2 * w) / 30));
    }
  }
  return out;
}

function buildSurf(a: Atmosphere): Uint8Array {
  const { nxy } = a;
  const out = new Uint8Array(nxy * 4);
  let mean = 0;
  for (let ij = 0; ij < nxy; ij++) mean += a.th[ij];
  mean /= nxy;
  for (let ij = 0; ij < nxy; ij++) {
    out[ij * 4] = Math.round(255 * Math.min(1, a.soilM[ij]));
    out[ij * 4 + 1] = Math.min(255, Math.round(a.rainRate[ij] * 5));
    out[ij * 4 + 2] = Math.min(255, Math.round((a.surfW[ij] / 3) * 255));
    out[ij * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (mean - a.th[ij]) / 4)));
  }
  return out;
}

function updateWindOffsets(a: Atmosphere, dtSim: number) {
  const { nxy } = a;
  const B = 16;
  const sw = new Float64Array(B), su = new Float64Array(B), sv = new Float64Array(B);
  if (a.anyHydro) {
    for (let k = 0; k < a.nz; k++) {
      const b = Math.min(B - 1, Math.floor((a.g.zc[k] / ZTOP) * B));
      for (let ij = 0; ij < nxy; ij++) {
        if (!a.colHydro[ij]) continue;
        const c = k * nxy + ij;
        const w = a.qc[c] + a.qi[c] + 0.25 * a.qs[c];
        if (w > 1e-6) { sw[b] += w; su[b] += w * a.uc0[c]; sv[b] += w * a.vc0[c]; }
      }
    }
  }
  for (let b = 0; b < B; b++) {
    const k = Math.min(a.nz - 1, Math.floor((b + 0.5) / B * a.nz));
    const u = sw[b] > 1e-4 ? su[b] / sw[b] : a.prof.u[k];
    const v = sw[b] > 1e-4 ? sv[b] / sw[b] : a.prof.v[k];
    windOff[b * 2] += u * dtSim; windOff[b * 2 + 1] += v * dtSim;
  }
}

function snapshot(forceDiag = false) {
  const a = atm!;
  const ci = Math.min(a.nx - 1, Math.max(0, Math.floor(cam.x / a.g.dx))), cj = Math.min(a.ny - 1, Math.max(0, Math.floor(cam.z / a.g.dy)));
  updateWindOffsets(a, a.time - lastSnapSimTime); lastSnapSimTime = a.time;
  const cloud = buildClouds(a);
  const surf = buildSurf(a);
  const snd = localSounding(a, ci, cj);
  if (a.step_n - lastCape >= 8 || !capeM) { capeM = capeMap(a); lastCape = a.step_n; }
  const mode = stormMode(a, snd);
  a.stats.maxCape = capeM.max;
  const d = diagSlice(a, diag.field, diag.mode, diag.level, ci, cj, capeM);
  void forceDiag;
  const ij = cj * a.nx + ci;
  const sfcU = 0.5 * (a.u[ij] + a.u[cj * a.nx + (ci + 1) % a.nx]), sfcV = 0.5 * (a.v[ij] + a.v[((cj + 1) % a.ny) * a.nx + ci]);
  const msg = {
    type: 'snap', time: a.time, speed: actualSpeed, stepMs, dt: a.dt, paused,
    cloud, surf, windOff: windOff.slice(), stats: { ...a.stats }, sounding: snd, mode, capeMean: capeM.mean, capeMax: capeM.max,
    diag: d, local: { u: sfcU, v: sfcV, rain: a.rainRate[ij], T: snd.surfT, rh: snd.surfRH, tau: snd.tauColumn, wetness: a.soilM[ij], surfW: a.surfW[ij] },
    sunSin: a.sunSin, empty: emptyTex, snowLevel: precipTypeHeight(a), params: a.params, envCape: a.env.cape,
  };
  ctx.postMessage(msg, [cloud.buffer, surf.buffer, d.data.buffer, d.ua.buffer, d.va.buffer]);
}

function loop() {
  const now = performance.now();
  if (atm) {
    const realDt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    if (!paused) {
      budget += realDt * speed;
      const t0 = performance.now();
      let n = 0;
      while (budget >= atm.dt && performance.now() - t0 < 45) {
        const s0 = performance.now();
        atm.step();
        stepMs = 0.9 * stepMs + 0.1 * (performance.now() - s0);
        budget -= atm.dt; simAdv += atm.dt; n++;
        if (atm.flashEvents.length) {
          for (const e of atm.flashEvents) ctx.postMessage({ type: 'flash', event: e }, [e.segs.buffer]);
          atm.flashEvents.length = 0;
        }
      }
      if (budget > atm.dt * 2) budget = atm.dt;
      void n;
      realAcc += realDt;
      if (realAcc > 1) { actualSpeed = simAdv / realAcc; simAdv = 0; realAcc = 0; }
    }
    if (now - lastSnap > 110) { lastSnap = now; snapshot(); }
  }
  setTimeout(loop, 3);
}

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      const terr = new Terrain(256);
      const params: SimParams = clampParams(m.params || DEFAULT_PARAMS);
      atm = new Atmosphere(m.n, m.nz, params, terr, m.seed || 7);
      setupLayers(atm);
      windOff = new Float32Array(32);
      lastSnapSimTime = atm.time; capeM = null;
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
    case 'cam': cam = { x: m.x, z: m.z }; break;
    case 'diag': diag = { field: m.field, mode: m.mode, level: m.level }; break;
    case 'reset': {
      if (!atm) break;
      atm.reset(m.params ? clampParams(m.params) : atm.params);
      windOff = new Float32Array(32); lastSnapSimTime = atm.time; capeM = null; budget = 0;
      ctx.postMessage({ type: 'reset', params: atm.params, envCape: atm.env.cape });
      break;
    }
  }
};
