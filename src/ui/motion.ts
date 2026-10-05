/**
 * Reduced motion, resolved once (DUB-49).
 *
 * The game used to answer "is motion suppressed?" in two places that did not
 * agree. `store.reducedMotion` composed the OS `prefers-reduced-motion` query
 * with the Settings toggle and surfaced as `.meter--still` / `.star-burst--still`
 * — that one honoured the player. Three rules in `ui.css` keyed off a bare
 * `@media (prefers-reduced-motion: reduce)` instead, which cannot see a toggle:
 * the sheet entrance, the card entrance, and the buy button's press scale. So a
 * player who switched reduced motion *on* in Settings still got a sliding
 * sheet, and one who switched it explicitly *off* lost the press scale.
 *
 * This module is the single resolution. `resolveReducedMotion` is the whole
 * rule, as a pure function; `applyMotionRootClass` publishes the answer to
 * `<html>` so the stylesheet can read it without every animated element having
 * to render a class list for itself.
 *
 * Two classes rather than one, and neither present until the answer lands:
 *
 *  - `is-still`  — motion is suppressed.
 *  - `is-moving` — motion is allowed, and that is an explicit answer, not an
 *    absence of one.
 *
 * `is-moving` is what lets the bare `@media` blocks stay in the file as the
 * first-paint fallback without breaking the explicit `off`. Each one is scoped
 * `html:not(.is-moving)`, so it carries the first paint, keeps covering a
 * player who never opens Settings, and stops applying the moment the store
 * resolves to "motion is fine". See the motion section at the top of `ui.css`.
 */
import type { SavedSettings } from '../save/schema.ts';

export const MOTION_STILL_CLASS = 'is-still';
export const MOTION_MOVING_CLASS = 'is-moving';

/**
 * The resolved flag: `on`/`off` are the player's word and win outright, `auto`
 * defers to the OS.
 *
 * This is the only place the three-state setting becomes a boolean. Everything
 * downstream — the Pixi scene, the HUD meter, the ★ burst, the two root classes
 * — reads the resolved value out of the store and never re-derives it.
 */
export function resolveReducedMotion(
  preference: SavedSettings['reducedMotion'],
  osPrefersReduce: boolean,
): boolean {
  if (preference === 'on') return true;
  if (preference === 'off') return false;
  return osPrefersReduce;
}

/** Just enough of `Element` to carry the two flags, so this is testable. */
export interface MotionRoot {
  readonly classList: Pick<DOMTokenList, 'toggle'>;
}

/**
 * Mirror the resolved flag onto the root element.
 *
 * Both classes are written on every call, because "motion is allowed" has to be
 * stated to override the media-query fallback — leaving `is-moving` off would
 * leave an explicit `off` looking identical to a page that has not resolved yet.
 */
export function applyMotionRootClass(root: MotionRoot, still: boolean): void {
  root.classList.toggle(MOTION_STILL_CLASS, still);
  root.classList.toggle(MOTION_MOVING_CLASS, !still);
}
