import { useState } from 'react';
import { useGame } from '../app/store';
import { buildingName, dist } from '../sim/world';
import { nearestOffice } from '../sim/execution';
import { CELL } from '../sim/constants';
import { buildingMapIntel } from '../sim/mapIntel';
import { Modal } from './common';
import { handleMapHit } from './mapClick';
import { ORDERS } from '../sim/constants';
import { activeBlocks, cityBlockAt } from '../sim/cityLayout';
import { blockOrderSites, orderPersonAtSite, selectableOrderPerson, selectableOrderSite, selectedOrderSites } from '../app/orderSelection';
import type { PickResult } from '../render/scene';
import { specialistPeopleBySite } from '../app/specialistSelection';
import { specialistTargetEligible } from '../sim/specialistJobs';
import { lieutenantAreaChoices } from '../sim/lieutenantAreas';

import { peopleList, buildingList } from '../sim/entityLists';
/** Keyboard alternative to canvas picking, using the same action handler. */
export function MapAccess({ className = 'btn sm', label = 'Choose on map' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return <><button className={className} onClick={() => setOpen(true)}>{label}</button>{open && <MapChooser onClose={() => setOpen(false)} />}</>;
}
function MapChooser({ onClose }: { onClose: () => void }) {
  const sim = useGame(s => s.sim)!;
  const mode = useGame(s => s.pickMode);
  const card = useGame(s => s.jobCard);
  const staff = useGame(s => s.specialistCard);
  const policeBlocks = useGame(s => s.policeAreaBlockIds);
  useGame(s => s.version);
  const [query, setQuery] = useState('');
  const streetPeople = mode?.kind === 'streetOrder' && mode.orderType !== 'goTo';
  const areaMode = mode?.kind === 'policeArea' || mode?.kind === 'lieutenantArea';
  const [kind, setKind] = useState<'buildings' | 'people' | 'blocks'>(areaMode ? 'blocks' : staff || streetPeople || card && ORDERS[card.type].target === 'person' ? 'people' : 'buildings');
  const [x, setX] = useState(0), [y, setY] = useState(0);
  const w = sim.world, gang = sim.playerGang;
  const lieutenant = mode?.kind === 'lieutenantArea' ? lieutenantAreaChoices(w, gang.id, mode.teamId) : null;
  const picking = mode?.kind === 'order' && card != null;
  const selected = new Set(card ? selectedOrderSites(w, gang.id, card) : []);
  const staffSites = staff ? specialistPeopleBySite(w, gang.id, staff.type) : new Map<number, number>();
  // An area order takes as many places as you like: the list stays open while they are ticked.
  const several = picking && ORDERS[card.type].target === 'area';
  const select = (hit: PickResult, site = false) => {
    handleMapHit(hit, { site });
    if (!(mode?.kind === 'lieutenantArea' || mode?.kind === 'policeArea' || mode?.kind === 'order' && kind === 'blocks' || several && kind === 'buildings')) onClose();
  };
  // How far each place is from the headquarters, nearest first.
  const office = nearestOffice(w, gang.id, w.blocks[0].center);
  const hq = office ? w.lots[office.lotId].center : null;
  const away = (p: { x: number; y: number }) => (hq ? dist(hq, p) : 0);
  const far = (p: { x: number; y: number }) => (hq ? ` · ${(away(p) / CELL).toFixed(1)} blocks from HQ` : '');
  const people = peopleList(w).filter(p => staff ? specialistTargetEligible(w, gang.id, staff.type, p) : picking ? selectableOrderPerson(w, gang.id, card.type, p)
    : (p.gangId === gang.id || p.gangId == null || gang.knownPeople.includes(p.id)) &&
      (!streetPeople || !['dead', 'jailed', 'kidnapped'].includes(p.status) && !mode.personIds.includes(p.id)));
  const needle = query.toLowerCase();
  const rows = kind === 'people'
    ? people.map(p => ({ id: p.id, label: p.name, hit: { personId: p.id, buildingId: null, blockId: null, point: p.pos } }))
    : kind === 'blocks'
      ? activeBlocks(w).filter(b => (!lieutenant || lieutenant.available.has(b.id)) && (!picking || ORDERS[card.type].target === 'point' || blockOrderSites(w, gang.id, card, b.id).length > 0))
        .map(b => ({ id: b.id, label: `Block ${b.gx},${b.gy}`, hit: { personId: null, buildingId: null, blockId: b.id, point: b.center } }))
      : buildingList(w).filter(b => (!staff || staffSites.has(b.id)) && buildingMapIntel(b, gang.id).siteKnown && (!picking || ORDERS[card.type].target === 'point' ||
        (ORDERS[card.type].target === 'person' ? orderPersonAtSite(w, gang.id, card.type, b) != null : selectableOrderSite(w, gang.id, card, b))))
        .sort((a, b) => away(w.lots[a.lotId].center) - away(w.lots[b.lotId].center))
        .map(b => ({ id: b.id, label: `${buildingName(w, b.id)} · block ${w.blocks[b.blockId].gx},${w.blocks[b.blockId].gy} · site ${w.lots[b.lotId].index + 1}${far(w.lots[b.lotId].center)}`,
        hit: { personId: null, buildingId: b.id, blockId: b.blockId, point: w.lots[b.lotId].center } }));
  const filtered = rows.filter(r => r.label.toLowerCase().includes(needle));
  const block = cityBlockAt(w, x, y);
  const blockAvailable = block && (!lieutenant || lieutenant.available.has(block.id)) && (!picking || ORDERS[card.type].target === 'point' || blockOrderSites(w, gang.id, card, block.id).length > 0);
  return <Modal title="Choose on map" onClose={onClose}>
      <p>{lieutenant ? 'Choose your territory to allocate it, or select an assigned block again to remove it. Another lieutenant must release their area before you can take it.'
        : several ? 'Type a name (pool hall, cafe…) and tick every place you want: the list stays open, nearest your headquarters first. Click a ticked place again to drop it, then close.'
        : 'Select a person, site or block to perform the current map action. Area selections can include several blocks.'}</p>
      <label>Find <input className="text-input" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="row wrap">{(['buildings', 'people', 'blocks'] as const).filter(k => areaMode ? k === 'blocks' : !staff || k !== 'blocks').map(k => <button className="btn" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
      {(!staff || mode?.kind === 'policeArea') && <div className="row wrap">
        <label>Block column <input type="number" min={0} max={w.gridW - 1} value={x} onChange={e => setX(Number(e.target.value))} /></label>
        <label>Block row <input type="number" min={0} max={w.gridH - 1} value={y} onChange={e => setY(Number(e.target.value))} /></label>
        <button className="btn" disabled={!blockAvailable} onClick={() => block && select({ buildingId: null, personId: null, blockId: block.id, point: block.center })}>Choose block centre</button>
      </div>}
      <p role="status">{filtered.length} matches{filtered.length > 50 ? ' · first 50 shown; refine your search' : ''}</p>
      <div className="scroll-list">{filtered.slice(0, 50).map(r => <button className="list-row" key={r.id}
        aria-pressed={kind === 'blocks' ? lieutenant ? lieutenant.selected.has(r.id) : mode?.kind === 'policeArea' ? policeBlocks.includes(r.id) : !!card?.blockIds.includes(r.id) : kind === 'buildings' ? selected.has(r.id) : (staff ?? card)?.personId === r.id}
        onClick={() => select(r.hit, kind === 'buildings')}>{several && kind === 'buildings' ? (selected.has(r.id) ? '☑ ' : '☐ ') : ''}{r.label}</button>)}</div>
      {several && kind === 'buildings' && <p role="status" className="muted">{selected.size} place{selected.size === 1 ? '' : 's'} chosen for this order.</p>}
    </Modal>;
}
