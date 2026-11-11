import { restingStatus } from '../src/sim/transport';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultGameOptions } from '../src/app/newGame';
import { issueStreetOrder } from '../src/sim/api';
import { MINUTES_PER_SECOND, Sim } from '../src/sim/sim';
import { WALK_SPEED } from '../src/sim/constants';

/** These limits were sized for a 10 m-a-minute walk; scale them with the walk. */
const SLOW = Math.ceil(10 / WALK_SPEED);
import { tickStreetOrders } from '../src/sim/systems/street';
import { presentationEvents } from '../src/sim/presentationEvents';
import { previewPosition } from '../src/sim/movement';
import { dist } from '../src/sim/world';
import { onRoad } from '../src/sim/vehicleNavigation';
import { restoreLegacyTransport } from '../src/sim/transport';
import type { WorldState } from '../src/sim/types';
import { act, useGame } from '../src/app/store';
import { handleMapHit } from '../src/ui/mapClick';

let initial: string;
beforeAll(() => { initial = JSON.stringify(new Sim({ ...defaultGameOptions(), seed:404, citySize:10 }).world); });
afterEach(() => { vi.restoreAllMocks(); useGame.setState({sim:null,pickMode:null,paused:false}); });
function scene(armed = true, driving = false) {
  const sim = Sim.fromSave(JSON.parse(initial) as WorldState), w = sim.world, gang = sim.playerGang;
  const team = w.teams[gang.teamIds[0]], actor = w.people[team.lieutenantId];
  const target = Object.values(w.people).find(p => p.role === 'citizen')!;
  for (const p of Object.values(w.people)) p.status = 'jailed';
  for (const p of [actor,target]) Object.assign(p, {status:'active', hp:100, inVehicle:false,
    streetOrder:null, orderId:null, buildingId:null, dest:null, path:[]});
  for (const key of Object.keys(team.weapons) as (keyof typeof team.weapons)[]) team.weapons[key]=0;
  team.weapons.pistol = armed ? 1 : 0;
  actor.inVehicle = driving; actor.skills.firearms = 4; actor.skills.fists = 4;
  actor.pos = {x:20,y:driving ? 1.95 : 5.4}; target.pos = {x:90,y:5.4};
  w.phase = 'week'; w.minute = 0; w.messages = []; w.crimes = [];
  // Stage a real owned car before comparing restored and uninterrupted play.
  // Migration coverage elsewhere deliberately supplies old boolean-only cars.
  if (driving) restoreLegacyTransport(w);
  return {sim,w,gang,team,actor,target};
}
function order(s: ReturnType<typeof scene>, type: 'kill'|'assault'|'tail' = 'kill') {
  expect(issueStreetOrder(s.w,s.gang.id,[s.actor.id],type,s.target.id,null).ok).toBe(true);
}
function tick(s: ReturnType<typeof scene>) { s.w.minute++; tickStreetOrders(s.w,s.sim.rng,1); }

describe('responsive live attacks', () => {
  it('starts approaching as soon as the target is clicked, between simulation ticks', () => {
    const s=scene(); order(s);
    expect(s.actor.dest).not.toBeNull();
    expect(dist(previewPosition(s.actor,.5,{x:0,y:0}),s.actor.pos)).toBeGreaterThan(0);
  });

  it('reaches a stationary target across a junction instead of restarting the route each minute', () => {
    const s=scene(false); order(s);
    for(let i=0;i<24*SLOW && dist(s.actor.pos,s.target.pos)>2;i++)tick(s);
    expect(dist(s.actor.pos,s.target.pos)).toBeLessThanOrEqual(2);
  });

  it.each(['kill','assault'] as const)('gets out of the car to finish a close-range %s', type => {
    const s=scene(false,true); order(s,type);
    for(let i=0;i<24*SLOW && !presentationEvents(s.w).events.some(e=>e.kind==='attack');i++) {
      tick(s);
      if(s.actor.inVehicle)expect(onRoad(s.w,s.actor.pos)).toBe(true);
    }
    expect(s.actor.inVehicle).toBe(false);
    expect(presentationEvents(s.w).events.some(e=>e.kind==='attack')).toBe(true);
    expect(dist(s.actor.pos,s.target.pos)).toBeLessThanOrEqual(2);
  });

  it('attempts the first shot within one normal-speed tick, even when accuracy rolls miss', () => {
    const s=scene(); s.target.pos={x:30,y:5.4}; order(s);
    vi.spyOn(s.sim.rng,'chance').mockReturnValue(false);
    tick(s);
    expect(1/MINUTES_PER_SECOND).toBeLessThan(7);
    expect(presentationEvents(s.w).events.filter(e=>e.kind==='attack')).toHaveLength(1);
    expect(s.target.hp).toBe(100);
    expect(s.w.messages.some(m=>m.category==='combat' && m.sound==='gunshot' && /miss/i.test(m.text))).toBe(true);
  });

  it('reports nonlethal hits instead of silently waiting for the target to die', () => {
    const s=scene(); s.target.pos={x:30,y:5.4}; order(s);
    // Hit, but refuse the lethal draw: the original roll leaves a wound, no hit points.
    let calls=0; vi.spyOn(s.sim.rng,'chance').mockImplementation(()=>calls++%2===0);
    tick(s);
    expect(s.target.status).toBe('active');
    expect(s.w.messages.some(m=>m.category==='combat' && m.sound==='gunshot' && m.text.includes(s.target.name) && m.text.includes('wounded'))).toBe(true);
  });

  it('follows a moving target without retreating to the previous junction', () => {
    const s=scene(); s.target.pos={x:110,y:5.4}; order(s);
    for(let i=0;i<35*SLOW && !presentationEvents(s.w).events.some(e=>e.kind==='attack');i++) {
      s.target.pos.x+=.4*WALK_SPEED;
      tick(s);
    }
    expect(presentationEvents(s.w).events.some(e=>e.kind==='attack')).toBe(true);
  });

  it('catches a target walking away at full pace (the pursuer hurries and re-plans as she moves)', () => {
    const s=scene(false); s.target.pos={x:40,y:5.4}; order(s,'assault');
    let minutes=0;
    for(;minutes<240 && !presentationEvents(s.w).events.some(e=>e.kind==='attack');minutes++) {
      s.target.pos.x+=WALK_SPEED;
      tick(s);
    }
    // 20 m ahead at walking pace: at a walker's speed he never gains, so this
    // only passes because a pursuer hurries (and re-plans as she moves).
    expect(presentationEvents(s.w).events.some(e=>e.kind==='attack')).toBe(true);
  });

  it.each([false,true])('finishes a real seeded Kill and restores mid-pursuit deterministically (driving=%s)', driving => {
    const s=scene(true,driving); s.target.role='hood'; order(s);
    s.sim.advance(3/MINUTES_PER_SECOND,1);
    const restored=Sim.fromSave(JSON.parse(JSON.stringify(s.w)) as WorldState);
    for(let i=0;i<60*SLOW && s.target.status!=='dead';i++) {
      s.sim.advance(1/MINUTES_PER_SECOND,1); restored.advance(1/MINUTES_PER_SECOND,1);
    }
    expect(s.target.status).toBe('dead'); expect(s.actor.streetOrder).toBeNull();
    expect(restored.world.people[s.target.id]).toEqual(s.target);
    expect(restored.world.people[s.actor.id]).toEqual(s.actor);
    expect(restored.world.vehicleFleet).toEqual(s.w.vehicleFleet);
    expect(restored.rng.state).toBe(s.sim.rng.state);
  });

  it('cancels a pursuit when the target is no longer available', () => {
    const s=scene(); order(s); s.target.status='jailed'; tick(s);
    expect(s.actor.streetOrder).toBeNull();
    // The pursuit is dropped. With nothing else to do he makes for the office, as the
    // original's men did, rather than stand where it ended (issue 10 item 14).
    expect(restingStatus(s.w, s.actor)).toMatch(/office/);
    expect(presentationEvents(s.w).events).toHaveLength(0);
  });

  it.each([false, true])('finishes a real seeded Assault without killing the target (driving=%s)', driving => {
    const s = scene(true, driving); s.target.role = 'hood'; order(s, 'assault');
    for (let i = 0; i < 60 * SLOW && s.actor.streetOrder; i++) s.sim.advance(1 / MINUTES_PER_SECOND, 1);
    expect(s.target.status).toBe('beaten'); expect(s.target.hp).toBeGreaterThan(0);
    // Blows cost stamina, not hit points (0x465C20); the beating ends when he is down or spent.
    expect(s.target.hp).toBe(100); expect(s.actor.streetOrder).toBeNull();
    expect(s.actor.inVehicle).toBe(false);
    expect(s.w.crimes.some(c => c.kind === 'streetAssault' && c.victimId === s.target.id)).toBe(true);
    expect(presentationEvents(s.w).events.some(e => e.kind === 'attack')).toBe(true);
  });

  it('accepts an actual map target, names it, and explains when the clock is paused', () => {
    const s=scene();
    useGame.setState({sim:s.sim,screen:'game',paused:true,
      pickMode:{kind:'streetOrder',orderType:'kill',personIds:[s.actor.id]}});
    handleMapHit({personId:s.target.id,buildingId:null,blockId:0,point:{...s.target.pos}});
    expect(s.actor.streetOrder?.targetPersonId).toBe(s.target.id);
    expect(useGame.getState().pickMode).toBeNull();
    expect(useGame.getState().toast?.text).toContain(s.target.name);
    expect(useGame.getState().toast?.text).toContain('Paused');
    useGame.getState().advance(10);
    expect(s.w.minute).toBe(0); // Never silently override the player's pause.
  });

  it('keeps target selection open after an invalid target without replacing the old job', () => {
    const s=scene(); order(s,'tail'); const previous=s.actor.streetOrder;
    useGame.setState({sim:s.sim,pickMode:{kind:'streetOrder',orderType:'kill',personIds:[s.actor.id]}});
    handleMapHit({personId:s.actor.id,buildingId:null,blockId:0,point:{...s.actor.pos}});
    expect(useGame.getState().pickMode?.kind).toBe('streetOrder');
    expect(s.actor.streetOrder).toBe(previous); expect(useGame.getState().toast?.bad).toBe(true);
  });

  it('rebases an attack command at the visible position without spending movement twice', () => {
    const s=scene(); order(s,'tail');
    s.sim.advance(.6/MINUTES_PER_SECOND,1);
    const shown=previewPosition(s.actor,s.sim.subMinute,{x:0,y:0});
    useGame.setState({sim:s.sim});
    act(sim=>issueStreetOrder(sim.world,s.gang.id,[s.actor.id],'kill',s.target.id,null));
    expect(previewPosition(s.actor,s.sim.subMinute,{x:0,y:0})).toEqual(shown);
    s.sim.advance(.4/MINUTES_PER_SECOND,1);
    expect(dist(s.actor.pos,shown)).toBeLessThanOrEqual(4.0001);
  });
});
