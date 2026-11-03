import { Terrain } from './sim/terrain';
import { DOMAIN } from './sim/consts';

const EYE = 1.7;
const wrap = (v: number) => ((v % DOMAIN) + DOMAIN) % DOMAIN;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const wrapDelta = (d: number) => d - DOMAIN * Math.round(d / DOMAIN);

export interface VehicleState {
  active: boolean;
  x: number; z: number; heading: number;
  vx: number; vz: number; speed: number; roll: number;
  damage: number; probe: boolean;
  wind: number; pressureDrop: number; distance: number; bearing: number;
}

export interface VehiclePose {
  active: boolean; x: number; z: number; heading: number; roll: number;
  speed: number; damage: number; probe: boolean;
  wind: number; pressureDrop: number; distance: number; bearing: number;
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

  constructor(el: HTMLElement, terrain: Terrain, spawn: [number, number]) {
    this.terrain = terrain;
    this.x = spawn[0]; this.z = spawn[1];
    this.eyeY = terrain.groundHeight(this.x, this.z) + EYE; this.y = this.eyeY;
    this.vehicle = {
      active: false, x: this.x, z: this.z, heading: this.yaw,
      vx: 0, vz: 0, speed: 0, roll: 0, damage: 0, probe: false,
      wind: 0, pressureDrop: 0, distance: Infinity, bearing: 0,
    };
    const on = (t: EventTarget, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts); this.cleanup.push(() => t.removeEventListener(ev, fn, opts as any));
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'KeyV' && !e.repeat) this.toggleVehicle();
      if (e.code === 'KeyP' && !e.repeat && this.mode === 'vehicle') this.vehicle.probe = !this.vehicle.probe;
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
    } else {
      this.mode = 'foot'; v.active = false;
      this.x = v.x; this.z = v.z; this.vx = 0; this.vz = 0;
    }
    this.onModeChange?.(this.mode);
  }

  vehiclePose(): VehiclePose {
    const v = this.vehicle;
    return {
      active: v.active, x: v.x, z: v.z, heading: v.heading, roll: v.roll,
      speed: v.speed, damage: v.damage, probe: v.probe,
      wind: v.wind, pressureDrop: v.pressureDrop, distance: v.distance, bearing: v.bearing,
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
    // 5x the original walking pace (running still ~2.75x faster than walking)
    const sp = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 27.5 : 10.0;
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
    const target = gh + EYE + Math.sin(this.walking) * 0.035 * Math.min(1, speed / 9);
    this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 14));
    this.y = Math.max(this.eyeY, gh + 1.2);
  }

  private updateVehicle(dt: number, tornado: any) {
    const v = this.vehicle;
    let throttle = this.vf, steer = this.vs;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttle += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) throttle -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
    throttle = clamp(throttle, -1, 1); steer = clamp(steer, -1, 1);
    const handbrake = this.keys.has('Space');
    // Bicycle-model steering: the faster the truck, the slower the yaw rate.
    const steerRate = steer * (0.9 - 0.55 * Math.min(1, Math.abs(v.speed) / 40));
    v.heading += steerRate * dt;
    this.yaw += steerRate * dt;
    v.heading = wrap(v.heading);
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const accel = throttle > 0 ? 13 : throttle < 0 ? -19 : 0;
    const drag = 0.010 * v.speed * Math.abs(v.speed) + 0.30 * v.speed + (handbrake ? 14 * Math.sign(v.speed) : 0);
    v.speed = clamp(v.speed + (accel - drag) * dt, -9, 44);
    v.vx = fx * v.speed; v.vz = fz * v.speed;

    // Rankine-vortex wind force, pressure deficit and debris damage from the solver snapshot.
    let wind = 0, pressure = 0, distance = Infinity, bearing = 0;
    if (tornado && tornado.active) {
      const dx = wrapDelta(v.x - tornado.x), dz = wrapDelta(v.z - tornado.z);
      const r = Math.max(1, Math.hypot(dx, dz)), R = Math.max(80, tornado.radius);
      const vt = tornado.maxWind * (r < R ? r / R : Math.pow(R / r, 0.62) * Math.exp(-(r - R) / 4200));
      const inflow = -0.2 * tornado.maxWind * Math.exp(-r / (1.8 * R));
      const wx = -(dz / r) * vt + (dx / r) * inflow;
      const wz = (dx / r) * vt + (dz / r) * inflow;
      const relx = wx - v.vx, relz = wz - v.vz;
      const rel = Math.hypot(relx, relz);
      // F = 0.5 rho Cd A |v_rel| v_rel / mass; CdA/m ~ 0.0027 m^2/kg for a 2.1 t truck.
      const force = 0.0027 * rel;
      v.vx += relx * force * dt; v.vz += relz * force * dt;
      wind = Math.hypot(wx, wz);
      pressure = tornado.pressureDrop * Math.exp(-(r * r) / (6 * R * R));
      distance = r;
      bearing = Math.atan2(-dx, dz);    // bearing from vehicle toward vortex centre
      v.damage = clamp(v.damage + Math.max(0, wind - 32) * dt * 0.00018, 0, 1);
    } else {
      v.damage = Math.max(0, v.damage - dt * 0.00008);
    }
    v.wind = wind; v.pressureDrop = pressure; v.distance = distance; v.bearing = bearing;

    // Terrain slope limits traction; water and steep slopes stop the vehicle.
    const nx = wrap(v.x + v.vx * dt), nz = wrap(v.z + v.vz * dt);
    const h0 = this.terrain.groundHeight(v.x, v.z), h1 = this.terrain.groundHeight(nx, nz);
    const slope = Math.abs(h1 - h0) / Math.max(1, Math.hypot(nx - v.x, nz - v.z));
    if (h1 > -0.3 && slope < 0.55) { v.x = nx; v.z = nz; }
    else { v.vx *= 0.15; v.vz *= 0.15; v.speed *= 0.15; }
    v.roll += (clamp(-steer * Math.abs(v.speed) / 90 + (v.vx * fz - v.vz * fx) / 220, -0.16, 0.16) - v.roll) * Math.min(1, dt * 5);
    const gh = Math.max(0, this.terrain.groundHeight(v.x, v.z));
    this.eyeY += (gh + 2.45 - this.eyeY) * (1 - Math.exp(-dt * 10));
    this.y = this.eyeY;
    this.x = v.x; this.z = v.z;
    this.vx = v.vx; this.vz = v.vz;
    this.walking += Math.abs(v.speed) * dt * 0.08;
  }

  dispose() { this.cleanup.forEach((f) => f()); }
}
