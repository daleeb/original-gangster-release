import { useEffect, useState } from 'react';
import { SAVE_NAME_MAX, useGame } from '../../app/store';
import { slotLoadable } from '../../app/save';
import { useSaveActions } from '../saveActions';
import { cameraApi } from '../CityView';
import { describeMode } from '../../app/newGame';
import { audio } from '../../audio/audio';
import { GO_STRAIGHT_ASSETS } from '../../sim/constants';
import { gangAssets, gangWealth, money, powerRating, territoryCount } from '../../sim/world';
import { ConfirmDialog, Empty, Panel } from '../common';
import { UI_SCALES, uiScaleAvailable, uiScaleInUse } from '../../app/uiScale';
import { downloadDebugFile } from '../../app/debugFile';

/** Interface size: zooms the whole desktop window; a browser has its own zoom. */
function InterfaceSize() {
  const uiScale = useGame((s) => s.uiScale);
  const setUiScale = useGame((s) => s.setUiScale);
  const [inUse, setInUse] = useState(uiScaleInUse);
  useEffect(() => {
    const update = () => setInUse(uiScaleInUse());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [uiScale]);
  const percent = (scale: number) => `${Math.round(scale * 100)}%`;

  if (!uiScaleAvailable()) {
    return (
      <div className="muted tiny" style={{ marginTop: 8 }}>
        Interface size: use your browser's zoom (Ctrl + and Ctrl −, or ⌘ + and ⌘ − on a Mac).
      </div>
    );
  }
  return (
    <>
      <div className="tiny" style={{ marginTop: 10 }}>Interface size</div>
      <div className="row" role="group" aria-label="Interface size" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
        {UI_SCALES.map((scale) => (
          <button key={scale} aria-pressed={uiScale === scale} className={`btn sm${uiScale === scale ? ' on' : ''}`}
            onClick={() => setUiScale(scale)}>
            {percent(scale)}
          </button>
        ))}
      </div>
      <div className="muted tiny" style={{ marginTop: 6 }}>
        {Math.abs(inUse - uiScale) > 0.001
          ? `This window has room for ${percent(inUse)}; ${percent(uiScale)} applies when the window is larger.`
          : 'Scales menus, panels and text, for large or high-resolution screens.'}
      </div>
    </>
  );
}

export function OptionsTab() {
  const sim = useGame((s) => s.sim)!;
  const save = useGame((s) => s.save);
  const saves = useGame((s) => s.saves);
  const savesError = useGame(s => s.savesError);
  const refreshSaves = useGame((s) => s.refreshSaves);
  const loadFromSlot = useGame((s) => s.loadFromSlot);
  const setScreen = useGame((s) => s.setScreen);
  const autoLowerRoofs = useGame((s) => s.autoLowerRoofs);
  const roadNames = useGame((s) => s.roadNames);
  const mouseReversal = useGame((s) => s.mouseReversal);
  const textureQuality = useGame((s) => s.textureQuality);
  const bureauGauges = useGame((s) => s.bureauGauges);
  const setRoadNames = useGame((s) => s.setRoadNames);
  const setAutoLowerRoofs = useGame((s) => s.setAutoLowerRoofs);
  const startGame = useGame((s) => s.startGame);
  const [quit, setQuit] = useState<null | 'restart' | 'fresh' | 'menu'>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  const { busy, exportSlot, setDeleting, importControl, feedback, confirmation } = useSaveActions();
  useGame((s) => s.version);

  const w = sim.world;
  const gang = sim.playerGang;
  const [name, setName] = useState(`${w.people[gang.bossId]?.name ?? 'Boss'} — Week ${w.week}`);
  const [music, setMusic] = useState(audio.musicVolume);
  const [menuMusic, setMenuMusic] = useState(audio.menuMusic);
  const [gameMusic, setGameMusic] = useState(audio.gameMusic);
  const [sfx, setSfx] = useState(audio.sfxVolume);

  useEffect(() => {
    void refreshSaves();
  }, [refreshSaves]);

  return (
    <div>
      <Panel title="Objectives">
        <div className="muted tiny" style={{ marginBottom: 8 }}>
          {describeMode(w.options)}
        </div>
        {Object.values(w.gangs).map((g) => (
          <div key={g.id} className="kv">
            <span>
              {g.name}
              {g.isPlayer && ' (you)'}
              {g.eliminated && ' — wiped out'}
            </span>
            <b>
              {w.options.mode === 'wealth'
                ? money(gangWealth(w, g))
                : w.options.mode === 'territory'
                  ? `${territoryCount(w, g.id)} blocks`
                  : `power ${powerRating(w, g)}`}
            </b>
          </div>
        ))}
        {w.options.mode === 'normal' && (
          <div className="muted tiny" style={{ marginTop: 8 }}>
            Going straight needs {money(GO_STRAIGHT_ASSETS)} in assets excluding cash, no illegal businesses and no
            pending trials. You currently hold {money(gangAssets(w, gang))}.
          </div>
        )}
      </Panel>

      <Panel title="Save Game">
        <div className="row" style={{ gap: 6 }}>
          <input
            aria-label="Save name"
            className="text-input"
            style={{ background: '#fffdf5', color: 'var(--ink)' }}
            value={name}
            maxLength={SAVE_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn" disabled={!name.trim()} onClick={() => {
            // Saving over an existing game asks first.
            if (saves.some(s => s.id === name.trim())) setOverwrite(name.trim());
            else void save(name);
          }}>
            Save
          </button>
        </div>
        {overwrite && (
          <ConfirmDialog
            text={`Save over "${overwrite}"? The game saved under that name is replaced.`}
            onYes={() => { void save(overwrite); setOverwrite(null); }}
            onNo={() => setOverwrite(null)}
          />
        )}
      </Panel>

      <Panel title="Load Game">
        <div style={{ borderBottom: '1px dotted #bdb094', marginBottom: 4, paddingBottom: 8 }}>
          {importControl}
          {feedback}
        </div>
        {savesError && <p role="alert">{savesError} <button className="btn" onClick={() => void refreshSaves()}>Retry</button></p>}
        {saves.length === 0 && !savesError ? (
          <Empty>No saved games.</Empty>
        ) : (
          saves.map((s, index) => (
            <div key={s.id} className="row between" style={{ padding: '4px 0', borderTop: index ? '1px dotted #bdb094' : undefined, flexWrap: 'wrap', gap: 4 }}>
              <div>
                <b className="tiny">{s.name}</b>
                <div className="muted tiny">
                  {s.error ?? `${s.bossName} · Week ${s.week}`}
                </div>
              </div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={!slotLoadable(s) || busy} onClick={() => void exportSlot(s)}>Export</button>
                <button className="btn sm" disabled={!slotLoadable(s)} onClick={() => loadFromSlot(s)}>Load</button>
                <button className="btn sm red-text" onClick={() => setDeleting(s)}>Delete</button>
              </div>
            </div>
          ))
        )}
        {confirmation}
      </Panel>

      <Panel title="View">
        <button aria-pressed={autoLowerRoofs} className={`btn sm${autoLowerRoofs ? ' on' : ''}`} onClick={() => {
          setAutoLowerRoofs(!autoLowerRoofs);
          if (autoLowerRoofs) cameraApi.ref?.setHiddenRoofs(false);
        }}>
          {autoLowerRoofs ? 'Roofs drop in Street View; B hides buildings' : 'Roofs stay up; B hides buildings'}
        </button>
        <div className="muted tiny" style={{ marginTop: 6 }}>
          B removes or restores buildings so people and pavement are easier to see.
        </div>
        <button aria-pressed={roadNames} className={`btn sm${roadNames ? ' on' : ''}`} style={{ marginTop: 8 }} onClick={() => setRoadNames(!roadNames)}>
          {roadNames ? 'Street names painted on the road' : 'Street names in the header only'}
        </button>
        <div className="muted tiny" style={{ marginTop: 6 }}>
          The original names the street at the top of the view; painted names are an addition.
        </div>
        <button aria-pressed={mouseReversal} className={`btn sm${mouseReversal ? ' on' : ''}`} style={{ marginTop: 8 }}
          onClick={() => useGame.getState().setMouseReversal(!mouseReversal)}>
          {mouseReversal ? 'Mouse reversal: on' : 'Mouse reversal: off'}
        </button>
        <div className="muted tiny" style={{ marginTop: 6 }}>
          The original's Advanced Options: with it on, dragging moves the view the other way.
        </div>
        <button aria-pressed={textureQuality === 'standard'} className={`btn sm${textureQuality === 'standard' ? ' on' : ''}`} style={{ marginTop: 8 }}
          onClick={() => useGame.getState().setTextureQuality(textureQuality === 'high' ? 'standard' : 'high')}>
          {textureQuality === 'high' ? 'Textures: High (2048)' : 'Textures: Standard (1024)'}
        </button>
        <div className="muted tiny" style={{ marginTop: 6 }}>
          Standard uses a quarter of the graphics memory for people, cars and trees, for older graphics cards. It applies when the city next loads.
        </div>
        <button aria-pressed={bureauGauges} className={`btn sm${bureauGauges ? ' on' : ''}`} style={{ marginTop: 8 }}
          onClick={() => useGame.getState().setBureauGauges(!bureauGauges)}>
          {bureauGauges ? 'Bureau gauges: shown' : 'Bureau gauges: hidden'}
        </button>
        <div className="muted tiny" style={{ marginTop: 6 }}>
          The Accountant's FBI suspicion and evidence gauges, and the Suspicion graph. The original showed neither:
          hidden, you judge the heat from your own books, your crimes and who you have paid.
        </div>
        <InterfaceSize />
      </Panel>

      <Panel title="Sound">
        <div className="field">
          <label htmlFor="organizer-OptionsTab-field-1">
            Music<span className="value">{Math.round(music * 100)}%</span>
          </label>
          <input id="organizer-OptionsTab-field-1"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={music}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMusic(v);
              audio.setMusicVolume(v);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="organizer-OptionsTab-field-2">
            Effects<span className="value">{Math.round(sfx * 100)}%</span>
          </label>
          <input id="organizer-OptionsTab-field-2"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sfx}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSfx(v);
              audio.setSfxVolume(v);
            }}
          />
        </div>
        {/* Manual p.61: Play Sample, below the sound effects slider. */}
        <button className="btn sm" onClick={() => audio.gunshot()}>Play Sample</button>
        {/* The original's ambient switches: music at the menus and in the game. */}
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className={`btn sm${menuMusic ? ' on' : ''}`} aria-pressed={menuMusic}
            onClick={() => { audio.setMusicPlaces({ menuMusic: !menuMusic }); setMenuMusic(!menuMusic); }}>
            {menuMusic ? 'Menu music: On' : 'Menu music: Off'}
          </button>
          <button className={`btn sm${gameMusic ? ' on' : ''}`} aria-pressed={gameMusic}
            onClick={() => { audio.setMusicPlaces({ gameMusic: !gameMusic }); setGameMusic(!gameMusic); }}>
            {gameMusic ? 'Game music: On' : 'Game music: Off'}
          </button>
        </div>
      </Panel>

      <Panel title="Reporting a Problem">
        <div className="muted tiny" style={{ marginBottom: 8 }}>
          Version {__APP_VERSION__} (also in the bottom right corner of every screen, so it shows in screenshots). A debug
          file holds this city as it stands, your settings and your graphics details: attach it to your report so the
          problem can be looked at exactly as you saw it. It is saved to your downloads and sent nowhere.
        </div>
        <button className="btn" onClick={() => {
          const state = useGame.getState();
          void downloadDebugFile(sim, {
            organizerTab: state.organizerTab, planningView: state.planningView, overlays: state.overlays, pickMode: state.pickMode,
            jobCard: state.jobCard, specialistCard: state.specialistCard, sheet: state.sheet, selectedTeamId: state.selectedTeamId,
            selectedBuildingId: state.selectedBuildingId, speed: state.speed, paused: state.paused, uiScale: state.uiScale,
            textureQuality: state.textureQuality,
          }).then((name) => state.notify(`Debug file saved as ${name}.`),
            () => state.notify({ ok: false, error: 'The debug file could not be written.' }));
        }}>
          Save a debug file
        </button>
      </Panel>

      <Panel title="Quit">
        <div className="muted tiny" style={{ marginBottom: 8 }}>
          Restart puts the same city back to Monday of week one; a new city rolls fresh streets with the same
          settings. Either way this game is lost unless you have saved it.
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setQuit('restart')}>
            Restart this city
          </button>
          <button className="btn" onClick={() => setQuit('fresh')}>
            Start a new city
          </button>
          <button className="btn danger" onClick={() => setQuit('menu')}>
            Back to the main menu
          </button>
        </div>
        {quit && (
          <ConfirmDialog
            text={
              quit === 'restart'
                ? 'Start this city again from week one? Everything since is lost.'
                : quit === 'fresh'
                  ? 'Leave this city for a new one with the same settings? Everything here is lost.'
                  : 'Abandon this city and return to the main menu?'
            }
            onYes={() => {
              const o = w.options;
              setQuit(null);
              if (quit === 'restart') startGame({ ...o });
              else if (quit === 'fresh') startGame({ ...o, cityLayout: 'varied', seed: Math.floor(Math.random() * 0xffffffff) >>> 0 });
              else setScreen('menu');
            }}
            onNo={() => setQuit(null)}
          />
        )}
      </Panel>
    </div>
  );
}
