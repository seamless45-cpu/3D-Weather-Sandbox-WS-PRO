// Canvas renderers for the diagnostic panel. Everything drawn comes from the live simulation snapshot.
export interface Slice { field: string; mode: 'h' | 'v'; w: number; h: number; data: Float32Array; ua: Float32Array; va: Float32Array; min: number; max: number; unit: string; }

type RGB = [number, number, number];
const SEQ: RGB[] = [[5, 9, 24], [18, 58, 112], [0, 178, 200], [236, 232, 160], [255, 86, 150]];
const DIV: RGB[] = [[20, 90, 255], [8, 16, 40], [255, 150, 30]];
function ramp(stops: RGB[], t: number): RGB {
  t = Math.max(0, Math.min(1, t));
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  return [0, 1, 2].map((k) => stops[i][k] + (stops[i + 1][k] - stops[i][k]) * u) as RGB;
}
const DIVERGING = new Set(['w', 'zeta', 'thp', 'p']);

export function drawSlice(c: HTMLCanvasElement, s: Slice, zf: number[], marker: { i: number; j: number } | null) {
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.fillStyle = '#04080f'; g.fillRect(0, 0, W, H);
  const div = DIVERGING.has(s.field);
  let lo = s.min, hi = s.max;
  if (div) { const m = Math.max(Math.abs(lo), Math.abs(hi), s.field === 'w' ? 1 : 1e-6); lo = -m; hi = m; }
  else { if (['cloud', 'precip', 'E', 'cape'].includes(s.field)) lo = 0; if (hi - lo < 1e-6) hi = lo + 1e-6; }
  const stops = div ? DIV : SEQ;
  const mapH = s.mode === 'h' ? Math.min(H, W) : H;
  const mapW = s.mode === 'h' ? mapH : W;
  const ox = s.mode === 'h' ? (W - mapW) / 2 : 0;
  if (s.mode === 'h') {
    const img = g.createImageData(s.w, s.h);
    for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
      const v = s.data[j * s.w + i], col = ramp(stops, (v - lo) / (hi - lo));
      const o = (j * s.w + i) * 4; img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
    const off = document.createElement('canvas'); off.width = s.w; off.height = s.h; off.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false; g.drawImage(off, ox, 0, mapW, mapH);
  } else {
    const ztop = zf[zf.length - 1];
    for (let k = 0; k < s.h; k++) {
      const y0 = H - (zf[k + 1] / ztop) * H, y1 = H - (zf[k] / ztop) * H;
      for (let i = 0; i < s.w; i++) {
        const col = ramp(stops, (s.data[k * s.w + i] - lo) / (hi - lo));
        g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        g.fillRect((i / s.w) * W, y0, W / s.w + 0.6, y1 - y0 + 0.6);
      }
    }
    g.strokeStyle = 'rgba(0,255,230,0.18)'; g.lineWidth = 1; g.fillStyle = 'rgba(160,255,240,0.5)'; g.font = '8px monospace';
    for (let km = 3; km < 15; km += 3) { const y = H - ((km * 1000) / ztop) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(km + 'km', 2, y - 1); }
  }
  // wind vectors (u,v in plan view; u,w in cross-section)
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 0.8;
  const stride = 4;
  for (let j = 0; j < s.h; j += stride) for (let i = 0; i < s.w; i += stride) {
    const u = s.ua[j * s.w + i], v = s.va[j * s.w + i];
    let cx: number, cy: number, dx: number, dy: number;
    if (s.mode === 'h') { cx = ox + ((i + 0.5) / s.w) * mapW; cy = ((j + 0.5) / s.h) * mapH; dx = u * 0.5; dy = v * 0.5; }
    else { const ztop = zf[zf.length - 1]; cx = ((i + 0.5) / s.w) * W; cy = H - (((zf[j] + zf[j + 1]) / 2) / ztop) * H; dx = u * 0.5; dy = -v * 1.2; }
    const L = Math.hypot(dx, dy); if (L < 0.2) continue;
    const m = Math.min(1, 7 / L);
    g.beginPath(); g.moveTo(cx - dx * m * 0.5, cy - dy * m * 0.5); g.lineTo(cx + dx * m * 0.5, cy + dy * m * 0.5); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(cx + dx * m * 0.5 - 0.8, cy + dy * m * 0.5 - 0.8, 1.6, 1.6);
  }
  if (marker) {
    g.strokeStyle = '#00ffe0'; g.lineWidth = 1;
    const mx = s.mode === 'h' ? ox + ((marker.i + 0.5) / s.w) * mapW : ((marker.i + 0.5) / s.w) * W;
    const my = s.mode === 'h' ? ((marker.j + 0.5) / s.h) * mapH : H - 2;
    g.beginPath(); g.arc(mx, my, 3, 0, 7); g.stroke();
  }
  g.fillStyle = 'rgba(200,255,250,0.85)'; g.font = '9px monospace';
  g.fillText(`${lo.toFixed(Math.abs(hi) < 10 ? 1 : 0)} … ${hi.toFixed(Math.abs(hi) < 10 ? 1 : 0)} ${s.unit}`, 3, 10);
}

export function drawSkewT(c: HTMLCanvasElement, snd: any) {
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.fillStyle = '#04080f'; g.fillRect(0, 0, W, H);
  const pTop = 150, pBot = 1020;
  const X = (T: number, p: number) => ((T + 48 + 36 * Math.log(1000 / p)) / 92) * W;
  const Y = (p: number) => ((Math.log(p) - Math.log(pBot)) / (Math.log(pTop) - Math.log(pBot))) * H;
  g.lineWidth = 0.6;
  for (let T = -80; T <= 40; T += 10) { g.strokeStyle = T === 0 ? 'rgba(0,255,230,0.35)' : 'rgba(0,255,230,0.1)'; g.beginPath(); g.moveTo(X(T, pBot), Y(pBot)); g.lineTo(X(T, pTop), Y(pTop)); g.stroke(); }
  g.fillStyle = 'rgba(160,255,240,0.5)'; g.font = '8px monospace';
  for (const p of [1000, 850, 700, 500, 300, 200]) { g.strokeStyle = 'rgba(0,255,230,0.15)'; g.beginPath(); g.moveTo(0, Y(p)); g.lineTo(W, Y(p)); g.stroke(); g.fillText(String(p), 1, Y(p) - 1); }
  const n = snd.p.length;
  const line = (arr: ArrayLike<number>, col: string, w = 1.4, dash = false) => {
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash ? [3, 2] : []); g.beginPath();
    let first = true;
    for (let k = 0; k < n; k++) { if (isNaN(arr[k])) continue; const x = X(arr[k], snd.p[k]), y = Y(snd.p[k]); if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
    g.stroke(); g.setLineDash([]);
  };
  // CAPE / CIN shading between the surface-based parcel and the environment
  for (let k = 1; k < n; k++) {
    if (isNaN(snd.tpar[k]) || isNaN(snd.tpar[k - 1])) continue;
    const pos = snd.tpar[k] > snd.T[k];
    g.fillStyle = pos ? 'rgba(255,150,40,0.28)' : 'rgba(60,120,255,0.22)';
    g.beginPath();
    g.moveTo(X(snd.T[k - 1], snd.p[k - 1]), Y(snd.p[k - 1])); g.lineTo(X(snd.T[k], snd.p[k]), Y(snd.p[k]));
    g.lineTo(X(snd.tpar[k], snd.p[k]), Y(snd.p[k])); g.lineTo(X(snd.tpar[k - 1], snd.p[k - 1]), Y(snd.p[k - 1])); g.fill();
  }
  line(snd.Td, '#3dff9a'); line(snd.T, '#ff4d5e'); line(snd.tpar, '#e8f6ff', 1, true);
}

// ---------------------------------------------------------------------------------------------
// Advanced radar: plan-view scope centred on the truck. Reflectivity (NWS-style dBZ ramp)
// or radial velocity (green inbound / red outbound), range rings, azimuth spokes, a rotating
// sweep and markers for the truck and any active vortex.
// ---------------------------------------------------------------------------------------------
export type RadarMode = 'ref' | 'vel';

const DBZ_STOPS: [number, RGB][] = [
  [5, [4, 120, 130]], [15, [10, 90, 230]], [25, [20, 200, 60]], [35, [170, 220, 30]],
  [45, [255, 230, 40]], [55, [255, 130, 20]], [65, [255, 40, 40]], [75, [255, 60, 240]],
];

function dbzRGB(d: number): RGB {
  if (d < 5) return [0, 0, 0];
  for (let i = 1; i < DBZ_STOPS.length; i++) {
    if (d <= DBZ_STOPS[i][0]) {
      const [d0, c0] = DBZ_STOPS[i - 1], [d1, c1] = DBZ_STOPS[i];
      const u = (d - d0) / (d1 - d0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * u)) as RGB;
    }
  }
  return DBZ_STOPS[DBZ_STOPS.length - 1][1];
}

function velRGB(v: number): RGB {
  const m = Math.min(1, Math.abs(v) / 35);
  if (Math.abs(v) < 2) return [16, 26, 38];
  return v < 0 ? [20, Math.round(90 + 150 * m), 40] : [Math.round(140 + 110 * m), Math.round(40 + 40 * m), 30];
}

/** Rebuild the n×n scope raster from a radar message (call only when data changes). */
export function radarRaster(data: any, mode: RadarMode): HTMLCanvasElement {
  const n = data.n as number;
  let cv = radarRaster.cache;
  if (!cv || cv.width !== n) { cv = document.createElement('canvas'); cv.width = n; cv.height = n; radarRaster.cache = cv; }
  const g = cv.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = ((n - 1 - j) * n + i) * 4;   // flip so north (+z? world +z is south here: our plan maps world +z downward like screen y)
      let c: RGB;
      if (mode === 'ref') {
        const d = data.dbz[j * n + i];
        c = dbzRGB(d);
        if (d < 5) img.data[o + 3] = 0;
        else { img.data[o + 3] = 235; }
      } else {
        const v = data.vel[j * n + i] * 40 / 127;
        c = velRGB(v);
        img.data[o + 3] = 235;
      }
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}
radarRaster.cache = null as any;

export interface RadarView {
  mode: RadarMode; range: number; cx: number; cz: number;   // world centre (truck)
  truckX: number; truckZ: number; heading: number;          // truck position + heading (deg, 0 = north)
  tornado: { x: number; z: number; active: boolean } | null;
  sweep: number;                                            // radians
}

/** Draw the full scope into cv (268 px class canvas). */
export function drawRadar(cv: HTMLCanvasElement, raster: HTMLCanvasElement | null, v: RadarView) {
  const g = cv.getContext('2d')!;
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 2;
  g.clearRect(0, 0, W, H);
  g.save();
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#020a12'; g.fillRect(0, 0, W, H);
  if (raster) g.drawImage(raster, cx - R, cy - R, R * 2, R * 2);
  // rotating sweep with a soft trailing wedge
  const a0 = v.sweep;
  const grad = g.createLinearGradient(cx, cy, cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
  grad.addColorStop(0, 'rgba(120,255,200,0.30)'); grad.addColorStop(1, 'rgba(120,255,200,0.02)');
  g.strokeStyle = grad; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R); g.stroke();
  // range rings + spokes (16 km rings on a 48 km scope)
  g.strokeStyle = 'rgba(120,200,255,0.30)'; g.lineWidth = 1;
  g.setLineDash([3, 4]);
  for (let r = 1; r <= 2; r++) { g.beginPath(); g.arc(cx, cy, (R * r) / 3, 0, Math.PI * 2); g.stroke(); }
  g.setLineDash([]);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    g.globalAlpha = 0.22; g.beginPath(); g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); g.globalAlpha = 1;
  }
  // world → scope: north up. World +x = east (right), +z = south (down).
  const toS = (wx: number, wz: number) => {
    let dx = wx - v.cx, dz = wz - v.cz;
    if (dx > v.range / 2) dx -= v.range; if (dx < -v.range / 2) dx += v.range;
    if (dz > v.range / 2) dz -= v.range; if (dz < -v.range / 2) dz += v.range;
    return [cx + (dx / (v.range / 2)) * R, cy + (dz / (v.range / 2)) * R] as const;
  };
  // vortex marker
  if (v.tornado?.active) {
    const [tx, ty] = toS(v.tornado.x, v.tornado.z);
    g.strokeStyle = '#ff7a3c'; g.lineWidth = 2;
    g.beginPath(); g.arc(tx, ty, 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(tx, ty, 3, 0, Math.PI * 2); g.stroke();
  }
  // truck at centre: heading-up triangle (scope itself stays north-up)
  const ha = (v.heading * Math.PI) / 180;
  g.save(); g.translate(cx, cy); g.rotate(ha);
  g.fillStyle = '#e8f6ff';
  g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill();
  g.restore();
  g.restore();
  // ring labels + north
  g.fillStyle = 'rgba(150,215,255,0.85)'; g.font = '9px monospace'; g.textAlign = 'left';
  g.fillText(`${Math.round(v.range / 3000)}km`, cx + 4, cy - (R * 1) / 3 - 3);
  g.fillText(`${Math.round((2 * v.range) / 3000)}km`, cx + 4, cy - (R * 2) / 3 - 3);
  g.textAlign = 'center'; g.fillStyle = '#9fdcff'; g.font = 'bold 10px monospace';
  g.fillText('N', cx, 11);
  // frame
  g.strokeStyle = '#155e75'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  // dBZ legend along the bottom (ref mode)
  if (v.mode === 'ref') {
    const bw = W - 24, bh = 6, bx = 12, by = H - 12;
    for (let i = 0; i < bw; i++) {
      const d = 5 + (70 * i) / bw;
      const c = dbzRGB(d);
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.fillRect(bx + i, by, 1, bh);
    }
    g.fillStyle = 'rgba(180,225,255,0.9)'; g.font = '8px monospace'; g.textAlign = 'left';
    g.fillText('5', bx, by - 2); g.textAlign = 'right'; g.fillText('75 dBZ', bx + bw, by - 2);
  }
}
