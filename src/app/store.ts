import { readTextureQuality, writeTextureQuality, type TextureQuality } from '../render/textureQuality';
import { applyUiScale, readUiScale, writeUiScale } from './uiScale';
import { applyLiveMovement } from '../sim/movement';
import { recordScorePeaks } from '../sim/scoring';
import { observeTargetRace } from '../sim/targetRace';
import { FLAT_OUT_BUDGET_MS, SPEED_STAGES, isFlatOut, nearestStage, stageIndex } from './speed';
import { automaticRoofsPreference } from '../render/viewModes';
import { bossInsideOffice } from '../render/characterPresentation';
import { create } from 'zustand';
import { fitAreaToWeek, type ApiResult } from '../sim/api';
import { Sim } from '../sim/sim';
import { planGang } from '../sim/ai';
import type { GameOptions, ID, MessageCategory, OrderOptions, OrderType, SpecialistJob, Vec2 } from '../sim/types';
import { specialistTargetEligible } from '../sim/specialistJobs';
import type { OverlayKind } from '../render/scene';
import { defaultGameOptions, newCampaignOptions } from './newGame';
import { cloneSavedWorldResponsive, loadGame, loadSlotWorld, saveGame, type SaveSlot } from './save';
import { yieldForInput } from '../yieldForInput';
import { yieldForPaint } from '../yieldForPaint';
import { captureTutorialProgress } from './tutorials';
import { addOrderBlocks, toggleOrderBlock, toggleOrderSite } from './orderSelection';
import { personMapPosition } from '../sim/mapIntel';

/** Colour washes: the map draws one of these at a time. */
const HEAT_OVERLAYS: readonly OverlayKind[] = ['landValue', 'crime', 'security', 'hostility', 'events'];

export type Screen = 'menu' | 'newGame' | 'game' | 'gameOver' | 'halloFame';

export type OrganizerTab =
  | 'lieutenants'
  | 'accountant'
  | 'lawyer'
  | 'diplomacy'
  | 'newspaper'
  | 'graphs'
  | 'maps'
  | 'options';

export interface JobCard {
  /** The confirmed job remains intact until this replacement is accepted. */
  editingOrderId?: ID;
  type: OrderType;
  teamId: ID;
  buildingIds: ID[];
  blockIds: ID[];
  personId: ID | null;
  pos: Vec2 | null;
  opts: OrderOptions;
  /** Sites left off the selection because the crew has not got the time. */
  trimmed?: { dropped: number; total: number };
  /** The selection as the player made it, before any was left off: more
   *  manpower takes back what fits, and toggles work on it. */
  requested?: { buildingIds: ID[]; blockIds: ID[] };
}

/** What the Organizer's right-hand panel is showing, if anything. */
export type OrganizerSheet =
  | null
  | { kind: 'orders'; group: 'business' | 'personnel' | 'minor' | 'violent' }
  | { kind: 'hoods' }
  | { kind: 'weapons' }
  | { kind: 'vehicles' }
  | { kind: 'recruits' }
  | { kind: 'person'; id: ID }
  | { kind: 'clipboard' };

export type PickMode =
  | null
  | { kind: 'order' }
  | { kind: 'lieutenantArea'; teamId: ID }
  | { kind: 'policeArea' }
  | { kind: 'specialist' }
  | { kind: 'streetOrder'; orderType: 'kill' | 'assault' | 'tail' | 'goTo'; personIds: ID[] };

interface GameState {
  sim: Sim | null;
  version: number;
  worldSession: number;
  screen: Screen;
  options: GameOptions;

  organizerTab: OrganizerTab;
  selectedTeamId: ID | null;
  selectedBuildingId: ID | null;
  selectedPersonId: ID | null;
  /** Your own people picked together on the street, for one street order to all of them. */
  selectedPersonIds: ID[];
  /** Independent live windows; street group selection does not replace them. */
  taggedPersonIds: ID[];
  /** The blocks the lawyer will tour putting officers on the payroll. */
  policeAreaBlockIds: ID[];
  /** The planned order the This Week's Orders rolodex is showing on the map. */
  reviewOrderId: ID | null;
  /** The How to Play sheet, and the quit prompt, opened from the keyboard. */
  helpOpen: boolean;
  /** Drop the roofs by themselves in Street View, as the original did. */
  autoLowerRoofs: boolean;
  /** Street names painted on the road (not in the original; off by default). */
  roadNames: boolean;
  /** The original's Mouse Reversal (Advanced Options): dragging moves the view the other way. */
  mouseReversal: boolean;
  /** Model texture quality; applies when the city next loads (A20). */
  textureQuality: TextureQuality;
  /** Interface scale chosen in Options (desktop app; see uiScale.ts). */
  uiScale: number;
  quitPrompt: boolean;
  jobCard: JobCard | null;
  specialistCard: { type: SpecialistJob['type']; personId: ID | null } | null;
  pickMode: PickMode;
  overlays: OverlayKind[];
  organizerCollapsed: boolean;
  sheet: OrganizerSheet;
  /** What the boss looks at while planning: the blueprint plan, or the city itself. */
  planningView: 'plan' | 'city';

  speed: number;
  paused: boolean;
  finishingWeek: boolean;
  savingToQuit: boolean;
  /** The menu's attract mode: an autopilot city that is never saved or scored. */
  attract: boolean;
  savingSnapshot: boolean;
  loadingSave: string | null;
  /** Covers order dispatch and the first prepared street frame; never saved. */
  streetLoading: boolean;
  setStreetLoading: (loading: boolean) => void;
  messageFilter: Record<MessageCategory, boolean>;
  messageBox: MessageCategory | null;
  /** When on, incoming messages no longer slow the clock. */
  messageOverride: boolean;
  toast: { text: string; bad: boolean; at: number } | null;
  /** Centre the main view here; an optional zoom (e.g. Rooftop for a precise pick). */
  cameraRequest: (Vec2 & { zoom?: number }) | null;
  selectedStreetIds: ID[];
  saves: SaveSlot[];
  savesError: string | null;

  // actions
  setScreen: (s: Screen) => void;
  setOptions: (o: Partial<GameOptions>) => void;
  startGame: (o: GameOptions) => void;
  startAttract: () => void;
  attractWeek: () => void;
  endAttract: () => void;
  /** Resolves true only if this request installs its independent saved world. */
  loadFromSlot: (slot: SaveSlot) => Promise<boolean>;
  cancelLoad: () => void;
  refreshSaves: () => Promise<void>;
  save: (name: string) => Promise<void>;
  bump: () => void;
  launchWeek: () => Promise<void>;
  /** Skip to Friday: finish the week and put the city away for Monday. */
  finishWeek: () => Promise<void>;
  cancelFinishWeek: () => void;
  advance: (seconds: number) => void;

  setTab: (t: OrganizerTab) => void;
  recordTutorialVisit: (view: 'lieutenantsViewed' | 'reportsViewed') => void;
  selectTeam: (id: ID | null) => void;
  selectBuilding: (id: ID | null) => void;
  selectPerson: (id: ID | null) => void;
  /** Select without opening a Tagged Window (the number keys cycling a crew). */
  focusPerson: (id: ID | null) => void;
  tagPerson: (id: ID) => void;
  closeTaggedPerson: (id: ID) => void;
  clearTaggedWindows: () => void;
  /** Replace the street selection with these of your own people. */
  selectPeople: (ids: ID[]) => void;
  /** Add one of your own people to the street selection, or drop them from it. */
  togglePersonSelected: (id: ID) => void;
  setHelpOpen: (open: boolean) => void;
  setAutoLowerRoofs: (on: boolean) => void;
  setRoadNames: (on: boolean) => void;
  setMouseReversal: (on: boolean) => void;
  setTextureQuality: (quality: TextureQuality) => void;
  setUiScale: (scale: number) => void;
  togglePoliceAreaBlock: (id: ID) => void;
  clearPoliceArea: () => void;
  setReviewOrder: (id: ID | null) => void;
  setQuitPrompt: (open: boolean) => void;
  toggleOverlay: (o: OverlayKind) => void;
  setOrganizerCollapsed: (v: boolean) => void;
  setOverlays: (o: OverlayKind[]) => void;
  setSheet: (s: OrganizerSheet) => void;
  setPlanningView: (v: 'plan' | 'city') => void;

  beginOrder: (type: OrderType, teamId: ID) => void;
  beginSpecialistOrder: (type: SpecialistJob['type'], personId?: ID) => void;
  selectSpecialistTarget: (personId: ID | null) => void;
  cancelSpecialistCard: () => void;
  updateJobCard: (patch: Partial<JobCard>) => void;
  updateJobOpts: (patch: Partial<OrderOptions>) => void;
  cancelJobCard: () => void;
  toggleJobTargetBuilding: (id: ID) => void;
  toggleJobTargetBlock: (id: ID) => void;

  setPickMode: (m: PickMode) => void;
  setSelectedStreetIds: (ids: ID[]) => void;

  setSpeed: (s: number) => void;
  speedUp: () => void;
  speedDown: () => void;
  setPaused: (p: boolean) => void;
  toggleMessageFilter: (c: MessageCategory) => void;
  setMessageBox: (c: MessageCategory | null) => void;
  toggleMessageOverride: () => void;
  autosave: (responsive?: boolean) => Promise<boolean>;
  saveAndQuit: () => Promise<void>;

  notify: (r: ApiResult | string | undefined) => void;
  clearToast: () => void;
  requestCamera: (p: (Vec2 & { zoom?: number }) | null) => void;
  /** Centre the map on a person, where this gang's map can place him. */
  centreOnPerson: (id: ID) => void;
}

/** An area selection the crew has not got the time for loses its farthest
 * sites, as the original's does, and says how many were left off. */
function fitJobCard(sim: Sim | null, jc: JobCard, refit = false): JobCard {
  const { trimmed: _previous, ...card } = jc;
  // A new selection is what the player asked for; a refit (manpower changed)
  // starts again from it, so sites left off can come back.
  if (refit && card.requested) { card.buildingIds = [...card.requested.buildingIds]; card.blockIds = [...card.requested.blockIds]; }
  else card.requested = { buildingIds: [...card.buildingIds], blockIds: [...card.blockIds] };
  if (!sim) return card;
  const editing = card.editingOrderId != null ? sim.world.orders[card.editingOrderId]?.estimatedMinutes ?? 0 : 0;
  const fit = fitAreaToWeek(sim.world, sim.playerGang.id, card, editing);
  if (!fit || !fit.buildingIds.length) return card;
  return { ...card, buildingIds: fit.buildingIds, blockIds: [], trimmed: { dropped: fit.dropped, total: fit.total } };
}

const endingUi = {
  screen: 'gameOver', streetLoading: false, finishingWeek: false, paused: true,
  jobCard: null, specialistCard: null, pickMode: null, sheet: null, organizerCollapsed: false,
} satisfies Partial<GameState>;

function readMouseReversal(): boolean {
  try { return localStorage.getItem('og.mouseReversal') === '1'; } catch { return false; }
}

function readRoadNames(): boolean {
  try { return localStorage.getItem('og.roadNames') === '1'; } catch { return false; }
}

function readAutoLower(): boolean {
  try {
    return automaticRoofsPreference(localStorage.getItem('og.autoLowerRoofs'));
  } catch {
    return true;
  }
}

// A stopped run must stay stopped even if another starts before its timer wakes.
let finishRun = 0;
let saveRefreshRequest = 0;
let activeLoad: AbortController | null = null;

/** Only persistent preferences (roof setting and message filters) survive. */
function freshWorldUi() {
  return {
    organizerTab: 'lieutenants' as const,
    selectedBuildingId: null, selectedPersonId: null, selectedPersonIds: [] as ID[], taggedPersonIds: [] as ID[],
    selectedStreetIds: [] as ID[], policeAreaBlockIds: [] as ID[], reviewOrderId: null,
    helpOpen: false, quitPrompt: false, jobCard: null, specialistCard: null, pickMode: null, messageBox: null,
    overlays: ['territory'] as OverlayKind[], organizerCollapsed: false,
    sheet: null, planningView: 'plan' as const, speed: 1, paused: false,
    finishingWeek: false, savingToQuit: false, savingSnapshot: false, loadingSave: null, streetLoading: false, messageOverride: false, toast: null, cameraRequest: null,
  };
}

export const useGame = create<GameState>((set, get) => ({
  sim: null,
  version: 0,
  worldSession: 0,
  screen: 'menu',
  options: newCampaignOptions(),

  organizerTab: 'lieutenants',
  selectedTeamId: null,
  selectedBuildingId: null,
  selectedPersonId: null,
  selectedPersonIds: [],
  taggedPersonIds: [],
  policeAreaBlockIds: [],
  reviewOrderId: null,
  helpOpen: false,
  autoLowerRoofs: readAutoLower(),
  roadNames: readRoadNames(),
  mouseReversal: readMouseReversal(),
  textureQuality: readTextureQuality(),
  uiScale: readUiScale(),
  quitPrompt: false,
  jobCard: null,
  specialistCard: null,
  pickMode: null,
  overlays: ['territory'],
  organizerCollapsed: false,
  sheet: null,
  planningView: 'plan',

  speed: 1,
  paused: false,
  finishingWeek: false,
  savingToQuit: false,
  attract: false,
  savingSnapshot: false,
  loadingSave: null,
  streetLoading: false,
  setStreetLoading: (streetLoading) => set({ streetLoading }),
  messageFilter: { combat: true, police: true, failed: true, waiting: true },
  messageBox: null,
  setMessageBox: (messageBox) => set({messageBox}),
  messageOverride: false,
  toast: null,
  cameraRequest: null,
  selectedStreetIds: [],
  saves: [],
  savesError: null,

  setScreen: (screen) => {
    get().cancelLoad();
    // New Game after a lesson or scenario starts an ordinary campaign: the
    // lesson's hidden id (and its fixed city and easy settings) came along
    // under a "Full Game" heading. The boss's own details are kept.
    const o = get().options;
    const fresh = screen === 'newGame' && (o.tutorialId != null || o.scenarioId != null)
      ? { options: { ...newCampaignOptions(), seed: defaultGameOptions().seed, playerName: o.playerName, playerNickname: o.playerNickname,
          playerHeritage: o.playerHeritage, playerSitter: o.playerSitter, playerFemale: o.playerFemale,
          playerPortrait: o.playerPortrait, playerColor: o.playerColor } }
      // Every new game gets a new city; the seed box can still bring one back.
      : screen === 'newGame' ? { options: { ...o, seed: defaultGameOptions().seed } }
      : {};
    set({ screen, ...fresh, ...(screen !== 'game' ? { streetLoading: false } : {}) });
  },
  setOptions: (o) => set({ options: { ...get().options, ...o } }),

  startGame: (options) => {
    get().cancelLoad();
    const sim = new Sim(options);
    const player = sim.playerGang;
    set({
      ...freshWorldUi(),
      // Every new game opens planning on the crew page; later weeks open with news.
      organizerTab: 'lieutenants',
      sim,
      options,
      screen: sim.world.phase === 'gameOver' ? 'gameOver' : 'game',
      version: 1,
      worldSession: get().worldSession + 1,
      selectedTeamId: player.teamIds[0] ?? null,
      attract: false,
    });
  },

  // Attract mode (the original's demo, byte_7C0084): left idle on the menu, the
  // game runs a city on autopilot, every gang planned by the computer, at
  // speed. It never touches the Autosave, the Hall of Fame or tutorial records.
  startAttract: () => {
    if (get().screen !== 'menu' || get().loadingSave != null) return;
    const names = ['Sal Benedetto', 'Frankie Doyle', 'Mo Kaplan', 'Vito Russo', 'Eddie Malone'];
    const options: GameOptions = { ...newCampaignOptions(), seed: defaultGameOptions().seed,
      playerName: names[Math.floor(Math.random() * names.length)], playerPortrait: Math.floor(Math.random() * 8) };
    const sim = new Sim(options);
    set({
      ...freshWorldUi(),
      sim, screen: 'game', attract: true, version: 1, worldSession: get().worldSession + 1,
      selectedTeamId: null, speed: SPEED_STAGES[SPEED_STAGES.length - 2], paused: false, organizerCollapsed: true,
    });
    get().attractWeek();
  },

  attractWeek: () => {
    const sim = get().sim;
    if (!get().attract || !sim || sim.world.phase !== 'planning' || get().streetLoading) return;
    planGang(sim.world, sim.rng, sim.playerGang, true);
    set({ streetLoading: true });
    sim.launchWeek();
    if ((sim.world.phase as Sim['world']['phase']) !== 'week') { get().endAttract(); return; }
    set({ version: get().version + 1, organizerCollapsed: true });
  },

  endAttract: () => {
    if (!get().attract) return;
    set({ ...freshWorldUi(), sim: null, attract: false, screen: 'menu', streetLoading: false, speed: 1, paused: false,
      worldSession: get().worldSession + 1, version: get().version + 1 });
  },

  cancelLoad: () => {
    activeLoad?.abort();
    activeLoad = null;
    if (get().loadingSave != null) set({ loadingSave: null });
  },

  loadFromSlot: async (slot) => {
    activeLoad?.abort();
    const request = new AbortController();
    activeLoad = request;
    const worldSession = get().worldSession;
    set({ loadingSave: slot.name, toast: null });
    try {
      if (slot.error) throw Error(slot.error);
      // Paint the cancellable loading dialog before reading, cloning and validating.
      await yieldForInput();
      if (request.signal.aborted) return false;
      // A slot listed from its header is read from disk now.
      slot = await loadSlotWorld(slot);
      if (request.signal.aborted) return false;
      if (!slot.world || slot.error) throw Error(slot.error ?? "This save is unavailable.");
      // Clone: Sim.fromSave keeps the object it is handed, and the slot in this
      // store would otherwise become the live world — so loading the same slot
      // twice would restore nothing.
      const snapshot = await cloneSavedWorldResponsive(slot.world, request.signal);
      const sim = await Sim.fromSaveResponsive(snapshot, request.signal);
      // A newer load, new game or navigation must win over this request.
      if (activeLoad !== request || request.signal.aborted || get().worldSession !== worldSession) return false;
      const player = sim.playerGang;
      set({
        ...freshWorldUi(),
        sim,
        options: snapshot.options,
        screen: snapshot.phase === 'gameOver' ? 'gameOver' : 'game',
        version: get().version + 1,
        worldSession: get().worldSession + 1,
        selectedTeamId: player.teamIds[0] ?? null,
      });
      return true;
    } catch (error) {
      if (activeLoad === request && !request.signal.aborted) {
        set({ toast: { text: error instanceof Error ? error.message : 'This save could not be loaded.', bad: true, at: Date.now() } });
      }
      return false;
    } finally {
      if (activeLoad === request) {
        activeLoad = null;
        set({ loadingSave: null });
      }
    }
  },

  refreshSaves: async () => {
    const request = ++saveRefreshRequest;
    try {
      const saves = await loadGame();
      if (request === saveRefreshRequest) set({ saves, savesError: null });
    } catch {
      if (request === saveRefreshRequest) set({ savesError: 'Saved games could not be read. Retry, or check the save folder.' });
    }
  },

  save: async (raw) => {
    const sim = get().sim;
    if (!sim || get().savingSnapshot) return;
    const name = raw.trim();
    const refuse = (text: string) => set({ toast: { text, bad: true, at: Date.now() } });
    if (!name) return refuse('Give the save a name first.');
    if (name.toLowerCase() === 'autosave') return refuse('"Autosave" is kept for the automatic save. Choose another name.');
    if (name.length > SAVE_NAME_MAX) return refuse(`Save names can be at most ${SAVE_NAME_MAX} characters.`);
    try {
      captureTutorialProgress(sim.world);
      sim.settleDeferred();
      await saveGame(name, sim.world);
      set({ toast: { text: `Saved as "${name}".`, bad: false, at: Date.now() } });
      await get().refreshSaves();
    } catch {
      set({
        toast: {
          text: 'The game could not be saved — the save could not be written.',
          bad: true,
          at: Date.now(),
        },
      });
    }
  },

  bump: () => {
    const sim = get().sim;
    if (get().attract && sim?.world.phase === 'gameOver') { get().endAttract(); return; }
    if (sim) captureTutorialProgress(sim.world);
    const mode = get().pickMode;
    const staleArea = mode?.kind === 'lieutenantArea' &&
      (!sim || !sim.playerGang.teamIds.includes(mode.teamId) || !sim.world.teams[mode.teamId]);
    set({ version: get().version + 1, ...(staleArea ? { pickMode: null } : {}),
      ...(sim?.world.phase === 'gameOver' && get().screen === 'game' ? endingUi : {}) });
  },

  launchWeek: async () => {
    const sim = get().sim;
    if (!sim || sim.world.phase !== 'planning' || get().streetLoading || get().savingSnapshot || get().loadingSave != null) return;
    set({ streetLoading: true });
    try {
      await yieldForPaint();
      if (get().sim !== sim || get().screen !== 'game' || !get().streetLoading) return;
      // Snapshot the committed planning orders before launch assigns people and
      // clears reports. Reloading this boundary returns to the same Monday plan.
      await get().autosave(true);
      if (get().sim !== sim || get().screen !== 'game' || !get().streetLoading) return;
      if (get().loadingSave != null) { set({ streetLoading: false }); return; }
      sim.launchWeek();
      if ((sim.world.phase as Sim['world']['phase']) === 'gameOver') {
        get().bump();
        await get().autosave(true);
        return;
      }
      captureTutorialProgress(sim.world);
      // A job card or an allocation mode left open would silently swallow every
      // map click for the whole week.
      set({
        taggedPersonIds: [],
        jobCard: null,
        pickMode: null,
        organizerCollapsed: false,
        sheet: null,
        version: get().version + 1,
      });
    } catch (error) {
      if (get().sim !== sim) return;
      set({ streetLoading: false });
      get().notify({ ok: false, error: error instanceof Error ? error.message : 'The working week could not be opened. Please try again.' });
    }
  },

  // Opening the page already shown (C/H/V/W, or a crew number) keeps a job
  // card in progress; only leaving the page puts it away.
  setTab: (organizerTab) => set(s => s.organizerTab === organizerTab
    ? { organizerCollapsed: false, sheet: null }
    : { organizerTab, jobCard: null, specialistCard: null, pickMode: null, organizerCollapsed: false, sheet: null }),
  recordTutorialVisit: (view) => {
    const w = get().sim?.world;
    if (!w || w.options.tutorialId !== 1 || w.phase !== 'planning') return;
    if (view === 'reportsViewed' && w.week <= 1) return;
    if (w.tutorialActions?.[view]) return;
    (w.tutorialActions ??= {})[view] = true;
    get().bump();
  },
  selectTeam: (selectedTeamId) => {
    const { sim, pickMode } = get();
    if (pickMode?.kind !== 'lieutenantArea') { set({ selectedTeamId }); return; }
    const valid = selectedTeamId != null && sim?.playerGang.teamIds.includes(selectedTeamId) && sim.world.teams[selectedTeamId];
    set({ selectedTeamId, pickMode: valid ? { kind: 'lieutenantArea', teamId: selectedTeamId! } : null });
  },
  selectBuilding: (selectedBuildingId) => set({ selectedBuildingId, selectedPersonId: null }),
  selectPerson: (selectedPersonId) => {
    get().focusPerson(selectedPersonId);
    if (selectedPersonId != null) get().tagPerson(selectedPersonId);
  },
  focusPerson: (selectedPersonId) =>
    set({ selectedPersonId, selectedBuildingId: null, selectedPersonIds: selectedPersonId != null ? [selectedPersonId] : [] }),
  tagPerson: (id) => {
    const {sim, taggedPersonIds} = get();
    const person = sim?.world.people[id];
    if (sim?.world.phase !== 'week' || !person || bossInsideOffice(person) || taggedPersonIds.includes(id)) return;
    set({taggedPersonIds: [...taggedPersonIds, id]});
  },
  closeTaggedPerson: (id) => set(s => ({taggedPersonIds: s.taggedPersonIds.filter(p => p !== id)})),
  clearTaggedWindows: () => set({taggedPersonIds: []}),
  selectPeople: (ids) => set({ selectedPersonIds: ids, selectedPersonId: ids[ids.length - 1] ?? null, selectedBuildingId: null }),
  togglePersonSelected: (id) => {
    const cur = get().selectedPersonIds;
    const ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set({ selectedPersonIds: ids, selectedPersonId: ids[ids.length - 1] ?? null, selectedBuildingId: null });
  },
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setTextureQuality: (textureQuality) => {
    writeTextureQuality(textureQuality);
    set({ textureQuality });
  },
  setUiScale: (uiScale) => {
    writeUiScale(uiScale);
    set({ uiScale });
    applyUiScale(uiScale);
  },
  setMouseReversal: (mouseReversal) => {
    try { localStorage.setItem('og.mouseReversal', mouseReversal ? '1' : '0'); } catch { /* session only */ }
    set({ mouseReversal });
  },
  setRoadNames: (roadNames) => {
    try { localStorage.setItem('og.roadNames', roadNames ? '1' : '0'); } catch { /* session only */ }
    set({ roadNames });
  },
  setAutoLowerRoofs: (autoLowerRoofs) => {
    try {
      localStorage.setItem('og.autoLowerRoofs', autoLowerRoofs ? '1' : '0');
    } catch {
      /* no storage: the setting lasts the session */
    }
    set({ autoLowerRoofs });
  },
  togglePoliceAreaBlock: (id) => {
    const cur = get().policeAreaBlockIds;
    set({ policeAreaBlockIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  clearPoliceArea: () => set({ policeAreaBlockIds: [] }),
  setReviewOrder: (reviewOrderId) => set({ reviewOrderId }),
  setQuitPrompt: (quitPrompt) => set({ quitPrompt }),

  toggleOverlay: (o) => {
    const { overlays: cur, sim, pickMode, selectedTeamId, jobCard, specialistCard } = get();
    if (o === 'lieutenant' && sim?.world.phase === 'planning' && !jobCard && !specialistCard) {
      if (pickMode?.kind === 'lieutenantArea') {
        set({ pickMode: null, overlays: cur.filter(id => id !== 'lieutenant') });
        return;
      }
      const teamId = selectedTeamId != null && sim.playerGang.teamIds.includes(selectedTeamId)
        ? selectedTeamId : sim.playerGang.teamIds[0];
      if (teamId == null || !sim.world.teams[teamId]) { get().notify('Promote a lieutenant before allocating territory.'); return; }
      set({ selectedTeamId: teamId, pickMode: { kind: 'lieutenantArea', teamId },
        overlays: cur.includes(o) ? cur : [...cur, o] });
      return;
    }
    // The map draws one colour wash at a time, so turning one on turns the
    // others off; territory and a lieutenant's area still stack on top.
    const next = cur.includes(o) ? cur.filter((x) => x !== o)
      : [...cur.filter((x) => !HEAT_OVERLAYS.includes(x) || !HEAT_OVERLAYS.includes(o)), o];
    set({ overlays: next });
  },
  setOverlays: (overlays) => set({ overlays,
    ...(get().pickMode?.kind === 'lieutenantArea' && !overlays.includes('lieutenant') ? { pickMode: null } : {}) }),
  setOrganizerCollapsed: (organizerCollapsed) => set({ organizerCollapsed }),
  setSheet: (sheet) => set({ sheet }),
  setPlanningView: (planningView) => set({ planningView }),

  beginOrder: (type, teamId) => {
    set({ specialistCard: null });
    const sim = get().sim;
    const allocated = sim && (type === 'patrol' || type === 'collectProtection')
      ? sim.world.teams[teamId]?.allocatedBlockIds ?? [] : [];
    set({
      // Configure the order in the journal; "Pick on map" folds it away when needed.
      organizerCollapsed: false,
      // The orders list makes way for the map the targets are picked on.
      sheet: null,
      jobCard: {
        type,
        teamId,
        buildingIds: [],
        blockIds: [...allocated],
        personId: null,
        pos: null,
        opts: {
          repeat: false,
          isPublic: false,
          priority: false,
          manpower: 1,
          wait: false,
          preferredHoodId: null,
          protectionLevel: 1,
          // Bribes have an adjustable offer; donations are quoted for the chosen charity.
          amount: type === 'bribe' ? 1000 : undefined,
        },
      },
      pickMode: { kind: 'order' },
    });
    const card = get().jobCard;
    if (sim && card) set({ jobCard: { ...card, ...addOrderBlocks(sim.world, sim.playerGang.id, { ...card, blockIds: [] }, allocated) } });
  },

  updateJobCard: (patch) => {
    const jc = get().jobCard;
    if (!jc) return;
    const next = { ...jc, ...patch };
    // A different site for a business: the type and front chosen for the old
    // one may not suit it (a legal lot, another block).
    if (jc.type === 'setUpBusiness' && !patch.opts && jc.buildingIds.length && patch.buildingIds && patch.buildingIds[0] !== jc.buildingIds[0]) {
      const { businessTypeId: _type, frontBuildingId: _front, ...opts } = jc.opts;
      next.opts = opts;
    }
    set({ jobCard: 'buildingIds' in patch || 'blockIds' in patch ? fitJobCard(get().sim, next) : next });
  },

  updateJobOpts: (patch) => {
    const jc = get().jobCard;
    if (!jc) return;
    const next = { ...jc, opts: { ...jc.opts, ...patch } };
    set({ jobCard: 'manpower' in patch ? fitJobCard(get().sim, next, true) : next });
  },

  cancelJobCard: () => set({ jobCard: null, pickMode: null, organizerCollapsed: false }),
  beginSpecialistOrder: (type, personId) => set({ specialistCard: { type, personId: personId ?? null }, jobCard: null,
    pickMode: { kind: type === 'employPolice' && personId == null ? 'policeArea' : 'specialist' },
    policeAreaBlockIds: [], sheet: null, organizerCollapsed: false }),
  selectSpecialistTarget: (personId) => {
    const { sim, specialistCard } = get();
    if (!sim || !specialistCard) return;
    if (personId != null && (!sim.world.people[personId] || !specialistTargetEligible(sim.world, sim.playerGang.id, specialistCard.type, sim.world.people[personId]))) return;
    set({ specialistCard: { ...specialistCard, personId } });
    if (personId != null) get().requestCamera({ ...sim.world.people[personId].pos });
  },
  cancelSpecialistCard: () => set({ specialistCard: null, pickMode: null, policeAreaBlockIds: [], organizerCollapsed: false }),

  toggleJobTargetBuilding: (id) => {
    const { jobCard: jc, sim } = get();
    if (!jc || !sim) return;
    const asked = { ...jc, ...jc.requested };
    set({ jobCard: fitJobCard(sim, { ...jc, ...toggleOrderSite(sim.world, sim.playerGang.id, asked, id) }) });
  },

  toggleJobTargetBlock: (id) => {
    const { jobCard: jc, sim } = get();
    if (!jc || !sim) return;
    const asked = { ...jc, ...jc.requested };
    set({ jobCard: fitJobCard(sim, { ...jc, ...toggleOrderBlock(sim.world, sim.playerGang.id, asked, id) }) });
  },

  setPickMode: (pickMode) => set({ pickMode }),
  setSelectedStreetIds: (selectedStreetIds) => set({ selectedStreetIds }),

  setSpeed: (speed) => set({ speed: nearestStage(speed) }),
  speedUp: () => set({ speed: SPEED_STAGES[Math.min(SPEED_STAGES.length - 1, stageIndex(get().speed) + 1)] }),
  speedDown: () => set({ speed: SPEED_STAGES[Math.max(0, stageIndex(get().speed) - 1)] }),
  setPaused: (paused) => {
    if (get().savingToQuit || get().savingSnapshot) return;
    if (get().finishingWeek) get().cancelFinishWeek();
    else set({ paused });
  },
  toggleMessageFilter: (c) =>
    set({ messageFilter: { ...get().messageFilter, [c]: !get().messageFilter[c] } }),
  toggleMessageOverride: () => set({ messageOverride: !get().messageOverride }),

  advance: (seconds) => {
    const state = get();
    const sim = state.sim;
    if (sim?.world.phase === 'gameOver' && state.screen === 'game') { get().bump(); return; }
    if (!sim || sim.world.phase !== 'week' || state.streetLoading || state.paused || state.finishingWeek || state.savingToQuit || state.savingSnapshot || state.loadingSave != null || state.screen !== 'game') return;
    // A report the player asked to be slowed for drops time to normal on the
    // tick it arrives, not when the HUD next redraws (up to 0.2 s of flat out).
    const seen = sim.world.messages.at(-1)?.id ?? 0;
    const reported = () => {
      if (state.messageOverride || state.speed === 1) return false;
      const messages = sim.world.messages;
      for (let i = messages.length - 1; i >= 0 && messages[i].id > seen; i--) if (state.messageFilter[messages[i].category]) return true;
      return false;
    };
    if (isFlatOut(state.speed)) sim.runFlatOut(FLAT_OUT_BUDGET_MS, reported);
    else sim.advance(seconds, state.speed, 8);
    if (reported()) get().setSpeed(1);
    if (sim.world.phase !== 'week') {
      if (get().attract) {
        if (sim.world.phase === 'gameOver') get().endAttract();
        else { get().bump(); get().attractWeek(); }
        return;
      }
      get().bump();
      if (sim.world.phase === 'gameOver') set({ screen: 'gameOver' });
      else get().setTab('newspaper');
      void get().autosave(true);
    }
  },

  // Not offered to the player (the original has no End Week; maximum speed runs
  // flat out). Kept for tools and tests that need to finish a week quickly.
  finishWeek: async () => {
    const sim = get().sim;
    if (sim?.world.phase === 'gameOver' && get().screen === 'game') { get().bump(); return; }
    if (!sim || sim.world.phase !== 'week' || get().streetLoading || get().finishingWeek || get().savingToQuit || get().savingSnapshot || get().loadingSave != null) return;
    const run = ++finishRun;
    set({ finishingWeek: true, paused: true });
    let lastUi = performance.now();
    // Yield even the first batch so the busy/cancel control can paint.
    while (sim.world.phase === 'week') {
      await yieldForInput();
      if (run !== finishRun || get().sim !== sim || !get().finishingWeek || get().screen !== 'game') return;
      if (get().loadingSave != null) continue;
      sim.finishWeekSlice();
      if (performance.now() - lastUi >= 200 || sim.world.phase !== 'week') {
        get().bump();
        lastUi = performance.now();
      }
    }
    if (sim.world.phase === 'planning') get().setTab('newspaper');
    set({ finishingWeek: false, paused: false, screen: sim.world.phase === 'gameOver' ? 'gameOver' : 'game' });
    await get().autosave(true);
  },

  cancelFinishWeek: () => set({ finishingWeek: false, paused: true }),

  autosave: async (responsive = false) => {
    const sim = get().sim;
    if (!sim || get().savingSnapshot) return false;
    // The attract city is a demonstration; the player's Autosave is never touched.
    if (get().attract) return true;
    if (responsive) set({ savingSnapshot: true });
    try {
      captureTutorialProgress(sim.world);
      sim.settleDeferred();
      await saveGame('Autosave', sim.world, responsive);
      if (get().sim === sim) get().notify('The city has been put away in the Autosave slot.');
      return true;
    } catch {
      if (get().sim === sim) get().notify({ ok: false, error: 'Autosave failed — the save could not be written. Your city is still open; try saving again.' });
      return false;
    } finally {
      if (responsive && get().sim === sim) set({ savingSnapshot: false });
    }
  },

  saveAndQuit: async () => {
    if (get().savingToQuit || get().savingSnapshot) return;
    const sim = get().sim;
    const paused = get().paused;
    set({ paused: true, finishingWeek: false, savingToQuit: true, quitPrompt: false });
    const saved = await get().autosave();
    if (get().sim !== sim) return;
    if (saved) set({ screen: 'menu', savingToQuit: false });
    else set({ paused, savingToQuit: false });
  },

  notify: (r) => {
    if (r == null) return; // An action may be deferred while settlement/saving holds the world.
    if (typeof r === 'string') {
      set({ toast: { text: r, bad: false, at: Date.now() } });
      return;
    }
    if (r.ok) {
      if (r.message) set({ toast: { text: r.message, bad: false, at: Date.now() } });
    } else {
      set({ toast: { text: r.error, bad: true, at: Date.now() } });
    }
  },
  clearToast: () => set({ toast: null }),
  requestCamera: (cameraRequest) => set({ cameraRequest }),
  centreOnPerson: (id) => {
    const sim = get().sim, p = sim?.world.people[id];
    if (!sim || !p) return;
    const at = personMapPosition(sim.world, sim.playerGang.id, p);
    if (at) get().requestCamera({ ...at }); else get().notify(`You do not know where ${p.name} is.`);
  },
}));

/** Longest name a manual save may have (the disk store allows 200). */
export const SAVE_NAME_MAX = 60;

/** Run a mutation against the sim and refresh the UI. */
export function act<T>(fn: (sim: Sim) => T): T | undefined {
  const { sim, bump, savingSnapshot, loadingSave, streetLoading } = useGame.getState();
  if (!sim || sim.world.settlementStage != null || savingSnapshot || loadingSave != null || streetLoading) return undefined;
  observeTargetRace(sim.world, undefined, 'boundary');
  if (sim.resolveImmediateOutcome()) { bump(); return undefined; }
  recordScorePeaks(sim.world);
  const result = applyLiveMovement(sim.world, sim.subMinute, () => fn(sim));
  recordScorePeaks(sim.world);
  observeTargetRace(sim.world, undefined, 'boundary');
  sim.resolveImmediateOutcome();
  bump();
  return result;
}
