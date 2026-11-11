import { useGame } from '../../app/store';
import { GO_STRAIGHT_ASSETS } from '../../sim/constants';
import type { WorldState } from '../../sim/types';
import {
  allBuildings,
  buildingsOfBlock,
  gangAssets,
  gangManpower,
  money,
  ownedBuildings,
  protectedBuildings,
  territoryCount,
} from '../../sim/world';
import { art } from '../art';
import { Kicker } from '../common';

interface Advice {
  urgency: 'urgent' | 'normal' | 'good';
  text: string;
}

/**
 * The consigliere: looks at the state of the empire and says the single most
 * useful thing the boss could do about it this week.
 */
export function adviseOn(w: WorldState, gangId: number): Advice[] {
  const gang = w.gangs[gangId];
  const out: Advice[] = [];
  if (!gang) return out;

  const racket = protectedBuildings(w, gangId);
  const owned = ownedBuildings(w, gangId);
  const men = gangManpower(w, gang);
  const teams = gang.teamIds.length;
  const wageBill = Object.values(w.people)
    .filter((p) => p.gangId === gangId && p.role !== 'boss' && p.status !== 'dead')
    .reduce((s, p) => s + p.pay, 0);

  // ---- things that will end your career
  if (teams === 0) {
    out.push({
      urgency: 'urgent',
      text: 'You have no crew. Promote somebody from the pool, or hire a lieutenant from the Recruits list — without one you cannot give a single order.',
    });
  }
  if (gang.cash < wageBill && wageBill > 0) {
    out.push({
      urgency: 'urgent',
      text: `Your wage bill is ${money(wageBill)} and you have ${money(gang.cash)}. Collect what you are owed, or your people will start walking out.`,
    });
  }
  if (gang.suspicion > 65) {
    out.push({
      urgency: 'urgent',
      text: 'The Bureau is close. Buy legal businesses to soak up the money you cannot explain, or stop your illegal sites trading for a week.',
    });
  }
  // Guns in the cache arm nobody in a crew: say so before an unarmed crew is sent out.
  const spare = Object.entries(gang.weapons).reduce((n, [id, count]) => n + (id === 'explosives' ? 0 : count), 0);
  const unarmed = gang.teamIds.map((id) => w.teams[id]).find((t) => t &&
    Object.entries(t.weapons).every(([id, count]) => id === 'explosives' || !count));
  if (spare > 0 && unarmed) {
    out.push({
      urgency: 'normal',
      text: `${w.people[unarmed.lieutenantId]?.name ?? 'A lieutenant'}'s crew carries no guns, and there ${spare === 1 ? 'is one' : `are ${spare}`} in the cache. Open Weapons and send some across (→ Team) before they go out.`,
    });
  }
  const inTrouble = Object.values(w.cases).filter(
    (c) => c.gangId === gangId && (c.status === 'awaiting' || c.status === 'onTrial'),
  );
  if (inTrouble.length && !gang.lawyerId) {
    out.push({
      urgency: 'urgent',
      text: `${inTrouble.length === 1 ? 'One of your people faces' : `${inTrouble.length} of your people face`} trial with no lawyer. Send a hood to Recruit at a law office or the courthouse.`,
    });
  }

  // ---- the ordinary business of getting rich
  if (racket.length === 0) {
    out.push({
      urgency: 'normal',
      text: 'Start a protection racket. Give a crew the Extort order and click a block near your office — a whole block at a time is how turf is won.',
    });
  } else {
    const collecting = Object.values(w.orders).some(
      (o) => o.gangId === gangId && o.type === 'collectProtection',
    );
    if (!collecting) {
      out.push({
        urgency: 'normal',
        text: `Collect Protection from ${racket.length} site${racket.length === 1 ? '' : 's'}, with Repeat, so you never have to ask again.`,
      });
    }
  }

  if (men < 6 && gang.cash > 2000) {
    out.push({
      urgency: 'normal',
      text: 'You are short of men. Send somebody to Recruit at a gym, pool hall, the docks or the labour exchange.',
    });
  }

  // ---- the money behind the money
  const centreLots = owned.filter((b) => b.cls === 'empty' && w.lots[b.lotId].index === 4);
  const readyToOpen = centreLots.find((land) =>
    buildingsOfBlock(w, w.blocks[land.blockId]).some(
      (b) => b.ownerGangId === gangId && b.cls !== 'illegal' && b.cls !== 'empty' && b.hidesId == null,
    ),
  );
  if (readyToOpen) {
    out.push({
      urgency: 'good',
      text: 'A centre lot with a front is ready for Set Up Business — an illegal site earns many times what the shop in front of it does.',
    });
  } else if (gang.cash > 15000 && !owned.some((b) => b.cls === 'illegal' && b.typeId !== 'office')) {
    out.push({
      urgency: 'good',
      text: 'You can afford to go into business properly: buy a legal site on a block, then buy the empty centre lot behind it and open something illegal there.',
    });
  }

  if (!gang.accountantId && gang.cash > 5000) {
    out.push({
      urgency: 'normal',
      text: 'Hire an accountant. Without one, almost every illegal dollar you earn goes onto the Bureau’s ledger as risky money.',
    });
  }

  const speakeasies = owned.filter((b) => b.typeId === 'speakeasy');
  const stills = owned.filter((b) => b.typeId === 'moonshineStill');
  if (speakeasies.length && !stills.length) {
    out.push({
      urgency: 'normal',
      text: 'Your speakeasy needs liquor. A moonshine still behind a drug store or plumbers will keep the bar supplied.',
    });
  }

  const refusing = racket.filter((b) => b.protection?.refusing);
  if (refusing.length) {
    out.push({
      urgency: 'normal',
      text: `${refusing.length} owner${refusing.length === 1 ? ' has' : 's have'} stopped paying. Intimidate them before they go to the police.`,
    });
  }

  const damaged = owned.filter((b) => b.state === 'damaged');
  if (damaged.length) {
    out.push({
      urgency: 'normal',
      text: `${damaged.length} of your sites ${damaged.length === 1 ? 'is' : 'are'} wrecked and earning nothing. Repair or sell ${damaged.length === 1 ? 'it' : 'them'}.`,
    });
  }

  const unmanaged = owned.filter((b) => b.cls !== 'empty' && b.managerId == null && b.state === 'trading');
  if (unmanaged.length) {
    out.push({
      urgency: 'normal',
      text: `${unmanaged.length} of your businesses ${unmanaged.length === 1 ? 'has' : 'have'} nobody minding the till. Give a crew the Run Business order.`,
    });
  }

  // ---- the endgame
  const assets = gangAssets(w, gang);
  if (assets > GO_STRAIGHT_ASSETS * 0.75 && w.options.mode === 'normal') {
    out.push({
      urgency: 'good',
      text: `You hold ${money(assets)}. Close your illegal sites, clear the courts and your lawyer can take you straight.`,
    });
  }
  if (w.election.active) {
    out.push({
      urgency: 'good',
      text: `An election is under way — ${w.election.weeksLeft} week${w.election.weeksLeft === 1 ? '' : 's'} to polling. You hold ${territoryCount(w, gangId)} blocks. Donate, patrol and keep the protection light if you mean to stand.`,
    });
  }

  const rivalOffices = allBuildings(w).filter(
    (b) =>
      b.isHQ && b.ownerGangId != null && b.ownerGangId !== gangId && (b.knowledge[gangId] ?? 0) >= 3,
  );
  const atWar = Object.values(w.gangs).some(
    (g) => g.id !== gangId && (gang.offered[g.id] === 'war' || gang.offered[g.id] === 'aggression'),
  );
  if (atWar && !rivalOffices.length) {
    out.push({
      urgency: 'normal',
      text: 'You are at war but do not know where your enemy lives. Explore their streets, or take a prisoner and make him talk.',
    });
  }

  return out;
}

/** Optional guidance; urgent advice is expanded so a warning cannot be missed. */
export function Advisor({ compact = false }: { compact?: boolean }) {
  const sim = useGame((s) => s.sim)!;
  useGame((s) => s.version);
  const advice = adviseOn(sim.world, sim.playerGang.id);

  const order = { urgent: 0, normal: 1, good: 2 };
  const sorted = [...advice].sort((a, b) => order[a.urgency] - order[b.urgency]);
  const lead = sorted[0];
  const more = sorted.slice(1, 3);

  const note = (
    <div className={`consigliere${lead?.urgency === 'urgent' ? ' urgent' : ''}`}>
      <img className="consig-face" src={art('portraits/consigliere.png')} alt="" draggable={false} />
      <div style={{ minWidth: 0 }}>
        <Kicker style={{ marginBottom: 6 }}>Consigliere</Kicker>
        <div className="lead">{lead ? lead.text : 'The books balance and the streets are quiet. Take a block while they are.'}</div>
        {more.length > 0 && <div className="more">Then: {more.map((a) => a.text).join(' ')}</div>}
      </div>
    </div>
  );
  return compact ? (
    <details className="planning-advice" key={lead?.urgency} open={lead?.urgency === 'urgent' ? true : undefined}>
      <summary>{lead?.urgency === 'urgent' ? 'Consigliere · needs attention' : 'Advice from your consigliere'}</summary>
      {note}
    </details>
  ) : note;
}
