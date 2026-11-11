import { DRIVE_MIN_DISTANCE, DRIVE_SPEED, MINUTES_PER_WEEK, ORDERS, VEHICLES, WALK_SPEED } from './constants';
import { hash32 } from './hash';
import { cargoWarehouse, routeCargoReturn, unloadCargo } from './cargo';
import { clearDestination, setDestination } from './movement';
import { onRoad, parkingSpot, pavementBeside } from './vehicleNavigation';
import { allBuildings, buildingDoor, dist } from './world';
import type { FleetVehicle, Gang, ID, OrderType, Person, Team, Vec2, VehicleId, WorldState } from './types';

// Seat counts, cargo units and speed multipliers are remake tuning. The manual
// establishes relative performance, not these numerical limits.
const kinds: VehicleId[] = ['speedster', 'coupe', 'truck'];
export const FOOT_CARGO = 8;
const busy = (v: FleetVehicle | undefined): boolean => !!v && (!!v.cargo || v.orderId != null || v.occupantIds.length > 0);
export function vehicleOf(w: WorldState | undefined, p: Person): FleetVehicle | undefined {
  return p.vehicleKey ? w?.vehicleFleet?.[p.vehicleKey] : undefined;
}
export function vehicleDriver(w: WorldState, p: Person): Person {
  const v = vehicleOf(w,p);
  return p.inVehicle && v?.driverId != null ? w.people[v.driverId] ?? p : p;
}
/** Game minutes a returning truck stays at the warehouse while its goods go in. */
export const RETURN_UNLOAD_MINUTES = 8;
const absoluteMinute = (w: WorldState) => w.week * MINUTES_PER_WEEK + w.minute;
/** A pursuer on foot moves this much faster than a walker. */
export const PURSUIT_PACE = 1.5;
/** The original runs 1 in 64 civilian errand legs (POP §4.1, rand 0x281 → run
 * flag). Chosen from the person and the leg's destination, so nothing extra is
 * saved and a restored game makes the same choice. */
export function runningCivilian(p: Person): boolean {
  return p.role === 'citizen' && !p.inVehicle && p.dest != null &&
    hash32(p.id * 7919 + Math.round(p.dest.x * 4) * 131 + Math.round(p.dest.y * 4)) % 64 === 0;
}
/** On a planned order after a named person who has been placed (not asking
 * round the pool halls for him): he hurries as a man on a street order does. */
function closingOnHisMan(p: Person, w?: WorldState): boolean {
  const order = w && p.orderId != null ? w.orders[p.orderId] : undefined;
  return !!order && order.state === 'travelling' && !order.hunting && !order.exportDelivery && !order.raidDelivery &&
    ORDERS[order.type].target === 'person';
}
export function transportSpeed(p: Person, w?: WorldState): number {
  // Someone sent after a person on foot hurries, or an ambling target would
  // keep the same lead for ever at the original's walking pace.
  if (!p.inVehicle) return p.streetOrder?.type === 'assault' || p.streetOrder?.type === 'kill' || runningCivilian(p) || closingOnHisMan(p, w) ? WALK_SPEED * PURSUIT_PACE : WALK_SPEED;
  const v = vehicleOf(w,p), driver = v?.driverId == null ? p : w?.people[v.driverId] ?? p;
  const kind = v?.kind ?? (p.role === 'accountant' || p.role === 'lawyer' ?
    w?.gangs[p.gangId!]?.staffVehicles?.[p.role] : null);
  return DRIVE_SPEED * (kind ? VEHICLES[kind].speed : p.role === 'police' ? 1.6 : 1) * (.75 + driver.skills.driving * .1);
}
function base(w: WorldState, gangId: ID, near: Vec2): Vec2 {
  const offices = allBuildings(w).filter(b => b.ownerGangId === gangId && b.typeId === 'office' && b.state !== 'destroyed');
  offices.sort((a,b) => dist(buildingDoor(w,a),near)-dist(buildingDoor(w,b),near));
  return offices[0] ? buildingDoor(w,offices[0]) : near;
}
const ownOffice = (w: WorldState, gangId: ID) =>
  allBuildings(w).some(b => b.ownerGangId === gangId && b.typeId === 'office' && b.state !== 'destroyed');
/** How near the office door counts as having gone in. */
const OFFICE_DOOR_M = 4;
/**
 * Back at the office with nothing to do: one of the gang's men who has walked
 * (or been driven) home and is waiting inside for his next order. Derived from
 * where he is, so nothing is added to a save; and never `buildingId`, which
 * means running a business and would take him out of his crew's staffing.
 */
export function atOffice(w: WorldState, p: Person, doors?: Vec2[]): boolean {
  if (p.gangId == null || p.status !== 'active' || (p.role !== 'hood' && p.role !== 'lieutenant')) return false;
  if (p.orderId != null || p.resumeOrderId != null || p.streetOrder || p.dest || p.vehicleKey || p.inVehicle || p.buildingId != null) return false;
  return (doors ?? officeDoors(w, p.gangId)).some(door => dist(p.pos, door) <= OFFICE_DOOR_M);
}
/** The doors a gang's men go home to. The renderer asks once a frame and
 * passes the list to `atOffice`, rather than search the city for every man. */
export function officeDoors(w: WorldState, gangId: ID): Vec2[] {
  return allBuildings(w).filter(b => b.ownerGangId === gangId && b.typeId === 'office' && b.state !== 'destroyed').map(b => buildingDoor(w, b));
}
/** What somebody with no order is doing, for the week's status lines. */
export function restingStatus(w: WorldState, p: Person): string {
  if (atOffice(w, p)) return 'At the office';
  const ganged = p.gangId != null && (p.role === 'hood' || p.role === 'lieutenant');
  if (p.dest) return ganged && ownOffice(w, p.gangId!) ? 'Returning to the office' : 'Travelling';
  return 'Idle';
}
/** Where the gang's other cars stand, or are going to stand. */
export function parkedSpots(w: WorldState, exceptKey: string): Vec2[] {
  const out: Vec2[] = [];
  for (const [key, v] of Object.entries(w.vehicleFleet ?? {})) {
    if (key === exceptKey) continue;
    const driver = v.driverId == null ? undefined : w.people[v.driverId];
    out.push(driver?.inVehicle && driver.dest ? driver.dest : v.pos);
  }
  for (const d of Object.values(w.goodsDeliveries ?? {})) out.push(d.path.at(-1) ?? d.pos);
  return out;
}
function makeVehicle(w: WorldState, key: string, kind: VehicleId, gangId: ID, teamId: ID|null, staffId: ID|null, slot: number, near: Vec2): FleetVehicle {
  return (w.vehicleFleet ??= {})[key] ??= { kind, gangId, teamId, staffId, slot,
    pos: parkingSpot(w,base(w,gangId,near),parkedSpots(w,key)), driverId:null, occupantIds:[], orderId:null,
    destination:null, boarding:false, returning:false };
}
export function syncVehicle(w: WorldState, v: FleetVehicle): void {
  const d = v.driverId == null ? undefined : w.people[v.driverId];
  if (!d?.inVehicle) return;
  v.pos = {...d.pos};
  for (const id of v.occupantIds) {
    const p = w.people[id];
    if (!p || p === d || !p.inVehicle) continue;
    p.pos = {...d.pos}; p.dest = d.dest ? {...d.dest} : null;
    p.path = d.path.map(x => ({...x})); p.halted = d.halted;
  }
}
export function tryBoard(w: WorldState, v: FleetVehicle): void {
  if (!v.boarding || !v.occupantIds.length) return;
  if (v.boardAfter != null) { if (absoluteMinute(w) < v.boardAfter) return; delete v.boardAfter; }
  const people = v.occupantIds.map(id=>w.people[id]);
  if (people.some(p=>!p || dist(p.pos,v.pos)>3)) return;
  v.boarding = false;
  for(const p of people){p.inVehicle=true;p.pos={...v.pos};clearDestination(p);}
  const driver = w.people[v.driverId!];
  if(v.destination)setDestination(w,driver,v.destination);
  syncVehicle(w,v);
}
function reserve(w:WorldState,key:string,v:FleetVehicle,people:Person[],to:Vec2,orderId:ID|null):void {
  v.occupantIds=people.map(p=>p.id);v.driverId=people.reduce((a,b)=>a.skills.driving>=b.skills.driving?a:b).id;
  v.orderId=orderId;v.destination={...to};v.boarding=true;v.returning=false;
  for(const p of people){p.vehicleKey=key;p.inVehicle=false;setDestination(w,p,v.pos);}
  // Starting beside the car is an ordinary board, never a teleport across town.
  for(const p of people)if(dist(p.pos,v.pos)<=8){p.pos={...v.pos};clearDestination(p);}
  tryBoard(w,v);
}
/** The estimator and dispatch use the same free cars, riders and drivers. */
export function transportPlan(w:WorldState,team:Team,people:Person[],type:OrderType) {
  const remaining=[...people];
  const cars:{key:string;kind:VehicleId;slot:number;riders:Person[]}[]=[];
  const preference=type==='export'||type==='raid'?['truck','coupe','speedster'] as VehicleId[]:kinds;
  for(const kind of preference){
    let free=(team.vehicles[kind]??0)-Object.values(w.vehicleFleet??{}).filter(v=>v.teamId===team.id&&v.kind===kind&&busy(v)).length;
    for(let slot=0;slot<(team.vehicles[kind]??0)&&remaining.length;slot++){
      const key=`team:${team.id}:${kind}:${slot}`;
      if(busy(w.vehicleFleet?.[key]))continue;
      // Left out across town: it is fetched home rather than walked to.
      const parked=w.vehicleFleet?.[key];if(parked&&remaining[0]&&dist(parked.pos,remaining[0].pos)>DRIVE_MIN_DISTANCE)continue;
      const seats=type==='export'&&kind==='truck'?Math.min(VEHICLES.truck.capacity,Math.ceil(remaining.length/Math.max(1,free))):VEHICLES[kind].capacity;
      cars.push({key,kind,slot,riders:remaining.splice(0,seats)});free--;
    }
  }
  return {cars,walkers:remaining};
}
/** Each car is reserved once, including parked cars retained by an active job. */
export function allocateTransport(w:WorldState,team:Team,people:Person[],to:Vec2,orderId:ID,type:OrderType):void {
  reconcileTransport(w);
  // Only men going far enough to drive take a car (exports and raids carry goods, so always do).
  const drivers=type==='export'||type==='raid'?people:people.filter(p=>dist(p.pos,to)>DRIVE_MIN_DISTANCE);
  const plan=transportPlan(w,team,drivers,type);
  for(const {key,kind,slot,riders} of plan.cars)reserve(w,key,makeVehicle(w,key,kind,team.gangId,team.id,null,slot,to),riders,to,orderId);
  for(const p of [...plan.walkers,...people.filter(p=>!drivers.includes(p))]){p.inVehicle=false;delete p.vehicleKey;setDestination(w,p,to);}
}
export function startStaffJourney(w:WorldState,p:Person,to:Vec2):void {
  const role=p.role==='accountant'?'accountant':'lawyer',kind=w.gangs[p.gangId!]?.staffVehicles?.[role];
  const current=vehicleOf(w,p);
  if(current&&p.inVehicle){setDestination(w,p,to);return;}
  if(!kind){p.inVehicle=false;setDestination(w,p,to);return;}
  const key=`staff:${p.id}`,v=makeVehicle(w,key,kind,p.gangId!,null,p.id,0,p.pos);
  // Fetch the car only when walking to it and driving on is quicker than
  // walking there (a lawyer crossed the city on foot for his car).
  const drive=DRIVE_SPEED*VEHICLES[kind].speed*(.75+p.skills.driving*.1);
  // Nearer than the original's driving distance he walks, as he does when fetching it would be slower.
  if(dist(p.pos,to)<=DRIVE_MIN_DISTANCE||(dist(p.pos,v.pos)>8&&dist(p.pos,v.pos)/WALK_SPEED+dist(v.pos,to)/drive>=dist(p.pos,to)/WALK_SPEED)){
    if(p.vehicleKey===key)dismount(w,p);
    p.inVehicle=false;setDestination(w,p,to);return;
  }
  reserve(w,key,v,[p],to,null);
}
/** Leaving parks the vehicle; it does not copy its keys to the whole team. */
export function dismount(w:WorldState,p:Person):void {
  const v=vehicleOf(w,p);
  if(v){
    if(v.driverId===p.id&&p.inVehicle)v.pos={...p.pos};
    v.occupantIds=v.occupantIds.filter(id=>id!==p.id);
    if(v.driverId===p.id)v.driverId=bestDriver(w,v.occupantIds);
    if(!v.occupantIds.length){v.boarding=false;v.destination=null;v.returning=false;}
  }
  delete p.vehicleKey;p.inVehicle=false;
}
/** The best driver left in the car takes the wheel (not whoever sat first). */
function bestDriver(w:WorldState,ids:ID[]):ID|null{
  let best:Person|undefined;
  for(const id of ids){const p=w.people[id];if(p&&(!best||p.skills.driving>best.skills.driving||p.skills.driving===best.skills.driving&&p.id<best.id))best=p;}
  return best?.id??null;
}
/** Out of the car — or out of a reservation on one he was walking to — and
 *  onto the pavement beside it, not left standing in the traffic lane. */
export function alight(w:WorldState,p:Person):void {
  const seated=p.inVehicle;
  if(p.vehicleKey)dismount(w,p);
  if(seated&&onRoad(w,p.pos))p.pos=pavementBeside(w,p.pos);
}
export function releaseTransportOrder(w:WorldState,orderId:ID):void {
  for(const v of Object.values(w.vehicleFleet??{}))if(v.orderId===orderId)v.orderId=null;
}
export function availableVehicle(w:WorldState,team:Team,kind:VehicleId):boolean {
  const used=Object.values(w.vehicleFleet??{}).filter(v=>v.teamId===team.id&&v.kind===kind&&busy(v)).length;
  return used<(team.vehicles[kind]??0);
}
/** Get out beside the car for a job at the kerb (a thrown molotov or bomb):
 * the seat stays reserved and the car waits, boarding, to take them back. */
export function stepOut(w:WorldState,p:Person,toward:Vec2):void {
  const v=vehicleOf(w,p);
  if(!v||!p.inVehicle)return;
  const d=dist(v.pos,toward),k=d>0?Math.min(2,d)/d:0;
  p.inVehicle=false;p.pos={x:v.pos.x+(toward.x-v.pos.x)*k,y:v.pos.y+(toward.y-v.pos.y)*k};
  clearDestination(p);v.boarding=true;v.destination=null;
  // Out long enough to be seen to throw (he was back in the car the same minute).
  v.boardAfter=absoluteMinute(w)+STEP_OUT_MINUTES;
}
/** Minutes a man who steps out for a job at the kerb stays out (a throw, a blow). */
export const STEP_OUT_MINUTES = 3;
export function sendHome(w:WorldState,p:Person):void {
  if(p.status!=='active'||p.gangId==null)return;
  const destination=base(w,p.gangId,p.pos),v=vehicleOf(w,p);
  p.buildingId=null;
  // Back into the waiting car after stepping out for the job.
  if(v&&!p.inVehicle&&v.boarding)tryBoard(w,v);
  if(v?.cargo?.purpose==='return'){routeCargoReturn(w,v);return;}
  // Home to a parking spot of its own by the office (not the one point every car stopped on).
  if(v&&p.inVehicle){v.returning=true;setDestination(w,vehicleDriver(w,p),parkingSpot(w,destination,parkedSpots(w,p.vehicleKey!)));}
  else if(p.role==='lawyer'||p.role==='accountant'){
    startStaffJourney(w,p,destination);const car=vehicleOf(w,p);if(car)car.returning=true;
  }else {if(v)dismount(w,p);setDestination(w,p,destination);}
}
/** Called after actual movement, also by tests that step the order system. */
export function afterTransportStep(w:WorldState,p:Person,arrived:boolean):boolean {
  const v=vehicleOf(w,p);
  if(!v)return arrived;
  if(v.boarding){tryBoard(w,v);return false;}
  if(p.inVehicle){
    syncVehicle(w,v);
    if(arrived&&v.cargo?.purpose==='return'&&!p.streetOrder&&p.orderId==null){
      const warehouse=v.cargo.destinationId==null?undefined:w.buildings[v.cargo.destinationId];
      const moved=warehouse?unloadCargo(w,v,warehouse):0;
      // Emptied: stay a few minutes while the cases go in (reconcileTransport ends it).
      if(warehouse&&moved>0&&!v.cargo){v.unloading={buildingId:warehouse.id,until:absoluteMinute(w)+RETURN_UNLOAD_MINUTES};return false;}
      if(v.cargo)routeCargoReturn(w,v);else sendHome(w,p);
      return false;
    }
    if(arrived&&v.returning){
      for(const id of [...v.occupantIds]){
        const rider=w.people[id];dismount(w,rider);
        // Home: out of the car and in at the office door, not left standing in the lane beside it.
        if(rider?.gangId!=null&&rider.status==='active'&&ownOffice(w,rider.gangId))rider.pos={...base(w,rider.gangId,rider.pos)};
      }
    }
  }
  return arrived;
}
/** Clean interrupted seats, promote a surviving passenger, release ended jobs. */
export function reconcileTransport(w:WorldState):void {
  for(const [key,v] of Object.entries(w.vehicleFleet??{})){
    if(v.unloading&&absoluteMinute(w)>=v.unloading.until){
      delete v.unloading;const driver=v.driverId==null?undefined:w.people[v.driverId];if(driver)sendHome(w,driver);
    }
    for(const id of [...v.occupantIds]){
      const p=w.people[id];
      if(!p||p.status!=='active'||p.burningEscape?.week===w.week||p.gangId!==v.gangId||
        p.vehicleKey!==key||(!v.boarding&&!p.inVehicle)){
        if(p&&p.vehicleKey===key)alight(w,p);
        else {v.occupantIds=v.occupantIds.filter(x=>x!==id);if(v.driverId===id)v.driverId=bestDriver(w,v.occupantIds);}
      }
    }
    if(v.orderId!=null&&!['queued','travelling','executing','waiting'].includes(w.orders[v.orderId]?.state))v.orderId=null;
    if(v.driverId!=null)syncVehicle(w,v);
    if(v.cargo?.purpose==='return'){
      if(!v.occupantIds.length){
        const courier=freeCourier(w,v);
        const warehouse=cargoWarehouse(w,v.gangId,v.pos,v.cargo.goods);
        if(courier&&warehouse)reserve(w,key,v,[courier],buildingDoor(w,warehouse),null);
      }
      routeCargoReturn(w,v);
    }
    // A car left standing away from the offices (its crew walked on, or was
    // killed or taken) stays where it was left; a free man goes for it and
    // drives it home, as one does for an abandoned truck.
    // Not at once: the man who left it there may want it again (an hour standing first).
    // (Out of the week it only waits: a load between weeks changed nothing.)
    else if(v.teamId!=null&&!busy(v)&&!v.boarding&&stranded(w,v)){
      if(w.phase==='week'){
        const now=absoluteMinute(w);v.idleSince??=now;
        const courier=now-v.idleSince>=STRANDED_MINUTES?freeCourier(w,v):undefined;
        if(courier){delete v.idleSince;reserve(w,key,v,[courier],parkingSpot(w,base(w,v.gangId,v.pos),parkedSpots(w,key)),null);v.returning=true;}
      }
    }
    else delete v.idleSince;
  }
}
/** The nearest free man of the car's crew (or gang) to fetch it: the first on the books could be across town. */
function freeCourier(w:WorldState,v:FleetVehicle):Person|undefined{
  const team=v.teamId==null?null:w.teams[v.teamId];
  const candidates=team?[...team.memberIds,team.lieutenantId]:(w.gangs[v.gangId]?.poolIds??[]);
  return candidates.map(id=>w.people[id]).filter(p=>p?.status==='active'&&p.gangId===v.gangId&&
    p.buildingId==null&&p.orderId==null&&!p.streetOrder&&!p.dest&&!p.vehicleKey&&p.burningEscape?.week!==w.week)
    .sort((a,b)=>dist(a.pos,v.pos)-dist(b.pos,v.pos)||a.id-b.id)[0];
}
/** Further than this from the nearest office, an empty car is out on the streets, not parked at home. */
const STRANDED_DISTANCE=25;
/** How long a car left out stands before somebody fetches it, in minutes. */
const STRANDED_MINUTES=60;
function stranded(w:WorldState,v:FleetVehicle):boolean{return dist(v.pos,base(w,v.gangId,v.pos))>STRANDED_DISTANCE;}
export function orderVehicles(w:WorldState,people:Person[]):FleetVehicle[]{
  const keys=new Set(people.filter(p=>p.inVehicle).map(p=>p.vehicleKey).filter((k):k is string=>!!k));
  return [...keys].map(k=>w.vehicleFleet?.[k]).filter((v):v is FleetVehicle=>!!v);
}
export function cargoCapacity(w:WorldState,people:Person[]):number {
  return orderVehicles(w,people).reduce((n,v)=>n+VEHICLES[v.kind].cargo,0)+people.filter(p=>!p.inVehicle).length*FOOT_CARGO;
}
/** Can only dispose of a car which has actually returned and is unreserved. */
export function removeFleetVehicle(w:WorldState,owner:Team|Gang,kind:VehicleId):boolean {
  const count=owner.vehicles[kind]??0,prefix='lieutenantId' in owner?`team:${owner.id}`:`cache:${owner.id}`;
  for(let slot=count-1;slot>=0;slot--){
    const key=`${prefix}:${kind}:${slot}`,v=w.vehicleFleet?.[key];
    if(busy(v))continue;
    const lastKey=`${prefix}:${kind}:${count-1}`,last=w.vehicleFleet?.[lastKey];
    if(w.vehicleFleet){delete w.vehicleFleet[key];delete w.vehicleFleet[lastKey];
      if(last&&last!==v){last.slot=slot;w.vehicleFleet[key]=last;for(const id of last.occupantIds)w.people[id].vehicleKey=key;
        for(const o of Object.values(w.orders))if(o.exportDelivery?.vehicleKeys)o.exportDelivery.vehicleKeys=o.exportDelivery.vehicleKeys.map(k=>k===lastKey?key:k);}}
    return true;
  }
  return false;
}
/** Empty cars at the offices are back in the garage after the weekend; one left out
 * on the streets, and undelivered loads, keep their place. */
export function resetWeekTransport(w:WorldState):void {
  for(const p of Object.values(w.people))if(p.vehicleKey&&!w.vehicleFleet?.[p.vehicleKey]?.cargo){delete p.vehicleKey;p.inVehicle=false;clearDestination(p);}
  for(const [key,v] of Object.entries(w.vehicleFleet??{})){
    if(v.cargo){v.cargo.purpose='return';v.cargo.orderId=null;v.orderId=null;}
    // Left out on the streets: it is still there next week (fetched, or taken from where it stands).
    // One whose crew was still aboard when the week ran out comes home with them: they start the next
    // week at the office, and a car left across town was passed over, so a repeated order went on foot.
    else if(v.teamId!=null&&stranded(w,v)&&!v.occupantIds.length){
      v.occupantIds=[];v.driverId=null;v.orderId=null;v.destination=null;v.boarding=false;v.returning=false;
      delete v.boardAfter;delete v.unloading;
    }
    else delete w.vehicleFleet![key];
  }
  if(!Object.keys(w.vehicleFleet??{}).length)delete w.vehicleFleet;
}
/** Old saves had a boolean car per hood. Preserve legal positions/routes while
 * limiting those cars to the owned fleet; nearby same-job riders share a seat. */
export function restoreLegacyTransport(w:WorldState):void {
  if(w.vehicleFleet||w.phase!=='week')return;
  for(const p of Object.values(w.people)){
    if(!p.inVehicle||p.status!=='active')continue;
    const team=p.teamId==null?undefined:w.teams[p.teamId];
    const staff=p.role==='accountant'||p.role==='lawyer'?w.gangs[p.gangId!]?.staffVehicles?.[p.role]:null;
    if(!team&&!staff)continue; // police and standalone review figures are not team inventory
    const shared=team&&Object.entries(w.vehicleFleet??{}).find(([,v])=>v.teamId===team.id&&v.orderId===p.orderId&&p.orderId!=null&&dist(v.pos,p.pos)<3&&v.occupantIds.length<VEHICLES[v.kind].capacity);
    if(shared){p.vehicleKey=shared[0];shared[1].occupantIds.push(p.id);syncVehicle(w,shared[1]);continue;}
    let key:string|undefined,kind:VehicleId|undefined,slot=0;
    if(staff){key=`staff:${p.id}`;kind=staff;}
    else for(const k of (p.orderId!=null&&['export','raid'].includes(w.orders[p.orderId]?.type)?['truck','coupe','speedster']:['coupe','truck','speedster']) as VehicleId[]){
      for(let i=0;i<(team!.vehicles[k]??0);i++)if(!w.vehicleFleet?.[`team:${team!.id}:${k}:${i}`]){key=`team:${team!.id}:${k}:${i}`;kind=k;slot=i;break;}
      if(key)break;
    }
    if(!key||!kind){const dest=p.dest;dismount(w,p);if(dest)setDestination(w,p,dest);continue;}
    (w.vehicleFleet??={})[key]={kind,gangId:p.gangId!,teamId:team?.id??null,staffId:staff?p.id:null,slot,pos:{...p.pos},
      driverId:p.id,occupantIds:[p.id],orderId:p.orderId,destination:p.dest?{...p.dest}:null,boarding:false,returning:!p.orderId&&!p.streetOrder};
    p.vehicleKey=key;
  }
}
/** Planning uses the slowest dispatched traveller; excess people go on foot. */
export function plannedTravelSpeed(w:WorldState,team:Team,people:Person[],type:OrderType):number {
  const plan=transportPlan(w,team,people,type);
  const speeds=plan.cars.map(c=>DRIVE_SPEED*VEHICLES[c.kind].speed*(.75+Math.max(...c.riders.map(p=>p.skills.driving))*.1));
  if(plan.walkers.length||!speeds.length)speeds.push(WALK_SPEED);
  return Math.min(...speeds);
}
