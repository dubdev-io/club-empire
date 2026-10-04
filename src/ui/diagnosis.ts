import { QUEUE_WARNING_SHARE } from '../config/economy.ts';
import { formatGuestRate } from './format.ts';
import type { StationView } from '../state/store.ts';

/** The rate below which a residual overflow is rounding, not a queue. */
const QUEUE_EPSILON = 0.001;

/**
 * One line of queue diagnosis, as data rather than as markup.
 *
 * Split out from the JSX for one reason: the branch is the fix, so the branch
 * is what a test has to be able to reach. The UI tests have no DOM
 * (`vitest.config.ts` runs on `node`), and these are pure, so every state is
 * pinned in CI without pulling in a renderer.
 *
 * Both sheets share this shape because they share the defect it fixes. A line
 * gated on how *big* the shortfall is will sooner or later fire in a state
 * where the fix it names cannot be bought; the rule that prevents that is
 * **gate on purchasability, never on magnitude** — and `warn` is what carries
 * it, since it drives both the `⚠` and the `--warn` class. A warning the
 * player cannot act on is just anxiety.
 *
 * Purchasability decides whether the advice is *given*; it does not on its own
 * decide whether the advice shouts. What a line says and how loudly it says it
 * are two axes, so `warn` is gated on severity as well — see `doorDiagnosis`.
 */
export interface Diagnosis {
  /** Drives both the `⚠` and the `--warn` class — they are never separated. */
  readonly warn: boolean;
  readonly glyph: string;
  /** The bolded lead-in, or null when the line is one plain sentence. */
  readonly lead: string | null;
  readonly body: string;
}

/**
 * What to say about the guests who are not getting in (DUB-13).
 *
 * Two bugs, at opposite ends of the same run, both from gating this line on one
 * axis.
 *
 * The first was magnitude alone, which made it advise "more lanes" at full lane
 * build-out — the one state where no lane can be bought. Door Lv 8 arrives at
 * 3.225/s against 3.167/s of lane capacity, so 0.058/s is turned away
 * permanently; that residual is the economy, not a problem, and it is reachable
 * mid-run with every station still at Lv 7.
 *
 * Fixing that on purchasability alone left the opposite end lit: a **fresh
 * club** serves 0.50/s against 0.90/s arriving, a lane is buyable, so the amber
 * `⚠` was on screen at second zero telling a player with £32 to buy a £60
 * upgrade. That is the scenario `QUEUE_WARNING_SHARE` was tuned to prevent, and
 * the Hud and the DOOR badge both already honour it — this sheet was the one
 * surface ignoring it, firing one identical alarm at 1.8%, 44% and 84%.
 *
 * So the two axes are separated: **purchasability decides the advice, severity
 * decides the volume.** `share >= QUEUE_WARNING_SHARE` is the only thing that
 * earns amber. The neutral tiers give the *same* advice in a lower register —
 * the right move does not change with severity, only the urgency does, so
 * "turned away" is the amber verb and "walk past" the neutral one.
 */
export function doorDiagnosis(
  turnedAway: number,
  arrivals: number,
  canAddLanes: boolean,
  complete: boolean,
): Diagnosis {
  if (turnedAway <= QUEUE_EPSILON) {
    return {
      warn: false,
      glyph: '◦',
      lead: null,
      body: 'No queue. Every guest who arrives gets served.',
    };
  }

  const rate = formatGuestRate(turnedAway);

  if (canAddLanes) {
    // Load-bearing, and not for the reason it looks like. Inside one
    // `ClubFlow` the divide is safe by construction — `turnedAway` is the
    // undrained remainder of `arrivals`, so `turnedAway <= arrivals`
    // identically — but the sheet never sees a `ClubFlow`. It reads two
    // independently published store slices: `turnedAway` on the 10 Hz fast
    // snapshot, `arrivals` on the purchase-time structural one, both
    // defaulting to 0. What keeps them consistent is that `publishStructure`
    // runs before `publishFast` at every call site, and that before the first
    // structural publish `stations` is `[]` — so `canAddLanes` is false and
    // this branch is unreachable. Reorder those publishes and `x / 0` is
    // `Infinity`, not `NaN`, which is `>= QUEUE_WARNING_SHARE` and puts the
    // fresh-club alarm straight back on screen. The guard is cheaper than the
    // coupling.
    const severe = arrivals > 0 && turnedAway / arrivals >= QUEUE_WARNING_SHARE;

    return severe
      ? {
          warn: true,
          glyph: '⚠',
          lead: 'Queue',
          body: `${rate} turned away. More lanes before more guests.`,
        }
      : {
          // No lead: the amber tier's "Queue —" is what makes it read as an
          // alarm, and an ordinary condition of play should not borrow it.
          warn: false,
          glyph: '◦',
          lead: null,
          body: `${rate} walk past. More lanes before more guests.`,
        };
  }

  // Nothing left to widen. Name the state, then point at the only lever that
  // still does anything — or, at the end, say the club is finished. The last
  // line a player ever reads on this sheet is an achievement, not a 1.8%
  // shortfall dressed up as a fault, and not a ceiling either: the completion
  // card it sits behind promises a second venue in Phase 2, so this line must
  // not contradict it.
  return {
    warn: false,
    glyph: '◦',
    lead: 'Full house',
    body: `${rate} walk past. ${
      complete ? "You've built it all." : 'Levels are what pay now.'
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

/** Half a bartender standing still is the point at which idling is worth saying. */
const IDLE_LANES_EPSILON = 0.5;

/**
 * One station's line: a queue, an idle bartender, or nothing.
 *
 * Same defect and same rule as `doorDiagnosis`. The old line branched on
 * `saturated` alone, so at three lanes it said "Add a lane" directly above a
 * row reading `3 LANES` — and at full build-out it said it on all three cards
 * at once, in amber, behind the CLUB COMPLETE card. A reward screen landing
 * over three warnings is the opposite of what a reward screen is for.
 *
 * So `⚠` is kept for exactly the case it teaches: this station is saturated
 * *and* a lane can still be bought. With the lane gone the same fact is stated
 * without an imperative, and the lever named is the one that still exists.
 */
export function stationDiagnosis(
  station: Pick<
    StationView,
    'saturated' | 'idleLanes' | 'laneCost' | 'maxed' | 'servedPerSecond' | 'capacityPerSecond'
  >,
): Diagnosis | null {
  if (station.saturated) {
    if (station.laneCost !== null) {
      return {
        warn: true,
        glyph: '⚠',
        lead: 'Queue',
        body: 'every lane is busy. Add a lane.',
      };
    }

    // Every lane is bought. `maxed` is the level axis, so when it is also true
    // there is no lever left on this card at all and the line says so rather
    // than pointing at one.
    return {
      warn: false,
      glyph: '◦',
      lead: 'Full house',
      // The terminal line drops the "every lane is pouring" clause: the lead
      // already says the lanes are full, and the long form measured 71
      // characters against the 64 the two-line box fits at 390 px.
      body: station.maxed
        ? 'this bar is as big as it gets.'
        : 'every lane is pouring. Levels are what pay now.',
    };
  }

  if (station.idleLanes >= IDLE_LANES_EPSILON) {
    // Said in whole lanes, because an idle lane is a bartender the player can
    // see standing still on the floor — that correspondence is the diagnostic.
    // A decimal ("1.0 lanes idle") reads as a rendering bug before it reads as
    // capacity, so it is rounded, and never below the 1 the threshold implies.
    const idle = Math.max(1, Math.round(station.idleLanes));
    return {
      warn: false,
      glyph: '◦',
      lead: null,
      body: `${idle} ${idle === 1 ? 'lane' : 'lanes'} idle — raise the Door, not the lanes.`,
    };
  }

  return null;
}
