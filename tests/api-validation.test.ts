import { describe, expect, it } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { allocateBlocks, buyVehicle, buyWeapon, issueOrder, issueStreetOrder, nearTerritory, sellVehicle, sellWeapon, transferVehicle, transferWeapon } from '../src/sim/api';
import type { ApiResult, IssueOrderInput } from '../src/sim/api';
import { CELL, MINUTES_PER_WEEK, ORDERS } from '../src/sim/constants';
import { isValidAreaTarget } from '../src/sim/execution';
import { Sim } from '../src/sim/sim';
import type { WorldState } from '../src/sim/types';
import { allBuildings, CENTRE_LOT } from '../src/sim/world';
import { staffFirstCrew } from './helpers/crew';

function fixture() {
  const sim = new Sim({ ...defaultGameOptions(), seed: 404, citySize: 10, startMoney: 50_000, startHoods: 8 });
  staffFirstCrew(sim);
  const w = sim.world;
  const gang = sim.playerGang;
  const team = w.teams[gang.teamIds[0]];
  const rival = Object.values(w.teams).find((t) => t.gangId !== gang.id)!;
  return { w, gang, team, rival };
}

function rejectsWithoutMutation(w: WorldState, call: () => ApiResult) {
  const before = JSON.stringify(w);
  expect(call().ok).toBe(false);
  expect(JSON.stringify(w)).toBe(before);
}

describe('resource ownership', () => {
  it.each(['rival', 'missing'] as const)('rejects every resource operation with a %s crew', (kind) => {
    const { w, gang, rival } = fixture();
    const id = kind === 'rival' ? rival.id : 99999999;
    gang.weapons.pistol = rival.weapons.pistol = 2;
    gang.vehicles.coupe = rival.vehicles.coupe = 2;
    const calls = [
      () => buyWeapon(w, gang.id, 'pistol', id), () => sellWeapon(w, gang.id, 'pistol', id),
      () => buyVehicle(w, gang.id, 'coupe', id), () => sellVehicle(w, gang.id, 'coupe', id),
      () => transferWeapon(w, gang.id, 'pistol', id, true), () => transferWeapon(w, gang.id, 'pistol', id, false),
      () => transferVehicle(w, gang.id, 'coupe', id, true), () => transferVehicle(w, gang.id, 'coupe', id, false),
      () => allocateBlocks(w, gang.id, id, [0]),
    ];
    for (const call of calls) rejectsWithoutMutation(w, call);
  });

  it('keeps valid cache and own-crew transfers, sales and allocation working', () => {
    const { w, gang, team } = fixture();
    const cash = gang.cash;
    const pistols = gang.weapons.pistol ?? 0;
    expect(buyWeapon(w, gang.id, 'pistol').ok).toBe(true);
    expect(transferWeapon(w, gang.id, 'pistol', team.id, true).ok).toBe(true);
    expect(transferWeapon(w, gang.id, 'pistol', team.id, false).ok).toBe(true);
    expect(sellWeapon(w, gang.id, 'pistol').ok).toBe(true);
    expect(gang.weapons.pistol).toBe(pistols);
    expect(gang.cash).toBe(cash - 50);
    const cars = team.vehicles.coupe ?? 0;
    expect(buyVehicle(w, gang.id, 'coupe', team.id).ok).toBe(true);
    expect(transferVehicle(w, gang.id, 'coupe', team.id, false).ok).toBe(true);
    expect(transferVehicle(w, gang.id, 'coupe', team.id, true).ok).toBe(true);
    expect(sellVehicle(w, gang.id, 'coupe', team.id).ok).toBe(true);
    expect(team.vehicles.coupe).toBe(cars);
    for (const b of Object.values(w.buildings)) if (b.blockId === 0 || b.blockId === 1) b.ownerGangId = gang.id;
    expect(allocateBlocks(w, gang.id, team.id, [0, 0, 1]).ok).toBe(true);
    expect(team.allocatedBlockIds).toEqual([0, 1]);
    rejectsWithoutMutation(w, () => allocateBlocks(w, gang.id, team.id, [0, 99999999]));
  });
});

describe('order validation is atomic', () => {
  it.each(Object.values(ORDERS))('rejects missing targets for $type without consuming an ID or time', (def) => {
    const { w, gang, team } = fixture();
    const input: IssueOrderInput = { teamId: team.id, type: def.type };
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, input));
    if (def.target === 'area' || def.target === 'building') input.buildingIds = [99999999];
    if (def.target === 'person') input.personId = 99999999;
    if (def.target === 'point') input.pos = { x: NaN, y: 10 };
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, input));
  });

  it('caps manpower at the Crime.xtx maximum for the order', () => {
    const { w, gang, team } = fixture();
    expect(team.memberIds.length + 1).toBeGreaterThan(4);
    const target = allBuildings(w).find(b => b.ownerGangId !== gang.id && b.ownerPersonId != null)!;
    const before = JSON.stringify(w);
    const result = issueOrder(w, gang.id, { teamId: team.id, type: 'smashUp', buildingIds: [target.id], opts: { manpower: 5 } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('at most 4');
    expect(JSON.stringify(w)).toBe(before);
    expect(ORDERS.kill.maxManpower).toBe(4);
    expect(ORDERS.collectProtection.maxManpower).toBe(10);
    expect(ORDERS.buyPremises.maxManpower).toBe(2);
  });

  it('rejects invalid area sites whether selected alone or mixed with valid sites', () => {
    const { w, gang, team } = fixture();
    const site = allBuildings(w).find((b) => isValidAreaTarget(w, gang.id, 'extort', b))!;
    const church = allBuildings(w).find((b) => b.cls === 'charity')!;
    for (const buildingIds of [[church.id], [site.id, church.id], [site.id, 99999999]]) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type: 'extort', buildingIds }));
    }
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type: 'explore', blockIds: [0, 99999999] }));
    site.state = 'destroyed';
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type: 'explore', buildingIds: [site.id] }));
  });

  it('rejects wrong building types, ownership and destroyed sites', () => {
    const { w, gang, team } = fixture();
    const hq = allBuildings(w).find((b) => b.ownerGangId === gang.id && b.isHQ)!;
    for (const type of ['buyPremises', 'export', 'donate'] as const) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type, buildingIds: [hq.id] }));
    }
    const rivalSite = allBuildings(w).find((b) => b.ownerGangId != null && b.ownerGangId !== gang.id)!;
    for (const type of ['runBusiness', 'guardBusiness', 'setUpBusiness'] as const) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type, buildingIds: [rivalSite.id] }));
    }
    rivalSite.state = 'destroyed';
    for (const type of ['raid', 'smashUp', 'torch', 'bomb'] as const) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type, buildingIds: [rivalSite.id] }));
    }
  });

  it('rejects unavailable people and non-rival kidnapping', () => {
    const { w, gang, team, rival } = fixture();
    for (const status of ['dead', 'jailed', 'kidnapped'] as const) {
      w.people[rival.lieutenantId].status = status;
      for (const type of ['kill', 'assault', 'kidnap', 'bribe'] as const) {
        rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type, personId: rival.lieutenantId }));
      }
    }
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type: 'kidnap', personId: team.lieutenantId }));
  });

  it('requires an owned standing front on the same block with capacity for the chosen business', () => {
    const { w, gang, team, rival } = fixture();
    const centre = Object.values(w.lots).find(l=>l.index===CENTRE_LOT&&w.buildings[l.buildingId].cls==='empty')!;
    const land = w.buildings[centre.buildingId], block = w.blocks[land.blockId];
    const frontLot=block.lotIds.map(id=>w.lots[id]).find(l=>l.index!==CENTRE_LOT)!;
    const front = w.buildings[frontLot.buildingId];
    land.ownerGangId = front.ownerGangId = gang.id;
    front.cls = 'commercial';
    front.typeId = 'cafe';
    front.state = 'trading';
    front.hidesId = null;
    const input: IssueOrderInput = { teamId: team.id, type: 'setUpBusiness', buildingIds: [land.id], opts: { businessTypeId: 'casino', frontBuildingId: front.id } };
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { ...input, opts: { businessTypeId: 'casino' } }));
    for (const patch of [
      { ownerGangId: rival.gangId }, { state: 'destroyed' as const }, { state: 'ceased' as const },
      { cls: 'empty' as const }, { cls: 'illegal' as const }, { blockId: (block.id + 1) % w.blocks.length }, { hidesId: 99999999 },
    ]) {
      const original = { ...front };
      Object.assign(front, patch);
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, input));
      Object.assign(front, original);
    }
    expect(issueOrder(w, gang.id, input).ok).toBe(true);
  });

  it('uses the same eligibility rules for explicit protection and recruitment targets as whole blocks', () => {
    const { w, gang, team } = fixture();
    const site = allBuildings(w).find((b) => b.typeId === 'church')!;
    site.protection = null;
    for (const type of ['collectProtection', 'adjustProtection', 'intimidate', 'recruit'] as const) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type, buildingIds: [site.id] }));
    }
  });

  it('rejects nonfinite and out-of-city positions', () => {
    const { w, gang, team } = fixture();
    for (const pos of [{ x: -1, y: 0 }, { x: 0, y: Infinity }, { x: NaN, y: 0 }, { x: w.gridW * CELL, y: 0 }]) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { teamId: team.id, type: 'goTo', pos }));
    }
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'goTo', pos: w.blocks[0].center }).ok).toBe(true);
  });

  it('rejects invalid manpower, crew preference and exhausted time without allocating IDs', () => {
    const { w, gang, team, rival } = fixture();
    const site = allBuildings(w).find((b) => isValidAreaTarget(w, gang.id, 'explore', b))!;
    const input: IssueOrderInput = { teamId: team.id, type: 'explore', buildingIds: [site.id] };
    for (const manpower of [0, -1, 0.5, NaN, Infinity, 99]) {
      rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { ...input, opts: { manpower } }));
    }
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, { ...input, opts: { preferredHoodId: rival.lieutenantId } }));
    team.timeUsed = MINUTES_PER_WEEK;
    rejectsWithoutMutation(w, () => issueOrder(w, gang.id, input));
  });

  it('accepts valid building, area and person selections and snapshots caller arrays', () => {
    const { w, gang, team, rival } = fixture();
    const site = allBuildings(w).find((b) => b.cls === 'empty' && b.ownerGangId == null && nearTerritory(w, gang.id, b.blockId, 2))!;
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'buyPremises', buildingIds: [site.id] }).ok).toBe(true);
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'assault', personId: rival.lieutenantId }).ok).toBe(true);
    team.timeUsed = 0;
    const blockIds = [0];
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'explore', blockIds, opts: { manpower: 4 } }).ok).toBe(true);
    const order = w.orders[team.orderIds.at(-1)!];
    blockIds.push(99999999);
    expect(order.targetBlockIds).toEqual([0]);
  });

  it('validates street targets and every actor before detaching anyone from orders', () => {
    const { w, gang, team, rival } = fixture();
    const actor = w.people[team.lieutenantId];
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'goTo', pos: actor.pos }).ok).toBe(true);
    actor.orderId = team.orderIds[0];
    w.orders[actor.orderId].assignedIds = [actor.id];
    for (const target of [null, 99999999, actor.id]) {
      for (const type of ['kill', 'assault', 'tail'] as const) {
        rejectsWithoutMutation(w, () => issueStreetOrder(w, gang.id, [actor.id], type, target, null));
      }
    }
    rejectsWithoutMutation(w, () => issueStreetOrder(w, gang.id, [actor.id, rival.lieutenantId], 'goTo', null, actor.pos));
    rejectsWithoutMutation(w, () => issueStreetOrder(w, gang.id, [actor.id], 'goTo', null, { x: NaN, y: 0 }));
    expect(issueStreetOrder(w, gang.id, [actor.id], 'tail', rival.lieutenantId, null).ok).toBe(true);
    expect(actor.orderId).toBeNull();
    // He keeps his place on the planned order, to go back to it (R-02).
    expect(w.orders[team.orderIds[0]].assignedIds).toEqual([actor.id]);
    expect(actor.resumeOrderId).toBe(team.orderIds[0]);
  });
});
