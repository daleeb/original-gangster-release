import { rollOriginalProfile, startingHostility, stanceOfHostility } from './aiStance';
import { BLOCK_SIZE, CITIZENS_PER_BLOCK, MAYOR_INITIAL_TERM_WEEKS, SNITCH_COUNT } from './constants';
import { BUILDING_BY_ID, BUILDING_TYPES, coverQuality } from './data/buildings';
import {
  FEMALE_FIRST,
  GANG_SURNAMES,
  MALE_FIRST,
  NEWSPAPER_NAMES,
  NICKNAMES,
  SURNAMES,
} from './data/names';
import { Rng } from './rng';
import { BLOCK_MODULE_BY_ID, MODULE_BUILDING_TYPES } from './blockModules';
import { pavementSpawn } from './streetPlacement';
import { activeBlocks, blockPavement, blockRect, churchCountForSize, hasFootway, layOutCity } from './cityLayout';
import { ORIGINAL_ECONOMICS } from './data/originalEconomics';
import { ourTypeForOriginalKind } from './data/originalKinds';
import { createOriginalBusinessSeeding } from './originalBusinesses';
import { originalStartingSites, placeOriginalHeadquarters } from './originalBootstrap';
import { replenishOriginalRecruits } from './recruitPool';
import { C as OC, generateOriginalCitySafe, isParkContent, isRiverContent } from './originalCityGen';
import { originalTramLines } from './trams';
import { bossFace, heritageOfSurname, sitterFromSeed } from './heritage';
import { bossName, generatedCityDimensions, isOriginalCity, potentialTerritoryCapacity, validateTerritoryTarget } from './newGameValidation';

/** Constants.xtx line 13 (400 police) for the original 40 × 32 city. Line 1
 * gives 2,000 civilians, but our blocks are larger relative to a person than
 * the original's, so 2,000 left the pavements about a third as busy as the
 * original's at its figure size; we chose 6,000 (29 September) to match
 * the original's street density rather than its head count. */
const ORIGINAL_CIVILIANS = 6000, ORIGINAL_POLICE = 400;
import {
  SKILLS,
  type Block,
  type Building,
  type BuildingType,
  type DistrictKind,
  type GameOptions,
  type Gang,
  type GangColorName,
  type ID,
  type Lot,
  type Person,
  type PersonRole,
  type Skills,
  type Team,
  type Vec2,
  type WorldState,
} from './types';
import { CENTRE_LOT, blockCenter, gangMembers, lotCenter } from './world';
import { originalStartingWage } from './originalWages';
import { protectionFee } from './premises';
import { forgetEntityLists } from './entityLists';

export function newId(w: WorldState): ID {
  return w.nextId++;
}

function makeSkills(rng: Rng, quality = 1): Skills {
  const s = {} as Skills;
  for (const k of SKILLS) {
    const raw = rng.bell(0.5, 5.2) * quality;
    s[k] = Math.max(0.5, Math.min(5, Math.round(raw * 2) / 2));
  }
  return s;
}

function makeName(rng: Rng, female: boolean): string {
  const first = female ? rng.pick(FEMALE_FIRST) : rng.pick(MALE_FIRST);
  return `${first} ${rng.pick(SURNAMES)}`;
}

export function createPerson(
  w: WorldState,
  rng: Rng,
  role: PersonRole,
  pos: Vec2,
  opts: Partial<Person> & { quality?: number } = {},
): Person {
  const female = opts.female ?? rng.chance(role === 'hood' ? 0.22 : 0.4);
  const p: Person = {
    id: newId(w),
    name: opts.name ?? makeName(rng, female),
    female,
    portrait: opts.portrait ?? rng.int(0, 23),
    role,
    skills: opts.skills ?? makeSkills(rng, opts.quality ?? 1),
    gangId: opts.gangId ?? null,
    teamId: null,
    buildingId: opts.buildingId ?? null,
    pay: opts.pay ?? 0,
    payDemand: opts.payDemand ?? 0,
    loyalty: 70,
    opinion: {},
    status: 'active',
    wanted: 0,
    pos: { x: pos.x, y: pos.y },
    dest: null,
    path: [],
    inVehicle: false,
    orderId: null,
    jailWeeks: 0,
    bribedBy: null,
    employedBy: null,
    weeklyRetainer: 0,
    snitchKnows: [],
    hp: 100,
    diedWeek: 0,
    interrogationValue: 0,
    capturedBy: null,
    streetOrder: null,
  };
  w.people[p.id] = p;
  return p;
}

/** Pay demand for a hood scales with their overall quality. */
export function hoodPayDemand(p: Person, role: PersonRole): number {
  let total = 0;
  for (const k of SKILLS) total += p.skills[k];
  const avg = total / SKILLS.length;
  let base = 30 + avg * 26;
  if (role === 'lieutenant') base += 50;
  if (role === 'accountant' || role === 'lawyer') base = 90 + avg * 44;
  return Math.round(base / 5) * 5;
}

function districtFor(gx: number, gy: number, w: number, h: number, industrialEdge: number): DistrictKind {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const dx = (gx - cx) / (w / 2);
  const dy = (gy - cy) / (h / 2);
  const r = Math.hypot(dx, dy);

  // Industrial occupies one full edge strip.
  const onIndustrialEdge =
    (industrialEdge === 0 && gy <= 1) ||
    (industrialEdge === 1 && gx >= w - 2) ||
    (industrialEdge === 2 && gy >= h - 2) ||
    (industrialEdge === 3 && gx <= 1);
  if (onIndustrialEdge) return 'industrial';

  if (r < 0.28) return 'downtown';
  if (r < 0.42) return 'civic';
  if (r < 0.72) return 'commercial';
  return 'residential';
}

function pickBuildingType(rng: Rng, district: DistrictKind, varied = false): BuildingType {
  const entries = BUILDING_TYPES.filter((t) => t.id !== 'church' && (t.weight[district] ?? 0) > 0 &&
    (!varied || !['church', 'hospital', 'cityHall', 'courthouse', 'policeHQ', 'docks', 'railroad'].includes(t.id))).map((t) => ({
    item: t,
    weight: t.weight[district] ?? 0,
  }));
  if (!entries.length) return BUILDING_BY_ID.tenementPoor;
  return rng.weighted(entries);
}

function makeBuilding(
  w: WorldState,
  lot: Lot,
  block: Block,
  typeId: string,
  gangIds: ID[],
): Building {
  const t = BUILDING_BY_ID[typeId];
  const b: Building = {
    id: newId(w),
    lotId: lot.id,
    blockId: block.id,
    typeId,
    cls: t.cls,
    ownerGangId: null,
    managerId: null,
    ownerPersonId: null,
    state: t.cls === 'empty' ? 'empty' : 'trading',
    protection: null,
    frontId: null,
    hidesId: null,
    stock: { liquor: 0, stolen: 0, counterfeit: 0 },
    lastProfit: 0,
    repairCost: 0,
    cover: 0,
    fbiSuspicion: 0,
    discovered: false,
    knowledge: Object.fromEntries(gangIds.map((g) => [g, 0])) as Record<ID, number>,
    guardIds: [],
    isHQ: false,
  };
  w.buildings[b.id] = b;
  lot.buildingId = b.id;
  return b;
}

/** An empty-land placeholder occupying a lot. */
const EMPTY_TYPE: BuildingType = {
  id: 'emptyLand',
  name: 'Empty Land',
  cls: 'empty',
  cost: 1400,
  profit: 0,
  weight: {},
  storeys: 0,
};

const ORIGINAL_CIVIC_TYPES: Record<number, string> = {
  [OC.CITY_HALL]: 'cityHall', [OC.HOSPITAL]: 'hospital', [OC.POLICE_HQ]: 'policeHQ', [OC.EMPLOYMENT]: 'labourExchange',
  [OC.FIRE_DEPT]: 'firehouse', [OC.US_POST]: 'usPost', [OC.MUSEUM]: 'museum', [OC.COURTHOUSE]: 'courthouse',
  [OC.BATHS]: 'publicBaths', [OC.FBI_HQ]: 'fbiHQ', [OC.ORPHANAGE]: 'orphanage', [OC.SCHOOL]: 'school',
  [OC.CHURCH_H]: 'church', [OC.CHURCH_V_LOWER]: 'church', [OC.CHURCH_V_UPPER]: 'church', [OC.POWER_PLANT]: 'powerPlant',
  [OC.WATER_PLANT]: 'waterPlant', [OC.STATION]: 'railroad', [OC.RADIO]: 'radioStation', [OC.NEWSPAPER]: 'newspaper',
  [OC.DOCKS]: 'docks',
};
const ORIGINAL_PARK_NAMES = ['Temperance Park', 'Oak Square', 'Lincoln Park', 'Riverside Gardens'];

function originalBlockUse(c: number): NonNullable<Block['layout']>['use'] {
  if (isParkContent(c)) return 'park';
  if (c === OC.PLAZA) return 'plaza';
  if (c === OC.AVENUE_H || c === OC.AVENUE_V || c === OC.AVENUE_CROSSING || c === OC.RAIL_OVER_AVENUE || c === OC.BRIDGE) return 'avenue';
  if (isRiverContent(c) || c === OC.RAIL_BRIDGE) return 'water';
  return ORIGINAL_CIVIC_TYPES[c] ? 'civic' : 'urban';
}

function originalDistrict(c: number, lv: number): DistrictKind {
  if (ORIGINAL_CIVIC_TYPES[c] && ![OC.DOCKS, OC.STATION, OC.POWER_PLANT, OC.WATER_PLANT].includes(c as 9)) return 'civic';
  if ((c >= 10 && c <= 14) || [OC.DOCKS, OC.STATION, OC.POWER_PLANT, OC.WATER_PLANT].includes(c as 9)) return 'industrial';
  if ((c >= 15 && c <= 18) || c === OC.DEPARTMENT_STORE || c === OC.BANK_LARGE || c === OC.HOTEL_LARGE) return lv >= 150 ? 'downtown' : 'commercial';
  return 'residential';
}

/**
 * The original 40 × 32 city: the ported generator (originalCityGen) with the
 * original business placers (originalBusinesses), replayed into blocks, lots and
 * buildings. Each block's 3 × 3 interior cells become parcels; parks and church
 * grounds join into single sites. Gameplay types come from ORIGINAL_KIND_TYPES.
 */
function buildOriginalCity(w: WorldState, rng: Rng, gangIds: ID[]): void {
  const seeding = createOriginalBusinessSeeding();
  const plan = generateOriginalCitySafe({ seed: w.options.seed,
    churches: churchCountForSize(Math.min(w.gridW, w.gridH)), builder: seeding.builder });
  const W = plan.w, at = (x: number, y: number) => y * W + x;
  for (let gy = 0; gy < plan.h; gy++) for (let gx = 0; gx < W; gx++) {
    const content = plan.content[at(gx, gy)], lv = plan.landValue[at(gx, gy)];
    const district = originalDistrict(content, lv);
    const rail = content === OC.RAIL || content === OC.RAIL_BRIDGE || content === OC.RAIL_OVER_AVENUE || content === OC.STATION;
    w.blocks.push({
      id: w.blocks.length, gx, gy, district, center: blockCenter(gx, gy), lotIds: [],
      landValue: Math.round(lv * 100 / 255),
      squalor: district === 'residential' ? rng.int(30, 70) : district === 'industrial' ? rng.int(28, 60) : rng.int(5, 34),
      crimeHeat: 0, policePresence: 0,
      original: { content, landValue: lv },
      layout: { spanX: 1, spanY: 1, use: originalBlockUse(content), streetInset: 3, ...(rail ? { rail: true } : {}) },
    });
  }
  // Parks and church grounds are single sites; streets inside them disappear.
  let parkName = 0;
  for (const park of plan.parks) {
    const cells: Block[] = [];
    for (let y = park.y; y < park.y + park.h; y++) for (let x = park.x; x < park.x + park.w; x++) cells.push(w.blocks[at(x, y)]);
    const church = cells.find(b => ORIGINAL_CIVIC_TYPES[b.original!.content] === 'church');
    if (!cells.every(b => b === church || isParkContent(b.original!.content))) continue;
    const root = cells[0];
    for (const b of cells) b.layout = b === root
      ? { ...b.layout!, spanX: park.w, spanY: park.h, use: church ? 'civic' : 'park',
        ...(church ? { landmark: 'church', name: `St. ${['Michael’s', 'Mary’s', 'Joseph’s', 'Patrick’s'][plan.churches.indexOf(plan.churches.find(p => at(p.x, p.y) === church.id)!)]}` }
          : { name: ORIGINAL_PARK_NAMES[parkName++ % ORIGINAL_PARK_NAMES.length] }) }
      : { ...b.layout!, use: church ? 'civic' : 'park', mergedInto: root.id };
    if (church) root.original = church.original, root.district = 'civic';
    const r = blockRect(root); root.center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  const addLot = (block: Block, index: number, rect: { x: number; y: number; w: number; h: number }, typeId: string, originalKind?: number) => {
    const id = newId(w);
    const lot: Lot = { id, blockId: block.id, index, buildingId: -1, bounds: rect,
      center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } };
    w.lots[id] = lot; block.lotIds.push(id);
    const b = makeBuilding(w, lot, block, typeId, gangIds);
    if (originalKind != null) b.originalKind = originalKind;
    return b;
  };
  const cellRect = (block: Block, cells: number[]) => {
    const r = blockRect(block), cw = r.w / 3, ch = r.h / 3;
    const cols = cells.map(c => c % 3), rows = cells.map(c => Math.floor(c / 3));
    const c0 = Math.min(...cols), c1 = Math.max(...cols), r0 = Math.min(...rows), r1 = Math.max(...rows);
    return { x: r.x + c0 * cw, y: r.y + r0 * ch, w: (c1 - c0 + 1) * cw, h: (r1 - r0 + 1) * ch };
  };
  let paper = 0;
  for (const block of w.blocks) {
    const l = block.layout!;
    if (l.mergedInto != null || l.use === 'park' || l.use === 'plaza' || l.use === 'avenue' || l.use === 'water') continue;
    const content = block.original!.content, fill = seeding.fills.get(at(block.gx, block.gy));
    if (l.use === 'civic') {
      const typeId = ORIGINAL_CIVIC_TYPES[content];
      l.landmark = typeId;
      const r = blockRect(block), church = typeId === 'church';
      const width = church ? Math.min(r.w * .7, 21) : r.w - 2, height = church ? Math.min(r.h * .65, 38) : r.h - 2;
      const b = addLot(block, 1, { x: block.center.x - width / 2, y: block.center.y - height / 2, w: width, h: height },
        typeId, fill?.businesses[0]?.kind);
      if (typeId === 'newspaper') b.paperName = NEWSPAPER_NAMES[paper++ % NEWSPAPER_NAMES.length];
      continue;
    }
    if (!fill) { addLot(block, CENTRE_LOT, cellRect(block, [CENTRE_LOT]), EMPTY_TYPE.id); continue; }
    const houses: number[] = [], tenement: number[] = [];
    fill.cells.forEach((c, i) => { if (c?.use === 'house') houses.push(i); else if (c?.use === 'tenement') tenement.push(i); });
    if (tenement.length) {
      const lv = block.original!.landValue;
      addLot(block, tenement[0], cellRect(block, tenement), lv < 56 ? 'tenementPoor' : 'tenementMid', 170);
    }
    if (houses.length) {
      // Row houses and shop frontage: one terrace per interior column.
      for (const col of [0, 1, 2]) {
        const cells = houses.filter(i => i % 3 === col);
        if (!cells.length) continue;
        const runs: number[][] = [];
        for (const i of cells) (runs.at(-1)?.at(-1) === i - 3 ? runs.at(-1)! : (runs.push([]), runs.at(-1)!)).push(i);
        for (const run of runs) addLot(block, run.includes(CENTRE_LOT) ? run.find(i => i !== CENTRE_LOT) ?? run[0] : run[0],
          cellRect(block, run), 'residence', 151);
      }
    }
    fill.businesses.forEach(biz => addLot(block, biz.master, cellRect(block, biz.cells),
      ourTypeForOriginalKind(ORIGINAL_ECONOMICS[biz.kind]), biz.kind));
    fill.cells.forEach((c, i) => {
      if (c?.use === 'lot') addLot(block, i, cellRect(block, [i]), EMPTY_TYPE.id);
      else if (c?.use === 'soupKitchen') addLot(block, i, cellRect(block, [i]), 'soupKitchen', 153);
    });
  }
  w.cityLayout = { version: 1, tramLines: [], original: { layout: plan.layout, railColumn: plan.railColumn,
    station: plan.station, avenues: plan.avenues, docks: plan.docks, notes: plan.notes } };
  // The avenues are tramways (0x4EC3D0, 0x53A520): one line down the middle of each.
  w.cityLayout.tramLines = originalTramLines(w);
}

export function createWorld(options: GameOptions): { world: WorldState; rng: Rng } {
  const { w: width, h: height } = generatedCityDimensions(options);
  const blockCount = width * height, original = isOriginalCity(options);
  validateTerritoryTarget(options, blockCount);
  const rng = new Rng(options.seed);

  const w: WorldState = {
    schemaVersion: 2,
    sequences: { message: 1, crime: 1, court: 1 },
    options,
    rngState: rng.state,
    week: 1,
    minute: 0,
    phase: 'planning',
    outcome: null,
    blocks: [],
    lots: {},
    buildings: {},
    people: {},
    gangs: {},
    teams: {},
    orders: {},
    lastWeekOrders: [],
    crimes: [],
    cases: {},
    election: { active: false, weeksLeft: 0, candidates: [], lastResultWeek: 0 },
    electionWinnerGangId: null,
    news: [],
    messages: [],
    mayorId: -1,
    policeChiefId: -1,
    fbiHeadId: -1,
    judgeIds: [],
    daIds: [],
    snitchIds: [],
    policeIds: [],
    fbiIds: [],
    gridW: width,
    gridH: height,
    nextId: 1,
    auditTargets: {},
    auditResults: {},
    weekLog: [],
  };

  // Register the empty-land pseudo type so lookups never miss.
  BUILDING_BY_ID[EMPTY_TYPE.id] = EMPTY_TYPE;

  const gangIds: ID[] = [1, 2, 3, 4]; // ids assigned below, kept stable
  const industrialEdge = rng.int(0, 3);

  const halfW = Math.floor(width / 2), halfH = Math.floor(height / 2);
  const corners: ((b: Block) => boolean)[] = [
    (b) => b.gx < halfW && b.gy < halfH,
    (b) => b.gx >= halfW && b.gy < halfH,
    (b) => b.gx < halfW && b.gy >= halfH,
    (b) => b.gx >= halfW && b.gy >= halfH,
  ];
  if (original) buildOriginalCity(w, rng, gangIds);
  else {
    // ------------------------------------------------------------ blocks & lots
    for (let gy = 0; gy < height; gy++) {
      for (let gx = 0; gx < width; gx++) {
        const district = districtFor(gx, gy, width, height, industrialEdge);
        const block: Block = {
          id: w.blocks.length,
          gx,
          gy,
          district,
          center: blockCenter(gx, gy),
          lotIds: [],
          landValue:
            district === 'downtown'
              ? rng.int(72, 96)
              : district === 'civic'
                ? rng.int(52, 74)
                : district === 'commercial'
                  ? rng.int(38, 66)
                  : district === 'industrial'
                    ? rng.int(22, 48)
                    : rng.int(16, 44),
          squalor:
            district === 'residential' ? rng.int(30, 70) : district === 'industrial' ? rng.int(28, 60) : rng.int(5, 34),
          crimeHeat: 0,
          policePresence: 0,
        };
        w.blocks.push(block);

        // Varied cities place complete authored kits in layOutCity. Do not first
        // generate a disposable 3x3 block and then rebuild every urban parcel.
        if (options.cityLayout === 'varied') continue;
        for (let i = 0; i < 9; i++) {
          const lot: Lot = {
            id: newId(w),
            blockId: block.id,
            index: i,
            center: lotCenter(gx, gy, i),
            buildingId: -1,
          };
          w.lots[lot.id] = lot;
          block.lotIds.push(lot.id);
        }
      }
    }

    if (options.cityLayout === 'varied') layOutCity(w, rng);

    // ------------------------------------------------------------ buildings
    for (const block of w.blocks) {
      const module = block.layout?.module ? BLOCK_MODULE_BY_ID[block.layout.module.id] : undefined;
      for (const lotId of block.lotIds) {
        const lot = w.lots[lotId];
        if (lot.index === CENTRE_LOT) {
          // Centre lots start as empty land — the only place illegal sites may go.
          makeBuilding(w, lot, block, EMPTY_TYPE.id, gangIds);
          continue;
        }
        const slot = module?.plots.find(p => p.index === lot.index);
        const family = slot ? MODULE_BUILDING_TYPES[slot.use].map(id => BUILDING_BY_ID[id]) : [];
        const suited = family.filter(t => (t.weight[block.district] ?? 0) > 0);
        const t = block.layout?.landmark ? BUILDING_BY_ID[block.layout.landmark]
          : slot ? rng.weighted((suited.length ? suited : family).map(item => ({ item, weight: item.weight[block.district] ?? 1 })))
            : pickBuildingType(rng, block.district, !!w.cityLayout);
        makeBuilding(w, lot, block, slot?.vacant ? EMPTY_TYPE.id : t.id, gangIds);
      }
    }

    // ------------------------------------------------------------ landmark placement
    const placedSpecials = new Set<ID>();
    const placeSpecial = (typeId: string, pred: (b: Block) => boolean): Building | null => {
      const reserved = Object.values(w.buildings).find(b => b.typeId === typeId &&
        w.blocks[b.blockId].layout?.landmark === typeId && !placedSpecials.has(b.id));
      if (reserved) { placedSpecials.add(reserved.id); return reserved; }
      const availableLots = (b: Block) => b.lotIds.map(id => w.lots[id]).filter(l =>
        l.index !== CENTRE_LOT && !placedSpecials.has(l.buildingId));
      const candidates = w.blocks.filter(b => pred(b) && b.lotIds.length > 1 && b.layout?.use !== 'civic' && availableLots(b).length > 0);
      if (!candidates.length) return null;
      const blk = rng.pick(candidates);
      const edgeLots = availableLots(blk);
      if (!edgeLots.length) return null;
      const lot = rng.pick(edgeLots);
      const old = w.buildings[lot.buildingId];
      if (old) delete w.buildings[old.id];
      const building = makeBuilding(w, lot, blk, typeId, gangIds);
      placedSpecials.add(building.id);
      return building;
    };

    placeSpecial('cityHall', (b) => b.district === 'civic');
    placeSpecial('courthouse', (b) => b.district === 'civic');
    placeSpecial('policeHQ', (b) => b.district === 'civic');
    placeSpecial('hospital', (b) => b.district === 'civic' || b.district === 'commercial');

    // Four newspapers, one to a corner region.
    corners.forEach((pred, i) => {
      const nb = placeSpecial('newspaper', (b) => pred(b) && b.district !== 'industrial');
      if (nb) {
        nb.paperName = NEWSPAPER_NAMES[i];
      }
    });

    placeSpecial('docks', (b) => b.district === 'industrial');
    placeSpecial('railroad', (b) => b.district === 'industrial');
    for (let i = 0; i < churchCountForSize(Math.min(width, height)); i++) placeSpecial('church', (b) => b.district === 'residential' || b.district === 'civic');
    placeSpecial('orphanage', (b) => b.district === 'residential');
    placeSpecial('labourExchange', (b) => b.district === 'industrial' || b.district === 'civic');
    for (let i = 0; i < 3; i++) placeSpecial('tradeUnion', (b) => b.district === 'industrial');

    // Guarantee enough recruit sites and a main bank.
    placeSpecial('bankLarge', (b) => b.district === 'downtown');
    for (let i = 0; i < 5; i++) placeSpecial('gym', (b) => b.district !== 'downtown');
    for (let i = 0; i < 5; i++) placeSpecial('poolHall', (b) => b.district !== 'downtown');
    for (let i = 0; i < 3; i++) placeSpecial('accountancy', (b) => b.district === 'downtown' || b.district === 'civic');
    for (let i = 0; i < 3; i++) placeSpecial('lawFirm', (b) => b.district === 'downtown' || b.district === 'civic');
    for (let i = 0; i < 3; i++) placeSpecial('warehouse', (b) => b.district === 'industrial');

  }
  // People never start on the river or in the middle of an avenue.
  const streetBlocks = activeBlocks(w).filter(hasFootway);
  const streetSpawn = (b: Block) => w.cityLayout ? blockPavement(b, w.nextId) : pavementSpawn(b.center, w.nextId);

  // ------------------------------------------------------------ civilian population
  for (const b of Object.values(w.buildings)) {
    const t = BUILDING_BY_ID[b.typeId];
    if (!t) continue;
    if (b.cls === 'commercial' || b.cls === 'industrial' || b.cls === 'tenement') {
      const owner = createPerson(w, rng, 'owner', w.lots[b.lotId].center, { buildingId: b.id });
      b.ownerPersonId = owner.id;
    }
    if (t.special === 'church' || t.special === 'orphanage') {
      const priest = createPerson(w, rng, 'clergy', w.lots[b.lotId].center, { buildingId: b.id });
      b.ownerPersonId = priest.id;
    }
    if (t.special === 'newspaper') {
      const editor = createPerson(w, rng, 'reporter', w.lots[b.lotId].center, { buildingId: b.id });
      b.ownerPersonId = editor.id;
      for (let i = 0; i < 2; i++) createPerson(w, rng, 'reporter', w.lots[b.lotId].center, { buildingId: b.id });
    }
  }

  // Officials.
  const civicBlocks = streetBlocks.filter((b) => b.district === 'civic');
  const civicPos = () => {
    const block = rng.pick(civicBlocks.length ? civicBlocks : w.blocks);
    if (w.cityLayout) return blockPavement(block, w.nextId);
    // Civic staff start on a pavement, where they can be seen and selected.
    const side = (w.nextId & 1) ? 1 : -1;
    return { x: block.center.x + side * (BLOCK_SIZE / 2 + 1.6),
      y: block.center.y + ((w.nextId % 13) - 6) * 2 };
  };

  const mayor = createPerson(w, rng, 'mayor', civicPos(), { quality: 1.2 });
  w.mayorId = mayor.id;
  w.election.mayorTerm = { personId: mayor.id, weeks: MAYOR_INITIAL_TERM_WEEKS };
  const chief = createPerson(w, rng, 'policeChief', civicPos(), { quality: 1.15 });
  w.policeChiefId = chief.id;
  const fbiHead = createPerson(w, rng, 'fbiHead', civicPos(), { quality: 1.35 });
  w.fbiHeadId = fbiHead.id;

  for (let i = 0; i < 4; i++) w.judgeIds.push(createPerson(w, rng, 'judge', civicPos(), { quality: 1.1 }).id);
  for (let i = 0; i < 4; i++) w.daIds.push(createPerson(w, rng, 'da', civicPos(), { quality: 1.1 }).id);

  // The original city fixes its totals (Constants.xtx: 2,000 civilians,
  // 400 police); compact cities keep their per-block densities.
  const officerCount = original ? ORIGINAL_POLICE : Math.round(blockCount * 0.22);
  for (let i = 0; i < officerCount; i++) {
    const blk = rng.pick(streetBlocks);
    const p = createPerson(w, rng, 'police', streetSpawn(blk), { quality: 1.05 });
    w.policeIds.push(p.id);
  }
  for (let i = 0; i < 5; i++) {
    const p = createPerson(w, rng, 'fbi', civicPos(), { quality: 1.3 });
    w.fbiIds.push(p.id);
  }
  for (let i = 0; i < SNITCH_COUNT; i++) {
    const p = createPerson(w, rng, 'snitch', streetSpawn(rng.pick(streetBlocks)), {});
    w.snitchIds.push(p.id);
  }

  // The citizens who walk the streets. Every figure on a pavement is one of
  // these: a person with a name who can be clicked on, followed, bribed or
  // shot, so there are enough of them to make a city look lived in.
  const walkerCount = original ? ORIGINAL_CIVILIANS : Math.round(blockCount * (w.cityLayout ? 14 : CITIZENS_PER_BLOCK));
  const ring = BLOCK_SIZE / 2 + 1.6;
  // The original seeds its walkers by the same busy-block weighting as their
  // errands (0x606AF0); here the busier of two random blocks (trading lots).
  const trading = (b: Block) => b.lotIds.filter(id => w.buildings[w.lots[id].buildingId]?.state === 'trading').length;
  for (let i = 0; i < walkerCount; i++) {
    let blk = rng.pick(streetBlocks);
    if (original) { const other = rng.pick(streetBlocks); if (trading(other) > trading(blk)) blk = other; }
    if (w.cityLayout) { createPerson(w, rng, 'citizen', blockPavement(blk, i), {}); continue; }
    // Spread them round the pavement, not stacked on the block's centre point,
    // which is under a building.
    const along = (((i * 13) % 41) / 40) * BLOCK_SIZE - BLOCK_SIZE / 2;
    const side = i % 4;
    const at =
      side === 0
        ? { x: blk.center.x + along, y: blk.center.y - ring }
        : side === 1
          ? { x: blk.center.x + ring, y: blk.center.y + along }
          : side === 2
            ? { x: blk.center.x + along, y: blk.center.y + ring }
            : { x: blk.center.x - ring, y: blk.center.y + along };
    createPerson(w, rng, 'citizen', at, {});
  }

  // Unaffiliated hoods available for recruitment, loitering at recruit sites.
  // The original city stocks each site to the original's weekly quota instead.
  if (original) replenishOriginalRecruits(w, rng);
  else {
    const recruitSites = Object.values(w.buildings).filter(
      (b) => BUILDING_BY_ID[b.typeId]?.recruit === 'hood',
    );
    const freeHoodCount = Math.round(blockCount * 0.5);
    for (let i = 0; i < freeHoodCount; i++) {
      const site = recruitSites.length ? rng.pick(recruitSites) : rng.pick(Object.values(w.buildings));
      const p = createPerson(w, rng, 'hood', w.lots[site.lotId].center, {
        quality: rng.chance(0.16) ? 1.35 : 1,
        buildingId: site.id,
      });
      p.payDemand = hoodPayDemand(p, 'hood');
    }
    // Free specialists.
    const acctSites = Object.values(w.buildings).filter((b) => BUILDING_BY_ID[b.typeId]?.recruit === 'accountant');
    const lawSites = Object.values(w.buildings).filter((b) => BUILDING_BY_ID[b.typeId]?.recruit === 'lawyer');
    for (let i = 0; i < 6; i++) {
      const site = acctSites.length ? rng.pick(acctSites) : rng.pick(Object.values(w.buildings));
      const p = createPerson(w, rng, 'accountant', w.lots[site.lotId].center, {
        quality: 1.1,
        buildingId: site.id,
      });
      p.payDemand = hoodPayDemand(p, 'accountant');
    }
    for (let i = 0; i < 6; i++) {
      const site = lawSites.length ? rng.pick(lawSites) : rng.pick(Object.values(w.buildings));
      const p = createPerson(w, rng, 'lawyer', w.lots[site.lotId].center, {
        quality: 1.1,
        buildingId: site.id,
      });
      p.payDemand = hoodPayDemand(p, 'lawyer');
    }
  }

  // ------------------------------------------------------------ gangs
  const colorPool: GangColorName[] = ['red', 'green', 'blue', 'orange'];
  const playerColor = options.playerColor;
  const otherColors = colorPool.filter((c) => c !== playerColor);
  rng.shuffle(otherColors);
  const order: GangColorName[] = [playerColor, ...otherColors];

  // HQ blocks: one per quadrant, biased away from the very centre.
  const quadrantPreds = rng.shuffle([...corners]);
  const surnames = rng.shuffle([...GANG_SURNAMES]);
  // The player's gang carries the boss's surname, and no rival shares it.
  const playerSurname = options.playerName.trim().split(/\s+/).pop();
  if (playerSurname) {
    const plain = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
    const twin = surnames.findIndex((s, i) => i > 0 && plain(s) === plain(playerSurname));
    if (twin >= 0) surnames[twin] = surnames[0];
    surnames[0] = playerSurname;
  }
  const startingRacketChoices = new Map<ID, Building[]>();
  const previousRacketKnowledge = new Map<ID, number>();
  const seedProtection = (b: Building, gangId: ID) => {
    const base = protectionFee(b);
    previousRacketKnowledge.set(b.id, b.knowledge[gangId] ?? 0);
    b.protection = { gangId, weekly: base, base, refusing: false, grievance: 0 };
    b.knowledge[gangId] = Math.max(b.knowledge[gangId] ?? 0, 2);
  };

  // The original city places every HQ by its own rules (Gang_PlaceHeadquarters):
  // gang g in quadrant g, the player top left, fronted by a converted tenement.
  const originalHQs = original ? placeOriginalHeadquarters(w, options.seed, gangIds) : null;

  order.forEach((color, idx) => {
    const isPlayer = idx === 0;
    const gangId = gangIds[idx];
    const pred = quadrantPreds[idx];
    const legalFront = (lot: Lot) => lot.index !== CENTRE_LOT &&
      ['commercial', 'industrial', 'tenement', 'charity'].includes(w.buildings[lot.buildingId]?.cls) &&
      w.buildings[lot.buildingId]?.state === 'trading';
    const hqBlockIds = new Set(Object.values(w.buildings).filter(bb => bb.isHQ).map(bb => bb.blockId));
    const officeBlocks = w.blocks.filter(b => b.lotIds.some(id => w.lots[id].index === CENTRE_LOT) &&
      b.lotIds.some(id => legalFront(w.lots[id])) && !hqBlockIds.has(b.id));
    const candidates = officeBlocks.filter(
      (b) =>
        pred(b) &&
        (b.district === 'commercial' || b.district === 'residential'),
    );
    const hqBlock = originalHQs ? w.blocks[originalHQs[idx].blockId] : rng.pick(candidates.length ? candidates : officeBlocks);

    const bossFemale = isPlayer ? options.playerFemale : rng.chance(0.2);
    const boss = createPerson(w, rng, 'boss', hqBlock.center, {
      name: isPlayer ? bossName(options.playerName, options.playerNickname) : `${rng.pick(bossFemale ? FEMALE_FIRST : MALE_FIRST)} "${rng.pick(NICKNAMES)}" ${surnames[idx]}`,
      female: bossFemale,
      portrait: isPlayer ? options.playerPortrait : rng.int(0, 23),
      quality: 1.3,
      gangId,
    });
    // A painted boss portrait: the player's chosen heritage and sitter; a rival
    // by its surname, with a sitter from the gang id (not the world's random stream).
    const heritage = isPlayer ? options.playerHeritage : heritageOfSurname(surnames[idx]);
    if (heritage) boss.face = bossFace(heritage, bossFemale,
      isPlayer ? options.playerSitter ?? 0 : sitterFromSeed(options.seed + gangId * 7919));

    let personality: 'passive' | 'normal' | 'aggressive' = 'normal';
    if (!isPlayer) {
      personality =
        options.opponents === 'random'
          ? rng.pick(['passive', 'normal', 'aggressive'] as const)
          : options.opponents;
    }

    const gang: Gang = {
      id: gangId,
      name: `The ${surnames[idx]} Gang`,
      color,
      bossId: boss.id,
      isPlayer,
      personality,
      ...(original && !isPlayer ? { aiProfile: rollOriginalProfile(options.opponents, rng) } : {}),
      cash: options.startMoney,
      teamIds: [],
      poolIds: [],
      accountantId: null,
      lawyerId: null,
      // The player's three pistols all start in the cache, to be handed out as he
      // sees fit; a computer gang's first crew starts with one of them.
      weapons: { pistol: isPlayer ? 3 : 2, shotgun: 0, rifle: 0, tommy: 0, twinPistols: 0, explosives: 0 },
      vehicles: { coupe: 1, truck: 0, speedster: 0 },
      offered: {},
      known: {},
      evadingTax: false,
      taxEvaded: [],
      uncoveredTax: 0,
      riskyMoney: 0,
      suspicion: 0,
      evidence: 0,
      goingStraight: false,
      runningForOffice: false,
      campaignSpend: 0,
      popularity: 0,
      goodwill: 0,
      eliminated: false,
      snitchUsedWeek: -1,
      employedPoliceIds: [],
      recruitIds: [],
      prisonerIds: [],
      knownPeople: [],
      history: [],
      lastWeekIncome: { legal: 0, illegal: 0, protection: 0, other: 0 },
      lastWeekCosts: { wages: 0, purchases: 0, upkeep: 0 },
    };
    w.gangs[gangId] = gang;

    // HQ: a legal front on an edge lot plus the office in the centre lot.
    const edgeLots = hqBlock.lotIds.map((id) => w.lots[id]).filter((l) => l.index !== CENTRE_LOT);
    // Keep the seeded choice when it is a real legal business. A fire station,
    // other civic service or empty plot cannot serve as the gang's street front.
    const candidateLot = originalHQs ? w.lots[w.buildings[originalHQs[idx].frontBuildingId].lotId] : rng.pick(edgeLots);
    const frontLot = legalFront(candidateLot) ? candidateLot : edgeLots.find(legalFront)!;
    const front = w.buildings[frontLot.buildingId];
    front.ownerGangId = gangId;
    front.knowledge[gangId] = 4;

    const centreLot = hqBlock.lotIds.map(id => w.lots[id]).find(l => l.index === CENTRE_LOT)!;
    const officeOld = w.buildings[centreLot.buildingId];
    if (officeOld) delete w.buildings[officeOld.id];
    const office = makeBuilding(w, centreLot, hqBlock, 'office', gangIds);
    office.ownerGangId = gangId;
    office.isHQ = true;
    office.frontId = front.id;
    office.cover = coverQuality('office', front.typeId);
    office.knowledge[gangId] = 4;
    front.hidesId = office.id;

    boss.buildingId = office.id;
    boss.pos = { ...w.lots[office.lotId].center };

    // Manual p.31: one front manager, a two-person team, then reserves in the pool.
    const hoodCount = Math.max(3, Math.min(10, options.startHoods));
    const hoods: Person[] = [];
    for (let i = 0; i < hoodCount; i++) {
      const p = createPerson(w, rng, 'hood', w.lots[office.lotId].center, {
        quality: i === 0 ? 1.15 : 1,
        gangId,
      });
      p.payDemand = hoodPayDemand(p, 'hood');
      p.pay = p.payDemand;
      hoods.push(p);
    }

    // First hood manages the front.
    const manager = hoods.shift()!;
    manager.buildingId = front.id;
    manager.pos = { ...w.lots[front.lotId].center };
    front.managerId = manager.id;

    // Promote the best organiser to lieutenant and build the team.
    hoods.sort(
      (a, b) =>
        b.skills.organization + b.skills.intelligence - (a.skills.organization + a.skills.intelligence),
    );
    const lt = hoods.shift()!;
    lt.role = 'lieutenant';
    lt.payDemand = hoodPayDemand(lt, 'lieutenant');
    lt.pay = lt.payDemand;

    const team: Team = {
      id: newId(w),
      gangId,
      lieutenantId: lt.id,
      name: lt.name.split(' ')[0] + "'s Crew",
      memberIds: [],
      weapons: { pistol: isPlayer ? 0 : 1, shotgun: 0, rifle: 0, tommy: 0, twinPistols: 0, explosives: 0 },
      vehicles: { coupe: 1, truck: 0, speedster: 0 },
      allocatedBlockIds: [],
      orderIds: [],
      timeUsed: 0,
    };
    w.teams[team.id] = team;
    gang.teamIds.push(team.id);
    lt.teamId = team.id;

    for (const h of hoods) {
      if (team.memberIds.length === 0) {
        team.memberIds.push(h.id);
        h.teamId = team.id;
      } else {
        gang.poolIds.push(h.id);
      }
    }

    // Pre-extorted businesses near the HQ.
    const extra = Math.max(0, Math.min(10, options.startBusinesses) - 1);
    const nearby = w.blocks
      .filter((b) => Math.abs(b.gx - hqBlock.gx) <= 2 && Math.abs(b.gy - hqBlock.gy) <= 2)
      .flatMap((b) => b.lotIds.map((id) => w.buildings[w.lots[id].buildingId]))
      .filter(
        (b): b is Building =>
          !!b && b.cls !== 'empty' && b.cls !== 'illegal' && b.cls !== 'municipal' && b.cls !== 'charity' &&
          b.cls !== 'residential' && !b.protection,
      );
    if (originalHQs) {
      // Business and tenement masters in the original's spiral order from the front.
      nearby.splice(0, nearby.length, ...originalStartingSites(w, originalHQs[idx]));
    } else rng.shuffle(nearby);
    startingRacketChoices.set(gangId, nearby);
    for (let i = 0; i < Math.min(extra, nearby.length); i++) {
      seedProtection(nearby[i], gangId);
    }
  });

  // All four fronts must be reserved before finalizing the starting rackets.
  // A previously selected site can become a later gang's front; a gang's own
  // front can also have been picked. Neither is an additional extorted business
  // (manual p.31). Keep valid seeded choices and the existing RNG sequence.
  for (const b of Object.values(w.buildings)) {
    if (b.ownerGangId == null || !b.protection) continue;
    const protector = b.protection.gangId;
    if (protector !== b.ownerGangId) b.knowledge[protector] = previousRacketKnowledge.get(b.id) ?? 0;
    b.protection = null;
  }
  const startingExtras = Math.max(0, Math.min(10, options.startBusinesses) - 1);
  for (const gang of Object.values(w.gangs)) {
    let remaining = startingExtras - Object.values(w.buildings).filter(b => b.protection?.gangId === gang.id).length;
    for (const b of startingRacketChoices.get(gang.id) ?? []) {
      if (remaining <= 0) break;
      if (b.ownerGangId != null || b.protection) continue;
      seedProtection(b, gang.id);
      remaining--;
    }
  }

  // Everyone starts at peace and knows it.
  for (const g of Object.values(w.gangs)) {
    for (const other of Object.values(w.gangs)) {
      if (other.id === g.id) continue;
      g.offered[other.id] = 'peace';
      g.known[other.id] = 'peace';
    }
  }
  // Except that in the original city a computer gang opens toward the player
  // at the stance of its starting hostility (0x6CBE10), and the player sees it.
  if (original) for (const g of Object.values(w.gangs)) for (const other of Object.values(w.gangs)) {
    if (!g.aiProfile || !other.isPlayer) continue;
    g.offered[other.id] = other.known[g.id] = stanceOfHostility(startingHostility(g, other));
  }

  // Opinions start close to neutral; sermons, newspapers and violence move them.
  for (const p of Object.values(w.people)) {
    for (const g of Object.values(w.gangs)) p.opinion[g.id] = rng.int(-6, 6);
  }

  // The original city offers every starting member his own wage quote.
  if (original) for (const g of Object.values(w.gangs))
    for (const p of gangMembers(w, g)) if (p.role !== 'boss') originalStartingWage(p, g.id);

  w.rngState = rng.state;
  if (options.mode === 'territory') validateTerritoryTarget(options, potentialTerritoryCapacity(w));
  forgetEntityLists(w);
  return { world: w, rng };
}
