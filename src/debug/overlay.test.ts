/**
 * The `valid` verdict, which is the one part of the overlay a test can reach.
 *
 * DUB-10 exists because a report that was wrong in two separate ways still
 * looked complete, and the only thing standing between that happening again
 * and it not is the rule table below. Everything else in `overlay.ts` needs a
 * DOM, a WebGL context and a frame clock — `vitest` runs on the node
 * environment, so those parts are verified by running the published build in a
 * browser and reading the panel back (see the README). This part does not need
 * any of that, so it is checked here rather than by eye on a phone, which is
 * the whole argument of the ticket applied to its own code.
 *
 * The reason strings are asserted literally, not by substring. They are what
 * the owner reads and pastes, and a reason that drifted into saying something
 * slightly untrue would be exactly the defect this is guarding.
 */

import { describe, expect, it } from 'vitest';
import { validityVerdict, type MeasurementWindow } from './overlay.ts';
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
  guests: STRESS_GUESTS,
  bartenders: STRESS_BARTENDERS,
  queues: STRESS_QUEUES,
};

function verdict(patch: Partial<MeasurementWindow>): string {
  return validityVerdict({ ...CLEAN, ...patch });
}

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
