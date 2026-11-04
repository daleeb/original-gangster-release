import type { Heritage } from './heritage';
/**
 * Core data model. Everything here is plain, structured-clone-safe data so the
 * whole simulation state serialises directly into a save file.
 */

export type ID = number;

export const SKILLS = [
  'intelligence',
  'organization',
  'business',
  'firearms',
  'fists',
  'knives',
  'arson',
  'explosives',
  'intimidation',
  'driving',
  'stealth',
] as const;
export type Skill = (typeof SKILLS)[number];
export type Skills = Record<Skill, number>; // 0.5 .. 5.0 in half-star steps

export const SKILL_LABELS: Record<Skill, string> = {
  intelligence: 'Intelligence',
  organization: 'Organization',
  business: 'Business',
  firearms: 'Firearms',
  fists: 'Fists',
  knives: 'Knives',
  arson: 'Arson',
  explosives: 'Explosives',
  intimidation: 'Intimidation',
  driving: 'Driving',
  stealth: 'Stealth',
};

export type GangColorName = 'red' | 'green' | 'blue' | 'orange';

export type PersonRole =
  | 'boss'
  | 'lieutenant'
  | 'hood'
  | 'accountant'
  | 'lawyer'
  | 'citizen'
  | 'owner'
  | 'police'
  | 'firefighter'
  | 'policeChief'
  | 'fbi'
  | 'fbiHead'
  | 'judge'
  | 'da'
  | 'mayor'
  | 'reporter'
  | 'clergy'
  | 'snitch';

export type PersonStatus =
  | 'active'
  | 'arrested'
  | 'onTrial'
  | 'jailed'
  | 'kidnapped'
  | 'beaten'
  | 'dead';

export interface Vec2 {
  x: number;
  y: number;
}

/** A waypoint; `cross` marks the leg ending here as a street crossing, and is its length in metres. */
export interface PathPoint extends Vec2 {
  cross?: number;
}

export type CombatPosture = 'standing' | 'kneeling' | 'down';
export interface CloseCombatState {
  posture: CombatPosture;
  turnsLost: number;
  /** Close-combat stamina, 0..15 (goal 13 flags bits 10–13; 0x5614D0 starts it at 15). Absent = 15. */
  stamina?: number;
  /** Last blow taken: Cart attack type, reaction id and the minute it landed. */
  lastBlow?: { attack: number; reaction: number; hit: boolean; minute: number; week: number };
}

export interface Person {
  id: ID;
  name: string;
  female: boolean;
  portrait: number;
  /** A gang boss's painted portrait under portraits/nationality/ (heritage.ts); the pool portrait stands in. */
  face?: string;
  role: PersonRole;
  skills: Skills;
  /** Owning gang, or null for civilians / officials / unaffiliated hoods. */
  gangId: ID | null;
  teamId: ID | null;
  /** Building this person is the manager/owner/resident of, if any. */
  buildingId: ID | null;
  pay: number;
  payDemand: number;
  /** 0..100. Falls with unpaid wages, refused raises, deaths at HQ. */
  loyalty: number;
  /** Per-gang opinion, -100 (hates) .. +100 (loves). Officials & civilians use this. */
  opinion: Record<ID, number>;
  /** The original's attitude bytes per gang (0..255), written only once they
   * change; unset entries hold the Constants.xtx creation roll (attitudes.ts). */
  hostility?: Record<ID, number>;
  fear?: Record<ID, number>;
  status: PersonStatus;
  /** The part of the coming minute already shown when a command was given (movement.ts). */
  commandFraction?: number;
  /** FBI "Most Wanted" heat for this individual. */
  wanted: number;
  pos: Vec2;
  /** Live movement target while walking the city. */
  dest: Vec2 | null;
  path: PathPoint[];
  /** Standing at a kerb waiting for a gap in the traffic. */
  halted?: boolean;
  inVehicle: boolean;
  /** Saved reservation/seat in an actual fleet vehicle; absent in legacy saves. */
  vehicleKey?: string;
  /** Set while carrying out an order in the working week. */
  orderId: ID | null;
  /** Weeks remaining before an arrested/jailed person returns. */
  jailWeeks: number;
  /** Bribe/retainer bookkeeping. */
  bribedBy: ID | null;
  employedBy: ID | null;
  weeklyRetainer: number;
  /** Original city: this week's retainer was cut to half (0x75DA90 flag); a
   * later full payment takes back the hostility the cut added. */
  retainerShort?: boolean;
  /** Original city: the gangs whose payroll he quit in the weekly pass
   * (0x75DA90). He keeps their payroll bit (+0x90), so he still counts as
   * their man and none of them can hire him again (payrollMark.ts). */
  quitPayrollOf?: ID[];
  /** Uncovered tax this accountant can disclose, retained after leaving a gang. */
  taxRecords?: Record<ID, number>;
  /** Original city: the accountant's last sixteen weeks of levy kept back
   * (+0xB0 ring, written by 0x4BF180); 0x4BF160 counts the weeks above 0. */
  taxEvasionWeeks?: number[];
  /** Original city: wanted by the FBI (+0x84 bit 0x40, 0x4F5AE0): an
   * accountant by its check, any member by the member pass. */
  fbiWarrant?: boolean;
  /** Original city: this man's own FBI suspicion (+0x7C, 16-bit), raised by
   * the heavy crimes he and his team file (0x4DB700), a tenth off each week
   * (0x460300); a boss's is `Gang.fbiTotal` instead. */
  crimeSuspicion?: number;
  /** Original city: an FBI agent's own zeal (+0x70, 128..255, 0x4FBDC0),
   * which decides whether his investigation is solved (0x580360). */
  fbiAgentZeal?: number;
  /** Saved Bureau journey and on-site work; an unavailable agent cannot complete it. */
  fbiAssignment?: FbiAssignment;
  /** Snitch: which gangs' rosters they currently know about. */
  snitchKnows: ID[];
  hp: number;
  /** Close combat in progress (Cart.txt exchange): posture, turns still to
   * lose, and the last blow for presentation. Optional for older saves. */
  closeCombat?: CloseCombatState;
  /** The week they died, for the newspaper's death notices. */
  diedWeek: number;
  /** Saved doorway escape and corpse pose; the clock also drives its animation. */
  burningEscape?: BurningEscape;
  emergencyResponse?: EmergencyResponse;
  shockReaction?: {week:number;startMinute:number;untilMinute:number;victimId:ID;from:Vec2;to:Vec2;resume:Vec2|null};
  /** Set for kidnapped prisoners: how much they will still divulge. */
  interrogationValue: number;
  capturedBy: ID | null;
  /** Live order given directly on the street during the working week. */
  streetOrder: {
    type: 'kill' | 'assault' | 'tail' | 'goTo';
    targetPersonId: ID | null;
    /** Go-to destination, or the last target position used to route a pursuit. */
    pos: Vec2 | null;
    /** First damaging hit already caused the Bureau response; survives save/load. */
    bureauResponseApplied?: boolean;
  } | null;
  /** Absolute minute until which he counts as under fire (shot at, hit or not). */
  underFireUntil?: number;
  /** Absolute minute at which a beaten man gets back on his feet. */
  beatenUntil?: number;
  /** The planned order a street order took him off; he goes back to it. */
  resumeOrderId?: ID;
  /** Original city: walking to a street tram that stands for him, or riding
   * it (tramRiding.ts: 0x5DCDF0, 0x6220E0, goal 10 of 0x5D2740). */
  tram?: TramRide;
}

/** A walker's tram ride (tramRiding.ts). */
export interface TramRide {
  /** The tram, by its place in `tramsAt`. */
  tram: number;
  /** Walking to it while it stands, or aboard (0x5D2740 goal 10: getting in, travelling). */
  phase: 'boarding' | 'riding';
  /** Where he gets off, in metres along the line (0x622410 keeps the cell). */
  drop: number;
  /** The line of his footway across the tram line (y of an east-west line,
   * x of a north-south one): he crosses back to it when set down. */
  kerb: number;
  /** Where he was walking: he walks on there once set down. */
  dest: Vec2;
  /** Campaign minute he set off for the tram. */
  since: number;
}

export interface BurningEscape {
  week:number; buildingId:ID; startMinute:number; fatal:boolean;
  door:Vec2; pavement:Vec2; end:Vec2;
  gangId:ID|null; perpetratorId:ID|null;
}

export interface FbiAssignment {
  buildingId: ID;
  /** 'arrest': original city, the squad sent to a boss's office (0x4F6ED0). */
  kind: 'search' | 'raid' | 'arrest';
  assignedWeek: number;
  phase: 'travelling' | 'working';
  searchPoint: number;
  workLeft: number;
}
export interface EmergencyResponse {
  week:number; buildingId:ID; startMinute:number; untilMinute:number;
  kind:'police'|'fire'|'reporter'; stage:'approaching'|'working'|'returning';
  target:Vec2; lookAt:Vec2; home:Vec2; arrivedMinute?:number;
}

export type BuildingClass =
  | 'commercial'
  | 'industrial'
  | 'tenement'
  | 'municipal'
  | 'charity'
  | 'illegal'
  | 'empty'
  /** Plain houses in the original city's row-house strips; not a business. */
  | 'residential';

export type GoodsKind = 'liquor' | 'stolen' | 'counterfeit';

export interface BuildingType {
  id: string;
  name: string;
  cls: BuildingClass;
  /** Purchase cost basis, scaled by land value. */
  cost: number;
  /** Base weekly profit before market, economy and manager modifiers. */
  profit: number;
  /** Weight for procedural placement, per district. */
  weight: Partial<Record<DistrictKind, number>>;
  /** Which goods this site can hold. */
  stores?: GoodsKind[];
  /** Illegal businesses only: legal types that make a convincing front. */
  fronts?: string[];
  /** Illegal businesses only: what it produces each week. */
  produces?: { kind: GoodsKind; amount: number };
  /** Legal sites that hoods can be recruited from. */
  recruit?: 'hood' | 'accountant' | 'lawyer';
  /** Municipal special role. */
  special?:
    | 'cityHall'
    | 'courthouse'
    | 'policeHQ'
    | 'hospital'
    | 'newspaper'
    | 'church'
    | 'orphanage'
    | 'docks'
    | 'railroad'
    | 'bank'
    | 'union'
    | 'radio';
  /** Height hint for the renderer, in storeys. */
  storeys: number;
}

export type DistrictKind = 'downtown' | 'commercial' | 'industrial' | 'residential' | 'civic';

export interface Lot {
  id: ID;
  blockId: ID;
  /** Index 4 is the centre lot (illegal businesses only). */
  index: number;
  center: Vec2;
  buildingId: ID;
  bounds?: { x: number; y: number; w: number; h: number };
  /** Authored module building envelope, in world X/Z metres. */
  footprint?: { w: number; h: number };
  facing?: 'north' | 'south' | 'east' | 'west';
}

export interface Block {
  id: ID;
  gx: number;
  gy: number;
  district: DistrictKind;
  center: Vec2;
  lotIds: ID[];
  landValue: number; // 0..100
  squalor: number; // 0..100
  crimeHeat: number; // decays weekly
  policePresence: number; // 0..10 officers assigned
  /** Logical cells can join into one physical city block. Absorbed cells own no lots. */
  /** Original 40 × 32 city: the generator's content id and 0..255 land value. */
  original?: { content: number; landValue: number };
  layout?: {
    spanX: number; spanY: number;
    /** Plaza, avenue and water blocks exist only in the original 40 × 32 city. */
    use: 'urban' | 'park' | 'civic' | 'plaza' | 'avenue' | 'water';
    /** The original's elevated railway crosses this block. */
    rail?: boolean;
    mergedInto?: ID;
    landmark?: string;
    name?: string;
    /** Extra road clearance, saved per cell; absent in older cities. */
    streetInset?: number;
    /** Versioned, authored block kit. Absent in older generated cities. */
    module?: { id: string; turn: number };
  };
}

export interface Protection {
  gangId: ID;
  weekly: number;
  base: number;
  refusing: boolean;
  /** Weeks the owner has been unhappy; drives squealing. */
  grievance: number;
  /** The week this racket last paid (one collection a week). */
  collectedWeek?: number;
  /** The week the owner last refused a collection call (original cell flag 8, 0x4CD730). */
  refusedWeek?: number;
}

export interface Building {
  id: ID;
  lotId: ID;
  blockId: ID;
  typeId: string;
  cls: BuildingClass;
  /** Original 40 × 32 city: the economics record this business was seeded as. */
  originalKind?: number;
  ownerGangId: ID | null;
  /** Hood managing it for a gang, or the civilian owner. */
  managerId: ID | null;
  /** Purchase and fit-out cost, retained until the property is sold. */
  acquisitionCost?: number;
  /** The week the manager was recalled to base: that week's takings are lost. */
  managerRecalledWeek?: number;
  /** Daily production already booked, so a saved/restored day cannot repeat it. */
  goodsProduction?: { week: number; day: number; remainder: number };
  ownerPersonId: ID | null;
  /** Stable newspaper identity, independent of the current owner or week. */
  paperName?: string;
  state: 'trading' | 'ceased' | 'damaged' | 'destroyed' | 'empty';
  ceasedWeek?: number;
  resumeTradingWeek?: number;
  protection: Protection | null;
  /** For an illegal business: the legal building fronting it. */
  frontId: ID | null;
  /** For a legal building: the illegal business it fronts. */
  hidesId: ID | null;
  stock: Record<GoodsKind, number>;
  lastProfit: number;
  repairCost: number;
  /** Saved fire damage: smoke lasts through this week, scorch persists until repaired. */
  fireWeek?: number;
  /** Paid fire repairs finish at the start of this week. */
  repairCompleteWeek?: number;
  /** How well hidden from the FBI: 0 (obvious) .. 1 (perfect front). */
  cover: number;
  /** FBI progress toward discovering this illegal site. */
  fbiSuspicion: number;
  discovered: boolean;
  fbiDiscoveredWeek?: number;
  fbiRaidWeek?: number;
  fbiClosedWeek?: number;
  fbiSearchedWeek?: number;
  /** Last week illicit goods were passed through this legal business. */
  launderingWeek?: number;
  /** Per-gang knowledge: 0 none, 1 type only, 2 extorted, 3 explored, 4 owned. */
  knowledge: Record<ID, number>;
  /** Ownership named in a published report, without revealing protection or hidden premises. */
  reportedOwners?: Record<ID, ID>;
  guardIds: ID[];
  isHQ: boolean;
}

export type OrderGroup = 'business' | 'personnel' | 'minor' | 'violent';

export type OrderType =
  // Business
  | 'buyPremises'
  | 'setUpBusiness'
  | 'runBusiness'
  | 'collectProtection'
  | 'adjustProtection'
  | 'export'
  | 'donate'
  // Personnel
  | 'guardBusiness'
  | 'patrol'
  | 'explore'
  | 'recruit'
  | 'goTo'
  // Minor crimes
  | 'bribe'
  | 'intimidate'
  | 'extort'
  | 'raid'
  | 'kidnap'
  // Violent crimes
  | 'smashUp'
  | 'assault'
  | 'torch'
  | 'bomb'
  | 'kill'
  | 'ambush';

export type SpecialistOrderType =
  | 'audit'
  | 'bribeOfficials'
  | 'employPolice'
  | 'goStraight'
  | 'runForOffice';

export interface SpecialistJob {
  id: ID;
  gangId: ID;
  actorId: ID;
  week: number;
  type: 'audit' | 'bribeOfficials' | 'employPolice';
  targetPersonId: ID | null;
  blockIds: ID[];
  state: 'queued' | 'travelling' | 'working' | 'done' | 'failed' | 'cancelled';
  quotedPrice: number;
  workLeft: number;
  visitedPersonIds: ID[];
  completed: number;
  patrolIndex: number;
  /** Last position used to route a moving-target visit. */
  targetPos: Vec2 | null;
  result: string;
  paused?: boolean;
}

export interface OrderOptions {
  repeat: boolean;
  isPublic: boolean;
  priority: boolean;
  manpower: number;
  wait: boolean;
  preferredHoodId: ID | null;
  /** adjustProtection: multiplier of base, 0 .. 2. */
  protectionLevel?: number;
  /** setUpBusiness: which type to establish, and the front to hide behind. */
  businessTypeId?: string;
  frontBuildingId?: ID;
  /** donate / bribe: money committed. */
  amount?: number;
}

export type OrderState =
  | 'queued'
  | 'travelling'
  | 'waiting'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Order {
  id: ID;
  gangId: ID;
  teamId: ID;
  type: OrderType;
  /** Target buildings/blocks for area or site orders. */
  targetBuildingIds: ID[];
  targetBlockIds: ID[];
  targetPersonId: ID | null;
  targetPos: Vec2 | null;
  opts: OrderOptions;
  assignedIds: ID[];
  state: OrderState;
  /** Index into targetBuildingIds currently being worked. */
  cursor: number;
  /** Minutes left on the current target. */
  workLeft: number;
  estimatedMinutes: number;
  results: string[];
  failReason: string | null;
  /** Street orders are transient and re-entrant. */
  isStreetOrder: boolean;
  completedTargets: number;
  /** Continue releases this week's initial Wait without changing the planning option. */
  waitReleased?: boolean;
  /** Resume the same phase and remaining work after a live pause. */
  waitResumeState?: 'travelling' | 'executing';
  /** Queued until the complete party or required vehicle is available; persisted to avoid repeat alerts. */
  dispatchWaitReason?: string;
  /** Last reported active party size, so casualties/interruption report once. */
  reportedCrewSize?: number;
  /** Actual time performing a standing order; absent in historical saves. */
  workedMinutes?: number;
  /** Rival currently engaged by the crew within its selected Ambush area. */
  ambushTargetId?: ID;
  /** Stock already removed from the warehouse, paid only after terminal delivery. */
  exportDelivery?: {
    warehouseId: ID;
    terminalId: ID;
    goods: Record<GoodsKind, number>;
    rate: number;
    /** Keys of the actual loaded trucks; absent only in older saves. */
    vehicleKeys?: string[];
  };
  /** A successful raid is delivering its goods before proceeding to the next site. */
  raidDelivery?: { warehouseId: ID };
  /** Unloaded part of the stock accepted for this Export; later deposits wait for another order. */
  exportPending?: {warehouseId: ID; goods: Record<GoodsKind,number>};
  /** Hunting: the target's whereabouts are unknown, so the crew asks around at these places first. */
  hunting?: boolean;
  huntStopIds?: ID[];
  /** Minutes still to spend asking at the current stop of a hunt. */
  huntAsking?: number;
  /** Where an informant said the hunted man was seen; the crew is on its way there. */
  huntTip?: Vec2;
  /** Original city: the pool hall or gym the hunt is heading for, to ask there (0x4E2130). */
  huntHallId?: ID;
  /** Original city: what `huntTip` is, his position when told ('told'), the push on past it ('press') or his position within 15 cells ('near'). */
  huntLeg?: 'told' | 'press' | 'near';
  /** Original city: the pool halls and gyms this hunt has been sent to (0x60B950's visited set). */
  huntVisitedIds?: ID[];
  /** Counted done when it paid (a raid's haul, an export's first load), before its delivery leg. */
  targetPaid?: boolean;
  /** The last attempt that came to nothing (its reason, if the whole job did). */
  lastMiss?: string;
  /** Its crew walked away from a loaded truck (the load was lost with it). */
  cargoLeft?: boolean;
}

export interface Team {
  id: ID;
  gangId: ID;
  lieutenantId: ID;
  name: string;
  memberIds: ID[];
  weapons: Record<WeaponId, number>;
  vehicles: Record<VehicleId, number>;
  allocatedBlockIds: ID[];
  orderIds: ID[];
  timeUsed: number;
}

export type WeaponId = 'pistol' | 'shotgun' | 'rifle' | 'tommy' | 'twinPistols' | 'explosives';
export type VehicleId = 'coupe' | 'truck' | 'speedster';

/** Lazily materialized from the team's inventory; one entry is one car. */
export interface GoodsDelivery {
  sourceId: ID;
  gangId: ID;
  kind: GoodsKind;
  amount: number;
  targetId: ID | null;
  returning: boolean;
  pos: Vec2;
  path: Vec2[];
  heading: number;
  halted: boolean;
  /** Minutes left parked at the shop while the driver carries the cases in. */
  unloadLeft?: number;
}

export interface FleetVehicle {
  kind: VehicleId;
  gangId: ID;
  teamId: ID | null;
  staffId: ID | null;
  slot: number;
  pos: Vec2;
  driverId: ID | null;
  occupantIds: ID[];
  orderId: ID | null;
  destination: Vec2 | null;
  boarding: boolean;
  returning: boolean;
  /** When it was left standing out on the streets (transport.ts fetches it after a while). */
  idleSince?: number;
  cargo?: {
    goods: Record<GoodsKind, number>;
    sourceId: ID;
    orderId: ID | null;
    purpose: 'export' | 'raid' | 'return';
    destinationId: ID | null;
  };
  /** Parked at a warehouse while the crew carry returned goods in, until this
   * absolute minute (week × MINUTES_PER_WEEK + minute). */
  unloading?: { buildingId: ID; until: number };
  /** Absolute minute before which nobody gets back in (a man out for a throw). */
  boardAfter?: number;
}

export type DiplomacyLevel = 'alliance' | 'peace' | 'ceasefire' | 'aggression' | 'war';
export const DIPLOMACY_ORDER: DiplomacyLevel[] = [
  'alliance',
  'peace',
  'ceasefire',
  'aggression',
  'war',
];

export interface Gang {
  id: ID;
  /** Newspaper milestones already printed for this gang (pressStories.ts). */
  pressMilestones?: string[];
  /** Original city, AI only: the 7-byte personality profile (aiStance.ts). */
  aiProfile?: number[];
  /** Original city, AI only: hostility toward each rival (0..255) and last week's value. */
  aiHostility?: Record<ID, number>;
  aiHostilitySnapshot?: Record<ID, number>;
  name: string;
  color: GangColorName;
  bossId: ID;
  isPlayer: boolean;
  personality: 'passive' | 'normal' | 'aggressive';
  cash: number;
  teamIds: ID[];
  poolIds: ID[];
  accountantId: ID | null;
  lawyerId: ID | null;
  weapons: Record<WeaponId, number>;
  vehicles: Record<VehicleId, number>;
  /** A car each for the accountant and the lawyer, out of the cache. */
  staffVehicles?: { accountant: VehicleId | null; lawyer: VehicleId | null };
  /** Stance we are offering to each rival. */
  offered: Record<ID, DiplomacyLevel>;
  /** Stance we believe they hold — updates one week late. */
  known: Record<ID, DiplomacyLevel>;
  evadingTax: boolean;
  taxEvaded: number[]; // last 8 weeks
  uncoveredTax: number;
  /** Original city: the accountant's laundering pool (gang+0x830); optional for older saves. */
  launderPool?: number;
  /** Outstanding tax already disclosed to the authorities; prevents duplicate evidence. */
  exposedTax?: number;
  riskyMoney: number;
  suspicion: number; // 0..100 FBI interest
  /** Original city: the boss's FBI suspicion word (+0x7C, 0..255); `suspicion`
   * shows it as a percentage. Optional for older saves. */
  fbiTotal?: number;
  /** Original city: the week the FBI raids the boss's office, once a case is open. */
  fbiRaidWeek?: number;
  /** Original city: the last weekly rise of `fbiTotal` (0..255, FBI+0x190 + gang×4),
   * which the FBI weighs when it decides to look into a racket. */
  fbiWeekRise?: number;
  evidence: number; // 0..100 courtroom case against the boss
  goingStraight: boolean;
  runningForOffice: boolean;
  /** Legacy arbitrary budget retained in saves only; never used for billing or votes. */
  campaignSpend: number;
  popularity: number; // -100..100 with the electorate
  /** Standing earned by charity and quiet streets; decays, and adds to popularity. */
  goodwill: number;
  eliminated: boolean;
  snitchUsedWeek: number;
  employedPoliceIds: ID[];
  /** People who have agreed to join and are awaiting a hiring decision. */
  recruitIds: ID[];
  /** Kidnapped rivals held at the office. */
  prisonerIds: ID[];
  /** Rival gang members this gang has identified. */
  knownPeople: ID[];
  history: GangWeekStat[];
  /** Campaign highs used by the final score; independent of rolling graph history. */
  scorePeaks?: ScoreMeasures;
  lastWeekIncome: { legal: number; illegal: number; protection: number; other: number };
  lastWeekCosts: { wages: number; purchases: number; upkeep: number };
  /** Monday planning through Friday settlement; optional for older saves. */
  finances?: FinanceReport;
  lastFinanceReport?: FinanceReport;
}

export interface FinanceReport {
  week: number;
  openingCash: number;
  closingCash: number;
  income: { legal: number; illegal: number; protection: number; other: number };
  costs: { wages: number; purchases: number; upkeep: number; tax: number };
  /** Older saves cannot reconstruct transactions made before this ledger existed. */
  partial: boolean;
  /** Operating profit plus realized asset gains/losses, before tax. Older saves omit it. */
  taxableProfit?: number;
  /** This week's illicit receipts before accountant cover, never carried into a new week. */
  riskyIncome?: number;
  /** Paid costs of ceased sites, already included in costs.upkeep. Older reports omit this breakdown. */
  closedSiteUpkeep?: number;
  /** Paid campaign bill, already included in costs.upkeep. Absent in older reports. */
  campaignCost?: number;
}

export interface GangWeekStat {
  week: number;
  power: number;
  assets: number;
  /** Present on new entries: assets excludes cash. Legacy entries combined them
   * without retaining the split, so cannot supply a separate asset graph. */
  cash?: number;
  territory: number;
  manpower: number;
  loyalty: number;
  crimes: number;
  suspicion: number;
}

export interface ScoreMeasures {
  cash: number;
  territory: number;
  manpower: number;
}

export interface CrimeRecord {
  id: ID;
  week: number;
  gangId: ID;
  perpetratorId: ID;
  kind: string;
  buildingId: ID | null;
  victimId: ID | null;
  witnesses: ID[];
  /** 0..1 chance the police can build a case. */
  arrestRisk: number;
  reported: boolean;
  /** The charge laid at an arrest, not a fresh crime: weekly passes that
   * count the week's crimes (suspicion, the newspaper, opinion, history) skip it. */
  charge?: true;
}

export interface CourtCase {
  id: ID;
  defendantId: ID;
  gangId: ID;
  crime: string;
  judgeId: ID;
  daId: ID;
  witnessIds: ID[];
  jurorIds: ID[];
  /** Weeks until the verdict. */
  weeksToTrial: number;
  status: 'awaiting' | 'onTrial' | 'dismissed' | 'acquitted' | 'convicted';
  /** True once the gang has bribed the DA for the lists. */
  knowsWitnesses: boolean;
  knowsJurors: boolean;
  judgeBribed: boolean;
  strength: number; // prosecution strength 0..100
}

export interface Election {
  active: boolean;
  weeksLeft: number;
  candidates: { id: ID; kind: 'mayor' | 'judge' | 'gang'; gangId: ID | null; votes: number }[];
  lastResultWeek: number;
  /** Optional for saves predating the recovered mayor-counter implementation. */
  mayorTerm?: { personId: ID; weeks: number };
  /** Set when an election begins mid-week (the mayor's death): the begin
   * routine's initial guard, cleared by the next weekly call without counting. */
  beganInWeek?: boolean;
  /** The last poll's final tally; 0x4BD310 keeps the result for one more
   * weekly call before resetting the record. */
  lastResult?: { week: number; winnerId: ID; candidates: { id: ID; kind: 'mayor' | 'judge' | 'gang'; gangId: ID | null; votes: number }[] };
}

export interface NewsItem {
  week: number;
  /** An owned paper keeps its master's purchases out of other newspapers. */
  paperOwnerId?: ID;
  /** Structured provenance for reports generated by completed transactions. */
  kind?: 'purchase' | 'sale' | 'opening' | 'donation' | 'charityAppeal';
  buildingId?: ID;
  amount?: number;
  /** Editorial ranking: routine lead, major event, election result. */
  frontPagePriority?: 1 | 2 | 3;
  section:
    | 'front'
    | 'business'
    | 'law'
    | 'crime'
    | 'charity'
    | 'deaths'
    | 'politics'
    /** Period colour, after the original's era headlines (pressStories.ts). */
    | 'city';
  headline: string;
  body: string;
  gangId: ID | null;
}

export type MessageCategory = 'combat' | 'police' | 'failed' | 'waiting';

export interface SimMessage {
  /** Explicit firearm cue; other combat events must not sound like gunfire. */
  sound?: 'gunshot';
  id: ID;
  minute: number;
  category: MessageCategory;
  text: string;
  pos: Vec2 | null;
  personId: ID | null;
}

export interface GameOptions {
  seed: number;
  playerName: string;
  /** The original's third name field: the boss is known as First "Nick" Last. */
  playerNickname?: string;
  /** The original's nationality and face traits: the boss's portrait set and sitter (heritage.ts). */
  playerHeritage?: Heritage;
  /** Which of the heritage's sitters (twelve men, six women; heritage.ts). */
  playerSitter?: number;
  playerFemale: boolean;
  playerPortrait: number;
  playerColor: GangColorName;
  mode: 'normal' | 'power' | 'wealth' | 'territory';
  economy: 'weak' | 'normal' | 'strong';
  opponents: 'passive' | 'normal' | 'aggressive' | 'random';
  startMoney: number;
  startHoods: number;
  startBusinesses: number;
  /** Short-game targets. */
  powerWeeks: number;
  wealthTarget: number;
  territoryTarget: number;
  /** Blocks across. */
  citySize: number;
  /** Blocks down. Absent in square compact cities, including every save made
   * before the original 40 × 32 grid was restored. */
  cityHeight?: number;
  cityLayout?: 'classic' | 'varied';
  /** A hand-crafted scenario, or one of the four lessons, if the game is one. */
  scenarioId?: string;
  tutorialId?: number;
}

export interface WorldState {
  schemaVersion?: number;
  sequences: { message: number; crime: number; court: number };
  tutorialProgress?: { lessonId: number; completed: number[] };
  options: GameOptions;
  /** Player actions recorded during lessons; optional for older saves. */
  tutorialActions?: {
    weaponBought?: boolean;
    rivalExplorationOrdered?: boolean;
    lieutenantsViewed?: boolean;
    reportsViewed?: boolean;
  };
  rngState: number;
  week: number;
  minute: number; // 0 .. MINUTES_PER_WEEK
  /** How many of the coming minute's ambient walking slices have already run
   * (sim.ts AMBIENT_SLICES), so a save part way through a minute steps nobody twice. */
  ambientSlicesDone?: number;
  /** People charged only part of the coming minute's walk for a command given part way through it (movement.ts). */
  commandFractionIds?: ID[];
  /** Resumable Friday settlement, also retained by a mid-settlement save. */
  settlementStage?: number;
  phase: 'planning' | 'week' | 'gameOver';
  /** First completed event to reach a short-game target; persists even if the
   * holding is subsequently lost. Old saves can only resolve current holdings. */
  targetRace?: {
    mode: 'wealth' | 'territory'; gangId: ID; value: number; target: number;
    week: number; minute: number;
    basis: 'event' | 'initial' | 'legacy' | 'boundary';
    tiedGangIds: ID[];
  };
  outcome: null | {
    won: boolean;
    reason: string;
    score: number;
  };
  blocks: Block[];
  cityLayout?: {
    version: 1;
    tramLines: { name: string; color: string; points: Vec2[]; stops: { name: string; pos: Vec2 }[] }[];
    /** The original generator's terrain, in block coordinates. */
    original?: {
      layout: 1 | 2 | 3;
      railColumn: number | null; station: { x: number; y: number } | null;
      avenues: { cols: number[]; rows: number[] };
      docks: { x: number; y: number } | null;
      notes: string[];
    };
  };
  lots: Record<ID, Lot>;
  buildings: Record<ID, Building>;
  people: Record<ID, Person>;
  gangs: Record<ID, Gang>;
  teams: Record<ID, Team>;
  orders: Record<ID, Order>;
  /** Snapshots of the previous week's orders, for the Last Week's Results report. */
  lastWeekOrders: Order[];
  crimes: CrimeRecord[];
  cases: Record<ID, CourtCase>;
  election: Election;
  /** Set for one week when a gang leader wins the mayoralty. */
  electionWinnerGangId: ID | null;
  news: NewsItem[];
  messages: SimMessage[];
  /** How far behind their timetable the cars have fallen, stopping for crossings. */
  traffic?: import('./traffic').TrafficState;
  /** Original city: how far behind their timetable the street trams have
   * fallen, standing for boarders (trams.ts); absent until one first stands. */
  trams?: import('./trams').TramState;
  /** Denormalised lookups rebuilt on load. */
  mayorId: ID;
  policeChiefId: ID;
  fbiHeadId: ID;
  /** Original city: the FBI's zeal (FBI+4), 128 + rand%80, rolled once a game. */
  fbiZeal?: number;
  /** Original city: the payroll crackdown falls due at the next FBI turn (FBI+0x16C). */
  fbiCrackdownDue?: boolean;
  judgeIds: ID[];
  daIds: ID[];
  snitchIds: ID[];
  policeIds: ID[];
  fbiIds: ID[];
  gridW: number;
  gridH: number;
  nextId: ID;
  /** Whose books the accountant will inspect this week, per gang. */
  auditTargets: Record<ID, ID>;
  /** Saved specialist visits, retained for the current/previous week's reports. */
  specialistJobs?: Record<ID, SpecialistJob>;
  vehicleFleet?: Record<string, FleetVehicle>;
  /** Automatic business haulage; employees, not the boss's allocated hood cars. */
  goodsDeliveries?: Record<ID, GoodsDelivery>;
  /** Actual gross and handed-over money for audits; never inferred from loyalty later. */
  personTakings?: Record<ID, { week: number; gross: number; declared: number }>;
  /** Results of the last audit, per gang. */
  auditResults: Record<ID, { personId: ID; brought: number; declared: number } | null>;
  /** Per-week accumulators the UI reads. */
  weekLog: string[];
}
