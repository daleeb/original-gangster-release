import { NO_ORIGINAL_CHANNEL, opinionSet } from '../attitudes';
import { BUILDING_BY_ID } from '../data/buildings';
import { publishingNewspapers } from '../newspaper';
import { addNews, localOpinionShifter } from '../events';
import type { Rng } from '../rng';
import type { Gang, ID, WorldState } from '../types';
import { allBuildings, dist2, territoryCount } from '../world';
import { peopleList } from '../entityLists';

/**
 * Public feeling. The mayor leans on the police chief, the chief leans on his
 * officers, and priests and newspaper editors lean on everybody else.
 */
export function weeklyOpinion(w: WorldState, rng: Rng): void {
  const shift = localOpinionShifter(w);
  const mayor = w.people[w.mayorId];
  const chief = w.people[w.policeChiefId];

  // ---- how the mayor feels about each gang
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;
    const crimesThisWeek = w.crimes.filter((c) => c.week === w.week && c.gangId === gang.id && !c.charge);
    const severity = crimesThisWeek.reduce((s, c) => s + c.arrestRisk * 10, 0);
    if (mayor) {
      let delta = -severity * 0.5 + gang.popularity * 0.05;
      if (gang.goingStraight) delta += 2;
      opinionSet(mayor, gang.id, clamp((mayor.opinion[gang.id] ?? 0) + delta), NO_ORIGINAL_CHANNEL);
    }
  }

  // ---- the chief takes the mayor's view, gradually
  if (chief && mayor) {
    for (const gang of Object.values(w.gangs)) {
      const target = mayor.opinion[gang.id] ?? 0;
      const cur = chief.opinion[gang.id] ?? 0;
      opinionSet(chief, gang.id, clamp(cur + (target - cur) * 0.35), NO_ORIGINAL_CHANNEL);
    }
  }

  // ---- and the officers take the chief's
  if (chief) {
    for (const id of w.policeIds) {
      const o = w.people[id];
      if (!o || o.status === 'dead') continue;
      for (const gang of Object.values(w.gangs)) {
        const target = chief.opinion[gang.id] ?? 0;
        const cur = o.opinion[gang.id] ?? 0;
        // A retainer keeps an officer sweet whatever the chief thinks.
        const pull = o.employedBy === gang.id ? 0.08 : 0.25;
        opinionSet(o, gang.id, clamp(cur + (target - cur) * pull), NO_ORIGINAL_CHANNEL);
      }
    }
  }

  // ---- the pulpit
  for (const b of allBuildings(w)) {
    const t = BUILDING_BY_ID[b.typeId];
    if (t?.special !== 'church' && t?.special !== 'orphanage') continue;
    const priest = b.ownerPersonId != null ? w.people[b.ownerPersonId] : null;
    if (!priest) continue;
    const lot = w.lots[b.lotId];
    for (const gang of Object.values(w.gangs)) {
      const view = priest.opinion[gang.id] ?? 0;
      if (Math.abs(view) < 4) continue;
      shift(lot.center, 110, gang.id, view * 0.04);
    }
  }

  // ---- the press
  for (const b of publishingNewspapers(w)) {
    const editor = b.ownerPersonId != null ? w.people[b.ownerPersonId] : null;
    if (!editor || editor.status !== 'active') continue;
    const lot = w.lots[b.lotId];
    for (const gang of Object.values(w.gangs)) {
      // An owned paper is kind to its owner.
      const owned = b.ownerGangId === gang.id;
      const view = (editor.opinion[gang.id] ?? 0) + (owned ? 30 : 0);
      shift(lot.center, 150, gang.id, view * 0.03);
    }
  }

  // ---- violence sours the neighbourhood it happens in
  for (const c of w.crimes) {
    if (c.week !== w.week || c.charge) continue;
    const bl = c.buildingId != null ? w.buildings[c.buildingId] : null;
    const pos = bl ? w.lots[bl.lotId].center : null;
    if (pos) shift(pos, 45, c.gangId, -c.arrestRisk * 4);
  }

  // Soup kitchens have no weekly favour writer in the original: the charity
  // weekly op (0x55F270) only books their running costs, and they reach the
  // election through their occupier's ordinary attitude channel (Deep25
  // W21-Q2, live IDA). The remake's former +3.5 popularity / −2 squalor pass
  // was removed on that evidence.

  // ---- overall popularity, used by elections. Standing earned by charity and
  //      quiet streets is kept separately so it accumulates rather than being
  //      wiped out by the week's average.
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;
    let total = 0;
    let n = 0;
    for (const p of peopleList(w)) {
      if (p.role !== 'owner' && p.role !== 'citizen') continue;
      if (p.status === 'dead') continue;
      total += p.opinion[gang.id] ?? 0;
      n++;
    }
    gang.goodwill *= 0.88;
    gang.popularity = clamp((n ? total / n : 0) + gang.goodwill);
  }

  // ---- police deployment follows the chief's mood and the crime figures
  const presencePerBlock = Math.max(1, Math.round(w.policeIds.length / Math.max(1, w.blocks.length / 6)));
  for (const blk of w.blocks) {
    let level = blk.crimeHeat / 22;
    for (const gang of Object.values(w.gangs)) {
      if (gang.eliminated) continue;
      const chiefView = chief ? (chief.opinion[gang.id] ?? 0) : 0;
      if (chiefView < -20) level += 0.4;
    }
    blk.policePresence = Math.min(10, Math.round(level * presencePerBlock * 0.5));
  }

  // ---- the mayor names the week's worst offender
  const worst = mostActiveGang(w);
  if (worst && rng.chance(0.3)) {
    addNews(w, {
      section: 'politics',
      headline: 'MAYOR DEMANDS CRACKDOWN',
      body: `The Mayor today named ${worst.name} as the source of the city's lawlessness and promised a redoubled police effort in their districts.`,
      gangId: worst.id,
    });
    opinionSet(chief, worst.id, clamp((chief.opinion[worst.id] ?? 0) - 22), NO_ORIGINAL_CHANNEL);
    w.weekLog.push(`The Mayor named ${worst.name} in a crackdown declaration.`);
  }
}

function mostActiveGang(w: WorldState): Gang | null {
  const counts: Record<ID, number> = {};
  for (const c of w.crimes) {
    if (c.week !== w.week || c.charge) continue;
    counts[c.gangId] = (counts[c.gangId] ?? 0) + c.arrestRisk * 10;
  }
  let best: Gang | null = null;
  let bestN = 6;
  for (const gang of Object.values(w.gangs)) {
    const n = counts[gang.id] ?? 0;
    if (n > bestN) {
      bestN = n;
      best = gang;
    }
  }
  return best;
}

/** Reassure the people who pay you: territory held peacefully raises standing. */
export function territoryGoodwill(w: WorldState): void {
  for (const gang of Object.values(w.gangs)) {
    if (gang.eliminated) continue;
    const terr = territoryCount(w, gang.id);
    if (terr > 0) gang.goodwill = Math.min(40, gang.goodwill + Math.min(2, terr / 60));
  }
}

export function opinionNear(w: WorldState, gangId: ID, x: number, y: number, radius: number): number {
  const r2 = radius * radius;
  let total = 0;
  let n = 0;
  for (const p of peopleList(w)) {
    if (p.role !== 'owner' && p.role !== 'citizen') continue;
    if (dist2(p.pos, { x, y }) > r2) continue;
    total += p.opinion[gangId] ?? 0;
    n++;
  }
  return n ? total / n : 0;
}

function clamp(v: number): number {
  return Math.max(-100, Math.min(100, v));
}
