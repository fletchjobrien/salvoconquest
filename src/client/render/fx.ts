// GPU point particles: wakes, smoke, fire, trails, splashes, rain. Point sprites look great pixelated.
//
// The combat effects follow the author's earlier game Salvo: fireballs that grow and rise, sparks that
// arc and die on the water, long black smoke, tall water columns with a foam ring, billowing launch
// clouds, tracer streaks, flash lights and camera shake. Salvo's presets are in its own units (a
// destroyer is 62 long there); U converts them to km here, a little larger so they read at RTS zoom.
import * as THREE from 'three';

/** km per Salvo effect unit. */
const U = 0.014;

const VERT = /* glsl */ `
attribute float size;
attribute vec4 color;
varying vec4 vColor;
uniform float scale;
uniform float pull;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float ps = size * scale / -mv.z;
  // Pull big puffs toward the camera so the sea surface does not cut them in half.
  vec3 p = mv.xyz + normalize(-mv.xyz) * min(size * 0.5, -mv.z * 0.5) * pull;
  // Sub-pixel particles fade instead of popping.
  if (ps < 1.0) { vColor.a *= ps; ps = 1.0; }
  // Capped: up close, huge soft puffs would flood the screen with overdraw.
  gl_PointSize = min(ps, 180.0);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;
const FRAG = /* glsl */ `
varying vec4 vColor;
uniform float soft;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = vColor.a * mix(1.0, 1.0 - r * r, soft);
  gl_FragColor = vec4(vColor.rgb, a);
}
`;

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  s0: number;
  s1: number;
  r: number;
  g: number;
  b: number;
  a0: number;
  drag: number;
  grav: number;
  // colour fade toward (r2,g2,b2)
  r2: number;
  g2: number;
  b2: number;
  /** How much the particle fades over its life (1 = fully, 0 = stays bright, e.g. tracer rounds). */
  fade: number;
  /** Size grows with the square root of age (fast burst, slow spread), as in Salvo. */
  sq: boolean;
  /** Dies when it falls back to the sea (sparks, debris, spray). */
  floor: boolean;
  /** Colour reaches (r2,g2,b2) at this fraction of life (0.5 default; 1 = over the whole life). */
  cl: number;
}

class Pool {
  readonly points: THREE.Points;
  private ps: P[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private geo: THREE.BufferGeometry;
  readonly mat: THREE.ShaderMaterial;

  constructor(
    readonly max: number,
    additive: boolean,
    soft = 1,
    pull = 0,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { scale: { value: 300 }, soft: { value: soft }, pull: { value: pull } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  add(p: Partial<P> & { x: number; y: number; z: number }) {
    if (this.ps.length >= this.max) this.ps.shift();
    const q: P = {
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      max: 1,
      s0: 0.1,
      s1: 0.2,
      r: 1,
      g: 1,
      b: 1,
      a0: 1,
      drag: 0,
      grav: 0,
      r2: -1,
      g2: 0,
      b2: 0,
      fade: 1,
      sq: false,
      floor: false,
      cl: 0.5,
      ...p,
    };
    this.ps.push(q);
  }

  update(dt: number) {
    const ps = this.ps;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vy -= p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.floor && p.y < 0 && p.vy < 0) continue;
      ps[w++] = p;
    }
    ps.length = w;
    for (let i = 0; i < w; i++) {
      const p = ps[i];
      const t = p.life / p.max;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      let r = p.r;
      let g = p.g;
      let b = p.b;
      if (p.r2 >= 0) {
        const k = Math.min(1, t / p.cl);
        r += (p.r2 - r) * k;
        g += (p.g2 - g) * k;
        b += (p.b2 - b) * k;
      }
      this.col[i * 4] = r;
      this.col[i * 4 + 1] = g;
      this.col[i * 4 + 2] = b;
      this.col[i * 4 + 3] = p.a0 * (1 - t * p.fade) * Math.min(1, p.life * 12);
      this.size[i] = p.s0 + (p.s1 - p.s0) * (p.sq ? Math.sqrt(t) : t);
    }
    this.geo.setDrawRange(0, w);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const RING_GEO = new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2);

/** Expanding foam/shock rings flat on the water (pooled). */
interface Ring {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  t: number;
  life: number;
  size: number;
  alpha: number;
}

/** Short point-light flashes from muzzles, launches and explosions (pooled). */
interface Flash {
  light: THREE.PointLight;
  t: number;
  life: number;
  peak: number;
}

export class Fx {
  group = new THREE.Group();
  smoke = new Pool(9000, false, 0.7, 1);
  foam = new Pool(6000, false, 1, 0.5);
  glow = new Pool(6000, true, 1, 1);
  rain = new Pool(2500, false, 0);
  private rings: Ring[] = [];
  private flashes: Flash[] = [];
  /** Shell tracers: line segments rebuilt every frame (head bright, tail fading to dark red). */
  private streakPos = new Float32Array(800 * 6);
  private streakCol = new Float32Array(800 * 8);
  private streakN = 0;
  private streaks: THREE.LineSegments;
  /** Camera shake requested by effects this frame (the scene hands it to the camera rig). */
  shake = 0;
  /** Where the camera looks and how far it is: shake falls off with distance from the view centre. */
  view = { x: 0, y: 0, dist: 40 };

  constructor() {
    this.group.add(this.foam.points, this.smoke.points, this.glow.points, this.rain.points);
    this.foam.points.renderOrder = 1;
    this.smoke.points.renderOrder = 2;
    this.glow.points.renderOrder = 3;
    for (let i = 0; i < 28; i++) {
      const mesh = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color: 0xd8ecff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.rings.push({ mesh, t: 1, life: 1, size: 1, alpha: 0 });
    }
    // Every point light costs every lit pixel (land, ships) every frame, lit or not: keep two.
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffaa66, 0, 10, 1.6);
      this.group.add(light);
      this.flashes.push({ light, t: 1, life: 1, peak: 0 });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.streakCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.streaks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 4;
    this.group.add(this.streaks);
  }

  /** An expanding ring on the water (size = final radius, km). */
  ring(x: number, y: number, size: number, life: number, alpha: number, color = 0xd8ecff) {
    const r = this.rings.reduce((a, b) => (b.t / b.life > a.t / a.life ? b : a));
    r.t = 0;
    r.life = life;
    r.size = size;
    r.alpha = alpha;
    r.mesh.material.color.setHex(color);
    r.mesh.position.set(x, 0.012, y);
    r.mesh.visible = true;
  }

  /** A point-light flash; the pooled light with the least time left is reused (small flashes skip it). */
  light(x: number, alt: number, y: number, color: number, peak: number, range: number, life: number) {
    if (peak < 10) return;
    const f = this.flashes.reduce((a, b) => (b.life - b.t < a.life - a.t ? b : a));
    f.t = 0;
    f.life = life;
    f.peak = peak;
    f.light.color.setHex(color);
    f.light.distance = range;
    f.light.position.set(x, alt, y);
  }

  /**
   * Camera shake, only for a blast you are looking at: inside the middle of the view (a radius of
   * a third of the camera distance, at least 1.5 km), strongest at the centre, none outside; and
   * only when zoomed in (full at 6 km camera distance, none beyond 30 km).
   */
  addShake(x: number, y: number, amount: number) {
    const zoom = Math.max(0, Math.min(1, (30 - this.view.dist) / 24));
    if (zoom <= 0) return;
    const R = Math.max(1.5, this.view.dist * 0.33);
    const d = Math.hypot(x - this.view.x, y - this.view.y);
    if (d >= R) return;
    const near = 1 - (d / R) ** 2;
    this.shake = Math.min(1, this.shake + amount * zoom * zoom * near);
  }

  /** One tracer streak this frame, from (x1..) back toward (x0..). */
  streak(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number, r: number, g: number, b: number) {
    if (this.streakN >= 800) return;
    const i = this.streakN++;
    this.streakPos.set([x1, a1, y1, x0, a0, y0], i * 6);
    this.streakCol.set([r, g, b, 1, r * 0.4, g * 0.25, b * 0.2, 0], i * 8);
  }

  setScale(viewportHeight: number, fovDeg: number) {
    const s = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    for (const p of [this.smoke, this.foam, this.glow, this.rain]) p.mat.uniforms.scale.value = s;
  }

  private clock = 0;
  private queued: { t: number; fn: () => void }[] = [];

  /** Run an emitter a little later (staggered bursts of fire, delayed blasts). */
  later(delay: number, fn: () => void) {
    this.at(delay, fn);
  }

  private at(delay: number, fn: () => void) {
    this.queued.push({ t: this.clock + delay, fn });
  }

  update(dt: number) {
    this.clock += dt;
    if (this.queued.length) {
      const due = this.queued.filter((l) => l.t <= this.clock);
      if (due.length) {
        this.queued = this.queued.filter((l) => l.t > this.clock);
        for (const l of due) l.fn();
      }
    }
    this.smoke.update(dt);
    this.foam.update(dt);
    this.glow.update(dt);
    this.rain.update(dt);
    for (const r of this.rings) {
      if (r.t >= r.life) continue;
      r.t += dt;
      const t = Math.min(1, r.t / r.life);
      const k = r.size * (0.15 + Math.sqrt(t));
      r.mesh.scale.set(k, 1, k);
      r.mesh.material.opacity = (1 - t) * r.alpha;
      r.mesh.visible = t < 1;
    }
    for (const f of this.flashes) {
      f.t = Math.min(f.life, f.t + dt);
      const k = 1 - f.t / f.life;
      f.light.intensity = f.peak * k * k;
    }
    const sg = this.streaks.geometry;
    sg.setDrawRange(0, this.streakN * 2);
    (sg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (sg.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.streakN = 0;
  }

  // ---- emitters ----

  wake(x: number, y: number, heading: number, speed: number, width: number) {
    // Two foam lines from the stern spreading outward, plus a bow wave.
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    for (const side of [-1, 1]) {
      const px = -s * side;
      const py = c * side;
      this.foam.add({
        x: x + px * width * 0.3,
        y: 0.01,
        z: y + py * width * 0.3,
        vx: px * speed * 0.25 - c * speed * 0.1,
        vz: py * speed * 0.25 - s * speed * 0.1,
        max: rnd(3, 5),
        s0: width * 0.5,
        s1: width * 1.6,
        r: 0.95,
        g: 0.98,
        b: 1,
        a0: 0.55,
        drag: 0.4,
      });
    }
  }

  bowSpray(x: number, y: number, heading: number, len: number) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    this.foam.add({ x: x + c * len * 0.46, y: 0.01, z: y + s * len * 0.46, vx: rnd(-0.02, 0.02), vz: rnd(-0.02, 0.02), max: 0.8, s0: len * 0.04, s1: len * 0.1, a0: 0.55 });
  }

  subWake(x: number, y: number) {
    this.foam.add({ x: x + rnd(-0.03, 0.03), y: 0.008, z: y + rnd(-0.03, 0.03), max: 2.5, s0: 0.05, s1: 0.15, a0: 0.25 });
  }

  /**
   * Missile smoke laid down by distance travelled (one puff every ~80 m, so fast missiles leave
   * unbroken trails at any frame rate), plus the motor flame at the head. Returns leftover distance.
   */
  missileTrail(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number, carry: number, sam: boolean, hostile: boolean): number {
    const d = Math.hypot(x1 - x0, a1 - a0, y1 - y0);
    const step = (sam ? 3.5 : 4) * U;
    let acc = carry + d;
    const n = Math.min(12, Math.floor(acc / step));
    acc -= n * step;
    const g = sam ? 0.92 : 0.82;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      this.smoke.add({
        x: x0 + (x1 - x0) * t,
        y: a0 + (a1 - a0) * t,
        z: y0 + (y1 - y0) * t,
        vx: rnd(-1, 1) * U,
        vy: rnd(0.5, 2.5) * U,
        vz: rnd(-1, 1) * U,
        max: sam ? rnd(1.4, 2.4) : rnd(2.2, 3.5),
        s0: (sam ? 2.5 : 3) * U,
        s1: (sam ? 6 : 9) * U,
        r: g,
        g,
        b: g,
        a0: 0.42,
        drag: 0.4,
        grav: -0.6 * U,
        sq: true,
      });
    }
    if (d > 1e-5) {
      const k = (3 * U) / d;
      const flame = sam ? [1, 0.95, 0.85] : hostile ? [1, 0.6, 0.25] : [1, 0.85, 0.5];
      this.glow.add({ x: x1 - (x1 - x0) * k, y: a1 - (a1 - a0) * k, z: y1 - (y1 - y0) * k, max: 0.06, s0: (sam ? 5 : 7) * U, s1: 3 * U, r: flame[0], g: flame[1], b: flame[2], a0: 1, r2: 1, g2: 0.35, b2: 0.06, cl: 1 });
    }
    return acc;
  }

  torpedoTrail(x: number, y: number) {
    this.foam.add({ x, y: 0.006, z: y, max: 3, s0: 0.02, s1: 0.07, a0: 0.45 });
  }

  /**
   * Gun firing: a flash blown forward along the barrel, smoke puffs pushed out the same way, and a
   * brief light. (dx, dy) points at the target.
   */
  muzzle(x: number, alt: number, y: number, big: number, dx = 0, dy = 0) {
    const l = Math.hypot(dx, dy) || 1;
    const fx = dx / l;
    const fy = dy / l;
    this.glow.add({ x: x + fx * 4 * U, y: alt + 0.03, z: y + fy * 4 * U, vx: fx * 20 * U, vz: fy * 20 * U, max: 0.12, s0: 9 * U * big, s1: 14 * U * big, r: 1, g: 0.9, b: 0.65, a0: 1, r2: 1, g2: 0.35, b2: 0.05, cl: 1, sq: true });
    for (let i = 0; i < 4 * big; i++) {
      const v = rnd(10, 25) * U;
      this.smoke.add({ x: x + fx * 4 * U, y: alt + 0.03, z: y + fy * 4 * U, vx: fx * v + rnd(-2, 2) * U, vy: rnd(1, 4) * U, vz: fy * v + rnd(-2, 2) * U, max: rnd(1.5, 3), s0: 4 * U * big, s1: 16 * U * big, r: 0.62, g: 0.62, b: 0.62, a0: 0.5, drag: 1.5, grav: -1 * U, sq: true });
    }
    if (big >= 1.5) this.light(x + fx * 0.05, alt + 0.1, y + fy * 0.05, 0xffc080, 6 * big, 2.5 * big, 0.12);
    if (big >= 1.5) this.addShake(x, y, 0.05 * big);
  }

  /** Missile launch: a hot flash and a big billowing cloud of white smoke (smaller for SAMs). */
  launch(x: number, alt: number, y: number, sam = false) {
    this.glow.add({ x, y: alt + 0.05, z: y, max: 0.25, s0: (sam ? 16 : 26) * U, s1: (sam ? 24 : 40) * U, r: 1, g: 0.92, b: 0.7, a0: 1, r2: 1, g2: 0.3, b2: 0.04, cl: 1, sq: true });
    for (let i = 0; i < (sam ? 10 : 20); i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(6, 22) * U;
      const g = rnd(0.75, 0.85);
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: Math.cos(a) * v, vy: rnd(0, 8) * U, vz: Math.sin(a) * v, max: rnd(2.5, 4.5), s0: rnd(4, 7) * U, s1: rnd(14, 24) * U, r: g, g, b: g * 0.98, a0: 0.7, drag: 0.9, grav: -1.2 * U, sq: true });
    }
    this.light(x, alt + 0.15, y, 0xffc080, sam ? 10 : 20, (sam ? 180 : 300) * U, 0.6);
    if (!sam) this.addShake(x, y, 0.12);
  }

  /**
   * A hit that blows up (missile, big shell, ship lost). Salvo's recipe: a flash that grows, rising
   * fireball blobs, glowing cores that linger, long black smoke, sparks and debris that arc and die
   * on the water, a water column and foam ring, a light and camera shake.
   */
  explosion(x: number, alt: number, y: number, scale: number, onWater: boolean) {
    const s = Math.max(0.3, scale);
    const y0 = alt + 0.02;
    this.glow.add({ x, y: y0, z: y, max: 0.18, s0: 45 * s * U, s1: 80 * s * U, r: 1, g: 0.85, b: 0.6, a0: 0.85, r2: 1, g2: 0.45, b2: 0.1, cl: 1, sq: true });
    for (let i = 0; i < 40 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = rnd(-0.3, 1);
      const sp = rnd(12, 48) * s * U;
      const rr = Math.sqrt(1 - u * u);
      this.glow.add({ x, y: y0, z: y, vx: Math.cos(a) * rr * sp, vy: u * sp + 10 * U, vz: Math.sin(a) * rr * sp, max: rnd(0.6, 1.6), s0: rnd(10, 18) * s * U, s1: rnd(26, 46) * s * U, r: 1, g: 0.55, b: 0.15, a0: 0.55, r2: 0.4, g2: 0.06, b2: 0.01, cl: 1, drag: 2.2, grav: -7 * U, sq: true });
    }
    for (let i = 0; i < 8; i++) {
      this.glow.add({ x: x + rnd(-6, 6) * s * U, y: y0 + rnd(0, 8) * s * U, z: y + rnd(-6, 6) * s * U, vy: rnd(4, 10) * U, max: rnd(1.4, 2.4), s0: 22 * s * U, s1: 34 * s * U, r: 1, g: 0.42, b: 0.08, a0: 0.55, r2: 0.2, g2: 0.03, b2: 0, cl: 1, drag: 1, grav: -3 * U, sq: true });
    }
    for (let i = 0; i < 22 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(4, 16) * s * U;
      const g = rnd(0.08, 0.2);
      this.smoke.add({ x: x + rnd(-4, 4) * U, y: y0 + rnd(0, 6) * U, z: y + rnd(-4, 4) * U, vx: Math.cos(a) * sp, vy: rnd(6, 18) * U, vz: Math.sin(a) * sp, max: rnd(4, 9), s0: rnd(8, 14) * s * U, s1: rnd(36, 64) * s * U, r: g, g, b: g, a0: 0.85, r2: g * 2.2, g2: g * 2.2, b2: g * 2.2, cl: 1, drag: 0.6, grav: -2.5 * U, sq: true });
    }
    for (let i = 0; i < 30 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(25, 80) * s * U;
      this.glow.add({ x, y: y0 + 2 * U, z: y, vx: Math.cos(a) * sp * 0.6, vy: rnd(20, 70) * s * U, vz: Math.sin(a) * sp * 0.6, max: rnd(0.8, 2), s0: 2.6 * U, s1: 1.6 * U, r: 1, g: 0.85, b: 0.45, a0: 1, r2: 0.9, g2: 0.3, b2: 0.05, cl: 1, drag: 0.4, grav: 40 * U, floor: true, fade: 0.6 });
    }
    for (let i = 0; i < 10 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(15, 45) * s * U;
      this.smoke.add({ x, y: y0 + 2 * U, z: y, vx: Math.cos(a) * sp * 0.6, vy: rnd(20, 50) * U, vz: Math.sin(a) * sp * 0.6, max: rnd(1.2, 2.2), s0: 2.6 * U, s1: 2.4 * U, r: 0.03, g: 0.03, b: 0.03, a0: 1, fade: 0, drag: 0.3, grav: 40 * U, floor: true });
    }
    if (onWater) {
      this.waterColumn(x, y, 0.6 * s);
      this.ring(x, y, 50 * s * U, 1.6, 0.3);
    }
    this.light(x, y0 + 10 * U, y, 0xffa860, 30 * s, 500 * s * U, 0.9);
    this.addShake(x, y, 0.5 * s);
  }

  /** A shell striking a hull: a hard flash, a spray of sparks and a few puffs of smoke. */
  shellHit(x: number, alt: number, y: number) {
    const y0 = alt + 0.03;
    this.glow.add({ x, y: y0, z: y, max: 0.15, s0: 18 * U, s1: 26 * U, r: 1, g: 0.92, b: 0.75, a0: 1, r2: 1, g2: 0.4, b2: 0.05, cl: 1, sq: true });
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(15, 50) * U;
      this.glow.add({ x, y: y0, z: y, vx: Math.cos(a) * sp, vy: rnd(15, 45) * U, vz: Math.sin(a) * sp, max: rnd(0.6, 1.4), s0: 2.4 * U, s1: 1.4 * U, r: 1, g: 0.85, b: 0.45, a0: 1, r2: 0.9, g2: 0.3, b2: 0.05, cl: 1, drag: 0.4, grav: 40 * U, floor: true, fade: 0.6 });
    }
    for (let i = 0; i < 6; i++) {
      const g = rnd(0.12, 0.25);
      this.smoke.add({ x: x + rnd(-2, 2) * U, y: y0, z: y + rnd(-2, 2) * U, vx: rnd(-3, 3) * U, vy: rnd(4, 10) * U, vz: rnd(-3, 3) * U, max: rnd(2, 4), s0: 5 * U, s1: 22 * U, r: g, g, b: g, a0: 0.8, drag: 0.8, grav: -2 * U, sq: true });
    }
    this.light(x, y0 + 0.08, y, 0xffb070, 12, 160 * U, 0.35);
    this.addShake(x, y, 0.08);
  }

  /** A column of white water thrown up and falling back, with a low skirt of spray. */
  waterColumn(x: number, y: number, scale: number) {
    for (let i = 0; i < 40 * scale; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rnd(0, 4) * scale * U;
      const out = rnd(2, 9) * U;
      this.foam.add({ x: x + Math.cos(a) * r, y: 0.01, z: y + Math.sin(a) * r, vx: Math.cos(a) * out, vy: rnd(30, 70) * Math.sqrt(scale) * U, vz: Math.sin(a) * out, max: rnd(1.4, 2.6), s0: rnd(4, 7) * scale * U, s1: rnd(12, 22) * scale * U, r: 0.95, g: 0.97, b: 1, a0: 0.95, drag: 0.5, grav: 32 * U, sq: true });
    }
    for (let i = 0; i < 16 * scale; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(8, 20) * U;
      this.foam.add({ x, y: 0.01, z: y, vx: Math.cos(a) * v, vy: rnd(1, 4) * U, vz: Math.sin(a) * v, max: rnd(2, 4), s0: 6 * scale * U, s1: 26 * scale * U, r: 0.9, g: 0.95, b: 1, a0: 0.7, drag: 1.2, sq: true });
    }
  }

  /** A round landing in the sea: a water column and a foam ring (scale 0.35 small gun ... 0.8 heavy). */
  splash(x: number, y: number, scale = 0.35) {
    this.waterColumn(x, y, scale);
    this.ring(x, y, 34 * scale * U, 1.1, 0.3);

  }

  /** A torpedo hit: a towering column of water, a wide ring, a flash and a smoke pall. */
  torpedoHit(x: number, y: number) {
    this.waterColumn(x, y, 2.2);
    this.ring(x, y, 110 * U, 2.2, 0.35);
    this.glow.add({ x, y: 0.05, z: y, max: 0.25, s0: 40 * U, s1: 60 * U, r: 1, g: 0.9, b: 0.7, a0: 1, r2: 1, g2: 0.4, b2: 0.05, cl: 1, sq: true });
    for (let i = 0; i < 20; i++) {
      const g = rnd(0.1, 0.22);
      this.smoke.add({ x: x + rnd(-4, 4) * U, y: 0.05, z: y + rnd(-4, 4) * U, vx: rnd(-6, 6) * U, vy: rnd(8, 18) * U, vz: rnd(-6, 6) * U, max: rnd(4, 8), s0: 10 * U, s1: 50 * U, r: g, g, b: g, a0: 0.85, drag: 0.6, grav: -2 * U, sq: true });
    }
    this.light(x, 0.2, y, 0xffa860, 30, 400 * U, 0.6);
    this.addShake(x, y, 0.6);
  }

  /**
   * A fire on deck: licking flames and a tall column of black smoke drifting downwind (Salvo's
   * ship fire). Called many times a second while something burns.
   */
  fire(x: number, alt: number, y: number, size: number) {
    if (Math.random() < 0.7) {
      this.glow.add({ x: x + rnd(-1.5, 1.5) * size * U, y: alt + 0.02, z: y + rnd(-1.5, 1.5) * size * U, vy: rnd(6, 14) * U, max: rnd(0.4, 0.8), s0: rnd(4, 7) * size * U, s1: rnd(2, 4) * size * U, r: 1, g: 0.6, b: 0.2, a0: 0.95, r2: 0.6, g2: 0.15, b2: 0.02, cl: 1, grav: -4 * U });
    }
    if (Math.random() < 0.5) {
      const g = rnd(0.05, 0.09);
      this.smoke.add({ x: x + rnd(-1, 1) * U, y: alt + 0.04, z: y + rnd(-1, 1) * U, vx: 2 * U, vy: rnd(8, 14) * U, vz: 0.6 * U, max: rnd(6, 11), s0: rnd(6, 10) * size * U, s1: rnd(40, 80) * size * U, r: g, g, b: g, a0: 0.85, r2: 0.18, g2: 0.18, b2: 0.18, cl: 1, drag: 0.3, grav: -1.5 * U, sq: true });
    }
  }

  /** Chaff: a launcher thump, then a glittering cloud of foil that spreads, drifts and slowly falls. */
  chaff(x: number, alt: number, y: number) {
    this.glow.add({ x, y: alt, z: y, max: 0.25, s0: 0.2, s1: 0.05, r: 1, g: 0.9, b: 0.6, a0: 1 });
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(0.05, 0.4);
      const k = rnd(0.75, 1);
      this.glow.add({ x, y: alt + 0.03, z: y, vx: Math.cos(a) * v, vy: rnd(0.02, 0.2), vz: Math.sin(a) * v, max: rnd(4, 7.5), s0: rnd(0.012, 0.025), s1: 0.008, r: k, g: k, b: k * 1.05, a0: 0.9, drag: 1.2, grav: 0.015 });
    }
    for (let i = 0; i < 6; i++) {
      this.smoke.add({ x: x + rnd(-0.05, 0.05), y: alt + 0.02, z: y + rnd(-0.05, 0.05), vx: rnd(-0.06, 0.06), vy: rnd(0.01, 0.05), vz: rnd(-0.06, 0.06), max: rnd(2, 3.5), s0: 0.05, s1: 0.25, r: 0.85, g: 0.86, b: 0.9, a0: 0.3, drag: 1 });
    }
  }

  /** Smoke grenades bursting around a ground unit. */
  smokeBurst(x: number, alt: number, y: number) {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(0.1, 0.35);
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: Math.cos(a) * v, vy: rnd(0.02, 0.08), vz: Math.sin(a) * v, max: rnd(3, 5), s0: 0.08, s1: 0.55, r: 0.86, g: 0.87, b: 0.85, a0: 0.75, drag: 0.9 });
    }
  }

  /** One puff of a standing smoke screen (white-grey, slowly rising and spreading). */
  smokePuff(x: number, alt: number, y: number, size: number, a0: number) {
    this.smoke.add({ x, y: alt + 0.02, z: y, vx: rnd(-0.02, 0.02) + 0.01, vy: rnd(0.01, 0.04), vz: rnd(-0.02, 0.02), max: rnd(3.5, 5.5), s0: size * 0.4, s1: size, r: 0.84, g: 0.85, b: 0.83, a0, drag: 0.5 });
  }

  /** A missile killed in the air: a real explosion with black smoke, not a spark. */
  intercept(x: number, alt: number, y: number) {
    this.glow.add({ x, y: alt, z: y, max: 0.2, s0: 34 * U, s1: 50 * U, r: 1, g: 0.95, b: 0.8, a0: 1, r2: 1, g2: 0.4, b2: 0.05, cl: 1, sq: true });
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = rnd(-1, 1);
      const rr = Math.sqrt(1 - u * u);
      const sp = rnd(10, 30) * U;
      this.glow.add({ x, y: alt, z: y, vx: Math.cos(a) * rr * sp, vy: u * sp, vz: Math.sin(a) * rr * sp, max: rnd(0.4, 0.9), s0: 6 * U, s1: 16 * U, r: 1, g: 0.6, b: 0.2, a0: 0.95, r2: 0.4, g2: 0.06, b2: 0.01, cl: 1, drag: 2.5, grav: -2 * U, sq: true });
    }
    for (let i = 0; i < 14; i++) {
      const g = rnd(0.07, 0.12);
      this.smoke.add({ x: x + rnd(-3, 3) * U, y: alt, z: y + rnd(-3, 3) * U, vx: rnd(-4, 4) * U, vy: rnd(0, 4) * U, vz: rnd(-4, 4) * U, max: rnd(4, 7), s0: 8 * U, s1: 34 * U, r: g, g, b: g, a0: 0.85, r2: 0.2, g2: 0.2, b2: 0.2, cl: 1, drag: 0.8, sq: true });
    }
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(20, 60) * U;
      this.glow.add({ x, y: alt, z: y, vx: Math.cos(a) * sp, vy: rnd(-10, 30) * U, vz: Math.sin(a) * sp, max: rnd(1, 2.2), s0: 2.4 * U, s1: 1.4 * U, r: 1, g: 0.85, b: 0.45, a0: 1, r2: 0.9, g2: 0.3, b2: 0.05, cl: 1, drag: 0.4, grav: 35 * U, floor: true, fade: 0.6 });
    }
    this.light(x, alt, y, 0xffb070, 25, 450 * U, 0.6);
    this.addShake(x, y, 0.2);
  }

  /** A SAM that missed and self-destructed: a small black puff in the sky. */
  airburst(x: number, alt: number, y: number) {
    this.glow.add({ x, y: alt, z: y, max: 0.15, s0: 20 * U, s1: 30 * U, r: 1, g: 0.9, b: 0.7, a0: 1, r2: 1, g2: 0.4, b2: 0.05, cl: 1, sq: true });
    for (let i = 0; i < 8; i++) {
      const g = rnd(0.1, 0.18);
      this.smoke.add({ x: x + rnd(-2, 2) * U, y: alt, z: y + rnd(-2, 2) * U, vx: rnd(-3, 3) * U, vy: rnd(0, 3) * U, vz: rnd(-3, 3) * U, max: rnd(3, 5), s0: 5 * U, s1: 22 * U, r: g, g, b: g, a0: 0.8, drag: 0.8, sq: true });
    }
    this.light(x, alt, y, 0xffb070, 8, 200 * U, 0.3);
  }

  /** One visible round: a bright head with a short fading tail, flying from muzzle to target. */
  private round(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number, speed: number, r: number, g: number, b: number, size: number) {
    const dx = x1 - x0;
    const dy = a1 - a0;
    const dz = y1 - y0;
    const d = Math.hypot(dx, dy, dz) || 0.001;
    const life = d / speed;
    const vx = (dx / d) * speed;
    const vy = (dy / d) * speed;
    const vz = (dz / d) * speed;
    for (let k = 0; k < 3; k++) {
      const back = k * size * 0.45;
      this.glow.add({ x: x0 - (dx / d) * back, y: a0 - (dy / d) * back, z: y0 - (dz / d) * back, vx, vy, vz, max: life, s0: size * (1 - k * 0.25), s1: size * (1 - k * 0.25), r, g, b, a0: 1 - k * 0.3, fade: 0.2 });
    }
  }

  /** Where a round lands: a spark and a small puff of dust (on land) or spray (on water). */
  private hit(x: number, alt: number, y: number, water: boolean, air: boolean) {
    this.glow.add({ x, y: alt + 0.01, z: y, max: 0.12, s0: 0.07, s1: 0.02, r: 1, g: 0.85, b: 0.5, a0: 1 });
    if (air) return;
    if (water) this.foam.add({ x, y: 0.01, z: y, vy: 0.08, max: 0.6, s0: 0.02, s1: 0.05, a0: 0.7, grav: 0.3 });
    else this.smoke.add({ x, y: alt + 0.01, z: y, vy: 0.03, max: rnd(0.8, 1.4), s0: 0.03, s1: 0.11, r: 0.62, g: 0.55, b: 0.45, a0: 0.5, drag: 1 });
  }

  /**
   * Small arms (rifles, machine guns): a stream of yellow tracers, flickering muzzle flashes and
   * dust kicked up around the target.
   */
  smallArms(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number, water: boolean) {
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this.at(i * 0.11 + Math.random() * 0.04, () => {
        const sx = x0 + rnd(-0.06, 0.06);
        const sy = y0 + rnd(-0.06, 0.06);
        const tx = x1 + rnd(-0.12, 0.12);
        const ty = y1 + rnd(-0.12, 0.12);
        this.glow.add({ x: sx, y: a0 + 0.02, z: sy, max: 0.07, s0: 0.06, s1: 0.03, r: 1, g: 0.8, b: 0.4, a0: 1 });
        this.round(sx, a0 + 0.02, sy, tx, a1 + 0.01, ty, 3.2, 1, 0.82, 0.35, 0.035);
        const d = Math.hypot(tx - sx, ty - sy);
        this.at(d / 3.2, () => this.hit(tx, a1, ty, water, false));
      });
    }
  }

  /** Autocannons and AA guns: fast chains of orange tracers, big flashes, flak puffs at aircraft. */
  autocannon(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number, water: boolean, air: boolean) {
    const n = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      this.at(i * 0.07, () => {
        const tx = x1 + rnd(-0.08, 0.08);
        const ty = y1 + rnd(-0.08, 0.08);
        const ta = a1 + rnd(-0.03, 0.05);
        this.glow.add({ x: x0, y: a0 + 0.03, z: y0, max: 0.06, s0: 0.11, s1: 0.04, r: 1, g: 0.7, b: 0.3, a0: 1 });
        this.round(x0, a0 + 0.03, y0, tx, ta, ty, 4.5, 1, 0.55, 0.2, 0.045);
        const d = Math.hypot(tx - x0, ta - a0, ty - y0);
        this.at(d / 4.5, () => {
          if (air) this.smoke.add({ x: tx, y: ta, z: ty, max: rnd(1, 1.6), s0: 0.04, s1: 0.13, r: 0.25, g: 0.24, b: 0.24, a0: 0.6, drag: 1 });
          this.hit(tx, ta, ty, water, air);
        });
      });
    }
    this.smoke.add({ x: x0, y: a0 + 0.04, z: y0, vy: 0.04, max: 1.2, s0: 0.04, s1: 0.14, r: 0.75, g: 0.75, b: 0.75, a0: 0.35, drag: 1.5 });
  }

  /** A shell landing on land: a fountain of dirt and stones, then a dust cloud. */
  dirt(x: number, alt: number, y: number, size: number) {
    const s = Math.max(0.4, size);
    for (let i = 0; i < 10 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(0.03, 0.16) * s;
      this.smoke.add({ x, y: alt + 0.02, z: y, vx: Math.cos(a) * v, vy: rnd(0.15, 0.4) * s, vz: Math.sin(a) * v, max: rnd(0.8, 1.4), s0: 0.03 * s, s1: 0.05 * s, r: 0.36, g: 0.3, b: 0.24, a0: 0.9, grav: 0.6, drag: 0.5 });
    }
    this.smoke.add({ x, y: alt + 0.03, z: y, vy: 0.04, max: 3, s0: 0.1 * s, s1: 0.4 * s, r: 0.6, g: 0.53, b: 0.43, a0: 0.4, drag: 0.6 });
  }

  tracer(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number) {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      this.glow.add({ x: x0 + (x1 - x0) * t, y: a0 + (a1 - a0) * t + 0.02, z: y0 + (y1 - y0) * t, max: 0.12, s0: 0.03, s1: 0.015, r: 1, g: 0.9, b: 0.55, a0: 1 });
    }
  }

  contrail(x: number, alt: number, y: number) {
    this.smoke.add({ x, y: alt, z: y, max: rnd(2.5, 3.5), s0: 0.015, s1: 0.07, r: 0.95, g: 0.96, b: 0.98, a0: 0.3, drag: 0 });
  }

  dust(x: number, alt: number, y: number) {
    this.smoke.add({ x: x + rnd(-0.08, 0.08), y: alt + 0.01, z: y + rnd(-0.08, 0.08), vy: 0.02, max: 1.6, s0: 0.05, s1: 0.18, r: 0.65, g: 0.6, b: 0.5, a0: 0.25 });
  }

  rainDrop(x: number, y: number, top: number) {
    this.rain.add({ x, y: top, z: y, vy: -2.5, vx: 0.4, max: top / 2.5, s0: 0.012, s1: 0.012, r: 0.75, g: 0.8, b: 0.85, a0: 0.55 });
  }




}
