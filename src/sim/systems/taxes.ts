import { addMessage } from '../events';
import { currentFinances, payCash } from '../finances';
import { availableSpecialist } from '../specialists';
import type { Rng } from '../rng';
import type { CrimeRecord, FinanceReport, Gang, Person, WorldState } from '../types';
import { peopleList, buildingList } from '../entityLists';

/** Preserve the accountant's knowledge when dismissed/replaced, including older saves. */
export function rememberAccountantTax(w: WorldState, gang: Gang): void {
  const p = gang.accountantId == null ? null : w.people[gang.accountantId];
  if (!p || p.role !== 'accountant' || p.gangId !== gang.id || p.status === 'dead') return;
  (p.taxRecords ??= {})[gang.id] = gang.uncoveredTax;
}

export function weeklyTaxes(w: WorldState, rng: Rng): void {
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;
    rememberAccountantTax(w, gang);
    const report = currentFinances(w, gang);
    const original = !!w.cityLayout?.original;
    const accountant = availableSpecialist(w, gang, 'accountant');
    // Original city: 0x6CFB30's boss levy is 20% of the whole weekly ledger
    // net (every income less wages, purchases, upkeep and campaign), not the
    // remake's 24% of operating profit.
    const tax = original ? originalLevy(report) : Math.round(Math.max(0, report.taxableProfit!) * .24);
    const previous = gang.lastFinanceReport;
    const legal = previous?.week === w.week - 1 ? Math.max(0, previous.income.legal) : 0;
    // Rates are remake tuning; prior legal income and later cover are manual rules.
    const capacity = accountant ? Math.round(legal * (.1 + accountant.skills.intelligence * .05)) : 0;
    const covered = Math.min(gang.uncoveredTax, capacity);
    gang.uncoveredTax -= covered;
    gang.exposedTax = Math.max(0, (gang.exposedTax ?? 0) - covered);
    if (covered > 0) for (const p of peopleList(w)) {
      if (p.taxRecords?.[gang.id] != null) p.taxRecords[gang.id] = Math.max(0, p.taxRecords[gang.id] - covered);
    }
    const availableCover = capacity - covered;
    let evaded = 0;
    if (original && accountant && (gang.evadingTax || !gang.isPlayer)) {
      // 0x4BF180: the accountant saves levy·skill/256 (an AI gang's always
      // does; the player's when told to) into the laundering pool (+0x830).
      evaded = Math.floor(tax * accountantSkillByte(accountant.skills.intelligence) / 256);
      gang.launderPool = (gang.launderPool ?? 0) + evaded;
    } else if (gang.evadingTax && accountant) {
      evaded = Math.min(tax, availableCover);
      // Occasionally more is held back than can be hidden, to cover in later weeks.
      if (capacity > 0 && evaded < tax && rng.chance(.18)) evaded += Math.min(tax - evaded, Math.round(tax * .3));
      gang.uncoveredTax += Math.max(0, evaded - availableCover);
    }
    if (original) launderPool(w, gang, report, accountant ?? null);
    payCash(w, gang, 'tax', tax - evaded);
    gang.taxEvaded.push(evaded);
    gang.taxEvaded = gang.taxEvaded.slice(-8);
    if (accountant) rememberAccountantTax(w, gang);
  }
}

/** Held-back tax not yet hidden: the laundering pool in the original city. */
export function taxNotCoveredUp(w: WorldState, gang: Gang): number {
  return w.cityLayout?.original ? Math.max(0, gang.launderPool ?? 0) : gang.uncoveredTax;
}

/**
 * The original city's laundering pool. 0x4BEF30: a free accountant launders it
 * down by the week's business takings × intelligence/31 (never below 0).
 * 0x6CFB30: what is left raises the suspicion byte of every premises the gang
 * holds by (pool − 1000)/1000 a week (C division: nothing below $2,000).
 */
export function launderPool(w: WorldState, gang: Gang, report: FinanceReport, accountant: Person | null): void {
  let pool = gang.launderPool ?? 0;
  if (accountant) pool = Math.max(0, pool - Math.trunc(Math.max(0, report.income.legal) * accountantSkillByte(accountant.skills.intelligence) / 31));
  gang.launderPool = pool;
  const rise = Math.trunc((pool - 1000) / 1000);
  if (rise <= 0) return;
  for (const b of buildingList(w))
    if (b.ownerGangId === gang.id && b.state !== 'destroyed') b.fbiSuspicion = Math.min(255, (b.fbiSuspicion ?? 0) + rise);
}

/** The original's levy base: every ledger income less every non-tax cost. */
export function originalLevy(report: FinanceReport): number {
  const income = Object.values(report.income).reduce((a, b) => a + b, 0);
  // Upkeep already includes the campaign bill (campaignCost is a share of it).
  const costs = report.costs.wages + report.costs.purchases + report.costs.upkeep;
  const net = income - costs;
  return net < 0 ? 0 : Math.trunc(20 * net / 100);
}

/** Our 0.5..5-star intelligence onto the original accountant's 0..255 byte. */
export const accountantSkillByte = (stars: number) => Math.round(Math.max(0, Math.min(5, stars)) / 5 * 255);

/** An arrested accountant can implicate a former employer, but not repeatedly. */
export function exposeTaxRecords(w: WorldState): CrimeRecord[] {
  const crimes: CrimeRecord[] = [];
  for (const gang of Object.values(w.gangs)) rememberAccountantTax(w, gang);
  for (const p of peopleList(w)) {
    if (p.role !== 'accountant' || !['arrested', 'onTrial', 'jailed'].includes(p.status)) continue;
    for (const [id, recorded] of Object.entries(p.taxRecords ?? {})) {
      const gang = w.gangs[Number(id)], boss = gang && w.people[gang.bossId];
      if (!gang || gang.eliminated || !boss || boss.status === 'dead') continue;
      const disclosed = Math.min(recorded, gang.uncoveredTax);
      const fresh = Math.max(0, disclosed - (gang.exposedTax ?? 0));
      if (!fresh) continue;
      gang.exposedTax = disclosed;
      gang.evidence = Math.min(100, gang.evidence + Math.max(1, fresh / 500));
      gang.suspicion = Math.min(100, gang.suspicion + fresh / 1000);
      const crime: CrimeRecord = { id: w.sequences.crime++, week: w.week, gangId: gang.id, perpetratorId: boss.id,
        kind: 'taxEvasion', buildingId: null, victimId: null, witnesses: [p.id],
        arrestRisk: Math.min(.85, .1 + fresh / 20_000), reported: true };
      w.crimes.push(crime); crimes.push(crime);
      const text = `${p.name} disclosed $${Math.round(fresh).toLocaleString('en-US')} of uncovered tax belonging to ${gang.name}.`;
      if (gang.isPlayer) { w.weekLog.push(text); addMessage(w, 'police', text, boss.pos, boss.id); }
    }
  }
  return crimes;
}
