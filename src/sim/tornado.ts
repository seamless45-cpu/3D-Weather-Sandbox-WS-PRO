/**
 * Physics-driven tornadogenesis parameterization.
 *
 * The 500 m anelastic grid cannot resolve a 100-600 m tornado core, so this module does not
 * pretend to be an LES. It derives a sub-grid vortex from the simulated fields: low-level
 * vertical vorticity and convergence, 2-5 km updraft helicity, 0-1 km shear/helicity, CAPE,
 * LCL, cold-pool strength and the local rotating updraft maximum. The resulting Rankine vortex
 * feeds a bounded tangential/inflow wind tendency back into the lowest model levels; the
 * pressure deficit, condensation funnel height, debris load and EF-like intensity follow from
 * cyclostrophic balance and the simulated cloud base.
 */
import type { Atmosphere } from './atmosphere';
import { DOMAIN } from './consts';
import { dewpoint } from './thermo';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapDelta = (d: number) => d - DOMAIN * Math.round(d / DOMAIN);
const wrap = (v: number) => ((v % DOMAIN) + DOMAIN) % DOMAIN;

export type TornadoStage = 'none' | 'wall-cloud' | 'funnel' | 'mature' | 'rope' | 'dissipating';

export interface TornadoState {
  active: boolean;
  x: number; z: number;              // world horizontal coordinates (x, z), metres
  vx: number; vz: number;            // translation, m/s
  intensity: number;                 // 0..1
  target: number;
  confidence: number;
  radius: number;                    // core radius, m
  maxWind: number;                   // m/s
  pressureDrop: number;              // hPa
  funnelTop: number; funnelBottom: number; lcl: number;
  debris: number;
  stage: TornadoStage;
  ef: number;
  age: number;                       // simulated seconds
  potential: number;
  uh: number; zeta: number; shear1: number; srh1: number; cape: number; coldPool: number;
}

export interface TornadoSnapshot extends TornadoState {
  distance: number;                  // distance from camera/vehicle, m
  bearing: number;                   // radians from -Z (north), clockwise
}

function initialState(): TornadoState {
  return {
    active: false, x: DOMAIN / 2, z: DOMAIN / 2, vx: 0, vz: 0,
    intensity: 0, target: 0, confidence: 0, radius: 220, maxWind: 0, pressureDrop: 0,
    funnelTop: 0, funnelBottom: 0, lcl: 1200, debris: 0, stage: 'none', ef: 0, age: 0,
    potential: 0, uh: 0, zeta: 0, shear1: 0, srh1: 0, cape: 0, coldPool: 0,
  };
}

/** EF scale from 3-second gust (m/s), simplified WEFG-ish thresholds. */
export function efFromWind(v: number): number {
  if (v >= 89) return 5;
  if (v >= 74) return 4;
  if (v >= 60) return 3;
  if (v >= 49) return 2;
  if (v >= 38) return 1;
  if (v >= 29) return 0;
  return -1;
}

export class TornadoSystem {
  state: TornadoState = initialState();
  private rot = new Float32Array(0);
  private sm = new Float32Array(0);
  private pending = 0;
  private weak = 0;
  private diagStep = -1;
  private candidateX = DOMAIN / 2;
  private candidateZ = DOMAIN / 2;
  private candidateScore = 0;

  reset() {
    this.state = initialState();
    this.pending = 0; this.weak = 0; this.diagStep = -1;
    this.candidateScore = 0;
  }

  snapshot(camX: number, camZ: number): TornadoSnapshot {
    const s = this.state;
    const dx = wrapDelta(s.x - camX), dz = wrapDelta(s.z - camZ);
    return { ...s, distance: Math.hypot(dx, dz), bearing: Math.atan2(dx, -dz) };
  }

  /** Called every solver step: cheap vortex feedback; full detection every 6th step. */
  update(a: Atmosphere, dt: number) {
    if (a.step_n - this.diagStep >= 6) { this.diagnose(a); this.diagStep = a.step_n; }
    const s = this.state;
    s.age = s.active ? s.age + dt : 0;
    // Track the rotating updraft maximum with a periodic-domain minimum-image correction.
    if (s.active) {
      const cx = wrapDelta(this.candidateX - s.x), cz = wrapDelta(this.candidateZ - s.z);
      const pull = Math.min(1, dt / 45) * 0.22;
      s.vx += cx * pull / Math.max(30, dt);
      s.vz += cz * pull / Math.max(30, dt);
      s.vx = clamp(s.vx, -30, 30); s.vz = clamp(s.vz, -30, 30);
      s.x = wrap(s.x + s.vx * dt); s.z = wrap(s.z + s.vz * dt);
    } else {
      s.x = this.candidateX; s.z = this.candidateZ;
    }

    const grow = s.active ? 110 : 210;
    const decay = s.active ? 240 : 80;
    const tau = s.target > s.intensity ? grow : decay;
    s.intensity += (s.target - s.intensity) * Math.min(1, dt / tau);
    s.intensity = clamp(s.intensity, 0, 1);

    if (!s.active && s.target > 0.30 && this.candidateScore > 0.20) this.pending += dt;
    else this.pending = Math.max(0, this.pending - dt * 1.5);
    if (s.active && s.target < 0.12) this.weak += dt; else this.weak = Math.max(0, this.weak - dt * 1.2);
    if (!s.active && this.pending > 55) { s.active = true; s.age = 0; s.intensity = Math.max(s.intensity, 0.12); }
    if (s.active && (this.weak > 110 || s.intensity < 0.025)) { s.active = false; s.intensity = 0; s.target = 0; s.age = 0; }

    s.radius = 120 + 340 * Math.pow(s.intensity, 0.7);
    s.maxWind = 25 + 45 * Math.pow(s.intensity, 0.72);
    s.pressureDrop = (0.5 * a.prof.rho[0] * s.maxWind * s.maxWind) / 100;
    s.funnelTop = clamp(s.lcl * 1.18 + 180, 600, 3200);
    const reach = smooth(0.12, 0.82, s.intensity);
    s.funnelBottom = clamp(s.funnelTop * (1 - 1.06 * reach), 0, s.funnelTop);
    s.debris = smooth(0.34, 0.9, s.intensity) * (0.55 + 0.45 * s.confidence);
    s.ef = efFromWind(s.maxWind);
    s.stage = !s.active ? (s.target > 0.18 ? 'wall-cloud' : 'none')
      : s.intensity < 0.28 ? 'funnel'
      : s.intensity > 0.72 && s.age > 900 ? 'rope'
      : s.target < s.intensity - 0.12 ? 'dissipating'
      : 'mature';

    if (s.active && s.intensity > 0.03) this.applyVortex(a, dt);
  }

  private diagnose(a: Atmosphere) {
    const { nx, ny, nz, nxy } = a, g = a.g;
    if (this.rot.length !== nxy) { this.rot = new Float32Array(nxy); this.sm = new Float32Array(nxy); }
    const rot = this.rot, sm = this.sm;
    rot.fill(0); sm.fill(0);
    const u = a.uc0, v = a.vc0, w = a.w;
    const kLow = Math.max(2, Math.min(nz, 7));
    for (let k = 0; k < kLow; k++) {
      const wt = Math.max(0, 1 - g.zc[k] / 3200);
      for (let j = 0; j < ny; j++) {
        const jp = (j + 1) % ny, jm = (j + ny - 1) % ny;
        for (let i = 0; i < nx; i++) {
          const ip = (i + 1) % nx, im = (i + nx - 1) % nx;
          const c = k * nxy + j * nx + i;
          const zeta = (v[c - i + ip] - v[c - i + im]) / (2 * g.dx) - (u[k * nxy + jp * nx + i] - u[k * nxy + jm * nx + i]) / (2 * g.dy);
          const wv = 0.5 * (w[c] + w[c + nxy]);
          const conv = -((u[c - i + ip] - u[c - i + im]) + (v[k * nxy + jp * nx + i] - v[k * nxy + jm * nx + i])) / (2 * g.dx);
          rot[j * nx + i] += wt * Math.max(0, zeta) * Math.max(0, wv) * (1 + 0.35 * Math.max(0, conv));
        }
      }
    }
    // 3x3 smoothing suppresses single-cell vorticity spikes from the pressure projection.
    let best = 0, bi = 0, bj = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += rot[((j + dj + ny) % ny) * nx + ((i + di + nx) % nx)];
      const r = sum / 9;
      sm[j * nx + i] = r;
      if (r > best) { best = r; bi = i; bj = j; }
    }
    this.candidateX = (bi + 0.5) * g.dx;
    this.candidateZ = (bj + 0.5) * g.dy;
    this.candidateScore = clamp(best / 0.012, 0, 1);

    // Environmental ingredients for a significant-tornado-parameter-like predictor.
    // The imposed hodograph is deliberately weak, so the storm-generated local shear and
    // helicity around the rotating updraft are used, not just the mean profile.
    const pi0 = a.prof.pi[0], p0 = a.prof.p[0];
    let th0 = 0, q0 = 0;
    for (let ij = 0; ij < nxy; ij++) { th0 += a.th[ij]; q0 += a.qv[ij]; }
    th0 /= nxy; q0 /= nxy;
    const T0c = th0 * pi0, Td = dewpoint(q0, p0);
    const lcl = clamp(125 * (T0c - Td), 250, 2600);
    let k1 = 0; while (k1 < nz - 1 && g.zc[k1] < 1000) k1++;
    let k6 = 0; while (k6 < nz - 1 && g.zc[k6] < 6000) k6++;
    // Storm-local hodograph: 3x3 mean centred on the rotating updraft maximum. This captures
    // cold-pool/outflow shear and mesocyclone inflow that the horizontally uniform sounding omits.
    const ci = Math.min(nx - 1, Math.max(0, Math.floor(this.candidateX / g.dx)));
    const cj = Math.min(ny - 1, Math.max(0, Math.floor(this.candidateZ / g.dy)));
    const lu = new Float64Array(k6 + 1), lv = new Float64Array(k6 + 1);
    for (let k = 0; k <= k6; k++) {
      let su = 0, sv = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const c = k * nxy + ((cj + dj + ny) % ny) * nx + ((ci + di + nx) % nx);
        su += u[c]; sv += v[c]; n++;
      }
      lu[k] = su / n; lv[k] = sv / n;
    }
    const shear1 = Math.max(
      Math.hypot(a.prof.u[k1] - a.prof.u[0], a.prof.v[k1] - a.prof.v[0]),
      Math.hypot(lu[k1] - lu[0], lv[k1] - lv[0]),
    );
    let mu = 0, mv = 0;
    for (let k = 0; k <= k6; k++) { mu += lu[k]; mv += lv[k]; }
    mu /= k6 + 1; mv /= k6 + 1;
    const cU = 0.75 * mu + 0.25 * (lu[k1] - lu[0]);
    const cV = 0.75 * mv + 0.25 * (lv[k1] - lv[0]);
    let srh = 0;
    for (let k = 0; k < k1; k++) {
      const dz = Math.max(1, g.zc[k + 1] - g.zc[k]);
      const du = (lu[k + 1] - lu[k]) / dz, dv = (lv[k + 1] - lv[k]) / dz;
      srh += ((lu[k] - cU) * dv - (lv[k] - cV) * du) * dz;
    }
    srh = Math.abs(srh) + 0.5 * Math.abs(a.stats.maxUH || 0) / 100;
    const cape = a.env.cape, uh = a.stats.maxUH || 0, cold = a.stats.coldPool || 0;
    const capeF = clamp(cape / 1800, 0, 2);
    const shearF = clamp(shear1 / 3.5, 0, 2);
    const srhF = clamp(srh / 3.0, 0, 2);
    const lclF = clamp((2200 - lcl) / 1400, 0, 1.35);
    const coldF = clamp(1 - cold * 2.4, 0, 1);
    const uhF = clamp(uh / 220, 0, 1.5);
    const stp = capeF * shearF * srhF * lclF * coldF;
    const potential = stp * (0.42 + 0.58 * uhF) * (0.48 + 0.52 * this.candidateScore);
    const target = smooth(0.42, 2.3, potential) * (0.32 + 0.68 * uhF);

    const s = this.state;
    s.target = target; s.potential = potential; s.confidence = clamp(potential / 2.3, 0, 1);
    s.uh = uh; s.shear1 = shear1; s.srh1 = srh; s.cape = cape; s.coldPool = cold; s.lcl = lcl;
    s.zeta = best;
    if (!s.active) { s.vx = cU; s.vz = cV; }
  }

  /** Bounded Rankine vortex + frictional inflow, applied to face winds before projection. */
  private applyVortex(a: Atmosphere, dt: number) {
    const s = this.state;
    const { nx, ny, nz, nxy } = a, g = a.g, u = a.u, v = a.v;
    const R = Math.max(80, s.radius), V = s.maxWind * (0.45 + 0.55 * s.intensity);
    const kTop = Math.max(2, Math.min(nz, 5));
    for (let k = 0; k < kTop; k++) {
      const zDecay = Math.exp(-g.zc[k] / 1100);
      const blend = Math.min(1, dt / 55) * zDecay * (0.35 + 0.65 * s.intensity);
      if (blend < 1e-4) continue;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const dx = wrapDelta((i + 0.5) * g.dx - s.x), dz = wrapDelta((j + 0.5) * g.dy - s.z);
        const r = Math.hypot(dx, dz);
        const rr = Math.max(r, 30);
        const core = r < R ? r / R : Math.pow(R / rr, 0.62) * Math.exp(-(r - R) / 4200);
        const vt = V * core;
        const inflow = -0.20 * V * Math.exp(-r / (1.8 * R)) * zDecay;
        const tx = -(dz / rr) * vt + (dx / rr) * inflow + s.vx;
        const tz = (dx / rr) * vt + (dz / rr) * inflow + s.vz;
        const c = k * nxy + j * nx + i;
        u[c] += (tx - u[c]) * blend;
        v[c] += (tz - v[c]) * blend;
      }
    }
  }
}
