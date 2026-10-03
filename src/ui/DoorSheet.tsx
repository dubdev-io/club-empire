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
  const stations = useGameStore((s) => s.stations);

  const doorBinding = arrivals < capacity;

  // Is "more lanes" something the player can still do? At full build-out every
  // `laneCost` is null and 0.058/s is turned away for ever — by design, since
  // Door Lv 8 is deliberately a hair ahead of three stations at three lanes. A
  // warning naming a fix that no longer exists is a dead end, and §9's "no
  // advice the player cannot act on" applies to the last minute of the game as
  // much as the first.
  const lanesBuyable = stations.some((s) => !s.unlocked || s.laneCost !== null);

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

      {turnedAway > 0.001 && lanesBuyable ? (
        <p className="station-row__diagnosis station-row__diagnosis--warn">
          <span aria-hidden="true">⚠</span> <strong>Queue</strong> —{' '}
          {formatGuestRate(turnedAway)} turned away. More lanes before more guests.
        </p>
      ) : turnedAway > 0.001 ? (
        // Every lane bought. The residual is a fact about a finished club, not
        // a problem, so it is stated and not alarmed: no ⚠, no instruction, and
        // nothing the player is being nagged to go and fix.
        <p className="station-row__diagnosis">
          <span aria-hidden="true">◦</span> {formatGuestRate(turnedAway)} turned away — every lane
          is bought and the door runs a hair ahead of the bars.
        </p>
      ) : (
        <p className="station-row__diagnosis">
          <span aria-hidden="true">◦</span> No queue. Every guest who arrives gets served.
        </p>
      )}

      {/* Same terminal-state rule as the Bars sheet: at Lv 8 "Upgrade to Door
          Lv 8" is literally wrong, so the label states where the door is
          instead of offering a step it cannot take. */}
      <BuyButton
        label={
          doorMaxed ? `Door Lv ${DOOR_MAX} — maxed` : `Upgrade to Door Lv ${doorLevel + 1}`
        }
        price={formatCash(doorCost ?? 0)}
        affordable={doorCost !== null && cash >= doorCost}
        doneLabel={doorMaxed ? `Lv ${DOOR_MAX} of ${DOOR_MAX}` : undefined}
        accent="cyan"
        onBuy={actions.upgradeDoor}
      />
    </Sheet>
  );
}
