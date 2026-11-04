import { beforeEach, describe, expect, it } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { useGame } from '../src/app/store';
import { blockOrderSites, orderPeopleBySite, selectableOrderSite, selectedOrderSites } from '../src/app/orderSelection';
import { specialistPeopleBySite } from '../src/app/specialistSelection';
import { cancelOrder, issueOrder, previewOrder, replaceOrder } from '../src/sim/api';
import { ORDERS } from '../src/sim/constants';
import { activeBlocks } from '../src/sim/cityLayout';
import { expandTargets } from '../src/sim/execution';
import { Sim } from '../src/sim/sim';
import { handleMapBox, handleMapHit } from '../src/ui/mapClick';
import type { Building, OrderType } from '../src/sim/types';
import { buildingsOfBlock } from '../src/sim/world';

let sim: Sim;
const state = () => useGame.getState();
const card = () => state().jobCard!;
const selected = () => selectedOrderSites(sim.world, sim.playerGang.id, card());
const begin = (type: OrderType) => state().beginOrder(type, sim.playerGang.teamIds[0]);
const hit = (b: Building, site = false) => handleMapHit({ buildingId: b.id, blockId: b.blockId, personId: null, point: sim.world.lots[b.lotId].center }, { site });
beforeEach(() => {
  sim = new Sim({ ...defaultGameOptions(), citySize: 10, seed: 404 });
  useGame.setState({ sim, jobCard: null, specialistCard: null, pickMode: null, sheet: null, policeAreaBlockIds: [], organizerCollapsed: false });
});

describe('planning map selection', () => {
  it('repeating a bound clears it, and a partly overlapping bound adds its new blocks', () => {
    begin('extort'); const w = sim.world, g = sim.playerGang;
    const [a, b, c] = activeBlocks(w).filter(block => blockOrderSites(w, g.id, card(), block.id).length);
    handleMapBox([a.id, b.id]);
    handleMapBox([b.id, c.id]);
    expect(card().blockIds).toEqual([a.id, b.id, c.id]);
    expect(new Set(selected()).size).toBe(selected().length);
    handleMapBox([c.id, b.id, b.id, -1]);
    expect(card().blockIds).toEqual([a.id]);
    expect(selected()).toEqual(blockOrderSites(w, g.id, card(), a.id));
    handleMapBox([a.id]); expect(selected()).toEqual([]);
    handleMapBox([a.id]); expect(selected().length).toBeGreaterThan(0);
  });

  it('clears a fully selected bound even when its sites were picked individually', () => {
    begin('extort'); const w = sim.world, g = sim.playerGang;
    const [a, b] = activeBlocks(w).filter(block => blockOrderSites(w, g.id, card(), block.id).length);
    const sites = blockOrderSites(w, g.id, card(), a.id);
    for (const site of sites) hit(w.buildings[site], true);
    handleMapBox([b.id]);
    handleMapBox([a.id]);
    expect(card().buildingIds).toEqual([]);
    expect(card().blockIds).toEqual([b.id]);
    expect(previewOrder(w, g.id, card())!.targetBuildingIds).not.toEqual(expect.arrayContaining(sites));
  });

  it('repeating a lieutenant-area bound removes only that area, including merged blocks', () => {
    const w = sim.world, team = w.teams[sim.playerGang.teamIds[0]];
    const hasBusiness = (id: number) => buildingsOfBlock(w, w.blocks[id]).some(b => ['commercial', 'industrial', 'tenement'].includes(b.cls));
    const merged = w.blocks.find(b => b.layout?.mergedInto != null && hasBusiness(b.layout.mergedInto))!;
    const root = merged.layout!.mergedInto!, other = activeBlocks(w).find(b => b.id !== root && hasBusiness(b.id))!;
    for (const block of [w.blocks[root], other]) for (const b of buildingsOfBlock(w, block)) b.ownerGangId = sim.playerGang.id;
    team.allocatedBlockIds = [other.id];
    useGame.setState({ pickMode: { kind: 'lieutenantArea', teamId: team.id } });
    handleMapBox([merged.id, root, root]);
    expect(team.allocatedBlockIds).toEqual([other.id, root]);
    handleMapBox([merged.id, root]);
    expect(team.allocatedBlockIds).toEqual([other.id]);
  });

  it('box adds eligible blocks, click toggles, single-site removal overrides its boxed block', () => {
    begin('extort');
    const w = sim.world, g = sim.playerGang;
    const block = activeBlocks(w).find(b => blockOrderSites(w, g.id, card(), b.id).length >= 3)!;
    const ids = blockOrderSites(w, g.id, card(), block.id), first = w.buildings[ids[0]];
    handleMapBox([block.id, block.id, -1]);
    expect(card().blockIds).toEqual([block.id]); expect(selected()).toEqual(ids);
    hit(first, true);
    expect(card().blockIds).toEqual([]); expect(selected()).toEqual(ids.slice(1));
    expect(previewOrder(w, g.id, card())!.targetBuildingIds).not.toContain(first.id);
    hit(first, true); expect(new Set(selected())).toEqual(new Set(ids));
    hit(first); expect(selected()).toEqual([]);
    hit(first); expect(selected()).toEqual(ids);
    const invalid = Object.values(w.buildings).find(b => b.cls === 'municipal')!;
    hit(invalid, true); expect(selected()).toEqual(ids);
    state().updateJobCard({ blockIds: [], buildingIds: [], personId: null, pos: null });
    expect(selected()).toEqual([]);
  });

  it('excludes empty recruit areas and clears a block whose only valid site is selected', () => {
    begin('recruit'); const w = sim.world, g = sim.playerGang;
    const blocks = activeBlocks(w), good = blocks.filter(b => blockOrderSites(w, g.id, card(), b.id).length);
    const bad = blocks.find(b => !blockOrderSites(w, g.id, card(), b.id).length)!;
    handleMapBox([good[0].id, bad.id]);
    const extraSites = blockOrderSites(w, g.id, card(), good[1].id);
    expect(extraSites).toHaveLength(1);
    const extra = extraSites[0]; hit(w.buildings[extra], true);
    expect(card().blockIds).toEqual([good[0].id]); expect(card().buildingIds).toEqual([extra]);
    handleMapBox([good[1].id]);
    expect(card().buildingIds).toEqual([]); expect(card().blockIds).toEqual([good[0].id]);
    handleMapBox([good[1].id]);
    expect(card().buildingIds).toEqual([]); expect(card().blockIds).toEqual([good[0].id, good[1].id]);
    expect(new Set(selected()).size).toBe(selected().length);
  });

  it.each(['patrol', 'collectProtection'] as const)('%s starts with the lieutenant’s valid allocated territory', type => {
    const w = sim.world, g = sim.playerGang, team = w.teams[g.teamIds[0]];
    const own = Object.values(w.buildings).find(b => b.protection?.gangId === g.id)!;
    team.allocatedBlockIds = [own.blockId]; begin(type);
    expect(card().blockIds).toEqual([own.blockId]);
    expect(selected().length).toBeGreaterThan(0);
    state().cancelJobCard(); expect(team.orderIds).toEqual([]); expect(team.timeUsed).toBe(0);
  });

  it('selects a known owner through their building and does not expose a hidden rival HQ', () => {
    begin('bribe'); const w = sim.world, g = sim.playerGang;
    const site = Object.values(w.buildings).find(b => b.ownerPersonId != null && b.cls === 'commercial')!;
    hit(site); expect(card().personId).toBe(site.ownerPersonId);
    expect(orderPeopleBySite(w, g.id, 'bribe').get(site.id)).toBe(site.ownerPersonId);
    const hidden = Object.values(w.buildings).find(b => b.isHQ && b.ownerGangId !== g.id)!;
    expect(orderPeopleBySite(w, g.id, 'kill').has(hidden.id)).toBe(false);
    begin('kidnap'); hit(site); expect(card().personId).toBeNull();
  });

  it('building and point orders reject unrelated map targets', () => {
    begin('donate'); const w = sim.world;
    const shop = Object.values(w.buildings).find(b => b.cls === 'commercial')!, church = Object.values(w.buildings).find(b => b.cls === 'charity')!;
    hit(shop); expect(card().buildingIds).toEqual([]);
    hit(church); expect(card().buildingIds).toEqual([church.id]);
    begin('goTo'); handleMapHit({ buildingId: null, blockId: null, personId: null, point: { x: 0, y: 0 } });
    expect(card().pos).toBeNull(); hit(shop); expect(card().pos).toEqual(w.lots[shop.lotId].center);
  });

  it.each(Object.values(ORDERS).filter(d => d.target === 'building').map(d => d.type))('%s advertises sites the API can accept', type => {
    const w = sim.world, g = sim.playerGang;
    const warehouse = Object.values(w.buildings).find(b => b.typeId === 'warehouse')!; warehouse.ownerGangId = g.id;
    if(type==='export')w.teams[g.teamIds[0]].vehicles.truck=1;
    // The API refuses what the gang cannot pay for or carry out (B#15).
    g.cash = 1_000_000; g.weapons.explosives = 1;
    begin(type);
    if (type === 'setUpBusiness') state().updateJobOpts({ businessTypeId: 'cafe' });
    const sites = Object.values(w.buildings).filter(b => selectableOrderSite(w, g.id, card(), b) && (type !== 'setUpBusiness' || w.lots[b.lotId].index !== 4));
    expect(sites.length).toBeGreaterThan(0);
    hit(sites[0]); const res = issueOrder(w, g.id, card()); expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(w.orders[w.teams[g.teamIds[0]].orderIds[0]].targetBuildingIds).toEqual([sites[0].id]);
  });
});

describe('confirmed planning orders', () => {
  it('cancelled/failed edits preserve the old job and successful edits replace its budget only once', () => {
    begin('extort'); const w = sim.world, g = sim.playerGang, team = w.teams[g.teamIds[0]];
    const blocks = activeBlocks(w).filter(b => blockOrderSites(w, g.id, card(), b.id).length > 0);
    const site = blockOrderSites(w, g.id, card(), blocks[0].id)[0]; hit(w.buildings[site], true);
    expect(issueOrder(w, g.id, card()).ok).toBe(true);
    const id = team.orderIds[0], before = JSON.stringify(w);
    state().updateJobCard({ editingOrderId: id }); state().cancelJobCard(); expect(JSON.stringify(w)).toBe(before);
    begin('extort'); state().updateJobCard({ editingOrderId: id });
    expect(replaceOrder(w, g.id, id, card()).ok).toBe(false); expect(JSON.stringify(w)).toBe(before);
    hit(w.buildings[site], true); state().updateJobOpts({ priority: true, wait: true, manpower: 2 });
    const estimate = previewOrder(w, g.id, card())!.estimatedMinutes;
    expect(replaceOrder(w, g.id, id, card()).ok).toBe(true);
    expect(team.orderIds).toHaveLength(1); expect(w.orders[id]).toBeUndefined(); expect(team.timeUsed).toBe(estimate);
    expect(w.orders[team.orderIds[0]].opts).toMatchObject({ priority: true, wait: true, manpower: 2 });
    expect(cancelOrder(w, team.orderIds[0]).ok).toBe(true); expect(team.timeUsed).toBe(0);
  });

  it('leaves the farthest sites off an area too big for the week, as the original does, and keeps options through save/load', () => {
    begin('extort'); const w = sim.world, g = sim.playerGang, team = w.teams[g.teamIds[0]];
    handleMapBox(activeBlocks(w).map(b => b.id));
    // The selection itself is trimmed as it is made: only what the crew has time for stays.
    const trimmed = card();
    expect(trimmed.trimmed?.dropped).toBeGreaterThan(0);
    expect(trimmed.blockIds).toEqual([]);
    expect(team.orderIds).toEqual([]);
    expect(issueOrder(w, g.id, trimmed).ok).toBe(true);
    const order = w.orders[team.orderIds[0]];
    expect(order.targetBuildingIds).toEqual(trimmed.buildingIds);
    expect(order.targetBuildingIds).toEqual(expandTargets(w, g.id, card().type, card().blockIds, card().buildingIds));
    const restored = Sim.fromSave(JSON.parse(JSON.stringify(w)));
    expect(restored.world.orders[order.id]).toEqual(order);
  });
});

describe('specialist planning targets', () => {
  it('selects street officials or audit premises and ignores unrelated people', () => {
    const w = sim.world, g = sim.playerGang;
    state().beginSpecialistOrder('bribeOfficials');
    const personId = w.policeChiefId;
    handleMapHit({ personId, blockId: null, buildingId: null, point: w.people[personId].pos });
    expect(state().specialistCard?.personId).toBe(personId);
    const boss = w.people[g.bossId];
    handleMapHit({ personId: boss.id, blockId: null, buildingId: null, point: boss.pos });
    expect(state().specialistCard?.personId).toBe(personId);
    expect(Object.values(w.specialistJobs ?? {})).toEqual([]);
    state().cancelSpecialistCard(); expect(state().pickMode).toBeNull();
    state().beginSpecialistOrder('audit');
    const [siteId, managerId] = [...specialistPeopleBySite(w, g.id, 'audit')][0];
    hit(w.buildings[siteId]); expect(state().specialistCard?.personId).toBe(managerId);
  });

  it('bounds and clears a police area across merged blocks without creating a tour', () => {
    state().beginSpecialistOrder('employPolice');
    const merged = sim.world.blocks.find(b => b.layout?.mergedInto != null)!;
    const root = merged.layout!.mergedInto!;
    handleMapBox([merged.id, root, root, -1]);
    expect(state().policeAreaBlockIds).toEqual([root]);
    handleMapBox([root]); expect(state().policeAreaBlockIds).toEqual([]);
    handleMapBox([merged.id]); expect(state().policeAreaBlockIds).toEqual([root]);
    handleMapHit({ personId: null, blockId: root, buildingId: null, point: sim.world.blocks[root].center });
    expect(state().policeAreaBlockIds).toEqual([]);
    state().setOrganizerCollapsed(true); state().cancelSpecialistCard();
    expect(state().organizerCollapsed).toBe(false);
    expect(Object.values(sim.world.specialistJobs ?? {})).toEqual([]);
  });

  it('selects only its own audit subjects and clears a draft when changing organizer tabs', () => {
    const w = sim.world, g = sim.playerGang;
    state().beginSpecialistOrder('audit');
    const own = w.people[w.teams[g.teamIds[0]].lieutenantId];
    state().selectSpecialistTarget(own.id); expect(state().specialistCard?.personId).toBe(own.id);
    state().selectSpecialistTarget(w.policeChiefId); expect(state().specialistCard?.personId).toBe(own.id);
    state().setTab('lawyer');
    expect(state().specialistCard).toBeNull(); expect(state().pickMode).toBeNull();
    expect(w.auditTargets[g.id]).toBeUndefined();
  });
});
