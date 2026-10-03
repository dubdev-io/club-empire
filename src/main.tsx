import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startGame } from './game/runtime.ts';
import { useGameStore } from './state/store.ts';
import { App } from './ui/App.tsx';
import './styles/global.css';

const gameRoot = document.getElementById('game-root');
const uiRoot = document.getElementById('ui-root');

if (!gameRoot || !uiRoot) {
  throw new Error('index.html is missing #game-root or #ui-root');
}

// The React tree mounts first so the boot state paints while the WebGL context
// and textures are still being created. On a mid-range phone that is the
// difference between a blank screen and a visible loading state.
createRoot(uiRoot).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Remove the pre-bundle fallback now that React owns the boot state. Both are
// the same dark room with the same silhouette, so there is no flash between
// them.
document.getElementById('boot-fallback')?.remove();

if (import.meta.env.DEV) {
  // The store, for the screenshot driver and for poking at UI states by hand.
  // Dev-only, so it is tree-shaken out of the production bundle — the shipping
  // game exposes no way to set its own cash.
  (window as unknown as { __clubStore?: unknown }).__clubStore = useGameStore;
}

const params = new URLSearchParams(window.location.search);

/**
 * `?noboot=1` loads the page without starting the game. Dev only.
 *
 * The screenshot harness needs to write a save into `localStorage` *before* the
 * game boots. Seeding it on a page that already has a running game does not
 * work: navigating away fires `pagehide`, the running game writes its own save,
 * and the seed is gone before the reload reads it — which is exactly how the
 * offline-return screenshot came out showing the previous shot's club.
 */
const NO_BOOT = import.meta.env.DEV && params.has('noboot');

/**
 * The two measurement flags (DUB-9).
 *
 * Unlike `noboot`, these are *not* behind `import.meta.env.DEV`. That is the
 * point of the ticket: every existing hook is dev-only and so is eliminated
 * from `dist`, which left QA measuring a production bundle in which none of
 * the deterministic routes into a test state exist. These two have to work on
 * the published build.
 *
 * `stress=1` is only honoured alongside `debug=1`, on purpose: the stress
 * scene replaces the club with a fixture and must not be reachable by a stray
 * link. It still never writes the save (see `StartOptions`), but requiring both
 * flags means the only way to see it is to have asked for it.
 */
const debugRequested = params.get('debug') === '1';
const stressRequested = debugRequested && params.get('stress') === '1';

// The Pixi runtime deliberately lives outside React. React re-renders are not
// a safe place to own a WebGL context, and StrictMode's double-invoked effects
// would create two of them in development.
if (!NO_BOOT) {
  void startGame(gameRoot, { stress: stressRequested }).then(
    (runtime) => {
      if (!debugRequested) return;
      // Dynamic, and reached only behind the flag — so Rolldown emits the
      // overlay as its own chunk and the browser never fetches it in normal
      // play. This is the whole of acceptance criterion 1.
      void import('./debug/overlay.ts')
        .then(({ mountDebugOverlay }) => {
          mountDebugOverlay(runtime, { build: __CLUB_BUILD__, stress: stressRequested });
        })
        .catch((error: unknown) => {
          // A dead instrument, not a dead game: the club keeps running and the
          // player (or the owner, on the wrong network) just has no read-out.
          console.error('Club Empire debug overlay failed to load', error);
        });
    },
    (error: unknown) => {
      console.error('Club Empire failed to start', error);
      // Whatever went wrong, the player must not be left looking at a boot
      // spinner forever. `startGame` already handles the WebGL case specifically;
      // this is the catch-all for anything else, and it names the problem rather
      // than showing a dark screen with no explanation.
      useGameStore.getState().setWebglUnavailable(true);
      useGameStore.getState().setBooting(false, 1);
    },
  );
}
