import { useEffect, useRef, useState } from 'react';
import { CityRenderer } from '../render/scene';
import { VIEW_ZOOM, viewForZoom } from '../render/viewModes';

/** Lets the HUD drive the camera without threading refs through the tree. */
export const cameraApi = {
  ref: null as CityRenderer | null,
};

/** The transparent opening in the HUD is drawn by the city's shared WebGL canvas. */
export const taggedViewApi = {
  views: new Map<number, { element: HTMLDivElement; personId: number; mode: 'street' | 'roof' }>(),
};

import { useGame } from '../app/store';
import { carsAt } from '../sim/traffic';
import { handleMapBox, handleMapHit } from './mapClick';
import { ORDERS } from '../sim/constants';
import { activeBlocks } from '../sim/cityLayout';
import { orderPeopleBySite, selectableOrderSite, selectedOrderSites } from '../app/orderSelection';
import { plannedCrimeBlocks, specialistPeopleBySite } from '../app/specialistSelection';
import { specialistTargetEligible } from '../sim/specialistJobs';
import { lieutenantAreaChoices } from '../sim/lieutenantAreas';
import { yieldForPaint } from '../yieldForPaint';
import { StreetLoading } from './StreetLoading';
import { WEEK_DAYS, weekTime } from './WeekClock';
import { dayIndex } from '../sim/world';
import { peopleList } from '../sim/entityLists';

/**
 * The city itself: owns the Three.js renderer, drives the simulation clock and
 * turns clicks into selections or order targets.
 */
export function CityView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CityRenderer | null>(null);
  const readyForInput = useRef(false);
  const [cityStatus, setCityStatus] = useState<'opening' | 'ready' | 'failed'>('opening');
  /** What the graphics layer said when the city could not be drawn. */
  const [cityError, setCityError] = useState<string | null>(null);
  const [openingMessage, setOpeningMessage] = useState('Preparing the city…');
  const [renderAttempt, setRenderAttempt] = useState(0);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  // A left-button drag draws a box and gathers your own people inside it.
  const boxing = useRef(false);
  const boxStart = useRef({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });

  const sim = useGame((s) => s.sim);
  const streetLoading = useGame((s) => s.streetLoading);
  const finishingWeek = useGame((s) => s.finishingWeek);

  // Keep the renderer in sync with a brand new simulation.
  useEffect(() => {
    if (!canvasRef.current || !sim) return;
    readyForInput.current = false;
    setCityStatus('opening');
    setCityError(null);
    const canvas = canvasRef.current;
    let alive = true;
    let ownedRenderer: CityRenderer | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let removeResizeListener: (() => void) | null = null;

    const open = async () => {
      const renderer = await CityRenderer.create(canvas, sim.world,
        () => alive && useGame.getState().sim === sim);
      if (!renderer) return;
      ownedRenderer = renderer;
      rendererRef.current = renderer;
      cameraApi.ref = renderer;
      // A handle for timing the simulation from the console during development.
      if (import.meta.env.DEV) {
        const dev = window as unknown as Record<string, unknown>;
        dev.__sim = sim;
        dev.__carsAt = carsAt;
        dev.__game = useGame;
      }

      const player = sim.playerGang;
      let lastCard: unknown = undefined, lastTargetVersion = -1, lastPlanningView = '';
      let lastStaff: unknown, lastPick: unknown, lastArea: unknown;
      const hq = Object.values(sim.world.buildings).find((b) => b.ownerGangId === player.id && b.isHQ);
      if (hq) {
        const lot = sim.world.lots[hq.lotId];
        renderer.centerOn(lot.center.x, lot.center.y);
      }

      if (sim.world.phase === 'week') renderer.setZoom(VIEW_ZOOM.street);

      const resize = () => {
        const el = canvasRef.current;
        if (!el) return;
        renderer.resize(el.clientWidth, el.clientHeight);
      };
      resize();
      ro = new ResizeObserver(resize);
      if (canvas.parentElement) ro.observe(canvas.parentElement);
      window.addEventListener('resize', resize);
      removeResizeListener = () => window.removeEventListener('resize', resize);

      let preparing = false;
      let preparationFailed = false;
      let last = performance.now();
      let uiAccum = 0;
      let lastWeek = sim.world.week;
      let lastPhase = sim.world.phase;

      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;

        const state = useGame.getState();
        const s = state.sim;
        if (s !== sim) return;
        // The launch screen must paint before the planning snapshot and order
        // dispatch; do not compete with that work from the renderer loop.
        if (state.streetLoading && s.world.phase === 'planning') return;

        renderer.setTimeScale(0);
        renderer.setSubMinute(s.subMinute);
        renderer.setStreetsOpen(s.world.phase === 'week');
        // Street View drops the roofs by itself when the option is on.
        renderer.setHiddenRoofs(state.autoLowerRoofs && viewForZoom(renderer.getZoom()) === 'street');
        renderer.setRoadNames(state.roadNames);

        // A new week rebuilds the ground plan and the skyline.
        if (s.world.week !== lastWeek || s.world.phase !== lastPhase) {
          if (lastPhase !== s.world.phase && s.world.phase === 'week') renderer.setZoom(VIEW_ZOOM.street);
          lastWeek = s.world.week;
          lastPhase = s.world.phase;
          renderer.markDirty();
          state.bump();
        }

        // Overlays and selection.
        const areaTeamId = state.pickMode?.kind === 'lieutenantArea' ? state.pickMode.teamId : state.selectedTeamId ?? s.playerGang.teamIds[0];
        const teamBlocks = areaTeamId != null ? (s.world.teams[areaTeamId]?.allocatedBlockIds ?? []) : [];
        renderer.setOverlays(state.pickMode?.kind === 'lieutenantArea' && !state.overlays.includes('lieutenant')
          ? [...state.overlays, 'lieutenant'] : state.overlays, s.playerGang.id, teamBlocks);
        if (lastCard !== state.jobCard || lastTargetVersion !== state.version || lastPlanningView !== state.planningView || lastStaff !== state.specialistCard || lastPick !== state.pickMode || lastArea !== state.policeAreaBlockIds) {
          lastCard = state.jobCard; lastTargetVersion = state.version; lastPlanningView = state.planningView;
          lastStaff = state.specialistCard; lastPick = state.pickMode; lastArea = state.policeAreaBlockIds;
          const card = s.world.phase === 'planning' && state.planningView === 'city' ? state.jobCard : null;
          const available = new Set<number>(), selected = new Set(card ? selectedOrderSites(s.world, s.playerGang.id, card) : []);
          if (state.pickMode?.kind === 'lieutenantArea') {
            const areas = lieutenantAreaChoices(s.world, s.playerGang.id, state.pickMode.teamId);
            for (const b of Object.values(s.world.buildings)) {
              const root = s.world.blocks[b.blockId]?.layout?.mergedInto ?? b.blockId;
              if (areas.available.has(root) && !areas.selected.has(root)) available.add(b.id);
            }
          }
          if (card) {
            const people = ORDERS[card.type].target === 'person' ? orderPeopleBySite(s.world, s.playerGang.id, card.type) : new Map<number, number>();
            for (const b of Object.values(s.world.buildings)) {
              if (people.has(b.id) || selectableOrderSite(s.world, s.playerGang.id, card, b)) available.add(b.id);
              if (card.personId != null && people.get(b.id) === card.personId) selected.add(b.id);
            }
          }
          const staff = s.world.phase === 'planning' && state.planningView === 'city' ? state.specialistCard : null;
          const crimes = new Set<number>();
          if (staff && state.pickMode?.kind === 'policeArea') {
            const crimeBlocks = plannedCrimeBlocks(s.world, s.playerGang.id);
            for (const b of Object.values(s.world.buildings)) {
              available.add(b.id);
              if (state.policeAreaBlockIds.includes(b.blockId)) selected.add(b.id);
              if (crimeBlocks.has(b.blockId)) crimes.add(b.id);
            }
          } else if (staff) for (const [site, person] of specialistPeopleBySite(s.world, s.playerGang.id, staff.type)) {
            available.add(site); if (person === staff.personId) selected.add(site);
          }
          renderer.setPlanningTargets(available, selected, crimes);
          renderer.setPlanningPeople(staff && state.pickMode?.kind === 'specialist'
            ? Object.values(s.world.people).filter(p => specialistTargetEligible(s.world, s.playerGang.id, staff.type, p)) : [], staff?.personId ?? null);
        }

        const sel = state.selectedBuildingId != null ? s.world.buildings[state.selectedBuildingId] : null;
        const selectedPersonId = s.world.phase === 'planning' && state.specialistCard ? state.specialistCard.personId : state.selectedPersonId;
        const selP = selectedPersonId != null ? s.world.people[selectedPersonId] : null;
        renderer.select(state.specialistCard ? null : sel ?? null, state.specialistCard ? null : selP ?? null);
        const tagged = s.world.phase === 'week' ? [...taggedViewApi.views.values()] : [];
        const host = canvas.getBoundingClientRect();
        renderer.setTaggedViews(tagged.map(view => {
          const r = view.element.getBoundingClientRect();
          const container = view.element.closest('.week-windows');
          const hud = container?.getBoundingClientRect() ?? host;
          return {
            personId: view.personId, mode: view.mode,
            x: r.left - host.left, y: r.top - host.top, width: r.width, height: r.height,
            clipTop: Math.max(r.top, hud.top, host.top) - host.top,
            clipBottom: Math.min(r.bottom, hud.top + (container?.clientHeight ?? hud.height), host.bottom) - host.top,
            clipLeft: Math.max(r.left, hud.left, host.left) - host.left,
            clipRight: Math.min(r.right, hud.left + (container?.clientWidth ?? hud.width), host.right) - host.left,
          };
        }));

        if (state.cameraRequest) {
          renderer.centerOn(state.cameraRequest.x, state.cameraRequest.y);
          if (state.cameraRequest.zoom != null) renderer.setZoom(state.cameraRequest.zoom);
          state.requestCamera(null);
        }

        // Visibility changes and model arrivals can invalidate preparation.
        // Check after applying them, never reuse the empty planning scene's flag.
        const ready = renderer.isPrepared() && !preparationFailed;
        if (!ready) {
          if (!preparing && !preparationFailed) {
            preparing = true;
            readyForInput.current = false;
            boxing.current = false;
            dragging.current = false;
            if (boxRef.current) boxRef.current.hidden = true;
            setCityStatus('opening');
            setOpeningMessage('Preparing the city…');
            void (async () => {
              await yieldForPaint();
              if (!alive) return;
              await renderer.prepare(message => { if (alive) setOpeningMessage(message); });
            })().then(() => {
              if (alive) preparing = false;
            }, error => {
              if (!alive) return;
              preparing = false;
              preparationFailed = true;
              setCityStatus('failed');
              setCityError(error instanceof Error ? error.message : String(error));
              console.error('City preparation failed', error);
            });
          }
          return;
        }

        // First prepared frame releases the overlay; simulation time starts on
        // the next frame, without catching up for any time spent loading.
        if (readyForInput.current && !state.streetLoading) state.advance(dt);
        // Read the fraction after advancing: read before, a frame that ticks draws
        // everyone at the new minute plus last frame's fraction, a jump forward that
        // snaps back next frame (people and cars flickered once a game minute).
        renderer.setSubMinute(s.subMinute);
        renderer.setTimeScale(readyForInput.current && !state.streetLoading && s.world.phase === 'week' && !state.paused ? state.speed : 0);

        // The clock and Stop Skipping control stay live while fast-forwarding;
        // hold the city image instead of spending half the skip drawing it.
        if (!state.finishingWeek && !state.savingSnapshot && state.loadingSave == null) renderer.update();
        // While the blueprint is on the desk the city is under it; no need to draw it.
        if (!state.finishingWeek && !state.savingSnapshot && state.loadingSave == null && !(s.world.phase === 'planning' && state.planningView === 'plan')) renderer.render();
        for (const view of tagged) {
          const status = renderer.taggedViewStatus(view.personId);
          view.element.dataset.flipped = String(status.flipped);
          view.element.dataset.obscured = String(status.obscured);
          view.element.dataset.cutaway = String(status.cutaway);
        }

        // Also a week launched while the streets are already open and prepared:
        // the attract demo goes straight from one week into the next, with no
        // planning desk to close the streets, and would wait on its card forever.
        if (!readyForInput.current || state.streetLoading && s.world.phase === 'week') {
          readyForInput.current = true;
          setCityStatus('ready');
          if (s.world.phase === 'week') useGame.getState().setStreetLoading(false);
        }

        // Refresh the interface a few times a second while the week runs.
        uiAccum += dt;
        if (uiAccum > 0.2) {
          uiAccum = 0;
          if (s.world.phase === 'week' && !state.paused) state.bump();
        }
      };
      raf = requestAnimationFrame(loop);

    };
    void open().catch(error => {
      if (!alive) return;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      removeResizeListener?.();
      ownedRenderer?.dispose();
      if (cameraApi.ref === ownedRenderer) cameraApi.ref = null;
      rendererRef.current = null;
      setCityStatus('failed');
      setCityError(error instanceof Error ? error.message : String(error));
      console.error('City construction failed', error);
    });

    return () => {
      alive = false;
      readyForInput.current = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      removeResizeListener?.();
      ownedRenderer?.dispose();
      if (rendererRef.current === ownedRenderer) rendererRef.current = null;
      if (cameraApi.ref === ownedRenderer) cameraApi.ref = null;
      if (import.meta.env.DEV) {
        const dev = window as unknown as Record<string, unknown>;
        if (dev.__sim === sim) delete dev.__sim;
      }
    };
  }, [sim, renderAttempt]);

  // The menu's demonstration city has nobody to choose what to do about a
  // street view that will not open: it simply goes back to the menu.
  const attract = useGame((s) => s.attract);
  useEffect(() => { if (attract && cityStatus === 'failed') useGame.getState().endAttract(); }, [attract, cityStatus]);

  // Redraw the ground whenever the player changes overlays or buys something.
  const version = useGame((s) => s.version);
  useEffect(() => {
    rendererRef.current?.markDirty(false);
  }, [version]);

  // ------------------------------------------------------------ input

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyForInput.current) return;
    // A fresh press starts a fresh gesture: the previous pan must not
    // swallow this click.
    dragMoved.current = false;
    const state = useGame.getState();
    const areaPick = state.pickMode?.kind === 'lieutenantArea' || state.pickMode?.kind === 'policeArea' ||
      state.pickMode?.kind === 'order' && state.jobCard && ORDERS[state.jobCard.type].target === 'area';
    if (e.button === 0 && (areaPick || state.sim?.world.phase === 'week' && !state.pickMode)) {
      boxing.current = true;
      boxStart.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (e.button === 2 || e.button === 1) {
      dragging.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyForInput.current) return;
    if (boxing.current) {
      const dx = e.clientX - boxStart.current.x;
      const dy = e.clientY - boxStart.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) dragMoved.current = true;
      const box = boxRef.current;
      if (box && dragMoved.current) {
        const rect = canvasRef.current!.getBoundingClientRect();
        box.hidden = false;
        box.style.left = `${Math.min(e.clientX, boxStart.current.x) - rect.left}px`;
        box.style.top = `${Math.min(e.clientY, boxStart.current.y) - rect.top}px`;
        box.style.width = `${Math.abs(dx)}px`;
        box.style.height = `${Math.abs(dy)}px`;
      }
      return;
    }
    if (!dragging.current || !rendererRef.current) return;
    const dx = e.clientX - lastPointer.current.x;
    const dy = e.clientY - lastPointer.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved.current = true;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    // Mouse Reversal (the original's Advanced Options) pans the other way.
    const flip = useGame.getState().mouseReversal ? -1 : 1;
    rendererRef.current.panBy(dx * flip, dy * flip);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (boxing.current) {
      boxing.current = false;
      if (boxRef.current) boxRef.current.hidden = true;
      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      const state = useGame.getState();
      if (dragMoved.current && renderer && canvas && state.sim) {
        // Everyone of yours whose feet fall inside the box.
        const rect = canvas.getBoundingClientRect();
        const x0 = Math.min(e.clientX, boxStart.current.x) - rect.left;
        const x1 = Math.max(e.clientX, boxStart.current.x) - rect.left;
        const y0 = Math.min(e.clientY, boxStart.current.y) - rect.top;
        const y1 = Math.max(e.clientY, boxStart.current.y) - rect.top;
        const w = state.sim.world;
        if (state.pickMode) {
          handleMapBox(activeBlocks(w).filter(b => {
            const p = renderer.project(b.center.x, b.center.y, rect);
            return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
          }).map(b => b.id));
          return;
        }
        const mine = state.sim.playerGang.id;
        const ids: number[] = [];
        for (const p of peopleList(w)) {
          if (p.gangId !== mine || p.status !== 'active') continue;
          const s = renderer.project(p.pos.x, p.pos.y, rect);
          if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) ids.push(p.id);
        }
        if (ids.length) state.selectPeople(e.ctrlKey ? [...new Set([...state.selectedPersonIds, ...ids])] : ids);
        // The click that follows the drag must not undo the selection.
        return;
      }
    }
    if (dragging.current) {
      dragging.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!readyForInput.current) return;
    if (!e.deltaY) return; // a sideways swipe or Shift+wheel
    // In proportion to the turn (a trackpad sends many small deltas), and at
    // most one old wheel notch's worth per event.
    const pixels = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
    rendererRef.current?.zoomBy(Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.0011));
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    const state = useGame.getState();
    const s = state.sim;
    if (!readyForInput.current || !renderer || !canvas || !s) return;
    if (dragMoved.current) return;

    handleMapHit(renderer.pick(e.clientX, e.clientY, canvas.getBoundingClientRect()), { site: e.shiftKey, add: e.ctrlKey });
  };

  const pickMode = useGame((s) => s.pickMode);

  const week = sim?.world.phase === 'week';
  const showStreetLoading = streetLoading || (cityStatus !== 'ready' && week);
  return (
    <>
    <div ref={boxRef} className="select-box" hidden />
    {/* A new canvas for every attempt: one whose graphics context was lost or
        refused keeps handing back the same dead context, so Try Again on the
        old canvas could never succeed. */}
    <canvas
      key={renderAttempt}
      ref={canvasRef}
      aria-busy={streetLoading || cityStatus !== 'ready'}
      className={`city-canvas${pickMode ? ' picking' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { boxing.current = false; dragging.current = false; dragMoved.current = true; if (boxRef.current) boxRef.current.hidden = true; }}
      onWheel={onWheel}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    />
    {showStreetLoading ? <StreetLoading
      message={sim?.world.phase === 'planning' ? 'Saving your orders and getting the week ready…' : openingMessage}
      // Only once the week has opened: before that the orders are still being saved.
      failed={cityStatus === 'failed' && !!week}
      resolving={finishingWeek && !!week}
      progress={week && sim ? `${WEEK_DAYS[dayIndex(sim.world.minute)] ?? 'Fri'} · ${weekTime(sim.world.minute)}` : undefined}
      detail={cityError} attempts={renderAttempt}
      onRetry={() => setRenderAttempt(n => n + 1)}
      onSkip={() => { void useGame.getState().runWeekUnseen(); }}
      onStop={() => useGame.getState().cancelFinishWeek()}
      onExit={() => useGame.getState().setScreen('menu')} /> :
    cityStatus !== 'ready' && <div className="city-opening">
      <div className="paper city-opening-card">
        <p role={cityStatus === 'failed' ? 'alert' : 'status'}>
          {cityStatus === 'failed' ? 'The city could not be displayed.' : 'Opening city…'}
        </p>
        {cityStatus === 'failed' && <button className="btn" onClick={() => setRenderAttempt(n => n + 1)}>Try again</button>}
      </div>
    </div>}
    </>
  );
}
