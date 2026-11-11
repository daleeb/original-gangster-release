import { describe, expect, it } from 'vitest';
import { defaultGameOptions, newCampaignOptions } from '../src/app/newGame';
import { buyWeapon, defaultOptions, issueOrder, killMember, transferVehicle } from '../src/sim/api';
import { DRIVE_MIN_DISTANCE, MINUTES_PER_WEEK } from '../src/sim/constants';
import { expandTargets, fitsWeek, isValidAreaTarget, weekCharge } from '../src/sim/execution';
import { crewPeople, readyForPlanning } from '../src/sim/orderStaffing';
import { protectionFee, siteBuilding } from '../src/sim/premises';
import { Sim, MINUTES_PER_SECOND } from '../src/sim/sim';
import { atOffice, officeDoors, restingStatus } from '../src/sim/transport';
import type { Person } from '../src/sim/types';
import { allBuildings, buildingDoor, dist, typeOf } from '../src/sim/world';
import { weekTime } from '../src/ui/WeekClock';
import { staffFirstCrew } from './helpers/crew';

function fixture(seed = 404) {
  const sim = new Sim({ ...defaultGameOptions(), seed, citySize: 10, startMoney: 100_000, startHoods: 8 });
  staffFirstCrew(sim);
  const w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
  return { sim, w, gang, team };
}
const minute = (sim: Sim) => sim.advance(1 / MINUTES_PER_SECOND, 1);

describe('issue 10 item 13: a crew sent after a person by car', () => {
  it('drives to a man indoors and deals with him, rather than being re-routed every minute all week', () => {
    const sim = new Sim({ ...defaultGameOptions(), seed: 23, citySize: 10, startMoney: 100_000 });
    const w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    w.orders = {};
    for (const t of Object.values(w.teams)) { t.orderIds = []; t.timeUsed = 0; }
    expect(buyWeapon(w, gang.id, 'pistol', team.id).ok).toBe(true);
    team.vehicles = { coupe: 1, truck: 0, speedster: 0 };
    const door = buildingDoor(w, allBuildings(w).find(b => b.isHQ && b.ownerGangId === gang.id)!);
    // A shopkeeper far enough off to be driven to: he stands inside, well back from the kerb the car stops at.
    const victim = Object.values(w.people).filter(p => p.role === 'owner' && p.status === 'active' && p.buildingId != null && p.gangId == null)
      .map(p => ({ p, d: dist(p.pos, door) })).filter(o => o.d > DRIVE_MIN_DISTANCE + 60 && o.d < 520).sort((a, b) => a.d - b.d)[0].p;
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'kill', personId: victim.id, opts: { manpower: 1 } }).ok).toBe(true);
    const order = Object.values(w.orders).find(o => o.type === 'kill')!;
    sim.launchWeek();
    const actor = w.people[order.assignedIds[0]];
    let reroutes = 0, lastPath: Person['path'] | null = null, reached = false, drove = false;
    for (let i = 0; i < MINUTES_PER_WEEK && w.phase === 'week' && order.state !== 'done' && order.state !== 'failed'; i++) {
      minute(sim);
      if (actor.path !== lastPath) reroutes++;
      lastPath = actor.path;
      drove ||= actor.inVehicle;
      reached ||= order.state === 'executing';
    }
    expect(drove).toBe(true);
    expect(reached).toBe(true);
    // A fresh route every minute was the fault: there were as many re-routes as minutes.
    expect(reroutes).toBeLessThan(60);
  }, 300_000);
});

describe('issue 11: the crew\'s week is its people\'s time', () => {
  it('charges a job by the share of the crew it takes, but never accepts one longer than the week', () => {
    const { w, gang, team } = fixture();
    const bodies = crewPeople(w, team).filter(p => readyForPlanning(w, p)).length;
    expect(bodies).toBeGreaterThan(3);
    const order = { type: 'extort' as const, opts: defaultOptions({ manpower: 1 }), estimatedMinutes: 600 };
    expect(weekCharge(w, team, order)).toBe(Math.round(600 / bodies));
    expect(weekCharge(w, team, { ...order, opts: defaultOptions({ manpower: bodies }) })).toBe(600);
    // More men asked for than the crew has is still the whole crew, not more.
    expect(weekCharge(w, team, { ...order, opts: defaultOptions({ manpower: bodies + 3 }) })).toBe(600);
    // A standing order was always shared out by head; it is charged as estimated.
    expect(weekCharge(w, team, { type: 'patrol', opts: defaultOptions(), estimatedMinutes: 480 })).toBe(480);
    expect(fitsWeek(w, team, order, 0)).toBe(true);
    expect(fitsWeek(w, team, { ...order, estimatedMinutes: MINUTES_PER_WEEK * 1.5 }, 0)).toBe(false);
    expect(fitsWeek(w, team, order, MINUTES_PER_WEEK)).toBe(false);
    // The computer's crews keep planning by the clock.
    const rival = Object.values(w.teams).find(t => t.gangId !== gang.id)!;
    expect(weekCharge(w, rival, order)).toBe(600);
  });

  it('lets several one-man jobs run side by side, where the old budget refused the second', () => {
    const { w, gang, team } = fixture();
    const sites = allBuildings(w).filter(b => isValidAreaTarget(w, gang.id, 'extort', b)).slice(0, 24);
    let accepted = 0;
    for (let i = 0; i < 4; i++) {
      if (issueOrder(w, gang.id, { teamId: team.id, type: 'extort', buildingIds: sites.slice(i * 6, i * 6 + 6).map(b => b.id), opts: { manpower: 1 } }).ok) accepted++;
    }
    expect(accepted).toBe(4);
    const total = team.orderIds.reduce((sum, id) => sum + weekCharge(w, team, w.orders[id]), 0);
    expect(team.timeUsed).toBe(total);
    expect(team.timeUsed).toBeLessThanOrEqual(MINUTES_PER_WEEK * 1.02);
  });
});

describe('issue 10 item 6: queued orders are timed again when the crew changes', () => {
  it('shortens a queued journey when a car is handed over, and re-totals the week', () => {
    const { w, gang, team } = fixture();
    team.vehicles = { coupe: 0, truck: 0, speedster: 0 };
    gang.vehicles.coupe = 1;
    const door = buildingDoor(w, allBuildings(w).find(b => b.isHQ && b.ownerGangId === gang.id)!);
    const far = allBuildings(w).filter(b => isValidAreaTarget(w, gang.id, 'explore', b))
      .sort((a, b) => dist(buildingDoor(w, b), door) - dist(buildingDoor(w, a), door))[0];
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'explore', buildingIds: [far.id], opts: { manpower: 1 } }).ok).toBe(true);
    const order = w.orders[team.orderIds[0]];
    const onFoot = order.estimatedMinutes, bookedOnFoot = team.timeUsed;
    expect(transferVehicle(w, gang.id, 'coupe', team.id, true).ok).toBe(true);
    expect(order.estimatedMinutes).toBeLessThan(onFoot);
    expect(team.timeUsed).toBe(weekCharge(w, team, order));
    expect(team.timeUsed).toBeLessThan(bookedOnFoot);
    // ...and lengthens it again when the car goes back.
    expect(transferVehicle(w, gang.id, 'coupe', team.id, false).ok).toBe(true);
    expect(order.estimatedMinutes).toBe(onFoot);
  });
});

describe('issue 10 item 4: Recruit looks for one kind of recruit', () => {
  it('takes only the haunts of the kind asked for', () => {
    const { w, gang, team } = fixture();
    const haunts = allBuildings(w).filter(b => typeOf(b)?.recruit && b.state !== 'destroyed');
    expect(haunts.some(b => typeOf(b)!.recruit === 'hood')).toBe(true);
    for (const kind of ['hood', 'accountant', 'lawyer'] as const) {
      for (const b of haunts) expect(isValidAreaTarget(w, gang.id, 'recruit', b, { recruitKind: kind })).toBe(typeOf(b)!.recruit === kind);
    }
    // No kind given (older saves, the computer's gangs): anywhere anybody can be recruited.
    for (const b of haunts) expect(isValidAreaTarget(w, gang.id, 'recruit', b)).toBe(true);
    const blocks = [...new Set(haunts.map(b => b.blockId))];
    const hoodSites = expandTargets(w, gang.id, 'recruit', blocks, [], { recruitKind: 'hood' });
    expect(hoodSites.length).toBeGreaterThan(0);
    expect(hoodSites.every(id => typeOf(w.buildings[id])!.recruit === 'hood')).toBe(true);
    const hoodHaunt = haunts.find(b => typeOf(b)!.recruit === 'hood')!;
    const wrong = issueOrder(w, gang.id, { teamId: team.id, type: 'recruit', buildingIds: [hoodHaunt.id], opts: { recruitKind: 'lawyer' } });
    expect(wrong.ok).toBe(false);
    expect(issueOrder(w, gang.id, { teamId: team.id, type: 'recruit', buildingIds: [hoodHaunt.id], opts: { recruitKind: 'hood' } }).ok).toBe(true);
    expect(w.orders[team.orderIds.at(-1)!].opts.recruitKind).toBe('hood');
  });
});

describe('issue 10 item 9: nobody held out of reach can be killed from the desk', () => {
  it.each(['arrested', 'onTrial', 'jailed', 'kidnapped'] as const)('refuses for a member who is %s', status => {
    const { w, gang, team } = fixture();
    const hood = w.people[team.memberIds[0]];
    hood.status = status;
    const result = killMember(w, gang.id, hood.id);
    expect(result.ok).toBe(false);
    expect(hood.status).toBe(status);
    hood.status = 'active';
    expect(killMember(w, gang.id, hood.id).ok).toBe(true);
  });
});

describe('issue 10 item 14: a man with nothing to do is at the office', () => {
  it('counts him in at the office door and says so, and out again once he has somewhere to go', () => {
    const { w, gang, team } = fixture();
    const hood = w.people[team.memberIds[0]];
    const door = officeDoors(w, gang.id)[0];
    expect(door).toBeTruthy();
    hood.pos = { ...door }; hood.dest = null; hood.path = [];
    expect(atOffice(w, hood)).toBe(true);
    expect(restingStatus(w, hood)).toBe('At the office');
    hood.dest = { x: door.x + 80, y: door.y }; hood.pos = { x: door.x + 40, y: door.y };
    expect(atOffice(w, hood)).toBe(false);
    expect(restingStatus(w, hood)).toBe('Returning to the office');
    hood.dest = null;
    expect(restingStatus(w, hood)).toBe('Idle');
  });
});

describe('issue 10 item 19: the week clock', () => {
  it('reads the working day 8 am to 4 pm, and the end of the week as Friday afternoon', () => {
    expect(weekTime(0)).toBe('8:00 am');
    expect(weekTime(479)).toBe('3:59 pm');
    expect(weekTime(480)).toBe('8:00 am');
    expect(weekTime(MINUTES_PER_WEEK - 1)).toBe('3:59 pm');
    // The settlement minute was read as a sixth morning ("Fri · 8:00 am").
    expect(weekTime(MINUTES_PER_WEEK)).toBe('4:00 pm');
  });
});

describe('issue 10 item 21: an apartment block is one building', () => {
  it('resolves the terraces of a tenement block to its tenement, and leaves plain row houses alone', () => {
    const sim = new Sim({ ...newCampaignOptions(), seed: 4711 });
    const w = sim.world;
    const houses = allBuildings(w).filter(b => b.cls === 'residential');
    expect(houses.length).toBeGreaterThan(0);
    let resolved = 0, alone = 0;
    for (const house of houses) {
      const site = siteBuilding(w, house);
      const tenement = w.blocks[house.blockId].lotIds.map(id => w.buildings[w.lots[id].buildingId]).find(b => b.cls === 'tenement');
      if (tenement) { expect(site.id).toBe(tenement.id); resolved++; } else { expect(site.id).toBe(house.id); alone++; }
    }
    expect(resolved).toBeGreaterThan(0);
    expect(alone).toBeGreaterThan(0);
    // Everything else is itself.
    const shop = allBuildings(w).find(b => b.cls === 'commercial')!;
    expect(siteBuilding(w, shop)).toBe(shop);
  });
});

describe('issue 10 item 17: whoever buys a business stays to run it', () => {
  it('sends for a hood from the pool when the lieutenant had to make the purchase himself', () => {
    const sim = new Sim({ ...defaultGameOptions(), seed: 404, citySize: 10, startMoney: 100_000, startHoods: 8 });
    const w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    expect(gang.poolIds.length).toBeGreaterThan(0);
    // Every hood of his is out on an earlier job, so the lieutenant goes to the sale himself.
    expect(team.memberIds.length).toBeGreaterThan(0);
    const extortable = allBuildings(w).filter(b => isValidAreaTarget(w, gang.id, 'extort', b));
    team.memberIds.forEach((hood, i) => expect(issueOrder(w, gang.id, { teamId: team.id, type: 'extort',
      buildingIds: extortable.slice(i * 3, i * 3 + 3).map(b => b.id), opts: { manpower: 1, preferredHoodId: hood } }).ok).toBe(true));
    const door = buildingDoor(w, allBuildings(w).find(b => b.isHQ && b.ownerGangId === gang.id)!);
    const shop = allBuildings(w).filter(b => b.ownerGangId == null && b.cls === 'commercial' && b.state === 'trading')
      .sort((a, b) => dist(buildingDoor(w, a), door) - dist(buildingDoor(w, b), door))
      .find(b => issueOrder(w, gang.id, { teamId: team.id, type: 'buyPremises', buildingIds: [b.id], opts: { manpower: 1 } }).ok)!;
    expect(shop).toBeTruthy();
    // The crew's own order: the rival gangs have purchases on the books too.
    const order = w.orders[team.orderIds.at(-1)!];
    expect(order.type).toBe('buyPremises');
    sim.launchWeek();
    expect(order.assignedIds).toEqual([team.lieutenantId]);
    for (let i = 0; i < MINUTES_PER_WEEK && w.phase === 'week' && order.state !== 'done' && order.state !== 'failed'; i++) minute(sim);
    expect(order.state, order.failReason ?? '').toBe('done');
    expect(shop.ownerGangId).toBe(gang.id);
    expect(shop.managerId).not.toBeNull();
    expect(shop.managerId).not.toBe(team.lieutenantId);
    expect(gang.poolIds).not.toContain(shop.managerId);
    expect(w.people[shop.managerId!].buildingId).toBe(shop.id);
    expect(order.results.join(' ')).toMatch(/stays on to run it/);
  }, 300_000);
});

describe('issue 10 item 20: protection costs a shop less than it earns', () => {
  it('asks two fifths of the takings, the same for a racket signed up as for one a gang starts with', () => {
    const { w, gang } = fixture();
    const sites = allBuildings(w).filter(b => isValidAreaTarget(w, gang.id, 'extort', b));
    expect(sites.length).toBeGreaterThan(50);
    for (const b of sites) {
      const profit = typeOf(b)!.profit, fee = protectionFee(b);
      expect(fee, b.typeId).toBe(Math.max(60, Math.round(profit * 0.4)));
      if (profit > 60) expect(fee, b.typeId).toBeLessThan(profit);
    }
    const started = allBuildings(w).filter(b => b.protection);
    expect(started.length).toBeGreaterThan(0);
    for (const b of started) expect(b.protection!.base, b.typeId).toBe(protectionFee(b));
  });
});
