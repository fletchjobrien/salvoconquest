// Geometry parts for the procedural low-poly models. A part is a geometry plus a flat colour;
// all parts of a model are merged into one vertex-coloured mesh.
// Axes: +x is the bow (or nose), +y is up, z is the beam. Models are about 1 unit long.
import * as THREE from 'three';

export type Part = [THREE.BufferGeometry, number];

/** Box with its base at y. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, c: number, ry = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y + h / 2, z);
  return [g, c];
}

/** Box centred at (x, y, z), turned about x, then z, then y. */
export function boxR(w: number, h: number, d: number, x: number, y: number, z: number, c: number, rx = 0, ry = 0, rz = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return [g, c];
}

export function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, c: number, seg = 6, axis: 'y' | 'x' | 'z' = 'y'): Part {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y + (axis === 'y' ? h / 2 : 0), z);
  return [g, c];
}

/** Round tube centred at (x, y, z), along +x, then pitched up (nose high) and turned. */
export function tube(r: number, len: number, x: number, y: number, z: number, c: number, pitch = 0, yaw = 0, seg = 8, r2 = r): Part {
  const g = new THREE.CylinderGeometry(r2, r, len, seg);
  g.rotateZ(-Math.PI / 2);
  if (pitch) g.rotateZ(pitch);
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return [g, c];
}

/** Truncated pyramid: base w×d at y, top tw×td at y+h (sloped, stealthy superstructures). */
export function frustum(w: number, d: number, tw: number, td: number, h: number, x: number, y: number, z: number, c: number): Part {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? tw : w), top ? h : 0, p.getZ(i) * (top ? td : d));
  }
  g.translate(x, y, z);
  return [g, c];
}

/** Block whose top slopes from h0 (aft end) to h1 (fore end), optionally narrower at the fore end: ski jumps, glacis plates. */
export function ramp(len: number, w: number, h0: number, h1: number, x: number, y: number, z: number, c: number, foreW = 1): Part {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    const fore = p.getX(i) > 0;
    p.setXYZ(i, p.getX(i) * len, top ? (fore ? h1 : h0) : 0, p.getZ(i) * w * (fore ? foreW : 1));
  }
  g.translate(x, y, z);
  return [g, c];
}

/** Flat polygon panel (radar array face) of radius r, facing along `yaw` from +x. */
export function panel(r: number, x: number, y: number, z: number, yaw: number, c: number, sides = 8): Part {
  const g = new THREE.CylinderGeometry(r, r, 0.004, sides);
  g.rotateY(Math.PI / sides);
  g.rotateZ(Math.PI / 2);
  g.rotateY(yaw);
  g.translate(x, y, z);
  return [g, c];
}

export function ellipsoid(rx: number, ry: number, rz: number, x: number, y: number, z: number, c: number, seg = 8): Part {
  const g = new THREE.SphereGeometry(1, seg, Math.max(4, seg - 2)).scale(rx, ry, rz).translate(x, y, z);
  return [g, c];
}

/** Convex polygon (x,z) extruded from y0 to y1. */
export function prism(pts: [number, number][], y0: number, y1: number, c: number): Part {
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

/** Mirror a half-outline (z >= 0 side, listed bow to stern) to a full closed outline. */
export function mirrored(half: [number, number][]): [number, number][] {
  const out = half.slice();
  for (let i = half.length - 1; i >= 0; i--) if (half[i][1] !== 0) out.push([half[i][0], -half[i][1]]);
  return out;
}

export function hullShape(beam: number, bowStart = 0.12, sternCut = 0.92): [number, number][] {
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

/** Scale a polygon's beam (z) or length (x). */
export function scaled(pts: [number, number][], sx: number, sz: number): [number, number][] {
  return pts.map(([x, z]) => [x * sx, z * sz] as [number, number]);
}
