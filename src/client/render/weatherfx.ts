// Shared weather uniforms injected into world materials: fog banks whiten, storms darken.
import * as THREE from 'three';

const N = 6;
export const weatherUniforms = {
  wStorm: { value: Array.from({ length: N }, () => new THREE.Vector4()) },
  wFog: { value: Array.from({ length: N }, () => new THREE.Vector4()) },
  wStormN: { value: 0 },
  wFogN: { value: 0 },
  wFogColor: { value: new THREE.Color(0.8, 0.83, 0.86) },
  wStormColor: { value: new THREE.Color(0.06, 0.07, 0.09) },
};

export const WEATHER_GLSL = /* glsl */ `
uniform vec4 wStorm[${N}];
uniform vec4 wFog[${N}];
uniform int wStormN;
uniform int wFogN;
uniform vec3 wFogColor;
uniform vec3 wStormColor;
float cellAmount(vec4 c, vec2 p) {
  float d = length(p - c.xy);
  return c.w * clamp((1.0 - d / c.z) * 2.2, 0.0, 1.0);
}
vec3 applyWeather(vec3 col, vec3 wp) {
  float s = 0.0;
  float f = 0.0;
  for (int i = 0; i < ${N}; i++) { if (i >= wStormN) break; s = max(s, cellAmount(wStorm[i], wp.xz)); }
  for (int i = 0; i < ${N}; i++) { if (i >= wFogN) break; f = max(f, cellAmount(wFog[i], wp.xz)); }
  col = mix(col, col * 0.5 + wStormColor * 0.2, s * 0.6);
  // Fog hugs the surface: stronger low down.
  float low = 1.0 - smoothstep(0.0, 2.5, wp.y);
  col = mix(col, wFogColor, f * (0.55 + 0.25 * low));
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

export function setWeatherCells(cells: [number, number, number, number, number][], fogColor: THREE.Color) {
  let s = 0;
  let f = 0;
  for (const [kind, x, y, r, i] of cells) {
    if (kind === 0 && s < N) weatherUniforms.wStorm.value[s++].set(x, y, r, i / 100);
    else if (kind === 1 && f < N) weatherUniforms.wFog.value[f++].set(x, y, r, i / 100);
  }
  weatherUniforms.wStormN.value = s;
  weatherUniforms.wFogN.value = f;
  weatherUniforms.wFogColor.value.copy(fogColor);
}
