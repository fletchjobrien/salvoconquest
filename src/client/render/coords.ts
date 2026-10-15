import { UNITS, UnitType } from '../../shared/defs';
import { GameMap, heightAt } from '../../shared/map';
import { VSCALE } from './terrain';

export const AIR_VIS = 2.2;

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
