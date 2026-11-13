import { validateSaveWorld, validateSaveWorldResponsive } from '../sim/saveSchema';
import type { GangColorName, WorldState } from '../sim/types';
import { yieldForInput } from '../yieldForInput';
import { buildingList } from '../sim/entityLists';
import { gangManpower, territoryCount } from '../sim/world';

export interface SaveSlot {
  id: string;
  name: string;
  savedAt: number;
  week: number;
  bossName: string;
  /** The city, when it has been read; null for a listed slot not yet loaded (`lazy`). */
  world: WorldState | null;
  /** Listed from its header only: the city is read when it is loaded (loadSlotWorld). */
  lazy?: boolean;
  /** What the menus show of a slot, recorded when it was saved. */
  summary?: SaveSummary;
  error?: string;
}

export interface SaveSummary { cash: number; blocks: number; men: number; seed: number; finished: boolean }

/** A slot that can be loaded: read already, or waiting on disk. */
export function slotLoadable(slot: SaveSlot): boolean {
  return !slot.error && (!!slot.world || !!slot.lazy);
}

/** The slot's city, reading it from disk if the list held only its header. */
export async function loadSlotWorld(slot: SaveSlot): Promise<SaveSlot> {
  if (slot.world || !slot.lazy) return slot;
  const disk = desktopSaves();
  if (!disk?.read) throw Error('This save is unavailable.');
  return decodeSlot(await disk.read(slot.id), true);
}

/** Portable save envelope, independent of the browser or desktop storage format. */
export async function exportSave(slot: SaveSlot): Promise<string> {
  const loaded = await loadSlotWorld(slot);
  if (!loaded.world || loaded.error) throw Error(loaded.error ?? 'This save is unavailable.');
  return JSON.stringify({ kind: 'original-gangster-save', version: 1, name: loaded.name,
    campaignId: campaignId(loaded.world), world: loaded.world });
}

/** Validate before writing; imported saves never replace an existing slot. */
export async function importSave(text: string): Promise<string> {
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw Error('This file is not valid JSON.'); }
  if (!data || typeof data !== 'object' || data.kind !== 'original-gangster-save' || data.version !== 1)
    throw Error('This is not a supported Original Gangster save file.');
  await validateSaveWorldResponsive(data.world);
  const world = data.world as WorldState;
  if (typeof data.campaignId === 'string' && data.campaignId) campaignIds.set(world, data.campaignId);
  const base = (typeof data.name === 'string' ? data.name.trim() : '').slice(0, 60) || 'Imported game';
  const existing = new Set((await loadGame()).map(slot => slot.id.toLowerCase()));
  let name = base;
  for (let n = 2; existing.has(name.toLowerCase()) || name.toLowerCase() === 'autosave'; n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, 60 - suffix.length) + suffix;
  }
  await saveGame(name, world);
  return name;
}

/** The desktop build's save files (electron/preload.cjs); absent in a browser. */
interface DesktopSaves {
  list(): Promise<unknown[]>;
  /** Present since 1.0.3: list() then gives headers only. */
  read?(id: string): Promise<unknown>;
  write(meta: Record<string, unknown>, worldJson: string): Promise<void>;
  remove(id: string): Promise<void>;
}
const desktopSaves = (): DesktopSaves | undefined =>
  (globalThis as { ogDesktop?: { saves?: DesktopSaves } }).ogDesktop?.saves;
const MIGRATED_KEY = 'og.savesOnDisk';

/** First desktop launch: copy any browser-storage saves to disk, once. */
async function migrateBrowserSaves(disk: DesktopSaves): Promise<void> {
  try { if (localStorage.getItem(MIGRATED_KEY)) return; } catch { /* no storage: try anyway */ }
  let records: unknown[] = [];
  try {
    const db = await openDb();
    try {
      records = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  } catch { records = []; }
  const onDisk = new Set((await disk.list()).map(r => (r as { id?: unknown }).id));
  for (const raw of records) {
    const { worldJson, world, ...meta } = raw as Record<string, unknown>;
    if (typeof meta.id !== 'string' || onDisk.has(meta.id)) continue;
    const json = typeof worldJson === 'string' ? worldJson : world != null ? JSON.stringify(world) : null;
    // One record the disk refuses (an old, over-long name) must not hide every
    // other save on every launch.
    if (json) try { await disk.write(meta, json); } catch (e) { console.warn('A browser save could not be copied to disk:', e); }
  }
  try { localStorage.setItem(MIGRATED_KEY, '1'); } catch { /* retried next launch; writes skip existing slots */ }
}

const DB_NAME = 'original-gangster';
const STORE = 'saves';
const VERSION = 1;

// Identity belongs to the save envelope, not deterministic simulation state.
const campaignIds = new WeakMap<WorldState, string>();
function campaignId(world: WorldState): string {
  let id = campaignIds.get(world);
  if (!id) { id = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join(''); campaignIds.set(world, id); }
  return id;
}

/** Keep save identity when installing an independent copy of a stored world. */
export function cloneSavedWorld(world: WorldState): WorldState {
  const snapshot = JSON.parse(JSON.stringify(world)) as WorldState;
  campaignIds.set(snapshot, campaignId(world));
  return snapshot;
}

/** Copy a stored snapshot without joining serialization and parsing in one task. */
export async function cloneSavedWorldResponsive(world: WorldState, signal?: AbortSignal): Promise<WorldState> {
  const json = await stringifyFrozenWorld(world, signal);
  await yieldForInput();
  signal?.throwIfAborted();
  const snapshot = JSON.parse(json) as WorldState;
  // Parsing is native and indivisible; give input a turn before validation.
  await yieldForInput();
  signal?.throwIfAborted();
  campaignIds.set(snapshot, campaignId(world));
  return snapshot;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    let blocked = false;
    req.onblocked = () => { blocked = true; reject(new Error("Save storage is busy in another window. Close it and retry.")); };
    req.onsuccess = () => {
      if (blocked) { req.result.close(); return; }
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** The caller holds the world still while this bounded snapshot is assembled. */
async function stringifyFrozenWorld(world: WorldState, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const parts: string[] = ['{'];
  let deadline = performance.now() + 6;
  let first = true;
  for (const [key, value] of Object.entries(world)) {
    if (value === undefined) continue;
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(key), ':');
    if (value && typeof value === 'object') {
      const array = Array.isArray(value);
      parts.push(array ? '[' : '{');
      let itemFirst = true;
      for (const [id, item] of array ? value.entries() : Object.entries(value)) {
        const json = JSON.stringify(item);
        if (json === undefined && !array) continue;
        if (!itemFirst) parts.push(',');
        itemFirst = false;
        if (!array) parts.push(JSON.stringify(id), ':');
        parts.push(json ?? 'null');
        if (performance.now() >= deadline) {
          await yieldForInput();
          signal?.throwIfAborted();
          deadline = performance.now() + 6;
        }
      }
      parts.push(array ? ']' : '}');
    } else parts.push(JSON.stringify(value));
  }
  parts.push('}');
  return parts.join('');
}

let writeQueue: Promise<unknown> = Promise.resolve();
function oneWriteAtATime<T>(write: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(write, write);
  writeQueue = run.catch(() => {});
  return run;
}

export async function saveGame(name: string, world: WorldState, frozen = false): Promise<void> {
  const boss = Object.values(world.gangs).find((g) => g.isPlayer);
  const summary: SaveSummary = {
    cash: Math.round(boss?.cash ?? 0), blocks: boss ? territoryCount(world, boss.id) : 0,
    men: boss ? gangManpower(world, boss) : 0, seed: world.options?.seed ?? 1928, finished: world.phase === 'gameOver',
  };
  const metadata = {
    id: name,
    name,
    savedAt: Date.now(),
    campaignId: campaignId(world),
    week: world.week,
    bossName: boss ? (world.people[boss.bossId]?.name ?? 'Unknown') : 'Unknown',
    summary,
  };
  // Store JSON directly: parsing only to make IndexedDB clone it again used to
  // add two large, synchronous copies. Old object-based slots remain readable.
  const worldJson = frozen ? await stringifyFrozenWorld(world) : JSON.stringify(world);
  const disk = desktopSaves();
  // The city is copied above, at the moment of saving; only the writes wait
  // their turn (two at once raced on one slot).
  if (disk) return oneWriteAtATime(() => disk.write(metadata, worldJson));
  const slot = { ...metadata, format: 2, worldJson };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Save transaction aborted'));
      tx.objectStore(STORE).put(slot);
    });
  } finally {
    db.close();
  }
}

export async function loadGame(): Promise<SaveSlot[]> {
  const disk = desktopSaves();
  if (disk) {
    await migrateBrowserSaves(disk);
    return decodeSlots(await disk.list());
  }
  const db = await openDb();
  try {
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('Could not read saves'));
      tx.onabort = () => reject(tx.error ?? new Error('Reading saves was aborted'));
      req.onerror = () => reject(req.error);
    });
    return await decodeSlots(raw);
  } finally { db.close(); }
}

// Parsing/validating every city in one callback used to block the menu for
// hundreds of milliseconds. Release input between slots as well as within the
// large per-entity validation loops.
async function decodeSlots(raw: unknown[]): Promise<SaveSlot[]> {
  const slots: SaveSlot[] = [];
  for (const record of raw) {
    await yieldForInput();
    slots.push(await decodeSlot(record, true));
  }
  return slots.sort((a, b) => b.savedAt - a.savedAt);
}

export function decodeSlot(raw: unknown): SaveSlot;
export function decodeSlot(raw: unknown, responsive: true): Promise<SaveSlot>;
export function decodeSlot(raw: unknown, responsive = false): SaveSlot | Promise<SaveSlot> {
  const slot = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const s = slot.summary && typeof slot.summary === 'object' ? slot.summary as Record<string, unknown> : null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const metadata = {
    id: typeof slot.id === 'string' ? slot.id : 'unreadable',
    name: typeof slot.name === 'string' ? slot.name : 'Unreadable save',
    savedAt: typeof slot.savedAt === 'number' && Number.isFinite(slot.savedAt) ? slot.savedAt : 0,
    week: typeof slot.week === 'number' ? slot.week : 0,
    bossName: typeof slot.bossName === 'string' ? slot.bossName : 'Unknown',
    ...(s ? { summary: { cash: num(s.cash), blocks: num(s.blocks), men: num(s.men), seed: num(s.seed) || 1928, finished: s.finished === true } } : {}),
  };
  const accept = (world: WorldState): SaveSlot => {
    campaignIds.set(world, typeof slot.campaignId === 'string' && slot.campaignId
      ? slot.campaignId
      : `legacy:${JSON.stringify([metadata.id, metadata.savedAt, world.options.seed])}`);
    return { ...metadata, world };
  };
  const damaged = (error: unknown): SaveSlot => ({
    ...metadata, world: null, error: error instanceof Error ? error.message : 'This save is damaged.',
  });
  try {
    if (typeof slot.unreadable === 'string') throw Error(slot.unreadable);
    if (slot.format != null && slot.format !== 1 && slot.format !== 2) throw Error('Unsupported save format.');
    // A header from the desktop list: the city is read when it is loaded.
    if (slot.lazy === true && slot.worldJson == null && slot.world == null) {
      const listed: SaveSlot = { ...metadata, world: null, lazy: true };
      return responsive ? Promise.resolve(listed) : listed;
    }
    const world: unknown = slot.worldJson != null ? JSON.parse(String(slot.worldJson)) : slot.world;
    if (responsive) return yieldForInput().then(() => validateSaveWorldResponsive(world)).then(accept).catch(damaged);
    validateSaveWorld(world);
    return accept(world);
  } catch (error) {
    return responsive ? Promise.resolve(damaged(error)) : damaged(error);
  }
}

export async function deleteSave(id: string): Promise<void> {
  const disk = desktopSaves();
  if (disk) return disk.remove(id);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Delete transaction aborted'));
      tx.objectStore(STORE).delete(id);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------- hall of fame

export interface HallEntry {
  resultId?: string;
  name: string;
  score: number;
  weeks: number;
  reason: string;
  won: boolean;
  at: number;
  /** Face and colour for the Hall of Fame screen; absent on older entries. */
  portrait?: number;
  female?: boolean;
  /** The boss's painted portrait key (portraits/boss/), when they had one. */
  face?: string;
  color?: GangColorName;
  /** Manual p.83: the leader's achievements for empire and crime. */
  empire?: { cash: number; blocks: number; men: number; businesses: number };
  crime?: { crimes: number; rivalsEliminated: number };
  /** One of the era's standing legends (not a game played here), with the killings laid at their door. */
  legend?: { kills: number };
}

const HALL_KEY = 'og.hallOfFame';

/**
 * The original's default Hall (Data\DefaultHST.xtx): eleven legends of the
 * era with its scores, territory, manpower, money and kills. They stand in
 * the table for new names to climb past; Clear keeps them, as the original's
 * reset rewrote the file from these defaults.
 */
const LEGENDS: [first: string, nick: string, last: string, score: number, blocks: number, men: number, cash: number, kills: number][] = [
  ['Alphonse', 'Scarface', 'Capone', 80, 400, 60, 650_000, 37],
  ['Charles', 'Lucky', 'Luciano', 70, 300, 55, 400_000, 28],
  ['John', 'Johnny', 'Torrio', 60, 200, 35, 300_000, 28],
  ['Francesco', 'Frankie', 'Yale', 40, 200, 33, 280_000, 21],
  ['Dion', 'Deanie', "O'Banion", 35, 175, 30, 200_000, 15],
  ['Earl', 'Hymie', 'Weiss', 30, 120, 25, 150_000, 14],
  ['George', 'Bugs', 'Moran', 25, 80, 16, 100_000, 12],
  ['Vito', 'Don Vitone', 'Genovese', 20, 50, 12, 80_000, 9],
  ['Arthur', 'Dutch', 'Schulz', 15, 40, 10, 50_000, 7],
  ['Tony', 'The Gentleman', 'Genna', 10, 30, 7, 15_000, 4],
  ['Joe', 'The Boss', 'Masseria', 5, 20, 6, 10_000, 1],
];

export const HALL_LEGENDS: readonly HallEntry[] = LEGENDS.map(([first, nick, last, score, blocks, men, cash, kills], i) => ({
  resultId: `legend-${i}`, name: `${first} "${nick}" ${last}`, score, weeks: 0, reason: 'A legend of the Prohibition era',
  won: false, at: 0, portrait: 7 + i * 5, female: false,
  empire: { cash, blocks, men, businesses: 0 }, legend: { kills },
}));

/** The Hall as shown: the player's own results among the era's legends, best first. */
export function hallOfFameTable(): HallEntry[] {
  // A tie goes to the newcomer, who had to beat a legend's mark to reach it.
  return [...loadHallOfFame(), ...HALL_LEGENDS].sort((a, b) => b.score - a.score || Number(!!a.legend) - Number(!!b.legend));
}

export function loadHallOfFame(): HallEntry[] {
  try {
    const raw = localStorage.getItem(HALL_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as HallEntry[]).sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

/** Whether the entry is in the Hall afterwards (it keeps the best 24). */
export function addHallOfFame(entry: HallEntry, adoptLegacy = false): boolean {
  try {
    const existing = loadHallOfFame();
    if (entry.resultId && existing.some(saved => saved.resultId === entry.resultId)) return true;
    const legacy = adoptLegacy ? existing.findIndex(saved => !saved.resultId &&
      saved.name === entry.name && saved.score === entry.score && saved.weeks === entry.weeks &&
      saved.reason === entry.reason && saved.won === entry.won) : -1;
    if (legacy >= 0) {
      existing[legacy] = { ...existing[legacy], resultId: entry.resultId };
      localStorage.setItem(HALL_KEY, JSON.stringify(existing));
      return true;
    }
    const all = [...existing, entry].sort((a, b) => b.score - a.score).slice(0, 24);
    localStorage.setItem(HALL_KEY, JSON.stringify(all));
    return all.includes(entry);
  } catch {
    /* storage may be unavailable; the score simply is not kept */
    return false;
  }
}

export function clearHallOfFame(): void {
  try {
    localStorage.removeItem(HALL_KEY);
  } catch {
    /* ignore */
  }
}

/** Reopening a terminal save must not displace other scores with duplicates. */
/** Enter a finished campaign in the Hall of Fame; whether it was entered.
 *  A lesson is practice, not a campaign, and is never entered. */
export function recordHallOfFame(world: WorldState): boolean {
  const gang = Object.values(world.gangs).find(g => g.isPlayer);
  const outcome = world.outcome;
  if (world.phase !== 'gameOver' || !gang || !outcome || world.options.tutorialId != null) return false;
  const id = campaignId(world);
  const boss = world.people[gang.bossId];
  const peaks = gang.scorePeaks;
  return addHallOfFame({
    resultId: JSON.stringify([id, world.week, outcome.won, outcome.reason, outcome.score]),
    name: world.people[gang.bossId]?.name ?? 'Unknown',
    score: outcome.score,
    weeks: world.week,
    reason: outcome.reason,
    won: outcome.won,
    at: Date.now(),
    portrait: boss?.portrait,
    female: boss?.female,
    face: boss?.face,
    color: gang.color,
    empire: {
      cash: peaks?.cash ?? gang.cash,
      blocks: peaks?.territory ?? 0,
      men: peaks?.manpower ?? 0,
      businesses: buildingList(world).filter(b => b.ownerGangId === gang.id).length,
    },
    crime: {
      // Graph history keeps the last 40 weeks of crimes on record.
      crimes: gang.history.reduce((sum, h) => sum + h.crimes, 0),
      rivalsEliminated: Object.values(world.gangs).filter(g => !g.isPlayer && g.eliminated).length,
    },
  }, id.startsWith('legacy:'));
}
