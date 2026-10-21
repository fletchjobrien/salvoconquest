// Connections: online (WebSocket to the room Durable Object) or local (simulation runs in this tab).
import { Game } from '../shared/game';
import { Bot } from '../shared/ai';
import type { ClientMsg, ServerMsg, StartInfo } from '../shared/protocol';
import { TICK, Faction, Fleet } from '../shared/defs';
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

/** This browser tab's identity for the server. It survives a page reload (sessionStorage), so a refresh gets its seat back. */
export function tabToken(): string {
  const make = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
  try {
    let t = sessionStorage.getItem('salvo.token');
    if (!t) {
      t = make();
      sessionStorage.setItem('salvo.token', t);
    }
    return t;
  } catch {
    return make();
  }
}

/** Server close reasons after which trying again cannot help. */
const FINAL = new Set(['in progress', 'full', 'replaced']);
/** Give up reconnecting after this long (ms). */
const RETRY_FOR = 120_000;
/** An open connection that has said nothing for this long (ms) is dead (sleep, network change). */
const SILENT = 12_000;

export class OnlineConn implements Conn {
  readonly local = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  /** 'lost': the connection dropped and we are trying again (attempt n); 'back': reconnected. */
  onReconnect: (state: 'lost' | 'back', attempt: number) => void = () => {};
  latency = 0;
  private ws!: WebSocket;
  private pingTimer: ReturnType<typeof setInterval>;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private closed = false;
  private opened = false;
  /** The hello message, sent again on every reconnect so the server gives us our seat back. */
  private hello: string | null = null;
  private lastMsg = performance.now();
  private attempt = 0;
  private lostAt = 0;

  constructor(private code: string) {
    this.connect();
    // Pings measure latency and keep the room's Durable Object busy with fresh requests.
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', n: performance.now() });
      this.watchdog();
    }, 2000);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(this.code)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMsg = performance.now();
      if (this.opened && this.hello) ws.send(this.hello);
      for (const q of this.queue) ws.send(q);
      this.queue = [];
      this.opened = true;
      if (this.attempt > 0) {
        this.attempt = 0;
        this.onReconnect('back', 0);
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsg = performance.now();
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
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.closed) return;
      if (FINAL.has(ev.reason)) return this.finish(ev.reason === 'replaced' ? 'Opened in another tab' : 'Connection lost');
      this.retry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /** Try again with growing pauses (0.5, 1, 2, 4, 8, 8 ... s) for up to two minutes. */
  private retry() {
    if (this.closed || this.retryTimer) return;
    const now = performance.now();
    if (this.attempt === 0) this.lostAt = now;
    if (now - this.lostAt > RETRY_FOR) return this.finish('Connection lost');
    this.attempt++;
    this.onReconnect('lost', this.attempt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.connect();
    }, Math.min(8000, 250 * 2 ** this.attempt));
  }

  /**
   * Drop a connection that went silent, or one stuck closing (no close reply), and start again.
   * Only judged while the tab is visible: a hidden tab pings rarely.
   */
  private watchdog() {
    const st = this.ws.readyState;
    if (this.closed || document.hidden || (st !== WebSocket.OPEN && st !== WebSocket.CLOSING)) return;
    if (performance.now() - this.lastMsg < (st === WebSocket.CLOSING ? 3000 : SILENT)) return;
    const ws = this.ws;
    ws.onclose = null;
    ws.close();
    this.retry();
  }

  /** Back in the tab: check the line at once, and do not wait out a long retry pause. */
  private onVisible = () => {
    if (document.hidden || this.closed) return;
    this.lastMsg = Math.max(this.lastMsg, performance.now() - SILENT + 4000);
    this.send({ t: 'ping', n: performance.now() });
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.connect();
    }
  };

  private finish(reason: string) {
    if (this.closed) return;
    this.cleanup();
    this.onClose(reason);
  }

  private cleanup() {
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  send(msg: ClientMsg) {
    const s = JSON.stringify(msg);
    if (msg.t === 'hello') this.hello = s;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    // Only the first connection queues; orders given while reconnecting are stale and dropped.
    else if (this.ws.readyState === WebSocket.CONNECTING && !this.opened) this.queue.push(s);
  }

  close() {
    this.cleanup();
    this.ws.close();
  }
}

export interface SkirmishSettings {
  name: string;
  faction: Faction;
  theme: Theme;
  bots: { faction: Faction }[];
  teams: 'ffa' | '2v2';
  fleet: Fleet;
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
      { name: s.name, faction: s.faction, team: teamOf(slots[0]), slot: slots[0], bot: false, fleet: s.fleet },
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

  /** Let the AI play for you (handy for demos and spectating). */
  autopilot() {
    if (!this.bots.some((b) => b.pid === 0)) this.bots.push(new Bot(this.game, 0));
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
