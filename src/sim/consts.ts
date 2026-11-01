// Physical constants and grid definition (SI units throughout)
export const G = 9.80665;
export const RD = 287.04;
export const RV = 461.5;
export const CP = 1004.6;
export const LV = 2.5e6;
export const LF = 3.34e5;
export const LS = LV + LF;
export const P00 = 1.0e5;
export const KAPPA = RD / CP;
export const EPS = RD / RV;
export const T0 = 273.15;
export const SIGMA = 5.670374e-8;
export const EPS0 = 8.854e-12;

export const DOMAIN = 32000; // horizontal periodic domain edge length [m]
export const ZTOP = 15000; // model lid [m]

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  dy: number;
  zf: Float64Array; // face heights (nz+1)
  zc: Float64Array; // centre heights (nz)
  dz: Float64Array; // cell thickness (nz)
  dzf: Float64Array; // centre-to-centre distance across face k (nz+1)
}

/** Horizontally uniform, vertically stretched grid (fine near ground, coarse aloft). */
export function makeGrid(n: number, nz: number): Grid {
  const dx = DOMAIN / n;
  const mean = ZTOP / nz;
  const a = 0.35 * mean;
  const b = (2 * (ZTOP - nz * a)) / (nz * (nz - 1));
  const zf = new Float64Array(nz + 1);
  const zc = new Float64Array(nz);
  const dz = new Float64Array(nz);
  const dzf = new Float64Array(nz + 1);
  for (let k = 0; k < nz; k++) {
    dz[k] = a + b * k;
    zf[k + 1] = zf[k] + dz[k];
    zc[k] = zf[k] + dz[k] / 2;
  }
  dzf[0] = zc[0];
  for (let k = 1; k < nz; k++) dzf[k] = zc[k] - zc[k - 1];
  dzf[nz] = zf[nz] - zc[nz - 1];
  return { nx: n, ny: n, nz, dx, dy: dx, zf, zc, dz, dzf };
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
