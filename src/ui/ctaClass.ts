/**
 * The buy button's class list, as a function.
 *
 * It lives apart from `Sheet.tsx` for one reason: whether the pressed state is
 * *visible* depends on which classes are on the element and how specific the
 * rule that matches them is, and that is a fact worth pinning in a test rather
 * than reading off the cascade by eye. `vitest` runs on the node environment
 * with no DOM, so the testable form of "the press is not out-specified by the
 * affordable fill" is "the element carries `cta--pressed` next to `cta`, and
 * carries `cta--affordable` only when the tap actually buys something".
 *
 * DUB-38: `.cta--pressed` alone is (0,1,0) and would lose to
 * `.cta--cyan.cta--affordable` (0,2,0) — the same specificity trap the Door's
 * demoted treatment walked into. `ui.css` therefore matches the press as
 * `.cta.cta--pressed` (0,2,0), which is why `cta` is always first in this list
 * and never conditional.
 */
export interface CtaClassInput {
  readonly accent: 'magenta' | 'cyan';
  /** The player can pay for it. */
  readonly affordable: boolean;
  /** Nothing left to buy, or buying is switched off. */
  readonly inactive: boolean;
  /**
   * Nothing left to buy — the row shows a badge instead of a price (DUB-42).
   *
   * Narrower than `inactive`, and deliberately not derived from it: `inactive`
   * is `disabled || isDone`, so a button with buying switched off is inactive
   * but *not* maxed. Only the maxed row has a `--gold-vip` badge inside it, and
   * `.cta--maxed` is what moves the `aria-disabled` dim off the button and onto
   * the label so that badge can clear 4.5:1.
   *
   * Required rather than optional on purpose. DUB-38 and DUB-42 landed on the
   * same expression from opposite directions, and the resolution that drops
   * this field compiles happily while putting the badge back at 4.37:1 — so the
   * type system is asked to refuse it instead.
   */
  readonly maxed: boolean;
  /** A finger or a cursor is down on it right now. */
  readonly pressed: boolean;
}

export function ctaClassName({
  accent,
  affordable,
  inactive,
  maxed,
  pressed,
}: CtaClassInput): string {
  const classes = ['cta', `cta--${accent}`];

  // The accent fill is the "you can buy this" signal, so it is withheld from a
  // button whose tap would buy nothing. That makes `cta--affordable` the exact
  // inverse of "this tap is a dead end", which is what `ui.css` keys the ring
  // and the price flash off with `:not(.cta--affordable)`.
  if (affordable && !inactive) classes.push('cta--affordable');

  if (maxed) classes.push('cta--maxed');

  if (pressed) classes.push('cta--pressed');

  return classes.join(' ');
}
