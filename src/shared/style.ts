// Training: record how a human plays a skirmish, and turn recordings into a style profile the AI
// can follow (opening buys, unit mix by phase of the game, expansion pace, how early and how hard
// it attacks, how far forward it keeps its fleet and submarines).
//
// A recording is plain JSON. It is kept in the browser and can be downloaded, so it can also be
// studied by hand to improve the AI.
import { BUILDABLE, UNITS, UNIT_TYPES, UnitType, unitCost } from './defs';
import type { Faction } from './defs';
import type { Game } from './game';
import type { Command } from './protocol';
import type { Theme } from './map';

export interface StyleSample {
  /** Game time, s. */
  t: number;
  cash: number;
  /** Income over the last minute. */
  income: number;
  units: Partial<Record<UnitType, number>>;
  islands: number;
  res: number;
  kills: number;
  losses: number;
  enemyIslands: number;
  /** Where our warships are, 0 = at our HQ, 1 = at the nearest enemy HQ (-1: none). */
  fleetFwd: number;
  /** Same for our submarines. */
  subFwd: number;
}

export interface Recording {
  v: 1;
  date: string;
  seed: number;
  theme: Theme;
  faction: Faction;
  /** Number of players in the match. */
  players: number;
  /** Game time when the recording ended, s. */
  seconds: number;
  result: 'win' | 'loss' | 'quit';
  /** Units bought in the deployment phase. */
  deploy: UnitType[];
  /** [time s, type] for every unit we built in the battle. */
  builds: [number, UnitType][];
  /** [time s, command, units involved (e.g. "DDG2 SSN1"), x, y]; x and y are -1 when the command has no point. */
  cmds: [number, string, string, number, number][];
  /** [time s, site type, true if taken from an enemy]. */
  captures: [number, string, boolean][];
  /** First time one of our units fired at the enemy, s (-1: never). */
  firstShot: number;
  samples: StyleSample[];
}

/** Records one player's game. Feed it every command the player sends and call tick() after every step. */
export class Recorder {
  readonly rec: Recording;
  private nextSample = 0;
  private earnedAt: number[] = [];
  private inBattle = false;

  constructor(
    private game: Game,
    private pid: number,
  ) {
    const p = game.players[pid];
    this.rec = {
      v: 1,
      date: new Date().toISOString(),
      seed: game.seed,
      theme: game.theme,
      faction: p.faction,
      players: game.players.length,
      seconds: 0,
      result: 'quit',
      deploy: [],
      builds: [],
      cmds: [],
      captures: [],
      firstShot: -1,
      samples: [],
    };
  }

  command(cmd: Command) {
    const g = this.game;
    const ids: number[] = 'ids' in cmd && Array.isArray(cmd.ids) ? cmd.ids : cmd.c === 'unload' ? [cmd.ship] : [];
    const count = new Map<string, number>();
    for (const id of ids) {
      const u = g.units.get(id);
      if (u) count.set(UNITS[u.type].short, (count.get(UNITS[u.type].short) ?? 0) + 1);
    }
    let what = [...count].map(([k, n]) => `${k}${n}`).join(' ');
    if (cmd.c === 'attack') {
      const t = g.units.get(Number(cmd.target));
      if (t) what += ` > ${UNITS[t.type].short}`;
    }
    if (cmd.c === 'build' || cmd.c === 'deploy') what = UNITS[cmd.type]?.short ?? String(cmd.type);
    if (cmd.c === 'firemode') what += ` mode${cmd.mode}`;
    if (cmd.c === 'radar') what += cmd.on ? ' on' : ' off';
    const x = 'x' in cmd && typeof cmd.x === 'number' ? Math.round(cmd.x * 10) / 10 : -1;
    const y = 'y' in cmd && typeof cmd.y === 'number' ? Math.round(cmd.y * 10) / 10 : -1;
    this.rec.cmds.push([Math.round(g.time * 10) / 10, cmd.c, what, x, y]);
  }

  /** Call after each simulation step, before its events are flushed. */
  tick() {
    const g = this.game;
    const r = this.rec;
    if (!this.inBattle && g.phase === 'battle') {
      this.inBattle = true;
      for (const u of g.units.values()) if (u.owner === this.pid && !u.dead && u.type !== 'merchant' && u.type !== 'lander') r.deploy.push(u.type);
    }
    if (!this.inBattle) return;
    const team = g.players[this.pid].team;
    for (const { e } of g.events) {
      if (e.k === 'built' && e.o === this.pid) r.builds.push([Math.round(g.time), UNIT_TYPES[e.ty]]);
      else if (e.k === 'capture' && e.o === this.pid) r.captures.push([Math.round(g.time), g.sites[e.site].type, e.prev >= 0 && g.team(e.prev) !== team]);
      else if (e.k === 'fire' && r.firstShot < 0) {
        const u = g.units.get(e.id);
        if (u && u.owner === this.pid) r.firstShot = Math.round(g.time);
      }
    }
    r.seconds = Math.round(g.time);
    if (g.time >= this.nextSample) {
      this.nextSample = g.time + 10;
      r.samples.push(this.sample());
    }
  }

  finish(result: Recording['result']) {
    this.rec.result = result;
    this.rec.seconds = Math.round(this.game.time);
  }

  private sample(): StyleSample {
    const g = this.game;
    const p = g.players[this.pid];
    const team = p.team;
    this.earnedAt.push(p.earned);
    if (this.earnedAt.length > 7) this.earnedAt.shift();
    const units: Partial<Record<UnitType, number>> = {};
    const war: { x: number; y: number }[] = [];
    const subs: { x: number; y: number }[] = [];
    for (const u of g.units.values()) {
      if (u.owner !== this.pid || u.dead || u.type === 'merchant' || u.type === 'lander') continue;
      units[u.type] = (units[u.type] ?? 0) + 1;
      if (u.type === 'destroyer' || u.type === 'battleship' || u.type === 'carrier') war.push(u);
      if (u.type === 'sub') subs.push(u);
    }
    const hq = g.sites.find((s) => s.type === 'hq' && s.owner === this.pid);
    const enemyHqs = g.sites.filter((s) => s.type === 'hq' && s.owner >= 0 && g.team(s.owner) !== team);
    const fwd = (pts: { x: number; y: number }[]) => {
      if (!pts.length || !hq || !enemyHqs.length) return -1;
      const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
      const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
      const e = enemyHqs.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
      const L = Math.hypot(e.x - hq.x, e.y - hq.y) || 1;
      // Projection of the group's centre on the line from our HQ to theirs.
      const f = ((cx - hq.x) * (e.x - hq.x) + (cy - hq.y) * (e.y - hq.y)) / (L * L);
      return Math.round(Math.max(0, Math.min(1, f)) * 100) / 100;
    };
    const held = (pred: (owner: number) => boolean) => new Set(g.sites.filter((s) => s.owner >= 0 && pred(s.owner)).map((s) => s.island)).size;
    return {
      t: Math.round(g.time),
      cash: Math.round(p.cash),
      income: Math.round(this.earnedAt[this.earnedAt.length - 1] - this.earnedAt[0]),
      units,
      islands: held((o) => o === this.pid),
      res: g.sites.filter((s) => s.owner === this.pid && s.type === 'resource').length,
      kills: p.kills,
      losses: p.losses,
      enemyIslands: held((o) => g.team(o) !== team),
      fleetFwd: fwd(war),
      subFwd: fwd(subs),
    };
  }
}

/** Game phases the profile splits the unit mix into, s. */
export const PHASES: [number, number][] = [
  [0, 300],
  [300, 900],
  [900, 1e9],
];

export interface StyleProfile {
  games: number;
  /** Units bought in the deployment phase, most common first (one typical opening). */
  deploy: UnitType[];
  /** Share of money spent on each type, per phase. */
  mix: Partial<Record<UnitType, number>>[];
  /** Islands held at 5, 10 and 15 minutes. */
  islandsAt: number[];
  /** First shot and first capture from an enemy, s (-1: not seen). */
  firstShot: number;
  firstEnemyCapture: number;
  /** Average forward position of warships and submarines (0 = home, 1 = enemy HQ). */
  fleetFwd: number;
  subFwd: number;
  /** 0 = cautious, 1 = very aggressive. */
  aggression: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : -1);

/** Average a set of recordings into one profile. */
export function deriveProfile(recs: Recording[], faction: Faction = 'coalition'): StyleProfile | null {
  const rs = recs.filter((r) => r.v === 1 && r.seconds > 240);
  if (!rs.length) return null;
  // Opening: the most common count of each type across games.
  const deploy: UnitType[] = [];
  for (const type of UNIT_TYPES) {
    const counts = rs.map((r) => r.deploy.filter((d) => d === type).length).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)];
    for (let i = 0; i < median; i++) deploy.push(type);
  }
  // Order: ships first, then ground, then air (as a player usually places them).
  const order = (t: UnitType) => (BUILDABLE.naval.includes(t) ? 0 : BUILDABLE.ground.includes(t) ? 1 : 2);
  deploy.sort((a, b) => order(a) - order(b));
  const mix = PHASES.map(([a, b]) => {
    const spend: Partial<Record<UnitType, number>> = {};
    let total = 0;
    for (const r of rs)
      for (const [t, type] of r.builds) {
        if (t < a || t >= b) continue;
        const c = unitCost(type, faction);
        spend[type] = (spend[type] ?? 0) + c;
        total += c;
      }
    if (total > 0) for (const k of Object.keys(spend) as UnitType[]) spend[k] = Math.round((spend[k]! / total) * 1000) / 1000;
    return spend;
  });
  const islandsAt = [300, 600, 900].map((t) => {
    const xs = rs.map((r) => r.samples.find((s) => s.t >= t)?.islands).filter((x): x is number => x !== undefined);
    return Math.round(avg(xs) * 10) / 10;
  });
  const firstShot = Math.round(avg(rs.map((r) => r.firstShot).filter((x) => x >= 0)));
  const firstEnemyCapture = Math.round(avg(rs.map((r) => r.captures.find((c) => c[2])?.[0] ?? -1).filter((x) => x >= 0)));
  const fleetFwd = avg(rs.flatMap((r) => r.samples.map((s) => s.fleetFwd).filter((x) => x >= 0)));
  const subFwd = avg(rs.flatMap((r) => r.samples.map((s) => s.subFwd).filter((x) => x >= 0)));
  // Aggression: how far forward the fleet sits and how early the first enemy island falls.
  const early = firstEnemyCapture > 0 ? Math.max(0, Math.min(1, (1200 - firstEnemyCapture) / 900)) : 0;
  const aggression = Math.round(Math.max(0, Math.min(1, (fleetFwd < 0 ? 0.3 : fleetFwd) * 0.6 + early * 0.4)) * 100) / 100;
  return {
    games: rs.length,
    deploy,
    mix,
    islandsAt,
    firstShot,
    firstEnemyCapture,
    fleetFwd: Math.round(fleetFwd * 100) / 100,
    subFwd: Math.round(subFwd * 100) / 100,
    aggression,
  };
}
