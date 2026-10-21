// One Durable Object per room: lobby, authoritative simulation loop, and snapshot fan-out.
import { DurableObject } from 'cloudflare:workers';
import { FACTIONS, Faction, Fleet, TICK, sanitizeFleet } from '../shared/defs';
import { Game } from '../shared/game';
import { Bot } from '../shared/ai';
import { THEMES, Theme } from '../shared/map';
import type { ClientMsg, LobbySlot, LobbyState, ServerMsg } from '../shared/protocol';

interface Slot extends LobbySlot {
  ws: WebSocket | null;
  fleet: Fleet | undefined;
  pid: number; // player index once started
  /** The browser tab's reconnect token (empty for bots). */
  token: string;
  needFull: boolean;
  /** Token bucket for commands and chat. */
  tokens: number;
  refill: number;
}

const BUCKET = 40; // burst
const RATE = 20; // per second

const BOT_NAMES = ['ADM. HALSEY', 'CDR. ZHENG', 'CAPT. NIMITZ', 'ADM. YI', 'CDR. RICKOVER', 'CAPT. LIU'];
const MAX_SLOTS = 4;
const SNAP_EVERY = 2;

export class GameRoom extends DurableObject {
  private code = '';
  private slots: Slot[] = [];
  private theme: Theme = 'jungle';
  private teams: 'ffa' | '2v2' = 'ffa';
  private game: Game | null = null;
  private bots: Bot[] = [];
  private loop: ReturnType<typeof setInterval> | null = null;
  private idleSince = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.code = url.searchParams.get('code') ?? this.code;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket | null, msg: ServerMsg) {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closed */
    }
  }

  private attach(ws: WebSocket) {
    let slot: Slot | null = null;
    ws.addEventListener('message', (ev) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        return;
      }
      if (msg.t === 'ping') return this.send(ws, { t: 'pong', n: msg.n });
      if (msg.t === 'hello') {
        slot = this.join(ws, msg.name, msg.faction, msg.fleet, msg.token);
        return;
      }
      if (!slot || slot.ws !== ws) return;
      // One bad message must never take the room (and every player's connection) down.
      try {
        this.handle(slot, msg);
      } catch (e) {
        console.error('room: message failed', msg.t, e);
      }
    });
    const drop = () => {
      if (slot && slot.ws === ws) {
        slot.ws = null;
        if (!this.game) {
          this.slots = this.slots.filter((s) => s !== slot);
          this.ensureHost();
        }
        this.broadcastLobby();
      }
      if (!this.slots.some((s) => s.ws)) this.idleSince = Date.now();
    };
    ws.addEventListener('close', () => {
      // Answer the client's close frame: without it the browser waits about a minute before it
      // reports the socket closed (and only then reconnects).
      try {
        ws.close(1000, 'bye');
      } catch {
        /* already closed */
      }
      drop();
    });
    ws.addEventListener('error', drop);
  }

  private join(ws: WebSocket, rawName: unknown, rawFaction: unknown, rawFleet: unknown, rawToken: unknown): Slot | null {
    const name = String(rawName ?? 'PLAYER').replace(/[^\w .\-]/g, '').slice(0, 16).toUpperCase() || 'PLAYER';
    const faction: Faction = FACTIONS.includes(rawFaction as Faction) ? (rawFaction as Faction) : 'coalition';
    const fleet = sanitizeFleet(rawFleet);
    const token = typeof rawToken === 'string' ? rawToken.slice(0, 64) : '';
    // The same browser tab coming back (a refresh, a dropped connection): it takes back its seat, even
    // if the server has not noticed yet that the old connection is gone.
    const mine = token ? this.slots.find((s) => !s.bot && s.token === token) : undefined;
    if (mine) return this.resume(mine, ws);
    if (this.game) {
      // A seat left empty in a running game can be taken back by name (another tab or device).
      const s = this.slots.find((s) => !s.bot && !s.ws && s.name === name);
      if (!s) {
        this.send(ws, { t: 'error', msg: 'Game already in progress.' });
        ws.close(1000, 'in progress');
        return null;
      }
      if (token) s.token = token;
      return this.resume(s, ws);
    }
    if (this.slots.length >= MAX_SLOTS) {
      // Replace a bot if there is one.
      const bot = this.slots.find((s) => s.bot);
      if (!bot) {
        this.send(ws, { t: 'error', msg: 'Room is full.' });
        ws.close(1000, 'full');
        return null;
      }
      this.slots = this.slots.filter((s) => s !== bot);
    }
    const used = new Set(this.slots.map((s) => s.slot));
    const order = [0, 2, 1, 3];
    const slotNo = order.find((n) => !used.has(n)) ?? 0;
    let uniqueName = name;
    let k = 2;
    while (this.slots.some((s) => s.name === uniqueName)) uniqueName = `${name}${k++}`;
    const s: Slot = { slot: slotNo, name: uniqueName, faction, team: slotNo, bot: false, ready: false, ws, fleet, pid: -1, token, needFull: true, tokens: BUCKET, refill: Date.now() };
    this.slots.push(s);
    this.ensureHost();
    this.send(ws, { t: 'welcome', slot: slotNo, code: this.code });
    this.broadcastLobby();
    return s;
  }

  /** Put a returning player back in their seat on a new connection; the old one, if still open, is closed. */
  private resume(s: Slot, ws: WebSocket): Slot {
    const old = s.ws;
    s.ws = ws;
    s.needFull = true;
    if (old && old !== ws) {
      try {
        old.close(1000, 'replaced');
      } catch {
        /* already closed */
      }
    }
    this.send(ws, { t: 'welcome', slot: s.slot, code: this.code });
    if (this.game) this.send(ws, { t: 'start', info: this.startInfo(s) });
    else this.broadcastLobby();
    return s;
  }

  private ensureHost() {
    const humans = this.slots.filter((s) => !s.bot);
    if (!humans.length) return;
    if (!humans.some((s) => s.host)) humans[0].host = true;
  }

  private allow(slot: Slot, cost: number): boolean {
    const now = Date.now();
    slot.tokens = Math.min(BUCKET, slot.tokens + ((now - slot.refill) / 1000) * RATE);
    slot.refill = now;
    if (slot.tokens < cost) return false;
    slot.tokens -= cost;
    return true;
  }

  private handle(slot: Slot, msg: ClientMsg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'cmd' && (!msg.cmd || typeof msg.cmd !== 'object')) return;
    if ((msg.t === 'cmd' || msg.t === 'chat' || msg.t === 'lobby') && !this.allow(slot, msg.t === 'chat' ? 8 : 1)) return;
    if (msg.t === 'cmd') {
      if (this.game && slot.pid >= 0) this.game.command(slot.pid, msg.cmd);
      return;
    }
    if (msg.t === 'chat') {
      const text = String(msg.text ?? '').slice(0, 140);
      for (const s of this.slots) this.send(s.ws, { t: 'chat', from: slot.name, text });
      return;
    }
    if (this.game) return;
    if (msg.t === 'lobby') {
      if (msg.faction && FACTIONS.includes(msg.faction)) slot.faction = msg.faction;
      if (typeof msg.ready === 'boolean') slot.ready = msg.ready;
      if (slot.host) {
        if (msg.theme && THEMES.includes(msg.theme)) this.theme = msg.theme;
        if (msg.teams === 'ffa' || msg.teams === '2v2') this.teams = msg.teams;
        if (msg.addBot && this.slots.length < MAX_SLOTS) {
          const used = new Set(this.slots.map((s) => s.slot));
          const slotNo = [0, 2, 1, 3].find((n) => !used.has(n))!;
          const bf: Faction = slot.faction === 'coalition' ? 'union' : 'coalition';
          this.slots.push({ slot: slotNo, name: BOT_NAMES[slotNo % BOT_NAMES.length], faction: bf, team: slotNo, bot: true, ready: true, ws: null, fleet: undefined, pid: -1, token: '', needFull: false, tokens: 0, refill: 0 });
        }
        if (typeof msg.removeSlot === 'number') this.slots = this.slots.filter((s) => !(s.bot && s.slot === msg.removeSlot));
        if (msg.botFaction) {
          const b = this.slots.find((s) => s.bot && s.slot === msg.botFaction!.slot);
          if (b && FACTIONS.includes(msg.botFaction.faction)) b.faction = msg.botFaction.faction;
        }
      }
      this.broadcastLobby();
      return;
    }
    if (msg.t === 'start' && slot.host) this.startGame();
  }

  private lobbyState(forSlot: Slot): LobbyState {
    return {
      code: this.code,
      theme: this.theme,
      teams: this.teams,
      started: !!this.game,
      slots: this.slots
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((s) => ({ slot: s.slot, name: s.name, faction: s.faction, team: this.teamOf(s), bot: s.bot, ready: s.ready, you: s === forSlot, host: s.host })),
    };
  }

  private teamOf(s: Slot): number {
    if (this.teams === '2v2') return s.slot === 0 || s.slot === 1 ? 0 : 1;
    return s.slot;
  }

  private broadcastLobby() {
    for (const s of this.slots) this.send(s.ws, { t: 'lobby', lobby: this.lobbyState(s) });
  }

  private startInfo(s: Slot) {
    const g = this.game!;
    return {
      seed: g.seed,
      theme: g.theme,
      you: s.pid,
      players: g.players.map((p) => ({ id: p.id, name: p.name, faction: p.faction, team: p.team, slot: p.slot, bot: p.bot })),
    };
  }

  private startGame() {
    if (this.slots.length < 2) {
      const host = this.slots.find((s) => s.host);
      this.send(host?.ws ?? null, { t: 'error', msg: 'Need at least 2 players. Add a bot.' });
      return;
    }
    const ordered = this.slots.slice().sort((a, b) => a.slot - b.slot);
    // 2-player games use opposite corners.
    if (ordered.length === 2) {
      ordered[0].slot = 0;
      ordered[1].slot = 2;
    }
    ordered.forEach((s, i) => (s.pid = i));
    const seed = (Math.random() * 2 ** 31) | 0;
    this.game = new Game(
      seed,
      this.theme,
      ordered.map((s) => ({ name: s.name, faction: s.faction, team: this.teamOf(s), slot: s.slot, bot: s.bot, fleet: s.fleet })),
    );
    this.bots = ordered.filter((s) => s.bot).map((s) => new Bot(this.game!, s.pid));
    for (const s of ordered) {
      s.needFull = true;
      this.send(s.ws, { t: 'start', info: this.startInfo(s) });
    }
    let last = Date.now();
    let acc = 0;
    this.loop = setInterval(() => {
      const now = Date.now();
      acc += Math.min(1000, now - last) / 1000;
      last = now;
      const g = this.game;
      if (!g) return;
      if (!this.slots.some((s) => s.ws)) {
        if (Date.now() - this.idleSince > 5 * 60_000) this.stopGame();
        return; // pause while nobody is connected
      }
      try {
        while (acc >= TICK && this.game === g) {
          acc -= TICK;
          this.step(g);
        }
      } catch (e) {
        // Keep the room alive: log it, drop the backlog and carry on with the next tick.
        console.error('room: tick failed', e);
        acc = 0;
      }
    }, TICK * 1000);
  }

  /** One simulation tick; snapshots go out every SNAP_EVERY ticks (5 Hz). */
  private step(g: Game) {
    for (const b of this.bots) b.tick();
    g.step();
    // Events accumulate between snapshots so none are lost.
    if (g.tickN % SNAP_EVERY !== 0 && !g.over) return;
    for (const s of this.slots) {
      if (!s.ws || s.pid < 0) continue;
      const snap = g.snapshotFor(s.pid, s.needFull);
      s.needFull = false;
      this.send(s.ws, snap);
    }
    g.flushEvents();
    if (g.over) {
      const winners = g.players.filter((p) => p.team === g.winnerTeam).map((p) => p.id);
      for (const s of this.slots) this.send(s.ws, { t: 'end', winner: g.winnerTeam, winners, stats: g.results() });
      this.stopGame();
    }
  }

  private stopGame() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.game = null;
    this.bots = [];
    // Back to lobby for anyone still connected.
    this.slots = this.slots.filter((s) => s.ws || s.bot);
    for (const s of this.slots) {
      s.pid = -1;
      s.ready = false;
    }
    this.ensureHost();
    this.broadcastLobby();
  }
}
