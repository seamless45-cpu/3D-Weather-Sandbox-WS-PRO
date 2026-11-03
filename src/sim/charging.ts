/**
 * Mixed-phase thunderstorm electrification.
 *
 * Replaces the old single-coefficient, single-reversal-temperature source with:
 *  - Saunders-type non-inductive graupel/ice rebounding charging whose sign-reversal
 *    temperature depends on liquid water content and whose rate depends on collision
 *    kinetic energy, supercooled liquid, ice and graupel concentrations;
 *  - inductive charging of rebounding particles in the existing vertical electric field;
 *  - a relaxed tripole/screening structure (upper positive ice, mid-level negative
 *    graupel, lower positive warm mixed-phase pocket);
 *  - charge carried on heavy and light hydrometeors, sedimented and decayed by the existing
 *    conductivity profile.
 *
 * This is still a grid-scale bulk parameterization: it does not resolve individual collisions.
 */
import type { Atmosphere } from './atmosphere';
import { T0 } from './consts';
import { rhoFac, vtGraupel, vtIce } from './micro';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Lumped non-inductive charging coefficient, tuned to give realistic grid-scale E fields. */
const K_NI = 7.5e-4;
const K_IND = 2.2e-10;
const Q_SCREEN = 2.4e-9;
const Q_LIMIT = 5.0e-7;

export interface ChargeDiagnostics {
  sepRate: number;       // C/s over the domain, non-inductive
  inductiveRate: number; // C/s, inductive
  screeningRate: number; // C/s, screening/tripole relaxation
  upperPos: number; midNeg: number; lowerPos: number; // C per layer band
  tripole: number;       // 0..1 structural index
  flashEnergy: number;   // proxy J in the separated charge field
}

export function emptyChargeDiagnostics(): ChargeDiagnostics {
  return { sepRate: 0, inductiveRate: 0, screeningRate: 0, upperPos: 0, midNeg: 0, lowerPos: 0, tripole: 0, flashEnergy: 0 };
}

export function chargeSeparation(a: Atmosphere, dt: number) {
  const { nz, nxy } = a, g = a.g, rhoC = a.prof.rho, Pi = a.prof.pi;
  const rate = a.params.chargeRate;
  const qh = a.qh, ql = a.ql, qc = a.qc, qi = a.qi, qs = a.qs, qg = a.qg, th = a.th;
  const ez = a.ez, emag = a.emag;
  const area = g.dx * g.dy;
  const kNI = K_NI * rate, kInd = K_IND * rate, qScreen = Q_SCREEN * rate, qLimit = Q_LIMIT * Math.max(0.4, rate);
  let sep = 0, ind = 0, scr = 0, upper = 0, mid = 0, lower = 0;
  for (let k = 0; k < nz; k++) {
    const rho = rhoC[k], rf = rhoFac(rho), z = g.zc[k];
    for (let ij = 0; ij < nxy; ij++) {
      const idx = k * nxy + ij;
      const cond = qc[idx] + qi[idx] + qs[idx] + qg[idx];
      if (cond < 1e-9) continue;
      const T = th[idx] * Pi[k];
      const lwc = rho * qc[idx] * 1000;                 // g/m3
      const ice = qi[idx] + 0.35 * qs[idx];
      const graupel = qg[idx];
      const vol = area * g.dz[k] * rho;

      // 1. Non-inductive charging in the mixed-phase region (-5 to -38 C).
      if (T < T0 - 5 && T > 233.15 && graupel > 1e-7 && ice > 1e-7 && qc[idx] > 1e-7) {
        // Warmer / high-LWC reversal moves toward -20 C; dry / cold toward -8 C.
        const Trev = T0 - 12 - 7 * clamp((lwc - 0.35) / 1.8, 0, 1) + 3 * clamp(1 - lwc / 0.6, 0, 1);
        const dT = T - Trev;
        const sign = dT >= 0 ? 1 : -1;
        const thermal = clamp(Math.abs(dT) / 11, 0.08, 1) * clamp((T - 233.15) / 12, 0, 1) * clamp((T0 - 5 - T) / 9, 0, 1);
        const liquid = clamp(lwc / 1.1, 0, 1);
        const vrel = Math.max(1.2, vtGraupel(rho * graupel, rf) - vtIce(rf));
        // Collision rate ~ rho_g * rho_i * relative fall speed; rebound probability rises with vrel.
        const collision = rho * graupel * rho * ice * vrel * clamp(vrel / 8, 0.15, 1);
        const dq = clamp((kNI * collision * liquid * thermal * dt) / rho, -4e-9 * rate, 4e-9 * rate) * sign;
        qh[idx] += dq; ql[idx] -= dq;
        sep += Math.abs(dq) * vol;
      }

      // 2. Inductive charging: a pre-existing field polarises colliding graupel/ice pairs.
      const E = ez[idx], Emag = emag[idx];
      if (Math.abs(E) > 2e3 && Emag > 2e3 && graupel > 1e-7 && ice > 1e-7) {
        const dq = clamp(kInd * (E / 1e5) * graupel * ice * rho * dt * 1e4, -2e-9 * rate, 2e-9 * rate);
        qh[idx] += dq; ql[idx] -= dq;
        ind += Math.abs(dq) * vol;
      }

      // 3. Tripole / screening-layer structure. Charge is tied to existing hydrometeors,
      //    so clear air never generates field; the relaxation time is a few minutes.
      let target = 0;
      if (z > 8000 && (qi[idx] + qs[idx]) > 1e-7) target = qScreen * clamp((qi[idx] + qs[idx]) / 3e-4, 0, 1.4);
      else if (z > 4200 && z <= 8000 && graupel > 1e-7) target = -qScreen * 1.45 * clamp(graupel / 3e-4, 0, 1.4);
      else if (z > 1200 && z <= 4200 && graupel > 1e-7 && T > T0 - 14) target = qScreen * 0.85 * clamp(graupel / 3e-4, 0, 1.4);
      if (target !== 0) {
        const cur = qh[idx] + ql[idx];
        const delta = (target - cur) * Math.min(1, dt / 240);
        const heavyShare = target < 0 ? 0.72 : 0.58;
        qh[idx] += delta * heavyShare;
        ql[idx] += delta * (1 - heavyShare);
        scr += Math.abs(delta) * vol;
      }

      qh[idx] = clamp(qh[idx], -qLimit, qLimit);
      ql[idx] = clamp(ql[idx], -qLimit, qLimit);
      const q = qh[idx] + ql[idx];
      if (z > 8000 && q > 0) upper += q * vol;
      else if (z > 4200 && q < 0) mid += -q * vol;
      else if (z > 1200 && q > 0) lower += q * vol;
    }
  }
  const total = upper + mid + lower + 1e-9;
  const tripole = clamp((upper + lower) / total, 0, 1) * clamp(mid / total, 0, 1) * 4;
  a.chargeDiag = {
    sepRate: sep, inductiveRate: ind, screeningRate: scr,
    upperPos: upper, midNeg: mid, lowerPos: lower,
    tripole: clamp(tripole, 0, 1),
    flashEnergy: 0.5 * total * Math.pow(Math.max(0, a.stats.maxE || 0) / 1e5, 2),
  };
}
