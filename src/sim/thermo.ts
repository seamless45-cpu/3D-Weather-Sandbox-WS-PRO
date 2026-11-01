import { G, RD, CP, LV, EPS, P00, KAPPA, Grid } from './consts';

// ---------- saturation thermodynamics ----------
export const esl = (T: number) => 611.2 * Math.exp((17.67 * (T - 273.15)) / (T - 29.65)); // Bolton (1980)
export const esi = (T: number) => 611.2 * Math.exp((22.46 * (T - 273.15)) / (T - 0.53)); // Magnus over ice
export const qsl = (T: number, p: number) => { const e = Math.min(esl(T), 0.5 * p); return (EPS * e) / (p - e); };
export const qsi = (T: number, p: number) => { const e = Math.min(esi(T), 0.5 * p); return (EPS * e) / (p - e); };
export const exner = (p: number) => Math.pow(p / P00, KAPPA);
export function dewpoint(q: number, p: number) {
  const e = Math.max(1e-3, (q * p) / (EPS + q));
  const a = Math.log(e / 611.2);
  return (29.65 * a - 17.67 * 273.15) / (a - 17.67);
}

// ---------- environment sounding ----------
// There is no preset list any more: the initial sounding is generated from the CAPE control so a
// requested instability is actually reproduced by the profile the model relaxes toward.
export interface Environment {
  cape: number; // SBCAPE realised by this sounding [J/kg]
  thSfc: number; thTr: number; qvMax: number; capD: number; capZ: number; midDry: number;
  shearType: 'uni' | 'curved'; shear: number; shearZ: number; u0: number; v0: number; nocturnal: number;
}

const BASE_ENV: Omit<Environment, 'cape'> = {
  thSfc: 299.0, thTr: 344, qvMax: 0.0145, capD: 0.6, capZ: 1750, midDry: 0.15,
  shearType: 'uni', shear: 12, shearZ: 4500, u0: 1, v0: 1, nocturnal: 3.5,
};

/** SBCAPE of a sounding on this grid. */
export function soundingCape(g: Grid, env: Environment): number {
  const p = buildProfile(g, env);
  return parcelAscent(p.z, p.p, p.T, p.qv, 'SB').cape;
}

/**
 * Build the environment that realises `capeTarget` J/kg of surface-based CAPE.
 * A cap is added when little instability is asked for (so low values really stay suppressed) and
 * the boundary layer is warmed/moistened when more is asked for; a short bisection nails the target.
 */
export function envForCape(g: Grid, capeTarget: number): Environment {
  const t = Math.max(0, Math.min(4000, isFinite(capeTarget) ? capeTarget : 2000));
  // a cap keeps low instability settings genuinely suppressed
  const capD = 0.6 + Math.max(0, (700 - t) / 110);
  // one knob scales a physically sane boundary layer: 296..305.6 K, 10..21.7 g/kg
  const make = (m: number): Environment => ({
    ...BASE_ENV,
    cape: t,
    capD,
    thSfc: 296 + m * 6,
    qvMax: 0.010 + m * 0.0072,
  });
  let lo = 0, hi = 1.6;
  let best = make(0.8), bestErr = Infinity, bestCape = 0;
  const cLo = soundingCape(g, make(lo)), cHi = soundingCape(g, make(hi));
  if (cHi < t) lo = hi;            // even the most unstable profile is not enough
  else if (cLo > t) hi = lo;       // already unstable enough at the driest/coolest setting
  for (let i = 0; i < 16; i++) {
    const m = 0.5 * (lo + hi);
    const env = make(m);
    const cape = soundingCape(g, env);
    const err = Math.abs(cape - t);
    if (err < bestErr) { bestErr = err; best = env; bestCape = cape; }
    if (cape < t) lo = m; else hi = m;
  }
  return { ...best, cape: bestCape };
}

export interface Profile {
  n: number; z: Float64Array; th: Float64Array; qv: Float64Array; u: Float64Array; v: Float64Array;
  p: Float64Array; rho: Float64Array; pi: Float64Array; T: Float64Array; thv: Float64Array;
  rhoF: Float64Array; pSfc: number;
}

function windAt(z: number, pr: Environment): [number, number] {
  const f = Math.min(1, z / pr.shearZ);
  const after = Math.max(0, z - pr.shearZ) / 9000;
  if (pr.shearType === 'uni') {
    const r = 0.5 * (1 - Math.cos(Math.PI * f));
    return [pr.u0 + pr.shear * r + 0.25 * pr.shear * after, pr.v0 + 0.18 * pr.shear * r];
  }
  const a = (Math.PI / 2) * f;
  const U = pr.shear / Math.SQRT2;
  return [pr.u0 + U * (1 - Math.cos(a)) + 0.3 * U * after, pr.v0 + U * Math.sin(a) + 0.15 * U * after];
}

export function thetaProfile(z: number, pr: Environment, ztr = 12000, Ttr = 213): number {
  let th: number;
  if (z <= ztr) th = pr.thSfc + (pr.thTr - pr.thSfc) * Math.pow(z / ztr, 1.25);
  else th = pr.thTr * Math.exp((G / (CP * Ttr)) * (z - ztr));
  th += pr.capD * (0.5 * (1 + Math.tanh((z - pr.capZ) / 170)));
  th -= pr.nocturnal * Math.exp(-z / 260);
  return th;
}

export function buildProfile(g: Grid, pr: Environment): Profile {
  const n = g.nz, zc = g.zc;
  const th = new Float64Array(n), qv = new Float64Array(n), u = new Float64Array(n), v = new Float64Array(n);
  const p = new Float64Array(n), rho = new Float64Array(n), pi = new Float64Array(n), T = new Float64Array(n), thv = new Float64Array(n);
  const pSfc = 98000, ztr = 12000;
  for (let k = 0; k < n; k++) {
    th[k] = thetaProfile(zc[k], pr);
    const w = windAt(zc[k], pr); u[k] = w[0]; v[k] = w[1];
    p[k] = pSfc * Math.exp(-zc[k] / 8000);
  }
  for (let it = 0; it < 4; it++) {
    for (let k = 0; k < n; k++) {
      T[k] = th[k] * exner(p[k]);
      const z = zc[k];
      let rh = z < ztr ? 1 - 0.75 * Math.pow(z / ztr, 1.25) : 0.25;
      rh *= 1 - pr.midDry * Math.exp(-Math.pow((z - 5000) / 2200, 2));
      qv[k] = Math.min(pr.qvMax, rh * qsl(T[k], p[k]));
      thv[k] = th[k] * (1 + 0.61 * qv[k]);
    }
    let Pi = Math.pow(pSfc / P00, KAPPA) - (G * zc[0]) / (CP * thv[0]);
    pi[0] = Pi;
    for (let k = 1; k < n; k++) {
      Pi -= (G * (zc[k] - zc[k - 1])) / (CP * 0.5 * (thv[k] + thv[k - 1]));
      pi[k] = Pi;
    }
    for (let k = 0; k < n; k++) p[k] = P00 * Math.pow(pi[k], 1 / KAPPA);
  }
  for (let k = 0; k < n; k++) rho[k] = p[k] / (RD * thv[k] * pi[k]);
  const rhoF = new Float64Array(n + 1);
  for (let k = 1; k < n; k++) { const f = (g.zf[k] - zc[k - 1]) / (zc[k] - zc[k - 1]); rhoF[k] = rho[k - 1] * (1 - f) + rho[k] * f; }
  rhoF[0] = rho[0] + (rho[0] - rho[1]) * (zc[0] / (zc[1] - zc[0]));
  rhoF[n] = Math.max(0.02, rho[n - 1] - (rho[n - 2] - rho[n - 1]) * ((g.zf[n] - zc[n - 1]) / (zc[n - 1] - zc[n - 2])));
  return { n, z: zc, th, qv, u, v, p, rho, pi, T, thv, rhoF, pSfc };
}

// ---------- parcel theory: CAPE, CIN, LCL, LFC, EL ----------
export interface ParcelResult { cape: number; cin: number; lcl: number; lfc: number; el: number; }
export type ParcelType = 'SB' | 'ML' | 'MU';

/** Lift a parcel (dry adiabat to LCL, then pseudo-adiabat) through an environment given at levels z[]. Virtual-temperature buoyancy. */
export function parcelAscent(z: ArrayLike<number>, p: ArrayLike<number>, T: ArrayLike<number>, qv: ArrayLike<number>,
  type: ParcelType, tparOut?: Float32Array): ParcelResult {
  const n = z.length;
  let k0 = 0;
  let Tp = T[0], r = qv[0];
  const ps = p[0];
  if (type === 'ML') {
    let ths = 0, rs = 0, c = 0;
    for (let k = 0; k < n && p[k] > ps - 10000; k++) { ths += T[k] * Math.pow(P00 / p[k], KAPPA); rs += qv[k]; c++; }
    Tp = (ths / c) * Math.pow(ps / P00, KAPPA); r = rs / c;
  } else if (type === 'MU') {
    let best = -1;
    for (let k = 0; k < n && p[k] > ps - 30000; k++) {
      const the = T[k] * Math.pow(P00 / p[k], KAPPA) * Math.exp((LV * qv[k]) / (CP * T[k]));
      if (the > best) { best = the; k0 = k; }
    }
    Tp = T[k0]; r = qv[k0];
  }
  if (tparOut) tparOut.fill(NaN);
  let sat = false; let lcl = NaN, lfc = NaN, el = NaN;
  let cape = 0, cin = 0, found = false, done = false;
  if (r >= qsl(Tp, p[k0])) { sat = true; lcl = z[k0]; }
  if (tparOut) tparOut[k0] = Tp;
  for (let k = k0 + 1; k < n; k++) {
    const nsub = Math.max(1, Math.ceil((z[k] - z[k - 1]) / 60));
    const h = (z[k] - z[k - 1]) / nsub;
    for (let s = 0; s < nsub; s++) {
      const f = (s + 1) / nsub;
      const zz = z[k - 1] + h * (s + 1);
      const pp = Math.exp(Math.log(p[k - 1]) * (1 - f) + Math.log(p[k]) * f);
      if (!sat) {
        Tp -= (G / CP) * h;
        const q = qsl(Tp, pp);
        if (r >= q) { sat = true; lcl = zz; }
      }
      if (sat) {
        const rs = qsl(Tp, pp);
        const gam = (G * (1 + (LV * rs) / (RD * Tp))) / (CP + (LV * LV * rs * EPS) / (RD * Tp * Tp));
        Tp -= gam * h;
        r = qsl(Tp, pp);
      }
      const Te = T[k - 1] * (1 - f) + T[k] * f;
      const qe = qv[k - 1] * (1 - f) + qv[k] * f;
      const Tvp = Tp * (1 + 0.61 * r), Tve = Te * (1 + 0.61 * qe);
      const B = (G * (Tvp - Tve)) / Tve;
      if (!done) {
        if (!found) {
          if (B > 0 && sat) { found = true; lfc = Math.max(isNaN(lcl) ? zz : lcl, zz - h); cape += B * h; el = zz; }
          else if (B < 0) cin += B * h;
        } else if (B > 0) { cape += B * h; el = zz; }
        else if (zz > lfc + 200) done = true;
      }
    }
    if (tparOut) tparOut[k] = Tp;
  }
  if (!found) { cape = 0; }
  return { cape, cin, lcl, lfc: found ? lfc : NaN, el: found ? el : NaN };
}

// ---------- validation against standard meteorological definitions ----------
export interface Check { name: string; value: string; expect: string; ok: boolean; }
export function runValidation(): Check[] {
  const out: Check[] = [];
  const rel = (a: number, b: number) => Math.abs(a - b) / b;
  out.push({ name: 'es(0C)', value: esl(273.15).toFixed(1) + ' Pa', expect: '611.2', ok: rel(esl(273.15), 611.2) < 0.005 });
  out.push({ name: 'es(20C)', value: esl(293.15).toFixed(0) + ' Pa', expect: '2339', ok: rel(esl(293.15), 2339) < 0.015 });
  out.push({ name: 'es(100C)', value: esl(373.15).toFixed(0) + ' Pa', expect: '101325', ok: rel(esl(373.15), 101325) < 0.04 });
  // LCL (Espy/Bolton) on a standard 6.5 K/km atmosphere
  const nn = 160; const z = new Float64Array(nn), p = new Float64Array(nn), T = new Float64Array(nn), q = new Float64Array(nn);
  for (let k = 0; k < nn; k++) {
    z[k] = 50 + k * 100; T[k] = 303.15 - 0.0065 * z[k];
    p[k] = 100000 * Math.pow(T[k] / 303.15, G / (RD * 0.0065));
  }
  const pe = 100000, Td = 293.15, e = esl(Td), r0 = (EPS * e) / (pe - e);
  for (let k = 0; k < nn; k++) q[k] = r0 * Math.min(1, Math.pow(p[k] / pe, 1.2));
  q[0] = r0;
  const res = parcelAscent(z, p, T, q, 'SB');
  const Tl = 1 / (1 / (Td - 56) + Math.log(303.15 / Td) / 800) + 56;
  const zl = ((303.15 - Tl) / 9.76) * 1000;
  out.push({ name: 'LCL T=30,Td=20', value: res.lcl.toFixed(0) + ' m', expect: `~${zl.toFixed(0)} (Bolton)`, ok: rel(res.lcl, zl) < 0.1 });
  // Weisman-Klemp (1982) analytic sounding
  const wk: Environment = { cape: 2200, thSfc: 300, thTr: 343, qvMax: 0.014, capD: 0, capZ: 1e5, midDry: 0, shearType: 'uni', shear: 0, shearZ: 1000, u0: 0, v0: 0, nocturnal: 0 };
  const zz = new Float64Array(120), pp = new Float64Array(120), TT = new Float64Array(120), qq = new Float64Array(120);
  const th = new Float64Array(120), thv = new Float64Array(120);
  for (let k = 0; k < 120; k++) { zz[k] = 50 + k * 125; pp[k] = 98000 * Math.exp(-zz[k] / 8000); }
  for (let it = 0; it < 5; it++) {
    for (let k = 0; k < 120; k++) {
      th[k] = thetaProfile(zz[k], wk); TT[k] = th[k] * exner(pp[k]);
      const rh = zz[k] < 12000 ? 1 - 0.75 * Math.pow(zz[k] / 12000, 1.25) : 0.25;
      qq[k] = Math.min(0.014, rh * qsl(TT[k], pp[k])); thv[k] = th[k] * (1 + 0.61 * qq[k]);
    }
    let Pi = Math.pow(98000 / P00, KAPPA) - (G * zz[0]) / (CP * thv[0]); pp[0] = P00 * Math.pow(Pi, 1 / KAPPA);
    for (let k = 1; k < 120; k++) { Pi -= (G * (zz[k] - zz[k - 1])) / (CP * 0.5 * (thv[k] + thv[k - 1])); pp[k] = P00 * Math.pow(Pi, 1 / KAPPA); }
  }
  const w = parcelAscent(zz, pp, TT, qq, 'SB');
  out.push({ name: 'WK82 SBCAPE', value: w.cape.toFixed(0) + ' J/kg', expect: '1600-3000 (WK82 ~2200)', ok: w.cape > 1600 && w.cape < 3000 });
  out.push({ name: 'WK82 EL', value: (w.el / 1000).toFixed(1) + ' km', expect: '11-13 km', ok: w.el > 10500 && w.el < 13500 });
  return out;
}
