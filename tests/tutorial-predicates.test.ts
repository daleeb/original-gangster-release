import { describe, expect, it } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { applyTutorial, TUTORIALS } from '../src/app/tutorials';
import { buyWeapon, defaultOptions, issueOrder, nearTerritory, setDiplomacy, validBuildingTarget } from '../src/sim/api';
import { isValidAreaTarget } from '../src/sim/execution';
import { Sim } from '../src/sim/sim';
import type { OrderType } from '../src/sim/types';
import { allBuildings } from '../src/sim/world';

function ordered(sim: Sim, type: OrderType) {
  const w = sim.world, g = sim.playerGang;
  // Anything for sale to this gang: the middle of a block is not, until it owns a front there.
  const b = allBuildings(w).find(b => type === 'buyPremises'
    ? validBuildingTarget(w, g.id, type, b, defaultOptions()) && nearTerritory(w, g.id, b.blockId, 2)
    : isValidAreaTarget(w, g.id, type, b))!;
  if (type === 'buyPremises') g.cash = Math.max(g.cash, 1_000_000);
  expect(issueOrder(w, g.id, { teamId: g.teamIds[0], type, buildingIds: [b.id] }).ok).toBe(true);
  const order = w.orders[w.teams[g.teamIds[0]].orderIds.at(-1)!];
  return () => { order.state = 'cancelled'; };
}

function specialist(sim: Sim, role: 'lawyer' | 'accountant') {
  const p = Object.values(sim.world.people).find(p => p.role === role)!;
  p.status = 'active';
  p.gangId = sim.playerGang.id;
  sim.playerGang[role === 'lawyer' ? 'lawyerId' : 'accountantId'] = p.id;
  return p;
}

function frontedLand(sim: Sim) {
  const w = sim.world, g = sim.playerGang;
  const land = allBuildings(w).find(b => w.lots[b.lotId].index === 4 && b.cls === 'empty')!;
  const front = allBuildings(w).find(b => b.blockId === land.blockId && b.id !== land.id)!;
  land.ownerGangId = front.ownerGangId = g.id;
  front.typeId = 'cafe'; front.cls = 'commercial'; front.state = 'trading'; front.hidesId = null;
  return { land, front };
}

const cases: { lesson: number; step: number; setup: (s: Sim) => () => void }[] = [
  { lesson: 1, step: 0, setup: s => { s.world.tutorialActions = { lieutenantsViewed: true }; return () => { s.world.tutorialActions = {}; }; } },
  { lesson: 1, step: 1, setup: s => ordered(s, 'extort') },
  { lesson: 1, step: 2, setup: s => { s.world.phase = 'week'; return () => { s.world.phase = 'planning'; }; } },
  { lesson: 1, step: 3, setup: s => { s.world.week = 2; return () => { s.world.week = 1; }; } },
  { lesson: 1, step: 4, setup: s => { s.world.tutorialActions = { reportsViewed: true }; return () => { s.world.tutorialActions = {}; }; } },
  { lesson: 2, step: 0, setup: s => ordered(s, 'buyPremises') },
  { lesson: 2, step: 1, setup: s => { const { front } = frontedLand(s); return () => { front.state = 'destroyed'; }; } },
  { lesson: 2, step: 2, setup: s => { const { front } = frontedLand(s); return () => { front.hidesId = 99999999; }; } },
  { lesson: 2, step: 3, setup: s => {
    const { land, front } = frontedLand(s);
    land.typeId = 'numbersRacket'; land.cls = 'illegal'; land.state = 'trading'; land.frontId = front.id; front.hidesId = land.id;
    return () => { land.state = 'destroyed'; };
  } },
  { lesson: 2, step: 4, setup: s => ordered(s, 'collectProtection') },
  { lesson: 3, step: 0, setup: s => { const p = specialist(s, 'lawyer'); return () => { p.status = 'dead'; }; } },
  { lesson: 3, step: 1, setup: s => { const p = s.world.people[s.world.policeIds[0]]; p.bribedBy = s.playerGang.id; return () => { p.role = 'citizen'; }; } },
  { lesson: 3, step: 2, setup: s => { const p = s.world.people[s.world.policeIds[0]]; p.employedBy = s.playerGang.id; s.playerGang.employedPoliceIds = [p.id]; return () => { p.employedBy = null; }; } },
  { lesson: 3, step: 3, setup: s => { const p = specialist(s, 'accountant'); return () => { p.status = 'dead'; }; } },
  { lesson: 3, step: 4, setup: s => { specialist(s, 'accountant'); s.playerGang.evadingTax = true; return () => { s.playerGang.accountantId = null; }; } },
  { lesson: 4, step: 0, setup: s => { buyWeapon(s.world, s.playerGang.id, 'pistol'); return () => { s.world.tutorialActions!.weaponBought = false; }; } },
  { lesson: 4, step: 1, setup: s => {
    const rival = allBuildings(s.world).find(b => b.ownerGangId != null && b.ownerGangId !== s.playerGang.id && b.cls !== 'empty')!;
    expect(issueOrder(s.world, s.playerGang.id, { teamId: s.playerGang.teamIds[0], type: 'explore', buildingIds: [rival.id] }).ok).toBe(true);
    return () => { s.world.tutorialActions!.rivalExplorationOrdered = false; };
  } },
  { lesson: 4, step: 2, setup: s => { const rival = Object.values(s.world.gangs).find(g => !g.isPlayer)!; setDiplomacy(s.world, s.playerGang.id, rival.id, 'war'); return () => { rival.eliminated = true; }; } },
  { lesson: 4, step: 3, setup: s => ordered(s, 'ambush') },
  // Through a week of war: a violent order given, and the boss alive in week 2.
  { lesson: 4, step: 4, setup: s => { ordered(s, 'ambush'); s.world.week = 2; return () => { delete s.world.people[s.playerGang.bossId]; }; } },
];

describe('every tutorial step', () => {
  it.each(cases)('requires a valid positive condition for lesson $lesson step $step', ({ lesson, step, setup }) => {
    const tutorial = TUTORIALS[lesson - 1];
    const sim = new Sim(applyTutorial(defaultGameOptions(), tutorial));
    const done = () => tutorial.steps[step].done(sim.world, sim.playerGang.id);
    expect(done()).toBe(false);
    const invalidate = setup(sim);
    expect(done()).toBe(true);
    invalidate();
    expect(done()).toBe(false);
  });
});
