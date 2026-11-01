import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import SimWorker from './sim/worker?worker&inline';
import { Terrain } from './sim/terrain';
import { PRESETS } from './sim/thermo';
import { clockString } from './sim/sun';
import { Engine, detectQuality } from './render/engine';
import { Player } from './controls';
import { AudioEngine } from './audio';
import { drawSkewT, drawSlice } from './ui/draw';

const SPEEDS = [1, 5, 15, 30, 60];
const FIELDS: [string, string][] = [['w', 'W'], ['cloud', 'CLD'], ['precip', 'PCP'], ['T', 'T'], ['RH', 'RH'], ['E', 'E-FLD'], ['thp', "θ'"], ['p', "P'"], ['zeta', 'ζ'], ['cape', 'CAPE']];
const f0 = (x: number, d = 0) => (x === undefined || x === null || isNaN(x) ? '—' : x.toFixed(d));
const km = (m: number) => (isNaN(m) ? '—' : (m / 1000).toFixed(2));

interface Rt { engine: Engine; player: Player; audio: AudioEngine; worker: Worker; terrain: Terrain; raf: number; info: any }

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rtRef = useRef<Rt | null>(null);
  const snapRef = useRef<any>(null);
  const checksRef = useRef<any[]>([]);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const skewRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<'menu' | 'loading' | 'run' | 'error'>('menu');
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState('pulse');
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [diagOn, setDiagOn] = useState(false);
  const [field, setField] = useState('w');
  const [mode, setMode] = useState<'h' | 'v'>('h');
  const [level, setLevel] = useState(8);
  const [sound, setSound] = useState(true);
  const [about, setAbout] = useState(false);
  const [locked, setLocked] = useState(false);
  const [, setTick] = useState(0);
  const [touch] = useState(() => typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  const [lastFlash, setLastFlash] = useState<any>(null);

  const send = useCallback((m: any) => rtRef.current?.worker.postMessage(m), []);

  const start = useCallback(() => {
    setError(null);
    setPhase('loading');
    setTimeout(() => {
      try {
        const q = detectQuality();
        const terrain = new Terrain(q.M);
        const spawn = terrain.findSpawn();
        const n = q.M >= 512 ? 64 : 32, nz = q.M >= 512 ? 36 : 28, NZR = 48;
        const canvas = canvasRef.current!;
        const engine = new Engine(canvas, q, terrain, n, NZR);
        const player = new Player(canvas, terrain, spawn);
        player.onLockChange = setLocked;
        const audio = new AudioEngine();
        audio.start(terrain);
        const worker = new SimWorker();
        const rt: Rt = { engine, player, audio, worker, terrain, raf: 0, info: null };
        rtRef.current = rt; (window as any).__rt = rt;
        worker.onmessage = (ev: MessageEvent) => {
          const m = ev.data;
          if (m.type === 'ready') { rt.info = m.info; checksRef.current = m.checks; setPhase('run'); }
          else if (m.type === 'snap') {
            snapRef.current = m;
            engine.applySnapshot(m, performance.now() / 1000);
          } else if (m.type === 'flash') {
            const fv = engine.addFlash(m.event, new THREE.Vector3(player.x, player.y, player.z));
            if (fv) {
              audio.thunder(m.event.segs, [fv.off.x, fv.off.z], [player.x, player.y, player.z]);
              setLastFlash({ type: m.event.type, dist: fv.dist, q: m.event.chargeC, t: performance.now() });
            }
          }
        };
        worker.onerror = (ev: ErrorEvent) => {
          setError(ev.message || 'simulation worker failed');
          setPhase('error');
        };
        worker.postMessage({ type: 'init', n, nz, preset, seed: 11 });
        let last = performance.now(), camT = 0, audT = 0;
        const loop = () => {
          const now = performance.now();
          const dt = Math.min(0.1, (now - last) / 1000); last = now;
          player.update(dt);
          engine.render(dt, { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, fov: player.fov });
          camT += dt; audT += dt;
          if (camT > 0.2) { camT = 0; worker.postMessage({ type: 'cam', x: player.x, z: player.z }); }
          if (audT > 0.1) {
            audT = 0;
            const s = snapRef.current;
            if (s) audio.update(0.1, Math.hypot(s.local.u, s.local.v), s.local.rain, terrain.classAt(player.x, player.z)[0]);
          }
          rt.raf = requestAnimationFrame(loop);
        };
        rt.raf = requestAnimationFrame(loop);
        const onResize = () => engine.resize(window.innerWidth, window.innerHeight);
        window.addEventListener('resize', onResize);
      } catch (err) {
        // Surface boot failures (no WebGL, worker crash, bad grid) instead of hanging on the loader.
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    }, 60);
  }, [preset]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1e6), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => { const r = rtRef.current; if (r) { cancelAnimationFrame(r.raf); r.worker.terminate(); r.player.dispose(); r.engine.dispose(); } }, []);
  useEffect(() => { send({ type: 'cfg', paused, speed }); }, [paused, speed, send, phase]);
  useEffect(() => { send({ type: 'diag', field, mode, level }); }, [field, mode, level, send, phase]);
  useEffect(() => { rtRef.current?.audio.setEnabled(sound); }, [sound]);

  const s = snapRef.current;
  // draw diagnostics from the latest snapshot
  useEffect(() => {
    if (!diagOn || !s || !rtRef.current) return;
    const rt = rtRef.current;
    if (mapRef.current && s.diag) {
      const ci = Math.floor(rt.player.x / (32000 / s.diag.w)), cj = Math.floor(rt.player.z / (32000 / s.diag.w));
      drawSlice(mapRef.current, s.diag, rt.info?.zf || [], { i: ci, j: cj });
    }
    if (skewRef.current && s.sounding) drawSkewT(skewRef.current, s.sounding);
  });

  const reset = () => { send({ type: 'reset', preset }); rtRef.current?.engine.flashes.slice().forEach((f) => (rtRef.current!.engine as any).removeFlash(f)); setLastFlash(null); };

  const player = rtRef.current?.player;
  const sd = s?.sounding;
  const st = s?.stats;
  const heading = player ? (((-player.yaw * 180) / Math.PI) % 360 + 360) % 360 : 0;
  const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
  const wind = s ? Math.hypot(s.local.u, s.local.v) : 0;
  const levelKm = rtRef.current?.info ? (rtRef.current.info.zc[Math.min(level, rtRef.current.info.nz - 1)] / 1000).toFixed(1) : '—';
  const flashAge = lastFlash ? (performance.now() - lastFlash.t) / 1000 : 999;
  const holdMove = (f: number, sv = 0) => ({
    onTouchStart: (e: React.TouchEvent) => { e.stopPropagation(); if (player) { player.vf = f; player.vs = sv; } },
    onTouchEnd: (e: React.TouchEvent) => { e.stopPropagation(); if (player) { player.vf = 0; player.vs = 0; } },
    onTouchCancel: () => { if (player) { player.vf = 0; player.vs = 0; } },
  });

  return (
    <div className="fixed inset-0 select-none bg-black" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ touchAction: 'none' }} />

      {phase === 'menu' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#02070d]/90 p-4">
          <div className="hud scan relative w-[340px] max-w-full p-3">
            <div className="mb-1 text-[13px] tracking-[0.3em]"><b>ATMOS//SIM</b></div>
            <div className="mb-2 lbl">3-D anelastic convective atmosphere · ray-marched volumetric clouds · bulk microphysics · electrification</div>
            <div className="mb-1 lbl">INITIAL ENVIRONMENT (clear sky start, sounding only)</div>
            <div className="mb-2 flex flex-col gap-1">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => setPreset(p.id)} className={`hbtn text-left ${preset === p.id ? 'on' : ''}`}>
                  {p.name}<span className="lbl ml-1 normal-case tracking-normal">— {p.blurb}</span>
                </button>
              ))}
            </div>
            <button className="hbtn w-full !py-1 !text-[11px]" onClick={start}>▶ enter simulation</button>
            <div className="mt-2 lbl leading-snug">{touch ? 'Drag: look · Pinch: zoom · Hold ▲▼ to walk' : 'Click view: mouse-look · WASD / arrows: walk · Shift: run · wheel: zoom · Esc: release cursor'}<br />Weather starts clear and evolves from surface heating; storms form only if the environment allows.</div>
          </div>
        </div>
      )}
      {phase === 'loading' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#02070d]"><div className="hud p-3"><b>INITIALISING</b> terrain · solver · volumes …</div></div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#02070d]/95 p-4">
          <div className="hud w-[360px] max-w-full p-3">
            <div className="mb-1 text-[12px] tracking-[0.2em]"><b>UNABLE TO START</b></div>
            <div className="mb-2 break-words">{error || 'Unknown error'}</div>
            <div className="mb-2 lbl">A WebGL2-capable browser is required for the volumetric renderer.</div>
            <button className="hbtn" onClick={() => setPhase('menu')}>← back</button>
          </div>
        </div>
      )}

      {phase === 'run' && (
        <>
          {/* top-left status */}
          <div className="hud absolute left-1.5 top-1.5 z-10 px-1.5 py-1">
            <div><b>ATMOS//SIM</b> <span className="lbl">LT</span> <b>{s ? clockString(s.time) : '--:--'}</b> <span className="lbl">×</span>{s ? f0(s.speed, 0) : '—'}{s?.paused ? <span className="text-amber-300"> ‖PAUSED</span> : ''}</div>
            <div className="lbl">{s ? `${f0(wind, 1)}m/s ${f0(s.local.T, 1)}°C RH${f0(s.local.rh)}% ${s.local.rain > 0.1 ? `RAIN ${f0(s.local.rain, 1)}mm/h` : ''}` : 'sync…'}</div>
          </div>
          {/* heading */}
          <div className="hud absolute left-1.5 top-[46px] z-10 px-1.5 py-0.5"><b>{card}</b> {f0(heading)}° <span className="lbl">FOV</span> {f0(player?.fov || 72)}</div>
          {/* top-right controls */}
          <div className="hud absolute right-1.5 top-1.5 z-10 flex max-w-[60vw] flex-wrap items-center justify-end gap-1 px-1.5 py-1">
            <button className={`hbtn ${paused ? 'on' : ''}`} onClick={() => setPaused((p) => !p)}>{paused ? '▶' : '‖'}</button>
            {SPEEDS.map((v) => <button key={v} className={`hbtn ${speed === v ? 'on' : ''}`} onClick={() => setSpeed(v)}>{v}×</button>)}
            <select className="hsel" value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="hbtn" onClick={reset} title="Reset to clear sky with the selected environment">⟲ clear</button>
            <button className={`hbtn ${diagOn ? 'on' : ''}`} onClick={() => setDiagOn((d) => !d)}>diag</button>
            <button className={`hbtn ${sound ? 'on' : ''}`} onClick={() => setSound((d) => !d)}>♪</button>
            <button className="hbtn" onClick={() => setAbout(true)}>i</button>
          </div>
          {/* bottom-left thermodynamics */}
          <div className="hud absolute bottom-1.5 left-1.5 z-10 px-1.5 py-1 tabular-nums">
            <div><span className="lbl">SBCAPE</span> <b>{f0(sd?.sb.cape)}</b> <span className="lbl">CIN</span> <b>{f0(sd?.sb.cin)}</b> <span className="lbl">J/kg</span></div>
            <div><span className="lbl">MLCAPE</span> {f0(sd?.ml.cape)} <span className="lbl">MUCAPE</span> {f0(sd?.mu.cape)}</div>
            <div><span className="lbl">LCL</span> {km(sd?.sb.lcl)} <span className="lbl">LFC</span> {km(sd?.sb.lfc)} <span className="lbl">EL</span> {km(sd?.sb.el)} <span className="lbl">km</span></div>
            <div><span className="lbl">SHR0-6</span> {f0(sd?.shear06, 1)} <span className="lbl">m/s</span> <span className="lbl">WMAX</span> {f0(st?.maxW, 1)}</div>
            <div className="text-[#ffd27a]">{s?.mode?.label || '…'}</div>
            <div><span className="lbl">⚡</span> {st?.flashes ?? 0} {flashAge < 20 && <span className="lbl">last {lastFlash.type} {f0(lastFlash.dist / 1000, 1)}km</span>}</div>
          </div>

          {/* diagnostics panel */}
          {diagOn && (
            <div className="hud absolute right-1.5 top-[34px] z-10 max-h-[calc(100vh-80px)] w-[236px] overflow-y-auto p-1.5">
              <div className="mb-1 flex flex-wrap gap-0.5">
                {FIELDS.map(([k, l]) => <button key={k} className={`hbtn !px-[3px] ${field === k ? 'on' : ''}`} onClick={() => setField(k)}>{l}</button>)}
              </div>
              <div className="mb-1 flex items-center gap-1">
                <button className={`hbtn ${mode === 'h' ? 'on' : ''}`} onClick={() => setMode('h')}>plan</button>
                <button className={`hbtn ${mode === 'v' ? 'on' : ''}`} onClick={() => setMode('v')}>x-sect</button>
                {mode === 'h' && <><input className="hr" type="range" min={0} max={30} value={level} onChange={(e) => setLevel(+e.target.value)} /><span className="w-10 text-right">{levelKm}km</span></>}
              </div>
              <canvas ref={mapRef} width={224} height={mode === 'h' ? 150 : 110} className="mb-1 w-full border border-cyan-900/60" />
              <div className="lbl mb-0.5">SKEW-T · LOCAL COLUMN <span className="text-[#ff4d5e]">T</span> <span className="text-[#3dff9a]">Td</span> <span className="text-white">parcel</span></div>
              <canvas ref={skewRef} width={224} height={120} className="mb-1 w-full border border-cyan-900/60" />
              {st && (
                <div className="tabular-nums leading-[1.3]">
                  <div><span className="lbl">DOMAIN</span> maxCAPE {f0(s.capeMax)} · mean {f0(s.capeMean)}</div>
                  <div><span className="lbl">CLD</span> qc {f0(st.maxQc * 1000, 2)} qi {f0(st.maxQi * 1000, 2)} g/kg · <span className="lbl">PCP</span> qr {f0(st.maxQr * 1000, 1)} qg {f0(st.maxQg * 1000, 1)}</div>
                  <div><span className="lbl">RAIN</span> {f0(st.maxRain, 0)}mm/h · <span className="lbl">CP</span> {f0(st.coldPool * 100, 1)}% (ΔΘ {f0(st.coldPoolMin, 1)}K) · <span className="lbl">UH</span> {f0(st.maxUH)}</div>
                  <div><span className="lbl">ELEC</span> Emax {f0(st.maxE / 1000, 0)}kV/m ({f0(st.maxEratio * 100)}% of breakdown) · Q+ {f0(st.chargePos, 1)}C Q− {f0(st.chargeNeg, 1)}C</div>
                  <div className="mt-0.5 lbl">NUMERICS</div>
                  <div>∇·ρu max {st.maxDiv.toExponential(1)}/s · CFL {f0(st.cfl, 2)} · dt {f0(s.dt, 1)}s · {f0(s.stepMs, 0)}ms/step</div>
                  <div>H₂O budget residual {(st.waterRes * 100).toExponential(1)}% · energy residual {f0(st.energyRes * 100, 1)}% · KE {st.KE.toExponential(1)}J</div>
                  <div className="mt-0.5 lbl">VALIDATION</div>
                  {checksRef.current.map((c) => <div key={c.name} className={c.ok ? '' : 'text-red-400'}>{c.ok ? '✓' : '✗'} {c.name}: {c.value} <span className="lbl">({c.expect})</span></div>)}
                </div>
              )}
            </div>
          )}

          {!touch && !locked && <div className="hud absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2 px-2 py-0.5 lbl">click view to look · WASD walk · wheel zoom</div>}
          {touch && (
            <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-2">
              <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(1)}>▲</button>
              <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(-1)}>▼</button>
            </div>
          )}
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200/40" />
        </>
      )}

      {about && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-3" onClick={() => setAbout(false)}>
          <div className="hud max-h-[88vh] w-[560px] max-w-full overflow-y-auto p-3 leading-snug" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex justify-between"><b>MODEL NOTES</b><button className="hbtn" onClick={() => setAbout(false)}>×</button></div>
            <p><b>Resolved:</b> 3-D anelastic Navier–Stokes (∇·ρ₀u=0) on a 64×64×36 MAC grid (Δx=500 m, Δz 146→689 m, 32 km periodic box, 15 km lid), momentum + θ + water vapour + 5 hydrometeor species + 2 charge species advected with a mass-weighted TVD (van Leer) flux scheme, buoyancy from virtual potential temperature and condensate loading, exact FFT/tridiagonal pressure projection (div → round-off). Cold pools, gust fronts, updraft tilt and rotation are emergent. Nothing smaller than ~1.5 km is resolved.</p>
            <p className="mt-1"><b>Parameterised:</b> Deardorff 1.5-order TKE sub-grid closure (entrainment/mixing at cloud edges); surface energy balance (SW with slope/cloud shading, LW, sensible & latent flux, soil moisture, runoff); drag by land-cover roughness; kinematic terrain lifting at the lower boundary; bulk microphysics (Kessler warm rain, Bergeron/WBF deposition, riming, graupel, melting, freezing, evaporation, sedimentation); non-inductive charging (Saunders-type sign reversal at −12 °C, lumped coefficient); effective grid-scale breakdown field = 0.45·E_k(ρ); DBM leader growth on the solved potential; large-scale forcing as weak relaxation of domain-mean wind/θ/moisture and −1.5 K/day radiative cooling.</p>
            <p className="mt-1"><b>Visual only:</b> sub-grid cloud erosion noise (advected with cloud-weighted winds), rain streaks (placed where the simulated precipitation exists), splashes/ripples, vegetation sway, thunder synthesis from channel geometry (arrival time r/c, absorption, terrain obstruction).</p>
            <p className="mt-1"><b>Diagnostics:</b> CAPE/CIN/LCL/LFC/EL from parcel ascent (virtual-temperature buoyancy, pseudo-adiabat) over the live column; validated against Bolton e<sub>s</sub>, Espy LCL and the Weisman–Klemp sounding. Water budget uses surface evaporation, precipitation and nudging fluxes; the energy residual excludes frictional heating and is approximate.</p>
            <p className="mt-1 lbl">Limitations: periodic box, flat solver levels (terrain via lower-boundary w), single-moment microphysics, no aerosol, no Coriolis. Time-lapse (×N) compresses simulated time, including lightning rate.</p>
          </div>
        </div>
      )}
    </div>
  );
}
