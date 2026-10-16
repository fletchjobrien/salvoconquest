// Player loadouts, persisted in localStorage, one set per faction (each faction has its own
// weapons). Defaults are the recommended setup.
import { FACTIONS, Faction, Loadouts, UNIT_TYPES, UnitType, sanitizeLoadout } from '../shared/defs';

const KEY = 'salvo.loadouts.v2';
let current: Record<Faction, Loadouts> = load();

function load(): Record<Faction, Loadouts> {
  const out = { coalition: {}, union: {} } as Record<Faction, Loadouts>;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const f of FACTIONS) for (const t of UNIT_TYPES) if (raw[f]?.[t]) out[f][t] = sanitizeLoadout(t, raw[f][t], f);
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return out;
}

export function getLoadouts(faction: Faction): Loadouts {
  return current[faction];
}

export function loadoutOf(type: UnitType, faction: Faction): string[] {
  return sanitizeLoadout(type, current[faction][type], faction);
}

export function setLoadout(type: UnitType, faction: Faction, lo: string[] | null) {
  if (lo) current[faction][type] = sanitizeLoadout(type, lo, faction);
  else delete current[faction][type];
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
}

/** Loadouts in effect for the current match (frozen at start, for the faction we play). */
let matchLoadouts: Loadouts = {};
let matchFaction: Faction = 'coalition';
export function freezeForMatch(faction: Faction) {
  matchFaction = faction;
  matchLoadouts = JSON.parse(JSON.stringify(current[faction]));
}
export function matchLoadoutOf(type: UnitType): string[] {
  return sanitizeLoadout(type, matchLoadouts[type], matchFaction);
}
