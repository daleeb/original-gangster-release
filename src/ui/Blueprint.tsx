import { attitudeScore } from '../sim/attitudes';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useGame } from '../app/store';
import type { PickResult } from '../render/scene';
import { CELL, GANG_COLORS, ORDERS, STREET_WIDTH } from '../sim/constants';
import { activeBlocks, lotRect, streetEdgeOpen, streetName } from '../sim/cityLayout';
import { orderPeopleBySite, selectableOrderSite, selectedOrderSites } from '../app/orderSelection';
import { plannedCrimeBlocks, specialistPeopleBySite } from '../app/specialistSelection';
import { specialistTargetEligible } from '../sim/specialistJobs';
import { buildingMapIntel, knownBlockOwners } from '../sim/mapIntel';
import { recentEventCounts } from '../sim/events';
import { drawTerritoryOutline } from '../render/territoryOutline';
import { lieutenantAreaChoices } from '../sim/lieutenantAreas';
import type { Block, ID, WorldState } from '../sim/types';
import { blockAt, buildingsOfBlock } from '../sim/world';
import { handleMapBox, handleMapHit } from './mapClick';
import { art } from './art';
import { PLAN, SITE_COLORS, drawCityLandscape, drawElevatedRail, drawPlanLot, drawPlanMarkers, drawPlanSelection, fromPlanPoint, label,
  planBlockRect, planIcon, toPlanRect, type PlanMarker, type PlanMarkerHit } from './cityPlanDrawing';
import { peopleList, buildingList } from '../sim/entityLists';
import { cityTramLines } from '../sim/trams';
import { blockTypeName } from './blockTypeName';

/**
 * The City Plan, after the original organizer map: dark streets, rooftops seen
 * from above and icon tiles for key buildings, opening on the boss's own
 * neighbourhood. Gang holdings are coloured only as they are discovered. It is what the
 * boss looks at while the week is being planned, and it takes the same clicks
 * the 3D city does — job-card targets, a lieutenant's blocks, a site's papers.
 *
 * The plan proper is painted once onto an offscreen sheet whenever the world
 * or the selection changes. The block tag and a selection box being dragged
 * only re-composite that sheet; panning and zooming redraw it at the new scale.
 *
 * Pointing at the map shows nothing, as in the original (its map hit test
 * 0x4EE380 gives the map no tooltip). Holding the left button on it shows the
 * block-type tag of 0x4EC3D0 / 0x4EC770: the name alone ("Residential",
 * "Tramway"...), centred 5 px above the pointer and kept inside the map,
 * refreshed while the button is held and no drag has begun, then left in
 * place for 4 seconds. See docs/audit/2026-10-29/map-hover/review.md.
 */

interface MapArea { x: number; y: number; w: number; h: number }
interface MapChrome { x: number; y: number; w: number; footerY: number }

const HEAT_KEYS = ['landValue', 'crime', 'security', 'hostility', 'events'] as const;
type HeatKey = typeof HEAT_KEYS[number];
const HEAT_LEGENDS: Record<HeatKey, { label: string; low: string; high: string; start: string; end: string }> = {
  landValue: { label: 'Land value', low: 'Low', high: 'High', start: '#ede5d2', end: '#619467' },
  crime: { label: 'Crime', low: 'Quiet', high: 'High', start: '#ede5d2', end: '#cc634a' },
  security: { label: 'Security', low: 'Low', high: 'High', start: '#ede5d2', end: '#6496bf' },
  hostility: { label: 'Local opinion', low: 'Hostile', high: 'Friendly', start: '#cf7f6a', end: '#75a582' },
  events: { label: 'Activity', low: 'Quiet', high: 'Busy', start: '#ede5d2', end: '#d0a041' },
};

/** The block tag: 0x4EC3D0 pads the name by 3 px a side; 0x4EC770 keeps it 4000 ms after the last refresh. */
const BLOCK_TAG_FONT = `600 13px "Barlow Condensed", sans-serif`;
const BLOCK_TAG_PAD = 3, BLOCK_TAG_H = 13 + BLOCK_TAG_PAD * 2, BLOCK_TAG_MS = 4000;

interface Frame {
  scale: number;
  ox: number;
  oy: number;
}

interface View {
  zoom: number;
  panX: number;
  panY: number;
}

/** Where the plan sits: to the right of the journal, unless it is folded away. */
function mapArea(canvas: HTMLCanvasElement, journalOpen: boolean): MapArea {
  const origin = canvas.getBoundingClientRect(), width = canvas.clientWidth, height = canvas.clientHeight;
  const journal = journalOpen ? document.querySelector('.journal')?.getBoundingClientRect() : null;
  const x = journal && journal.width < width * .82 ? journal.right - origin.left + 18 : 24;
  const tabs = journalOpen ? document.querySelector('.journal-tabs')?.getBoundingClientRect() : null;
  const targetBar = !journalOpen ? document.querySelector('.order-target-bar, .plan-map-bar')?.getBoundingClientRect() : null;
  const top = tabs ?? targetBar;
  const y = top ? top.bottom - origin.top + 14 : 24;
  const controls = document.querySelector('.map-buttons')?.getBoundingClientRect();
  const bottom = controls && controls.height > 0 ? controls.top - origin.top - 12 : height - 18;
  return { x, y, w: Math.max(100, width - x - 24), h: Math.max(160, bottom - y) };
}

function fit(w: WorldState, area: { x: number; y: number; w: number; h: number }, view: View): Frame {
  const cityW = w.gridW * CELL;
  const cityH = w.gridH * CELL;
  const scale = Math.min(area.w / cityW, area.h / cityH) * view.zoom;
  return {
    scale,
    ox: area.x + (area.w - cityW * scale) / 2 + view.panX,
    oy: area.y + (area.h - cityH * scale) / 2 + view.panY,
  };
}

/** The laid-paper texture as a canvas pattern, once it has loaded. */
let grainImage: HTMLImageElement | null = null;
function paperGrain(ctx: CanvasRenderingContext2D, redraw: () => void): CanvasPattern | null {
  if (!grainImage) {
    grainImage = new Image();
    grainImage.onload = redraw;
    grainImage.src = art('desk/paper-laid.jpg');
  }
  return grainImage.complete && grainImage.naturalWidth ? ctx.createPattern(grainImage, 'repeat') : null;
}

export function Blueprint() {
  const ref = useRef<HTMLCanvasElement>(null);
  const header = useRef<HTMLDivElement>(null), key = useRef<HTMLDivElement>(null);
  const [chrome, setChrome] = useState<MapChrome | null>(null);
  const mapBounds = useRef<MapArea>({ x: 0, y: 0, w: 1, h: 1 });
  const markerHits = useRef<PlanMarkerHit[]>([]);
  const sheet = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<Frame>({ scale: 1, ox: 0, oy: 0 });
  const view = useRef<View>({ zoom: 1, panX: 0, panY: 0 });
  /** The plan opens on the boss's neighbourhood once per loaded world. */
  const framedWorld = useRef<WorldState | null>(null);
  /** The block-type tag: its top-left corner in city coordinates, pinned to the map as the original's is. */
  const blockTag = useRef<{ x: number; y: number; w: number; text: string } | null>(null);
  const tagTimer = useRef<number | null>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number; button: number; moved: boolean; panX: number; panY: number } | null>(null);
  const paintBase = useRef<() => void>(() => {});
  const composite = useRef<() => void>(() => {});

  const sim = useGame((s) => s.sim);
  const version = useGame((s) => s.version);
  const overlays = useGame((s) => s.overlays);
  const jobCard = useGame((s) => s.jobCard);
  const reviewOrderId = useGame((s) => s.reviewOrderId);
  const staff = useGame(s => s.specialistCard);
  const pickMode = useGame((s) => s.pickMode);
  const policeAreaBlockIds = useGame((s) => s.policeAreaBlockIds);
  const selectedBuildingId = useGame((s) => s.selectedBuildingId);
  const selectedTeamId = useGame((s) => s.selectedTeamId);
  const collapsed = useGame((s) => s.organizerCollapsed);
  const heat = HEAT_KEYS.find(o => overlays.includes(o));
  const heatLegend = heat ? HEAT_LEGENDS[heat] : null;
  const knownGangs = useMemo(() => {
    if (!sim) return [];
    const ids = new Set<ID>([sim.playerGang.id]);
    for (const b of Object.values(sim.world.buildings)) {
      const intel = buildingMapIntel(b, sim.playerGang.id);
      if (intel.ownerGangId != null) ids.add(intel.ownerGangId);
      if (intel.protectionGangId != null) ids.add(intel.protectionGangId);
    }
    return Object.values(sim.world.gangs).filter(g => !g.eliminated && ids.has(g.id));
  }, [sim, version]);


  // ---------------------------------------------------------------- painting
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !sim) return;
    const w = sim.world;
    const gang = sim.playerGang;

    const drawSheet = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (W === 0 || H === 0) return;
      if (!sheet.current) sheet.current = document.createElement('canvas');
      const sc = sheet.current;
      sc.width = Math.round(W * dpr);
      sc.height = Math.round(H * dpr);
      const ctx = sc.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const panel = mapArea(cv, !collapsed);
      const headerH = header.current?.offsetHeight ?? 66, keyH = key.current?.offsetHeight ?? 48;
      const layout = { x: panel.x, y: panel.y, w: panel.w, footerY: panel.y + panel.h - keyH };
      setChrome(previous => previous && Object.keys(layout).every(k => previous[k as keyof MapChrome] === layout[k as keyof MapChrome]) ? previous : layout);
      const area = { x: panel.x + 18, y: panel.y + headerH + 22, w: Math.max(64, panel.w - 36), h: Math.max(64, panel.h - headerH - keyH - 42) };
      mapBounds.current = area;
      if (framedWorld.current !== w) {
        framedWorld.current = w;
        view.current = openingView(w, area, gang.id);
      }
      const f = fit(w, area, view.current);
      frame.current = f;
      const S = (v: number) => v * f.scale;
      const X = (v: number) => f.ox + v * f.scale;
      const Y = (v: number) => f.oy + v * f.scale;

      // A sheet of plan paper lying on the desk (the desk is the shell behind
      // this canvas); it frames a dark map, as in the original organizer.
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14;
      ctx.fillStyle = PLAN.paper; ctx.fillRect(panel.x - 10, panel.y - 8, panel.w + 20, panel.h + 16);
      ctx.restore();
      const grain = paperGrain(ctx, () => paintBase.current());
      if (grain) {
        ctx.save(); ctx.globalAlpha = 0.55; ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = grain; ctx.fillRect(panel.x - 10, panel.y - 8, panel.w + 20, panel.h + 16);
        ctx.restore();
      }
      ctx.strokeStyle = '#b6a583'; ctx.lineWidth = 1;
      ctx.strokeRect(panel.x - 10.5, panel.y - 8.5, panel.w + 21, panel.h + 17);
      ctx.save(); ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();
      ctx.fillStyle = PLAN.ground; ctx.fillRect(area.x, area.y, area.w, area.h);

      // ---- who holds what
      const territory = new Map<ID, ID[]>();
      for (const blk of activeBlocks(w)) {
        territory.set(blk.id, knownBlockOwners(w, blk, gang.id));
      }
      const team = (selectedTeamId != null ? w.teams[selectedTeamId] : undefined) ?? w.teams[gang.teamIds[0]];
      const areaTeam = pickMode?.kind === 'lieutenantArea' ? w.teams[pickMode.teamId] : null;
      const policeArea = pickMode?.kind === 'policeArea';
      const areaChoices = (areaTeam ?? team) ? lieutenantAreaChoices(w, gang.id, (areaTeam ?? team).id) : null;
      const ltBlocks = policeArea ? new Set(policeAreaBlockIds) : areaChoices?.selected ?? new Set<ID>();
      const showLt = policeArea || areaTeam != null || overlays.includes('lieutenant');

      // Keep valid targets visible while an order is being planned.
      const validBlocks = new Set<ID>();
      const validSites = new Set<ID>();
      const def = jobCard ? ORDERS[jobCard.type] : null;
      const personSites = jobCard && def?.target === 'person' ? orderPeopleBySite(w, gang.id, jobCard.type) : new Map<ID, ID>();
      const pickedSites = new Set(jobCard ? selectedOrderSites(w, gang.id, jobCard) : []);
      const crimeBlocks = policeArea ? plannedCrimeBlocks(w, gang.id) : new Set<ID>();
      // The This Week's Orders rolodex highlights the order it is showing.
      const reviewed = !jobCard && reviewOrderId != null ? w.orders[reviewOrderId] : undefined;
      const reviewBlocks = new Set<ID>(reviewed ? [...reviewed.targetBlockIds,
        ...reviewed.targetBuildingIds.map(id => w.buildings[id]?.blockId).filter((id): id is ID => id != null),
        ...(reviewed.targetPersonId != null && w.people[reviewed.targetPersonId]
          ? [blockAt(w, Math.floor(w.people[reviewed.targetPersonId].pos.x / CELL), Math.floor(w.people[reviewed.targetPersonId].pos.y / CELL))?.id].filter((id): id is ID => id != null) : [])] : []);
      if (areaTeam && areaChoices) for (const id of areaChoices.available) if (!ltBlocks.has(id)) validBlocks.add(id);
      if (policeArea) for (const b of buildingList(w)) { validSites.add(b.id); validBlocks.add(b.blockId); if (ltBlocks.has(b.blockId)) pickedSites.add(b.id); }
      if (staff && !policeArea) for (const [site, person] of specialistPeopleBySite(w, gang.id, staff.type)) {
        validSites.add(site); validBlocks.add(w.buildings[site].blockId);
        if (staff.personId === person) pickedSites.add(site);
      }
      if (jobCard && def && pickMode?.kind === 'order') {
        for (const b of buildingList(w)) {
          if (selectableOrderSite(w, gang.id, jobCard, b) || personSites.has(b.id)) {
            validSites.add(b.id); validBlocks.add(b.blockId);
          }
          if (jobCard.personId != null && personSites.get(b.id) === jobCard.personId) pickedSites.add(b.id);
        }
      }

      // ---- building parcels and visible territory
      drawCityLandscape(ctx, w, X, Y, S);
      ctx.lineJoin = 'round';
      const markers: PlanMarker[] = [];
      const events = heat === 'events' ? recentEventCounts(w) : null;
      for (const blk of activeBlocks(w)) {
        const rect = planBlockRect(blk), x = X(rect.x), y = Y(rect.y), s = S(rect.w), h = S(rect.h);
        if (x + s < area.x || y + h < area.y || x > area.x + area.w || y > area.y + area.h) continue;
        const holderColors = overlays.includes('territory')
          ? (territory.get(blk.id) ?? []).map(id => GANG_COLORS[w.gangs[id].color].hex) : [];
        if (!blk.layout || blk.layout.use === 'urban') { ctx.fillStyle = '#4f4b45'; ctx.fillRect(x, y, s, h); }
        if (holderColors.length === 1) {
          ctx.fillStyle = holderColors[0]; ctx.globalAlpha = .26; ctx.fillRect(x, y, s, h); ctx.globalAlpha = 1;
        }
        drawTerritoryOutline(ctx, x - 1, y - 1, s + 2, h + 2, holderColors, 2);
        // Whole-block picking (a lieutenant's area, police coverage) outlines the
        // choosable blocks; order targets are outlined site by site instead.
        if ((areaTeam || policeArea) && validBlocks.has(blk.id)) {
          ctx.strokeStyle = PLAN.target; ctx.lineWidth = 2; ctx.strokeRect(x, y, s, h);
        }
        if (crimeBlocks.has(blk.id)) { ctx.strokeStyle = '#e4b422'; ctx.lineWidth = 4; ctx.strokeRect(x - 2, y - 2, s + 4, h + 4); }
        for (const lotId of blk.lotIds) {
          const lot = w.lots[lotId], b = w.buildings[lot.buildingId];
          if (!b) continue;
          const lr = toPlanRect(blk, lotRect(lot)), lx = X(lr.x), ly = Y(lr.y), ls = S(lr.w);
          drawPlanLot(ctx, w, b, lx, ly, ls, gang.id, validSites.has(b.id), pickedSites.has(b.id), heat != null, S(lr.h));
          const intel = buildingMapIntel(b, gang.id);
          if (!intel.siteKnown || b.state === 'destroyed') continue;
          const icon = intel.isHQ ? 'hq' : planIcon(b);
          // Everyday churches, banks and papers are local detail; they appear
          // once the plan is close enough not to swamp the civic landmarks.
          const minor = icon === 'church' || icon === 'newspaper' || icon === 'bank' || icon === 'school' || icon === 'fire';
          if (icon && (!minor || S(CELL) >= 34)) markers.push({ x: X(lr.x + lr.w / 2), y: Y(lr.y + lr.h / 2), icon, buildingId: b.id,
            hq: intel.isHQ, size: Math.min(ls, S(lr.h)) * .8,
            color: intel.isHQ && intel.ownerGangId != null ? GANG_COLORS[w.gangs[intel.ownerGangId].color].hex : '#4e635b' });
        }
        const tint = heat ? overlayTint(w, blk, heat, gang.id, events) : null;
        if (tint) { ctx.fillStyle = tint; ctx.globalAlpha = .72; ctx.fillRect(x, y, s, h); ctx.globalAlpha = 1; }
        if (showLt && !policeArea && (ltBlocks.has(blk.id) || areaChoices?.other.has(blk.id))) {
          const mine = ltBlocks.has(blk.id), color = mine ? '#ffffff' : GANG_COLORS[gang.color].hex;
          ctx.fillStyle = color; ctx.globalAlpha = mine ? .55 : .24; ctx.fillRect(x, y, s, h); ctx.globalAlpha = 1;
          ctx.strokeStyle = '#514b40'; ctx.lineWidth = 4; ctx.strokeRect(x - 1.5, y - 1.5, s + 3, h + 3);
          ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x - 1.5, y - 1.5, s + 3, h + 3);
        }
        if (jobCard?.blockIds.includes(blk.id) || policeArea && ltBlocks.has(blk.id) || reviewBlocks.has(blk.id)) drawPlanSelection(ctx, x - 1, y - 1, s + 2, h + 2);
      }

      drawElevatedRail(ctx, w, X, Y, S);
      // Actual street names appear once there is room for readable lettering.
      if (S(CELL) >= 78) {
        const street = (text: string, x: number, y: number, vertical: boolean) => {
          if (x < area.x || x > area.x + area.w || y < area.y || y > area.y + area.h) return;
          ctx.save(); ctx.translate(x, y); if (vertical) ctx.rotate(-Math.PI / 2);
          label(ctx, text, 0, 0, S(CELL) * 1.6); ctx.restore();
        };
        for (let x = 0; x <= w.gridW; x++) for (let y = 1; y < w.gridH; y += 3)
          if (streetEdgeOpen(w, x, y, x, y + 1)) street(streetName(w, 'ns', x), X(x * CELL), Y((y + .5) * CELL), true);
        for (let y = 0; y <= w.gridH; y++) for (let x = 1; x < w.gridW; x += 3)
          if (streetEdgeOpen(w, x, y, x + 1, y)) street(streetName(w, 'ew', y), X((x + .5) * CELL), Y(y * CELL), false);
      }
      markerHits.current = drawPlanMarkers(ctx, markers);
      if (selectedBuildingId != null) {
        const b = w.buildings[selectedBuildingId];
        if (b && buildingMapIntel(b, gang.id).siteKnown) {
          const r = toPlanRect(w.blocks[b.blockId], lotRect(w.lots[b.lotId]));
          drawPlanSelection(ctx, X(r.x), Y(r.y), S(r.w), S(r.h));
        }
      }
      if (staff && !policeArea) for (const p of peopleList(w)) if (specialistTargetEligible(w, gang.id, staff.type, p)) {
        ctx.beginPath(); ctx.arc(X(p.pos.x), Y(p.pos.y), staff.personId === p.id ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = staff.personId === p.id ? PLAN.selected : PLAN.target; ctx.fill();
        ctx.strokeStyle = '#fff8dd'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.restore();

    };

    /** Put the sheet on the canvas, with whatever the mouse is doing on top. */
    const paint = () => {
      const sc = sheet.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (!sc || W === 0 || H === 0) return;
      if (cv.width !== sc.width || cv.height !== sc.height) {
        cv.width = sc.width;
        cv.height = sc.height;
      }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(sc, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const d = drag.current;
      if (d && d.moved && isBoxing(d.button)) {
        ctx.strokeStyle = PLAN.selected;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(181,54,45,.12)';
        ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      }

      const tag = blockTag.current;
      if (tag) {
        // Drawn into the map, as the original blits it onto the map surface.
        const f = frame.current, a = mapBounds.current;
        const tx = f.ox + tag.x * f.scale, ty = f.oy + tag.y * f.scale;
        ctx.save();
        ctx.beginPath(); ctx.rect(a.x, a.y, a.w, a.h); ctx.clip();
        ctx.font = BLOCK_TAG_FONT;
        ctx.fillStyle = '#303a36';
        ctx.fillRect(tx, ty, tag.w, BLOCK_TAG_H);
        ctx.strokeStyle = PLAN.edge;
        ctx.lineWidth = 1;
        ctx.strokeRect(tx + 0.5, ty + 0.5, tag.w - 1, BLOCK_TAG_H - 1);
        ctx.fillStyle = '#fffdf5';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag.text, tx + BLOCK_TAG_PAD, ty + BLOCK_TAG_H / 2);
        ctx.restore();
      }
    };

    paintBase.current = () => {
      drawSheet();
      paint();
    };
    composite.current = paint;
    paintBase.current();
    const ro = new ResizeObserver(() => paintBase.current());
    ro.observe(cv);
    if (header.current) ro.observe(header.current);
    if (key.current) ro.observe(key.current);
    const controls = document.querySelector('.map-buttons');
    if (controls) ro.observe(controls);
    const mapBar = document.querySelector('.order-target-bar, .plan-map-bar');
    if (mapBar) ro.observe(mapBar);
    let active = true;
    void document.fonts.ready.then(() => { if (active) paintBase.current(); });
    return () => { active = false; ro.disconnect(); };
  }, [sim, version, overlays, heat, jobCard, reviewOrderId, staff, pickMode, selectedBuildingId, selectedTeamId, policeAreaBlockIds, collapsed]);

  // ---------------------------------------------------------------- hit-testing

  /** What lies under a pixel of the plan. A click just off a lot still finds it. */
  const hitAt = (px: number, py: number): PickResult => {
    const out: PickResult = { buildingId: null, blockId: null, personId: null, point: { x: 0, y: 0 } };
    if (!sim) return out;
    const area = mapBounds.current;
    if (px < area.x || py < area.y || px > area.x + area.w || py > area.y + area.h) return out;
    const w = sim.world;
    if (staff && pickMode?.kind === 'specialist') {
      const f = frame.current;
      const person = peopleList(w).filter(p => specialistTargetEligible(w, sim.playerGang.id, staff.type, p))
        .find(p => Math.hypot(f.ox + p.pos.x * f.scale - px, f.oy + p.pos.y * f.scale - py) <= 7);
      if (person) return { ...out, personId: person.id, point: person.pos };
    }
    const marker = markerHits.current.find(m => px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h);
    if (marker) {
      const b = w.buildings[marker.buildingId];
      return { ...out, buildingId: b.id, blockId: b.blockId, point: w.lots[b.lotId].center };
    }
    const f = frame.current;
    let wx = (px - f.ox) / f.scale;
    let wy = (py - f.oy) / f.scale;
    if (wx < 0 || wy < 0 || wx > w.gridW * CELL || wy > w.gridH * CELL) return out;
    out.point = { x: wx, y: wy };
    const gx = Math.floor(wx / CELL);
    const gy = Math.floor(wy / CELL);
    const blk = blockAt(w, gx, gy);
    if (!blk) return out;
    out.blockId = blk.id;
    ({ x: wx, y: wy } = fromPlanPoint(blk, { x: wx, y: wy }));
    const tol = STREET_WIDTH / 2 + 1;
    let distance = Infinity;
    for (const id of blk.lotIds) {
      const lot = w.lots[id], r = lotRect(lot), building = w.buildings[lot.buildingId];
      if (!building || !buildingMapIntel(building, sim.playerGang.id).siteKnown) continue;
      const dx = Math.max(r.x - wx, 0, wx - r.x - r.w), dy = Math.max(r.y - wy, 0, wy - r.y - r.h);
      const d = Math.hypot(dx, dy);
      if (d <= tol && d < distance) { distance = d; out.buildingId = building.id; }
    }
    return out;
  };

  const blocksInBox = (x0: number, y0: number, x1: number, y1: number): ID[] => {
    if (!sim) return [];
    const w = sim.world;
    const f = frame.current;
    const a = mapBounds.current;
    const wx0 = (Math.max(a.x, Math.min(x0, x1)) - f.ox) / f.scale;
    const wy0 = (Math.max(a.y, Math.min(y0, y1)) - f.oy) / f.scale;
    const wx1 = (Math.min(a.x + a.w, Math.max(x0, x1)) - f.ox) / f.scale;
    const wy1 = (Math.min(a.y + a.h, Math.max(y0, y1)) - f.oy) / f.scale;
    return activeBlocks(w).filter((b) => b.center.x >= wx0 && b.center.x <= wx1 && b.center.y >= wy0 && b.center.y <= wy1).map((b) => b.id);
  };

  const local = (e: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const isBoxing = (button: number) => button === 0 && (pickMode?.kind === 'lieutenantArea' || pickMode?.kind === 'policeArea' ||
    pickMode?.kind === 'order' && jobCard != null && ORDERS[jobCard.type].target === 'area');

  // ---------------------------------------------------------------- block tag

  /**
   * 0x4EC770 → 0x4EC3D0 while the left button is held over the map and no drag
   * has begun: the tag names the block under the pointer, centred on it with
   * its foot 5 px above, then is pushed back inside the map (right and bottom
   * edges, then 4 px in from the left, then the top). Off the city the old tag
   * is left alone, as the original's bounds test skips the refresh; a cell the
   * original has no name for clears it (a remake choice).
   */
  const holdBlockTag = (p: { x: number; y: number }) => {
    const cv = ref.current;
    if (!sim || !cv) return;
    const a = mapBounds.current, f = frame.current, w = sim.world;
    if (p.x < a.x || p.y < a.y || p.x > a.x + a.w || p.y > a.y + a.h) return;
    const gx = Math.floor((p.x - f.ox) / f.scale / CELL), gy = Math.floor((p.y - f.oy) / f.scale / CELL);
    if (gx < 0 || gy < 0 || gx >= w.gridW || gy >= w.gridH) return;
    const text = blockTypeName(w, gx, gy);
    if (tagTimer.current != null) { window.clearTimeout(tagTimer.current); tagTimer.current = null; }
    if (!text) { blockTag.current = null; return; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.font = BLOCK_TAG_FONT;
    const tw = Math.ceil(ctx.measureText(text).width) + BLOCK_TAG_PAD * 2;
    let x = p.x - (tw >> 1), y = p.y - BLOCK_TAG_H - 5;
    if (x + tw > a.x + a.w) x = a.x + a.w - tw;
    if (y + BLOCK_TAG_H > a.y + a.h) y = a.y + a.h - BLOCK_TAG_H;
    if (x < a.x) x = a.x + 4;
    if (y < a.y) y = a.y;
    blockTag.current = { x: (x - f.ox) / f.scale, y: (y - f.oy) / f.scale, w: tw, text };
  };

  /** The button is up or a drag has begun: the tag stays 4 seconds after its last refresh. */
  const releaseBlockTag = () => {
    if (!blockTag.current || tagTimer.current != null) return;
    tagTimer.current = window.setTimeout(() => {
      tagTimer.current = null;
      blockTag.current = null;
      composite.current();
    }, BLOCK_TAG_MS);
  };

  useEffect(() => () => { if (tagTimer.current != null) window.clearTimeout(tagTimer.current); }, []);

  // ---------------------------------------------------------------- mouse

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const area = mapBounds.current;
    if (p.x < area.x || p.y < area.y || p.x > area.x + area.w || p.y > area.y + area.h) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 0) holdBlockTag(p);
    drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, button: e.button, moved: false, panX: view.current.panX, panY: view.current.panY };
    composite.current();
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!sim) return;
    const p = local(e);
    const d = drag.current;
    if (d) {
      d.x1 = p.x;
      d.y1 = p.y;
      if (!d.moved && Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) > 4) {
        d.moved = true;
        releaseBlockTag();
      }
      if (d.moved && !isBoxing(d.button)) {
        // Anything that is not a selection box drags the plan around.
        const flip = useGame.getState().mouseReversal ? -1 : 1;
        view.current.panX = d.panX + (d.x1 - d.x0) * flip;
        view.current.panY = d.panY + (d.y1 - d.y0) * flip;
        paintBase.current();
        return;
      }
      if (d.moved) {
        composite.current();
        return;
      }
      // Held, not yet a drag: the tag follows the block under the pointer.
      if (d.button === 0) { holdBlockTag(p); composite.current(); }
    }
    // Merely pointing at the map shows nothing, as in the original.
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.button === 0) releaseBlockTag();
    const p = local(e);
    if (d.moved) {
      if (isBoxing(d.button)) handleMapBox(blocksInBox(d.x0, d.y0, p.x, p.y));
      else paintBase.current();
      composite.current();
      return;
    }
    if (d.button !== 0) return;
    handleMapHit(hitAt(p.x, p.y), { site: e.shiftKey, fromPlan: true });
  };

  const zoomAt = (zoom: number, p: { x: number; y: number }) => {
    const v = view.current, f = frame.current;
    const next = Math.max(1, Math.min(16, zoom));
    if (next === v.zoom) return;
    // Zoom about the cursor: the world point under it stays put.
    const k = next / v.zoom;
    const baseOx = f.ox - v.panX;
    const baseOy = f.oy - v.panY;
    v.zoom = next;
    if (next === 1) {
      v.panX = 0;
      v.panY = 0;
    } else {
      // The unpanned origin moves with the zoom too, so solve for the pan that
      // keeps the world point under the cursor where it is.
      const nx = p.x - (p.x - f.ox) * k;
      const ny = p.y - (p.y - f.oy) * k;
      const cityW = (sim?.world.gridW ?? 1) * CELL;
      const cityH = (sim?.world.gridH ?? 1) * CELL;
      const newBaseOx = baseOx - (cityW * f.scale * (k - 1)) / 2;
      const newBaseOy = baseOy - (cityH * f.scale * (k - 1)) / 2;
      v.panX = nx - newBaseOx;
      v.panY = ny - newBaseOy;
    }
    paintBase.current();
  };

  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => zoomAt(view.current.zoom * (e.deltaY > 0 ? 1 / 1.18 : 1.18), local(e));
  const zoom = (factor: number) => {
    const a = mapBounds.current;
    zoomAt(view.current.zoom * factor, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
  };
  const fitCity = () => { view.current = { zoom: 1, panX: 0, panY: 0 }; paintBase.current(); };
  const focusHq = () => {
    if (!sim) return;
    const hq = Object.values(sim.world.buildings).find(b => b.isHQ && b.ownerGangId === sim.playerGang.id);
    if (!hq) return;
    const a = mapBounds.current, pos = sim.world.lots[hq.lotId].center;
    const f = fit(sim.world, a, { zoom: 3, panX: 0, panY: 0 });
    view.current = { zoom: 3, panX: a.x + a.w / 2 - f.ox - pos.x * f.scale, panY: a.y + a.h / 2 - f.oy - pos.y * f.scale };
    paintBase.current();
  };

  // Names in organizer reports/Clipboard centre the visible plan as well as the city camera.
  useEffect(() => useGame.subscribe((state, previous) => {
    const pos = state.cameraRequest;
    if (!sim || !pos || pos === previous.cameraRequest) return;
    const a = mapBounds.current, f = fit(sim.world, a, { zoom: 3, panX: 0, panY: 0 });
    view.current = { zoom: 3, panX: a.x + a.w / 2 - f.ox - pos.x * f.scale, panY: a.y + a.h / 2 - f.oy - pos.y * f.scale };
    paintBase.current();
  }), [sim]);

  if (!sim) return null;
  const panelStyle = { left: chrome?.x ?? 0, width: chrome?.w ?? 400, visibility: chrome ? 'visible' as const : 'hidden' as const };
  const playerColor = GANG_COLORS[sim.playerGang.color].hex;
  const target = jobCard ? ORDERS[jobCard.type].target : null;
  const targetHint = target === 'area' ? 'click a block or drag a box · Shift-click a single site'
    : target === 'building' ? 'click a site'
    : target === 'point' ? 'choose a location'
    : target === 'person' ? 'click a highlighted building or use the Clipboard' : 'confirm on the order card';
  return <>
    <canvas
      ref={ref}
      className={`blueprint${pickMode ? ' picking' : ''}`}
      aria-label="City plan. Select blocks and buildings; scroll to zoom or drag to pan."
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { drag.current = null; releaseBlockTag(); composite.current(); }}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
    <div ref={header} className="city-plan-header" style={{ ...panelStyle, top: chrome?.y ?? 0 }}>
      <div className="city-plan-heading"><span>City plan · Week {sim.world.week}</span><h2>New Temperance</h2></div>
      <div className="city-plan-tools" role="group" aria-label="City plan navigation">
        <button onClick={() => zoom(1 / 1.4)} aria-label="Zoom out" title="Zoom out">−</button>
        <button onClick={() => zoom(1.4)} aria-label="Zoom in" title="Zoom in">+</button>
        <button onClick={fitCity}>Fit city</button><button onClick={focusHq} title="Zoom to your headquarters">HQ</button>
      </div>
      <p className={jobCard || isBoxing(0) ? 'target-hint' : undefined}>{jobCard ? `${ORDERS[jobCard.type].name} · ${targetHint}`
        : pickMode?.kind === 'lieutenantArea' ? 'Allocate your territory · click or drag · repeat to remove · right-drag to pan'
        : isBoxing(0) ? 'Click or drag to select · repeat over a selected area to clear it · right-drag to pan'
        : 'Scroll to zoom · drag to move · hold the button on a block for its type'}</p>
    </div>
    <div ref={key} className="city-plan-key" style={{ ...panelStyle, top: chrome?.footerY ?? 0 }} aria-label="City plan key">
      <div className="city-plan-key-row">
        <span><i style={{ background: playerColor }} />Your property</span>
        <span><i className="outline" style={{ borderColor: playerColor }} />Protection</span>
        <span><b className="map-symbol">HQ</b>Headquarters</span>
      </div>
      <div className="city-plan-key-row types">
        {target === 'area' || target === 'building' || target === 'person' ? <>
          <span><i className="map-target" />Available target</span>
          <span><i className="map-selected" />Selected</span>
        </> : pickMode?.kind === 'lieutenantArea' || overlays.includes('lieutenant') ? <>
          <span><i style={{ background: '#fff', border: '1px solid #514b40' }} />Selected lieutenant</span>
          <span><i style={{ background: playerColor }} />Other lieutenants</span>
          {pickMode?.kind === 'lieutenantArea' && <span><i className="map-target" />Available territory</span>}
        </> : heatLegend ? <span className="map-heat-key">
          <strong>{heatLegend.label}</strong>{heatLegend.low}
          <i style={{ background: `linear-gradient(90deg, ${heatLegend.start}, ${heat === 'hostility' ? '#ede5d2,' : ''} ${heatLegend.end})` }} />
          {heatLegend.high}
        </span> : <>
          <span><i style={{ background: SITE_COLORS.commercial }} />Shops</span>
          <span><i style={{ background: SITE_COLORS.tenement }} />Homes</span>
          <span><i style={{ background: SITE_COLORS.industrial }} />Industry</span>
          <span><i style={{ background: SITE_COLORS.municipal }} />Civic</span>
          {sim.world.cityLayout && <span><i style={{ background: PLAN.park }} />Parkland</span>}
          {!!cityTramLines(sim.world).length && <span><i style={{ background: '#9b5143', height: 3 }} />
            {/* The original city's trams have no fixed stops. */}
            {cityTramLines(sim.world).some(line => line.stops.length) ? 'Tram routes · ○ stops' : 'Tram routes'}</span>}
          {sim.world.cityLayout?.original && <span><i style={{ background: PLAN.water }} />River</span>}
        </>}
        {knownGangs.filter(g => !g.isPlayer).map(g => <span key={g.id}><i style={{ background: GANG_COLORS[g.color].hex }} />{g.name}</span>)}
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- pieces

/** Like the original organizer map: a readable block size centred on the HQ.
 * A compact city that already fits at that size opens whole. */
const OPENING_BLOCK_PX = 46;
function openingView(w: WorldState, area: MapArea, gangId: ID): View {
  const base = fit(w, area, { zoom: 1, panX: 0, panY: 0 });
  const zoom = Math.max(1, Math.min(16, OPENING_BLOCK_PX / (CELL * base.scale)));
  if (zoom === 1) return { zoom: 1, panX: 0, panY: 0 };
  const hq = buildingList(w).find(b => b.isHQ && b.ownerGangId === gangId);
  const pos = hq ? w.lots[hq.lotId].center : { x: w.gridW * CELL / 2, y: w.gridH * CELL / 2 };
  const f = fit(w, area, { zoom, panX: 0, panY: 0 });
  return { zoom, panX: area.x + area.w / 2 - f.ox - pos.x * f.scale, panY: area.y + area.h / 2 - f.oy - pos.y * f.scale };
}

function overlayTint(w: WorldState, blk: Block, overlay: HeatKey, gangId: ID, events: Map<ID, number> | null): string {
  const legend = HEAT_LEGENDS[overlay];
  if (overlay === 'landValue') return mixColor(legend.start, legend.end, blk.landValue / 100);
  if (overlay === 'crime') return mixColor(legend.start, legend.end, blk.crimeHeat / 60);
  if (overlay === 'security') return mixColor(legend.start, legend.end, blk.policePresence / 6);
  if (overlay === 'hostility') {
    let total = 0;
    let n = 0;
    for (const b of buildingsOfBlock(w, blk)) {
      if (!b.ownerPersonId) continue;
      const p = w.people[b.ownerPersonId];
      if (!p) continue;
      total += attitudeScore(w, p, gangId);
      n++;
    }
    const avg = n ? total / n : 0;
    return avg >= 0
      ? mixColor('#ede5d2', legend.end, avg / 100)
      : mixColor('#ede5d2', legend.start, -avg / 100);
  }
  return mixColor(legend.start, legend.end, (events?.get(blk.id) ?? 0) / 4);
}

function mixColor(a: string, b: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount));
  const rgb = [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t));
  return `rgb(${rgb.join(',')})`;
}

