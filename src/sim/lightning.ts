// Lightning: bidirectional leader initiation at the grid cell where E / E_break is largest, then stochastic
// dielectric-breakdown (DBM, eta=1.5) growth of branching channels in the solved electric potential.
// A negative-polarity tip climbs toward higher ambient potential, a positive tip toward lower potential; the channel
// (a floating conductor) sits at the mean of the ambient potential along it; contact with the ground (phi=0) grounds it.
import type { Atmosphere } from './atmosphere';

export interface FlashEvent {
  id: number; type: 'CG-' | 'CG+' | 'IC'; simTime: number;
  init: [number, number, number]; strike: [number, number, number] | null;
  segs: Float32Array; // per segment 10 floats: x0,y0,z0,x1,y1,z1, gen, dist, order, width  (world frame: X, up, Z)
  strokes: { t: number; amp: number }[]; ccEnd: number; ccAmp: number; leaderEnd: number;
  chargeC: number; ratio: number;
}

let nextId = 1;

function kFind(zc: Float64Array, z: number): number {
  let lo = 0, hi = zc.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (zc[m] > z) hi = m; else lo = m; }
  return lo;
}

export function phiAt(a: Atmosphere, x: number, y: number, z: number): number {
  const { nx, ny, nz, nxy } = a, g = a.g, phi = a.phi;
  let fx = x / g.dx - 0.5, fy = y / g.dy - 0.5;
  fx = ((fx % nx) + nx) % nx; fy = ((fy % ny) + ny) % ny;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const tx = fx - i0, ty = fy - j0;
  const i1 = (i0 + 1) % nx, j1 = (j0 + 1) % ny;
  const samp = (k: number) => {
    const o = k * nxy;
    const a0 = phi[o + j0 * nx + i0], a1 = phi[o + j0 * nx + i1], b0 = phi[o + j1 * nx + i0], b1 = phi[o + j1 * nx + i1];
    return (a0 * (1 - tx) + a1 * tx) * (1 - ty) + (b0 * (1 - tx) + b1 * tx) * ty;
  };
  if (z <= g.zc[0]) return samp(0) * Math.max(0, z / g.zc[0]);
  if (z >= g.zc[nz - 1]) return samp(nz - 1) * Math.max(0, (g.zf[nz] - z) / (g.zf[nz] - g.zc[nz - 1]));
  const k = kFind(g.zc, z);
  const t = (z - g.zc[k]) / (g.zc[k + 1] - g.zc[k]);
  return samp(k) * (1 - t) + samp(k + 1) * t;
}

interface Tip { x: number; y: number; z: number; s: number; dx: number; dy: number; dz: number; order: number; alive: boolean; node: number; }

export function growFlash(a: Atmosphere, ci: number, ratio: number): FlashEvent {
  const { nx, ny, nxy } = a, g = a.g;
  const rnd = a.rng;
  const k = Math.floor(ci / nxy), ij = ci % nxy, j = Math.floor(ij / nx), i = ij % nx;
  let x = (i + 0.2 + 0.6 * rnd()) * g.dx, y = (j + 0.2 + 0.6 * rnd()) * g.dy;
  let z = g.zf[k] + g.dz[k] * (0.2 + 0.6 * rnd());
  const L = g.dx * nx;
  const ground = (px: number, py: number) => a.terrain.groundHeight(((px % L) + L) % L, ((py % L) + L) % L);
  const gfun = (px: number, py: number, pz: number) => {
    const hag = pz - Math.max(0, ground(px, py));
    return phiAt(a, px, py, pz) * Math.min(1, Math.max(0.02, hag / 900));
  };
  const nodesX: number[] = [x], nodesY: number[] = [y], nodesZ: number[] = [z], nodeGen: number[] = [0], nodeParent: number[] = [-1], nodeOrder: number[] = [0];
  let phiSum = gfun(x, y, z), phiCnt = 1;
  let phiCh = phiSum;
  const tips: Tip[] = [];
  const rdir = () => { const u = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - u * u); return [r * Math.cos(t), u, r * Math.sin(t)]; };
  const d0 = rdir();
  tips.push({ x, y, z, s: 1, dx: d0[0], dy: d0[1], dz: d0[2], order: 0, alive: true, node: 0 });
  tips.push({ x, y, z, s: -1, dx: -d0[0], dy: -d0[1], dz: -d0[2], order: 0, alive: true, node: 0 });
  const EPROP = 1.2e4, ETA = 1.5;
  let grounded = false, strikeNode = -1, strikeSign = 0, attachGen = 0;
  const MAXSEG = 760;
  let gen = 0;
  const NC = 14;
  for (gen = 1; gen <= 170 && nodesX.length < MAXSEG; gen++) {
    let any = false;
    const nt = tips.length;
    for (let ti = 0; ti < nt; ti++) {
      const tp = tips[ti];
      if (!tp.alive) continue;
      any = true;
      const len = 55 + 55 * rnd();
      const dV = EPROP * len;
      let best = -1, tot = 0;
      const cw: number[] = [], cx: number[] = [], cy: number[] = [], cz: number[] = [], cdx: number[] = [], cdy: number[] = [], cdz: number[] = [];
      const phiTip = gfun(tp.x, tp.y, tp.z);
      for (let c = 0; c < NC; c++) {
        const d = rdir();
        const px = tp.x + d[0] * len, py = tp.y + d[1] * len, pz = tp.z + d[2] * len;
        cx.push(px); cy.push(py); cz.push(pz); cdx.push(d[0]); cdy.push(d[1]); cdz.push(d[2]);
        if (pz < 20) { cw.push(0); continue; }
        const pc = gfun(px, py, pz);
        const drive = tp.s * (pc - phiCh);                   // potential difference between channel and candidate site
        const grad = (tp.s * (pc - phiTip)) / len;           // local field component along the step (DBM growth probability ~ E^eta)
        const fwd = Math.max(0, d[0] * tp.dx + d[1] * tp.dy + d[2] * tp.dz);
        const wgt = drive > dV && grad > 0 ? Math.pow(grad / 8000, ETA) * (0.4 + 0.6 * fwd) * (0.6 + 0.8 * rnd()) : 0;
        cw.push(wgt);
        tot += wgt;
      }
      if (tot <= 0) { tp.alive = false; continue; }
      let r = rnd() * tot;
      for (let c = 0; c < NC; c++) { r -= cw[c]; if (r <= 0) { best = c; break; } }
      if (best < 0) best = cw.lastIndexOf(Math.max(...cw));
      const parent = tp.node;
      tp.x = cx[best]; tp.y = cy[best]; tp.z = cz[best];
      tp.dx = 0.5 * tp.dx + 0.5 * cdx[best]; tp.dy = 0.5 * tp.dy + 0.5 * cdy[best]; tp.dz = 0.5 * tp.dz + 0.5 * cdz[best];
      const nl = Math.hypot(tp.dx, tp.dy, tp.dz) || 1; tp.dx /= nl; tp.dy /= nl; tp.dz /= nl;
      nodesX.push(tp.x); nodesY.push(tp.y); nodesZ.push(tp.z); nodeGen.push(gen); nodeParent.push(parent); nodeOrder.push(tp.order);
      tp.node = nodesX.length - 1;
      phiSum += gfun(tp.x, tp.y, tp.z); phiCnt++;
      if (!grounded) phiCh = phiSum / phiCnt;
      // ground contact (connecting leader, ~60 m above local terrain)
      if (!grounded && tp.z - Math.max(0, ground(tp.x, tp.y)) < 70) {
        grounded = true; strikeNode = tp.node; strikeSign = tp.s; attachGen = gen; phiCh = 0; tp.alive = false;
        continue;
      }
      // branching
      if (tips.length < 26 && rnd() < 0.06) {
        const d = rdir();
        tips.push({ x: tp.x, y: tp.y, z: tp.z, s: tp.s, dx: d[0], dy: d[1], dz: d[2], order: tp.order + 1, alive: true, node: tp.node });
      }
    }
    if (!any) break;
  }
  // graph distance from strike (or initiation) for return-stroke / K-process propagation, plus the dilated neutralisation mask
  const n = nodesX.length;
  const root = grounded ? strikeNode : 0;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let q = 1; q < n; q++) { adj[q].push(nodeParent[q]); adj[nodeParent[q]].push(q); }
  const dist = new Float32Array(n).fill(-1);
  const stack = [root]; dist[root] = 0;
  while (stack.length) {
    const c = stack.pop()!;
    for (const m of adj[c]) if (dist[m] < 0) {
      dist[m] = dist[c] + Math.hypot(nodesX[m] - nodesX[c], nodesY[m] - nodesY[c], nodesZ[m] - nodesZ[c]); stack.push(m);
    }
  }
  const segs = new Float32Array((n - 1) * 10);
  let o = 0;
  const cells = new Set<number>();
  const nz = a.nz;
  for (let q = 1; q < n; q++) {
    const p = nodeParent[q];
    const ord = nodeOrder[q];
    segs[o++] = nodesX[p]; segs[o++] = nodesZ[p]; segs[o++] = ((nodesY[p] % L) + L) % L;
    segs[o++] = nodesX[q]; segs[o++] = nodesZ[q]; segs[o++] = ((nodesY[q] % L) + L) % L;
    segs[o++] = nodeGen[q]; segs[o++] = Math.max(dist[p], dist[q]); segs[o++] = ord; segs[o++] = Math.max(0.25, 1 - 0.28 * ord);
    const mx = (nodesX[q] + nodesX[p]) / 2, my = (nodesY[q] + nodesY[p]) / 2, mz = (nodesZ[q] + nodesZ[p]) / 2;
    const ii = Math.floor((((mx % L) + L) % L) / g.dx), jj = Math.floor((((my % L) + L) % L) / g.dy);
    let kk = 0; while (kk < nz - 1 && g.zf[kk + 1] < mz) kk++;
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const k2 = kk + dk; if (k2 < 0 || k2 >= nz) continue;
      cells.add(k2 * nxy + ((jj + dj + ny) % ny) * nx + ((ii + di + nx) % nx));
    }
  }
  const charge = a.neutralize(cells, 0.55);
  // timing / strokes
  const STEP = 0.0016;
  const leaderEnd = gen * STEP;
  const strokes: { t: number; amp: number }[] = [];
  let ccEnd = 0, ccAmp = 0, type: FlashEvent['type'] = 'IC';
  let strike: [number, number, number] | null = null;
  if (grounded) {
    type = strikeSign > 0 ? 'CG-' : 'CG+';
    strike = [nodesX[strikeNode], nodesZ[strikeNode], ((nodesY[strikeNode] % L) + L) % L];
    let t = attachGen * STEP + 0.002;
    const positive = type === 'CG+';
    const ns = positive ? (rnd() < 0.75 ? 1 : 2) : Math.min(8, 1 + Math.floor(-Math.log(rnd() + 1e-6) * 2.2));
    strokes.push({ t, amp: positive ? 1.35 : 1 });
    for (let s = 1; s < ns; s++) { t += 0.035 + 0.08 * rnd(); strokes.push({ t, amp: 0.22 + 0.5 * rnd() }); }
    ccEnd = strokes[0].t + (positive ? 0.09 + 0.2 * rnd() : 0.01 + 0.04 * rnd());
    ccAmp = positive ? 0.2 : 0.12;
  } else {
    const np = 3 + Math.floor(rnd() * 6);
    let t = leaderEnd + 0.01;
    for (let s = 0; s < np; s++) { strokes.push({ t, amp: 0.1 + 0.3 * rnd() }); t += 0.02 + 0.06 * rnd(); }
    ccEnd = strokes[0].t + 0.05; ccAmp = 0.06;
  }
  return {
    id: nextId++, type, simTime: a.time, init: [nodesX[0], nodesZ[0], nodesY[0]], strike, segs, strokes, ccEnd, ccAmp, leaderEnd,
    chargeC: charge, ratio,
  };
}

/** Check breakdown conditions; may produce up to two flashes per call. */
export function tryLightning(a: Atmosphere): FlashEvent[] {
  const out: FlashEvent[] = [];
  if (a.stats.maxEratio < 1) return out;
  const p = 1 - Math.exp(-a.dt / 3);
  const { nx, ny, nz, nxy } = a;
  const used: [number, number, number][] = [];
  for (let f = 0; f < 2; f++) {
    let bestR = 1, best = -1;
    for (let k = 0; k < nz; k++) {
      const eth = a.thresholdE(k);
      for (let ij = 0; ij < nxy; ij++) {
        const c = k * nxy + ij;
        const r = a.emag[c] / eth;
        if (r > bestR) {
          const jj = Math.floor(ij / nx), ii = ij % nx;
          let ok = true;
          for (const u of used) {
            let dx = Math.abs(ii - u[0]); dx = Math.min(dx, nx - dx);
            let dy = Math.abs(jj - u[1]); dy = Math.min(dy, ny - dy);
            if (dx < 6 && dy < 6) { ok = false; break; }
          }
          if (ok) { bestR = r; best = c; }
        }
      }
    }
    if (best < 0 || a.rng() > p) break;
    const ij = best % nxy;
    used.push([ij % nx, Math.floor(ij / nx), 0]);
    out.push(growFlash(a, best, bestR));
    a.flashCount++;
  }
  return out;
}
