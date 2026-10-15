// Headless smoke test: bots play each other on every theme; asserts the sim stays healthy.
import { Game } from '../src/shared/game';
import { Bot } from '../src/shared/ai';
import { THEMES } from '../src/shared/map';

const minutes = Number(process.env.MINUTES ?? 12);
let failed = false;
for (const theme of THEMES) {
  const t0 = Date.now();
  const g = new Game(1234 + theme.length, theme, [
    { name: 'Blue', faction: 'coalition', team: 0, slot: 0, bot: true },
    { name: 'Red', faction: 'union', team: 1, slot: 2, bot: true },
  ]);
  const genMs = Date.now() - t0;
  const bots = g.players.map((p) => new Bot(g, p.id));
  const t1 = Date.now();
  let maxStep = 0;
  let snapBytes = 0;
  const ticks = minutes * 600;
  for (let i = 0; i < ticks && !g.over; i++) {
    const s = performance.now();
    for (const b of bots) b.tick();
    g.step();
    if (i % 1 === 0) {
      for (const p of g.players) snapBytes = Math.max(snapBytes, JSON.stringify(g.snapshotFor(p.id, i % 50 === 0)).length);
    }
    g.flushEvents();
    maxStep = Math.max(maxStep, performance.now() - s);
    if (i % 1800 === 0 || i === ticks - 1) {
      const owned = g.players.map((p) => g.sites.filter((s) => s.owner === p.id).length);
      const units = g.players.map((p) => [...g.units.values()].filter((u) => u.owner === p.id).length);
      console.log(`[${theme}] t=${g.time.toFixed(0)}s sites=${owned} units=${units} cash=${g.players.map((p) => Math.round(p.cash))} kills=${g.players.map((p) => p.kills)} proj=${g.projs.length}`);
    }
    for (const u of g.units.values()) {
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.hp)) {
        console.error('NaN unit', u.type, u.id, u.x, u.y, u.hp);
        failed = true;
        break;
      }
    }
    if (failed) break;
  }
  const simMs = Date.now() - t1;
  console.log(`[${theme}] map gen ${genMs}ms, ${minutes} min sim in ${simMs}ms (max step ${maxStep.toFixed(1)}ms), max snapshot ${(snapBytes / 1024).toFixed(1)}KB, over=${g.over} winner=${g.winnerTeam}`);
  const captured = g.sites.filter((s) => s.owner >= 0 && s.home < 0).length;
  if (captured === 0) {
    console.error(`[${theme}] bots captured nothing`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
