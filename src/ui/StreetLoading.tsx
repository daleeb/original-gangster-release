import { useState } from 'react';
import { DialogFrame } from './DialogFrame';
import { Rivets } from './common';

/** The backdrop is decoded while the player plans, not while the city is being
 * built (which holds the main thread and would leave the screen black). */
export const LOADING_ART = `${import.meta.env.BASE_URL}art/brand/key-art-city.jpg`;
export function preloadLoadingArt(): void {
  if (typeof Image === 'undefined') return;
  const img = new Image(); img.src = LOADING_ART; void img.decode?.().catch(() => {});
}

/** Advice from the manual, shown while the streets open. */
export const LOADING_TIPS = [
  'Illegal businesses earn far more than legal ones, but they must sit behind a legal front on the same block.',
  'Extorting blocks near your territory is easier: the further away, the harder the sell.',
  'A lieutenant with little to do still costs his wages. Give every crew a full week.',
  'Without an accountant, almost nothing you earn illegally can be explained away to the tax man.',
  'A hood who is wanted should stay off the streets for a week or two while the heat dies down.',
  'Bribed police look the other way, but a bribe is only as good as the officer who took it.',
  'Guarding a front also protects the illegal business behind it.',
  'Your boss is the gang. If he dies or goes to prison, the game is over.',
  'Win the mayoralty and the city is yours: you need territory, a lawyer and the cash for the campaign.',
  'Rival hoods you have not identified dress like ordinary citizens. Explore to learn who they are.',
];

export interface StreetLoadingProps {
  message: string;
  failed: boolean;
  /** The week is being run without the street view. */
  resolving?: boolean;
  /** Where the unseen week has got to ("Wed · 2:10 pm"). */
  progress?: string;
  /** What the graphics layer reported, for a bug report. */
  detail?: string | null;
  /** How many times the street view has been tried again. */
  attempts?: number;
  onRetry: () => void;
  onExit: () => void;
  /** Run the week without the street view. */
  onSkip?: () => void;
  /** Stop an unseen week part way. */
  onStop?: () => void;
}

export function StreetLoading({ message, failed, resolving = false, progress, detail, attempts = 0, onRetry, onExit, onSkip, onStop }: StreetLoadingProps) {
  const [tip] = useState(() => LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)]);
  if (resolving) {
    return <DialogFrame title="Running the week" onClose={() => {}} width={460} className="street-loading">
      <div className="paper street-loading-card">
        <Rivets />
        <div className="kicker">New Temperance · Working week</div>
        <h2>Running the week</h2>
        <div className="street-loading-spinner" aria-hidden="true" />
        <p role="status" aria-live="polite">Your crews are at work without the street view{progress ? ` · ${progress}` : ''}</p>
        <p className="street-loading-note">The newspaper and your lieutenants' reports follow on Friday.</p>
        {onStop && <div className="row"><button className="btn" onClick={onStop}>Stop</button></div>}
      </div>
    </DialogFrame>;
  }
  return <DialogFrame title={failed ? 'City unavailable' : 'Opening the streets'} onClose={() => {}} width={460} className="street-loading">
    <div className="paper street-loading-card">
      <Rivets />
      <div className="kicker">New Temperance · Working week</div>
      <h2>{failed ? 'The city could not be displayed' : 'Opening the streets'}</h2>
      {!failed && <div className="street-loading-spinner" aria-hidden="true" />}
      <p role={failed ? 'alert' : 'status'} aria-live="polite">
        {failed
          ? 'The street view needs 3D graphics (WebGL 2), and this browser or graphics driver would not open it. You can run the week without it: your orders are carried out just the same, and the newspaper and your lieutenants\' reports are waiting at the end.'
          : message}
      </p>
      <p className="street-loading-note">
        {failed
          ? `Your city is still open.${attempts > 0 ? ` Tried again ${attempts} time${attempts === 1 ? '' : 's'} without success.` : ''}`
          : 'The game clock is paused while the city loads.'}
      </p>
      {failed && detail && <p className="street-loading-detail">Reported: {detail}</p>}
      {!failed && <p className="street-loading-tip"><b>Consigliere's advice.</b> {tip}</p>}
      {failed && <div className="row wrap" style={{ gap: 6 }}>
        {onSkip && <button className="btn brass" data-autofocus onClick={onSkip}>Run the week without the street view</button>}
        <button className={onSkip ? 'btn' : 'btn brass'} onClick={onRetry}>Try again</button>
        <button className="btn" onClick={onExit}>Back to menu</button>
      </div>}
    </div>
  </DialogFrame>;
}
