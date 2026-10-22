// Wire protocol between client and the authoritative simulation.
// The same messages are used for online rooms (WebSocket) and offline play (in-browser host).
import type { Faction, Fleet, ProjKind, UnitType } from './defs';
import type { Theme } from './map';

export type Command =
  | { c: 'move'; ids: number[]; x: number; y: number; mode?: 'attack' | 'move' }
  | { c: 'attack'; ids: number[]; target: number }
  | { c: 'stop'; ids: number[] }
  | { c: 'board'; ids: number[]; ship: number }
  | { c: 'unload'; ship: number; ids: number[]; x: number; y: number }
  | { c: 'mines'; ids: number[] }
  | { c: 'rtb'; ids: number[] }
  | { c: 'autoretreat'; ids: number[]; on: boolean }
  | { c: 'build'; cat: 'naval' | 'ground' | 'air'; type: UnitType; x?: number; y?: number }
  | { c: 'cancel'; cat: 'naval' | 'ground' | 'air'; index: number }
  // Deployment phase only:
  | { c: 'deploy'; type: UnitType; x: number; y: number }
  | { c: 'undeploy'; ids: number[] }
  | { c: 'ready'; on: boolean }
  // Countermeasure of the selected units (chaff or smoke), hotkey C:
  | { c: 'counter'; ids: number[] }
  // Active radar on/off (emission control), hotkey G:
  | { c: 'radar'; ids: number[]; on: boolean }
  // Fire control: 0 hold fire, 1 weapons tight (2 missiles per target), 2 weapons free. Hotkey F:
  | { c: 'firemode'; ids: number[]; mode: number }
  // Carrier (ship) or airbase (site): launch every flight on the ground there toward a point (fighters patrol,
  // strike flights attack, AEW orbits). Hotkey L:
  | { c: 'launch'; ship?: number; site?: number; x: number; y: number }
  // Aircraft: move to this airbase (if it has room), land and stay there until launched (RMB on an own airbase):
  | { c: 'base'; ids: number[]; site: number }
  // Ships and aircraft follow and protect a friendly ship or aircraft (RMB on it):
  | { c: 'escort'; ids: number[]; target: number }
  // Missile cruiser: fire every anti-ship missile and SAM in quick succession. Hotkey B:
  | { c: 'salvo'; ids: number[] }
  // Battleship: sustained gunfire on an area. Hotkey B, then click:
  | { c: 'bombard'; ids: number[]; x: number; y: number };

export interface LobbySlot {
  slot: number;
  name: string;
  faction: Faction;
  team: number;
  bot: boolean;
  ready: boolean;
  you?: boolean;
  host?: boolean;
}

export interface LobbyState {
  code: string;
  theme: Theme;
  slots: LobbySlot[];
  started: boolean;
  teams: 'ffa' | '2v2';
}

export type ClientMsg =
  /** token: random per browser tab, kept across reloads, so a refresh or a dropped connection takes back the same seat. */
  | { t: 'hello'; name: string; faction: Faction; fleet: Fleet; token?: string }
  | { t: 'lobby'; theme?: Theme; addBot?: boolean; removeSlot?: number; teams?: 'ffa' | '2v2'; faction?: Faction; ready?: boolean; botFaction?: { slot: number; faction: Faction } }
  | { t: 'start' }
  | { t: 'cmd'; cmd: Command }
  | { t: 'ping'; n: number }
  | { t: 'chat'; text: string };

export interface StartInfo {
  seed: number;
  theme: Theme;
  you: number;
  players: { id: number; name: string; faction: Faction; team: number; slot: number; bot: boolean }[];
}

/** Unit row: id, type index, owner, x, y, alt, heading, hp 0-100, flags, fleet-comp variant. */
export type UnitRow = [number, number, number, number, number, number, number, number, number, number];
/** Contact row: id, kind (domain index 0-3 or 10+type index when classified), x, y, error radius, flags (1 = ESM only). */
export type ContactRow = [number, number, number, number, number, number];
/** Projectile row: id, kind index, x, y, alt, team-relative owner (1 = friendly, 0 = hostile). */
export type ProjRow = [number, number, number, number, number, number];
/** Site row: id, owner, capture progress 0-100, capturing player. */
export type SiteRow = [number, number, number, number];
/** Own unit detail: id, ammo[], cargo ids[], fuel 0-100, order code, order x, order y, flags (1 auto-retreat, 2 embarked), type index. */
/**
 * Own-unit details: id, ammo, cargo ids, fuel %, order code, order x, order y, flags, type index,
 * then (aircraft) range left before bingo in km, nearest base x, y, (carriers) the deck: ids of
 * flights based on it, (ships) the damage state, countermeasure charges left, kills, and the bearing to an
 * enemy radar holding it (centiradians, map frame; 999 = not locked).
 */
export type DetailRow = [number, number[], number[], number, number, number, number, number, number, number, number, number, number[], DamageRow, number, number, number];
/** Seconds left on each damaged system: engine, rudder, radar, fire, flood, stun, disabled weapon index (-1 none), weapon. */
export type DamageRow = [number, number, number, number, number, number, number, number];
/** Weather cell: kind (0 storm, 1 fog), x, y, radius, intensity 0-100. */
export type WeatherRow = [number, number, number, number, number];
/** On the wire: kind, x, y, radius, intensity, vx, vy (km/s), id. */
export type WeatherWire = [number, number, number, number, number, number, number, number];

export interface QueueItem {
  type: UnitType;
  progress: number; // 0..1
  /** Placed build: where the unit goes once built, and the site that builds it. */
  x?: number;
  y?: number;
  s?: number;
}

export interface Snapshot {
  t: 's';
  time: number;
  cash: number;
  income: number;
  u: UnitRow[];
  c: ContactRow[];
  p: ProjRow[];
  d: DetailRow[];
  e: GameEvent[];
  s?: SiteRow[];
  w?: WeatherWire[];
  q?: Record<'naval' | 'ground' | 'air', QueueItem[]>;
  pl?: { id: number; res: number; units: number; defeated: boolean; dom: number }[];
  /** Present while the deployment phase runs: seconds left and the players who are ready. */
  ph?: { left: number; ready: number[] };
  /** Smoke screens: x, y, radius, seconds left. */
  sm?: [number, number, number, number][];
  /** Our team's sonobuoys: x, y, seconds left. */
  bu?: [number, number, number][];
  /** Our airbases: site id and the flights based there (on the ground or in the air). */
  ab?: [number, number[]][];
}

export type GameEvent =
  | { k: 'fire'; id: number; m: string; x: number; y: number; tx: number; ty: number; a?: number }
  /** p: kind of the round that hit (index in PROJ_KINDS), when it was a hit on a unit. */
  | { k: 'boom'; x: number; y: number; s: number; w: boolean; a?: number; p?: number }
  /** s: splash size (0.35 small round ... 0.8 heavy shell). */
  | { k: 'splash'; x: number; y: number; s?: number }
  | { k: 'intercept'; x: number; y: number; a: number }
  | { k: 'kill'; id: number; ty: number; x: number; y: number; o: number; h: number }
  | { k: 'capture'; site: number; o: number; prev: number }
  | { k: 'cash'; o: number; v: number; x: number; y: number }
  | { k: 'built'; id: number; ty: number; o: number }
  | { k: 'land'; id: number; x: number; y: number }
  | { k: 'board'; id: number; ship: number }
  | { k: 'retreat'; id: number; ammo?: boolean }
  | { k: 'vampire'; x: number; y: number }
  | { k: 'lightning'; x: number; y: number }
  | { k: 'mine'; x: number; y: number }
  | { k: 'buoy'; x: number; y: number }
  | { k: 'defeat'; o: number }
  | { k: 'crit'; id: number; part: CritPart; o: number; m?: string }
  | { k: 'battle' }
  | { k: 'chaff'; id: number; x: number; y: number; a: number }
  | { k: 'smoke'; id: number; x: number; y: number; r: number }
  | { k: 'msg'; text: string; o?: number };

export type ServerMsg =
  | { t: 'welcome'; slot: number; code: string }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'start'; info: StartInfo }
  | Snapshot
  | { t: 'end'; winner: number; winners: number[]; stats: { id: number; name: string; kills: number; losses: number; earned: number }[] }
  | { t: 'error'; msg: string }
  | { t: 'pong'; n: number }
  | { t: 'chat'; from: string; text: string };

export const PROJ_KINDS: ProjKind[] = ['shell', 'missile', 'sam', 'torpedo', 'bomb', 'bullet', 'mine', 'atgm'];

// Unit flags
export const F_MOVING = 1;
export const F_FIRING = 2;
export const F_RETREAT = 4;
export const F_LANDED = 8;
export const F_CARGO = 16; // carrying troops
export const F_DAMAGED = 32;
export const F_LOADING = 64;
export const F_FIRE = 128; // on fire
export const F_STOPPED = 256; // engine knocked out: dead in the water
export const F_STUN = 512; // crew stunned: cannot fire
export const F_PAINTED = 1024; // an enemy radar is tracking this unit right now
export const F_DARK = 2048; // own radar switched off (emission control)
export const F_HOLD = 4096; // fire control: hold fire
export const F_FREE = 8192; // fire control: weapons free (neither bit: weapons tight)
export const F_ABOARD = 16384; // aircraft stowed on a carrier: not drawn, launched with the carrier's LAUNCH order

/** Ship systems that a hit can knock out (WARNO-style critical damage). */
export type CritPart = 'engine' | 'rudder' | 'radar' | 'weapon' | 'fire' | 'flood' | 'stun';

// Order codes for DetailRow
export const ORDER_CODES = ['idle', 'move', 'attack', 'board', 'patrol', 'rtb', 'retreat', 'unload', 'merchant', 'lander', 'escort', 'bombard'] as const;
