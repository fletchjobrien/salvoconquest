import { UNITS, UnitType } from '../../shared/defs';
import { GameMap, heightAt } from '../../shared/map';
import { VSCALE } from './terrain';

/** Visual altitude multiplier for aircraft and missiles; shrinks when zoomed in so planes stay in frame. */
export let AIR_VIS = 2.2;
export function setAirZoom(dist: number) {
  AIR_VIS = Math.max(0.45, Math.min(2.2, 0.35 + dist * 0.07));
}

export function groundY(map: GameMap, x: number, y: number): number {
  const h = heightAt(map, x, y);
  return h > 0 ? h * VSCALE : 0;
}

/**
 * Smooth terrain ceiling (three.js Y): the highest ground within ~2.5 km, blurred, so aircraft
 * climb over mountains in a gentle arc instead of hugging the slopes. Cached per map.
 */
const ceilings = new WeakMap<GameMap, { n: number; g: Float32Array }>();
const CEIL_CELL = 1;
function ceilingGrid(map: GameMap) {
  let c = ceilings.get(map);
  if (c) return c;
  const n = Math.ceil(map.size / CEIL_CELL) + 1;
  const raw = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy += 0.5) for (let dx = -1; dx <= 1; dx += 0.5) m = Math.max(m, groundY(map, (i + dx) * CEIL_CELL, (j + dy) * CEIL_CELL));
      raw[j * n + i] = m;
    }
  // Dilate then blur: the ceiling rises before the slope does and has no sharp steps.
  const dil = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const ii = i + dx;
          const jj = j + dy;
          if (ii >= 0 && jj >= 0 && ii < n && jj < n) m = Math.max(m, raw[jj * n + ii]);
        }
      dil[j * n + i] = m;
    }
  const g = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      let w = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const ii = i + dx;
          const jj = j + dy;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const k = 3 - Math.max(Math.abs(dx), Math.abs(dy));
          s += dil[jj * n + ii] * k;
          w += k;
        }
      g[j * n + i] = s / w;
    }
  c = { n, g };
  ceilings.set(map, c);
  return c;
}

export function terrainCeiling(map: GameMap, x: number, y: number): number {
  const { n, g } = ceilingGrid(map);
  const fx = Math.max(0, Math.min(n - 1.001, x / CEIL_CELL));
  const fy = Math.max(0, Math.min(n - 1.001, y / CEIL_CELL));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const a = g[j * n + i] + (g[j * n + i + 1] - g[j * n + i]) * u;
  const b = g[(j + 1) * n + i] + (g[(j + 1) * n + i + 1] - g[(j + 1) * n + i]) * u;
  return a + (b - a) * v;
}

/**
 * Visual height (three.js Y) of something flying at sim altitude alt (km). Aircraft-level
 * altitudes ride on the terrain ceiling; sea-skimmers stay low (their sim altitude already
 * follows the ground).
 */
export function airY(map: GameMap, x: number, y: number, alt: number): number {
  const lift = alt <= 0.12 ? 0 : terrainCeiling(map, x, y) * Math.min(1, (alt - 0.12) / 0.45);
  return Math.max(groundY(map, x, y) + 0.03, alt * AIR_VIS + lift);
}

/** Visual height for a unit (three.js Y). */
export function visAlt(map: GameMap, type: UnitType, x: number, y: number, alt: number): number {
  const dom = UNITS[type].domain;
  if (dom === 'air') return airY(map, x, y, alt);
  if (dom === 'land') return groundY(map, x, y);
  if (dom === 'sub') return 0;
  return 0;
}
