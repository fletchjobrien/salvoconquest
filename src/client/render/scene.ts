// Owns all 3D objects for a match: terrain, units, sites, wrecks, lights, weather visuals, effects.
import * as THREE from 'three';
import { UNITS, UNIT_TYPES, UnitType, MODULES, FACTIONS } from '../../shared/defs';
import { heightAt } from '../../shared/map';
import type { GameEvent } from '../../shared/protocol';
import { F_LANDED, F_FIRE, F_ABOARD, PROJ_KINDS } from '../../shared/protocol';
import type { World } from '../state';
import { PALETTES, Palette, playerColor } from '../theme';
import { Renderer, CameraRig } from './renderer';
import { TerrainView, VSCALE } from './terrain';
import { Fx } from './fx';
import { UnitModel, makeSiteModel, makeUnitModel, SiteModel, VIS_LEN } from './models';
import { groundY, visAlt, setAirZoom, airY, weaponY } from './coords';
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
  /** Which way the hulk rolls and pitches as it sinks (+1 / -1). */
  side: number;
  nose: number;
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
  private smokeEmit = 0;
  overlay: Overlay | null = null;
  onSound: (name: string, x: number, y: number, vol?: number, size?: number) => void = () => {};

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
    // Effects are culled against this frame's view (and skipped when too small to see).
    this.fx.view = { x: rig.tx, y: rig.ty, dist: rig.dist };
    this.fx.setView(this.r.camera, this.r.height / this.r.pixelSize);

    // ---- units ----
    const seen = new Set<number>();
    for (const u of w.units.values()) {
      // Flights stowed on a carrier are below deck: no model (it would clip through the carrier).
      if (u.flags & F_ABOARD) continue;
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
        if (u.flags & F_FIRE) {
          // A fire on board, at its own spot along the deck: flames and a tall black smoke column.
          const len = VIS_LEN[u.type] ?? 0.3;
          const along = (((u.id * 0.618) % 1) - 0.5) * len * 0.6;
          if (Math.random() < 0.5) this.fx.fire(u.x + Math.cos(u.h) * along, y3 + 0.03, u.y + Math.sin(u.h) * along, 1.4);
        } else if (u.hp < 50) {
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
        // Salvo's sinking: the hulk drifts on, settles ever faster and rolls onto its side; magazines
        // cook off for the first ten seconds and the deck burns until the sea closes over it.
        const k = Math.min(1, wr.t / 26);
        wr.vx *= Math.exp(-dt * 0.35);
        wr.x += Math.cos(wr.h) * wr.vx * dt;
        wr.y += Math.sin(wr.h) * wr.vx * dt;
        o.position.x = wr.x;
        o.position.z = wr.y;
        o.position.y = -Math.pow(k, 1.4) * 0.6;
        o.rotation.z = Math.min(0.9, wr.t * 0.05) * wr.side;
        o.rotation.x = Math.min(0.45, wr.t * 0.02) * wr.nose;
        const len = VIS_LEN[wr.type] ?? 0.3;
        const deck = () => {
          const a = (Math.random() - 0.5) * len * 0.8;
          return [wr.x + Math.cos(wr.h) * a, wr.y + Math.sin(wr.h) * a] as const;
        };
        if (wr.emit <= 0 && k < 0.85) {
          wr.emit = 0.04;
          const [fx, fy] = deck();
          this.fx.fire(fx, Math.max(0, o.position.y + 0.04), fy, 1.4 * (1 - k));
        }
        if (wr.t < 10 && wr.dom === 'sea' && Math.random() < dt * 0.6) {
          const [bx, by] = deck();
          this.fx.explosion(bx, Math.max(0, o.position.y + 0.03), by, 0.6, false);
          this.onSound('boom_s', bx, by, 0.8);
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
      const done = wr.t > (wr.dom === 'land' ? 40 : wr.dom === 'air' ? 16 : 30);
      if (done) scene.remove(wr.obj);
      return !done;
    });

    // ---- projectiles ----
    // Tracer streaks scale with zoom so they read like Salvo's at any distance.
    const streakLen = Math.max(0.12, rig.dist * 0.012);
    for (const p of w.projs.values()) {
      const ma = p.kind === 'missile' || p.kind === 'sam' || p.kind === 'atgm' ? weaponY(map, p.kind, p.air, p.rx, p.ry, p.ralt, p.alt0, w.clock - p.born) : p.ralt;
      const prev = this.trails.get(p.id);
      if (p.kind === 'missile' || p.kind === 'sam') {
        const carry = prev ? this.fx.missileTrail(prev.x, prev.a, prev.y, p.rx, ma, p.ry, prev.carry, p.kind === 'sam', !p.mine) : 0;
        this.trails.set(p.id, { x: p.rx, a: ma, y: p.ry, carry, seen: this.time });
      } else if (p.kind === 'atgm') {
        const carry = prev ? this.fx.atgmTrail(prev.x, prev.a, prev.y, p.rx, ma, p.ry, prev.carry) : 0;
        this.trails.set(p.id, { x: p.rx, a: ma, y: p.ry, carry, seen: this.time });
      } else if (p.kind === 'torpedo') {
        if (Math.random() < 0.5) this.fx.torpedoTrail(p.rx, p.ry);
      } else if (p.kind === 'shell' || p.kind === 'bomb') {
        if (prev) {
          const dx = p.rx - prev.x;
          const da = ma - prev.a;
          const dy = p.ry - prev.y;
          const d = Math.hypot(dx, da, dy);
          if (d > 1e-4) {
            const k = streakLen / d;
            this.fx.streak(p.rx - dx * k, ma - da * k, p.ry - dy * k, p.rx, ma, p.ry, 1, 0.75, 0.35);
          }
        }
        this.trails.set(p.id, { x: p.rx, a: ma, y: p.ry, carry: 0, seen: this.time });
      }
    }
    for (const [id, t] of this.trails) if (t.seen !== this.time) this.trails.delete(id);

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
    // Standing smoke screens: keep them topped up with puffs, thinning out in their last seconds.
    this.smokeEmit -= dt;
    if (this.smokeEmit <= 0 && w.smokes.length) {
      this.smokeEmit = 0.08;
      for (const [sx, sy, r, left] of w.smokes) {
        const fade = Math.min(1, left / 6);
        for (let k = 0; k < 2; k++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r * 0.85;
          const px = sx + Math.cos(a) * d;
          const py = sy + Math.sin(a) * d;
          this.fx.smokePuff(px, groundY(w.map, px, py), py, 0.5 + Math.random() * 0.4, 0.55 * fade + 0.1);
        }
      }
    }
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
    if (!this.prewarmed) this.prewarm();
    // Effects ask for camera shake; the rig applies it.
    rig.shake = Math.min(1, rig.shake + this.fx.shake);
    this.fx.shake = 0;
    this.fx.view = { x: rig.tx, y: rig.ty, dist: rig.dist };
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

  private prewarmed = false;

  /**
   * Compile every shader the battle can need, once, before play: effects that are hidden until
   * the first explosion, lightning or wreck, and every unit model. Otherwise each first use
   * compiles mid-game, a visible hitch (worst when panning reveals new things).
   */
  private prewarm() {
    this.prewarmed = true;
    const scene = this.r.scene;
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const extra = new THREE.Group();
    for (const f of FACTIONS) for (const t of UNIT_TYPES) extra.add(makeUnitModel(t, f, this.pal).root);
    const wreck = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), WRECK_MAT);
    extra.add(wreck);
    extra.position.set(this.world.map.size / 2, -50, this.world.map.size / 2);
    scene.add(extra);
    this.weatherView.lightning(-100, -100);
    try {
      this.r.gl.compile(scene, this.r.camera);
    } finally {
      scene.remove(extra);
      wreck.geometry.dispose();
      for (const o of hidden) o.visible = false;
    }
  }

  private pendingKills = new Map<number, GameEvent & { k: 'kill' }>();
  /** Last drawn position of each missile and shell (trails are laid by distance travelled). */
  private trails = new Map<number, { x: number; a: number; y: number; carry: number; seen: number }>();

  /** A warm screen flash for a big blast, fading with distance from the centre of the view. */
  private blastFlash(x: number, y: number, k: number) {
    const ref = this.fx.view.dist * 0.25 + 2;
    const d = Math.hypot(x - this.fx.view.x, y - this.fx.view.y);
    this.r.flashColor.setRGB(1, 0.7, 0.4);
    this.r.flash = Math.max(this.r.flash, (k * 0.16) / (1 + (d / ref) ** 2));
  }

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
      side: Math.random() < 0.5 ? -1 : 1,
      nose: Math.random() < 0.5 ? -1 : 1,
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
        } else if (m.proj === 'atgm') {
          this.fx.atgmLaunch(e.x, alt, e.y);
          this.onSound('sam', e.x, e.y, 0.4);
        } else if (m.proj === 'sam') {
          this.fx.launch(e.x, alt, e.y, true);
          this.onSound('sam', e.x, e.y);
        } else if (m.proj === 'shell') {
          const big = m.id === 'gun406' ? 2.2 : m.id === 'railgun' ? 1.6 : m.id === 'mortar' ? 0.6 : 1;
          this.fx.muzzle(e.x, alt, e.y, big, e.tx - e.x, e.ty - e.y);
          this.onSound(big > 1.5 ? 'bigGun' : 'gun', e.x, e.y, m.id === 'mortar' ? 0.5 : 1);
        } else if (m.proj === 'bullet') {
          // The event carries the target's height, so take the shooter's own height from the unit.
          const su = w.units.get(e.id);
          const sa = su ? visAlt(map, su.type, su.x, su.y, su.alt) : groundY(map, e.x, e.y);
          // At a missile: missile height frame; at an aircraft: aircraft frame; else the ground.
          const atMissile = [...w.projs.values()].some((q) => q.kind === 'missile' && Math.abs(q.rx - e.tx) < 0.4 && Math.abs(q.ry - e.ty) < 0.4);
          const air = atMissile || (e.a ?? 0) > 0.3;
          const ta = atMissile ? Math.max(groundY(map, e.tx, e.ty) + 0.03, (e.a ?? 0) * VSCALE) : air ? airY(map, e.tx, e.ty, e.a ?? 0) : groundY(map, e.tx, e.ty);
          const water = heightAt(map, e.tx, e.ty) < 0;
          if (m.id === 'rifles') {
            this.fx.smallArms(e.x, sa, e.y, e.tx, ta, e.ty, water);
            this.onSound('rifle', e.x, e.y);
          } else {
            this.fx.autocannon(e.x, sa, e.y, e.tx, ta, e.ty, water, air);
            this.onSound(m.id === 'ciws' ? 'ciws' : 'autocannon', e.x, e.y, 0.6);
          }
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
        const inAir = !!e.a && e.a > 0.1;
        const alt = inAir ? airY(map, e.x, e.y, e.a!) : groundY(map, e.x, e.y);
        const kind = e.p !== undefined ? PROJ_KINDS[e.p] : null;
        if (kind === 'torpedo' && water) {
          // Under the keel: a towering column of water.
          this.fx.torpedoHit(e.x, e.y);
          this.onSound('boom_l', e.x, e.y, 1.1, 1.6);
          this.blastFlash(e.x, e.y, 1);
        } else if (inAir && e.s < 0.3) {
          // A SAM bursting near (or short of) its target.
          this.fx.airburst(e.x, alt, e.y);
          this.onSound('boom_s', e.x, e.y, 0.6, 0.35);
        } else if (kind === 'shell' && e.s < 0.7) {
          this.fx.shellHit(e.x, alt, e.y);
          this.onSound('boom_s', e.x, e.y, 1, 0.5);
        } else {
          this.fx.explosion(e.x, alt, e.y, Math.min(1.5, Math.max(0.5, e.s)), water && alt < 0.1);
          this.onSound(e.s > 0.8 ? 'boom_l' : 'boom_s', e.x, e.y, 1, Math.min(1.5, Math.max(0.5, e.s)));
          if (kind === 'missile' || e.s > 1) this.blastFlash(e.x, e.y, 1);
        }
        // Hits on land throw up dirt.
        if (!water && !inAir) this.fx.dirt(e.x, alt, e.y, e.s);
        if (e.s > 0.6) this.overlay?.shock(e.x, e.y, alt, 0.5 + e.s * 0.5, '#ffb070', 0.7);
        break;
      }
      case 'splash': {
        const sz = e.s ?? 0.35;
        this.fx.splash(e.x, e.y, sz);
        this.onSound('splash', e.x, e.y, sz > 0.5 ? 1 : 0.6);
        break;
      }
      case 'chaff': {
        const ca = Math.max(groundY(map, e.x, e.y) + 0.05, e.a * VSCALE);
        this.fx.chaff(e.x, ca, e.y);
        this.onSound('launch', e.x, e.y, 0.5);
        break;
      }
      case 'smoke':
        this.fx.smokeBurst(e.x, groundY(map, e.x, e.y), e.y);
        this.onSound('splash', e.x, e.y, 0.4);
        break;
      case 'intercept':
        const ia = Math.max(groundY(map, e.x, e.y) + 0.03, e.a * VSCALE);
        this.fx.intercept(e.x, ia, e.y);
        this.overlay?.shock(e.x, e.y, ia, 0.6, '#ffffff', 0.5);
        this.overlay?.splash(e.x, e.y, ia);
        this.onSound('intercept', e.x, e.y);
        break;
      case 'kill': {
        const type = UNIT_TYPES[e.ty];
        const dom = UNITS[type].domain;
        const alt = this.units.get(e.id)?.m.root.position.y ?? 0;
        const warship = dom === 'sea' && type !== 'lander' && type !== 'merchant';
        const big = dom === 'sea' ? (type === 'lander' ? 0.6 : type === 'merchant' ? 1.2 : 2.2) : dom === 'land' ? 1.1 : 0.8;
        this.fx.explosion(e.x, alt, e.y, big, dom === 'sea' || dom === 'sub');
        this.overlay?.shock(e.x, e.y, alt, big * 0.9, e.o === w.me ? '#ff5d4f' : '#ffd84a', 1.2);
        this.onSound(dom === 'air' ? 'boom_s' : 'boom_l', e.x, e.y, 1.2, dom === 'air' ? 0.6 : big);
        if (warship || dom === 'sub') {
          // Salvo's sinking blast: a wide ring and three more explosions over two seconds.
          this.fx.ring(e.x, e.y, 150 * 0.014, 2.8, 0.4, 0xffd0a0);
          this.fx.addShake(e.x, e.y, 0.7);
          this.blastFlash(e.x, e.y, 1.6);
          for (const dt of [0.7, 1.4, 2.1]) {
            const ox = (Math.random() - 0.5) * 0.56;
            const oy = (Math.random() - 0.5) * 0.56;
            this.fx.later(dt, () => {
              this.fx.explosion(e.x + ox, 0, e.y + oy, 1.1, true);
              this.onSound('boom_l', e.x + ox, e.y + oy, 0.9, 1.1);
            });
          }
        }
        if (this.units.has(e.id)) this.pendingKills.set(e.id, e);
        break;
      }
      case 'capture': {
        const s = map.sites[e.site];
        this.overlay?.shock(s.x, s.y, groundY(map, s.x, s.y), 2.2, playerColor(e.o) ?? '#ff5d4f', 1.4);
        break;
      }
      case 'lightning': {
        this.r.flashColor.setRGB(1, 1, 1);
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
      case 'buoy':
        this.fx.splash(e.x, e.y, e.k === 'buoy' ? 0.15 : 0.25);
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
