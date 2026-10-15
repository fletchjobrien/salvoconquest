// Volumetric-looking weather built from a few cheap layers:
// - storms: two drifting cloud decks, slanted rain shafts beneath them, forked lightning
// - fog banks: stacked low layers that hug the sea, so hulls fade out and peaks stick out
import * as THREE from 'three';
import { weatherUniforms, WEATHER_FUNCS, WEATHER_UNIFORMS_GLSL } from './weatherfx';
import type { WeatherRow } from '../../shared/protocol';
import { weatherOutline } from '../../shared/weather';

const MAX = 6;
const CLOUD_Y = [2.5, 3.6];
const FOG_Y = [0.02, 0.12, 0.26, 0.45, 0.7];
const SHAFTS = 7;

const WORLD_VERT = /* glsl */ `
varying vec3 vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CLOUD_FRAG = /* glsl */ `
${WEATHER_UNIFORMS_GLSL}
${WEATHER_FUNCS}
uniform vec4 uCell;
uniform float uLayer;
uniform vec4 uFlash; // x, y, radius, strength
uniform vec2 uSun;   // sun direction on the ground plane
varying vec3 vW;
void main() {
  vec2 p = vW.xz;
  float d = stormCover(uCell, p, uLayer);
  // Capped opacity: the cloud tops read clearly but ships and islands always show through.
  float a = smoothstep(0.06, 0.5, d) * (uLayer < 0.5 ? 0.5 : 0.28);
  // Opaque from high up; thins out as you zoom in so the battle below stays readable.
  a *= smoothstep(vW.y + 6.0, vW.y + 60.0, cameraPosition.y);
  if (a < 0.02) discard;
  // Fake sunlight: sides facing the sun are bright, lee sides and cores fall into shadow.
  float d2 = stormCover(uCell, p + uSun * 0.7, uLayer);
  float light = clamp(0.55 + (d - d2) * 3.0, 0.0, 1.0);
  vec3 shadowCol = uLayer < 0.5 ? vec3(0.2, 0.22, 0.26) : vec3(0.36, 0.39, 0.44);
  vec3 topCol = uLayer < 0.5 ? vec3(0.62, 0.64, 0.68) : vec3(0.86, 0.87, 0.9);
  vec3 col = mix(shadowCol, topCol, light);
  col *= 0.85 + 0.15 * wxFbm((p - wWind * wTime) * 1.3 + uLayer * 5.0);
  col = mix(col, shadowCol * 0.8, smoothstep(0.55, 0.95, d) * 0.4);
  // Lightning lights the cloud from inside.
  float fl = uFlash.w * exp(-dot(p - uFlash.xy, p - uFlash.xy) / (uFlash.z * uFlash.z));
  col += vec3(0.7, 0.75, 1.0) * fl * (0.3 + d * 0.7);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

const SHAFT_FRAG = /* glsl */ `
${WEATHER_UNIFORMS_GLSL}
${WEATHER_FUNCS}
uniform float uSeed;
uniform float uStrength;
uniform float uWidth;
varying vec3 vW;
varying vec2 vUv;
void main() {
  // Streaky curtain of falling rain, thicker near the cloud base.
  float streak = wxNoise(vec2(vUv.x * uWidth * 9.0 + uSeed, vUv.y * 2.5 + wTime * 3.0));
  float veil = 0.55 + 0.45 * smoothstep(0.3, 0.85, streak);
  float side = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
  float vert = mix(0.55, 1.0, vUv.y) * smoothstep(0.0, 0.08, vUv.y);
  // Hide shafts right next to the camera; the screen-space rain covers that case.
  float camD = length(cameraPosition.xz - vW.xz);
  float a = uStrength * 0.2 * veil * side * vert * smoothstep(2.0, 6.0, camD);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.36, 0.4, 0.45), a);
  #include <colorspace_fragment>
}
`;

const FOG_FRAG = /* glsl */ `
${WEATHER_UNIFORMS_GLSL}
${WEATHER_FUNCS}
uniform vec4 uCell;
uniform float uLayer;
varying vec3 vW;
void main() {
  vec2 p = vW.xz;
  float d = fogCover(uCell, p, uLayer);
  // Upper layers are thinner and only exist over the dense core.
  // Five thin layers add up to about half opacity at the densest point.
  float a = smoothstep(0.1 + uLayer * 0.08, 0.8, d) * (0.17 - uLayer * 0.025);
  if (a < 0.01) discard;
  float lum = 0.97 + (wxFbm(p * 0.6 + uLayer * 3.0 - wWind * wTime) - 0.5) * 0.12 + uLayer * 0.02;
  gl_FragColor = vec4(wFogColor * lum, a);
  #include <colorspace_fragment>
}
`;

interface StormSet {
  decks: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[];
  shafts: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
}
interface FogSet {
  layers: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[];
}
interface Bolt {
  line: THREE.LineSegments;
  t: number;
}

function flatPlane(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A slanted vertical quad, base at y=0, top at y=1, x in -0.5..0.5 (uv.x across, uv.y up). */
function shaftGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const slant = 0.35;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5 + slant, 1, 0, 0.5 + slant, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

export class WeatherView {
  readonly group = new THREE.Group();
  private storms: StormSet[] = [];
  private fogs: FogSet[] = [];
  private bolts: Bolt[] = [];
  private flash = new THREE.Vector4(0, 0, 4, 0);
  private sun = new THREE.Vector2(1, 0);
  private boltMat = new THREE.LineBasicMaterial({ color: 0xf2f5ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

  constructor(sunDir: [number, number, number]) {
    this.sun.set(sunDir[0], sunDir[2]).normalize();
    const common = { ...weatherUniforms };
    const plane = flatPlane();
    const shaft = shaftGeometry();
    for (let i = 0; i < MAX; i++) {
      const decks = CLOUD_Y.map((y, layer) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: WORLD_VERT,
          fragmentShader: CLOUD_FRAG,
          uniforms: { ...common, uCell: { value: new THREE.Vector4() }, uLayer: { value: layer }, uFlash: { value: this.flash }, uSun: { value: this.sun } },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(plane, mat);
        m.position.y = y;
        m.renderOrder = 20 + layer;
        m.frustumCulled = false;
        return m;
      });
      const shafts = Array.from({ length: SHAFTS }, (_, k) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: WORLD_VERT,
          fragmentShader: SHAFT_FRAG,
          uniforms: { ...common, uSeed: { value: i * 13.7 + k * 5.3 }, uStrength: { value: 0 }, uWidth: { value: 3 } },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(shaft, mat);
        m.renderOrder = 15;
        m.frustumCulled = false;
        return m;
      });
      this.storms.push({ decks, shafts });
      const layers = FOG_Y.map((y, layer) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: WORLD_VERT,
          fragmentShader: FOG_FRAG,
          uniforms: { ...common, uCell: { value: new THREE.Vector4() }, uLayer: { value: layer } },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(plane, mat);
        m.position.y = y;
        m.renderOrder = 10 + layer;
        m.frustumCulled = false;
        return m;
      });
      this.fogs.push({ layers });
      for (const m of [...decks, ...shafts, ...layers]) {
        m.visible = false;
        this.group.add(m);
      }
    }
  }

  update(dt: number, cells: WeatherRow[], camera: THREE.Camera) {
    let si = 0;
    let fi = 0;
    for (const [kind, x, y, r, i] of cells) {
      const inten = i / 100;
      if (kind === 0 && si < MAX) {
        const s = this.storms[si++];
        for (const d of s.decks) {
          d.visible = inten > 0.02;
          d.position.x = x;
          d.position.z = y;
          d.scale.set(r * 4, 1, r * 4);
          d.material.uniforms.uCell.value.set(x, y, r, inten);
        }
        s.shafts.forEach((m, k) => {
          // Shafts sit at fixed spots inside the cell (golden-angle spiral) and drift with it.
          const a = k * 2.399 + si * 1.3;
          const rr = 0.62 * Math.sqrt((k + 0.5) / SHAFTS);
          const width = r * (0.22 + 0.12 * ((k * 7) % 3));
          m.visible = inten > 0.05;
          const [px, py] = weatherOutline(0, x, y, r * rr, a);
          m.position.set(px, 0, py);
          m.scale.set(width, CLOUD_Y[0] + 0.1, 1);
          // Cylindrical billboard: face the camera around the vertical axis.
          m.rotation.y = Math.atan2(camera.position.x - m.position.x, camera.position.z - m.position.z);
          m.material.uniforms.uStrength.value = inten * (0.6 + 0.4 * Math.sin(k * 3.1 + si));
          m.material.uniforms.uWidth.value = width;
        });
      } else if (kind === 1 && fi < MAX) {
        const f = this.fogs[fi++];
        for (const l of f.layers) {
          l.visible = inten > 0.02;
          l.position.x = x;
          l.position.z = y;
          l.scale.set(r * 4.2, 1, r * 4.2);
          l.material.uniforms.uCell.value.set(x, y, r, inten);
        }
      }
    }
    for (; si < MAX; si++) for (const m of [...this.storms[si].decks, ...this.storms[si].shafts]) m.visible = false;
    for (; fi < MAX; fi++) for (const m of this.fogs[fi].layers) m.visible = false;

    // Lightning: flicker twice, then fade the in-cloud glow.
    for (const b of this.bolts) {
      b.t += dt;
      const on = b.t < 0.07 || (b.t > 0.12 && b.t < 0.19) || (b.t > 0.26 && b.t < 0.3);
      (b.line.material as THREE.LineBasicMaterial).opacity = on ? 1 : 0;
    }
    this.bolts = this.bolts.filter((b) => {
      if (b.t < 0.4) return true;
      this.group.remove(b.line);
      b.line.geometry.dispose();
      (b.line.material as THREE.Material).dispose();
      return false;
    });
    this.flash.w = Math.max(0, this.flash.w - dt * 3);
  }

  /** Forked bolt from the cloud base to the sea, plus a glow inside the cloud deck. */
  lightning(x: number, y: number) {
    const pts: number[] = [];
    const branch = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, segs: number, jit: number, depth: number) => {
      let px = sx;
      let py = sy;
      let pz = sz;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const k = i === segs ? 0 : jit * (1 - t * 0.5);
        const nx = sx + (ex - sx) * t + (Math.random() - 0.5) * k;
        const ny = sy + (ey - sy) * t;
        const nz = sz + (ez - sz) * t + (Math.random() - 0.5) * k;
        pts.push(px, py, pz, nx, ny, nz);
        if (depth < 1 && i > 1 && i < segs - 2 && Math.random() < 0.25) {
          branch(nx, ny, nz, nx + (Math.random() - 0.5) * 1.6, ny - 0.6 - Math.random() * 0.6, nz + (Math.random() - 0.5) * 1.6, 4, jit * 0.6, depth + 1);
        }
        px = nx;
        py = ny;
        pz = nz;
      }
    };
    const top = CLOUD_Y[0];
    branch(x + (Math.random() - 0.5) * 1.2, top, y + (Math.random() - 0.5) * 1.2, x, 0, y, 14, 0.7, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineSegments(g, this.boltMat.clone());
    line.renderOrder = 30;
    line.frustumCulled = false;
    this.group.add(line);
    this.bolts.push({ line, t: 0 });
    this.flash.set(x, y, 2.6, 0.7);
  }
}
