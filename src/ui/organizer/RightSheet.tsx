import { useEffect, useRef, useState } from 'react';
import { act, useGame } from '../../app/store';
import {
  buyVehicle,
  buyWeapon,
  hireRecruit,
  killMember,
  moveToPool,
  moveToTeam,
  promote,
  sackPerson,
  sellVehicle,
  sellWeapon,
  setPay,
  transferVehicle,
  transferWeapon,
} from '../../sim/api';
import { ORDERS, ORDER_GROUPS, VEHICLES, VEHICLE_ORDER, WEAPONS, WEAPON_ORDER, type OrderDef } from '../../sim/constants';
import type { ID, OrderType, Person, VehicleId, WeaponId } from '../../sim/types';
import { buildingName, money } from '../../sim/world';
import { ConfirmDialog, Empty, Hint, Icon, Kicker, Rivets, SkillList, Stamp, Stars } from '../common';

/** Roles that have an engraved glyph of their own. */
const ROLE_ICON = new Set(['police', 'policeChief', 'fbi', 'fbiHead', 'judge', 'da', 'mayor', 'reporter', 'clergy', 'snitch', 'accountant', 'lawyer', 'citizen']);
import { Portrait } from '../Portrait';
import { handleMapHit } from '../mapClick';
import { selectableOrderPerson, selectableOrderSite, selectedOrderSites } from '../../app/orderSelection';
import { resourceDragProps, useResourceDrop } from '../resourceDrag';

import { buildingList } from '../../sim/entityLists';
export function hours(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = minutes / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
}

/** What an order promises in time: per site, or the whole week. */
export function orderCost(def: OrderDef): string {
  if (def.wholeWeek) return 'all week';
  const per = def.target === 'area' || def.target === 'building' ? ' / site' : '';
  let s = `~${hours(def.minutesPerTarget)}${per}`;
  if (def.supportsRepeat) s += ' · repeats';
  return s;
}

export const ABSENT: Record<string, string> = {
  arrested: 'Arrested',
  onTrial: 'On trial',
  jailed: 'In prison',
  kidnapped: 'Kidnapped',
  dead: 'Dead',
};

/**
 * The original's money roll: how much this person is paid, how much you have,
 * and buttons to turn it either way.
 */
export function PayRoll({ person, onClose }: { person: Person; onClose?: () => void }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  useGame((s) => s.version);
  const step = Math.max(5, Math.round(person.payDemand * 0.08));
  return (
    <div className="pay-roll">
      <div style={{ flex: 1 }}>
        Paying <b>{money(person.pay)}</b> a week
        <div className="tiny muted">
          wants {money(person.payDemand)} · {money(sim.playerGang.cash)} in the safe
        </div>
      </div>
      <button className="btn sm" title="Decrease pay — they will not thank you" onClick={() => notify(act((s) => setPay(s.world, person.id, person.pay - step))!)}>
        −
      </button>
      <button className="btn sm" title="Increase pay" onClick={() => notify(act((s) => setPay(s.world, person.id, person.pay + step))!)}>
        +
      </button>
      {person.pay < person.payDemand && (
        <button className="btn sm brass" onClick={() => notify(act((s) => setPay(s.world, person.id, person.payDemand))!)}>
          Meet
        </button>
      )}
      {onClose && (
        <button className="btn sm quiet" onClick={onClose}>
          Done
        </button>
      )}
    </div>
  );
}

/**
 * The original's Right Panel: whatever the page needs beside it — the orders
 * of one group, the hoods' pool, the black market, the motor cars, the people
 * willing to work, one hood's skills, or the clipboard.
 */
export function RightSheet() {
  const sim = useGame((s) => s.sim)!;
  const sheet = useGame((s) => s.sheet);
  const setSheet = useGame((s) => s.setSheet);
  const jobCard = useGame((s) => s.jobCard);
  const selectedTeamId = useGame((s) => s.selectedTeamId);
  useGame((s) => s.version);

  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [sheet]);
  if (!sheet) return null;
  const w = sim.world;
  const gang = sim.playerGang;
  const team = (selectedTeamId != null ? w.teams[selectedTeamId] : undefined) ?? w.teams[gang.teamIds[0]];

  let title = '';
  let kicker = 'Right panel';
  let body: React.ReactNode = null;

  switch (sheet.kind) {
    case 'orders': {
      const group = ORDER_GROUPS.find((g) => g.id === sheet.group);
      title = group?.name ?? 'Orders';
      kicker = team ? `Orders for ${w.people[team.lieutenantId]?.name ?? team.name}` : 'Orders';
      body = <OrderListSheet group={sheet.group} teamId={team?.id ?? null} />;
      break;
    }
    case 'hoods':
      title = 'The Pool';
      kicker = 'Resource details · hoods';
      body = <PoolSheet teamId={team?.id} />;
      break;
    case 'weapons':
      title = 'Weapons';
      kicker = 'Resource details · black market';
      body = team ? <WeaponsSheet teamId={team.id} /> : <Empty>Promote a lieutenant first.</Empty>;
      break;
    case 'vehicles':
      title = 'Motor Cars';
      kicker = 'Resource details · vehicles';
      body = team ? <VehiclesSheet teamId={team.id} /> : <Empty>Promote a lieutenant first.</Empty>;
      break;
    case 'recruits':
      title = 'Recruitment';
      kicker = 'Character selection · willing to work';
      body = <RecruitsSheet teamId={team?.id ?? null} />;
      break;
    case 'person': {
      const p = w.people[sheet.id];
      if (!p) return null;
      title = p.name;
      kicker = 'Skill panel';
      body = <PersonSheet person={p} teamId={team?.id} />;
      break;
    }
    case 'clipboard':
      title = 'Clipboard';
      kicker = jobCard ? 'Pick a target for the job card' : 'People and places you know';
      body = <ClipboardSheet />;
      break;
  }

  return (
    <div ref={panel} role="region" aria-label={title} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setSheet(null); } }} className="brass right-sheet">
      <div className="paper">
        <Rivets />
        <div className="brass-face rs-head">
          <div>
            <Kicker className="dark">{kicker}</Kicker>
            <h4>{title}</h4>
          </div>
          <button className="sheet-close" onClick={() => setSheet(null)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="rs-body">{body}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sheets

function OrderListSheet({ group, teamId }: { group: OrderDef['group']; teamId: ID | null }) {
  const beginOrder = useGame((s) => s.beginOrder);
  const notify = useGame((s) => s.notify);
  const list = Object.values(ORDERS).filter((o) => o.group === group);
  return (
    <>
      {list.map((o) => (
        <button
          key={o.type}
          className="order-row"
          onClick={() => {
            if (teamId == null) {
              notify('Promote a lieutenant before giving orders.');
              return;
            }
            beginOrder(o.type as OrderType, teamId);
          }}
        >
          <span className={`order-ico tone-${o.group}`}>
            <Icon name={`orders/${o.type}`} size={26} />
          </span>
          <span className="order-text">
            <b>{o.name}</b>
            <span className="cost">{orderCost(o)}</span>
            <span className="desc">{o.desc}</span>
          </span>
        </button>
      ))}
    </>
  );
}

function PoolSheet({ teamId }: { teamId?: ID }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const setSheet = useGame((s) => s.setSheet);
  const [sortBy, setSortBy] = useState<keyof Person['skills']>('intelligence');
  const [dropProps, dropOver] = useResourceDrop({ kind: 'pool' });
  const w = sim.world;
  const gang = sim.playerGang;
  const pool = gang.poolIds
    .map((id) => w.people[id])
    .filter(Boolean)
    .sort((a, b) => b.skills[sortBy] - a.skills[sortBy]);

  return (
    <div {...dropProps} className={`resource-drop${dropOver ? ' drop-over' : ''}`} aria-label="The pool: drag a crew member here to stand him down">
      <div className="row wrap tiny" style={{ gap: 3, marginBottom: 8 }}>
        <span className="muted">Sort:</span>
        {(['intelligence', 'organization', 'business', 'firearms', 'intimidation', 'stealth'] as const).map((k) => (
          <button key={k} aria-pressed={sortBy === k} className={`btn sm${sortBy === k ? ' on' : ''}`} onClick={() => setSortBy(k)}>
            {k.slice(0, 5)}
          </button>
        ))}
      </div>
      {pool.length === 0 ? (
        <Empty>Nobody is sitting idle.</Empty>
      ) : (
        pool.map((p) => (
          <div key={p.id} className="person-row" {...resourceDragProps({ kind: 'hood', id: p.id })} title="Drag onto a lieutenant to give him this hood">
            <div className="avatar">
              <Portrait person={p} gang={gang} size={34} />
            </div>
            <button className="name" style={{ textAlign: 'left' }} onClick={() => setSheet({ kind: 'person', id: p.id })}>
              {p.name}
            </button>
            <Stars value={p.skills[sortBy]} />
            {teamId != null && (
              <button className="btn sm" onClick={() => notify(act((s) => moveToTeam(s.world, gang.id, p.id, teamId))!)}>
                → Team
              </button>
            )}
            {/* Reachable even with no crews at all — otherwise losing your
                last lieutenant would leave the game unwinnable. */}
            <button className="btn sm" title="Make this hood a lieutenant with a team of his own" onClick={() => notify(act((s) => promote(s.world, gang.id, p.id))!)}>
              Promote
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function WeaponsSheet({ teamId }: { teamId: ID }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const gang = sim.playerGang;
  const team = sim.world.teams[teamId];
  const [offer,setOffer]=useState<{kind:WeaponId;action:'buy'|'sell';fromTeam:boolean}|null>(null);
  useEffect(()=>setOffer(null),[teamId,sim]);
  if (!team) return null;
  return (
    <>
      <Hint>
        Each active hood carries one firearm from this crew’s stock. Priority jobs and working hoods
        get first choice, then the best shots. Spare guns stay with the crew; the cache equips unassigned
        gang members. Hoods without a gun must close in to fight. Explosives are only for bombing jobs.
      </Hint>
      {WEAPON_ORDER.map((id: WeaponId) => (
        <div key={id} style={{ padding: '7px 0', borderBottom: '1px dotted var(--dots)' }}
          {...(gang.weapons[id] ? { ...resourceDragProps({ kind: 'weapon', id }), title: 'Drag onto a lieutenant to hand one over from the cache' } : {})}>
          <div className="row between">
            <b style={{ fontWeight: 500 }}>
              <Icon name={`weapons/${id}`} size={18} /> {WEAPONS[id].name}
            </b>
            <span className="mono">{money(WEAPONS[id].cost)}</span>
          </div>
          <div className="muted" style={{ margin: '2px 0 5px' }}>
            {WEAPONS[id].desc}
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            <span className="tiny muted">
              cache {gang.weapons[id] ?? 0} · team {team.weapons[id] ?? 0}
            </span>
            <button className="btn sm" onClick={() => setOffer({kind:id,action:'buy',fromTeam:true})}>
              Buy
            </button>
            <button className="btn sm" disabled={!team.weapons[id]} onClick={() => setOffer({kind:id,action:'sell',fromTeam:true})}>
              Sell from team
            </button>
            <button className="btn sm" disabled={!gang.weapons[id]} onClick={() => setOffer({kind:id,action:'sell',fromTeam:false})}>
              Sell from cache
            </button>
            <button className="btn sm" onClick={() => notify(act((s) => transferWeapon(s.world, gang.id, id, teamId, true))!)}>
              → Team
            </button>
            <button className="btn sm" onClick={() => notify(act((s) => transferWeapon(s.world, gang.id, id, teamId, false))!)}>
              → Cache
            </button>
          </div>
        </div>
      ))}
      {offer&&<ConfirmDialog text={offer.action==='buy'?
        `Buy ${WEAPONS[offer.kind].name} for ${money(WEAPONS[offer.kind].cost)} and give it to ${team.name}? Cash in the safe: ${money(gang.cash)}.`:
        `Sell ${WEAPONS[offer.kind].name} from ${offer.fromTeam?team.name:'the cache'} for ${money(Math.round(WEAPONS[offer.kind].cost*.5))}?`}
        onNo={()=>setOffer(null)} onYes={()=>{
          const result=act(s=>offer.action==='buy'?buyWeapon(s.world,gang.id,offer.kind,teamId):sellWeapon(s.world,gang.id,offer.kind,offer.fromTeam?teamId:undefined));
          if(result){notify(result);setOffer(null);}
        }}/>}
    </>
  );
}

function VehiclesSheet({ teamId }: { teamId: ID }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const gang = sim.playerGang;
  const team = sim.world.teams[teamId];
  const [offer,setOffer]=useState<{kind:VehicleId;action:'buy'|'sell';fromTeam:boolean}|null>(null);
  useEffect(()=>setOffer(null),[teamId,sim]);
  if (!team) return null;
  return (
    <>
      {VEHICLE_ORDER.map((id: VehicleId) => (
        <div key={id} style={{ padding: '7px 0', borderBottom: '1px dotted var(--dots)' }}
          {...(gang.vehicles[id] ? { ...resourceDragProps({ kind: 'vehicle', id }), title: 'Drag onto a lieutenant to hand one over from the cache' } : {})}>
          <div className="row between">
            <b style={{ fontWeight: 500 }}>
              <Icon name={`vehicles/${id}`} size={18} /> {VEHICLES[id].name}
            </b>
            <span className="mono">{money(VEHICLES[id].cost)}</span>
          </div>
          <div className="muted" style={{ margin: '2px 0 5px' }}>
            {VEHICLES[id].desc}
            <div className="tiny">Seats {VEHICLES[id].capacity} · cargo {VEHICLES[id].cargo} cases</div>
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            <span className="tiny muted">
              cache {gang.vehicles[id] ?? 0} · team {team.vehicles[id] ?? 0}
            </span>
            <button className="btn sm" title="Purchase for this crew" onClick={() => setOffer({kind:id,action:'buy',fromTeam:true})}>
              Buy
            </button>
            <button className="btn sm" disabled={!team.vehicles[id]} onClick={() => setOffer({kind:id,action:'sell',fromTeam:true})}>
              Sell from team
            </button>
            <button className="btn sm" disabled={!gang.vehicles[id]} onClick={() => setOffer({kind:id,action:'sell',fromTeam:false})}>
              Sell from cache
            </button>
            <button className="btn sm" onClick={() => notify(act((s) => transferVehicle(s.world, gang.id, id, teamId, true))!)}>
              → Team
            </button>
            <button className="btn sm" onClick={() => notify(act((s) => transferVehicle(s.world, gang.id, id, teamId, false))!)}>
              → Cache
            </button>
          </div>
        </div>
      ))}
      {offer&&<ConfirmDialog text={offer.action==='buy'?
        `Buy a ${VEHICLES[offer.kind].name} for ${money(VEHICLES[offer.kind].cost)} and give it to ${team.name}? Cash in the safe: ${money(gang.cash)}.`:
        `Sell a ${VEHICLES[offer.kind].name} from ${offer.fromTeam?team.name:'the cache'} for ${money(Math.round(VEHICLES[offer.kind].cost*.5))}?`}
        onNo={()=>setOffer(null)} onYes={()=>{
          const result=act(s=>offer.action==='buy'?buyVehicle(s.world,gang.id,offer.kind,teamId):sellVehicle(s.world,gang.id,offer.kind,offer.fromTeam?teamId:undefined));
          if(result){notify(result);setOffer(null);}
        }}/>}
    </>
  );
}

function RecruitsSheet({ teamId }: { teamId: ID | null }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const w = sim.world;
  const gang = sim.playerGang;
  const recruits = gang.recruitIds.map((id) => w.people[id]).filter(Boolean);
  return (
    <>
      {recruits.length === 0 ? (
        <Empty>
          Nobody is offering their services. Send a hood to Recruit at a gym, pool hall, the docks or the labour
          exchange.
        </Empty>
      ) : (
        recruits.map((p) => (
          <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px dotted var(--dots)' }}>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div className="avatar">
                <Portrait person={p} size={64} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="row between">
                  <b style={{ fontWeight: 500, fontSize: 15 }}>{p.name}</b>
                  <span className="muted">
                    {p.role} · wants {money(p.payDemand)}/week
                  </span>
                </div>
                <div style={{ margin: '5px 0' }}>
                  <SkillList skills={p.skills} columns={2} />
                </div>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {teamId != null && (
                <button className="btn sm brass" onClick={() => notify(act((s) => hireRecruit(s.world, gang.id, p.id, 'team', teamId))!)}>
                  Hire to team
                </button>
              )}
              <button className="btn sm" onClick={() => notify(act((s) => hireRecruit(s.world, gang.id, p.id, 'pool'))!)}>
                Hire to pool
              </button>
              {p.role === 'hood' && (
                <button className="btn sm" onClick={() => notify(act((s) => hireRecruit(s.world, gang.id, p.id, 'lieutenant'))!)}>
                  As lieutenant (+$50)
                </button>
              )}
            </div>
          </div>
        ))
      )}
      {gang.recruitIds.length > 0 && <div className="muted" style={{ marginTop: 6 }}>Hiring an accountant or lawyer replaces the one you already have.</div>}
      <div className="muted" style={{ marginTop: 8 }}>
        Managers currently running your businesses:{' '}
        {Object.values(w.buildings)
          .filter((b) => b.ownerGangId === gang.id && b.managerId != null)
          .map((b) => `${w.people[b.managerId!]?.name} (${buildingName(w, b.id)})`)
          .join(', ') || 'none'}
      </div>
    </>
  );
}

/** The original showed a hood's face and full details when his name was clicked. */
function PersonSheet({ person, teamId }: { person: Person; teamId?: ID }) {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const setSheet = useGame((s) => s.setSheet);
  const [payOpen, setPayOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; go: () => void } | null>(null);
  const gang = sim.playerGang;
  const absent = ABSENT[person.status];

  return (
    <>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start', position: 'relative' }}>
        {person.wanted >= 50 && <Stamp kind="wanted" />}
        <div className="avatar">
          <Portrait person={person} gang={person.gangId === gang.id ? gang : undefined} size={96} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Kicker>
            {ROLE_ICON.has(person.role) && <Icon name={`roles/${person.role}`} size={12} />} {person.role} ·{' '}
            {absent ? (
              <>
                <Icon name={`status/${person.status}`} size={12} /> {absent}
              </>
            ) : (
              'active'
            )}
          </Kicker>
          <div className="row between" style={{ marginTop: 6 }}>
            <span className={`tag ${person.loyalty > 60 ? 'good' : person.loyalty > 30 ? 'warn' : 'bad'}`}>Loyalty {Math.round(person.loyalty)}</span>
            <span className="tag">Wanted {Math.round(person.wanted)}</span>
          </div>
          <div className={`pay-lines${person.pay < person.payDemand ? ' unhappy' : ''}`} style={{ textAlign: 'left', marginTop: 8 }}>
            <Kicker>Wants {money(person.payDemand)}</Kicker>
            <b>Pay {money(person.pay)}</b>
          </div>
        </div>
      </div>
      {absent && (
        <Hint>
          {person.status === 'kidnapped'
            ? 'Held tied to a chair somewhere in the city. He will be back when they let him go — or when you get him out.'
            : person.status === 'arrested' || person.status === 'onTrial'
              ? 'Behind bars, awaiting trial. A lawyer improves his chances.'
              : `${absent}.`}
        </Hint>
      )}
      <div style={{ margin: '12px 0' }}>
        <SkillList skills={person.skills} columns={2} />
      </div>
      {payOpen && <PayRoll person={person} onClose={() => setPayOpen(false)} />}
      <div className="team-buttons">
        {person.role === 'hood' && person.gangId === gang.id && person.teamId != null && (
          <button className="btn" onClick={() => notify(act((s) => moveToPool(s.world, gang.id, person.id))!)}>
            Send to pool
          </button>
        )}
        {gang.poolIds.includes(person.id) && teamId != null && person.gangId === gang.id && (
          <button className="btn" onClick={() => notify(act((s) => moveToTeam(s.world, gang.id, person.id, teamId))!)}>
            Send to team
          </button>
        )}
        <button className="btn" onClick={() => setConfirm({ text: `Sack ${person.name}? He goes back on the street, and he will not forget it.`, go: () => notify(act((s) => sackPerson(s.world, gang.id, person.id))!) })}>
          Sack
        </button>
        <button className="btn danger" onClick={() => setConfirm({ text: `Have ${person.name} killed? The police will not investigate, but the rest of the gang will notice.`, go: () => notify(act((s) => killMember(s.world, gang.id, person.id))!) })}>
          Kill
        </button>
        {person.role === 'hood' && person.gangId === gang.id && (person.teamId != null || gang.poolIds.includes(person.id)) && <button
          className="btn"
          title="Make this hood a lieutenant, if one of the eight tabs is free"
          onClick={() => {
            notify(act((s) => promote(s.world, gang.id, person.id))!);
            setSheet(null);
          }}
        >
          Promote
        </button>}
        <button className={`btn${payOpen ? ' on' : ''}`} onClick={() => setPayOpen(!payOpen)}>
          Pay
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          text={confirm.text}
          onYes={() => {
            confirm.go();
            setConfirm(null);
            setSheet(null);
          }}
          onNo={() => setConfirm(null)}
        />
      )}
    </>
  );
}

/**
 * The clipboard: everybody and everywhere you know of, to pick a job card's
 * target from without hunting for it on the map.
 */
function ClipboardSheet() {
  const sim = useGame((s) => s.sim)!;
  const jobCard = useGame((s) => s.jobCard);
  const requestCamera = useGame((s) => s.requestCamera);
  const centreOnPerson = useGame((s) => s.centreOnPerson);
  const notify = useGame((s) => s.notify);
  const w = sim.world;
  const gang = sim.playerGang;
  const def = jobCard ? ORDERS[jobCard.type] : null;
  const selected = new Set(jobCard ? selectedOrderSites(w, gang.id, jobCard) : []);
  const eligiblePerson = (p: Person) => !jobCard || def?.target !== 'person' || selectableOrderPerson(w, gang.id, jobCard.type, p);

  const people = gang.knownPeople
    .map((id) => w.people[id])
    .filter((p) => p && p.status !== 'dead' && p.gangId != null && p.gangId !== gang.id && eligiblePerson(p))
    .slice(0, 30);
  const OFFICIAL_ROLES = ['mayor', 'policeChief', 'judge', 'da', 'fbiHead', 'reporter', 'clergy', 'police'];
  const officials = Object.values(w.people)
    .filter((p) => p.status !== 'dead' && OFFICIAL_ROLES.includes(p.role) && eligiblePerson(p))
    .sort((a, b) => OFFICIAL_ROLES.indexOf(a.role) - OFFICIAL_ROLES.indexOf(b.role))
    .slice(0, 40);
  const ROLE_LABEL: Record<string, string> = {
    mayor: 'Mayor',
    policeChief: 'Chief of Police',
    judge: 'Judge',
    da: 'District Attorney',
    fbiHead: 'Bureau chief',
    reporter: 'Reporter',
    clergy: 'Clergy',
    police: 'Officer',
  };
  const sites = buildingList(w).filter((b) => (b.ownerGangId === gang.id || b.protection?.gangId === gang.id) &&
    (!jobCard || def?.target !== 'building' && def?.target !== 'area' || selectableOrderSite(w, gang.id, jobCard, b)));

  const pickPerson = (id: ID) => {
    const p = w.people[id];
    if (def?.target === 'person') {
      handleMapHit({ personId: id, buildingId: null, blockId: null, point: p.pos });
      notify(`${p.name} is the target.`);
    } else if (p) centreOnPerson(id);
  };
  const pickSite = (id: ID) => {
    const b = w.buildings[id];
    if (def?.target === 'building') {
      handleMapHit({ personId: null, buildingId: id, blockId: b.blockId, point: w.lots[b.lotId].center }, { site: true });
      notify(`${buildingName(w, id)} is the target.`);
    } else if (def?.target === 'area') {
      handleMapHit({ personId: null, buildingId: id, blockId: b.blockId, point: w.lots[b.lotId].center }, { site: true });
    } else if (b) {
      const lot = w.lots[b.lotId];
      requestCamera({ x: lot.center.x, y: lot.center.y });
    }
  };

  return (
    <>
      <Kicker style={{ marginBottom: 6 }}>People you know · {people.length}</Kicker>
      {people.length === 0 ? (
        <Empty>You know nothing of your rivals' people. Explore, or buy from a snitch.</Empty>
      ) : (
        people.map((p) => (
          <button key={p.id} className={`list-row${jobCard?.personId === p.id ? ' on' : ''}`} onClick={() => pickPerson(p.id)}>
            <span className="name">{p.name}</span>
            <span className="muted">
              {w.gangs[p.gangId!]?.name} · {p.role}
            </span>
          </button>
        ))
      )}
      <Kicker style={{ margin: '14px 0 6px' }}>Officials · {officials.length}</Kicker>
      {officials.map((p) => (
        <button key={p.id} className={`list-row${jobCard?.personId === p.id ? ' on' : ''}`} onClick={() => pickPerson(p.id)}>
          <span className="name">
            <Icon name={`roles/${p.role}`} size={13} /> {p.name}
          </span>
          <span className="muted">
            {ROLE_LABEL[p.role] ?? p.role}
            {p.bribedBy === gang.id ? ' · on your payroll' : ''}
          </span>
        </button>
      ))}
      <Kicker style={{ margin: '14px 0 6px' }}>Your sites · {sites.length}</Kicker>
      {sites.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        sites.slice(0, 60).map((b) => (
          <button key={b.id} className={`list-row${selected.has(b.id) ? ' on' : ''}`} onClick={() => pickSite(b.id)}>
            <span className="name">{buildingName(w, b.id)}</span>
            <span className="muted">{b.ownerGangId === gang.id ? 'owned' : `${money(b.protection?.weekly ?? 0)}/wk`}</span>
          </button>
        ))
      )}
    </>
  );
}
