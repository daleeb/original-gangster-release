import type { OrderType, VehicleId, WeaponId } from './types';

/** Working week runs Monday..Friday, 8 working hours a day, one tick = one minute. */
export const DAYS_PER_WEEK = 5;
export const MINUTES_PER_DAY = 480;
export const MINUTES_PER_WEEK = DAYS_PER_WEEK * MINUTES_PER_DAY;
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
/** Working day starts at 8am. */
export const DAY_START_HOUR = 8;

/** World geometry, in metres. */
export const BLOCK_SIZE = 40;
export const STREET_WIDTH = 14;
export const CELL = BLOCK_SIZE + STREET_WIDTH;
/** How far to the right of a street's centre line people and cars keep. */
export const PAVEMENT_OFFSET = STREET_WIDTH / 2 - 1.6;
export const LANE_OFFSET = 1.95;

/**
 * The clock, in simulated minutes per real second at normal speed. The
 * original's working week lasts 12 real minutes at speed 1 (720,000 sim-ms,
 * 30 ms per tick; Deep 02), so our 2,400-minute week runs at 10/3 minutes a
 * second (playtest, 30 September: match the original's pace).
 */
export const MINUTES_PER_SECOND = 10 / 3;

/**
 * Movement, metres per simulated minute. Walkers keep the original's on-screen
 * pace, about one body height a second (1.8 m/s at normal speed); cars keep
 * their earlier ratio to walking. Our blocks are about twice the original's in
 * body lengths, so a block crossing is ~4% of the week against its 2%.
 */
export const WALK_SPEED = 1.8 / MINUTES_PER_SECOND;
export const DRIVE_SPEED = WALK_SPEED * 3.4;
/**
 * A man with a car drives only when he is going further than this; nearer,
 * he walks (the original's travel decision 0x4BFE00: over 1,800 units,
 * 18.75 of its map cells, five to a block).
 */
export const DRIVE_MIN_DISTANCE = 18.75 * CELL / 5;

export const MAX_TEAMS = 8;
export const MAX_TEAM_SIZE = 10;
export const SNITCH_COUNT = 3;
/** Citizens walking the streets, per block. Every pedestrian is one of them. */
export const CITIZENS_PER_BLOCK = 28;
export const GO_STRAIGHT_ASSETS = 250_000;
export const ELECTION_BLOCKS_REQUIRED = 100;
export const ELECTION_WEEKS = 6;
/** Original mayor record: ctor 0x4C2E20, weekly counter 0x4C32F0. */
export const MAYOR_INITIAL_TERM_WEEKS = 4;
export const MAYOR_ELECTION_CYCLE = 22;
export const WAREHOUSE_GOODS_CAP = 300;
export const WAREHOUSE_CASH_CAP = 15;

export const WEAPONS: Record<
  WeaponId,
  { name: string; cost: number; range: number; damage: number; accuracy: number; desc: string }
> = {
  pistol: {
    name: 'Pistol',
    cost: 100,
    range: 22,
    damage: 26,
    accuracy: 0.5,
    desc: 'A basic six-shot revolver. Effective only at short range, but every hood should carry one.',
  },
  shotgun: {
    name: 'Shotgun',
    cost: 750,
    range: 22,
    damage: 60,
    accuracy: 0.62,
    desc: 'Devastating at point-blank range, falls off fast. The deadliest weapon up close.',
  },
  rifle: {
    name: 'Rifle',
    cost: 750,
    range: 46,
    damage: 42,
    accuracy: 0.7,
    desc: 'Long reach and accurate. Rifles and shotguns together make a fine patrol.',
  },
  tommy: {
    name: 'Tommy Gun',
    cost: 2000,
    range: 38,
    damage: 52,
    accuracy: 0.66,
    desc: 'Ten rounds a second. What it lacks in accuracy it makes up for in quantity.',
  },
  twinPistols: {
    name: 'Twin Pack Pistols',
    cost: 3000,
    range: 40,
    damage: 58,
    accuracy: 0.78,
    desc: 'Rarely available heavy automatics. In the right hands they out-perform everything.',
  },
  explosives: {
    name: 'Explosives',
    cost: 500,
    range: 0,
    damage: 0,
    accuracy: 0,
    desc: 'A timed bundle, enough to remove most buildings. Not for the inexperienced.',
  },
};

export const WEAPON_ORDER: WeaponId[] = [
  'pistol',
  'shotgun',
  'rifle',
  'tommy',
  'twinPistols',
  'explosives',
];

export const VEHICLES: Record<
  VehicleId,
  { name: string; cost: number; speed: number; capacity: number; cargo: number; desc: string }
> = {
  coupe: {
    name: 'Coupe',
    cost: 3000,
    speed: 1,
    capacity: 4,
    cargo: 60,
    desc: 'The most common car on the road. Average in every respect.',
  },
  truck: {
    name: 'Truck',
    cost: 3000,
    speed: 0.38,
    capacity: 10,
    cargo: 400,
    desc: 'Carries people and goods in quantity, but barely outruns a man on foot.',
  },
  speedster: {
    name: 'Speedster',
    cost: 5000,
    speed: 1.45,
    capacity: 2,
    cargo: 20,
    desc: 'Fast and manoeuvrable. Ideal for jobs that must be finished in a hurry.',
  },
};

export const VEHICLE_ORDER: VehicleId[] = ['coupe', 'truck', 'speedster'];

export interface OrderDef {
  type: OrderType;
  group: 'business' | 'personnel' | 'minor' | 'violent';
  name: string;
  desc: string;
  /** Minutes of work per target, before skill modifiers. */
  /** On-site work per target. Where Crime.xtx gives a short work timer it is
   * used directly (its units ÷ 5: 12,000 = a week = our 2,400 minutes) —
   * collect/extort/recruit/donate 33, explore 17, intimidate/bomb/smash/torch
   * 67, bribe/raid 100. Its 6,000/12,000 rows are limits for orders that end on
   * an event (kill, assault, kidnap, export, business); those keep ours. */
  minutesPerTarget: number;
  /** Crime.xtx "max manpower" for the order's row: the most people it may take. */
  maxManpower: number;
  /** Target selection mode. */
  target: 'area' | 'building' | 'person' | 'point' | 'none';
  /** Consumes the whole week regardless of targets. */
  wholeWeek?: boolean;
  /** Primary skills used for the outcome roll. */
  skills: (keyof typeof SKILL_WEIGHTS_DUMMY)[];
  /** Base crime severity: drives witnesses, heat and arrest risk. 0 = not a crime. */
  severity: number;
  /** Options this order supports beyond manpower/priority/wait. */
  supportsRepeat?: boolean;
  supportsPublic?: boolean;
}

// Only used so the OrderDef skill list stays typed against real skill names.
const SKILL_WEIGHTS_DUMMY = {
  intelligence: 0,
  organization: 0,
  business: 0,
  firearms: 0,
  fists: 0,
  knives: 0,
  arson: 0,
  explosives: 0,
  intimidation: 0,
  driving: 0,
  stealth: 0,
};

export const ORDERS: Record<OrderType, OrderDef> = {
  // ---------------- Business ----------------
  buyPremises: {
    type: 'buyPremises',
    maxManpower: 2,
    group: 'business',
    name: 'Buy Premises',
    desc: 'Buy empty land, a warehouse, or a commercial, industrial or tenement site within two blocks of your territory. The land in the middle of a block is only sold to whoever owns a business in front of it.',
    minutesPerTarget: 250,
    target: 'building',
    skills: ['business', 'organization'],
    severity: 0,
  },
  setUpBusiness: {
    type: 'setUpBusiness',
    maxManpower: 2,
    group: 'business',
    name: 'Set Up Business',
    desc: 'Open a business on land you own. Illegal businesses need the centre lot and a legal front on the same block.',
    minutesPerTarget: 500,
    target: 'building',
    skills: ['business', 'organization'],
    severity: 0,
  },
  runBusiness: {
    type: 'runBusiness',
    maxManpower: 2,
    group: 'business',
    name: 'Run Business',
    desc: 'Send your best available hood to manage a site. Any hood already there returns to headquarters.',
    minutesPerTarget: 150,
    target: 'building',
    skills: ['business', 'organization'],
    severity: 0,
  },
  collectProtection: {
    type: 'collectProtection',
    maxManpower: 10,
    group: 'business',
    name: 'Collect Protection',
    desc: 'Visit protected businesses and pick up the weekly payment. Needs no special skill.',
    minutesPerTarget: 33,
    target: 'area',
    skills: ['intimidation'],
    severity: 0,
    supportsRepeat: true,
  },
  adjustProtection: {
    type: 'adjustProtection',
    maxManpower: 1,
    group: 'business',
    name: 'Adjust Protection',
    desc: 'Set the weekly rate between nothing and double the going rate. Greed breeds refusals and squealers.',
    minutesPerTarget: 20,
    target: 'area',
    skills: ['intimidation'],
    severity: 0,
  },
  export: {
    type: 'export',
    maxManpower: 4,
    group: 'business',
    name: 'Export Goods',
    desc: 'Truck surplus warehouse goods to the docks or the railroad terminal. Pays less than selling in the city.',
    minutesPerTarget: 350,
    target: 'building',
    skills: ['business', 'driving'],
    severity: 0,
  },
  donate: {
    type: 'donate',
    maxManpower: 4,
    group: 'business',
    name: 'Donate to Charity',
    desc: 'Take money to a church or orphanage. The poorer the district, the further your money goes.',
    minutesPerTarget: 33,
    target: 'building',
    skills: ['intelligence'],
    severity: 0,
  },

  // ---------------- Personnel ----------------
  guardBusiness: {
    type: 'guardBusiness',
    maxManpower: 4,
    group: 'personnel',
    name: 'Guard Business',
    desc: 'Stand watch over a site all week. Guarding a front also protects the illegal business behind it.',
    minutesPerTarget: 0,
    target: 'building',
    wholeWeek: true,
    skills: ['firearms'],
    severity: 0,
  },
  patrol: {
    type: 'patrol',
    maxManpower: 4,
    group: 'personnel',
    name: 'Patrol',
    desc: 'Walk the streets of your territory looking for intruders. Reassures the people who pay you.',
    minutesPerTarget: 0,
    target: 'area',
    wholeWeek: true,
    skills: ['firearms', 'intimidation'],
    severity: 0,
    supportsRepeat: true,
  },
  explore: {
    type: 'explore',
    maxManpower: 10,
    group: 'personnel',
    name: 'Explore',
    desc: 'Investigate an area. Reveals business details and may uncover rival illegal operations.',
    minutesPerTarget: 17,
    target: 'area',
    skills: ['stealth', 'intelligence'],
    severity: 0,
  },
  recruit: {
    type: 'recruit',
    maxManpower: 10,
    group: 'personnel',
    name: 'Recruit',
    desc: 'Find new blood at gyms, pool halls, the docks and the labour exchange. Accountants and lawyers keep their own haunts.',
    minutesPerTarget: 33,
    target: 'area',
    skills: ['intelligence'],
    severity: 0,
  },
  goTo: {
    type: 'goTo',
    maxManpower: 4,
    group: 'personnel',
    name: 'Go To',
    desc: 'Send hoods to a spot and have them hold it. Useful for a fixed lookout.',
    minutesPerTarget: 0,
    target: 'point',
    wholeWeek: true,
    skills: ['stealth'],
    severity: 0,
  },

  // ---------------- Minor crimes ----------------
  bribe: {
    type: 'bribe',
    maxManpower: 4,
    group: 'minor',
    name: 'Bribe',
    desc: 'Bend a citizen, business owner, reporter or priest to your will with money.',
    minutesPerTarget: 100,
    target: 'person',
    skills: ['intelligence'],
    severity: 1,
  },
  intimidate: {
    type: 'intimidate',
    maxManpower: 10,
    group: 'minor',
    name: 'Intimidate',
    desc: 'Lean on shop owners who refuse you — those who turned down your protection or stopped paying.',
    minutesPerTarget: 67,
    target: 'area',
    skills: ['intimidation'],
    severity: 2,
  },
  extort: {
    type: 'extort',
    maxManpower: 10,
    group: 'minor',
    name: 'Extort',
    desc: 'Persuade businesses to pay a weekly sum for your protection. The further from your territory, the harder the sell.',
    minutesPerTarget: 33,
    target: 'area',
    skills: ['intimidation'],
    severity: 2,
  },
  raid: {
    type: 'raid',
    maxManpower: 4,
    group: 'minor',
    name: 'Raid',
    desc: 'Rob a business. With a truck your hoods can carry off the goods as well as the cash.',
    minutesPerTarget: 100,
    target: 'building',
    skills: ['stealth', 'firearms'],
    severity: 5,
  },
  kidnap: {
    type: 'kidnap',
    maxManpower: 4,
    group: 'minor',
    name: 'Kidnap',
    desc: 'Abduct a rival gang member. Dangerous, but they arrive at your office with money and secrets.',
    minutesPerTarget: 500,
    target: 'person',
    skills: ['stealth', 'fists', 'intimidation'],
    severity: 6,
  },

  // ---------------- Violent crimes ----------------
  smashUp: {
    type: 'smashUp',
    maxManpower: 4,
    group: 'violent',
    name: 'Smash Up',
    desc: 'Wreck the place. Usually puts a site out of commission for a week or two.',
    minutesPerTarget: 67,
    target: 'building',
    skills: ['intelligence', 'stealth', 'fists'],
    severity: 4,
    supportsPublic: true,
  },
  assault: {
    type: 'assault',
    maxManpower: 4,
    group: 'violent',
    name: 'Assault',
    desc: 'Give someone a beating. A high knives rating can turn a beating into a murder charge.',
    minutesPerTarget: 400,
    target: 'person',
    skills: ['intelligence', 'fists'],
    severity: 5,
  },
  torch: {
    type: 'torch',
    maxManpower: 4,
    group: 'violent',
    name: 'Torch',
    desc: 'Maximum damage at minimum cost. No explosives required.',
    minutesPerTarget: 67,
    target: 'building',
    skills: ['arson', 'stealth', 'intelligence'],
    severity: 7,
    supportsPublic: true,
  },
  bomb: {
    type: 'bomb',
    maxManpower: 4,
    group: 'violent',
    name: 'Bomb',
    desc: 'Level the building, and possibly the block. Consumes a bundle of explosives.',
    minutesPerTarget: 67,
    target: 'building',
    skills: ['explosives', 'stealth', 'intelligence'],
    severity: 9,
    supportsPublic: true,
  },
  kill: {
    type: 'kill',
    maxManpower: 4,
    group: 'violent',
    name: 'Kill',
    desc: 'Permanent removal. Use when every other alternative is exhausted.',
    minutesPerTarget: 550,
    target: 'person',
    skills: ['firearms', 'stealth', 'intimidation'],
    severity: 10,
  },
  ambush: {
    type: 'ambush',
    maxManpower: 4,
    group: 'violent',
    name: 'Ambush',
    desc: 'Hold an area and open fire on any rival gang member who shows his face.',
    minutesPerTarget: 0,
    target: 'area',
    wholeWeek: true,
    skills: ['firearms', 'stealth'],
    severity: 8,
  },
};

export const ORDER_GROUPS: { id: 'business' | 'personnel' | 'minor' | 'violent'; name: string }[] = [
  { id: 'business', name: 'Business Orders' },
  { id: 'personnel', name: 'Personnel Orders' },
  { id: 'minor', name: 'Minor Crimes' },
  { id: 'violent', name: 'Violent Crimes' },
];

export const GANG_COLORS: Record<string, { hex: string; light: string; label: string }> = {
  red: { hex: '#c0392b', light: '#e74c3c', label: 'Red' },
  green: { hex: '#27803f', light: '#2ecc71', label: 'Green' },
  blue: { hex: '#2456a6', light: '#3f8ae0', label: 'Blue' },
  orange: { hex: '#c87816', light: '#f0a03a', label: 'Orange' },
};

export const ECONOMY_MULT = { weak: 0.68, normal: 1, strong: 1.38 };
