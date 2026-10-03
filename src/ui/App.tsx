import { useEffect, useRef, useState } from 'react';
import { useGameStore, topOverlay } from '../state/store.ts';
import { BarsSheet } from './BarsSheet.tsx';
import { BottomBar } from './BottomBar.tsx';
import { DoorSheet } from './DoorSheet.tsx';
import { Hud } from './Hud.tsx';
import {
  Banners,
  BootScreen,
  ClubComplete,
  OfflineCard,
  RotatePrompt,
  StarBurst,
  WebglUnavailable,
} from './Overlays.tsx';
import { SettingsSheet } from './SettingsSheet.tsx';
import './ui.css';

/**
 * The whole UI layer.
 *
 * Every panel, counter, sheet and card in this game is DOM and React owns it.
 * Pixi owns the club floor and nothing else. That split is not arbitrary: text
 * in WebGL means a font atlas, no selection, no screen reader and manual
 * layout, and the brief's contrast and touch-target rules are far easier to
 * actually meet in CSS than to re-implement on a canvas.
 *
 * There is no router and no screen stack — one canvas with overlays over it,
 * exactly as §8 draws it.
 */
export function App(): React.JSX.Element {
  const booting = useGameStore((s) => s.booting);
  const webglUnavailable = useGameStore((s) => s.webglUnavailable);
  const sheet = useGameStore((s) => s.sheet);
  const landscape = useLandscape();

  useReducedMotionSync();
  useOverlayDismissal();

  // Checked before everything: there is no point rendering a HUD over a canvas
  // that will never draw.
  if (webglUnavailable) return <WebglUnavailable />;

  // Checked before `booting` so a player who loads in landscape gets the
  // rotate prompt rather than a boot screen laid out for a shape we do not
  // support.
  if (landscape) return <RotatePrompt />;

  if (booting) return <BootScreen />;

  return (
    <>
      <Hud />
      <Banners />
      <div className="club-spacer" />
      <BottomBar />

      {sheet === 'bars' && <BarsSheet />}
      {sheet === 'door' && <DoorSheet />}
      {sheet === 'settings' && <SettingsSheet />}

      <OfflineCard />
      <ClubComplete />
      <StarBurst />
    </>
  );
}

/**
 * Should the rotate prompt be showing?
 *
 * §9 says portrait only, and in landscape show a rotate prompt rather than
 * attempting a landscape layout. But the brief *also* says the game must not be
 * broken at 1440x900, and the designer reviews it at that size — and a desktop
 * monitor is landscape. Showing "turn your phone upright" to someone at a
 * 1440x900 window is the broken outcome, not the compliant one.
 *
 * So the condition is landscape **and short**: a phone on its side is about
 * 390 px tall, where a desktop window has room to letterbox the 390x844 design
 * comfortably. Under 600 px of height there is no way to show the portrait
 * layout, and the prompt is the only honest answer; above it, render the game.
 *
 * Driven off a media query rather than `screen.orientation`, which iOS Safari
 * does not implement, and rather than comparing `innerWidth`/`innerHeight`,
 * which flips briefly during the keyboard animation and would flash the prompt
 * at a player who did nothing.
 */
const ROTATE_QUERY = '(min-aspect-ratio: 1/1) and (max-height: 599px)';

function useLandscape(): boolean {
  const [landscape, setLandscape] = useState(matchRotatePrompt);

  useEffect(() => {
    const query = window.matchMedia(ROTATE_QUERY);
    const update = (): void => setLandscape(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);

  return landscape;
}

function matchRotatePrompt(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(ROTATE_QUERY).matches;
}

/**
 * Keep the resolved reduced-motion flag in sync with both inputs.
 *
 * `auto` follows the OS; `on`/`off` override it. The resolved boolean is what
 * the renderer and every component read, so neither has to know about the
 * three-state setting.
 */
function useReducedMotionSync(): void {
  const preference = useGameStore((s) => s.settings.reducedMotion);
  const setReducedMotion = useGameStore((s) => s.setReducedMotion);

  useEffect(() => {
    if (preference === 'on') {
      setReducedMotion(true);
      return;
    }
    if (preference === 'off') {
      setReducedMotion(false);
      return;
    }

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [preference, setReducedMotion]);
}

/**
 * `Escape` and browser-back dismiss the top overlay rather than leaving the
 * game (§8).
 *
 * The back button is the one worth getting right. On Android, back inside a
 * web game is reflexive, and if it navigates away mid-session the player has
 * lost their place for no reason. So every overlay pushes one history entry
 * when it opens and pops it when it closes, which makes back behave exactly
 * like the close button.
 *
 * `closingRef` is what stops the loop: closing an overlay calls
 * `history.back()`, which fires `popstate`, which would close the next one
 * down if it were not suppressed for that turn.
 */
function useOverlayDismissal(): void {
  const closingRef = useRef(false);
  const pushedRef = useRef(0);

  useEffect(() => {
    const dismissTop = (): boolean => {
      const state = useGameStore.getState();
      const top = topOverlay(state);
      if (top === null) return false;

      // Dismissed in the same order they stack. The offline card and the
      // complete card both *collect* rather than cancel — dismissing them must
      // never be a way to lose the money.
      if (top === 'complete') state.actions.acknowledgeComplete();
      else if (top === 'offline') state.actions.collectOffline();
      else state.closeSheet();
      return true;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const state = useGameStore.getState();
      if (topOverlay(state) === null) return;
      event.preventDefault();
      // Route through history so the pushed entry is consumed; the popstate
      // handler does the actual dismissal.
      if (pushedRef.current > 0) {
        window.history.back();
      } else {
        dismissTop();
      }
    };

    const onPopState = (): void => {
      if (closingRef.current) return;
      if (pushedRef.current > 0) pushedRef.current -= 1;
      closingRef.current = true;
      dismissTop();
      closingRef.current = false;
    };

    // One subscription rather than a render-time effect: the store knows when
    // an overlay opened and React does not need to re-render for us to push a
    // history entry.
    const unsubscribe = useGameStore.subscribe((state, previous) => {
      const was = topOverlay(previous);
      const now = topOverlay(state);
      if (was === null && now !== null) {
        pushedRef.current += 1;
        window.history.pushState({ clubOverlay: pushedRef.current }, '');
      } else if (was !== null && now === null && pushedRef.current > 0 && !closingRef.current) {
        // Closed by a tap rather than by back: consume the entry we pushed so
        // the history depth matches the overlay depth.
        closingRef.current = true;
        pushedRef.current -= 1;
        window.history.back();
        // `popstate` is async; release the guard after it has fired.
        window.setTimeout(() => {
          closingRef.current = false;
        }, 0);
      }
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);
}
