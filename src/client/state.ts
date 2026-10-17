// Client-side view of the game: interpolated units, radar contacts with memory, sites, weather.
import { UNIT_TYPES, UNITS, UnitType, Faction, Domain } from '../shared/defs';
import { GameMap, generateMap } from '../shared/map';
import type { DetailRow, GameEvent, QueueItem, Snapshot, StartInfo, WeatherRow } from '../shared/protocol';
import { PROJ_KINDS } from '../shared/protocol';
import { angDiff } from '../shared/game';

export interface UView {
  id: number;
  type: UnitType;
  owner: number;
  x: number;
  y: number;
  alt: number;
  h: number;
  hp: number;
  flags: number;
  p: [number, number, number, number];
  n: [number, number, number, number];
  t0: number;
  t1: number;
  born: number;
  seen: number;
}

export interface CView {
  id: number;
  kind: number;
  /** Displayed estimate; eases toward the latest server estimate (tx, ty, tr). */
  x: number;
  y: number;
  r: number;
  tx: number;
  ty: number;
  tr: number;
  born: number;
  seen: number;
  /** Held only by ESM: we hear its radar, none of our sensors sees it. */
  esm: boolean;
}

export interface Ghost {
  id: number;
  domain: Domain;
  type: UnitType | null;
  x: number;
  y: number;
  r: number;
  t: number;
}

export interface PView {
  id: number;
  kind: string;
  x: number;
  y: number;
  alt: number;
  px: number;
  py: number;
  palt: number;
  mine: boolean;
  /** A SAM chasing an aircraft (drawn in the aircraft height frame, not the missile one). */
  air: boolean;
  /** Altitude at first sight (air-launched missiles blend from the aircraft frame). */
  alt0: number;
  born: number;
  t0: number;
  t1: number;
  rx: number;
  ry: number;
  ralt: number;
}

export interface SiteView {
  id: number;
  owner: number;
  cap: number;
  capBy: number;
}

export const DOMAINS: Domain[] = ['sea', 'sub', 'air', 'land'];
/** Seconds a last-known-position marker stays after a track is lost. */
export const GHOST_LIFE = 8;

export class World {
  map: GameMap;
  me: number;
  myTeam: number;
  units = new Map<number, UView>();
  contacts = new Map<number, CView>();
  ghosts = new Map<number, Ghost>();
  projs = new Map<number, PView>();
  sites: SiteView[];
  /** Smoothed weather cells for rendering: [kind, x, y, r, intensity]. */
  weather: WeatherRow[] = [];
  private wx = new Map<number, { row: WeatherRow; tx: number; ty: number; ti: number; vx: number; vy: number }>();
  details = new Map<number, DetailRow>();
  /** Type of each own unit, including ones embarked on ships. */
  cargoTypes = new Map<number, UnitType>();
  cash = 0;
  /** Deployment phase info while it lasts (seconds left, ready players), else null. */
  setup: { left: number; ready: number[] } | null = null;
  /** Smoke screens on the map: x, y, radius, seconds left. */
  smokes: [number, number, number, number][] = [];
  /** Our team's sonobuoys: x, y, seconds left. */
  buoys: [number, number, number][] = [];
  displayCash = 0;
  income = 0;
  queues: Record<'naval' | 'ground' | 'air', QueueItem[]> = { naval: [], ground: [], air: [] };
  factories: Record<'naval' | 'ground' | 'air', number> = { naval: -1, ground: -1, air: -1 };
  players: { id: number; name: string; faction: Faction; team: number; slot: number; bot: boolean; res: number; units: number; defeated: boolean; dom: number }[];
  serverTime = 0;
  renderTime = 0;
  clock = 0;
  onEvent: (e: GameEvent) => void = () => {};
  private started = false;

  constructor(readonly info: StartInfo) {
    this.map = generateMap(info.seed, info.theme, info.players.map((p) => p.slot));
    this.me = info.you;
    this.players = info.players.map((p) => ({ ...p, res: 0, units: 0, defeated: false, dom: 0 }));
    this.myTeam = this.players[this.me]?.team ?? 0;
    this.sites = this.map.sites.map((s) => ({ id: s.id, owner: -1, cap: 0, capBy: -1 }));
  }

  faction(pid: number): Faction {
    return this.players[pid]?.faction ?? 'coalition';
  }
  get myFaction(): Faction {
    return this.faction(this.me);
  }
  teamOf(pid: number): number {
    return this.players[pid]?.team ?? -1;
  }

  /** Measured interval between snapshots (0.1 s offline, 0.2 s online). */
  snapDt = 0.1;

  apply(s: Snapshot) {
    const T = s.time;
    if (this.started && T > this.serverTime) this.snapDt += (Math.min(0.5, T - this.serverTime) - this.snapDt) * 0.2;
    this.serverTime = T;
    if (!this.started) {
      this.renderTime = T - 0.1;
      this.started = true;
    }
    this.cash = s.cash;
    this.income = s.income;
    this.setup = s.ph ?? null;
    this.smokes = s.sm ?? [];
    this.buoys = s.bu ?? [];
    if (s.q) this.queues = s.q;
    if (s.f) this.factories = s.f;
    if (s.s) for (const [id, owner, cap, capBy] of s.s) this.sites[id] = { id, owner, cap: cap / 100, capBy };
    if (s.w) {
      // Server sends cells once a second; keep them gliding in between.
      const live = new Set<number>();
      for (const [kind, x, y, r, i, vx, vy, id] of s.w) {
        live.add(id);
        const c = this.wx.get(id);
        if (!c) this.wx.set(id, { row: [kind, x, y, r, i], tx: x, ty: y, ti: i, vx, vy });
        else Object.assign(c, { tx: x, ty: y, ti: i, vx, vy }), (c.row[3] = r);
      }
      for (const id of this.wx.keys()) if (!live.has(id)) this.wx.delete(id);
      this.weather = [...this.wx.values()].map((c) => c.row);
    }
    if (s.pl) for (const p of s.pl) Object.assign(this.players[p.id], p);
    this.details.clear();
    for (const d of s.d) {
      this.details.set(d[0], d);
      this.cargoTypes.set(d[0], UNIT_TYPES[d[8]]);
    }
    for (const e of s.e) if (e.k === 'kill') this.deadIds.add(e.id);

    const now = this.clock;
    const seen = new Set<number>();
    for (const r of s.u) {
      const [id, ti, owner, x, y, alt, h, hp, flags] = r;
      seen.add(id);
      let u = this.units.get(id);
      if (!u) {
        u = { id, type: UNIT_TYPES[ti], owner, x, y, alt, h, hp, flags, p: [x, y, alt, h], n: [x, y, alt, h], t0: T - 0.1, t1: T, born: now, seen: now };
        this.units.set(id, u);
        this.ghosts.delete(id);
        this.contacts.delete(id);
      } else {
        u.p = [u.x, u.y, u.alt, u.h];
        u.n = [x, y, alt, h];
        u.t0 = this.renderTime;
        u.t1 = T;
        u.hp = hp;
        u.flags = flags;
        u.owner = owner;
        u.seen = now;
      }
    }
    for (const [id, u] of this.units) {
      if (seen.has(id)) continue;
      this.units.delete(id);
      // Hostile tracks that vanish leave a last-known-position ghost.
      if (this.teamOf(u.owner) !== this.myTeam && !this.deadIds.has(id)) {
        this.ghosts.set(id, { id, domain: UNITS[u.type].domain, type: u.type, x: u.x, y: u.y, r: 0, t: now });
      }
    }
    const seenC = new Set<number>();
    for (const [id, kind, x, y, r, f] of s.c) {
      seenC.add(id);
      const c = this.contacts.get(id);
      if (!c) {
        this.contacts.set(id, { id, kind, x, y, r, tx: x, ty: y, tr: r, born: now, seen: now, esm: (f & 1) === 1 });
        this.ghosts.delete(id);
      } else {
        c.tx = x;
        c.ty = y;
        c.tr = r;
        c.kind = kind;
        c.seen = now;
        c.esm = (f & 1) === 1;
      }
    }
    for (const [id, c] of this.contacts) {
      if (seenC.has(id)) continue;
      this.contacts.delete(id);
      if (!this.units.has(id) && !this.deadIds.has(id)) {
        const type = c.kind >= 10 ? UNIT_TYPES[c.kind - 10] : null;
        this.ghosts.set(id, { id, domain: type ? UNITS[type].domain : DOMAINS[c.kind], type, x: c.x, y: c.y, r: c.r, t: now });
      }
    }
    const seenP = new Set<number>();
    for (const [id, ki, x, y, alt, mine] of s.p) {
      seenP.add(id);
      const p = this.projs.get(id);
      if (!p) {
        this.projs.set(id, { id, kind: PROJ_KINDS[ki], x, y, alt, px: x, py: y, palt: alt, mine: (mine & 1) === 1, air: (mine & 2) === 2, alt0: alt, born: this.clock, t0: T - 0.1, t1: T, rx: x, ry: y, ralt: alt });
      } else {
        p.air = (mine & 2) === 2;
        p.px = p.rx;
        p.py = p.ry;
        p.palt = p.ralt;
        p.x = x;
        p.y = y;
        p.alt = alt;
        p.t0 = this.renderTime;
        p.t1 = T;
      }
    }
    for (const id of this.projs.keys()) if (!seenP.has(id)) this.projs.delete(id);
    for (const e of s.e) {
      if (e.k === 'kill') this.ghosts.delete(e.id);
      this.onEvent(e);
    }
  }

  deadIds = new Set<number>();

  update(dt: number) {
    this.clock += dt;
    // Keep the render clock about one snapshot interval behind the newest snapshot.
    const target = this.serverTime - this.snapDt * 1.05;
    this.renderTime += dt;
    const drift = target - this.renderTime;
    if (Math.abs(drift) > 0.6) this.renderTime = target;
    else this.renderTime += drift * Math.min(1, dt * 3);
    for (const u of this.units.values()) {
      const span = Math.max(0.05, u.t1 - u.t0);
      const f = Math.max(0, Math.min(1.25, (this.renderTime - u.t0) / span));
      u.x = u.p[0] + (u.n[0] - u.p[0]) * f;
      u.y = u.p[1] + (u.n[1] - u.p[1]) * f;
      u.alt = u.p[2] + (u.n[2] - u.p[2]) * f;
      u.h = u.p[3] + angDiff(u.p[3], u.n[3]) * f;
    }
    for (const p of this.projs.values()) {
      const span = Math.max(0.05, p.t1 - p.t0);
      const f = Math.max(0, Math.min(1.3, (this.renderTime - p.t0) / span));
      p.rx = p.px + (p.x - p.px) * f;
      p.ry = p.py + (p.y - p.py) * f;
      p.ralt = p.palt + (p.alt - p.palt) * f;
    }
    for (const [id, g] of this.ghosts) if (this.clock - g.t > GHOST_LIFE) this.ghosts.delete(id);
    // Contacts sit on the unit: follow the 2 Hz sensor updates closely so fast movers don't trail.
    const ck = Math.min(1, dt * 6);
    for (const c of this.contacts.values()) {
      c.x += (c.tx - c.x) * ck;
      c.y += (c.ty - c.y) * ck;
      c.r += (c.tr - c.r) * ck;
    }
    for (const c of this.wx.values()) {
      c.tx += c.vx * dt;
      c.ty += c.vy * dt;
      const k = Math.min(1, dt * 1.5);
      c.row[1] += (c.tx - c.row[1]) * k;
      c.row[2] += (c.ty - c.row[2]) * k;
      c.row[4] += (c.ti - c.row[4]) * Math.min(1, dt * 0.8);
    }
    // Cash ticker.
    const d = this.cash - this.displayCash;
    this.displayCash += Math.abs(d) < 1 ? d : d * Math.min(1, dt * 6);
  }

  myUnits(): UView[] {
    return [...this.units.values()].filter((u) => u.owner === this.me);
  }
}
