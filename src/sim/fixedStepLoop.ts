import { MAX_CATCHUP_TICKS, TICK_MS } from './constants.ts';

export interface FixedStepLoopOptions {
  /** Milliseconds of simulated time per tick. Defaults to the economy tick. */
  readonly tickMs?: number;
  /** Maximum ticks executed per `advance()` call. */
  readonly maxCatchupTicks?: number;
}

/**
 * Fixed-timestep accumulator.
 *
 * The render frame rate is an input to this class and nothing else. Whatever
 * frame deltas arrive, the simulation only ever advances in whole `tickMs`
 * steps, so 30 fps and 120 fps produce the same economy state for the same
 * elapsed wall-clock time. For an idle game that is the difference between a
 * correct economy and one that quietly pays out at a different rate on a
 * 120 Hz phone.
 *
 * Two implementation details matter more than they look:
 *
 * 1. **Ticks are derived by division, not by repeated subtraction.** The
 *    textbook accumulator does `while (acc >= step) { acc -= step; tick(); }`.
 *    That drifts: at 120 fps the frame delta is 8.333…, and after a few
 *    thousand subtractions the residue is enough to land just below a tick
 *    boundary and silently skip a tick. Measured before this was fixed: 599
 *    ticks instead of 600 over 60 simulated seconds at 120 fps, while 30 fps
 *    got all 600. So the tick count comes from `floor(total / tickMs)`, which
 *    cannot drift away from the real elapsed time.
 *
 * 2. **The running total is a compensated (Kahan–Babuška–Neumaier) sum.**
 *    Plain `+=` over tens of thousands of inexact frame deltas accumulates
 *    its own error. The compensation is four extra floating-point operations
 *    per frame and makes the total accurate to ~1 ulp for any session length.
 *
 * The hot path allocates nothing: no closures, no objects, no array methods.
 */
export class FixedStepLoop {
  readonly tickMs: number;
  readonly maxCatchupTicks: number;

  /** Compensated running total of every frame delta fed in, in ms. */
  private totalMs = 0;
  /** Lost-low-order-bits compensation term for `totalMs`. */
  private totalMsError = 0;

  /** Ticks actually executed. The simulation's clock. */
  private elapsedTicks = 0;

  /** Ticks skipped by the catch-up clamp. Diagnostic, and keeps the tick
   *  accounting aligned with `totalMs` after a clamp. */
  private droppedTicks = 0;

  private readonly onTick: () => void;

  constructor(onTick: () => void, options: FixedStepLoopOptions = {}) {
    this.onTick = onTick;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.maxCatchupTicks = options.maxCatchupTicks ?? MAX_CATCHUP_TICKS;
  }

  /**
   * Feed one render frame's elapsed time in. Returns how many ticks ran.
   *
   * Negative, zero and non-finite deltas are ignored rather than trusted. A
   * monotonic clock should never produce them, but a restored tab, a paused
   * debugger or a `performance.now()` polyfill can.
   */
  advance(frameDeltaMs: number): number {
    if (!Number.isFinite(frameDeltaMs) || frameDeltaMs <= 0) return 0;

    this.addToTotal(frameDeltaMs);

    const target = Math.floor(this.correctedTotalMs / this.tickMs);
    const pending = target - (this.elapsedTicks + this.droppedTicks);
    if (pending <= 0) return 0;

    // Bound the work in one frame. Without this, a long stall — a
    // backgrounded tab, a device waking from sleep — hands us a multi-hour
    // delta and the catch-up pass blocks the main thread until it finishes.
    // Time the player spent away is credited by the offline path instead, so
    // discarding the backlog here loses nothing.
    const runnable = pending < this.maxCatchupTicks ? pending : this.maxCatchupTicks;

    let ran = 0;
    while (ran < runnable) {
      this.elapsedTicks += 1;
      ran += 1;
      this.onTick();
    }

    this.droppedTicks += pending - runnable;
    return ran;
  }

  /**
   * Fraction of the way from the last tick boundary to the next, in `[0, 1)`.
   * Renderers interpolate with this so motion is smooth between ticks.
   */
  get alpha(): number {
    const ticks = this.correctedTotalMs / this.tickMs;
    const fraction = ticks - Math.floor(ticks);
    return fraction < 0 ? 0 : fraction;
  }

  get ticks(): number {
    return this.elapsedTicks;
  }

  get dropped(): number {
    return this.droppedTicks;
  }

  /** Simulated milliseconds consumed by executed ticks. */
  get simulatedMs(): number {
    return this.elapsedTicks * this.tickMs;
  }

  /**
   * Restore the tick clock from a save. Does not replay ticks — it rebases the
   * accumulator so the loop continues counting from the saved tick.
   */
  restoreTicks(ticks: number): void {
    this.elapsedTicks = Number.isFinite(ticks) && ticks > 0 ? Math.floor(ticks) : 0;
    this.droppedTicks = 0;
    this.totalMs = this.elapsedTicks * this.tickMs;
    this.totalMsError = 0;
  }

  reset(): void {
    this.totalMs = 0;
    this.totalMsError = 0;
    this.elapsedTicks = 0;
    this.droppedTicks = 0;
  }

  private get correctedTotalMs(): number {
    return this.totalMs + this.totalMsError;
  }

  /** Kahan–Babuška–Neumaier compensated addition. Allocation-free. */
  private addToTotal(delta: number): void {
    const sum = this.totalMs + delta;
    if (Math.abs(this.totalMs) >= Math.abs(delta)) {
      this.totalMsError += this.totalMs - sum + delta;
    } else {
      this.totalMsError += delta - sum + this.totalMs;
    }
    this.totalMs = sum;
  }
}
