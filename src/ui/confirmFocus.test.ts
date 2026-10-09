/**
 * The reset confirm's focus order (DUB-80).
 *
 * `activation.test.ts` pins the handlers: Enter and Space act, and one touch
 * or one keypress acts once. This file pins the thing a handler cannot fix —
 * that each step of the confirm unmounts the button that was pressed, so a
 * keyboard player's place in the sheet is destroyed by their own press unless
 * something puts it back.
 *
 * Two of these cases are safety rather than ergonomics, and they are the ones
 * the ticket asked about: the step that reveals an unrecoverable action must
 * not hand focus to it, and a re-render for any other reason must not move
 * focus at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { confirmFocusTarget } from './confirmFocus.ts';

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
}

describe('where focus goes when the confirm step changes', () => {
  it('lands on the safe choice when the destructive one is revealed', () => {
    // The whole point. Not `'confirm'` — a leaned-on Enter whose repeat lands
    // on a focused "Delete my club" is the mis-fire the two-step confirm was
    // built to prevent, and focusing it would reintroduce it in the name of
    // fixing focus order.
    expect(confirmFocusTarget({ confirming: true, wasConfirming: false, focusLost: true })).toBe(
      'cancel',
    );
  });

  it('goes back to the button that opened it when the step closes', () => {
    expect(confirmFocusTarget({ confirming: false, wasConfirming: true, focusLost: true })).toBe(
      'reveal',
    );
  });

  it('never returns the destructive button, on any input', () => {
    // Exhaustive over the three booleans, because this is the assertion that
    // has to survive someone editing the function rather than reading it.
    for (const confirming of [false, true]) {
      for (const wasConfirming of [false, true]) {
        for (const focusLost of [false, true]) {
          const target = confirmFocusTarget({ confirming, wasConfirming, focusLost });
          expect(target === 'cancel' || target === 'reveal' || target === null).toBe(true);
        }
      }
    }
  });
});

describe('when it leaves focus alone', () => {
  it('does nothing on a re-render that did not change the step', () => {
    // A toggle flipping re-renders the whole sheet. Focus is on the toggle,
    // and it stays there.
    expect(confirmFocusTarget({ confirming: false, wasConfirming: false, focusLost: true })).toBe(
      null,
    );
    expect(confirmFocusTarget({ confirming: true, wasConfirming: true, focusLost: true })).toBe(
      null,
    );
  });

  it('does not take focus from somewhere the player moved it', () => {
    // `focusLost` false means the element focus is on is still mounted, so the
    // step changing was not what moved it. Restoring here would be a settings
    // sheet yanking the caret out from under a player who had tabbed on.
    expect(confirmFocusTarget({ confirming: true, wasConfirming: false, focusLost: false })).toBe(
      null,
    );
    expect(confirmFocusTarget({ confirming: false, wasConfirming: true, focusLost: false })).toBe(
      null,
    );
  });
});

/**
 * Source assertions, for the same reason `activation.test.ts` has them: the
 * decision above is only worth anything if the sheet is actually wired to it,
 * and there is no DOM here to mount the sheet into and check.
 */
describe('the call site', () => {
  const sheet = source('SettingsSheet.tsx');

  it('routes the sheet through the one decision', () => {
    expect(sheet).toContain("from './confirmFocus.ts'");
    expect(sheet.match(/confirmFocusTarget\(\{/g) ?? []).toHaveLength(1);
  });

  it('has a ref on the reveal and on the cancel, and none on the destructive button', () => {
    // Two refs, so there is nothing for a later edit to point `.focus()` at
    // except the two buttons that are safe to focus.
    expect(sheet.match(/ref=\{\w+Ref\}/g) ?? []).toHaveLength(2);
    expect(sheet).toContain('ref={revealRef}');
    expect(sheet).toContain('ref={cancelRef}');
  });

  it('reads focus loss from the live document rather than assuming it', () => {
    // The guard above is only honest if the input is measured. A hard-coded
    // `focusLost: true` would pass every test in this file and still steal
    // focus from a player who had tabbed away.
    expect(sheet).toContain('document.activeElement');
    expect(sheet).not.toContain('focusLost: true');
  });
});
