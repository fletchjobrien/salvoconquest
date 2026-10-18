// Fast AI benchmark: plays many short bot games in parallel (one worker thread per core) and reports
// what the bots achieve over time. No rendering, so a 20-minute game takes about 10 s of CPU.
//
//   npm run bench:ai                       self-play: current AI vs itself
//   VS=HEAD~1 npm run bench:ai             head-to-head: current AI vs the AI at a git revision
//   GAMES=16 MIN=20 CHECK=5 npm run bench:ai
//
// Each pairing is played with the AIs swapping sides and factions, so map and faction luck cancel out.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../src/shared/game';
import { Bot } from '../src/shared/ai';
import { THEMES, islandAt } from '../src/shared/map';
import type { Faction } from '../src/shared/defs';

interface Job {
  seed: number;
  theme: string;
  /** Which AI plays slot 0 and slot 1: 'new' or 'old'. */
  ais: ['new' | 'old', 'new' | 'old'];
  factions: [Faction, Faction];
  minutes: number;
  check: number;
  baseline?: string;
}

interface Snap {
  min: number;
  islands: number;
  res: number;
  centre: number;
  fromEnemy: number;
  idleHome: number;
  ships: number;
  ground: number;
  cash: number;
  kills: number;
  losses: number;
  subKills: number;
  subsLost: number;
  subSeen: number;
  ops: number;
  won: number;
  aborted: number;
}

interface Result {
  job: Job;
  snaps: Snap[][];
  winner: number;
  over: boolean;
  ms: number;
}

async function play(job: Job): Promise<Result> {
  const t0 = Date.now();
  const g = new Game(job.seed, job.theme as never, [
    { name: 'A', faction: job.factions[0], team: 0, slot: 0, bot: true },
    { name: 'B', faction: job.factions[1], team: 1, slot: 2, bot: true },
  ]);
  const Old = job.baseline ? ((await import(job.baseline)) as { Bot: typeof Bot }).Bot : Bot;
  const bots = g.players.map((p) => (job.ais[p.id] === 'old' ? new Old(g, p.id) : new Bot(g, p.id)));
  // Captures from the enemy: count sites whose owner flips from one player to the other.
  const fromEnemy = [0, 0];
  const owner = g.sites.map((s) => s.owner);
  const snaps: Snap[][] = [[], []];
  const centre = g.map.islands[0]?.id ?? 0;
  // Submarines: kills scored by each boat, boats lost, and how often the enemy holds a track on them.
  const subKills = [new Map<number, number>(), new Map<number, number>()];
  const subsLost = [new Set<number>(), new Set<number>()];
  const seenSamples = [0, 0];
  const seenHits = [0, 0];
  for (let i = 1; i <= job.minutes * 600 && !g.over; i++) {
    for (const b of bots) b.tick();
    g.step();
    g.flushEvents();
    if (i % 50 === 0) {
      for (const pid of [0, 1]) for (const id of subKills[pid].keys()) if (!g.units.get(id) || g.units.get(id)!.dead) subsLost[pid].add(id);
      for (const u of g.units.values()) {
        if (u.type !== 'sub') continue;
        subKills[u.owner].set(u.id, Math.max(subKills[u.owner].get(u.id) ?? 0, u.kills));
        if (u.dead) continue;
        seenSamples[u.owner]++;
        const k = g.knowledge.get(1 - g.players[u.owner].team)?.get(u.id);
        if (k && k.ident >= 1) seenHits[u.owner]++;
      }
      g.sites.forEach((s, k) => {
        if (s.owner >= 0 && owner[k] >= 0 && owner[k] !== s.owner) fromEnemy[s.owner]++;
        owner[k] = s.owner;
      });
    }
    if (i % (job.check * 600) === 0) {
      for (const p of g.players) {
        const mine = [...g.units.values()].filter((u) => u.owner === p.id && !u.dead);
        const hq = g.sites.find((s) => s.type === 'hq' && s.owner === p.id);
        const ground = mine.filter((u) => u.type === 'infantry' || u.type === 'coastal' || u.type === 'sam');
        snaps[p.id].push({
          min: i / 600,
          islands: new Set(g.sites.filter((s) => s.owner === p.id).map((s) => s.island)).size,
          res: g.sites.filter((s) => s.owner === p.id && s.type === 'resource').length,
          centre: g.sites.filter((s) => s.owner === p.id && s.island === centre).length,
          fromEnemy: fromEnemy[p.id],
          idleHome: ground.filter((u) => u.inside < 0 && u.order.k === 'idle' && hq && islandAt(g.map, u.x, u.y) === hq.island).length,
          ships: mine.filter((u) => u.type === 'destroyer' || u.type === 'battleship' || u.type === 'carrier' || u.type === 'sub').length,
          ground: ground.length,
          cash: Math.round(p.cash),
          kills: p.kills,
          losses: p.losses,
          subKills: [...subKills[p.id].values()].reduce((a, b) => a + b, 0),
          subsLost: subsLost[p.id].size,
          subSeen: seenSamples[p.id] ? (100 * seenHits[p.id]) / seenSamples[p.id] : 0,
          ...structuredClone((bots[p.id] as Bot).stats ?? { ops: 0, won: 0, aborted: 0 }),
        });
      }
    }
  }
  // Teams are the player ids here (one player per team).
  return { job, snaps, winner: g.over ? g.winnerTeam : -1, over: g.over, ms: Date.now() - t0 };
}

if (!isMainThread) {
  void play(workerData as Job).then((r) => parentPort!.postMessage(r));
} else {
  const GAMES = Number(process.env.GAMES ?? 8);
  const MIN = Number(process.env.MIN ?? 20);
  const CHECK = Number(process.env.CHECK ?? 5);
  const VS = process.env.VS;
  let baseline: string | undefined;
  if (VS) {
    // Extract the AI at that revision and bundle it against the current game code.
    const dir = resolve('.wrangler/bench');
    mkdirSync(dir, { recursive: true });
    const src = execSync(`git show ${VS}:src/shared/ai.ts`).toString().replace(/from '\.\/(\w+)'/g, `from '${resolve('src/shared')}/$1'`);
    writeFileSync(`${dir}/ai-baseline.ts`, src);
    const esbuild = await import('esbuild');
    esbuild.buildSync({ entryPoints: [`${dir}/ai-baseline.ts`], bundle: true, platform: 'node', format: 'esm', outfile: `${dir}/ai-baseline.mjs`, logLevel: 'warning' });
    baseline = `${dir}/ai-baseline.mjs`;
  }
  const jobs: Job[] = [];
  for (let k = 0; jobs.length < GAMES; k++) {
    const theme = THEMES[k % THEMES.length];
    const seed = 1000 + Math.floor(k / 4) * 17 + k;
    const swapAi = VS ? k % 2 === 1 : false;
    const swapFac = Math.floor(k / 2) % 2 === 1;
    jobs.push({
      seed,
      theme,
      ais: VS ? (swapAi ? ['old', 'new'] : ['new', 'old']) : ['new', 'new'],
      factions: swapFac ? ['union', 'coalition'] : ['coalition', 'union'],
      minutes: MIN,
      check: CHECK,
      baseline,
    });
  }
  const t0 = Date.now();
  const results: Result[] = [];
  const queue = jobs.slice();
  const threads = Math.min(cpus().length, jobs.length);
  await Promise.all(
    Array.from({ length: threads }, async () => {
      while (queue.length) {
        const job = queue.shift()!;
        const r = await new Promise<Result>((ok, bad) => {
          const w = new Worker(new URL(import.meta.url), { workerData: job });
          w.once('message', ok);
          w.once('error', bad);
        });
        results.push(r);
        process.stdout.write('.');
      }
    }),
  );
  console.log(`\n${results.length} games of ${MIN} min on ${threads} threads in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Average per checkpoint, per side ('new' / 'old' in head-to-head; both sides pooled in self-play).
  const sides = VS ? (['new', 'old'] as const) : (['new'] as const);
  const avg = (side: string, ci: number, f: (s: Snap) => number) => {
    const xs: number[] = [];
    for (const r of results) r.job.ais.forEach((a, pid) => a === side && r.snaps[pid][ci] && xs.push(f(r.snaps[pid][ci])));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  const cols: [string, (s: Snap) => number][] = [
    ['islands', (s) => s.islands],
    ['res', (s) => s.res],
    ['centre', (s) => s.centre],
    ['captured', (s) => s.fromEnemy],
    ['ships', (s) => s.ships],
    ['ground', (s) => s.ground],
    ['idle@home', (s) => s.idleHome],
    ['cash', (s) => s.cash],
    ['kills', (s) => s.kills],
    ['losses', (s) => s.losses],
    ['sub kills', (s) => s.subKills ?? 0],
    ['subs lost', (s) => s.subsLost ?? 0],
    ['sub seen%', (s) => s.subSeen ?? 0],
    ['ops', (s) => s.ops ?? 0],
    ['ops won', (s) => s.won ?? 0],
    ['ops off', (s) => s.aborted ?? 0],
  ];
  const nCheck = Math.floor(MIN / CHECK);
  for (const side of sides) {
    console.log(`\n${VS ? (side === 'new' ? 'CURRENT AI' : `AI @ ${VS}`) : 'AI (both sides pooled)'}`);
    console.log('min  ' + cols.map(([k]) => k.padStart(9)).join(''));
    for (let ci = 0; ci < nCheck; ci++) console.log(String((ci + 1) * CHECK).padStart(3) + '  ' + cols.map(([, f]) => avg(side, ci, f).toFixed(1).padStart(9)).join(''));
  }
  if (VS) {
    // Final standing: sites held x2 + kills x3 - losses, or an outright win.
    let w = 0;
    let l = 0;
    let d = 0;
    for (const r of results) {
      const ni = r.job.ais.indexOf('new');
      const last = (pid: number) => r.snaps[pid][r.snaps[pid].length - 1];
      const score = (pid: number) => (last(pid) ? last(pid).islands * 4 + last(pid).res * 2 + last(pid).kills * 3 - last(pid).losses : 0);
      if (r.over) {
        if (r.winner === ni) w++;
        else l++;
      } else if (score(ni) > score(1 - ni)) w++;
      else if (score(ni) < score(1 - ni)) l++;
      else d++;
    }
    console.log(`\nCurrent AI vs AI @ ${VS}: ${w} wins / ${l} losses / ${d} draws (outright wins, otherwise islands x4 + resource sites x2 + kills x3 - losses)`);
  }
  // Why operations ended (current AI only).
  const why: Record<string, number> = {};
  for (const r of results)
    r.job.ais.forEach((a, pid) => {
      if (a !== 'new') return;
      const last = r.snaps[pid][r.snaps[pid].length - 1] as Snap & { why?: Record<string, number> };
      for (const [k, v] of Object.entries(last?.why ?? {})) why[k] = (why[k] ?? 0) + v;
    });
  if (Object.keys(why).length) console.log('operation outcomes:', Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', '));
  const wins = results.filter((r) => r.over).length;
  console.log(`games decided outright: ${wins}/${results.length}`);
}
