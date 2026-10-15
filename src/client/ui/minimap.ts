// Radar-scope minimap with a rotating sweep.
import * as THREE from 'three';
import { WEATHER_AXES, WIND_ANGLE } from '../../shared/weather';
import type { World } from '../state';
import { SIDE } from '../theme';
import { UNITS } from '../../shared/defs';
import type { Renderer, CameraRig } from '../render/renderer';

export class Minimap {
  readonly el: HTMLDivElement;
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private land: HTMLCanvasElement;
  private size = 200;
  private sweep = 0;
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

  draw(dt: number, r: Renderer, rig: CameraRig) {
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
    // sites
    for (const s of w.map.sites) {
      const sv = w.sites[s.id];
      const col = sv.owner < 0 ? 'rgba(220,225,230,0.55)' : sv.owner === w.me ? SIDE.own : w.teamOf(sv.owner) === w.myTeam ? SIDE.ally : SIDE.hostile;
      ctx.fillStyle = col;
      const z = s.type === 'resource' ? 2 : 3;
      if (s.type === 'resource') {
        ctx.beginPath();
        ctx.arc(s.x * k, s.y * k, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(s.x * k - z / 2, s.y * k - z / 2, z, z);
    }
    // contacts
    ctx.strokeStyle = SIDE.unknown;
    ctx.globalAlpha = 0.7;
    for (const c of w.contacts.values()) {
      ctx.beginPath();
      ctx.arc(c.x * k, c.y * k, Math.max(1.5, c.r * k), 0, Math.PI * 2);
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
    // sweep
    this.sweep += dt * 1.4;
    const cx = rig.tx * k;
    const cy = rig.ty * k;
    const grad = ctx.createConicGradient ? ctx.createConicGradient(this.sweep - 0.9, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(111,208,255,0)');
      grad.addColorStop(0.14, 'rgba(111,208,255,0.12)');
      grad.addColorStop(0.145, 'rgba(111,208,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, S, S);
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
