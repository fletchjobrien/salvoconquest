// Model check: every unit model and variant must be one connected piece. A part whose bounding box
// touches no other part floats (a mast above its deckhouse, missiles hanging below a wing).
// Battery vehicles stand apart on purpose, so only one vehicle is checked; each air flight is
// two jets, so only the lead jet is checked.
import * as THREE from 'three';
import { RADAR_MOUNT, airParts, groundParts, shipParts, type ShipType } from '../src/client/render/unitmodels';
import type { Part } from '../src/client/render/parts';
import { FACTIONS } from '../src/shared/defs';

const EPS = 0.0015;
const pal = { vehicle: 0x8a7d5a } as Parameters<typeof groundParts>[3];

function floating(P: Part[]): number {
  const boxes = P.map(([g]) => {
    g.computeBoundingBox();
    return g.boundingBox!.clone().expandByScalar(EPS);
  });
  const seen = new Array(boxes.length).fill(false);
  const stack = [0];
  seen[0] = true;
  while (stack.length) {
    const a = stack.pop()!;
    for (let j = 0; j < boxes.length; j++)
      if (!seen[j] && boxes[a].intersectsBox(boxes[j])) {
        seen[j] = true;
        stack.push(j);
      }
  }
  return seen.filter((s) => !s).length;
}

const centre = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 };
};

let bad = 0;
const report = (label: string, P: Part[]) => {
  const n = floating(P);
  if (n) {
    bad++;
    console.log(`FLOATING: ${label}: ${n} part(s) not attached`);
  }
};
const ships: ShipType[] = ['corvette', 'frigate', 'destroyer', 'cruiser', 'battleship', 'carrier', 'sub'];
for (const f of FACTIONS) {
  for (const t of ships)
    for (let v = 0; v < 3; v++) {
      const P: Part[] = [];
      shipParts(P, t, f, v);
      const m = RADAR_MOUNT[f][t];
      if (m) P.push([new THREE.BoxGeometry(...m.size).translate(...m.at), 0]);
      report(`${f} ${t} variant ${v}`, P);
    }
  for (const t of ['infantry', 'coastal', 'sam'] as const)
    for (let v = 0; v < 3; v++) {
      const P: Part[] = [];
      groundParts(P, t, f, pal, v);
      report(`${f} ${t} variant ${v}`, P.filter(([g]) => Math.hypot(centre(g).x - 0.18, centre(g).z) < 0.16));
    }
  for (const t of ['fighter', 'strike', 'recon'] as const)
    for (let v = 0; v < 3; v++) {
      const P: Part[] = [];
      airParts(P, t, f, v);
      report(`${f} ${t} variant ${v}`, t === 'recon' ? P : P.filter(([g]) => centre(g).z < 0.45));
    }
}
console.log(bad ? `${bad} model(s) with floating parts` : 'models: every part attached');
if (bad) process.exit(1);
