// Owns all 3D objects for a match: terrain, units, sites, wrecks, lights, weather visuals, effects.
import * as THREE from 'three';
import { UNITS, UNIT_TYPES, UnitType, MODULES } from '../../shared/defs';
import { heightAt } from '../../shared/map';
import type { GameEvent } from '../../shared/protocol';
import { F_LANDED } from '../../shared/protocol';
import type { World } from '../state';
import { PALETTES, Palette } from '../theme';
import { Renderer, CameraRig } from './renderer';
import { TerrainView } from './terrain';
import { Fx } from './fx';
import { UnitModel, makeSiteModel, makeUnitModel, SiteModel, VIS_LEN } from './models';
import { groundY, visAlt, setAirZoom, airY } from './coords';
import type { Overlay } from './overlay';
import { Wakes } from './wakes';
import { setWeatherCells } from './weatherfx';
import { WeatherView } from './weatherView';
import { weatherStrength } from '../../shared/weather';

interface UnitObj {
  m: UnitModel;
  type: UnitType;
  lastX: number;
  lastY: number;
  lastH: number;
  speed: number;
  roll: number;
  emit: number;
  phase: number;
}

interface Wreck {
  obj: THREE.Object3D;
  type: UnitType;
  t: number;
  x: number;
  y: number;
  alt: number;
  h: number;
  vx: number;
  vy: number;
  dom: string;
  emit: number;
}

const WRECK_MAT = new THREE.MeshLambertMaterial({ color: 0x1e1c1a, flatShading: true });

export class GameScene {
  readonly pal: Palette;
  readonly terrain: TerrainView;
  readonly fx = new Fx();
  readonly wakes: Wakes;
  readonly weatherView: WeatherView;
  private units = new Map<number, UnitObj>();
  private sites: SiteModel[] = [];
  private wrecks: Wreck[] = [];
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private bg: THREE.Color;
  private flashLight: THREE.PointLight;
  private time = 0;
  private weatherEmit = 0;
  overlay: Overlay | null = null;
  onSound: (name: string, x: number, y: number, vol?: number) => void = () => {};

  constructor(
    readonly r: Renderer,
    readonly world: World,
  ) {
    this.pal = PALETTES[world.map.theme];
    const pal = this.pal;
    const scene = r.scene;
    scene.clear();
    this.bg = new THREE.Color(pal.sky);
    scene.background = this.bg;
    this.fog = new THREE.Fog(pal.fog, 60, 220);
    scene.fog = this.fog;
    this.hemi = new THREE.HemisphereLight(pal.amb, pal.ground, 1.25);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(pal.sun, pal.sunI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.sun, this.sun.target);
    this.flashLight = new THREE.PointLight(0xdde6ff, 0, 22, 1.5);
    scene.add(this.flashLight);
    this.terrain = new TerrainView(world.map, pal);
    scene.add(this.terrain.group);
    scene.add(this.fx.group);
    this.wakes = new Wakes(pal.foam);
    scene.add(this.wakes.mesh);
    this.weatherView = new WeatherView(pal.sunDir);
    scene.add(this.weatherView.group);
    for (const s of world.map.sites) {
      const ang = s.dock ? Math.atan2(s.dock.y - s.y, s.dock.x - s.x) : Math.atan2(world.map.size / 2 - s.y, world.map.size / 2 - s.x);
      const m = makeSiteModel(s.type, pal, ang);
      m.root.position.set(s.x, groundY(world.map, s.x, s.y), s.y);
      scene.add(m.root);
      this.sites.push(m);
    }
  }

  private flagColor(owner: number): number {
    const w = this.world;
    if (owner === -2) return 0xe8d27a;
    if (owner < 0) return 0xd9dde0;
    if (owner === w.me) return 0x4fb8ff;
    return w.teamOf(owner) === w.myTeam ? 0x5fe08a : 0xff4a3d;
  }

  update(dt: number, rig: CameraRig) {
    this.time += dt;
    const w = this.world;
    const map = w.map;
    const scene = this.r.scene;
    setAirZoom(rig.dist);

    // ---- units ----
    const seen = new Set<number>();
    for (const u of w.units.values()) {
      seen.add(u.id);
      let o = this.units.get(u.id);
      if (!o) {
        const m = makeUnitModel(u.type, w.faction(u.owner), this.pal);
        scene.add(m.root);
        o = { m, type: u.type, lastX: u.x, lastY: u.y, lastH: u.h, speed: 0, roll: 0, emit: Math.random(), phase: Math.random() * 10 };
        this.units.set(u.id, o);
      }
      const dom = UNITS[u.type].domain;
      const y3 = visAlt(map, u.type, u.x, u.y, u.alt);
      const root = o.m.root;
      const sp = dt > 0 ? Math.hypot(u.x - o.lastX, u.y - o.lastY) / dt : 0;
      o.speed += (sp - o.speed) * Math.min(1, dt * 4);
      const turn = dt > 0 ? (u.h - o.lastH) / dt : 0;
      o.lastX = u.x;
      o.lastY = u.y;
      o.lastH = u.h;
      root.position.set(u.x, y3, u.y);
      root.rotation.set(0, -u.h, 0, 'YXZ');
      if (dom === 'sea') {
        // Ships pitch and roll harder in heavy weather.
        const t = this.time + o.phase;
        const heave = 1 + this.weatherAt(u.x, u.y).storm * 4;
        root.rotation.z = Math.sin(t * 0.9) * 0.025 * heave;
        root.rotation.x = Math.sin(t * 0.7) * 0.03 * heave;
        root.position.y = Math.sin(t * 1.1) * 0.004 * heave;
      } else if (dom === 'sub') {
        root.position.y = -0.012;
      } else if (dom === 'air') {
        o.roll += (Math.max(-0.9, Math.min(0.9, -turn * 0.8)) - o.roll) * Math.min(1, dt * 3);
        root.rotation.x = o.roll;
        if (u.flags & F_LANDED) root.rotation.x = 0;
      }
      if (o.m.radar) o.m.radar.rotation.y += dt * 2.2;
      root.visible = true;

      // Wake ribbon.
      if ((dom === 'sea' || dom === 'sub') && o.speed > 0.02) {
        const len = VIS_LEN[u.type];
        const k = dom === 'sub' ? 0.35 : 1;
        this.wakes.sample(u.id, u.x - Math.cos(u.h) * len * 0.42, u.y - Math.sin(u.h) * len * 0.42, u.h, this.time, len * 0.09, Math.min(1, o.speed / 0.25) * k);
      }
      // Effects.
      o.emit -= dt;
      if (o.emit <= 0) {
        o.emit = 0.09;
        const len = VIS_LEN[u.type];
        if (dom === 'sea' && o.speed > 0.15) {
          this.fx.bowSpray(u.x, u.y, u.h, len);
        } else if (dom === 'sub' && o.speed > 0.05) {
          this.fx.subWake(u.x - Math.cos(u.h) * len * 0.2, u.y - Math.sin(u.h) * len * 0.2);
        } else if (dom === 'land' && o.speed > 0.02 && w.map.theme !== 'jungle') {
          this.fx.dust(u.x, y3, u.y);
        } else if (dom === 'air' && !(u.flags & F_LANDED) && y3 > 0.3) {
          // Faint contrails from each jet in the flight.
          const c = Math.cos(u.h);
          const s = Math.sin(u.h);
          const len = VIS_LEN[u.type];
          if (u.type === 'recon') this.fx.contrail(u.x - c * len * 0.5, y3, u.y - s * len * 0.5);
          else {
            // Lead jet at +0.2 len, wingman at (-0.45 len, +0.75 len) in model space.
            this.fx.contrail(u.x - c * len * 0.3, y3, u.y - s * len * 0.3);
            this.fx.contrail(u.x - c * len * 0.95 - s * len * 0.75, y3, u.y - s * len * 0.95 + c * len * 0.75);
          }
        }
        if (u.hp < 50) {
          const s = dom === 'air' ? 0.5 : dom === 'land' ? 0.7 : 1.2;
          if (Math.random() < (1 - u.hp / 50) * 0.9 + 0.1) this.fx.fire(u.x, y3 + (dom === 'sea' ? 0.04 : 0), u.y, s);
        }
      }
    }
    for (const [id, o] of this.units) {
      if (seen.has(id)) continue;
      this.units.delete(id);
      if (this.pendingKills.has(id)) {
        this.startWreck(o, this.pendingKills.get(id)!);
        this.pendingKills.delete(id);
      } else {
        this.r.scene.remove(o.m.root);
      }
    }
    this.pendingKills.clear();

    // ---- wrecks ----
    for (const wr of this.wrecks) {
      wr.t += dt;
      wr.emit -= dt;
      const o = wr.obj;
      if (wr.dom === 'sea' || wr.dom === 'sub') {
        const k = Math.min(1, wr.t / 14);
        o.position.y = -k * k * 0.5;
        o.rotation.z = Math.min(0.5, wr.t * 0.05) * (wr.h > 0 ? 1 : -1);
        o.rotation.x = Math.min(0.35, wr.t * 0.03);
        if (wr.emit <= 0 && k < 0.85) {
          wr.emit = 0.12;
          this.fx.fire(wr.x, Math.max(0, o.position.y + 0.04), wr.y, 1.4 * (1 - k));
        }
      } else if (wr.dom === 'air') {
        wr.vy -= dt * 0.8;
        wr.x += Math.cos(wr.h) * wr.vx * dt;
        wr.y += Math.sin(wr.h) * wr.vx * dt;
        wr.alt += wr.vy * dt;
        o.position.set(wr.x, wr.alt, wr.y);
        o.rotation.x += dt * 4;
        if (wr.emit <= 0) {
          wr.emit = 0.04;
          this.fx.fire(o.position.x, o.position.y, o.position.z, 0.5);
        }
        const g = groundY(map, o.position.x, o.position.z);
        if (wr.alt <= g) {
          const water = heightAt(map, o.position.x, o.position.z) < 0;
          this.fx.explosion(o.position.x, g, o.position.z, 0.6, water);
          this.onSound('boom_s', o.position.x, o.position.z);
          wr.t = 999;
        }
      } else {
        if (wr.emit <= 0 && wr.t < 25) {
          wr.emit = 0.25;
          this.fx.fire(wr.x, wr.alt, wr.y, 0.6 * (1 - wr.t / 25));
        }
      }
    }
    this.wrecks = this.wrecks.filter((wr) => {
      const done = wr.t > (wr.dom === 'land' ? 40 : 16);
      if (done) scene.remove(wr.obj);
      return !done;
    });

    // ---- projectiles ----
    for (const p of w.projs.values()) {
      const ma = p.kind === 'missile' || p.kind === 'sam' ? airY(map, p.rx, p.ry, p.ralt) : 0;
      if (p.kind === 'missile') this.fx.missileTrail(p.rx, ma, p.ry, !p.mine);
      else if (p.kind === 'sam') this.fx.samTrail(p.rx, ma, p.ry);
      else if (p.kind === 'torpedo') {
        if (Math.random() < 0.5) this.fx.torpedoTrail(p.rx, p.ry);
      } else if (p.kind === 'shell' || p.kind === 'bomb') this.fx.shellDot(p.rx, p.ralt, p.ry);
    }

    // ---- sites ----
    for (let i = 0; i < this.sites.length; i++) {
      const m = this.sites[i];
      const sv = w.sites[i];
      (m.flag.material as THREE.MeshBasicMaterial).color.setHex(this.flagColor(sv.owner));
      m.flag.rotation.y = Math.sin(this.time * 2 + i) * 0.35;
      if (m.spinner) m.spinner.rotation.y += dt * 1.4;
    }

    // ---- lighting & shadows follow the camera ----
    const sd = new THREE.Vector3(...this.pal.sunDir).normalize();
    const span = Math.max(4, Math.min(60, rig.dist * 0.75));
    this.sun.position.set(rig.tx + sd.x * 80, sd.y * 80, rig.ty + sd.z * 80);
    this.sun.target.position.set(rig.tx, 0, rig.ty);
    const sc = this.sun.shadow.camera;
    sc.left = -span;
    sc.right = span;
    sc.top = span;
    sc.bottom = -span;
    sc.near = 1;
    sc.far = 200;
    sc.updateProjectionMatrix();

    // ---- weather visuals ----
    const wa = this.weatherAt(rig.tx, rig.ty);
    const baseNear = rig.dist * 1.6 + 10;
    const baseFar = rig.dist * 5 + 90;
    const fogK = Math.max(wa.fog * 0.9, wa.storm * 0.6);
    this.fog.near = baseNear * (1 - fogK * 0.85);
    this.fog.far = Math.max(this.fog.near + 4, baseFar * (1 - fogK * 0.75));
    const fogCol = new THREE.Color(this.pal.fog).lerp(new THREE.Color(0x4a525a), wa.storm * 0.6);
    this.fog.color.copy(fogCol);
    this.bg.copy(fogCol);
    setWeatherCells(w.weather, new THREE.Color(this.pal.fog).lerp(new THREE.Color(0xe6ebee), 0.5), this.time);
    this.weatherView.update(dt, w.weather, this.r.camera);
    this.terrain.update(this.time, this.fog.near, this.fog.far, fogCol);
    this.wakes.update(this.time);
    this.sun.intensity = this.pal.sunI * (1 - wa.storm * 0.6);
    this.hemi.intensity = 1.25 * (1 - wa.storm * 0.35);
    // Fog layers now carry the fog look; keep only a faint veil when the camera is inside a bank.
    this.r.setVeil(Math.min(0.12, wa.fog * 0.12 * Math.max(0, 1 - rig.dist / 30)), new THREE.Color(0.85, 0.87, 0.89));
    this.weatherEmit -= dt;
    if (this.weatherEmit <= 0) {
      this.weatherEmit = 0.05;
      if (wa.storm > 0.15 && rig.dist < 40) {
        const n = Math.round(wa.storm * 30);
        const R = Math.min(15, rig.dist * 0.7);
        for (let k = 0; k < n; k++) this.fx.rainDrop(rig.tx + (Math.random() - 0.5) * R * 2, rig.ty + (Math.random() - 0.5) * R * 2, 3 + Math.random() * 2);
      }
    }
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 220);
    this.r.flash = Math.max(0, this.r.flash - dt * 1.5);

    this.fx.setScale(this.r.height / this.r.pixelSize, this.r.camera.fov);
    this.fx.update(dt);
  }

  private weatherAt(x: number, y: number) {
    let storm = 0;
    let fog = 0;
    for (const [kind, cx, cy, r, i] of this.world.weather) {
      const f = weatherStrength(kind as 0 | 1, x - cx, y - cy, r, i / 100);
      if (f <= 0) continue;
      if (kind === 0) storm = Math.max(storm, f);
      else fog = Math.max(fog, f);
    }
    return { storm, fog };
  }

  private pendingKills = new Map<number, GameEvent & { k: 'kill' }>();

  private startWreck(o: UnitObj, e: GameEvent & { k: 'kill' }) {
    const dom = UNITS[o.type].domain;
    const root = o.m.root;
    o.m.body.material = WRECK_MAT;
    if (o.m.radar) o.m.radar.visible = false;
    this.wrecks.push({
      obj: root,
      type: o.type,
      t: 0,
      x: root.position.x,
      y: root.position.z,
      alt: root.position.y,
      h: e.h,
      vx: Math.max(0.2, o.speed),
      vy: 0,
      dom,
      emit: 0,
    });
  }

  onEvent(e: GameEvent) {
    const w = this.world;
    const map = w.map;
    switch (e.k) {
      case 'fire': {
        const m = MODULES[e.m];
        if (!m) break;
        const alt = e.a && e.a > 0.3 ? airY(map, e.x, e.y, e.a) : (e.a ?? 0) + groundY(map, e.x, e.y);
        if (m.proj === 'missile') {
          this.fx.launch(e.x, alt, e.y);
          this.onSound('launch', e.x, e.y);
        } else if (m.proj === 'sam') {
          this.fx.launch(e.x, alt, e.y);
          this.onSound('sam', e.x, e.y);
        } else if (m.proj === 'shell') {
          const big = m.id === 'gun406' ? 2.2 : m.id === 'railgun' ? 1.6 : m.id === 'mortar' ? 0.6 : 1;
          this.fx.muzzle(e.x, alt, e.y, big);
          this.onSound(big > 1.5 ? 'bigGun' : 'gun', e.x, e.y);
        } else if (m.proj === 'bullet') {
          const ta = airY(map, e.tx, e.ty, e.a ?? 0);
          this.fx.tracer(e.x, alt + 0.05, e.y, e.tx, ta, e.ty);
          this.onSound('ciws', e.x, e.y, 0.5);
        } else if (m.proj === 'torpedo') {
          this.onSound('torpedo', e.x, e.y);
          this.fx.splash(e.x, e.y, 0.3);
        } else if (m.proj === 'bomb') {
          this.onSound('bombDrop', e.x, e.y, 0.5);
        }
        break;
      }
      case 'boom': {
        const water = heightAt(map, e.x, e.y) < 0;
        const alt = e.a && e.a > 0.1 ? airY(map, e.x, e.y, e.a) : groundY(map, e.x, e.y);
        this.fx.explosion(e.x, alt, e.y, e.s, water && alt < 0.1);
        this.onSound(e.s > 0.8 ? 'boom_l' : 'boom_s', e.x, e.y);
        if (e.s > 0.6) this.overlay?.shock(e.x, e.y, alt, 0.5 + e.s * 0.5, '#ffb070', 0.7);
        break;
      }
      case 'splash':
        this.fx.splash(e.x, e.y, 0.5);
        this.onSound('splash', e.x, e.y, 0.6);
        break;
      case 'intercept':
        const ia = airY(map, e.x, e.y, e.a);
        this.fx.intercept(e.x, ia, e.y);
        this.overlay?.shock(e.x, e.y, ia, 0.6, '#ffffff', 0.5);
        this.overlay?.splash(e.x, e.y, ia);
        this.onSound('intercept', e.x, e.y);
        break;
      case 'kill': {
        const type = UNIT_TYPES[e.ty];
        const dom = UNITS[type].domain;
        const alt = this.units.get(e.id)?.m.root.position.y ?? 0;
        const big = dom === 'sea' ? (type === 'lander' ? 0.6 : type === 'merchant' ? 1.2 : 2) : dom === 'land' ? 1.1 : 0.8;
        this.fx.explosion(e.x, alt, e.y, big, dom === 'sea' || dom === 'sub');
        this.overlay?.shock(e.x, e.y, alt, big * 0.9, e.o === w.me ? '#ff5d4f' : '#ffd84a', 1.2);
        this.onSound(dom === 'air' ? 'boom_s' : 'boom_l', e.x, e.y, 1.2);
        if (this.units.has(e.id)) this.pendingKills.set(e.id, e);
        break;
      }
      case 'capture': {
        const s = map.sites[e.site];
        this.overlay?.shock(s.x, s.y, groundY(map, s.x, s.y), 2.2, e.o === w.me ? '#6fd0ff' : w.teamOf(e.o) === w.myTeam ? '#8dffb4' : '#ff5d4f', 1.4);
        break;
      }
      case 'lightning': {
        this.flashLight.position.set(e.x, 3, e.y);
        this.flashLight.intensity = 45;
        this.weatherView.lightning(e.x, e.y);
        const dc = Math.hypot(e.x - this.r.camera.position.x, e.y - this.r.camera.position.z);
        if (dc < 40) this.r.flash = Math.max(this.r.flash, 0.12 * (1 - dc / 40));
        this.onSound('thunder', e.x, e.y);
        break;
      }
      case 'land':
        this.fx.splash(e.x, e.y, 0.3);
        break;
      case 'mine':
        this.fx.splash(e.x, e.y, 0.25);
        break;
      case 'built': {
        const type = UNIT_TYPES[e.ty];
        if (UNITS[type].domain === 'sea') this.fx.splash(w.units.get(e.id)?.x ?? 0, w.units.get(e.id)?.y ?? 0, 0.6);
        break;
      }
    }
  }

  dispose() {
    // Release GPU buffers. Shared geometries/materials re-upload automatically if used again.
    this.r.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) (o as THREE.Light).dispose();
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture) v.dispose();
        if (mat instanceof THREE.ShaderMaterial) for (const u of Object.values(mat.uniforms)) if (u.value instanceof THREE.Texture) u.value.dispose();
        mat.dispose();
      }
    });
    this.r.scene.clear();
    this.units.clear();
    this.wrecks = [];
  }
}
