import { MoneyRoll } from './MoneyRoll';
import { useEffect, useRef, useState } from 'react';
import { useGame } from '../app/store';
import { streetRoster } from '../app/streetRoster';

/** The HUD redraws five times a second; the roster walks the whole city, so
 * one result serves for 400 ms (a new street order shows within that). */
let rosterCache: { w: WorldState; gangId: number; at: number; roster: ReturnType<typeof streetRoster> } | null = null;
function rosterFor(w: WorldState, gang: Gang): ReturnType<typeof streetRoster> {
  const now = performance.now();
  if (rosterCache && rosterCache.w === w && rosterCache.gangId === gang.id && now - rosterCache.at < 400) return rosterCache.roster;
  rosterCache = { w, gangId: gang.id, at: now, roster: streetRoster(w, gang) };
  return rosterCache.roster;
}
import { audio } from '../audio/audio';
import { ORDERS, WEAPONS } from '../sim/constants';
import { cargoActivity } from '../sim/cargo';
import type { Gang, MessageCategory, Person, WorldState } from '../sim/types';
import type { OverlayKind } from '../render/scene';
import { previewPosition } from '../sim/movement';
import { allocateWeapons } from '../sim/weapons';
import { streetLocation } from '../sim/cityLayout';
import { dayIndex } from '../sim/world';
import { VIEW_ZOOM, viewForZoom, type CityViewMode } from '../render/viewModes';
import { cameraApi } from './CityView';
import { Icon } from './common';
import { InterfaceButton, WindowHeading } from './InterfaceControls';
import { MapAccess } from './MapAccess';
import { Minimap } from './Minimap';
import { TaggedWindow } from './TaggedWindow';
import { TutorialPanel } from './TutorialPanel';
import { WeekClock, weekTime, WEEK_DAYS } from './WeekClock';
import './interface.css';
import { buildingList } from '../sim/entityLists';

const CATEGORIES:Record<MessageCategory,{name:string;short:string;key:string}>={
  combat:{name:'Combat messages',short:'Combat',key:'F5'},
  police:{name:'Gangsters and Police messages',short:'Police',key:'F6'},
  failed:{name:'Failed Order messages',short:'Failed',key:'F7'},
  waiting:{name:'Waiting and Priority messages',short:'Waiting',key:'F8'},
};
const OVERLAYS:{id:OverlayKind;label:string;caption:string}[]=[
  {id:'territory',label:'Territory',caption:'Turf'},
  {id:'lieutenant',label:'Lieutenant’s area',caption:'Lt. area'},
  {id:'landValue',label:'Land value',caption:'Value'},
  {id:'security',label:'Security',caption:'Security'},
  {id:'hostility',label:'Hostility',caption:'Hostility'},
  {id:'crime',label:'Crime hot spots',caption:'Crime'},
  {id:'events',label:'Recent events',caption:'Events'},
];
function currentOrder(p:Person,w:WorldState) {
  const staff = Object.values(w.specialistJobs ?? {}).find(j => j.actorId === p.id && j.week === w.week && ['travelling', 'working'].includes(j.state));
  if (staff) return staff.paused ? 'Waiting' : staff.type === 'audit' ? 'Audit' : staff.type === 'bribeOfficials' ? 'Bribe Officials' : 'Employ Police';
  if(p.streetOrder)return ({goTo:'Go to',kill:'Kill',assault:'Assault',tail:'Tail'} as const)[p.streetOrder.type];
  const order=p.orderId==null?null:w.orders[p.orderId];
  return order?.state==='waiting'?'Waiting':cargoActivity(w,p)??(order?ORDERS[order.type].name:p.dest?'Travelling':'Idle');
}
export function WeekHud() {
  const sim=useGame(s=>s.sim)!;
  const paused=useGame(s=>s.paused), finishing=useGame(s=>s.finishingWeek);
  const filter=useGame(s=>s.messageFilter), override=useGame(s=>s.messageOverride);
  const messageBox=useGame(s=>s.messageBox), taggedIds=useGame(s=>s.taggedPersonIds);
  const autoCut=useGame(s=>s.autoLowerRoofs), overlays=useGame(s=>s.overlays);
  const setMessageBox=useGame(s=>s.setMessageBox);
  useGame(s=>s.version);
  const [view,setView]=useState<CityViewMode>('street');
  const [removed,setRemoved]=useState(false),[flipped,setFlipped]=useState(false);
  const [rosterOpen,setRosterOpen]=useState(false),[rosterMode,setRosterMode]=useState<'people'|'orders'>('people');
  const [messageId,setMessageId]=useState<number|null>(null);
  // The street under the view, in the original's words (manual p.74).
  const [place,setPlace]=useState('');
  const [flashes,setFlashes]=useState<MessageCategory[]>([]);
  // Messages already in a loaded city are not news: no sirens or slow-down for them.
  const lastMessage=useRef(sim.world.messages.at(-1)?.id??0);
  const w=sim.world,gang=sim.playerGang,roster=rosterFor(w,gang),loadout=rosterOpen?allocateWeapons(w):null;
  const state=useGame.getState;
  const worldRef=useRef(w);worldRef.current=w;
  useEffect(()=>{
    const sync=()=>{const city=cameraApi.ref;if(city){setView(viewForZoom(city.getZoom()));setRemoved(city.areBuildingsRemoved());setFlipped(city.isFlipped());setPlace(streetLocation(worldRef.current,city.getTarget()));}};
    sync();const timer=window.setInterval(sync,150);return ()=>clearInterval(timer);
  },[]);
  const latest=w.messages.at(-1)?.id??0;
  useEffect(()=>{
    if(latest<=lastMessage.current){lastMessage.current=latest;return;}
    const fresh=w.messages.filter(m=>m.id>lastMessage.current);lastMessage.current=latest;
    if(!fresh.length)return;
    if(fresh.some(m=>m.sound==='gunshot'))audio.gunshot();
    else if(fresh.some(m=>m.category==='combat'))audio.alert();
    else if(fresh.some(m=>m.category==='police'))audio.siren();
    else if(fresh.some(m=>m.category==='failed'))audio.alert();
    if(!override && fresh.some(m=>filter[m.category]))state().setSpeed(1);
    setFlashes([...new Set(fresh.map(m=>m.category))]);
  },[latest,w.messages,override,filter]);
  useEffect(()=>{if(!flashes.length)return;const timer=window.setTimeout(()=>setFlashes([]),5000);return ()=>clearTimeout(timer);},[flashes]);
  useEffect(()=>{setMessageId(null);},[messageBox]);
  const messages=w.messages.filter(m=>m.category===messageBox).slice().reverse();
  const messageIndex=Math.max(0,messages.findIndex(m=>m.id===messageId));
  const message=messages[messageIndex];
  const counts={combat:0,police:0,failed:0,waiting:0};
  for(const m of w.messages)counts[m.category]++;
  const zoom=(mode:CityViewMode)=>{setView(mode);cameraApi.ref?.setZoom(VIEW_ZOOM[mode]);};
  const watch=(p:Person)=>{state().selectPerson(p.id);state().requestCamera(previewPosition(p,sim.subMinute,{x:0,y:0}));};
  const eventView=(m:typeof message|undefined)=>{if(!m)return;if(m.pos)state().requestCamera(m.pos);if(m.personId!=null)state().selectPerson(m.personId);};
  return <div className="classic-hud">
    <header className="week-bars">
      <div className="week-titlebar">
        <button className="week-exit" onClick={()=>state().setQuitPrompt(true)} title="Exit to the main menu (Ctrl+Q)">Exit</button>
        <span>Working week <b>{w.week}</b></span>
        <span className="week-status">{paused?'Paused':finishing?'Finishing week':`${WEEK_DAYS[dayIndex(w.minute)]} · ${weekTime(w.minute)}`}</span>
        <span className="week-place" title={place}>{place}</span>
        <span className="week-cash">Cash <b><MoneyRoll value={gang.cash} /></b></span>
      </div>
      <nav className="week-iconbar" aria-label="Working week controls">
        <div className="interface-control-group">
          <InterfaceButton label={paused&&!finishing?'Resume':'Pause'} icon={paused&&!finishing?'hud/play':'hud/pause'} caption={paused&&!finishing?'Resume':'Pause'} aria-pressed={paused&&!finishing}
            title={finishing?'Stop skipping and pause (P)':paused?'Resume (P)':'Pause (P)'} onClick={()=>finishing?state().cancelFinishWeek():state().setPaused(!paused)}/>
          <InterfaceButton label="Help" glyph="?" caption="Help" onClick={()=>state().setHelpOpen(true)}/>
          <InterfaceButton label="City Plan View" icon="tabs/maps" caption="City plan" aria-pressed={view==='plan'} title="City Plan View (Insert)" onClick={()=>zoom('plan')}/>
          <InterfaceButton label="Rooftop View" glyph="▱" caption="Rooftop" aria-pressed={view==='roof'} title="Rooftop View (Home)" onClick={()=>zoom('roof')}/>
          <InterfaceButton label="Street View" icon="orders/explore" caption="Street" aria-pressed={view==='street'} title="Street View (Page Up)" onClick={()=>zoom('street')}/>
          <InterfaceButton label="Center on Headquarters" glyph="⌂" caption="HQ" onClick={()=>{
            const hq=buildingList(w).find(b=>b.ownerGangId===gang.id&&b.isHQ);
            if(hq)state().requestCamera(w.lots[hq.lotId].center);
          }}/>
          <InterfaceButton label="Tagged Characters" icon="groups/personnel" caption="People" count={roster.count} aria-expanded={rosterOpen} aria-controls="street-roster-window" onClick={()=>setRosterOpen(!rosterOpen)}/>
          <InterfaceButton label="Clear Tagged Windows" glyph="×" caption="Untag" disabled={!taggedIds.length} onClick={()=>state().clearTaggedWindows()}/>
        </div>
        <div className="interface-control-group" aria-label="View options">
          {/* The ground wash shows from the rooftops too; only the street is too close for it. */}
          {view!=='street' && <>{OVERLAYS.map(o=><InterfaceButton key={o.id} label={o.label} icon={`overlays/${o.id}`} caption={o.caption} aria-pressed={overlays.includes(o.id)} onClick={()=>state().toggleOverlay(o.id)}/>)}
            <InterfaceButton label="Clear overlays" glyph="∅" caption="Clear" onClick={()=>state().setOverlays([])}/></>}
          {view!=='plan' && <>
            <InterfaceButton label="Reverse view" glyph="↔" caption="Reverse" aria-pressed={flipped} title="Reverse view (F)" onClick={()=>cameraApi.ref?.flipView()}/>
            <InterfaceButton label={removed?'Restore buildings':'Remove buildings'} icon="orders/buyPremises" caption={removed?'Restore':'Remove'} aria-pressed={removed} title="Remove or restore buildings (B)" onClick={()=>cameraApi.ref?.toggleBuildingsRemoved()}/>
            <InterfaceButton label="Automatic cutaway" icon="orders/setUpBusiness" caption="Cutaway" aria-pressed={autoCut} onClick={()=>state().setAutoLowerRoofs(!autoCut)}/>
          </>}
        </div>
        <div className="interface-control-group message-controls" aria-label="Messages">
          {(Object.keys(CATEGORIES) as MessageCategory[]).map(c=><InterfaceButton key={c} label={CATEGORIES[c].name} icon={`messages/${c}`} caption={CATEGORIES[c].short} count={counts[c]}
            className={flashes.includes(c)?'message-flash':''} aria-pressed={messageBox===c} title={`${CATEGORIES[c].name} (${CATEGORIES[c].key}); right-click to view latest event`}
            onClick={()=>{setMessageBox(c);setMessageId(null);}} onContextMenu={e=>{e.preventDefault();eventView(w.messages.filter(m=>m.category===c).at(-1));}}/>) }
          <InterfaceButton label="Message Override" icon="hud/override" caption="Override" aria-pressed={override} title="Message Override — keep accelerated time when reports arrive" onClick={()=>state().toggleMessageOverride()}/>
        </div>
        <MapAccess className="interface-map-search" label="Find…"/>
      </nav>
    </header>
    <div className="week-windows">
      {taggedIds.map(id=><TaggedWindow key={id} id={id}/>)}
      <div className="week-tutorial"><TutorialPanel/></div>
      {rosterOpen && <section id="street-roster-window" className="interface-window street-list" aria-label="Tagged characters">
        <WindowHeading title="Tagged Characters" onClose={()=>setRosterOpen(false)}/>
        <div className="street-list-summary">On the streets · {roster.count}</div>
        <div className="street-list-content">
          {!roster.count && <p>Nobody deployed. The boss and indoor staff are not counted.</p>}
          {roster.groups.map(group=><div className="street-list-group" key={group.key}>
            <div className="street-list-heading"><b>{group.name}</b><span>{group.people.length}{group.team?` of ${group.crewSize}`:''} deployed</span></div>
            {group.people.map(p=>{
              const weapon=loadout?.get(p.id),order=currentOrder(p,w),role=p.role==='lieutenant'?'Lieutenant':p.role==='accountant'?'Accountant':p.role==='lawyer'?'Lawyer':'Hood';
              return <button key={p.id} className={`street-list-person${group.team&&p.id!==group.team.lieutenantId?' subordinate':''}`} aria-pressed={taggedIds.includes(p.id)}
                title={`${p.name} · ${role} · ${order} · ${weapon?WEAPONS[weapon].name:'Unarmed'}`} onClick={()=>watch(p)}>
                <Icon name={p.role==='accountant'?'roles/accountant':p.role==='lawyer'?'roles/lawyer':weapon?`weapons/${weapon}`:'skills/fists'} size={20}/>
                <span><b>{rosterMode==='people'?p.name:order}</b><small>{rosterMode==='people'?role:p.name}</small></span>
              </button>;
            })}
          </div>)}
        </div>
        <footer className="interface-window-tabs">
          <button aria-pressed={rosterMode==='people'} onClick={()=>setRosterMode('people')}>People</button>
          <button aria-pressed={rosterMode==='orders'} onClick={()=>setRosterMode('orders')}>Orders</button>
        </footer>
      </section>}
    </div>
    <div className={`week-minimap${messageBox?' has-message':''}`}><Minimap size={144}/><span>City plan</span></div>
    <WeekClock/>
    {messageBox && <section className="interface-window message-window" aria-label="Message Box">
      <WindowHeading title={CATEGORIES[messageBox].name} onClose={()=>setMessageBox(null)}/>
      <div className="message-filter-row"><span>Slow time for</span>{(Object.keys(CATEGORIES) as MessageCategory[]).map(c=><button key={c} aria-label={`Slow time for ${CATEGORIES[c].short}`} aria-pressed={filter[c]} title={`${filter[c]?'Disable':'Enable'} ${CATEGORIES[c].name.toLowerCase()} slowing time`} onClick={()=>state().toggleMessageFilter(c)}><Icon name={`messages/${c}`} size={18}/></button>)}</div>
      <div className="message-paper" aria-live="polite">{message?<><time>{WEEK_DAYS[dayIndex(message.minute)]} · {weekTime(message.minute)}</time><p>{message.text}</p></>:<p>Nothing to report.</p>}</div>
      <footer className="message-navigation">
        <button aria-label="Most recent message" title="Most recent message" disabled={!message||messageIndex===0} onClick={()=>setMessageId(null)}>«</button>
        <button aria-label="Newer message" title="Newer message" disabled={!message||messageIndex===0} onClick={()=>setMessageId(messages[messageIndex-1].id)}>‹</button>
        <span>{messages.length?messageIndex+1:0} / {messages.length}</span>
        <button aria-label="Older message" title="Older message" disabled={!message||messageIndex===messages.length-1} onClick={()=>setMessageId(messages[messageIndex+1].id)}>›</button>
        <button aria-label="Earliest message" title="Earliest message" disabled={!message||messageIndex===messages.length-1} onClick={()=>setMessageId(messages.at(-1)!.id)}>»</button>
        <button disabled={!message||(!message.pos&&message.personId==null)} onClick={()=>eventView(message)}>View event</button>
        <button disabled={!message} title="Remove this report from the message box" onClick={()=>{
          if(message){w.messages=w.messages.filter(m=>m.id!==message.id);state().bump();}
          setMessageId(null);
        }}>Clear</button>
      </footer>
    </section>}
  </div>;
}
