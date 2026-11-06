// All GLSL (ES 3.00 via three.js ShaderMaterial). Written without implicit int->float conversions.
export const COMMON = /* glsl */ `
#define PI 3.14159265
uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyAmb; uniform vec3 uHorizon; uniform vec3 uGroundAmb;
uniform float uTwilight; uniform float uDomain; uniform float uVis; uniform float uSkyScale;
uniform float uCamCloud;   // 0 = clear air at the camera, 1 = camera inside condensate
// Storm-load controls: thin precipitation instances and simplify shadow/visibility taps.
uniform float uPrecipDensity; uniform float uCheapShadows; uniform float uRainIntensity;
uniform float uFlashGlow;
// Sub-grid vortex (x, z, radius, intensity), heavy-rain envelope and denoise controls.
// x/z use the same periodic world coordinates as sampleCloud().
uniform vec4 uTornado; uniform float uTornadoTop; uniform float uHeavyRain;
uniform vec2 uCloudRes; uniform float uDenoise;
uniform sampler3D uCloud;
uniform vec4 uFlash[6]; uniform vec3 uFlashCol; uniform float uFlashOn;
uniform vec2 uWind;
uniform sampler2D uFluid;   // GPU stable-fluids horizontal flow (m/s, domain-periodic)
// Integrated surface-wind drift (metres). Particles advect with this instead of wind*uTime:
// multiplying an ever-growing clock by a wind that changes every 250 ms snapshot teleported
// every drop across the map (jump = Δwind × uTime), which read as constant particle flicker.
uniform vec2 uWindDrift;
// Horizontal flow at a world position from the fluid pass. Clouds, rain shafts, near-camera
// drops and the funnel all lean through this same evolving field, so every visual element
// swirls with the same turbulent motion instead of sliding along a constant wind vector.
vec2 fluidVel(vec2 xz){ return texture(uFluid, xz / uDomain).rg; }
const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float BMIE = 21e-6;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise2(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1.0,0.0)), f.x), mix(hash12(i+vec2(0.0,1.0)), hash12(i+vec2(1.0,1.0)), f.x), f.y);
}
float airMass(float cy){
  cy = max(cy, 0.0);
  // Rational fit of Kasten-Young. This runs per pixel inside applyFog, so the acos/pow
  // version was a significant constant cost on integrated GPUs.
  return (1.0 - 0.06 * (1.0 - cy)) / (cy + 0.035);
}

vec3 skyRad(vec3 dir){
  float cy = max(dir.y, 0.0);
  float am = airMass(cy);
  float cs = dot(dir, uSunDir);
  float phR = 3.0 / (16.0 * PI) * (1.0 + cs*cs);
  float g = 0.76;
  float b = max(1.0 + g*g - 2.0*g*cs, 1e-3);
  float phM = (1.0 - g*g) / (4.0 * PI * b * sqrt(b));
  float sam = uSunDir.y > 0.0 ? airMass(uSunDir.y) : 40.0 + (-uSunDir.y) * 400.0;
  vec3 sT = exp(-(BR * 8000.0 + vec3(BMIE * 1320.0)) * sam);
  vec3 tau = (BR * 8000.0 + vec3(BMIE * 1320.0 * 1.1)) * am;
  vec3 fex = exp(-tau);
  vec3 bt = BR + vec3(BMIE * 1.1);
  vec3 insc = (BR * phR + vec3(BMIE * 1.1 * phM)) / bt * (1.0 - fex);
  vec3 st = mix(sT, sqrt(sT), min(1.0, cy * 2.0));
  vec3 L = uSkyScale * insc * st;
  L += vec3(0.0016, 0.0030, 0.0085);
  float csp = max(cs, 0.0);
  L += uTwilight * vec3(0.55, 0.28, 0.2) * 0.35 * exp(-cy * 5.0) * (0.25 + 0.75 * csp * csp);
  return L;
}

vec4 sampleCloud(vec3 p){ return texture(uCloud, vec3(p.x / uDomain, p.z / uDomain, clamp(p.y / 15000.0, 0.0, 1.0))); }

// transmittance of direct sunlight through the simulated condensate (moving cloud shadows)
float cloudSunTrans(vec3 p){
  if (uSunDir.y < 0.02) return 1.0;
#ifdef LOWQ
  // single tap: the shadow pattern is what reads, not its fine structure
  vec4 q = sampleCloud(p + uSunDir * (2600.0 / max(uSunDir.y, 0.2)));
  return exp(-(q.r * 2.6 + q.g * 1.1));
#else
  if (uCheapShadows > 0.5) {
    vec4 q = sampleCloud(p + uSunDir * (2600.0 / max(uSunDir.y, 0.2)));
    return exp(-(q.r * 2.6 + q.g * 1.1));
  }
  float tau = 0.0;
  for (int i = 0; i < 5; i++){
    float alt = 600.0 + float(i) * 1900.0;
    if (alt <= p.y) continue;
    vec3 q = p + uSunDir * ((alt - p.y) / uSunDir.y);
    vec4 s = sampleCloud(q);
    tau += (s.r * 0.8 + s.g * 0.5) * 1900.0 * 0.016 / max(uSunDir.y, 0.15);
  }
  return exp(-tau);
#endif
}
// sky-dome visibility (ambient dimming beneath thick cloud decks / anvils)
float skyVisibility(vec3 p){
#ifdef LOWQ
  vec4 s = sampleCloud(vec3(p.x, 4500.0, p.z));
  return mix(0.2, 1.0, exp(-(s.r * 1.9 + s.g * 0.9)));
#else
  if (uCheapShadows > 0.5) {
    vec4 s = sampleCloud(vec3(p.x, 4500.0, p.z));
    return mix(0.2, 1.0, exp(-(s.r * 1.9 + s.g * 0.9)));
  }
  float tau = 0.0;
  for (int i = 0; i < 3; i++){
    float alt = 1000.0 + float(i) * 3600.0;
    vec4 s = sampleCloud(vec3(p.x, alt, p.z));
    tau += (s.r * 0.8 + s.g * 0.5) * 3600.0 * 0.0045;
  }
  return mix(0.2, 1.0, exp(-tau * 0.5));
#endif
}
vec3 flashLight(vec3 p, vec3 n){
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++){
    vec4 f = uFlash[i];
    if (f.w <= 0.0) continue;
    vec3 d = f.xyz - p;
    float r2 = dot(d, d);
    vec3 L = d * inversesqrt(r2 + 1.0);
    float att = f.w / (1.0 + r2 / 6.5e5);   // ~800 m scale: localized, blinding up close
    acc += att * (0.35 + 0.65 * max(dot(n, L), 0.0));
  }
  return acc * uFlashCol;
}
vec3 applyFog(vec3 col, vec3 wpos){
  vec3 d = wpos - cameraPosition;
  float dist = length(d);
  vec3 dn = d / max(dist, 1e-3);
  float f = 1.0 - exp(-dist / uVis);
  // Fully haze out before the geometry edges: the terrain lattice ends at +-16 km and the
  // water plane at +-22 km — without this the domain's square bounding edge was visible.
  f = max(f, smoothstep(9500.0, 15500.0, dist));
  f = max(f, uCamCloud * 0.92);   // inside cloud: visibility collapses, which also hides the cheap-shadow switch
#ifdef LOWQ
  // the low tier cannot afford a full scattering integral per surface pixel
  vec3 fogc = (uHorizon * 0.92 + uSkyAmb * 0.30) * (1.0 - 0.25 * max(dn.y, 0.0));
#else
  vec3 fogc = skyRad(normalize(vec3(dn.x, max(dn.y, 0.0) + 0.015, dn.z)));
#endif
  vec3 outc = mix(col, fogc, f);
  // A flash lifts the whole air mass, not just the six local point lights.
  outc += uFlashCol * uFlashGlow * 0.10 * (0.35 + 0.65 * f);
  return outc;
}
`;

export const TERRAIN_FN = /* glsl */ `
uniform sampler2D uHeight; uniform float uM; uniform float uSpacing;
float latH(ivec2 q){ q = ivec2(int(mod(float(q.x), uM)), int(mod(float(q.y), uM))); return texelFetch(uHeight, q, 0).r; }
float groundH(vec2 p){
  vec2 g = p / uSpacing; vec2 f = floor(g); vec2 t = g - f; ivec2 q = ivec2(f);
  float h00 = latH(q), h10 = latH(q + ivec2(1,0)), h01 = latH(q + ivec2(0,1)), h11 = latH(q + ivec2(1,1));
  return t.x >= t.y ? h00 + t.x * (h10 - h00) + t.y * (h11 - h10) : h00 + t.x * (h11 - h01) + t.y * (h01 - h00);
}
`;

export const skyVert = /* glsl */ `
varying vec3 vDir;
void main(){
  gl_Position = vec4(position.xy, 1.0, 1.0);
  mat4 ip = inverse(projectionMatrix);
  vec4 v = ip * vec4(position.xy, 1.0, 1.0);
  mat3 cr = transpose(mat3(viewMatrix));
  vDir = cr * (v.xyz / v.w);
}`;
export const skyFrag = /* glsl */ `
${COMMON}
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 c = skyRad(vec3(d.x, max(d.y, 0.0), d.z));
  // Mild desaturation toward the horizon so the sky reads as air, not milk.
  float lum = dot(c, vec3(0.333));
  c = mix(c, vec3(lum), 0.14 * (1.0 - abs(d.y)));
  float cs = dot(d, uSunDir);
  float sam = uSunDir.y > 0.0 ? airMass(uSunDir.y) : 60.0;
  vec3 sT = exp(-(BR * 8000.0 + vec3(BMIE * 1320.0)) * sam);
  c += sT * 60.0 * smoothstep(0.99988, 0.99996, cs) * step(0.0, uSunDir.y);
  // Lightning scatters through the whole sky dome, strongest near the horizon and the cloud deck.
  c += uFlashCol * uFlashGlow * (0.025 + 0.16 * exp(-max(d.y, 0.0) * 3.0)) * (0.4 + 0.6 * max(cs, 0.0));
  gl_FragColor = vec4(c, 1.0);
}`;

export const terrainVert = /* glsl */ `
${TERRAIN_FN}
attribute vec2 aIdx;
uniform vec2 uSnap;
varying vec3 vWorld; varying vec3 vNormal;
void main(){
  vec2 li = aIdx + uSnap;
  ivec2 q = ivec2(li);
  float h = latH(q);
  float hl = latH(q + ivec2(-1,0)), hr = latH(q + ivec2(1,0)), hd = latH(q + ivec2(0,-1)), hu = latH(q + ivec2(0,1));
  vNormal = normalize(vec3(hl - hr, 2.0 * uSpacing, hd - hu));
  vWorld = vec3(li.x * uSpacing, h, li.y * uSpacing);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;

const heightShadowFn = /* glsl */ `
float heightShadow(vec3 p){
  if (uSunDir.y <= 0.0) return 0.0;
  if (uCheapShadows > 0.5) return 0.8;
  float s = 1.0;
  vec2 dxz = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
  float slope = uSunDir.y / max(length(uSunDir.xz), 1e-3);
#ifdef LOWQ
  for (int i = 1; i <= 4; i++){
#else
  for (int i = 1; i <= 7; i++){
#endif
    float fi = float(i);
    float d = 30.0 + fi * fi * 20.0;
    vec2 q = p.xz + dxz * d;
    float h = latH(ivec2(floor(q / uSpacing + 0.5)));
    float hr = p.y + d * slope;
    s = min(s, clamp(0.5 + (hr - h) / (0.1 * d + 5.0), 0.0, 1.0));
  }
  return s;
}`;

export const terrainFrag = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${heightShadowFn}
uniform sampler2D uClass; uniform sampler2D uSurf;
varying vec3 vWorld; varying vec3 vNormal;
float ripple(vec2 p, float t){
  vec2 ip = floor(p); vec2 fp = fract(p) - 0.5;
  float h = hash12(ip);
  vec2 off = (vec2(hash12(ip + 7.0), hash12(ip + 13.0)) - 0.5) * 0.5;
  float ph = fract(t * 1.1 + h);
  float r = length(fp - off);
  float ring = sin((r - ph * 0.45) * 38.0) * exp(-14.0 * abs(r - ph * 0.45)) * (1.0 - ph);
  return ring;
}
void main(){
  vec3 N = normalize(vNormal);
  vec2 uv = vWorld.xz / uDomain;
  vec4 cl = texture(uClass, uv);
  vec4 sf = texture(uSurf, uv);
  vec3 V = cameraPosition - vWorld;
  float dist = length(V); V /= dist;
  vec2 P = vWorld.xz;
#ifdef LOWQ
  float n1 = vnoise2(P * 0.12), n2 = vnoise2(P * 0.9), n3 = 0.5, n0 = 0.5;
  float fade = 0.0;
#else
  float n1 = vnoise2(P * 0.12), n2 = vnoise2(P * 0.9), n3 = vnoise2(P * 6.0), n0 = vnoise2(P * 0.012);
  float fade = 1.0 - smoothstep(40.0, 350.0, dist);
#endif
  vec3 grass = mix(vec3(0.085, 0.12, 0.032), vec3(0.15, 0.18, 0.05), n1) * (0.82 + 0.35 * n2) * (0.9 + 0.2 * n3 * fade);
  grass = mix(grass, vec3(0.28, 0.25, 0.1), smoothstep(0.55, 0.9, n0) * 0.45);
  vec3 forest = vec3(0.045, 0.075, 0.03) * (0.75 + 0.5 * n2);
  vec3 rock = vec3(0.26, 0.24, 0.21) * (0.7 + 0.6 * n2) * (0.9 + 0.2 * n3 * fade);
  vec3 alb = grass * cl.b + forest * cl.r + rock * cl.g;
  alb = mix(alb, vec3(0.1, 0.085, 0.06), cl.a);
#ifndef LOWQ
  // bump from detail noise
  float bs = 1.6 * fade;
  vec2 gdet = vec2(vnoise2(P * 2.3 + vec2(0.3, 0.0)) - vnoise2(P * 2.3 - vec2(0.3, 0.0)), vnoise2(P * 2.3 + vec2(0.0, 0.3)) - vnoise2(P * 2.3 - vec2(0.0, 0.3)));
  N = normalize(N + vec3(gdet.x, 0.0, gdet.y) * 0.25 * bs);
#endif
  float rain = sf.g, pud = sf.b;
  float wet = clamp(pud * 1.4 + rain * 0.7, 0.0, 1.0);
  float pm = smoothstep(0.3, 0.75, pud * 1.6 + n1 * 0.35 - 0.2) * smoothstep(0.35, 0.9, N.y) * (1.0 - cl.a);
  alb *= 1.0 - 0.45 * wet;
  vec3 Nw = N;
#ifndef LOWQ
  if (uCheapShadows < 0.5 && rain > 0.02 && dist < 60.0){
    float rp = ripple(P * 2.6, uTime) + ripple(P * 3.7 + 11.0, uTime * 1.2);
    vec2 g = vec2(ripple(P * 2.6 + vec2(0.02, 0.0), uTime) - ripple(P * 2.6 - vec2(0.02, 0.0), uTime), ripple(P * 2.6 + vec2(0.0, 0.02), uTime) - ripple(P * 2.6 - vec2(0.0, 0.02), uTime));
    Nw = normalize(mix(N, normalize(N + vec3(g.x, 0.0, g.y) * 1.5), pm * clamp(rain * 3.0, 0.0, 1.0) * (1.0 - dist / 60.0)));
    alb *= 1.0 + rp * 0.05 * pm;
  }
#endif
  float ndl = max(dot(N, uSunDir), 0.0);
  // When the camera is inside the cloud the ground is a fogged-out backdrop, so the
  // 20-tap shadow/visibility stack is pure waste. Uniform branch: no divergence.
  float hs = 0.35, cs = 0.12, sv = 0.18;
  if (uCamCloud < 0.5){
    hs = heightShadow(vWorld);
    cs = cloudSunTrans(vWorld);
    sv = skyVisibility(vWorld);
  }
  vec3 sun = uSunCol * ndl * hs * cs;
  vec3 amb = mix(uGroundAmb, uSkyAmb, 0.5 + 0.5 * N.y) * sv;
  vec3 col = alb * (sun + amb);
  // glossy wet surface / puddles
  vec3 Hh = normalize(V + uSunDir);
  float spec = pow(max(dot(Nw, Hh), 0.0), 140.0) * (0.2 * wet + pm) * hs * cs * 3.0 * step(0.0, uSunDir.y);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);
  vec3 Rr = reflect(-V, Nw);
#ifdef LOWQ
  vec3 refl = (uHorizon * 0.75 + uSkyAmb * 0.5) * mix(0.35, 1.0, cs) * sv;
#else
  vec3 refl = skyRad(vec3(Rr.x, abs(Rr.y), Rr.z)) * mix(0.35, 1.0, cs) * sv;
#endif
  col = mix(col, refl, clamp((pm * 0.85 + wet * 0.15) * fres * 1.6, 0.0, 0.9));
  col += uSunCol * spec;
  if (uFlashOn > 0.5) col += flashLight(vWorld, N) * alb * 0.9 + flashLight(vWorld, Nw) * pm * fres * 0.4;
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

export const waterVert = /* glsl */ `
uniform vec2 uCamXZ;
varying vec3 vWorld;
void main(){
  vWorld = vec3(uCamXZ.x + position.x * 22000.0, 0.0, uCamXZ.y - position.y * 22000.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;
export const waterFrag = /* glsl */ `
${COMMON}
${TERRAIN_FN}
uniform sampler2D uSurf;
varying vec3 vWorld;
vec2 waveGrad(vec2 p, vec2 wd, float t){
  vec2 g = vec2(0.0);
  float a = 1.0; float f = 0.35; float sp = 0.7;
  for (int i = 0; i < 2; i++){
    vec2 q = p * f + wd * t * sp;
    float e = 0.05;
    g += a * vec2(vnoise2(q + vec2(e, 0.0)) - vnoise2(q - vec2(e, 0.0)), vnoise2(q + vec2(0.0, e)) - vnoise2(q - vec2(0.0, e))) / (2.0 * e) * f;
    a *= 0.55; f *= 2.1; sp *= 1.3;
  }
  return g;
}
float ripple(vec2 p, float t){
  vec2 ip = floor(p); vec2 fp = fract(p) - 0.5;
  float h = hash12(ip);
  vec2 off = (vec2(hash12(ip + 7.0), hash12(ip + 13.0)) - 0.5) * 0.5;
  float ph = fract(t * 1.1 + h);
  float r = length(fp - off);
  return sin((r - ph * 0.45) * 38.0) * exp(-14.0 * abs(r - ph * 0.45)) * (1.0 - ph);
}
void main(){
  float bed = groundH(vWorld.xz);
  float depth = -bed;
  if (depth <= 0.0) discard;
  vec3 V = cameraPosition - vWorld;
  float dist = length(V); V /= dist;
  float ws = length(uWind);
  vec2 wd = ws > 0.1 ? uWind / ws : vec2(1.0, 0.0);
  vec4 sf = texture(uSurf, vWorld.xz / uDomain);
  float amp = clamp(0.012 + ws * 0.012 + sf.g * 0.03, 0.01, 0.2) * (1.0 - smoothstep(300.0, 3000.0, dist) * 0.7);
  vec2 g = waveGrad(vWorld.xz, wd, uTime) * amp;
#ifndef LOWQ
  if (uCheapShadows < 0.5 && sf.g > 0.02 && dist < 70.0){
    vec2 P = vWorld.xz * 2.2;
    g += vec2(ripple(P + vec2(0.02, 0.0), uTime) - ripple(P - vec2(0.02, 0.0), uTime), ripple(P + vec2(0.0, 0.02), uTime) - ripple(P - vec2(0.0, 0.02), uTime)) * 1.3 * clamp(sf.g * 3.0, 0.0, 1.0) * (1.0 - dist / 70.0);
  }
#endif
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.002; R = normalize(R);
#ifdef LOWQ
  vec3 sky = uHorizon * 0.9 + uSkyAmb * 0.35;
#else
  vec3 sky = skyRad(R);
#endif
  // cheap cloud reflection: a few altitude slices of the simulated condensate
  float ca = 0.0;
  if (uCamCloud < 0.5){
#ifdef LOWQ
    { vec4 s = sampleCloud(vWorld + R * (4000.0 / max(R.y, 0.2))); ca = s.r * 1.4 + s.g * 0.6; }
#else
    for (int i = 0; i < 5; i++){
      float alt = 1500.0 + float(i) * 2300.0;
      vec3 q = vWorld + R * (alt / R.y);
      vec4 s = sampleCloud(q);
      ca += s.r * 0.35 + s.g * 0.15;
    }
#endif
  }
  ca = 1.0 - exp(-ca * 1.5);
  vec3 cloudCol = (uSunCol * 0.35 + uSkyAmb * 1.5 + vec3(0.02)) * 0.8;
  vec3 refl = mix(sky, cloudCol, ca);
  float cs = 0.12, sv = 0.18;
  if (uCamCloud < 0.5){
    cs = cloudSunTrans(vec3(vWorld.x, 0.0, vWorld.z));
    sv = skyVisibility(vec3(vWorld.x, 0.0, vWorld.z));
  }
  vec3 deep = vec3(0.012, 0.05, 0.065) * (uSunCol * 0.35 * cs + uSkyAmb * 1.4 * sv + vec3(0.01));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 col = mix(deep, refl, fres);
  vec3 Hh = normalize(V + uSunDir);
  col += uSunCol * pow(max(dot(N, Hh), 0.0), 400.0) * 8.0 * cs * step(0.0, uSunDir.y);
  if (uFlashOn > 0.5) col += flashLight(vWorld, N) * deep * 2.0 + flashLight(vWorld, N) * fres * 0.25;
  col = applyFog(col, vWorld);
  float alpha = mix(smoothstep(0.0, 0.5, depth) * 0.85, 1.0, fres);
  gl_FragColor = vec4(col, alpha);
}`;

export const treeVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aColor; attribute vec2 aCell;
uniform sampler2D uClass; uniform float uCS; uniform float uHalf; uniform vec2 uCamXZ; uniform vec2 uTreeWind;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec3 vSun; varying float vSV;
void main(){
  vec2 base = floor(uCamXZ / uCS);
  vec2 cellId = base + aCell - vec2(uHalf);
  vec2 jit = vec2(hash12(cellId), hash12(cellId + 17.3));
  vec2 c = (cellId + 0.15 + 0.7 * jit) * uCS;
  float hh = hash12(cellId + 3.1);
  vec4 cl = texture(uClass, c / uDomain);
  float d = length(c - uCamXZ);
  float keep = step(hash12(cellId + 9.7), cl.r * 0.8) * step(cl.a, 0.5) * (1.0 - smoothstep(uHalf * uCS * 0.8, uHalf * uCS * 0.98, d));
  float gh = texture(uHeight, c / uDomain).r;   // 1 fetch instead of groundH's 4 texelFetch
  float sc = (0.7 + 0.8 * hh) * keep;
  float ang = hash12(cellId + 5.5) * 6.2831;
  float ca = cos(ang), sa = sin(ang);
  vec3 lp = position * sc;
  float hf = clamp(position.y / 14.0, 0.0, 1.0);
  float sway = hf * hf * (0.35 + 0.65 * sin(uTime * 1.7 + hh * 20.0 + c.x * 0.05));
  lp.xz += uTreeWind * sway * 0.6 * sc;
  vec3 rp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
  vec3 wp = vec3(c.x, gh, c.y) + rp;
  vW = wp;
  vCol = aColor * (0.8 + 0.4 * hh);
  vN = normalize(vec3(normal.x * ca - normal.z * sa, normal.y, normal.x * sa + normal.z * ca));
  // Trees are tiny on screen: a 2-tap shadow/visibility estimate is indistinguishable from
  // the 11-tap full version and saves millions of vertex fetches per frame.
  float cs = 0.15, sv = 0.2;
  if (uCamCloud < 0.5){
    if (uCheapShadows > 0.5) {
      cs = 0.45; sv = 0.65;
    } else {
      vec3 tp = vec3(c.x, gh + 8.0, c.y);
      vec4 ts = sampleCloud(tp + uSunDir * (2400.0 / max(uSunDir.y, 0.2)));
      cs = exp(-(ts.r * 2.6 + ts.g * 1.1));
      vec4 vs = sampleCloud(vec3(c.x, 4200.0, c.y));
      sv = mix(0.2, 1.0, exp(-(vs.r * 1.9 + vs.g * 0.9)));
    }
  }
  vSun = uSunCol * cs;
  vSV = sv;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
export const treeFrag = /* glsl */ `
${COMMON}
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec3 vSun; varying float vSV;
void main(){
  vec3 N = normalize(vN);
  float ndl = max(dot(N, uSunDir), 0.0);
  float ao = clamp(0.35 + 0.65 * (vW.y - floor(vW.y)) , 0.0, 1.0);
  vec3 amb = mix(uGroundAmb, uSkyAmb, 0.5 + 0.5 * N.y) * vSV;
  // Slightly desaturate + darken so distant trees read as dark green specks, not white dots.
  vec3 base = mix(vCol, vec3(dot(vCol, vec3(0.333))), 0.22);
  vec3 col = base * (vSun * (0.15 + 0.85 * ndl) * step(0.0, uSunDir.y) + amb * 0.72);
  if (uFlashOn > 0.5) col += flashLight(vW, N) * vCol * 0.9;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
  ao = ao;
}`;

// ---------------------------------------------------------------------------------------------
// Precipitation. Two layers:
//   * drops     - individually sized, backlit raindrops / snow crystals within ~56 m of the camera
//   * curtains  - soft, wind-sheared veils hanging from the cloud base; distant precipitation
// ---------------------------------------------------------------------------------------------
export const rainVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
attribute vec4 aDrop;   // size class, glint, phase, crystal shape
uniform float uSnowLevel;
varying float vAlpha; varying vec2 vQ; varying vec3 vCol; varying float vDist; varying float vFlake;
varying float vClass; varying float vGlint; varying float vPhase; varying float vShape;
void main(){
  if (aSeed.z > uPrecipDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 size = vec3(86.0, 48.0, 86.0);
  vec3 seed = aSeed * size;
  float rnd = fract(aSeed.x * 91.7 + aSeed.y * 37.3 + aSeed.z * 13.1);
  float rnd2 = fract(aSeed.y * 51.3 + aSeed.z * 17.9 + aSeed.x * 7.1);
  float cls = aDrop.x;                 // many small drops, a few large ones
  float glint = aDrop.y, phase = aDrop.z, shape = aDrop.w;
  vec3 rel0 = mod(seed - cameraPosition + size * 0.5, size) - size * 0.5;
  float flake = smoothstep(uSnowLevel - 250.0, uSnowLevel + 500.0, cameraPosition.y + rel0.y);
  // Marshall-Palmer-ish size distribution: small drops drift more, big drops fall faster.
  // Terminal velocity from drop diameter (Gunn–Kinzer fit): small drizzle ~2-4 m/s,
  // large drops ~8-9 m/s — the old linear-in-class law made drizzle fall too fast.
  float dmm = 0.7 + 2.6 * cls;
  float fall = mix(9.65 * (1.0 - exp(-pow(dmm / 1.77, 1.4))) + rnd * 0.5, 0.9 + 0.9 * cls + rnd * 0.4, flake);
  float windResp = mix(1.35, 0.68, clamp(cls / 1.5, 0.0, 1.0));
  vec3 vel = vec3(uWind.x * windResp, -fall, uWind.y * windResp);   // for drop orientation only
  // Advection: horizontal drift comes from the integrated wind (constant per-drop response),
  // vertical is a constant fall speed — so uTime only ever multiplies constants. The old
  // form (wind + wobble) * uTime repositioned every drop by Δwind × uTime on each 250 ms
  // snapshot and grew the wobble without bound: the root cause of particle flicker.
  vec3 adv = vec3(
    uWindDrift.x * windResp + sin(uTime * 1.7 + phase * 6.2831) * 0.6 * (1.0 - cls / 1.6),
    -fall * uTime,
    uWindDrift.y * windResp + cos(uTime * 1.4 + phase * 6.2831) * 0.6 * (1.0 - cls / 1.6));
  vec3 rel = mod(seed + adv - cameraPosition + size * 0.5, size) - size * 0.5;
  // Fade to zero before any axis of the wrap box is reached: otherwise a drop teleports the
  // instant its modulo wraps — a visible blink at full alpha.
  vec3 cell = abs(rel) / (size * 0.5);
  float edge = 1.0 - smoothstep(0.80, 0.99, max(cell.x, max(cell.y, cell.z)));
  float dist = length(rel);
  if (dist > 56.0 || edge < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = cameraPosition + rel;
  // The drops ride the fluid field as well as the mean wind: coherent swirls and eddies
  // instead of a uniform drift. Bounded (no uTime factor), so a changing flow never pops.
  vec2 fv = fluidVel(p.xz);
  p.xz += fv * (0.70 + 0.35 * sin(uTime * 1.1 + phase * 6.2831)) * 1.4;
  vec4 s = sampleCloud(p);
  // Spawn from the clouds: a drop may only exist where a cloud column actually rains on
  // this parcel — check the local precip field AND condensate/precip aloft (two samples up
  // to ~3.4 km overhead) so drops never appear in clear air with no cloud above them.
  vec4 sUp = sampleCloud(vec3(p.x, p.y + 1500.0, p.z));
  vec4 sUp2 = sampleCloud(vec3(p.x, p.y + 3300.0, p.z));
  float column = max(s.g, max(sUp.r + sUp.g, sUp2.r + sUp2.g));
  float local = clamp(0.70 + 0.75 * uRainIntensity + 0.55 * uHeavyRain, 0.70, 1.5);
  float inten = clamp(pow(max(s.g, 1e-5), 0.30) * local, 0.0, 1.0);
  // Soft intensity gate: a hard step popped drops in and out every time the 250 ms cloud
  // snapshot landed, which read as particle flicker. The curve used to starve moderate
  // rain down to ~10-20% visible drops (inten^0.40 with a −0.16 offset); now visible
  // fraction tracks the local rain rate smoothly from trace to heavy.
  float thr = mix(rnd, rnd2, flake);
  float gate = (1.0 - smoothstep(inten - 0.17, inten + 0.03, thr))
    * smoothstep(0.006, 0.03, column);
  if (gate < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (p.y < 1400.0 && p.y < groundH(p.xz) + 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // A drop is a motion-blurred teardrop: rounded bright head, tapering tail. Flakes are short.
  float len = mix(0.35 + 1.25 * cls, 0.16 + 0.12 * cls, flake) * (1.0 + clamp(dist * 0.025, 0.0, 2.0))
    * (0.55 + 0.085 * fall) * (0.82 + 0.35 * uRainIntensity + 0.45 * uHeavyRain);
  float wid = mix(0.0035 + 0.005 * cls, 0.014 + 0.010 * cls, flake) * (1.0 + dist * 0.0007);
  vec3 dirV = normalize(vel);
  vec3 center = p - dirV * len * 0.5;
  vec3 toCam = normalize(cameraPosition - center);
  vec3 side = normalize(cross(dirV, toCam) + vec3(1e-5));
  vec3 wp = center + dirV * (position.y * len) + side * (position.x * wid * 2.0);
  vQ = position.xy * 2.0;
  vDist = dist;
  vDist = dist; vFlake = flake; vClass = cls; vGlint = glint; vPhase = phase; vShape = shape;
  float fwd = pow(max(dot(-toCam, uSunDir), 0.0), 8.0);
  // Cool grey-blue streak body (not near-white): inside a rain core every drop's gate opens,
  // and bright end-on heads read as white dots speckled over the ground.
  vec3 col = uSkyAmb * 0.82 + uSunCol * (0.08 + 0.42 * fwd) + uGroundAmb * 0.30 + vec3(0.012);
  // Each drop catches a different amount of light: brightness jitter from its phase, so the
  // rain reads as individual glints, not a uniform wash.
  col *= 0.72 + 0.30 * fract(phase * 7.31 + cls * 3.7);
  if (uFlashOn > 0.5) col += flashLight(p, vec3(0.0, 0.0, 1.0)) * 0.8 + uFlashCol * uFlashGlow * 0.12;
  vCol = mix(col, col * vec3(1.06, 1.06, 1.12) + vec3(0.045), flake);
  vAlpha = smoothstep(0.25, 1.2, dist) * (1.0 - smoothstep(38.0, 60.0, dist)) * mix(0.68 + 0.24 * cls, 0.46, flake) * (0.90 + 0.55 * uHeavyRain) * gate * edge;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
export const rainFrag = /* glsl */ `
varying float vAlpha; varying vec2 vQ; varying vec3 vCol; varying float vDist; varying float vFlake;
varying float vClass; varying float vGlint; varying float vPhase; varying float vShape;
void main(){
  float along = vQ.y, across = vQ.x;
  float rr = length(vec2(across, along * 0.72));
  float soft = 1.0 - smoothstep(0.35, 1.0, rr);
  // Capsule/teardrop: rounded head at +0.6, thin tail toward -0.8.
  float head = smoothstep(-0.35, 0.78, along);
  float rad = mix(0.11, 0.52, head);
  float capsule = (1.0 - smoothstep(rad * 0.65, rad, abs(across))) * (1.0 - smoothstep(0.78, 1.0, abs(along)));
  float headDist = length(vec2(across, (along - 0.58) * 1.15));
  float headMask = 1.0 - smoothstep(0.30, 0.62, headDist);
  float body = max(capsule * 0.85, headMask * 0.9);
  // Off-centre specular glint: the cue that this is a refracting drop, not a white line.
  float glint = pow(max(0.0, 1.0 - length(vec2((across - 0.16) * 2.4, (along - 0.50) * 1.7))), 12.0) * vGlint;
  vec3 rainCol = vCol * (0.62 + 0.55 * pow(1.0 - min(1.0, abs(across)), 2.0));
  rainCol += vec3(0.85, 0.88, 0.95) * glint * (0.16 + 0.30 * vClass / 1.5);
  // Six-arm crystal for frozen precipitation; rotation varies per flake.
  float ang = atan(along, across) + vShape * 6.2831 + vPhase;
  float arms = pow(abs(cos(ang * 3.0)), 22.0) * (1.0 - smoothstep(0.18, 0.92, rr));
  float core = 1.0 - smoothstep(0.0, 0.42, rr);
  float crystal = max(arms * 0.9, core * 0.42) * (1.0 - smoothstep(0.72, 1.0, rr));
  float shape = mix(body, crystal, vFlake);
  float blur = smoothstep(9.0, 48.0, vDist);
  shape = mix(shape, soft * 0.7, blur * 0.65);
  // Streak break-up: a real fall streak flickers along its length (drop oscillation), so
  // modulate by fine noise along vQ.y.
  shape *= 0.78 + 0.36 * vnoise2(vec2(vQ.y * 21.0, vPhase * 17.0));
  float a = vAlpha * shape;
  if (a < 0.003) discard;
  a *= mix(1.0, 0.45, smoothstep(8.0, 55.0, vDist));
  gl_FragColor = vec4(mix(rainCol, vCol, vFlake), a);
}`;

export const splashVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
attribute vec4 aDrop;
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol; varying float vDist; varying float vShape;
void main(){
  if (aSeed.z > uPrecipDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 size = vec2(70.0);
  vec2 rel = mod(aSeed.xy * size - cameraPosition.xz + size * 0.5, size) - size * 0.5;
  // Fade before the wrap radius (35 m per axis) so a modulo wrap never teleports a visible
  // splash across the box.
  vec2 cell = abs(rel) / 35.0;
  float edge = 1.0 - smoothstep(0.80, 0.99, max(cell.x, cell.y));
  float rdist = length(rel);
  if (rdist > 48.0 || edge < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 xz = cameraPosition.xz + rel;
  float gh = groundH(xz);
  vec4 s = sampleCloud(vec3(xz.x, max(gh, 0.0) + 40.0, xz.y));
  float local = clamp(0.70 + 0.75 * uRainIntensity + 0.55 * uHeavyRain, 0.70, 1.5);
  float inten = clamp(pow(max(s.g, 1e-5), 0.34) * local, 0.0, 1.0);
  float ph = fract(uTime * (1.6 + 0.8 * aDrop.x) + aSeed.z * 13.0 + aDrop.z);
  // Soft gates: the old hard steps popped splashes in/out with every cloud snapshot.
  // Splashes ring both wet ground and open water (water surface sits at y=0).
  float onWater = step(-2.0, gh) * (1.0 - step(0.05, gh));
  float gate = (1.0 - smoothstep(inten * 0.9 - 0.06, inten * 0.9 + 0.10, fract(aSeed.z * 37.7 + aDrop.z)))
    * smoothstep(0.003, 0.013, s.g) * step(-2.0, gh);
  float r = (0.035 + 0.16 * ph) * (0.7 + 0.7 * aDrop.x) * (1.0 + 2.2 * onWater);
  vec3 wp = vec3(xz.x + position.x * 2.0 * r, max(gh, 0.0) + 0.03, xz.y + position.y * 2.0 * r);
  vPh = ph; vP = position.xy * 2.0; vShape = aDrop.w;
  vDist = length(rel);
  vVis = gate * edge * (1.0 - smoothstep(26.0, 48.0, vDist));
  vCol = (uSkyAmb * 0.62 + uSunCol * 0.16 + vec3(0.006)) * 0.9;
  if (uFlashOn > 0.5) vCol += flashLight(wp, vec3(0.0, 1.0, 0.0)) * 0.6 + uFlashCol * uFlashGlow * 0.10;
  gl_Position = gate > 0.05 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
export const splashFrag = /* glsl */ `
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol; varying float vDist; varying float vShape;
void main(){
  float rr = length(vP);
  float ang = atan(vP.y, vP.x) + vShape * 6.2831;
  float spikes = pow(abs(cos(ang * 6.0)), 14.0) * (1.0 - smoothstep(0.42, 0.96, rr));
  float ring = smoothstep(0.48, 0.72, rr) * (1.0 - smoothstep(0.72, 0.98, rr)) * (0.65 + 0.35 * spikes);
  float mist = (1.0 - smoothstep(0.0, 0.95, rr)) * 0.10;
  float droplets = smoothstep(0.82, 0.98, rr) * (0.5 + 0.5 * spikes) * 0.07;
  float a = (ring * 0.22 + mist * 0.8 + droplets * 0.85) * (1.0 - vPh) * (1.0 - vPh) * 0.7 * vVis * (1.0 + 0.6 * uHeavyRain);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}`;

// ---------------------------------------------------------------------------------------------
// Impact droplets: crown-splash micro droplets ejected ballistically off wet ground under
// heavy rain. Each particle loops a short arc (launch → apex → landing) with outward drift,
// gated by the same local rain field as the splashes it accompanies.
// ---------------------------------------------------------------------------------------------
export const dropVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
attribute vec4 aDrop;
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol;
void main(){
  if (aSeed.z > uPrecipDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 size = vec2(70.0);
  vec2 rel = mod(aSeed.xy * size - cameraPosition.xz + size * 0.5, size) - size * 0.5;
  // Fade before the wrap radius so a modulo wrap never teleports a visible droplet.
  vec2 cell = abs(rel) / 35.0;
  float edge = 1.0 - smoothstep(0.80, 0.99, max(cell.x, cell.y));
  if (length(rel) > 46.0 || edge < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 xz = cameraPosition.xz + rel;
  float gh = groundH(xz);
  if (gh < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 s = sampleCloud(vec3(xz.x, max(gh, 0.0) + 40.0, xz.y));
  float local = clamp(0.70 + 0.75 * uRainIntensity + 0.55 * uHeavyRain, 0.70, 1.5);
  float inten = clamp(pow(max(s.g, 1e-5), 0.34) * local, 0.0, 1.0);
  float gate = (1.0 - smoothstep(inten * 0.9 - 0.06, inten * 0.9 + 0.10, fract(aSeed.z * 41.3 + aDrop.z)))
    * smoothstep(0.004, 0.016, s.g) * step(0.0, gh);
  // Ballistic arc: launch at ph=0, apex mid-flight, lands at ph=1.
  float Tl = 0.34 + 0.26 * aDrop.x;
  float ph = fract(uTime / Tl + aSeed.z * 17.0 + aDrop.z);
  float v0 = 1.4 + 2.4 * aDrop.y;
  float tl = ph * Tl;
  float h = max(v0 * tl - 4.9 * tl * tl, 0.0);
  float ang = aDrop.w * 6.2831;
  vec2 drift = vec2(cos(ang), sin(ang)) * (0.3 + 1.1 * aDrop.y) * tl;
  vec3 wp = vec3(xz.x + drift.x, gh + h + 0.02, xz.y + drift.y);
  vPh = ph; vP = position.xy * 2.0;
  vVis = gate * edge * (1.0 - smoothstep(24.0, 46.0, length(rel))) * (1.0 - smoothstep(0.82, 1.0, ph));
  vCol = (uSkyAmb * 0.66 + uSunCol * 0.18 + vec3(0.008)) * 0.9;
  if (uFlashOn > 0.5) vCol += flashLight(wp, vec3(0.0, 1.0, 0.0)) * 0.6 + uFlashCol * uFlashGlow * 0.10;
  gl_Position = vVis > 0.02 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
export const dropFrag = /* glsl */ `
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol;
void main(){
  float rr = length(vP);
  float a = (1.0 - smoothstep(0.30, 0.92, rr)) * vVis;
  // Sun glint near the droplet centre sells the crown sparkle.
  float glint = exp(-rr * rr * 14.0);
  vec3 c = vCol * (0.7 + 0.35 * glint);
  a *= 0.40 + 0.35 * (1.0 - vPh);
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
}`;

// ---------------------------------------------------------------------------------------------
// Rain mist: large, soft, ground-hugging puffs that only exist where precipitation reaches
// the surface. They drift with the integrated wind plus a bounded taste of the fluid field,
// hug the terrain, and fade before the wrap box so nothing ever teleports.
// ---------------------------------------------------------------------------------------------
export const mistVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
attribute vec4 aDrop;   // size, phase, height fraction, tint
varying float vA; varying vec3 vCol; varying vec2 vQ; varying float vDist;
void main(){
  vec2 box = vec2(240.0, 240.0);
  vec2 rel = mod(aSeed.xy * box + uWindDrift * (0.20 + 0.10 * aDrop.x) - cameraPosition.xz + box * 0.5, box) - box * 0.5;
  vec2 xz = cameraPosition.xz + rel;
  float gh = groundH(xz);
  float hf = aDrop.z;
  // Rain mist is BOUNCE SPRAY: droplets shattering off the ground and being lofted, so the
  // sheet hugs the surface (peaks at ground level, dies out well under 200 m) instead of
  // drifting up to 300 m where it read as a low haze layer rather than rain spray.
  float y = gh + 4.0 + hf * hf * 150.0;
  // Only where rain is actually reaching the ground (sampled through the spray layer).
  vec4 s = sampleCloud(vec3(xz.x, gh + 90.0, xz.y));
  float rain = clamp(pow(max(s.g, 0.0), 0.42) * (0.85 + 0.85 * uRainIntensity + 0.95 * uHeavyRain), 0.0, 1.0);
  vec3 p = vec3(xz.x, y, xz.y);
  // Bounded churn: turbulence jostles the spray in every axis (vertical bobbing included),
  // but nothing integrates over uTime, so a changing flow field never pops the sheet.
  p.xz += fluidVel(p.xz) * (0.8 + 0.4 * sin(uTime * 0.4 + aDrop.y * 6.2831)) * 1.1;
  p.y += sin(uTime * 0.55 + aDrop.y * 12.566) * 5.0 * (1.0 - hf);
  float dist = length(p - cameraPosition);
  // Near-ground spray billows are the largest; higher wisps shrink.
  float size = mix(16.0, 54.0, aDrop.x) * (0.85 + 0.55 * (1.0 - hf));
  // Edge fade before the wrap radius, overhead fade, no-rain fade.
  vec2 cell = abs(rel) / (box * 0.5);
  float edge = 1.0 - smoothstep(0.80, 0.99, max(cell.x, cell.y));
  // Standing INSIDE the core: quads centred on the camera would fill the whole screen as
  // one flat veil (the artificial look) — fade them out hard at point-blank range.
  float near0 = smoothstep(7.0, 32.0, dist);
  vA = rain * edge * near0 * (0.55 + 0.55 * aDrop.w) * (1.0 - smoothstep(0.30, 0.85, hf));
  vA *= 1.0 - smoothstep(130.0, 230.0, dist);
  // Under heavy rain the spray sheet becomes a SHEET-RAIN veil: much stronger, so the whole
  // view softens into falling water instead of discrete puffs.
  vA *= 1.0 + 1.1 * uHeavyRain + 0.5 * uRainIntensity;
  vA = min(vA, 0.5);   // cap: no full-screen whiteout inside the core
  if (vA < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5));
  vec3 up = cross(toCam, right);
  // Vertically stretched quads: tall thin streaks read as a rain veil, not round fog puffs.
  vec3 wp = p + right * (position.x * size * 0.42) + up * (position.y * size * 2.9);
  vQ = position.xy * 2.0;
  vec3 col = (uSkyAmb * 1.25 + uSunCol * 0.26 + uGroundAmb * 0.35 + vec3(0.02)) * vec3(0.92, 0.95, 1.0);
  if (uFlashOn > 0.5) col += flashLight(p, vec3(0.0, 1.0, 0.0)) * 0.7 + uFlashCol * uFlashGlow * 0.14;
  vCol = col;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
export const mistFrag = /* glsl */ `
varying float vA; varying vec3 vCol; varying vec2 vQ; varying float vDist;
void main(){
  // Anisotropic falloff matching the stretched quad: tight across, long along the fall.
  float a = exp(-(vQ.x * vQ.x * 3.6 + vQ.y * vQ.y * 0.22)) * vA;
  // Fragment-level near fade: mist puffs are large quads, so vertex-level fading alone left
  // close fragments opaque — speckle grain when standing inside the rain core.
  a *= smoothstep(6.0, 30.0, vDist);
  // Fine vertical striations so the veil reads as countless streaks, not one soft blob.
  a *= 0.82 + 0.26 * vnoise2(vec2(vQ.y * 26.0, vQ.x * 2.0));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}`;

// ---------------------------------------------------------------------------------------------
// Rain curtains. Six bowed, vertically-subdivided planes per column form a cylindrical
// shaft whose silhouette is torn by per-row noise, whose whole body leans and sways through
// the GPU fluid field, and whose interior falls through three scrolling noise layers.
// ---------------------------------------------------------------------------------------------
export const shaftVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec4 aCol;      // x, z, seed, plane index
attribute vec2 aCorner;   // 0..1 across / 0..1 up the quad
uniform sampler2D uSurf;  // .g = companded rain rate (0..1)
uniform vec2 uShaftWind;
uniform float uSnowLevel;
#define SHAFT_PLANES 6.0
varying float vRain; varying float vU; varying float vV; varying float vSeed; varying float vSnow;
varying float vDist; varying vec2 vWorld; varying float vLayer; varying float vHook;
varying vec2 vFlow; varying float vFace; varying float vY;
void main(){
  vec2 xz = aCol.xy;
  float rain = texture(uSurf, xz / uDomain).g;
  float layer = aCol.w;
  float seed = fract(aCol.z + layer * 0.371);
  vRain = 0.0; vU = 0.0; vV = 0.0; vSeed = seed; vSnow = 0.0; vDist = 0.0;
  vWorld = vec2(0.0); vLayer = layer; vHook = 0.0; vFlow = vec2(0.0); vFace = 1.0; vY = 0.0;
  if (rain <= 0.008 || seed > max(1.0, uPrecipDensity)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // Wrap precipitation around the mesocyclone, leaving a dry lower inflow notch.
  vec2 tv = xz - uTornado.xy;
  tv -= uDomain * floor(tv / uDomain + 0.5);
  float tr = length(tv);
  float core = exp(-tr * tr / max(1.0, 18.0 * uTornado.z * uTornado.z));
  float angle = atan(tv.y, tv.x);
  float hook = uTornado.w * core * smoothstep(1.0, 3.2, tr / max(80.0, uTornado.z));
  xz += vec2(-sin(angle), cos(angle)) * hook * 420.0;
  float notch = uTornado.w * smoothstep(0.0, 1.0, tr / max(80.0, uTornado.z)) * (1.0 - smoothstep(1.0, 4.0, tr / max(80.0, uTornado.z)));
  rain *= 1.0 - 0.65 * notch * smoothstep(0.0, 1.0, -tv.y / max(80.0, uTornado.z));
  vHook = hook;
  // Cloud base: walk up the column until the precipitation field appears.
  float top = 3800.0;
  for (int i = 0; i < 6; i++){
    float h = 400.0 + float(i) * 1150.0;
    if (sampleCloud(vec3(xz.x, h, xz.y)).g > 0.03) { top = h + 900.0; break; }
  }
  float gy = groundH(xz);
  float depth = max(top - gy, 300.0);
  float h = aCorner.y;

  // ---- fluid dynamics: the shaft leans with the GPU flow field (more with height, i.e.
  // shear), and each column wobbles on its own phase so neighbours never move in lockstep.
  vec2 fv = fluidVel(xz);
  vFlow = fv;
  vec2 lean = fv * (0.55 + 1.45 * pow(h, 1.15)) * 3.0;
  lean += vec2(sin(uTime * 0.23 + seed * 31.0), cos(uTime * 0.19 + seed * 17.0)) * (24.0 * h);

  float y = mix(gy + 20.0, top, h);
  // Wind shear tilts the fall streaks progressively toward the ground.
  float fall = (top - y) * 0.00042;
  vec2 shear = uShaftWind * fall * 220.0;
  vec3 p = vec3(xz.x + lean.x + shear.x, y, xz.y + lean.y + shear.y);

  // Six planes at fixed azimuths read as a volume from every camera angle; each plane bows
  // outward so the assembly reads as a cylinder rather than six flat cards.
  float az = (layer / SHAFT_PLANES) * 2.0 * PI + seed * 0.35;
  vec3 right = vec3(cos(az), 0.0, sin(az));
  float width = mix(230.0, 1050.0, pow(h, 1.25)) * (0.62 + 0.85 * fract(seed * 13.7)) * (0.62 + 0.75 * clamp(rain * 2.4, 0.0, 1.0)) + depth * 0.075;
  // Ragged silhouette: two octaves of row noise bend the width, so no edge is ever straight.
  float rowN = vnoise2(vec2(seed * 149.0, h * 5.0 + uTime * 0.045)) - 0.5;
  float rowN2 = vnoise2(vec2(seed * 61.0 + 7.3, h * 11.0 - uTime * 0.06)) - 0.5;
  width *= 1.0 + rowN * 0.55 + rowN2 * 0.30;
  float across = aCorner.x - 0.5;
  float bow = (1.0 - 4.0 * across * across) * width * 0.17 * (0.6 + 0.4 * fract(seed * 5.1));
  p += right * (across * width + (fract(seed * 31.0) - 0.5) * 90.0);
  p += vec3(-right.z, 0.0, right.x) * bow;

  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  // Facing of this curtain plane vs the camera: a vertical plane seen exactly edge-on
  // collapses to a 1-px full-height line — the fragment shader fades that case out.
  vFace = abs(dot(vec3(-right.z, 0.0, right.x), normalize(cameraPosition - p)));
  vRain = smoothstep(0.005, 0.42, rain) * (0.92 + 0.42 * uHeavyRain);
  vU = h;
  vV = across * 2.0;
  vWorld = vec2(p.x, p.z);
  vY = p.y;
  vSnow = smoothstep(uSnowLevel - 300.0, uSnowLevel + 800.0, y);
  vDist = length(cameraPosition - p);
}`;
export const shaftFrag = /* glsl */ `
${COMMON}
uniform sampler3D uNoise;
uniform float uLodScale;   // texels-per-metre-per-pixel for the noise volume
varying float vRain; varying float vU; varying float vV; varying float vSeed; varying float vSnow;
varying float vDist; varying vec2 vWorld; varying float vLayer; varying float vHook;
varying vec2 vFlow; varying float vFace; varying float vY;
void main(){
  if (vRain < 0.01) discard;
  // Kill the edge-on artifact: a shaft plane viewed edge-on is a full-height 1-px line.
  if (vFace < 0.985) { float eo = 1.0 - smoothstep(0.90, 0.985, vFace); if (eo <= 0.0) discard; }
  // Soft multi-lobe edge, then torn by noise: the card boundary itself becomes wispy.
  float edge = exp(-1.5 * vV * vV) * (1.0 - smoothstep(0.76, 1.0, abs(vV)));
  if (edge < 0.01) discard;

  // Integer numbers of noise tiles across the 32 km domain: no seams at periodic boundaries.
  float shaftP = uDomain / 12.0;
  // Fall streaks: each layer scrolls downward at its own terminal-fall rate (parallax).
  float fallA = uTime * 0.055;
  float fallB = uTime * 0.14;
  // The fluid field advects the interior structure, so rain inside the shaft circulates.
  // Distance-based mip LOD (the march-free equivalent of nlod in the cloud pass): without it
  // the fine layers alias into crawling grain on distant curtains.
  vec2 nxy = vWorld / shaftP + vFlow * 0.00045;
  float lod = clamp(log2(max(1.0, vDist * uLodScale / shaftP)) + 1.1, 0.0, 5.0);
  vec4 nA = textureLod(uNoise, vec3(nxy * 2.3 + vec2(vSeed * 5.0, vSeed * 3.0), vU * 0.05 - fallA * 1.35), lod);
  vec4 nB = textureLod(uNoise, vec3(nxy * 3.7 + vec2(vSeed * 11.0, vSeed * 7.0), vU * 0.52 - fallB), lod + 1.9);
  vec4 nC = textureLod(uNoise, vec3(nxy * 9.0 - vec2(vSeed * 3.0, vSeed * 13.0), vU * 0.95 - fallB * 1.7), min(lod + 3.2, 5.0));
  // Sub-columns of heavier / lighter precipitation inside one shaft.
  // Heavier AND lighter patches within a single shaft (real curtains are not an even sheet).
  float strand = 0.30 + 0.85 * (0.55 * nB.r + 0.45 * nC.a);
  float streak = 0.20 + 0.48 * nA.r + 0.38 * nA.g + 0.66 * (nB.r * 0.5 + nB.g * 0.5) + 0.20 * (nC.r - 0.5);
  streak *= strand;
  // Torn edges: the fine layer erodes the silhouette where it is already thin.
  float erode = 0.5 + 0.5 * (nB.g * 0.6 + nC.g * 0.4);
  edge = pow(edge, mix(1.7, 0.85, erode));

  float topFade = 1.0 - smoothstep(0.74, 1.0, vU);
  // Virga: ragged evaporating tendrils with a per-column bottom height.
  float ragged = fract(vSeed * 7.77);
  float botFade = smoothstep(0.0, 0.03 + 0.11 * ragged, vU);
  float tendril = mix(1.0, smoothstep(0.14, 0.58, nB.b + 0.28 * nC.b), (1.0 - smoothstep(0.02, 0.32, vU)) * 0.85);
  float body = pow(vU, 0.22);
  float planeGain = 0.86 + 0.16 * sin(vLayer * 2.399 + vSeed * 6.2831);
  float a = vRain * streak * edge * topFade * botFade * tendril * mix(0.62, 1.08, vU) * (0.66 + 0.44 * body) * planeGain;
  a *= clamp(0.72 + 0.85 * uRainIntensity + 0.95 * uHeavyRain, 0.72, 2.65);
  // Edge-on fade (see vertex): plane seen edge-on must vanish, not draw a line.
  a *= 1.0 - smoothstep(0.90, 0.985, vFace);
  // Spray churn where the curtain meets the ground: bright, turbulent base.
  float churn = (0.5 + 0.5 * nB.g) * (1.0 - smoothstep(0.0, 0.22, vU)) * clamp(0.35 + 0.65 * uRainIntensity + 0.6 * uHeavyRain, 0.0, 1.6);
  a *= 1.0 + 0.30 * churn;
  // Soft dissolve at the base (over water the shaft fades into spray, not a hard edge).
  a *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.16, vU));
  // Near shafts must be visible; the old 120..650 m fade erased exactly the rain under the storm.
  a *= smoothstep(30.0, 170.0, vDist);   // inside a shaft the nearest planes must not flash across the lens
  // Fragment-level near fade: the vertex fade above is interpolated across huge planes, so
  // fragments much closer than their vertices stayed fully opaque and speckled (grain)
  // whenever the camera sat inside a rain core.
  float fDist = length(cameraPosition - vec3(vWorld.x, vY, vWorld.y));
  a *= smoothstep(35.0, 200.0, fDist);
  a *= 1.0 - smoothstep(14000.0, 28000.0, vDist);
  // Far shafts soften their internal stripes so distant curtains read as volume, not bands.
  float far = smoothstep(2500.0, 12000.0, vDist);
  a *= mix(1.0, 0.82 + 0.18 * smoothstep(0.2, 1.0, streak), far);
  a = min(a, 0.9);
  if (a < 0.003) discard;

  // ---- lighting
  vec3 toCam = normalize(vec3(vWorld.x, 0.0, vWorld.y) - cameraPosition);
  float fwd = max(dot(toCam, uSunDir), 0.0);   // looking sunward through the shaft
  float back = max(dot(-toCam, uSunDir), 0.0); // the sun directly behind the shaft
  vec3 rainCol = (uSkyAmb * 1.05 + uSunCol * 0.24 + vec3(0.01)) * vec3(0.70, 0.76, 0.88);
  vec3 snowCol = (uSkyAmb * 1.1 + uSunCol * 0.4 + vec3(0.02)) * vec3(1.06, 1.06, 1.1);
  vec3 col = mix(rainCol, snowCol, vSnow);
  // Each shaft gets its own brightness/hue so a rain area reads as many individual cells,
  // not one uniform veil.
  col *= 0.90 + 0.20 * fract(vSeed * 29.7);
  // Vertical light: bright where the shaft enters the lit cloud base, dark near the ground.
  col *= mix(0.70, 1.14, vU);
  // Curtains take the colour of the cloud deck behind them, top to bottom, and blend into
  // the cloud base (no hard wedge where the shaft meets the deck).
  vec3 deck = (mix(uSkyAmb, uHorizon, 0.45) * 0.85 + uSunCol * 0.07 + vec3(0.012)) * mix(0.82, 1.06, fract(vSeed * 13.1));
  col = mix(col, deck, smoothstep(0.45, 1.0, vU) * 0.62);
  // Dense cores self-shadow; thin edges scatter more sunlight through them.
  float density = vRain * strand;
  col *= 1.0 - 0.30 * smoothstep(0.35, 1.1, density);
  // Forward scatter: a backlit shaft glows along its sunward face; streaks glint most
  // against dark backgrounds, so boost the sunward term when the deck is dark.
  col *= 1.0 + 1.20 * pow(fwd, 3.0) * (0.35 + 0.65 * (1.0 - smoothstep(0.4, 1.0, density)));
  col += uSunCol * pow(fwd, 6.0) * 0.10 * (1.0 - smoothstep(0.3, 0.9, density)) * streak;
  col *= 1.0 + 0.35 * pow(back, 4.0);
  col *= 1.0 - 0.18 * vHook;   // hook echo is darker / rain-wrapped
  if (uFlashOn > 0.5) col += flashLight(vec3(vWorld.x, 300.0, vWorld.y), vec3(0.0, 1.0, 0.0)) * 0.5 + uFlashCol * uFlashGlow * 0.16;
  // Atmospheric-haze integration: distant shafts must melt into the background air mass, not
  // sit on top of it as opaque cards. Blend toward the horizon haze colour and thin out.
  float fogF = 1.0 - exp(-vDist / max(uVis, 1.0));
  fogF = max(fogF, smoothstep(9000.0, 19000.0, vDist) * 0.85);
  vec3 fogc = uHorizon * 0.92 + uSkyAmb * 0.30;
  col = mix(col, fogc, clamp(fogF, 0.0, 1.0));
  a *= 1.0 - 0.55 * clamp(fogF, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`;

// A continuous camera-facing ribbon with mitered joins. Neighbour endpoints let the shader
// smooth bends instead of drawing disconnected, constant-width segment quads.
export const boltVert = /* glsl */ `
attribute vec3 aA; attribute vec3 aB; attribute vec3 aPrev; attribute vec3 aNext;
attribute vec4 aS; attribute vec2 aCorner; attribute vec2 aSeed;
uniform vec3 uOff; uniform float uT; uniform float uStep; uniform float uRS; uniform float uN;
uniform float uStrokeT[8]; uniform float uStrokeA[8];
uniform float uCCEnd; uniform float uCCAmp; uniform float uLeaderEnd;
uniform float uPol;   // -1 = negative CG, +1 = positive CG, 0 = intracloud
varying float vLum; varying float vHalo; varying float vSide; varying float vOrder; varying float vAlong;
varying float vFlicker; varying float vBead;
void main(){
  vec3 A = aA + uOff, B = aB + uOff;
  vec3 seg = B - A;
  vec3 segDir = normalize(seg + vec3(1e-4));
  vec3 toCam = normalize(cameraPosition - mix(A, B, aCorner.x));
  vec3 inDir = segDir, outDir = segDir;
  float lp = length(aA - aPrev), ln = length(aNext - aB);
  if (lp > 1e-3) inDir = normalize((A - (aPrev + uOff)) / lp);
  if (ln > 1e-3) outDir = normalize(((aNext + uOff) - B) / ln);
  vec3 d0 = normalize(mix(inDir, segDir, 0.45) + vec3(1e-5));
  vec3 d1 = normalize(mix(segDir, outDir, 0.45) + vec3(1e-5));
  vec3 side0 = cross(d0, toCam), side1 = cross(d1, toCam);
  float l0 = length(side0), l1 = length(side1);
  vec3 fallback = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-4, 1e-5, 1e-4));
  side0 = l0 > 1e-4 ? side0 / l0 : fallback;
  side1 = l1 > 1e-4 ? side1 / l1 : fallback;
  vec3 side = normalize(mix(side0, side1, aCorner.x) + vec3(1e-5));
  float tGen = aS.x * uStep;
  float ord = pow(0.72, aS.z);
  // Two luminance envelopes, as in real photographs of lightning:
  //  * vLum  — the blinding return-stroke core (microsecond rise, ~10 ms strobe decay);
  //  * vHalo — plasma-channel afterglow and air scattering (100-600 ms), which is what
  //    makes a bolt look like a violet ribbon hanging in the air instead of a strobe.
  // The old model used one envelope for both, so the glow died with the core and the only
  // "realism" left was bloom inflating a width that pulsed with the strobe.
  float lum = 0.0;
  float halo = 0.0;
  // Stepped leader: faint, short-lived beads appear as the channel grows, wrapped in a
  // soft violet scatter glow that trails the stepping front.
  if (uT > tGen){
    float age = uT - tGen;
    lum += 0.34 * exp(-age / 0.006) + 0.025 * exp(-age / 0.09);
    halo += 0.055 * exp(-age / 0.13);
  }
  for (int i = 0; i < 8; i++){
    if (float(i) >= uN) break;
    float tr = uStrokeT[i] + aS.y * uRS;
    if (uT > tr){
      float age = uT - tr;
      lum += uStrokeA[i] * ord * (exp(-age / 0.012) + 0.28 * exp(-age / 0.075));
      // Channel afterglow: a real CG channel stays visibly lit for ~100-200 ms after the
      // return stroke passes, cooling from white to violet.
      halo += uStrokeA[i] * ord * 0.45 * exp(-age / 0.13);
    }
  }
  if (uT > uStrokeT[0] && uT < uCCEnd) {
    lum += uCCAmp * ord * (0.65 + 0.35 * sin(uT * 90.0 + aSeed.x * 20.0));
    halo += uCCAmp * ord * 0.55;
  }
  if (uT > uLeaderEnd) {
    lum += 0.03 * ord * exp(-(uT - uLeaderEnd) / 0.42);
    halo += 0.05 * ord * exp(-(uT - uLeaderEnd) / 0.55);
  }
  vLum = lum;
  vHalo = halo;
  vOrder = aS.z;
  vAlong = aCorner.x * 2.0 - 1.0;
  vSide = aCorner.y;
  // Negative strokes strobe fast (stepped-leader return strokes); positive strokes are a
  // single sustained discharge with a slower, smoother intensity wobble.
  float flickSpeed = uPol > 0.5 ? 70.0 : 210.0;
  float flick2 = uPol > 0.5 ? 160.0 : 470.0;
  float flickAmp = uPol > 0.5 ? 0.05 : 0.10;
  vFlicker = clamp(0.86 + flickAmp * sin(uT * flickSpeed + aSeed.x * 37.0) + 0.06 * sin(uT * flick2 + aSeed.y * 19.0), 0.62, 1.08);
  vBead = 0.86 + 0.14 * sin(aS.y * 0.055 + aSeed.y * 31.0);
  float dist = length(cameraPosition - mix(A, B, aCorner.x));
  // Physical channel radius scales only weakly with peak current (~sqrt(I)); the broad
  // scattering halo is carried by vHalo in the fragment stage, so ribbon width follows the
  // slow afterglow envelope rather than the return-stroke strobe — no width-pulsing.
  float w = (0.40 + 0.70 * sqrt(max(lum, 0.0)) + 0.95 * sqrt(max(halo, 0.0))) * aS.w * 1.05
    + dist * 0.00085;
  w *= mix(1.0, 0.72, clamp(aS.z / 3.0, 0.0, 1.0));
  // Positive CG channels carry far higher peak current: a visibly thicker, steadier channel.
  w *= mix(1.0, 1.4, step(0.5, uPol));
  vec3 p = mix(A, B, aCorner.x) + side * aCorner.y * w * 3.0;
  // Extend both ends slightly along the local tangent so mitered joints never show a gap.
  p += mix(d0, d1, aCorner.x) * (aCorner.x * 2.0 - 1.0) * w * 0.16;
  gl_Position = (lum < 0.003) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
export const boltFrag = /* glsl */ `
varying float vLum; varying float vHalo; varying float vSide; varying float vOrder; varying float vAlong;
varying float vFlicker; varying float vBead;
uniform float uPol;
void main(){
  float s = abs(vSide);
  float core = exp(-s * s * 24.0);
  float glow = exp(-s * s * 3.0);
  float halo = exp(-s * s * 0.62);
  float endFade = 0.82 + 0.18 * (1.0 - smoothstep(0.72, 1.0, abs(vAlong)));
  vec3 hot = vec3(1.0, 0.98, 0.94);
  vec3 blue = vec3(0.62, 0.78, 1.0);
  vec3 violet = vec3(0.38, 0.44, 0.96);
  // Positive CG: hotter white-violet core from the much larger peak current.
  // Negative CG: classic blue-white return stroke. IC: dimmer, violet.
  vec3 tint = uPol > 0.5 ? vec3(1.0, 0.96, 1.02) : (uPol < -0.5 ? vec3(0.86, 0.94, 1.06) : vec3(0.82, 0.84, 1.05));
  float gain = uPol > 0.5 ? 1.35 : (uPol < -0.5 ? 1.0 : 0.8);
  // The core strobes with the return stroke (vFlicker); the scatter halo rides the slow
  // afterglow envelope and does NOT strobe — light scattered by air and rain keeps lighting
  // the ribbon for ~150 ms after the channel current dies. That persistence, not bloom, is
  // what reads as realism on camera.
  float strobe = vLum * vFlicker * vBead;
  float after = vHalo * (0.85 + 0.15 * vBead);
  vec3 c = hot * core * (26.0 * strobe + 1.9 * after)
    + mix(blue, hot, core) * glow * (3.0 * strobe + 1.15 * after)
    + violet * halo * (0.55 * strobe + 0.95 * after);
  c *= endFade;
  c *= tint * gain;
  c *= mix(1.0, 0.58, clamp(vOrder / 3.0, 0.0, 1.0));   // thin branches are dimmer
  gl_FragColor = vec4(c, 1.0);
}`;

export const fsVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const cloudFrag = /* glsl */ `
${COMMON}
uniform sampler3D uNoise; uniform sampler2D uDepth; uniform sampler2D uHist; uniform sampler2D uHistAux;
uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform mat4 uPrevVP; uniform vec3 uCamPos;
uniform float uFrame; uniform float uBlend; uniform float uStepScale; uniform float uMaxSteps;
uniform float uDetail; uniform float uCheapLight;   // fast storm-load path
uniform vec2 uWindOff[16];
uniform float uLodScale;   // texels-per-metre-per-pixel factor for the noise volume
uniform vec3 uCloudSeed;   // per-session constant offset: every run builds different structures
varying vec2 vUv;
// MRT: location 0 = premultiplied cloud radiance + transmittance, location 1 = scattering depth
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;

#ifdef LOWQ
#define CLOUD_STEPS 26
#define DETAIL_ON true
#else
#define CLOUD_STEPS 80
#define DETAIL_ON (t < 7000.0)
#endif

vec2 windOffAt(float y){
  float f = clamp(y / 15000.0 * 16.0 - 0.5, 0.0, 15.0);
  int i0 = int(floor(f)); int i1 = min(i0 + 1, 15);
  return mix(uWindOff[i0], uWindOff[i1], f - float(i0));
}
float hg(float c, float g){ float b = max(1.0 + g*g - 2.0*g*c, 1e-3); return (1.0 - g*g) / (b * sqrt(b)); }
// two-lobe droplet phase function: strong forward peak (silver lining) + wide backscatter
#ifdef LOWQ
float phase(float c, float k){ return hg(c, 0.6 * k) * 1.15; }
#else
float phase(float c, float k){ return 0.78 * hg(c, 0.72 * k) + 0.22 * hg(c, -0.18 * k); }
#endif

// Mip level for the noise volume. The march runs in non-uniform control flow where screen
// derivatives are undefined, so the footprint is derived from ray distance instead — without
// this every high-frequency noise tap aliases into per-pixel grain on distant cloud.
float nlod(float t, float period){ return clamp(log2(max(1.0, t * uLodScale / period)) + 0.3, 0.0, 5.0); }

// The solver supplies broad condensate, ice fraction, rain and vertical velocity. A
// Perlin-Worley base shapes that coverage into billows; height/ice/updraft make towers and
// smoother anvils; cellular detail erodes only the exposed edges. No extra cloud fetches.
float cloudDensity(vec3 p, float t, out float rainD, out float iceF, out float edge, bool detail){
  vec4 s = sampleCloud(p);
  rainD = s.g; iceF = s.b; edge = 0.0;
  float base = s.r;
  // Lowered, rain-free wall cloud / condensation funnel source around the simulated vortex.
  vec2 td = p.xz - uTornado.xy;
  td -= uDomain * floor(td / uDomain + 0.5);
  float tr = length(td);
  float wall = uTornado.w * exp(-tr * tr / max(1.0, 9.0 * uTornado.z * uTornado.z));
  wall *= 1.0 - smoothstep(uTornadoTop * 0.55, uTornadoTop * 1.35, p.y);
  base += wall * 0.45 * smoothstep(0.0, 0.25, p.y / max(1.0, uTornadoTop));
  // Smooth vertical envelope instead of a visible lid / ground box.
  float topFade = 1.0 - smoothstep(12600.0, 15000.0, p.y);
  float baseFade = smoothstep(0.0, 220.0, p.y);
  base *= topFade * baseFade;
  if (base < 0.0006) return 0.0;
  float updraft = clamp((s.a - 0.5) * 2.0, -1.0, 1.0);
  // Integer noise periods per 32 km domain. A constant wind offset preserves periodicity;
  // the fluid displacement is also domain-periodic, so the tiling survives it too.
  float broadP = uDomain / 6.0, midP = uDomain / 32.0, fineP = uDomain / 128.0;
  // Fluid shear displaces the sampling frame, but bounded: the raw field carries grid-scale
  // noise that a x7 gain amplified into cloud shimmer between frames.
  vec2 wo = windOffAt(p.y) + fluidVel(p.xz) * 4.5;
  vec3 np = p + vec3(wo.x, 0.0, wo.y) + uCloudSeed;
  // Slow domain-periodic churn boil: growing turrets visibly roil and breathe instead of
  // being a static texture advected with the wind (constant per-frame offset keeps tiling).
  np += vec3(6.0, 1.1, 3.0) * uTime * 0.8;
  // ---- regional regime: one very-broad periodic field gives different parts of the domain
  // different cloud character (stratus decks, cumulus fields, fibrous cirrus) and varies the
  // coverage threshold / warp strength per region — so the domain never repeats one structure.
  vec4 nR = textureLod(uNoise, np / (uDomain / 2.0), nlod(t, uDomain / 2.0));
  float regime = nR.r;
  float wStratus = 1.0 - smoothstep(0.34, 0.50, regime);
  float wCirrus = smoothstep(0.62, 0.80, regime);
  float wCumulus = clamp(1.0 - wStratus - wCirrus, 0.0, 1.0);
  float cover = smoothstep(0.002 + 0.008 * nR.g, 0.44 + 0.14 * nR.b, base);
  vec4 nA = textureLod(uNoise, np / broadP, nlod(t, broadP));
  // A gentle domain-periodic organisation: broad bands + cellular billows, no per-frame drift.
  float broad = 0.58 * nA.r + 0.42 * (1.0 - nA.g);
  float billow = smoothstep(0.16, 0.80, broad);
  float band = 0.5 + 0.5 * sin((np.x + 0.35 * np.z) / (uDomain / 3.0) + 2.0 * nA.b);
  vec2 warp = (nA.gb - 0.5) * mix(420.0, 950.0, smoothstep(0.35, 0.95, iceF)) * (0.70 + 0.60 * nR.g);
  vec3 np2 = np + vec3(warp.x, warp.y * 0.25, warp.y);
  vec4 nB = textureLod(uNoise, np2 / midP, nlod(t, midP));
  // Second, finer warp: this is what turns smooth blobs into lobed cauliflower with creases.
  vec2 warp2 = (nB.ba - 0.5) * 115.0;
  vec3 np3 = np2 + vec3(warp2.x, warp2.y * 0.4, warp2.y);
  vec4 nC = textureLod(uNoise, np3 / midP, nlod(t, midP));
  float towerW = smoothstep(0.04, 0.82, updraft);
  float iceW = smoothstep(0.35, 0.95, iceF);
  float hW = smoothstep(1800.0, 5400.0, p.y);
  float anvilW = iceW * smoothstep(6200.0, 10000.0, p.y);
  // Billow transform: rounded lobes with sharp creases instead of evenly puffy cotton.
  float lobes = 1.0 - abs(2.0 * nC.g - 1.0);
  lobes = mix(0.5, lobes, 0.5 + 0.3 * billow);
  // Cauliflower: inside strong updraft towers the lobes sharpen into deep creased domes
  // (pow > 1 on the ridged field) — the signature look of a growing cumulonimbus turret.
  float cauli = pow(1.0 - abs(2.0 * nC.g - 1.0), 1.9);
  float lowShape = cover * (0.52 + 0.66 * billow + 0.30 * lobes) * (0.86 + 0.26 * band);
  // ---- cloud types selected by the regional regime field
  // cumulus humilis: small puffy fair-weather fields with a hard ceiling
  float humShape = cover * smoothstep(150.0, 500.0, p.y) * (1.0 - smoothstep(1700.0, 3100.0, p.y))
    * (0.42 + 0.62 * billow + 0.40 * lobes) * (0.84 + 0.26 * band);
  // stratus / stratocumulus deck: flat base, lumpy top, modest depth (never deletes the
  // solver's cloud above the deck — it fades to a quarter density instead of zero)
  float deckTop = 1900.0 + 1500.0 * nR.a;
  float stratusShape = cover * smoothstep(280.0, 680.0, p.y)
    * (1.0 - 0.75 * smoothstep(deckTop * 0.80, deckTop * 1.9, p.y))
    * (0.72 + 0.34 * billow + 0.16 * band) * (0.88 + 0.22 * nA.r);
  // cirrus: high fibrous ice, read from a 4x-stretched slice (still domain-periodic)
  float fib = 0.5;
  float cirrusShape = 0.0;
  if (wCirrus > 0.02) {
    vec4 nF = textureLod(uNoise, vec3(np.x / (8.0 * midP), np.y / midP, np.z / midP), nlod(t, 8.0 * midP));
    fib = nF.r * 0.55 + (1.0 - abs(2.0 * nF.g - 1.0)) * 0.45;
    cirrusShape = cover * smoothstep(7200.0, 9000.0, p.y) * (1.0 - smoothstep(12400.0, 14600.0, p.y))
      * (0.30 + 0.85 * fib) * (0.66 + 0.40 * band) * 0.60;
  }
  float cumulusShape = mix(lowShape, humShape, 0.45);
  float bg = wStratus * stratusShape + wCumulus * cumulusShape + wCirrus * cirrusShape;
  bg = max(bg, 0.28 * lowShape);   // the solver's structure always shows through
  float towerShape = cover * (0.54 + 0.66 * billow + 0.36 * mix(lobes, cauli, towerW)) * (0.86 + 0.34 * towerW) * (0.92 + 0.18 * band);
  float anvilShape = cover * (0.62 + 0.46 * nA.r) * (0.84 + 0.30 * nC.r) * (1.0 - 0.12 * billow);
  // Wind-drawn anvil fibres: at anvil heights sample the noise stretched hard along the
  // wind (x) and compressed across it, so the ice cap breaks into streaks streaming
  // downwind instead of a smooth dome.
  if (anvilW > 0.02) {
    vec4 nAn = textureLod(uNoise, vec3(np.x / (2.2 * midP), np.y / midP, np.z / (9.0 * midP)), nlod(t, 9.0 * midP));
    float fibAn = nAn.r * 0.55 + (1.0 - abs(2.0 * nAn.g - 1.0)) * 0.45;
    anvilShape *= 0.60 + 0.62 * fibAn;
  }
  // Deep convection overrides the regional background only where updrafts actually build
  // towers; quiescent high regions keep their regime character (cirrus stays fibrous).
  float shape = mix(bg, towerShape, hW * (0.30 + 0.70 * towerW));
  shape = mix(shape, anvilShape, anvilW);
  // Real cloud bases are flat (condensation level): calm the lowest sliver of each column so
  // the underside reads as a level deck instead of noise dipping to the ground.
  shape *= mix(0.78, 1.0, smoothstep(0.03, 0.13, base));
  // the cirrus regime shears the anvil top into wind-drawn ice fibres, not smooth blobs
  if (wCirrus > 0.05) shape *= 1.0 - 0.35 * wCirrus * anvilW * (1.0 - fib);
  if (!detail) return clamp(shape, 0.0, 1.0);
  float mid = 0.60 * nC.r + 0.40 * (1.0 - nC.g);
  shape *= 0.88 + mix(0.24, 0.16, uDenoise) * mid;
  float fine = nC.b * 0.62 + nC.a * 0.38;
  if (t < 3400.0) {
    vec4 nD = textureLod(uNoise, np3 / fineP, nlod(t, fineP));
    fine = fine * 0.58 + (0.55 * nD.r + 0.45 * (1.0 - nD.g)) * 0.42;
  }
  edge = 1.0 - smoothstep(0.08, 0.72, shape);
  // Erosion eats exposed edges more than cores; the lobe term carves the creases deeper.
  float erosion = (1.0 - fine) * mix(0.08 + 0.22 * edge, 0.05 + 0.14 * edge, uDenoise) * mix(0.55, 0.90, 1.0 - iceW);
  erosion += (1.0 - lobes) * 0.07 * edge;
  float d = clamp((shape - erosion) / max(0.24, 1.0 - erosion * 0.60), 0.0, 1.0);
  // Soft cutoff: hard density thresholds are what make a voxel grid read as stacked boxes.
  return smoothstep(0.0, 0.26, d) * d;
}

float sunTau(vec3 p){
#ifdef LOWQ
  // Low tier / cheap path: one tap instead of four 3-D fetches per lighting update.
  vec4 s = sampleCloud(p + uSunDir * (2200.0 / max(uSunDir.y, 0.2)));
  return (smoothstep(0.01, 0.85, s.r) * 1.10 + s.g * 0.30) * 0.058 * 2200.0;
#else
  float tau = 0.0; float st = 150.0; vec3 q = p;
  for (int j = 0; j < 4; j++){
    q += uSunDir * st;
    if (q.y > 15000.0) break;
    vec4 s = sampleCloud(q);
    tau += (smoothstep(0.01, 0.85, s.r) * 1.10 + s.g * 0.30) * 0.058 * st;
    st *= 2.5;
  }
  return tau;
#endif
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 rd = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
  vec3 ro = uCamPos;
  float dpt = texture(uDepth, vUv).r;
  float tTer = 1e9;
  if (dpt < 0.99999){ vec4 vv = uInvProj * vec4(ndc, dpt * 2.0 - 1.0, 1.0); vv /= vv.w; tTer = length(vv.xyz); }
  // No hard 45 km / 15 km box: density fades with height and distance before the march ends.
  // Terrain depth is the only real occlusion boundary.
  float t1 = min(60000.0, tTer);
  // Jitter keyed to the WORLD ray direction, not gl_FragCoord: a screen-fixed pattern slides
  // over the cloud surface whenever the camera turns (clouds appeared to shift under you).
  // The ray through a given world direction keeps the same cell, so history reprojection is
  // exact under rotation; translation errors are one cell (~half a pixel).
  vec3 rcell = floor(rd * 2048.0);
  float staticJ = fract(52.9829189 * fract(dot(rcell, vec3(0.06711056, 0.00583715, 0.11311993))));
  float frameJ = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * uFrame, vec2(0.06711056, 0.00583715))));
  // Almost entirely a fixed per-pixel offset: only a hint of frame variation, so the
  // temporal blend has something stable to accumulate instead of chasing a new dither.
  float jitter = mix(staticJ, frameJ, mix(0.16, 0.05, uDenoise));
  float cosT = dot(rd, uSunDir);
  vec3 L = vec3(0.0); float T = 1.0; float tHit = -1.0;
  float tSum = 0.0, wSum = 0.0;
  float t = mix(60.0, 34.0, uDenoise) * jitter * uStepScale;
  // Always run a short coarse entry search. The old hard uCamCloud < 0.35 branch made
  // cloud structure pop when the camera crossed a condensate threshold.
  float cstep = clamp(t1 * 0.075, 260.0, 1700.0) * uStepScale * mix(1.0, 0.45, uCamCloud);
  for (int i = 0; i < 9; i++){
    if (t + cstep * 1.5 >= t1) break;
    vec3 pc = ro + rd * t;
    vec4 sc0 = sampleCloud(pc);
    if (sc0.r > 0.005 || sc0.g > 0.010) break;
    t += cstep;
  }
  float tauC = 0.0; bool lightDirty = true;
  // Engulfed by cloud: the beam is extinguished within a few hundred metres, so the
  // remaining step budget is wasted work. Halve it.
  float maxSteps = uMaxSteps * (1.0 - 0.35 * uCamCloud);
  for (int i = 0; i < CLOUD_STEPS; i++){
    if (float(i) >= maxSteps || t > t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float stepLen = clamp(0.045 * t + 55.0, 55.0, 1200.0) * uStepScale;
    // vary the step length with a *smooth* per-pixel field: white noise here read as grain
    // in the integrated density, low-frequency variation just breaks slice banding
    stepLen *= 0.97 + 0.06 * vnoise2(gl_FragCoord.xy * 0.13 + vec2(float(i) * 7.3, float(i) * 3.1));
    // optically thick cloud does not need fine steps: grow them as the beam is extinguished
    stepLen *= mix(1.0, 2.6, 1.0 - T);
    float rainD, iceF, edge;
    bool detail = DETAIL_ON && uDetail > 0.5;
    float d = cloudDensity(p, t, rainD, iceF, edge, detail);
    float rainFade = smoothstep(120.0, 700.0, t);
    float sc = d * 0.085;
    // Smooth low-frequency modulation of the precipitation scattering: the old per-sample
    // white noise was a grain generator inside every shaft.
    float rm = vnoise2(vec2(p.x * 0.0011 + p.z * 0.0007, p.y * 0.0009 + p.z * 0.0005));
#ifdef LOWQ
    float sr = rainD * 0.0055 * rainFade * 0.95;
#else
    float sr = rainD * 0.0055 * rainFade * (0.55 + 0.85 * rm);
#endif
    // ---- rain mist: dense low-level haze suspended beneath precipitating cloud. This is the
    // murk that fills the air under a shaft and softens the ground contact of heavy rain.
    float mist = (1.0 - smoothstep(60.0, 950.0, p.y)) * smoothstep(0.008, 0.14, rainD) * (0.55 + 0.90 * uHeavyRain);
    float sm = mist * 0.011;
    // No spherical horizon fade: that shell (32-60 km around the camera) was the "bounding
    // sphere" clipping the cloud volume along a visible curved edge. Distance haze now
    // saturates before the march cap instead (fogF below) — same perf bound, no edge.
    float topFade = 1.0 - smoothstep(12600.0, 15000.0, p.y);
    float sig = (sc + sr + sm) * topFade;
    if (sig > 1e-5){
      // Sun transmittance is the most expensive part of a dense march. Recompute it on the first
      // hit, then every 4 steps normally or every 8 in the cheap storm path.
      if (lightDirty || ((i & 3) == 0 && (uCheapLight < 0.5 || (i & 7) == 0))) { tauC = sunTau(p); lightDirty = false; }
      float tau = tauC;
      // 4 octaves of a Henyey-Greenstein phase function: a cheap multiple-scattering
      // approximation. Without it thick cloud cores go black instead of glowing grey.
      // The phase is evaluated once per step (the anisotropy barely changes per octave).
      float ph = phase(cosT, 1.0);
      vec3 sunL = vec3(0.0); float a = 1.0, b = 1.0;
      for (int o = 0; o < 4; o++){ sunL += a * exp(-tau * b) * ph; a *= 0.46; b *= 0.38; }
      sunL *= 0.54;
      float powder = mix(1.0, 1.0 - 0.68 * exp(-d * 7.0), 0.8 * (1.0 - smoothstep(0.15, 0.85, cosT)));
      float cT = max(cosT, 0.0), cT2 = cT * cT, cT4 = cT2 * cT2;
      float rim = smoothstep(0.35, 0.95, edge) * (1.0 - d);
      float silver = cT4 * cT4 * cT2 * ((1.0 - smoothstep(0.05, 0.5, d)) + 0.30 * rim);
      float hF = clamp(p.y / 9000.0, 0.0, 1.0);
      // one-tap vertical occlusion: how much cloud sits above this sample
      float aoU = 1.0;
      if (uCheapLight < 0.5 && d > 0.03 && (i & 1) == 0) aoU = exp(-sampleCloud(p + vec3(0.0, 1100.0, 0.0)).r * 2.3);
      // one-tap directional (side) shading: denser cloud toward the sun means this face is
      // turned away from the light — the single biggest cue that separates real cumulus
      // from uniformly lit cotton wool.
      float sideShade = 1.0;
      if (uCheapLight < 0.5 && (i & 1) == 0) {
        float dSun = sampleCloud(p + uSunDir * 430.0).r;
        sideShade = mix(0.56, 1.24, smoothstep(-0.30, 0.30, d - dSun));
      }
      float hDark = mix(0.34, 1.0, smoothstep(0.02, 0.46, hF));
      hDark *= 1.0 - 0.36 * smoothstep(0.06, 0.75, rainD);   // precipitation darkens the base
      // Shadowed cloud volume scatters skylight in, so it reads blue-grey; tops warm up.
      vec3 ambTint = mix(vec3(0.74, 0.84, 1.06), vec3(1.02, 1.0, 0.97), smoothstep(0.0, 0.65, hF));
      vec3 amb = mix(uGroundAmb * 0.55, uSkyAmb, smoothstep(0.0, 0.75, hF));
      amb *= (0.16 + 0.84 * aoU) * (0.70 + 0.52 * d) * hDark * ambTint;
      // light that has bounced around inside the cloud: lifts the core without flattening edges
      amb += uSunCol * sunL * (0.05 + 0.13 * d) * mix(0.35, 1.0, hF);
      // A flash illuminates the whole cloud body, not just six discrete point samples.
      amb += uFlashCol * uFlashGlow * (0.10 + 0.32 * d) * mix(0.35, 1.0, hF);
      vec3 sunTint = mix(vec3(1.0), vec3(1.18, 0.93, 0.78), clamp(uTwilight * 0.8 + 0.25 * (1.0 - uSunDir.y), 0.0, 0.65));
      vec3 fl = uFlashOn > 0.5 ? flashLight(p, vec3(0.0, 1.0, 0.0)) : vec3(0.0);
      vec3 iceTint = mix(vec3(1.0), vec3(0.95, 0.97, 1.06), iceF);
      vec3 Sc = (uSunCol * sunTint * sunL * sideShade * (0.55 + 0.70 * silver) * powder + amb + fl * 0.28) * iceTint;
      vec3 Sr = (uSunCol * sunTint * 0.09 * sunL * sideShade + amb * 0.8 + fl * 0.18) * vec3(0.78, 0.84, 0.94);
      // Mist scatters like thin haze: skylight-dominated, slightly sunlit, cool grey.
      vec3 Sm = (uSkyAmb * 1.2 + uSunCol * 0.30 * exp(-tau * 0.55) + vec3(0.015)) * vec3(0.86, 0.90, 0.97);
      vec3 S = (sc * Sc + sr * Sr + sm * Sm) / max(sig, 1e-7);
      float Ts = exp(-sig * stepLen);
      float wgt = T * (1.0 - Ts);
      tSum += wgt * t; wSum += wgt;
      L += T * (1.0 - Ts) * S;
      T *= Ts;
      if (tHit < 0.0 && T < 0.97) tHit = t;
      t += stepLen * (0.7 + 0.3 * clamp(sig * stepLen, 0.0, 1.0));
    } else {
      t += stepLen * 2.0;   // clear air: stride out
    }
  }
  float tMean = wSum > 1e-4 ? tSum / wSum : 60000.0;
  float dist = tHit > 0.0 ? tHit : min(t1, 60000.0);
  float fogF = 1.0 - exp(-dist / (uVis * 2.2));   // storms stay readable from many km away
  // Fully hazed well before the 60 km march cap, so the cloud volume never ends along a
  // visible spherical shell around the camera (the removed horizonFade was that shell).
  fogF = max(fogF, smoothstep(30000.0, 52000.0, dist));
  vec3 haze = mix(uHorizon, uSkyAmb, 0.55) * 0.85;   // air, not white fog
  L = L * (1.0 - fogF) + haze * fogF * (1.0 - T);
  // ---- temporal reprojection at the real scattering depth (a fixed 9 km point smears
  // badly once the cloud is close to the camera, which is what looked like stutter)
  vec3 P = uCamPos + rd * tMean;
  vec4 pc = uPrevVP * vec4(P, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float valid = (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) ? 1.0 : 0.0;
  vec4 hist = texture(uHist, puv);
  float histD = texture(uHistAux, puv).r;
  // Clamp history to the 3x3 neighbourhood range: removes speckles and one-frame black/white
  // pops without smearing real cloud edges as much as a raw temporal blur would.
  vec2 hx = 1.0 / uCloudRes;
  vec4 h0 = texture(uHist, puv + vec2(hx.x, 0.0));
  vec4 h1 = texture(uHist, puv - vec2(hx.x, 0.0));
  vec4 h2 = texture(uHist, puv + vec2(0.0, hx.y));
  vec4 h3 = texture(uHist, puv - vec2(0.0, hx.y));
  vec4 hmin = min(min(hist, h0), min(min(h1, h2), h3));
  vec4 hmax = max(max(hist, h0), max(max(h1, h2), h3));
  vec4 histC = clamp(hist, hmin - vec4(0.04), hmax + vec4(0.04));
  hist = mix(hist, histC, uDenoise);
  // Softer history rejection: the old tight thresholds discarded history on ordinary
  // snapshot-to-snapshot changes, snapping between old/new results as one-frame flicker.
  float b2 = mix(uBlend, 0.975, uDenoise) * valid * (1.0 - smoothstep(0.30, 0.68, abs(hist.a - T)));
  float rel = abs(histD - tMean) / max(min(histD, tMean), 200.0);
  b2 *= 1.0 - smoothstep(0.45, 1.2, rel);
  b2 *= 1.0 - 0.9 * uCamCloud;   // inside cloud: trust the (cheap, short) current march
  // Even a rejected history keeps a fifth of its weight: full rejection flashed the raw
  // jittered march back in and read as grain/flicker on every snapshot tick.
  b2 = max(b2, mix(0.20, 0.38, uCamCloud) * valid);
  outColor = mix(vec4(L, T), hist, b2);
  outAux = vec4(tMean, T, 0.0, 1.0);
}
`;

export const compFrag = /* glsl */ `
uniform sampler2D uScene; uniform sampler2D uCloudRT; uniform sampler2D uCloudAux;
uniform float uExposure; uniform float uTime; uniform vec2 uRes; uniform vec2 uCloudRes;
uniform float uCheapUpsample; uniform float uDenoise;
uniform float uRainIntensity; uniform float uHeavyRain; uniform float uCamCloud;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// Edge-aware upsample of the reduced-resolution cloud buffer. A plain bilinear fetch
// smears cloud edges into blocky steps; weighting the 4 neighbours by scattering-depth
// similarity keeps the silhouette crisp without ringing.
const vec2 CLOUD_OFF[16] = vec2[16](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0),
  vec2(2.0, 0.0), vec2(-2.0, 0.0), vec2(0.0, 2.0), vec2(0.0, -2.0),
  vec2(2.0, 2.0), vec2(-2.0, 2.0), vec2(2.0, -2.0), vec2(-2.0, -2.0)
);
const float CLOUD_W[16] = float[16](
  1.0, 1.0, 1.0, 1.0, 0.72, 0.72, 0.72, 0.72,
  0.45, 0.45, 0.45, 0.45, 0.25, 0.25, 0.25, 0.25
);
vec4 cloudSample(vec2 uv){
  vec2 tx = 1.0 / uCloudRes;
  vec4 c0 = texture(uCloudRT, uv);
  float d0 = texture(uCloudAux, uv).r;
  vec4 acc = c0 * 2.0;
  float wsum = 2.0;
  int taps = uCheapUpsample > 0.5 ? 4 : (uDenoise > 0.5 ? 16 : 8);
  for (int i = 0; i < 16; i++){
    if (i >= taps) break;
    vec4 c = texture(uCloudRT, uv + CLOUD_OFF[i] * tx);
    float d = texture(uCloudAux, uv + CLOUD_OFF[i] * tx).r;
    // depth similarity keeps the silhouette crisp; transmittance jump rejects cloud/sky bleed
    float w = CLOUD_W[i] / (1.0 + pow(abs(d - d0) / max(120.0, 0.06 * d0), 2.0));
    w *= 1.0 - 0.35 * smoothstep(0.18, 0.65, abs(c.a - c0.a));
    acc += c * w; wsum += w;
  }
  return acc / wsum;
}

void main(){
  vec3 scene = texture(uScene, vUv).rgb;
  vec4 c = cloudSample(vUv);
  // A small depth/range-aware bilateral filter removes residual checkerboard and speckle
  // without crossing cloud/sky boundaries (checked on transmittance and scattering depth).
  if (uDenoise > 0.01 && uCheapUpsample < 0.5) {
    vec2 tx = 1.0 / uCloudRes;
    float d0 = texture(uCloudAux, vUv).r;
    vec3 rad = vec3(0.0); float wsum = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 uv = vUv + CLOUD_OFF[i] * tx;
      vec4 q = texture(uCloudRT, uv);
      float d = texture(uCloudAux, uv).r;
      float w = CLOUD_W[i] / (1.0 + pow(abs(d - d0) / max(120.0, 0.06 * d0), 2.0));
      w *= 1.0 - 0.35 * smoothstep(0.18, 0.65, abs(q.a - c.a));
      rad += q.rgb * w; wsum += w;
    }
    c.rgb = mix(c.rgb, (c.rgb * 2.0 + rad) / (2.0 + wsum), 0.45 * uDenoise);
  }
  vec3 col = scene * c.a + c.rgb;
  // Looking through heavy local rain: a faint cool desaturating veil (rain haze), suppressed
  // when the camera is inside cloud (the cloud pass already handles that murk).
  float rainVeil = uRainIntensity * (0.35 + 0.65 * uHeavyRain) * (1.0 - uCamCloud);
  col = mix(col, col * vec3(0.86, 0.92, 1.03) + vec3(0.006), 0.34 * rainVeil);
  col *= uExposure;
  col = aces(col);
  float vg = 1.0 - 0.28 * pow(length(vUv - 0.5) * 1.35, 2.2);
  col *= vg;
  col = pow(col, vec3(1.0 / 2.2));
  // Static per-pixel dither: the old fract(uTime) re-randomised it every frame, dithering
  // the ENTIRE composite (particles, clouds, terrain) into frame-by-frame flicker.
  float n = fract(sin(dot(vUv * uRes, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Charge particles for the show-charges toggle: point sprites drawn as crisp + / − glyphs,
// red for net-positive charge, blue for net-negative, sized and faded by |q|.
// ---------------------------------------------------------------------------------------------
export const chargeVert = /* glsl */ `
${COMMON}
attribute vec2 aQ;   // x = signed magnitude (sign * 0..1), y = phase
varying float vSign; varying float vMag; varying float vPhase; varying vec3 vW; varying float vDist;
void main(){
  vSign = sign(aQ.x);
  vMag = clamp(abs(aQ.x), 0.0, 1.0);
  vPhase = aQ.y;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float dist = length(mv.xyz);
  vDist = dist;
  // Gentle bob so the field reads as suspended charge, not a static decal.
  vec3 wp = position;
  wp.y += sin(uTime * 0.9 + aQ.y * 6.2831) * 3.0;
  vW = wp;
  gl_PointSize = clamp((5.0 + 15.0 * vMag) * (1500.0 / max(dist, 1.0)), 2.0, 70.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

export const chargeFrag = /* glsl */ `
${COMMON}
varying float vSign; varying float vMag; varying float vPhase; varying vec3 vW; varying float vDist;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Soft glow + tight core: charge pockets are diffuse volumes, not hard ± glyphs. The old
  // glyph bars aliased into white grain speckle over the whole sky when viewed from below.
  float glow = exp(-r2 * 3.2);
  float core = exp(-r2 * 14.0);
  float tw = 0.88 + 0.12 * sin(uTime * 1.1 + vPhase * 6.2831);
  vec3 pos = vec3(1.0, 0.34, 0.22);
  vec3 neg = vec3(0.35, 0.62, 1.0);
  vec3 col = mix(neg, pos, step(0.0, vSign));
  col = mix(col, vec3(1.0), core * 0.35 * step(0.45, vMag));   // only strong cores whiten slightly
  if (uFlashOn > 0.5) col += flashLight(vW, vec3(0.0, 1.0, 0.0)) * 0.2;
  float a = (glow * 0.55 + core * 0.45) * (0.25 + 0.75 * vMag) * tw;
  // Distance fades: no point-sprite popping near the lens or glittering at the domain edge.
  a *= smoothstep(250.0, 900.0, vDist) * (1.0 - smoothstep(28000.0, 44000.0, vDist));
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
}`;
