// Connections: online (WebSocket to the room Durable Object) or local (simulation runs in this tab).
import { Game } from '../shared/game';
import { Bot } from '../shared/ai';
import type { ClientMsg, ServerMsg, StartInfo } from '../shared/protocol';
import { TICK, Faction, Loadouts } from '../shared/defs';
import type { Theme } from '../shared/map';

export interface Conn {
  readonly local: boolean;
  send(msg: ClientMsg): void;
  onMessage: (m: ServerMsg) => void;
  onClose: (reason: string) => void;
  close(): void;
  latency: number;
  paused?: boolean;
  speed?: number;
}

export class OnlineConn implements Conn {
  readonly local = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  latency = 0;
  private ws: WebSocket;
  private pingTimer: ReturnType<typeof setInterval>;
  private queue: string[] = [];
  private closed = false;

  constructor(code: string) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(code)}`);
    this.ws.onopen = () => {
      for (const q of this.queue) this.ws.send(q);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'pong') {
        this.latency = performance.now() - m.n;
        return;
      }
      this.onMessage(m);
    };
    this.ws.onclose = () => {
      if (!this.closed) this.onClose('Connection lost');
      this.closed = true;
      clearInterval(this.pingTimer);
    };
    this.ws.onerror = () => {
      /* onclose follows */
    };
    // Pings keep the Durable Object's CPU budget fresh and measure latency.
    this.pingTimer = setInterval(() => this.send({ t: 'ping', n: performance.now() }), 2000);
  }

  send(msg: ClientMsg) {
    const s = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(s);
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws.close();
  }
}

export interface SkirmishSettings {
  name: string;
  faction: Faction;
  theme: Theme;
  bots: { faction: Faction }[];
  teams: 'ffa' | '2v2';
  loadouts: Loadouts;
}

const BOT_NAMES = ['ADM. HALSEY', 'CDR. ZHENG', 'CAPT. NIMITZ', 'ADM. YI', 'CDR. RICKOVER'];

export class LocalConn implements Conn {
  readonly local = true;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  latency = 0;
  paused = false;
  speed = 1;
  game: Game;
  private bots: Bot[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private info: StartInfo;

  constructor(s: SkirmishSettings) {
    const n = 1 + s.bots.length;
    const slots = n === 2 ? [0, 2] : [0, 2, 1, 3].slice(0, n);
    const teamOf = (slot: number) => (s.teams === '2v2' ? (slot === 0 || slot === 1 ? 0 : 1) : slot);
    const players = [
      { name: s.name, faction: s.faction, team: teamOf(slots[0]), slot: slots[0], bot: false, loadouts: s.loadouts },
      ...s.bots.map((b, i) => ({ name: BOT_NAMES[i], faction: b.faction, team: teamOf(slots[i + 1]), slot: slots[i + 1], bot: true })),
    ];
    const seed = (Math.random() * 2 ** 31) | 0;
    this.game = new Game(seed, s.theme, players);
    this.bots = this.game.players.filter((p) => p.bot).map((p) => new Bot(this.game, p.id));
    this.info = {
      seed,
      theme: s.theme,
      you: 0,
      players: this.game.players.map((p) => ({ id: p.id, name: p.name, faction: p.faction, team: p.team, slot: p.slot, bot: p.bot })),
    };
  }

  start() {
    this.onMessage({ t: 'start', info: this.info });
    let first = true;
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (this.paused) return;
      acc += dt * this.speed;
      const g = this.game;
      while (acc >= TICK) {
        acc -= TICK;
        for (const b of this.bots) b.tick();
        g.step();
        this.onMessage(g.snapshotFor(0, first));
        first = false;
        g.flushEvents();
        if (g.over) {
          const winners = g.players.filter((p) => p.team === g.winnerTeam).map((p) => p.id);
          this.onMessage({ t: 'end', winner: g.winnerTeam, winners, stats: g.results() });
          this.close();
          return;
        }
      }
    }, TICK * 1000);
  }

  send(msg: ClientMsg) {
    if (msg.t === 'cmd') this.game.command(0, msg.cmd);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
