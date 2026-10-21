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
        slot = this.join(ws, msg.name, msg.faction, msg.fleet);
        return;
      }
      if (!slot) return;
      this.handle(slot, msg);
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
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  private join(ws: WebSocket, rawName: unknown, rawFaction: unknown, rawFleet: unknown): Slot | null {
    const name = String(rawName ?? 'PLAYER').replace(/[^\w .\-]/g, '').slice(0, 16).toUpperCase() || 'PLAYER';
    const faction: Faction = FACTIONS.includes(rawFaction as Faction) ? (rawFaction as Faction) : 'coalition';
    const fleet = sanitizeFleet(rawFleet);
    if (this.game) {
      // Rejoin a running game by name.
      const s = this.slots.find((s) => !s.bot && !s.ws && s.name === name);
      if (!s) {
        this.send(ws, { t: 'error', msg: 'Game already in progress.' });
        ws.close(1000, 'in progress');
        return null;
      }
      s.ws = ws;
      s.needFull = true;
      this.send(ws, { t: 'welcome', slot: s.slot, code: this.code });
      this.send(ws, { t: 'start', info: this.startInfo(s) });
      return s;
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
    const s: Slot = { slot: slotNo, name: uniqueName, faction, team: slotNo, bot: false, ready: false, ws, fleet, pid: -1, needFull: true, tokens: BUCKET, refill: Date.now() };
    this.slots.push(s);
    this.ensureHost();
    this.send(ws, { t: 'welcome', slot: slotNo, code: this.code });
    this.broadcastLobby();
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
          this.slots.push({ slot: slotNo, name: BOT_NAMES[slotNo % BOT_NAMES.length], faction: bf, team: slotNo, bot: true, ready: true, ws: null, fleet: undefined, pid: -1, needFull: false, tokens: 0, refill: 0 });
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
      while (acc >= TICK) {
        acc -= TICK;
        for (const b of this.bots) b.tick();
        g.step();
        // Snapshots go out at 5 Hz; events accumulate between them so none are lost.
        if (g.tickN % SNAP_EVERY !== 0 && !g.over) continue;
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
          return;
        }
      }
    }, TICK * 1000);
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
