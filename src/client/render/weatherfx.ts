// Shared weather uniforms and GLSL. World materials get cloud shadows and low fog;
// the cloud decks, rain shafts and fog layers (weatherView.ts) use the same density
// functions, so shadows sit under clouds and fog edges match everywhere.
import * as THREE from 'three';
import { WEATHER_AXES } from '../../shared/weather';

const N = 6;
export const weatherUniforms = {
  wStorm: { value: Array.from({ length: N }, () => new THREE.Vector4()) },
  wFog: { value: Array.from({ length: N }, () => new THREE.Vector4()) },
  wStormN: { value: 0 },
  wFogN: { value: 0 },
  wFogColor: { value: new THREE.Color(0.8, 0.83, 0.86) },
  wStormColor: { value: new THREE.Color(0.06, 0.07, 0.09) },
  wTime: { value: 0 },
  wWind: { value: new THREE.Vector2(0.06, 0.025) },
};

/** Noise and density functions only (no uniforms), for shaders that declare their own. */
export const WEATHER_FUNCS = /* glsl */ `
float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), f.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Cellular noise: distance to the nearest jittered point. 1 - F1 gives round "bubbles".
vec2 wxHash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
float wxCell(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = wxHash2(i + g) * 0.8 + 0.1;
      vec2 r = g + o - f;
      d = min(d, dot(r, r));
    }
  return sqrt(d);
}
float wxFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * wxNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.9375;
}
// Elliptical distance in wind-aligned axes (same shape as shared/weather.ts): 1 on the edge.
float ellD(vec2 d, vec2 axes) {
  vec2 w = normalize(wWind);
  return length(vec2(dot(d, w) / axes.x, dot(d, vec2(-w.y, w.x)) / axes.y));
}
const vec2 STORM_AX = vec2(${WEATHER_AXES[0][0]}, ${WEATHER_AXES[0][1]});
const vec2 FOG_AX = vec2(${WEATHER_AXES[1][0]}, ${WEATHER_AXES[1][1]});
// Smooth strength of a storm cell (drives waves, gloom and matches the gameplay falloff).
float cellAmount(vec4 c, vec2 p) {
  float d = ellD(p - c.xy, STORM_AX * c.z);
  return c.w * clamp((1.0 - d) * 2.2, 0.0, 1.0);
}
// Cloud cover of a storm. Not a disc: a warped cluster of separate convective cells inside a
// soft envelope, with gaps between them and stray cells drifting past the edge. The pattern is
// in cell-relative coordinates, so it travels with the storm, and seeded per cell (from its
// radius), so no two storms look alike. layer 1 is the anvil: a fibrous sheet blown downwind.
float stormCover(vec4 c, vec2 p, float layer) {
  vec2 rel = (p - c.xy) / c.z;
  // Beyond 1.75 radii both layers are zero whatever the noise: skip it (most of every quad).
  if (c.w <= 0.0 || dot(rel, rel) > 3.06) return 0.0;
  float seed = fract(c.z * 7.137) * 61.0;
  vec2 w = normalize(wWind);
  vec2 pw = vec2(-w.y, w.x);
  float evo = wTime * 0.006;
  if (layer > 0.5) {
    vec2 ra = rel - w * 0.35;
    vec2 qa = vec2(dot(ra, w) * 0.8, dot(ra, pw) * 1.3) * 2.0 + seed + 13.0;
    vec2 wa = vec2(wxFbm(qa * 0.6 + evo), wxFbm(qa * 0.6 + 4.1 - evo)) - 0.5;
    float fib = wxFbm(qa * vec2(0.9, 1.3) + wa * 1.2);
    float envA = 1.0 - smoothstep(0.1, 1.0, length(ra + wa * 0.5));
    float limitA = 1.0 - smoothstep(0.7, 1.35, length(ra));
    return c.w * limitA * smoothstep(0.62, 0.85, fib * 0.55 + envA * 0.5);
  }
  vec2 q = rel * 2.6 + seed;
  vec2 wq = vec2(wxFbm(q * 0.7 + evo), wxFbm(q * 0.7 + 5.2 - evo)) - 0.5;
  vec2 qw = q + wq * 0.6;
  // Convective towers: round cells at three sizes stacked into cauliflower heads.
  float towers = 1.0 - wxCell(qw * 1.1);
  float heads = 1.0 - wxCell(qw * 3.3 + 7.0);
  float puffs = 1.0 - wxCell(qw * 8.5 + 3.0);
  float cluster = wxFbm(q * 0.8 + 21.0);
  float env = 1.0 - smoothstep(0.1, 1.1, length(rel + wq * 0.5));
  float limit = 1.0 - smoothstep(0.85, 1.4, length(rel + wq * 0.3));
  float v = towers * 0.42 + heads * 0.2 + puffs * 0.1 + cluster * 0.3 + env * 0.4;
  return c.w * limit * smoothstep(0.72, 0.84, v);
}
// Fog: sprawling patches with fingers and holes, combed along the wind, no clean outline.
float fogCover(vec4 c, vec2 p, float layer) {
  vec2 rel = (p - c.xy) / c.z;
  if (c.w <= 0.0 || dot(rel, rel) > 3.06) return 0.0;
  float seed = fract(c.z * 5.313) * 47.0;
  vec2 w = normalize(wWind);
  vec2 rs = vec2(dot(rel, w) * 0.6, dot(rel, vec2(-w.y, w.x)) * 1.5);
  vec2 q = rs * 2.6 + seed + vec2(layer * 3.7, layer * 1.3) - vec2(wTime * 0.004, 0.0);
  vec2 wq = vec2(wxFbm(q * 0.6), wxFbm(q * 0.6 + 3.3)) - 0.5;
  float n = wxFbm(q + wq * 2.0);
  float env = 1.0 - smoothstep(0.05, 1.15, length(rel + wq * 0.7));
  float limit = 1.0 - smoothstep(0.9, 1.45, length(rel + wq * 0.4));
  return c.w * limit * smoothstep(0.5, 0.82, n * 0.72 + env * 0.5);
}
float stormGloom(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < ${N}; i++) { if (i >= wStormN) break; s = max(s, cellAmount(wStorm[i], p)); }
  return s;
}
float cloudShadow(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < ${N}; i++) { if (i >= wStormN) break; s = max(s, stormCover(wStorm[i], p, 0.0)); }
  return s;
}
float fogAt(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < ${N}; i++) { if (i >= wFogN) break; f = max(f, fogCover(wFog[i], p, 0.0)); }
  return f;
}
`;

export const WEATHER_UNIFORMS_GLSL = /* glsl */ `
uniform vec4 wStorm[${N}];
uniform vec4 wFog[${N}];
uniform int wStormN;
uniform int wFogN;
uniform vec3 wFogColor;
uniform vec3 wStormColor;
uniform float wTime;
uniform vec2 wWind;
`;

export const WEATHER_GLSL =
  WEATHER_UNIFORMS_GLSL +
  WEATHER_FUNCS +
  /* glsl */ `
vec3 applyWeather(vec3 col, vec3 wp) {
  // Overcast gloom under the whole storm, plus darker shadows under the thick cloud.
  float g = stormGloom(wp.xz);
  float sh = cloudShadow(wp.xz);
  col *= 1.0 - g * 0.08 - sh * 0.3;
  col = mix(col, wStormColor, g * 0.12);
  // Fog only hugs the surface; hills poke out of it.
  float f = fogAt(wp.xz) * (1.0 - smoothstep(0.05, 0.9, wp.y));
  col = mix(col, wFogColor, f * 0.22);
  return col;
}
`;

const patched = new WeakSet<THREE.Material>();

export function patchMaterial(mat: THREE.Material) {
  if (patched.has(mat)) return;
  patched.add(mat);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, weatherUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWxPos;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vec4 wxp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wxp = instanceMatrix * wxp;
  #endif
  vWxPos = (modelMatrix * wxp).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWxPos;\n' + WEATHER_GLSL)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyWeather(gl_FragColor.rgb, vWxPos);\n#include <fog_fragment>');
  };
  mat.needsUpdate = true;
}

export function setWeatherCells(cells: [number, number, number, number, number][], fogColor: THREE.Color, time: number) {
  let s = 0;
  let f = 0;
  for (const [kind, x, y, r, i] of cells) {
    if (kind === 0 && s < N) weatherUniforms.wStorm.value[s++].set(x, y, r, i / 100);
    else if (kind === 1 && f < N) weatherUniforms.wFog.value[f++].set(x, y, r, i / 100);
  }
  weatherUniforms.wStormN.value = s;
  weatherUniforms.wFogN.value = f;
  weatherUniforms.wFogColor.value.copy(fogColor);
  weatherUniforms.wTime.value = time;
}
