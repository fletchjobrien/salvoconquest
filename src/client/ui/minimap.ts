// Minimap with fog of war: what your side's sensors cover is clear, the rest is dark.
import * as THREE from 'three';
import { WEATHER_AXES, WIND_ANGLE } from '../../shared/weather';
import type { World } from '../state';
import { SIDE } from '../theme';
import { BUILDINGS, UNITS, deriveStats } from '../../shared/defs';
import { deployZone } from '../../shared/game';
import { F_LANDED } from '../../shared/protocol';
import { matchLoadoutOf } from '../loadouts';

/** Fog layer resolution (pixels across the whole map). */
const FOG_RES = 160;
import type { Renderer, CameraRig } from '../render/renderer';

export class Minimap {
  readonly el: HTMLDivElement;
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private land: HTMLCanvasElement;
  private size = 200;
  private fog: HTMLCanvasElement;
  private surfMask: HTMLCanvasElement;
  private airMask: HTMLCanvasElement;
  private fogAt = -1;
  onJump: (x: number, y: number) => void = () => {};
  onCommand: (x: number, y: number) => void = () => {};

  constructor(private world: World) {
    this.el = document.createElement('div');
    this.el.id = 'minimap';
    this.el.className = 'panel hp';
    this.c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = this.size * dpr;
    this.c.height = this.size * dpr;
    this.ctx = this.c.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.el.appendChild(this.c);
    this.land = this.renderLand();
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = FOG_RES;
      return c;
    };
    this.fog = mk();
    this.surfMask = mk();
    this.airMask = mk();
    let dragging = false;
    const at = (e: MouseEvent) => {
      const r = this.c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * world.map.size, ((e.clientY - r.top) / r.height) * world.map.size] as const;
    };
    this.el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) {
        dragging = true;
        const [x, y] = at(e);
        this.onJump(x, y);
      } else if (e.button === 2) {
        const [x, y] = at(e);
        this.onCommand(x, y);
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const [x, y] = at(e);
      this.onJump(x, y);
    });
    window.addEventListener('mouseup', () => (dragging = false));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private renderLand(): HTMLCanvasElement {
    const map = this.world.map;
    const c = document.createElement('canvas');
    const n = map.nn;
    c.width = n;
    c.height = n;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const v = map.nav[k];
        const o = k * 4;
        if (v === 1) {
          img.data[o] = 70;
          img.data[o + 1] = 92;
          img.data[o + 2] = 96;
          img.data[o + 3] = 255;
        } else if (v === 2) {
          img.data[o] = 30;
          img.data[o + 1] = 52;
          img.data[o + 2] = 60;
          img.data[o + 3] = 255;
        } else {
          img.data[o] = 10;
          img.data[o + 1] = 20;
          img.data[o + 2] = 27;
          img.data[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Fog of war from our side's sensors (own and allied units and sites): fully clear where
   * surface radar or eyes reach, half clear where only air-search radar reaches, dark beyond.
   * Each layer is a union of soft-edged discs, so overlaps never stack up.
   */
  private updateFog() {
    const w = this.world;
    const k = FOG_RES / w.map.size;
    const surf: [number, number, number][] = [];
    const air: [number, number, number][] = [];
    for (const u of w.units.values()) {
      if (w.teamOf(u.owner) !== w.myTeam || u.flags & F_LANDED) continue;
      const lo = u.owner === w.me ? matchLoadoutOf(u.type) : UNITS[u.type].defaults;
      const st = deriveStats(u.type, w.players[u.owner]?.faction ?? w.myFaction, lo);
      const near = Math.max(st.radarSurf, UNITS[u.type].visual, st.sonar);
      if (near > 0) surf.push([u.x, u.y, near]);
      if (st.radarAir > near) air.push([u.x, u.y, st.radarAir]);
    }
    for (const s of w.map.sites) {
      const o = w.sites[s.id].owner;
      if (o < 0 || w.teamOf(o) !== w.myTeam) continue;
      const b = BUILDINGS[s.type];
      const near = Math.max(b.radarSurf, b.visual);
      surf.push([s.x, s.y, near]);
      if (b.radarAir > near) air.push([s.x, s.y, b.radarAir]);
    }
    const paint = (c: HTMLCanvasElement, discs: [number, number, number][]) => {
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, FOG_RES, FOG_RES);
      for (const [x, y, rad] of discs) {
        const R = rad * k;
        const grd = g.createRadialGradient(x * k, y * k, R * 0.8, x * k, y * k, R);
        grd.addColorStop(0, 'rgba(0,0,0,1)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x * k, y * k, R, 0, Math.PI * 2);
        g.fill();
      }
    };
    paint(this.surfMask, surf);
    paint(this.airMask, air);
    const f = this.fog.getContext('2d')!;
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, FOG_RES, FOG_RES);
    f.fillStyle = 'rgba(2,6,10,0.8)';
    f.fillRect(0, 0, FOG_RES, FOG_RES);
    f.globalCompositeOperation = 'destination-out';
    f.globalAlpha = 0.45;
    f.drawImage(this.airMask, 0, 0);
    f.globalAlpha = 1;
    f.drawImage(this.surfMask, 0, 0);
    f.globalCompositeOperation = 'source-over';
  }

  draw(_dt: number, r: Renderer, _rig: CameraRig) {
    const w = this.world;
    const ctx = this.ctx;
    const S = this.size;
    const k = S / w.map.size;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.land, 0, 0, S, S);
    // grid
    ctx.strokeStyle = 'rgba(170,215,240,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 10; g < w.map.size; g += 10) {
      ctx.moveTo(g * k + 0.5, 0);
      ctx.lineTo(g * k + 0.5, S);
      ctx.moveTo(0, g * k + 0.5);
      ctx.lineTo(S, g * k + 0.5);
    }
    ctx.stroke();
    // weather
    for (const [kind, x, y, rad, i] of w.weather) {
      ctx.fillStyle = kind === 0 ? `rgba(120,130,150,${(i / 100) * 0.35})` : `rgba(220,225,230,${(i / 100) * 0.2})`;
      const [a, b] = WEATHER_AXES[kind as 0 | 1];
      ctx.beginPath();
      ctx.ellipse(x * k, y * k, rad * a * k, rad * b * k, WIND_ANGLE, 0, Math.PI * 2);
      ctx.fill();
    }
    // fog of war (refreshed a few times a second)
    if (w.clock - this.fogAt > 0.3 || w.clock < this.fogAt) {
      this.fogAt = w.clock;
      this.updateFog();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fog, 0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    // deployment zone (setup phase only)
    if (w.setup) {
      const z = deployZone(w.map, w.players[w.me].slot);
      if (z) {
        ctx.strokeStyle = SIDE.own;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(z.x * k, z.y * k, z.r * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    // sites
    for (const s of w.map.sites) {
      const sv = w.sites[s.id];
      const col = sv.owner === -2 ? 'rgba(232,210,122,0.5)' : sv.owner < 0 ? 'rgba(220,225,230,0.55)' : sv.owner === w.me ? SIDE.own : w.teamOf(sv.owner) === w.myTeam ? SIDE.ally : SIDE.hostile;
      ctx.fillStyle = col;
      const z = s.type === 'resource' ? 2 : 3;
      if (s.type === 'resource') {
        ctx.beginPath();
        ctx.arc(s.x * k, s.y * k, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(s.x * k - z / 2, s.y * k - z / 2, z, z);
    }
    // contacts: a small hollow diamond (hostile if classified, else unknown)
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    for (const c of w.contacts.values()) {
      ctx.strokeStyle = c.kind >= 10 ? SIDE.hostile : SIDE.unknown;
      const x = c.x * k;
      const y = c.y * k;
      ctx.beginPath();
      ctx.moveTo(x, y - 2.2);
      ctx.lineTo(x + 2.2, y);
      ctx.lineTo(x, y + 2.2);
      ctx.lineTo(x - 2.2, y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // units
    for (const u of w.units.values()) {
      const col = u.owner === w.me ? SIDE.own : w.teamOf(u.owner) === w.myTeam ? SIDE.ally : SIDE.hostile;
      ctx.fillStyle = col;
      const air = UNITS[u.type].domain === 'air';
      const z = u.type === 'merchant' || u.type === 'lander' ? 1.5 : air ? 2 : 2.5;
      if (air) {
        ctx.beginPath();
        ctx.moveTo(u.x * k, u.y * k - z);
        ctx.lineTo(u.x * k + z, u.y * k + z);
        ctx.lineTo(u.x * k - z, u.y * k + z);
        ctx.fill();
      } else ctx.fillRect(u.x * k - z / 2, u.y * k - z / 2, z, z);
    }
    // camera footprint
    const corners: [number, number][] = [
      [0, 0],
      [r.width, 0],
      [r.width, r.height],
      [0, r.height],
    ];
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    let ok = 0;
    corners.forEach(([sx, sy], i) => {
      const p = screenToGround(r, sx, sy);
      if (!p) return;
      ok++;
      const px = Math.max(-5, Math.min(S + 5, p[0] * k));
      const py = Math.max(-5, Math.min(S + 5, p[1] * k));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (ok === 4) {
      ctx.closePath();
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(170,215,240,0.25)';
    ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
  }
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
export function screenToGround(r: Renderer, sx: number, sy: number, y0 = 0): [number, number] | null {
  ndc.set((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1);
  ray.setFromCamera(ndc, r.camera);
  plane.constant = -y0;
  if (!ray.ray.intersectPlane(plane, hit)) return null;
  return [hit.x, hit.z];
}
