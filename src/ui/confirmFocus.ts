/**
 * Where focus goes when a two-step confirm reveals and when it closes again
 * (DUB-80).
 *
 * `activation.ts` gave the Settings controls a keyboard route. That left one
 * thing it could not fix, because it is not a handler: both steps of the reset
 * confirm *replace* the button that was pressed. React unmounts "Reset club…"
 * to mount "Delete my club" / "Keep it", and unmounts those to bring the first
 * one back. An element that had focus and is then removed does not hand focus
 * on — the browser drops it to `<body>`.
 *
 * For a pointer that is invisible. For a keyboard it is the whole interaction:
 * press Enter on "Reset club…", the choice you asked for appears, and your
 * focus is now at the top of the document, several Tab stops and one sheet
 * away from the two buttons you are looking at. WCAG 2.4.3 Focus Order.
 *
 * The ticket asked specifically where an Enter lands when the destructive
 * button appears, and the answer has two halves:
 *
 *  - **Today it lands nowhere, which is safe by accident.** Focus is on
 *    `<body>`, so a leaned-on Enter's auto-repeats reach no button at all. The
 *    two-step confirm is not what saves the club here — losing focus is.
 *  - **Repairing the focus order must not spend that.** Move focus to
 *    "Delete my club" and a held Enter deletes the save on the repeat that
 *    follows the press that revealed it: the exact mis-fire the second step
 *    exists to prevent. So focus goes to the *safe* choice. "Keep it" is the
 *    one a repeat can hit for free, and `activation.ts`'s key-repeat guard
 *    then declines even that — the repeat's `keydown` arrives at the newly
 *    focused button with `repeat: true`, which vetoes the `click` behind it.
 *    Two independent reasons a held Enter does not delete a club, where there
 *    is currently one and it is a side effect.
 *
 * Kept as a pure function over the three facts that decide it, for the reason
 * `activation.ts` gives: `vitest` runs on the node environment, there is no
 * DOM to mount a sheet into, and the part worth pinning is the decision rather
 * than React's call to `.focus()`.
 */

/**
 * Which control should hold focus after the confirm step has changed, or
 * `null` to leave focus where it is.
 */
export type ConfirmFocusTarget = 'cancel' | 'reveal' | null;

export interface ConfirmFocusInput {
  /** Is the destructive choice on screen now? */
  readonly confirming: boolean;
  /** Was it on screen on the previous render? */
  readonly wasConfirming: boolean;
  /**
   * Has the browser dropped focus to `<body>` (or lost it altogether)?
   *
   * This is the signal that the element focus was on is the one that just got
   * unmounted, and so that moving focus is restoring it rather than taking it.
   * A player who tabbed away before the step changed still has focus
   * somewhere, and a settings sheet that yanks it back is its own defect.
   */
  readonly focusLost: boolean;
}

export function confirmFocusTarget({
  confirming,
  wasConfirming,
  focusLost,
}: ConfirmFocusInput): ConfirmFocusTarget {
  // Nothing changed — a re-render for any of the other reasons this component
  // has (a toggle flipped, the save-status banner appeared) must not move
  // focus. This is the common case and it is the whole reason the previous
  // value is an input.
  if (confirming === wasConfirming) return null;
  if (!focusLost) return null;

  // Revealing: the safe choice, never the destructive one. See the header.
  // Closing: back to the button that opened it, which is where the player's
  // place in the sheet was and is also what `Escape`-less dismissal needs —
  // "Keep it" means "nothing happened", and focus landing back on
  // "Reset club…" is the only way that reads as true to a keyboard.
  return confirming ? 'cancel' : 'reveal';
}
