// Ship wakes as flat ribbons on the water: a turbulent centre line plus Kelvin arms that spread with age.
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec3 wake; // x = lateral (-1..1), y = age 0..1, z = strength
varying vec3 vW;
void main() {
  vW = wake;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const FRAG = /* glsl */ `
varying vec3 vW;
uniform vec3 foam;
void main() {
  float lat = abs(vW.x);
  float age = vW.y;
  float arms = smoothstep(0.55, 0.92, lat) * (1.0 - smoothstep(0.92, 1.0, lat));
  float centre = (1.0 - smoothstep(0.0, 0.35 + age * 0.4, lat)) * (1.0 - age) * 1.2;
  float a = max(arms * 0.8, centre) * (1.0 - age) * vW.z;
  if (a < 0.04) discard;
  gl_FragColor = vec4(foam, min(0.85, a));
}
`;

interface Pt {
  x: number;
  y: number;
  h: number;
  t: number;
  w: number;
  s: number;
}

const LIFE = 9;
const MAX_PTS = 48;

export class Wakes {
  readonly mesh: THREE.Mesh;
  private trails = new Map<number, Pt[]>();
  private pos: Float32Array;
  private attr: Float32Array;
  private idx: Uint32Array;
  private geo = new THREE.BufferGeometry();
  private cap = 0;

  constructor(foam: number) {
    this.pos = new Float32Array(0);
    this.attr = new Float32Array(0);
    this.idx = new Uint32Array(0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { foam: { value: new THREE.Color(foam) } },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  /** Record a sample for a moving ship. width = beam-ish size in km, strength 0..1. */
  sample(id: number, x: number, y: number, h: number, time: number, width: number, strength: number) {
    let tr = this.trails.get(id);
    if (!tr) this.trails.set(id, (tr = []));
    const last = tr[tr.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 0.06 && time - last.t < 0.5) {
      // Keep the head glued to the stern.
      last.x = x;
      last.y = y;
      last.h = h;
      return;
    }
    tr.push({ x, y, h, t: time, w: width, s: strength });
    if (tr.length > MAX_PTS) tr.shift();
  }

  update(time: number) {
    let quads = 0;
    for (const [id, tr] of this.trails) {
      while (tr.length && time - tr[0].t > LIFE) tr.shift();
      if (tr.length < 2) {
        if (!tr.length) this.trails.delete(id);
        continue;
      }
      quads += tr.length - 1;
    }
    const verts = quads * 4;
    if (verts > this.cap) {
      this.cap = Math.ceil(verts * 1.5) + 64;
      this.pos = new Float32Array(this.cap * 3);
      this.attr = new Float32Array(this.cap * 3);
      this.idx = new Uint32Array((this.cap / 4) * 6);
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('wake', new THREE.BufferAttribute(this.attr, 3));
      this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1));
    }
    let v = 0;
    let k = 0;
    const put = (p: Pt, side: number) => {
      const age = Math.min(1, (time - p.t) / LIFE);
      const half = p.w * (0.5 + age * 3.2);
      const nx = -Math.sin(p.h) * side * half;
      const ny = Math.cos(p.h) * side * half;
      this.pos[v * 3] = p.x + nx;
      this.pos[v * 3 + 1] = 0.004;
      this.pos[v * 3 + 2] = p.y + ny;
      this.attr[v * 3] = side;
      this.attr[v * 3 + 1] = age;
      this.attr[v * 3 + 2] = p.s;
      v++;
    };
    for (const tr of this.trails.values()) {
      for (let i = 0; i < tr.length - 1; i++) {
        const a = tr[i];
        const b = tr[i + 1];
        const base = v;
        put(a, -1);
        put(a, 1);
        put(b, -1);
        put(b, 1);
        this.idx[k++] = base;
        this.idx[k++] = base + 2;
        this.idx[k++] = base + 1;
        this.idx[k++] = base + 1;
        this.idx[k++] = base + 2;
        this.idx[k++] = base + 3;
      }
    }
    this.geo.setDrawRange(0, k);
    if (this.geo.attributes.position) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.wake as THREE.BufferAttribute).needsUpdate = true;
      this.geo.index!.needsUpdate = true;
    }
  }
}
