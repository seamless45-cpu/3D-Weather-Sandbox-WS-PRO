/**
 * Anelastic (Ogura-Phillips / Lipps-Hemler style) 3-D atmosphere on a periodic-horizontal, stretched-vertical MAC grid.
 *   d u/dt = -u.grad u - grad(pi) + B k + SGS + surface drag + large-scale forcing,   div(rho0 u) = 0
 *   d theta/dt, d q_x/dt : flux-limited (van Leer TVD) mass-weighted advection + TKE-based SGS diffusion + sources
 * Pressure is obtained by an exact FFT/tridiagonal solve of the discrete variable-density Poisson equation.
 * Buoyancy uses virtual potential temperature and condensate loading; latent heating is applied in microphysics.
 */
import { Grid, makeGrid, G, CP, LV, LF, SIGMA, EPS, EPS0, DOMAIN, mulberry32 } from './consts';
import { Profile, buildProfile, Environment, envForCape, qsl } from './thermo';
import { SimParams, clampParams } from './params';
import { Poisson } from './fft';
import { Terrain, columnProps, ColumnProps } from './terrain';
import { sunState } from './sun';
import { microphysics, sedimentation, chargeDecay } from './micro';
import { chargeSeparation, emptyChargeDiagnostics, type ChargeDiagnostics } from './charging';
import { TornadoSystem } from './tornado';
import { tryLightning } from './lightning';
import { radiationTendencies, surfaceEmissivity } from './radiation';

export interface Stats {
  maxW: number; minW: number; maxQc: number; maxQi: number; maxQr: number; maxQg: number; maxRain: number;
  maxE: number; maxEratio: number; maxEz0: number; KE: number; waterRes: number; energyRes: number; maxDiv: number; cfl: number;
  cloudFrac: number; coldPool: number; coldPoolMin: number; meanTs: number; maxUH: number; precipCum: number; flashes: number;
  waterTotal: number; chargePos: number; chargeNeg: number; maxCape: number;
  tornadoActive: number; tornadoIntensity: number; tornadoPotential: number; tornadoEF: number;
  maxTornadoWind: number; tornadoPressure: number; chargeSep: number; chargeTripole: number;
}

export class Atmosphere {
  g: Grid; nx: number; ny: number; nz: number; nxy: number; n3: number;
  prof!: Profile; env: Environment; params: SimParams; terrain: Terrain; cols: ColumnProps;
  u!: Float32Array; v!: Float32Array; w!: Float32Array;
  th!: Float32Array; qv!: Float32Array; qc!: Float32Array; qi!: Float32Array; qr!: Float32Array; qs!: Float32Array; qg!: Float32Array;
  qh!: Float32Array; ql!: Float32Array; tke!: Float32Array; pi!: Float32Array;
  /** Per-cell radiative temperature tendencies [K/s] (longwave / shortwave), refreshed each step. */
  radLw!: Float32Array; radSw!: Float32Array;
  uc!: Float32Array; vc!: Float32Array; wc!: Float32Array; uc0!: Float32Array; vc0!: Float32Array; wc0!: Float32Array;
  Km!: Float32Array; Kh!: Float32Array; tmp!: Float32Array; rhs!: Float32Array;
  M0!: Float32Array; M1!: Float32Array; M2!: Float32Array; M3!: Float32Array;
  phi!: Float32Array; emag!: Float32Array; ez!: Float32Array;
  /** Surface charge density on the ground [C/m²]: charge rained out of the cloud and charge
   *  induced on the surface by the overhead dipole. Feeds the Poisson rhs so the field just
   *  above the ground reflects it — this is what makes nearby cloud-to-ground lightning
   *  possible (real CGs overwhelmingly strike where surface charge has accumulated). */
  qGround!: Float32Array;
  /** max |qGround| over the domain, maintained by sedimentation and the electric solve. */
  qgMax = 0;
  /** Ground-flash trigger diagnostics (cells/field seen by the ground block in tryLightning). */
  gd = { call: 0, cand: 0, maxR: 0, pass: 0, blk: 0, sel: 0, roll: 0 };
  Ts!: Float32Array; soilM!: Float32Array; surfW!: Float32Array; rainRate!: Float32Array; surfPrec!: Float32Array;
  Hf!: Float32Array; LEf!: Float32Array; Tdeep!: Float32Array; tauCol!: Float32Array; ustar!: Float32Array; swd!: Float32Array;
  colHydro!: Uint8Array; act!: Uint8Array; rowAct!: Uint8Array; colAct!: Uint8Array;
  colA!: Float32Array; colB!: Float32Array; colC!: Float32Array; colD!: Float32Array; colE!: Float32Array;
  rhoC!: Float64Array; rhoF!: Float64Array;
  poisP!: Poisson; poisE!: Poisson;
  bufX: Float32Array; fluxX: Float32Array; fluxPlane: Float32Array;
  time = 11 * 3600; dt = 4; step_n = 0; rng: () => number;
  /** Diurnal boundary-layer state: sunrise time [s] and previous sin(elevation) for crossing detection. */
  sunriseT = -1; prevSin = 0;
  anyHydro = false; chargeMax = 0; flashEvents: any[] = [];
  tornado = new TornadoSystem(); chargeDiag: ChargeDiagnostics = emptyChargeDiagnostics();
  /** Player-spawned props (lightning rods attract ground-initiated lightning, etc.). */
  props: { x: number; z: number; type: string; h: number }[] = [];
  setProps(list: { x: number; z: number; type: string; h: number }[]) { this.props = list.slice(0, 64); }
  precipCum = 0; iceGroundCum = 0; evapCum = 0; nudgeWater = 0; w0Total = 0; mse0 = 0; srcEnergy = 0; flashCount = 0;
  stats: Stats; sunSin = 0; sunDirV: [number, number, number] = [0, 1, 0]; cflRate = 0;
  lastLightningT = -1e9;

  constructor(n: number, nz: number, params: SimParams, terrain: Terrain, seed = 7) {
    // The horizontal pressure solver is a radix-2 FFT: the (square) horizontal
    // grid must be a power of two. Fail loudly instead of producing NaNs.
    if (!Number.isInteger(n) || n < 8 || (n & (n - 1)) !== 0) {
      throw new Error(`horizontal grid size must be a power of two >= 8 (got ${n})`);
    }
    if (!Number.isInteger(nz) || nz < 8) {
      throw new Error(`vertical levels must be an integer >= 8 (got ${nz})`);
    }
    this.g = makeGrid(n, nz);
    this.nx = n; this.ny = n; this.nz = nz; this.nxy = n * n; this.n3 = n * n * nz;
    this.params = clampParams(params);
    this.terrain = terrain; this.cols = columnProps(terrain, n);
    this.rng = mulberry32(seed);
    const g = this.g;
    this.env = envForCape(g, this.params.cape);
    this.prof = buildProfile(g, this.env);
    this.poisP = null as any; this.poisE = null as any;
    this.buildSolvers();
    const F = (m: number) => new Float32Array(m);
    const n3 = this.n3, nxy = this.nxy;
    this.u = F(n3); this.v = F(n3); this.w = F(nxy * (nz + 1));
    this.th = F(n3); this.qv = F(n3); this.qc = F(n3); this.qi = F(n3); this.qr = F(n3); this.qs = F(n3); this.qg = F(n3);
    this.qh = F(n3); this.ql = F(n3); this.tke = F(n3); this.pi = F(n3);
    this.radLw = F(n3); this.radSw = F(n3);
    this.uc = F(n3); this.vc = F(n3); this.wc = F(n3); this.uc0 = F(n3); this.vc0 = F(n3); this.wc0 = F(n3);
    this.Km = F(n3); this.Kh = F(n3); this.tmp = F(n3); this.rhs = F(n3);
    this.M0 = F(n3); this.M1 = F(n3); this.M2 = F(n3); this.M3 = F(n3);
    this.phi = F(n3); this.emag = F(n3); this.ez = F(n3);
    this.qGround = F(nxy);
    this.Ts = F(nxy); this.soilM = F(nxy); this.surfW = F(nxy); this.rainRate = F(nxy); this.surfPrec = F(nxy);
    this.Hf = F(nxy); this.LEf = F(nxy); this.Tdeep = F(nxy); this.tauCol = F(nxy); this.ustar = F(nxy); this.swd = F(nxy);
    this.colHydro = new Uint8Array(nxy); this.act = new Uint8Array(nxy); this.rowAct = new Uint8Array(n); this.colAct = new Uint8Array(n);
    this.colA = F(nz); this.colB = F(nz); this.colC = F(nz); this.colD = F(nz); this.colE = F(nz);
    this.bufX = F(n + 4); this.fluxX = F(n + 1); this.fluxPlane = F(nxy * (nz + 1));
    for (let k = 0; k < nz; k++) for (let ij = 0; ij < nxy; ij++) this.M0[k * nxy + ij] = this.rhoC[k];
    this.stats = {} as Stats;
    this.init();
  }

  private buildSolvers() {
    const { nx: n, nz } = this; const g = this.g;
    this.rhoC = this.prof.rho; this.rhoF = this.prof.rhoF;
    // pressure Poisson (Neumann, variable density)
    const aL = new Float64Array(nz), bB = new Float64Array(nz), cU = new Float64Array(nz);
    for (let k = 0; k < nz; k++) {
      aL[k] = k > 0 ? this.rhoF[k] / (this.rhoC[k] * g.dz[k] * g.dzf[k]) : 0;
      cU[k] = k < nz - 1 ? this.rhoF[k + 1] / (this.rhoC[k] * g.dz[k] * g.dzf[k + 1]) : 0;
      bB[k] = -(aL[k] + cU[k]);
    }
    this.poisP = new Poisson(n, n, nz, g.dx, g.dy, aL, bB, cU, true);
    // electrostatic potential (Dirichlet: grounded surface + conducting upper boundary)
    const aE = new Float64Array(nz), bE = new Float64Array(nz), cE = new Float64Array(nz);
    for (let k = 0; k < nz; k++) {
      aE[k] = k > 0 ? 1 / (g.dz[k] * g.dzf[k]) : 0;
      cE[k] = k < nz - 1 ? 1 / (g.dz[k] * g.dzf[k + 1]) : 0;
      bE[k] = -(aE[k] + cE[k]);
    }
    bE[0] -= 1 / (g.dz[0] * g.zc[0]);
    bE[nz - 1] -= 1 / (g.dz[nz - 1] * g.dzf[nz]);
    this.poisE = new Poisson(n, n, nz, g.dx, g.dy, aE, bE, cE, false);
  }

  /** Clear-sky initial state: sounding + tiny boundary-layer noise + surface state. No condensate, no charge, no storms. */
  init() {
    const { nz, nxy } = this;
    const r = this.rng, pr = this.prof;
    for (const f of [this.th, this.qv, this.qc, this.qi, this.qr, this.qs, this.qg, this.qh, this.ql, this.tke, this.w, this.phi]) f.fill(0);
    for (let k = 0; k < nz; k++) {
      const bl = this.g.zc[k] < 1600;
      for (let ij = 0; ij < nxy; ij++) {
        const idx = k * nxy + ij;
        this.th[idx] = pr.th[k] + (bl ? (r() - 0.5) * 0.3 : 0);
        this.qv[idx] = pr.qv[k] + (bl ? (r() - 0.5) * 1e-4 : 0);
        this.u[idx] = pr.u[k]; this.v[idx] = pr.v[k];
        this.tke[idx] = bl ? 0.15 : 0.005;
      }
    }
    for (let ij = 0; ij < nxy; ij++) {
      const Ta = this.th[ij] * pr.pi[0];
      const water = this.cols.fW[ij] > 0.5;
      this.Ts[ij] = Ta + (water ? 1.0 : -0.5) + (water ? 0 : (r() - 0.5) * 0.4);
      this.Tdeep[ij] = this.Ts[ij] + (water ? 0 : 1.5);
      const h = this.cols.h[ij];
      this.soilM[ij] = water ? 1 : Math.max(0.1, Math.min(0.9, 0.55 - h / 700 + (r() - 0.5) * 0.3));
      this.surfW[ij] = 0;
    }
    this.time = 11 * 3600; this.step_n = 0; this.dt = 4; this.sunriseT = -1; this.prevSin = 0;
    this.precipCum = 0; this.iceGroundCum = 0; this.evapCum = 0; this.nudgeWater = 0; this.srcEnergy = 0; this.flashCount = 0;
    this.anyHydro = false; this.chargeMax = 0; this.lastLightningT = -1e9;
    this.qGround.fill(0); this.qgMax = 0;
    this.terrainBC();
    this.project(4);
    this.computeStats();
    this.w0Total = this.stats.waterTotal; this.mse0 = this.totalMSE();
  }

  // ---------------------------------------------------------------- helpers
  private centered() {
    const { nx, ny, nz, nxy, u, v, w, uc, vc, wc } = this;
    let mx = 0;
    const dx = this.g.dx, dy = this.g.dy;
    for (let k = 0; k < nz; k++) {
      const idz = 1 / this.g.dz[k];
      for (let j = 0; j < ny; j++) {
        const jn = j + 1 < ny ? j + 1 : 0;
        for (let i = 0; i < nx; i++) {
          const in_ = i + 1 < nx ? i + 1 : 0;
          const c = (k * ny + j) * nx + i;
          const a = 0.5 * (u[c] + u[(k * ny + j) * nx + in_]);
          const b = 0.5 * (v[c] + v[(k * ny + jn) * nx + i]);
          const d = 0.5 * (w[c] + w[c + nxy]);
          uc[c] = a; vc[c] = b; wc[c] = d;
          const ax = Math.abs(a) / dx, ay = Math.abs(b) / dy, az = Math.abs(d) * idz;
          const rate = ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az);
          if (rate > mx) mx = rate;
        }
      }
    }
    this.cflRate = mx;
    this.uc0.set(uc); this.vc0.set(vc); this.wc0.set(wc);
  }

  private masks() {
    const { nx, ny } = this;
    this.act.fill(0); this.rowAct.fill(0); this.colAct.fill(0);
    if (!this.anyHydro && this.chargeMax < 1e-16) return;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!this.colHydro[j * nx + i]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = (j + dj + ny) % ny, ii = (i + di + nx) % nx;
        this.act[jj * nx + ii] = 1;
      }
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (this.act[j * nx + i]) { this.rowAct[j] = 1; this.colAct[i] = 1; }
  }

  // ---------------------------------------------------------------- advection (flux-form, mass-weighted, van Leer limiter)
  private massSweep(d: number, Min: Float32Array, Mout: Float32Array) {
    const { nx, ny, nz, nxy, dt } = this;
    if (d === 0) {
      const c = dt / this.g.dx;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const b = (k * ny + j) * nx;
        for (let i = 0; i < nx; i++) Mout[b + i] = Min[b + i] - c * this.rhoC[k] * (this.u[b + (i + 1 < nx ? i + 1 : 0)] - this.u[b + i]);
      }
    } else if (d === 1) {
      const c = dt / this.g.dy;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const b = (k * ny + j) * nx, bn = (k * ny + (j + 1 < ny ? j + 1 : 0)) * nx;
        for (let i = 0; i < nx; i++) Mout[b + i] = Min[b + i] - c * this.rhoC[k] * (this.v[bn + i] - this.v[b + i]);
      }
    } else {
      for (let k = 0; k < nz; k++) {
        const c = dt / this.g.dz[k], rf1 = this.rhoF[k + 1], rf0 = this.rhoF[k];
        for (let ij = 0; ij < nxy; ij++) Mout[k * nxy + ij] = Min[k * nxy + ij] - c * (rf1 * this.w[(k + 1) * nxy + ij] - rf0 * this.w[k * nxy + ij]);
      }
    }
  }

  private sweepX(phi: Float32Array, Min: Float32Array, Mout: Float32Array, masked: boolean) {
    const { nx, ny, nz, u, bufX: buf, fluxX: F } = this;
    const cdx = this.dt / this.g.dx;
    for (let k = 0; k < nz; k++) {
      const rho = this.rhoC[k];
      for (let j = 0; j < ny; j++) {
        if (masked && !this.rowAct[j]) continue;
        const base = (k * ny + j) * nx;
        for (let i = 0; i < nx; i++) buf[i + 2] = phi[base + i];
        buf[0] = phi[base + nx - 2]; buf[1] = phi[base + nx - 1]; buf[nx + 2] = phi[base]; buf[nx + 3] = phi[base + 1];
        for (let i = 0; i < nx; i++) {
          const vel = u[base + i], c = vel * cdx;
          let pu: number, puu: number, pd: number;
          if (c >= 0) { pu = buf[i + 1]; puu = buf[i]; pd = buf[i + 2]; } else { pu = buf[i + 2]; puu = buf[i + 3]; pd = buf[i + 1]; }
          const dU = pu - puu, dD = pd - pu;
          const s = dU * dD > 0 ? (2 * dU * dD) / (dU + dD) : 0;
          F[i] = rho * vel * (pu + 0.5 * (1 - (c < 0 ? -c : c)) * s);
        }
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          phi[idx] = (Min[idx] * phi[idx] - cdx * (F[i + 1 < nx ? i + 1 : 0] - F[i])) / Mout[idx];
        }
      }
    }
  }

  private sweepY(phi: Float32Array, Min: Float32Array, Mout: Float32Array, masked: boolean) {
    const { nx, ny, nz, v } = this;
    const Fy = this.fluxPlane;
    const cdy = this.dt / this.g.dy;
    for (let k = 0; k < nz; k++) {
      const rho = this.rhoC[k];
      const kb = k * ny * nx;
      for (let j = 0; j < ny; j++) {
        const jm1 = ((j + ny - 1) % ny) * nx, jm2 = ((j + ny - 2) % ny) * nx, j0 = j * nx, jp1 = ((j + 1) % ny) * nx;
        for (let i = 0; i < nx; i++) {
          if (masked && !this.colAct[i]) continue;
          const vel = v[kb + j0 + i], c = vel * cdy;
          let pu: number, puu: number, pd: number;
          if (c >= 0) { pu = phi[kb + jm1 + i]; puu = phi[kb + jm2 + i]; pd = phi[kb + j0 + i]; }
          else { pu = phi[kb + j0 + i]; puu = phi[kb + jp1 + i]; pd = phi[kb + jm1 + i]; }
          const dU = pu - puu, dD = pd - pu;
          const s = dU * dD > 0 ? (2 * dU * dD) / (dU + dD) : 0;
          Fy[j0 + i] = rho * vel * (pu + 0.5 * (1 - (c < 0 ? -c : c)) * s);
        }
      }
      for (let j = 0; j < ny; j++) {
        const j0 = j * nx, jn = ((j + 1) % ny) * nx;
        for (let i = 0; i < nx; i++) {
          if (masked && !this.colAct[i]) continue;
          const idx = kb + j0 + i;
          phi[idx] = (Min[idx] * phi[idx] - cdy * (Fy[jn + i] - Fy[j0 + i])) / Mout[idx];
        }
      }
    }
  }

  private sweepZ(phi: Float32Array, Min: Float32Array, Mout: Float32Array, masked: boolean) {
    const { nz, nxy, w } = this;
    const Fz = this.fluxPlane, dt = this.dt, dz = this.g.dz;
    for (let ij = 0; ij < nxy; ij++) if (!masked || this.act[ij]) Fz[ij] = this.rhoF[0] * w[ij] * phi[ij];
    for (let k = 1; k < nz; k++) {
      const rf = this.rhoF[k], km1 = (k - 1) * nxy, k0 = k * nxy, km2 = Math.max(k - 2, 0) * nxy, kp1 = Math.min(k + 1, nz - 1) * nxy;
      for (let ij = 0; ij < nxy; ij++) {
        if (masked && !this.act[ij]) continue;
        const vel = w[k0 + ij];
        let pu: number, puu: number, pd: number, c: number;
        if (vel >= 0) { c = (vel * dt) / dz[k - 1]; pu = phi[km1 + ij]; puu = phi[km2 + ij]; pd = phi[k0 + ij]; }
        else { c = (-vel * dt) / dz[k]; pu = phi[k0 + ij]; puu = phi[kp1 + ij]; pd = phi[km1 + ij]; }
        const dU = pu - puu, dD = pd - pu;
        const s = dU * dD > 0 ? (2 * dU * dD) / (dU + dD) : 0;
        Fz[k0 + ij] = rf * vel * (pu + 0.5 * (1 - c) * s);
      }
    }
    for (let ij = 0; ij < nxy; ij++) if (!masked || this.act[ij]) Fz[nz * nxy + ij] = 0;
    for (let k = 0; k < nz; k++) {
      const c = dt / dz[k];
      for (let ij = 0; ij < nxy; ij++) {
        if (masked && !this.act[ij]) continue;
        const idx = k * nxy + ij;
        phi[idx] = (Min[idx] * phi[idx] - c * (Fz[(k + 1) * nxy + ij] - Fz[idx])) / Mout[idx];
      }
    }
  }

  private advectFields(fields: Float32Array[], masked: boolean, order: number[]) {
    const Ms = [this.M0, this.M1, this.M2, this.M3];
    for (const f of fields) {
      for (let s = 0; s < 3; s++) {
        const d = order[s];
        if (d === 0) this.sweepX(f, Ms[s], Ms[s + 1], masked);
        else if (d === 1) this.sweepY(f, Ms[s], Ms[s + 1], masked);
        else this.sweepZ(f, Ms[s], Ms[s + 1], masked);
      }
    }
  }

  // ---------------------------------------------------------------- SGS turbulence: Deardorff 1.5-order TKE closure
  private turbulence(dt: number) {
    const { nx, ny, nz, nxy, uc, vc, wc, u, v, w, tke, Km, Kh, th, qv } = this;
    const g = this.g, pr = this.prof;
    for (let k = 0; k < nz; k++) {
      const kp = Math.min(nz - 1, k + 1), km = Math.max(0, k - 1);
      const dzc = g.zc[kp] - g.zc[km];
      const delta = Math.cbrt(g.dx * g.dy * g.dz[k]);
      const kmax = (0.3 * g.dz[k] * g.dz[k]) / dt;
      for (let j = 0; j < ny; j++) {
        const jp = (j + 1) % ny, jm = (j + ny - 1) % ny;
        for (let i = 0; i < nx; i++) {
          const ip = (i + 1) % nx, im = (i + nx - 1) % nx;
          const c = (k * ny + j) * nx + i;
          const cu = (k * ny + j) * nx;
          const dudz = (uc[kp * nxy + j * nx + i] - uc[km * nxy + j * nx + i]) / dzc;
          const dvdz = (vc[kp * nxy + j * nx + i] - vc[km * nxy + j * nx + i]) / dzc;
          const dwdx = (wc[cu + ip] - wc[cu + im]) / (2 * g.dx);
          const dwdy = (wc[(k * ny + jp) * nx + i] - wc[(k * ny + jm) * nx + i]) / (2 * g.dy);
          const dudy = (uc[(k * ny + jp) * nx + i] - uc[(k * ny + jm) * nx + i]) / (2 * g.dy);
          const dvdx = (vc[cu + ip] - vc[cu + im]) / (2 * g.dx);
          const dudx = (u[cu + ip] - u[c]) / g.dx;
          const dvdy = (v[(k * ny + jp) * nx + i] - v[c]) / g.dy;
          const dwdz = (w[c + nxy] - w[c]) / g.dz[k];
          const S2 = (dudz + dwdx) * (dudz + dwdx) + (dvdz + dwdy) * (dvdz + dwdy) + (dudy + dvdx) * (dudy + dvdx)
            + 2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz);
          const cp = kp * nxy + j * nx + i, cm = km * nxy + j * nx + i;
          const thvp = th[cp] * (1 + 0.61 * qv[cp]), thvm = th[cm] * (1 + 0.61 * qv[cm]);
          let N2 = ((G / pr.thv[k]) * (thvp - thvm)) / dzc;
          if (N2 > 0 && this.qc[c] + this.qi[c] > 1e-5) N2 *= 0.2;
          let e = tke[c];
          const sq = Math.sqrt(e);
          let l = delta;
          if (N2 > 1e-8) l = Math.min(delta, (0.76 * sq) / Math.sqrt(N2));
          l = Math.max(l, 0.05 * delta);
          const km_ = Math.min(kmax, 0.1 * l * sq + 0.3);
          const kh_ = Math.min(kmax, (1 + (2 * l) / delta) * 0.1 * l * sq + 0.3);
          const Ce = 0.19 + (0.51 * l) / delta;
          e += dt * (km_ * S2 - kh_ * N2 - (Ce * e * sq) / l);
          if (e < 1e-4) e = 1e-4; else if (e > 40) e = 40;
          tke[c] = e; Km[c] = km_; Kh[c] = kh_;
        }
      }
    }
  }

  private diffuse(f: Float32Array, K: Float32Array, dt: number, horiz: number) {
    const { nx, ny, nz, nxy, tmp } = this;
    const g = this.g;
    const hx = horiz / (g.dx * g.dx);
    for (let k = 0; k < nz; k++) {
      const rc = this.rhoC[k] * g.dz[k];
      const rfu = k < nz - 1 ? this.rhoF[k + 1] / g.dzf[k + 1] : 0, rfd = k > 0 ? this.rhoF[k] / g.dzf[k] : 0;
      for (let j = 0; j < ny; j++) {
        const jp = (j + 1) % ny, jm = (j + ny - 1) % ny;
        for (let i = 0; i < nx; i++) {
          const c = (k * ny + j) * nx + i;
          const fi = f[c];
          let t = 0;
          if (horiz > 0) {
            const ip = (i + 1) % nx, im = (i + nx - 1) % nx;
            const cb = (k * ny + j) * nx;
            t += hx * ((f[cb + ip] - fi) - (fi - f[cb + im]));
            t += hx * ((f[(k * ny + jp) * nx + i] - fi) - (fi - f[(k * ny + jm) * nx + i]));
          }
          const up = k < nz - 1 ? rfu * 0.5 * (K[c] + K[c + nxy]) * (f[c + nxy] - fi) : 0;
          const dn = k > 0 ? rfd * 0.5 * (K[c] + K[c - nxy]) * (fi - f[c - nxy]) : 0;
          tmp[c] = fi + dt * (t + (up - dn) / rc);
        }
      }
    }
    f.set(tmp);
  }

  // ---------------------------------------------------------------- surface energy balance & large-scale forcing
  private surface(dt: number) {
    const { nxy, nz } = this;
    const pr = this.prof, g = this.g;
    const sun = sunState(this.time);
    this.sunSin = sun.sinElev; this.sunDirV = sun.dir;
    // Detect the sunrise crossing once so the daytime heating depth can grow through the day.
    if (this.prevSin <= 0 && sun.sinElev > 0) this.sunriseT = this.time;
    this.prevSin = sun.sinElev;
    const p0 = pr.pSfc;
    const rho = this.rhoC[0], zc0 = g.zc[0];
    const area = g.dx * g.dy;
    let evap = 0;
    for (let ij = 0; ij < nxy; ij++) {
      const c = this.cols;
      const fW = c.fW[ij], fF = c.fF[ij], fR = Math.min(c.fR[ij], 1 - fF), fG = Math.max(0, 1 - fW - fF - fR);
      // Monin-Obukhov surface layer: iterate u*, theta*, q* and the Obukhov length with
      // Businger-Dyer stability functions. Over water the roughness length follows Charnock
      // (z0 ~ alpha u*^2 / g), so it grows with the wind instead of staying fixed.
      const z0land = Math.exp(fF * Math.log(1.0) + fR * Math.log(0.15) + fG * Math.log(0.05));
      const Ta = this.th[ij] * pr.pi[0];
      const qa = this.qv[ij];
      const Vh = Math.hypot(this.uc0[ij], this.vc0[ij]);
      const V = Math.sqrt(Vh * Vh + 0.6 + 2.5 * this.tke[ij]);
      const Ts = this.Ts[ij];
      const qss = qsl(Ts, p0);
      let z0 = fW > 0.5 ? 5e-4 : z0land;
      let ustar = (0.4 * V) / Math.log(zc0 / z0);
      let tstar = (0.4 * (Ts - Ta)) / Math.log(zc0 / z0);
      let qstar = (0.4 * (qss - qa)) / Math.log(zc0 / z0);
      for (let it = 0; it < 4; it++) {
        if (fW > 0.5) z0 = Math.max(1e-4, (0.014 * ustar * ustar) / G); // Charnock
        const lnz = Math.log(zc0 / z0);
        const L = (-Math.pow(ustar, 3) * Ta) / (0.4 * G * (tstar + 0.61 * Ta * qstar) + 1e-12);
        const x = Math.max(-50, Math.min(50, zc0 / L));
        const y = Math.sqrt(Math.max(0, 1 - 16 * Math.min(0, x)));
        const psiM = x >= 0 ? -5 * x : 2 * Math.log((1 + y) / 2) + Math.log((1 + y * y) / 2) - 2 * Math.atan(y) + Math.PI / 2;
        const psiH = x >= 0 ? -5 * x : 2 * Math.log((1 + y * y) / 2);
        const dm = Math.max(0.5, lnz - psiM), dh = Math.max(0.5, lnz - psiH);
        ustar = (0.4 * V) / dm;
        tstar = (0.4 * (Ts - Ta)) / dh;
        qstar = (0.4 * (qss - qa)) / dh;
      }
      // shortwave: slope-aware direct beam with cloud attenuation
      const sx = -c.dhdx[ij], sy = -c.dhdy[ij];
      const nrm = Math.hypot(sx, sy, 1);
      const ndots = (sx * sun.dir[0] + sun.dir[1] + sy * sun.dir[2]) / nrm;
      const slopeF = sun.sinElev > 0.05 ? Math.min(1.7, Math.max(0.3, ndots / sun.sinElev)) : 1;
      const tc = 1 / (1 + 0.08 * this.tauCol[ij]);
      const S = sun.sinElev > 0 ? 1000 * Math.pow(sun.sinElev, 1.1) * tc * slopeF : 0;
      this.swd[ij] = S;
      const alb = fW * 0.06 + fF * 0.12 + fR * 0.25 + fG * 0.2;
      const Cs = fW * 3e7 + (1 - fW) * (fF * 4e5 + fR * 5e5 + fG * 2.5e5);
      const soil = this.soilM[ij];
      const wet = fW > 0.5 ? 1 : this.surfW[ij] > 0.2 ? 1 : Math.min(1, Math.max(fF > 0.5 ? 0.35 : 0.05, soil / 0.5));
      const H = rho * CP * ustar * tstar;
      const evapMul = fW > 0.5 ? this.params.lakeEvap : this.params.landEvap;
      let LE = rho * LV * ustar * qstar * wet * evapMul;
      if (LE < 0) LE *= 0.3;
      // Downwelling longwave: Brutsaert clear-sky emissivity from boundary-layer vapour pressure,
      // lifted toward blackbody by the column's cloud optical depth.
      const eHpa = (qa * p0) / (EPS + qa) / 100;
      const LWdown = surfaceEmissivity(eHpa, Ta, this.tauCol[ij]) * SIGMA * Ta * Ta * Ta * Ta;
      const LWnet = 0.97 * SIGMA * Ts * Ts * Ts * Ts - 0.97 * LWdown;
      const Gf = fW > 0.5 ? 0 : 6 * (Ts - this.Tdeep[ij]);
      this.Ts[ij] = Ts + (dt * ((1 - alb) * S - LWnet - H - LE - Gf)) / Cs;
      const noise = 1 + 0.5 * (this.rng() - 0.5); // stochastic sub-grid thermal triggering of the flux
      this.Hf[ij] = H * (H > 0 ? noise : 1); this.LEf[ij] = LE;
      this.ustar[ij] = ustar;
      this.srcEnergy += (H + LE) * dt * area;
      evap += (LE / LV) * dt * area;
      // soil moisture / surface water budget (kg m-2)
      if (fW < 0.5) {
        const prec = this.surfPrec[ij] * dt;
        let m = soil + (prec - Math.max(0, LE / LV) * dt) / 100;
        let sw = this.surfW[ij];
        if (m > 1) { sw += (m - 1) * 100; m = 1; }
        if (m < 0.02) m = 0.02;
        const ev = Math.min(sw, (Math.max(0, LE / LV) * dt) * 0.5);
        sw -= ev;
        this.soilM[ij] = m; this.surfW[ij] = Math.max(0, sw * 0.9995);
      }
      const rr = this.surfPrec[ij] * 3600;
      this.rainRate[ij] = 0.6 * this.rainRate[ij] + 0.4 * rr;
    }
    this.evapCum += evap;
    void nz;
    // simple runoff: surface water drains to lower neighbours (mm)
    if (this.step_n % 3 === 0) {
      const { nx, ny } = this;
      const tmp = this.tmp; tmp.fill(0);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = j * nx + i, s = this.surfW[c];
        if (s < 0.01) continue;
        const h = this.cols.h[c];
        const nb = [j * nx + ((i + 1) % nx), j * nx + ((i + nx - 1) % nx), ((j + 1) % ny) * nx + i, ((j + ny - 1) % ny) * nx + i];
        for (const q of nb) {
          const dh = h - this.cols.h[q];
          if (dh > 0) { const f = s * Math.min(0.1, 0.01 * dh); tmp[q] += f; tmp[c] -= f; }
        }
      }
      for (let c = 0; c < this.nxy; c++) this.surfW[c] = Math.max(0, this.surfW[c] + tmp[c]);
    }
  }

  private forcing(dt: number) {
    const { nx, ny, nz, nxy } = this;
    const g = this.g, pr = this.prof;
    const rho0 = this.rhoC[0], dz0 = g.dz[0], Pi0 = pr.pi[0];
    const area = g.dx * g.dy;
    // f-plane Coriolis at the storm's nominal 38 N latitude. Add the inertial tendency after the
    // synoptic relaxation so background shear and storm-relative helicity stay consistent.
    const fCor = 2 * 7.2921159e-5 * Math.sin(38 * Math.PI / 180);
    // surface fluxes into lowest layer; drag
    for (let ij = 0; ij < nxy; ij++) {
      this.th[ij] += (this.Hf[ij] * dt) / (rho0 * CP * Pi0 * dz0);
      this.qv[ij] += (this.LEf[ij] * dt) / (rho0 * LV * dz0);
      if (this.qv[ij] < 0) this.qv[ij] = 0;
      const us = this.ustar[ij];
      // Deacon-style gustiness: sub-grid TKE surges the effective wind in the drag law, so
      // gusty boundary layers erode momentum faster near the surface than the mean wind alone.
      const cd = (us * us) / Math.max(1, Math.hypot(this.uc0[ij], this.vc0[ij]) + 0.5 + 0.8 * Math.sqrt(this.tke[ij]));
      const f = 1 / (1 + (dt * cd) / dz0);
      this.uc[ij] *= f; this.vc[ij] *= f;
      // surface-driven sub-grid TKE
      this.tke[ij] += (dt * us * us * us) / (0.4 * g.zc[0]) * 0.5;
    }
    const mu = new Float64Array(nz), mv = new Float64Array(nz), mth = new Float64Array(nz), mq = new Float64Array(nz);
    for (let k = 0; k < nz; k++) {
      let su = 0, sv = 0, st = 0, sq = 0;
      for (let ij = 0; ij < nxy; ij++) { const c = k * nxy + ij; su += this.uc[c]; sv += this.vc[c]; st += this.th[c]; sq += this.qv[c]; }
      mu[k] = su / nxy; mv[k] = sv / nxy; mth[k] = st / nxy; mq[k] = sq / nxy;
    }
    const sinE = sunState(this.time).sinElev;
    const dayH = Math.max(0, sinE), nightH = Math.max(0, -sinE);
    for (let k = 0; k < nz; k++) {
      const z = g.zc[k];
      const tau = z < 1500 ? 3600 : 2400;
      const du = ((pr.u[k] - mu[k]) * dt) / tau, dv = ((pr.v[k] - mv[k]) * dt) / tau;
      // Interactive broadband radiation (clear-sky LW shaped by humidity, cloud-top/base LW,
      // water-vapour + ozone SW heating) replaces the old flat -1.5 K/day; weak mean-theta
      // relaxation (synoptic advection) and mean-moisture advection remain.
      const radBase = 0; void radBase;
      // Diurnal boundary-layer cycle: solar heating deepens and moistens the mixed layer
      // through the day (surface CAPE builds to its afternoon peak), nocturnal radiative
      // cooling caps the lowest levels (CAPE collapses overnight). The CAPE slider sets the
      // sounding; the sun makes the realised instability live instead of static.
      // The mixed-layer depth zi grows with daylight hours since sunrise (~350 m at sunrise
      // to ~2.2 km by late afternoon) — real PBLs deepen as surface heating accumulates,
      // which is why convection fires in the afternoon rather than at dawn.
      const dayHrs = this.sunriseT > 0 ? Math.min(8, Math.max(0, (this.time - this.sunriseT) / 3600)) : 0;
      const zi = 350 + 235 * dayHrs;
      const dthDiurnal = dt * (dayH * (0.85 / 3600) * Math.max(0, 1 - z / zi)
        - nightH * (0.6 / 3600) * Math.exp(-z / 240));
      const dth = ((pr.th[k] - mth[k]) * dt) / (z > 12500 ? 1800 : 5 * 3600) + dthDiurnal;
      const dq = z < zi * 2
        ? ((pr.qv[k] - mq[k]) * dt) / (3 * 3600) + dt * dayH * 9e-8 * Math.max(0, 1 - z / (zi * 2))
        : 0;
      const sponge = z > 12500 ? 0.012 * Math.pow((z - 12500) / 2500, 2) : 0;
      const sf = 1 / (1 + sponge * dt);
      for (let ij = 0; ij < nxy; ij++) {
        const c = k * nxy + ij;
        const uOld = this.uc[c], vOld = this.vc[c];
        this.uc[c] = uOld + du + fCor * vOld * dt;
        this.vc[c] = vOld + dv - fCor * uOld * dt;
        this.th[c] += dth; this.qv[c] += dq;
        this.wc[c] *= sf;
      }
      const m = this.rhoC[k] * g.dz[k] * area * nxy;
      this.nudgeWater += m * dq;
      this.srcEnergy += m * (CP * pr.pi[k] * dth + LV * dq);
    }
    void nx; void ny;
  }

  private facesFromCentered() {
    const { nx, ny, nz, nxy, u, v, w, uc, vc, wc, uc0, vc0, wc0 } = this;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const jm = (j + ny - 1) % ny;
      for (let i = 0; i < nx; i++) {
        const im = (i + nx - 1) % nx;
        const c = (k * ny + j) * nx + i;
        u[c] += 0.5 * ((uc[c] - uc0[c]) + (uc[(k * ny + j) * nx + im] - uc0[(k * ny + j) * nx + im]));
        v[c] += 0.5 * ((vc[c] - vc0[c]) + (vc[(k * ny + jm) * nx + i] - vc0[(k * ny + jm) * nx + i]));
        if (k > 0) w[c] += 0.5 * ((wc[c] - wc0[c]) + (wc[c - nxy] - wc0[c - nxy]));
      }
    }
  }

  // ---------------------------------------------------------------- buoyancy (virtual potential temperature + condensate loading)
  private buoyancy(dt: number) {
    const { nz, nxy, w } = this;
    const pr = this.prof;
    const B = this.tmp;
    for (let k = 0; k < nz; k++) {
      let s = 0;
      for (let ij = 0; ij < nxy; ij++) {
        const c = k * nxy + ij;
        const thv = this.th[c] * (1 + 0.61 * this.qv[c]);
        let b = G * ((thv - pr.thv[k]) / pr.thv[k] - (this.qc[c] + this.qi[c] + this.qr[c] + this.qs[c] + this.qg[c]));
        // Entrainment dilution: rising parcels mix with dry environmental air and lose
        // buoyancy (real updrafts are 10-30% diluted); downdrafts evaporatively cooled
        // are diluted a little less. This is what caps real updraft speeds below the
        // theoretical CAPE limit.
        const wUp = this.wc[c];
        b *= 1 - (b > 0 ? 0.24 * Math.min(1, wUp / 22) : 0.10 * Math.min(1, -wUp / 14));
        B[c] = b; s += b;
      }
      s /= nxy;
      for (let ij = 0; ij < nxy; ij++) B[k * nxy + ij] -= s; // horizontal-mean buoyancy is balanced by the mean hydrostatic pressure
    }
    for (let k = 1; k < nz; k++) {
      for (let ij = 0; ij < nxy; ij++) {
        w[k * nxy + ij] += dt * 0.5 * (B[k * nxy + ij] + B[(k - 1) * nxy + ij]);
      }
    }
  }

  /** Kinematic lower boundary condition: flow over terrain slopes induces vertical motion at the surface. */
  private terrainBC() {
    const { nx, ny, nxy, u, v, w } = this;
    let s = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const a = 0.5 * (u[c] + u[j * nx + (i + 1) % nx]), b = 0.5 * (v[c] + v[((j + 1) % ny) * nx + i]);
      const wb = 0.7 * (a * this.cols.dhdx[c] + b * this.cols.dhdy[c]);
      w[c] = wb; s += wb;
    }
    s /= nxy;
    for (let c = 0; c < nxy; c++) w[c] -= s;
  }

  // ---------------------------------------------------------------- pressure projection
  private divergence(out: Float32Array | null, scale: number): number {
    const { nx, ny, nz, nxy, u, v, w } = this;
    const g = this.g;
    let mx = 0;
    for (let k = 0; k < nz; k++) {
      const rcdz = 1 / (this.rhoC[k] * g.dz[k]);
      for (let j = 0; j < ny; j++) {
        const jn = (j + 1) % ny;
        for (let i = 0; i < nx; i++) {
          const c = (k * ny + j) * nx + i;
          const D = (u[(k * ny + j) * nx + (i + 1) % nx] - u[c]) / g.dx + (v[(k * ny + jn) * nx + i] - v[c]) / g.dy
            + (this.rhoF[k + 1] * w[c + nxy] - this.rhoF[k] * w[c]) * rcdz;
          if (out) out[c] = D * scale;
          const a = D < 0 ? -D : D;
          if (a > mx) mx = a;
        }
      }
    }
    return mx;
  }

  private project(dt: number) {
    const { nx, ny, nz, nxy, u, v, w, pi } = this;
    const g = this.g;
    for (let k = 1; k < nz; k++) {
      let s = 0;
      for (let ij = 0; ij < nxy; ij++) s += w[k * nxy + ij];
      s /= nxy;
      for (let ij = 0; ij < nxy; ij++) w[k * nxy + ij] -= s;
    }
    this.divergence(this.rhs, 1 / dt);
    this.poisP.solve(this.rhs, pi);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const jm = (j + ny - 1) % ny;
      for (let i = 0; i < nx; i++) {
        const im = (i + nx - 1) % nx;
        const c = (k * ny + j) * nx + i;
        u[c] -= (dt * (pi[c] - pi[(k * ny + j) * nx + im])) / g.dx;
        v[c] -= (dt * (pi[c] - pi[(k * ny + jm) * nx + i])) / g.dy;
        if (k > 0) w[c] -= (dt * (pi[c] - pi[c - nxy])) / g.dzf[k];
      }
    }
  }

  // ---------------------------------------------------------------- electric field
  electricField() {
    const { nx, ny, nz, nxy, phi, emag } = this;
    const g = this.g;
    const rhs = this.rhs;
    // Surface charge relaxes: a slow leak to ground (wet soil, vegetation contact) plus a
    // fast corona bleed once induction has pushed the field just above the surface past the
    // corona-onset level (~1/4 of breakdown) — the same feedback that limits real fields
    // under thunderstorms to a few tens of kV/m. Electric field is solved every 4 steps, so
    // this block covers 4·dt of decay each time it runs.
    let qgMax = 0;
    {
      const dec = Math.exp((-4 * this.dt) / 900);
      const cor = this.thresholdE(0) * 0.25;
      for (let ij = 0; ij < nxy; ij++) {
        let qg = this.qGround[ij];
        if (qg === 0) continue;
        qg *= dec;
        const eg = Math.abs(this.ez[ij]);
        if (eg > cor) qg *= Math.exp(((-4 * this.dt) / 180) * Math.min(4, (eg - cor) / cor));
        if (Math.abs(qg) < 1e-15) qg = 0;
        this.qGround[ij] = qg;
        const m = Math.abs(qg); if (m > qgMax) qgMax = m;
      }
    }
    this.qgMax = qgMax;
    for (let k = 0; k < nz; k++) {
      const r = this.rhoC[k] / EPS0;
      for (let ij = 0; ij < nxy; ij++) rhs[k * nxy + ij] = -r * (this.qh[k * nxy + ij] + this.ql[k * nxy + ij]);
    }
    // Ground sheet: qGround is a surface density [C/m²]; over the lowest layer it acts as
    // a volume charge qGround/dz0, so it enters the rhs with the same form as cloud charge.
    for (let ij = 0; ij < nxy; ij++) {
      if (this.qGround[ij] !== 0) rhs[ij] -= this.qGround[ij] / (g.dz[0] * EPS0);
    }
    this.poisE.solve(rhs, phi);
    let mx = 0, mr = 0, mxEz0 = 0;
    for (let k = 0; k < nz; k++) {
      const kp = Math.min(nz - 1, k + 1), km = Math.max(0, k - 1);
      const dzc = g.zc[kp] - g.zc[km];
      const eth = this.thresholdE(k);
      for (let j = 0; j < ny; j++) {
        const jp = (j + 1) % ny, jm = (j + ny - 1) % ny;
        for (let i = 0; i < nx; i++) {
          const ip = (i + 1) % nx, im = (i + nx - 1) % nx;
          const c = (k * ny + j) * nx + i;
          let ez: number;
          if (k === 0) ez = -(phi[c + nxy] - 0) / (g.zc[1] - 0 + 0) * 1.0;
          else if (k === nz - 1) ez = -(0 - phi[c - nxy]) / (g.zf[nz] - g.zc[nz - 2]);
          else ez = -(phi[kp * nxy + j * nx + i] - phi[km * nxy + j * nx + i]) / dzc;
          if (k === 0) ez = -(phi[c + nxy] - 0) / (g.zc[1]);
          const ex = -(phi[(k * ny + j) * nx + ip] - phi[(k * ny + j) * nx + im]) / (2 * g.dx);
          const ey = -(phi[(k * ny + jp) * nx + i] - phi[(k * ny + jm) * nx + i]) / (2 * g.dy);
          const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
          emag[c] = e; this.ez[c] = ez;
          if (e > mx) mx = e;
          if (e / eth > mr) mr = e / eth;
          if (k === 0) { const m0 = Math.abs(ez); if (m0 > mxEz0) mxEz0 = m0; }
        }
      }
    }
    this.stats.maxE = mx; this.stats.maxEratio = mr; this.stats.maxEz0 = mxEz0;
  }
  /** Effective grid-scale breakdown field: conventional E_k(z)=2.16e5*rho/rho0 reduced by 0.45 for unresolved sub-grid charge pockets. */
  thresholdE(k: number): number { return 2.16e5 * 0.45 * (this.rhoC[k] / this.rhoC[0]); }

  // ---------------------------------------------------------------- one model time step
  step() {
    const dt = this.dt;
    const order = this.step_n % 2 === 0 ? [0, 1, 2] : [2, 1, 0];
    this.centered();
    this.surface(dt);
    this.turbulence(dt);
    this.masks();
    // mass sweeps for the chosen splitting order
    this.massSweep(order[0], this.M0, this.M1);
    this.massSweep(order[1], this.M1, this.M2);
    this.massSweep(order[2], this.M2, this.M3);
    this.advectFields([this.uc, this.vc, this.wc, this.th, this.qv], false, order);
    if (this.anyHydro || this.chargeMax > 1e-16) this.advectFields([this.qc, this.qi, this.qr, this.qs, this.qg, this.qh, this.ql], true, order);
    // sub-grid mixing: momentum (K_m + weak horizontal filter), heat/moisture (K_h)
    const hf = Math.min(0.02 * this.g.dx * this.g.dx / dt, 400);
    this.diffuse(this.uc, this.Km, dt, hf); this.diffuse(this.vc, this.Km, dt, hf); this.diffuse(this.wc, this.Km, dt, hf);
    this.diffuse(this.th, this.Kh, dt, 0); this.diffuse(this.qv, this.Kh, dt, 0);
    this.diffuse(this.tke, this.Kh, dt, 0);   // sub-grid TKE is transported by the same mixing
    if (this.anyHydro) { this.diffuse(this.qc, this.Kh, dt, 0); this.diffuse(this.qi, this.Kh, dt, 0); }
    radiationTendencies(this, this.sunSin);
    this.forcing(dt);
    this.facesFromCentered();
    microphysics(this, dt);
    // Electrification is computed from the updated hydrometeor spectra, before sedimentation
    // carries graupel/ice charge downward and conductivity relaxes the screening layers.
    chargeSeparation(this, dt);
    sedimentation(this, dt);
    if (this.chargeMax > 1e-16 || this.anyHydro) chargeDecay(this, dt);
    // Sub-grid vortex feedback is applied before buoyancy/terrain BC/projection so the pressure
    // solve removes spurious divergence from the convergent Rankine inflow.
    this.tornado.update(this, dt);
    this.buoyancy(dt);
    this.terrainBC();
    this.project(dt);
    this.time += dt; this.step_n++;
    // Solving electrostatics is a second full FFT/tridiagonal pass. During a multicell outbreak
    // it was run every other step, doubling the solver's most expensive pass. Every fourth step
    // is enough at the model's 2-10 s timestep and also halves lightning-burst bookkeeping.
    if (this.step_n % 4 === 0 && (this.chargeMax > 1e-14 || this.qgMax > 1e-9)) { this.electricField(); for (const e of tryLightning(this)) this.flashEvents.push(e); }
    else if (this.chargeMax <= 1e-14) { this.stats.maxE = 0; this.stats.maxEratio = 0; this.stats.maxEz0 = 0; }
    if (this.step_n % 3 === 0) this.computeStats();
    this.dt = Math.max(2, Math.min(10, 0.6 / Math.max(1e-6, this.cflRate)));
  }

  totalMSE(): number {
    const { nz, nxy } = this;
    let s = 0;
    const area = this.g.dx * this.g.dy;
    for (let k = 0; k < nz; k++) {
      const Pi = this.prof.pi[k];
      let sk = 0;
      for (let ij = 0; ij < nxy; ij++) {
        const c = k * nxy + ij;
        sk += CP * this.th[c] * Pi + G * this.g.zc[k] + LV * this.qv[c] - LF * (this.qi[c] + this.qs[c] + this.qg[c]);
      }
      s += sk * this.rhoC[k] * this.g.dz[k];
    }
    return s * area;
  }

  computeStats() {
    const { nx, ny, nz, nxy } = this;
    const S = this.stats, area = this.g.dx * this.g.dy;
    let maxW = 0, minW = 0, maxQc = 0, maxQi = 0, maxQr = 0, maxQg = 0, KE = 0, water = 0, cloudCols = 0, qpos = 0, qneg = 0;
    let uhMax = 0;
    for (let k = 0; k < nz; k++) {
      const rd = this.rhoC[k] * this.g.dz[k] * area;
      for (let ij = 0; ij < nxy; ij++) {
        const c = k * nxy + ij;
        const w = this.wc0[c];
        const wc = 0.5 * (this.w[c] + this.w[c + nxy]);
        if (wc > maxW) maxW = wc; if (wc < minW) minW = wc;
        if (this.qc[c] > maxQc) maxQc = this.qc[c]; if (this.qi[c] > maxQi) maxQi = this.qi[c];
        if (this.qr[c] > maxQr) maxQr = this.qr[c]; if (this.qg[c] > maxQg) maxQg = this.qg[c];
        const uu = this.u[c], vv = this.v[c];
        KE += 0.5 * rd * (uu * uu + vv * vv + wc * wc);
        water += rd * (this.qv[c] + this.qc[c] + this.qi[c] + this.qr[c] + this.qs[c] + this.qg[c]);
        const ch = this.rhoC[k] * (this.qh[c] + this.ql[c]) * rd / this.rhoC[k] / this.g.dz[k] * this.g.dz[k] / this.rhoC[k];
        void ch; void w;
        const rq = (this.qh[c] + this.ql[c]) * rd;
        if (rq > 0) qpos += rq; else qneg += rq;
      }
    }
    for (let ij = 0; ij < nxy; ij++) {
      let cl = 0;
      for (let k = 0; k < nz && !cl; k++) if (this.qc[k * nxy + ij] + this.qi[k * nxy + ij] > 1e-5) cl = 1;
      cloudCols += cl;
    }
    // updraft helicity (2-5 km): w * vertical vorticity
    for (let k = 0; k < nz; k++) {
      const z = this.g.zc[k];
      if (z < 2000 || z > 5000) continue;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        const zeta = (this.vc[(k * ny + j) * nx + (i + 1) % nx] - this.vc[(k * ny + j) * nx + (i + nx - 1) % nx]) / (2 * this.g.dx)
          - (this.uc[(k * ny + (j + 1) % ny) * nx + i] - this.uc[(k * ny + (j + ny - 1) % ny) * nx + i]) / (2 * this.g.dy);
        const wv = 0.5 * (this.w[c] + this.w[c + nxy]);
        if (wv > 0) { const uh = wv * zeta * this.g.dz[k] * 3; if (uh > uhMax) uhMax = uh; }
      }
    }
    let maxRain = 0, tsSum = 0, cp = 0, cpMin = 0;
    let thMean = 0;
    for (let ij = 0; ij < nxy; ij++) thMean += this.th[ij];
    thMean /= nxy;
    for (let ij = 0; ij < nxy; ij++) {
      if (this.rainRate[ij] > maxRain) maxRain = this.rainRate[ij];
      tsSum += this.Ts[ij];
      const d = this.th[ij] - thMean;
      if (d < -1.5) cp++;
      if (d < cpMin) cpMin = d;
    }
    const mxDiv = this.divergence(null, 1);
    S.maxW = maxW; S.minW = minW; S.maxQc = maxQc; S.maxQi = maxQi; S.maxQr = maxQr; S.maxQg = maxQg; S.maxRain = maxRain;
    S.KE = KE; S.waterTotal = water; S.maxDiv = mxDiv; S.cfl = this.cflRate * this.dt;
    S.cloudFrac = cloudCols / nxy; S.coldPool = cp / nxy; S.coldPoolMin = cpMin; S.meanTs = tsSum / nxy - 273.15;
    S.maxUH = uhMax; S.precipCum = this.precipCum; S.flashes = this.flashCount;
    S.chargePos = qpos; S.chargeNeg = qneg;
    const T = this.tornado.state;
    S.tornadoActive = T.active ? 1 : 0; S.tornadoIntensity = T.intensity; S.tornadoPotential = T.potential;
    S.tornadoEF = T.active ? T.ef : -1; S.maxTornadoWind = T.active ? T.maxWind : 0;
    S.tornadoPressure = T.active ? T.pressureDrop : 0;
    S.chargeSep = this.chargeDiag.sepRate + this.chargeDiag.inductiveRate + this.chargeDiag.screeningRate;
    S.chargeTripole = this.chargeDiag.tripole;
    const expected = this.w0Total + this.evapCum - this.precipCum + this.nudgeWater;
    S.waterRes = (water - expected) / Math.max(1, this.w0Total);
    const dM = this.totalMSE() - this.mse0;
    const ref = Math.max(1, Math.abs(this.srcEnergy) + 1e-3 * Math.abs(this.mse0));
    S.energyRes = (dM - this.srcEnergy - this.iceGroundCum * LF * 0) / ref;
    if (S.maxE === undefined) { S.maxE = 0; S.maxEratio = 0; }
    if (S.maxEz0 === undefined) S.maxEz0 = 0;
  }

  /** Remove charge near a lightning channel (called by the lightning module). */
  neutralize(cells: Set<number>, frac: number): number {
    let removed = 0;
    const area = this.g.dx * this.g.dy;
    cells.forEach((c) => {
      const k = Math.floor(c / this.nxy);
      const vol = area * this.g.dz[k] * this.rhoC[k];
      removed += (Math.abs(this.qh[c]) + Math.abs(this.ql[c])) * vol * frac * 0.5;
      this.qh[c] *= 1 - frac; this.ql[c] *= 1 - frac;
    });
    return removed;
  }

  /** Rebuild the clear-sky state from scratch (optionally with a new parameter set). */
  reset(params: SimParams = this.params) {
    this.params = clampParams(params);
    this.env = envForCape(this.g, this.params.cape);
    this.prof = buildProfile(this.g, this.env);
    this.rhoC = this.prof.rho; this.rhoF = this.prof.rhoF;
    this.rng = mulberry32((Math.random() * 1e9) | 0);
    this.tornado.reset(); this.chargeDiag = emptyChargeDiagnostics();
    this.buildSolvers();
    for (let k = 0; k < this.nz; k++) for (let ij = 0; ij < this.nxy; ij++) this.M0[k * this.nxy + ij] = this.rhoC[k];
    this.init();
  }

  /**
   * Live parameter update. Microphysics/surface parameters take effect on the next step; changing the
   * CAPE target rebuilds the environmental sounding (which the model relaxes toward, so the change
   * spreads through the column over the next few simulated hours).
   */
  setParams(next: Partial<SimParams>): SimParams {
    const merged = clampParams({ ...this.params, ...next });
    const capeChanged = Math.abs(merged.cape - this.params.cape) > 1;
    this.params = merged;
    if (capeChanged) {
      this.env = envForCape(this.g, merged.cape);
      this.prof = buildProfile(this.g, this.env);
      this.rhoC = this.prof.rho; this.rhoF = this.prof.rhoF;
      this.buildSolvers();
      for (let k = 0; k < this.nz; k++) for (let ij = 0; ij < this.nxy; ij++) this.M0[k * this.nxy + ij] = this.rhoC[k];
      // Move the existing state most of the way to the new environment so the change is felt in
      // seconds rather than waiting for the multi-hour relaxation. Clouds are left untouched.
      const wgt = 0.65;
      for (let k = 0; k < this.nz; k++) {
        const dth = this.prof.th[k], dqv = this.prof.qv[k];
        for (let ij = 0; ij < this.nxy; ij++) {
          const c = k * this.nxy + ij;
          if (this.qc[c] + this.qi[c] + this.qr[c] + this.qs[c] + this.qg[c] > 1e-6) continue;
          this.th[c] += (dth - this.th[c]) * wgt;
          this.qv[c] += (dqv - this.qv[c]) * wgt;
        }
      }
    }
    return this.params;
  }
}
export { DOMAIN };
