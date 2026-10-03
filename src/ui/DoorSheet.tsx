import { DOOR_MAX } from '../config/economy.ts';
import { useGameStore } from '../state/store.ts';
import { formatCash, formatGuestRate } from './format.ts';
import { BuyButton, Sheet } from './Sheet.tsx';

/**
 * The DOOR sheet: arrivals now versus capacity, and one purchase.
 *
 * The brief specifies this panel as "arrivals now vs capacity" plus a queue
 * badge, and the reason is the `min()`. Those two numbers side by side are the
 * whole economy: whichever is smaller is what the player's next pound should go
 * to. Putting them on one line, as a pair, is what makes the Door a diagnosis
 * rather than another upgrade button.
 *
 * There is deliberately no "recommended" label. The two numbers say it, and the
 * player reading them is the design working.
 */
export function DoorSheet(): React.JSX.Element {
  const closeSheet = useGameStore((s) => s.closeSheet);
  const actions = useGameStore((s) => s.actions);
  const cash = useGameStore((s) => s.cash);

  const doorLevel = useGameStore((s) => s.doorLevel);
  const doorCost = useGameStore((s) => s.doorCost);
  const doorMaxed = useGameStore((s) => s.doorMaxed);
  const arrivals = useGameStore((s) => s.arrivalsPerSecond);
  const capacity = useGameStore((s) => s.capacityPerSecond);
  const turnedAway = useGameStore((s) => s.turnedAwayPerSecond);

  const doorBinding = arrivals < capacity;

  return (
    <Sheet
      title="Door"
      subtitle="How many guests walk in. Only useful if your bars can serve them."
      onClose={closeSheet}
    >
      <div className="door-compare">
        <div className={`door-compare__side${doorBinding ? ' door-compare__side--binding' : ''}`}>
          <span className="door-compare__label">Arriving</span>
          <span className="door-compare__value">{formatGuestRate(arrivals)}</span>
          <span className="door-compare__sub">Door Lv {doorLevel}</span>
        </div>

        <span className="door-compare__vs" aria-hidden="true">
          vs
        </span>

        <div className={`door-compare__side${!doorBinding ? ' door-compare__side--binding' : ''}`}>
          <span className="door-compare__label">Can serve</span>
          <span className="door-compare__value">{formatGuestRate(capacity)}</span>
          <span className="door-compare__sub">All lanes</span>
        </div>
      </div>

      {turnedAway > 0.001 ? (
        <p className="station-row__diagnosis station-row__diagnosis--warn">
          <span aria-hidden="true">⚠</span> <strong>Queue</strong> —{' '}
          {formatGuestRate(turnedAway)} turned away. More lanes before more guests.
        </p>
      ) : (
        <p className="station-row__diagnosis">
          <span aria-hidden="true">◦</span> No queue. Every guest who arrives gets served.
        </p>
      )}

      <BuyButton
        label={`Upgrade to Door Lv ${Math.min(doorLevel + 1, DOOR_MAX)}`}
        price={formatCash(doorCost ?? 0)}
        affordable={doorCost !== null && cash >= doorCost}
        doneLabel={doorMaxed ? `Lv ${DOOR_MAX} MAXED` : undefined}
        accent="cyan"
        onBuy={actions.upgradeDoor}
      />
    </Sheet>
  );
}
