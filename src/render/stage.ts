import { Application, Container } from 'pixi.js';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../sim/constants.ts';
import { BG_ROOM } from './palette.ts';
import { readSafeAreaInsets } from './safeArea.ts';

export interface Stage {
  readonly app: Application;
  /**
   * Root container. Everything is authored in 390x844 design coordinates and
   * this container's transform maps those onto the real screen.
   */
  readonly world: Container;
  /** Design-space width/height actually visible after letterboxing. */
  readonly layout: StageLayout;
  /**
   * Convert a pointer event's viewport coordinates into design space.
   *
   * Hit-testing has to happen in the same 390x844 coordinates the layout table
   * is written in, or every touch target is off by the letterbox offset. Writes
   * into the caller's object rather than returning a new one, because this runs
   * on every pointer event and tap latency is the one budget in the game with a
   * hard number attached to it.
   */
  toDesign(clientX: number, clientY: number, out: { x: number; y: number }): void;
  destroy(): void;
}

export interface StageLayout {
  /** Uniform design→screen scale factor. */
  scale: number;
  /** Visible design-space rect, inset by the device safe area. */
  width: number;
  height: number;
  /** Safe-area insets converted into design-space units. */
  insetTop: number;
  insetBottom: number;
}

/**
 * Create the full-screen Pixi canvas.
 *
 * Scaling policy: uniform `min(w/390, h/844)` fit, centred. The design is
 * authored for a 390x844 portrait phone; on a taller phone the world is
 * centred with the background bleeding to the edges, on a shorter or wider one
 * it shrinks. No non-uniform stretch, ever — it makes circles into ellipses
 * and is the first thing a player notices.
 */
export async function createStage(parent: HTMLElement): Promise<Stage> {
  const app = new Application();

  await app.init({
    background: BG_ROOM,
    antialias: false,
    // Cap at 2x. A 3x device pixel ratio triples fill-rate cost for a
    // difference no one can see on a phone, and fill rate is exactly what a
    // mid-range Android GPU runs out of first.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    powerPreference: 'high-performance',
    // We drive updates from our own loop so the simulation and the render
    // frame stay separable.
    autoStart: false,
    resizeTo: parent,
  });

  app.canvas.classList.add('club-canvas');
  parent.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  const layout: StageLayout = {
    scale: 1,
    width: DESIGN_WIDTH,
    height: DESIGN_HEIGHT,
    insetTop: 0,
    insetBottom: 0,
  };

  // The canvas rect is cached rather than read per event: `getBoundingClientRect`
  // forces a layout flush, and doing that inside a `pointerdown` handler is
  // paying for a reflow on the one code path that has a 100 ms budget. It is
  // refreshed on resize and orientation change, which are the only things that
  // can move the canvas — the page itself does not scroll.
  let canvasRect = app.canvas.getBoundingClientRect();
  const refreshRect = (): void => {
    canvasRect = app.canvas.getBoundingClientRect();
  };

  const applyLayout = (): void => {
    // `app.screen` is the logical (CSS-pixel) size. `renderer.width/height` is
    // the backing-store size in device pixels and is the wrong number to lay
    // out against — on a 3x phone it is three times too large.
    const screenWidth = app.screen.width;
    const screenHeight = app.screen.height;
    const insets = readSafeAreaInsets();

    const scale = Math.min(screenWidth / DESIGN_WIDTH, screenHeight / DESIGN_HEIGHT);

    world.scale.set(scale);
    world.position.set(
      (screenWidth - DESIGN_WIDTH * scale) / 2,
      (screenHeight - DESIGN_HEIGHT * scale) / 2,
    );

    layout.scale = scale;
    layout.width = screenWidth / scale;
    layout.height = screenHeight / scale;
    layout.insetTop = insets.top / scale;
    layout.insetBottom = insets.bottom / scale;

    // Publish the letterboxed rect so the DOM layer can sit exactly on top of
    // the canvas instead of spanning the window.
    //
    // On a phone the two are the same thing and this changes nothing. On a
    // 1440x900 desktop window the canvas is a 416 px column in the middle and a
    // full-width HUD would float a cash counter a thousand pixels away from the
    // club it belongs to — which is the "broken at 1440x900" the brief rules
    // out, even though desktop is not a designed target.
    const root = document.documentElement.style;
    root.setProperty('--stage-width', `${DESIGN_WIDTH * scale}px`);
    root.setProperty('--stage-height', `${Math.min(screenHeight, DESIGN_HEIGHT * scale)}px`);
  };

  applyLayout();

  // `resizeTo` already handles the renderer; this hook re-derives our own
  // transform. `orientationchange` fires before the viewport has settled on
  // iOS, so re-run on the next frame as well.
  const onResize = (): void => {
    applyLayout();
    refreshRect();
    requestAnimationFrame(() => {
      applyLayout();
      refreshRect();
    });
  };
  app.renderer.on('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  if (import.meta.env.DEV) {
    // Layout inspection hook for manual and headless checks. Dev-only, so it
    // is tree-shaken out of the production bundle.
    (window as unknown as { __clubDebug?: () => unknown }).__clubDebug = () => ({
      screen: { width: app.screen.width, height: app.screen.height },
      resolution: app.renderer.resolution,
      world: { x: world.position.x, y: world.position.y, scale: world.scale.x },
      layout: { ...layout },
    });
  }

  return {
    app,
    world,
    layout,
    toDesign: (clientX, clientY, out) => {
      out.x = (clientX - canvasRect.left - world.position.x) / layout.scale;
      out.y = (clientY - canvasRect.top - world.position.y) / layout.scale;
    },
    destroy: () => {
      app.renderer.off('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      app.destroy(true, { children: true, texture: true });
    },
  };
}
