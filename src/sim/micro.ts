// Bulk cloud microphysics (6 water species, Kessler warm-rain + Lin/Rutledge-style cold-rain simplifications),
// sedimentation, non-inductive charge separation and charge relaxation. All phase changes release/absorb latent heat in theta.
import type { Atmosphere } from './atmosphere';
import { CP, LV, LF, LS, RV, T0 } from './consts';
import { qsl, qsi } from './thermo';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export const rhoFac = (rho: number) => Math.min(1.8, Math.sqrt(1.2 / rho));
export const vtRain = (rhoq: number, rf: number) => Math.min(9.5, 0.4 + 4.6 * Math.pow(rhoq * 1000, 0.2)) * rf;
export const vtSnow = (rf: number) => 0.9 * rf;
export const vtGraupel = (rhoq: number, rf: number) => Math.min(14, 3.5 + 4 * Math.pow(rhoq * 1000, 0.3)) * rf;
export const vtIce = (rf: number) => 0.12 * rf;

export const K_NI = 4e-4; // effective non-inductive charging coefficient [C m^3 kg^-2 ... lumped]

export function microphysics(a: Atmosphere, dt: number) {
  const { nz, nxy } = a;
  const th = a.th, qv = a.qv, qc = a.qc, qi = a.qi, qr = a.qr, qs = a.qs, qg = a.qg, qh = a.qh, ql = a.ql;
  a.colHydro.fill(0);
  a.tauCol.fill(0);
  let anyH = false;
  for (let k = 0; k < nz; k++) {
    const Pi = a.prof.pi[k], p = a.prof.p[k], rho = a.prof.rho[k], dzk = a.g.dz[k];
    const rf = rhoFac(rho);
    const LFc = LF / CP;
    for (let ij = 0; ij < nxy; ij++) {
      const idx = k * nxy + ij;
      let tqv = qv[idx], tqc = qc[idx], tqi = qi[idx], tqr = qr[idx], tqs = qs[idx], tqg = qg[idx];
      let T = th[idx] * Pi;
      const cond = tqc + tqi + tqr + tqs + tqg;
      if (cond < 1e-12) {
        if (T > 233.15) { if (tqv <= qsl(T, p)) continue; }
        else if (tqv <= 1.05 * qsi(T, p)) continue;
      }
      // 1. melting
      if (T > T0) {
        if (tqi > 0) { tqc += tqi; T -= LFc * tqi; tqi = 0; }
        const f = Math.min(1, ((T - T0) * dt) / 90);
        let ms = tqs * f, mg = tqg * f;
        const lim = (0.9 * (T - T0)) / LFc;
        if (ms + mg > lim) { const s = lim / (ms + mg); ms *= s; mg *= s; }
        tqr += ms + mg; tqs -= ms; tqg -= mg; T -= LFc * (ms + mg);
      } else {
        // 2. freezing: homogeneous (< -38C), immersion/contact, rain freezing
        if (tqc > 0 && T < 233.15) { tqi += tqc; T += LFc * tqc; tqc = 0; }
        if (tqc > 1e-8 && T < T0 - 4) {
          const x = (T0 - T - 4) / 10;
          const fr = tqc * (1 - Math.exp(-dt * 4e-4 * x * x));
          tqc -= fr; tqi += fr; T += LFc * fr;
        }
        if (tqr > 1e-9 && T < T0 - 2) {
          const x = (T0 - T) / 10;
          const fr = T < 243.15 ? tqr : tqr * (1 - Math.exp(-dt * 1e-3 * x * x));
          tqr -= fr; tqg += fr; T += LFc * fr;
        }
        // 3. ice nucleation (needs supercooled liquid / ice supersaturation) then deposition growth (WBF) / sublimation
        const qsiV = qsi(T, p);
        if (T < T0 - 5 && tqv > qsiV && (tqc > 1e-6 || tqv > 1.08 * qsiV)) {
          const nuc = Math.min(dt * 3e-8 * Math.exp(0.25 * (T0 - T - 5)), 6e-7, tqv - qsiV);
          tqv -= nuc; tqi += nuc; T += (LS / CP) * nuc;
        }
        // vapour deposition on ice: weighted by available particle surface (crystals >> snow >> graupel)
        const wi = tqi, ws = 0.5 * tqs, wg = 0.04 * tqg, wsum = wi + ws + wg;
        const qI = tqi + tqs + tqg;
        if (qI > 1e-10) {
          const lam = 0.1 * Math.sqrt(1000 * rho * wsum);
          let dq = (tqv - qsiV) * (1 - Math.exp(-lam * dt));
          dq /= 1 + (LS * LS * qsiV) / (CP * RV * T * T);
          if (dq > 0 && wsum > 0) {
            tqv -= dq; tqi += (dq * wi) / wsum; tqs += (dq * ws) / wsum; tqg += (dq * wg) / wsum; T += (LS / CP) * dq;
          } else if (dq < 0) {
            const sub = Math.min(-dq, qI * 0.9);
            const s2 = sub / qI;
            tqv += sub; tqi -= tqi * s2; tqs -= tqs * s2; tqg -= tqg * s2; T -= (LS / CP) * sub;
          }
        }
      }
      // 5. saturation adjustment (liquid above -38C; ice-saturation limited below)
      if (T >= 233.15) {
        for (let it = 0; it < 2; it++) {
          const q = qsl(T, p);
          let dq = (tqv - q) / (1 + (LV * LV * q) / (CP * RV * T * T));
          if (dq < 0) dq = -Math.min(-dq, tqc);
          tqv -= dq; tqc += dq; T += (LV / CP) * dq;
        }
      } else {
        const q = qsi(T, p);
        if (tqv > 1.05 * q) {
          const dq = (tqv - q) / (1 + (LS * LS * q) / (CP * RV * T * T));
          tqv -= dq; tqi += dq; T += (LS / CP) * dq;
        }
      }
      // 6. collision-coalescence (autoconversion + accretion)
      if (tqc > 1e-9) {
        const auto = tqc > 5e-4 ? 1.2e-3 * (tqc - 5e-4) : 0;
        const accr = tqr > 1e-9 ? 2.2 * tqc * Math.pow(tqr, 0.875) : 0;
        const conv = Math.min(tqc, dt * (auto + accr));
        tqc -= conv; tqr += conv;
      }
      // 7. cold-rain: aggregation, riming (snow->graupel), accretion
      if (T < T0) {
        if (tqi > 2e-4) { const au = Math.min(tqi, dt * 1e-3 * (tqi - 2e-4)); tqi -= au; tqs += au; }
        if (tqs > 1e-8 && tqi > 1e-8) { const ac = Math.min(tqi, dt * 0.8 * tqi * Math.pow(tqs, 0.6)); tqi -= ac; tqs += ac; }
        if (tqc > 1e-8) {
          const rs = tqs > 1e-8 ? dt * 0.35 * tqc * Math.pow(tqs, 0.75) : 0;
          const rg = tqg > 1e-8 ? dt * 0.5 * tqc * Math.pow(tqg, 0.75) : 0;
          let tot = rs + rg, sc = 1;
          if (tot > 0.9 * tqc) sc = (0.9 * tqc) / tot;
          const rs2 = rs * sc, rg2 = rg * sc; tot *= sc;
          tqc -= tot; tqs += 0.4 * rs2; tqg += 0.6 * rs2 + rg2; T += LFc * tot;
        }
      }
      // 8. rain evaporation below cloud base / in dry air (strong source of evaporative cooling)
      if (tqr > 1e-9) {
        const q = qsl(T, p);
        if (tqv < q) {
          const rr = rho * tqr;
          let ev = (((1.6 + 124.9 * Math.pow(rr, 0.2046)) * Math.pow(rr, 0.525)) / (2.55e8 / (p * q) + 5.4e5)) * ((q - tqv) / (rho * q));
          ev *= 3;
          const lim = (q - tqv) / (1 + (LV * LV * q) / (CP * RV * T * T));
          const e = Math.min(ev * dt, tqr, lim);
          tqr -= e; tqv += e; T -= (LV / CP) * e;
        }
      }
      // non-inductive charge separation (graupel-ice rebounding collisions in supercooled liquid)
      if (T < T0 - 2 && tqg > 1e-6 && tqi + 0.3 * tqs > 1e-7 && tqc > 1e-6) {
        const rhoqg = rho * tqg, rhoqi = rho * (tqi + 0.3 * tqs);
        const vrel = Math.max(1.5, vtGraupel(rhoqg, rf) - 0.4);
        const fL = Math.min(1, (rho * tqc * 1000) / 0.8);
        const fT = clamp((T0 - T - 2) / 8, 0, 1) * clamp((T - 233.15) / 12, 0, 1);
        const dq = (K_NI * rhoqg * rhoqi * vrel * fL * fT * dt) / rho;
        const sgn = T > T0 - 12 ? 1 : -1; // reversal temperature ~ -12C
        qh[idx] += sgn * dq; ql[idx] -= sgn * dq;
      }
      qv[idx] = tqv < 0 ? 0 : tqv; qc[idx] = tqc < 0 ? 0 : tqc; qi[idx] = tqi < 0 ? 0 : tqi;
      qr[idx] = tqr < 0 ? 0 : tqr; qs[idx] = tqs < 0 ? 0 : tqs; qg[idx] = tqg < 0 ? 0 : tqg;
      th[idx] = T / Pi;
      const c2 = tqc + tqi + tqr + tqs + tqg;
      if (c2 > 1e-10) {
        a.colHydro[ij] = 1; anyH = true;
        a.tauCol[ij] += rho * dzk * (tqc * 150 + tqi * 40 + tqs * 8);
      }
    }
  }
  a.anyHydro = anyH;
}

/** Gravitational settling (upwind, sub-cycled) of rain, snow, graupel, ice and the charge carried by heavy hydrometeors. */
export function sedimentation(a: Atmosphere, dt: number) {
  const { nz, nxy } = a;
  const vtr = a.colA, vts = a.colB, vtg = a.colC, vti = a.colD, vth = a.colE;
  const rhoC = a.prof.rho, dz = a.g.dz;
  let precipKg = 0, iceKg = 0;
  for (let ij = 0; ij < nxy; ij++) {
    if (!a.colHydro[ij]) { a.surfPrec[ij] = 0; continue; }
    let any = 0;
    for (let k = 0; k < nz; k++) {
      const idx = k * nxy + ij, rho = rhoC[k], rf = rhoFac(rho);
      const qr = a.qr[idx], qs = a.qs[idx], qg = a.qg[idx];
      vtr[k] = qr > 1e-9 ? vtRain(rho * qr, rf) : 0;
      vts[k] = qs > 1e-9 ? vtSnow(rf) : 0;
      vtg[k] = qg > 1e-9 ? vtGraupel(rho * qg, rf) : 0;
      vti[k] = a.qi[idx] > 1e-9 ? vtIce(rf) : 0;
      const hs = qr + qs + qg;
      vth[k] = hs > 1e-9 ? (qr * vtr[k] + qs * vts[k] + qg * vtg[k]) / hs : 0;
      if (hs > 0 || a.qi[idx] > 0) any = 1;
    }
    if (!any) { a.surfPrec[ij] = 0; continue; }
    const gr = sedCol(a, a.qr, ij, vtr, dt);
    const gs = sedCol(a, a.qs, ij, vts, dt);
    const gg = sedCol(a, a.qg, ij, vtg, dt);
    sedCol(a, a.qi, ij, vti, dt);
    sedCol(a, a.qh, ij, vth, dt);
    const g = gr + gs + gg;
    a.surfPrec[ij] = g / dt;
    precipKg += g; iceKg += gs + gg;
    void rhoC; void dz;
  }
  const area = a.g.dx * a.g.dy;
  a.precipCum += precipKg * area;
  a.iceGroundCum += iceKg * area;
}

function sedCol(a: Atmosphere, q: Float32Array, ij: number, vt: Float32Array, dt: number): number {
  const { nz, nxy } = a;
  const dz = a.g.dz, rho = a.prof.rho;
  let cmax = 0;
  for (let k = 0; k < nz; k++) { const c = (vt[k] * dt) / dz[k]; if (c > cmax) cmax = c; }
  if (cmax <= 0) return 0;
  const ns = Math.max(1, Math.ceil(cmax / 0.8));
  const dts = dt / ns;
  let ground = 0;
  for (let s = 0; s < ns; s++) {
    for (let k = 0; k < nz; k++) {
      const idx = k * nxy + ij;
      const v = q[idx];
      if (v === 0 || vt[k] === 0) continue;
      const frac = Math.min(0.95, (vt[k] * dts) / dz[k]);
      const dq = v * frac;
      q[idx] = v - dq;
      if (k > 0) q[idx - nxy] += (dq * rho[k] * dz[k]) / (rho[k - 1] * dz[k - 1]);
      else ground += dq * rho[0] * dz[0];
    }
  }
  return ground;
}

/** Charge relaxation: air conductivity grows with height; charge on vanished hydrometeors leaks away quickly. */
export function chargeDecay(a: Atmosphere, dt: number) {
  const { nz, nxy } = a;
  let mx = 0;
  for (let k = 0; k < nz; k++) {
    const lam0 = 1.1e-3 * Math.exp(a.g.zc[k] / 6000);
    for (let ij = 0; ij < nxy; ij++) {
      const idx = k * nxy + ij;
      let h = a.qh[idx], l = a.ql[idx];
      if (h === 0 && l === 0) continue;
      const hv = a.qr[idx] + a.qg[idx] + a.qs[idx];
      const li = a.qi[idx] + a.qs[idx];
      h *= Math.exp(-(lam0 + 0.03 * (1 - Math.min(1, hv / 3e-5))) * dt);
      l *= Math.exp(-(lam0 + 0.03 * (1 - Math.min(1, li / 3e-5))) * dt);
      if (Math.abs(h) < 1e-17) h = 0;
      if (Math.abs(l) < 1e-17) l = 0;
      a.qh[idx] = h; a.ql[idx] = l;
      const m = Math.abs(h) + Math.abs(l);
      if (m > mx) mx = m;
      if (m > 1e-16) a.colHydro[ij] = 1;
    }
  }
  a.chargeMax = mx;
}
