import { describe, expect, it } from 'vitest';

import { SHOTS, isReady, missingGlobals, readyBudgetMs } from './screenshots.ts';

/**
 * The screenshot driver's two gates (DUB-108).
 *
 * The bug these cover was not in the browser half — it was that the readiness
 * loop ran out of attempts and *fell through* to the shutter, so a boot splash
 * got written under a state's filename with exit 0. The decisions that now
 * stop that are pure functions, so they are tested without a browser; the CDP
 * plumbing around them is not, and that is the part a real `npm run shots` run
 * exercises.
 */

describe('readiness predicate', () => {
  it('needs the store, and the runtime too when the shot is not the boot splash', () => {
    expect(isReady({ clubStore: true, club: true }, true)).toBe(true);
    expect(isReady({ clubStore: true, club: false }, true)).toBe(false);
    expect(isReady({ clubStore: false, club: true }, true)).toBe(false);
  });

  it('lets the boot shot through on the store alone — it is photographed mid-boot', () => {
    expect(isReady({ clubStore: true, club: false }, false)).toBe(true);
  });

  it('never calls a page with no globals ready', () => {
    expect(isReady({ clubStore: false, club: false }, false)).toBe(false);
  });
});

describe('missingGlobals', () => {
  it('names what the failure message has to report', () => {
    expect(missingGlobals({ clubStore: false, club: false }, true)).toEqual([
      'window.__clubStore',
      'window.__club',
    ]);
    expect(missingGlobals({ clubStore: true, club: false }, true)).toEqual(['window.__club']);
  });

  it('does not blame the runtime on a shot that never needed it', () => {
    expect(missingGlobals({ clubStore: false, club: false }, false)).toEqual(['window.__clubStore']);
  });

  it('is empty exactly when the shot is ready', () => {
    for (const requiresRuntime of [true, false]) {
      for (const clubStore of [true, false]) {
        for (const club of [true, false]) {
          const globals = { clubStore, club };
          expect(missingGlobals(globals, requiresRuntime).length === 0).toBe(
            isReady(globals, requiresRuntime),
          );
        }
      }
    }
  });
});

describe('readyBudgetMs', () => {
  it('defaults generously — 6s was a fast-machine number', () => {
    expect(readyBudgetMs(undefined)).toBe(30_000);
    expect(readyBudgetMs('')).toBe(30_000);
    expect(readyBudgetMs('   ')).toBe(30_000);
    expect(readyBudgetMs(undefined, 5_000)).toBe(5_000);
  });

  it('takes an override from the environment', () => {
    expect(readyBudgetMs('90000')).toBe(90_000);
    expect(readyBudgetMs('1')).toBe(1);
  });

  it('refuses a budget that would silently disable the gate', () => {
    // `Number('30s')` is NaN, and every `Date.now() >= NaN` comparison is
    // false — a budget that never expires is the bug all over again.
    expect(() => readyBudgetMs('30s')).toThrow(/positive number/);
    expect(() => readyBudgetMs('0')).toThrow(/positive number/);
    expect(() => readyBudgetMs('-1')).toThrow(/positive number/);
  });
});

describe('the shot list', () => {
  it('gives every state a selector only that state satisfies', () => {
    for (const shot of SHOTS) {
      expect(shot.expectSelector, shot.name).toBeTruthy();
      // `.boot` is the splash's own marker, so the boot shot is the one state
      // allowed to assert it. Any other shot asserting it would re-admit the
      // exact picture DUB-108 is about.
      if (shot.name !== '01-boot') {
        expect(shot.expectSelector, shot.name).not.toBe('.boot');
      }
    }
  });

  it('has unique names, since the name is the output filename', () => {
    const names = SHOTS.map((shot) => shot.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
