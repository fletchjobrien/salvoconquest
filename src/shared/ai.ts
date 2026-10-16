// Computer opponent. Uses only what its team can detect for targeting.
import { BUILDABLE, UNITS, UnitType, unitCost, counterOf } from './defs';
import { canDeployAt, deployZone } from './game';
import type { Game, Unit, SiteState } from './game';
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
    if (g.time < this.nextThink) return;
    this.nextThink = g.time + 2;
    this.produce();
    this.expand();
    this.fleet();
    this.air();
    this.groundIdle();
    this.specials();
  }

  /** Use faction specials when the situation calls for them (see doctrine.ts). */
  private specials() {
    const g = this.game;
    const team = g.players[this.pid].team;
    const know = g.knowledge.get(team);
    if (!know) return;
    // Closest identified enemy ship to a point.
    const nearestShip = (x: number, y: number) => {
      let bd = 1e9;
      for (const [id, k] of know) {
        const t = g.units.get(id);
        if (!t || t.dead || k.ident < 1) continue;
        const dom = UNITS[t.type].domain;
        if (dom !== 'sea' && dom !== 'sub') continue;
        bd = Math.min(bd, Math.hypot(k.x - x, k.y - y));
      }
      return bd;
    };
    const missileInbound = (x: number, y: number, r: number) => g.projs.some((p) => !p.dead && p.kind === 'missile' && p.team !== team && Math.hypot(p.x - x, p.y - y) < r);
    for (const u of this.mine()) {
      const sp = g.specialOf(u);
      if (!sp || u.inside >= 0 || g.time < u.spec.ready) continue;
      let use = false;
      switch (sp.id) {
        case 'aegis':
        case 'screen':
          use = missileInbound(u.x, u.y, 20);
          break;
        case 'silent':
          // Go quiet near the enemy, speak up again when clear.
          use = u.spec.on ? nearestShip(u.x, u.y) > 25 : nearestShip(u.x, u.y) < 20;
          break;
        case 'gunfire':
          use = nearestShip(u.x, u.y) < 18 || g.units.get((u.order as { target?: number }).target ?? -1) !== undefined;
          break;
        case 'surge':
          use = [...g.units.values()].some((a) => !a.dead && a.landed && a.base && 'unit' in a.base && a.base.unit === u.id);
          break;
        case 'saturation':
          use = nearestShip(u.x, u.y) < 34;
          break;
        case 'hypersonic':
          use = nearestShip(u.x, u.y) < 28;
          break;
        case 'minefield':
          use = nearestShip(u.x, u.y) < 12;
          break;
      }
      if (use) g.command(this.pid, { c: 'special', ids: [u.id] });
    }
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
        if (e && k.ident >= 1 && (e.type === 'sub' || e.type === 'destroyer' || e.type === 'battleship' || e.type === 'carrier')) this.spotted.set(id, e.type);
      }
    }
    const seen = { sub: 0, destroyer: 0, battleship: 0, carrier: 0 } as Record<string, number>;
    for (const [id, type] of this.spotted) {
      if (!g.units.get(id) || g.units.get(id)!.dead) this.spotted.delete(id);
      else seen[type]++;
    }
    want.destroyer += Math.min(4, seen.sub);
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
    const busyShips = new Set(this.transports.map((t) => t.ship));
    const all = this.targetIslands();
    const hqIslands = new Set(g.sites.filter((x) => x.type === 'hq').map((x) => x.island));
    // Up to three transports may converge on an enemy home island; one per other island.
    const targets = all.filter((t) => this.transports.filter((tr) => tr.island === t.island).length < (hqIslands.has(t.island) ? 3 : 1));
    // Start a new transport if possible.
    const idleInf = units.filter((u) => UNITS[u.type].domain === 'land' && u.inside < 0 && islandAt(g.map, u.x, u.y) === hq.island && u.order.k === 'idle');
    if (targets.length && idleInf.length >= 2 && this.transports.length < 4) {
      const ship = units
        .filter((u) => (u.type === 'destroyer' || u.type === 'battleship') && !busyShips.has(u.id) && u.holdCap > u.cargo.length && u.inside < 0 && !u.retreating)
        .sort((a, b) => Math.hypot(a.x - hq.x, a.y - hq.y) - Math.hypot(b.x - hq.x, b.y - hq.y))[0];
      if (ship) {
        const tgt = targets[0];
        this.transports.push({ ship: ship.id, island: tgt.island, tx: tgt.x, ty: tgt.y, state: 'loading', since: g.time });
        const n = Math.min(ship.holdCap - ship.cargo.length, idleInf.length);
        const pick = idleInf.slice(0, n);
        g.command(this.pid, { c: 'board', ids: pick.map((u) => u.id), ship: ship.id });
      }
    }
    for (const tr of this.transports) {
      const ship = g.units.get(tr.ship)!;
      if (tr.state === 'loading') {
        const boarding = units.some((u) => u.order.k === 'board' && u.order.ship === ship.id) || [...g.units.values()].some((l) => l.type === 'lander' && l.ferry?.ship === ship.id);
        if ((!boarding && ship.cargo.length > 0) || (g.time - tr.since > 70 && ship.cargo.length > 0)) {
          tr.state = 'sailing';
          g.command(this.pid, { c: 'unload', ship: ship.id, ids: [], x: tr.tx, y: tr.ty });
        } else if (g.time - tr.since > 90) {
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
      : target && bd < 45
        ? target
        : islands[0]
          ? { x: (islands[0].x + hq.x) / 2, y: (islands[0].y + hq.y) / 2 }
          : { x: g.map.size / 2, y: g.map.size / 2 };
    const surface = ships.filter((s) => s.type !== 'sub');
    const subs = ships.filter((s) => s.type === 'sub');
    if (surface.length) g.command(this.pid, { c: 'move', ids: surface.map((s) => s.id), x: rally.x, y: rally.y });
    // Subs prowl further out toward enemy homes.
    if (subs.length) {
      const enemyHq = g.sites.find((s) => s.type === 'hq' && s.owner >= 0 && g.team(s.owner) !== g.players[this.pid].team);
      const tx = target ? target.x : enemyHq ? (enemyHq.x + g.map.size / 2) / 2 : g.map.size / 2;
      const ty = target ? target.y : enemyHq ? (enemyHq.y + g.map.size / 2) / 2 : g.map.size / 2;
      g.command(this.pid, { c: 'move', ids: subs.map((s) => s.id), x: tx, y: ty });
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
    for (const pl of planes) {
      if (pl.type === 'fighter') {
        const x = (hq.x * 2 + front.x) / 3;
        const y = (hq.y * 2 + front.y) / 3;
        g.command(this.pid, { c: 'move', ids: [pl.id], x, y });
      } else if (pl.type === 'strike') {
        g.command(this.pid, { c: 'move', ids: [pl.id], x: front.x, y: front.y });
      } else if (pl.type === 'recon') {
        g.command(this.pid, { c: 'move', ids: [pl.id], x: (hq.x + front.x) / 2, y: (hq.y + front.y) / 2 });
      }
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
