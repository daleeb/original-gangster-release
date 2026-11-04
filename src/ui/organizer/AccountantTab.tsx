import { useState } from 'react';
import { act, useGame } from '../../app/store';
import { financeNet } from '../../sim/finances';
import {
  assignStaffVehicle,
  dismissPoliceOfficer,
  hireRecruit,
  sackPerson,
  setPay,
  toggleEvadeTax,
} from '../../sim/api';
import { VEHICLES, VEHICLE_ORDER } from '../../sim/constants';
import { gangHoldings, money } from '../../sim/world';
import { reservedAudit, specialistTargetEligible } from '../../sim/specialistJobs';
import { Avatar, ConfirmDialog, Empty, Hint, Meter, Panel, Pill, Stars } from '../common';
import { SpecialistJobList } from '../SpecialistJobCard';
import { peopleList } from '../../sim/entityLists';
import { taxNotCoveredUp } from '../../sim/systems/taxes';

export function AccountantTab() {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  useGame((s) => s.version);

  const w = sim.world;
  const gang = sim.playerGang;
  const acct = gang.accountantId != null ? w.people[gang.accountantId] : null;
  const audit = w.auditResults[gang.id];
  const [period, setPeriod] = useState<'current' | 'last'>('last');
  const [sacking, setSacking] = useState(false);
  const report = (period === 'last' ? gang.lastFinanceReport : null) ?? gang.finances!;
  const income = report.income;
  const costs = report.costs;
  const net = financeNet(report);
  const holdings = gangHoldings(w, gang);

  const auditable = peopleList(w).filter(p => specialistTargetEligible(w, gang.id, 'audit', p));
  const reservation = reservedAudit(w, gang.id);

  const freeAccountants = peopleList(w).filter(
    (p) => p.role === 'accountant' && p.gangId == null && p.status === 'active',
  );

  return (
    <div>
      <Panel title="The Accountant">
        {acct ? (
          <>
            <div className="row" style={{ gap: 10 }}>
              <Avatar person={acct} gang={gang} />
              <div style={{ flex: 1 }}>
                <div className="row between">
                  <b style={{ color: acct.pay < acct.payDemand ? 'var(--blood)' : undefined }}>{acct.name}</b>
                  <Stars value={acct.skills.intelligence} />
                </div>
                <div className="muted tiny">
                  Pay {money(acct.pay)} · wants {money(acct.payDemand)}
                </div>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
              <button
                className={`btn sm${gang.evadingTax ? ' on' : ''}`}
                onClick={() => notify(act((s) => toggleEvadeTax(s.world, gang.id))!)}
              >
                {gang.evadingTax ? 'Evading Tax' : 'Evade Tax'}
              </button>
              <button
                className="btn sm"
                onClick={() => notify(act((s) => setPay(s.world, acct.id, acct.payDemand))!)}
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
                text={`Sack ${acct.name}? He leaves bearing a grudge, and you will need a new accountant.`}
                onYes={() => { setSacking(false); notify(act((s) => sackPerson(s.world, gang.id, acct.id))!); }}
                onNo={() => setSacking(false)}
              />
            )}
            <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
              <span className="tiny muted">Car: {gang.staffVehicles?.accountant ? VEHICLES[gang.staffVehicles.accountant].name : 'none'}</span>
              {VEHICLE_ORDER.filter((v) => (gang.vehicles[v] ?? 0) > 0 && gang.staffVehicles?.accountant !== v).map((v) => (
                <button key={v} className="btn sm" onClick={() => notify(act((s) => assignStaffVehicle(s.world, gang.id, 'accountant', v))!)}>
                  Give {VEHICLES[v].name}
                </button>
              ))}
              {gang.staffVehicles?.accountant && (
                <button className="btn sm" onClick={() => notify(act((s) => assignStaffVehicle(s.world, gang.id, 'accountant', null))!)}>
                  Take the car back
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <Empty>
              You have no accountant. Without one, almost nothing you earn illegally can be
              explained away.
            </Empty>
            {freeAccountants.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="muted tiny" style={{ marginBottom: 4 }}>
                  Known accountants for hire (send a hood to Recruit at an accountancy firm or the main
                  bank to find more):
                </div>
                {freeAccountants.slice(0, 4).map((p) => (
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

      <Panel title={`Finances — Week ${report.week}`}>
        <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          <button className="btn sm" aria-pressed={report === gang.finances} onClick={() => setPeriod('current')}>This week</button>
          <button className="btn sm" disabled={!gang.lastFinanceReport} aria-pressed={report === gang.lastFinanceReport} onClick={() => setPeriod('last')}>Last week</button>
        </div>
        <Hint>{report.partial ? 'Partial report: some details from this older save are unavailable.' : 'Includes Monday planning purchases through Friday settlement.'}</Hint>
        <div className="kv"><span>Opening cash</span><b>{money(report.openingCash)}</b></div>
        <div className="kv">
          <span>Legal income</span>
          <b>{money(income.legal)}</b>
        </div>
        <div className="kv">
          <span>Illegal income</span>
          <b>{money(income.illegal)}</b>
        </div>
        <div className="kv">
          <span>Protection</span>
          <b>{money(income.protection)}</b>
        </div>
        <div className="kv">
          <span>Other</span>
          <b>{money(income.other)}</b>
        </div>
        <div className="kv">
          <span>Wages</span>
          <b style={{ color: 'var(--blood)' }}>{money(-costs.wages)}</b>
        </div>
        <div className="kv">
          <span>Upkeep &amp; retainers</span>
          <b style={{ color: 'var(--blood)' }}>{money(-costs.upkeep)}</b>
        </div>
        {(report.closedSiteUpkeep ?? 0)>0 && <Hint>Includes {money(report.closedSiteUpkeep!)} paid for ceased sites. Their managers' pay is included in Wages.</Hint>}
        {(report.campaignCost ?? 0)>0 && <Hint>Includes {money(report.campaignCost!)} paid for the election campaign.</Hint>}
        <div className="kv">
          <span>Purchases &amp; bribes</span>
          <b style={{ color: 'var(--blood)' }}>{money(-costs.purchases)}</b>
        </div>
        {report.taxableProfit != null && <div className="kv"><span>Profit before tax</span><b>{money(report.taxableProfit)}</b></div>}
        <Hint>Tax covers profit after operating costs. Asset sales count only the gain or loss on their cost.</Hint>
        <div className="kv">
          <span>Tax paid</span>
          <b style={{ color: 'var(--blood)' }}>{money(-costs.tax)}</b>
        </div>
        <div className="kv" style={{ borderTop: '2px solid #bdb094', marginTop: 4, paddingTop: 6 }}>
          <span>
            <b>Net</b>
          </span>
          <b style={{ color: net >= 0 ? 'var(--green)' : 'var(--blood)' }}>{money(net)}</b>
        </div>
        <div className="kv">
          <span>{report === gang.lastFinanceReport ? 'Closing cash' : 'Cash so far'}</span>
          <b>{money(report.closingCash)}</b>
        </div>
      </Panel>

      <Panel title="Current holdings">
        <div className="kv"><span>Cash</span><b>{money(holdings.cash)}</b></div>
        <div className="kv"><span>Assets</span><b>{money(holdings.assets)}</b></div>
        <div className="kv"><span>Total wealth</span><b>{money(holdings.wealth)}</b></div>
        <details><summary>Asset breakdown</summary>
          <div className="kv"><span>Property</span><b>{money(holdings.property)}</b></div>
          <div className="kv"><span>Weapons</span><b>{money(holdings.weapons)}</b></div>
          <div className="kv"><span>Vehicles</span><b>{money(holdings.vehicles)}</b></div>
        </details>
        <Hint>Cash is separate from property and equipment. Equipment uses its half-price resale value; property estimates reflect location and damage. Goods count when sold.</Hint>
      </Panel>

      <Panel title="Risk">
        <div className="row between tiny" style={{ marginBottom: 3 }}>
          <span>Risky money at last settlement</span>
          <b className="mono">{money(gang.riskyMoney)}</b>
        </div>
        <Meter value={Math.min(100, gang.riskyMoney / 200)} />
        <div className="row between tiny" style={{ margin: '9px 0 3px' }}>
          <span>FBI suspicion</span>
          <b className="mono">{Math.round(gang.suspicion)}%</b>
        </div>
        <Meter value={gang.suspicion} />
        <div className="row between tiny" style={{ margin: '9px 0 3px' }}>
          <span>Evidence against you</span>
          <b className="mono">{Math.round(gang.evidence)}%</b>
        </div>
        <Meter value={gang.evidence} />
        <Hint>
          Illegal income you cannot explain is what brings the Bureau. Buy legal businesses to soak
          it up, or stop trading for a week to let the heat fall.
        </Hint>
      </Panel>

      <Panel title="Tax Evasion — Last 8 Weeks">
        <Hint>{w.cityLayout?.original
          ? 'Held-back tax waits until your accountant launders it against business takings. Above $2,000 it draws the FBI to your premises.'
          : 'Your accountant uses the previous week\'s legal income to hide tax and cover earlier shortfalls. Uncovered amounts remain a risk if the accountant is arrested, even after dismissal.'}</Hint>
        {gang.taxEvaded.length === 0 ? (
          <Empty>Nothing has been held back.</Empty>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              {gang.taxEvaded.map((v, i) => (
                <span key={i} className="pill">
                  {money(v)}
                </span>
              ))}
            </div>
            <div className="row between tiny" style={{ marginTop: 7 }}>
              <span>Not yet covered up</span>
              <b style={{ color: 'var(--blood)' }}>{money(taxNotCoveredUp(w, gang))}</b>
            </div>
          </>
        )}
      </Panel>

      {acct && (
        <Panel title="Audit">
          <Hint>Compare what a lieutenant or business manager took in with what they handed over. Audit reserves the accountant for the whole week.</Hint>
          <div className="row between tiny" style={{ marginBottom: 4 }}>
            <span>Accountant's week assigned</span><b>{reservation ? '100%' : '0%'}</b>
          </div>
          <Meter value={reservation ? 100 : 0} />
          {reservation?.state === 'done' && <Hint>The inspection is complete. Your accountant is preparing the report for the end of the week.</Hint>}
          {audit && (
            <div className="panel" style={{ background: 'rgba(200,149,47,0.16)' }}>
              <b className="tiny">{w.people[audit.personId]?.name}</b>
              <div className="kv">
                <span>Took in</span>
                <b>{money(audit.brought)}</b>
              </div>
              <div className="kv">
                <span>Turned over</span>
                <b>{money(audit.declared)}</b>
              </div>
              <div className="kv">
                <span>Skimmed</span>
                <b style={{ color: audit.brought - audit.declared > 0 ? 'var(--blood)' : 'var(--green)' }}>
                  {money(audit.brought - audit.declared)}
                </b>
              </div>
            </div>
          )}
          {auditable.length === 0 ? (
            <Empty>Nobody handles your money yet.</Empty>
          ) : (
            auditable.map((p) => (
              <button
                key={p.id}
                className="list-row"
                disabled={!!reservation && reservation.state !== 'queued'}
                onClick={() => useGame.getState().beginSpecialistOrder('audit', p.id)}
              >
                <span className="name tiny">{p.name}</span>
                {w.auditTargets[gang.id] === p.id && <Pill kind="warn">scheduled</Pill>}
              </button>
            ))
          )}
        </Panel>
      )}

      <SpecialistJobList role="accountant" />
      <Panel title="Bribed People">
        {peopleList(w).filter((p) => p.bribedBy === gang.id).length === 0 ? (
          <Empty>Nobody is on your hook.</Empty>
        ) : (
          Object.values(w.people)
            .filter((p) => p.bribedBy === gang.id)
            .slice(0, 20)
            .map((p) => (
              <div key={p.id} className="row between tiny" style={{ padding: '2px 0' }}>
                <span>{p.name}</span>
                <Pill>{p.role}</Pill>
              </div>
            ))
        )}
      </Panel>

      <Panel title="Employed Police">
        {gang.employedPoliceIds.length === 0 ? (
          <Empty>No officers on the payroll.</Empty>
        ) : (
          gang.employedPoliceIds
            .map((id) => w.people[id])
            .filter(Boolean)
            .map((p) => (
              <div key={p.id} className="row between" style={{ padding: '3px 0' }}>
                <span className="tiny">{p.name}</span>
                <div className="row" style={{ gap: 5 }}>
                  <span className="muted tiny mono">{money(p.weeklyRetainer)}/wk</span>
                  <button
                    className="btn sm danger"
                    onClick={() => notify(act((s) => dismissPoliceOfficer(s.world, gang.id, p.id))!)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
        )}
      </Panel>
    </div>
  );
}
