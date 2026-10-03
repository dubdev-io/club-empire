/**
 * How long the player was away.
 *
 * This module only measures time. It deliberately does not convert elapsed
 * time into money — the offline-earnings formula belongs to the design brief
 * (DUB-2), and baking a guess in here would mean two formulas to reconcile
 * later.
 */
export interface OfflineElapsed {
  /** Elapsed real milliseconds since `lastSeenAt`, never negative. */
  readonly elapsedMs: number;
  /** Elapsed real seconds since `lastSeenAt`, never negative. */
  readonly elapsedSeconds: number;
  /** True when `elapsedMs` was reduced by `maxElapsedMs`. */
  readonly clamped: boolean;
  /**
   * True when `lastSeenAt` is in the future — the device clock moved
   * backwards, or the save came from a device in a different timezone with a
   * wrong clock. Elapsed time is reported as 0 in that case.
   */
  readonly clockWentBackwards: boolean;
}

/**
 * Default cap on credited offline time: 8 hours.
 *
 * A cap is required regardless of the earnings formula, because a save that
 * sat untouched for a year must not produce an unbounded number. The exact
 * value is a balance decision and DUB-2 can override it via `maxElapsedMs`.
 */
export const DEFAULT_MAX_OFFLINE_MS = 8 * 60 * 60 * 1000;

export const NO_OFFLINE_ELAPSED: OfflineElapsed = {
  elapsedMs: 0,
  elapsedSeconds: 0,
  clamped: false,
  clockWentBackwards: false,
};

export function computeOfflineElapsed(
  lastSeenAt: number,
  now: number = Date.now(),
  maxElapsedMs: number = DEFAULT_MAX_OFFLINE_MS,
): OfflineElapsed {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(now)) {
    return NO_OFFLINE_ELAPSED;
  }

  const raw = now - lastSeenAt;

  // Clock moved backwards (user changed it, or NTP corrected a fast clock).
  // Report zero rather than a negative number so no consumer has to guard.
  if (raw < 0) {
    return {
      elapsedMs: 0,
      elapsedSeconds: 0,
      clamped: false,
      clockWentBackwards: true,
    };
  }

  const clamped = raw > maxElapsedMs;
  const elapsedMs = clamped ? maxElapsedMs : raw;

  return {
    elapsedMs,
    elapsedSeconds: elapsedMs / 1000,
    clamped,
    clockWentBackwards: false,
  };
}
