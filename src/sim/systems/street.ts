import { addMessage, recordCrime } from '../events';
import { respondToBureauViolence } from '../bureauViolence';
import { keepContactDistance, killPerson, knockDown } from '../execution';
import { dist } from '../world';
import { originalFireRoll } from '../fireRoll';
import { presentAttack } from '../presentationEvents';
import { absoluteMinute, UNDER_FIRE_MINUTES } from './combat';
import { clearDestination, setDestination, stepPerson } from '../movement';
import { trafficContext } from '../traffic';
import { prepareStreetPursuit, streetOrderRange } from '../streetPursuit';
import type { Rng } from '../rng';
import type { Person, WorldState } from '../types';
import { closeCombatBlow, endCloseCombat, meleeWeapon, spendLostTurn, type Blow } from '../closeCombat';
import { allocateWeapons, attackProfile, type Loadout } from '../weapons';
import { peopleList } from '../entityLists';

/**
 * Orders given directly to hoods during the working week: kill, assault, tail
 * and go-to. They pre-empt whatever the lieutenant had planned.
 */
export function tickStreetOrders(w: WorldState, rng: Rng, minutes: number, loadout: Loadout = allocateWeapons(w)): void {
  if (minutes <= 0) return;
  for (const p of peopleList(w)) {
    // A fight that has gone quiet is over: the man gets back on his feet.
    const blow = p.closeCombat?.lastBlow;
    if (blow && (blow.week !== w.week || w.minute - blow.minute > CLOSE_COMBAT_QUIET)) endCloseCombat(p);
    // A beaten man gets back on his feet after a while, not at the week's end.
    if (p.status === 'beaten' && p.beatenUntil != null && p.beatenUntil <= absoluteMinute(w)) {
      p.status = 'active';
      delete p.beatenUntil;
    }
    const so = p.streetOrder;
    if (!so || p.status !== 'active' || p.burningEscape?.week===w.week) continue;

    if (so.type === 'goTo') {
      if (!so.pos) {
        p.streetOrder = null;
        clearDestination(p);
        continue;
      }
      if (!p.dest) setDestination(w, p, so.pos);
      if (stepPerson(p, minutes, trafficContext(w))) p.streetOrder = null;
      continue;
    }

    const target = so.targetPersonId != null ? w.people[so.targetPersonId] : null;
    if (!target || (target.status !== 'active' && target.status !== 'beaten')) {
      p.streetOrder = null;
      clearDestination(p);
      continue;
    }

    const { weapon, spec, skill } = attackProfile(loadout, p);
    const range = streetOrderRange(p,loadout);
    if (!prepareStreetPursuit(w,p,target,range)) {
      stepPerson(p, minutes, trafficContext(w));
      if (!prepareStreetPursuit(w,p,target,range)) continue;
    }
    if (so.type === 'tail') continue;

    // In reach: stop the route so interpolation cannot slide a stationary attacker.
    clearDestination(p);
    if (p.gangId == null) {
      p.streetOrder = null;
      clearDestination(p);
      continue;
    }

    // Original city: a Kill without a gun becomes an Assault (0x4D6E40 sets
    // order type 0x18), so it ends when the victim is down or spent.
    if (so.type === 'kill' && !weapon && w.cityLayout?.original) so.type = 'assault';

    if (so.type === 'kill' && !weapon) {
      // Close combat: the original's Cart.txt exchange (closeCombat.ts).
      keepContactDistance([p], target);
      const blow = exchange(w, rng, p, target, true, loadout);
      if (blow?.lethal) {
        killPerson(w, target, 'killed in close combat');
        recordCrime(w, rng, { gangId: p.gangId, perpetratorId: p.id, type: 'streetKill', pos: target.pos, victimId: target.id, severity: 10 });
        addMessage(w, 'combat', `${target.name} was killed in close combat by ${p.name}.`, target.pos, p.id);
        endCloseCombat(p); p.streetOrder = null;
      } else if (blow && !blow.hit) {
        recordCrime(w, rng, { gangId: p.gangId, perpetratorId: p.id, type: 'streetAssault', pos: p.pos, severity: 5 });
      }
      if (blow?.hit && !so.bureauResponseApplied && respondToBureauViolence(w, p.gangId, target)) so.bureauResponseApplied = true;
      if (blow && w.gangs[p.gangId]?.isPlayer && !blow.lethal) addMessage(w, 'combat', blowReport(p, target, blow), target.pos, p.id);
      // The victim's answer may have killed him.
      if ((p.status as string) !== 'active') { endCloseCombat(target); p.streetOrder = null; }
      continue;
    }

    if (so.type === 'kill') {
      // One attempt per simulation tick (6.7 real seconds at Normal). Skill
      // controls accuracy, not minutes of random inactivity before firing.
      // Guns use the original fire roll (fireRoll.ts); melee keeps the remake model.
      const shot = weapon ? originalFireRoll(rng, p, target, weapon, dist(p.pos, target.pos)) : null;
      if (!weapon) keepContactDistance([p], target);
      const hit = shot ? shot.hit : rng.chance(Math.min(0.9, spec.accuracy * (0.45 + skill * 0.14) * (1 - (target.skills.stealth - 0.5) * 0.07)));
      presentAttack(w, p, target, weapon, hit);
      target.underFireUntil = absoluteMinute(w) + UNDER_FIRE_MINUTES;
      if (hit) {
        if (shot) { if (shot.kills) target.hp = 0; }
        else target.hp -= spec.damage * rng.range(0.7, 1.25);
        const lethal = target.hp <= 0;
        if (lethal) {
          killPerson(w, target, weapon ? 'shot down in the street' : 'killed in close combat');
        }
        // One response for this actor's attack order, including after a save/load.
        // Misses have no victim attribution; later hits/death do not add it again.
        if (!so.bureauResponseApplied && respondToBureauViolence(w, p.gangId, target)) {
          so.bureauResponseApplied = true;
        }
        if (lethal) {
          recordCrime(w, rng, {
            gangId: p.gangId,
            perpetratorId: p.id,
            type: 'streetKill',
            pos: target.pos,
            victimId: target.id,
            severity: 10,
          });
          addMessage(w, 'combat', `${target.name} was ${weapon ? 'shot dead' : 'killed in close combat'} by ${p.name}.`, target.pos, p.id, weapon ? 'gunshot' : undefined);
          p.streetOrder = null;
        } else if (w.gangs[p.gangId]?.isPlayer) {
          addMessage(w, 'combat', weapon ? `${p.name} shot ${target.name}, who is wounded but still standing.`
            : `${p.name} struck ${target.name} — ${Math.ceil(target.hp)} hp remaining.`, target.pos, p.id, weapon ? 'gunshot' : undefined);
        }
      } else {
        recordCrime(w, rng, {
          gangId: p.gangId,
          perpetratorId: p.id,
          type: weapon ? 'shootout' : 'streetAssault',
          pos: p.pos,
          severity: 5,
        });
        if (w.gangs[p.gangId]?.isPlayer) addMessage(w, 'combat', `${p.name} ${weapon ? 'fired at' : 'swung at'} ${target.name} and missed.`, target.pos, p.id, weapon ? 'gunshot' : undefined);
      }
      continue;
    }

    if (so.type === 'assault') {
      // The same exchange with bare fists; the beating ends once he is down or spent.
      keepContactDistance([p], target);
      const blow = exchange(w, rng, p, target, false, loadout);
      if (!blow) continue;
      if (blow.lethal) {
        killPerson(w, target, 'beaten to death');
        recordCrime(w, rng, { gangId: p.gangId, perpetratorId: p.id, type: 'streetKill', pos: target.pos, victimId: target.id, severity: 10 });
        addMessage(w, 'combat', `${target.name} died from a beating by ${p.name}.`, target.pos, p.id);
        endCloseCombat(p); p.streetOrder = null;
        continue;
      }
      if (!blow.hit) {
        if (w.gangs[p.gangId]?.isPlayer) addMessage(w, 'combat', blowReport(p, target, blow), target.pos, p.id);
        continue;
      }
      // The fight also ends at 0 stamina (0x465C20), down or not.
      if (blow.posture === 'standing' && !blow.exhausted) {
        if (w.gangs[p.gangId]?.isPlayer) addMessage(w, 'combat', blowReport(p, target, blow), target.pos, p.id);
        continue;
      }
      target.hp = Math.max(5, target.hp);
      knockDown(w, target);
      respondToBureauViolence(w, p.gangId, target);
      recordCrime(w, rng, {
        gangId: p.gangId,
        perpetratorId: p.id,
        type: 'streetAssault',
        pos: target.pos,
        victimId: target.id,
        severity: 5,
      });
      addMessage(w, 'combat', `${p.name} gave ${target.name} a beating.`, target.pos, p.id);
      endCloseCombat(p);
      p.streetOrder = null;
    }
  }
}

/** Game minutes without a blow after which a fighter is no longer engaged. */
const CLOSE_COMBAT_QUIET = 20;

/** Who fights back: gang members, police and FBI, while on their feet. */
const FIGHTS_BACK = new Set<Person['role']>(['boss', 'lieutenant', 'hood', 'police', 'fbi', 'policeChief', 'fbiHead']);

/**
 * One exchange (0x465330 alternates attack and defend): the attacker's blow
 * unless he has a turn to lose, then the victim's answer if he can give one.
 * Returns the attacker's blow, or null when he sat this exchange out.
 */
function exchange(w: WorldState, rng: Rng, p: Person, target: Person, kill: boolean, loadout: Loadout): Blow | null {
  if (spendLostTurn(p)) return null;
  // Original city: close combat never kills (a gunless Kill is an Assault, 0x4D6E40).
  const meleeKills = !w.cityLayout?.original;
  const blow = closeCombatBlow(rng, p, target, meleeWeapon(p, kill), loadout.get(p.id), w.minute, w.week, meleeKills);
  presentAttack(w, p, target, undefined, blow.hit, { attack: blow.attack, reaction: blow.entry[0] });
  if (blow.lethal || !FIGHTS_BACK.has(target.role) || target.closeCombat?.posture !== 'standing') return blow;
  if (spendLostTurn(target)) return blow;
  const answer = closeCombatBlow(rng, target, p, meleeWeapon(target, kill), loadout.get(target.id), w.minute, w.week, meleeKills);
  presentAttack(w, target, p, undefined, answer.hit, { attack: answer.attack, reaction: answer.entry[0] });
  if (answer.lethal) {
    killPerson(w, p, 'killed in close combat');
    addMessage(w, 'combat', `${p.name} was killed in close combat by ${target.name}.`, p.pos, target.id);
  }
  return blow;
}

const POSTURE_WORDS = { standing: 'still standing', kneeling: 'now kneeling', down: 'now on the ground' } as const;
function blowReport(p: Person, target: Person, blow: Blow): string {
  return blow.hit ? `${p.name} landed a blow on ${target.name}, ${POSTURE_WORDS[blow.posture]}.`
    : `${p.name} swung at ${target.name} and missed.`;
}
