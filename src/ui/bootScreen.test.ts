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

const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('./Overlays.tsx', import.meta.url), 'utf8');

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
  it('is gated on elapsed time, not on bootProgress being non-zero', () => {
    expect(overlays).toMatch(/BOOT_PROGRESS_AFTER_MS = 1000/);
    // `progress > 0` was the old condition, and the runtime sets progress to
    // 0.25 on its first line — so the bar appeared instantly on every load,
    // which is what the component's own doc comment says it must not do.
    expect(overlays).not.toMatch(/\{progress > 0 && \(/);
  });
});
