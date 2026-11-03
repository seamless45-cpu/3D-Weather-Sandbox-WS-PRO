// Diagnostics derived exclusively from the live simulation state.
import type { Atmosphere } from './atmosphere';
import { ParcelResult, parcelAscent, qsl, dewpoint } from './thermo';
import { ZTOP } from './consts';

export interface LocalSounding {
  z: Float32Array; T: Float32Array; Td: Float32Array; p: Float32Array; u: Float32Array; v: Float32Array; tpar: Float32Array;
  sb: ParcelResult; ml: ParcelResult; mu: ParcelResult;
  shear06: number; meanWind: number; surfRH: number; surfT: number; tauColumn: number;
}

export function localSounding(a: Atmosphere, ci: number, cj: number): LocalSounding {
  const { nx, ny, nz, nxy } = a;
  const z = new Float32Array(nz), T = new Float32Array(nz), Td = new Float32Array(nz), p = new Float32Array(nz);
  const u = new Float32Array(nz), v = new Float32Array(nz), tpar = new Float32Array(nz);
  const Tn = new Float64Array(nz), qn = new Float64Array(nz);
  let tau = 0;
  for (let k = 0; k < nz; k++) {
    let th = 0, q = 0, uu = 0, vv = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const idx = k * nxy + ((cj + dj + ny) % ny) * nx + ((ci + di + nx) % nx);
      th += a.th[idx]; q += a.qv[idx]; uu += a.uc0[idx]; vv += a.vc0[idx]; c++;
    }
    th /= c; q /= c;
    const Tk = th * a.prof.pi[k];
    Tn[k] = Tk; qn[k] = q;
    z[k] = a.g.zc[k]; T[k] = Tk - 273.15; p[k] = a.prof.p[k] / 100; Td[k] = dewpoint(q, a.prof.p[k]) - 273.15;
    u[k] = uu / c; v[k] = vv / c;
  }
  const ij = cj * nx + ci;
  tau = a.tauCol[ij];
  const sb = parcelAscent(a.prof.z, a.prof.p, Tn, qn, 'SB', tpar);
  for (let k = 0; k < nz; k++) tpar[k] = isNaN(tpar[k]) ? NaN : tpar[k] - 273.15;
  const ml = parcelAscent(a.prof.z, a.prof.p, Tn, qn, 'ML');
  const mu = parcelAscent(a.prof.z, a.prof.p, Tn, qn, 'MU');
  let k6 = 0; while (k6 < nz - 1 && z[k6] < 6000) k6++;
  const shear06 = Math.hypot(u[k6] - u[0], v[k6] - v[0]);
  let mw = 0, cnt = 0;
  for (let k = 0; k <= k6; k++) { mw += Math.hypot(u[k], v[k]); cnt++; }
  const rh = a.qv[ij] / qsl(Tn[0], a.prof.p[0]);
  return { z, T, Td, p, u, v, tpar, sb, ml, mu, shear06, meanWind: mw / cnt, surfRH: rh * 100, surfT: T[0], tauColumn: tau };
}

/** Surface-based CAPE / CIN on a decimated horizontal grid (stride 2 or 4, power of two). */
export function capeMap(a: Atmosphere, stride = 4): { cape: Float32Array; cin: Float32Array; n: number; stride: number; mean: number; max: number } {
  const { nx, ny, nz, nxy } = a;
  const n = nx / stride;
  const cape = new Float32Array(n * n), cin = new Float32Array(n * n);
  const T = new Float64Array(nz), q = new Float64Array(nz);
  let sum = 0, mx = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ij = (j * stride) * nx + i * stride;
    for (let k = 0; k < nz; k++) { T[k] = a.th[k * nxy + ij] * a.prof.pi[k]; q[k] = a.qv[k * nxy + ij]; }
    const r = parcelAscent(a.prof.z, a.prof.p, T, q, 'SB');
    cape[j * n + i] = r.cape; cin[j * n + i] = r.cin;
    sum += r.cape; if (r.cape > mx) mx = r.cape;
  }
  void ny;
  return { cape, cin, n, stride, mean: sum / (n * n), max: mx };
}

export interface StormMode { label: string; cores: number; linearity: number; uh: number; cold: number; }
// Static neighbour offsets: the old `for (const [a,b] of [[1,0],...])` allocated five arrays per
// visited cell, which is exactly what a broad multicell updraft field has a lot of.
const NB = [1, 0, -1, 0, 0, 1, 0, -1];

export function stormMode(a: Atmosphere, snd: LocalSounding): StormMode {
  const { nx, ny, nz, nxy } = a;
  const wmax = new Float32Array(nxy);
  for (let k = 0; k < nz; k++) {
    if (a.g.zc[k] < 1500 || a.g.zc[k] > 9000) continue;
    for (let ij = 0; ij < nxy; ij++) { const w = 0.5 * (a.w[k * nxy + ij] + a.w[(k + 1) * nxy + ij]); if (w > wmax[ij]) wmax[ij] = w; }
  }
  const seen = new Uint8Array(nxy);
  const comps: { x: number; y: number; n: number }[] = [];
  for (let s = 0; s < nxy; s++) {
    if (seen[s] || wmax[s] < 5) continue;
    const st = [s]; seen[s] = 1;
    let cx = 0, cy = 0, c = 0;
    const i0 = s % nx, j0 = Math.floor(s / nx);
    while (st.length) {
      const q = st.pop()!; const i = q % nx, j = Math.floor(q / nx);
      let di = i - i0; if (di > nx / 2) di -= nx; if (di < -nx / 2) di += nx;
      let dj = j - j0; if (dj > ny / 2) dj -= ny; if (dj < -ny / 2) dj += ny;
      cx += di; cy += dj; c++;
      for (let d = 0; d < 4; d++) {
        const a1 = NB[d * 2], b1 = NB[d * 2 + 1];
        const qq = ((j + b1 + ny) % ny) * nx + ((i + a1 + nx) % nx);
        if (!seen[qq] && wmax[qq] >= 5) { seen[qq] = 1; st.push(qq); }
      }
    }
    comps.push({ x: i0 + cx / c, y: j0 + cy / c, n: c });
  }
  // linearity: eigenvalue ratio of the (minimum-image) position covariance of cores
  let lin = 0;
  if (comps.length >= 3) {
    const r = comps[0];
    const pts = comps.map((c) => { let dx = c.x - r.x, dy = c.y - r.y; dx -= nx * Math.round(dx / nx); dy -= ny * Math.round(dy / ny); return [dx, dy]; });
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, d = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + d, l2 = Math.max(1e-6, tr / 2 - d);
    lin = 1 - Math.sqrt(l2 / Math.max(l1, 1e-6));
  }
  const S = a.stats, cores = comps.length;
  let label: string;
  if (cores === 0) {
    if (S.cloudFrac > 0.02) label = 'Shallow cumulus, no deep updrafts';
    else if (snd.sb.cape > 100 && snd.sb.cin < -50) label = 'Convection suppressed (CIN)';
    else label = 'Clear / stable';
  } else if (S.maxUH > 150 && snd.shear06 > 15 && cores <= 4) label = 'Supercell-like (rotating updraft)';
  else if (cores >= 5 && lin > 0.8 && S.coldPool > 0.03) label = 'Squall line / bow echo';
  else if (cores >= 6 && S.coldPool > 0.05) label = 'MCS / merged cold-pool complex';
  else if (cores >= 2) label = snd.shear06 > 10 ? 'Multicell cluster (gust-front regeneration)' : 'Pulse multicells';
  else label = 'Isolated cell';
  return { label, cores, linearity: lin, uh: S.maxUH, cold: S.coldPool };
}

export type DiagField = 'w' | 'T' | 'RH' | 'cloud' | 'precip' | 'E' | 'thp' | 'zeta' | 'p' | 'cape';
export interface DiagSlice { field: DiagField; mode: 'h' | 'v'; w: number; h: number; data: Float32Array; ua: Float32Array; va: Float32Array; min: number; max: number; unit: string; }

export function diagSlice(a: Atmosphere, field: DiagField, mode: 'h' | 'v', level: number, ci: number, cj: number, cm: { cape: Float32Array; cin: Float32Array; n: number; stride: number } | null): DiagSlice {
  const { nx, ny, nz, nxy } = a;
  const w = nx, h = mode === 'h' ? ny : nz;
  const data = new Float32Array(w * h), ua = new Float32Array(w * h), va = new Float32Array(w * h);
  const val = (c: number, k: number): number => {
    switch (field) {
      case 'w': return 0.5 * (a.w[c] + a.w[c + nxy]);
      case 'T': return a.th[c] * a.prof.pi[k] - 273.15;
      case 'RH': return (100 * a.qv[c]) / qsl(a.th[c] * a.prof.pi[k], a.prof.p[k]);
      case 'cloud': return (a.qc[c] + a.qi[c]) * 1000;
      case 'precip': return (a.qr[c] + a.qs[c] + a.qg[c]) * 1000;
      case 'E': return a.emag[c] / 1000;
      case 'thp': return a.th[c] - a.prof.th[k];
      case 'p': return (a.pi[c] * a.rhoC[k]) / 100;
      case 'zeta': {
        const i = c % nx, j = Math.floor((c % nxy) / nx), b = Math.floor(c / nxy) * nxy;
        return 1000 * ((a.vc0[b + j * nx + (i + 1) % nx] - a.vc0[b + j * nx + (i + nx - 1) % nx]) / (2 * a.g.dx)
          - (a.uc0[b + ((j + 1) % ny) * nx + i] - a.uc0[b + ((j + ny - 1) % ny) * nx + i]) / (2 * a.g.dy));
      }
      default: return 0;
    }
  };
  if (field === 'cape' && cm) {
    const s = cm.stride;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = cm.cape[(((j / s) | 0) % cm.n) * cm.n + (((i / s) | 0) % cm.n)];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { ua[j * nx + i] = a.uc0[j * nx + i]; va[j * nx + i] = a.vc0[j * nx + i]; }
  } else if (mode === 'h') {
    const k = Math.min(nz - 1, Math.max(0, level));
    for (let ij = 0; ij < nxy; ij++) { data[ij] = val(k * nxy + ij, k); ua[ij] = a.uc0[k * nxy + ij]; va[ij] = a.vc0[k * nxy + ij]; }
  } else {
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = k * nxy + cj * nx + i;
      data[k * nx + i] = val(c, k); ua[k * nx + i] = a.uc0[c]; va[k * nx + i] = 0.5 * (a.w[c] + a.w[c + nxy]);
    }
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < data.length; i++) { if (data[i] < mn) mn = data[i]; if (data[i] > mx) mx = data[i]; }
  const unit = { w: 'm/s', T: '°C', RH: '%', cloud: 'g/kg', precip: 'g/kg', E: 'kV/m', thp: 'K', zeta: '1e-3/s', p: 'hPa', cape: 'J/kg' }[field];
  void ci; void ZTOP;
  return { field, mode, w, h, data, ua, va, min: mn, max: mx, unit };
}
