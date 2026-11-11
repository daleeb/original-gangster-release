import { WALK_SPEED } from './constants';
import { clearDestination, setDestination } from './movement';
import { alight } from './transport';
import type { Person, Vec2, WorldState } from './types';
import { roadPosition } from './vehicleNavigation';
import { attackProfile, UNARMED, type Loadout } from './weapons';
import { dist } from './world';

export function streetOrderRange(p: Person, loadout: Loadout): number {
  return p.streetOrder?.type === 'tail' ? 18 : p.streetOrder?.type === 'assault' ? UNARMED.range : attackProfile(loadout,p).spec.range;
}

/** How far a target may move before a pursuer re-plans: two minutes' walk.
 * (A fixed 12 m was one minute's walk before the clock took the original's
 * pace; at 0.54 m a minute it left pursuers chasing stale points for ~20 min.) */
export const PURSUIT_REPLAN_M = Math.max(1.5, WALK_SPEED * 2);

/**
 * Turn a pursuer toward where his man now is without throwing away the leg he
 * is on. A pavement route always begins at the nearest corner, which is often
 * the one behind him: planned afresh each time the target moved, he walked back
 * to that corner over and over (pacing one block face while the target ambled
 * off). So he keeps heading for his next waypoint when it is a crossing or
 * brings him closer, and the new route is taken up from there.
 */
export function replanPursuit(w: WorldState, p: Person, to: Vec2): void {
  const next = p.dest ? p.path[0] : undefined;
  if (next && (next.cross || dist(next, to) < dist(p.pos, to))) {
    const route = { ...p, pos: { x: next.x, y: next.y } };
    setDestination(w, route, to);
    p.dest = route.dest;
    p.path = [{ ...next }, ...route.path];
  } else setDestination(w, p, to);
}

/** Keep a pursuit's route until its target moves. Restarting a pavement route
 * every minute sends the walker back to the same junction indefinitely. */
export function prepareStreetPursuit(w: WorldState, p: Person, target: Person, range: number): boolean {
  const order = p.streetOrder!;
  const inReach = dist(p.pos,target.pos) <= range;
  // Cars stop on the road. Finish the last leg on foot when the target cannot
  // be reached from there, and never try to punch someone from inside a car.
  if (p.inVehicle && ((inReach && range === UNARMED.range) ||
      (!inReach && dist(p.pos,roadPosition(w,target.pos)) < .5) ||
      // Beside the target's stretch of road with no route left: on foot from
      // here (re-planning across the road and back, he never got out).
      (range === UNARMED.range && !p.dest && dist(p.pos,roadPosition(w,target.pos)) < PURSUIT_REPLAN_M))) {
    alight(w,p);
    clearDestination(p);
  }
  if (inReach) { clearDestination(p); return true; }

  if (!p.dest) {
    setDestination(w,p,target.pos);
    order.pos = {...target.pos};
  } else if (order.pos && dist(order.pos,target.pos) > PURSUIT_REPLAN_M) {
    // Finish the current leg before changing direction. In particular, keep
    // the current crossing and its traffic check rather than retreating to it.
    // Keep heading for the next waypoint when it is a crossing or brings him
    // closer; otherwise re-plan from where he stands, since that waypoint
    // would turn him back just as he is closing in.
    replanPursuit(w, p, target.pos);
    order.pos = {...target.pos};
  } else if (!order.pos) {
    // Historical saves did not store the position used for the pursuit.
    order.pos = {...target.pos};
  }
  return false;
}
