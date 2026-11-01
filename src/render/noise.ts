// Tileable 3-D noise volume used for sub-grid cloud erosion (visual detail only; not part of the physics).
function hash3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(s, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function worley(px: number, py: number, pz: number, F: number, seed: number): number {
  const x = px * F, y = py * F, z = pz * F;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, cz = zi + k;
    const wx = ((cx % F) + F) % F, wy = ((cy % F) + F) % F, wz = ((cz % F) + F) % F;
    const dx = cx + hash3(wx, wy, wz, seed) - x, dy = cy + hash3(wx, wy, wz, seed + 1) - y, dz = cz + hash3(wx, wy, wz, seed + 2) - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function vnoise(px: number, py: number, pz: number, F: number, seed: number): number {
  const x = px * F, y = py * F, z = pz * F;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const g = (a: number, b: number, c: number) => hash3(((xi + a) % F + F) % F, ((yi + b) % F + F) % F, ((zi + c) % F + F) % F, seed);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(g(0, 0, 0), g(1, 0, 0), u), l(g(0, 1, 0), g(1, 1, 0), u), v), l(l(g(0, 0, 1), g(1, 0, 1), u), l(g(0, 1, 1), g(1, 1, 1), u), v), w);
}

export function makeNoiseData(n: number): Uint8Array {
  const data = new Uint8Array(n * n * n * 4);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = x / n, py = y / n, pz = z / n;
    const p = 0.55 * vnoise(px, py, pz, 4, 3) + 0.3 * vnoise(px, py, pz, 8, 5) + 0.15 * vnoise(px, py, pz, 16, 9);
    const w1 = worley(px, py, pz, 4, 21), w2 = worley(px, py, pz, 8, 33), w3 = worley(px, py, pz, 16, 47);
    const pw = Math.min(1, Math.max(0, (p - (1 - (0.6 * w2 + 0.4 * w3)) * 0.55) / (1 - (1 - (0.6 * w2 + 0.4 * w3)) * 0.55)));
    const o = ((z * n + y) * n + x) * 4;
    data[o] = Math.round(255 * (0.35 * p + 0.65 * pw));
    data[o + 1] = Math.round(255 * w1);
    data[o + 2] = Math.round(255 * w2);
    data[o + 3] = Math.round(255 * w3);
  }
  return data;
}
