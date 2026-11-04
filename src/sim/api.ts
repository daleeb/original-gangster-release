import { INCIDENT_HOSTILITY, provoke } from './aiStance';
import { huntStops, whereaboutsUnknown } from './execution';
export { huntStops, whereaboutsUnknown };
import { LEFT_GANG, NO_ORIGINAL_CHANNEL, opinionSet } from './attitudes';
import { originalStartingWage } from './originalWages';
import { cityBlockAt } from './cityLayout';
import { orderStaffing } from './orderStaffing';
import { observeTargetRace } from './targetRace';
import {
  MAX_TEAMS,
  MAX_TEAM_SIZE,
  MINUTES_PER_WEEK,
  ORDERS,
  VEHICLES,
  WEAPONS,
} from './constants';
import { BUILDING_BY_ID } from './data/buildings';
import { hoodPayDemand, newId } from './citygen';
import { payCash, receiveAssetCash } from './finances';
import { rememberAccountantTax } from './systems/taxes';
import { businessFrontReady, resetBusinessInvestigation } from './businessState';
import { recoverExportGoods } from './exportGoods';
import { purchasablePremisesType } from './premises';
import { donationAmount, donationTarget } from './charity';
import { alight, releaseTransportOrder, removeFleetVehicle, sendHome } from './transport';
import { availableSpecialist, reclaimStaffVehicle } from './specialists';
import { cancelSpecialistVisits, queueSpecialistJob } from './specialistJobs';
export { bribePrice } from './officials';
export { cancelSpecialistJob } from './specialistJobs';
import { addMessage, reportBusinessMove } from './events';
import { prepareStreetPursuit, streetOrderRange } from './streetPursuit';
import { allocateWeapons } from './weapons';
import {
  buildingValue,
  disbandTeam,
  estimateMinutes,
  expandTargets,
  forgetWhatWasThere,
  isValidAreaTarget,
  killPerson,
  nearestOffice,
  promoteToLieutenant,
  releaseGuardPost,
  stopBusinessGuards,
} from './execution';
import { defect } from './systems/economy';
import { campaignWeeklyCost, officeEntryCheck, enterElection, withdrawFromElection } from './systems/politics';
import type { Rng } from './rng';
import type {
  Building,
  DiplomacyLevel,
  Gang,
  ID,
  Order,
  OrderOptions,
  OrderType,
  Person,
  Team,
  Vec2,
  VehicleId,
  WeaponId,
  WorldState,
} from './types';
import { CELL, GO_STRAIGHT_ASSETS } from './constants';

import { clearDestination, setDestination } from './movement';
import { canonicalAreaBlocks, lieutenantAreaChoices } from './lieutenantAreas';
import { CENTRE_LOT, allBuildings, buildingDoor, dist, gangAssets, ownedBuildings, teamsOf, territoryBlocks } from './world';
import { peopleList } from './entityLists';
import { quitGangPayroll } from './payrollMark';

export type ApiResult =
  | { ok: true; message?: string }
  | {
      ok: false;
      error: string;
      /** For an order that does not fit the week: the part of it that would. */
      suggestion?: { buildingIds: ID[]; count: number; total: number };
    };

const ok = (message?: string): ApiResult => ({ ok: true, message });
const fail = (error: string): ApiResult => ({ ok: false, error });

export function defaultOptions(overrides: Partial<OrderOptions> = {}): OrderOptions {
  return {
    repeat: false,
    isPublic: false,
    priority: false,
    manpower: 1,
    wait: false,
    preferredHoodId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- orders

export interface IssueOrderInput {
  teamId: ID;
  type: OrderType;
  buildingIds?: ID[];
  blockIds?: ID[];
  personId?: ID | null;
  pos?: Vec2 | null;
  opts?: Partial<OrderOptions>;
}

function validPoint(w: WorldState, pos: Vec2 | null | undefined): pos is Vec2 {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 0 || pos.y < 0) return false;
  const gx = Math.floor(pos.x / CELL);
  const gy = Math.floor(pos.y / CELL);
  return w.blocks.some((block) => block.gx === gx && block.gy === gy);
}

export function validBuildingTarget(w: WorldState, gangId: ID, type: OrderType, b: Building, opts: OrderOptions): boolean {
  if (b.state === 'destroyed') return false;
  switch (type) {
    case 'buyPremises':
      return b.ownerGangId == null && purchasablePremisesType(b);
    case 'setUpBusiness': {
      if (b.discovered || b.fbiClosedWeek != null) return false;
      const business = opts.businessTypeId ? BUILDING_BY_ID[opts.businessTypeId] : null;
      if (b.ownerGangId !== gangId || !business || business.cls === 'municipal' || business.cls === 'empty') return false;
      if ((business.cls === 'illegal') !== (w.lots[b.lotId]?.index === CENTRE_LOT)) return false;
      if (business.cls !== 'illegal') return true;
      const front = opts.frontBuildingId != null ? w.buildings[opts.frontBuildingId] : null;
      return !!front && front.ownerGangId === gangId && front.blockId === b.blockId && front.state === 'trading' &&
        ['commercial', 'industrial', 'tenement', 'charity'].includes(front.cls) && (front.hidesId == null || front.hidesId === b.id);
    }
    case 'export': return b.ownerGangId === gangId && b.typeId === 'warehouse';
    case 'runBusiness': return b.ownerGangId === gangId && b.cls !== 'empty' && b.fbiClosedWeek == null;
    case 'guardBusiness': return b.cls !== 'empty' && (b.ownerGangId === gangId || b.protection?.gangId === gangId);
    case 'donate': return donationTarget(b);
    default: return b.cls !== 'empty';
  }
}

/** Pure draft shared by the job card and accepted orders. No IDs or time are consumed. */
export function previewOrder(w: WorldState, gangId: ID, input: IssueOrderInput): Order | null {
  const gang = w.gangs[gangId], team = w.teams[input.teamId];
  if (!gang || !team || team.gangId !== gangId || !ORDERS[input.type]) return null;
  const def = ORDERS[input.type];
  const opts = defaultOptions(input.opts);
  const blockIds = [...new Set((input.blockIds ?? []).map(id => w.blocks[id]?.layout?.mergedInto ?? id))];
  const buildingIds = [...new Set(input.buildingIds ?? [])];
  const targetBuildingIds = expandTargets(w, gangId, input.type, blockIds, buildingIds);
  const charity = w.buildings[targetBuildingIds[0]];
  if (input.type === 'donate' && opts.amount == null && charity && donationTarget(charity)) opts.amount = donationAmount(w, charity);
  const order: Order = {
    id: -1, // Allocate only after all validation succeeds.
    gangId,
    teamId: team.id,
    type: input.type,
    targetBuildingIds,
    targetBlockIds: blockIds,
    targetPersonId: input.personId ?? null,
    targetPos: input.pos ? { ...input.pos } : null,
    opts,
    assignedIds: [],
    state: 'queued',
    cursor: 0,
    workLeft: 0,
    estimatedMinutes: 0,
    results: [],
    failReason: null,
    isStreetOrder: false,
    completedTargets: 0,
  };
  // A target nobody of yours has ever placed has to be found first: the crew
  // asks around at the pool halls and gyms nearest the office.
  if (def.target === 'person' && order.targetPersonId != null) {
    const target = w.people[order.targetPersonId];
    if (target && whereaboutsUnknown(gang, target)) {
      order.hunting = true;
      order.huntStopIds = huntStops(w, gangId);
    }
  }
  order.estimatedMinutes = estimateMinutes(w, team, order);
  return order;
}

export function issueOrder(w: WorldState, gangId: ID, input: IssueOrderInput): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[input.teamId];
  if (!gang || !team || team.gangId !== gangId) return fail('No such crew.');
  const lt = w.people[team.lieutenantId];
  // A lieutenant awaiting trial or nursing a beating can still run his crew.
  // Only prison, a kidnapping or a grave stops him.
  if (!lt || lt.status === 'dead' || lt.status === 'jailed' || lt.status === 'kidnapped') {
    return fail('That lieutenant is not available. Promote somebody to take the crew.');
  }

  const def = ORDERS[input.type];
  if (!def) return fail('No such order.');
  if(input.type==='export'&&!team.vehicles.truck)return fail('Allocate a truck to this crew before ordering Export.');
  if (input.type === 'bomb' && !(team.weapons.explosives ?? 0) && !(gang.weapons.explosives ?? 0)) return fail('Buy explosives before ordering a Bomb.');
  const opts = defaultOptions(input.opts);
  if (!Number.isInteger(opts.manpower) || opts.manpower < 1) return fail('Choose a positive whole number of people.');
  if (opts.manpower > team.memberIds.length + 1) return fail(`${lt.name} has only ${team.memberIds.length + 1} people.`);
  if (opts.manpower > def.maxManpower) return fail(`${def.name} takes at most ${def.maxManpower} ${def.maxManpower === 1 ? 'person' : 'people'}.`);
  if (opts.preferredHoodId != null && opts.preferredHoodId !== team.lieutenantId && !team.memberIds.includes(opts.preferredHoodId)) {
    return fail('That person is not in this crew.');
  }
  const staffing = orderStaffing(w, team, { type: input.type, opts }, true);
  if (staffing.reason) return fail(staffing.reason);
  if (opts.amount != null && (!Number.isFinite(opts.amount) || opts.amount < 0)) return fail('Choose a valid amount.');
  if (input.type === 'donate' && opts.amount === 0) return fail('A donation must be greater than zero.');
  if (opts.protectionLevel != null && (!Number.isFinite(opts.protectionLevel) || opts.protectionLevel < 0 || opts.protectionLevel > 2)) return fail('Choose a protection rate between zero and double.');
  const buildingIds = [...new Set(input.buildingIds ?? [])];
  const blockIds = [...new Set((input.blockIds ?? []).map(id => w.blocks[id]?.layout?.mergedInto ?? id))];
  if (blockIds.some((id) => !w.blocks[id])) return fail('No such block.');
  if (buildingIds.some((id) => !w.buildings[id])) return fail('No such site.');
  if (def.target === 'building' && (buildingIds.length !== 1 || !validBuildingTarget(w, gangId, input.type, w.buildings[buildingIds[0]], opts))) {
    return fail('Choose a valid site for that order.');
  }
  if (def.target === 'area' && buildingIds.some((id) => !isValidAreaTarget(w, gangId, input.type, w.buildings[id]))) {
    return fail('That site is not valid for this order.');
  }
  if (def.target === 'person') {
    const target = input.personId != null ? w.people[input.personId] : null;
    if (!target || ['dead', 'jailed', 'kidnapped'].includes(target.status)) return fail('Choose an available target.');
    if (input.type === 'kidnap' && (target.gangId == null || target.gangId === gangId)) return fail('Only rival gang members can be taken.');
  }
  if (def.target === 'point' && !validPoint(w, input.pos)) return fail('Choose a place inside the city.');

  const targetBuildingIds = expandTargets(
    w,
    gangId,
    input.type,
    blockIds,
    buildingIds,
  );

  // A whole-block order with no eligible sites (for example, a municipal or
  // charity block selected for extortion) is refused rather than sent out.
  if (def.target === 'area' && !targetBuildingIds.length) return fail('Nothing there for that order.');
  // Premises can only be bought within two blocks of your territory.
  if (input.type === 'buyPremises') {
    const site = w.buildings[targetBuildingIds[0]];
    if (site && !nearTerritory(w, gangId, site.blockId, BUY_REACH_BLOCKS)) {
      return fail(`Too far from your territory: you can only buy within ${BUY_REACH_BLOCKS} blocks of it.`);
    }
  }

  const order = previewOrder(w, gangId, { ...input, buildingIds, blockIds, opts })!;
  // Refuse a purchase the gang cannot pay for now, rather than send the crew
  // out for a week to fail at the door. The order still checks again on arrival.
  const price = input.type === 'buyPremises' ? buildingValue(w, w.buildings[targetBuildingIds[0]])
    : input.type === 'setUpBusiness' ? BUILDING_BY_ID[opts.businessTypeId!]?.cost ?? 0
    : input.type === 'donate' ? order.opts.amount ?? 0
    : 0;
  if (price > gang.cash) return fail(`You cannot afford it: it costs $${Math.round(price).toLocaleString('en-US')}.`);

  if (team.timeUsed + order.estimatedMinutes > MINUTES_PER_WEEK * 1.02) {
    // Undermanned for the whole area, the lieutenant offers what he can manage.
    if (def.target === 'area' && targetBuildingIds.length > 1) {
      for (let k = targetBuildingIds.length - 1; k >= 1; k--) {
        const part = { ...order, targetBuildingIds: targetBuildingIds.slice(0, k), targetBlockIds: [] };
        if (team.timeUsed + estimateMinutes(w, team, part) <= MINUTES_PER_WEEK * 1.02) {
          return {
            ok: false,
            error: `${lt.name} has not got the time for all ${targetBuildingIds.length} sites — he could manage ${k} of them.`,
            suggestion: { buildingIds: part.targetBuildingIds, count: k, total: targetBuildingIds.length },
          };
        }
      }
    }
    return fail(
      `${lt.name} has not got the time. Reduce the area, add manpower, or leave it until next week.`,
    );
  }
  order.id = newId(w);
  w.orders[order.id] = order;
  team.orderIds.push(order.id);
  team.timeUsed += order.estimatedMinutes;
  if (w.options.tutorialId === 4 && gang.isPlayer && input.type === 'explore') {
    // Capture the target's allegiance when the order is accepted: territory
    // may change before the lesson card is next shown or the save is loaded.
    const targetBlocks = new Set(targetBuildingIds.map((id) => w.buildings[id]?.blockId));
    // A foothold is enough: starting gangs may own a front without yet
    // controlling a third of the block, so the territory overlay can be empty.
    const targetsRival = allBuildings(w).some((building) => {
      const owner = building.ownerGangId ?? building.protection?.gangId;
      return targetBlocks.has(building.blockId) && building.cls !== 'empty' && building.state !== 'destroyed' &&
        owner != null && owner !== gangId && !!w.gangs[owner] && !w.gangs[owner].eliminated;
    });
    if (targetsRival) (w.tutorialActions ??= {}).rivalExplorationOrdered = true;
  }
  return ok(`${lt.name} accepted the order.`);
}

/**
 * As the original selects an area: when the crew has not got the time for
 * every site picked, the farthest from its office are left off until the rest
 * fit the week. Null when everything fits (or the order is not an area order);
 * an empty list when not even one site would. `editingMinutes` is the time
 * of a queued order being replaced, which is given back.
 */
export function fitAreaToWeek(w: WorldState, gangId: ID, input: IssueOrderInput, editingMinutes = 0):
  { buildingIds: ID[]; dropped: number; total: number } | null {
  const team = w.teams[input.teamId], def = ORDERS[input.type];
  if (!team || def?.target !== 'area') return null;
  const order = previewOrder(w, gangId, input);
  if (!order || order.targetBuildingIds.length < 2) return null;
  const free = MINUTES_PER_WEEK * 1.02 - Math.max(0, team.timeUsed - editingMinutes);
  if (order.estimatedMinutes <= free) return null;
  const office = nearestOffice(w, gangId, w.blocks[0].center);
  const from = office ? w.lots[office.lotId].center : null;
  const sites = [...order.targetBuildingIds].sort((a, b) => from
    ? dist(from, w.lots[w.buildings[a].lotId].center) - dist(from, w.lots[w.buildings[b].lotId].center) : 0);
  for (let k = sites.length - 1; k >= 1; k--) {
    const part = { ...order, targetBuildingIds: sites.slice(0, k), targetBlockIds: [] };
    if (estimateMinutes(w, team, part) <= free) return { buildingIds: part.targetBuildingIds, dropped: sites.length - k, total: sites.length };
  }
  return { buildingIds: [], dropped: sites.length, total: sites.length };
}

/** How far from your territory you may buy, in blocks. */
export const BUY_REACH_BLOCKS = 2;

/** Replace a queued job only after the revised job passes the usual validation. */
export function replaceOrder(w: WorldState, gangId: ID, orderId: ID, input: IssueOrderInput): ApiResult {
  const old = w.orders[orderId], team = w.teams[input.teamId];
  if (!old || old.gangId !== gangId || old.teamId !== input.teamId || old.state !== 'queued' || w.phase !== 'planning' || !team)
    return fail('Only a queued order can be edited.');
  const committed = team.timeUsed, index = team.orderIds.indexOf(orderId);
  team.timeUsed = Math.max(0, committed - old.estimatedMinutes);
  const result = issueOrder(w, gangId, input);
  if (!result.ok) { team.timeUsed = committed; return result; }
  const replacement = team.orderIds.pop()!;
  team.orderIds.splice(index, 1, replacement);
  delete w.orders[orderId];
  return result;
}

/** Distance between occupied grid cells, including both ends of merged blocks. */
export function nearTerritory(w: WorldState, gangId: ID, blockId: ID, reach: number): boolean {
  const source = w.blocks[blockId];
  const blk = source && w.blocks[source.layout?.mergedInto ?? source.id];
  if (!blk || !Number.isFinite(reach) || reach < 0) return false;
  return territoryBlocks(w, gangId).some(a => {
    const dx = Math.max(0, a.gx - (blk.gx + (blk.layout?.spanX ?? 1) - 1),
      blk.gx - (a.gx + (a.layout?.spanX ?? 1) - 1));
    const dy = Math.max(0, a.gy - (blk.gy + (blk.layout?.spanY ?? 1) - 1),
      blk.gy - (a.gy + (a.layout?.spanY ?? 1) - 1));
    return dx + dy <= reach;
  });
}

/** Nobody of yours has placed this person: not one of your own, not identified, and with no known workplace. */
/** Sack the manager of one of your sites; the place runs itself until you send somebody. */
export function sackManager(w: WorldState, gangId: ID, buildingId: ID): ApiResult {
  const b = w.buildings[buildingId];
  if (!b || b.ownerGangId !== gangId || b.managerId == null) return fail('Nobody of yours runs that place.');
  const mgr = w.people[b.managerId];
  b.managerId = null;
  if (mgr) {
    mgr.buildingId = null;
    return sackPerson(w, gangId, mgr.id);
  }
  return ok();
}

/** Recall the manager to base. He rejoins the pool, and the week's takings go with him. */
export function recallManager(w: WorldState, gangId: ID, buildingId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const b = w.buildings[buildingId];
  if (!gang || !b || b.ownerGangId !== gangId || b.managerId == null) return fail('Nobody of yours runs that place.');
  const mgr = w.people[b.managerId];
  b.managerId = null;
  b.managerRecalledWeek = w.week;
  if (mgr) {
    mgr.buildingId = null;
    mgr.teamId = null;
    if (!gang.poolIds.includes(mgr.id)) gang.poolIds.push(mgr.id);
    const office = nearestOffice(w, gangId, mgr.pos);
    if (office) setDestination(w, mgr, w.lots[office.lotId].center);
  }
  return ok(`${mgr?.name ?? 'The manager'} is on his way back to base. This week's takings go with him.`);
}

export function cancelOrder(w: WorldState, orderId: ID): ApiResult {
  const order = w.orders[orderId];
  if (!order) return fail('No such order.');
  recoverExportGoods(w, order);
  releaseTransportOrder(w,order.id);
  const team = w.teams[order.teamId];
  if (team) {
    team.orderIds = team.orderIds.filter((id) => id !== orderId);
    team.timeUsed = Math.max(0, team.timeUsed - order.estimatedMinutes);
  }
  for (const id of order.assignedIds) {
    if (order.type === 'guardBusiness') releaseGuardPost(w, id);
    const p = w.people[id];
    if (p?.orderId === orderId) {
      p.orderId = null;
      if (!p.streetOrder) {clearDestination(p);sendHome(w,p);}
    }
  }
  order.state = 'cancelled';
  delete w.orders[orderId];
  return ok('Order cancelled.');
}

/** Clear finished orders at the end of a week, keeping repeat orders alive. */
export function rolloverOrders(w: WorldState): void {
  // Keep a copy of everything that ran so the player can read the outcome.
  w.lastWeekOrders = Object.values(w.orders)
    .filter((o) => o.state === 'done' || o.state === 'failed')
    .map((o) => JSON.parse(JSON.stringify(o)) as Order);

  for (const team of Object.values(w.teams)) {
    const keep: ID[] = [];
    team.timeUsed = 0;
    for (const oid of team.orderIds) {
      const order = w.orders[oid];
      if (!order) continue;
      const def = ORDERS[order.type];
      if (order.opts.repeat && def.supportsRepeat && order.state !== 'cancelled') {
        order.state = 'queued';
        order.cursor = 0;
        order.completedTargets = 0;
        order.results = [];
        order.failReason = null;
        order.assignedIds = [];
        delete order.waitReleased;
        delete order.waitResumeState;
        delete order.dispatchWaitReason;
        delete order.reportedCrewSize;
        delete order.workedMinutes;
        if (order.type === 'collectProtection' && order.targetBlockIds.length) {
          const blocks = new Set(order.targetBlockIds);
          const picked = order.targetBuildingIds.filter(id => !blocks.has(w.buildings[id]?.blockId));
          order.targetBuildingIds = expandTargets(w, order.gangId, order.type, order.targetBlockIds, picked);
        }
        order.estimatedMinutes = estimateMinutes(w, team, order);
        team.timeUsed += order.estimatedMinutes;
        keep.push(oid);
      } else {
        delete w.orders[oid];
      }
    }
    team.orderIds = keep;
  }
}

/** Re-issue an order that ran last week, exactly as it was given. */
export function repeatOrder(w: WorldState, gangId: ID, archived: Order): ApiResult {
  return issueOrder(w, gangId, {
    teamId: archived.teamId,
    type: archived.type,
    buildingIds: archived.targetBuildingIds,
    blockIds: archived.targetBlockIds,
    personId: archived.targetPersonId,
    pos: archived.targetPos,
    opts: archived.opts,
  });
}

// ---------------------------------------------------------------- personnel

export function setPay(w: WorldState, personId: ID, pay: number): ApiResult {
  const p = w.people[personId];
  if (!p) return fail('No such person.');
  const before = p.pay;
  p.pay = Math.max(0, Math.round(pay));
  if (p.pay < before) p.loyalty = Math.max(0, p.loyalty - 6);
  else if (p.pay >= p.payDemand) p.loyalty = Math.min(100, p.loyalty + 4);
  return ok();
}

export function sackPerson(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p) return fail('No such person.');
  defect(w, gang, personId);
  // defect() already applied the original's leaving-the-gang hostility.
  opinionSet(p, gangId, Math.min(-40, (p.opinion[gangId] ?? 0) - 40), NO_ORIGINAL_CHANNEL);
  return ok(`${p.name} is back on the street.`);
}

export function killMember(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p) return fail('No such person.');
  killPerson(w, p, `executed on the orders of ${gang.name}`);
  // No police case — but the rest of the gang notices.
  for (const t of teamsOf(w, gang)) {
    const lt = w.people[t.lieutenantId];
    if (lt) {
      lt.loyalty = Math.max(0, lt.loyalty - 6);
      lt.payDemand = Math.round(lt.payDemand * 1.06);
    }
  }
  return ok(`${p.name} has been dealt with.`);
}

export function promote(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.gangId !== gangId || p.role !== 'hood') return fail('Choose one of your hoods.');
  const crew = p.teamId == null ? null : w.teams[p.teamId];
  if (!gang.poolIds.includes(personId) && !(crew?.gangId === gangId && crew.memberIds.includes(personId)))
    return fail('That hood is not in the pool or a crew.');
  if (gang.teamIds.length >= MAX_TEAMS) return fail('You already have eight lieutenants.');
  const team = promoteToLieutenant(w, gang, p);
  return team ? ok(`${p.name} now runs his own crew.`) : fail('Could not promote.');
}

export function demote(w: WorldState, gangId: ID, teamId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[teamId];
  if (!gang || !team || team.gangId !== gangId) return fail('No such crew.');
  const lt = w.people[team.lieutenantId];
  disbandTeam(w, gang, teamId, true);
  if (lt) lt.loyalty = Math.max(0, lt.loyalty - 10);
  return ok('The crew has been broken up.');
}

export function moveToTeam(w: WorldState, gangId: ID, personId: ID, teamId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[teamId];
  const p = w.people[personId];
  if (!gang || !team || team.gangId !== gangId || !p || p.gangId !== gangId || p.role !== 'hood')
    return fail('Choose one of your hoods and one of your crews.');
  const old = p.teamId == null ? null : w.teams[p.teamId];
  if (!gang.poolIds.includes(personId) && !(old?.gangId === gangId && old.memberIds.includes(personId)))
    return fail('That hood is not in the pool or a crew.');
  if (p.teamId === teamId) return ok();
  if (team.memberIds.length >= MAX_TEAM_SIZE - 1) return fail('That crew is full.');
  if (old) old.memberIds = old.memberIds.filter((id) => id !== personId);
  gang.poolIds = gang.poolIds.filter((id) => id !== personId);
  team.memberIds.push(personId);
  p.teamId = teamId;
  return ok();
}

export function moveToPool(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.gangId !== gangId || p.role !== 'hood') return fail('Choose one of your crew hoods.');
  const old = p.teamId == null ? null : w.teams[p.teamId];
  if (!gang.poolIds.includes(personId) && !(old?.gangId === gangId && old.memberIds.includes(personId)))
    return fail('That hood is not in the pool or a crew.');
  if (old) old.memberIds = old.memberIds.filter((id) => id !== personId);
  p.teamId = null;
  if (!gang.poolIds.includes(personId)) gang.poolIds.push(personId);
  return ok();
}

/** A man who signs on is off the market: take him off every gang's list. */
function unlistRecruit(w: WorldState, personId: ID): void {
  for (const g of Object.values(w.gangs)) g.recruitIds = g.recruitIds.filter((id) => id !== personId);
}

export function hireRecruit(
  w: WorldState,
  gangId: ID,
  personId: ID,
  destination: 'pool' | 'team' | 'lieutenant',
  teamId?: ID,
): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p) return fail('No such person.');
  if (p.gangId != null) return fail('They already work for somebody.');
  if (p.status !== 'active') return fail('That recruit is not available.');

  if (p.role === 'accountant' || p.role === 'lawyer') {
    const slot = p.role === 'accountant' ? 'accountantId' : 'lawyerId';
    const existing = gang[slot];
    if (existing != null) {
      if (p.role === 'accountant') rememberAccountantTax(w, gang);
      reclaimStaffVehicle(w, gang, p.role);
      const old = w.people[existing];
      if (old) {
        old.gangId = null;
        opinionSet(old, gangId, (old.opinion[gangId] ?? 0) - 25, LEFT_GANG);
      }
    }
    gang[slot] = p.id;
    p.gangId = gangId;
    p.buildingId = null;
    p.pay = p.payDemand;
    if (w.cityLayout?.original) originalStartingWage(p, gangId);
    p.loyalty = 70;
    p.inVehicle = false;
    const office = nearestOffice(w, gangId, p.pos);
    if (office) p.pos = { ...w.lots[office.lotId].center };
    unlistRecruit(w, personId);
    return ok(`${p.name} has joined you.`);
  }

  // Decide where they are going before taking them on, so a refusal never
  // leaves a half-hired man on the books.
  const wantsLieutenant = destination === 'lieutenant';
  const noSlot = wantsLieutenant && gang.teamIds.length >= MAX_TEAMS;

  p.gangId = gangId;
  p.buildingId = null;
  p.loyalty = 70;
  p.payDemand = hoodPayDemand(p, wantsLieutenant && !noSlot ? 'lieutenant' : 'hood');
  p.pay = p.payDemand;
  if (w.cityLayout?.original) originalStartingWage(p, gangId);
  unlistRecruit(w, personId);

  p.inVehicle = false;
  const office = nearestOffice(w, gangId, p.pos);
  if (office) p.pos = { ...w.lots[office.lotId].center };

  if (wantsLieutenant) {
    if (noSlot) {
      gang.poolIds.push(p.id);
      return ok(`${p.name} joined the pool — you have no free lieutenant slot.`);
    }
    promoteToLieutenant(w, gang, p);
    return ok(`${p.name} now runs a crew.`);
  }
  if (destination === 'team' && teamId != null) {
    const team = w.teams[teamId];
    if (team && team.memberIds.length < MAX_TEAM_SIZE - 1) {
      team.memberIds.push(p.id);
      p.teamId = teamId;
      return ok(`${p.name} joined ${team.name}.`);
    }
  }
  gang.poolIds.push(p.id);
  return ok(`${p.name} has joined the pool.`);
}

// ---------------------------------------------------------------- resources

export function buyWeapon(w: WorldState, gangId: ID, weapon: WeaponId, teamId?: ID): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (teamId != null && w.teams[teamId]?.gangId !== gangId) return fail('No such crew.');
  if (!WEAPONS[weapon]) return fail('No such weapon.');
  const cost = WEAPONS[weapon].cost;
  if (gang.cash < cost) return fail('You cannot afford it.');
  payCash(w, gang, 'purchases', cost, 'capital');
  if (teamId != null && w.teams[teamId]) {
    w.teams[teamId].weapons[weapon] = (w.teams[teamId].weapons[weapon] ?? 0) + 1;
  } else {
    gang.weapons[weapon] = (gang.weapons[weapon] ?? 0) + 1;
  }
  if (w.options.tutorialId === 4 && gang.isPlayer) {
    (w.tutorialActions ??= {}).weaponBought = true;
  }
  return ok(`Bought a ${WEAPONS[weapon].name}.`);
}

export function sellWeapon(w: WorldState, gangId: ID, weapon: WeaponId, teamId?: ID): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (teamId != null && w.teams[teamId]?.gangId !== gangId) return fail('No such crew.');
  if (!WEAPONS[weapon]) return fail('No such weapon.');
  const store = teamId != null && w.teams[teamId] ? w.teams[teamId].weapons : gang.weapons;
  if ((store[weapon] ?? 0) <= 0) return fail('You have none to sell.');
  store[weapon]--;
  receiveAssetCash(w, gang, Math.round(WEAPONS[weapon].cost * 0.5), WEAPONS[weapon].cost);
  return ok(`Sold a ${WEAPONS[weapon].name}.`);
}

export function transferWeapon(
  w: WorldState,
  gangId: ID,
  weapon: WeaponId,
  teamId: ID,
  toTeam: boolean,
): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[teamId];
  if (!gang || !team || team.gangId !== gangId) return fail('No such crew.');
  if (!WEAPONS[weapon]) return fail('No such weapon.');
  if (toTeam) {
    if ((gang.weapons[weapon] ?? 0) <= 0) return fail('None in the cache.');
    gang.weapons[weapon]--;
    team.weapons[weapon] = (team.weapons[weapon] ?? 0) + 1;
  } else {
    if ((team.weapons[weapon] ?? 0) <= 0) return fail('The crew has none.');
    team.weapons[weapon]--;
    gang.weapons[weapon] = (gang.weapons[weapon] ?? 0) + 1;
  }
  return ok();
}

export function buyVehicle(w: WorldState, gangId: ID, vehicle: VehicleId, teamId?: ID): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (teamId != null && w.teams[teamId]?.gangId !== gangId) return fail('No such crew.');
  if (!VEHICLES[vehicle]) return fail('No such vehicle.');
  const cost = VEHICLES[vehicle].cost;
  if (gang.cash < cost) return fail('You cannot afford it.');
  payCash(w, gang, 'purchases', cost, 'capital');
  if (teamId != null && w.teams[teamId]) {
    w.teams[teamId].vehicles[vehicle] = (w.teams[teamId].vehicles[vehicle] ?? 0) + 1;
  } else {
    gang.vehicles[vehicle] = (gang.vehicles[vehicle] ?? 0) + 1;
  }
  return ok(`Bought a ${VEHICLES[vehicle].name}.`);
}

export function sellVehicle(w: WorldState, gangId: ID, vehicle: VehicleId, teamId?: ID): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (teamId != null && w.teams[teamId]?.gangId !== gangId) return fail('No such crew.');
  if (!VEHICLES[vehicle]) return fail('No such vehicle.');
  const store = teamId != null && w.teams[teamId] ? w.teams[teamId].vehicles : gang.vehicles;
  if ((store[vehicle] ?? 0) <= 0) return fail('You have none to sell.');
  if(!removeFleetVehicle(w,teamId!=null?w.teams[teamId]:gang,vehicle))return fail('That vehicle is out with a crew or carrying goods. Bring it back first.');
  store[vehicle]--;
  receiveAssetCash(w, gang, Math.round(VEHICLES[vehicle].cost * 0.5), VEHICLES[vehicle].cost);
  return ok(`Sold a ${VEHICLES[vehicle].name}.`);
}

export function transferVehicle(
  w: WorldState,
  gangId: ID,
  vehicle: VehicleId,
  teamId: ID,
  toTeam: boolean,
): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[teamId];
  if (!gang || !team || team.gangId !== gangId) return fail('No such crew.');
  if (!VEHICLES[vehicle]) return fail('No such vehicle.');
  if (toTeam) {
    if ((gang.vehicles[vehicle] ?? 0) <= 0) return fail('None in the cache.');
    if(!removeFleetVehicle(w,gang,vehicle))return fail('That vehicle is still carrying goods. Bring it back first.');
    gang.vehicles[vehicle]--;
    team.vehicles[vehicle] = (team.vehicles[vehicle] ?? 0) + 1;
  } else {
    if ((team.vehicles[vehicle] ?? 0) <= 0) return fail('The crew has none.');
    if(!removeFleetVehicle(w,team,vehicle))return fail('That vehicle is out with a crew. Bring it back first.');
    team.vehicles[vehicle]--;
    gang.vehicles[vehicle] = (gang.vehicles[vehicle] ?? 0) + 1;
  }
  return ok();
}

// ---------------------------------------------------------------- territory

export function allocateBlocks(w: WorldState, gangId: ID, teamId: ID, blockIds: ID[]): ApiResult {
  const gang = w.gangs[gangId];
  const team = w.teams[teamId];
  if (!gang || !team || team.gangId !== gangId) return fail('No such crew.');
  if (blockIds.some((id) => !w.blocks[id])) return fail('No such block.');
  blockIds = canonicalAreaBlocks(w, blockIds);
  const { selected, other, available } = lieutenantAreaChoices(w, gangId, teamId);
  const additions = blockIds.filter(id => !selected.has(id));
  if (additions.some(id => other.has(id))) return fail('Release that area from its current lieutenant first.');
  if (additions.some(id => !available.has(id))) return fail('Choose blocks containing a business you own or protect.');
  team.allocatedBlockIds = blockIds;
  return ok();
}

// ---------------------------------------------------------------- buildings

export function setTrading(w: WorldState, gangId: ID, buildingId: ID, trading: boolean): ApiResult {
  const b = w.buildings[buildingId];
  if (!b || b.ownerGangId !== gangId) return fail('That is not yours.');
  if (b.fbiClosedWeek != null) return fail('The FBI closed this operation. Shut it down before opening a new business.');
  if (b.state === 'damaged' || b.state === 'destroyed' || b.state === 'empty' || b.cls === 'empty') return fail('The place is in no state to trade.');
  if (!trading) {
    if (b.state === 'trading') b.ceasedWeek = w.week;
    b.state = 'ceased'; delete b.resumeTradingWeek;
    // The illegal business behind it has no cover while the front is shut.
    const hidden = b.hidesId != null ? w.buildings[b.hidesId] : undefined;
    if (hidden && hidden.ownerGangId === gangId && hidden.state === 'trading') {
      hidden.ceasedWeek = w.week; hidden.state = 'ceased'; delete hidden.resumeTradingWeek;
    }
    return ok('The site has stopped trading for this week.');
  }
  if (!businessFrontReady(w,b)) return fail('The illegal business needs a trading legal front before it can reopen.');
  if (b.ceasedWeek === w.week) {
    b.resumeTradingWeek = w.week+1;
    return ok('Trading will resume next week.');
  }
  b.state = 'trading'; delete b.resumeTradingWeek; delete b.ceasedWeek;
  return ok('Trading has resumed.');
}

export function repairBuilding(w: WorldState, gangId: ID, buildingId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const b = w.buildings[buildingId];
  if (!gang || !b || b.ownerGangId !== gangId) return fail('That is not yours.');
  if (b.state !== 'damaged') return fail('It is not damaged.');
  if (b.repairCompleteWeek != null) return fail('Repairs are already underway.');
  if (gang.cash < b.repairCost) return fail('You cannot afford the repairs.');
  payCash(w, gang, 'purchases', b.repairCost);
  b.repairCost = 0;
  if(b.fireWeek!=null){
    b.repairCompleteWeek=Math.max(w.week+1,b.fireWeek+2);
    return ok(`Repairs will be complete in week ${b.repairCompleteWeek}.${b.fbiClosedWeek!=null?' The FBI closure still applies.':''}`);
  }
  b.state = b.fbiClosedWeek != null || b.ceasedWeek != null || !businessFrontReady(w,b) ? 'ceased' : 'trading';
  if (b.hidesId != null) {
    const hidden = w.buildings[b.hidesId];
    if (hidden && hidden.state === 'ceased' && hidden.fbiClosedWeek == null && hidden.ceasedWeek == null && businessFrontReady(w,hidden)) hidden.state = 'trading';
  }
  observeTargetRace(w, [gangId]);
  return ok('Repairs are underway.');
}

export function shutdownBuilding(w: WorldState, gangId: ID, buildingId: ID): ApiResult {
  const b = w.buildings[buildingId];
  if (!b || b.ownerGangId !== gangId) return fail('That is not yours.');
  if (b.isHQ) return fail('You cannot shut down your headquarters.');
  if (b.hidesId != null) return fail('Shut the illegal business down first.');
  if (b.frontId != null) {
    const front = w.buildings[b.frontId];
    if (front) front.hidesId = null;
    b.frontId = null;
  }
  if (b.managerId != null) {
    const mgr = w.people[b.managerId];
    if (mgr) {
      mgr.buildingId = null;
      if(mgr.status==='active'){mgr.pos=buildingDoor(w,b);sendHome(w,mgr);}
      const gang = w.gangs[gangId];
      if (gang && mgr.status !== 'dead' && !gang.poolIds.includes(mgr.id)) gang.poolIds.push(mgr.id);
    }
    b.managerId = null;
  }
  b.typeId = 'emptyLand';
  b.cls = 'empty';
  b.state = 'empty';
  forgetWhatWasThere(b, gangId);
  stopBusinessGuards(w,b,'The business was shut down.');
  resetBusinessInvestigation(w,b);
  delete b.ceasedWeek; delete b.resumeTradingWeek;
  delete b.fireWeek;
  delete b.repairCompleteWeek;
  b.stock = { liquor: 0, stolen: 0, counterfeit: 0 };
  return ok('The site has been closed down.');
}

/** Read-only offer used by the money roll and rechecked when accepted. */
export function quoteBuildingSale(w: WorldState, gangId: ID, buildingId: ID):
  {ok:true;value:number} | {ok:false;error:string} {
  const gang = w.gangs[gangId];
  const b = w.buildings[buildingId];
  if (!gang || !b || b.ownerGangId !== gangId) return {ok:false,error:'That is not yours.'};
  if (b.cls === 'illegal') return {ok:false,error:'Shut the illegal business down before selling the land.'};
  if (b.hidesId != null) return {ok:false,error:'Shut the illegal business down first.'};
  if (b.isHQ) return {ok:false,error:'You cannot sell your headquarters.'};
  let value = buildingValue(w, b);
  if (b.state === 'damaged') value = Math.round(value * 0.4);
  return {ok:true,value};
}

export function sellBuilding(w: WorldState, gangId: ID, buildingId: ID, acceptedPrice?: number): ApiResult {
  const offer = quoteBuildingSale(w,gangId,buildingId);
  if (!offer.ok) return offer;
  if (acceptedPrice != null && (!Number.isFinite(acceptedPrice) || acceptedPrice !== offer.value))
    return fail('The offer has changed. Ask for a new price before selling.');
  const b = w.buildings[buildingId], gang = w.gangs[gangId], value = offer.value;
  if (b.managerId != null) {
    const mgr = w.people[b.managerId];
    if (mgr) {
      mgr.buildingId = null;
      if(mgr.status==='active'){mgr.pos=buildingDoor(w,b);sendHome(w,mgr);}
      if (mgr.status !== 'dead' && !gang.poolIds.includes(mgr.id)) gang.poolIds.push(mgr.id);
    }
    b.managerId = null;
  }
  if (b.frontId != null) {
    const front = w.buildings[b.frontId];
    if (front) front.hidesId = null;
    b.frontId = null;
  }
  b.ownerGangId = null;
  delete b.resumeTradingWeek;
  stopBusinessGuards(w,b,'The business was sold.');
  receiveAssetCash(w, gang, value, b.acquisitionCost ?? value);
  delete b.acquisitionCost;
  reportBusinessMove(w, gangId, b, 'sold');
  return ok(`Sold for ${value.toLocaleString('en-US')}.`);
}

// ---------------------------------------------------------------- specialists

export function toggleEvadeTax(w: WorldState, gangId: ID): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (!gang.evadingTax && !availableSpecialist(w, gang, 'accountant')) return fail('You need an available accountant.');
  gang.evadingTax = !gang.evadingTax;
  return ok(gang.evadingTax ? 'The accountant will hold back what he can.' : 'Taxes will be paid in full.');
}

export function orderAudit(w: WorldState, gangId: ID, targetPersonId: ID): ApiResult {
  return queueSpecialistJob(w, gangId, 'audit', targetPersonId);
}

export function bribeOfficial(w: WorldState, gangId: ID, personId: ID): ApiResult {
  return queueSpecialistJob(w, gangId, 'bribeOfficials', personId);
}

export function employPoliceOfficer(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.role !== 'police') return fail('That is not an officer.');
  if (p.employedBy === gangId) return ok(`${p.name} is already on your payroll.`);
  if (quitGangPayroll(p, gangId)) return fail(`${p.name} quit your payroll and will not go back on it.`);
  return queueSpecialistJob(w, gangId, 'employPolice', personId);
}

/** Give the accountant or the lawyer a car from the cache, or take it back. */
export function assignStaffVehicle(w: WorldState, gangId: ID, who: 'accountant' | 'lawyer', vehicle: VehicleId | null): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  const holder = who === 'accountant' ? gang.accountantId : gang.lawyerId;
  const person = holder == null ? undefined : w.people[holder];
  if (!person || person.gangId !== gangId || person.role !== who) return fail(`You have no ${who}.`);
  const had = gang.staffVehicles?.[who] ?? null;
  // Validate the replacement before returning the currently allocated keys.
  if (vehicle && (!Object.hasOwn(VEHICLES, vehicle) ||
    (vehicle !== had && (gang.vehicles[vehicle] ?? 0) <= 0))) return fail('None of those in the cache.');
  if (vehicle && !availableSpecialist(w, gang, who)) return fail(`Your ${who} is not available.`);
  if (vehicle === had) return ok();
  if(person.vehicleKey&&w.vehicleFleet?.[person.vehicleKey]?.occupantIds.length)return fail(`Bring your ${who} back before changing the car.`);
  if(vehicle&&!removeFleetVehicle(w,gang,vehicle))return fail('That vehicle is still out with goods.');
  reclaimStaffVehicle(w, gang, who);
  gang.staffVehicles ??= { accountant: null, lawyer: null };
  if (vehicle != null) {
    gang.vehicles[vehicle]--;
    gang.staffVehicles[who] = vehicle;
  }
  person.inVehicle = false;
  return ok(vehicle ? `The ${who} has the keys to a ${VEHICLES[vehicle].name.toLowerCase()}.` : `The ${who} is back on foot.`);
}

/** How many officers the lawyer can put on the payroll on one tour of an area. */
export function policeTourCapacity(gang: Gang): number {
  return gang.staffVehicles?.lawyer ? 8 : 4;
}

/** The lawyer tours an area putting the officers on its beats on a weekly retainer. */
export function employPoliceInArea(w: WorldState, gangId: ID, blockIds: ID[]): ApiResult {
  return queueSpecialistJob(w, gangId, 'employPolice', null, blockIds);
}

/** Which block a street position belongs to, counting the streets round it. */
export function blockIdAt(w: WorldState, pos: Vec2): ID {
  const gx = Math.max(0, Math.min(w.gridW - 1, Math.floor(pos.x / CELL)));
  const gy = Math.max(0, Math.min(w.gridH - 1, Math.floor(pos.y / CELL)));
  return cityBlockAt(w, gx, gy)!.id;
}

export function dismissPoliceOfficer(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.role !== 'police' || p.employedBy !== gangId) return fail('That officer is not on your payroll.');
  p.employedBy = null; delete p.retainerShort;
  p.weeklyRetainer = 0;
  opinionSet(p, gangId, (p.opinion[gangId] ?? 0) - 25, NO_ORIGINAL_CHANNEL);
  gang.employedPoliceIds = gang.employedPoliceIds.filter((id) => id !== personId);
  return ok(`${p.name} is off the payroll — and furious about it.`);
}

export function canGoStraight(w: WorldState, gangId: ID): { can: boolean; reason: string } {
  const gang = w.gangs[gangId];
  if (!gang) return { can: false, reason: 'No such gang.' };
  if (!availableSpecialist(w, gang, 'lawyer')) return { can: false, reason: 'You need an available lawyer.' };
  const assets = gangAssets(w, gang);
  if (assets < GO_STRAIGHT_ASSETS)
    return { can: false, reason: `You need ${GO_STRAIGHT_ASSETS.toLocaleString('en-US')} in assets, excluding cash (you have ${assets.toLocaleString('en-US')}).` };
  const cases = Object.values(w.cases).filter(
    (c) => c.gangId === gangId && (c.status === 'awaiting' || c.status === 'onTrial'),
  );
  if (cases.length) return { can: false, reason: 'You have people awaiting trial.' };
  const illegal = ownedBuildings(w, gangId).filter((b) => b.cls === 'illegal' && b.typeId !== 'office');
  if (illegal.length) return { can: false, reason: `You still run ${illegal.length} illegal business(es).` };
  return { can: true, reason: 'Ready to go straight.' };
}

export function setGoStraight(w: WorldState, gangId: ID, on: boolean): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (w.options.mode !== 'normal' && on) return fail('Going straight is only possible in a full game.');
  if (on) {
    const check = canGoStraight(w, gangId);
    if (!check.can) return fail(check.reason);
  }
  gang.goingStraight = on;
  return ok(on ? 'Your lawyer has begun the paperwork.' : 'You are back in the life.');
}

export function setRunForOffice(w: WorldState, gangId: ID, on: boolean): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang) return fail('No such gang.');
  if (!on) {
    withdrawFromElection(w, gangId);
    return ok('You have withdrawn from the race.');
  }
  const check = officeEntryCheck(w, gangId);
  if (!check.can) return fail(check.reason);
  if (!enterElection(w, gangId)) return fail('The ballot is full.');
  return ok(`Your campaign has begun. Current weekly cost: $${campaignWeeklyCost(w, gangId).toLocaleString('en-US')}.`);
}

// ---------------------------------------------------------------- prisoners

export function interrogatePrisoner(w: WorldState, rng: Rng, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.capturedBy !== gangId) return fail('You hold no such prisoner.');
  if (p.interrogationValue <= 0) return fail('He has nothing left to tell you.');

  const talked = rng.chance(0.35 + (p.interrogationValue / 100) * 0.3);
  p.interrogationValue = Math.max(0, p.interrogationValue - 30);
  if (!talked) return ok(`${p.name} said nothing.`);

  const learned = revealRivalIntel(w, rng, gang, p);
  return ok(learned || `${p.name} gave you nothing useful.`);
}

export function assaultPrisoner(w: WorldState, rng: Rng, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.capturedBy !== gangId) return fail('You hold no such prisoner.');
  p.hp -= rng.int(20, 45);
  if (p.hp <= 0) {
    killPerson(w, p, 'died under interrogation');
    gang.prisonerIds = gang.prisonerIds.filter((id) => id !== personId);
    return ok(`${p.name} died under questioning.`);
  }
  const learned = revealRivalIntel(w, rng, gang, p);
  p.interrogationValue = Math.max(0, p.interrogationValue - 20);
  return ok(learned || `${p.name} is still not talking.`);
}

export function killPrisoner(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.capturedBy !== gangId) return fail('You hold no such prisoner.');
  const rivalId = p.gangId;
  killPerson(w, p, `killed in custody by ${gang.name}`);
  gang.prisonerIds = gang.prisonerIds.filter((id) => id !== personId);
  // Word gets around, and the rival takes it badly (the player decides for himself).
  provoke(w, rivalId, gangId, INCIDENT_HOSTILITY.kill);
  return ok(`${p.name} will not be missed.`);
}

export function releasePrisoner(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const gang = w.gangs[gangId];
  const p = w.people[personId];
  if (!gang || !p || p.capturedBy !== gangId) return fail('You hold no such prisoner.');
  p.status = 'active';
  p.capturedBy = null;
  p.interrogationValue = 0;
  const office = nearestOffice(w, gangId, p.pos);
  if (office) p.pos = buildingDoor(w, office);
  p.buildingId = null;
  p.inVehicle = false;
  p.orderId = null;
  p.streetOrder = null;
  clearDestination(p);
  gang.prisonerIds = gang.prisonerIds.filter((id) => id !== personId);
  return ok(`${p.name} has been thrown out onto the street.`);
}

function revealRivalIntel(w: WorldState, rng: Rng, gang: Gang, prisoner: Person): string | null {
  const rivalId = prisoner.gangId;
  if (rivalId == null) return null;
  const rival = w.gangs[rivalId];
  if (!rival) return null;

  // Names first, then places.
  const unknownPeople = peopleList(w).filter(
    (p) => p.gangId === rivalId && p.status !== 'dead' && !gang.knownPeople.includes(p.id),
  );
  if (unknownPeople.length && rng.chance(0.6)) {
    const n = Math.min(unknownPeople.length, rng.int(1, 3));
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = unknownPeople[i];
      gang.knownPeople.push(t.id);
      names.push(t.name);
    }
    return `He named ${names.join(', ')}.`;
  }

  const hiddenSites = allBuildings(w).filter(
    (b) => b.ownerGangId === rivalId && (b.knowledge[gang.id] ?? 0) < 3 && b.state !== 'destroyed',
  );
  if (hiddenSites.length) {
    const site = rng.pick(hiddenSites);
    site.knowledge[gang.id] = 3;
    return `He gave up the location of a ${BUILDING_BY_ID[site.typeId]?.name ?? 'site'}.`;
  }
  return null;
}

// ---------------------------------------------------------------- diplomacy

export function setDiplomacy(
  w: WorldState,
  gangId: ID,
  otherId: ID,
  level: DiplomacyLevel,
): ApiResult {
  const gang = w.gangs[gangId];
  if (!gang || !w.gangs[otherId]) return fail('No such gang.');
  gang.offered[otherId] = level;
  return ok();
}

export function buySnitchInfo(
  w: WorldState,
  rng: Rng,
  gangId: ID,
  snitchId: ID,
  targetGangIds: ID[],
): ApiResult {
  const gang = w.gangs[gangId];
  const snitch = w.people[snitchId];
  if (!gang || !snitch) return fail('No such snitch.');
  if (gang.snitchUsedWeek === w.week) return fail('You have already bought from a snitch this week.');

  const candidates: Person[] = [];
  for (const p of peopleList(w)) {
    if (p.status === 'dead') continue;
    if (gang.knownPeople.includes(p.id)) continue;
    if (p.gangId === gangId) continue;
    const wantsUnaffiliated = targetGangIds.includes(0);
    if (p.gangId == null && wantsUnaffiliated && (p.role === 'hood' || p.role === 'lieutenant')) {
      candidates.push(p);
    } else if (p.gangId != null && targetGangIds.includes(p.gangId)) {
      candidates.push(p);
    }
  }
  if (!candidates.length) return fail('He has nothing you do not already know.');

  const price = 400 * targetGangIds.length + candidates.length * 30;
  if (gang.cash < price) return fail(`He wants ${price.toLocaleString('en-US')} for that.`);
  payCash(w, gang, 'purchases', price);
  gang.snitchUsedWeek = w.week;

  rng.shuffle(candidates);
  const n = Math.min(candidates.length, rng.int(2, 6));
  for (let i = 0; i < n; i++) gang.knownPeople.push(candidates[i].id);
  return ok(`${snitch.name} named ${n} people for ${price.toLocaleString('en-US')}.`);
}

export function snitchPrice(w: WorldState, gangId: ID, targetGangIds: ID[]): number {
  const gang = w.gangs[gangId];
  if (!gang) return 0;
  let count = 0;
  for (const p of peopleList(w)) {
    if (p.status === 'dead' || gang.knownPeople.includes(p.id) || p.gangId === gangId) continue;
    if (p.gangId == null && targetGangIds.includes(0) && (p.role === 'hood' || p.role === 'lieutenant')) count++;
    else if (p.gangId != null && targetGangIds.includes(p.gangId)) count++;
  }
  return 400 * targetGangIds.length + count * 30;
}

// ---------------------------------------------------------------- street orders

export type StreetOrderType = 'kill' | 'assault' | 'tail' | 'goTo';

export function issueStreetOrder(
  w: WorldState,
  gangId: ID,
  personIds: ID[],
  type: StreetOrderType,
  targetPersonId: ID | null,
  pos: Vec2 | null,
): ApiResult {
  if (!w.gangs[gangId] || personIds.some((id) => !w.people[id] || w.people[id].gangId !== gangId || w.people[id].status !== 'active')) {
    return fail('Choose available people from your gang.');
  }
  if (!['goTo', 'tail', 'assault', 'kill'].includes(type)) return fail('No such street order.');
  if (type === 'goTo') {
    if (!validPoint(w, pos)) return fail('Choose a place inside the city.');
  } else {
    const target = targetPersonId != null ? w.people[targetPersonId] : null;
    if (!target || ['dead', 'jailed', 'kidnapped'].includes(target.status) || personIds.includes(target.id)) return fail('Choose an available target.');
  }
  const actors = [...new Set(personIds)].map((id) => w.people[id]);
  if (!actors.length) return fail('Nobody selected.');
  // The accountant and the lawyer are not fighting men: they go where they
  // are sent and nothing more.
  if (type !== 'goTo' && actors.some((a) => a.role === 'accountant' || a.role === 'lawyer')) {
    return fail('The accountant and the lawyer will only go where you send them.');
  }

  for (const a of actors) {
    const car=a.vehicleKey?w.vehicleFleet?.[a.vehicleKey]:undefined;
    // Out of a car shared with others not given this order — and out of a
    // reservation on a car he was still walking to (it boarded him and drove
    // him to the cancelled job).
    if(car&&(!a.inVehicle||car.occupantIds.some(id=>!personIds.includes(id))))alight(w,a);
    else if(car)car.returning=false;
    cancelSpecialistVisits(w, a.id);
    // Take them off their planned order for the moment: they go back to it
    // when the street order is done (tickOrders). A delivery under way is the
    // exception; its goods go back and the man leaves it for good.
    if (a.orderId != null) {
      const order = w.orders[a.orderId];
      if (order?.type === 'guardBusiness') releaseGuardPost(w, a.id);
      if (order && !order.exportDelivery && !order.raidDelivery) a.resumeOrderId = order.id;
      else if (order) {
        order.assignedIds = order.assignedIds.filter((id) => id !== a.id);
        if (!order.assignedIds.length) recoverExportGoods(w, order, false);
      }
      a.orderId = null;
    }
    a.streetOrder = { type, targetPersonId, pos: pos ? { ...pos } : null };
    clearDestination(a);
    if (type === 'goTo' && pos) setDestination(w, a, pos);
  }
  // Start the route now, so the renderer can show movement between minute
  // ticks. Allocate after every actor has their new task, as the tick does.
  if (type !== 'goTo') {
    const loadout = allocateWeapons(w), target = w.people[targetPersonId!];
    for (const a of actors) prepareStreetPursuit(w,a,target,streetOrderRange(a,loadout));
  }
  const subject = actors.length === 1 ? actors[0].name : `${actors.length} of your people`;
  const message = type === 'goTo' ? `${subject}: moving to the selected location.` :
    `${subject}: ${type === 'kill' ? 'Kill' : type === 'assault' ? 'Assault' : 'Tail'} ${w.people[targetPersonId!].name}.`;
  addMessage(
    w,
    'waiting',
    message,
    actors[0].pos,
    actors[0].id,
  );
  return ok(message);
}

/** Drop whatever a person is doing and send them back to the nearest office. */
export function returnToBase(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const p = w.people[personId];
  if (!p || p.gangId !== gangId) return fail('Not one of yours.');
  if (p.status !== 'active') return fail(`${p.name} is in no position to move.`);
  cancelSpecialistVisits(w, p.id);
  const orderId = p.orderId ?? p.resumeOrderId;
  if (orderId != null) {
    const order = w.orders[orderId];
    if (order?.type === 'guardBusiness') releaseGuardPost(w, p.id);
    if (order) order.assignedIds = order.assignedIds.filter((id) => id !== p.id);
    if (order && !order.assignedIds.length) recoverExportGoods(w, order, false);
    p.orderId = null;
  }
  delete p.resumeOrderId;
  p.streetOrder = null;
  const office = nearestOffice(w, gangId, p.pos);
  if (!office) return fail('You have no office to return to.');
  const car=p.vehicleKey?w.vehicleFleet?.[p.vehicleKey]:undefined;
  // Others in the car still at work (an order or a street order) keep it.
  if(car&&car.occupantIds.some(id=>id!==p.id&&(w.people[id]?.orderId!=null||w.people[id]?.streetOrder!=null)))alight(w,p);
  sendHome(w,p);
  return ok(`${p.name} is heading back to base.`);
}

/** Out of the car and onto the pavement; the journey continues on foot. */
export function leaveVehicle(w: WorldState, gangId: ID, personId: ID): ApiResult {
  const p = w.people[personId];
  if (!p || p.gangId !== gangId) return fail('Not one of yours.');
  if (!p.inVehicle) return fail(`${p.name} is already on foot.`);
  alight(w,p);
  if (p.dest) setDestination(w, p, p.dest);
  return ok(`${p.name} is out of the car.`);
}

export function clearStreetOrder(w: WorldState, personIds: ID[]): ApiResult {
  for (const id of personIds) {
    const p = w.people[id];
    if (!p?.streetOrder) continue;
    p.streetOrder = null; clearDestination(p);
    // A driver stopped: passengers still on a street order go on, on foot
    // (they had no route of their own and sat there for good).
    const car = p.inVehicle && p.vehicleKey ? w.vehicleFleet?.[p.vehicleKey] : undefined;
    if (car?.driverId === p.id) for (const other of car.occupantIds.map(o => w.people[o]).filter(Boolean))
      if (other.id !== p.id && other.streetOrder) alight(w, other);
  }
  return ok();
}

export function setWaiting(w: WorldState, orderId: ID, waiting: boolean): ApiResult {
  const order = w.orders[orderId];
  if (!order) return fail('No such order.');
  if (!['travelling', 'executing', 'waiting'].includes(order.state)) return fail('That order is not in progress.');
  if (waiting) {
    if (order.state === 'waiting') return ok();
    order.waitResumeState = order.state as 'travelling' | 'executing';
    order.state = 'waiting';
    for (const id of order.assignedIds) {
      const person = w.people[id];
      if (person?.orderId === orderId && !person.streetOrder) clearDestination(person);
    }
  }
  else if (order.state === 'waiting') {
    order.waitReleased = true;
    // Older saves do not record the paused phase. Resume their journey once;
    // the released flag prevents the original Wait instruction firing again.
    order.state = order.waitResumeState ?? 'travelling';
    delete order.waitResumeState;
  }
  return ok();
}

/** How much of a team's week is already committed, 0..1. */
export function teamTimeFraction(team: Team): number {
  return Math.min(1, team.timeUsed / MINUTES_PER_WEEK);
}
