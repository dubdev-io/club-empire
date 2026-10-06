import { DOOR_MAX } from '../config/economy.ts';
import { useGameStore } from '../state/store.ts';
import { canAddLanes, doorDiagnosis } from './diagnosis.ts';
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
  const complete = useGameStore((s) => s.complete);

  const doorBinding = arrivals < capacity;
  const diagnosis = doorDiagnosis(turnedAway, arrivals, canAddLanes(stations), complete);

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

      <p
        className={`station-row__diagnosis${
          diagnosis.warn ? ' station-row__diagnosis--warn' : ''
        }`}
      >
        <span aria-hidden="true">{diagnosis.glyph}</span>
        {/* Lead and body in one span, the way the HUD banner already does it.
            The paragraph is a flex row, so a bare `<strong>` is its own column:
            "Queue" is one word and survived that, but "Full house" broke across
            two lines with the sentence beside it. Inside one span the sentence
            flows and the glyph stays outdented. */}
        <span>
          {diagnosis.lead !== null && (
            <>
              <strong>{diagnosis.lead}</strong> —{' '}
            </>
          )}
          {diagnosis.body}
        </span>
      </p>

      {/* Same terminal-state rule as the Bars sheet: at Lv 8 "Upgrade to Door
          Lv 8" is literally wrong, so the label states where the door is
          instead of offering a step it cannot take — and the slot that held the
          price says the state, not the level over again (DUB-55).

          This row keeps the word "Door" where the Bars rows drop their noun.
          It is a bare button under the compare block rather than a row inside a
          named card, so nothing above it names what is finished. */}
      <BuyButton
        label={doorMaxed ? `Door Lv ${DOOR_MAX}` : `Upgrade to Door Lv ${doorLevel + 1}`}
        price={formatCash(doorCost ?? 0)}
        affordable={doorCost !== null && cash >= doorCost}
        doneLabel={doorMaxed ? 'Maxed' : undefined}
        accent="cyan"
        onBuy={actions.upgradeDoor}
      />
    </Sheet>
  );
}
