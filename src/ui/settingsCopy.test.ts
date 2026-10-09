import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../save/schema.ts';
import { reducedMotionHint, resolveReducedMotionToggle } from './SettingsSheet.tsx';

/**
 * The reduced-motion hint has to describe the state it sits under.
 *
 * DUB-73: the hint was picked with a two-way ternary — `auto` got its own
 * sentence and *everything else* got the `on` sentence. So `off` rendered the
 * word "Off" next to copy claiming shake and confetti had become a flash.
 * These are exact-string assertions on purpose: the bug was not a crash or a
 * missing branch, it was a sentence describing the opposite state, and only
 * the full sentence can catch that.
 *
 * The copy review then found the same contradiction on `auto` under
 * `prefers-reduced-motion: no-preference` — which is the *default* state on
 * most phones, so it was what a first-run player read. One sentence cannot
 * cover `auto`, because `auto` renders two states. Hence the four strings
 * below and the invariant at the bottom, which states the rule both defects
 * broke rather than enumerating the sentences that happened to break it.
 */

const AUTO_REDUCED = 'Following your device setting. Shake and confetti become a flash.';
const AUTO_INTACT = 'Following your device setting. Shake and confetti stay for now.';
const ON = 'Shake and confetti become a flash. Feedback is never removed.';
const OFF = 'Shake, confetti and button motion stay on, whatever your device asks for.';

/** Every sentence that claims motion *has* been reduced says this. */
const CLAIMS_REDUCED = 'become a flash';
/** Every sentence that claims motion is *intact* says this. */
const CLAIMS_INTACT = 'stay';

/**
 * `resolveReducedMotionToggle` reads `window.matchMedia`, and the test
 * environment is `node`, so there is no `window` at all. Installing a minimal
 * one is cheaper than moving the whole suite to jsdom for one media query, and
 * it lets the tests below drive the device preference — which is the axis the
 * `auto` defect lived on.
 */
function setDevicePrefersReduce(reduce: boolean): void {
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({ matches: query.includes('reduce') && reduce }),
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('reducedMotionHint', () => {
  it('tells an `auto` player on a reduce device what their device asked for', () => {
    expect(reducedMotionHint('auto', true)).toBe(AUTO_REDUCED);
  });

  it('does not claim a flash to an `auto` player whose device asked for nothing', () => {
    expect(reducedMotionHint('auto', false)).toBe(AUTO_INTACT);
  });

  it('describes the flash substitution when reduced motion is on', () => {
    expect(reducedMotionHint('on', true)).toBe(ON);
  });

  it('tells an `off` player that motion stays, overriding their device', () => {
    expect(reducedMotionHint('off', false)).toBe(OFF);
  });

  /**
   * The regression itself, stated as the thing that must never be true again:
   * `off` must not borrow `on`'s sentence. An exact-string test per branch
   * already implies this, but naming it keeps the reason visible to whoever
   * next edits the copy.
   */
  it('never shows the same sentence for on and off', () => {
    expect(reducedMotionHint('off', false)).not.toBe(reducedMotionHint('on', true));
  });

  it('covers every value the setting can hold', () => {
    const values = ['auto', 'on', 'off'] as const;
    expect(values).toContain(DEFAULT_SETTINGS.reducedMotion);
    const sentences = new Set([
      ...values.map((v) => reducedMotionHint(v, true)),
      ...values.map((v) => reducedMotionHint(v, false)),
    ]);
    expect(sentences.size).toBe(4);
  });
});

describe('resolveReducedMotionToggle', () => {
  it('ignores the device when the player has chosen explicitly', () => {
    for (const reduce of [true, false]) {
      setDevicePrefersReduce(reduce);
      expect(resolveReducedMotionToggle('on')).toBe(true);
      expect(resolveReducedMotionToggle('off')).toBe(false);
    }
  });

  it('follows the device under `auto`', () => {
    setDevicePrefersReduce(true);
    expect(resolveReducedMotionToggle('auto')).toBe(true);
    setDevicePrefersReduce(false);
    expect(resolveReducedMotionToggle('auto')).toBe(false);
  });
});

/**
 * The invariant both defects are instances of.
 *
 * The toggle renders one word — "On" or "Off" — from `resolvedOn`, and the
 * hint sits directly under it. So the hint must never claim motion has been
 * reduced while the control reads Off, nor claim it is intact while the
 * control reads On. Driving this through the real resolver rather than a
 * hand-written pair list means a new setting value, or a change to how `auto`
 * resolves, is covered the moment it lands — nobody has to remember to think
 * of the case, which is exactly what went wrong with `auto`.
 */
describe('the hint never contradicts the state word', () => {
  const values = ['auto', 'on', 'off'] as const;

  for (const value of values) {
    for (const reduce of [true, false]) {
      it(`reducedMotion=${value} on a ${reduce ? 'reduce' : 'no-preference'} device`, () => {
        setDevicePrefersReduce(reduce);
        const resolvedOn = resolveReducedMotionToggle(value);
        const hint = reducedMotionHint(value, resolvedOn);

        if (resolvedOn) {
          expect(hint).toContain(CLAIMS_REDUCED);
          expect(hint).not.toContain(CLAIMS_INTACT);
        } else {
          expect(hint).toContain(CLAIMS_INTACT);
          expect(hint).not.toContain(CLAIMS_REDUCED);
        }
      });
    }
  }
});
