import { describe, expect, it, vi } from 'vitest';
import { CityRenderer, type OverlayKind } from '../src/render/scene';
import { TaggedViews } from '../src/render/taggedView';
import type { WorldState } from '../src/sim/types';

// Exercise the renderer's real invalidation path without requiring a GPU.
function fixture(overlays: OverlayKind[] = ['territory']) {
  const world = {
    week: 1, gridW: 1, gridH: 1,
    blocks: [{ id: 0, gx: 0, gy: 0, lotIds: Array.from({ length: 9 }, (_, i) => i),
      landValue: 50, crimeHeat: 9.1, policePresence: 2.1 }],
    lots: Array.from({ length: 9 }, (_, i) => ({ id: i, buildingId: i })),
    buildings: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, {
      id: i, blockId: 0, lotId: i, typeId: 'cafe', cls: 'commercial', state: 'trading',
      ownerGangId: null, protection: null, isHQ: false, ownerPersonId: i + 10, knowledge: { 0: 3, 1: 3 },
    }])),
    people: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 10, { opinion: { 0: 10, 1: -20 } }])),
    gangs: { 0: { color: 'red', teamIds: [] }, 1: { color: 'blue', teamIds: [] } }, teams: {}, crimes: [],
  } as unknown as WorldState;
  const drawGround = vi.fn(), refreshBuildings = vi.fn();
  const city = Object.assign(Object.create(CityRenderer.prototype), {
    world, overlays, overlayGang: 0, overlayTeamBlocks: [],
    groundSig: null, buildingSig: -1, groundDirty: true, buildingsDirty: true,
    lastFrame: 0, clock: 0, simClock: 0, timeScale: 0, streetsOpen: false,
    hiddenRoofs: false, buildingsRemoved: false, foregroundCutaways: new Set(),
    characterActions: {update:vi.fn()}, updateForegroundCutaways:vi.fn(), tagged:new TaggedViews(),
    drawGround, refreshBuildings, applyTimeOfDay: () => 0,
    refreshStreet: vi.fn(), actorMotion: { clear: vi.fn() },
  }) as CityRenderer;
  const redraw = () => { city.markDirty(); city.update(); };
  redraw();
  return { city, world, drawGround, refreshBuildings, redraw };
}

describe('road texture invalidation', () => {
  it('hides unknown rival control and refreshes the facade and territory as sites are discovered', () => {
    const f = fixture();
    for (const b of Object.values(f.world.buildings)) { b.knowledge[0] = 0; b.ownerGangId = 1; }
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(1);
    expect(f.refreshBuildings).toHaveBeenCalledTimes(1);
    f.world.buildings[0].knowledge[0] = 3; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    expect(f.refreshBuildings).toHaveBeenCalledTimes(2);
    f.world.buildings[1].knowledge[0] = f.world.buildings[2].knowledge[0] = 3; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    expect(f.refreshBuildings).toHaveBeenCalledTimes(3);
    f.city.setOverlays(['territory'], 1); f.city.update();
    expect(f.refreshBuildings).toHaveBeenCalledTimes(4);
  });

  it('uploads only when the set of claimed border colours changes', () => {
    const f = fixture();
    f.world.buildings[0].ownerGangId = 0; f.redraw();
    f.world.buildings[1].ownerGangId = 0; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.world.buildings[2].ownerGangId = 0; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    for (const id of [3, 4, 5]) f.world.buildings[id].ownerGangId = 1;
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(3);
    f.world.buildings[5].ownerGangId = 0; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(3); // Both gangs still claim the block.
    for (const id of [3, 4]) f.world.buildings[id].ownerGangId = 0;
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(4);
    f.world.gangs[0].color = 'blue'; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(5);
    expect(f.refreshBuildings.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps protection claims until their last surviving premises are destroyed', () => {
    const f = fixture();
    for (const id of [0, 1]) f.world.buildings[id].protection = { gangId: 0 } as NonNullable<WorldState['buildings'][number]['protection']>;
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    for (const id of [6, 7, 8]) f.world.buildings[id].state = 'destroyed';
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.world.buildings[0].state = 'destroyed'; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.world.buildings[1].state = 'destroyed'; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(3);
  });

  it.each(['crime', 'security', 'events'] as const)('tracks fractional %s wash changes', overlay => {
    const f = fixture([overlay]);
    if (overlay === 'security') f.world.blocks[0].policePresence += .1;
    else if (overlay === 'events') f.world.crimes.push({ id: 1, week: 1, reported: true, buildingId: 0 } as WorldState['crimes'][number]);
    else f.world.blocks[0].crimeHeat += .1;
    f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
  });

  it('updates hostility when opinions or the viewed gang change', () => {
    const f = fixture(['hostility']);
    f.world.people[10].opinion[0] = 50; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.city.setOverlays(['hostility'], 1); f.city.update();
    expect(f.drawGround).toHaveBeenCalledTimes(3);
  });

  it('honours wash precedence and allocation changes without uploading hidden changes', () => {
    const f = fixture(['lieutenant', 'landValue', 'crime']);
    f.city.setOverlays(['lieutenant', 'landValue', 'crime'], 0, [0]); f.city.update();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.world.blocks[0].landValue = 80; f.world.blocks[0].crimeHeat = 30; f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    f.city.setOverlays(['lieutenant', 'landValue', 'crime'], 0, []); f.city.update();
    expect(f.drawGround).toHaveBeenCalledTimes(3);
    f.city.setOverlays([], 0); f.city.update();
    expect(f.drawGround).toHaveBeenCalledTimes(4);
  });

  it('keeps road pixels through building-only and week changes, and invalidates a replaced world', () => {
    const f = fixture();
    f.world.week++; f.world.buildings[0].isHQ = true;
    f.city.setHiddenRoofs(true); f.redraw();
    expect(f.drawGround).toHaveBeenCalledTimes(1);
    expect(f.refreshBuildings).toHaveBeenCalledTimes(2);
    const before = structuredClone(f.world);
    f.city.setWorld(structuredClone(f.world)); f.city.update();
    expect(f.drawGround).toHaveBeenCalledTimes(2);
    expect(f.world).toEqual(before);
  });
});
