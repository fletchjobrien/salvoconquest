// Wire protocol between client and the authoritative simulation.
// The same messages are used for online rooms (WebSocket) and offline play (in-browser host).
import type { Faction, Loadouts, ProjKind, UnitType } from './defs';
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
  | { c: 'factory'; cat: 'naval' | 'ground' | 'air'; site?: number; unit?: number }
  // Deployment phase only:
  | { c: 'deploy'; type: UnitType; x: number; y: number }
  | { c: 'undeploy'; ids: number[] }
  | { c: 'ready'; on: boolean }
  // Faction special ability of the selected ships (doctrine.ts), hotkey F:
  | { c: 'special'; ids: number[] }
  // Countermeasure of the selected units (chaff or smoke), hotkey C:
  | { c: 'counter'; ids: number[] };

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
  | { t: 'hello'; name: string; faction: Faction; loadouts: Loadouts }
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

/** Unit row: id, type index, owner, x, y, alt, heading, hp 0-100, flags. */
export type UnitRow = [number, number, number, number, number, number, number, number, number];
/** Contact row: id, kind (domain index 0-3 or 10+type index when classified), x, y, error radius. */
export type ContactRow = [number, number, number, number, number];
/** Projectile row: id, kind index, x, y, alt, team-relative owner (1 = friendly, 0 = hostile). */
export type ProjRow = [number, number, number, number, number, number];
/** Site row: id, owner, capture progress 0-100, capturing player. */
export type SiteRow = [number, number, number, number];
/** Own unit detail: id, ammo[], cargo ids[], fuel 0-100, order code, order x, order y, flags (1 auto-retreat, 2 embarked), type index. */
/**
 * Own-unit details: id, ammo, cargo ids, fuel %, order code, order x, order y, flags, type index,
 * then (aircraft) range left before bingo in km, nearest base x, y, (carriers) the deck: ids of
 * flights based on it, (ships) the damage state, the faction special, and countermeasure charges left.
 */
export type DetailRow = [number, number[], number[], number, number, number, number, number, number, number, number, number, number[], DamageRow, SpecialRow, number];
/** Faction special: seconds until usable, seconds still active, toggle on (1/0). */
export type SpecialRow = [number, number, number];
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
  f?: Record<'naval' | 'ground' | 'air', number>; // factory site (>=0) or carrier unit (encoded -1-id)
  pl?: { id: number; res: number; units: number; defeated: boolean; dom: number }[];
  /** Present while the deployment phase runs: seconds left and the players who are ready. */
  ph?: { left: number; ready: number[] };
  /** Smoke screens: x, y, radius, seconds left. */
  sm?: [number, number, number, number][];
}

export type GameEvent =
  | { k: 'fire'; id: number; m: string; x: number; y: number; tx: number; ty: number; a?: number }
  | { k: 'boom'; x: number; y: number; s: number; w: boolean; a?: number }
  | { k: 'splash'; x: number; y: number }
  | { k: 'intercept'; x: number; y: number; a: number }
  | { k: 'kill'; id: number; ty: number; x: number; y: number; o: number; h: number }
  | { k: 'capture'; site: number; o: number; prev: number }
  | { k: 'cash'; o: number; v: number; x: number; y: number }
  | { k: 'built'; id: number; ty: number; o: number }
  | { k: 'land'; id: number; x: number; y: number }
  | { k: 'board'; id: number; ship: number }
  | { k: 'retreat'; id: number }
  | { k: 'vampire'; x: number; y: number }
  | { k: 'lightning'; x: number; y: number }
  | { k: 'mine'; x: number; y: number }
  | { k: 'defeat'; o: number }
  | { k: 'crit'; id: number; part: CritPart; o: number; m?: string }
  | { k: 'battle' }
  | { k: 'special'; id: number; s: string; o: number; on: boolean }
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

export const PROJ_KINDS: ProjKind[] = ['shell', 'missile', 'sam', 'torpedo', 'bomb', 'bullet', 'mine'];

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

/** Ship systems that a hit can knock out (WARNO-style critical damage). */
export type CritPart = 'engine' | 'rudder' | 'radar' | 'weapon' | 'fire' | 'flood' | 'stun';

// Order codes for DetailRow
export const ORDER_CODES = ['idle', 'move', 'attack', 'board', 'patrol', 'rtb', 'retreat', 'unload', 'merchant', 'lander'] as const;
