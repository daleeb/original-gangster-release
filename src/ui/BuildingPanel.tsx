import { useEffect, useState } from 'react';
import { ArtImage } from './ArtImage';
import { act, useGame } from '../app/store';
import { quoteBuildingSale, recallManager, repairBuilding, sackManager, sellBuilding, setPay, setTrading, shutdownBuilding } from '../sim/api';
import { businessCarryingCost } from '../sim/businessState';
import { goodsDeliverySummary } from '../sim/goodsDelivery';
import { BUILDING_BY_ID } from '../sim/data/buildings';
import { buildingValue, protectionBase } from '../sim/execution';
import { buildingMapIntel } from '../sim/mapIntel';
import {fireDamageStage} from '../sim/buildingDamage';
import { buildingName, money } from '../sim/world';
import { thumbUrl } from './art';
import { Icon, Kicker, Modal, Pill, Rivets, Stamp, Stars } from './common';

export function BuildingPanel() {
  const sim = useGame((s) => s.sim)!;
  const id = useGame((s) => s.selectedBuildingId);
  const selectBuilding = useGame((s) => s.selectBuilding);
  const notify = useGame((s) => s.notify);
  useGame((s) => s.version);
  const [confirmation,setConfirmation] = useState<{kind:'shutdown'|'sell';id:number;name:string;price?:number}|null>(null);
  useEffect(()=>setConfirmation(null),[sim,id]);

  if (id == null) return null;
  const w = sim.world;
  const gang = sim.playerGang;
  const b = w.buildings[id];
  if (!b) return null;
  const intel = buildingMapIntel(b, gang.id);
  if (!intel.siteKnown) return null;
  const protection = intel.protectionGangId != null ? b.protection : null;

  const t = BUILDING_BY_ID[b.typeId];
  const blk = w.blocks[b.blockId];
  const lot = w.lots[b.lotId];
  const knowledge = b.ownerGangId === gang.id ? 4 : (b.knowledge[gang.id] ?? 0);
  const mine = b.ownerGangId === gang.id;
  const manager = b.managerId != null ? w.people[b.managerId] : null;
  const owner = b.ownerPersonId != null ? w.people[b.ownerPersonId] : null;
  const front = b.frontId != null ? w.buildings[b.frontId] : null;
  const hides = b.hidesId != null ? w.buildings[b.hidesId] : null;
  const cls = b.cls[0].toUpperCase() + b.cls.slice(1);
  const fireStage=fireDamageStage(b,w.week);
  const carryingCost=businessCarryingCost(b);
  const deliverySummary=mine?goodsDeliverySummary(w,b):null;
  const offerSale=()=>{
    const offer=quoteBuildingSale(w,gang.id,b.id);
    if(!offer.ok){notify(offer);return;}
    setConfirmation({kind:'sell',id:b.id,name:buildingName(w,b.id),price:offer.value});
  };
  const accept=()=>{
    if(!confirmation||confirmation.id!==id)return;
    const result=act(s=>confirmation.kind==='sell'
      ?sellBuilding(s.world,gang.id,confirmation.id,confirmation.price)
      :shutdownBuilding(s.world,gang.id,confirmation.id));
    if(result==null)return;
    setConfirmation(null);notify(result);
  };

  return (
    <>
    <div className="brass info-panel">
      <div className="paper">
        <Rivets />
        {protection?.refusing && <Stamp kind="refused" />}
        <div className="head">
          <ArtImage className="facade" src={thumbUrl(b.cls, b.state)} alt="" draggable={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Kicker>
              {cls} · block {blk.gx},{blk.gy} · lot {lot.index === 4 ? 'centre' : lot.index}
            </Kicker>
            <h4>{t?.name ?? 'Empty land'}</h4>
            <div className="sub">
              {fireStage==='scorched'?'Fire damaged':fireStage==='repairing'?'Under repair':fireStage==='awaiting-repair'?'Awaiting repairs':b.fbiClosedWeek!=null&&b.state==='ceased'?'Closed by FBI':b.state[0].toUpperCase() + b.state.slice(1)}
              {b.state === 'damaged' && b.repairCompleteWeek==null && ` · repairs ${money(b.repairCost)}`} · land value {blk.landValue}
              {intel.isHQ && ' · headquarters'}
            </div>
          </div>
          <button className="close" onClick={() => selectBuilding(null)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="body">
          {mine && b.fbiClosedWeek!=null && <div className="note">The FBI seized the stock and closed this operation. Shut it down before opening a new business.</div>}
          {mine && b.fbiRaidWeek!=null && <div className="note">The FBI found this operation. A raid is expected from week {b.fbiRaidWeek}; ceasing trade does not erase the discovery.</div>}
          {mine && b.resumeTradingWeek!=null && <div className="note">Trading resumes in week {b.resumeTradingWeek}. There will be no income this week.</div>}
          {mine && b.state==='ceased' && carryingCost>0 && <div className="note">Site costs continue at {money(carryingCost)} a week while ceased, plus the manager's wages.</div>}
          {b.repairCompleteWeek!=null&&<div className="note">Closed for fire repairs. Repairs finish in week {b.repairCompleteWeek}.</div>}
          {protection && (
            <div className="kv">
              <span>Protection</span>
              <b>
                {money(protection.weekly)}/wk to {w.gangs[protection.gangId]?.name}
                {protection.refusing && ' — refusing'}
              </b>
            </div>
          )}
          {/* A bought site keeps its seller as occupant: the owner is the gang. */}
          {(intel.ownerGangId != null || owner && knowledge >= 2 && b.ownerGangId == null) && (
            <div className="kv">
              <span>Owner</span>
              <b>{intel.ownerGangId != null ? w.gangs[intel.ownerGangId]?.name : owner!.name}</b>
            </div>
          )}
          {knowledge >= 3 && !mine && t && (
            <div className="kv">
              <span>Trade</span>
              <b>{money(t.profit)}/wk typical</b>
            </div>
          )}
          {b.cls !== 'municipal' && b.cls !== 'charity' && b.cls !== 'residential' && !mine && intel.ownerGangId == null && (
            <div className="kv">
              <span>Asking price</span>
              <b>about {money(buildingValue(w, b))}</b>
            </div>
          )}

          {b.state === 'destroyed' && (
            <div className="note">Rubble. Nobody can build here until it is cleared — and a ruined block drags the whole neighbourhood down.</div>
          )}
          {knowledge < 2 && !mine && <div className="note">You know little of this place. Extort it, or send a hood to explore.</div>}
          {b.cls !== 'illegal' && b.cls !== 'empty' && b.cls !== 'municipal' && b.cls !== 'residential' && !protection && !mine && (
            <div className="note">Would pay roughly {money(protectionBase(w, b))} a week under your protection.</div>
          )}

          {/* ------------------------------------------------ owned */}
          {mine && (
            <>
              <div className="kv">
                <span>Last week</span>
                <b style={{ color: b.lastProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(b.lastProfit)}</b>
              </div>
              {manager && (
                <>
                  <div className="kv">
                    <span>Manager</span>
                    <b>{manager.name}</b>
                  </div>
                  <div className="kv">
                    <span>Ability</span>
                    <b>
                      <Stars value={(manager.skills.business + manager.skills.organization) / 2} />
                    </b>
                  </div>
                  <div className="kv">
                    <span>Pay</span>
                    <b>
                      {money(manager.pay)} / wants {money(manager.payDemand)}
                    </b>
                  </div>
                  {mine && (
                    <div className="row" style={{ gap: 6, margin: '4px 0 6px', flexWrap: 'wrap' }}>
                      {manager.pay < manager.payDemand && (
                        <button className="btn sm" title="Pay him what he asks" onClick={() => notify(act((s) => setPay(s.world, manager.id, manager.payDemand))!)}>
                          Pay his demand
                        </button>
                      )}
                      <button className="btn sm" title="Back to the pool; this week's takings go with him" onClick={() => notify(act((s) => recallManager(s.world, gang.id, b.id))!)}>
                        Return to base
                      </button>
                      <button className="btn sm danger" title="Out on the street, and no friend of yours" onClick={() => notify(act((s) => sackManager(s.world, gang.id, b.id))!)}>
                        Sack
                      </button>
                    </div>
                  )}
                </>
              )}
              {!manager && b.cls !== 'empty' && b.fbiClosedWeek == null && (
                <div className="note" style={{ color: 'var(--red)' }}>
                  Nobody is running this place. Give a crew the Run Business order.
                </div>
              )}
              {front && (
                <div className="kv">
                  <span>Fronted by</span>
                  <b>{buildingName(w, front.id)}</b>
                </div>
              )}
              {hides && (
                <div className="kv">
                  <span>Hides</span>
                  <b>{buildingName(w, hides.id)}</b>
                </div>
              )}
              {b.cls === 'illegal' && (
                <div className="kv">
                  <span>Cover</span>
                  <b>
                    {Math.round(b.cover * 100)}%{b.discovered && ' — DISCOVERED'}
                  </b>
                </div>
              )}
              {(b.stock.liquor > 0 || b.stock.stolen > 0 || b.stock.counterfeit > 0) && (
                <div className="kv">
                  <span>Stock</span>
                  <b>
                    {b.stock.liquor > 0 && (
                      <>
                        <Icon name="goods/liquor" size={13} /> {b.stock.liquor} liquor{' '}
                      </>
                    )}
                    {b.stock.stolen > 0 && (
                      <>
                        <Icon name="goods/stolen" size={13} /> {b.stock.stolen} goods{' '}
                      </>
                    )}
                    {b.stock.counterfeit > 0 && (
                      <>
                        <Icon name="goods/counterfeit" size={13} /> {b.stock.counterfeit} queer
                      </>
                    )}
                  </b>
                </div>
              )}

              {b.typeId==='warehouse' && <div className="kv"><span>Storage capacity</span><b>300 liquor / stolen cases combined · 15 counterfeit</b></div>}
              {deliverySummary && <div className="note">{deliverySummary}</div>}
              {t?.produces && b.state==='trading' && b.stock[t.produces.kind]>=(t.produces.kind==='counterfeit'?15:300) && <div className="note">Production is waiting for storage space.</div>}
              <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                {b.state === 'trading' && b.fbiClosedWeek == null && (
                  <button className="btn sm" title={`No income for the entire week. Site costs ${money(carryingCost)}/week plus wages still apply.`} onClick={() => notify(act((s) => setTrading(s.world, gang.id, b.id, false))!)}>
                    Cease trading
                  </button>
                )}
                {b.state === 'ceased' && b.fbiClosedWeek == null && (
                  <button className="btn sm" onClick={() => notify(act((s) => setTrading(s.world, gang.id, b.id, true))!)}>
                    {b.resumeTradingWeek != null ? 'Restart scheduled' : 'Commence trading'}
                  </button>
                )}
                {b.resumeTradingWeek != null && <button className="btn sm" onClick={() => notify(act(s => setTrading(s.world,gang.id,b.id,false))!)}>Keep closed</button>}
                {b.state === 'damaged' && b.repairCompleteWeek==null && (
                  <button className="btn sm" onClick={() => notify(act((s) => repairBuilding(s.world, gang.id, b.id))!)}>
                    Repair ({money(b.repairCost)})
                  </button>
                )}
                {!b.isHQ && b.cls !== 'empty' && b.hidesId == null && (
                  <button className="btn sm danger" onClick={() => setConfirmation({kind:'shutdown',id:b.id,name:buildingName(w,b.id)})}>
                    Shut down
                  </button>
                )}
                {!b.isHQ && b.cls !== 'illegal' && b.hidesId == null && (
                  <button className="btn sm" onClick={offerSale}>
                    Sell
                  </button>
                )}
                {b.isHQ && <Pill kind="warn">Headquarters</Pill>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    {confirmation && confirmation.id===id && <Modal title={confirmation.kind==='sell'?`Sell ${confirmation.name}`:`Shut down ${confirmation.name}?`}
      kicker={confirmation.kind==='sell'?'Offer for your property':'Business order'} onClose={()=>setConfirmation(null)} width={430}
      footer={<><button className="btn danger lg" onClick={accept}>{confirmation.kind==='sell'?'Accept offer':'Yes, shut down'}</button>
        <button className="btn lg" data-autofocus onClick={()=>setConfirmation(null)}>Cancel</button></>}>
      {confirmation.kind==='sell'?<><p>You have been offered:</p><p className="mono" style={{fontSize:30,textAlign:'center'}}>{money(confirmation.price!)}</p>
        <p>Accept to sell this property. Its manager remains on your payroll.</p></>
        :<p>Close this business and leave empty land? Its stock will be lost and its manager will return to the pool. The land remains yours.</p>}
    </Modal>}
    </>
  );
}
