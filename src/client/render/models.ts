// Procedural low-poly models for units and buildings. Built once per (type, faction, theatre) and cloned.
import * as THREE from 'three';
import type { Faction, UnitType, BuildingType } from '../../shared/defs';
import { mergeColored } from './terrain';
import { FACTION_STYLE, Palette } from '../theme';
import { patchMaterial } from './weatherfx';

type Part = [THREE.BufferGeometry, number];

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: number, ry = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y + h / 2, z);
  return [g, c];
}
function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, c: number, seg = 6, axis: 'y' | 'x' | 'z' = 'y'): Part {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y + (axis === 'y' ? h / 2 : 0), z);
  return [g, c];
}
/** Convex polygon (x,z) extruded from y0 to y1. */
function prism(pts: [number, number][], y0: number, y1: number, c: number): Part {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) pts = pts.slice().reverse();
  const pos: number[] = [];
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0];
    cz += p[1];
  }
  cx /= pts.length;
  cz /= pts.length;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    // top (counter-clockwise when seen from above => normal +y)
    pos.push(cx, y1, cz, b[0], y1, b[1], a[0], y1, a[1]);
    // side
    pos.push(a[0], y0, a[1], a[0], y1, a[1], b[0], y1, b[1]);
    pos.push(a[0], y0, a[1], b[0], y1, b[1], b[0], y0, b[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return [g, c];
}
function hullShape(beam: number, bowStart = 0.12, sternCut = 0.92): [number, number][] {
  const b = beam / 2;
  return [
    [-0.5, -b * sternCut],
    [-0.46, -b],
    [bowStart, -b],
    [0.3, -b * 0.82],
    [0.42, -b * 0.5],
    [0.5, 0],
    [0.42, b * 0.5],
    [0.3, b * 0.82],
    [bowStart, b],
    [-0.46, b],
    [-0.5, b * sternCut],
  ];
}

function finalize(parts: Part[], scale: number): THREE.BufferGeometry {
  const g = mergeColored(parts);
  g.scale(scale, scale, scale);
  return g;
}

const cache = new Map<string, THREE.BufferGeometry>();
const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
patchMaterial(MAT);
const MAT_GLOW = new THREE.MeshBasicMaterial({ vertexColors: true });

/** Visual length (km) for each type. Models are exaggerated for readability. */
export const VIS_LEN: Record<UnitType, number> = {
  destroyer: 0.72,
  sub: 0.58,
  battleship: 1.05,
  carrier: 1.2,
  merchant: 0.5,
  lander: 0.16,
  infantry: 0.42,
  coastal: 0.42,
  sam: 0.42,
  fighter: 0.26,
  strike: 0.28,
  recon: 0.32,
};

function unitGeometry(type: UnitType, faction: Faction, pal: Palette): THREE.BufferGeometry {
  const key = `${type}:${faction}:${pal.treeKind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const st = FACTION_STYLE[faction];
  const H = st.hull;
  const D = st.deck;
  const S = st.superstructure;
  const T = st.trim;
  const dark = 0x2a2f33;
  const P: Part[] = [];
  const u = faction === 'union';
  switch (type) {
    case 'destroyer': {
      P.push(prism(hullShape(0.13), -0.03, 0.045, H));
      P.push(prism(hullShape(0.12).map(([x, z]) => [x * 0.98, z] as [number, number]), 0.045, 0.05, D));
      P.push(prism(hullShape(0.135).map(([x, z]) => [x, z] as [number, number]), -0.035, -0.005, T));
      // superstructure
      P.push(box(0.2, 0.06, 0.09, 0.0, 0.05, 0, S));
      P.push(box(0.1, 0.05, 0.075, 0.04, 0.11, 0, S));
      P.push(box(0.04, 0.012, 0.08, 0.09, 0.16, 0, dark)); // bridge windows band
      if (u) P.push(box(0.05, 0.06, 0.05, 0.02, 0.16, 0, S));
      P.push(cyl(0.006, 0.01, 0.14, 0.03, 0.16, 0, dark, 4));
      P.push(box(0.012, 0.03, 0.05, 0.03, 0.26, 0, S));
      P.push(box(0.07, 0.045, 0.05, -0.12, 0.05, 0, S));
      P.push(box(0.04, 0.03, 0.035, -0.12, 0.095, 0, dark));
      // VLS & gun
      P.push(box(0.07, 0.006, 0.06, 0.2, 0.05, 0, dark));
      P.push(box(0.05, 0.006, 0.06, -0.28, 0.05, 0, dark));
      P.push(box(0.045, 0.03, 0.04, 0.3, 0.05, 0, S));
      P.push(cyl(0.004, 0.004, 0.07, 0.36, 0.068, 0, S, 4, 'x'));
      // helipad marking
      P.push(box(0.08, 0.002, 0.08, -0.42, 0.05, 0, 0x9aa3a8));
      break;
    }
    case 'battleship': {
      P.push(prism(hullShape(0.16, 0.05), -0.03, 0.05, H));
      P.push(prism(hullShape(0.15, 0.05).map(([x, z]) => [x * 0.98, z] as [number, number]), 0.05, 0.055, D));
      P.push(prism(hullShape(0.165, 0.05), -0.035, -0.005, T));
      const turret = (x: number, flip: boolean) => {
        P.push(cyl(0.032, 0.035, 0.02, x, 0.055, 0, S, 8));
        P.push(box(0.06, 0.028, 0.055, x, 0.06, 0, S));
        for (const z of [-0.016, 0, 0.016]) {
          const len = 0.1;
          P.push(cyl(0.004, 0.005, len, x + (flip ? -1 : 1) * (0.03 + len / 2), 0.075, z, dark, 4, 'x'));
        }
      };
      turret(0.27, false);
      turret(0.16, false);
      turret(-0.3, true);
      P.push(box(0.22, 0.06, 0.1, -0.03, 0.055, 0, S));
      P.push(box(0.1, 0.09, 0.07, 0.02, 0.115, 0, S));
      P.push(box(0.05, 0.08, 0.05, 0.03, 0.2, 0, S));
      P.push(cyl(0.006, 0.008, 0.12, 0.03, 0.28, 0, dark, 4));
      P.push(box(0.05, 0.06, 0.045, -0.1, 0.115, 0, S));
      P.push(box(0.03, 0.03, 0.03, -0.1, 0.17, 0, dark));
      P.push(box(0.09, 0.006, 0.07, -0.18, 0.055, 0, dark));
      break;
    }
    case 'carrier': {
      const deck: [number, number][] = [
        [-0.5, -0.1],
        [0.32, -0.1],
        [0.5, -0.03],
        [0.5, 0.06],
        [0.2, 0.13],
        [-0.25, 0.14],
        [-0.5, 0.11],
      ];
      P.push(prism(hullShape(0.14, 0.1), -0.03, 0.06, H));
      P.push(prism(deck, 0.06, 0.075, D));
      P.push(prism(hullShape(0.145, 0.1), -0.035, -0.005, T));
      // island on starboard
      P.push(box(0.12, 0.07, 0.035, -0.05, 0.075, -0.08, S));
      P.push(box(0.06, 0.05, 0.03, -0.04, 0.145, -0.08, S));
      P.push(cyl(0.004, 0.006, 0.08, -0.04, 0.195, -0.08, dark, 4));
      // deck markings
      P.push(box(0.9, 0.002, 0.006, -0.02, 0.075, 0.02, 0xd8d8c8, -0.12));
      P.push(box(0.35, 0.002, 0.005, 0.25, 0.075, -0.02, 0xd8d8c8));
      // parked jets
      for (let i = 0; i < 5; i++) {
        const x = -0.4 + i * 0.07;
        P.push(prism([[x + 0.025, 0.09], [x - 0.02, 0.07], [x - 0.02, 0.11]], 0.075, 0.085, 0x50585e));
      }
      break;
    }
    case 'sub': {
      P.push(cyl(0.045, 0.045, 0.78, 0, -0.01, 0, 0x22272b, 8, 'x'));
      const nose = new THREE.SphereGeometry(0.045, 8, 6).scale(1.6, 1, 1).translate(0.39, -0.01, 0);
      P.push([nose, 0x22272b]);
      P.push(cyl(0.015, 0.045, 0.14, -0.46, -0.01, 0, 0x22272b, 8, 'x'));
      P.push(box(0.1, 0.07, 0.025, 0.12, 0.02, 0, 0x2b3136));
      P.push(box(0.05, 0.004, 0.11, 0.12, 0.07, 0, 0x2b3136));
      P.push(box(0.04, 0.06, 0.004, -0.5, -0.03, 0, 0x2b3136));
      P.push(box(0.04, 0.004, 0.09, -0.5, -0.01, 0, 0x2b3136));
      if (u) P.push(box(0.01, 0.01, 0.026, 0.15, 0.07, 0, 0x8a2f2a));
      break;
    }
    case 'merchant': {
      P.push(prism(hullShape(0.17, 0.25, 1), -0.03, 0.06, 0x23262b));
      P.push(prism(hullShape(0.175, 0.25, 1), -0.035, 0.0, 0x8a3226));
      P.push(prism(hullShape(0.16, 0.25, 1), 0.06, 0.065, 0x6b2d25));
      P.push(box(0.1, 0.11, 0.15, -0.38, 0.065, 0, 0xf0efe8));
      P.push(box(0.03, 0.02, 0.16, -0.36, 0.175, 0, 0x2a2f33));
      P.push(box(0.03, 0.05, 0.03, -0.43, 0.175, 0, 0xc9442f));
      const colors = [0xc44a2a, 0x2f6fb4, 0xe0a030, 0x3d8a52, 0xd2d2c8, 0x8f4ab4];
      let k = 0;
      for (let x = -0.26; x < 0.28; x += 0.1) {
        for (const z of [-0.045, 0.0, 0.045]) {
          const hgt = 1 + ((k * 7) % 3);
          for (let y = 0; y < hgt; y++) P.push(box(0.09, 0.03, 0.04, x, 0.065 + y * 0.03, z, colors[(k * 5 + y * 3) % colors.length]));
          k++;
        }
      }
      break;
    }
    case 'lander': {
      P.push(prism([[-0.5, -0.2], [0.4, -0.2], [0.5, -0.12], [0.5, 0.12], [0.4, 0.2], [-0.5, 0.2]], -0.05, 0.1, 0x59646b));
      P.push(box(0.75, 0.02, 0.32, 0.0, 0.1, 0, 0x3e464c));
      P.push(box(0.2, 0.14, 0.36, -0.38, 0.1, 0, 0x6f7a80));
      P.push(box(0.08, 0.04, 0.3, 0.42, 0.1, 0, 0x4b555b));
      break;
    }
    case 'infantry':
    case 'coastal':
    case 'sam': {
      const v = pal.vehicle;
      const vd = new THREE.Color(v).multiplyScalar(0.7).getHex();
      const spots: [number, number][] = [
        [0.18, 0],
        [-0.12, -0.2],
        [-0.12, 0.2],
      ];
      for (const [x, z] of spots) {
        if (type === 'infantry') {
          P.push(box(0.2, 0.06, 0.11, x, 0, z, v));
          P.push(box(0.12, 0.035, 0.09, x - 0.02, 0.06, z, vd));
          P.push(box(0.07, 0.03, 0.05, x + 0.02, 0.095, z, v));
          P.push(cyl(0.006, 0.006, 0.08, x + 0.09, 0.11, z, 0x2a2a2a, 4, 'x'));
          // dismounts
          for (let i = 0; i < 3; i++) P.push(box(0.012, 0.03, 0.012, x - 0.13 - i * 0.03, 0, z + 0.06 - i * 0.02, 0x3a3f33));
        } else if (type === 'coastal') {
          P.push(box(0.26, 0.05, 0.09, x, 0, z, v));
          P.push(box(0.06, 0.06, 0.085, x + 0.1, 0.03, z, vd));
          const tubes = new THREE.BoxGeometry(0.18, 0.04, 0.08);
          tubes.rotateZ(0.35);
          tubes.translate(x - 0.03, 0.11, z);
          P.push([tubes, 0x4a5246]);
        } else {
          P.push(box(0.24, 0.05, 0.1, x, 0, z, v));
          P.push(box(0.06, 0.06, 0.09, x + 0.09, 0.03, z, vd));
          const can = new THREE.BoxGeometry(0.15, 0.07, 0.09);
          can.rotateZ(0.9);
          can.translate(x - 0.04, 0.13, z);
          P.push([can, 0x5d6658]);
        }
      }
      if (type === 'sam' || type === 'coastal') {
        P.push(box(0.12, 0.05, 0.1, 0.05, 0, 0.42, v));
        P.push(box(0.012, 0.09, 0.08, 0.05, 0.08, 0.42, 0xe8e8e0));
      }
      break;
    }
    case 'fighter':
    case 'strike':
    case 'recon': {
      const body = type === 'recon' ? 0x9aa3a8 : u ? 0x8e989f : 0x7d878e;
      const wingC = new THREE.Color(body).multiplyScalar(0.85).getHex();
      const plane = (ox: number, oz: number) => {
        P.push(prism([[0.5 + ox, oz], [0.2 + ox, -0.05 + oz], [-0.45 + ox, -0.05 + oz], [-0.45 + ox, 0.05 + oz], [0.2 + ox, 0.05 + oz]], -0.03, 0.04, body));
        if (type === 'recon') {
          P.push(prism([[0.12 + ox, -0.5 + oz], [0.2 + ox, -0.5 + oz], [0.2 + ox, 0.5 + oz], [0.12 + ox, 0.5 + oz]], -0.005, 0.01, wingC));
          P.push(cyl(0.16, 0.16, 0.03, -0.05 + ox, 0.08, oz, 0xdad8cc, 10));
          P.push(box(0.12, 0.08, 0.3, -0.42 + ox, 0, oz, wingC));
        } else {
          const span = type === 'fighter' ? 0.4 : 0.36;
          P.push(prism([[0.15 + ox, oz], [-0.2 + ox, -span + oz], [-0.3 + ox, -span + oz], [-0.25 + ox, oz], [-0.3 + ox, span + oz], [-0.2 + ox, span + oz]], -0.005, 0.01, wingC));
          P.push(prism([[-0.3 + ox, oz], [-0.45 + ox, -0.16 + oz], [-0.5 + ox, -0.16 + oz], [-0.48 + ox, oz], [-0.5 + ox, 0.16 + oz], [-0.45 + ox, 0.16 + oz]], -0.005, 0.01, wingC));
          P.push(box(0.12, 0.1, 0.01, -0.42 + ox, 0.02, -0.05 + oz, wingC));
          P.push(box(0.12, 0.1, 0.01, -0.42 + ox, 0.02, 0.05 + oz, wingC));
          P.push(box(0.12, 0.025, 0.05, 0.25 + ox, 0.03, oz, 0x223344));
        }
      };
      if (type === 'recon') plane(0, 0);
      else {
        plane(0.2, 0);
        plane(-0.45, 0.75);
      }
      break;
    }
  }
  const g = finalize(P, 1);
  cache.set(key, g);
  return g;
}

export interface UnitModel {
  root: THREE.Group;
  body: THREE.Mesh;
  radar?: THREE.Object3D;
  baseLen: number;
}

export function makeUnitModel(type: UnitType, faction: Faction, pal: Palette): UnitModel {
  const root = new THREE.Group();
  const geo = unitGeometry(type, faction, pal);
  const body = new THREE.Mesh(geo, MAT);
  body.castShadow = true;
  body.receiveShadow = false;
  const len = VIS_LEN[type];
  body.scale.setScalar(len);
  root.add(body);
  let radar: THREE.Object3D | undefined;
  if (type === 'destroyer' || type === 'battleship' || type === 'carrier') {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.07), MAT_DARK);
    const holder = new THREE.Group();
    holder.add(r);
    const y = type === 'destroyer' ? 0.29 : type === 'battleship' ? 0.34 : 0.24;
    const x = type === 'carrier' ? -0.04 : 0.03;
    const z = type === 'carrier' ? -0.08 : 0;
    holder.position.set(x * len, y * len, z * len);
    holder.scale.setScalar(len);
    root.add(holder);
    radar = holder;
  }
  return { root, body, radar, baseLen: len };
}

const MAT_DARK = new THREE.MeshLambertMaterial({ color: 0x2a2f33, flatShading: true });

export function makeFlag(color: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(0.07, 0.04);
  g.translate(0.035, 0, 0);
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  return new THREE.Mesh(g, m);
}

export interface SiteModel {
  root: THREE.Group;
  flag: THREE.Mesh;
  spinner?: THREE.Object3D;
}

/** Buildings are placed on the terrain at the site location; `toWater` points to the dock. */
export function makeSiteModel(type: BuildingType, pal: Palette, toWater: number): SiteModel {
  const P: Part[] = [];
  const conc = 0xb8b4a8;
  const concD = 0x8f8b80;
  const roof = 0x6f7a72;
  const dark = 0x30363a;
  let spinner: THREE.Object3D | undefined;
  switch (type) {
    case 'hq':
      P.push(box(0.5, 0.012, 0.5, 0, 0, 0, concD));
      P.push(box(0.32, 0.12, 0.26, 0, 0.012, 0, conc));
      P.push(box(0.22, 0.07, 0.18, -0.02, 0.13, 0, roof));
      P.push(cyl(0.006, 0.01, 0.35, 0.12, 0.13, 0.08, dark, 4));
      P.push(box(0.06, 0.04, 0.06, 0.1, 0.012, -0.18, 0x4c5a4a));
      P.push(cyl(0.05, 0.05, 0.02, -0.15, 0.13, -0.06, 0xdedbd0, 10));
      break;
    case 'navalbase':
    case 'dockyard': {
      P.push(box(0.6, 0.012, 0.5, 0, 0, 0, concD));
      P.push(box(0.26, 0.1, 0.16, -0.12, 0.012, -0.12, roof));
      P.push(box(0.2, 0.08, 0.14, -0.12, 0.012, 0.12, 0x8a8f86));
      // piers toward the water (local +x)
      for (const z of [-0.12, 0.12]) P.push(box(0.9, 0.025, 0.05, 0.6, -0.02, z, conc));
      // crane
      P.push(box(0.04, 0.32, 0.04, 0.25, 0.012, 0.0, 0xd2a03a));
      P.push(box(0.4, 0.03, 0.03, 0.38, 0.32, 0.0, 0xd2a03a));
      if (type === 'navalbase') P.push(cyl(0.05, 0.05, 0.12, -0.22, 0.012, 0.0, 0x9aa2a6, 8));
      break;
    }
    case 'airbase':
      P.push(box(1.6, 0.008, 0.16, 0, 0, 0, 0x4a4d50));
      for (let i = -6; i <= 6; i++) P.push(box(0.06, 0.002, 0.012, i * 0.11, 0.008, 0, 0xe8e8e0));
      P.push(box(0.6, 0.006, 0.08, 0.1, 0, 0.2, 0x55585b));
      P.push(cyl(0.025, 0.03, 0.2, -0.2, 0.0, -0.22, conc, 6));
      P.push(box(0.08, 0.05, 0.08, -0.2, 0.2, -0.22, 0x2c4a5a));
      for (const x of [0.1, 0.3]) {
        const hg = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 8, 1, false, 0, Math.PI);
        hg.rotateZ(Math.PI / 2);
        hg.rotateY(Math.PI / 2);
        hg.translate(x, 0.0, -0.26);
        P.push([hg, 0x7c857d]);
      }
      break;
    case 'barracks':
      P.push(box(0.55, 0.01, 0.45, 0, 0, 0, concD));
      for (const z of [-0.13, 0, 0.13]) P.push(box(0.36, 0.06, 0.08, -0.05, 0.01, z, roof));
      P.push(box(0.12, 0.08, 0.12, 0.2, 0.01, 0.12, conc));
      P.push(cyl(0.004, 0.006, 0.25, 0.22, 0.01, -0.15, dark, 4));
      break;
    case 'radar':
      P.push(box(0.35, 0.01, 0.35, 0, 0, 0, concD));
      P.push(cyl(0.03, 0.07, 0.36, 0, 0.01, 0, 0x9ea4a6, 4));
      P.push(cyl(0.09, 0.09, 0.03, 0, 0.37, 0, conc, 8));
      P.push(box(0.14, 0.06, 0.12, 0.17, 0.01, 0.12, roof));
      {
        const sphere = new THREE.SphereGeometry(0.07, 8, 6).translate(-0.14, 0.08, -0.12);
        P.push([sphere, 0xecebe4]);
      }
      break;
    case 'battery':
      P.push(box(0.5, 0.01, 0.4, 0, 0, 0, concD));
      for (const z of [-0.12, 0.0, 0.12]) {
        const l = new THREE.BoxGeometry(0.22, 0.05, 0.07);
        l.rotateZ(0.5);
        l.translate(0.03, 0.08, z);
        P.push([l, 0x5d6658]);
        P.push(box(0.16, 0.03, 0.08, 0.0, 0.01, z, 0x4c5248));
      }
      P.push(box(0.1, 0.06, 0.1, -0.18, 0.01, 0.12, roof));
      P.push(box(0.012, 0.1, 0.09, -0.18, 0.07, 0.12, 0xe0e0d8));
      break;
    case 'resource': {
      P.push(box(0.5, 0.01, 0.45, 0, 0, 0, concD));
      const tank = pal.treeKind === 'pine' ? 'sphere' : 'cyl';
      for (const [x, z] of [
        [-0.12, -0.1],
        [0.06, -0.12],
        [-0.04, 0.1],
      ]) {
        if (tank === 'sphere') P.push([new THREE.SphereGeometry(0.07, 8, 6).translate(x, 0.09, z), 0xe5e3da]);
        else P.push(cyl(0.07, 0.07, 0.09, x, 0.01, z, 0xd9d6cc, 10));
      }
      // derrick
      P.push(cyl(0.005, 0.06, 0.36, 0.17, 0.01, 0.1, 0xb5452e, 4));
      P.push(box(0.2, 0.02, 0.02, 0.0, 0.04, 0.0, 0x777f80));
      // pipe to the dock
      P.push(box(0.6, 0.015, 0.015, 0.4, 0.01, 0.0, 0x666d70));
      break;
    }
  }
  const root = new THREE.Group();
  const SCALE = type === 'airbase' ? 1.0 : 0.95;
  const geo = finalize(P, SCALE);
  const mesh = new THREE.Mesh(geo, MAT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  root.rotation.y = -toWater;
  if (type === 'radar') {
    const dish = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.09, 0.22).translate(0.02, 0, 0), MAT_DARK);
    const holder = new THREE.Group();
    holder.add(dish);
    holder.position.set(0, 0.45 * SCALE, 0);
    holder.scale.setScalar(SCALE);
    root.add(holder);
    spinner = holder;
  }
  // Ownership flag.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.22, 4).translate(0, 0.11, 0), MAT_DARK);
  pole.position.set(-0.22 * SCALE, 0, -0.2 * SCALE);
  pole.scale.setScalar(SCALE);
  root.add(pole);
  const flag = makeFlag(0xdddddd);
  flag.position.set(-0.22 * SCALE, 0.2 * SCALE, -0.2 * SCALE);
  flag.scale.setScalar(SCALE);
  root.add(flag);
  return { root, flag, spinner };
}
