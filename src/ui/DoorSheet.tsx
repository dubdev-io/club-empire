import { DOOR_MAX } from '../config/economy.ts';
import { useGameStore, type StationView } from '../state/store.ts';
import { formatCash, formatGuestRate } from './format.ts';
import { BuyButton, Sheet } from './Sheet.tsx';

/** The rate below which a residual overflow is rounding, not a queue. */
const QUEUE_EPSILON = 0.001;

/**
 * One line of the DOOR sheet's queue diagnosis, as data rather than as markup.
 *
 * Split out from the JSX for one reason: the branch is the fix, so the branch
 * is what a test has to be able to reach. The UI tests have no DOM
 * (`vitest.config.ts` runs on `node`), and this is pure, so the three states
 * are pinned in CI without pulling in a renderer.
 */
export interface DoorDiagnosis {
  /** Drives both the `⚠` and the `--warn` class — they are never separated. */
  readonly warn: boolean;
  readonly glyph: string;
  /** The bolded lead-in, or null when the line is one plain sentence. */
  readonly lead: string | null;
  readonly body: string;
}

/**
 * What to say about the guests who are not getting in.
 *
 * The old line was gated on magnitude alone, which made it advise "more lanes"
 * at full lane build-out — the one state where no lane can be bought. Door Lv 8
 * arrives at 3.225/s against 3.167/s of lane capacity, so 0.058/s is turned
 * away permanently; that residual is the economy, not a problem, and it is
 * reachable mid-run with every station still at Lv 7.
 *
 * So the gate is purchasability, not size. `⚠` is kept for exactly the case it
 * teaches — a lane can still be bought — which is the same reasoning already
 * written into the HUD banner: a warning the player cannot act on is just
 * anxiety.
 */
export function doorDiagnosis(
  turnedAway: number,
  canAddLanes: boolean,
  complete: boolean,
): DoorDiagnosis {
  if (turnedAway <= QUEUE_EPSILON) {
    return {
      warn: false,
      glyph: '◦',
      lead: null,
      body: 'No queue. Every guest who arrives gets served.',
    };
  }

  if (canAddLanes) {
    return {
      warn: true,
      glyph: '⚠',
      lead: 'Queue',
      body: `${formatGuestRate(turnedAway)} turned away. More lanes before more guests.`,
    };
  }

  // Nothing left to widen. Name the state, then point at the only lever that
  // still does anything — or, at the end, say the club is finished. The last
  // line a player ever reads on this sheet is an achievement, not a 1.8%
  // shortfall dressed up as a fault.
  return {
    warn: false,
    glyph: '◦',
    lead: 'Full house',
    body: `${formatGuestRate(turnedAway)} walk past. ${
      complete ? 'The club is as big as it gets.' : 'Levels are what pay now.'
    }`,
  };
}

/**
 * Whether a lane can still be bought anywhere in the club.
 *
 * Includes unlocking a station, which is how the second and third bars' lanes
 * arrive. Both costs are `null` when the purchase does not exist, not when it is
 * unaffordable — affordability is compared against cash separately — so this
 * asks whether the advice is actionable at all, never whether the player can
 * pay for it today.
 */
export function canAddLanes(
  stations: readonly Pick<StationView, 'laneCost' | 'unlockCost'>[],
): boolean {
  return stations.some((st) => st.laneCost !== null || st.unlockCost !== null);
}

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
  const diagnosis = doorDiagnosis(turnedAway, canAddLanes(stations), complete);

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
