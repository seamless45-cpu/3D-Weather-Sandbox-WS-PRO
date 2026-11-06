// Lightning: bidirectional leader initiation at the grid cell where E / E_break is largest for
// the *chosen polarity*, then stochastic dielectric-breakdown (DBM, eta=1.35) growth of
// branching channels in the solved electric potential. One leader descends toward the ground,
// the other climbs into the cloud; the channel is a floating conductor at the mean ambient
// potential until a tip attaches.
//
// Negative and positive lightning trigger in different places and behave differently:
//  * CG− (the common kind): initiates inside the mid-level negative charge where the dipole
//    field first exceeds the breakdown threshold; branchy stepped leader; several return
//    strokes; short continuing current.
//  * CG+ : initiates in the upper positive charge region (or the lower positive pocket) once
//    the reservoir is large and the local field reaches ~80% of breakdown — rarer, straighter,
//    usually a single very high-peak-current stroke with a long continuing current.
import type { Atmosphere } from './atmosphere';
import { EPS0 } from './consts';

export type Polarity = 'neg' | 'pos';

export interface FlashEvent {
  id: number; type: 'CG-' | 'CG+' | 'IC' | 'CC' | 'ANVIL'; simTime: number;
  init: [number, number, number]; strike: [number, number, number] | null;
  segs: Float32Array; // per segment 10 floats: x0,y0,z0,x1,y1,z1, gen, dist, order, width  (world frame: X, up, Z)
  strokes: { t: number; amp: number }[]; ccEnd: number; ccAmp: number; leaderEnd: number;
  chargeC: number; ratio: number;
  /** true when the flash was initiated from accumulated charge on the ground (upward leader). */
  fromGround?: boolean;
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

interface Tip { x: number; y: number; z: number; s: number; dx: number; dy: number; dz: number; order: number; alive: boolean; node: number; born: number; }

/**
 * @groundUp When set, the flash is ground-initiated: it starts from a point on the surface
 *  that carries accumulated charge (qGround) with a single upward leader already attached to
 *  earth (φ = 0 on the channel from the first node). `polarity` follows the surface charge
 *  sign: negative sheet → upward positive leader → CG−; positive sheet → upward negative
 *  leader → CG+. The bright stages begin only after the leader has climbed into the charge
 *  (leaderEnd), not at t≈0 as for cloud-initiated flashes.
 */
export function growFlash(a: Atmosphere, ci: number, ratio: number, polarity: Polarity, groundUp = false): FlashEvent {
  const { nx, ny, nxy } = a, g = a.g;
  const rnd = a.rng;
  const k = Math.floor(ci / nxy), ij = ci % nxy, j = Math.floor(ij / nx), i = ij % nx;
  let x = (i + 0.2 + 0.6 * rnd()) * g.dx, y = (j + 0.2 + 0.6 * rnd()) * g.dy;
  let z = g.zf[k] + g.dz[k] * (0.2 + 0.6 * rnd());
  const L = g.dx * nx;
  const ground = (px: number, py: number) => a.terrain.groundHeight(((px % L) + L) % L, ((py % L) + L) % L);
  if (groundUp) z = Math.max(30, Math.max(0, ground(x, y)) + 25);
  const gfun = (px: number, py: number, pz: number) => {
    const hag = pz - Math.max(0, ground(px, py));
    return phiAt(a, px, py, pz) * Math.min(1, Math.max(0.02, hag / 900));
  };
  const nodesX: number[] = [x], nodesY: number[] = [y], nodesZ: number[] = [z];
  const nodeGen: number[] = [0], nodeParent: number[] = [-1], nodeOrder: number[] = [0];
  let phiSum = gfun(x, y, z), phiCnt = 1, phiCh = groundUp ? 0 : phiSum;
  const tips: Tip[] = [];
  const rdir = () => { const u = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - u * u); return [r * Math.cos(t), u, r * Math.sin(t)]; };
  // Leader sign convention: s = +1 grows toward higher potential (a NEGATIVE leader, toward
  // positive charge), s = −1 grows toward lower potential (a POSITIVE leader). The flash
  // polarity is the descending leader: CG− sends its negative leader to the ground, CG+ sends
  // its positive leader down from the upper (or lower) positive charge region.
  const descS = polarity === 'neg' ? 1 : -1;
  const positive = polarity === 'pos';
  // Per-step chance the descending leader stalls out (screening, branching losses, charge
  // structure it cannot cross). This is the valve that keeps intracloud flashes the majority:
  // negative leaders branch heavily and stall more, positive leaders from the anvil mostly
  // survive the long trip down — so both polarities still attach, at realistic rates.
  const stallP = positive ? 0.008 : 0.032;
  // Flash flavour: 'cc' = cloud-to-cloud (never attaches, wanders horizontally through the
  // charge); 'anvil' = positive anvil crawler (starts > 7 km, flattens into a long horizontal
  // run through the anvil and may attach far from the core). Everything else is normal IC/CG.
  let flavor: 'norm' | 'cc' | 'anvil' = 'norm';
  const rFlav = rnd();
  if (rFlav < 0.15) flavor = 'cc';
  else if (positive && z > 7000 && rFlav < 0.55) flavor = 'anvil';
  // Start with a descending polarity leader and an ascending counter-leader. A purely random
  // bidirectional pair often wandered sideways and produced a horizontal "spider" instead of a bolt.
  // Ground-initiated flashes instead launch a single polarity leader already attached to the
  // surface charge sheet: it climbs with s = −descS (negative sheet → upward positive leader
  // into the negative charge → CG−; positive sheet → upward negative leader → CG+).
  const az = 2 * Math.PI * rnd(), horiz = 0.35 + 0.35 * rnd(), down = Math.sqrt(1 - horiz * horiz);
  let d0: [number, number, number] = [horiz * Math.cos(az), horiz * Math.sin(az), -down];
  if (flavor === 'anvil') d0 = [Math.cos(az), Math.sin(az), -0.18 - 0.12 * rnd()];   // flat crawler start
  if (groundUp) {
    flavor = 'norm';
    d0 = [horiz * Math.cos(az) * 0.6, horiz * Math.sin(az) * 0.6, Math.sqrt(1 - horiz * horiz * 0.36)];
    tips.push({ x, y, z, s: -descS, dx: d0[0], dy: d0[1], dz: d0[2], order: 0, alive: true, node: 0, born: 0 });
  } else {
    tips.push({ x, y, z, s: descS, dx: d0[0], dy: d0[1], dz: d0[2], order: 0, alive: true, node: 0, born: 0 });
    tips.push({ x, y, z, s: -descS, dx: -d0[0], dy: -d0[1], dz: -d0[2], order: 0, alive: true, node: 0, born: 0 });
  }

  const EPROP = 1.1e4, ETA = 1.35, NC = 12;
  const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const MAXSEG = 1400, MAXGEN = 180, MAXTIPS = 16;
  // Ground-initiated flashes are attached to the surface charge sheet from generation 0:
  // the channel is earthed, so φ stays 0 on it and return strokes fire once the leader has
  // climbed into the charge (timed at leaderEnd below).
  let grounded = groundUp, strikeNode = groundUp ? 0 : -1, attachGen = 0;
  let gen = 0;
  for (gen = 1; gen <= MAXGEN && nodesX.length < MAXSEG; gen++) {
    let any = false;
    const nt = tips.length;
    for (let ti = 0; ti < nt; ti++) {
      const tp = tips[ti];
      if (!tp.alive) continue;
      // Branches are pruned after ~45 generations: forks that wander forever turned every
      // flash into a hairball. The main channel and counter-leader are never pruned.
      if (tp.order > 0 && gen - tp.born > 45) { tp.alive = false; continue; }
      any = true;
      // Longer, smoother leader steps with gentle kinks; branches get shorter steps.
      // Positive leaders propagate in longer, straighter segments than stepped negative ones.
      const len = (positive ? 78 + 88 * rnd() : 55 + 75 * rnd()) * (1 - Math.min(0.35, tp.order * 0.1));
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
        // The polarity leader descends toward the ground; the counter-leader climbs into the
        // cloud — for both polarities, which is what keeps CG+ from wandering sideways.
        dz += tp.s === descS ? -vBias : vBias;
        // Anvil crawlers stay flat for their first ~70 generations (z is up): that is the
        // long horizontal run along the anvil that makes them read as a distinct type.
        if (flavor === 'anvil' && gen < 70) dz *= 0.30;
        else if (flavor === 'cc') dz *= 0.55;   // cloud-to-cloud wanders between charge levels
        const nl = Math.hypot(dx, dy, dz) || 1; dx /= nl; dy /= nl; dz /= nl;
        const px = tp.x + dx * len, py = tp.y + dy * len, pz = tp.z + dz * len;
        cx.push(px); cy.push(py); cz.push(pz); cdx.push(dx); cdy.push(dy); cdz.push(dz);
        if (pz < 20) { cw.push(0); cg.push(0); continue; }
        const pc = gfun(px, py, pz);
        const drive = tp.s * (pc - phiCh);
        const grad = (tp.s * (pc - phiTip)) / len;
        const fwd = Math.max(0, dx * tp.dx + dy * tp.dy + dz * tp.dz);
        const vertical = tp.s === descS ? Math.max(0, -dz) : Math.max(0, dz);
        // A soft drive threshold keeps marginal cells from producing empty flashes while still
        // strongly favouring sites that exceed the propagation field.
        const driveF = smooth(dV * 0.25, dV * 1.15, drive);
        let wgt = grad > 0
          ? Math.pow(grad / 8000, ETA) * (0.35 + 0.65 * fwd) * (0.6 + 0.8 * rnd()) * (1 + 0.45 * vertical) * (0.12 + 0.88 * driveF)
          : 0;
        // Ground-seeking persistence: the ambient gradient flips sign at the potential
        // minimum between the charge levels, but the descending polarity leader's own space
        // charge keeps its tip field pointing down — without this floor every flash dies as
        // an IC a few kilometres above the ground.
        if (tp.s === descS && dz < -0.15) {
          wgt = Math.max(wgt, (0.9 + 1.6 * rnd()) * (0.30 + 0.70 * fwd) * (0.45 + 0.55 * vertical));
        } else if (tp.s === descS && dz > 0.10) {
          // The descending tip does not climb back — ascending is the counter-leader's job;
          // letting it wander upward is what kept the channel from ever reaching the ground.
          wgt *= 0.18;
        } else if (groundUp && dz > 0.15) {
          // Ground-initiated upward leader: near the surface the ambient gradient is too
          // weak to steer (both endpoints sit at ≈0 potential), so persistence carries the
          // tip up until the cloud's field takes over the driving.
          wgt = Math.max(wgt, (0.9 + 1.6 * rnd()) * (0.30 + 0.70 * fwd) * (0.45 + 0.55 * vertical));
        }
        cw.push(wgt); cg.push(grad); tot += wgt;
      }
      if (tot <= 0) {
        // Fall back to the strongest local field component so a weak cell still forms a short channel.
        let bv = 0;
        for (let c = 0; c < NC; c++) if (cg[c] > bv) { bv = cg[c]; best = c; }
        if (best < 0 || bv <= 0) {
          if (tp.s !== descS) { tp.alive = false; continue; }
          // Descending leader with no field-preferred step: continue the most downward
          // candidate rather than stalling (its own charge sustains propagation here).
          let minZ = Infinity;
          for (let c = 0; c < NC; c++) if (cz[c] < minZ) { minZ = cz[c]; best = c; }
        }
      } else {
        let pick = rnd() * tot;
        for (let c = 0; c < NC; c++) { pick -= cw[c]; if (pick <= 0) { best = c; break; } }
        if (best < 0) best = cw.lastIndexOf(Math.max(...cw));
      }
      const parent = tp.node;
      const jit = 0.10 * len;
      tp.x = cx[best] + (rnd() - 0.5) * jit;
      tp.y = cy[best] + (rnd() - 0.5) * jit;
      tp.z = Math.max(25, cz[best] + (rnd() - 0.5) * jit);
      // Smoother heading: real channels are long arcs with kinks, not lattice random walks.
      tp.dx = 0.78 * tp.dx + 0.22 * cdx[best]; tp.dy = 0.78 * tp.dy + 0.22 * cdy[best]; tp.dz = 0.78 * tp.dz + 0.22 * cdz[best];
      const nl = Math.hypot(tp.dx, tp.dy, tp.dz) || 1; tp.dx /= nl; tp.dy /= nl; tp.dz /= nl;
      nodesX.push(tp.x); nodesY.push(tp.y); nodesZ.push(tp.z); nodeGen.push(gen); nodeParent.push(parent); nodeOrder.push(tp.order);
      tp.node = nodesX.length - 1;
      phiSum += gfun(tp.x, tp.y, tp.z); phiCnt++;
      if (!grounded) phiCh = phiSum / phiCnt;
      // Ground attachment: only the descending polarity leader can connect (~60 m above
      // terrain). Cloud-to-cloud flashes never attach by definition. When the surface field
      // under the tip is already near breakdown (charge accumulated on the ground via
      // precipitation and induction), an upward streamer meets the leader far above the
      // surface — that is how real CGs close the last few hundred metres.
      if (!grounded && flavor !== 'cc' && tp.s === descS) {
        const tGround = Math.max(0, ground(tp.x, tp.y));
        let attachDist = 70;
        if (tp.z - tGround < 700) {
          const ii = (((Math.floor(tp.x / g.dx) % nx) + nx) % nx);
          const jj = (((Math.floor(tp.y / g.dy) % ny) + ny) % ny);
          const surfR = a.emag[jj * nx + ii] / a.thresholdE(0);
          if (surfR > 0.7) attachDist = 70 + 530 * Math.min(1, (surfR - 0.7) / 0.3);
        }
        if (tp.z - tGround < attachDist) {
          grounded = true; strikeNode = tp.node; attachGen = gen; phiCh = 0; tp.alive = false;
          continue;
        }
      }
      // Stall (see stallP): a desc tip that dies here leaves the counter-leader finishing the
      // flash as an IC — exactly how most flashes in a real storm end.
      if (tp.s === descS && rnd() < stallP) { tp.alive = false; continue; }
      // Shallow forks, rarer with each generation; high-order branches stop subdividing.
      // Positive leaders fork much less than stepped negative ones.
      const pBranch = positive
        ? (tp.order < 2 && tp.z > 900 ? 0.055 * Math.pow(0.5, tp.order) : 0)
        : (tp.order < 3 && tp.z > 550 ? 0.085 * Math.pow(0.5, tp.order) : 0);
      // Keep a node reserve so branches can never starve the main channel of steps before it
      // reaches the ground (branches are what made every flash die as an IC).
      if (tips.length < MAXTIPS && nodesX.length < MAXSEG - 400 && rnd() < pBranch) {
        const r = rdir(), bk = 0.22 + 0.28 * rnd();
        let bx = tp.dx * (1 - bk) + r[0] * bk, by = tp.dy * (1 - bk) + r[1] * bk, bz = tp.dz * (1 - bk) + r[2] * bk;
        bz += tp.s < 0 ? -0.08 : 0.08;
        const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
        tips.push({ x: tp.x, y: tp.y, z: tp.z, s: tp.s, dx: bx, dy: by, dz: bz, order: tp.order + 1, alive: true, node: tp.node, born: gen });
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

  // Upward connecting leader: when the descending stepped leader nears the ground, upward
  // streamers rise from surface tips (grass, roughness, the charged sheet itself) and the
  // strongest one meets the leader a few hundred metres up — the last stretch of every real
  // CG is closed by this ground-launched streamer, not by the cloud leader touching soil.
  if (grounded && !groundUp && strikeNode >= 0) {
    const sx = nodesX[strikeNode], sy = nodesY[strikeNode], sz = nodesZ[strikeNode];
    const gz = Math.max(0, ground(sx, sy));
    const nStream = 4;
    let parent = strikeNode;
    for (let f = 1; f <= nStream; f++) {
      const fr = f / nStream;
      const px = sx + (rnd() - 0.5) * 34 * fr, py = sy + (rnd() - 0.5) * 34 * fr;
      const pz = gz + (sz - gz) * fr * fr;   // streamer accelerates upward: quadratic rise
      nodesX.push(px); nodesY.push(py); nodesZ.push(Math.max(5, pz));
      nodeGen.push(attachGen); nodeParent.push(parent); nodeOrder.push(1);
      parent = nodesX.length - 1;
    }
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
  // Positive CGs grow their leader a touch slower and then dump one huge stroke plus a long
  // continuing current; negative CGs strobe through several progressively weaker strokes.
  const STEP = positive ? 0.0028 : 0.0022;
  const leaderEnd = gen * STEP + 0.006;
  const strokes: { t: number; amp: number }[] = [];
  let ccEnd = 0, ccAmp = 0, type: FlashEvent['type'] = 'IC';
  let strike: [number, number, number] | null = null;
  type = flavor === 'anvil' ? 'ANVIL' : flavor === 'cc' ? 'CC' : 'IC';
  if (grounded) {
    if (flavor !== 'anvil') type = polarity === 'neg' ? 'CG-' : 'CG+';
    strike = [nodesX[strikeNode], nodesZ[strikeNode], ((nodesY[strikeNode] % L) + L) % L];
    // Cloud-initiated: the return stroke fires when the leader attaches. Ground-initiated:
    // nothing bright leaves the surface until the upward leader has connected aloft
    // (leaderEnd) — before that only the faint climbing leader beads are visible.
    let t = groundUp ? leaderEnd + 0.004 : attachGen * STEP + 0.004;
    const ns = positive ? (rnd() < 0.15 ? 2 : 1) : Math.min(8, 1 + Math.floor(-Math.log(rnd() + 1e-6) * 2.0));
    strokes.push({ t, amp: positive ? 2.1 : 1 });
    // Subsequent strokes are dart leaders re-using the same channel: quick, tightly spaced.
    for (let s = 1; s < ns; s++) { t += 0.014 + 0.05 * rnd(); strokes.push({ t, amp: (0.22 + 0.52 * rnd()) * (1 - 0.05 * s) }); }
    ccEnd = strokes[0].t + (positive ? 0.14 + 0.30 * rnd() : 0.012 + 0.045 * rnd());
    ccAmp = positive ? 0.34 : 0.10;
  } else {
    const np = 2 + Math.floor(rnd() * 5);
    let t = leaderEnd + 0.008;
    const scale = positive ? 1.4 : 1;
    for (let s = 0; s < np; s++) { strokes.push({ t, amp: (0.08 + 0.26 * rnd()) * scale }); t += 0.015 + 0.05 * rnd(); }
    ccEnd = strokes[0].t + (type === 'CC' ? 0.14 + 0.30 * rnd() : 0.05);
    ccAmp = type === 'CC' ? 0.14 * scale : 0.06 * scale;
  }
  return {
    id: nextId++, type, simTime: a.time, init: [nodesX[0], nodesZ[0], ((nodesY[0] % L) + L) % L], strike, segs, strokes, ccEnd, ccAmp, leaderEnd,
    chargeC: charge, ratio, ...(groundUp ? { fromGround: true } : {}),
  };
}

/** Check breakdown conditions; may produce up to two flashes per call.
 *  Polarity is chosen first and then *filters* the initiation search, so negative and
 *  positive lightning literally trigger in different charge regions and at different
 *  field thresholds (negative: E ≥ E_break inside the negative charge; positive: E ≥ 0.8·E_break
 *  inside a well-supplied positive charge region). */
export function tryLightning(a: Atmosphere): FlashEvent[] {
  const out: FlashEvent[] = [];
  const { nx, ny, nz, nxy } = a;
  // Breakdown gate: hydrometeor tips and channel space charge enhance the local field by
  // several-fold, so the effective ambient threshold sits below the ideal ~97 kV/m — flashes
  // start once the storm reaches ~62% of it and the cadence scales with severity above 0.75.
  // Ground-initiated flashes are gated on their own criterion (the surface sheet), so they
  // can still fire when the in-cloud field alone would not pass this bar.
  const cloudGate = a.stats.maxEratio >= 0.62;
  // Electrostatics/lightning is evaluated every 4 steps, so each call covers two intervals.
  // The mean interval scales with how far past breakdown the storm is, and is re-jittered
  // every call: flashes arrive in irregular clumps rather than on a fixed metronome.
  const sev = Math.max(0, a.stats.maxEratio - 0.75);
  const meanT = (6.5 / (0.45 + Math.min(3.5, sev * 1.6))) * (0.45 + 1.3 * a.rng());
  const p = 1 - Math.exp(-(a.dt * 2) / Math.max(2.5, meanT));
  const used: [number, number, number][] = [];
  const cd = a.chargeDiag;
  const posRes = Math.max(0, cd.upperPos), negRes = Math.max(0, cd.midNeg);
  for (let f = 0; f < (cloudGate ? 2 : 0); f++) {
    // ---- polarity. Positive CGs need a healthy upper-positive (or lower-positive) reservoir
    // and stay rare either way; everything else defaults to the common negative flash.
    const pPos = Math.min(0.19, Math.max(0.03, 0.03 + 0.13 * posRes / (posRes + negRes + 1e-6)));
    let polarity: Polarity = a.rng() < pPos ? 'pos' : 'neg';
    let flipped = false;
    let bestR = 0, best = -1;
    for (;;) {
      const minR = polarity === 'pos' ? 0.85 : 1.0;
      bestR = minR; best = -1;
      for (let k = 0; k < nz; k++) {
        const z = a.g.zc[k];
        // Positive flashes start high in the anvil (> 7 km) or in the lower positive pocket
        // (< 4.5 km); negative flashes start in the mid-level negative charge — never in the
        // cloud-top screening skin, where the long path down mostly stalls as an IC.
        if (polarity === 'pos' && !(z > 7000 || (z < 4500 && cd.lowerPos > 0.5))) continue;
        if (polarity === 'neg' && z > 8800) continue;
        const eth = a.thresholdE(k);
        for (let ij = 0; ij < nxy; ij++) {
          const c = k * nxy + ij;
          const q = a.qh[c] + a.ql[c];
          if (polarity === 'neg' ? q >= 0 : q <= 0) continue;   // wrong-sign charge cell
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
      if (best >= 0 || flipped) break;
      flipped = true;
      polarity = polarity === 'neg' ? 'pos' : 'neg';   // wrong reservoir: try the other kind
    }
    if (best < 0 || a.rng() > p) break;
    const ij = best % nxy;
    used.push([ij % nx, Math.floor(ij / nx), 0]);
    out.push(growFlash(a, best, bestR, polarity));
    a.flashCount++;
  }
  // ---- ground-initiated flashes: where precipitation/induction charge has accumulated on
  // the surface, the field just above ground can exceed breakdown on its own and launch an
  // upward leader. Polarity follows the sign of the surface sheet (negative sheet → upward
  // positive leader closing as CG−, positive sheet → upward negative leader as CG+).
  // Initiation uses the same logic as the cloud gate: the solved ez at the first level is
  // diluted over ~300 m, and the sheet's own σ/ε0 plus roughness/vegetation/conductor tips
  // enhance the surface field several-fold — so ~55% of the ideal 97 kV/m macroscopic field
  // starts an upward leader, not 100%. The rate then scales with how far past that bar the
  // total surface field has pushed, so flashes appear only where charge really piled up.
  // A lightning rod in the domain opens the ground gate on its own (its tip field stands
  // out even where the ambient sheet is weak).
  const anyRod = a.props.some((pr) => pr.type === 'rod');
  if (a.qgMax > 1.2e-7 || anyRod) {
    a.gd.call++;
    let gBest = -1, gR = 0.55, gI = -1, gJ = -1;
    for (let ij = 0; ij < nxy; ij++) {
      const qg = a.qGround[ij];
      let rodBoost = 0;
      for (const pr of a.props) {
        if (pr.type !== 'rod') continue;
        let dx = Math.abs(((ij % nx) * a.g.dx) - pr.x); dx = Math.min(dx, nx * a.g.dx - dx);
        let dz = Math.abs((Math.floor(ij / nx) * a.g.dy) - pr.z); dz = Math.min(dz, ny * a.g.dy - dz);
        const d = Math.hypot(dx, dz);
        if (d < 900) rodBoost = Math.max(rodBoost, (1.9 * (pr.h / 12)) * (1 - d / 900) * (1 - d / 900));
      }
      if (Math.abs(qg) < 1.4e-7 && rodBoost < 0.25) continue;
      a.gd.cand++;
      // Total surface field: solved field at the lowest level + the sheet's near-ground
      // self-field σ/ε0 (an observer at the surface feels the full sheet, while ez averages
      // over the first ~300 m and dilutes it).
      // The rod's tip concentrates the field (enhancement ~ h/r_tip), so an upward leader
      // launches from the rod long before flat ground would fire — rods attract strikes.
      const r = (Math.abs(a.ez[ij]) + (Math.abs(qg) / EPS0) * 0.9) / a.thresholdE(0) + rodBoost;
      if (r > a.gd.maxR) a.gd.maxR = r;
      if (r <= gR) continue;
      if (r > 0.55) a.gd.pass++;
      const jj = Math.floor(ij / nx), ii = ij % nx;
      let ok = true;
      for (const u of used) {
        let dx = Math.abs(ii - u[0]); dx = Math.min(dx, nx - dx);
        let dy = Math.abs(jj - u[1]); dy = Math.min(dy, ny - dy);
        if (dx < 6 && dy < 6) { ok = false; break; }
      }
      if (ok) { gR = r; gBest = ij; gI = ii; gJ = jj; }
      else if (r > 0.55) a.gd.blk++;
    }
    if (gBest >= 0) a.gd.sel++;
    // Probability has a modest floor once a cell clears the initiation bar (charged ground
    // does flare at threshold) and grows with the field excess — a heavily charged surface
    // fires readily, a marginal sheet only occasionally.
    if (gBest >= 0 && (a.gd.roll++, a.rng() < Math.min(0.55, 0.06 + Math.max(0, gR - 0.55) * 2.5) * Math.min(1, p * 1.4))) {
      used.push([gI, gJ, 0]);
      out.push(growFlash(a, gBest, gR, a.qGround[gBest] < 0 ? 'neg' : 'pos', true));
      a.flashCount++;
      // The return stroke dumps the local surface sheet into the channel: drain it in a
      // ~1 km patch around the strike so ground flashes self-limit — the sheet has to
      // recharge through precipitation before the same spot can fire again.
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > 6) continue;
        const id = ((gJ + dy + ny) % ny) * nx + ((gI + dx + nx) % nx);
        a.qGround[id] *= 0.30 + 0.55 * Math.min(1, d2 / 6);
      }
    }
  }
  return out;
}
