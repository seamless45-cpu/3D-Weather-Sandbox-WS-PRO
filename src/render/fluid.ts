import * as THREE from 'three';

/**
 * Real-time 2-D stable-fluids solver (Stam) running entirely on the GPU.
 *
 * The grid covers the periodic 32 km weather box and is *not* a second physics model — it is a
 * dynamic horizontal flow field that the visuals drink from: cloud noise coordinates, rain
 * shafts, near-camera raindrops and the funnel all sample `fluidVel()` so every visual element
 * swirls through the same evolving velocity field instead of sliding along a constant wind.
 *
 * Each step is the classic sequence — semi-Lagrangian advection, vorticity confinement,
 * force injection (ambient wind, tornado swirl, gust fronts out of rain cores, updraft
 * convergence, periodic turbulence), a Jacobi pressure projection and a gradient subtract.
 * Everything wraps periodically so the field matches the domain-periodic cloud texture.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const ADVECT = /* glsl */ `
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uDt; uniform float uDiss; uniform float uDomain;
varying vec2 vUv;
void main(){
  vec2 v = texture(uSrc, vUv).rg;
  // Back-trace in uv space: 1 uv = uDomain metres.
  vec2 back = vUv - uDt * v / uDomain;
  vec2 nv = texture(uSrc, back).rg * uDiss;
  gl_FragColor = vec4(nv, 0.0, 1.0);
}`;

const CURL = /* glsl */ `
precision highp float;
uniform sampler2D uVel; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).y;
  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uVel, vUv + vec2(0.0, uTexel.y)).x;
  gl_FragColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);
}`;

const VORTICITY = /* glsl */ `
precision highp float;
uniform sampler2D uVel; uniform sampler2D uCurl; uniform vec2 uTexel;
uniform float uDt; uniform float uEps;
varying vec2 vUv;
void main(){
  float l = abs(texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x);
  float r = abs(texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x);
  float b = abs(texture(uCurl, vUv - vec2(0.0, uTexel.y)).x);
  float t = abs(texture(uCurl, vUv + vec2(0.0, uTexel.y)).x);
  vec2 grad = 0.5 * vec2(r - l, t - b);
  vec2 n = grad / (length(grad) + 1e-5);
  float w = texture(uCurl, vUv).x;
  // Confinement force N x w restores small eddies the advection step diffuses away.
  vec2 force = uEps * vec2(n.y, -n.x) * w;
  vec2 v = texture(uVel, vUv).rg + force * uDt;
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;

const FORCES = /* glsl */ `
precision highp float;
uniform sampler2D uVel; uniform sampler2D uSurf; uniform sampler2D uCloud;
uniform vec2 uTexel; uniform vec2 uWind; uniform vec4 uToro; uniform vec3 uCloudOff;
uniform float uDt; uniform float uTime; uniform float uDomain;
varying vec2 vUv;
void main(){
  vec2 v = texture(uVel, vUv).rg;
  vec2 xz = vUv * uDomain;
  // 1. weak relaxation toward the simulated surface wind so the far field stays honest
  v = mix(v, uWind, clamp(uDt * 0.05, 0.0, 1.0));

  // 2. resolved vortex swirl + frictional inflow (radius stretched to grid scale)
  vec2 d = xz - uToro.xy;
  d -= uDomain * floor(d / uDomain + 0.5);
  float r = length(d) + 1.0;
  float R = max(700.0, uToro.z * 2.6);
  float core = r < R ? r / R : pow(R / r, 0.85);
  float vt = uToro.w * 48.0 * core;
  vec2 target = vec2(-d.y, d.x) / r * vt - d / r * (0.18 * vt);
  v += (target - v) * clamp(uDt * (0.12 + 0.9 * uToro.w), 0.0, 1.0);

  // 3. gust fronts: push along -grad(rain) so outflow spreads out of the heavy cores
  float rc = texture(uSurf, vUv).g;
  float rl = texture(uSurf, vUv - vec2(uTexel.x, 0.0)).g;
  float rr = texture(uSurf, vUv + vec2(uTexel.x, 0.0)).g;
  float rb = texture(uSurf, vUv - vec2(0.0, uTexel.y)).g;
  float rt = texture(uSurf, vUv + vec2(0.0, uTexel.y)).g;
  v -= 0.5 * vec2(rr - rl, rt - rb) * (uDt * 150.0 * smoothstep(0.05, 0.4, rc));

  // 4. updraft convergence: horizontal flow drawn into the resolved convective cores
  vec4 cl = texture(uCloud, vec3(vUv, uCloudOff.x));
  vec4 clL = texture(uCloud, vec3(vUv - vec2(uTexel.x, 0.0), uCloudOff.x));
  vec4 clR = texture(uCloud, vec3(vUv + vec2(uTexel.x, 0.0), uCloudOff.x));
  vec4 clB = texture(uCloud, vec3(vUv - vec2(0.0, uTexel.y), uCloudOff.x));
  vec4 clT = texture(uCloud, vec3(vUv + vec2(0.0, uTexel.y), uCloudOff.x));
  float wc = cl.r > 0.02 ? (cl.a - 0.5) * 15.0 : 0.0;
  float wl = clL.r > 0.02 ? (clL.a - 0.5) * 15.0 : 0.0;
  float wr = clR.r > 0.02 ? (clR.a - 0.5) * 15.0 : 0.0;
  float wb = clB.r > 0.02 ? (clB.a - 0.5) * 15.0 : 0.0;
  float wtp = clT.r > 0.02 ? (clT.a - 0.5) * 15.0 : 0.0;
  wc = clamp(wc, -8.0, 18.0);
  v += 0.5 * vec2(wr - wl, wtp - wb) * (uDt * 55.0 * step(0.02, cl.r));

  // 5. gentle periodic turbulence keeps the field alive between storm events
  float k = 6.2831853 / uDomain;
  vec2 turb = vec2(
    sin(xz.y * k * 3.0 + uTime * 0.19) * cos(xz.x * k * 2.0 - uTime * 0.12),
    cos(xz.x * k * 3.0 - uTime * 0.16) * sin(xz.y * k * 2.0 + uTime * 0.10));
  turb += 0.55 * vec2(
    sin(xz.y * k * 7.0 - uTime * 0.31) * cos(xz.x * k * 5.0 + uTime * 0.23),
    cos(xz.x * k * 7.0 + uTime * 0.27) * sin(xz.y * k * 5.0 - uTime * 0.21));
  v += turb * uDt * 2.2;

  float sp = length(v);
  if (sp > 80.0) v *= 80.0 / sp;
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;

const DIVERGENCE = /* glsl */ `
precision highp float;
uniform sampler2D uVel; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
  float t = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  gl_FragColor = vec4(0.5 * ((r - l) + (t - b)), 0.0, 0.0, 1.0);
}`;

const CLEAR = /* glsl */ `
precision highp float;
uniform sampler2D uSrc; uniform float uScale;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture(uSrc, vUv).x * uScale, 0.0, 0.0, 1.0); }`;

const JACOBI = /* glsl */ `
precision highp float;
uniform sampler2D uPress; uniform sampler2D uDiv; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float l = texture(uPress, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPress, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPress, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPress, vUv + vec2(0.0, uTexel.y)).x;
  float d = texture(uDiv, vUv).x;
  gl_FragColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT = /* glsl */ `
precision highp float;
uniform sampler2D uVel; uniform sampler2D uPress; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float l = texture(uPress, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPress, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPress, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPress, vUv + vec2(0.0, uTexel.y)).x;
  vec2 v = texture(uVel, vUv).rg - 0.5 * vec2(r - l, t - b);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;

export interface FluidStepOpts {
  /** Surface wind (m/s) the far field relaxes toward. */
  wind: THREE.Vector2;
  /** Vortex (x, z, radius, intensity) in world metres / 0..1. */
  tornado: THREE.Vector4;
  time: number;
  cheap: boolean;
}

function rt(N: number): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(N, N, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
  return t;
}

export class FluidSim {
  readonly N: number;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private vel: THREE.WebGLRenderTarget[];      // ping-pong, `vi` = readable
  private press: THREE.WebGLRenderTarget[];    // ping-pong, `pi` = readable
  private curl: THREE.WebGLRenderTarget;
  private div: THREE.WebGLRenderTarget;
  private vi = 0;
  private pi = 0;
  private texel: THREE.Vector2;
  private mat: Record<string, THREE.ShaderMaterial> = {};

  constructor(renderer: THREE.WebGLRenderer, N: number, domain: number) {
    this.renderer = renderer;
    this.N = N;
    this.texel = new THREE.Vector2(1 / N, 1 / N);
    this.vel = [rt(N), rt(N)];
    this.press = [rt(N), rt(N)];
    this.curl = rt(N);
    this.div = rt(N);
    const mk = (frag: string, extra: Record<string, { value: any }>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: extra, depthTest: false, depthWrite: false });
    const t4 = { value: new THREE.Vector4() };
    const v2 = { value: new THREE.Vector2() };
    this.mat = {
      advect: mk(ADVECT, { uSrc: { value: null }, uTexel: { value: this.texel }, uDt: { value: 1 / 60 }, uDiss: { value: 0.999 }, uDomain: { value: domain } }),
      curl: mk(CURL, { uVel: { value: null }, uTexel: { value: this.texel } }),
      vort: mk(VORTICITY, { uVel: { value: null }, uCurl: { value: null }, uTexel: { value: this.texel }, uDt: { value: 1 / 60 }, uEps: { value: 3.4 } }),
      forces: mk(FORCES, {
        uVel: { value: null }, uSurf: { value: null }, uCloud: { value: null },
        uTexel: { value: this.texel }, uWind: { value: v2.value }, uToro: t4, uCloudOff: { value: new THREE.Vector3(0.09, 0, 0) },
        uDt: { value: 1 / 60 }, uTime: { value: 0 }, uDomain: { value: domain },
      }),
      div: mk(DIVERGENCE, { uVel: { value: null }, uTexel: { value: this.texel } }),
      clear: mk(CLEAR, { uSrc: { value: null }, uScale: { value: 0.85 } }),
      jacobi: mk(JACOBI, { uPress: { value: null }, uDiv: { value: null }, uTexel: { value: this.texel } }),
      grad: mk(GRADIENT, { uVel: { value: null }, uPress: { value: null }, uTexel: { value: this.texel } }),
    };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat.advect);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    // Clear both ping-pong chains once so the first frames start from rest.
    this.pass('clear', { uSrc: { value: this.press[0].texture }, uScale: { value: 0 } }, this.press[1]);
    this.pass('clear', { uSrc: { value: this.vel[0].texture }, uScale: { value: 0 } }, this.vel[1]);
    this.renderer.setRenderTarget(null);
  }

  /** Texture the rest of the renderer should sample this frame (the readable velocity buffer). */
  get texture(): THREE.Texture { return this.vel[this.vi].texture; }

  private pass(name: string, uniforms: Record<string, { value: any }>, dst: THREE.WebGLRenderTarget) {
    const m = this.mat[name];
    for (const k in uniforms) m.uniforms[k] = uniforms[k];
    this.quad.material = m;
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.scene, this.cam);
  }

  step(dt: number, o: FluidStepOpts) {
    dt = Math.min(0.05, Math.max(1e-4, dt));
    const src = this.vel[this.vi];
    const dst = this.vel[1 - this.vi];
    // 1. advect velocity
    this.mat.advect.uniforms.uDt!.value = dt;
    this.pass('advect', { uSrc: { value: src.texture }, uDiss: { value: Math.pow(0.999, dt * 60) } }, dst);
    let cur = dst;
    // 2. vorticity confinement (curl -> force)
    this.pass('curl', { uVel: { value: cur.texture } }, this.curl);
    const tmp = this.vel[this.vi];
    this.pass('vort', { uVel: { value: cur.texture }, uCurl: { value: this.curl.texture }, uDt: { value: dt } }, tmp);
    const afterVort = tmp;
    // 3. force injection
    const fm = this.mat.forces.uniforms;
    fm.uDt!.value = dt; fm.uTime!.value = o.time;
    fm.uWind!.value.copy(o.wind); fm.uToro!.value.copy(o.tornado);
    this.pass('forces', {
      uVel: { value: afterVort.texture },
      uSurf: { value: fm.uSurf!.value },
      uCloud: { value: fm.uCloud!.value },
      uWind: { value: o.wind }, uToro: { value: o.tornado },
      uTime: { value: o.time }, uDt: { value: dt },
      uCloudOff: { value: fm.uCloudOff!.value },
    }, cur);
    // 4. pressure projection
    this.pass('div', { uVel: { value: cur.texture } }, this.div);
    const p0 = this.press[this.pi], p1 = this.press[1 - this.pi];
    this.pass('clear', { uSrc: { value: p0.texture }, uScale: { value: 0.85 } }, p1);
    let pr = p1;
    const iters = o.cheap ? 10 : 22;
    for (let i = 0; i < iters; i++) {
      const out = pr === p1 ? p0 : p1;
      this.pass('jacobi', { uPress: { value: pr.texture }, uDiv: { value: this.div.texture } }, out);
      pr = out;
    }
    this.pi = pr === p0 ? 0 : 1;
    // 5. subtract the pressure gradient -> divergence-free field
    const finalDst = cur === dst ? src : dst;
    this.pass('grad', { uVel: { value: cur.texture }, uPress: { value: pr.texture } }, finalDst);
    this.vi = finalDst === this.vel[0] ? 0 : 1;
    // Leave the default target bound so three.js' next setRenderTarget behaves normally.
    this.renderer.setRenderTarget(null);
  }

  /** Bind the fluid's shared textures into the scene uniforms (surfaces the visuals drink from). */
  bindUniforms(surf: THREE.Texture, cloud: THREE.Texture, windOffLayer: number) {
    const fm = this.mat.forces.uniforms;
    fm.uSurf!.value = surf;
    fm.uCloud!.value = cloud;
    (fm.uCloudOff!.value as THREE.Vector3).set(windOffLayer, 0, 0);
  }

  dispose() {
    for (const t of [...this.vel, ...this.press, this.curl, this.div]) t.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
  }
}
