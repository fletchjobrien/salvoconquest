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
  | 'corvette'
  | 'frigate'
  | 'cruiser'
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
  'corvette',
  'frigate',
  'cruiser',
];
export const BUILDABLE: Record<'naval' | 'ground' | 'air', UnitType[]> = {
  naval: ['corvette', 'frigate', 'destroyer', 'sub', 'cruiser', 'carrier', 'battleship'],
  ground: ['infantry', 'coastal', 'sam'],
  air: ['fighter', 'strike', 'recon'],
};

/** atgm: infantry anti-tank missiles (low, slow, terrain-hugging; not intercepted or decoyed by chaff). */
export type ProjKind = 'shell' | 'missile' | 'sam' | 'torpedo' | 'bomb' | 'bullet' | 'mine' | 'atgm';

export interface ModuleDef {
  id: string;
  /** Only this faction can fit it (absent: both). */
  faction?: Faction;
  /** Built into missile-battery buildings only; never fitted to units. */
  building?: boolean;
  name: string;
  short: string;
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
  /** Interceptors kill it this much less often (sea-skimming stealth, supersonic sprint): 1 = normal. */
  evade?: number;
  /** Heat-seeking (not radar-guided): aircraft dodge it more often (see AIR_DODGE). */
  ir?: boolean;
  /** Manually triggered ability instead of automatic fire. */
  ability?: 'mines' | 'buoys';
  /** Land mines (sappers): laid on land, hit ground units. */
  land?: boolean;
  /** Counter-SAM: intercepts enemy SAMs and air-to-air missiles in flight, not anti-ship missiles. */
  antiSam?: boolean;
  /** Drops a sonobuoy by itself every few km the ship sails (sub-hunter frigate). */
  autobuoy?: boolean;
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
  // Coalition (US-pattern) naval weapons.
  gun127: M({ id: 'gun127', faction: 'coalition', name: 'Mk 45 5-inch Gun', short: 'GUN', desc: 'Fast-firing gun. Good against boats, coast and landing craft.', proj: 'shell', range: 10, dmg: { sea: 7, land: 9 }, cooldown: 2, ammo: -1, speed: 2.4, accuracy: 0.55 }),
  gun406: M({ id: 'gun406', faction: 'coalition', name: '16-inch Triple Turret', short: 'MAIN', desc: 'Huge shells. Long range shore bombardment and ship killing. Never runs dry.', proj: 'shell', range: 17, dmg: { sea: 28, land: 30 }, cooldown: 5, ammo: -1, speed: 2.2, accuracy: 0.42 }),
  railgun: M({ id: 'railgun', faction: 'coalition', name: 'Railgun', short: 'RAIL', desc: 'Hypersonic slug. Very long range, slower to cycle.', proj: 'shell', range: 22, dmg: { sea: 32, land: 26 }, cooldown: 8, ammo: -1, speed: 5, accuracy: 0.5 }),
  vls_ashm: M({ id: 'vls_ashm', faction: 'coalition', name: 'Naval Strike Missile', short: 'NSM', desc: 'Stealthy sea-skimmer: 21 km, seen late, interceptors hit it 30% less often.', proj: 'missile', range: 21, dmg: { sea: 40 }, cooldown: 4, ammo: 4, speed: 0.85, accuracy: 0.9, seeker: 5, evade: 0.7 }),
  vls_sam: M({ id: 'vls_sam', faction: 'coalition', name: 'SM-6 Standard Missile', short: 'SM-6', desc: 'Long-reach SAM: aircraft and missiles out to 24 km.', proj: 'sam', range: 24, dmg: { air: 38, missile: 1 }, cooldown: 1.2, ammo: 5, speed: 1.7, accuracy: 0.75, intercept: 0.5 }),
  vls_lacm: M({ id: 'vls_lacm', faction: 'coalition', name: 'Tomahawk', short: 'TLAM', desc: 'Cruise missiles against ground forces from 45 km.', proj: 'missile', range: 45, dmg: { land: 40 }, cooldown: 5, ammo: 4, speed: 0.75, accuracy: 0.9, seeker: 4 }),
  vls_asroc: M({ id: 'vls_asroc', faction: 'coalition', name: 'VL-ASROC', short: 'ASW', desc: 'Rocket-thrown torpedoes out to 12 km. Outranges a submarine\'s torpedoes.', proj: 'torpedo', range: 12, dmg: { sub: 45 }, cooldown: 6, ammo: 8, speed: 0.9, accuracy: 0.85, seeker: 2.5 }),
  torp: M({ id: 'torp', faction: 'coalition', name: 'Mk 48 ADCAP Torpedo', short: 'TORP', desc: 'Fast, smart heavy torpedo: 10 km, wide seeker.', proj: 'torpedo', range: 10, dmg: { sea: 55, sub: 50 }, cooldown: 8, ammo: 8, speed: 0.46, accuracy: 0.87, seeker: 3 }),
  tube_ashm: M({ id: 'tube_ashm', faction: 'coalition', name: 'Sub Harpoon', short: 'ASM', desc: 'Anti-ship missiles fired from underwater. Reveals the sub.', proj: 'missile', range: 17, dmg: { sea: 38 }, cooldown: 6, ammo: 2, speed: 0.85, accuracy: 0.85, seeker: 5 }),
  // Union (PLAN-pattern) naval weapons.
  gun130: M({ id: 'gun130', faction: 'union', name: 'H/PJ-38 130mm Gun', short: 'GUN', desc: 'Heavy automatic gun: longer reach, slower to fire.', proj: 'shell', range: 12, dmg: { sea: 8, land: 10 }, cooldown: 2.4, ammo: -1, speed: 2.3, accuracy: 0.55 }),
  twin130: M({ id: 'twin130', faction: 'union', name: 'AK-130 Twin Mount', short: 'GUN', desc: 'Twin 130mm: fast, medium range. Never runs dry.', proj: 'shell', range: 13, dmg: { sea: 12, land: 14 }, cooldown: 2.4, ammo: -1, speed: 2.4, accuracy: 0.5 }),
  heavy_ashm: M({ id: 'heavy_ashm', faction: 'union', name: 'Heavy Anti-Ship Missiles', short: 'HASM', desc: 'Granit-class giants: 25 km, huge warhead, supersonic, hard to stop. 3 rounds.', proj: 'missile', range: 25, dmg: { sea: 55 }, cooldown: 7, ammo: 3, speed: 1.3, accuracy: 0.9, seeker: 5, evade: 0.7 }),
  yj18: M({ id: 'yj18', faction: 'union', name: 'YJ-18 Supersonic ASM', short: 'YJ18', desc: 'Supersonic terminal sprint: 22 km, interceptors hit it 25% less often.', proj: 'missile', range: 22, dmg: { sea: 44 }, cooldown: 4, ammo: 4, speed: 1.0, accuracy: 0.9, seeker: 5, evade: 0.75 }),
  hq9: M({ id: 'hq9', faction: 'union', name: 'HQ-9B SAM', short: 'HQ-9', desc: 'Area SAM out to 20 km with a larger magazine (6).', proj: 'sam', range: 20, dmg: { air: 38, missile: 1 }, cooldown: 1.2, ammo: 6, speed: 1.6, accuracy: 0.75, intercept: 0.38 }),
  cj10: M({ id: 'cj10', faction: 'union', name: 'CJ-10 Cruise Missile', short: 'LACM', desc: 'Cruise missiles against ground forces from 38 km.', proj: 'missile', range: 38, dmg: { land: 42 }, cooldown: 5, ammo: 4, speed: 0.75, accuracy: 0.9, seeker: 4 }),
  cy5: M({ id: 'cy5', faction: 'union', name: 'CY-5 ASW Missile', short: 'ASW', desc: 'Rocket-thrown torpedoes out to 11 km.', proj: 'torpedo', range: 11, dmg: { sub: 48 }, cooldown: 6, ammo: 8, speed: 0.9, accuracy: 0.85, seeker: 2.5 }),
  yu6: M({ id: 'yu6', faction: 'union', name: 'Yu-6 Heavy Torpedo', short: 'TORP', desc: 'Heavy torpedo: 9.5 km, bigger warhead, slower.', proj: 'torpedo', range: 9.5, dmg: { sea: 60, sub: 50 }, cooldown: 8, ammo: 8, speed: 0.4, accuracy: 0.85, seeker: 2.5 }),
  tube_yj18: M({ id: 'tube_yj18', faction: 'union', name: 'Sub YJ-18', short: 'ASM', desc: 'Supersonic anti-ship missiles from underwater: 18 km. Reveals the sub.', proj: 'missile', range: 18, dmg: { sea: 40 }, cooldown: 6, ammo: 2, speed: 1.1, accuracy: 0.85, seeker: 5, evade: 0.7 }),
  // Shared kit (both factions).
  gun76: M({ id: 'gun76', name: '76mm Rapid Gun', short: 'GUN', desc: 'Light rapid gun. Shorter range, can also shoot at aircraft.', proj: 'shell', range: 7, dmg: { sea: 4, land: 5, air: 4 }, cooldown: 0.8, ammo: -1, speed: 2.8, accuracy: 0.5 }),
  ciws: M({ id: 'ciws', name: 'CIWS', short: 'CIWS', desc: 'Last-ditch gun that shreds incoming missiles at close range.', proj: 'bullet', range: 2, dmg: { air: 6, missile: 1 }, cooldown: 0.6, ammo: -1, accuracy: 0.6, intercept: 0.15 }),
  mines1: M({ id: 'mines1', name: 'Mine Rails', short: 'MINE', desc: 'One load of hidden mines dropped behind the ship [M].', proj: 'mine', range: 0, dmg: { sea: 50, sub: 40 }, cooldown: 4, ammo: 1, ability: 'mines' }),
  mines3: M({ id: 'mines3', name: 'Mine Deck', short: 'MINE', desc: 'Three loads of hidden mines dropped behind the ship [M].', proj: 'mine', range: 0, dmg: { sea: 50, sub: 40 }, cooldown: 4, ammo: 3, ability: 'mines' }),
  sub_mines: M({ id: 'sub_mines', name: 'Tube-Laid Mines', short: 'MINE', desc: 'Two loads of mines laid from the torpedo tubes [M], quietly, deep in enemy waters.', proj: 'mine', range: 0, dmg: { sea: 50, sub: 40 }, cooldown: 6, ammo: 2, ability: 'mines' }),
  ecm: M({ id: 'ecm', name: 'Decoys + ECM', short: 'ECM', desc: 'Incoming missiles miss more often.', mods: { ecm: 0.35 } }),
  towed: M({ id: 'towed', name: 'Towed Sonar', short: 'SONAR', desc: 'Hear submarines much further away.', mods: { sonarMul: 1.4 } }),
  radar_ext: M({ id: 'radar_ext', name: 'Long Range Radar', short: 'RADAR', desc: 'Better radar range and accuracy.', mods: { radar: 1.25 } }),
  armor: M({ id: 'armor', name: 'Armour Belt', short: 'ARMR', desc: '+35% hull points, -10% speed.', mods: { hp: 1.35, speed: 0.9 } }),
  anechoic: M({ id: 'anechoic', name: 'Anechoic Tiles', short: 'QUIET', desc: 'Harder to hear on enemy sonar.', mods: { quiet: 0.6 } }),
  // New hulls' weapons.
  gun30: M({ id: 'gun30', name: '30mm Bushmaster', short: 'GUN', desc: 'Light autocannon for self-defence against boats, troops and drones.', proj: 'bullet', range: 3, dmg: { sea: 2, land: 4, air: 3 }, cooldown: 0.5, ammo: -1, accuracy: 0.5 }),
  gun57: M({ id: 'gun57', name: '57mm Rapid Gun', short: 'GUN', desc: 'Fast, accurate gun with programmable rounds: shreds troops and boats near the shore.', proj: 'shell', range: 8, dmg: { sea: 5, land: 9, air: 3 }, cooldown: 0.8, ammo: -1, speed: 2.6, accuracy: 0.6 }),
  nsm_light: M({ id: 'nsm_light', faction: 'coalition', name: 'NSM Quad Pack', short: 'NSM', desc: 'Four light anti-ship missiles: 16 km, stealthy. Swarm boats fire them together.', proj: 'missile', range: 16, dmg: { sea: 34 }, cooldown: 3, ammo: 4, speed: 0.85, accuracy: 0.88, seeker: 5, evade: 0.75 }),
  yj83: M({ id: 'yj83', faction: 'union', name: 'YJ-83 Quad Pack', short: 'YJ83', desc: 'Four light anti-ship missiles: 16 km, a sprint at the end.', proj: 'missile', range: 16, dmg: { sea: 36 }, cooldown: 3, ammo: 4, speed: 0.95, accuracy: 0.86, seeker: 5, evade: 0.85 }),
  essm: M({ id: 'essm', faction: 'coalition', name: 'ESSM Block II', short: 'ESSM', desc: 'Medium SAM, quad-packed: 14 km, good against missiles.', proj: 'sam', range: 14, dmg: { air: 32, missile: 1 }, cooldown: 1, ammo: 6, speed: 1.6, accuracy: 0.75, intercept: 0.45 }),
  hq16: M({ id: 'hq16', faction: 'union', name: 'HQ-16 SAM', short: 'HQ16', desc: 'Medium SAM: 15 km.', proj: 'sam', range: 15, dmg: { air: 32, missile: 1 }, cooldown: 1, ammo: 6, speed: 1.5, accuracy: 0.74, intercept: 0.4 }),
  lwt: M({ id: 'lwt', name: 'Lightweight Torpedo Tubes', short: 'LWT', desc: 'Short-range torpedoes for a sub that comes close: 4 km.', proj: 'torpedo', range: 4, dmg: { sub: 35, sea: 20 }, cooldown: 4, ammo: 6, speed: 0.5, accuracy: 0.8, seeker: 2 }),
  autobuoy: M({ id: 'autobuoy', name: 'Sonobuoy Launcher', short: 'BUOY', desc: 'Drops a sonobuoy every 4 km it sails, so its sonar picture trails behind it.', autobuoy: true }),
  railgun_u: M({ id: 'railgun_u', faction: 'union', name: 'Type-726 Railgun', short: 'RAIL', desc: 'Electromagnetic gun: long reach, slow to cycle.', proj: 'shell', range: 21, dmg: { sea: 34, land: 24 }, cooldown: 8, ammo: -1, speed: 4.8, accuracy: 0.5 }),
  apc_gun: M({ id: 'apc_gun', name: 'APC Autocannon', short: 'AC', desc: '30mm turret on a heavy APC: kills troops at 2.6 km.', proj: 'bullet', range: 2.6, dmg: { land: 9, sea: 3, air: 2 }, cooldown: 1, ammo: -1, accuracy: 0.55 }),
  landmine: M({ id: 'landmine', name: 'Landmines', short: 'MINE', desc: 'Lay one hidden minefield on land [M]. It wrecks the first enemy ground unit to cross it.', proj: 'mine', range: 0, dmg: { land: 35 }, cooldown: 4, ammo: 1, ability: 'mines', land: true }),
  aa_guns: M({ id: 'aa_guns', name: 'AA Guns', short: 'AAA', desc: 'Radar-laid guns: never run dry, but short range (3.5 km) and inaccurate.', proj: 'bullet', range: 3.5, dmg: { air: 7, missile: 1 }, cooldown: 0.5, ammo: -1, accuracy: 0.4, intercept: 0.1 }),
  radarpod_ext: M({ id: 'radarpod_ext', name: 'Extended Surveillance Radar', short: 'AEW+', desc: 'A bigger radar bubble: 46 km air, 38 km surface.', mods: { radarAir: 46, radarSurf: 38 } }),
  // ---- air ----
  agm: M({ id: 'agm', faction: 'coalition', name: 'Joint Strike Missile', short: 'JSM', desc: 'Stealthy stand-off missile vs ground units and ships: 12 km.', proj: 'missile', range: 12, dmg: { land: 26, sea: 24 }, cooldown: 2, ammo: 2, speed: 1.0, accuracy: 0.85, seeker: 3, evade: 0.8 }),
  kd88: M({ id: 'kd88', faction: 'union', name: 'KD-88 Missile', short: 'AGM', desc: 'Stand-off missile vs ground units and ships: 10 km, bigger warhead.', proj: 'missile', range: 10, dmg: { land: 30, sea: 26 }, cooldown: 2, ammo: 2, speed: 1.0, accuracy: 0.85, seeker: 3 }),
  bombs: M({ id: 'bombs', name: 'Guided Bombs', short: 'BOMB', desc: 'Heavy damage, must overfly the target.', proj: 'bomb', range: 2.5, dmg: { land: 38, sea: 34 }, cooldown: 1.5, ammo: 2, speed: 0.8, accuracy: 0.8 }),
  air_ashm: M({ id: 'air_ashm', faction: 'coalition', name: 'LRASM', short: 'ASM', desc: 'One stealthy heavy missile that kills ships from 21 km.', proj: 'missile', range: 21, dmg: { sea: 55 }, cooldown: 2, ammo: 1, speed: 0.9, accuracy: 0.9, seeker: 5, evade: 0.8 }),
  yj83k: M({ id: 'yj83k', faction: 'union', name: 'YJ-83K', short: 'ASM', desc: 'Two air-launched anti-ship missiles, 17 km.', proj: 'missile', range: 17, dmg: { sea: 40 }, cooldown: 2, ammo: 2, speed: 1.0, accuracy: 0.88, seeker: 5 }),
  air_torp: M({ id: 'air_torp', name: 'ASW Torpedo', short: 'TORP', desc: 'Drop torpedoes on submarine contacts.', proj: 'torpedo', range: 4, dmg: { sub: 45, sea: 25 }, cooldown: 2, ammo: 2, speed: 0.5, accuracy: 0.8, seeker: 2.5 }),
  aam_long: M({ id: 'aam_long', faction: 'coalition', name: 'AIM-120D AMRAAM', short: 'AAM', desc: 'Beyond-visual-range missiles with an active seeker: 16 km, accurate.', proj: 'sam', range: 16, dmg: { air: 40 }, cooldown: 2, ammo: 2, speed: 1.8, accuracy: 0.8, seeker: 2.5 }),
  pl15: M({ id: 'pl15', faction: 'union', name: 'PL-15', short: 'AAM', desc: 'Very long-range air-to-air missiles with an active seeker: 20 km, less accurate.', proj: 'sam', range: 20, dmg: { air: 40 }, cooldown: 2, ammo: 2, speed: 2.0, accuracy: 0.62, seeker: 2.5 }),
  aam_short: M({ id: 'aam_short', name: 'Dogfight AAM', short: 'SRM', desc: 'Agile short-range heat-seekers. Jets dodge them more often than radar missiles.', proj: 'sam', range: 5, dmg: { air: 32 }, cooldown: 1.5, ammo: 2, speed: 2, accuracy: 0.8, ir: true }),
  gunpod: M({ id: 'gunpod', name: 'Cannon', short: 'GUN', desc: 'Close range gun. Never runs dry.', proj: 'bullet', range: 1.6, dmg: { air: 6, land: 3, sea: 2 }, cooldown: 0.8, ammo: -1, accuracy: 0.5 }),
  droptank: M({ id: 'droptank', name: 'Drop Tank', short: 'FUEL', desc: '+60% time on station.', mods: { fuel: 1.6 } }),
  radarpod: M({ id: 'radarpod', name: 'Surveillance Radar', short: 'AEW', desc: 'Huge radar bubble with good accuracy.', mods: { radarAir: 34, radarSurf: 28 } }),
  sonobuoy: M({ id: 'sonobuoy', name: 'Sonobuoys', short: 'BUOY', desc: 'Drop listening buoys into the sea [M]. Each one hears submarines within 6 km, and ships further, for 150 s. 8 buoys.', proj: 'mine', range: 0, cooldown: 1.5, ammo: 8, ability: 'buoys' }),
  // ---- ground ----
  rifles: M({ id: 'rifles', name: 'Rifles + MG', short: 'MG', desc: 'Infantry small arms. Holds ground.', proj: 'bullet', range: 2.2, dmg: { land: 5 }, cooldown: 1, ammo: -1, accuracy: 0.6 }),
  atgm: M({ id: 'atgm', faction: 'coalition', name: 'Javelin Teams', short: 'ATGM', desc: 'Top-attack anti-tank missiles. Also hit boats near the beach.', proj: 'atgm', range: 3, dmg: { land: 18, sea: 8 }, cooldown: 6, ammo: -1, speed: 0.3, accuracy: 0.85, seeker: 0.8 }),
  hj12: M({ id: 'hj12', faction: 'union', name: 'HJ-12 Teams', short: 'ATGM', desc: 'Anti-tank missiles with a little more reach. Also hit boats near the beach.', proj: 'atgm', range: 3.4, dmg: { land: 16, sea: 9 }, cooldown: 6, ammo: -1, speed: 0.32, accuracy: 0.8, seeker: 0.8 }),
  mortar: M({ id: 'mortar', name: 'Mortars', short: 'MORT', desc: 'Indirect fire. Longer range than rifles.', proj: 'shell', range: 4, dmg: { land: 7 }, cooldown: 3, ammo: -1, speed: 0.6, accuracy: 0.45 }),
  manpads: M({ id: 'manpads', name: 'MANPADS', short: 'AA', desc: 'Shoulder-fired heat-seekers against low aircraft. Jets dodge them more often than radar missiles.', proj: 'sam', range: 4, dmg: { air: 22 }, cooldown: 4, ammo: 4, regen: 0.05, speed: 1.4, accuracy: 0.6, ir: true }),
  coastal_ashm: M({ id: 'coastal_ashm', building: true, name: 'Coastal Anti-Ship Missiles', short: 'ASM', desc: 'Truck-launched missiles against ships.', proj: 'missile', range: 18, dmg: { sea: 40 }, cooldown: 10, ammo: 4, regen: 0.04, speed: 0.85, accuracy: 0.9, seeker: 5 }),
  nsm_coastal: M({ id: 'nsm_coastal', faction: 'coalition', name: 'NMESIS (NSM)', short: 'NSM', desc: 'Stealthy truck-launched anti-ship missiles: 20 km.', proj: 'missile', range: 20, dmg: { sea: 40 }, cooldown: 10, ammo: 4, regen: 0.04, speed: 0.85, accuracy: 0.9, seeker: 5, evade: 0.8 }),
  yj12c: M({ id: 'yj12c', faction: 'union', name: 'YJ-12 Coastal', short: 'YJ12', desc: 'Supersonic heavy anti-ship missiles: 22 km, bigger warhead, slower to reload.', proj: 'missile', range: 22, dmg: { sea: 48 }, cooldown: 12, ammo: 4, regen: 0.035, speed: 1.2, accuracy: 0.9, seeker: 5, evade: 0.7 }),
  ground_sam: M({ id: 'ground_sam', building: true, name: 'SAM Launchers', short: 'SAM', desc: 'Medium range air defence. Also intercepts missiles.', proj: 'sam', range: 16, dmg: { air: 36, missile: 1 }, cooldown: 3.2, ammo: 8, regen: 0.08, speed: 1.6, accuracy: 0.72, intercept: 0.4 }),
  patriot: M({ id: 'patriot', faction: 'coalition', name: 'Patriot PAC-3', short: 'PAC3', desc: 'Hit-to-kill SAM: 16 km, best against missiles.', proj: 'sam', range: 16, dmg: { air: 36, missile: 1 }, cooldown: 3.2, ammo: 8, regen: 0.08, speed: 1.7, accuracy: 0.75, intercept: 0.48 }),
  hq9g: M({ id: 'hq9g', faction: 'union', name: 'HQ-9 Launchers', short: 'HQ-9', desc: 'Long-reach SAM: 20 km, slightly less effective against missiles.', proj: 'sam', range: 20, dmg: { air: 38, missile: 1 }, cooldown: 3.2, ammo: 8, regen: 0.08, speed: 1.6, accuracy: 0.72, intercept: 0.4 }),
  ground_ciws: M({ id: 'ground_ciws', name: 'SPAAG', short: 'AAA', desc: 'Radar guns vs aircraft and missiles at short range.', proj: 'bullet', range: 2.5, dmg: { air: 6, missile: 1 }, cooldown: 0.7, ammo: -1, accuracy: 0.55, intercept: 0.13 }),
  radartruck: M({ id: 'radartruck', name: 'Radar Truck', short: 'RDR', desc: 'Own radar. Fire without help from the fleet.', mods: { radarAir: 20, radarSurf: 16 } }),
  entrench: M({ id: 'entrench', name: 'Engineers', short: 'ENG', desc: '-30% damage taken while holding position.', mods: { entrench: 0.7 } }),
  medics: M({ id: 'medics', name: 'Field Medics', short: 'MED', desc: 'Slowly heals in the field.', mods: { regen: 0.6 } }),
};

/** A variant of a weapon with other numbers (shorter reach and more rounds, and so on). */
function derive(base: string, id: string, name: string, desc: string, ch: Partial<ModuleDef>) {
  MODULES[id] = { ...MODULES[base], id, name, desc, ...ch };
}
for (const b of ['torp', 'yu6']) derive(b, b + '_h', MODULES[b].name + ' (half load)', 'Half the torpedoes: the tubes are shared with missiles.', { ammo: 4 });
for (const [b, f] of [['nsm_coastal', 'NMESIS'], ['yj12c', 'YJ-12']] as const) {
  const m = MODULES[b];
  derive(b, b + '_s', `${f} (short)`, 'Short-range launchers with twice the missiles: 14 km.', { range: 14, ammo: 8, cooldown: (m.cooldown ?? 10) * 0.6 });
  derive(b, b + '_l', `${f} (long)`, 'Long-range missiles, few of them: 27 km, 2 rounds.', { range: 27, ammo: 2 });
}
for (const [b, f] of [['patriot', 'Patriot'], ['hq9g', 'HQ-9']] as const) {
  const m = MODULES[b];
  derive(b, b + '_m', `${f} (point defence)`, 'Missile defence: 10 km, half again as many rounds, kills incoming missiles more often.', { range: 10, ammo: 12, intercept: (m.intercept ?? 0.4) + 0.15, cooldown: 2 });
  derive(b, b + '_l', `${f} (long range)`, 'Area air defence: reaches 25% further, fewer rounds.', { range: (m.range ?? 16) * 1.25, ammo: 5 });
}
for (const [b, f] of [['aam_long', 'AMRAAM'], ['pl15', 'PL-15']] as const) {
  const m = MODULES[b];
  derive(b, b + '_m', `${f} (interceptor)`, 'Medium-range missiles that also shoot down anti-ship missiles: 9 km, 4 rounds.', { range: 9, ammo: 4, dmg: { air: 36, missile: 1 }, intercept: 0.35 });
  derive(b, b + '_l', `${f} (long range)`, 'Fewer, longer-reaching, more accurate missiles.', { range: (m.range ?? 16) * 1.25, ammo: 1, accuracy: (m.accuracy ?? 0.7) + 0.1 });
  derive(b, b + '_x', `${f} (counter-SAM)`, 'Shoots down enemy SAMs and air-to-air missiles in flight: 10 km, 6 rounds. Still fights aircraft.', { range: 10, ammo: 6, cooldown: 1, speed: 2.8, dmg: { air: 30 }, intercept: 0.7, antiSam: true });
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
  /** Hull noise on sonar (submarines; 1 = normal, smaller = quieter). */
  quiet?: number;
  hold: number;
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
  destroyer: U({ type: 'destroyer', category: 'naval', domain: 'sea', names: { coalition: 'Arleigh-class Destroyer', union: 'Type-55 Destroyer' }, short: 'DDG', cost: 400, buildTime: 20, hp: 100, speed: 0.34, turn: 0.35, radarAir: 22, radarSurf: 15, sonar: 0, visual: 6, signature: 1, hold: 0, role: 'Main fighter: the most firepower for the price. No sonar: it needs frigates against subs. Loses to battleships.', size: 0.16 }),
  sub: U({ type: 'sub', category: 'naval', domain: 'sub', names: { coalition: 'Virginia-class SSN', union: 'Type-95 SSN' }, short: 'SSN', cost: 200, buildTime: 22, hp: 70, speed: 0.26, turn: 0.3, radarAir: 0, radarSurf: 0, sonar: 10, visual: 4, signature: 0, hold: 0, role: 'Assassin: slow but hard to find. Hears ships far away; torpedoes break big hulls. Beats capital ships, loses to frigates.', size: 0.11 }),
  battleship: U({ type: 'battleship', category: 'naval', domain: 'sea', names: { coalition: 'Iowa-II Battleship', union: 'Type-70 Gun Battleship' }, short: 'BB', cost: 900, buildTime: 42, hp: 230, speed: 0.25, turn: 0.22, radarAir: 20, radarSurf: 16, sonar: 2, visual: 6, signature: 1.6, hold: 0, role: 'Tank with guns: railguns and a thick hull to soak up hits up close. BOMBARD [B] shells an area. Nearly deaf to subs.', size: 0.26 }),
  carrier: U({ type: 'carrier', category: 'naval', domain: 'sea', names: { coalition: 'Ford-class Carrier', union: 'Type-04 Carrier' }, short: 'CV', cost: 900, buildTime: 48, hp: 200, speed: 0.27, turn: 0.2, radarAir: 28, radarSurf: 16, sonar: 2, visual: 6, signature: 2, hold: 0, airbase: true, deck: 4, role: 'Mobile airbase. Up to 4 air flights refuel and rearm on its deck. Nearly deaf to subs: escort it.', size: 0.3 }),
  infantry: U({ type: 'infantry', category: 'ground', domain: 'land', names: { coalition: 'Marine Rifle Company', union: 'Naval Infantry Company' }, short: 'INF', cost: 50, buildTime: 10, hp: 60, speed: 0.1, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 5, signature: 0.5, hold: 0, role: 'Takes and holds islands. Kills other ground units.', size: 0.05 }),
  coastal: U({ type: 'coastal', category: 'ground', domain: 'land', names: { coalition: 'NSM Coastal Battery', union: 'YJ Coastal Battery' }, short: 'CDB', cost: 100, buildTime: 12, hp: 40, speed: 0.085, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 4, signature: 0.6, hold: 0, role: 'Anti-ship missiles. Turns an island into a fortress.', size: 0.05 }),
  sam: U({ type: 'sam', category: 'ground', domain: 'land', names: { coalition: 'Patriot Battery', union: 'HQ-9 Battery' }, short: 'SAM', cost: 100, buildTime: 12, hp: 40, speed: 0.085, turn: 3, radarAir: 0, radarSurf: 0, sonar: 0, visual: 4, signature: 0.6, hold: 0, role: 'Air umbrella. Kills planes and missiles.', size: 0.05 }),
  strike: U({ type: 'strike', category: 'air', domain: 'air', names: { coalition: 'F-35 Strike Flight', union: 'J-15 Strike Flight' }, short: 'ATK', cost: 150, buildTime: 15, hp: 30, speed: 0.9, turn: 1.4, radarAir: 9, radarSurf: 10, sonar: 0, visual: 6, signature: 0.5, hold: 0, fuel: 110, role: 'Hits ships and ground units, then returns to rearm.', size: 0.02 }),
  fighter: U({ type: 'fighter', category: 'air', domain: 'air', names: { coalition: 'F-22 Fighter Flight', union: 'J-20 Fighter Flight' }, short: 'FTR', cost: 100, buildTime: 14, hp: 30, speed: 1.15, turn: 1.8, radarAir: 18, radarSurf: 6, sonar: 0, visual: 6, signature: 0.4, hold: 0, fuel: 120, role: 'Owns the sky. Patrols and intercepts aircraft.', size: 0.02 }),
  recon: U({ type: 'recon', category: 'air', domain: 'air', names: { coalition: 'E-2 Hawkeye AEW', union: 'KJ-600 AEW' }, short: 'AEW', cost: 150, buildTime: 15, hp: 25, speed: 0.7, turn: 1.0, radarAir: 8, radarSurf: 8, sonar: 0, visual: 6, signature: 1, hold: 0, fuel: 180, role: 'Flying radar. Sharpens every contact around it.', size: 0.025 }),
  corvette: U({ type: 'corvette', category: 'naval', domain: 'sea', names: { coalition: 'Freedom-class Corvette', union: 'Type-056 Corvette' }, short: 'FS', cost: 100, buildTime: 14, hp: 60, speed: 0.4, turn: 0.5, radarAir: 14, radarSurf: 12, sonar: 0, visual: 5, signature: 0.7, hold: 2, role: 'Small, fast and cheap. The only ships that carry troops. Good in swarms.', size: 0.09 }),
  frigate: U({ type: 'frigate', category: 'naval', domain: 'sea', names: { coalition: 'Constellation-class Frigate', union: 'Type-054B Frigate' }, short: 'FF', cost: 200, buildTime: 18, hp: 80, speed: 0.34, turn: 0.4, radarAir: 18, radarSurf: 14, sonar: 12, visual: 6, signature: 0.85, hold: 0, role: 'Sub hunter: the only surface ship with hull sonar. Lays mines. Beats subs.', size: 0.13 }),
  cruiser: U({ type: 'cruiser', category: 'naval', domain: 'sea', names: { coalition: 'Ticonderoga-II Missile Cruiser', union: 'Type-60 Strike Cruiser' }, short: 'CG', cost: 900, buildTime: 44, hp: 210, speed: 0.27, turn: 0.24, radarAir: 26, radarSurf: 18, sonar: 2, visual: 6, signature: 1.5, hold: 0, role: 'Super destroyer: huge magazines for long fights. SALVO [B] empties its missiles fast.', size: 0.22 }),
  merchant: U({ type: 'merchant', category: 'support', domain: 'sea', names: { coalition: 'Merchant Marine', union: 'Merchant Marine' }, short: 'MM', cost: 0, buildTime: 0, hp: 30, speed: 0.36, turn: 0.4, radarAir: 0, radarSurf: 6, sonar: 0, visual: 4, signature: 1, hold: 0, role: 'Hauls resources home. Protect it.', size: 0.09 }),
  lander: U({ type: 'lander', category: 'support', domain: 'sea', names: { coalition: 'Landing Craft', union: 'Landing Craft' }, short: 'LC', cost: 0, buildTime: 0, hp: 14, speed: 0.32, turn: 2, radarAir: 0, radarSurf: 0, sonar: 0, visual: 3, signature: 0.3, hold: 0, role: 'Ferries troops between ships and beaches.', size: 0.03 }),
};

/**
 * Faction hulls. UNITS holds the shared base; these override it per faction. The two sides pay the
 * same price for each unit, but their hulls and weapons differ (faction weapons in MODULES carry a faction):
 *   Coalition (US pattern): stealthier, better sensors, longer-reach SAMs, guns on the battleship.
 *   Union (PLAN / Russian pattern): tougher hulls, longer-range supersonic missiles, missiles on the battleship.
 */
export const HULLS: Record<Faction, Partial<Record<UnitType, Partial<UnitDef>>>> = {
  coalition: {
    corvette: { hp: 58, speed: 0.42, signature: 0.6 },
    frigate: { hp: 78, radarAir: 20, sonar: 13, signature: 0.75 },
    destroyer: { hp: 100, speed: 0.34, radarAir: 24, radarSurf: 15, signature: 1 },
    cruiser: { hp: 205, radarAir: 30, radarSurf: 18, signature: 1.4 },
    sub: { hp: 70, speed: 0.26, sonar: 12, quiet: 0.8 },
    battleship: { hp: 265, speed: 0.25, turn: 0.22, radarAir: 20, radarSurf: 17, signature: 1.6 },
    carrier: { hp: 210, speed: 0.27, deck: 5, radarAir: 28, signature: 2 },
    infantry: { hp: 60, speed: 0.11 },
    fighter: { hp: 30, speed: 1.15, radarAir: 20, signature: 0.3 },
    strike: { hp: 30, speed: 0.9, signature: 0.35 },
  },
  union: {
    corvette: { hp: 66, speed: 0.39, turn: 0.46, signature: 0.75 },
    frigate: { hp: 86, speed: 0.33, sonar: 12, signature: 0.9 },
    destroyer: { hp: 102, speed: 0.33, turn: 0.32, radarAir: 22, radarSurf: 16, signature: 1.15 },
    cruiser: { hp: 225, speed: 0.28, radarAir: 26, radarSurf: 19, signature: 1.7 },
    sub: { hp: 75, speed: 0.28, sonar: 10, quiet: 1 },
    battleship: { hp: 240, speed: 0.27, turn: 0.24, radarAir: 22, radarSurf: 17, signature: 1.7 },
    carrier: { hp: 200, speed: 0.26, deck: 4, radarAir: 32, radarSurf: 17, signature: 2 },
    infantry: { hp: 70, speed: 0.095 },
    coastal: { hp: 45 },
    sam: { hp: 45 },
    fighter: { hp: 30, speed: 1.1, radarAir: 20, signature: 0.4 },
    strike: { hp: 36, speed: 0.85, fuel: 100, signature: 0.7 },
  },
};

// ---------------------------------------------------------------- fleet composition
//
// Before a match each player picks one of three variants for every class (the "fleet comp").
// A variant fixes the weapons and kit and may change hull numbers. The capital class is a choice
// between three different ships: missile cruiser, carrier or battleship.

/** Each faction's own weapon for a role; loadouts write '@role' (or '@role_suffix' for a derived one). */
const WK: Record<Faction, Record<string, string>> = {
  coalition: { gun: 'gun127', asm: 'vls_ashm', sam: 'vls_sam', asw: 'vls_asroc', torp: 'torp', subasm: 'tube_ashm', lacm: 'vls_lacm', heavy: 'railgun', heavyasm: 'vls_ashm', casm: 'nsm_light', fsam: 'essm', cdb: 'nsm_coastal', gsam: 'patriot', atgm: 'atgm', aam: 'aam_long', agm: 'agm', airasm: 'air_ashm', airasm2: 'air_ashm' },
  union: { gun: 'gun130', asm: 'yj18', sam: 'hq9', asw: 'cy5', torp: 'yu6', subasm: 'tube_yj18', lacm: 'cj10', heavy: 'railgun_u', heavyasm: 'heavy_ashm', casm: 'yj83', fsam: 'hq16', cdb: 'yj12c', gsam: 'hq9g', atgm: 'hj12', aam: 'pl15', agm: 'kd88', airasm: 'yj83k', airasm2: 'kd88' },
};

export type ClassId = 'corvette' | 'frigate' | 'destroyer' | 'sub' | 'capital' | 'infantry' | 'coastal' | 'sam' | 'fighter' | 'strike' | 'recon';
export const CLASS_IDS: ClassId[] = ['corvette', 'frigate', 'destroyer', 'sub', 'capital', 'infantry', 'coastal', 'sam', 'fighter', 'strike', 'recon'];

export interface VariantDef {
  name: string;
  /** One line for the fleet builder. */
  desc: string;
  type: UnitType;
  /** Modules: ids, or '@role' for this faction's weapon in that role. */
  lo: string[];
  /** Hull changes: multipliers, and a troop hold that replaces the hull's. */
  mul?: { hp?: number; speed?: number; quiet?: number; fuel?: number };
  hold?: number;
  /** Countermeasure other than the hull's (the troop transport lays smoke). */
  counter?: CounterKind;
  /** Hotkey B ability. */
  special?: 'salvo' | 'bombard';
  /** Infantry that comes ashore in armoured landing craft. */
  heavyLander?: boolean;
}

export interface ClassDef {
  name: string;
  cat: 'naval' | 'ground' | 'air';
  role: string;
  variants: [VariantDef, VariantDef, VariantDef];
  /** Variant picked until the player chooses. */
  def: number;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  corvette: {
    name: 'Corvette',
    cat: 'naval',
    role: 'Carries troops. Good in swarms.',
    def: 0,
    variants: [
      { name: 'Troop Transport', desc: '4 troop slots instead of 2. Lays a smoke screen [C] to cover the landing. Almost unarmed.', type: 'corvette', lo: ['gun30'], hold: 4, counter: 'smoke' },
      { name: 'Littoral Combat Ship', desc: 'Two guns that shred troops and boats near the shore: supports landings, clears small islands. 2 troop slots.', type: 'corvette', lo: ['gun57', 'gun76', 'ciws'], hold: 2 },
      { name: 'Swarm', desc: 'Two anti-ship missile packs for massed attacks. Only 1 troop slot.', type: 'corvette', lo: ['@casm', '@casm', 'gun30'], hold: 1 },
    ],
  },
  frigate: {
    name: 'Frigate',
    cat: 'naval',
    role: 'Hunts submarines, lays mines.',
    def: 0,
    variants: [
      { name: 'Sub Hunter', desc: 'Towed sonar, two ASW rocket launchers and torpedo tubes. Drops a sonobuoy every 4 km as it sails.', type: 'frigate', lo: ['gun76', '@asw', '@asw', 'lwt', 'towed', 'autobuoy', 'mines1', 'ciws'] },
      { name: 'Mine Layer', desc: 'Three loads of mines [M] instead of one. ASW rockets.', type: 'frigate', lo: ['gun76', '@asw', 'mines3', 'ciws'] },
      { name: 'Air Defence', desc: 'Two extra SAM launchers to cover the fleet. ASW rockets, one load of mines.', type: 'frigate', lo: ['gun76', '@asw', '@fsam', '@fsam', 'mines1', 'ciws'] },
    ],
  },
  destroyer: {
    name: 'Destroyer',
    cat: 'naval',
    role: 'Main fighter: damage per second.',
    def: 0,
    variants: [
      { name: 'Missiles', desc: 'Two anti-ship missile launchers.', type: 'destroyer', lo: ['@gun', '@asm', '@asm', '@sam', 'ciws'] },
      { name: 'Air Defence', desc: 'Two long-range SAM launchers: an umbrella against aircraft and missiles.', type: 'destroyer', lo: ['@gun', '@asm', '@sam', '@sam', 'ciws'] },
      { name: 'Guns', desc: 'Two main guns: never run dry, good against ships and the shore.', type: 'destroyer', lo: ['@gun', '@gun', '@asm', '@sam', 'ciws'] },
    ],
  },
  sub: {
    name: 'Submarine',
    cat: 'naval',
    role: 'Assassin: slow but hard to see.',
    def: 0,
    variants: [
      { name: 'Stealth', desc: 'Anechoic tiles and a quieter plant: 15% slower, much harder to hear.', type: 'sub', lo: ['@torp', '@subasm', 'anechoic'], mul: { speed: 0.85, quiet: 0.75 } },
      { name: 'Mines', desc: 'Lays two loads of mines [M] from its tubes, deep in enemy waters.', type: 'sub', lo: ['@torp', '@subasm', 'sub_mines'] },
      { name: 'Long Range', desc: 'Swaps half its torpedoes for a second load of anti-ship missiles.', type: 'sub', lo: ['@torp_h', '@subasm', '@subasm'] },
    ],
  },
  capital: {
    name: 'Capital Ship',
    cat: 'naval',
    role: 'Powerful ships. Pick one kind per match.',
    def: 2,
    variants: [
      { name: 'Missile Cruiser', desc: 'Super destroyer with huge magazines. SALVO [B]: fires every anti-ship missile and SAM in quick succession until empty.', type: 'cruiser', lo: ['@gun', '@heavyasm', '@asm', '@asm', '@sam', '@sam', '@sam', '@lacm', 'ciws', 'ciws'], special: 'salvo' },
      { name: 'Carrier', desc: 'Mobile airbase: aircraft based on it are stowed, refuel and rearm aboard, and launch with [L].', type: 'carrier', lo: ['@sam', 'ciws', 'radar_ext', 'ecm'] },
      { name: 'Battleship', desc: 'Tank with railguns and an armour belt: soaks up hits for the fleet up close. BOMBARD [B]: sustained gunfire on an area, even where no enemy is seen.', type: 'battleship', lo: ['@heavy', '@heavy', '@gun', '@sam', 'ciws', 'ciws', 'armor'], special: 'bombard' },
    ],
  },
  infantry: {
    name: 'Infantry',
    cat: 'ground',
    role: 'Takes and holds islands.',
    def: 0,
    variants: [
      { name: 'Heavy Landing Craft', desc: 'Comes ashore in armoured landing craft that take three times the damage.', type: 'infantry', lo: ['rifles', '@atgm', 'manpads'], heavyLander: true },
      { name: 'Heavy APCs', desc: 'Autocannon turrets and mortars: much better against enemy troops.', type: 'infantry', lo: ['apc_gun', 'mortar', '@atgm', 'manpads'], mul: { hp: 1.15, speed: 0.9 } },
      { name: 'Sappers', desc: 'Engineers who dig in (-30% damage while holding) and lay a minefield [M].', type: 'infantry', lo: ['rifles', '@atgm', 'manpads', 'landmine', 'entrench'] },
    ],
  },
  coastal: {
    name: 'Anti-Ship Battery',
    cat: 'ground',
    role: 'Turns an island into a fortress.',
    def: 2,
    variants: [
      { name: 'Short Range', desc: 'Twice the missiles, 14 km reach. Needs radar from the fleet, a radar station or an AEW.', type: 'coastal', lo: ['@cdb_s'] },
      { name: 'Long Range', desc: '27 km reach, only 2 missiles. Needs radar from the fleet, a radar station or an AEW.', type: 'coastal', lo: ['@cdb_l'] },
      { name: 'Radar Independent', desc: 'Brings its own surface radar truck: fires without help.', type: 'coastal', lo: ['@cdb', 'radartruck'] },
    ],
  },
  sam: {
    name: 'SAM Battery',
    cat: 'ground',
    role: 'Air and missile umbrella.',
    def: 1,
    variants: [
      { name: 'Missile Defence', desc: 'Shorter reach (10 km) but half again as many rounds, and better at killing incoming missiles.', type: 'sam', lo: ['@gsam_m', 'radartruck'] },
      { name: 'Anti-Air', desc: 'Reaches 25% further, fewer rounds.', type: 'sam', lo: ['@gsam_l', 'radartruck'] },
      { name: 'AA Guns', desc: 'Radar-laid guns: never run out, but 3.5 km reach and inaccurate.', type: 'sam', lo: ['aa_guns', 'radartruck'] },
    ],
  },
  fighter: {
    name: 'Fighter',
    cat: 'air',
    role: 'Owns the sky.',
    def: 1,
    variants: [
      { name: 'Anti-Missile', desc: 'Shorter-range missiles (9 km), twice as many; they also shoot down anti-ship missiles.', type: 'fighter', lo: ['@aam_m', 'aam_short', 'gunpod'] },
      { name: 'Anti-Air', desc: 'Long-range missiles that reach 25% further and hit more often, but fewer of them.', type: 'fighter', lo: ['@aam_l', 'aam_short', 'gunpod'] },
      { name: 'SAM Screen', desc: 'Counter-SAM missiles that shoot down enemy SAMs and air-to-air missiles in flight. Fly it with (or escort) your strike flights, or over a missile barrage, to get them through.', type: 'fighter', lo: ['@aam_x', 'aam_short', 'gunpod'] },
    ],
  },
  strike: {
    name: 'Attack Aircraft',
    cat: 'air',
    role: 'Hits ships, troops and subs.',
    def: 0,
    variants: [
      { name: 'Anti-Ship', desc: 'Heavy anti-ship missiles only.', type: 'strike', lo: ['@airasm', '@airasm2', 'ecm'] },
      { name: 'Anti-Ground', desc: 'Stand-off missiles and guided bombs against troops and batteries.', type: 'strike', lo: ['@agm', 'bombs', 'ecm'] },
      { name: 'Anti-Sub', desc: 'Two loads of ASW torpedoes for submarine contacts.', type: 'strike', lo: ['air_torp', 'air_torp', 'ecm'] },
    ],
  },
  recon: {
    name: 'AEW',
    cat: 'air',
    role: 'Flying radar.',
    def: 1,
    variants: [
      { name: 'Long Endurance', desc: 'Drop tanks: 60% more time on station.', type: 'recon', lo: ['radarpod', 'droptank'] },
      { name: 'Long Range', desc: 'A bigger radar: 46 km air, 38 km surface.', type: 'recon', lo: ['radarpod_ext'] },
      { name: 'Sonobuoys', desc: 'Drops listening buoys [M] that hear submarines.', type: 'recon', lo: ['radarpod', 'sonobuoy'] },
    ],
  },
};

/** The class a unit type is built under (null for merchants and landing craft). */
export function classOf(type: UnitType): ClassId | null {
  if (type === 'cruiser' || type === 'carrier' || type === 'battleship') return 'capital';
  return type in CLASSES ? (type as ClassId) : null;
}

/** A player's pick: variant index per class. */
export type Fleet = Partial<Record<ClassId, number>>;

export function sanitizeFleet(f: unknown): Record<ClassId, number> {
  const out = {} as Record<ClassId, number>;
  const raw = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
  for (const c of CLASS_IDS) {
    const v = Math.floor(Number(raw[c]));
    out[c] = v >= 0 && v <= 2 ? v : CLASSES[c].def;
  }
  return out;
}

/** The variant this fleet uses for a unit type, or null if it cannot build the type (another capital ship). */
export function variantIndex(fleet: Record<ClassId, number>, type: UnitType): number | null {
  const c = classOf(type);
  if (!c) return null;
  const i = fleet[c];
  return CLASSES[c].variants[i].type === type ? i : null;
}

export function variantDef(type: UnitType, index: number): VariantDef | null {
  const c = classOf(type);
  return c ? CLASSES[c].variants[index] ?? null : null;
}

/** The modules of a variant as this faction fits them. */
export function variantLoadout(v: VariantDef, faction: Faction): string[] {
  return v.lo.map((id) => {
    if (id[0] !== '@') return id;
    const key = id.slice(1);
    const cut = key.indexOf('_');
    const role = cut < 0 ? key : key.slice(0, cut);
    const suffix = cut < 0 ? '' : key.slice(cut);
    return (WK[faction][role] ?? role) + suffix;
  });
}

/** Unit types this fleet can build: the capital class only offers the chosen ship. */
export function fleetBuildable(fleet: Record<ClassId, number>, cat: 'naval' | 'ground' | 'air'): UnitType[] {
  return BUILDABLE[cat].filter((t) => variantIndex(fleet, t) !== null);
}

/** Fleets for computer players: a sensible pick with some variety from the match seed. */
export function botFleet(seed: number): Record<ClassId, number> {
  let s = (seed * 2654435761) >>> 0;
  const r = (n: number) => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 16) % n;
  };
  return {
    corvette: 0,
    frigate: r(3) === 0 ? 2 : 0,
    destroyer: r(3),
    sub: r(3),
    capital: r(2) === 0 ? 0 : 2,
    infantry: r(3),
    coastal: r(3),
    sam: r(2),
    fighter: r(3),
    strike: r(2),
    recon: r(3),
  };
}

const unitDefCache = new Map<string, UnitDef>();
/** A unit type as this faction builds it (shared base plus the faction's hull). */
export function unitDef(type: UnitType, faction: Faction): UnitDef {
  const k = faction + type;
  let d = unitDefCache.get(k);
  if (!d) {
    d = { ...UNITS[type], ...(HULLS[faction]?.[type] ?? {}) };
    unitDefCache.set(k, d);
  }
  return d;
}


/** Names only: the factions are equal in price and build time and differ in hulls and weapons. */
export const FACTION_MOD: Record<Faction, { cost: number; hp: number; build: number; sensor: number; dmg: number; name: string; tag: string }> = {
  coalition: { cost: 1, hp: 1, build: 1, sensor: 1, dmg: 1, name: 'Atlantic Coalition', tag: 'COALITION' },
  union: { cost: 1, hp: 1, build: 1, sensor: 1, dmg: 1, name: 'Pacific Union', tag: 'UNION' },
};

/**
 * Every unit costs three times its base price. Base prices follow fixed ratios of one point
 * ($150): corvette 2, frigate 4, destroyer 8, capital ship 18, submarine 4; fighter 2, attack 3,
 * AEW 3; infantry 1, anti-ship battery 2, SAM battery 2.
 */
export const COST_SCALE = 3;

/**
 * Countermeasures: one charge each, refilled when the unit rearms.
 * Chaff (warships, aircraft): a cloud of foil that pulls homing missiles off the unit.
 * Smoke (ground units): a screen that hides the units inside it and spoils the aim of shots already fired.
 */
/**
 * Chance that an aircraft out-turns a heat-seeking missile (flares and a hard break). Radar-guided
 * missiles are not dodged this way; ECM works against those.
 */
export const AIR_DODGE: Partial<Record<UnitType, number>> = { fighter: 0.4, strike: 0.3, recon: 0.15 };

export const COUNTER = {
  /** Chaff: chance to decoy each enemy missile homing on the unit (hypersonic ones less often). */
  chaffChance: 0.6,
  chaffHard: 0.4,
  /** Chaff works on missiles closer than this (km) while the cloud lasts (s). */
  chaffRange: 12,
  chaffLife: 8,
  /** Chaff only works while its unit is still this close (km) to the cloud. */
  chaffNear: 2.5,
  /** Smoke: radius (km), life (s), range inside which an enemy still sees through it, hit chance factor. */
  smokeR: 1.1,
  smokeLife: 25,
  smokeSee: 0.35,
  smokeHit: 0.45,
  /** After popping smoke, a ground unit keeps laying more behind it for this long (s) as it moves. */
  smokeTrail: 12,
};

/**
 * Emission control. A radar that is switched on can be heard by enemy electronic support measures (ESM)
 * further away than the radar itself can see: the signal only travels one way. ESM gives a rough,
 * unidentified position. Switched off, the unit sees only by eye and sonar, but cannot be heard.
 */
export const ESM = {
  /** ESM hears an emitter out to this multiple of the emitter's own radar range. */
  range: 1.5,
  /** Best contact quality from ESM alone (below the 0.4 needed to identify, so not targetable). */
  q: 0.38,
  /** Largest position error of an ESM-only contact (km). */
  err: 7,
};

/** Dropped sonobuoys: passive sonar range (km) and life (s). */
export const BUOY = { sonar: 6, life: 150 };

export type CounterKind = 'chaff' | 'smoke';

/** The countermeasure a unit carries: smoke for ground units (and the troop transport), chaff for the rest. */
export function counterOf(type: UnitType, variant?: VariantDef | null): CounterKind | null {
  if (variant?.counter) return variant.counter;
  const d = UNITS[type];
  if (d.domain === 'air') return 'chaff';
  if (d.domain === 'land') return 'smoke';
  if (d.domain === 'sea' && classOf(type)) return 'chaff';
  return null;
}

// Counter triangle: submarine > capital ships, battleship > destroyer, frigate > submarine.
/** Passive sonar range against surface ships, as a share of sonar range (a sub vs a ship's own hull sonar). */
export const PASSIVE_SUB = 1.3;
export const PASSIVE_SHIP = 0.5;
/** Torpedo effect on surface ships: big hulls break their keel; frigates tow torpedo decoys. */
export const TORPEDO_VS: Partial<Record<UnitType, { dmg?: number; hit?: number }>> = {
  battleship: { dmg: 1.6 },
  carrier: { dmg: 1.6 },
  cruiser: { dmg: 1.6 },
  frigate: { hit: 0.5 },
};
/** A fixed random markup per unit type (4-9%, drawn once) on top of the point ratios. */
export const PRICE_MARKUP: Partial<Record<UnitType, number>> = {
  corvette: 1.062,
  frigate: 1.042,
  destroyer: 1.051,
  sub: 1.081,
  cruiser: 1.044,
  carrier: 1.064,
  battleship: 1.063,
  infantry: 1.047,
  coastal: 1.06,
  sam: 1.082,
  fighter: 1.08,
  strike: 1.041,
  recon: 1.042,
};
export function unitCost(type: UnitType, faction: Faction): number {
  return Math.round((UNITS[type].cost * COST_SCALE * (PRICE_MARKUP[type] ?? 1) * FACTION_MOD[faction].cost) / 5) * 5;
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
  radar: { type: 'radar', name: 'Radar Station', short: 'RDR', desc: 'Long range radar coverage over a wide area.', radarAir: 24, radarSurf: 18, visual: 5, captureTime: 12, weapons: [] },
  dockyard: { type: 'dockyard', name: 'Dockyard', short: 'DOCK', desc: 'Forward port. Builds, repairs and rearms ships.', radarAir: 0, radarSurf: 10, visual: 5, produces: 'naval', captureTime: 15, weapons: [] },
  battery: { type: 'battery', name: 'Missile Battery', short: 'MSL', desc: 'Fires anti-ship and anti-air missiles for its owner.', radarAir: 20, radarSurf: 16, visual: 5, captureTime: 15, weapons: ['coastal_ashm', 'ground_sam'] },
  resource: { type: 'resource', name: 'Resource Site', short: 'RES', desc: 'Merchant ships haul its output home as cash.', radarAir: 0, radarSurf: 0, visual: 4, captureTime: 10, weapons: [] },
};

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

export const MAP_SIZE = 160; // km
export const TICK = 0.1; // s
export const HQ_INCOME = 1.5; // $/s
export const MERCHANT_SUNK_WAIT = 45; // s before a site sends a new merchant after one is sunk
/** Merchant cargo: a base sum plus so much per km of trip (longer trips pay more). */
export const MERCHANT_PAY = { base: 30, perKm: 6 };
/** Deployment budget: 32 points (see COST_SCALE); what you don't spend carries into battle. */
export const START_CASH = 4800;
/** Every unit moves this much faster than its listed speed (ships, subs, troops, aircraft; not weapons). */
export const MOVE_SPEED = 1.2;
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
  turn: number;
  signature: number;
  visual: number;
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

/** Final stats of a unit for a faction, loadout and variant. Used by the simulation and the fleet builder. */
export function deriveStats(type: UnitType, faction: Faction, loadout: string[], v?: VariantDef | null): DerivedStats {
  const def = unitDef(type, faction);
  const fac = FACTION_MOD[faction];
  let hpMul = 1;
  let spdMul = 1;
  let radarMul = 1;
  let radarAir = def.radarAir;
  let radarSurf = def.radarSurf;
  let sonar = def.sonar;
  let sonarMul = 1;
  let ecmKeep = 1;
  let quiet = (def.quiet ?? 1) * (v?.mul?.quiet ?? 1);
  let hold = v?.hold ?? def.hold;
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
  hpMul *= v?.mul?.hp ?? 1;
  spdMul *= v?.mul?.speed ?? 1;
  fuelMul *= v?.mul?.fuel ?? 1;
  return {
    hp: Math.round(def.hp * fac.hp * hpMul),
    speed: def.speed * spdMul * MOVE_SPEED,
    turn: def.turn,
    signature: def.signature,
    visual: def.visual,
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

/** Air flights a carrier of this faction can base. */
export function deckCap(faction: Faction, type: UnitType): number {
  return unitDef(type, faction).deck ?? 0;
}
