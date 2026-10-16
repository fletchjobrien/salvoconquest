// Computer opponent. Uses only what its team can detect for targeting.
import { BUILDABLE, UNITS, UnitType, unitCost, counterOf } from './defs';
import { canDeployAt, deployZone } from './game';
import type { Contact, Game, Unit, SiteState } from './game';
import { islandAt } from './map';

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
    this.produce();
    this.expand();
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
        const front = this.targetIslands()[0];
        const raid = this.raided[this.raided.length - 1];
        const cap = raid ? { x: raid.x, y: raid.y } : hq && front ? { x: (hq.x * 2 + front.x) / 3, y: (hq.y * 2 + front.y) / 3 } : anchor;
        if (t && Math.hypot(t.k.x - pl.x, t.k.y - pl.y) < 70 && samThreat(t.k.x, t.k.y) === 0) attack(pl, t.e);
        else if (pl.order.k !== 'patrol' || Math.hypot(pl.order.x - cap.x, pl.order.y - cap.y) > 8) g.command(this.pid, { c: 'move', ids: [pl.id], x: cap.x, y: cap.y });
      } else if (pl.type === 'recon') {
        // Orbit over the fleet, a little toward the enemy; drop a sonobuoy every 20 s over water.
        const front = this.targetIslands()[0];
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
    // Rich bots field bigger forces.
    const rich = 1 + Math.min(3, p.cash / 6000);
    const want: Record<UnitType, number> = {
      infantry: Math.min(12 * rich, (4 + Math.floor(t / 90)) * rich),
      coastal: t > 150 ? Math.min(4, 1 + Math.floor(t / 400)) : 0,
      sam: t > 120 ? Math.min(4, 1 + Math.floor(t / 400)) : 0,
      destroyer: Math.min(6 * rich, (2 + Math.floor(t / 120)) * rich),
      sub: t > 180 ? Math.min(4, Math.floor(t / 240) * rich) : 0,
      battleship: t > 360 ? Math.floor(rich) : 0,
      carrier: t > 540 ? 1 : 0,
      fighter: Math.min(3 * rich, (1 + Math.floor(t / 240)) * rich),
      strike: t > 150 ? Math.min(3 * rich, (1 + Math.floor(t / 300)) * rich) : 0,
      recon: t > 200 ? 1 : 0,
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
    for (const cat of ['ground', 'naval', 'air'] as const) {
      if (p.queues[cat].length >= (p.cash > 6000 ? 3 : 2)) continue;
      let best: UnitType | null = null;
      let bestNeed = 0;
      for (const type of BUILDABLE[cat]) {
        const need = (want[type] - (count.get(type) ?? 0)) / Math.max(1, want[type]);
        if (need > bestNeed) {
          bestNeed = need;
          best = type;
        }
      }
      if (!best) continue;
      const cost = unitCost(best, p.faction);
      if (p.cash >= cost) {
        g.command(this.pid, { c: 'build', cat, type: best });
        count.set(best, (count.get(best) ?? 0) + 1);
      }
    }
  }

  private targetIslands(): { island: number; x: number; y: number; d: number }[] {
    const g = this.game;
    const myTeam = g.players[this.pid].team;
    const hq = this.home();
    if (!hq) return [];
    const best = new Map<number, { island: number; x: number; y: number; d: number }>();
    const neutralLeft = g.sites.some((s) => s.owner < 0 && s.island !== hq.island);
    // Late game (or nothing neutral left): go for the throat.
    const assault = !neutralLeft || g.time > 900;
    for (const s of g.sites) {
      if (s.owner >= 0 && g.team(s.owner) === myTeam) continue;
      if (s.island === hq.island) continue;
      let d = Math.hypot(s.x - hq.x, s.y - hq.y);
      if (s.type === 'resource') d -= 8;
      if (s.type === 'hq') d += assault ? -40 : 30;
      if (s.owner >= 0 && !assault) d += 15;
      const cur = best.get(s.island);
      if (!cur || d < cur.d) best.set(s.island, { island: s.island, x: s.x, y: s.y, d });
    }
    return [...best.values()].sort((a, b) => a.d - b.d);
  }

  private expand() {
    const g = this.game;
    const hq = this.home();
    if (!hq) return;
    const units = this.mine();
    // Clean up finished/broken transports.
    this.transports = this.transports.filter((tr) => {
      const s = g.units.get(tr.ship);
      if (!s || s.dead) return false;
      if (tr.state === 'sailing' && s.cargo.length === 0 && s.order.k !== 'unload') return false;
      return true;
    });
    const all = this.targetIslands();
    const hqIslands = new Set(g.sites.filter((x) => x.type === 'hq').map((x) => x.island));
    // Up to three transports may converge on an enemy home island; one per other island.
    const targets = all.filter((t) => this.transports.filter((tr) => tr.island === t.island).length < (hqIslands.has(t.island) ? 3 : 1));
    // Start new transports: idle troops on any island with nothing left to take there (home, or
    // an island we already hold) are grouped by island; the nearest free ship comes to collect them.
    const myTeam = g.players[this.pid].team;
    const workLeft = (isl: number) => g.sites.some((x) => x.island === isl && !(x.owner >= 0 && g.team(x.owner) === myTeam));
    const groups = new Map<number, Unit[]>();
    for (const u of units) {
      if (UNITS[u.type].domain !== 'land' || u.inside >= 0 || u.order.k !== 'idle') continue;
      const isl = islandAt(g.map, u.x, u.y);
      if (isl < 0 || (isl !== hq.island && workLeft(isl))) continue;
      groups.set(isl, [...(groups.get(isl) ?? []), u]);
    }
    for (const [isl, troops] of groups) {
      if (!targets.length || this.transports.length >= 6) break;
      if (troops.length < 2 && isl === hq.island) continue;
      const gx = troops.reduce((a, u) => a + u.x, 0) / troops.length;
      const gy = troops.reduce((a, u) => a + u.y, 0) / troops.length;
      const used = new Set(this.transports.map((t) => t.ship));
      const ship = units
        .filter((u) => (u.type === 'destroyer' || u.type === 'battleship') && !used.has(u.id) && u.holdCap > u.cargo.length && u.inside < 0 && !u.retreating && u.hp > u.maxHp * 0.5)
        .sort((a, b) => Math.hypot(a.x - gx, a.y - gy) - Math.hypot(b.x - gx, b.y - gy))[0];
      if (!ship) break;
      // Nearest objective to these troops, not to home.
      const tgt = targets.slice().sort((a, b) => Math.hypot(a.x - gx, a.y - gy) - Math.hypot(b.x - gx, b.y - gy))[0];
      this.transports.push({ ship: ship.id, island: tgt.island, tx: tgt.x, ty: tgt.y, state: 'loading', since: g.time });
      const n = Math.min(ship.holdCap - ship.cargo.length, troops.length);
      g.command(this.pid, { c: 'board', ids: troops.slice(0, n).map((u) => u.id), ship: ship.id });
      if (Math.hypot(ship.x - gx, ship.y - gy) > 6) g.command(this.pid, { c: 'move', ids: [ship.id], x: gx, y: gy, mode: 'move' });
    }
    for (const tr of this.transports) {
      const ship = g.units.get(tr.ship)!;
      if (tr.state === 'loading') {
        const boarding = units.some((u) => u.order.k === 'board' && u.order.ship === ship.id) || [...g.units.values()].some((l) => l.type === 'lander' && l.ferry?.ship === ship.id);
        if ((!boarding && ship.cargo.length > 0) || (g.time - tr.since > 110 && ship.cargo.length > 0)) {
          tr.state = 'sailing';
          g.command(this.pid, { c: 'unload', ship: ship.id, ids: [], x: tr.tx, y: tr.ty });
        } else if (g.time - tr.since > 130) {
          tr.state = 'done';
        }
      }
    }
    this.transports = this.transports.filter((t) => t.state !== 'done');
  }

  private fleet() {
    const g = this.game;
    if (g.time < this.fleetOrderAt) return;
    this.fleetOrderAt = g.time + 18;
    const hq = this.home();
    if (!hq) return;
    const busy = new Set(this.transports.map((t) => t.ship));
    const ships = this.mine().filter((u) => (UNITS[u.type].domain === 'sea' || u.type === 'sub') && u.type !== 'merchant' && u.type !== 'lander' && !busy.has(u.id) && !u.retreating && u.inside < 0);
    if (!ships.length) return;
    const know = g.knowledge.get(g.players[this.pid].team)!;
    // Nearest known enemy ship to our home.
    let target: { x: number; y: number } | null = null;
    let bd = 1e9;
    for (const [id, k] of know) {
      const e = g.units.get(id);
      if (!e || e.dead) continue;
      const dom = UNITS[e.type].domain;
      if (dom !== 'sea' && dom !== 'sub') continue;
      const d = Math.hypot(k.x - hq.x, k.y - hq.y) + (e.type === 'merchant' ? 10 : 0);
      if (d < bd) {
        bd = d;
        target = { x: k.x, y: k.y };
      }
    }
    const islands = this.targetIslands();
    // Escort a landing on an enemy-held island; otherwise hunt nearby ships or screen the next objective.
    const myTeam = g.players[this.pid].team;
    const contested = this.transports.find((tr) => tr.state === 'sailing' && g.sites.some((x) => x.island === tr.island && x.owner >= 0 && g.team(x.owner) !== myTeam));
    const rally = contested
      ? { x: contested.tx, y: contested.ty }
      : target && bd < 45 * (g.map.size / 80)
        ? target
        : islands[0]
          ? { x: (islands[0].x + hq.x) / 2, y: (islands[0].y + hq.y) / 2 }
          : { x: g.map.size / 2, y: g.map.size / 2 };
    const engaged = (s: Unit) => s.order.k === 'attack' && !!g.units.get(s.order.target) && !g.units.get(s.order.target)!.dead;
    const surface = ships.filter((s) => s.type !== 'sub' && s.type !== 'carrier' && !engaged(s));
    const subs = ships.filter((s) => s.type === 'sub' && !engaged(s));
    if (surface.length) g.command(this.pid, { c: 'move', ids: surface.map((s) => s.id), x: rally.x, y: rally.y });
    // Carriers stay 10 km behind the screen, toward home.
    const cvs = ships.filter((s) => s.type === 'carrier');
    if (cvs.length) {
      const dx = hq.x - rally.x;
      const dy = hq.y - rally.y;
      const dl = Math.hypot(dx, dy) || 1;
      g.command(this.pid, { c: 'move', ids: cvs.map((s) => s.id), x: rally.x + (dx / dl) * Math.min(10, dl), y: rally.y + (dy / dl) * Math.min(10, dl) });
    }
    // Subs prowl further out toward enemy homes.
    // Subs without prey lie in wait on the enemy's shipping lanes (resource site -> home port).
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

  private air() {
    const g = this.game;
    if (g.time < this.airOrderAt) return;
    this.airOrderAt = g.time + 25;
    const hq = this.home();
    if (!hq) return;
    const planes = this.mine().filter((u) => UNITS[u.type].domain === 'air' && !u.landed && u.order.k === 'patrol');
    const islands = this.targetIslands();
    const front = islands[0] ?? { x: g.map.size / 2, y: g.map.size / 2 };
    // Fighters and the AEW are handled in tactics(); idle strike flights loiter over the front.
    for (const pl of planes) if (pl.type === 'strike') g.command(this.pid, { c: 'move', ids: [pl.id], x: front.x, y: front.y });
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
