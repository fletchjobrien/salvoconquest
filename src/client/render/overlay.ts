// Crisp 2D tactical overlay drawn over the pixelated world: symbols, contacts, rings, orders.
import { BUILDINGS, MODULES, UNITS, UNIT_TYPES, UNLOAD_RANGE, UnitType, deriveStats } from '../../shared/defs';
import { ORDER_CODES, F_RETREAT, F_LANDED } from '../../shared/protocol';
import type { Renderer, CameraRig } from './renderer';
import type { World, UView } from '../state';
import { DOMAINS } from '../state';
import { Affil, FONT, SITE_GLYPH, SymDomain, glyphFor, sideColor, symbolCanvas } from './symbols';
import { SIDE, unitName } from '../theme';
import { matchLoadoutOf } from '../loadouts';
import { groundY, visAlt, AIR_VIS } from './coords';

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
  mode: { k: 'unload'; ship: number; ids: number[] } | null;
  mouse: { x: number; y: number; wx: number; wy: number; valid: boolean };
  showRanges: boolean;
  showSensors: boolean;
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

  shock(x: number, y: number, alt: number, r: number, color: string, dur = 0.9) {
    this.shocks.push({ x, y, alt, t: 0, r, color, dur });
  }

  floater(x: number, y: number, alt: number, text: string, color: string) {
    this.floaters.push({ x, y, alt, text, color, t: 0 });
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
    for (const id of v.selected) {
      const u = w.units.get(id);
      if (!u) continue;
      this.drawOrder(v, u);
      if (v.showRanges || v.selected.size <= 3) this.drawRanges(v, u, v.selected.size > 3 ? 0.4 : 1);
    }
    if (v.mode?.k === 'unload') this.drawUnloadMode(v);

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

    // ---- radar contacts ----
    for (const c of w.contacts.values()) {
      const type = c.kind >= 10 ? (UNIT_TYPES[c.kind - 10] as UnitType) : null;
      const domain = (type ? UNITS[type].domain : DOMAINS[c.kind]) as SymDomain;
      const affil: Affil = type ? 'hostile' : 'unknown';
      const col = sideColor(affil);
      const age = w.clock - c.born;
      const fadeIn = Math.min(1, age / 0.5);
      if (c.old && w.clock - c.old.t < 0.6) {
        const k = 1 - (w.clock - c.old.t) / 0.6;
        if (this.proj(v, c.old.x, 0, c.old.y)) {
          ctx.globalAlpha = k * 0.6;
          this.blit(symbolCanvas(affil, domain, glyphFor(type), symSize - 1), P.x, P.y);
          ctx.globalAlpha = 1;
        }
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      if (c.r > 0.05) {
        ctx.globalAlpha = 0.3 * fadeIn;
        ctx.setLineDash([3, 6]);
        if (this.circle(v, c.x, c.y, c.r, 0, 48)) ctx.stroke();
        ctx.setLineDash([]);
        if (age < 0.7) {
          const k = age / 0.7;
          ctx.globalAlpha = (1 - k) * 0.7;
          if (this.circle(v, c.x, c.y, c.r * (1.6 - 0.6 * k), 0, 48)) ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (!this.proj(v, c.x, 0, c.y)) continue;
      const hov = v.hover?.kind === 'contact' && v.hover.id === c.id;
      ctx.globalAlpha = fadeIn;
      this.blit(symbolCanvas(affil, domain, glyphFor(type), symSize - 1, hov), P.x, P.y);
      ctx.globalAlpha = fadeIn * 0.85;
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.font = `500 8px ${FONT}`;
      ctx.fillText(type ? UNITS[type].short + '?' : domain === 'sub' ? 'SONAR' : domain === 'air' ? 'AIR' : 'SFC', P.x + symSize + 3, P.y - 2);
      ctx.fillText('±' + c.r.toFixed(1) + 'km', P.x + symSize + 3, P.y + 7);
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
      const a3 = p.kind === 'torpedo' ? 0 : p.ralt * (p.kind === 'shell' || p.kind === 'bomb' ? 1 : AIR_VIS);
      if (!this.proj(v, p.rx, a3, p.ry)) continue;
      const sx = P.x;
      const sy = P.y;
      const col = p.mine ? '#e8f8ff' : '#ff7a4a';
      ctx.fillStyle = col;
      if (p.kind === 'missile' || p.kind === 'sam') {
        // Short fixed-length streak opposite the direction of travel.
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const dl = Math.hypot(dx, dy);
        if (dl > 1e-4 && this.proj(v, p.rx - (dx / dl) * 0.2, a3, p.ry - (dy / dl) * 0.2)) {
          const ex = P.x - sx;
          const ey = P.y - sy;
          const el = Math.hypot(ex, ey) || 1;
          const L = p.kind === 'missile' ? 14 : 9;
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + (ex / el) * L, sy + (ey / el) * L);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const s = p.kind === 'missile' ? 3 : 2;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
        if (!p.mine && p.kind === 'missile') {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.5 + 0.5 * Math.sin(w.clock * 12);
          ctx.beginPath();
          ctx.arc(sx, sy, 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      } else if (p.kind === 'torpedo') {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(w.clock * 8);
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        ctx.globalAlpha = 1;
      } else {
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
      ctx.fillText(f.text, P.x, P.y - 18 - k * 26);
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
      if (this.circle(v, x, y, r * 0.85, 0.2)) ctx.stroke();
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

  /** Own radar (cyan) and sonar (violet) coverage as soft filled discs, DEFCON style. */
  private drawSensors(v: OverlayView) {
    const w = v.world;
    const ctx = this.ctx;
    const fac = w.myFaction;
    const discs: { x: number; y: number; r: number; sonar: boolean }[] = [];
    for (const u of w.units.values()) {
      if (u.owner !== w.me || u.flags & F_LANDED) continue;
      const st = deriveStats(u.type, fac, matchLoadoutOf(u.type));
      const radar = Math.max(st.radarAir, st.radarSurf);
      if (radar > 0) discs.push({ x: u.x, y: u.y, r: radar, sonar: false });
      if (st.sonar > 0) discs.push({ x: u.x, y: u.y, r: st.sonar, sonar: true });
    }
    for (const s of w.map.sites) {
      if (w.sites[s.id].owner !== w.me) continue;
      const b = BUILDINGS[s.type];
      const r = Math.max(b.radarAir, b.radarSurf);
      if (r > 0) discs.push({ x: s.x, y: s.y, r, sonar: false });
    }
    // Union of discs: paint opaque into a scratch layer, then composite once at low alpha.
    const layer = this.layer();
    const real = this.ctx;
    for (const sonar of [false, true]) {
      layer.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      layer.ctx.clearRect(0, 0, this.w, this.h);
      this.ctx = layer.ctx;
      layer.ctx.fillStyle = sonar ? '#a08cff' : '#6fd0ff';
      for (const d of discs) if (d.sonar === sonar && this.circle(v, d.x, d.y, d.r, 0, 64)) layer.ctx.fill();
      this.ctx = real;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = sonar ? 0.12 : 0.07;
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    ctx.lineWidth = 1;
    for (const d of discs) {
      ctx.strokeStyle = d.sonar ? 'rgba(160,140,255,0.3)' : 'rgba(111,208,255,0.16)';
      if (this.circle(v, d.x, d.y, d.r, 0, 64)) ctx.stroke();
    }
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

  private drawRanges(v: OverlayView, u: UView, alpha: number) {
    const w = v.world;
    const det = w.details.get(u.id);
    if (!det) return;
    const ctx = this.ctx;
    const ranges = new Map<number, string>();
    const mods = weaponModsFor(w, u);
    mods.forEach((m) => {
      const r = m.range ?? 0;
      if (r < 1.5) return;
      const cls = m.dmg?.air && !m.dmg.sea && !m.dmg.land ? 'air' : m.dmg?.sub && !m.dmg.sea ? 'sub' : 'surf';
      const color = cls === 'air' ? '#7fd8ff' : cls === 'sub' ? '#9a8cff' : '#ffb36b';
      if (!ranges.has(r)) ranges.set(r, color);
    });
    const y3 = UNITS[u.type].domain === 'land' ? groundY(w.map, u.x, u.y) : 0;
    for (const [r, color] of ranges) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.28 * alpha;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      if (this.circle(v, u.x, u.y, r, y3 * 0.2, 72)) ctx.stroke();
      ctx.setLineDash([]);
      // Range label at the ring's "south" point.
      if (alpha >= 1 && this.proj(v, u.x, 0, u.y + r)) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.font = `500 8px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${r}km`, P.x, P.y + 10);
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

  private drawUnloadMode(v: OverlayView) {
    const w = v.world;
    const m = v.mode!;
    const ship = w.units.get(m.ship);
    if (!ship) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#8dffb4';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -w.clock * 10;
    if (this.circle(v, ship.x, ship.y, UNLOAD_RANGE, 0, 96)) ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    if (v.mouse.valid) {
      const inRange = Math.hypot(v.mouse.wx - ship.x, v.mouse.wy - ship.y) <= UNLOAD_RANGE;
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
        ctx.fillText(inRange ? 'LAND HERE' : 'SHIP WILL CLOSE IN', P.x + 13, P.y - 6);
      }
    }
  }
}

export function weaponModsFor(w: World, u: UView) {
  // Own units use our match loadout; others are assumed to carry the defaults.
  const ids = u.owner === w.me ? matchLoadoutOf(u.type) : UNITS[u.type].defaults;
  return ids.map((id) => MODULES[id]).filter((m) => m && m.proj);
}

export function unitLabel(w: World, u: { id: number; type: UnitType; owner: number }): string {
  return unitName(w.faction(u.owner), u.type, u.id);
}
