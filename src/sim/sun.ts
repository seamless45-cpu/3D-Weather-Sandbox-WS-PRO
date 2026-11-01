// Solar geometry for 38N, near early-summer declination. World frame: +X east, +Y up, -Z north.
const LAT = (38 * Math.PI) / 180;
const DECL = (20 * Math.PI) / 180;

export interface SunState {
  dir: [number, number, number];
  elev: number; // radians
  sinElev: number;
}

export function sunState(tSec: number): SunState {
  const hours = (tSec / 3600) % 24;
  const H = ((hours - 12) * 15 * Math.PI) / 180;
  const sinE = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinE)));
  const cosE = Math.cos(elev);
  let cosA = (Math.sin(DECL) - sinE * Math.sin(LAT)) / Math.max(1e-4, cosE * Math.cos(LAT));
  cosA = Math.max(-1, Math.min(1, cosA));
  let A = Math.acos(cosA);
  if (H > 0) A = 2 * Math.PI - A;
  return { dir: [cosE * Math.sin(A), sinE, -cosE * Math.cos(A)], elev, sinElev: sinE };
}

export function clockString(tSec: number): string {
  const s = ((tSec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
