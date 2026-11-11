import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useGame } from '../src/app/store';
import { defaultGameOptions } from '../src/app/newGame';
import { yieldForPaint } from '../src/yieldForPaint';

vi.mock('../src/yieldForPaint', () => ({ yieldForPaint: vi.fn(async () => {}) }));
const paint = vi.mocked(yieldForPaint);
const autosave = useGame.getState().autosave;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
beforeEach(() => {
  paint.mockReset().mockResolvedValue();
  useGame.getState().startGame({ ...defaultGameOptions(), seed:404, citySize:10 });
  useGame.setState({ autosave:vi.fn(async () => true) });
});
afterEach(() => { useGame.setState({ autosave }); vi.restoreAllMocks(); });

describe('planning to street loading boundary', () => {
  it('shows loading before snapshotting or dispatching orders and ignores duplicate launches', async () => {
    const held = gate(); paint.mockReturnValueOnce(held.promise);
    const sim = useGame.getState().sim!, launch = vi.spyOn(sim, 'launchWeek');
    const pending = useGame.getState().launchWeek();
    expect(useGame.getState().streetLoading).toBe(true);
    expect(sim.world.phase).toBe('planning');
    expect(useGame.getState().autosave).not.toHaveBeenCalled();
    expect(act(() => 'must not edit the plan while saving')).toBeUndefined();
    await useGame.getState().launchWeek();
    held.release(); await pending;
    expect(useGame.getState().autosave).toHaveBeenCalledExactlyOnceWith(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(sim.world.phase).toBe('week');
    expect(useGame.getState().streetLoading).toBe(true);
  });

  it('holds the clock and RNG until the renderer releases the first frame', async () => {
    await useGame.getState().launchWeek();
    const sim = useGame.getState().sim!, minute = sim.world.minute, rng = sim.world.rngState;
    useGame.getState().advance(10);
    await useGame.getState().finishWeek();
    expect(sim.world.minute).toBe(minute);
    expect(sim.world.phase).toBe('week');
    expect(sim.world.rngState).toBe(rng);
    useGame.getState().setStreetLoading(false);
    useGame.getState().advance(10);
    expect(sim.world.minute).toBeGreaterThan(minute);
  });

  it('runs the week to the next Monday when the street view never opens', async () => {
    await useGame.getState().launchWeek();
    const sim = useGame.getState().sim!, week = sim.world.week;
    // No renderer here: nothing ever releases the loading card.
    expect(useGame.getState().streetLoading).toBe(true);
    await useGame.getState().runWeekUnseen();
    expect(sim.world.phase).toBe('planning');
    expect(sim.world.week).toBe(week + 1);
    const ui = useGame.getState();
    expect(ui.streetLoading).toBe(false);
    expect(ui.finishingWeek).toBe(false);
    expect(ui.paused).toBe(false);
    expect(ui.organizerTab).toBe('newspaper');
    expect(ui.planningView).toBe('plan');
    // The next week launches and can be run the same way.
    await useGame.getState().launchWeek();
    await useGame.getState().runWeekUnseen();
    expect(sim.world.week).toBe(week + 2);
  });

  it('finishes the responsive planning snapshot before changing the world phase', async () => {
    const held = gate();
    useGame.setState({ autosave:vi.fn(async () => { await held.promise; return true; }) });
    const pending = useGame.getState().launchWeek();
    await Promise.resolve();
    expect(useGame.getState().sim!.world.phase).toBe('planning');
    held.release(); await pending;
    expect(useGame.getState().sim!.world.phase).toBe('week');
  });

  it.each(['menu', 'replacement'] as const)('does not launch a stale city after %s navigation', async destination => {
    const held = gate(); paint.mockReturnValueOnce(held.promise);
    const old = useGame.getState().sim!, launch = vi.spyOn(old, 'launchWeek');
    const pending = useGame.getState().launchWeek();
    if (destination === 'menu') useGame.getState().setScreen('menu');
    else useGame.getState().startGame({ ...defaultGameOptions(), seed:405, citySize:10 });
    held.release(); await pending;
    expect(launch).not.toHaveBeenCalled();
    expect(useGame.getState().streetLoading).toBe(false);
  });

  it('releases the loading lock and explains a failed order dispatch', async () => {
    vi.spyOn(useGame.getState().sim!, 'launchWeek').mockImplementation(() => { throw Error('Dispatch failed'); });
    await useGame.getState().launchWeek();
    expect(useGame.getState().streetLoading).toBe(false);
    expect(useGame.getState().toast).toMatchObject({ bad:true, text:'Dispatch failed' });
  });
});
