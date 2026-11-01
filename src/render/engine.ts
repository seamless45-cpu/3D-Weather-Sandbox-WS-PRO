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
}

/** Preset for each performance tier. `low` targets entry-level mobile GPUs (Adreno 6xx, Mali-G5x). */
export function qualityFor(tier: Tier): Quality {
  if (tier === 'low') return { tier, pr: 0.62, cloudScale: 0.28, stepScale: 2.6, minCloudScale: 0.2, M: 256, rain: 2400, treeGrid: 22, msaa: 0, splashes: false, shafts: 12, steps: 24 };
  if (tier === 'mid') return { tier, pr: Math.min(window.devicePixelRatio || 1, 1), cloudScale: 0.5, stepScale: 1.5, minCloudScale: 0.3, M: 256, rain: 6000, treeGrid: 40, msaa: 0, splashes: true, shafts: 32, steps: 72 };
  return { tier: 'high', pr: Math.min(window.devicePixelRatio || 1, 1.25), cloudScale: 0.7, stepScale: 1.0, minCloudScale: 0.4, M: 512, rain: 12000, treeGrid: 72, msaa: 2, splashes: true, shafts: 64, steps: 80 };
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
    const adreno = s.match(/adreno[^0-9]*([0-9]{3})/);
    if (adreno) return parseInt(adreno[1], 10) >= 700 ? 'mid' : 'low';   // 6xx and older: entry level
    if (/mali-4|mali-t|mali-g[0-4]|powervr|videocore|adreno/.test(s)) return 'low';
    if (/mali-g[5-9]|apple gpu|intel/.test(s)) return 'mid';
    if (coarse) return 'low';        // unknown mobile GPU: assume the entry-level path
    if (cores <= 4) return 'mid';
    return 'high';
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

export function detectQuality(): Quality {
  return qualityFor(readTierPref() || detectGpuTier());
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
  lowTimer = 0; highTimer = 0; cloudScale: number; dynStep = 1;
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
      uCamCloud: { value: 0 },
    };
    const U = this.U;
    // Low tier compiles a cut-down variant of every shader (see #ifdef LOWQ in glsl.ts)
    this.defs = q.tier === 'low' ? { LOWQ: 1 } : undefined;
    const mk = (vs: string, fs: string, extra: Record<string, { value: any }> = {}, opts: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...U, ...extra }, ...(this.defs ? { defines: { ...this.defs } } : {}), ...opts });

    // ---- sky
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mk(S.skyVert, S.skyFrag, {}, { depthTest: false, depthWrite: false }));
    sky.frustumCulled = false; sky.renderOrder = -10; this.scene.add(sky);

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
        uFrame: { value: 0 }, uBlend: { value: 0 }, uStepScale: { value: q.stepScale }, uMaxSteps: { value: q.steps }, uWindOff: { value: Array.from({ length: 16 }, () => new THREE.Vector2()) },
      },
    });
    const cq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudMat); cq.frustumCulled = false; this.cloudScene.add(cq);
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: S.fsVert, fragmentShader: S.compFrag, depthTest: false, depthWrite: false,
      uniforms: { uScene: { value: null }, uCloudRT: { value: null }, uCloudAux: { value: null }, uExposure: { value: 1 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCloudRes: { value: new THREE.Vector2(1, 1) } },
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

  resize(w: number, h: number) {
    this.cssW = w; this.cssH = h;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
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
    const cw = Math.max(2, Math.floor(W * this.cloudScale)), ch = Math.max(2, Math.floor(H * this.cloudScale));
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
        aA.set([s[o], s[o + 1], s[o + 2]], (i * 4 + v) * 3); aB.set([s[o + 3], s[o + 4], s[o + 5]], (i * 4 + v) * 3);
        aS.set([s[o + 6], s[o + 7], s[o + 8], s[o + 9]], (i * 4 + v) * 4);
        aC.set([v >= 2 ? 1 : 0, v % 2 === 0 ? -1 : 1], (i * 4 + v) * 2);
      }
      ind.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
      const mx = (s[o] + s[o + 3]) / 2, my = (s[o + 1] + s[o + 4]) / 2, mz = (s[o + 2] + s[o + 5]) / 2;
      cx += mx; cy += my; cz += mz;
      if (my < lowY) lowY = my;
    }
    cx /= n; cy /= n; cz /= n;
    for (let i = 0; i < n; i++) {
      const o = i * 10; const my = (ev.segs[o + 1] + ev.segs[o + 4]) / 2;
      const m = [(ev.segs[o] + ev.segs[o + 3]) / 2, my, (ev.segs[o + 2] + ev.segs[o + 5]) / 2];
      if (my > cy) { hiSum = hiSum.map((v, k) => v + m[k]); hiN++; } else { loSum = loSum.map((v, k) => v + m[k]); loN++; }
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
    this.flashes.push(fv);
    if (this.flashes.length > 5) this.removeFlash(this.flashes[0]);
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

  render(dtReal: number, cam: { x: number; y: number; z: number; yaw: number; pitch: number; fov: number }) {
    this.time += dtReal;
    const U = this.U;
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
    this.flashLevel = Math.max(flashSum, this.flashLevel * Math.exp(-dtReal / 0.15));
    U.uFlashOn.value = act.length > 0 ? 1 : 0;

    // ---- exposure: physically-motivated from sun elevation and overhead cloud optical depth, with flash compression
    const bright = lt.dayness * (0.3 + 0.7 * tc);
    let target = Math.pow(1 / (0.25 + 0.75 * bright), 0.7) * (1 + 7 * Math.pow(1 - lt.dayness, 2));
    this.expoTarget = target;
    this.exposure += (this.expoTarget - this.exposure) * Math.min(1, dtReal / 2.2);
    const expFinal = this.exposure / (1 + 0.5 * this.flashLevel);
    this.compMat.uniforms.uExposure.value = expFinal;
    this.compMat.uniforms.uTime.value = this.time;

    // ---- cloud noise advection offsets (extrapolated between snapshots)
    const dts = Math.min(0.4, (nowMs / 1000 - this.offT));
    const wo = this.cloudMat.uniforms.uWindOff.value as THREE.Vector2[];
    for (let b = 0; b < 16; b++) wo[b].set(this.offCur[b * 2] + this.offVel[b * 2] * dts, this.offCur[b * 2 + 1] + this.offVel[b * 2 + 1] * dts);

    // ---- pass 1: scene
    this.renderer.setRenderTarget(this.rtScene);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    // ---- pass 2: ray-marched clouds (reduced resolution, temporal reprojection)
    const cm = this.cloudMat.uniforms;
    const ang = Math.hypot(cam.yaw - this.lastAng[0], cam.pitch - this.lastAng[1]) / Math.max(dtReal, 1e-3);
    this.lastAng = [cam.yaw, cam.pitch];
    let blend = 0.86 * Math.exp(-ang * 1.2);
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
    this.renderer.setRenderTarget(curRT);
    this.renderer.render(this.cloudScene, this.ortho);

    // ---- pass 3: composite + tone mapping
    this.compMat.uniforms.uScene.value = this.rtScene.texture;
    this.compMat.uniforms.uCloudRT.value = curRT.textures[0];
    this.compMat.uniforms.uCloudAux.value = curRT.textures[1];
    this.compMat.uniforms.uCloudRes.value.set(curRT.width, curRT.height);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.ortho);
    this.prevVP.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.cur = 1 - this.cur;
    this.frame++;

    // ---- dynamic resolution for the cloud pass
    if (dtReal > 1e-4) this.fps += (1 / dtReal - this.fps) * Math.min(1, dtReal * 0.15);
    const frameDt = dtReal * 1000;
    if (frameDt > 26) { this.lowTimer += dtReal; this.highTimer = 0; } else if (frameDt < 15) { this.highTimer += dtReal; this.lowTimer = 0; } else { this.lowTimer = 0; this.highTimer = 0; }
    if (!this.adaptive) { this.lowTimer = 0; this.highTimer = 0; }
    const uMax = this.cloudMat.uniforms.uMaxSteps;
    // A single huge spike (a cloud swallowing the camera) reacts immediately instead of waiting
    // for a 1.6 s average: bigger steps first, they are far cheaper than pixels.
    if (this.adaptive && frameDt > 55) {
      this.dynStep = Math.min(3.2, this.dynStep + 0.45);
      uMax.value = Math.max(20, uMax.value - 6);
      this.lowTimer = 0;
    }
    if (this.lowTimer > 0.9) {
      if (this.dynStep < 3.2) this.dynStep = Math.min(3.2, this.dynStep + 0.35);
      else if (this.cloudScale > this.q.minCloudScale) { this.cloudScale = Math.max(this.q.minCloudScale, this.cloudScale - 0.06); this.rebuildCloud(); }
      else if (this.renderer.getPixelRatio() > 0.4) { this.renderer.setPixelRatio(Math.max(0.4, this.renderer.getPixelRatio() - 0.12)); this.resize(this.cssW, this.cssH); }
      else uMax.value = Math.max(18, uMax.value - 4);
      this.lowTimer = 0;
    }
    if (this.highTimer > 4) {
      if (uMax.value < this.q.steps) uMax.value = Math.min(this.q.steps, uMax.value + 2);
      else if (this.cloudScale < this.q.cloudScale) { this.cloudScale = Math.min(this.q.cloudScale, this.cloudScale + 0.06); this.rebuildCloud(); }
      else if (this.dynStep > 1) this.dynStep = Math.max(1, this.dynStep - 0.15);
      else if (this.renderer.getPixelRatio() < this.q.pr) { this.renderer.setPixelRatio(Math.min(this.q.pr, this.renderer.getPixelRatio() + 0.1)); this.resize(this.cssW, this.cssH); }
      this.highTimer = 0;
    }
    this.cloudMat.uniforms.uStepScale.value = this.q.stepScale * this.dynStep;
  }
  private rebuildCloud() {
    const pr = this.renderer.getPixelRatio();
    const sz = this.renderer.getSize(new THREE.Vector2());
    this.makeCloudRT(Math.floor(sz.x * pr), Math.floor(sz.y * pr));
  }

  dispose() { this.renderer.dispose(); }
}
