import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { defaultGameOptions } from '../src/app/newGame';
import { deleteSave, exportSave, importSave, loadGame, saveGame } from '../src/app/save';
import { Sim } from '../src/sim/sim';

const require = createRequire(import.meta.url);
const store = require('../electron/saveStore.cjs') as {
  writeSlot(dir: string, meta: Record<string, unknown>, worldJson: string): Promise<void>;
  listSlots(dir: string): Promise<Record<string, unknown>[]>;
  listHeaders(dir: string): Promise<Record<string, unknown>[]>;
  readSlot(dir: string, id: string): Promise<Record<string, unknown>>;
  removeSlot(dir: string, id: string): Promise<void>;
  fileFor(dir: string, id: string): string;
};

const dirs: string[] = [];
async function dir() { const d = await mkdtemp(path.join(tmpdir(), 'og-saves-')); dirs.push(d); return d; }
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const meta = (id: string, week = 3) => ({ id, name: id, savedAt: 1000 + week, campaignId: 'c1', week, bossName: 'Boss' });

describe('desktop save files', () => {
  it('writes, lists and overwrites a slot, keeping the previous version as a backup', async () => {
    const d = await dir();
    await store.writeSlot(d, meta('Autosave', 3), '{"week":3}');
    await store.writeSlot(d, meta('Autosave', 4), '{"week":4}');
    const [slot] = await store.listSlots(d);
    expect(slot).toMatchObject({ id: 'Autosave', week: 4, format: 2, worldJson: '{"week":4}' });
    expect(await readFile(store.fileFor(d, 'Autosave') + '.bak', 'utf8')).toContain('{"week":3}');
    expect((await readdir(d)).some(f => f.endsWith('.tmp'))).toBe(false);
  });

  it('keeps names with characters Windows forbids in file names', async () => {
    const d = await dir();
    await store.writeSlot(d, meta('Big Al: "week*3"?'), '{}');
    expect((await store.listSlots(d))[0].id).toBe('Big Al: "week*3"?');
  });

  it('falls back to the backup when the slot is torn, and flags a slot with none', async () => {
    const d = await dir();
    await store.writeSlot(d, meta('One', 1), '{"week":1}');
    await store.writeSlot(d, meta('One', 2), '{"week":2}');
    await writeFile(store.fileFor(d, 'One'), JSON.stringify(meta('One', 2)) + '\n{"week":', 'utf8');
    expect((await store.listSlots(d))[0]).toMatchObject({ id: 'One', worldJson: '{"week":1}' });
    await rm(store.fileFor(d, 'One') + '.bak');
    const [bad] = await store.listSlots(d);
    expect(bad.unreadable).toBeTruthy();
    await store.removeSlot(d, bad.id as string);
    expect(await store.listSlots(d)).toEqual([]);
  });

  it('removes a slot with its backup, and rejects invalid names', async () => {
    const d = await dir();
    await store.writeSlot(d, meta('Gone'), '{}');
    await store.writeSlot(d, meta('Gone'), '{}');
    await store.removeSlot(d, 'Gone');
    expect(await readdir(d)).toEqual([]);
    await expect(store.writeSlot(d, meta(''), '{}')).rejects.toThrow();
    await expect(store.removeSlot(d, 'x'.repeat(300))).rejects.toThrow();
  });
});

describe('the game saves through the desktop store', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function desktop(d: string) {
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
    vi.stubGlobal('ogDesktop', { saves: {
      list: () => store.listSlots(d), write: (m: Record<string, unknown>, j: string) => store.writeSlot(d, m, j), remove: (id: string) => store.removeSlot(d, id),
    } });
  }

  it('saves, loads and deletes on disk, and imports browser saves once', async () => {
    const d = await dir();
    vi.stubGlobal('indexedDB', new IDBFactory());
    const sim = new Sim({ ...defaultGameOptions(), seed: 7, citySize: 10 });
    // A save made by the browser build before the desktop app existed.
    await saveGame('Old browser save', sim.world);
    desktop(d);
    await saveGame('Autosave', sim.world);
    const slots = await loadGame();
    expect(slots.map(s => s.name).sort()).toEqual(['Autosave', 'Old browser save']);
    expect(slots.every(s => s.world && s.world.week === sim.world.week)).toBe(true);
    expect((await readdir(d)).filter(f => f.endsWith('.ogsave'))).toHaveLength(2);
    await deleteSave('Old browser save');
    // Imported once: deleting it on disk does not bring it back from the browser store.
    expect((await loadGame()).map(s => s.name)).toEqual(['Autosave']);
  }, 60000);

  it('exports a lazy desktop slot and imports it as a separate loadable save', async () => {
    const d = await dir();
    vi.stubGlobal('indexedDB', new IDBFactory());
    desktop(d);
    const read = vi.fn((id: string) => store.readSlot(d, id));
    vi.stubGlobal('ogDesktop', { saves: {
      list: () => store.listHeaders(d), read,
      write: (m: Record<string, unknown>, j: string) => store.writeSlot(d, m, j),
      remove: (id: string) => store.removeSlot(d, id),
    } });
    const sim = new Sim({ ...defaultGameOptions(), seed: 7, citySize: 10 });
    await saveGame('Desktop', sim.world);
    const [header] = await loadGame();
    expect(header).toMatchObject({ lazy: true, world: null });
    const file = await exportSave(header);
    expect(read).toHaveBeenCalledWith('Desktop');
    expect(await importSave(file)).toBe('Desktop (2)');
    const imported = await store.readSlot(d, 'Desktop (2)');
    expect(JSON.parse(imported.worldJson as string)).toEqual(sim.world);
  });
});
