import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../save/schema.ts';
import { reducedMotionHint } from './SettingsSheet.tsx';

/**
 * The reduced-motion hint has to describe the state it sits under.
 *
 * DUB-73: the hint was picked with a two-way ternary — `auto` got its own
 * sentence and *everything else* got the `on` sentence. So `off` rendered the
 * word "Off" next to copy claiming shake and confetti had become a flash.
 * These are exact-string assertions on purpose: the bug was not a crash or a
 * missing branch, it was a sentence describing the opposite state, and only
 * the full sentence can catch that.
 */

const AUTO = 'Following your device setting. Shake and confetti become a flash.';
const ON = 'Shake and confetti become a flash. Feedback is never removed.';
const OFF = 'Shake, confetti and button motion stay on, whatever your device asks for.';

describe('reducedMotionHint', () => {
  it('tells an `auto` player which setting it is following', () => {
    expect(reducedMotionHint('auto')).toBe(AUTO);
  });

  it('describes the flash substitution when reduced motion is on', () => {
    expect(reducedMotionHint('on')).toBe(ON);
  });

  it('tells an `off` player that motion stays, overriding their device', () => {
    expect(reducedMotionHint('off')).toBe(OFF);
  });

  /**
   * The regression itself, stated as the thing that must never be true again:
   * `off` must not borrow `on`'s sentence. An exact-string test per branch
   * already implies this, but naming it keeps the reason visible to whoever
   * next edits the copy.
   */
  it('never shows the same sentence for on and off', () => {
    expect(reducedMotionHint('off')).not.toBe(reducedMotionHint('on'));
  });

  it('covers every value the setting can hold', () => {
    const values = ['auto', 'on', 'off'] as const;
    expect(values).toContain(DEFAULT_SETTINGS.reducedMotion);
    expect(new Set(values.map(reducedMotionHint)).size).toBe(values.length);
  });
});
