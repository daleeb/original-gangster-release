import { fearOf, hostilityOf } from '../src/sim/attitudes';
import { describe, expect, it } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { issueOrder, interrogatePrisoner, releasePrisoner, type IssueOrderInput } from '../src/sim/api';
import { MINUTES_PER_WEEK } from '../src/sim/constants';
import { Sim, MINUTES_PER_SECOND } from '../src/sim/sim';
import { presentationEvents } from '../src/sim/presentationEvents';
import { allBuildings, buildingDoor, dist, placeName, typeOf } from '../src/sim/world';

function fixture(seed = 404) {
  const sim = new Sim({ ...defaultGameOptions(), seed, citySize: 10, startMoney: 100_000, startHoods: 8 });
  const w = sim.world, gang = sim.playerGang, team = w.teams[gang.teamIds[0]];
  // Legal high-skill crew isolates execution from weak-crew failure rates. No
  // outcome rolls, travel, work clocks or other simulation systems are stubbed.
  for (const id of [team.lieutenantId, ...team.memberIds]) {
    for (const skill of Object.keys(w.people[id].skills) as (keyof typeof w.people[number]['skills'])[])
      w.people[id].skills[skill] = skill === 'knives' ? 0.5 : 5;
  }
  return { sim, w, gang, team };
}
type Fixture = ReturnType<typeof fixture>;

function run(s: Fixture, input: Omit<IssueOrderInput, 'teamId'>, mayFail = false) {
  const result = issueOrder(s.w, s.gang.id, { ...input, teamId: s.team.id,
    opts: { priority: true, manpower: 1, ...input.opts } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const order = s.w.orders[s.team.orderIds.at(-1)!];
  s.sim.launchWeek();
  expect(order.assignedIds.length).toBeGreaterThan(0);
  for (let minute = 0; minute < MINUTES_PER_WEEK - 1 && !['done', 'failed'].includes(order.state); minute++) s.sim.advance(1 / MINUTES_PER_SECOND, 1);
  console.info(`${input.type}, seed ${s.w.options.seed}, minute ${s.w.minute}: ${order.state}; ${order.results.join(' ')} ${order.failReason ?? ''}`);
  if (mayFail && order.state === 'failed') return order;
  expect(order.state, order.failReason ?? order.results.join(' ')).toBe('done');
  expect(order.completedTargets).toBe(1);
  return order;
}

describe('planned orders produce real gameplay outcomes', () => {
  it('changes the protection rate and then collects exactly that amount', () => {
    const s = fixture(), site = allBuildings(s.w).find(b => b.protection?.gangId === s.gang.id)!;
    const base = site.protection!.base;
    run(s, { type: 'adjustProtection', buildingIds: [site.id], opts: { protectionLevel: 1.5 } });
    expect(site.protection!.weekly).toBe(Math.round(base * 1.5));
    const before = s.gang.finances!.income.protection;
    // New planning boundary, preserving the actual adjusted site through settlement.
    s.sim.finishWeek();
    site.protection!.refusing = false;
    const opening = s.gang.finances!.income.protection;
    run(s, { type: 'collectProtection', buildingIds: [site.id] });
    expect(s.gang.finances!.income.protection - opening).toBe(site.protection!.weekly);
    expect(before).toBe(0);
  });

  it('exports warehouse stock with a truck and cannot sell it twice', () => {
    const s = fixture(), site = allBuildings(s.w).find(b => b.typeId === 'warehouse')!;
    site.ownerGangId = s.gang.id;
    site.stock = { liquor: 30, stolen: 20, counterfeit: 3 };
    s.team.vehicles.truck = 1;
    const cash = s.gang.cash, income = s.gang.finances!.income.illegal;
    const gross = 30 * 26 + 20 * 34 + 3 * 900;
    run(s, { type: 'export', buildingIds: [site.id] });
    expect(site.stock).toEqual({ liquor: 0, stolen: 0, counterfeit: 0 });
    expect(s.gang.cash - cash).toBe(gross);
    expect(s.gang.finances!.income.illegal - income).toBe(gross);
    for (let minute = 0; minute < 30; minute++) s.sim.advance(1 / MINUTES_PER_SECOND, 1);
    expect(s.gang.cash).toBe(cash + gross);
  });

  it('donates the specified amount and improves local opinion and goodwill', () => {
    const s = fixture(), site = allBuildings(s.w).find(b => b.cls === 'charity')!;
    const local = Object.values(s.w.people).filter(p => dist(p.pos, s.w.lots[site.lotId].center) < 70);
    const opinions = new Map(local.map(p => [p.id, p.opinion[s.gang.id] ?? 0]));
    const cash = s.gang.cash, goodwill = s.gang.goodwill;
    run(s, { type: 'donate', buildingIds: [site.id], opts: { amount: 1200 } });
    expect(s.gang.cash).toBe(cash - 1200);
    expect(s.gang.goodwill).toBeGreaterThan(goodwill);
    expect(local.some(p => (p.opinion[s.gang.id] ?? 0) > opinions.get(p.id)!)).toBe(true);
  });

  it.each(['hood', 'accountant', 'lawyer'] as const)('recruit finds a real available %s at the correct premises', role => {
    const s = fixture();
    const available = () => Object.values(s.w.people).find(p => p.gangId == null && p.role === role && p.status === 'active' &&
      p.buildingId != null && typeOf(s.w.buildings[p.buildingId])?.recruit === role);
    const first = available()!;
    expect(first).toBeDefined();
    // Persuasion is a real roll even for a strong crew; ask again next week, at
    // a site that still has somebody (a rival may have hired the first one).
    const asked: number[] = [];
    for (let week = 0; week < 3 && !s.gang.recruitIds.some(id => s.w.people[id].role === role); week++) {
      if (week) s.sim.finishWeek();
      const candidate = available()!;
      asked.push(candidate.id);
      run(s, { type: 'recruit', buildingIds: [candidate.buildingId!] });
    }
    expect(s.gang.recruitIds.some(id => s.w.people[id].role === role)).toBe(true);
    // Finding somebody is not silently hiring them into the gang.
    for (const id of asked) expect(s.w.people[id].gangId).not.toBe(s.gang.id);
  });

  it('points an empty recruiting site to hoods looking for work, never to an owner', () => {
    const s = fixture();
    const free = Object.values(s.w.people).filter(p => p.gangId == null && p.role === 'hood' && p.status === 'active');
    const sites = allBuildings(s.w).filter(b => b.state === 'trading' && typeOf(b)?.recruit === 'hood');
    const empty = sites[0], from = s.w.lots[empty.lotId].center;
    const byDistance = sites.slice(1).sort((a, b) => dist(s.w.lots[a.lotId].center, from) - dist(s.w.lots[b.lotId].center, from));
    const tipped = byDistance.at(-1)!, ownerOnly = byDistance[0];
    // The only hood looking for work is at the farthest site; nearer sites hold just their owners.
    for (const p of free) p.buildingId = null;
    free[0].buildingId = tipped.id;
    expect(Object.values(s.w.people).some(p => p.gangId == null && p.buildingId === ownerOnly.id && p.role !== 'hood')).toBe(true);
    const order = run(s, { type: 'recruit', buildingIds: [empty.id] });
    expect(order.results.join(' ')).toContain(`people looking for work at ${placeName(s.w, tipped)}`);
  });

  // Bribes and intimidation are real rolls that a skilled crew can still lose;
  // try a few fixed seeds and check the effects of the first success.
  it('bribes an owner, spends the chosen amount and records the allegiance', () => {
    let bribed = false;
    for (const seed of [404, 405, 406, 407, 408]) {
      const s = fixture(seed);
      const site = allBuildings(s.w).find(b => b.ownerPersonId != null && b.cls === 'commercial')!;
      const owner = s.w.people[site.ownerPersonId!], cash = s.gang.cash;
      run(s, { type: 'bribe', personId: owner.id, opts: { amount: 1100 } }, true);
      expect(s.gang.cash).toBe(cash - 1100);
      if (owner.bribedBy == null) continue;
      expect(owner.bribedBy).toBe(s.gang.id);
      bribed = true; break;
    }
    expect(bribed).toBe(true);
  });

  it('intimidates a refusing protection payer and makes collection possible again', () => {
    let cowed = false;
    for (const seed of [404, 405, 406, 407, 408]) {
      const s = fixture(seed), site = allBuildings(s.w).find(b => b.protection?.gangId === s.gang.id)!;
      site.protection!.refusing = true; site.protection!.grievance = 5;
      run(s, { type: 'intimidate', buildingIds: [site.id] });
      expect(s.w.crimes.some(c => c.kind === 'intimidate' && c.gangId === s.gang.id)).toBe(true);
      if (site.protection!.refusing) continue;
      expect(site.protection!.grievance).toBe(0);
      cowed = true; break;
    }
    expect(cowed).toBe(true);
  });

  it('cows a shopkeeper only over premises that are no gang’s or the intimidator’s (0x4DE030)', () => {
    const outcomes = { own: false, rival: false };
    for (const seed of [404, 405, 406, 407, 408, 409, 410, 411]) for (const whose of ['own', 'rival'] as const) {
      if (outcomes[whose]) continue;
      const s = fixture(seed), rival = Object.values(s.w.gangs).find(g => !g.isPlayer)!;
      const site = allBuildings(s.w).find(b => b.protection?.gangId === s.gang.id && b.ownerPersonId != null)!;
      // The order only targets sites this gang protects; another gang owning
      // the premises is what makes them "another gang's" (vt+176).
      if (whose === 'rival') site.ownerGangId = rival.id;
      site.protection!.refusing = true;
      const owner = s.w.people[site.ownerPersonId!];
      const before = [hostilityOf(owner, s.gang.id), fearOf(owner, s.gang.id)];
      const order = run(s, { type: 'intimidate', buildingIds: [site.id] });
      if (!order.results.join(' ').includes('has seen sense')) continue;
      expect([hostilityOf(owner, s.gang.id), fearOf(owner, s.gang.id)]).toEqual(whose === 'own'
        ? [Math.max(0, before[0] - 32), Math.min(255, before[1] + 32)] : before);
      outcomes[whose] = true;
    }
    expect(outcomes).toEqual({ own: true, rival: true });
  });

  it('successful raids bring money and trucked goods back; botched raids do not', () => {
    // A skilled crew can still fail its roll. Fixed seeds must exercise both
    // outcomes; do not assume one city's changing street RNG guarantees loot.
    let successes = 0, failures = 0;
    for (const seed of [404, 405, 406, 407, 408, 409, 410, 411]) {
      if (successes && failures) break;
      const s = fixture(seed);
      // After a success, send a half-star crew so a botch is likely too.
      if (successes) for (const id of [s.team.lieutenantId, ...s.team.memberIds])
        for (const skill of Object.keys(s.w.people[id].skills) as (keyof typeof s.w.people[number]['skills'])[]) s.w.people[id].skills[skill] = 0.5;
      const warehouse = allBuildings(s.w).find(b => b.typeId === 'warehouse')!;
      warehouse.ownerGangId = s.gang.id; warehouse.stock = { liquor: 0, stolen: 0, counterfeit: 0 };
      s.team.vehicles.truck = 1;
      const site = allBuildings(s.w).find(b => b.id !== warehouse.id && b.ownerGangId == null && b.state === 'trading' && typeOf(b)?.stores?.length)!;
      // Every possible haul fits the empty warehouse, including its smaller
      // counterfeit compartment. Overflow/recovery has separate cargo tests.
      site.stock = { liquor: 10, stolen: 10, counterfeit: 10 };
      const cash = s.gang.cash;
      const order = run(s, { type: 'raid', buildingIds: [site.id] }, true);
      const goods = Object.values(warehouse.stock).reduce((a, b) => a + b, 0);
      // The courier can be shot by a rival on the way back (the city is live):
      // that seed says nothing about delivery, which cargo tests cover.
      if (order.results.includes('The raided goods were lost.')) continue;
      if (order.results.some(line => line.startsWith('Raided '))) {
        successes++;
        expect(s.gang.cash).toBeGreaterThan(cash);
        expect(goods).toBe(10);
      } else {
        failures++;
        // A botched raid has failed (it was reported done).
        expect(order.state).toBe('failed');
        expect(order.failReason).toContain('was botched.');
        expect(s.gang.cash).toBe(cash);
        expect(goods).toBe(0);
      }
      expect(s.w.crimes.some(c => c.kind === 'raid' && c.gangId === s.gang.id)).toBe(true);
    }
    expect(successes).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0);
  });

  it('replaces the old manager with the dispatched hood and returns the old manager', () => {
    const s = fixture(), site = allBuildings(s.w).find(b => b.ownerGangId === s.gang.id && b.managerId != null)!;
    const old = s.w.people[site.managerId!], replacement = s.w.people[s.team.memberIds[0]];
    old.skills.business = old.skills.organization = 5;
    for (const id of s.team.memberIds) s.w.people[id].skills.business = s.w.people[id].skills.organization = 2;
    run(s, { type: 'runBusiness', buildingIds: [site.id], opts: { preferredHoodId: replacement.id } });
    expect(site.managerId).toBe(replacement.id);
    expect(old.buildingId).toBeNull();
    expect(replacement.buildingId).toBe(site.id);
    expect(replacement.teamId).toBeNull();
    const home = allBuildings(s.w).find(b => b.isHQ && b.ownerGangId === s.gang.id)!;
    for (let minute = 0; minute < 100 && old.dest; minute++) s.sim.advance(1 / MINUTES_PER_SECOND, 1);
    expect(dist(old.pos, buildingDoor(s.w, home))).toBeLessThan(1);
  });

  it.each(['the crew has no hood', 'the lieutenant is named'])('keeps the manager and reports failure when no hood goes because %s', (reason) => {
    const s = fixture(), site = allBuildings(s.w).find(b => b.ownerGangId === s.gang.id && b.managerId != null)!;
    const manager = site.managerId!;
    if (reason === 'the crew has no hood') {
      for (const id of s.team.memberIds.splice(0)) { s.w.people[id].teamId = null; s.gang.poolIds.push(id); }
    }
    const preferredHoodId = reason === 'the lieutenant is named' ? s.team.lieutenantId : null;
    const order = run(s, { type: 'runBusiness', buildingIds: [site.id], opts: { preferredHoodId } }, true);
    expect(order.state).toBe('failed');
    expect(order.failReason).toMatch(/No hood was free to run/);
    expect(order.results.join(' ')).not.toMatch(/New management/);
    expect(site.managerId).toBe(manager);
    expect(s.w.people[manager].buildingId).toBe(site.id);
  });

  it('kidnaps a rival, allows interrogation and releases them onto the street', () => {
    // A kidnapping is a real roll a strong crew can still lose; take the first
    // fixed seed where it succeeds and check everything after it.
    const attempt = (seed: number) => {
      const s = fixture(seed);
      const rival = Object.values(s.w.gangs).find(g => !g.isPlayer)!;
      // Taken off his crew into the reserve, so no orders of his own walk him off.
      const crew = s.w.teams[rival.teamIds[0]], victim = s.w.people[crew.memberIds[0]];
      crew.memberIds = crew.memberIds.filter(id => id !== victim.id); victim.teamId = null; rival.poolIds.push(victim.id);
      // A stationary rival on a public street, known to the player's crew.
      const home = allBuildings(s.w).find(b => b.isHQ && b.ownerGangId === s.gang.id)!;
      victim.pos = buildingDoor(s.w, home); victim.buildingId = null; victim.dest = null; victim.path = []; victim.halted = true;
      s.gang.knownPeople.push(victim.id);
      run(s, { type: 'kidnap', personId: victim.id }, true);
      return { s, victim, home };
    };
    const { s, victim, home } = [405, 406, 407, 408, 409].map(attempt).find(a => a.victim.status === 'kidnapped') ?? attempt(405);
    expect(victim.status).toBe('kidnapped'); expect(victim.capturedBy).toBe(s.gang.id);
    expect(victim.dest).toBeNull(); expect(victim.path).toEqual([]); expect(victim.streetOrder).toBeNull();
    expect(s.gang.prisonerIds).toContain(victim.id);
    const loaded = Sim.fromSave(structuredClone(s.w)), prisoner = loaded.world.people[victim.id];
    expect(interrogatePrisoner(loaded.world, loaded.rng, s.gang.id, prisoner.id).ok).toBe(true);
    expect(prisoner.interrogationValue).toBe(70);
    expect(releasePrisoner(loaded.world, s.gang.id, prisoner.id).ok).toBe(true);
    expect(prisoner.status).toBe('active'); expect(prisoner.capturedBy).toBeNull();
    expect(loaded.playerGang.prisonerIds).not.toContain(prisoner.id);
    expect(dist(prisoner.pos, buildingDoor(loaded.world, home))).toBeLessThan(2);
    expect(prisoner.dest).toBeNull(); expect(prisoner.path).toEqual([]);
  });

  it('smashes up a trading shop, closes it and creates a repair bill', () => {
    // High skills do not guarantee success. Check consequences for every
    // actual roll across fixed seeds, and require a successful completed job.
    let successes = 0;
    for (const seed of [404, 405, 406]) {
      const s = fixture(seed);
      const site = allBuildings(s.w).find(b => b.cls === 'commercial' && b.ownerGangId == null && b.state === 'trading')!;
      const previousRepair = site.repairCost;
      // A failed roll ends the order failed; its consequences are checked below.
      const order = run(s, { type: 'smashUp', buildingIds: [site.id] }, true);
      if (order.results.some(line => line.startsWith('Wrecked '))) {
        successes++;
        expect(site.state).toBe('damaged'); expect(site.repairCost).toBeGreaterThan(0);
      } else {
        expect(order.results.some(line => line.startsWith('Could not get into '))).toBe(true);
        expect(site.state).toBe('trading'); expect(site.repairCost).toBe(previousRepair);
      }
      expect(s.w.crimes.some(c => c.kind === 'smashUp' && c.gangId === s.gang.id)).toBe(true);
    }
    expect(successes).toBeGreaterThan(0);
  });

  it.each(['torch', 'bomb'] as const)('%s reaches the premises and applies damage, crime and a building-effect cue', type => {
    let successes = 0;
    for (const seed of [404, 405, 406]) {
      const s = fixture(seed);
      const site = allBuildings(s.w).find(b => b.cls === 'commercial' && b.ownerGangId == null && b.state === 'trading')!;
      s.team.weapons.explosives = 2;
      // A throw can miss; the failed branch below checks that case.
      const order = run(s, { type, buildingIds: [site.id] }, true);
      const success = order.results.some(line => type === 'torch' ? line.startsWith('Put ') : line.endsWith('is a pile of rubble.'));
      if (success) {
        successes++;
        expect(site.state).toBe(type === 'torch' ? 'damaged' : 'destroyed');
        if (type === 'torch') expect(site.fireWeek).toBe(s.w.week);
        expect(presentationEvents(s.w).events.some(e => e.kind === (type === 'torch' ? 'fire' : 'explosion') && e.buildingId === site.id)).toBe(true);
      } else {
        expect(order.results.some(line => type === 'torch' ? line.endsWith('would not take.') : line === 'The bomb went off early.')).toBe(true);
        expect(site.state).toBe('trading');
        expect(presentationEvents(s.w).events.some(e => e.kind === (type === 'torch' ? 'fire' : 'explosion') && e.buildingId === site.id)).toBe(false);
        if (type === 'bomb') expect(s.w.crimes.some(c => c.kind === type && c.gangId === s.gang.id && s.w.people[c.perpetratorId!].hp <= 20)).toBe(true);
      }
      expect(s.team.weapons.explosives).toBe(type === 'torch' ? 2 : 1);
      expect(s.w.crimes.some(c => c.kind === type && c.gangId === s.gang.id)).toBe(true);
      // The crew arrives by car: the thrower steps out, throws, and gets back in.
      expect(presentationEvents(s.w).events.some(e => e.kind === 'throw' && e.throwable === (type === 'torch' ? 'molotov' : 'bomb'))).toBe(true);
      const thrower = s.w.people[order.assignedIds[0]];
      if (thrower?.status === 'active' && thrower.vehicleKey) expect(thrower.inVehicle).toBe(true);
    }
    expect(successes).toBeGreaterThan(0);
  });
});
