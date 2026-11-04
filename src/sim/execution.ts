import { INCIDENT_HOSTILITY, provoke } from './aiStance';
import { originalWageQuote } from './originalWages';
import { BLAST_DAMAGE, blastFear, effectiveHostility, fearOf, hostilityOf, MEMBER_DEATH_FEAR, NO_ORIGINAL_CHANNEL, opinionShift, ownerSquealLevel, setAttitude, shiftAttitude } from './attitudes';
import { onMayorDeath, refreshNominees } from './systems/politics';
import { originalHuntArrived, originalHuntFinds, startOriginalHunt } from './systems/originalHunt';
import {startBuildingEmergency} from './systems/buildingEmergency';
import { validAmbushTarget } from './ambush';
import { crewPeople, orderStaffing, readyForPlanning } from './orderStaffing';
import { claimedTerritoryBlocks, distanceToTerritory } from './territory';
import { observeTargetRace } from './targetRace';
import { reclaimStaffVehicle } from './specialists';
import { allocateTransport, alight, availableVehicle, dismount, stepOut, orderVehicles, plannedTravelSpeed, transportPlan, reconcileTransport, releaseTransportOrder, resetWeekTransport, sendHome } from './transport';
import { cargoVehicles, cargoWarehouse, emptyGoods, goodsTotal, loadCargo, refreshExportCargo, unloadCargo } from './cargo';
import {
  DRIVE_MIN_DISTANCE,
  MINUTES_PER_WEEK,
  ORDERS,
  VEHICLES,
  WEAPON_ORDER,
} from './constants';
import { BUILDING_BY_ID, coverQuality } from './data/buildings';
import { addMessage, addNews, blockAtPos, recordCrime, reportBusinessMove, shiftLocalOpinion } from './events';
import { donationAmount, donationTarget } from './charity';
import { purchasablePremisesType } from './premises';
import { respondToBureauViolence } from './bureauViolence';
import { presentDeath, presentAttack, presentBuildingEffect, presentThrow, THROW_TIMING } from './presentationEvents';
import type { MessageCategory } from './types';
import { hoodPayDemand, newId } from './citygen';
import { payCash, receiveOrderCash } from './finances';
import { resetBusinessInvestigation } from './businessState';
import { isExportTerminal, nearestExportTerminal, recoverExportGoods } from './exportGoods';
import { clearDestination, setDestination, stepPerson } from './movement';
import { trafficContext } from './traffic';
import { allocateWeapons, attackProfile, type Loadout } from './weapons';
import type { Rng } from './rng';
import type {
  Building,
  Gang,
  ID,
  Order,
  OrderType,
  Person,
  Skills,
  Team,
  Vec2,
  WorldState,
} from './types';
import {
  CENTRE_LOT,
  allBuildings,
  buildingDoor,
  buildingName,
  placeName,
  buildingsOfBlock,
  dist,
  skillAvg,
  starFactor,
  typeOf,
} from './world';
import { peopleList, buildingList } from './entityLists';

// ---------------------------------------------------------------- utilities

/**
 * Report to the boss. Only the player's own gang generates entries in the
 * message log — you do not get told what a rival's hoods are up to across town.
 */
function report(
  w: WorldState,
  gangId: ID,
  category: MessageCategory,
  text: string,
  pos: Vec2 | null = null,
  personId: ID | null = null,
  sound?: 'gunshot',
): void {
  if (!w.gangs[gangId]?.isPlayer) return;
  addMessage(w, category, text, pos, personId, sound);
}

/** Original city: an owner whose squeal level toward the gang is above 200
 * files a crime record (rec+0x24 += 5) — 0x4CD730 ln 210-217. */
function squealIfAbove200(w: WorldState, gang: Gang, owner: Person, building: Building, pos: Vec2, leadId: ID): void {
  if (owner.status === 'dead') return;
  const influence = claimedTerritoryBlocks(w, gang.id).has(w.blocks[building.blockId]?.layout?.mergedInto ?? building.blockId);
  if (ownerSquealLevel(owner, gang.id, influence) <= 200) return;
  gang.evidence = Math.min(100, gang.evidence + 5);
  report(w, gang.id, 'police', `${owner.name} squealed to the police about your hoods.`, pos, leadId);
}

export function orderActors(w: WorldState, order: Order): Person[] {
  const out: Person[] = [];
  for (const id of order.assignedIds) {
    const p = w.people[id];
    if (p && p.orderId === order.id && p.status === 'active' && p.burningEscape?.week!==w.week) out.push(p);
  }
  return out;
}

export function whereaboutsUnknown(gang: Gang, target: Person): boolean {
  if (target.gangId === gang.id) return false;
  if (target.gangId == null) return false;
  if (gang.knownPeople.includes(target.id)) return false;
  return true;
}

/** The pool halls and gyms nearest the office, where a crew asks after a stranger. */
export function huntStops(w: WorldState, gangId: ID): ID[] {
  // Every pool hall and gym, as a round from the office: the nearest next each time.
  const office = nearestOffice(w, gangId, w.blocks[0].center);
  let at = office ? w.lots[office.lotId].center : w.blocks[0].center;
  const left = allBuildings(w).filter((b) => b.state === 'trading' && (b.typeId === 'poolHall' || b.typeId === 'gym'));
  const round: ID[] = [];
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (dist(w.lots[left[i].lotId].center, at) < dist(w.lots[left[best].lotId].center, at)) best = i;
    const [b] = left.splice(best, 1);
    round.push(b.id);
    at = w.lots[b.lotId].center;
  }
  return round;
}

export function nearestOffice(w: WorldState, gangId: ID, near: Vec2): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of allBuildings(w)) {
    if (b.ownerGangId !== gangId || b.typeId !== 'office' || b.state === 'destroyed') continue;
    const d = dist(w.lots[b.lotId].center, near);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function actorSkill(actors: Person[], skills: (keyof Skills)[]): number {
  if (!actors.length) return 1;
  // The best hand on the job leads, the rest help a little.
  let best = 0;
  let sum = 0;
  for (const a of actors) {
    const s = skillAvg(a, skills);
    sum += s;
    if (s > best) best = s;
  }
  return best * 0.7 + (sum / actors.length) * 0.3;
}

/** Success roll shared by every order. `difficulty` is 0 (trivial) .. 1 (brutal). */
function roll(rng: Rng, actors: Person[], skills: (keyof Skills)[], difficulty: number): boolean {
  const s = starFactor(actorSkill(actors, skills));
  const chance = Math.max(0.03, Math.min(0.97, 0.18 + s * 0.85 - difficulty * 0.75));
  return rng.chance(chance);
}

function spend(w: WorldState, gang: Gang, amount: number, treatment: 'operating' | 'capital' = 'operating'): boolean {
  if (gang.cash < amount) return false;
  payCash(w, gang, 'purchases', amount, treatment);
  return true;
}

/** A gang that is wiped out holds nothing: its premises are for sale again,
 *  its rackets are free for the taking, and its hidden businesses are shut. */
export function releaseGangHoldings(w: WorldState, gangId: ID): void {
  for (const b of buildingList(w)) {
    if (b.protection?.gangId === gangId) b.protection = null;
    if (b.ownerGangId !== gangId) continue;
    b.ownerGangId = null;
    b.managerId = null;
    b.isHQ = false;
    if (b.cls === 'illegal' && b.state === 'trading') { b.state = 'ceased'; b.ceasedWeek = w.week; }
  }
}

/** A new business on a lot is news to everybody else: what a rival learnt of
 *  the old one (an explored front, a shut speakeasy) does not reveal it. */
export function forgetWhatWasThere(b: Building, ownerGangId: ID | null): void {
  for (const key of Object.keys(b.knowledge ?? {})) {
    const g = Number(key);
    if (g !== ownerGangId && (b.knowledge[g] ?? 0) > 1) b.knowledge[g] = 1;
  }
}

export function buildingValue(w: WorldState, b: Building): number {
  const t = typeOf(b);
  const blk = w.blocks[b.blockId];
  const base = t ? t.cost : 2000;
  // Violence depresses land values, which makes buying cheaper.
  const heatDiscount = 1 - Math.min(0.35, blk.crimeHeat / 260);
  return Math.round(base * (0.55 + blk.landValue / 100) * heatDiscount);
}

export function protectionBase(w: WorldState, b: Building): number {
  const t = typeOf(b);
  const blk = w.blocks[b.blockId];
  const p = t ? Math.max(140, t.profit) : 170;
  // Enough that a modest racket pays a modest crew, as it does in the original.
  return Math.round((p * 0.62 + blk.landValue * 5) / 10) * 10;
}

// ---------------------------------------------------------------- targeting

/** Expand a player/AI selection into the concrete list of buildings to work. */
export function expandTargets(
  w: WorldState,
  gangId: ID,
  type: OrderType,
  blockIds: ID[],
  buildingIds: ID[],
): ID[] {
  const def = ORDERS[type];
  if (def.target === 'building') return buildingIds.slice(0, 1);
  if (def.target !== 'area') return [];

  const out: ID[] = [];
  const seen = new Set<ID>(buildingIds);
  for (const id of buildingIds) out.push(id);

  for (const blockId of blockIds) {
    const blk = w.blocks[blockId];
    if (!blk) continue;
    for (const b of buildingsOfBlock(w, blk)) {
      if (seen.has(b.id)) continue;
      if (!isValidAreaTarget(w, gangId, type, b)) continue;
      seen.add(b.id);
      out.push(b.id);
    }
  }
  return out;
}

export function isValidAreaTarget(
  _w: WorldState,
  gangId: ID,
  type: OrderType,
  b: Building,
): boolean {
  if (b.state === 'destroyed') return false;
  switch (type) {
    case 'extort':
      return (
        b.cls !== 'empty' && purchasablePremisesType(b) &&
        !b.protection &&
        b.ownerGangId == null
      );
    case 'collectProtection':
      return b.protection?.gangId === gangId;
    case 'adjustProtection':
      return b.protection?.gangId === gangId;
    case 'intimidate':
      return b.protection?.gangId === gangId && b.protection.refusing;
    case 'explore':
      return b.cls !== 'empty';
    case 'recruit':
      return !!typeOf(b)?.recruit;
    case 'patrol':
    case 'ambush':
      return b.lotId >= 0;
    default:
      return true;
  }
}

/** Standing area jobs accept both whole blocks and individual map/Clipboard sites.
 * Derive the route without rewriting the saved selection (which would expand a
 * deliberately excluded property when the card is edited or repeated).
 */
export function standingBlocks(w: WorldState, order: Order): ID[] {
  return [...new Set([...order.targetBlockIds, ...order.targetBuildingIds
    .map(id => w.buildings[id]?.blockId).filter((id): id is ID => id != null)]
    .map(id => w.blocks[id]?.layout?.mergedInto ?? id))].filter(id => !!w.blocks[id]);
}

/** A person who can still be found on the street (not dead, held or in custody). */
function onTheStreet(p: Person): boolean {
  return p.status === 'active' || p.status === 'beaten';
}

/** Where the hoods must physically stand for the current target. */
function targetPos(w: WorldState, order: Order): Vec2 | null {
  const def = ORDERS[order.type];
  if (order.exportDelivery) {
    const terminal = w.buildings[order.exportDelivery.terminalId];
    return isExportTerminal(terminal) ? buildingDoor(w, terminal) : null;
  }
  if(order.raidDelivery){const warehouse=w.buildings[order.raidDelivery.warehouseId];return warehouse?buildingDoor(w,warehouse):null;}
  if (order.hunting) return huntPos(w, order);
  if (def.target === 'person') {
    const p = order.targetPersonId != null ? w.people[order.targetPersonId] : null;
    if (!p || !onTheStreet(p)) return null;
    return p.pos;
  }
  if (def.target === 'point') return order.targetPos;
  if (def.wholeWeek && def.target === 'area') {
    // Patrol/ambush: walk between the blocks of the allocated area.
    const blocks = standingBlocks(w, order);
    const idx = order.cursor % Math.max(1, blocks.length);
    const blk = w.blocks[blocks[idx]];
    return blk ? w.cityLayout ? blockPavement(blk, order.id + order.cursor) : blk.center : order.targetPos;
  }
  const bId = order.targetBuildingIds[order.cursor];
  if (bId == null) return null;
  const b = w.buildings[bId];
  if (!b) return null;
  return buildingDoor(w, b);
}

/** While hunting, the crew heads for the next place to ask at. */
function huntPos(w: WorldState, order: Order): Vec2 | null {
  if (order.huntTip) return order.huntTip;
  // Original city: the pool hall or gym the search is heading for.
  if (order.huntHallId != null) { const hall = w.buildings[order.huntHallId]; return hall ? buildingDoor(w, hall) : null; }
  const stops = order.huntStopIds ?? [];
  const id = stops.length ? stops[order.cursor % stops.length] : undefined;
  const b = id != null ? w.buildings[id] : null;
  return b ? buildingDoor(w, b) : null;
}

/**
 * Hunting a man nobody has placed, as the manual has it (p37): the hoods go
 * round the pool halls and gyms asking the unattached hoods there; the more
 * intelligent and intimidating they are, the faster they get an answer and
 * the more accurate it is. An answer is where he was seen: they go there and
 * find him if he is in sight, or take up the round again.
 */
const HUNT_SIGHT = 30;
/** How far out a tip can be, in metres, from the dullest crew (a sharp crew is told exactly). */
const HUNT_TIP_ERROR = 100;
const huntSharpness = (actors: Person[]) => starFactor(actorSkill(actors, ['intelligence', 'intimidation']));
/** Minutes asking at one stop: an hour and a half for a dull crew, half an hour for a sharp one. */
const huntAskMinutes = (actors: Person[]) => Math.round(90 - 60 * huntSharpness(actors));

// ---------------------------------------------------------------- estimation

/** Minutes spent asking around at one pool hall or gym. */
const HUNT_MINUTES_PER_STOP = 60;

export function estimateMinutes(w: WorldState, team: Team, order: Order): number {
  const def = ORDERS[order.type];
  // A standing order ties up its hoods for the week, not the whole crew: it
  // costs the crew's week in proportion to the men it takes.
  if (def.wholeWeek) {
    const bodies = crewPeople(w, team).filter(p => readyForPlanning(w, p)).length;
    return Math.round((MINUTES_PER_WEEK * Math.max(1, order.opts.manpower)) / Math.max(1, bodies));
  }

  const manpower = Math.max(1, order.opts.manpower);
  const candidates=orderStaffing(w,team,order,w.phase==='planning').chosen;
  const speed=plannedTravelSpeed(w,team,candidates,order.type);
  const lt = w.people[team.lieutenantId];
  const efficiency = lt ? 1.35 - starFactor(skillAvg(lt, ['organization', 'intelligence'])) * 0.4 : 1.2;

  let targets = 1;
  if (def.target === 'area') targets = Math.max(1, order.targetBuildingIds.length);

  let work = def.minutesPerTarget * targets * efficiency;

  // Travel: rough march from the office through the targets.
  const office = nearestOffice(w, order.gangId, w.blocks[0].center);
  let travel = 0;
  let cur: Vec2 | null = office ? w.lots[office.lotId].center : null;
  const list = def.target === 'area' ? order.targetBuildingIds : order.targetBuildingIds.slice(0, 1);
  for (const id of list) {
    const b = w.buildings[id];
    if (!b) continue;
    const p = w.lots[b.lotId].center;
    if (cur) travel += dist(cur, p);
    cur = p;
  }
  if (order.type === 'export' && cur) {
    const terminal = nearestExportTerminal(w, cur);
    const stock=w.buildings[order.targetBuildingIds[0]]?.stock;
    const capacity=Math.max(1,transportPlan(w,team,candidates,order.type).cars.filter(c=>c.kind==='truck').length)*VEHICLES.truck.cargo;
    const trips=Math.max(1,Math.ceil(Object.values(stock??{}).reduce((n,v)=>n+v,0)/capacity));
    if (terminal) travel += dist(cur, buildingDoor(w, terminal))*(trips*2-1);
    work*=trips;
  }
  if (def.target === 'person' && order.targetPersonId != null) {
    const p = w.people[order.targetPersonId];
    if (p && cur) travel += dist(cur, p.pos) * 1.6; // they have to be found first
  }
  if (def.target === 'point' && order.targetPos && cur) travel += dist(cur, order.targetPos);
  // Asking around takes time at every stop, and the walking between them.
  let hunt = 0;
  if (order.hunting && order.huntStopIds?.length) {
    let from = cur;
    // The plan books the first few stops of the round.
    for (const id of order.huntStopIds.slice(0, 3)) {
      const b = w.buildings[id];
      if (!b) continue;
      const p = w.lots[b.lotId].center;
      if (from) hunt += dist(from, p) / speed;
      from = p;
      hunt += HUNT_MINUTES_PER_STOP;
    }
  }

  return Math.round(work / manpower + travel / speed + hunt);
}

// ---------------------------------------------------------------- week start

function waitForDispatch(w: WorldState, order: Order, reason: string): false {
  if (order.dispatchWaitReason == null)
    report(w, order.gangId, 'waiting', `${ORDERS[order.type].name} is queued: ${reason}`);
  order.dispatchWaitReason = reason;
  return false;
}

function assignOrder(w: WorldState, team: Team, order: Order, atWeekStart = false): boolean {
  if(order.type==='export'){
    if(!team.vehicles.truck){finishOrder(w,order,'Export needs a truck allocated to this crew.');return false;}
    if(!availableVehicle(w,team,'truck'))return waitForDispatch(w, order, 'Waiting for an available truck.');
  }
  const { chosen, reason, impossible } = orderStaffing(w, team, order);
  if (reason) {
    if (impossible) { finishOrder(w, order, reason); return false; }
    return waitForDispatch(w, order, reason);
  }

  order.assignedIds = chosen.map((p) => p.id);
  delete order.dispatchWaitReason;
  // The hunt is planned again as the crew sets out: the gang may have learnt
  // where he is since it was ordered (a snitch, an interrogation).
  if (ORDERS[order.type].target === 'person' && order.targetPersonId != null) {
    const target = w.people[order.targetPersonId], gang = w.gangs[order.gangId];
    const unknown = !!target && !!gang && whereaboutsUnknown(gang, target);
    if (unknown !== !!order.hunting) {
      order.hunting = unknown;
      if (unknown) order.huntStopIds = huntStops(w, order.gangId); else delete order.huntStopIds;
      order.cursor = 0;
    }
    delete order.huntAsking;
    // Original city: the search sets out afresh (0x565B00 → 0x5DE990 state 0 → 1).
    if (order.hunting && w.cityLayout?.original && target && chosen.length) startOriginalHunt(w, order, chosen[0], target);
    else { delete order.huntHallId; delete order.huntLeg; delete order.huntVisitedIds; }
  }
  order.reportedCrewSize = chosen.length;
  order.workedMinutes = 0;
  for (const p of chosen) p.orderId = order.id;
  order.state = 'travelling';
  order.cursor = 0;
  order.completedTargets = 0;
  order.results = [];
  order.failReason = null;
  delete order.waitReleased;
  delete order.waitResumeState;

  const tp = targetPos(w, order);
  for (const p of chosen) {
    // At the start of the week a hood sets out from the office closest to
    // his first job, as the original had it.
    if (atWeekStart && tp) {
      const office = nearestOffice(w, order.gangId, tp);
      if (office) {
        p.pos = buildingDoor(w, office);
      }
    }
  }
  if(tp)allocateTransport(w,team,chosen,tp,order.id,order.type);
  return true;
}

/** Called when the working week begins: hand every queued order its hoods. */
export function beginWeekOrders(w: WorldState): void {
  resetWeekTransport(w);
  for(const p of Object.values(w.people))if(p.gangId!=null&&['hood','lieutenant'].includes(p.role)&&p.buildingId==null&&!p.vehicleKey){clearDestination(p);p.streetOrder=null;p.inVehicle=false;}
  for (const team of Object.values(w.teams)) {
    for (const oid of team.orderIds) {
      const order = w.orders[oid];
      if (!order || order.state === 'cancelled') continue;
      order.state = 'queued';
      order.assignedIds = [];
    }
  }
  for (const p of peopleList(w)) p.orderId = null;

  for (const team of Object.values(w.teams)) {
    for (const oid of team.orderIds) {
      const order = w.orders[oid];
      if (!order || order.state !== 'queued') continue;
      assignOrder(w, team, order, true);
    }
  }
}

// ---------------------------------------------------------------- tick

/** A street order finished: its men go back to the planned order it interrupted. */
function rejoinPlannedOrders(w: WorldState): void {
  for (const p of peopleList(w)) {
    if (p.resumeOrderId == null || p.streetOrder) continue;
    const order = w.orders[p.resumeOrderId];
    delete p.resumeOrderId;
    if (p.status !== 'active' || p.orderId != null || !order || !order.assignedIds.includes(p.id) ||
      !['travelling', 'executing', 'waiting'].includes(order.state)) continue;
    p.orderId = order.id;
    const tp = targetPos(w, order);
    if (!tp || order.state === 'waiting') continue;
    // Back on his own, he walks to the job before the work goes on.
    if (order.state === 'executing' && !ORDERS[order.type].wholeWeek && orderActors(w, order).length === 1) order.state = 'travelling';
    setDestination(w, p, tp);
  }
}

/** Someone taken off this order for a street order is still coming back to it. */
const awaitingStreetCrew = (w: WorldState, order: Order) =>
  order.assignedIds.some((id) => w.people[id]?.resumeOrderId === order.id && w.people[id].status === 'active');

export function tickOrders(w: WorldState, rng: Rng, minutes: number, loadout: Loadout = allocateWeapons(w)): void {
  reconcileTransport(w);
  rejoinPlannedOrders(w);
  for (const team of Object.values(w.teams)) {
    let freedSomething = false;

    for (const oid of team.orderIds) {
      const order = w.orders[oid];
      if (!order) continue;
      if (w.targetRace) return;
      if (order.state === 'done' || order.state === 'failed' || order.state === 'cancelled') continue;
      if (order.state === 'queued') continue;

      const actors = orderActors(w, order);
      if (!actors.length && awaitingStreetCrew(w, order)) continue;
      if (!actors.length) {
        recoverExportGoods(w, order, true);
        finishOrder(w, order, order.failReason ?? 'Nobody was left to carry out the order.');
        freedSomething = true;
        continue;
      }

      if (actors.length < (order.reportedCrewSize ?? order.opts.manpower)) {
        const message = `${ORDERS[order.type].name}: continuing with ${actors.length} of ${order.reportedCrewSize ?? order.opts.manpower} people; the others are unavailable.`;
        order.results.push(message);
        report(w, order.gangId, 'waiting', message, actors[0].pos, actors[0].id);
      }
      order.reportedCrewSize = actors.length;

      const def = ORDERS[order.type];
      if(order.exportDelivery)refreshExportCargo(w,order);
      if(order.exportDelivery&&!goodsTotal(order.exportDelivery.goods)){
        finishOrder(w,order,'The export truck is no longer with the couriers.');freedSomething=true;continue;
      }
      if(order.raidDelivery&&order.state!=='waiting'){
        for(const v of cargoVehicles(w,order.id))if(!v.occupantIds.some(id=>order.assignedIds.includes(id)&&w.people[id]?.status==='active'&&w.people[id].inVehicle)){
          v.cargo!.purpose='return';v.cargo!.orderId=null;v.orderId=null;
        }
        const loads=cargoVehicles(w,order.id),goods=emptyGoods();
        if(!loads.length){finishOrder(w,order,'The raid truck is no longer with the couriers.');freedSomething=true;continue;}
        for(const v of loads)for(const k of Object.keys(goods) as (keyof typeof goods)[])goods[k]+=v.cargo!.goods[k];
        const warehouse=cargoWarehouse(w,order.gangId,actors[0].pos,goods);
        if(!warehouse){finishOrder(w,order,'No warehouse has room for the raided goods. The truck will wait for storage.');freedSomething=true;continue;}
        if(warehouse.id!==order.raidDelivery.warehouseId){order.raidDelivery.warehouseId=warehouse.id;order.state='travelling';for(const a of actors)setDestination(w,a,buildingDoor(w,warehouse));}
      }

      if (order.state === 'waiting') {
        for (const a of actors) a.dest = null;
        continue;
      }

      if (order.exportDelivery && !isExportTerminal(w.buildings[order.exportDelivery.terminalId])) {
        const terminal = nearestExportTerminal(w, actors[0].pos);
        if (!terminal) {
          finishOrder(w, order, 'Neither the docks nor the railroad terminal is open.');
          freedSomething = true;
          continue;
        }
        order.exportDelivery.terminalId = terminal.id;
        order.state = 'travelling';
        for (const a of actors) setDestination(w, a, buildingDoor(w, terminal));
        order.results.push(`Export delivery redirected to ${placeName(w, terminal)}.`);
      }

      if (order.state === 'travelling') {
        const tp = targetPos(w, order);
        // Their man shot dead on the way (in a street fight, say): the job is done.
        const quarry = order.type === 'kill' && order.targetPersonId != null ? w.people[order.targetPersonId] : null;
        if (!tp && quarry?.status === 'dead') {
          order.results.push(`${quarry.name} is dead.`);
          order.completedTargets++;
          finishOrder(w, order, null);
          freedSomething = true;
          continue;
        }
        if (!tp) {
          finishOrder(w, order, 'The target could not be found.');
          freedSomething = true;
          continue;
        }
        // Chasing a man who has gone further than a walk: a crew on foot takes
        // a free car after all (it set out on foot when he was near).
        const team = w.teams[order.teamId];
        if (def.target === 'person' && team && actors.every(a => !a.vehicleKey && !a.inVehicle) &&
            actors.some(a => dist(a.pos, tp) > DRIVE_MIN_DISTANCE) && transportPlan(w, team, actors, order.type).cars.length)
          allocateTransport(w, team, actors, tp, order.id, order.type);
        let arrived = 0;
        for (const a of actors) {
          // Chasing a person means re-routing as they move.
          const boarding=a.vehicleKey&&w.vehicleFleet?.[a.vehicleKey]?.boarding;
          if (!boarding && def.target === 'person' && (!a.dest || dist(a.dest, tp) > 12)) setDestination(w, a, tp);
          else if (!boarding && !a.dest && dist(a.pos, tp) > 6) setDestination(w, a, tp);
          if (stepPerson(a, minutes, trafficContext(w)) || !boarding && !a.inVehicle && dist(a.pos, tp) <= 6) arrived++;
        }
        if (order.hunting) {
          // Whoever they are looking for may die meanwhile (another crew, a
          // street fight): a killing is then done, anything else has no one to do.
          const target = order.targetPersonId != null ? w.people[order.targetPersonId] : null;
          if (target?.status === 'dead') {
            order.results.push(`${target.name} is dead.`);
            if (order.type === 'kill') order.completedTargets++;
            finishOrder(w, order, order.type === 'kill' ? null : `${target.name} is dead.`);
            freedSomething = true;
            continue;
          }
          if (!target) {
            finishOrder(w, order, 'The target could not be found.');
            freedSomething = true;
            continue;
          }
          // Seen: on the way round, or where the tip sent them. Original city:
          // the sighting roll on the look beat, or the gang has learnt of him.
          if (w.cityLayout?.original ? !!originalHuntFinds(w, rng, order, actors, target)
            : onTheStreet(target) && actors.some(a => dist(a.pos, target.pos) <= HUNT_SIGHT)) {
            const gang = w.gangs[order.gangId];
            if (gang && !gang.knownPeople.includes(target.id)) gang.knownPeople.push(target.id);
            order.hunting = false;
            order.cursor = 0;
            delete order.huntTip; delete order.huntAsking; delete order.huntHallId; delete order.huntLeg;
            report(w, order.gangId, 'waiting', `${actors[0].name} has found ${target.name}.`, actors[0].pos, actors[0].id);
            for (const a of actors) setDestination(w, a, target.pos);
            continue;
          }
        }
        if (arrived === actors.length && order.hunting) {
          const target = w.people[order.targetPersonId!];
          const next = () => { order.cursor++; const at = huntPos(w, order); for (const a of actors) if (at) setDestination(w, a, at); };
          // Original city: ask at once at a pool hall or gym, or take the next
          // leg (systems/originalHunt.ts); no asking time and no blurred tip.
          if (w.cityLayout?.original) {
            const news = originalHuntArrived(w, order, actors, target);
            if (news) report(w, order.gangId, 'waiting', news, actors[0].pos, actors[0].id);
            const at = huntPos(w, order);
            for (const a of actors) if (at) setDestination(w, a, at);
            continue;
          }
          // Where the tip said, and he is not in sight: the trail has gone cold.
          if (order.huntTip) { delete order.huntTip; next(); continue; }
          // The unattached hoods about the place are the ones who talk (looked for on arrival).
          if (order.huntAsking === undefined) {
            const stops = order.huntStopIds ?? [];
            const stop = w.buildings[stops[order.cursor % stops.length]];
            if (!stop || !peopleList(w).some(p => p.status === 'active' && p.role === 'hood' && p.gangId == null && p.buildingId === stop.id)) { next(); continue; }
          }
          order.huntAsking = (order.huntAsking ?? huntAskMinutes(actors)) - minutes;
          if (order.huntAsking > 0) continue;
          delete order.huntAsking;
          if (roll(rng, actors, ['intelligence', 'intimidation'], 0.35)) {
            // Where he was seen, as near as they could say.
            const out = rng.range(0, (1 - huntSharpness(actors)) * HUNT_TIP_ERROR), angle = rng.range(0, Math.PI * 2);
            order.huntTip = { x: target.pos.x + Math.cos(angle) * out, y: target.pos.y + Math.sin(angle) * out };
            report(w, order.gangId, 'waiting', `${actors[0].name} heard where ${target.name} was seen.`, actors[0].pos, actors[0].id);
            for (const a of actors) setDestination(w, a, order.huntTip);
          } else next();
          continue;
        }
        if (arrived === actors.length) {
          // Close enough counts as there: he stops where he is rather than
          // keep a route nothing walks him along while they work.
          // (Standing orders walk their own rounds, to the exact spot.)
          if (!def.wholeWeek) for (const a of actors) if (!a.inVehicle && a.dest) clearDestination(a);
          // Catching up with a man they had started on, the work done stands.
          if (!(def.target === 'person' && order.workLeft > 0)) order.workLeft = workForTarget(w, order, actors);
          if (order.opts.wait && !order.waitReleased) {
            order.waitResumeState = 'executing';
            order.state = 'waiting';
            report(
              w,
              order.gangId,
              'waiting',
              `${actors[0].name} is in position and waiting for the word.`,
              actors[0].pos,
              actors[0].id,
            );
          } else {
            order.state = 'executing';
          }
        }
        continue;
      }

      if (order.state === 'executing') {
        if (def.wholeWeek) {
          if (order.workedMinutes != null) order.workedMinutes = Math.min(MINUTES_PER_WEEK, order.workedMinutes + minutes);
          tickStandingOrder(w, rng, order, actors, minutes, loadout);
          continue;
        }
        // A man who walks off while they work is followed, not hit from across
        // town. (One standing still is where they found him, even if a car
        // left them at the kerb some way from his counter.)
        if (def.target === 'person') {
          const victim = order.targetPersonId != null ? w.people[order.targetPersonId] : null;
          if (victim && onTheStreet(victim) && victim.dest && dist(actors[0].pos, victim.pos) > 12) {
            order.state = 'travelling';
            for (const a of actors) setDestination(w, a, victim.pos);
            continue;
          }
        }
        order.workLeft -= actors.length * minutes;
        if (order.workLeft <= 0) {
          const missed = resolveTarget(w, rng, team, order, actors, loadout);
          const resolvedState = order.state as Order['state'];
          // Loading starts a second journey. It is not a completed export and
          // must retain its warehouse cursor until the terminal has been paid.
          if (resolvedState === 'travelling') continue;
          // A raid or an export counted when it paid (before its delivery) is not counted twice.
          if (resolvedState !== 'failed' && !order.targetPaid && !missed) order.completedTargets++;
          delete order.targetPaid;
          if (missed) order.lastMiss = missed;
          order.cursor++;
          const more =
            def.target === 'area' && order.cursor < order.targetBuildingIds.length;
          if (more && order.state === 'executing') {
            order.state = 'travelling';
            const tp = targetPos(w, order);
            for (const a of actors) if (tp) setDestination(w, a, tp);
          } else if (order.state === 'executing') {
            // Nothing came of it (every attempt refused, botched or escaped): failed.
            finishOrder(w, order, order.completedTargets > 0 ? null : order.lastMiss ?? 'Nothing came of it.');
            freedSomething = true;
          } else {
            freedSomething = true;
          }
        }
      }
    }

    if (w.targetRace) return;
    if (freedSomething || team.orderIds.some(id=>w.orders[id]?.state==='queued')) {
      for (const oid of team.orderIds) {
        const order = w.orders[oid];
        if (order && order.state === 'queued') assignOrder(w, team, order);
      }
    }
  }
}

function workForTarget(w: WorldState, order: Order, actors: Person[]): number {
  if(order.raidDelivery)return 10;
  const def = ORDERS[order.type];
  const skill = starFactor(actorSkill(actors, def.skills));
  void w;
  // Keep the original total work allowance, divided between loading and sale.
  const stage = order.type === 'export' ? (order.exportDelivery ? 0.25 : 0.75) : 1;
  return Math.max(20, def.minutesPerTarget * (1.35 - skill * 0.5) * stage);
}

export function releaseGuardPost(w: WorldState, personId: ID): void {
  for (const b of buildingList(w)) if (b.guardIds.includes(personId))
    b.guardIds = b.guardIds.filter(id => id !== personId);
}

/** A closed site must not regain stale guards on the following tick. */
export function stopBusinessGuards(w: WorldState, b: Building, reason: string): void {
  for (const order of Object.values(w.orders)) {
    if (order.type === 'guardBusiness' && order.targetBuildingIds.includes(b.id) &&
        order.state !== 'done' && order.state !== 'failed') finishOrder(w,order,reason);
  }
  b.guardIds = [];
}

/** An ambush has fulfilled its order once its crew kills a rival at the post. */
export function completeAmbush(w: WorldState, actor: Person, victim: Person): void {
  const order = actor.orderId == null ? null : w.orders[actor.orderId];
  if (order?.type !== 'ambush' || order.state !== 'executing') return;
  order.completedTargets++;
  order.results.push(`Ambushed ${victim.name}. The crew is returning to headquarters.`);
  finishOrder(w, order, null);
}

/** Guards actually on the door: the gang's men still free, and one police
 *  watch at most (a guard arrested or taken stayed on the list all week). */
function standingGuards(w: WorldState, b: Building): number {
  let n = b.guardIds.includes(-1) ? 1 : 0;
  for (const id of b.guardIds) if (id !== -1 && w.people[id]?.status === 'active') n++;
  return n;
}

function finishOrder(w: WorldState, order: Order, failReason: string | null): void {
  releaseTransportOrder(w,order.id);
  if (failReason) recoverExportGoods(w, order);
  // Cut short after part of it was done (a raid's haul taken, an export load
  // sold): partly done, as at the week's end, not failed.
  const partly = !!failReason && order.completedTargets > 0;
  order.state = failReason && !partly ? 'failed' : 'done';
  order.failReason = failReason;
  delete order.dispatchWaitReason;
  delete order.ambushTargetId;
  delete order.targetPaid;
  if (failReason) {
    report(w, order.gangId, 'failed', `${partly ? 'Order cut short' : 'Order failed'}: ${ORDERS[order.type].name} — ${failReason}`);
  }
  for (const id of order.assignedIds) {
    const p = w.people[id];
    if (!p || p.orderId !== order.id) continue;
    if (order.type === 'guardBusiness') releaseGuardPost(w, p.id);
    p.orderId = null;
    if (p.status === 'active' && p.buildingId == null) {
      sendHome(w,p);
    }
  }
  order.assignedIds = [];
}

/** Patrol, guard, ambush and go-to: they occupy the whole week. */
function tickStandingOrder(
  w: WorldState,
  rng: Rng,
  order: Order,
  actors: Person[],
  minutes: number,
  loadout: Loadout,
): void {
  switch (order.type) {
    case 'patrol':
    case 'ambush': {
      if (order.type === 'ambush' && order.ambushTargetId != null) {
        const target = w.people[order.ambushTargetId];
        if (target?.status === 'dead') {
          order.completedTargets++;
          order.results.push(`${target.name} is dead. The ambush crew is returning to headquarters.`);
          finishOrder(w, order, null);
          return;
        }
        if (validAmbushTarget(w, order, target)) {
          for (const a of actors) {
            if (dist(a.pos, target.pos) <= attackProfile(loadout, a).spec.range) clearDestination(a);
            else {
              // Finish the current route before retargeting, avoiding the
              // pavement-junction restart bug of resetting a path every tick.
              if (!a.dest) setDestination(w, a, target.pos);
              stepPerson(a, minutes, trafficContext(w));
            }
          }
          return;
        }
        delete order.ambushTargetId;
        for (const a of actors) clearDestination(a);
      }
      for (const a of actors) {
        if (!a.dest) {
          order.cursor++;
          const tp = targetPos(w, order);
          if (tp) {
            const blocks = standingBlocks(w, order);
            const block = w.blocks[blocks[order.cursor % Math.max(1, blocks.length)]];
            setDestination(w, a, w.cityLayout && block ? blockPavement(block, rng.int(0, 100000)) :
              { x: tp.x + rng.range(-14, 14), y: tp.y + rng.range(-14, 14) });
          }
        } else {
          stepPerson(a, minutes, trafficContext(w));
        }
      }
      if (order.type === 'patrol' && rng.chance(0.004 * minutes)) {
        // Visible protection reassures the neighbourhood.
        for (const blockId of standingBlocks(w, order)) {
          const blk = w.blocks[blockId];
          if (!blk) continue;
          blk.crimeHeat = Math.max(0, blk.crimeHeat - 0.6);
          shiftLocalOpinion(w, blk.center, 40, order.gangId, 0.5);
        }
      }
      break;
    }
    case 'guardBusiness': {
      const bId = order.targetBuildingIds[0];
      const b = bId != null ? w.buildings[bId] : null;
      if (!b || b.state === 'destroyed' || b.ownerGangId !== order.gangId) {
        finishOrder(w, order, 'The site is gone.');
        return;
      }
      const door = buildingDoor(w, b);
      for (const a of actors) {
        // The car reaches the road beside the shop. The guard must finish the
        // journey on foot to reach the doorway and actually protect the site.
        if (a.inVehicle) { dismount(w,a); clearDestination(a); }
        if (dist(a.pos, door) > 5) {
          if (!a.dest) setDestination(w, a, door);
          stepPerson(a, minutes, trafficContext(w));
        } else if (!b.guardIds.includes(a.id)) {
          b.guardIds.push(a.id);
        }
        if (b.guardIds.includes(a.id) && b.hidesId != null) {
          const hidden = w.buildings[b.hidesId];
          if (hidden && !hidden.guardIds.includes(a.id)) hidden.guardIds.push(a.id);
        }
      }
      break;
    }
    case 'goTo': {
      for (const a of actors) if (a.dest) stepPerson(a, minutes, trafficContext(w));
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- resolution

function assignManager(w: WorldState, team: Team, building: Building, actors: Person[]): void {
  // The lieutenant sends whoever is best with a ledger — but never himself: he
  // is not one of his own crew, and putting him behind a counter would leave
  // them with nobody to take orders from.
  // Assignment already chose the best available hoods. Do not draw again from
  // the whole crew: that can rehire the outgoing manager or steal a hood who
  // is still executing a different order.
  const pool = actors.filter(
    (p): p is Person =>
      !!p && p.status === 'active' && p.buildingId == null && p.id !== team.lieutenantId,
  );
  if (!pool.length) return;
  pool.sort(
    (a, b) => b.skills.business + b.skills.organization - (a.skills.business + a.skills.organization),
  );
  const mgr = pool[0];
  const idx = team.memberIds.indexOf(mgr.id);
  if (idx >= 0) team.memberIds.splice(idx, 1);
  mgr.teamId = null;
  mgr.orderId = null;
  mgr.buildingId = building.id;
  dismount(w,mgr);
  mgr.pos = { ...w.lots[building.lotId].center };
  mgr.dest = null;
  mgr.path = [];
  building.managerId = mgr.id;
}

/** Arm's length between an actor and the person they are dealing with (metres). */
/** Arm's length for people drawn at 1.3× (render CHARACTER_SCALE): 0.9 m at
 * modelled size, so a punch lands without the figures overlapping. */
export const CONTACT_DISTANCE = .9 * 1.3;

/** Face-to-face work never happens inside the other person: anyone closer than
 * arm's length steps back along their approach (or a fixed bearing if they
 * are exactly on top), so strikes, reactions and falls read on screen. */
export function keepContactDistance(actors: readonly Person[], target: Person): void {
  if (target.inVehicle) return;
  for (const a of actors) {
    if (a === target || a.inVehicle || dist(a.pos, target.pos) >= CONTACT_DISTANCE - .1) continue;
    const dx = a.pos.x - target.pos.x, dy = a.pos.y - target.pos.y, d = Math.hypot(dx, dy);
    const angle = d > 1e-3 ? Math.atan2(dy, dx) : (a.id % 8) * Math.PI / 4;
    a.pos = { x: target.pos.x + Math.cos(angle) * CONTACT_DISTANCE, y: target.pos.y + Math.sin(angle) * CONTACT_DISTANCE };
  }
}

/** 0x4DE430 called by the assault and kill handlers with the victim: the area
 * is his block, at the default radius (only bomb, smash-up and torch set the
 * centre-lot flag). Original city. */
function blastAtVictim(w: WorldState, gangId: ID, victim: Person, damage: number): void {
  const blockId = blockAtPos(w, victim.pos);
  if (blockId != null) blastFear(w, gangId, { blockId, ownerPersonId: victim.id }, damage);
}

function resolveTarget(
  w: WorldState,
  rng: Rng,
  team: Team,
  order: Order,
  actors: Person[],
  loadout: Loadout,
): string | null | void {
  const gang = w.gangs[order.gangId];
  if (!gang) return;
  const def = ORDERS[order.type];
  const lead = actors[0];
  const bId = order.targetBuildingIds[order.cursor];
  const building = bId != null ? w.buildings[bId] : null;
  const victim = order.targetPersonId != null ? w.people[order.targetPersonId] : null;
  // Killed, arrested or carried off by somebody else while the crew worked:
  // there is nobody left to bribe, beat, take or shoot (a corpse was beaten
  // back to life, a prisoner taken twice).
  if (order.type === 'kill' && victim?.status === 'dead') { order.results.push(`${victim.name} is already dead.`); return; }
  if (def.target === 'person' && (!victim || !onTheStreet(victim))) return finishOrder(w, order, 'The target could not be found.');
  const here = building ? w.lots[building.lotId].center : lead.pos;
  if (victim) keepContactDistance(actors, victim);

  const say = (s: string) => order.results.push(s);
  // The attempt failed (refused, botched, got away): reported, and returned so
  // the job is not counted done for it.
  let missed: string | null = null;
  const miss = (s: string) => { order.results.push(s); missed = s; };

  switch (order.type) {
    // -------------------------------------------------- business
    case 'buyPremises': {
      if (!building) return finishOrder(w, order, 'No such site.');
      if (building.ownerGangId != null) return finishOrder(w, order, 'Somebody else already owns it.');
      if (building.state === 'destroyed' || !purchasablePremisesType(building))
        return finishOrder(w, order, 'Those premises are no longer available to buy.');
      const cost = buildingValue(w, building);
      if (!spend(w, gang, cost, 'capital')) return finishOrder(w, order, 'You could not cover the asking price.');
      building.acquisitionCost = cost;
      // 0x4CC8F0: the occupant who sold halves their hostility toward the
      // buyer and loses 64 fear of it.
      const seller = building.ownerPersonId != null ? w.people[building.ownerPersonId] : null;
      if (seller) setAttitude(seller, gang.id, { hostility: hostilityOf(seller, gang.id) >> 1, fear: fearOf(seller, gang.id) - 64 });
      building.ownerGangId = gang.id;
      // One controller per site: buying the premises ends any racket on them.
      building.protection = null;
      building.knowledge[gang.id] = 4;
      if (building.cls !== 'empty' && building.state !== 'damaged' && building.fbiClosedWeek == null) {
        building.state = 'trading';
        assignManager(w, team, building, actors);
      }
      say(`Bought ${placeName(w, building)} for $${cost.toLocaleString('en-US')}.`);
      reportBusinessMove(w, gang.id, building, 'bought');
      report(w, gang.id, 'waiting', `Acquired ${placeName(w, building)}.`, here, lead.id);
      break;
    }

    case 'setUpBusiness': {
      if (!building) return finishOrder(w, order, 'No such site.');
      if (building.discovered || building.fbiClosedWeek != null) return finishOrder(w,order,'Shut down the operation found by the FBI before rebuilding.');
      if (building.ownerGangId !== gang.id) return finishOrder(w, order, 'You do not own that land.');
      const typeId = order.opts.businessTypeId;
      const t = typeId ? BUILDING_BY_ID[typeId] : null;
      if (!t) return finishOrder(w, order, 'No business type was chosen.');
      const lot = w.lots[building.lotId];
      if (t.cls === 'illegal' && lot.index !== CENTRE_LOT)
        return finishOrder(w, order, 'Illegal businesses can only occupy the centre of a block.');
      if (t.cls !== 'illegal' && lot.index === CENTRE_LOT)
        return finishOrder(w, order, 'Only illegal businesses belong in the centre of a block.');
      if (t.cls === 'municipal') return finishOrder(w, order, 'Only the city builds those.');

      let front: Building | null = null;
      if (t.cls === 'illegal') {
        const fId = order.opts.frontBuildingId;
        front = fId != null ? w.buildings[fId] : null;
        if (!front || front.ownerGangId !== gang.id || front.blockId !== building.blockId)
          return finishOrder(w, order, 'That illegal business has no front on the block.');
        if (front.hidesId != null && front.hidesId !== building.id)
          return finishOrder(w, order, 'That front already hides another operation.');
      }
      if (!spend(w, gang, t.cost, 'capital')) return finishOrder(w, order, 'You could not afford the fit-out.');
      building.acquisitionCost = (building.acquisitionCost ?? buildingValue(w, building)) + t.cost;

      building.typeId = t.id;
      building.cls = t.cls;
      resetBusinessInvestigation(w,building);
      forgetWhatWasThere(building, gang.id);
      delete building.ceasedWeek; delete building.resumeTradingWeek;
      building.state = 'trading';
      delete building.fireWeek;
      delete building.repairCompleteWeek;
      building.stock = { liquor: 0, stolen: 0, counterfeit: 0 };
      if (front) {
        building.frontId = front.id;
        front.hidesId = building.id;
        building.cover = coverQuality(t.id, front.typeId);
      }
      assignManager(w, team, building, actors);
      say(`Opened a ${t.name}.`);
      reportBusinessMove(w, gang.id, building, 'established');
      report(w, gang.id, 'waiting', `Opened a ${t.name}.`, here, lead.id);
      break;
    }

    case 'runBusiness': {
      if (!building || building.ownerGangId !== gang.id)
        return finishOrder(w, order, 'That is not one of your sites.');
      if (building.fbiClosedWeek != null) return finishOrder(w,order,'The business was closed by the FBI.');
      if (building.managerId != null) {
        const old = w.people[building.managerId];
        if (old) {
          old.buildingId = null;
          old.pos=buildingDoor(w,building);
          sendHome(w,old);
          if (team.memberIds.length < 9) {
            team.memberIds.push(old.id);
            old.teamId = team.id;
          } else {
            gang.poolIds.push(old.id);
          }
        }
        building.managerId = null;
      }
      assignManager(w, team, building, actors);
      say(`New management installed at ${placeName(w, building)}.`);
      break;
    }

    case 'collectProtection': {
      if (!building || building.protection?.gangId !== gang.id) return;
      if (building.state !== 'trading') {
        miss(`${placeName(w, building)} is closed — nothing to collect.`);
        return;
      }
      // 0x4CD730, original city: a shopkeeper whose effective hostility
      // ((hostility − fear + 256) >> 1) is 180 or more refuses outright and
      // grows 16 more hostile.
      const payer = building.ownerPersonId != null ? w.people[building.ownerPersonId] : null;
      const hostile = !!w.cityLayout?.original && !!payer && payer.status !== 'dead' && effectiveHostility(payer, gang.id) >= 180;
      if (hostile) shiftAttitude(payer!, gang.id, 16, 0);
      if (building.protection.refusing || hostile) {
        // 0x4CD730 marks the cell refused (flag 8), which stops this week's
        // fear fade in weeklyProtectionFear.
        building.protection.refusedWeek = w.week;
        miss(`${w.people[building.ownerPersonId ?? -1]?.name ?? 'The owner'} refused to pay.`);
        // The till-short branch (not the outright refusal) is where the original
        // owner squeals: squeal level above 200 files a record, +5 evidence.
        if (!hostile && payer && w.cityLayout?.original) squealIfAbove200(w, gang, payer, building, here, lead.id);
        report(
          w,
          gang.id,
          'failed',
          `${placeName(w, building)} refused to pay protection.`,
          here,
          lead.id,
        );
        return;
      }
      if (building.protection.collectedWeek === w.week) {
        miss(`${placeName(w, building)} has already paid this week.`);
        return;
      }
      const take = building.protection.weekly;
      building.protection.collectedWeek = w.week;
      receiveOrderCash(w, gang, order, 'protection', take);
      building.protection.grievance = Math.max(0, building.protection.grievance - 0.4);
      say(`Collected $${take.toLocaleString('en-US')} from ${placeName(w, building)}.`);
      break;
    }

    case 'adjustProtection': {
      if (!building || building.protection?.gangId !== gang.id) return;
      const level = order.opts.protectionLevel ?? 1;
      const newWeekly = Math.round(building.protection.base * Math.max(0, Math.min(2, level)));
      const owner = building.ownerPersonId != null ? w.people[building.ownerPersonId] : null;
      const increase = newWeekly - building.protection.weekly;
      building.protection.weekly = newWeekly;
      if (owner) {
        opinionShift(owner, gang.id, -increase / 40, w.cityLayout?.original ? NO_ORIGINAL_CHANNEL : undefined);
        if (increase > 0) building.protection.grievance += increase / building.protection.base;
        else building.protection.grievance = Math.max(0, building.protection.grievance - 1);
      }
      say(`Protection at ${placeName(w, building)} set to $${newWeekly.toLocaleString('en-US')}.`);
      break;
    }

    case 'export': {
      const cargo = order.exportDelivery;
      if (cargo) {
        const terminal = w.buildings[cargo.terminalId];
        if (!isExportTerminal(terminal)) return finishOrder(w, order, 'The export terminal has closed.');
        const gross = Math.round((cargo.goods.liquor * 26 + cargo.goods.stolen * 34 + cargo.goods.counterfeit * 900) * cargo.rate);
        for(const v of cargoVehicles(w,order.id))delete v.cargo;
        delete order.exportDelivery;
        receiveOrderCash(w, gang, order, 'illegal', gross);
        say(`Exported goods through ${placeName(w, terminal)} for $${gross.toLocaleString('en-US')}.`);
        // Done once a load is sold; any trips for the rest follow.
        if (!order.targetPaid) { order.completedTargets++; order.targetPaid = true; }
        const warehouse=w.buildings[cargo.warehouseId];
        if(warehouse?.ownerGangId===gang.id&&warehouse.typeId==='warehouse'&&warehouse.state!=='destroyed'&&
          Object.entries(order.exportPending?.goods??{}).some(([k,n])=>n>0&&warehouse.stock[k as keyof typeof warehouse.stock]>0)){
          order.state='travelling';for(const a of actors)setDestination(w,a,buildingDoor(w,warehouse));
          say('Returning for the remaining export goods.');
        }else delete order.exportPending;
        break;
      }
      if (!building || building.ownerGangId !== gang.id || building.typeId !== 'warehouse' || building.state === 'destroyed')
        return finishOrder(w, order, 'You need a warehouse of your own to export from.');
      const terminal = nearestExportTerminal(w, buildingDoor(w, building));
      if (!terminal) return finishOrder(w, order, 'Neither the docks nor the railroad terminal is open.');
      const trucks=orderVehicles(w,actors).filter(v=>v.kind==='truck');
      if(!trucks.length)return finishOrder(w,order,'No truck reached the warehouse. Export was cancelled.');
      const rate = 1;
      const liquor = building.stock.liquor;
      const stolen = building.stock.stolen;
      const counterfeit = building.stock.counterfeit;
      const gross = Math.round((liquor * 26 + stolen * 34 + counterfeit * 900) * rate);
      if (gross <= 0) {
        // Back for the rest, and somebody had emptied it meanwhile: what was sold stands.
        if (order.targetPaid) { say('Nothing was left to export.'); delete order.exportPending; break; }
        return finishOrder(w, order, 'The warehouse was empty.');
      }
      let room=trucks.length*VEHICLES.truck.cargo;
      order.exportPending??={warehouseId:building.id,goods:{...building.stock}};
      const goods={liquor:0,stolen:0,counterfeit:0};
      for(const kind of ['counterfeit','stolen','liquor'] as const){goods[kind]=Math.min(building.stock[kind],order.exportPending.goods[kind],room);building.stock[kind]-=goods[kind];order.exportPending.goods[kind]-=goods[kind];room-=goods[kind];}
      if(!Object.values(goods).some(n=>n>0))return finishOrder(w,order,'Nobody can carry the export goods.');
      const vehicleKeys=loadCargo(w,order,actors,building,goods,'export');
      order.exportDelivery = { warehouseId: building.id, terminalId: terminal.id, goods, rate, vehicleKeys };
      order.state = 'travelling';
      for (const a of actors) setDestination(w, a, buildingDoor(w, terminal));
      say(`Loaded export goods; delivering to ${placeName(w, terminal)}.`);
      break;
    }

    case 'donate': {
      if (!building || !donationTarget(building)) return finishOrder(w, order, 'No charity there.');
      const blk = w.blocks[building.blockId];
      const amount = order.opts.amount ?? donationAmount(w, building);
      if (!Number.isFinite(amount) || amount <= 0) return finishOrder(w, order, 'No donation was offered.');
      if (!spend(w, gang, amount)) return finishOrder(w, order, 'You could not spare the money.');
      const impact = (amount / 1000) * (1 + blk.squalor / 60);
      shiftLocalOpinion(w, here, 90, gang.id, Math.min(18, impact * 4));
      gang.goodwill = Math.min(40, gang.goodwill + Math.min(4, impact));
      say(`Donated $${amount.toLocaleString('en-US')} to ${placeName(w, building)}.`);
      addNews(w, { section: 'charity', kind: 'donation', buildingId: building.id, amount,
        headline: 'CHARITY THANKS ITS BENEFACTORS',
        body: `${placeName(w, building)} thanked ${gang.name} for a donation of $${amount.toLocaleString('en-US')} to help local families.`,
        gangId: gang.id });
      break;
    }

    // -------------------------------------------------- personnel
    case 'explore': {
      if (!building) return;
      building.knowledge[gang.id] = Math.max(building.knowledge[gang.id] ?? 0, 3);
      // Poking around may turn up somebody else's back room.
      if (building.hidesId != null) {
        const hidden = w.buildings[building.hidesId];
        if (hidden && hidden.ownerGangId !== gang.id) {
          const found = roll(rng, actors, ['stealth', 'intelligence'], 0.35 + hidden.cover * 0.4);
          if (found) {
            hidden.knowledge[gang.id] = 3;
            say(`Found a ${buildingName(w, hidden.id)} behind ${placeName(w, building)}.`);
            report(w, gang.id, 'waiting', `Your hoods uncovered a hidden ${buildingName(w, hidden.id)}.`, here, lead.id);
          }
        }
      }
      if (building.ownerGangId != null && building.ownerGangId !== gang.id) {
        const mgr = building.managerId != null ? w.people[building.managerId] : null;
        if (mgr && !gang.knownPeople.includes(mgr.id)) gang.knownPeople.push(mgr.id);
      }
      // What the scout learned, for the report.
      {
        const holder = building.ownerGangId != null ? w.gangs[building.ownerGangId] : null;
        const payee = building.protection ? w.gangs[building.protection.gangId] : null;
        const standing = holder
          ? `owned by ${holder.id === gang.id ? 'you' : holder.name}`
          : payee
            ? `paying $${building.protection!.weekly.toLocaleString('en-US')} a week to ${payee.id === gang.id ? 'you' : payee.name}`
            : 'paying nobody';
        say(`Looked over ${placeName(w, building)}: ${standing}.`);
      }
      break;
    }

    case 'recruit': {
      if (!building) return;
      const kind = typeOf(building)?.recruit;
      if (!kind) return;
      // Only people of the kind being recruited count, never the owner or staff.
      const seeking = (p: Person, at: number) => p.gangId == null && p.status === 'active' && p.buildingId === at && p.role === kind;
      const candidates = peopleList(w).filter((p) => seeking(p, building.id));
      if (!candidates.length) {
        // Nobody here — but a crew asking around hears where there is somebody.
        const here = w.lots[building.lotId].center;
        const elsewhere = allBuildings(w)
          .filter(
            (b) =>
              b.id !== building.id &&
              b.state === 'trading' &&
              typeOf(b)?.recruit === kind &&
              peopleList(w).some((p) => seeking(p, b.id)),
          )
          .sort((a, b) => dist(w.lots[a.lotId].center, here) - dist(w.lots[b.lotId].center, here))[0];
        say(
          elsewhere
            ? `Nobody worth hiring at ${placeName(w, building)} — word is there are people looking for work at ${placeName(w, elsewhere)}.`
            : `Nobody worth hiring at ${placeName(w, building)}.`,
        );
        return;
      }
      const persuaded = roll(rng, actors, ['intelligence'], 0.25);
      if (!persuaded) {
        miss(`Nobody at ${placeName(w, building)} was interested.`);
        return;
      }
      const take = rng.int(1, Math.min(3, candidates.length));
      let added = 0;
      for (let i = 0; i < take; i++) {
        const c = candidates[i];
        if (!gang.recruitIds.includes(c.id)) { gang.recruitIds.push(c.id); added++; }
      }
      say(added ? `${added} ${kind === 'hood' ? 'hood(s)' : kind + '(s)'} willing to work for you.` : 'Nobody new was willing to work for you.');
      break;
    }

    // -------------------------------------------------- minor crimes
    case 'bribe': {
      if (!victim) return finishOrder(w, order, 'The target could not be found.');
      const cost = order.opts.amount ?? Math.round(300 + victim.skills.intelligence * 260);
      if (!spend(w, gang, cost)) return finishOrder(w, order, 'You could not cover the bribe.');
      if (roll(rng, actors, ['intelligence'], 0.2 + Math.max(0, -(victim.opinion[gang.id] ?? 0)) / 200)) {
        victim.bribedBy = gang.id;
        // No bribe handler writes an attitude channel in the original.
        opinionShift(victim, gang.id, Math.min(100, (victim.opinion[gang.id] ?? 0) + 35) - (victim.opinion[gang.id] ?? 0), NO_ORIGINAL_CHANNEL);
        say(`${victim.name} took the money.`);
      } else {
        opinionShift(victim, gang.id, -10, NO_ORIGINAL_CHANNEL);
        miss(`${victim.name} refused the money.`);
      }
      break;
    }

    case 'intimidate': {
      const target = victim ?? (building?.ownerPersonId != null ? w.people[building.ownerPersonId] : null);
      if (!target) return;
      const success = roll(rng, actors, ['intimidation'], 0.25 + Math.max(0, -(target.opinion[gang.id] ?? 0)) / 220);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'intimidate',
        pos: here,
        buildingId: building?.id ?? null,
        victimId: target.id,
      });
      if (success) {
        if (building?.protection?.gangId === gang.id) {
          building.protection.refusing = false;
          building.protection.grievance = 0;
        }
        // 0x4DE030: a shopkeeper (type 15) is cowed −32 hostility / +32 fear,
        // but only when his premises are no gang's or this gang's (vt+176);
        // civilians and clergy/reporters (types 16, 24, 25) only gain 10 fear.
        const premises = target.buildingId != null ? w.buildings[target.buildingId] : building;
        const premisesGang = premises ? premises.ownerGangId ?? premises.protection?.gangId ?? null : null;
        const cowed = premisesGang == null || premisesGang === gang.id;
        opinionShift(target, gang.id, -6, target.role === 'owner' ? (cowed ? { hostility: -32, fear: 32 } : { hostility: 0, fear: 0 })
          : ['citizen', 'clergy', 'reporter'].includes(target.role) ? { hostility: 0, fear: 10 } : { hostility: 0, fear: 0 });
        // Frightened witnesses forget what they saw.
        for (const c of w.cases ? Object.values(w.cases) : []) {
          const i = c.witnessIds.indexOf(target.id);
          if (i >= 0 && c.gangId === gang.id) c.witnessIds.splice(i, 1);
        }
        say(`${target.name} has seen sense.`);
      } else {
        // A failed roll only flags the target in 0x4DE030; no attitude change.
        opinionShift(target, gang.id, -16, { hostility: 0, fear: 0 });
        miss(`${target.name} would not be moved.`);
      }
      break;
    }

    case 'extort': {
      if (!building) return;
      if (building.protection) {
        miss(`${placeName(w, building)} already pays somebody.`);
        return;
      }
      if (!isValidAreaTarget(w, gang.id, 'extort', building)) {
        miss(`${placeName(w, building)} is no longer available to extort.`);
        return;
      }
      const owner = building.ownerPersonId != null ? w.people[building.ownerPersonId] : null;
      const distance = distanceToTerritory(w, gang.id, here);
      const difficulty =
        0.12 + Math.min(0.5, distance / 900) + Math.max(0, -(owner?.opinion[gang.id] ?? 0)) / 240;
      const success = roll(rng, actors, ['intimidation'], difficulty);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'extort',
        pos: here,
        buildingId: building.id,
        victimId: owner?.id ?? null,
      });
      if (success) {
        const base = protectionBase(w, building);
        building.protection = { gangId: gang.id, weekly: base, base, refusing: false, grievance: 0 };
        building.knowledge[gang.id] = Math.max(building.knowledge[gang.id] ?? 0, 2);
        // Recode reading of the extortion write-back: hostility −16, fear +16.
        if (owner) opinionShift(owner, gang.id, -8, { hostility: -16, fear: 16 });
        say(`${placeName(w, building)} now pays $${base.toLocaleString('en-US')} a week.`);
      } else {
        if (owner) {
          // A refused extortion writes no attitude in 0x4DD9C0; the original only
          // reports when the owner's squeal byte (+0x20) exceeds 200, which the
          // original city follows. The compact cities keep the remake's souring
          // opinion (which makes the next attempt harder) and random squeal.
          if (w.cityLayout?.original) squealIfAbove200(w, gang, owner, building, here, lead.id);
          else {
            opinionShift(owner, gang.id, -18, { hostility: 0, fear: 0 });
            if (rng.chance(0.22)) {
              report(w, gang.id, 'police', `${owner.name} squealed to the police about your hoods.`, here, lead.id);
              gang.evidence = Math.min(100, gang.evidence + 3);
            }
          }
        }
        miss(`${placeName(w, building)} refused your protection.`);
      }
      break;
    }

    case 'raid': {
      if(order.raidDelivery){
        const warehouse=w.buildings[order.raidDelivery.warehouseId];
        for(const v of cargoVehicles(w,order.id))if(warehouse)unloadCargo(w,v,warehouse);
        if(cargoVehicles(w,order.id).length){order.state='travelling';return;}
        delete order.raidDelivery;say('The raided goods reached the warehouse.');break;
      }
      if (!building) return;
      if (building.state === 'destroyed') return finishOrder(w, order, 'The site is gone.');
      if (building.state !== 'trading') return finishOrder(w, order, `${placeName(w, building)} is shut; there was nothing worth taking.`);
      const t = typeOf(building);
      const blk = w.blocks[building.blockId];
      const success = roll(rng, actors, ['stealth', 'firearms'], 0.28 + standingGuards(w, building) * 0.12);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'raid',
        pos: here,
        buildingId: building.id,
      });
      if (success) {
        const haul = Math.round(((t?.profit ?? 200) * 1.6 + blk.landValue * 12) * rng.range(0.6, 1.5));
        receiveOrderCash(w, gang, order, 'other', haul);
        say(`Raided ${placeName(w, building)} for $${haul.toLocaleString('en-US')}.`);
        // Done once the haul is taken; delivering the goods follows.
        order.completedTargets++;
        order.targetPaid = true;

        // With a truck the goods go too.
        if (orderVehicles(w,actors).some(v=>v.kind==='truck') && t?.stores?.length) {
          const kind = rng.pick(t.stores);
          const desired = rng.int(10, 40);
          const tracked=building.typeId==='warehouse'||building.cls==='illegal'||building.stock[kind]>0;
          const amount = Math.min(desired,tracked?building.stock[kind]:desired,
            orderVehicles(w,actors).filter(v=>v.kind==='truck'&&!v.cargo).length*VEHICLES.truck.cargo);
          const goods={...emptyGoods(),[kind]:amount};
          const store=cargoWarehouse(w,gang.id,lead.pos,goods);
          if (store) {
            loadCargo(w,order,actors,building,goods,'raid');
            if(tracked)building.stock[kind]-=amount;
            order.raidDelivery={warehouseId:store.id};order.state='travelling';
            for(const a of actors)setDestination(w,a,buildingDoor(w,store));
            say(`Loaded ${amount} cases of ${kind}; delivering to ${placeName(w,store)}.`);
          }
        }
        if (rng.chance(0.4) && !building.guardIds.includes(-1)) {
          building.guardIds.push(-1); // a police guard now watches the place
        }
      } else return finishOrder(w, order, `The raid on ${placeName(w, building)} was botched.`);
      break;
    }

    case 'kidnap': {
      if (!victim) return finishOrder(w, order, 'The target could not be found.');
      if (victim.gangId == null || victim.gangId === gang.id)
        return finishOrder(w, order, 'Only rival gang members can be taken.');
      const success = roll(rng, actors, ['stealth', 'fists', 'intimidation'], 0.35);
      stepOut(w,lead,victim.pos);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'kidnap',
        pos: victim.pos,
        victimId: victim.id,
      });
      if (success) {
        // 0x4DFCB0: an abducted shopkeeper (type 15) −32 hostility / +32 fear.
        if (victim.role === 'owner') shiftAttitude(victim, gang.id, -32, 32);
        victim.status = 'kidnapped';
        victim.capturedBy = gang.id;
        victim.interrogationValue = 100;
        victim.orderId = null;
        victim.streetOrder = null;
        victim.inVehicle = false;
        clearDestination(victim);
        const office = nearestOffice(w, gang.id, victim.pos);
        if (office) victim.pos = { ...w.lots[office.lotId].center };
        if (!gang.prisonerIds.includes(victim.id)) gang.prisonerIds.push(victim.id);
        const pocket = rng.int(120, 900);
        receiveOrderCash(w, gang, order, 'other', pocket);
        say(`Took ${victim.name} — and $${pocket} from his pockets.`);
        report(w, gang.id, 'waiting', `${victim.name} has been brought to your office.`, victim.pos, victim.id);
      } else {
        miss(`${victim.name} got away.`);
        if (rng.chance(0.35) && actors.length) {
          const unlucky = rng.pick(actors);
          unlucky.hp -= 55;
          if (unlucky.hp <= 0) killPerson(w, unlucky, 'killed during a botched kidnapping');
        }
      }
      break;
    }

    // -------------------------------------------------- violent crimes
    case 'smashUp': {
      if (!building) return;
      if (building.state === 'destroyed') return finishOrder(w, order, 'The site is gone.');
      const success = roll(rng, actors, ['intelligence', 'stealth', 'fists'], 0.2 + standingGuards(w, building) * 0.15);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'smashUp',
        pos: here,
        buildingId: building.id,
        isPublic: order.opts.isPublic,
      });
      if (success) {
        damageBuilding(w, building, 0.4);
        if (w.cityLayout?.original) blastFear(w, gang.id, building, BLAST_DAMAGE.smashUp);
        say(`Wrecked ${placeName(w, building)}.`);
        shiftLocalOpinion(w, here, order.opts.isPublic ? 60 : 30, gang.id, -3);
      } else {
        miss(`Could not get into ${placeName(w, building)}.`);
      }
      break;
    }

    case 'assault': {
      if (!victim) return finishOrder(w, order, 'The target could not be found.');
      const success = roll(rng, actors, ['intelligence', 'fists'], 0.18);
      // Out of the car to do it (he struck from the seat across the street).
      stepOut(w,lead,victim.pos);
      presentAttack(w,lead,victim,undefined,success);
      if (success) {
        // High knives skill makes a beating fatal more often than you would like.
        const knives = actorSkill(actors, ['knives']);
        const fatal = rng.chance(Math.max(0, (knives - 2.5) * 0.09));
        recordCrime(w, rng, {
          gangId: gang.id,
          perpetratorId: lead.id,
          type: fatal ? 'kill' : 'assault',
          pos: victim.pos,
          victimId: victim.id,
        });
        if (fatal) {
          killPerson(w, victim, `beaten to death by ${gang.name}`);
          // Recorded as an attack while he lived; the death makes it a killing.
          provoke(w, victim.gangId, gang.id, INCIDENT_HOSTILITY.kill - INCIDENT_HOSTILITY.attacked);
          say(`${victim.name} died from the beating. That is a murder charge.`);
          report(w, gang.id, 'combat', `${victim.name} was killed during an assault.`, victim.pos, victim.id);
        } else {
          victim.hp = Math.max(5, victim.hp - 45);
          knockDown(w, victim);
          // Assault victim (recode reading): fear +32, hostility −16.
          opinionShift(victim, gang.id, -25, { hostility: -16, fear: 32 });
          if (victim.role === 'owner' && victim.buildingId != null) {
            const b = w.buildings[victim.buildingId];
            if (b?.protection?.gangId === gang.id) {
              b.protection.refusing = false;
              b.protection.grievance = 0;
            }
          }
          say(`${victim.name} took a beating.`);
        }
        // 0x4D6060 state 5: the assault's fear at the victim (0x4DE430, 100).
        if (w.cityLayout?.original) blastAtVictim(w, gang.id, victim, BLAST_DAMAGE.assault);
        respondToBureauViolence(w, gang.id, victim);
      } else {
        miss(`${victim.name} was not where he should have been.`);
      }
      break;
    }

    case 'torch': {
      if (!building) return;
      if (building.state === 'destroyed') return finishOrder(w, order, 'The site is gone.');
      stepOut(w,lead,here);presentThrow(w,lead,here,'molotov');
      const success = roll(rng, actors, ['arson', 'stealth', 'intelligence'], 0.24 + standingGuards(w, building) * 0.12);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'torch',
        pos: here,
        buildingId: building.id,
        isPublic: order.opts.isPublic,
      });
      if (success) {
        const before=structuredClone(building);
        startBuildingEmergency(w,rng,building,'fire',THROW_TIMING.release+THROW_TIMING.flight,lead);
        if (w.cityLayout?.original) blastFear(w, gang.id, building, BLAST_DAMAGE.torch);
        burnBuilding(w, building);
        presentBuildingEffect(w, 'fire', here, building.id,THROW_TIMING.release+THROW_TIMING.flight,before);
        say(`Put ${placeName(w, building)} to the torch.`);
        shiftLocalOpinion(w, here, order.opts.isPublic ? 70 : 36, gang.id, -6);

      } else {
        miss(`The fire at ${placeName(w, building)} would not take.`);
        if (w.cityLayout?.original) blastFear(w, gang.id, building, BLAST_DAMAGE.torchFailed);
      }
      break;
    }

    case 'bomb': {
      if (!building) return;
      if (building.state === 'destroyed') return finishOrder(w, order, 'The site is gone.');
      if ((team.weapons.explosives ?? 0) <= 0 && (gang.weapons.explosives ?? 0) <= 0)
        return finishOrder(w, order, 'No explosives were available.');
      if ((team.weapons.explosives ?? 0) > 0) team.weapons.explosives--;
      else gang.weapons.explosives--;
      stepOut(w,lead,here);presentThrow(w,lead,here,'bomb');

      const success = roll(rng, actors, ['explosives', 'stealth', 'intelligence'], 0.3);
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: 'bomb',
        pos: here,
        buildingId: building.id,
        isPublic: order.opts.isPublic,
      });
      if (success) {
        const before=structuredClone(building);
        startBuildingEmergency(w,rng,building,'explosion',THROW_TIMING.release+THROW_TIMING.flight,lead);
        if (w.cityLayout?.original) blastFear(w, gang.id, building, BLAST_DAMAGE.bomb);
        destroyBuilding(w, building);
        presentBuildingEffect(w, 'explosion', here, building.id,THROW_TIMING.release+THROW_TIMING.flight,before);
        say(`${placeName(w, building)} is a pile of rubble.`);
        shiftLocalOpinion(w, here, order.opts.isPublic ? 90 : 50, gang.id, -12);
        if (order.opts.isPublic) {
          // A public bombing takes the neighbours with it.
          const blk = w.blocks[building.blockId];
          for (const nb of buildingsOfBlock(w, blk)) {
            if (nb.id !== building.id && rng.chance(0.3)) damageBuilding(w, nb, 0.6);
          }
        }

      } else {
        miss('The bomb went off early.');
        if (w.cityLayout?.original) blastFear(w, gang.id, building, BLAST_DAMAGE.bombFailed);
        presentBuildingEffect(w, 'explosion', lead.pos);
        const bomber = lead;
        bomber.hp -= 80;
        if (bomber.hp <= 0) {
          killPerson(w, bomber, 'blown up by his own bomb');
          report(w, gang.id, 'combat', `${bomber.name} was killed by his own explosives.`, here, bomber.id);
        }
      }
      break;
    }

    case 'kill': {
      if (!victim) return finishOrder(w, order, 'The target could not be found.');
      const guard = victim.gangId != null ? 0.18 : 0;
      // The mission still resolves as a whole, but only an equipped actor can
      // contribute shooting skill. Close-combat attempts are harder to execute.
      const equippedActors = actors.map(p => {
        const attack = attackProfile(loadout, p);
        return { ...p, skills: { ...p.skills, firearms: attack.skill * (attack.weapon ? 1 : 0.6) } };
      });
      const armed = actors.some(p => loadout.has(p.id));
      const success = roll(rng, equippedActors, ['firearms', 'stealth', 'intimidation'], 0.24 + guard);
      const shooter=actors.find(p=>loadout.has(p.id))??lead;
      // A gun reaches from the car; bare hands do not.
      if(!loadout.has(shooter.id))stepOut(w,shooter,victim.pos);
      presentAttack(w,shooter,victim,loadout.get(shooter.id),true);
      // Original city, 0x4D6E40 state 0: a hit man without a gun (weapon 0, 4,
      // 5 or 11) turns the Kill into an Assault (order 0x18), whose close
      // combat never kills; only a shopkeeper is executed in his premises
      // (0x4E0220) whatever the weapon.
      const beating = !!w.cityLayout?.original && !armed && victim.role !== 'owner';
      recordCrime(w, rng, {
        gangId: gang.id,
        perpetratorId: lead.id,
        type: beating ? 'assault' : 'kill',
        pos: victim.pos,
        victimId: victim.id,
      });
      if (success && beating) {
        victim.hp = Math.max(5, victim.hp - 45);
        knockDown(w, victim);
        opinionShift(victim, gang.id, -25, { hostility: -16, fear: 32 });
        say(`Without a gun it came down to fists: ${victim.name} took a beating.`);
        blastAtVictim(w, gang.id, victim, BLAST_DAMAGE.assault);
      } else if (success) {
        if (w.cityLayout?.original) blastAtVictim(w, gang.id, victim, BLAST_DAMAGE.kill);
        killPerson(w, victim, `${armed ? 'shot' : 'killed in close combat'} on the orders of ${gang.name}`);
        // Recorded as an attack while he lived; the death makes it a killing.
        provoke(w, victim.gangId, gang.id, INCIDENT_HOSTILITY.kill - INCIDENT_HOSTILITY.attacked);
        say(`${victim.name} is dead.`);
        report(w, gang.id, 'combat', `${victim.name} has been killed.`, victim.pos, victim.id, armed ? 'gunshot' : undefined);
      } else {
        miss(`${victim.name} survived the attempt.`);
        victim.hp = Math.max(10, victim.hp - 30);
        // A rival survives an attempt and takes it badly (the attack was
        // recorded above); the player's stance is the player's to set.
      }
      // Even a survived planned attempt inflicts injury; the outcome is one event.
      respondToBureauViolence(w, gang.id, victim);
      break;
    }

    default:
      break;
  }

  observeTargetRace(w, [gang.id]);
  void def;
  return missed;
}

// ---------------------------------------------------------------- world edits

export function damageBuilding(w: WorldState, b: Building, severity: number): void {
  if (b.cls === 'municipal' || b.state === 'destroyed') return;
  delete b.repairCompleteWeek;
  delete b.resumeTradingWeek;
  if (severity >= 0.8 && b.state === 'damaged') return destroyBuilding(w, b);
  b.state = 'damaged';
  const t = typeOf(b);
  b.repairCost = Math.round((t?.cost ?? 4000) * (0.18 + severity * 0.3));
  releaseManager(w, b);
  // An illegal business behind a damaged front cannot operate.
  if (b.hidesId != null) {
    const hidden = w.buildings[b.hidesId];
    if (hidden) {
      if (hidden.state === 'trading') hidden.state = 'ceased';
      delete hidden.resumeTradingWeek;
    }
  }
}

export function burnBuilding(w:WorldState,b:Building):void {
  if(b.cls==='municipal')return;
  damageBuilding(w,b,.85);b.fireWeek=w.week;
}

export function destroyBuilding(w: WorldState, b: Building): void {
  if (b.cls === 'municipal') return;
  delete b.repairCompleteWeek;
  delete b.resumeTradingWeek; delete b.fbiRaidWeek;
  releaseManager(w, b);
  if (b.hidesId != null) {
    const hidden = w.buildings[b.hidesId];
    if (hidden) {
      hidden.state = 'ceased';
      hidden.frontId = null;
      delete hidden.resumeTradingWeek;
    }
    b.hidesId = null;
  }
  if (b.frontId != null) {
    const front = w.buildings[b.frontId];
    if (front && front.hidesId === b.id) front.hidesId = null;
    b.frontId = null;
  }
  b.state = 'destroyed';
  b.protection = null;
  b.isHQ = false;
  const blk = w.blocks[b.blockId];
  blk.squalor = Math.min(100, blk.squalor + 6);
  blk.landValue = Math.max(5, blk.landValue - 4);
}

function releaseManager(w: WorldState, b: Building): void {
  if (b.managerId == null) return;
  const mgr = w.people[b.managerId];
  b.managerId = null;
  if (!mgr) return;
  mgr.buildingId = null;
  const gangId = b.ownerGangId;
  if (gangId != null) {
    const gang = w.gangs[gangId];
    if (gang && !gang.poolIds.includes(mgr.id)) gang.poolIds.push(mgr.id);
    const office = nearestOffice(w, gangId, mgr.pos);
    if (office) setDestination(w, mgr, w.lots[office.lotId].center);
  }
}

export function killPerson(w: WorldState, p: Person, reason: string): void {
  // Shot in a car, he falls on the pavement beside it, not under it in the lane.
  alight(w,p);
  if (p.status === 'dead') return;
  if(!p.burningEscape?.fatal)presentDeath(w,p);
  p.status = 'dead';
  p.hp = 0;
  p.dest = null;
  p.path = [];
  p.orderId = null;
  p.streetOrder = null;
  p.diedWeek = w.week;
  // A member's death leaves the rest of the gang more afraid of it (0x48D0B0).
  if (p.gangId != null && w.gangs[p.gangId]) {
    for (const q of peopleList(w))
      if (q.gangId === p.gangId && q.id !== p.id && q.status !== 'dead') shiftAttitude(q, p.gangId, 0, MEMBER_DEATH_FEAR);
  }
  // The original clears the seat and calls or refreshes the election at once.
  if (p.id === w.mayorId) onMayorDeath(w);
  else if (w.election.active && w.election.candidates.some(c => c.id === p.id && c.kind !== 'gang')) refreshNominees(w);

  // Unpick every reference, in every gang — a corpse left in a list is a bug
  // that surfaces weeks later as a phantom guard or an unpayable wage.
  for (const gang of Object.values(w.gangs)) {
    gang.poolIds = gang.poolIds.filter((id) => id !== p.id);
    gang.prisonerIds = gang.prisonerIds.filter((id) => id !== p.id);
    gang.recruitIds = gang.recruitIds.filter((id) => id !== p.id);
    gang.knownPeople = gang.knownPeople.filter((id) => id !== p.id);
    gang.employedPoliceIds = gang.employedPoliceIds.filter((id) => id !== p.id);
    if (gang.accountantId === p.id) { reclaimStaffVehicle(w, gang, 'accountant'); gang.accountantId = null; }
    if (gang.lawyerId === p.id) { reclaimStaffVehicle(w, gang, 'lawyer'); gang.lawyerId = null; }
  }
  for (const t of Object.values(w.teams)) {
    t.memberIds = t.memberIds.filter((id) => id !== p.id);
  }
  // His crew gets a new lieutenant now, not at the end of the week.
  for (const t of Object.values(w.teams)) {
    const gang = w.gangs[t.gangId];
    if (t.lieutenantId === p.id && gang) replaceLieutenant(w, gang, t);
  }
  p.teamId = null;
  p.capturedBy = null;
  p.interrogationValue = 0;

  for (const b of buildingList(w)) {
    if (b.managerId === p.id) b.managerId = null;
    if (b.ownerPersonId === p.id) b.ownerPersonId = null;
    if (b.guardIds.includes(p.id)) b.guardIds = b.guardIds.filter((id) => id !== p.id);
  }
  p.buildingId = null;

  // Officials are drawn from these lists; a dead judge must not be assigned.
  w.judgeIds = w.judgeIds.filter((id) => id !== p.id);
  w.daIds = w.daIds.filter((id) => id !== p.id);
  w.policeIds = w.policeIds.filter((id) => id !== p.id);
  w.fbiIds = w.fbiIds.filter((id) => id !== p.id);
  w.snitchIds = w.snitchIds.filter((id) => id !== p.id);

  w.weekLog.push(`${p.name} ${reason}.`);
}

/** How long a beating keeps a man down before he gets up on his own. */
export const BEATEN_MINUTES = 120;

/** A beaten man drops what he was doing and stays down for a while. */
export function knockDown(w: WorldState, victim: Person): void {
  victim.status = 'beaten';
  victim.orderId = null;
  victim.streetOrder = null;
  clearDestination(victim);
  victim.beatenUntil = w.week * MINUTES_PER_WEEK + w.minute + BEATEN_MINUTES;
}

/**
 * A promoted man is paid what he asks as a lieutenant. Original city
 * (0x460870, 0x67F479–0x67F491): his lieutenant quote when it is more than $20
 * above his demand, else his demand; pay and demand are both set to it.
 */
export function setLieutenantPay(w: WorldState, gang: Gang, hood: Person): void {
  if (w.cityLayout?.original) {
    const quote = originalWageQuote(hood, gang.id);
    if (quote > hood.payDemand + 20) hood.payDemand = quote;
  } else hood.payDemand = Math.max(hood.payDemand, hoodPayDemand(hood, 'lieutenant'));
  hood.pay = hood.payDemand;
}

/**
 * A crew whose lieutenant is dead, jailed or kidnapped goes to its best active
 * member and keeps its orders. With nobody to take it, a crew whose lieutenant
 * is dead is disbanded.
 */
export function replaceLieutenant(w: WorldState, gang: Gang, t: Team): void {
  const lt = w.people[t.lieutenantId];
  const stand = t.memberIds
    .map((id) => w.people[id])
    .filter((p) => p && p.status === 'active')
    .sort(
      (a, b) =>
        b.skills.organization + b.skills.intelligence - (a.skills.organization + a.skills.intelligence),
    )[0];
  if (!stand) {
    // Nobody left to lead it. A crew with a dead lieutenant and no
    // members would otherwise sit there forever holding a slot.
    if (!lt || lt.status === 'dead') disbandTeam(w, gang, t.id, false);
    return;
  }
  t.memberIds = t.memberIds.filter((id) => id !== stand.id);
  if (lt && lt.status !== 'dead') {
    // The old boss of the crew keeps his place in it until he is back.
    lt.role = 'hood';
    if (!t.memberIds.includes(lt.id)) t.memberIds.push(lt.id);
  }
  stand.role = 'lieutenant';
  stand.teamId = t.id;
  setLieutenantPay(w, gang, stand);
  t.lieutenantId = stand.id;
  t.name = `${stand.name.split(' ')[0]}'s Crew`;
  w.weekLog.push(`${stand.name} has taken over the crew for ${gang.name}.`);
}

/** Disband a crew: return its people and delete the orders it was carrying. */
export function disbandTeam(w: WorldState, gang: Gang, teamId: ID, keepLieutenant: boolean): void {
  const team = w.teams[teamId];
  if (!team || team.gangId !== gang.id) return;
  for(const id of team.orderIds){const o=w.orders[id];if(o)recoverExportGoods(w,o,!orderActors(w,o).length);}
  for(const [key,v] of Object.entries(w.vehicleFleet??{}))if(v.teamId===teamId){
    // Loaded vehicles keep their position and crew until the delivery finishes,
    // even when the lieutenant's inventory returns to the gang cache.
    if(v.cargo){
      v.cargo.purpose='return';v.cargo.orderId=null;v.orderId=null;
      v.slot+=(gang.vehicles[v.kind]??0);v.teamId=null;
      const newKey=`cache:${gang.id}:${v.kind}:${v.slot}`;
      w.vehicleFleet![newKey]=v;for(const id of v.occupantIds)w.people[id].vehicleKey=newKey;
    }else for(const id of [...v.occupantIds]){const p=w.people[id];if(p)dismount(w,p);}
    delete w.vehicleFleet![key];
  }
  for(const kind of ['coupe','truck','speedster'] as const)gang.vehicles[kind]=(gang.vehicles[kind]??0)+(team.vehicles[kind]??0);
  for (const kind of WEAPON_ORDER) gang.weapons[kind] = (gang.weapons[kind] ?? 0) + (team.weapons[kind] ?? 0);
  for (const oid of team.orderIds) {
    const order = w.orders[oid];
    if (order) {
      recoverExportGoods(w, order, !orderActors(w, order).length);
      for (const id of order.assignedIds) {
        const p = w.people[id];
        if (p) p.orderId = null;
      }
    }
    delete w.orders[oid];
  }
  for (const id of team.memberIds) {
    const m = w.people[id];
    if (!m || m.status === 'dead') continue;
    m.teamId = null;
    if (!gang.poolIds.includes(id)) gang.poolIds.push(id);
    if(m.vehicleKey)sendHome(w,m);
  }
  if (keepLieutenant) {
    const lt = w.people[team.lieutenantId];
    if (lt && lt.status !== 'dead') {
      lt.role = 'hood';
      lt.teamId = null;
      if (!gang.poolIds.includes(lt.id)) gang.poolIds.push(lt.id);
      if(lt.vehicleKey)sendHome(w,lt);
    }
  }
  gang.teamIds = gang.teamIds.filter((id) => id !== teamId);
  delete w.teams[teamId];
}

/** Promote a hood into a lieutenant, creating a new team. */
export function promoteToLieutenant(w: WorldState, gang: Gang, hood: Person): Team | null {
  if (gang.teamIds.length >= 8) return null;
  if (hood.teamId != null) {
    const old = w.teams[hood.teamId];
    if (old) old.memberIds = old.memberIds.filter((id) => id !== hood.id);
  }
  gang.poolIds = gang.poolIds.filter((id) => id !== hood.id);
  hood.role = 'lieutenant';
  setLieutenantPay(w, gang, hood);
  const team: Team = {
    id: newId(w),
    gangId: gang.id,
    lieutenantId: hood.id,
    name: `${hood.name.split(' ')[0]}'s Crew`,
    memberIds: [],
    weapons: { pistol: 0, shotgun: 0, rifle: 0, tommy: 0, twinPistols: 0, explosives: 0 },
    vehicles: { coupe: 0, truck: 0, speedster: 0 },
    allocatedBlockIds: [],
    orderIds: [],
    timeUsed: 0,
  };
  w.teams[team.id] = team;
  gang.teamIds.push(team.id);
  hood.teamId = team.id;
  return team;
}
import { blockPavement } from './cityLayout';
