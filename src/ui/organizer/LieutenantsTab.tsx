import { useEffect, useState } from 'react';
import { act, useGame } from '../../app/store';
import {
  assaultPrisoner,
  cancelOrder,
  demote,
  interrogatePrisoner,
  killMember,
  killPrisoner,
  releasePrisoner,
  repeatOrder,
  sackPerson,
} from '../../sim/api';
import { MINUTES_PER_WEEK, ORDERS, ORDER_GROUPS } from '../../sim/constants';
import type { ID, Order, Team, WorldState } from '../../sim/types';
import { buildingName, money } from '../../sim/world';
import { ConfirmDialog, Dial, Empty, Hint, Icon, Kicker, Pill, SkillList, Stamp } from '../common';
import { Portrait } from '../Portrait';
import { resourceDragProps, useResourceDrop } from '../resourceDrag';
import { Advisor } from './Advisor';
import { ABSENT, PayRoll, hours } from './RightSheet';

type Mode = 'orders' | 'reports';

const GROUP_BLURB: Record<(typeof ORDER_GROUPS)[number]['id'], string> = {
  business: 'Collect protection, buy premises, run businesses',
  personnel: 'Recruit, patrol, guard, explore',
  minor: 'Extort, intimidate, raid, kidnap',
  violent: 'Assault, smash up, arson, bombing',
};

function describeTargets(o: Order, w: WorldState): string {
  if (o.targetPersonId != null) return w.people[o.targetPersonId]?.name ?? 'somebody';
  if (o.targetBuildingIds.length === 1) return buildingName(w, o.targetBuildingIds[0]);
  if (o.targetBlockIds.length === 1) {
    const b = w.blocks[o.targetBlockIds[0]];
    return b ? `block ${b.gx},${b.gy}` : 'a block';
  }
  if (o.targetBlockIds.length) return `${o.targetBlockIds.length} blocks`;
  if (o.targetBuildingIds.length) return `${o.targetBuildingIds.length} sites`;
  return 'a place';
}

/**
 * The original's This Week's Orders rolodex (manual pp.15, 41; Deep26 §3.10b):
 * every person given an order this week, what the order is and its target,
 * stepped with Previous/Next while the map highlights the order's area.
 */
function OrdersRolodex() {
  const sim = useGame((s) => s.sim);
  useGame((s) => s.version);
  const reviewOrderId = useGame((s) => s.reviewOrderId);
  const setReviewOrder = useGame((s) => s.setReviewOrder);
  const [index, setIndex] = useState(0);
  useEffect(() => () => setReviewOrder(null), [setReviewOrder]);
  if (!sim) return null;
  const w = sim.world, gang = sim.playerGang;
  const orders = gang.teamIds.flatMap(id => w.teams[id]?.orderIds ?? []).map(id => w.orders[id])
    .filter((o): o is Order => !!o && o.state === 'queued');
  if (!orders.length) return null;
  const at = Math.min(index, orders.length - 1), o = orders[at];
  const team = w.teams[o.teamId], who = o.assignedIds.length
    ? o.assignedIds.map(id => w.people[id]?.name).filter(Boolean).join(', ')
    : `${w.people[team?.lieutenantId ?? -1]?.name ?? 'A crew'}'s crew`;
  const show = (i: number) => { const next = (i + orders.length) % orders.length; setIndex(next); setReviewOrder(orders[next].id); };
  return (
    <div className="orders-rolodex" role="region" aria-label="This week's orders">
      <Kicker style={{ marginBottom: 4 }}>This week's orders · {at + 1} of {orders.length}</Kicker>
      <div className="row between" style={{ gap: 6 }}>
        <button className="btn sm" aria-label="Previous order" onClick={() => show(at - 1)}>‹</button>
        <button className={`btn sm${reviewOrderId === o.id ? ' on' : ''}`} style={{ flex: 1, textAlign: 'left' }}
          title="Show this order's area on the map" onClick={() => setReviewOrder(reviewOrderId === o.id ? null : o.id)}>
          <Icon name={`orders/${o.type}`} size={14} /> <b style={{ fontWeight: 500 }}>{who}</b> · {ORDERS[o.type].name} · {describeTargets(o, w)}
        </button>
        <button className="btn sm" aria-label="Next order" onClick={() => show(at + 1)}>›</button>
      </div>
    </div>
  );
}

/**
 * The Lieutenants Section, laid out as the original's manual describes it: the
 * Team Details Panel at the top of the page, the Reports Panel below it (which
 * becomes the Orders Panel), the Lieutenant Tabs down the edge of the journal
 * and the Right Panel and the map beside it.
 */
export function LieutenantsTab() {
  const sim = useGame((s) => s.sim)!;
  useEffect(() => { useGame.getState().recordTutorialVisit('lieutenantsViewed'); }, [sim]);
  const selectedTeamId = useGame((s) => s.selectedTeamId);
  const setSheet = useGame((s) => s.setSheet);
  const sheet = useGame((s) => s.sheet);
  const notify = useGame((s) => s.notify);
  const setCollapsed = useGame((s) => s.setOrganizerCollapsed);
  const pickMode = useGame((s) => s.pickMode);
  const beginOrder = useGame((s) => s.beginOrder);
  const updateJobCard = useGame((s) => s.updateJobCard);
  useGame((s) => s.version);

  const [mode, setMode] = useState<Mode>('orders');
  const [showSkills, setShowSkills] = useState(false);
  const [teamDetailsOpen, setTeamDetailsOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; go: () => void } | null>(null);

  const w = sim.world;
  const gang = sim.playerGang;
  const teams = gang.teamIds.map((id) => w.teams[id]).filter(Boolean);
  // The selected team may have been disbanded or lost its lieutenant during
  // the week, so always fall back to one that still exists.
  const team = (selectedTeamId != null ? w.teams[selectedTeamId] : undefined) ?? teams[0];
  const [dropProps, dropOver] = useResourceDrop(team ? { kind: 'team', teamId: team.id } : null);

  if (!team) {
    return (
      <div>
        <Advisor />
        <Hint>
          You have no lieutenants, so you cannot give a single order. Promote somebody from the pool, or take on a
          new lieutenant from the people willing to work.
        </Hint>
        <div className="team-buttons">
          <button className="btn brass" onClick={() => setSheet({ kind: 'hoods' })}>
            The pool · {gang.poolIds.length}
          </button>
          <button className="btn" onClick={() => setSheet({ kind: 'recruits' })}>
            Recruitment · {gang.recruitIds.length}
          </button>
        </div>
      </div>
    );
  }

  const lt = w.people[team.lieutenantId];
  const timePct = (team.timeUsed / MINUTES_PER_WEEK) * 100;
  const members = team.memberIds.map((id) => w.people[id]).filter(Boolean);
  const guns = Object.entries(team.weapons).reduce((s, [id, n]) => s + (id === 'explosives' ? 0 : n), 0);
  const cars = Object.values(team.vehicles).reduce((s, n) => s + n, 0);
  const orders = team.orderIds.map((id) => w.orders[id]).filter(Boolean);

  const rename = (name: string) =>
    act((s) => {
      const t = s.world.teams[team.id];
      if (t) t.name = name.slice(0, 24);
    });

  /** Re-open a confirmed order on a job card, as the original's Edit Order did. */
  const editOrder = (o: Order) => {
    beginOrder(o.type, o.teamId);
    updateJobCard({
      editingOrderId: o.id,
      buildingIds: o.targetBuildingIds.filter(id => !o.targetBlockIds.includes(w.buildings[id]?.blockId)),
      blockIds: [...o.targetBlockIds],
      personId: o.targetPersonId,
      pos: o.targetPos,
      // A preferred hood who has since left the crew could not be cleared on the card.
      opts: { ...o.opts, preferredHoodId: o.opts.preferredHoodId != null && w.teams[o.teamId]?.memberIds.includes(o.opts.preferredHoodId)
        ? o.opts.preferredHoodId : null },
    });
  };

  return (
    <div className="lieutenant-planning">
      {/* ------------------------------------------------ team details panel */}
      {lt && (
        <section className={`team-panel${dropOver ? ' drop-over' : ''}`} aria-label="Selected lieutenant" {...dropProps}>
          <input aria-label="Crew name" className="team-name" value={team.name} onChange={(e) => rename(e.target.value)} title="Click to rename the team" spellCheck={false} />
          <div className="team-head">
            <div className="avatar">
              <Portrait person={lt} gang={gang} size={64} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <h3 className={lt.pay < lt.payDemand ? 'unhappy' : ''}>{lt.name}</h3>
                <Dial pct={timePct} size={36} />
              </div>
              <div className="counters">
                <span title="The lieutenant leads this crew; the hoods serve under them">
                  <Icon name="groups/personnel" size={16} />
                  1 lieutenant + <b>{members.length}</b> {members.length === 1 ? 'hood' : 'hoods'}
                </span>
                <span title="Weapons in the team's possession">
                  <Icon name="skills/firearms" size={16} />
                  <b>{guns}</b> {guns === 1 ? 'weapon' : 'weapons'}
                </span>
                <span title="Vehicles at the team's disposal">
                  <Icon name="vehicles/coupe" size={16} />
                  <b>{cars}</b> {cars === 1 ? 'vehicle' : 'vehicles'}
                </span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <span className={`tag ${lt.loyalty > 60 ? 'good' : lt.loyalty > 30 ? 'warn' : 'bad'}`}>Loyalty {Math.round(lt.loyalty)}</span>
                <span className="tag">Wanted {Math.round(lt.wanted)}</span>
                {lt.status !== 'active' && (
                  <span className="tag bad">
                    <Icon name={`status/${lt.status}`} size={12} /> {ABSENT[lt.status] ?? lt.status}
                  </span>
                )}
              </div>
            </div>
            <div className={`pay-lines${lt.pay < lt.payDemand ? ' unhappy' : ''}`}>
              <Kicker>Wants {money(lt.payDemand)}</Kicker>
              <b>{money(lt.pay)}</b>
              <Kicker>a week</Kicker>
            </div>
          </div>

          {payOpen && <PayRoll person={lt} onClose={() => setPayOpen(false)} />}

          <div className="team-buttons">
            <button className="btn" onClick={() => setConfirm({ text: `Sack ${lt.name}? The team goes back to the pool, and he goes back on the street with a grudge.`, go: () => notify(act((s) => sackPerson(s.world, gang.id, lt.id))!) })}>
              Sack
            </button>
            <button className="btn danger" onClick={() => setConfirm({ text: `Have ${lt.name} killed? The police will not look into it, but your other lieutenants will want more money.`, go: () => notify(act((s) => killMember(s.world, gang.id, lt.id))!) })}>
              Kill
            </button>
            <button className="btn" title="Send the lieutenant and the team back to the pool" onClick={() => setConfirm({ text: `Demote ${lt.name}? His crew goes back to the pool, its orders are cancelled, and its weapons and cars go back to the cache.`, go: () => notify(act((s) => demote(s.world, gang.id, team.id))!) })}>
              Demote
            </button>
            <button aria-pressed={showSkills} className={`btn${showSkills ? ' on' : ''}`} onClick={() => { setShowSkills(!showSkills); setTeamDetailsOpen(true); }} title="Swap the paper between the team and the lieutenant's skills">
              {showSkills ? 'Team' : 'Attributes'}
            </button>
            <button aria-expanded={payOpen} className={`btn${payOpen ? ' on' : ''}`} onClick={() => setPayOpen(!payOpen)}>
              Pay
            </button>
            <button
              className={`btn${pickMode?.kind === 'lieutenantArea' ? ' on' : ''}`}
              onClick={() => {
                const on = pickMode?.kind === 'lieutenantArea';
                useGame.getState().selectTeam(team.id);
                useGame.getState().toggleOverlay('lieutenant');
                setCollapsed(!on);
              }}
            >
              <Icon name="overlays/lieutenant" size={14} /> {pickMode?.kind === 'lieutenantArea' ? 'Done' : `Territory · ${team.allocatedBlockIds.length}`}
            </button>
          </div>

          <details className="team-roster" open={teamDetailsOpen} onToggle={e => setTeamDetailsOpen(e.currentTarget.open)}>
            <summary>{showSkills ? 'Lieutenant attributes' : `Crew · ${members.length+1} people · view ${members.length} hood${members.length===1?'':'s'}`}{members.some(m => m.status !== 'active') && ' · members absent'}</summary>
          <div className="paper-strip" tabIndex={0} role="region" aria-label={showSkills ? "Lieutenant attributes" : "Team members"}>
            {showSkills ? (
              <>
                <Kicker style={{ marginBottom: 6 }}>{lt.name}'s attributes</Kicker>
                <SkillList skills={lt.skills} columns={2} />
              </>
            ) : (
              <>
                <Kicker style={{ marginBottom: 4 }}>
                  {team.name} · {members.length} hood{members.length === 1 ? '' : 's'}
                </Kicker>
                {members.length === 0 ? (
                  <Empty>Nobody yet. Open the pool and send some hoods across.</Empty>
                ) : (
                  members.map((m) => {
                    const absent = ABSENT[m.status];
                    const job = orders.find((o) => o.opts.preferredHoodId === m.id || o.assignedIds.includes(m.id));
                    return (
                      <button
                        key={m.id}
                        className={`row-line${m.pay < m.payDemand ? ' unhappy' : ''}`}
                        onClick={() => setSheet(sheet?.kind === 'person' && sheet.id === m.id ? null : { kind: 'person', id: m.id })}
                        {...resourceDragProps({ kind: 'hood', id: m.id })}
                        title="Click for his details; drag onto another lieutenant or the pool to move him"
                      >
                        <span className="nm">{m.name}</span>
                        <span className="st">
                          {absent ? (
                            <>
                              <Icon name={`status/${m.status}`} size={13} /> {absent}
                            </>
                          ) : job ? (
                            ORDERS[job.type].name
                          ) : (
                            money(m.pay)
                          )}
                          {absent && (m.status === 'kidnapped' ? ' · tied to a chair' : m.status === 'arrested' || m.status === 'onTrial' ? ' · behind bars' : '')}
                        </span>
                      </button>
                    );
                  })
                )}
              </>
            )}
          </div>
          </details>
        </section>
      )}

      {/* ------------------------------------------------ reports / orders panel */}
      <section className="list-box planning-orders" aria-label="Weekly orders and reports">
        <div className="lb-head">
          <div className="sub-tabs">
            <button aria-pressed={mode === 'orders'} className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>
              Orders
            </button>
            <button aria-pressed={mode === 'reports'} className={mode === 'reports' ? 'on' : ''} onClick={() => setMode('reports')}>
              Reports
            </button>
          </div>
          <span className="planning-time">{Math.round(timePct)}% of this crew’s week assigned</span>
        </div>
        <div className="lb-body">
          {mode === 'orders' ? (
            <>
              <p className="order-instruction">Choose an order group, then an order and its map target.</p>
              <div className="planning-groups">
                {ORDER_GROUPS.map((g) => (
                  <button key={g.id} aria-pressed={sheet?.kind === 'orders' && sheet.group === g.id} className={`group-btn${sheet?.kind === 'orders' && sheet.group === g.id ? ' on' : ''}`} onClick={() => setSheet({ kind: 'orders', group: g.id })}>
                    <span className="gb-name">
                      <Icon name={`groups/${g.id}`} size={20} /> {g.name}
                    </span>
                    <span className="gb-description">{GROUP_BLURB[g.id]}</span>
                  </button>
                ))}
              </div>
              {orders.length === 0 && <p className="orders-empty">No orders for this crew yet.</p>}
              {orders.length > 0 && (
                <div className="queued-orders" tabIndex={0} role="region" aria-label="This week's orders">
                  <Kicker style={{ marginBottom: 4 }}>
                    This week · {orders.length} order{orders.length === 1 ? '' : 's'}
                  </Kicker>
                  {orders.map((o) => (
                    <div key={o.id} className="row between report-item">
                      <span>
                        <Icon name={`orders/${o.type}`} size={15} /> <b style={{ fontWeight: 500 }}>{ORDERS[o.type].name}</b> · {describeTargets(o, w)}
                        {o.opts.manpower > 1 && ` · ${o.opts.manpower} men`}
                        {o.opts.repeat && ' · repeats'}
                        {o.opts.priority && ' · priority'}
                        {o.opts.wait && ' · waits'}
                        <span className="muted"> · {hours(o.estimatedMinutes)}</span>
                        {o.dispatchWaitReason && <span className="muted"> · Queued: {o.dispatchWaitReason}</span>}
                      </span>
                      <span className="row" style={{ gap: 4 }}>
                        <button className="btn sm" onClick={() => editOrder(o)} title="Open the job card again">
                          Edit
                        </button>
                        <button className="btn sm red-text" aria-label={`Cancel ${ORDERS[o.type].name}`} onClick={() => notify(act((s) => cancelOrder(s.world, o.id))!)} title="Cancel this order">
                          ×
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <OrdersRolodex />
              <ReportsPanel teamId={team.id} />
            </>
          )}
        </div>
        <div className="lb-foot">
          <button title="Clipboard (C)" className={`btn sm${sheet?.kind === 'clipboard' ? ' on' : ''}`} onClick={() => setSheet(sheet?.kind === 'clipboard' ? null : { kind: 'clipboard' })}>
            Clipboard
          </button>
          <span style={{ flex: 1 }} />
          <button title="Hoods (H)" className={`btn sm${sheet?.kind === 'hoods' ? ' on' : ''}`} onClick={() => setSheet({ kind: 'hoods' })}>
            <Icon name="groups/personnel" size={13} /> Hoods · {gang.poolIds.length}
          </button>
          <button title="Weapons (W)" className={`btn sm${sheet?.kind === 'weapons' ? ' on' : ''}`} onClick={() => setSheet({ kind: 'weapons' })}>
            <Icon name="weapons/pistol" size={13} /> Weapons
          </button>
          <button title="Vehicles (V)" className={`btn sm${sheet?.kind === 'vehicles' ? ' on' : ''}`} onClick={() => setSheet({ kind: 'vehicles' })}>
            <Icon name="vehicles/coupe" size={13} /> Vehicles
          </button>
          <button className={`btn sm${sheet?.kind === 'recruits' ? ' on' : ''}`} onClick={() => setSheet({ kind: 'recruits' })}>
            <Icon name="orders/recruit" size={13} /> Recruitment · {gang.recruitIds.length}
          </button>
        </div>
      </section>

      <Advisor compact />

      {confirm && (
        <ConfirmDialog
          text={confirm.text}
          onYes={() => {
            confirm.go();
            setConfirm(null);
          }}
          onNo={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** The Lieutenant Tabs down the left edge of the journal: one per team, eight at most. */
export function LieutenantStrip() {
  const sim = useGame((s) => s.sim)!;
  const selectedTeamId = useGame((s) => s.selectedTeamId);
  const selectTeam = useGame((s) => s.selectTeam);
  const setSheet = useGame((s) => s.setSheet);
  useGame((s) => s.version);
  const w = sim.world;
  const gang = sim.playerGang;
  const teams: (Team | undefined)[] = gang.teamIds.map((id) => w.teams[id]);
  const selected = (selectedTeamId != null ? w.teams[selectedTeamId] : undefined) ?? teams[0];

  const slots = [];
  for (let i = 0; i < 8; i++) {
    const t = teams[i];
    if (!t) {
      slots.push(
        <button key={`e${i}`} className="lt-tab empty" title="A free tab — promote a hood to fill it" onClick={() => setSheet({ kind: 'hoods' })}>
          {i + 1}
        </button>,
      );
      continue;
    }
    slots.push(<LieutenantTab key={t.id} team={t} index={i} selected={selected?.id === t.id} onSelect={() => selectTeam(t.id)} />);
  }
  return <div className="lt-strip">{slots}</div>;
}

/** One lieutenant's tab; hoods, weapons and vehicles dropped on it join that crew. */
function LieutenantTab({ team: t, index, selected, onSelect }: { team: Team; index: number; selected: boolean; onSelect: () => void }) {
  const sim = useGame((s) => s.sim)!;
  const [dropProps, dropOver] = useResourceDrop({ kind: 'team', teamId: t.id });
  const w = sim.world, gang = sim.playerGang;
  const lt = w.people[t.lieutenantId];
  const pct = Math.round((t.timeUsed / MINUTES_PER_WEEK) * 100);
  return (
    <button
      aria-pressed={selected} className={`lt-tab${selected ? ' on' : ''}${lt && lt.status !== 'active' ? ' absent' : ''}${dropOver ? ' drop-over' : ''}`}
      title={`${lt?.name ?? 'Vacant'} — ${t.name}${pct ? ` · ${pct}% of the week allocated` : ''}`}
      onClick={onSelect}
      {...dropProps}
    >
      {lt && <Portrait person={lt} gang={gang} size={58} />}
      <span className="num">{index + 1}</span>
      {pct > 0 && <i className="mini-dial" style={{ ['--pct' as string]: pct }} />}
    </button>
  );
}

function ReportsPanel({ teamId }: { teamId: ID }) {
  const sim = useGame((s) => s.sim)!;
  useEffect(() => { useGame.getState().recordTutorialVisit('reportsViewed'); }, [sim, sim.world.week]);
  const notify = useGame((s) => s.notify);
  const centreOnPerson = useGame((s) => s.centreOnPerson);
  const w = sim.world;
  const gang = sim.playerGang;

  const results = w.lastWeekOrders.filter((o) => o.teamId === teamId);
  const prisoners = gang.prisonerIds.map((id) => w.people[id]).filter(Boolean);
  const deaths = w.weekLog;
  const seen = gang.knownPeople
    .map((id) => w.people[id])
    .filter((p) => p && p.status !== 'dead' && p.gangId != null && p.gangId !== gang.id)
    .slice(0, 12);

  return (
    <>
      <Kicker style={{ marginBottom: 4 }}>Last week's orders</Kicker>
      {results.length === 0 ? (
        <Empty>Nothing to report yet.</Empty>
      ) : (
        results.map((o) => (
          <div key={o.id} className="report-item" style={{ position: 'relative' }}>
            {o.state === 'done' && o.type === 'collectProtection' && <Stamp kind="paid" />}
            <div className="row between">
              <b>
                <Icon name={`orders/${o.type}`} size={14} /> {ORDERS[o.type].name}
              </b>
              <Pill kind={o.state === 'done' ? 'good' : 'bad'}>{o.state}</Pill>
            </div>
            {o.failReason && <div className="muted">{o.failReason}</div>}
            {o.results.map((r, i) => (
              <div key={i} className="tiny" style={{ marginTop: 2 }}>
                · {r}
              </div>
            ))}
            {/* A Repeat order is already back on the books for this week. */}
            {w.orders[o.id]?.state === 'queued' ? (
              <div className="muted tiny" style={{ marginTop: 6 }}>Repeats this week.</div>
            ) : (
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => notify(act((s) => repeatOrder(s.world, s.playerGang.id, o))!)}>
                Repeat order
              </button>
            )}
          </div>
        ))
      )}

      {prisoners.length > 0 && (
        <>
          <Kicker style={{ margin: '12px 0 4px' }}>Prisoners</Kicker>
          {prisoners.map((p) => (
            <div key={p.id} className="report-item">
              <div className="row between">
                <b>{p.name}</b>
                <span className="muted">will talk: {Math.round(p.interrogationValue)}%</span>
              </div>
              <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                <button className="btn sm" onClick={() => notify(act((s) => interrogatePrisoner(s.world, s.rng, gang.id, p.id))!)}>
                  Interrogate
                </button>
                <button className="btn sm" onClick={() => notify(act((s) => assaultPrisoner(s.world, s.rng, gang.id, p.id))!)}>
                  Assault
                </button>
                <button className="btn sm danger" onClick={() => notify(act((s) => killPrisoner(s.world, gang.id, p.id))!)}>
                  Kill
                </button>
                <button className="btn sm" onClick={() => notify(act((s) => releasePrisoner(s.world, gang.id, p.id))!)}>
                  Release
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <Kicker style={{ margin: '12px 0 4px' }}>Deaths & defections</Kicker>
      {deaths.length === 0 ? (
        <Empty>A quiet week.</Empty>
      ) : (
        <div className="scroll-list" style={{ maxHeight: 160 }}>
          {deaths.map((d, i) => (
            <div key={i} className="tiny" style={{ padding: '2px 0' }}>
              · {d}
            </div>
          ))}
        </div>
      )}

      <Kicker style={{ margin: '12px 0 4px' }}>Other gangs seen</Kicker>
      {seen.length === 0 ? (
        <Empty>You know nothing of your rivals' people. Explore, or buy from a snitch.</Empty>
      ) : (
        seen.map((p) => (
          <button key={p.id} className="list-row" onClick={() => centreOnPerson(p.id)}>
            <span className="name">{p.name}</span>
            <span className="muted">{w.gangs[p.gangId!]?.name}</span>
          </button>
        ))
      )}
    </>
  );
}
