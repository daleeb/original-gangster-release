import type { Building, ID, WorldState } from './types';
import { BUILDING_BY_ID } from './data/buildings';

/**
 * What a business pays a week for protection at the standard rate: two fifths
 * of what it takes (never less than $60, which is all a warehouse or other
 * place with no takings pays), so a racket no longer asks more than a shop
 * earns. The one rule for rackets a gang starts with and those it signs up later.
 */
export function protectionFee(b: Building): number {
  return Math.round(Math.max(60, (BUILDING_BY_ID[b.typeId]?.profit ?? 0) * 0.4));
}

/** Manual p.39 permits legal commercial, industrial and tenement premises.
 * A special service does not make an industrial business municipal; in
 * particular a union must be ownable to front Teamsters (p.58). */
export function purchasablePremisesType(b: Building): boolean {
  return ['empty', 'commercial', 'industrial', 'tenement'].includes(b.cls);
}

/** The lot in the middle of a block (world.ts CENTRE_LOT; kept here so this
 * module stays free of world.ts). */
const CENTRE = 4;

/** A legal business of this gang's standing on the same block as `b`. */
export function ownsBusinessOnBlock(w: WorldState, gangId: ID, b: Building): boolean {
  const block = w.blocks[b.blockId];
  return !!block && block.lotIds.some((lotId) => {
    const other = w.buildings[w.lots[lotId]?.buildingId];
    return !!other && other.id !== b.id && other.ownerGangId === gangId && other.state !== 'destroyed' &&
      other.cls !== 'empty' && other.cls !== 'illegal';
  });
}

/**
 * The building a lot belongs to as far as the player is concerned. In the
 * original city an apartment block is one tenement round the middle of its
 * block; here its terraces are separate plain-house lots with nothing of their
 * own to click on (no owner, nothing to extort or buy). They stand for the
 * block's tenement: a click on one is a click on it, and the plan marks them
 * with it. Row-house blocks with no tenement keep their houses as they are.
 */
export function siteBuilding(w: WorldState, b: Building): Building {
  if (b.cls !== 'residential') return b;
  const block = w.blocks[b.blockId];
  for (const lotId of block?.lotIds ?? []) {
    const other = w.buildings[w.lots[lotId]?.buildingId];
    if (other && other.cls === 'tenement' && other.state !== 'destroyed') return other;
  }
  return b;
}

/** As in the original, the land in the middle of a block is sold only to a
 * gang that already owns a business in front of it; every other lot is sold
 * to anybody. */
export function centreLotNeedsFront(w: WorldState, gangId: ID, b: Building): boolean {
  return w.lots[b.lotId]?.index === CENTRE && !ownsBusinessOnBlock(w, gangId, b);
}
