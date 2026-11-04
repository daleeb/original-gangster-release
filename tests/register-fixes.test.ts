import { afterEach, describe, expect, it } from 'vitest';
import { defaultGameOptions, newCampaignOptions } from '../src/app/newGame';
import { selectableOrderPerson } from '../src/app/orderSelection';
import { useGame } from '../src/app/store';
import { BUY_REACH_BLOCKS, hireRecruit, issueOrder, issueStreetOrder, nearTerritory } from '../src/sim/api';
import { createWorld } from '../src/sim/citygen';
import { MINUTES_PER_WEEK } from '../src/sim/constants';
import { recentEventCounts } from '../src/sim/events';
import { BEATEN_MINUTES, killPerson, knockDown, promoteToLieutenant } from '../src/sim/execution';
import { personMapPosition } from '../src/sim/mapIntel';
import { purchasablePremisesType } from '../src/sim/premises';
import { MINUTES_PER_SECOND, Sim } from '../src/sim/sim';
import { taxNotCoveredUp } from '../src/sim/systems/taxes';
import { allBuildings } from '../src/sim/world';
import { staffFirstCrew } from './helpers/crew';

// Remake bugs from the differences register (rows marked Fix, and bug fixes
// another fork made that this one lacked).

function newSim(seed = 404) {
  const sim = new Sim({ ...defaultGameOptions(), seed, citySize: 10, startMoney: 50_000, startHoods: 8 });
  staffFirstCrew(sim);
  return sim;
}
const minute = (sim: Sim) => sim.advance(1 / MINUTES_PER_SECOND, 1);

describe('orders without the means (B#15)', () => {
  it('refuses a Bomb with no explosives in the crew or the gang store', () => {
    const sim = newSim(), w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    team.weapons.explosives = 0; gang.weapons.explosives = 0;
    const rivalSite = allBuildings(w).find((b) => b.ownerGangId != null && b.ownerGangId !== gang.id && b.state !== 'destroyed')!;
    const result = issueOrder(w, gang.id, { teamId: team.id, type: 'bomb', buildingIds: [rivalSite.id] });
    expect(result.ok).toBe(false);
    expect(team.orderIds).toEqual([]);
  });

  it('refuses to buy premises the gang cannot pay for', () => {
    const sim = newSim(), w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    const site = allBuildings(w).find((b) => b.ownerGangId == null && b.state !== 'destroyed' && purchasablePremisesType(b) &&
      nearTerritory(w, gang.id, b.blockId, BUY_REACH_BLOCKS))!;
    gang.cash = 0;
    const result = issueOrder(w, gang.id, { teamId: team.id, type: 'buyPremises', buildingIds: [site.id] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot afford/);
  });
});

describe('people', () => {
  it('takes a hired man off every gang\'s recruit list (B#32)', () => {
    const sim = newSim(), w = sim.world, player = sim.playerGang;
    const rival = Object.values(w.gangs).find((g) => !g.isPlayer)!;
    const free = Object.values(w.people).find((p) => p.gangId == null && p.status === 'active' && p.role === 'hood')!;
    player.recruitIds.push(free.id); rival.recruitIds.push(free.id);
    expect(hireRecruit(w, rival.id, free.id, 'pool').ok).toBe(true);
    expect(player.recruitIds).not.toContain(free.id);
  });

  it('hands a dead lieutenant\'s crew over at once, not at the end of the week (B#37)', () => {
    const sim = newSim(), w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    const old = team.lieutenantId;
    expect(team.memberIds.length).toBeGreaterThan(0);
    killPerson(w, w.people[old], 'shot');
    expect(team.lieutenantId).not.toBe(old);
    expect(w.people[team.lieutenantId].status).toBe('active');
    expect(w.people[team.lieutenantId].role).toBe('lieutenant');
  });

  it('pays a promoted lieutenant what he asks (X-40)', () => {
    const sim = newSim(), w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
    const hood = w.people[team.memberIds[0]];
    expect(promoteToLieutenant(w, gang, hood)).not.toBeNull();
    expect(hood.pay).toBe(hood.payDemand);
  });

  it('gets a beaten man back on his feet during the week (E#53)', () => {
    const sim = newSim(), w = sim.world;
    sim.launchWeek();
    const victim = Object.values(w.people).find((p) => p.role === 'citizen' && p.status === 'active')!;
    knockDown(w, victim);
    expect(victim.status).toBe('beaten');
    for (let i = 0; i <= BEATEN_MINUTES + 2 && victim.status === 'beaten'; i++) minute(sim);
    expect(victim.status).toBe('active');
    expect(victim.beatenUntil).toBeUndefined();
  });
});

describe('street orders and the planned order (R-02)', () => {
  it('sends a man back to his planned order once his street order is done', () => {
    const sim = new Sim({ ...defaultGameOptions(), seed: 404, citySize: 10 });
    const w = sim.world, g = sim.playerGang, t = w.teams[g.teamIds[0]];
    const site = allBuildings(w).find((b) => b.ownerGangId === g.id && !b.isHQ && b.cls !== 'empty')!;
    expect(issueOrder(w, g.id, { teamId: t.id, type: 'guardBusiness', buildingIds: [site.id] }).ok).toBe(true);
    sim.launchWeek();
    const order = w.orders[t.orderIds[0]], actor = w.people[order.assignedIds[0]];
    for (let i = 0; i < 200 && !site.guardIds.includes(actor.id); i++) minute(sim);
    expect(site.guardIds).toContain(actor.id);

    expect(issueStreetOrder(w, g.id, [actor.id], 'goTo', null, { ...actor.pos }).ok).toBe(true);
    expect(actor.orderId).toBeNull();
    for (let i = 0; i < 300 && (actor.streetOrder || !site.guardIds.includes(actor.id)); i++) minute(sim);
    expect(order.state).toBe('executing');
    expect(actor.orderId).toBe(order.id);
    expect(site.guardIds).toContain(actor.id);
    expect(w.minute).toBeLessThan(MINUTES_PER_WEEK);
  });
});

describe('maps and reports', () => {
  it('counts recent events by block, without arrest charges (overlay E#19, F#33)', () => {
    const sim = newSim(), w = sim.world, gang = sim.playerGang;
    const site = allBuildings(w).find((b) => b.cls !== 'empty')!;
    const base = { gangId: gang.id, perpetratorId: gang.bossId, kind: 'raid', buildingId: site.id, victimId: null, witnesses: [], arrestRisk: 0.5 };
    w.crimes.push({ id: -1, week: w.week, reported: true, ...base });
    w.crimes.push({ id: -2, week: w.week, reported: true, charge: true, ...base });
    w.crimes.push({ id: -3, week: w.week, reported: false, ...base });
    const block = w.blocks[site.blockId].layout?.mergedInto ?? site.blockId;
    expect(recentEventCounts(w).get(block)).toBe(1);
  });

  it('reports the laundering pool as tax not covered up in the original city (R-28)', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const gang = Object.values(w.gangs).find((g) => g.isPlayer)!;
    expect(w.cityLayout?.original).toBeTruthy();
    gang.launderPool = 3_000; gang.uncoveredTax = 0;
    expect(taxNotCoveredUp(w, gang)).toBe(3_000);
  });

  it('places a rival only at premises known to be his gang\'s (R-17)', () => {
    const sim = newSim(), w = sim.world, player = sim.playerGang;
    const rival = Object.values(w.gangs).find((g) => !g.isPlayer)!;
    const office = allBuildings(w).find((b) => b.ownerGangId === rival.id && b.typeId === 'office')!;
    const man = w.people[w.teams[rival.teamIds[0]].lieutenantId];
    man.buildingId = office.id;
    office.knowledge[player.id] = 0;
    expect(personMapPosition(w, player.id, man)).toBeNull();
    office.knowledge[player.id] = 3;
    expect(personMapPosition(w, player.id, man)).toEqual(w.lots[office.lotId].center);
  });

  it('lets a stranger at a known site be named as a target, to be hunted (R-17)', () => {
    const sim = newSim(), w = sim.world, player = sim.playerGang;
    const rival = Object.values(w.gangs).find((g) => !g.isPlayer)!;
    const man = w.people[w.teams[rival.teamIds[0]].lieutenantId];
    player.knownPeople = player.knownPeople.filter((id) => id !== man.id);
    man.buildingId = null;
    expect(selectableOrderPerson(w, player.id, 'kill', man)).toBe(false);
    man.buildingId = allBuildings(w).find((b) => b.cls === 'commercial')!.id;
    expect(selectableOrderPerson(w, player.id, 'kill', man)).toBe(true);
  });
});

describe('store', () => {
  const initial = useGame.getState();
  afterEach(() => useGame.setState(initial, true));

  it('draws one colour overlay at a time, territory alongside (overlays F#54)', () => {
    const s = useGame.getState();
    s.setOverlays(['territory']);
    s.toggleOverlay('crime');
    s.toggleOverlay('security');
    expect(useGame.getState().overlays).toEqual(['territory', 'security']);
  });

  it('cycles to a man with the number keys without tagging him (E#61)', () => {
    useGame.getState().startGame({ ...defaultGameOptions(), seed: 404, citySize: 10 });
    const sim = useGame.getState().sim!;
    sim.launchWeek();
    const id = Object.values(sim.world.people).find((p) => p.role === 'citizen')!.id;
    useGame.getState().focusPerson(id);
    expect(useGame.getState().selectedPersonId).toBe(id);
    expect(useGame.getState().taggedPersonIds).toEqual([]);
  });

  it('builds a new city for every New Game (A5)', () => {
    const s = useGame.getState();
    s.setOptions({ seed: 12345 });
    s.setScreen('newGame');
    expect(useGame.getState().options.seed).not.toBe(12345);
  });
});
