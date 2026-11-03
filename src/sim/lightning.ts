// Lightning: bidirectional leader initiation at the grid cell where E / E_break is largest, then
// stochastic dielectric-breakdown (DBM, eta=1.35) growth of branching channels in the solved
// electric potential. One leader descends toward the ground, the other climbs into the cloud;
// the channel is a floating conductor at the mean ambient potential until a tip attaches.
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
  const nodesX: number[] = [x], nodesY: number[] = [y], nodesZ: number[] = [z];
  const nodeGen: number[] = [0], nodeParent: number[] = [-1], nodeOrder: number[] = [0];
  let phiSum = gfun(x, y, z), phiCnt = 1, phiCh = phiSum;
  const tips: Tip[] = [];
  const rdir = () => { const u = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - u * u); return [r * Math.cos(t), u, r * Math.sin(t)]; };
  // Start with a descending negative leader and an ascending positive leader. A purely random
  // bidirectional pair often wandered sideways and produced a horizontal "spider" instead of a bolt.
  const az = 2 * Math.PI * rnd(), horiz = 0.35 + 0.35 * rnd(), down = Math.sqrt(1 - horiz * horiz);
  const d0 = [horiz * Math.cos(az), horiz * Math.sin(az), -down];
  tips.push({ x, y, z, s: -1, dx: d0[0], dy: d0[1], dz: d0[2], order: 0, alive: true, node: 0 });
  tips.push({ x, y, z, s: 1, dx: -d0[0], dy: -d0[1], dz: -d0[2], order: 0, alive: true, node: 0 });

  const EPROP = 1.1e4, ETA = 1.35, NC = 12;
  const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const MAXSEG = 620, MAXGEN = 180, MAXTIPS = 28;
  let grounded = false, strikeNode = -1, strikeSign = 0, attachGen = 0;
  let gen = 0;
  for (gen = 1; gen <= MAXGEN && nodesX.length < MAXSEG; gen++) {
    let any = false;
    const nt = tips.length;
    for (let ti = 0; ti < nt; ti++) {
      const tp = tips[ti];
      if (!tp.alive) continue;
      any = true;
      // Longer, smoother leader steps with gentle kinks; branches get shorter steps.
      const len = (55 + 75 * rnd()) * (1 - Math.min(0.35, tp.order * 0.1));
      const dV = EPROP * len;
      let best = -1, tot = 0;
      const cw: number[] = [], cg: number[] = [], cx: number[] = [], cy: number[] = [], cz: number[] = [], cdx: number[] = [], cdy: number[] = [], cdz: number[] = [];
      const phiTip = gfun(tp.x, tp.y, tp.z);
      for (let c = 0; c < NC; c++) {
        const r = rdir();
        // Most candidates stay in a narrow forward cone; a few explore sideways. This keeps
        // the field-driven growth but removes the "random walk on a lattice" look.
        const blend = c < 7 ? 0.18 + 0.34 * rnd() : 0.48 + 0.40 * rnd();
        let dx = tp.dx * (1 - blend) + r[0] * blend;
        let dy = tp.dy * (1 - blend) + r[1] * blend;
        let dz = tp.dz * (1 - blend) + r[2] * blend;
        const vBias = (c < 8 ? 0.10 : 0.20) * rnd();
        dz += tp.s < 0 ? -vBias : vBias;   // descending / ascending field bias
        const nl = Math.hypot(dx, dy, dz) || 1; dx /= nl; dy /= nl; dz /= nl;
        const px = tp.x + dx * len, py = tp.y + dy * len, pz = tp.z + dz * len;
        cx.push(px); cy.push(py); cz.push(pz); cdx.push(dx); cdy.push(dy); cdz.push(dz);
        if (pz < 20) { cw.push(0); cg.push(0); continue; }
        const pc = gfun(px, py, pz);
        const drive = tp.s * (pc - phiCh);
        const grad = (tp.s * (pc - phiTip)) / len;
        const fwd = Math.max(0, dx * tp.dx + dy * tp.dy + dz * tp.dz);
        const vertical = tp.s < 0 ? Math.max(0, -dz) : Math.max(0, dz);
        // A soft drive threshold keeps marginal cells from producing empty flashes while still
        // strongly favouring sites that exceed the propagation field.
        const driveF = smooth(dV * 0.25, dV * 1.15, drive);
        const wgt = grad > 0
          ? Math.pow(grad / 8000, ETA) * (0.35 + 0.65 * fwd) * (0.6 + 0.8 * rnd()) * (1 + 0.45 * vertical) * (0.12 + 0.88 * driveF)
          : 0;
        cw.push(wgt); cg.push(grad); tot += wgt;
      }
      if (tot <= 0) {
        // Fall back to the strongest local field component so a weak cell still forms a short channel.
        let bv = 0;
        for (let c = 0; c < NC; c++) if (cg[c] > bv) { bv = cg[c]; best = c; }
        if (best < 0 || bv <= 0) { tp.alive = false; continue; }
      } else {
        let pick = rnd() * tot;
        for (let c = 0; c < NC; c++) { pick -= cw[c]; if (pick <= 0) { best = c; break; } }
        if (best < 0) best = cw.lastIndexOf(Math.max(...cw));
      }
      const parent = tp.node;
      const jit = 0.14 * len;
      tp.x = cx[best] + (rnd() - 0.5) * jit;
      tp.y = cy[best] + (rnd() - 0.5) * jit;
      tp.z = Math.max(25, cz[best] + (rnd() - 0.5) * jit);
      tp.dx = 0.68 * tp.dx + 0.32 * cdx[best]; tp.dy = 0.68 * tp.dy + 0.32 * cdy[best]; tp.dz = 0.68 * tp.dz + 0.32 * cdz[best];
      const nl = Math.hypot(tp.dx, tp.dy, tp.dz) || 1; tp.dx /= nl; tp.dy /= nl; tp.dz /= nl;
      nodesX.push(tp.x); nodesY.push(tp.y); nodesZ.push(tp.z); nodeGen.push(gen); nodeParent.push(parent); nodeOrder.push(tp.order);
      tp.node = nodesX.length - 1;
      phiSum += gfun(tp.x, tp.y, tp.z); phiCnt++;
      if (!grounded) phiCh = phiSum / phiCnt;
      // Ground attachment: only the descending leader can connect (~60 m above terrain).
      if (!grounded && tp.s < 0 && tp.z - Math.max(0, ground(tp.x, tp.y)) < 70) {
        grounded = true; strikeNode = tp.node; strikeSign = tp.s; attachGen = gen; phiCh = 0; tp.alive = false;
        continue;
      }
      // Shallow forks, rarer with each generation; high-order branches stop subdividing.
      const pBranch = tp.order < 3 && tp.z > 550 ? 0.10 * Math.pow(0.52, tp.order) : 0;
      if (tips.length < MAXTIPS && rnd() < pBranch) {
        const r = rdir(), bk = 0.22 + 0.28 * rnd();
        let bx = tp.dx * (1 - bk) + r[0] * bk, by = tp.dy * (1 - bk) + r[1] * bk, bz = tp.dz * (1 - bk) + r[2] * bk;
        bz += tp.s < 0 ? -0.08 : 0.08;
        const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
        tips.push({ x: tp.x, y: tp.y, z: tp.z, s: tp.s, dx: bx, dy: by, dz: bz, order: tp.order + 1, alive: true, node: tp.node });
      }
    }
    if (!any) break;
  }

  // A marginal electrified cell can still register a breakdown. Give it a short stepped leader
  // so every flash has a visible channel instead of a one-segment dash or an empty event.
  if (nodesX.length < 4) {
    const need = 4 - nodesX.length;
    const t0 = tips[0];
    let px = nodesX[0], py = nodesY[0], pz = nodesZ[0];
    for (let f = 0; f < need; f++) {
      const parent = nodesX.length - 1;
      px = ((px + t0.dx * 90) % L + L) % L;
      py = ((py + t0.dy * 90) % L + L) % L;
      pz = Math.max(Math.max(0, ground(px, py)) + 80, pz + t0.dz * 90);
      nodesX.push(px); nodesY.push(py); nodesZ.push(pz);
      nodeGen.push(gen + f + 1); nodeParent.push(parent); nodeOrder.push(0);
    }
    gen += need;
  }

  // Graph distance from the strike (or initiation) drives return-stroke propagation and width taper.
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
    const p = nodeParent[q], ord = nodeOrder[q];
    const tipD = Math.max(dist[p], dist[q]);
    // Main channel is widest at the attachment point; branches and tips taper to a filament.
    const branch = Math.pow(0.62, ord), taper = 1 / (1 + tipD / 9000);
    const width = Math.max(0.12, Math.min(1.25, 0.18 + 1.05 * branch * taper));
    segs[o++] = nodesX[p]; segs[o++] = nodesZ[p]; segs[o++] = ((nodesY[p] % L) + L) % L;
    segs[o++] = nodesX[q]; segs[o++] = nodesZ[q]; segs[o++] = ((nodesY[q] % L) + L) % L;
    segs[o++] = nodeGen[q]; segs[o++] = tipD; segs[o++] = ord; segs[o++] = width;
    const mx = (nodesX[q] + nodesX[p]) / 2, my = (nodesY[q] + nodesY[p]) / 2, mz = (nodesZ[q] + nodesZ[p]) / 2;
    const ii = Math.floor((((mx % L) + L) % L) / g.dx), jj = Math.floor((((my % L) + L) % L) / g.dy);
    let kk = 0; while (kk < nz - 1 && g.zf[kk + 1] < mz) kk++;
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const k2 = kk + dk; if (k2 < 0 || k2 >= nz) continue;
      cells.add(k2 * nxy + ((jj + dj + ny) % ny) * nx + ((ii + di + nx) % nx));
    }
  }
  const charge = a.neutralize(cells, 0.55);

  // Timing: a slightly slower stepped leader, then return strokes / K-changes travelling up
  // the channel. Multiple strokes and continuing current make the flicker read as one flash.
  const STEP = 0.0022;
  const leaderEnd = gen * STEP + 0.006;
  const strokes: { t: number; amp: number }[] = [];
  let ccEnd = 0, ccAmp = 0, type: FlashEvent['type'] = 'IC';
  let strike: [number, number, number] | null = null;
  if (grounded) {
    type = strikeSign > 0 ? 'CG-' : 'CG+';
    strike = [nodesX[strikeNode], nodesZ[strikeNode], ((nodesY[strikeNode] % L) + L) % L];
    let t = attachGen * STEP + 0.004;
    const positive = type === 'CG+';
    const ns = positive ? (rnd() < 0.8 ? 1 : 2) : Math.min(8, 1 + Math.floor(-Math.log(rnd() + 1e-6) * 2.0));
    strokes.push({ t, amp: positive ? 1.25 : 1 });
    for (let s = 1; s < ns; s++) { t += 0.018 + 0.065 * rnd(); strokes.push({ t, amp: (0.22 + 0.52 * rnd()) * (1 - 0.05 * s) }); }
    ccEnd = strokes[0].t + (positive ? 0.10 + 0.20 * rnd() : 0.012 + 0.045 * rnd());
    ccAmp = positive ? 0.18 : 0.10;
  } else {
    const np = 2 + Math.floor(rnd() * 5);
    let t = leaderEnd + 0.008;
    for (let s = 0; s < np; s++) { strokes.push({ t, amp: 0.08 + 0.26 * rnd() }); t += 0.015 + 0.05 * rnd(); }
    ccEnd = strokes[0].t + 0.05; ccAmp = 0.06;
  }
  return {
    id: nextId++, type, simTime: a.time, init: [nodesX[0], nodesZ[0], ((nodesY[0] % L) + L) % L], strike, segs, strokes, ccEnd, ccAmp, leaderEnd,
    chargeC: charge, ratio,
  };
}

/** Check breakdown conditions; may produce up to two flashes per call. */
export function tryLightning(a: Atmosphere): FlashEvent[] {
  const out: FlashEvent[] = [];
  if (a.stats.maxEratio < 1) return out;
  // electrostatics/lightning is evaluated every 4 steps, so each call covers two intervals
  const p = 1 - Math.exp(-(a.dt * 2) / 3);
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
