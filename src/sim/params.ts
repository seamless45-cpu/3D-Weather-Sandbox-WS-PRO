/**
 * User-facing simulation parameters. Everything the old "environment presets" used to bundle is now
 * a continuous control, and the microphysics rates are exposed directly.
 */
export interface SimParams {
  /** Potential-evaporation multiplier over open water (lakes/rivers). 1 = physical baseline. */
  lakeEvap: number;
  /** Potential-evaporation multiplier over land (soil moisture limited). */
  landEvap: number;
  /** Target surface-based CAPE of the environment sounding [J/kg]. */
  cape: number;
  /** Droplet (CCN) concentration factor: >1 = more, smaller droplets (slower warm-rain). */
  dropletSpawn: number;
  /** Freezing rate multiplier (immersion/contact freezing, rain freezing). */
  freezing: number;
  /** Rain evaporation/sublimation rate multiplier. */
  evaporation: number;
  /** Warm-rain collision/coalescence and riming efficiency multiplier. */
  precipEfficiency: number;
  /** Non-inductive/inductive electrification rate multiplier. */
  chargeRate: number;
  /** Melting rate multiplier. */
  melting: number;
  /** Precipitation-type threshold [°C]: below this, precipitation is treated as frozen. */
  precipTempC: number;
}

export const DEFAULT_PARAMS: SimParams = {
  lakeEvap: 1.35,
  landEvap: 0.8,
  cape: 2600,
  dropletSpawn: 1,
  freezing: 1,
  evaporation: 0.28,
  precipEfficiency: 4.2,
  chargeRate: 1,
  melting: 1,
  precipTempC: 1,
};

export interface ParamSpec {
  key: keyof SimParams;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  hint: string;
}

/** Single source of truth for the UI sliders (order = display order). */
export const PARAM_SPECS: ParamSpec[] = [
  { key: 'cape', label: 'CAPE', unit: 'J/kg', min: 0, max: 12000, step: 50, decimals: 0, hint: 'surface instability: the fuel for convection' },
  { key: 'lakeEvap', label: 'Lake evaporation', unit: '×', min: 0.1, max: 12, step: 0.05, decimals: 2, hint: 'moisture supplied by lakes and rivers' },
  { key: 'landEvap', label: 'Land evaporation', unit: '×', min: 0.05, max: 12, step: 0.05, decimals: 2, hint: 'evapotranspiration from soil and vegetation' },
  { key: 'dropletSpawn', label: 'Droplet spawn', unit: '×', min: 0.2, max: 12, step: 0.05, decimals: 2, hint: 'CCN concentration: more, smaller droplets → slower rain' },
  { key: 'freezing', label: 'Freezing rate', unit: '×', min: 0.1, max: 12, step: 0.05, decimals: 2, hint: 'supercooled water → ice / rain → graupel' },
  { key: 'evaporation', label: 'Evaporation rate', unit: '×', min: 0.1, max: 12, step: 0.05, decimals: 2, hint: 'rain evaporating below cloud base (cold pools, virga)' },
  { key: 'chargeRate', label: 'Charge separation', unit: '×', min: 0.1, max: 12, step: 0.05, decimals: 2, hint: 'mixed-phase charging, inductive charging and screening layers' },
  { key: 'melting', label: 'Melting rate', unit: '×', min: 0.1, max: 12, step: 0.05, decimals: 2, hint: 'snow/graupel melting below the 0 °C level' },
  { key: 'precipTempC', label: 'Precipitation threshold', unit: '°C', min: -20, max: 20, step: 0.5, decimals: 1, hint: 'below this temperature precipitation falls as snow/hail' },
];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Clamp/normalise arbitrary input into a valid parameter set. */
export function clampParams(p: Partial<SimParams>): SimParams {
  const d = DEFAULT_PARAMS;
  const num = (v: unknown, fb: number) => (typeof v === 'number' && isFinite(v) ? v : fb);
  return {
    lakeEvap: clamp(num(p.lakeEvap, d.lakeEvap), 0.1, 12),
    landEvap: clamp(num(p.landEvap, d.landEvap), 0.05, 12),
    cape: clamp(num(p.cape, d.cape), 0, 12000),
    dropletSpawn: clamp(num(p.dropletSpawn, d.dropletSpawn), 0.2, 12),
    freezing: clamp(num(p.freezing, d.freezing), 0.1, 12),
    evaporation: clamp(num(p.evaporation, d.evaporation), 0.1, 12),
    precipEfficiency: clamp(num(p.precipEfficiency, d.precipEfficiency), 0.2, 6),
    chargeRate: clamp(num(p.chargeRate, d.chargeRate), 0.1, 12),
    melting: clamp(num(p.melting, d.melting), 0.1, 12),
    precipTempC: clamp(num(p.precipTempC, d.precipTempC), -20, 20),
  };
}
