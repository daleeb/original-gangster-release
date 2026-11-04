import { addMessage, addNews } from '../events';
import { clearDestination, setDestination, stepPerson } from '../movement';
import { stopBusinessGuards } from '../execution';
import { availableSpecialist } from '../specialists';
import { currentFinances } from '../finances';
import { blockRect } from '../cityLayout';
import { trafficContext } from '../traffic';
import { peopleList } from '../entityLists';
import { dismount } from '../transport';
import { onRoad, pavementBeside } from '../vehicleNavigation';
import { accountantSkillByte } from './taxes';
import { WAREHOUSE_CASH_CAP, WAREHOUSE_GOODS_CAP } from '../constants';
import { BUILDING_BY_ID } from '../data/buildings';
import { describeCrime } from './law';
import { skillByte } from '../fireRoll';
import type { Rng } from '../rng';
import type { Building, Gang, ID, Person, Vec2, WorldState } from '../types';
import { allBuildings, buildingDoor, buildingName, dist } from '../world';

const SEARCH_MINUTES = 20, RAID_MINUTES = 10, SEARCH_POINTS = [0, -5, 5];
/** 0x4F6ED0: one agent leads the squad and up to seven more join it. */
const ARREST_SQUAD = 8;
/** 0x4F5860: above this total the FBI opens a case against the boss. */
export const FBI_CASE_THRESHOLD = 200;
/** Crime.xtx row 0x25 (`evade tax`): its suspicion byte, city+0x1BA4. */
export const EVADE_TAX_SUSPICION = 10;
/** 0x4F6750: more people than this on the gangs' payrolls brings a crackdown. */
export const CRACKDOWN_PAYROLL = 100;
/** Crime.xtx: the suspicion byte of every racket row (0x2C–0x39). */
export const RACKET_SUSPICION = 20;
/**
 * Racket kinds the FBI never looks into. 0x4F7750 opens an event for every
 * racket kind but the office (10), with the row by kind (the alphabetical
 * Illegal Economics.xtx order); the racket step 0x723E50 then checks the
 * cell's kind (+0x54) against the row and has no case for kinds 0, 3 and 5,
 * card game, dice game and grifters (rows 0x2D, 0x30, 0x33), so their events
 * are closed (state 3) at their first step and a fresh one each week closes
 * the same way.
 */
export const UNINVESTIGATED_RACKETS: ReadonlySet<string> = new Set(['cardGames', 'diceGame', 'grifters', 'office']);
/** 0x4F5AE0: what a racket must beat, besides its manager's skills (0xB4). */
export const RACKET_INVESTIGATION_BAR = 180;
/** 0x4F6220: a manager is a raid target when Business + Stealth + Organisation
 * + 63 is below the FBI's zeal. */
export const RAID_MANAGER_BAR = 63;
/** Crime.xtx suspicion byte (+0xC) of the rows the remake's crime kinds file. */
export const CRIME_ROW_SUSPICION: Readonly<Record<string, number>> = {
  bribe: 20, extort: 20, intimidate: 20, kidnap: 60, raid: 40, ambush: 100, assault: 40, streetAssault: 40,
  bomb: 80, kill: 100, streetKill: 100, smashUp: 60, torch: 80,
};
/** 0x4DB700: only a crime whose suspicion is above 59 marks the men who did it. */
export const HEAVY_CRIME_SUSPICION = 59;
/** 0x4F5AE0's member pass: a man is wanted when 200 + rand(0..63) < his +0x7C. */
export const MEMBER_WARRANT_BAR = 200;
/** The roster's people (classes 0x1A–0x1F) other than the boss. */
const WARRANT_ROLES: ReadonlySet<string> = new Set(['hood', 'lieutenant', 'accountant', 'lawyer']);

function operation(w: WorldState, b: Building): boolean {
  return b.ownerGangId != null && !!w.gangs[b.ownerGangId] && !w.gangs[b.ownerGangId].eliminated &&
    b.typeId !== 'office' && !b.isHQ && b.cls !== 'empty' && b.cls !== 'municipal' &&
    b.state !== 'destroyed' && b.state !== 'empty' && b.fbiClosedWeek == null;
}

function suspicious(w: WorldState, b: Building): boolean {
  return operation(w,b) && b.state === 'trading' && (b.cls === 'illegal' ||
    b.stock.liquor > 0 || b.stock.stolen > 0 || b.stock.counterfeit > 0 ||
    (b.launderingWeek != null && w.week - b.launderingWeek <= 1));
}

/** Original city: the premises' own suspicion byte, raised by an unlaundered
 * pool (0x6CFB30). The original's FBI reads it once, as the suspicion of the
 * racket's crime event (0x4F7750, `racketEventSuspicion`); here it also adds
 * to search priority and chance (remake mapping). Compact cities: none. */
function premisesSuspicion(w: WorldState, b: Building): number {
  return w.cityLayout?.original && !b.discovered ? Math.max(0, Math.min(255, b.fbiSuspicion ?? 0)) : 0;
}

function available(w: WorldState, p: Person): boolean {
  return p.role === 'fbi' && p.status === 'active' && !p.streetOrder && p.orderId == null &&
    p.burningEscape?.week !== w.week && !p.emergencyResponse && !p.shockReaction;
}

/** Older saves have only a discovery flag: allow a full week before the raid. */
export function normalizeFbiInvestigations(w: WorldState): void {
  for (const b of allBuildings(w)) {
    if (!operation(w,b) || !b.discovered) continue;
    b.fbiDiscoveredWeek ??= w.week;
    b.fbiRaidWeek ??= b.fbiDiscoveredWeek + 1;
  }
}

/** Original city: the office a boss's raid lands on. */
function headquarters(w: WorldState, gangId: ID): Building | undefined {
  return allBuildings(w).find(b => b.isHQ && b.ownerGangId === gangId && b.state !== 'destroyed');
}

function arrestDue(w: WorldState, b: Building): boolean {
  const gang = b.ownerGangId == null ? undefined : w.gangs[b.ownerGangId];
  return !!gang && !gang.eliminated && b.isHQ && b.state !== 'destroyed' &&
    gang.fbiRaidWeek != null && w.week >= gang.fbiRaidWeek;
}

function assignmentValid(w: WorldState, p: Person): boolean {
  const job = p.fbiAssignment, b = job && w.buildings[job.buildingId];
  if (job?.kind === 'arrest') return !!b && arrestDue(w,b);
  if (!job || !b || !operation(w,b)) return false;
  return job.kind === 'search' ? suspicious(w,b) && !b.discovered
    : b.discovered && b.fbiRaidWeek != null && w.week >= b.fbiRaidWeek;
}

function releaseAssignment(p: Person): void {
  delete p.fbiAssignment;
  if (!p.streetOrder && p.orderId == null && !p.emergencyResponse && !p.shockReaction) clearDestination(p);
}

/** Search along the legal front's pavement. Never aim at a hidden lot's centre. */
export function fbiWorkPosition(w: WorldState, b: Building, point = 0): Vec2 {
  const door = buildingDoor(w,b), front = b.frontId == null ? b : w.buildings[b.frontId] ?? b;
  const r = blockRect(w.blocks[front.blockId]), offset = SEARCH_POINTS[point] ?? 0;
  if (door.y < r.y || door.y > r.y+r.h) return {x:Math.max(r.x+1,Math.min(r.x+r.w-1,door.x+offset)),y:door.y};
  return {x:door.x,y:Math.max(r.y+1,Math.min(r.y+r.h-1,door.y+offset))};
}

export function dispatchFbi(w: WorldState, rng: Rng): void {
  if (w.phase !== 'week') return;
  normalizeFbiInvestigations(w);
  const claimed = new Map<number, number>();
  for (const id of w.fbiIds) {
    const p = w.people[id], job = p?.fbiAssignment;
    if (!job) continue;
    const n = claimed.get(job.buildingId) ?? 0;
    if (p.status !== 'active') { investigatorLost(w,p); releaseAssignment(p); }
    else if (!assignmentValid(w,p) || n >= (job.kind === 'arrest' ? ARREST_SQUAD : 1)) releaseAssignment(p);
    else claimed.set(job.buildingId, n+1);
  }
  const agents = w.fbiIds.map(id => w.people[id]).filter(p => p && available(w,p) && !p.fbiAssignment);
  if (!agents.length) return;
  // Original city: a boss's raid takes the squad before any search.
  const offices = Object.values(w.gangs).map(g => g.fbiRaidWeek != null && g.fbiRaidWeek <= w.week ? headquarters(w,g.id) : undefined)
    .filter((b): b is Building => !!b && arrestDue(w,b)).sort((a,b) => a.id-b.id);
  for (const b of offices) {
    while (agents.length && (claimed.get(b.id) ?? 0) < ARREST_SQUAD) {
      const agent = agents.shift()!;
      agent.fbiAssignment = {buildingId:b.id,kind:'arrest',assignedWeek:w.week,phase:'travelling',searchPoint:0,workLeft:RAID_MINUTES};
      agent.inVehicle = false; agent.buildingId = null;
      setDestination(w,agent,fbiWorkPosition(w,b));
      claimed.set(b.id,(claimed.get(b.id) ?? 0)+1);
    }
  }
  if (!agents.length) return;
  const targets = allBuildings(w).filter(b => !claimed.has(b.id) && operation(w,b));
  const raids = targets.filter(b => b.discovered && b.fbiRaidWeek != null && b.fbiRaidWeek <= w.week)
    .sort((a,b) => a.fbiRaidWeek! - b.fbiRaidWeek! || a.id-b.id);
  // Original city: only a racket is looked into, and only when the zeal rule
  // passes (0x4F5AE0, state 1). Contraband is raided by 0x4F6220 instead.
  const searches = targets.filter(b => !b.discovered && b.fbiSearchedWeek !== w.week && suspicious(w,b) &&
      (!w.cityLayout?.original || b.cls === 'illegal' && fbiInvestigatesRacket(w,b)))
    .map(b => ({b,score:w.gangs[b.ownerGangId!].suspicion*(1.3-b.cover)+premisesSuspicion(w,b)/4+rng.range(0,18)}))
    .sort((a,b) => b.score-a.score || a.b.id-b.b.id);
  for (const agent of agents) {
    const raid = raids.shift(), b = raid ?? searches.shift()?.b;
    if (!b) break;
    agent.fbiAssignment = {buildingId:b.id,kind:raid?'raid':'search',assignedWeek:w.week,
      phase:'travelling',searchPoint:0,workLeft:raid?RAID_MINUTES:SEARCH_MINUTES};
    agent.inVehicle = false; agent.buildingId = null;
    setDestination(w,agent,fbiWorkPosition(w,b));
  }
}

function guarded(w: WorldState, b: Building): boolean {
  const front = b.frontId == null ? null : w.buildings[b.frontId];
  return [...b.guardIds,...(front?.guardIds ?? [])].some(id => {
    const p = w.people[id];
    return p?.status === 'active' && p.gangId === b.ownerGangId && dist(p.pos,buildingDoor(w,b)) <= 12;
  });
}

function searchSite(w: WorldState, rng: Rng, b: Building, agent: Person): boolean {
  const gang = w.gangs[b.ownerGangId!];
  if (w.cityLayout?.original) {
    // 0x580360: the investigation is solved, or not, by the agent's own zeal.
    if (!fbiSolvesRacket(w, b, fbiAgentZeal(rng, agent))) return false;
  } else {
    const head = w.people[w.fbiHeadId];
    const competence = head?.status === 'active' ? head.skills.intelligence : .5;
    const interest = .2 + gang.suspicion/100*1.6 + premisesSuspicion(w,b)/255*.8;
    const chance = (.03+(1-b.cover)*.22)*interest+(competence-2.5)*.03-(guarded(w,b) ? .06 : 0);
    if (!rng.chance(Math.max(.01,Math.min(.85,chance)))) return false;
  }
  b.discovered = true; b.fbiSuspicion = 100; b.fbiDiscoveredWeek = w.week; b.fbiRaidWeek = w.week+1;
  if (gang.isPlayer) addMessage(w,'police','An FBI agent found an illegal operation. A raid is expected next week.',buildingDoor(w,b),agent.id);
  if (gang.isPlayer) w.weekLog.push(`The FBI located an operation belonging to ${gang.name}; a raid is planned for week ${b.fbiRaidWeek}.`);
  return true;
}

/** Real travel and bounded work at three points; every phase survives saves. */
export function tickFbi(w: WorldState, rng: Rng, minutes: number): void {
  if (w.phase !== 'week') return;
  if (w.minute % 30 === 0) dispatchFbi(w,rng);
  const traffic = trafficContext(w);
  for (const id of w.fbiIds) {
    const agent = w.people[id], job = agent?.fbiAssignment;
    if (!agent || !job) continue;
    if (agent.status !== 'active') { investigatorLost(w,agent); releaseAssignment(agent); continue; }
    if (!assignmentValid(w,agent)) { releaseAssignment(agent); continue; }
    if (!available(w,agent)) continue;
    const b = w.buildings[job.buildingId], target = fbiWorkPosition(w,b,job.searchPoint);
    if (dist(agent.pos,target) > .75) {
      job.phase = 'travelling';
      if (!agent.dest || dist(agent.dest,target) > .1) setDestination(w,agent,target);
      if (stepPerson(agent,minutes,traffic)) job.phase = 'working';
      continue;
    }
    clearDestination(agent); job.phase = 'working'; job.workLeft = Math.max(0,job.workLeft-minutes);
    if (job.workLeft > 0) continue;
    if (job.kind === 'raid') { raidSite(w,rng,b,agent); releaseAssignment(agent); continue; }
    if (job.kind === 'arrest') { raidHeadquarters(w,rng,b,agent); releaseAssignment(agent); continue; }
    const found = searchSite(w,rng,b,agent);
    // Original city: one visit (order 0x21 waits at the event's cell), one verdict.
    if (found || w.cityLayout?.original || job.searchPoint === SEARCH_POINTS.length-1) {
      b.fbiSearchedWeek = w.week; releaseAssignment(agent);
    } else {
      job.searchPoint++; job.phase = 'travelling'; job.workLeft = SEARCH_MINUTES;
      setDestination(w,agent,fbiWorkPosition(w,b,job.searchPoint));
    }
  }
}

/**
 * The FBI. Incorruptible: it follows money it cannot explain, then sends agents
 * to search, then raids what they find. Violence against agents only hardens it.
 */
export function weeklyFbi(w: WorldState, rng: Rng): void {
  const original = !!w.cityLayout?.original;
  if (original) { fbiZeal(w, rng); serveAccountantWarrants(w, rng); heavyCrimeSuspicion(w); }
  // ---- suspicion follows unexplained money
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;

    // A trading loss cannot create illicit receipts through negative cover.
    const legal = Math.max(0, gang.lastWeekIncome.legal);
    const risky = currentFinances(w, gang).riskyIncome!;

    // A good accountant hides income behind legitimate profits.
    const accountant = availableSpecialist(w, gang, 'accountant');
    const coverCapacity = accountant
      ? legal * (0.5 + accountant.skills.intelligence * 0.22) + accountant.skills.intelligence * 400
      : legal * 0.2;

    const uncovered = Math.max(0, risky - coverCapacity);
    gang.riskyMoney = uncovered;
    if (original) {
      recordAccountantWeek(w, gang);
      originalWeeklySuspicion(w, gang);
      accountantCheck(w, gang);
      continue;
    }

    const delta = uncovered / 900 + gang.uncoveredTax / 1400;
    if (delta > 0) gang.suspicion = Math.min(100, gang.suspicion + delta);
    // Interest cools slowly, but only in a week with nothing to find: money
    // that cannot be explained keeps the Bureau's attention, however little.
    else gang.suspicion = Math.max(0, gang.suspicion - 1.6);

    // Warehouses full of contraband are a standing invitation.
    for (const b of allBuildings(w)) {
      if (b.ownerGangId !== gang.id || b.typeId !== 'warehouse') continue;
      const total = b.stock.liquor + b.stock.stolen + b.stock.counterfeit * 20;
      if (total > 120) gang.suspicion = Math.min(100, gang.suspicion + 0.8);
    }
  }

  if (original) {
    // Each man's own +0x7C loses a tenth in his weekly turn (0x460300), then
    // the FBI's member pass (0x4F6088) puts warrants out.
    decayCrimeSuspicion(w);
    memberWarrants(w, rng);
    // 0x4F5AE0 ends its weekly turn with the payroll crackdown (0x4F61BC) and
    // the laundering and fencing raids (0x4F6220, called right after it).
    payrollCrackdown(w, rng);
    launderingFencingRaids(w, rng);
  }
  // Discovery schedules next week's journey; settlement itself cannot raid.
  normalizeFbiInvestigations(w);
}

/**
 * The suspicion a racket's FBI crime event carries. The premises' weekly turn
 * seeds the premises byte +0x44 (0x6EC950) and, the first time, opens the
 * racket's crime event with that byte as its suspicion (0x4F7750, one event
 * per racket, in state 1): the racket row's suspicion (20) × 4 on its own,
 * or behind a front × 4, × 2 or × 1 by Business Suspicion.xtx's grade 0, 1
 * or 2 for that front and racket. Remake mapping: the grade from `cover`
 * (0.95 ideal front 2, 0.6 partial 1, otherwise 0).
 */
export function racketEventSuspicion(w: WorldState, b: Building): number {
  if (b.frontId == null || !w.buildings[b.frontId]) return RACKET_SUSPICION * 4;
  return RACKET_SUSPICION * (b.cover >= .95 ? 1 : b.cover >= .6 ? 2 : 4);
}

/**
 * 0x4F5AE0, each FBI weekly turn, for a crime event in state 1. A racket
 * (rows 0x2C and up, at a business with a gangster, class 0x1C, as its
 * manager) is investigated (0x4F6BC0: one random agent of the pool, order
 * 0x21) when zeal + the event's suspicion + the week's rise of the manager's
 * gang (FBI+0x190, `fbiWeekRise`) > 180 + the manager's Business (+0xAF) +
 * Organisation (+0xB5), each 0..63. Otherwise it waits for a later week.
 * (Ordinary crime rows below 0x2C need rand(0..31) + zeal + suspicion ≥ 256,
 * but the FBI's list holds none in state 1: its other events start in state
 * 4 or 7, and the laundering and fencing events of 0x4F6220, rows 0x3B and
 * 0x3C, take the racket branch with suspicion 0.) Here a passing racket may
 * be searched (`dispatchFbi`).
 */
export function fbiInvestigatesRacket(w: WorldState, b: Building): boolean {
  return racketRule(w, b, w.fbiZeal ?? 128);
}

/**
 * 0x580360, the FBI squad's turn, when its investigation (order 0x21,
 * 0x5844A0: to the event's cell, a wait of the order time, Crime.xtx row
 * 0x21's 333, then a visit to each entry of the event's list at +0x1C) is
 * done: the agents go back to the pool and the same rule is rolled again
 * with the lead agent's own zeal (squad +0x70, copied from the agent by
 * 0x427E60) in place of the FBI's. Solved ("Crime solved"), the event goes
 * to state 4 with its countdown (+0x28) reset to the row's investigation
 * byte (0x724750); the next FBI weekly turn raids its cell (0x4F6ED0) and
 * the crime-event step 0x723FC0 puts warrants on its perpetrators. Not
 * solved, it is dropped if its countdown has run out ("investigation out of
 * time") and otherwise falls back to state 1 for a later week (0x723FC0,
 * state 2 with its squad gone). Here solved means found: a raid next week.
 */
export function fbiSolvesRacket(w: WorldState, b: Building, agentZeal: number): boolean {
  return racketRule(w, b, agentZeal);
}

function racketRule(w: WorldState, b: Building, zeal: number): boolean {
  if (UNINVESTIGATED_RACKETS.has(b.typeId)) return false;
  const manager = b.managerId == null ? undefined : w.people[b.managerId];
  const gang = manager?.gangId == null ? undefined : w.gangs[manager.gangId];
  if (!manager || manager.role !== 'hood' || manager.status === 'dead' || !gang) return false;
  const bar = RACKET_INVESTIGATION_BAR + skillByte(manager.skills.business) + skillByte(manager.skills.organization);
  return zeal + racketEventSuspicion(w, b) + (gang.fbiWeekRise ?? 0) > bar;
}

/** An agent's own zeal (+0x70 of the FBI agent, class 0x16, constructor
 * 0x4FBC70): rolled once by its vt+0xC (0x4FBDC0) as 128 + rand % 128
 * (128..255) and saved with it. Rolled here when it is first needed. */
export function fbiAgentZeal(rng: Rng, agent: Person): number {
  return agent.fbiAgentZeal ??= 128 + rng.int(0, 127);
}

/** Original city: an investigating agent lost on the way (dead, arrested,
 * hurt). 0x723FC0 returns the event to state 1 when its squad is gone or
 * out (+0x24 & 0x38000000), and only the next FBI weekly turn sends another:
 * the racket is not looked into again this week. */
function investigatorLost(w: WorldState, agent: Person): void {
  const job = agent.fbiAssignment, b = job && w.buildings[job.buildingId];
  if (w.cityLayout?.original && job?.kind === 'search' && b) b.fbiSearchedWeek = w.week;
}

/** FBI+4, rolled once a game in 0x4F3CE0: 128 + rand % 80 (128..207). */
export function fbiZeal(w: WorldState, rng: Rng): number {
  return w.fbiZeal ??= 128 + rng.int(0, 79);
}

/** The gang's accountant as the original keeps him (gang+0x488): held while
 * he is not dead, whether free, arrested or jailed. */
function gangAccountant(w: WorldState, gang: Gang): Person | undefined {
  const p = gang.accountantId == null ? undefined : w.people[gang.accountantId];
  return p && p.role === 'accountant' && p.gangId === gang.id && p.status !== 'dead' ? p : undefined;
}

/**
 * The accountant's sixteen-week ring (+0xB0). His weekly turn 0x4BEF30 moves
 * to the next slot and clears it; the levy 0x6D11DA then writes into it what
 * he kept back (0x4BF180: levy × Intelligence / 256, only when he is free and
 * evading, which is the week's `evaded` in weeklyTaxes). Original city.
 */
export function recordAccountantWeek(w: WorldState, gang: Gang): void {
  const p = gangAccountant(w, gang);
  if (!p) return;
  const kept = Math.max(0, Math.trunc(gang.taxEvaded[gang.taxEvaded.length - 1] ?? 0));
  p.taxEvasionWeeks = [...(p.taxEvasionWeeks ?? []), kept].slice(-16);
}

/** 0x4BF160: the weeks of the last sixteen in which he kept tax back. */
export function evasionWeeks(p: Person): number {
  return (p.taxEvasionWeeks ?? []).filter(n => n > 0).length;
}

/**
 * 0x4F5AE0, for a gang in the game whose boss is not under arrest: its
 * accountant is wanted when (Intelligence >> 1) + 150 < zeal + n × 10, n his
 * weeks of evasion (0x4BF160) and 10 the `evade tax` suspicion. A dull
 * accountant can be wanted with no evasion at all once zeal passes 150.
 */
export function accountantCheck(w: WorldState, gang: Gang): boolean {
  const boss = w.people[gang.bossId];
  if (!boss || boss.status !== 'active' && boss.status !== 'kidnapped' && boss.status !== 'beaten') return false;
  const p = gangAccountant(w, gang);
  // One already in custody is not wanted again; his warrant was served.
  if (!p || p.status === 'arrested' || p.status === 'onTrial' || p.status === 'jailed') return false;
  const zeal = w.fbiZeal ?? 128;
  if ((accountantSkillByte(p.skills.intelligence) >> 1) + 150 >= zeal + evasionWeeks(p) * EVADE_TAX_SUSPICION) return false;
  if (!p.fbiWarrant) {
    p.fbiWarrant = true;
    w.weekLog.push(`The FBI wants ${p.name}, accountant to ${gang.name}, for tax evasion.`);
    if (gang.isPlayer) addMessage(w, 'police', `The FBI has a warrant out for your accountant, ${p.name}.`, p.pos, p.id);
  }
  return true;
}

/** Out of his car, and off the carriageway, as the street arrest elsewhere does. */
function outOfCar(w: WorldState, p: Person): void {
  if (!p.vehicleKey) return;
  dismount(w, p);
  if (onRoad(w, p.pos)) p.pos = pavementBeside(w, p.pos);
}

/** Arrest a gang person where he stands and charge him. */
function takeIntoCustody(w: WorldState, p: Person, gangId: ID, kind: string, buildingId: ID | null, agent?: Person): void {
  outOfCar(w, p);
  p.status = 'arrested'; p.buildingId = null; p.inVehicle = false;
  p.orderId = null; p.streetOrder = null; clearDestination(p);
  w.crimes.push({id:w.sequences.crime++,week:w.week,gangId,perpetratorId:p.id,
    kind,buildingId,victimId:null,witnesses:agent?[agent.id]:[],arrestRisk:.75,reported:true,charge:true});
}

/**
 * Remake mapping. In the original a wanted accountant is arrested by the
 * squad that meets him (0x49A530, from the police and FBI squads' sweeps;
 * which squad goes after a wanted accountant is not traced), and the arrest
 * is turned into an `evade tax` crime event with suspicion n × 10 and the
 * accountant as perpetrator (0x4F47C3 for the FBI, 0x56DD41 for the police).
 * Here the FBI comes for him at its next weekly turn, if it has an agent on
 * duty: he faces the arrest contest, and an arrest charges him with tax
 * evasion and spends the warrant. Resisting or breaking away leaves it
 * standing for the week after. A member wanted by the member pass
 * (`memberWarrants`) is served the same way; an arrest takes his team with
 * him (0x49A530) and charges them with his latest recorded crime.
 */
export function serveAccountantWarrants(w: WorldState, rng: Rng): void {
  const agent = w.fbiIds.map(id => w.people[id]).find(p => p?.status === 'active');
  if (!agent) return;
  const wanted = peopleList(w).filter(p => p.fbiWarrant && WARRANT_ROLES.has(p.role) && p.status === 'active' && p.gangId != null && w.gangs[p.gangId])
    .sort((a, b) => a.id - b.id);
  for (const p of wanted) {
    if (p.status !== 'active') continue;   // taken in with a wanted team-mate
    const gang = w.gangs[p.gangId!];
    const accountant = p.role === 'accountant';
    const who = accountant ? 'accountant' : 'man';
    // One agent comes for him: a squad of one.
    const team = teamMates(w, p), mates = accountant ? [] : team;
    const outcome = arrestContest(rng, p, arrestEdge(1, team.length));
    if (outcome === 'arrested') {
      // A member wanted for his own suspicion (0x4F6088) answers for the
      // latest crime on his record; his team goes with him (0x49A530).
      const kind = accountant ? 'taxEvasion' : latestCrimeKind(w, p);
      for (const q of [p, ...mates]) {
        takeIntoCustody(w, q, gang.id, kind, null, agent);
        delete q.fbiWarrant;
      }
      w.weekLog.push(`Federal agents arrested ${p.name}, ${who === 'man' ? 'of' : 'accountant to'} ${gang.name}, for ${describeCrime(kind)}.`);
      if (gang.isPlayer) addMessage(w, 'police', `Federal agents arrested your ${who}, ${p.name}.`, p.pos, agent.id);
    } else {
      const how = outcome === 'resists' ? 'resisted' : 'got away';
      w.weekLog.push(`Federal agents came for ${p.name}, ${who === 'man' ? 'of' : 'accountant to'} ${gang.name}; he ${how}.`);
      if (gang.isPlayer) addMessage(w, 'police', `Federal agents came for your ${who}, ${p.name}; he ${how}.`, p.pos, agent.id);
    }
  }
}

/** The kind of the last crime on a man's record (remake mapping for the
 * charge a wanted member answers to); racketeering when none is kept. */
function latestCrimeKind(w: WorldState, p: Person): string {
  for (let i = w.crimes.length - 1; i >= 0; i--) if (w.crimes[i].perpetratorId === p.id) return w.crimes[i].kind;
  return 'racketeering';
}


/**
 * 0x4F6750, at the end of the FBI's weekly turn. Turn A counts the people in
 * the city on any gang's payroll (person +0x90 bits 0..3, 0x51B2C0); above 100
 * the crackdown is due. Turn B clears the flag and, for each gang with a
 * lawyer (gang+0x48C, class 0x1B, whose list at +0xCC/+0xD8 holds the officers
 * on its payroll and pays their retainers in 0x75DA90), dismisses
 * zeal × n / 512 of its n officers at random: off the payroll (0x75D6E0), out
 * of the city (0x574530) and deleted. Here they leave the police force.
 */
export function payrollCrackdown(w: WorldState, rng: Rng): void {
  if (!w.fbiCrackdownDue) {
    const n = peopleList(w).filter(p => (p.employedBy != null || !!p.quitPayrollOf?.length) && p.status !== 'dead').length;
    if (n > CRACKDOWN_PAYROLL) w.fbiCrackdownDue = true;
    return;
  }
  delete w.fbiCrackdownDue;
  const zeal = w.fbiZeal ?? 128;
  for (const gang of Object.values(w.gangs).sort((a, b) => a.id - b.id)) {
    const lawyer = gang.lawyerId == null ? undefined : w.people[gang.lawyerId];
    if (!lawyer || lawyer.status === 'dead') continue;
    const payroll = gang.employedPoliceIds.filter(id => w.people[id]?.employedBy === gang.id);
    let k = Math.trunc(zeal * payroll.length / 512);
    const names: string[] = [];
    while (k-- > 0 && payroll.length) {
      const [id] = payroll.splice(rng.int(0, payroll.length - 1), 1);
      const o = w.people[id];
      names.push(o.name);
      dismissOfficer(w, gang, o);
    }
    if (!names.length) continue;
    w.weekLog.push(`FBI crackdown: officers dismissed. ${gang.name} lost ${names.join(', ')} from its payroll.`);
    if (gang.isPlayer) addMessage(w, 'police', `FBI crackdown: officers dismissed. You lost ${names.length} officer${names.length === 1 ? '' : 's'} from your payroll.`);
  }
}

function dismissOfficer(w: WorldState, gang: Gang, o: Person): void {
  o.employedBy = null; o.weeklyRetainer = 0; delete o.retainerShort;
  gang.employedPoliceIds = gang.employedPoliceIds.filter(id => id !== o.id);
  w.policeIds = w.policeIds.filter(id => id !== o.id);
  delete o.emergencyResponse;
  if (o.role === 'police') o.role = 'citizen';
  if (!o.streetOrder && o.orderId == null) clearDestination(o);
}

/** The room a premises has for contraband, by the business type's Liquor,
 * Stolen and C.feit flags (Economics.xtx, rows at city+0x9E0, +0x4E..+0x50):
 * liquor (+0x64) and stolen goods (+0x66) share one store, counterfeit
 * money (+0x68) has its own. Remake mapping: a warehouse's 300 cases and 15
 * counterfeit cases, a speakeasy's 120 cases of liquor, a fence's 60 stolen
 * cases and a counterfeit outlet's 6 (`goodsRoom`'s buffers). */
function storeRoom(b: Building): { liquor: boolean; stolen: boolean; counterfeit: number; goods: number } {
  const warehouse = b.typeId === 'warehouse', stores = BUILDING_BY_ID[b.typeId]?.stores ?? [];
  const liquor = warehouse || b.typeId === 'speakeasy';
  const stolen = warehouse || stores.includes('stolen');
  const counterfeit = warehouse ? WAREHOUSE_CASH_CAP : stores.includes('counterfeit') ? 6 : 0;
  const goods = warehouse ? WAREHOUSE_GOODS_CAP : liquor ? 120 : stolen ? 60 : 0;
  return { liquor, stolen, counterfeit, goods };
}

/**
 * 0x4F6220's draw for one premises: the goods held (0x628580 + 0x628840 +
 * 0x628B10, each only where the business type may hold it) against the room
 * left (0x628650 + 0x628910 + 0x628BD0; the shared store is counted once for
 * each of the two kinds the type takes). It passes when rand % 10 +
 * trunc(held × 10 / (held + room)) > 10, so a full store is picked nine weeks
 * in ten and one under a fifth full never.
 */
export function contrabandDraw(b: Building, roll: number): boolean {
  const room = storeRoom(b);
  const liquor = room.liquor ? b.stock.liquor : 0, stolen = room.stolen ? b.stock.stolen : 0;
  const counterfeit = room.counterfeit ? b.stock.counterfeit : 0;
  const held = liquor + stolen + counterfeit;
  const free = (room.liquor ? Math.max(0, room.goods - liquor - stolen) : 0) +
    (room.stolen ? Math.max(0, room.goods - stolen - liquor) : 0) +
    (room.counterfeit ? Math.max(0, room.counterfeit - counterfeit) : 0);
  return roll + Math.trunc(held * 10 / (held + free || 1)) > 10;
}

/**
 * 0x4F6220, at the end of the FBI's weekly turn. For each gang in the game
 * (city+0x20C + i), each of its premises (gang+0x1DC) managed by a gangster
 * (class 0x1C) whose Business + Stealth + Organisation (+0xAF, +0xB0, +0xB5,
 * 0..63 each) + 63 is below the FBI's zeal is weighed by `contrabandDraw`.
 * One that passes and holds counterfeit money (0x628A90 > 0) goes on the
 * laundering list, and one that holds stolen goods (0x6287C0 > 0) on the
 * fencing list; liquor only fills the store. Each list, sorted by its
 * managers' sums (0x4FA550 with 0x4F66E0), gives every premises a crime
 * event (0x722DF0: row 0x3B `laundering` or 0x3C `fencing`, suspicion 0,
 * investigation 4, the manager as perpetrator, at its cell, an FBI event in
 * state 1) and a raid at once (0x4F6ED0): up to eight agents, warrants on
 * the gang's men in the cell, arrests by the sweep (0x585CB0), and the
 * operation closed ("F.B.I. raid closes down illegal operation", premises
 * flag 0x80, from the raid order 0x584940). Nothing checks for an earlier
 * event, so a premises can be raided week after week. Remake mapping: the
 * premises is found and raided the next week (`raidSite`).
 */
export function launderingFencingRaids(w: WorldState, rng: Rng): Building[] {
  const zeal = w.fbiZeal ?? 128, raided: Building[] = [];
  for (const gang of Object.values(w.gangs).sort((a, c) => a.id - c.id)) {
    if (gang.eliminated) continue;
    for (const b of allBuildings(w).filter(x => x.ownerGangId === gang.id && operation(w, x)).sort((a, c) => a.id - c.id)) {
      const m = b.managerId == null ? undefined : w.people[b.managerId];
      if (!m || m.role !== 'hood' || m.status === 'dead' || m.gangId !== gang.id) continue;
      if (skillByte(m.skills.business) + skillByte(m.skills.stealth) + skillByte(m.skills.organization) + RAID_MANAGER_BAR >= zeal) continue;
      if (!contrabandDraw(b, rng.int(0, 9))) continue;
      const room = storeRoom(b);
      const laundering = room.counterfeit > 0 && b.stock.counterfeit > 0, fencing = room.stolen && b.stock.stolen > 0;
      if (!laundering && !fencing) continue;
      raided.push(b);
      if (b.fbiRaidWeek != null) continue;   // already on next week's list
      b.discovered = true; b.fbiDiscoveredWeek = w.week; b.fbiRaidWeek = w.week + 1;
      const what = laundering && fencing ? 'counterfeit money and stolen goods' : laundering ? 'counterfeit money' : 'stolen goods';
      w.weekLog.push(`The FBI is to raid a ${buildingName(w, b.id)} of ${gang.name} for ${what}.`);
    }
  }
  return raided;
}

/**
 * A man's own FBI suspicion (+0x7C, a 16-bit word every person has; the
 * boss's is the gang's total, `Gang.fbiTotal`). Filing a crime (0x4DB700,
 * person vt+0x144, at 0x4DB88A) whose Crime.xtx suspicion is above 59
 * (kidnap and smash-up 60, bomb and torch 80, ambush and kill 100) adds that
 * suspicion, halved when the victim is a policeman (class 0x11/0x12) and a
 * tenth when he is a gangster or lieutenant (0x1C, 0x1D, 0x1F), to the man
 * and to everyone in his team (+0x114). The remake files its crimes as it
 * goes; this adds the week's, once, at the FBI's weekly turn. (The
 * crime-event step 0x723FC0 also adds half an event's suspicion to its
 * perpetrators when the event is dropped; the remake's police crimes do not
 * run those events.)
 */
export function heavyCrimeSuspicion(w: WorldState): void {
  for (const c of w.crimes) {
    // A charge repeats a crime already counted when it was committed.
    if (c.week !== w.week || c.charge) continue;
    const s = CRIME_ROW_SUSPICION[c.kind] ?? 0;
    if (s <= HEAVY_CRIME_SUSPICION) continue;
    const p = w.people[c.perpetratorId], gang = p?.gangId == null ? undefined : w.gangs[p.gangId];
    if (!p || !gang) continue;
    const victim = c.victimId == null ? undefined : w.people[c.victimId];
    // 0x4DB700 files nothing against himself or one of his own team.
    if (victim && (victim.id === p.id || p.teamId != null && victim.teamId === p.teamId && victim.gangId === p.gangId)) continue;
    // fileCrime step 1: an owner never files a smash-up against himself.
    if (victim?.role === 'owner' && c.kind === 'smashUp') continue;
    const rise = victim && (victim.role === 'police' || victim.role === 'policeChief') ? s >> 1
      : victim && (victim.role === 'hood' || victim.role === 'lieutenant') ? Math.trunc(s / 10) : s;
    for (const q of [p, ...crew(w, p)]) {
      if (q.id === gang.bossId) gang.fbiTotal = Math.min(255, (gang.fbiTotal ?? 0) + rise);
      else q.crimeSuspicion = Math.min(0x7FFF, (q.crimeSuspicion ?? 0) + rise);
    }
  }
}

/** The rest of a man's team, free or not (the list at +0x114). */
function crew(w: WorldState, p: Person): Person[] {
  if (p.teamId == null) return [];
  return peopleList(w).filter(q => q.id !== p.id && q.teamId === p.teamId && q.gangId === p.gangId && q.status !== 'dead')
    .sort((a, b) => a.id - b.id);
}

/** Every person's weekly turn (0x460300, person vt+0x50) takes a tenth off
 * his +0x7C, floored at 0. (The boss's total has its own, 0x6D04C2.) */
export function decayCrimeSuspicion(w: WorldState): void {
  for (const p of peopleList(w)) {
    if (!p.crimeSuspicion) continue;
    const s = p.crimeSuspicion - Math.trunc(p.crimeSuspicion / 10);
    if (s > 0) p.crimeSuspicion = s; else delete p.crimeSuspicion;
  }
}

/**
 * 0x4F5AE0's member pass (0x4F6088–0x4F61B4): starting from a random gang,
 * every person on each gang's roster (0x6D93B0) whose state (+0xA0 & 0x1F)
 * is 10 or less is wanted (+0x84 |= 0x40) when 200 + rand(0..63) < his
 * +0x7C. (One above state 10 gets flag 0x20 instead, not followed.) Here the
 * free members of a gang still in the game; the boss is left to his case
 * (`fbiTotal`). A wanted man is served by `serveAccountantWarrants` at the
 * next weekly turn.
 */
export function memberWarrants(w: WorldState, rng: Rng): Person[] {
  const gangs = Object.values(w.gangs).sort((a, c) => a.id - c.id);
  if (!gangs.length) return [];
  const start = rng.int(0, 3), wanted: Person[] = [];
  for (let k = 0; k < gangs.length; k++) {
    const gang = gangs[(start + k) % gangs.length];
    if (gang.eliminated) continue;
    const men = peopleList(w).filter(p => p.gangId === gang.id && p.id !== gang.bossId && WARRANT_ROLES.has(p.role) &&
      (p.status === 'active' || p.status === 'beaten' || p.status === 'kidnapped')).sort((a, c) => a.id - c.id);
    for (const p of men) {
      const s = p.crimeSuspicion ?? 0;
      if (s <= MEMBER_WARRANT_BAR || MEMBER_WARRANT_BAR + rng.int(0, 63) >= s) continue;
      wanted.push(p);
      if (p.fbiWarrant) continue;
      p.fbiWarrant = true;
      w.weekLog.push(`The FBI wants ${p.name} of ${gang.name}.`);
      if (gang.isPlayer) addMessage(w, 'police', `The FBI has a warrant out for ${p.name}.`, p.pos, p.id);
    }
  }
  return wanted;
}

/** 0x4F5860: the Opponents setting weighs a gang's premises takings. */
function opponentsFactor(w: WorldState, gang: Gang): number {
  const o = w.options.opponents;
  if (gang.isPlayer) return o === 'passive' ? 16 : o === 'aggressive' ? 8 : 10;
  return o === 'aggressive' ? 14 : 10;
}

/**
 * 0x4F5860: the week's rise in a boss's FBI suspicion, 0..255. Office takings
 * (+0x4F4: protection and the other money handed in) are weighed against
 * premises takings (+0x4F0: legal and illegal business); the accountant's
 * intelligence raises the tolerated ratio, by two thirds for the player.
 */
export function originalSuspicionRise(w: WorldState, gang: Gang): number {
  const income = currentFinances(w, gang).income;
  const premises = Math.trunc(income.legal + income.illegal), office = Math.trunc(income.protection + income.other);
  if (office < 0) return 0;
  const base = Math.max(100, Math.trunc(premises * opponentsFactor(w, gang) / 10));
  const accountant = availableSpecialist(w, gang, 'accountant');
  let int = accountant ? accountantSkillByte(accountant.skills.intelligence) : 0;
  if (gang.isPlayer) int = Math.trunc(int * 2 / 3);
  const rise = Math.trunc((Math.trunc(office / base) - (0.12 * (int || 1) + 9.88)) * 2);
  return Math.max(0, Math.min(255, rise));
}

/**
 * Original city. The gang's weekly turn first takes a tenth off the boss's
 * total (0x6D04C2), then the FBI adds the week's rise (0x4F5860). Above 200
 * it opens an extortion case (Crime.xtx row 0x12), and its next weekly turn
 * (0x4F5AE0) raids the boss: here, agents reach the office the next week.
 */
function originalWeeklySuspicion(w: WorldState, gang: Gang): void {
  let total = gang.fbiTotal ?? 0;
  total -= Math.trunc(total / 10);
  const rise = originalSuspicionRise(w, gang);
  // FBI+0x190 + gang×4 keeps the week's rise for the racket investigations.
  gang.fbiWeekRise = rise;
  total = Math.min(255, total + rise);
  gang.fbiTotal = total;
  gang.suspicion = total * 100 / 255;
  if (total <= FBI_CASE_THRESHOLD || gang.fbiRaidWeek != null || !headquarters(w, gang.id)) return;
  gang.fbiRaidWeek = w.week + 1;
  w.weekLog.push(`The FBI opened a case against ${gang.name}.`);
}

export type ArrestOutcome = 'arrested' | 'resists' | 'breaksAway';

/** The original's arrest of a person by an officer (0x49A530, the person
 * vtable's slot +0x104 at 0x77E94C): edge + rand(0..31) + Intelligence
 * (0..255) − 16; under 20 he resists, over 128 he is arrested, otherwise he
 * breaks away. `edge` is `arrestEdge`. */
export function arrestContest(rng: Rng, p: Person, edge = 0): ArrestOutcome {
  const score = edge + rng.int(0,31) + accountantSkillByte(p.skills.intelligence) - 16;
  return score < 20 ? 'resists' : score > 128 ? 'arrested' : 'breaksAway';
}

/**
 * 0x49A530's edge: numbers, not rank. The officer's side is the count of a
 * list: a police squad (class 0x12, list +0x98, count +0xA4, its policemen;
 * constructor 0x742380, loader 0x748140), an FBI squad (class 0x14, list
 * +0x94, count +0xA0: the agents 0x4F6ED0 puts in it) or a gangster or
 * lieutenant (0x1C/0x1F: +0x120, his own team). The person's side is his
 * team count (+0x120, the count of the team list at +0x114 that an arrest
 * takes with him; 0x6D8B80 sums the same field as a gang's head count) + 1.
 * +64 when squad − 1 > side, −64 when side > squad + 3, else 0.
 */
export function arrestEdge(squad: number, team: number): number {
  const side = team + 1;
  return squad - 1 > side ? 64 : side > squad + 3 ? -64 : 0;
}

/** The rest of a man's team, whom an arrest takes with him (0x49A530). */
function teamMates(w: WorldState, p: Person): Person[] {
  if (p.teamId == null) return [];
  return peopleList(w).filter(q => q.id !== p.id && q.teamId === p.teamId && q.gangId === p.gangId && q.status === 'active')
    .sort((a, b) => a.id - b.id);
}

/**
 * Original city: an officer (police or FBI) on the street meets a man of a
 * gang he would take in. 0x49A530 is called by the police squad's cell sweep
 * (0x748C20) and its message handler, by the FBI squad's raid sweep
 * (0x585CB0, from the raid order 0x584940) and its "arrest him" slot
 * 0x5867D0 (squad vtable 0x77FE6C, reached from the message handler
 * 0x58341F). So ordinary police arrests use the same contest. Remake
 * mapping: the squad is the officers of his service within 26 m of the man,
 * the one making the arrest included. Arrested: he and his team are taken in.
 * Resists: he turns on the officer (vt+0x14C). Breaks away: goal 0xD to his
 * gang's office (gang +0x2D6), i.e. he runs for home.
 */
export function streetArrest(w: WorldState, rng: Rng, officer: Person, p: Person): ArrestOutcome {
  // Stopped and taken out of his car whatever comes of it: he resists or runs
  // on foot, and the best driver left takes the wheel.
  outOfCar(w, p);
  const squad = peopleList(w).filter(o => o.role === officer.role && o.status === 'active' && dist(o.pos, p.pos) <= 26).length;
  const mates = teamMates(w, p);
  const outcome = arrestContest(rng, p, arrestEdge(Math.max(1, squad), mates.length));
  const gang = p.gangId == null ? undefined : w.gangs[p.gangId];
  const by = officer.role === 'fbi' ? 'the FBI' : 'the police';
  if (outcome === 'arrested') {
    for (const q of [p, ...mates]) {
      outOfCar(w, q);
      q.status = 'arrested'; q.buildingId = null; q.inVehicle = false;
      q.orderId = null; q.streetOrder = null; clearDestination(q);
      if (gang?.isPlayer) addMessage(w, 'police', `${q.name} has been arrested by ${by}.`, q.pos, q.id);
    }
  } else if (outcome === 'resists') {
    p.streetOrder = { type: 'assault', targetPersonId: officer.id, pos: null };
    if (gang?.isPlayer) addMessage(w, 'police', `${p.name} resisted arrest by ${by}.`, p.pos, p.id);
  } else {
    p.orderId = null; p.streetOrder = null;
    const office = gang ? headquarters(w, gang.id) : undefined;
    if (office) setDestination(w, p, buildingDoor(w, office)); else clearDestination(p);
    if (gang?.isPlayer) addMessage(w, 'police', `${p.name} broke away from ${by} and ran for home.`, p.pos, p.id);
  }
  return outcome;
}

/** Original city: the squad sent on a case (0x4F6ED0) puts a warrant on
 * every gang member standing in the boss's cell; here it confronts whoever of
 * the gang is in the office or at its door. The case is spent either way.
 * Each person there faces the arrest contest (the raid sweep 0x585CB0 calls
 * 0x49A530 for each gangster in the cell), with the squad's head count
 * against his team's; one arrest takes his whole team with him, wherever
 * they are, as in the original. */
export function raidHeadquarters(w: WorldState, rng: Rng, b: Building, agent?: Person): void {
  const gang = b.ownerGangId == null ? undefined : w.gangs[b.ownerGangId];
  if (!gang || gang.fbiRaidWeek == null) return;
  delete gang.fbiRaidWeek;
  const door = buildingDoor(w, b);
  const found = peopleList(w).filter(p => p.gangId === gang.id && p.status === 'active' &&
    (p.buildingId === b.id || (!p.inVehicle && dist(p.pos, door) <= 12)))
    .sort((a, c) => a.id - c.id);
  const taken: Person[] = [];
  const arrest = (p: Person) => {
    if (p.status !== 'active') return;
    // A wanted accountant taken in is charged with tax evasion (0x4F47C3); a
    // man wanted by the member pass, with the latest crime on his record.
    const kind = !p.fbiWarrant ? 'extort' : p.role === 'accountant' ? 'taxEvasion' : latestCrimeKind(w, p);
    takeIntoCustody(w, p, gang.id, kind, b.id, agent);
    delete p.fbiWarrant;
    taken.push(p);
  };
  let resisted = 0, escaped = 0;
  // The squad's count (+0xA0): the agents sent on this raid, still on it.
  const squad = Math.max(1, w.fbiIds.filter(id => {
    const a = w.people[id], job = a?.fbiAssignment;
    return a?.status === 'active' && job?.kind === 'arrest' && job.buildingId === b.id;
  }).length);
  for (const p of found) {
    if (p.status !== 'active') continue;
    const outcome = arrestContest(rng, p, arrestEdge(squad, teamMates(w, p).length));
    if (outcome === 'arrested') {
      arrest(p);
      if (p.teamId != null) for (const q of peopleList(w))
        if (q.teamId === p.teamId && q.gangId === gang.id) arrest(q);
    } else if (outcome === 'resists') {
      resisted++;
      if (agent && agent.status === 'active') p.streetOrder = { type: 'assault', targetPersonId: agent.id, pos: null };
    } else escaped++;
  }
  const boss = taken.some(p => p.id === gang.bossId), n = taken.length;
  const rest = [resisted ? `${resisted} resisted` : '', escaped ? `${escaped} got away` : ''].filter(Boolean).join(', ');
  w.weekLog.push(`Federal agents raided the office of ${gang.name}; ${n} arrested${boss ? ', the boss among them' : ''}${rest ? `; ${rest}` : ''}.`);
  if (gang.isPlayer) addMessage(w,'police',`Federal agents raided your office. ${n} arrest${n===1?'':'s'}${boss ? ', you among them' : ''}${rest ? `; ${rest}` : ''}.`,door,agent?.id ?? null);
  addNews(w,{section:'law',headline:'FEDERAL AGENTS RAID GANG HEADQUARTERS',
    body:`Agents raided the offices of ${gang.name}. ${n} arrest${n===1?' was':'s were'} made.`,gangId:gang.id});
}

/** Shut a site down, seize the stock, arrest whoever is inside. */
export function raidSite(w: WorldState, rng: Rng, b: Building, agent?: Person): void {
  if (!operation(w,b)) return;
  const gang = b.ownerGangId != null ? w.gangs[b.ownerGangId] : null;
  let arrests = 0;
  const arrest = (p: Person) => {
    p.status = 'arrested'; p.buildingId = null; p.inVehicle = false;
    p.orderId = null; p.streetOrder = null; clearDestination(p);
    p.wanted = Math.min(100,p.wanted+25); arrests++;
    if (gang) w.crimes.push({id:w.sequences.crime++,week:w.week,gangId:gang.id,perpetratorId:p.id,
      kind:'illegalBusiness',buildingId:b.id,victimId:null,witnesses:agent?[agent.id]:[],arrestRisk:.75,reported:true});
  };
  if (b.managerId != null) {
    const mgr = w.people[b.managerId];
    if (mgr && mgr.status === 'active' && mgr.gangId === b.ownerGangId && mgr.buildingId === b.id) {
      mgr.pos = {...buildingDoor(w,b)}; arrest(mgr);
      // He still works for the gang; without this he vanishes from the payroll
      // and from every roster, and can never be given another job.
      if (gang && !gang.poolIds.includes(mgr.id)) gang.poolIds.push(mgr.id);
    }
    if (mgr && gang && mgr.gangId === gang.id && mgr.status !== 'dead' && !gang.poolIds.includes(mgr.id) && mgr.teamId == null) gang.poolIds.push(mgr.id);
    if (mgr?.buildingId === b.id) mgr.buildingId = null;
    b.managerId = null;
  }
  for (const guardId of b.guardIds) {
    const g = w.people[guardId];
    if (g && g.status === 'active' && g.gangId === b.ownerGangId && dist(g.pos,buildingDoor(w,b)) <= 12 && rng.chance(0.5)) arrest(g);
  }
  stopBusinessGuards(w,b,'The business was closed by the FBI.');
  b.guardIds = [];
  b.stock = { liquor: 0, stolen: 0, counterfeit: 0 };
  if (gang) {
    gang.evidence = Math.min(100, gang.evidence + 12);
    gang.suspicion = Math.min(100, gang.suspicion + 8);
    w.weekLog.push(`Federal agents raided a ${buildingName(w, b.id)} belonging to ${gang.name}.`);
  }
  b.fbiClosedWeek = w.week; b.discovered = true; b.fbiDiscoveredWeek ??= w.week;
  delete b.fbiRaidWeek; delete b.resumeTradingWeek;
  if (b.state !== 'damaged') b.state = 'ceased';
  const hidden = b.hidesId == null ? undefined : w.buildings[b.hidesId];
  if (hidden) {
    if (hidden.state === 'trading') hidden.state = 'ceased';
    delete hidden.resumeTradingWeek;
  }
  // Seizing a business is not a bombing: do not create rubble or lower land value.
  // Intact closure is an explicit remake interpretation of the manual's shutdown.
  if (gang?.isPlayer) addMessage(w,'police',`The FBI closed ${buildingName(w,b.id)} and seized its stock. ${arrests} arrest${arrests===1?'':'s'}.`,buildingDoor(w,b),agent?.id ?? null);
  addNews(w,{section:'law',headline:'FEDERAL AGENTS RAID CITY PREMISES',
    body:`Agents closed a ${buildingName(w,b.id)} and seized its stock. ${arrests} arrest${arrests===1?' was':'s were'} made.`,gangId:gang?.id ?? null});
}
