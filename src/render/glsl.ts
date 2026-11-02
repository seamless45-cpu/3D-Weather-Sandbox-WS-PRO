// All GLSL (ES 3.00 via three.js ShaderMaterial). Written without implicit int->float conversions.
export const COMMON = /* glsl */ `
#define PI 3.14159265
uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyAmb; uniform vec3 uHorizon; uniform vec3 uGroundAmb;
uniform float uTwilight; uniform float uDomain; uniform float uVis; uniform float uSkyScale;
uniform float uCamCloud;   // 0 = clear air at the camera, 1 = camera inside condensate
uniform sampler3D uCloud;
uniform vec4 uFlash[6]; uniform vec3 uFlashCol; uniform float uFlashOn;
uniform vec2 uWind;
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
  L += vec3(0.0025, 0.0045, 0.012);
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
    float att = f.w / (1.0 + r2 / 1.44e6);
    acc += att * (0.35 + 0.65 * max(dot(n, L), 0.0));
  }
  return acc * uFlashCol;
}
vec3 applyFog(vec3 col, vec3 wpos){
  vec3 d = wpos - cameraPosition;
  float dist = length(d);
  vec3 dn = d / max(dist, 1e-3);
  float f = 1.0 - exp(-dist / uVis);
  f = max(f, smoothstep(13500.0, 21500.0, dist));
  f = max(f, uCamCloud * 0.92);   // inside cloud: visibility collapses, which also hides the cheap-shadow switch
#ifdef LOWQ
  // the low tier cannot afford a full scattering integral per surface pixel
  vec3 fogc = (uHorizon * 0.92 + uSkyAmb * 0.30) * (1.0 - 0.25 * max(dn.y, 0.0));
#else
  vec3 fogc = skyRad(normalize(vec3(dn.x, max(dn.y, 0.0) + 0.015, dn.z)));
#endif
  return mix(col, fogc, f);
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
  float cs = dot(d, uSunDir);
  float sam = uSunDir.y > 0.0 ? airMass(uSunDir.y) : 60.0;
  vec3 sT = exp(-(BR * 8000.0 + vec3(BMIE * 1320.0)) * sam);
  c += sT * 60.0 * smoothstep(0.99988, 0.99996, cs) * step(0.0, uSunDir.y);
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
  if (rain > 0.02 && dist < 80.0){
    float rp = ripple(P * 2.6, uTime) + ripple(P * 3.7 + 11.0, uTime * 1.2);
    vec2 g = vec2(ripple(P * 2.6 + vec2(0.02, 0.0), uTime) - ripple(P * 2.6 - vec2(0.02, 0.0), uTime), ripple(P * 2.6 + vec2(0.0, 0.02), uTime) - ripple(P * 2.6 - vec2(0.0, 0.02), uTime));
    Nw = normalize(mix(N, normalize(N + vec3(g.x, 0.0, g.y) * 1.5), pm * clamp(rain * 3.0, 0.0, 1.0) * (1.0 - dist / 80.0)));
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
  if (sf.g > 0.02 && dist < 120.0){
    vec2 P = vWorld.xz * 2.2;
    g += vec2(ripple(P + vec2(0.02, 0.0), uTime) - ripple(P - vec2(0.02, 0.0), uTime), ripple(P + vec2(0.0, 0.02), uTime) - ripple(P - vec2(0.0, 0.02), uTime)) * 1.3 * clamp(sf.g * 3.0, 0.0, 1.0) * (1.0 - dist / 120.0);
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
    vec3 tp = vec3(c.x, gh + 8.0, c.y);
    vec4 ts = sampleCloud(tp + uSunDir * (2400.0 / max(uSunDir.y, 0.2)));
    cs = exp(-(ts.r * 2.6 + ts.g * 1.1));
    vec4 vs = sampleCloud(vec3(c.x, 4200.0, c.y));
    sv = mix(0.2, 1.0, exp(-(vs.r * 1.9 + vs.g * 0.9)));
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
  vec3 col = vCol * (vSun * (0.15 + 0.85 * ndl) * step(0.0, uSunDir.y) + amb * 1.1);
  if (uFlashOn > 0.5) col += flashLight(vW, N) * vCol * 0.9;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
  ao = ao;
}`;

// ---------------------------------------------------------------------------------------------
// Precipitation. Two layers:
//   * particles  - individual motion-blurred streaks within ~60 m of the camera (rain or snow)
//   * curtains   - one billboard per precipitation column, drawn as a scrolling veil that hangs
//                  from the cloud base to the ground; this is what makes a shower read as a shaft
// ---------------------------------------------------------------------------------------------
export const rainVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
uniform float uSnowLevel;
varying float vAlpha; varying vec2 vQ; varying vec3 vCol; varying float vDist; varying float vFlake;
void main(){
  vec3 size = vec3(86.0, 48.0, 86.0);
  vec3 seed = aSeed * size;
  float rnd = fract(aSeed.x * 91.7 + aSeed.y * 37.3 + aSeed.z * 13.1);
  float rnd2 = fract(aSeed.y * 51.3 + aSeed.z * 17.9 + aSeed.x * 7.1);
  vec3 rel0 = mod(seed - cameraPosition + size * 0.5, size) - size * 0.5;
  // above the snow level the same particles fall slowly and drift like flakes
  float flake = smoothstep(uSnowLevel - 250.0, uSnowLevel + 500.0, cameraPosition.y + rel0.y);
  float fall = mix(6.2 + rnd * 3.8, 1.2 + rnd * 1.0, flake);
  vec3 vel = vec3(uWind.x * mix(1.1, 1.6, flake), -fall, uWind.y * mix(1.1, 1.6, flake));
  vec3 rel = mod(seed + vel * uTime - cameraPosition + size * 0.5, size) - size * 0.5;
  float dist = length(rel);
  if (dist > 56.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // beyond the particle layer
  vec3 p = cameraPosition + rel;
  vec4 s = sampleCloud(p);
  if (s.g < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float inten = pow(s.g, 0.7);
  if (mix(rnd, rnd2, flake) > inten) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (p.y < 1400.0 && p.y < groundH(p.xz) + 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // streak geometry: heavy drops draw long thin streaks, flakes are short and wide
  float len = mix(0.8 + 2.4 * rnd, 0.20 + 0.10 * rnd, flake) * (1.0 + clamp(dist * 0.03, 0.0, 2.0));
  float wid = mix(0.005 + 0.004 * rnd, 0.018 + 0.012 * rnd, flake) + dist * 0.00055;
  vec3 dirV = normalize(vel);
  vec3 center = p - dirV * len * 0.5;
  vec3 toCam = normalize(cameraPosition - center);
  vec3 side = normalize(cross(dirV, toCam) + vec3(1e-5));
  vec3 wp = center + dirV * (position.y * len) + side * (position.x * wid * 2.0);
  vQ = position.xy * 2.0;
  vDist = dist;
  vFlake = flake;
  // forward scattering: drops light up when the sun is behind them
  float fwd = pow(max(dot(-toCam, uSunDir), 0.0), 8.0);
  vec3 col = uSkyAmb * 1.15 + uSunCol * (0.12 + 0.7 * fwd) + uGroundAmb * 0.45 + vec3(0.02);
  if (uFlashOn > 0.5) col += flashLight(p, vec3(0.0, 0.0, 1.0)) * 0.9;
  vCol = mix(col, col * vec3(1.05, 1.05, 1.1) + vec3(0.05), flake);
  vAlpha = smoothstep(0.35, 1.5, dist) * (1.0 - smoothstep(34.0, 56.0, dist)) * mix(0.72, 0.4, flake);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
export const rainFrag = /* glsl */ `
varying float vAlpha; varying vec2 vQ; varying vec3 vCol; varying float vDist; varying float vFlake;
void main(){
  // capsule mask: fade the streak ends, round the cross-section
  float along = abs(vQ.y);
  float across = abs(vQ.x);
  float capsule = (1.0 - smoothstep(0.45, 1.0, along)) * (1.0 - smoothstep(0.15, 1.0, across));
  float a = vAlpha * capsule;
  if (a < 0.003) discard;
  a *= mix(1.0, 0.5, smoothstep(8.0, 55.0, vDist));   // distant drops blur into a veil
  gl_FragColor = vec4(vCol, a);
}`;

export const splashVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol; varying float vDist;
void main(){
  vec2 size = vec2(70.0);
  vec2 rel = mod(aSeed.xy * size - cameraPosition.xz + size * 0.5, size) - size * 0.5;
  float rdist = length(rel);
  if (rdist > 48.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 xz = cameraPosition.xz + rel;
  float gh = groundH(xz);
  vec4 s = sampleCloud(vec3(xz.x, max(gh, 0.0) + 40.0, xz.y));
  float inten = pow(s.g, 0.75);
  float ph = fract(uTime * 1.9 + aSeed.z * 13.0);
  float vis = step(fract(aSeed.z * 37.7), inten * 0.9) * step(0.004, s.g) * step(0.0, gh);
  float r = 0.04 + 0.19 * ph;
  vec3 wp = vec3(xz.x + position.x * 2.0 * r, gh + 0.03, xz.y + position.y * 2.0 * r);
  vPh = ph; vP = position.xy * 2.0;
  vDist = length(rel);
  vVis = vis * (1.0 - smoothstep(26.0, 48.0, vDist));
  vCol = (uSkyAmb * 0.85 + uSunCol * 0.3 + vec3(0.01)) * 1.3;
  if (uFlashOn > 0.5) vCol += flashLight(wp, vec3(0.0, 1.0, 0.0)) * 0.6;
  gl_Position = vis > 0.5 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
export const splashFrag = /* glsl */ `
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol; varying float vDist;
void main(){
  float rr = length(vP);
  // expanding crown ring plus the fine mist kicked up around it
  float ring = smoothstep(0.55, 0.78, rr) * (1.0 - smoothstep(0.78, 1.0, rr));
  float mist = (1.0 - smoothstep(0.0, 0.95, rr)) * 0.12;
  float a = (ring * 0.34 + mist) * (1.0 - vPh) * (1.0 - vPh) * 0.85 * vVis;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}`;

// ---------------------------------------------------------------------------------------------
// Rain curtains. One cylindrical billboard per precipitation column, hanging from the cloud base
// down to the ground, slanted by the wind shear it falls through. The veil is textured with
// strongly anisotropic noise that scrolls downward, so it reads as falling sheets of water
// rather than a flat grey card. Near the camera the curtains fade out (particles take over).
// ---------------------------------------------------------------------------------------------
export const shaftVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec4 aCol;      // x, z, seed, unused
attribute vec2 aCorner;   // 0..1 across the quad
uniform sampler2D uSurf;  // .g = rain rate (0..1)
uniform vec2 uShaftWind;
uniform float uSnowLevel;
varying float vRain; varying float vU; varying float vV; varying float vSeed; varying float vSnow;
varying vec3 vCol; varying float vDist; varying vec2 vWorld;
void main(){
  vec2 xz = aCol.xy;
  float rain = texture(uSurf, xz / uDomain).g;
  vRain = 0.0; vU = 0.0; vV = 0.5; vSeed = aCol.z; vSnow = 0.0; vCol = vec3(0.0); vDist = 0.0; vWorld = vec2(0.0);
  if (rain <= 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float seed = aCol.z;
  // cloud base: walk up the column until the precipitation field appears
  float top = 3800.0;
  for (int i = 0; i < 6; i++){
    float h = 400.0 + float(i) * 1150.0;
    if (sampleCloud(vec3(xz.x, h, xz.y)).g > 0.03) { top = h + 900.0; break; }
  }
  float gy = groundH(xz);
  float depth = max(top - gy, 300.0);
  vec3 p = vec3(xz.x, mix(gy + 20.0, top, aCorner.y), xz.y);
  // slant with the wind shear of the layer it falls through
  float fall = (top - p.y) * 0.00042;
  p.x += uShaftWind.x * fall * 220.0;
  p.z += uShaftWind.y * fall * 220.0;
  float width = mix(150.0, 760.0, pow(aCorner.y, 1.4)) * (0.6 + 0.8 * fract(seed * 13.7)) + depth * 0.06;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5));
  p += right * (aCorner.x - 0.5) * width;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vRain = smoothstep(0.02, 0.6, rain);
  vU = aCorner.y;
  vV = aCorner.x * 2.0 - 1.0;
  vSeed = seed;
  vWorld = vec2(p.x, p.z);
  vSnow = smoothstep(uSnowLevel - 300.0, uSnowLevel + 800.0, mix(gy, top, aCorner.y));
  vDist = length(cameraPosition - p);
  vCol = uSkyAmb * 0.8 + uSunCol * 0.26 + uGroundAmb * 0.35 + vec3(0.012);
}`;
export const shaftFrag = /* glsl */ `
${COMMON}
varying float vRain; varying float vU; varying float vV; varying float vSeed; varying float vSnow;
varying vec3 vCol; varying float vDist; varying vec2 vWorld;
void main(){
  if (vRain < 0.01) discard;
  // soft horizontal edges: never let the card outline show
  float edge = 1.0 - smoothstep(0.25, 1.0, abs(vV));
  if (edge < 0.01) discard;
  // falling sheets: two octaves of vertically stretched noise scrolling downward
  float fall = uTime * 34.0;
  float n1 = vnoise2(vec2(vWorld.x * 0.020 + vWorld.y * 0.011 + vSeed * 17.0, (vU * 900.0 - fall) * 0.014));
  float n2 = vnoise2(vec2(vWorld.x * 0.055 - vWorld.y * 0.031 + vSeed * 41.0, (vU * 900.0 - fall * 1.6) * 0.035));
  float streak = 0.22 + 1.05 * (n1 * 0.55 + n2 * 0.45);
  // taper: wispy where it leaves the cloud, denser and wider at the ground
  float topFade = smoothstep(1.0, 0.55, vU);
  float botFade = smoothstep(0.0, 0.09, vU);
  float body = pow(vU, 0.35);
  float a = vRain * streak * edge * topFade * botFade * mix(0.52, 0.95, vU) * (0.5 + 0.5 * body);
  // distance handling: fade in past the particle range, fade out with aerial perspective
  a *= smoothstep(220.0, 900.0, vDist);
  a *= 1.0 - smoothstep(9000.0, 20000.0, vDist);
  if (a < 0.004) discard;
  // rain reads darker than the sky it hangs in; snow reads brighter
  // the veil is lit by the sky it sits under, not by the (often black) ground below it
  vec3 rainCol = (uSkyAmb * 1.05 + uSunCol * 0.24 + vec3(0.01)) * vec3(0.74, 0.79, 0.9);
  vec3 snowCol = (uSkyAmb * 1.1 + uSunCol * 0.4 + vec3(0.02)) * vec3(1.06, 1.06, 1.1);
  vec3 col = mix(rainCol, snowCol, vSnow);
  // backlit veil glows toward the sun, shaded veil darkens
  float cs = dot(normalize(vec3(vWorld.x, 0.0, vWorld.y) - cameraPosition), uSunDir);
  col *= 1.0 + 0.55 * pow(max(cs, 0.0), 4.0);
  if (uFlashOn > 0.5) col += flashLight(vec3(vWorld.x, 300.0, vWorld.y), vec3(0.0, 1.0, 0.0)) * 0.5;
  gl_FragColor = vec4(col, a);
}`;

export const boltVert = /* glsl */ `
attribute vec3 aA; attribute vec3 aB; attribute vec4 aS; attribute vec2 aCorner;
uniform float uT; uniform float uStep; uniform float uRS; uniform float uN;
uniform float uStrokeT[8]; uniform float uStrokeA[8];
uniform float uCCEnd; uniform float uCCAmp; uniform float uLeaderEnd;
varying float vLum; varying float vSide; varying float vOrder;
void main(){
  vec3 p = mix(aA, aB, aCorner.x);
  vec3 dir = normalize(aB - aA + vec3(1e-4));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-5));
  float dist = length(cameraPosition - p);
  float tGen = aS.x * uStep;                 // this segment appears when the leader reaches it
  float ord = pow(0.66, aS.z);
  float lum = 0.0;
  // stepped-leader glow while the channel grows
  if (uT > tGen){ float age = uT - tGen; lum += 0.55 * exp(-age / 0.004) + 0.045 * exp(-age / 0.09); }
  // return strokes / K-changes travelling up the channel
  for (int i = 0; i < 8; i++){
    if (float(i) >= uN) break;
    float tr = uStrokeT[i] + aS.y * uRS;
    if (uT > tr){ float age = uT - tr; lum += uStrokeA[i] * ord * (exp(-age / 0.010) + 0.3 * exp(-age / 0.075)); }
  }
  if (uT > uStrokeT[0] && uT < uCCEnd) lum += uCCAmp * ord;   // continuing current
  if (uT > uLeaderEnd) lum += 0.035 * ord * exp(-(uT - uLeaderEnd) / 0.4);
  vLum = lum;
  vOrder = aS.z;
  float w = (0.55 + 1.7 * sqrt(lum)) * aS.w * 1.15 + dist * 0.0011;
  vSide = aCorner.y;
  vec3 wp = p + side * aCorner.y * w * 3.0;
  gl_Position = (lum < 0.003) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
export const boltFrag = /* glsl */ `
varying float vLum; varying float vSide; varying float vOrder;
void main(){
  float s = abs(vSide);
  float core = exp(-s * s * 15.0);
  float glow = exp(-s * s * 2.0);
  float outer = exp(-s * s * 0.7);
  vec3 hot = vec3(0.92, 0.95, 1.0);
  vec3 cold = vec3(0.45, 0.62, 1.0);
  vec3 c = (hot * core * 24.0 + mix(cold, hot, core) * glow * 5.5 + cold * outer * 1.1) * vLum;
  c *= mix(1.0, 0.75, clamp(vOrder / 3.0, 0.0, 1.0));   // thin branches are dimmer
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
uniform vec2 uWindOff[16];
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

// 1 cloud + 2 noise fetches instead of 6: the shape/warp share one volume fetch, and two
// octaves of erosion detail are enough to break up the 500 m simulation cells.
float cloudDensity(vec3 p, float t, out float rainD, out float iceF, bool detail){
  vec4 s = sampleCloud(p);
  rainD = s.g; iceF = s.b;
  float base = s.r;
  if (base < 0.004) return 0.0;
  vec2 wo = windOffAt(p.y);
  vec3 np = p + vec3(wo.x, uTime * 1.2, wo.y);
  vec4 nA = texture(uNoise, np / 5200.0);
  // domain warp from the worley channels: stops the 500 m solver cells reading as a grid
  vec2 warp = (nA.gb - 0.5) * 1300.0;
  vec3 np2 = np + vec3(warp.x, 0.0, warp.y);
  float shape = base * (0.40 + 0.92 * nA.r + 0.26 * nA.g);
  if (!detail) return clamp(shape, 0.0, 1.0);
  vec4 nB = texture(uNoise, np2 / 700.0);
  shape *= 0.80 + 0.40 * nB.r;   // mid-scale billows break up the base cells
  float fine = nB.b;
  // the finest octave only pays for itself close to the camera, where it is visible
  if (t < 3400.0) fine = fine * 0.70 + texture(uNoise, np2 / 240.0).a * 0.30;
  float edge = 1.0 - smoothstep(0.22, 0.95, base);
  float erode = (1.0 - fine) * (0.30 + 0.44 * edge);
  return clamp((shape - erode) / (1.0 - erode + 1e-3), 0.0, 1.0);
}

float sunTau(vec3 p){
  float tau = 0.0; float st = 150.0; vec3 q = p;
  for (int j = 0; j < 4; j++){
    q += uSunDir * st;
    if (q.y > 15000.0) break;
    vec4 s = sampleCloud(q);
    tau += (s.r * 1.05 + s.g * 0.28) * 0.058 * st;
    st *= 2.5;
  }
  return tau;
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
  float t1 = 45000.0;
  if (rd.y > 1e-4) t1 = min(t1, (15000.0 - ro.y) / rd.y);
  else if (rd.y < -1e-4) t1 = min(t1, max(0.0, -ro.y / rd.y));
  t1 = min(t1, tTer);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * uFrame, vec2(0.06711056, 0.00583715))));
  float cosT = dot(rd, uSunDir);
  vec3 L = vec3(0.0); float T = 1.0; float tHit = -1.0;
  float tSum = 0.0, wSum = 0.0;
  float t = 60.0 * jitter * uStepScale;
  // ---- coarse entry search: hop over the clear air before the condensate (<=9 cheap fetches)
  if (uCamCloud < 0.35){
    float cstep = clamp(t1 * 0.09, 260.0, 1700.0) * uStepScale;
    for (int i = 0; i < 9; i++){
      if (t + cstep * 1.5 >= t1) break;
      vec3 pc = ro + rd * t;
      if (pc.y > 15200.0) { t = t1; break; }
      vec4 sc0 = sampleCloud(pc);
      if (sc0.r > 0.006 || sc0.g > 0.012) break;
      t += cstep;
    }
  }
  float tauC = 0.0;
  // Engulfed by cloud: the beam is extinguished within a few hundred metres, so the
  // remaining step budget is wasted work. Halve it.
  float maxSteps = uMaxSteps * (1.0 - 0.5 * uCamCloud);
  for (int i = 0; i < CLOUD_STEPS; i++){
    if (float(i) >= maxSteps || t > t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float stepLen = clamp(0.045 * t + 55.0, 55.0, 1200.0) * uStepScale;
    // vary the step length per pixel *and* per frame: breaks slice banding without a fixed pattern
    stepLen *= 0.96 + 0.08 * hash12(gl_FragCoord.xy + vec2(float(i) * 1.37, uFrame * 3.11));
    // optically thick cloud does not need fine steps: grow them as the beam is extinguished
    stepLen *= mix(1.0, 2.6, 1.0 - T);
    float rainD, iceF;
    float d = cloudDensity(p, t, rainD, iceF, DETAIL_ON);
    float rainFade = smoothstep(120.0, 700.0, t);
    float sc = d * 0.085;
#ifdef LOWQ
    float sr = rainD * 0.0055 * rainFade * 0.95;
#else
    float sr = rainD * 0.0055 * rainFade * (0.55 + 0.9 * hash12(vec2(p.x * 0.012 + p.z * 0.007, p.y * 0.0015)));
#endif
    float sig = sc + sr;
    if (sig > 1e-5){
      if (i % 4 == 0) tauC = sunTau(p);
      float tau = tauC;
      // 4 octaves of a Henyey-Greenstein phase function: a cheap multiple-scattering
      // approximation. Without it thick cloud cores go black instead of glowing grey.
      // The phase is evaluated once per step (the anisotropy barely changes per octave).
      float ph = phase(cosT, 1.0);
      vec3 sunL = vec3(0.0); float a = 1.0, b = 1.0;
      for (int o = 0; o < 3; o++){ sunL += a * exp(-tau * b) * ph; a *= 0.46; b *= 0.38; }
      sunL *= 0.60;
      float powder = mix(1.0, 1.0 - 0.72 * exp(-d * 8.0), 0.8 * (1.0 - smoothstep(0.15, 0.85, cosT)));
      float cT = max(cosT, 0.0), cT2 = cT * cT, cT4 = cT2 * cT2;
      float silver = cT4 * cT4 * cT2 * (1.0 - smoothstep(0.05, 0.5, d));
      float hF = clamp(p.y / 9000.0, 0.0, 1.0);
      // one-tap vertical occlusion: how much cloud sits above this sample
      float aoU = 1.0;
      if (d > 0.03 && (i & 1) == 0) aoU = exp(-sampleCloud(p + vec3(0.0, 1100.0, 0.0)).r * 1.7);
      float hDark = mix(0.52, 1.0, smoothstep(0.03, 0.38, hF));
      vec3 amb = mix(uGroundAmb * 0.6, uSkyAmb, smoothstep(0.0, 0.75, hF));
      amb *= (0.16 + 0.84 * aoU) * (0.72 + 0.48 * d) * hDark;
      // light that has bounced around inside the cloud: lifts the core without flattening edges
      amb += uSunCol * sunL * (0.05 + 0.13 * d) * mix(0.35, 1.0, hF);
      vec3 fl = uFlashOn > 0.5 ? flashLight(p, vec3(0.0, 1.0, 0.0)) : vec3(0.0);
      vec3 iceTint = mix(vec3(1.0), vec3(0.95, 0.97, 1.06), iceF);
      vec3 Sc = (uSunCol * sunL * (0.6 + 0.6 * silver) * powder + amb + fl * 0.14) * iceTint;
      vec3 Sr = (uSunCol * 0.09 * sunL + amb * 0.8 + fl * 0.1) * vec3(0.78, 0.84, 0.94);
      vec3 S = (sc * Sc + sr * Sr) / sig;
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
  float tMean = wSum > 1e-4 ? tSum / wSum : 45000.0;
  float dist = tHit > 0.0 ? tHit : min(t1, 45000.0);
  float fogF = 1.0 - exp(-dist / (uVis * 2.2));   // storms stay readable from many km away
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
  float b2 = uBlend * valid * (1.0 - smoothstep(0.2, 0.5, abs(hist.a - T)));
  float rel = abs(histD - tMean) / max(min(histD, tMean), 200.0);
  b2 *= 1.0 - smoothstep(0.3, 0.9, rel);
  b2 *= 1.0 - 0.9 * uCamCloud;   // inside cloud: trust the (cheap, short) current march
  outColor = mix(vec4(L, T), hist, b2);
  outAux = vec4(tMean, T, 0.0, 1.0);
}
`;

export const compFrag = /* glsl */ `
uniform sampler2D uScene; uniform sampler2D uCloudRT; uniform sampler2D uCloudAux;
uniform float uExposure; uniform float uTime; uniform vec2 uRes; uniform vec2 uCloudRes;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// Edge-aware upsample of the reduced-resolution cloud buffer. A plain bilinear fetch
// smears cloud edges into blocky steps; weighting the 4 neighbours by scattering-depth
// similarity keeps the silhouette crisp without ringing.
const vec2 CLOUD_OFF[8] = vec2[8](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(2.0, 0.0), vec2(-2.0, 0.0), vec2(0.0, 2.0), vec2(0.0, -2.0)
);
const float CLOUD_W[8] = float[8](1.0, 1.0, 1.0, 1.0, 0.55, 0.55, 0.55, 0.55);
vec4 cloudSample(vec2 uv){
  vec2 tx = 1.0 / uCloudRes;
  vec4 c0 = texture(uCloudRT, uv);
  float d0 = texture(uCloudAux, uv).r;
  vec4 acc = c0 * 2.0;
  float wsum = 2.0;
  for (int i = 0; i < 8; i++){
    vec4 c = texture(uCloudRT, uv + CLOUD_OFF[i] * tx);
    float d = texture(uCloudAux, uv + CLOUD_OFF[i] * tx).r;
    // depth similarity keeps the silhouette crisp; transmittance jump rejects cloud/sky bleed
    float w = CLOUD_W[i] / (1.0 + pow(abs(d - d0) / max(120.0, 0.06 * d0), 2.0));
    w *= 1.0 - 0.75 * smoothstep(0.12, 0.5, abs(c.a - c0.a));
    acc += c * w; wsum += w;
  }
  return acc / wsum;
}

void main(){
  vec3 scene = texture(uScene, vUv).rgb;
  vec4 c = cloudSample(vUv);
  vec3 col = scene * c.a + c.rgb;
  col *= uExposure;
  col = aces(col);
  float vg = 1.0 - 0.28 * pow(length(vUv - 0.5) * 1.35, 2.2);
  col *= vg;
  col = pow(col, vec3(1.0 / 2.2));
  float n = fract(sin(dot(vUv * uRes + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
