/**
 * Offline earnings (§5).
 *
 * `src/sim/offline.ts` measures time; this converts it into money. The split is
 * deliberate — the clock rules (negative deltas, a device that slept) are a
 * different kind of problem from the balance rules (rate, cap, threshold) and
 * they are tested separately.
 *
 * What this module deliberately does *not* have, because §5 forbids it: a
 * doubling option, an ad hook, a countdown, a decay term, or any notion of the
 * club "dying" while the player was away. The club simply carried on at half
 * rate for up to ten minutes.
 */

import { OFFLINE_CAP_SECONDS, OFFLINE_MIN_SECONDS_TO_SHOW, OFFLINE_RATE } from '../config/economy.ts';
import { computeOfflineElapsed, type OfflineElapsed } from './offline.ts';

export interface OfflineEarnings {
  /** True elapsed time away, uncapped. This is the "You were away 2h 14m" line. */
  readonly awaySeconds: number;
  /** Seconds actually paid for: `min(awaySeconds, OFFLINE_CAP_SECONDS)`. */
  readonly creditedSeconds: number;
  /** True when the cap bit, which is what shows the "Capped at 10 min" line. */
  readonly capped: boolean;
  readonly amount: number;
  /** False below the 30 s threshold, or when there is nothing to pay. */
  readonly show: boolean;
  /** The device clock moved backwards. Credited as zero, never as a negative. */
  readonly clockWentBackwards: boolean;
}

export const NO_OFFLINE_EARNINGS: OfflineEarnings = {
  awaySeconds: 0,
  creditedSeconds: 0,
  capped: false,
  amount: 0,
  show: false,
  clockWentBackwards: false,
};

/**
 * Elapsed real time since `lastSeenAt`, with no cap applied.
 *
 * The §5 cap is on *credited* time, not on measured time: the card says "You
 * were away 2h 14m" and then pays ten minutes of it. Clamping the measurement
 * would make the first line a lie, so the cap is applied downstream, here.
 */
export function offlineElapsedSince(lastSeenAt: number, now: number = Date.now()): OfflineElapsed {
  return computeOfflineElapsed(lastSeenAt, now, Number.POSITIVE_INFINITY);
}

/**
 * Apply the §5 rule.
 *
 * `incomePerSecond` must be the rate **at the moment of leaving**, measured
 * unboosted. Last Call is excluded by construction: it is a 30-second buff
 * fired by tapping, and paying it out for ten minutes of a closed tab would
 * make putting the phone down the optimal way to use it.
 */
export function computeOfflineEarnings(
  incomePerSecond: number,
  elapsed: OfflineElapsed,
): OfflineEarnings {
  const rate = Number.isFinite(incomePerSecond) && incomePerSecond > 0 ? incomePerSecond : 0;
  const awaySeconds = elapsed.elapsedSeconds;

  const capped = awaySeconds > OFFLINE_CAP_SECONDS;
  const creditedSeconds = capped ? OFFLINE_CAP_SECONDS : awaySeconds;
  const amount = rate * OFFLINE_RATE * creditedSeconds;

  return {
    awaySeconds,
    creditedSeconds,
    capped,
    amount,
    // Both conditions matter. Under 30 s is a tab switch, not a night away;
    // and a club earning nothing has nothing to report, so showing a "£0"
    // card would be noise at exactly the moment the player is least able to
    // do anything about it.
    show: awaySeconds >= OFFLINE_MIN_SECONDS_TO_SHOW && amount > 0,
    clockWentBackwards: elapsed.clockWentBackwards,
  };
}

/** Convenience for the boot path: measure and price in one step. */
export function offlineEarningsSince(
  incomePerSecond: number,
  lastSeenAt: number,
  now: number = Date.now(),
): OfflineEarnings {
  return computeOfflineEarnings(incomePerSecond, offlineElapsedSince(lastSeenAt, now));
}
