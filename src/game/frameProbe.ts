/**
 * Per-system frame timing.
 *
 * Acceptance criterion 8 asks for >= 50 fps on a Pixel 6a / Galaxy A54 class
 * phone. A single fps figure is the least useful possible answer to that: it
 * says a budget was missed without saying which system spent it, and it is
 * dominated by whatever the GPU happens to be doing. So this measures the four
 * phases of a frame separately and reports a distribution rather than a mean.
 *
 * Two deliberate choices:
 *
 *  - **p95, not average.** Dropped frames are a tail problem. A 60 fps average
 *    with a 40 ms p95 stutters visibly and reads as "fine" in any mean.
 *  - **Allocation-free.** A probe that allocates changes the thing it is
 *    measuring — GC pauses are exactly what the tail is made of. Samples go
 *    into pre-sized ring buffers.
 *  - **Duty cycle alongside frame time.** The sim is fixed-step at 10 Hz with
 *    catch-up, so the work done per frame is proportional to how long the
 *    frame lasted: on a slow rasteriser `avgFrameMs` measures the rasteriser,
 *    not the code. QA measured a 3.4x spread from `deviceScaleFactor` alone
 *    with the build held constant. Main-thread busy ms per second of wall
 *    clock does not move with frame duration, so that is the figure DUB-6
 *    gates on. It is accumulated over the whole window rather than kept in the
 *    ring buffer, because a ring that wrapped would silently narrow the
 *    denominator.
 *
 * What it cannot tell you: anything GPU-side. `app.render()` returns when the
 * commands are *submitted*, not when they are done, so the `gpu` phase here is
 * CPU-side submission cost. On a container with no GPU the rasteriser is
 * software and the number is meaningless; that limitation is real and is
 * reported rather than papered over.
 */

/** Samples kept per phase. 240 at 60 fps is a four-second window. */
const WINDOW = 240;

/**
 * The four phases of a frame.
 *
 * Named rather than enumerated at runtime: nothing iterates them, and a
 * `Record<Phase, …>` already forces every one to be handled, so a value-level
 * array would be a second list to keep in step with this one.
 */
export type Phase = 'sim' | 'scene' | 'publish' | 'gpu';

export interface PhaseReport {
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface FrameReport {
  readonly frames: number;
  readonly windowFrames: number;
  readonly avgFrameMs: number;
  readonly p95FrameMs: number;
  readonly maxFrameMs: number;
  readonly estimatedFps: number;
  /** Frames that took longer than 16.6 ms, as a percentage of the window. */
  readonly overBudgetPercent: number;
  readonly phases: Record<Phase, PhaseReport>;
  /** Main-thread ms spent inside the game frame since the last `reset()`. */
  readonly busyMs: number;
  /** Wall-clock ms since the last `reset()`. The denominator of the duty cycle. */
  readonly wallMs: number;
  /** `busyMs` per second of wall clock. DUB-6's gating figure, unnormalised. */
  readonly busyMsPerSecond: number;
  /** The same figure as a percentage. DUB-6 gates at <= 18 % at 1x, <= 72 % at 4x. */
  readonly busyPercent: number;
}

export class FrameProbe {
  private readonly samples: Record<Phase, Float32Array>;
  private readonly frameSamples = new Float32Array(WINDOW);
  /** Scratch buffer for the percentile sort, so `report()` does not allocate either. */
  private readonly scratch = new Float32Array(WINDOW);

  private cursor = 0;
  private filled = 0;
  private frames = 0;

  private frameStart = 0;
  private phaseStart = 0;

  /**
   * Duty-cycle accounting. Kept as running totals rather than in the ring
   * buffer: the window the overlay measures over is 60 s, which at 120 Hz is
   * thirty times `WINDOW`, and a wrapped ring would quietly change the
   * denominator from "the measurement" to "the last four seconds".
   */
  private busyMs = 0;
  private windowStartedAt = performance.now();
  private windowEndedAt = this.windowStartedAt;

  constructor() {
    this.samples = {
      sim: new Float32Array(WINDOW),
      scene: new Float32Array(WINDOW),
      publish: new Float32Array(WINDOW),
      gpu: new Float32Array(WINDOW),
    };
  }

  beginFrame(now: number): void {
    this.frameStart = now;
    this.phaseStart = now;
  }

  /** Close out one phase. Cheap enough to leave in the production frame loop. */
  mark(phase: Phase): void {
    const now = performance.now();
    this.samples[phase][this.cursor] = now - this.phaseStart;
    this.phaseStart = now;
  }

  endFrame(): void {
    const now = performance.now();
    const elapsed = now - this.frameStart;
    this.frameSamples[this.cursor] = elapsed;
    this.cursor = (this.cursor + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled += 1;
    this.frames += 1;

    // The whole `beginFrame` -> `endFrame` span is main-thread time the game
    // took: everything between the two is synchronous. Anything the browser
    // does outside it — compositing, the overlay's own rAF hook, idle — is
    // correctly not counted as the game being busy.
    this.busyMs += elapsed;
    this.windowEndedAt = now;
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.frames = 0;
    this.busyMs = 0;
    this.windowStartedAt = performance.now();
    this.windowEndedAt = this.windowStartedAt;
  }

  report(): FrameReport {
    const n = this.filled;
    if (n === 0) {
      return {
        frames: 0,
        windowFrames: 0,
        avgFrameMs: 0,
        p95FrameMs: 0,
        maxFrameMs: 0,
        estimatedFps: 0,
        overBudgetPercent: 0,
        phases: {
          sim: EMPTY_PHASE,
          scene: EMPTY_PHASE,
          publish: EMPTY_PHASE,
          gpu: EMPTY_PHASE,
        },
        busyMs: 0,
        wallMs: 0,
        busyMsPerSecond: 0,
        busyPercent: 0,
      };
    }

    const frame = this.summarise(this.frameSamples, n);

    // Measured to the end of the last frame, not to "now". Both the overlay
    // and QA read this after freezing the display, and a denominator that
    // kept growing while nothing was being rendered would walk the duty cycle
    // down towards zero the longer you looked at it.
    const wallMs = this.windowEndedAt - this.windowStartedAt;
    const busyMsPerSecond = wallMs > 0 ? (this.busyMs / wallMs) * 1000 : 0;

    let overBudget = 0;
    for (let i = 0; i < n; i += 1) {
      if (this.frameSamples[i]! > 16.6) overBudget += 1;
    }

    return {
      frames: this.frames,
      windowFrames: n,
      avgFrameMs: frame.avgMs,
      p95FrameMs: frame.p95Ms,
      maxFrameMs: frame.maxMs,
      // Derived from the *p95*, not the average: the question criterion 8 asks
      // is whether the frame budget holds, not what it averages.
      estimatedFps: frame.p95Ms > 0 ? 1000 / frame.p95Ms : 0,
      overBudgetPercent: (overBudget / n) * 100,
      phases: {
        sim: this.summarise(this.samples.sim, n),
        scene: this.summarise(this.samples.scene, n),
        publish: this.summarise(this.samples.publish, n),
        gpu: this.summarise(this.samples.gpu, n),
      },
      busyMs: this.busyMs,
      wallMs,
      busyMsPerSecond,
      busyPercent: busyMsPerSecond / 10,
    };
  }

  private summarise(source: Float32Array, n: number): PhaseReport {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      const value = source[i]!;
      sum += value;
      if (value > max) max = value;
      this.scratch[i] = value;
    }

    // `Float32Array.prototype.sort` is numeric by default and sorts in place,
    // so this needs no comparator closure and no copy.
    const view = this.scratch.subarray(0, n);
    view.sort();

    const index = Math.min(n - 1, Math.floor(n * 0.95));
    return { avgMs: sum / n, p95Ms: view[index]!, maxMs: max };
  }
}

const EMPTY_PHASE: PhaseReport = { avgMs: 0, p95Ms: 0, maxMs: 0 };
