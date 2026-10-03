import { useGameStore } from '../state/store.ts';
import { formatDuration } from './format.ts';

/**
 * Diagnostics strip. Proves the shell's three invariants are live on screen:
 * the tick counter advances at 10 Hz, the save was restored, and offline
 * elapsed time was computed. Replace or hide this when real UI lands.
 */
export function StatusLine(): React.JSX.Element {
  const ticks = useGameStore((s) => s.ticks);
  const saveStatus = useGameStore((s) => s.saveStatus);
  const offline = useGameStore((s) => s.offline);

  const away =
    offline.elapsedMs > 0
      ? `away ${formatDuration(offline.elapsedSeconds)}${offline.clamped ? ' (capped)' : ''}`
      : offline.clockWentBackwards
        ? 'clock moved backwards'
        : 'no offline time';

  return (
    <div className="status-line">
      tick {ticks} · save: {saveStatus} · {away}
    </div>
  );
}
