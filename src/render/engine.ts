import * as THREE from 'three';
import { Terrain } from '../sim/terrain';
import { DOMAIN } from '../sim/consts';
import { sunState } from '../sim/sun';
import { computeLighting } from './skyModel';
import { makeNoiseData } from './noise';
import * as S from './glsl';

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
  if (tier === 'low') return { tier, pr: 0.8, cloudScale: 0.5, stepScale: 2.6, minCloudScale: 0.36, M: 256, rain: 1000, treeGrid: 16, msaa: 0, splashes: false, shafts: 8, steps: 20, maxPixels: 1.2e6, maxCloudPixels: 0.6e6 };
  if (tier === 'mid') return { tier, pr: Math.min(window.devicePixelRatio || 1, 1), cloudScale: 0.6, stepScale: 1.5, minCloudScale: 0.42, M: 256, rain: 2500, treeGrid: 28, msaa: 0, splashes: true, shafts: 18, steps: 48, maxPixels: 2.2e6, maxCloudPixels: 0.9e6 };
  return { tier: 'high', pr: Math.min(window.devicePixelRatio || 1, 1.25), cloudScale: 0.8, stepScale: 1.0, minCloudScale: 0.52, M: 256, rain: 6000, treeGrid: 56, msaa: 2, splashes: true, shafts: 24, steps: 64, maxPixels: 3.6e6, maxCloudPixels: 1.6e6 };
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
    q.cloudScale = Math.min(q.cloudScale, 0.55);
    q.minCloudScale = Math.min(q.minCloudScale, 0.40);
    q.stepScale = Math.max(q.stepScale, 1.35);
    q.steps = Math.min(q.steps, 36);
    q.maxPixels = Math.min(q.maxPixels, 1.8e6);
    q.maxCloudPixels = Math.min(q.maxCloudPixels, 0.7e6);
    q.rain = Math.min(q.rain, 2500);
    q.treeGrid = Math.min(q.treeGrid, 32);
    q.shafts = Math.min(q.shafts, 16);
    q.splashes = false; q.msaa = 0;
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
      uFlash: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) }, uFlashCol: { value: new V3(0.75, 0.85, 1.0) },
      uFlashOn: { value: 0 },
      uWind: { value: this.localWind },
      uHeight: { value: hTex }, uM: { value: terrain.M }, uSpacing: { value: terrain.spacing },
      uClass: { value: cTex }, uSurf: { value: this.surfTex }, uCamXZ: { value: new THREE.Vector2() },
      uCamCloud: { value: 0 }, uPrecipDensity: { value: 1 }, uCheapShadows: { value: 0 },
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
      uShaftWind: { value: new THREE.Vector2() }, uSnowLevel: { value: 3500 },
    }, { transparent: true, depthWrite: false }));
    this.shaftMesh.frustumCulled = false; this.shaftMesh.renderOrder = 2; this.scene.add(this.shaftMesh);

    // ---- rain + splashes
    this.rainMesh = new THREE.Mesh(this.buildParticles(q.rain), mk(S.rainVert, S.rainFrag, { uSnowLevel: { value: 3500 } }, { transparent: true, depthWrite: false }));
    this.rainMesh.frustumCulled = false; this.rainMesh.renderOrder = 3; this.scene.add(this.rainMesh);
    this.splashMesh = new THREE.Mesh(this.buildParticles(Math.max(1, Math.floor(q.rain * 0.42))), mk(S.splashVert, S.splashFrag, {}, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    if (!q.splashes) this.splashMesh.visible = false;
    this.splashMesh.frustumCulled = false; this.splashMesh.renderOrder = 3; this.scene.add(this.splashMesh);

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
      uniforms: { uScene: { value: null }, uCloudRT: { value: null }, uCloudAux: { value: null }, uExposure: { value: 1 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCloudRes: { value: new THREE.Vector2(1, 1) }, uCheapUpsample: { value: 0 } },
    });
    const cp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat); cp.frustumCulled = false; this.compScene.add(cp);
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  /** Grid of cylindrical billboards, one per precipitation column, driven by the surface rain texture. */
  private buildShafts(n: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const quads = n * n;
    const col = new Float32Array(quads * 4 * 4);
    const corner = new Float32Array(quads * 4 * 2);
    const pos = new Float32Array(quads * 4 * 3);
    const idx = new Uint32Array(quads * 6);
    const cell = DOMAIN / n;
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * cell, z = (j + 0.5) * cell;
      const seed = ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 997) / 997;
      for (let v = 0; v < 4; v++) {
        const vi = q * 4 + v;
        corner[vi * 2] = v === 1 || v === 3 ? 1 : 0;
        corner[vi * 2 + 1] = v >= 2 ? 1 : 0;
        col[vi * 4] = x; col[vi * 4 + 1] = z; col[vi * 4 + 2] = seed; col[vi * 4 + 3] = 0;
      }
      idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
      q++;
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

  private buildParticles(n: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) seeds[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
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
    // Pre-empt the multicell transition: cloud coverage, core count and rain all predict the
    // coming dense-march/precipitation cost, so quality starts easing before frames are lost.
    const cf = typeof s.stats?.cloudFrac === 'number' ? s.stats.cloudFrac : 0;
    const cores = typeof s.mode?.cores === 'number' ? s.mode.cores : 0;
    const rain = typeof s.stats?.maxRain === 'number' ? s.stats.maxRain : 0;
    const load = Math.min(1, 0.45 * Math.min(1, cf / 0.5) + 0.4 * Math.min(1, cores / 8) + 0.15 * Math.min(1, rain / 80));
    this.stormLoad += (load - this.stormLoad) * 0.45;
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

  addFlash(ev: FlashEvent, cam: THREE.Vector3) {
    const n = ev.segs.length / 10;
    if (n < 1) return;
    const aA = new Float32Array(n * 12), aB = new Float32Array(n * 12), aS = new Float32Array(n * 16), aC = new Float32Array(n * 8), ind = new Uint32Array(n * 6);
    let cx = 0, cy = 0, cz = 0, lowY = 1e9, hiSum = [0, 0, 0], hiN = 0, loSum = [0, 0, 0], loN = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 10;
      const s = ev.segs;
      for (let v = 0; v < 4; v++) {
        const av = (i * 4 + v) * 3, sv = (i * 4 + v) * 4, cv = (i * 4 + v) * 2;
        aA[av] = s[o]; aA[av + 1] = s[o + 1]; aA[av + 2] = s[o + 2];
        aB[av] = s[o + 3]; aB[av + 1] = s[o + 4]; aB[av + 2] = s[o + 5];
        aS[sv] = s[o + 6]; aS[sv + 1] = s[o + 7]; aS[sv + 2] = s[o + 8]; aS[sv + 3] = s[o + 9];
        aC[cv] = v >= 2 ? 1 : 0; aC[cv + 1] = v % 2 === 0 ? -1 : 1;
      }
      const io = i * 6, iv = i * 4;
      ind[io] = iv; ind[io + 1] = iv + 1; ind[io + 2] = iv + 2;
      ind[io + 3] = iv + 2; ind[io + 4] = iv + 1; ind[io + 5] = iv + 3;
      const mx = (s[o] + s[o + 3]) / 2, my = (s[o + 1] + s[o + 4]) / 2, mz = (s[o + 2] + s[o + 5]) / 2;
      cx += mx; cy += my; cz += mz;
      if (my < lowY) lowY = my;
    }
    cx /= n; cy /= n; cz /= n;
    for (let i = 0; i < n; i++) {
      const o = i * 10; const my = (ev.segs[o + 1] + ev.segs[o + 4]) / 2;
      const mx = (ev.segs[o] + ev.segs[o + 3]) / 2, mz = (ev.segs[o + 2] + ev.segs[o + 5]) / 2;
      if (my > cy) { hiSum[0] += mx; hiSum[1] += my; hiSum[2] += mz; hiN++; }
      else { loSum[0] += mx; loSum[1] += my; loSum[2] += mz; loN++; }
    }
    const off = new THREE.Vector3(Math.round((cam.x - cx) / L) * L, 0, Math.round((cam.z - cz) / L) * L);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(aA, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(aA, 3)); geo.setAttribute('aB', new THREE.BufferAttribute(aB, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(aS, 4)); geo.setAttribute('aCorner', new THREE.BufferAttribute(aC, 2));
    geo.setIndex(new THREE.BufferAttribute(ind, 1));
    const st = new Array(8).fill(0), sa = new Array(8).fill(0);
    ev.strokes.slice(0, 8).forEach((k, i) => { st[i] = k.t; sa[i] = k.amp; });
    const mat = new THREE.ShaderMaterial({
      vertexShader: S.boltVert.replace('vec3 p = mix(aA, aB, aCorner.x);', 'vec3 p = mix(aA, aB, aCorner.x) + uOff;').replace('uniform float uT;', 'uniform vec3 uOff; uniform float uT;'),
      fragmentShader: S.boltFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uOff: { value: off }, uT: { value: 0 }, uStep: { value: 0.0016 }, uRS: { value: 1 / 2.0e6 }, uN: { value: Math.min(8, ev.strokes.length) },
        uStrokeT: { value: st }, uStrokeA: { value: sa }, uCCEnd: { value: ev.ccEnd }, uCCAmp: { value: ev.ccAmp }, uLeaderEnd: { value: ev.leaderEnd },
      },
    });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 5;
    this.scene.add(mesh);
    const cloudPos = new THREE.Vector3(hiN ? hiSum[0] / hiN : cx, hiN ? hiSum[1] / hiN : cy, hiN ? hiSum[2] / hiN : cz).add(off);
    const groundPos = ev.strike ? new THREE.Vector3(ev.strike[0], ev.strike[1] + 30, ev.strike[2]).add(off)
      : new THREE.Vector3(loN ? loSum[0] / loN : cx, loN ? loSum[1] / loN : lowY, loN ? loSum[2] / loN : cz).add(off);
    const last = ev.strokes.length ? ev.strokes[ev.strokes.length - 1].t : 0;
    const centre = new THREE.Vector3(cx, cy, cz).add(off);
    const fv: FlashVis = { ev, t0: performance.now(), mesh, mat, off, cloudPos, groundPos, end: Math.max(ev.ccEnd, last) + 1.4, dist: centre.distanceTo(cam) };
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
    if (t < ev.leaderEnd) l += 0.18 * (t / ev.leaderEnd);
    if (ev.strokes.length && t > ev.strokes[0].t && t < ev.ccEnd) l += ev.ccAmp;
    if (t > ev.leaderEnd) l += 0.03 * Math.exp(-(t - ev.leaderEnd) / 0.35);
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
    const density = Math.max(0.3, (1 - 0.55 * this.stormLoad) * (this.cheapMode ? 0.65 : 1));
    U.uPrecipDensity.value += (density - U.uPrecipDensity.value) * Math.min(1, rawDt * 4);
    this.cloudMat.uniforms.uDetail.value = this.cheapMode ? 0 : 1;
    this.cloudMat.uniforms.uCheapLight.value = cheap;
    this.compMat.uniforms.uCheapUpsample.value = cheap;
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.rotation.set(cam.pitch, cam.yaw, 0);
    if (Math.abs(this.camera.fov - cam.fov) > 0.01) { this.camera.fov = cam.fov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld(true);

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
    U.uVis.value = Math.max(3000, (62000 * (1 - 0.38 * this.rh)) / (1 + 0.05 * this.rainAtCam));
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
        fl[i * 2].set(f.cloudPos.x, f.cloudPos.y, f.cloudPos.z, 14 * lum);
        fl[i * 2 + 1].set(f.groundPos.x, f.groundPos.y, f.groundPos.z, 18 * lum);
      }
      flashSum += (lum * 8) / (1 + (f.dist * f.dist) / (3500 * 3500));
      if (t > f.end) this.removeFlash(f);
    });
    this.flashLevel = Math.max(flashSum, this.flashLevel * Math.exp(-dt / 0.15));
    U.uFlashOn.value = act.length > 0 ? 1 : 0;

    // ---- exposure: physically-motivated from sun elevation and overhead cloud optical depth, with flash compression
    const bright = lt.dayness * (0.3 + 0.7 * tc);
    let target = Math.pow(1 / (0.25 + 0.75 * bright), 0.7) * (1 + 7 * Math.pow(1 - lt.dayness, 2));
    this.expoTarget = target;
    this.exposure += (this.expoTarget - this.exposure) * Math.min(1, dt / 2.2);
    const expFinal = this.exposure / (1 + 0.5 * this.flashLevel);
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
    let blend = 0.93 * Math.exp(-ang * 1.2);
    if (this.cheapMode) blend = Math.min(0.96, blend * 1.03);   // lean on temporal history
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
    const stepCap = Math.max(16, Math.round(this.q.steps * (1 - 0.3 * this.stormLoad)));
    if (uMax.value > stepCap) uMax.value = stepCap;
    const stepFloor = Math.max(16, Math.floor(stepCap * 0.65));
    // A cheap path reacts to the first bad frame without reallocating render targets: coarser
    // march, fewer lighting/detail fetches, thinner precipitation, fewer upsample taps.
    if (this.adaptive && frameDt > 40 && nowMs - this.lastSoftSpike > 250) {
      this.lastSoftSpike = nowMs;
      this.cheapMode = true;
      this.dynStep = Math.max(this.dynStep, 2.0);
      uMax.value = Math.min(uMax.value, stepFloor);
      this.lowTimer = 0;
    }
    // A single huge spike also coarsens the cloud buffer, but is rate-limited so a sustained
    // stall cannot turn into a reallocation storm.
    if (this.adaptive && frameDt > 50 && nowMs - this.lastSpike > 900) {
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
    this.cloudMat.uniforms.uStepScale.value = this.q.stepScale * Math.max(this.dynStep, 1 + 0.7 * this.stormLoad);
  }
  private rebuildCloud() {
    const pr = this.renderer.getPixelRatio();
    const sz = this.renderer.getSize(new THREE.Vector2());
    this.makeCloudRT(Math.floor(sz.x * pr), Math.floor(sz.y * pr));
  }

  dispose() { this.renderer.dispose(); }
}
