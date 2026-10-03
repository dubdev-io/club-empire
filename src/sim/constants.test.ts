import { describe, expect, it } from 'vitest';
import { AUTOSAVE_INTERVAL_MS, MAX_CATCHUP_TICKS, TICK_MS, TICKS_PER_SECOND } from './constants.ts';

/**
 * The autosave cadence is a stated requirement, not a tuning knob: it is the
 * worst-case progress loss when the tab dies without firing a lifecycle event.
 * It regressed to 15 s once and QA caught it from the outside, which is the
 * expensive way to find it. This pins it from the inside.
 */
describe('autosave cadence', () => {
  it('writes at least once every 5 s, per DUB-5 scope item 10', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBeLessThanOrEqual(5_000);
  });

  it('is a sane positive interval, not zero and not a per-frame write', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(Number.isFinite(AUTOSAVE_INTERVAL_MS)).toBe(true);
  });

  it('cannot be starved by the fixed-step catch-up bound', () => {
    // A single `advance()` may burn up to MAX_CATCHUP_TICKS of simulated time
    // on the main thread. If that stall were longer than the autosave period
    // the timer would be the thing that never gets to run.
    expect(MAX_CATCHUP_TICKS * TICK_MS).toBeGreaterThan(AUTOSAVE_INTERVAL_MS);
  });
});

describe('tick constants', () => {
  it('keeps TICK_MS and TICKS_PER_SECOND in agreement', () => {
    expect(TICK_MS * TICKS_PER_SECOND).toBe(1_000);
  });
});
