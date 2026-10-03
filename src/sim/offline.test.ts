import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_OFFLINE_MS, computeOfflineElapsed } from './offline.ts';

describe('computeOfflineElapsed', () => {
  it('reports elapsed time since lastSeenAt', () => {
    const result = computeOfflineElapsed(1_000_000, 1_000_000 + 90_000);
    expect(result.elapsedMs).toBe(90_000);
    expect(result.elapsedSeconds).toBe(90);
    expect(result.clamped).toBe(false);
    expect(result.clockWentBackwards).toBe(false);
  });

  it('reports zero, not a negative number, when the clock moved backwards', () => {
    const result = computeOfflineElapsed(2_000_000, 1_000_000);
    expect(result.elapsedMs).toBe(0);
    expect(result.elapsedSeconds).toBe(0);
    expect(result.clockWentBackwards).toBe(true);
  });

  it('clamps an unbounded absence to the cap', () => {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const result = computeOfflineElapsed(0, oneYearMs);
    expect(result.elapsedMs).toBe(DEFAULT_MAX_OFFLINE_MS);
    expect(result.clamped).toBe(true);
  });

  it('treats a non-finite timestamp as no offline time', () => {
    expect(computeOfflineElapsed(Number.NaN, 1000).elapsedMs).toBe(0);
    expect(computeOfflineElapsed(1000, Number.POSITIVE_INFINITY).elapsedMs).toBe(0);
  });
});
