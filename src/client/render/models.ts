// Procedural low-poly models for units and buildings. Built once per (type, faction, theatre) and cloned.
import * as THREE from 'three';
import type { Faction, UnitType, BuildingType } from '../../shared/defs';
import { mergeColored } from './terrain';
import type { Palette } from '../theme';
import { Part, box, cyl, hullShape, prism } from './parts';
import { RADAR_MOUNT, airParts, groundParts, shipParts } from './unitmodels';
import { patchMaterial } from './weatherfx';

function finalize(parts: Part[], scale: number): THREE.BufferGeometry {
  const g = mergeColored(parts);
  g.scale(scale, scale, scale);
  return g;
}

const cache = new Map<string, THREE.BufferGeometry>();
const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
patchMaterial(MAT);

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
  const P: Part[] = [];
  switch (type) {
    case 'destroyer':
    case 'battleship':
    case 'carrier':
    case 'sub':
      shipParts(P, type, faction);
      break;
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
    case 'sam':
      groundParts(P, type, faction, pal);
      break;
    case 'fighter':
    case 'strike':
    case 'recon':
      airParts(P, type, faction);
      break;
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
  const mount = RADAR_MOUNT[faction][type];
  if (mount) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(...mount.size), MAT_DARK);
    const holder = new THREE.Group();
    holder.add(r);
    holder.position.set(mount.at[0] * len, mount.at[1] * len, mount.at[2] * len);
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
