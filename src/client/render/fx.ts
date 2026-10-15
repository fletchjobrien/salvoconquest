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
      this.col[i * 4 + 3] = p.a0 * (1 - t) * Math.min(1, p.life * 12);
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

  update(dt: number) {
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
    this.smoke.add({ x: x + rnd(-0.01, 0.01), y: alt, z: y + rnd(-0.01, 0.01), vy: 0.01, max: rnd(2.5, 4), s0: 0.04, s1: 0.22, r: 0.85, g: 0.86, b: 0.86, a0: 0.55, drag: 1 });
    this.glow.add({ x, y: alt, z: y, max: 0.12, s0: 0.07, s1: 0.03, r: 1, g: hostile ? 0.55 : 0.85, b: hostile ? 0.25 : 0.5, a0: 1 });
  }

  samTrail(x: number, alt: number, y: number) {
    this.smoke.add({ x, y: alt, z: y, vy: 0.005, max: rnd(1.5, 2.5), s0: 0.03, s1: 0.14, r: 0.95, g: 0.95, b: 0.95, a0: 0.5, drag: 1 });
    this.glow.add({ x, y: alt, z: y, max: 0.1, s0: 0.05, s1: 0.02, r: 1, g: 0.9, b: 0.7, a0: 1 });
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
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: rnd(-0.05, 0.05), vy: rnd(0.02, 0.06), vz: rnd(-0.05, 0.05), max: rnd(1.2, 2.2), s0: 0.06 * big, s1: 0.25 * big, r: 0.8, g: 0.8, b: 0.8, a0: 0.5, drag: 1.5 });
    }
  }

  launch(x: number, alt: number, y: number) {
    for (let i = 0; i < 14; i++) {
      this.smoke.add({ x, y: alt + 0.03, z: y, vx: rnd(-0.08, 0.08), vy: rnd(0.0, 0.1), vz: rnd(-0.08, 0.08), max: rnd(2, 4), s0: 0.08, s1: 0.4, r: 0.88, g: 0.88, b: 0.86, a0: 0.55, drag: 1.2 });
    }
    this.glow.add({ x, y: alt + 0.05, z: y, max: 0.25, s0: 0.3, s1: 0.1, r: 1, g: 0.8, b: 0.4, a0: 1 });
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

  tracer(x0: number, a0: number, y0: number, x1: number, a1: number, y1: number) {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      this.glow.add({ x: x0 + (x1 - x0) * t, y: a0 + (a1 - a0) * t + 0.02, z: y0 + (y1 - y0) * t, max: 0.12, s0: 0.03, s1: 0.015, r: 1, g: 0.9, b: 0.55, a0: 1 });
    }
  }

  dust(x: number, alt: number, y: number) {
    this.smoke.add({ x: x + rnd(-0.08, 0.08), y: alt + 0.01, z: y + rnd(-0.08, 0.08), vy: 0.02, max: 1.6, s0: 0.05, s1: 0.18, r: 0.65, g: 0.6, b: 0.5, a0: 0.25 });
  }

  rainDrop(x: number, y: number, top: number) {
    this.rain.add({ x, y: top, z: y, vy: -2.5, vx: 0.4, max: top / 2.5, s0: 0.012, s1: 0.012, r: 0.75, g: 0.8, b: 0.85, a0: 0.55 });
  }

  fogPuff(x: number, alt: number, y: number, r: number) {
    this.smoke.add({ x, y: alt, z: y, vx: rnd(-0.02, 0.02), vz: rnd(-0.02, 0.02), max: rnd(6, 10), s0: r * 0.6, s1: r, r: 0.86, g: 0.88, b: 0.9, a0: 0.08, drag: 0 });
  }

  cloud(x: number, alt: number, y: number, r: number, dark: number) {
    const c = 0.55 - dark * 0.35;
    this.smoke.add({ x, y: alt, z: y, vx: rnd(-0.02, 0.02), vz: rnd(-0.02, 0.02), max: rnd(5, 9), s0: r * 0.7, s1: r, r: c, g: c + 0.02, b: c + 0.05, a0: 0.35, drag: 0 });
  }
}
