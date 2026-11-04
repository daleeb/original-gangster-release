import { BUY_REACH_BLOCKS, defaultOptions, nearTerritory, validBuildingTarget } from '../sim/api';
import { ORDERS } from '../sim/constants';
import { expandTargets, isValidAreaTarget } from '../sim/execution';
import { buildingMapIntel } from '../sim/mapIntel';
import type { Building, ID, OrderType, Person, WorldState } from '../sim/types';
import type { JobCard } from './store';
import { peopleList, buildingList } from '../sim/entityLists';

/** Map/clipboard candidates share the order rules without spending time or IDs. */
export function selectableOrderSite(w: WorldState, gangId: ID, card: Pick<JobCard, 'type' | 'opts'>, b: Building): boolean {
  if (!buildingMapIntel(b, gangId).siteKnown || b.state === 'destroyed') return false;
  if (ORDERS[card.type].target === 'area') return isValidAreaTarget(w, gangId, card.type, b);
  if (ORDERS[card.type].target !== 'building') return false;
  // Choose the premises first, then configure its business and front on the card.
  if (card.type === 'setUpBusiness') return b.ownerGangId === gangId;
  return validBuildingTarget(w, gangId, card.type, b, defaultOptions(card.opts)) &&
    (card.type !== 'buyPremises' || nearTerritory(w, gangId, b.blockId, BUY_REACH_BLOCKS));
}

export function selectableOrderPerson(w: WorldState, gangId: ID, type: OrderType, p: Person): boolean {
  if (ORDERS[type].target !== 'person' || ['dead', 'jailed', 'kidnapped'].includes(p.status)) return false;
  if (type === 'kidnap' && (p.gangId == null || p.gangId === gangId)) return false;
  if (p.gangId == null || p.gangId === gangId || w.gangs[gangId].knownPeople.includes(p.id)) return true;
  // A stranger at a site you know can be named as a target: the crew has to
  // hunt for him first (previewOrder marks the order as hunting).
  const site = p.buildingId != null ? w.buildings[p.buildingId] : null;
  return !!site && buildingMapIntel(site, gangId).siteKnown;
}

/** A public owner, manager, or known occupant can be selected through their site. */
export function orderPersonAtSite(w: WorldState, gangId: ID, type: OrderType, b: Building): ID | null {
  if (!buildingMapIntel(b, gangId).siteKnown) return null;
  const ids = [b.ownerPersonId, b.managerId, ...peopleList(w).filter(p => p.buildingId === b.id).map(p => p.id)];
  return ids.find(id => id != null && w.people[id] && selectableOrderPerson(w, gangId, type, w.people[id])) ?? null;
}

export function orderPeopleBySite(w: WorldState, gangId: ID, type: OrderType): Map<ID, ID> {
  const result = new Map<ID, ID>();
  for (const b of buildingList(w)) {
    if (!buildingMapIntel(b, gangId).siteKnown) continue;
    const id = [b.ownerPersonId, b.managerId].find(id => id != null && w.people[id] && selectableOrderPerson(w, gangId, type, w.people[id]));
    if (id != null) result.set(b.id, id);
  }
  for (const p of peopleList(w)) if (p.buildingId != null && !result.has(p.buildingId) &&
    w.buildings[p.buildingId] && buildingMapIntel(w.buildings[p.buildingId], gangId).siteKnown && selectableOrderPerson(w, gangId, type, p)) result.set(p.buildingId, p.id);
  return result;
}

export function blockOrderSites(w: WorldState, gangId: ID, card: Pick<JobCard, 'type' | 'opts'>, id: ID): ID[] {
  const block = w.blocks[w.blocks[id]?.layout?.mergedInto ?? id];
  return (block?.lotIds ?? []).map(l => w.buildings[w.lots[l].buildingId])
    .filter(b => b && selectableOrderSite(w, gangId, card, b)).map(b => b.id);
}

export function selectedOrderSites(w: WorldState, gangId: ID, card: JobCard): ID[] {
  return expandTargets(w, gangId, card.type, card.blockIds, card.buildingIds)
    .filter(id => w.buildings[id] && selectableOrderSite(w, gangId, card, w.buildings[id]));
}

export function addOrderBlocks(w: WorldState, gangId: ID, card: JobCard, ids: ID[]): Pick<JobCard, 'blockIds' | 'buildingIds'> {
  const blockIds = [...new Set([...card.blockIds, ...ids.map(id => w.blocks[id]?.layout?.mergedInto ?? id)
    .filter(id => blockOrderSites(w, gangId, card, id).length > 0)])];
  return { blockIds, buildingIds: card.buildingIds.filter(id => !blockIds.includes(w.buildings[id]?.blockId)) };
}

export function toggleOrderBlock(w: WorldState, gangId: ID, card: JobCard, id: ID): Pick<JobCard, 'blockIds' | 'buildingIds'> {
  return toggleOrderBlocks(w, gangId, card, [id]);
}

/** Manual p.8: bounding an already selected area again cancels that selection. */
export function toggleOrderBlocks(w: WorldState, gangId: ID, card: JobCard, ids: ID[]): Pick<JobCard, 'blockIds' | 'buildingIds'> {
  const blocks = new Set(ids.map(id => w.blocks[id]?.layout?.mergedInto ?? id)
    .filter(id => blockOrderSites(w, gangId, card, id).length > 0));
  const sites = new Set([...blocks].flatMap(id => blockOrderSites(w, gangId, card, id)));
  if (!sites.size) return card;
  const selected = new Set(selectedOrderSites(w, gangId, card));
  // A mixed bound fills the area; a fully selected bound clears it. Unrelated
  // selections stay intact, including individually chosen properties.
  if (![...sites].every(site => selected.has(site))) return addOrderBlocks(w, gangId, card, [...blocks]);
  return { blockIds: card.blockIds.filter(id => !blocks.has(w.blocks[id]?.layout?.mergedInto ?? id)),
    buildingIds: card.buildingIds.filter(site => !sites.has(site)) };
}

export function toggleOrderSite(w: WorldState, gangId: ID, card: JobCard, id: ID): Pick<JobCard, 'blockIds' | 'buildingIds'> {
  const b = w.buildings[id];
  if (!b || !selectableOrderSite(w, gangId, card, b)) return card;
  // Removing one site from a boxed block expands its remaining sites explicitly.
  const blockIds = card.blockIds.filter(block => block !== b.blockId);
  const sites = new Set(card.buildingIds);
  if (card.blockIds.includes(b.blockId)) for (const site of blockOrderSites(w, gangId, card, b.blockId)) sites.add(site);
  if (sites.has(id)) sites.delete(id); else sites.add(id);
  return { blockIds, buildingIds: [...sites] };
}
