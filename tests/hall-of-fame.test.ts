import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { defaultGameOptions } from '../src/app/newGame';
import { addHallOfFame, clearHallOfFame, HALL_LEGENDS, hallOfFameTable, cloneSavedWorld, cloneSavedWorldResponsive, decodeSlot, exportSave, importSave, loadGame, loadHallOfFame, recordHallOfFame, saveGame } from '../src/app/save';
import { Sim } from '../src/sim/sim';
import { hallPages, NEXT_BEST_PAGE, TOP_GANGSTERS } from '../src/ui/HallOfFame';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function finished() {
  const sim = new Sim({ ...defaultGameOptions(), seed: 404, citySize: 10 });
  sim.world.phase = 'gameOver';
  sim.world.outcome = { won: true, reason: 'Natural test outcome', score: 35 };
  return sim.world;
}

describe('Hall of Fame terminal reloads', () => {
  it('keeps campaign identity through export and import', async () => {
    const world = finished();
    await saveGame('Finished', world);
    recordHallOfFame(world);
    const first = loadHallOfFame();
    await importSave(await exportSave((await loadGame())[0]));
    const imported = (await loadGame()).find(slot => slot.name === 'Finished (2)')!;
    recordHallOfFame(imported.world!);
    expect(loadHallOfFame()).toEqual(first);
  });
  it.each(['synchronous', 'responsive'])('records once across %s restoration and renamed save without changing simulation state', async mode => {
    const world = finished(), before = JSON.stringify(world);
    await saveGame('Finished', world);
    recordHallOfFame(world);
    const first = loadHallOfFame();
    expect(first).toHaveLength(1);
    const restored = (await loadGame())[0].world!;
    const installed = mode === 'responsive'
      ? (await Sim.fromSaveResponsive(await cloneSavedWorldResponsive(restored))).world
      : Sim.fromSave(cloneSavedWorld(restored)).world;
    expect(installed).not.toBe(restored);
    recordHallOfFame(installed);
    await saveGame('Renamed', restored);
    for (const slot of await loadGame()) recordHallOfFame(slot.world!);
    expect(loadHallOfFame()).toEqual(first);
    expect(JSON.stringify(world)).toBe(before);
  });

  it('keeps distinct campaigns even when their seed and displayed outcome are identical', () => {
    recordHallOfFame(finished());
    recordHallOfFame(finished());
    expect(loadHallOfFame()).toHaveLength(2);
    expect(new Set(loadHallOfFame().map(e => e.resultId)).size).toBe(2);
  });

  it('preserves a different ending reached from an earlier checkpoint of the same campaign', async () => {
    const world = finished();
    await saveGame('Checkpoint', world);
    recordHallOfFame(world);
    const restored = (await loadGame())[0].world!;
    restored.outcome = { won: false, reason: 'A different ending', score: 12 };
    recordHallOfFame(restored);
    recordHallOfFame(restored);
    expect(loadHallOfFame().map(e => e.score)).toEqual([35, 12]);
  });

  it('gives legacy saves stable identity and retains historical unkeyed scores', async () => {
    const raw = { id: 'Old save', name: 'Old save', savedAt: 123, world: finished() };
    addHallOfFame({ name: 'Historic boss', score: 90, weeks: 12, reason: 'Old score', won: true, at: 1 });
    const one = decodeSlot(structuredClone(raw)).world!;
    recordHallOfFame(one);
    recordHallOfFame(decodeSlot(structuredClone(raw)).world!);
    await saveGame('Legacy resaved', one);
    recordHallOfFame((await loadGame())[0].world!);
    expect(loadHallOfFame()).toHaveLength(2);
    expect(loadHallOfFame()[0].name).toBe('Historic boss');
  });

  it('adopts an existing matching legacy score without changing its timestamp or losing it', () => {
    const world = finished();
    const old = { name: world.options.playerName, score: 35, weeks: world.week, reason: world.outcome!.reason, won: true, at: 123 };
    addHallOfFame(old);
    const raw = { id: 'Old terminal', savedAt: 456, world };
    recordHallOfFame(decodeSlot(structuredClone(raw)).world!);
    recordHallOfFame(decodeSlot(structuredClone(raw)).world!);
    expect(loadHallOfFame()).toHaveLength(1);
    expect(loadHallOfFame()[0]).toMatchObject(old);
    expect(loadHallOfFame()[0].resultId).toBeTruthy();
    recordHallOfFame(finished());
    expect(loadHallOfFame()).toHaveLength(2);
  });

  it('retries after rejected storage and repeated reloads do not displace other retained scores', () => {
    const world = finished();
    const rejected = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw Error('Quota'); });
    expect(() => recordHallOfFame(world)).not.toThrow();
    rejected.mockRestore();
    recordHallOfFame(world);
    for (let i = 0; i < 23; i++) addHallOfFame({ resultId: `other-${i}`, name: `Other ${i}`, score: 20, weeks: 10, reason: 'Other campaign', won: false, at: i });
    const retained = loadHallOfFame();
    for (let i = 0; i < 30; i++) recordHallOfFame(world);
    expect(loadHallOfFame()).toEqual(retained);
    expect(retained).toHaveLength(24);
  });

  it('keeps the boss face, colour and empire/crime achievements (manual p.83)', () => {
    const world = finished();
    const gang = Object.values(world.gangs).find(g => g.isPlayer)!;
    const rival = Object.values(world.gangs).find(g => !g.isPlayer)!;
    rival.eliminated = true;
    gang.history = [{ week: 1, power: 1, assets: 0, cash: 1, territory: 1, manpower: 1, loyalty: 1, crimes: 4, suspicion: 0 },
      { week: 2, power: 1, assets: 0, cash: 1, territory: 1, manpower: 1, loyalty: 1, crimes: 3, suspicion: 0 }];
    gang.scorePeaks = { cash: 9000, territory: 12, manpower: 15 };
    recordHallOfFame(world);
    const [entry] = loadHallOfFame();
    const boss = world.people[gang.bossId];
    expect(entry).toMatchObject({ portrait: boss.portrait, female: boss.female, color: gang.color,
      empire: { cash: 9000, blocks: 12, men: 15 }, crime: { crimes: 7, rivalsEliminated: 1 } });
    expect(entry.empire!.businesses).toBe(Object.values(world.buildings).filter(b => b.ownerGangId === gang.id).length);
  });

  it('pages the Hall as the top three, then the next best eight at a time', () => {
    const entry = (i: number) => ({ name: `Boss ${i}`, score: 100 - i, weeks: 1, reason: '', won: false, at: i });
    expect(hallPages([])).toEqual([[]]);
    const pages = hallPages(Array.from({ length: 20 }, (_, i) => entry(i)));
    expect(pages.map(p => p.length)).toEqual([TOP_GANGSTERS, NEXT_BEST_PAGE, NEXT_BEST_PAGE, 1]);
    expect(pages[1][0].name).toBe('Boss 3');
  });
});

describe("the era's legends (DefaultHST.xtx)", () => {
  it('stand in the table from the first run, Capone at the head', () => {
    const table = hallOfFameTable();
    expect(table).toHaveLength(11);
    expect(table[0].name).toBe('Alphonse "Scarface" Capone');
    expect(table.map(e => e.score)).toEqual([80, 70, 60, 40, 35, 30, 25, 20, 15, 10, 5]);
    expect(loadHallOfFame()).toEqual([]);
  });

  it('a new name takes its place among them, and Clear keeps the legends', () => {
    addHallOfFame({ resultId: 'r1', name: 'Johnny Moretti', score: 40, weeks: 52, reason: 'Mayor', won: true, at: 1 });
    const table = hallOfFameTable();
    expect(table.map(e => e.name).slice(2, 5)).toEqual(['John "Johnny" Torrio', 'Johnny Moretti', 'Francesco "Frankie" Yale']);
    clearHallOfFame();
    expect(hallOfFameTable()).toEqual([...HALL_LEGENDS]);
  });
});
