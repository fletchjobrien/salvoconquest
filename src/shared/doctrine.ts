// Faction doctrines. The two navies are equal in price, build time, hull, sensors and damage;
// what differs is how their warships fight: each class has a faction trait (passive) and a
// special ability (active, hotkey F).
//   Coalition (blue) — shield and network: out-defend, out-sense, sustain carriers.
//   Union (red)      — swarm and strike: saturate, mine, outrange, jam.
import type { Faction, UnitType } from './defs';

export type SpecialId = 'aegis' | 'silent' | 'gunfire' | 'surge' | 'saturation' | 'minefield' | 'hypersonic' | 'screen';

export interface SpecialDef {
  id: SpecialId;
  name: string;
  /** Short tag shown on the map while active. */
  tag: string;
  desc: string;
  /** Seconds before it can be used again (counted from activation). */
  cooldown: number;
  /** Seconds it stays active (0 = instant). */
  duration: number;
  /** On/off switch instead of a timed effect. */
  toggle?: boolean;
}

export const SPECIALS: Record<SpecialId, SpecialDef> = {
  aegis: { id: 'aegis', name: 'Aegis Surge', tag: 'AEGIS', desc: 'For 15 s, SAMs reload twice as fast and are 20% more likely to kill incoming missiles.', cooldown: 75, duration: 15 },
  silent: { id: 'silent', name: 'Silent Running', tag: 'SILENT', desc: 'On/off. Half as easy to hear on sonar, but half speed.', cooldown: 3, duration: 0, toggle: true },
  gunfire: { id: 'gunfire', name: 'Naval Gunfire Support', tag: 'NGFS', desc: 'For 20 s, main guns fire twice as fast and reach 4 km further.', cooldown: 90, duration: 20 },
  surge: { id: 'surge', name: 'Surge Sorties', tag: 'SURGE', desc: 'For 30 s, flights based on this carrier rearm and refuel instantly.', cooldown: 120, duration: 30 },
  saturation: { id: 'saturation', name: 'Saturation Salvo', tag: 'SALVO', desc: 'For 12 s, anti-ship missiles ripple-fire as fast as the launchers allow.', cooldown: 90, duration: 12 },
  minefield: { id: 'minefield', name: 'Minefield', tag: 'MINES', desc: 'Lays four mines around the submarine at once.', cooldown: 75, duration: 0 },
  hypersonic: { id: 'hypersonic', name: 'Hypersonic Strike', tag: 'HYPER', desc: 'For 30 s, anti-ship missiles fly 1.7 times as fast and are 35% harder to shoot down.', cooldown: 120, duration: 30 },
  screen: { id: 'screen', name: 'Electronic Screen', tag: 'SCREEN', desc: 'For 25 s, enemy missiles aimed at our ships within 8 km of the carrier hit 40% less often.', cooldown: 100, duration: 25 },
};

/** Passive trait of a ship class in a faction. Module overrides apply to modules fitted. */
export interface Trait {
  text: string;
  mods?: Record<string, { range?: number; ammo?: number }>;
  hp?: number;
  sonar?: number;
  deck?: number;
  ecm?: number;
}

export interface Doctrine {
  title: string;
  playstyle: string;
  ships: Partial<Record<UnitType, { special: SpecialId; trait: Trait }>>;
}

export const DOCTRINES: Record<Faction, Doctrine> = {
  coalition: {
    title: 'Shield and network',
    playstyle: 'Out-defend and out-sense. Deep SAM magazines, quiet submarines, gunfire support and fast carrier sorties. Win the long fight.',
    ships: {
      destroyer: { special: 'aegis', trait: { text: '12 SAMs per launcher (instead of 8).', mods: { vls_sam: { ammo: 12 } } } },
      sub: { special: 'silent', trait: { text: 'Sonar range ×1.3.', sonar: 1.3 } },
      battleship: { special: 'gunfire', trait: { text: 'Armoured citadel: hull ×1.2.', hp: 1.2 } },
      carrier: { special: 'surge', trait: { text: 'Deck for 5 air flights (instead of 4).', deck: 5 } },
    },
  },
  union: {
    title: 'Swarm and strike',
    playstyle: 'Hit first and hard. Longer-range missiles, salvos that saturate defences, mines and hypersonics, and jamming cover. Win the opening exchange.',
    ships: {
      destroyer: { special: 'saturation', trait: { text: 'Anti-ship missiles reach 36 km, 6 per launcher.', mods: { vls_ashm: { range: 36, ammo: 6 } } } },
      sub: { special: 'minefield', trait: { text: '4 tube-launched anti-ship missiles (instead of 2).', mods: { tube_ashm: { ammo: 4 } } } },
      battleship: { special: 'hypersonic', trait: { text: '6 anti-ship missiles per launcher.', mods: { vls_ashm: { ammo: 6 } } } },
      carrier: { special: 'screen', trait: { text: 'Built-in jamming suite (missiles miss it more often).', ecm: 0.2 } },
    },
  },
};

export function shipDoctrine(faction: Faction, type: UnitType): { special: SpecialDef; trait: Trait } | null {
  const d = DOCTRINES[faction].ships[type];
  return d ? { special: SPECIALS[d.special], trait: d.trait } : null;
}
