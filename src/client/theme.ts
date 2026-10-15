// Visual palettes per theatre and side colours for the symbol overlay.
import type { Theme } from '../shared/map';
import type { Faction } from '../shared/defs';

export interface Palette {
  sky: number;
  fog: number;
  deep: number;
  mid: number;
  shallow: number;
  foam: number;
  sand: number;
  low: number;
  high: number;
  rock: number;
  peak: number;
  tree: number;
  tree2: number;
  sun: number;
  sunI: number;
  amb: number;
  ground: number;
  vehicle: number;
  sunDir: [number, number, number];
  treeDensity: number;
  treeKind: 'palm' | 'scrub' | 'pine';
}

export const PALETTES: Record<Theme, Palette> = {
  desert: {
    sky: 0xe7d9b6,
    fog: 0xd9cba6,
    deep: 0x0e4560,
    mid: 0x16708a,
    shallow: 0x3ab3b0,
    foam: 0xf4f0e0,
    sand: 0xe2cf9a,
    low: 0xcdb27a,
    high: 0xb08a58,
    rock: 0x8e6d4a,
    peak: 0x7a5b3e,
    tree: 0x7b7f45,
    tree2: 0x5f6a3a,
    sun: 0xfff1d6,
    sunI: 2.4,
    amb: 0xb9c4cf,
    ground: 0x8b6a45,
    vehicle: 0xc2ab7c,
    sunDir: [-0.5, 1, -0.35],
    treeDensity: 0.25,
    treeKind: 'scrub',
  },
  jungle: {
    sky: 0xbcd6d6,
    fog: 0xaecfd0,
    deep: 0x07384d,
    mid: 0x0b6a7d,
    shallow: 0x1fc2b0,
    foam: 0xf6fbf6,
    sand: 0xf0e2b4,
    low: 0x4f8a3c,
    high: 0x2f6a2f,
    rock: 0x52624a,
    peak: 0x3d4c39,
    tree: 0x2e7a33,
    tree2: 0x1f5a28,
    sun: 0xfff8e6,
    sunI: 2.2,
    amb: 0xa8c8c8,
    ground: 0x3d5a2f,
    vehicle: 0x5f6e44,
    sunDir: [0.45, 1, -0.3],
    treeDensity: 1,
    treeKind: 'palm',
  },
  arctic: {
    sky: 0x9fb0ba,
    fog: 0x95a7b1,
    deep: 0x112a38,
    mid: 0x1d4656,
    shallow: 0x3f7a86,
    foam: 0xe6eef0,
    sand: 0x7f7e74,
    low: 0x6f7b62,
    high: 0x8f9483,
    rock: 0x6b6b6b,
    peak: 0xeef3f5,
    tree: 0x3f5243,
    tree2: 0x34453a,
    sun: 0xeef4ff,
    sunI: 2.1,
    amb: 0xb4c6d4,
    ground: 0x55605a,
    vehicle: 0xb9c0c2,
    sunDir: [0.3, 0.8, 0.5],
    treeDensity: 0.12,
    treeKind: 'pine',
  },
};

/** Overlay colours, relative to the viewer (APP-6 style). */
export const SIDE = {
  own: '#6fd0ff',
  ally: '#8dffb4',
  hostile: '#ff5d4f',
  unknown: '#ffd84a',
  neutral: '#d9dde0',
};

export const FACTION_STYLE: Record<Faction, { accent: string; hull: number; deck: number; superstructure: number; trim: number; emblem: string }> = {
  coalition: { accent: '#6fd0ff', hull: 0x8a949c, deck: 0x5b636a, superstructure: 0xaeb6bd, trim: 0x2d3338, emblem: '✦' },
  union: { accent: '#ff8a5c', hull: 0x7a8794, deck: 0x4c5660, superstructure: 0x9aa6b1, trim: 0x8a2f2a, emblem: '★' },
};

export const SHIP_NAMES: Record<Faction, string[]> = {
  coalition: ['HALSEY', 'DARING', 'FORBIN', 'TROMP', 'SACHSEN', 'NANSEN', 'ANZAC', 'HOBART', 'KONGO', 'SEJONG', 'ARLEIGH', 'DEFENDER', 'CHEVALIER', 'IOWA', 'FORD', 'VIRGINIA', 'SPRUANCE', 'DUNCAN', 'MAHAN', 'ZUMWALT', 'ARTEMIS', 'VALIANT'],
  union: ['NANCHANG', 'LHASA', 'ANSHAN', 'DALIAN', 'YANAN', 'ZUNYI', 'XIAMEN', 'KUNMING', 'HEFEI', 'JINAN', 'TAIYUAN', 'URUMQI', 'GUILIN', 'YINCHUAN', 'FUJIAN', 'SHANDONG', 'CHANGSHA', 'NANNING', 'XINING', 'BAOTOU', 'TANGSHAN', 'LIAONING'],
};

export function unitName(faction: Faction, type: string, id: number): string {
  if (type === 'destroyer' || type === 'battleship' || type === 'carrier' || type === 'sub') {
    const list = SHIP_NAMES[faction];
    const n = list[(id * 7 + type.length * 3) % list.length];
    return faction === 'coalition' ? n : n;
  }
  const n = ((id * 13) % 89) + 1;
  switch (type) {
    case 'infantry':
      return `${ordinal(n)} CO.`;
    case 'coastal':
      return `${ordinal(n)} CST BTY`;
    case 'sam':
      return `${ordinal(n)} ADA BTY`;
    case 'fighter':
      return faction === 'coalition' ? `VIPER ${n}` : `FALCON ${n}`;
    case 'strike':
      return faction === 'coalition' ? `HAMMER ${n}` : `THUNDER ${n}`;
    case 'recon':
      return faction === 'coalition' ? `OVERLORD ${n}` : `SKYEYE ${n}`;
    case 'merchant':
      return `MV ${['ATLAS', 'BOUNTY', 'CORAL', 'DAWN', 'EMBER', 'FORTUNE', 'GALE', 'HARBOR'][id % 8]}`;
    default:
      return `LCU ${n}`;
  }
}

function ordinal(n: number): string {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
