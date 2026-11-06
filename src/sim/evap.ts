// Reworked bulk evaporation / sublimation of precipitating hydrometeors.
//
// One coherent scheme for all precipitating species, built from the two-resistance
// (vapour-diffusion + heat-conduction) bulk limit of Pruppacher & Klett (1997), as used in
// cloud-resolving models (Kessler 1969 liquid form; the same structure over ice with L_s):
//
//   E = (q_s - q_v) / [ rho_a * ( L^2 q_s / (k_a R_v T^2) + R_d T / (D_v e_s) ) ] * N_a(r)
//
// collapsed into the standard bulk coefficients, then ventilation-corrected by the terminal
// fall speed (larger/faster drops ventilate harder, so they evaporate faster), scaled by the
// user's evaporation multiplier, and capped by the thermodynamic budget (latent heat must
// come from somewhere — the cap is what couples evaporation to cold-pool cooling).
import { CP, LV, LS, RV } from './consts';
import { qsl, qsi } from './thermo';

/** Bulk rain evaporation rate [kg/kg/s, positive = evaporating]. */
export function rainEvapRate(T: number, p: number, qv: number, qr: number, rho: number, vt: number, evapMul: number): number {
  if (qr <= 0) return 0;
  const qs = qsl(T, p);
  if (qv >= qs) return 0;
  const rr = rho * qr; // kg/m^3
  // Ventilation: Re^1/2 correction, Re ~ vt * D_drop / nu with a representative 2 mm drop.
  const vent = 1 + 0.42 * Math.sqrt(Math.max(0, vt) * 0.002 / 1.5e-5);
  const denom = 2.55e8 / (p * qs) + 5.4e5;                 // thermodynamic resistance [s/m-ish]
  let ev = ((1.6 + 124.9 * Math.pow(rr, 0.2046)) * Math.pow(rr, 0.525)) / denom * ((qs - qv) / (rho * qs));
  ev *= vent * 2.2 * evapMul;
  // Latent-heat budget: cannot evaporate more than the saturation deficit can absorb.
  const lim = (qs - qv) / (1 + (LV * LV * qs) / (CP * RV * T * T));
  return Math.min(ev, lim);
}

/** Bulk snow/graupel sublimation rate [kg/kg/s, positive = sublimating] over ice. */
export function iceSublimRate(T: number, p: number, qv: number, qiMass: number, rho: number, vt: number, evapMul: number): number {
  if (qiMass <= 0) return 0;
  const qs = qsi(T, p);
  if (qv >= qs) return 0;
  const rr = rho * qiMass;
  const vent = 1 + 0.38 * Math.sqrt(Math.max(0, vt) * 0.001 / 1.5e-5);
  // over ice: larger L_s and lower e_s -> different (larger) resistance
  const denom = 2.83e8 / (p * qs) + 5.4e5;
  let ev = ((1.6 + 124.9 * Math.pow(rr, 0.2046)) * Math.pow(rr, 0.525)) / denom * ((qs - qv) / (rho * qs));
  ev *= vent * 2.2 * evapMul;
  const lim = (qs - qv) / (1 + (LS * LS * qs) / (CP * RV * T * T));
  return Math.min(ev, lim);
}
