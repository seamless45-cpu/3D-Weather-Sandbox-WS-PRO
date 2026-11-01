// All GLSL (ES 3.00 via three.js ShaderMaterial). Written without implicit int->float conversions.
export const COMMON = /* glsl */ `
#define PI 3.14159265
uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyAmb; uniform vec3 uHorizon; uniform vec3 uGroundAmb;
uniform float uTwilight; uniform float uDomain; uniform float uVis; uniform float uSkyScale;
uniform sampler3D uCloud;
uniform vec4 uFlash[6]; uniform vec3 uFlashCol;
uniform vec2 uWind;
const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float BMIE = 21e-6;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise2(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1.0,0.0)), f.x), mix(hash12(i+vec2(0.0,1.0)), hash12(i+vec2(1.0,1.0)), f.x), f.y);
}
float airMass(float cy){ cy = max(cy, 0.0); float zen = degrees(acos(min(cy, 1.0))); return 1.0 / (cy + 0.15 * pow(max(93.885 - zen, 1.0), -1.253)); }

vec3 skyRad(vec3 dir){
  float cy = max(dir.y, 0.0);
  float am = airMass(cy);
  float cs = dot(dir, uSunDir);
  float phR = 3.0 / (16.0 * PI) * (1.0 + cs*cs);
  float g = 0.76;
  float phM = (1.0 - g*g) / (4.0 * PI * pow(max(1.0 + g*g - 2.0*g*cs, 1e-3), 1.5));
  float sam = uSunDir.y > 0.0 ? airMass(uSunDir.y) : 40.0 + (-uSunDir.y) * 400.0;
  vec3 sT = exp(-(BR * 8000.0 + vec3(BMIE * 1320.0)) * sam);
  vec3 tau = (BR * 8000.0 + vec3(BMIE * 1320.0 * 1.1)) * am;
  vec3 fex = exp(-tau);
  vec3 bt = BR + vec3(BMIE * 1.1);
  vec3 insc = (BR * phR + vec3(BMIE * 1.1 * phM)) / bt * (1.0 - fex);
  vec3 st = pow(sT, vec3(1.0 - 0.5 * min(1.0, cy * 2.0)));
  vec3 L = uSkyScale * insc * st;
  L += vec3(0.0025, 0.0045, 0.012);
  L += uTwilight * vec3(0.55, 0.28, 0.2) * 0.35 * exp(-cy * 5.0) * (0.25 + 0.75 * pow(max(cs, 0.0), 2.0));
  return L;
}

vec4 sampleCloud(vec3 p){ return texture(uCloud, vec3(p.x / uDomain, p.z / uDomain, clamp(p.y / 15000.0, 0.0, 1.0))); }

// transmittance of direct sunlight through the simulated condensate (moving cloud shadows)
float cloudSunTrans(vec3 p){
  if (uSunDir.y < 0.02) return 1.0;
  float tau = 0.0;
  for (int i = 0; i < 7; i++){
    float alt = 600.0 + float(i) * 1700.0;
    if (alt <= p.y) continue;
    vec3 q = p + uSunDir * ((alt - p.y) / uSunDir.y);
    vec4 s = sampleCloud(q);
    tau += (s.r * 0.8 + s.g * 0.5) * 1700.0 * 0.016 / max(uSunDir.y, 0.15);
  }
  return exp(-tau);
}
// sky-dome visibility (ambient dimming beneath thick cloud decks / anvils)
float skyVisibility(vec3 p){
  float tau = 0.0;
  for (int i = 0; i < 4; i++){
    float alt = 1000.0 + float(i) * 3000.0;
    vec4 s = sampleCloud(vec3(p.x, alt, p.z));
    tau += (s.r * 0.8 + s.g * 0.5) * 3000.0 * 0.0045;
  }
  return mix(0.2, 1.0, exp(-tau * 0.5));
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
  vec3 fogc = skyRad(normalize(vec3(dn.x, max(dn.y, 0.0) + 0.015, dn.z)));
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
  for (int i = 1; i <= 9; i++){
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
  float n1 = vnoise2(P * 0.12), n2 = vnoise2(P * 0.9), n3 = vnoise2(P * 6.0), n0 = vnoise2(P * 0.012);
  float fade = 1.0 - smoothstep(40.0, 350.0, dist);
  vec3 grass = mix(vec3(0.085, 0.12, 0.032), vec3(0.15, 0.18, 0.05), n1) * (0.82 + 0.35 * n2) * (0.9 + 0.2 * n3 * fade);
  grass = mix(grass, vec3(0.28, 0.25, 0.1), smoothstep(0.55, 0.9, n0) * 0.45);
  vec3 forest = vec3(0.045, 0.075, 0.03) * (0.75 + 0.5 * n2);
  vec3 rock = vec3(0.26, 0.24, 0.21) * (0.7 + 0.6 * n2) * (0.9 + 0.2 * n3 * fade);
  vec3 alb = grass * cl.b + forest * cl.r + rock * cl.g;
  alb = mix(alb, vec3(0.1, 0.085, 0.06), cl.a);
  // bump from detail noise
  float bs = 1.6 * fade;
  vec2 gdet = vec2(vnoise2(P * 2.3 + vec2(0.3, 0.0)) - vnoise2(P * 2.3 - vec2(0.3, 0.0)), vnoise2(P * 2.3 + vec2(0.0, 0.3)) - vnoise2(P * 2.3 - vec2(0.0, 0.3)));
  N = normalize(N + vec3(gdet.x, 0.0, gdet.y) * 0.25 * bs);
  float rain = sf.g, pud = sf.b;
  float wet = clamp(pud * 1.4 + rain * 0.7, 0.0, 1.0);
  float pm = smoothstep(0.3, 0.75, pud * 1.6 + n1 * 0.35 - 0.2) * smoothstep(0.35, 0.9, N.y) * (1.0 - cl.a);
  alb *= 1.0 - 0.45 * wet;
  vec3 Nw = N;
  if (rain > 0.02 && dist < 80.0){
    float rp = ripple(P * 2.6, uTime) + ripple(P * 3.7 + 11.0, uTime * 1.2);
    vec2 g = vec2(ripple(P * 2.6 + vec2(0.02, 0.0), uTime) - ripple(P * 2.6 - vec2(0.02, 0.0), uTime), ripple(P * 2.6 + vec2(0.0, 0.02), uTime) - ripple(P * 2.6 - vec2(0.0, 0.02), uTime));
    Nw = normalize(mix(N, normalize(N + vec3(g.x, 0.0, g.y) * 1.5), pm * clamp(rain * 3.0, 0.0, 1.0) * (1.0 - dist / 80.0)));
    alb *= 1.0 + rp * 0.05 * pm;
  }
  float ndl = max(dot(N, uSunDir), 0.0);
  float hs = heightShadow(vWorld);
  float cs = cloudSunTrans(vWorld);
  float sv = skyVisibility(vWorld);
  vec3 sun = uSunCol * ndl * hs * cs;
  vec3 amb = mix(uGroundAmb, uSkyAmb, 0.5 + 0.5 * N.y) * sv;
  vec3 col = alb * (sun + amb);
  // glossy wet surface / puddles
  vec3 Hh = normalize(V + uSunDir);
  float spec = pow(max(dot(Nw, Hh), 0.0), 140.0) * (0.2 * wet + pm) * hs * cs * 3.0 * step(0.0, uSunDir.y);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);
  vec3 Rr = reflect(-V, Nw);
  vec3 refl = skyRad(vec3(Rr.x, abs(Rr.y), Rr.z)) * mix(0.35, 1.0, cs) * sv;
  col = mix(col, refl, clamp((pm * 0.85 + wet * 0.15) * fres * 1.6, 0.0, 0.9));
  col += uSunCol * spec;
  col += flashLight(vWorld, N) * alb * 0.9 + flashLight(vWorld, Nw) * pm * fres * 0.4;
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
  for (int i = 0; i < 4; i++){
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
  if (sf.g > 0.02 && dist < 120.0){
    vec2 P = vWorld.xz * 2.2;
    g += vec2(ripple(P + vec2(0.02, 0.0), uTime) - ripple(P - vec2(0.02, 0.0), uTime), ripple(P + vec2(0.0, 0.02), uTime) - ripple(P - vec2(0.0, 0.02), uTime)) * 1.3 * clamp(sf.g * 3.0, 0.0, 1.0) * (1.0 - dist / 120.0);
  }
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.002; R = normalize(R);
  vec3 sky = skyRad(R);
  // cheap cloud reflection: a few altitude slices of the simulated condensate
  float ca = 0.0;
  for (int i = 0; i < 5; i++){
    float alt = 1500.0 + float(i) * 2300.0;
    vec3 q = vWorld + R * (alt / R.y);
    vec4 s = sampleCloud(q);
    ca += s.r * 0.35 + s.g * 0.15;
  }
  ca = 1.0 - exp(-ca * 1.5);
  vec3 cloudCol = (uSunCol * 0.35 + uSkyAmb * 1.5 + vec3(0.02)) * 0.8;
  vec3 refl = mix(sky, cloudCol, ca);
  float cs = cloudSunTrans(vec3(vWorld.x, 0.0, vWorld.z));
  float sv = skyVisibility(vec3(vWorld.x, 0.0, vWorld.z));
  vec3 deep = vec3(0.012, 0.05, 0.065) * (uSunCol * 0.35 * cs + uSkyAmb * 1.4 * sv + vec3(0.01));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 col = mix(deep, refl, fres);
  vec3 Hh = normalize(V + uSunDir);
  col += uSunCol * pow(max(dot(N, Hh), 0.0), 400.0) * 8.0 * cs * step(0.0, uSunDir.y);
  col += flashLight(vWorld, N) * deep * 2.0 + flashLight(vWorld, N) * fres * 0.25;
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
  float gh = groundH(c);
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
  float cs = cloudSunTrans(vec3(c.x, gh + 8.0, c.y));
  vSun = uSunCol * cs;
  vSV = skyVisibility(vec3(c.x, gh, c.y));
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
  col += flashLight(vW, N) * vCol * 0.9;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
  ao = ao;
}`;

export const rainVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
varying float vAlpha; varying float vX; varying vec3 vCol;
void main(){
  vec3 size = vec3(110.0, 56.0, 110.0);
  float vt = 6.5;
  vec3 vel = vec3(uWind.x * 1.15, -vt, uWind.y * 1.15);
  vec3 seed = aSeed * size;
  vec3 rel = mod(seed + vel * uTime - cameraPosition + size * 0.5, size) - size * 0.5;
  vec3 p = cameraPosition + rel;
  vec4 s = sampleCloud(p);
  float inten = pow(s.g, 0.75);
  float rnd = fract(aSeed.x * 91.7 + aSeed.y * 37.3 + aSeed.z * 13.1);
  float vis = step(rnd, inten) * step(groundH(p.xz) + 0.1, p.y) * step(0.004, s.g);
  vec3 dirV = normalize(vel);
  float len = 0.75;
  vec3 center = p - dirV * len * 0.5;
  vec3 toCam = normalize(cameraPosition - center);
  vec3 side = normalize(cross(dirV, toCam));
  float dist = length(cameraPosition - center);
  float w = 0.005 + dist * 0.0009;
  vec3 wp = center + dirV * (position.y * len) + side * (position.x * w * 2.0);
  vAlpha = vis * 0.42 * smoothstep(0.6, 3.0, dist) * (1.0 - smoothstep(35.0, 55.0, dist));
  vX = position.x * 2.0;
  vCol = (uSkyAmb * 0.9 + uSunCol * 0.2 + vec3(0.01)) * 1.15 + flashLight(p, vec3(0.0, 1.0, 0.0)) * 0.6;
  gl_Position = vis > 0.5 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
export const rainFrag = /* glsl */ `
varying float vAlpha; varying float vX; varying vec3 vCol;
void main(){
  float a = vAlpha * (1.0 - smoothstep(0.4, 1.0, abs(vX)));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
}`;

export const splashVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol;
void main(){
  vec2 size = vec2(70.0);
  vec2 rel = mod(aSeed.xy * size - cameraPosition.xz + size * 0.5, size) - size * 0.5;
  vec2 xz = cameraPosition.xz + rel;
  float gh = groundH(xz);
  vec4 s = sampleCloud(vec3(xz.x, max(gh, 0.0) + 40.0, xz.y));
  float inten = pow(s.g, 0.75);
  float ph = fract(uTime * 1.9 + aSeed.z * 13.0);
  float vis = step(fract(aSeed.z * 37.7), inten * 0.9) * step(0.004, s.g) * step(0.0, gh);
  float r = 0.03 + 0.17 * ph;
  vec3 wp = vec3(xz.x + position.x * 2.0 * r, gh + 0.04, xz.y + position.y * 2.0 * r);
  vPh = ph; vP = position.xy * 2.0; vVis = vis * (1.0 - smoothstep(30.0, 55.0, length(rel)));
  vCol = (uSkyAmb * 0.9 + uSunCol * 0.2 + vec3(0.01)) * 1.4 + flashLight(wp, vec3(0.0, 1.0, 0.0)) * 0.6;
  gl_Position = vis > 0.5 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
export const splashFrag = /* glsl */ `
varying float vPh; varying vec2 vP; varying float vVis; varying vec3 vCol;
void main(){
  float rr = length(vP);
  float ring = smoothstep(0.55, 0.8, rr) * (1.0 - smoothstep(0.8, 1.0, rr));
  float a = ring * (1.0 - vPh) * 0.55 * vVis;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}`;

// ---------------------------------------------------------------------------------------------
// Rain shafts: one cylindrical billboard per precipitation column, from the ground up into the
// cloud base, slanted by the local wind and textured with falling streaks. This is what makes the
// precipitation read as a solid shaft instead of a sprinkle of particles.
// ---------------------------------------------------------------------------------------------
export const shaftVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec4 aCol;      // x, z, seed, unused
attribute vec2 aCorner;   // 0..1 across the quad
uniform sampler2D uSurf;  // .g = rain rate (0..1)
uniform vec2 uShaftWind;
uniform float uSnowLevel;
varying float vRain; varying float vU; varying float vSeed; varying float vSnow; varying vec3 vCol; varying float vDist;
void main(){
  vec2 xz = aCol.xy;
  float rain = texture(uSurf, xz / uDomain).g;
  vRain = 0.0; vU = 0.0; vSeed = aCol.z; vSnow = 0.0; vCol = vec3(0.0); vDist = 0.0;
  if (rain <= 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float seed = aCol.z;
  float top = 4200.0;
  // find the precipitation base by walking up the cloud texture
  for (int i = 0; i < 6; i++){
    float h = 350.0 + float(i) * 1150.0;
    if (sampleCloud(vec3(xz.x, h, xz.y)).g > 0.02) { top = h + 1200.0; break; }
  }
  float gy = groundH(xz);
  vec3 p = vec3(xz.x, mix(gy + 30.0, top, aCorner.y), xz.y);
  // slant with the wind shear of the layer it falls through
  float fall = (top - p.y) * 0.00042;
  p.x += uShaftWind.x * fall * 1000.0 * 0.22;
  p.z += uShaftWind.y * fall * 1000.0 * 0.22;
  float width = mix(200.0, 620.0, aCorner.y) * (0.55 + 0.9 * fract(seed * 13.7));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5));
  p += right * (aCorner.x - 0.5) * width;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vRain = smoothstep(0.004, 0.55, rain);
  vU = aCorner.y;
  vSeed = seed;
  vSnow = smoothstep(uSnowLevel - 200.0, uSnowLevel + 600.0, p.y);
  vDist = length(cameraPosition - p);
  vCol = uSkyAmb * 0.85 + uSunCol * 0.28 + vec3(0.015) + flashLight(p, vec3(0.0, 1.0, 0.0)) * 0.5;
}`;
export const shaftFrag = /* glsl */ `
${COMMON}
varying float vRain; varying float vU; varying float vSeed; varying float vSnow; varying vec3 vCol; varying float vDist;
void main(){
  if (vRain < 0.01) discard;
  float wob = vnoise2(vec2(vSeed * 31.0 + vU * 2.5, vU * 9.0 - uTime * 2.4));
  float streak = 0.45 + 0.75 * wob;
  float topFade = 1.0 - smoothstep(0.62, 1.0, vU);
  float botFade = smoothstep(0.0, 0.10, vU);
  float a = vRain * streak * topFade * botFade * 0.34;
  a *= mix(1.0, 0.75, vSnow);
  a *= 1.0 - smoothstep(9000.0, 16000.0, vDist);
  if (a < 0.004) discard;
  vec3 col = mix(vCol * vec3(0.78, 0.83, 0.92), vCol * vec3(1.05, 1.05, 1.08), vSnow);
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
uniform sampler3D uNoise; uniform sampler2D uDepth; uniform sampler2D uHist;
uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform mat4 uPrevVP; uniform vec3 uCamPos;
uniform float uFrame; uniform float uBlend; uniform float uStepScale; uniform vec2 uWindOff[16];
varying vec2 vUv;

vec2 windOffAt(float y){
  float f = clamp(y / 15000.0 * 16.0 - 0.5, 0.0, 15.0);
  int i0 = int(floor(f)); int i1 = min(i0 + 1, 15);
  return mix(uWindOff[i0], uWindOff[i1], f - float(i0));
}
float hg(float c, float g){ return (1.0 - g*g) / pow(max(1.0 + g*g - 2.0*g*c, 1e-3), 1.5); }
// two-lobe droplet phase function (strong forward peak + wide backscatter), tightened by k
float phase(float c, float k){ return 0.78 * hg(c, 0.72 * k) + 0.22 * hg(c, -0.18 * k); }

float cloudDensity(vec3 p, out float rainD, out float iceF, bool detail){
  vec4 s = sampleCloud(p);
  rainD = s.g; iceF = s.b;
  float base = s.r;
  if (base < 0.004) return 0.0;
  vec2 wo = windOffAt(p.y);
  vec3 np = p + vec3(wo.x, uTime * 1.2, wo.y);
  // billows: two-scale low frequency shape modulation with a slow domain warp
  float low = texture(uNoise, np / 5200.0).r;
  float warp = texture(uNoise, np * 0.00011 + vec3(0.37, 0.11, 0.73)).g;
  float shape = base * (0.42 + 0.86 * low + 0.24 * warp);
  if (!detail) return clamp(shape, 0.0, 1.0);
  // erode the edges: detail noise gets stronger where the field is weak (fractal edges, wispy bases)
  float f1 = texture(uNoise, np / 1550.0).g;
  float f2 = texture(uNoise, np / 640.0).b;
  float f3 = texture(uNoise, np / 250.0).a;
  float fine = f1 * 0.52 + f2 * 0.31 + f3 * 0.17;
  float edge = 1.0 - smoothstep(0.25, 0.95, base);
  float erode = (1.0 - fine) * (0.34 + 0.42 * edge);
  return clamp((shape - erode) / (1.0 - erode + 1e-3), 0.0, 1.0);
}

float sunTau(vec3 p){
  float tau = 0.0; float st = 70.0; vec3 q = p;
  for (int j = 0; j < 6; j++){
    q += uSunDir * st;
    if (q.y > 15000.0) break;
    vec4 s = sampleCloud(q);
    tau += (s.r * 1.05 + s.g * 0.28) * 0.058 * st;
    st *= 1.95;
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
  float t = 260.0 * jitter * uStepScale;   // dither the entry point so the march does not band
  float amb0 = 1.0;
  for (int i = 0; i < 112; i++){
    if (t > t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float stepLen = clamp(0.04 * t + 60.0, 60.0, 1100.0) * uStepScale;
    stepLen *= 0.62 + 0.76 * fract(sin(dot(vec2(gl_FragCoord.x, gl_FragCoord.y + float(i) * 1.37), vec2(12.9898, 78.233))) * 43758.5453);
    float rainD, iceF;
    float d = cloudDensity(p, rainD, iceF, true);
    float rainFade = smoothstep(120.0, 700.0, t);
    float sc = d * 0.085;
    float sr = rainD * 0.0055 * rainFade * (0.55 + 0.9 * vnoise2(vec2(p.x * 0.012 + p.z * 0.007, p.y * 0.0015)));
    float sig = sc + sr;
    if (sig > 1e-5){
      float tau = sunTau(p);
      vec3 sunL = vec3(0.0); float a = 1.0, b = 1.0, c = 1.0;
      for (int o = 0; o < 4; o++){ sunL += a * exp(-tau * b) * phase(cosT, c); a *= 0.46; b *= 0.38; c *= 0.62; }
      sunL *= 0.56;   // keep the multi-octave sum energy-normalised instead of blowing out to white
      float powder = mix(1.0, 1.0 - 0.72 * exp(-d * 8.0), 0.8 * (1.0 - smoothstep(0.15, 0.85, cosT)));
      float silver = pow(max(cosT, 0.0), 10.0) * (1.0 - smoothstep(0.05, 0.5, d));
      float hF = clamp(p.y / 9000.0, 0.0, 1.0);
      float up1 = sampleCloud(p + vec3(0.0, 600.0, 0.0)).r;
      float up2 = sampleCloud(p + vec3(0.0, 1900.0, 0.0)).r;
      float up3 = sampleCloud(p + vec3(0.0, 3800.0, 0.0)).r;
      float aoU = exp(-(up1 * 1.15 + up2 * 0.55 + up3 * 0.25));
      float hDark = mix(0.58, 1.0, smoothstep(0.04, 0.40, hF));   // cloud bases read darker than sunlit tops
      vec3 amb = mix(uGroundAmb * 0.55, uSkyAmb, smoothstep(0.0, 0.7, hF)) * (0.15 + 0.85 * aoU) * (0.7 + 0.5 * d) * hDark;
      vec3 fl = flashLight(p, vec3(0.0, 1.0, 0.0));
      vec3 iceTint = mix(vec3(1.0), vec3(0.95, 0.97, 1.06), iceF);
      vec3 Sc = (uSunCol * sunL * (0.6 + 0.6 * silver) * powder + amb + fl * 0.14) * iceTint;
      vec3 Sr = (uSunCol * 0.09 * sunL + amb * 0.8 + fl * 0.1) * vec3(0.78, 0.84, 0.94);
      vec3 S = (sc * Sc + sr * Sr) / sig;
      float Ts = exp(-sig * stepLen);
      L += T * (1.0 - Ts) * S;
      T *= Ts;
      if (tHit < 0.0 && T < 0.97) tHit = t;
      t += stepLen * 0.65;
    } else {
      t += stepLen;
    }
  }
  float dist = tHit > 0.0 ? tHit : min(t1, 45000.0);
  float fogF = 1.0 - exp(-dist / (uVis * 2.2));   // storms stay readable from many km away
  vec3 haze = mix(uHorizon, uSkyAmb, 0.55) * 0.85;   // air, not white fog
  L = L * (1.0 - fogF) + haze * fogF * (1.0 - T);
  vec4 cur = vec4(L, T);
  vec3 P = uCamPos + rd * 9000.0;
  vec4 pc = uPrevVP * vec4(P, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float valid = (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) ? 1.0 : 0.0;
  vec4 hist = texture(uHist, puv);
  float b2 = uBlend * valid * (1.0 - smoothstep(0.2, 0.5, abs(hist.a - T)));
  gl_FragColor = mix(cur, hist, b2);
}`;

export const compFrag = /* glsl */ `
uniform sampler2D uScene; uniform sampler2D uCloudRT; uniform float uExposure; uniform float uTime; uniform vec2 uRes;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  vec3 scene = texture(uScene, vUv).rgb;
  vec4 c = texture(uCloudRT, vUv);
  vec3 col = scene * c.a + c.rgb;
  col *= uExposure;
  col = aces(col);
  float vg = 1.0 - 0.28 * pow(length(vUv - 0.5) * 1.35, 2.2);
  col *= vg;
  col = pow(col, vec3(1.0 / 2.2));
  float n = fract(sin(dot(vUv * uRes + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;
