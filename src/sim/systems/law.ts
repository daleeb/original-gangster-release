import { ORDERS } from '../constants';
import { availableOfficial, ensureCourtOfficials } from '../courtOfficials';
import { availableSpecialist } from '../specialists';
import { exposeTaxRecords } from './taxes';
import { addMessage, addNews } from '../events';
import type { Rng } from '../rng';
import type { CourtCase, CrimeRecord, ID, OrderType, WorldState } from '../types';
import { allBuildings } from '../world';
import { peopleList } from '../entityLists';

/**
 * Police work, arrests and the courts. Trials are a contest between your lawyer
 * and the district attorney, decided by evidence, witnesses and money.
 */
export function weeklyLaw(w: WorldState, rng: Rng): void {
  ensureCourtOfficials(w, rng);
  exposeTaxRecords(w);
  // A sentence imposed below begins now; do not immediately subtract its first week.
  releasePrisoners(w);
  investigateCrimes(w, rng);
  // An accountant arrested in that investigation can disclose records now.
  // Only investigate the fresh disclosure, never reroll the other crimes.
  investigateCrimes(w, rng, exposeTaxRecords(w));
  handleSquealers(w, rng);
  openCases(w, rng);
  progressCases(w, rng);

  // Individual heat cools when a hood keeps off the streets.
  for (const p of peopleList(w)) {
    if (p.gangId == null) continue;
    const layingLow = p.orderId == null && p.status === 'active';
    p.wanted = Math.max(0, p.wanted - (layingLow ? 6 : 2));
  }

  // Crime heat and the memory of the street both fade.
  for (const blk of w.blocks) blk.crimeHeat = Math.max(0, blk.crimeHeat * 0.82);
  w.crimes = w.crimes.filter((c) => w.week - c.week <= 8);
}

/** Below this severity a crime is minor: the police mostly look the other way. */
const MINOR_SEVERITY = 2;
const MINOR_FACTOR = 0.35;

function investigateCrimes(w: WorldState, rng: Rng, records = w.crimes): void {
  // The police build one case a week against a man, on his worst crime; the
  // rest of his week adds a little to it. Minor crimes — extortion, bribery,
  // intimidation — are mostly overlooked, as the manual has it.
  const byPerp = new Map<ID, CrimeRecord[]>();
  for (const crime of records) {
    if (crime.week !== w.week || !crime.reported) continue;
    const list = byPerp.get(crime.perpetratorId);
    if (list) list.push(crime);
    else byPerp.set(crime.perpetratorId, [crime]);
  }
  for (const [perpId, crimes] of byPerp) {
    const perp = w.people[perpId];
    if (!perp || perp.status !== 'active') continue;
    const weighted = crimes.map((c) => {
      const sev = ORDERS[c.kind as OrderType]?.severity ?? 8;
      return { c, r: c.arrestRisk * (sev <= MINOR_SEVERITY ? MINOR_FACTOR : 1) };
    });
    weighted.sort((a, b) => b.r - a.r);
    const crime = weighted[0].c;
    const gang = w.gangs[crime.gangId];
    if (!gang) continue;

    // Bought officers and a friendly chief both lower the odds.
    const chief = w.people[w.policeChiefId];
    const chiefOpinion = chief ? (chief.opinion[gang.id] ?? 0) : 0;
    let risk = weighted[0].r + weighted.slice(1).reduce((a, x) => a + x.r * 0.08, 0);
    risk *= 1 - chiefOpinion / 260;
    risk *= 1 - Math.min(0.4, gang.employedPoliceIds.length * 0.04);
    // Men working a priority job press on regardless, and take the extra chance.
    if (perp.orderId != null && w.orders[perp.orderId]?.opts.priority) risk *= 1.25;

    if (rng.chance(Math.max(0, Math.min(0.95, risk)))) {
      perp.status = 'arrested';
      perp.dest = null;
      perp.path = [];
      perp.orderId = null;
      addMessage(w, 'police', `${perp.name} has been picked up by the police.`, perp.pos, perp.id);
      w.weekLog.push(`${perp.name} was arrested for ${describeCrime(crime.kind)}.`);
    }
  }
}

function handleSquealers(w: WorldState, rng: Rng): void {
  for (const b of allBuildings(w)) {
    if (!b.protection || b.state === 'destroyed') continue;
    const gang = w.gangs[b.protection.gangId];
    if (!gang) continue;
    const owner = b.ownerPersonId != null ? w.people[b.ownerPersonId] : null;
    if (!owner || owner.status !== 'active') continue;

    const opinion = owner.opinion[gang.id] ?? 0;
    // An overcharged, unhappy owner stops paying...
    if (b.protection.grievance > 1.4 || opinion < -45) {
      if (!b.protection.refusing && rng.chance(0.35)) {
        b.protection.refusing = true;
        if (gang.isPlayer) {
          addMessage(w, 'failed', `${owner.name} has refused to pay protection.`, owner.pos, owner.id);
        }
      }
      // ...and eventually goes to the police.
      if (b.protection.refusing && rng.chance(0.12)) {
        gang.evidence = Math.min(100, gang.evidence + 5);
        gang.suspicion = Math.min(100, gang.suspicion + 3);
        w.weekLog.push(`${owner.name} squealed to the police about ${gang.name}.`);
        if (gang.isPlayer) {
          addMessage(w, 'police', `${owner.name} squealed to the police. Deal with him.`, owner.pos, owner.id);
        }
      }
      // Or drops out of the racket entirely.
      if (b.protection.refusing && b.protection.grievance > 3 && rng.chance(0.2)) {
        b.protection = null;
      }
    } else {
      b.protection.grievance = Math.max(0, b.protection.grievance - 0.15);
    }
  }
}

function openCases(w: WorldState, rng: Rng): void {
  for (const p of peopleList(w)) {
    if (p.status !== 'arrested') continue;
    if (Object.values(w.cases).some((c) => c.defendantId === p.id && (c.status === 'awaiting' || c.status === 'onTrial'))) continue;
    if (p.gangId == null) {
      p.status = 'active';
      continue;
    }
    const gang = w.gangs[p.gangId];
    if (!gang) continue;

    const crimes = w.crimes.filter((c) => c.perpetratorId === p.id).sort((a, b) => b.arrestRisk - a.arrestRisk);
    const worst = crimes[0];
    const witnessIds = worst ? worst.witnesses.slice(0, 4) : [];

    // Jurors are drawn from the city's business owners.
    const owners = peopleList(w).filter((q) => q.role === 'owner' && q.status === 'active');
    const jurors: ID[] = [];
    for (let i = 0; i < 6 && owners.length; i++) {
      const index = rng.int(0, owners.length - 1);
      jurors.push(owners.splice(index, 1)[0].id);
    }

    const c: CourtCase = {
      id: w.sequences.court++,
      defendantId: p.id,
      gangId: gang.id,
      crime: worst ? describeCrime(worst.kind) : 'racketeering',
      judgeId: rng.pick(w.judgeIds),
      daId: rng.pick(w.daIds),
      witnessIds,
      jurorIds: jurors,
      // Opened and progressed in the same weekly pass, so this must be at
      // least two for the boss to get a planning phase to work with.
      weeksToTrial: rng.int(2, 3),
      status: 'awaiting',
      knowsWitnesses: false,
      knowsJurors: false,
      judgeBribed: false,
      strength: Math.min(100, 25 + witnessIds.length * 14 + (worst ? worst.arrestRisk * 40 : 0)),
    };
    w.cases[c.id] = c;
    p.status = 'onTrial';
    if (gang.isPlayer) {
      addMessage(w, 'police', `${p.name} will stand trial for ${c.crime}.`, p.pos, p.id);
    }
  }
}

function progressCases(w: WorldState, rng: Rng): void {
  for (const c of Object.values(w.cases)) {
    if (c.status !== 'awaiting' && c.status !== 'onTrial') continue;
    const defendant = w.people[c.defendantId];
    const gang = w.gangs[c.gangId];
    if (!defendant || !gang) {
      c.status = 'dismissed';
      continue;
    }
    if (defendant.status === 'dead') {
      c.status = 'dismissed';
      continue;
    }

    let reassigned = false;
    if (!availableOfficial(w, c.judgeId, 'judge')) {
      c.judgeId = rng.pick(w.judgeIds);
      c.judgeBribed = false;
      reassigned = true;
    }
    if (!availableOfficial(w, c.daId, 'da')) {
      c.daId = rng.pick(w.daIds);
      reassigned = true;
    }
    // Let the next planning screen show the changed officials before the verdict.
    if (reassigned) c.weeksToTrial = Math.max(2, c.weeksToTrial);
    c.weeksToTrial--;
    if (c.weeksToTrial > 0) {
      c.status = 'onTrial';
      continue;
    }

    // A bribed judge throws it straight out.
    const judge = w.people[c.judgeId];
    if (c.judgeBribed || (judge && (judge.opinion[gang.id] ?? 0) > 55)) {
      c.status = 'dismissed';
      freeDefendant(w, defendant);
      w.weekLog.push(`The case against ${defendant.name} was thrown out of court.`);
      if (gang.isPlayer) addMessage(w, 'police', `${defendant.name} walked free — case dismissed.`);
      addNews(w, {
        section: 'law',
        headline: 'CASE COLLAPSES IN COURT',
        body: `Charges against ${defendant.name} were dismissed today amid questions over the conduct of proceedings.`,
        gangId: gang.id,
      });
      continue;
    }

    // Prosecution versus defence.
    const da = w.people[c.daId];
    const lawyer = availableSpecialist(w, gang, 'lawyer');
    const daSkill = da ? da.skills.intelligence : 3;
    const defSkill = lawyer?.status === 'active' ? lawyer.skills.intelligence : 0.5;

    const livingWitnesses = c.witnessIds.filter((id) => {
      const wn = w.people[id];
      return wn && wn.status === 'active' && (wn.opinion[gang.id] ?? 0) < 40;
    });
    const friendlyJurors = c.jurorIds.filter((id) => {
      const j = w.people[id];
      return j && j.status === 'active' && (j.opinion[gang.id] ?? 0) > 25;
    });

    let prosecution = c.strength * 0.6 + livingWitnesses.length * 12 + daSkill * 6 + gang.evidence * 0.25;
    let defence = defSkill * 16 + friendlyJurors.length * 11 + 15;
    prosecution *= rng.range(0.85, 1.15);
    defence *= rng.range(0.85, 1.15);

    if (prosecution > defence) {
      c.status = 'convicted';
      const isBoss = defendant.role === 'boss';
      defendant.status = 'jailed';
      defendant.jailWeeks = isBoss ? 999 : rng.int(2, 6);
      w.weekLog.push(`${defendant.name} was convicted of ${c.crime}.`);
      if (gang.isPlayer) addMessage(w, 'police', `${defendant.name} was convicted and jailed.`);
      addNews(w, {
        section: 'law',
        headline: 'GUILTY VERDICT RETURNED',
        body: `${defendant.name} was today found guilty of ${c.crime} and sentenced.`,
        gangId: gang.id,
      });
    } else {
      c.status = 'acquitted';
      freeDefendant(w, defendant);
      w.weekLog.push(`${defendant.name} was acquitted.`);
      if (gang.isPlayer) addMessage(w, 'police', `${defendant.name} was acquitted.`);
    }
    gang.evidence = Math.max(0, gang.evidence - 8);
  }

  // Clear out concluded cases after a week so the report can show them once.
  for (const c of Object.values(w.cases)) {
    if (c.status === 'dismissed' || c.status === 'acquitted' || c.status === 'convicted') {
      if (c.weeksToTrial < -1) delete w.cases[c.id];
      else c.weeksToTrial--;
    }
  }
}

function freeDefendant(w: WorldState, p: { id: ID; status: string }): void {
  const person = w.people[p.id];
  if (!person) return;
  person.status = 'active';
  person.wanted = Math.max(0, person.wanted - 30);
}

function releasePrisoners(w: WorldState): void {
  for (const p of peopleList(w)) {
    if (p.status !== 'jailed') continue;
    if (p.jailWeeks >= 999) continue;
    p.jailWeeks--;
    if (p.jailWeeks <= 0) {
      p.status = 'active';
      p.wanted = Math.max(0, p.wanted - 40);
      w.weekLog.push(`${p.name} was released from prison.`);
    }
  }
}

export function describeCrime(kind: string): string {
  switch (kind) {
    case 'kill':
    case 'streetKill':
      return 'murder';
    case 'assault':
    case 'streetAssault':
      return 'assault';
    case 'bomb':
      return 'bombing';
    case 'torch':
      return 'arson';
    case 'raid':
      return 'armed robbery';
    case 'kidnap':
      return 'kidnapping';
    case 'smashUp':
      return 'criminal damage';
    case 'extort':
    case 'intimidate':
      return 'extortion';
    case 'shootout':
      return 'discharging a firearm';
    case 'taxEvasion':
      return 'tax evasion';
    case 'illegalBusiness':
      return 'operating an illegal business';
    default:
      return 'racketeering';
  }
}
