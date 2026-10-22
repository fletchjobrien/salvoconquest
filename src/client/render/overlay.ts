// Crisp 2D tactical overlay drawn over the pixelated world: symbols, contacts, rings, orders.
import { AIR_SPEED, BUILDINGS, MODULES, MOVE_SPEED, UNITS, UNIT_TYPES, UNLOAD_RANGE, UnitType, unitCost } from '../../shared/defs';
import { canDeployAt, deployZone, rallySite } from '../../shared/game';
import { cellOf } from '../../shared/map';
import { sensorCoverage, coverageStale, unionOutline, COVER_COLORS, Coverage, Disc, Loop } from '../sensors';
import { ORDER_CODES, F_ABOARD, F_RETREAT, F_LANDED, F_FIRE, F_STOPPED, F_STUN, F_PAINTED, F_DARK, F_HOLD, F_FREE } from '../../shared/protocol';
import type { Renderer, CameraRig } from './renderer';
import type { World, UView } from '../state';
import { DOMAINS, GHOST_LIFE } from '../state';
import { Affil, FONT, SITE_GLYPH, SymDomain, glyphFor, sideColor, symbolCanvas } from './symbols';
import { SIDE, playerColor, unitName } from '../theme';
import { unitLoadout } from '../loadouts';
import { groundY, visAlt, weaponY } from './coords';
import { weatherOutline } from '../../shared/weather';

export interface Hover {
  kind: 'unit' | 'contact' | 'site' | 'ghost';
  id: number;
}

export interface OverlayView {
  world: World;
  r: Renderer;
  rig: CameraRig;
  selected: Set<number>;
  hover: Hover | null;
  dragRect: { x0: number; y0: number; x1: number; y1: number } | null;
  mode: { k: 'unload'; ships: { ship: number; ids: number[] }[] } | { k: 'launch'; ships: number[]; sites: number[] } | { k: 'bombard'; ships: number[] } | { k: 'deploy'; type: UnitType } | { k: 'build'; type: UnitType } | null;
  mouse: { x: number; y: number; wx: number; wy: number; valid: boolean };
  showRanges: boolean;
  showSensors: boolean;
  /** Weapon (module id) hovered in the unit panel: its range ring is highlighted. */
  hoverWeapon: string | null;
  /** Storm intensity at the camera, 0..1. */
  rain: number;
  pings: { x: number; y: number; t: number; color: string; kind: 'move' | 'attack' | 'unload' }[];
}

interface Shock {
  x: number;
  y: number;
  alt: number;
  t: number;
  r: number;
  color: string;
  dur: number;
}

export interface ScreenItem {
  kind: Hover['kind'];
  id: number;
  sx: number;
  sy: number;
  own: boolean;
  type: UnitType | null;
}

const P = { x: 0, y: 0, z: 0 };
/** Radius (km) of a battleship bombardment's beaten zone (as BOMBARD.spread in the simulation). */
const BOMBARD_ZONE = 0.7;

interface Floater {
  x: number;
  y: number;
  alt: number;
  text: string;
  color: string;
  t: number;
  /** Stack offset in pixels, so callouts at the same spot don't overlap. */
  yo: number;
}

export class Overlay {
  ctx: CanvasRenderingContext2D;
  shocks: Shock[] = [];
  floaters: Floater[] = [];
  private selPulse = new Map<number, number>();
  private prevSel = new Set<number>();
  /** Screen positions of everything clickable this frame. */
  items: ScreenItem[] = [];
  private dpr = 1;
  /** Extra off-screen margin (px) counted as visible: the cached layers' margin while they are built. */
  private pad = 0;
  private w = 1;
  private h = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /** Short-lived "splash" crosses where missiles were shot down. */
  splashes: { x: number; y: number; alt: number; t: number }[] = [];

  splash(x: number, y: number, alt: number) {
    this.splashes.push({ x, y, alt, t: 0 });
  }

  shock(x: number, y: number, alt: number, r: number, color: string, dur = 0.9) {
    this.shocks.push({ x, y, alt, t: 0, r, color, dur });
  }

  floater(x: number, y: number, alt: number, text: string, color: string) {
    // Stack above any fresh callout at the same spot.
    let yo = 0;
    for (const f of this.floaters) if (f.t < 1.2 && Math.abs(f.x - x) < 0.3 && Math.abs(f.y - y) < 0.3) yo = Math.max(yo, f.yo + 11);
    this.floaters.push({ x, y, alt, text, color, t: 0, yo });
  }

  private proj(v: OverlayView, x: number, alt: number, y: number) {
    v.r.project(x, alt, y, P);
    const m = Math.max(200, this.pad);
    return P.z < 1 && P.x > -m && P.y > -m && P.x < this.w + m && P.y < this.h + m;
  }

  private circle(v: OverlayView, x: number, y: number, rad: number, alt = 0, seg = 56): boolean {
    const ctx = this.ctx;
    ctx.beginPath();
    let any = false;
    let started = false;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      v.r.project(x + c * rad, alt, y + s * rad, P);
      if (P.z >= 1) {
        // Behind the camera (or past the far plane): pull the point in toward the centre until
        // it projects again. Skipping it instead joins the neighbours with a straight line
        // across the screen.
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 10; k++) {
          const m = (lo + hi) / 2;
          v.r.project(x + c * rad * m, alt, y + s * rad * m, P);
          if (P.z < 1) lo = m;
          else hi = m;
        }
        if (lo === 0) continue;
        v.r.project(x + c * rad * lo, alt, y + s * rad * lo, P);
      }
      if (P.x > -50 - this.pad && P.y > -50 - this.pad && P.x < this.w + 50 + this.pad && P.y < this.h + 50 + this.pad) any = true;
      if (!started) ctx.moveTo(P.x, P.y);
      else ctx.lineTo(P.x, P.y);
      started = true;
    }
    return any;
  }

  /**
   * Add closed map-space outlines (coverage loops) to the current path. A point that cannot be
   * projected (behind the camera) is pulled toward the view centre until it can, so the loop stays
   * closed and fills correctly.
   */
  private loops(v: OverlayView, loops: Loop[], g: CanvasRenderingContext2D) {
    const cx = v.rig.tx;
    const cy = v.rig.ty;
    for (const L of loops) {
      for (let i = 0; i < L.length; i += 2) {
        let x = L[i];
        let y = L[i + 1];
        v.r.project(x, 0, y, P);
        if (P.z >= 1) {
          let lo = 0;
          let hi = 1;
          for (let k = 0; k < 10; k++) {
            const m = (lo + hi) / 2;
            v.r.project(cx + (x - cx) * m, 0, cy + (y - cy) * m, P);
            if (P.z < 1) lo = m;
            else hi = m;
          }
          x = cx + (x - cx) * lo;
          y = cy + (y - cy) * lo;
          v.r.project(x, 0, y, P);
        }
        if (i === 0) g.moveTo(P.x, P.y);
        else g.lineTo(P.x, P.y);
      }
      g.closePath();
    }
  }

  /**
   * Add a world-space polyline to the current path, sampled along each leg and broken wherever a point
   * cannot be projected (behind the camera). Joining across such a gap draws stray lines across the
   * screen. Returns whether any point landed near the screen.
   */
  private polyline(v: OverlayView, pts: [number, number][], alt = 0, steps = 1): boolean {
    const ctx = this.ctx;
    let open = false;
    let any = false;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x0, y0] = i > 0 ? pts[i - 1] : pts[i];
      for (let k = i === 0 ? steps : 1; k <= steps; k++) {
        const f = k / steps;
        v.r.project(x0 + (x1 - x0) * f, alt, y0 + (y1 - y0) * f, P);
        if (P.z >= 1) {
          open = false;
          continue;
        }
        if (P.x > -50 - this.pad && P.y > -50 - this.pad && P.x < this.w + 50 + this.pad && P.y < this.h + 50 + this.pad) any = true;
        if (open) ctx.lineTo(P.x, P.y);
        else ctx.moveTo(P.x, P.y);
        open = true;
      }
    }
    return any;
  }

  affilOf(w: World, owner: number): Affil {
    if (owner === -2) return 'unknown';
    if (owner < 0) return 'neutral';
    if (owner === w.me) return 'own';
    return w.teamOf(owner) === w.myTeam ? 'ally' : 'hostile';
  }

  draw(v: OverlayView, dt: number) {
    const ctx = this.ctx;
    const w = v.world;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.items = [];
    const dist = v.rig.dist;
    const zoomedOut = Math.min(1, Math.max(0, (dist - 25) / 40));
    const lift = Math.min(1, Math.max(0, (12 - dist) / 7)); // symbol lift when close
    const symSize = Math.round(10 + Math.max(0, Math.min(2, (60 - dist) / 25)));
    ctx.font = `500 10px ${FONT}`;
    ctx.lineCap = 'round';

    // Map grid, weather, island names and the fog of war come from cached layers, rebuilt a few
    // times a second; everything after this is drawn fresh every frame.
    this.drawStatic(v, zoomedOut, dist);
    if (v.showSensors) this.drawSensorLegend();

    // ---- range rings & orders for selection ----
    const selUnits: UView[] = [];
    for (const id of v.selected) {
      const u = w.units.get(id);
      if (!u) continue;
      selUnits.push(u);
      this.drawOrder(v, u);
      if (UNITS[u.type].domain === 'air') this.drawFuelRange(v, u, v.selected.size > 3 ? 0.5 : 1);
    }
    if (selUnits.length && (v.showRanges || selUnits.length <= 12)) this.drawRanges(v, selUnits, selUnits.length > 6 ? 0.6 : 1);
    if (v.mode?.k === 'unload') this.drawUnloadMode(v);
    if (v.mode?.k === 'launch') this.drawLaunchMode(v);
    if (v.mode?.k === 'bombard') this.drawBombardMode(v);
    if (w.setup) this.drawDeployZone(v);
    else this.drawBuildGhosts(v);

    // ---- sites ----
    for (const s of w.map.sites) {
      const sv = w.sites[s.id];
      const gy = groundY(w.map, s.x, s.y);
      if (!this.proj(v, s.x, gy + 0.15, s.y)) continue;
      const sx = P.x;
      const sy = P.y - lift * 18;
      const affil = this.affilOf(w, sv.owner);
      const scol = playerColor(sv.owner) ?? sideColor(affil);
      const hov = v.hover?.kind === 'site' && v.hover.id === s.id;
      const img = symbolCanvas(affil, 'site', SITE_GLYPH[s.type], symSize - 1, hov, scol);
      ctx.globalAlpha = 0.95;
      this.blit(img, sx, sy);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'site', id: s.id, sx, sy, own: sv.owner === w.me, type: null });
      if (sv.cap > 0 && sv.capBy >= 0) {
        const col = playerColor(sv.capBy) ?? sideColor(this.affilOf(w, sv.capBy));
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, symSize * 1.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sv.cap);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.arc(sx, sy, symSize * 1.55, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // Capture radius on the ground.
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        if (this.circle(v, s.x, s.y, 1.6, gy, 32)) ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      if (lift > 0.3 || hov) {
        ctx.globalAlpha = Math.max(lift, hov ? 1 : 0) * 0.8;
        ctx.fillStyle = scol;
        ctx.textAlign = 'center';
        ctx.font = `500 9px ${FONT}`;
        ctx.fillText(BUILDINGS[s.type].name.toUpperCase(), sx, sy + symSize + 12);
        ctx.globalAlpha = 1;
      }
      if (hov && (BUILDINGS[s.type].radarAir > 0 || BUILDINGS[s.type].radarSurf > 0)) {
        ctx.strokeStyle = scol;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 5]);
        if (this.circle(v, s.x, s.y, Math.max(BUILDINGS[s.type].radarAir, BUILDINGS[s.type].radarSurf))) ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // ---- our sonobuoys: a small violet ring with a dot, fading in their last 20 s ----
    for (const [bx, by, left] of w.buoys) {
      if (!this.proj(v, bx, 0, by)) continue;
      ctx.globalAlpha = 0.55 * Math.min(1, left / 20);
      ctx.strokeStyle = '#a890ff';
      ctx.fillStyle = '#a890ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(P.x, P.y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillRect(P.x - 0.75, P.y - 0.75, 1.5, 1.5);
      ctx.globalAlpha = 1;
    }

    // ---- ghosts (last known positions) ----
    for (const g of w.ghosts.values()) {
      const age = w.clock - g.t;
      const a = Math.max(0, 1 - age / GHOST_LIFE) * 0.4;
      if (!this.proj(v, g.x, 0, g.y)) continue;
      const img = symbolCanvas(g.type ? 'hostile' : 'unknown', g.domain as SymDomain, glyphFor(g.type), symSize - 2);
      ctx.globalAlpha = a;
      this.blit(img, P.x, P.y);
      ctx.fillStyle = SIDE.unknown;
      ctx.textAlign = 'center';
      ctx.font = `500 8px ${FONT}`;
      ctx.fillText('LKP ' + Math.floor(age) + 's', P.x, P.y + symSize + 9);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'ghost', id: g.id, sx: P.x, sy: P.y, own: false, type: g.type });
    }

    // ---- radar contacts: one calm marker per track ----
    // Just a small symbol and a one-word class; the marker glides as the estimate improves.
    // The position error shows only as text, and only on hover (no overlapping circles).
    for (const c of w.contacts.values()) {
      const type = c.kind >= 10 ? (UNIT_TYPES[c.kind - 10] as UnitType) : null;
      const domain = (type ? UNITS[type].domain : DOMAINS[c.kind]) as SymDomain;
      const affil: Affil = type ? 'hostile' : 'unknown';
      const col = sideColor(affil);
      const fadeIn = Math.min(1, (w.clock - c.born) / 0.8);
      const hov = v.hover?.kind === 'contact' && v.hover.id === c.id;
      if (!this.proj(v, c.x, 0, c.y)) continue;
      if (c.esm) {
        // ESM-only: we hear its radar but no sensor of ours sees it. A faint emitter mark (a dot with
        // two pulsing wave arcs) instead of a track symbol, so it reads as "heard", not "seen".
        const k = (w.clock * 0.9 + c.id * 0.13) % 1;
        ctx.strokeStyle = SIDE.unknown;
        ctx.fillStyle = SIDE.unknown;
        ctx.lineWidth = 1;
        ctx.globalAlpha = fadeIn * 0.7;
        ctx.beginPath();
        ctx.arc(P.x, P.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
        for (const s of [1, -1]) {
          for (const [rr, a] of [
            [4 + k * 3, 0.6 * (1 - k)],
            [7 + k * 3, 0.35 * (1 - k)],
          ]) {
            ctx.globalAlpha = fadeIn * a;
            ctx.beginPath();
            ctx.arc(P.x, P.y, rr, s > 0 ? -0.6 : Math.PI - 0.6, s > 0 ? 0.6 : Math.PI + 0.6);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = fadeIn * (hov ? 0.9 : 0.5);
        ctx.textAlign = 'left';
        ctx.font = `500 8px ${FONT}`;
        ctx.fillText('ESM', P.x + symSize + 2, P.y + 3);
        if (hov) ctx.fillText('RADAR HEARD · NOT SEEN · CANNOT TARGET', P.x + symSize + 2, P.y + 12);
        ctx.globalAlpha = 1;
        this.items.push({ kind: 'contact', id: c.id, sx: P.x, sy: P.y, own: false, type });
        continue;
      }
      ctx.globalAlpha = fadeIn * 0.9;
      this.blit(symbolCanvas(affil, domain, glyphFor(type), symSize - 2, hov), P.x, P.y);
      ctx.globalAlpha = fadeIn * (hov ? 0.9 : 0.6);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.font = `500 8px ${FONT}`;
      ctx.fillText(type ? UNITS[type].short : domain === 'sub' ? 'SONAR' : domain === 'air' ? 'AIR' : domain === 'land' ? 'GROUND' : 'SURFACE', P.x + symSize + 2, P.y + 3);
      if (hov) ctx.fillText(type ? 'IDENTIFIED · NO FIRM TRACK' : 'UNIDENTIFIED · CANNOT TARGET', P.x + symSize + 2, P.y + 12);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'contact', id: c.id, sx: P.x, sy: P.y, own: false, type });
    }

    // ---- units ----
    const list = [...w.units.values()].filter((u) => !(u.flags & F_ABOARD)).sort((a, b) => (UNITS[a.type].domain === 'air' ? 1 : 0) - (UNITS[b.type].domain === 'air' ? 1 : 0));
    for (const u of list) {
      const def = UNITS[u.type];
      const dom = def.domain;
      const air = dom === 'air';
      const y3 = visAlt(w.map, u.type, u.x, u.y, u.alt);
      if (!this.proj(v, u.x, y3, u.y)) continue;
      let sx = P.x;
      let sy = P.y;
      const affil = this.affilOf(w, u.owner);
      const col = playerColor(u.owner) ?? sideColor(affil);
      if (air && !(u.flags & F_LANDED)) {
        // Altitude stalk down to the surface.
        const gx = sx;
        const gy0 = sy;
        if (this.proj(v, u.x, groundY(w.map, u.x, u.y), u.y)) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(gx, gy0);
          ctx.lineTo(P.x, P.y);
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(P.x - 1, P.y - 1, 2, 2);
          ctx.globalAlpha = 1;
        }
      }
      const small = u.type === 'merchant' || u.type === 'lander';
      const liftPx = lift * (air ? 10 : 22);
      if (liftPx > 1 && !air) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.35 * lift;
        ctx.beginPath();
        ctx.moveTo(sx, sy - 3);
        ctx.lineTo(sx, sy - liftPx + symSize * 0.8);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      sy -= liftPx;
      const sel = v.selected.has(u.id);
      const hov = v.hover?.kind === 'unit' && v.hover.id === u.id;
      if (sel && !this.prevSel.has(u.id)) this.selPulse.set(u.id, w.clock);
      const pt = this.selPulse.get(u.id);
      if (pt !== undefined) {
        const k = (w.clock - pt) / 0.45;
        if (k >= 1) this.selPulse.delete(u.id);
        else {
          ctx.strokeStyle = '#e8f6ff';
          ctx.globalAlpha = (1 - k) * 0.9;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, symSize * (1.2 + k * 1.6), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      const sz = small ? symSize - 4 : symSize;
      // Radar warning: like a radar-warning receiver, a thin amber arc on the side the enemy radar
      // is painting from, with a faint glint sweeping along it (the beam brushing past).
      if (u.flags & F_PAINTED && u.owner === w.me) this.drawRadarLock(v, u, y3, sx, sy, sz);
      const img = symbolCanvas(affil, dom as SymDomain, glyphFor(u.type), sz, sel || hov, col);
      const born = Math.min(1, (w.clock - u.born) / 0.4);
      ctx.globalAlpha = (small ? 0.75 : 1) * born;
      if (born < 1) {
        const s = 1 + (1 - born) * 0.8;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(s, s);
        this.blit(img, 0, 0);
        ctx.restore();
      } else this.blit(img, sx, sy);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'unit', id: u.id, sx, sy, own: u.owner === w.me, type: u.type });
      // Health bar.
      if (!small || u.hp < 100) {
        const bw = sz * 2;
        const hp = u.hp / 100;
        const by = sy + sz + 4;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(sx - bw / 2 - 1, by - 1, bw + 2, 4);
        ctx.fillStyle = hp > 0.6 ? '#7dff9a' : hp > 0.3 ? '#ffc94a' : '#ff5a4a';
        ctx.fillRect(sx - bw / 2, by, bw * hp, 2);
      }
      // Damaged systems: tiny tags under the health bar (own ships show every system).
      const tags = this.damageTags(w, u);
      if (tags.length) {
        ctx.font = `600 7px ${FONT}`;
        ctx.textAlign = 'left';
        let tw = 0;
        for (const [t] of tags) tw += ctx.measureText(t).width + 4;
        let tx = sx - tw / 2;
        const ty = sy + sz + 13;
        for (const [t, c] of tags) {
          const wdt = ctx.measureText(t).width;
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(tx - 1, ty - 7, wdt + 2, 9);
          ctx.fillStyle = c;
          ctx.fillText(t, tx, ty);
          tx += wdt + 4;
        }
      }
      if (u.flags & F_RETREAT) {
        ctx.fillStyle = '#ffc94a';
        ctx.font = `600 8px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('◄ RTRT', sx, sy - sz - 6);
      }
      if (sel) {
        const b = sz * 1.45;
        const k = 4;
        ctx.strokeStyle = '#e8f6ff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const [cx, cy, dx, dy] of [
          [-b, -b, 1, 1],
          [b, -b, -1, 1],
          [-b, b, 1, -1],
          [b, b, -1, -1],
        ]) {
          ctx.moveTo(sx + cx, sy + cy + dy * k);
          ctx.lineTo(sx + cx, sy + cy);
          ctx.lineTo(sx + cx + dx * k, sy + cy);
        }
        ctx.stroke();
      }
      if ((sel && v.selected.size <= 4) || hov) {
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.font = `500 9px ${FONT}`;
        ctx.fillText(this.label(w, u), sx + sz * 1.6, sy + 3);
      }
    }

    // ---- projectiles ----
    for (const p of w.projs.values()) {
      if (p.kind === 'mine') {
        if (!this.proj(v, p.rx, 0, p.ry)) continue;
        ctx.strokeStyle = SIDE.own;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(P.x, P.y, 3, 0, Math.PI * 2);
        ctx.moveTo(P.x - 4, P.y - 4);
        ctx.lineTo(P.x + 4, P.y + 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      if (p.kind === 'shell' && dist > 30) continue;
      if (p.kind === 'atgm') {
        // Anti-tank missiles: a small dot with a short tail, amber when hostile, white when ours.
        // Small on purpose: they must not read as anti-ship missiles. Hidden when zoomed far out.
        if (dist > 45) continue;
        const a3 = weaponY(w.map, p.kind, p.air, p.rx, p.ry, p.ralt, p.alt0, w.clock - p.born);
        if (!this.proj(v, p.rx, a3, p.ry)) continue;
        const sx = P.x;
        const sy = P.y;
        const col = p.mine ? '#f2f8ff' : '#ffb24a';
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const dl = Math.hypot(dx, dy);
        if (dl > 1e-4 && this.proj(v, p.rx - (dx / dl) * 0.12, a3, p.ry - (dy / dl) * 0.12)) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(P.x, P.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = col;
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        ctx.globalAlpha = 1;
        continue;
      }
      const guided = p.kind === 'missile' || p.kind === 'sam';
      const a3 =
        p.kind === 'torpedo'
          ? 0
          : p.kind === 'shell' || p.kind === 'bomb'
            ? p.ralt
            : weaponY(w.map, p.kind, p.air, p.rx, p.ry, p.ralt, p.alt0, w.clock - p.born);
      if (!this.proj(v, p.rx, a3, p.ry)) continue;
      const sx = P.x;
      const sy = P.y;
      // Two families that must never be confused:
      //   anti-ship (and other surface-attack) missiles: a filled arrowhead with a long trail;
      //     hostile ones red with a faint halo and an "ASM" tag, ours white.
      //   anti-air missiles (SAM, AAM, MANPADS): a small hollow ring with a short trail;
      //     ours cyan, hostile magenta.
      const asm = p.kind === 'missile';
      const col = asm ? (p.mine ? '#f2f8ff' : '#ff4a3d') : p.mine ? '#5fe3ff' : '#ff6ad5';
      if (guided) {
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const dl = Math.hypot(dx, dy);
        // Screen-space direction of travel (from a point slightly behind the missile).
        let ux = 1;
        let uy = 0;
        if (dl > 1e-4 && this.proj(v, p.rx - (dx / dl) * 0.2, a3, p.ry - (dy / dl) * 0.2)) {
          const ex = sx - P.x;
          const ey = sy - P.y;
          const el = Math.hypot(ex, ey);
          if (el > 0.01) {
            ux = ex / el;
            uy = ey / el;
          }
          // Short trail for anti-air missiles only; anti-ship darts carry no tail.
          if (!asm) {
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx - ux * 7, sy - uy * 7);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        if (asm) {
          // A slim dart with a notched back, pointing along the flight path; a soft glow
          // (hostile only) instead of a filled halo.
          const px = -uy;
          const py = ux;
          ctx.save();
          if (!p.mine) {
            ctx.shadowColor = col;
            ctx.shadowBlur = 6;
          }
          ctx.fillStyle = col;
          ctx.globalAlpha = p.mine ? 0.75 : 0.9;
          ctx.beginPath();
          ctx.moveTo(sx + ux * 5, sy + uy * 5);
          ctx.lineTo(sx - ux * 3.5 + px * 2.4, sy - uy * 3.5 + py * 2.4);
          ctx.lineTo(sx - ux * 2, sy - uy * 2);
          ctx.lineTo(sx - ux * 3.5 - px * 2.4, sy - uy * 3.5 - py * 2.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          if (!p.mine) {
            ctx.font = `500 7px ${FONT}`;
            ctx.textAlign = 'left';
            ctx.fillStyle = col;
            ctx.globalAlpha = 0.55;
            ctx.fillText('ASM', sx + 6, sy - 4);
            ctx.globalAlpha = 1;
          }
        } else {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (p.kind === 'torpedo') {
        ctx.fillStyle = p.mine ? '#f2f8ff' : '#ff4a3d';
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(w.clock * 8);
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#ffd9a0';
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }

    // ---- shock rings ----
    for (const s of this.shocks) {
      s.t += dt;
      const k = s.t / s.dur;
      if (k >= 1) continue;
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.lineWidth = 1.5;
      if (this.circle(v, s.x, s.y, s.r * (0.2 + k * 0.8), s.alt, 32)) ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.shocks = this.shocks.filter((s) => s.t < s.dur);
    // Shot-down missiles: a small cross that fades, so a missile never just vanishes.
    for (const s of this.splashes) {
      s.t += dt;
      if (s.t > 2.5 || !this.proj(v, s.x, s.alt, s.y)) continue;
      const k = s.t / 2.5;
      const L = 3 + (1 - k) * 2;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.85 * (1 - k);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(P.x - L, P.y - L);
      ctx.lineTo(P.x + L, P.y + L);
      ctx.moveTo(P.x + L, P.y - L);
      ctx.lineTo(P.x - L, P.y + L);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.splashes = this.splashes.filter((s) => s.t <= 2.5);

    this.prevSel = new Set(v.selected);

    // ---- floating text (cash, captures) ----
    for (const f of this.floaters) {
      f.t += dt;
      if (f.t > 2.2 || !this.proj(v, f.x, f.alt, f.y)) continue;
      const k = f.t / 2.2;
      ctx.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.5) / 0.5);
      ctx.fillStyle = f.color;
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(f.text, P.x, P.y - 18 - f.yo - k * 26);
      ctx.globalAlpha = 1;
    }
    this.floaters = this.floaters.filter((f) => f.t <= 2.2);

    // ---- command pings ----
    for (const p of v.pings) {
      const age = w.clock - p.t;
      if (age > 0.7) continue;
      const k = age / 0.7;
      if (!this.proj(v, p.x, groundY(w.map, p.x, p.y), p.y)) continue;
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const r = 4 + k * 14;
      if (p.kind === 'attack') {
        ctx.moveTo(P.x - r, P.y - r);
        ctx.lineTo(P.x + r, P.y + r);
        ctx.moveTo(P.x + r, P.y - r);
        ctx.lineTo(P.x - r, P.y + r);
      } else {
        ctx.ellipse(P.x, P.y, r, r * 0.6, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- rain streaks (screen space) ----
    if (v.rain > 0.05) {
      const n = Math.floor(v.rain * 160 * Math.max(0.3, Math.min(1, 20 / dist)));
      const t = w.clock;
      ctx.strokeStyle = 'rgba(200,215,230,1)';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.18 + v.rain * 0.12;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const hx = Math.sin(i * 12.9898) * 43758.5453;
        const hy = Math.sin(i * 78.233) * 12345.6789;
        const fx = hx - Math.floor(hx);
        const fy = hy - Math.floor(hy);
        const sp = 0.9 + fx * 0.6;
        const x = (((fx * this.w + t * 160 * sp) % this.w) + this.w) % this.w;
        const y = (((fy * this.h + t * 900 * sp) % this.h) + this.h) % this.h;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4, y - 16);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- selection box ----
    if (v.dragRect) {
      const d = v.dragRect;
      ctx.strokeStyle = 'rgba(200,235,255,0.9)';
      ctx.fillStyle = 'rgba(111,208,255,0.07)';
      ctx.lineWidth = 1;
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
  }

  private blit(img: HTMLCanvasElement, x: number, y: number) {
    const w = img.width / this.dpr;
    const h = img.height / this.dpr;
    this.ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
  }

  /** Short tags for knocked-out ship systems: [text, colour]. */
  /** Bearing arc for a unit an enemy radar holds in track (see the F_PAINTED cue above). */
  private drawRadarLock(v: OverlayView, u: UView, y3: number, sx: number, sy: number, sz: number) {
    const w = v.world;
    const ctx = this.ctx;
    const b = w.details.get(u.id)?.[16];
    if (b === undefined || b === 999) return;
    const bearing = b / 100;
    // The map bearing turned into a screen direction (the camera may be rotated and tilted).
    if (!this.proj(v, u.x, y3, u.y)) return;
    const bx = P.x;
    const by = P.y;
    if (!this.proj(v, u.x + Math.cos(bearing), y3, u.y + Math.sin(bearing))) return;
    const ang = Math.atan2(P.y - by, P.x - bx);
    const R = sz * 1.95;
    const half = 0.38;
    const t = w.clock + u.id * 0.37;
    const breathe = 0.5 + 0.5 * Math.sin(t * 2.4);
    ctx.save();
    ctx.lineCap = 'round';
    // The arc and its end ticks.
    ctx.strokeStyle = `rgba(255, 186, 92, ${0.32 + 0.28 * breathe})`;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(sx, sy, R, ang - half, ang + half);
    ctx.stroke();
    ctx.lineWidth = 1;
    for (const e of [ang - half, ang + half]) {
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(e) * (R - 2.5), sy + Math.sin(e) * (R - 2.5));
      ctx.lineTo(sx + Math.cos(e) * (R + 2.5), sy + Math.sin(e) * (R + 2.5));
      ctx.stroke();
    }
    // The glint: travels end to end every 1.6 s, brightest mid-way.
    const f = (t / 1.6) % 1;
    const ga = ang - half + f * half * 2;
    ctx.fillStyle = `rgba(255, 226, 170, ${Math.sin(f * Math.PI) * 0.85})`;
    ctx.beginPath();
    ctx.arc(sx + Math.cos(ga) * R, sy + Math.sin(ga) * R, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private damageTags(w: World, u: UView): [string, string][] {
    const out: [string, string][] = [];
    const d = u.owner === w.me ? w.details.get(u.id)?.[13] : undefined;
    if (u.flags & F_STOPPED) out.push(['DIW', '#ff5a4a']);
    else if (d && d[0] > 0) out.push(['ENG', '#ffb36b']);
    if (d && d[1] > 0) out.push(['RUD', '#ffb36b']);
    if (d && d[2] > 0) out.push(['RAD', '#ffb36b']);
    if (d && d[6] >= 0) out.push(['WPN', '#ffb36b']);
    if (u.flags & F_FIRE) out.push(['FIRE', '#ff7a3a']);
    if (d && d[4] > 0) out.push(['FLD', '#6fb8ff']);
    if (u.flags & F_STUN) out.push(['STUN', '#ffe14a']);
    if (u.flags & F_DARK && w.teamOf(u.owner) === w.myTeam) out.push(['DARK', '#9fb0bd']);
    if (u.owner === w.me && u.flags & F_HOLD) out.push(['HOLD', '#9fb0bd']);
    if (u.owner === w.me && u.flags & F_FREE) out.push(['FREE', '#ff9a6b']);
    return out;
  }

  label(w: World, u: UView): string {
    return `${UNITS[u.type].short} ${unitLabel(w, u)}`;
  }

  private drawGrid(v: OverlayView, zoomedOut: number) {
    const ctx = this.ctx;
    const S = v.world.map.size;
    ctx.strokeStyle = 'rgba(220,240,255,1)';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.05 + zoomedOut * 0.07;
    ctx.beginPath();
    const steps = Math.ceil(S / 5);
    for (let k = 0; k <= S; k += 10) {
      this.polyline(v, [[k, 0], [k, S]], 0, steps);
      this.polyline(v, [[0, k], [S, k]], 0, steps);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    this.polyline(
      v,
      [
        [0, 0],
        [S, 0],
        [S, S],
        [0, S],
        [0, 0],
      ],
      0,
      steps,
    );
    ctx.stroke();
    // Grid labels along the top edge.
    ctx.globalAlpha = 0.25 + zoomedOut * 0.2;
    ctx.fillStyle = '#dff2ff';
    ctx.font = `500 9px ${FONT}`;
    ctx.textAlign = 'center';
    for (let k = 0; k < S; k += 10) {
      if (this.proj(v, k + 5, 0, -1.2)) ctx.fillText(String.fromCharCode(65 + k / 10), P.x, P.y);
      if (this.proj(v, -1.5, 0, k + 5)) ctx.fillText(String(k / 10 + 1), P.x, P.y + 3);
    }
    ctx.globalAlpha = 1;
  }

  private drawWeather(v: OverlayView, zoomedOut: number) {
    const ctx = this.ctx;
    for (const [kind, x, y, r, i] of v.world.weather) {
      if (i < 5) continue;
      const a = (i / 100) * (0.25 + zoomedOut * 0.5);
      ctx.strokeStyle = kind === 0 ? '#b9c6d8' : '#e8eef2';
      ctx.globalAlpha = a;
      ctx.lineWidth = 1;
      ctx.setLineDash(kind === 0 ? [10, 6] : [2, 6]);
      // Same shape the simulation uses: squall line across the wind, fog tongue along it.
      ctx.beginPath();
      const outline: [number, number][] = [];
      for (let k = 0; k <= 64; k++) outline.push(weatherOutline(kind as 0 | 1, x, y, r * 0.92, (k / 64) * Math.PI * 2));
      if (this.polyline(v, outline, 0.2)) ctx.stroke();
      ctx.setLineDash([]);
      if (this.proj(v, x, 0.2, y)) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = `600 10px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = a * 1.4;
        ctx.fillText(kind === 0 ? '⛈ STORM' : '≋ FOG', P.x, P.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawIslandLabels(v: OverlayView, dist: number) {
    const ctx = this.ctx;
    const a = Math.min(1, Math.max(0, (dist - 8) / 15)) * 0.45;
    if (a <= 0.01) return;
    ctx.fillStyle = '#f2f6f8';
    ctx.font = `500 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.globalAlpha = a;
    for (const isl of v.world.map.islands) {
      if (isl.minor) continue;
      if (!this.proj(v, isl.x, 0.6, isl.y + isl.r * 1.1)) continue;
      const name = isl.home >= 0 ? this.homeName(v.world, isl.home) : isl.name;
      ctx.fillText(name.split('').join(' '), P.x, P.y + 14);
    }
    ctx.globalAlpha = 1;
  }

  private homeName(w: World, slot: number): string {
    const p = w.players.find((p) => p.slot === slot);
    return p ? `${p.name}` : 'UNCLAIMED';
  }

  // ---------------------------------------------------------------- cached map layers
  //
  // Three offscreen layers: "under" (grid, weather, island names), "fog" (the sensor veil, at half
  // resolution) and "edge" (coverage outlines). They are drawn for the camera as it was when they
  // were built, with a margin around the screen. Each frame they are laid onto the overlay through
  // the 2D transform that takes three ground points from where they were to where they are now, so
  // they follow panning, zoom and rotation between rebuilds. A rebuild comes when the camera has
  // moved and 0.1 s has passed, when coverage or weather changed and 0.25 s has passed, or at once
  // when the warp would show an edge of the layer or distort it too much.

  private layers = { under: newLayer(), fog: newLayer(), edge: newLayer() };
  private built = {
    at: -1,
    tx: 0,
    ty: 0,
    dist: 0,
    yaw: 0,
    w: 0,
    h: 0,
    full: false,
    margin: 0,
    cov: null as Coverage | null,
    refs: [0, 0, 0, 0, 0, 0],
    scr: [0, 0, 0, 0, 0, 0],
  };

  private drawStatic(v: OverlayView, zoomedOut: number, dist: number) {
    const w = v.world;
    const rig = v.rig;
    const b = this.built;
    const now = w.clock;
    const full = v.showSensors;
    let warp: number[] | null = null;
    if (b.at >= 0 && b.w === this.w && b.h === this.h && b.full === full && now >= b.at) {
      const dst: number[] = [];
      for (let i = 0; i < 6; i += 2) {
        if (!this.proj(v, b.refs[i], 0, b.refs[i + 1])) break;
        dst.push(P.x, P.y);
      }
      if (dst.length === 6) warp = affine(b.scr, dst);
    }
    let rebuild = !warp || !this.covers(warp, b.margin) || Math.abs(Math.log(rig.dist / b.dist)) > 0.12 || Math.abs(rig.yaw - b.yaw) > 0.06;
    if (!rebuild) {
      const moved = rig.tx !== b.tx || rig.ty !== b.ty || rig.dist !== b.dist || rig.yaw !== b.yaw;
      const age = now - b.at;
      if (coverageStale(w)) {
        // Recompute coverage on this frame and rebuild the layers on the next one, so the two
        // costs never land on the same frame.
        sensorCoverage(w);
      } else if ((moved && age >= 0.1) || (age >= 0.25 && (sensorCoverage(w) !== b.cov || w.weather.length > 0))) rebuild = true;
    }
    if (rebuild) {
      this.buildLayers(v, zoomedOut, dist, full);
      warp = [1, 0, 0, 1, 0, 0];
    }
    const real = this.ctx;
    for (const L of [this.layers.under, this.layers.fog, this.layers.edge]) {
      if (!L.used) continue;
      real.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      real.transform(warp![0], warp![1], warp![2], warp![3], warp![4], warp![5]);
      real.translate(-b.margin, -b.margin);
      real.scale(1 / L.sc, 1 / L.sc);
      real.drawImage(L.canvas, 0, 0);
    }
    real.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Whether the warped layer (built with this margin) still covers the whole screen. */
  private covers(m: number[], margin: number): boolean {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-6) return false;
    for (const [x, y] of [
      [0, 0],
      [this.w, 0],
      [0, this.h],
      [this.w, this.h],
    ]) {
      // Inverse of the affine map: screen now -> screen when built.
      const dx = x - m[4];
      const dy = y - m[5];
      const ox = (m[3] * dx - m[2] * dy) / det;
      const oy = (-m[1] * dx + m[0] * dy) / det;
      if (ox < -margin + 2 || oy < -margin + 2 || ox > this.w + margin - 2 || oy > this.h + margin - 2) return false;
    }
    return true;
  }

  private buildLayers(v: OverlayView, zoomedOut: number, dist: number, full: boolean) {
    const w = v.world;
    const rig = v.rig;
    const b = this.built;
    const margin = Math.round(Math.max(this.w, this.h) * 0.15);
    const cov = sensorCoverage(w);
    // Reference points on the ground around the view centre, for the warp.
    const k = Math.max(0.5, rig.dist * 0.2);
    const refs = [rig.tx, rig.ty, rig.tx + k, rig.ty, rig.tx, rig.ty + k];
    const scr: number[] = [];
    for (let i = 0; i < 6; i += 2) {
      this.proj(v, refs[i], 0, refs[i + 1]);
      scr.push(P.x, P.y);
    }
    Object.assign(b, { at: w.clock, tx: rig.tx, ty: rig.ty, dist: rig.dist, yaw: rig.yaw, w: this.w, h: this.h, full, margin, cov, refs, scr });
    const real = this.ctx;
    const begin = (L: Layer, sc: number) => {
      const cw = Math.ceil((this.w + margin * 2) * sc);
      const ch = Math.ceil((this.h + margin * 2) * sc);
      if (L.canvas.width !== cw || L.canvas.height !== ch) {
        L.canvas.width = cw;
        L.canvas.height = ch;
      }
      L.sc = sc;
      L.used = true;
      const g = L.ctx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, cw, ch);
      // Draw in screen pixels (CSS), offset by the margin.
      g.setTransform(sc, 0, 0, sc, margin * sc, margin * sc);
      return g;
    };
    this.pad = margin;
    try {
      // 1. Under the fog: grid, weather outlines, island names (sharp, full resolution).
      this.ctx = begin(this.layers.under, this.dpr);
      this.ctx.lineCap = 'round';
      this.drawGrid(v, zoomedOut);
      this.drawWeather(v, zoomedOut);
      this.drawIslandLabels(v, dist);

      // 2. The veil (half resolution: it is soft anyway): dark everywhere, half cleared under air
      // radar, fully cleared under the surface picture.
      const F = this.layers.fog;
      const vg = begin(F, 0.5);
      vg.setTransform(1, 0, 0, 1, 0, 0);
      vg.fillStyle = full ? 'rgba(2, 6, 10, 0.62)' : 'rgba(4, 10, 18, 0.32)';
      vg.fillRect(0, 0, F.canvas.width, F.canvas.height);
      if (!full) {
        // Faint diagonal hatching marks the fog as "not seen" without hiding the map.
        vg.fillStyle = this.hatch(vg);
        vg.fillRect(0, 0, F.canvas.width, F.canvas.height);
      }
      vg.setTransform(F.sc, 0, 0, F.sc, margin * F.sc, margin * F.sc);
      // Coverage outlines already are the merged edge (weather bites included): one even-odd fill each.
      vg.globalCompositeOperation = 'destination-out';
      vg.fillStyle = '#000';
      for (const [loops, a] of [
        [cov.air, 0.5],
        [cov.surf, 1],
      ] as [Loop[], number][]) {
        if (!loops.length) continue;
        vg.globalAlpha = a;
        vg.beginPath();
        this.loops(v, loops, vg);
        vg.fill('evenodd');
      }
      vg.globalAlpha = 1;
      vg.globalCompositeOperation = 'source-over';

      // 3. Coverage edges: a thin faint line where the surface picture ends, or with V the merged
      // outline of each sensor kind.
      const eg = begin(this.layers.edge, this.dpr);
      eg.lineJoin = 'round';
      const stroke = (loops: Loop[], col: string, width: number, alpha: number) => {
        if (!loops.length) return;
        eg.strokeStyle = col;
        eg.lineWidth = width;
        eg.globalAlpha = alpha;
        eg.beginPath();
        this.loops(v, loops, eg);
        eg.stroke();
        eg.globalAlpha = 1;
      };
      if (!full) stroke(cov.surf, COVER_COLORS.surf, 0.75, 0.4);
      else {
        stroke(cov.air, COVER_COLORS.air, 1.25, 0.45);
        stroke(cov.surf, COVER_COLORS.surf, 1.25, 0.9);
        if (cov.sonar.length) {
          // Sonar discs: their union outline needs a scratch canvas of its own.
          const E = this.layers.edge;
          const sc = this.layer2();
          if (sc.canvas.width !== E.canvas.width || sc.canvas.height !== E.canvas.height) {
            sc.canvas.width = E.canvas.width;
            sc.canvas.height = E.canvas.height;
          }
          sc.ctx.setTransform(1, 0, 0, 1, 0, 0);
          sc.ctx.clearRect(0, 0, sc.canvas.width, sc.canvas.height);
          sc.ctx.setTransform(E.sc, 0, 0, E.sc, margin * E.sc, margin * E.sc);
          unionOutline(sc.ctx, cov.sonar, COVER_COLORS.sonar, 1.25, (g, d: Disc) => {
            this.ctx = g;
            this.circle(v, d[0], d[1], d[2], 0, 72);
            this.ctx = eg;
          });
          eg.setTransform(1, 0, 0, 1, 0, 0);
          eg.globalAlpha = 0.9;
          eg.drawImage(sc.canvas, 0, 0);
          eg.globalAlpha = 1;
        }
      }
    } finally {
      this.ctx = real;
      this.pad = 0;
    }
  }

  /** Legend for the full sensor view (V). */
  private drawSensorLegend() {
    const real = this.ctx;
    real.font = `600 9px ${FONT}`;
    real.textAlign = 'left';
    const items: [string, string][] = [
      ['SURFACE RADAR / EYES', COVER_COLORS.surf],
      ['AIR RADAR ONLY', COVER_COLORS.air],
      ['SONAR', COVER_COLORS.sonar],
    ];
    let lx = this.w / 2 - 190;
    const ly = 52;
    real.fillStyle = 'rgba(5, 9, 12, 0.7)';
    real.fillRect(lx - 10, ly - 12, 440, 18);
    for (const [t, c] of items) {
      real.fillStyle = c;
      real.fillRect(lx, ly - 4, 12, 2);
      real.fillText(t, lx + 16, ly);
      lx += real.measureText(t).width + 34;
    }
    real.fillStyle = 'rgba(232, 246, 255, 0.6)';
    real.fillText('V: CLOSE', lx - 10, ly);
  }

  private hatchPat: CanvasPattern | null = null;
  private hatch(g: CanvasRenderingContext2D): CanvasPattern {
    if (!this.hatchPat) {
      const c = document.createElement('canvas');
      // Drawn into the half-resolution fog layer: 4 px here is 8 px on screen.
      c.width = c.height = 4;
      const h = c.getContext('2d')!;
      h.strokeStyle = 'rgba(150, 190, 220, 0.09)';
      h.lineWidth = 0.75;
      h.beginPath();
      h.moveTo(-1, 5);
      h.lineTo(5, -1);
      h.stroke();
      this.hatchPat = g.createPattern(c, 'repeat')!;
    }
    return this.hatchPat;
  }

  private scratch2: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  private layer2() {
    if (!this.scratch2) {
      const canvas = document.createElement('canvas');
      this.scratch2 = { canvas, ctx: canvas.getContext('2d')! };
    }
    const sc = this.scratch2;
    if (sc.canvas.width !== this.canvas.width || sc.canvas.height !== this.canvas.height) {
      sc.canvas.width = this.canvas.width;
      sc.canvas.height = this.canvas.height;
    }
    return sc;
  }

  /**
   * Weapon range rings of the selection. Rings of the same weapon range (and kind: anti-air,
   * anti-sub, anti-surface) from several units merge into a single outline: only arcs outside
   * every other ring of the group are drawn, so a group shows the edge of its combined reach.
   */
  private drawRanges(v: OverlayView, units: UView[], alpha: number) {
    const w = v.world;
    const ctx = this.ctx;
    const groups = new Map<string, { x: number; y: number; r: number; y3: number }[]>();
    const groupMods = new Map<string, Map<string, string>>();
    for (const u of units) {
      if (!w.details.get(u.id)) continue;
      const y3 = UNITS[u.type].domain === 'land' ? groundY(w.map, u.x, u.y) * 0.2 : 0;
      const seen = new Set<string>();
      for (const m of weaponModsFor(w, u)) {
        const r = m.range ?? 0;
        if (r < 1.5) continue;
        const cls = m.dmg?.air && !m.dmg.sea && !m.dmg.land ? 'air' : m.dmg?.sub && !m.dmg.sea ? 'sub' : 'surf';
        const color = cls === 'air' ? '#7fd8ff' : cls === 'sub' ? '#9a8cff' : '#ffb36b';
        const key = color + ':' + r;
        let gm = groupMods.get(key);
        if (!gm) groupMods.set(key, (gm = new Map()));
        gm.set(m.id, m.name);
        if (seen.has(key)) continue;
        seen.add(key);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({ x: u.x, y: u.y, r, y3 });
      }
    }
    const hovered = v.hoverWeapon;
    for (const [key, circles] of groups) {
      const color = key.split(':')[0];
      const mods = groupMods.get(key)!;
      const hl = !!hovered && mods.has(hovered);
      ctx.strokeStyle = color;
      // The hovered weapon's ring: solid, bright and glowing; the others step back.
      ctx.globalAlpha = hl ? 0.95 : hovered ? 0.1 * alpha : 0.3 * alpha;
      ctx.lineWidth = hl ? 2 : 1;
      ctx.setLineDash(hl ? [] : [6, 6]);
      ctx.shadowColor = color;
      ctx.shadowBlur = hl ? 8 : 0;
      // Label once per kind, at the southmost point of the outline.
      let lab: { x: number; y: number; r: number; y3: number } | null = null;
      for (const c of circles) {
        const seg = Math.max(48, Math.min(160, Math.round(c.r * 6)));
        let open = false;
        ctx.beginPath();
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          const px = c.x + Math.cos(a) * c.r;
          const py = c.y + Math.sin(a) * c.r;
          let inside = false;
          for (const o of circles) {
            if (o === c) continue;
            const dd = Math.hypot(px - o.x, py - o.y);
            // Inside another ring (ties broken by order, so identical rings draw once).
            if (dd < o.r - 1e-3 || (Math.abs(dd - o.r) < 1e-3 && circles.indexOf(o) < circles.indexOf(c))) {
              inside = true;
              break;
            }
          }
          if (inside) {
            open = false;
            continue;
          }
          v.r.project(px, c.y3, py, P);
          if (P.z >= 1) {
            open = false;
            continue;
          }
          if (!open) ctx.moveTo(P.x, P.y);
          else ctx.lineTo(P.x, P.y);
          open = true;
          if (Math.abs(a - Math.PI / 2) < Math.PI / seg && (!lab || py > lab.y + lab.r)) lab = c;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      if (lab && (alpha >= 1 || hl) && this.proj(v, lab.x, 0, lab.y + lab.r)) {
        ctx.fillStyle = color;
        ctx.globalAlpha = hl ? 1 : hovered ? 0.15 : 0.5;
        ctx.font = hl ? `600 10px ${FONT}` : `500 8px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(hl ? `${mods.get(hovered!)!.toUpperCase()} · ${lab.r} KM` : `${lab.r}km`, P.x, P.y + (hl ? 13 : 10));
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Fuel range of a selected flight: every point it can still reach and then get home from.
   * That is an ellipse with the aircraft and its nearest base as foci (out-and-back distance
   * equals the range left). The flight turns home on its own when it reaches the edge.
   */
  private drawFuelRange(v: OverlayView, u: UView, alpha: number) {
    const d = v.world.details.get(u.id);
    if (!d || d[10] < 0) return;
    const ctx = this.ctx;
    const R = d[9];
    const bx = d[10];
    const by = d[11];
    const c = Math.hypot(bx - u.x, by - u.y) / 2;
    const a = R / 2;
    const cx = (u.x + bx) / 2;
    const cy = (u.y + by) / 2;
    const ang = Math.atan2(by - u.y, bx - u.x);
    const bingo = a <= c + 0.3;
    const col = bingo ? '#ff6a5a' : '#c8e6ff';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    if (!bingo) {
      const b = Math.sqrt(Math.max(0, a * a - c * c));
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      ctx.beginPath();
      const seg = 72;
      const ring: [number, number][] = [];
      for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        const ex = Math.cos(t) * a;
        const ey = Math.sin(t) * b;
        ring.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca]);
      }
      const any = this.polyline(v, ring);
      if (any) {
        ctx.globalAlpha = 0.04 * alpha;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.35 * alpha;
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Faint line home, with a label at the base.
    if (this.proj(v, u.x, 0, u.y)) {
      const sx = P.x;
      const sy = P.y;
      if (this.proj(v, bx, 0, by)) {
        ctx.globalAlpha = (bingo ? 0.6 : 0.25) * alpha;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(P.x, P.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (alpha >= 1) {
          ctx.globalAlpha = 0.7;
          ctx.fillStyle = col;
          ctx.font = `500 8px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(bingo ? 'BINGO · RTB' : `FUEL · ${Math.round(R / 2)} KM OUT AND BACK`, P.x, P.y + 14);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawOrder(v: OverlayView, u: UView) {
    const w = v.world;
    const d = w.details.get(u.id);
    if (!d) return;
    const code = ORDER_CODES[d[4]];
    const ctx = this.ctx;
    const y0 = visAlt(w.map, u.type, u.x, u.y, u.alt);
    if (!this.proj(v, u.x, y0, u.y)) return;
    const sx = P.x;
    const sy = P.y;
    let tx = d[5];
    let ty = d[6];
    let color = 'rgba(160,230,255,0.75)';
    if (code === 'attack') {
      const t = w.units.get(d[5]) ?? null;
      const c = w.contacts.get(d[5]);
      if (t) {
        tx = t.x;
        ty = t.y;
      } else if (c) {
        tx = c.x;
        ty = c.y;
      } else return;
      color = 'rgba(255,110,90,0.85)';
    } else if (code === 'move' || code === 'retreat' || code === 'patrol' || code === 'unload') {
      if (code === 'retreat') color = 'rgba(255,200,80,0.8)';
      if (code === 'unload') color = 'rgba(140,255,170,0.85)';
    } else if (code === 'bombard') {
      color = 'rgba(255,150,80,0.9)';
    } else if (code === 'board' || code === 'escort') {
      const s = w.units.get(d[5]);
      if (!s) return;
      tx = s.x;
      ty = s.y;
      color = code === 'escort' ? 'rgba(160,230,255,0.85)' : 'rgba(140,255,170,0.85)';
    } else return;
    const ty3 = groundY(w.map, tx, ty);
    if (!this.proj(v, tx, ty3, ty)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -w.clock * 12;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(P.x, P.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.beginPath();
    if (code === 'patrol') {
      ctx.globalAlpha = 0.6;
      if (this.circle(v, d[5], d[6], 2.6, 2, 32)) ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (code === 'bombard') {
      // The beaten zone: rounds fall anywhere inside it.
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([3, 3]);
      if (this.circle(v, d[5], d[6], BOMBARD_ZONE, ty3, 40)) ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    } else {
      ctx.arc(P.x, P.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Placed builds: every queued unit with a destination shows as a faint ghost there, joined by
   * a dashed line to the building that makes it (the front of each queue shows its progress).
   * In build mode the cursor carries a ghost: green with its source, or red with the reason.
   */
  private drawBuildGhosts(v: OverlayView) {
    const w = v.world;
    const ctx = this.ctx;
    const symSize = 11;
    const col = sideColor('own');
    const at = (x: number, y: number, type: UnitType) => (UNITS[type].domain === 'land' ? groundY(w.map, x, y) : 0);
    const line = (sx: number, sy: number, tx: number, ty: number, alpha: number) => {
      if (!this.proj(v, sx, 0, sy)) return;
      const ax = P.x;
      const ay = P.y;
      if (!this.proj(v, tx, 0, ty)) return;
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(P.x, P.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    for (const cat of ['naval', 'ground', 'air'] as const) {
      w.queues[cat].forEach((it, i) => {
        if (it.x === undefined || it.y === undefined) return;
        const src = it.s !== undefined ? w.map.sites[it.s] : undefined;
        if (src) {
          const from = cat === 'naval' && src.dock ? src.dock : src;
          line(from.x, from.y, it.x, it.y, 0.22);
        }
        if (!this.proj(v, it.x, at(it.x, it.y, it.type), it.y)) return;
        ctx.globalAlpha = 0.45;
        this.blit(symbolCanvas('own', UNITS[it.type].domain as SymDomain, glyphFor(it.type), symSize, false), P.x, P.y);
        ctx.globalAlpha = 1;
        if (i === 0) {
          // Build progress as a thin arc around the front ghost.
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(P.x, P.y, symSize * 1.45, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * it.progress);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
    }
    const m = v.mode;
    if (m?.k !== 'build' || !v.mouse.valid) return;
    const x = v.mouse.wx;
    const y = v.mouse.wy;
    const ours = (id: number) => w.sites[id]?.owner === w.me;
    const src = rallySite(w.map, w.map.sites, ours, m.type, x, y);
    const cat = UNITS[m.type].category as 'naval' | 'ground' | 'air';
    const afford = w.cash >= unitCost(m.type, w.myFaction);
    const full = w.queues[cat].length >= 8;
    const ok = src >= 0 && afford && !full;
    if (src >= 0) {
      const s = w.map.sites[src];
      const from = cat === 'naval' && s.dock ? s.dock : s;
      line(from.x, from.y, x, y, ok ? 0.6 : 0.3);
    }
    if (!this.proj(v, x, at(x, y, m.type), y)) return;
    ctx.globalAlpha = ok ? 0.85 : 0.5;
    this.blit(symbolCanvas('own', UNITS[m.type].domain as SymDomain, glyphFor(m.type), symSize + 1, false), P.x, P.y);
    ctx.strokeStyle = ok ? '#7dff9a' : '#ff5a4a';
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(P.x, P.y, (symSize + 1) * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    let why: string;
    if (!afford) why = 'NOT ENOUGH FUNDS';
    else if (full) why = 'BUILD QUEUE FULL';
    else if (src < 0) {
      const c = w.map.nav[cellOf(w.map, x, y)];
      if (cat === 'naval') why = c !== 0 ? 'SHIPS: OPEN WATER ONLY' : 'NO NAVAL BASE CAN REACH THIS WATER';
      else if (cat === 'ground') why = c !== 1 ? 'TROOPS: LAND ONLY' : 'NO BARRACKS ON THIS ISLAND';
      else why = 'NO AIRBASE';
    } else {
      const s = w.map.sites[src];
      const isl = w.map.islands[s.island];
      const place = isl.home >= 0 ? (w.players.some((p) => p.slot === isl.home) ? 'HOME' : 'UNCLAIMED') : isl.name.toUpperCase();
      why = `${UNITS[m.type].short} · FROM ${BUILDINGS[s.type].name.toUpperCase()}, ${place}`;
    }
    ctx.fillStyle = ok ? '#7dff9a' : '#ff5a4a';
    ctx.font = `600 9px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(why, P.x + (symSize + 1) * 1.9, P.y + 3);
    ctx.globalAlpha = 1;
  }

  /** Deployment phase: our zone, and a placement ghost (green ring = legal spot, red = not). */
  private drawDeployZone(v: OverlayView) {
    const w = v.world;
    const ctx = this.ctx;
    const z = deployZone(w.map, w.players[w.me].slot);
    if (!z) return;
    const symSize = 12;
    const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
    const col = sideColor('own');
    const pulse = 0.5 + 0.5 * Math.sin(w.clock * 2);
    if (this.circle(v, z.x, z.y, z.r, 0, 128)) {
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.035;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.45 + 0.2 * pulse;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.proj(v, z.x, 0, z.y - z.r)) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = col;
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('DEPLOYMENT ZONE', P.x, P.y - 8);
    }
    ctx.globalAlpha = 1;
    const m = v.mode;
    if (m?.k !== 'deploy' || !v.mouse.valid) return;
    const ok = canDeployAt(w.map, w.players[w.me].slot, m.type, v.mouse.wx, v.mouse.wy);
    const afford = w.cash >= unitCost(m.type, w.myFaction);
    if (!this.proj(v, v.mouse.wx, 0, v.mouse.wy)) return;
    const good = ok && afford;
    ctx.globalAlpha = good ? 0.85 : 0.5;
    this.blit(symbolCanvas('own', UNITS[m.type].domain as SymDomain, glyphFor(m.type), symSize, false), P.x, P.y);
    ctx.strokeStyle = good ? '#7dff9a' : '#ff5a4a';
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(P.x, P.y, symSize * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = good ? '#7dff9a' : '#ff5a4a';
    ctx.font = `600 9px ${FONT}`;
    ctx.textAlign = 'left';
    const why = !afford ? 'NOT ENOUGH FUNDS' : !ok ? (UNITS[m.type].domain === 'land' ? 'TROOPS: HOME ISLAND ONLY' : UNITS[m.type].domain === 'air' ? 'INSIDE THE ZONE ONLY' : 'SHIPS: OPEN WATER IN THE ZONE') : `${UNITS[m.type].short} · ${fmtMoney(unitCost(m.type, w.myFaction))}`;
    ctx.fillText(why, P.x + symSize * 1.9, P.y + 3);
    ctx.globalAlpha = 1;
  }

  private drawUnloadMode(v: OverlayView) {
    const w = v.world;
    const m = v.mode;
    if (m?.k !== 'unload') return;
    const ships = m.ships.map((s) => w.units.get(s.ship)).filter((s): s is UView => !!s);
    if (!ships.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#8dffb4';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -w.clock * 10;
    for (const ship of ships) if (this.circle(v, ship.x, ship.y, UNLOAD_RANGE, 0, 96)) ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    if (v.mouse.valid) {
      const inRange = ships.every((ship) => Math.hypot(v.mouse.wx - ship.x, v.mouse.wy - ship.y) <= UNLOAD_RANGE);
      if (this.proj(v, v.mouse.wx, groundY(w.map, v.mouse.wx, v.mouse.wy), v.mouse.wy)) {
        ctx.strokeStyle = inRange ? '#8dffb4' : '#ffc94a';
        ctx.beginPath();
        ctx.moveTo(P.x - 10, P.y);
        ctx.lineTo(P.x - 3, P.y);
        ctx.moveTo(P.x + 3, P.y);
        ctx.lineTo(P.x + 10, P.y);
        ctx.moveTo(P.x, P.y - 10);
        ctx.lineTo(P.x, P.y - 3);
        ctx.moveTo(P.x, P.y + 3);
        ctx.lineTo(P.x, P.y + 10);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = `600 9px ${FONT}`;
        ctx.textAlign = 'left';
        const n = ships.length > 1 ? `${ships.length} SHIPS · ` : '';
        ctx.fillText(n + (inRange ? 'LAND HERE' : ships.length > 1 ? 'WILL CLOSE IN' : 'SHIP WILL CLOSE IN'), P.x + 13, P.y - 6);
      }
    }
  }

  /** Bombardment: each battleship's gun range, and the beaten zone under the cursor. */
  private drawBombardMode(v: OverlayView) {
    const w = v.world;
    const m = v.mode;
    if (m?.k !== 'bombard') return;
    const ctx = this.ctx;
    const col = '#ff9a50';
    const reach: [UView, number][] = [];
    for (const id of m.ships) {
      const u = w.units.get(id);
      if (!u) continue;
      let r = 0;
      for (const md of weaponModsFor(w, u)) if (md.proj === 'shell') r = Math.max(r, md.range ?? 0);
      reach.push([u, r]);
    }
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = col;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -w.clock * 10;
    for (const [u, r] of reach) if (this.circle(v, u.x, u.y, r, 0, 96)) ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    if (!v.mouse.valid) return;
    const gy = groundY(w.map, v.mouse.wx, v.mouse.wy);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    if (this.circle(v, v.mouse.wx, v.mouse.wy, BOMBARD_ZONE, gy, 40)) ctx.stroke();
    if (this.proj(v, v.mouse.wx, gy, v.mouse.wy)) {
      const ok = reach.every(([u, r]) => Math.hypot(v.mouse.wx - u.x, v.mouse.wy - u.y) <= r);
      ctx.fillStyle = col;
      ctx.font = `600 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(ok ? 'BOMBARD HERE' : 'BOMBARD HERE · SHIPS CLOSE TO GUN RANGE FIRST', P.x + 14, P.y - 6);
    }
  }

  /** Carrier or airbase launch: each base's strike radius (out and back on full fuel) and the chosen point. */
  private drawLaunchMode(v: OverlayView) {
    const w = v.world;
    const m = v.mode;
    if (m?.k !== 'launch') return;
    const ctx = this.ctx;
    const col = '#a6e6ff';
    const reach: [{ x: number; y: number }, number][] = [];
    // The shortest-legged flight on the ground sets the radius.
    const radius = (wing: number[]) => {
      let r = Infinity;
      for (const a of wing) {
        const t = w.units.get(a)?.type;
        if (t && UNITS[t].fuel) r = Math.min(r, (UNITS[t].fuel! * UNITS[t].speed * MOVE_SPEED * AIR_SPEED) / 2);
      }
      return Number.isFinite(r) ? r : 40;
    };
    for (const id of m.ships) {
      const c = w.units.get(id);
      if (c) reach.push([c, radius(w.details.get(id)?.[12] ?? [])]);
    }
    for (const id of m.sites) {
      const st = w.map.sites[id];
      if (st) reach.push([st, radius((w.airbases.get(id) ?? []).filter((a) => (w.units.get(a)?.flags ?? 0) & F_LANDED))]);
    }
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = col;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -w.clock * 10;
    for (const [c, r] of reach) if (this.circle(v, c.x, c.y, r, 0, 128)) ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    if (!v.mouse.valid) return;
    const ok = reach.every(([c, r]) => Math.hypot(v.mouse.wx - c.x, v.mouse.wy - c.y) <= r);
    const tint = ok ? col : '#ffc94a';
    // Flight path from each carrier to the point.
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (const [c] of reach) this.polyline(v, [[c.x, c.y], [v.mouse.wx, v.mouse.wy]], 0.9, 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (this.circle(v, v.mouse.wx, v.mouse.wy, 3, 0.9, 40)) ctx.stroke();
    if (this.proj(v, v.mouse.wx, 0.9, v.mouse.wy)) {
      ctx.fillStyle = tint;
      ctx.font = `600 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(ok ? 'LAUNCH HERE' : 'BEYOND RANGE: FLIGHTS RETURN ON BINGO FUEL', P.x + 13, P.y - 6);
    }
  }
}

export function weaponModsFor(w: World, u: UView) {
  // Own units use our match loadout; others are assumed to carry their faction's defaults.
  const ids = unitLoadout(u.type, u.variant, w.faction(u.owner));
  return ids.map((id) => MODULES[id]).filter((m) => m && m.proj);
}

export function unitLabel(w: World, u: { id: number; type: UnitType; owner: number }): string {
  return unitName(w.faction(u.owner), u.type, u.id);
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Canvas pixels per screen (CSS) pixel. */
  sc: number;
  used: boolean;
}

function newLayer(): Layer {
  const canvas = document.createElement('canvas');
  return { canvas, ctx: canvas.getContext('2d')!, sc: 1, used: false };
}

/**
 * The 2D affine transform [a, b, c, d, e, f] (canvas order) that takes three points (x, y pairs in
 * `src`) to three others (`dst`): u = a x + c y + e, v = b x + d y + f.
 */
function affine(src: number[], dst: number[]): number[] | null {
  const [x1, y1, x2, y2, x3, y3] = src;
  const det = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2);
  if (Math.abs(det) < 1e-6) return null;
  const solve = (u1: number, u2: number, u3: number) => [
    (u1 * (y2 - y3) + u2 * (y3 - y1) + u3 * (y1 - y2)) / det,
    (u1 * (x3 - x2) + u2 * (x1 - x3) + u3 * (x2 - x1)) / det,
    (u1 * (x2 * y3 - x3 * y2) + u2 * (x3 * y1 - x1 * y3) + u3 * (x1 * y2 - x2 * y1)) / det,
  ];
  const [a, c, e] = solve(dst[0], dst[2], dst[4]);
  const [b, d, f] = solve(dst[1], dst[3], dst[5]);
  return [a, b, c, d, e, f];
}
