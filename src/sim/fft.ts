// Direct, exact elliptic solver: 2-D FFT in the periodic horizontal plane + tridiagonal solve in the vertical.
// The modified wavenumbers reproduce the discrete 7-point operator exactly, so the pressure projection removes
// divergence to round-off (no iterative convergence tolerance).
export class FFT1 {
  n: number;
  cosT: Float64Array;
  sinT: Float64Array;
  rev: Uint32Array;
  constructor(n: number) {
    if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT length must be a power of two >= 2 (got ${n})`);
    }
    this.n = n;
    this.cosT = new Float64Array(n / 2);
    this.sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cosT[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinT[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  run(re: Float64Array, im: Float64Array, inv: boolean) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sg = inv ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cosT[t];
          const wi = sg * this.sinT[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export class Poisson {
  nx: number; ny: number; nz: number;
  re: Float64Array; im: Float64Array;
  cp: Float64Array; bi: Float64Array;
  aL: Float64Array;
  neumann: boolean;
  fft: FFT1;
  tr: Float64Array; ti: Float64Array;
  /** aL[k]: coeff of x[k-1]; cU[k]: coeff of x[k+1]; bB[k]: diagonal (without horizontal eigenvalue). */
  constructor(nx: number, ny: number, nz: number, dx: number, dy: number,
    aL: Float64Array, bB: Float64Array, cU: Float64Array, neumann: boolean) {
    this.nx = nx; this.ny = ny; this.nz = nz; this.neumann = neumann;
    this.aL = aL;
    const nxy = nx * ny;
    this.re = new Float64Array(nxy * nz);
    this.im = new Float64Array(nxy * nz);
    this.cp = new Float64Array(nxy * nz);
    this.bi = new Float64Array(nxy * nz);
    this.fft = new FFT1(nx);
    this.tr = new Float64Array(Math.max(nx, ny));
    this.ti = new Float64Array(Math.max(nx, ny));
    for (let n = 0; n < ny; n++) {
      const ly = (2 * Math.cos((2 * Math.PI * n) / ny) - 2) / (dy * dy);
      for (let m = 0; m < nx; m++) {
        const lx = (2 * Math.cos((2 * Math.PI * m) / nx) - 2) / (dx * dx);
        const lam = lx + ly;
        const idx = n * nx + m;
        if (neumann && idx === 0) continue;
        let cpPrev = 0;
        for (let k = 0; k < nz; k++) {
          const b = bB[k] + lam;
          const denom = b - (k > 0 ? aL[k] * cpPrev : 0);
          const bi = 1 / denom;
          const cpk = (k < nz - 1 ? cU[k] : 0) * bi;
          this.bi[idx * nz + k] = bi;
          this.cp[idx * nz + k] = cpk;
          cpPrev = cpk;
        }
      }
    }
  }
  private fft2(k: number, inv: boolean) {
    const { nx, ny, re, im, tr, ti } = this;
    const nxy = nx * ny;
    const o = k * nxy;
    for (let j = 0; j < ny; j++) {
      const b = o + j * nx;
      for (let i = 0; i < nx; i++) { tr[i] = re[b + i]; ti[i] = im[b + i]; }
      this.fft.run(tr, ti, inv);
      for (let i = 0; i < nx; i++) { re[b + i] = tr[i]; im[b + i] = ti[i]; }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) { tr[j] = re[o + j * nx + i]; ti[j] = im[o + j * nx + i]; }
      this.fft.run(tr, ti, inv);
      for (let j = 0; j < ny; j++) { re[o + j * nx + i] = tr[j]; im[o + j * nx + i] = ti[j]; }
    }
  }
  solve(rhs: Float32Array, out: Float32Array) {
    const { nx, ny, nz, re, im, cp, bi, aL } = this;
    const nxy = nx * ny;
    for (let i = 0; i < nxy * nz; i++) { re[i] = rhs[i]; im[i] = 0; }
    for (let k = 0; k < nz; k++) this.fft2(k, false);
    for (let idx = 0; idx < nxy; idx++) {
      if (this.neumann && idx === 0) {
        for (let k = 0; k < nz; k++) { re[k * nxy] = 0; im[k * nxy] = 0; }
        continue;
      }
      let pr = 0, pi = 0;
      const base = idx * nz;
      for (let k = 0; k < nz; k++) {
        const o = k * nxy + idx;
        const b = bi[base + k];
        const a = k > 0 ? aL[k] : 0;
        pr = (re[o] - a * pr) * b;
        pi = (im[o] - a * pi) * b;
        re[o] = pr; im[o] = pi;
      }
      for (let k = nz - 2; k >= 0; k--) {
        const o = k * nxy + idx;
        const c = cp[base + k];
        re[o] -= c * re[o + nxy];
        im[o] -= c * im[o + nxy];
      }
    }
    for (let k = 0; k < nz; k++) this.fft2(k, true);
    const s = 1 / nxy;
    for (let i = 0; i < nxy * nz; i++) out[i] = re[i] * s;
  }
}
