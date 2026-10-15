// Island terrain (flat-shaded low poly), animated water, and scattered props.
import * as THREE from 'three';
import { GameMap, heightAt } from '../../shared/map';
import { Palette } from '../theme';
import { Rng, fbm } from '../../shared/rng';
import { patchMaterial, weatherUniforms, WEATHER_FUNCS, WEATHER_UNIFORMS_GLSL } from './weatherfx';

export const VSCALE = 2.4; // vertical exaggeration for terrain

const WATER_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D depthMap;
uniform float mapSize;
uniform float time;
uniform vec3 deep;
uniform vec3 mid;
uniform vec3 shallow;
uniform vec3 foam;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
varying vec3 vWorld;
${WEATHER_UNIFORMS_GLSL}
${WEATHER_FUNCS}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 p = vWorld.xz;
  vec2 uv = p / mapSize;
  float depth = 1.0;
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) { depth = texture2D(depthMap, uv).r; depth *= depth; }
  float storm = stormGloom(p);
  float shade = cloudShadow(p);
  float fogb = fogAt(p);
  // Waves -> normal. Storm seas are steeper and wind-driven.
  float amp = 0.35 + storm * 1.6;
  float t = time;
  vec2 g = vec2(0.0);
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 3.1 + t * 1.3) * 0.5;
  g += vec2(-0.5, 0.9) * cos(dot(p, vec2(-0.5, 0.9)) * 4.7 + t * 1.7) * 0.35;
  g += vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 9.3 + t * 2.3) * 0.18;
  g += (vec2(noise(p * 2.3 + t * 0.2), noise(p * 2.3 - t * 0.17)) - 0.5) * 0.8;
  vec3 n = normalize(vec3(-g.x * amp * 0.12, 1.0, -g.y * amp * 0.12));
  // Colour by depth.
  vec3 col = mix(shallow, mid, smoothstep(0.0, 0.12, depth));
  col = mix(col, deep, smoothstep(0.1, 0.55, depth));
  // Caustic shimmer in the shallows.
  float caust = noise(p * 6.0 + vec2(t * 0.4, -t * 0.3)) * noise(p * 5.0 - vec2(t * 0.3, t * 0.2));
  col += vec3(0.10, 0.14, 0.12) * smoothstep(0.25, 0.6, caust) * (1.0 - smoothstep(0.0, 0.08, depth));
  // Lighting.
  float diff = clamp(dot(n, normalize(sunDir)), 0.0, 1.0);
  col *= 0.78 + 0.32 * diff;
  // Sun glint: a soft glow where the sun reflects, broken into sparkles by the waves.
  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec3 h = normalize(normalize(sunDir) + viewDir);
  float area = pow(clamp(h.y, 0.0, 1.0), 220.0);
  float spec = pow(clamp(dot(n, h), 0.0, 1.0), 600.0);
  float sparkle = step(0.8, noise(p * 16.0 + vec2(t * 1.3, -t * 0.9))) * step(0.45, noise(p * 2.7 - t * 0.25));
  col += sunColor * (area * 0.12 + (area * 0.6 + spec) * sparkle * 0.55) * (1.0 - storm);
  // Shore foam: a solid lip at the waterline plus thin bands rolling in.
  float lip = 1.0 - smoothstep(0.0, 0.006, depth);
  float near = 1.0 - smoothstep(0.004, 0.03, depth);
  float band = step(0.82, sin(depth * 420.0 - t * 1.8 + noise(p * 2.5) * 5.0));
  float breakup = step(0.45, noise(p * 7.0 + vec2(t * 0.3, 0.0)));
  float foamAmt = max(lip * 0.9, near * band * breakup * 0.7);
  col = mix(col, foam, clamp(foamAmt, 0.0, 1.0));
  // Whitecaps in storms: sparse wind-streaked flecks.
  vec2 wp = vec2(p.x * 9.0 + p.y * 3.0, p.y * 22.0 - p.x * 4.0);
  float caps = step(0.95 - storm * 0.04, noise(wp + vec2(t * 2.1, t * 0.7))) * step(0.45, noise(p * 1.7 - t * 0.15)) * storm;
  col = mix(col, foam, caps * 0.45);
  // Storm: grey-green overcast sea, darkest under the thick cloud.
  vec3 gloomy = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))) * vec3(0.8, 0.95, 0.95), 0.6);
  col = mix(col, gloomy * 0.55, storm * 0.8);
  col *= 1.0 - shade * 0.45;
  // Wind streaks along the storm.
  float streak = wxNoise(vec2(dot(p, vec2(0.93, 0.37)) * 1.6, dot(p, vec2(-0.37, 0.93)) * 30.0) + t * vec2(0.4, 0.0));
  col = mix(col, foam * 0.8, smoothstep(0.86, 0.98, streak) * storm * 0.12);
  // Fog banks sit on the water.
  col = mix(col, wFogColor, fogb * 0.4);
  // Distance fog.
  float fd = length(cameraPosition - vWorld);
  float f = smoothstep(fogNear, fogFar, fd);
  col = mix(col, fogColor, f);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class TerrainView {
  group = new THREE.Group();
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  props: THREE.InstancedMesh[] = [];

  constructor(
    readonly map: GameMap,
    readonly pal: Palette,
  ) {
    this.group.add(this.buildTerrain());
    const wm = this.buildWater();
    this.waterMat = wm.mat;
    this.water = wm.mesh;
    this.group.add(this.water);
    for (const m of this.buildProps()) {
      this.props.push(m);
      this.group.add(m);
    }
  }

  private buildTerrain(): THREE.Mesh {
    const map = this.map;
    const pal = this.pal;
    const step = 2; // sample every 2 height cells (0.5 km)
    const n = map.hn;
    const pos: number[] = [];
    const col: number[] = [];
    const cSand = new THREE.Color(pal.sand);
    const cLow = new THREE.Color(pal.low);
    const cHigh = new THREE.Color(pal.high);
    const cRock = new THREE.Color(pal.rock);
    const cPeak = new THREE.Color(pal.peak);
    const cBed = new THREE.Color(pal.shallow).multiplyScalar(0.8);
    const tmp = new THREE.Color();
    const hAt = (i: number, j: number) => map.height[Math.min(n - 1, j) * n + Math.min(n - 1, i)];
    const colorFor = (h: number, slope: number, x: number, y: number) => {
      const nz = fbm(x * 0.6, y * 0.6, 77, 2) - 0.5;
      if (h < 0) return tmp.copy(cBed);
      const hh = h + nz * 0.06;
      if (hh < 0.025) tmp.copy(cSand);
      else if (hh < 0.18) tmp.copy(cLow).lerp(cHigh, (hh - 0.025) / 0.155);
      else if (hh < 0.42) tmp.copy(cHigh).lerp(cRock, (hh - 0.18) / 0.24);
      else tmp.copy(cRock).lerp(cPeak, Math.min(1, (hh - 0.42) / 0.15));
      if (slope > 0.35 && hh > 0.03) tmp.lerp(cRock, Math.min(0.7, (slope - 0.35) * 1.2));
      tmp.multiplyScalar(1 + nz * 0.25);
      return tmp;
    };
    for (let j = 0; j < n - 1; j += step) {
      for (let i = 0; i < n - 1; i += step) {
        const h00 = hAt(i, j);
        const h10 = hAt(i + step, j);
        const h01 = hAt(i, j + step);
        const h11 = hAt(i + step, j + step);
        if (Math.max(h00, h10, h01, h11) < -0.03) continue;
        const x0 = i / map.hres;
        const x1 = (i + step) / map.hres;
        const y0 = j / map.hres;
        const y1 = (j + step) / map.hres;
        const v = (h: number) => (h > 0 ? h * VSCALE : h * 0.6) ;
        const tris: [number, number, number][][] = [
          [
            [x0, v(h00), y0],
            [x0, v(h01), y1],
            [x1, v(h10), y0],
          ],
          [
            [x1, v(h10), y0],
            [x0, v(h01), y1],
            [x1, v(h11), y1],
          ],
        ];
        for (const t of tris) {
          const hm = (t[0][1] + t[1][1] + t[2][1]) / 3 / VSCALE;
          const ax = t[1][0] - t[0][0];
          const ay = t[1][1] - t[0][1];
          const az = t[1][2] - t[0][2];
          const bx = t[2][0] - t[0][0];
          const by = t[2][1] - t[0][1];
          const bz = t[2][2] - t[0][2];
          const nx = ay * bz - az * by;
          const ny = az * bx - ax * bz;
          const nz = ax * by - ay * bx;
          const slope = 1 - Math.abs(ny) / Math.hypot(nx, ny, nz);
          const c = colorFor(hm, slope * 3, t[0][0], t[0][2]);
          for (const p of t) {
            pos.push(p[0], p[1], p[2]);
            col.push(c.r, c.g, c.b);
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    patchMaterial(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  private buildWater() {
    const map = this.map;
    const res = 512;
    const data = new Uint8Array(res * res * 4);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const h = heightAt(map, ((i + 0.5) / res) * map.size, ((j + 0.5) / res) * map.size);
        // Square-root encoding keeps precision in the shallows.
        const d = Math.sqrt(Math.max(0, Math.min(1, -h / 1.0)));
        const k = (j * res + i) * 4;
        data[k] = Math.round(d * 255);
        data[k + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    const lin = (c: number) => new THREE.Color(c);
    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: {
        depthMap: { value: tex },
        mapSize: { value: map.size },
        time: { value: 0 },
        deep: { value: lin(this.pal.deep) },
        mid: { value: lin(this.pal.mid) },
        shallow: { value: lin(this.pal.shallow) },
        foam: { value: lin(this.pal.foam) },
        sunDir: { value: new THREE.Vector3(...this.pal.sunDir).normalize() },
        sunColor: { value: lin(this.pal.sun) },
        fogColor: { value: lin(this.pal.fog) },
        fogNear: { value: 50 },
        fogFar: { value: 200 },
        ...weatherUniforms,
      },
    });
    const geo = new THREE.PlaneGeometry(map.size + 400, map.size + 400, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(map.size / 2, 0, map.size / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'water';
    return { mesh, mat };
  }

  private buildProps(): THREE.InstancedMesh[] {
    const map = this.map;
    const pal = this.pal;
    const rng = new Rng(map.seed ^ 0xbeef);
    const out: THREE.InstancedMesh[] = [];
    let geo: THREE.BufferGeometry;
    if (pal.treeKind === 'palm') {
      const trunk = new THREE.CylinderGeometry(0.008, 0.012, 0.09, 4).translate(0, 0.045, 0);
      const crown = new THREE.ConeGeometry(0.06, 0.05, 5).translate(0, 0.1, 0);
      geo = mergeColored([
        [trunk, 0x6b5a3c],
        [crown, pal.tree],
      ]);
    } else if (pal.treeKind === 'pine') {
      geo = mergeColored([
        [new THREE.ConeGeometry(0.035, 0.11, 5).translate(0, 0.055, 0), pal.tree],
        [new THREE.ConeGeometry(0.025, 0.06, 5).translate(0, 0.1, 0), 0xe8eef0],
      ]);
    } else {
      geo = mergeColored([[new THREE.IcosahedronGeometry(0.035, 0).scale(1, 0.6, 1).translate(0, 0.02, 0), pal.tree]]);
    }
    const count = Math.round(30000 * pal.treeDensity);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    patchMaterial(mat);
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const cTree = new THREE.Color(pal.tree);
    const cTree2 = new THREE.Color(pal.tree2);
    let placed = 0;
    for (let t = 0; t < count * 6 && placed < count; t++) {
      const x = rng.range(0, map.size);
      const y = rng.range(0, map.size);
      const h = heightAt(map, x, y);
      if (h < 0.02 || h > 0.5) continue;
      // Clumps via noise.
      if (fbm(x * 0.35, y * 0.35, map.seed + 5, 3) < 0.5 - pal.treeDensity * 0.08) continue;
      // Keep clear of sites.
      let clear = true;
      for (const st of map.sites) if (Math.abs(st.x - x) < 0.75 && Math.abs(st.y - y) < 0.75) clear = false;
      if (!clear) continue;
      const sc = rng.range(0.55, 1.1) * (pal.treeKind === 'palm' ? 1.2 : 1);
      p.set(x, h * VSCALE - 0.005, y);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      s.set(sc, sc * rng.range(0.8, 1.3), sc);
      m.compose(p, q, s);
      inst.setMatrixAt(placed, m);
      inst.setColorAt(placed, cTree.clone().lerp(cTree2, rng.next()).multiplyScalar(rng.range(0.85, 1.15)));
      placed++;
    }
    inst.count = placed;
    inst.castShadow = true;
    inst.receiveShadow = true;
    out.push(inst);
    // Rocks along shores.
    const rockGeo = mergeColored([[new THREE.DodecahedronGeometry(0.05, 0), pal.rock]]);
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    patchMaterial(rockMat);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 1400);
    let rp = 0;
    for (let t = 0; t < 20000 && rp < 1400; t++) {
      const x = rng.range(0, map.size);
      const y = rng.range(0, map.size);
      const h = heightAt(map, x, y);
      if (h < -0.01 || h > 0.06) continue;
      const sc = rng.range(0.5, 1.4);
      p.set(x, Math.max(0, h * VSCALE) - 0.02, y);
      q.setFromEuler(new THREE.Euler(rng.next() * 3, rng.next() * 3, rng.next() * 3));
      s.set(sc, sc * 0.6, sc);
      m.compose(p, q, s);
      rocks.setMatrixAt(rp, m);
      rocks.setColorAt(rp, new THREE.Color(pal.rock).multiplyScalar(rng.range(0.75, 1.15)));
      rp++;
    }
    rocks.count = rp;
    rocks.castShadow = true;
    out.push(rocks);
    return out;
  }

  update(time: number, fogNear: number, fogFar: number, fogColor: THREE.Color) {
    const u = this.waterMat.uniforms;
    u.time.value = time;
    u.fogNear.value = fogNear;
    u.fogFar.value = fogFar;
    (u.fogColor.value as THREE.Color).copy(fogColor);
  }
}

/** Merge geometries, baking a flat colour per part into vertex colours. */
export function mergeColored(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const [g0, color] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    c.set(color);
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
