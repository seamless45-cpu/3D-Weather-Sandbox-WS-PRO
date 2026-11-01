import * as THREE from 'three';
import { Terrain } from '../sim/terrain';
import { DOMAIN } from '../sim/consts';
import { sunState } from '../sim/sun';
import { computeLighting } from './skyModel';
import { makeNoiseData } from './noise';
import * as S from './glsl';

export interface Quality { pr: number; cloudScale: number; stepScale: number; M: number; rain: number; treeGrid: number; msaa: number; }
export function detectQuality(): Quality {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse || cores <= 4) return { pr: 1, cloudScale: 0.36, stepScale: 1.4, M: 256, rain: 6000, treeGrid: 48, msaa: 0 };
  return { pr: Math.min(window.devicePixelRatio || 1, 1.5), cloudScale: 0.5, stepScale: 1.0, M: 512, rain: 14000, treeGrid: 72, msaa: 4 };
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
  terrainMesh: THREE.Mesh; waterMesh: THREE.Mesh; treeMesh: THREE.Mesh; rainMesh: THREE.Mesh; splashMesh: THREE.Mesh;
  flashes: FlashVis[] = []; frame = 0; prevVP = new THREE.Matrix4(); lastAng = [0, 0];
  exposure = 1; expoTarget = 1; time = 0; lastSimTime = 9 * 3600;
  nx = 64; nz = 48;
  offPrev = new Float32Array(32); offCur = new Float32Array(32); offVel = new Float32Array(32); offT = 0;
  localWind = new THREE.Vector2(); tmpV = new THREE.Vector3();
  frameMs = 16; lowTimer = 0; highTimer = 0; cloudScale: number;
  flashLevel = 0; sunDirV = new THREE.Vector3(0, 1, 0);
  lightingDayness = 1; camTau = 0; rainAtCam = 0; rh = 0.5;

  constructor(canvas: HTMLCanvasElement, q: Quality, terrain: Terrain, nx: number, nzr: number) {
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
      uWind: { value: this.localWind },
      uHeight: { value: hTex }, uM: { value: terrain.M }, uSpacing: { value: terrain.spacing },
      uClass: { value: cTex }, uSurf: { value: this.surfTex }, uCamXZ: { value: new THREE.Vector2() },
    };
    const U = this.U;
    const mk = (vs: string, fs: string, extra: Record<string, { value: any }> = {}, opts: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...U, ...extra }, ...opts });

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

    // ---- rain + splashes
    this.rainMesh = new THREE.Mesh(this.buildParticles(q.rain), mk(S.rainVert, S.rainFrag, {}, { transparent: true, depthWrite: false }));
    this.rainMesh.frustumCulled = false; this.rainMesh.renderOrder = 3; this.scene.add(this.rainMesh);
    this.splashMesh = new THREE.Mesh(this.buildParticles(Math.floor(q.rain * 0.4)), mk(S.splashVert, S.splashFrag, {}, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.splashMesh.frustumCulled = false; this.splashMesh.renderOrder = 3; this.scene.add(this.splashMesh);

    // ---- cloud + composite passes
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: S.fsVert, fragmentShader: S.cloudFrag, depthTest: false, depthWrite: false,
      uniforms: {
        ...U, uNoise: { value: this.noiseTex }, uDepth: { value: null }, uHist: { value: null }, uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uFrame: { value: 0 }, uBlend: { value: 0 }, uStepScale: { value: q.stepScale }, uWindOff: { value: Array.from({ length: 16 }, () => new THREE.Vector2()) },
      },
    });
    const cq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudMat); cq.frustumCulled = false; this.cloudScene.add(cq);
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: S.fsVert, fragmentShader: S.compFrag, depthTest: false, depthWrite: false,
      uniforms: { uScene: { value: null }, uCloudRT: { value: null }, uExposure: { value: 1 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
    });
    const cp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat); cp.frustumCulled = false; this.compScene.add(cp);
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
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
    this.rtCloud = [0, 1].map(() => new THREE.WebGLRenderTarget(cw, ch, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }));
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
    this.localWind.set(s.local.u, s.local.v);
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
    const t0 = performance.now();
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
    U.uVis.value = Math.max(2500, (34000 * (1 - 0.45 * this.rh)) / (1 + 0.06 * this.rainAtCam));
    U.uCamXZ.value.set(cam.x, cam.z);
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
    cm.uHist.value = prev.texture;
    this.renderer.setRenderTarget(curRT);
    this.renderer.render(this.cloudScene, this.ortho);

    // ---- pass 3: composite + tone mapping
    this.compMat.uniforms.uScene.value = this.rtScene.texture;
    this.compMat.uniforms.uCloudRT.value = curRT.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.ortho);
    this.prevVP.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.cur = 1 - this.cur;
    this.frame++;

    // ---- dynamic resolution for the cloud pass
    this.frameMs = this.frameMs * 0.95 + (performance.now() - t0 + dtReal * 0) * 0.05;
    const frameDt = dtReal * 1000;
    if (frameDt > 26) { this.lowTimer += dtReal; this.highTimer = 0; } else if (frameDt < 15) { this.highTimer += dtReal; this.lowTimer = 0; } else { this.lowTimer = 0; this.highTimer = 0; }
    if (this.lowTimer > 2.5 && this.cloudScale > 0.26) { this.cloudScale = Math.max(0.26, this.cloudScale - 0.08); this.lowTimer = 0; this.rebuildCloud(); }
    if (this.highTimer > 8 && this.cloudScale < this.q.cloudScale) { this.cloudScale = Math.min(this.q.cloudScale, this.cloudScale + 0.06); this.highTimer = 0; this.rebuildCloud(); }
  }
  private rebuildCloud() {
    const pr = this.renderer.getPixelRatio();
    const sz = this.renderer.getSize(new THREE.Vector2());
    this.makeCloudRT(Math.floor(sz.x * pr), Math.floor(sz.y * pr));
  }

  dispose() { this.renderer.dispose(); }
}
