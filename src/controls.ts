import { Terrain } from './sim/terrain';
import { DOMAIN } from './sim/consts';

const EYE = 1.7;
const wrap = (v: number) => ((v % DOMAIN) + DOMAIN) % DOMAIN;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const TAU = Math.PI * 2;
const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU;

/** Headlight technologies the truck can be fitted with (K / the LIGHT button cycles them).
 *  col = lens emission tint, i = relative intensity — halogen is warm and modest, xenon is
 *  a brighter blue-white HID, LED is the crispest cool white. */
export const LIGHT_TYPES: { name: string; col: [number, number, number]; i: number }[] = [
  { name: 'HALOGEN', col: [1.0, 0.84, 0.58], i: 1.0 },
  { name: 'XENON', col: [0.80, 0.90, 1.0], i: 1.45 },
  { name: 'LED', col: [0.93, 0.97, 1.0], i: 1.75 },
];
const wrapDelta = (d: number) => d - DOMAIN * Math.round(d / DOMAIN);

export interface VehicleState {
  active: boolean;
  x: number; z: number; heading: number;
  vx: number; vz: number; speed: number;
  pitch: number; roll: number; steer: number; bounce: number;
  damage: number; probe: boolean; lights: boolean; brake: boolean;
  lightType: number;    // index into LIGHT_TYPES: 0 halogen, 1 xenon, 2 LED
  wind: number; pressureDrop: number; distance: number; bearing: number;
  closing: number;      // m/s toward the vortex (positive = closing in)
  prevDist: number;
}

export interface VehiclePose {
  active: boolean; x: number; z: number; heading: number;
  pitch: number; roll: number; steer: number; bounce: number;
  speed: number; damage: number; probe: boolean; lights: boolean; brake: boolean;
  lightType: number;
  wind: number; pressureDrop: number; distance: number; bearing: number; closing: number;
  /** Seconds of energy-drink boost left (×10 speed), 0 when dry. */
  drink: number;
}

/** Player controller with a foot mode and a fully player-driven intercept vehicle. */
export class Player {
  x: number; z: number; y = 0; yaw = 0.6; pitch = 0.18; fov = 72; walking = 0;
  keys = new Set<string>(); locked = false;
  vx = 0; vz = 0; eyeY = 0;
  vf = 0; vs = 0; // virtual (touch) move input
  mode: 'foot' | 'vehicle' = 'foot';
  vehicle: VehicleState;
  onLockChange?: (l: boolean) => void;
  onModeChange?: (mode: 'foot' | 'vehicle') => void;
  private terrain: Terrain;
  private touches = new Map<number, { x: number; y: number }>(); private pinch = 0;
  private cleanup: (() => void)[] = [];
  private bounceV = 0; private tT = 0;
  /** Energy-drink boost deadline (performance.now ms): ×10 speed while now < drinkUntil. */
  private drinkUntil = 0;
  drinkActive() { return performance.now() < this.drinkUntil; }
  /** Trigger the 30 s energy-drink boost (G on desktop, the G button on mobile). */
  drink() { this.drinkUntil = performance.now() + 30000; }
  /** Set by the app: honk the truck horn (H on desktop, HORN button on mobile). */
  onHorn?: () => void;
  /** Cycle headlight technology (halogen → xenon → LED) and switch the lamps on. */
  cycleLights() {
    this.vehicle.lights = true;
    this.vehicle.lightType = (this.vehicle.lightType + 1) % LIGHT_TYPES.length;
  }
  /** Touch: one button round-robins OFF → halogen → xenon → LED → OFF. */
  touchLights() {
    const v = this.vehicle;
    const next = v.lights ? v.lightType + 1 : 0;
    if (next >= LIGHT_TYPES.length) v.lights = false;
    else { v.lights = true; v.lightType = next; }
  }
  /** Vertical velocity for the foot-mode jump (gravity-integrated in updateFoot). */
  private vy = 0;
  private jumpQueued = false;
  /** Queue a jump: consumed when the player is in foot mode and at ground contact.
   *  The mobile JUMP button and the Space key both land here. */
  jump() { this.jumpQueued = true; }

  constructor(el: HTMLElement, terrain: Terrain, spawn: [number, number]) {
    this.terrain = terrain;
    this.x = spawn[0]; this.z = spawn[1];
    this.eyeY = terrain.groundHeight(this.x, this.z) + EYE; this.y = this.eyeY;
    this.vehicle = {
      active: false, x: this.x, z: this.z, heading: this.yaw,
      vx: 0, vz: 0, speed: 0, pitch: 0, roll: 0, steer: 0, bounce: 0,
      damage: 0, probe: false, lights: false, brake: false, lightType: 0,
      wind: 0, pressureDrop: 0, distance: Infinity, bearing: 0, closing: 0, prevDist: Infinity,
    };
    const on = (t: EventTarget, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts); this.cleanup.push(() => t.removeEventListener(ev, fn, opts as any));
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'KeyV' && !e.repeat) this.toggleVehicle();
      if (e.code === 'KeyP' && !e.repeat && this.mode === 'vehicle') this.vehicle.probe = !this.vehicle.probe;
      if (e.code === 'KeyL' && !e.repeat && this.mode === 'vehicle') this.vehicle.lights = !this.vehicle.lights;
      // Cycle headlight technology (halogen → xenon → LED); turns the lamps on.
      if (e.code === 'KeyK' && !e.repeat && this.mode === 'vehicle') this.cycleLights();
      // Horn (WebAudio lives in AudioEngine; the controller just reports the press).
      if (e.code === 'KeyH' && !e.repeat && this.mode === 'vehicle') this.onHorn?.();
      // Energy drink: 30 s of ×10 power/speed. Re-drinking refreshes the timer.
      if (e.code === 'KeyG' && !e.repeat) this.drink();
      // Jump (foot mode): edge-triggered so holding Space does not bunny-hop on landing.
      if (e.code === 'Space' && !e.repeat && this.mode === 'foot') this.jump();
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(el, 'click', () => { if (!this.locked && !('ontouchstart' in window)) (el as any).requestPointerLock?.(); });
    on(document, 'pointerlockchange', () => { this.locked = document.pointerLockElement === el; this.onLockChange?.(this.locked); });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0021; this.pitch -= e.movementY * 0.0021;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    on(el, 'wheel', (e: WheelEvent) => { e.preventDefault(); this.fov = Math.max(30, Math.min(95, this.fov + e.deltaY * 0.03)); }, { passive: false });
    // touch: one-finger look, two-finger pinch zoom (FOV). Default browser gestures are suppressed.
    const ts = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (this.touches.size === 2) this.pinch = this.pinchDist();
    };
    const tm = (e: TouchEvent) => {
      e.preventDefault();
      if (this.touches.size === 1) {
        const t = e.changedTouches[0]; const p = this.touches.get(t.identifier);
        if (p) {
          this.yaw -= (t.clientX - p.x) * 0.0052; this.pitch -= (t.clientY - p.y) * 0.0052;
          this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
        }
      }
      for (const t of Array.from(e.changedTouches)) if (this.touches.has(t.identifier)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (this.touches.size === 2) {
        const d = this.pinchDist();
        if (this.pinch > 0) this.fov = Math.max(30, Math.min(95, this.fov * (this.pinch / d)));
        this.pinch = d;
      }
    };
    const te = (e: TouchEvent) => { e.preventDefault(); for (const t of Array.from(e.changedTouches)) this.touches.delete(t.identifier); this.pinch = 0; };
    on(el, 'touchstart', ts, { passive: false }); on(el, 'touchmove', tm, { passive: false });
    on(el, 'touchend', te, { passive: false }); on(el, 'touchcancel', te, { passive: false });
    on(document, 'gesturestart', (e: Event) => e.preventDefault(), { passive: false } as any);
    on(el, 'contextmenu', (e: Event) => e.preventDefault());
  }

  private pinchDist() {
    const a = Array.from(this.touches.values());
    return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  }

  toggleVehicle() {
    const v = this.vehicle;
    if (this.mode === 'foot') {
      this.mode = 'vehicle'; v.active = true;
      v.x = this.x; v.z = this.z; v.heading = this.yaw;
      v.vx = 0; v.vz = 0; v.speed = 0; v.damage = 0; v.probe = false;
      v.pitch = 0; v.roll = 0; v.steer = 0; v.bounce = 0; v.closing = 0; v.prevDist = Infinity;
      this.bounceV = 0;
    } else {
      this.mode = 'foot'; v.active = false;
      this.x = v.x; this.z = v.z; this.vx = 0; this.vz = 0;
    }
    this.onModeChange?.(this.mode);
  }

  vehiclePose(): VehiclePose {
    const v = this.vehicle;
    return {
      active: v.active, x: v.x, z: v.z, heading: v.heading,
      pitch: v.pitch, roll: v.roll, steer: v.steer, bounce: v.bounce,
      speed: v.speed, damage: v.damage, probe: v.probe, lights: v.lights, brake: v.brake,
      lightType: v.lightType,
      wind: v.wind, pressureDrop: v.pressureDrop, distance: v.distance, bearing: v.bearing,
      closing: v.closing,
      drink: Math.max(0, (this.drinkUntil - performance.now()) / 1000),
    };
  }

  update(dt: number, tornado?: any) {
    dt = Math.min(dt, 0.1);
    if (this.mode === 'vehicle') this.updateVehicle(dt, tornado);
    else this.updateFoot(dt);
  }

  private updateFoot(dt: number) {
    let f = this.vf, s = this.vs;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s -= 1;
    const len = Math.hypot(f, s); if (len > 1) { f /= len; s /= len; }
    // 5x the original walking pace (running still ~2.75x faster than walking); the energy
    // drink multiplies it again by 10 for its 30 s window.
    const sp = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 27.5 : 10.0)
      * (this.drinkActive() ? 10 : 1);
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const tvx = (fx * f + rx * s) * sp, tvz = (fz * f + rz * s) * sp;
    const k = 1 - Math.exp(-dt * 7);
    this.vx += (tvx - this.vx) * k; this.vz += (tvz - this.vz) * k;
    const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    const g0 = this.terrain.groundHeight(this.x, this.z);
    const ok = (px: number, pz: number) => {
      const h = this.terrain.groundHeight(px, pz);
      return h > -0.3 && Math.abs(h - g0) < 1.3 * Math.max(0.05, Math.hypot(px - this.x, pz - this.z));
    };
    if (ok(nx, nz)) { this.x = wrap(nx); this.z = wrap(nz); }
    else if (ok(nx, this.z)) { this.x = wrap(nx); this.vz *= 0.3; }
    else if (ok(this.x, nz)) { this.z = wrap(nz); this.vx *= 0.3; }
    else { this.vx = 0; this.vz = 0; }
    const speed = Math.hypot(this.vx, this.vz);
    this.walking += speed * dt * 0.55;
    const gh = Math.max(0, this.terrain.groundHeight(this.x, this.z));
    const groundEye = gh + EYE;
    // Jump: gravity-integrated hop (~1 m apex at 7 m/s against 25 m/s²). A press while
    // airborne stays queued and fires on touchdown.
    if (this.jumpQueued && this.vy <= 0 && this.eyeY <= groundEye + 0.08) {
      this.vy = 7.0;
      this.jumpQueued = false;
    }
    // Physics only while actually airborne (jump/fall); the walk-bob path owns ground contact
    // otherwise — a residual ≤10 cm is bob/terrain-follow slack, not flight.
    if (this.vy !== 0 || this.eyeY > groundEye + 0.1) {
      this.vy -= 25 * dt;
      this.eyeY += this.vy * dt;
      if (this.eyeY <= groundEye) { this.eyeY = groundEye; if (this.vy < 0) this.vy = 0; }
    } else {
      this.vy = 0;
      const target = groundEye + Math.sin(this.walking) * 0.035 * Math.min(1, speed / 9);
      this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 14));
    }
    this.y = Math.max(this.eyeY, gh + 1.2);
  }

  private updateVehicle(dt: number, tornado: any) {
    const v = this.vehicle;
    this.tT += dt;
    let throttle = this.vf, steer = this.vs;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttle += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) throttle -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
    throttle = clamp(throttle, -1, 1); steer = clamp(steer, -1, 1);
    const handbrake = this.keys.has('Space');

    // Bicycle-model steering: the faster the truck, the slower the yaw rate. The visual
    // front wheels follow the same (smoothed) input.
    const steerRate = steer * (0.95 - 0.58 * Math.min(1, Math.abs(v.speed) / 42));
    v.heading += steerRate * dt;
    // The camera look (this.yaw) is decoupled from the truck: the vehicle drives along its
    // OWN heading and mouse-look only aims the camera — the truck no longer drives in the
    // camera direction while its model faces a fixed heading.
    // Angle normalisation — NOT wrap(): DOMAIN (32000) is not a multiple of 2π, so the old
    // domain wrap snapped a negative yaw ~15° away from the camera every frame (the truck
    // stopped facing where you look).
    v.heading = wrapAngle(v.heading);
    v.steer += (steer - v.steer) * Math.min(1, dt * 8);

    const fx = -Math.sin(v.heading), fz = -Math.cos(v.heading);
    const rx = Math.cos(v.heading), rz = -Math.sin(v.heading);
    // Grip model: split the velocity into forward and lateral components so the truck can
    // understeer, break traction under the handbrake and be pushed sideways by the vortex.
    let fwd = v.vx * fx + v.vz * fz;
    let lat = v.vx * rx + v.vz * rz;

    // Power curve with speed falloff; hull damage steals power. The energy drink multiplies
    // engine power ×10, quarter-drag and raises the speed clamp ×10 for its 30 s window.
    const boost = this.drinkActive() ? 10 : 1;
    const dmg = v.damage;
    const power = 15.5 * boost * (1 - 0.34 * dmg) * (1 - 0.75 * Math.min(1, Math.abs(fwd) / (50 * boost)));
    const accel = throttle >= 0 ? power * throttle : 21 * boost * throttle;
    const dragScale = boost > 1 ? 0.25 : 1;
    const drag = (0.010 * fwd * Math.abs(fwd) + 0.30 * fwd) * dragScale;
    fwd += (accel - (drag + (handbrake ? 16 * Math.sign(fwd) : 0))) * dt;
    if (Math.abs(throttle) < 0.02) fwd *= Math.exp(-dt * 0.55);   // engine braking
    fwd = clamp(fwd, -11, 50 * boost);

    // Lateral grip: firm normally, cut by the handbrake (drift), by damage and by water.
    const grip = (handbrake ? 1.15 : 7.0) * (1 - 0.4 * dmg);
    lat *= Math.exp(-dt * grip);
    const latCap = 0.45 * Math.abs(fwd) + 2.5;
    if (Math.abs(lat) > latCap) lat *= latCap / Math.abs(lat);

    // Rankine-vortex wind force, turbulence gusts, pressure deficit and debris damage.
    let wind = 0, pressure = 0, distance = Infinity, bearing = 0;
    if (tornado && tornado.active) {
      const dx = wrapDelta(v.x - tornado.x), dz = wrapDelta(v.z - tornado.z);
      const r = Math.max(1, Math.hypot(dx, dz)), R = Math.max(55, tornado.radius);
      // Burgers–Rott profile, matching the solver-side vortex: solid-body core, smooth
      // peak at r=R (no Rankine kink), 1/r decay and a far-field exponential cutoff.
      const xr = Math.max(r, 12) / R;
      let vt = tornado.maxWind * ((2 * xr) / (1 + xr * xr))
        * (r > 1.6 * R ? Math.exp(-(r - 1.6 * R) / 5200) : 1);
      // Suction-spot passage (mature multi-vortex): brief ~40% tangential gust as an
      // orbiting sub-vortex sweeps past the truck.
      const si = Math.max(0, Math.min(1, ((tornado.intensity || 0) - 0.5) / 0.45));
      if (si > 0) vt *= 1 + 0.45 * si * Math.max(0, Math.sin(this.tT * 2.05 + v.x * 0.013 + v.z * 0.011));
      const inflow = -(0.18 + 0.16 * (tornado.intensity || 0)) * tornado.maxWind * Math.exp(-r / (1.4 * R));
      const wx = -(dz / r) * vt + (dx / r) * inflow;
      const wz = (dx / r) * vt + (dz / r) * inflow;
      const vwx = fx * fwd + rx * lat, vwz = fz * fwd + rz * lat;
      const relx = wx - vwx, relz = wz - vwz;
      const rel = Math.hypot(relx, relz);
      // F = 0.5 rho Cd A |v_rel| v_rel / mass; CdA/m ~ 0.0027 m^2/kg for a 2.1 t truck,
      // rising with load on the flat sides as the wind gets extreme.
      const force = 0.0031 * rel * (1 + 0.5 * Math.min(1, rel / 45));
      const rf = relx * fx + relz * fz, rl = relx * rx + relz * rz;
      fwd += rf * force * dt; lat += rl * force * dt;
      wind = Math.hypot(wx, wz);
      pressure = tornado.pressureDrop * Math.exp(-(r * r) / (6 * R * R));
      distance = r;
      bearing = Math.atan2(-dx, dz);    // bearing from vehicle toward vortex centre
      // Turbulent gusts: buffeting the hull and steering around near the core.
      const prox = Math.exp(-r / 4200);
      const gust = (Math.sin(this.tT * 2.3 + v.x * 0.011) + 0.7 * Math.sin(this.tT * 3.7 + v.z * 0.014)) * wind * prox;
      lat += gust * 0.045 * dt * 60 * 0.016;
      v.heading += gust * 0.00035 * dt * 60 * 0.016;
      v.damage = clamp(v.damage + Math.max(0, wind - 30) * dt * 0.00022, 0, 1);
    } else {
      v.damage = Math.max(0, v.damage - dt * 0.00008);
    }
    // Closing speed toward the vortex (for the HUD): + = getting closer.
    if (isFinite(distance) && isFinite(v.prevDist)) {
      const c = (v.prevDist - distance) / Math.max(dt, 1e-3);
      v.closing += (c - v.closing) * Math.min(1, dt * 3);
    }
    v.prevDist = distance;
    v.wind = wind; v.pressureDrop = pressure; v.distance = distance; v.bearing = bearing;
    v.brake = throttle < -0.05 || handbrake;

    // Terrain slope limits traction; water and steep slopes slow or stop the vehicle.
    let nx = wrap(v.x + (fx * fwd + rx * lat) * dt), nz = wrap(v.z + (fz * fwd + rz * lat) * dt);
    const h0 = this.terrain.groundHeight(v.x, v.z), h1 = this.terrain.groundHeight(nx, nz);
    const slope = Math.abs(h1 - h0) / Math.max(1, Math.hypot(nx - v.x, nz - v.z));
    if (h1 > -0.3 && slope < 0.55) { v.x = nx; v.z = nz; }
    else { fwd *= 0.15; lat *= 0.15; }
    // Ponds and creeks: drag rises fast with depth (the truck fords, it does not float).
    const depth = Math.max(0, -h1);
    if (depth > 0.02) fwd *= Math.exp(-dt * (1.1 + 4.5 * Math.min(1, depth)));

    v.speed = fwd;
    v.vx = fx * fwd + rx * lat; v.vz = fz * fwd + rz * lat;

    // The body faces where it is actually going: at speed, the heading chases the velocity
    // vector (slides, gust shoves and handbrake drifts visibly swing the nose) instead of
    // staring in one fixed direction.
    const sp2 = Math.hypot(v.vx, v.vz);
    if (sp2 > 4) {
      const vAng = Math.atan2(-v.vx, -v.vz);
      const d = wrapAngle(vAng - v.heading);
      v.heading = wrapAngle(v.heading + d * Math.min(1, dt * 1.4));
    }

    // ---- suspension: pitch from longitudinal slope + squat/dive, roll from cross slope +
    // cornering lean, and a springy bounce over rough ground.
    const hF = this.terrain.groundHeight(v.x + fx * 2.2, v.z + fz * 2.2);
    const hB = this.terrain.groundHeight(v.x - fx * 2.2, v.z - fz * 2.2);
    const hL = this.terrain.groundHeight(v.x + rx * 1.1, v.z + rz * 1.1);
    const hR = this.terrain.groundHeight(v.x - rx * 1.1, v.z - rz * 1.1);
    const pitchT = clamp(Math.atan2(hF - hB, 4.4) + accel * 0.0035, -0.30, 0.30);
    const rollT = clamp(Math.atan2(hR - hL, 2.2) - v.steer * Math.min(1, Math.abs(fwd) / 30) * 0.10 - lat * 0.012, -0.24, 0.24);
    v.pitch += (pitchT - v.pitch) * Math.min(1, dt * 7);
    v.roll += (rollT - v.roll) * Math.min(1, dt * 6);
    const rough = Math.abs(hF + hB - 2 * h0);
    const bumpT = -Math.min(0.3, rough * 0.45) * Math.min(1, Math.abs(fwd) / 14);
    this.bounceV += ((bumpT - v.bounce) * 46 - this.bounceV * 6.5) * dt;
    v.bounce = clamp(v.bounce + this.bounceV * dt, -0.35, 0.35);

    const gh = Math.max(0, this.terrain.groundHeight(v.x, v.z));
    this.eyeY += (gh + 2.45 + v.bounce - this.eyeY) * (1 - Math.exp(-dt * 10));
    this.y = this.eyeY;
    this.x = v.x; this.z = v.z;
    this.vx = v.vx; this.vz = v.vz;
    this.walking += Math.abs(v.speed) * dt * 0.08;
  }

  dispose() { this.cleanup.forEach((f) => f()); }
}
