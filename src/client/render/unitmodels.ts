// Per-faction unit models. Each navy, army and air arm is drawn after real equipment of its
// type, so the two sides read differently at a glance but stay believable:
//   Coalition: Freedom LCS, Constellation FFG, Arleigh Burke DDG, Virginia SSN, Ticonderoga CG,
//              Iowa battleship, Ford carrier, ACV 8x8, NMESIS anti-ship launcher, Patriot,
//              F-22, F-35, E-2 Hawkeye.
//   Union:     Type 056 corvette, Type 054B frigate, Type 055 DDG, Type 09x SSN, Kirov-type
//              strike cruiser, a fictional railgun battleship, ski-jump carrier, ZBD-05
//              amphibious IFV, YJ-12 coastal TEL, HQ-9, J-20, J-15, KJ-600.
// Every model has three versions, one per fleet-comp variant (vi 0..2): the same hull with the
// variant's kit visible on deck (extra launchers, a second gun, mine rails, drop tanks, missiles...).
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
    corvette: { at: [0.06, 0.25, 0], size: [0.012, 0.02, 0.08] },
    frigate: { at: [0.06, 0.27, 0], size: [0.01, 0.018, 0.07] },
    cruiser: { at: [0.1, 0.31, 0], size: [0.009, 0.018, 0.065] },
    destroyer: { at: [0.045, 0.3, 0], size: [0.008, 0.016, 0.06] },
    battleship: { at: [0.075, 0.37, 0], size: [0.008, 0.02, 0.075] },
    carrier: { at: [-0.2, 0.235, -0.088], size: [0.006, 0.014, 0.05] },
  },
  union: {
    corvette: { at: [0.02, 0.26, 0], size: [0.012, 0.02, 0.08] },
    frigate: { at: [0.04, 0.29, 0], size: [0.01, 0.018, 0.075] },
    cruiser: { at: [0.06, 0.315, 0], size: [0.012, 0.04, 0.1] },
    destroyer: { at: [0.055, 0.3, 0], size: [0.007, 0.014, 0.05] },
    battleship: { at: [0.02, 0.3, 0], size: [0.01, 0.022, 0.08] },
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
function coalitionDestroyer(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.13, 0.1), 0.04);
  gunMount(P, 0.34, 0.045, c.S, 1);
  vls(P, 0.22, 0.08, 0.07, 0.045);
  destroyerKit(P, c, vi, -0.2, 0.045);
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
function unionDestroyer(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.115, 0.04), 0.045);
  destroyerKit(P, c, vi, -0.16, 0.05);
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

/** Destroyer variant kit amidships (x0 is the space between funnel and hangar). */
function destroyerKit(P: Part[], c: Colors, vi: number, x0: number, y: number) {
  if (vi === 0) {
    // Missiles: angled anti-ship canister racks either side.
    for (const z of [-0.04, 0.04]) for (const k of [0, 1]) P.push(boxR(0.07, 0.014, 0.014, x0 + 0.03, y + 0.03 + k * 0.016, z, DARK, 0, 0, 0.25));
  } else if (vi === 1) {
    // Air defence: a second illuminator mast and extra cells.
    vls(P, x0 + 0.02, 0.05, 0.06, y + 0.002);
    P.push(cyl(0.006, 0.008, 0.07, x0 - 0.02, y + 0.035, 0, DARK, 4));
    P.push(ellipsoid(0.016, 0.016, 0.016, x0 - 0.02, y + 0.08, 0, 0xe6e6df, 6));
  } else {
    // Guns: a second main gun aft.
    gunMount(P, x0 - 0.02, y, c.S, 0.95, true);
  }
}

// ---------------------------------------------------------------- corvettes

/** Freedom-class LCS: semi-planing hull with a sharp flared bow, a tall slab-sided superstructure,
 * 57 mm gun forward and a very large flight deck and mission bay aft. */
function coalitionCorvette(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.15, 0.18, 0.95), 0.035);
  // Superstructure: one tall angular block from bridge to hangar.
  P.push(frustum(0.36, 0.14, 0.3, 0.12, 0.09, 0.0, 0.035, 0, c.S));
  P.push(box(0.012, 0.014, 0.1, 0.17, 0.11, 0, GLASS));
  P.push(frustum(0.08, 0.07, 0.04, 0.04, 0.09, 0.07, 0.125, 0, c.S));
  P.push(box(0.12, 0.002, 0.13, -0.38, 0.036, 0, 0x9aa3a8));
  if (vi === 0) {
    // Troop transport: an enlarged mission bay with a stern ramp, smoke dispensers on the mast.
    P.push(box(0.2, 0.06, 0.14, -0.22, 0.035, 0, c.S));
    P.push(ramp(0.06, 0.1, 0.0, 0.03, -0.47, 0.035, 0, DARK));
    for (const z of [-0.02, 0.02]) P.push(tube(0.006, 0.03, 0.06, 0.2, z, DARK, 0.8, 0, 5));
    P.push(tube(0.003, 0.04, 0.3, 0.05, 0, DARK, 0, 0, 4));
  } else if (vi === 1) {
    // LCS: 57 mm forward, a 76 mm on the hangar roof, SeaRAM aft.
    gunMount(P, 0.3, 0.035, c.S, 0.75);
    gunMount(P, -0.17, 0.125, c.S, 0.7, true);
    ciws(P, -0.27, 0.125, 0);
    P.push(box(0.12, 0.09, 0.13, -0.2, 0.035, 0, c.S));
  } else {
    // Swarm: two angled quad canister packs amidships, a light gun forward.
    P.push(tube(0.003, 0.04, 0.3, 0.05, 0, DARK, 0, 0, 4));
    for (const z of [-0.04, 0.04]) for (const k of [0, 1]) P.push(boxR(0.09, 0.016, 0.018, -0.2, 0.06 + k * 0.018, z, 0x5a6066, 0, 0, 0.3));
    P.push(box(0.12, 0.04, 0.13, -0.2, 0.035, 0, c.S));
  }
}

/** Type 056: small conventional hull, 76 mm forward, a compact superstructure with a lattice-free
 * mast, YJ-83 box launchers amidships and a helicopter pad aft. */
function unionCorvette(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.12, 0.1), 0.04);
  P.push(frustum(0.22, 0.1, 0.19, 0.085, 0.07, 0.05, 0.04, 0, c.S));
  P.push(box(0.012, 0.012, 0.075, 0.15, 0.095, 0, GLASS));
  P.push(frustum(0.06, 0.05, 0.03, 0.03, 0.12, 0.03, 0.11, 0, c.S));
  P.push(frustum(0.06, 0.06, 0.05, 0.05, 0.05, -0.08, 0.04, 0, c.S));
  P.push(box(0.04, 0.008, 0.05, -0.08, 0.09, 0, BLACK));
  P.push(box(0.14, 0.002, 0.11, -0.38, 0.041, 0, 0x9aa3a8));
  if (vi === 0) {
    // Troop transport: a raised boat deck with davits and smoke dispensers.
    P.push(box(0.16, 0.05, 0.12, -0.22, 0.04, 0, c.S));
    for (const z of [-0.07, 0.07]) P.push(box(0.08, 0.025, 0.025, -0.22, 0.07, z, 0xc9a24a));
    for (const z of [-0.02, 0.02]) P.push(tube(0.006, 0.03, 0.12, 0.17, z, DARK, 0.8, 0, 5));
    gunMount(P, 0.3, 0.04, c.S, 0.55);
  } else if (vi === 1) {
    // LCS: 76 mm forward, a second gun aft, CIWS on the hangar.
    gunMount(P, 0.3, 0.04, c.S, 0.8);
    gunMount(P, -0.2, 0.04, c.S, 0.75, true);
    ciws(P, -0.13, 0.09, 0);
  } else {
    // Swarm: four YJ-83 boxes in two angled pairs.
    gunMount(P, 0.3, 0.04, c.S, 0.6);
    for (const z of [-0.035, 0.035]) for (const k of [0, 1]) P.push(boxR(0.1, 0.018, 0.02, -0.18, 0.06 + k * 0.02, z, 0x6a7178, 0, 0, 0.22));
  }
}

// ---------------------------------------------------------------- frigates

/** Constellation FFG: 57 mm gun, VLS forward, a superstructure with three flat SPY-6 faces,
 * a single funnel, hangar and flight deck. */
function coalitionFrigate(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.125, 0.1), 0.04);
  gunMount(P, 0.34, 0.04, c.S, 0.8);
  vls(P, 0.24, 0.07, 0.065, 0.04);
  P.push(frustum(0.18, 0.105, 0.14, 0.085, 0.07, 0.08, 0.04, 0, c.S));
  P.push(box(0.012, 0.012, 0.07, 0.15, 0.1, 0, GLASS));
  P.push(frustum(0.08, 0.07, 0.05, 0.05, 0.1, 0.06, 0.11, 0, c.S));
  for (const sz of [1, -1]) P.push(panel(0.022, 0.08, 0.15, sz * 0.03, -sz * Q, DARK, 6));
  P.push(cyl(0.004, 0.006, 0.06, 0.06, 0.23, 0, DARK, 4));
  P.push(frustum(0.06, 0.06, 0.045, 0.045, 0.07, -0.07, 0.04, 0, c.S));
  P.push(box(0.045, 0.008, 0.045, -0.07, 0.11, 0, BLACK));
  P.push(box(0.1, 0.06, 0.11, -0.2, 0.04, 0, c.S));
  P.push(box(0.12, 0.002, 0.1, -0.33, 0.041, 0, 0x9aa3a8));
  frigateKit(P, vi, 0.04);
}

/** Type 054B: stealthy flush hull, 100 mm gun, VLS, an integrated mast with flat array faces,
 * a twin-uptake funnel and a hangar aft. */
function unionFrigate(P: Part[], c: Colors, vi: number) {
  hull(P, c, hullShape(0.12, 0.06), 0.045);
  gunMount(P, 0.33, 0.045, c.S, 0.9);
  vls(P, 0.23, 0.08, 0.07, 0.045);
  P.push(frustum(0.22, 0.1, 0.19, 0.085, 0.065, 0.05, 0.045, 0, c.S));
  P.push(box(0.012, 0.01, 0.07, 0.15, 0.095, 0, GLASS));
  P.push(frustum(0.08, 0.075, 0.04, 0.035, 0.13, 0.04, 0.11, 0, c.S));
  P.push(boxR(0.004, 0.045, 0.045, 0.075, 0.16, 0, DARK, 0, 0, 0.14));
  for (const sz of [1, -1]) P.push(boxR(0.045, 0.045, 0.004, 0.04, 0.16, sz * 0.035, DARK, sz * 0.12));
  P.push(frustum(0.07, 0.06, 0.055, 0.05, 0.06, -0.08, 0.045, 0, c.S));
  for (const z of [-0.012, 0.012]) P.push(box(0.03, 0.008, 0.016, -0.08, 0.105, z, BLACK));
  P.push(box(0.1, 0.055, 0.1, -0.2, 0.045, 0, c.S));
  P.push(box(0.12, 0.002, 0.1, -0.33, 0.046, 0, 0x9aa3a8));
  frigateKit(P, vi, 0.045);
}

/** Frigate variant kit on the after deck (y is the deck height). */
function frigateKit(P: Part[], vi: number, y: number) {
  if (vi === 0) {
    // Sub hunter: a helicopter on deck, the towed-array reel at the stern, torpedo tubes.
    P.push(prism(mirrored([[-0.3, 0], [-0.33, 0.014], [-0.38, 0.01], [-0.4, 0]]), y + 0.004, y + 0.022, 0x6d777e));
    P.push(cyl(0.035, 0.035, 0.002, -0.34, y + 0.026, 0, DARK, 10));
    P.push(cyl(0.018, 0.018, 0.03, -0.45, y + 0.015, 0, 0xc9a24a, 8, 'z'));
    for (const z of [-0.055, 0.055]) P.push(tube(0.006, 0.04, -0.13, y + 0.01, z, DARK, 0, 0, 5));
  } else if (vi === 1) {
    // Mine layer: twin mine rails down the stern loaded with mines.
    for (const z of [-0.03, 0.03]) {
      P.push(box(0.2, 0.004, 0.006, -0.38, y + 0.003, z, DARK));
      for (let i = 0; i < 4; i++) P.push(cyl(0.012, 0.012, 0.016, -0.3 - i * 0.045, y + 0.012, z, 0x3a3f2e, 8));
    }
  } else {
    // Air defence: a second launcher block and an extra fire-control director.
    vls(P, -0.12, 0.05, 0.06, y + 0.022);
    P.push(cyl(0.007, 0.009, 0.05, -0.2, y + 0.06, 0, DARK, 4));
    P.push(ellipsoid(0.014, 0.014, 0.014, -0.2, y + 0.09, 0, 0xe6e6df, 6));
  }
}

// ---------------------------------------------------------------- submarines

/** Virginia: smooth cylinder, sail well forward with no sail planes, cruciform tail, pump-jet shroud. */
function coalitionSub(P: Part[], vi: number) {
  const C = vi === 0 ? 0x15181a : 0x1b1f22;
  subKit(P, vi, 0.044, C);
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
function unionSub(P: Part[], vi: number) {
  const C = vi === 0 ? 0x1e252b : 0x252c33;
  subKit(P, vi, 0.048, C);
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

/** Submarine variant kit: anechoic tile seams (stealth), mine pods (mines), a missile hump (range). */
function subKit(P: Part[], vi: number, r: number, C: number) {
  if (vi === 0) {
    for (const x of [0.25, 0.05, -0.15, -0.35]) P.push(cyl(r * 1.01, r * 1.01, 0.004, x, -0.01, 0, 0x0e1012, 10, 'x'));
  } else if (vi === 1) {
    for (const z of [-r, r]) P.push(tube(0.014, 0.22, -0.12, -0.03, z * 1.05, 0x3a3f2e, 0, 0, 6));
  } else {
    P.push(ellipsoid(0.13, 0.026, 0.03, 0.02, r * 0.55, 0, C, 8));
    for (let i = 0; i < 3; i++) for (const z of [-0.012, 0.012]) P.push(cyl(0.008, 0.008, 0.004, -0.06 + i * 0.05, r * 0.55 + 0.024, z, 0x0e1012, 8));
  }
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
function unionCruiser(P: Part[], c: Colors) {
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

/** Ticonderoga-type cruiser: two deckhouses each with two SPY-1 faces, VLS fields fore and aft,
 * two 5-inch guns, a pole mast on each house and two funnel pairs between them. */
function coalitionCruiser(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.12, 0.08), 0.045);
  gunMount(P, 0.36, 0.045, c.S, 1);
  vls(P, 0.25, 0.1, 0.075, 0.045);
  P.push(box(0.15, 0.08, 0.1, 0.09, 0.045, 0, c.S));
  P.push(box(0.08, 0.05, 0.08, 0.1, 0.125, 0, c.S));
  P.push(box(0.012, 0.012, 0.075, 0.145, 0.15, 0, GLASS));
  for (const sz of [1, -1]) P.push(panel(0.028, 0.14, 0.11, sz * 0.05, -sz * Q, DARK));
  P.push(cyl(0.005, 0.008, 0.13, 0.1, 0.24, 0, DARK, 4));
  for (const x of [0.0, -0.06]) {
    P.push(box(0.035, 0.07, 0.05, x, 0.08, 0, c.S));
    P.push(box(0.03, 0.006, 0.045, x, 0.153, 0, BLACK));
  }
  P.push(box(0.14, 0.075, 0.1, -0.15, 0.045, 0, c.S));
  for (const sz of [1, -1]) P.push(panel(0.026, -0.2, 0.1, sz * 0.05, -sz * 3 * Q, DARK));
  P.push(cyl(0.005, 0.007, 0.08, -0.14, 0.17, 0, DARK, 4));
  vls(P, -0.29, 0.1, 0.075, 0.045);
  gunMount(P, -0.4, 0.045, c.S, 1, true);
  ciws(P, -0.06, 0.13, 0.04);
  ciws(P, 0.03, 0.13, -0.04);
}

/** Fictional Union railgun battleship: a long stealthy hull, two big enclosed twin railgun turrets
 * forward and one aft, a faceted citadel with an integrated mast, flat uptakes. */
function unionBattleship(P: Part[], c: Colors) {
  hull(P, c, hullShape(0.13, -0.04, 0.82), 0.05);
  P.push(prism([[0.46, 0], [0.32, -0.055], [0.15, -0.065], [0.15, 0.065], [0.32, 0.055]], 0.05, 0.062, c.H));
  const turret = (x: number, y: number, aft: boolean) => {
    const s = aft ? -1 : 1;
    P.push(frustum(0.085, 0.07, 0.06, 0.055, 0.035, x, y, 0, c.S));
    for (const z of [-0.014, 0.014]) P.push(tube(0.006, 0.15, x + s * 0.11, y + 0.018, z, DARK, 0, aft ? Math.PI : 0, 6, 0.005));
  };
  turret(0.3, 0.062, false);
  turret(0.17, 0.08, false);
  turret(-0.3, 0.05, true);
  P.push(frustum(0.26, 0.11, 0.2, 0.09, 0.08, -0.02, 0.05, 0, c.S));
  P.push(box(0.012, 0.012, 0.07, 0.085, 0.12, 0, GLASS));
  P.push(frustum(0.1, 0.08, 0.05, 0.045, 0.14, 0.03, 0.13, 0, c.S));
  P.push(boxR(0.004, 0.055, 0.05, 0.07, 0.18, 0, DARK, 0, 0, 0.14));
  for (const sz of [1, -1]) P.push(boxR(0.055, 0.055, 0.004, 0.03, 0.18, sz * 0.04, DARK, sz * 0.12));
  for (const z of [-0.02, 0.02]) P.push(box(0.05, 0.01, 0.03, -0.11, 0.13, z, BLACK));
  vls(P, -0.17, 0.06, 0.08, 0.05);
  ciws(P, -0.05, 0.13, 0.05);
  ciws(P, -0.05, 0.13, -0.05);
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

/** Ground variant kit on one vehicle (heavy APC turret, dozer blade, launcher pods, AA guns). */
function groundKit(P: Part[], type: 'infantry' | 'coastal' | 'sam', vi: number, vd: number) {
  if (type === 'infantry') {
    if (vi === 0) P.push(ramp(0.04, 0.1, 0.0, 0.03, 0.15, 0.02, 0, vd));
    else if (vi === 1) {
      P.push(box(0.06, 0.028, 0.05, -0.02, 0.098, 0, vd));
      P.push(tube(0.006, 0.08, 0.04, 0.115, 0, DARK, 0, 0, 5));
    } else P.push(boxR(0.02, 0.04, 0.12, 0.15, 0.03, 0, DARK, 0, 0, 0.3));
  } else if (type === 'coastal') {
    if (vi === 0) for (const z of [-0.03, 0.03]) P.push(boxR(0.1, 0.03, 0.05, -0.05, 0.14, z, 0x4d5548, 0, 0, -0.35));
    else if (vi === 1) P.push(tube(0.024, 0.24, -0.05, 0.13, 0, 0x56604c, -0.3, 0, 8));
  } else if (vi === 2) {
    // AA guns: a twin-gun turret instead of the launcher.
    P.push(box(0.07, 0.04, 0.07, -0.03, 0.06, 0, vd));
    for (const z of [-0.02, 0.02]) P.push(tube(0.004, 0.1, 0.03, 0.1, z, DARK, -0.6, 0, 4));
  }
}

export function groundParts(P: Part[], type: 'infantry' | 'coastal' | 'sam', f: Faction, pal: Palette, vi = 0) {
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
    } else if (vi === 2) {
      // AA guns: a gun vehicle on the battery chassis.
      wheels(P, [-0.07, 0.07], 0, 0, 0.05, 0.022);
      P.push(box(0.2, 0.04, 0.1, 0, 0.02, 0, v));
    } else if (f === 'coalition') patriot(P, v, vd);
    else hq9(P, v, vd);
    groundKit(P, type, vi, vd);
    for (let i = start; i < P.length; i++) P[i][0].translate(x, 0, z);
  }
  // Batteries bring a radar vehicle, except anti-ship launchers that rely on outside radar.
  if (type === 'sam' || (type === 'coastal' && vi === 2)) batteryRadar(P, f, 0.05, 0.42, v);
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
function aew(P: Part[], f: Faction, vi = 0) {
  // Variants: drop tanks (endurance), a bigger rotodome (range), a sonobuoy pod (buoys).
  if (vi === 0) for (const s of [-1, 1]) P.push(tube(0.022, 0.2, -0.02, -0.02, s * 0.32, 0x8f9ba6, 0, 0, 6));
  if (vi === 2) P.push(box(0.16, 0.03, 0.05, -0.12, -0.055, 0, 0xc9a24a));
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
  const dome = vi === 1 ? 0.2 : 0.16;
  P.push(cyl(dome, dome, vi === 1 ? 0.036 : 0.03, dx, 0.1, 0, 0xdad8cc, 12));
}

/** Stores under one jet's wings (nose +x, centred at ox, oz): missiles, tanks, bombs or torpedoes. */
function stores(P: Part[], ox: number, oz: number, kind: 'aam' | 'aam_big' | 'aam_x' | 'tank' | 'asm' | 'bomb' | 'torp') {
  const spec = { aam: [0.004, 0.16, 0xd8d8d0, 2], aam_big: [0.006, 0.24, 0xd8d8d0, 1], aam_x: [0.0045, 0.15, 0xe2c76a, 3], tank: [0.014, 0.22, 0x6f7880, 1], asm: [0.009, 0.28, 0x8a8f86, 1], bomb: [0.01, 0.14, 0x55604e, 1], torp: [0.009, 0.22, 0xc9a24a, 1] } as const;
  const [r, len, col, n] = spec[kind];
  for (const s of [-1, 1]) for (let i = 0; i < n; i++) P.push(tube(r, len, ox - 0.1, -0.035, oz + s * (0.16 + i * 0.07), col, 0, 0, 5));
}

export function airParts(P: Part[], type: 'fighter' | 'strike' | 'recon', f: Faction, vi = 0) {
  if (type === 'recon') {
    aew(P, f, vi);
    return;
  }
  const spec = type === 'fighter' ? (f === 'coalition' ? F22 : J20) : f === 'coalition' ? F35 : J15;
  const kit = type === 'fighter' ? (['aam', 'aam_big', 'aam_x'] as const)[vi] : (['asm', 'bomb', 'torp'] as const)[vi];
  for (const [ox, oz] of [[0.2, 0], [-0.45, 0.75]] as const) {
    jet(P, ox, oz, spec);
    stores(P, ox, oz, kit ?? 'aam');
  }
}

export type ShipType = 'corvette' | 'frigate' | 'destroyer' | 'cruiser' | 'battleship' | 'carrier' | 'sub';

export function shipParts(P: Part[], type: ShipType, f: Faction, vi = 0) {
  const c = colors(f);
  const u = f === 'union';
  switch (type) {
    case 'corvette':
      return u ? unionCorvette(P, c, vi) : coalitionCorvette(P, c, vi);
    case 'frigate':
      return u ? unionFrigate(P, c, vi) : coalitionFrigate(P, c, vi);
    case 'destroyer':
      return u ? unionDestroyer(P, c, vi) : coalitionDestroyer(P, c, vi);
    case 'cruiser':
      return u ? unionCruiser(P, c) : coalitionCruiser(P, c);
    case 'battleship':
      return u ? unionBattleship(P, c) : coalitionBattleship(P, c);
    case 'carrier':
      return u ? unionCarrier(P, c) : coalitionCarrier(P, c);
    case 'sub':
      return u ? unionSub(P, vi) : coalitionSub(P, vi);
  }
}
