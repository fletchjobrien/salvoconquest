// Computer opponent. Uses only what its team can detect for targeting.
import { BUILDINGS, CLASSES, UNITS, UnitType, unitCost, counterOf } from './defs';
import { canDeployAt, deployZone } from './game';
import type { Contact, Game, Unit, SiteState } from './game';
import { cellOf, islandAt } from './map';

/** How dangerous a unit is to a fleet (hp-weighted when it is ours). */
const NAVAL_POWER: Partial<Record<UnitType, number>> = { battleship: 8, cruiser: 8, destroyer: 5, frigate: 3.5, corvette: 1.5, sub: 3, carrier: 3, coastal: 4, strike: 3 };
/** Surface ships that fight in the battle line (corvettes are troop transports for us). */
const LINE = new Set<UnitType>(['frigate', 'destroyer', 'cruiser', 'battleship']);
/** Big hulls: torpedo bait, worth escorting. */
const CAPITAL = new Set<UnitType>(['cruiser', 'battleship', 'carrier']);
/** Enemy surface warships we count as fleet power. */
const WARSHIP = new Set<UnitType>(['corvette', 'frigate', 'destroyer', 'cruiser', 'battleship', 'carrier']);
/** A remembered sighting counts half after this many seconds: the ship has likely moved on. */
const SIGHTING_HALF_LIFE = 60;
/** What an island's buildings are worth to us. */
const SITE_VALUE: Partial<Record<string, number>> = { resource: 3, hq: 8, dockyard: 2.5, navalbase: 2.5, airbase: 2, barracks: 2, battery: 2, radar: 1.5 };

interface IslandPlan {
  island: number;
  x: number;
  y: number;
  /** Most valuable site still to take there. */
  target: SiteState;
  value: number;
  dist: number;
  naval: number;
  ground: number;
  enemyHeld: boolean;
  centre: boolean;
  contested: boolean;
}

interface Operation {
  island: number;
  x: number;
  y: number;
  /** Landing objective (a site) and the staging point on our side. */
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  ships: number[];
  escorts: number[];
  state: 'load' | 'sail' | 'land' | 'hold';
  since: number;
  startPower: number;
  need: number;
  /** Strength the task force should have; new warships join only while it is below this. */
  want: number;
}

interface Transport {
  ship: number;
  island: number;
  tx: number;
  ty: number;
  state: 'loading' | 'sailing' | 'done';
  since: number;
}

export class Bot {
  private nextThink = 0;
  private transports: Transport[] = [];
  private fleetOrderAt = 0;
  private airOrderAt = 0;
  private deployed = false;
  private counterAt = 0;
  private tacticsAt = 0;
  private buoyAt = 0;
  /** Our merchants last tick (id -> position), and where we lost some recently (raids to cover). */
  private merchantPos = new Map<number, { x: number; y: number }>();
  private raided: { x: number; y: number; t: number }[] = [];
  /** Enemy warships our side has identified (id -> type), for counter-building. */
  private spotted = new Map<number, UnitType>();
  private intel = new Map<number, { type: UnitType; x: number; y: number; t: number }>();
  private op: Operation | null = null;
  /** Counters for the benchmark: operations started, won, called off; ships ordered to break off. */
  readonly stats = { ops: 0, won: 0, aborted: 0, breakoffs: 0, why: {} as Record<string, number> };
  private opCooldown = 0;
  /** Troops wanted in one place for the next operation. */
  private troopGoal = 0;
  private opOrderAt = 0;
  /** Next time a strike package may be formed. */
  private strikeAt = 0;
  /** Islands we were beaten back from, until when. */
  private avoid = new Map<number, number>();
  /** Ships ordered to break off: no new engagements until then. */
  private noEngage = new Map<number, number>();
  /** Submarine raid plans: target point and the safe route to it. */
  private raids = new Map<number, { tx: number; ty: number; pts: [number, number][]; i: number; at: number; home: boolean }>();

  constructor(
    private game: Game,
    readonly pid: number,
  ) {
    this.nextThink = 2 + pid * 0.37;
  }

  tick() {
    const g = this.game;
    if (g.phase === 'setup') {
      if (!this.deployed) this.deploy();
      return;
    }
    if (g.players[this.pid].defeated) return;
    if (g.time >= this.counterAt) {
      this.counterAt = g.time + 0.5;
      this.countermeasures();
    }
    if (g.time >= this.tacticsAt) {
      this.tacticsAt = g.time + 4;
      this.tactics();
    }
    if (g.time < this.nextThink) return;
    this.nextThink = g.time + 2;
    this.updateIntel();
    this.produce();
    this.operation();
    this.grabs();
    this.fleet();
    this.raidsAndRefits();
    this.air();
    this.groundIdle();
  }

  /** Deployment phase: buy a balanced opening force, place it, ready up. */
  private deploy() {
    const g = this.game;
    const p = g.players[this.pid];
    this.deployed = true;
    const zone = deployZone(g.map, p.slot);
    const site = (t: string) => g.sites.find((s) => s.owner === this.pid && s.type === t);
    const hq = site('hq');
    const nb = site('navalbase');
    const bk = site('barracks');
    const ab = site('airbase');
    if (!zone || !hq) {
      g.command(this.pid, { c: 'ready', on: true });
      return;
    }
    const plan: { type: UnitType; at: { x: number; y: number } }[] = [
      { type: 'destroyer', at: nb?.dock ?? hq },
      { type: 'corvette', at: nb?.dock ?? hq },
      { type: 'destroyer', at: nb?.dock ?? hq },
      { type: 'infantry', at: bk ?? hq },
      { type: 'infantry', at: bk ?? hq },
      { type: 'fighter', at: ab ?? hq },
      { type: 'frigate', at: nb?.dock ?? hq },
      { type: 'sam', at: hq },
      { type: 'infantry', at: bk ?? hq },
      { type: 'coastal', at: hq },
    ];
    // Spend the whole opening budget (32 points), like a player.
    const reserve = 0;
    for (const it of plan) {
      if (p.cash - unitCost(it.type, p.faction) < reserve) continue;
      // Spiral out from the anchor to the first legal spot.
      for (let k = 0; k < 200; k++) {
        const r = 0.3 + k * 0.08;
        const x = it.at.x + Math.cos(k * 2.4) * r;
        const y = it.at.y + Math.sin(k * 2.4) * r;
        if (canDeployAt(g.map, p.slot, it.type, x, y)) {
          g.command(this.pid, { c: 'deploy', type: it.type, x, y });
          break;
        }
      }
    }
    g.command(this.pid, { c: 'ready', on: true });
  }

  private mine(): Unit[] {
    const out: Unit[] = [];
    for (const u of this.game.units.values()) if (u.owner === this.pid && !u.dead) out.push(u);
    return out;
  }

  private home(): SiteState | undefined {
    return this.game.sites.find((s) => s.type === 'hq' && s.owner === this.pid);
  }

  /** Chaff when a missile homing on us gets close; smoke when troops are hurt and under fire. */
  private countermeasures() {
    const g = this.game;
    const fire: number[] = [];
    for (const u of this.mine()) {
      if (u.cm < 1 || u.landed || u.inside >= 0) continue;
      const kind = counterOf(u.type);
      if (kind === 'chaff') {
        const near = UNITS[u.type].domain === 'air' ? 4 : 6;
        if (g.projs.some((p) => !p.dead && p.target === u.id && p.team !== u.team && (p.kind === 'missile' || p.kind === 'sam') && Math.hypot(p.x - u.x, p.y - u.y) < near)) fire.push(u.id);
      } else if (kind === 'smoke') {
        if (u.hp < u.maxHp * 0.55 && g.time - u.lastHitAt < 3 && !g.inSmoke(u.x, u.y)) fire.push(u.id);
      }
    }
    if (fire.length) g.command(this.pid, { c: 'counter', ids: fire });
  }

  /** Identified, live enemy units our side knows about. */
  private contacts(): { e: Unit; k: Contact }[] {
    const g = this.game;
    const team = g.players[this.pid].team;
    const out: { e: Unit; k: Contact }[] = [];
    for (const [id, k] of g.knowledge.get(team) ?? []) {
      if (k.ident < 1 || k.lost) continue;
      const e = g.units.get(id);
      if (e && !e.dead && e.team !== team && e.inside < 0) out.push({ e, k });
    }
    return out;
  }

  /**
   * Every 4 s: pick fights well. Ships focus fire on the best target for their class (destroyers on
   * subs, battleships on destroyers), capital ships run from submarines, subs stalk capital ships and
   * merchants but slip away from destroyers, strike aircraft go for the most valuable identified ship,
   * fighters intercept, the AEW covers the fleet and seeds sonobuoys.
   */
  private tactics() {
    const g = this.game;
    const mine = this.mine();
    const known = this.contacts();
    const busy = new Set(this.transports.map((t) => t.ship));
    for (const [id, until] of this.noEngage) if (until > g.time) busy.add(id);
    if (this.op) for (const id of this.op.ships) busy.add(id);
    for (const [id, r] of this.raids) if (r.home) busy.add(id);
    // Remember where merchants died: those lanes need air cover.
    const alive = new Set<number>();
    for (const u of mine) if (u.type === 'merchant') alive.add(u.id);
    for (const [id, p] of this.merchantPos) if (!alive.has(id)) this.raided.push({ x: p.x, y: p.y, t: g.time });
    this.merchantPos.clear();
    for (const u of mine) if (u.type === 'merchant') this.merchantPos.set(u.id, { x: u.x, y: u.y });
    this.raided = this.raided.filter((r) => g.time - r.t < 180);
    const VALUE: Partial<Record<UnitType, number>> = { carrier: 10, battleship: 8, cruiser: 8, sub: 6, destroyer: 5, frigate: 4.5, corvette: 3, merchant: 3, coastal: 3, sam: 3, recon: 5, strike: 4, fighter: 4, infantry: 2, lander: 1 };
    const focus = new Map<number, number>();
    for (const u of mine) if (u.order.k === 'attack') focus.set(u.order.target, (focus.get(u.order.target) ?? 0) + 1);
    const attack = (u: Unit, t: Unit) => {
      if (u.order.k === 'attack' && u.order.target === t.id) return;
      g.command(this.pid, { c: 'attack', ids: [u.id], target: t.id });
      focus.set(t.id, (focus.get(t.id) ?? 0) + 1);
    };
    const away = (u: Unit, from: { x: number; y: number }, dist: number) => {
      const dx = u.x - from.x;
      const dy = u.y - from.y;
      const dl = Math.hypot(dx, dy) || 1;
      g.command(this.pid, { c: 'move', ids: [u.id], x: u.x + (dx / dl) * dist, y: u.y + (dy / dl) * dist, mode: 'move' });
    };
    const ships = mine.filter((u) => (LINE.has(u.type) || u.type === 'carrier' || u.type === 'sub') && u.inside < 0 && !u.retreating && !busy.has(u.id));
    let cx = 0;
    let cy = 0;
    for (const s of ships) {
      cx += s.x / ships.length;
      cy += s.y / ships.length;
    }
    const navalFoes = known.filter(({ e }) => UNITS[e.type].domain === 'sea' || e.type === 'sub');
    // Local strength around a point: fight where we are at least about as strong, never piecemeal.
    const power = (u: Unit) => (VALUE[u.type] ?? 1) * (u.hp / u.maxHp);
    // Our own ships also count their offensive ammunition left (the enemy's we cannot know).
    const ownPower = (u: Unit) => power(u) * (0.4 + 0.6 * this.offAmmo(u));
    const ourPower = (x: number, y: number) => ships.reduce((a, u) => a + (u.type !== 'sub' && Math.hypot(u.x - x, u.y - y) < 20 ? ownPower(u) : 0), 0);
    const theirPower = (x: number, y: number) =>
      navalFoes.reduce((a, { e, k }) => a + (e.type !== 'merchant' && e.type !== 'lander' && e.type !== 'sub' && Math.hypot(k.x - x, k.y - y) < 15 ? power(e) : 0), 0);
    // Surface combatants near each other fight as one group: one target at a time, every ship on
    // it, missiles weapons-free against defended ships so the salvo saturates their SAMs. A
    // group that is clearly outgunned falls back on its port (batteries, SAM cover) together,
    // instead of being picked off one ship at a time.
    const surf = ships.filter((s) => LINE.has(s.type));
    let gx = 0;
    let gy = 0;
    for (const s of surf) {
      gx += s.x / (surf.length || 1);
      gy += s.y / (surf.length || 1);
    }
    const group = new Set(surf.filter((s) => Math.hypot(s.x - gx, s.y - gy) < 25).map((s) => s.id));
    let groupTarget: Unit | null = null;
    const myTeam = g.players[this.pid].team;
    const cover = (x: number, y: number) => {
      let c = 0;
      for (const u of mine) if (u.type === 'coastal' && Math.hypot(u.x - x, u.y - y) < 18) c += 4;
      for (const st of g.sites) if (st.type === 'battery' && st.owner >= 0 && g.team(st.owner) === myTeam && Math.hypot(st.x - x, st.y - y) < 18) c += 5;
      return c;
    };
    // Troop carriers closing on our islands die first: every landing craft sunk is a squad that never lands.
    const ourSites = g.sites.filter((st) => st.owner >= 0 && g.team(st.owner) === myTeam);
    const landing = (e: Unit, k: { x: number; y: number }) => (e.type === 'lander' || e.type === 'corvette') && ourSites.some((st) => Math.hypot(st.x - k.x, st.y - k.y) < 14);
    let groupFree = false;
    if (group.size >= 2) {
      const ours = surf.filter((s) => group.has(s.id)).reduce((a, u) => a + ownPower(u), 0) + cover(gx, gy);
      const theirs = theirPower(gx, gy) + navalFoes.reduce((a, { e, k }) => a + (e.type !== 'merchant' && e.type !== 'lander' && e.type !== 'sub' && Math.hypot(k.x - gx, k.y - gy) >= 15 && Math.hypot(k.x - gx, k.y - gy) < 24 ? power(e) * 0.6 : 0), 0);
      if (theirs > ours * 1.25 && theirs > 0) {
        const hqs = this.home();
        const port = this.nearestOwnPort(gx, gy) ?? (hqs ? { x: hqs.x, y: hqs.y } : null);
        if (port) {
          const ids = surf.filter((s) => group.has(s.id)).map((s) => s.id);
          g.command(this.pid, { c: 'move', ids, x: port.x, y: port.y, mode: 'move' });
          for (const id of ids) this.noEngage.set(id, g.time + 30);
          this.stats.breakoffs++;
          group.clear();
        }
      } else {
        let bs = 0;
        // Clearly stronger here: weapons free, so the fight ends before their reinforcements arrive.
        groupFree = ours > theirs * 1.6;
        const hasDdg = surf.some((s) => group.has(s.id) && s.type === 'frigate');
        for (const { e, k } of navalFoes) {
          const d = Math.hypot(k.x - gx, k.y - gy);
          if (d > 30) continue;
          let match = e.type === 'sub' ? (hasDdg ? 2.5 : 0) : e.type === 'merchant' ? 0.6 : e.type === 'lander' ? 0.8 : 1;
          if (match <= 0) continue;
          if (d > 14 && ourPower(k.x, k.y) + cover(k.x, k.y) < theirPower(k.x, k.y) * 0.9) continue;
          if (CAPITAL.has(e.type)) match *= 1.2;
          if (landing(e, k)) match *= 3;
          const score = ((VALUE[e.type] ?? 1) * match * (1.6 - (e.hp / e.maxHp) * 0.6)) / (1 + d / 14);
          if (score > bs) {
            bs = score;
            groupTarget = e;
          }
        }
      }
    }
    for (const s of ships) {
      const near = (types: UnitType[], r: number) => navalFoes.filter(({ e, k }) => types.includes(e.type) && Math.hypot(k.x - s.x, k.y - s.y) < r);
      if (CAPITAL.has(s.type)) {
        // Capital ships never sit still next to a known submarine.
        const sub = near(['sub'], 12)[0];
        if (sub) {
          away(s, sub.k, 10);
          continue;
        }
      }
      if (s.type === 'sub') {
        const hunter = near(['frigate'], 10)[0];
        // Strike only what is close; getting there quietly is the raid planner's job.
        const prey = near(['carrier', 'battleship', 'cruiser', 'merchant', 'lander', 'corvette'], 12).sort((a, b) => (VALUE[b.e.type] ?? 1) / (1 + Math.hypot(b.k.x - s.x, b.k.y - s.y) / 8) - (VALUE[a.e.type] ?? 1) / (1 + Math.hypot(a.k.x - s.x, a.k.y - s.y) / 8))[0];
        if (hunter && (!prey || Math.hypot(prey.k.x - s.x, prey.k.y - s.y) > 7)) {
          away(s, hunter.k, 8);
          continue;
        }
        if (prey) {
          attack(s, prey.e);
          s.fireMode = prey.e.type === 'merchant' ? 1 : 2;
        }
        continue;
      }
      if (s.type === 'carrier') continue;
      if (groupTarget && group.has(s.id) && !(groupTarget.type === 'sub' && s.type !== 'frigate')) {
        attack(s, groupTarget);
        // Weapons free on capital ships, or on any warship when we clearly outgun them; otherwise two rounds at a time.
        s.fireMode = CAPITAL.has(groupTarget.type) || (groupFree && WARSHIP.has(groupTarget.type)) ? 2 : 1;
        // A cruiser empties its magazines into a defended capital target.
        if (s.type === 'cruiser' && CAPITAL.has(groupTarget.type) && !g.salvoOn(s)) g.command(this.pid, { c: 'salvo', ids: [s.id] });
        continue;
      }
      // Surface combatants on their own: score every naval contact in reach.
      let best: Unit | null = null;
      let bs = 0;
      for (const { e, k } of navalFoes) {
        const d = Math.hypot(k.x - s.x, k.y - s.y);
        if (d > 32) continue;
        let match = 1;
        if (s.type === 'frigate' && e.type === 'sub') match = 3;
        if ((s.type === 'battleship' || s.type === 'cruiser') && e.type === 'destroyer') match = 1.6;
        if (e.type === 'sub' && s.type !== 'frigate') match = 0; // no anti-sub weapons
        if (e.type === 'merchant') match = 0.6;
        if (landing(e, k)) match *= 3;
        if (match > 0 && d > 12 && ourPower(k.x, k.y) < theirPower(k.x, k.y) * 0.9) continue;
        const score = ((VALUE[e.type] ?? 1) * match * (1.6 - (e.hp / e.maxHp) * 0.6) * (1 + 0.4 * Math.min(2, focus.get(e.id) ?? 0))) / (1 + d / 12);
        if (score > bs) {
          bs = score;
          best = e;
        }
      }
      if (best) {
        attack(s, best);
        // Spend magazines freely on capital ships; ration them on the rest.
        s.fireMode = CAPITAL.has(best.type) ? 2 : 1;
      } else s.fireMode = 1;
    }
    // Aircraft.
    const hq = this.home();
    const planes = mine.filter((u) => UNITS[u.type].domain === 'air' && !u.landed && u.order.k !== 'rtb');
    const anchor = ships.length ? { x: cx, y: cy } : hq ? { x: hq.x, y: hq.y } : { x: g.map.size / 2, y: g.map.size / 2 };
    // Enemy air defence we know of: SAM-armed ships and batteries, and missile-battery buildings.
    const samSites = known.filter(({ e }) => LINE.has(e.type) || e.type === 'carrier' || e.type === 'sam').map(({ k }) => ({ x: k.x, y: k.y }));
    for (const st of g.sites) if (st.type === 'battery' && st.owner >= 0 && g.team(st.owner) !== g.players[this.pid].team) samSites.push({ x: st.x, y: st.y });
    const samThreat = (x: number, y: number, r = 22) => samSites.filter((p) => Math.hypot(p.x - x, p.y - y) < r).length;
    // Strike package: two or more strike flights hit one ship together (value against its air
    // defence), with fighters escorting the lead flight.
    const inPackage = new Set<number>();
    const strikes = planes.filter((p) => p.type === 'strike' && p.order.k !== 'attack' && p.fuel > p.fuelMax * 0.6 && p.weapons.some((w) => w.max < 0 || w.ammo > 0));
    if (strikes.length >= 2 && g.time > this.strikeAt) {
      const t = known
        .filter(({ e, k }) => UNITS[e.type].domain === 'sea' && e.type !== 'lander' && Math.hypot(k.x - anchor.x, k.y - anchor.y) < 70)
        .map(({ e, k }) => ({ e, score: ((VALUE[e.type] ?? 1) * (1.6 - (e.hp / e.maxHp) * 0.6)) / (1 + samThreat(k.x, k.y, 16) * 0.7) / (1 + Math.hypot(k.x - anchor.x, k.y - anchor.y) / 40) }))
        .sort((a, b) => b.score - a.score)[0];
      if (t) {
        this.strikeAt = g.time + 30;
        for (const p of strikes) {
          attack(p, t.e);
          inPackage.add(p.id);
        }
        const fighters = planes.filter((p) => p.type === 'fighter' && p.order.k !== 'attack' && p.fuel > p.fuelMax * 0.5).slice(0, 2);
        if (fighters.length) g.command(this.pid, { c: 'escort', ids: fighters.map((f) => f.id), target: strikes[0].id });
        for (const f of fighters) inPackage.add(f.id);
      }
    }
    for (const pl of planes) {
      if (inPackage.has(pl.id) || pl.order.k === 'escort') continue;
      if (pl.fuel < pl.fuelMax * 0.35) continue; // bingo logic brings it home
      if (pl.type === 'strike') {
        // Strike only what is lightly defended (the target's own SAMs count as one).
        const t = known
          .filter(({ e, k }) => {
            if (UNITS[e.type].domain !== 'sea' || (e.type === 'lander' && !landing(e, k))) return false;
            const threat = samThreat(k.x, k.y, 26);
            const ownSam = LINE.has(e.type) || e.type === 'carrier' ? 1 : 0;
            // Unescorted soft targets, or a lone SAM ship that is already badly hurt.
            return threat === 0 || (threat === ownSam && ownSam === 1 && e.hp < e.maxHp * 0.5);
          })
          .sort((a, b) => ((VALUE[b.e.type] ?? 1) * (landing(b.e, b.k) ? 4 : 1)) / (1 + Math.hypot(b.k.x - pl.x, b.k.y - pl.y) / 25) - ((VALUE[a.e.type] ?? 1) * (landing(a.e, a.k) ? 4 : 1)) / (1 + Math.hypot(a.k.x - pl.x, a.k.y - pl.y) / 25))[0];
        if (t && Math.hypot(t.k.x - pl.x, t.k.y - pl.y) < 60) attack(pl, t.e);
      } else if (pl.type === 'fighter') {
        // Enemy aircraft threatening any of our units (merchants included), closest to the fighter first.
        const t = known
          .filter(({ e, k }) => UNITS[e.type].domain === 'air' && mine.some((m) => m.inside < 0 && UNITS[m.type].domain !== 'air' && Math.hypot(m.x - k.x, m.y - k.y) < 25))
          .sort((a, b) => Math.hypot(a.k.x - pl.x, a.k.y - pl.y) - Math.hypot(b.k.x - pl.x, b.k.y - pl.y))[0];
        // Intercept only over friendly water: never chase into enemy SAM cover.
        const front = this.frontPoint();
        const raid = this.raided[this.raided.length - 1];
        const cap = raid ? { x: raid.x, y: raid.y } : hq && front ? { x: (hq.x * 2 + front.x) / 3, y: (hq.y * 2 + front.y) / 3 } : anchor;
        if (t && Math.hypot(t.k.x - pl.x, t.k.y - pl.y) < 70 && samThreat(t.k.x, t.k.y) === 0) attack(pl, t.e);
        else if (pl.order.k !== 'patrol' || Math.hypot(pl.order.x - cap.x, pl.order.y - cap.y) > 8) g.command(this.pid, { c: 'move', ids: [pl.id], x: cap.x, y: cap.y });
      } else if (pl.type === 'recon') {
        // Orbit over the fleet, a little toward the enemy; drop a sonobuoy every 20 s over water.
        const front = this.frontPoint();
        const fx = hq ? anchor.x + (hq.x - anchor.x) * 0.25 : anchor.x;
        const fy = hq ? anchor.y + (hq.y - anchor.y) * 0.25 : anchor.y;
        void front;
        if (pl.order.k !== 'patrol' || Math.hypot(pl.order.x - fx, pl.order.y - fy) > 6) g.command(this.pid, { c: 'move', ids: [pl.id], x: fx, y: fy });
        if (g.time > this.buoyAt && ships.length && Math.hypot(pl.x - cx, pl.y - cy) < 15) {
          this.buoyAt = g.time + 20;
          g.command(this.pid, { c: 'mines', ids: [pl.id] });
        }
      }
    }
  }

  /**
   * Spend every dollar on what wins fights. Money is scarce, so the bot walks one priority list
   * each think and buys the first thing it still lacks: troop lift and a landing party first (no
   * landing, no islands), then destroyers (the most firepower per dollar), submarines and strike
   * flights to bleed the enemy's merchants, the counters to what it has seen, and a capital ship
   * only once the destroyer line exists. When a warship on the list is too dear, the money is held
   * for it: items further down may only spend what is left over.
   */
  private produce() {
    const g = this.game;
    const p = g.players[this.pid];
    const t = g.time;
    const count = new Map<UnitType, number>();
    for (const u of this.mine()) count.set(u.type, (count.get(u.type) ?? 0) + 1);
    for (const cat of ['naval', 'ground', 'air'] as const) for (const it of p.queues[cat]) count.set(it.type, (count.get(it.type) ?? 0) + 1);
    const n = (k: UnitType) => count.get(k) ?? 0;
    let lift = 0;
    for (const u of this.mine()) if (u.holdCap > 0 && UNITS[u.type].category === 'naval') lift += u.holdCap;
    const spare = this.spareTroops().filter((u) => u.type === 'infantry').length + p.queues.ground.filter((it) => it.type === 'infantry').length;
    const pressed = this.underPressure();
    const team = p.team;
    const held = new Set(g.sites.filter((s) => s.owner >= 0 && g.team(s.owner) === team).map((s) => s.island)).size;
    // Counter-build against what we have seen: frigates hunt subs, subs kill capital ships,
    // fighters meet strike flights.
    const know = g.knowledge.get(team);
    if (know) {
      for (const [id, k] of know) {
        const e = g.units.get(id);
        if (e && k.ident >= 1 && (e.type === 'sub' || WARSHIP.has(e.type) || e.type === 'strike')) this.spotted.set(id, e.type);
      }
    }
    const seen: Partial<Record<UnitType, number>> = {};
    for (const [id, type] of this.spotted) {
      if (!g.units.get(id) || g.units.get(id)!.dead) this.spotted.delete(id);
      else seen[type] = (seen[type] ?? 0) + 1;
    }
    const capType = CLASSES.capital.variants[p.fleet.capital].type;
    // Troops: enough for the next landing plus a few garrisons, never a crowd idling at home.
    const troopCap = Math.min(10, Math.ceil(held * 0.5) + 2 + Math.max(this.troopGoal, 2));
    const troopWant = Math.min(troopCap, n('infantry') + Math.max(0, Math.max(2, this.troopGoal) - spare));
    const ddg = n('destroyer');
    const capitals = (seen.battleship ?? 0) + (seen.carrier ?? 0) + (seen.cruiser ?? 0);
    const plan: { type: UnitType; want: number; save?: boolean }[] = [
      // Nothing to land with is the worst shortage of all.
      { type: 'corvette', want: lift < 2 ? n('corvette') + 1 : 0 },
      { type: 'infantry', want: spare < 2 ? Math.min(troopCap, n('infantry') + 2 - spare) : 0 },
      // Under pressure, batteries hold the coast while the fleet is rebuilt.
      { type: 'coastal', want: pressed ? Math.min(3, 1 + Math.floor(this.enemyFleetPower() / 15)) : 0 },
      // One hull ferries garrisons to open islands; the others carry the next assault.
      { type: 'corvette', want: (t > 200 ? 2 : 1) + (t > 720 ? 1 : 0) },
      // The landing party for the next operation: cheap, and without it the fleet takes nothing.
      { type: 'infantry', want: troopWant },
      { type: 'frigate', want: Math.min(2, (seen.sub ?? 0) > 0 ? 1 + Math.floor((seen.sub ?? 0) / 2) : t > 420 ? 1 : 0), save: true },
      // A quiet boat on their merchant lanes pays for itself many times over.
      { type: 'sub', want: t > 240 ? 1 + (t > 720 ? 1 : 0) + Math.min(2, capitals) : 0, save: true },
      { type: 'destroyer', want: 2, save: true },
      { type: 'strike', want: t > 150 ? 1 : 0 },
      { type: 'fighter', want: Math.min(3, Math.ceil((seen.strike ?? 0) / 2)) },
      { type: 'destroyer', want: 4, save: true },
      { type: 'strike', want: t > 480 ? 2 : 1 },
      { type: 'recon', want: t > 600 ? 1 : 0 },
      { type: capType, want: capType === 'carrier' ? (ddg >= 4 ? 1 : 0) : ddg >= 3 ? 1 + Math.floor(Math.max(0, ddg - 4) / 2) : 0, save: true },
      { type: 'destroyer', want: 12, save: true },
    ];
    // Only what one of our buildings can produce.
    const can = new Set(g.sites.filter((s) => s.owner === this.pid).map((s) => BUILDINGS[s.type].produces));
    let reserve = 0;
    for (const it of plan) {
      if (n(it.type) >= it.want) continue;
      const cat = UNITS[it.type].category as 'naval' | 'ground' | 'air';
      if (!can.has(cat) || p.queues[cat].length >= 3) continue;
      const cost = unitCost(it.type, p.faction);
      if (p.cash - reserve >= cost) {
        g.command(this.pid, { c: 'build', cat, type: it.type });
        count.set(it.type, n(it.type) + 1);
        continue;
      }
      if (it.save) reserve = Math.max(reserve, Math.min(p.cash, cost));
      if (reserve >= p.cash) break;
    }
  }

  // ------------------------------------------------------------------ strategy
  //
  // The bot plans in islands. Every island with buildings gets a value (resource sites most), a
  // distance from our ports and a threat estimate from what we have seen there. Uncontested islands
  // are taken by single transports ("grabs"): money islands first, a stake in the middle island
  // early. Contested or enemy-held islands are taken by one planned operation at a time: troops
  // load while the escorts gather, the fleet sails ahead of the transports, troops land only once
  // the sea around the island is ours, and the whole force backs off to port if the fight turns
  // against it, to regroup and try again later.

  /** Enemy units we have identified, remembered for a while after they drop off our sensors. */
  private updateIntel() {
    const g = this.game;
    for (const { e, k } of this.contacts()) this.intel.set(e.id, { type: e.type, x: k.x, y: k.y, t: g.time });
    for (const [id, m] of this.intel) {
      const u = g.units.get(id);
      if (!u || u.dead || g.time - m.t > 240) this.intel.delete(id);
    }
  }

  /** Enemy strength against ships around a point: warships, coastal batteries, strike flights, missile-battery buildings. */
  private navalThreat(x: number, y: number, r: number, maxAge = 240): number {
    const g = this.game;
    let p = 0;
    for (const m of this.intel.values()) {
      const age = g.time - m.t;
      if (age <= maxAge && Math.hypot(m.x - x, m.y - y) < r) p += (NAVAL_POWER[m.type] ?? 0) * 0.5 ** (age / SIGHTING_HALF_LIFE);
    }
    const team = g.players[this.pid].team;
    for (const s of g.sites) if (s.type === 'battery' && s.owner >= 0 && g.team(s.owner) !== team && Math.hypot(s.x - x, s.y - y) < r) p += 5;
    return p;
  }

  /** Enemy ground strength on an island (troops, batteries we have seen there). */
  private groundThreat(island: number): number {
    let p = 0;
    for (const m of this.intel.values()) if (UNITS[m.type].domain === 'land' && islandAt(this.game.map, m.x, m.y) === island) p += m.type === 'infantry' ? 2 : 1;
    return p;
  }

  /** Our ship's fighting strength: hull left, and offensive ammunition left (guns keep some punch when the missiles are gone). */
  private shipPower(u: Unit): number {
    return (NAVAL_POWER[u.type] ?? 0) * (u.hp / u.maxHp) * (0.4 + 0.6 * this.offAmmo(u));
  }

  /** Share of offensive magazines left (anti-ship and land-attack missiles, torpedoes). Unlimited guns, SAMs and mines do not count; 1 when there are none. */
  private offAmmo(u: Unit): number {
    let have = 0;
    let max = 0;
    for (const w of u.weapons) {
      if (w.max <= 0 || w.mod.ability || w.mod.proj === 'sam' || w.mod.proj === 'mine') continue;
      have += Math.max(0, w.ammo);
      max += w.max;
    }
    return max > 0 ? have / max : 1;
  }

  /** Badly hurt or nearly out of offensive ammunition: go to port. On the way home, stay until nearly whole and full again. */
  private needsRefit(u: Unit, home: boolean): boolean {
    if (home) return u.hp < u.maxHp * 0.9 || this.offAmmo(u) < 0.85;
    return u.hp < u.maxHp * (u.type === 'sub' ? 0.45 : 0.5) || this.offAmmo(u) < 0.25;
  }

  /** Warship on its way to port, or in port, to repair and rearm. */
  private refitting(id: number): boolean {
    return this.raids.get(id)?.home === true;
  }

  /** Every island with buildings that is not fully ours, scored. */
  private islandPlans(): IslandPlan[] {
    const g = this.game;
    const team = g.players[this.pid].team;
    const hq = this.home();
    if (!hq) return [];
    const ports = g.sites.filter((s) => s.owner >= 0 && g.team(s.owner) === team && s.dock).map((s) => s.dock!);
    if (!ports.length) ports.push({ x: hq.x, y: hq.y });
    const byIsland = new Map<number, SiteState[]>();
    for (const s of g.sites) byIsland.set(s.island, [...(byIsland.get(s.island) ?? []), s]);
    const out: IslandPlan[] = [];
    for (const [island, sites] of byIsland) {
      const open = sites.filter((s) => !(s.owner >= 0 && g.team(s.owner) === team));
      if (!open.length) continue;
      const x = sites.reduce((a, s) => a + s.x, 0) / sites.length;
      const y = sites.reduce((a, s) => a + s.y, 0) / sites.length;
      let value = 0;
      for (const s of open) value += SITE_VALUE[s.type] ?? 1;
      const centre = island === 0;
      if (centre) value *= 1.3;
      const enemyHeld = open.some((s) => s.owner >= 0);
      const dist = Math.min(...ports.map((p) => Math.hypot(p.x - x, p.y - y)));
      // What we have not seen we assume: a garrison per enemy building, and the enemy fleet near its home.
      const enemySites = open.filter((s) => s.owner >= 0).length;
      const enemyHome = open.some((s) => s.type === 'hq' && s.owner >= 0);
      const naval = Math.max(this.navalThreat(x, y, 18), enemyHome ? 10 : 0);
      const ground = Math.max(this.groundThreat(island), enemySites * 1.5 + (enemyHome ? 4 : 0));
      out.push({ island, x, y, target: open.slice().sort((a, b) => (SITE_VALUE[b.type] ?? 1) - (SITE_VALUE[a.type] ?? 1))[0], value, dist, naval, ground, enemyHeld, centre, contested: enemyHeld || naval > 0 || ground > 0 });
    }
    return out;
  }

  /** Strength of the enemy fleet we know of (seen in the last 3 minutes). */
  private enemyFleetPower(): number {
    let p = 0;
    for (const m of this.intel.values()) {
      const age = this.game.time - m.t;
      if (age <= 180 && WARSHIP.has(m.type)) p += (NAVAL_POWER[m.type] ?? 0) * 0.5 ** (age / SIGHTING_HALF_LIFE);
    }
    return p;
  }

  /** The enemy fleet we know of outweighs ours. */
  private underPressure(): boolean {
    let ours = 0;
    for (const u of this.mine()) if (LINE.has(u.type) || u.type === 'carrier') ours += this.shipPower(u);
    return this.enemyFleetPower() > ours * 0.9 + 3;
  }

  /** Ships with a hold, not busy, healthy. */
  private freeTransports(): Unit[] {
    const busy = this.busyShips();
    return this.mine().filter((u) => UNITS[u.type].category === 'naval' && u.holdCap > u.cargo.length && u.inside < 0 && !u.retreating && u.hp > u.maxHp * 0.5 && !busy.has(u.id));
  }

  /** Ships tied to a grab or the operation. */
  private busyShips(): Set<number> {
    const s = new Set(this.transports.map((t) => t.ship));
    if (this.op) for (const id of [...this.op.ships, ...this.op.escorts]) s.add(id);
    for (const [id, r] of this.raids) if (r.home) s.add(id);
    return s;
  }

  /** Idle troops free to ship out: on home, or on an island with nothing left to take (keeping one there as garrison). */
  private spareTroops(): Unit[] {
    const g = this.game;
    const team = g.players[this.pid].team;
    const hq = this.home();
    const byIsland = new Map<number, Unit[]>();
    for (const u of this.mine()) {
      if (UNITS[u.type].domain !== 'land' || u.inside >= 0 || u.order.k !== 'idle') continue;
      const isl = islandAt(g.map, u.x, u.y);
      if (isl < 0) continue;
      byIsland.set(isl, [...(byIsland.get(isl) ?? []), u]);
    }
    const out: Unit[] = [];
    for (const [isl, us] of byIsland) {
      if (g.sites.some((s) => s.island === isl && !(s.owner >= 0 && g.team(s.owner) === team))) continue; // still work here
      const keep = hq && isl === hq.island ? 0 : 1;
      // Infantry ships out first; batteries stay as garrison where possible.
      us.sort((a, b) => (a.type === 'infantry' ? 0 : 1) - (b.type === 'infantry' ? 0 : 1));
      out.push(...us.slice(0, Math.max(0, us.length - keep)));
    }
    return out;
  }

  /** Uncontested islands: one transport each, best value per distance first. */
  private grabs() {
    const g = this.game;
    this.transports = this.transports.filter((tr) => {
      const s = g.units.get(tr.ship);
      if (!s || s.dead) return false;
      if (tr.state === 'sailing' && s.cargo.length === 0 && s.order.k !== 'unload') return false;
      return tr.state !== 'done';
    });
    let plans = this.islandPlans().filter((p) => !p.contested && !this.transports.some((t) => t.island === p.island) && !((this.avoid.get(p.island) ?? 0) > g.time));
    const hq = this.home();
    // Troops grouped by the island they wait on. Home groups wait for a full load; an outpost
    // sends what it has.
    const groups = new Map<number, Unit[]>();
    for (const u of this.spareTroops()) {
      const isl = islandAt(g.map, u.x, u.y);
      groups.set(isl, [...(groups.get(isl) ?? []), u]);
    }
    // After the opening, keep a transport out of ferry work for the next operation.
    const hulls = this.mine().filter((u) => u.holdCap > 0 && UNITS[u.type].category === 'naval').length;
    const opWanted = !this.op && g.time > 300 && hulls >= 2 && this.islandPlans().some((p) => p.contested && !(this.avoid.get(p.island)! > g.time));
    const maxGrabs = Math.min(6, opWanted ? Math.max(1, hulls - 1) : hulls);
    // The largest group is the landing force being gathered: grabs leave it enough troops.
    const largest = [...groups.keys()].sort((a, b) => groups.get(b)!.length - groups.get(a)!.length)[0];
    if (largest !== undefined && this.troopGoal > 0) groups.get(largest)!.splice(0, this.troopGoal);
    for (const [isl, troops] of groups) {
      while (plans.length && this.transports.length < maxGrabs) {
        const atHome = hq && isl === hq.island;
        if (troops.length < (atHome && g.time > 90 ? 2 : 1)) break;
        const gx = troops.reduce((a, u) => a + u.x, 0) / troops.length;
        const gy = troops.reduce((a, u) => a + u.y, 0) / troops.length;
        const ships = this.freeTransports();
        if (!ships.length) break;
        const ship = ships.sort((a, b) => Math.hypot(a.x - gx, a.y - gy) - Math.hypot(b.x - gx, b.y - gy))[0];
        // Best value for the trip from these troops: money islands near us first.
        // One squad takes one or two sites, so a big island is worth no more than a rich small one to it:
        // nearby money first, then a stake in the middle.
        const score = (p: IslandPlan) => Math.min(p.value, p.centre ? 9 : 7) / (1 + Math.hypot(p.x - gx, p.y - gy) / 15);
        const plan = plans.slice().sort((a, b) => score(b) - score(a))[0];
        plans = plans.filter((p) => p !== plan);
        const squad = troops.splice(0, Math.min(ship.holdCap - ship.cargo.length, plan.centre ? 3 : 2));
        // The loading clock starts when the ship can be there.
        const trip = Math.hypot(ship.x - gx, ship.y - gy) / ship.maxSpeed;
        this.transports.push({ ship: ship.id, island: plan.island, tx: plan.target.x, ty: plan.target.y, state: 'loading', since: g.time + trip });
        g.command(this.pid, { c: 'board', ids: squad.map((u) => u.id), ship: ship.id });
        // Always re-order the ship: it may still carry an old fleet order away from the troops.
        g.command(this.pid, { c: 'move', ids: [ship.id], x: gx, y: gy, mode: 'move' });
      }
    }
    for (const tr of this.transports) {
      const ship = g.units.get(tr.ship)!;
      // Troops that boarded after the unload order are still aboard: land them too.
      if (tr.state === 'sailing' && ship.order.k === 'idle' && ship.cargo.length > 0) g.command(this.pid, { c: 'unload', ship: ship.id, ids: [], x: tr.tx, y: tr.ty });
      if (tr.state !== 'loading') continue;
      const boarding = this.mine().some((u) => u.order.k === 'board' && u.order.ship === ship.id) || [...g.units.values()].some((l) => l.type === 'lander' && l.ferry?.ship === ship.id);
      if ((!boarding && ship.cargo.length > 0) || (g.time - tr.since > 110 && ship.cargo.length > 0)) {
        tr.state = 'sailing';
        g.command(this.pid, { c: 'unload', ship: ship.id, ids: [], x: tr.tx, y: tr.ty });
      } else if (g.time - tr.since > 130) tr.state = 'done';
    }
  }

  /** One planned, escorted assault at a time on a contested or enemy-held island. */
  private operation() {
    const g = this.game;
    const hq = this.home();
    if (!hq) return;
    const op = this.op;
    const alive = (id: number) => {
      const u = g.units.get(id);
      return u && !u.dead ? u : null;
    };
    if (!op) {
      if (g.time < this.opCooldown) return;
      const plans = this.islandPlans();
      // Open grabs come first, except the middle island, which is worth fighting for early.
      const easy = plans.filter((p) => !p.contested).length;
      // Warships escort; corvettes carry the troops.
      const fleet = this.mine().filter((u) => (LINE.has(u.type) || u.holdCap > 0) && UNITS[u.type].category === 'naval' && u.inside < 0 && !u.retreating && !this.refitting(u.id) && !this.transports.some((t) => t.ship === u.id));
      const power = fleet.reduce((a, u) => a + this.shipPower(u), 0);
      // Troops for the landing come from one island, so the transports make one pick-up.
      const groups = new Map<number, Unit[]>();
      for (const u of this.spareTroops()) {
        const isl = islandAt(g.map, u.x, u.y);
        groups.set(isl, [...(groups.get(isl) ?? []), u]);
      }
      const group = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const troops = group.length;
      const lift = fleet.reduce((a, u) => a + u.holdCap - u.cargo.length, 0);
      const needFor = (p: IslandPlan) => Math.min(6, lift, Math.ceil(p.ground * 0.75) + 2);
      // Only fights we expect to win: naval superiority at the target, with a margin.
      const best = plans
        .filter((p) => p.contested && !(this.avoid.get(p.island)! > g.time))
        .filter((p) => g.time > 180 || p.centre || easy === 0)
        // What waits on the way counts too (batteries and ships between us and the target).
        .map((p) => ({ ...p, naval: Math.max(p.naval, this.navalThreat((hq.x + p.x) / 2, (hq.y + p.y) / 2, 20)) }))
        // Small landings where no naval defence is known; elsewhere a clear margin.
        .filter((p) => power >= (p.naval < 1 ? 6 : p.naval * 1.4 + 4))
        .sort((a, b) => b.value / (1 + b.dist / 25) / (1 + b.naval / 10) - a.value / (1 + a.dist / 25) / (1 + a.naval / 10))[0];
      // Build up the landing force first; production reads this.
      this.troopGoal = best && fleet.length >= 2 ? needFor(best) : 0;
      if (!best || fleet.length < 2 || this.troopGoal < 2 || troops < this.troopGoal) return;
      const need = this.troopGoal;
      this.troopGoal = 0;
      // Staging: off our nearest held coast toward the target.
      const sx = hq.x + (best.x - hq.x) * 0.35;
      const sy = hq.y + (best.y - hq.y) * 0.35;
      const holds = fleet.filter((u) => u.holdCap > u.cargo.length).sort((a, b) => b.holdCap - a.holdCap);
      const ships: number[] = [];
      let cap = 0;
      for (const s of holds) {
        if (cap >= need) break;
        ships.push(s.id);
        cap += s.holdCap - s.cargo.length;
      }
      // A task force, not the whole navy: the ships nearest the target until it is clearly stronger
      // than the defence there. The rest stay free to hunt, raid and defend.
      const want = best.naval * 2 + 8;
      let force = fleet.filter((u) => ships.includes(u.id)).reduce((a, u) => a + this.shipPower(u), 0);
      const escorts: number[] = [];
      for (const u of fleet.filter((u) => !ships.includes(u.id)).sort((a, b) => Math.hypot(a.x - best.x, a.y - best.y) - Math.hypot(b.x - best.x, b.y - best.y))) {
        if (force >= want) break;
        escorts.push(u.id);
        force += this.shipPower(u);
      }
      this.stats.ops++;
      this.op = { island: best.island, x: best.x, y: best.y, tx: best.target.x, ty: best.target.y, sx, sy, ships, escorts, state: 'load', since: g.time, startPower: force, need, want };
      // Board the group; the transports come to it.
      const gx = group.reduce((a, u) => a + u.x, 0) / group.length;
      const gy = group.reduce((a, u) => a + u.y, 0) / group.length;
      let k = 0;
      let trip = 0;
      for (const id of ships) {
        const s = alive(id)!;
        const n = s.holdCap - s.cargo.length;
        const ids = group.slice(k, k + n).map((u) => u.id);
        k += n;
        if (ids.length) g.command(this.pid, { c: 'board', ids, ship: id });
        g.command(this.pid, { c: 'move', ids: [id], x: gx, y: gy, mode: 'move' });
        trip = Math.max(trip, Math.hypot(s.x - gx, s.y - gy) / s.maxSpeed);
      }
      this.op.since = g.time + trip;
      if (escorts.length) g.command(this.pid, { c: 'move', ids: escorts, x: sx, y: sy, mode: 'move' });
      return;
    }
    // Live members only.
    op.ships = op.ships.filter((id) => alive(id));
    // Escorts that left to refit are no longer part of the force.
    op.escorts = op.escorts.filter((id) => alive(id) && !this.refitting(id));
    // Healthy free warships reinforce the assault while the task force is below the strength it needs.
    if (op.state !== 'load') {
      let force = [...op.ships, ...op.escorts].reduce((a, id) => a + this.shipPower(alive(id)!), 0);
      const busy = this.busyShips();
      for (const u of this.mine()) {
        if (force >= op.want) break;
        if (LINE.has(u.type) && !busy.has(u.id) && u.inside < 0 && !u.retreating && u.hp > u.maxHp * 0.6 && !((this.noEngage.get(u.id) ?? 0) > g.time)) {
          op.escorts.push(u.id);
          force += this.shipPower(u);
        }
      }
    }
    const all = [...op.ships, ...op.escorts].map((id) => alive(id)!).filter((u) => !u.retreating);
    const power = all.reduce((a, u) => a + this.shipPower(u), 0);
    const cx = all.length ? all.reduce((a, u) => a + u.x, 0) / all.length : op.sx;
    const cy = all.length ? all.reduce((a, u) => a + u.y, 0) / all.length : op.sy;
    const end = (success: boolean, why = 'won') => {
      this.op = null;
      if (success) this.stats.won++;
      else this.stats.aborted++;
      this.stats.why[why] = (this.stats.why[why] ?? 0) + 1;
      this.opCooldown = g.time + (success ? 10 : 60);
      if (!success) this.avoid.set(op.island, g.time + 150);
    };
    // Back out when the fight turns against us; regroup at port and come back later.
    if (op.state !== 'load' && (power < op.startPower * 0.4 || this.navalThreat(cx, cy, 20, 30) > power * 1.15)) {
      const port = this.nearestOwnPort(cx, cy) ?? { x: hq.x, y: hq.y };
      const ids = all.map((u) => u.id);
      if (ids.length) g.command(this.pid, { c: 'move', ids, x: port.x, y: port.y, mode: 'move' });
      for (const id of ids) this.noEngage.set(id, g.time + 45);
      this.stats.breakoffs++;
      end(false, power < op.startPower * 0.4 ? 'beaten' : 'outgunned');
      return;
    }
    if (!all.length) {
      end(false, 'no ships');
      return;
    }
    const transports = op.ships.map((id) => alive(id)!);
    const cargo = transports.reduce((a, s) => a + s.cargo.length, 0);
    // Assault point: off the island's coast on our side; transports wait 5 km behind it.
    const dx = op.sx - op.x;
    const dy = op.sy - op.y;
    const dl = Math.hypot(dx, dy) || 1;
    const ax = op.x + (dx / dl) * 6;
    const ay = op.y + (dy / dl) * 6;
    const bx = op.x + (dx / dl) * 11;
    const by = op.y + (dy / dl) * 11;
    const reorder = g.time >= this.opOrderAt;
    if (reorder) this.opOrderAt = g.time + 8;
    const idleOrMoving = (u: Unit) => u.order.k !== 'attack' && u.order.k !== 'unload';
    switch (op.state) {
      case 'load': {
        const boarding = this.mine().some((u) => u.order.k === 'board' && op.ships.includes(u.order.ship)) || [...g.units.values()].some((l) => l.type === 'lander' && !!l.ferry && op.ships.includes(l.ferry.ship));
        if ((!boarding && cargo >= Math.min(op.need, 2)) || (g.time - op.since > 120 && cargo > 0)) {
          op.state = 'sail';
          op.since = g.time;
          // Sail from where the force is now.
          op.sx = cx;
          op.sy = cy;
        } else if (g.time - op.since > 150) end(false, 'load timeout');
        break;
      }
      case 'sail': {
        if (reorder) {
          const esc = op.escorts.map((id) => alive(id)!).filter(idleOrMoving).map((u) => u.id);
          if (esc.length) g.command(this.pid, { c: 'move', ids: esc, x: ax, y: ay });
          g.command(this.pid, { c: 'move', ids: op.ships, x: bx, y: by, mode: 'move' });
        }
        // Land once the transports are off the island, the escorts are on station and the sea is ours.
        const near = transports.length > 0 && transports.every((s) => Math.hypot(s.x - bx, s.y - by) < 6);
        const escorted = op.escorts.length === 0 || op.escorts.some((id) => Math.hypot(alive(id)!.x - ax, alive(id)!.y - ay) < 8);
        if (near && escorted && this.navalThreat(ax, ay, 15, 60) <= power * 0.7) {
          op.state = 'land';
          op.since = g.time;
          for (const s of transports) if (s.cargo.length) g.command(this.pid, { c: 'unload', ship: s.id, ids: [], x: op.tx, y: op.ty });
          // Battleships shell the beach while the troops go in.
          const bbs = op.escorts.filter((id) => alive(id)?.type === 'battleship');
          if (bbs.length) g.command(this.pid, { c: 'bombard', ids: bbs, x: op.tx, y: op.ty });
        } else if (g.time - op.since > 120 + (Math.hypot(op.sx - op.x, op.sy - op.y) / 0.25) * 1.5) end(false, 'sail timeout');
        break;
      }
      case 'land': {
        if (reorder) {
          const esc = op.escorts.map((id) => alive(id)!).filter(idleOrMoving).map((u) => u.id);
          if (esc.length) g.command(this.pid, { c: 'move', ids: esc, x: ax, y: ay });
        }
        if (cargo === 0) {
          op.state = 'hold';
          op.since = g.time;
        } else if (g.time - op.since > 120) {
          for (const s of transports) if (s.cargo.length && s.order.k !== 'unload') g.command(this.pid, { c: 'unload', ship: s.id, ids: [], x: op.tx, y: op.ty });
          if (g.time - op.since > 200) end(false, 'land timeout');
        }
        break;
      }
      case 'hold': {
        // Escorts cover the island until it is ours or our troops there are gone.
        if (reorder) {
          const esc = all.filter(idleOrMoving).map((u) => u.id);
          if (esc.length) g.command(this.pid, { c: 'move', ids: esc, x: ax, y: ay });
        }
        const team = g.players[this.pid].team;
        const left = g.sites.filter((s) => s.island === op.island && !(s.owner >= 0 && g.team(s.owner) === team)).length;
        const ours = this.mine().some((u) => UNITS[u.type].domain === 'land' && u.inside < 0 && islandAt(g.map, u.x, u.y) === op.island);
        if (left === 0) end(true);
        // Troops may still be in the landing craft for a while.
        else if ((!ours && g.time - op.since > 40) || g.time - op.since > 240) end(false, 'hold lost');
        break;
      }
    }
  }

  private nearestOwnPort(x: number, y: number): { x: number; y: number } | null {
    const g = this.game;
    const team = g.players[this.pid].team;
    let best: { x: number; y: number } | null = null;
    let bd = 1e9;
    for (const s of g.sites) {
      if (!s.dock || s.owner < 0 || g.team(s.owner) !== team) continue;
      const d = Math.hypot(s.dock.x - x, s.dock.y - y);
      if (d < bd) {
        bd = d;
        best = s.dock;
      }
    }
    return best;
  }

  /** Where the action is: the operation's target, else the best open island. */
  private frontPoint(): { x: number; y: number } {
    if (this.op) return { x: this.op.x, y: this.op.y };
    const best = this.islandPlans().sort((a, b) => b.value / (1 + b.dist / 20) - a.value / (1 + a.dist / 20))[0];
    return best ? { x: best.x, y: best.y } : { x: this.game.map.size / 2, y: this.game.map.size / 2 };
  }

  /** Warships not on a grab or the operation: defend what we hold, fight only winnable battles. */
  private fleet() {
    const g = this.game;
    if (g.time < this.fleetOrderAt) return;
    this.fleetOrderAt = g.time + 12;
    const hq = this.home();
    if (!hq) return;
    const busy = this.busyShips();
    const ships = this.mine().filter((u) => (LINE.has(u.type) || u.type === 'carrier' || u.type === 'sub') && !busy.has(u.id) && !u.retreating && u.inside < 0 && !((this.noEngage.get(u.id) ?? 0) > g.time));
    if (!ships.length) return;
    const myTeam = g.players[this.pid].team;
    const surface = ships.filter((s) => s.type !== 'sub' && s.type !== 'carrier' && s.order.k !== 'attack');
    const power = surface.reduce((a, u) => a + this.shipPower(u), 0);
    // Threatened island of ours that we can relieve? If the threat is too strong, gather at our
    // port nearest to it instead, under the batteries, and fight there.
    let rally: { x: number; y: number } | null = null;
    let worst = 0;
    let outgunned: { x: number; y: number } | null = null;
    let worstOut = 0;
    for (const s of g.sites) {
      if (s.owner < 0 || g.team(s.owner) !== myTeam) continue;
      const th = this.navalThreat(s.x, s.y, 25, 90);
      if (th <= 0) continue;
      if (th * 1.1 <= power) {
        if (th > worst) {
          worst = th;
          rally = { x: s.x, y: s.y };
        }
      } else if (th > worstOut) {
        worstOut = th;
        outgunned = { x: s.x, y: s.y };
      }
    }
    if (!rally && (outgunned || this.underPressure())) {
      const near = outgunned ?? { x: hq.x, y: hq.y };
      rally = this.nearestOwnPort(near.x, near.y) ?? { x: hq.x, y: hq.y };
    }
    if (!rally && !this.op) {
      // Nothing of ours to defend: take the fight to them where we are stronger.
      const h = this.huntTarget(surface, power);
      if (h) rally = h;
    }
    if (!rally) {
      // Screen the next objective from our side, or join the operation's staging point.
      const f = this.op ? { x: this.op.sx, y: this.op.sy } : this.frontPoint();
      rally = { x: hq.x + (f.x - hq.x) * 0.5, y: hq.y + (f.y - hq.y) * 0.5 };
    }
    if (surface.length) g.command(this.pid, { c: 'move', ids: surface.map((s) => s.id), x: rally.x, y: rally.y });
    const cvs = ships.filter((s) => s.type === 'carrier');
    if (cvs.length) {
      const dx = hq.x - rally.x;
      const dy = hq.y - rally.y;
      const dl = Math.hypot(dx, dy) || 1;
      g.command(this.pid, { c: 'move', ids: cvs.map((s) => s.id), x: rally.x + (dx / dl) * Math.min(12, dl), y: rally.y + (dy / dl) * Math.min(12, dl) });
    }
    // Submarines are handled by subRaids().
  }

  /** Current objective of the free fleet, kept for a while so it does not dither. */
  private hunt: { x: number; y: number; until: number; kind: string } | null = null;

  /**
   * Where the free fleet attacks: a known enemy squadron it outguns, or else the enemy's merchant
   * lanes (the docks of their resource islands, where every cargo run starts), or an enemy-held
   * island with weak defences. Merchants pay most of the enemy's income, and a fleet parked on a
   * lane both starves them and draws their fleet into a fight on our terms.
   */
  private huntTarget(surface: Unit[], power: number): { x: number; y: number } | null {
    const g = this.game;
    // A lone hull is picked off: hunt in pairs at least.
    if (surface.length < 2 || power < 8) return null;
    const team = g.players[this.pid].team;
    const cx = surface.reduce((a, u) => a + u.x, 0) / surface.length;
    const cy = surface.reduce((a, u) => a + u.y, 0) / surface.length;
    // Stay on an objective while it is still safe; leave it when the defence there gets too strong.
    if (this.hunt && g.time < this.hunt.until && this.navalThreat(this.hunt.x, this.hunt.y, 16, 60) * 1.2 <= power) return this.hunt;
    const cands: { x: number; y: number; score: number; kind: string }[] = [];
    // Enemy squadrons we have seen lately.
    for (const m of this.intel.values()) {
      if (g.time - m.t > 60 || !WARSHIP.has(m.type)) continue;
      const th = this.navalThreat(m.x, m.y, 14, 60);
      if (th * 1.25 > power) continue;
      cands.push({ x: m.x, y: m.y, score: (6 + th) / (1 + Math.hypot(m.x - cx, m.y - cy) / 30), kind: 'fleet' });
    }
    // Merchant lanes and weakly held enemy islands.
    for (const st of g.sites) {
      if (st.owner < 0 || g.team(st.owner) === team) continue;
      const at = st.dock ?? st;
      // Unseen defences assumed at their home: batteries and the home fleet.
      const th = Math.max(this.navalThreat(at.x, at.y, 16, 120), st.home !== undefined || st.type === 'hq' ? 10 : 0);
      if (th * 1.3 > power) continue;
      const v = st.type === 'resource' ? 5 : st.type === 'hq' ? 3 : 1.5;
      cands.push({ x: at.x, y: at.y, score: v / (1 + Math.hypot(at.x - cx, at.y - cy) / 30) / (1 + th / 8), kind: st.type });
    }
    const best = cands.sort((a, b) => b.score - a.score)[0];
    if (!best) {
      this.hunt = null;
      return null;
    }
    this.hunt = { x: best.x, y: best.y, until: g.time + 60, kind: best.kind };
    return this.hunt;
  }

  /** Strike flights support the operation (enemy ground units and soft ships at the target); otherwise loiter at the front. */
  private air() {
    const g = this.game;
    if (g.time < this.airOrderAt) return;
    this.airOrderAt = g.time + 15;
    const planes = this.mine().filter((u) => u.type === 'strike' && !u.landed && u.order.k !== 'attack' && u.order.k !== 'rtb' && u.fuel > u.fuelMax * 0.4);
    const front = this.frontPoint();
    for (const pl of planes) {
      if (this.op && this.op.state !== 'load') {
        const t = this.contacts()
          .filter(({ e, k }) => (UNITS[e.type].domain === 'land' || e.type === 'merchant') && Math.hypot(k.x - this.op!.x, k.y - this.op!.y) < 12 && e.type !== 'sam')
          .sort((a, b) => (b.e.type === 'coastal' ? 1 : 0) - (a.e.type === 'coastal' ? 1 : 0))[0];
        if (t) {
          g.command(this.pid, { c: 'attack', ids: [pl.id], target: t.e.id });
          continue;
        }
      }
      // Nothing to support: hunt merchants on an enemy lane that their warships do not cover.
      const lane =
        this.raidTargets()
          .filter((r) => r.unit === undefined && Math.hypot(r.x - pl.x, r.y - pl.y) < 55 && this.navalThreat(r.x, r.y, 14, 120) < 4)
          .sort((a, b) => Math.hypot(a.x - pl.x, a.y - pl.y) - Math.hypot(b.x - pl.x, b.y - pl.y))[pl.id % 2] ?? null;
      const to = lane ?? front;
      g.command(this.pid, { c: 'move', ids: [pl.id], x: to.x, y: to.y });
    }
  }

  // ------------------------------------------------------------------ submarine raids
  //
  // Subs hunt the enemy's rear: merchant lanes and capital ships in port, not the front line.
  // Radar cannot see a submerged boat; only sonar can (destroyers, enemy subs, sonobuoys), so
  // each sub plans its route around the enemy sonar we know of, closes in quietly, strikes, and
  // slips away along a safe route to look for the next target.

  /** Coarse water grid for route planning (2 km cells): 1 = open water. */
  private raidGrid: { n: number; h: number; water: Uint8Array } | null = null;

  private gridFor() {
    if (this.raidGrid) return this.raidGrid;
    const m = this.game.map;
    const h = 2;
    const n = Math.ceil(m.size / h);
    const water = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // Water only if most of the cell is deep water.
        let wet = 0;
        for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.5]]) if (m.nav[cellOf(m, (i + a) * h, (j + b) * h)] === 0) wet++;
        water[j * n + i] = wet >= 4 ? 1 : 0;
      }
    }
    this.raidGrid = { n, h, water };
    return this.raidGrid;
  }

  /** Enemy sonar we know of (fresh sightings only), as circles a sub should keep out of. */
  private sonarThreats(): { x: number; y: number; r: number }[] {
    const g = this.game;
    const out: { x: number; y: number; r: number }[] = [];
    for (const m of this.intel.values()) {
      if (g.time - m.t > 90) continue;
      // Destroyers hear a sub at about 15-18 km at speed; enemy subs and AEW (buoys) closer.
      const r = m.type === 'frigate' ? 19 : m.type === 'sub' ? 11 : m.type === 'recon' ? 9 : 0;
      if (r) out.push({ x: m.x, y: m.y, r: r + 2 });
    }
    return out;
  }

  /** A* on the coarse grid; danger (inside known sonar) costs 12x. Returns waypoints and cost. */
  private safeRoute(sx: number, sy: number, tx: number, ty: number, threats: { x: number; y: number; r: number }[]): { pts: [number, number][]; cost: number } | null {
    const { n, h, water } = this.gridFor();
    const idx = (x: number, y: number) => Math.max(0, Math.min(n - 1, Math.floor(y / h))) * n + Math.max(0, Math.min(n - 1, Math.floor(x / h)));
    const snap = (k: number) => {
      if (water[k]) return k;
      const i0 = k % n;
      const j0 = (k - i0) / n;
      for (let r = 1; r < 6; r++)
        for (let j = j0 - r; j <= j0 + r; j++)
          for (let i = i0 - r; i <= i0 + r; i++) if (i >= 0 && j >= 0 && i < n && j < n && water[j * n + i]) return j * n + i;
      return -1;
    };
    const s = snap(idx(sx, sy));
    const t = snap(idx(tx, ty));
    if (s < 0 || t < 0) return null;
    const danger = (k: number) => {
      const x = ((k % n) + 0.5) * h;
      const y = (Math.floor(k / n) + 0.5) * h;
      let d = 0;
      for (const c of threats) {
        const q = Math.hypot(c.x - x, c.y - y);
        if (q < c.r) d = Math.max(d, 1 - (q / c.r) * 0.5);
      }
      return d;
    };
    const gS = new Float32Array(n * n).fill(Infinity);
    const came = new Int32Array(n * n).fill(-1);
    const closed = new Uint8Array(n * n);
    const open: number[] = [s];
    gS[s] = 0;
    const hx = (k: number) => Math.hypot((k % n) - (t % n), Math.floor(k / n) - Math.floor(t / n)) * h;
    while (open.length) {
      // Small grid: a linear scan for the best open node is fast enough.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (gS[open[i]] + hx(open[i]) < gS[open[bi]] + hx(open[bi])) bi = i;
      const k = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (k === t) break;
      if (closed[k]) continue;
      closed[k] = 1;
      const i = k % n;
      const j = (k - i) / n;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const kk = jj * n + ii;
          if (!water[kk] || closed[kk]) continue;
          // No corner cutting past land.
          if (di && dj && (!water[j * n + ii] || !water[jj * n + i])) continue;
          const c = gS[k] + Math.hypot(di, dj) * h * (1 + 12 * danger(kk));
          if (c < gS[kk]) {
            gS[kk] = c;
            came[kk] = k;
            open.push(kk);
          }
        }
    }
    if (!Number.isFinite(gS[t])) return null;
    const cells: number[] = [];
    for (let k = t; k !== -1; k = came[k]) cells.push(k);
    cells.reverse();
    // Keep every 4th cell (about 8 km legs); the unit's own pathfinding does the fine work.
    const pts: [number, number][] = [];
    for (let i = 4; i < cells.length; i += 4) pts.push([((cells[i] % n) + 0.5) * h, (Math.floor(cells[i] / n) + 0.5) * h]);
    pts.push([tx, ty]);
    return { pts, cost: gS[t] };
  }

  /** Where a sub can do damage behind the lines: capital ships we have seen, the enemy's merchant lanes. */
  private raidTargets(): { x: number; y: number; value: number; unit?: number }[] {
    const g = this.game;
    const team = g.players[this.pid].team;
    const out: { x: number; y: number; value: number; unit?: number }[] = [];
    for (const [id, m] of this.intel) {
      if (g.time - m.t > 150) continue;
      if (CAPITAL.has(m.type)) out.push({ x: m.x, y: m.y, value: m.type === 'carrier' ? 10 : 8, unit: id });
    }
    for (const s of g.sites) {
      if (s.type !== 'resource' || !s.dock || s.owner < 0 || g.team(s.owner) === team) continue;
      // Lie in wait on the lane, a little out from the resource island.
      const hq = g.sites.find((h) => h.type === 'hq' && h.owner === s.owner);
      const port = hq?.dock ?? hq ?? s.dock;
      out.push({ x: s.dock.x * 0.7 + port.x * 0.3, y: s.dock.y * 0.7 + port.y * 0.3, value: 4 });
    }
    return out;
  }

  /**
   * Submarine raids, and the refit cycle of every warship: a boat or surface warship that is badly
   * hurt or nearly out of offensive ammunition sails to the nearest port (subs through safe water),
   * stays until repaired and rearmed (the port does the work while no one shoots at it), then goes
   * back to duty. Surface warships only pass through here for refits.
   */
  private raidsAndRefits() {
    const g = this.game;
    const boats = this.mine().filter((u) => (u.type === 'sub' || LINE.has(u.type)) && u.inside < 0 && !u.retreating);
    for (const id of this.raids.keys()) if (!boats.some((s) => s.id === id)) this.raids.delete(id);
    if (!boats.length) return;
    let threats: { x: number; y: number; r: number }[] | null = null;
    for (const sub of boats) {
      const isSub = sub.type === 'sub';
      let r = this.raids.get(sub.id);
      // A refit that drags on (port under fire) ends after 5 minutes.
      const refit = this.needsRefit(sub, !!r?.home && g.time - r.at < 300);
      if (!isSub && !refit) {
        if (r) this.raids.delete(sub.id);
        continue;
      }
      // A sub busy with a target (tactics gave it an attack order), or rearming: leave it.
      if (isSub && (sub.order.k === 'attack' || sub.rearming)) continue;
      if (refit) {
        // Home to repair or reload.
        const port = this.nearestOwnPort(sub.x, sub.y);
        if (port && (!r || r.home !== true)) {
          const route = isSub ? this.safeRoute(sub.x, sub.y, port.x, port.y, (threats ??= this.sonarThreats())) : null;
          r = { tx: port.x, ty: port.y, pts: route?.pts ?? [[port.x, port.y]], i: 0, at: g.time, home: true };
          this.raids.set(sub.id, r);
        }
      } else if (!r || r.home || g.time - r.at > 45 || Math.hypot(sub.x - r.tx, sub.y - r.ty) < 4) {
        // New plan: the best target by value per (danger-weighted) route length; spread the boats out.
        const taken = new Set([...this.raids.entries()].filter(([id]) => id !== sub.id).map(([, v]) => `${Math.round(v.tx)},${Math.round(v.ty)}`));
        let best: { tx: number; ty: number; pts: [number, number][]; score: number } | null = null;
        for (const c of this.raidTargets()) {
          if (taken.has(`${Math.round(c.x)},${Math.round(c.y)}`)) continue;
          // Arrived at a lane with nothing there: try another.
          if (r && Math.hypot(sub.x - c.x, sub.y - c.y) < 4 && !c.unit) continue;
          const route = this.safeRoute(sub.x, sub.y, c.x, c.y, (threats ??= this.sonarThreats()));
          if (!route) continue;
          const score = c.value / (1 + route.cost / 30);
          if (!best || score > best.score) best = { tx: c.x, ty: c.y, pts: route.pts, score };
        }
        if (best) {
          r = { tx: best.tx, ty: best.ty, pts: best.pts, i: 0, at: g.time, home: false };
          this.raids.set(sub.id, r);
        }
      }
      if (!r) continue;
      // Next leg: skip waypoints we have reached.
      while (r.i < r.pts.length - 1 && Math.hypot(sub.x - r.pts[r.i][0], sub.y - r.pts[r.i][1]) < 3) r.i++;
      const [wx, wy] = r.pts[r.i];
      const o = sub.order;
      if (!(o.k === 'move' && Math.hypot(o.x - wx, o.y - wy) < 0.5)) g.command(this.pid, { c: 'move', ids: [sub.id], x: wx, y: wy, mode: 'move' });
      sub.fireMode = 1;
    }
  }

  private groundIdle() {
    const g = this.game;
    const myTeam = g.players[this.pid].team;
    for (const u of this.mine()) {
      if (UNITS[u.type].domain !== 'land' || u.inside >= 0 || u.order.k !== 'idle') continue;
      const isl = islandAt(g.map, u.x, u.y);
      const hq = this.home();
      if (hq && isl === hq.island) continue; // reserves wait for transport
      let best: SiteState | null = null;
      let bd = 1e9;
      for (const s of g.sites) {
        if (s.island !== isl) continue;
        if (s.owner >= 0 && g.team(s.owner) === myTeam) continue;
        const d = Math.hypot(s.x - u.x, s.y - u.y);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (best && bd > 0.8) g.command(this.pid, { c: 'move', ids: [u.id], x: best.x, y: best.y });
    }
  }
}
