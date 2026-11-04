import { CHARACTER_SCALE } from './detailedCharacters';
import { attitudeScore } from '../sim/attitudes';
import {escapeSample,BURNING_TIMING} from '../sim/burningEscape';
import {BurningPeople} from './burningPeople';
import {EmergencyHoses} from './emergencyHoses';
import { activeBlocks, blockRect, cityBlockAt, cityStreetInset, streetNameIndex } from '../sim/cityLayout';
import { CityLandscape } from './cityLandscape';
import { DeathMarks } from './deathMarks';
import { CarGunfire } from './carGunfire';
import { closedFrontMaterial } from './closedFront';
import { riverBank, riverCrossing } from './riverBanks';
import { SculptTrees, type TreePlacement } from './sculptTrees';
import * as THREE from 'three';
import { BuildingPickBounds } from './buildingPickBounds';
import { BuildingOutline } from './buildingOutline';
import { actorSightlineHits, TaggedView, TaggedViews, type TaggedViewRect } from './taggedView';
import { fireEscapeLevels } from './fireEscapeLayout';
import { BLOCK_SIZE, CELL, GANG_COLORS, STREET_WIDTH } from '../sim/constants';
import { BUILDING_BY_ID } from '../sim/data/buildings';
import { buildingMapIntel, knownBlockOwners } from '../sim/mapIntel';
import { recentEventCounts } from '../sim/events';
import { drawTerritoryOutline } from './territoryOutline';
import type { Block, Building, ID, Person, VehicleId, WorldState } from '../sim/types';
import { MAX_CARS, carsAt } from '../sim/traffic';
import { streetSound } from '../audio/streetSound';
import { previewGoodsDelivery } from '../sim/goodsDelivery';
import { CENTRE_LOT, LOT_SIZE, dayPhase } from '../sim/world';
import {
  awningGeometry,
  bulkheadGeometry,
  chimneyGeometry,
  columnGeometry,
  domeGeometry,
  fireEscapeGeometry,
  hydrantGeometry,
  lampGlowGeometry,
  lampPostGeometry,
  pedimentGeometry,
  sawtoothGeometry,
  slabGeometry,
  spireGeometry,
  treeGeometry,
  wallShellGeometry,
  waterTankGeometry,
} from './geometry';
import { InstancePool, PoolView, type PoolSnapshot } from './pool';
import { TextureOwner } from './textureOwnership';
import { RoadSurfaceMaterial } from './roadSurface';
import { MINUTES_PER_SECOND } from '../sim/constants';
import { releaseAttachedShaders, ShadowMaterialOwner } from './shadowMaterialOwnership';
import { prepareScene } from './prepareScene';
import { yieldForInput } from '../yieldForInput';
import { yieldForPaint } from '../yieldForPaint';
import { waitForGpu } from './waitForGpu';
import { patchInstancedUv, patchRoofUv } from './materialUv';
import { ActorLayer, ActorMotion, actorStyleFor } from './actorLayer';
import { CharacterActions,liveCharacterAction } from './characterActions';
import { CityEffects } from './cityEffects';
import {fireDamageStage} from '../sim/buildingDamage';
import {FireDamageDecor} from './fireDamageDecor';
import {rubbleGeometry,ruinRubble} from './rubble';
import {SculptRubble,rubblePiles,type RubblePlacement} from './sculptRubble';
import { bossInsideOffice, characterPriority, streetPersonVisible, useDetailedModels, carriesExplosives, workingInside } from './characterPresentation';
import { characterInView, characterNeedsDetail, characterPixelHeight, DETAIL_KEEP_METRES, MAX_DETAILED_STREET_CHARACTERS } from './characterDetail';
import { previewActorMotion, previewStreetPosition, type PreviewActorMotion } from './previewActorMotion';
import { kerbside, roadHeading } from '../sim/vehicleNavigation';
import { previewVehicle } from '../sim/movement';
import { specialistParticipants } from '../sim/specialistJobs';
import { vehicleDriver } from '../sim/transport';
import { createVehicleMaterial, VEHICLE_PROFILE, vehicleGeometry, vehicleForPerson, vehicleLightGeometry } from './vehicles';
import { VehicleSpriteLayer } from './vehicleSpriteLayer';
import { SculptReviewLayer } from './sculptReviewLayer';
import { SCULPT_VEHICLE_PROFILE } from './sculptVehicles';
import { FACING_YAW, lotFacing, profileForLot, profileFor } from './profile';
import { createPitchedRoofMaterials } from './roofMaterials';
import { createInteriorMaterials } from './interiorMaterials';
import { industrialFixtureFor, industrialFixtureOffsets } from './interiorFixtures';
import { CityAudio } from './cityAudio';
import { VIEW_ZOOM } from './viewModes';
import { cutawayRoomLayout, furnitureGeometry, FURNITURE_KINDS, kitFor, type FurnitureKind } from './cutawayRooms';
import { churchBelfryLayout, civicDomeLayout, porticoColumnScale, CIVIC_STONE } from './ornamentLayout';
import { dailyMotion, deliveryDriver, loadingShuttle } from './dailyMotion';
import { dockCraneGeometry, stationClockGeometry, trainShedGeometry } from './architecture';
import { centreSiteHalfExtent, entryDoorGeometry, mouldingsFor, rusticationCourses, frontOf, frontageGeometry, interiorGeometry, massesForView, sectionMasses, pitchedRoofGeometry, storedGoodsGeometry, worksMachineGeometry } from './architecture';
import { cityTextures, loadCityArt, type CityArt, type CityTextures } from './textures';
import {
  BAY_W,
  KERB_H,
  PAVE_W,
  paveWidth,
  STOREY_H,
  TILE_BAYS,
  TILE_STOREYS,
  clamp,
  lerp,
  r01,
  rint,
  smoothstep,
} from './util';
import { peopleList, buildingList } from '../sim/entityLists';

export type OverlayKind =
  | 'territory'
  | 'landValue'
  | 'security'
  | 'hostility'
  | 'crime'
  | 'events'
  | 'lieutenant';

/** Placed wall extents retained for the architecture review tools. */
interface PlacedMass {
  x: number; y: number; z: number; w: number; h: number; d: number; yaw: number;
}

export interface PickResult {
  buildingId: ID | null;
  blockId: ID | null;
  personId: ID | null;
  point: { x: number; y: number };
}

const PX_PER_METRE = 2;
const MAX_AGENTS = 3600;
/** Original street imagery uses 2:1 ground diagonals: sin(elevation) = 1/2. */
const CAMERA_ELEVATION = Math.PI / 6;
/** Half-width of a block's pavement slab. */
const SLAB_HALF = BLOCK_SIZE / 2 + PAVE_W;
/** Keep tyre soles just clear of the road, in metres. */
const VEHICLE_GROUND_CLEARANCE = .008;

const CAR_COLORS = [0x14151a, 0x1c2b22, 0x3a1f1c, 0x1b2740, 0x2e2a22, 0x5d5140, 0x8d8371, 0x232323];
/**
 * Overcoat colours for the citizens. Mid-tones with a hue to them: the pavement
 * is neutral grey, so it is colour rather than brightness that picks a figure
 * out of it in sun and in shadow alike.
 */
const COAT_COLORS = [0x7a6a52, 0x5f6650, 0x3f4a63, 0x6b3a35, 0xa8926d, 0x45464c, 0x8c8a86, 0x5a4a3c];
const AWNING_COLORS = [0x2f4636, 0x5a2b28, 0x2c3a56, 0x6a5322, 0x7a6a52, 0x39383a, 0x8a3b2c, 0x3f5a4a, 0x6b4a6a, 0xa08452];
const awningScratch = new THREE.Color();
const paintScratch = new THREE.Color();
/** Cornices, copings and porticoes are dressed stone, never painted brick. */
// Weathered limestone: lighter than the brick, but not a white outline round
// every building when seen from the air.
const STONE = new THREE.Color(0.56, 0.535, 0.49);
const RUSTIC_STONE = new THREE.Color(0.46, 0.42, 0.36);
/** Multipliers over the facade textures: enough spread that a street of the
 * same facade still reads as different buildings. */
const WALL_TINTS: [number, number, number][] = [
  [1.00, 1.00, 1.00], [1.08, 0.94, 0.86], [0.82, 0.80, 0.80], [1.05, 1.02, 0.92],
  [0.92, 0.95, 1.02], [1.10, 0.98, 0.80], [0.70, 0.68, 0.66], [1.02, 0.90, 0.84],
  [0.95, 0.97, 0.94], [1.06, 1.04, 1.00],
];
/** Painted shopfront joinery: the period ran to dark, glossy colours. */
const SHOP_PAINT = [0x4a6b52, 0x8c5a4a, 0x50607e, 0x9a8656, 0x6d5a48, 0x7a6f62, 0x5c4e6b, 0x8a7a5c];
// The photographed brick/stucco tiles are darker than the original street
// palette. Lift wall albedo alone; pale stone porticos, roofs and props keep
// their existing response. These are linear colour multipliers.
const FACADE_ALBEDO_GAIN = [1.8, 2.5, 1, 1, 1.3] as const;

/** Renders New Temperance: streets, skyline, traffic, people and overlays. */
/** The original's avenues are double-width: the two flanking streets are its
 * carriageways and the cell between them is a raised central island with
 * lamps and trees (it was drawn as 50 m of open asphalt). Only a bridge, where
 * the avenue crosses the river, stays roadway from parapet to parapet. */
function avenueRoadway(b: Block | undefined): boolean {
  return riverCrossing(b);
}

/** All of a pool's instances, kept so a subset can be drawn and restored. */
type Placements = { pool: InstancePool; matrices: Float32Array; colors: Float32Array | null; count: number };
function snapshotPlacements(pool: InstancePool): Placements {
  const mesh = pool.mesh, count = mesh.count;
  return { pool, count, matrices: (mesh.instanceMatrix.array as Float32Array).slice(0, count * 16),
    colors: mesh.instanceColor ? (mesh.instanceColor.array as Float32Array).slice(0, count * 3) : null };
}
const cullMatrix = new THREE.Matrix4(), cullColor = new THREE.Color();
/** How far round a watched person the Tagged inset needs its street furniture. */
const TAGGED_FURNITURE_REACH = 90;
function refillNear(p: Placements, centres: [number, number, number][]): void {
  p.pool.reset();
  for (let i = 0; i < p.count; i++) {
    const px = p.matrices[i * 16 + 12], pz = p.matrices[i * 16 + 14];
    if (!centres.some(([x, z, reach]) => Math.abs(px - x) <= reach && Math.abs(pz - z) <= reach)) continue;
    cullMatrix.fromArray(p.matrices, i * 16);
    if (p.colors) cullColor.fromArray(p.colors, i * 3);
    p.pool.push(cullMatrix, p.colors ? cullColor : undefined);
  }
  p.pool.commit();
}

type RoomItem = { pool: InstancePool; m: number[]; r: number; g: number; b: number };
/** An opened mass waiting to be furnished when the camera comes near. */
type QueuedRooms = { x: number; z: number; px: number; pz: number; yaw: number; light: number; massIndex: number;
  id: number; cls: string; typeId: string; dx: number; dz: number; w: number; d: number; floor: number; top: number;
  multiStorey: boolean; items?: RoomItem[] };

/** Canvases whose city released its WebGL context, and the means to restore it. */
const releasedContexts = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>();
async function restoreReleasedContext(canvas: HTMLCanvasElement): Promise<void> {
  const lose = releasedContexts.get(canvas);
  if (!lose) return;
  releasedContexts.delete(canvas);
  await new Promise<void>(done => {
    const timer = setTimeout(done, 2000);
    canvas.addEventListener('webglcontextrestored', () => { clearTimeout(timer); done(); }, { once: true });
    lose.restoreContext();
  });
}

export class CityRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;
  private world: WorldState;
  private tex: CityTextures;
  private ownedTextures = new TextureOwner();
  private shadowMaterials = new ShadowMaterialOwner();
  /** Materials that take the delivered textures once they have loaded. */
  private roofMat!: THREE.MeshStandardMaterial;
  private plinthMat!: THREE.MeshStandardMaterial;
  private signMat!: THREE.MeshStandardMaterial;
  private awnMat!: THREE.MeshStandardMaterial;
  private sawMat!: THREE.MeshStandardMaterial;
  private paveTop!: THREE.MeshStandardMaterial;
  private kerbSide!: THREE.MeshStandardMaterial;
  private disposed = false;
  private preparationRevision = 0;
  private preparedRevision = -1;
  private preparation: Promise<boolean> | null = null;

  private ground!: THREE.Mesh;
  private landscape?: CityLandscape;
  private deathMarks?: DeathMarks;
  private carGunfire?: CarGunfire;
  private deathMarksChecked = -Infinity;
  /** Where each man carrying crates was last shown: one killed at it falls there, not at the truck. */
  private shuttleSeen = new Map<number, { x: number; y: number }>();
  private groundCanvas!: HTMLCanvasElement;
  private groundCtx!: CanvasRenderingContext2D;
  private groundTexture!: THREE.CanvasTexture;
  private groundBase: HTMLCanvasElement | null = null;
  private fontsLoaded = () => {
    this.groundMat?.refreshLabels();
    // Before the city is ready the labels are part of its preparation; after,
    // a font arriving for a dialog mid-week only redraws them (it sent the
    // whole city back behind the loading card).
    if (this.preparedRevision !== this.preparationRevision) this.preparationRevision++;
  };

  // --- building layers
  private wallPools: InstancePool[] = [];
  private cutawayWalls: InstancePool[] = [];
  private interiorRooms!: InstancePool;
  private interiorWorks!: InstancePool;
  private interiorMachines!: InstancePool;
  private interiorStorage!: InstancePool;
  /** The original's cutaway: broken masonry, plastered rooms and furniture (cutawayRooms.ts). */
  private cutawayCaps!: InstancePool;
  private cutawayLinings!: InstancePool;
  private furniture = new Map<FurnitureKind, InstancePool>();
  /** Rooms are laid out for every opened building but drawn only near the
   * camera: Street View shows a few dozen buildings, the city has thousands. */
  private roomCache: QueuedRooms[] = [];
  private furnishedAt = new THREE.Vector3(Infinity, 0, Infinity);
  private furnishedRadius = 0;
  /** Every lamp, lamp glow and hydrant in the city; only the reachable ones
   * are drawn (4,800 lamps of 568 triangles were 2.75M a frame, twice). */
  private streetFurniture: Placements[] = [];
  private furnitureAt = new THREE.Vector3(Infinity, 0, Infinity);
  private furnitureReach = 0;
  private furnitureTagged = '';
  private furnishMatrix = new THREE.Matrix4();
  private furnishColor = new THREE.Color();
  private cityAudio = new CityAudio();
  /** Territory as a painted line on the pavement, drawn as geometry so it
   * stays crisp at every zoom (the ground texture blurred it into a band). */
  private territoryLines!: InstancePool;
  private territorySegments: { x: number; z: number; length: number; alongX: boolean; color: string; inner: boolean }[] = [];
  private territoryLaidPx = -1;
  /** Hidden boxes to each opened building's top-storey cut, for sightlines only. */
  private sightProxies!: InstancePool;
  private entryDoors!: InstancePool;
  private cutawayDoors!: InstancePool;
  private gableRoofs!: InstancePool;
  private hipRoofs!: InstancePool;
  private cornice!: InstancePool;
  private rubble!: InstancePool;
  private rubbleModels?:SculptRubble;
  private fireDamageDecor!:FireDamageDecor;
  private rubbleLoad:Promise<void>|null=null;
  private shopBase!: InstancePool;
  /** Boards and notice over a shopfront the FBI has closed. */
  private closedFronts!: InstancePool;
  /** Delivered shop photographs already contain stone, joinery and glass colour. */
  private deliveredStorefront = false;
  private plinthBase!: InstancePool;
  private signs!: InstancePool;
  private banners!: InstancePool;
  private awnings!: InstancePool;
  private fireEscapes!: InstancePool;
  private sawteeth!: InstancePool;
  private columns!: InstancePool;
  private pediments!: InstancePool;
  private spires!: InstancePool;
  private domes!: InstancePool;
  private tanks!: InstancePool;
  private dockCranes!: InstancePool;
  private trainSheds!: InstancePool;
  private stationClocks!: InstancePool;
  private chimneys!: InstancePool;
  private bulkheads!: InstancePool;
  private picks!: InstancePool;
  /** Every per-building layer except the walls, reset and committed together. */
  private decor: InstancePool[] = [];
  private buildingIds: ID[] = [];

  // --- street layers
  private pavement!: InstancePool;
  private lamps!: InstancePool;
  private lampGlow!: InstancePool;
  private hydrants!: InstancePool;
  private trees!: InstancePool;
  private treeModels?: SculptTrees;
  private treeLoad: Promise<void> | null = null;

  // --- movers
  /** People at the wheel this frame, drawn as cars once the traffic is in. */
  private drivers: { x: number; z: number; facing: number; hex: number; kind: VehicleId; moving?: boolean }[] = [];
  private actors!: ActorLayer;
  private actorMotion = new ActorMotion();
  private characterActions:CharacterActions;
  private cityEffects?:CityEffects;
  private burningPeople?:BurningPeople;
  private emergencyHoses?:EmergencyHoses;
  private actionDelta=0;
  private actionsEnabled=new URLSearchParams(window.location.search).get('characterActions')==='1';
  private actorPreview: PreviewActorMotion = { x: 0, y: 0, facing: 0, moving: false };
  /** How far each car has pulled in to the kerb (0 in its lane, 1 parked), by car. */
  private pulledIn = new Map<string, number>();
  /** Where the cars standing at the kerb are drawn this frame. */
  private standingCars: { x: number; y: number }[] = [];
  private kerbScratch = { x: 0, y: 0 };
  /** Invisible selection envelopes preserve reliable picking at the original's smaller human scale. */
  private agentMesh!: THREE.InstancedMesh;
  private agentIds: ID[] = [];
  /** Your own colour at your people's feet, and the hand and bars over waiting and arrested figures. */
  private footRings!: InstancePool;
  private waitMarks!: InstancePool;
  private arrestMarks!: InstancePool;
  private sedans!: InstancePool;
  private trucks!: InstancePool;
  private speedsters!: InstancePool;
  private headlamps!: InstancePool;
  private vehicleSprites: VehicleSpriteLayer | null = null;
  private preferVehicleSprites = false;
  private vehicleSpritesActive = false;
  private reviewSpeedsterSprite = false;
  private sculptModels: SculptReviewLayer | null = null;
  private sculptLoad: Promise<void> | null = null;
  private preferSculptModels = false;
  private sculptModelsActive = false;
  private characterDetailStats = { bodyPixels: 0, inView: 0, eligible: 0, detailed: 0, simplified: 0 };
  /** Last frame's fully animated figures (see DETAIL_KEEP_METRES). */
  private lastDetailedIds: ReadonlySet<number> = new Set();

  private selectionRing!: THREE.Mesh;
  private buildingOutline!: BuildingOutline;
  /** The same outline round the selected person, following the figure. */
  private personHalo!: THREE.Mesh;
  private selectedPersonId: ID | null = null;
  private selectedBuildingId: ID | null = null;
  private footprints = new Map<ID, PlacedMass[]>();
  private buildingPickBounds = new BuildingPickBounds();
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private bounce!: THREE.DirectionalLight;

  // --- materials that respond to the time of day
  private facadeMats: THREE.MeshStandardMaterial[] = [];
  private shopMat!: THREE.MeshStandardMaterial;
  private glowMat!: THREE.MeshBasicMaterial;
  private headlampMat!: THREE.MeshBasicMaterial;
  private groundMat!: RoadSurfaceMaterial;

  private target = new THREE.Vector3();
  private zoom = 1.5;
  private tagged = new TaggedViews();
  private taggedCutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), KERB_H + .8);
  private taggedPreview: PreviewActorMotion = { x: 0, y: 0, facing: 0, moving: false };
  /** Looking at the city from the opposite corner, to see the far side of the blocks. */
  private flipped = false;
  private width = 1;
  private height = 1;

  private overlays: OverlayKind[] = ['territory'];
  private planningAvailable = new Set<ID>();
  private planningPeople = new Map<ID, { x: number; y: number }>();
  private planningPersonMarks: InstancePool | null = null;
  private planningSelected = new Set<ID>();
  private planningCrimes = new Set<ID>();
  // Matches the City Plan: teal can be chosen, magenta is chosen; no gang wears either.
  private planningBlue = new THREE.Color('#22c7ba');
  private planningRed = new THREE.Color('#ff3b9d');
  private planningYellow = new THREE.Color('#e4b422');
  private overlayGang: ID | null = null;
  private overlayTeamBlocks: ID[] = [];
  private groundDirty = true;
  /** A user action (overlay, new world): repaint without waiting. */
  private groundUrgent = true;
  private groundCheckedAt = 0;
  private shadowWatchedAt = -Infinity;
  private buildingsUrgent = true;
  private buildingsCheckedAt = 0;
  /** People bucketed by street cell once a game minute (refreshAgents). */
  private peopleGrid: { key: string; cells: Map<number, Person[]> } | null = null;
  private buildingsDirty = true;
  private hiddenRoofs = false;
  /** Street-view B toggle: remove the building meshes to expose pavement and people. */
  private buildingsRemoved = false;
  private groundSig: number | null = null;
  private buildingSig = -1;
  private buildingViews = new Map<boolean, PoolSnapshot[]>();
  private buildingViewMeshes = new Map<boolean, PoolView[]>();
  private makingBuildingView = false;
  private foregroundCutaways = new Set<ID>();
  private cutawayRay = new THREE.Raycaster();
  private cutawayPoint = new THREE.Vector3(Infinity, Infinity, Infinity);
  private cutawayPerson: ID | null = null;
  private cutawayBuilding: ID | null = null;
  private cutawayCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private cutawayFlipped = false;
  private cutawayRevision = -2;
  private cutawayRadius = -1;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private projScratch = new THREE.Vector3();
  private dummy = new THREE.Object3D();
  private colorScratch = new THREE.Color();
  private tintScratch = new THREE.Color();
  private uvScratch = new THREE.Vector4();
  private mat4 = new THREE.Matrix4();
  private clock = 0;
  /** Seconds of game time: runs with the sim's speed, stops when it pauses. */
  private simClock = 0;
  private timeScale = 1;
  /** Fraction of the current sim minute already elapsed; see Sim.subMinute. */
  private subMinute = 0;
  /** False while the week is being planned: nobody and nothing is on the streets. */
  private streetsOpen = true;
  private lastFrame = 0;

  constructor(canvas: HTMLCanvasElement, world: WorldState, deferConstruction = false) {
    this.world = world;
    this.characterActions = new CharacterActions(world);
    // The source bundle and decoded images are cached; this instance owns its
    // bundle metadata and every texture wrapper uploaded to its WebGL context.
    this.tex = { ...cityTextures() };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // World matrices are brought up to date once a frame in render(), not again
    // by every pass: each Tagged window re-renders the whole scene.
    this.scene.matrixWorldAutoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;

    this.camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -2000, 4000);
    const cityW = world.gridW * CELL;
    const cityH = world.gridH * CELL;
    this.target.set(cityW / 2, 0, cityH / 2);

    this.scene.background = new THREE.Color(0x2b3038);
    this.scene.fog = new THREE.Fog(0x2b3038, 900, 2600);

    if (!deferConstruction) {
      try {
        for (const build of this.constructionSteps()) build();
        this.finishConstruction();
      } catch (error) {
        this.dispose();
        throw error;
      }
    }
  }

  /** Open a city without combining all geometry construction in one input turn. */
  static async create(
    canvas: HTMLCanvasElement,
    world: WorldState,
    isCurrent: () => boolean = () => true,
  ): Promise<CityRenderer | null> {
    // Let the opening UI paint, and let an immediate navigation cancel before
    // allocating a WebGL renderer (including React's development remount).
    await yieldForInput();
    if (!isCurrent()) return null;
    // A canvas whose city was closed gave its context back: restore it first.
    await restoreReleasedContext(canvas);
    if (!isCurrent()) return null;
    const city = new CityRenderer(canvas, world, true);
    try {
      for (const build of city.constructionSteps()) {
        await yieldForInput();
        if (!isCurrent()) { city.dispose(); return null; }
        build();
      }
      if (!isCurrent()) { city.dispose(); return null; }
      city.finishConstruction();
      return city;
    } catch (error) {
      city.dispose();
      throw error;
    }
  }

  private constructionSteps(): (() => void)[] {
    return [
      () => this.buildLights(),
      () => this.buildGround(),
      () => this.buildMaterials(),
      () => this.buildBuildings(),
      () => this.buildStreet(),
      () => this.buildAgents(),
      () => this.buildTraffic(),
      () => this.buildSelection(),
      () => {this.cityEffects=new CityEffects(this.world,this.scene);this.burningPeople=new BurningPeople(this.scene);this.emergencyHoses=new EmergencyHoses(this.scene);this.carGunfire=new CarGunfire(this.scene);},
      () => this.refreshBuildings(),
      () => this.refreshStreet(),
      () => this.updateCamera(),
    ];
  }

  private finishConstruction(): void {
    const rubbleModels=new SculptRubble();this.rubbleModels=rubbleModels;this.scene.add(rubbleModels.group);
    this.rubbleLoad=rubbleModels.load().then(()=>{this.rubbleLoad=null;if(this.disposed)return;this.refreshBuildings();this.preparationRevision++;});
    const treeModels = new SculptTrees(); this.treeModels = treeModels; this.scene.add(treeModels.group);
    this.treeLoad = treeModels.load().then(() => {
      this.treeLoad = null;
      if (this.disposed) return;
      this.refreshStreet(); this.preparationRevision++;
    });
    document.fonts?.addEventListener('loadingdone', this.fontsLoaded);
    // A font can finish during staged construction, before the listener exists.
    void document.fonts?.ready.then(() => { if (!this.disposed) this.fontsLoaded(); });
    // A handle for poking at the scene from the console while developing.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__city = this;

    // The painted city is on screen already; the photographed one replaces it
    // texture by texture as the files come in.
    void loadCityArt().then((art) => {
      if (!this.disposed) this.applyArt(art);
    });
  }

  /** Swap the delivered textures into the materials that are already in use. */
  private applyArt(art: CityArt): void {
    // Any pending upload list may now contain wrappers that are being replaced.
    this.preparationRevision++;
    art.facades.forEach((f, i) => {
      const m = this.facadeMats[i];
      if (!f || !m) return;
      m.map = this.ownedTextures.replace(m.map, f.map);
      m.emissiveMap = this.ownedTextures.replace(m.emissiveMap, f.lights);
      m.needsUpdate = true;
    });
    if (art.storefront) {
      this.shopMat.map = this.ownedTextures.replace(this.shopMat.map, art.storefront.map);
      this.shopMat.emissiveMap = this.ownedTextures.replace(this.shopMat.emissiveMap, art.storefront.lights);
      this.deliveredStorefront = true;
      // The delivered emission image already encodes its warm light colour.
      this.shopMat.emissive.setRGB(1, 1, 1);
      this.shopMat.needsUpdate = true;
    }
    if (art.roof) {
      this.roofMat.map = this.ownedTextures.replace(this.roofMat.map, art.roof, 1, 1);
      this.roofMat.needsUpdate = true;
    }
    if (art.plinth) {
      this.plinthMat.map = this.ownedTextures.replace(this.plinthMat.map, art.plinth, 1, 1);
      this.plinthMat.needsUpdate = true;
    }
    if (art.pavement) {
      this.paveTop.map = this.ownedTextures.replace(this.paveTop.map, art.pavement, (SLAB_HALF * 2) / 6, (SLAB_HALF * 2) / 6);
      this.paveTop.needsUpdate = true;
    }
    if (art.kerb) {
      this.kerbSide.map = this.ownedTextures.replace(this.kerbSide.map, art.kerb, (SLAB_HALF * 2) / 6, 1);
      this.kerbSide.needsUpdate = true;
    }
    if (art.awning) {
      this.awnMat.map = this.ownedTextures.replace(this.awnMat.map, art.awning, 1, 1);
      this.awnMat.needsUpdate = true;
    }
    // The saw-tooth roof only takes glazing if its geometry has somewhere to put it.
    if (art.sawtooth && this.sawteeth.mesh.geometry.getAttribute('uv')) {
      this.sawMat.map = this.ownedTextures.replace(this.sawMat.map, art.sawtooth, 1, 1);
      this.sawMat.needsUpdate = true;
    }
    if (art.signs) {
      // Same layout, same indexes: only the boards under the names change.
      this.tex.signs = art.signs;
      this.signMat.map = this.ownedTextures.replace(this.signMat.map, art.signs.map);
      this.signMat.needsUpdate = true;
    }
    if (art.road) this.groundMat.setAsphalt(art.road);
    // Replace the fallback paint tint as soon as the photograph is available.
    if (art.storefront) this.refreshBuildings();
  }

  // ------------------------------------------------------------ construction

  private buildLights(): void {
    this.hemi = new THREE.HemisphereLight(0x9fb4d2, 0x3b3227, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffe7bd, 2.3);
    this.sun.position.set(-160, 260, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    // This camera spans 1,399 metres of depth: even a small depth bias can
    // detach pedestrian shadows. Keep both offsets below shoe-sole height.
    this.sun.shadow.bias = -0.00002;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // The existing cool fill follows the viewed elevations in updateCamera.
    // Its colour and day-dependent intensity remain independent of the view.
    // Trial: quadruple horizontal fill while preserving its vertical irradiance.
    const fillScale = Math.hypot(720, 120, 560) / Math.hypot(180, 120, 140);
    this.bounce = new THREE.DirectionalLight(0x8fa8c8, 0.35 * fillScale);
    this.bounce.position.set(720, 120, 560);
    this.scene.add(this.bounce);
  }

  private buildGround(): void {
    const w = this.world;
    const cityW = w.gridW * CELL;
    const cityH = w.gridH * CELL;

    this.groundCanvas = document.createElement('canvas');
    this.groundCanvas.width = Math.min(4096, Math.round(cityW * PX_PER_METRE));
    this.groundCanvas.height = Math.min(4096, Math.round(cityH * PX_PER_METRE));
    const ctx = this.groundCanvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for the city plan');
    this.groundCtx = ctx;

    this.groundTexture = this.ownedTextures.own(new THREE.CanvasTexture(this.groundCanvas));
    // RoadSurfaceMaterial composites canvas paint in sRGB, then linearizes once.
    this.groundTexture.colorSpace = THREE.NoColorSpace;
    this.groundTexture.anisotropy = 16;

    const geo = new THREE.PlaneGeometry(cityW, cityH);
    geo.rotateX(-Math.PI / 2);
    this.groundMat = new RoadSurfaceMaterial(this.groundTexture, this.ownedTextures, makeGritTile(), cityStreetInset(w), paveWidth(w));
    this.ground = new THREE.Mesh(geo, this.groundMat);
    this.ground.position.set(cityW / 2, 0, cityH / 2);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  private buildMaterials(): void {
    this.facadeMats = this.tex.facades.map((f, index) => {
      const gain = FACADE_ALBEDO_GAIN[index] ?? 1;
      const m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(gain, gain, gain),
        map: this.ownedTextures.clone(f.map),
        emissiveMap: this.ownedTextures.clone(f.lights),
        emissive: new THREE.Color(0xffc978),
        emissiveIntensity: 0,
        roughness: 0.88,
        metalness: 0.02,
      });
      patchInstancedUv(m, true);
      return m;
    });

    this.shopMat = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.storefront.map),
      emissiveMap: this.ownedTextures.clone(this.tex.storefront.lights),
      emissive: new THREE.Color(0xffc98a),
      emissiveIntensity: 0,
      roughness: 0.72,
      metalness: 0.04,
    });
    patchInstancedUv(this.shopMat);

    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffdc9a, transparent: true, opacity: 0 });
    this.headlampMat = new THREE.MeshBasicMaterial({ color: 0xfff0c4, transparent: true, opacity: 0 });
  }

  private buildBuildings(): void {
    const nB = Math.max(64, Object.keys(this.world.buildings).length);
    const cap = nB + 800;

    const roofMat = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.roof, 1, 1),
      roughness: 0.95,
      metalness: 0,
    });
    patchRoofUv(roofMat);
    this.roofMat = roofMat;

    const shell = wallShellGeometry();
    const openShell = wallShellGeometry(true);
    for (const mat of this.facadeMats) {
      const pool = new InstancePool(shell, [mat, roofMat], cap, {
        color: true,
        uv: true,
        castShadow: true,
        receiveShadow: true,
      });
      this.wallPools.push(pool);
      this.scene.add(pool.mesh);
      const openPool = new InstancePool(openShell, mat, nB, { color: true, uv: true, castShadow: true, receiveShadow: true });
      this.cutawayWalls.push(openPool);
      this.scene.add(openPool.mesh);
    }
    shell.dispose();
    openShell.dispose();
    const interior = createInteriorMaterials(this.ownedTextures);
    this.interiorRooms = new InstancePool(interiorGeometry(), interior.rooms, nB, { color: true, receiveShadow: true });
    this.interiorWorks = new InstancePool(interiorGeometry(true), interior.works, nB, { color: true, receiveShadow: true });
    this.interiorMachines = new InstancePool(worksMachineGeometry(),
      new THREE.MeshStandardMaterial({ roughness: .82, metalness: .16, vertexColors: true }), nB * 3,
      { castShadow: true, receiveShadow: true });
    this.interiorStorage = new InstancePool(storedGoodsGeometry(),
      new THREE.MeshStandardMaterial({ roughness: .94, vertexColors: true }), nB * 3,
      { castShadow: true, receiveShadow: true });
    // Rooms are drawn only for buildings in view (furnishNear), so the pools
    // are sized for those, not for the whole city.
    const nearRooms = Math.min(nB, 320);
    const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0);
    this.cutawayCaps = new InstancePool(unitBox, new THREE.MeshStandardMaterial({ roughness: .96, metalness: 0 }), nearRooms * 90,
      { color: true, castShadow: true, receiveShadow: true });
    this.cutawayLinings = new InstancePool(unitBox, new THREE.MeshStandardMaterial({ roughness: .98, metalness: 0 }), nearRooms * 14,
      { color: true, castShadow: true, receiveShadow: true });
    const lineBox = new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0);
    this.territoryLines = new InstancePool(lineBox, new THREE.MeshStandardMaterial({ roughness: .7, metalness: 0 }),
      Math.max(64, this.world.gridW * this.world.gridH * 10), { color: true, receiveShadow: true });
    this.scene.add(this.territoryLines.mesh);
    lineBox.dispose();
    unitBox.dispose();
    const furnitureMat = new THREE.MeshStandardMaterial({ roughness: .9, metalness: .02, vertexColors: true });
    for (const kind of FURNITURE_KINDS) {
      const geometry = furnitureGeometry(kind);
      this.furniture.set(kind, new InstancePool(geometry, furnitureMat, kind === 'stairs' ? nearRooms : nearRooms * 5,
        { color: true, castShadow: true, receiveShadow: true }));
      geometry.dispose();
    }
    // Door geometry retains its existing vertex palette and material response.
    const doorMat = new THREE.MeshStandardMaterial({ roughness: .95, vertexColors: true });
    this.entryDoors = new InstancePool(entryDoorGeometry(), doorMat, nB, { color: true, castShadow: true, receiveShadow: true });
    this.cutawayDoors = new InstancePool(entryDoorGeometry(true), doorMat, nB, { color: true, castShadow: true, receiveShadow: true });
    const pitchedMat = createPitchedRoofMaterials(this.ownedTextures);
    this.gableRoofs = new InstancePool(pitchedRoofGeometry(), pitchedMat.gable, nB, { color: true, castShadow: true, receiveShadow: true });
    this.hipRoofs = new InstancePool(pitchedRoofGeometry(true), pitchedMat.hip, nB, { color: true, castShadow: true, receiveShadow: true });

    const front = frontageGeometry();
    const slab = slabGeometry();

    const corniceMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.02 });
    this.cornice = new InstancePool(slab, corniceMat, nB * 5 + 2400, {
      color: true,
      castShadow: true,
      receiveShadow: true,
    });

    this.rubble=new InstancePool(rubbleGeometry(true),new THREE.MeshStandardMaterial({roughness:1,color:0x8c7160}),nB*64,
      {color:true,castShadow:true,receiveShadow:true});
    this.closedFronts = new InstancePool(front, closedFrontMaterial(), nB, { receiveShadow: true });
    this.shopBase = new InstancePool(front, this.shopMat, nB, {
      color: true,
      uv: true,
      castShadow: true,
      receiveShadow: true,
    });

    const plinthMat = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.plinth, 1, 1),
      roughness: 0.9,
      metalness: 0,
    });
    patchInstancedUv(plinthMat);
    this.plinthMat = plinthMat;
    this.plinthBase = new InstancePool(front, plinthMat, nB, {
      color: true,
      uv: true,
      castShadow: true,
      receiveShadow: true,
    });

    const signMat = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.signs.map),
      roughness: 0.7,
      metalness: 0.05,
      emissive: new THREE.Color(0xffd08a),
      emissiveIntensity: 0,
    });
    patchInstancedUv(signMat);
    this.signMat = signMat;
    this.signs = new InstancePool(front, signMat, nB, { uv: true, castShadow: false, receiveShadow: true });

    const bannerMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    this.banners = new InstancePool(front.clone(), bannerMat, nB, { color: true, receiveShadow: true });

    const awnMat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide, vertexColors: true });
    this.awnMat = awnMat;
    this.awnings = new InstancePool(awningGeometry(), awnMat, nB, { color: true, castShadow: true });

    const ironMat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.35, vertexColors: true });
    this.fireEscapes = new InstancePool(fireEscapeGeometry(), ironMat, nB, { castShadow: true });

    const roofPropMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: true });
    // The saw-tooth roofs get a material of their own so the glazing can be mapped in later.
    this.sawMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: true });
    this.sawteeth = new InstancePool(sawtoothGeometry(), this.sawMat, nB, {
      castShadow: true,
      receiveShadow: true,
    });
    this.tanks = new InstancePool(waterTankGeometry(), roofPropMat, Math.ceil(nB / 2), { castShadow: true });
    // Landmark dressing (playtest, 1 October): the Docks' crane, the terminal's glazed shed and clock.
    const landmarkMat = new THREE.MeshStandardMaterial({ roughness: .7, metalness: .25, vertexColors: true });
    this.dockCranes = new InstancePool(dockCraneGeometry(), landmarkMat, 16, { castShadow: true, receiveShadow: true });
    this.trainSheds = new InstancePool(trainShedGeometry(),
      new THREE.MeshStandardMaterial({ roughness: .3, metalness: .35, vertexColors: true, side: THREE.DoubleSide }), 16, { castShadow: true, receiveShadow: true });
    this.stationClocks = new InstancePool(stationClockGeometry(), landmarkMat, 16, {});
    this.chimneys = new InstancePool(chimneyGeometry(), roofPropMat, nB * 2, {
      castShadow: true,
      receiveShadow: true,
    });
    this.bulkheads = new InstancePool(bulkheadGeometry(), roofPropMat, nB, {
      castShadow: true,
      receiveShadow: true,
    });

    const stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
    this.columns = new InstancePool(columnGeometry(), stoneMat, 600, { color: true, castShadow: true });
    this.pediments = new InstancePool(pedimentGeometry(), stoneMat, 160, { color: true, castShadow: true });
    this.spires = new InstancePool(spireGeometry(), stoneMat, 64, { color: true, castShadow: true });
    this.domes = new InstancePool(domeGeometry(), stoneMat, 32, { color: true, castShadow: true });

    // The picking proxy: one invisible box per building covering its whole
    // silhouette, so a click anywhere on a tower or a spire still selects it.
    const pickMat = new THREE.MeshBasicMaterial();
    this.picks = new InstancePool(slab, pickMat, nB, {});
    this.picks.makePickable();
    this.picks.mesh.visible = false;
    this.sightProxies = new InstancePool(slab, new THREE.MeshBasicMaterial(), nB, {});
    this.sightProxies.makePickable();
    this.sightProxies.mesh.visible = false;

    front.dispose();
    this.fireDamageDecor=new FireDamageDecor(this.ownedTextures,nB);
    this.decor = [this.rubble,...this.fireDamageDecor.pools,
      this.interiorRooms, this.interiorWorks, this.interiorMachines, this.interiorStorage,
      this.entryDoors, this.cutawayDoors, this.gableRoofs, this.hipRoofs,
      this.cornice,
      this.shopBase,
      this.closedFronts,
      this.plinthBase,
      this.signs,
      this.banners,
      this.awnings,
      this.fireEscapes,
      this.sawteeth,
      this.tanks,
      this.dockCranes,
      this.trainSheds,
      this.stationClocks,
      this.chimneys,
      this.bulkheads,
      this.columns,
      this.pediments,
      this.spires,
      this.domes,
      this.picks, this.sightProxies,
    ];
    for (const p of this.decor) this.scene.add(p.mesh);
    for (const p of this.roomPools()) this.scene.add(p.mesh);
  }

  private buildStreet(): void {
    const nBlocks = Math.max(16, this.world.blocks.length);

    // Pavement slabs: a raised kerbed platform under each block.
    const slabGeo = new THREE.BoxGeometry(SLAB_HALF * 2, KERB_H, SLAB_HALF * 2);
    slabGeo.translate(0, KERB_H / 2, 0);
    const paveTop = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.pavement, (SLAB_HALF * 2) / 6, (SLAB_HALF * 2) / 6),
      roughness: 0.94,
      metalness: 0.02,
    });
    const kerbSide = new THREE.MeshStandardMaterial({
      map: this.ownedTextures.clone(this.tex.kerb, (SLAB_HALF * 2) / 6, 1),
      roughness: 0.9,
    });
    this.paveTop = paveTop;
    this.kerbSide = kerbSide;
    this.pavement = new InstancePool(
      slabGeo,
      [kerbSide, kerbSide, paveTop, kerbSide, kerbSide, kerbSide],
      nBlocks,
      { color: true, receiveShadow: true },
    );
    this.scene.add(this.pavement.mesh);

    const ironMat = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.3, vertexColors: true });
    this.lamps = new InstancePool(lampPostGeometry(), ironMat, nBlocks * 4, { castShadow: true });
    this.lampGlow = new InstancePool(lampGlowGeometry(), this.glowMat, nBlocks * 4, {});
    const propMat = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
    this.hydrants = new InstancePool(hydrantGeometry(), propMat, nBlocks * 2, { castShadow: true });
    this.trees = new InstancePool(treeGeometry(), propMat, nBlocks * 3, { castShadow: true });

    for (const p of [this.lamps, this.lampGlow, this.hydrants, this.trees]) this.scene.add(p.mesh);
  }

  private buildAgents(): void {
    this.actors = new ActorLayer(this.scene, MAX_AGENTS);
    for (const mesh of this.actors.meshes) mesh.userData.actorRootHeight = KERB_H + .008;
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const agentGeo = new THREE.BoxGeometry(.68, 1.97, .66);
    agentGeo.translate(0, .985, 0);
    this.agentMesh = new THREE.InstancedMesh(agentGeo, mat, MAX_AGENTS);
    this.agentMesh.name = 'actor-picking-envelopes';
    this.agentMesh.userData.pickingOnly = true;
    this.agentMesh.frustumCulled = false;
    this.agentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.agentMesh.count = 0;
    this.scene.add(this.agentMesh);

    // Your colour at the feet: a flat ring under each of your own people.
    const ringGeo = new THREE.RingGeometry(0.42, 0.51, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    this.footRings = new InstancePool(ringGeo, ringMat, MAX_AGENTS / 4, { color: true, dynamic: true });
    this.footRings.mesh.renderOrder = 9;
    this.scene.add(this.footRings.mesh);

    // The original's hand for a hood waiting for the word, and bars for an arrest.
    const markGeo = new THREE.PlaneGeometry(1.45, 1.45);
    const markMat = (draw: (ctx: CanvasRenderingContext2D) => void) =>
      new THREE.MeshBasicMaterial({ map: this.ownedTextures.own(markerTexture(draw)), transparent: true, depthTest: false, depthWrite: false });
    this.waitMarks = new InstancePool(markGeo, markMat(drawHand), MAX_AGENTS / 4, { dynamic: true });
    this.arrestMarks = new InstancePool(markGeo, markMat(drawBars), MAX_AGENTS / 8, { dynamic: true });
    for (const p of [this.waitMarks, this.arrestMarks]) {
      p.mesh.renderOrder = 12;
      this.scene.add(p.mesh);
    }
  }

  private buildTraffic(): void {
    const carMat = createVehicleMaterial();
    const capacity = MAX_CARS + MAX_AGENTS;
    this.sedans = new InstancePool(vehicleGeometry('coupe'), carMat, capacity, {
      color: true,
      castShadow: true,
      dynamic: true,
    });
    this.trucks = new InstancePool(vehicleGeometry('truck'), carMat, capacity, {
      color: true,
      castShadow: true,
      dynamic: true,
    });
    this.speedsters = new InstancePool(vehicleGeometry('speedster'), carMat, MAX_AGENTS, { color: true, castShadow: true, dynamic: true });
    this.sedans.mesh.name = 'vehicle-coupe';
    this.trucks.mesh.name = 'vehicle-truck';
    this.speedsters.mesh.name = 'vehicle-speedster';
    this.headlamps = new InstancePool(vehicleLightGeometry(), this.headlampMat, capacity, { dynamic: true });
    for (const p of [this.sedans, this.trucks, this.speedsters, this.headlamps]) this.scene.add(p.mesh);
    // Delivered models are the default. Explicit switches retain the audit/fallback views.
    this.preferVehicleSprites = new URLSearchParams(window.location.search).get('vehicleSprites') === '1';
    if (this.preferVehicleSprites) this.ensureVehicleSprites();
    this.preferSculptModels = useDetailedModels(window.location.search);
    if (this.preferSculptModels) this.ensureSculptModels();
    this.syncVehiclePresentation();
  }

  private ensureSculptModels(): void {
    if (this.sculptModels) return;
    const layer = new SculptReviewLayer(this.scene, MAX_CARS + MAX_AGENTS,
      () => this.syncVehiclePresentation(), MAX_AGENTS);
    this.sculptModels = layer;
    this.sculptLoad = layer.load().then(() => {
      this.sculptLoad = null;
      if (!this.disposed) this.preparationRevision++;
    });
  }

  private ensureVehicleSprites(): void {
    if (this.vehicleSprites) return;
    const layer = new VehicleSpriteLayer(this.scene, MAX_CARS + MAX_AGENTS, () => this.syncVehiclePresentation());
    this.vehicleSprites = layer;
    void layer.load();
  }

  private syncVehiclePresentation(): void {
    const previousSprites = this.vehicleSpritesActive, previousModels = this.sculptModelsActive;
    const active = this.preferVehicleSprites && !!this.vehicleSprites?.ready && !this.disposed;
    this.vehicleSpritesActive = active;
    this.sculptModelsActive = this.preferSculptModels && !!this.sculptModels?.ready && !active && !this.disposed;
    if (previousSprites !== this.vehicleSpritesActive || previousModels !== this.sculptModelsActive) this.preparationRevision++;
    this.vehicleSprites?.setVisible(this.streetsOpen && active);
    this.sculptModels?.setVisible(this.streetsOpen && this.sculptModelsActive);
    this.sedans.mesh.visible = this.streetsOpen && !active && !this.sculptModelsActive;
    this.trucks.mesh.visible = this.streetsOpen && !active && !this.sculptModelsActive;
    // The open car's seated 3D driver currently protrudes through the billboard
    // in one camera view. Keep that pairing intact until a matching rider exists.
    this.speedsters.mesh.visible = this.streetsOpen && !this.sculptModelsActive && !(active && this.reviewSpeedsterSprite);
  }

  /** Switch between detailed models and the lightweight fallback. */
  setSculptModelsEnabled(enabled: boolean): void {
    this.preferSculptModels = enabled;
    if (enabled) this.ensureSculptModels();
    this.syncVehiclePresentation();
  }

  getSculptModelStatus(): { requested: boolean; ready: boolean; active: boolean;
    error: string | null; characters: number; cachedCharacters: number; vehicles: number;
    presentation: { bodyPixels: number; inView: number; eligible: number; detailed: number; simplified: number } } {
    return { requested: this.preferSculptModels, ready: !!this.sculptModels?.ready,
      active: this.sculptModelsActive, error: this.sculptModels?.error ?? null,
      characters: this.sculptModels?.characterCount ?? 0,
      cachedCharacters: this.sculptModels?.cachedCharacterCount ?? 0,
      vehicles: this.sculptModels?.vehicleCount ?? 0, presentation: { ...this.characterDetailStats } };
  }

  /** Temporary review switch; the production city keeps its measured 3D vehicles. */
  setVehicleSpritesEnabled(enabled: boolean): void {
    this.preferVehicleSprites = enabled;
    if (enabled) this.ensureVehicleSprites();
    this.syncVehiclePresentation();
  }

  /** Isolated art QA only; the seated driver still needs a matching sprite. */
  setSpeedsterSpriteForReview(enabled: boolean): void {
    this.reviewSpeedsterSprite = enabled;
    this.syncVehiclePresentation();
  }

  getVehicleSpriteStatus(): { requested: boolean; ready: boolean; active: boolean; error: string | null } {
    return { requested: this.preferVehicleSprites, ready: !!this.vehicleSprites?.ready,
      active: this.vehicleSpritesActive, error: this.vehicleSprites?.error ?? null };
  }

  private buildSelection(): void {
    const geo = new THREE.RingGeometry(LOT_SIZE * 0.5, LOT_SIZE * 0.63, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd479,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.selectionRing = new THREE.Mesh(geo, mat);
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 10;
    this.scene.add(this.selectionRing);

    this.buildingOutline = new BuildingOutline();

    const personRing = new THREE.RingGeometry(.55, .65, 40);
    personRing.rotateX(-Math.PI / 2);
    this.personHalo = new THREE.Mesh(personRing, new THREE.MeshBasicMaterial({ color: 0xffd16c, depthTest: false, depthWrite: false, toneMapped: false }));
    this.personHalo.renderOrder = 11;
    this.personHalo.visible = false;
    this.scene.add(this.personHalo);
  }

  // ------------------------------------------------------------ ground plan

  private clearGroundBase(): void {
    if (this.groundBase) {
      this.groundBase.width = 0;
      this.groundBase.height = 0;
      this.groundBase = null;
    }
  }

  /** Static markings are rasterized once; changing overlays reuse those pixels. */
  private drawGroundBase(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const cw = this.groundCanvas.width;
    const ch = this.groundCanvas.height;
    const sx = cw / (w.gridW * CELL);
    const sy = ch / (w.gridH * CELL);
    const s = (sx + sy) / 2;

    // Only low-frequency stains and strategic colours use the city-size canvas.
    // Asphalt, road markings and names are sampled at their native resolution.
    for (const blk of activeBlocks(w)) {
      // Bridges and the river have no slab over them; keep their asphalt.
      if (avenueRoadway(blk) || blk.layout?.use === 'water') continue;
      const rect = blockRect(blk);
      const pave = paveWidth(w), ox = (rect.x - pave) * sx, oy = (rect.y - pave) * sy;
      ctx.fillStyle = '#26262a';
      ctx.fillRect(ox, oy, (rect.w + 2 * pave) * sx, (rect.h + 2 * pave) * sy);
    }

    // Manholes and puddles, placed off the block ids so they never wander.
    const slabHalf = BLOCK_SIZE / 2 + paveWidth(w);
    for (const blk of activeBlocks(w)) {
      const n = rint(blk.id, 61, 3);
      for (let k = 0; k < n; k++) {
        const px = (blk.gx * CELL + r01(blk.id, 70 + k) * CELL) * sx;
        const py = (blk.gy * CELL + r01(blk.id, 90 + k) * CELL) * sy;
        // Only mark the roadway, not under the slabs.
        const lx = px / sx - blk.gx * CELL;
        const ly = py / sy - blk.gy * CELL;
        const inSlab =
          lx > CELL / 2 - slabHalf && lx < CELL / 2 + slabHalf && ly > CELL / 2 - slabHalf && ly < CELL / 2 + slabHalf;
        if (inSlab && blk.layout?.use !== 'avenue') continue;
        ctx.beginPath();
        ctx.arc(px, py, 0.85 * s, 0, Math.PI * 2);
        ctx.fillStyle = k === 0 ? 'rgba(70,68,62,0.85)' : 'rgba(120,126,132,0.1)';
        ctx.fill();
      }
    }

  }

  private drawGround(): void {
    const w = this.world, ctx = this.groundCtx;
    const cw = this.groundCanvas.width, ch = this.groundCanvas.height;
    const sx = cw / (w.gridW * CELL), sy = ch / (w.gridH * CELL), s = (sx + sy) / 2;
    if (!this.groundBase) {
      const base = document.createElement('canvas');
      base.width = cw; base.height = ch;
      // This surface is painted once, then copied as a source. Software backing
      // avoids the extra GPU rasterization cost during initial cache creation.
      // Keep the composite canvas's normal context for its texture uploads.
      const baseCtx = base.getContext('2d', { willReadFrequently: true });
      if (!baseCtx) throw new Error('2D context unavailable for the road markings');
      this.drawGroundBase(baseCtx);
      this.groundBase = base;
    }
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.groundBase, 0, 0);

    // Overlay wash across the whole cell so it reads on the roads too.
    for (const blk of activeBlocks(w)) {
      const tint = this.overlayColor(blk.id);
      if (!tint) continue;
      ctx.fillStyle = tint;
      const rect = blockRect(blk);
      ctx.fillRect(blk.gx * CELL * sx, blk.gy * CELL * sy,
        (rect.w + STREET_WIDTH + cityStreetInset(w) * 2) * sx, (rect.h + STREET_WIDTH + cityStreetInset(w) * 2) * sy);
    }

    // Territory on the kerb: laid as geometry (layTerritoryLines), not painted here.
    const territory: typeof this.territorySegments = [];
    if (this.overlays.includes('territory')) {
      for (const blk of activeBlocks(w)) {
        const colors = this.blockOwners(blk.id).map(id => GANG_COLORS[w.gangs[id].color].hex);
        if (!colors.length) continue;
        const rect = blockRect(blk), pave = paveWidth(w);
        // A double rule on the pavement just inside the kerb, as a boundary on
        // a period plan; shared blocks alternate their owners along each side.
        for (const [inset, inner] of [[.3, false], [.75, true]] as [number, boolean][]) {
          const x0 = rect.x - pave + inset, z0 = rect.y - pave + inset;
          const x1 = rect.x + rect.w + pave - inset, z1 = rect.y + rect.h + pave - inset;
          const sides: [number, number, number, number][] = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
          for (const [ax, az, bx, bz] of sides) colors.forEach((color, i) => {
            const t0 = i / colors.length, t1 = (i + 1) / colors.length;
            const sx0 = ax + (bx - ax) * t0, sz0 = az + (bz - az) * t0, sx1 = ax + (bx - ax) * t1, sz1 = az + (bz - az) * t1;
            territory.push({ x: (sx0 + sx1) / 2, z: (sz0 + sz1) / 2, length: Math.hypot(sx1 - sx0, sz1 - sz0),
              alongX: Math.abs(bx - ax) > Math.abs(bz - az), color, inner });
          });
        }
      }
    }

    // Lieutenants' areas (manual: white for the selected crew, gang colour for
    // the others), outlined on the pavement inside the territory line so they
    // read under the buildings at every zoom.
    if (this.overlays.includes('lieutenant') && this.overlayGang != null && w.gangs[this.overlayGang]) {
      const gang = w.gangs[this.overlayGang], mine = new Set(this.overlayTeamBlocks);
      const others = new Set(gang.teamIds.flatMap(id => w.teams[id]?.allocatedBlockIds ?? [])
        .map(id => w.blocks[id]?.layout?.mergedInto ?? id).filter(id => !mine.has(id)));
      for (const blk of activeBlocks(w)) {
        const color = mine.has(blk.id) ? '#ffffff' : others.has(blk.id) ? GANG_COLORS[gang.color].hex : null;
        if (!color) continue;
        const rect = blockRect(blk), pave = paveWidth(w) * .55;
        ctx.globalAlpha = .95;
        drawTerritoryOutline(ctx, (rect.x - pave) * sx, (rect.y - pave) * sy, (rect.w + 2 * pave) * sx,
          (rect.h + 2 * pave) * sy, [color], Math.max(2, 1.3 * s));
        ctx.globalAlpha = 1;
      }
    }

    this.groundTexture.needsUpdate = true;
    this.territorySegments = territory;
    this.territoryLaidPx = -1;
    this.layTerritoryLines();
  }

  /** At least about two screen pixels wide, so the line neither blurs close
   * up nor vanishes at plan zoom; re-laid when the zoom changes. */
  private layTerritoryLines(): void {
    if (!this.territoryLines) return;
    const metresPerPixel = (240 / this.zoom) / Math.max(1, this.height);
    const px = Math.round(metresPerPixel * 1000);
    if (px === this.territoryLaidPx) return;
    this.territoryLaidPx = px;
    const pool = this.territoryLines, color = new THREE.Color(), m = new THREE.Matrix4();
    const q = new THREE.Quaternion(), scale = new THREE.Vector3(), pos = new THREE.Vector3();
    pool.reset();
    for (const seg of this.territorySegments) {
      const width = Math.max(seg.inner ? .1 : .26, metresPerPixel * (seg.inner ? 1.2 : 2.2));
      pos.set(seg.x, KERB_H + .004, seg.z);
      scale.set(seg.alongX ? seg.length + width : width, .012, seg.alongX ? width : seg.length + width);
      m.compose(pos, q, scale);
      color.set(seg.color);
      pool.push(m, color);
    }
    pool.commit();
  }

  /** Only changes to painted road colours require a canvas/GPU upload. */
  private groundSignature(): number {
    const w = this.world;
    const territory = this.overlays.includes('territory');
    // A running hash rather than a string of every block: it is only compared
    // for equality, and the string was rebuilt twice a second in the week.
    let h = (Math.imul(w.gridW, 73856093) ^ w.gridH) >>> 0;
    const mix = (v: number) => { h = (Math.imul(h ^ v, 16777619) + 0x9e3779b9) >>> 0; };
    for (const blk of activeBlocks(w)) {
      mix(blk.id); mix(blk.gx); mix(blk.gy);
      const color = this.overlayColor(blk.id);
      if (color) for (let i = 0; i < color.length; i++) mix(color.charCodeAt(i)); else mix(-1);
      // Every known claim and its colour, so discovering or losing a second
      // gang's business, or a gang's colour changing, repaints the borders.
      if (territory) for (const id of this.blockOwners(blk.id)) {
        mix(id + 7919);
        const light = GANG_COLORS[w.gangs[id].color].light;
        for (let i = 1; i < light.length; i++) mix(light.charCodeAt(i));
      }
      mix(-2);
    }
    return h;
  }

  private blockOwners(blockId: ID): ID[] {
    const w = this.world;
    const blk = w.blocks[blockId];
    return blk ? knownBlockOwners(w, blk, this.overlayGang) : [];
  }

  private overlayColor(blockId: ID): string | null {
    const blk = this.world.blocks[blockId];
    if (!blk) return null;

    if (this.overlays.includes('lieutenant')) {
      if (this.overlayTeamBlocks.includes(blockId)) return 'rgba(255,255,255,0.34)';
      const gang = this.overlayGang == null ? null : this.world.gangs[this.overlayGang];
      if (gang?.teamIds.some(id => this.world.teams[id]?.allocatedBlockIds.some(area =>
        (this.world.blocks[area]?.layout?.mergedInto ?? area) === blockId))) return `${GANG_COLORS[gang.color].hex}55`;
    }
    if (this.overlays.includes('landValue')) {
      const t = blk.landValue / 100;
      return `rgba(${Math.round(70 + t * 40)}, ${Math.round(160 + t * 60)}, ${Math.round(120 - t * 40)}, 0.34)`;
    }
    if (this.overlays.includes('crime')) {
      const t = Math.min(1, blk.crimeHeat / 60);
      if (t < 0.03) return null;
      return `rgba(220, ${Math.round(150 - t * 130)}, 40, ${0.15 + t * 0.4})`;
    }
    if (this.overlays.includes('security')) {
      const t = Math.min(1, blk.policePresence / 6);
      if (t < 0.05) return null;
      return `rgba(90, 150, 235, ${0.12 + t * 0.35})`;
    }
    if (this.overlays.includes('hostility') && this.overlayGang != null) {
      let total = 0;
      let n = 0;
      for (const lotId of blk.lotIds) {
        const b = this.world.buildings[this.world.lots[lotId].buildingId];
        if (!b?.ownerPersonId) continue;
        const p = this.world.people[b.ownerPersonId];
        if (!p) continue;
        total += attitudeScore(this.world, p, this.overlayGang);
        n++;
      }
      if (!n) return null;
      const avg = total / n;
      return avg >= 0
        ? `rgba(90, 200, 120, ${Math.min(0.45, (avg / 100) * 0.6 + 0.08)})`
        : `rgba(230, 90, 70, ${Math.min(0.45, (-avg / 100) * 0.6 + 0.08)})`;
    }
    if (this.overlays.includes('events')) {
      const t = Math.min(1, (this.recentEvents().get(blockId) ?? 0) / 4);
      if (!t) return null;
      return `rgba(255, 220, 120, ${0.12 + t * 0.33})`;
    }
    return null;
  }

  private recentEventsKey = '';
  private recentEventsCache = new Map<ID, number>();
  /** Recent Events by block, recounted only when a crime is filed or the week turns. */
  private recentEvents(): Map<ID, number> {
    const w = this.world, key = `${w.week}:${w.crimes.length}:${w.crimes.at(-1)?.id ?? -1}`;
    if (key !== this.recentEventsKey) {
      this.recentEventsKey = key;
      this.recentEventsCache = recentEventCounts(w);
    }
    return this.recentEventsCache;
  }

  // ------------------------------------------------------------ buildings

  /** Cheap fingerprint of everything the skyline and the plan depend on. */
  private signature(): number {
    const w = this.world;
    let s = (w.week * 131 + (this.hiddenRoofs ? 7 : 0) + (this.buildingsRemoved ? 13 : 0)) >>> 0;
    for (const id of this.foregroundCutaways) s = (Math.imul(s, 31) + id) >>> 0;
    for (const o of this.overlays) s = (Math.imul(s, 31) + o.length * 17 + o.charCodeAt(0)) >>> 0;
    s = (Math.imul(s, 31) + (this.overlayGang ?? -1) + this.overlayTeamBlocks.length * 7) >>> 0;
    for (const id of this.overlayTeamBlocks) s = (Math.imul(s, 31) + id) >>> 0;
    for (const actual of buildingList(w)) {
      const b=this.cityEffects?.buildingBeforeImpact(actual.id)??actual;
      const intel = buildingMapIntel(b, this.overlayGang);
      const v =
        (intel.ownerGangId ?? 9) * 31 +
        (intel.protectionGangId ?? 9) * 7 +
        b.state.length * 3 +
        b.state.charCodeAt(0) +
        (intel.isHQ ? 1024 : 0) +
        b.typeId.length * 13+(b.fireWeek??0)*29+(b.repairCompleteWeek??0)*47;
      s = (Math.imul(s, 33) ^ v) >>> 0;
    }
    if (this.overlays.some((o) => o === 'landValue' || o === 'crime' || o === 'security' || o === 'events')) {
      for (const blk of activeBlocks(w)) {
        s = (Math.imul(s, 33) ^ ((blk.landValue | 0) * 7 + (blk.crimeHeat | 0) * 3 + (blk.policePresence | 0))) >>> 0;
      }
    }
    return s;
  }

  refreshBuildings(): void {
    this.cityEffects?.syncSmolderSites(this.world);
    if (!this.makingBuildingView) this.clearBuildingViews();
    const w = this.world;
    const tex = this.tex;
    this.buildingIds = [];
    const rubblePlacements:RubblePlacement[]=[];
    if(this.rubbleModels)this.rubbleModels.group.visible=!this.buildingsRemoved;

    for (const p of [...this.wallPools, ...this.cutawayWalls]) p.reset();
    for (const p of this.decor) p.reset();
    if (!this.makingBuildingView) this.roomCache = [];
    this.footprints.clear();
    // The inset can temporarily rebuild different roofs; only the main view
    // owns the building-selection silhouette.
    const outline = this.makingBuildingView ? null : this.buildingOutline;
    outline?.clear();
    const outlinePools = outline ? [...this.wallPools, ...this.cutawayWalls, ...this.decor].filter(p => p !== this.picks && p !== this.sightProxies) : [];
    const targetPools = [...this.wallPools, ...this.cutawayWalls, ...this.decor].filter(p => p !== this.picks && p !== this.sightProxies && p.mesh.instanceColor);

    if (this.buildingsRemoved) {
      for (const p of [...this.wallPools, ...this.cutawayWalls, ...this.decor]) p.commit();
      if (!this.makingBuildingView) this.furnishNear(true);
      this.picks.mesh.boundingSphere = null;
      this.picks.mesh.boundingBox = null;
      this.buildingsDirty = false;
      return;
    }

    const lowered = this.hiddenRoofs;
    const centreHalfExtents = new Map<ID, number>();
    for (const block of w.blocks) {
      const centreLotId = block.lotIds.find(id => w.lots[id]?.index === CENTRE_LOT);
      const centre = centreLotId == null ? undefined : w.buildings[w.lots[centreLotId].buildingId];
      const profile = centre && (centre.cls !== 'empty' || centre.state === 'destroyed')
        ? profileFor(centre, BUILDING_BY_ID[centre.typeId]) : undefined;
      centreHalfExtents.set(block.id, centreSiteHalfExtent(profile));
    }

    for (const actual of buildingList(w)) {
      const b=this.cityEffects?.buildingBeforeImpact(actual.id)??actual;
      if (b.cls === 'empty' && b.state !== 'destroyed') continue;
      const lot = w.lots[b.lotId];
      if (!lot) continue;
      const blk = w.blocks[b.blockId];
      const t = BUILDING_BY_ID[b.typeId];
      const facing = lotFacing(lot, blk?.center, b.id);
      const prof = profileForLot(b, t, lot, facing);
      const fireStage=fireDamageStage(b,w.week);
      const outlineStarts = outline && b.id === this.selectedBuildingId ? outlinePools.map(p => p.count) : null;
      const targetColor = this.planningSelected.has(b.id) ? this.planningRed : this.planningCrimes.has(b.id) ? this.planningYellow : this.planningAvailable.has(b.id) ? this.planningBlue : null;
      const targetStarts = targetColor ? targetPools.map(p => p.count) : null;

      // Face the street (local +Z); the same facing sized the profile above.
      const yaw = FACING_YAW[facing];
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      const px = lot.center.x;
      const pz = lot.center.y;
      const local = (dx: number, dz: number): [number, number] => [
        px + dx * cosY + dz * sinY,
        pz - dx * sinY + dz * cosY,
      ];

      this.buildingPickBounds.reset(px, pz, yaw);

      // Base colour: a period wall tint per building (fresh and sooted brick,
      // limewash, buff, ochre, grey stone) over the facade texture, with a
      // little lightness variation, then washed with gang colour.
      const tint = WALL_TINTS[Math.floor(r01(b.id, 33) * WALL_TINTS.length)];
      const v = 0.88 + r01(b.id, 30) * 0.24;
      this.colorScratch.setRGB(v * tint[0], v * tint[1], v * tint[2]);
      if (b.state === 'destroyed') this.colorScratch.setRGB(0.26, 0.24, 0.23);
      else if (b.state === 'damaged') this.colorScratch.multiplyScalar(0.52);
      else if (b.state === 'ceased') this.colorScratch.multiplyScalar(0.76);

      const intel = buildingMapIntel(b, this.overlayGang);
      const ownerId = intel.ownerGangId;
      const holdId = ownerId ?? intel.protectionGangId;
      if (ownerId != null) {
        const gang = w.gangs[ownerId];
        if (gang) {
          this.tintScratch.setStyle(GANG_COLORS[gang.color].hex);
          this.colorScratch.lerp(this.tintScratch, intel.isHQ ? 0.42 : 0.2);
        }
      }

      if(fireStage)this.colorScratch.setRGB(.19,.18,.17);
      const uOff = prof.spire ? 0 : r01(b.id, 20);
      let top = 0;

      // Both views use the same centre-clear extension and public street edge;
      // simulation lots and upper building masses never move.
      const edgeLot = !lot.bounds && lot.index !== CENTRE_LOT && lot.index % 2 === 1;
      const { masses: intactMasses, extension: ext } = massesForView(prof, edgeLot, lowered, centreHalfExtents.get(b.blockId));
      // Opened buildings lose their roofs and show their top storey, as in the
      // original; one standing between the camera and the person or place it
      // is watching opens at the pavement instead, so nothing is hidden.
      const groundCutaway = lowered && this.foregroundCutaways.has(b.id);
      const masses = sectionMasses(intactMasses, lowered, groundCutaway);
      // The street front is cut too when the opened storey is the ground floor
      // (a one-storey shop): its awning, sign and shopfront follow the low wall
      // rather than hang in the air above it.
      const frontCut = groundCutaway || (lowered && masses.length > 0 && masses[0].floorY === 0);
      if(fireStage)this.fireDamageDecor.add(masses,px,pz,yaw,fireStage,lowered);
      const placed: PlacedMass[] = [];
      for (let mi = 0; mi < masses.length; mi++) {
        const m = masses[mi];
        const mh = m.h;
        const [wx, wz] = local(m.dx, m.dz);
        this.dummy.position.set(wx, KERB_H + m.y, wz);
        this.dummy.rotation.set(0, yaw, 0);
        this.dummy.scale.set(m.w, mh, m.d);
        placed.push({ x: wx, y: KERB_H + m.y, z: wz, w: m.w + .5, h: mh, d: m.d + .5, yaw });
        this.dummy.updateMatrix();
        this.uvScratch.set(
          m.w / (TILE_BAYS * BAY_W),
          mh / (TILE_STOREYS * STOREY_H),
          uOff + mi * 0.37,
          0,
        );
        (m.open ? this.cutawayWalls : this.wallPools)[prof.facade].push(this.dummy.matrix, this.colorScratch, this.uvScratch);
        if (m.floorY != null && !prof.ruin) {
          this.dummy.position.y = KERB_H + m.floorY;
          this.dummy.scale.set(m.w, 1, m.d);
          this.dummy.updateMatrix();
          // Floors face the sun square on; dim and cool them a little so the boards
          // read as polished wood in shade rather than glowing orange.
          this.tintScratch.setRGB(fireStage?.22:.62,fireStage?.20:.6,fireStage?.18:.6);
          (b.cls === 'industrial' ? this.interiorWorks : this.interiorRooms).push(this.dummy.matrix,this.tintScratch);
          if (!this.makingBuildingView && this.cutawayCaps) this.addCutawayRooms(b, m, mi, yaw, intactMasses, fireStage ? .3 : 1, px, pz);
        }
        top = Math.max(top, m.y + mh);

        if (m.cap && !m.open) {
          // The moulding stops just under the roof line so the roof itself
          // stays visible from above, with the cornice projecting round it.
          const [cx2, cz2] = local(m.dx, m.dz);
          // Works and sheds keep a plain coping; street fronts get a string course.
          const groundFloor = m.y === 0 && b.cls !== 'industrial' ? (prof.base === 'shop' ? prof.baseHeight : STOREY_H) : null;
          this.tintScratch.copy(this.colorScratch).multiply(STONE);
          const rusticated = groundFloor != null && prof.base !== 'shop' && (b.cls === 'municipal' || b.cls === 'charity')
            && !prof.spire && mh > groundFloor + 2.4;
          const bands = mouldingsFor(mh, prof.roof !== 'flat', groundFloor);
          const courses = rusticated ? rusticationCourses(groundFloor) : [];
          for (const band of [...bands, ...courses]) {
            // The weathered base reads darker than the cornice it carries.
            if (band === courses[0]) this.tintScratch.copy(this.colorScratch).multiply(RUSTIC_STONE);
            this.dummy.position.set(cx2, KERB_H + m.y + band.bottom, cz2);
            this.dummy.scale.set(m.w + band.projection * 2, band.height, m.d + band.projection * 2);
            this.dummy.updateMatrix();
            this.cornice.push(this.dummy.matrix, this.tintScratch);
          }
        }
      }

      this.footprints.set(b.id, placed);
      if(prof.ruin){
        if(this.rubbleModels?.ready){
          const kind=b.cls==='municipal'||b.cls==='charity'?'stone':'brick';
          for(const pile of rubblePiles(b.id,prof.width,prof.depth)){const [x,z]=local(pile.x,pile.z);
            rubblePlacements.push({kind,x,z,size:pile.size,yaw:yaw+pile.yaw});}
        }else for(const piece of ruinRubble(b.id,prof.width,prof.depth)){
          const [rx,rz]=local(piece.x,piece.z);
          this.dummy.position.set(rx,KERB_H+piece.y+piece.h/2,rz);
          this.dummy.rotation.set(0,yaw+piece.yaw,0);this.dummy.scale.set(piece.w,piece.h,piece.d);this.dummy.updateMatrix();
          this.tintScratch.setRGB(.48*piece.tint,.40*piece.tint,.32*piece.tint);
          this.rubble.push(this.dummy.matrix,this.tintScratch);
        }
      }
      // Distinct goods and machinery occupy the larger works room. These
      // appear only in lowered view and never reveal a hidden illegal site.
      const fixture = lowered && !prof.ruin && b.cls === 'industrial' ? industrialFixtureFor(b.typeId) : null;
      if (fixture) {
        const pool = fixture === 'machine' ? this.interiorMachines : this.interiorStorage;
        for (const offset of industrialFixtureOffsets(masses[0])) {
          const [fx, fz] = local(offset.x, offset.z);
          this.dummy.position.set(fx, KERB_H + offset.y, fz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(1, 1, 1);
          this.dummy.updateMatrix();
          if (pool.push(this.dummy.matrix) >= 0)
            this.buildingPickBounds.include(pool.mesh.geometry, this.dummy.matrix);
        }
      }

      // --- the storefront band
      if (prof.base !== 'none' && !prof.ruin) {
        const bh = frontCut ? Math.min(prof.baseHeight, 1.25) : prof.baseHeight;
        const m0 = masses[0];
        const front = frontOf(m0, .04);
        const [bx, bz] = local(front.x, front.z);
        this.dummy.position.set(bx, KERB_H, bz);
        this.dummy.rotation.set(0, yaw, 0);
        this.dummy.scale.set(m0.w, bh, 1);
        this.dummy.updateMatrix();
        if (prof.base === 'shop') {
          // Shopfronts are painted joinery, so they take their own colour
          // rather than the brickwork's.
          this.uvScratch.set((m0.w + 0.5) / 6.2, bh / prof.baseHeight, uOff * 0.5, 0);
          // The delivered joinery photograph takes a per-shop paint wash, so
          // neighbouring shops are not one repeated front.
          if (this.deliveredStorefront) this.tintScratch.setRGB(1.12, 1.12, 1.12).lerp(paintScratch.setHex(SHOP_PAINT[rint(b.id, 52, SHOP_PAINT.length)]).multiplyScalar(1.6), .45);
          else this.tintScratch.setHex(SHOP_PAINT[rint(b.id, 52, SHOP_PAINT.length)]);
          if (b.state === 'damaged') this.tintScratch.multiplyScalar(0.5);
          else if (b.state === 'ceased') this.tintScratch.multiplyScalar(0.7);
          if(fireStage)this.tintScratch.setRGB(.15,.14,.13);
          this.shopBase.push(this.dummy.matrix, this.tintScratch, this.uvScratch);
          if (b.fbiClosedWeek != null && b.state !== 'destroyed') this.closedFronts.push(this.dummy.matrix);
        } else if (prof.base === 'plinth') {
          this.uvScratch.set((m0.w + 0.5) / 5.0, bh / 3.2, uOff, 0);
          this.plinthBase.push(this.dummy.matrix, this.colorScratch, this.uvScratch);
        } else if (prof.base === 'entry') {
          // Keep the building's brick/stone facade visible down to the ground.
          // One real doorway replaces the industrial shutter photograph.
          const doorFront = frontOf(m0, .08);
          const [dx, dz] = local(doorFront.x, doorFront.z);
          this.dummy.position.set(dx, KERB_H, dz);
          this.dummy.scale.set(prof.spire ? 1.35 : 1, 1, 1);
          this.dummy.updateMatrix();
          (frontCut ? this.cutawayDoors : this.entryDoors).push(this.dummy.matrix, this.colorScratch);
        }

        // --- the sign over the door (never for an illegal site)
        const tile = prof.sign ? tex.signs.index[b.typeId] : undefined;
        if (tile != null && !frontCut && !fireStage) {
          const col = tile % tex.signs.cols;
          const row = Math.floor(tile / tex.signs.cols);
          const signFront = frontOf(m0, .09);
          const [sx, sz] = local(signFront.x, signFront.z);
          this.dummy.position.set(sx, KERB_H + (prof.base === 'entry' ? 2.90 : bh - .64), sz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(Math.min(6.4, m0.w * .72), .55, 1);
          this.dummy.updateMatrix();
          this.uvScratch.set(
            1 / tex.signs.cols,
            1 / tex.signs.rows,
            col / tex.signs.cols,
            1 - (row + 1) / tex.signs.rows,
          );
          this.signs.push(this.dummy.matrix, undefined, this.uvScratch);
        }

        if (prof.awning && !frontCut && !fireStage) {
          const awningFront = frontOf(m0, .56);
          const [ax, az] = local(awningFront.x, awningFront.z);
          this.dummy.position.set(ax, KERB_H + Math.max(2.3, bh - .92), az);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(Math.min(4.8, m0.w * .48), .75, 1.25);
          this.dummy.updateMatrix();
          const aw = rpickColor(b.id, 51);
          this.awnings.push(this.dummy.matrix, aw);
        }
      }

      // --- ownership banner, so a held site reads from the air
      if (holdId != null && !prof.ruin) {
        const gang = w.gangs[holdId];
        if (gang) {
          const m0 = masses[0];
          const mh = frontCut ? Math.min(m0.h, 1.35) : m0.h;
          const bannerFront = frontOf(m0, .11);
          const [nx, nz] = local(bannerFront.x, bannerFront.z);
          this.tintScratch.setStyle(GANG_COLORS[gang.color].light);
          if (ownerId == null) this.tintScratch.multiplyScalar(0.45);
          this.dummy.position.set(nx, KERB_H + mh - (frontCut ? .42 : b.isHQ ? 1.2 : .9), nz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(Math.min(3.8, m0.w * .55), frontCut ? .18 : b.isHQ ? .50 : .26, 1);
          this.dummy.updateMatrix();
          this.banners.push(this.dummy.matrix, this.tintScratch);
        }
      }

      if ((!lowered || !groundCutaway) && !prof.ruin) {
        const m0 = masses[0];
        if (!lowered && prof.roof !== 'flat') {
          const [rx, rz] = local(m0.dx, m0.dz);
          this.dummy.position.set(rx, KERB_H + m0.h, rz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(m0.w + .28, prof.roofHeight, m0.d + .28);
          this.dummy.updateMatrix();
          this.tintScratch.setRGB(.90 + r01(b.id, 93) * .16, .90 + r01(b.id, 94) * .14, .90 + r01(b.id, 95) * .12);
          if(fireStage)this.tintScratch.setRGB(.19,.18,.17);
          (prof.roof === 'gable' ? this.gableRoofs : this.hipRoofs).push(this.dummy.matrix, this.tintScratch);
          top = Math.max(top, m0.h + prof.roofHeight);
        }
        // --- fire escapes on the tenements
        for (const level of fireEscapeLevels(prof, m0)) {
          const y = KERB_H + level;
          const escapeFront = frontOf(m0, .05);
          const [fx, fz] = local(escapeFront.x, escapeFront.z);
          this.dummy.position.set(fx, y, fz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(Math.min(1, m0.w / 5.2), 1, 1);
          this.dummy.updateMatrix();
          if (this.fireEscapes.push(this.dummy.matrix) >= 0)
            this.buildingPickBounds.include(this.fireEscapes.mesh.geometry, this.dummy.matrix);
        }

        // --- saw-tooth roofs over the works
        for (let k = 0; !lowered && k < prof.sawtooth; k++) {
          const bay = m0.w / prof.sawtooth;
          const [gx2, gz2] = local(m0.dx - m0.w / 2 + (k + 0.5) * bay, m0.dz);
          this.dummy.position.set(gx2, KERB_H + prof.height - 0.1, gz2);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(bay * 0.98, 2.1, m0.d * 0.96);
          this.dummy.updateMatrix();
          this.sawteeth.push(this.dummy.matrix);
        }

        // --- a portico for the banks and the civic buildings
        if (prof.columns > 0) {
          const municipalPortico = b.cls === 'municipal';
          const colH = porticoColumnScale(prof, municipalPortico);
          const porticoTint = this.tintScratch.setHex(CIVIC_STONE).multiply(this.colorScratch);
          const spread = m0.w * 0.82;
          for (let k = 0; k < prof.columns; k++) {
            const fx = -spread / 2 + (spread * k) / (prof.columns - 1);
            const [cx2, cz2] = local(m0.dx + fx, frontOf(m0, .85).z);
            this.dummy.position.set(cx2, KERB_H, cz2);
            this.dummy.rotation.set(0, yaw, 0);
            this.dummy.scale.set(1.0, colH, 1.0);
            this.dummy.updateMatrix();
            if (this.columns.push(this.dummy.matrix, porticoTint) >= 0)
              this.buildingPickBounds.include(this.columns.mesh.geometry, this.dummy.matrix);
          }
          if (prof.pediment) {
            const [cx2, cz2] = local(m0.dx, frontOf(m0, .85).z);
            this.dummy.position.set(cx2, KERB_H + colH, cz2);
            this.dummy.rotation.set(0, yaw, 0);
            this.dummy.scale.set(spread + 2.4, municipalPortico ? 1.15 : 2.9, 2.6);
            this.dummy.updateMatrix();
            if (this.pediments.push(this.dummy.matrix, porticoTint) >= 0)
              this.buildingPickBounds.include(this.pediments.mesh.geometry, this.dummy.matrix);
          }
        }

        if (!lowered && prof.spire) {
          const tower = masses[1];
          const layout = churchBelfryLayout(tower);
          const [sx2, sz2] = local(layout.x, layout.z);
          this.dummy.position.set(sx2, KERB_H + layout.baseY, sz2);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(layout.scaleXZ, layout.scaleY, layout.scaleXZ);
          this.dummy.updateMatrix();
          if (this.spires.push(this.dummy.matrix, this.colorScratch) >= 0)
            this.buildingPickBounds.include(this.spires.mesh.geometry, this.dummy.matrix);
          top = Math.max(top, layout.top);
        }

        if (!lowered && prof.dome) {
          const layout = civicDomeLayout(m0);
          const [dx, dz] = local(layout.x, layout.z);
          this.dummy.position.set(dx, KERB_H + layout.baseY, dz);
          this.dummy.rotation.set(0, yaw, 0);
          this.dummy.scale.set(layout.scaleXZ, layout.scaleY, layout.scaleXZ);
          this.dummy.updateMatrix();
          if (this.domes.push(this.dummy.matrix, this.colorScratch) >= 0)
            this.buildingPickBounds.include(this.domes.mesh.geometry, this.dummy.matrix);
          top = Math.max(top, layout.top);
        }

        if (!lowered && prof.waterTank) {
          const [tx, tz] = local(m0.dx + m0.w * 0.22, m0.dz - m0.d * 0.2);
          this.dummy.position.set(tx, KERB_H + prof.height - 0.3, tz);
          this.dummy.rotation.set(0, yaw + rint(b.id, 55, 4) * 0.4, 0);
          this.dummy.scale.setScalar(0.8);
          this.dummy.updateMatrix();
          this.tanks.push(this.dummy.matrix);
        }

        // Landmark identity: a crane over the Docks' street front; a glazed
        // shed over the Railroad Terminal with a clock above its entrance.
        if (!lowered && b.typeId === 'docks') {
          const [kx, kz] = local(m0.dx - m0.w * .28, m0.dz + m0.d / 2 - 1.3);
          this.dummy.position.set(kx, KERB_H + m0.y + m0.h, kz);
          this.dummy.rotation.set(0, yaw, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
          this.dockCranes.push(this.dummy.matrix);
        }
        if (b.typeId === 'railroad') {
          // Where the elevated line crosses, its station is the landmark: no shed under it.
          if (!lowered && !w.blocks[b.blockId]?.layout?.rail) {
            const [sx, sz] = local(m0.dx, m0.dz);
            this.dummy.position.set(sx, KERB_H + m0.y + m0.h - .05, sz);
            this.dummy.rotation.set(0, yaw, 0);
            this.dummy.scale.set(m0.w * .92, Math.min(6, m0.w * .3), m0.d * .92); this.dummy.updateMatrix();
            this.trainSheds.push(this.dummy.matrix);
          }
          const [cx3, cz3] = local(m0.dx, m0.dz + m0.d / 2 + .06);
          this.dummy.position.set(cx3, KERB_H + Math.min(m0.h - 1.2, groundCutaway ? 99 : m0.h * .78), cz3);
          this.dummy.rotation.set(0, yaw, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
          if (!groundCutaway) this.stationClocks.push(this.dummy.matrix);
        }

        // --- chimneys and a stair head, on the roof of the topmost mass
        if (!lowered) {
          const topMass = masses[masses.length - 1];
          const roofY = KERB_H + topMass.y + topMass.h - .25 + (prof.roof === 'flat' ? 0 : prof.roofHeight * .70);
          const nChim = prof.spire ? 0 : prof.sawtooth || prof.roof !== 'flat' ? 1 : rint(b.id, 56, 3);
          for (let k = 0; k < nChim; k++) {
            const [chx, chz] = local(
              topMass.dx + (prof.roof === 'flat' ? (r01(b.id, 60 + k) - .5) * topMass.w * .72 : topMass.w * .15),
              topMass.dz + (prof.roof === 'flat' ? (r01(b.id, 66 + k) - .5) * topMass.d * .72 : topMass.d * .12),
            );
            this.dummy.position.set(chx, roofY, chz);
            this.dummy.rotation.set(0, yaw, 0);
            this.dummy.scale.set(.62, .38 + r01(b.id, 72 + k) * .26, .62);
            this.dummy.updateMatrix();
            this.chimneys.push(this.dummy.matrix);
          }
          if (prof.roof === 'flat' && !prof.sawtooth && prof.height > STOREY_H * 2.5 && r01(b.id, 58) < 0.55) {
            const [bx, bz] = local(topMass.dx - topMass.w * 0.2, topMass.dz + topMass.d * 0.18);
            this.dummy.position.set(bx, roofY, bz);
            this.dummy.rotation.set(0, yaw, 0);
            this.dummy.scale.setScalar(1);
            this.dummy.updateMatrix();
            this.bulkheads.push(this.dummy.matrix);
          }
        }
      }

      // Keep the padded body and inward clearance, and include the actual
      // ornament silhouette instead of guessing its extents from the wall size.
      const pw = Math.max(prof.width, prof.spire ? 4.5 : 0) + 1.2;
      const ph = lowered ? Math.max(top, 1.35) : Math.max(top, prof.height);
      // The sightline proxy always stands to the top-storey cut, so a building
      // opened at the pavement is still found by the sightline that opened it
      // (otherwise it would close again and rebuild the city every frame).
      const sightTop = lowered ? Math.max(ph, ...sectionMasses(intactMasses, true, false).map(m => m.y + m.h)) : ph;
      this.buildingPickBounds.includeBody(pw, prof.depth + 1.2, ext, ph + KERB_H);
      this.buildingPickBounds.writeTransform(this.dummy);
      this.picks.push(this.dummy.matrix);
      if (this.sightProxies) {
        if (sightTop > ph) {
          this.buildingPickBounds.includeBody(pw, prof.depth + 1.2, ext, sightTop + KERB_H);
          this.buildingPickBounds.writeTransform(this.dummy);
        }
        this.sightProxies.push(this.dummy.matrix);
      }
      this.buildingIds.push(b.id);
      if (targetStarts && targetColor) targetPools.forEach((p, i) => p.tintFrom(targetStarts[i], targetColor, .78));
      if (outlineStarts) outline!.setInstances(outlinePools.map((p, i) => ({
        mesh: p.mesh, start: outlineStarts[i], count: p.count - outlineStarts[i],
      })));
    }

    if (outline && !outline.partCount && this.selectedBuildingId != null) {
      const selected = w.buildings[this.selectedBuildingId], lot = selected && w.lots[selected.lotId];
      if (lot) outline.setLot(lot.center.x, lot.center.y, LOT_SIZE * .86, KERB_H);
    }

    for (const p of [...this.wallPools, ...this.cutawayWalls]) p.commit();
    for (const p of this.decor) p.commit();
    if (!this.makingBuildingView) this.furnishNear(true);
    this.rubbleModels?.setPlacements(rubblePlacements);
    // InstancedMesh caches these on its first raycast. Roof-mode and world
    // changes rebuild matrices, so picking must recompute the aggregate.
    this.picks.mesh.boundingSphere = null;
    this.picks.mesh.boundingBox = null;
    if (this.sightProxies) { this.sightProxies.mesh.boundingSphere = null; this.sightProxies.mesh.boundingBox = null; }
    this.buildingsDirty = false;
  }

  // ------------------------------------------------------------ street furniture

  private refreshStreet(): void {
    const w = this.world;
    this.landscape?.dispose();
    this.landscape = new CityLandscape(w, this.treeModels?.ready); this.scene.add(this.landscape.group);
    const treePlacements: TreePlacement[] = [...this.landscape.trees];
    (this.ground.material as RoadSurfaceMaterial).legacyRails.value = w.cityLayout ? 0 : 1;
    (this.ground.material as RoadSurfaceMaterial).setLineNames(w.gridW + 1, w.gridH + 1, (axis, line) => streetNameIndex(w, axis, line));
    (this.ground.material as RoadSurfaceMaterial).setRoadBlocks(w.gridW, w.gridH, i => {
      const b = w.blocks[i], c = b?.original?.content;
      if (b?.layout?.use !== 'avenue' || avenueRoadway(b)) return { road: false };
      return { road: true, line: c === 34 || c === 41 ? 'x' : c === 35 || c === 37 ? 'y' : undefined };
    });
    this.pavement.reset();
    this.lamps.reset();
    this.lampGlow.reset();
    this.hydrants.reset();
    this.trees.reset();

    const pave = paveWidth(w);
    for (const blk of activeBlocks(w)) {
      // Original 40 x 32 city: avenues are road from kerb to kerb, and the
      // river is open water. Neither gets a pavement island or street furniture.
      if (blk.layout?.use === 'water' || avenueRoadway(blk)) {
        // River banks: raised pavement between the kerb and the water.
        for (const bank of riverBank(w, blk).banks) {
          this.dummy.position.set(bank.x + bank.w / 2, 0, bank.y + bank.h / 2);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.set(bank.w / (2 * SLAB_HALF), 1, bank.h / (2 * SLAB_HALF));
          this.dummy.updateMatrix();
          this.colorScratch.setRGB(.92, .91, .88);
          this.pavement.push(this.dummy.matrix, this.colorScratch);
        }
        this.dummy.scale.set(1, 1, 1);
        continue;
      }
      if (avenueRoadway(blk)) continue;
      const rect = blockRect(blk), cx = blk.center.x, cz = blk.center.y;

      this.dummy.position.set(cx, 0, cz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set((rect.w + 2 * pave) / (2 * SLAB_HALF), 1, (rect.h + 2 * pave) / (2 * SLAB_HALF));
      this.dummy.updateMatrix();
      // The pavement carries the overlay wash as well as the plan does.
      const shade = 0.88 + r01(blk.id, 5) * 0.2;
      this.colorScratch.setRGB(shade, shade * 0.99, shade * 0.96);
      this.pavement.push(this.dummy.matrix, this.colorScratch);

      // A lamp standard on each corner of the block.
      this.dummy.scale.set(1, 1, 1);
      const corner = rect.w / 2 + pave - 1.5, cornerZ = rect.h / 2 + pave - 1.5;
      for (let k = 0; k < 4; k++) {
        const dx = k & 1 ? corner : -corner;
        const dz = k & 2 ? cornerZ : -cornerZ;
        this.dummy.position.set(cx + dx, KERB_H, cz + dz);
        this.dummy.rotation.set(0, (k * Math.PI) / 2, 0);
        this.dummy.updateMatrix();
        this.lamps.push(this.dummy.matrix);
        this.lampGlow.push(this.dummy.matrix);
      }

      // A hydrant, and trees on the leafier blocks.
      const side = rint(blk.id, 21, 4);
      const along = (r01(blk.id, 22) - 0.5) * BLOCK_SIZE * 0.6;
      const hx = side < 2 ? cx + along : cx + (side === 2 ? corner : -corner);
      const hz = side < 2 ? cz + (side === 0 ? cornerZ : -cornerZ) : cz + along;
      this.dummy.position.set(hx, KERB_H, hz);
      this.dummy.rotation.set(0, r01(blk.id, 23) * Math.PI, 0);
      this.dummy.updateMatrix();
      this.hydrants.push(this.dummy.matrix);

      if (blk.district === 'residential' || blk.district === 'civic' || r01(blk.id, 24) < 0.22) {
        const n = 1 + rint(blk.id, 25, 3);
        for (let k = 0; k < n; k++) {
          const s2 = rint(blk.id, 26 + k, 4);
          const a2 = (r01(blk.id, 30 + k) - 0.5) * BLOCK_SIZE * 0.7;
          const tx = s2 < 2 ? cx + a2 : cx + (s2 === 2 ? corner - 0.4 : -corner + 0.4);
          const tz = s2 < 2 ? cz + (s2 === 0 ? cornerZ - 0.4 : -cornerZ + 0.4) : cz + a2;
          this.dummy.position.set(tx, KERB_H, tz);
          this.dummy.rotation.set(0, r01(blk.id, 40 + k) * Math.PI * 2, 0);
          const ts = 0.8 + r01(blk.id, 50 + k) * 0.45;
          this.dummy.scale.setScalar(ts);
          this.dummy.updateMatrix();
          treePlacements.push({ kind: 'linden', x: tx, y: KERB_H, z: tz,
            height: 5.3 * ts, angle: this.dummy.rotation.y });
          if (!this.treeModels?.ready) this.trees.push(this.dummy.matrix);
        }
      }
      this.dummy.scale.set(1, 1, 1);
    }

    this.pavement.commit();
    this.lamps.commit();
    this.lampGlow.commit();
    this.hydrants.commit();
    this.streetFurniture = [this.lamps, this.lampGlow, this.hydrants].map(pool => snapshotPlacements(pool));
    this.furnitureAt.set(Infinity, 0, Infinity);
    this.cullStreetFurniture();
    this.trees.commit();
    this.treeModels?.setPlacements(treePlacements);
  }

  // ------------------------------------------------------------ agents

  /**
   * The people who could be in reach of (cx, cz), in id order. Positions move
   * a few metres a game minute, so the grid is rebuilt once a minute (and
   * whenever people are added) and the caller's exact reach test, with its
   * margin, does the rest. Each area is a square of half-width r; the watched
   * people of Tagged windows are always included.
   */
  private peopleNear(areas: readonly { x: number; z: number; r: number }[], watched: ReadonlySet<ID>): Person[] {
    const w = this.world;
    const CELL = BLOCK_SIZE;
    const key = `${w.week}:${w.minute}:${w.nextId}`;
    if (this.peopleGrid?.key !== key) {
      const cells = new Map<number, Person[]>();
      for (const p of peopleList(w)) {
        const c = Math.floor(p.pos.x / CELL) * 4096 + Math.floor(p.pos.y / CELL);
        const list = cells.get(c);
        if (list) list.push(p); else cells.set(c, [p]);
      }
      this.peopleGrid = { key, cells };
    }
    // One cell of slack: someone may have crossed a cell edge since the rebuild.
    const seen = new Set<number>(), out: Person[] = [];
    for (const a of areas) {
      const x0 = Math.floor((a.x - a.r) / CELL) - 1, x1 = Math.floor((a.x + a.r) / CELL) + 1;
      const z0 = Math.floor((a.z - a.r) / CELL) - 1, z1 = Math.floor((a.z + a.r) / CELL) + 1;
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const key = gx * 4096 + gz;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = this.peopleGrid.cells.get(key);
        if (list) for (const p of list) out.push(p);
      }
    }
    for (const id of watched) { const p = w.people[id]; if (p && !out.includes(p)) out.push(p); }
    return out.sort((a, b) => a.id - b.id);
  }

  private refreshAgents(): void {
    const w = this.world;
    this.agentIds = [];
    this.burningPeople?.reset();
    this.emergencyHoses?.reset();
    this.actors.reset();
    this.sculptModels?.resetCharacters();
    this.drivers.length = 0;
    this.standingCars.length = 0;
    let i = 0;
    let haloShown = false;
    // Anything the frame cannot reach is skipped rather than drawn; the
    // picking list is built from what is drawn, so it stays consistent.
    const reach = this.groundReach() + BLOCK_SIZE;
    const cx = this.target.x;
    const cz = this.target.z;
    this.footRings.reset();
    this.waitMarks.reset();
    this.arrestMarks.reset();
    // Who is looking: their own people are marked, and rivals they have not
    // identified dress like citizens, as the original had it.
    const viewer = this.overlayGang != null ? w.gangs[this.overlayGang] : null;
    const known = new Set<ID>(viewer?.knownPeople ?? []);
    const viewerHex = viewer ? Number(GANG_COLORS[viewer.color].light.replace('#', '0x')) : 0xffffff;

    const watchedIds = this.tagged.watchedIds();
    const burning=(p:Person)=>p.burningEscape?.week===w.week?p.burningEscape:undefined;
    // The reach test first: it is what every later pass applies anyway, and
    // the visibility rules below cost more than it does across 8,000 people.
    // The main view's reach, and each open Tagged window's own patch of street.
    const areas = [{ x: cx, z: cz, r: reach + 20 }];
    for (const view of this.tagged.views.values()) if (view.visible) areas.push({ x: view.target.x, z: view.target.z, r: 80 + 20 });
    const near = (p: Person) => watchedIds.has(p.id) ||
      areas.some(a => Math.max(Math.abs(p.pos.x - a.x), Math.abs(p.pos.y - a.z)) <= a.r);
    // A lawyer or accountant at a meeting stands in the street with no route.
    const meeting = specialistParticipants(w);
    const people = this.peopleNear(areas, watchedIds).filter(p => near(p) && (burning(p)?
      escapeSample(burning(p)!,w.minute+this.subMinute).time>=0:
      !bossInsideOffice(p) && !workingInside(w, p) && (streetPersonVisible(p, watchedIds.has(p.id) ? p.id : this.selectedPersonId) || meeting.has(p.id) ||
      (this.actionsEnabled && this.characterActions.has(p.id) || this.characterActions.hasDeath(p.id)) && !p.inVehicle && p.status!=='jailed' && p.status!=='kidnapped')));
    if (watchedIds.size) people.sort((a,b) => Number(watchedIds.has(b.id)) - Number(watchedIds.has(a.id)));
    const hdIds = new Set<number>(), visibleIds = new Set<number>();
    this.camera.updateMatrixWorld(true);
    const bodyPixels = characterPixelHeight(this.camera, this.height);
    this.characterDetailStats = { bodyPixels, inView: 0, eligible: 0, detailed: 0, simplified: 0 };
    if (this.sculptModelsActive) {
      const lastDetailed = this.lastDetailedIds;
      const detailDistance = (p: Person) => Math.hypot(p.pos.x - cx, p.pos.y - cz) - (lastDetailed.has(p.id) ? DETAIL_KEEP_METRES : 0);
      const candidates = people.filter(p => {
        if(p.inVehicle && !loadingShuttle(w, p, this.simClock)) return false;
        // A cheap reach test first: exact preview positions for all 8,000+
        // people each frame were a measurable share of Street View's time.
        // Open Tagged windows add their own patches of street to the reach.
        if(!near(p)) return false;
        const pos=previewStreetPosition(p,w,this.subMinute,this.taggedPreview);
        const inTaggedView = this.tagged.contains(pos.x,pos.y);
        this.projScratch.set(pos.x,streetSurfaceHeight(this.world, pos.x,pos.y)+1,pos.y).project(this.camera);
        const inMainView = characterInView(this.projScratch);
        if (inMainView) visibleIds.add(p.id);
        return inTaggedView || inMainView && characterNeedsDetail(bodyPixels, p.id === this.selectedPersonId || watchedIds.has(p.id));
      });
      candidates.sort((a,b)=>Number(!!burning(b))-Number(!!burning(a)) || Number(watchedIds.has(b.id))-Number(watchedIds.has(a.id)) || Number(this.characterActions.get(b.id)?.kind==='throw')-Number(this.characterActions.get(a.id)?.kind==='throw') || (this.actionsEnabled?Number(this.characterActions.has(b.id))-Number(this.characterActions.has(a.id)):0) || characterPriority(a,this.selectedPersonId,null,viewer?.id??null)-
        characterPriority(b,this.selectedPersonId,null,viewer?.id??null) ||
        detailDistance(a)-detailDistance(b) || a.id-b.id);
      candidates.slice(0,MAX_DETAILED_STREET_CHARACTERS).forEach(p=>hdIds.add(p.id));
      this.lastDetailedIds = hdIds;
      this.characterDetailStats.inView = visibleIds.size;
      this.characterDetailStats.eligible = candidates.length;
    }
    // Delivery drivers carrying cases in at a shop: in view and detailed only.
    const deliveryDrivers = Object.values(w.goodsDeliveries ?? {}).flatMap(d => {
      const driver = deliveryDriver(w, d, this.simClock);
      if (!driver || Math.abs(driver.pos.x - cx) > reach || Math.abs(driver.pos.y - cz) > reach) return [];
      if (this.sculptModelsActive) hdIds.add(driver.id);
      return [driver];
    });
    this.sculptModels?.retainCharacters(hdIds);
    for (const p of people) {
      if (i >= MAX_AGENTS) break;
      // Cheap reach test before the exact previews below (they skip the same
      // people further down), including each open Tagged window's patch.
      if (!near(p)) continue;
      // Part way to where the next tick will put them, so a slow clock does
      // not turn walking into hopping.
      const preview = previewActorMotion(p, this.subMinute, this.actorPreview,w);
      if(p.emergencyResponse&&w.minute+this.subMinute<p.emergencyResponse.startMinute){
        preview.x=p.pos.x;preview.y=p.pos.y;preview.moving=false;
      }
      const escape=burning(p),burn=escape&&escapeSample(escape,w.minute+this.subMinute);
      const shock=p.shockReaction?.week===w.week?p.shockReaction:undefined;
      const shockTime=shock?(w.minute+this.subMinute-shock.startMinute)/MINUTES_PER_SECOND:-1;
      // Crew seated during an Export/Raid are shown carrying crates instead.
      const shuttle = loadingShuttle(w, p, this.simClock);
      if (shuttle) this.shuttleSeen.set(p.id, { ...shuttle.pos });
      else if (p.status !== 'dead') this.shuttleSeen.delete(p.id);
      const fell = !shuttle && p.status === 'dead' ? this.shuttleSeen.get(p.id) : undefined;
      const pos = shuttle?.pos ?? (fell ? { ...fell } : previewStreetPosition(p,w,this.subMinute,this.taggedPreview));
      // A car that has stopped where it was going pulls in to the kerb.
      if (p.inVehicle && !shuttle) {
        const driver = vehicleDriver(w, p);
        // Eased once a frame, by the driver; his passengers sit where the car is.
        this.pullIn(p.vehicleKey ?? `p${p.id}`, pos, !driver.dest, driver === p);
      }
      const inTaggedView = this.tagged.contains(pos.x, pos.y);
      if (!inTaggedView && (Math.abs(pos.x - cx) > reach || Math.abs(pos.y - cz) > reach)) continue;

      // Use the visible route tangent, not the previous committed waypoint.
      const driving = p.inVehicle && !shuttle;
      const vehicle = vehicleForPerson(w, p);
      const walking = shuttle ? shuttle.walking : burn?burn.fleeing:shock?false:preview.moving && !p.inVehicle;
      const cue=this.characterActions.presentation(p.id);
      const response=p.emergencyResponse;
      const action:import('./characterActions').CharacterAction|undefined=burn?
        (burn.fleeing?{kind:'fleeBurning',time:burn.time}:escape!.fatal?{kind:'burnDeath',time:burn.deathTime}:undefined):
        shock&&shockTime>=0?{kind:'shock',time:shockTime}:
        response?.stage==='working'&&response.kind==='fire'?{kind:'firefight',time:(w.minute+this.subMinute-(response.arrivedMinute??w.minute))/MINUTES_PER_SECOND}:
        response?.stage==='working'&&response.kind==='reporter'?{kind:'photo',time:((w.minute+this.subMinute-(response.arrivedMinute??w.minute))/MINUTES_PER_SECOND)%4}:
        liveCharacterAction(cue,this.actionsEnabled);
      let facing = shuttle ? shuttle.facing : preview.moving ? preview.facing : driving ? roadHeading(w, pos) : r01(p.id, 3) * Math.PI * 2;
      // A burning man running from the door is moving, though he has no route.
      const motion = this.actorMotion.sample(p.id, pos.x, pos.y, shuttle ? shuttle.walking : burn ? burn.fleeing : preview.moving, facing);
      if (!shuttle && (!driving || preview.moving || p.dest)) facing = motion.facing;
      if(burn)facing=burn.facing;
      else if(shock){
        const victim=w.people[shock.victimId],at=victim?.burningEscape?escapeSample(victim.burningEscape,w.minute+this.subMinute).pos:victim?.pos;
        if(at)facing=Math.atan2(at.x-pos.x,at.y-pos.y);
      }
      else if(response?.stage==='working')facing=Math.atan2(response.lookAt.x-pos.x,response.lookAt.y-pos.y);
      // A man turns to his target; a car does not (it swung sideways on every hit).
      if(action?.target&&!driving)facing=Math.atan2(action.target.x-pos.x,action.target.y-pos.y);
      const surface = driving ? VEHICLE_GROUND_CLEARANCE : streetSurfaceHeight(this.world, pos.x, pos.y) + .008;
      this.dummy.position.set(pos.x, surface, pos.y);
      this.dummy.rotation.set(0, facing, 0);
      if (driving) {
        const profile = this.vehicleProfile(vehicle);
        this.dummy.scale.set(profile.width / .68, profile.height / 1.97, profile.length / .66);
      } else this.dummy.scale.setScalar(CHARACTER_SCALE);
      this.dummy.updateMatrix();
      this.agentMesh.setMatrixAt(i, this.dummy.matrix);
      if (p.id === this.selectedPersonId) {
        this.selectionRing.visible = false; // Replace the pre-load location marker once the person is drawn.
        // The car highlight lies on the road; its far arc must not paint over the driver.
        (this.personHalo.material as THREE.MeshBasicMaterial).depthTest = driving;
        this.personHalo.position.set(pos.x, surface + .025, pos.y);
        this.personHalo.rotation.set(0, facing, 0);
        this.personHalo.scale.set(driving ? 1.7 : CHARACTER_SCALE, 1, driving ? 3.6 : CHARACTER_SCALE);
        haloShown = true;
      }

      // Citizens in overcoats: mid-tones with a hue, so a figure separates
      // from the pavement by colour rather than brightness.
      let hex = COAT_COLORS[rint(p.id, 86, COAT_COLORS.length)];
      const own = viewer != null && p.gangId === viewer.id;
      if (p.role === 'police') hex = 0x263e59;
      else if (p.role === 'fbi') hex = 0x24242c;
      else if (p.gangId != null) {
        // Your own people and the rivals you have identified wear their colours;
        // the rest pass for citizens.
        const gang = w.gangs[p.gangId];
        if (gang && (own || viewer == null || known.has(p.id))) hex = Number(GANG_COLORS[gang.color].light.replace('#', '0x'));
      } else if (p.role === 'hood' || p.role === 'lieutenant') hex = 0xf2f2f2;
      else if (p.role === 'snitch') hex = 0xcfa93f;

      this.colorScratch.setHex(hex);
      if (p.status === 'beaten') this.colorScratch.multiplyScalar(0.6);
      if(burn&&escape!.fatal)this.colorScratch.multiplyScalar(.15);
      // Closed cabins conceal their occupants. Picking uses the vehicle-sized
      // envelope above, so no standing miniature protrudes through its roof.
      if (!driving) {
        const detailed = hdIds.has(p.id) && this.sculptModels?.pushCharacter(p.id, actorStyleFor(p),
          this.dummy.matrix, motion.phase, walking,
          {role:p.role,coat:hex,firefighting:action?.kind==='firefight',charred:burn&&escape!.fatal?Math.min(1,.25+burn.time/(BURNING_TIMING.flee+2)):0,weapon:burn||response||action?.kind==='strike'||action?.kind==='throw'?undefined:this.characterActions.heldWeapon(p.id),
            carriedProp:shuttle?.carrying?'crate':!burn&&action?.kind!=='throw'&&carriesExplosives(w,p)?'explosives':undefined,throwable:action?.kind==='throw'?action.throwable:undefined},
          {clock:this.simClock,delta:this.actionDelta,action,previewActions:this.actionsEnabled||action?.kind==='shoot',posture:p.closeCombat?.posture,...(shuttle ? (shuttle.carrying ? {gait:'carry' as const} : {}) : dailyMotion(w,p))});
        if (!detailed)
          this.actors.push(p, this.dummy.matrix, this.colorScratch, motion.phase, walking ? 1 : 0,action);
        if(burn&&escape!.fatal)this.burningPeople?.push(pos.x,surface,pos.y,burn.time,burn.deathTime,
          detailed?this.sculptModels?.burningAnchors(p.id):undefined,p.id,
          burn.fleeing?{x:Math.sin(burn.facing),z:Math.cos(burn.facing)}:undefined);
        if(action?.kind==='firefight'&&response){const nozzle=this.sculptModels?.fireNozzle(p.id);
          if(nozzle)this.emergencyHoses?.push(nozzle,response.lookAt,surface,action.time);}
        if (visibleIds.has(p.id)) this.characterDetailStats[detailed ? 'detailed' : 'simplified']++;
      }
      else if (vehicle === 'speedster' && !this.sculptModelsActive) {
        this.dummy.position.set(pos.x - Math.sin(facing) * .72, surface - .10, pos.y - Math.cos(facing) * .72);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.actors.push(p, this.dummy.matrix, this.colorScratch, 0, -1);
      }
      this.agentIds.push(p.id);

      if (own) {
        this.dummy.position.set(pos.x, surface + .022, pos.y);
        this.dummy.rotation.set(0, facing, 0);
        this.dummy.scale.set(driving ? 1.9 : 1, 1, driving ? 4 : 1);
        this.dummy.updateMatrix();
        this.tintScratch.setHex(viewerHex);
        this.footRings.push(this.dummy.matrix, this.tintScratch);
      }
      const waiting = p.orderId != null && w.orders[p.orderId]?.state === 'waiting';
      if (waiting || p.status === 'arrested') {
        // A card held up over the figure, square to the camera.
        this.dummy.position.set(pos.x, surface + (driving ? this.vehicleProfile(vehicle).height + .9 : 2.75), pos.y);
        this.dummy.quaternion.copy(this.camera.quaternion);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        (p.status === 'arrested' ? this.arrestMarks : this.waitMarks).push(this.dummy.matrix);
      }
      if (driving && (!p.vehicleKey || w.vehicleFleet?.[p.vehicleKey]?.driverId===p.id)) this.drivers.push({ x: pos.x, z: pos.y, facing, hex, kind: vehicle, moving: !(this.pulledIn.get(p.vehicleKey ?? `p${p.id}`) ?? 0) });
      // The driver is out loading: his truck stays parked where it is.
      else if (shuttle && p.vehicleKey && w.vehicleFleet?.[p.vehicleKey]?.driverId===p.id) {
        const car = w.vehicleFleet[p.vehicleKey];
        const at = previewVehicle(car, car.pos, this.subMinute, { x: 0, y: 0 });
        this.pullIn(p.vehicleKey, at, true);
        this.drivers.push({ x: at.x, z: at.y, facing: roadHeading(w, car.pos), hex, kind: car.kind });
      }
      i++;
    }

    for(const [key,car] of Object.entries(w.vehicleFleet??{}))if(!car.occupantIds.length||car.boarding){
      const at=previewVehicle(car,car.pos,this.subMinute,{x:0,y:0});
      this.pullIn(key,at,true);
      this.drivers.push({x:at.x,z:at.y,facing:roadHeading(w,car.pos),hex:0x252525,kind:car.kind});
    }
    for (const driver of deliveryDrivers) {
      const motion = this.actorMotion.sample(driver.id, driver.pos.x, driver.pos.y, driver.walking, driver.facing);
      this.dummy.position.set(driver.pos.x, streetSurfaceHeight(this.world, driver.pos.x, driver.pos.y) + .008, driver.pos.y);
      this.dummy.rotation.set(0, driver.facing, 0); this.dummy.scale.setScalar(CHARACTER_SCALE); this.dummy.updateMatrix();
      this.sculptModels?.pushCharacter(driver.id, 'worker', this.dummy.matrix, motion.phase, driver.walking,
        { role: 'citizen', coat: 0x4e5647, carriedProp: driver.carrying ? 'crate' : undefined },
        { clock: this.simClock, delta: this.actionDelta, gait: driver.carrying ? 'carry' : undefined });
    }
    for(const delivery of Object.values(w.goodsDeliveries??{})){
      const pos=previewGoodsDelivery(delivery,this.subMinute);
      const ahead=previewGoodsDelivery(delivery,this.subMinute+.0001),dx=ahead.x-pos.x,dy=ahead.y-pos.y;
      // Unloading, or waiting for somewhere to go: in to the kerb.
      this.pullIn(`delivery:${delivery.sourceId}`,pos,!delivery.path.length);
      this.drivers.push({x:pos.x,z:pos.y,facing:dx*dx+dy*dy>1e-10?Math.atan2(dx,dy):delivery.heading,hex:0x4e5647,kind:'truck'});
    }
    this.burningPeople?.commit();
    this.emergencyHoses?.commit();
    this.agentMesh.count = i;
    this.actors.commit();
    this.sculptModels?.commitCharacters();
    this.actorMotion.retain(new Set(this.agentIds));
    this.personHalo.visible = haloShown;
    this.footRings.commit();
    this.waitMarks.commit();
    this.arrestMarks.commit();
    this.agentMesh.instanceMatrix.needsUpdate = true;
    // InstancedMesh caches its pick bound; movement and culling change it every frame.
    this.agentMesh.boundingSphere = null;
  }

  // ------------------------------------------------------------ traffic

  /**
   * The traffic, drawn from the simulation's timetable (sim/traffic.ts) so the
   * cars are where the pedestrians think they are; the fraction of the minute
   * that has passed glides them between ticks.
   */
  private vehicleProfile(kind: VehicleId) {
    return (this.sculptModelsActive ? SCULPT_VEHICLE_PROFILE : VEHICLE_PROFILE)[kind];
  }

  /** Ease a car between its lane and the kerb (about a second to pull in or
   *  out), moving `pos` to where it is drawn. Only one call a frame for a car
   *  moves it on (`advance`); the rest read where it is. */
  private pullIn(key: string, pos: { x: number; y: number }, standing: boolean, advance = true): void {
    const was = this.pulledIn.get(key) ?? (standing ? 1 : 0);
    const step = advance ? this.actionDelta * 1.2 : 0;
    const now = standing ? Math.min(1, was + step) : Math.max(0, was - step);
    // Kept at 0 while it drives, so a stop eases in from the lane (deleting it
    // made the next stop start at the kerb, a jump sideways).
    if (now <= 0) { this.pulledIn.set(key, 0); return; }
    this.pulledIn.set(key, now);
    const k = now * now * (3 - 2 * now), kerb = kerbside(this.world, pos, this.kerbScratch);
    pos.x += (kerb.x - pos.x) * k;
    pos.y += (kerb.y - pos.y) * k;
    if (advance && now > .5) this.standingCars.push({ x: pos.x, y: pos.y });
  }

  /** How far a passing car edges out toward the crown of the road round a car
   *  standing at the kerb in its lane (there is no room to pass it cleanly). */
  private edgeOut(c: { axisX: boolean; line: number; x: number; y: number }): number {
    const centre = c.line * CELL, side = Math.sign((c.axisX ? c.y : c.x) - centre);
    let out = 0;
    for (const s of this.standingCars) {
      const across = (c.axisX ? s.y : s.x) - centre, along = Math.abs(c.axisX ? s.x - c.x : s.y - c.y);
      if (Math.sign(across) !== side || Math.abs(across) > 4.2 || along > 8) continue;
      out = Math.max(out, 1.15 * Math.min(1, (8 - along) / 3.5));
    }
    return out * side;
  }

  /** Where a man is shown, when that is not where the simulation has him:
   *  carrying crates between truck and door (the simulation keeps him seated),
   *  or fallen while carrying them. Shots at him are aimed there. */
  private shownAt(id: number): { x: number; y: number } | undefined {
    const p = this.world.people[id];
    if (!p) return undefined;
    const shuttle = loadingShuttle(this.world, p, this.simClock);
    return shuttle ? shuttle.pos : p.status === 'dead' ? this.shuttleSeen.get(id) : undefined;
  }

  private refreshTraffic(dusk: number, camera = this.camera): void {
    const w = this.world;

    this.sedans.reset();
    this.trucks.reset();
    this.speedsters.reset();
    this.sculptModels?.resetVehicles();
    this.headlamps.reset();
    this.vehicleSprites?.reset(camera);
    const spriteMode = this.vehicleSpritesActive;

    // Every car in the city was drawn as a full model each frame (about 1.6M
    // triangles, twice with shadows); only those the frame can reach are now.
    const carReach = this.groundReach() + BLOCK_SIZE, carCx = this.target.x, carCz = this.target.z;
    const mainView = camera === this.camera;
    for (const c of carsAt(w, w.minute + this.subMinute)) {
      const out = this.standingCars.length ? this.edgeOut(c) : 0;
      const x = c.axisX ? c.x : c.x - out;
      const z = c.axisX ? c.y - out : c.y;
      if (mainView && (Math.abs(x - carCx) > carReach || Math.abs(z - carCz) > carReach) && !this.tagged.contains(x, z)) continue;
      const truck = c.truck;
      // The car's nose is its local +x; a yaw of 0 drives east.
      const yaw = c.axisX ? (c.dir > 0 ? 0 : Math.PI) : c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;

      this.dummy.position.set(x, VEHICLE_GROUND_CLEARANCE, z);
      this.dummy.rotation.set(0, yaw, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.colorScratch.setHex(CAR_COLORS[c.color % CAR_COLORS.length]);
      if (spriteMode) this.vehicleSprites!.push(truck ? 'truck' : 'coupe', x, z, yaw);
      else if (this.sculptModelsActive && this.sculptModels?.pushVehicle(truck ? 'truck' : 'coupe', this.dummy.matrix)) { /* Detailed vehicle */ }
      else (truck ? this.trucks : this.sedans).push(this.dummy.matrix, this.colorScratch);

      if (dusk > 0.02) {
        const { nose, lampY } = this.vehicleProfile(truck ? 'truck' : 'coupe');
        this.dummy.position.set(x + Math.cos(yaw) * nose, lampY + VEHICLE_GROUND_CLEARANCE, z - Math.sin(yaw) * nose);
        this.dummy.updateMatrix();
        this.headlamps.push(this.dummy.matrix);
      }
    }

    // The sim's own drivers, in their gang's colours, on top of the traffic.
    for (const d of this.drivers) {
      // A moving gang car edges out round a car at the kerb, as the traffic does.
      if (d.moving && this.standingCars.length) {
        const axisX = Math.abs(Math.sin(d.facing)) >= Math.abs(Math.cos(d.facing));
        const out = this.edgeOut({ axisX, line: Math.round((axisX ? d.z : d.x) / CELL), x: d.x, y: d.z });
        if (axisX) d.z -= out; else d.x -= out;
      }
      this.dummy.position.set(d.x, VEHICLE_GROUND_CLEARANCE, d.z);
      // The figure faces its local +z, the car its local +x.
      this.dummy.rotation.set(0, d.facing - Math.PI / 2, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.colorScratch.setHex(d.hex);
      if (spriteMode && (d.kind !== 'speedster' || this.reviewSpeedsterSprite))
        this.vehicleSprites!.push(d.kind, d.x, d.z, d.facing - Math.PI / 2);
      else if (this.sculptModelsActive && this.sculptModels?.pushVehicle(d.kind, this.dummy.matrix)) { /* Detailed vehicle */ }
      else (d.kind === 'truck' ? this.trucks : d.kind === 'speedster' ? this.speedsters : this.sedans).push(this.dummy.matrix, this.colorScratch);
      if (dusk > .02) {
        const { nose, lampY } = this.vehicleProfile(d.kind);
        const yaw = d.facing - Math.PI / 2;
        this.dummy.position.set(d.x + Math.cos(yaw) * nose, lampY + VEHICLE_GROUND_CLEARANCE, d.z - Math.sin(yaw) * nose);
        this.dummy.updateMatrix();
        this.headlamps.push(this.dummy.matrix);
      }
    }

    this.sedans.commit();
    this.trucks.commit();
    this.speedsters.commit();
    this.sculptModels?.commitVehicles();
    this.vehicleSprites?.commit();
    this.headlamps.commit();
    this.headlamps.mesh.visible = dusk > 0.02;
  }

  // ------------------------------------------------------------ public api

  setWorld(world: WorldState): void {
    if (world !== this.world) this.actorMotion.clear();
    this.world = world;
    this.clearGroundBase();
    this.groundDirty = true; this.groundUrgent = true;
    this.buildingsDirty = true; this.buildingsUrgent = true;
    this.peopleGrid = null;
    this.groundSig = null;
    this.buildingSig = -1;
    this.refreshStreet();
  }

  setOverlays(overlays: OverlayKind[], gangId: ID | null, teamBlocks: ID[] = []): void {
    // Called every frame: only a real change repaints (the ground signature
    // walks every block's known owners — a Street View cost at 40×32).
    const changed = overlays.join() !== this.overlays.join() || gangId !== this.overlayGang ||
      teamBlocks.join() !== this.overlayTeamBlocks.join();
    this.overlays = overlays;
    if (this.overlayGang !== gangId) { this.buildingsDirty = true; this.buildingsUrgent = true; }
    this.overlayGang = gangId;
    this.overlayTeamBlocks = teamBlocks;
    if (changed) { this.groundDirty = true; this.groundUrgent = true; }
  }

  setHiddenRoofs(hidden: boolean): void {
    if (this.hiddenRoofs === hidden) return;
    this.hiddenRoofs = hidden;
    this.buildingsDirty = true; this.buildingsUrgent = true;
    this.buildingSig = -1;
  }

  /** The original's B key removes/replaces buildings to expose people and pavement. */
  toggleBuildingsRemoved(): void {
    this.buildingsRemoved = !this.buildingsRemoved;
    this.buildingOutline.visible = false;
    this.buildingsDirty = true; this.buildingsUrgent = true;
    this.buildingSig = -1;
  }

  areBuildingsRemoved(): boolean {
    return this.buildingsRemoved;
  }

  isLowered(): boolean {
    return this.hiddenRoofs;
  }

  /** `urgent: false` for routine world bumps, checked at most twice a second. */
  markDirty(urgent = true): void {
    this.groundDirty = true; if (urgent) this.groundUrgent = true;
    this.buildingsDirty = true; if (urgent) this.buildingsUrgent = true;
  }

  select(building: Building | null, person: Person | null): void {
    if (person && bossInsideOffice(person)) person = null;
    if (this.selectedBuildingId !== (building?.id ?? null)) {
      this.selectedBuildingId = building?.id ?? null;
      this.buildingsDirty = true; this.buildingsUrgent = true; this.buildingSig = -1;
    }
    if (building) {
      this.buildingOutline.visible = !this.buildingsRemoved;
      this.selectionRing.visible = false;
      this.personHalo.visible = false;
      this.selectedPersonId = null;
    } else if (person) {
      this.buildingOutline.visible = false;
      this.selectedPersonId = person.id;
      // While the streets are closed nobody is drawn, so the ring marks the
      // spot instead of an outline round nothing.
      const drawn = this.streetsOpen && this.agentIds.includes(person.id);
      this.selectionRing.position.set(person.pos.x, KERB_H + 0.35, person.pos.y);
      this.selectionRing.scale.setScalar(0.28);
      this.selectionRing.visible = !drawn;
      if (!drawn) this.personHalo.visible = false;
    } else {
      this.selectionRing.visible = false;
      this.buildingOutline.visible = false;
      this.personHalo.visible = false;
      this.selectedPersonId = null;
    }
  }

  setTaggedViews(rects: TaggedViewRect[]): void {
    this.tagged.set(rects, this.flipped);
  }

  private cullStreetFurniture(): void {
    const reach = this.groundReach() + BLOCK_SIZE, t = this.target;
    // The Tagged insets draw the same pools from their own cameras, so the
    // furniture round each watched person is kept as well as the main view's.
    const tagged = [...this.tagged.views.values()].filter(v => v.visible)
      .map(v => [Math.round(v.target.x / 10), Math.round(v.target.z / 10)].join(',')).join(';');
    if (tagged === this.furnitureTagged && Math.abs(reach - this.furnitureReach) < reach * .1 &&
      Math.hypot(t.x - this.furnitureAt.x, t.z - this.furnitureAt.z) < BLOCK_SIZE * .5) return;
    // Fill a margin beyond the frame so small pans need no refill.
    const fill = reach + BLOCK_SIZE;
    this.furnitureAt.set(t.x, 0, t.z);
    this.furnitureReach = reach;
    this.furnitureTagged = tagged;
    const centres: [number, number, number][] = [[t.x, t.z, fill]];
    for (const v of this.tagged.views.values()) if (v.visible) centres.push([v.target.x, v.target.z, TAGGED_FURNITURE_REACH]);
    for (const placements of this.streetFurniture) refillNear(placements, centres);
  }

  private roomPools(): InstancePool[] {
    return [this.cutawayCaps, this.cutawayLinings, ...(this.furniture?.values() ?? [])].filter(Boolean);
  }

  /** Draw the rooms of opened buildings near the camera, laying each out the
   * first time it comes near; on a pan, refill only once the view has moved
   * well away from the last fill. */
  private furnishNear(force: boolean): void {
    if (!this.cutawayCaps || !this.furniture) return;
    // The ground the camera can see: the oblique view stretches its height.
    const viewH = 240 / this.zoom, viewW = viewH * this.width / Math.max(1, this.height);
    const t = this.target, radius = THREE.MathUtils.clamp(.5 * Math.hypot(viewW, viewH * 1.8) + 15, 60, 230);
    if (!force && radius <= this.furnishedRadius * 1.1 &&
      Math.hypot(t.x - this.furnishedAt.x, t.z - this.furnishedAt.z) < this.furnishedRadius * .3) return;
    this.furnishedAt.set(t.x, 0, t.z);
    this.furnishedRadius = radius;
    const pools = this.roomPools();
    for (const p of pools) p.reset();
    if (this.hiddenRoofs && !this.buildingsRemoved) for (const room of this.roomCache) {
      if ((room.x - t.x) ** 2 + (room.z - t.z) ** 2 > radius * radius) continue;
      room.items ??= this.layCutawayRooms(room);
      for (const item of room.items) {
        this.furnishMatrix.fromArray(item.m);
        this.furnishColor.setRGB(item.r, item.g, item.b);
        item.pool.push(this.furnishMatrix, this.furnishColor);
      }
    }
    for (const p of pools) p.commit();
  }

  /** Queue an opened mass's rooms: only its position and size are kept here,
   * the layout itself waits until the camera comes near (furnishNear). */
  private addCutawayRooms(b: Building, m: { dx: number; dz: number; y: number; w: number; d: number; h: number; floorY?: number },
    massIndex: number, yaw: number, intact: { y: number; h: number }[], light: number, px: number, pz: number): void {
    this.roomCache.push({ x: px, z: pz, px, pz, yaw, light, massIndex, id: b.id, cls: b.cls, typeId: b.typeId,
      dx: m.dx, dz: m.dz, w: m.w, d: m.d, floor: KERB_H + (m.floorY ?? 0) + .071, top: KERB_H + m.y + m.h,
      multiStorey: intact.some(x => x.y + x.h > 5) });
  }

  /** Rooms in an opened mass: masonry caps, plastered walls and partitions,
   * a staircase and furniture, as the original draws a cutaway. */
  private layCutawayRooms(room: QueuedRooms): RoomItem[] {
    const items: RoomItem[] = [], { floor, top, yaw, light } = room;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const layout = cutawayRoomLayout(room.id * 4 + room.massIndex, room.w, room.d, top - floor, kitFor(room.cls, room.typeId),
      { stairs: room.massIndex === 0 && room.multiStorey, partitions: room.cls !== 'industrial', frontDoor: room.massIndex === 0 });
    const put = (pool: InstancePool, x: number, y: number, z: number, w: number, h: number, d: number, extraYaw = 0) => {
      const lx = room.dx + x, lz = room.dz + z;
      this.dummy.position.set(room.px + lx * cos + lz * sin, y, room.pz - lx * sin + lz * cos);
      this.dummy.rotation.set(0, yaw + extraYaw, 0);
      this.dummy.scale.set(w, h, d);
      this.dummy.updateMatrix();
      items.push({ pool, m: this.dummy.matrix.toArray(), r: this.tintScratch.r, g: this.tintScratch.g, b: this.tintScratch.b });
    };
    for (const c of layout.caps) {
      const v = c.tint * light;
      this.tintScratch.setRGB(.37 * v, .355 * v, .34 * v, THREE.SRGBColorSpace);
      put(this.cutawayCaps, c.x, top - .03, c.z, c.w, c.h, c.d);
    }
    for (const l of layout.linings) {
      const v = l.tint * light;
      this.tintScratch.setRGB(.62 * v, .55 * v, .45 * v, THREE.SRGBColorSpace);
      put(this.cutawayLinings, l.x, floor, l.z, l.w, l.h, l.d);
    }
    this.tintScratch.setRGB(light, light, light);
    for (const f of layout.furniture) {
      const pool = this.furniture.get(f.kind);
      if (pool) put(pool, f.x, floor, f.z, 1, 1, 1, f.yaw);
    }
    return items;
  }

  taggedViewStatus(id: number): { flipped: boolean; obscured: boolean; cutaway: boolean } {
    const view = this.tagged.views.get(id);
    return { flipped: view?.side === -1, obscured: !!view?.visible && !this.agentIds.includes(id),
      cutaway: !!view?.obscured && view.rect?.mode === 'street' };
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // Moved to a screen with another scale (or the page zoomed): render at its ratio.
    const ratio = Math.min(window.devicePixelRatio, 2);
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    this.clampTarget();
    this.updateCamera();
  }

  /**
   * How fast the decorative life of the city runs, in game seconds per real
   * second: the week's speed multiplier while it runs, 0 while it is paused.
   */
  setTimeScale(rate: number): void {
    this.timeScale = Math.max(0, rate);
  }

  /** How far the sim is into its current minute, so movement can be smoothed. */
  setSubMinute(fraction: number): void {
    this.subMinute = Math.max(0, Math.min(1, fraction));
  }

  /**
   * Whether the working week is under way. Until it is, the streets are
   * empty: no people, no traffic — the city waits for the orders.
   */
  setStreetsOpen(open: boolean): void {
    if (open === this.streetsOpen) return;
    this.streetsOpen = open;
    // Planning prepared an empty street. People, cars and their materials need
    // their own preparation before the working week becomes interactive.
    this.preparationRevision++;
    this.agentMesh.visible = open;
    this.actors.setVisible(open);
    this.sculptModels?.setVisible(open && this.sculptModelsActive);
    if (!open) this.personHalo.visible = false;
    for (const p of [this.footRings, this.waitMarks, this.arrestMarks]) p.mesh.visible = open;
    this.syncVehiclePresentation();
    this.headlamps.mesh.visible = open;
    if (!open) {
      this.agentMesh.count = 0;
      this.agentIds = [];
      this.burningPeople?.reset();
      this.burningPeople?.commit();
      this.emergencyHoses?.reset();
      this.emergencyHoses?.commit();
      this.actorMotion.clear();
    } else {
      this.updateCamera();
    }
  }

  /** 0.55 (city plan) .. 11 (street level). */
  setZoom(z: number): void {
    this.zoom = Math.max(0.55, Math.min(11, z));
    // Pulling back can leave the old target too near an edge to fill the frame.
    this.clampTarget();
    this.updateCamera();
  }

  /** Paint street names on the carriageway (Game Options). */
  setRoadNames(on: boolean): void {
    if (this.groundMat) this.groundMat.labelStrength.value = on ? 0.28 : 0;
  }

  getZoom(): number {
    return this.zoom;
  }

  /** The original's Flip Screen: the view from the opposite corner, left and right reversed. */
  flipView(): void {
    this.flipped = !this.flipped;
    this.updateCamera();
  }

  isFlipped(): boolean {
    return this.flipped;
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  panBy(dxPixels: number, dyPixels: number): void {
    const scale = (240 / this.zoom) / this.height;
    // Screen right/down mapped into the isometric ground plane.
    const side = this.flipped ? -1 : 1;
    const right = new THREE.Vector3(side, 0, -side).normalize();
    const fwd = new THREE.Vector3(side, 0, side).normalize();
    this.target.addScaledVector(right, -dxPixels * scale);
    this.target.addScaledVector(fwd, -dyPixels * scale / Math.sin(CAMERA_ELEVATION));
    this.clampTarget();
    this.updateCamera();
  }

  centerOn(x: number, y: number): void {
    this.target.set(x, 0, y);
    this.clampTarget();
    this.updateCamera();
  }

  getTarget(): { x: number; y: number } {
    return { x: this.target.x, y: this.target.z };
  }

  /**
   * How far the frame reaches across the ground along each map axis. The
   * camera looks down a diagonal, so screen-up runs along one ground diagonal
   * and screen-right along the other; both spend part of their length on x and
   * the same part on z. The coefficients come from projecting the camera basis
   * onto the ground plane.
   */
  private groundReach(): number {
    const viewH = 240 / this.zoom;
    const viewW = viewH * (this.width / this.height);
    return viewH * Math.SQRT1_2 / (2 * Math.sin(CAMERA_ELEVATION)) + viewW * Math.SQRT1_2 / 2;
  }

  private clampTarget(): void {
    const cityW = this.world.gridW * CELL;
    const cityH = this.world.gridH * CELL;
    const reach = this.groundReach();
    // Keep the city filling the frame; once the frame is wider than the city
    // the only sensible target is its middle, which is what these agree on.
    const low = (span: number) => Math.min(span / 2, reach - 40);
    const high = (span: number) => Math.max(span / 2, span - reach + 40);
    this.target.x = clamp(this.target.x, low(cityW), high(cityW));
    this.target.z = clamp(this.target.z, low(cityH), high(cityH));
  }

  private updateCamera(): void {
    const aspect = this.width / this.height;
    const viewH = 240 / this.zoom;
    const viewW = viewH * aspect;
    this.camera.left = -viewW / 2;
    this.camera.right = viewW / 2;
    this.camera.top = viewH / 2;
    this.camera.bottom = -viewH / 2;

    const dist = 900;
    const side = this.flipped ? -1 : 1;
    const dir = new THREE.Vector3(side, Math.SQRT2 * Math.tan(CAMERA_ELEVATION), side).normalize();
    this.camera.position.copy(this.target).addScaledVector(dir, dist);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();

    // Fill both visible wall directions, including Flip Screen. The light's
    // upward component stays fixed for horizontal roof/floor diffuse lighting.
    this.bounce.position.set(side * 720, 120, side * 560);

    // Retain broad coverage for off-screen buildings at city zoom. Concentrate
    // the map only at street zoom so filtering preserves shoe/tyre contact.
    const minShadowExtent = lerp(110, 60, smoothstep(4, 8, this.zoom));
    const s = clamp(viewH * 0.85, minShadowExtent, 620);
    const cam = this.sun.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    cam.updateProjectionMatrix();

    // Detail that would only shimmer at plan height is dropped there.
    const near = this.zoom > 0.95;
    const close = this.zoom > 1.6;
    this.signs.mesh.visible = near;
    this.awnings.mesh.visible = near;
    this.hydrants.mesh.visible = near;
    this.trees.mesh.visible = this.zoom > 0.7;
    if (this.treeModels) this.treeModels.group.visible = this.zoom > 0.7;
    this.fireEscapes.mesh.visible = near;
    this.interiorMachines.mesh.visible = near;
    this.cutawayCaps.mesh.visible = near;
    this.cutawayLinings.mesh.visible = near;
    for (const pool of this.furniture.values()) pool.mesh.visible = near;
    this.interiorStorage.mesh.visible = near;
    this.lamps.mesh.visible = this.zoom > 0.75;
    this.tanks.mesh.visible = this.zoom > 0.7;
    this.columns.mesh.visible = close || this.zoom > 0.9;

    if (this.scene.fog) {
      const fog = this.scene.fog as THREE.Fog;
      fog.near = 700 + viewH * 1.4;
      fog.far = 1700 + viewH * 5.5;
    }
  }

  /** Day/night colouring across the working week. */
  private applyTimeOfDay(): number {
    const phase = this.world.phase === 'week' ? dayPhase(this.world.minute) : 0.36;
    // The working day runs 8am to 4pm, so every minute of it is daylight: the
    // sun only climbs from a low morning angle to midday and back down again.
    const noon = Math.sin(Math.PI * clamp(0.28 + 0.44 * phase, 0, 1));
    // The last hour of business goes golden and then flat.
    const dusk = smoothstep(0.74, 1.0, phase);

    // As in the original's pre-lit street view, the sun comes from the
    // viewer's upper left whichever way the camera faces: the wall on the left
    // of the screen in full sun, the right one a little less, far faces in
    // shadow. Only its height follows the day.
    const side = this.flipped ? -1 : 1;
    const elev = 0.35 + noon * 0.95;
    const across = new THREE.Vector2(side * 0.35, side * 1.0).normalize().multiplyScalar(280);
    this.sun.position
      .copy(this.target)
      .add(new THREE.Vector3(across.x, elev * 300, across.y));
    this.sun.target.position.copy(this.target);
    this.sun.target.updateMatrixWorld();

    // The original's street view sits in strong, warm sunlight all day with
    // deep shadow on the far faces (playtest, 28 September: warmer, higher
    // contrast). A strong warm sun with less fill; the day still swings.
    this.sun.intensity = 2.2 + noon * 1.0;
    this.sun.color.setRGB(1, lerp(0.8, 0.9, noon), lerp(0.58, 0.72, noon));
    this.hemi.intensity = 0.5 + noon * 0.4;
    this.hemi.color.setRGB(lerp(0.55, 0.62, noon), lerp(0.6, 0.7, noon), lerp(0.78, 0.85, noon));
    // Match the gain-four horizontal direction; I * direction.y is unchanged.
    this.bounce.intensity = (0.15 + noon * 0.2) * (Math.hypot(720, 120, 560) / Math.hypot(180, 120, 140));

    const sky = new THREE.Color().setRGB(
      lerp(0.1, 0.42, noon) + dusk * 0.16,
      lerp(0.1, 0.48, noon) - dusk * 0.03,
      lerp(0.15, 0.56, noon) - dusk * 0.08,
    );
    (this.scene.background as THREE.Color).copy(sky);
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(sky);

    // Windows come on as the afternoon light goes.
    const lightUp = smoothstep(0.66, 1.0, phase);
    for (const m of this.facadeMats) m.emissiveIntensity = lightUp * 1.1;
    this.shopMat.emissiveIntensity = lightUp * 0.9;
    this.glowMat.opacity = dusk * 0.95;
    this.headlampMat.opacity = dusk * 0.9;
    this.lampGlow.mesh.visible = dusk > 0.02;

    // A faint sheen on the roadway once the light goes flat.
    this.groundMat.roughness = 0.93 - dusk * 0.3;
    this.groundMat.metalness = 0.02 + dusk * 0.16;
    return dusk;
  }

  /** Follow the street being viewed, including when no hood is selected. */
  private updateForegroundCutaways(): void {
    const person = this.selectedPersonId == null ? null : this.world.people[this.selectedPersonId];
    const next = new Set<ID>();
    // Opened buildings show their top storey; one is cut to the pavement only
    // when it hides what the player is watching (a selected person or site).
    // Free panning has no focus: re-testing the sightline on every pan rebuilt
    // the whole city each time the set changed (7 fps while panning).
    const watching = person != null || this.selectedBuildingId != null;
    if (this.hiddenRoofs && !this.buildingsRemoved && this.streetsOpen && watching) {
      const pos = person ? previewStreetPosition(person, this.world, this.subMinute, this.taggedPreview) : null;
      const profile = person && this.vehicleProfile(vehicleForPerson(this.world, person));
      const radius = person?.inVehicle && profile ? Math.hypot(profile.length, profile.width) / 2 + .2 : .35 * CHARACTER_SCALE;
      const h = person?.inVehicle && profile ? profile.height / 2 : CHARACTER_SCALE;
      const point = pos ? new THREE.Vector3(pos.x, streetSurfaceHeight(this.world, pos.x, pos.y) + h, pos.y) : this.target;
      if (this.cutawayRadius === radius && this.cutawayPerson === (person?.id ?? null) &&
          this.cutawayBuilding === this.selectedBuildingId && this.cutawayFlipped === this.flipped &&
          this.cutawayRevision === this.buildingSig && this.cutawayPoint.distanceToSquared(point) < .25 &&
          this.cutawayCamera.distanceToSquared(this.target) < .25) return;
      // Always test the intact variant, so already cut walls cannot oscillate.
      const restore = this.useTaggedBuildings(false);
      try {
        const side = this.flipped ? -1 : 1;
        const direction = new THREE.Vector3(side, Math.SQRT2 * Math.tan(CAMERA_ELEVATION), side).normalize();
        const sight = (this.sightProxies ?? this.picks).mesh;
        sight.updateMatrixWorld(true);
        const focus = new THREE.Vector3(this.target.x, KERB_H + 1, this.target.z);
        const geometry = sight.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const localFocus = new THREE.Vector3();
        for (let i=0;i<sight.count;i++) {
          sight.getMatrixAt(i,this.mat4);
          localFocus.copy(focus).applyMatrix4(this.mat4.invert());
          if (geometry.boundingBox!.containsPoint(localFocus)) next.add(this.buildingIds[i]);
        }
        const hits = actorSightlineHits(this.cutawayRay, focus, direction, 6, sight);
        if (person) hits.push(...actorSightlineHits(this.cutawayRay, point, direction, radius, sight));
        for (const hit of hits) {
          if (hit.instanceId != null) {
            const id = this.buildingIds[hit.instanceId];
            if (id != null) next.add(id);
          }
        }
        // A selected building contains the focus point; an outward ray starts
        // inside its picking box, so include that building explicitly.
        if (this.selectedBuildingId != null) next.add(this.selectedBuildingId);
      } finally { restore?.(); }
      this.cutawayPerson = person?.id ?? null;
      this.cutawayBuilding = this.selectedBuildingId;
      this.cutawayRadius = radius;
      this.cutawayPoint.copy(point);
      this.cutawayCamera.copy(this.target);
      this.cutawayFlipped = this.flipped;
      this.cutawayRevision = this.buildingSig;
    } else {
      this.cutawayPerson = null;
      this.cutawayBuilding = null;
      this.cutawayPoint.set(Infinity, Infinity, Infinity);
      this.cutawayCamera.set(Infinity, Infinity, Infinity);
    }
    if (next.size !== this.foregroundCutaways.size || [...next].some(id => !this.foregroundCutaways.has(id))) {
      this.foregroundCutaways = next;
      this.clearBuildingViews();
      this.buildingsDirty = true;
    }
  }

  update(): void {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.clock += dt;
    this.landscape?.updateWater(this.clock);
    this.simClock += dt * this.timeScale;
    this.landscape?.updateTrains(this.simClock);
    this.landscape?.updateTrams(this.world.minute + this.subMinute);
    // Chalk outlines and charred silhouettes where people died, checked twice a second.
    if (this.clock - this.deathMarksChecked > .5) {
      this.deathMarksChecked = this.clock;
      if (!this.deathMarks) { this.deathMarks = new DeathMarks(); this.scene.add(this.deathMarks.group); }
      this.deathMarks.update(this.world, (x, y) => streetSurfaceHeight(this.world, x, y), p => this.shuttleSeen.get(p.id) ?? p.pos);
    }
    // Pose transitions can settle after a paused command; one-shot action time
    // remains frozen with the simulation and cannot advance a shot or a fall.
    this.actionDelta=dt;
    this.characterActions.update(this.world,dt*Math.min(2,this.timeScale),id=>this.shownAt(id));
    // Shots from cars: the gun out of the window, its flash and streak.
    this.carGunfire?.update(this.world,dt*Math.min(2,this.timeScale),id=>{const p=this.world.people[id];return p?previewStreetPosition(p,this.world,this.subMinute,this.taggedPreview):undefined;},(x,y)=>streetSurfaceHeight(this.world,x,y));
    const effectRevision=this.cityEffects?.revision;
    this.cityEffects?.setFocusPoints([{x:this.target.x,z:this.target.z},...Array.from(this.tagged.views.values()).filter(t=>t.visible).map(t=>({x:t.target.x,z:t.target.z}))]);
    this.cityEffects?.update(this.world,dt*Math.min(2,this.timeScale),this.streetsOpen&&!this.buildingsRemoved);
    if(effectRevision!==this.cityEffects?.revision){this.buildingsDirty=true;this.buildingsUrgent=true;}
    // The city, heard from the camera (src/render/cityAudio.ts).
    if (this.streetsOpen) {
      const zoom01 = THREE.MathUtils.clamp((this.zoom - .8) / (VIEW_ZOOM.street - .8), 0, 1);
      let responders = 0;
      for (const id of this.agentIds) { const r = this.world.people[id]?.emergencyResponse; if (r && r.week === this.world.week && r.stage === 'approaching' && r.kind !== 'reporter') { responders++; break; } }
      // The two fastest stages (8 and maximum) are too quick for one-shots.
      this.cityAudio.update(this.world, this.camera, this.target, this.groundReach(), zoom01, dt,
        this.timeScale > 0, this.timeScale >= 8, this.cityEffects?.activeFires() ?? [], responders);
    } else streetSound.setBeds(0, 0); // Planning, the menu: no traffic hum or crackle left looping.

    // Routine version bumps (many a second in the working week) are checked at
    // most four times a second: the signature walks every block's known owners.
    const groundNow = performance.now();
    if (this.groundDirty && (this.groundUrgent || groundNow - this.groundCheckedAt >= 500)) {
      this.groundUrgent = false; this.groundCheckedAt = groundNow;
      const sig = this.groundSignature();
      if (sig !== this.groundSig) {
        this.drawGround();
        this.groundSig = sig;
      }
      this.groundDirty = false;
    }
    this.updateForegroundCutaways();
    if (this.hiddenRoofs && this.furnishedAt) this.furnishNear(false);
    if (this.territorySegments?.length) this.layTerritoryLines();
    if (this.streetFurniture?.length) this.cullStreetFurniture();
    // The building signature hashes every building: routine bumps (five a
    // second in the working week) are checked at most twice a second.
    if (this.buildingsDirty && (this.buildingsUrgent || groundNow - this.buildingsCheckedAt >= 500)) {
      this.buildingsUrgent = false; this.buildingsCheckedAt = groundNow;
      const sig = this.signature();
      if (sig !== this.buildingSig) {
        this.refreshBuildings();
        this.buildingSig = sig;
      }
      this.buildingsDirty = false;
    }
    const dusk = this.applyTimeOfDay();
    for (const [id, view] of this.tagged.views) {
      const watched = this.world.people[id];
      if (!watched) { this.tagged.views.delete(id); continue; }
      if (!view.visible) continue;
      const pos = previewStreetPosition(watched, this.world, this.subMinute, this.taggedPreview);
      const h = watched.inVehicle ? this.vehicleProfile(vehicleForPerson(this.world, watched)).height * .5 : 1;
      view.target.set(pos.x, streetSurfaceHeight(this.world, pos.x, pos.y) + h, pos.y);
    }
    if (this.streetsOpen) {
      this.refreshAgents();
      this.refreshTraffic(dusk);
    }
  }

  isPrepared(): boolean {
    return !this.disposed && !this.treeLoad && !this.rubbleLoad && !(this.streetsOpen && this.preferSculptModels && this.sculptLoad) && this.preparedRevision === this.preparationRevision;
  }

  /** May be called repeatedly; navigation/disposal cancels all pending GPU work. */
  prepare(onProgress?: (message: string) => void): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.isPrepared()) return Promise.resolve(true);
    if (!this.preparation) {
      this.preparation = this.prepareCurrent(onProgress).finally(() => { this.preparation = null; });
    }
    return this.preparation;
  }

  private async prepareCurrent(onProgress?: (message: string) => void): Promise<boolean> {
    while (!this.disposed) {
      onProgress?.(this.streetsOpen && this.sculptLoad ? 'Loading people and vehicles…' : 'Preparing the city…');
      await yieldForPaint();
      if (this.disposed) return false;
      if (this.treeLoad) { onProgress?.('Loading park and street trees…'); await this.treeLoad; }
      if (this.rubbleLoad) { onProgress?.('Loading building debris…'); await this.rubbleLoad; }
      if (this.streetsOpen && this.preferSculptModels && this.sculptLoad) await this.sculptLoad;
      if (this.disposed) return false;
      const revision = this.preparationRevision;
      // Populate the ground and current visibility before collecting maps.
      // Delivered art may arrive later: fallbacks need no network dependency.
      this.setTimeScale(0);
      onProgress?.('Placing people and vehicles…');
      await yieldForPaint();
      if (this.disposed || revision !== this.preparationRevision) continue;
      this.update();
      onProgress?.('Preparing textures and lighting…');
      await yieldForPaint();
      if (await prepareScene(this.renderer, this.scene, this.camera,
        () => !this.disposed && revision === this.preparationRevision)) {
        onProgress?.('Finishing the street view…');
        await yieldForPaint();
        const current = () => !this.disposed && revision === this.preparationRevision;
        if (!current()) continue;
        this.render();
        if (!await waitForGpu(this.renderer.getContext() as WebGL2RenderingContext, current)) continue;
        this.preparedRevision = revision;
        this.lastFrame = performance.now();
        return true;
      }
    }
    return false;
  }

  render(): void {
    this.scene.updateMatrixWorld();
    // Shadow casters only need finding when loaders add them: a scene walk
    // twice a second, not every frame (building views watch as they add).
    const now = performance.now();
    if (now - this.shadowWatchedAt >= 500) { this.shadowWatchedAt = now; this.shadowMaterials.watch(this.scene); }
    this.cityEffects?.setLowered(this.hiddenRoofs);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.scene, this.camera);
    this.buildingOutline.render(this.renderer, this.camera);
    for (const view of this.tagged.views.values()) this.renderTaggedView(view);
  }

  private clearBuildingViews(): void {
    for (const views of this.buildingViewMeshes.values()) for (const view of views) view.dispose();
    this.buildingViewMeshes.clear();
    this.buildingViews.clear();
  }

  /** Planning has no street actors: keep their selectable locations visible. */
  setPlanningPeople(people: Person[], selected: ID | null): void {
    this.planningPeople = new Map(people.map(p => [p.id, { ...p.pos }]));
    if (!this.planningPersonMarks && people.length) {
      const geometry = new THREE.RingGeometry(.8, 1.8, 24);
      geometry.rotateX(-Math.PI / 2);
      this.planningPersonMarks = new InstancePool(geometry,
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }), MAX_AGENTS, { color: true });
      this.planningPersonMarks.mesh.renderOrder = 12;
      this.scene.add(this.planningPersonMarks.mesh);
    }
    const marks = this.planningPersonMarks;
    if (!marks) return;
    marks.reset();
    const matrix = new THREE.Matrix4(), blue = new THREE.Color(0x387cdf), red = new THREE.Color(0xd63832);
    for (const p of people) marks.push(matrix.makeTranslation(p.pos.x, KERB_H + .35, p.pos.y), p.id === selected ? red : blue);
    marks.commit();
  }

  setPlanningTargets(available: Set<ID>, selected: Set<ID>, crimes = new Set<ID>()): void {
    if (available.size === this.planningAvailable.size && selected.size === this.planningSelected.size && crimes.size === this.planningCrimes.size &&
      [...available].every(id => this.planningAvailable.has(id)) && [...selected].every(id => this.planningSelected.has(id)) && [...crimes].every(id => this.planningCrimes.has(id))) return;
    this.planningAvailable = available;
    this.planningSelected = selected;
    this.planningCrimes = crimes;
    this.buildingsDirty = true;
    this.buildingSig = -1;
  }

  /** Roof mode is independent in the inset. Keep its instance data on the GPU:
   * rewriting all city buffers for every inset stalls behind the previous draw. */
  private useTaggedBuildings(hidden: boolean): (() => void) | null {
    if (this.buildingsRemoved || hidden === this.hiddenRoofs) return null;
    const pools = [...this.wallPools, ...this.cutawayWalls, ...this.decor];
    let current = this.buildingViews.get(this.hiddenRoofs);
    if (!current) {
      current = pools.map(pool => pool.snapshot());
      this.buildingViews.set(this.hiddenRoofs, current);
    }
    let alternate = this.buildingViews.get(hidden);
    if (!alternate) {
      const mainHidden = this.hiddenRoofs, dirty = this.buildingsDirty;
      const ids = this.buildingIds, footprints = this.footprints;
      this.footprints = new Map();
      this.hiddenRoofs = hidden;
      this.makingBuildingView = true;
      try {
        this.refreshBuildings();
        alternate = pools.map(pool => pool.snapshot());
        this.buildingViews.set(hidden, alternate);
      } finally {
        this.hiddenRoofs = mainHidden;
        this.buildingsDirty = dirty;
        this.buildingIds = ids;
        this.footprints = footprints;
        this.makingBuildingView = false;
        pools.forEach((pool, i) => pool.restore(current![i]));
      }
    }
    let views = this.buildingViewMeshes.get(hidden);
    if (!views) {
      views = pools.map((pool, i) => new PoolView(pool.mesh, alternate![i]));
      for (const view of views) this.scene.add(view.mesh);
      this.buildingViewMeshes.set(hidden, views);
      this.shadowMaterials.watch(this.scene);
    }
    const visibility = pools.map(pool => pool.mesh.visible);
    pools.forEach((pool, i) => { views![i].mesh.visible = pool.mesh.visible; pool.mesh.visible = false; });
    return () => pools.forEach((pool, i) => { views![i].mesh.visible = false; pool.mesh.visible = visibility[i]; });
  }

  /** Draw into the HUD opening without allocating a second scene or WebGL context. */
  private renderTaggedView(t: TaggedView): void {
    const r = t.rect;
    if (!r || !t.visible || !this.streetsOpen) return;
    const left = Math.max(0, r.clipLeft ?? r.x), right = Math.min(this.width, r.clipRight ?? r.x + r.width);
    const top = Math.max(0, r.clipTop), bottom = Math.min(this.height, r.clipBottom);
    if (right <= left || bottom <= top) return;
    const sunPosition = this.sun.position.clone();
    const sunTarget = this.sun.target.position.clone();
    const bouncePosition = this.bounce.position.clone();
    const shadowCamera = this.sun.shadow.camera;
    const shadowBounds = [shadowCamera.left, shadowCamera.right, shadowCamera.top, shadowCamera.bottom];
    const ringVisible = this.selectionRing.visible;
    const restoreBuildings = this.useTaggedBuildings(r.mode === 'street');
    const watched = this.world.people[r.personId];
    const profile = watched && this.vehicleProfile(vehicleForPerson(this.world, watched));
    const radius = watched?.inVehicle && profile ? Math.hypot(profile.length, profile.width) / 2 + .2 : .35 * CHARACTER_SCALE;
    t.update(t.target.x, t.target.y, t.target.z, this.picks.mesh, this.buildingSig * 2 + (r.mode === 'street' ? 1 : 0), radius);
    const clipping = this.renderer.localClippingEnabled;
    const clipped = new Map<THREE.Material, { planes: THREE.Plane[] | null; shadows: boolean }>();
    try {
      // Dense blocks can obstruct BOTH camera directions. In that case cut
      // building surfaces to a low wall in this inset only; never clip people
      // or vehicles, or turn the main city into a second follow camera.
      if (t.obscured && r.mode === 'street') {
        for (const pool of [...this.wallPools, ...this.cutawayWalls, ...this.decor]) {
          for (const material of Array.isArray(pool.mesh.material) ? pool.mesh.material : [pool.mesh.material]) {
            if (clipped.has(material)) continue;
            clipped.set(material, { planes: material.clippingPlanes, shadows: material.clipShadows });
            material.clippingPlanes = [this.taggedCutPlane];
            material.clipShadows = true;
          }
        }
        this.renderer.localClippingEnabled = true;
      }
      // Give the watched location the same sun direction and contact shadows,
      // even when the main camera has panned to the other side of the city.
      this.sun.position.add(t.target).sub(sunTarget);
      this.sun.target.position.copy(t.target);
      this.sun.target.updateMatrixWorld(true);
      this.bounce.position.set(t.side * 720, 120, t.side * 560);
      this.sun.updateMatrixWorld(); this.bounce.updateMatrixWorld();
      const extent = r.mode === 'street' ? 36 : 90;
      shadowCamera.left = -extent; shadowCamera.right = extent;
      shadowCamera.top = extent; shadowCamera.bottom = -extent;
      shadowCamera.updateProjectionMatrix();
      this.selectionRing.visible = false;
      if (this.vehicleSpritesActive) this.refreshTraffic(this.headlampMat.opacity / .9, t.camera);
      this.renderer.setViewport(r.x, this.height - r.y - r.height, r.width, r.height);
      this.renderer.setScissor(left, this.height - bottom, right - left, bottom - top);
      this.renderer.setScissorTest(true);
      this.cityEffects?.setLowered(r.mode === 'street');
      this.renderer.render(this.scene, t.camera);
    } finally {
      for (const [material, before] of clipped) {
        material.clippingPlanes = before.planes;
        material.clipShadows = before.shadows;
      }
      this.renderer.localClippingEnabled = clipping;
      restoreBuildings?.();
      this.cityEffects?.setLowered(this.hiddenRoofs);
      this.sun.position.copy(sunPosition);
      this.sun.target.position.copy(sunTarget);
      this.sun.target.updateMatrixWorld(true);
      this.bounce.position.copy(bouncePosition);
      this.sun.updateMatrixWorld(); this.bounce.updateMatrixWorld();
      [shadowCamera.left, shadowCamera.right, shadowCamera.top, shadowCamera.bottom] = shadowBounds;
      shadowCamera.updateProjectionMatrix();
      this.selectionRing.visible = ringVisible;
      if (this.vehicleSpritesActive) this.refreshTraffic(this.headlampMat.opacity / .9);
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.setScissorTest(false);
    }
  }

  /** Where a point on the ground falls on the canvas, in canvas pixels. */
  project(x: number, y: number, rect: DOMRect): { x: number; y: number } {
    this.projScratch.set(x, KERB_H + 1, y).project(this.camera);
    return { x: ((this.projScratch.x + 1) / 2) * rect.width, y: ((1 - this.projScratch.y) / 2) * rect.height };
  }

  /** Convert a canvas click into whatever is under it. */
  pick(clientX: number, clientY: number, rect: DOMRect): PickResult {
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const result: PickResult = { buildingId: null, blockId: null, personId: null, point: { x: 0, y: 0 } };

    // Screen-space tolerance includes the hollow ring's centre at distant zoom.
    if (!this.streetsOpen && this.planningPeople?.size) {
      let nearest = 9;
      for (const [id, pos] of this.planningPeople) {
        const projected = new THREE.Vector3(pos.x, KERB_H + .35, pos.y).project(this.camera);
        if (projected.z < -1 || projected.z > 1) continue;
        const distance = Math.hypot((projected.x - this.pointer.x) * rect.width / 2, (projected.y - this.pointer.y) * rect.height / 2);
        if (distance < nearest) { nearest = distance; result.personId = id; result.point = { ...pos }; }
      }
      if (result.personId != null) return result;
    }

    // People take priority — they are small and deliberately clicked.
    if (this.streetsOpen && this.agentMesh.count > 0) {
      const hits = this.raycaster.intersectObject(this.agentMesh, false);
      if (hits.length && hits[0].instanceId != null) {
        result.personId = this.agentIds[hits[0].instanceId] ?? null;
      }
    }
    if (this.picks.mesh.count > 0) {
      const hits = this.raycaster.intersectObject(this.picks.mesh, false);
      if (hits.length && hits[0].instanceId != null) {
        const id = this.buildingIds[hits[0].instanceId];
        if (id != null) {
          result.buildingId = id;
          result.blockId = this.world.buildings[id]?.blockId ?? null;
          result.point = { x: hits[0].point.x, y: hits[0].point.z };
        }
      }
    }
    const groundHit = this.raycaster.intersectObject(this.ground, false);
    if (groundHit.length) {
      const p = groundHit[0].point;
      result.point = { x: p.x, y: p.z };
      if (result.blockId == null) {
        const gx = Math.floor(p.x / CELL);
        const gy = Math.floor(p.z / CELL);
        if (gx >= 0 && gy >= 0 && gx < this.world.gridW && gy < this.world.gridH) {
          result.blockId = cityBlockAt(this.world, gx, gy)?.id ?? null;
        }
      }
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    streetSound.quiet();
    releaseAttachedShaders(this.renderer.getContext(), this.renderer.info.programs ?? []);
    document.fonts?.removeEventListener('loadingdone', this.fontsLoaded);
    this.clearGroundBase();
    // Release resources while the renderer still has its WebGL bookkeeping.
    this.ownedTextures.dispose();
    this.sun?.shadow.dispose();
    this.vehicleSprites?.dispose();
    this.sculptModels?.dispose();
    this.cityEffects?.dispose();
    this.deathMarks?.dispose();
    this.carGunfire?.dispose();
    this.burningPeople?.dispose();
    this.emergencyHoses?.dispose();
    this.landscape?.dispose();
    this.treeModels?.dispose();
    this.rubbleModels?.dispose();
    this.planningPersonMarks?.dispose();
    for (const p of [...this.wallPools, ...this.cutawayWalls, ...this.roomPools(), this.territoryLines].filter(Boolean)) p.dispose();
    for (const p of [
      ...this.decor,
      this.pavement,
      this.lamps,
      this.lampGlow,
      this.hydrants,
      this.trees,
      this.footRings,
      this.waitMarks,
      this.arrestMarks,
      this.sedans,
      this.trucks,
      this.speedsters,
      this.headlamps,
    ]) {
      p?.dispose();
    }
    this.agentMesh?.dispose();
    this.actors?.dispose();
    this.actorMotion.clear();
    this.agentMesh?.geometry.dispose();
    (this.agentMesh?.material as THREE.Material | undefined)?.dispose();
    this.ground?.geometry.dispose();
    (this.ground?.material as THREE.Material | undefined)?.dispose();
    this.selectionRing?.geometry.dispose();
    (this.selectionRing?.material as THREE.Material | undefined)?.dispose();
    this.buildingOutline?.dispose();
    this.personHalo?.geometry.dispose();
    (this.personHalo?.material as THREE.Material | undefined)?.dispose();
    // Construction may stop before these materials acquire owning pools.
    if (!this.wallPools.length) for (const material of this.facadeMats) material.dispose();
    if (!this.shopBase) this.shopMat?.dispose();
    if (!this.lampGlow) this.glowMat?.dispose();
    if (!this.headlamps) this.headlampMat?.dispose();
    this.clearBuildingViews();
    this.tagged.set([], false);
    this.shadowMaterials.dispose();
    // Give the context back now (menus and the attract loop made a new one
    // each time), restorably: a new city on this canvas restores it (a lost
    // context cannot be reused, and the next city on the canvas failed).
    const canvas = this.renderer.domElement, lose = this.renderer.getContext().getExtension('WEBGL_lose_context');
    this.renderer.dispose();
    if (lose) {
      canvas.addEventListener('webglcontextlost', event => event.preventDefault(), { once: true });
      releasedContexts.set(canvas, lose);
      lose.loseContext();
    }
    if (import.meta.env.DEV) {
      const dev = window as unknown as Record<string, unknown>;
      if (dev.__city === this) delete dev.__city;
    }
    void this.mat4;
  }
}

// ------------------------------------------------------------------ helpers

/** A small card painted on a canvas: cream disc, dark glyph. */
function markerTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#efe4c8';
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2a1f14';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#2a1f14';
  ctx.strokeStyle = '#2a1f14';
  draw(ctx);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A raised palm: wait for the word. */
function drawHand(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  // Fingers.
  for (const [x, top] of [[22, 20], [28, 15], [34, 14], [40, 19]] as const) {
    ctx.beginPath();
    ctx.moveTo(x, 36);
    ctx.lineTo(x, top);
    ctx.stroke();
  }
  // Thumb and palm.
  ctx.beginPath();
  ctx.moveTo(19, 38);
  ctx.lineTo(14, 30);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(19, 34);
  ctx.lineTo(43, 34);
  ctx.lineTo(43, 44);
  ctx.quadraticCurveTo(31, 52, 19, 44);
  ctx.closePath();
  ctx.fill();
}

/** Prison bars: an arrest. */
function drawBars(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 4;
  for (const x of [20, 28, 36, 44]) {
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, 48);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(16, 16);
  ctx.lineTo(48, 16);
  ctx.moveTo(16, 48);
  ctx.lineTo(48, 48);
  ctx.stroke();
}


function rpickColor(id: number, salt: number): THREE.Color {
  return awningScratch.setHex(AWNING_COLORS[rint(id, salt, AWNING_COLORS.length)]);
}

const bankCache = new WeakMap<WorldState, Map<ID, { x: number; y: number; w: number; h: number }[]>>();

/** Pavement height with a short visual step at the kerb; movement/collision remain in simulation metres. */
function streetSurfaceHeight(w: WorldState, x: number, z: number): number {
  if (w.cityLayout) {
    const b = cityBlockAt(w, Math.floor(x / CELL), Math.floor(z / CELL));
    if (b && (b.layout?.use === 'water' || avenueRoadway(b))) {
      // On a river block (or under a crossing) only the banks are raised.
      let banks = bankCache.get(w);
      if (!banks) bankCache.set(w, banks = new Map());
      let rects = banks.get(b.id);
      if (!rects) banks.set(b.id, rects = riverBank(w, b).banks);
      for (const r of rects) {
        const inside = Math.min(x - r.x, r.x + r.w - x, z - r.y, r.y + r.h - z);
        if (inside > -.16) return KERB_H * smoothstep(-.16, .16, inside);
      }
      return 0;
    }
    if (!b) return 0;
    const r = blockRect(b), pave = paveWidth(w);
    const inside = Math.min(x - r.x + pave, r.x + r.w + pave - x, z - r.y + pave, r.y + r.h + pave - z);
    return KERB_H * smoothstep(-.16, .16, inside);
  }
  const lx = ((x % CELL) + CELL) % CELL - CELL / 2;
  const lz = ((z % CELL) + CELL) % CELL - CELL / 2;
  const inside = SLAB_HALF - Math.max(Math.abs(lx), Math.abs(lz));
  return KERB_H * smoothstep(-.16, .16, inside);
}

/** A small tileable grit pattern used to break up the roadway. */
function makeGritTile(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  ctx.fillStyle = '#45474e';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.5 ? `rgba(150,150,148,${0.05 + rnd() * 0.14})` : `rgba(14,14,16,${0.05 + rnd() * 0.2})`;
    ctx.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 12 + rnd() * 44;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rnd() > 0.5 ? '180,178,172' : '10,10,12'},0.09)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}
