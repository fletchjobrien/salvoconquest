// Our side's sensor coverage, for the minimap outlines and the sensor view (V).
// Mirrors the simulation's sensor ranges: eyes and surface radar, air-search radar, sonar, cut by
// weather the same way. A ship with a knocked-out radar shows its reduced (35 %) range.
import { BUILDINGS, BUOY, UNITS, deriveStats } from '../shared/defs';
import { F_DARK, F_LANDED } from '../shared/protocol';
import { THEME_INFO } from '../shared/map';
import { weatherStrength } from '../shared/weather';
import type { World } from './state';
import { unitLoadout } from './loadouts';

export type Disc = [number, number, number];
/** Closed outline in map km: x0, y0, x1, y1, ... */
export type Loop = number[];

/** One of our sensors, split the way weather affects it (radar and eyes are cut differently). */
interface Source {
  x: number;
  y: number;
  /** Surface-search radar range (radar on, damage applied). */
  radar: number;
  /** Eyesight range. */
  vis: number;
  /** Air-search radar range, when it reaches beyond the surface picture; else 0. */
  air: number;
}

export interface Coverage {
  /** Eyes and surface-search radar: where ships (and, at short range, troops) are seen. Weather bites into it. */
  surf: Loop[];
  /** Air-search radar reaching beyond the surface picture: aircraft and missiles only. Storms bite into it. */
  air: Loop[];
  /** Sonar (ships, subs, sonobuoys): the only way to find submarines. Weather does not affect it. */
  sonar: Disc[];
}

function sources(w: World): { src: Source[]; sonar: Disc[] } {
  const src: Source[] = [];
  const sonar: Disc[] = [];
  for (const u of w.units.values()) {
    if (w.teamOf(u.owner) !== w.myTeam || u.flags & F_LANDED) continue;
    const def = UNITS[u.type];
    const fac = w.players[u.owner]?.faction ?? w.myFaction;
    const lo = unitLoadout(u.type, u.variant, fac);
    const st = deriveStats(u.type, fac, lo);
    const radarDown = u.flags & F_DARK ? 0 : u.owner === w.me && (w.details.get(u.id)?.[13]?.[2] ?? 0) > 0 ? 0.35 : 1;
    const near = Math.max(st.radarSurf * radarDown, st.visual);
    if (near > 0) src.push({ x: u.x, y: u.y, radar: st.radarSurf * radarDown, vis: st.visual, air: st.radarAir * radarDown > near ? st.radarAir * radarDown : 0 });
    if (st.sonar > 0 && def.domain !== 'land') sonar.push([u.x, u.y, st.sonar]);
  }
  for (const [x, y] of w.buoys) sonar.push([x, y, BUOY.sonar]);
  for (const s of w.map.sites) {
    const o = w.sites[s.id].owner;
    if (o < 0 || w.teamOf(o) !== w.myTeam) continue;
    const b = BUILDINGS[s.type];
    const near = Math.max(b.radarSurf, b.visual);
    src.push({ x: s.x, y: s.y, radar: b.radarSurf, vis: b.visual, air: b.radarAir > near ? b.radarAir : 0 });
  }
  return { src, sonar };
}

/** Grid step (km) of the coverage field, and the margin around the map it covers. */
const STEP = 0.8;
const PAD = 40;
let cache: { at: number; cov: Coverage } | null = null;
/** Grid buffers, reused between refreshes. */
let buf: { n: number; rad: Float32Array; vis: Float32Array; storm: Float32Array; fog: Float32Array; surf: Float32Array; air: Float32Array } | null = null;

/**
 * Our side's sensor coverage, with the weather cut in. The simulation shrinks a sensor's range by the
 * weather where the target is (storms: radar 45 %, eyes 70 %; fog: eyes 65 %), so a storm takes a
 * bite out of the covered area wherever it sits far enough from the sensor. The coverage is sampled
 * on a grid with the same rule and traced into outlines (marching squares). Refreshed every 0.4 s.
 */
/** Whether the next sensorCoverage() call will recompute (callers can keep it off a busy frame). */
export function coverageStale(w: World): boolean {
  return !(cache && w.clock >= cache.at && w.clock - cache.at < 0.4);
}

export function sensorCoverage(w: World): Coverage {
  if (cache && w.clock >= cache.at && w.clock - cache.at < 0.4) return cache.cov;
  const { src, sonar } = sources(w);
  const S = w.map.size;
  const n = Math.ceil((S + PAD * 2) / STEP) + 1;
  const gx = (i: number) => -PAD + i * STEP;
  // Weather multipliers at every grid point (as in Game.weatherAt and the detection pass).
  const baseFog = THEME_INFO[w.map.theme].baseFog;
  if (!buf || buf.n !== n) {
    const a = () => new Float32Array(n * n);
    buf = { n, rad: a(), vis: a(), storm: a(), fog: a(), surf: a(), air: a() };
  }
  const radMul = buf.rad.fill(1 - 0.1 * baseFog);
  const visMul = buf.vis.fill(1 - 0.65 * baseFog);
  const cells = w.weather.filter((c) => c[4] > 0);
  if (cells.length) {
    // Only grid points under some cell differ from the clear-sky values.
    const storm = buf.storm.fill(0);
    const fog = buf.fog.fill(baseFog);
    const touched: number[] = [];
    for (const [kind, cx, cy, r, inten] of cells) {
      const i0 = Math.max(0, Math.floor((cx - r + PAD) / STEP));
      const i1 = Math.min(n - 1, Math.ceil((cx + r + PAD) / STEP));
      const j0 = Math.max(0, Math.floor((cy - r + PAD) / STEP));
      const j1 = Math.min(n - 1, Math.ceil((cy + r + PAD) / STEP));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const f = weatherStrength(kind as 0 | 1, gx(i) - cx, gx(j) - cy, r, inten / 100);
          if (f <= 0) continue;
          const k = j * n + i;
          if (kind === 0) storm[k] = Math.max(storm[k], f);
          else fog[k] = Math.max(fog[k], f);
          touched.push(k);
        }
      }
    }
    for (const k of touched) {
      visMul[k] = (1 - 0.7 * storm[k]) * (1 - 0.65 * fog[k]);
      radMul[k] = (1 - 0.45 * storm[k]) * (1 - 0.1 * fog[k]);
    }
  }
  // Field: > 0 inside coverage (1 - d / effective range, best sensor wins).
  const surf = buf.surf.fill(-1);
  const air = buf.air.fill(-1);
  for (const s of src) {
    const reach = Math.max(s.radar, s.vis, s.air);
    const i0 = Math.max(1, Math.floor((s.x - reach + PAD) / STEP));
    const i1 = Math.min(n - 2, Math.ceil((s.x + reach + PAD) / STEP));
    const j0 = Math.max(1, Math.floor((s.y - reach + PAD) / STEP));
    const j1 = Math.min(n - 2, Math.ceil((s.y + reach + PAD) / STEP));
    // Look a little past the reach so the field crosses zero between grid points.
    const lim = (reach + STEP * 2) ** 2;
    for (let j = j0; j <= j1; j++) {
      const dy = gx(j) - s.y;
      for (let i = i0; i <= i1; i++) {
        const dx = gx(i) - s.x;
        const d2 = dx * dx + dy * dy;
        if (d2 > lim) continue;
        const k = j * n + i;
        const d = Math.sqrt(d2);
        const rv = s.vis * visMul[k];
        const rr = s.radar * radMul[k];
        const rs = rr > rv ? rr : rv;
        if (rs > 0) {
          const v = 1 - d / rs;
          if (v > surf[k]) surf[k] = v;
        }
        if (s.air > 0) {
          const v = 1 - d / (s.air * radMul[k]);
          if (v > air[k]) air[k] = v;
        }
      }
    }
  }
  const cov: Coverage = { surf: contours(surf, n, -PAD, STEP), air: contours(air, n, -PAD, STEP), sonar };
  cache = { at: w.clock, cov };
  return cov;
}

/**
 * Marching squares: closed outlines of field > 0 on an n x n grid (origin o, step h). The grid
 * border must be outside (< 0) so every outline closes. Outer edges and holes both come out as
 * loops: fill them with the even-odd rule.
 */
function contours(f: Float32Array, n: number, o: number, h: number): Loop[] {
  // Crossing point on an edge, keyed by edge id: horizontal (i,j)-(i+1,j) = 2k, vertical (i,j)-(i,j+1) = 2k+1.
  const point = (id: number): [number, number] => {
    const k = id >> 1;
    const i = k % n;
    const j = (k - i) / n;
    const k2 = id & 1 ? k + n : k + 1;
    const a = f[k];
    const t = a / (a - f[k2]);
    return id & 1 ? [o + i * h, o + (j + t) * h] : [o + (i + t) * h, o + j * h];
  };
  // Segments as pairs of edge ids; each crossed edge belongs to exactly two segments.
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const la = links.get(a);
    if (la) la.push(b);
    else links.set(a, [b]);
    const lb = links.get(b);
    if (lb) lb.push(a);
    else links.set(b, [a]);
  };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i;
      const c = (f[k] > 0 ? 1 : 0) | (f[k + 1] > 0 ? 2 : 0) | (f[k + n + 1] > 0 ? 4 : 0) | (f[k + n] > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const top = 2 * k;
      const bottom = 2 * (k + n);
      const left = 2 * k + 1;
      const right = 2 * (k + 1) + 1;
      const mid = (f[k] + f[k + 1] + f[k + n] + f[k + n + 1]) / 4 > 0;
      switch (c) {
        case 1: case 14: link(left, top); break;
        case 2: case 13: link(top, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(right, bottom); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, bottom); break;
        case 5: // corners 0 and 2 inside
          if (mid) { link(top, right); link(bottom, left); } else { link(left, top); link(right, bottom); }
          break;
        case 10: // corners 1 and 3 inside
          if (mid) { link(left, top); link(right, bottom); } else { link(top, right); link(bottom, left); }
          break;
      }
    }
  }
  const loops: Loop[] = [];
  const done = new Set<number>();
  for (const start of links.keys()) {
    if (done.has(start)) continue;
    const loop: Loop = [];
    let prev = -1;
    let cur = start;
    while (!done.has(cur)) {
      done.add(cur);
      const [x, y] = point(cur);
      loop.push(x, y);
      const nb = links.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
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
