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

/** Visual height for a unit (three.js Y). */
export function visAlt(map: GameMap, type: UnitType, x: number, y: number, alt: number): number {
  const dom = UNITS[type].domain;
  if (dom === 'air') return Math.max(groundY(map, x, y) + 0.02, alt * AIR_VIS);
  if (dom === 'land') return groundY(map, x, y);
  if (dom === 'sub') return 0;
  return 0;
}
