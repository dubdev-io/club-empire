/**
 * When the boot progress bar is allowed to appear.
 *
 * Its own module because the rule is the interesting part and it is the part a
 * unit test can hold: the component around it needs a DOM, a store and a
 * compositor, none of which the `node` test environment has.
 */

/** The brief's threshold: a progress bar, but only once the load is actually slow. */
export const BOOT_PROGRESS_AFTER_MS = 1000;

/** How long the reveal takes. Mirrors `bf-reveal` in the inlined fallback. */
export const BOOT_PROGRESS_REVEAL_MS = 200;

/**
 * The whole reveal animation: the wait, then the fade.
 *
 * One animation rather than a delay plus a fade, because the delay is the part
 * that cannot be trusted — see below.
 */
export const BOOT_PROGRESS_CYCLE_MS = BOOT_PROGRESS_AFTER_MS + BOOT_PROGRESS_REVEAL_MS;

/**
 * `animation-delay` for the bar, given how long this load has already taken.
 *
 * **Negative**, which is a seek rather than a wait: it starts the animation
 * immediately, already advanced to where it would be if it had begun at the
 * navigation. The bar is therefore running from the first frame it is in the
 * tree, and an animation that is already running is one the compositor can own.
 *
 * That is the point of DUB-21. The previous version gated the bar's *mount* on a
 * `setTimeout`, and on a load slow enough to need the bar that timer never ran:
 * `startGame` takes the WebGL context and every generated texture in unbroken
 * tasks, so the callback came due while the thread was busy and the unmount
 * cleared it before it ever got a slot. Measured on `74fb0df` at 10x CPU —
 * `.boot` up 854 → 1411, timer scheduled at 853 for +147 ms, one 474 ms task
 * running 937 → 1411, callback never invoked. The bar appeared only on loads
 * where `.boot` happened to mount *after* the threshold and a `useState`
 * initializer caught it, which is the opposite of the case it exists for.
 *
 * A positive `animation-delay` would also get the bar into the DOM, and measured
 * no worse here. It is avoided anyway because it leaves one main-thread
 * dependency in place: an animation still waiting out its delay has not started,
 * and starting it is work for the thread the boot has taken. A seek has nothing
 * left to wait for.
 *
 * Counted from the navigation rather than from mount, so a boot that has already
 * spent 900 ms downloading the bundle gets the bar 100 ms later rather than a
 * second after React woke up — and so it lands with the inlined fallback's own
 * 1 s reveal, which counts from the same origin.
 */
export function bootProgressAnimationDelayMs(elapsedMs: number): number {
  // `NaN` first: it fails every comparison, so it has to be named rather than
  // ruled out by one.
  if (Number.isNaN(elapsedMs) || elapsedMs <= 0) return 0;
  // Clamped: past the end of the animation there is nothing further to seek to,
  // and `animation-fill-mode: both` holds the revealed frame.
  return -Math.min(BOOT_PROGRESS_CYCLE_MS, elapsedMs);
}
