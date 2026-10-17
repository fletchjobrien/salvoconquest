// Computer opponent. Uses only what its team can detect for targeting.
import { BUILDABLE, UNITS, UnitType, unitCost, counterOf } from './defs';
import { canDeployAt, deployZone } from './game';
import type { Contact, Game, Unit, SiteState } from './game';
import { islandAt } from './map';

/** How dangerous a unit is to a fleet (hp-weighted when it is ours). */
const NAVAL_POWER: Partial<Record<UnitType, number>> = { battleship: 8, destroyer: 5, sub: 3, carrier: 3, coastal: 4, strike: 3 };
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
  /** Islands we were beaten back from, until when. */
  private avoid = new Map<number, number>();
  /** Ships ordered to break off: no new engagements until then. */
  private noEngage = new Map<number, number>();

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
    this.air();
    this.groundIdle();
  }

  /** Deployment phase: buy a balanced opening force (keeping a reserve), place it, ready up. */
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
      { type: 'infantry', at: bk ?? hq },
      { type: 'infantry', at: bk ?? hq },
      { type: 'fighter', at: ab ?? hq },
      { type: 'destroyer', at: nb?.dock ?? hq },
      { type: 'sam', at: hq },
      { type: 'infantry', at: bk ?? hq },
      { type: 'coastal', at: hq },
    ];
    const reserve = p.cash * 0.2;
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
    // Remember where merchants died: those lanes need air cover.
    const alive = new Set<number>();
    for (const u of mine) if (u.type === 'merchant') alive.add(u.id);
    for (const [id, p] of this.merchantPos) if (!alive.has(id)) this.raided.push({ x: p.x, y: p.y, t: g.time });
    this.merchantPos.clear();
    for (const u of mine) if (u.type === 'merchant') this.merchantPos.set(u.id, { x: u.x, y: u.y });
    this.raided = this.raided.filter((r) => g.time - r.t < 180);
    const VALUE: Partial<Record<UnitType, number>> = { carrier: 10, battleship: 8, sub: 6, destroyer: 5, merchant: 3, coastal: 3, sam: 3, recon: 5, strike: 4, fighter: 4, infantry: 2, lander: 1 };
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
    const ships = mine.filter((u) => (u.type === 'destroyer' || u.type === 'battleship' || u.type === 'carrier' || u.type === 'sub') && u.inside < 0 && !u.retreating && !busy.has(u.id));
    let cx = 0;
    let cy = 0;
    for (const s of ships) {
      cx += s.x / ships.length;
      cy += s.y / ships.length;
    }
    const navalFoes = known.filter(({ e }) => UNITS[e.type].domain === 'sea' || e.type === 'sub');
    // Local strength around a point: fight where we are at least about as strong, never piecemeal.
    const power = (u: Unit) => (VALUE[u.type] ?? 1) * (u.hp / u.maxHp);
    const ourPower = (x: number, y: number) => ships.reduce((a, u) => a + (u.type !== 'sub' && Math.hypot(u.x - x, u.y - y) < 20 ? power(u) : 0), 0);
    const theirPower = (x: number, y: number) =>
      navalFoes.reduce((a, { e, k }) => a + (e.type !== 'merchant' && e.type !== 'lander' && e.type !== 'sub' && Math.hypot(k.x - x, k.y - y) < 15 ? power(e) : 0), 0);
    for (const s of ships) {
      const near = (types: UnitType[], r: number) => navalFoes.filter(({ e, k }) => types.includes(e.type) && Math.hypot(k.x - s.x, k.y - s.y) < r);
      if (s.type === 'battleship' || s.type === 'carrier') {
        // Capital ships never sit still next to a known submarine.
        const sub = near(['sub'], 12)[0];
        if (sub) {
          away(s, sub.k, 10);
          continue;
        }
      }
      if (s.type === 'sub') {
        const hunter = near(['destroyer'], 9)[0];
        const prey = near(['carrier', 'battleship', 'merchant'], 40).sort((a, b) => (VALUE[b.e.type] ?? 1) / (1 + Math.hypot(b.k.x - s.x, b.k.y - s.y) / 8) - (VALUE[a.e.type] ?? 1) / (1 + Math.hypot(a.k.x - s.x, a.k.y - s.y) / 8))[0];
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
      // Surface combatants: score every naval contact in reach.
      let best: Unit | null = null;
      let bs = 0;
      for (const { e, k } of navalFoes) {
        const d = Math.hypot(k.x - s.x, k.y - s.y);
        if (d > 32) continue;
        let match = 1;
        if (s.type === 'destroyer' && e.type === 'sub') match = 3;
        if (s.type === 'battleship' && e.type === 'destroyer') match = 1.6;
        if (e.type === 'sub' && s.type !== 'destroyer') match = 0; // no anti-sub weapons
        if (e.type === 'merchant') match = 0.6;
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
        s.fireMode = best.type === 'battleship' || best.type === 'carrier' ? 2 : 1;
      } else s.fireMode = 1;
    }
    // Aircraft.
    const hq = this.home();
    const planes = mine.filter((u) => UNITS[u.type].domain === 'air' && !u.landed && u.order.k !== 'rtb');
    const anchor = ships.length ? { x: cx, y: cy } : hq ? { x: hq.x, y: hq.y } : { x: g.map.size / 2, y: g.map.size / 2 };
    // Enemy air defence we know of: SAM-armed ships and batteries, and missile-battery buildings.
    const samSites = known.filter(({ e }) => e.type === 'destroyer' || e.type === 'battleship' || e.type === 'carrier' || e.type === 'sam').map(({ k }) => ({ x: k.x, y: k.y }));
    for (const st of g.sites) if (st.type === 'battery' && st.owner >= 0 && g.team(st.owner) !== g.players[this.pid].team) samSites.push({ x: st.x, y: st.y });
    const samThreat = (x: number, y: number, r = 22) => samSites.filter((p) => Math.hypot(p.x - x, p.y - y) < r).length;
    for (const pl of planes) {
      if (pl.fuel < pl.fuelMax * 0.35) continue; // bingo logic brings it home
      if (pl.type === 'strike') {
        // Strike only what is lightly defended (the target's own SAMs count as one).
        const t = known
          .filter(({ e, k }) => {
            if (UNITS[e.type].domain !== 'sea' || e.type === 'lander') return false;
            const threat = samThreat(k.x, k.y, 26);
            const ownSam = e.type === 'destroyer' || e.type === 'battleship' || e.type === 'carrier' ? 1 : 0;
            // Unescorted soft targets, or a lone SAM ship that is already badly hurt.
            return threat === 0 || (threat === ownSam && ownSam === 1 && e.hp < e.maxHp * 0.5);
          })
          .sort((a, b) => (VALUE[b.e.type] ?? 1) / (1 + Math.hypot(b.k.x - pl.x, b.k.y - pl.y) / 25) - (VALUE[a.e.type] ?? 1) / (1 + Math.hypot(a.k.x - pl.x, a.k.y - pl.y) / 25))[0];
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

  private produce() {
    const g = this.game;
    const p = g.players[this.pid];
    const t = g.time;
    const count = new Map<UnitType, number>();
    for (const u of this.mine()) count.set(u.type, (count.get(u.type) ?? 0) + 1);
    for (const cat of ['naval', 'ground', 'air'] as const) for (const it of p.queues[cat]) count.set(it.type, (count.get(it.type) ?? 0) + 1);
    // The navy comes first: it carries the troops and decides every landing. Troops are built only
    // as far as we can ship them, so cash does not pile up in idle infantry at home.
    const rich = 1 + Math.min(2, p.cash / 5000);
    let lift = 0;
    for (const u of this.mine()) if (u.holdCap > 0 && UNITS[u.type].category === 'naval') lift += u.holdCap;
    const spare = this.spareTroops().filter((u) => u.type === 'infantry').length + p.queues.ground.filter((it) => it.type === 'infantry').length;
    // Two troops per free hull is a full load; more only waits at home.
    const free = this.freeTransports().reduce((a, u) => a + u.holdCap - u.cargo.length, 0);
    const short = spare < Math.max(Math.min(2, lift), this.troopGoal);
    const want: Record<UnitType, number> = {
      infantry: spare < Math.max(2, free, this.troopGoal) ? (count.get('infantry') ?? 0) + 1 : 0,
      coastal: t > 150 ? (t > 600 ? 2 : 1) : 0,
      sam: t > 120 ? (t > 600 ? 2 : 1) : 0,
      destroyer: Math.min(10, (3 + t / 150) * rich),
      sub: t > 300 ? Math.min(3, Math.floor(t / 400)) : 0,
      battleship: t > 600 ? (t > 1200 ? 2 : 1) * Math.floor(rich) : 0,
      carrier: t > 720 && p.cash > 3000 ? 1 : 0,
      fighter: Math.min(3, 1 + Math.floor(t / 240)),
      strike: t > 240 ? Math.min(3, 1 + Math.floor(t / 360)) : 0,
      recon: t > 180 ? 1 : 0,
      merchant: 0,
      lander: 0,
    };
    // Counter-build against what we have seen: destroyers hunt subs, subs kill capital ships,
    // a battleship outguns a destroyer group.
    const know = g.knowledge.get(p.team);
    if (know) {
      for (const [id, k] of know) {
        const e = g.units.get(id);
        if (e && k.ident >= 1 && (e.type === 'sub' || e.type === 'destroyer' || e.type === 'battleship' || e.type === 'carrier' || e.type === 'strike')) this.spotted.set(id, e.type);
      }
    }
    const seen = { sub: 0, destroyer: 0, battleship: 0, carrier: 0, strike: 0 } as Record<string, number>;
    for (const [id, type] of this.spotted) {
      if (!g.units.get(id) || g.units.get(id)!.dead) this.spotted.delete(id);
      else seen[type]++;
    }
    want.destroyer += Math.min(4, seen.sub);
    want.fighter += Math.min(3, seen.strike);
    want.sub += Math.min(3, seen.battleship + seen.carrier);
    if (seen.destroyer >= 3 && t > 240) want.battleship = Math.max(want.battleship, 1);
    // Save up for the warship we want: cheaper ground and air units only spend what is left over,
    // except when we have nothing to land with at all.
    let reserve = 0;
    for (const cat of ['naval', 'ground', 'air'] as const) {
      if (p.queues[cat].length >= (p.cash > 4000 ? 3 : 2)) continue;
      let best: UnitType | null = null;
      let bestNeed = 0;
      for (const type of BUILDABLE[cat]) {
        const need = (want[type] - (count.get(type) ?? 0)) / Math.max(1, want[type]);
        if (need > bestNeed) {
          bestNeed = need;
          best = type;
        }
      }
      // Short of troops to land: that comes before batteries.
      if (cat === 'ground' && short) best = 'infantry';
      if (!best) continue;
      const cost = unitCost(best, p.faction);
      const urgent = best === 'infantry' && short;
      if (p.cash - (urgent ? 0 : reserve) >= cost) {
        g.command(this.pid, { c: 'build', cat, type: best });
        count.set(best, (count.get(best) ?? 0) + 1);
      } else if (cat === 'naval' && bestNeed >= 0.3) reserve = cost;
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
    for (const m of this.intel.values()) if (g.time - m.t <= maxAge && Math.hypot(m.x - x, m.y - y) < r) p += NAVAL_POWER[m.type] ?? 0;
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

  private shipPower(u: Unit): number {
    return (NAVAL_POWER[u.type] ?? 0) * (u.hp / u.maxHp);
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

  /** Ships with a hold, not busy, healthy. */
  private freeTransports(): Unit[] {
    const busy = this.busyShips();
    return this.mine().filter((u) => (u.type === 'destroyer' || u.type === 'battleship') && u.holdCap > u.cargo.length && u.inside < 0 && !u.retreating && u.hp > u.maxHp * 0.5 && !busy.has(u.id));
  }

  /** Ships tied to a grab or the operation. */
  private busyShips(): Set<number> {
    const s = new Set(this.transports.map((t) => t.ship));
    if (this.op) for (const id of [...this.op.ships, ...this.op.escorts]) s.add(id);
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
    let plans = this.islandPlans().filter((p) => !p.contested && !this.transports.some((t) => t.island === p.island));
    const hq = this.home();
    // Troops grouped by the island they wait on. Home groups wait for a full load; an outpost
    // sends what it has.
    const groups = new Map<number, Unit[]>();
    for (const u of this.spareTroops()) {
      const isl = islandAt(g.map, u.x, u.y);
      groups.set(isl, [...(groups.get(isl) ?? []), u]);
    }
    // After the opening, keep two warships out of ferry work for the next operation.
    const hulls = this.mine().filter((u) => u.type === 'destroyer' || u.type === 'battleship').length;
    const opWanted = !this.op && g.time > 300 && hulls >= 4 && this.islandPlans().some((p) => p.contested && !(this.avoid.get(p.island)! > g.time));
    const maxGrabs = Math.min(6, opWanted ? Math.max(1, hulls - 2) : hulls);
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
        const trip = Math.hypot(ship.x - gx, ship.y - gy) / UNITS[ship.type].speed;
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
      const fleet = this.mine().filter((u) => (u.type === 'destroyer' || u.type === 'battleship') && u.inside < 0 && !u.retreating && !this.transports.some((t) => t.ship === u.id));
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
      // Only fights we expect to win: clear naval superiority at the target.
      const best = plans
        .filter((p) => p.contested && !(this.avoid.get(p.island)! > g.time))
        .filter((p) => g.time > 300 || p.centre || easy === 0)
        .filter((p) => power >= p.naval * 1.4 + 4)
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
      const escorts = fleet.filter((u) => !ships.includes(u.id)).map((u) => u.id);
      this.stats.ops++;
      this.op = { island: best.island, x: best.x, y: best.y, tx: best.target.x, ty: best.target.y, sx, sy, ships, escorts, state: 'load', since: g.time, startPower: power, need };
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
        trip = Math.max(trip, Math.hypot(s.x - gx, s.y - gy) / UNITS[s.type].speed);
      }
      this.op.since = g.time + trip;
      if (escorts.length) g.command(this.pid, { c: 'move', ids: escorts, x: sx, y: sy, mode: 'move' });
      return;
    }
    // Live members only.
    op.ships = op.ships.filter((id) => alive(id));
    op.escorts = op.escorts.filter((id) => alive(id));
    const all = [...op.ships, ...op.escorts].map((id) => alive(id)!).filter((u) => !u.retreating);
    const power = all.reduce((a, u) => a + this.shipPower(u), 0);
    const cx = all.length ? all.reduce((a, u) => a + u.x, 0) / all.length : op.sx;
    const cy = all.length ? all.reduce((a, u) => a + u.y, 0) / all.length : op.sy;
    const end = (success: boolean, why = 'won') => {
      this.op = null;
      if (success) this.stats.won++;
      else this.stats.aborted++;
      this.stats.why[why] = (this.stats.why[why] ?? 0) + 1;
      this.opCooldown = g.time + (success ? 20 : 120);
      if (!success) this.avoid.set(op.island, g.time + 240);
    };
    // Back out when the fight turns against us; regroup at port and come back later.
    if (op.state !== 'load' && (power < op.startPower * 0.4 || this.navalThreat(cx, cy, 20, 30) > power * 1.15)) {
      const port = this.nearestOwnPort(cx, cy) ?? { x: hq.x, y: hq.y };
      const ids = all.map((u) => u.id);
      if (ids.length) g.command(this.pid, { c: 'move', ids, x: port.x, y: port.y, mode: 'move' });
      for (const id of ids) this.noEngage.set(id, g.time + 45);
      this.stats.breakoffs++;
      end(false, 'beaten');
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
    const ships = this.mine().filter((u) => (u.type === 'destroyer' || u.type === 'battleship' || u.type === 'carrier' || u.type === 'sub') && !busy.has(u.id) && !u.retreating && u.inside < 0);
    if (!ships.length) return;
    const myTeam = g.players[this.pid].team;
    const surface = ships.filter((s) => s.type !== 'sub' && s.type !== 'carrier' && s.order.k !== 'attack');
    const power = surface.reduce((a, u) => a + this.shipPower(u), 0);
    // Threatened island of ours that we can relieve?
    let rally: { x: number; y: number } | null = null;
    let worst = 0;
    for (const s of g.sites) {
      if (s.owner < 0 || g.team(s.owner) !== myTeam) continue;
      const th = this.navalThreat(s.x, s.y, 20);
      if (th > worst && th * 1.1 <= power) {
        worst = th;
        rally = { x: s.x, y: s.y };
      }
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
    // Subs without prey lie in wait on the enemy's shipping lanes (resource site -> home port).
    const subs = ships.filter((s) => s.type === 'sub' && s.order.k !== 'attack');
    if (subs.length) {
      const enemyHq = g.sites.find((s) => s.type === 'hq' && s.owner >= 0 && g.team(s.owner) !== myTeam);
      const lanes = g.sites.filter((s) => s.type === 'resource' && s.owner >= 0 && g.team(s.owner) !== myTeam);
      subs.forEach((sub, i) => {
        let tx = enemyHq ? (enemyHq.x + g.map.size / 2) / 2 : g.map.size / 2;
        let ty = enemyHq ? (enemyHq.y + g.map.size / 2) / 2 : g.map.size / 2;
        if (lanes.length && enemyHq) {
          const r = lanes[i % lanes.length];
          tx = r.x * 0.6 + enemyHq.x * 0.4;
          ty = r.y * 0.6 + enemyHq.y * 0.4;
        }
        g.command(this.pid, { c: 'move', ids: [sub.id], x: tx, y: ty });
      });
    }
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
      g.command(this.pid, { c: 'move', ids: [pl.id], x: front.x, y: front.y });
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
