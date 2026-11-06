// Broadband radiative heating/cooling for the anelastic core.
//
// Longwave: clear-sky cooling shaped by local relative humidity (dry air loses heat to space
// through the 8-12 um window much faster than humid air), a greenhouse term for condensate
// (strong cooling at cloud top, warming at cloud base), and weak ozone longwave heating near
// the model lid. Shortwave: near-IR water-vapour absorption concentrated in the humid boundary
// layer plus ozone UV/visible heating peaking near the lid, both scaled by solar elevation.
//
// All rates are returned as temperature tendencies [K/s]; the caller converts to theta
// tendency via d(theta) = dT / Pi.
import { G, CP } from './consts';
import { qsl } from './thermo';
import type { Atmosphere } from './atmosphere';
import type { Check } from './thermo';

const DAY = 86400;

/** Clear-sky longwave cooling [K/s] at a level. Observed clear-sky values run ~1 K/day in
 *  humid air and up to ~3 K/day in dry mid/upper levels; ozone adds a little LW heating aloft. */
export function lwClearSky(T: number, p: number, qv: number, z: number): number {
  const qs = qsl(T, p);
  const rh = qs > 1e-9 ? Math.min(1, Math.max(0, qv / qs)) : 1;
  let r = (0.9 + 1.9 * (1 - rh)) / DAY; // 0.9 .. 2.8 K/day of cooling
  if (z > 10500) r -= (0.8 / DAY) * Math.exp(-(z - 12800) / 1800); // ozone LW heating near lid
  return -r;
}

/** Cloud greenhouse term [K/s]: cooling at cloud top, warming at cloud base, scaled by the
 *  layer's condensate optical thickness. Real anvil tops cool at up to ~10 K/day. */
export function lwCloudTerm(tau: number, isTop: boolean, isBase: boolean): number {
  const s = Math.min(1, tau / 0.4); // tau = condensate path proxy [kg/m^2]-ish
  if (isTop && !isBase) return (-7.0 / DAY) * s;
  if (isBase && !isTop) return (2.5 / DAY) * s;
  if (isTop && isBase) return (-3.0 / DAY) * s; // thin isolated cloud: net cooling
  return 0;
}

/** Shortwave atmospheric heating [K/s] for solar elevation sine `sinElev` (<=0 at night). */
export function swHeating(sinElev: number, z: number, qv: number): number {
  if (sinElev <= 0) return 0;
  // near-IR water-vapour bands: strongest where the air is humid and low (boundary layer)
  const wv = (0.5 / DAY) * Math.min(1, (qv * 1000) / 15) * Math.exp(-z / 5500);
  // ozone UV/visible absorption, peaking near the model lid (real stratopause is far higher)
  const oz = z > 10000 ? (1.6 / DAY) * Math.exp(-(z - 13200) / 2200) : 0;
  return sinElev * (wv + oz);
}

/** Fill a.radLw / a.radSw with per-cell temperature tendencies [K/s]. */
export function radiationTendencies(a: Atmosphere, sinElev: number) {
  const { nz, nxy } = a;
  const g = a.g, lw = a.radLw, sw = a.radSw;
  const tauCol = new Float64Array(nz);
  for (let ij = 0; ij < nxy; ij++) {
    // condensate path per layer (liquid + ice + precipitating species all emit/absorb LW)
    for (let k = 0; k < nz; k++) {
      const c = k * nxy + ij;
      tauCol[k] = (a.qc[c] + a.qi[c] + 0.7 * (a.qr[c] + a.qs[c] + a.qg[c])) * a.rhoC[k] * g.dz[k];
    }
    for (let k = 0; k < nz; k++) {
      const c = k * nxy + ij;
      const T = a.th[c] * a.prof.pi[k];
      const p = a.prof.p[k];
      const cloudy = tauCol[k] > 1e-4;
      const above = k < nz - 1 ? tauCol[k + 1] > 1e-4 : false;
      const below = k > 0 ? tauCol[k - 1] > 1e-4 : false;
      lw[c] = lwClearSky(T, p, a.qv[c], g.zc[k]) + (cloudy ? lwCloudTerm(tauCol[k], !above, !below) : 0);
      sw[c] = swHeating(sinElev, g.zc[k], a.qv[c]);
    }
  }
}

/** Clear-sky atmospheric emissivity for the downwelling longwave at the surface (Brutsaert 1975). */
export function surfaceEmissivity(eHpa: number, tK: number, cloudTau: number): number {
  const cs = 1.24 * Math.pow(Math.max(1e-3, eHpa) / Math.max(1, tK), 1 / 7);
  return Math.min(0.985, cs + 0.12 * Math.min(1, cloudTau * 4));
}

export { CP, G };

/** Validation of the radiation building blocks against observed magnitudes. */
export function runRadiationValidation(): Check[] {
  const out: Check[] = [];
  const kday = (r: number) => (-r * DAY).toFixed(2); // report cooling as positive K/day
  // humid boundary layer, T=295 K, p=950 hPa, qv=12 g/kg -> ~1 K/day
  const bl = lwClearSky(295, 95000, 0.012, 500);
  out.push({ name: 'LW clear humid BL', value: kday(bl) + ' K/day', expect: '0.8-1.6', ok: -bl * DAY > 0.8 && -bl * DAY < 1.6 });
  // dry mid-troposphere, T=250 K, p=500 hPa, qv=0.5 g/kg -> ~2.5 K/day
  const mid = lwClearSky(250, 50000, 0.0005, 6000);
  out.push({ name: 'LW clear dry mid', value: kday(mid) + ' K/day', expect: '2.0-3.2', ok: -mid * DAY > 2.0 && -mid * DAY < 3.2 });
  // cloud top with 1 g/kg condensate over 500 m at rho 0.7 -> strong cooling
  const top = lwCloudTerm(0.35, true, false);
  out.push({ name: 'LW cloud top', value: kday(top) + ' K/day', expect: '>4', ok: -top * DAY > 4 });
  // cloud base warming
  const base = lwCloudTerm(0.35, false, true);
  out.push({ name: 'LW cloud base', value: (-base * DAY).toFixed(2) + ' K/day', expect: '>1.5', ok: base * DAY > 1.5 });
  // noon stratospheric ozone heating
  const swOz = swHeating(0.9, 13500, 0.0001);
  out.push({ name: 'SW ozone 13.5km noon', value: (swOz * DAY).toFixed(2) + ' K/day', expect: '>0.8', ok: swOz * DAY > 0.8 });
  // night: no shortwave
  out.push({ name: 'SW night', value: (swHeating(-0.2, 500, 0.012) * DAY).toFixed(2) + ' K/day', expect: '0', ok: swHeating(-0.2, 500, 0.012) === 0 });
  // Brutsaert emissivity at 20 hPa, 295 K -> ~0.84
  const em = surfaceEmissivity(20, 295, 0);
  out.push({ name: 'emis Brutsaert', value: em.toFixed(3), expect: '0.80-0.90', ok: em > 0.8 && em < 0.9 });
  return out;
}
