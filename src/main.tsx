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

// The Pixi runtime deliberately lives outside React. React re-renders are not
// a safe place to own a WebGL context, and StrictMode's double-invoked effects
// would create two of them in development.
void startGame(gameRoot).catch((error: unknown) => {
  console.error('Club Empire failed to start', error);
  // Whatever went wrong, the player must not be left looking at a boot
  // spinner forever. `startGame` already handles the WebGL case specifically;
  // this is the catch-all for anything else, and it names the problem rather
  // than showing a dark screen with no explanation.
  useGameStore.getState().setWebglUnavailable(true);
  useGameStore.getState().setBooting(false, 1);
});
