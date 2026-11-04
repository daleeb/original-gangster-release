import { useState } from 'react';
import { act, useGame } from '../../app/store';
import {
  assignStaffVehicle,
  bribePrice,
  canGoStraight,
  policeTourCapacity,
  hireRecruit,
  sackPerson,
  setGoStraight,
  setPay,
  setRunForOffice,
} from '../../sim/api';
import { GO_STRAIGHT_ASSETS } from '../../sim/constants';
import { campaignWeeklyCost, officeEntryCheck, electionBlocksRequired } from '../../sim/systems/politics';
import type { Person } from '../../sim/types';
import { gangAssets, money, territoryCount } from '../../sim/world';
import { Avatar, ConfirmDialog, Empty, Hint, Panel, Pill, Stars } from '../common';
import { VEHICLES, VEHICLE_ORDER } from '../../sim/constants';
import { SpecialistJobList } from '../SpecialistJobCard';
import { peopleList } from '../../sim/entityLists';
import { quitGangPayroll } from '../../sim/payrollMark';

export function LawyerTab() {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const beginSpecialistOrder = useGame(s => s.beginSpecialistOrder);
  const requestCamera = useGame((s) => s.requestCamera);
  useGame((s) => s.version);
  const [officialKind, setOfficialKind] = useState<'mayor' | 'policeChief' | 'judge' | 'da' | 'police'>('mayor');
  const [sacking, setSacking] = useState(false);

  const w = sim.world;
  const gang = sim.playerGang;
  const lawyer = gang.lawyerId != null ? w.people[gang.lawyerId] : null;
  const straight = canGoStraight(w, gang.id);
  const officeEntry = officeEntryCheck(w, gang.id);
  const cases = Object.values(w.cases).filter((c) => c.gangId === gang.id);
  const squealers = peopleList(w).filter(
    (p) => p.role === 'owner' && (p.opinion[gang.id] ?? 0) < -40 && p.status === 'active',
  );
  const wanted = Object.values(w.people)
    .filter((p) => p.gangId === gang.id && p.wanted > 25 && p.status !== 'dead')
    .sort((a, b) => b.wanted - a.wanted);
  const crimes = w.crimes.filter((c) => c.gangId === gang.id && c.week >= w.week - 1 && !c.charge);

  const officials: Person[] = (() => {
    switch (officialKind) {
      case 'mayor':
        return [w.people[w.mayorId]].filter(Boolean);
      case 'policeChief':
        return [w.people[w.policeChiefId]].filter(Boolean);
      case 'judge':
        return w.judgeIds.map((id) => w.people[id]).filter(Boolean);
      case 'da':
        return w.daIds.map((id) => w.people[id]).filter(Boolean);
      case 'police':
        return w.policeIds
          .map((id) => w.people[id])
          .filter((p) => p && p.status === 'active')
          .slice(0, 24);
    }
  })();

  const freeLawyers = peopleList(w).filter(
    (p) => p.role === 'lawyer' && p.gangId == null && p.status === 'active',
  );

  return (
    <div>
      <Panel title="The Lawyer">
        {lawyer ? (
          <>
            <div className="row" style={{ gap: 10 }}>
              <Avatar person={lawyer} gang={gang} />
              <div style={{ flex: 1 }}>
                <div className="row between">
                  <b style={{ color: lawyer.pay < lawyer.payDemand ? 'var(--blood)' : undefined }}>{lawyer.name}</b>
                  <Stars value={lawyer.skills.intelligence} />
                </div>
                <div className="muted tiny">
                  Pay {money(lawyer.pay)} · wants {money(lawyer.payDemand)}
                </div>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
              <button
                className="btn sm"
                onClick={() => notify(act((s) => setPay(s.world, lawyer.id, lawyer.payDemand))!)}
              >
                Meet Pay
              </button>
              <button
                className="btn sm danger"
                onClick={() => setSacking(true)}
              >
                Sack
              </button>
            </div>
            {sacking && (
              <ConfirmDialog
                text={`Sack ${lawyer.name}? He leaves bearing a grudge, and you will need a new lawyer.`}
                onYes={() => { setSacking(false); notify(act((s) => sackPerson(s.world, gang.id, lawyer.id))!); }}
                onNo={() => setSacking(false)}
              />
            )}
            <Hint>He defends your people in court automatically. Everything else you must ask for.</Hint>
          </>
        ) : (
          <>
            <Empty>
              No lawyer. Your hoods will face the district attorney alone, and you cannot bribe
              officials, employ police, run for office or go straight.
            </Empty>
            {freeLawyers.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="muted tiny" style={{ marginBottom: 4 }}>
                  Recruit at a law office or the courthouse to bring one in.
                </div>
                {freeLawyers.slice(0, 4).map((p) => (
                  <div key={p.id} className="row between" style={{ padding: '3px 0' }}>
                    <span className="tiny">{p.name}</span>
                    <div className="row" style={{ gap: 5 }}>
                      <Stars value={p.skills.intelligence} />
                      <span className="muted tiny mono">{money(p.payDemand)}</span>
                      {gang.recruitIds.includes(p.id) && (
                        <button
                          className="btn sm"
                          onClick={() => notify(act((s) => hireRecruit(s.world, gang.id, p.id, 'pool'))!)}
                        >
                          Hire
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      {lawyer && (
        <>
          <Panel title="Employ Police">
            <Hint>
              He tours an area you mark on the map and puts the officers on its beats on a weekly retainer to
              overlook your crimes — {policeTourCapacity(gang)} of them in a week{gang.staffVehicles?.lawyer ? ' with the car' : ', twice that with a car'}.
            </Hint>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <button className="btn brass" onClick={() => beginSpecialistOrder('employPolice')}>Mark the area</button>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <span className="tiny muted">
                Car: {gang.staffVehicles?.lawyer ? VEHICLES[gang.staffVehicles.lawyer].name : 'none'}
              </span>
              {VEHICLE_ORDER.filter((v) => (gang.vehicles[v] ?? 0) > 0 && gang.staffVehicles?.lawyer !== v).map((v) => (
                <button key={v} className="btn sm" onClick={() => notify(act((s) => assignStaffVehicle(s.world, gang.id, 'lawyer', v))!)}>
                  Give {VEHICLES[v].name}
                </button>
              ))}
              {gang.staffVehicles?.lawyer && (
                <button className="btn sm" onClick={() => notify(act((s) => assignStaffVehicle(s.world, gang.id, 'lawyer', null))!)}>
                  Take the car back
                </button>
              )}
            </div>
          </Panel>

          <Panel title="Bribe Officials">
            <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
              {(
                [
                  ['mayor', 'Mayor'],
                  ['policeChief', 'Chief'],
                  ['judge', 'Judges'],
                  ['da', 'DAs'],
                  ['police', 'Officers'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`btn sm${officialKind === k ? ' on' : ''}`}
                  onClick={() => setOfficialKind(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="scroll-list">
              {officials.map((p) => {
                const view = p.opinion[gang.id] ?? 0;
                return (
                  <div key={p.id} className="row between" style={{ padding: '4px 0', borderBottom: '1px dotted #bdb094' }}>
                    <button
                      className="name tiny"
                      style={{ textAlign: 'left', flex: 1 }}
                      onClick={() => requestCamera({ x: p.pos.x, y: p.pos.y })}
                    >
                      {p.name}
                      {p.bribedBy === gang.id && ' ✓'}
                    </button>
                    <div className="row" style={{ gap: 5 }}>
                      <Pill kind={view > 20 ? 'good' : view < -20 ? 'bad' : undefined}>
                        {view > 20 ? 'friendly' : view < -20 ? 'hostile' : 'neutral'}
                      </Pill>
                      <span className="muted tiny mono">{money(bribePrice(w, p, gang.id))}</span>
                      <button
                        className="btn sm"
                        onClick={() => beginSpecialistOrder('bribeOfficials', p.id)}
                      >
                        Bribe
                      </button>
                      {p.role === 'police' && p.employedBy == null && !quitGangPayroll(p, gang.id) && (
                        <button
                          className="btn sm"
                          onClick={() => beginSpecialistOrder('employPolice', p.id)}
                        >
                          Employ
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <Hint>
              The head of the Bureau cannot be bought. Bribe a judge while he is hearing your case and
              it will be thrown out; bribe the DA and you will learn who is testifying.
            </Hint>
          </Panel>

          <Panel title="The Long Game">
            <div className="row between" style={{ marginBottom: 6 }}>
              <div>
                <b className="tiny">Go Straight</b>
                <div className="muted tiny">{straight.reason}</div>
              </div>
              <button
                className={`btn sm${gang.goingStraight ? ' on' : ''}`}
                disabled={!straight.can && !gang.goingStraight}
                onClick={() => notify(act((s) => setGoStraight(s.world, gang.id, !gang.goingStraight))!)}
              >
                {gang.goingStraight ? 'Cancel' : 'Begin'}
              </button>
            </div>
            <div className="row between tiny muted" style={{ marginBottom: 10 }}>
              <span>
                Assets excluding cash: {money(gangAssets(w, gang))} of {money(GO_STRAIGHT_ASSETS)}
              </span>
            </div>

            <div className="row between">
              <div>
                <b className="tiny">Run for Office</b>
                <div className="muted tiny">
                  {w.election.active
                    ? `Election in ${w.election.weeksLeft} week(s). You hold ${territoryCount(w, gang.id)} of ${electionBlocksRequired(w)} blocks needed.`
                    : 'No election is under way.'}
                </div>
                {w.election.active && <div className="muted tiny">
                  {money(campaignWeeklyCost(w, gang.id))} a week · changes with your territory and land values.
                  {!gang.runningForOffice && !officeEntry.can && ` ${officeEntry.reason}`}
                </div>}
              </div>
              <button
                className={`btn sm${gang.runningForOffice ? ' on' : ''}`}
                disabled={!officeEntry.can && !gang.runningForOffice}
                onClick={() => notify(act((s) => setRunForOffice(s.world, gang.id, !gang.runningForOffice))!)}
              >
                {gang.runningForOffice ? 'Withdraw' : 'Stand'}
              </button>
            </div>
          </Panel>
        </>
      )}

      <SpecialistJobList role="lawyer" />
      {w.election.active && (
        <Panel title="The Election">
          {gang.runningForOffice && <Hint>Campaign costs are paid after wages. If you cannot pay the full bill, you withdraw. Keep a lawyer available through the campaign; replace a lost lawyer before week's end to stay in the race.</Hint>}
          {w.election.candidates.map((c) => (
            <div key={c.id} className="row between tiny" style={{ padding: '3px 0' }}>
              <span>
                {w.people[c.id]?.name ?? 'Candidate'}
                {c.gangId != null && ` (${w.gangs[c.gangId]?.name})`}
              </span>
              <b className="mono">{c.votes}</b>
            </div>
          ))}
        </Panel>
      )}

      {!w.election.active && w.election.lastResult && w.week - w.election.lastResult.week <= 1 && (
        <Panel title="The Election Result">
          {w.election.lastResult.candidates.map((c) => (
            <div key={c.id} className="row between tiny" style={{ padding: '3px 0' }}>
              <span>
                {c.id === w.election.lastResult!.winnerId ? <b>{w.people[c.id]?.name ?? 'Candidate'} · elected</b> : w.people[c.id]?.name ?? 'Candidate'}
                {c.gangId != null && ` (${w.gangs[c.gangId]?.name})`}
              </span>
              <b className="mono">{c.votes}</b>
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Legal Proceedings">
        {cases.length === 0 ? (
          <Empty>Nobody of yours is before the courts.</Empty>
        ) : (
          cases.map((c) => (
            <div key={c.id} style={{ padding: '5px 0', borderBottom: '1px dotted #bdb094' }}>
              <div className="row between">
                <b className="tiny">{w.people[c.defendantId]?.name}</b>
                <Pill kind={c.status === 'convicted' ? 'bad' : c.status === 'awaiting' || c.status === 'onTrial' ? 'warn' : 'good'}>
                  {c.status}
                </Pill>
              </div>
              <div className="muted tiny">
                {c.crime} · Judge {w.people[c.judgeId]?.name} · DA {w.people[c.daId]?.name}
                {c.weeksToTrial > 0 && ` · trial in ${c.weeksToTrial} week(s)`}
              </div>
              {c.knowsWitnesses && (
                <div className="tiny" style={{ marginTop: 2 }}>
                  Witnesses: {c.witnessIds.map((id) => w.people[id]?.name).filter(Boolean).join(', ') || 'none left'}
                </div>
              )}
              {c.knowsJurors && (
                <div className="tiny">
                  Jurors: {c.jurorIds.map((id) => w.people[id]?.name).filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          ))
        )}
      </Panel>

      <Panel title="Most Wanted">
        {wanted.length === 0 ? (
          <Empty>None of your people are being watched.</Empty>
        ) : (
          wanted.slice(0, 12).map((p) => (
            <div key={p.id} className="row between tiny" style={{ padding: '2px 0' }}>
              <span>{p.name}</span>
              <b className="mono">{Math.round(p.wanted)}</b>
            </div>
          ))
        )}
        <Hint>Keep a hot hood off the streets for a week or two and the heat falls away.</Hint>
      </Panel>

      <Panel title="Squealers">
        {squealers.length === 0 ? (
          <Empty>Nobody is talking.</Empty>
        ) : (
          squealers.slice(0, 12).map((p) => (
            <button
              key={p.id}
              className="list-row"
              onClick={() => requestCamera({ x: p.pos.x, y: p.pos.y })}
            >
              <span className="name tiny">{p.name}</span>
              <Pill kind="bad">hostile</Pill>
            </button>
          ))
        )}
      </Panel>

      <Panel title="Crimes — This Week">
        {crimes.length === 0 ? (
          <Empty>Nothing on the books.</Empty>
        ) : (
          crimes.slice(-14).map((c) => (
            <div key={c.id} className="row between tiny" style={{ padding: '2px 0' }}>
              <span>
                {w.people[c.perpetratorId]?.name ?? 'Unknown'} — {c.kind}
              </span>
              <span className="muted mono">{Math.round(c.arrestRisk * 100)}% risk</span>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
