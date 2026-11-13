import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { act, useGame } from '../src/app/store';
import { defaultGameOptions } from '../src/app/newGame';
import { exportSave, importSave, loadGame, saveGame } from '../src/app/save';
import { issueOrder } from '../src/sim/api';
import { MINUTES_PER_WEEK } from '../src/sim/constants';
import { MINUTES_PER_SECOND } from '../src/sim/sim';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  useGame.getState().startGame({ ...defaultGameOptions(), seed: 404, citySize: 10 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('save boundaries and feedback', () => {
  it('exports and imports a validated save without overwriting existing slots', async () => {
    const sim = useGame.getState().sim!;
    await saveGame('Campaign', sim.world);
    const [original] = await loadGame();
    const file = await exportSave(original);
    sim.playerGang.cash = 1;
    expect(await importSave(file)).toBe('Campaign (2)');
    const slots = await loadGame();
    expect(slots).toHaveLength(2);
    expect(slots.find(s => s.name === 'Campaign (2)')!.world).toEqual(original.world);
    await expect(importSave('{')).rejects.toThrow();
    await expect(importSave(JSON.stringify({ kind: 'original-gangster-save', version: 1, world: {} }))).rejects.toThrow();
    expect(await loadGame()).toHaveLength(2);
  });

  it('rejects unsupported and damaged files without changing existing saves', async () => {
    await saveGame('Kept', useGame.getState().sim!.world);
    const before = await loadGame();
    for (const file of ['{', 'null', JSON.stringify({ kind: 'other', version: 1 }),
      JSON.stringify({ kind: 'original-gangster-save', version: 2 }),
      JSON.stringify({ kind: 'original-gangster-save', version: 1, world: {} })]) {
      await expect(importSave(file)).rejects.toThrow();
    }
    expect(await loadGame()).toEqual(before);
  });

  it('chooses distinct names for repeated imports, reserved autosaves and long names', async () => {
    await saveGame('Campaign', useGame.getState().sim!.world);
    const file = await exportSave((await loadGame())[0]);
    expect(await importSave(file)).toBe('Campaign (2)');
    expect(await importSave(file)).toBe('Campaign (3)');
    const data = JSON.parse(file);
    data.name = 'aUtOsAvE';
    expect(await importSave(JSON.stringify(data))).toBe('aUtOsAvE (2)');
    data.name = 'x'.repeat(80);
    expect(await importSave(JSON.stringify(data))).toBe('x'.repeat(60));
    expect(await importSave(JSON.stringify(data))).toBe(`${'x'.repeat(56)} (2)`);
    expect((await loadGame()).map(s => s.name)).toContain('Campaign');
  });
  it('snapshots before waiting for storage and reports only after commit', async () => {
    const state = useGame.getState();
    const cash = state.sim!.playerGang.cash;
    const pending = state.autosave();
    expect(useGame.getState().toast).toBeNull();
    state.sim!.playerGang.cash = 123;
    expect(await pending).toBe(true);
    const [slot] = await loadGame();
    expect(Object.values(slot.world!.gangs).find(g => g.isPlayer)!.cash).toBe(cash);
    expect(useGame.getState().toast?.bad).toBe(false);
  });

  it('first launch saves the planning orders and can restore them', async () => {
    const state = useGame.getState();
    const sim = state.sim!;
    expect(issueOrder(sim.world, sim.playerGang.id, {
      teamId: sim.playerGang.teamIds[0], type: 'patrol', blockIds: [0], opts: { manpower: 1 },
    }).ok).toBe(true);
    const orders = JSON.stringify(sim.world.orders);
    await state.launchWeek();
    expect(sim.world.phase).toBe('week');
    await vi.waitFor(() => expect(useGame.getState().toast?.bad).toBe(false));
    const [slot] = await loadGame();
    expect(slot.world!.phase).toBe('planning');
    expect(slot.week).toBe(1);
    expect(JSON.stringify(slot.world!.orders)).toBe(orders);
    await state.loadFromSlot(slot);
    expect(JSON.stringify(useGame.getState().sim!.world.orders)).toBe(orders);
  });

  it('reports storage rejection and keeps quit in the game', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('Storage denied'); });
    await useGame.getState().saveAndQuit();
    expect(useGame.getState().screen).toBe('game');
    expect(useGame.getState().toast?.bad).toBe(true);
    expect(useGame.getState().toast?.text).toContain('Autosave failed');
  });

  it('rejects aborted transactions and closes their database', async () => {
    const sim = useGame.getState().sim!;
    const originalCash = sim.playerGang.cash;
    await saveGame('Kept', sim.world);
    sim.playerGang.cash = 0;
    const original = IDBDatabase.prototype.transaction;
    const close = vi.spyOn(IDBDatabase.prototype, 'close');
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(saveGame('Kept', sim.world)).rejects.toThrow();
    expect(close).toHaveBeenCalled();
    const [kept] = await loadGame();
    expect(Object.values(kept.world!.gangs).find(g => g.isPlayer)!.cash).toBe(originalCash);
  });

  it('stays open until quit-save commits', async () => {
    const quitting = useGame.getState().saveAndQuit();
    expect(useGame.getState().screen).toBe('game');
    expect(useGame.getState().paused).toBe(true);
    await quitting;
    expect(useGame.getState().screen).toBe('menu');
    expect((await loadGame())[0].world!.phase).toBe('planning');
  });

  it.each(['clock', 'skip'] as const)('saves the settled week through %s once', async mode => {
    const state = useGame.getState();
    state.sim!.launchWeek();
    state.sim!.world.minute = MINUTES_PER_WEEK - 1;
    const save = vi.spyOn(useGame.getState(), 'autosave');
    save.mockClear();
    if (mode === 'clock') {
      state.advance(1 / MINUTES_PER_SECOND);
      for (let i = 0; i < 100 && state.sim!.world.phase === 'week'; i++) state.advance(0);
      expect(state.sim!.world.phase).not.toBe('week');
    }
    else await state.finishWeek();
    await vi.waitFor(() => expect(useGame.getState().toast?.bad).toBe(false));
    const [slot] = await loadGame();
    expect(slot.week).toBe(2);
    expect(slot.world!.phase).toBe('planning');
    expect(save).toHaveBeenCalledTimes(1);
    state.advance(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('holds the world still during a responsive snapshot and releases it after commit', async () => {
    const state = useGame.getState();
    const before = JSON.stringify(state.sim!.world);
    const pending = state.autosave(true);
    expect(useGame.getState().savingSnapshot).toBe(true);
    expect(act(sim => { sim.playerGang.cash = 0; })).toBeUndefined();
    await state.launchWeek();
    expect(state.sim!.world.phase).toBe('planning');
    expect(await pending).toBe(true);
    expect(useGame.getState().savingSnapshot).toBe(false);
    const [slot] = await loadGame();
    expect(JSON.stringify(slot.world)).toBe(before);
  });

  it('releases the responsive snapshot lock after storage failure', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('Storage denied'); });
    expect(await useGame.getState().autosave(true)).toBe(false);
    expect(useGame.getState().savingSnapshot).toBe(false);
    expect(useGame.getState().toast?.bad).toBe(true);
    expect(act(() => 'editable')).toBe('editable');
  });

  it('does not let an old snapshot completion alter a replacement world', async () => {
    const pending = useGame.getState().autosave(true);
    useGame.getState().startGame({ ...defaultGameOptions(), seed: 505, citySize: 10 });
    const replacement = useGame.getState().sim;
    await pending;
    expect(useGame.getState().sim).toBe(replacement);
    expect(useGame.getState().savingSnapshot).toBe(false);
    expect(useGame.getState().toast).toBeNull();
  });

  it('loads existing object-based slots alongside the new JSON format', async () => {
    const world = useGame.getState().sim!.world;
    await saveGame('New format', world);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('original-gangster', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put({ id: 'Legacy', name: 'Legacy', savedAt: 1, week: 1, bossName: 'Boss', world });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const slots = await loadGame();
    expect(slots).toHaveLength(2);
    for (const slot of slots) expect(JSON.stringify(slot.world)).toBe(JSON.stringify(world));
  });
});
