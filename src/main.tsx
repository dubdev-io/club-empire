import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startGame } from './game/runtime.ts';
import { App } from './ui/App.tsx';
import './styles/global.css';

const gameRoot = document.getElementById('game-root');
const uiRoot = document.getElementById('ui-root');

if (!gameRoot || !uiRoot) {
  throw new Error('index.html is missing #game-root or #ui-root');
}

// The React tree mounts first so the UI paints while the WebGL context and
// textures are still being created. On a mid-range phone that is the
// difference between a blank screen and a visible loading state.
createRoot(uiRoot).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The Pixi runtime deliberately lives outside React. React re-renders are not
// a safe place to own a WebGL context, and StrictMode's double-invoked effects
// would create two of them in development.
void startGame(gameRoot).catch((error: unknown) => {
  console.error('Club Empire failed to start', error);
});
