import { describe, expect, it } from 'vitest';
import { defaultGameOptions, newCampaignOptions } from '../src/app/newGame';
import { createWorld } from '../src/sim/citygen';
import { currentFinances } from '../src/sim/finances';
import { Rng } from '../src/sim/rng';
import { validateSaveWorld } from '../src/sim/saveSchema';
import {
  arrestContest, arrestEdge, contrabandDraw, decayCrimeSuspicion, dispatchFbi, fbiAgentZeal, fbiInvestigatesRacket, fbiSolvesRacket,
  fbiWorkPosition, heavyCrimeSuspicion, launderingFencingRaids, memberWarrants, originalSuspicionRise, racketEventSuspicion,
  raidHeadquarters, serveAccountantWarrants, streetArrest, tickFbi, weeklyFbi,
} from '../src/sim/systems/fbi';
import { accountantSkillByte } from '../src/sim/systems/taxes';
import { allocateTransport, tryBoard } from '../src/sim/transport';
import type { Building, GameOptions, Gang, WorldState } from '../src/sim/types';
import { allBuildings, buildingDoor } from '../src/sim/world';

function city(opponents: GameOptions['opponents'] = 'normal', options = newCampaignOptions()) {
  const w = createWorld({ ...options, seed: 404, opponents }).world;
  const player = Object.values(w.gangs).find(g => g.isPlayer)!;
  const ai = Object.values(w.gangs).find(g => !g.isPlayer)!;
  return { w, player, ai };
}

/** The week's two lanes: premises takings and office takings. */
function takings(w: WorldState, g: Gang, premises: number, office: number) {
  const income = currentFinances(w, g).income;
  income.legal = premises; income.illegal = 0; income.protection = office; income.other = 0;
}

const hq = (w: WorldState, g: Gang) => allBuildings(w).find(b => b.isHQ && b.ownerGangId === g.id)!;

describe('the original FBI suspicion of a boss (0x4F5860, 0x6D04C2, 0x4F5AE0)', () => {
  it('weighs office takings against premises takings, from a floor of 100', () => {
    const { w, player, ai } = city();
    player.accountantId = null; ai.accountantId = null;
    takings(w, player, 0, 2000);
    expect(originalSuspicionRise(w, player)).toBe(20);   // (2000/100 − 10) × 2
    takings(w, player, 0, 1000);
    expect(originalSuspicionRise(w, player)).toBe(0);
    takings(w, player, 0, 900);
    expect(originalSuspicionRise(w, player)).toBe(0);    // −2, floored
    takings(w, player, 5000, 100_000);
    expect(originalSuspicionRise(w, player)).toBe(20);   // 100000/5000
    takings(w, player, 0, -50);
    expect(originalSuspicionRise(w, player)).toBe(0);
    takings(w, player, 0, 1_000_000);
    expect(originalSuspicionRise(w, player)).toBe(255);
    takings(w, ai, 1000, 20_000);
    expect(originalSuspicionRise(w, ai)).toBe(20);
  });

  it('weighs premises by the Opponents setting: the player 16 Passive and 8 Aggressive, a computer gang 14 Aggressive (R-03)', () => {
    const passive = city('passive');
    passive.player.accountantId = null;
    takings(passive.w, passive.player, 1000, 32_000);
    expect(originalSuspicionRise(passive.w, passive.player)).toBe(20);   // base 1600
    const aggressive = city('aggressive');
    aggressive.player.accountantId = null; aggressive.ai.accountantId = null;
    takings(aggressive.w, aggressive.player, 1000, 16_000);
    expect(originalSuspicionRise(aggressive.w, aggressive.player)).toBe(20);     // base 800
    takings(aggressive.w, aggressive.ai, 1000, 28_000);
    expect(originalSuspicionRise(aggressive.w, aggressive.ai)).toBe(20);         // base 1400
  });

  it('lets the accountant hide more, the player\'s at two thirds of his intelligence', () => {
    const { w, player, ai } = city();
    for (const g of [player, ai]) {
      const p = Object.values(w.people).find(q => q.gangId === g.id && q.id !== g.bossId)!;
      p.role = 'accountant'; p.status = 'active'; p.skills.intelligence = 5; g.accountantId = p.id;
    }
    const byte = accountantSkillByte(5);
    takings(w, ai, 0, 5000);
    expect(originalSuspicionRise(w, ai)).toBe(Math.max(0, Math.trunc((50 - (0.12 * byte + 9.88)) * 2)));
    takings(w, player, 0, 5000);
    expect(originalSuspicionRise(w, player)).toBe(Math.trunc((50 - (0.12 * Math.trunc(byte * 2 / 3) + 9.88)) * 2));
  });

  it('takes a tenth off each week before the rise, and shows the total as a percentage', () => {
    const { w, player } = city();
    player.accountantId = null;
    takings(w, player, 0, 0);
    player.fbiTotal = 100;
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(90);
    expect(player.suspicion).toBeCloseTo(90 * 100 / 255);
    player.fbiTotal = 9;
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(9);
    player.fbiTotal = 250;
    takings(w, player, 0, 100_000);
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(255);
  });

  it('opens a case above 200 and raids the boss\'s office the next week', () => {
    const { w, player } = city();
    player.accountantId = null;
    player.fbiTotal = 200;
    takings(w, player, 0, 0);
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(180);
    expect(player.fbiRaidWeek).toBeUndefined();
    player.fbiTotal = 222;
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(200);
    expect(player.fbiRaidWeek).toBeUndefined();          // 200 is not above 200
    player.fbiTotal = 223;
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBe(201);
    expect(player.fbiRaidWeek).toBe(w.week + 1);
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();

    w.week++; w.phase = 'week';
    const office = hq(w, player);
    dispatchFbi(w, new Rng(2));
    const squad = w.fbiIds.map(id => w.people[id]).filter(p => p.fbiAssignment?.kind === 'arrest');
    expect(squad.length).toBe(Math.min(8, w.fbiIds.length));
    expect(squad.every(p => p.fbiAssignment!.buildingId === office.id)).toBe(true);
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();

    const boss = w.people[player.bossId];
    boss.status = 'active'; boss.buildingId = office.id; boss.skills.intelligence = 5;
    const crimes = w.crimes.length;
    raidHeadquarters(w, new Rng(3), office, squad[0]);
    expect(boss.status).toBe('arrested');
    expect(player.fbiRaidWeek).toBeUndefined();
    expect(w.crimes.slice(crimes).some(c => c.perpetratorId === boss.id && c.kind === 'extort')).toBe(true);
    dispatchFbi(w, new Rng(2));
    expect(w.fbiIds.some(id => w.people[id].fbiAssignment?.kind === 'arrest')).toBe(false);
  });

  it('settles each arrest by the contest 0x49A530: rand(0..31) + Intelligence − 16', () => {
    const { w, player } = city();
    const p = w.people[player.bossId];
    const outcomes = (stars: number) => {
      p.skills.intelligence = stars;
      const rng = new Rng(9), seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(arrestContest(rng, p));
      return [...seen].sort();
    };
    expect(outcomes(0)).toEqual(['resists']);          // −16..15
    expect(outcomes(1)).toEqual(['breaksAway']);       // byte 51: 35..66
    expect(outcomes(2)).toEqual(['breaksAway']);       // byte 102: 86..117
    expect(outcomes(3)).toEqual(['arrested']);         // byte 153: 137..168
    expect(outcomes(5)).toEqual(['arrested']);
  });

  it('takes a whole team with one arrest, and leaves those who resist or break away', () => {
    const { w, player } = city();
    const office = hq(w, player);
    const members = Object.values(w.people).filter(p => p.gangId === player.id && p.id !== player.bossId).slice(0, 4);
    expect(members.length).toBe(4);
    const [smart, partner, dull, middling] = members;
    const boss = w.people[player.bossId];
    boss.status = 'active'; boss.buildingId = null; boss.inVehicle = false; boss.pos = { x: -500, y: -500 };
    for (const p of members) { p.status = 'active'; p.inVehicle = false; p.teamId = null; p.buildingId = office.id; }
    smart.skills.intelligence = 5; dull.skills.intelligence = 0; middling.skills.intelligence = 2;
    smart.teamId = partner.teamId = 9001;
    partner.buildingId = null; partner.pos = { x: -400, y: -400 }; partner.skills.intelligence = 0;
    w.phase = 'week';
    const agent = w.people[w.fbiIds[0]];
    agent.status = 'active';
    player.fbiRaidWeek = w.week;
    raidHeadquarters(w, new Rng(4), office, agent);
    expect(smart.status).toBe('arrested');
    expect(partner.status).toBe('arrested');            // away from the office, but on his team
    expect(dull.status).toBe('active');
    expect(dull.streetOrder).toEqual({ type: 'assault', targetPersonId: agent.id, pos: null });
    expect(middling.status).toBe('active');
    expect(middling.streetOrder).toBeNull();
    expect(boss.status).toBe('active');                  // not at the office
    expect(w.weekLog.at(-1)).toContain('2 arrested; 1 resisted, 1 got away');
  });

  it('charges a wanted man caught at the office with his own crime; only an accountant with tax evasion', () => {
    const { w, player } = city();
    const office = hq(w, player);
    const hood = Object.values(w.people).find(p => p.gangId === player.id && p.role === 'hood')!;
    const boss = w.people[player.bossId];
    boss.status = 'active'; boss.buildingId = null; boss.inVehicle = false; boss.pos = { x: -500, y: -500 };
    hood.status = 'active'; hood.inVehicle = false; hood.teamId = null; hood.buildingId = office.id;
    hood.skills.intelligence = 5; hood.fbiWarrant = true;
    w.crimes.push({ id: w.sequences.crime++, week: w.week, gangId: player.id, perpetratorId: hood.id, kind: 'bomb',
      buildingId: null, victimId: null, witnesses: [], arrestRisk: .5, reported: true });
    w.phase = 'week';
    const agent = w.people[w.fbiIds[0]];
    agent.status = 'active';
    player.fbiRaidWeek = w.week;
    const crimes = w.crimes.length;
    raidHeadquarters(w, new Rng(4), office, agent);
    expect(hood.status).toBe('arrested');
    expect(hood.fbiWarrant).toBeUndefined();
    expect(w.crimes.slice(crimes).map(c => c.kind)).toEqual(['bomb']);
  });

  it('leaves the compact cities on the remake\'s rule', () => {
    const { w, player } = city('normal', defaultGameOptions());
    expect(w.cityLayout?.original).toBeFalsy();
    weeklyFbi(w, new Rng(1));
    expect(player.fbiTotal).toBeUndefined();
    expect(player.fbiRaidWeek).toBeUndefined();
  });
});

describe("who makes the arrest (0x49A530's callers) and its edge", () => {
  it("weighs the squad's head count against the man's team: +64, 0 or -64", () => {
    // side = team + 1; +64 when squad - 1 > side, -64 when side > squad + 3.
    expect(arrestEdge(1, 0)).toBe(0);
    expect(arrestEdge(2, 0)).toBe(0);      // 1 > 1 is false
    expect(arrestEdge(3, 0)).toBe(64);     // 2 > 1
    expect(arrestEdge(8, 0)).toBe(64);
    expect(arrestEdge(8, 6)).toBe(0);      // side 7, 7 > 7 false
    expect(arrestEdge(8, 5)).toBe(64);
    expect(arrestEdge(1, 4)).toBe(-64);    // side 5 > 4
    expect(arrestEdge(1, 3)).toBe(0);
    expect(arrestEdge(2, 5)).toBe(-64);
  });

  it('shifts the contest by the edge', () => {
    const { w, player } = city();
    const p = w.people[player.bossId];
    p.skills.intelligence = 2;                       // byte 102: 86..117 breaks away
    const seen = (edge: number) => {
      const rng = new Rng(9), out = new Set<string>();
      for (let i = 0; i < 200; i++) out.add(arrestContest(rng, p, edge));
      return [...out].sort();
    };
    expect(seen(0)).toEqual(['breaksAway']);
    expect(seen(64)).toEqual(['arrested']);          // 150..181
    expect(seen(-64)).toEqual(['breaksAway']);       // 22..53
    p.skills.intelligence = 1;                       // byte 51: 35..66 breaks away alone
    expect(seen(-64)).toEqual(['resists']);          // -29..2
  });

  it('lets a policeman on the street take a man in by the contest, with his team', () => {
    const { w, player } = city();
    const [hood, mate] = Object.values(w.people).filter(p => p.gangId === player.id && p.id !== player.bossId).slice(0, 2);
    const cop = Object.values(w.people).find(p => p.role === 'police')!;
    for (const p of Object.values(w.people)) if (p.role === 'police' && p !== cop) p.status = 'jailed';
    for (const p of [hood, mate, cop]) Object.assign(p, { status: 'active', inVehicle: false, buildingId: null, orderId: null, streetOrder: null });
    hood.teamId = mate.teamId = 9002; mate.pos = { x: -900, y: -900 };
    cop.pos = { ...hood.pos };
    hood.skills.intelligence = 5;                    // always arrested
    expect(streetArrest(w, new Rng(3), cop, hood)).toBe('arrested');
    expect(hood.status).toBe('arrested');
    expect(mate.status).toBe('arrested');            // his team goes with him
  });

  it('turns one who resists on the officer and sends one who breaks away home', () => {
    const { w, player } = city();
    const [dull, middling] = Object.values(w.people).filter(p => p.gangId === player.id && p.id !== player.bossId).slice(0, 2);
    const cop = Object.values(w.people).find(p => p.role === 'police')!;
    for (const p of Object.values(w.people)) if (p.role === 'police' && p !== cop) p.status = 'jailed';
    for (const p of [dull, middling, cop]) Object.assign(p, { status: 'active', inVehicle: false, buildingId: null, orderId: null, streetOrder: null, teamId: null });
    cop.pos = { ...dull.pos };
    dull.skills.intelligence = 0;
    expect(streetArrest(w, new Rng(3), cop, dull)).toBe('resists');
    expect(dull.streetOrder).toEqual({ type: 'assault', targetPersonId: cop.id, pos: null });
    middling.skills.intelligence = 2; cop.pos = { ...middling.pos };
    expect(streetArrest(w, new Rng(3), cop, middling)).toBe('breaksAway');
    expect(middling.status).toBe('active');
    const door = buildingDoor(w, hq(w, player));
    expect(middling.dest).toEqual(door);
  });

  it('takes a man out of his car whatever comes of it; the best driver left takes the wheel', () => {
    const { w, player } = city();
    const team = w.teams[player.teamIds[0]];
    const [driver, mate] = Object.values(w.people).filter(p => p.gangId === player.id && p.role === 'hood').slice(0, 2);
    for (const p of [driver, mate]) p.teamId = team.id;
    team.memberIds = [driver.id, mate.id];
    const cop = Object.values(w.people).find(p => p.role === 'police')!;
    for (const p of Object.values(w.people)) if (p.role === 'police' && p !== cop) p.status = 'jailed';
    for (const p of [driver, mate, cop]) Object.assign(p, { status: 'active', inVehicle: false, buildingId: null, orderId: null, streetOrder: null });
    team.vehicles = { coupe: 1, truck: 0, speedster: 0 };
    for (const p of [driver, mate]) p.pos = buildingDoor(w, hq(w, player));
    allocateTransport(w, team, [driver, mate], { x: 400, y: 400 }, -1, 'goTo');
    const car = w.vehicleFleet![driver.vehicleKey!];
    tryBoard(w, car);
    expect(car.driverId).toBe(driver.id);
    cop.pos = { ...driver.pos };
    driver.skills.intelligence = 0;
    expect(streetArrest(w, new Rng(3), cop, driver)).toBe('resists');
    expect(driver.inVehicle).toBe(false);
    expect(driver.vehicleKey).toBeUndefined();
    expect(car.occupantIds).toEqual([mate.id]);
    expect(car.driverId).toBe(mate.id);
  });
});

// 0x4F5AE0, a racket's crime event in state 1 (0x4F7750 opens one per racket
// with the premises byte +0x44 as its suspicion, seeded by 0x6EC950): the FBI
// sends an agent when zeal + suspicion + the week's rise of the manager's gang
// (FBI+0x190) > 180 + the manager's Business (+0xAF) + Organisation (+0xB5).
describe("the FBI's zeal for rackets (0x4F5AE0 state 1, 0x4F6BC0)", () => {
  /** A trading speakeasy of the gang's, run by one of its hoods; nothing else to look into. */
  function racket(w: WorldState, g: Gang): Building {
    for (const x of allBuildings(w)) {
      x.discovered = true; x.fbiDiscoveredWeek = w.week; x.fbiRaidWeek = w.week + 50;
    }
    const b = allBuildings(w).find(x => !x.isHQ && x.typeId !== 'office' && x.cls === 'commercial' && x.state !== 'destroyed')!;
    const hood = Object.values(w.people).find(p => p.gangId === g.id && p.id !== g.bossId && p.role === 'hood')!;
    Object.assign(b, { ownerGangId: g.id, typeId: 'speakeasy', cls: 'illegal', state: 'trading', frontId: null, cover: 0,
      discovered: false, managerId: hood.id });
    delete b.fbiDiscoveredWeek; delete b.fbiRaidWeek; delete b.fbiClosedWeek; delete b.fbiSearchedWeek;
    hood.skills.business = 2; hood.skills.organization = .5;   // bytes 25 + 6: the bar is 211
    return b;
  }

  it("looks into a racket when zeal + suspicion + the week's rise beat 180 + Business + Organisation", () => {
    const { w, player } = city();
    const b = racket(w, player);
    w.fbiZeal = 128;
    expect(racketEventSuspicion(w, b)).toBe(80);                // 20 × 4 on its own
    player.fbiWeekRise = 3;
    expect(fbiInvestigatesRacket(w, b)).toBe(false);            // 128 + 80 + 3 = 211, not above
    player.fbiWeekRise = 4;
    expect(fbiInvestigatesRacket(w, b)).toBe(true);
    const hood = w.people[b.managerId!];
    hood.skills.business = 5; hood.skills.organization = 5;     // 63 + 63: the bar is 306
    w.fbiZeal = 207; player.fbiWeekRise = 0;
    expect(fbiInvestigatesRacket(w, b)).toBe(false);
    player.fbiWeekRise = 20;
    expect(fbiInvestigatesRacket(w, b)).toBe(true);             // 207 + 80 + 20 = 307
    b.managerId = null;
    expect(fbiInvestigatesRacket(w, b)).toBe(false);            // no manager, no crime event
  });

  it('never looks into a card game, a dice game, grifters or an office (0x723E50 has no case for them)', () => {
    const { w, player } = city();
    const b = racket(w, player);
    w.fbiZeal = 255;
    expect(fbiInvestigatesRacket(w, b)).toBe(true);
    for (const typeId of ['cardGames', 'diceGame', 'grifters', 'office']) {
      b.typeId = typeId;
      expect(fbiInvestigatesRacket(w, b)).toBe(false);
      expect(fbiSolvesRacket(w, b, 255)).toBe(false);
    }
    b.typeId = 'teamsters';
    expect(fbiInvestigatesRacket(w, b)).toBe(true);
  });

  it('weighs a front by its cover: suspicion × 4, × 2 or × 1', () => {
    const { w, player } = city();
    const b = racket(w, player);
    const front = allBuildings(w).find(x => x.id !== b.id && !x.isHQ)!;
    b.frontId = front.id;
    b.cover = .35; expect(racketEventSuspicion(w, b)).toBe(80);
    b.cover = .6; expect(racketEventSuspicion(w, b)).toBe(40);
    b.cover = .95; expect(racketEventSuspicion(w, b)).toBe(20);
    w.fbiZeal = 190; player.fbiWeekRise = 0;
    expect(fbiInvestigatesRacket(w, b)).toBe(false);            // 190 + 20 = 210, bar 211
    b.cover = .6;
    expect(fbiInvestigatesRacket(w, b)).toBe(true);             // 190 + 40
  });

  it('sends an agent to search only a racket that passes', () => {
    const { w, player } = city();
    const b = racket(w, player);
    w.phase = 'week';
    w.fbiZeal = 128; player.fbiWeekRise = 0;
    dispatchFbi(w, new Rng(5));
    expect(w.fbiIds.some(id => w.people[id].fbiAssignment?.buildingId === b.id)).toBe(false);
    player.fbiWeekRise = 10;
    dispatchFbi(w, new Rng(5));
    const agents = w.fbiIds.filter(id => w.people[id].fbiAssignment?.buildingId === b.id);
    expect(agents.length).toBe(1);
    expect(w.people[agents[0]].fbiAssignment!.kind).toBe('search');
  });

  it("keeps the week's rise (FBI+0x190) in the save", () => {
    const { w, player } = city();
    player.accountantId = null;
    takings(w, player, 0, 2000);
    weeklyFbi(w, new Rng(1));
    expect(player.fbiWeekRise).toBe(20);
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(w));
    bad.gangs[player.id].fbiWeekRise = 300;
    expect(() => validateSaveWorld(bad)).toThrow(/weekly rise/);
  });
});

describe('the laundering and fencing raids (0x4F6220)', () => {
  /** A premises of the gang's, run by one of its hoods, holding nothing. */
  function premises(w: WorldState, g: Gang, typeId: string): Building {
    const b = allBuildings(w).find(x => !x.isHQ && x.ownerGangId == null && x.cls === 'commercial' && x.state !== 'destroyed')!;
    const hood = Object.values(w.people).find(p => p.gangId === g.id && p.id !== g.bossId && p.role === 'hood')!;
    Object.assign(b, { ownerGangId: g.id, typeId, cls: typeId === 'warehouse' ? 'industrial' : 'commercial', state: 'trading',
      discovered: false, managerId: hood.id, stock: { liquor: 0, stolen: 0, counterfeit: 0 } });
    delete b.fbiDiscoveredWeek; delete b.fbiRaidWeek; delete b.fbiClosedWeek; delete b.fbiSearchedWeek;
    hood.status = 'active';
    hood.skills.business = .5; hood.skills.stealth = .5; hood.skills.organization = .5;   // 6 + 6 + 6 + 63 = 81
    return b;
  }
  const roll = (n: number) => ({ int: (lo: number, hi: number) => Math.min(hi, Math.max(lo, n)) }) as unknown as Rng;

  it('draws on how full the store is: rand % 10 + held × 10 / (held + room) > 10', () => {
    const { w, player } = city();
    const b = premises(w, player, 'warehouse');
    b.stock.stolen = 300; b.stock.counterfeit = 15;                // full: 315 / 315
    expect(contrabandDraw(b, 0)).toBe(false);                      // 0 + 10
    expect(contrabandDraw(b, 1)).toBe(true);
    b.stock.stolen = 50; b.stock.counterfeit = 0;                  // 50 / (50 + 250 + 250 + 15)
    expect(contrabandDraw(b, 9)).toBe(false);
    const fence = premises(w, player, 'jewellers');                // stolen 60 and counterfeit 6, no liquor
    fence.stock.stolen = 60; fence.stock.counterfeit = 6;
    expect(contrabandDraw(fence, 1)).toBe(true);
    fence.stock.stolen = 30; fence.stock.counterfeit = 3;          // 33 / 66: 5
    expect(contrabandDraw(fence, 5)).toBe(false);
    expect(contrabandDraw(fence, 6)).toBe(true);
  });

  it('raids premises holding stolen goods or counterfeit money when the manager is below zeal − 63', () => {
    const { w, player } = city();
    w.fbiZeal = 207;
    const b = premises(w, player, 'warehouse');
    b.stock.stolen = 300;
    b.stock.counterfeit = 15;
    expect(launderingFencingRaids(w, roll(9))).toContain(b);
    expect(b.discovered).toBe(true);
    expect(b.fbiDiscoveredWeek).toBe(w.week);
    expect(b.fbiRaidWeek).toBe(w.week + 1);
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();
    // On next week's list already: not scheduled twice.
    expect(launderingFencingRaids(w, roll(9))).toContain(b);
    expect(b.fbiRaidWeek).toBe(w.week + 1);
  });

  it('spares a skilled manager, a store of liquor only, a store not full enough and an unmanaged one', () => {
    const { w, player } = city();
    w.fbiZeal = 207;
    const b = premises(w, player, 'warehouse');
    b.stock.stolen = 300; b.stock.counterfeit = 15;
    const m = w.people[b.managerId!];
    m.skills.business = 5; m.skills.stealth = 5; m.skills.organization = 5;   // 63 × 3 + 63 = 252
    expect(launderingFencingRaids(w, roll(9))).not.toContain(b);
    m.skills.business = .5; m.skills.stealth = .5; m.skills.organization = .5;
    w.fbiZeal = 81;
    expect(launderingFencingRaids(w, roll(9))).not.toContain(b);           // 81 is not below 81
    w.fbiZeal = 82;
    expect(launderingFencingRaids(w, roll(0))).not.toContain(b);           // 0 + 10
    const still = premises(w, player, 'warehouse');
    still.stock.liquor = 300;
    expect(launderingFencingRaids(w, roll(9))).not.toContain(still);       // liquor alone is not raided
    still.stock.liquor = 0; still.stock.stolen = 300; still.managerId = null;
    expect(launderingFencingRaids(w, roll(9))).not.toContain(still);
    expect(still.discovered).toBe(false);
  });

  it('runs at the end of the FBI weekly turn', () => {
    const { w, player } = city();
    player.accountantId = null;
    takings(w, player, 0, 0);
    w.fbiZeal = 207;
    const b = premises(w, player, 'jewellers');
    b.stock.stolen = 60; b.stock.counterfeit = 6;                   // full: raided unless the roll is 0
    let raided = 0;
    for (let seed = 1; seed <= 20; seed++) {
      delete b.fbiRaidWeek; delete b.fbiDiscoveredWeek; b.discovered = false;
      weeklyFbi(w, new Rng(seed));
      if (b.fbiRaidWeek === w.week + 1) raided++;
    }
    expect(raided).toBeGreaterThan(12);
  });
});

describe('the agent investigation (order 0x21, 0x5844A0, 0x580360)', () => {
  function racket(w: WorldState, g: Gang): Building {
    for (const x of allBuildings(w)) {
      x.discovered = true; x.fbiDiscoveredWeek = w.week; x.fbiRaidWeek = w.week + 50;
    }
    const b = allBuildings(w).find(x => !x.isHQ && x.typeId !== 'office' && x.cls === 'commercial' && x.state !== 'destroyed')!;
    const hood = Object.values(w.people).find(p => p.gangId === g.id && p.id !== g.bossId && p.role === 'hood')!;
    Object.assign(b, { ownerGangId: g.id, typeId: 'speakeasy', cls: 'illegal', state: 'trading', frontId: null, cover: 0,
      discovered: false, managerId: hood.id });
    delete b.fbiDiscoveredWeek; delete b.fbiRaidWeek; delete b.fbiClosedWeek; delete b.fbiSearchedWeek;
    hood.skills.business = 2; hood.skills.organization = .5;   // the bar is 211; suspicion 80
    return b;
  }
  /** An agent standing at the racket, his search nearly done. */
  function onSite(w: WorldState, b: Building) {
    const agent = w.people[w.fbiIds[0]];
    Object.assign(agent, { status: 'active', streetOrder: null, orderId: null, inVehicle: false, buildingId: null,
      pos: fbiWorkPosition(w, b, 0), dest: null, path: [] });
    agent.fbiAssignment = { buildingId: b.id, kind: 'search', assignedWeek: w.week, phase: 'working', searchPoint: 0, workLeft: 1 };
    w.phase = 'week'; w.minute = 1;
    return agent;
  }

  it('rolls the agent zeal once, 128..255, and keeps it', () => {
    const { w } = city();
    const agent = w.people[w.fbiIds[0]];
    const z = fbiAgentZeal(new Rng(7), agent);
    expect(z).toBeGreaterThanOrEqual(128);
    expect(z).toBeLessThanOrEqual(255);
    expect(fbiAgentZeal(new Rng(8), agent)).toBe(z);
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(w));
    bad.people[agent.id].fbiAgentZeal = 300;
    expect(() => validateSaveWorld(bad)).toThrow(/agent zeal/);
  });

  it('solves the racket by the same rule with the agent zeal in place of the FBI zeal', () => {
    const { w, player } = city();
    const b = racket(w, player);
    w.fbiZeal = 207; player.fbiWeekRise = 0;
    expect(fbiSolvesRacket(w, b, 131)).toBe(false);              // 131 + 80 = 211
    expect(fbiSolvesRacket(w, b, 132)).toBe(true);
    w.fbiZeal = 128;
    expect(fbiSolvesRacket(w, b, 132)).toBe(true);               // the FBI's zeal plays no part
  });

  it('finds a solved racket after one visit and schedules the raid', () => {
    const { w, player } = city();
    const b = racket(w, player);
    player.fbiWeekRise = 0;
    const agent = onSite(w, b);
    agent.fbiAgentZeal = 255;
    tickFbi(w, new Rng(3), 5);
    expect(b.discovered).toBe(true);
    expect(b.fbiRaidWeek).toBe(w.week + 1);
    expect(b.fbiDiscoveredWeek).toBe(w.week);
    expect(agent.fbiAssignment).toBeUndefined();
  });

  it('gives an unsolved racket up for the week after one visit', () => {
    const { w, player } = city();
    const b = racket(w, player);
    player.fbiWeekRise = 0;
    const agent = onSite(w, b);
    agent.fbiAgentZeal = 128;                                    // 128 + 80 = 208, not above 211
    tickFbi(w, new Rng(3), 5);
    expect(b.discovered).toBe(false);
    expect(b.fbiSearchedWeek).toBe(w.week);
    expect(agent.fbiAssignment).toBeUndefined();
  });

  it('returns the racket to state 1 when the agent is lost: no other agent before next week', () => {
    const { w, player } = city();
    const b = racket(w, player);
    player.fbiWeekRise = 10;                                     // the zeal rule passes
    w.fbiZeal = 128;
    const agent = onSite(w, b);
    agent.status = 'dead';
    dispatchFbi(w, new Rng(5));
    expect(agent.fbiAssignment).toBeUndefined();
    expect(b.fbiSearchedWeek).toBe(w.week);
    expect(w.fbiIds.some(id => w.people[id].fbiAssignment?.buildingId === b.id)).toBe(false);
  });

  it('no longer searches contraband premises in the original city', () => {
    const { w, player } = city();
    for (const x of allBuildings(w)) { x.discovered = true; x.fbiDiscoveredWeek = w.week; x.fbiRaidWeek = w.week + 50; }
    const b = allBuildings(w).find(x => !x.isHQ && x.cls === 'commercial' && x.state !== 'destroyed')!;
    Object.assign(b, { ownerGangId: player.id, typeId: 'jewellers', state: 'trading', discovered: false });
    delete b.fbiDiscoveredWeek; delete b.fbiRaidWeek; delete b.fbiClosedWeek; delete b.fbiSearchedWeek;
    b.stock.stolen = 40;
    w.phase = 'week';
    dispatchFbi(w, new Rng(5));
    expect(w.fbiIds.some(id => w.people[id].fbiAssignment?.buildingId === b.id)).toBe(false);
  });
});

describe('a member own FBI suspicion (+0x7C: 0x4DB700, 0x460300, the member pass)', () => {
  function men(w: WorldState, g: Gang) {
    const hoods = Object.values(w.people).filter(p => p.gangId === g.id && p.id !== g.bossId && p.role === 'hood').slice(0, 2);
    for (const p of hoods) { p.status = 'active'; p.teamId = null; delete p.crimeSuspicion; delete p.fbiWarrant; }
    return hoods;
  }
  function crime(w: WorldState, g: Gang, perpetratorId: number, kind: string, victimId: number | null = null) {
    w.crimes.push({ id: w.sequences.crime++, week: w.week, gangId: g.id, perpetratorId, kind, buildingId: null,
      victimId, witnesses: [], arrestRisk: .5, reported: true });
  }

  it('adds the suspicion of a crime above 59 to the man and his team, less for police and gangster victims', () => {
    const { w, player, ai } = city();
    const [a, b] = men(w, player);
    a.teamId = b.teamId = 9002;
    const citizen = Object.values(w.people).find(p => p.role === 'citizen')!;
    crime(w, player, a.id, 'kill', citizen.id);
    heavyCrimeSuspicion(w);
    expect(a.crimeSuspicion).toBe(100);
    expect(b.crimeSuspicion).toBe(100);                          // his team too
    w.crimes.length = 0; delete a.crimeSuspicion; delete b.crimeSuspicion; a.teamId = b.teamId = null;
    const officer = Object.values(w.people).find(p => p.role === 'police')!;
    const rival = Object.values(w.people).find(p => p.gangId === ai.id && p.role === 'hood')!;
    crime(w, player, a.id, 'kill', officer.id);                  // a policeman: half
    crime(w, player, b.id, 'kill', rival.id);                    // a gangster: a tenth
    crime(w, player, b.id, 'assault', citizen.id);               // 40: not above 59
    crime(w, player, b.id, 'kidnap', citizen.id);                // 60
    heavyCrimeSuspicion(w);
    expect(a.crimeSuspicion).toBe(50);
    expect(b.crimeSuspicion).toBe(10 + 60);
  });

  it('puts the boss own crimes on the gang total', () => {
    const { w, player } = city();
    player.fbiTotal = 200;
    crime(w, player, player.bossId, 'bomb');
    heavyCrimeSuspicion(w);
    expect(player.fbiTotal).toBe(255);
  });

  it('only counts the week being settled', () => {
    const { w, player } = city();
    const [a] = men(w, player);
    crime(w, player, a.id, 'ambush');
    w.crimes.at(-1)!.week = w.week - 1;
    heavyCrimeSuspicion(w);
    expect(a.crimeSuspicion).toBeUndefined();
  });

  it('loses a tenth a week, which never takes a small figure to 0', () => {
    const { w, player } = city();
    const [a, b] = men(w, player);
    a.crimeSuspicion = 250; b.crimeSuspicion = 9;
    decayCrimeSuspicion(w);
    expect(a.crimeSuspicion).toBe(225);
    expect(b.crimeSuspicion).toBe(9);
  });

  it('wants a member when 200 + rand(0..63) is below his suspicion', () => {
    const { w, player } = city();
    const [a, b] = men(w, player);
    a.crimeSuspicion = 264; b.crimeSuspicion = 200;
    expect(memberWarrants(w, new Rng(11))).toContain(a);
    expect(a.fbiWarrant).toBe(true);
    expect(b.fbiWarrant).toBeUndefined();
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(w));
    bad.people[a.id].crimeSuspicion = -3;
    expect(() => validateSaveWorld(bad)).toThrow(/personal FBI suspicion/);
  });

  it('serves a member warrant: arrested with his team, charged with his latest crime', () => {
    const { w, player } = city();
    const [a, b] = men(w, player);
    a.teamId = b.teamId = 9003;
    a.skills.intelligence = 5;                                   // byte 255: always comes quietly
    a.fbiWarrant = true;
    for (const id of w.fbiIds) w.people[id].status = 'active';
    crime(w, player, a.id, 'torch');
    const before = w.crimes.length;
    serveAccountantWarrants(w, new Rng(2));
    expect(a.status).toBe('arrested');
    expect(b.status).toBe('arrested');
    expect(a.fbiWarrant).toBeUndefined();
    expect(w.crimes.slice(before).filter(c => c.kind === 'torch').map(c => c.perpetratorId).sort()).toEqual([a.id, b.id].sort());
  });

  it('does not count the charge laid at an arrest as a fresh crime', () => {
    const { w, player } = city();
    const [a, b] = men(w, player);
    a.teamId = b.teamId = 9004;
    a.skills.intelligence = 5;
    a.fbiWarrant = true;
    for (const id of w.fbiIds) w.people[id].status = 'active';
    const citizen = Object.values(w.people).find(p => p.role === 'citizen')!;
    crime(w, player, a.id, 'kill', citizen.id);
    w.crimes[w.crimes.length - 1].week = w.week - 1;            // counted the week it was done
    serveAccountantWarrants(w, new Rng(2));
    expect(a.status).toBe('arrested');
    const charges = w.crimes.filter(c => c.week === w.week && c.kind === 'kill');
    expect(charges.map(c => c.perpetratorId).sort()).toEqual([a.id, b.id].sort());
    expect(charges.every(c => c.charge)).toBe(true);
    heavyCrimeSuspicion(w);
    expect(a.crimeSuspicion).toBeUndefined();
    expect(b.crimeSuspicion).toBeUndefined();
  });

  it('runs in the weekly turn: rise, decay, then the pass', () => {
    const { w, player } = city();
    player.accountantId = null;
    takings(w, player, 0, 0);
    const [a] = men(w, player);
    a.crimeSuspicion = 200;
    const citizen = Object.values(w.people).find(p => p.role === 'citizen')!;
    crime(w, player, a.id, 'kill', citizen.id);
    weeklyFbi(w, new Rng(1));
    expect(a.crimeSuspicion).toBe(270);                          // 300 less a tenth
    expect(a.fbiWarrant).toBe(true);                             // 270 beats 200 + 63
  });
});
