import * as THREE from 'three';
import { Terrain } from '../sim/terrain';
import { DOMAIN } from '../sim/consts';
import { sunState } from '../sim/sun';
import { computeLighting } from './skyModel';
import { makeNoiseData } from './noise';
import * as S from './glsl';
import * as T from './tornadoGlsl';

export type Tier = 'low' | 'mid' | 'high';
export interface Quality {
  tier: Tier; pr: number; cloudScale: number; stepScale: number; minCloudScale: number;
  M: number; rain: number; treeGrid: number; msaa: number; splashes: boolean; shafts: number; steps: number;
  /** Hard budgets in device pixels. A 4K/retina window must not multiply the cost by 4. */
  maxPixels: number; maxCloudPixels: number;
}

/** Preset for each performance tier. `low` targets entry-level mobile GPUs (Adreno 6xx, Mali-G5x). */
export function qualityFor(tier: Tier): Quality {
  // M is the terrain lattice: 256 (125 m spacing) is already finer than any landform the
  // solver resolves, so a 512 mesh buys nothing and costs 4x the triangles.
  if (tier === 'low') return { tier, pr: 0.8, cloudScale: 0.62, stepScale: 2.2, minCloudScale: 0.45, M: 256, rain: 2200, treeGrid: 16, msaa: 0, splashes: true, shafts: 12, steps: 30, maxPixels: 1.4e6, maxCloudPixels: 0.9e6 };
  if (tier === 'mid') return { tier, pr: Math.min(window.devicePixelRatio || 1, 1), cloudScale: 0.72, stepScale: 1.3, minCloudScale: 0.50, M: 256, rain: 6500, treeGrid: 28, msaa: 0, splashes: true, shafts: 24, steps: 64, maxPixels: 2.6e6, maxCloudPixels: 1.4e6 };
  return { tier: 'high', pr: Math.min(window.devicePixelRatio || 1, 1.25), cloudScale: 0.9, stepScale: 1.0, minCloudScale: 0.62, M: 256, rain: 14000, treeGrid: 56, msaa: 2, splashes: true, shafts: 32, steps: 96, maxPixels: 4.2e6, maxCloudPixels: 2.2e6 };
}

/** Probe the GPU string once and release the throwaway context (mobile browsers limit live contexts). */
function probeRenderer(): string {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = (ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '') + ' ' + String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/** Guess the tier from the GPU string; mobile parts are detected explicitly because core count lies. */
export function detectGpuTier(): Tier {
  try {
    const name = probeRenderer();
    if (!name.trim()) return 'low';
    const s = name.toLowerCase();
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    // Software rasterisers (SwiftShader/llvmpipe) can never fill a volumetric buffer: the old
    // fallback put them on the high tier, which is why the app felt frozen on some machines.
    if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(s)) return 'low';
    const adreno = s.match(/adreno[^0-9]*([0-9]{3})/);
    if (adreno) return parseInt(adreno[1], 10) >= 700 ? 'mid' : 'low';   // 6xx and older: entry level
    if (/mali-4|mali-t|mali-g[0-4]|powervr|videocore/.test(s)) return 'low';
    if (/uhd|hd graphics|hd 4[0-9]{2}|hd 5[0-9]{2}|gma/.test(s)) return 'low';
    if (/mali-g[5-9]|apple gpu|iris|intel|radeon|vega/.test(s)) return 'mid';
    if (coarse) return 'low';        // unknown mobile GPU: assume the entry-level path
    if (cores <= 4) return 'mid';
    return 'mid';                    // conservative: unknown desktop GPU, let the user opt into high
  } catch { return 'mid'; }
}

/** Short human-readable GPU string for the menu, e.g. "Adreno (TM) 610". */
export function gpuLabel(): string {
  const n = probeRenderer();
  return n.trim() ? n.replace(/^ANGLE \(|\)$/g, '').slice(0, 42) : 'no webgl2';
}

export function readTierPref(): Tier | null {
  try {
    const q = new URLSearchParams(location.search).get('perf');
    if (q === 'low' || q === 'mid' || q === 'high') return q;
    const v = localStorage.getItem('atmos.perf');
    return v === 'low' || v === 'mid' || v === 'high' ? v : null;
  } catch { return null; }
}

function isCoarsePointer(): boolean {
  try { return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches; } catch { return false; }
}
function isMobile(): boolean {
  try { return isCoarsePointer() || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent); } catch { return isCoarsePointer(); }
}

/**
 * Auto-detected phones get a conservative GPU budget even when their GPU string looks
 * flagship-class. An explicit ?perf=high / menu override is still honoured.
 */
export function detectQuality(): Quality {
  const pref = readTierPref();
  const q = qualityFor(pref || detectGpuTier());
  if (!pref && isMobile() && q.tier !== 'low') {
    q.pr = Math.min(q.pr, 1);
    q.cloudScale = Math.min(q.cloudScale, 0.66);
    q.minCloudScale = Math.min(q.minCloudScale, 0.46);
    q.stepScale = Math.max(q.stepScale, 1.2);
    q.steps = Math.min(q.steps, 52);
    q.maxPixels = Math.min(q.maxPixels, 2.2e6);
    q.maxCloudPixels = Math.min(q.maxCloudPixels, 1.1e6);
    q.rain = Math.min(q.rain, 5000);
    q.treeGrid = Math.min(q.treeGrid, 36);
    q.shafts = Math.min(q.shafts, 20);
    q.msaa = 0;
  }
  return q;
}

/**
 * Solver resolution is CPU-bound, not GPU-bound. A 64x64x48 storm step costs roughly four times
 * a 32x32x36 one, so touch devices stay on the coarser grid; only a multi-core desktop gets the
 * full 64x64x48 solver. The cloud texture still has 48 vertical samples (NZR) in every case.
 */
export function solverGrid(q: Quality): { n: number; nz: number } {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  if (q.tier === 'low') return { n: 32, nz: 28 };
  if (isMobile() || cores < 6) return { n: 32, nz: 36 };
  if (q.tier === 'high') return { n: 64, nz: 48 };
  return { n: 64, nz: 36 };
}

export interface FlashEvent {
  id: number; type: string; simTime: number; init: number[]; strike: number[] | null; segs: Float32Array;
  strokes: { t: number; amp: number }[]; ccEnd: number; ccAmp: number; leaderEnd: number; chargeC: number; ratio: number;
}
export interface FlashVis {
  ev: FlashEvent; t0: number; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; off: THREE.Vector3;
  cloudPos: THREE.Vector3; groundPos: THREE.Vector3; end: number; dist: number;
}

const L = DOMAIN;

export class Engine {
  renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; scene = new THREE.Scene();
  terrain: Terrain; q: Quality;
  U: Record<string, { value: any }>;
  cloudTex: THREE.Data3DTexture; noiseTex: THREE.Data3DTexture; surfTex: THREE.DataTexture;
  rtScene!: THREE.WebGLRenderTarget; rtCloud: THREE.WebGLRenderTarget[] = []; cur = 0;
  cloudScene = new THREE.Scene(); compScene = new THREE.Scene(); ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  cloudMat: THREE.ShaderMaterial; compMat: THREE.ShaderMaterial;
  terrainMesh: THREE.Mesh; waterMesh: THREE.Mesh; treeMesh: THREE.Mesh; rainMesh: THREE.Mesh; splashMesh: THREE.Mesh; shaftMesh: THREE.Mesh;
  funnelMesh: THREE.Mesh; debrisPoints: THREE.Points; vehicleGroup: THREE.Group;
  tornado: any = null; vehiclePose: any = null; heavyRain = 0; chargeTripole = 0; denoise = 1;
  flashes: FlashVis[] = []; frame = 0; prevVP = new THREE.Matrix4(); lastAng = [0, 0];
  exposure = 1; expoTarget = 1; time = 0; lastSimTime = 9 * 3600;
  nx = 64; nz = 48;
  offPrev = new Float32Array(32); offCur = new Float32Array(32); offVel = new Float32Array(32); offT = 0;
  localWind = new THREE.Vector2(); tmpV = new THREE.Vector3();
  lowTimer = 0; highTimer = 0; cloudScale: number; dynStep = 1; prScale = 1; lastSpike = 0; lastSoftSpike = 0;
  cloudW = 0; cloudH = 0; stormLoad = 0; cheapMode = false;
  // GPU time per pass in ms (EXT_disjoint_timer_query_webgl2); null when unavailable.
  timerExt: any = null;
  profile = { scene: 0, cloud: 0, comp: 0 };
  private timerQ: WebGLQuery[][] = [[], [], []];
  flashLevel = 0; sunDirV = new THREE.Vector3(0, 1, 0); defs?: Record<string, number>; cssW = 1; cssH = 1;
  adaptive = true;   // runtime degradation; disabled with ?noadapt for diagnostics
  fps = 60;
  lightingDayness = 1; camTau = 0; rainAtCam = 0; rh = 0.5; snowLevel = 3500;

  constructor(canvas: HTMLCanvasElement, q: Quality, terrain: Terrain, nx: number, nzr: number) {
    try { this.adaptive = !new URLSearchParams(location.search).has('noadapt'); } catch { /* keep default */ }
    this.q = q; this.terrain = terrain; this.nx = nx; this.nz = nzr; this.cloudScale = q.cloudScale;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(q.pr);
    this.renderer.autoClear = false;
    // Opt-in only: reading query results every frame is a pipeline sync and can itself
    // perturb the frame times we are trying to measure. ?profile=1 enables it.
    try {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      this.timerExt = new URLSearchParams(location.search).has('profile')
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    } catch { this.timerExt = null; }
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.3, 90000);
    this.camera.rotation.order = 'YXZ';

    // ---- textures
    this.cloudTex = new THREE.Data3DTexture(new Uint8Array(nx * nx * nzr * 4), nx, nx, nzr);
    this.cloudTex.format = THREE.RGBAFormat; this.cloudTex.type = THREE.UnsignedByteType;
    this.cloudTex.minFilter = this.cloudTex.magFilter = THREE.LinearFilter;
    this.cloudTex.wrapS = this.cloudTex.wrapT = THREE.RepeatWrapping; this.cloudTex.wrapR = THREE.ClampToEdgeWrapping;
    this.cloudTex.unpackAlignment = 1; this.cloudTex.needsUpdate = true;
    const NS = 48;
    this.noiseTex = new THREE.Data3DTexture(makeNoiseData(NS), NS, NS, NS);
    this.noiseTex.format = THREE.RGBAFormat; this.noiseTex.type = THREE.UnsignedByteType;
    this.noiseTex.minFilter = this.noiseTex.magFilter = THREE.LinearFilter;
    this.noiseTex.wrapS = this.noiseTex.wrapT = this.noiseTex.wrapR = THREE.RepeatWrapping;
    this.noiseTex.unpackAlignment = 1; this.noiseTex.needsUpdate = true;
    this.surfTex = new THREE.DataTexture(new Uint8Array(nx * nx * 4), nx, nx, THREE.RGBAFormat);
    this.surfTex.minFilter = this.surfTex.magFilter = THREE.LinearFilter;
    this.surfTex.wrapS = this.surfTex.wrapT = THREE.RepeatWrapping; this.surfTex.needsUpdate = true;
    const hTex = new THREE.DataTexture(terrain.heights, terrain.M, terrain.M, THREE.RedFormat, THREE.FloatType);
    hTex.minFilter = hTex.magFilter = THREE.NearestFilter; hTex.needsUpdate = true;
    const cTex = new THREE.DataTexture(terrain.cls, terrain.M, terrain.M, THREE.RGBAFormat);
    cTex.minFilter = cTex.magFilter = THREE.LinearFilter; cTex.wrapS = cTex.wrapT = THREE.RepeatWrapping; cTex.needsUpdate = true;

    const V3 = THREE.Vector3;
    this.U = {
      uTime: { value: 0 }, uSunDir: { value: new V3(0, 1, 0) }, uSunCol: { value: new V3(1, 1, 1) }, uSkyAmb: { value: new V3(0.2, 0.3, 0.5) },
      uHorizon: { value: new V3(0.5, 0.6, 0.8) }, uGroundAmb: { value: new V3(0.2, 0.2, 0.2) }, uTwilight: { value: 0 },
      uDomain: { value: DOMAIN }, uVis: { value: 30000 }, uSkyScale: { value: 14 }, uCloud: { value: this.cloudTex },
      uFlash: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) }, uFlashCol: { value: new V3(0.82, 0.88, 1.0) },
      uFlashOn: { value: 0 },
      uWind: { value: this.localWind },
      uHeight: { value: hTex }, uM: { value: terrain.M }, uSpacing: { value: terrain.spacing },
      uClass: { value: cTex }, uSurf: { value: this.surfTex }, uCamXZ: { value: new THREE.Vector2() },
      uCamCloud: { value: 0 }, uPrecipDensity: { value: 1 }, uCheapShadows: { value: 0 },
      uRainIntensity: { value: 0 }, uFlashGlow: { value: 0 },
      uTornado: { value: new THREE.Vector4(DOMAIN / 2, DOMAIN / 2, 220, 0) }, uTornadoTop: { value: 1200 },
      uHeavyRain: { value: 0 }, uCloudRes: { value: new THREE.Vector2(1, 1) }, uDenoise: { value: 1 },
    };
    const U = this.U;
    // Low tier compiles a cut-down variant of every shader (see #ifdef LOWQ in glsl.ts)
    this.defs = q.tier === 'low' ? { LOWQ: 1 } : undefined;
    const mk = (vs: string, fs: string, extra: Record<string, { value: any }> = {}, opts: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...U, ...extra }, ...(this.defs ? { defines: { ...this.defs } } : {}), ...opts });

    // ---- sky
    // Drawn after the opaque pass with a depth test: the sky shader only runs for pixels the
    // terrain/trees did not cover, instead of shading the whole screen and being overdrawn.
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mk(S.skyVert, S.skyFrag, {}, { depthTest: true, depthWrite: false }));
    sky.frustumCulled = false; sky.renderOrder = 1.5; this.scene.add(sky);

    // ---- terrain (camera-centred lattice mesh; heights fetched from the shared lattice texture)
    const SG = q.M;
    const idx = new Float32Array((SG + 1) * (SG + 1) * 2);
    for (let b = 0; b <= SG; b++) for (let a = 0; a <= SG; a++) { const o = (b * (SG + 1) + a) * 2; idx[o] = a - SG / 2; idx[o + 1] = b - SG / 2; }
    const ind = new Uint32Array(SG * SG * 6);
    let p = 0;
    for (let b = 0; b < SG; b++) for (let a = 0; a < SG; a++) {
      const v00 = b * (SG + 1) + a, v10 = v00 + 1, v01 = v00 + SG + 1, v11 = v01 + 1;
      ind[p++] = v00; ind[p++] = v11; ind[p++] = v10; ind[p++] = v00; ind[p++] = v01; ind[p++] = v11;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('aIdx', new THREE.BufferAttribute(idx, 2)); tg.setIndex(new THREE.BufferAttribute(ind, 1));
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const snapU = { uSnap: { value: new THREE.Vector2() } };
    this.terrainMesh = new THREE.Mesh(tg, mk(S.terrainVert, S.terrainFrag, snapU));
    this.terrainMesh.frustumCulled = false; this.scene.add(this.terrainMesh);

    // ---- water
    this.waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mk(S.waterVert, S.waterFrag, {}, { transparent: true }));
    this.waterMesh.frustumCulled = false; this.waterMesh.renderOrder = 2; this.scene.add(this.waterMesh);

    // ---- vegetation (procedurally placed around the player)
    this.treeMesh = new THREE.Mesh(this.buildTrees(q.treeGrid), mk(S.treeVert, S.treeFrag, {
      uCS: { value: 18 }, uHalf: { value: q.treeGrid / 2 }, uTreeWind: { value: new THREE.Vector2() },
    }));
    this.treeMesh.frustumCulled = false; this.treeMesh.renderOrder = 1; this.scene.add(this.treeMesh);

    // ---- precipitation shafts (one billboard per column, from the ground into the cloud base)
    this.shaftMesh = new THREE.Mesh(this.buildShafts(Math.max(8, Math.min(q.shafts, nx >> 1))), mk(S.shaftVert, S.shaftFrag, {
      uShaftWind: { value: new THREE.Vector2() }, uSnowLevel: { value: 3500 }, uNoise: { value: this.noiseTex },
    }, { transparent: true, depthWrite: false }));
    this.shaftMesh.frustumCulled = false; this.shaftMesh.renderOrder = 2; this.scene.add(this.shaftMesh);

    // ---- rain + splashes
    this.rainMesh = new THREE.Mesh(this.buildParticles(q.rain), mk(S.rainVert, S.rainFrag, { uSnowLevel: { value: 3500 } }, { transparent: true, depthWrite: false }));
    this.rainMesh.frustumCulled = false; this.rainMesh.renderOrder = 3; this.scene.add(this.rainMesh);
    this.splashMesh = new THREE.Mesh(this.buildParticles(Math.max(1, Math.floor(q.rain * 0.42))), mk(S.splashVert, S.splashFrag, {}, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    if (!q.splashes) this.splashMesh.visible = false;
    this.splashMesh.frustumCulled = false; this.splashMesh.renderOrder = 3; this.scene.add(this.splashMesh);

    // ---- solver-driven condensation funnel, debris cloud and intercept vehicle
    const funnelGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 36, true);
    const funnelExtra = {
      uTop: { value: 1200 }, uBottom: { value: 0 }, uRadius: { value: 220 },
      uIntensity: { value: 0 }, uDebris: { value: 0 }, uFunnelSeed: { value: Math.random() * 6.283 },
    };
    this.funnelMesh = new THREE.Mesh(funnelGeo, mk(T.funnelVert, T.funnelFrag, funnelExtra, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.funnelMesh.frustumCulled = false; this.funnelMesh.renderOrder = 3.5; this.funnelMesh.visible = false; this.scene.add(this.funnelMesh);
    const debrisGeo = new THREE.BufferGeometry();
    const debrisSeed = new Float32Array(900 * 3);
    for (let i = 0; i < debrisSeed.length; i++) debrisSeed[i] = Math.random();
    debrisGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(900 * 3), 3));
    debrisGeo.setAttribute('aSeed', new THREE.BufferAttribute(debrisSeed, 3));
    this.debrisPoints = new THREE.Points(debrisGeo, mk(T.debrisVert, T.debrisFrag, { uDebris: { value: 0 }, uTop: { value: 1200 } }, { transparent: true, depthWrite: false }));
    this.debrisPoints.frustumCulled = false; this.debrisPoints.renderOrder = 3.6; this.debrisPoints.visible = false; this.scene.add(this.debrisPoints);
    this.vehicleGroup = this.buildVehicle(mk(T.vehicleVert, T.vehicleFrag));
    this.vehicleGroup.visible = false; this.vehicleGroup.renderOrder = 4; this.scene.add(this.vehicleGroup);

    // ---- cloud + composite passes
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: S.fsVert, fragmentShader: S.cloudFrag, depthTest: false, depthWrite: false,
      glslVersion: THREE.GLSL3,
      ...(this.defs ? { defines: { ...this.defs } } : {}),
      uniforms: {
        ...U, uNoise: { value: this.noiseTex }, uDepth: { value: null }, uHist: { value: null }, uHistAux: { value: null }, uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uFrame: { value: 0 }, uBlend: { value: 0 }, uStepScale: { value: q.stepScale }, uMaxSteps: { value: q.steps },
        uDetail: { value: 1 }, uCheapLight: { value: 0 }, uWindOff: { value: Array.from({ length: 16 }, () => new THREE.Vector2()) },
      },
    });
    const cq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudMat); cq.frustumCulled = false; this.cloudScene.add(cq);
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: S.fsVert, fragmentShader: S.compFrag, depthTest: false, depthWrite: false,
      uniforms: { uScene: { value: null }, uCloudRT: { value: null }, uCloudAux: { value: null }, uExposure: { value: 1 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCloudRes: { value: new THREE.Vector2(1, 1) }, uCheapUpsample: { value: 0 }, uDenoise: { value: 1 } },
    });
    const cp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat); cp.frustumCulled = false; this.compScene.add(cp);
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  /** Six fixed-azimuth, independently seeded planes per precipitation column. The overlap
   *  forms a cylindrical rainshaft that reads as a volume from every camera angle. */
  private buildShafts(n: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const SHAFT_PLANES = 6;
    const quads = n * n * SHAFT_PLANES;
    const col = new Float32Array(quads * 4 * 4);
    const corner = new Float32Array(quads * 4 * 2);
    const pos = new Float32Array(quads * 4 * 3);
    const idx = new Uint32Array(quads * 6);
    const cell = DOMAIN / n;
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * cell, z = (j + 0.5) * cell;
      const base = ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 997) / 997;
      for (let layer = 0; layer < SHAFT_PLANES; layer++) {
        for (let v = 0; v < 4; v++) {
          const vi = q * 4 + v;
          corner[vi * 2] = v === 1 || v === 3 ? 1 : 0;
          corner[vi * 2 + 1] = v >= 2 ? 1 : 0;
          col[vi * 4] = x; col[vi * 4 + 1] = z; col[vi * 4 + 2] = base; col[vi * 4 + 3] = layer;
        }
        idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
        q++;
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(DOMAIN / 2, 4000, DOMAIN / 2), DOMAIN);
    return g;
  }

  private buildTrees(grid: number): THREE.InstancedBufferGeometry {
    const pos: number[] = [], nor: number[] = [], col: number[] = [];
    const cone = (y0: number, r: number, h: number, c: number[], seg = 8) => {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const pts = [[Math.cos(a0) * r, y0, Math.sin(a0) * r], [Math.cos(a1) * r, y0, Math.sin(a1) * r], [0, y0 + h, 0]];
        const ns = [[Math.cos(a0), 0.45, Math.sin(a0)], [Math.cos(a1), 0.45, Math.sin(a1)], [Math.cos((a0 + a1) / 2), 0.45, Math.sin((a0 + a1) / 2)]];
        for (let k = 0; k < 3; k++) { pos.push(...pts[k]); const l = Math.hypot(...ns[k]); nor.push(ns[k][0] / l, ns[k][1] / l, ns[k][2] / l); col.push(...c); }
      }
    };
    const trunk = (h: number, r: number) => {
      const seg = 5;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const q = [[Math.cos(a0) * r, 0, Math.sin(a0) * r], [Math.cos(a1) * r, 0, Math.sin(a1) * r], [Math.cos(a1) * r * 0.7, h, Math.sin(a1) * r * 0.7], [Math.cos(a0) * r * 0.7, h, Math.sin(a0) * r * 0.7]];
        for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...q[k]); nor.push(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)); col.push(0.11, 0.07, 0.04); }
      }
    };
    trunk(3.2, 0.28);
    cone(2.0, 2.7, 5.4, [0.035, 0.085, 0.03]); cone(4.8, 2.2, 4.8, [0.04, 0.1, 0.035]); cone(7.6, 1.5, 4.2, [0.05, 0.115, 0.04]);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    const cells = new Float32Array(grid * grid * 2);
    for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) { cells[(j * grid + i) * 2] = i; cells[(j * grid + i) * 2 + 1] = j; }
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    g.instanceCount = grid * grid;
    return g;
  }

  /** Low-poly mesonet-style intercept truck: chassis, cabin, roof rack, probe mast and wheels. */
  private buildVehicle(material: THREE.ShaderMaterial): THREE.Group {
    const group = new THREE.Group();
    const part = (geom: THREE.BufferGeometry, color: [number, number, number], x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      const g = geom.clone();
      const n = g.getAttribute('position').count;
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { cols[i * 3] = color[0]; cols[i * 3 + 1] = color[1]; cols[i * 3 + 2] = color[2]; }
      g.setAttribute('aColor', new THREE.BufferAttribute(cols, 3));
      const m = new THREE.Mesh(g, material);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz); group.add(m);
    };
    const armored: [number, number, number] = [0.16, 0.19, 0.20];
    const glass: [number, number, number] = [0.12, 0.20, 0.26];
    const trim: [number, number, number] = [0.42, 0.40, 0.34];
    part(new THREE.BoxGeometry(4.6, 1.05, 2.15), armored, 0, 0.95, 0);
    part(new THREE.BoxGeometry(2.35, 1.15, 2.0), armored, -0.45, 1.95, 0);
    part(new THREE.BoxGeometry(2.30, 0.65, 2.03), glass, -0.45, 2.18, 0);
    part(new THREE.BoxGeometry(4.75, 0.16, 2.25), trim, 0, 1.52, 0);
    part(new THREE.BoxGeometry(1.55, 0.10, 2.15), trim, 1.35, 1.55, 0);
    part(new THREE.BoxGeometry(0.10, 1.95, 0.10), trim, 0.45, 2.85, 0.85);
    part(new THREE.BoxGeometry(0.10, 1.95, 0.10), trim, 0.45, 2.85, -0.85);
    part(new THREE.BoxGeometry(1.45, 0.09, 0.09), trim, 0.45, 3.82, 0);
    part(new THREE.BoxGeometry(0.09, 1.65, 0.09), trim, -0.25, 3.0, 0);
    part(new THREE.BoxGeometry(0.55, 0.55, 0.55), [0.55, 0.12, 0.08], -0.25, 3.95, 0);
    const wheel = new THREE.CylinderGeometry(0.56, 0.56, 0.38, 16);
    for (const x of [-1.55, 1.55]) for (const z of [-1.16, 1.16]) {
      part(wheel, [0.045, 0.045, 0.05], x, 0.56, z, Math.PI / 2, 0, 0);
    }
    return group;
  }

  private buildParticles(n: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(n * 3), drops = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) seeds[i * 3 + k] = Math.random();
      // Skewed toward small drops: a few large, bright, fast ones among many fine ones.
      drops[i * 4] = 0.18 + 1.35 * Math.pow(Math.random(), 2.2);
      drops[i * 4 + 1] = 0.25 + 0.75 * Math.random();
      drops[i * 4 + 2] = Math.random();
      drops[i * 4 + 3] = Math.random();
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    g.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
    g.instanceCount = n;
    return g;
  }

  /** Largest pixel ratio that keeps the scene pass inside this tier's pixel budget. */
  private maxPixelRatio(): number {
    return Math.min(this.q.pr, Math.sqrt(this.q.maxPixels / Math.max(1, this.cssW * this.cssH)));
  }

  resize(w: number, h: number) {
    this.cssW = w; this.cssH = h;
    const pr = Math.max(0.3, this.maxPixelRatio() * this.prScale);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const W = Math.max(2, Math.floor(w * pr)), H = Math.max(2, Math.floor(h * pr));
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.rtScene?.dispose();
    const dt = new THREE.DepthTexture(W, H);
    this.rtScene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthTexture: dt, samples: this.q.msaa });
    this.makeCloudRT(W, H);
    this.compMat.uniforms.uRes.value.set(W, H);
    this.frame = 0;
  }
  private makeCloudRT(W: number, H: number) {
    for (const r of this.rtCloud) r.dispose();
    const scale = Math.min(this.cloudScale, Math.sqrt(this.q.maxCloudPixels / Math.max(1, W * H)));
    const cw = Math.max(2, Math.floor(W * scale)), ch = Math.max(2, Math.floor(H * scale));
    this.cloudW = cw; this.cloudH = ch;
    // count: 2 -> MRT. Attachment 0 is the cloud radiance/transmittance, attachment 1 the
    // scattering depth used for temporal reprojection and the edge-aware upscale.
    this.rtCloud = [0, 1].map(() => new THREE.WebGLRenderTarget(cw, ch, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, count: 2 }));
    this.frame = 0;
  }

  /** Apply a simulation snapshot to the GPU resources. */
  applySnapshot(s: any, realNow: number) {
    (this.cloudTex.image.data as Uint8Array).set(s.cloud); this.cloudTex.needsUpdate = true;
    (this.surfTex.image.data as Uint8Array).set(s.surf); this.surfTex.needsUpdate = true;
    const dtr = Math.max(0.03, realNow - this.offT);
    for (let i = 0; i < 32; i++) { this.offVel[i] = (s.windOff[i] - this.offCur[i]) / dtr; this.offCur[i] = s.windOff[i]; }
    this.offT = realNow;
    this.lastSimTime = s.time;
    this.camTau = s.local.tau; this.rainAtCam = s.local.rain; this.rh = s.local.rh / 100;
    if (typeof s.snowLevel === 'number') this.snowLevel = s.snowLevel;
    this.localWind.set(s.local.u, s.local.v);
    this.tornado = s.tornado || null;
    this.chargeTripole = typeof s.charge?.tripole === 'number' ? s.charge.tripole : 0;
    // Pre-empt the multicell transition: cloud coverage, core count and rain all predict the
    // coming dense-march/precipitation cost, so quality starts easing before frames are lost.
    const cf = typeof s.stats?.cloudFrac === 'number' ? s.stats.cloudFrac : 0;
    const cores = typeof s.mode?.cores === 'number' ? s.mode.cores : 0;
    const rain = typeof s.stats?.maxRain === 'number' ? s.stats.maxRain : 0;
    this.heavyRain = typeof s.heavyRain === 'number' ? s.heavyRain : Math.min(1, rain / 95);
    const load = Math.min(1, 0.45 * Math.min(1, cf / 0.5) + 0.4 * Math.min(1, cores / 8) + 0.15 * Math.min(1, rain / 80));
    this.stormLoad += (load - this.stormLoad) * 0.45;
  }

  /** Place the player-driven intercept vehicle from the controller's pose. */
  setVehiclePose(pose: any) {
    this.vehiclePose = pose;
    const v = this.vehicleGroup;
    if (!pose || !pose.active) { v.visible = false; return; }
    const gh = this.terrain.groundHeight(pose.x, pose.z);
    v.visible = true;
    v.position.set(pose.x, gh + 0.05, pose.z);
    v.rotation.set(0, pose.heading || 0, pose.roll || 0);
  }

  /** How much condensate sits *at the camera* (0..1). Drives the cheap surface shaders and
   *  tells the cloud march it can trust the current frame instead of the history buffer.
   *  Only the camera's own layer is sampled: a storm base a kilometre overhead must not
   *  switch the renderer into its "engulfed" path. */
  private camCloudAt(x: number, y: number, z: number): number {
    const d = this.cloudTex.image.data as Uint8Array;
    const nx = this.nx, nz = this.nz, nxy = nx * nx;
    const i0 = Math.min(nx - 1, Math.max(0, Math.floor((x / DOMAIN) * nx)));
    const j0 = Math.min(nx - 1, Math.max(0, Math.floor((z / DOMAIN) * nx)));
    const kc = Math.min(nz - 1, Math.max(0, Math.floor((y / 15000) * nz)));
    let m = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const j = (j0 + dj + nx) % nx;
      for (let di = -1; di <= 1; di++) {
        const i = (i0 + di + nx) % nx;
        const v = d[(kc * nxy + j * nx + i) * 4] / 255;
        if (v > m) m = v;
      }
    }
    return Math.min(1, Math.max(0, (m - 0.08) / 0.32));
  }

  /**
   * Build a continuous ribbon from the DBM graph. Neighbour endpoints are attached to each
   * segment so the vertex shader can miter joints, taper branches and hide quad seams.
   */
  addFlash(ev: FlashEvent, cam: THREE.Vector3) {
    const n = ev.segs.length / 10;
    if (n < 1) return;
    type Endpoint = [number, number, number];
    const A: Endpoint[] = [], B: Endpoint[] = [];
    const meta: { gen: number; dist: number; order: number; width: number }[] = [];
    let maxGen = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 10, s = ev.segs;
      A.push([s[o], s[o + 1], s[o + 2]]);
      B.push([s[o + 3], s[o + 4], s[o + 5]]);
      const gen = s[o + 6]; maxGen = Math.max(maxGen, gen);
      meta.push({ gen, dist: s[o + 7], order: s[o + 8], width: s[o + 9] });
    }
    const key = (p: Endpoint) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;
    const adj = new Map<string, { seg: number; other: Endpoint }[]>();
    const add = (k: string, seg: number, other: Endpoint) => {
      const list = adj.get(k) || []; list.push({ seg, other }); adj.set(k, list);
    };
    for (let i = 0; i < n; i++) { add(key(A[i]), i, B[i]); add(key(B[i]), i, A[i]); }
    const avgOther = (k: string, exclude: number): Endpoint | null => {
      const list = adj.get(k); if (!list) return null;
      let x = 0, y = 0, z = 0, c = 0;
      for (const e of list) if (e.seg !== exclude) { x += e.other[0]; y += e.other[1]; z += e.other[2]; c++; }
      return c ? [x / c, y / c, z / c] : null;
    };

    const aA = new Float32Array(n * 12), aB = new Float32Array(n * 12);
    const aPrev = new Float32Array(n * 12), aNext = new Float32Array(n * 12);
    const aS = new Float32Array(n * 16), aC = new Float32Array(n * 8), aSeed = new Float32Array(n * 8);
    const ind = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const prev = avgOther(key(A[i]), i) || A[i];
      const next = avgOther(key(B[i]), i) || B[i];
      const m = meta[i];
      const h0 = ((Math.imul(i, 1664525) + 1013904223) >>> 0) / 4294967296;
      const h1 = ((Math.imul(i, 22695477) + 1) >>> 0) / 4294967296;
      for (let v = 0; v < 4; v++) {
        const vi = i * 4 + v, av = vi * 3, sv = vi * 4, cv = vi * 2;
        aA[av] = A[i][0]; aA[av + 1] = A[i][1]; aA[av + 2] = A[i][2];
        aB[av] = B[i][0]; aB[av + 1] = B[i][1]; aB[av + 2] = B[i][2];
        aPrev[av] = prev[0]; aPrev[av + 1] = prev[1]; aPrev[av + 2] = prev[2];
        aNext[av] = next[0]; aNext[av + 1] = next[1]; aNext[av + 2] = next[2];
        aS[sv] = m.gen; aS[sv + 1] = m.dist; aS[sv + 2] = m.order; aS[sv + 3] = m.width;
        aC[cv] = v >= 2 ? 1 : 0; aC[cv + 1] = v % 2 === 0 ? -1 : 1;
        aSeed[cv] = h0; aSeed[cv + 1] = h1;
      }
      const io = i * 6, iv = i * 4;
      ind[io] = iv; ind[io + 1] = iv + 1; ind[io + 2] = iv + 2;
      ind[io + 3] = iv + 2; ind[io + 4] = iv + 1; ind[io + 5] = iv + 3;
    }

    // Width-weighted centroids give the point lights a more representative position on the
    // actual channel than the old unweighted average over every tiny branch segment.
    let cx = 0, cy = 0, cz = 0, sumW = 0, lowY = 1e9;
    const hi = [0, 0, 0, 0], lo = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const mx = (A[i][0] + B[i][0]) / 2, my = (A[i][1] + B[i][1]) / 2, mz = (A[i][2] + B[i][2]) / 2;
      const w = Math.max(0.12, meta[i].width);
      cx += mx * w; cy += my * w; cz += mz * w; sumW += w; lowY = Math.min(lowY, my);
    }
    cx /= sumW; cy /= sumW; cz /= sumW;
    for (let i = 0; i < n; i++) {
      const mx = (A[i][0] + B[i][0]) / 2, my = (A[i][1] + B[i][1]) / 2, mz = (A[i][2] + B[i][2]) / 2;
      const w = Math.max(0.12, meta[i].width), acc = my > cy ? hi : lo;
      acc[0] += mx * w; acc[1] += my * w; acc[2] += mz * w; acc[3] += w;
    }
    const off = new THREE.Vector3(Math.round((cam.x - cx) / L) * L, 0, Math.round((cam.z - cz) / L) * L);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(aA, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(aA, 3)); geo.setAttribute('aB', new THREE.BufferAttribute(aB, 3));
    geo.setAttribute('aPrev', new THREE.BufferAttribute(aPrev, 3)); geo.setAttribute('aNext', new THREE.BufferAttribute(aNext, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(aS, 4)); geo.setAttribute('aCorner', new THREE.BufferAttribute(aC, 2));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 2));
    geo.setIndex(new THREE.BufferAttribute(ind, 1));
    const st = new Array(8).fill(0), sa = new Array(8).fill(0);
    ev.strokes.slice(0, 8).forEach((k, i) => { st[i] = k.t; sa[i] = k.amp; });
    const leaderStep = ev.leaderEnd / Math.max(1, maxGen);
    const mat = new THREE.ShaderMaterial({
      vertexShader: S.boltVert, fragmentShader: S.boltFrag, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: {
        uOff: { value: off }, uT: { value: 0 }, uStep: { value: leaderStep }, uRS: { value: 1 / 1.5e6 }, uN: { value: Math.min(8, ev.strokes.length) },
        uStrokeT: { value: st }, uStrokeA: { value: sa }, uCCEnd: { value: ev.ccEnd }, uCCAmp: { value: ev.ccAmp }, uLeaderEnd: { value: ev.leaderEnd },
      },
    });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 5;
    this.scene.add(mesh);
    const cloudPos = new THREE.Vector3(hi[3] ? hi[0] / hi[3] : cx, hi[3] ? hi[1] / hi[3] : cy, hi[3] ? hi[2] / hi[3] : cz).add(off);
    const groundPos = ev.strike ? new THREE.Vector3(ev.strike[0], ev.strike[1] + 30, ev.strike[2]).add(off)
      : new THREE.Vector3(lo[3] ? lo[0] / lo[3] : cx, lo[3] ? lo[1] / lo[3] : lowY, lo[3] ? lo[2] / lo[3] : cz).add(off);
    const last = ev.strokes.length ? ev.strokes[ev.strokes.length - 1].t : 0;
    const centre = new THREE.Vector3(cx, cy, cz).add(off);
    const fv: FlashVis = { ev, t0: performance.now(), mesh, mat, off, cloudPos, groundPos, end: Math.max(ev.ccEnd, last) + 1.6, dist: centre.distanceTo(cam) };
    // Only three channels are exposed to uFlash[6]; more simultaneous bolt meshes just add
    // overdraw and per-frame luminance work during a lightning burst.
    while (this.flashes.length >= 3) this.removeFlash(this.flashes[0]);
    this.flashes.push(fv);
    return fv;
  }
  private removeFlash(f: FlashVis) {
    this.scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mat.dispose();
    this.flashes = this.flashes.filter((x) => x !== f);
  }

  static flashLum(ev: FlashEvent, t: number): number {
    let l = 0;
    for (const s of ev.strokes) if (t > s.t) { const a = t - s.t; l += s.amp * (Math.exp(-a / 0.012) + 0.25 * Math.exp(-a / 0.07)); }
    if (t < ev.leaderEnd) l += 0.12 * (t / ev.leaderEnd);
    if (ev.strokes.length && t > ev.strokes[0].t && t < ev.ccEnd) l += ev.ccAmp;
    if (t > ev.leaderEnd) l += 0.03 * Math.exp(-(t - ev.leaderEnd) / 0.42);
    return l;
  }

  private beginTimer(i: number) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!this.timerExt) return;
    const q = gl.createQuery();
    gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this.timerQ[i].push(q);
  }
  private endTimer() {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!this.timerExt) return;
    gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
  }
  private pollTimer(i: number, key: 'scene' | 'cloud' | 'comp') {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!this.timerExt) return;
    const arr = this.timerQ[i];
    for (let k = arr.length - 1; k >= 0; k--) {
      const q = arr[k];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        if (!gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) this.profile[key] = this.profile[key] * 0.8 + (ns / 1e6) * 0.2;
        gl.deleteQuery(q);
        arr.splice(k, 1);
      }
    }
  }

  render(dtReal: number, cam: { x: number; y: number; z: number; yaw: number; pitch: number; fov: number }) {
    // dtReal is the *real* frame time; the simulation clock is capped so a stall does not
    // teleport the animation, but fps/adaptive logic must see the true stall.
    const rawDt = Math.max(1e-3, dtReal);
    const dt = Math.min(0.1, dtReal);
    this.time += dt;
    const U = this.U;
    // Storm-load and stall controls are shared uniform objects across all scene materials.
    const cheap = this.cheapMode ? 1 : 0;
    const mixK = Math.min(1, rawDt * 6);
    U.uCheapShadows.value += (cheap - U.uCheapShadows.value) * mixK;
    // Heavy rain must get denser, not thinner: storm load only trims in the emergency cheap path.
    const density = Math.max(0.65, (1 - 0.15 * this.stormLoad + 0.25 * this.heavyRain) * (this.cheapMode ? 0.85 : 1));
    U.uPrecipDensity.value += (density - U.uPrecipDensity.value) * Math.min(1, rawDt * 4);
    this.cloudMat.uniforms.uDetail.value = this.cheapMode ? 0 : 1;
    this.cloudMat.uniforms.uCheapLight.value = cheap;
    this.compMat.uniforms.uCheapUpsample.value = cheap;
    this.denoise = this.cheapMode ? 0.45 : 1;
    U.uDenoise.value += (this.denoise - U.uDenoise.value) * mixK;
    this.compMat.uniforms.uDenoise.value = U.uDenoise.value;
    this.cloudMat.uniforms.uDenoise.value = U.uDenoise.value;
    U.uHeavyRain.value += (this.heavyRain - U.uHeavyRain.value) * Math.min(1, rawDt * 2);
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.rotation.set(cam.pitch, cam.yaw, 0);
    if (Math.abs(this.camera.fov - cam.fov) > 0.01) { this.camera.fov = cam.fov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld(true);
    // ---- solver-driven vortex and intercept vehicle
    const tor = this.tornado;
    const intensity = tor && tor.active ? tor.intensity : 0;
    U.uTornado.value.set(tor ? tor.x : DOMAIN / 2, tor ? tor.z : DOMAIN / 2, tor ? tor.radius : 220, intensity);
    U.uTornadoTop.value = tor && tor.active ? tor.funnelTop : 1200;
    const fu = this.funnelMesh.material as THREE.ShaderMaterial;
    fu.uniforms.uIntensity.value = intensity;
    fu.uniforms.uDebris.value = tor ? tor.debris : 0;
    fu.uniforms.uRadius.value = tor ? tor.radius : 220;
    fu.uniforms.uTop.value = tor && tor.active ? tor.funnelTop : 1200;
    fu.uniforms.uBottom.value = tor && tor.active ? tor.funnelBottom : 0;
    const height = Math.max(100, fu.uniforms.uTop.value - fu.uniforms.uBottom.value);
    this.funnelMesh.position.set(U.uTornado.value.x, fu.uniforms.uBottom.value + height * 0.5, U.uTornado.value.y);
    this.funnelMesh.scale.set(fu.uniforms.uRadius.value, height, fu.uniforms.uRadius.value);
    this.funnelMesh.visible = !!tor && tor.active && intensity > 0.04 && tor.distance < 26000;
    (this.debrisPoints.material as THREE.ShaderMaterial).uniforms.uDebris.value = tor && tor.active ? tor.debris : 0;
    this.debrisPoints.visible = this.funnelMesh.visible && tor && tor.debris > 0.08 && tor.distance < 9000;
    this.setVehiclePose(this.vehiclePose);

    // ---- lighting from the sun and the simulated sky state
    const sun = sunState(this.lastSimTime);
    const lt = computeLighting(sun.dir);
    this.sunDirV.set(...sun.dir);
    U.uSunDir.value.set(...sun.dir);
    const tc = 1 / (1 + 0.08 * this.camTau);
    const dim = 0.35 + 0.65 * tc;
    U.uSunCol.value.set(...lt.sunCol);
    U.uSkyAmb.value.set(lt.skyAmb[0], lt.skyAmb[1], lt.skyAmb[2]).multiplyScalar(0.55 + 0.45 * dim);
    U.uHorizon.value.set(...lt.horizon); U.uGroundAmb.value.set(...lt.groundAmb); U.uTwilight.value = lt.twilight;
    U.uTime.value = this.time;
    U.uVis.value = Math.max(2400, (62000 * (1 - 0.38 * this.rh)) / (1 + 0.075 * this.rainAtCam + 0.8 * this.heavyRain));
    // Local rain drives how many near-camera drops survive and how bright the veils are.
    U.uRainIntensity.value = Math.max(0, Math.min(1, this.rainAtCam / 45));
    U.uCamXZ.value.set(cam.x, cam.z);
    // camera engulfed by condensate: lets the surface shaders skip their cloud-shadow stack
    U.uCamCloud.value = this.camCloudAt(cam.x, cam.y, cam.z);
    const sm = this.shaftMesh.material as THREE.ShaderMaterial;
    sm.uniforms.uShaftWind.value.set(this.localWind.x, this.localWind.y);
    sm.uniforms.uSnowLevel.value = this.snowLevel;
    (this.rainMesh.material as THREE.ShaderMaterial).uniforms.uSnowLevel.value = this.snowLevel;
    this.localWind.lerp(this.tmpV.set(this.localWind.x, this.localWind.y, 0), 0);
    const tw = this.treeMesh.material as THREE.ShaderMaterial;
    const ww = Math.min(3.2, Math.hypot(this.localWind.x, this.localWind.y) * 0.3);
    const wl = Math.hypot(this.localWind.x, this.localWind.y) || 1;
    tw.uniforms.uTreeWind.value.set((this.localWind.x / wl) * ww, (this.localWind.y / wl) * ww);
    (this.terrainMesh.material as THREE.ShaderMaterial).uniforms.uSnap.value.set(Math.floor(cam.x / this.terrain.spacing), Math.floor(cam.z / this.terrain.spacing));

    // ---- lightning: bolts, scene illumination, exposure
    const nowMs = performance.now();
    const fl = U.uFlash.value as THREE.Vector4[];
    for (const v of fl) v.set(0, 0, 0, 0);
    let flashSum = 0;
    const act = [...this.flashes];
    act.forEach((f, i) => {
      const t = (nowMs - f.t0) / 1000;
      f.mat.uniforms.uT.value = t;
      const lum = Engine.flashLum(f.ev, t);
      if (i < 3) {
        fl[i * 2].set(f.cloudPos.x, f.cloudPos.y, f.cloudPos.z, 11 * lum);
        fl[i * 2 + 1].set(f.groundPos.x, f.groundPos.y, f.groundPos.z, 15 * lum);
      }
      flashSum += (lum * 7) / (1 + (f.dist * f.dist) / (3500 * 3500));
      if (t > f.end) this.removeFlash(f);
    });
    this.flashLevel = Math.max(flashSum, this.flashLevel * Math.exp(-dt / 0.15));
    U.uFlashOn.value = act.length > 0 ? 1 : 0;
    // Broad, decaying sky/cloud illumination outlives the individual point lights by a few frames.
    U.uFlashGlow.value = Math.min(1.25, this.flashLevel * 0.34);

    // ---- exposure: physically-motivated from sun elevation and overhead cloud optical depth, with flash compression
    const bright = lt.dayness * (0.3 + 0.7 * tc);
    let target = Math.pow(1 / (0.25 + 0.75 * bright), 0.7) * (1 + 7 * Math.pow(1 - lt.dayness, 2));
    this.expoTarget = target;
    this.exposure += (this.expoTarget - this.exposure) * Math.min(1, dt / 2.2);
    const expFinal = this.exposure / (1 + 0.42 * this.flashLevel);
    this.compMat.uniforms.uExposure.value = expFinal;
    this.compMat.uniforms.uTime.value = this.time;

    // ---- cloud noise advection offsets (extrapolated between snapshots)
    const dts = Math.min(0.4, (nowMs / 1000 - this.offT));
    const wo = this.cloudMat.uniforms.uWindOff.value as THREE.Vector2[];
    for (let b = 0; b < 16; b++) wo[b].set(this.offCur[b * 2] + this.offVel[b * 2] * dts, this.offCur[b * 2 + 1] + this.offVel[b * 2 + 1] * dts);

    this.pollTimer(0, 'scene'); this.pollTimer(1, 'cloud'); this.pollTimer(2, 'comp');
    // ---- pass 1: scene
    this.beginTimer(0);
    this.renderer.setRenderTarget(this.rtScene);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.endTimer();

    // ---- pass 2: ray-marched clouds (reduced resolution, temporal reprojection)
    const cm = this.cloudMat.uniforms;
    const ang = Math.hypot(cam.yaw - this.lastAng[0], cam.pitch - this.lastAng[1]) / rawDt;
    this.lastAng = [cam.yaw, cam.pitch];
    let blend = 0.955 * Math.exp(-ang * 1.2);
    if (this.cheapMode) blend = Math.min(0.975, blend * 1.02);   // lean on temporal history
    if (this.flashLevel > 0.05) blend *= 0.35;
    cm.uBlend.value = this.frame < 3 ? 0 : blend;
    cm.uFrame.value = this.frame & 1023;
    cm.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    cm.uCamWorld.value.copy(this.camera.matrixWorld);
    cm.uPrevVP.value.copy(this.prevVP);
    cm.uCamPos.value.copy(this.camera.position);
    cm.uDepth.value = this.rtScene.depthTexture;
    const prev = this.rtCloud[1 - this.cur], curRT = this.rtCloud[this.cur];
    cm.uHist.value = prev.textures[0];
    cm.uHistAux.value = prev.textures[1];
    this.beginTimer(1);
    this.renderer.setRenderTarget(curRT);
    this.renderer.render(this.cloudScene, this.ortho);
    this.endTimer();

    // ---- pass 3: composite + tone mapping
    this.compMat.uniforms.uScene.value = this.rtScene.texture;
    this.compMat.uniforms.uCloudRT.value = curRT.textures[0];
    this.compMat.uniforms.uCloudAux.value = curRT.textures[1];
    this.compMat.uniforms.uCloudRes.value.set(curRT.width, curRT.height);
    U.uCloudRes.value.set(curRT.width, curRT.height);
    this.beginTimer(2);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.ortho);
    this.endTimer();
    this.prevVP.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.cur = 1 - this.cur;
    this.frame++;

    // ---- dynamic resolution for the cloud pass
    this.fps += (1 / rawDt - this.fps) * Math.min(1, rawDt * 0.15);
    const frameDt = rawDt * 1000;
    // Recovery must be reachable on ordinary 60 Hz displays (16.7 ms), not just 120 Hz ones.
    if (frameDt > 28) { this.lowTimer += rawDt; this.highTimer = 0; } else if (frameDt < 19) { this.highTimer += rawDt; this.lowTimer = 0; } else { this.lowTimer = 0; this.highTimer = 0; }
    if (!this.adaptive) { this.lowTimer = 0; this.highTimer = 0; }
    const uMax = this.cloudMat.uniforms.uMaxSteps;
    const stepCap = Math.max(24, Math.round(this.q.steps * (1 - 0.15 * this.stormLoad)));
    if (uMax.value > stepCap) uMax.value = stepCap;
    const stepFloor = Math.max(16, Math.floor(stepCap * 0.65));
    // A cheap path reacts to the first bad frame without reallocating render targets: coarser
    // march, fewer lighting/detail fetches, thinner precipitation, fewer upsample taps.
    if (this.adaptive && frameDt > 55 && nowMs - this.lastSoftSpike > 350) {
      this.lastSoftSpike = nowMs;
      this.cheapMode = true;
      this.dynStep = Math.max(this.dynStep, 2.0);
      uMax.value = Math.min(uMax.value, stepFloor);
      this.lowTimer = 0;
    }
    // A single huge spike also coarsens the cloud buffer, but is rate-limited so a sustained
    // stall cannot turn into a reallocation storm.
    if (this.adaptive && frameDt > 70 && nowMs - this.lastSpike > 1400) {
      this.lastSpike = nowMs;
      this.cheapMode = true;
      this.dynStep = Math.min(3.2, this.dynStep + 0.5);
      uMax.value = Math.max(16, uMax.value - 8);
      if (this.cloudScale > this.q.minCloudScale) {
        this.cloudScale = Math.max(this.q.minCloudScale, this.cloudScale - 0.08);
        this.rebuildCloud();
      }
      this.lowTimer = 0;
    }
    if (this.lowTimer > 1.0) {
      const p = this.profile;
      // GPU timers are opt-in. With no timing data, assume the volumetric pass is the bottleneck
      // instead of shrinking the whole screen first (the old zero-profile fallback did that).
      const cloudBound = p.cloud > 0 ? p.cloud > p.scene * 1.15 : true;
      if (cloudBound) {
        if (uMax.value > stepFloor) uMax.value = Math.max(stepFloor, uMax.value - 4);
        else if (this.dynStep < 3.2) this.dynStep = Math.min(3.2, this.dynStep + 0.4);
        else if (this.cloudScale > this.q.minCloudScale) { this.cloudScale = Math.max(this.q.minCloudScale, this.cloudScale - 0.07); this.rebuildCloud(); }
      } else {
        if (uMax.value > stepFloor) uMax.value = Math.max(stepFloor, uMax.value - 4);
        else if (this.prScale > 0.4) { this.prScale = Math.max(0.4, this.prScale - 0.12); this.resize(this.cssW, this.cssH); }
        else if (this.cloudScale > this.q.minCloudScale) { this.cloudScale = Math.max(this.q.minCloudScale, this.cloudScale - 0.07); this.rebuildCloud(); }
      }
      this.lowTimer = 0;
    }
    if (this.highTimer > 8) {
      if (this.cheapMode) this.cheapMode = false;
      else if (uMax.value < stepCap) uMax.value = Math.min(stepCap, uMax.value + 2);
      else if (this.cloudScale < this.q.cloudScale) { this.cloudScale = Math.min(this.q.cloudScale, this.cloudScale + 0.06); this.rebuildCloud(); }
      else if (this.dynStep > 1) this.dynStep = Math.max(1, this.dynStep - 0.15);
      else if (this.prScale < 1) { this.prScale = Math.min(1, this.prScale + 0.1); this.resize(this.cssW, this.cssH); }
      this.highTimer = 0;
    }
    this.cloudMat.uniforms.uStepScale.value = this.q.stepScale * Math.max(this.dynStep, 1 + 0.28 * this.stormLoad);
  }
  private rebuildCloud() {
    const pr = this.renderer.getPixelRatio();
    const sz = this.renderer.getSize(new THREE.Vector2());
    this.makeCloudRT(Math.floor(sz.x * pr), Math.floor(sz.y * pr));
  }

  dispose() { this.renderer.dispose(); }
}
