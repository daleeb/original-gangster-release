import { fearOf, hostilityOf, NO_ORIGINAL_CHANNEL, opinionSet } from './attitudes';
import { INCIDENT_HOSTILITY, provoke } from './aiStance';
import { cityBlockAt } from './cityLayout';
import { ORIGINAL_CELL_METRES, skillByte } from './fireRoll';
import { ORDERS } from './constants';
import { BUILDING_BY_ID } from './data/buildings';
import { closestNewspaper, publishingNewspapers } from './newspaper';
import type { Rng } from './rng';
import type {
  CrimeRecord,
  Building,
  ID,
  MessageCategory,
  NewsItem,
  OrderType,
  Person,
  Vec2,
  WorldState,
} from './types';
import { dist2, placeName } from './world';
import { peopleList } from './entityLists';
import { onGangPayroll } from './payrollMark';



export function addMessage(
  w: WorldState,
  category: MessageCategory,
  text: string,
  pos: Vec2 | null = null,
  personId: ID | null = null,
  sound?: 'gunshot',
): void {
  w.messages.push({
    id: w.sequences.message++,
    minute: w.minute,
    category,
    text,
    pos: pos ? { x: pos.x, y: pos.y } : null,
    personId,
    ...(sound ? { sound } : {}),
  });
  // Keep the log bounded; the UI only ever shows the most recent entries.
  if (w.messages.length > 400) w.messages.splice(0, w.messages.length - 400);
}

export function addNews(w: WorldState, item: Omit<NewsItem, 'week'>): void {
  w.news.push({ ...item, week: w.week });
  if (w.news.length > 600) w.news.splice(0, w.news.length - 600);
}

/** Called only at a successful business transaction's commit point. */
export function reportBusinessMove(w: WorldState, gangId: ID, b: Building, move: 'bought' | 'sold' | 'established'): void {
  // The major-business threshold is remake tuning, not a recovered original constant.
  if (b.cls === 'illegal' || b.cls === 'empty' || (BUILDING_BY_ID[b.typeId]?.cost ?? 0) < 20000) return;
  const protectedPurchase = move === 'bought' && publishingNewspapers(w).some(p => p.ownerGangId === gangId);
  addNews(w, {
    section: 'business',
    kind: move === 'bought' ? 'purchase' : move === 'sold' ? 'sale' : 'opening', buildingId: b.id,
    headline: move === 'established' ? 'NEW BUSINESS OPENS' : 'MAJOR PREMISES CHANGE HANDS',
    body: `${placeName(w, b)} was ${move} by ${w.gangs[gangId].name}.`,
    gangId,
    ...(protectedPurchase ? { paperOwnerId: gangId } : {}),
  });
}

/** People close enough to have seen something happen. */
export function witnessesNear(w: WorldState, pos: Vec2, radius: number, exclude: ID[]): Person[] {
  const r2 = radius * radius;
  const out: Person[] = [];
  for (const p of peopleList(w)) {
    if (p.status === 'dead' || p.status === 'jailed') continue;
    if (exclude.includes(p.id)) continue;
    if (p.role !== 'citizen' && p.role !== 'owner' && p.role !== 'police' && p.role !== 'clergy' && p.role !== 'reporter')
      continue;
    // A tram's riders are off the map's cell lists while they ride (0x712810).
    if (p.tram?.phase === 'riding') continue;
    if (dist2(p.pos, pos) <= r2) out.push(p);
  }
  return out;
}

/** Each crime as the original's incidents (aiStance.ts); one whose victim is dead counts as a killing. */
const CRIME_HOSTILITY: Partial<Record<CrimeParams['type'], number>> = {
  intimidate: INCIDENT_HOSTILITY.threaten, extort: INCIDENT_HOSTILITY.threaten, raid: INCIDENT_HOSTILITY.burgle,
  kidnap: INCIDENT_HOSTILITY.abduct, smashUp: INCIDENT_HOSTILITY.sabotage, torch: INCIDENT_HOSTILITY.bomb, bomb: INCIDENT_HOSTILITY.bomb,
  assault: INCIDENT_HOSTILITY.attacked, streetAssault: INCIDENT_HOSTILITY.attacked, kill: INCIDENT_HOSTILITY.attacked,
  streetKill: INCIDENT_HOSTILITY.attacked, shootout: INCIDENT_HOSTILITY.attacked,
};

export interface CrimeParams {
  gangId: ID;
  perpetratorId: ID;
  type: OrderType | 'streetKill' | 'streetAssault' | 'shootout';
  pos: Vec2;
  buildingId?: ID | null;
  victimId?: ID | null;
  isPublic?: boolean;
  /** Overrides the order table severity. */
  severity?: number;
}



/** How much one citizen's word is worth against an owner's or an officer's. */
const PASSER_BY_WEIGHT = 0.15;
/** Crime rows 18/19/24/27 against a business owner file nothing (0x4DB750). */
const OWNER_SILENT = new Set<CrimeParams['type']>(['extort', 'intimidate', 'assault', 'smashUp']);

/**
 * Record a crime: works out who saw it, how much heat it generates and how
 * likely the police are to build a case.
 */
export function recordCrime(w: WorldState, rng: Rng, params: CrimeParams): CrimeRecord {
  const severity =
    params.severity ??
    (params.type in ORDERS ? ORDERS[params.type as OrderType].severity : 8);

  const perp = w.people[params.perpetratorId];
  const stealth = perp ? perp.skills.stealth : 2.5;
  const original = !!w.cityLayout?.original;
  const victim = params.victimId != null ? w.people[params.victimId] : null;
  // fileCrime 0x4DB700 step 1: an owner never files extortion, intimidation,
  // assault or a smash-up against himself.
  const suppressed = original && victim?.role === 'owner' && OWNER_SILENT.has(params.type);
  // Original sweep: 5 cells outdoors, 3 indoors; the remake's 46/22 otherwise.
  const radius = original ? (params.buildingId != null ? 3 : 5) * ORIGINAL_CELL_METRES : params.isPublic ? 46 : 22;

  const seen = suppressed ? [] : witnessesNear(w, params.pos, radius, [params.perpetratorId]);
  const witnesses: ID[] = [];
  const civilians: Person[] = [];
  for (const s of seen) {
    // fileCrime 0x4DB700: a civilian only comes forward against a gang they
    // are hostile to beyond their fear (hostility − fear > 64, Constants #127).
    // Compact cities keep this gate ahead of the remake's notice roll.
    if (!original && s.role === 'citizen' && hostilityOf(s, params.gangId) - fearOf(s, params.gangId) <= 64) continue;
    if (original && s.role !== 'police') {
      // Only civilians witness in the original (owners, clergy and the press
      // do not); police stay on the remake roll, standing in for the alert.
      if (s.role === 'citizen' && hostilityOf(s, params.gangId) - fearOf(s, params.gangId) > 64) civilians.push(s);
      continue;
    }
    // An officer the gang has bought sees nothing short of murder.
    if (s.role === 'police' && (onGangPayroll(s, params.gangId) || s.bribedBy === params.gangId) && severity < 9) continue;
    // Stealthy hoods are simply not noticed; the police notice most things.
    const noticeChance =
      (s.role === 'police' ? 0.85 : 0.3 + severity * 0.045) * (1 - (stealth - 0.5) * 0.12);
    if (rng.chance(Math.max(0.02, noticeChance))) witnesses.push(s.id);
  }

  if (original) {
    // Nearest six, then stealth sheds n·stealth/64 at random, then at most four.
    civilians.sort((a, b) => dist2(a.pos, params.pos) - dist2(b.pos, params.pos));
    const found = civilians.slice(0, 6).map(p => p.id);
    for (let shed = Math.floor(found.length * skillByte(stealth) / 64); shed > 0; shed--) found.splice(rng.int(0, found.length - 1), 1);
    while (found.length > 4) found.splice(rng.int(0, found.length - 1), 1);
    witnesses.push(...found);
  }

  const gang = w.gangs[params.gangId];
  const employedPoliceNearby = seen.some(
    (s) => s.role === 'police' && gang && (onGangPayroll(s, gang.id) || s.bribedBy === gang.id),
  );

  // Passers-by are many and soon forget; it is the people with a stake in
  // the street — owners, police, the priest, the press — whose word builds
  // a case. A crowd of citizens counts for a couple of them at most.
  let weight = 0;
  let passersBy = 0;
  for (const id of witnesses) {
    // The original files every civilian witness to the case (each +25% case
    // value), so in the original city each one counts in full.
    if (w.people[id]?.role === 'citizen' && !original) passersBy += PASSER_BY_WEIGHT;
    else weight += 1;
  }
  const crowd = Math.min(2, passersBy);
  // A crime is reported when someone with a stake saw it, or when enough of
  // the crowd did for one of them to go to the police.
  const reported = weight > 0 || passersBy >= 1.5;
  weight += crowd;

  // A bought officer looks the other way — unless it is murder.
  let arrestRisk = Math.min(0.92, 0.05 + weight * 0.09 + severity * 0.035);
  if (employedPoliceNearby && severity < 9) arrestRisk *= 0.25;
  arrestRisk *= 1 - Math.min(0.5, (stealth - 0.5) * 0.09);

  const crime: CrimeRecord = {
    id: w.sequences.crime++,
    week: w.week,
    gangId: params.gangId,
    perpetratorId: params.perpetratorId,
    kind: params.type,
    buildingId: params.buildingId ?? null,
    victimId: params.victimId ?? null,
    witnesses,
    arrestRisk: Math.max(0, arrestRisk),
    reported,
  };
  w.crimes.push(crime);
  // The gang wronged takes it badly: the man's own gang, or the gang that
  // owns or protects the premises.
  const premises = params.buildingId != null ? w.buildings[params.buildingId] : undefined;
  const wronged = victim?.gangId ?? premises?.ownerGangId ?? premises?.protection?.gangId;
  provoke(w, wronged, params.gangId, victim?.status === 'dead' ? INCIDENT_HOSTILITY.kill : CRIME_HOSTILITY[params.type] ?? 0);

  // Heat on the block and on the individual.
  const blk = blockAtPos(w, params.pos);
  if (blk != null) {
    w.blocks[blk].crimeHeat = Math.min(100, w.blocks[blk].crimeHeat + severity * 1.6);
  }
  if (suppressed) return crime;
  if (perp) perp.wanted = Math.min(100, perp.wanted + severity * (crime.reported ? 1.6 : 0.4));
  if (gang) gang.evidence = Math.min(100, gang.evidence + severity * 0.16 * (crime.reported ? 1 : 0.3));

  return crime;
}

/** Index of the block containing a world position, or null if off the grid. */
export function blockAtPos(w: WorldState, pos: Vec2): number | null {
  const CELLSIZE = 54; // BLOCK_SIZE + STREET_WIDTH, kept local to avoid a cycle
  const gx = Math.floor(pos.x / CELLSIZE);
  const gy = Math.floor(pos.y / CELLSIZE);
  if (gx < 0 || gy < 0 || gx >= w.gridW || gy >= w.gridH) return null;
  return cityBlockAt(w, gx, gy)!.id;
}

/**
 * The Recent Events overlay: reported crimes of this week and last, counted by
 * the block they happened in (the premises', else the victim's or the
 * perpetrator's). Charges laid at an arrest are not fresh events.
 */
export function recentEventCounts(w: WorldState): Map<ID, number> {
  const counts = new Map<ID, number>();
  for (const c of w.crimes) {
    if (c.week < w.week - 1 || !c.reported || c.charge) continue;
    const site = c.buildingId != null ? w.buildings[c.buildingId] : null;
    const pos = site ? null : (c.victimId != null ? w.people[c.victimId] : null)?.pos ?? w.people[c.perpetratorId]?.pos;
    const raw = site ? site.blockId : pos ? blockAtPos(w, pos) : null;
    if (raw == null) continue;
    const id = w.blocks[raw]?.layout?.mergedInto ?? raw;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Shift the opinion of everyone in an area toward or against a gang. */
export function shiftLocalOpinion(
  w: WorldState,
  pos: Vec2,
  radius: number,
  gangId: ID,
  delta: number,
  people: Iterable<Person> = Object.values(w.people),
): void {
  const r2 = radius * radius;
  for (const p of people) {
    if (p.role !== 'citizen' && p.role !== 'owner' && p.role !== 'clergy') continue;
    if (dist2(p.pos, pos) > r2) continue;
    // Original city (playtest, 1 October: follow the original): donations, sermons,
    // the press, patrols and public crimes have no attitude writer there.
    opinionSet(p, gangId, Math.max(-100, Math.min(100, (p.opinion[gangId] ?? 0) + delta)),
      w.cityLayout?.original ? NO_ORIGINAL_CHANNEL : undefined);
  }
}

/** For a settlement pass during which nobody moves: visit only nearby people.
 * Influence sources still run in their original order, preserving clamping. */
export function localOpinionShifter(w: WorldState) {
  const cell = 110;
  const buckets = new Map<string, Person[]>();
  for (const p of peopleList(w)) {
    if (p.role !== 'citizen' && p.role !== 'owner' && p.role !== 'clergy') continue;
    const key = `${Math.floor(p.pos.x / cell)},${Math.floor(p.pos.y / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p); else buckets.set(key, [p]);
  }
  return (pos: Vec2, radius: number, gangId: ID, delta: number) => {
    for (let x = Math.floor((pos.x - radius) / cell); x <= Math.floor((pos.x + radius) / cell); x++) {
      for (let y = Math.floor((pos.y - radius) / cell); y <= Math.floor((pos.y + radius) / cell); y++) {
        shiftLocalOpinion(w, pos, radius, gangId, delta, buckets.get(`${x},${y}`) ?? []);
      }
    }
  };
}

/** The newspaper nearest a position — used to decide who reports what. */
export function nearestNewspaper(w: WorldState, pos: Vec2): ID | null {
  return closestNewspaper(w, pos)?.id ?? null;
}

