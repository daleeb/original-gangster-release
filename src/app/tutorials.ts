import type { Building, GameOptions, WorldState } from '../sim/types';
import { allBuildings, ownedBuildings } from '../sim/world';
import { peopleList } from '../sim/entityLists';

/**
 * The four tutorials: each is a quiet city and a checklist of things to do,
 * ticked off by watching the world, as the original's four scripted lessons
 * walked a new boss through the game. Nothing is scripted for you — you do
 * each step yourself, and the card tells you what comes next. A step's test
 * need only hold at the moment it is done: the card keeps it ticked after.
 */
export interface TutorialStep {
  text: string;
  hint: string;
  done: (w: WorldState, gangId: number) => boolean;
}

export interface Tutorial {
  id: number;
  name: string;
  blurb: string;
  steps: TutorialStep[];
  options: Partial<GameOptions>;
}

const hasOrder = (w: WorldState, gangId: number, types: string[]) =>
  [...Object.values(w.orders), ...w.lastWeekOrders].some((o) => o.gangId === gangId && types.includes(o.type) && o.state !== 'cancelled' && o.state !== 'failed');

/** Lesson 4's violent-order step (index 3) was ticked, whatever became of the order. */
const warDeclared = (w: WorldState) => w.tutorialProgress?.lessonId === 4 && w.tutorialProgress.completed.includes(3);

const isLegalSite = (b: Building) => ['commercial', 'industrial', 'tenement', 'charity'].includes(b.cls) && b.state !== 'destroyed';
const hasSpecialist = (w: WorldState, g: number, role: 'lawyer' | 'accountant') => {
  const id = w.gangs[g]?.[role === 'lawyer' ? 'lawyerId' : 'accountantId'];
  const person = id != null ? w.people[id] : null;
  return !!person && person.gangId === g && person.role === role && person.status === 'active';
};

const QUIET: Partial<GameOptions> = { economy: 'strong', opponents: 'passive', citySize: 10, startMoney: 8000, startHoods: 6, startBusinesses: 3, mode: 'normal' };

export const TUTORIALS: Tutorial[] = [
  {
    id: 1,
    name: 'The Organizer',
    blurb: 'Where the week is planned: your lieutenants, their orders, and the clock.',
    options: { ...QUIET, seed: 101 },
    steps: [
      { text: 'Open the Lieutenants page and look at your crew', hint: 'F1, or the first tab of the journal. The dial beside the lieutenant fills as you give him work.', done: (w) => !!w.tutorialActions?.lieutenantsViewed },
      { text: 'Give the crew an Extort order on a nearby block', hint: 'Minor Crimes → Extort, then click a block on the plan. Shift-click takes a single site.', done: (w, g) => hasOrder(w, g, ['extort']) },
      { text: 'Hit the Streets and watch the week run', hint: 'The button at the foot of the journal. Speed the clock with > and slow it with <.', done: (w) => w.phase === 'week' || w.week > 1 },
      { text: 'See the week out', hint: 'Speed the clock up (the arrows beside it, or >). At maximum the week races by. Monday morning brings the newspaper and the reports.', done: (w) => w.week > 1 },
      { text: 'Read last week’s results on the Reports panel', hint: 'Lieutenants page → Reports. Refusers can be intimidated back into line.', done: (w) => !!w.tutorialActions?.reportsViewed },
    ],
  },
  {
    id: 2,
    name: 'Business',
    blurb: 'Premises, fronts and the illegal trade behind them.',
    options: { ...QUIET, seed: 202, startMoney: 12_000 },
    steps: [
      { text: 'Buy premises within two blocks of your territory', hint: 'Business Orders → Buy Premises, then click an unowned site. The land in the middle of a block is cheapest, but is only sold to you once you own a business in front of it.', done: (w, g) => hasOrder(w, g, ['buyPremises']) },
      { text: 'Own a second legal site', hint: 'The purchase completes during the week. Your sites are listed under City Maps → Controlled Businesses.', done: (w, g) => ownedBuildings(w, g).filter((b) => isLegalSite(b)).length >= 2 },
      { text: 'Own the centre lot of a block you have a legal front on', hint: 'Illegal businesses only fit the centre of a block, behind a legal site of yours on the same block. Your office already sits on one; this is about a second.', done: (w, g) => allBuildings(w).some((b) => b.ownerGangId === g && b.state !== 'destroyed' && w.lots[b.lotId]?.index === 4 && b.typeId !== 'office' && allBuildings(w).some(front => front.blockId === b.blockId && front.ownerGangId === g && isLegalSite(front) && front.state === 'trading' && (front.hidesId == null || front.hidesId === b.id))) },
      { text: 'Set up an illegal business behind the front', hint: 'Business Orders → Set Up Business on the centre lot. The closer the front matches, the better it hides.', done: (w, g) => allBuildings(w).some((b) => {
        const front = b.frontId != null ? w.buildings[b.frontId] : null;
        return b.ownerGangId === g && b.cls === 'illegal' && b.typeId !== 'office' && b.state === 'trading' &&
          !!front && front.ownerGangId === g && front.blockId === b.blockId && isLegalSite(front) && front.state === 'trading' && front.hidesId === b.id;
      }) },
      { text: 'Send a hood to collect protection', hint: 'Business Orders → Collect Protection, with Repeat so it happens every week.', done: (w, g) => hasOrder(w, g, ['collectProtection']) },
    ],
  },
  {
    id: 3,
    name: 'The Law',
    blurb: 'The lawyer, the accountant, and keeping your people out of court.',
    options: { ...QUIET, seed: 303, startMoney: 12_000 },
    steps: [
      { text: 'Recruit a lawyer', hint: 'Personnel → Recruit at a law office or the courthouse, then hire him from the Recruitment sheet.', done: (w, g) => hasSpecialist(w, g, 'lawyer') },
      { text: 'Bribe an official', hint: 'Lawyer page → Bribe Officials. A friendly judge throws cases out.', done: (w, g) => peopleList(w).some((p) => p.bribedBy === g && p.status !== 'dead' && ['police', 'policeChief', 'judge', 'da', 'mayor'].includes(p.role)) },
      { text: 'Put an officer on the payroll', hint: 'Lawyer page → Employ Police, by name or by marking an area for him to tour.', done: (w, g) => (w.gangs[g]?.employedPoliceIds ?? []).some(id => { const p = w.people[id]; return p?.role === 'police' && p.status === 'active' && p.employedBy === g; }) },
      { text: 'Recruit an accountant', hint: 'Personnel → Recruit at an accountancy or the main bank.', done: (w, g) => hasSpecialist(w, g, 'accountant') },
      { text: 'Turn on Evade Tax', hint: 'Accountant page. He hides what he can; what he cannot becomes risky money.', done: (w, g) => !!w.gangs[g]?.evadingTax && hasSpecialist(w, g, 'accountant') },
    ],
  },
  {
    id: 4,
    name: 'War',
    blurb: 'Arms, intelligence and violence — when talking stops.',
    options: { ...QUIET, seed: 404, opponents: 'normal', startMoney: 12_000 },
    steps: [
      { text: 'Buy a weapon from the black market', hint: 'Lieutenants page → Weapons (W). Choose Buy, then accept the $100 pistol offer; it goes straight to the selected crew.', done: (w, g) => !!w.gangs[g]?.isPlayer && !!w.tutorialActions?.weaponBought },
      { text: 'Give an Explore order on a rival block', hint: 'Personnel → Explore on a block containing a rival-owned or protected business. Check the site’s details to see who holds it. Stealth keeps the scout unseen.', done: (w, g) => !!w.gangs[g]?.isPlayer && !!w.tutorialActions?.rivalExplorationOrdered },
      { text: 'Offer a rival Aggression or Gang Warfare', hint: 'Diplomacy page (F4). They learn your stance a week late.', done: (w, g) => Object.entries(w.gangs[g]?.offered ?? {}).some(([id, d]) => Number(id) !== g && !!w.gangs[Number(id)] && !w.gangs[Number(id)].eliminated && (d === 'aggression' || d === 'war')) },
      { text: 'Give a violent order', hint: 'Violent Crimes: Smash Up a rival site, or Ambush their streets. Priority hoods avoid the police.', done: (w, g) => hasOrder(w, g, ['smashUp', 'assault', 'torch', 'bomb', 'kill', 'ambush']) },
      // Through a week of war: the violent order comes first (week 2 alone
      // ticked it before any) — given, even if it then failed.
      { text: 'Come through the week alive', hint: 'Watch the Combat message box. The Wire tells you who got hurt.', done: (w, g) => { const boss = w.people[w.gangs[g]?.bossId ?? -1]; return w.week > 1 && (hasOrder(w, g, ['smashUp', 'assault', 'torch', 'bomb', 'kill', 'ambush']) || warDeclared(w)) && !!boss && boss.status !== 'dead' && w.phase !== 'gameOver'; } },
    ],
  },
];

export function tutorialById(id: number | undefined): Tutorial | null {
  return TUTORIALS.find((t) => t.id === id) ?? null;
}

/** Latch observed steps into this world's snapshot, including while folded. */
export function captureTutorialProgress(w: WorldState): number[] {
  const tutorial = tutorialById(w.options.tutorialId);
  const gang = Object.values(w.gangs).find(g => g.isPlayer);
  if (!tutorial || !gang) return [];
  const completed = w.tutorialProgress?.lessonId === tutorial.id
    ? w.tutorialProgress.completed.filter(i => Number.isInteger(i) && i >= 0 && i < tutorial.steps.length)
    : [];
  tutorial.steps.forEach((step, i) => {
    if (!completed.includes(i) && step.done(w, gang.id)) completed.push(i);
  });
  w.tutorialProgress = { lessonId: tutorial.id, completed };
  return completed;
}

/** The player's identity kept, the lesson's quiet city set. */
export function applyTutorial(base: GameOptions, tutorial: Tutorial): GameOptions {
  return { ...base, ...tutorial.options, cityHeight: tutorial.options.cityHeight, tutorialId: tutorial.id, scenarioId: undefined };
}
