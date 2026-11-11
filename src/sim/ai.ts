import { originalWeeklyStance, rollOriginalProfile, stanceOfHostility, startingHostility } from './aiStance';
import { cityBlockAt } from './cityLayout';
import {
  buyVehicle,
  buyWeapon,
  hireRecruit,
  moveToTeam,
  sellBuilding,
  sellVehicle,
  sellWeapon,
  issueOrder,
  promote,
  setDiplomacy,
  setRunForOffice,
  bribeOfficial,
  bribePrice,
  employPoliceOfficer,
  toggleEvadeTax,
  transferVehicle,
  transferWeapon,
  interrogatePrisoner,
  killPrisoner,
  nearTerritory,
  BUY_REACH_BLOCKS,
  repairBuilding,
  setTrading,
} from './api';
import { MAX_TEAMS, MAX_TEAM_SIZE, MINUTES_PER_WEEK, WEAPONS } from './constants';
import { BUILDING_BY_ID, ILLEGAL_TYPES, coverQuality } from './data/buildings';
import { isValidAreaTarget, nearestOffice } from './execution';
import { centreLotNeedsFront, purchasablePremisesType } from './premises';
import { buildingMapIntel } from './mapIntel';
import type { Rng } from './rng';
import { campaignWeeklyCost, canRunForOffice, electionBlocksRequired } from './systems/politics';
import { originalElectionPoll } from './originalElection';
import type { Block, Building, Gang, ID, Team, WorldState } from './types';
import {
  allBuildings,
  buildingsOfBlock,
  dist,
  gangManpower,
  gangMembers,
  ownedBuildings,
  powerRating,
  protectedBuildings,
  teamsOf,
  territoryBlocks,
  territoryCount,
} from './world';
import { peopleList } from './entityLists';
import { quitGangPayroll } from './payrollMark';

/** Blocks within `radius` of anywhere the gang already has a presence. */
/** How long a crew's orders run end to end: what the planner fills the week by. */
function clockTime(w: WorldState, team: Team): number {
  return team.orderIds.reduce((sum, id) => sum + (w.orders[id]?.estimatedMinutes ?? 0), 0);
}

function homeBlocks(w: WorldState, gang: Gang, radius: number): Block[] {
  const seeds = new Set<number>();
  for (const b of allBuildings(w)) {
    if (b.ownerGangId === gang.id || b.protection?.gangId === gang.id) seeds.add(b.blockId);
  }
  if (!seeds.size) {
    const office = nearestOffice(w, gang.id, w.blocks[0].center);
    if (office) seeds.add(office.blockId);
  }
  const out = new Map<number, Block>();
  for (const id of seeds) {
    const s = w.blocks[id];
    if (!s) continue;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gx = s.gx + dx;
        const gy = s.gy + dy;
        if (gx < 0 || gy < 0 || gx >= w.gridW || gy >= w.gridH) continue;
        const blk = cityBlockAt(w, gx, gy);
        if (blk) out.set(blk.id, blk);
      }
    }
  }
  return [...out.values()];
}

function aggression(gang: Gang): number {
  return gang.personality === 'aggressive' ? 1 : gang.personality === 'normal' ? 0.55 : 0.2;
}

/** A whole planning phase for one computer-controlled gang; `autopilot` plans
 * the player's gang too, for the menu's attract mode. */
export function planGang(w: WorldState, rng: Rng, gang: Gang, autopilot = false): void {
  if (gang.eliminated || (gang.isPlayer && !autopilot)) return;
  const boss = w.people[gang.bossId];
  if (!boss || boss.status === 'dead') return;

  manageCashflow(w, gang);
  manageRepairs(w, gang);
  manageStaff(w, rng, gang);
  manageDiplomacy(w, rng, gang);
  manageSpecialists(w, rng, gang);
  managePrisoners(w, rng, gang);
  manageEquipment(w, rng, gang);

  const teams = teamsOf(w, gang).filter((t) => {
    const lt = w.people[t.lieutenantId];
    return lt && lt.status !== 'dead' && lt.status !== 'jailed' && lt.status !== 'kidnapped';
  });
  if (!teams.length) return;

  const near = homeBlocks(w, gang, 3);
  const nearIds = new Set(near.map((b) => b.id));

  // Everything the gang could reasonably work on this week.
  const protectedSites = protectedBuildings(w, gang.id).filter((b) => b.state === 'trading');
  const extortable = near
    .flatMap((blk) => buildingsOfBlock(w, blk))
    .filter(b => b.state === 'trading' && isValidAreaTarget(w, gang.id, 'extort', b));
  // Work a block at a time. A racket spread thinly over twenty streets controls
  // none of them; finishing one block at a time is what turns payers into turf.
  rng.shuffle(extortable);
  const holdings = new Map<ID, number>();
  for (const b of allBuildings(w)) {
    if (b.ownerGangId === gang.id || b.protection?.gangId === gang.id) {
      holdings.set(b.blockId, (holdings.get(b.blockId) ?? 0) + 1);
    }
  }
  const office = nearestOffice(w, gang.id, w.blocks[0].center);
  const home = office ? w.lots[office.lotId].center : w.blocks[0].center;
  extortable.sort((a, b) => {
    const ha = holdings.get(a.blockId) ?? 0;
    const hb = holdings.get(b.blockId) ?? 0;
    if (ha !== hb) return hb - ha;
    if (a.blockId !== b.blockId) {
      return dist(w.blocks[a.blockId].center, home) - dist(w.blocks[b.blockId].center, home);
    }
    return 0;
  });

  const recruitSites = near
    .flatMap((blk) => buildingsOfBlock(w, blk))
    .filter((b) => BUILDING_BY_ID[b.typeId]?.recruit === 'hood');

  // Shops refusing to pay, shared out between the crews (one crew to a shop).
  const refusing = protectedBuildings(w, gang.id).filter((b) => b.protection?.refusing);

  teams.forEach((team, idx) => {
    let guard = 0;
    const canDoMore = () => clockTime(w, team) < MINUTES_PER_WEEK * 0.9 && guard++ < 8;

    // 1. Always collect what is owed.
    if (protectedSites.length && canDoMore()) {
      const share = protectedSites.slice(idx * 40, idx * 40 + 40);
      if (share.length) {
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: 'collectProtection',
          buildingIds: share.map((b) => b.id),
          opts: { manpower: Math.min(3, team.memberIds.length || 1), repeat: false },
        });
      }
    }

    // 2. Expand the racket.
    if (extortable.length && canDoMore()) {
      const take = extortable.splice(0, 10);
      if (take.length) {
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: 'extort',
          buildingIds: take.map((b) => b.id),
          opts: { manpower: Math.min(2, Math.max(1, team.memberIds.length)) },
        });
      }
    }

    // 3. Bring refusers back into line (each shop to one crew).
    if (refusing.length && canDoMore()) {
      issueOrder(w, gang.id, {
        teamId: team.id,
        type: 'intimidate',
        buildingIds: refusing.splice(0, 6).map((b) => b.id),
        opts: { manpower: 2 },
      });
    }

    // 4. Keep the ranks filled.
    if (recruitSites.length && gangManpower(w, gang) < 18 && canDoMore() && rng.chance(0.7)) {
      issueOrder(w, gang.id, {
        teamId: team.id,
        type: 'recruit',
        buildingIds: rng.shuffle([...recruitSites]).slice(0, 2).map((b) => b.id),
        opts: { manpower: 1 },
      });
    }

    // 5. Learn the ground.
    if (canDoMore() && rng.chance(0.45)) {
      const unexplored = near.filter((blk) =>
        buildingsOfBlock(w, blk).some((b) => (b.knowledge[gang.id] ?? 0) < 3 && b.cls !== 'empty'),
      );
      if (unexplored.length) {
        const blk = rng.pick(unexplored);
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: 'explore',
          blockIds: [blk.id],
          opts: { manpower: 1 },
        });
      }
    }

    // 6. Gang Warfare permits deliberate plots. Aggression affects encounters
    // on the street, but does not order hits on a rival (manual p.50).
    const hostileTo = Object.values(w.gangs).filter(
      (g) => g.id !== gang.id && !g.eliminated && gang.offered[g.id] === 'war',
    );
    if (hostileTo.length && canDoMore() && rng.chance(aggression(gang))) {
      const enemy = rng.pick(hostileTo);
      const targets = allBuildings(w).filter(
        (b) =>
          b.ownerGangId === enemy.id &&
          buildingMapIntel(b, gang.id).ownerGangId === enemy.id &&
          b.state === 'trading' &&
          !b.isHQ,
      );
      const enemyHoods = peopleList(w).filter(
        (p) => p.gangId === enemy.id && p.status === 'active' && gang.knownPeople.includes(p.id),
      );

      if (targets.length && rng.chance(0.6)) {
        const t = rng.pick(targets);
        const kind = rng.weighted([
          { item: 'smashUp' as const, weight: 3 },
          { item: 'torch' as const, weight: 2 },
          { item: 'raid' as const, weight: 3 },
          { item: 'bomb' as const, weight: (team.weapons.explosives ?? 0) > 0 ? 2 : 0 },
        ]);
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: kind,
          buildingIds: [t.id],
          opts: { manpower: 2, isPublic: rng.chance(0.4) },
        });
      } else if (enemyHoods.length) {
        const victim = rng.pick(enemyHoods);
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: rng.chance(0.5) ? 'kill' : 'kidnap',
          personId: victim.id,
          opts: { manpower: 2 },
        });
      }
    }

    // 7. Spend what is left holding the streets.
    if (clockTime(w, team) < MINUTES_PER_WEEK * 0.45) {
      const mine = territoryBlocks(w, gang.id);
      if (mine.length) {
        const patrolBlocks = rng.shuffle([...mine]).slice(0, 6).map((b) => b.id);
        issueOrder(w, gang.id, {
          teamId: team.id,
          type: 'patrol',
          blockIds: patrolBlocks,
          opts: { manpower: 1, repeat: false },
        });
      }
    }

    void nearIds;
  });

  manageProperty(w, rng, gang, teams.map((t) => t.id));
}

/**
 * Payroll before everything. A boss short of cash sells the guns, then the
 * cars, then a shop — exactly what the manual tells the player to do — rather
 * than letting his people go unpaid until they walk out.
 */
/** Mend what was smashed or burned, and open again what was shut, while the
 *  wages are covered: a torched shop otherwise stood idle for good. */
function manageRepairs(w: WorldState, gang: Gang): void {
  const reserve = gangManpower(w, gang) * 220;
  for (const b of ownedBuildings(w, gang.id)) {
    if (b.state === 'damaged' && b.repairCompleteWeek == null && gang.cash - b.repairCost > reserve) repairBuilding(w, gang.id, b.id);
  }
  // Fronts first: a hidden business opens only behind a trading front.
  const shut = ownedBuildings(w, gang.id).filter((b) => b.state === 'ceased' && b.fbiClosedWeek == null);
  shut.sort((x, y) => Number(x.cls === 'illegal') - Number(y.cls === 'illegal'));
  for (const b of shut) setTrading(w, gang.id, b.id, true);
}

function manageCashflow(w: WorldState, gang: Gang): void {
  const wageBill = gangMembers(w, gang)
    .filter((p) => p.role !== 'boss')
    .reduce((sum, p) => sum + p.pay, 0);
  const target = wageBill * 2 + 500;
  if (gang.cash >= target) return;

  for (const wid of ['pistol', 'shotgun', 'rifle', 'tommy'] as (keyof Gang['weapons'])[]) {
    while (gang.cash < target && (gang.weapons[wid] ?? 0) > 0) {
      if (!sellWeapon(w, gang.id, wid).ok) break;
    }
    for (const t of teamsOf(w, gang)) {
      while (gang.cash < target && (t.weapons[wid] ?? 0) > 0) {
        if (!sellWeapon(w, gang.id, wid, t.id).ok) break;
      }
    }
  }
  for (const vid of ['coupe', 'truck', 'speedster'] as (keyof Gang['vehicles'])[]) {
    // Loaded trucks can survive the weekend. A refused sale leaves inventory
    // unchanged; try other assets instead of retrying the same vehicle forever.
    while (gang.cash < target && (gang.vehicles[vid] ?? 0) > 0) {
      if (!sellVehicle(w, gang.id, vid).ok) break;
    }
    for (const t of teamsOf(w, gang)) {
      while (gang.cash < target && (t.vehicles[vid] ?? 0) > 0) {
        if (!sellVehicle(w, gang.id, vid, t.id).ok) break;
      }
    }
  }
  if (gang.cash >= target) return;

  // Then the least valuable premises that is not the headquarters.
  const sellable = ownedBuildings(w, gang.id)
    .filter((b) => !b.isHQ && b.hidesId == null && b.cls !== 'empty')
    .sort((a, b) => (BUILDING_BY_ID[a.typeId]?.profit ?? 0) - (BUILDING_BY_ID[b.typeId]?.profit ?? 0));
  for (const b of sellable) {
    if (gang.cash >= target) break;
    sellBuilding(w, gang.id, b.id);
  }
}

function manageStaff(w: WorldState, rng: Rng, gang: Gang): void {
  // Hire everyone who has agreed to work, while the money lasts. A gang with
  // nobody left takes on anyone it can just about afford.
  const desperate = gangManpower(w, gang) < 2;
  for (const id of [...gang.recruitIds]) {
    const p = w.people[id];
    if (!p || p.gangId != null) {
      gang.recruitIds = gang.recruitIds.filter((x) => x !== id);
      continue;
    }
    if (gang.cash < p.payDemand * (desperate ? 1.5 : 4)) break;
    const teams = teamsOf(w, gang);
    const room = teams.find((t) => t.memberIds.length < MAX_TEAM_SIZE - 1);
    hireRecruit(w, gang.id, id, room ? 'team' : 'pool', room?.id);
  }

  // Promote when there are spare bodies and spare lieutenant slots.
  if (gang.teamIds.length < MAX_TEAMS && gang.poolIds.length >= 3 && gang.cash > 4000) {
    const best = gang.poolIds
      .map((id) => w.people[id])
      .filter((p) => p && p.status === 'active')
      .sort((a, b) => b.skills.organization + b.skills.intelligence - (a.skills.organization + a.skills.intelligence))[0];
    if (best) promote(w, gang.id, best.id);
  }

  // Reserves include the extra starting hoods. Put them to work after any
  // promotion, filling the smallest crew first instead of leaving them idle.
  for (const id of [...gang.poolIds]) {
    const p = w.people[id];
    if (!p || p.status !== 'active' || p.role !== 'hood') continue;
    const room = teamsOf(w, gang)
      .filter(t => w.people[t.lieutenantId]?.status === 'active' && t.memberIds.length < MAX_TEAM_SIZE - 1)
      .sort((a, b) => a.memberIds.length - b.memberIds.length || a.id - b.id)[0];
    if (!room) break;
    moveToTeam(w, gang.id, id, room.id);
  }

  // Keep people paid — an AI that starves its hoods simply falls apart.
  for (const t of teamsOf(w, gang)) {
    for (const id of [t.lieutenantId, ...t.memberIds]) {
      const p = w.people[id];
      if (!p) continue;
      if (p.pay < p.payDemand && gang.cash > p.payDemand * 3) p.pay = p.payDemand;
    }
  }
  void rng;
}

function manageSpecialists(w: WorldState, rng: Rng, gang: Gang): void {
  const wantAccountant = gang.accountantId == null && gang.cash > 6000;
  const wantLawyer = gang.lawyerId == null && gang.cash > 6000;

  if (wantAccountant || wantLawyer) {
    const free = peopleList(w).filter(
      (p) =>
        p.gangId == null &&
        p.status === 'active' &&
        ((wantAccountant && p.role === 'accountant') || (wantLawyer && p.role === 'lawyer')),
    );
    if (free.length) {
      const pick = free.sort((a, b) => b.skills.intelligence - a.skills.intelligence)[0];
      hireRecruit(w, gang.id, pick.id, 'pool');
    }
  }

  if (gang.accountantId != null && !gang.evadingTax && gang.lastWeekIncome.legal > 1500) {
    toggleEvadeTax(w, gang.id);
  }

  // Keep the officials sweet when the heat rises.
  if (gang.lawyerId != null) {
    const mayor = w.people[w.mayorId];
    const chief = w.people[w.policeChiefId];
    for (const official of [chief, mayor]) {
      if (!official) continue;
      const view = official.opinion[gang.id] ?? 0;
      const price = bribePrice(w, official, gang.id);
      if (view < 10 && gang.cash > price * 4 && rng.chance(0.6)) {
        bribeOfficial(w, gang.id, official.id);
      }
    }
    // A couple of officers on the payroll near home.
    if (gang.employedPoliceIds.length < 3 && gang.cash > 12000) {
      const office = nearestOffice(w, gang.id, w.blocks[0].center);
      if (office) {
        const here = w.lots[office.lotId].center;
        const officer = w.policeIds
          .map((id) => w.people[id])
          .filter((p) => p && p.status === 'active' && p.employedBy == null && !quitGangPayroll(p, gang.id))
          .sort((a, b) => dist(a.pos, here) - dist(b.pos, here))[0];
        if (officer) employPoliceOfficer(w, gang.id, officer.id);
      }
    }
  }

  // Stand for office when the moment comes. The original city follows the
  // planner's election task (0x6AFA90, below); compact cities keep the
  // remake's 80% entry roll and nothing more.
  if (w.cityLayout?.original) originalElectionCampaign(w, gang);
  else if (!gang.runningForOffice && canRunForOffice(w, gang.id) && rng.chance(0.8)) setRunForOffice(w, gang.id, true);
}

type Candidate = WorldState['election']['candidates'][number];

/** 0x4BCC50: the first candidate on the ballot with the most votes, none when
 * every count is 0 (it starts from 0 and takes only a strictly larger one). */
function pollLeader(w: WorldState, votes: (c: Candidate) => number): { c: Candidate; votes: number } | null {
  let top: { c: Candidate; votes: number } | null = null;
  for (const c of w.election.candidates) if (votes(c) > (top?.votes ?? 0)) top = { c, votes: votes(c) };
  return top;
}

/**
 * 0x6AFA90, AI planner task 0x32, run every AI week under the permanent root
 * 0x31 (docs/audit/2026-10-28/ai-incidents/review.md, "the election
 * campaign"). gang+0x4CB is the computer gang's "standing" flag, ours
 * `runningForOffice`; outside an election it is cleared (settleElectionCampaign).
 * - Not standing, and under the blocks needed (0x902894), past phase 3 (fewer
 *   than 3 weeks left) or with no more cash than the week's campaign cost
 *   (0x6DD210 / 0x902814): if a gang's boss (class 0x1E) leads the poll, the
 *   "stance 4 toward his gang" below. Nothing else.
 * - Otherwise without a lawyer (gang+0x48C): task 0x27, "Recruit a lawyer"
 *   (0x676D60). Not ported: its affordability gate reads takings and wage
 *   lanes the remake does not keep; manageSpecialists hires lawyers its own way.
 * - Otherwise it enters (0x4BC040) and withdraws at once (0x4BC0A0) unless it
 *   leads or has more than four-fifths of the leader's votes. Kept in, it sets
 *   the flag and loops straight into the standing branch the same week.
 * - Standing, and not the leader: a gang's boss leading gets the stance-4
 *   write; a civic leader gets task 0x24, "Bribe" (0x4B3970: order 0x29,
 *   bribe officials, through the lawyer, when the price is under the week's
 *   planning budget gang+0x518). Then task 0x25, "Donate" (0x4B35F0), not
 *   ported: see the review.
 * Nothing here draws the RNG.
 */
function originalElectionCampaign(w: WorldState, gang: Gang): void {
  if (!w.election.active) return;
  // The ballot as polled this week; 0x4BCC50 recounts on every call, which
  // differs only by what changed since the weekly poll.
  let votes = (c: Candidate) => c.votes;
  if (!gang.runningForOffice) {
    if (territoryCount(w, gang.id) < electionBlocksRequired(w) || w.election.weeksLeft < 3 ||
      gang.cash <= campaignWeeklyCost(w, gang.id)) {
      if (pollLeader(w, votes)?.c.kind === 'gang') resetToStartingStances(w, gang);
      return;
    }
    if (gang.lawyerId == null || !setRunForOffice(w, gang.id, true).ok) return;
    // Entered: the poll is recounted with the new candidate on the ballot.
    const poll = originalElectionPoll(w);
    votes = c => poll?.votes.get(c.id) ?? 0;
    const top = pollLeader(w, votes), mine = poll?.votes.get(gang.bossId) ?? 0;
    if (!(top?.c.kind === 'gang' && top.c.gangId === gang.id) && mine * 5 <= 4 * (top?.votes ?? 0)) {
      setRunForOffice(w, gang.id, false);
      return;
    }
  }
  const leader = pollLeader(w, votes)?.c;
  if (!leader || (leader.kind === 'gang' && leader.gangId === gang.id)) return;
  if (leader.kind === 'gang') resetToStartingStances(w, gang);
  else if (gang.lawyerId != null) {
    // Task 0x24 on the civic leader, if it can be afforded (cash for the budget).
    const official = w.people[leader.id];
    if (official && official.bribedBy !== gang.id && gang.cash > bribePrice(w, official, gang.id)) bribeOfficial(w, gang.id, official.id);
  }
}

/**
 * What 0x6AFA90 does when a gang's boss leads the poll. It writes stance 4
 * (War) toward his gang, then calls 0x6DDE60, the weekly commit of a gang's
 * pending stances: last week's row (+0x4C3) takes the current one, War
 * included, and the current row (+0x4BB) takes the pending row (+0x4BF). For
 * a computer gang only the setup 0x6CBE10 writes +0x4BF, with its starting
 * stances, so the War is overwritten at once and the gang stands at its
 * starting stance toward every gang until next week's stance machine. The
 * attack task 0x1A it then makes on the leader's gang (0x73A3D0) gives up at
 * once (returns 2) at Peace, so it goes ahead only against the player when the
 * gang started at Cease-fire or worse toward him; that attack planning is not
 * ported (no planner tree).
 */
function resetToStartingStances(w: WorldState, gang: Gang): void {
  for (const other of Object.values(w.gangs)) {
    if (other.id === gang.id) continue;
    const start = stanceOfHostility(startingHostility(gang, other));
    if ((gang.offered[other.id] ?? 'peace') !== start) setDiplomacy(w, gang.id, other.id, start);
  }
}

function managePrisoners(w: WorldState, rng: Rng, gang: Gang): void {
  for (const id of [...gang.prisonerIds]) {
    const p = w.people[id];
    if (!p || p.status !== 'kidnapped') {
      gang.prisonerIds = gang.prisonerIds.filter((x) => x !== id);
      continue;
    }
    interrogatePrisoner(w, rng, gang.id, id);
    if (p.interrogationValue <= 0 && rng.chance(aggression(gang))) killPrisoner(w, gang.id, id);
  }
}

function manageEquipment(w: WorldState, rng: Rng, gang: Gang): void {
  const atWar = Object.values(w.gangs).some(
    (g) => g.id !== gang.id && !g.eliminated && (gang.offered[g.id] === 'war' || gang.offered[g.id] === 'aggression'),
  );
  const teams = teamsOf(w, gang);
  if (!teams.length) return;

  // Never spend the wage bill on hardware.
  const reserve = gangManpower(w, gang) * 220;
  const spare = Math.max(0, gang.cash - reserve);
  const budget = atWar ? spare * 0.5 : spare * 0.2;
  let spent = 0;

  // What the gang owns is in its cache and with its crews (the cache is
  // handed out every week, so counting it alone bought more every week).
  const total = (cache: Record<string, number>) => Object.values(cache).reduce((s, n) => s + n, 0);
  let armedCount = total(gang.weapons) + teams.reduce((s, t) => s + total(t.weapons), 0);
  const bodies = gangManpower(w, gang);
  while (spent < budget && armedCount < bodies) {
    const choice = rng.weighted([
      { item: 'pistol' as const, weight: 5 },
      { item: 'shotgun' as const, weight: atWar ? 3 : 1 },
      { item: 'rifle' as const, weight: atWar ? 3 : 1 },
      { item: 'tommy' as const, weight: atWar && gang.cash > 20000 ? 2 : 0 },
      { item: 'explosives' as const, weight: atWar ? 2 : 0 },
    ]);
    if (spent + WEAPONS[choice].cost > budget) break;
    const before = gang.cash;
    const res = buyWeapon(w, gang.id, choice);
    if (!res.ok) break;
    spent += before - gang.cash;
    armedCount++;
  }

  const cars = total(gang.vehicles) + teams.reduce((s, t) => s + total(t.vehicles), 0);
  if (gang.cash > 12000 && cars < teams.length + 1) {
    buyVehicle(w, gang.id, rng.chance(0.7) ? 'coupe' : 'truck');
  }

  // Push the cache out to the crews.
  for (const [wid, count] of Object.entries(gang.weapons)) {
    for (let i = 0; i < count; i++) {
      const team = teams[i % teams.length];
      transferWeapon(w, gang.id, wid as keyof Gang['weapons'], team.id, true);
    }
  }
  for (const [vid, count] of Object.entries(gang.vehicles)) {
    for (let i = 0; i < count; i++) {
      const team = teams[i % teams.length];
      transferVehicle(w, gang.id, vid as keyof Gang['vehicles'], team.id, true);
    }
  }
}

function manageDiplomacy(w: WorldState, rng: Rng, gang: Gang): void {
  const others = Object.values(w.gangs).filter((g) => g.id !== gang.id && !g.eliminated);
  if (!others.length) return;
  // The original city runs the original stance machine (0x6DD950) on the gang's
  // rolled profile; compact cities keep the remake's power-ratio appetite.
  if (w.cityLayout?.original) {
    gang.aiProfile ??= rollOriginalProfile(w.options.opponents, rng);
    for (const [id, stance] of originalWeeklyStance(w, rng, gang))
      if ((gang.offered[id] ?? 'peace') !== stance) setDiplomacy(w, gang.id, id, stance);
    return;
  }
  const myPower = powerRating(w, gang);

  for (const other of others) {
    const theirPower = powerRating(w, other);
    const ratio = myPower / Math.max(1, theirPower);
    const current = gang.offered[other.id] ?? 'peace';
    const theirs = gang.known[other.id] ?? 'peace';

    // Retaliate first: nobody stays at peace with someone shooting at them.
    if (theirs === 'war') {
      setDiplomacy(w, gang.id, other.id, 'war');
      continue;
    }
    if (theirs === 'aggression' && current === 'peace') {
      setDiplomacy(w, gang.id, other.id, 'ceasefire');
      continue;
    }

    const appetite = aggression(gang) * ratio;
    // Passive opponents reserve violence for retaliation, even when wealthy
    // enough that the relative-power calculation would otherwise invite war.
    if (gang.personality !== 'passive' && appetite > 1.3 && rng.chance(0.25)) {
      setDiplomacy(w, gang.id, other.id, appetite > 1.9 ? 'war' : 'aggression');
    } else if (ratio < 0.6 && (current === 'war' || current === 'aggression') && rng.chance(0.4)) {
      setDiplomacy(w, gang.id, other.id, 'ceasefire');
    } else if (gang.personality === 'passive' && current !== 'peace' && rng.chance(0.3)) {
      setDiplomacy(w, gang.id, other.id, 'peace');
    }
  }
}

function manageProperty(w: WorldState, rng: Rng, gang: Gang, teamIds: ID[]): void {
  if (!teamIds.length) return;
  const teamId = teamIds[0];

  // Set up an illegal business on land already owned.
  const emptyOwned = ownedBuildings(w, gang.id).filter(
    (b) => b.cls === 'empty' && w.lots[b.lotId].index === 4,
  );
  for (const land of emptyOwned) {
    const blockFronts = buildingsOfBlock(w, w.blocks[land.blockId]).filter(
      (b) => b.ownerGangId === gang.id && b.cls !== 'illegal' && b.cls !== 'empty' && b.hidesId == null &&
        b.state === 'trading',
    );
    if (!blockFronts.length) continue;
    const front = blockFronts[0];
    const affordable = ILLEGAL_TYPES.filter((t) => t.id !== 'office' && t.cost <= gang.cash * 0.5);
    if (!affordable.length) continue;
    const best = affordable
      .map((t) => ({ t, score: coverQuality(t.id, front.typeId) * 2 + t.profit / 1200 }))
      .sort((a, b) => b.score - a.score)[0];
    // A refused order (the front not fit to cover it) is no reason to stop buying.
    if (issueOrder(w, gang.id, {
      teamId,
      type: 'setUpBusiness',
      buildingIds: [land.id],
      opts: { businessTypeId: best.t.id, frontBuildingId: front.id, manpower: 1 },
    }).ok) return;
  }

  // Otherwise buy something worth having.
  if (gang.cash < 14000) return;
  const near = homeBlocks(w, gang, 2);
  const candidates: Building[] = [];
  for (const blk of near) {
    for (const b of buildingsOfBlock(w, blk)) {
      if (b.ownerGangId != null || b.state === 'destroyed') continue;
      if (!purchasablePremisesType(b)) continue;
      // The middle of a block is only sold to the owner of one of its fronts.
      if (centreLotNeedsFront(w, gang.id, b)) continue;
      // The order's own reach, not the square round the gang's blocks.
      if (!nearTerritory(w, gang.id, b.blockId, BUY_REACH_BLOCKS)) continue;
      candidates.push(b);
    }
  }
  if (!candidates.length) return;

  // Prefer the centre lot of a block already fronted, else a profitable site.
  const centre = candidates.filter(
    (b) =>
      b.cls === 'empty' &&
      w.lots[b.lotId].index === 4 &&
      buildingsOfBlock(w, w.blocks[b.blockId]).some((x) => x.ownerGangId === gang.id),
  );
  const pickFrom = centre.length && rng.chance(0.7) ? centre : candidates;
  const target = pickFrom.sort(
    (a, b) => (BUILDING_BY_ID[b.typeId]?.profit ?? 0) - (BUILDING_BY_ID[a.typeId]?.profit ?? 0),
  )[0];
  if (target) {
    issueOrder(w, gang.id, {
      teamId,
      type: 'buyPremises',
      buildingIds: [target.id],
      opts: { manpower: 1 },
    });
  }
}
