import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from './fixedStepLoop.ts';
import { TICK_SECONDS, TICKS_PER_SECOND } from './constants.ts';

/**
 * A stand-in economy: 2 cash per simulated second, accumulated one tick at a
 * time.
 *
 * Deliberately not the real `tickClub`. What is under test here is the
 * accumulator, and the cleanest way to see a tick-counting bug is for the
 * thing being accumulated to be arithmetic simple enough that the expected
 * answer can be written down by hand.
 */
function createEconomyState(): { money: number } {
  return { money: 0 };
}

function stepEconomy(economy: { money: number }): void {
  economy.money += 2 * TICK_SECONDS;
}

/**
 * Drive the loop for `seconds` of simulated wall-clock time at a given frame
 * rate and return the resulting economy.
 *
 * This is the test that protects the single most important property of an idle
 * game: income is a function of elapsed time, not of how many frames the
 * device managed to draw.
 */
function runAtFrameRate(fps: number, seconds: number) {
  const economy = createEconomyState();
  const loop = new FixedStepLoop(() => stepEconomy(economy));

  const frameMs = 1000 / fps;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i += 1) {
    loop.advance(frameMs);
  }

  return { economy, loop };
}

describe('FixedStepLoop', () => {
  it('advances the economy identically at 30, 60 and 120 fps', () => {
    const seconds = 60;

    const at30 = runAtFrameRate(30, seconds);
    const at60 = runAtFrameRate(60, seconds);
    const at120 = runAtFrameRate(120, seconds);

    // Same number of ticks: 10 per simulated second.
    expect(at30.loop.ticks).toBe(seconds * TICKS_PER_SECOND);
    expect(at60.loop.ticks).toBe(seconds * TICKS_PER_SECOND);
    expect(at120.loop.ticks).toBe(seconds * TICKS_PER_SECOND);

    // Same money, to the cent. Not "approximately" — identical tick counts
    // over identical arithmetic must give an identical number.
    expect(at60.economy.money).toBeCloseTo(at30.economy.money, 10);
    expect(at120.economy.money).toBeCloseTo(at30.economy.money, 10);

    // And it is the right amount: 2/s for 60 s at bar level 1.
    expect(at30.economy.money).toBeCloseTo(120, 6);
  });

  it('matches a steady frame rate when frames are jittery', () => {
    const seconds = 30;
    const steady = runAtFrameRate(60, seconds);

    // A deliberately uneven frame sequence: a 4 ms frame, a 120 ms hitch, and
    // everything between. The pattern sums to 200 ms and is repeated 150
    // times, so the simulated total is exactly 30 s with no help from the
    // test's own arithmetic.
    const economy = createEconomyState();
    const loop = new FixedStepLoop(() => stepEconomy(economy));
    const pattern = [8, 16, 32, 4, 120, 16, 4];
    const patternMs = 200;
    const repeats = (seconds * 1000) / patternMs;
    for (let r = 0; r < repeats; r += 1) {
      for (let i = 0; i < pattern.length; i += 1) {
        loop.advance(pattern[i]!);
      }
    }

    expect(loop.ticks).toBe(steady.loop.ticks);
    expect(economy.money).toBeCloseTo(steady.economy.money, 10);
  });

  // Regression guard. The naive `acc -= tickMs` accumulator passed a 60 s
  // check at 30 and 60 fps but lost ticks at awkward frame rates over longer
  // runs, because the subtraction residue compounds. These are the rates and
  // durations that exposed it.
  it.each([
    [30, 600],
    [60, 600],
    [90, 600],
    [120, 600],
    [144, 600],
    [120, 60],
  ])('does not drift at %i fps over %i simulated seconds', (fps, seconds) => {
    const { loop, economy } = runAtFrameRate(fps, seconds);
    expect(loop.ticks).toBe(seconds * TICKS_PER_SECOND);
    expect(loop.dropped).toBe(0);
    expect(economy.money).toBeCloseTo(2 * seconds, 6);
  });

  it('exposes a render interpolation alpha in [0, 1)', () => {
    const loop = new FixedStepLoop(() => {});
    loop.advance(25); // a quarter of a 100 ms tick
    expect(loop.ticks).toBe(0);
    expect(loop.alpha).toBeCloseTo(0.25, 10);

    loop.advance(80); // crosses one tick boundary, 5 ms left over
    expect(loop.ticks).toBe(1);
    expect(loop.alpha).toBeCloseTo(0.05, 10);
    expect(loop.alpha).toBeLessThan(1);
  });

  it('clamps catch-up instead of blocking the frame, and reports the drop', () => {
    let ticks = 0;
    const loop = new FixedStepLoop(() => {
      ticks += 1;
    }, { maxCatchupTicks: 10 });

    // One hour of delta arriving in a single frame (tab restored from sleep).
    loop.advance(60 * 60 * 1000);

    expect(ticks).toBe(10);
    expect(loop.dropped).toBe(35990);
    // The backlog is discarded, not carried: the next frame is normal.
    expect(loop.alpha).toBeCloseTo(0, 10);
  });

  it('ignores negative, zero and non-finite frame deltas', () => {
    let ticks = 0;
    const loop = new FixedStepLoop(() => {
      ticks += 1;
    });

    expect(loop.advance(-500)).toBe(0);
    expect(loop.advance(0)).toBe(0);
    expect(loop.advance(Number.NaN)).toBe(0);
    expect(loop.advance(Number.POSITIVE_INFINITY)).toBe(0);
    expect(ticks).toBe(0);
    expect(loop.alpha).toBe(0);
  });
});
