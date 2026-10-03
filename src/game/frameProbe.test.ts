import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameProbe } from './frameProbe.ts';

/**
 * `FrameProbe` reads `performance.now()` inside `mark` and `endFrame`, so the
 * clock is driven by hand here. That is the only way to assert on a duty cycle
 * at all: the figure is a ratio of two durations, and with a real clock both
 * of them depend on how loaded the machine running the test happens to be.
 */
let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * One frame that does `busyMs` of main-thread work and then leaves the thread
 * idle until the next one, `frameIntervalMs` after this one began.
 */
function runFrame(probe: FrameProbe, busyMs: number, frameIntervalMs: number): void {
  const started = clock;
  probe.beginFrame(clock);
  clock += busyMs;
  probe.endFrame();
  clock = started + frameIntervalMs;
}

describe('FrameProbe duty cycle', () => {
  it('reports busy ms per second of wall clock, not per frame', () => {
    const probe = new FrameProbe();
    probe.reset();

    // 60 frames of 3 ms work each, one every 16.6667 ms: one second of wall
    // clock, 180 ms of it spent in the game. 18 % is DUB-6's 1x threshold.
    for (let i = 0; i < 60; i += 1) runFrame(probe, 3, 1000 / 60);

    const report = probe.report();
    // The window ends at the last `endFrame`, not at the last frame boundary,
    // so the denominator is 59 intervals plus the final 3 ms of work.
    expect(report.wallMs).toBeCloseTo((59 * 1000) / 60 + 3, 6);
    expect(report.busyMs).toBeCloseTo(180, 6);
    expect(report.busyPercent).toBeCloseTo(18.3, 1);
    expect(report.busyMsPerSecond).toBeCloseTo(report.busyPercent * 10, 6);
  });

  it('is unchanged when the same work is spread over half as many frames', () => {
    // The regression this protects: the sim is fixed-step with catch-up, so
    // halving the frame rate doubles the work per frame while leaving the work
    // per second alone. `avgFrameMs` moves, the duty cycle must not — that is
    // the whole reason DUB-6 gates on this field instead of on frame time.
    const fast = new FrameProbe();
    fast.reset();
    for (let i = 0; i < 120; i += 1) runFrame(fast, 2, 10);

    clock = 0;
    const slow = new FrameProbe();
    slow.reset();
    for (let i = 0; i < 60; i += 1) runFrame(slow, 4, 20);

    const a = fast.report();
    const b = slow.report();

    expect(b.avgFrameMs).toBeCloseTo(a.avgFrameMs * 2, 6);
    expect(b.busyMs).toBeCloseTo(a.busyMs, 6);
    expect(b.busyPercent).toBeCloseTo(a.busyPercent, 1);
    expect(a.busyPercent).toBeCloseTo(20, 1);
  });

  it('counts only the window since the last reset', () => {
    const probe = new FrameProbe();
    probe.reset();
    for (let i = 0; i < 30; i += 1) runFrame(probe, 12, 16);
    expect(probe.report().busyPercent).toBeGreaterThan(70);

    probe.reset();
    for (let i = 0; i < 30; i += 1) runFrame(probe, 1, 16);
    const after = probe.report();
    expect(after.busyMs).toBeCloseTo(30, 6);
    expect(after.busyPercent).toBeLessThan(10);
  });

  it('accumulates past the 240-sample ring without narrowing the denominator', () => {
    // `busyMs` is a running total rather than a ring entry precisely so that a
    // 60 s measurement at 120 Hz — 30x the ring — still divides the right two
    // numbers. A ring-based implementation passes every test above and fails
    // this one.
    const probe = new FrameProbe();
    probe.reset();
    for (let i = 0; i < 1200; i += 1) runFrame(probe, 5, 10);

    const report = probe.report();
    expect(report.frames).toBe(1200);
    expect(report.windowFrames).toBe(240);
    expect(report.busyMs).toBeCloseTo(6000, 6);
    expect(report.busyPercent).toBeCloseTo(50, 1);
  });

  it('reports a zero duty cycle rather than NaN before the first frame', () => {
    const report = new FrameProbe().report();
    expect(report.busyPercent).toBe(0);
    expect(report.busyMsPerSecond).toBe(0);
    expect(report.wallMs).toBe(0);
  });
});
