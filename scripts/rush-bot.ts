// A test opponent for the AI benchmark (VS=rush): plays like an aggressive human. It runs the
// normal AI's economy and landings, but spends almost everything on destroyers, keeps its
// warships in one fleet, and from minute 6 sends that fleet at the enemy's islands, one after
// another, never stopping. It is not shipped in the game.
import { Bot } from '../src/shared/ai';
import type { Game, Unit } from '../src/shared/game';

export function makeRusher(g: Game, pid: number): Bot {
  const b = new Bot(g, pid);
  const bot = b as unknown as Record<string, unknown>;
  const team = g.players[pid].team;
  let orderAt = 0;
  // Production: destroyers first and always, troops for landings, nothing fancy.
  bot.produce = () => {
    const p = g.players[pid];
    const mine = [...g.units.values()].filter((u) => u.owner === pid && !u.dead);
    const inf = mine.filter((u) => u.type === 'infantry').length + p.queues.ground.length;
    if (p.queues.naval.length < 2 && p.cash >= 1200) g.command(pid, { c: 'build', cat: 'naval', type: 'destroyer' });
    if (p.queues.ground.length < 2 && inf < 10 && p.cash >= 450 + (p.queues.naval.length ? 0 : 900)) g.command(pid, { c: 'build', cat: 'ground', type: 'infantry' });
  };
  // Fleet: one stack. Before minute 6 it gathers off home; then it attacks enemy islands in turn.
  bot.fleet = () => {
    if (g.time < orderAt) return;
    orderAt = g.time + 8;
    const busy = (bot.busyShips as () => Set<number>).call(b);
    const ships = [...g.units.values()].filter((u) => u.owner === pid && !u.dead && u.inside < 0 && (u.type === 'destroyer' || u.type === 'battleship') && !busy.has(u.id) && !u.retreating);
    if (!ships.length) return;
    const hq = g.sites.find((s) => s.type === 'hq' && s.owner === pid);
    const cx = ships.reduce((a, u) => a + u.x, 0) / ships.length;
    const cy = ships.reduce((a, u) => a + u.y, 0) / ships.length;
    const enemySites = g.sites.filter((s) => s.owner >= 0 && g.team(s.owner) !== team);
    if (!enemySites.length || !hq) return;
    // Nearest enemy island to the fleet; resource islands and the HQ count double.
    const tgt = enemySites.sort((a, c) => Math.hypot(a.x - cx, a.y - cy) / (a.type === 'resource' || a.type === 'hq' ? 2 : 1) - Math.hypot(c.x - cx, c.y - cy) / (c.type === 'resource' || c.type === 'hq' ? 2 : 1))[0];
    const ids = ships.map((u: Unit) => u.id);
    if (g.time < 360 && ships.length < 6) {
      const sx = hq.x + (tgt.x - hq.x) * 0.25;
      const sy = hq.y + (tgt.y - hq.y) * 0.25;
      g.command(pid, { c: 'move', ids, x: sx, y: sy });
    } else {
      for (const u of ships) u.fireMode = 2;
      g.command(pid, { c: 'move', ids, x: tgt.x, y: tgt.y });
    }
  };
  // Its ships never break off on their own.
  bot.tactics = () => {};
  return b;
}
