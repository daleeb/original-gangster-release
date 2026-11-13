import { useRef, useState } from 'react';
import { deleteSave, exportSave, importSave, type SaveSlot } from '../app/save';
import { useGame } from '../app/store';
import { ConfirmDialog } from './common';

/** Shared actions for the main menu and the in-game save list. */
export function useSaveActions() {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SaveSlot | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const refresh = useGame(s => s.refreshSaves);

  const exportSlot = async (slot: SaveSlot) => {
    setBusy(true); setMessage(null);
    try {
      const json = await exportSave(slot);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slot.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'save'}.ogsave.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({ text: 'Save exported to your downloads.', bad: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Could not export this save.', bad: true });
    } finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    setBusy(true); setMessage(null);
    try {
      await importSave(await file.text());
      await refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Could not import this save.', bad: true });
    } finally { setBusy(false); }
  };

  const importControl = <>
    <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Import save</button>
    <input ref={input} aria-label="Choose save file" type="file" accept=".json,application/json" hidden
      onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file); }} />
  </>;
  const feedback = message && <p role={message.bad ? 'alert' : 'status'} className="tiny" style={{ margin: '8px 0 0', color: message.bad ? 'var(--red)' : undefined }}>{message.text}</p>;
  const confirmation = deleting && <ConfirmDialog
    text={`Delete "${deleting.name}"? ${deleting.id === 'Autosave' ? 'This is your automatic save. ' : ''}It cannot be brought back.`}
    onYes={() => {
      const id = deleting.id;
      setDeleting(null);
      setMessage(null);
      void deleteSave(id)
        .then(() => refresh())
        .catch(() => setMessage({ text: 'Could not delete this save. Retry when storage is available.', bad: true }));
    }}
    onNo={() => setDeleting(null)}
  />;
  return { busy, exportSlot, setDeleting, importControl, feedback, confirmation };
}
