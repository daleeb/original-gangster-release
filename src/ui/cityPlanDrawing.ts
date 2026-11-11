import { CELL, GANG_COLORS } from '../sim/constants';
import { BUILDING_BY_ID } from '../sim/data/buildings';
import { buildingMapIntel } from '../sim/mapIntel';
import type { Block, Building, BuildingClass, ID, WorldState } from '../sim/types';
import { activeBlocks, blockRect } from '../sim/cityLayout';
import { cityTramLines } from '../sim/trams';

/**
 * The City Plan, drawn after the original's organizer map: dark asphalt
 * streets, rooftops seen from above, a continuous river and elevated railway,
 * and icon tiles for the city's key buildings — in clean vector detail.
 */
export const PLAN = {
  paper: '#f4efdf', ground: '#2b2c2d', road: '#46484a', pavement: '#5c5a55', lane: '#8d8b82',
  ink: '#1f2422', label: '#e8e2d2', muted: '#62685e', edge: '#b7ac95',
  // Chosen and choosable sites in colours no gang wears (red, green, blue,
  // orange), so a selection never reads as somebody's territory.
  selected: '#e2338c', target: '#1fb5aa',
  park: '#56643b', parkPath: '#8b8565', tree: '#3c4829', plaza: '#8a8378',
  water: '#2f5f5c', waterLight: '#4c7d78', bank: '#5f5a50', rail: '#2a2724', sleeper: '#7a6248',
};

/**
 * Plan geometry. The street view keeps wide streets for traffic, but the
 * original organizer map shows blocks nearly touching across narrow streets.
 * The plan draws each block across its whole cell less this margin, and maps
 * parcels into it proportionally.
 */
export const PLAN_STREET_HALF = 4.2;
type Rect = { x: number; y: number; w: number; h: number };
export function planBlockRect(b: Block): Rect {
  const sx = b.layout?.spanX ?? 1, sy = b.layout?.spanY ?? 1;
  return { x: b.gx * CELL + PLAN_STREET_HALF, y: b.gy * CELL + PLAN_STREET_HALF,
    w: sx * CELL - PLAN_STREET_HALF * 2, h: sy * CELL - PLAN_STREET_HALF * 2 };
}
/** A street-view rectangle inside `b`, placed in the block's plan rectangle. */
export function toPlanRect(b: Block, r: Rect): Rect {
  const from = blockRect(b), to = planBlockRect(b), kx = to.w / from.w, ky = to.h / from.h;
  return { x: to.x + (r.x - from.x) * kx, y: to.y + (r.y - from.y) * ky, w: r.w * kx, h: r.h * ky };
}
/** The street-view point under a plan point inside `b` (for hit-testing). */
export function fromPlanPoint(b: Block, p: { x: number; y: number }): { x: number; y: number } {
  const from = blockRect(b), to = planBlockRect(b);
  return { x: from.x + (p.x - to.x) * from.w / to.w, y: from.y + (p.y - to.y) * from.h / to.h };
}

/** Legend swatches: the dominant roof tone of each class. */
export const SITE_COLORS: Record<BuildingClass, string> = {
  commercial: '#7a6b5e', tenement: '#5a524b', industrial: '#5a6f78', municipal: '#a39b8c',
  charity: '#8a7f73', illegal: '#3b3632', empty: '#6a5f4c', residential: '#6b5647',
};

const ROOFS: Record<BuildingClass, string[]> = {
  commercial: ['#8f877d', '#a39a8e', '#6e6259', '#7f7263', '#b0a697', '#5f5852', '#958574', '#c2b8a8'],
  tenement: ['#5e5853', '#6d655d', '#534d48', '#7a7066'],
  residential: ['#7d5f4a', '#6b5647', '#8a6a52', '#5f4b3e', '#94735a'],
  industrial: ['#5f7680', '#6a8089', '#566b74'],
  municipal: ['#a39b8c', '#9c9486', '#aaa293'],
  charity: ['#8a7f73', '#82776b'],
  illegal: ['#3b3632'],
  empty: ['#6a5f4c', '#645a48'],
};

/** Deterministic 0..1 noise from a building id and a salt. */
function r01(id: number, salt: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (amount > 0 ? (255 - c) * amount : c * amount))));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Key buildings shown as icon tiles, like the original organizer map. */
export type PlanIcon = 'hq' | 'cityHall' | 'courthouse' | 'police' | 'hospital' | 'church' | 'bank' | 'docks'
  | 'railroad' | 'newspaper' | 'fire' | 'school' | 'fbi';
export function planIcon(b: Building): PlanIcon | null {
  const t = BUILDING_BY_ID[b.typeId];
  switch (t?.special) {
    case 'cityHall': return 'cityHall';
    case 'courthouse': return 'courthouse';
    case 'policeHQ': return 'police';
    case 'hospital': return 'hospital';
    case 'church': return 'church';
    case 'bank': return 'bank';
    case 'docks': return 'docks';
    case 'railroad': return 'railroad';
    case 'newspaper': return 'newspaper';
  }
  if (b.typeId === 'firehouse') return 'fire';
  if (b.typeId === 'school') return 'school';
  if (b.typeId === 'fbiHQ') return 'fbi';
  return null;
}
/** Kept for callers that only need to know whether a site is a public landmark. */
export function planLandmark(b: Building): string | null { return planIcon(b); }

// ---------------------------------------------------------------- the network

/** Streets, pavements, avenues, parks, plazas and the river: everything under the rooftops. */
export function drawCityLandscape(ctx: CanvasRenderingContext2D, w: WorldState,
  X: (x: number) => number, Y: (y: number) => number, S: (n: number) => number): void {
  const blocks = activeBlocks(w), px = S(1);
  // Asphalt across the whole city; each block then sits on its pavement.
  ctx.fillStyle = PLAN.road; ctx.fillRect(X(0), Y(0), S(w.gridW * CELL), S(w.gridH * CELL));
  // The original city's wide stone pavements and narrow carriageways.
  const pave = Math.max(1, S(w.cityLayout?.original ? 2.4 : 1.4));
  for (const b of blocks) {
    const use = b.layout?.use;
    if (use === 'avenue' || use === 'water') continue;
    const r = planBlockRect(b);
    ctx.fillStyle = PLAN.pavement;
    ctx.fillRect(X(r.x) - pave, Y(r.y) - pave, S(r.w) + pave * 2, S(r.h) + pave * 2);
  }
  // Avenue lane markings (the original's double-width avenues).
  if (px * CELL >= 22) {
    ctx.strokeStyle = PLAN.lane; ctx.lineWidth = Math.max(1, S(.35)); ctx.setLineDash([S(3), S(3)]);
    ctx.beginPath();
    for (const b of blocks) {
      if (b.layout?.use !== 'avenue' || !b.original) continue;
      const c = b.original.content, x0 = b.gx * CELL, y0 = b.gy * CELL;
      if (c === 34 || c === 41) { ctx.moveTo(X(x0), Y(y0 + CELL / 2)); ctx.lineTo(X(x0 + CELL), Y(y0 + CELL / 2)); }
      if (c === 35) { ctx.moveTo(X(x0 + CELL / 2), Y(y0)); ctx.lineTo(X(x0 + CELL / 2), Y(y0 + CELL)); }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  drawRiver(ctx, w, X, Y, S);

  for (const b of blocks) {
    const use = b.layout?.use;
    if (!use || use === 'urban' || use === 'civic' || use === 'avenue' || use === 'water') continue;
    const r = planBlockRect(b), x = X(r.x), y = Y(r.y), width = S(r.w), height = S(r.h);
    if (use === 'plaza') {
      ctx.fillStyle = PLAN.plaza; ctx.fillRect(x, y, width, height);
      if (width >= 20) {
        ctx.strokeStyle = shade(PLAN.plaza, -.12); ctx.lineWidth = 1; ctx.beginPath();
        for (let i = 1; i < 6; i++) {
          ctx.moveTo(x + width * i / 6, y); ctx.lineTo(x + width * i / 6, y + height);
          ctx.moveTo(x, y + height * i / 6); ctx.lineTo(x + width, y + height * i / 6);
        }
        ctx.stroke();
      }
      continue;
    }
    // Parkland: lawn, crossing paths, a boundary walk and tree crowns.
    ctx.fillStyle = PLAN.park; ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = PLAN.parkPath; ctx.lineWidth = Math.max(1, S(2.4));
    ctx.beginPath();
    ctx.moveTo(x + width / 2, y); ctx.lineTo(x + width / 2, y + height);
    ctx.moveTo(x, y + height / 2); ctx.lineTo(x + width, y + height / 2);
    ctx.stroke();
    if (width >= 24) {
      ctx.lineWidth = Math.max(1, S(1.6)); ctx.strokeRect(x + width * .12, y + height * .12, width * .76, height * .76);
      const n = Math.round((r.w + r.h) / 7);
      for (let i = 0; i < n; i++) {
        const tx = x + width * (.05 + r01(b.id, i) * .9), ty = y + height * (.05 + r01(b.id, i + 99) * .9);
        const rad = Math.max(1.2, S(2.2 + r01(b.id, i + 7) * 1.4));
        ctx.fillStyle = PLAN.tree; ctx.beginPath(); ctx.arc(tx, ty, rad, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = shade(PLAN.park, .18); ctx.beginPath(); ctx.arc(tx - rad * .3, ty - rad * .3, rad * .45, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (b.layout?.name && width >= 60) label(ctx, b.layout.name, x + width / 2, y + height * .5, width - 6, true);
  }
  // Tram routes: the original city's avenues, compact cities' two lines.
  for (const line of cityTramLines(w)) {
    ctx.strokeStyle = line.color; ctx.lineWidth = Math.max(1.3, S(.7));
    ctx.beginPath(); line.points.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))); ctx.stroke();
    for (const stop of line.stops) {
      ctx.beginPath(); ctx.arc(X(stop.pos.x), Y(stop.pos.y), S(54) > 45 ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = PLAN.label; ctx.fill(); ctx.lineWidth = 1.1; ctx.stroke();
    }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

/** The river as one channel with rounded bends, and the bridges across it. */
function drawRiver(ctx: CanvasRenderingContext2D, w: WorldState,
  X: (x: number) => number, Y: (y: number) => number, S: (n: number) => number): void {
  const wet = (b: Block | undefined) => !!b && (b.layout?.use === 'water' || b.original?.content === 37);
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w.gridW && y < w.gridH ? w.blocks[y * w.gridW + x] : undefined;
  const river = w.blocks.filter(wet);
  if (!river.length) return;
  const centre = (b: Block) => [X((b.gx + .5) * CELL), Y((b.gy + .5) * CELL)] as const;
  const path = () => {
    ctx.beginPath();
    for (const b of river) {
      const [cx, cy] = centre(b);
      ctx.moveTo(cx, cy); ctx.lineTo(cx + .01, cy);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = at(b.gx + dx, b.gy + dy);
        if (!wet(n)) continue;
        const [nx, ny] = centre(n!); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny);
      }
      // Channels run to the map edge.
      if (b.gx === 0) { ctx.moveTo(cx, cy); ctx.lineTo(X(0), cy); }
      if (b.gx === w.gridW - 1) { ctx.moveTo(cx, cy); ctx.lineTo(X(w.gridW * CELL), cy); }
    }
  };
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  path(); ctx.strokeStyle = PLAN.bank; ctx.lineWidth = S(CELL * .74); ctx.stroke();
  path(); ctx.strokeStyle = PLAN.water; ctx.lineWidth = S(CELL * .6); ctx.stroke();
  if (S(CELL) >= 28) { path(); ctx.strokeStyle = PLAN.waterLight; ctx.lineWidth = Math.max(1, S(.8)); ctx.setLineDash([S(5), S(9)]); ctx.stroke(); }
  ctx.restore();
  // Bridges: an avenue deck across the channel.
  for (const b of river) {
    const c = b.original?.content;
    if (c !== 37 && c !== 40) continue;
    const x = X(b.gx * CELL), y = Y(b.gy * CELL), s = S(CELL);
    const deckW = c === 40 ? s * .22 : s * .62;
    ctx.fillStyle = c === 40 ? PLAN.rail : PLAN.road;
    ctx.fillRect(x + (s - deckW) / 2, y, deckW, s);
    ctx.strokeStyle = shade(PLAN.pavement, .25); ctx.lineWidth = Math.max(1, S(.8));
    ctx.beginPath();
    ctx.moveTo(x + (s - deckW) / 2, y + s * .18); ctx.lineTo(x + (s - deckW) / 2, y + s * .82);
    ctx.moveTo(x + (s + deckW) / 2, y + s * .18); ctx.lineTo(x + (s + deckW) / 2, y + s * .82);
    ctx.stroke();
  }
}

/** The elevated railway and its station, drawn above the rooftops. */
export function drawElevatedRail(ctx: CanvasRenderingContext2D, w: WorldState,
  X: (x: number) => number, Y: (y: number) => number, S: (n: number) => number): void {
  const col = w.cityLayout?.original?.railColumn;
  if (col == null) return;
  const x = X((col + .5) * CELL), band = Math.max(2, S(5.5));
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - band / 2 + S(1.2), Y(0), band, S(w.gridH * CELL));
  ctx.fillStyle = PLAN.rail; ctx.fillRect(x - band / 2, Y(0), band, S(w.gridH * CELL));
  if (S(CELL) >= 20) {
    ctx.strokeStyle = PLAN.sleeper; ctx.lineWidth = Math.max(1, S(.6)); ctx.beginPath();
    for (let m = 0; m < w.gridH * CELL; m += 2.4) { ctx.moveTo(x - band / 2, Y(m)); ctx.lineTo(x + band / 2, Y(m)); }
    ctx.stroke();
    ctx.strokeStyle = '#9a9a92'; ctx.lineWidth = Math.max(.6, S(.25)); ctx.beginPath();
    for (const o of [-.25, .25]) { ctx.moveTo(x + band * o, Y(0)); ctx.lineTo(x + band * o, Y(w.gridH * CELL)); }
    ctx.stroke();
  }
  const station = w.cityLayout?.original?.station;
  if (station) {
    const sx = X((station.x + .5) * CELL), sy = Y((station.y + .5) * CELL), pw = S(CELL * .5), ph = S(CELL * .8);
    ctx.fillStyle = '#6d6356'; ctx.fillRect(sx - pw / 2, sy - ph / 2, pw, ph);
    ctx.fillStyle = PLAN.rail; ctx.fillRect(sx - band / 2, sy - ph / 2, band, ph);
  }
}

// ---------------------------------------------------------------- rooftops

/** One parcel's rooftop, seen from above, with ownership and targeting on top. */
export function drawPlanLot(ctx: CanvasRenderingContext2D, w: WorldState, b: Building,
  x: number, y: number, s: number, viewer: ID, valid: boolean, picked: boolean, heatMap = false, height = s,
  /** The building this lot is part of (premises.ts siteBuilding): whose it is and how it is roofed. */
  site: Building = b): void {
  const intel = buildingMapIntel(site, viewer);
  const owner = intel.ownerGangId != null ? w.gangs[intel.ownerGangId] : null;
  const protector = intel.protectionGangId != null ? w.gangs[intel.protectionGangId] : null;
  // A hidden illegal business looks like the yard it sits in.
  const cls: BuildingClass = intel.siteKnown ? site.cls : 'empty';
  const gap = Math.max(.5, Math.min(1.6, Math.min(s, height) * .05));
  const rx = x + gap, ry = y + gap, rw = s - gap * 2, rh = height - gap * 2;
  if (rw <= 0 || rh <= 0) return;
  if (b.state === 'destroyed') drawRubble(ctx, b.id, rx, ry, rw, rh);
  else drawRoof(ctx, b, cls, rx, ry, rw, rh);
  if (b.state === 'damaged') {
    ctx.fillStyle = 'rgba(20,14,10,.45)'; ctx.beginPath();
    ctx.ellipse(rx + rw * .6, ry + rh * .45, rw * .32, rh * .28, .4, 0, Math.PI * 2); ctx.fill();
  }
  if (heatMap) { ctx.fillStyle = 'rgba(20,22,24,.25)'; ctx.fillRect(rx, ry, rw, rh); }
  if (owner) {
    const hex = GANG_COLORS[owner.color].hex;
    ctx.fillStyle = hex; ctx.globalAlpha = .55; ctx.fillRect(rx, ry, rw, rh); ctx.globalAlpha = 1;
    ctx.strokeStyle = shade(hex, .35); ctx.lineWidth = Math.max(1, Math.min(2, rw * .08)); ctx.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
  }
  if (protector) {
    ctx.strokeStyle = GANG_COLORS[protector.color].hex;
    ctx.lineWidth = Math.max(1.5, Math.min(2.5, s * .12));
    ctx.strokeRect(x + .5, y + .5, s - 1, height - 1);
    if (site.protection?.refusing) {
      ctx.strokeStyle = PLAN.label; ctx.setLineDash([2, 2]);
      ctx.strokeRect(x + .5, y + .5, s - 1, height - 1); ctx.setLineDash([]);
    }
  }
  if (valid && !picked) {
    // Choosable: a teal outline only, so the building's own colour stays
    // readable underneath; chosen sites alone are filled (magenta).
    ctx.strokeStyle = PLAN.target; ctx.lineWidth = Math.max(1.5, Math.min(2.5, s * .1));
    ctx.strokeRect(x + 1, y + 1, s - 2, height - 2);
  }
  if (picked) drawPlanSelection(ctx, x, y, s, height);
}

function drawRoof(ctx: CanvasRenderingContext2D, b: Building, cls: BuildingClass, x: number, y: number, w: number, h: number): void {
  const tones = ROOFS[cls] ?? ROOFS.commercial, id = b.id;
  const base = b.typeId === 'church' ? '#7f766b' : tones[Math.floor(r01(id, 1) * tones.length)];
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  const small = Math.min(w, h);
  if (small < 5) return;
  // Parapet bevel: lit top-left, shadowed bottom-right.
  const lip = Math.max(.8, small * .08);
  ctx.fillStyle = shade(base, .28); ctx.fillRect(x, y, w, lip); ctx.fillRect(x, y, lip, h);
  ctx.fillStyle = shade(base, -.38); ctx.fillRect(x, y + h - lip, w, lip); ctx.fillRect(x + w - lip, y, lip, h);
  if (small < 9) return;
  const ix = x + lip, iy = y + lip, iw = w - lip * 2, ih = h - lip * 2;
  const long = iw >= ih;
  switch (cls) {
    case 'industrial': {
      // Sawtooth north lights: alternating lit and shaded bays.
      const bays = Math.max(3, Math.round((long ? iw : ih) / Math.max(3, small * .16)));
      for (let i = 0; i < bays; i++) {
        ctx.fillStyle = i % 2 ? shade(base, -.22) : shade(base, .32);
        if (long) ctx.fillRect(ix + iw * i / bays, iy, iw / bays * .55, ih);
        else ctx.fillRect(ix, iy + ih * i / bays, iw, ih / bays * .55);
      }
      break;
    }
    case 'residential': case 'tenement': {
      // Terraces: one roof per house along the frontage, ridge line down the middle.
      const houses = cls === 'residential' ? Math.max(2, Math.round((long ? iw : ih) / Math.max(4, small * .45))) : 1;
      for (let i = 0; i < houses; i++) {
        const t = shade(base, (r01(id, i + 20) - .5) * .22);
        ctx.fillStyle = t;
        if (long) ctx.fillRect(ix + iw * i / houses, iy, iw / houses - .6, ih);
        else ctx.fillRect(ix, iy + ih * i / houses, iw, ih / houses - .6);
      }
      ctx.fillStyle = shade(base, -.3);
      if (long) ctx.fillRect(ix, iy + ih / 2 - .5, iw, 1); else ctx.fillRect(ix + iw / 2 - .5, iy, 1, ih);
      ctx.fillStyle = shade(base, .12);
      if (long) ctx.fillRect(ix, iy, iw, ih / 2 - .5); // lit slope
      else ctx.fillRect(ix, iy, iw / 2 - .5, ih);
      // Chimney stacks.
      ctx.fillStyle = '#3a3230';
      const stacks = cls === 'tenement' ? 4 : houses;
      for (let i = 0; i < stacks; i++) {
        const cs = Math.max(1.2, small * .08);
        const cx = long ? ix + iw * (i + .5) / stacks : ix + iw * .25;
        const cy = long ? iy + ih * .25 : iy + ih * (i + .5) / stacks;
        ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
      }
      break;
    }
    case 'municipal': case 'charity': {
      ctx.fillStyle = shade(base, .14); ctx.fillRect(ix + iw * .12, iy + ih * .12, iw * .76, ih * .76);
      const special = BUILDING_BY_ID[b.typeId]?.special;
      if (b.typeId === 'church') {
        ctx.fillStyle = shade(base, -.18);
        ctx.fillRect(ix + iw * .4, iy + ih * .08, iw * .2, ih * .84); ctx.fillRect(ix + iw * .15, iy + ih * .3, iw * .7, ih * .18);
      } else if (special === 'cityHall' || special === 'courthouse') {
        ctx.fillStyle = shade(base, .3); ctx.beginPath(); ctx.arc(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * .22, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = shade(base, -.25); ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.fillStyle = shade(base, -.12); ctx.fillRect(ix + iw * .3, iy + ih * .3, iw * .4, ih * .4);
      }
      break;
    }
    case 'empty': {
      // Gravel and packed earth.
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = i % 2 ? shade(base, .12) : shade(base, -.14);
        ctx.fillRect(ix + iw * r01(id, i + 40), iy + ih * r01(id, i + 60), Math.max(1, small * .06), Math.max(1, small * .06));
      }
      break;
    }
    default: {
      // Flat tar roofs: skylights and plant boxes.
      const lights = Math.max(1, Math.round((long ? iw : ih) / Math.max(6, small * .5)));
      ctx.fillStyle = shade(base, .34);
      for (let i = 0; i < lights; i++) {
        const lw = long ? iw / lights * .5 : iw * .28, lh = long ? ih * .28 : ih / lights * .5;
        const lx = long ? ix + iw * (i + .25) / lights : ix + iw * .56, ly = long ? iy + ih * .56 : iy + ih * (i + .25) / lights;
        ctx.fillRect(lx, ly, lw, lh);
      }
      ctx.fillStyle = shade(base, -.35);
      const vs = Math.max(1.2, small * .1);
      ctx.fillRect(ix + iw * (.15 + r01(id, 5) * .3), iy + ih * (.12 + r01(id, 6) * .25), vs, vs);
      if (b.cls === 'illegal') { ctx.fillStyle = '#9b2a22'; ctx.fillRect(ix + iw * .7, iy + ih * .15, vs, vs); }
    }
  }
}

function drawRubble(ctx: CanvasRenderingContext2D, id: number, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#4b433b'; ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = i % 3 ? '#6b5f53' : '#2e2925';
    const s = Math.max(1, Math.min(w, h) * (.06 + r01(id, i + 80) * .1));
    ctx.fillRect(x + w * r01(id, i + 81), y + h * r01(id, i + 82), s, s);
  }
}

// ---------------------------------------------------------------- overlays and icons

/** A chosen site, as the original marks it: a solid red wash with a light
 * keyline and a bold red rule, readable at any zoom over any building colour. */
export function drawPlanSelection(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.fillStyle = 'rgba(226,51,140,.62)'; ctx.fillRect(x, y, width, height);
  const rule = Math.max(2, Math.min(3.5, Math.min(width, height) * .12));
  ctx.strokeStyle = '#fff4dc'; ctx.lineWidth = rule + 2.5; ctx.strokeRect(x, y, width, height);
  ctx.strokeStyle = PLAN.selected; ctx.lineWidth = rule; ctx.strokeRect(x, y, width, height);
}

export interface PlanMarker { x: number; y: number; icon: PlanIcon; color: string; hq: boolean; buildingId: ID; size: number }
export interface PlanMarkerHit { x: number; y: number; w: number; h: number; buildingId: ID }

/** Icon tiles for key buildings; HQs first, then civic landmarks, never overlapping. */
export function drawPlanMarkers(ctx: CanvasRenderingContext2D, markers: PlanMarker[]): PlanMarkerHit[] {
  const placed: PlanMarkerHit[] = [];
  const priority = (m: PlanMarker) => m.hq ? 3 : ['cityHall', 'courthouse', 'police', 'hospital'].includes(m.icon) ? 2 : 1;
  for (const m of markers.sort((a, b) => priority(b) - priority(a))) {
    const size = Math.max(m.hq ? 20 : 16, Math.min(36, m.size));
    const box = { x: m.x - size / 2, y: m.y - size / 2, w: size, h: size, buildingId: m.buildingId };
    if (placed.some(p => box.x < p.x + p.w + 1 && box.x + box.w + 1 > p.x && box.y < p.y + p.h + 1 && box.y + box.h + 1 > p.y)) continue;
    placed.push(box);
    // Tile: pale card with a dark rim and a soft drop shadow.
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(box.x + 1.5, box.y + 1.5, size, size);
    ctx.fillStyle = m.hq ? m.color : '#e9e1cd'; ctx.fillRect(box.x, box.y, size, size);
    ctx.strokeStyle = m.hq ? '#fff4dc' : '#2b2a27'; ctx.lineWidth = 1.2; ctx.strokeRect(box.x + .6, box.y + .6, size - 1.2, size - 1.2);
    drawIcon(ctx, m.icon, m.x, m.y, size * .62, m.hq ? '#fff4dc' : '#2b2a27');
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  return placed;
}

function drawIcon(ctx: CanvasRenderingContext2D, icon: PlanIcon, cx: number, cy: number, s: number, ink: string): void {
  const u = s / 10;
  ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, u * .9);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const rect = (x: number, y: number, w: number, h: number) => ctx.fillRect(x * u, y * u, w * u, h * u);
  switch (icon) {
    case 'hq': // pistol
      rect(-5, -2.5, 8, 2.4); rect(-5, -2.6, 1.2, 1); rect(0, -.6, 2.6, 5); rect(-1.6, .2, 1.2, 1.6);
      break;
    case 'hospital':
      ctx.fillStyle = '#b3261e'; rect(-1.4, -4.5, 2.8, 9); rect(-4.5, -1.4, 9, 2.8);
      break;
    case 'church':
      rect(-.9, -5, 1.8, 10); rect(-3.5, -2.8, 7, 1.8);
      break;
    case 'bank':
      ctx.fillStyle = '#2f6b3a'; ctx.font = `700 ${s * 1.05}px Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', 0, u * .5);
      break;
    case 'police': case 'fbi': {
      ctx.fillStyle = icon === 'fbi' ? '#26436b' : '#2e4f86';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, r = (i % 2 ? 2.2 : 5) * u;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'cityHall': case 'courthouse':
      ctx.beginPath(); ctx.moveTo(-5 * u, -2 * u); ctx.lineTo(0, -5 * u); ctx.lineTo(5 * u, -2 * u); ctx.closePath(); ctx.fill();
      for (const x of [-3.8, -1.4, 1, 3.2]) rect(x, -1.5, .9, 5);
      rect(-5, 3.8, 10, 1.2);
      if (icon === 'courthouse') { ctx.fillStyle = '#e9e1cd'; rect(-.6, -3.9, 1.2, 1.2); }
      break;
    case 'newspaper':
      ctx.strokeRect(-4.5 * u, -4 * u, 9 * u, 8 * u);
      rect(-3.4, -2.8, 6.8, 1.6); for (const y of [0, 1.6, 3]) rect(-3.4, y - .3, 6.8, .6);
      break;
    case 'docks': // anchor
      ctx.beginPath(); ctx.arc(0, -3.6 * u, 1.1 * u, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -2.5 * u); ctx.lineTo(0, 4.5 * u); ctx.moveTo(-2.4 * u, -1 * u); ctx.lineTo(2.4 * u, -1 * u);
      ctx.moveTo(-4 * u, 1.5 * u); ctx.quadraticCurveTo(-3 * u, 4.6 * u, 0, 4.5 * u); ctx.quadraticCurveTo(3 * u, 4.6 * u, 4 * u, 1.5 * u); ctx.stroke();
      break;
    case 'railroad': // locomotive
      rect(-4.5, -1, 7, 3.4); rect(1, -4, 2.5, 3); rect(-4, -3, 1.5, 2);
      for (const x of [-3, -.5, 2]) { ctx.beginPath(); ctx.arc(x * u, 3.4 * u, 1.1 * u, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'fire':
      ctx.fillStyle = '#b8431b'; ctx.beginPath(); ctx.moveTo(0, -5 * u);
      ctx.quadraticCurveTo(4.5 * u, 0, 2.6 * u, 4 * u); ctx.lineTo(-2.6 * u, 4 * u); ctx.quadraticCurveTo(-4.5 * u, 0, 0, -5 * u); ctx.fill();
      break;
    case 'school': // book
      ctx.beginPath(); ctx.moveTo(0, -2.5 * u); ctx.lineTo(-4.5 * u, -3.5 * u); ctx.lineTo(-4.5 * u, 3.5 * u); ctx.lineTo(0, 4.3 * u);
      ctx.lineTo(4.5 * u, 3.5 * u); ctx.lineTo(4.5 * u, -3.5 * u); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -2.5 * u); ctx.lineTo(0, 4.3 * u); ctx.stroke();
      break;
  }
  ctx.restore();
}

/** Readable lettering over the dark map: pale text with a dark halo. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, italic = false): void {
  ctx.font = `${italic ? 'italic ' : ''}600 12px "Barlow Condensed", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(20,20,20,.85)'; ctx.lineWidth = 3; ctx.strokeText(text, x, y, maxWidth);
  ctx.fillStyle = PLAN.label; ctx.fillText(text, x, y, maxWidth);
}
