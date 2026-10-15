// Player loadouts, persisted in localStorage. Defaults are the recommended setup.
import { Loadouts, UNIT_TYPES, UnitType, sanitizeLoadout } from '../shared/defs';

const KEY = 'salvo.loadouts.v1';
let current: Loadouts = load();

function load(): Loadouts {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out: Loadouts = {};
    for (const t of UNIT_TYPES) if (raw[t]) out[t] = sanitizeLoadout(t, raw[t]);
    return out;
  } catch {
    return {};
  }
}

export function getLoadouts(): Loadouts {
  return current;
}

export function loadoutOf(type: UnitType): string[] {
  return sanitizeLoadout(type, current[type]);
}

export function setLoadout(type: UnitType, lo: string[] | null) {
  if (lo) current[type] = sanitizeLoadout(type, lo);
  else delete current[type];
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
}

/** Loadouts in effect for the current match (frozen at start). */
let matchLoadouts: Loadouts = {};
export function freezeForMatch() {
  matchLoadouts = JSON.parse(JSON.stringify(current));
}
export function matchLoadoutOf(type: UnitType): string[] {
  return sanitizeLoadout(type, matchLoadouts[type]);
}
