// Tileable 3-D noise volume used for sub-grid cloud erosion (visual detail only; not part of the physics).
// A Perlin-Worley base plus three cellular octaves gives the broad cauliflower shapes, the
// billow edges and the fine wisps without the blocky look of plain value noise.
function hash3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(s, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const wrap = (v: number, F: number) => ((v % F) + F) % F;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad3(x: number, y: number, z: number, F: number, seed: number): [number, number, number] {
  const xi = wrap(x, F), yi = wrap(y, F), zi = wrap(z, F);
  const a = hash3(xi, yi, zi, seed) * Math.PI * 2;
  const b = hash3(xi, yi, zi, seed + 1) * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - b * b));
  return [Math.cos(a) * r, b, Math.sin(a) * r];
}

function dotGrad(x: number, y: number, z: number, dx: number, dy: number, dz: number, F: number, seed: number): number {
  const g = grad3(x, y, z, F, seed);
  return g[0] * dx + g[1] * dy + g[2] * dz;
}

/** Tileable improved Perlin noise in [0,1]. */
function perlin(px: number, py: number, pz: number, F: number, seed: number): number {
  const x = px * F, y = py * F, z = pz * F;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const c000 = dotGrad(xi, yi, zi, fx, fy, fz, F, seed);
  const c100 = dotGrad(xi + 1, yi, zi, fx - 1, fy, fz, F, seed);
  const c010 = dotGrad(xi, yi + 1, zi, fx, fy - 1, fz, F, seed);
  const c110 = dotGrad(xi + 1, yi + 1, zi, fx - 1, fy - 1, fz, F, seed);
  const c001 = dotGrad(xi, yi, zi + 1, fx, fy, fz - 1, F, seed);
  const c101 = dotGrad(xi + 1, yi, zi + 1, fx - 1, fy, fz - 1, F, seed);
  const c011 = dotGrad(xi, yi + 1, zi + 1, fx, fy - 1, fz - 1, F, seed);
  const c111 = dotGrad(xi + 1, yi + 1, zi + 1, fx - 1, fy - 1, fz - 1, F, seed);
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  const y0 = lerp(x00, x10, v), y1 = lerp(x01, x11, v);
  return Math.min(1, Math.max(0, 0.5 + 0.78 * lerp(y0, y1, w)));
}

function worley(px: number, py: number, pz: number, F: number, seed: number): number {
  const x = px * F, y = py * F, z = pz * F;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, cz = zi + k;
    const wx = wrap(cx, F), wy = wrap(cy, F), wz = wrap(cz, F);
    const dx = cx + hash3(wx, wy, wz, seed) - x, dy = cy + hash3(wx, wy, wz, seed + 1) - y, dz = cz + hash3(wx, wy, wz, seed + 2) - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

export function makeNoiseData(n: number): Uint8Array {
  const data = new Uint8Array(n * n * n * 4);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = x / n, py = y / n, pz = z / n;
    // Broad Perlin FBM: the large billows of a cumulus field.
    const p = 0.54 * perlin(px, py, pz, 4, 3) + 0.31 * perlin(px, py, pz, 8, 5) + 0.15 * perlin(px, py, pz, 16, 9);
    const w1 = worley(px, py, pz, 4, 21), w2 = worley(px, py, pz, 8, 33), w3 = worley(px, py, pz, 16, 47);
    // Perlin-Worley: carve the cellular boundaries out of the broad shape, then keep some of
    // the original FBM so the cloud does not turn into a field of identical soap bubbles.
    const cut = (1 - (0.6 * w2 + 0.4 * w3)) * 0.58;
    const pw = Math.min(1, Math.max(0, (p - cut) / (1 - cut)));
    const o = ((z * n + y) * n + x) * 4;
    data[o] = Math.round(255 * (0.38 * p + 0.62 * pw));
    data[o + 1] = Math.round(255 * w1);
    data[o + 2] = Math.round(255 * w2);
    data[o + 3] = Math.round(255 * w3);
  }
  return data;
}
