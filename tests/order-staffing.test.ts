import { describe, expect, it } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { cancelOrder, issueOrder, moveToTeam, rolloverOrders, setWaiting, type IssueOrderInput } from '../src/sim/api';
import { MINUTES_PER_WEEK, MAX_TEAM_SIZE } from '../src/sim/constants';
import { estimateMinutes, tickOrders } from '../src/sim/execution';
import { clearDestination } from '../src/sim/movement';
import { validateSaveWorld, validateSaveWorldResponsive } from '../src/sim/saveSchema';
import { Sim, MINUTES_PER_SECOND } from '../src/sim/sim';
import { buildingDoor } from '../src/sim/world';
import type { Order, PersonStatus } from '../src/sim/types';

function fixture() {
  const sim = new Sim({ ...defaultGameOptions(), seed: 404, citySize: 10, startMoney: 100_000 });
  const w = sim.world, g = sim.playerGang, t = w.teams[g.teamIds[0]];
  w.orders = {};
  for (const team of Object.values(w.teams)) { team.orderIds = []; team.timeUsed = 0; }
  t.vehicles = { coupe: 0, truck: 0, speedster: 0 };
  const hq = Object.values(w.buildings).find(b => b.isHQ && b.ownerGangId === g.id)!;
  return { sim, w, g, t, hq };
}
type Fixture = ReturnType<typeof fixture>;
function queue(s: Fixture, input: Omit<IssueOrderInput, 'teamId'>): Order {
  const result = issueOrder(s.w, s.g.id, { ...input, teamId: s.t.id });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return s.w.orders[s.t.orderIds.at(-1)!];
}
function advanceUntil(sim: Sim, predicate: () => boolean, limit = MINUTES_PER_WEEK) {
  for (let n = 0; n < limit && !predicate(); n++) sim.advance(1 / MINUTES_PER_SECOND, 1);
  expect(predicate()).toBe(true);
}
function settleOrders(sim: Sim) {
  // Exercise the real settlement stage without simulating unrelated full weeks.
  sim.world.phase = 'week'; sim.world.minute = MINUTES_PER_WEEK;
  sim.world.settlementStage = 0; sim.finishWeekSlice(0);
  expect(sim.world.settlementStage).toBe(1);
}

describe('requested manpower and actual dispatch', () => {
  it.each(['beaten', 'arrested', 'jailed', 'dead'] satisfies PersonStatus[])('rejects unavailable manpower atomically (%s)', status => {
    const s = fixture(), p = s.w.people[s.t.memberIds[0]];
    p.status = status;
    for (const opts of [{ manpower: 2 }, { manpower: 1, preferredHoodId: p.id }]) {
      const before = JSON.stringify(s.w);
      const result = issueOrder(s.w, s.g.id, { teamId: s.t.id, type: 'explore', buildingIds: [s.hq.id], opts });
      expect(result.ok).toBe(false); expect(JSON.stringify(s.w)).toBe(before);
    }
  });

  it('lets an arrested lieutenant direct an available hood, but does not send the lieutenant', () => {
    const s = fixture(); s.w.people[s.t.lieutenantId].status = 'arrested';
    const order = queue(s, { type: 'explore', buildingIds: [s.hq.id] });
    s.sim.launchWeek();
    expect(order.assignedIds).toEqual(s.t.memberIds);
  });

  it('waits for the entire requested party, then turns the returning man round for the next job', () => {
    const s = fixture();
    expect(moveToTeam(s.w, s.g.id, s.g.poolIds[0], s.t.id).ok).toBe(true);
    const charity = Object.values(s.w.buildings).find(b => b.cls === 'charity')!;
    const first = queue(s, { type: 'donate', buildingIds: [charity.id], opts: { manpower: 1, amount: 1000 } });
    const second = queue(s, { type: 'explore', buildingIds: [s.hq.id], opts: { manpower: 3 } });
    s.sim.launchWeek();
    expect(first.assignedIds).toHaveLength(1);
    expect(second.state).toBe('queued'); expect(second.assignedIds).toEqual([]);
    expect(second.dispatchWaitReason).toMatch(/3 people; 2 are free/);
    const returning = s.w.people[first.assignedIds[0]];
    advanceUntil(s.sim, () => first.state === 'done');
    // As in the original he goes straight on to the next job: he is not made
    // to walk back to the office first while the queued order waits.
    expect(second.state).not.toBe('queued');
    expect(returning.orderId).toBe(second.id);
    expect(second.assignedIds).toHaveLength(3);
    expect(second.assignedIds).toContain(returning.id);
    expect(second.dispatchWaitReason).toBeUndefined();
    expect(new Set(second.assignedIds).size).toBe(3);
    expect(s.w.messages.filter(m => m.text.includes('Explore is queued:'))).toHaveLength(1);
  });

  it('keeps a preferred-person wait through saves, with one alert and no substitute', () => {
    const s = fixture(), preferred = s.t.memberIds[0];
    const first = queue(s, { type: 'goTo', pos: buildingDoor(s.w, s.hq), opts: { preferredHoodId: preferred } });
    const second = queue(s, { type: 'explore', buildingIds: [s.hq.id], opts: { preferredHoodId: preferred } });
    s.sim.launchWeek();
    expect(second.assignedIds).toEqual([]); expect(second.dispatchWaitReason).toContain(s.w.people[preferred].name);
    const restored = Sim.fromSave(structuredClone(s.w)), saved = restored.world.orders[second.id];
    for (let n = 0; n < 8; n++) restored.advance(1 / MINUTES_PER_SECOND, 1);
    expect(saved.state).toBe('queued'); expect(saved.assignedIds).toEqual([]);
    expect(restored.world.messages.filter(m => m.text.includes('Explore is queued:'))).toHaveLength(1);
    expect(cancelOrder(restored.world, first.id).ok).toBe(true);
    advanceUntil(restored, () => saved.state !== 'queued');
    expect(saved.assignedIds).toEqual([preferred]);
    expect(saved.dispatchWaitReason).toBeUndefined();
  });

  it.each(['arrested', 'beaten'] satisfies PersonStatus[])('holds an accepted job when its person becomes %s and dispatches on recovery', status => {
    const s = fixture(), preferred = s.t.memberIds[0];
    const order = queue(s, { type: 'explore', buildingIds: [s.hq.id], opts: { manpower: 2, preferredHoodId: preferred } });
    s.w.people[preferred].status = status; s.sim.launchWeek();
    expect(order.state).toBe('queued'); expect(order.assignedIds).toEqual([]);
    s.w.people[preferred].status = 'active'; tickOrders(s.w, s.sim.rng, 1);
    expect(order.state).toBe('travelling'); expect(order.assignedIds).toHaveLength(2);
  });

  it('fails an accepted job explicitly if the required party can no longer exist', () => {
    const s = fixture();
    const order = queue(s, { type: 'explore', buildingIds: [s.hq.id], opts: { manpower: 2 } });
    s.w.people[s.t.memberIds[0]].status = 'dead'; s.sim.launchWeek();
    expect(order.state).toBe('failed'); expect(order.assignedIds).toEqual([]);
    expect(order.failReason).toMatch(/2 people.*only 1 remain/);
  });

  it('continues an underway job with its survivors, slower and with one honest report', () => {
    const s = fixture(), charity = Object.values(s.w.buildings).find(b => b.cls === 'charity')!;
    const order = queue(s, { type: 'donate', buildingIds: [charity.id], opts: { manpower: 2, amount: 1000 } });
    s.sim.launchWeek(); advanceUntil(s.sim, () => order.state === 'executing');
    const remaining = order.workLeft, assigned = [...order.assignedIds];
    s.w.people[assigned[0]].status = 'beaten';
    for (let n = 0; n < 3; n++) tickOrders(s.w, s.sim.rng, 1);
    expect(order.workLeft).toBe(remaining - 3);
    expect(order.assignedIds).toEqual(assigned);
    expect(order.results.filter(r => r.includes('continuing with 1 of 2'))).toHaveLength(1);
    expect(s.w.messages.filter(m => m.text.includes('continuing with 1 of 2'))).toHaveLength(1);
  });

  it('does not reclaim a recovered hood from a later job when the old order ends', () => {
    const s = fixture(), charity = Object.values(s.w.buildings).find(b => b.cls === 'charity')!;
    const first = queue(s, { type: 'donate', buildingIds: [charity.id], opts: { manpower: 2, amount: 1000 } });
    const preferred = s.t.memberIds[0];
    const next = queue(s, { type: 'explore', buildingIds: [s.hq.id], opts: { preferredHoodId: preferred } });
    s.sim.launchWeek(); advanceUntil(s.sim, () => first.state === 'executing');
    const recovering = s.w.people[preferred];
    // Arrest and nonfatal assaults release the previous assignment this way.
    recovering.status = 'beaten'; recovering.orderId = null; clearDestination(recovering);
    tickOrders(s.w, s.sim.rng, 1);
    expect(next.state).toBe('queued');
    recovering.status = 'active'; tickOrders(s.w, s.sim.rng, 1);
    expect(next.assignedIds).toEqual([preferred]); expect(recovering.orderId).toBe(next.id);
    const remaining = first.workLeft;
    tickOrders(s.w, s.sim.rng, 1);
    expect(first.workLeft).toBe(remaining - 1);
    // Complete the old job while the new job still owns that person.
    first.workLeft = 1; tickOrders(s.w, s.sim.rng, 1);
    expect(first.state).toBe('done'); expect(recovering.orderId).toBe(next.id);
    expect(first.results.filter(r => r.includes('continuing with 1 of 2'))).toHaveLength(1);
  });
});

describe('standing-order duty reports and save compatibility', () => {
  it.each(['queued', 'travelling', 'waiting'] as const)('does not invent successful duty for an order still %s without doing work', state => {
    const s = fixture(), order = queue(s, { type: 'patrol', buildingIds: [s.hq.id] });
    s.sim.launchWeek(); order.state = state; order.workedMinutes = 0;
    if (state === 'queued') { order.assignedIds = []; order.dispatchWaitReason = 'Waiting for the preferred person.'; }
    settleOrders(s.sim);
    expect(order.state).toBe('failed'); expect(order.results.some(r => r.includes('Patrolled'))).toBe(false);
    expect(order.failReason).toMatch(state === 'queued' ? /never started.*preferred person/ : /not enough time/);
  });

  it('counts actual duty, excludes Wait, and preserves the duration across save/restore and rollover', () => {
    const s = fixture(), order = queue(s, { type: 'patrol', buildingIds: [s.hq.id], opts: { repeat: true } });
    s.sim.launchWeek(); advanceUntil(s.sim, () => order.state === 'executing');
    for (let n = 0; n < 17; n++) tickOrders(s.w, s.sim.rng, 1);
    expect(order.workedMinutes).toBe(17);
    expect(setWaiting(s.w, order.id, true).ok).toBe(true);
    const restored = Sim.fromSave(structuredClone(s.w)), saved = restored.world.orders[order.id];
    for (let n = 0; n < 4; n++) tickOrders(restored.world, restored.rng, 1);
    expect(saved.workedMinutes).toBe(17);
    settleOrders(restored); expect(saved.state).toBe('done');
    expect(saved.results).toContain('Patrolled 1 block for 17 minutes.');
    expect(saved.results.join(' ')).not.toContain('all week');
    rolloverOrders(restored.world);
    expect(restored.world.lastWeekOrders.find(o => o.id === order.id)?.workedMinutes).toBe(17);
    expect(saved).toMatchObject({ state: 'queued', assignedIds: [], results: [] });
    expect(saved.workedMinutes).toBeUndefined(); expect(saved.reportedCrewSize).toBeUndefined();
  });

  it('preserves an executing historical save without inventing a duration', () => {
    const s = fixture(), order = queue(s, { type: 'patrol', buildingIds: [s.hq.id] });
    s.sim.launchWeek(); advanceUntil(s.sim, () => order.state === 'executing');
    delete order.workedMinutes; delete order.reportedCrewSize;
    const restored = Sim.fromSave(structuredClone(s.w)), saved = restored.world.orders[order.id];
    tickOrders(restored.world, restored.rng, 1); settleOrders(restored);
    expect(saved.state).toBe('done'); expect(saved.results).toContain('Patrolled 1 block.');
  });

  it.each(['current', 'archived'] as const)('rejects invalid staffing history in %s orders with both save readers', async location => {
    const s = fixture(), order = queue(s, { type: 'patrol', buildingIds: [s.hq.id] });
    if (location === 'archived') { s.w.lastWeekOrders = [order]; s.w.orders = {}; s.t.orderIds = []; }
    for (const [field, value] of [['workedMinutes', -1], ['workedMinutes', MINUTES_PER_WEEK + 1], ['reportedCrewSize', 0], ['reportedCrewSize', MAX_TEAM_SIZE + 1], ['reportedCrewSize', 1.5]] as const) {
      order[field] = value;
      expect(() => validateSaveWorld(s.w)).toThrow(/order (duty duration|crew count)/);
      await expect(validateSaveWorldResponsive(structuredClone(s.w))).rejects.toThrow(/order (duty duration|crew count)/);
      delete order[field];
    }
    expect(() => validateSaveWorld(s.w)).not.toThrow();
  });

  it('does not count an unavailable person as free capacity in standing-order estimates', () => {
    const s = fixture(), order = queue(s, { type: 'patrol', buildingIds: [s.hq.id] });
    const before = estimateMinutes(s.w, s.t, order);
    s.w.people[s.t.lieutenantId].status = 'arrested';
    expect(estimateMinutes(s.w, s.t, order)).toBe(before * 2);
  });
});
