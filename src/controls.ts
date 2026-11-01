import { Terrain } from './sim/terrain';
import { DOMAIN } from './sim/consts';

const EYE = 1.7;
const wrap = (v: number) => ((v % DOMAIN) + DOMAIN) % DOMAIN;

export class Player {
  x: number; z: number; y = 0; yaw = 0.6; pitch = 0.18; fov = 72; walking = 0;
  keys = new Set<string>(); locked = false;
  vx = 0; vz = 0; eyeY = 0;
  vf = 0; vs = 0; // virtual (touch) move input
  private terrain: Terrain;
  private touches = new Map<number, { x: number; y: number }>(); private pinch = 0;
  private cleanup: (() => void)[] = [];
  onLockChange?: (l: boolean) => void;

  constructor(el: HTMLElement, terrain: Terrain, spawn: [number, number]) {
    this.terrain = terrain;
    this.x = spawn[0]; this.z = spawn[1];
    this.eyeY = terrain.groundHeight(this.x, this.z) + EYE; this.y = this.eyeY;
    const on = (t: EventTarget, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts); this.cleanup.push(() => t.removeEventListener(ev, fn, opts as any));
    };
    on(window, 'keydown', (e: KeyboardEvent) => { this.keys.add(e.code); if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault(); });
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
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    let f = this.vf, s = this.vs;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s -= 1;
    const len = Math.hypot(f, s); if (len > 1) { f /= len; s /= len; }
    const sp = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5.5 : 2.0;
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
    this.walking += speed * dt * 2.2;
    const gh = Math.max(0, this.terrain.groundHeight(this.x, this.z));
    const target = gh + EYE + Math.sin(this.walking) * 0.025 * Math.min(1, speed / 2);
    this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 14));
    this.y = Math.max(this.eyeY, gh + 1.2);
  }
  dispose() { this.cleanup.forEach((f) => f()); }
}
