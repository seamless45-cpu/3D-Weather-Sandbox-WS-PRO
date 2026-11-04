import { Terrain } from './sim/terrain';
import { DOMAIN } from './sim/consts';

const SOUND_SPEED = 343;
const THUNDER_SR = 22050;

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode; wind!: GainNode; windF!: BiquadFilterNode; rain!: GainNode; leaf!: GainNode; leafF!: BiquadFilterNode;
  reverb!: ConvolverNode; wet!: GainNode; dry!: GainNode;
  enabled = true; t = 0; gust = 0;
  terrain: Terrain | null = null;
  /** Reused white noise for thunder grains; avoids Math.random() millions of times per flash. */
  noise!: Float32Array;
  private lastThunderMs = -Infinity;
  private thunderSources = new Set<AudioBufferSourceNode>();

  start(terrain: Terrain) {
    if (this.ctx) { this.ctx.resume(); return; }
    this.terrain = terrain;
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    // 22.05 kHz is plenty for wind/rain/thunder and halves the audio DSP cost on weak CPUs.
    let ctx: AudioContext;
    try { ctx = new AC({ sampleRate: THUNDER_SR }); } catch { ctx = new AC(); }
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? 0.8 : 0; this.master.connect(ctx.destination);
    // noise source
    const nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    const white = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const wd = white.getChannelData(0); for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.noise = wd;
    const src = (buf: AudioBuffer) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    // wind: pink noise, band-limited, level & colour follow the simulated surface wind
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'lowpass'; this.windF.frequency.value = 300; this.windF.Q.value = 0.6;
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    src(nb).connect(this.windF); this.windF.connect(this.wind); this.wind.connect(this.master);
    // rain
    const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 1400;
    const rf2 = ctx.createBiquadFilter(); rf2.type = 'peaking'; rf2.frequency.value = 4200; rf2.gain.value = 5;
    this.rain = ctx.createGain(); this.rain.gain.value = 0;
    src(white).connect(rf); rf.connect(rf2); rf2.connect(this.rain); this.rain.connect(this.master);
    // vegetation rustle
    this.leafF = ctx.createBiquadFilter(); this.leafF.type = 'bandpass'; this.leafF.frequency.value = 2800; this.leafF.Q.value = 0.7;
    this.leaf = ctx.createGain(); this.leaf.gain.value = 0;
    src(white).connect(this.leafF); this.leafF.connect(this.leaf); this.leaf.connect(this.master);
    // reverb for thunder tails
    this.reverb = ctx.createConvolver();
    // A 1.5 s mono impulse response keeps the convolution affordable on mobile audio threads.
    const irLen = Math.floor(ctx.sampleRate * 1.5);
    const ir = ctx.createBuffer(1, irLen, ctx.sampleRate);
    const a = ir.getChannelData(0);
    for (let i = 0; i < irLen; i++) a[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.45)) * (1 - Math.exp(-i / (ctx.sampleRate * 0.03)));
    this.reverb.buffer = ir;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.45; this.reverb.connect(this.wet); this.wet.connect(this.master);
    this.dry = ctx.createGain(); this.dry.gain.value = 1; this.dry.connect(this.master);
  }

  setEnabled(on: boolean) { this.enabled = on; if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.1); }

  /** Truck horn: classic dual-tone air horn (≈F4 + A4 saws) with an octave-down square for
   *  body, through a lowpass — short, loud, unmistakable. Key H / the HORN button. */
  horn() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    const dur = 0.6;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(0.55, t0 + 0.025);
    out.gain.setValueAtTime(0.55, t0 + dur - 0.14);
    out.gain.linearRampToValueAtTime(0, t0 + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.5;
    lp.connect(out);
    out.connect(this.master);
    const mk = (freq: number, type: OscillatorType, g: number, det = 0) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(lp);
      o.start(t0); o.stop(t0 + dur + 0.05);
    };
    mk(370, 'sawtooth', 0.34);        // ≈ F4
    mk(440, 'sawtooth', 0.28, 7);     // ≈ A4 — the dual-tone pair
    mk(185, 'square', 0.20);          // octave-down body
  }

  update(dt: number, wind: number, rainRate: number, forest: number) {
    if (!this.ctx) return;
    this.t += dt;
    this.gust = 0.75 + 0.25 * Math.sin(this.t * 0.7) * Math.sin(this.t * 0.37 + 1.3) + 0.15 * Math.sin(this.t * 2.9);
    const c = this.ctx.currentTime;
    const w = Math.min(18, wind);
    this.wind.gain.setTargetAtTime(Math.min(0.9, 0.012 + 0.05 * Math.pow(w, 1.2) * this.gust), c, 0.25);
    this.windF.frequency.setTargetAtTime(160 + 110 * w, c, 0.4);
    this.leaf.gain.setTargetAtTime(Math.min(0.2, 0.0015 * w * w * (0.4 + forest) * this.gust), c, 0.3);
    this.leafF.frequency.setTargetAtTime(2200 + 150 * w, c, 0.5);
    this.rain.gain.setTargetAtTime(Math.min(0.55, 0.45 * Math.sqrt(Math.min(rainRate, 80) / 80)), c, 0.4);
  }

  /**
   * Build a bounded thunder waveform from the channel geometry. Multicell stages can produce
   * several breakdowns per second; the old 260-grain, 40-second synthesis blocked the UI for
   * seconds on every flash. Grain count, grain tail and total duration are all hard-capped, and
   * the filters/envelopes use recurrences over a shared noise buffer instead of per-sample exp()
   * and Math.random() calls.
   */
  thunder(segs: Float32Array, off: [number, number], listener: [number, number, number], flashStartDelay = 0) {
    if (!this.ctx || !this.enabled || !this.terrain) return;
    const ctx = this.ctx, sr = THUNDER_SR;
    const n = segs.length / 10;
    if (n < 2) return;
    // One thunder per 180 ms and at most three overlapping tails. The solver still simulates every
    // flash; this only stops a lightning burst from turning into a main-thread/audio DSP pile-up.
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastThunderMs < 180) return;
    while (this.thunderSources.size >= 3) {
      const oldest = this.thunderSources.values().next().value as AudioBufferSourceNode | undefined;
      if (!oldest) break;
      this.thunderSources.delete(oldest);
      try { (oldest as any).stop?.(); } catch { /* already stopped */ }
    }
    this.lastThunderMs = nowMs;

    const MAX_GRAINS = 48;
    const step = Math.max(1, Math.ceil(n / MAX_GRAINS));
    type G = { t: number; a: number; fc: number; tau: number; crack: number };
    const grains: G[] = [];
    let tmin = 1e9, tmax = 0;
    for (let i = 0; i < n; i += step) {
      const o = i * 10;
      const px = (segs[o] + segs[o + 3]) / 2 + off[0], py = (segs[o + 1] + segs[o + 4]) / 2, pz = (segs[o + 2] + segs[o + 5]) / 2 + off[1];
      const dx = px - listener[0], dy = py - listener[1], dz = pz - listener[2];
      const d = Math.hypot(dx, dy, dz);
      const len = Math.hypot(segs[o + 3] - segs[o], segs[o + 4] - segs[o + 1], segs[o + 5] - segs[o + 2]) * step;
      // terrain obstruction: line-of-sight test against the heightfield
      let blocked = 0;
      for (let s = 1; s < 10; s++) {
        const f = s / 10;
        const x = ((listener[0] + dx * f) % DOMAIN + DOMAIN) % DOMAIN, z = ((listener[2] + dz * f) % DOMAIN + DOMAIN) % DOMAIN;
        if (this.terrain.groundHeight(x, z) > listener[1] + dy * f) blocked = 1;
      }
      const t = d / SOUND_SPEED;
      const atten = Math.exp(-d / 26000); // atmospheric absorption (mostly high frequencies)
      const a = ((24 * len) / (d + 90)) * atten * (blocked ? 0.55 : 1);
      const fc = Math.max(60, (9000 / (1 + d / 900)) * (blocked ? 0.45 : 1));
      grains.push({ t, a, fc, tau: 0.12 + d * 0.00006 + Math.random() * 0.15, crack: d < 3500 && !blocked ? Math.exp(-d / 1500) : 0 });
      tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    const dur = Math.min(10, tmax - tmin + 3);
    const total = Math.max(1, Math.floor(dur * sr));
    const out = new Float32Array(total);
    const noise = this.noise && this.noise.length ? this.noise : (() => { const w = new Float32Array(1 << 15); for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1; return w; })();
    const noiseLen = noise.length;
    let touched = 0;
    // Per-sample filter and envelope state is advanced with multiplication. Only the few grain
    // parameters need exp(); the old implementation called exp() and random() inside every loop.
    const addGrain = (t: number, a: number, fc: number, tau: number, attack: number, maxTail: number) => {
      const i0 = Math.floor((t - tmin) * sr);
      if (i0 < 0 || i0 >= total) return;
      const len = Math.min(total - i0, Math.floor(Math.min(tau * 2.2, maxTail) * sr));
      if (len <= 0) return;
      const alpha = 1 - Math.exp(-2 * Math.PI * fc / sr);
      const decay = Math.exp(-1 / (tau * sr));
      const atk = Math.max(1, Math.floor(attack * sr));
      let lp = 0, lp2 = 0, decayPow = 1, j = (Math.random() * noiseLen) | 0;
      for (let i = 0; i < len; i++) {
        const w = noise[j]; if (++j === noiseLen) j = 0;
        lp += alpha * (w - lp); lp2 += alpha * (lp - lp2);
        const env = Math.min(1, (i + 1) / atk) * decayPow;
        decayPow *= decay;
        out[i0 + i] += a * env * lp2 * 3.2;
      }
      touched = Math.max(touched, i0 + len);
    };
    for (const g of grains) {
      addGrain(g.t, g.a, g.fc, g.tau, 0.004, 0.28);                                  // body
      addGrain(g.t, g.a * 0.8, Math.min(220, g.fc), g.tau * 2.6, 0.03, 0.50);       // rolling rumble
      addGrain(g.t + 0.35 + Math.random() * 1.8, g.a * 0.3, g.fc * 0.5, g.tau * 2, 0.05, 0.30); // terrain echo
      if (g.crack > 0.02) addGrain(g.t, g.a * 1.8 * g.crack, 7000, 0.018, 0.0008, 0.05);     // near crack
    }
    // Cubic soft clip: cheaper than tanh over the whole buffer.
    for (let i = 0; i < touched; i++) {
      const v = out[i] * 0.55;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v * (1.5 - 0.5 * v * v);
    }
    const buf = ctx.createBuffer(1, total, sr);
    buf.getChannelData(0).set(out);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const gain = ctx.createGain(); gain.gain.value = 0.9;
    s.connect(gain); gain.connect(this.dry); gain.connect(this.reverb);
    this.thunderSources.add(s);
    const sn = s as any;
    sn.onended = () => {
      this.thunderSources.delete(s);
      try { sn.disconnect?.(); gain.disconnect?.(); } catch { /* already disconnected */ }
    };
    s.start(ctx.currentTime + tmin + flashStartDelay);
  }
}
