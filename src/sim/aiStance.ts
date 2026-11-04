/**
 * The original AI's personality profile and weekly stance machine, for AI gangs
 * in the original city. Sources (read, not executed): the reference's
 * strategic_ai_spec §6.3 (profile table at city+0x1628, written by 0x650EE0;
 * roll in the gang ctor 0x6CAB20) and §7.2 (weekly stance machine 0x6DD950).
 *
 * Profile bytes: [0] calm damper, [1] aggression, [2] personality index,
 * [3] unread, [4] hostility drift, [5] hostility noise, [6] band.
 * Stances: 0 Alliance, 1 Peace, 2 Cease-fire, 3 Aggression, 4 War.
 *
 * Re-read on 27 October 2026 from the shipped gangsters.exe (GOG, SHA-256
 * 78c66b2e…): the weekly turn 0x6D6070 runs "stop the leader" (0x6D5D70) and
 * then the stance machine; docs/audit/2026-10-27/ai-leader/review.md.
 *
 * The pairwise incident window (§7.3), traced 28 October 2026
 * (docs/audit/2026-10-28/ai-incidents/review.md): four rows of signed bytes,
 * one per gang, at gang+0x52C. After the stance machine, the weekly turn
 * (0x6D6070; 0x6D6860 likewise) adds every row to the hostility toward each
 * gang through 0x5A2B10, floors it at 106, then shifts the rows down a week
 * and clears the newest. Nothing in the retail build writes a row: the only
 * references are the constructor's zeroing (0x6CB358), the save and load
 * copies (0x6CD2B8, 0x6CECCC) and that weekly pass. The window is always
 * empty, so an incident acts once, through the direct book 0x6DF6E0
 * (`provoke`), and the stance machine answers it in the week it lands. That is
 * what the remake does; there is nothing further to port.
 *
 * The strength comparison (traced 28 October 2026): 0x6AF840 is the AI
 * planner's task 0x19, a child of task 0x31 (0x6AF720, table 0x7BBBE8 =
 * {0x32, 0x19}). It compares the city's power shares (city+0x2598,
 * 0x6608E0) and books hostility through the direct book 0x6DF6E0:
 * `strengthBooking`. How often (traced 29 October 2026,
 * docs/audit/2026-10-28/ai-incidents/review.md): task 0x31 is the root of
 * every gang's planner tree (0x677B40(0x31) at game start, 0x6CC4F8, and for
 * a gang split off, 0x6D1410); nothing replaces it. The planner 0x6D4690
 * expands that root first thing in every computer gang's weekly turn
 * (0x677DE0, root at planner+0x4C), after the stance machine; 0x31 and 0x19
 * both set their re-run flag (+0x46), and 0x31 re-creates 0x19 whenever it is
 * missing, so 0x19 books once a week against every rival that qualifies.
 * The root 0x1E task is only the idle-crew fallback (0x6760B0). Not ported:
 * the profile's other readers (roster target, wages, money/asset task rows).
 */
import type { Rng } from './rng';
import type { DiplomacyLevel, Gang, GameOptions, ID, WorldState } from './types';
import { gangWealth, territoryCount } from './world';
import { peopleList } from './entityLists';

export const ORIGINAL_AI_PROFILES: readonly (readonly number[])[] = [
  // 0..7 Passive
  [10, 2, 0, 191, 63, 63, 0], [10, 4, 2, 191, 126, 127, 0], [10, 0, 1, 127, 80, 63, 0], [10, 12, 3, 191, 50, 127, 0],
  [5, 2, 1, 63, 80, 191, 0], [5, 4, 3, 63, 126, 127, 0], [5, 0, 0, 63, 126, 63, 0], [0, 12, 1, 63, 100, 255, 0],
  // 8..15 Normal
  [10, 0, 2, 191, 63, 127, 1], [10, 12, 1, 191, 192, 63, 1], [5, 4, 0, 191, 126, 191, 1], [5, 8, 2, 63, 191, 63, 1],
  [5, 0, 3, 127, 126, 63, 1], [5, 4, 2, 63, 63, 191, 1], [0, 0, 0, 127, 192, 127, 1], [0, 8, 3, 63, 191, 127, 1],
  // 16..23 Aggressive
  [5, 2, 1, 127, 126, 127, 2], [5, 0, 1, 63, 192, 127, 2], [0, 4, 1, 63, 192, 191, 2], [0, 8, 1, 0, 255, 0, 2],
  [0, 12, 1, 127, 192, 127, 2], [0, 8, 1, 63, 192, 63, 2], [0, 4, 1, 0, 255, 191, 2], [0, 0, 1, 63, 192, 127, 2],
];

const STANCES: DiplomacyLevel[] = ['alliance', 'peace', 'ceasefire', 'aggression', 'war'];
const stanceIndex = (d: DiplomacyLevel | undefined) => Math.max(0, STANCES.indexOf(d ?? 'peace'));
/**
 * When hostility is not rising, the stance decays towards (hostility + anchor)/2.
 * The original reads the anchor from the rival's stance toward itself
 * (0x6DDAE4: rival.stance[rival]), a slot only the gang setup 0x6CBE10 writes:
 * Peace for a computer gang, Ceasefire for the player. Kept as the original
 * plays it: a quiet week cannot hold War, and Aggression only from 239 up.
 */
const ANCHOR_AI_RIVAL = 139, ANCHOR_PLAYER_RIVAL = 172;
const PEACE_PRESSURE = [
  [0, 16, 32, 64, 96], [-8, 0, 16, 32, 64], [-16, -8, 0, 16, 32], [-32, -16, -8, 0, 8], [-64, -32, -16, -8, 0],
];
/** A computer gang's starting hostility toward the other computer gangs (Peace). */
export const STARTING_HOSTILITY = 122;

/**
 * 0x6CBE10, the gang setup, run for gangs 0..3 in order. In a single-player
 * game the player is always gang 0 (0x46B7C0) and its setup sets its drift to
 * 126 first, so every computer gang starts toward the player at
 * `(drift + 126) / 126 × 33 + 122` from its own profile drift (155 Peace,
 * 188 Cease-fire or 221 Aggression) and at 122 toward the other computer gangs.
 */
export function startingHostility(gang: Gang, other: Gang | undefined): number {
  if (!other?.isPlayer || !gang.aiProfile) return STARTING_HOSTILITY;
  return STARTING_HOSTILITY + Math.trunc((gang.aiProfile[4] + 126) / 126) * 33;
}

/** The stance a hostility reads as outside a quiet week (0x6DD950's thresholds). */
export function stanceOfHostility(h: number): DiplomacyLevel {
  return STANCES[h < 156 ? 1 : h < 189 ? 2 : h < 222 ? 3 : 4];
}

/** The ctor's roll (0x6CB1D2): Passive rows 0..7, Normal 8..15, Aggressive
 * 16..23; Random takes the ctor's fallback, any of the 24. */
export function rollOriginalProfile(opponents: GameOptions['opponents'], rng: Rng): number[] {
  const band = opponents === 'passive' ? 0 : opponents === 'normal' ? 1 : opponents === 'aggressive' ? 2 : null;
  const row = band == null ? rng.int(0, 23) : band * 8 + rng.int(0, 7);
  return [...ORIGINAL_AI_PROFILES[row]];
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** What each incident adds to the wronged gang's hostility toward the gang
 *  behind it: the original's direct-book bumps (deep/19_ida_r3_answers Q3). */
export const INCIDENT_HOSTILITY = { kill: 33, threaten: 33, bomb: 100, burgle: 66, sabotage: 12, abduct: 16, attacked: 16 } as const;

/**
 * A gang wronged by another. In the original city an AI gang's hostility
 * toward it rises by the original's amount at once (0x6DF6E0: 0x5A2B10 adds
 * and clamps to a byte, then a floor of 106), whether the gang behind it is
 * the player or another computer gang, and its weekly
 * stance machine answers from that; elsewhere an AI gang answers a serious
 * incident (a death, a threat, a raid, a fire or a bomb) with war and a
 * lesser one with aggression. The player's stance is the player's to set.
 */
export function provoke(w: WorldState, wrongedGangId: ID | null | undefined, byGangId: ID | null | undefined, amount: number): void {
  if (!amount || wrongedGangId == null || byGangId == null || wrongedGangId === byGangId) return;
  const gang = w.gangs[wrongedGangId];
  if (!gang || gang.isPlayer || gang.eliminated || !w.gangs[byGangId]) return;
  if (gang.aiProfile) {
    gang.aiHostility ??= {};
    gang.aiHostility[byGangId] = Math.max(106, clampByte((gang.aiHostility[byGangId] ?? startingHostility(gang, w.gangs[byGangId])) + amount));
  } else if (amount >= INCIDENT_HOSTILITY.kill) gang.offered[byGangId] = 'war';
  else if (stanceIndex(gang.offered[byGangId]) < stanceIndex('aggression')) gang.offered[byGangId] = 'aggression';
}

/** What "stop the leader" adds to hostility toward a gang close to winning. */
export const STOP_THE_LEADER = 200;
/** Worth over which a richer gang counts as the leader in any game. */
const LEADER_WORTH = 200_000;

/**
 * 0x6D5D70: the rival an AI gang singles out as close to winning, if any. In
 * gang order, a rival counts when it is ahead of this gang and at the top so
 * far: in a Territory game with more than 60% of the target in blocks, in a
 * Wealth game with more than 60% of the target in worth, and in any game with
 * more than $200,000 of worth. Worth is cash, property and equipment at half
 * price (0x6DD2A0, `gangWealth`); blocks are the territory held (0x4125C0).
 */
export function leadingRival(w: WorldState, gang: Gang): ID | null {
  const mode = w.options.mode;
  const myWorth = gangWealth(w, gang), myBlocks = territoryCount(w, gang.id);
  let leader: ID | null = null, topWorth = -1, topBlocks = -1;
  for (const other of Object.values(w.gangs)) {
    if (other.eliminated) continue;
    const worth = gangWealth(w, other), blocks = territoryCount(w, other.id);
    topWorth = Math.max(topWorth, worth);
    topBlocks = Math.max(topBlocks, blocks);
    if (mode === 'territory' && myBlocks < blocks && Math.trunc(w.options.territoryTarget * 60 / 100) < blocks && blocks === topBlocks)
      leader = other.id;
    if (mode === 'wealth' && myWorth < worth && Math.trunc(w.options.wealthTarget * 60 / 100) < worth && worth === topWorth)
      leader = other.id;
    if (myWorth < worth && worth > LEADER_WORTH && worth === topWorth) leader = other.id;
  }
  return leader === gang.id ? null : leader;
}

/**
 * One week of 0x6DD950 for an AI gang, after "stop the leader": returns the
 * stance it now holds toward each rival (the caller offers it through the
 * ordinary diplomacy path).
 */
export function originalWeeklyStance(w: WorldState, rng: Rng, gang: Gang): Map<ID, DiplomacyLevel> {
  const profile = gang.aiProfile!;
  gang.aiHostility ??= {}; gang.aiHostilitySnapshot ??= {};
  const leader = leadingRival(w, gang);
  if (leader != null)
    gang.aiHostility[leader] = Math.max(106, clampByte((gang.aiHostility[leader] ?? startingHostility(gang, w.gangs[leader])) + STOP_THE_LEADER));
  const result = new Map<ID, DiplomacyLevel>();
  for (const other of Object.values(w.gangs)) {
    if (other.id === gang.id || other.eliminated) continue;
    const start = startingHostility(gang, other);
    const prev = gang.aiHostilitySnapshot[other.id] ?? gang.aiHostility[other.id] ?? start;
    const raw = gang.aiHostility[other.id] ?? start;
    // The change since last week, by band: Passive warms at half of it and
    // cools at half as much again, Aggressive the other way round, Normal
    // takes it as it is. Clamped to a byte; the 106 floor comes after the bump.
    const change = raw - prev, rising = change > 0;
    const step = profile[6] === 0 ? Math.trunc(rising ? change / 2 : change * 3 / 2)
      : profile[6] === 2 ? Math.trunc(rising ? change * 3 / 2 : change / 2) : change;
    let cur = clampByte(prev + step);
    let stance: number, bump = 0;
    const theirs = stanceIndex(gang.known[other.id]);
    if (cur <= prev) {
      const v = Math.trunc((cur + (other.isPlayer ? ANCHOR_PLAYER_RIVAL : ANCHOR_AI_RIVAL)) / 2);
      stance = v < 156 ? 1 : v < 189 ? 2 : v < 222 ? 3 : 4;
      bump = PEACE_PRESSURE[stance][theirs];
    } else stance = cur < 156 ? 1 : cur < 189 ? 2 : cur < 222 ? 3 : 4;
    bump += Math.trunc((profile[4] - 128) / 8);
    if (bump > 0) bump -= 2 * profile[0];
    if (profile[5]) bump += rng.int(0, Math.max(0, (profile[5] >> 3) - 1)) - (profile[5] >> 4);
    cur = Math.max(106, clampByte(cur + bump));
    gang.aiHostility[other.id] = cur;
    gang.aiHostilitySnapshot[other.id] = cur;
    result.set(other.id, STANCES[stance]);
  }
  // The planner runs after the stance machine (0x6D61C4) and expands its root
  // task 0x31 every week, so 0x19 books every week: a rising week for next
  // week's machine. Original city only.
  if (w.cityLayout?.original)
    for (const [id, amount] of strengthBooking(w, gang)) provoke(w, gang.id, id, amount);
  return result;
}

/**
 * 0x6608E0, at the end of the city's weekly step (0x660609; also when the
 * offices are placed, 0x6565AE): each gang's share of the city's power, in
 * percent (city+0x2598 + 4·gang). Power is min(cash (gang+0x514) / 1000,
 * 20 000) + head count (0x6D8B80: boss, accountant, lawyer, crews and their
 * teams) + blocks held (0x4125C0) / 3. Gangs out of the game count 0.
 */
export function originalPowerShares(w: WorldState): Map<ID, number> {
  const power = new Map<ID, number>();
  for (const g of Object.values(w.gangs).sort((a, b) => a.id - b.id)) {
    if (g.eliminated) continue;
    const heads = peopleList(w).filter(p => p.gangId === g.id && p.status !== 'dead').length;
    power.set(g.id, Math.min(Math.trunc(g.cash / 1000), 20000) + heads + Math.trunc(territoryCount(w, g.id) / 3));
  }
  let total = [...power.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) total = 1;
  return new Map([...power].map(([id, v]) => [id, Math.trunc(v * 100 / total)]));
}

/**
 * 0x6AF840 (AI planner task 0x19): against each rival in the game, with
 * k = profile[0] / 5 + 1 and b = the band (profile[6]), a gang whose share is
 * under the rival's / 2k books (b·5 + 5)·2 hostility toward it (10/20/30),
 * and under the rival's / 3k (b·4 + 4)·5 (20/40/60); one whose share is over
 * 2k times the rival's books (b·5 + 5)·2, and over 3k times (b·4 + 4)·5. So
 * an AI gang turns on rivals far weaker or far stronger than itself, every
 * AI week (0x31 is the planner's permanent root and 0x19 re-runs on each
 * expansion). Two rare exceptions hang on planner state the remake does not
 * have (traced 29 October 2026; not ported):
 * - No booking: 0x32 (0x6AFA90) returns 1 while it holds a child and 2
 *   without (never 0); outside an election (city+0x2555 = 0) it makes none,
 *   so it is kept only in an election week where one of its campaign tasks
 *   (0x1A against a rival boss leading the poll, 0x24, 0x25, 0x27) planned.
 *   If 0x19 is new that same week and also kept, the root holds [0x32, 0x19];
 *   in the first later week in which 0x32 ends with no child it returns 2,
 *   0x6773F0 deletes it, shifts 0x19 into its slot and advances past it, and
 *   0x31's own run then finds 0x19 present: nothing is booked that week.
 * - Double booking: 0x19 returns 1 while it holds a child, 0 without (2 when
 *   it is the only gang left). It is kept only when 0x16 (0x4B0990, its table
 *   0x79C260) or 0x17 (0x73A130: a 0x1A attack task per rival whose stance
 *   byte is 2 or more) planned. In a later week in which both 0x16 and 0x17
 *   come back with nothing, 0x19 returns 0 as a child, 0x31 drops all its
 *   children, and its own run re-creates 0x32 and 0x19 at once: 0x19 books a
 *   second time that week.
 * Both hang on whether these subtasks (recruiting, buying, campaigning,
 * attack planning, and the orders they wait on) are still pending from an
 * earlier week. The remake's AI has no such task tree, so it books once in
 * every AI week.
 */
export function strengthBooking(w: WorldState, gang: Gang, shares = originalPowerShares(w)): Map<ID, number> {
  const out = new Map<ID, number>();
  const profile = gang.aiProfile;
  const own = shares.get(gang.id);
  if (!profile || own == null) return out;
  const k = Math.trunc(profile[0] / 5) + 1, band = profile[6];
  const small = (band * 5 + 5) * 2, large = (band * 4 + 4) * 5;
  for (const [id, r] of shares) {
    if (id === gang.id) continue;
    let amount = 0;
    if (own <= k * r) {
      if (own < Math.trunc(r / k) && own < Math.trunc(r / (k * 2))) amount = own < Math.trunc(r / (k * 3)) ? large : small;
    } else if (own > k * r * 2) amount = own <= k * r * 3 ? small : large;
    if (amount) out.set(id, amount);
  }
  return out;
}
