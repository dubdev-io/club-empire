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

/**
 * How often the save is written while the tab is in the foreground.
 *
 * 5 s is the DUB-5/DUB-6 requirement, and it is the worst-case progress loss
 * for a crash or an OS tab kill that fires no lifecycle event. The lifecycle
 * handlers (`visibilitychange`, `pagehide`) cover every *graceful* exit; this
 * interval exists only for the ungraceful ones, so it is deliberately
 * wall-clock rather than simulation time — a backgrounded tab must not keep
 * writing, and a throttled timer there is the correct behaviour.
 */
export const AUTOSAVE_INTERVAL_MS = 5_000;
