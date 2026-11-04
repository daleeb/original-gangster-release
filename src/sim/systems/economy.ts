import { effectiveHostility, fearOf, hostilityOf, LEFT_GANG, opinionSet, setAttitude, shiftAttitude } from '../attitudes';
import { ECONOMY_MULT } from '../constants';
import { goodsRetailer } from '../goodsStorage';
import { BUILDING_BY_ID } from '../data/buildings';
import { addMessage } from '../events';
import { currentFinances, payCash, receiveCash, recordRiskyIncome, recordTakings, skimRate } from '../finances';
import { ORIGINAL_DESERTION_LOYALTY, originalRetainerFloor, originalSkimFraction, originalWeeklyWage } from '../originalWages';
import { businessCarryingCost } from '../businessState';
import { rememberAccountantTax } from './taxes';
export { skimRate } from '../finances';
import { reclaimStaffVehicle } from '../specialists';
import { settleElectionCampaign, withdrawUnavailableCandidates } from './politics';
import type { Rng } from '../rng';
import type { Building, Gang, ID, Person, WorldState } from '../types';
import { disbandTeam } from '../execution';
import { allBuildings, gangMembers, ownedBuildings, teamsOf } from '../world';

export function businessProfit(w: WorldState, b: Building, rng: Rng): number {
  const t = BUILDING_BY_ID[b.typeId];
  if (!t) return 0;
  if (b.state !== 'trading') return 0;
  if (b.cls === 'municipal') return 0;

  const blk = w.blocks[b.blockId];
  const econ = ECONOMY_MULT[w.options.economy];
  const market = rng.range(0.82, 1.2);
  const location = 0.55 + blk.landValue / 110;
  const slum = 1 - Math.min(0.35, blk.squalor / 220);

  let profit = t.profit * econ * market * location * slum;

  // A speakeasy is only worth having if there is liquor behind the bar.
  if (t.id === 'speakeasy') {
    const supply = Math.min(1, b.stock.liquor / 40);
    profit *= 0.25 + supply * 0.75;
  }

  if (b.ownerGangId != null && b.managerId != null && profit > 0) {
    const mgr = w.people[b.managerId];
    if (mgr) {
      profit *= 0.45 + mgr.skills.business * 0.16 + mgr.skills.organization * 0.05;
    }
  }
  // A manager recalled to base takes the week's takings with him.
  if (b.ownerGangId != null && b.managerRecalledWeek === w.week) return 0;
  return Math.round(profit);
}

/** The full weekly financial settlement for every gang. */
export function weeklyEconomy(w: WorldState, rng: Rng): void {
  withdrawUnavailableCandidates(w);
  // Income booked during the working week — protection, raids, exports, sales —
  // is already in these totals; launchWeek is what clears them. Only the
  // wage and upkeep lines are recomputed here.
  for (const gang of Object.values(w.gangs)) {
    gang.lastWeekCosts = { wages: 0, purchases: gang.lastWeekCosts.purchases, upkeep: 0 };
  }

  // ---------------------------------------------------------- trading
  for (const b of allBuildings(w)) {
    if (b.ownerGangId == null) {
      b.lastProfit = 0;
      continue;
    }
    const gang = w.gangs[b.ownerGangId];
    if (!gang) continue;

    let profit = businessProfit(w, b, rng);
    let laundered = 0;

    // Speakeasies drink their way through the stock.
    if (b.typeId === 'speakeasy' && b.state === 'trading') {
      b.stock.liquor = Math.max(0, b.stock.liquor - 40);
    }
    // Counterfeit money is passed off as change; stolen goods are fenced.
    const t = BUILDING_BY_ID[b.typeId];
    if (t && b.cls !== 'illegal' && b.state === 'trading') {
      if (b.stock.counterfeit > 0 && goodsRetailer(b,'counterfeit')) {
        const passed = Math.min(b.stock.counterfeit, 2);
        b.stock.counterfeit -= passed;
        profit += passed * 620;
        laundered += passed * 620;
      }
      if (b.stock.stolen > 0 && goodsRetailer(b,'stolen')) {
        const sold = Math.min(b.stock.stolen, 12);
        b.stock.stolen -= sold;
        profit += sold * 40;
        laundered += sold * 40;
      }
    }

    // Skimming: what the manager turns in is not always what he took.
    let declared = profit;
    if (b.managerId != null) {
      const mgr = w.people[b.managerId];
      if (mgr && profit > 0) {
        // The original's runner banking rule (0x4C3AA0) in the original city.
        const rate = w.cityLayout?.original ? originalSkimFraction(mgr, gang.id) : skimRate(mgr.loyalty, mgr.skills.organization);
        declared = Math.round(profit * (1 - rate));
      }
    }

    b.lastProfit = declared;
    if (b.managerId != null && w.people[b.managerId]) recordTakings(w, b.managerId, profit, declared);
    if (b.cls === 'illegal') {
      receiveCash(w, gang, 'illegal', declared);
    } else {
      receiveCash(w, gang, 'legal', declared);
      if (laundered > 0) {
        b.launderingWeek = w.week;
        recordRiskyIncome(w, gang, laundered * (profit > 0 ? declared / profit : 1));
      }
    }
    // Finish this receipt's bookkeeping, then stop before another business or
    // wages can replace the first gang to reach the target.
    if (w.targetRace) return;
  }

  // ---------------------------------------------------------- costs
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;

    let wages = 0;
    for (const p of gangMembers(w, gang)) {
      if (p.role === 'boss') continue;
      wages += p.pay;
    }
    // Loss-making businesses already deducted their operating result above.
    // Charging the catalogue's negative profit here would bill it twice.
    const closedSites = ownedBuildings(w,gang.id).filter(b=>b.state==='ceased')
      .reduce((total,b)=>total+businessCarryingCost(b),0);
    gang.lastWeekCosts.upkeep += closedSites;
    // Original city: officials are paid by their own ladder after wages
    // (0x75DA90), not with the rest of the upkeep.
    const original = !!w.cityLayout?.original;
    if (!original) for (const id of gang.employedPoliceIds) {
      const o = w.people[id];
      if (o && o.status === 'active') gang.lastWeekCosts.upkeep += o.weeklyRetainer;
    }

    const owed = wages + gang.lastWeekCosts.upkeep;
    let paidFraction = 1;
    if (gang.cash < owed) {
      paidFraction = gang.cash >= owed / 2 ? 0.5 : 0;
    }
    const actuallyPaid = Math.round(owed * paidFraction);
    const paidWages = Math.round(wages * paidFraction);
    // Report what left the safe, including partial retainers and rounding.
    gang.lastWeekCosts.upkeep = 0;
    payCash(w, gang, 'wages', paidWages);
    payCash(w, gang, 'upkeep', actuallyPaid - paidWages);
    const report = currentFinances(w,gang);
    report.closedSiteUpkeep = (report.closedSiteUpkeep ?? 0) +
      Math.min(actuallyPaid-paidWages,Math.round(closedSites*paidFraction));

    if (original) payOfficialRetainers(w, gang);
    settleElectionCampaign(w, gang);

    applyLoyalty(w, gang, paidFraction);
    if (paidFraction < 1 && gang.isPlayer) {
      const text = paidFraction === 0
        ? 'Your people were not paid at all this week.'
        : 'Your people received only half pay this week.';
      // Settled after the week's last tick: the week log is what planning shows.
      w.weekLog.push(text);
      addMessage(w, 'failed', text);
    }
  }

}

/**
 * 0x75DA90, the lawyer's weekly pass over officials on the payroll.
 *
 * The list is first sorted (0x764120, comparator 0x4087A1 → 0x7610B0) by each
 * official's eff 0x5A4400 toward the gang, most hostile first; the original's
 * quicksort is not stable, ties keep our hire order. Then, for each official:
 *  1. his fear toward the gang falls by 32 for every official who has quit so
 *     far in this pass (0x5A42E0 setter, clamped at 0);
 *  2. a fee below the floor `((eff >> 1) + 50) / 5` adds the shortfall to his
 *     hostility (vt+0x6C). Fees are in the original's dollars, the same units
 *     as the hire's quote `(eff >> 1) + 50` (0x75D3B0), so the floor is only
 *     reached by fees set some other way (compact-city hires, old saves);
 *  3. if hostility − fear is over 128 he quits, gaining 32 hostility;
 *  4. otherwise he is paid in full while the safe covers the running total;
 *     one who was short-paid before gets back the hostility the cut added. The
 *     first one it cannot cover is paid half and grows hostility by half its
 *     value. Each one after that is offered half too; if the safe cannot cover
 *     even that, he is let go with his (already raised) hostility added again,
 *     and so is everyone after him.
 * A quitter is only unlinked from the paid list: the original leaves his
 * payroll bit (+0x90) set. We let him go outright.
 */
export function payOfficialRetainers(w: WorldState, gang: Gang): void {
  const eff = new Map<ID, number>();
  for (const id of gang.employedPoliceIds) {
    const o = w.people[id];
    eff.set(id, o && o.status === 'active' ? effectiveHostility(o, gang.id) : -1);
  }
  gang.employedPoliceIds = [...gang.employedPoliceIds].sort((a, b) => eff.get(b)! - eff.get(a)!);
  let total = 0, stage = 0, fearLost = 0;
  for (const id of [...gang.employedPoliceIds]) {
    const o = w.people[id];
    if (!o || o.status !== 'active') continue;
    if (fearLost) setAttitude(o, gang.id, { fear: fearOf(o, gang.id) - fearLost });
    const shortfall = originalRetainerFloor(o, gang.id) - o.weeklyRetainer;
    if (shortfall > 0) shiftAttitude(o, gang.id, shortfall, 0);
    if (hostilityOf(o, gang.id) - fearOf(o, gang.id) > 128) {
      shiftAttitude(o, gang.id, 32, 0); fearLost += 32;
      // Unlinked from the list, but his payroll bit stays set (payrollMark.ts).
      if (!(o.quitPayrollOf ??= []).includes(gang.id)) o.quitPayrollOf.push(gang.id);
      letGo(w, gang, o, 'has quit your payroll');
      continue;
    }
    const half = Math.floor(o.weeklyRetainer / 2);
    if (stage === 0) {
      total += o.weeklyRetainer;
      if (gang.cash - total >= 0) {
        if (o.retainerShort) { shiftAttitude(o, gang.id, -(hostilityOf(o, gang.id) >> 1), 0); delete o.retainerShort; }
        continue;
      }
      total -= o.weeklyRetainer - half;
      shiftAttitude(o, gang.id, hostilityOf(o, gang.id) >> 1, 0); o.retainerShort = true;
      stage = 1;
    } else if (stage === 1) {
      total += half;
      shiftAttitude(o, gang.id, hostilityOf(o, gang.id) >> 1, 0); o.retainerShort = true;
      if (gang.cash - total >= 0) continue;
      total -= half;
      shiftAttitude(o, gang.id, hostilityOf(o, gang.id), 0);
      letGo(w, gang, o, 'was let go when the retainer could not be paid');
      stage = 2;
    } else {
      shiftAttitude(o, gang.id, hostilityOf(o, gang.id), 0);
      letGo(w, gang, o, 'was let go when the retainer could not be paid');
    }
  }
  // The first short-paid official is not re-checked: half his fee is paid even
  // if that overdraws the safe, as in the original.
  if (total > 0) payCash(w, gang, 'upkeep', total);
}

function letGo(w: WorldState, gang: Gang, o: Person, why: string): void {
  o.employedBy = null; o.weeklyRetainer = 0; delete o.retainerShort;
  gang.employedPoliceIds = gang.employedPoliceIds.filter(id => id !== o.id);
  if (gang.isPlayer) w.weekLog.push(`${o.name} ${why} (${gang.name}).`);
  if (gang.isPlayer) addMessage(w, 'police', `${o.name} ${why}.`, o.pos, o.id);
}

function applyLoyalty(w: WorldState, gang: Gang, paidFraction: number): void {
  for (const p of gangMembers(w, gang)) {
    if (p.role === 'boss') continue;
    if (paidFraction < 1 && w.cityLayout?.original) {
      // 0x6D3D20: half pay costs the crew +8 hostility toward the gang and 16
      // loyalty; no pay +32 and 48 (loyalty bytes, scaled onto our 0..100).
      const none = paidFraction === 0;
      shiftAttitude(p, gang.id, none ? 32 : 8, 0);
      p.loyalty -= (none ? 48 : 16) * 100 / 255;
    } else if (paidFraction < 1) {
      p.loyalty -= paidFraction === 0 ? 16 : 8;
    }
    if (w.cityLayout?.original) {
      // 0x460300 steps 6–7: the original quote, ratchet and satisfaction.
      originalWeeklyWage(p, gang.id);
      p.loyalty = Math.max(0, Math.min(100, p.loyalty));
      continue;
    }
    if (paidFraction < 1) {
      // (applied above)
    } else if (p.pay >= p.payDemand) {
      p.loyalty = Math.min(100, p.loyalty + 3);
    } else {
      // Underpaid but not unpaid: resentment builds, and demands rise.
      const shortfall = (p.payDemand - p.pay) / Math.max(1, p.payDemand);
      p.loyalty -= shortfall * 12;
    }
    // Ambition: good hoods ask for more over time.
    if (w.week % 4 === 0) p.payDemand = Math.round(p.payDemand * 1.04);
    p.loyalty = Math.max(0, Math.min(100, p.loyalty));
  }

  // Desertions.
  for (const p of gangMembers(w, gang)) {
    if (p.role === 'boss' || p.loyalty > (w.cityLayout?.original ? ORIGINAL_DESERTION_LOYALTY : 14)) continue;
    defect(w, gang, p.id);
    if (gang.isPlayer) w.weekLog.push(`${p.name} walked out on ${gang.name}.`);
    if (gang.isPlayer) addMessage(w, 'failed', `${p.name} has deserted you.`);
  }
}

export function defect(w: WorldState, gang: Gang, personId: ID): void {
  const p = w.people[personId];
  if (!p) return;
  if (gang.accountantId === personId) rememberAccountantTax(w, gang);
  p.gangId = null;
  p.loyalty = 50;
  if (p.role === 'lieutenant') p.role = 'hood';
  opinionSet(p, gang.id, Math.min(-30, (p.opinion[gang.id] ?? 0) - 30), LEFT_GANG);
  if (p.teamId != null) {
    const t = w.teams[p.teamId];
    if (t) t.memberIds = t.memberIds.filter((id) => id !== personId);
  }
  p.teamId = null;
  gang.poolIds = gang.poolIds.filter((id) => id !== personId);
  if (gang.accountantId === personId) { reclaimStaffVehicle(w, gang, 'accountant'); gang.accountantId = null; }
  if (gang.lawyerId === personId) { reclaimStaffVehicle(w, gang, 'lawyer'); gang.lawyerId = null; }
  if (p.buildingId != null) {
    const b = w.buildings[p.buildingId];
    if (b && b.managerId === personId) b.managerId = null;
    p.buildingId = null;
  }
  // A lieutenant walking out sends his whole crew back to the pool — and takes
  // his orders off the books with him.
  for (const t of teamsOf(w, gang)) {
    if (t.lieutenantId !== personId) continue;
    disbandTeam(w, gang, t.id, false);
  }
}
