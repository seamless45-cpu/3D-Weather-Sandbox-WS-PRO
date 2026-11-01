import { DOMAIN } from './consts';

// Periodic procedural terrain shared by the renderer (player collision, mesh) and the solver (surface properties).
function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, P: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P;
  const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(u: number, v: number, f0: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, f = f0, nrm = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(u * f, v * f, f, seed + o * 7); nrm += a; a *= 0.5; f *= 2; }
  return s / nrm;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const WATER_LEVEL = 0;

export function rawHeight(x: number, z: number): number {
  const u = x / DOMAIN, v = z / DOMAIN;
  const n = fbm(u, v, 3, 6, 11);
  let h0 = 560 * (n - 0.45);
  h0 = h0 > 0 ? h0 : -9 * (1 - Math.exp(h0 / 14));
  if (h0 > 0) h0 += 9 * (fbm(u, v, 40, 3, 90) - 0.5) * Math.min(1, h0 / 30);
  return h0;
}
export function forestField(x: number, z: number): number {
  return fbm(x / DOMAIN, z / DOMAIN, 5, 4, 41);
}

export class Terrain {
  M: number; spacing: number;
  heights: Float32Array;
  cls: Uint8Array; // RGBA: forest, rock, grass, water
  constructor(M: number) {
    this.M = M; this.spacing = DOMAIN / M;
    this.heights = new Float32Array(M * M);
    this.cls = new Uint8Array(M * M * 4);
    const s = this.spacing;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) this.heights[j * M + i] = rawHeight(i * s, j * s);
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        const h = this.heights[j * M + i];
        const hx = (this.heights[j * M + ((i + 1) % M)] - this.heights[j * M + ((i + M - 1) % M)]) / (2 * s);
        const hz = (this.heights[((j + 1) % M) * M + i] - this.heights[((j + M - 1) % M) * M + i]) / (2 * s);
        const slope = Math.hypot(hx, hz);
        const ff = forestField(i * s, j * s);
        let forest = smooth(0.5, 0.58, ff) * smooth(2, 12, h) * (1 - smooth(190, 250, h)) * (1 - smooth(0.35, 0.6, slope));
        let rock = Math.max(smooth(170, 260, h), smooth(0.4, 0.7, slope));
        const water = h < 0.05 ? 1 : 0;
        if (water) { forest = 0; rock = 0; }
        rock = Math.min(rock, 1 - forest * 0.5);
        const o = (j * M + i) * 4;
        this.cls[o] = Math.round(forest * 255);
        this.cls[o + 1] = Math.round(rock * 255);
        this.cls[o + 2] = Math.round(Math.max(0, 1 - forest - rock) * 255);
        this.cls[o + 3] = water * 255;
      }
    }
  }
  /** Exact interpolation over the rendered triangle mesh (quad diagonal (i,j)-(i+1,j+1)). */
  groundHeight(x: number, z: number): number {
    const M = this.M, s = this.spacing;
    const gx = x / s, gz = z / s;
    const i0f = Math.floor(gx), j0f = Math.floor(gz);
    const fx = gx - i0f, fz = gz - j0f;
    const i0 = ((i0f % M) + M) % M, j0 = ((j0f % M) + M) % M;
    const i1 = (i0 + 1) % M, j1 = (j0 + 1) % M;
    const H = this.heights;
    const h00 = H[j0 * M + i0], h10 = H[j0 * M + i1], h01 = H[j1 * M + i0], h11 = H[j1 * M + i1];
    if (fx >= fz) return h00 + fx * (h10 - h00) + fz * (h11 - h10);
    return h00 + fx * (h11 - h01) + fz * (h01 - h00);
  }
  classAt(x: number, z: number): [number, number, number, number] {
    const M = this.M, s = this.spacing;
    const i = (((Math.round(x / s)) % M) + M) % M, j = (((Math.round(z / s)) % M) + M) % M;
    const o = (j * M + i) * 4;
    return [this.cls[o] / 255, this.cls[o + 1] / 255, this.cls[o + 2] / 255, this.cls[o + 3] / 255];
  }
  findSpawn(): [number, number] {
    const c = DOMAIN / 2;
    for (let r = 0; r < 12000; r += 80) {
      for (let a = 0; a < 16; a++) {
        const x = c + r * Math.cos((a * Math.PI) / 8), z = c + r * Math.sin((a * Math.PI) / 8);
        const h = this.groundHeight(x, z);
        const cl = this.classAt(x, z);
        const hx = this.groundHeight(x + 60, z) - this.groundHeight(x - 60, z);
        if (h > 4 && h < 90 && cl[0] < 0.3 && cl[3] < 0.1 && Math.abs(hx) < 12) return [x, z];
      }
    }
    return [c, c];
  }
}

export interface ColumnProps {
  h: Float32Array; fW: Float32Array; fF: Float32Array; fR: Float32Array;
  dhdx: Float32Array; dhdy: Float32Array;
}
/** Average the terrain over each solver column. */
export function columnProps(t: Terrain, n: number): ColumnProps {
  const nxy = n * n;
  const h = new Float32Array(nxy), fW = new Float32Array(nxy), fF = new Float32Array(nxy), fR = new Float32Array(nxy);
  const per = Math.floor(t.M / n);
  for (let cj = 0; cj < n; cj++) for (let ci = 0; ci < n; ci++) {
    let sh = 0, sw = 0, sf = 0, sr = 0, c = 0;
    for (let b = 0; b < per; b++) for (let a = 0; a < per; a++) {
      const i = (ci * per + a) % t.M, j = (cj * per + b) % t.M;
      sh += t.heights[j * t.M + i]; const o = (j * t.M + i) * 4;
      sf += t.cls[o]; sr += t.cls[o + 1]; sw += t.cls[o + 3]; c++;
    }
    const q = cj * n + ci;
    h[q] = sh / c; fF[q] = sf / c / 255; fR[q] = sr / c / 255; fW[q] = sw / c / 255;
  }
  const dx = DOMAIN / n;
  const dhdx = new Float32Array(nxy), dhdy = new Float32Array(nxy);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    dhdx[j * n + i] = (h[j * n + ((i + 1) % n)] - h[j * n + ((i + n - 1) % n)]) / (2 * dx);
    dhdy[j * n + i] = (h[((j + 1) % n) * n + i] - h[((j + n - 1) % n) * n + i]) / (2 * dx);
  }
  return { h, fW, fF, fR, dhdx, dhdy };
}
