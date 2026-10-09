import { QUEUE_WARNING_SHARE } from '../config/economy.ts';
import { useGameStore } from '../state/store.ts';
import { activationProps } from './activation.ts';

/**
 * The only navigation in the game: two panels and settings.
 *
 * Sits in the thumb zone, above the home indicator, and every target is 56 px
 * tall with 8 px between them. The badges are the reason this is a bar and not
 * a menu — `⚠` on DOOR when guests are being turned away, and a dot on BARS
 * when something in there is affordable — so the player is told where to look
 * without opening anything.
 *
 * It is also the only way into any of the three panels, which made DUB-59's bug
 * worst here: these three opened on `pointerdown` alone, and keyboard
 * activation of a `<button>` produces a `click` and no `pointerdown`, so a
 * player on a keyboard could tab onto all three tabs and open none of them. Not
 * a degraded game — no game, because everything the player can buy is behind
 * one of these.
 *
 * `activationProps` is the shared fix, and no tab passes a press callback:
 * `.bar-button:active` already swaps the tab's background against a container
 * it does not match, so unlike `.cta` there is nothing for a class of our own
 * to rescue.
 */
export function BottomBar(): React.JSX.Element {
  const openSheet = useGameStore((s) => s.openSheet);
  const sheet = useGameStore((s) => s.sheet);
  const turnedAway = useGameStore((s) => s.turnedAwayPerSecond);
  const arrivals = useGameStore((s) => s.arrivalsPerSecond);
  const cash = useGameStore((s) => s.cash);
  const stations = useGameStore((s) => s.stations);
  const doorCost = useGameStore((s) => s.doorCost);

  const barsAffordable = stations.some(
    (st) =>
      (st.unlockCost !== null && cash >= st.unlockCost) ||
      (st.upgradeCost !== null && cash >= st.upgradeCost) ||
      (st.laneCost !== null && cash >= st.laneCost),
  );
  const doorAffordable = doorCost !== null && cash >= doorCost;

  return (
    <nav className="bottom-bar" aria-label="Club panels">
      <button
        type="button"
        className={`bar-button${sheet === 'bars' ? ' bar-button--active' : ''}`}
        {...activationProps({ onAct: () => openSheet('bars') })}
      >
        <span>BARS</span>
        {barsAffordable && <span className="bar-button__dot" aria-label="upgrade available" />}
      </button>

      <button
        type="button"
        className={`bar-button${sheet === 'door' ? ' bar-button--active' : ''}`}
        {...activationProps({ onAct: () => openSheet('door') })}
      >
        <span>DOOR</span>
        {arrivals > 0 && turnedAway / arrivals >= QUEUE_WARNING_SHARE ? (
          <span className="bar-button__warn">
            <span aria-hidden="true">⚠</span>
            <span className="visually-hidden">queue at the door</span>
          </span>
        ) : (
          doorAffordable && <span className="bar-button__dot" aria-label="upgrade available" />
        )}
      </button>

      <button
        type="button"
        className={`bar-button bar-button--icon${sheet === 'settings' ? ' bar-button--active' : ''}`}
        {...activationProps({ onAct: () => openSheet('settings') })}
        aria-label="Settings"
      >
        <span aria-hidden="true">⚙</span>
      </button>
    </nav>
  );
}
