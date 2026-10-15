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
// Broken cloud cover of a storm cell: ragged edge, dense core, holes between cells.
float stormCover(vec4 c, vec2 p, float layer) {
  vec2 q = p - wWind * wTime + vec2(layer * 37.0, layer * 11.0);
  float d = ellD(p - c.xy, STORM_AX * c.z);
  float edge = 1.0 - smoothstep(0.35, 1.0, d + (wxFbm(q * 0.07) - 0.5) * 0.8);
  // Big convective cells plus cauliflower detail; gaps between them show the sea.
  float cells = wxFbm(q * (0.17 + layer * 0.1));
  float detail = wxFbm(q * (0.7 + layer * 0.4) + 3.0);
  float body = smoothstep(0.42, 0.78, cells * 0.62 + detail * 0.22 + edge * 0.3);
  return c.w * edge * body;
}
// Fog bank density at ground level: lumpy, with fingers at the edges.
float fogCover(vec4 c, vec2 p, float layer) {
  vec2 q = p - wWind * wTime * 0.4 + vec2(layer * 19.0, -layer * 7.0);
  // Stretch along the wind so the bank forms long tongues and wisps.
  vec2 w = normalize(wWind);
  vec2 qs = vec2(dot(q, w) * 0.55, dot(q, vec2(-w.y, w.x)) * 1.6);
  float d = ellD(p - c.xy, FOG_AX * c.z);
  float edge = 1.0 - smoothstep(0.3, 1.0, d + (wxFbm(qs * 0.09 + 31.0) - 0.5) * 1.0);
  float body = 0.3 + 0.7 * wxFbm(qs * 0.35 + 7.0);
  return c.w * edge * body;
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
  col *= 1.0 - g * 0.22 - sh * 0.28;
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
