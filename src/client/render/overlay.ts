// Crisp 2D tactical overlay drawn over the pixelated world: symbols, contacts, rings, orders.
import { BUILDINGS, MODULES, UNITS, UNIT_TYPES, UNLOAD_RANGE, UnitType, unitCost, moduleFor } from '../../shared/defs';
import { shipDoctrine } from '../../shared/doctrine';
import { canDeployAt, deployZone, rallySite } from '../../shared/game';
import { cellOf } from '../../shared/map';
import { sensorCoverage, unionOutline, COVER_COLORS, Disc } from '../sensors';
import { ORDER_CODES, F_RETREAT, F_LANDED, F_FIRE, F_STOPPED, F_STUN } from '../../shared/protocol';
import type { Renderer, CameraRig } from './renderer';
import type { World, UView } from '../state';
import { DOMAINS } from '../state';
import { Affil, FONT, SITE_GLYPH, SymDomain, glyphFor, sideColor, symbolCanvas } from './symbols';
import { SIDE, unitName } from '../theme';
import { matchLoadoutOf } from '../loadouts';
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
  mode: { k: 'unload'; ships: { ship: number; ids: number[] }[] } | { k: 'deploy'; type: UnitType } | { k: 'build'; type: UnitType } | null;
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
    return P.z < 1 && P.x > -200 && P.y > -200 && P.x < this.w + 200 && P.y < this.h + 200;
  }

  private circle(v: OverlayView, x: number, y: number, rad: number, alt = 0, seg = 56): boolean {
    const ctx = this.ctx;
    ctx.beginPath();
    let any = false;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      v.r.project(x + Math.cos(a) * rad, alt, y + Math.sin(a) * rad, P);
      if (P.z >= 1) continue;
      if (P.x > -50 && P.y > -50 && P.x < this.w + 50 && P.y < this.h + 50) any = true;
      if (i === 0) ctx.moveTo(P.x, P.y);
      else ctx.lineTo(P.x, P.y);
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

    this.drawGrid(v, zoomedOut);
    this.drawWeather(v, zoomedOut);
    this.drawIslandLabels(v, dist);

    if (v.showSensors) this.drawSensors(v);

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
      const hov = v.hover?.kind === 'site' && v.hover.id === s.id;
      const img = symbolCanvas(affil, 'site', SITE_GLYPH[s.type], symSize - 1, hov);
      ctx.globalAlpha = 0.95;
      this.blit(img, sx, sy);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'site', id: s.id, sx, sy, own: sv.owner === w.me, type: null });
      if (sv.cap > 0 && sv.capBy >= 0) {
        const col = sideColor(this.affilOf(w, sv.capBy));
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
        ctx.fillStyle = sideColor(affil);
        ctx.textAlign = 'center';
        ctx.font = `500 9px ${FONT}`;
        ctx.fillText(BUILDINGS[s.type].name.toUpperCase(), sx, sy + symSize + 12);
        ctx.globalAlpha = 1;
      }
      if (hov && (BUILDINGS[s.type].radarAir > 0 || BUILDINGS[s.type].radarSurf > 0)) {
        ctx.strokeStyle = sideColor(affil);
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 5]);
        if (this.circle(v, s.x, s.y, Math.max(BUILDINGS[s.type].radarAir, BUILDINGS[s.type].radarSurf))) ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // ---- ghosts (last known positions) ----
    for (const g of w.ghosts.values()) {
      const age = w.clock - g.t;
      const a = Math.max(0, 1 - age / 30) * 0.5;
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
      ctx.globalAlpha = fadeIn * 0.9;
      this.blit(symbolCanvas(affil, domain, glyphFor(type), symSize - 2, hov), P.x, P.y);
      ctx.globalAlpha = fadeIn * (hov ? 0.9 : 0.6);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.font = `500 8px ${FONT}`;
      ctx.fillText(type ? UNITS[type].short : domain === 'sub' ? 'SONAR' : domain === 'air' ? 'AIR' : domain === 'land' ? 'GROUND' : 'SURFACE', P.x + symSize + 2, P.y + 3);
      if (hov) ctx.fillText(type ? '±' + c.r.toFixed(1) + ' km' : 'UNIDENTIFIED · CANNOT TARGET', P.x + symSize + 2, P.y + 12);
      ctx.globalAlpha = 1;
      this.items.push({ kind: 'contact', id: c.id, sx: P.x, sy: P.y, own: false, type });
    }

    // ---- units ----
    const list = [...w.units.values()].sort((a, b) => (UNITS[a.type].domain === 'air' ? 1 : 0) - (UNITS[b.type].domain === 'air' ? 1 : 0));
    for (const u of list) {
      const def = UNITS[u.type];
      const dom = def.domain;
      const air = dom === 'air';
      const y3 = visAlt(w.map, u.type, u.x, u.y, u.alt);
      if (!this.proj(v, u.x, y3, u.y)) continue;
      let sx = P.x;
      let sy = P.y;
      const affil = this.affilOf(w, u.owner);
      const col = sideColor(affil);
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
      const img = symbolCanvas(affil, dom as SymDomain, glyphFor(u.type), sz, sel || hov);
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
    // Our faction special while it is running.
    const sr = u.owner === w.me ? w.details.get(u.id)?.[14] : undefined;
    const sp = sr ? shipDoctrine(w.myFaction, u.type)?.special : undefined;
    if (sp && sr && (sp.toggle ? sr[2] === 1 : sr[1] > 0)) out.push([sp.tag, '#7dd8ff']);
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
    for (let k = 0; k <= S; k += 10) {
      if (this.proj(v, k, 0, 0)) ctx.moveTo(P.x, P.y);
      if (this.proj(v, k, 0, S)) ctx.lineTo(P.x, P.y);
      if (this.proj(v, 0, 0, k)) ctx.moveTo(P.x, P.y);
      if (this.proj(v, S, 0, k)) ctx.lineTo(P.x, P.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    const corners: [number, number][] = [
      [0, 0],
      [S, 0],
      [S, S],
      [0, S],
      [0, 0],
    ];
    corners.forEach(([x, y], i) => {
      this.proj(v, x, 0, y);
      if (i === 0) ctx.moveTo(P.x, P.y);
      else ctx.lineTo(P.x, P.y);
    });
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
      let any = false;
      for (let k = 0; k <= 64; k++) {
        const [ox, oy] = weatherOutline(kind as 0 | 1, x, y, r * 0.92, (k / 64) * Math.PI * 2);
        v.r.project(ox, 0.2, oy, P);
        if (P.z >= 1) continue;
        if (P.x > -50 && P.y > -50 && P.x < this.w + 50 && P.y < this.h + 50) any = true;
        if (k === 0) ctx.moveTo(P.x, P.y);
        else ctx.lineTo(P.x, P.y);
      }
      if (any) ctx.stroke();
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

  /**
   * Sensor view (V): everything our sensors do not cover is darkened; where only air-search
   * radar reaches (aircraft and missiles only) it is half dark. Coverage edges are drawn as one
   * merged outline per sensor kind.
   */
  private drawSensors(v: OverlayView) {
    const w = v.world;
    const real = this.ctx;
    const cov = sensorCoverage(w);
    const veil = this.layer();
    const mask = this.layer2();
    const disc = (g: CanvasRenderingContext2D, [x, y, r]: Disc) => {
      this.ctx = g;
      this.circle(v, x, y, r, 0, 72);
      this.ctx = real;
    };
    const fillUnion = (discs: Disc[]) => {
      mask.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      mask.ctx.clearRect(0, 0, this.w, this.h);
      mask.ctx.fillStyle = '#000';
      for (const d of discs) {
        disc(mask.ctx, d);
        mask.ctx.fill();
      }
    };
    // 1. The veil: dark everywhere, half cleared under air radar, fully cleared under the surface picture.
    const vg = veil.ctx;
    vg.setTransform(1, 0, 0, 1, 0, 0);
    vg.clearRect(0, 0, veil.canvas.width, veil.canvas.height);
    vg.globalCompositeOperation = 'source-over';
    vg.fillStyle = 'rgba(2, 6, 10, 0.62)';
    vg.fillRect(0, 0, veil.canvas.width, veil.canvas.height);
    vg.globalCompositeOperation = 'destination-out';
    fillUnion(cov.air);
    vg.globalAlpha = 0.5;
    vg.drawImage(mask.canvas, 0, 0);
    fillUnion(cov.surf);
    vg.globalAlpha = 1;
    vg.drawImage(mask.canvas, 0, 0);
    vg.globalCompositeOperation = 'source-over';
    real.setTransform(1, 0, 0, 1, 0, 0);
    real.drawImage(veil.canvas, 0, 0);
    // 2. Merged outlines per sensor kind.
    const kinds: [Disc[], string, number][] = [
      [cov.air, COVER_COLORS.air, 0.45],
      [cov.surf, COVER_COLORS.surf, 0.9],
      [cov.sonar, COVER_COLORS.sonar, 0.9],
    ];
    for (const [discs, col, alpha] of kinds) {
      if (!discs.length) continue;
      mask.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      mask.ctx.clearRect(0, 0, this.w, this.h);
      unionOutline(mask.ctx, discs, col, 1.25, (g, d) => disc(g, d));
      real.globalAlpha = alpha;
      real.drawImage(mask.canvas, 0, 0);
      real.globalAlpha = 1;
    }
    real.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 3. Legend.
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

  private scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  private layer() {
    if (!this.scratch) {
      const canvas = document.createElement('canvas');
      this.scratch = { canvas, ctx: canvas.getContext('2d')! };
    }
    const sc = this.scratch;
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
      let any = false;
      const seg = 72;
      for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        const ex = Math.cos(t) * a;
        const ey = Math.sin(t) * b;
        v.r.project(cx + ex * ca - ey * sa, 0, cy + ex * sa + ey * ca, P);
        if (P.z >= 1) continue;
        if (P.x > -50 && P.y > -50 && P.x < this.w + 50 && P.y < this.h + 50) any = true;
        if (i === 0) ctx.moveTo(P.x, P.y);
        else ctx.lineTo(P.x, P.y);
      }
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
    } else if (code === 'board') {
      const s = w.units.get(d[5]);
      if (!s) return;
      tx = s.x;
      ty = s.y;
      color = 'rgba(140,255,170,0.85)';
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
}

export function weaponModsFor(w: World, u: UView) {
  // Own units use our match loadout; others are assumed to carry the defaults.
  const ids = u.owner === w.me ? matchLoadoutOf(u.type) : UNITS[u.type].defaults;
  const fac = w.faction(u.owner);
  return ids
    .map((id) => MODULES[id])
    .filter((m) => m && m.proj)
    .map((m) => moduleFor(fac, u.type, m));
}

export function unitLabel(w: World, u: { id: number; type: UnitType; owner: number }): string {
  return unitName(w.faction(u.owner), u.type, u.id);
}
