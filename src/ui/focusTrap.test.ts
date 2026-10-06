/**
 * The focus trap, where it can be tested without a browser (DUB-72).
 *
 * Two different kinds of fact, and the split is the same one `focusRing.test.ts`
 * draws: `vitest` runs on the node environment, so anything that needs a real
 * focus engine belongs to `npm run audit:focus`, which tabs all three sheets in
 * Chrome and counts the stops behind the scrim.
 *
 *  - **The decision.** `tabDestination` is the whole of where Tab goes, as index
 *    arithmetic with no DOM in it. The case worth pinning is not the wrap — it is
 *    the `null`: a trap that moved focus by hand on *every* Tab would erase the
 *    ring DUB-50 draws, because Chrome withholds `:focus-visible` from a bare
 *    programmatic `.focus()`.
 *  - **The coverage.** Every `aria-modal` dialog in `src/` installs the trap.
 *    This is the test that fails when a fourth dialog is added, which is how this
 *    bug shipped in the first place: three dialogs claimed to be modal and the
 *    claim was never checked anywhere.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tabDestination } from './focusTrap.ts';

describe('where Tab goes', () => {
  // Five stops: the sheet with a ✕ and four buy buttons, which is `bars`.
  const COUNT = 5;

  it('leaves the middle of the ring to the browser, so the ring survives', () => {
    // The load-bearing `null`s. A native focus move is the only kind Chrome
    // reliably grants `:focus-visible` to, so every Tab that already lands
    // inside the dialog has to be left alone rather than re-implemented.
    for (const from of [0, 1, 2, 3]) {
      expect(tabDestination(COUNT, from, false), `forward from ${from}`).toBeNull();
    }
    for (const from of [1, 2, 3, 4]) {
      expect(tabDestination(COUNT, from, true), `backward from ${from}`).toBeNull();
    }
  });

  it('wraps at both ends rather than letting Tab out of the dialog', () => {
    expect(tabDestination(COUNT, COUNT - 1, false)).toBe(0);
    expect(tabDestination(COUNT, 0, true)).toBe(COUNT - 1);
  });

  it('pulls focus in from outside, at the end Tab was heading for', () => {
    // `from < 0` is focus on the bottom bar, on `body` after a blur, or on the
    // dialog panel itself the moment it opened — the case that was the bug.
    // Forward goes to the first stop; Shift+Tab to the last, because a player
    // tabbing backwards into a dialog expects to arrive at its end.
    expect(tabDestination(COUNT, -1, false)).toBe(0);
    expect(tabDestination(COUNT, -1, true)).toBe(COUNT - 1);
  });

  it('has no answer for a dialog with no stops, rather than a wrong one', () => {
    // Not a state the game ships — every sheet has its ✕ and every card its CTA
    // — and the caller puts focus on the panel instead. What it must not do is
    // return index 0 of an empty list.
    expect(tabDestination(0, -1, false)).toBeNull();
    expect(tabDestination(0, 2, true)).toBeNull();
  });

  it('is total on a one-stop dialog, where both ends are the same stop', () => {
    // `ClubComplete` and `OfflineCard` are this: one CTA. Tab and Shift+Tab both
    // have to resolve to it rather than fall through to `null` and escape.
    expect(tabDestination(1, 0, false)).toBe(0);
    expect(tabDestination(1, 0, true)).toBe(0);
  });
});

describe('every dialog in the game', () => {
  // Read as text for the same reason the stylesheet is in `focusRing.test.ts`:
  // there is no DOM here to render them into, and what is being checked is that
  // nobody wrote a fourth one without the trap.
  const FILES = [
    './Sheet.tsx',
    './Overlays.tsx',
    './App.tsx',
    './BarsSheet.tsx',
    './DoorSheet.tsx',
    './SettingsSheet.tsx',
  ];

  // Comments stripped before anything is counted. The components explain the
  // trap in prose that quotes `aria-modal="true"`, so counting raw text makes a
  // doc comment look like a fourth dialog. Crude on purpose: stripping block and
  // line comments by regex is wrong on a string literal that contains either
  // delimiter, and none of these six files has one.
  const code = (body: string): string =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const sources = FILES.map((file) => ({
    file,
    body: code(readFileSync(new URL(file, import.meta.url), 'utf8')),
  }));

  it('backs up `aria-modal` with the trap, in the same component', () => {
    for (const { file, body } of sources) {
      const modals = body.match(/aria-modal="true"/g)?.length ?? 0;
      if (modals === 0) continue;

      expect(body, `${file} claims aria-modal`).toContain('useFocusTrap');
      // One trap per claim. `Overlays.tsx` has two dialogs in it and needs two.
      expect(body.match(/useFocusTrap</g)?.length ?? 0, `${file}: traps vs aria-modal`).toBe(modals);
    }
  });

  it('gives each trapped dialog somewhere for focus to land', () => {
    // `tabIndex={-1}` on the `role="dialog"` element is what lets focus arrive
    // on the panel rather than on its ✕, and it is also the fallback the Tab
    // handler uses when a dialog has no stops at all. A trap without it throws
    // focus nowhere.
    for (const { file, body } of sources) {
      const modals = body.match(/aria-modal="true"/g)?.length ?? 0;
      if (modals === 0) continue;
      expect(body.match(/tabIndex=\{-1\}/g)?.length ?? 0, `${file}: tabIndex={-1}`).toBe(modals);
    }
  });

  it('traps nothing that is not a dialog — the ★ burst is a toast', () => {
    // `StarBurst` is `role="status"`, holds no controls and auto-dismisses.
    // Trapping focus in it would be trapping focus in a notification.
    const overlays = sources.find((s) => s.file === './Overlays.tsx')!.body;
    const burst = overlays.slice(overlays.indexOf('export function StarBurst'));
    const next = burst.indexOf('\nexport function', 1);
    expect(next, 'StarBurst is not the last export').toBeGreaterThan(0);
    expect(burst.slice(0, next)).not.toContain('useFocusTrap');
  });
});
