// Procedural archipelago with 4-fold rotational symmetry (fair for 2 or 4 players).
import { BuildingType, MAP_SIZE } from './defs';
import { Rng, fbm } from './rng';

export type Theme = 'desert' | 'jungle' | 'arctic';
export const THEMES: Theme[] = ['desert', 'jungle', 'arctic'];

export interface ThemeInfo {
  id: Theme;
  name: string;
  region: string;
  islandNames: string[];
  centerName: string;
  stormRate: number; // storms per minute
  fogRate: number; // fog banks per minute
  baseFog: number; // 0..1 global haze
}

export const THEME_INFO: Record<Theme, ThemeInfo> = {
  desert: {
    id: 'desert',
    name: 'Operation Sandglass',
    region: 'Strait of Hormuz / Eastern Mediterranean',
    islandNames: ['KHARG', 'ABU MUSA', 'FARSI', 'TUNB', 'SIRRI', 'LAVAN', 'HENGAM', 'LARAK', 'KISH', 'HORMUZ', 'DAS', 'ZIRKU', 'ARZANA', 'DALMA', 'SIR BANI', 'HALUL', 'KYTHIRA', 'GAVDOS', 'ANTIKYTH', 'KASOS'],
    centerName: 'QESHM',
    stormRate: 0.35,
    fogRate: 0.15,
    baseFog: 0.08,
  },
  jungle: {
    id: 'jungle',
    name: 'Operation Monsoon',
    region: 'Spratly Islands / South China Sea',
    islandNames: ['THITU', 'NAMYIT', 'SIN COWE', 'MISCHIEF', 'FIERY CROSS', 'SUBI', 'SWALLOW', 'LOAITA', 'WEST YORK', 'GAVEN', 'SAND CAY', 'NORTHEAST', 'SOUTHWEST', 'AMBOYNA', 'COMMODORE', 'JOHNSON', 'HUGHES', 'CUARTERON', 'LANKIAM', 'SECOND THOMAS'],
    centerName: 'ITU ABA',
    stormRate: 0.7,
    fogRate: 0.2,
    baseFog: 0.12,
  },
  arctic: {
    id: 'arctic',
    name: 'Operation Williwaw',
    region: 'Aleutian Islands / Bering Sea',
    islandNames: ['ATTU', 'KISKA', 'ATKA', 'AMCHITKA', 'TANAGA', 'SHEMYA', 'AGATTU', 'KANAGA', 'UMNAK', 'SEGUAM', 'AMLIA', 'BULDIR', 'GARELOI', 'ULAK', 'SEMICHI', 'RAT', 'LITTLE SITKIN', 'GREAT SITKIN', 'YUNASKA', 'CHUGINADAK'],
    centerName: 'ADAK',
    stormRate: 0.55,
    fogRate: 0.7,
    baseFog: 0.25,
  },
};

export interface Island {
  id: number;
  name: string;
  x: number;
  y: number;
  r: number;
  home: number; // player slot or -1
  /** Buildings on a neutral island. */
  roles?: BuildingType[];
  /** Small uninhabited islet (no buildings, no label); shapes straits and chokepoints. */
  minor?: boolean;
}

export interface Site {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  island: number;
  home: number; // slot or -1
  /** Navigable water point next to the site (ports, resources). */
  dock: { x: number; y: number } | null;
}

export interface GameMap {
  seed: number;
  theme: Theme;
  size: number;
  /** Height samples per km. */
  hres: number;
  hn: number;
  height: Float32Array;
  /** Navigation grid. */
  cell: number;
  nn: number;
  /** 0 = deep water (ships), 1 = land, 2 = coastal shallows (landing craft only). */
  nav: Uint8Array;
  /** Island id per nav cell (land only), -1 otherwise. */
  islandOf: Int16Array;
  islands: Island[];
  sites: Site[];
  spawns: { x: number; y: number; island: number }[];
}

/** A capsule (segment with radius) in an island's canonical frame; unions of these make peninsulas and bays. */
interface Lobe {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

interface IslandSpec {
  x: number;
  y: number;
  r: number;
  rot: number; // quarter turns
  seed: number;
  peak: number;
  lobes: Lobe[];
  warp: number;
}

const C = MAP_SIZE / 2;

function rotQ(x: number, y: number, k: number): [number, number] {
  // Rotate (x,y) around the map centre by k quarter turns.
  let dx = x - C;
  let dy = y - C;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
    const t = dx;
    dx = -dy;
    dy = t;
  }
  return [C + dx, C + dy];
}

function segDist(px: number, py: number, l: Lobe): number {
  const vx = l.bx - l.ax;
  const vy = l.by - l.ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - l.ax) * vx + (py - l.ay) * vy) / len2)) : 0;
  return Math.hypot(px - (l.ax + vx * t), py - (l.ay + vy * t));
}

/** Smooth maximum: blends lobes together without creases. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** Shape field in the island's own frame: > 0 on land, < 0 at sea. */
function shapeField(s: IslandSpec, dx: number, dy: number): number {
  // Domain warp bends straight edges into coves and headlands.
  const w = s.warp * s.r;
  const wx = dx + (fbm(dx * 0.16 + 3.1, dy * 0.16, s.seed + 41, 3) - 0.5) * w;
  const wy = dy + (fbm(dx * 0.16, dy * 0.16 + 7.7, s.seed + 59, 3) - 0.5) * w;
  let f = -10;
  for (const l of s.lobes) f = smax(f, 1 - segDist(wx, wy, l) / l.r, 0.35);
  // Rugged coastline detail at two scales.
  f += (fbm(dx * 0.55 + 20, dy * 0.55 + 20, s.seed + 3, 4) - 0.5) * 0.3;
  f += (fbm(dx * 1.6 + 5, dy * 1.6 + 5, s.seed + 9, 2) - 0.5) * 0.1;
  return f;
}

function rot90(x: number, y: number, k: number): [number, number] {
  for (let i = 0; i < k; i++) {
    const t = x;
    x = -y;
    y = t;
  }
  return [x, y];
}

function islandHeight(s: IslandSpec, x: number, y: number): number {
  // Undo this copy's rotation so all four copies share one canonical shape.
  const [dx, dy] = rot90(x - s.x, y - s.y, (4 - s.rot) % 4);
  if (Math.hypot(dx, dy) > s.r * 3.2) return -1;
  const t = shapeField(s, dx, dy);
  if (t > 0) {
    // Ridged noise raises mountain spines; valleys stay low.
    const ridge = 1 - Math.abs(fbm(dx * 0.22 + 70, dy * 0.22 + 70, s.seed + 13, 3) * 2 - 1);
    return Math.pow(t, 0.8) * s.peak * (0.55 + 0.75 * ridge) + 0.004;
  }
  return t * 0.6; // continental shelf slope into deep water
}

/** Random capsules: a core plus arms that become peninsulas, with bays between them. */
function makeLobes(rng: Rng, r: number, arms: number, armLen: number, stretch: number): Lobe[] {
  const a = rng.range(0, Math.PI * 2);
  const half = r * 0.45 * stretch;
  const lobes: Lobe[] = [{ ax: -Math.cos(a) * half, ay: -Math.sin(a) * half, bx: Math.cos(a) * half, by: Math.sin(a) * half, r: r * 0.62 }];
  for (let i = 0; i < arms; i++) {
    const b = a + rng.range(-Math.PI, Math.PI);
    const sx = Math.cos(a) * rng.range(-half, half);
    const sy = Math.sin(a) * rng.range(-half, half);
    const len = r * rng.range(0.5, armLen);
    lobes.push({ ax: sx, ay: sy, bx: sx + Math.cos(b) * len, by: sy + Math.sin(b) * len, r: r * rng.range(0.22, 0.4) });
  }
  return lobes;
}

export function generateMap(seed: number, theme: Theme): GameMap {
  const rng = new Rng(seed);
  const info = THEME_INFO[theme];
  const specs: IslandSpec[] = [];
  const islands: Island[] = [];
  const names = info.islandNames.slice();
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const peakScale = theme === 'arctic' ? 1.6 : theme === 'jungle' ? 1.1 : 0.8;

  // Centre: one big organic island.
  specs.push({ x: C, y: C, r: 10.5, rot: 0, seed: seed + 11, peak: 0.55 * peakScale, lobes: makeLobes(rng, 10.5, 4, 0.85, 1.1), warp: 0.45 });
  islands.push({ id: 0, name: info.centerName, x: C, y: C, r: 10.5, home: -1 });

  // Home islands: one shape, rotated into the four corners, so every start is identical.
  const homeOff = 26.5;
  const homeLobes = makeLobes(rng, 5.6, 2, 0.9, 1.0);
  const placed: { x: number; y: number; r: number }[] = [{ x: C, y: C, r: 10.5 * 1.4 }];
  for (let k = 0; k < 4; k++) {
    const [x, y] = rotQ(C + homeOff, C + homeOff, k);
    specs.push({ x, y, r: 5.6, rot: k, seed: seed + 21, peak: 0.45 * peakScale, lobes: homeLobes, warp: 0.5 });
    islands.push({ id: islands.length, name: `HOME ${k + 1}`, x, y, r: 5.6, home: k });
    placed.push({ x, y, r: 5.6 * 1.3 });
  }
  const free = (x: number, y: number, r: number, gap: number) => {
    if (x < r + 2 || y < r + 2 || x > MAP_SIZE - r - 2 || y > MAP_SIZE - r - 2) return false;
    for (const q of placed) if (Math.hypot(q.x - x, q.y - y) < q.r + r * 1.3 + gap) return false;
    return true;
  };

  // Neutral islands: drawn separately for each quarter, so the map is uneven (different routes,
  // straits and chokepoints) while every quarter still holds the same mix of buildings.
  const roleSets: BuildingType[][] = [
    ['resource', 'battery'],
    ['resource', 'radar'],
    ['resource', 'dockyard'],
    ['airbase', 'barracks'],
  ];
  let nameIdx = 0;
  for (let k = 0; k < 4; k++) {
    const base = (k * Math.PI) / 2;
    for (const roles of roleSets) {
      for (let t = 0; t < 600; t++) {
        const a = base + rng.range(-0.25, Math.PI / 2 + 0.25);
        const dist = rng.range(15, 37);
        const r = rng.range(2.2, 4.4);
        const x = C + Math.cos(a) * dist;
        const y = C + Math.sin(a) * dist;
        if (!free(x, y, r, 3.2)) continue;
        specs.push({ x, y, r, rot: 0, seed: seed + 100 + islands.length * 13, peak: rng.range(0.25, 0.5) * peakScale, lobes: makeLobes(rng, r, rng.int(1, 3), 1.1, rng.range(0.6, 1.6)), warp: rng.range(0.5, 0.9) });
        islands.push({ id: islands.length, name: names[nameIdx++ % names.length], x, y, r, home: -1, roles });
        placed.push({ x, y, r: r * 1.4 });
        break;
      }
    }
  }

  // Islet chains: rocky strings of small islands that funnel ships through straits.
  const chains = rng.int(4, 6);
  for (let c = 0; c < chains; c++) {
    // Start each chain in open water.
    let x = 0;
    let y = 0;
    for (let t = 0; t < 60; t++) {
      x = rng.range(8, MAP_SIZE - 8);
      y = rng.range(8, MAP_SIZE - 8);
      if (free(x, y, 1.5, 2.2)) break;
    }
    let dir = rng.range(0, Math.PI * 2);
    const n = rng.int(4, 6);
    for (let i = 0; i < n; i++) {
      const r = rng.range(0.9, 1.9);
      if (free(x, y, r, 2.2)) {
        specs.push({ x, y, r, rot: 0, seed: seed + 500 + islands.length * 7, peak: rng.range(0.2, 0.45) * peakScale, lobes: makeLobes(rng, r, rng.int(0, 2), 1.2, rng.range(0.8, 1.8)), warp: 0.7 });
        islands.push({ id: islands.length, name: '', x, y, r, home: -1, minor: true });
        placed.push({ x, y, r: r * 1.3 });
      }
      // Gaps of a few km between links make navigable but narrow channels.
      dir += rng.range(-0.5, 0.5);
      const step = rng.range(3.6, 5.2);
      x += Math.cos(dir) * step;
      y += Math.sin(dir) * step;
    }
  }

  // Heightmap.
  const hres = 4;
  const hn = MAP_SIZE * hres + 1;
  const height = new Float32Array(hn * hn).fill(-1);
  for (const s of specs) {
    const reach = s.r * 3.2;
    const x0 = Math.max(0, Math.floor((s.x - reach) * hres));
    const x1 = Math.min(hn - 1, Math.ceil((s.x + reach) * hres));
    const y0 = Math.max(0, Math.floor((s.y - reach) * hres));
    const y1 = Math.min(hn - 1, Math.ceil((s.y + reach) * hres));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const h = islandHeight(s, i / hres, j / hres);
        const idx = j * hn + i;
        if (h > height[idx]) height[idx] = h;
      }
    }
  }
  // Seabed undulation for nicer water colour (does not change coastlines).
  for (let j = 0; j < hn; j++) {
    for (let i = 0; i < hn; i++) {
      const idx = j * hn + i;
      if (height[idx] < -0.05) height[idx] = Math.min(-0.05, height[idx] + (fbm(i * 0.02, j * 0.02, seed + 999, 3) - 0.5) * 0.4);
    }
  }

  const map: GameMap = {
    seed,
    theme,
    size: MAP_SIZE,
    hres,
    hn,
    height,
    cell: 0.5,
    nn: MAP_SIZE * 2,
    nav: new Uint8Array(MAP_SIZE * 2 * MAP_SIZE * 2),
    islandOf: new Int16Array(MAP_SIZE * 2 * MAP_SIZE * 2).fill(-1),
    islands,
    sites: [],
    spawns: [],
  };

  // Navigation grid.
  const nn = map.nn;
  for (let j = 0; j < nn; j++) {
    for (let i = 0; i < nn; i++) {
      const cx = (i + 0.5) * map.cell;
      const cy = (j + 0.5) * map.cell;
      const hc = heightAt(map, cx, cy);
      let maxH = hc;
      for (const [ox, oy] of [
        [-0.3, 0],
        [0.3, 0],
        [0, -0.3],
        [0, 0.3],
        [0.22, 0.22],
        [-0.22, 0.22],
        [0.22, -0.22],
        [-0.22, -0.22],
      ]) {
        maxH = Math.max(maxH, heightAt(map, cx + ox, cy + oy));
      }
      map.nav[j * nn + i] = hc > 0 ? 1 : maxH < -0.015 ? 0 : 2;
    }
  }
  // Islands = connected land regions (4-neighbour). Each island keeps its largest region near its
  // centre; stray islets get no id, so nothing is ever placed where troops cannot walk.
  const comp = new Int32Array(nn * nn).fill(-1);
  const comps: { size: number; sx: number; sy: number }[] = [];
  const stack: number[] = [];
  for (let c0 = 0; c0 < nn * nn; c0++) {
    if (map.nav[c0] !== 1 || comp[c0] >= 0) continue;
    const id = comps.length;
    const info = { size: 0, sx: 0, sy: 0 };
    comps.push(info);
    comp[c0] = id;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!;
      const ci = c % nn;
      const cj = (c - ci) / nn;
      info.size++;
      info.sx += ci;
      info.sy += cj;
      for (const [ni, nj] of [
        [ci + 1, cj],
        [ci - 1, cj],
        [ci, cj + 1],
        [ci, cj - 1],
      ]) {
        if (ni < 0 || nj < 0 || ni >= nn || nj >= nn) continue;
        const k = nj * nn + ni;
        if (map.nav[k] === 1 && comp[k] < 0) {
          comp[k] = id;
          stack.push(k);
        }
      }
    }
  }
  const owner = new Int32Array(comps.length).fill(-1);
  for (const isl of islands) {
    let best = -1;
    let bestSize = 0;
    comps.forEach((cp, id) => {
      const cx = (cp.sx / cp.size + 0.5) * map.cell;
      const cy = (cp.sy / cp.size + 0.5) * map.cell;
      if (Math.hypot(cx - isl.x, cy - isl.y) > isl.r * 1.8 + 2) return;
      if (owner[id] >= 0 || cp.size <= bestSize) return;
      best = id;
      bestSize = cp.size;
    });
    if (best >= 0) owner[best] = isl.id;
  }
  for (let c = 0; c < nn * nn; c++) if (comp[c] >= 0) map.islandOf[c] = owner[comp[c]];

  placeSites(map, rng);
  fixDocks(map);
  return map;
}

export function heightAt(map: GameMap, x: number, y: number): number {
  const fx = Math.max(0, Math.min(map.hn - 1.001, x * map.hres));
  const fy = Math.max(0, Math.min(map.hn - 1.001, y * map.hres));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const n = map.hn;
  const h = map.height;
  const a = h[j * n + i];
  const b = h[j * n + i + 1];
  const c = h[(j + 1) * n + i];
  const d = h[(j + 1) * n + i + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export function cellOf(map: GameMap, x: number, y: number): number {
  const i = Math.max(0, Math.min(map.nn - 1, Math.floor(x / map.cell)));
  const j = Math.max(0, Math.min(map.nn - 1, Math.floor(y / map.cell)));
  return j * map.nn + i;
}
export function cellCenter(map: GameMap, c: number): [number, number] {
  return [((c % map.nn) + 0.5) * map.cell, (Math.floor(c / map.nn) + 0.5) * map.cell];
}
export function isLand(map: GameMap, x: number, y: number): boolean {
  return heightAt(map, x, y) > 0;
}
export function islandAt(map: GameMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.size || y >= map.size) return -1;
  return map.islandOf[cellOf(map, x, y)];
}
export function isNavigable(map: GameMap, x: number, y: number): boolean {
  if (x < 0.5 || y < 0.5 || x > map.size - 0.5 || y > map.size - 0.5) return false;
  return map.nav[cellOf(map, x, y)] === 0;
}

/** Nearest cell matching pred, searching rings outward (max radius in cells). */
export function nearestCell(map: GameMap, x: number, y: number, pred: (c: number) => boolean, maxR = 60): number {
  const nn = map.nn;
  const ci = Math.max(0, Math.min(nn - 1, Math.floor(x / map.cell)));
  const cj = Math.max(0, Math.min(nn - 1, Math.floor(y / map.cell)));
  if (pred(cj * nn + ci)) return cj * nn + ci;
  let best = -1;
  let bd = 1e9;
  for (let r = 1; r <= maxR; r++) {
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= nn) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= nn) continue;
        if (Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
        const c = j * nn + i;
        if (!pred(c)) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
    }
    if (best >= 0 && r * r > bd) break;
  }
  return best;
}

/** Label each deep-water cell with its connected region; returns labels and the largest region id. */
export function seaRegions(map: GameMap): { label: Int32Array; main: number } {
  const nn = map.nn;
  const label = new Int32Array(nn * nn).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let c0 = 0; c0 < nn * nn; c0++) {
    if (map.nav[c0] !== 0 || label[c0] >= 0) continue;
    const id = sizes.length;
    sizes.push(0);
    label[c0] = id;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!;
      sizes[id]++;
      const ci = c % nn;
      const cj = (c - ci) / nn;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ni = ci + di;
          const nj = cj + dj;
          if ((!di && !dj) || ni < 0 || nj < 0 || ni >= nn || nj >= nn) continue;
          const k = nj * nn + ni;
          // Diagonal moves need both side cells open, as in findPath.
          if (di && dj && (map.nav[cj * nn + ni] !== 0 || map.nav[nj * nn + ci] !== 0)) continue;
          if (map.nav[k] === 0 && label[k] < 0) {
            label[k] = id;
            stack.push(k);
          }
        }
    }
  }
  let main = 0;
  sizes.forEach((sz, i) => {
    if (sz > sizes[main]) main = i;
  });
  return { label, main };
}

/** Ports and resource docks must sit on the open sea, not in a lagoon cut off by islets. */
function fixDocks(map: GameMap) {
  const { label, main } = seaRegions(map);
  for (const st of map.sites) {
    if (!st.dock) continue;
    if (label[cellOf(map, st.dock.x, st.dock.y)] === main) continue;
    const c = nearestCell(map, st.x, st.y, (k) => label[k] === main, 40);
    if (c >= 0) {
      const [x, y] = cellCenter(map, c);
      st.dock = { x, y };
    }
  }
}

function distToWater(map: GameMap, x: number, y: number): number {
  const c = nearestCell(map, x, y, (k) => map.nav[k] !== 1, 20);
  if (c < 0) return 99;
  const [wx, wy] = cellCenter(map, c);
  return Math.hypot(wx - x, wy - y);
}

function placeSites(map: GameMap, rng: Rng) {
  const sites = map.sites;
  const add = (type: BuildingType, x: number, y: number, island: number, home: number, needDock: boolean) => {
    let dock: { x: number; y: number } | null = null;
    if (needDock) {
      const c = nearestCell(map, x, y, (k) => map.nav[k] === 0, 30);
      if (c >= 0) {
        const [dx, dy] = cellCenter(map, c);
        dock = { x: dx, y: dy };
      }
    }
    sites.push({ id: sites.length, type, x, y, island, home, dock });
  };

  // Find a land point on an island; coast=true prefers near the shore.
  const findSpot = (
    isl: Island,
    want: (x: number, y: number) => number,
    avoid: { x: number; y: number }[],
    coastal: boolean,
    minSep = 1.8,
  ): [number, number] => {
    let best: [number, number] = [isl.x, isl.y];
    let bestScore = -1e9;
    for (let t = 0; t < 260; t++) {
      const [ox, oy] = rng.inDisc(isl.r * 1.9);
      const x = isl.x + ox;
      const y = isl.y + oy;
      if (islandAt(map, x, y) !== isl.id || heightAt(map, x, y) < 0.01) continue;
      let ok = true;
      for (const a of avoid) if (Math.hypot(a.x - x, a.y - y) < minSep) ok = false;
      if (!ok) continue;
      const dw = distToWater(map, x, y);
      let score = want(x, y);
      if (coastal) score -= Math.abs(dw - 0.7) * 4;
      else score -= Math.max(0, 0.9 - dw) * 6;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    return best;
  };

  for (const isl of map.islands) {
    const placed: { x: number; y: number }[] = [];
    const put = (type: BuildingType, coastal: boolean, want: (x: number, y: number) => number, home = -1) => {
      const [x, y] = findSpot(isl, want, placed, coastal);
      placed.push({ x, y });
      add(type, x, y, isl.id, home, type === 'navalbase' || type === 'dockyard' || type === 'resource');
      return [x, y];
    };
    const towardCenter = (x: number, y: number) => -Math.hypot(x - C, y - C) * 0.3;
    const centrality = (x: number, y: number) => -Math.hypot(x - isl.x, y - isl.y);
    if (isl.home >= 0) {
      put('hq', false, centrality, isl.home);
      put('navalbase', true, towardCenter, isl.home);
      put('airbase', false, (x, y) => -Math.abs(Math.hypot(x - isl.x, y - isl.y) - isl.r * 0.45), isl.home);
      put('barracks', false, (x, y) => -Math.abs(Math.hypot(x - isl.x, y - isl.y) - isl.r * 0.4), isl.home);
      put('resource', true, (x, y) => Math.hypot(x - C, y - C) * 0.1, isl.home);
      map.spawns[isl.home] = { x: isl.x, y: isl.y, island: isl.id };
    } else if (isl.id === 0) {
      for (let k = 0; k < 4; k++) {
        const ang = Math.PI / 4 + (k * Math.PI) / 2;
        put('resource', true, (x, y) => -Math.hypot(x - (C + Math.cos(ang) * 9), y - (C + Math.sin(ang) * 9)));
      }
      put('radar', false, centrality);
      put('airbase', false, (x, y) => -Math.abs(Math.hypot(x - C, y - C) - 4));
      put('battery', true, (x, y) => -Math.hypot(x - (C + 7), y - C));
      put('battery', true, (x, y) => -Math.hypot(x - (C - 7), y - C));
      put('barracks', false, (x, y) => -Math.hypot(x - C, y - (C + 4)));
      put('dockyard', true, (x, y) => -Math.hypot(x - C, y - (C - 8)));
    }
  }
  for (const isl of map.islands) {
    if (!isl.roles) continue;
    const placed: { x: number; y: number }[] = [];
    for (const type of isl.roles) {
      const coastal = type === 'resource' || type === 'dockyard' || type === 'battery';
      const [x, y] = findSpot(isl, (px, py) => -Math.hypot(px - isl.x, py - isl.y) * 0.2, placed, coastal, 1.4);
      placed.push({ x, y });
      add(type, x, y, isl.id, -1, type === 'resource' || type === 'dockyard');
    }
  }
}

// ---------- Path finding ----------

class Heap {
  ids: number[] = [];
  f: number[] = [];
  push(id: number, f: number) {
    const a = this.ids;
    const b = this.f;
    a.push(id);
    b.push(f);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (b[p] <= b[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [b[p], b[i]] = [b[i], b[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.ids;
    const b = this.f;
    const top = a[0];
    const la = a.pop()!;
    const lb = b.pop()!;
    if (a.length) {
      a[0] = la;
      b[0] = lb;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && b[l] < b[m]) m = l;
        if (r < a.length && b[r] < b[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [b[m], b[i]] = [b[i], b[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.ids.length;
  }
}

export type Passable = (cell: number) => boolean;

/** True if a straight segment stays on passable cells. */
export function lineClear(map: GameMap, x0: number, y0: number, x1: number, y1: number, pass: Passable): boolean {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / (map.cell * 0.4)) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (x < 0 || y < 0 || x >= map.size || y >= map.size) return false;
    if (!pass(cellOf(map, x, y))) return false;
  }
  return true;
}

interface Scratch {
  g: Float32Array;
  came: Int32Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  gen: number;
}
const scratch = new WeakMap<GameMap, Scratch>();

/**
 * A* over the nav grid. Returns world-space waypoints (excluding start), or null.
 * The goal snaps to the nearest passable cell.
 */
export function findPath(map: GameMap, sx: number, sy: number, gx: number, gy: number, pass: Passable): { x: number; y: number }[] | null {
  if (lineClear(map, sx, sy, gx, gy, pass)) return [{ x: gx, y: gy }];
  const nn = map.nn;
  let sc = scratch.get(map);
  if (!sc) {
    const n = nn * nn;
    sc = { g: new Float32Array(n), came: new Int32Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), gen: 0 };
    scratch.set(map, sc);
  }
  const gen = ++sc.gen;
  const { g: gS, came, stamp, closed } = sc;
  let start = cellOf(map, sx, sy);
  if (!pass(start)) {
    start = nearestCell(map, sx, sy, pass, 8);
    if (start < 0) return null;
  }
  let goal = cellOf(map, gx, gy);
  let snapped = false;
  if (!pass(goal)) {
    goal = nearestCell(map, gx, gy, pass, 40);
    if (goal < 0) return null;
    snapped = true;
  }
  const [gcx, gcy] = cellCenter(map, goal);
  const gi = goal % nn;
  const gj = Math.floor(goal / nn);
  stamp[start] = gen;
  gS[start] = 0;
  const open = new Heap();
  const h = (c: number) => {
    const dx = Math.abs((c % nn) - gi);
    const dy = Math.abs(Math.floor(c / nn) - gj);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
  };
  open.push(start, h(start));
  let found = false;
  let iter = 0;
  // Enough budget to cross the whole map around islands (each cell is closed once).
  const maxIter = nn * nn * 2;
  while (open.size && iter++ < maxIter) {
    const cur = open.pop();
    if (cur === goal) {
      found = true;
      break;
    }
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    const ci = cur % nn;
    const cj = (cur - ci) / nn;
    const g0 = gS[cur];
    for (let dj = -1; dj <= 1; dj++) {
      const nj = cj + dj;
      if (nj < 0 || nj >= nn) continue;
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        if (ni < 0 || ni >= nn) continue;
        const nc = nj * nn + ni;
        if (closed[nc] === gen || !pass(nc)) continue;
        if (di && dj && (!pass(cj * nn + ni) || !pass(nj * nn + ci))) continue;
        const g = g0 + (di && dj ? 1.414 : 1);
        if (stamp[nc] === gen && gS[nc] <= g) continue;
        stamp[nc] = gen;
        gS[nc] = g;
        came[nc] = cur;
        open.push(nc, g + h(nc));
      }
    }
  }
  if (!found) return null;
  const cells: number[] = [];
  for (let c = goal; c !== start; c = came[c]) cells.push(c);
  cells.reverse();
  const pts = cells.map((c) => {
    const [x, y] = cellCenter(map, c);
    return { x, y };
  });
  if (!snapped && pts.length) pts[pts.length - 1] = { x: gx, y: gy };
  else if (pts.length) pts[pts.length - 1] = { x: gcx, y: gcy };
  // String pulling.
  const out: { x: number; y: number }[] = [];
  let ax = sx;
  let ay = sy;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineClear(map, ax, ay, pts[j].x, pts[j].y, pass)) j--;
    out.push(pts[j]);
    ax = pts[j].x;
    ay = pts[j].y;
    i = j + 1;
  }
  return out;
}
