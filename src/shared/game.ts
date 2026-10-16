// Authoritative game simulation. Runs inside the Durable Object (online) or in the browser (offline).
import {
  BUILDINGS,
  BuildingType,
  CAPTURE_RADIUS,
  DOMINATION_SHARE,
  DOMINATION_TIME,
  FACTION_MOD,
  Faction,
  HQ_INCOME,
  Loadouts,
  MODULES,
  ModuleDef,
  START_CASH,
  SETUP_TIME,
  DEPLOY_MARGIN,
  BUILDABLE,
  CRIT,
  TICK,
  TargetClass,
  UNITS,
  UNIT_TYPES,
  UNLOAD_RANGE,
  BOARD_RANGE,
  UnitType,
  sanitizeLoadout,
  deriveStats,
  unitBuildTime,
  unitCost,
  ProjKind,
} from './defs';
import {
  GameMap,
  Site,
  Theme,
  THEME_INFO,
  cellCenter,
  cellOf,
  findPath,
  generateMap,
  heightAt,
  islandAt,
  nearestCell,
  lineClear,
} from './map';
import {
  Command,
  ContactRow,
  DetailRow,
  F_CARGO,
  F_DAMAGED,
  F_FIRING,
  F_LANDED,
  F_LOADING,
  F_MOVING,
  F_RETREAT,
  F_FIRE,
  F_STOPPED,
  F_STUN,
  CritPart,
  DamageRow,
  GameEvent,
  PROJ_KINDS,
  ProjRow,
  QueueItem,
  SiteRow,
  Snapshot,
  UnitRow,
  WeatherWire,
  ORDER_CODES,
} from './protocol';
import { Rng } from './rng';
import { weatherStrength } from './weather';

type Cat = 'naval' | 'ground' | 'air';
const CATS: Cat[] = ['naval', 'ground', 'air'];

export interface PlayerInit {
  name: string;
  faction: Faction;
  team: number;
  slot: number;
  bot: boolean;
  loadouts?: Loadouts;
}

export interface Weapon {
  mod: ModuleDef;
  ammo: number;
  max: number;
  cd: number;
}

export type Order =
  | { k: 'idle' }
  | { k: 'move'; x: number; y: number; attack: boolean }
  | { k: 'attack'; target: number; lx?: number; ly?: number }
  | { k: 'board'; ship: number }
  | { k: 'patrol'; x: number; y: number }
  | { k: 'rtb' }
  | { k: 'retreat'; x: number; y: number }
  | { k: 'unload'; x: number; y: number; ids: number[] };

const OVERKILL_CHECK = new Set<string>(['missile', 'torpedo', 'bomb']);

export interface ShipSystems {
  engine: number;
  rudder: number;
  radar: number;
  fire: number;
  flood: number;
  stun: number;
  /** Index of the knocked-out weapon (-1 none) and seconds until it works again. */
  weaponOut: number;
  weaponT: number;
  /** Repairs run faster while alongside a friendly naval base (game time until which this holds). */
  dockedUntil: number;
}

const newSystems = (): ShipSystems => ({ engine: 0, rudder: 0, radar: 0, fire: 0, flood: 0, stun: 0, weaponOut: -1, weaponT: 0, dockedUntil: 0 });

/** Which system a hit tends to knock out, by what hit it (relative weights). */
const CRIT_TABLE: Record<string, [CritPart, number][]> = {
  shell: [['weapon', 3], ['fire', 2], ['engine', 1.5], ['radar', 1.5], ['rudder', 1], ['stun', 1]],
  missile: [['fire', 3], ['radar', 2], ['engine', 1.5], ['weapon', 1.5], ['stun', 1.5], ['rudder', 0.5]],
  torpedo: [['flood', 3], ['engine', 3], ['rudder', 2]],
  mine: [['flood', 3], ['engine', 2.5], ['rudder', 2]],
  bomb: [['fire', 3], ['weapon', 2], ['radar', 1.5], ['engine', 1]],
  bullet: [['radar', 1], ['weapon', 1], ['fire', 0.5]],
};

export interface Unit {
  id: number;
  type: UnitType;
  owner: number;
  team: number;
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
  hp: number;
  maxHp: number;
  weapons: Weapon[];
  maxSpeed: number;
  radarAir: number;
  radarSurf: number;
  sonar: number;
  visual: number;
  ecm: number;
  quiet: number;
  holdCap: number;
  entrench: number;
  regen: number;
  fuel: number;
  fuelMax: number;
  order: Order;
  resume: Order | null;
  /**
   * Aircraft: the mission the player gave (patrol point or strike target). After an automatic
   * return to refuel or rearm, the flight goes back to it. Null = patrol near its base.
   */
  mission?: Order | null;
  path: { x: number; y: number }[] | null;
  pathGoal: { x: number; y: number } | null;
  repathAt: number;
  cargo: number[];
  inside: number; // carrier ship / lander id, or -1
  base: { site: number } | { unit: number } | null; // aircraft home
  landed: boolean;
  rearm: number;
  autoRetreat: boolean;
  retreating: boolean;
  revealUntil: number;
  firingUntil: number;
  stillFor: number;
  /** Critical damage to ship systems (seconds left); see CRIT in defs.ts. */
  sys: ShipSystems;
  /** Last enemy to hurt this unit (credited if fire or flooding sinks it). */
  lastHitBy: number;
  /** Seconds spent close to (but not at) the move point; groups can't all reach the exact spot. */
  nearGoalFor?: number;
  pendingDmg: number;
  dead: boolean;
  lastThink: number;
  // merchant
  site?: number;
  mstate?: 'out' | 'load' | 'back';
  mtimer?: number;
  port?: { x: number; y: number };
  // lander
  ferry?: { mode: 'unload' | 'board'; ship: number; dest: { x: number; y: number }; then: { x: number; y: number } | null; island: number };
  // ground: board bookkeeping
  boardShore?: { x: number; y: number; sx: number; sy: number };
}

export interface Projectile {
  id: number;
  kind: ProjKind;
  mod: ModuleDef;
  owner: number;
  team: number;
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
  target: number; // unit id, or -2-projId for interceptors, -1 none
  tx: number;
  ty: number;
  t: number;
  life: number;
  dmgMul: number;
  hitChance: number;
  sx: number;
  sy: number;
  dead: boolean;
  seeking: boolean;
  hostileSeen: boolean;
  /** Closest approach so far (SAMs). */
  best?: number;
  /** Missile arc: launch altitude, apex height above the launch-to-target line, distance flown. */
  arc?: { a0: number; apex: number; flown: number; f: number };
  /** Expected damage reserved on a unit (anti-overkill); released when the projectile ends. */
  resv?: { id: number; dmg: number };
}

interface Mine {
  id: number;
  owner: number;
  team: number;
  x: number;
  y: number;
  armAt: number;
}

export interface Contact {
  x: number;
  y: number;
  r: number;
  q: number;
  ident: 0 | 1 | 2; // 0 domain only, 1 classified, 2 exact track
  /** Fixed random offset (unit disc), scaled by r: one stable marker per track, no re-rolls. */
  ox: number;
  oy: number;
  /** Not detected on the last sweep: shown at the last estimate, never fired upon. */
  lost: boolean;
  seen: number;
}

export interface SiteState extends Site {
  owner: number;
  cap: number;
  capBy: number;
  weapons: Weapon[];
  merchantCd: number;
}

export interface Player {
  id: number;
  name: string;
  faction: Faction;
  team: number;
  slot: number;
  bot: boolean;
  cash: number;
  earned: number;
  income: number;
  queues: Record<Cat, { type: UnitType; t: number; total: number }[]>;
  factory: Record<Cat, { site: number } | { unit: number } | null>;
  loadouts: Record<string, string[]>;
  defeated: boolean;
  kills: number;
  losses: number;
  dom: number;
  incomeWindow: number[];
}

export interface Weather {
  id: number;
  kind: 0 | 1; // storm, fog
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  i: number; // current intensity 0..1
  peak: number;
  age: number;
  life: number;
}

const DOMAIN_IDX = { sea: 0, sub: 1, air: 2, land: 3 } as const;

export class Game {
  map: GameMap;
  theme: Theme;
  seed: number;
  time = 0;
  tickN = 0;
  /** Deployment phase first (place the starting force), then the battle. */
  phase: 'setup' | 'battle' = 'setup';
  setupLeft = SETUP_TIME;
  readySet = new Set<number>();
  rng: Rng;
  players: Player[] = [];
  units = new Map<number, Unit>();
  projs: Projectile[] = [];
  mines: Mine[] = [];
  sites: SiteState[] = [];
  weather: Weather[] = [];
  knowledge = new Map<number, Map<number, Contact>>();
  /** Per team: last owner seen at each site (-2 = never observed), and whether it is watched now. */
  siteIntel = new Map<number, { owner: Int32Array; watched: Uint8Array }>();
  events: { e: GameEvent; x: number; y: number; team: number }[] = [];
  nextId = 1;
  over = false;
  winnerTeam = -1;
  private sitesDirty = true;

  constructor(seed: number, theme: Theme, players: PlayerInit[]) {
    this.seed = seed;
    this.theme = theme;
    this.rng = new Rng(seed ^ 0x51ab);
    this.map = generateMap(seed, theme);
    for (const s of this.map.sites) {
      const w = BUILDINGS[s.type].weapons.map((m) => mkWeapon(MODULES[m]));
      this.sites.push({ ...s, owner: -1, cap: 0, capBy: -1, weapons: w, merchantCd: 0 });
    }
    players.forEach((p, i) => {
      const loadouts: Record<string, string[]> = {};
      for (const t of UNIT_TYPES) loadouts[t] = sanitizeLoadout(t, p.loadouts?.[t]);
      this.players.push({
        id: i,
        name: p.name,
        faction: p.faction,
        team: p.team,
        slot: p.slot,
        bot: p.bot,
        cash: START_CASH,
        earned: 0,
        income: 0,
        queues: { naval: [], ground: [], air: [] },
        factory: { naval: null, ground: null, air: null },
        loadouts,
        defeated: false,
        kills: 0,
        losses: 0,
        dom: 0,
        incomeWindow: [],
      });
      if (!this.knowledge.has(p.team)) this.knowledge.set(p.team, new Map());
    });
    // Home islands.
    for (const p of this.players) {
      for (const s of this.sites) {
        if (s.home === p.slot) {
          s.owner = p.id;
          if (s.type === 'navalbase') p.factory.naval = { site: s.id };
          if (s.type === 'airbase') p.factory.air = { site: s.id };
          if (s.type === 'barracks') p.factory.ground = { site: s.id };
        }
      }
      // No free starting forces: everyone buys and places theirs in the deployment phase.
    }
    // Everyone knows the neutral map and their own bases; other homes start unknown.
    for (const p of this.players) {
      if (this.siteIntel.has(p.team)) continue;
      const owner = new Int32Array(this.sites.length);
      this.sites.forEach((st, i) => (owner[i] = st.owner < 0 || this.team(st.owner) === p.team ? st.owner : -2));
      this.siteIntel.set(p.team, { owner, watched: new Uint8Array(this.sites.length) });
    }
    this.updateDetection(true);
  }

  // ------------------------------------------------------------------ helpers

  team(pid: number): number {
    return pid >= 0 ? this.players[pid].team : -1;
  }

  private emit(e: GameEvent, x: number, y: number, team = -1) {
    this.events.push({ e, x, y, team });
  }

  factorySite(p: Player, cat: Cat): SiteState | null {
    const f = p.factory[cat];
    if (f && 'site' in f) {
      const s = this.sites[f.site];
      if (s && s.owner === p.id) return s;
    }
    // Fallback: any owned production site of this category, home first.
    let best: SiteState | null = null;
    for (const s of this.sites) {
      if (s.owner !== p.id || BUILDINGS[s.type].produces !== cat) continue;
      if (!best || (s.home === p.slot && best.home !== p.slot)) best = s;
    }
    return best;
  }

  spawn(owner: number, type: UnitType, x: number, y: number): Unit {
    const def = UNITS[type];
    const p = this.players[owner];
    const lo = type === 'merchant' || type === 'lander' ? [] : p.loadouts[type] ?? def.defaults;
    const st = deriveStats(type, p.faction, lo);
    const weapons: Weapon[] = [];
    for (const id of lo) {
      const m = MODULES[id];
      if (m?.proj) weapons.push(mkWeapon(m));
    }
    const maxHp = st.hp;
    const u: Unit = {
      id: this.nextId++,
      type,
      owner,
      team: p.team,
      x,
      y,
      alt: def.domain === 'air' ? 0.9 : def.domain === 'sub' ? -0.05 : 0,
      heading: Math.atan2(this.map.size / 2 - y, this.map.size / 2 - x),
      speed: 0,
      hp: maxHp,
      maxHp,
      weapons,
      maxSpeed: st.speed,
      radarAir: st.radarAir,
      radarSurf: st.radarSurf,
      sonar: st.sonar,
      visual: def.visual,
      ecm: st.ecm,
      quiet: st.quiet,
      holdCap: st.hold,
      entrench: st.entrench,
      regen: st.regen,
      fuel: st.fuel,
      fuelMax: st.fuel,
      order: { k: 'idle' },
      resume: null,
      path: null,
      pathGoal: null,
      repathAt: 0,
      cargo: [],
      inside: -1,
      base: null,
      landed: false,
      rearm: 0,
      autoRetreat: def.category === 'naval' || def.category === 'ground',
      retreating: false,
      revealUntil: 0,
      firingUntil: 0,
      stillFor: 0,
      pendingDmg: 0,
      sys: newSystems(),
      lastHitBy: -1,
      dead: false,
      lastThink: this.rng.next(),
    };
    this.units.set(u.id, u);
    return u;
  }

  private dmgClass(u: Unit): TargetClass {
    return UNITS[u.type].domain;
  }

  inWorld(u: Unit): boolean {
    return !u.dead && u.inside < 0;
  }

  /** Storm and fog intensity at a point. */
  weatherAt(x: number, y: number): { storm: number; fog: number } {
    let storm = 0;
    let fog = THEME_INFO[this.theme].baseFog;
    for (const w of this.weather) {
      const f = weatherStrength(w.kind, x - w.x, y - w.y, w.r, w.i);
      if (f <= 0) continue;
      if (w.kind === 0) storm = Math.max(storm, f);
      else fog = Math.max(fog, f);
    }
    return { storm, fog };
  }

  // ------------------------------------------------------------------ commands

  command(pid: number, cmd: Command) {
    const p = this.players[pid];
    if (!p || p.defeated || this.over) return;
    const own = (ids: unknown): Unit[] => {
      if (!Array.isArray(ids)) return [];
      const out: Unit[] = [];
      for (const id of ids.slice(0, 200)) {
        const u = this.units.get(Number(id));
        if (u && !u.dead && u.owner === pid && u.type !== 'merchant' && u.type !== 'lander') out.push(u);
      }
      return out;
    };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    if (this.phase === 'setup') {
      this.setupCommand(pid, cmd, own, num);
      return;
    }
    switch (cmd.c) {
      case 'move': {
        const x = num(cmd.x);
        const y = num(cmd.y);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const us = own(cmd.ids).filter((u) => u.inside < 0 || this.units.get(u.inside)?.type !== 'lander');
        this.groupMove(us, x, y, cmd.mode !== 'move');
        break;
      }
      case 'attack': {
        const us = own(cmd.ids);
        const t = this.units.get(Number(cmd.target));
        if (!t || t.dead || t.team === p.team) return;
        // Only identified targets can be attacked; an unknown radar contact is just a position.
        const kt = this.knowledge.get(p.team)?.get(t.id);
        if (!kt || kt.ident < 1) return;
        const k = this.knowledge.get(p.team)?.get(t.id);
        for (const u of us) {
          if (u.inside >= 0) continue;
          this.setOrder(u, { k: 'attack', target: t.id });
          if (UNITS[u.type].domain === 'air') u.mission = { k: 'attack', target: t.id, lx: k?.x ?? t.x, ly: k?.y ?? t.y };
        }
        break;
      }
      case 'stop':
        for (const u of own(cmd.ids)) {
          if (u.inside >= 0) continue;
          if (UNITS[u.type].domain === 'air') {
            this.setOrder(u, { k: 'patrol', x: u.x, y: u.y });
            u.mission = { k: 'patrol', x: u.x, y: u.y };
          } else this.setOrder(u, { k: 'idle' });
        }
        break;
      case 'board': {
        const ship = this.units.get(Number(cmd.ship));
        if (!ship || ship.dead || ship.owner !== pid) return;
        // Aircraft: move to this carrier's deck (if there is room) and land there.
        if (UNITS[ship.type].deck) {
          for (const u of own(cmd.ids)) {
            if (UNITS[u.type].domain !== 'air') continue;
            const already = u.base && 'unit' in u.base && u.base.unit === ship.id;
            if (!already && this.deckUsed(ship) >= UNITS[ship.type].deck!) continue;
            if (u.landed && !already) this.launch(u);
            u.base = { unit: ship.id };
            // Land and stay on deck until given a new order.
            u.resume = { k: 'rtb' };
            u.mission = null;
            if (!u.landed) this.setOrder(u, { k: 'rtb' }, true);
          }
        }
        if (ship.holdCap <= 0) return;
        for (const u of own(cmd.ids)) {
          if (UNITS[u.type].domain !== 'land' || u.inside >= 0) continue;
          this.setOrder(u, { k: 'board', ship: ship.id });
        }
        break;
      }
      case 'unload': {
        const ship = this.units.get(Number(cmd.ship));
        const x = num(cmd.x);
        const y = num(cmd.y);
        if (!ship || ship.dead || ship.owner !== pid || Number.isNaN(x)) return;
        if (islandAt(this.map, x, y) < 0) return;
        const ids = Array.isArray(cmd.ids) && cmd.ids.length ? cmd.ids.map(Number).filter((i) => ship.cargo.includes(i)) : ship.cargo.slice();
        if (!ids.length) return;
        this.setOrder(ship, { k: 'unload', x, y, ids });
        break;
      }
      case 'mines':
        for (const u of own(cmd.ids)) this.dropMines(u);
        break;
      case 'rtb':
        // A player RTB ends the mission: land and stay down until given a new order.
        for (const u of own(cmd.ids))
          if (UNITS[u.type].domain === 'air' && !u.landed) {
            this.setOrder(u, { k: 'rtb' });
            u.resume = { k: 'rtb' };
            u.mission = null;
          }
        break;
      case 'autoretreat':
        for (const u of own(cmd.ids)) u.autoRetreat = !!cmd.on;
        break;
      case 'build': {
        if (!CATS.includes(cmd.cat)) return;
        const def = UNITS[cmd.type];
        if (!def || def.category !== cmd.cat) return;
        const cost = unitCost(cmd.type, p.faction);
        if (p.cash < cost || p.queues[cmd.cat].length >= 8) return;
        p.cash -= cost;
        const total = unitBuildTime(cmd.type, p.faction);
        p.queues[cmd.cat].push({ type: cmd.type, t: 0, total });
        break;
      }
      case 'cancel': {
        if (!CATS.includes(cmd.cat)) return;
        const q = p.queues[cmd.cat];
        const i = Number(cmd.index);
        if (!(i >= 0 && i < q.length)) return;
        const [it] = q.splice(i, 1);
        p.cash += unitCost(it.type, p.faction);
        break;
      }
      case 'factory': {
        if (!CATS.includes(cmd.cat)) return;
        if (typeof cmd.site === 'number') {
          const s = this.sites[cmd.site];
          if (s && s.owner === pid && BUILDINGS[s.type].produces === cmd.cat) p.factory[cmd.cat] = { site: s.id };
        }
        break;
      }
    }
  }

  private setOrder(u: Unit, o: Order, keepResume = false) {
    u.order = o;
    u.path = null;
    u.pathGoal = null;
    u.retreating = false;
    if (!keepResume) u.resume = null;
    if (UNITS[u.type].domain === 'air' && u.landed && o.k !== 'rtb') this.launch(u);
  }

  private groupMove(us: Unit[], x: number, y: number, attack: boolean) {
    if (!us.length) return;
    let cx = 0;
    let cy = 0;
    for (const u of us) {
      cx += u.x;
      cy += u.y;
    }
    cx /= us.length;
    cy /= us.length;
    const spread = Math.min(2.5, 0.4 + Math.sqrt(us.length) * 0.45);
    const clickIsland = islandAt(this.map, x, y);
    for (const u of us) {
      const dom = UNITS[u.type].domain;
      let ox = u.x - cx;
      let oy = u.y - cy;
      const d = Math.hypot(ox, oy);
      if (d > spread) {
        ox *= spread / d;
        oy *= spread / d;
      }
      if (us.length === 1) {
        ox = 0;
        oy = 0;
      }
      const tx = x + ox;
      const ty = y + oy;
      if (dom === 'air') {
        // Right-click on an enemy-free spot = patrol/mission point.
        this.setOrder(u, { k: 'patrol', x: tx, y: ty });
        u.mission = { k: 'patrol', x: tx, y: ty };
        continue;
      }
      if (dom === 'land') {
        const myIsland = islandAt(this.map, u.x, u.y);
        if (clickIsland < 0 || clickIsland !== myIsland) {
          // Clicking water/another island with troops: move to the nearest beach toward it.
          const c = nearestCell(this.map, x, y, (k) => this.map.islandOf[k] === myIsland, 200);
          if (c < 0) continue;
          const [bx, by] = cellCenter(this.map, c);
          this.setOrder(u, { k: 'move', x: bx, y: by, attack });
          continue;
        }
        let gx = tx;
        let gy = ty;
        if (islandAt(this.map, gx, gy) !== myIsland) {
          gx = x;
          gy = y;
        }
        this.setOrder(u, { k: 'move', x: gx, y: gy, attack });
        continue;
      }
      this.setOrder(u, { k: 'move', x: tx, y: ty, attack });
    }
  }

  private dropMines(u: Unit) {
    const w = u.weapons.find((w) => w.mod.ability === 'mines');
    if (!w || w.ammo <= 0 || w.cd > 0 || u.inside >= 0) return;
    w.ammo--;
    w.cd = w.mod.cooldown ?? 4;
    for (let i = 0; i < 2; i++) {
      const bx = u.x - Math.cos(u.heading) * (0.3 + i * 0.35) + this.rng.range(-0.15, 0.15);
      const by = u.y - Math.sin(u.heading) * (0.3 + i * 0.35) + this.rng.range(-0.15, 0.15);
      this.mines.push({ id: this.nextId++, owner: u.owner, team: u.team, x: bx, y: by, armAt: this.time + 4 });
    }
    this.emit({ k: 'mine', x: u.x, y: u.y }, u.x, u.y, u.team);
  }

  // ------------------------------------------------------------------ tick

  step() {
    if (this.over) return;
    if (this.phase === 'setup') {
      // Deployment: the clock and the world stand still; only the setup timer runs.
      this.tickN++;
      this.setupLeft -= TICK;
      const humans = this.players.filter((p) => !p.bot && !p.defeated);
      if (this.setupLeft <= 0 || (humans.length > 0 && humans.every((p) => this.readySet.has(p.id))) || (humans.length === 0 && this.players.every((p) => this.readySet.has(p.id)))) this.startBattle();
      return;
    }
    const dt = TICK;
    this.time += dt;
    this.tickN++;
    this.updateWeather(dt);
    this.updateEconomy(dt);
    this.updateProduction(dt);
    for (const u of this.units.values()) {
      if (u.dead) continue;
      if (u.inside >= 0) continue;
      const dom = UNITS[u.type].domain;
      if (dom === 'sea' || dom === 'sub') {
        this.updateSystems(u, dt);
        if (u.dead) continue;
      }
      this.think(u, dt);
      this.move(u, dt);
    }
    if (this.tickN % 2 === 0) this.separate();
    this.updateWeapons(dt);
    this.updateProjectiles(dt);
    this.updateMines();
    this.updateCapture(dt);
    if (this.tickN % 5 === 0) this.updateDetection(false);
    for (const [id, u] of this.units) if (u.dead) this.units.delete(id);
    this.projs = this.projs.filter((p) => {
      if (!p.dead) return true;
      // Release the anti-overkill reservation however the projectile ended (hit, miss,
      // shot down, self-destruct, out of fuel). A leak here makes ships stop firing.
      if (p.resv) {
        const t = this.units.get(p.resv.id);
        if (t) t.pendingDmg = Math.max(0, t.pendingDmg - p.resv.dmg);
        p.resv = undefined;
      }
      return false;
    });
    if (this.tickN % 10 === 0) this.checkVictory();
  }

  private startBattle() {
    this.phase = 'battle';
    this.setupLeft = 0;
    this.emit({ k: 'battle' }, 0, 0);
    this.updateDetection(true);
  }

  /** Setup-phase commands: buy and place, refund, reposition, embark troops, ready up. */
  private setupCommand(pid: number, cmd: Command, own: (ids: unknown) => Unit[], num: (v: unknown) => number) {
    const p = this.players[pid];
    switch (cmd.c) {
      case 'deploy': {
        const type = cmd.type as UnitType;
        const x = num(cmd.x);
        const y = num(cmd.y);
        if (!UNITS[type] || Number.isNaN(x) || Number.isNaN(y)) return;
        if (!Object.values(BUILDABLE).some((l) => l.includes(type))) return;
        const cost = unitCost(type, p.faction);
        if (p.cash < cost || !canDeployAt(this.map, p.slot, type, x, y)) return;
        p.cash -= cost;
        const u = this.spawn(pid, type, x, y);
        u.heading = Math.atan2(this.map.size / 2 - y, this.map.size / 2 - x);
        if (UNITS[type].domain === 'air') {
          const ab = this.factorySite(p, 'air');
          if (ab) u.base = { site: ab.id };
          u.alt = 0.9;
          u.speed = u.maxSpeed * 0.6;
          u.order = { k: 'patrol', x, y };
          u.mission = { k: 'patrol', x, y };
        }
        break;
      }
      case 'undeploy':
        for (const u of own(cmd.ids)) {
          for (const cid of u.cargo) {
            const c = this.units.get(cid);
            if (c) {
              p.cash += unitCost(c.type, p.faction);
              this.units.delete(cid);
            }
          }
          if (u.inside >= 0) {
            const ship = this.units.get(u.inside);
            if (ship) ship.cargo = ship.cargo.filter((id) => id !== u.id);
          }
          p.cash += unitCost(u.type, p.faction);
          this.units.delete(u.id);
        }
        break;
      case 'move': {
        // Repositioning is instant: keep the group's shape, skip spots outside the zone.
        const x = num(cmd.x);
        const y = num(cmd.y);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const us = own(cmd.ids).filter((u) => u.inside < 0);
        if (!us.length) return;
        let cx = 0;
        let cy = 0;
        for (const u of us) {
          cx += u.x / us.length;
          cy += u.y / us.length;
        }
        for (const u of us) {
          const tries: [number, number][] = [[x + (u.x - cx), y + (u.y - cy)], [x, y]];
          for (let k = 0; k < 8; k++) tries.push([x + Math.cos(k + u.id) * (0.4 + k * 0.15), y + Math.sin(k + u.id) * (0.4 + k * 0.15)]);
          const ok = tries.find(([tx, ty]) => canDeployAt(this.map, p.slot, u.type, tx, ty));
          if (!ok) continue;
          u.x = ok[0];
          u.y = ok[1];
          u.path = null;
          if (UNITS[u.type].domain === 'air') {
            u.order = { k: 'patrol', x: ok[0], y: ok[1] };
            u.mission = { k: 'patrol', x: ok[0], y: ok[1] };
          } else u.order = { k: 'idle' };
        }
        break;
      }
      case 'board': {
        // Embark at once: troops start the battle aboard.
        const ship = this.units.get(Number(cmd.ship));
        if (!ship || ship.dead || ship.owner !== pid || ship.holdCap <= 0) return;
        for (const u of own(cmd.ids)) {
          if (UNITS[u.type].domain !== 'land' || u.inside >= 0 || ship.cargo.length >= ship.holdCap) continue;
          u.inside = ship.id;
          ship.cargo.push(u.id);
          u.order = { k: 'idle' };
        }
        break;
      }
      case 'ready':
        if (cmd.on) this.readySet.add(pid);
        else this.readySet.delete(pid);
        break;
    }
  }

  // ------------------------------------------------------------------ weather

  private updateWeather(dt: number) {
    const info = THEME_INFO[this.theme];
    const S = this.map.size;
    const spawnCell = (kind: 0 | 1) => {
      // Enter from a random edge and drift across.
      const edge = this.rng.int(0, 3);
      const t = this.rng.range(0.1, 0.9) * S;
      const r = kind === 0 ? this.rng.range(9, 16) : this.rng.range(8, 18);
      const pos = [
        [t, -r * 0.5],
        [S + r * 0.5, t],
        [t, S + r * 0.5],
        [-r * 0.5, t],
      ][edge];
      const ang = Math.atan2(S / 2 - pos[1], S / 2 - pos[0]) + this.rng.range(-0.6, 0.6);
      const sp = kind === 0 ? this.rng.range(0.08, 0.15) : this.rng.range(0.04, 0.08);
      this.weather.push({
        id: this.nextId++,
        kind,
        x: pos[0],
        y: pos[1],
        r,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        i: 0,
        peak: this.rng.range(0.7, 1),
        age: 0,
        life: (S + r * 2) / sp,
      });
    };
    // Weather is occasional: a calm opening and at most two systems (storm or fog) at a time.
    if (this.time > 150 && this.weather.length < 2) {
      if (this.rng.next() < (info.stormRate / 120) * dt) spawnCell(0);
      else if (this.rng.next() < (info.fogRate / 120) * dt) spawnCell(1);
    }
    for (const w of this.weather) {
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.age += dt;
      const fadeIn = Math.min(1, w.age / 25);
      const fadeOut = Math.min(1, (w.life - w.age) / 25);
      w.i = w.peak * Math.max(0, Math.min(fadeIn, fadeOut));
      if (w.kind === 0 && w.i > 0.5 && this.rng.next() < dt * 0.25 * w.i) {
        const [ox, oy] = this.rng.inDisc(w.r * 0.7);
        this.emit({ k: 'lightning', x: w.x + ox, y: w.y + oy }, w.x + ox, w.y + oy);
      }
    }
    this.weather = this.weather.filter((w) => w.age < w.life);
  }

  // ------------------------------------------------------------------ economy

  private updateEconomy(dt: number) {
    for (const p of this.players) {
      if (p.defeated) continue;
      const hq = this.sites.find((s) => s.type === 'hq' && s.owner === p.id);
      if (hq) {
        p.cash += HQ_INCOME * dt;
        p.earned += HQ_INCOME * dt;
      }
    }
    // Merchants: one per owned resource site.
    for (const s of this.sites) {
      if (s.type !== 'resource' || s.owner < 0 || !s.dock) continue;
      const p = this.players[s.owner];
      if (p.defeated) continue;
      if (s.merchantCd > 0) {
        s.merchantCd -= dt;
        continue;
      }
      let has = false;
      for (const u of this.units.values()) if (u.type === 'merchant' && u.site === s.id && !u.dead && u.owner === s.owner) has = true;
      if (has) continue;
      const port = this.homePort(p, s.dock.x, s.dock.y);
      if (!port) continue;
      const m = this.spawn(p.id, 'merchant', port.x, port.y);
      m.site = s.id;
      m.mstate = 'out';
      m.mtimer = 0;
      m.port = { x: port.x, y: port.y };
      m.autoRetreat = false;
      s.merchantCd = 6;
    }
    if (this.tickN % 10 === 0) {
      for (const p of this.players) {
        p.incomeWindow.push(p.earned);
        if (p.incomeWindow.length > 31) p.incomeWindow.shift();
        const w = p.incomeWindow;
        p.income = w.length > 1 ? (w[w.length - 1] - w[0]) / (w.length - 1) : 0;
      }
    }
  }

  private homePort(p: Player, nearX: number, nearY: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bd = 1e9;
    for (const s of this.sites) {
      if (s.owner !== p.id || !s.dock || (s.type !== 'navalbase' && s.type !== 'dockyard')) continue;
      const d = Math.hypot(s.dock.x - nearX, s.dock.y - nearY) + (s.type === 'navalbase' ? 0 : 6);
      if (d < bd) {
        bd = d;
        best = s.dock;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ production

  private updateProduction(dt: number) {
    for (const p of this.players) {
      if (p.defeated) continue;
      for (const cat of CATS) {
        const q = p.queues[cat];
        if (!q.length) continue;
        const site = this.factorySite(p, cat);
        // Aircraft are built at airbases only; carriers take them aboard afterwards.
        if (!site) continue;
        const it = q[0];
        it.t += dt;
        if (it.t < it.total) continue;
        q.shift();
        let u: Unit;
        {
          const at = cat === 'naval' && site.dock ? site.dock : { x: site.x, y: site.y };
          let [ox, oy] = this.rng.inDisc(cat === 'ground' ? 0.6 : 0.3);
          // Ships must start in open water, not on the beach next to the dock.
          if (cat === 'naval') {
            for (let tries = 0; tries < 12 && this.map.nav[cellOf(this.map, at.x + ox, at.y + oy)] !== 0; tries++) [ox, oy] = this.rng.inDisc(0.3);
            if (this.map.nav[cellOf(this.map, at.x + ox, at.y + oy)] !== 0) ox = oy = 0;
          }
          let sx = at.x + ox;
          let sy = at.y + oy;
          if (cat === 'ground' && islandAt(this.map, sx, sy) !== site.island) {
            sx = site.x;
            sy = site.y;
          }
          u = this.spawn(p.id, it.type, sx, sy);
          if (cat === 'air') {
            u.base = { site: site.id };
            u.order = { k: 'patrol', x: site.x, y: site.y };
          }
        }
        this.emit({ k: 'built', id: u.id, ty: UNIT_TYPES.indexOf(u.type), o: p.id }, u.x, u.y, p.team);
      }
    }
  }

  // ------------------------------------------------------------------ AI / behaviours per unit

  private think(u: Unit, dt: number) {
    const def = UNITS[u.type];
    // Firing reveals submarines.
    if (u.type === 'merchant') return this.thinkMerchant(u, dt);
    if (u.type === 'lander') return this.thinkLander(u);
    if (def.domain === 'air') return this.thinkAir(u, dt);

    // Regen
    if (u.regen > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.regen * dt);
    for (const w of u.weapons) if (w.mod.regen && w.ammo < w.max) w.ammo = Math.min(w.max, w.ammo + w.mod.regen * dt);

    // Repair & rearm near friendly bases.
    if (this.tickN % 5 === 0) this.serviceAtBase(u, 0.5);

    // Periodic decisions (1 Hz, staggered).
    u.lastThink += dt;
    if (u.lastThink >= 1) {
      u.lastThink -= 1;
      this.considerRetreat(u);
      if (def.domain === 'land' && u.order.k === 'idle') this.autoAggro(u);
      if (u.retreating && u.hp >= u.maxHp * 0.85) {
        u.retreating = false;
        u.order = u.resume ?? { k: 'idle' };
        u.resume = null;
        u.path = null;
      }
    }

    switch (u.order.k) {
      case 'board':
        this.thinkBoard(u);
        break;
      case 'unload':
        this.thinkUnload(u);
        break;
      case 'attack': {
        const o = u.order;
        const t = this.units.get(o.target);
        const k = this.knowledge.get(u.team)?.get(o.target);
        if (!t || t.dead || !k || t.inside >= 0) {
          // Track lost: search where it was last seen (attack-move), instead of stopping dead.
          if (t && !t.dead && t.inside < 0 && o.lx !== undefined && o.ly !== undefined) {
            u.order = { k: 'move', x: o.lx, y: o.ly, attack: true };
          } else {
            u.order = { k: 'idle' };
            u.path = null;
          }
          break;
        }
        o.lx = k.x;
        o.ly = k.y;
        // Close in until some weapon can really engage (guns need a firm track, missiles a
        // seeker that can find the contact); then hold at a comfortable range.
        const d = Math.hypot(k.x - u.x, k.y - u.y);
        const reach = this.engageRange(u, t, k);
        if (reach <= 0 || d > Math.max(0.5, reach * 0.85)) this.navTo(u, k.x, k.y);
        else u.path = null;
        break;
      }
      case 'move':
      case 'retreat': {
        const o = u.order;
        // Ground attack-move halts while something is in weapon range.
        if (o.k === 'move' && o.attack && def.domain === 'land' && this.hasTargetInRange(u)) {
          u.speed = 0;
          return;
        }
        const d = Math.hypot(o.x - u.x, o.y - u.y);
        // Arrived, or reached the end of the route to a point it cannot stand on (a ship
        // sent to an inland target stops at the shore).
        const routeDone = !!u.path && u.path.length === 0 && !!u.pathGoal && u.stillFor > 2;
        const end = u.path && u.path.length ? u.path[u.path.length - 1] : null;
        const dNear = Math.min(d, end ? Math.hypot(end.x - u.x, end.y - u.y) : d);
        u.nearGoalFor = dNear < 1.2 ? (u.nearGoalFor ?? 0) + dt : 0;
        if (d < (def.domain === 'land' ? 0.15 : 0.35) || routeDone || u.nearGoalFor > 8) {
          u.nearGoalFor = 0;
          u.order = { k: 'idle' };
          u.path = null;
          u.speed *= 0.5;
        } else this.navTo(u, o.x, o.y);
        break;
      }
    }
  }

  private serviceAtBase(u: Unit, dt: number) {
    const dom = UNITS[u.type].domain;
    for (const s of this.sites) {
      if (s.owner < 0 || this.team(s.owner) !== u.team) continue;
      const naval = s.type === 'navalbase' || s.type === 'dockyard';
      if ((dom === 'sea' || dom === 'sub') && naval && s.dock) {
        if (Math.hypot(s.dock.x - u.x, s.dock.y - u.y) < 3) {
          u.sys.dockedUntil = this.time + 0.6;
          u.hp = Math.min(u.maxHp, u.hp + 3 * dt);
          for (const w of u.weapons) if (w.max > 0) w.ammo = Math.min(w.max, w.ammo + dt * 0.5);
          return;
        }
      }
      if (dom === 'land' && Math.hypot(s.x - u.x, s.y - u.y) < 2.2) {
        u.hp = Math.min(u.maxHp, u.hp + 1.5 * dt);
        for (const w of u.weapons) if (w.max > 0) w.ammo = Math.min(w.max, w.ammo + dt * 0.2);
        return;
      }
    }
  }

  private localPower(x: number, y: number, team: number, r: number, enemies: boolean): number {
    let sum = 0;
    for (const o of this.units.values()) {
      if (!this.inWorld(o) || o.type === 'merchant' || o.type === 'lander') continue;
      if ((o.team === team) === enemies) continue;
      if (Math.hypot(o.x - x, o.y - y) > r) continue;
      if (enemies) {
        const k = this.knowledge.get(team)?.get(o.id);
        if (!k) continue;
      }
      sum += o.hp * (o.weapons.length ? 1 : 0.3);
    }
    return sum;
  }

  private considerRetreat(u: Unit) {
    if (!u.autoRetreat || u.retreating) return;
    const dom = UNITS[u.type].domain;
    const thr = dom === 'land' ? 0.4 : 0.3;
    if (u.hp > u.maxHp * thr) return;
    const r = dom === 'land' ? 4 : 18;
    const enemy = this.localPower(u.x, u.y, u.team, r, true);
    if (enemy <= 0) return;
    const friend = this.localPower(u.x, u.y, u.team, r, false);
    if (enemy < friend * 0.8 && u.hp > u.maxHp * 0.2) return;
    // Find a safe spot.
    let best: { x: number; y: number } | null = null;
    let bd = 1e9;
    const isl = islandAt(this.map, u.x, u.y);
    for (const s of this.sites) {
      if (s.owner < 0 || this.team(s.owner) !== u.team) continue;
      if (dom === 'land') {
        if (s.island !== isl) continue;
        const d = Math.hypot(s.x - u.x, s.y - u.y);
        if (d < 1.5) return; // already there
        if (d < bd) {
          bd = d;
          best = { x: s.x, y: s.y };
        }
      } else if ((s.type === 'navalbase' || s.type === 'dockyard') && s.dock) {
        const d = Math.hypot(s.dock.x - u.x, s.dock.y - u.y);
        if (d < 2.5) return;
        if (d < bd) {
          bd = d;
          best = s.dock;
        }
      }
    }
    if (!best) return;
    if (u.order.k !== 'retreat') u.resume = u.order.k === 'idle' ? null : u.order;
    u.order = { k: 'retreat', x: best.x, y: best.y };
    u.retreating = true;
    u.path = null;
    this.emit({ k: 'retreat', id: u.id }, u.x, u.y, u.team);
  }

  private autoAggro(u: Unit) {
    // Idle ground units engage enemy ground units seen on the same island.
    const isl = islandAt(this.map, u.x, u.y);
    if (isl < 0) return;
    const know = this.knowledge.get(u.team)!;
    let best: Unit | null = null;
    let bd = 5;
    for (const [id, k] of know) {
      if (k.ident < 2) continue;
      const t = this.units.get(id);
      if (!t || !this.inWorld(t) || UNITS[t.type].domain !== 'land') continue;
      if (islandAt(this.map, t.x, t.y) !== isl) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (best && !this.hasTargetInRange(u)) {
      u.order = { k: 'move', x: best.x, y: best.y, attack: true };
      u.path = null;
    }
  }

  private thinkBoard(u: Unit) {
    if (u.order.k !== 'board') return;
    const ship = this.units.get(u.order.ship);
    if (!ship || ship.dead || ship.inside >= 0) {
      u.order = { k: 'idle' };
      return;
    }
    const isl = islandAt(this.map, u.x, u.y);
    // Shore point on my island closest to the ship (cached; recomputed when the ship moves).
    let bs = u.boardShore;
    if (!bs || Math.hypot(bs.sx - ship.x, bs.sy - ship.y) > 1.5) {
      const shore = nearestCell(this.map, ship.x, ship.y, (k) => this.map.islandOf[k] === isl && this.isCoastCell(k), 160);
      if (shore < 0) {
        u.order = { k: 'idle' };
        return;
      }
      const [cx, cy] = cellCenter(this.map, shore);
      bs = u.boardShore = { x: cx, y: cy, sx: ship.x, sy: ship.y };
    }
    const sx = bs.x;
    const sy = bs.y;
    const dShip = Math.hypot(ship.x - u.x, ship.y - u.y);
    const dShore = Math.hypot(sx - u.x, sy - u.y);
    const used = ship.cargo.length + this.incomingTo(ship.id);
    if (used >= ship.holdCap) {
      u.speed = 0;
      return; // wait for space
    }
    if ((dShore < 0.8 || this.isCoastCell(cellOf(this.map, u.x, u.y))) && dShip <= BOARD_RANGE) {
      // Embark in a landing craft.
      const wc = nearestCell(this.map, u.x, u.y, (k) => this.map.nav[k] !== 1, 6);
      if (wc < 0) return;
      const [wx, wy] = cellCenter(this.map, wc);
      const lc = this.spawn(u.owner, 'lander', wx, wy);
      lc.ferry = { mode: 'board', ship: ship.id, dest: { x: ship.x, y: ship.y }, then: null, island: isl };
      lc.cargo = [u.id];
      lc.heading = Math.atan2(ship.y - wy, ship.x - wx);
      u.inside = lc.id;
      u.order = { k: 'idle' };
      u.path = null;
      this.emit({ k: 'board', id: u.id, ship: ship.id }, u.x, u.y, u.team);
      return;
    }
    if (dShore > 0.5) this.navTo(u, sx, sy);
    else u.speed = 0;
    // Bring the ship closer if it is just idling.
    if (dShip > BOARD_RANGE - 0.5 && ship.order.k === 'idle') {
      const wc = nearestCell(this.map, sx, sy, (k) => this.map.nav[k] === 0, 30);
      if (wc >= 0) {
        const [wx, wy] = cellCenter(this.map, wc);
        // Stop a little offshore, along the line from the shore to the ship.
        ship.order = { k: 'move', x: wx, y: wy, attack: true };
        ship.path = null;
      }
    }
  }

  private incomingTo(shipId: number): number {
    let n = 0;
    for (const l of this.units.values()) if (l.type === 'lander' && !l.dead && l.ferry?.mode === 'board' && l.ferry.ship === shipId) n += l.cargo.length;
    return n;
  }

  isCoastCell(k: number): boolean {
    const m = this.map;
    if (m.nav[k] !== 1) return false;
    const nn = m.nn;
    const i = k % nn;
    const j = Math.floor(k / nn);
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nn || nj >= nn) continue;
      if (m.nav[nj * nn + ni] !== 1) return true;
    }
    return false;
  }

  private thinkUnload(ship: Unit) {
    if (ship.order.k !== 'unload') return;
    const o = ship.order;
    const ids = o.ids.filter((i) => ship.cargo.includes(i));
    if (!ids.length) {
      ship.order = { k: 'idle' };
      return;
    }
    const d = Math.hypot(o.x - ship.x, o.y - ship.y);
    if (d > UNLOAD_RANGE - 0.3) {
      // Close in automatically: head toward the nearest water near the target.
      const wc = nearestCell(this.map, o.x, o.y, (k) => this.map.nav[k] === 0, 40);
      if (wc < 0) {
        ship.order = { k: 'idle' };
        return;
      }
      const [wx, wy] = cellCenter(this.map, wc);
      this.navTo(ship, wx, wy);
      return;
    }
    ship.path = null;
    ship.speed *= 0.9;
    const isl = islandAt(this.map, o.x, o.y);
    // Beach: water cell (any) adjacent to land of the target island, nearest the click.
    const beachLand = nearestCell(this.map, o.x, o.y, (k) => this.map.islandOf[k] === isl && this.isCoastCell(k), 80);
    if (beachLand < 0) {
      ship.order = { k: 'idle' };
      return;
    }
    const [bx, by] = cellCenter(this.map, beachLand);
    ids.forEach((id, n) => {
      const g = this.units.get(id);
      ship.cargo = ship.cargo.filter((c) => c !== id);
      if (!g || g.dead) return;
      const ang = ship.heading + Math.PI / 2 + (n - (ids.length - 1) / 2) * 0.5;
      const lc = this.spawn(ship.owner, 'lander', ship.x + Math.cos(ang) * 0.15, ship.y + Math.sin(ang) * 0.15);
      const [jx, jy] = this.rng.inDisc(0.5);
      lc.ferry = { mode: 'unload', ship: ship.id, dest: { x: bx + jx * 0.5, y: by + jy * 0.5 }, then: { x: o.x + jx, y: o.y + jy }, island: isl };
      lc.cargo = [id];
      lc.heading = Math.atan2(by - ship.y, bx - ship.x);
      g.inside = lc.id;
    });
    ship.order = { k: 'idle' };
  }

  private thinkLander(l: Unit) {
    const f = l.ferry;
    if (!f) {
      l.dead = true;
      return;
    }
    if (f.mode === 'board') {
      const ship = this.units.get(f.ship);
      if (!ship || ship.dead) {
        // Ship gone: go back to the beach.
        f.mode = 'unload';
        const c = nearestCell(this.map, l.x, l.y, (k) => this.map.islandOf[k] === f.island && this.isCoastCell(k), 60);
        if (c < 0) {
          l.dead = true;
          return;
        }
        const [x, y] = cellCenter(this.map, c);
        f.dest = { x, y };
        f.then = null;
        return;
      }
      f.dest = { x: ship.x, y: ship.y };
      if (Math.hypot(ship.x - l.x, ship.y - l.y) < 0.35) {
        for (const id of l.cargo) {
          const g = this.units.get(id);
          if (!g) continue;
          if (ship.cargo.length < ship.holdCap) {
            ship.cargo.push(id);
            g.inside = ship.id;
            g.x = ship.x;
            g.y = ship.y;
          } else {
            g.dead = true;
          }
        }
        l.cargo = [];
        l.dead = true;
        return;
      }
      this.navTo(l, ship.x, ship.y);
    } else {
      const dLand = Math.hypot(f.dest.x - l.x, f.dest.y - l.y);
      const onLand = islandAt(this.map, l.x, l.y) === f.island && heightAt(this.map, l.x, l.y) > -0.02;
      if (dLand < 0.35 || onLand) {
        const c = nearestCell(this.map, l.x, l.y, (k) => this.map.islandOf[k] === f.island, 20);
        const [gx, gy] = c >= 0 ? cellCenter(this.map, c) : [f.dest.x, f.dest.y];
        for (const id of l.cargo) {
          const g = this.units.get(id);
          if (!g) continue;
          g.inside = -1;
          g.x = gx;
          g.y = gy;
          g.heading = l.heading;
          g.order = f.then ? { k: 'move', x: f.then.x, y: f.then.y, attack: true } : { k: 'idle' };
          g.path = null;
          this.emit({ k: 'land', id: g.id, x: gx, y: gy }, gx, gy, g.team);
        }
        l.cargo = [];
        l.dead = true;
        return;
      }
      this.navTo(l, f.dest.x, f.dest.y);
    }
  }

  private thinkMerchant(m: Unit, dt: number) {
    const s = this.sites[m.site ?? -1];
    const lost = !s || s.owner !== m.owner;
    if (lost && m.mstate === 'out') {
      m.mstate = 'back';
      m.mtimer = 0;
    }
    if (m.mstate === 'out' && s?.dock) {
      if (Math.hypot(s.dock.x - m.x, s.dock.y - m.y) < 0.6) {
        m.mstate = 'load';
        m.mtimer = 4;
        m.speed = 0;
      } else this.navTo(m, s.dock.x, s.dock.y);
    } else if (m.mstate === 'load') {
      m.speed = 0;
      m.mtimer = (m.mtimer ?? 0) - dt;
      if ((m.mtimer ?? 0) <= 0) {
        m.mstate = 'back';
        // Payout scales with the trip length.
        m.mtimer = s?.dock && m.port ? 60 + 12 * Math.hypot(s.dock.x - m.port.x, s.dock.y - m.port.y) : 100;
      }
    } else if (m.mstate === 'back') {
      const p = this.players[m.owner];
      const port = this.homePort(p, m.x, m.y) ?? m.port;
      if (!port) return;
      if (Math.hypot(port.x - m.x, port.y - m.y) < 0.6) {
        const v = Math.round(m.mtimer ?? 0);
        if (v > 0) {
          p.cash += v;
          p.earned += v;
          this.emit({ k: 'cash', o: p.id, v, x: m.x, y: m.y }, m.x, m.y, p.team);
        }
        if (lost) {
          m.dead = true;
          return;
        }
        m.port = { x: port.x, y: port.y };
        m.mstate = 'out';
        m.mtimer = 0;
      } else this.navTo(m, port.x, port.y);
    }
  }

  /** Flights based on a carrier (landed or in the air). */
  deckUsed(c: Unit): number {
    let n = 0;
    for (const a of this.units.values()) if (!a.dead && a.base && 'unit' in a.base && a.base.unit === c.id) n++;
    return n;
  }

  /** Nearest place this aircraft may land: a friendly airbase, or a friendly carrier with deck room. */
  nearestAirBase(u: Unit): { x: number; y: number; base: { site: number } | { unit: number } } | null {
    let best: { x: number; y: number; base: { site: number } | { unit: number } } | null = null;
    let bd = 1e9;
    for (const s of this.sites) {
      if (s.type !== 'airbase' || s.owner < 0 || this.team(s.owner) !== u.team) continue;
      const d = Math.hypot(s.x - u.x, s.y - u.y);
      if (d < bd) {
        bd = d;
        best = { x: s.x, y: s.y, base: { site: s.id } };
      }
    }
    for (const c of this.units.values()) {
      const cap = UNITS[c.type].deck ?? 0;
      if (c.dead || c.team !== u.team || !cap) continue;
      const mine = u.base && 'unit' in u.base && u.base.unit === c.id;
      if (!mine && this.deckUsed(c) >= cap) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < bd) {
        bd = d;
        best = { x: c.x, y: c.y, base: { unit: c.id } };
      }
    }
    return best;
  }

  private airBasePos(u: Unit): { x: number; y: number } | null {
    const b = u.base;
    if (b && 'site' in b) {
      const s = this.sites[b.site];
      if (s && s.owner >= 0 && this.team(s.owner) === u.team) return { x: s.x, y: s.y };
    } else if (b && 'unit' in b) {
      const c = this.units.get(b.unit);
      if (c && !c.dead) return { x: c.x, y: c.y };
    }
    // Base lost: pick the nearest one with room.
    const n = this.nearestAirBase(u);
    u.base = n ? n.base : null;
    return n;
  }

  /** Range budget (km) for out-and-back flight, and the base it is measured to. */
  private airDetail(u: Unit): [number, number, number] {
    if (UNITS[u.type].domain !== 'air' || u.landed) return [0, -1, -1];
    const n = this.nearestAirBase(u);
    if (!n) return [0, -1, -1];
    const km = Math.max(0, ((u.fuel - 6) * u.maxSpeed) / 1.12);
    return [Math.round(km * 10) / 10, Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100];
  }

  private deckIds(c: Unit): number[] {
    const ids: number[] = [];
    for (const a of this.units.values()) if (!a.dead && a.base && 'unit' in a.base && a.base.unit === c.id) ids.push(a.id);
    return ids;
  }

  /** Seconds of flight needed to reach the nearest base, with a safety margin. */
  bingoFuel(u: Unit): { need: number; base: { x: number; y: number; base: { site: number } | { unit: number } } | null } {
    const n = this.nearestAirBase(u);
    if (!n) return { need: 0, base: null };
    return { need: (Math.hypot(n.x - u.x, n.y - u.y) / u.maxSpeed) * 1.12 + 6, base: n };
  }

  /**
   * Apex of a missile's ballistic-looking arc: higher for longer shots, and raised so the arc
   * clears every hill on the straight line to the aim point (with a 100 m margin).
   */
  private arcApex(a0: number, x0: number, y0: number, x1: number, y1: number): number {
    const D = Math.hypot(x1 - x0, y1 - y0);
    let apex = Math.min(1.2, Math.max(0.2, D * 0.04));
    for (let i = 1; i < 24; i++) {
      const f = i / 24;
      const h = heightAt(this.map, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      if (h <= 0) continue;
      const base = a0 * (1 - f) + 0.02 * f;
      apex = Math.max(apex, (h + 0.1 - base) / Math.sin(Math.PI * f));
    }
    return Math.min(2.2, apex);
  }

  /** Put a rearmed flight back on its mission; a dead strike target becomes a patrol of that area. */
  private resumeMission(u: Unit, bp: { x: number; y: number }) {
    const m = u.mission;
    u.resume = null;
    if (m && m.k === 'attack') {
      const t = this.units.get(m.target);
      const k = this.knowledge.get(u.team)?.get(m.target);
      const area: Order = { k: 'patrol', x: k?.x ?? m.lx ?? bp.x, y: k?.y ?? m.ly ?? bp.y };
      if (t && !t.dead && t.inside < 0 && k) {
        u.order = { k: 'attack', target: m.target };
        u.resume = area;
      } else {
        u.order = area;
        u.mission = area;
      }
      return;
    }
    u.order = m ? { ...m } : { k: 'patrol', x: bp.x, y: bp.y };
  }

  private launch(u: Unit) {
    u.landed = false;
    u.alt = 0.9;
    u.speed = UNITS[u.type].speed * 0.6;
  }

  private thinkAir(u: Unit, dt: number) {
    if (u.landed) {
      // Rearm/refuel on the ground, then resume the mission. A carrier that sinks takes its deck with it.
      if (u.base && 'unit' in u.base) {
        const c = this.units.get(u.base.unit);
        if (!c || c.dead) {
          this.kill(u, -1);
          return;
        }
      }
      const bp = this.airBasePos(u);
      if (!bp) {
        u.dead = true;
        return;
      }
      u.x = bp.x;
      u.y = bp.y;
      u.speed = 0;
      u.alt = 0;
      u.rearm -= dt;
      u.hp = Math.min(u.maxHp, u.hp + 2 * dt);
      if (u.rearm <= 0) {
        for (const w of u.weapons) w.ammo = w.max;
        u.fuel = u.fuelMax;
        if (!u.resume || u.resume.k !== 'rtb') {
          // Back to the mission it left to refuel or rearm.
          this.resumeMission(u, bp);
          this.launch(u);
        }
      }
      return;
    }
    u.fuel -= dt;
    // Bingo fuel: turn back while the nearest base is still in reach.
    let bingo = false;
    if (u.order.k !== 'rtb' && this.tickN % 5 === u.id % 5) {
      const bf = this.bingoFuel(u);
      if (bf.base && u.fuel <= bf.need) {
        bingo = true;
        u.base = bf.base.base;
      }
    }
    const needRtb =
      bingo ||
      (u.type === 'strike' && u.weapons.every((w) => w.max > 0 && w.ammo < 1) && u.weapons.some((w) => w.max > 0)) ||
      (u.type === 'fighter' && u.weapons.filter((w) => w.max > 0).every((w) => w.ammo < 1) && u.order.k !== 'rtb');
    if (u.fuel <= 0) {
      this.kill(u, -1);
      return;
    }
    if (needRtb && u.order.k !== 'rtb') {
      // Automatic return: the mission (u.mission) is kept and resumed after rearming.
      u.resume = null;
      u.order = { k: 'rtb' };
    }
    const o = u.order;
    if (o.k === 'rtb') {
      const bp = this.airBasePos(u);
      if (!bp) {
        // Nowhere to land: circle until fuel runs out.
        this.flyToward(u, u.x + Math.cos(u.heading + 0.5), u.y + Math.sin(u.heading + 0.5), dt);
        return;
      }
      const d = Math.hypot(bp.x - u.x, bp.y - u.y);
      if (d < 0.6) {
        u.landed = true;
        u.rearm = 9;
        u.alt = 0;
        return;
      }
      this.flyToward(u, bp.x, bp.y, dt);
      u.alt += (Math.min(0.9, d * 0.15) - u.alt) * dt;
      return;
    }
    u.alt += (0.9 - u.alt) * dt * 0.8;
    if (o.k === 'attack') {
      const k = this.knowledge.get(u.team)?.get(o.target);
      const t = this.units.get(o.target);
      if (!t || t.dead || !k || t.inside >= 0) {
        // Strike target gone: the mission becomes a patrol of that area.
        if (u.mission?.k === 'attack' && u.mission.target === o.target) u.mission = { k: 'patrol', x: u.mission.lx ?? u.x, y: u.mission.ly ?? u.y };
        u.order = u.resume ?? (u.mission ? { ...u.mission } : { k: 'patrol', x: u.x, y: u.y });
        u.resume = null;
        return;
      }
      if (u.mission?.k === 'attack' && u.mission.target === o.target) {
        u.mission.lx = k.x;
        u.mission.ly = k.y;
      }
      const cls = this.dmgClass(t);
      const rng = this.maxRangeVs(u, cls);
      const d = Math.hypot(k.x - u.x, k.y - u.y);
      if (rng <= 0) {
        u.order = u.resume ?? { k: 'patrol', x: u.x, y: u.y };
        return;
      }
      if (d > rng * 0.8) this.flyToward(u, k.x, k.y, dt);
      else this.orbit(u, k.x, k.y, Math.max(1.2, rng * 0.6), dt);
      return;
    }
    if (o.k === 'patrol') {
      // Look for work around the mission point.
      if (this.tickN % 5 === 0) {
        const tgt = this.airPickTarget(u, o.x, o.y);
        if (tgt) {
          u.resume = o;
          u.order = { k: 'attack', target: tgt };
          return;
        }
      }
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d > 3.2) this.flyToward(u, o.x, o.y, dt);
      else this.orbit(u, o.x, o.y, 2.6, dt);
      return;
    }
    // Idle fallback.
    u.order = { k: 'patrol', x: u.x, y: u.y };
  }

  private airPickTarget(u: Unit, px: number, py: number): number | 0 {
    const know = this.knowledge.get(u.team)!;
    const classes = new Set<TargetClass>();
    for (const w of u.weapons) if ((w.ammo > 0 || w.max < 0) && w.mod.dmg) for (const k of Object.keys(w.mod.dmg)) if ((w.mod.dmg as any)[k] > 1) classes.add(k as TargetClass);
    if (u.type === 'strike') classes.delete('air');
    if (!classes.size) return 0;
    const radius = u.type === 'fighter' ? 24 : 14;
    let best = 0;
    let bd = 1e9;
    for (const [id, k] of know) {
      const t = this.units.get(id);
      if (!t || !this.inWorld(t)) continue;
      const cls = this.dmgClass(t);
      if (!classes.has(cls)) continue;
      if (k.ident < 1 && cls !== 'air') continue;
      if (t.type === 'lander') continue;
      const d = Math.hypot(k.x - px, k.y - py);
      if (d > radius) continue;
      const score = d + (t.type === 'merchant' ? 6 : 0);
      if (score < bd) {
        bd = score;
        best = id;
      }
    }
    return best;
  }

  private flyToward(u: Unit, x: number, y: number, dt: number) {
    const def = UNITS[u.type];
    const want = Math.atan2(y - u.y, x - u.x);
    u.heading = turnToward(u.heading, want, def.turn * dt);
    u.speed += (u.maxSpeed - u.speed) * Math.min(1, dt * 0.8);
  }

  private orbit(u: Unit, x: number, y: number, r: number, dt: number) {
    const ang = Math.atan2(u.y - y, u.x - x) + 0.6;
    this.flyToward(u, x + Math.cos(ang) * r, y + Math.sin(ang) * r, dt);
  }

  // ------------------------------------------------------------------ movement

  private passFor(u: Unit): (c: number) => boolean {
    const dom = UNITS[u.type].domain;
    const m = this.map;
    if (u.type === 'lander') return (c) => m.nav[c] !== 1;
    if (dom === 'land') {
      const isl = islandAt(m, u.x, u.y);
      return (c) => m.nav[c] === 1 && m.islandOf[c] === isl;
    }
    return (c) => m.nav[c] === 0;
  }

  private navTo(u: Unit, x: number, y: number) {
    const dom = UNITS[u.type].domain;
    if (dom === 'air') return;
    const g = u.pathGoal;
    if (!u.path || !g || Math.hypot(g.x - x, g.y - y) > 0.6 || (u.path.length === 0 && Math.hypot(x - u.x, y - u.y) > 0.4)) {
      if (this.time < u.repathAt && u.path && g && Math.hypot(g.x - x, g.y - y) < 3) return;
      u.repathAt = this.time + 1.5;
      u.pathGoal = { x, y };
      const pass = this.passFor(u);
      if (u.type === 'lander') {
        // Landing craft drive straight in; only route around islands when blocked.
        const direct = lineClear(this.map, u.x, u.y, x, y, (c) => this.map.nav[c] !== 1 || this.map.islandOf[c] === u.ferry?.island);
        u.path = direct ? [{ x, y }] : findPath(this.map, u.x, u.y, x, y, pass) ?? [{ x, y }];
      } else {
        const path = findPath(this.map, u.x, u.y, x, y, pass);
        u.path = path ?? [];
        if (!path) {
          // Unreachable (another sea, or inland): give up the move instead of waiting forever.
          u.repathAt = this.time + 6;
          if (u.order.k === 'move' || u.order.k === 'retreat') {
            u.order = { k: 'idle' };
            u.pathGoal = null;
          }
        }
      }
    }
  }

  private move(u: Unit, dt: number) {
    const def = UNITS[u.type];
    const dom = def.domain;
    if (dom === 'air') {
      if (u.landed) return;
      u.x += Math.cos(u.heading) * u.speed * dt;
      u.y += Math.sin(u.heading) * u.speed * dt;
      u.x = Math.max(-5, Math.min(this.map.size + 5, u.x));
      u.y = Math.max(-5, Math.min(this.map.size + 5, u.y));
      return;
    }
    const path = u.path;
    let target: { x: number; y: number } | null = null;
    while (path && path.length) {
      const wp = path[0];
      const d = Math.hypot(wp.x - u.x, wp.y - u.y);
      if (d < (dom === 'land' ? 0.12 : 0.3) && path.length > 1) path.shift();
      // Final waypoint: ships turn too wide to hit a 100 m spot, so they accept 300 m.
      else if (d < (dom === 'land' ? 0.1 : 0.3)) path.shift();
      else {
        target = wp;
        break;
      }
    }
    const w = this.weatherAt(u.x, u.y);
    const wMul = dom === 'sub' ? 1 : 1 - 0.4 * w.storm;
    if (!target) {
      u.speed = Math.max(0, u.speed - dt * u.maxSpeed * 0.8);
      if (dom === 'land') u.speed = 0;
      u.stillFor += dt;
    } else {
      const want = Math.atan2(target.y - u.y, target.x - u.x);
      const diff = Math.abs(angDiff(u.heading, want));
      if (dom === 'land') {
        u.heading = turnToward(u.heading, want, def.turn * dt);
        u.speed = u.maxSpeed;
      } else {
        // Jammed steering turns at a quarter rate; engine and flooding damage cut speed.
        u.heading = turnToward(u.heading, want, def.turn * (u.sys.rudder > 0 ? 0.25 : 1) * dt);
        const dEnd = Math.hypot(target.x - u.x, target.y - u.y) + (path!.length > 1 ? 5 : 0);
        let vmax = u.maxSpeed * this.speedFactor(u) * wMul * (diff > 1 ? 0.45 : 1);
        vmax = Math.min(vmax, Math.max(0.05, dEnd * 0.35));
        if (this.speedFactor(u) === 0) vmax = 0;
        const acc = u.maxSpeed * 0.35;
        u.speed += Math.max(-acc * dt * 2, Math.min(acc * dt, vmax - u.speed));
      }
      u.stillFor = 0;
    }
    if (dom !== 'land' && this.speedFactor(u) === 0) u.speed = Math.max(0, u.speed - dt * u.maxSpeed * 0.5);
    if (u.speed <= 0) return;
    const nx = u.x + Math.cos(u.heading) * u.speed * dt;
    const ny = u.y + Math.sin(u.heading) * u.speed * dt;
    const pass = this.passFor(u);
    const c = cellOf(this.map, nx, ny);
    // A unit that ended up on a cell it may not use (spawned at a crowded dock, shoved by a
    // neighbour) may always move, so it can drive out instead of being stuck forever.
    if (pass(c) || u.type === 'lander' || !pass(cellOf(this.map, u.x, u.y))) {
      u.x = nx;
      u.y = ny;
    } else {
      // Blocked: slide along or re-path.
      const cx = cellOf(this.map, nx, u.y);
      const cy = cellOf(this.map, u.x, ny);
      if (pass(cx)) u.x = nx;
      else if (pass(cy)) u.y = ny;
      else u.speed *= 0.3;
      u.repathAt = 0;
      if (u.pathGoal) {
        const g = u.pathGoal;
        u.path = null;
        u.pathGoal = null;
        this.navTo(u, g.x, g.y);
      }
    }
  }

  private separate() {
    const list: Unit[] = [];
    for (const u of this.units.values()) if (this.inWorld(u) && UNITS[u.type].domain !== 'air' && u.type !== 'lander') list.push(u);
    // Spatial hash.
    const cell = 1;
    const grid = new Map<number, Unit[]>();
    for (const u of list) {
      const k = Math.floor(u.x / cell) * 1000 + Math.floor(u.y / cell);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(u);
    }
    for (const u of list) {
      const gx = Math.floor(u.x / cell);
      const gy = Math.floor(u.y / cell);
      const domA = UNITS[u.type].domain;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const a = grid.get((gx + dx) * 1000 + gy + dy);
          if (!a) continue;
          for (const o of a) {
            if (o.id <= u.id) continue;
            const domB = UNITS[o.type].domain;
            const landA = domA === 'land';
            if (landA !== (domB === 'land')) continue;
            const min = landA ? 0.32 : domA === 'sub' || domB === 'sub' ? 0.25 : 0.5;
            let ddx = o.x - u.x;
            let ddy = o.y - u.y;
            let d = Math.hypot(ddx, ddy);
            if (d >= min) continue;
            if (d < 1e-4) {
              ddx = Math.cos(u.id);
              ddy = Math.sin(u.id);
              d = 1;
            }
            const push = (min - d) * 0.25;
            const px = (ddx / d) * push;
            const py = (ddy / d) * push;
            const pu = this.passFor(u);
            const po = this.passFor(o);
            if (pu(cellOf(this.map, u.x - px, u.y - py))) {
              u.x -= px;
              u.y -= py;
            }
            if (po(cellOf(this.map, o.x + px, o.y + py))) {
              o.x += px;
              o.y += py;
            }
          }
        }
    }
  }

  // ------------------------------------------------------------------ combat

  private maxRangeVs(u: Unit, cls: TargetClass): number {
    let r = 0;
    for (const w of u.weapons) {
      if ((w.ammo > 0 || w.max < 0) && w.mod.dmg && (w.mod.dmg[cls] ?? 0) > 1 && !w.mod.ability) r = Math.max(r, w.mod.range ?? 0);
    }
    return r;
  }

  /** Longest range at which one of u's weapons can engage this contact right now (0 = none). */
  private engageRange(u: Unit, t: Unit, k: Contact): number {
    const cls = this.dmgClass(t);
    let r = 0;
    if (k.lost) return 0;
    for (const w of u.weapons) {
      if (w.mod.ability || (w.max >= 0 && w.ammo < 1) || (w.mod.dmg?.[cls] ?? 0) <= 1) continue;
      // Same rule as pickTarget: a firm track, or a seeker that can find the fuzzy one.
      const ok = k.ident === 2 || (!!w.mod.seeker && k.r <= w.mod.seeker);
      if (!ok) continue;
      // Torpedoes need open water to the target.
      if (w.mod.proj === 'torpedo' && !lineClear(this.map, u.x, u.y, k.x, k.y, (c) => this.map.nav[c] !== 1)) continue;
      r = Math.max(r, w.mod.range ?? 0);
    }
    return r;
  }

  /** Ground attack-move stops only for a close fight on the same island (not for long-range launchers). */
  private hasTargetInRange(u: Unit): boolean {
    const know = this.knowledge.get(u.team)!;
    const isl = islandAt(this.map, u.x, u.y);
    for (const [id, k] of know) {
      if (k.ident < 2) continue;
      const t = this.units.get(id);
      if (!t || !this.inWorld(t)) continue;
      const near = t.type === 'lander' || (UNITS[t.type].domain === 'land' && islandAt(this.map, t.x, t.y) === isl);
      if (!near) continue;
      const r = Math.min(6, this.maxRangeVs(u, this.dmgClass(t)));
      if (r > 0 && Math.hypot(t.x - u.x, t.y - u.y) <= r) return true;
    }
    return false;
  }

  private updateWeapons(dt: number) {
    // Hostile missiles currently visible to each team (for interception).
    const shooters: { x: number; y: number; alt: number; team: number; owner: number; weapons: Weapon[]; unit: Unit | null; dmgMul: number }[] = [];
    for (const u of this.units.values()) {
      if (!this.inWorld(u) || !u.weapons.length) continue;
      if (u.landed) continue;
      shooters.push({ x: u.x, y: u.y, alt: u.alt, team: u.team, owner: u.owner, weapons: u.weapons, unit: u, dmgMul: FACTION_MOD[this.players[u.owner].faction].dmg });
    }
    for (const s of this.sites) {
      if (s.owner < 0 || !s.weapons.length) continue;
      for (const w of s.weapons) if (w.mod.regen && w.ammo < w.max) w.ammo = Math.min(w.max, w.ammo + w.mod.regen * dt * 2);
      shooters.push({ x: s.x, y: s.y, alt: 0.05, team: this.team(s.owner), owner: s.owner, weapons: s.weapons, unit: null, dmgMul: 1 });
    }
    for (const sh of shooters) {
      const sys = sh.unit?.sys;
      for (let wi = 0; wi < sh.weapons.length; wi++) {
        const w = sh.weapons[wi];
        if (w.cd > 0) w.cd -= dt;
        if (w.cd > 0 || w.mod.ability) continue;
        // Stunned crews hold fire; a knocked-out mount is silent until repaired.
        if (sys && (sys.stun > 0 || sys.weaponOut === wi)) continue;
        if (w.max >= 0 && w.ammo < 1) continue;
        // Interceptors first.
        if (w.mod.intercept) {
          const m = this.pickMissileTarget(sh, w);
          if (m) {
            this.fireAtMissile(sh, w, m);
            continue;
          }
        }
        const t = this.pickTarget(sh, w);
        if (t) this.fire(sh, w, t.unit, t.x, t.y, t.exact);
      }
    }
  }

  /** Live SAMs homing on a target (unit id, or -2-projId for a missile). */
  private samsAt(target: number): number {
    let n = 0;
    for (const q of this.projs) if (!q.dead && q.kind === 'sam' && q.target === target) n++;
    return n;
  }

  private pickMissileTarget(sh: { x: number; y: number; team: number }, w: Weapon): Projectile | null {
    const range = w.mod.range ?? 0;
    let best: Projectile | null = null;
    let bd = 1e9;
    for (const p of this.projs) {
      if (p.dead || p.kind !== 'missile' || p.team === sh.team) continue;
      const d = Math.hypot(p.x - sh.x, p.y - sh.y);
      if (d > range) continue;
      // Only engage missiles heading for something of ours.
      const tgt = this.units.get(p.target);
      const threat = tgt ? tgt.team === sh.team : Math.hypot(p.tx - sh.x, p.ty - sh.y) < 12;
      if (!threat) continue;
      // Never more than two SAMs in flight at one missile; if both miss, fire again.
      if (w.mod.proj === 'sam' && this.samsAt(-2 - p.id) >= 2) continue;
      // Most urgent first: the missile closest to hitting its target (not merely closest to
      // this launcher, which may be passing by on its way to another ship).
      const urgency = tgt ? Math.hypot(tgt.x - p.x, tgt.y - p.y) : Math.hypot(p.tx - p.x, p.ty - p.y);
      if (urgency < bd) {
        bd = urgency;
        best = p;
      }
    }
    return best;
  }

  private fireAtMissile(sh: { x: number; y: number; alt: number; team: number; owner: number; unit: Unit | null; dmgMul: number }, w: Weapon, m: Projectile) {
    w.cd = w.mod.cooldown ?? 1;
    if (w.max >= 0) w.ammo--;
    if (sh.unit) sh.unit.firingUntil = this.time + 1;
    if (w.mod.proj === 'bullet') {
      this.emit({ k: 'fire', id: sh.unit?.id ?? 0, m: w.mod.id, x: sh.x, y: sh.y, tx: m.x, ty: m.y, a: m.alt }, sh.x, sh.y);
      if (this.rng.next() < (w.mod.intercept ?? 0)) {
        m.dead = true;
        this.emit({ k: 'intercept', x: m.x, y: m.y, a: m.alt }, m.x, m.y);
      }
      return;
    }
    this.launchProj(sh, w, -2 - m.id, m.x, m.y);
  }

  private pickTarget(sh: { x: number; y: number; team: number; unit: Unit | null }, w: Weapon): { unit: Unit; x: number; y: number; exact: boolean } | null {
    const know = this.knowledge.get(sh.team);
    if (!know) return null;
    const range = w.mod.range ?? 0;
    const dmg = w.mod.dmg ?? {};
    const forced = sh.unit?.order.k === 'attack' ? sh.unit.order.target : -1;
    let best: { unit: Unit; x: number; y: number; exact: boolean } | null = null;
    let bs = 1e9;
    for (const [id, k] of know) {
      const t = this.units.get(id);
      if (!t || !this.inWorld(t)) continue;
      const cls = this.dmgClass(t);
      const dv = dmg[cls] ?? 0;
      if (dv <= 1) continue;
      if (t.landed) continue;
      if (k.lost) continue;
      const exact = k.ident === 2;
      // Never fire blind: fuzzy contacts must be classified (identified as a hostile type)
      // and within reach of the weapon's seeker. Unidentified contacts cannot be targeted.
      if (!exact && !(w.mod.seeker && k.r <= w.mod.seeker && k.ident >= 1)) continue;
      const tx = exact ? t.x : k.x;
      const ty = exact ? t.y : k.y;
      const d = Math.hypot(tx - sh.x, ty - sh.y);
      if (d > range) continue;
      // Torpedoes need open water all the way.
      if (w.mod.proj === 'torpedo' && !lineClear(this.map, sh.x, sh.y, tx, ty, (c) => this.map.nav[c] !== 1)) continue;
      // Never more than two SAMs (or air-to-air missiles) in flight at one aircraft.
      if (w.mod.proj === 'sam' && this.samsAt(id) >= 2) continue;
      // Don't waste limited, slow munitions on a target that is already as good as dead.
      // Guns are not held back: their rounds are free and arrive in seconds.
      if (OVERKILL_CHECK.has(w.mod.proj!) && t.pendingDmg >= t.hp * 1.2) continue;
      // Ground small arms only fight on the same island.
      if (sh.unit && UNITS[sh.unit.type].domain === 'land' && cls === 'land' && islandAt(this.map, t.x, t.y) !== islandAt(this.map, sh.x, sh.y)) continue;
      let score = d / range;
      if (id === forced) score -= 10;
      if (t.type === 'lander') score -= 0.3;
      if (t.type === 'merchant') score += 0.2;
      score -= dv / 100;
      if (score < bs) {
        bs = score;
        best = { unit: t, x: tx, y: ty, exact };
      }
    }
    return best;
  }

  private fire(sh: { x: number; y: number; alt: number; team: number; owner: number; unit: Unit | null; dmgMul: number }, w: Weapon, t: Unit, tx: number, ty: number, exact: boolean) {
    w.cd = (w.mod.cooldown ?? 1) * (0.9 + this.rng.next() * 0.2);
    if (w.max >= 0) w.ammo--;
    const u = sh.unit;
    if (u) {
      u.firingUntil = this.time + 1.5;
      if (u.type === 'sub') u.revealUntil = this.time + (w.mod.proj === 'missile' ? 20 : 8);
    }
    const cls = this.dmgClass(t);
    const dmg = (w.mod.dmg?.[cls] ?? 0) * sh.dmgMul;
    if (w.mod.proj === 'bullet') {
      this.emit({ k: 'fire', id: u?.id ?? 0, m: w.mod.id, x: sh.x, y: sh.y, tx: t.x, ty: t.y, a: t.alt }, sh.x, sh.y);
      const acc = (w.mod.accuracy ?? 0.5) * (cls === 'air' ? 0.6 : 1);
      if (this.rng.next() < acc) this.damage(t, dmg, sh.owner, 'bullet');
      return;
    }
    // Lead the target for shells.
    let ax = tx;
    let ay = ty;
    if (w.mod.proj === 'shell' || w.mod.proj === 'bomb') {
      const d = Math.hypot(tx - sh.x, ty - sh.y);
      const tt = d / (w.mod.speed ?? 2);
      ax += Math.cos(t.heading) * t.speed * tt;
      ay += Math.sin(t.heading) * t.speed * tt;
    }
    const p = this.launchProj(sh, w, exact ? t.id : -1, ax, ay);
    if (exact || w.mod.proj === 'missile' || w.mod.proj === 'sam') p.target = t.id;
    p.seeking = !exact;
    p.dmgMul = sh.dmgMul;
    if (OVERKILL_CHECK.has(w.mod.proj!)) {
      const resv = dmg * (w.mod.accuracy ?? 0.7);
      t.pendingDmg += resv;
      p.resv = { id: t.id, dmg: resv };
    }
  }

  private launchProj(sh: { x: number; y: number; alt: number; team: number; owner: number; unit: Unit | null }, w: Weapon, target: number, tx: number, ty: number): Projectile {
    const kind = w.mod.proj!;
    const d = Math.hypot(tx - sh.x, ty - sh.y);
    const speed = w.mod.speed ?? 2;
    const p: Projectile = {
      id: this.nextId++,
      kind,
      mod: w.mod,
      owner: sh.owner,
      team: sh.team,
      x: sh.x,
      y: sh.y,
      alt: Math.max(0.02, sh.alt),
      heading: Math.atan2(ty - sh.y, tx - sh.x),
      speed,
      target,
      tx,
      ty,
      t: 0,
      life: kind === 'shell' || kind === 'bomb' ? d / speed : ((w.mod.range ?? 10) * (kind === 'sam' ? 1.25 : 1.6)) / speed + (kind === 'sam' ? 2 : 4),
      dmgMul: 1,
      hitChance: w.mod.accuracy ?? 0.7,
      sx: sh.x,
      sy: sh.y,
      dead: false,
      seeking: false,
      hostileSeen: false,
    };
    if (kind === 'missile') {
      if (!sh.unit || UNITS[sh.unit.type].domain !== 'air') p.alt = Math.max(0.05, heightAt(this.map, sh.x, sh.y) + 0.03);
      p.arc = { a0: p.alt, apex: this.arcApex(p.alt, sh.x, sh.y, tx, ty), flown: 0, f: 0 };
    }
    this.projs.push(p);
    this.emit({ k: 'fire', id: sh.unit?.id ?? 0, m: w.mod.id, x: sh.x, y: sh.y, tx, ty, a: sh.alt }, sh.x, sh.y);
    return p;
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projs) {
      if (p.dead) continue;
      p.t += dt;
      if (p.kind === 'shell' || p.kind === 'bomb') {
        const f = Math.min(1, p.t / p.life);
        p.x = p.sx + (p.tx - p.sx) * f;
        p.y = p.sy + (p.ty - p.sy) * f;
        const d = Math.hypot(p.tx - p.sx, p.ty - p.sy);
        p.alt = Math.sin(f * Math.PI) * Math.min(3, d * 0.12) + (p.kind === 'bomb' ? (1 - f) * 0.9 : 0);
        if (f >= 1) this.resolveImpact(p);
        continue;
      }
      // Guided projectiles.
      let gx = p.tx;
      let gy = p.ty;
      let galt = 0.02;
      if (p.target <= -2) {
        const m = this.projs.find((q) => q.id === -2 - p.target);
        if (!m || m.dead) {
          p.target = -1;
        } else {
          const tt = Math.hypot(m.x - p.x, m.y - p.y) / p.speed;
          gx = m.x + Math.cos(m.heading) * m.speed * tt;
          gy = m.y + Math.sin(m.heading) * m.speed * tt;
          galt = m.alt;
        }
      } else if (p.target >= 0) {
        const t = this.units.get(p.target);
        if (!t || t.dead || t.inside >= 0) {
          p.target = -1;
        } else {
          const close = Math.hypot(t.x - p.x, t.y - p.y);
          const seekR = p.mod.seeker ?? 99;
          if (!p.seeking || close < seekR) {
            p.seeking = false;
            // Aim at the predicted intercept point.
            const tt = close / p.speed;
            gx = t.x + Math.cos(t.heading) * t.speed * tt;
            gy = t.y + Math.sin(t.heading) * t.speed * tt;
            galt = t.alt;
          }
        }
      }
      const want = Math.atan2(gy - p.y, gx - p.x);
      const turn = p.kind === 'torpedo' ? 0.8 : p.kind === 'sam' ? 6 : 2.5;
      p.heading = turnToward(p.heading, want, turn * dt);
      p.x += Math.cos(p.heading) * p.speed * dt;
      p.y += Math.sin(p.heading) * p.speed * dt;
      const dist = Math.hypot(gx - p.x, gy - p.y);
      if (p.kind === 'missile') {
        // One smooth arc from launch to target: progress f is the share of the path flown so
        // far (it adapts when the target moves or the seeker re-aims).
        const arc = p.arc ?? (p.arc = { a0: p.alt, apex: 0.3, flown: 0, f: 0 });
        arc.flown += p.speed * dt;
        // Progress only moves forward (a target that runs away must not make the arc climb again).
        arc.f = Math.max(arc.f, Math.min(1, arc.flown / (arc.flown + dist)));
        const f = arc.f;
        let want = arc.a0 * (1 - f) + galt * f + Math.sin(Math.PI * f) * arc.apex;
        // Soft clearance: if the real path bends over a hill the straight-line apex missed, rise
        // early and gently (look 2 km ahead) instead of popping up at the slope.
        if (f < 0.9) {
          const c = Math.cos(p.heading);
          const s = Math.sin(p.heading);
          let hi = 0;
          for (let k = 0; k <= 4; k++) hi = Math.max(hi, heightAt(this.map, p.x + c * k * 0.5, p.y + s * k * 0.5));
          want = Math.max(want, hi + 0.1);
        }
        p.alt += (want - p.alt) * Math.min(1, dt * 2.5);
        // Hard floor, last resort only.
        p.alt = Math.max(p.alt, Math.max(0, heightAt(this.map, p.x, p.y)) + 0.02);
      } else if (p.kind === 'sam') {
        // Boost straight up out of the launcher, then climb to the target.
        if (p.t < 0.6) p.alt += dt * 0.8;
        else p.alt += (galt - p.alt) * Math.min(1, dt * 3);
        // Missed and flying away: self-destruct instead of circling.
        if (p.target !== -1) {
          if (dist < (p.best ?? 1e9)) p.best = dist;
          else if ((p.best ?? 1e9) < 0.8 && dist > (p.best ?? 0) + 0.3) {
            p.dead = true;
            this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.15, w: false, a: p.alt }, p.x, p.y);
            continue;
          }
        }
      } else if (p.kind === 'torpedo') {
        p.alt = -0.03;
        if (heightAt(this.map, p.x, p.y) > -0.01) {
          p.dead = true;
          this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.4, w: false }, p.x, p.y);
          continue;
        }
      }
      // A SAM whose target is gone self-destructs; it never picks a new one (that is how
      // three, four or more SAMs ended up chasing the same aircraft).
      if (p.kind === 'sam' && p.target === -1) {
        p.dead = true;
        this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.12, w: false, a: p.alt }, p.x, p.y);
        continue;
      }
      // Seeker search when arriving at an aim point without a lock (the fuzzy track was off,
      // or the target slipped away): look around, lock on to whatever is there, or give up.
      if ((p.target === -1 || (p.kind !== 'sam' && p.seeking)) && dist < 0.4) {
        const found = this.seekerSearch(p);
        if (found) {
          p.target = found.id;
          p.seeking = false;
          continue; // steer at it from the next tick on
        }
        p.dead = true;
        if (p.kind !== 'sam') this.fizzle(p);
        continue;
      }
      if (dist < (p.kind === 'torpedo' ? 0.12 : 0.15) && p.target !== -1) {
        this.resolveImpact(p);
        continue;
      }
      if (p.t > p.life) {
        p.dead = true;
        if (p.kind === 'missile' || p.kind === 'torpedo') this.fizzle(p);
      }
    }
  }

  /** A weapon that found nothing: missiles self-destruct in the air over land, others drop in the sea. */
  private fizzle(p: Projectile) {
    if (p.kind === 'missile' && heightAt(this.map, p.x, p.y) > -0.005) this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.15, w: false, a: Math.max(p.alt, 0.12) }, p.x, p.y);
    else this.emit({ k: 'splash', x: p.x, y: p.y }, p.x, p.y);
  }

  private seekerSearch(p: Projectile): Unit | null {
    const r = p.mod.seeker ?? 3;
    let best: Unit | null = null;
    let bd = r;
    for (const u of this.units.values()) {
      if (!this.inWorld(u) || u.team === p.team) continue;
      const cls = this.dmgClass(u);
      if ((p.mod.dmg?.[cls] ?? 0) <= 1) continue;
      const d = Math.hypot(u.x - p.x, u.y - p.y);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  private resolveImpact(p: Projectile) {
    p.dead = true;
    if (p.target <= -2) {
      const m = this.projs.find((q) => q.id === -2 - p.target);
      if (m && !m.dead && this.rng.next() < (p.mod.intercept ?? 0.5)) {
        m.dead = true;
        this.emit({ k: 'intercept', x: m.x, y: m.y, a: m.alt }, m.x, m.y);
      } else this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.2, w: false, a: p.alt }, p.x, p.y);
      return;
    }
    let t = p.target >= 0 ? this.units.get(p.target) : undefined;
    if (p.kind === 'shell' || p.kind === 'bomb') {
      // Area check around impact point.
      t = undefined;
      let bd = 0.35;
      for (const u of this.units.values()) {
        if (!this.inWorld(u) || u.team === p.team || UNITS[u.type].domain === 'air' || UNITS[u.type].domain === 'sub') continue;
        const d = Math.hypot(u.x - p.x, u.y - p.y);
        if (d < bd) {
          bd = d;
          t = u;
        }
      }
    }
    const water = heightAt(this.map, p.x, p.y) < 0;
    if (!t || t.dead) {
      if (water) this.emit({ k: 'splash', x: p.x, y: p.y }, p.x, p.y);
      else this.emit({ k: 'boom', x: p.x, y: p.y, s: 0.3, w: false }, p.x, p.y);
      return;
    }
    const cls = this.dmgClass(t);
    const dmg = (p.mod.dmg?.[cls] ?? 0) * p.dmgMul;
    let chance = p.kind === 'shell' ? p.hitChance * (0.75 + 0.25 * (1 - Math.min(1, t.speed / 0.35))) + 0.2 : p.hitChance;
    if (p.kind === 'missile') chance *= 1 - t.ecm;
    if (p.kind === 'sam' && cls === 'air') chance *= 1 - t.ecm * 0.5;
    const w = this.weatherAt(t.x, t.y);
    chance *= 1 - 0.25 * w.storm;
    if (this.rng.next() < chance) {
      this.damage(t, dmg, p.owner, p.kind);
      this.emit({ k: 'boom', x: t.x, y: t.y, s: Math.min(1.5, dmg / 30), w: false, a: t.alt }, t.x, t.y);
    } else {
      const [ox, oy] = this.rng.inDisc(0.25);
      if (cls === 'air') this.emit({ k: 'boom', x: t.x + ox, y: t.y + oy, s: 0.2, w: false, a: t.alt }, t.x, t.y);
      else if (water) this.emit({ k: 'splash', x: t.x + ox, y: t.y + oy }, t.x, t.y);
      else this.emit({ k: 'boom', x: t.x + ox, y: t.y + oy, s: 0.3, w: false }, t.x, t.y);
    }
  }

  damage(t: Unit, dmg: number, by: number, src?: string) {
    if (t.dead) return;
    let d = dmg;
    if (UNITS[t.type].domain === 'land' && t.stillFor > 4) d *= t.entrench;
    t.hp -= d;
    if (by >= 0) t.lastHitBy = by;
    if (t.hp <= 0) {
      this.kill(t, by);
      return;
    }
    const dom = UNITS[t.type].domain;
    if (src && (dom === 'sea' || dom === 'sub') && t.type !== 'lander') this.rollCrits(t, d, src);
  }

  /**
   * WARNO-style critical hits on ships. Any heavy hit stuns the crew for a moment; beyond that a
   * hit may knock out one system (two for a really big hit), chosen by what struck the ship.
   */
  private rollCrits(t: Unit, d: number, src: string) {
    const f = d / t.maxHp;
    const s = t.sys;
    if (f >= 0.1) {
      const stun = Math.min(CRIT.stunMax, 1.5 + f * 25);
      if (stun > s.stun + 1) this.crit(t, 'stun');
      s.stun = Math.max(s.stun, stun);
    }
    const table = CRIT_TABLE[src] ?? CRIT_TABLE.bullet;
    const rolls = f > 0.35 ? 2 : 1;
    for (let r = 0; r < rolls; r++) {
      if (this.rng.next() > Math.min(0.75, 0.1 + f * 1.8)) continue;
      let sum = 0;
      for (const [, w] of table) sum += w;
      let pick = this.rng.next() * sum;
      let part: CritPart = table[0][0];
      for (const [p, w] of table) {
        pick -= w;
        if (pick <= 0) {
          part = p;
          break;
        }
      }
      this.applyCrit(t, part);
    }
  }

  private applyCrit(t: Unit, part: CritPart) {
    const s = t.sys;
    switch (part) {
      case 'engine':
        s.engine = CRIT.engineStop + CRIT.engineSlow;
        break;
      case 'rudder':
        s.rudder = CRIT.rudder;
        break;
      case 'radar':
        s.radar = CRIT.radar;
        break;
      case 'fire':
        s.fire = Math.max(s.fire, CRIT.fire);
        break;
      case 'flood':
        s.flood = Math.max(s.flood, CRIT.flood);
        break;
      case 'stun':
        s.stun = Math.max(s.stun, 3 + this.rng.next() * 2);
        break;
      case 'weapon': {
        const usable = t.weapons.map((w, i) => (w.mod.ability ? -1 : i)).filter((i) => i >= 0);
        if (!usable.length) return;
        s.weaponOut = usable[Math.floor(this.rng.next() * usable.length)];
        s.weaponT = CRIT.weapon;
        this.crit(t, part, t.weapons[s.weaponOut].mod.name);
        return;
      }
    }
    this.crit(t, part);
  }

  private crit(t: Unit, part: CritPart, m?: string) {
    this.emit({ k: 'crit', id: t.id, part, o: t.owner, ...(m ? { m } : {}) }, t.x, t.y);
  }

  /** System timers tick down (3x faster alongside a friendly naval base); fire and flooding hurt. */
  private updateSystems(u: Unit, dt: number) {
    const s = u.sys;
    const k = s.dockedUntil > this.time ? 3 : 1;
    const down = (v: number) => Math.max(0, v - dt * k);
    s.engine = down(s.engine);
    s.rudder = down(s.rudder);
    s.radar = down(s.radar);
    s.stun = Math.max(0, s.stun - dt);
    s.weaponT = down(s.weaponT);
    if (s.weaponT <= 0) s.weaponOut = -1;
    if (s.fire > 0) {
      s.fire = down(s.fire);
      u.hp -= CRIT.fireDps * dt;
    }
    if (s.flood > 0) {
      s.flood = down(s.flood);
      u.hp -= CRIT.floodDps * dt;
    }
    if (u.hp <= 0) this.kill(u, u.lastHitBy);
  }

  /** Speed multiplier from engine and flooding damage (0 = dead in the water). */
  speedFactor(u: Unit): number {
    const s = u.sys;
    let f = s.engine > CRIT.engineSlow ? 0 : s.engine > 0 ? 0.55 : 1;
    if (s.flood > 0) f *= 0.7;
    return f;
  }

  private sysFlags(u: Unit): number {
    const s = u.sys;
    return (s.fire > 0 ? F_FIRE : 0) | (this.speedFactor(u) === 0 ? F_STOPPED : 0) | (s.stun > 0 ? F_STUN : 0);
  }

  damageRow(u: Unit): DamageRow {
    const s = u.sys;
    const r = (v: number) => Math.ceil(v);
    return [r(s.engine), r(s.rudder), r(s.radar), r(s.fire), r(s.flood), r(s.stun), s.weaponOut, r(s.weaponT)];
  }

  kill(t: Unit, by: number) {
    if (t.dead) return;
    t.dead = true;
    t.hp = 0;
    const owner = this.players[t.owner];
    if (t.type !== 'merchant' && t.type !== 'lander') owner.losses++;
    if (by >= 0 && by !== t.owner && t.type !== 'lander') this.players[by].kills++;
    for (const cid of t.cargo) {
      const c = this.units.get(cid);
      if (c) {
        c.dead = true;
        owner.losses++;
      }
    }
    t.cargo = [];
    this.emit({ k: 'kill', id: t.id, ty: UNIT_TYPES.indexOf(t.type), x: t.x, y: t.y, o: t.owner, h: t.heading }, t.x, t.y);
  }

  private updateMines() {
    if (!this.mines.length) return;
    for (const m of this.mines) {
      if (this.time < m.armAt) continue;
      for (const u of this.units.values()) {
        if (!this.inWorld(u) || u.team === m.team) continue;
        const dom = UNITS[u.type].domain;
        if (dom !== 'sea' && dom !== 'sub') continue;
        if (Math.hypot(u.x - m.x, u.y - m.y) < 0.45) {
          m.armAt = Infinity;
          const dmg = dom === 'sub' ? 40 : 50;
          this.damage(u, dmg, m.owner, 'mine');
          this.emit({ k: 'boom', x: m.x, y: m.y, s: 1.2, w: true }, m.x, m.y);
          break;
        }
      }
    }
    this.mines = this.mines.filter((m) => m.armAt !== Infinity);
  }

  // ------------------------------------------------------------------ capture

  private updateCapture(dt: number) {
    for (const s of this.sites) {
      const byTeam = new Map<number, { n: number; pid: number }>();
      for (const u of this.units.values()) {
        if (!this.inWorld(u) || UNITS[u.type].domain !== 'land') continue;
        if (Math.hypot(u.x - s.x, u.y - s.y) > CAPTURE_RADIUS) continue;
        const e = byTeam.get(u.team);
        if (e) e.n++;
        else byTeam.set(u.team, { n: 1, pid: u.owner });
      }
      const ownerTeam = this.team(s.owner);
      const prevCap = s.cap;
      if (byTeam.size === 1) {
        const [team, info] = [...byTeam.entries()][0];
        if (team !== ownerTeam) {
          if (s.capBy >= 0 && this.team(s.capBy) !== team) {
            s.cap = Math.max(0, s.cap - dt / 4);
            if (s.cap === 0) s.capBy = info.pid;
          } else {
            s.capBy = info.pid;
            const time = BUILDINGS[s.type].captureTime * (s.owner >= 0 ? 1.4 : 1);
            s.cap += (dt / time) * Math.sqrt(Math.min(info.n, 4));
          }
          if (s.cap >= 1) this.setSiteOwner(s, s.capBy);
        } else {
          s.cap = Math.max(0, s.cap - dt / 3);
        }
      } else if (byTeam.size === 0) {
        s.cap = Math.max(0, s.cap - dt / 10);
      }
      if (s.cap === 0) s.capBy = -1;
      if (Math.abs(prevCap - s.cap) > 0.01) this.sitesDirty = true;
    }
  }

  private setSiteOwner(s: SiteState, pid: number) {
    const prev = s.owner;
    s.owner = pid;
    s.cap = 0;
    s.capBy = -1;
    s.merchantCd = 3;
    for (const w of s.weapons) w.ammo = w.max;
    this.sitesDirty = true;
    this.emit({ k: 'capture', site: s.id, o: pid, prev }, s.x, s.y);
    if (s.type === 'hq' && prev >= 0) this.defeat(prev);
  }

  private defeat(pid: number) {
    const p = this.players[pid];
    if (p.defeated) return;
    p.defeated = true;
    for (const u of this.units.values()) if (u.owner === pid && !u.dead) this.kill(u, -1);
    for (const s of this.sites) if (s.owner === pid) s.owner = -1;
    p.queues = { naval: [], ground: [], air: [] };
    this.sitesDirty = true;
    this.emit({ k: 'defeat', o: pid }, 0, 0);
  }

  private checkVictory() {
    const res = this.sites.filter((s) => s.type === 'resource');
    const alive = new Set<number>();
    for (const p of this.players) if (!p.defeated) alive.add(p.team);
    for (const p of this.players) {
      if (p.defeated) continue;
      const teamRes = res.filter((s) => s.owner >= 0 && this.team(s.owner) === p.team).length;
      if (teamRes >= res.length * DOMINATION_SHARE) p.dom += 1;
      else p.dom = 0;
      if (p.dom >= DOMINATION_TIME) {
        this.over = true;
        this.winnerTeam = p.team;
        return;
      }
    }
    if (alive.size <= 1 && this.players.length > 1) {
      this.over = true;
      this.winnerTeam = alive.size ? [...alive][0] : -1;
    }
    // A player with no HQ (e.g. lost while offline) is defeated.
    for (const p of this.players) {
      if (p.defeated) continue;
      if (!this.sites.some((s) => s.type === 'hq' && s.owner === p.id)) this.defeat(p.id);
    }
  }

  // ------------------------------------------------------------------ detection

  updateDetection(force: boolean) {
    const teams = new Set(this.players.filter((p) => !p.defeated).map((p) => p.team));
    for (const team of teams) {
      const know = this.knowledge.get(team)!;
      const sensors: { x: number; y: number; air: number; surf: number; sonar: number; vis: number; isUnit: boolean }[] = [];
      for (const u of this.units.values()) {
        if (!this.inWorld(u) || u.team !== team) continue;
        const dom = UNITS[u.type].domain;
        sensors.push({
          x: u.x,
          y: u.y,
          air: u.landed ? 0 : u.radarAir * (u.sys.radar > 0 ? 0.35 : 1),
          surf: u.landed ? 0 : u.radarSurf * (u.sys.radar > 0 ? 0.35 : 1),
          sonar: dom === 'sea' || dom === 'sub' || dom === 'air' ? u.sonar : 0,
          vis: u.visual,
          isUnit: true,
        });
      }
      for (const s of this.sites) {
        if (s.owner < 0 || this.team(s.owner) !== team) continue;
        const b = BUILDINGS[s.type];
        sensors.push({ x: s.x, y: s.y, air: b.radarAir, surf: b.radarSurf, sonar: 0, vis: b.visual, isUnit: false });
      }
      // Which sites can this team see right now?
      const intel = this.siteIntel.get(team);
      if (intel) {
        this.sites.forEach((st, i) => {
          let watched = st.owner >= 0 && this.team(st.owner) === team;
          for (const sn of sensors) {
            if (watched) break;
            const d = Math.hypot(sn.x - st.x, sn.y - st.y);
            if (d < Math.max(sn.vis * 1.5, sn.surf * 0.8)) watched = true;
          }
          intel.watched[i] = watched ? 1 : 0;
          if (watched) intel.owner[i] = st.owner;
        });
      }
      const seen = new Set<number>();
      for (const e of this.units.values()) {
        if (!this.inWorld(e) || e.team === team) continue;
        const dom = UNITS[e.type].domain;
        const w = this.weatherAt(e.x, e.y);
        const visMul = (1 - 0.7 * w.storm) * (1 - 0.65 * w.fog);
        const radMul = (1 - 0.45 * w.storm) * (1 - 0.1 * w.fog);
        let q = 0;
        let exact = false;
        let viaSonar = false;
        for (const s of sensors) {
          const d = Math.hypot(s.x - e.x, s.y - e.y);
          if (d > 70) continue;
          if (dom !== 'sub' && d < s.vis * visMul) {
            exact = true;
            break;
          }
          let R = 0;
          if (dom === 'air') R = s.air * radMul;
          else if (dom === 'sea') R = s.surf * radMul * Math.sqrt(UNITS[e.type].signature);
          else if (dom === 'land') R = s.surf * radMul * 0.45;
          else if (dom === 'sub') {
            R = s.sonar * e.quiet * (e.speed > e.maxSpeed * 0.7 ? 1.4 : 1);
            if (d < R * 0.35) {
              exact = true;
              break;
            }
          }
          if (d < R) {
            const qq = 1 - d / R;
            if (qq > q) {
              q = qq;
              viaSonar = dom === 'sub';
            }
          }
        }
        if (!exact && e.revealUntil > this.time) {
          // Launch transients: everybody nearby hears it.
          for (const s of sensors) {
            if (s.isUnit && Math.hypot(s.x - e.x, s.y - e.y) < 25) {
              q = Math.max(q, 0.45);
              break;
            }
          }
        }
        if (!exact && q <= 0) continue;
        seen.add(e.id);
        let rec = know.get(e.id);
        if (!rec) {
          const [ox, oy] = this.rng.inDisc(1);
          rec = { x: e.x, y: e.y, r: 99, q: 0, ident: 0, ox, oy, lost: false, seen: this.time };
          know.set(e.id, rec);
        }
        rec.lost = false;
        rec.seen = this.time;
        if (exact) {
          rec.x = e.x;
          rec.y = e.y;
          rec.r = 0;
          rec.q = 1;
          rec.ident = 2;
          continue;
        }
        const maxErr = viaSonar ? 3 : dom === 'air' ? 4 : 5;
        const err = maxErr * Math.pow(1 - q, 1.4) * (1 + w.storm * 1.2);
        // The error radius eases toward the new value; the marker keeps its offset, so it glides.
        rec.r = rec.r > 50 || force ? err : rec.r + (err - rec.r) * 0.35;
        if (rec.r < 0.45) rec.r = 0;
        rec.q = q;
        rec.ident = rec.r === 0 ? 2 : q > 0.4 ? 1 : Math.min(rec.ident, 1) as 0 | 1;
        rec.x = e.x + rec.ox * rec.r;
        rec.y = e.y + rec.oy * rec.r;
      }
      // Brief dropouts keep the track (frozen, not targetable); after 4 s it is lost.
      for (const [id, k] of know) {
        if (seen.has(id)) continue;
        if (this.time - k.seen > 4 || !this.units.get(id) || this.units.get(id)!.dead) {
          know.delete(id);
          continue;
        }
        k.lost = true;
        if (k.ident === 2) {
          k.ident = 1;
          k.r = Math.max(k.r, 1);
        }
      }
    }
    // First-time detection of incoming missiles -> vampire warning.
    for (const p of this.projs) {
      if (p.kind !== 'missile' || p.hostileSeen || p.dead) continue;
      const t = this.units.get(p.target);
      if (t && Math.hypot(t.x - p.x, t.y - p.y) < 18) {
        p.hostileSeen = true;
        this.emit({ k: 'vampire', x: p.x, y: p.y }, p.x, p.y, t.team);
      }
    }
  }

  // ------------------------------------------------------------------ snapshots

  snapshotFor(pid: number, full: boolean): Snapshot {
    const p = this.players[pid];
    const team = p.team;
    const know = this.knowledge.get(team) ?? new Map<number, Contact>();
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const u: UnitRow[] = [];
    const c: ContactRow[] = [];
    const d: DetailRow[] = [];
    // Team assets for event visibility.
    const assets: { x: number; y: number }[] = [];
    for (const x of this.units.values()) {
      if (x.dead) continue;
      if (x.team === team) {
        if (x.inside >= 0 && x.owner !== pid) continue;
        if (x.inside < 0) assets.push({ x: x.x, y: x.y });
        let flags = 0;
        if (x.speed > 0.01) flags |= F_MOVING;
        if (x.firingUntil > this.time) flags |= F_FIRING;
        if (x.retreating) flags |= F_RETREAT;
        if (x.landed) flags |= F_LANDED;
        if (x.cargo.length) flags |= F_CARGO;
        if (x.hp < x.maxHp * 0.5) flags |= F_DAMAGED;
        if (x.type === 'merchant' && x.mstate === 'back') flags |= F_LOADING;
        flags |= this.sysFlags(x);
        if (x.inside < 0) u.push([x.id, UNIT_TYPES.indexOf(x.type), x.owner, r2(x.x), r2(x.y), r2(x.alt), r2(x.heading), Math.ceil((x.hp / x.maxHp) * 100), flags]);
        if (x.owner === pid) {
          const o = x.order;
          const oc = ORDER_CODES.indexOf(x.type === 'merchant' ? 'merchant' : x.type === 'lander' ? 'lander' : o.k);
          const ox = 'x' in o ? r2(o.x) : o.k === 'attack' ? o.target : 0;
          const oy = 'y' in o ? r2(o.y) : 0;
          d.push([
            x.id,
            x.weapons.map((w) => (w.max < 0 ? -1 : Math.floor(w.ammo))),
            x.cargo.slice(),
            x.fuelMax ? Math.round((x.fuel / x.fuelMax) * 100) : 100,
            oc,
            ox,
            oy,
            (x.autoRetreat ? 1 : 0) | (x.inside >= 0 ? 2 : 0),
            UNIT_TYPES.indexOf(x.type),
            ...this.airDetail(x),
            UNITS[x.type].deck ? this.deckIds(x) : [],
            this.damageRow(x),
          ]);
        }
        continue;
      }
      if (x.inside >= 0) continue;
      const k = know.get(x.id);
      if (!k) continue;
      let flags = 0;
      if (x.speed > 0.01) flags |= F_MOVING;
      if (x.firingUntil > this.time) flags |= F_FIRING;
      if (x.landed) flags |= F_LANDED;
      flags |= this.sysFlags(x);
      if (k.ident === 2) {
        u.push([x.id, UNIT_TYPES.indexOf(x.type), x.owner, r2(x.x), r2(x.y), r2(x.alt), r2(x.heading), Math.ceil((x.hp / x.maxHp) * 100), flags]);
      } else {
        const dom = UNITS[x.type].domain;
        const kind = k.ident === 1 ? 10 + UNIT_TYPES.indexOf(x.type) : DOMAIN_IDX[dom];
        c.push([x.id, kind, r2(k.x), r2(k.y), r2(k.r)]);
      }
    }
    for (const s of this.sites) if (s.owner >= 0 && this.team(s.owner) === team) assets.push({ x: s.x, y: s.y });
    const nearAsset = (x: number, y: number, r: number) => {
      for (const a of assets) if (Math.abs(a.x - x) < r && Math.abs(a.y - y) < r) return true;
      return false;
    };
    const pr: ProjRow[] = [];
    for (const q of this.projs) {
      if (q.dead || q.kind === 'bullet') continue;
      const mine = q.team === team;
      if (!mine) {
        if (q.kind === 'torpedo' && !nearAsset(q.x, q.y, 8)) continue;
        if (!nearAsset(q.x, q.y, q.kind === 'shell' ? 14 : 30)) continue;
      }
      // Flags: 1 = ours, 2 = a SAM chasing an aircraft (drawn in the aircraft height frame).
      const airSam = q.kind === 'sam' && q.target >= 0 && UNITS[this.units.get(q.target)?.type ?? 'destroyer'].domain === 'air';
      pr.push([q.id, PROJ_KINDS.indexOf(q.kind), r2(q.x), r2(q.y), r2(q.alt), (mine ? 1 : 0) | (airSam ? 2 : 0)]);
    }
    for (const m of this.mines) if (m.team === team) pr.push([m.id, PROJ_KINDS.indexOf('mine'), r2(m.x), r2(m.y), 0, 1]);
    const e: GameEvent[] = [];
    for (const ev of this.events) {
      if (ev.team >= 0 && ev.team !== team) continue;
      const involved = ev.e.k === 'capture' && (this.team(ev.e.o) === team || this.team(ev.e.prev) === team);
      if (ev.e.k === 'defeat' || ev.e.k === 'lightning' || ev.e.k === 'msg' || involved || nearAsset(ev.x, ev.y, 20)) e.push(ev.e);
    }
    const snap: Snapshot = { t: 's', time: r2(this.time), cash: Math.floor(p.cash), income: r2(p.income), u, c, p: pr, d, e };
    if (this.phase === 'setup') snap.ph = { left: Math.ceil(this.setupLeft), ready: [...this.readySet] };
    if (full || this.sitesDirty || this.tickN % 10 === 0) {
      const intel = this.siteIntel.get(team);
      snap.s = this.sites.map((s, i) => {
        if (!intel || intel.watched[i]) return [s.id, s.owner, Math.round(s.cap * 100), s.capBy] as SiteRow;
        return [s.id, intel.owner[i], 0, -1] as SiteRow;
      });
    }
    if (full || this.tickN % 10 === 0) {
      snap.w = this.weather.map((w) => [w.kind, r2(w.x), r2(w.y), r2(w.r), Math.round(w.i * 100), Math.round(w.vx * 1e4) / 1e4, Math.round(w.vy * 1e4) / 1e4, w.id] as WeatherWire);
      const res = this.sites.filter((s) => s.type === 'resource');
      snap.pl = this.players.map((pp) => ({
        id: pp.id,
        res: res.filter((s) => s.owner === pp.id).length,
        units: [...this.units.values()].filter((x) => x.owner === pp.id && !x.dead && x.type !== 'merchant' && x.type !== 'lander').length,
        defeated: pp.defeated,
        dom: Math.round(pp.dom),
      }));
    }
    snap.q = {
      naval: p.queues.naval.map((i) => ({ type: i.type, progress: Math.min(1, i.t / i.total) }) as QueueItem),
      ground: p.queues.ground.map((i) => ({ type: i.type, progress: Math.min(1, i.t / i.total) }) as QueueItem),
      air: p.queues.air.map((i) => ({ type: i.type, progress: Math.min(1, i.t / i.total) }) as QueueItem),
    };
    const fac = (cat: Cat) => {
      const s = this.factorySite(p, cat);
      return s ? s.id : -1;
    };
    snap.f = { naval: fac('naval'), ground: fac('ground'), air: fac('air') };
    return snap;
  }

  /** Call after all snapshots for this tick were taken. */
  flushEvents() {
    this.events.length = 0;
    this.sitesDirty = false;
  }

  results() {
    return this.players.map((p) => ({ id: p.id, name: p.name, kills: p.kills, losses: p.losses, earned: Math.round(p.earned) }));
  }
}

function mkWeapon(m: ModuleDef): Weapon {
  const ammo = m.ammo ?? -1;
  return { mod: m, ammo, max: ammo, cd: Math.random() * 0.5 };
}

/** A player's deployment zone: a circle around their home island. */
export function deployZone(map: GameMap, slot: number): { x: number; y: number; r: number; island: number } | null {
  const sp = map.spawns[slot];
  if (!sp) return null;
  const isl = map.islands[sp.island];
  return { x: sp.x, y: sp.y, r: (isl?.r ?? 6) + DEPLOY_MARGIN, island: sp.island };
}

/** Where a unit may be placed in the deployment phase: ships on open water, troops on the home island, aircraft anywhere in the zone. */
export function canDeployAt(map: GameMap, slot: number, type: UnitType, x: number, y: number): boolean {
  const z = deployZone(map, slot);
  if (!z || Math.hypot(x - z.x, y - z.y) > z.r) return false;
  if (x < 0.5 || y < 0.5 || x > map.size - 0.5 || y > map.size - 0.5) return false;
  const dom = UNITS[type].domain;
  if (dom === 'air') return true;
  const c = cellOf(map, x, y);
  if (dom === 'land') return map.nav[c] === 1 && map.islandOf[c] === z.island;
  return map.nav[c] === 0;
}

export function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function turnToward(a: number, b: number, max: number): number {
  const d = angDiff(a, b);
  if (Math.abs(d) <= max) return b;
  return a + Math.sign(d) * max;
}

export type { BuildingType };
