// Weather cell shape, shared by the simulation, the overlay and the shaders (see weatherfx.ts).
// Storms are squall lines stretched across the wind; fog banks are long tongues along it.

/** Prevailing wind direction (radians). The shaders use the same direction (wWind uniform). */
export const WIND_ANGLE = Math.atan2(0.025, 0.06);
const WC = Math.cos(WIND_ANGLE);
const WS = Math.sin(WIND_ANGLE);

/** Semi-axes as multiples of the cell radius: [along the wind, across the wind]. */
export const WEATHER_AXES: Record<0 | 1, [number, number]> = {
  0: [0.72, 1.4],
  1: [1.65, 0.62],
};

/** Normalised distance from a cell centre: 0 at the centre, 1 on the edge. */
export function weatherNormDist(kind: 0 | 1, dx: number, dy: number, r: number): number {
  const [a, b] = WEATHER_AXES[kind];
  const u = (dx * WC + dy * WS) / (r * a);
  const v = (-dx * WS + dy * WC) / (r * b);
  return Math.hypot(u, v);
}

/** Effect strength 0..1 of a cell with intensity i (0..1) at offset (dx, dy). */
export function weatherStrength(kind: 0 | 1, dx: number, dy: number, r: number, i: number): number {
  const d = weatherNormDist(kind, dx, dy, r);
  return d >= 1 ? 0 : i * Math.min(1, (1 - d) * 2.2);
}

/** Point on the cell outline at parameter t (radians), for drawing. */
export function weatherOutline(kind: 0 | 1, x: number, y: number, r: number, t: number): [number, number] {
  const [a, b] = WEATHER_AXES[kind];
  const u = Math.cos(t) * r * a;
  const v = Math.sin(t) * r * b;
  return [x + u * WC - v * WS, y + u * WS + v * WC];
}
