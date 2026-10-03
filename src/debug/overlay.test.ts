/**
 * The two parts of the overlay a test can reach: the `valid` verdict and the
 * freeze latch.
 *
 * DUB-10 exists because a report that was wrong in two separate ways still
 * looked complete, and the only thing standing between that happening again
 * and it not is the rule table below. DUB-12 is the same failure one layer in:
 * the panel said `FROZEN`, and three of its fields carried on moving anyway.
 * Both are "the report says something untrue about itself", and both are now
 * rules in code rather than things somebody has to notice on a phone.
 *
 * The rest of `overlay.ts` needs a DOM, a WebGL context and a frame clock —
 * `vitest` runs on the node environment, so those parts are verified by running
 * the published build in a browser and reading the panel back (see the README).
 * Neither of these two needs any of that, which is why they are shaped as
 * exported, injectable units in the first place.
 *
 * The reason strings are asserted literally, not by substring. They are what
 * the owner reads and pastes, and a reason that drifted into saying something
 * slightly untrue would be exactly the defect this is guarding.
 */

import { describe, expect, it } from 'vitest';
import {
  C1_BARTENDERS,
  C1_GUESTS,
  C1_QUEUES,
  createWindowFreeze,
  validityVerdict,
  type MeasurementWindow,
} from './overlay.ts';
import type { FrameReport } from '../game/frameProbe.ts';
import {
  STRESS_BARTENDERS,
  STRESS_GUESTS,
  STRESS_QUEUES,
} from '../game/stressScene.ts';

/** A window that passes every rule. Each test spoils exactly one thing. */
const CLEAN: MeasurementWindow = {
  armed: true,
  completed: true,
  frozen: true,
  elapsedMs: 60_000,
  hiddenBreaks: 0,
  hiddenMs: 0,
  stress: true,
  guests: C1_GUESTS,
  bartenders: C1_BARTENDERS,
  queues: C1_QUEUES,
};

function verdict(patch: Partial<MeasurementWindow>): string {
  return validityVerdict({ ...CLEAN, ...patch });
}

describe('the C1 counts the verdict checks against', () => {
  it('match the stress scene the overlay is validating', () => {
    // `overlay.ts` writes 25 / 9 / 3 out by hand rather than importing these,
    // because importing the computed `STRESS_BARTENDERS` stops Rolldown
    // dead-code-eliminating it and grows the *flag-off* bundle — see the
    // comment on `C1_GUESTS`. This assertion is the price of that: the day the
    // certification scene moves, CI fails here instead of the overlay quietly
    // validating every run against a floor the game no longer has.
    expect([C1_GUESTS, C1_BARTENDERS, C1_QUEUES]).toEqual([
      STRESS_GUESTS,
      STRESS_BARTENDERS,
      STRESS_QUEUES,
    ]);
  });
});

describe('validityVerdict', () => {
  it('passes a clean 60 s run on the C1 scene', () => {
    expect(validityVerdict(CLEAN)).toBe('yes');
  });

  it('refuses a panel nobody armed', () => {
    expect(verdict({ armed: false, completed: false, frozen: false })).toBe(
      'no — no measurement started',
    );
  });

  it('refuses a window that was copied before the minute was up', () => {
    // The real case from the owner's report: 26 s of a 60 s window.
    expect(verdict({ completed: false, elapsedMs: 26_000 })).toBe('no — copied at 26 s of 60 s');
  });

  it('distinguishes a live window from one that was copied early', () => {
    // Same defect, different event. Saying "copied at" while the panel is
    // still counting would be the overlay narrating something that has not
    // happened — which is the class of bug DUB-10 is about.
    expect(verdict({ completed: false, frozen: false, elapsedMs: 26_400 })).toBe(
      'no — still running, 26 s of 60 s',
    );
  });

  it('refuses a window the page was hidden during, and says for how long', () => {
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 8_750 })).toBe(
      'no — window was hidden for 8.8 s',
    );
  });

  it('refuses a measurement taken outside the stress scene', () => {
    expect(verdict({ stress: false })).toBe('no — scene was normal, not stress');
  });

  it('refuses a stress run whose scene drifted off the C1 counts', () => {
    expect(verdict({ guests: 18 })).toBe('no — scene was 18/9/3, not 25/9/3');
  });

  it('prints the first failure that applies, not all of them', () => {
    // Hidden *and* cut short *and* on the wrong scene. DUB-10: "Two failures:
    // print the first that applies" — the unfinished window is the more
    // fundamental fact, and a reader who fixes it re-runs anyway.
    expect(
      verdict({
        completed: false,
        elapsedMs: 12_000,
        hiddenBreaks: 2,
        hiddenMs: 5_000,
        stress: false,
      }),
    ).toBe('no — copied at 12 s of 60 s');
  });

  it('puts "no measurement started" ahead of every other failure', () => {
    expect(
      verdict({ armed: false, completed: false, frozen: false, hiddenBreaks: 3, stress: false }),
    ).toBe('no — no measurement started');
  });

  it('does not invalidate a run on an unavailable or refused wake lock', () => {
    // `wake_lock` is deliberately not an input to the verdict: it only changes
    // how likely a hidden break is, and the hidden break itself is checked
    // directly. If this ever becomes a reason, a correct measurement on a
    // browser without the API stops being reportable.
    const inputs = Object.keys(CLEAN);
    expect(inputs).not.toContain('wakeLock');
    expect(validityVerdict(CLEAN)).toBe('yes');
  });

  it('keeps every reason inside a readable width', () => {
    // The verdict row soft-wraps rather than clipping, but a reason long
    // enough to need three lines on a 390 px phone is a reason nobody reads.
    const reasons = [
      verdict({ armed: false }),
      verdict({ completed: false, elapsedMs: 26_000 }),
      verdict({ completed: false, frozen: false, elapsedMs: 26_000 }),
      verdict({ hiddenBreaks: 1, hiddenMs: 8_750 }),
      verdict({ stress: false }),
      verdict({ guests: 18, bartenders: 7, queues: 2 }),
    ];
    for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(36);
  });
});

/**
 * A `FrameReport` with the duty cycle set and everything else inert.
 *
 * `busyPercent` is derived from the other two rather than passed in, exactly as
 * `FrameProbe.report` derives it, so a test cannot assert against an internally
 * inconsistent report that the real probe could never produce.
 */
function report(busyMs: number, wallMs: number): FrameReport {
  const busyMsPerSecond = wallMs > 0 ? (busyMs / wallMs) * 1000 : 0;
  const phase = { avgMs: 0, p95Ms: 0, maxMs: 0 };
  return {
    frames: 0,
    windowFrames: 0,
    avgFrameMs: 0,
    p95FrameMs: 0,
    maxFrameMs: 0,
    estimatedFps: 0,
    overBudgetPercent: 0,
    phases: { sim: phase, scene: phase, publish: phase, gpu: phase },
    busyMs,
    wallMs,
    busyMsPerSecond,
    busyPercent: busyMsPerSecond / 10,
  };
}

describe('createWindowFreeze', () => {
  it('reads the live figures while the window is open', () => {
    let live = report(500, 10_000);
    const freeze = createWindowFreeze(() => live);

    expect(freeze.frozen).toBe(false);
    expect(freeze.instant(10_000)).toBe(10_000);
    expect(freeze.frames().wallMs).toBe(10_000);

    live = report(1_000, 20_000);
    expect(freeze.frames().wallMs).toBe(20_000);
  });

  it('latches the duty cycle at the freeze, undiluted by the idle tail', () => {
    // The real numbers from DUB-10's own verification paste, which is what
    // found this: a 60 s window reported `elapsed_s 60.0` beside
    // `busy_window_s 67.1`, so the `busy_pct 1.3` that was copied described
    // 67.1 s — the last 7 of them a frozen, idle panel. Idle time dilutes the
    // duty cycle *downward*, which made the one figure DUB-6 gates on read
    // lenient in proportion to how slow the tester was to tap "Copy report".
    let live = report(1_500, 60_000);
    const freeze = createWindowFreeze(() => live);

    freeze.freeze(60_000);

    // Seven seconds of the game still rendering while nobody is looking.
    live = report(1_520, 67_100);

    expect(freeze.frozen).toBe(true);
    expect(freeze.instant(67_100)).toBe(60_000);
    expect(freeze.frames().wallMs).toBe(60_000);
    expect(freeze.frames().busyPercent).toBeCloseTo(2.5, 6);
    expect(freeze.frames().busyMsPerSecond).toBeCloseTo(25, 6);

    // What the bug printed instead, for the record: the same work over a 12%
    // longer window.
    expect(live.busyPercent).toBeLessThan(freeze.frames().busyPercent);
  });

  it('gives a second tap on “Copy report” the first tap’s numbers', () => {
    let live = report(1_500, 26_000);
    const freeze = createWindowFreeze(() => live);

    freeze.freeze(26_000);
    const first = freeze.frames();

    live = report(4_000, 90_000);
    freeze.freeze(90_000);

    expect(freeze.instant(90_000)).toBe(26_000);
    expect(freeze.frames()).toBe(first);
  });

  it('goes back to live when “Start 60 s measurement” reopens the window', () => {
    let live = report(1_500, 60_000);
    const freeze = createWindowFreeze(() => live);

    freeze.freeze(60_000);
    freeze.thaw();
    live = report(10, 200);

    expect(freeze.frozen).toBe(false);
    expect(freeze.instant(61_000)).toBe(61_000);
    expect(freeze.frames().wallMs).toBe(200);
  });

  it('reads the frames once per freeze, not once per repaint', () => {
    // Not a performance assertion — a correctness one. A latch that re-read on
    // every access would be the original defect with more code, and the panel
    // repaints five times a second for as long as it is left on screen.
    let reads = 0;
    const freeze = createWindowFreeze(() => {
      reads += 1;
      return report(1_500, 60_000);
    });

    freeze.freeze(60_000);
    freeze.frames();
    freeze.frames();
    freeze.frames();

    expect(reads).toBe(1);
  });
});
