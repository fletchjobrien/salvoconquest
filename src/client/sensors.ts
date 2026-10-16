// Our side's sensor coverage, for the minimap outlines and the sensor view (V).
// Mirrors the simulation's sensor ranges: eyes and surface radar, air-search radar, sonar.
// A ship with a knocked-out radar shows its reduced (35 %) range.
import { BUILDINGS, UNITS, deriveStats } from '../shared/defs';
import { F_LANDED } from '../shared/protocol';
import type { World } from './state';
import { matchLoadoutOf } from './loadouts';

export type Disc = [number, number, number];

export interface Coverage {
  /** Eyes and surface-search radar: where ships (and, at short range, troops) are seen. */
  surf: Disc[];
  /** Air-search radar reaching beyond the surface picture: aircraft and missiles only. */
  air: Disc[];
  /** Sonar (ships, subs, sonobuoys): the only way to find submarines. */
  sonar: Disc[];
}

export function sensorCoverage(w: World): Coverage {
  const out: Coverage = { surf: [], air: [], sonar: [] };
  for (const u of w.units.values()) {
    if (w.teamOf(u.owner) !== w.myTeam || u.flags & F_LANDED) continue;
    const def = UNITS[u.type];
    const lo = u.owner === w.me ? matchLoadoutOf(u.type) : def.defaults;
    const st = deriveStats(u.type, w.players[u.owner]?.faction ?? w.myFaction, lo);
    const radarDown = u.owner === w.me && (w.details.get(u.id)?.[13]?.[2] ?? 0) > 0 ? 0.35 : 1;
    const near = Math.max(st.radarSurf * radarDown, def.visual);
    if (near > 0) out.surf.push([u.x, u.y, near]);
    if (st.radarAir * radarDown > near) out.air.push([u.x, u.y, st.radarAir * radarDown]);
    if (st.sonar > 0 && def.domain !== 'land') out.sonar.push([u.x, u.y, st.sonar]);
  }
  for (const s of w.map.sites) {
    const o = w.sites[s.id].owner;
    if (o < 0 || w.teamOf(o) !== w.myTeam) continue;
    const b = BUILDINGS[s.type];
    const near = Math.max(b.radarSurf, b.visual);
    out.surf.push([s.x, s.y, near]);
    if (b.radarAir > near) out.air.push([s.x, s.y, b.radarAir]);
  }
  return out;
}

export const COVER_COLORS = { surf: '#6fd0ff', air: '#b9e6ff', sonar: '#a890ff' };

/**
 * Draw the outline of a union of circles: stroke every circle, then erase each circle's
 * interior, which removes the inner half of every stroke and every arc inside another circle.
 * `path` adds one circle's path (in whatever projection the caller uses) to the context.
 */
export function unionOutline(scratch: CanvasRenderingContext2D, discs: Disc[], color: string, width: number, path: (g: CanvasRenderingContext2D, d: Disc) => void) {
  scratch.save();
  scratch.globalCompositeOperation = 'source-over';
  scratch.strokeStyle = color;
  scratch.lineWidth = width * 2;
  for (const d of discs) {
    scratch.beginPath();
    path(scratch, d);
    scratch.stroke();
  }
  scratch.globalCompositeOperation = 'destination-out';
  scratch.fillStyle = '#000';
  for (const d of discs) {
    scratch.beginPath();
    path(scratch, d);
    scratch.fill();
  }
  scratch.restore();
}
