import { act, useGame } from '../app/store';
import type { PickResult } from '../render/scene';
import { BUY_REACH_BLOCKS, CENTRE_LOT_NEEDS_FRONT, allocateBlocks, issueStreetOrder, nearTerritory } from '../sim/api';
import { centreLotNeedsFront, purchasablePremisesType, siteBuilding } from '../sim/premises';
import { ORDERS } from '../sim/constants';
import { VIEW_ZOOM } from '../render/viewModes';
import type { ID } from '../sim/types';
import { toggleOrderBlocks, orderPersonAtSite, selectableOrderPerson, selectableOrderSite } from '../app/orderSelection';
import { specialistPeopleBySite } from '../app/specialistSelection';
import { canonicalAreaBlocks, lieutenantAreaChoices } from '../sim/lieutenantAreas';

export interface MapClickOptions {
  /** For an area order: this click means one site, not the whole block. */
  site?: boolean;
  /** Ctrl held: add the person to the street selection rather than replacing it. */
  add?: boolean;
  /** The click came from the City Plan rather than the 3D city. */
  fromPlan?: boolean;
}

/**
 * What a click on the city means, whichever map it lands on — the 3D city or
 * the blueprint plan. Depending on what the player is doing it picks a job
 * card's targets, allocates a lieutenant's blocks, gives a street order, or
 * simply selects what was clicked.
 */
export function handleMapHit(hit: PickResult, opts: MapClickOptions = {}): void {
  const state = useGame.getState();
  const s = state.sim;
  if (!s) return;
  const mode = state.pickMode;
  // The terraces of an apartment block are part of it: a click on one is a click on the block's tenement.
  const clicked = hit.buildingId != null ? s.world.buildings[hit.buildingId] : undefined;
  if (clicked) hit = { ...hit, buildingId: siteBuilding(s.world, clicked).id };

  // `point` is only meaningful when something in the city was actually hit;
  // a click on the sky leaves it at the map origin.
  const onMap = hit.blockId != null || hit.buildingId != null;
  if (mode?.kind === 'specialist' && state.specialistCard) {
    const id = hit.personId ?? (hit.buildingId == null ? null : specialistPeopleBySite(s.world, s.playerGang.id, state.specialistCard.type).get(hit.buildingId));
    if (id != null) state.selectSpecialistTarget(id);
    return;
  }

  // ---- picking targets for a job card
  if (mode?.kind === 'order' && state.jobCard) {
    const def = ORDERS[state.jobCard.type];
    switch (def.target) {
      case 'person': {
        const site = hit.buildingId != null ? s.world.buildings[hit.buildingId] : null;
        const id = hit.personId ?? (site ? orderPersonAtSite(s.world, s.playerGang.id, state.jobCard.type, site) : null);
        const person = id != null ? s.world.people[id] : null;
        if (person && selectableOrderPerson(s.world, s.playerGang.id, state.jobCard.type, person)) state.updateJobCard({ personId: person.id });
        break;
      }
      case 'building':
        // One site at a time: a second click chooses somewhere else.
        if (hit.buildingId != null && s.world.buildings[hit.buildingId] &&
          selectableOrderSite(s.world, s.playerGang.id, state.jobCard, s.world.buildings[hit.buildingId]))
          state.updateJobCard({ buildingIds: [hit.buildingId] });
        else if (hit.buildingId != null && state.jobCard.type === 'buyPremises') {
          // A site that looks for sale and is not: say which rule is in the way.
          const site = s.world.buildings[hit.buildingId];
          if (site && site.ownerGangId == null && site.state !== 'destroyed' && purchasablePremisesType(site)) {
            if (centreLotNeedsFront(s.world, s.playerGang.id, site)) state.notify({ ok: false, error: CENTRE_LOT_NEEDS_FRONT });
            else if (!nearTerritory(s.world, s.playerGang.id, site.blockId, BUY_REACH_BLOCKS))
              state.notify({ ok: false, error: `Too far from your territory: you can only buy within ${BUY_REACH_BLOCKS} blocks of it.` });
          }
        }
        break;
      case 'area':
        // A click takes the whole block; a shift-click takes just the one site.
        if (hit.buildingId != null && opts.site) state.toggleJobTargetBuilding(hit.buildingId);
        else if (hit.blockId != null) state.toggleJobTargetBlock(hit.blockId);
        break;
      case 'point':
        if (!onMap) break;
        state.updateJobCard({ pos: hit.point });
        // Deep26 §3.6: a City Plan click zooms to Rooftop View, where the
        // pavement point is picked precisely (the next click refines it).
        if (opts.fromPlan) {
          state.setPlanningView('city');
          state.requestCamera({ ...hit.point, zoom: VIEW_ZOOM.roof });
        }
        return;
      default:
        break;
    }
    if (onMap) state.updateJobCard({ pos: hit.point });
    return;
  }

  // ---- allocating a lieutenant's patch
  if (mode?.kind === 'lieutenantArea') {
    if (hit.blockId == null) return;
    const team = s.world.teams[mode.teamId];
    if (!team) {
      state.setPickMode(null);
      state.notify('That crew no longer exists.');
      return;
    }
    const id = canonicalAreaBlocks(s.world, [hit.blockId])[0];
    if (id == null) return;
    const current = canonicalAreaBlocks(s.world, team.allocatedBlockIds);
    const next = current.includes(id) ? current.filter(b => b !== id) : [...current, id];
    const res = act((sim) => allocateBlocks(sim.world, sim.playerGang.id, mode.teamId, next));
    if (res && !res.ok) state.notify(res);
    return;
  }

  // ---- the lawyer's tour: blocks toggle in and out
  if (mode?.kind === 'policeArea') {
    if (hit.blockId != null) state.togglePoliceAreaBlock(hit.blockId);
    return;
  }

  // ---- live street orders
  if (mode?.kind === 'streetOrder') {
    let res;
    if (mode.orderType === 'goTo') {
      if (!onMap) {
        state.notify('Click somewhere in the city.');
        return;
      }
      res = act((sim) => issueStreetOrder(sim.world, sim.playerGang.id, mode.personIds, 'goTo', null, hit.point));
    } else if (hit.personId != null) {
      res = act((sim) => issueStreetOrder(sim.world, sim.playerGang.id, mode.personIds, mode.orderType, hit.personId, null));
    } else {
      state.notify('Click on a person to complete that order.');
      return;
    }
    if (res?.ok) {
      state.setPickMode(null);
      state.notify(`${res.message ?? 'Orders given.'}${state.paused ? ' Paused — press Space to continue.' : ''}`);
    } else if (res) state.notify(res);
    return;
  }

  // ---- plain selection; Ctrl-click gathers your own people for one street order
  if (hit.personId != null && opts.add && s.world.people[hit.personId]?.gangId === s.playerGang.id) state.togglePersonSelected(hit.personId);
  else if (hit.personId != null) state.selectPerson(hit.personId);
  else if (hit.buildingId != null) state.selectBuilding(hit.buildingId);
  else {
    state.selectBuilding(null);
    state.selectPerson(null);
  }
}

/** A box dragged over the plan for an area order: every block inside it. */
export function handleMapBox(blockIds: ID[]): void {
  const state = useGame.getState();
  if (!state.sim) return;
  const sim = state.sim, mode = state.pickMode;
  const ids = [...new Set(blockIds.map(id => sim.world.blocks[id]?.layout?.mergedInto ?? id))].filter(id => sim.world.blocks[id]);
  if (!ids.length) return;
  if (mode?.kind === 'lieutenantArea') {
    const team = sim.world.teams[mode.teamId];
    if (team) {
      const { selected, available } = lieutenantAreaChoices(sim.world, sim.playerGang.id, team.id);
      const eligible = ids.filter(id => available.has(id));
      if (!eligible.length) { state.notify('No unassigned territory in that area.'); return; }
      const current = [...selected];
      const next = eligible.every(id => selected.has(id)) ? current.filter(id => !eligible.includes(id)) : [...new Set([...current, ...eligible])];
      state.notify(act(s => allocateBlocks(s.world, s.playerGang.id, team.id, next))!);
    } else {
      state.setPickMode(null);
      state.notify('That crew no longer exists.');
    }
    return;
  }
  if (mode?.kind === 'policeArea') {
    const remove = ids.every(id => state.policeAreaBlockIds.includes(id));
    for (const id of ids) if (remove || !state.policeAreaBlockIds.includes(id)) state.togglePoliceAreaBlock(id);
    return;
  }
  if (mode?.kind !== 'order' || !state.jobCard) return;
  const def = ORDERS[state.jobCard.type];
  // Other orders have no use for a box.
  if (def.target !== 'area') return;
  state.updateJobCard(toggleOrderBlocks(sim.world, sim.playerGang.id, state.jobCard, ids));
}
