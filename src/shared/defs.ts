// Static game data: factions, units, weapon/utility modules, buildings.
// World units are kilometres and seconds. Speeds are "game speed", not real knots.

export type Faction = 'coalition' | 'union';
export const FACTIONS: Faction[] = ['coalition', 'union'];

export type Domain = 'sea' | 'sub' | 'air' | 'land';
export type Category = 'naval' | 'ground' | 'air' | 'support';
export type TargetClass = 'sea' | 'sub' | 'air' | 'land' | 'missile';

export type UnitType =
  | 'sub'
  | 'destroyer'
  | 'battleship'
  | 'carrier'
  | 'infantry'
  | 'coastal'
  | 'sam'
  | 'strike'
  | 'fighter'
  | 'recon'
  | 'merchant'
  | 'lander';

export const UNIT_TYPES: UnitType[] = [
  'sub',
  'destroyer',
  'battleship',
  'carrier',
  'infantry',
  'coastal',
  'sam',
  'strike',
  'fighter',
  'recon',
  'merchant',
  'lander',
];
export const BUILDABLE: Record<'naval' | 'ground' | 'air', UnitType[]> = {
  naval: ['destroyer', 'sub', 'battleship', 'carrier'],
  ground: ['infantry', 'coastal', 'sam'],
  air: ['fighter', 'strike', 'recon'],
};

export type SlotKind = 'mount' | 'heavy' | 'vls' | 'tube' | 'aux' | 'hard' | 'pod' | 'arms' | 'kit';
export const SLOT_LABEL: Record<SlotKind, string> = {
  mount: 'DECK MOUNT',
  heavy: 'MAIN BATTERY',
  vls: 'VLS CELLS',
  tube: 'TORPEDO ROOM',
  aux: 'AUXILIARY',
  hard: 'HARDPOINT',
  pod: 'POD',
  arms: 'ARMS',
  kit: 'SUPPORT KIT',
};

export type ProjKind = 'shell' | 'missile' | 'sam' | 'torpedo' | 'bomb' | 'bullet' | 'mine';

export interface ModuleDef {
  id: string;
  name: string;
  short: string;
  slots: SlotKind[];
  desc: string;
  // Weapon fields (absent for utilities).
  proj?: ProjKind;
  range?: number;
  dmg?: Partial<Record<TargetClass, number>>;
  cooldown?: number;
  /** -1 = unlimited. */
  ammo?: number;
  /** Ammo regained per second when not at a base (ground launchers). */
  regen?: number;
  speed?: number;
  accuracy?: number;
  /** Chance that one shot kills an incoming missile. */
  intercept?: number;
  /** Missile seeker acquisition radius (km) around the aim point. */
  seeker?: number;
  /** Manually triggered ability instead of automatic fire. */
  ability?: 'mines';
  // Utility modifiers.
  mods?: {
    hp?: number;
    speed?: number;
    radar?: number;
    radarAir?: number;
    radarSurf?: number;
    sonar?: number;
    sonarMul?: number;
    visual?: number;
    ecm?: number;
    hold?: number;
    fuel?: number;
    quiet?: number;
    entrench?: number;
    regen?: number;
  };
}

const M = (m: ModuleDef) => m;

export const MODULES: Record<string, ModuleDef> = {
  // ---- naval ----
  gun127: M({ id: 'gun127', name: '127mm Naval Gun', short: 'GUN', slots: ['mount'], desc: 'Fast-firing gun. Good against boats, coast and landing craft.', proj: 'shell', range: 10, dmg: { sea: 7, land: 9 }, cooldown: 2, ammo: -1, speed: 2.4, accuracy: 0.55 }),
  gun76: M({ id: 'gun76', name: '76mm Rapid Gun', short: 'GUN', slots: ['mount', 'aux'], desc: 'Light rapid gun. Shorter range, can also shoot at aircraft.', proj: 'shell', range: 7, dmg: { sea: 4, land: 5, air: 4 }, cooldown: 0.8, ammo: -1, speed: 2.8, accuracy: 0.5 }),
  gun406: M({ id: 'gun406', name: '406mm Triple Turret', short: 'MAIN', slots: ['heavy'], desc: 'Huge shells. Long range shore bombardment and ship killing.', proj: 'shell', range: 16, dmg: { sea: 28, land: 30 }, cooldown: 5, ammo: -1, speed: 2.2, accuracy: 0.42 }),
  railgun: M({ id: 'railgun', name: 'Railgun', short: 'RAIL', slots: ['heavy'], desc: 'Hypersonic slug. Very long range, slower to cycle.', proj: 'shell', range: 22, dmg: { sea: 32, land: 26 }, cooldown: 8, ammo: -1, speed: 5, accuracy: 0.5 }),
  vls_ashm: M({ id: 'vls_ashm', name: 'Anti-Ship Missiles', short: 'ASM', slots: ['vls'], desc: 'Long range sea-skimming missiles. Can be shot down.', proj: 'missile', range: 30, dmg: { sea: 42 }, cooldown: 4, ammo: 4, speed: 0.9, accuracy: 0.9, seeker: 5 }),
  vls_sam: M({ id: 'vls_sam', name: 'Area SAM', short: 'SAM', slots: ['vls'], desc: 'Shoots down aircraft and incoming missiles out to 18 km.', proj: 'sam', range: 18, dmg: { air: 38, missile: 1 }, cooldown: 1.2, ammo: 8, speed: 1.6, accuracy: 0.75, intercept: 0.45 }),
  vls_lacm: M({ id: 'vls_lacm', name: 'Land Attack Missiles', short: 'LACM', slots: ['vls'], desc: 'Cruise missiles against ground forces from very far away.', proj: 'missile', range: 35, dmg: { land: 40 }, cooldown: 5, ammo: 4, speed: 0.75, accuracy: 0.9, seeker: 4 }),
  vls_asroc: M({ id: 'vls_asroc', name: 'ASW Rockets', short: 'ASW', slots: ['vls', 'tube'], desc: 'Rocket-thrown torpedoes. Fast kill against submarines.', proj: 'torpedo', range: 7, dmg: { sub: 40 }, cooldown: 6, ammo: 8, speed: 0.9, accuracy: 0.75, seeker: 2.5 }),
  torp: M({ id: 'torp', name: 'Heavy Torpedoes', short: 'TORP', slots: ['tube'], desc: 'Slow, silent, devastating. Hits ships and submarines.', proj: 'torpedo', range: 9, dmg: { sea: 55, sub: 50 }, cooldown: 8, ammo: 6, speed: 0.42, accuracy: 0.85, seeker: 2.5 }),
  tube_ashm: M({ id: 'tube_ashm', name: 'Tube-launched ASM', short: 'ASM', slots: ['tube'], desc: 'Anti-ship missiles fired from underwater. Reveals the sub.', proj: 'missile', range: 24, dmg: { sea: 38 }, cooldown: 6, ammo: 2, speed: 0.85, accuracy: 0.85, seeker: 5 }),
  ciws: M({ id: 'ciws', name: 'CIWS', short: 'CIWS', slots: ['aux', 'mount'], desc: 'Last-ditch gun that shreds incoming missiles at close range.', proj: 'bullet', range: 2, dmg: { air: 6, missile: 1 }, cooldown: 0.6, ammo: -1, accuracy: 0.6, intercept: 0.15 }),
  mines: M({ id: 'mines', name: 'Mine Rails', short: 'MINE', slots: ['aux'], desc: 'Drop hidden mines behind the ship. Ability: [M].', proj: 'mine', range: 0, dmg: { sea: 50, sub: 40 }, cooldown: 4, ammo: 6, ability: 'mines' }),
  ecm: M({ id: 'ecm', name: 'Decoys + ECM', short: 'ECM', slots: ['aux', 'pod', 'kit'], desc: 'Incoming missiles miss more often.', mods: { ecm: 0.35 } }),
  towed: M({ id: 'towed', name: 'Towed Sonar', short: 'SONAR', slots: ['aux'], desc: 'Hear submarines much further away.', mods: { sonarMul: 1.8 } }),
  radar_ext: M({ id: 'radar_ext', name: 'Long Range Radar', short: 'RADAR', slots: ['aux'], desc: 'Better radar range and accuracy.', mods: { radar: 1.25 } }),
  armor: M({ id: 'armor', name: 'Armour Belt', short: 'ARMR', slots: ['aux'], desc: '+35% hull points, -10% speed.', mods: { hp: 1.35, speed: 0.9 } }),
  troopbay: M({ id: 'troopbay', name: 'Troop Bay', short: 'BAY', slots: ['aux'], desc: 'Carry 2 more ground units.', mods: { hold: 2 } }),
  anechoic: M({ id: 'anechoic', name: 'Anechoic Tiles', short: 'QUIET', slots: ['aux'], desc: 'Harder to hear on enemy sonar.', mods: { quiet: 0.6 } }),
  // ---- air ----
  agm: M({ id: 'agm', name: 'Air-to-Ground Missiles', short: 'AGM', slots: ['hard'], desc: 'Stand-off missiles vs ground units and ships.', proj: 'missile', range: 9, dmg: { land: 26, sea: 22 }, cooldown: 2, ammo: 2, speed: 1.0, accuracy: 0.85, seeker: 3 }),
  bombs: M({ id: 'bombs', name: 'Guided Bombs', short: 'BOMB', slots: ['hard'], desc: 'Heavy damage, must overfly the target.', proj: 'bomb', range: 2.5, dmg: { land: 38, sea: 34 }, cooldown: 1.5, ammo: 2, speed: 0.8, accuracy: 0.8 }),
  air_ashm: M({ id: 'air_ashm', name: 'Heavy Anti-Ship Missile', short: 'ASM', slots: ['hard'], desc: 'One big missile that kills ships from 24 km.', proj: 'missile', range: 24, dmg: { sea: 55 }, cooldown: 2, ammo: 1, speed: 1.0, accuracy: 0.9, seeker: 5 }),
  air_torp: M({ id: 'air_torp', name: 'ASW Torpedo', short: 'TORP', slots: ['hard'], desc: 'Drop torpedoes on submarine contacts.', proj: 'torpedo', range: 4, dmg: { sub: 45, sea: 25 }, cooldown: 2, ammo: 2, speed: 0.5, accuracy: 0.8, seeker: 2.5 }),
  aam_long: M({ id: 'aam_long', name: 'Long Range AAM', short: 'AAM', slots: ['hard'], desc: 'Beyond-visual-range missiles against aircraft.', proj: 'sam', range: 14, dmg: { air: 40 }, cooldown: 2, ammo: 2, speed: 1.8, accuracy: 0.7 }),
  aam_short: M({ id: 'aam_short', name: 'Dogfight AAM', short: 'SRM', slots: ['hard'], desc: 'Agile short-range missiles.', proj: 'sam', range: 5, dmg: { air: 32 }, cooldown: 1.5, ammo: 2, speed: 2, accuracy: 0.8 }),
  gunpod: M({ id: 'gunpod', name: 'Cannon', short: 'GUN', slots: ['pod'], desc: 'Close range gun. Never runs dry.', proj: 'bullet', range: 1.6, dmg: { air: 6, land: 3, sea: 2 }, cooldown: 0.8, ammo: -1, accuracy: 0.5 }),
  droptank: M({ id: 'droptank', name: 'Drop Tank', short: 'FUEL', slots: ['pod', 'hard'], desc: '+60% time on station.', mods: { fuel: 1.6 } }),
  radarpod: M({ id: 'radarpod', name: 'Surveillance Radar', short: 'AEW', slots: ['pod'], desc: 'Huge radar bubble with good accuracy.', mods: { radarAir: 34, radarSurf: 28 } }),
  sonobuoy: M({ id: 'sonobuoy', name: 'Sonobuoys', short: 'BUOY', slots: ['pod'], desc: 'Detect submarines under the aircraft.', mods: { sonar: 7 } }),
  // ---- ground ----
  rifles: M({ id: 'rifles', name: 'Rifles + MG', short: 'MG', slots: ['arms'], desc: 'Infantry small arms. Holds ground.', proj: 'bullet', range: 2.2, dmg: { land: 5 }, cooldown: 1, ammo: -1, accuracy: 0.6 }),
  atgm: M({ id: 'atgm', name: 'ATGM Teams', short: 'ATGM', slots: ['arms'], desc: 'Anti-tank missiles. Also hit boats near the beach.', proj: 'missile', range: 3, dmg: { land: 16, sea: 8 }, cooldown: 4, ammo: -1, speed: 0.5, accuracy: 0.8, seeker: 0.8 }),
  mortar: M({ id: 'mortar', name: 'Mortars', short: 'MORT', slots: ['arms'], desc: 'Indirect fire. Longer range than rifles.', proj: 'shell', range: 4, dmg: { land: 7 }, cooldown: 3, ammo: -1, speed: 0.6, accuracy: 0.45 }),
  manpads: M({ id: 'manpads', name: 'MANPADS', short: 'AA', slots: ['arms', 'kit'], desc: 'Shoulder-fired missiles against low aircraft.', proj: 'sam', range: 4, dmg: { air: 22 }, cooldown: 4, ammo: 4, regen: 0.05, speed: 1.4, accuracy: 0.6 }),
  coastal_ashm: M({ id: 'coastal_ashm', name: 'Coastal Anti-Ship Missiles', short: 'ASM', slots: ['arms'], desc: 'Truck-launched missiles against ships.', proj: 'missile', range: 26, dmg: { sea: 40 }, cooldown: 10, ammo: 4, regen: 0.04, speed: 0.85, accuracy: 0.9, seeker: 5 }),
  ground_sam: M({ id: 'ground_sam', name: 'SAM Launchers', short: 'SAM', slots: ['arms'], desc: 'Medium range air defence. Also intercepts missiles.', proj: 'sam', range: 16, dmg: { air: 36, missile: 1 }, cooldown: 3.2, ammo: 8, regen: 0.08, speed: 1.6, accuracy: 0.72, intercept: 0.4 }),
  ground_ciws: M({ id: 'ground_ciws', name: 'SPAAG', short: 'AAA', slots: ['arms', 'kit'], desc: 'Radar guns vs aircraft and missiles at short range.', proj: 'bullet', range: 2.5, dmg: { air: 6, missile: 1 }, cooldown: 0.7, ammo: -1, accuracy: 0.55, intercept: 0.13 }),
  radartruck: M({ id: 'radartruck', name: 'Radar Truck', short: 'RDR', slots: ['kit'], desc: 'Own radar. Fire without help from the fleet.', mods: { radarAir: 20, radarSurf: 16 } }),
  entrench: M({ id: 'entrench', name: 'Engineers', short: 'ENG', slots: ['kit'], desc: '-30% damage taken while holding position.', mods: { entrench: 0.7 } }),
  medics: M({ id: 'medics', name: 'Field Medics', short: 'MED', slots: ['kit'], desc: 'Slowly heals in the field.', mods: { regen: 0.6 } }),
};

export interface SlotDef {
  kind: SlotKind;
}

export interface UnitDef {
  type: UnitType;
  category: Category;
  domain: Domain;
  names: Record<Faction, string>;
  short: string;
  cost: number;
  buildTime: number;
  hp: number;
  speed: number;
  /** Turn rate in rad/s. */
  turn: number;
  radarAir: number;
  radarSurf: number;
  sonar: number;
  visual: number;
  /** Radar signature multiplier (smaller = harder to see). */
  signature: number;
  hold: number;
  slots: SlotKind[];
  defaults: string[];
  fuel?: number;
  /** Carrier: can launch and rearm aircraft. */
  airbase?: boolean;
  /** Aircraft flights that can be based on this ship. */
  deck?: number;
  role: string;
  /** Approximate length in km, used for visuals and spacing. */
  size: number;
}

const U = (u: UnitDef) => u;

export const UNITS: Record<UnitType, UnitDef> = {
  destroyer: U({ type: 'destroyer', category: 'naval', domain: 'sea', names: { coalition: 'Arleigh-class Destroyer', union: 'Type-55 Destroyer' }, short: 'DDG', cost: 400, buildTime: 20, hp: 100, speed: 0.34, turn: 0.35, radarAir: 22, radarSurf: 15, sonar: 7, visual: 6, signature: 1, hold: 2, slots: ['mount', 'vls', 'vls', 'tube', 'aux'], defaults: ['gun127', 'vls_ashm', 'vls_sam', 'torp', 'ciws'], role: 'Workhorse. Missiles, air defence, sub hunting, carries 2 units.', size: 0.16 }),
  sub: U({ type: 'sub', category: 'naval', domain: 'sub', names: { coalition: 'Virginia-class SSN', union: 'Type-95 SSN' }, short: 'SSN', cost: 450, buildTime: 22, hp: 70, speed: 0.26, turn: 0.3, radarAir: 0, radarSurf: 0, sonar: 10, visual: 4, signature: 0, hold: 0, slots: ['tube', 'tube', 'aux'], defaults: ['torp', 'tube_ashm', 'anechoic'], role: 'Invisible hunter. Only sonar can find it.', size: 0.11 }),
  battleship: U({ type: 'battleship', category: 'naval', domain: 'sea', names: { coalition: 'Iowa-II Arsenal Ship', union: 'Type-60 Strike Cruiser' }, short: 'BB', cost: 900, buildTime: 42, hp: 230, speed: 0.25, turn: 0.22, radarAir: 20, radarSurf: 16, sonar: 4, visual: 6, signature: 1.6, hold: 3, slots: ['heavy', 'heavy', 'vls', 'vls', 'aux', 'aux'], defaults: ['gun406', 'gun406', 'vls_ashm', 'vls_sam', 'ciws', 'armor'], role: 'Floating fortress. Bombards islands, soaks damage, carries 3.', size: 0.26 }),
  carrier: U({ type: 'carrier', category: 'naval', domain: 'sea', names: { coalition: 'Ford-class Carrier', union: 'Type-04 Carrier' }, short: 'CV', cost: 1000, buildTime: 48, hp: 200, speed: 0.27, turn: 0.2, radarAir: 28, radarSurf: 16, sonar: 4, visual: 6, signature: 2, hold: 0, slots: ['vls', 'aux', 'aux', 'aux'], defaults: ['vls_sam', 'ciws', 'radar_ext', 'ecm'], airbase: true, deck: 4, role: 'Mobile airbase. Up to 4 air flights refuel and rearm on its deck.', size: 0.3 }),
  infantry: U({ type: 'infantry', category: 'ground', domain: 'land', names: { coalition: 'Marine Rifle Company', union: 'Naval Infantry Company' }, short: 'INF', cost: 150, buildTime: 10, hp: 60, speed: 0.1, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 5, signature: 0.5, hold: 0, slots: ['arms', 'arms', 'kit'], defaults: ['rifles', 'atgm', 'manpads'], role: 'Takes and holds islands. Kills other ground units.', size: 0.05 }),
  coastal: U({ type: 'coastal', category: 'ground', domain: 'land', names: { coalition: 'NSM Coastal Battery', union: 'YJ Coastal Battery' }, short: 'CDB', cost: 230, buildTime: 12, hp: 40, speed: 0.085, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 4, signature: 0.6, hold: 0, slots: ['arms', 'kit'], defaults: ['coastal_ashm', 'radartruck'], role: 'Anti-ship missiles. Turns an island into a fortress.', size: 0.05 }),
  sam: U({ type: 'sam', category: 'ground', domain: 'land', names: { coalition: 'Patriot Battery', union: 'HQ-9 Battery' }, short: 'SAM', cost: 210, buildTime: 12, hp: 40, speed: 0.085, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 4, signature: 0.6, hold: 0, slots: ['arms', 'kit'], defaults: ['ground_sam', 'radartruck'], role: 'Air umbrella. Kills planes and missiles.', size: 0.05 }),
  strike: U({ type: 'strike', category: 'air', domain: 'air', names: { coalition: 'F-35 Strike Flight', union: 'J-35 Strike Flight' }, short: 'ATK', cost: 300, buildTime: 15, hp: 30, speed: 0.9, turn: 1.4, radarAir: 9, radarSurf: 10, sonar: 0, visual: 6, signature: 0.5, hold: 0, slots: ['hard', 'hard', 'pod'], defaults: ['agm', 'bombs', 'ecm'], fuel: 110, role: 'Hits ships and ground units, then returns to rearm.', size: 0.02 }),
  fighter: U({ type: 'fighter', category: 'air', domain: 'air', names: { coalition: 'F-22 Fighter Flight', union: 'J-20 Fighter Flight' }, short: 'FTR', cost: 280, buildTime: 14, hp: 30, speed: 1.15, turn: 1.8, radarAir: 18, radarSurf: 6, sonar: 0, visual: 6, signature: 0.4, hold: 0, slots: ['hard', 'hard', 'pod'], defaults: ['aam_long', 'aam_short', 'gunpod'], fuel: 120, role: 'Owns the sky. Patrols and intercepts aircraft.', size: 0.02 }),
  recon: U({ type: 'recon', category: 'air', domain: 'air', names: { coalition: 'E-2 Hawkeye AEW', union: 'KJ-600 AEW' }, short: 'AEW', cost: 200, buildTime: 15, hp: 25, speed: 0.7, turn: 1.0, radarAir: 8, radarSurf: 8, sonar: 0, visual: 6, signature: 1, hold: 0, slots: ['pod', 'pod'], defaults: ['radarpod', 'sonobuoy'], fuel: 180, role: 'Flying radar. Sharpens every contact around it.', size: 0.025 }),
  merchant: U({ type: 'merchant', category: 'support', domain: 'sea', names: { coalition: 'Merchant Marine', union: 'Merchant Marine' }, short: 'MM', cost: 0, buildTime: 0, hp: 30, speed: 0.36, turn: 0.4, radarAir: 0, radarSurf: 6, sonar: 0, visual: 4, signature: 1, hold: 0, slots: [], defaults: [], role: 'Hauls resources home. Protect it.', size: 0.09 }),
  lander: U({ type: 'lander', category: 'support', domain: 'sea', names: { coalition: 'Landing Craft', union: 'Landing Craft' }, short: 'LC', cost: 0, buildTime: 0, hp: 14, speed: 0.32, turn: 2, radarAir: 0, radarSurf: 0, sonar: 0, visual: 3, signature: 0.3, hold: 0, slots: [], defaults: [], role: 'Ferries troops between ships and beaches.', size: 0.03 }),
};

/** Asymmetry: the Union fields cheaper, faster-built, slightly weaker kit. */
export const FACTION_MOD: Record<Faction, { cost: number; hp: number; build: number; sensor: number; dmg: number; name: string; tag: string }> = {
  coalition: { cost: 1, hp: 1, build: 1, sensor: 1, dmg: 1, name: 'Atlantic Coalition', tag: 'COALITION' },
  union: { cost: 0.65, hp: 0.8, build: 0.78, sensor: 0.88, dmg: 0.85, name: 'Pacific Union', tag: 'UNION' },
};

/** Every unit costs three times its base price: forces are small and every hull counts. */
export const COST_SCALE = 3;
export function unitCost(type: UnitType, faction: Faction): number {
  return Math.round((UNITS[type].cost * COST_SCALE * FACTION_MOD[faction].cost) / 5) * 5;
}
export function unitBuildTime(type: UnitType, faction: Faction): number {
  return UNITS[type].buildTime * FACTION_MOD[faction].build;
}

export type BuildingType = 'hq' | 'navalbase' | 'airbase' | 'barracks' | 'radar' | 'dockyard' | 'battery' | 'resource';

export interface BuildingDef {
  type: BuildingType;
  name: string;
  short: string;
  desc: string;
  radarAir: number;
  radarSurf: number;
  visual: number;
  /** Produces units of this category. */
  produces?: 'naval' | 'ground' | 'air';
  captureTime: number;
  weapons: string[];
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  hq: { type: 'hq', name: 'Headquarters', short: 'HQ', desc: 'Lose it and you lose the war. Earns a small income.', radarAir: 16, radarSurf: 12, visual: 6, captureTime: 30, weapons: ['ground_ciws'] },
  navalbase: { type: 'navalbase', name: 'Naval Base', short: 'NAV', desc: 'Builds ships. Repairs and rearms ships nearby.', radarAir: 0, radarSurf: 10, visual: 6, produces: 'naval', captureTime: 20, weapons: [] },
  airbase: { type: 'airbase', name: 'Airbase', short: 'AIR', desc: 'Builds, launches and rearms aircraft.', radarAir: 16, radarSurf: 0, visual: 5, produces: 'air', captureTime: 18, weapons: [] },
  barracks: { type: 'barracks', name: 'Barracks', short: 'BKS', desc: 'Trains ground units right on this island.', radarAir: 0, radarSurf: 0, visual: 5, produces: 'ground', captureTime: 15, weapons: [] },
  radar: { type: 'radar', name: 'Radar Station', short: 'RDR', desc: 'Long range radar coverage over a huge area.', radarAir: 36, radarSurf: 28, visual: 5, captureTime: 12, weapons: [] },
  dockyard: { type: 'dockyard', name: 'Dockyard', short: 'DOCK', desc: 'Forward port. Builds, repairs and rearms ships.', radarAir: 0, radarSurf: 10, visual: 5, produces: 'naval', captureTime: 15, weapons: [] },
  battery: { type: 'battery', name: 'Missile Battery', short: 'MSL', desc: 'Fires anti-ship and anti-air missiles for its owner.', radarAir: 20, radarSurf: 16, visual: 5, captureTime: 15, weapons: ['coastal_ashm', 'ground_sam'] },
  resource: { type: 'resource', name: 'Resource Site', short: 'RES', desc: 'Merchant ships haul its output home as cash.', radarAir: 0, radarSurf: 0, visual: 4, captureTime: 10, weapons: [] },
};

export function moduleFits(modId: string, slot: SlotKind): boolean {
  const m = MODULES[modId];
  return !!m && m.slots.includes(slot);
}

/** Every module that fits into at least one slot of this unit. */
export function modulesFor(type: UnitType): ModuleDef[] {
  const kinds = new Set(UNITS[type].slots);
  return Object.values(MODULES).filter((m) => m.slots.some((s) => kinds.has(s)));
}

export type Loadouts = Partial<Record<UnitType, string[]>>;

/** Returns a legal loadout for the unit: invalid entries fall back to defaults. */
export function sanitizeLoadout(type: UnitType, lo: unknown): string[] {
  const def = UNITS[type];
  const out = def.defaults.slice();
  if (!Array.isArray(lo)) return out;
  for (let i = 0; i < def.slots.length; i++) {
    const id = lo[i];
    if (typeof id === 'string' && moduleFits(id, def.slots[i])) out[i] = id;
  }
  return out;
}

/**
 * Critical ship damage, in seconds. An engine hit first stops the ship dead (ENGINE_STOP), then
 * leaves it slow (55 %) until repaired. Repairs run three times faster at a friendly naval base.
 */
export const CRIT = {
  engineStop: 8,
  engineSlow: 35,
  rudder: 30,
  radar: 40,
  weapon: 30,
  fire: 25,
  fireDps: 0.9,
  flood: 30,
  floodDps: 0.5,
  stunMax: 6,
};

export const MAP_SIZE = 80; // km
export const TICK = 0.1; // s
export const HQ_INCOME = 3; // $/s
export const MERCHANT_PAYOUT = 260;
/** Deployment budget (prices are tripled, see COST_SCALE); what you don't spend carries into battle. */
export const START_CASH = 6500;
/** Deployment phase: place your starting force, then launch (or wait for the timer). */
export const SETUP_TIME = 120;
/** The deployment zone reaches this far (km) beyond the home island's radius. */
export const DEPLOY_MARGIN = 7;
export const UNLOAD_RANGE = 8;
export const BOARD_RANGE = 8;
export const CAPTURE_RADIUS = 1.6;
export const DOMINATION_SHARE = 0.75;
export const DOMINATION_TIME = 180;

export interface DerivedStats {
  hp: number;
  speed: number;
  radarAir: number;
  radarSurf: number;
  sonar: number;
  ecm: number;
  quiet: number;
  hold: number;
  fuel: number;
  entrench: number;
  regen: number;
}

/** Final stats of a unit for a faction and loadout. Used by the simulation and the loadout editor. */
export function deriveStats(type: UnitType, faction: Faction, loadout: string[]): DerivedStats {
  const def = UNITS[type];
  const fac = FACTION_MOD[faction];
  let hpMul = 1;
  let spdMul = 1;
  let radarMul = 1;
  let radarAir = def.radarAir;
  let radarSurf = def.radarSurf;
  let sonar = def.sonar;
  let sonarMul = 1;
  let ecmKeep = 1;
  let quiet = 1;
  let hold = def.hold;
  let fuelMul = 1;
  let entrench = 1;
  let regen = 0;
  for (const id of loadout) {
    const md = MODULES[id]?.mods;
    if (!md) continue;
    if (md.hp) hpMul *= md.hp;
    if (md.speed) spdMul *= md.speed;
    if (md.radar) radarMul *= md.radar;
    if (md.radarAir) radarAir += md.radarAir;
    if (md.radarSurf) radarSurf += md.radarSurf;
    if (md.sonar) sonar += md.sonar;
    if (md.sonarMul) sonarMul *= md.sonarMul;
    if (md.ecm) ecmKeep *= 1 - md.ecm;
    if (md.quiet) quiet *= md.quiet;
    if (md.hold) hold += md.hold;
    if (md.fuel) fuelMul *= md.fuel;
    if (md.entrench) entrench *= md.entrench;
    if (md.regen) regen += md.regen;
  }
  return {
    hp: Math.round(def.hp * fac.hp * hpMul),
    speed: def.speed * spdMul,
    radarAir: radarAir * radarMul * fac.sensor,
    radarSurf: radarSurf * radarMul * fac.sensor,
    sonar: sonar * sonarMul * fac.sensor,
    ecm: 1 - ecmKeep,
    quiet,
    hold,
    fuel: (def.fuel ?? 0) * fuelMul,
    entrench,
    regen,
  };
}
