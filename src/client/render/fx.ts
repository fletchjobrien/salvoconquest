// GPU point particles: wakes, smoke, fire, trails, splashes, rain. Point sprites look great pixelated.
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float size;
attribute vec4 color;
varying vec4 vColor;
uniform float scale;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
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
      uniforms: { scale: { value: 300 }, soft: { value: soft } },
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
        const k = Math.min(1, t * 2);
        r += (p.r2 - r) * k;
        g += (p.g2 - g) * k;
        b += (p.b2 - b) * k;
      }
      this.col[i * 4] = r;
      this.col[i * 4 + 1] = g;
      this.col[i * 4 + 2] = b;
      this.col[i * 4 + 3] = p.a0 * (1 - t * p.fade) * Math.min(1, p.life * 12);
      this.size[i] = p.s0 + (p.s1 - p.s0) * t;
    }
    this.geo.setDrawRange(0, w);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Fx {
  group = new THREE.Group();
  smoke = new Pool(5000, false);
  foam = new Pool(5000, false);
  glow = new Pool(3000, true);
  rain = new Pool(2500, false, 0);

  constructor() {
    this.group.add(this.foam.points, this.smoke.points, this.glow.points, this.rain.points);
    this.foam.points.renderOrder = 1;
    this.smoke.points.renderOrder = 2;
    this.glow.points.renderOrder = 3;
  }

  setScale(viewportHeight: number, fovDeg: number) {
    const s = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    for (const p of [this.smoke, this.foam, this.glow, this.rain]) p.mat.uniforms.scale.value = s;
  }

  private clock = 0;
  private later: { t: number; fn: () => void }[] = [];

  /** Run an emitter a little later (staggered bursts of fire). */
  private at(delay: number, fn: () => void) {
    this.later.push({ t: this.clock + delay, fn });
  }

  update(dt: number) {
    this.clock += dt;
    if (this.later.length) {
      const due = this.later.filter((l) => l.t <= this.clock);
      if (due.length) {
        this.later = this.later.filter((l) => l.t > this.clock);
        for (const l of due) l.fn();
      }
    }
    this.smoke.update(dt);
    this.foam.update(dt);
    this.glow.update(dt);
    this.rain.update(dt);
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

  missileTrail(x: number, alt: number, y: number, hostile: boolean) {
    this.smoke.add({ x: x + rnd(-0.006, 0.006), y: alt, z: y + rnd(-0.006, 0.006), vy: 0.008, max: rnd(3, 4.5), s0: 0.035, s1: 0.15, r: 0.7, g: 0.7, b: 0.7, a0: 0.5, drag: 1 });
    this.glow.add({ x, y: alt, z: y, max: 0.12, s0: 0.07, s1: 0.03, r: 1, g: hostile ? 0.55 : 0.85, b: hostile ? 0.25 : 0.5, a0: 1 });
  }

  /** Anti-air missiles: a thin, quick-fading white streak and an ice-blue motor, unlike the
   *  heavy grey smoke and orange flame of an anti-ship missile. */
  samTrail(x: number, alt: number, y: number) {
    this.smoke.add({ x, y: alt, z: y, max: rnd(0.7, 1.1), s0: 0.012, s1: 0.035, r: 1, g: 1, b: 1, a0: 0.55, drag: 1 });
    this.glow.add({ x, y: alt, z: y, max: 0.09, s0: 0.06, s1: 0.02, r: 0.55, g: 0.85, b: 1, a0: 1 });
  }

  torpedoTrail(x: number, y: number) {
    this.foam.add({ x, y: 0.006, z: y, max: 3, s0: 0.02, s1: 0.07, a0: 0.45 });
  }

  shellDot(x: number, alt: number, y: number) {
    this.glow.add({ x, y: alt, z: y, max: 0.08, s0: 0.035, s1: 0.02, r: 1, g: 0.85, b: 0.5, a0: 0.9 });
  }

  muzzle(x: number, alt: number, y: number, big: number) {
    this.glow.add({ x, y: alt + 0.03, z: y, max: 0.15, s0: 0.12 * big, s1: 0.3 * big, r: 1, g: 0.85, b: 0.5, a0: 1 });
    for (let i = 0; i < 4 * big; i++) {
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: rnd(-0.04, 0.04), vy: rnd(0.02, 0.05), vz: rnd(-0.04, 0.04), max: rnd(1.0, 1.8), s0: 0.03 * big, s1: 0.14 * big, r: 0.8, g: 0.8, b: 0.8, a0: 0.45, drag: 1.5 });
    }
  }

  launch(x: number, alt: number, y: number) {
    for (let i = 0; i < 9; i++) {
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: rnd(-0.05, 0.05), vy: rnd(0.02, 0.12), vz: rnd(-0.05, 0.05), max: rnd(1.8, 3.2), s0: 0.04, s1: 0.2, r: 0.9, g: 0.9, b: 0.88, a0: 0.5, drag: 1.4 });
    }
    this.glow.add({ x, y: alt + 0.05, z: y, max: 0.22, s0: 0.18, s1: 0.06, r: 1, g: 0.8, b: 0.4, a0: 1 });
  }

  explosion(x: number, alt: number, y: number, size: number, onWater: boolean) {
    const s = Math.max(0.3, size);
    this.glow.add({ x, y: alt + 0.05, z: y, max: 0.35, s0: 0.9 * s, s1: 0.2 * s, r: 1, g: 0.95, b: 0.8, a0: 1 });
    for (let i = 0; i < 18 * s; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rnd(0.05, 0.35) * s;
      this.glow.add({ x, y: alt + 0.03, z: y, vx: Math.cos(a) * v, vy: rnd(0.05, 0.3) * s, vz: Math.sin(a) * v, max: rnd(0.3, 0.8), s0: 0.12 * s, s1: 0.02, r: 1, g: rnd(0.45, 0.8), b: 0.15, a0: 1, drag: 2.5, grav: 0.3, r2: 0.6, g2: 0.15, b2: 0.05 });
    }
    for (let i = 0; i < 10 * s; i++) {
      this.smoke.add({ x: x + rnd(-0.05, 0.05) * s, y: alt + 0.05, z: y + rnd(-0.05, 0.05) * s, vx: rnd(-0.04, 0.04), vy: rnd(0.04, 0.12), vz: rnd(-0.04, 0.04), max: rnd(3, 6), s0: 0.15 * s, s1: 0.7 * s, r: 0.22, g: 0.21, b: 0.2, a0: 0.75, drag: 0.8 });
    }
    if (onWater) this.splash(x, y, s * 0.8);
  }

  splash(x: number, y: number, size = 0.6) {
    // A narrow column of spray that rises and collapses.
    for (let i = 0; i < 14 * size + 4; i++) {
      this.foam.add({ x: x + rnd(-0.02, 0.02), y: 0.01, z: y + rnd(-0.02, 0.02), vx: rnd(-0.03, 0.03) * size, vy: rnd(0.15, 0.45) * size, vz: rnd(-0.03, 0.03) * size, max: rnd(0.9, 1.6), s0: 0.025 * size + 0.01, s1: 0.07 * size + 0.02, a0: 0.9, grav: 0.45, drag: 0.6 });
    }
    this.foam.add({ x, y: 0.005, z: y, max: 1.6, s0: 0.04 * size, s1: 0.22 * size, a0: 0.35 });
  }

  fire(x: number, alt: number, y: number, size: number) {
    this.glow.add({ x: x + rnd(-0.03, 0.03) * size, y: alt + 0.04, z: y + rnd(-0.03, 0.03) * size, vy: rnd(0.02, 0.06), max: rnd(0.3, 0.7), s0: 0.08 * size, s1: 0.02, r: 1, g: rnd(0.4, 0.7), b: 0.1, a0: 0.9 });
    this.smoke.add({ x: x + rnd(-0.03, 0.03) * size, y: alt + 0.08, z: y + rnd(-0.03, 0.03) * size, vx: 0.03, vy: rnd(0.08, 0.14), vz: 0.01, max: rnd(4, 7), s0: 0.08 * size, s1: 0.6 * size, r: 0.16, g: 0.15, b: 0.15, a0: 0.65, drag: 0.3 });
  }

  intercept(x: number, alt: number, y: number) {
    this.glow.add({ x, y: alt, z: y, max: 0.3, s0: 0.5, s1: 0.1, r: 1, g: 1, b: 0.85, a0: 1 });
    for (let i = 0; i < 10; i++) {
      this.glow.add({ x, y: alt, z: y, vx: rnd(-0.3, 0.3), vy: rnd(-0.1, 0.3), vz: rnd(-0.3, 0.3), max: rnd(0.3, 0.6), s0: 0.04, s1: 0.01, r: 1, g: 0.8, b: 0.4, a0: 1, grav: 0.4 });
    }
    this.smoke.add({ x, y: alt, z: y, max: 4, s0: 0.12, s1: 0.5, r: 0.5, g: 0.5, b: 0.5, a0: 0.4 });
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
