// A running match: wires world state, rendering, overlay, HUD, input, audio and the connection.
import { UNITS, UNIT_TYPES, UnitType, MODULES, UNLOAD_RANGE, unitCost, counterOf } from '../shared/defs';
import { canDeployAt, rallySite } from '../shared/game';
import { islandAt } from '../shared/map';
import { weatherStrength } from '../shared/weather';
import type { Command, GameEvent, ServerMsg, StartInfo } from '../shared/protocol';
import { F_DARK, F_LANDED } from '../shared/protocol';
import { Conn } from './net';
import { World, UView } from './state';
import { Renderer, CameraRig } from './render/renderer';
import { GameScene } from './render/scene';
import { Overlay, OverlayView, Hover } from './render/overlay';
import { groundY } from './render/coords';
import { Hud, fireModeOf } from './ui/hud';
import { Minimap, screenToGround } from './ui/minimap';
import { audio, Sfx } from './audio/sfx';
import { voices, VoiceCat } from './audio/voice';
import { unitName } from './theme';
import { matchLoadoutOf, freezeForMatch } from './loadouts';

type Cat = 'naval' | 'ground' | 'air';

export class Match {
  world: World;
  scene: GameScene;
  overlay: Overlay;
  rig: CameraRig;
  hud: Hud;
  minimap: Minimap;
  selected = new Set<number>();
  groups = new Map<number, number[]>();
  view: OverlayView;
  private keys = new Set<string>();
  private drag: { x: number; y: number; btn: number; moved: boolean; tx: number; ty: number } | null = null;
  private lastClick = { t: 0, id: -1 };
  private lastAlert: { x: number; y: number } | null = null;
  private disposers: (() => void)[] = [];
  private announcedSites = new Set<string>();
  private lastUnderFire = 0;
  /** Recent combat around our forces (decays); drives the music. */
  private heat = 0;
  private heatAt = 0;
  private ended = false;
  onExit: () => void = () => {};
  onEnd: (msg: ServerMsg & { t: 'end' }) => void = () => {};

  constructor(
    readonly r: Renderer,
    readonly conn: Conn,
    info: StartInfo,
    readonly ui: HTMLElement,
  ) {
    freezeForMatch(info.players.find((p) => p.id === info.you)?.faction ?? 'coalition');
    this.world = new World(info);
    this.rig = new CameraRig(r.camera);
    this.overlay = new Overlay(document.getElementById('ov') as HTMLCanvasElement);
    this.overlay.resize(r.width, r.height);
    this.scene = new GameScene(r, this.world);
    this.scene.overlay = this.overlay;
    this.scene.onSound = (n, x, y, v) => audio.play(n as Sfx, x, y, v);
    this.view = {
      world: this.world,
      r,
      rig: this.rig,
      selected: this.selected,
      hover: null,
      dragRect: null,
      mode: null,
      mouse: { x: 0, y: 0, wx: 0, wy: 0, valid: false },
      showRanges: false,
      showSensors: false,
      hoverWeapon: null,
      rain: 0,
      pings: [],
    };
    this.hud = new Hud(this.world, {
      build: (_cat, type) => {
        // Deployment phase: the build bar picks what to place on the map instead.
        if (this.world.setup) {
          this.view.mode = { k: 'deploy', type };
          audio.play('click');
          return;
        }
        // In battle the build bar also picks a unit to place: click the map where it should go.
        this.view.mode = { k: 'build', type };
        audio.play('click');
      },
      ready: (on) => {
        this.send({ c: 'ready', on });
        audio.play(on ? 'order' : 'click');
      },
      cancel: (cat, type) => {
        const q = this.world.queues[cat];
        for (let i = q.length - 1; i >= 0; i--)
          if (q[i].type === type) {
            this.send({ c: 'cancel', cat, index: i });
            audio.play('deny');
            return;
          }
      },
      selectOnly: (ids) => this.select(ids, false),
      unloadMode: () => this.enterUnload(),
      toggleCargo: (id) => {
        if (this.hud.cargoSel.has(id)) this.hud.cargoSel.delete(id);
        else this.hud.cargoSel.add(id);
        audio.play('click');
        this.hud.invalidate();
      },
      ability: (a) => this.ability(a),
    });
    this.minimap = new Minimap(this.world);
    this.minimap.onJump = (x, y) => this.rig.flyTo(x, y);
    this.minimap.onCommand = (x, y) => this.commandAt(x, y, null, false);
    this.minimap.onToggleSensors = () => this.toggleSensors();
    this.hud.root.appendChild(this.minimap.el);
    ui.appendChild(this.hud.root);
    voices.onSubtitle = (_cat, text, who) => this.hud.log(who, text);
    this.world.onEvent = (e) => this.onEvent(e);
    // Start the camera over our home island.
    const me = info.players[info.you];
    const spawn = this.world.map.spawns[me.slot];
    if (spawn) {
      const c = this.world.map.size / 2;
      this.rig.flyTo(spawn.x + (c - spawn.x) * 0.15, spawn.y + (c - spawn.y) * 0.15);
      this.rig.yaw = this.rig.yaw;
    }
    this.rig.setDist(24, true);
    this.bindInput();
    audio.setMusicTheme(this.world.map.theme);
    audio.startAmbient();
    setTimeout(() => this.hud.banner('DEPLOYMENT PHASE', 'Place your starting force inside your zone · then launch the battle'), 400);
    setTimeout(() => this.hud.toggleHelp(false), 25000);
  }

  onServer(m: ServerMsg) {
    if (m.t === 's') this.world.apply(m);
    else if (m.t === 'end') {
      this.ended = true;
      audio.stinger(m.winners.includes(this.world.me) ? 'victory' : 'defeat');
      this.onEnd(m);
    } else if (m.t === 'chat') this.hud.log(m.from, m.text);
  }

  send(cmd: Command, uiSound = false) {
    this.conn.send({ t: 'cmd', cmd });
    if (uiSound) audio.play('click');
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number) {
    const w = this.world;
    w.update(dt);
    // Keyboard panning.
    let px = 0;
    let py = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) py -= 1;
    if (this.keys.has('KeyS')) py += 1;
    if (this.keys.has('ArrowDown')) py += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) px -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) px += 1;
    // Edge scrolling.
    const m = this.view.mouse;
    if (this.edgeScroll && this.mouseInside && document.hasFocus() && !this.drag) {
      if (m.x < 4) px -= 1;
      if (m.x > this.r.width - 4) px += 1;
      if (m.y < 4) py -= 1;
      if (m.y > this.r.height - 4) py += 1;
    }
    this.rig.push(px, py);
    if (this.keys.has('KeyQ')) this.rig.rotate(-dt * 1.2);
    if (this.keys.has('KeyE')) this.rig.rotate(dt * 1.2);
    this.rig.update(dt, w.map.size, w.clock);
    // Drop selections that no longer exist.
    for (const id of this.selected) if (!w.units.has(id)) this.selected.delete(id);
    if (this.view.mode?.k === 'unload') {
      this.view.mode.ships = this.view.mode.ships.filter((s) => w.units.has(s.ship));
      if (!this.view.mode.ships.length) this.view.mode = null;
    }
    if (this.view.mode?.k === 'deploy' && !w.setup) this.view.mode = null;
    this.updateMouseWorld();
    this.scene.update(dt, this.rig);
    this.r.render(w.clock);
    this.view.hoverWeapon = this.hud.hoverMod;
    this.overlay.draw(this.view, dt);
    this.updateHover();
    this.hud.update(this.selectedUnits(), w.clock);
    this.minimap.draw(dt, this.r, this.rig);
    audio.listener = { x: this.rig.tx, y: this.rig.ty, dist: this.rig.dist, yaw: this.rig.yaw };
    const wx = this.weatherAtCam();
    this.view.rain = wx;
    audio.setWeather(wx, this.rig.dist);
    if (w.clock - this.heatAt > 0.5) {
      this.heatAt = w.clock;
      audio.setMusicIntensity(this.musicIntensity());
    }
    this.view.pings = this.view.pings.filter((p) => w.clock - p.t < 1);
  }

  edgeScroll = true;
  private mouseInside = false;

  /**
   * How hot the fight is for us, 0..1: enemies close to our forces, missiles inbound, and
   * recent hits, launches and losses (the "heat", which fades over about half a minute).
   */
  private musicIntensity(): number {
    const w = this.world;
    this.heat *= Math.exp(-0.5 / 25);
    const mine = [...w.units.values()].filter((u) => u.owner === w.me);
    let near = 0;
    const close = (x: number, y: number, r: number) => mine.some((u) => Math.abs(u.x - x) < r && Math.abs(u.y - y) < r && Math.hypot(u.x - x, u.y - y) < r);
    for (const u of w.units.values()) if (w.teamOf(u.owner) !== w.myTeam && u.owner >= 0 && close(u.x, u.y, 14)) near++;
    for (const c of w.contacts.values()) if (close(c.x, c.y, 18)) near += 0.5;
    let inbound = 0;
    for (const p of w.projs.values()) if (!p.mine && (p.kind === 'missile' || p.kind === 'torpedo')) inbound++;
    if (this.ended) return 0;
    return Math.min(1, Math.min(0.45, near * 0.09) + Math.min(0.4, inbound * 0.15) + this.heat);
  }

  private weatherAtCam(): number {
    let storm = 0;
    for (const [kind, x, y, r, i] of this.world.weather) {
      if (kind !== 0) continue;
      storm = Math.max(storm, weatherStrength(0, this.rig.tx - x, this.rig.ty - y, r, i / 100));
    }
    return storm;
  }

  private selectedUnits(): UView[] {
    const out: UView[] = [];
    for (const id of this.selected) {
      const u = this.world.units.get(id);
      if (u) out.push(u);
    }
    return out;
  }

  private updateMouseWorld() {
    const m = this.view.mouse;
    let p = screenToGround(this.r, m.x, m.y, 0);
    if (p) {
      // Refine against terrain height.
      for (let i = 0; i < 3; i++) {
        const gy = groundY(this.world.map, p[0], p[1]);
        const q = screenToGround(this.r, m.x, m.y, gy);
        if (!q) break;
        p = q;
      }
      m.wx = p[0];
      m.wy = p[1];
      m.valid = true;
    } else m.valid = false;
  }

  private pick(x: number, y: number, ownOnly = false): Hover | null {
    let best: Hover | null = null;
    let bd = 18;
    let bestPri = 9;
    for (const it of this.overlay.items) {
      if (ownOnly && !(it.kind === 'unit' && it.own)) continue;
      const d = Math.hypot(it.sx - x, it.sy - y);
      if (d > 18) continue;
      const pri = it.kind === 'unit' ? (it.own ? 0 : 1) : it.kind === 'contact' ? 2 : it.kind === 'site' ? 3 : 4;
      if (pri < bestPri || (pri === bestPri && d < bd)) {
        best = { kind: it.kind, id: it.id };
        bd = d;
        bestPri = pri;
      }
    }
    return best;
  }

  private updateHover() {
    if (this.drag?.moved) return;
    this.view.hover = this.pick(this.view.mouse.x, this.view.mouse.y);
  }

  // ------------------------------------------------------------------ selection & commands

  select(ids: number[], add: boolean) {
    if (!add) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.hud.cargoSel.clear();
    this.hud.siteSel = null;
    this.view.mode = null;
    const first = this.world.units.get(ids[0]);
    if (first) {
      audio.play('select');
      void voices.say(this.world.myFaction, this.voiceCat(first.type), 'select', unitName(this.world.myFaction, first.type, first.id));
    }
  }

  private voiceCat(t: UnitType): VoiceCat {
    const c = UNITS[t].category;
    return c === 'air' ? 'air' : c === 'ground' ? 'ground' : 'naval';
  }

  private ownSelectedIds(): number[] {
    return [...this.selected].filter((id) => this.world.units.get(id)?.owner === this.world.me);
  }

  private ping(x: number, y: number, kind: 'move' | 'attack' | 'unload') {
    const color = kind === 'attack' ? '#ff6e5a' : kind === 'unload' ? '#8dffb4' : '#a6e6ff';
    this.view.pings.push({ x, y, t: this.world.clock, color, kind });
  }

  private commandAt(x: number, y: number, hover: Hover | null, forceMove: boolean) {
    const w = this.world;
    const ids = this.ownSelectedIds();
    if (this.view.mode?.k === 'unload') {
      const mode = this.view.mode;
      if (islandAt(w.map, x, y) < 0) {
        audio.play('deny');
        return;
      }
      // Every selected ship with troops lands them here, spread a little along the beach.
      const n = mode.ships.length;
      mode.ships.forEach((s, i) => {
        const a = (i / Math.max(1, n)) * Math.PI * 2;
        const off = n > 1 ? 0.35 : 0;
        let lx = x + Math.cos(a) * off;
        let ly = y + Math.sin(a) * off;
        if (islandAt(w.map, lx, ly) < 0) {
          lx = x;
          ly = y;
        }
        this.send({ c: 'unload', ship: s.ship, ids: s.ids, x: lx, y: ly });
      });
      this.ping(x, y, 'unload');
      audio.play('order');
      const first = mode.ships[0];
      void voices.say(w.myFaction, 'ground', 'unload', unitName(w.myFaction, 'infantry', first.ids[0] ?? first.ship));
      this.view.mode = null;
      this.hud.cargoSel.clear();
      return;
    }
    if (!ids.length) return;
    const first = w.units.get(ids[0])!;
    const cat = this.voiceCat(first.type);
    const who = unitName(w.myFaction, first.type, first.id);
    if (hover && !forceMove) {
      if (hover.kind === 'unit') {
        const t = w.units.get(hover.id);
        if (t && w.teamOf(t.owner) !== w.myTeam) {
          this.send({ c: 'attack', ids, target: t.id });
          this.ping(t.x, t.y, 'attack');
          audio.play('order');
          void voices.say(w.myFaction, cat, 'attack', who);
          return;
        }
        if (t && t.owner === w.me && UNITS[t.type].deck) {
          const air = ids.filter((id) => UNITS[w.units.get(id)!.type].domain === 'air');
          if (air.length) {
            this.send({ c: 'board', ids: air, ship: t.id });
            this.ping(t.x, t.y, 'unload');
            audio.play('order');
            void voices.say(w.myFaction, 'air', 'rtb', unitName(w.myFaction, w.units.get(air[0])!.type, air[0]));
            const rest = ids.filter((id) => !air.includes(id) && id !== t.id);
            if (rest.length) this.send({ c: 'move', ids: rest, x, y });
            return;
          }
        }
        if (t && t.owner === w.me && UNITS[t.type].hold > 0 || (t && t.owner === w.me && matchLoadoutOf(t.type).includes('troopbay'))) {
          const ground = ids.filter((id) => UNITS[w.units.get(id)!.type].domain === 'land');
          if (ground.length) {
            this.send({ c: 'board', ids: ground, ship: t!.id });
            this.ping(t!.x, t!.y, 'unload');
            audio.play('order');
            void voices.say(w.myFaction, 'ground', 'board', unitName(w.myFaction, 'infantry', ground[0]));
            const rest = ids.filter((id) => !ground.includes(id) && id !== t!.id);
            if (rest.length) this.send({ c: 'move', ids: rest, x, y });
            return;
          }
        }
      } else if (hover.kind === 'contact') {
        const c = w.contacts.get(hover.id);
        // Unidentified contacts are only a position: right-click there is a move order.
        if (c && c.kind >= 10) {
          this.send({ c: 'attack', ids, target: hover.id });
          this.ping(c.x, c.y, 'attack');
          audio.play('order');
          void voices.say(w.myFaction, cat, 'attack', who);
          return;
        }
        if (c) this.hud.log('CIC', 'Unidentified contact: cannot target it yet. Close in or bring an AEW to identify it.', 'warn');
      }
    }
    this.send({ c: 'move', ids, x, y, mode: forceMove ? 'move' : 'attack' });
    this.ping(x, y, 'move');
    audio.play('order');
    void voices.say(w.myFaction, cat, 'move', who);
  }

  /** Unload mode for every selected ship that carries troops (picked troops only, if any are picked). */
  private toggleSensors() {
    this.view.showSensors = !this.view.showSensors;
    this.minimap.setSensors(this.view.showSensors);
    audio.play('click');
  }

  private enterUnload() {
    const w = this.world;
    const ships: { ship: number; ids: number[] }[] = [];
    for (const id of this.selected) {
      const d = w.details.get(id);
      if (!d || !d[2].length) continue;
      const ids = this.hud.cargoSel.size ? d[2].filter((c) => this.hud.cargoSel.has(c)) : d[2].slice();
      if (ids.length) ships.push({ ship: id, ids });
    }
    if (!ships.length) {
      audio.play('deny');
      return;
    }
    this.view.mode = { k: 'unload', ships };
    audio.play('click');
    this.hud.log('ORDERS', `Pick a landing point${ships.length > 1 ? ` for ${ships.length} ships` : ''} within ${UNLOAD_RANGE} km — ships close in if needed.`, 'good');
  }

  private ability(a: 'mines' | 'rtb' | 'retreat' | 'stop' | 'siteFactory' | 'refund' | 'counter' | 'radar' | 'firemode') {
    const ids = this.ownSelectedIds();
    const w = this.world;
    switch (a) {
      case 'firemode': {
        // Cycle hold fire -> weapons tight -> weapons free; a mixed selection goes to tight.
        const us = ids.map((id) => w.units.get(id)).filter((u) => !!u);
        if (!us.length) break;
        const modes = new Set(us.map((u) => fireModeOf(u!.flags)));
        const mode = modes.size === 1 ? ([...modes][0] + 1) % 3 : 1;
        this.send({ c: 'firemode', ids: us.map((u) => u!.id), mode });
        audio.play('order');
        this.hud.log('FIRE CONTROL', mode === 0 ? 'Hold fire. Self-defence only.' : mode === 1 ? 'Weapons tight: two rounds per target.' : 'Weapons free: fire everything that bears.', mode === 2 ? 'warn' : 'good');
        break;
      }
      case 'radar': {
        // Toggle as a group: if any selected radar is on, switch them all off; otherwise all on.
        const radars = ids.map((id) => w.units.get(id)).filter((u) => !!u && (UNITS[u.type].radarAir > 0 || UNITS[u.type].radarSurf > 0 || matchLoadoutOf(u.type).some((m) => !!(MODULES[m]?.mods?.radarAir || MODULES[m]?.mods?.radarSurf))));
        if (!radars.length) {
          audio.play('deny');
          break;
        }
        const on = !radars.some((u) => !(u!.flags & F_DARK));
        this.send({ c: 'radar', ids: radars.map((u) => u!.id), on });
        audio.play('order');
        this.hud.log('EMCON', on ? `Radar on (${radars.length}). Emitting: enemy ESM can hear us.` : `Radar off (${radars.length}). Running silent: eyes and sonar only.`, on ? '' : 'good');
        break;
      }
      case 'counter': {
        // Every selected unit that still has its chaff or smoke fires it.
        const ready = ids.filter((id) => {
          const u = w.units.get(id);
          return u && counterOf(u.type) && (w.details.get(id)?.[14] ?? 0) > 0 && !(u.flags & F_LANDED);
        });
        if (!ready.length || w.setup) {
          audio.play('deny');
          break;
        }
        this.send({ c: 'counter', ids: ready });
        break;
      }
      case 'refund':
        if (!w.setup || !ids.length) break;
        this.send({ c: 'undeploy', ids });
        this.selected.clear();
        audio.play('cash');
        break;
      case 'mines':
        this.send({ c: 'mines', ids });
        break;
      case 'rtb':
        this.send({ c: 'rtb', ids });
        void voices.say(w.myFaction, 'air', 'rtb', 'FLIGHT');
        break;
      case 'retreat': {
        const on = !ids.every((id) => ((w.details.get(id)?.[7] ?? 1) & 1) === 1);
        this.send({ c: 'autoretreat', ids, on });
        this.hud.log('ORDERS', `Auto-retreat ${on ? 'ON' : 'OFF'}`);
        break;
      }
      case 'stop':
        this.send({ c: 'stop', ids });
        break;
      case 'siteFactory': {
        const s = this.hud.siteSel;
        if (s === null) break;
        const site = w.map.sites[s];
        const cat = site.type === 'navalbase' || site.type === 'dockyard' ? 'naval' : site.type === 'airbase' ? 'air' : 'ground';
        this.send({ c: 'factory', cat: cat as Cat, site: s });
        break;
      }
    }
    this.hud.invalidate();
  }

  // ------------------------------------------------------------------ events → feedback

  private onEvent(e: GameEvent) {
    const w = this.world;
    this.scene.onEvent(e);
    const fac = w.myFaction;
    switch (e.k) {
      case 'built': {
        if (e.o !== w.me) break;
        const type = UNIT_TYPES[e.ty];
        audio.play('built');
        const nu = w.units.get(e.id);
        if (nu) this.overlay.shock(nu.x, nu.y, 0, UNITS[type].domain === 'air' ? 0.6 : 0.9, '#6fd0ff', 0.9);
        void voices.say(fac, this.voiceCat(type), 'ready', unitName(fac, type, e.id), true);
        break;
      }
      case 'kill': {
        const type = UNIT_TYPES[e.ty];
        if (e.o === w.me) {
          if (type !== 'lander') {
            this.hud.log(unitName(fac, type, e.id), type === 'merchant' ? 'Merchant sunk!' : 'Unit lost.', 'bad');
            if (type !== 'merchant') void voices.say(fac, this.voiceCat(type), 'lost', unitName(fac, type, e.id), true);
            this.lastAlert = { x: e.x, y: e.y };
          }
        } else if (w.teamOf(e.o) !== w.myTeam && type !== 'lander') {
          this.hud.log('CIC', `Splash one ${UNITS[type].short}. ${type === 'merchant' ? 'Enemy merchant sunk.' : 'Target destroyed.'}`, 'good');
        }
        break;
      }
      case 'capture': {
        const s = w.map.sites[e.site];
        const isl = w.map.islands[s.island];
        const name = `${isl.home >= 0 ? (w.players.some((p) => p.slot === isl.home) ? 'HOME' : 'UNCLAIMED') : isl.name} ${s.type === 'resource' ? 'RESOURCES' : s.type.toUpperCase()}`;
        if (e.o === w.me) {
          audio.play('capture');
          audio.stinger('capture');
          this.hud.banner('SITE CAPTURED', name);
          this.overlay.floater(s.x, s.y, 0.3, s.type === 'resource' ? 'MERCHANTS DISPATCHED' : 'CAPTURED', '#6fd0ff');
          void voices.say(fac, 'ground', 'capture', 'MARINES', true);
        } else if (e.prev === w.me) {
          audio.play('lost');
          this.hud.log('CIC', `${name} lost to ${w.players[e.o]?.name ?? 'enemy'}!`, 'bad');
          this.hud.alert();
          this.lastAlert = { x: s.x, y: s.y };
        } else if (w.teamOf(e.o) !== w.myTeam && e.o >= 0) {
          const key = `${e.site}:${e.o}`;
          if (!this.announcedSites.has(key)) {
            this.announcedSites.add(key);
            this.hud.log('INTEL', `${w.players[e.o].name} took ${name}.`, 'warn');
          }
        }
        break;
      }
      case 'cash':
        if (e.o === w.me) {
          audio.play('cash', e.x, e.y);
          this.overlay.shock(e.x, e.y, 0.05, 0.6, '#7dff9a', 0.8);
          this.overlay.floater(e.x, e.y, 0.05, `+$${e.v}`, '#7dff9a');
        }
        break;
      case 'vampire': {
        this.heat = Math.min(0.6, this.heat + 0.3);
        audio.play('vampire');
        const near = [...w.units.values()].find((u) => u.owner === w.me && UNITS[u.type].category === 'naval' && Math.hypot(u.x - e.x, u.y - e.y) < 30);
        if (near) void voices.say(fac, 'naval', 'vampire', unitName(fac, near.type, near.id), true);
        else this.hud.log('CIC', 'Vampire! Missiles inbound!', 'warn');
        this.lastAlert = { x: e.x, y: e.y };
        this.hud.alert();
        break;
      }
      case 'chaff':
      case 'smoke': {
        const u = w.units.get(e.id);
        const txt = e.k === 'chaff' ? 'CHAFF' : 'SMOKE';
        const mine = !!u && u.owner === w.me;
        this.overlay.floater(e.x, e.y, e.k === 'chaff' ? e.a : 0.05, txt, mine ? '#7dd8ff' : '#ffb36b');
        if (mine && u) {
          audio.play('order');
          this.hud.log(unitName(fac, u.type, u.id), e.k === 'chaff' ? 'Chaff away!' : 'Popping smoke!', 'good');
        }
        break;
      }
      case 'battle':
        this.view.mode = null;
        this.hud.banner('BATTLE STATIONS', 'Deployment over · weapons free');
        audio.play('capture');
        break;
      case 'crit': {
        // Critical hit on a ship: floating callout over it; a log line (and alert) if it is ours.
        const u = w.units.get(e.id);
        const txt: Record<string, string> = {
          engine: 'ENGINE HIT',
          rudder: 'STEERING JAMMED',
          radar: 'RADAR DOWN',
          weapon: (e.m ?? 'WEAPON').toUpperCase() + ' OUT',
          fire: 'FIRE',
          flood: 'FLOODING',
          stun: 'CREW STUNNED',
        };
        if (u) this.overlay.floater(u.x, u.y, 0.1, txt[e.part], e.o === w.me ? '#ffb36b' : '#e8f6ff');
        if (e.o === w.me && u) {
          const msg: Record<string, string> = {
            engine: 'Engine hit! Dead in the water.',
            rudder: 'Steering jammed.',
            radar: 'Radar knocked out.',
            weapon: `${e.m ?? 'A weapon'} knocked out.`,
            fire: 'Fire on board!',
            flood: 'We are taking on water!',
            stun: 'Crew stunned.',
          };
          // Stuns are frequent and short: shown on the map, not logged.
          if (e.part !== 'stun') this.hud.log(unitName(fac, u.type, u.id), msg[e.part], 'bad');
          if (e.part === 'engine' || e.part === 'flood' || e.part === 'fire') this.lastAlert = { x: u.x, y: u.y };
        }
        break;
      }
      case 'retreat': {
        const u = w.units.get(e.id);
        if (u && u.owner === w.me) {
          void voices.say(fac, this.voiceCat(u.type), 'retreat', unitName(fac, u.type, u.id));
          if (e.ammo) this.hud.log(unitName(fac, u.type, u.id), 'Winchester: magazines empty, returning to port to rearm.', 'warn');
        }
        break;
      }
      case 'boom': {
        // Shake when something blows up close to the camera.
        const d = Math.hypot(e.x - this.rig.tx, e.y - this.rig.ty);
        if (d < this.rig.dist * 0.6 && e.s > 0.5) this.rig.shake = Math.max(this.rig.shake, Math.min(0.6, e.s * 0.4 * (1 - d / (this.rig.dist * 0.6))));
        if (e.s > 0.3 && [...w.units.values()].some((u) => u.owner === w.me && Math.hypot(u.x - e.x, u.y - e.y) < 12)) this.heat = Math.min(0.6, this.heat + 0.06 * Math.min(2, e.s));
        // Under fire callout.
        if (w.clock - this.lastUnderFire > 20) {
          const hit = [...w.units.values()].find((u) => u.owner === w.me && Math.hypot(u.x - e.x, u.y - e.y) < 0.4);
          if (hit) {
            this.lastUnderFire = w.clock;
            this.lastAlert = { x: e.x, y: e.y };
            const cat = this.voiceCat(hit.type);
            if (cat === 'naval') void voices.say(fac, 'naval', 'underfire', unitName(fac, hit.type, hit.id));
          }
        }
        break;
      }
      case 'land':
        if (w.units.get(e.id)?.owner === w.me) audio.play('splash', e.x, e.y, 0.5);
        break;
      case 'defeat': {
        const p = w.players[e.o];
        if (e.o === w.me) this.hud.banner('HQ LOST', 'Your forces have surrendered');
        else this.hud.banner(`${p?.name ?? 'ENEMY'} DEFEATED`, 'Headquarters captured');
        break;
      }
      case 'fire': {
        // Sonar ping when one of our subs launches.
        const m = MODULES[e.m];
        const u = w.units.get(e.id);
        if (u?.owner === w.me && u.type === 'sub' && m?.proj === 'torpedo') audio.play('sonar');
        break;
      }
    }
  }

  // ------------------------------------------------------------------ input

  private bindInput() {
    const canvas = this.r.canvas;
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void, target: Window | HTMLElement = window) => {
      target.addEventListener(t, f as EventListener);
      this.disposers.push(() => target.removeEventListener(t, f as EventListener));
    };
    on('resize', () => {
      this.r.resize();
      this.overlay.resize(this.r.width, this.r.height);
    });
    on('mousemove', (e) => {
      this.mouseInside = true;
      this.view.mouse.x = e.clientX;
      this.view.mouse.y = e.clientY;
      const d = this.drag;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) d.moved = true;
      if (d.btn === 0 && d.moved) this.view.dragRect = { x0: d.x, y0: d.y, x1: e.clientX, y1: e.clientY };
      if (d.btn === 1) {
        // Grab-pan: keep the grabbed ground point under the cursor.
        const p = screenToGround(this.r, e.clientX, e.clientY);
        if (p) {
          this.rig.tx += d.tx - p[0];
          this.rig.ty += d.ty - p[1];
        }
      }
    });
    on(
      'mousedown',
      (e) => {
        audio.unlock();
        if (e.button === 1) {
          e.preventDefault();
          const p = screenToGround(this.r, e.clientX, e.clientY);
          this.drag = { x: e.clientX, y: e.clientY, btn: 1, moved: false, tx: p?.[0] ?? 0, ty: p?.[1] ?? 0 };
          return;
        }
        if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, btn: 0, moved: false, tx: 0, ty: 0 };
        if (e.button === 2) {
          const m = this.view.mouse;
          if (!m.valid) return;
          if (this.view.mode?.k === 'deploy' || this.view.mode?.k === 'build') {
            this.view.mode = null;
            return;
          }
          if (this.view.mode && !this.selected.size) this.view.mode = null;
          this.commandAt(m.wx, m.wy, this.pick(e.clientX, e.clientY), e.ctrlKey || e.metaKey);
        }
      },
      canvas,
    );
    on('mouseup', (e) => {
      const d = this.drag;
      this.drag = null;
      this.view.dragRect = null;
      if (!d || d.btn !== 0 || e.button !== 0) return;
      const mode = this.view.mode;
      if (mode?.k === 'deploy' && !d.moved) {
        const m = this.view.mouse;
        const w = this.world;
        if (m.valid && w.setup && canDeployAt(w.map, w.players[w.me].slot, mode.type, m.wx, m.wy) && w.cash >= unitCost(mode.type, w.myFaction)) {
          this.send({ c: 'deploy', type: mode.type, x: m.wx, y: m.wy });
          audio.play('order');
          if (!e.shiftKey) this.view.mode = null;
        } else audio.play('deny');
        return;
      }
      if (mode?.k === 'build' && !d.moved) {
        const m = this.view.mouse;
        const w = this.world;
        const cat = UNITS[mode.type].category as Cat;
        const ok =
          m.valid &&
          rallySite(w.map, w.map.sites, (id) => w.sites[id]?.owner === w.me, mode.type, m.wx, m.wy) >= 0 &&
          w.cash >= unitCost(mode.type, w.myFaction) &&
          w.queues[cat].length < 8;
        if (ok) {
          this.send({ c: 'build', cat, type: mode.type, x: m.wx, y: m.wy });
          audio.play('order');
          if (!e.shiftKey) this.view.mode = null;
        } else audio.play('deny');
        return;
      }
      if (this.view.mode?.k === 'unload' && !d.moved) {
        const m = this.view.mouse;
        if (m.valid) this.commandAt(m.wx, m.wy, null, false);
        return;
      }
      if (d.moved) this.boxSelect(d.x, d.y, e.clientX, e.clientY, e.shiftKey);
      else this.clickSelect(e.clientX, e.clientY, e.shiftKey);
    });
    on('contextmenu', (e) => e.preventDefault());
    on(
      'wheel',
      (e) => {
        e.preventDefault();
        const m = this.view.mouse;
        const f = Math.exp(Math.sign(e.deltaY) * Math.min(0.35, Math.abs(e.deltaY) * 0.0015 + 0.08));
        this.rig.zoom(f, m.valid ? m.wx : undefined, m.valid ? m.wy : undefined);
      },
      canvas,
    );
    on('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      audio.unlock();
      this.keys.add(e.code);
      const ids = this.ownSelectedIds();
      if (e.code === 'Escape') {
        if (this.view.mode) this.view.mode = null;
        else if (this.selected.size || this.hud.siteSel !== null) {
          this.selected.clear();
          this.hud.siteSel = null;
        } else this.onExit();
        return;
      }
      if (e.code === 'Enter' && !this.conn.local) {
        e.preventDefault();
        this.openChat();
        return;
      }
      if (e.code === 'F1') {
        e.preventDefault();
        this.hud.toggleHelp();
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        this.view.showRanges = true;
      }
      if (e.code === 'KeyV') {
        this.toggleSensors();
      }
      if (e.code === 'Space' && this.lastAlert) {
        e.preventDefault();
        this.rig.flyTo(this.lastAlert.x, this.lastAlert.y);
      }
      const digit = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : -1;
      if (digit >= 1 && digit <= 9) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.groups.set(digit, ids);
          this.hud.log('ORDERS', `Group ${digit} set (${ids.length}).`);
        } else {
          const g = (this.groups.get(digit) ?? []).filter((id) => this.world.units.has(id));
          if (g.length) {
            const same = g.length === this.selected.size && g.every((id) => this.selected.has(id));
            this.select(g, false);
            if (same) {
              const u = this.world.units.get(g[0])!;
              this.rig.flyTo(u.x, u.y);
            }
          }
        }
      }
      if (!ids.length) return;
      if ((e.code === 'Delete' || e.code === 'Backspace') && this.world.setup) this.ability('refund');
      if (e.code === 'KeyX') this.ability('stop');
      if (e.code === 'KeyC') this.ability('counter');
      if (e.code === 'KeyF') this.ability('firemode');
      if (e.code === 'KeyG') this.ability('radar');
      if (e.code === 'KeyU') this.enterUnload();
      if (e.code === 'KeyM') this.ability('mines');
      if (e.code === 'KeyR') this.ability('rtb');
      if (e.code === 'KeyT') this.ability('retreat');
    });
    on('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.view.showRanges = false;
    });
    on('blur', () => this.keys.clear());
    const leave = () => (this.mouseInside = false);
    document.documentElement.addEventListener('mouseleave', leave);
    this.disposers.push(() => document.documentElement.removeEventListener('mouseleave', leave));
  }

  private chatEl: HTMLInputElement | null = null;
  private openChat() {
    if (!this.chatEl) {
      const el = document.createElement('input');
      el.className = 'field hp';
      el.placeholder = 'SAY TO ALL — ENTER TO SEND';
      el.maxLength = 140;
      Object.assign(el.style, { position: 'absolute', left: '16px', bottom: '230px', width: '300px', fontSize: '11px' });
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.code === 'Enter') {
          const text = el.value.trim();
          if (text) this.conn.send({ t: 'chat', text });
          el.value = '';
          el.blur();
          el.classList.add('hidden');
        } else if (e.code === 'Escape') {
          el.blur();
          el.classList.add('hidden');
        }
      });
      this.hud.root.appendChild(el);
      this.chatEl = el;
    }
    this.chatEl.classList.remove('hidden');
    this.chatEl.focus();
  }

  private clickSelect(x: number, y: number, add: boolean) {
    const hit = this.pick(x, y);
    const w = this.world;
    if (!hit) {
      if (!add) {
        this.selected.clear();
        this.hud.siteSel = null;
      }
      return;
    }
    if (hit.kind === 'unit') {
      const u = w.units.get(hit.id);
      if (!u) return;
      if (u.owner !== w.me) {
        this.selected.clear();
        this.hud.siteSel = null;
        this.hud.log('INTEL', `${w.players[u.owner]?.name ?? 'Enemy'} ${UNITS[u.type].names[w.faction(u.owner)]} · hull ${u.hp}%`, 'warn');
        return;
      }
      const now = performance.now();
      if (this.lastClick.id === u.id && now - this.lastClick.t < 350) {
        // Double click: all of this type on screen.
        const same = this.overlay.items.filter((it) => it.kind === 'unit' && it.own && it.type === u.type && it.sx > 0 && it.sy > 0 && it.sx < this.r.width && it.sy < this.r.height).map((it) => it.id);
        this.select(same, add);
      } else if (add && this.selected.has(u.id)) {
        this.selected.delete(u.id);
      } else this.select([u.id], add);
      this.lastClick = { t: now, id: u.id };
      return;
    }
    if (hit.kind === 'site') {
      this.selected.clear();
      this.hud.siteSel = hit.id;
      audio.play('click');
      return;
    }
    if (hit.kind === 'contact') {
      const c = w.contacts.get(hit.id);
      if (c) this.hud.log('CIC', `Radar contact · position error ±${c.r.toFixed(1)} km. Get closer or bring an AEW to classify.`, 'warn');
    }
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean) {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    let ids = this.overlay.items.filter((it) => it.kind === 'unit' && it.own && it.sx >= ax && it.sx <= bx && it.sy >= ay && it.sy <= by).map((it) => it.id);
    // Prefer combat units over merchants/landers.
    const combat = ids.filter((id) => {
      const t = this.world.units.get(id)?.type;
      return t && t !== 'merchant' && t !== 'lander';
    });
    if (combat.length) ids = combat;
    if (ids.length) this.select(ids, add);
    else if (!add) this.selected.clear();
  }

  dispose() {
    audio.setMusicIntensity(0);
    for (const d of this.disposers) d();
    this.hud.root.remove();
    this.scene.dispose();
    const ctx = this.overlay.ctx;
    ctx.clearRect(0, 0, this.overlay.canvas.width, this.overlay.canvas.height);
  }

  get isEnded() {
    return this.ended;
  }
}
