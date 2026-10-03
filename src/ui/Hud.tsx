import { useGameStore } from '../state/store.ts';
import { LAST_CALL_DURATION_SECONDS } from '../config/economy.ts';
import { formatCash, formatRate } from './format.ts';

/**
 * The top HUD: cash, income per second, the Last Call meter, and the queue
 * warning.
 *
 * Everything here is **read, never tapped** — §9 reserves the top 25% of the
 * screen for exactly that, and this component has no interactive element in
 * it at all. The one exception a reader might expect, dismissing the queue
 * warning, is deliberately absent: the warning goes away by fixing the club,
 * which is the whole point of it.
 *
 * Every text node sits on `--scrim` rather than directly on the canvas. The
 * art is dark today, but "the art stays dark" is not a contrast guarantee and
 * criterion 7 is measured against the *rendered* background.
 */
export function Hud(): React.JSX.Element {
  const cash = useGameStore((s) => s.cash);
  const incomePerSecond = useGameStore((s) => s.incomePerSecond);
  const multiplier = useGameStore((s) => s.multiplier);

  return (
    <div className="hud">
      <div className="hud__row">
        <div className="hud__cash-block">
          {/* aria-live so the counter is announced on change, but `polite` and
              on a container that only holds the number — `assertive` here
              would talk over everything else, ten times a second. */}
          <div className="hud__cash" aria-live="polite" aria-atomic="true">
            {formatCash(cash)}
          </div>
          <div className="hud__rate">
            {formatRate(incomePerSecond)}
            {multiplier > 1 && (
              <span className="hud__boost"> ×{multiplier} Last Call</span>
            )}
          </div>
        </div>
      </div>

      <LastCallMeter />
      <QueueWarning />
    </div>
  );
}

/**
 * The Last Call meter (§4.5).
 *
 * Two visual states, and the difference matters. At rest it is a quiet bar.
 * When the player can afford nothing it is **promoted** — full opacity, the
 * violet fill pulsing with the dance floor — because at that moment it is the
 * only thing they can still act on, and the design review was explicit that
 * this is what replaces a "time to afford" countdown. An ETA teaches the
 * player to put the phone down; a meter that visibly moves when they tap
 * teaches them to tap.
 */
function LastCallMeter(): React.JSX.Element {
  const meter = useGameStore((s) => s.lastCallMeter);
  const remaining = useGameStore((s) => s.lastCallRemaining);
  const nothingAffordable = useGameStore((s) => s.nothingAffordable);
  const reducedMotion = useGameStore((s) => s.reducedMotion);

  const firing = remaining > 0;
  const fill = firing ? remaining / LAST_CALL_DURATION_SECONDS : meter;

  const classes = ['meter'];
  if (firing) classes.push('meter--firing');
  if (nothingAffordable && !firing) classes.push('meter--promoted');
  if (reducedMotion) classes.push('meter--still');

  return (
    <div
      className={classes.join(' ')}
      role="progressbar"
      aria-label={firing ? 'Last Call active' : 'Last Call meter'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fill * 100)}
    >
      <div className="meter__track">
        <div className="meter__fill" style={{ width: `${Math.min(100, fill * 100)}%` }} />
      </div>
      <div className="meter__label">
        {firing ? (
          <>
            {/* A number, not a bar alone — the fill is draining and §9 forbids
                signalling state by one channel only. */}
            <span className="meter__tag">LAST CALL</span> ×3 · {Math.ceil(remaining)}s
          </>
        ) : (
          <>
            <span className="meter__tag">LAST CALL</span> {Math.floor(meter * 100)}%
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The queue warning.
 *
 * `⚠` plus the word "Queue", never the colour alone (§9). It names the fix,
 * because the queue is the entire tutorial and a warning the player cannot act
 * on is just anxiety.
 */
function QueueWarning(): React.JSX.Element | null {
  const turnedAway = useGameStore((s) => s.turnedAwayPerSecond);
  if (turnedAway <= 0.001) return null;

  return (
    <div className="queue-warning" role="status">
      <span aria-hidden="true">⚠</span>
      <span>
        <strong>Queue at the door</strong> — buy a serving lane
      </span>
    </div>
  );
}
