import { ArtImage } from './ArtImage';
import { useEffect, useState } from 'react';
import { useGame } from '../app/store';
import { loadHallOfFame, slotLoadable, type HallEntry, type SaveSlot } from '../app/save';
import { gangManpower, money, territoryCount } from '../sim/world';
import { art } from './art';
import { CityPlan } from './desk/CityPlan';
import { Modal } from './common';
import { useSaveActions } from './saveActions';
import { Plaque } from './Plaque';
import { audio } from '../audio/audio';
import { HelpSheet } from './HelpSheet';
import { applyTutorial, tutorialById, TUTORIALS } from '../app/tutorials';
import { HallOfFame } from './HallOfFame';

type Sheet = null | 'load' | 'tutorials' | 'hall' | 'help' | 'credits';

/** The desktop build can close its window; a browser tab cannot. */
function desktopQuit(): (() => void) | null {
  const quit = (globalThis as { ogDesktop?: { app?: { quit?: () => void } } }).ogDesktop?.app?.quit;
  return quit ?? null;
}

/** What a saved city looked like when it was put away. */
function describeSlot(slot: SaveSlot): { cash: number; blocks: number; men: number; seed: number; finished: boolean } {
  if (slot.summary) return slot.summary;
  const w = slot.world;
  if (!w) return { cash: 0, blocks: 0, men: 0, seed: 0, finished: false };
  const gang = Object.values(w.gangs).find((g) => g.isPlayer);
  return {
    cash: gang?.cash ?? 0,
    blocks: gang ? territoryCount(w, gang.id) : 0,
    men: gang ? gangManpower(w, gang) : 0,
    seed: w.options?.seed ?? 1928,
    finished: w.phase === 'gameOver',
  };
}

function surname(name: string): string {
  const parts = name.replace(/"[^"]*"/g, '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

/** How long the menu waits untouched before the attract mode starts. */
const ATTRACT_IDLE_MS = 60_000;

export function MainMenu() {
  const setScreen = useGame((s) => s.setScreen);
  const refreshSaves = useGame((s) => s.refreshSaves);
  const saves = useGame((s) => s.saves);
  const loadFromSlot = useGame((s) => s.loadFromSlot);
  const startGame = useGame((s) => s.startGame);

  const [sheet, setSheet] = useState<Sheet>(null);
  const { busy, exportSlot, setDeleting, importControl, feedback, confirmation } = useSaveActions();
  const [hall, setHall] = useState<HallEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [lesson, setLesson] = useState(TUTORIALS[0]?.id ?? 1);
  const quit = desktopQuit();

  useEffect(() => {
    void refreshSaves();
    setHall(loadHallOfFame());
  }, [refreshSaves]);

  // Left alone at the table, the game shows itself off as the original's demo
  // did; any movement, key or open page keeps the menu.
  useEffect(() => {
    if (sheet) return;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!document.hidden && !document.querySelector('[aria-modal="true"]')) useGame.getState().startAttract();
      }, ATTRACT_IDLE_MS);
    };
    arm();
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, arm, { passive: true });
    return () => { window.clearTimeout(timer); for (const e of events) window.removeEventListener(e, arm); };
  }, [sheet]);

  const savesError = useGame(s => s.savesError);
  const latest = saves.find(slotLoadable) ?? null;
  const latestInfo = latest ? describeSlot(latest) : null;
  const best = hall[0] ?? null;

  const plaques: { label: string; detail?: string; go: () => void; continueSave?: boolean }[] = [
    ...(latest && latestInfo
      ? [{
          label: 'Continue Previous Game',
          continueSave: true,
          detail: `${latest.bossName} · Week ${latest.week} · ${latestInfo.finished ? 'Finished' : money(latestInfo.cash)}`,
          go: () => loadFromSlot(latest),
        }]
      : []),
    { label: 'New Game', go: () => setScreen('newGame') },
    {
      label: 'Load Game',
      detail: savesError ? 'Storage unavailable' : undefined,
      go: () => {
        void refreshSaves();
        setSheet('load');
      },
    },
    { label: 'Tutorials', go: () => setSheet('tutorials') },
    {
      label: 'Hall of Fame',
      go: () => {
        setHall(loadHallOfFame());
        setSheet('hall');
      },
    },
    { label: 'How to Play', go: () => setSheet('help') },
    { label: 'Credits', go: () => setSheet('credits') },
    ...(quit ? [{ label: 'Quit', go: quit }] : []),
  ];
  const entries = plaques;

  // The closing-time ballad at the casino table (it starts with the first gesture).
  useEffect(() => { audio.music('menu'); }, []);

  // The table answers the keyboard as the original's menus did.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.target as HTMLElement)?.closest('input, select, textarea, a, [contenteditable="true"]')) return;
      if (sheet) {
        if (e.key === 'Escape') setSheet(null);
        return;
      }
      if (e.key === 'ArrowDown') { setCursor((c) => Math.min(entries.length - 1, c + 1)); audio.hover(); }
      else if (e.key === 'ArrowUp') { setCursor((c) => Math.max(0, c - 1)); audio.hover(); }
      else if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('button')) { audio.plaque(); entries[cursor]?.go(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, cursor, entries]);

  return (
    <div className="scene scene-casino">
      <div className="scene-light" aria-hidden="true" />
      <h1 className="scene-title">
        <ArtImage src={art('brand/wordmark.png')} alt="Original Gangster" draggable={false} />
      </h1>

      <nav className="plaque-stack" aria-label="Main menu">
        {plaques.map((p, i) => (
          <Plaque
            key={p.label}
            className={`${cursor === i ? 'on' : ''}${p.continueSave ? ' continue-plaque' : ''}`}
            onClick={p.go}
            onMouseEnter={() => setCursor(i)}
            detail={p.detail}
          >
            {p.label}
          </Plaque>
        ))}
      </nav>

      {best && <div className="scene-footnote">Best in the Hall: {surname(best.name)} · {best.score}</div>}

      {sheet === 'load' && (
        <Modal title="Load Game" kicker={`Saved games · ${saves.length}`} onClose={() => setSheet(null)}>
          <div style={{ paddingBottom: 12, marginBottom: 8, borderBottom: '1px dotted var(--dots)' }}>
            {importControl}
            {feedback}
          </div>
          {savesError && <p role="alert">{savesError} <button className="btn" onClick={() => void refreshSaves()}>Retry</button></p>}
          {saves.length === 0 && !savesError ? (
            <p className="muted">No saved games yet. The game saves itself every Monday morning.</p>
          ) : (
            saves.map((s) => {
              const info = describeSlot(s);
              return (
                <div key={s.id} className="save-row">
                  <div className="thumb">
                    <CityPlan seed={info.seed} blocks={10} />
                  </div>
                  <div>
                    <h3>
                      {s.name}
                      {s.id === 'Autosave' && <small>Autosave</small>}
                    </h3>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {s.error ?? <>{s.bossName} · Week {s.week}{s.summary || s.world ? <> · {money(info.cash)} · {info.blocks} blocks</> : null}</>}
                    </div>
                    <div className="typewriter" style={{ fontSize: 11.5, color: 'var(--brass-label)', marginTop: 2 }}>
                      {new Date(s.savedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn" disabled={!slotLoadable(s) || busy} onClick={() => void exportSlot(s)}>Export</button>
                    <button
                      className="btn brass"
                      disabled={!slotLoadable(s)}
                      onClick={() => {
                        loadFromSlot(s);
                        setSheet(null);
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="btn red-text"
                      onClick={() => setDeleting(s)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </Modal>
      )}
      {confirmation}

      {sheet === 'hall' && <HallOfFame onClose={() => { setHall(loadHallOfFame()); setSheet(null); }} />}

      {sheet === 'tutorials' && (() => {
        const chosen = tutorialById(lesson) ?? TUTORIALS[0];
        return (
          <Modal
            title="Tutorials"
            kicker="Four lessons · manual pp. 9–27"
            onClose={() => setSheet(null)}
            width={640}
            footer={
              <>
                <button className="btn" onClick={() => setSheet(null)}>Cancel</button>
                <button className="btn brass" onClick={() => startGame(applyTutorial(useGame.getState().options, chosen))}>Load Tutorial</button>
              </>
            }
          >
            <div className="scenario-list tutorial-list" role="listbox" aria-label="Tutorials">
              {TUTORIALS.map((t) => (
                <button key={t.id} role="option" aria-selected={t.id === chosen.id} className={`paper scenario${t.id === chosen.id ? ' on' : ''}`}
                  onClick={() => setLesson(t.id)} onDoubleClick={() => startGame(applyTutorial(useGame.getState().options, t))}>
                  <b>Tutorial {t.id}: {t.name}</b>
                </button>
              ))}
            </div>
            <div className="paper tutorial-details">
              <p style={{ margin: '0 0 6px' }}>{chosen.blurb}</p>
              <ol className="muted tiny" style={{ margin: 0, paddingLeft: 18 }}>
                {chosen.steps.map((step, i) => <li key={i}>{step.text}</li>)}
              </ol>
            </div>
          </Modal>
        );
      })()}

      {sheet === 'help' && (
        <HelpSheet
          onClose={() => setSheet(null)}
          onStartLesson={(id) => {
            const t = tutorialById(id);
            if (t) startGame(applyTutorial(useGame.getState().options, t));
          }}
        />
      )}
      {sheet === 'credits' && (
        <Modal title="Credits" kicker="Original Gangster · an HD reimagining" onClose={() => setSheet(null)} width={640}>
          <div className="credits">
            <h4>The original</h4>
            <p>
              <i>Gangsters: Organized Crime</i> (1998), designed by Martin Capel, developed by Hothouse Creations and
              published by Eidos Interactive. This is a fan reimagining; the original game and its manual are
              the reference for every rule here.
            </p>
            <h4>This reimagining</h4>
            <p>
              Design, simulation, renderer, interface and art made for this project: desk materials, crests,
              icons, portraits, city facades, mastheads, cursors, and the people, vehicles, trees and rubble of
              the streets.
            </p>
            <h4>Music and sound</h4>
            <p>The score and the city's sounds were made for this game; synthesised Web Audio stands in until they load.</p>
            <h4>Type and tools</h4>
            <p>Barlow, Barlow Condensed, Special Elite and Cinzel from Google Fonts (Open Font License) · Three.js · React · Vite · Zustand · Electron · Vitest.</p>
            <p className="muted">New Temperance is fictional. Any resemblance to a Chicago of the 1920s is entirely the point.</p>
            <p className="muted">Version {__APP_VERSION__}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

