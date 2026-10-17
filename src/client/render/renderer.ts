// Three.js renderer with a low-resolution pixel pass (depth outlines + ordered dither).
import * as THREE from 'three';

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const POST_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 res;
uniform float cNear;
uniform float cFar;
uniform float flash;
uniform vec3 flashColor;
uniform float levels;
uniform float vignette;
uniform float fogVeil;
uniform vec3 veilColor;
uniform float time;
varying vec2 vUv;

float lin(float z) {
  float ndc = z * 2.0 - 1.0;
  return (2.0 * cNear * cFar) / (cFar + cNear - ndc * (cFar - cNear));
}
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float m[16];
  m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0;
  m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
  m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0;
  m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
  for (int k = 0; k < 16; k++) { if (k == i) return m[k] / 16.0; }
  return 0.0;
}
void main() {
  vec2 px = 1.0 / res;
  vec2 cell = floor(vUv * res);
  vec2 uv = (cell + 0.5) * px;
  vec3 c = texture2D(tColor, uv).rgb;
  float d = lin(texture2D(tDepth, uv).r);
  float dl = lin(texture2D(tDepth, uv - vec2(px.x, 0.0)).r);
  float dr = lin(texture2D(tDepth, uv + vec2(px.x, 0.0)).r);
  float du = lin(texture2D(tDepth, uv + vec2(0.0, px.y)).r);
  float dd = lin(texture2D(tDepth, uv - vec2(0.0, px.y)).r);
  // Outline object pixels that sit in front of their neighbours.
  float e = max(max(dl - d, dr - d), max(du - d, dd - d)) / d;
  float outline = smoothstep(0.035, 0.08, e);
  c = mix(c, c * 0.42, outline * 0.85);
  // Highlight crease: pixels behind a neighbour get a faint lift (rim light).
  float rim = max(max(d - dl, d - dr), max(d - du, d - dd)) / d;
  c += vec3(0.04) * smoothstep(0.05, 0.12, rim) * (1.0 - outline);
  // Fog veil (weather) on top.
  c = mix(c, veilColor, fogVeil);
  // Vignette.
  vec2 q = vUv - 0.5;
  c *= 1.0 - vignette * dot(q, q) * 1.6;
  // Linear -> sRGB, then ordered dither + gentle quantisation for that crunchy look.
  c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  float b = bayer4(cell) - 0.5;
  c = floor(c * levels + 0.5 + b * 0.9) / levels;
  c += flash * flashColor;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private post: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  pixelSize = 3;
  width = 1;
  height = 1;
  flash = 0;
  /** Colour of the screen flash: white for lightning, warm for blasts. */
  flashColor = new THREE.Color(1, 1, 1);

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.setPixelRatio(1);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 600);
    this.rt = this.makeTarget(1, 1);
    this.post = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tColor: { value: this.rt.texture },
        tDepth: { value: this.rt.depthTexture },
        res: { value: new THREE.Vector2(1, 1) },
        cNear: { value: this.camera.near },
        cFar: { value: this.camera.far },
        flash: { value: 0 },
        flashColor: { value: new THREE.Color(1, 1, 1) },
        levels: { value: 28 },
        vignette: { value: 0.55 },
        fogVeil: { value: 0 },
        veilColor: { value: new THREE.Color(0.7, 0.75, 0.78) },
        time: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    quad.frustumCulled = false;
    this.postScene.add(quad);
    this.resize();
  }

  private makeTarget(w: number, h: number) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    const lw = Math.max(64, Math.floor(w / this.pixelSize));
    const lh = Math.max(64, Math.floor(h / this.pixelSize));
    this.rt.setSize(lw, lh);
    (this.post.uniforms.res.value as THREE.Vector2).set(lw, lh);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setVeil(amount: number, color: THREE.Color) {
    this.post.uniforms.fogVeil.value = amount;
    (this.post.uniforms.veilColor.value as THREE.Color).copy(color);
  }

  render(time: number) {
    this.post.uniforms.cNear.value = this.camera.near;
    this.post.uniforms.cFar.value = this.camera.far;
    this.post.uniforms.flash.value = this.flash;
    this.post.uniforms.flashColor.value.copy(this.flashColor);
    this.post.uniforms.time.value = time;
    this.gl.setRenderTarget(this.rt);
    this.gl.render(this.scene, this.camera);
    this.gl.setRenderTarget(null);
    this.gl.render(this.postScene, this.postCam);
  }

  /** World (x, alt, y) → CSS pixel coords; z > 1 means behind the camera. */
  project(x: number, alt: number, y: number, out: { x: number; y: number; z: number }) {
    const v = TMP.set(x, alt, y).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    out.z = v.z;
    return out;
  }
}

const TMP = new THREE.Vector3();

/** RTS camera: orbits a ground target; pitch flattens as you zoom in. */
export class CameraRig {
  tx = 40;
  ty = 40;
  dist = 45;
  yaw = 0;
  private vx = 0;
  private vy = 0;
  private wantDist = 45;
  private wantYaw = 0;
  minDist = 2.2;
  maxDist = 240;
  shake = 0;

  constructor(private cam: THREE.PerspectiveCamera) {}

  get pitch(): number {
    // Radians below horizontal: steep when zoomed out, more cinematic when close.
    const t = Math.min(1, Math.max(0, (this.dist - this.minDist) / 60));
    return 0.62 + t * 0.75;
  }

  zoom(factor: number, aroundX?: number, aroundY?: number) {
    const before = this.wantDist;
    this.wantDist = Math.min(this.maxDist, Math.max(this.minDist, this.wantDist * factor));
    // Zoom toward the cursor.
    if (aroundX !== undefined && aroundY !== undefined) {
      const k = 1 - this.wantDist / before;
      this.tx += (aroundX - this.tx) * k * 0.9;
      this.ty += (aroundY - this.ty) * k * 0.9;
    }
  }

  setDist(d: number, instant = false) {
    this.wantDist = Math.min(this.maxDist, Math.max(this.minDist, d));
    if (instant) this.dist = this.wantDist;
  }
  get targetDist() {
    return this.wantDist;
  }

  rotate(d: number) {
    this.wantYaw += d;
  }

  pan(dx: number, dy: number) {
    // dx/dy in screen-aligned units (km).
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    this.tx += dx * c - dy * s;
    this.ty += dx * s + dy * c;
  }

  push(vx: number, vy: number) {
    this.vx = vx;
    this.vy = vy;
  }

  flyTo(x: number, y: number) {
    this.tx = x;
    this.ty = y;
  }

  update(dt: number, mapSize: number, time: number) {
    const k = 1 - Math.exp(-dt * 10);
    this.dist += (this.wantDist - this.dist) * k;
    this.yaw += (this.wantYaw - this.yaw) * k;
    const speed = this.dist * 0.9;
    this.pan(this.vx * speed * dt, this.vy * speed * dt);
    const m = 12;
    this.tx = Math.max(-m, Math.min(mapSize + m, this.tx));
    this.ty = Math.max(-m, Math.min(mapSize + m, this.ty));
    const p = this.pitch;
    const h = Math.sin(p) * this.dist;
    const back = Math.cos(p) * this.dist;
    // Camera looks along +y map axis rotated by yaw ("north up" at yaw 0 means looking toward -y).
    const fx = -Math.sin(this.yaw);
    const fy = Math.cos(this.yaw);
    let sx = 0;
    let sy = 0;
    let sh = 0;
    let lx = 0;
    if (this.shake > 0.002) {
      // Salvo's shake: a jolt that dies away fast, moving the eye more than the aim point.
      const s = this.shake * this.dist * 0.012;
      const t = time * 50;
      sx = Math.sin(t * 1.7) * s;
      sy = Math.sin(t * 2.3 + 1) * s * 0.7;
      sh = Math.sin(t * 2.9 + 2) * s * 0.7;
      lx = Math.sin(t * 1.3 + 2) * s * 0.5;
      this.shake *= Math.exp(-4 * dt);
    } else this.shake = 0;
    this.cam.position.set(this.tx + fx * back + sx, h + sh, this.ty + fy * back + sy);
    this.cam.lookAt(this.tx + lx, 0, this.ty);
    this.cam.near = Math.max(0.03, this.dist * 0.02);
    this.cam.far = this.dist * 6 + 120;
    this.cam.updateProjectionMatrix();
  }
}
