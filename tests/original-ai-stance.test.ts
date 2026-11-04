import { describe, expect, it } from 'vitest';
import { newCampaignOptions } from '../src/app/newGame';
import { INCIDENT_HOSTILITY, leadingRival, ORIGINAL_AI_PROFILES, originalWeeklyStance, provoke, rollOriginalProfile, stanceOfHostility, startingHostility } from '../src/sim/aiStance';
import { recordCrime } from '../src/sim/events';
import { allBuildings, territoryCount } from '../src/sim/world';
import { createWorld } from '../src/sim/citygen';
import { Rng } from '../src/sim/rng';
import { validateSaveWorld } from '../src/sim/saveSchema';

describe('original AI profile and stance machine (0x6CAB20, 0x6DD950)', () => {
  it('rolls a profile from the difficulty band: Passive 0..7, Normal 8..15, Aggressive 16..23 (R-03)', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 40; i++) {
      expect(rollOriginalProfile('passive', rng)[6]).toBe(0);
      expect(rollOriginalProfile('normal', rng)[6]).toBe(1);
      expect(rollOriginalProfile('aggressive', rng)[6]).toBe(2);
      const any = rollOriginalProfile('random', rng).join();
      expect(ORIGINAL_AI_PROFILES.some(r => r.join() === any)).toBe(true);
    }
  });

  it('gives every AI gang in the original city a profile, and saves it', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404, opponents: 'aggressive' }).world;
    for (const g of Object.values(w.gangs)) {
      if (g.isPlayer) expect(g.aiProfile).toBeUndefined();
      else expect(g.aiProfile![6]).toBe(2);
    }
    expect(() => validateSaveWorld(JSON.parse(JSON.stringify(w)))).not.toThrow();
  });

  it('starts a computer gang toward the player by its drift (0x6CBE10), at peace with the others, and opens at that stance', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(g => g.isPlayer)!;
    const ai = Object.values(w.gangs).filter(g => !g.isPlayer);
    for (const g of ai) {
      const h = startingHostility(g, player);
      expect(h).toBe(122 + Math.trunc((g.aiProfile![4] + 126) / 126) * 33);
      expect(g.offered[player.id]).toBe(stanceOfHostility(h));
      expect(player.known[g.id]).toBe(g.offered[player.id]);
      for (const other of ai) if (other !== g) {
        expect(startingHostility(g, other)).toBe(122);
        expect(g.offered[other.id]).toBe('peace');
      }
    }
    // Drift 63 / 126 / 255: Peace, Cease-fire, Aggression.
    const g = ai[0];
    const at = (row: number) => { g.aiProfile = [...ORIGINAL_AI_PROFILES[row]]; return startingHostility(g, player); };
    expect([at(0), at(1), at(19)]).toEqual([155, 188, 221]);
    expect([155, 188, 221].map(stanceOfHostility)).toEqual(['peace', 'ceasefire', 'aggression']);
  });

  it('a strong hostility drift escalates to aggression but never to war on its own; a calm passive profile stays at peace', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(g => g.isPlayer)!;
    const [a, b] = Object.values(w.gangs).filter(g => !g.isPlayer);
    a.aiProfile = [...ORIGINAL_AI_PROFILES[19]];   // drift 255, no damper, no noise
    b.aiProfile = [...ORIGINAL_AI_PROFILES[6]];    // calm passive
    const rng = new Rng(8);
    let hostile = originalWeeklyStance(w, rng, a), calm = originalWeeklyStance(w, rng, b);
    const seen = new Set<string>();
    for (let week = 0; week < 16; week++) {
      hostile = originalWeeklyStance(w, rng, a); calm = originalWeeklyStance(w, rng, b);
      for (const [id, s] of hostile) { a.offered[id] = s; seen.add(s); }
      for (const [id, s] of calm) b.offered[id] = s;
    }
    // Drift +15 a week. A quiet week decays toward (hostility + the rival's
    // own-stance anchor)/2, so Aggression needs 206 against the player
    // (anchor 172) and 239 against a computer gang (139), and War is out of reach.
    // Against the player it starts at 221 and settles where drift and peace
    // pressure balance, at that 206 edge: Aggression or just below it.
    expect(seen.has('war')).toBe(false);
    expect(['ceasefire', 'aggression']).toContain(hostile.get(player.id));
    expect(a.aiHostility![player.id]).toBeGreaterThanOrEqual(199);
    expect(a.aiHostility![player.id]).toBeLessThan(222);
    for (const [id, s] of hostile) if (id !== player.id) {
      expect(s).toBe('aggression');
      expect(a.aiHostility![id]).toBeGreaterThanOrEqual(239);
    }
    expect([...calm.values()].every(s => s === 'peace')).toBe(true);   // warmed from its 188 start
    expect(Object.values(b.aiHostility!).every(h => h >= 106)).toBe(true);
  });

  it('a bombing and a killing: an aggressive gang goes to war, a passive one takes half the rise and stops short of it', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(g => g.isPlayer)!;
    const [hard, calm] = Object.values(w.gangs).filter(g => !g.isPlayer);
    hard.aiProfile = [...ORIGINAL_AI_PROFILES[9]];   // aggressive band: the change as it is
    calm.aiProfile = [...ORIGINAL_AI_PROFILES[6]];   // passive band: half of a rise
    const rng = new Rng(8);
    for (const g of [hard, calm]) {
      for (const [id, s] of originalWeeklyStance(w, rng, g)) g.offered[id] = s;
      expect(g.offered[player.id]).toBe('ceasefire');   // both start at 188 (drift 192, 126)
    }
    const calmBefore = calm.aiHostility![player.id];
    // A bomb at one of its premises, and one of its men shot dead.
    const premises = allBuildings(w).find(b => b.ownerGangId === calm.id)!;
    const boss = w.people[calm.bossId];
    recordCrime(w, rng, { gangId: player.id, perpetratorId: w.people[player.bossId].id, type: 'bomb', pos: boss.pos, buildingId: premises.id });
    expect(calm.aiHostility![player.id]).toBe(Math.min(255, calmBefore + INCIDENT_HOSTILITY.bomb));
    provoke(w, calm.id, player.id, INCIDENT_HOSTILITY.kill);
    provoke(w, hard.id, player.id, INCIDENT_HOSTILITY.bomb);
    provoke(w, hard.id, player.id, INCIDENT_HOSTILITY.kill);
    for (const g of [hard, calm]) for (const [id, s] of originalWeeklyStance(w, rng, g)) g.offered[id] = s;
    expect(hard.offered[player.id]).toBe('war');
    expect(calm.offered[player.id]).not.toBe('war');
    expect(calm.aiHostility![player.id]).toBeLessThan(222);
    // The next, quiet week the aggressive gang falls back to aggression.
    for (const [id, s] of originalWeeklyStance(w, rng, hard)) hard.offered[id] = s;
    expect(hard.offered[player.id]).toBe('aggression');
  });

  it('smooths by band: passive warms by half and cools by half as much again, random the other way round', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(g => g.isPlayer)!, g = Object.values(w.gangs).find(x => !x.isPlayer)!;
    // No drift, damper or noise; the rival's stance is set where a falling
    // week's peace pressure adds nothing (cease-fire against cease-fire).
    const after = (band: number, from: number, to: number) => {
      g.aiProfile = [0, 0, 0, 0, 128, 0, band];
      g.known[player.id] = 'ceasefire';
      g.aiHostilitySnapshot = { [player.id]: from }; g.aiHostility = { [player.id]: to };
      originalWeeklyStance(w, new Rng(1), g);
      return g.aiHostility[player.id];
    };
    expect(after(0, 140, 200)).toBe(170);   // +60 → +30
    expect(after(0, 200, 160)).toBe(140);   // −40 → −60
    expect(after(1, 140, 200)).toBe(200);
    expect(after(2, 140, 200)).toBe(230);   // +60 → +90
    expect(after(2, 200, 160)).toBe(180);   // −40 → −20
  });

  it('stop the leader (0x6D5D70): +200 hostility toward a rival ahead and worth over $200,000, which brings war that week', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(x => x.isPlayer)!;
    const [g, other] = Object.values(w.gangs).filter(x => !x.isPlayer);
    g.aiProfile = [...ORIGINAL_AI_PROFILES[9]];
    const rng = new Rng(8);
    for (const [id, s] of originalWeeklyStance(w, rng, g)) g.offered[id] = s;
    expect(leadingRival(w, g)).toBeNull();
    const before = g.aiHostility![player.id];
    player.cash += 300_000;
    other.cash += 250_000;                            // richer than g, but not the top
    expect(leadingRival(w, g)).toBe(player.id);
    for (const [id, s] of originalWeeklyStance(w, rng, g)) g.offered[id] = s;
    expect(g.aiHostility![player.id]).toBeGreaterThanOrEqual(222);
    expect(g.aiHostility![player.id]).toBeGreaterThan(before);
    expect(g.offered[player.id]).toBe('war');
    expect(g.offered[other.id]).not.toBe('war');
    // A gang never singles itself out.
    g.cash += 1_000_000;
    expect(leadingRival(w, g)).toBeNull();
  });

  it('in a Territory game the leader is the rival past 60% of the target in blocks', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404, mode: 'territory' }).world;
    const blocks = (id: number) => territoryCount(w, id);
    const gangs = Object.values(w.gangs);
    const top = Math.max(...gangs.map(x => blocks(x.id)));
    // The computer gang holding least, so somebody is ahead of it.
    const g = gangs.filter(x => !x.isPlayer).sort((a, b) => blocks(a.id) - blocks(b.id))[0];
    expect(leadingRival(w, g)).toBeNull();
    expect(blocks(g.id)).toBeLessThan(top);
    // A target whose 60% only the top holding passes.
    w.options.territoryTarget = Math.floor(top * 100 / 60) - 1;
    const leader = leadingRival(w, g)!;
    expect(leader).not.toBeNull();
    expect(blocks(leader)).toBe(top);
    // Below 60% of the target nobody is singled out.
    w.options.territoryTarget = Math.ceil(top * 100 / 60) + 1;
    expect(leadingRival(w, g)).toBeNull();
  });

  it('elsewhere a rival answers a killing with war and a smashed window with aggression; the player sets his own', () => {
    const w = createWorld({ ...newCampaignOptions(), seed: 404 }).world;
    const player = Object.values(w.gangs).find(g => g.isPlayer)!, [a, b] = Object.values(w.gangs).filter(g => !g.isPlayer);
    delete a.aiProfile; delete b.aiProfile;
    a.offered[player.id] = 'peace'; b.offered[player.id] = 'peace';
    provoke(w, a.id, player.id, INCIDENT_HOSTILITY.kill);
    provoke(w, b.id, player.id, INCIDENT_HOSTILITY.sabotage);
    expect(a.offered[player.id]).toBe('war');
    expect(b.offered[player.id]).toBe('aggression');
    const before = player.offered[a.id];
    provoke(w, player.id, a.id, INCIDENT_HOSTILITY.bomb);
    expect(player.offered[a.id]).toBe(before);
  });
});
