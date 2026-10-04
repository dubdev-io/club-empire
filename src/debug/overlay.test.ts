/**
 * The four parts of the overlay a test can reach: the `valid` verdict, the
 * freeze latch, the duty-cycle correction and the wake-lock holder.
 *
 * DUB-10 exists because a report that was wrong in two separate ways still
 * looked complete, and the only thing standing between that happening again
 * and it not is the rule table below. DUB-12 is the same failure one layer in:
 * the panel said `FROZEN`, and three of its fields carried on moving anyway.
 * DUB-14 is both at once — a tolerance that would have made `busy_pct` read
 * low, and a wake lock that could leak a sentinel and then describe a window
 * that had already ended. All of them are "the report says something untrue
 * about itself", and all of them are now rules in code rather than things
 * somebody has to notice on a phone.
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
  createWakeLockHolder,
  createWindowFreeze,
  dutyCycle,
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

  // --- the hidden tolerance (DUB-14) --------------------------------------
  //
  // DUB-10's rule was `hiddenBreaks > 0`, which voided a full minute of good
  // frames because a notification sheet appeared for a second. The owner had
  // lost two attempts to measurement mechanics by then, so the rule now runs
  // on the total against `HIDDEN_TOLERANCE_MS` (3 s). The boundary cases are
  // asserted rather than described because the constant lives in `overlay.ts`
  // and is not exported — these tests are what pins it.
  it('tolerates a one-second interruption, and still reports it', () => {
    // The case the tolerance exists for: one glance at the clock. The deadline
    // moved out by the second it was away (see `onVisibilityChange`), so this
    // is a full minute of real frames with a second of wall clock absorbed.
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 1_000 })).toBe('yes');
    // `valid yes` is not permission to stop printing what happened: both
    // `hidden_breaks` and `hidden_s` are unconditional rows in `buildReport`,
    // so this run reports `hidden_breaks 1` / `hidden_s 1.0` and a reader can
    // judge it. That formatting needs a DOM and is verified in the browser;
    // what is checked here is that a tolerated run is *reported*, by the
    // verdict not being allowed to launder it into an unremarkable `yes`.
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 1_000 })).not.toContain('hidden');
  });

  it('tolerates several small interruptions that stay under the budget', () => {
    // Four accidental swipes of 600 ms. The old rule voided on the first.
    expect(verdict({ hiddenBreaks: 4, hiddenMs: 2_400 })).toBe('yes');
  });

  it('voids on the total, not the count', () => {
    // 3.5 s in one break: over budget, so the run is void — and the reason
    // still quotes the total, which is the number the rule was decided on.
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 3_500 })).toBe(
      'no — window was hidden for 3.5 s',
    );
    // The same 3.5 s split three ways is just as void. The count is reported,
    // never decisive.
    expect(verdict({ hiddenBreaks: 3, hiddenMs: 3_500 })).toBe(
      'no — window was hidden for 3.5 s',
    );
  });

  it('holds the tolerance exactly at the budget', () => {
    // 3000 ms is tolerated and 3001 is not. Spelled out because `>` versus
    // `>=` here is the difference between a rule and a rule nobody can predict.
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 3_000 })).toBe('yes');
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 3_001 })).toBe(
      'no — window was hidden for 3.0 s',
    );
  });

  it('still voids a locked screen', () => {
    // The failure DUB-10 was written for, and the one the tolerance must not
    // reach: a minute split across a screen lock is two different thermal
    // conditions averaged together, which is not a measurement of either.
    expect(verdict({ hiddenBreaks: 1, hiddenMs: 30_000 })).toBe(
      'no — window was hidden for 30.0 s',
    );
  });

  it('does not let a tolerated interruption rescue an unfinished window', () => {
    // Precedence is unchanged: hidden time is checked after completion, so
    // absorbing a second does not make a window that was copied at 12 s valid.
    expect(verdict({ completed: false, elapsedMs: 12_000, hiddenMs: 1_000 })).toBe(
      'no — copied at 12 s of 60 s',
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

describe('dutyCycle', () => {
  it('leaves an uninterrupted window exactly as the probe measured it', () => {
    // 9 s of work in 60 s of wall clock: 15 %. With nothing hidden the
    // correction has to be the identity, or every clean C1 reading taken
    // before DUB-14 stops comparing to one taken after it.
    const busy = dutyCycle(report(9_000, 60_000), 0);
    expect(busy.busyPercent).toBeCloseTo(15, 10);
    expect(busy.busyMsPerSecond).toBeCloseTo(150, 10);
    expect(busy.windowMs).toBe(60_000);
  });

  it('takes absorbed hidden time out of the denominator', () => {
    // The same 9 s of work, but 2 s of the window was a notification sheet
    // with no frames in it. The duty cycle is work per second of *measured*
    // wall clock, so the denominator is 58 s and the figure goes **up**.
    const busy = dutyCycle(report(9_000, 60_000), 2_000);
    expect(busy.windowMs).toBe(58_000);
    expect(busy.busyPercent).toBeCloseTo((9_000 / 58_000) * 100, 10);
    // Up, not down. This is the whole reason the correction exists: leaving
    // the hidden 2 s in reads 15.0 % against a true 15.5 %, and a tolerance
    // that quietly bought a 3 % softer gate would be DUB-12's dilution bug
    // arriving by a different route.
    expect(busy.busyPercent).toBeGreaterThan(report(9_000, 60_000).busyPercent);
  });

  it('keeps busy_pct and busy_ms_per_s the same figure', () => {
    // `busy_pct` is `busy_ms_per_s / 10` by definition, and the README tells a
    // reader to do arithmetic with the pair. They must not drift apart here.
    const busy = dutyCycle(report(7_431, 60_000), 1_250);
    expect(busy.busyPercent).toBeCloseTo(busy.busyMsPerSecond / 10, 10);
  });

  it('reports the corrected window, because that is the denominator', () => {
    // `busy_window_s` is on the report so `busy_pct` can be checked by hand.
    // It therefore has to be the number actually divided by — on a tolerated
    // run it falls short of `elapsed_s` by `hidden_s`, which is a cross-check
    // a reader can complete rather than a mismatch nobody can account for.
    const busy = dutyCycle(report(1_000, 60_000), 1_400);
    expect(busy.windowMs).toBe(58_600);
    // Completable by hand off the printed rows: busy_ms_per_s * busy_window_s
    // is the work, to the precision the report prints them at.
    expect((busy.busyMsPerSecond * busy.windowMs) / 1000).toBeCloseTo(1_000, 6);
  });

  it('refuses to invent a duty cycle for a window with no measured time', () => {
    // Hidden time is counted from `visibilitychange` and `wallMs` from the
    // game's own frames, so in principle the two can disagree at the edge of a
    // window. Zero is the honest answer to "work per second of no seconds"; a
    // negative denominator would print a plausible-looking nonsense figure,
    // which is the one thing this overlay does not do.
    expect(dutyCycle(report(1_000, 60_000), 60_000)).toEqual({
      busyPercent: 0,
      busyMsPerSecond: 0,
      windowMs: 0,
    });
    expect(dutyCycle(report(1_000, 60_000), 90_000)).toEqual({
      busyPercent: 0,
      busyMsPerSecond: 0,
      windowMs: 0,
    });
    expect(dutyCycle(report(0, 0), 0)).toEqual({
      busyPercent: 0,
      busyMsPerSecond: 0,
      windowMs: 0,
    });
  });
});

/**
 * A wake lock that hands out sentinels on demand, so a test can decide *when*
 * each request settles.
 *
 * That control is the entire point: both DUB-14 faults are about a promise
 * resolving at a moment nobody expected it to, and a fake that resolved
 * immediately could not express either of them.
 */
function fakeWakeLock(): {
  readonly api: WakeLock;
  /** Settle the nth outstanding request, and return the sentinel it produced. */
  grant(index: number): FakeSentinel;
  /** Reject the nth outstanding request. */
  refuse(index: number): void;
  readonly requests: number;
} {
  const pending: { grant: (s: FakeSentinel) => void; refuse: () => void }[] = [];
  // `WakeLock` is satisfied structurally — it is the one-method interface
  // `request(type?)`. `WakeLockSentinel` is not: it is a full `EventTarget`
  // with `released`, `type` and `onrelease`, and `FakeSentinel` deliberately
  // implements only the two members the holder touches, so that a holder which
  // started relying on a third member would fail to compile here rather than
  // pass against a stub that quietly grew to match it.
  const api: WakeLock = {
    request: () =>
      new Promise<WakeLockSentinel>((resolve, reject) => {
        pending.push({
          grant: (sentinel) => resolve(sentinel as unknown as WakeLockSentinel),
          refuse: () => reject(new Error('denied')),
        });
      }),
  };

  return {
    api,
    grant(index) {
      const sentinel = new FakeSentinel();
      pending[index]!.grant(sentinel);
      return sentinel;
    },
    refuse(index) {
      pending[index]!.refuse();
    },
    get requests() {
      return pending.length;
    },
  };
}

/** Just enough `WakeLockSentinel` to see whether it was released. */
class FakeSentinel {
  released = 0;
  private listeners: (() => void)[] = [];

  release(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }

  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }

  /** What the browser does when the document becomes hidden. */
  autoRelease(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Let every already-settled promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createWakeLockHolder', () => {
  it('says nothing until a lock has been asked for', () => {
    // The row is absent, not `unavailable`: before "Start" there is no outcome
    // to report, and `unavailable` there claimed the API was missing on every
    // browser that has it.
    expect(createWakeLockHolder(() => undefined).state).toBeNull();
  });

  it('reports an engine without the API as unavailable', () => {
    const holder = createWakeLockHolder(() => undefined);
    holder.request();
    expect(holder.state).toBe('unavailable');
  });

  it('is pessimistic while a request is in flight', () => {
    // The field must never claim a lock is held before the browser grants it.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);
    holder.request();
    expect(holder.state).toBe('refused');
  });

  it('reports a granted lock as held', async () => {
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);
    holder.request();
    lock.grant(0);
    await settle();
    expect(holder.state).toBe('held');
  });

  it('releases the first sentinel when a second tap supersedes it', async () => {
    // The leak. `request` used to call `release` first, but that only released
    // a sentinel that had *already resolved* — so two taps before the first
    // `request('screen')` settled left the first lock held forever, the screen
    // awake past the end of the window, and `wake_lock` describing a lock that
    // was not this window's.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    holder.request();
    expect(lock.requests).toBe(2);

    const first = lock.grant(0);
    const second = lock.grant(1);
    await settle();

    expect(first.released).toBe(1);
    expect(second.released).toBe(0);
    expect(holder.state).toBe('held');
  });

  it('drops a request that settles after the window was released', async () => {
    // DUB-12's own argument, in the eighth field. "Copy report" releases the
    // lock and freezes the panel; a request settling afterwards used to write
    // `held` onto a frozen report, and a second copy printed it.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    holder.release();
    const late = lock.grant(0);
    await settle();

    expect(holder.state).toBe('refused');
    // And it does not leak either: a result nobody wants is still a lock on
    // the user's screen until someone releases it.
    expect(late.released).toBe(1);
  });

  it('drops a rejection that settles after the window was released', async () => {
    // The same untruth mirrored: the previous window's `refused` must not
    // overwrite the current window's `held`.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    holder.request();
    lock.grant(1);
    await settle();
    expect(holder.state).toBe('held');

    lock.refuse(0);
    await settle();
    expect(holder.state).toBe('held');
  });

  it('keeps held through the overlay’s own release at the end of a window', async () => {
    // DUB-12's detach-before-release ordering, which DUB-14 does not change. A
    // window that ran its full minute with the lock in hand reads `held`,
    // because that is what was true throughout it.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    const sentinel = lock.grant(0);
    await settle();

    holder.release();
    expect(sentinel.released).toBe(1);
    expect(holder.state).toBe('held');
  });

  it('reports released when the browser takes the lock back', async () => {
    // The browser drops a screen lock by itself when the document becomes
    // hidden and says so only through this event. Without it the field went on
    // reading `held` while the screen was free to sleep.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    const sentinel = lock.grant(0);
    await settle();

    sentinel.autoRelease();
    expect(holder.state).toBe('released');
  });

  it('does not let an auto-release from a superseded lock speak for this window', async () => {
    // The generation guard and the `release` listener answer different
    // questions, which is why both are needed: "is this result still ours" and
    // "did the browser take it back". A stale sentinel firing `release` must
    // not turn the live window's `held` into `released`.
    const lock = fakeWakeLock();
    const holder = createWakeLockHolder(() => lock.api);

    holder.request();
    const first = lock.grant(0);
    await settle();

    holder.request();
    lock.grant(1);
    await settle();
    expect(holder.state).toBe('held');

    first.autoRelease();
    expect(holder.state).toBe('held');
  });
});
