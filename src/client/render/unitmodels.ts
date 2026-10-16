// Per-faction unit models. Each navy, army and air arm is drawn after real equipment of its
// type, so the two sides read differently at a glance but stay believable:
//   Coalition: Arleigh Burke DDG, Virginia SSN, Iowa battleship, Ford carrier, ACV 8x8,
//              NMESIS anti-ship launcher, Patriot, F-22, F-35, E-2 Hawkeye.
//   Union:     Type 055 DDG, Type 09x SSN, Kirov-type strike cruiser, ski-jump carrier,
//              ZBD-05 amphibious IFV, YJ-12 coastal TEL, HQ-9, J-20, J-15, KJ-600.
// Axes: +x is the bow or nose, +y up; +z is starboard (the carrier island side is -z, as before).
import * as THREE from 'three';
import type { Faction } from '../../shared/defs';
import { FACTION_STYLE, Palette } from '../theme';
import { Part, box, boxR, cyl, ellipsoid, frustum, hullShape, mirrored, panel, prism, ramp, scaled, tube } from './parts';

const DARK = 0x2a2f33;
const GLASS = 0x1b2126;
const BLACK = 0x15181b;
const DECK_MARK = 0xd8d8c8;
const YELLOW = 0xd6b34a;

const Q = Math.PI / 4;

/** Where the spinning search radar sits on each ship (model units), and its antenna size. */
export interface RadarMount {
  at: [number, number, number];
  size: [number, number, number];
}

export const RADAR_MOUNT: Record<Faction, Partial<Record<string, RadarMount>>> = {
  coalition: {
    destroyer: { at: [0.045, 0.3, 0], size: [0.008, 0.016, 0.06] },
    battleship: { at: [0.075, 0.37, 0], size: [0.008, 0.02, 0.075] },
    carrier: { at: [-0.2, 0.235, -0.088], size: [0.006, 0.014, 0.05] },
  },
  union: {
    destroyer: { at: [0.055, 0.3, 0], size: [0.007, 0.014, 0.05] },
    battleship: { at: [0.06, 0.315, 0], size: [0.012, 0.04, 0.1] },
    carrier: { at: [0.03, 0.27, -0.09], size: [0.008, 0.02, 0.07] },
  },
};

interface Colors {
  H: number;
  D: number;
  S: number;
  T: number;
}

function colors(f: Faction): Colors {
  const st = FACTION_STYLE[f];
  return { H: st.hull, D: st.deck, S: st.superstructure, T: st.trim };
}

// ---------------------------------------------------------------- shared ship parts

function hull(P: Part[], c: Colors, outline: [number, number][], top: number) {
  P.push(prism(outline, -0.03, top, c.H));
  P.push(prism(scaled(outline, 0.985, 0.93), top, top + 0.005, c.D));
  P.push(prism(scaled(outline, 1, 1.03), -0.035, -0.005, c.T));
}

/** Naval gun mount: a sloped turret with one barrel (or two), facing +x or -x. */
function gunMount(P: Part[], x: number, y: number, col: number, size: number, aft = false, twin = false) {
  const s = aft ? -1 : 1;
  P.push(frustum(0.05 * size, 0.045 * size, 0.03 * size, 0.035 * size, 0.026 * size, x, y, 0, col));
  const zs = twin ? [-0.008 * size, 0.008 * size] : [0];
  for (const z of zs) P.push(tube(0.0035 * size, 0.07 * size, x + s * 0.05 * size, y + 0.014 * size, z, DARK, 0, aft ? Math.PI : 0, 4));
}

/** Flush vertical launch hatch block. */
function vls(P: Part[], x: number, len: number, wid: number, y: number) {
  P.push(box(len, 0.005, wid, x, y, 0, DARK));
  for (let i = 1; i < 4; i++) P.push(box(0.003, 0.0055, wid * 0.96, x - len / 2 + (len * i) / 4, y, 0, 0x3a4045));
}

function ciws(P: Part[], x: number, y: number, z: number) {
  P.push(cyl(0.012, 0.014, 0.012, x, y, z, 0x8b9399, 6));
  P.push(ellipsoid(0.011, 0.016, 0.011, x, y + 0.026, z, 0xe6e6df, 6));
}

// ---------------------------------------------------------------- destroyers

/** Arleigh Burke Flight IIA: flared hull, pyramid deckhouse with four octagonal SPY-1 faces,
 * raked tripod mast, two separate funnels, hangar and flight deck aft. */
function coalitionDestroyer(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.13, 0.1), 0.04);
  gunMount(P, 0.34, 0.045, c.S, 1);
  vls(P, 0.22, 0.08, 0.07, 0.045);
  // Forward deckhouse (sloped sides) and bridge.
  P.push(frustum(0.2, 0.115, 0.16, 0.09, 0.07, 0.06, 0.045, 0, c.S));
  P.push(frustum(0.1, 0.085, 0.075, 0.065, 0.05, 0.08, 0.115, 0, c.S));
  P.push(box(0.012, 0.012, 0.07, 0.12, 0.14, 0, GLASS));
  // SPY-1 arrays: two face forward-out, two face aft-out.
  for (const sz of [1, -1]) {
    P.push(panel(0.026, 0.125, 0.09, sz * 0.04, -sz * Q, DARK));
    P.push(panel(0.026, -0.005, 0.09, sz * 0.04, -sz * 3 * Q, DARK));
  }
  // Raked tripod mast with yardarm.
  P.push(boxR(0.008, 0.13, 0.008, 0.05, 0.225, 0, DARK, 0, 0, 0.18));
  P.push(boxR(0.006, 0.11, 0.006, 0.035, 0.215, 0.02, DARK, 0.25, 0, 0.18));
  P.push(boxR(0.006, 0.11, 0.006, 0.035, 0.215, -0.02, DARK, -0.25, 0, 0.18));
  P.push(box(0.008, 0.004, 0.08, 0.045, 0.255, 0, DARK));
  // Two funnels, each with a black cap.
  for (const x of [-0.05, -0.15]) {
    P.push(frustum(0.05, 0.06, 0.04, 0.05, 0.075, x, 0.045, 0, c.S));
    P.push(box(0.036, 0.008, 0.046, x, 0.12, 0, BLACK));
  }
  P.push(box(0.06, 0.04, 0.08, -0.1, 0.045, 0, c.S));
  vls(P, -0.235, 0.06, 0.07, 0.045);
  // Hangar, CIWS on top, flight deck.
  P.push(box(0.11, 0.06, 0.11, -0.32, 0.045, 0, c.S));
  ciws(P, -0.3, 0.105, 0);
  P.push(box(0.11, 0.002, 0.1, -0.43, 0.045, 0, 0x9aa3a8));
  P.push(box(0.05, 0.003, 0.004, -0.43, 0.046, 0, DECK_MARK));
}

/** Type 055: long enclosed hull, faceted gun, big forward VLS field, one tall integrated mast
 * carrying flat AESA faces, a single wide funnel, hangar aft. Lighter PLAN grey. */
function unionDestroyer(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.115, 0.04), 0.045);
  // Raised forecastle bulwark.
  P.push(prism([[0.42, 0], [0.3, -0.045], [0.26, -0.05], [0.26, 0.05], [0.3, 0.045]], 0.045, 0.055, c.H));
  gunMount(P, 0.33, 0.055, c.S, 1.05);
  vls(P, 0.2, 0.1, 0.075, 0.05);
  // Long smooth superstructure.
  P.push(frustum(0.22, 0.105, 0.2, 0.09, 0.065, 0.02, 0.05, 0, c.S));
  P.push(box(0.012, 0.01, 0.075, 0.11, 0.1, 0, GLASS));
  // Integrated mast: one tall tapered tower.
  P.push(frustum(0.1, 0.085, 0.045, 0.04, 0.15, 0.055, 0.115, 0, c.S));
  // Large S-band faces low on the tower, small X-band faces high up.
  P.push(boxR(0.004, 0.05, 0.05, 0.1, 0.15, 0, DARK, 0, 0, 0.14));
  P.push(boxR(0.004, 0.05, 0.05, 0.01, 0.15, 0, DARK, 0, 0, -0.14));
  for (const sz of [1, -1]) P.push(boxR(0.05, 0.05, 0.004, 0.055, 0.15, sz * 0.04, DARK, sz * 0.12));
  P.push(box(0.03, 0.02, 0.045, 0.055, 0.215, 0, DARK));
  P.push(cyl(0.004, 0.006, 0.04, 0.055, 0.265, 0, DARK, 4));
  // Single wide funnel.
  P.push(frustum(0.07, 0.07, 0.055, 0.055, 0.085, -0.1, 0.05, 0, c.S));
  P.push(box(0.05, 0.008, 0.05, -0.1, 0.135, 0, BLACK));
  vls(P, -0.19, 0.06, 0.07, 0.05);
  P.push(box(0.1, 0.06, 0.1, -0.29, 0.05, 0, c.S));
  ciws(P, -0.27, 0.11, 0);
  P.push(box(0.1, 0.002, 0.095, -0.41, 0.05, 0, 0x9aa3a8));
  P.push(cyl(0.02, 0.02, 0.002, -0.41, 0.051, 0, DECK_MARK, 10));
}

// ---------------------------------------------------------------- submarines

/** Virginia: smooth cylinder, sail well forward with no sail planes, cruciform tail, pump-jet shroud. */
function coalitionSub(P: Part[]) {
  const C = 0x1b1f22;
  P.push(tube(0.044, 0.74, 0.0, -0.01, 0, C, 0, 0, 10));
  P.push(ellipsoid(0.07, 0.044, 0.044, 0.37, -0.01, 0, C, 10));
  P.push(tube(0.016, 0.16, -0.45, -0.01, 0, C, 0, 0, 10, 0.044));
  // Sail with a rounded leading edge.
  P.push(box(0.09, 0.075, 0.022, 0.2, 0.02, 0, C));
  P.push(ellipsoid(0.02, 0.0375, 0.011, 0.245, 0.0575, 0, C, 6));
  P.push(box(0.006, 0.02, 0.004, 0.19, 0.095, 0, DARK));
  // Cruciform tail and the pump-jet shroud.
  P.push(box(0.05, 0.11, 0.004, -0.5, -0.065, 0, C));
  P.push(box(0.05, 0.004, 0.1, -0.5, -0.012, 0, C));
  P.push(tube(0.022, 0.04, -0.54, -0.01, 0, 0x22272b, 0, 0, 10));
}

/** Type 09x: wider hull, raised "hump" behind the sail, planes mounted on the sail,
 * X-form tail and an open seven-blade screw. Slightly blue-grey anechoic coat. */
function unionSub(P: Part[]) {
  const C = 0x252c33;
  P.push(tube(0.048, 0.7, 0.01, -0.01, 0, C, 0, 0, 10));
  P.push(ellipsoid(0.075, 0.048, 0.048, 0.36, -0.01, 0, C, 10));
  P.push(tube(0.014, 0.18, -0.43, -0.01, 0, C, 0, 0, 10, 0.048));
  // Hump (missile / machinery deck) aft of the sail.
  P.push(ellipsoid(0.16, 0.03, 0.036, -0.03, 0.03, 0, C, 8));
  // Tall sail with a sloped base fillet and sail planes.
  P.push(frustum(0.14, 0.032, 0.085, 0.021, 0.03, 0.175, 0.015, 0, C));
  P.push(box(0.08, 0.06, 0.02, 0.175, 0.04, 0, C));
  P.push(box(0.035, 0.004, 0.12, 0.19, 0.075, 0, C));
  // X-form tail.
  for (const a of [Q, -Q]) P.push(boxR(0.05, 0.12, 0.004, -0.5, -0.01, 0, C, a));
  // Open propeller.
  P.push(cyl(0.03, 0.03, 0.006, -0.55, -0.01, 0, 0x3b3426, 7, 'x'));
}

// ---------------------------------------------------------------- capital ships

/** Iowa after the 1980s refit: long sharp bow, three triple 16-inch turrets (two forward,
 * one aft), tower bridge with a tall pole mast, two funnels, Tomahawk box launchers between them. */
function coalitionBattleship(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.125, -0.06, 0.8), 0.05);
  const turret = (x: number, y: number, aft: boolean) => {
    const s = aft ? -1 : 1;
    P.push(cyl(0.034, 0.036, y - 0.05 + 0.006, x, 0.05, 0, c.S, 10));
    P.push(frustum(0.07, 0.062, 0.055, 0.052, 0.03, x, y, 0, c.S));
    for (const z of [-0.016, 0, 0.016]) P.push(tube(0.0058, 0.12, x + s * 0.09, y + 0.016, z, DARK, 0, aft ? Math.PI : 0, 4, 0.0042));
  };
  turret(0.29, 0.056, false);
  turret(0.185, 0.072, false);
  turret(-0.29, 0.056, true);
  // Superstructure: conning tower, stepped tower bridge, pole mast.
  P.push(box(0.24, 0.05, 0.1, -0.03, 0.05, 0, c.S));
  P.push(box(0.11, 0.05, 0.075, 0.06, 0.1, 0, c.S));
  P.push(box(0.07, 0.06, 0.05, 0.075, 0.15, 0, c.S));
  P.push(box(0.012, 0.012, 0.055, 0.112, 0.19, 0, GLASS));
  P.push(box(0.04, 0.05, 0.04, 0.075, 0.21, 0, c.S));
  P.push(cyl(0.005, 0.008, 0.11, 0.075, 0.26, 0, DARK, 4));
  P.push(box(0.008, 0.004, 0.09, 0.075, 0.33, 0, DARK));
  // Two funnels with caps.
  for (const x of [0.0, -0.1]) {
    P.push(box(0.05, 0.085, 0.055, x, 0.1, 0, c.S));
    P.push(box(0.045, 0.008, 0.05, x, 0.185, 0, BLACK));
  }
  // Armoured box launchers (Tomahawk), secondary 5-inch mounts along the sides.
  for (const z of [-0.042, 0.042]) {
    P.push(boxR(0.045, 0.022, 0.022, -0.05, 0.11, z, DARK, 0, 0, 0.18));
    for (const x of [0.06, -0.02, -0.1]) P.push(box(0.025, 0.018, 0.022, x, 0.1, z * 1.25, c.S));
  }
  P.push(box(0.035, 0.05, 0.035, -0.16, 0.1, 0, c.S));
  P.push(cyl(0.004, 0.006, 0.07, -0.16, 0.15, 0, DARK, 4));
}

/** Kirov-type strike cruiser: high forecastle with flush missile-hatch grids, a massive central
 * superstructure topped by a pyramid tower and a large back-to-back radar, combined funnel
 * block aft, twin 130 mm gun at the stern. */
function unionBattleship(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.115, 0.0, 0.85), 0.05);
  P.push(prism([[0.45, 0], [0.3, -0.05], [0.12, -0.057], [0.12, 0.057], [0.3, 0.05]], 0.05, 0.065, c.H));
  // SAM silo cluster (round hatches) and the anti-ship missile hatch grid.
  for (let i = 0; i < 6; i++) P.push(cyl(0.008, 0.008, 0.004, 0.36 - (i % 3) * 0.02, 0.065, (i < 3 ? -1 : 1) * 0.012, DARK, 8));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) P.push(box(0.016, 0.004, 0.014, 0.28 - i * 0.022, 0.065, -0.04 + j * 0.02, DARK));
  // Central superstructure and bridge.
  P.push(frustum(0.26, 0.1, 0.22, 0.085, 0.075, 0.0, 0.05, 0, c.S));
  P.push(frustum(0.09, 0.08, 0.07, 0.065, 0.06, 0.09, 0.125, 0, c.S));
  P.push(box(0.012, 0.012, 0.06, 0.125, 0.165, 0, GLASS));
  // Pyramid tower under the big radar.
  P.push(frustum(0.08, 0.07, 0.035, 0.032, 0.11, 0.06, 0.185, 0, c.S));
  P.push(box(0.012, 0.012, 0.012, 0.06, 0.295, 0, DARK));
  // Fire-control dishes either side.
  for (const z of [-0.035, 0.035]) P.push(ellipsoid(0.012, 0.012, 0.012, 0.0, 0.14, z, 0xe6e6df, 6));
  // Funnel block aft with paired uptakes and an aft lattice mast.
  P.push(frustum(0.1, 0.085, 0.08, 0.07, 0.07, -0.13, 0.05, 0, c.S));
  for (const z of [-0.018, 0.018]) P.push(boxR(0.03, 0.03, 0.026, -0.15, 0.135, z, BLACK, 0, 0, -0.35));
  P.push(cyl(0.004, 0.009, 0.1, -0.1, 0.12, 0, DARK, 4));
  // Twin 130 mm aft, helicopter deck at the stern.
  gunMount(P, -0.3, 0.05, c.S, 1.2, true, true);
  P.push(box(0.09, 0.002, 0.09, -0.42, 0.05, 0, 0x9aa3a8));
}

// ---------------------------------------------------------------- carriers

/** Ford: angled flight deck, small island set well aft on the starboard (-z) edge with fixed
 * radar faces, two bow and two waist catapult tracks, deck-edge elevators. */
function coalitionCarrier(P: Part[], c: Colors) {
  const deck: [number, number][] = [
    [-0.5, -0.1],
    [0.32, -0.1],
    [0.5, -0.04],
    [0.5, 0.05],
    [0.2, 0.13],
    [-0.25, 0.145],
    [-0.5, 0.11],
  ];
  P.push(prism(hullShape(0.14, 0.1), -0.03, 0.06, c.H));
  P.push(prism(hullShape(0.145, 0.1), -0.035, -0.005, c.T));
  P.push(prism(deck, 0.06, 0.075, c.D));
  // Island, its fixed radar faces and mast.
  P.push(box(0.09, 0.07, 0.034, -0.2, 0.075, -0.088, c.S));
  P.push(box(0.05, 0.04, 0.03, -0.2, 0.145, -0.088, c.S));
  P.push(panel(0.012, -0.172, 0.165, -0.088, 0, DARK, 6));
  P.push(panel(0.012, -0.2, 0.165, -0.105, Math.PI / 2, DARK, 6));
  P.push(box(0.015, 0.008, 0.032, -0.165, 0.13, -0.088, GLASS));
  P.push(cyl(0.004, 0.006, 0.05, -0.2, 0.185, -0.088, DARK, 4));
  // Deck markings: landing line on the angle, catapult tracks.
  P.push(box(0.7, 0.002, 0.006, -0.12, 0.075, 0.04, DECK_MARK, -0.15));
  for (const z of [-0.035, 0.0]) P.push(box(0.24, 0.002, 0.004, 0.33, 0.075, z, 0x9aa0a0));
  for (const z of [0.07, 0.1]) P.push(box(0.22, 0.002, 0.004, 0.02, 0.075, z, 0x9aa0a0, -0.15));
  // Deck-edge elevators.
  for (const x of [-0.06, -0.32]) P.push(box(0.06, 0.003, 0.03, x, 0.073, -0.112, DARK));
  P.push(box(0.06, 0.003, 0.03, -0.38, 0.073, 0.135, DARK));
  // Parked jets (F-35C and an E-2 near the island).
  for (let i = 0; i < 5; i++) {
    const x = 0.22 - i * 0.065;
    P.push(prism([[x + 0.025, -0.075], [x - 0.02, -0.095], [x - 0.02, -0.055]], 0.075, 0.084, 0x5d666d));
  }
  P.push(box(0.03, 0.01, 0.07, -0.3, 0.075, -0.065, 0x8a9399));
}

/** Ski-jump carrier (Shandong type): STOBAR bow ramp, angled deck, a large island mid-ships
 * on the starboard (-z) edge with flat AESA faces and a rotating air-search radar on top. */
function unionCarrier(P: Part[], c: Colors) {
  const deck: [number, number][] = [
    [-0.5, -0.1],
    [0.3, -0.1],
    [0.38, -0.06],
    [0.38, 0.06],
    [0.2, 0.135],
    [-0.25, 0.15],
    [-0.5, 0.11],
  ];
  P.push(prism(hullShape(0.15, 0.1), -0.03, 0.06, c.H));
  P.push(prism(hullShape(0.155, 0.1), -0.035, -0.005, c.T));
  P.push(prism(deck, 0.06, 0.075, c.D));
  // Ski-jump ramp at the bow.
  P.push(ramp(0.14, 0.12, 0.015, 0.05, 0.44, 0.06, -0.005, c.D, 0.55));
  // Big island with a stepped top, flat radar faces and the rotating radar mast.
  P.push(frustum(0.15, 0.04, 0.13, 0.034, 0.08, 0.02, 0.075, -0.09, c.S));
  P.push(frustum(0.08, 0.034, 0.06, 0.03, 0.06, 0.03, 0.155, -0.09, c.S));
  P.push(box(0.016, 0.009, 0.034, 0.07, 0.17, -0.09, GLASS));
  P.push(boxR(0.004, 0.032, 0.03, 0.06, 0.19, -0.09, DARK, 0, 0, 0.15));
  P.push(boxR(0.03, 0.032, 0.004, 0.03, 0.19, -0.073, DARK, 0.15));
  P.push(cyl(0.005, 0.008, 0.06, 0.03, 0.215, -0.09, DARK, 4));
  // Deck markings: landing line on the angle, three take-off spots aimed at the ramp.
  P.push(box(0.7, 0.002, 0.006, -0.12, 0.075, 0.045, DECK_MARK, -0.15));
  for (const z of [-0.06, -0.02, 0.03]) P.push(box(0.16, 0.002, 0.004, 0.26, 0.075, z, YELLOW, z * 1.2));
  // Two starboard elevators either side of the island.
  for (const x of [0.15, -0.12]) P.push(box(0.06, 0.003, 0.03, x, 0.073, -0.112, DARK));
  // Parked J-15s aft.
  for (let i = 0; i < 5; i++) {
    const x = -0.2 - i * 0.055;
    P.push(prism([[x + 0.025, -0.07], [x - 0.02, -0.092], [x - 0.02, -0.048]], 0.075, 0.085, 0x7f8a95));
  }
}

// ---------------------------------------------------------------- ground forces

/** Vehicle colour: Coalition marines use the theatre camouflage, Union naval infantry the
 * blue-grey "ocean" pattern of PLA Navy Marine Corps vehicles. */
function vehicleColor(f: Faction, pal: Palette): number {
  if (f === 'coalition') return pal.vehicle;
  return new THREE.Color(pal.vehicle).lerp(new THREE.Color(0x56687a), 0.6).getHex();
}

function wheels(P: Part[], xs: number[], x: number, z: number, half: number, r = 0.022) {
  for (const wx of xs) for (const s of [-1, 1]) P.push(cyl(r, r, 0.016, x + wx, r, z + s * half, BLACK, 8, 'z'));
}

/** ACV 8x8 amphibious combat vehicle with a remote weapon station; dismounts beside it. */
function acv(P: Part[], v: number, vd: number) {
  wheels(P, [-0.075, -0.025, 0.035, 0.085], 0, 0, 0.052);
  P.push(prism([[0.13, 0], [0.1, -0.05], [-0.11, -0.05], [-0.11, 0.05], [0.1, 0.05]], 0.02, 0.075, v));
  P.push(frustum(0.2, 0.09, 0.16, 0.075, 0.018, -0.01, 0.075, 0, v));
  P.push(box(0.05, 0.022, 0.04, -0.02, 0.093, 0, vd));
  P.push(tube(0.004, 0.05, 0.03, 0.107, 0, DARK, 0, 0, 4));
  for (let i = 0; i < 3; i++) P.push(box(0.012, 0.032, 0.012, -0.15 - i * 0.03, 0, 0.06 - i * 0.02, 0x5a5440));
}

/** ZBD-05 amphibious tracked IFV: long low hull with a planing bow plate, tracks, 30 mm turret. */
function zbd05(P: Part[], v: number, vd: number) {
  for (const s of [-1, 1]) P.push(box(0.22, 0.035, 0.022, -0.01, 0, s * 0.05, BLACK));
  P.push(box(0.2, 0.045, 0.1, -0.02, 0.018, 0, v));
  P.push(ramp(0.07, 0.1, 0.045, 0.012, 0.115, 0.018, 0, v));
  P.push(frustum(0.065, 0.06, 0.05, 0.045, 0.028, -0.02, 0.063, 0, vd));
  P.push(tube(0.004, 0.07, 0.045, 0.078, 0, DARK, 0, 0, 4));
  for (let i = 0; i < 3; i++) P.push(box(0.012, 0.032, 0.012, -0.16 - i * 0.03, 0, 0.06 - i * 0.02, 0x3d4a55));
}

/** NMESIS: JLTV-based carrier with two NSM canisters on a raised launcher. */
function nmesis(P: Part[], v: number, vd: number) {
  wheels(P, [-0.06, 0.07], 0, 0, 0.05, 0.026);
  P.push(box(0.2, 0.05, 0.095, 0, 0.02, 0, v));
  P.push(box(0.06, 0.03, 0.085, 0.06, 0.07, 0, vd));
  for (const z of [-0.022, 0.022]) P.push(boxR(0.15, 0.03, 0.035, -0.04, 0.1, z, 0x4d5548, 0, 0, -0.3));
}

/** YJ-12 coastal TEL: heavy 8x8 truck, cab forward, three large round launch tubes raised. */
function yj12(P: Part[], v: number, vd: number) {
  wheels(P, [-0.1, -0.05, 0.05, 0.1], 0, 0, 0.052, 0.022);
  P.push(box(0.27, 0.035, 0.1, 0, 0.025, 0, v));
  P.push(box(0.055, 0.05, 0.095, 0.11, 0.06, 0, vd));
  for (const z of [-0.03, 0, 0.03]) P.push(tube(0.016, 0.2, -0.04, 0.1, z, 0x56604c, -0.32, 0, 8));
}

/** Patriot M903: semi-trailer with four square canisters raised at about 38 degrees. */
function patriot(P: Part[], v: number, vd: number) {
  wheels(P, [-0.1, -0.07, 0.1], 0, 0, 0.05, 0.02);
  P.push(box(0.06, 0.05, 0.09, 0.11, 0.02, 0, vd));
  P.push(box(0.22, 0.02, 0.1, -0.03, 0.03, 0, v));
  for (const zz of [-0.022, 0.022]) for (const yy of [0, 0.03]) P.push(boxR(0.16, 0.028, 0.04, -0.05, 0.1 + yy, zz, 0x606a5c, 0, 0, -0.66));
}

/** HQ-9: 8x8 TEL with four round tubes standing upright, cab forward. */
function hq9(P: Part[], v: number, vd: number) {
  wheels(P, [-0.1, -0.05, 0.05, 0.1], 0, 0, 0.052, 0.022);
  P.push(box(0.27, 0.035, 0.1, 0, 0.025, 0, v));
  P.push(box(0.055, 0.05, 0.095, 0.11, 0.06, 0, vd));
  for (const [dx, dz] of [[-0.07, -0.022], [-0.07, 0.022], [-0.03, -0.022], [-0.03, 0.022]]) P.push(cyl(0.017, 0.017, 0.15, dx, 0.06, dz, 0x5e6a5a, 8));
}

/** Fire-control / search radar vehicle beside a battery. */
function batteryRadar(P: Part[], f: Faction, x: number, z: number, v: number) {
  if (f === 'coalition') {
    // Flat phased-array face on a trailer (AN/MPQ-65 / G/ATOR style).
    wheels(P, [-0.03, 0.03], x, z, 0.05, 0.02);
    P.push(box(0.12, 0.04, 0.1, x, 0.02, z, v));
    P.push(boxR(0.012, 0.1, 0.09, x + 0.04, 0.12, z, 0xd8d8cf, 0, 0, -0.35));
  } else {
    // Tall truck-mounted array (HT-233 style) on a mast.
    wheels(P, [-0.06, 0.0, 0.06], x, z, 0.05, 0.02);
    P.push(box(0.17, 0.04, 0.1, x, 0.02, z, v));
    P.push(cyl(0.008, 0.01, 0.08, x - 0.02, 0.06, z, DARK, 4));
    P.push(boxR(0.012, 0.09, 0.1, x - 0.02, 0.17, z, 0xd8d8cf, 0, 0, -0.3));
  }
}

export function groundParts(P: Part[], type: 'infantry' | 'coastal' | 'sam', f: Faction, pal: Palette) {
  const v = vehicleColor(f, pal);
  const vd = new THREE.Color(v).multiplyScalar(0.72).getHex();
  const spots: [number, number][] = [
    [0.18, 0],
    [-0.12, -0.2],
    [-0.12, 0.2],
  ];
  for (const [x, z] of spots) {
    const start = P.length;
    if (type === 'infantry') {
      if (f === 'coalition') acv(P, v, vd);
      else zbd05(P, v, vd);
    } else if (type === 'coastal') {
      if (f === 'coalition') nmesis(P, v, vd);
      else yj12(P, v, vd);
    } else if (f === 'coalition') patriot(P, v, vd);
    else hq9(P, v, vd);
    for (let i = start; i < P.length; i++) P[i][0].translate(x, 0, z);
  }
  if (type !== 'infantry') batteryRadar(P, f, 0.05, 0.42, v);
}

// ---------------------------------------------------------------- aircraft

type Wing = [number, number][];

/** One aircraft, nose at +x, centred at (ox, oz). Lists are half-outlines on the +z side. */
function jet(P: Part[], ox: number, oz: number, spec: { body: Wing; wing: Wing; tail?: Wing; canard?: Wing; fins: { x: number; z: number; cant: number; h: number; len: number; y?: number }[]; col: number; canopy: number; canopyX: number; nacelles?: number }) {
  const at = (pts: Wing): [number, number][] => mirrored(pts).map(([x, z]) => [x + ox, z + oz] as [number, number]);
  const wc = new THREE.Color(spec.col).multiplyScalar(0.88).getHex();
  P.push(prism(at(spec.body), -0.03, 0.035, spec.col));
  // Wings, tailplanes and canards are drawn as one half per side (each half is convex).
  const halves = (pts: Wing, c: number) => {
    for (const s of [1, -1]) P.push(prism(pts.map(([x, z]) => [x + ox, s * z + oz] as [number, number]), -0.006, 0.008, c));
  };
  halves(spec.wing, wc);
  if (spec.tail) halves(spec.tail, wc);
  if (spec.canard) halves(spec.canard, wc);
  if (spec.nacelles) for (const s of [-1, 1]) P.push(box(0.42, 0.045, 0.045, -0.24 + ox, -0.03, s * spec.nacelles + oz, wc));
  for (const fn of spec.fins) for (const s of [-1, 1]) P.push(boxR(fn.len, fn.h, 0.008, fn.x + ox, fn.y ?? 0.02 + fn.h / 2, s * fn.z + oz, wc, s * fn.cant));
  P.push(ellipsoid(0.09, 0.022, 0.026, spec.canopyX + ox, 0.035, oz, spec.canopy, 6));
}

const F22: Parameters<typeof jet>[3] = {
  body: [[0.5, 0], [0.3, 0.045], [0.05, 0.075], [-0.45, 0.07], [-0.5, 0.035]],
  wing: [[0.12, 0.05], [-0.22, 0.4], [-0.32, 0.4], [-0.3, 0.05]],
  tail: [[-0.34, 0.05], [-0.47, 0.19], [-0.52, 0.19], [-0.5, 0.05]],
  fins: [{ x: -0.36, z: 0.07, cant: 0.45, h: 0.11, len: 0.13 }],
  col: 0x6f7880,
  canopy: 0xb08a3a,
  canopyX: 0.28,
};
const F35: Parameters<typeof jet>[3] = {
  body: [[0.46, 0], [0.25, 0.05], [0.0, 0.08], [-0.42, 0.06], [-0.48, 0.03]],
  wing: [[0.05, 0.06], [-0.13, 0.32], [-0.24, 0.32], [-0.26, 0.06]],
  tail: [[-0.3, 0.04], [-0.42, 0.18], [-0.48, 0.18], [-0.46, 0.04]],
  fins: [{ x: -0.34, z: 0.055, cant: 0.4, h: 0.09, len: 0.12 }],
  col: 0x7b858c,
  canopy: 0x2e3a44,
  canopyX: 0.25,
};
const J20: Parameters<typeof jet>[3] = {
  body: [[0.58, 0], [0.35, 0.04], [0.05, 0.07], [-0.45, 0.065], [-0.5, 0.035]],
  wing: [[0.02, 0.05], [-0.3, 0.36], [-0.4, 0.36], [-0.4, 0.05]],
  canard: [[0.25, 0.05], [0.12, 0.18], [0.08, 0.18], [0.1, 0.05]],
  fins: [
    { x: -0.36, z: 0.06, cant: 0.3, h: 0.1, len: 0.12 },
    { x: -0.36, z: 0.05, cant: -0.5, h: 0.05, len: 0.08, y: -0.045 },
  ],
  col: 0x56606a,
  canopy: 0xa48a4a,
  canopyX: 0.34,
};
const J15: Parameters<typeof jet>[3] = {
  body: [[0.52, 0], [0.3, 0.04], [0.05, 0.05], [-0.52, 0.03], [-0.6, 0.012]],
  wing: [[0.12, 0.08], [-0.24, 0.38], [-0.3, 0.38], [-0.28, 0.08]],
  tail: [[-0.36, 0.08], [-0.46, 0.21], [-0.5, 0.21], [-0.5, 0.08]],
  canard: [[0.2, 0.05], [0.12, 0.13], [0.08, 0.13], [0.1, 0.05]],
  fins: [{ x: -0.36, z: 0.1, cant: 0, h: 0.12, len: 0.12 }],
  nacelles: 0.055,
  col: 0x8d9aa6,
  canopy: 0x2e3a44,
  canopyX: 0.3,
};

/** Carrier AEW turboprop: high straight wing, two engines, rotodome on a pylon.
 * E-2 has four fins on its tailplane; the KJ-600 has two large end fins and a longer nose. */
function aew(P: Part[], f: Faction) {
  const col = f === 'coalition' ? 0x9aa3a8 : 0x8f9ba6;
  const wc = new THREE.Color(col).multiplyScalar(0.88).getHex();
  const nose = f === 'coalition' ? 0.45 : 0.5;
  P.push(prism(mirrored([[nose, 0], [0.32, 0.05], [-0.3, 0.05], [-0.45, 0.025]]), -0.04, 0.04, col));
  P.push(prism(mirrored([[0.12, 0.05], [0.12, 0.5], [0.04, 0.5], [0.02, 0.05]]), 0.02, 0.032, wc));
  for (const s of [-1, 1]) {
    P.push(box(0.16, 0.035, 0.035, 0.06, 0.0, s * 0.17, wc));
    P.push(cyl(0.06, 0.06, 0.004, 0.15, 0.018, s * 0.17, DARK, 8, 'x'));
  }
  P.push(prism(mirrored([[-0.36, 0.03], [-0.36, 0.2], [-0.44, 0.2], [-0.45, 0.03]]), 0.0, 0.012, wc));
  const fins = f === 'coalition' ? [0.2, 0.07] : [0.2];
  for (const z of fins) for (const s of [-1, 1]) P.push(box(0.08, 0.09, 0.008, -0.41, -0.02, s * z, wc));
  const dx = f === 'coalition' ? -0.08 : -0.03;
  P.push(cyl(0.012, 0.016, 0.06, dx, 0.04, 0, DARK, 4));
  P.push(cyl(0.16, 0.16, 0.03, dx, 0.1, 0, 0xdad8cc, 12));
}

export function airParts(P: Part[], type: 'fighter' | 'strike' | 'recon', f: Faction) {
  if (type === 'recon') {
    aew(P, f);
    return;
  }
  const spec = type === 'fighter' ? (f === 'coalition' ? F22 : J20) : f === 'coalition' ? F35 : J15;
  jet(P, 0.2, 0, spec);
  jet(P, -0.45, 0.75, spec);
}

export function shipParts(P: Part[], type: 'destroyer' | 'battleship' | 'carrier' | 'sub', f: Faction) {
  const c = colors(f);
  const u = f === 'union';
  switch (type) {
    case 'destroyer':
      return u ? unionDestroyer(P, c) : coalitionDestroyer(P, c);
    case 'battleship':
      return u ? unionBattleship(P, c) : coalitionBattleship(P, c);
    case 'carrier':
      return u ? unionCarrier(P, c) : coalitionCarrier(P, c);
    case 'sub':
      return u ? unionSub(P) : coalitionSub(P);
  }
}
