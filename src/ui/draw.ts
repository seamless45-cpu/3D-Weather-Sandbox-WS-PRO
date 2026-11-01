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
