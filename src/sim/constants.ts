/** Economy ticks per real second. The simulation never runs at any other rate. */
export const TICKS_PER_SECOND = 10;

/** Milliseconds of simulated time advanced by one economy tick. */
export const TICK_MS = 1000 / TICKS_PER_SECOND;

/** Seconds of simulated time advanced by one economy tick. */
export const TICK_SECONDS = 1 / TICKS_PER_SECOND;

/**
 * Upper bound on ticks executed in a single `advance()` call.
 *
 * Without a bound, a long stall (a backgrounded tab, a device waking from
 * sleep) hands the loop a multi-hour delta and the catch-up pass blocks the
 * main thread until it finishes. Offline progress is handled separately, by
 * the offline-elapsed path, not by replaying hours of ticks in one frame.
 *
 * 600 ticks is 60 s of simulated time — enough to swallow any realistic
 * foreground hitch.
 */
export const MAX_CATCHUP_TICKS = 600;

/** Portrait design resolution. Everything on the Pixi stage is authored at this size. */
export const DESIGN_WIDTH = 390;
export const DESIGN_HEIGHT = 844;
