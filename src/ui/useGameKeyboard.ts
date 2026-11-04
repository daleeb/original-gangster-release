import { useEffect } from 'react';
import { useGame } from '../app/store';
import type { MessageCategory } from '../sim/types';
import { cameraApi } from './CityView';
import { VIEW_ZOOM, viewForZoom } from '../render/viewModes';

/** Shared production keyboard controls for the organizer and working week. */
export function useGameKeyboard() {
  const setTab = useGame((s) => s.setTab);
  const setPaused = useGame((s) => s.setPaused);
  const speedUp = useGame((s) => s.speedUp);
  const speedDown = useGame((s) => s.speedDown);
  const setPickMode = useGame((s) => s.setPickMode);
  const cancelJobCard = useGame((s) => s.cancelJobCard);
  const bump = useGame((s) => s.bump);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('button, [role=tab]') && (e.key === ' ' || e.key === 'Enter')) return;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'))
        return;
      const s = useGame.getState();
      if (s.savingToQuit || s.savingSnapshot) { e.preventDefault(); return; }
      const world = s.sim?.world;
      if (!world) return;

      const planning = world.phase === 'planning';
      const gang = s.sim!.playerGang;
      // Ctrl+S / Ctrl+L / Ctrl+Q: save, load, quit — as the original had them.
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        // Held down, the key repeats: one save, not a stream of them.
        if (!e.repeat) void s.autosave();
        return;
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (planning) setTab('options');
        return;
      }
      if (e.ctrlKey && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault();
        s.setQuitPrompt(true);
        return;
      }
      if (e.key === '?') {
        s.setHelpOpen(!s.helpOpen);
        return;
      }
      // The Organizer's sheets on their letters, and the week's street orders
      // and message boxes on the function keys.
      if (planning && !e.ctrlKey && !e.altKey) {
        const letter = e.key.toLowerCase();
        if (letter === 'c') {
          setTab('lieutenants');
          s.setSheet({ kind: 'clipboard' });
          return;
        }
        if (letter === 'h') {
          setTab('lieutenants');
          s.setSheet({ kind: 'hoods' });
          return;
        }
        if (letter === 'v') {
          setTab('lieutenants');
          s.setSheet({ kind: 'vehicles' });
          return;
        }
        if (letter === 'w') {
          setTab('lieutenants');
          s.setSheet({ kind: 'weapons' });
          return;
        }
        if (e.key === 'Enter' && s.jobCard) {
          (document.querySelector('.jobcard .foot button.brass') as HTMLButtonElement | null)?.click();
          return;
        }
      }
      if (!planning) {
        const streetKeys: Record<string, 'kill' | 'assault' | 'tail' | 'goTo'> = { F1: 'kill', F2: 'assault', F3: 'tail', F4: 'goTo' };
        const kind = streetKeys[e.key];
        if (kind) {
          e.preventDefault();
          // Only people still free to act: the dead keep their gang.
          const ids = (s.selectedPersonIds.length ? s.selectedPersonIds : s.selectedPersonId != null ? [s.selectedPersonId] : [])
            .filter(id => world.people[id]?.status === 'active');
          if (ids.length && ids.every((id) => world.people[id]?.gangId === gang.id)) {
            s.setPickMode({ kind: 'streetOrder', orderType: kind, personIds: ids });
            s.notify(kind === 'goTo' ? 'Click where they should go.' : 'Click the person to target.');
          } else s.notify('Pick one of your own people first.');
          return;
        }
        const boxKeys: Record<string, MessageCategory> = { F5: 'combat', F6: 'police', F7: 'failed', F8: 'waiting' };
        const box = boxKeys[e.key];
        if (box) {
          e.preventDefault();
          s.setMessageBox(box);
          return;
        }
        if (e.key >= '1' && e.key <= '8') {
          // Cycle through a crew's people on the street, centring on each in turn.
          const teamId = gang.teamIds[Number(e.key) - 1];
          const team = teamId != null ? world.teams[teamId] : null;
          if (team) {
            const out = [team.lieutenantId, ...team.memberIds].filter((id) => {
              const p = world.people[id];
              return p && p.status === 'active' && (p.orderId != null || p.streetOrder != null || p.dest != null);
            });
            if (out.length) {
              const cur = out.indexOf(s.selectedPersonId ?? -1);
              const next = out[(cur + 1) % out.length];
              s.focusPerson(next);
              const p = world.people[next];
              if (p) s.requestCamera({ x: p.pos.x, y: p.pos.y });
            } else s.notify('Nobody from that crew is out.');
          }
          return;
        }
      }
      switch (e.key) {
        case 'F1':
          if (planning) setTab('lieutenants');
          break;
        case 'F2':
          if (planning) setTab('accountant');
          break;
        case 'F3':
          if (planning) setTab('lawyer');
          break;
        case 'F4':
          if (planning) setTab('diplomacy');
          break;
        case 'F5':
          if (planning) setTab('newspaper');
          break;
        case 'F6':
          if (planning) setTab('graphs');
          break;
        case 'F7':
          if (planning) setTab('maps');
          break;
        case 'F8':
          if (planning) setTab('options');
          break;
        case 'p':
        case 'P':
          if (!planning) setPaused(!s.paused);
          break;
        case '>':
        case '.':
          speedUp();
          break;
        case '<':
        case ',':
          speedDown();
          break;
        case 'Insert':
          cameraApi.ref?.setZoom(VIEW_ZOOM.plan);
          break;
        case 'Home':
          cameraApi.ref?.setZoom(VIEW_ZOOM.roof);
          break;
        case 'PageUp':
          cameraApi.ref?.setZoom(VIEW_ZOOM.street);
          break;
        case ' ': {
          // Leave the space bar alone when it is being used to press a button.
          if (target && (target.tagName === 'BUTTON' || target.tagName === 'A')) break;
          const z = cameraApi.ref?.getZoom() ?? 3;
          cameraApi.ref?.setZoom(viewForZoom(z) === 'street' ? VIEW_ZOOM.roof : VIEW_ZOOM.street);
          e.preventDefault();
          break;
        }
        case 'b':
        case 'B':
          cameraApi.ref?.toggleBuildingsRemoved();
          break;
        case 'f':
        case 'F':
          cameraApi.ref?.flipView();
          break;
        case 'Escape':
          if (s.sheet) s.setSheet(null);
          else if (s.jobCard) cancelJobCard();
          else if (s.specialistCard) s.cancelSpecialistCard();
          else if (!s.pickMode && s.messageBox) s.setMessageBox(null);
          else setPickMode(null);
          break;
        default:
          break;
      }
      if (e.key >= '1' && e.key <= '8' && planning) {
        const teamId = gang.teamIds[Number(e.key) - 1];
        if (teamId != null) {
          s.selectTeam(teamId);
          setTab('lieutenants');
          bump();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab, setPaused, speedUp, speedDown, setPickMode, cancelJobCard, bump]);

}
