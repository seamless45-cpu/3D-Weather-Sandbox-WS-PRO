import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import SimWorker from './sim/worker?worker&inline';
import { Terrain } from './sim/terrain';
import { DEFAULT_PARAMS, PARAM_SPECS, SimParams } from './sim/params';
import { clockString } from './sim/sun';
import { Engine, detectQuality, detectGpuTier, gpuLabel, readTierPref, readPRPref, writePRPref, qualityFor, solverGrid } from './render/engine';
import { Player, LIGHT_TYPES } from './controls';
import { AudioEngine } from './audio';
import { drawSkewT, drawSlice, drawRadar, radarRaster, RadarMode } from './ui/draw';

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
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [envOpen, setEnvOpen] = useState(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [diagOn, setDiagOn] = useState(false);
  const [field, setField] = useState('w');
  const [mode, setMode] = useState<'h' | 'v'>('h');
  const [level, setLevel] = useState(8);
  const [sound, setSound] = useState(true);
  const [about, setAbout] = useState(false);
  const [locked, setLocked] = useState(false);
  const [vehicleMode, setVehicleMode] = useState<'foot' | 'vehicle'>('foot');
  const [chargesOn, setChargesOn] = useState(false);
  // Device-pixel-ratio target: saved value or the auto-detected tier default.
  const [pr, setPr] = useState<number>(() => readPRPref() ?? qualityFor(readTierPref() || detectGpuTier()).pr);
  const prRef = useRef(pr);
  prRef.current = pr;
  const [, setTick] = useState(0);
  const [touch] = useState(() => typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  const [perf, setPerf] = useState<string>(() => readTierPref() || 'auto');
  const detected = useState(() => { try { return detectGpuTier(); } catch { return 'mid'; } })[0];
  const setPerfPref = (v: string) => {
    setPerf(v);
    try { if (v === 'auto') localStorage.removeItem('atmos.perf'); else localStorage.setItem('atmos.perf', v); } catch { /* ignore */ }
  };
  const [lastFlash, setLastFlash] = useState<any>(null);
  const [radarOn, setRadarOn] = useState(false);
  const [radarMode, setRadarMode] = useState<RadarMode>('ref');
  const [stationOn, setStationOn] = useState(false);
  const radarRef = useRef<HTMLCanvasElement>(null);
  const radarDataRef = useRef<any>(null);

  const send = useCallback((m: any) => rtRef.current?.worker.postMessage(m), []);

  // ---- advanced radar: request sweeps while the scope is open, redraw at frame rate
  useEffect(() => {
    if (!radarOn) { send({ type: 'radar', cx: 0, cz: 0, on: false }); return; }
    const tick = () => {
      const p = rtRef.current?.player;
      if (p) send({ type: 'radar', cx: p.x, cz: p.z, on: true });
    };
    tick();
    const iv = setInterval(tick, 400);
    return () => clearInterval(iv);
  }, [radarOn, send]);

  useEffect(() => {
    if (!radarOn) return;
    let raf = 0;
    let raster: HTMLCanvasElement | null = null;
    let rasterSrc: any = null;
    let rasterMode: RadarMode | null = null;
    const loop = () => {
      const cv = radarRef.current;
      const data = radarDataRef.current;
      if (cv && data) {
        if (data !== rasterSrc || radarMode !== rasterMode) {
          raster = radarRaster(data, radarMode); rasterSrc = data; rasterMode = radarMode;
        }
        const p = rtRef.current?.player;
        const tor = snapRef.current?.tornado;
        drawRadar(cv, raster, {
          mode: radarMode, range: data.range, cx: data.cx, cz: data.cz,
          truckX: p?.x ?? 0, truckZ: p?.z ?? 0,
          heading: p ? (((-p.yaw * 180) / Math.PI) % 360 + 360) % 360 : 0,
          tornado: tor ? { x: tor.x, z: tor.z, active: !!tor.active } : null,
          sweep: (performance.now() / 1400) * Math.PI * 2,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [radarOn, radarMode]);

  const start = useCallback(() => {
    setError(null);
    setPhase('loading');
    setTimeout(() => {
      try {
        const q = detectQuality();
        const terrain = new Terrain(q.M);
        const spawn = terrain.findSpawn();
        // Solver resolution follows CPU headroom, not just the GPU tier. Touch devices and
        // low-core CPUs stay on 32x32, while multi-core desktops can afford 64x64 cells. The
        // renderer's cloud texture still uses 48 vertical slices in every case.
        const grid = solverGrid(q);
        const n = grid.n, nz = grid.nz, NZR = 48;
        const canvas = canvasRef.current!;
        const engine = new Engine(canvas, q, terrain, n, NZR);
        engine.setUserPR(prRef.current);
        const player = new Player(canvas, terrain, spawn);
        player.onLockChange = setLocked;
        player.onModeChange = setVehicleMode;
        const audio = new AudioEngine();
        audio.start(terrain);
        player.onHorn = () => audio.horn();
        const worker = new SimWorker();
        const rt: Rt = { engine, player, audio, worker, terrain, raf: 0, info: null };
        rtRef.current = rt; (window as any).__rt = rt;
        let lastFlashMsg = -Infinity;
        worker.onmessage = (ev: MessageEvent) => {
          const m = ev.data;
          if (m.type === 'ready') { rt.info = m.info; checksRef.current = m.checks; setPhase('run'); }
          else if (m.type === 'snap') {
            snapRef.current = m;
            engine.applySnapshot(m, performance.now() / 1000);
            // The GPU copy is done: return the cloud/surface ArrayBuffers to the worker pool.
            if (m.cloud?.buffer && m.surf?.buffer) {
              const cloudBuf = m.cloud.buffer as ArrayBuffer, surfBuf = m.surf.buffer as ArrayBuffer;
              worker.postMessage({ type: 'recycle', cloud: cloudBuf, surf: surfBuf }, [cloudBuf, surfBuf]);
            }
          } else if (m.type === 'radar') {
            radarDataRef.current = m;
          } else if (m.type === 'flash') {
            // A lightning burst must not allocate bolt geometry, thunder and React state updates
            // for every breakdown. The worker already keeps the nearest flash of each burst.
            const nowFlash = performance.now();
            if (nowFlash - lastFlashMsg < 260) return;
            lastFlashMsg = nowFlash;
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
        worker.postMessage({ type: 'init', n, nz, params: paramsRef.current, seed: 11 });
        let last = performance.now(), camT = 0, audT = 0;
        const loop = () => {
          const now = performance.now();
          const rawDt = Math.max(1e-3, (now - last) / 1000);
          const dt = Math.min(0.1, rawDt); last = now;
          player.update(dt, snapRef.current?.tornado);
          engine.setVehiclePose(player.vehiclePose());
          engine.render(rawDt, { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, fov: player.fov });
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
        // Debounced: resize() reallocates every render target, so a burst of events
        // (mobile address bar, window drag) must not trigger a reallocation each time.
        let resizeT = 0;
        const onResize = () => {
          clearTimeout(resizeT);
          resizeT = window.setTimeout(() => engine.resize(window.innerWidth, window.innerHeight), 140);
        };
        window.addEventListener('resize', onResize);
      } catch (err) {
        // Surface boot failures (no WebGL, worker crash, bad grid) instead of hanging on the loader.
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    }, 60);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1e6), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => { const r = rtRef.current; if (r) { cancelAnimationFrame(r.raf); r.worker.terminate(); r.player.dispose(); r.engine.dispose(); } }, []);
  useEffect(() => { send({ type: 'cfg', paused, speed }); }, [paused, speed, send, phase]);
  // live parameter changes (debounced so dragging a slider does not rebuild the sounding every frame)
  useEffect(() => {
    const id = setTimeout(() => send({ type: 'params', params }), 140);
    return () => clearTimeout(id);
  }, [params, send]);
  useEffect(() => { send({ type: 'diag', field, mode, level, enabled: diagOn }); }, [field, mode, level, diagOn, send, phase]);
  useEffect(() => { rtRef.current?.audio.setEnabled(sound); }, [sound]);
  // show-charges toggle: ask the worker for the particle field and flip the renderer layer
  useEffect(() => {
    send({ type: 'charges', enabled: chargesOn });
    rtRef.current?.engine.showCharges(chargesOn);
  }, [chargesOn, send, phase]);
  // pixel-ratio slider: applied live (reallocates the render targets, so only on commit)
  useEffect(() => { rtRef.current?.engine.setUserPR(pr); }, [pr]);

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

  const reset = () => {
    send({ type: 'reset', params });
    rtRef.current?.engine.reset();
    const eng = rtRef.current?.engine;
    if (eng) {
      eng.stormLoad = 0; eng.cheapMode = false;
      eng.U.uPrecipDensity.value = 1; eng.U.uCheapShadows.value = 0;
      eng.U.uRainIntensity.value = 0; eng.U.uFlashGlow.value = 0; eng.U.uFlashOn.value = 0;
      eng.U.uHeavyRain.value = 0; eng.U.uTornado.value.set(16000, 16000, 220, 0);
      eng.tornado = null; eng.vehiclePose = null; eng.heavyRain = 0;
    }
    rtRef.current?.engine.flashes.slice().forEach((f) => (rtRef.current!.engine as any).removeFlash(f));
    setLastFlash(null);
  };

  const player = rtRef.current?.player;
  const sd = s?.sounding;
  const st = s?.stats;
  const tor = s?.tornado;
  const ch = s?.charge;
  const veh = player?.vehiclePose();
  const heading = player ? (((-player.yaw * 180) / Math.PI) % 360 + 360) % 360 : 0;
  const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
  const wind = s ? Math.hypot(s.local.u, s.local.v) : 0;
  const levelKm = rtRef.current?.info ? (rtRef.current.info.zc[Math.min(level, rtRef.current.info.nz - 1)] / 1000).toFixed(1) : '—';
  const flashAge = lastFlash ? (performance.now() - lastFlash.t) / 1000 : 999;
  const flashCls = (t: string) => (t === 'CG+' || t === 'ANVIL') ? 'text-[#ffb35a]' : t === 'CC' ? 'text-[#c99bff]' : 'text-[#7fd4ff]';
  const effPr = rtRef.current?.engine.renderer.getPixelRatio() ?? pr;
  const effW = rtRef.current?.engine.renderer.domElement.width ?? 0;
  const effH = rtRef.current?.engine.renderer.domElement.height ?? 0;
  const holdMove = (f: number, sv = 0) => ({
    onTouchStart: (e: React.TouchEvent) => { e.stopPropagation(); if (player) { player.vf = f; player.vs = sv; } },
    onTouchEnd: (e: React.TouchEvent) => { e.stopPropagation(); if (player) { player.vf = 0; player.vs = 0; } },
    onTouchCancel: () => { if (player) { player.vf = 0; player.vs = 0; } },
  });

  const paramSliders = (
    <div className="flex flex-col gap-1.5">
      {PARAM_SPECS.map((sp) => (
        <label key={sp.key} className="block" title={sp.hint}>
          <div className="flex items-baseline justify-between">
            <span className="lbl">{sp.label}</span>
            <b>{params[sp.key].toFixed(sp.decimals)} <span className="lbl">{sp.unit}</span></b>
          </div>
          <input
            className="hr"
            type="range"
            min={sp.min}
            max={sp.max}
            step={sp.step}
            value={params[sp.key]}
            onChange={(e) => setParams((p) => ({ ...p, [sp.key]: Number(e.target.value) }))}
          />
        </label>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 select-none bg-black" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ touchAction: 'none' }} />

      {phase === 'menu' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#02070d]/90 p-4">
          <div className="hud scan relative w-[340px] max-w-full p-3">
            <div className="mb-1 text-[13px] tracking-[0.3em]"><b>ATMOS//SIM</b></div>
            <div className="mb-2 lbl">3-D anelastic convective atmosphere · ray-marched volumetric clouds · bulk microphysics · electrification</div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="lbl">ENVIRONMENT · MICROPHYSICS</span>
              <button className="hbtn !px-1" onClick={() => setParams(DEFAULT_PARAMS)}>defaults</button>
            </div>
            <div className="mb-2 max-h-[44vh] overflow-y-auto pr-1">{paramSliders}</div>
            <div className="mb-1 flex items-center justify-between">
              <span className="lbl">RENDER QUALITY</span>
              <span className="lbl truncate pl-2 text-right" title={`auto-detected: ${detected}`}>{gpuLabel()}</span>
            </div>
            <div className="mb-2 flex gap-1">
              {['auto', 'low', 'mid', 'high'].map((v) => (
                <button key={v} className={`hbtn flex-1 !px-1 ${perf === v ? 'on' : ''}`} onClick={() => setPerfPref(v)}>
                  {v}{v === 'auto' ? ` · ${detected}` : ''}
                </button>
              ))}
            </div>
            <label className="mb-2 block" title="Device pixels per CSS pixel — sharper costs fill rate">
              <div className="flex items-baseline justify-between">
                <span className="lbl">PIXEL RATIO</span>
                <b>{pr.toFixed(2)}×</b>
              </div>
              <input className="hr" type="range" min={0.5} max={2} step={0.05} value={pr}
                onChange={(e) => { const v = Number(e.target.value); setPr(v); writePRPref(v); }} />
            </label>
            <button className="hbtn w-full !py-1 !text-[11px]" onClick={start}>▶ enter simulation</button>
            <div className="mt-2 lbl leading-snug">{touch ? 'Drag: look · Pinch: zoom · Hold ▲▼◀▶ to move · V: vehicle · P: probe' : 'Click view: mouse-look · WASD / arrows: walk · Shift: run · wheel: zoom · V: intercept vehicle · P: deploy probe · Esc: release cursor'}<br />Weather starts clear and evolves from surface heating; storms form only if the environment allows.</div>
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
            <div><b>ATMOS//SIM</b> <span className="lbl">LT</span> <b>{s ? clockString(s.time) : '--:--'}</b> <span className="lbl">×</span>{s ? f0(s.speed, 0) : '—'}{s?.paused ? <span className="text-amber-300"> ‖PAUSED</span> : ''} <span className={rtRef.current && rtRef.current.engine.fps < 30 ? 'text-amber-300' : 'lbl'}>{rtRef.current ? rtRef.current.engine.fps.toFixed(0) : '—'} fps</span></div>
            <div className="lbl">{s ? `${f0(wind, 1)}m/s ${f0(s.local.T, 1)}°C RH${f0(s.local.rh)}% ${s.local.rain > 0.1 ? `RAIN ${f0(s.local.rain, 1)}mm/h` : ''}` : 'sync…'}</div>
            {rtRef.current?.engine.timerExt && <div className="lbl">GPU scene {rtRef.current.engine.profile.scene.toFixed(1)} · cloud {rtRef.current.engine.profile.cloud.toFixed(1)} · comp {rtRef.current.engine.profile.comp.toFixed(1)} ms</div>}
          </div>
          {/* heading */}
          <div className="hud absolute left-1.5 top-[46px] z-10 px-1.5 py-0.5"><b>{card}</b> {f0(heading)}° <span className="lbl">FOV</span> {f0(player?.fov || 72)}{veh && veh.drink > 0 && <span className="text-[#ffd27a]"> · ⚡ DRINK ×10 {f0(veh.drink, 0)}s</span>}</div>

          {/* weather station: live surface observations at the truck */}
          {stationOn && s && (
            <div className="hud absolute left-1.5 top-[70px] z-10 px-1.5 py-1 tabular-nums">
              <div className="mb-0.5"><b>STATION</b> <span className="lbl">mobile mesonet</span></div>
              <div><span className="lbl">T</span> <b>{f0(s.local.T, 1)}</b>°C · <span className="lbl">Td</span> {f0(
                (() => { const g0 = Math.log(Math.max(1, s.local.rh) / 100) + (17.62 * s.local.T) / (243.12 + s.local.T); return (243.12 * g0) / (17.62 - g0); })(), 1)}°C · <span className="lbl">RH</span> {f0(s.local.rh, 0)}%</div>
              <div><span className="lbl">P</span> <b>{f0(s.local.p, 1)}</b> hPa · <span className="lbl">wind</span> <b>{f0(wind, 1)}</b> m/s {card} · <span className="lbl">gust</span> {f0(s.local.gust ?? 0, 1)}</div>
              <div><span className="lbl">rain</span> {f0(s.local.rain, 1)} mm/h · <span className="lbl">wet</span> {f0((s.local.wetness ?? 0) * 100, 0)}% · <span className="lbl">alt</span> {f0(s.local.gh, 0)} m</div>
            </div>
          )}

          {/* advanced radar scope */}
          {radarOn && (
            <div className="hud absolute right-1.5 top-[34px] z-10 w-[268px] p-1.5">
              <div className="mb-1 flex items-center justify-between">
                <b>📡 RADAR</b>
                <div className="flex gap-0.5">
                  <button className={`hbtn !px-1.5 ${radarMode === 'ref' ? 'on' : ''}`} onClick={() => setRadarMode('ref')}>REF</button>
                  <button className={`hbtn !px-1.5 ${radarMode === 'vel' ? 'on' : ''}`} onClick={() => setRadarMode('vel')}>VEL</button>
                  <button className="hbtn !px-1.5" onClick={() => setRadarOn(false)}>×</button>
                </div>
              </div>
              <canvas ref={radarRef} width={250} height={250} className="w-full border border-cyan-900/60" />
              <div className="lbl mt-0.5">{radarMode === 'ref' ? 'reflectivity dBZ' : 'radial velocity m/s · green in / red out'} · ±48 km · rings 16/32 km</div>
              <div className="lbl">{radarDataRef.current ? `sweep ${f0(radarDataRef.current.t, 0)}s` : 'awaiting sweep…'}</div>
            </div>
          )}
          {/* top-right controls */}
          <div className="hud absolute right-1.5 top-1.5 z-10 flex max-w-[60vw] flex-wrap items-center justify-end gap-1 px-1.5 py-1">
            <button className={`hbtn ${paused ? 'on' : ''}`} onClick={() => setPaused((p) => !p)}>{paused ? '▶' : '‖'}</button>
            {SPEEDS.map((v) => <button key={v} className={`hbtn ${speed === v ? 'on' : ''}`} onClick={() => setSpeed(v)}>{v}×</button>)}
            <button className={`hbtn ${envOpen ? 'on' : ''}`} onClick={() => setEnvOpen((o) => !o)} title="Environment and microphysics controls">⚙ env</button>
            <button className={`hbtn ${chargesOn ? 'on' : ''}`} onClick={() => setChargesOn((c) => !c)} title="Show charge particles: + positive (red) / − negative (blue)">± charges</button>
            <button className={`hbtn ${radarOn ? 'on' : ''}`} onClick={() => { setRadarOn((r) => !r); setDiagOn(false); }} title="Advanced radar: reflectivity and radial velocity scope centred on the truck">📡 radar</button>
            <button className={`hbtn ${stationOn ? 'on' : ''}`} onClick={() => setStationOn((o) => !o)} title="Weather station: live surface observations at your position">☂ met</button>
            <button className="hbtn" onClick={reset} title="Reset to clear sky with the current parameters">⟲ clear</button>
            <button className={`hbtn ${vehicleMode === 'vehicle' ? 'on' : ''}`} onClick={() => rtRef.current?.player.toggleVehicle()} title="Enter / exit the intercept vehicle">🚙 {vehicleMode === 'vehicle' ? 'exit' : 'drive'}</button>
            <button className={`hbtn ${diagOn ? 'on' : ''}`} onClick={() => { setDiagOn((d) => !d); setRadarOn(false); }}>diag</button>
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
            <div><span className="lbl">⚡</span> {st?.flashes ?? 0} {flashAge < 20 && <span className={flashCls(lastFlash.type)}>last {lastFlash.type} {f0(lastFlash.dist / 1000, 1)}km</span>}</div>
            <div className={tor?.active ? 'text-[#ff9a5a]' : 'lbl'}>
              {tor?.active ? `🌪 EF${Math.max(0, tor.ef)} ${f0(tor.maxWind, 0)}m/s Δp ${f0(tor.pressureDrop, 0)}hPa · ${f0(tor.distance / 1000, 1)}km` : `🌪 potential ${f0(tor?.potential, 2)} · shear1 ${f0(tor?.shear1, 1)} SRH1 ${f0(tor?.srh1, 1)}`}
            </div>
            <div className="lbl">CHARGE sep {f0((st?.chargeSep ?? 0) / 1000, 1)}kC/s · tripole {f0(st?.chargeTripole, 2)} · E {f0((st?.maxE ?? 0) / 1000, 0)}kV/m</div>
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
                  <div><span className="lbl">CHARGE</span> NI {f0((ch?.sepRate ?? 0) / 1000, 1)} · IND {f0((ch?.inductiveRate ?? 0) / 1000, 1)} · SCR {f0((ch?.screeningRate ?? 0) / 1000, 1)} kC/s · tripole {f0(ch?.tripole, 2)}</div>
                  <div><span className="lbl">VORTEX</span> {tor?.active ? `EF${Math.max(0, tor.ef)} ${f0(tor.maxWind, 0)}m/s R ${f0(tor.radius, 0)}m LCL ${km(tor.lcl)}km funnel ${km(tor.funnelBottom)}–${km(tor.funnelTop)}km` : `potential ${f0(tor?.potential, 2)} target ${f0(tor?.target, 2)}`}</div>
                  <div className="mt-0.5 lbl">NUMERICS</div>
                  <div>∇·ρu max {st.maxDiv.toExponential(1)}/s · CFL {f0(st.cfl, 2)} · dt {f0(s.dt, 1)}s · {f0(s.stepMs, 0)}ms/step</div>
                  <div>H₂O budget residual {(st.waterRes * 100).toExponential(1)}% · energy residual {f0(st.energyRes * 100, 1)}% · KE {st.KE.toExponential(1)}J</div>
                  <div className="mt-0.5 lbl">VALIDATION</div>
                  {checksRef.current.map((c) => <div key={c.name} className={c.ok ? '' : 'text-red-400'}>{c.ok ? '✓' : '✗'} {c.name}: {c.value} <span className="lbl">({c.expect})</span></div>)}
                </div>
              )}
            </div>
          )}

          {envOpen && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-3" onClick={() => setEnvOpen(false)}>
              <div className="hud max-h-[86vh] w-[340px] max-w-full overflow-y-auto p-2.5" onClick={(e) => e.stopPropagation()}>
                <div className="mb-1 flex items-center justify-between">
                  <b>ENVIRONMENT · MICROPHYSICS</b>
                  <button className="hbtn" onClick={() => setEnvOpen(false)}>×</button>
                </div>
                <div className="mb-1 lbl">sounding CAPE {f0(s?.envCape)} J/kg · applies live</div>
                {paramSliders}
                <label className="mt-1.5 block" title="Device pixels per CSS pixel — higher is sharper, costs fill rate">
                  <div className="flex items-baseline justify-between">
                    <span className="lbl">PIXEL RATIO</span>
                    <b>{pr.toFixed(2)}× <span className="lbl">→ {effPr.toFixed(2)}× · {effW}×{effH}</span></b>
                  </div>
                  <input className="hr" type="range" min={0.5} max={2} step={0.05} value={pr}
                    onChange={(e) => { const v = Number(e.target.value); setPr(v); writePRPref(v); }} />
                </label>
                <div className="mt-1.5 flex items-center justify-between">
                  <button className="hbtn" onClick={() => setParams(DEFAULT_PARAMS)}>defaults</button>
                  <span className="lbl">CAPE re-targets the sounding</span>
                </div>
              </div>
            </div>
          )}

          {vehicleMode === 'vehicle' && veh && (
            <div className="hud absolute bottom-1.5 right-1.5 z-10 w-[248px] px-1.5 py-1 tabular-nums">
              <div className="flex items-baseline justify-between">
                <b>INTERCEPT</b>
                <span className="lbl">{veh.lights ? '◉ LIGHTS' : '○ lights'} · {veh.probe ? 'PROBE OUT' : 'probe stowed'}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                {/* analog speedometer: 0–200 km/h over a 240° sweep */}
                <svg width="78" height="72" viewBox="0 0 78 72" className="shrink-0">
                  <circle cx="39" cy="36" r="32" fill="#03131c" stroke="#164e63" strokeWidth="1.5" />
                  {Array.from({ length: 9 }, (_, i) => {
                    const a = ((-210 + i * 30) * Math.PI) / 180;
                    const r0 = i % 2 === 0 ? 24 : 27;
                    return <line key={i} x1={39 + Math.cos(a) * r0} y1={36 + Math.sin(a) * r0}
                      x2={39 + Math.cos(a) * 30} y2={36 + Math.sin(a) * 30}
                      stroke={i >= 6 ? '#ff8a5a' : '#3a7a94'} strokeWidth={i % 2 === 0 ? 1.6 : 1} />;
                  })}
                  {(() => {
                    const kmh = Math.min(200, Math.max(0, (veh?.speed ?? 0) * 3.6));
                    const a = ((-210 + (kmh / 200) * 240) * Math.PI) / 180;
                    const col = (veh?.drink ?? 0) > 0 ? '#ffd27a' : kmh > 145 ? '#ff8a5a' : '#7fd4ff';
                    return <line x1={39 - Math.cos(a) * 6} y1={36 - Math.sin(a) * 6}
                      x2={39 + Math.cos(a) * 25} y2={36 + Math.sin(a) * 25}
                      stroke={col} strokeWidth="2.6" strokeLinecap="round" />;
                  })()}
                  <circle cx="39" cy="36" r="2.5" fill="#e8f6ff" />
                  <text x="39" y="60" textAnchor="middle" fontSize="12" fontWeight="700" fill="#e8f6ff" fontFamily="monospace">{f0((veh?.speed ?? 0) * 3.6, 0)}</text>
                  <text x="39" y="18" textAnchor="middle" fontSize="7" fill="#5f8fa8" fontFamily="monospace">km/h</text>
                </svg>
                <div className="flex-1 tabular-nums">
                  <div><b>{f0(veh.speed * 3.6, 0)}</b> <span className="lbl">km/h</span> <span className="lbl">· {f0(veh.speed, 1)}m/s</span></div>
                  <div className="lbl">{f0(Math.abs(veh.roll) * 57.3, 0)}° roll · {f0(Math.abs(veh.pitch) * 57.3, 0)}° pitch</div>
                  {(veh.drink ?? 0) > 0
                    ? <div className="text-[#ffd27a]">⚡ ENERGY {f0(veh.drink, 0)}s <span className="lbl">×10 speed</span></div>
                    : <div className="lbl">G — energy drink ×10 / 30s</div>}
                </div>
              </div>
              <div className="mt-0.5 h-[5px] w-full border border-cyan-900/70 bg-[#03131c]">
                <div className="h-full bg-cyan-400/80" style={{ width: `${Math.max(0, Math.min(100, (veh.speed / 50) * 100))}%` }} />
              </div>
              <div className="mt-0.5">
                {isFinite(veh.distance)
                  ? <>vortex <b>{f0(veh.distance / 1000, 2)}km</b> · {veh.closing > 0.4 ? <span className="text-[#ff9a5a]">CLOSING {f0(veh.closing, 1)}</span> : veh.closing < -0.4 ? <span className="text-[#7fd4ff]">opening {f0(-veh.closing, 1)}</span> : <span className="lbl">holding</span>} <span className="lbl">m/s</span></>
                  : <span className="lbl">vortex —</span>}
              </div>
              <div className="lbl">wind {f0(veh.wind, 0)}m/s · Δp {f0(veh.pressureDrop, 1)}hPa{tor?.active ? ` · EF${Math.max(0, tor.ef)}` : ''}</div>
              <div className={veh.damage > 0.35 ? 'text-[#ff9a5a]' : 'lbl'}>
                hull {f0(veh.damage * 100, 0)}%{veh.damage > 0.7 ? ' · POWER LOSS' : ''} · W/S gas · A/D steer · Space slide · P probe · <span className="text-[#7fd4ff]">{veh.lights ? LIGHT_TYPES[veh.lightType ?? 0].name : 'LIGHTS OFF'}</span> (L) · K cycle · H horn · G drink
              </div>
            </div>
          )}
          {!touch && !locked && <div className="hud absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2 px-2 py-0.5 lbl">click view to look · WASD walk · Space jump · wheel zoom</div>}
          {touch && (
            <div className="absolute bottom-3 right-3 z-10 flex items-end gap-2">
              <div className="flex flex-col gap-2">
                <button
                  className="hbtn !px-3 !py-3 !text-sm"
                  title="Energy drink: ×10 speed/power for 30 s"
                  onTouchStart={(e) => { e.stopPropagation(); player?.drink(); }}
                >⚡ G</button>
                {vehicleMode === 'foot' && (
                  <button
                    className="hbtn !px-3 !py-3 !text-sm"
                    title="Jump"
                    onTouchStart={(e) => { e.stopPropagation(); player?.jump(); }}
                  >⬆ JUMP</button>
                )}
                {vehicleMode === 'vehicle' && (
                  <>
                    <button
                      className="hbtn !px-3 !py-3 !text-sm"
                      title="Horn"
                      onTouchStart={(e) => { e.stopPropagation(); player?.onHorn?.(); }}
                    >📯 HORN</button>
                    <button
                      className="hbtn !px-3 !py-3 !text-sm"
                      title="Headlights: off → halogen → xenon → LED → off"
                      onTouchStart={(e) => { e.stopPropagation(); player?.touchLights(); }}
                    >💡 {player?.vehicle.lights ? ['HAL', 'XEN', 'LED'][player.vehicle.lightType] : 'OFF'}</button>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(1)}>▲</button>
                <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(-1)}>▼</button>
              </div>
              <div className="flex gap-2">
                <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(0, -1)}>◀</button>
                <button className="hbtn !px-4 !py-3 !text-base" {...holdMove(0, 1)}>▶</button>
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200/40" />
        </>
      )}

      {about && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-3" onClick={() => setAbout(false)}>
          <div className="hud max-h-[88vh] w-[560px] max-w-full overflow-y-auto p-3 leading-snug" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex justify-between"><b>MODEL NOTES</b><button className="hbtn" onClick={() => setAbout(false)}>×</button></div>
            <div className="mb-1 lbl">RENDER {rtRef.current ? `${rtRef.current.engine.q.tier} · ${rtRef.current.engine.fps.toFixed(0)} fps · scene ${rtRef.current.engine.renderer.domElement.width}×${rtRef.current.engine.renderer.domElement.height} · cloud ${rtRef.current.engine.cloudW}×${rtRef.current.engine.cloudH}` : gpuLabel()}</div>
            {rtRef.current?.engine.timerExt && (
              <div className="mb-1 lbl">GPU scene {rtRef.current.engine.profile.scene.toFixed(1)} · cloud {rtRef.current.engine.profile.cloud.toFixed(1)} · comp {rtRef.current.engine.profile.comp.toFixed(1)} ms</div>
            )}
            <p><b>Resolved:</b> 3-D anelastic Navier–Stokes (∇·ρ₀u=0) on a 64×64×36 MAC grid (Δx=500 m, Δz 146→689 m, 32 km periodic box, 15 km lid), momentum + θ + water vapour + 5 hydrometeor species + 2 charge species advected with a mass-weighted TVD (van Leer) flux scheme, buoyancy from virtual potential temperature and condensate loading, exact FFT/tridiagonal pressure projection (div → round-off). Cold pools, gust fronts, updraft tilt and rotation are emergent. Nothing smaller than ~1.5 km is resolved.</p>
            <p className="mt-1"><b>Parameterised:</b> Deardorff 1.5-order TKE closure; surface energy balance, soil moisture and land-cover drag; kinematic terrain lifting; bulk microphysics with precipitation-efficiency controls; f-plane Coriolis at 38°N; mixed-phase electrification (LWC-dependent charge-sign reversal, inductive charging and a tripole/screening structure carried by heavy and light hydrometeors); effective breakdown field = 0.45·E_k(ρ); DBM leader growth on the solved potential.</p>
            <p className="mt-1"><b>Sub-grid vortex:</b> tornadogenesis is derived from the simulated low-level vorticity/convergence, 2–5 km updraft helicity, storm-local 0–1 km shear/heighticity, CAPE, LCL and cold pool. A bounded Rankine vortex feeds tangential wind and frictional inflow back into the lowest solver levels before projection; funnel height, core radius, EF-like wind, pressure deficit and debris follow from cyclostrophic balance and cloud base. It is a coupled parameterization, not a resolved LES.</p>
            <p className="mt-1"><b>Visual / interaction:</b> domain-periodic, temporally-clamped and reprojected Perlin-Worley clouds with two-stage domain warping, billow-lobe cauliflower structure and one-tap side/self shading; a real-time GPU stable-fluids flow field drives cloud shear, rainshaft lean, drop drift and gust-front swirl; six bowed, noise-torn rainshaft planes with falling strand structure, virga tendrils and forward-scatter lighting; genuinely heavy companded precipitation and clearly visible distant curtains; helical condensation funnel and debris; a fully reworked intercept vehicle with grip-model handling, suspension pitch/roll/bounce, vortex gust buffeting, damage-stolen power, spinning anemometer, rotating radome, deployable probe, lamps (L) and a telemetry HUD.</p>
            <p className="mt-1"><b>Electrical:</b> negative and positive lightning trigger differently — CG− starts in the mid-level negative charge at full breakdown field with a branchy stepped leader and several return strokes; CG+ starts in the upper positive charge region (or the lower positive pocket) at ~80% of breakdown when the reservoir is large, grows straighter and usually lands one very high-peak-current stroke with a long continuing current (amber in the HUD, thicker hotter channel). The ± charges toggle renders the simulated charge pockets as + (red) and − (blue) particles.</p>
            <p className="mt-1"><b>Diagnostics:</b> CAPE/CIN/LCL/LFC/EL from parcel ascent over the live column; validated against Bolton e<sub>s</sub>, Espy LCL and the Weisman–Klemp sounding. Water budget uses surface evaporation, precipitation and nudging fluxes; the energy residual excludes frictional heating and is approximate.</p>
            <p className="mt-1 lbl">Limitations: periodic box, flat solver levels (terrain via lower-boundary w), single-moment microphysics, no aerosol, no nested tornado LES, no resolved cyclone/planetary dynamics. Time-lapse (×N) compresses simulated time, including lightning rate. Realism is prioritised over frame rate on mid/low devices.</p>
          </div>
        </div>
      )}
    </div>
  );
}
