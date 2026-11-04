import {settleBurningEscapes, tickBuildingEmergencies} from './systems/buildingEmergency';
import { driveFrom, earlySteps, finishMovementTick, repairVehicleRoutes } from './movement';
import { reconcileTransport, resetWeekTransport, restoreLegacyTransport } from './transport';
import { recoverExportGoods } from './exportGoods';
import { availableSpecialist } from './specialists';
import { beginSpecialistJobs, settleSpecialistJobs, tickSpecialistJobs } from './specialistJobs';
import {finishBuildingRepairs} from './buildingDamage';
import { finishTradingRestarts } from './businessState';
import { validateSaveWorld, validateSaveWorldResponsive } from './saveSchema';
import { canGoStraight, rolloverOrders } from './api';
import { planGang } from './ai';
import { createWorld } from './citygen';
import { repairLegacyStreetSpawns } from './streetPlacement';
import { closeFinances, currentFinances, openFinances } from './finances';
import { finalScore, recordScorePeaks, scoreMeasures } from './scoring';
import { observeTargetRace, tieRank } from './targetRace';
import { weeklyTaxes } from './systems/taxes';
import { buildingValue, releaseGangHoldings, standingBlocks } from './execution';
import { MINUTES_PER_SECOND, MINUTES_PER_WEEK, ORDERS } from './constants';
import { addMessage, addNews } from './events';
import { beginWeekOrders, disbandTeam, promoteToLieutenant, replaceLieutenant, tickOrders } from './execution';
import { Rng } from './rng';
import { allocateWeapons } from './weapons';
import { tickAmbient } from './systems/ambient';
import { scanStreetSlice, tickTraffic, trafficContext } from './traffic';
import { TRAM_RIDING, tickTramRiding } from './tramRiding';
import { capturePeaceFireExclusions, tickCombat } from './systems/combat';
import { sightingCells, tickSightings } from './systems/sightings';
import { blockClaimants } from './territory';
import { weeklyEconomy } from './systems/economy';
import { tickGoods } from './goodsDelivery';
import { dispatchFbi, normalizeFbiInvestigations, tickFbi, weeklyFbi } from './systems/fbi';
import { weeklyLaw } from './systems/law';
import { weeklyNews } from './systems/news';
import { territoryGoodwill, weeklyOpinion } from './systems/opinion';
import { weeklyPolitics } from './systems/politics';
import { replenishOriginalRecruits } from './recruitPool';
import { replacePoliceChief } from './officials';
import { weeklyProtectionFear } from './attitudes';
import { restoreElectionTiming } from './electionTiming';
import { tickStreetOrders } from './systems/street';
import type { GameOptions, Gang, ID, WorldState } from './types';

/** Ambient walking slices per minute (ambientSlices). */
const AMBIENT_SLICES = 6;
import { gangAssets, gangWealth, gangLoyalty, gangManpower, money, ownedBuildings, placeName, powerRating, teamsOf, territoryCount } from './world';
import { peopleList, buildingList } from './entityLists';

/** The clock lives with the other units; see constants.ts. */
export { MINUTES_PER_SECOND } from './constants';

export class Sim {
  world: WorldState;
  rng: Rng;
  private accumulator = 0;
  /** The last tick's score peaks are still to be taken (settleDeferred). */
  private peaksDue = false;

  constructor(options: GameOptions) {
    earlySteps.clear(); driveFrom.clear();
    const { world, rng } = createWorld(options);
    this.world = world;
    this.rng = rng;
    for (const gang of Object.values(world.gangs)) openFinances(world, gang);
    for (const b of buildingList(world)) if (b.ownerGangId != null) b.acquisitionCost = buildingValue(world, b);
    // Give the computer gangs their opening moves.
    observeTargetRace(world, undefined, 'initial');
    if (!this.resolveImmediateOutcome()) this.planAi();
    recordScorePeaks(this.world);
    this.world.rngState = this.rng.state;
  }

  static fromSave(state: WorldState): Sim {
    validateSaveWorld(state);
    return Sim.restoreValidated(state);
  }

  /** Restore an owned snapshot while allowing input between validation batches. */
  static async fromSaveResponsive(state: WorldState, signal?: AbortSignal): Promise<Sim> {
    await validateSaveWorldResponsive(state, signal);
    signal?.throwIfAborted();
    return Sim.restoreValidated(state);
  }

  private static restoreValidated(state: WorldState): Sim {
    earlySteps.clear(); driveFrom.clear();
    const sim = Object.create(Sim.prototype) as Sim;
    sim.world = state;
    sim.rng = new Rng(state.options.seed);
    sim.rng.state = state.rngState;
    sim.accumulator = 0;
    for (const gang of Object.values(state.gangs)) {
      if (!gang.finances) openFinances(state, gang, true);
      currentFinances(state, gang);
    }
    const maximum = (ids: number[]) => ids.reduce((m, id) => Math.max(m, id), 0) + 1;
    const old = state.sequences;
    state.sequences = {
      message: Math.max(old?.message ?? 1, maximum(state.messages.map(x => x.id))),
      crime: Math.max(old?.crime ?? 1, maximum(state.crimes.map(x => x.id))),
      court: Math.max(old?.court ?? 1, maximum(Object.values(state.cases).map(x => x.id))),
    };
    state.schemaVersion = 2;
    repairLegacyStreetSpawns(state);
    repairVehicleRoutes(state);
    restoreLegacyTransport(state);
    reconcileTransport(state);
    normalizeFbiInvestigations(state);
    restoreElectionTiming(state);
    observeTargetRace(state, undefined, 'legacy');
    sim.resolveImmediateOutcome();
    return sim;
  }

  get playerGang(): Gang {
    return Object.values(this.world.gangs).find((g) => g.isPlayer)!;
  }

  // ------------------------------------------------------------ territory

  territoryOwners(blockId: ID): ID[] {
    const block = this.world.blocks[blockId];
    return block ? blockClaimants(this.world, block) : [];
  }

  // ------------------------------------------------------------ week control

  launchWeek(): void {
    const w = this.world;
    if (w.phase !== 'planning') return;
    observeTargetRace(w, undefined, 'boundary');
    if (this.resolveImmediateOutcome()) return;
    recordScorePeaks(w);
    w.phase = 'week';
    w.minute = 0;
    w.messages = [];
    w.weekLog = [];
    this.accumulator = 0;
    for (const gang of Object.values(w.gangs)) {
      const report = currentFinances(w, gang);
      // Carry Monday's planning transactions into this working week.
      gang.lastWeekIncome = { ...report.income };
      gang.lastWeekCosts = { wages: report.costs.wages, upkeep: report.costs.upkeep, purchases: report.costs.purchases };
      gang.riskyMoney = 0;
    }
    beginWeekOrders(w);
    beginSpecialistJobs(w);
    repairVehicleRoutes(w);
    for (const b of buildingList(w)) b.guardIds = b.guardIds.filter((id) => id === -1);
    dispatchFbi(w,this.rng);
  }

  /** Advance the working week. `seconds` is real elapsed time; speed multiplies it. */
  /**
   * How far into the next minute the clock has got, 0..1. Positions only move
   * once a tick; the renderer uses this to draw people part way to where the
   * next tick will put them.
   */
  get subMinute(): number {
    return Math.min(1, this.accumulator);
  }

  /**
   * The coming minute's ambient walking, a slice at a time as the clock moves
   * through the minute: the original spread its people updates over many
   * small ticks (a 30 ms base tick, the heavy people pass every other one),
   * so no single frame carried the whole city. Each slice is a sixth of the
   * people by id; whatever is left runs at the start of the minute's tick, so
   * everyone still steps exactly once a minute whatever the frame rate.
   */
  private ambientSlices(ticked: boolean): void {
    const w = this.world;
    if (w.phase !== 'week' || w.settlementStage != null) return;
    // Nothing more in the frame that ran the tick: the held-over peaks and
    // the slices wait for the frames after it. The slices are spaced at
    // sevenths of the minute, so all six fall between ticks.
    if (ticked) return;
    this.settleDeferred();
    const due = Math.min(AMBIENT_SLICES, Math.floor(Math.min(1, this.accumulator) * (AMBIENT_SLICES + 1)));
    while ((w.ambientSlicesDone ?? 0) < due) {
      const index = w.ambientSlicesDone ?? 0;
      // A slice computes the coming minute's step, so it sees that minute's clock.
      const minute = w.minute, traffic = trafficContext(w);
      w.minute = minute + 1;
      try {
        tickAmbient(w, this.rng, 1, { index, count: AMBIENT_SLICES, early: true, traffic, vehicles: 'skip' });
        scanStreetSlice(w, index, AMBIENT_SLICES);
      } finally { w.minute = minute; }
      w.ambientSlicesDone = index + 1;
    }
  }

  advance(seconds: number, speed: number, budgetMs = Infinity): void {
    const w = this.world;
    if (w.phase !== 'week') return;
    if (w.settlementStage != null && Number.isFinite(budgetMs)) {
      this.endWeekStep();
      w.rngState = this.rng.state;
      return;
    }

    this.accumulator += seconds * MINUTES_PER_SECOND * speed;
    // 10/3 minutes a second is not exact in binary: 0.3 s × 10/3 comes to
    // 0.9999… A millionth of a minute's tolerance keeps whole minutes whole.
    let steps = Math.floor(this.accumulator + 1e-6);
    if (steps <= 0) { this.ambientSlices(false); w.rngState = this.rng.state; return; }
    this.accumulator = Math.max(0, this.accumulator - steps);
    // Never let a stall turn into a thousand-tick catch-up.
    steps = Math.min(steps, 240);

    const deadline = performance.now() + budgetMs;
    for (let i = 0; i < steps; i++) {
      this.tickOnce(Number.isFinite(budgetMs));
      if (this.world.phase !== 'week') break;
      if (w.settlementStage != null || performance.now() >= deadline) {
        this.accumulator += steps - i - 1;
        break;
      }
    }
    this.ambientSlices(true);
    w.rngState = this.rng.state;
  }

  /**
   * Maximum speed, as the original ran it: not a fixed multiple but as many
   * whole ticks as fit in the frame's budget (its busy loop). Nothing is
   * banked for later frames, so slowing down takes effect at once.
   */
  runFlatOut(budgetMs: number, stop?: () => boolean): void {
    const w = this.world;
    if (w.phase !== 'week') return;
    if (w.settlementStage != null) { this.endWeekStep(); w.rngState = this.rng.state; return; }
    this.accumulator = 0;
    const deadline = performance.now() + budgetMs;
    do {
      this.tickOnce(true);
      if (w.phase !== 'week' || w.settlementStage != null || stop?.()) break;
    } while (performance.now() < deadline);
    w.rngState = this.rng.state;
  }

  /** Work held over from the last tick (score peaks): done before anything else reads or changes the world. */
  settleDeferred(): void {
    // Planning-desk actions (an interrogation, a snitch's tip) draw from the
    // stream outside advance(); a save must carry where the stream really is,
    // or a reload replays (and re-rolls) them.
    this.world.rngState = this.rng.state;
    if (!this.peaksDue) return;
    this.peaksDue = false;
    recordScorePeaks(this.world);
  }

  private tickOnce(deferSettlement = false): void {
    const w = this.world;
    this.settleDeferred();
    if (this.resolveImmediateOutcome()) return;
    if (w.settlementStage != null) {
      if (deferSettlement) this.endWeekStep();
      else this.endWeek();
      return;
    }
    // Where the rival men stood before this minute's walking: a protected
    // business sees only a man who walks into its door's cell (sightings.ts).
    // Those the early slices already stepped are taken from where they began.
    const sightingBefore = sightingCells(w, earlySteps);
    earlySteps.clear();
    driveFrom.clear();
    // The closing minute's traffic, for the slices still to run and for the
    // drivers left over from those that ran ahead (already built by them).
    const closingTraffic = trafficContext(w);
    w.minute++;
    // The drivers of the slices that ran ahead (they left their cars for the tick).
    for (let index = 0; index < (w.ambientSlicesDone ?? 0); index++)
      tickAmbient(w, this.rng, 1, { index, count: AMBIENT_SLICES, early: false, traffic: closingTraffic, vehicles: 'only' });
    // The rest of this minute's ambient walking: the slices the clock had not
    // reached before the tick (the others ran ahead, on this minute's clock).
    for (let index = w.ambientSlicesDone ?? 0; index < AMBIENT_SLICES; index++) {
      tickAmbient(w, this.rng, 1, { index, count: AMBIENT_SLICES, early: false, traffic: closingTraffic });
      scanStreetSlice(w, index, AMBIENT_SLICES);
    }
    w.ambientSlicesDone = 0;
    // Pedestrians catch, board, ride and leave the street trams. Off, as in the
    // shipped game, where nothing sets the walk order's riding flag.
    if (TRAM_RIDING) tickTramRiding(w);
    const loadout = allocateWeapons(w);
    const peaceFireExclusions = capturePeaceFireExclusions(w, loadout);

    tickTraffic(w);
    tickGoods(w, 1);
    tickOrders(w, this.rng, 1, loadout);
    if (this.resolveImmediateOutcome()) return;
    tickStreetOrders(w, this.rng, 1, loadout);
    if (this.resolveImmediateOutcome()) return;
    tickBuildingEmergencies(w, this.rng, 1);
    if (this.resolveImmediateOutcome()) return;
    tickFbi(w, this.rng, 1);
    tickSpecialistJobs(w, 1);
    finishMovementTick(w);
    reconcileTransport(w);
    tickCombat(w, this.rng, 1, undefined, loadout, peaceFireExclusions);
    tickSightings(w, this.rng, sightingBefore);
    // The minute's score peaks read only its closing state, which nothing but
    // the player changes before the next tick: they are taken in the first
    // sub-step after it (settleDeferred), not in this frame.
    this.peaksDue = true;
    if (this.resolveImmediateOutcome()) return;

    if (w.minute >= MINUTES_PER_WEEK) {
      w.settlementStage = 0;
      if (!deferSettlement) this.endWeek();
    }
  }

  /** Skip whatever is left of the week. */
  finishWeek(): void {
    const w = this.world;
    if (w.phase !== 'week') return;
    let guard = 0;
    while (w.phase === 'week' && guard++ < MINUTES_PER_WEEK + 10) this.tickOnce();
    w.rngState = this.rng.state;
  }

  /** Run complete ticks within a small UI budget. Tick/RNG order is unchanged. */
  finishWeekSlice(budgetMs = 8): void {
    const deadline = performance.now() + budgetMs;
    if (this.world.phase !== 'week') return;
    do {
      this.tickOnce(true);
    } while (this.world.phase === 'week' && this.world.settlementStage == null && performance.now() < deadline);
    this.world.rngState = this.rng.state;
  }

  // ------------------------------------------------------------ end of week

  private endWeek(): void {
    while (this.world.settlementStage != null) this.endWeekStep();
  }

  private endWeekStep(): void {
    const w = this.world;
    this.settleDeferred();
    observeTargetRace(w, undefined, 'boundary');
    if (this.resolveImmediateOutcome()) return;
    const stage = w.settlementStage ?? 0;
    w.settlementStage = stage + 1;
    switch (stage) {
      case 0: this.failUnfinishedOrders(); settleSpecialistJobs(w); settleBurningEscapes(w, this.rng); break;
      case 1: weeklyEconomy(w, this.rng); break;
      case 2: weeklyTaxes(w, this.rng); break;
      case 3: this.settleAudits(); break;
      case 4: weeklyLaw(w, this.rng); break;
      case 5: weeklyFbi(w, this.rng); break;
      case 6: weeklyOpinion(w, this.rng); break;
      case 7: territoryGoodwill(w); break;
      case 8: weeklyPolitics(w, this.rng); break;
      case 9: weeklyNews(w, this.rng); break;
      case 10: this.updateDiplomacyKnowledge(); break;
      case 11: this.rebuildCommand(); break;
      case 12: this.recordHistory(); break;
      case 13: this.checkSuccession(); break;
      case 14: break; // Reserved settlement stage in historical saves; claims are now live.
      case 15: {
        const outcome = this.checkEndConditions();
        closeFinances(w);
        if (outcome) {
          w.outcome = outcome;
          w.phase = 'gameOver';
          delete w.settlementStage;
          // Release vehicles held by the orders settlement just failed, as the
          // next tick or a restore would: the final save must already agree.
          reconcileTransport(w);
        }
        break;
      }
      case 16:
        resetWeekTransport(w);
        w.week++;
        finishBuildingRepairs(w);
        finishTradingRestarts(w);
        replenishOriginalRecruits(w, this.rng);
        replacePoliceChief(w, this.rng);
        weeklyProtectionFear(w);
        w.minute = 0;
        for (const gang of Object.values(w.gangs)) openFinances(w, gang);
        rolloverOrders(w);
        break;
      default: {
        const gang = Object.values(w.gangs)[stage - 17];
        if (gang) {
          if (!gang.isPlayer && !gang.eliminated) planGang(w, this.rng, gang);
        } else {
          w.minute = 0;
          w.phase = 'planning';
          this.accumulator = 0;
          delete w.settlementStage;
        }
      }
    }
    recordScorePeaks(w);
    observeTargetRace(w, undefined, 'boundary');
    this.resolveImmediateOutcome();
  }

  private failUnfinishedOrders(): void {
    const w = this.world;
    for (const order of Object.values(w.orders)) {
      if (order.state === 'done' || order.state === 'failed' || order.state === 'cancelled') continue;
      recoverExportGoods(w, order, !order.assignedIds.some(id => w.people[id]?.status === 'active'));
      const neverStarted = order.state === 'queued';
      const standingDuty = order.workedMinutes != null ? order.workedMinutes > 0 : order.state === 'executing';
      if (ORDERS[order.type].wholeWeek && !neverStarted && standingDuty) {
        order.state = 'done';
        // Report actual performed duty, never a fictional full week. Historical
        // saves lack a duration, so preserve their activity without inventing it.
          const blocks = standingBlocks(w, order).length || 1;
          const where =
            order.type === 'guardBusiness' && order.targetBuildingIds[0] != null
              ? placeName(w, w.buildings[order.targetBuildingIds[0]])
              : `${blocks} block${blocks === 1 ? '' : 's'}`;
          const duration = order.workedMinutes == null ? '' : ` for ${Math.round(order.workedMinutes)} minutes`;
          order.results.push(
            order.type === 'guardBusiness'
              ? `Stood guard at ${where}${duration}.`
              : order.type === 'patrol'
                ? `Patrolled ${where}${duration}.`
                : order.type === 'ambush'
                  ? `Lay in wait over ${where}${duration}.`
                  : `Held position${duration}.`,
          );
      } else if (order.completedTargets > 0) {
        order.state = 'done';
        order.failReason = 'Ran out of week before finishing every target.';
      } else {
        order.state = 'failed';
        order.failReason = order.failReason ?? (neverStarted
          ? `The order never started. ${order.dispatchWaitReason ?? 'No crew was available before the week ended.'}`
          : 'There was not enough time in the week to perform the order.');
      }
      delete order.dispatchWaitReason;
      for (const id of order.assignedIds) {
        const p = w.people[id];
        if (p?.orderId === order.id) p.orderId = null;
      }
    }
    for (const p of peopleList(w)) {
      p.streetOrder = null;
      if (p.status === 'beaten') p.status = 'active';
      delete p.beatenUntil;
      delete p.resumeOrderId;
      if (p.status !== 'dead') p.hp = Math.min(100, p.hp + 35);
    }
  }

  private settleAudits(): void {
    const w = this.world;
    for (const gang of Object.values(w.gangs)) {
      const targetId = w.auditTargets[gang.id];
      w.auditResults[gang.id] = null;
      if (targetId == null) continue;
      delete w.auditTargets[gang.id];
      const target = w.people[targetId];
      const acct = availableSpecialist(w, gang, 'accountant');
      const visited = Object.values(w.specialistJobs ?? {}).some(j => j.week === w.week && j.gangId === gang.id && j.type === 'audit' && j.state === 'done' && j.targetPersonId === targetId);
      if (!visited || !target || target.status === 'dead' || target.gangId !== gang.id || !acct) {
        const message = 'The audit could not be completed: the accountant or subject is no longer available.';
        if (gang.isPlayer) { w.weekLog.push(`${gang.name}: ${message}`); addMessage(w, 'failed', message); }
        continue;
      }

      const takings = w.personTakings?.[targetId];
      const declared = takings?.week === w.week ? takings.declared : 0;
      const actual = takings?.week === w.week ? takings.gross : 0;
      w.auditResults[gang.id] = { personId: targetId, brought: actual, declared };
    }
  }

  private updateDiplomacyKnowledge(): void {
    const w = this.world;
    for (const gang of Object.values(w.gangs)) {
      for (const other of Object.values(w.gangs)) {
        if (other.id === gang.id) continue;
        // What a boss believes about a rival is always a week behind the street.
        gang.known[other.id] = other.offered[gang.id] ?? 'peace';
      }
    }
  }

  private recordHistory(): void {
    const w = this.world;
    recordScorePeaks(w);
    for (const gang of Object.values(w.gangs)) {
      const crimes = w.crimes.filter((c) => c.week === w.week && c.gangId === gang.id && !c.charge).length;
      gang.history.push({
        week: w.week,
        power: powerRating(w, gang),
        assets: gangAssets(w, gang),
        cash: gang.cash,
        territory: territoryCount(w, gang.id),
        manpower: gangManpower(w, gang),
        loyalty: gangLoyalty(w, gang),
        crimes,
        suspicion: Math.round(gang.suspicion),
      });
      if (gang.history.length > 40) gang.history.shift();
    }
  }

  /**
   * Nobody stays leaderless. A gang left without a lieutenant promotes whoever
   * is left, and a gang with nobody at all finds men willing to sign on —
   * otherwise one bad week would end a boss's career with no way back.
   */
  private rebuildCommand(): void {
    const w = this.world;
    for (const gang of Object.values(w.gangs)) {
      if (gang.eliminated) continue;
      const boss = w.people[gang.bossId];
      if (!boss) continue;

      // A crew whose lieutenant is inside needs somebody to take over.
      for (const t of teamsOf(w, gang)) {
        const lt = w.people[t.lieutenantId];
        const away = !lt || lt.status === 'dead' || lt.status === 'jailed' || lt.status === 'kidnapped';
        if (away) replaceLieutenant(w, gang, t);
      }

      const liveTeams = teamsOf(w, gang).filter((t) => {
        const lt = w.people[t.lieutenantId];
        return lt && lt.status !== 'dead' && lt.status !== 'jailed' && lt.status !== 'kidnapped';
      });

      if (!liveTeams.length) {
        // Anybody still on the books can step up.
        const candidates = [
          ...gang.poolIds.map((id) => w.people[id]),
          ...ownedBuildings(w, gang.id)
            .filter((b) => b.managerId != null)
            .map((b) => w.people[b.managerId!]),
        ].filter((p) => p && p.status === 'active');

        if (candidates.length) {
          candidates.sort(
            (a, b) =>
              b.skills.organization + b.skills.intelligence - (a.skills.organization + a.skills.intelligence),
          );
          const heir = candidates[0];
          if (heir.buildingId != null) {
            const site = w.buildings[heir.buildingId];
            if (site && site.managerId === heir.id) site.managerId = null;
            heir.buildingId = null;
          }
          promoteToLieutenant(w, gang, heir);
          w.weekLog.push(`${heir.name} took charge of a crew for ${gang.name}.`);
        }
      }

      // Word gets around when a boss is hiring.
      const men = gangManpower(w, gang);
      if (men < 2 && gang.cash > 300 && gang.recruitIds.length < 2) {
        const willing = peopleList(w).filter(
          (p) =>
            p.gangId == null &&
            p.status === 'active' &&
            p.role === 'hood' &&
            !gang.recruitIds.includes(p.id),
        );
        for (let i = 0; i < Math.min(2, willing.length); i++) {
          gang.recruitIds.push(willing[i].id);
        }
        if (willing.length && gang.isPlayer) {
          w.weekLog.push('Word is out that you are hiring. Men have come forward.');
        }
      }
    }
  }

  /** A dead boss is replaced by his best lieutenant — if he has one. */
  private checkSuccession(): void {
    const w = this.world;
    for (const gang of Object.values(w.gangs)) {
      if (gang.eliminated) continue;
      const boss = w.people[gang.bossId];
      // A boss doing life is as gone as a dead one, as far as the gang is
      // concerned — somebody has to run things while he is inside.
      const bossGone =
        !boss || boss.status === 'dead' || (boss.status === 'jailed' && boss.jailWeeks >= 999);
      if (!bossGone) continue;
      // The player has no successor: losing the boss is how the player's game
      // ends, and checkEndConditions is what reports it.
      if (gang.isPlayer) continue;

      // Anybody still standing can take over: a lieutenant first, then a hood,
      // a man from the pool, or whoever is minding a shop. A gang with eighty
      // businesses does not dissolve because its leader is in prison.
      const candidates = [
        ...teamsOf(w, gang).map((t) => w.people[t.lieutenantId]),
        ...teamsOf(w, gang).flatMap((t) => t.memberIds.map((id) => w.people[id])),
        ...gang.poolIds.map((id) => w.people[id]),
        ...ownedBuildings(w, gang.id)
          .filter((b) => b.managerId != null)
          .map((b) => w.people[b.managerId!]),
      ]
        .filter(
          (p): p is NonNullable<typeof p> =>
            !!p &&
            p.status !== 'dead' &&
            !(p.status === 'jailed' && p.jailWeeks >= 999) &&
            p.id !== gang.bossId,
        )
        .sort(
          (a, b) =>
            // A free man before one in a cell, on trial or held by a rival.
            Number(b.status === 'active' || b.status === 'beaten') - Number(a.status === 'active' || a.status === 'beaten') ||
            b.skills.organization + b.skills.intelligence - (a.skills.organization + a.skills.intelligence),
        );
      const lieutenants = candidates;

      if (lieutenants.length) {
        const heir = lieutenants[0];
        if (heir.buildingId != null) {
          const site = w.buildings[heir.buildingId];
          if (site && site.managerId === heir.id) site.managerId = null;
          heir.buildingId = null;
        }
        gang.poolIds = gang.poolIds.filter((id) => id !== heir.id);
        gang.bossId = heir.id;
        heir.role = 'boss';
        if (heir.teamId != null && w.teams[heir.teamId]?.lieutenantId !== heir.id) {
          // He was a rank-and-file hood; just take him out of the crew.
          const crew = w.teams[heir.teamId];
          if (crew) crew.memberIds = crew.memberIds.filter((id) => id !== heir.id);
        } else if (heir.teamId != null) {
          const t = w.teams[heir.teamId];
          if (t) {
            // His old crew needs a new lieutenant.
            const next = t.memberIds.map((id) => w.people[id]).filter((p) => p && p.status === 'active')[0];
            disbandTeam(w, gang, t.id, false);
            if (next) promoteToLieutenant(w, gang, next);
          }
        }
        heir.teamId = null;
        addNews(w, {
          section: 'front',
          headline: 'NEW HAND AT THE TOP',
          frontPagePriority: 2,
          body: `${heir.name} is said to have taken control of ${gang.name} following the removal of its leader.`,
          gangId: gang.id,
        });
        w.weekLog.push(`${heir.name} has taken over ${gang.name}.`);
      } else {
        gang.eliminated = true;
        releaseGangHoldings(w, gang.id);
        // Its story is this one, not "BROKE!" in next week's paper.
        (gang.pressMilestones ??= []).push('broke');
        w.weekLog.push(`${gang.name} has been wiped out.`);
        addNews(w, {
          section: 'front',
          headline: 'GANG BROKEN UP',
          frontPagePriority: 2,
          body: `${gang.name} has ceased to exist after the death of its leader and the loss of its territory.`,
          gangId: gang.id,
        });
      }
    }

    // A gang with nothing left is finished whether its boss lives or not.
    for (const gang of Object.values(w.gangs)) {
      if (gang.eliminated || gang.isPlayer) continue;
      const men = gangManpower(w, gang);
      const terr = territoryCount(w, gang.id);
      const wealth = gangWealth(w, gang);
      if (men === 0 && terr === 0 && wealth < 1500) {
        gang.eliminated = true;
        releaseGangHoldings(w, gang.id);
        w.weekLog.push(`${gang.name} has collapsed.`);
      }
    }
  }

  // ------------------------------------------------------------ endings

  /** Defeat must not leave a playable dead-boss week or permit another action.
   * A previously recorded target keeps its established event precedence. */
  resolveImmediateOutcome(): boolean {
    if (this.resolveTargetRace()) return true;
    const loss = this.checkLossConditions();
    if (!loss) return false;
    this.finishGame(loss);
    return true;
  }

  private finishGame(outcome: NonNullable<WorldState['outcome']>): void {
    const w = this.world;
    w.outcome = outcome;
    closeFinances(w);
    w.phase = 'gameOver';
    delete w.settlementStage;
    reconcileTransport(w);
    this.accumulator = 0;
  }

  /** Resolve a recorded target after its atomic event, before later work. */
  resolveTargetRace(): boolean {
    const w = this.world;
    if (w.phase === 'gameOver') return true;
    const race = w.targetRace;
    if (!race) return false;
    const winner = w.gangs[race.gangId], won = winner.isPlayer;
    const objective = race.mode === 'wealth'
      ? `${money(race.target)} in total wealth` : `${race.target} block${race.target === 1 ? '' : 's'} of New Temperance`;
    const reason = race.tiedGangIds.length > 1
      ? `${won ? 'You' : winner.name} won the tie-break for the ${objective} target.`
      : race.basis === 'legacy'
        ? `${won ? 'You have' : `${winner.name} has`} reached ${objective} in this saved game.`
        : `${won ? 'You' : winner.name} reached ${objective} first.`;
    this.finishGame(this.makeOutcome(won, reason, won ? 45 : 0)!);
    return true;
  }

  private checkLossConditions(includeInsolvency = false): WorldState['outcome'] {
    const w = this.world;
    const player = this.playerGang;
    const boss = w.people[player.bossId];

    // ---- losing
    if (!boss || boss.status === 'dead') {
      return this.makeOutcome(false, 'You were killed. Somebody else runs this city now.');
    }
    if (boss.status === 'jailed' && boss.jailWeeks >= 999) {
      return this.makeOutcome(false, 'You were convicted and sent down for a long stretch.');
    }
    // Insolvency retains its weekly settlement boundary: receipts may still
    // arrive during the week. Ordinary immediate checks remain O(1).
    if (includeInsolvency && player.cash < 0 && gangManpower(w, player) === 0 && gangWealth(w, player) < 1000) {
      return this.makeOutcome(false, 'You are bankrupt and alone. The city has moved on.');
    }
    if (w.electionWinnerGangId != null && w.electionWinnerGangId !== player.id) {
      return this.makeOutcome(false, 'A rival was elected Mayor. This is their city now.');
    }
    return null;
  }

  private checkEndConditions(): WorldState['outcome'] {
    const loss = this.checkLossConditions(true);
    if (loss) return loss;
    const w = this.world, player = this.playerGang;

    // ---- winning
    if (w.options.mode === 'normal' && w.electionWinnerGangId === player.id) {
      return this.makeOutcome(true, 'You were elected Mayor of New Temperance.', 35);
    }

    const rivals = Object.values(w.gangs).filter((g) => !g.isPlayer && !g.eliminated);
    if (!rivals.length) {
      return this.makeOutcome(true, 'Every rival gang has been wiped out. The city is yours.', 45);
    }
    // Two survivors in a firm alliance also counts as settling the question.
    if (rivals.length === 1) {
      const other = rivals[0];
      if (player.offered[other.id] === 'alliance' && player.known[other.id] === 'alliance') {
        return this.makeOutcome(true, 'You and your last rival have carved the city in two.', 45);
      }
    }

    if (player.goingStraight && w.options.mode === 'normal' && canGoStraight(w, player.id).can) {
      return this.makeOutcome(true, 'You went straight, with every dollar accounted for.', 25);
    }

    // ---- short game targets
    if (w.options.mode === 'power' && w.week >= w.options.powerWeeks) {
      const ranked = Object.values(w.gangs)
        .filter((g) => !g.eliminated)
        // An equal rating is settled by the seeded lot, not by the player's
        // gang being made first.
        .sort((a, b) => powerRating(w, b) - powerRating(w, a) || tieRank(w.options.seed, a.id) - tieRank(w.options.seed, b.id) || a.id - b.id);
      const top = ranked[0];
      return top?.isPlayer
        ? this.makeOutcome(true, 'When the clock ran out you were the most powerful boss in the city.', 45)
        : this.makeOutcome(false, `${top?.name ?? 'A rival'} ended the period stronger than you.`);
    }

    return null;
  }

  private makeOutcome(won: boolean, reason: string, winBonus = 0): WorldState['outcome'] {
    const w = this.world;
    const player = this.playerGang;
    recordScorePeaks(w);
    const current = scoreMeasures(w, player);
    const score = finalScore(current, player.scorePeaks ?? current, won, winBonus);

    addMessage(w, 'waiting', reason);
    return { won, reason, score };
  }

  // ------------------------------------------------------------ ai

  private planAi(): void {
    for (const gang of Object.values(this.world.gangs)) {
      if (gang.isPlayer || gang.eliminated) continue;
      planGang(this.world, this.rng, gang);
    }
  }
}
