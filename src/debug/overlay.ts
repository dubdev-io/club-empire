/**
 * The `?debug=1` frame-rate overlay (DUB-9).
 *
 * This is a measurement instrument, not a feature, and it is built to five
 * rules that follow from that.
 *
 * **1. It costs nothing when the flag is off.** This module is reached only by
 * a dynamic `import()` in `main.tsx`, so Rolldown emits it as its own chunk and
 * the browser never fetches it in normal play. Every DOM node, every listener
 * and the `rAF` hook below are created inside `mountDebugOverlay` — there is no
 * top-level side effect, so even importing this file does nothing until it is
 * called. Its CSS is injected from here for the same reason.
 *
 * **2. It measures the frame, not itself.** The sampling loop allocates
 * nothing: frame times go into pre-sized typed arrays, the scene counts are
 * written into one reused object, and the text is rebuilt five times a second
 * rather than sixty. A probe that triggers GC is measuring its own garbage —
 * dropped frames are a tail problem and GC pauses are what the tail is made of.
 *
 * **3. It never lies about what it does not know.** `heap_mb` is a
 * Chrome-only, non-standard API and prints `n/a` on WebKit rather than
 * guessing. `draw_calls` needs the WebGL context and prints `n/a` if Pixi came
 * up on WebGPU or software canvas. The whole point of DUB-8 was to get *one
 * honest number* off a real phone, which a plausible-looking fabrication would
 * defeat.
 *
 * **4. The gating number is `busy_pct`, not `fps`.** QA showed the container
 * frame rate moves 3.4x on `deviceScaleFactor` alone with the build held
 * constant, so it cannot carry a build-to-build regression gate. Main-thread
 * busy ms per second of wall clock can, and the sim being fixed-step is
 * exactly why: the work per wall-clock second is the invariant and the work
 * per frame is not. `fps` stays, because on the owner's iPhone it is a real
 * device number and this ticket exists to get one — but it has to be read
 * next to `dpr` and `canvas_px` to mean anything, which is why they are here.
 *
 * **5. A report that cannot be trusted says so on its first line (DUB-10).**
 * The first run of this overlay came back from the owner with
 * `frame_ms_max 8750` and `frame_ms_mean 23.11` over 26 s — the phone had been
 * put face down, `rAF` had stopped, and the gap had been recorded as one giant
 * frame. The numbers were wrong and the panel carried on looking complete,
 * which is rule 3 failing one level up: it was not lying about a field, it was
 * lying about the report. So the window is now visibility-aware (the frame that
 * spans a hidden period is discarded, not averaged), and a single `valid` row
 * states the verdict and the shortest true reason it failed. The device is
 * printed as facts — `ua`, `viewport_css`, `touch_points` — because the same
 * report also turned out to be from desktop Chrome, and the only tells were
 * `canvas_css` and the mere presence of `heap_mb`.
 *
 * **6. A frozen report is frozen in every field (DUB-12).** Freezing the panel
 * is a claim about the report, not about the panel: it says "these numbers
 * describe the window that just ended". Three fields did not honour it.
 * `busy_pct`, `busy_ms_per_s` and `busy_window_s` were read live from
 * `debug.frames()` on every repaint, and the game keeps running after the panel
 * stops — so a 60 s run copied seven seconds later reported `elapsed_s 60.0`
 * next to `busy_window_s 67.1`, and the duty cycle printed above it had been
 * diluted by seven seconds of idle. The direction is what makes it serious:
 * idle time pushes `busy_pct` *down*, and `busy_pct` is the figure DUB-6 gates
 * on, so the slower you were to tap "Copy report" the better the build looked.
 * `createWindowFreeze` below is the answer, and the reason it is one object
 * rather than three more `let`s: the bug was a freeze path that pinned two of
 * the things it owed and forgot the third, so there is now exactly one place
 * that can be forgotten and it is covered by a test.
 *
 * Field names are a contract: QA reads them off this overlay for the DUB-6 C1
 * frame-budget numbers. They are listed in the README and must not be renamed
 * without saying so on DUB-6. New fields may be added; existing ones keep both
 * their name and their meaning.
 */

import type { FrameReport } from '../game/frameProbe.ts';
import type { GameRuntime } from '../game/runtime.ts';
import type { RenderCounts } from '../render/clubScene.ts';

/**
 * The C1 floor the `valid` verdict checks against: 25 guests, 9 bartenders,
 * 3 queues.
 *
 * Written out here rather than imported from `game/stressScene.ts`, which is
 * where they really live, and that is a deliberate trade rather than an
 * oversight. `STRESS_BARTENDERS` there is computed — `STATION_DEFS.length *
 * MAX_LANES` — so with nothing referencing it, Rolldown drops the binding from
 * the main bundle entirely. A reference from this chunk brings it back, and the
 * *flag-off* bundle grows by 15 bytes it did not have before. DUB-10's one
 * hard constraint is that the build behind the published URL stays the Phase 1
 * review build plus this overlay, and 15 bytes of otherwise-dead constant in
 * the chunk every player downloads is still not that.
 *
 * The coupling is enforced in `overlay.test.ts` instead, which asserts these
 * three against the real `STRESS_*` constants. The test is not bundled, so it
 * costs the player nothing, and the day the C1 scene moves, CI says so rather
 * than the overlay quietly validating against the old floor.
 */
export const C1_GUESTS = 25;
export const C1_BARTENDERS = 9;
export const C1_QUEUES = 3;

/** Length of the 60 s measurement, in ms. The number DUB-9 asks for. */
const MEASURE_MS = 60_000;

/** The same length in whole seconds, for the `valid` reason text. */
const MEASURE_S = MEASURE_MS / 1000;

/**
 * Frame-time samples kept per window.
 *
 * 8192 covers 60 s at 120 Hz with room to spare, which matters because
 * `fps_p1_worst` is a percentile over the *whole* window — a ring buffer that
 * wrapped would quietly turn "slowest 1% of the 60 s run" into "slowest 1% of
 * the last few seconds", and the stutter it is there to catch usually happens
 * once.
 */
const MAX_SAMPLES = 8192;

/** Timestamps kept for the 1 s rolling average. 256 covers 1 s at 240 Hz. */
const RECENT = 256;

/** How often the text is rebuilt. 5 Hz is readable and 12x cheaper than per-frame. */
const REDRAW_MS = 200;

export interface DebugOverlayInfo {
  /** Short commit SHA, injected at build time. */
  readonly build: string;
  /** True when `stress=1` put the game into the DUB-6 C1 scene. */
  readonly stress: boolean;
}

export interface DebugOverlay {
  destroy(): void;
}

/**
 * Chrome's non-standard heap readout. Absent on WebKit and on Firefox.
 *
 * Typed locally rather than declared as a global so nothing outside this file
 * can come to depend on it existing.
 */
interface ChromeMemory {
  readonly usedJSHeapSize: number;
}

/**
 * Everything the `valid` verdict is allowed to depend on.
 *
 * A plain record rather than the overlay's live closure state, for one reason:
 * the verdict is the only piece of this module that can be tested without a
 * WebGL context, a DOM or a frame clock, and it is also the piece most likely
 * to be read wrong. `vitest` runs on the node environment, so if the rules
 * lived inside `mountDebugOverlay` they would be checked by eye on a phone —
 * which is the thing DUB-10 exists to stop doing.
 */
export interface MeasurementWindow {
  /** "Start 60 s measurement" has been tapped at least once. */
  readonly armed: boolean;
  /** The full 60 s elapsed and the panel froze itself. */
  readonly completed: boolean;
  /** The panel has stopped updating, whether by timeout or by "Copy report". */
  readonly frozen: boolean;
  /** Wall clock since the window opened. */
  readonly elapsedMs: number;
  /** Hidden periods seen while sampling. */
  readonly hiddenBreaks: number;
  /** Total time the page spent hidden during the window. */
  readonly hiddenMs: number;
  /** `stress=1` was on the URL. */
  readonly stress: boolean;
  /** Worst scene counts seen during the window — see `noteScene`. */
  readonly guests: number;
  readonly bartenders: number;
  readonly queues: number;
}

/**
 * The value of the `valid` row: `yes`, or `no — <shortest true reason>`.
 *
 * The order of the checks is the order DUB-10 specifies, and it is not
 * arbitrary — it runs from "there is no measurement here at all" down to "the
 * measurement is real but the scene was wrong", so the first reason printed is
 * always the most fundamental thing wrong with the report. Two failures print
 * one line, because a reader who fixes the first will re-run anyway.
 *
 * Note what is deliberately *not* here: `wake_lock`. A refused screen lock is
 * not a defect in the measurement, only a raised probability of one, and the
 * defect it raises the probability of (`hidden_breaks`) is already checked
 * directly. Invalidating on it would make a correct run on a browser without
 * the API unreportable.
 */
export function validityVerdict(measured: MeasurementWindow): string {
  if (!measured.armed) return 'no — no measurement started';

  if (!measured.completed) {
    const seconds = Math.round(measured.elapsedMs / 1000);
    // "copied at" only when it is true. A live panel mid-run has the same
    // defect — an unfinished window — but nobody has copied anything yet, and
    // a report that invents an event is the failure this ticket is about.
    return measured.frozen
      ? `no — copied at ${seconds} s of ${MEASURE_S} s`
      : `no — still running, ${seconds} s of ${MEASURE_S} s`;
  }

  if (measured.hiddenBreaks > 0) {
    return `no — window was hidden for ${(measured.hiddenMs / 1000).toFixed(1)} s`;
  }

  // The C1 numbers are only C1 numbers if they were taken on the C1 floor.
  // `?debug=1` on its own is a useful read-out and an invalid measurement.
  if (!measured.stress) return 'no — scene was normal, not stress';

  if (
    measured.guests !== C1_GUESTS ||
    measured.bartenders !== C1_BARTENDERS ||
    measured.queues !== C1_QUEUES
  ) {
    return (
      `no — scene was ${measured.guests}/${measured.bartenders}/${measured.queues}, ` +
      `not ${C1_GUESTS}/${C1_BARTENDERS}/${C1_QUEUES}`
    );
  }

  return 'yes';
}

/**
 * Everything a frozen report has to stop reading live.
 *
 * There are two ways a window stops — the 60 s deadline and "Copy report" — and
 * before DUB-12 each of them pinned the window clock by hand and left the
 * duty-cycle trio to be re-read from `debug.frames()` on the next repaint. That
 * is not a typo-sized mistake; it is the shape of the code inviting one, and the
 * second freeze path duly took the invitation. So the latch is a single value
 * that owns *all* of it: a freeze path either calls `freeze` or it does not, and
 * there is no way to pin half a report.
 *
 * Exported, with the live readout injected as `readFrames`, for the same reason
 * `validityVerdict` is: `vitest` runs on the node environment, and this is now
 * the second piece of the overlay that can be checked without a DOM, a WebGL
 * context or a frame clock instead of by eye on a phone.
 */
export interface WindowFreeze {
  /** True once the window has stopped, whether by deadline or by copy. */
  readonly frozen: boolean;
  /**
   * Stop the window as of `at`.
   *
   * Only the first call does anything. A second tap on "Copy report" has to
   * hand over the report the first tap did — the same `elapsed_s`, the same
   * `busy_pct` — rather than the same run measured over a longer idle tail.
   */
  freeze(at: number): void;
  /** Reopen for a fresh measurement. */
  thaw(): void;
  /** The instant the report describes: the freeze, or `now` while live. */
  instant(now: number): number;
  /** The duty-cycle and phase readout the report describes. */
  frames(): FrameReport;
}

export function createWindowFreeze(readFrames: () => FrameReport): WindowFreeze {
  let at: number | null = null;
  /**
   * `FrameProbe.report()` builds a fresh object every call and never mutates
   * one it has handed out, so holding the reference is enough — no copy, and no
   * risk of the latched numbers being edited underneath us by the next frame.
   */
  let latched: FrameReport | null = null;

  return {
    get frozen(): boolean {
      return at !== null;
    },
    freeze(when: number): void {
      if (at !== null) return;
      at = when;
      latched = readFrames();
    },
    thaw(): void {
      at = null;
      latched = null;
    },
    instant(now: number): number {
      return at ?? now;
    },
    frames(): FrameReport {
      return latched ?? readFrames();
    },
  };
}

/**
 * What the screen wake lock did, as reported by `wake_lock`.
 *
 * `released` is the DUB-12 addition and it is a distinct outcome, not a tidier
 * word for `refused`: the browser drops a screen lock by itself when the
 * document becomes hidden, and without observing the sentinel's `release` event
 * the field went on claiming `held` after the OS had taken it away. The state
 * only ever means *the browser* released it — see `releaseWakeLock`, which
 * detaches the sentinel before releasing so the overlay's own release at the end
 * of a window does not overwrite the `held` that was true throughout it.
 *
 * There is deliberately no fourth state for "not requested yet". Before a
 * measurement is armed the row is simply absent (see `buildReport`), because
 * `unavailable` there was the overlay answering a question nobody had asked —
 * and answering it wrongly, with "the API is not here" on every browser that
 * has it.
 */
type WakeLockState = 'held' | 'refused' | 'released' | 'unavailable';

export function mountDebugOverlay(runtime: GameRuntime, info: DebugOverlayInfo): DebugOverlay {
  const debug = runtime.debug;

  // --- sampling state -----------------------------------------------------
  const samples = new Float32Array(MAX_SAMPLES);
  const recent = new Float64Array(RECENT);
  const sorted = new Float32Array(MAX_SAMPLES);
  const counts: RenderCounts = { guests: 0, bartenders: 0, queues: 0, particles: 0 };

  let sampleCount = 0;
  let dropped = 0;
  let recentCursor = 0;
  let recentFilled = 0;

  let windowStart = performance.now();
  let lastFrameAt = windowStart;
  let lastRedrawAt = 0;
  /** Set when "Start 60 s measurement" is armed; null when free-running. */
  let measureUntil: number | null = null;
  /**
   * The window clock and the duty-cycle readout, latched together.
   *
   * `freeze.frozen` is the panel's frozen flag — there is no separate boolean,
   * so a path that stops the panel cannot stop it without also pinning the
   * numbers it is about to print.
   */
  const freeze = createWindowFreeze(() => debug.frames());
  let peakFps = 0;
  let status = 'free-running — tap “Start 60 s measurement” to take a reading';

  // --- window integrity (DUB-10) ------------------------------------------
  /** "Start 60 s measurement" has been tapped at least once. */
  let armed = false;
  /** The 60 s ran out and the panel froze itself, rather than being copied early. */
  let completed = false;
  /** Hidden periods during the current window, and their total duration. */
  let hiddenBreaks = 0;
  let hiddenMs = 0;
  /** `performance.now()` at which the page went hidden; 0 when visible. */
  let hiddenAt = 0;
  /**
   * Set when visibility returns, cleared by the next frame.
   *
   * That frame's delta is the length of the hidden period plus a real frame,
   * which is not a frame time and must not reach `samples`. On the owner's
   * report it was 8750 ms and it moved the mean by 9 ms on its own.
   */
  let discardNextFrame = false;
  /** Latched first non-C1 scene seen while measuring — see `noteScene`. */
  let sceneBroke = false;
  let brokeGuests = 0;
  let brokeBartenders = 0;
  let brokeQueues = 0;

  /**
   * Null until "Start 60 s measurement" asks for a lock, and the row is left
   * out of the report while it is null.
   *
   * Nothing has been requested before then, so there is no outcome to report;
   * the old initial value of `'unavailable'` said "this browser does not have
   * the API" on every browser that does, which is the one thing this panel is
   * built not to do.
   */
  let wakeLockState: WakeLockState | null = null;
  let wakeLockSentinel: WakeLockSentinel | null = null;

  const drawCalls = installDrawCallCounter(debug.renderer());

  /**
   * `navigator.userAgent`, formatted once.
   *
   * Once, because this is the one string in the report that is both long and
   * completely static, and rebuilding it five times a second would be the
   * overlay allocating in its own measurement window for no reason. It is also
   * the single most load-bearing line in a device report — the run this ticket
   * exists because of was desktop Chrome, and nothing in the report said so.
   *
   * It lives in its own soft-wrapping element rather than in the two-column
   * grid so it can be printed verbatim: a 30-character column would have to
   * either clip it or insert line breaks into it, and a user-agent string with
   * breaks in it is no longer the string the browser reported.
   */
  const uaLine = `${'ua'.padEnd(19, ' ')} ${navigator.userAgent}`;

  // --- DOM ----------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ce-debug';
  // The panel as a whole is transparent to touch. Only the two buttons take a
  // tap, and they sit in the top band §9 reserves for reading — so nothing the
  // overlay adds is over a tappable control, and the owner can still tap cash
  // bubbles and fire Last Call while a measurement is running.
  root.setAttribute('role', 'status');

  const bar = document.createElement('div');
  bar.className = 'ce-debug__bar';

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'ce-debug__btn';
  startButton.textContent = 'Start 60 s measurement';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'ce-debug__btn';
  copyButton.textContent = 'Copy report';

  bar.append(startButton, copyButton);

  // The report is rendered as the *same* plain-text block that "Copy report"
  // writes to the clipboard, not as a prettier parallel view. Clipboard
  // permission fails silently on iOS Safari, so the fallback has to be the
  // real thing rather than an approximation of it.
  //
  // Three elements rather than one, and the split is by line width, not by
  // importance: the grid in the middle is the 30-character two-column block
  // DUB-9 sized to a 390 px phone, and `valid` and `ua` are the two rows whose
  // text cannot be made to fit it. Putting them in full-width, soft-wrapping
  // siblings keeps the column discipline intact *and* keeps both strings
  // whole. Read top to bottom they are still one plain-text report, which is
  // exactly what `reportText()` hands the clipboard.
  const verdict = document.createElement('pre');
  verdict.className = 'ce-debug__verdict';

  const out = document.createElement('pre');
  out.className = 'ce-debug__out';

  const ua = document.createElement('pre');
  ua.className = 'ce-debug__ua';
  ua.textContent = uaLine;

  const statusLine = document.createElement('div');
  statusLine.className = 'ce-debug__status';

  root.append(bar, verdict, out, ua, statusLine);
  document.body.appendChild(root);

  /**
   * Keep the screen on for the length of a measurement.
   *
   * This is a mitigation, not a fix. `hidden_breaks` is the fix — it catches
   * the failure after the fact and refuses to average it in. This only makes
   * the failure rarer, by removing the most likely cause: DUB-8's protocol
   * tells the owner to put the phone down for a minute, and a phone left alone
   * locks its screen. Feature-detected because Safari only grew the API
   * recently and a WebView may not have it at all, and failure is quiet
   * because a refused lock is a legal outcome, not an error.
   */
  function requestWakeLock(): void {
    releaseWakeLock();

    // Typed as non-optional in lib.dom, genuinely absent in some engines —
    // the same situation as `performance.memory`, handled the same way.
    const wakeLock: WakeLock | undefined = navigator.wakeLock;
    if (wakeLock === undefined || typeof wakeLock.request !== 'function') {
      wakeLockState = 'unavailable';
      return;
    }

    // Pessimistic until the promise resolves: the field must never claim a
    // lock is held while the request is still in flight. The panel redraws at
    // 5 Hz, so a granted lock shows up within 200 ms.
    wakeLockState = 'refused';
    wakeLock.request('screen').then(
      (sentinel) => {
        if (!alive) {
          void sentinel.release();
          return;
        }
        wakeLockSentinel = sentinel;
        wakeLockState = 'held';
        // The browser releases a screen lock by itself when the document
        // becomes hidden, and says so only through this event. Without it the
        // field goes on reading `held` for the rest of the window while the
        // screen is free to sleep — a mitigation reporting success after it
        // stopped mitigating, which is worse than reporting nothing.
        //
        // The guard is what keeps `held` true for a window that completed
        // normally: `releaseWakeLock` clears `wakeLockSentinel` *before* it
        // releases, so a release the overlay asked for no longer matches here
        // and leaves the field alone. Only a release nobody here requested
        // reaches the assignment.
        sentinel.addEventListener('release', () => {
          if (wakeLockSentinel !== sentinel) return;
          wakeLockSentinel = null;
          wakeLockState = 'released';
        });
      },
      () => {
        wakeLockState = 'refused';
      },
    );
  }

  function releaseWakeLock(): void {
    const sentinel = wakeLockSentinel;
    // Detached first, so the `release` listener above can tell this release
    // apart from one the browser performed on its own.
    wakeLockSentinel = null;
    if (sentinel !== null) void sentinel.release();
  }

  /**
   * The page went away, or came back.
   *
   * Counted on the way out rather than on the way back, so a window that is
   * hidden and never returns is still recorded as broken; the duration is
   * added on the way back, with `buildReport` adding the in-flight tail if it
   * is somehow called while hidden.
   *
   * Only while sampling: a hidden period after the panel has frozen is the
   * owner pocketing the phone to go and paste the report, and invalidating a
   * finished measurement for that would be the instrument crying wolf.
   */
  function onVisibilityChange(): void {
    if (freeze.frozen) return;
    const now = performance.now();

    if (document.visibilityState === 'hidden') {
      if (hiddenAt === 0) {
        hiddenAt = now;
        hiddenBreaks += 1;
      }
      return;
    }

    if (hiddenAt !== 0) {
      hiddenMs += now - hiddenAt;
      hiddenAt = 0;
      discardNextFrame = true;
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  // --- report -------------------------------------------------------------
  /**
   * Wall clock in the current window.
   *
   * A frozen window stops at the instant it froze rather than at the moment the
   * report happens to be rebuilt, so `elapsed_s` does not creep while the panel
   * sits on the table and a second tap on "Copy report" gives the same number
   * as the first.
   */
  function elapsedMsAt(now: number): number {
    return freeze.instant(now) - windowStart;
  }

  /**
   * Hidden time in the window, including a period still in progress.
   *
   * `rAF` does not run while hidden, so in practice the tail is only ever read
   * by a report built from an event handler — but a field that silently
   * under-reports in the one case it is there to catch would be no better than
   * not having it.
   */
  function hiddenMsAt(now: number): number {
    return hiddenAt === 0 ? hiddenMs : hiddenMs + (now - hiddenAt);
  }

  /**
   * The verdict, as the `valid` row's value.
   *
   * One object literal per redraw — 5 Hz, in the same path that already builds
   * the `rows` array and a fresh `Date`. The constraint that matters is that
   * the *sampling* loop allocates nothing, and it still does not: `tick` only
   * reaches this code on the 200 ms boundary.
   */
  function currentValidity(now: number): string {
    return validityVerdict({
      armed,
      completed,
      frozen: freeze.frozen,
      elapsedMs: elapsedMsAt(now),
      hiddenBreaks,
      hiddenMs: hiddenMsAt(now),
      stress: info.stress,
      guests: sceneBroke ? brokeGuests : counts.guests,
      bartenders: sceneBroke ? brokeBartenders : counts.bartenders,
      queues: sceneBroke ? brokeQueues : counts.queues,
    });
  }

  function buildReport(now: number): string {
    const elapsedMs = elapsedMsAt(now);
    const canvas = debug.canvas();
    // Live while the panel is live, latched once it is frozen. Everything
    // downstream of this line — the duty-cycle trio and the four phase
    // percentiles — therefore describes the window `elapsed_s` describes, which
    // before DUB-12 it did not: the game goes on rendering after the panel
    // stops, so a re-read here was a different measurement with the same
    // heading on it.
    const frames = freeze.frames();
    const domParticles = confettiPieces();

    const n = sampleCount;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      const value = samples[i]!;
      sum += value;
      if (value > max) max = value;
      sorted[i] = value;
    }
    // `Float32Array.prototype.sort` is numeric and in place: no comparator
    // closure, no copy.
    const view = sorted.subarray(0, n);
    view.sort();

    // The slowest 1% of frames, expressed as the fps they correspond to. The
    // p99 frame *time* is the p1 frame *rate* — the same tail, read from the
    // end the owner cares about.
    const p99Index = Math.min(n - 1, Math.floor(n * 0.99));
    const p99Ms = n > 0 ? view[p99Index]! : 0;

    // Split across two lines rather than one: every row has to fit a column
    // 30 characters wide (see `CSS`), and a full ISO timestamp on its own is
    // 24 of them.
    const stamp = new Date().toISOString();

    // `null` is "there is nothing true to print here yet", and the row is left
    // out entirely rather than filled with a plausible word. `n/a` is the other
    // half of the same rule and is not interchangeable with it: `n/a` means the
    // browser cannot tell us (`heap_mb` on WebKit), `null` means we have not
    // asked.
    const rows: [string, string | null][] = [
      ['build', info.build],
      ['scene', info.stress ? 'stress' : 'normal'],
      ['state', freeze.frozen ? 'FROZEN' : 'live'],
      ['date', stamp.slice(0, 10)],
      ['time', stamp.slice(11, 19) + 'Z'],
      ['fps', fixed(rollingFps(now), 1)],
      ['fps_p1_worst', p99Ms > 0 ? fixed(1000 / p99Ms, 1) : 'n/a'],
      ['frame_ms_mean', n > 0 ? fixed(sum / n, 2) : 'n/a'],
      ['frame_ms_max', n > 0 ? fixed(max, 2) : 'n/a'],
      ['refresh_cap_hz', peakFps > 0 ? String(Math.round(peakFps)) : 'n/a'],
      // The gating figure for DUB-6's C1 regression gate. Reported from the
      // game's own probe, not from this module's rAF hook: the hook can see
      // how long a frame lasted but not how much of it the game spent
      // working, and the gap between those two is the entire point.
      ['busy_pct', fixed(frames.busyPercent, 1)],
      ['busy_ms_per_s', fixed(frames.busyMsPerSecond, 1)],
      ['busy_window_s', fixed(frames.wallMs / 1000, 1)],
      ['draw_calls', drawCalls === null ? 'n/a' : String(drawCalls.lastFrame)],
      ['guests_rendered', String(counts.guests)],
      ['bartenders_rendered', String(counts.bartenders)],
      ['queues_rendered', String(counts.queues)],
      ['particles_rendered', String(counts.particles + domParticles)],
      ['particles_canvas', String(counts.particles)],
      ['particles_dom', String(domParticles)],
      ['dpr', fixed(window.devicePixelRatio || 1, 2)],
      ['canvas_px', canvas === null ? 'n/a' : `${canvas.width}x${canvas.height}`],
      [
        'canvas_css',
        canvas === null ? 'n/a' : `${Math.round(canvas.clientWidth)}x${Math.round(canvas.clientHeight)}`,
      ],
      // Three plain facts about the device, and no classification built on top
      // of them. The report that triggered DUB-10 was desktop Chrome and the
      // only hints were `canvas_css` and the existence of `heap_mb`; sniffing
      // the UA to print "iPhone" or "desktop" would have replaced a reader's
      // inference with the overlay's, which is not an improvement. `ua` itself
      // is printed verbatim in its own line below the grid.
      ['viewport_css', `${window.innerWidth}x${window.innerHeight}`],
      ['touch_points', touchPoints()],
      ['heap_mb', heapMb()],
      ['elapsed_s', fixed(elapsedMs / 1000, 1)],
      // Hidden periods are the reason the frame stats can be trusted at all:
      // the frame spanning each one is discarded rather than averaged, so
      // these two fields are what is left to say it happened. `hidden_breaks`
      // is also the condition that drives `valid` to `no`.
      ['hidden_breaks', String(hiddenBreaks)],
      ['hidden_s', fixed(hiddenMsAt(now) / 1000, 1)],
      // Null until a lock has actually been asked for, which omits the row —
      // see `wakeLockState`.
      ['wake_lock', wakeLockState],
      ['window_frames', String(n + dropped)],
      ['sim_ms_p95', fixed(frames.phases.sim.p95Ms, 2)],
      ['scene_ms_p95', fixed(frames.phases.scene.p95Ms, 2)],
      ['publish_ms_p95', fixed(frames.phases.publish.p95Ms, 2)],
      ['gpu_ms_p95', fixed(frames.phases.gpu.p95Ms, 2)],
    ];

    let text = '';
    for (const [key, value] of rows) {
      if (value === null) continue;
      text += `${key.padEnd(19, ' ')} ${value}\n`;
    }
    if (dropped > 0) {
      text += `${'dropped'.padEnd(19, ' ')} ${dropped}\n`;
    }
    return text;
  }

  /** Rebuild every visible part of the report from the same instant. */
  function paint(now: number): void {
    const value = currentValidity(now);
    verdict.textContent = `${'valid'.padEnd(19, ' ')} ${value}`;
    out.textContent = buildReport(now);
    // The one piece of styling that carries information: an invalid report is
    // outlined in red, so a glance at the phone is enough and nobody has to
    // read a 36-row block to find out the run has to be done again.
    root.classList.toggle('ce-debug--invalid', value !== 'yes');
  }

  /**
   * What "Copy report" puts on the clipboard: the three blocks, in the order
   * they are on screen. What you read is what you paste.
   */
  function reportText(): string {
    return `${verdict.textContent ?? ''}\n${out.textContent ?? ''}${ua.textContent ?? ''}\n`;
  }

  /**
   * Latch the first non-C1 scene seen during a measurement.
   *
   * The verdict is a statement about the whole window, not about the instant
   * it was read — the same reason `frame_ms_max` is on the report. The crowd
   * is pinned through `syncProgress`, so in principle a purchase mid-run
   * cannot shift these counts; this is here so that if that ever stops being
   * true, the report says so instead of the next person re-deriving it from a
   * frame time that looks slightly off.
   */
  function noteScene(): void {
    if (sceneBroke || !armed || freeze.frozen) return;
    if (
      counts.guests === C1_GUESTS &&
      counts.bartenders === C1_BARTENDERS &&
      counts.queues === C1_QUEUES
    ) {
      return;
    }
    sceneBroke = true;
    brokeGuests = counts.guests;
    brokeBartenders = counts.bartenders;
    brokeQueues = counts.queues;
  }

  /** Frames in the trailing second, as fps. The field DUB-9 calls `fps`. */
  function rollingFps(now: number): number {
    const cutoff = now - 1000;
    let inWindow = 0;
    let oldest = now;
    for (let i = 0; i < recentFilled; i += 1) {
      const at = recent[i]!;
      if (at < cutoff) continue;
      inWindow += 1;
      if (at < oldest) oldest = at;
    }
    if (inWindow < 2) return 0;
    const span = now - oldest;
    return span > 0 ? ((inWindow - 1) * 1000) / span : 0;
  }

  function heapMb(): string {
    // Non-standard and Chrome-only. DUB-9 is explicit: print `n/a` on Safari
    // rather than guessing, because a made-up memory number is worse than no
    // memory number.
    const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
    if (memory === undefined || typeof memory.usedJSHeapSize !== 'number') return 'n/a';
    return fixed(memory.usedJSHeapSize / (1024 * 1024), 1);
  }

  /**
   * `navigator.maxTouchPoints`. 0 on a desktop mouse, 5 on an iPhone.
   *
   * Not a device test and not used as one — it is one of the three facts that
   * let a reader see for themselves what the report came off, next to `ua` and
   * `viewport_css`.
   */
  function touchPoints(): string {
    const points = navigator.maxTouchPoints;
    return typeof points === 'number' ? String(points) : 'n/a';
  }

  function resetWindow(now: number): void {
    sampleCount = 0;
    dropped = 0;
    recentCursor = 0;
    recentFilled = 0;
    peakFps = 0;
    windowStart = now;
    lastFrameAt = now;
    // The integrity counters belong to the window, not to the page: a hidden
    // period before the owner tapped "Start" says nothing about the run that
    // follows it.
    // Already hidden when the window opens counts as the first break: the
    // `visibilitychange` that would have counted it fired before the reset.
    const startsHidden = document.visibilityState === 'hidden';
    hiddenBreaks = startsHidden ? 1 : 0;
    hiddenMs = 0;
    hiddenAt = startsHidden ? now : 0;
    discardNextFrame = false;
    sceneBroke = false;
    brokeGuests = 0;
    brokeBartenders = 0;
    brokeQueues = 0;
    drawCalls?.reset();
    // Put the duty-cycle window on the same 60 s as everything else here. This
    // is one half of `busy_pct` and `fps` describing the same stretch of time;
    // the other half is `WindowFreeze` latching the readout when the panel
    // stops, because resetting the window at the start does nothing about a
    // denominator that keeps growing after the end.
    debug.resetFrames();
  }

  // --- buttons ------------------------------------------------------------
  startButton.addEventListener('click', () => {
    const now = performance.now();
    freeze.thaw();
    armed = true;
    completed = false;
    resetWindow(now);
    measureUntil = now + MEASURE_MS;
    status = 'measuring 60 s — leave the phone alone';
    applyFrozenClass();
    // Inside the tap, so iOS treats it as user-initiated. A rejection is
    // reported through `wake_lock` and changes nothing else.
    requestWakeLock();
    debug.counts(counts);
    noteScene();
    paint(now);
    statusLine.textContent = status;
  });

  copyButton.addEventListener('click', () => {
    const now = performance.now();

    // Freeze on copy as well as on timeout. `user-select` is off document-wide
    // and the panel is touch-transparent while live, so this is what makes the
    // on-screen text actually selectable when the clipboard write fails
    // quietly — which on iOS it does.
    //
    // Frozen *before* the text is built, not after, and that ordering is the
    // whole of DUB-10's "copied early still says `valid no`": the verdict for
    // an unfinished window depends on whether it was copied or is still
    // running, so the report has to be rebuilt once the answer is known.
    // Only the first freeze sets the clock and latches the duty cycle, and the
    // report is rebuilt as of *that* instant. A second tap on "Copy report"
    // must hand over the same numbers as the first, not the same run with a
    // longer `elapsed_s`, an `fps` of zero and a `busy_pct` diluted by however
    // long the panel sat there — which is what DUB-12 came to fix.
    freeze.freeze(now);
    const at = freeze.instant(now);
    measureUntil = null;
    releaseWakeLock();
    applyFrozenClass();
    paint(at);

    // iOS Safari only honours a clipboard write that happens inside the user
    // gesture. So the text is built and handed over synchronously here, before
    // any `await` — the promise is only used to report the outcome afterwards.
    const text = reportText();

    const clipboard = navigator.clipboard;
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      const written = clipboard.writeText(text);
      status = 'copying…';
      statusLine.textContent = status;
      written.then(
        () => {
          status = 'copied — display frozen, text is selectable';
          statusLine.textContent = status;
        },
        () => {
          status = legacyCopy(text)
            ? 'copied (fallback) — display frozen, text is selectable'
            : 'clipboard refused — select the text above and copy by hand';
          statusLine.textContent = status;
        },
      );
      return;
    }

    status = legacyCopy(text)
      ? 'copied (fallback) — display frozen, text is selectable'
      : 'no clipboard API — select the text above and copy by hand';
    statusLine.textContent = status;
  });

  function applyFrozenClass(): void {
    // Selectable only while frozen: a `<pre>` whose text is replaced five
    // times a second cannot hold a selection, and while live the panel has to
    // stay transparent to taps so it is not sitting on the game.
    root.classList.toggle('ce-debug--frozen', freeze.frozen);
  }

  // --- the sampling loop --------------------------------------------------
  // A second `requestAnimationFrame` hook rather than a tap into the game's
  // loop. `rAF` callbacks fire once per presented frame whatever order they
  // were registered in, so the interval between two of these *is* the frame
  // interval — and keeping it separate means the game's frame loop is byte for
  // byte the one that ships.
  let rafHandle = requestAnimationFrame(tick);
  let alive = true;

  function tick(now: number): void {
    if (!alive) return;
    rafHandle = requestAnimationFrame(tick);

    if (!freeze.frozen) {
      const delta = now - lastFrameAt;
      lastFrameAt = now;

      // The two frames that are not frame times.
      //
      // `discardNextFrame` is the one that spans a hidden period: `rAF` stops
      // while the page is not visible and the callback that arrives when it
      // comes back carries the whole gap in its delta. The owner's first
      // report recorded one of those as `frame_ms_max 8750` and let it pull
      // `frame_ms_mean` to 23.11 ms, which is how a 26-second run came to
      // describe a frame rate nobody had experienced.
      //
      // `document.hidden` is the belt and braces: some engines throttle `rAF`
      // to roughly 1 Hz in a hidden document rather than stopping it, and a
      // run of 1000 ms "frames" would be just as wrong and much less obvious.
      // Reading the flag costs nothing and allocates nothing.
      const gapFrame = discardNextFrame || document.hidden;
      discardNextFrame = false;

      if (!gapFrame) {
        if (sampleCount < MAX_SAMPLES) {
          samples[sampleCount] = delta;
          sampleCount += 1;
        } else {
          dropped += 1;
        }
      }

      // The timestamp still goes in even for a discarded frame, and must: the
      // rolling second is a window over *when* frames happened, so leaving the
      // gap frame out of it would make `fps` read as though the frames either
      // side of the gap were adjacent.
      if (recentFilled < RECENT) {
        recent[recentFilled] = now;
        recentFilled += 1;
        recentCursor = recentFilled % RECENT;
      } else {
        recent[recentCursor] = now;
        recentCursor = (recentCursor + 1) % RECENT;
      }

      const fps = rollingFps(now);
      if (fps > peakFps) peakFps = fps;

      if (measureUntil !== null && now >= measureUntil) {
        // The window closes at its own deadline, not at the frame that
        // happened to notice — otherwise a hidden period straddling the 60 s
        // mark would print an `elapsed_s` of 68.
        const deadline = measureUntil;
        // Latches the duty-cycle readout as well as the clock. `wallMs` here is
        // measured to the game's last rendered frame, so it lands within one
        // frame of the 60 s `elapsed_s` reports rather than wherever the game
        // had got to by the time somebody tapped "Copy report".
        freeze.freeze(deadline);
        completed = true;
        measureUntil = null;
        releaseWakeLock();
        status =
          hiddenBreaks > 0
            ? 'complete but INVALID — the page was hidden; read the valid row and run it again'
            : 'measurement complete — frozen, tap “Copy report”';
        applyFrozenClass();
        paint(deadline);
        statusLine.textContent = status;
        drawCalls?.commit();
        return;
      }
    }

    drawCalls?.commit();

    if (now - lastRedrawAt < REDRAW_MS) return;
    lastRedrawAt = now;
    if (freeze.frozen) return;

    debug.counts(counts);
    noteScene();
    paint(now);
    statusLine.textContent = status;
  }

  paint(windowStart);
  statusLine.textContent = status;

  return {
    destroy: () => {
      alive = false;
      cancelAnimationFrame(rafHandle);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releaseWakeLock();
      drawCalls?.restore();
      root.remove();
      style.remove();
    },
  };
}

/**
 * Confetti pieces currently in the DOM.
 *
 * The star-celebration confetti is not a canvas particle system: it is twelve
 * CSS-animated `<span>`s in the React overlay layer (`ui/Overlays.tsx`), so a
 * GL-side probe reads zero for it even mid-celebration and a 60-particle cap
 * checked against the canvas alone is a false pass. Counted rather than
 * derived, because QA cross-checks this field against an independent probe
 * and an estimate that disagreed would be indistinguishable from a defect.
 *
 * This is a DOM count and is reported separately as `particles_dom` for that
 * reason: the day a Pixi emitter is added, only `particles_canvas` moves.
 */
function confettiPieces(): number {
  return document.getElementsByClassName('confetti__piece').length;
}

/** Last-resort clipboard path for browsers that refuse the async API. */
function legacyCopy(text: string): boolean {
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', 'readonly');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  try {
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}

interface DrawCallCounter {
  /** Draw calls issued during the frame that just ended. */
  lastFrame: number;
  /** Roll the in-flight count into `lastFrame`. Called once per frame. */
  commit(): void;
  reset(): void;
  restore(): void;
}

/**
 * Count `draw*` calls by wrapping the WebGL context.
 *
 * Pixi 8 keeps no draw-call statistic of its own, and the batcher is internal,
 * so the only honest source is the context itself. `renderer.gl` is set by
 * `GlContextSystem` but is not on the public `Renderer` union type, hence the
 * narrow cast — if it is ever absent the overlay prints `n/a` rather than 0.
 *
 * Patching a hot GL function would normally be unacceptable, but this is a
 * debug-chunk-only path and a batched frame of this scene issues single-digit
 * draw calls, so the wrapper runs a handful of times per frame.
 */
function installDrawCallCounter(renderer: unknown): DrawCallCounter | null {
  const gl = (renderer as { gl?: WebGL2RenderingContext } | null)?.gl;
  if (gl === undefined || gl === null) return null;

  let pending = 0;

  // Bound up front. The four `draw*` functions live on
  // `WebGL2RenderingContext.prototype`, so assigning to `gl.draw*` below adds
  // an *own* property that shadows them — which is also what makes `restore`
  // a `delete` rather than a re-assignment: it puts the context back to
  // genuinely unpatched rather than to a wrapper that happens to forward.
  const drawArrays = gl.drawArrays.bind(gl);
  const drawElements = gl.drawElements.bind(gl);
  const drawArraysInstanced = gl.drawArraysInstanced.bind(gl);
  const drawElementsInstanced = gl.drawElementsInstanced.bind(gl);

  gl.drawArrays = (mode, first, count) => {
    pending += 1;
    drawArrays(mode, first, count);
  };
  gl.drawElements = (mode, count, type, offset) => {
    pending += 1;
    drawElements(mode, count, type, offset);
  };
  gl.drawArraysInstanced = (mode, first, count, instances) => {
    pending += 1;
    drawArraysInstanced(mode, first, count, instances);
  };
  gl.drawElementsInstanced = (mode, count, type, offset, instances) => {
    pending += 1;
    drawElementsInstanced(mode, count, type, offset, instances);
  };

  const counter: DrawCallCounter = {
    lastFrame: 0,
    commit: () => {
      counter.lastFrame = pending;
      pending = 0;
    },
    reset: () => {
      pending = 0;
      counter.lastFrame = 0;
    },
    restore: () => {
      const own = gl as unknown as Record<string, unknown>;
      delete own.drawArrays;
      delete own.drawElements;
      delete own.drawArraysInstanced;
      delete own.drawElementsInstanced;
    },
  };
  return counter;
}

function fixed(value: number, places: number): string {
  return Number.isFinite(value) ? value.toFixed(places) : 'n/a';
}

/**
 * Injected from here rather than imported as a stylesheet so the flag-off
 * bundle carries none of it.
 *
 * Placement follows DUB-9: top-left, inside the safe-area insets, and clear of
 * every tappable control. `env(safe-area-inset-*)` is read directly rather
 * than through the app's `--safe-*` tokens, so the overlay still lands
 * correctly if it is ever mounted before the app's stylesheet.
 */
const CSS = `
.ce-debug {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 6px);
  left: calc(env(safe-area-inset-left, 0px) + 6px);
  z-index: 2147483647;
  width: fit-content;
  max-width: calc(100vw - 12px);
  pointer-events: none;
  /* 9.5 px sounds small and is not: at the 3x device pixel ratio of the phone
     this is measured on, it rasterises at 28 device pixels. It is the largest
     size at which two 30-character columns fit inside 390 CSS px without
     clipping, and the primary way the numbers leave the device is "Copy
     report" rather than someone squinting at them. */
  font: 500 9.5px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: #eafff4;
}

.ce-debug__bar {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  pointer-events: auto;
}

.ce-debug__btn {
  /* 44 px is the §9 touch minimum and applies to a debug button too: the owner
     is tapping this with a thumb on a phone. */
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid #38e8b0;
  border-radius: 8px;
  background: #06130f;
  color: #eafff4;
  font: inherit;
  font-weight: 600;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.ce-debug__btn:active {
  background: #10352a;
}

.ce-debug__out {
  margin: 0;
  padding: 6px 8px;
  border-radius: 8px;
  /* Opaque, not translucent: this is read against a club floor with coloured
     lights moving behind it. */
  background: #06130f;
  border: 1px solid #1d4d3e;
  white-space: pre;
  /* Two columns, which is the whole reason the rows are capped at 30
     characters. Twenty-four fields in one column is 450 px tall on a 390x844
     phone — over half the screen and sitting squarely on the cash bubbles,
     which are the one thing the owner has to be able to tap while a
     measurement is running. CSS multicol breaks on the line boxes of a
     "white-space: pre" block, so textContent is still the single plain-text
     report that "Copy report" puts on the clipboard. */
  column-count: 2;
  column-gap: 10px;
  column-fill: balance;
  /* Two 30-character columns plus the gap and the padding, in the element's
     own monospace ch unit. The longest row the report can produce is
     "bartenders_rendered" (19) + a space + a ten-character value.
     One row exceeds that by a single character — "wake_lock unavailable" is
     31 — and spends it on the 10 px column gap rather than on the next
     column's text. Widening the block instead would push it past the 390 px
     phone this font size was chosen for, and shortening the value would mean
     inventing a word for "the API is not here", which is the one thing this
     overlay does not do. */
  width: calc(60ch + 10px + 18px);
  max-width: calc(100vw - 14px);
  user-select: none;
  -webkit-user-select: none;
}

/* The two rows that cannot fit a 30-character column.
   Both soft-wrap instead of being truncated or broken by hand: a verdict with
   a reason clipped off it, or a user-agent string with newlines inserted into
   it, would each be a different kind of lie than the one DUB-10 came to fix.
   They are separate elements so the grid below keeps its column discipline —
   and because "white-space: pre-wrap" does not survive CSS multicol intact. */
.ce-debug__verdict,
.ce-debug__ua {
  margin: 0 0 4px;
  padding: 6px 8px;
  border-radius: 8px;
  background: #06130f;
  border: 1px solid #1d4d3e;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  width: calc(60ch + 10px + 18px);
  max-width: calc(100vw - 14px);
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}

.ce-debug__ua {
  margin: 4px 0 0;
  /* Dimmer than the numbers: it is identity, not a measurement. */
  color: #9fd9c4;
}

.ce-debug__status {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 8px;
  background: #06130f;
  border: 1px solid #1d4d3e;
  max-width: 100%;
  white-space: normal;
}

/* Frozen: the numbers have stopped moving, so the text becomes selectable and
   the panel starts taking taps. While live it stays transparent to touch so it
   is never in the way of a cash bubble. */
.ce-debug--frozen .ce-debug__out,
.ce-debug--frozen .ce-debug__verdict,
.ce-debug--frozen .ce-debug__ua {
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
  border-color: #38e8b0;
}

/* The verdict is the only thing on this panel that is styled to carry
   information. A 36-row block of numbers all looks equally plausible, which is
   the failure mode DUB-10 exists for — so an invalid window is red at a
   glance, from across a table, before anybody starts reading. */
.ce-debug--invalid .ce-debug__verdict {
  background: #2a0b0b;
  border-color: #ff6b6b;
  color: #ffd9d9;
}
`;
