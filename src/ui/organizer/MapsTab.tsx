import { useState } from 'react';
import { useGame } from '../../app/store';
import type { OverlayKind } from '../../render/scene';
import { BUILDING_BY_ID } from '../../sim/data/buildings';
import { allBuildings, buildingName, money, ownedBuildings, protectedBuildings } from '../../sim/world';
import { Empty, Hint, Panel, Pill } from '../common';
import { LieutenantAreaControls } from './LieutenantAreaControls';

const OVERLAYS: { id: OverlayKind; label: string; help: string }[] = [
  { id: 'territory', label: 'Territory', help: 'Territory discovered by your gang.' },
  { id: 'lieutenant', label: "Lieutenant's Area", help: 'Allocate your territory. Selected crew: white; other crews: gang color.' },
  { id: 'landValue', label: 'Land Value', help: 'What the ground is worth. Violence drives it down.' },
  { id: 'security', label: 'Security', help: 'Where the police are thickest.' },
  { id: 'hostility', label: 'Hostility', help: 'How the people on each block feel about you.' },
  { id: 'crime', label: 'Crime Hot Spots', help: 'Where the violence has been.' },
  { id: 'events', label: 'Recent Events', help: 'Crimes reported this week and last.' },
];

export function MapsTab() {
  const sim = useGame((s) => s.sim)!;
  const overlays = useGame((s) => s.overlays);
  const toggleOverlay = useGame((s) => s.toggleOverlay);
  const setOverlays = useGame((s) => s.setOverlays);
  const selectBuilding = useGame((s) => s.selectBuilding);
  const requestCamera = useGame((s) => s.requestCamera);
  useGame((s) => s.version);

  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'all' | 'owned' | 'protected'>('all');

  const w = sim.world;
  const gang = sim.playerGang;

  const owned = ownedBuildings(w, gang.id);
  const prot = protectedBuildings(w, gang.id);
  // A site you extorted and later bought is in both lists; show it once.
  const list =
    mode === 'owned'
      ? owned
      : mode === 'protected'
        ? prot
        : [...new Map([...owned, ...prot].map((b) => [b.id, b])).values()];

  const grouped = new Map<string, typeof list>();
  for (const b of list) {
    const name = buildingName(w, b.id);
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
    const arr = grouped.get(name) ?? [];
    arr.push(b);
    grouped.set(name, arr);
  }

  const knownTypes = new Map<string, number>();
  for (const b of allBuildings(w)) {
    if ((b.knowledge[gang.id] ?? 0) < 1 && b.ownerGangId !== gang.id && b.protection?.gangId !== gang.id) continue;
    const name = BUILDING_BY_ID[b.typeId]?.name ?? b.typeId;
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
    knownTypes.set(name, (knownTypes.get(name) ?? 0) + 1);
  }

  return (
    <div>
      <Panel title="Overlays" right={<button className="btn sm" onClick={() => setOverlays([])}>Clear</button>}>
        <div className="row wrap" style={{ gap: 4 }}>
          {OVERLAYS.map((o) => (
            <button
              key={o.id}
              aria-pressed={overlays.includes(o.id)} className={`btn sm${overlays.includes(o.id) ? ' on' : ''}`}
              title={o.help}
              onClick={() => toggleOverlay(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="row wrap"><LieutenantAreaControls /></div>
        <Hint>
          Drag with the right mouse button to move around, and use the wheel to zoom from the city
          plan down to the street.
        </Hint>
        <button
          className="btn block"
          onClick={() => {
            const hq = allBuildings(w).find((b) => b.ownerGangId === gang.id && b.isHQ);
            if (hq) requestCamera({ x: w.lots[hq.lotId].center.x, y: w.lots[hq.lotId].center.y });
          }}
        >
          Centre on Headquarters
        </button>
      </Panel>

      <Panel title="Controlled Businesses">
        <div className="row wrap" style={{ gap: 4, marginBottom: 7 }}>
          {(['all', 'owned', 'protected'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} className={`btn sm${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
          <input
            className="text-input"
            style={{ flex: 1, minWidth: 120, padding: '4px 8px', background: '#fffdf5', color: 'var(--ink)' }}
            placeholder="Search…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {grouped.size === 0 ? (
          <Empty>Nothing here yet.</Empty>
        ) : (
          <div className="scroll-list">
            {[...grouped.entries()].map(([name, items]) => (
              <div key={name} style={{ marginBottom: 6 }}>
                <div className="row between">
                  <b className="tiny">{name}</b>
                  <span className="muted tiny">{items.length}</span>
                </div>
                {items.slice(0, 8).map((b) => (
                  <button
                    key={b.id}
                    className="list-row"
                    onClick={() => {
                      selectBuilding(b.id);
                      requestCamera({ x: w.lots[b.lotId].center.x, y: w.lots[b.lotId].center.y });
                    }}
                  >
                    <span className="name tiny">
                      Block {w.blocks[b.blockId].gx},{w.blocks[b.blockId].gy}
                    </span>
                    {b.ownerGangId === gang.id ? <Pill kind="good">owned</Pill> : <Pill>paying</Pill>}
                    <span className="muted tiny mono">
                      {b.ownerGangId === gang.id ? money(b.lastProfit) : money(b.protection?.weekly ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Building Types Known">
        {knownTypes.size === 0 ? (
          <Empty>Explore the city to learn what is where.</Empty>
        ) : (
          <div className="scroll-list" style={{ maxHeight: 200 }}>
            {[...knownTypes.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([name, n]) => (
                <div key={name} className="row between tiny" style={{ padding: '2px 0' }}>
                  <span>{name}</span>
                  <span className="muted">{n}</span>
                </div>
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
