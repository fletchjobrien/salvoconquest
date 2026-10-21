// APP-6 / NATO-style tactical symbols, pre-rendered to small canvases and cached.
import { SIDE } from '../theme';
import type { UnitType, BuildingType } from '../../shared/defs';

export type Affil = 'own' | 'ally' | 'hostile' | 'unknown' | 'neutral';
export type SymDomain = 'sea' | 'sub' | 'air' | 'land' | 'site';

export const FONT = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

const GLYPH: Record<UnitType, string> = {
  destroyer: 'DD',
  sub: 'SS',
  battleship: 'BB',
  carrier: 'CV',
  merchant: 'MM',
  lander: 'LC',
  infantry: '#inf',
  coastal: '#ssm',
  sam: '#sam',
  fighter: 'F',
  strike: 'A',
  recon: 'R',
};
export const SITE_GLYPH: Record<BuildingType, string> = {
  hq: 'HQ',
  navalbase: 'NB',
  airbase: '#air',
  barracks: 'BK',
  radar: '#rdr',
  dockyard: 'DY',
  battery: '#ssm',
  resource: '$',
};

export function glyphFor(type: UnitType | null): string {
  return type ? GLYPH[type] : '?';
}

export function sideColor(a: Affil): string {
  return SIDE[a];
}

const cache = new Map<string, HTMLCanvasElement>();

/** Returns a cached canvas; draw it centred at the unit position. */
export function symbolCanvas(affil: Affil, domain: SymDomain, glyph: string, size: number, hi = false, color?: string): HTMLCanvasElement {
  const col = color ?? SIDE[affil];
  const key = `${affil}|${domain}|${glyph}|${size}|${hi ? 1 : 0}|${col}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pad = 8;
  const w = size * 3 + pad * 2;
  const h = size * 3 + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.translate(w / 2, h / 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Glow pass.
  ctx.shadowColor = col;
  ctx.shadowBlur = hi ? 9 : 4;
  framePath(ctx, affil, domain, size);
  ctx.fillStyle = 'rgba(8,12,16,0.62)';
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = hi ? 2 : 1.5;
  ctx.stroke();
  ctx.shadowBlur = hi ? 6 : 2;
  drawGlyph(ctx, glyph, size, col, domain);
  if (domain === 'site') {
    // Installation marker: a small bar on top.
    ctx.fillStyle = col;
    ctx.fillRect(-size * 0.35, -size * 0.78 - 3, size * 0.7, 2.5);
  }
  cache.set(key, c);
  return c;
}

function framePath(ctx: CanvasRenderingContext2D, affil: Affil, domain: SymDomain, s: number) {
  ctx.beginPath();
  const friend = affil === 'own' || affil === 'ally';
  const W = s * 1.15;
  const H = s * 0.78;
  if (affil === 'neutral') {
    ctx.rect(-H, -H, H * 2, H * 2);
    return;
  }
  if (friend) {
    switch (domain) {
      case 'land':
      case 'site':
        ctx.rect(-W, -H, W * 2, H * 2);
        return;
      case 'sea':
        ctx.arc(0, 0, s * 0.82, 0, Math.PI * 2);
        return;
      case 'air':
        ctx.moveTo(-s * 0.85, s * 0.45);
        ctx.lineTo(-s * 0.85, 0);
        ctx.arc(0, 0, s * 0.85, Math.PI, 0);
        ctx.lineTo(s * 0.85, s * 0.45);
        return;
      case 'sub':
        ctx.moveTo(-s * 0.85, -s * 0.45);
        ctx.lineTo(-s * 0.85, 0);
        ctx.arc(0, 0, s * 0.85, Math.PI, 0, true);
        ctx.lineTo(s * 0.85, -s * 0.45);
        return;
    }
  }
  if (affil === 'hostile') {
    const D = s * 1.05;
    switch (domain) {
      case 'land':
      case 'sea':
      case 'site':
        ctx.moveTo(0, -D);
        ctx.lineTo(D, 0);
        ctx.lineTo(0, D);
        ctx.lineTo(-D, 0);
        ctx.closePath();
        return;
      case 'air':
        ctx.moveTo(-D, D * 0.45);
        ctx.lineTo(-D, 0);
        ctx.lineTo(0, -D);
        ctx.lineTo(D, 0);
        ctx.lineTo(D, D * 0.45);
        return;
      case 'sub':
        ctx.moveTo(-D, -D * 0.45);
        ctx.lineTo(-D, 0);
        ctx.lineTo(0, D);
        ctx.lineTo(D, 0);
        ctx.lineTo(D, -D * 0.45);
        return;
    }
  }
  // Unknown: quatrefoil.
  const r = s * 0.48;
  const o = s * 0.5;
  if (domain === 'air') {
    ctx.moveTo(-o - r, s * 0.4);
    ctx.arc(-o, 0, r, Math.PI, Math.PI * 1.5 + 0.3);
    ctx.arc(0, -o, r, Math.PI * 1.25, Math.PI * 1.75);
    ctx.arc(o, 0, r, Math.PI * 1.5 - 0.3, 0);
    ctx.lineTo(o + r, s * 0.4);
    return;
  }
  if (domain === 'sub') {
    ctx.moveTo(-o - r, -s * 0.4);
    ctx.arc(-o, 0, r, Math.PI, Math.PI * 0.5 - 0.3, true);
    ctx.arc(0, o, r, Math.PI * 0.75, Math.PI * 0.25, true);
    ctx.arc(o, 0, r, Math.PI * 0.5 + 0.3, 0, true);
    ctx.lineTo(o + r, -s * 0.4);
    return;
  }
  if (domain === 'land') {
    // Unknown ground contact: a square with clipped corners, so it never reads as a ship.
    const a = s * 0.85;
    const c = s * 0.32;
    ctx.moveTo(-a + c, -a);
    ctx.lineTo(a - c, -a);
    ctx.lineTo(a, -a + c);
    ctx.lineTo(a, a - c);
    ctx.lineTo(a - c, a);
    ctx.lineTo(-a + c, a);
    ctx.lineTo(-a, a - c);
    ctx.lineTo(-a, -a + c);
    ctx.closePath();
    return;
  }
  ctx.arc(0, -o, r, Math.PI * 0.85, Math.PI * 2.15);
  ctx.arc(o, 0, r, Math.PI * 1.35, Math.PI * 2.65);
  ctx.arc(0, o, r, Math.PI * 1.85, Math.PI * 3.15);
  ctx.arc(-o, 0, r, Math.PI * 0.35, Math.PI * 1.65);
  ctx.closePath();
}

function drawGlyph(ctx: CanvasRenderingContext2D, g: string, s: number, col: string, domain: SymDomain) {
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 1.4;
  const W = s * 1.15;
  const H = s * 0.78;
  const yOff = domain === 'air' ? s * 0.12 : domain === 'sub' ? -s * 0.12 : 0;
  switch (g) {
    case '#inf':
      ctx.beginPath();
      ctx.moveTo(-W, -H);
      ctx.lineTo(W, H);
      ctx.moveTo(W, -H);
      ctx.lineTo(-W, H);
      ctx.stroke();
      return;
    case '#ssm':
      ctx.beginPath();
      ctx.moveTo(0, H * 0.75);
      ctx.lineTo(0, -H * 0.55);
      ctx.moveTo(-s * 0.22, -H * 0.2);
      ctx.lineTo(0, -H * 0.7);
      ctx.lineTo(s * 0.22, -H * 0.2);
      ctx.moveTo(-s * 0.5, H * 0.6);
      ctx.quadraticCurveTo(-s * 0.25, H * 0.35, 0, H * 0.6);
      ctx.quadraticCurveTo(s * 0.25, H * 0.85, s * 0.5, H * 0.6);
      ctx.stroke();
      return;
    case '#sam':
      ctx.beginPath();
      ctx.arc(0, H, s * 0.62, Math.PI, 0);
      ctx.moveTo(0, H * 0.2);
      ctx.lineTo(0, -H * 0.65);
      ctx.moveTo(-s * 0.2, -H * 0.3);
      ctx.lineTo(0, -H * 0.7);
      ctx.lineTo(s * 0.2, -H * 0.3);
      ctx.stroke();
      return;
    case '#air':
      ctx.beginPath();
      ctx.moveTo(-s * 0.55, 0);
      ctx.lineTo(s * 0.55, 0);
      ctx.moveTo(0, -H * 0.6);
      ctx.lineTo(0, H * 0.6);
      ctx.moveTo(-s * 0.2, H * 0.55);
      ctx.lineTo(s * 0.2, H * 0.55);
      ctx.stroke();
      return;
    case '#rdr':
      ctx.beginPath();
      ctx.arc(-s * 0.1, H * 0.1, s * 0.55, -Math.PI * 0.75, Math.PI * 0.25);
      ctx.moveTo(-s * 0.1, H * 0.1);
      ctx.lineTo(s * 0.35, -H * 0.4);
      ctx.moveTo(-s * 0.1, H * 0.1);
      ctx.lineTo(-s * 0.1, H * 0.75);
      ctx.stroke();
      return;
  }
  const fs = g.length >= 2 ? s * 0.78 : s * 0.95;
  ctx.font = `700 ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(g, 0, yOff + 0.5);
}

/** Small inline symbol image for HTML UI. */
export function symbolDataUrl(affil: Affil, domain: SymDomain, glyph: string, size = 12, color?: string): string {
  return symbolCanvas(affil, domain, glyph, size, false, color).toDataURL();
}
