import { useState } from 'react';
import { act, useGame } from '../../app/store';
import { buySnitchInfo, setDiplomacy, snitchPrice } from '../../sim/api';
import { GANG_COLORS } from '../../sim/constants';
import { DIPLOMACY_ORDER, type DiplomacyLevel, type ID } from '../../sim/types';
import { gangAssets, gangManpower, money, powerRating, territoryCount } from '../../sim/world';
import { crestUrl } from '../art';
import { Empty, Hint, Icon, Panel, Pill } from '../common';

const LEVEL_LABEL: Record<DiplomacyLevel, string> = {
  alliance: 'Alliance',
  peace: 'Peace',
  ceasefire: 'Cease-Fire',
  aggression: 'Aggression',
  war: 'Gang Warfare',
};

const LEVEL_DESC: Record<DiplomacyLevel, string> = {
  alliance: 'Free passage through each other\'s streets. Delicate, and easily broken.',
  peace: 'Stable, but it cannot last once the others are gone.',
  ceasefire: 'Leave each other alone — but intruders on your patch are fair game.',
  aggression: 'Attack on sight. No deliberate plotting, but no consideration either.',
  war: 'Hits planned against each other\'s people and places. Territory means nothing now.',
};

export function DiplomacyTab() {
  const sim = useGame((s) => s.sim)!;
  const notify = useGame((s) => s.notify);
  const centreOnPerson = useGame((s) => s.centreOnPerson);
  useGame((s) => s.version);
  const [snitchTargets, setSnitchTargets] = useState<ID[]>([]);
  const [viewGang, setViewGang] = useState<ID | null>(null);

  const w = sim.world;
  const gang = sim.playerGang;
  const rivals = Object.values(w.gangs).filter((g) => g.id !== gang.id);
  const snitches = w.snitchIds.map((id) => w.people[id]).filter(Boolean);
  const usedThisWeek = gang.snitchUsedWeek === w.week;
  const price = snitchTargets.length ? snitchPrice(w, gang.id, snitchTargets) : 0;

  const viewed = viewGang != null ? w.gangs[viewGang] : null;
  const knownOfViewed =
    viewed != null
      ? gang.knownPeople
          .map((id) => w.people[id])
          .filter((p) => p && p.gangId === viewed.id && p.status !== 'dead')
      : [];

  return (
    <div>
      {rivals.map((r) => {
        const mine = gang.offered[r.id] ?? 'peace';
        const theirs = gang.known[r.id] ?? 'peace';
        const agreed = mine === theirs;
        return (
          <Panel key={r.id}>
            <div className="row between" style={{ marginBottom: 7 }}>
              <div className="row" style={{ gap: 8 }}>
                <img className="crest" src={crestUrl(r.color)} alt="" draggable={false} />
                <b>{r.name}</b>
                {r.eliminated && <Pill kind="bad">wiped out</Pill>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className="muted tiny">power {powerRating(w, r)}</span>
                <button className="btn sm" onClick={() => setViewGang(viewGang === r.id ? null : r.id)}>
                  Details
                </button>
              </div>
            </div>

            {!r.eliminated && (
              <>
                <div className="row" style={{ gap: 3 }}>
                  {DIPLOMACY_ORDER.map((lvl) => (
                    <button
                      key={lvl}
                      className={`btn sm${mine === lvl ? ' on' : ''}`}
                      style={{ flex: 1, fontSize: 10, padding: '4px 2px' }}
                      onClick={() => notify(act((s) => setDiplomacy(s.world, gang.id, r.id, lvl))!)}
                      title={LEVEL_DESC[lvl]}
                    >
                      <Icon name={`diplomacy/${lvl}`} size={12} /> {LEVEL_LABEL[lvl]}
                    </button>
                  ))}
                </div>
                <div className="row between tiny" style={{ marginTop: 5 }}>
                  <span className="muted">
                    You offer <b>{LEVEL_LABEL[mine]}</b>
                  </span>
                  <span className="muted">
                    They last offered <b style={{ color: GANG_COLORS[r.color].light }}>{LEVEL_LABEL[theirs]}</b>
                  </span>
                </div>
                {!agreed && (
                  <div className="muted tiny" style={{ marginTop: 3 }}>
                    You are not in agreement. Their view of you always runs a week behind the street.
                  </div>
                )}
              </>
            )}
          </Panel>
        );
      })}

      {viewed && (
        <Panel
          title={`${viewed.name} — What You Know`}
          right={
            <button className="btn sm" onClick={() => setViewGang(null)}>
              ×
            </button>
          }
        >
          <div className="kv">
            <span>Territory</span>
            <b>{territoryCount(w, viewed.id)} blocks</b>
          </div>
          <div className="kv">
            <span>Manpower</span>
            <b>{gangManpower(w, viewed)}</b>
          </div>
          <div className="kv">
            <span>Estimated assets</span>
            <b>{money(gangAssets(w, viewed))}</b>
          </div>
          <div className="kv">
            <span>Temperament</span>
            <b>{viewed.personality}</b>
          </div>
          <div style={{ marginTop: 8 }}>
            <b className="tiny">People you have identified ({knownOfViewed.length})</b>
            {knownOfViewed.length === 0 ? (
              <Empty>None. Explore their streets, take a prisoner, or buy from a snitch.</Empty>
            ) : (
              <div className="scroll-list" style={{ maxHeight: 160 }}>
                {knownOfViewed.map((p) => (
                  <button
                    key={p.id}
                    className="list-row"
                    onClick={() => centreOnPerson(p.id)}
                  >
                    <span className="name tiny">{p.name}</span>
                    <span className="muted tiny">{p.role}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Panel>
      )}

      <Panel title="Snitches">
        <Hint>
          One snitch a week, no more. They sell names, never places — and they never name anybody you
          already know.
        </Hint>
        <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
          {rivals.map((r) => (
            <button
              key={r.id}
              className={`btn sm${snitchTargets.includes(r.id) ? ' on' : ''}`}
              onClick={() =>
                setSnitchTargets(
                  snitchTargets.includes(r.id)
                    ? snitchTargets.filter((x) => x !== r.id)
                    : [...snitchTargets, r.id],
                )
              }
            >
              {r.name}
            </button>
          ))}
          <button
            className={`btn sm${snitchTargets.includes(0) ? ' on' : ''}`}
            onClick={() =>
              setSnitchTargets(
                snitchTargets.includes(0) ? snitchTargets.filter((x) => x !== 0) : [...snitchTargets, 0],
              )
            }
          >
            Unaffiliated
          </button>
        </div>
        {snitchTargets.length > 0 && (
          <div className="row between tiny" style={{ marginBottom: 6 }}>
            <span className="muted">Asking price</span>
            <b className="mono">{money(price)}</b>
          </div>
        )}
        {snitches.map((s) => (
          <div key={s.id} className="row between" style={{ padding: '3px 0' }}>
            <span className="tiny">{s.name}</span>
            <button
              className="btn sm"
              disabled={usedThisWeek || snitchTargets.length === 0}
              onClick={() =>
                notify(act((sm) => buySnitchInfo(sm.world, sm.rng, gang.id, s.id, snitchTargets))!)
              }
            >
              {usedThisWeek ? 'Used this week' : 'Buy'}
            </button>
          </div>
        ))}
      </Panel>
    </div>
  );
}
