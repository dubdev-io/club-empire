/**
 * The boot state has to actually reach the screen (DUB-11 defect 3).
 *
 * Measured at `8e650f4`: across every CPU rate and a 1.6 Mbps network, React
 * committed `.boot` **zero** times. Its first and only commit to `#ui-root` was
 * the playing HUD. Two separate causes, and neither is visible to a unit test of
 * a component:
 *
 *  1. A concurrent root schedules its first commit on React's scheduler, and
 *     `startGame()` then holds the main thread through the WebGL context and
 *     texture generation — so the commit landed after boot had already set
 *     `booting: false`. Fixed by committing synchronously and starting the game
 *     after the first paint.
 *  2. The long phase of a cold load is the bundle in flight, during which none of
 *     our JavaScript is running. A spinner that only exists in a React component
 *     cannot be on screen for the one phase slow enough to need it. Fixed by
 *     putting the spinner and the progress bar in the inlined fallback.
 *
 * These are source assertions because the subject is module-evaluation ordering
 * and inlined HTML, and the vitest environment is `node` with no DOM. The real
 * verification is a CDP probe over the built bundle — `.boot` committed, painted,
 * and handed over in the same mutation batch as the fallback's removal. This
 * test exists so the ordering cannot be quietly undone between QA passes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOT_PROGRESS_AFTER_MS,
  BOOT_PROGRESS_CYCLE_MS,
  bootProgressAnimationDelayMs,
} from './bootProgress.ts';

const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('./Overlays.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

describe('the React boot screen is committed before the game starts', () => {
  it('flushes the first render synchronously', () => {
    // A plain `root.render()` leaves the boot tree one scheduler tick away, and
    // that tick never came before boot finished.
    expect(main).toMatch(/flushSync\(\s*\(\)\s*=>\s*\{/);
    expect(main).toMatch(/import \{ flushSync \} from 'react-dom'/);
  });

  it('removes the inlined fallback only after that commit', () => {
    const flushAt = main.indexOf('flushSync');
    const removeAt = main.indexOf("getElementById('boot-fallback')");

    expect(flushAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(flushAt);
  });

  it('starts the game after a paint rather than in the same task', () => {
    // A synchronous commit is not a paint. Without the deferral the boot screen
    // is committed and replaced without the pixels ever changing.
    expect(main).toMatch(/afterFirstPaint\(/);
    const deferAt = main.indexOf('afterFirstPaint(() =>');
    const startAt = main.indexOf('startGame(gameRoot');

    expect(deferAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(deferAt);
  });
});

describe('the inlined fallback carries the loading indicators itself', () => {
  it('has a spinner that needs no JavaScript', () => {
    expect(indexHtml).toMatch(/data-spinner/);
    // Animated by CSS, because there is nothing else running yet.
    expect(indexHtml).toMatch(/@keyframes bf-spin/);
  });

  it('has a progress bar revealed on the brief 1 s threshold', () => {
    expect(indexHtml).toMatch(/data-progress/);
    // The reveal is a 1 s animation delay — the only way to time it without JS.
    expect(indexHtml).toMatch(/animation:\s*bf-reveal[^;]*\b1s\b/);
  });

  it('still has the club silhouette that stops the white flash', () => {
    expect(indexHtml).toMatch(/bf-silhouette/);
    expect((indexHtml.match(/class="bf-bar"/g) ?? []).length).toBe(3);
  });
});

describe('the React progress bar waits out the same second', () => {
  it('seeks the reveal to the navigation, not to mount', () => {
    // A boot that has already spent 900 ms downloading the bundle is 100 ms from
    // the threshold, not a second from it — and the inlined fallback it takes
    // over from is counting from the same origin.
    expect(bootProgressAnimationDelayMs(0)).toBe(0);
    expect(bootProgressAnimationDelayMs(900)).toBe(-900);
    expect(bootProgressAnimationDelayMs(999.6)).toBeCloseTo(-999.6, 5);
  });

  it('is negative, so the animation is running rather than pending', () => {
    // A seek, not a wait. An animation still counting down a positive delay has
    // not started, and starting it is work for the thread the boot has taken.
    expect(bootProgressAnimationDelayMs(500)).toBeLessThan(0);
    expect(bootProgressAnimationDelayMs(BOOT_PROGRESS_AFTER_MS + 1)).toBeLessThan(
      -BOOT_PROGRESS_AFTER_MS,
    );
  });

  it('never seeks past the end, whatever the clock says', () => {
    // `.boot` mounting well after the threshold: the reveal is already over and
    // `both` holds the last frame.
    expect(bootProgressAnimationDelayMs(4000)).toBe(-BOOT_PROGRESS_CYCLE_MS);
    expect(bootProgressAnimationDelayMs(Number.POSITIVE_INFINITY)).toBe(-BOOT_PROGRESS_CYCLE_MS);
    expect(bootProgressAnimationDelayMs(-50)).toBe(0);
    expect(bootProgressAnimationDelayMs(Number.NaN)).toBe(0);
  });

  it('hands the delay to CSS rather than to a timer (DUB-21)', () => {
    // The defect: a `setTimeout` gating the mount. `startGame` holds the main
    // thread across the whole boot window, so the callback was cleared by the
    // unmount before it ever got a slot — measured at 10x CPU on `74fb0df`,
    // `.boot` up 854 → 1411 with one 474 ms task from 937 to 1411.
    expect(overlays).not.toMatch(/setTimeout\(/);
    expect(overlays).toMatch(/animationDelay: `\$\{animationDelayMs\}ms`/);
    // Unconditionally in the tree: there is no re-render to mount it with.
    expect(overlays).not.toMatch(/\{slow && \(/);
    expect(overlays).not.toMatch(/\{progress > 0 && \(/);
  });

  it('sweeps rather than sitting at 0% while there is no figure to report', () => {
    // `bootProgress` is 0 at the commit that puts the bar on screen and its next
    // value lands after texture generation — on the far side of the blocked
    // window. A determinate fill would be an empty track for exactly as long as
    // the bar is visible, which reads as broken rather than as busy.
    expect(overlays).toMatch(/const indeterminate = progress <= 0/);
    expect(overlays).toMatch(/boot__progress-fill--sweep/);
    // A transform, so the sweep keeps moving while the boot owns the thread —
    // and the same geometry as `bf-sweep`, so the handover is invisible.
    expect(css).toMatch(/@keyframes boot-progress-sweep\s*\{[^}]*\{\s*transform: translateX/);
    expect(indexHtml).toMatch(/@keyframes bf-sweep/);
  });

  it('reveals with an animation, with the bar visible if animations are off', () => {
    expect(css).toMatch(
      new RegExp(`animation:\\s*boot-progress-reveal\\s+${BOOT_PROGRESS_CYCLE_MS}ms[^;]*\\bboth\\b`),
    );
    // The threshold expressed as a keyframe offset: 1000 of 1200 ms.
    expect(css).toMatch(/@keyframes boot-progress-reveal\s*\{\s*0%,\s*83\.333%/);
    // `from { opacity: 0 }` inside the keyframes, never on the rule: an
    // `opacity: 0` base turns "animations disabled" into a bar nobody can see.
    expect(css).not.toMatch(/\.boot__progress\s*\{[^}]*opacity:\s*0/);
  });
});
