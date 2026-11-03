// Shaders for the solver-driven vortex, its debris cloud and the player-driven intercept vehicle.
// The funnel is a deformed cylinder (not a billboard): six helical filaments rotate around a
// pressure-scaled condensation column, with a separate near-ground debris/dust annulus.
import { COMMON, TERRAIN_FN } from './glsl';

export const funnelVert = /* glsl */ `
${COMMON}
uniform float uTop; uniform float uBottom; uniform float uRadius; uniform float uIntensity;
uniform float uDebris; uniform float uFunnelSeed;
varying float vH; varying float vA; varying float vN; varying vec3 vW; varying float vDust;
void main(){
  float h = clamp(position.y + 0.5, 0.0, 1.0);
  float a = uv.x * 2.0 * PI;
  // Condensation funnel is narrow at the ground and flares into the wall cloud. Helical
  // perturbations and a slow tilt keep it from looking like a static cone of revolution.
  float taper = mix(0.24, 1.0, pow(h, 0.62));
  float helix = sin(a * 3.0 - h * 13.0 - uTime * 5.1 + uFunnelSeed) * 0.10
              + sin(a * 5.0 + h * 19.0 + uTime * 3.3) * 0.045;
  float r = uRadius * taper * (1.0 + helix * (0.45 + 0.55 * uIntensity));
  float tilt = (h - 0.5) * uRadius * 0.22 * sin(uTime * 0.6 + uFunnelSeed);
  vec3 local = vec3(cos(a) * r + tilt, h - 0.5, sin(a) * r);
  vec4 wp = modelMatrix * vec4(local, 1.0);
  vW = wp.xyz; vH = h; vA = a;
  vN = 0.5 + 0.5 * sin(a * 4.0 - h * 16.0 - uTime * 4.2 + uFunnelSeed);
  vDust = (1.0 - smoothstep(0.02, 0.28, h)) * uDebris;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const funnelFrag = /* glsl */ `
${COMMON}
uniform float uIntensity; uniform float uDebris;
varying float vH; varying float vA; varying float vN; varying vec3 vW; varying float vDust;
void main(){
  // Facing ratio: a hollow cylinder needs limb darkening to read as a volume.
  float facing = abs(sin(vA + uTime * 1.7));
  float limb = 0.28 + 0.72 * pow(facing, 0.6);
  float filaments = 0.55 + 0.45 * vN;
  float condensation = smoothstep(0.06, 0.35, vH) * (1.0 - smoothstep(0.82, 1.0, vH));
  float wall = smoothstep(0.80, 0.98, vH) * 0.65;
  float a = (condensation * 0.62 + wall * 0.38) * limb * filaments * (0.35 + 0.65 * uIntensity);
  a += vDust * limb * (0.55 + 0.45 * filaments);
  if (a < 0.004) discard;
  vec3 grey = mix(uSkyAmb * 0.45 + uGroundAmb * 0.25, uSkyAmb * 0.85 + uSunCol * 0.22, vH);
  vec3 dust = mix(vec3(0.16, 0.13, 0.10), vec3(0.34, 0.28, 0.21), vN) * (uSkyAmb * 0.7 + uGroundAmb * 0.5);
  vec3 col = mix(grey, dust, clamp(vDust * 1.6, 0.0, 1.0));
  col += vec3(0.035) * pow(facing, 6.0) * (1.0 - vDust);
  if (uFlashOn > 0.5) col += flashLight(vW, normalize(vec3(cos(vA), 0.0, sin(vA)))) * 0.45;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.82));
}`;

export const debrisVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute vec3 aSeed;
uniform float uDebris;
varying float vA; varying float vS; varying vec3 vW; varying float vVis;
void main(){
  float s0 = aSeed.x, s1 = aSeed.y, s2 = aSeed.z;
  float ang = fract(s0 + uTime * (0.08 + 0.16 * s1)) * 2.0 * PI;
  float rad = uTornado.z * (0.4 + 2.6 * sqrt(s1));
  vec2 xz = uTornado.xy + vec2(cos(ang), sin(ang)) * rad;
  float gh = groundH(xz);
  float h = gh + 2.0 + (s2 * s2) * (25.0 + 95.0 * uDebris);
  vec3 wp = vec3(xz.x, h, xz.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = length(mv.xyz);
  float wind = uDebris * (0.5 + 0.5 * s0);
  gl_PointSize = clamp((2.0 + 7.0 * s1) * 1400.0 / max(dist, 1.0), 1.0, 16.0) * (0.55 + 0.45 * wind);
  vVis = uDebris * smoothstep(0.0, 1.0, dist / 40.0) * (1.0 - smoothstep(2500.0, 7000.0, dist));
  vA = ang; vS = s2; vW = wp;
  gl_Position = projectionMatrix * mv;
}`;

export const debrisFrag = /* glsl */ `
${COMMON}
varying float vA; varying float vS; varying vec3 vW; varying float vVis;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0 || vVis < 0.01) discard;
  float soft = 1.0 - smoothstep(0.25, 1.0, r);
  vec3 col = mix(vec3(0.12, 0.10, 0.08), vec3(0.34, 0.28, 0.21), vS) * (uSkyAmb * 0.8 + uGroundAmb * 0.5);
  col += uSunCol * 0.06 * max(0.0, 1.0 - r);
  gl_FragColor = vec4(col, soft * vVis * 0.55);
}`;

export const vehicleVert = /* glsl */ `
${COMMON}
attribute vec3 aColor;
varying vec3 vN; varying vec3 vW; varying vec3 vCol;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = aColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const vehicleFrag = /* glsl */ `
${COMMON}
varying vec3 vN; varying vec3 vW; varying vec3 vCol;
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float dif = max(dot(n, uSunDir), 0.0);
  float amb = 0.42 + 0.22 * max(n.y, 0.0);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(n, H), 0.0), 32.0) * 0.25;
  vec3 col = vCol * (uSkyAmb * amb + uGroundAmb * 0.28 + uSunCol * dif * 0.75) + uSunCol * spec;
  if (uFlashOn > 0.5) col += flashLight(vW, n) * 0.35 + uFlashCol * uFlashGlow * 0.08;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
}`;

// Vehicle lamps: one shader for head lamps (white → uHead), tail/brake lamps (red → uTail)
// and the amber beacon bar (pulses with uPulse). The part colour selects the channel.
export const lampFrag = /* glsl */ `
${COMMON}
varying vec3 vN; varying vec3 vW; varying vec3 vCol;
uniform float uHead; uniform float uTail; uniform float uPulse;
void main(){
  // white≈ neutral (r≈g≈b), amber (beacon) has g well above b but far below r,
  // red tail has g tiny. Order matters: amber before red.
  bool white = abs(vCol.r - vCol.b) < 0.15;
  bool amber = !white && vCol.g > 0.30 * vCol.r;
  float k = white ? uHead : (amber ? (0.25 + 0.75 * uPulse) : uTail);
  vec3 emis = vCol * k * (1.4 + 0.9 * k);
  // A little surface shading keeps the lens housings attached to the truck at night.
  vec3 n = normalize(vN);
  float dif = max(dot(n, uSunDir), 0.0);
  vec3 col = vCol * (uSkyAmb * 0.3 + uSunCol * dif * 0.15) + emis;
  if (uFlashOn > 0.5) col += flashLight(vW, n) * 0.2;
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
}`;
