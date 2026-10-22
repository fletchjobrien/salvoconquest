// Client-side view of the game: interpolated units, radar contacts with memory, sites, weather.
//
// Units and projectiles are drawn a little in the past (about 1.4 snapshot intervals plus network
// jitter: some 250-300 ms online, where the server sends 5 snapshots a second). Each keeps a short
// history of authoritative positions, and the render clock always falls between two of them, so
// motion is a straight interpolation between real samples, not a chase after the newest one.
// Events (shots, hits, kills) are held back by the same delay so they line up with what is drawn.
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
  /** Fleet-comp variant (index in its class): picks the model and the weapons. */
  variant: number;
  /** Authoritative samples, oldest first (server time). */
  hist: Sample[];
  /** Server time of the first snapshot that no longer had it (Infinity while it is still sent). */
  gone: number;
  born: number;
  seen: number;
}

/** One authoritative position: server time, map x/y, altitude, heading. */
export interface Sample {
  t: number;
  x: number;
  y: number;
  alt: number;
  h: number;
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
  /** Drawn position (interpolated); x/y/alt above are the newest sample, px/py/palt the one before. */
  rx: number;
  ry: number;
  ralt: number;
  hist: Sample[];
  gone: number;
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
  /** Our airbases: site id -> flights based there. */
  airbases = new Map<number, number[]>();
  displayCash = 0;
  income = 0;
  queues: Record<'naval' | 'ground' | 'air', QueueItem[]> = { naval: [], ground: [], air: [] };
  players: { id: number; name: string; faction: Faction; team: number; slot: number; bot: boolean; res: number; units: number; defeated: boolean; dom: number }[];
  serverTime = 0;
  /** Server time being drawn: behind the newest snapshot by `delay`. */
  renderTime = 0;
  /** How far behind the server we draw (s). */
  delay = 0.15;
  clock = 0;
  /** Estimated server time minus local clock, and how much the arrival times scatter. */
  private offset = NaN;
  private offsets: number[] = [];
  private jitter = 0;
  /** Everything we track, including tracks not yet (or no longer) drawn. */
  private uTrack = new Map<number, UView>();
  private pTrack = new Map<number, PView>();
  /** Events waiting for the render clock to reach the snapshot that brought them. */
  private queued: { t: number; e: GameEvent }[] = [];
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
    // Server clock estimate from arrival times over the last dozen snapshots: the earliest arrival
    // (least network delay) gives the server clock, the spread gives the jitter. A snapshot so late
    // that the render clock would outrun the data (a pause, a stall) restarts the estimate.
    const sample = T - this.clock;
    if (this.offsets.length && (sample < this.offset - Math.max(0.3, this.delay) || sample > this.offset + 1.5)) this.offsets.length = 0;
    this.offsets.push(sample);
    if (this.offsets.length > 12) this.offsets.shift();
    this.offset = Math.max(...this.offsets);
    this.jitter = this.offsets.reduce((a, o) => a + (this.offset - o), 0) / this.offsets.length;
    this.delay = Math.min(0.45, Math.max(0.12, this.snapDt * 1.4, this.snapDt + this.jitter * 2 + 0.03));
    if (!this.started) {
      this.renderTime = T - this.delay;
      this.started = true;
    }
    this.cash = s.cash;
    this.income = s.income;
    this.setup = s.ph ?? null;
    this.smokes = s.sm ?? [];
    this.buoys = s.bu ?? [];
    this.airbases = new Map(s.ab ?? []);
    if (s.q) this.queues = s.q;
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
      const [id, ti, owner, x, y, alt, h, hp, flags, variant] = r;
      seen.add(id);
      let u = this.uTrack.get(id);
      if (!u || u.gone !== Infinity) {
        // New, or back in sight before its old track was drawn out: start a fresh history.
        if (u) this.units.delete(id);
        u = { id, type: UNIT_TYPES[ti], owner, x, y, alt, h, hp, flags, variant: variant ?? 0, hist: [], gone: Infinity, born: now, seen: now };
        this.uTrack.set(id, u);
      }
      push(u.hist, { t: T, x, y, alt, h });
      u.hp = hp;
      u.flags = flags;
      u.owner = owner;
      u.seen = now;
    }
    for (const u of this.uTrack.values()) if (u.gone === Infinity && !seen.has(u.id)) u.gone = T;
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
      let p = this.pTrack.get(id);
      if (!p) {
        p = { id, kind: PROJ_KINDS[ki], x, y, alt, px: x, py: y, palt: alt, mine: (mine & 1) === 1, air: (mine & 2) === 2, alt0: alt, born: this.clock, rx: x, ry: y, ralt: alt, hist: [], gone: Infinity };
        this.pTrack.set(id, p);
      } else {
        p.air = (mine & 2) === 2;
        p.px = p.x;
        p.py = p.y;
        p.palt = p.alt;
        p.x = x;
        p.y = y;
        p.alt = alt;
      }
      push(p.hist, { t: T, x, y, alt, h: 0 });
    }
    for (const p of this.pTrack.values()) if (p.gone === Infinity && !seenP.has(p.id)) p.gone = T;
    // Events wait for the render clock (a hidden tab draws nothing, so there they go out at once).
    const hidden = typeof document !== 'undefined' && document.hidden;
    for (const e of s.e) {
      if (hidden) this.emitEvent(e);
      else this.queued.push({ t: T, e });
    }
  }

  private emitEvent(e: GameEvent) {
    if (e.k === 'kill') this.ghosts.delete(e.id);
    this.onEvent(e);
  }

  deadIds = new Set<number>();

  update(dt: number) {
    this.clock += dt;
    // The render clock runs with the local clock and is steered gently toward
    // (estimated server time - delay); it never runs backward.
    if (this.started && !Number.isNaN(this.offset)) {
      const target = this.clock + this.offset - this.delay;
      const drift = target - (this.renderTime + dt);
      if (Math.abs(drift) > 1) this.renderTime = target;
      else this.renderTime += Math.max(0, dt + drift * Math.min(1, dt * 2));
      // Never past the newest snapshot: while the game is paused or stalled, the picture waits.
      this.renderTime = Math.min(this.renderTime, this.serverTime);
    }
    const rt = this.renderTime;
    // Events and removals happen half a snapshot interval before the snapshot that reported them
    // (the event itself fell somewhere inside that interval).
    const half = this.snapDt * 0.5;
    if (this.queued.length) {
      let n = 0;
      while (n < this.queued.length && this.queued[n].t - half <= rt) n++;
      if (n) for (const { e } of this.queued.splice(0, n)) this.emitEvent(e);
    }
    const S: Sample = { t: 0, x: 0, y: 0, alt: 0, h: 0 };
    for (const u of this.uTrack.values()) {
      if (rt >= u.gone - half) {
        this.uTrack.delete(u.id);
        if (this.units.delete(u.id) && this.teamOf(u.owner) !== this.myTeam && !this.deadIds.has(u.id)) {
          // Hostile tracks that vanish leave a last-known-position ghost.
          this.ghosts.set(u.id, { id: u.id, domain: UNITS[u.type].domain, type: u.type, x: u.x, y: u.y, r: 0, t: this.clock });
        }
        continue;
      }
      // Drawn once the render clock is within one interval of its first sample.
      if (!this.units.has(u.id)) {
        if (rt < u.hist[0].t - this.snapDt) continue;
        this.units.set(u.id, u);
        this.ghosts.delete(u.id);
        this.contacts.delete(u.id);
      }
      sampleAt(u.hist, rt, 0.15, S);
      u.x = S.x;
      u.y = S.y;
      u.alt = S.alt;
      u.h = S.h;
      trim(u.hist, rt);
    }
    for (const p of this.pTrack.values()) {
      if (rt >= p.gone - half) {
        this.pTrack.delete(p.id);
        this.projs.delete(p.id);
        continue;
      }
      if (!this.projs.has(p.id)) {
        if (rt < p.hist[0].t - half) continue;
        this.projs.set(p.id, p);
      }
      // Projectiles fly on past their last sample until the snapshot that removed them is due.
      sampleAt(p.hist, rt, 0.5, S);
      p.rx = S.x;
      p.ry = S.y;
      p.ralt = S.alt;
      trim(p.hist, rt);
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

/** Keep a sample (in time order) and at most a second or so of history. */
function push(hist: Sample[], s: Sample) {
  const last = hist[hist.length - 1];
  if (last && s.t <= last.t) {
    if (s.t === last.t) hist[hist.length - 1] = s;
    return;
  }
  hist.push(s);
  if (hist.length > 16) hist.shift();
}

/** Drop samples the render clock has passed, keeping the one just before it. */
function trim(hist: Sample[], rt: number) {
  let n = 0;
  while (n + 1 < hist.length && hist[n + 1].t <= rt) n++;
  if (n > 0) hist.splice(0, n);
}

/**
 * Position at render time rt: linear between the two samples around it. Before the first sample:
 * the first. After the last: carried on along the last leg for at most `extra` seconds. A jump too
 * big for any unit (launched from a deck, a new track) snaps instead of sliding across the map.
 */
function sampleAt(hist: Sample[], rt: number, extra: number, out: Sample) {
  const n = hist.length;
  let a = hist[0];
  let b = a;
  if (n > 1) {
    if (rt >= hist[n - 1].t) {
      a = hist[n - 2];
      b = hist[n - 1];
    } else {
      for (let i = 0; i + 1 < n; i++) {
        if (rt < hist[i + 1].t) {
          a = hist[i];
          b = hist[i + 1];
          break;
        }
      }
    }
  }
  const span = b.t - a.t;
  let f = span > 1e-6 ? (rt - a.t) / span : 0;
  f = Math.max(0, Math.min(f, span > 1e-6 ? 1 + extra / span : 0));
  if (Math.hypot(b.x - a.x, b.y - a.y) > 2.5) f = f < 1 ? 0 : 1;
  out.x = a.x + (b.x - a.x) * f;
  out.y = a.y + (b.y - a.y) * f;
  out.alt = a.alt + (b.alt - a.alt) * f;
  out.h = a.h + angDiff(a.h, b.h) * f;
}
