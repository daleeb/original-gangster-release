import { ORDERS } from './constants';
import type { Order, Person, Team, WorldState } from './types';
import { skillAvg } from './world';

export function crewPeople(w: WorldState, team: Team): Person[] {
  return [...new Set([team.lieutenantId, ...team.memberIds])].map(id => w.people[id])
    .filter((p): p is Person => !!p && p.gangId === team.gangId && p.teamId === team.id &&
      (p.id === team.lieutenantId ? p.role === 'lieutenant' : p.role === 'hood'));
}

/** Current jobs and return journeys can finish before a queued job begins. */
export function readyForPlanning(w: WorldState, p: Person): boolean {
  return p.status === 'active' && p.buildingId == null && p.burningEscape?.week !== w.week;
}

/** Free to be sent on a job during the week. As in the original, a man who
 * has finished one job goes straight on to the next: one only walking (or
 * driving an empty car) back to the office is turned round where he is,
 * rather than made to get home first while the rest of the week's orders wait. */
export function freeForDispatch(w: WorldState, p: Person): boolean {
  if (p.orderId != null || p.resumeOrderId != null || p.streetOrder) return false;
  if (p.emergencyResponse || p.shockReaction) return false;
  const car = p.vehicleKey ? w.vehicleFleet?.[p.vehicleKey] : undefined;
  if (p.vehicleKey && !car) return true;
  // Still bringing goods home, or unloading them: that journey is finished first.
  return !car || (car.returning && !car.cargo && !car.unloading && car.orderId == null);
}

export function orderStaffing(w: WorldState, team: Team, order: Pick<Order, 'type' | 'opts'>, planning = false) {
  const members = crewPeople(w, team).filter(p => p.status !== 'dead');
  const available = members.filter(p => readyForPlanning(w, p) && (planning || freeForDispatch(w, p)));
  const want = Math.max(1, order.opts.manpower);
  const preferred = order.opts.preferredHoodId == null ? null : members.find(p => p.id === order.opts.preferredHoodId);
  let reason: string | null = null, impossible = false;
  if (order.opts.preferredHoodId != null && !preferred) {
    reason = 'The preferred person is no longer available in this crew.'; impossible = true;
  } else if (members.length < want) {
    reason = `This order needs ${want} people, but only ${members.length} remain in the crew.`; impossible = true;
  } else if (preferred && !available.includes(preferred)) {
    reason = `${preferred.name} is ${planning ? 'unavailable' : 'not free yet'}; this order needs that person.`;
  } else if (available.length < want) {
    reason = `This order needs ${want} people; ${available.length} ${available.length === 1 ? 'is' : 'are'} ${planning ? 'available' : 'free'}.`;
    // Say what is keeping the others, so a queued order is not a mystery.
    if (!planning) {
      const busy = members.filter(p => !available.includes(p));
      const working = busy.filter(p => p.status === 'active' && (p.orderId != null || p.resumeOrderId != null || p.streetOrder)).length;
      const away = busy.filter(p => p.status !== 'active' || p.buildingId != null).length;
      const parts = [working ? `${working} still on an earlier order` : '', away ? `${away} out of action or running a business` : ''].filter(Boolean);
      if (parts.length) reason += ` (${parts.join(', ')}.) It starts as soon as enough of the crew are free.`;
    }
  }
  const chosen = preferred && available.includes(preferred) ? [preferred] : [];
  const lt = available.find(p => p.id === team.lieutenantId);
  const def = ORDERS[order.type];
  const dangerous = def.group === 'minor' || def.group === 'violent' || order.type === 'guardBusiness' || order.type === 'patrol';
  // Manual p.88: poor leaders avoid danger even when best suited to the job.
  // Three stars is remake tuning. A capable leader competes on task skill;
  // otherwise they remain the fallback, so accepted manpower is still filled.
  const willing = dangerous && lt && skillAvg(lt, ['organization', 'intelligence']) >= 3;
  const candidates = available.filter(p => p !== preferred && (p.id !== team.lieutenantId || willing))
    .sort((a, b) => skillAvg(b, def.skills) - skillAvg(a, def.skills) ||
      Number(a.id === team.lieutenantId) - Number(b.id ===team.lieutenantId));
  while (chosen.length < want && candidates.length) chosen.push(candidates.shift()!);
  if (chosen.length < want && lt && !chosen.includes(lt)) chosen.push(lt);
  return { chosen, available: available.length, reason, impossible };
}
