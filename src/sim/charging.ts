/**
 * Mixed-phase thunderstorm electrification — generation + separation.
 *
 * GENERATION (where charge is created):
 *  - Saunders-type non-inductive graupel/ice rebounding with an LWC-dependent reversal
 *    temperature. The sign carried by GRAUPEL (ice takes the opposite) is physical:
 *
 *      T warmer than the reversal      → NEGATIVE graupel   (main mid-level negative)
 *      T colder than the reversal      → POSITIVE graupel   (cold mixed-phase)
 *      below the freezing level (warm
 *      reversal, T > T0 − 9)           → POSITIVE graupel   (lower positive pocket)
 *
 *  - inductive charging of rebounding particles in the existing vertical field;
 *  - ion attachment at the cloud top: the topmost 700 m relaxes toward a NEGATIVE
 *    screening skin (fair-weather ions of opposite sign drift in and attach).
 *
 * SEPARATION (how the structure forms): NO band-target relaxation exists any more —
 * the tripole is *transported* into place:
 *  - negative graupel sediments with the heavy species → main mid-level negative;
 *  - the ice crystals carry the opposite sign and ride the updraft (they only settle at
 *    their tiny terminal speed relative to the air) → upper positive;
 *  - warm-reversal graupel sits low and falls → lower positive pocket;
 *  - the cold-side negative ice lofted to the top reinforces the screening skin.
 * Charge rides the existing hydrometeor advection + sedimentation and decays with the
 * conductivity profile (micro.ts chargeDecay).
 *
 * This is still a grid-scale bulk parameterization: it does not resolve individual
 * collisions. Diagnostics partition the dynamic bands for the tripole index.
 */
import type { Atmosphere } from './atmosphere';
import { T0 } from './consts';
import { rhoFac, vtGraupel, vtIce } from './micro';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Lumped non-inductive charging coefficient, tuned to give realistic grid-scale E fields. */
const K_NI = 7.0;
const K_IND = 1.0e-9;
const Q_SCREEN = 2.0e-9;
const Q_LIMIT = 5.0e-7;

export interface ChargeDiagnostics {
  sepRate: number;       // C/s over the domain, non-inductive
  inductiveRate: number; // C/s, inductive
  screeningRate: number; // C/s, cloud-top ion screening
  upperPos: number; midNeg: number; lowerPos: number; // C per layer band
  tripole: number;       // 0..1 structural index
  flashEnergy: number;   // proxy J in the separated charge field
}

export function emptyChargeDiagnostics(): ChargeDiagnostics {
  return { sepRate: 0, inductiveRate: 0, screeningRate: 0, upperPos: 0, midNeg: 0, lowerPos: 0, tripole: 0, flashEnergy: 0 };
}

/** Scratch: highest condensate level per column — reused between calls (this runs every step). */
let topScratch: Float32Array | null = null;

export function chargeSeparation(a: Atmosphere, dt: number) {
  const { nz, nxy } = a, g = a.g, rhoC = a.prof.rho, Pi = a.prof.pi;
  const rate = a.params.chargeRate;
  const qh = a.qh, ql = a.ql, qc = a.qc, qi = a.qi, qs = a.qs, qg = a.qg, th = a.th;
  const ez = a.ez, emag = a.emag;
  const area = g.dx * g.dy;
  const kNI = K_NI * rate, kInd = K_IND * rate, qScreen = Q_SCREEN * rate, qLimit = Q_LIMIT * Math.max(0.4, rate);
  let sep = 0, ind = 0, scr = 0, upper = 0, mid = 0, lower = 0;

  // ---- freezing level from the mean profile: diagnostics bands and the warm-reversal
  // pocket hang off this.
  let z0 = 4000, found0 = false;
  for (let k = 1; k < nz; k++) {
    const Ta = a.prof.th[k - 1] * a.prof.pi[k - 1];
    const Tb = a.prof.th[k] * a.prof.pi[k];
    if (Ta > T0 && Tb <= T0) {
      const f = (Ta - T0) / Math.max(1e-6, Ta - Tb);
      z0 = g.zc[k - 1] + (g.zc[k] - g.zc[k - 1]) * f;
      found0 = true;
      break;
    }
  }
  if (!found0) z0 = 4000;
  z0 = clamp(z0, 1500, 7000);

  // ---- per-column cloud top: early-exit scan from the top. Every processed cell has
  // condensate, so colTop[ij] >= z for each of them (same 1e-9 threshold as the main guard).
  if (!topScratch || topScratch.length < nxy) topScratch = new Float32Array(nxy);
  const colTop = topScratch;
  for (let ij = 0; ij < nxy; ij++) {
    let top = 0;
    for (let k = nz - 1; k >= 0; k--) {
      const idx = k * nxy + ij;
      if (qc[idx] + qi[idx] + qs[idx] + qg[idx] > 1e-9) { top = g.zc[k]; break; }
    }
    colTop[ij] = top;
  }

  // Diagnostics partition (upper/mid/lower) — bands follow the freezing level and cloud top.
  const zPosLo = Math.max(z0 + 2200, 5200);

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
      const zTopC = colTop[ij];
      const zMidTop = clamp(Math.min(zPosLo, zTopC - 1100), z0 - 300, zPosLo);

      // 1. Non-inductive charging (mixed phase). Gate widened to just below freezing so the
      //    warm-reversal pocket can form; supercooled liquid is still required.
      if (T < T0 - 1 && T > 233.15 && graupel > 1e-7 && ice > 1e-7 && qc[idx] > 1e-7) {
        // Primary reversal: warmer / high-LWC toward -20 C; dry / cold toward -8 C.
        const Trev = T0 - 12 - 7 * clamp((lwc - 0.35) / 1.8, 0, 1) + 3 * clamp(1 - lwc / 0.6, 0, 1);
        const dT = T - Trev;
        // Sign carried by GRAUPEL (ice takes the opposite). Warm side of the primary
        // reversal → negative graupel (the main mid-level negative, transported down by
        // sedimentation); cold side → positive graupel. Below the freezing level the warm
        // reversal flips graupel positive — the lower positive pocket.
        const warmPocket = z < z0 + 250 && T > T0 - 9;
        const sign = warmPocket ? 1 : (dT >= 0 ? -1 : 1);
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

      // 3. Cloud-top ion screening: the topmost 700 m of each column relaxes toward a
      //    negative skin — fair-weather ions drift in and attach at the storm boundary.
      //    The ion current closes just beneath the skin, so the mirrored positive charge is
      //    deposited in the cell below: screening stays a neutral dipole and cannot starve
      //    the domain of positive charge (a one-sided sink left the storm 70 C net-negative
      //    and the Poisson solve with nothing positive to work with).
      if (z >= zTopC - 700) {
        const target = -qScreen * 1.15 * clamp((qi[idx] + qs[idx]) / 3e-4, 0, 1.3);
        const cur = qh[idx] + ql[idx];
        const delta = (target - cur) * Math.min(1, dt / 240);
        const heavyShare = 0.7;
        qh[idx] += delta * heavyShare;
        ql[idx] += delta * (1 - heavyShare);
        scr += Math.abs(delta) * vol;
        if (k > 0 && delta !== 0) {
          const ib = idx - nxy;
          if (qc[ib] + qi[ib] + qs[ib] + qg[ib] > 1e-9) {
            const mirror = -delta * 0.85;
            qh[ib] += mirror * 0.6;
            ql[ib] += mirror * 0.4;
          }
        }
      }

      qh[idx] = clamp(qh[idx], -qLimit, qLimit);
      ql[idx] = clamp(ql[idx], -qLimit, qLimit);

      // Diagnostics partition the same dynamic bands; the screening skin is excluded so it
      // does not pollute the tripole index (it is not part of the dipole/tripole structure).
      const q = qh[idx] + ql[idx];
      if (z >= zTopC - 700) { /* screening skin — deliberately uncounted */ }
      else if (z > zMidTop) { if (q > 0) upper += q * vol; }
      else if (z > z0 - 500) { if (q < 0) mid += -q * vol; }
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
