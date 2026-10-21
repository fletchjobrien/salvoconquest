// Fleet comp: the variant picked for each class, persisted in localStorage, one pick per faction
// (each faction has its own weapons). Defaults are the recommended picks.
import { CLASSES, ClassId, FACTIONS, Faction, UnitType, sanitizeFleet, variantDef, variantIndex, variantLoadout } from '../shared/defs';

const KEY = 'salvo.fleet.v1';
let current: Record<Faction, Record<ClassId, number>> = load();

function load(): Record<Faction, Record<ClassId, number>> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return { coalition: sanitizeFleet(raw.coalition), union: sanitizeFleet(raw.union) };
}

export function getFleet(faction: Faction): Record<ClassId, number> {
  return current[faction];
}

export function setVariant(faction: Faction, cls: ClassId, index: number) {
  current[faction][cls] = Math.max(0, Math.min(2, index));
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
}

export function resetFleet(faction: Faction) {
  current[faction] = sanitizeFleet({});
  setVariant(faction, 'corvette', CLASSES.corvette.def);
}

/** The fleet in effect for the current match (frozen at start, for the faction we play). */
let matchFleet: Record<ClassId, number> = sanitizeFleet({});
let matchFaction: Faction = 'coalition';
export function freezeForMatch(faction: Faction) {
  matchFaction = faction;
  matchFleet = { ...current[faction] };
}
export function getMatchFleet(): Record<ClassId, number> {
  return matchFleet;
}

/** Modules of a unit of one of our types as our fleet builds it. */
export function fleetLoadout(type: UnitType): string[] {
  const v = variantDef(type, variantIndex(matchFleet, type) ?? 0);
  return v ? variantLoadout(v, matchFaction) : [];
}

/** Modules of any unit we can see: its type, its variant (from the snapshot) and its owner's faction. */
export function unitLoadout(type: UnitType, variant: number, faction: Faction): string[] {
  const v = variantDef(type, variant);
  return v ? variantLoadout(v, faction) : [];
}

export const ALL_FACTIONS = FACTIONS;
