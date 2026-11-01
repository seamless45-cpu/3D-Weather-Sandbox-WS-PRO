// CPU mirror of the GLSL single-scattering sky model: used to derive sun colour, ambient light and haze colours.
export type V3 = [number, number, number];
const BR: V3 = [5.8e-6, 13.5e-6, 33.1e-6];
const BM = 21e-6;
export const SKY_SCALE = 14;

function airMass(cy: number) {
  cy = Math.max(cy, 0);
  const zen = (Math.acos(Math.min(1, cy)) * 180) / Math.PI;
  return 1 / (cy + 0.15 * Math.pow(Math.max(93.885 - zen, 1), -1.253));
}

export function sunTransmittance(sunY: number): V3 {
  const sam = sunY > 0 ? airMass(sunY) : 40 + (-sunY) * 400;
  return [0, 1, 2].map((i) => Math.exp(-(BR[i] * 8000 + BM * 1320) * sam)) as V3;
}

export function skyRadiance(dir: V3, sun: V3): V3 {
  const cy = Math.max(dir[1], 0);
  const am = airMass(cy);
  const cs = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const phR = (3 / (16 * Math.PI)) * (1 + cs * cs);
  const g = 0.76;
  const phM = (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * cs, 1.5));
  const sT = sunTransmittance(sun[1]);
  const out: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tau = (BR[i] * 8000 + BM * 1320 * 1.1) * am;
    const fex = Math.exp(-tau);
    const bt = BR[i] + BM * 1.1;
    const insc = ((BR[i] * phR + BM * 1.1 * phM) / bt) * (1 - fex);
    const st = Math.pow(sT[i], 1 - 0.5 * Math.min(1, cy * 2));
    out[i] = SKY_SCALE * insc * st;
  }
  const nightFloor: V3 = [0.0025, 0.0045, 0.012];
  for (let i = 0; i < 3; i++) out[i] += nightFloor[i];
  return out;
}

export interface Lighting {
  sunCol: V3; skyAmb: V3; horizon: V3; groundAmb: V3; twilight: number; dayness: number;
}

export function computeLighting(sunDir: V3): Lighting {
  const sT = sunTransmittance(sunDir[1]);
  const up = Math.max(0, Math.min(1, (sunDir[1] + 0.08) / 0.3));
  const sunCol: V3 = [1.75 * sT[0] * up, 1.75 * sT[1] * up, 1.75 * sT[2] * up];
  // horizon colour: average of two horizontal directions perpendicular to the sun azimuth
  const hz = Math.hypot(sunDir[0], sunDir[2]) || 1;
  const px = -sunDir[2] / hz, pz = sunDir[0] / hz;
  const dirs: V3[] = [[px, 0.04, pz], [-px, 0.04, -pz], [sunDir[0] / hz, 0.04, sunDir[2] / hz]];
  const hor: V3 = [0, 0, 0];
  for (const d of dirs) { const n = Math.hypot(...d); const s = skyRadiance([d[0] / n, d[1] / n, d[2] / n], sunDir); for (let i = 0; i < 3; i++) hor[i] += s[i] / 3; }
  const zen = skyRadiance([0, 1, 0], sunDir);
  const mid = skyRadiance([0.7, 0.7, 0], sunDir);
  const skyAmb: V3 = [0, 1, 2].map((i) => 0.55 * zen[i] + 0.45 * mid[i]) as V3;
  const groundAmb: V3 = [0, 1, 2].map((i) => 0.5 * hor[i] + 0.3 * skyAmb[i]) as V3;
  const twilight = Math.pow(Math.max(0, Math.min(1, 1 + (Math.asin(Math.max(-1, Math.min(1, sunDir[1]))) * 180) / Math.PI / 9)), 2) * (sunDir[1] < 0.02 ? 1 : 0.0);
  return { sunCol, skyAmb, horizon: hor, groundAmb, twilight, dayness: up };
}
