import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { defaultGameOptions } from '../src/app/newGame';
import { fitAreaToWeek, issueOrder, previewOrder } from '../src/sim/api';
import { activeBlocks } from '../src/sim/cityLayout';
import { MINUTES_PER_WEEK } from '../src/sim/constants';
import { fitsWeek } from '../src/sim/execution';

describe('area selections the crew has not got the time for', () => {
  it('leaves off the farthest sites until the rest fit the week, and the trimmed order is accepted', () => {
    const sim = new Sim({ ...defaultGameOptions(), seed: 404 });
    const w = sim.world, g = sim.playerGang, team = w.teams[g.teamIds[0]];
    // Most of the week is already committed.
    team.timeUsed = MINUTES_PER_WEEK - 300;
    const blocks = activeBlocks(w).map(b => b.id);
    const input = { teamId: team.id, type: 'extort' as const, blockIds: blocks.slice(0, 6), buildingIds: [], opts: { manpower: 1 } as any };
    const all = previewOrder(w, g.id, input)!;
    expect(all.targetBuildingIds.length).toBeGreaterThan(3);
    const fit = fitAreaToWeek(w, g.id, input)!;
    expect(fit).not.toBeNull();
    expect(fit.buildingIds.length).toBeGreaterThan(0);
    expect(fit.buildingIds.length + fit.dropped).toBe(fit.total);
    const kept = previewOrder(w, g.id, { ...input, blockIds: [], buildingIds: fit.buildingIds })!;
    // The crew's week is charged by the share of its people the job takes.
    expect(fitsWeek(w, team, kept, team.timeUsed)).toBe(true);
    expect(issueOrder(w, g.id, { ...input, blockIds: [], buildingIds: fit.buildingIds }).ok).toBe(true);
  });

  it('changes nothing when the selection already fits', () => {
    const sim = new Sim({ ...defaultGameOptions(), seed: 404 });
    const w = sim.world, g = sim.playerGang, team = w.teams[g.teamIds[0]];
    const block = activeBlocks(w)[0].id;
    expect(fitAreaToWeek(w, g.id, { teamId: team.id, type: 'extort', blockIds: [block], buildingIds: [], opts: { manpower: 2 } as any })).toBeNull();
  });
});
