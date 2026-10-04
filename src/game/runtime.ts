import type { Renderer } from 'pixi.js';
import {
  AVERAGE_SPEND_MULTIPLIER,
  DOOR_MAX,
  MAX_LANES,
  MAX_STATION_LEVEL,
  STAR_LEVELS,
  STATION_DEFS,
  baseDrinkPrice,
  doorUpgradeCost,
  laneCost,
  stationDef,
  stationUpgradeCost,
  totalCapacity,
  type StationKey,
} from '../config/economy.ts';
import { ClubScene, type RenderCounts } from '../render/clubScene.ts';
import { createStage, type Stage } from '../render/stage.ts';
import { createTextures, type GeneratedTextures } from '../render/textures.ts';
import { AUTOSAVE_INTERVAL_MS } from '../sim/constants.ts';
import { FixedStepLoop } from '../sim/fixedStepLoop.ts';
import {
  applyPurchase,
  buyLane,
  collectBubble,
  createClubState,
  creditCash,
  effectiveIncomePerSecond,
  currentMultiplier,
  progressOf,
  restoreClub,
  shouldShowComplete,
  snapshotClub,
  takePendingStar,
  unlockStation,
  upgradeDoor,
  upgradeStation,
  tickClub,
  type ClubState,
} from '../sim/clubState.ts';
import { offlineEarningsSince, NO_OFFLINE_EARNINGS } from '../sim/offlineEarnings.ts';
import { clearSave, createSave, getBrowserStorage, loadSave, writeSave, type SaveStorage } from '../save/storage.ts';
import { DEFAULT_SETTINGS, type SavedSettings } from '../save/schema.ts';
import {
  useGameStore,
  type FastSnapshot,
  type StationView,
  type StructureSnapshot,
} from '../state/store.ts';
import { createAudio, vibrate } from './audio.ts';
import { FrameProbe, type FrameReport } from './frameProbe.ts';
import { STRESS_CROWD, createStressClub } from './stressScene.ts';

/** How often the UI read model is refreshed. 10 Hz is below the eye's ability
 *  to read a changing number and well under the React render budget. */
const UI_PUBLISH_INTERVAL_MS = 100;

/** The ★ overlay auto-dismisses after this. ~800 ms per §9's celebrate token. */
const STAR_DISMISS_MS = 800;

export interface GameRuntime {
  destroy(): void;
  /**
   * Read-only handle for the `?debug=1` overlay.
   *
   * Building it costs one object literal at boot and nothing after that, and
   * nothing in the shipping bundle calls into it — the overlay is the only
   * caller and it lives in a chunk that is never fetched without the flag.
   */
  readonly debug: GameDebugHandle;
}

export interface StartOptions {
  /**
   * `?debug=1&stress=1`. Boots straight into the DUB-6 C1 certification scene
   * and takes the save out of the loop entirely — neither read nor written —
   * so measuring the frame rate cannot cost the player their club.
   */
  readonly stress?: boolean;
}

/** What the debug overlay is allowed to see. Deliberately five narrow holes. */
export interface GameDebugHandle {
  /** The Pixi renderer, for draw-call counting. Null when WebGL was refused. */
  renderer(): Renderer | null;
  /** The canvas, for `dpr` and the backing-store size. Null when WebGL was refused. */
  canvas(): HTMLCanvasElement | null;
  /** Live sprite counts, written into `out` so sampling allocates nothing. */
  counts(out: RenderCounts): void;
  /** Per-system frame timing and the duty cycle, for the DUB-6 C1 breakdown. */
  frames(): FrameReport;
  /**
   * Restart the timing window.
   *
   * The overlay calls this when "Start 60 s measurement" is tapped, so that
   * `busy_pct` is the duty cycle *of that measurement* rather than of however
   * long the page happened to have been open. Without it the two windows
   * drift apart and the number stops being comparable between runs.
   */
  resetFrames(): void;
}

/**
 * Boots the game and owns the only `requestAnimationFrame` loop in the app.
 *
 * The important structural property: `rAF` does nothing but (a) hand the frame
 * delta to the fixed-step loop and (b) render. All economy mutation happens
 * inside `FixedStepLoop.advance`, in whole 100 ms steps. Nothing downstream of
 * this function can make income depend on frame rate.
 *
 * The second property, which matters just as much for how the game feels:
 * **player input is applied synchronously in the pointer handler**, never
 * queued for the next tick. A tap changes the club and republishes the HUD in
 * the same event, so the visible response is bounded by the next paint rather
 * than by the 100 ms tick — which is what makes criterion 2's "< 100 ms"
 * achievable rather than marginal.
 */
export async function startGame(
  parent: HTMLElement,
  options: StartOptions = {},
): Promise<GameRuntime> {
  const store = useGameStore;
  const probe = new FrameProbe();

  /**
   * The stress scene is a measurement fixture, not a session.
   *
   * Handing `null` storage to the save layer is the whole mechanism: `loadSave`
   * reports `empty`, `writeSave` and `clearSave` are no-ops, and the autosave
   * timer and the lifecycle handlers below keep their existing shape without
   * needing a second code path. Opening `?debug=1&stress=1` therefore cannot
   * overwrite a real club — which matters, because the owner is going to open
   * this URL on the phone they also play on.
   */
  const persistent = options.stress !== true;

  // --- settings and state restore ----------------------------------------
  const storage: SaveStorage | null = persistent ? getBrowserStorage() : null;
  store.getState().setStorageUnavailable(persistent && storage === null);

  let settings: SavedSettings = { ...DEFAULT_SETTINGS };
  let club: ClubState;
  let restoredTicks = 0;
  let offlineLastSeenAt: number | null = null;

  const result = loadSave(storage);
  if (!persistent) {
    club = createStressClub();
    store.getState().setSaveStatus('new');
  } else if (result.status === 'loaded') {
    club = restoreClub(result.save.club);
    settings = result.save.settings;
    restoredTicks = result.save.elapsedTicks;
    offlineLastSeenAt = result.save.lastSeenAt;
    store.getState().setSaveStatus(result.migratedFrom === null ? 'loaded' : 'migrated');
  } else {
    club = createClubState();
    // 'empty' is a first run and says nothing to the player; 'discarded' means
    // we had a save and could not read it, which they have to be told about.
    store.getState().setSaveStatus(result.status === 'empty' ? 'new' : 'corrupt');
  }
  store.getState().setSettings(settings);

  const loop = new FixedStepLoop(() => {
    tickClub(club);
    scene?.tick();
  });
  loop.restoreTicks(restoredTicks);

  // --- audio --------------------------------------------------------------
  // Remembering the preference only. `setEnabled` no longer opens a context, so
  // boot stays silent until the first tap reaches `unlock()` — which is the
  // brief's "audio loads after first interaction" and the autoplay policy both.
  const audio = createAudio();
  audio.setEnabled(settings.audio);

  // --- render -------------------------------------------------------------
  let stage: Stage | null = null;
  let textures: GeneratedTextures | null = null;
  let scene: ClubScene | null = null;

  try {
    store.getState().setBooting(true, 0.25);
    stage = await createStage(parent);
  } catch (error) {
    // No WebGL, or a context the driver refused. A text screen naming the
    // problem, never a silent black canvas.
    console.error('Club Empire could not create a WebGL context', error);
    store.getState().setWebglUnavailable(true);
    store.getState().setBooting(false, 1);
    // The overlay still mounts on a WebGL failure — "no canvas" is itself a
    // result worth reading off a phone — so it gets a handle that reports
    // nothing rather than no handle at all.
    return {
      destroy: () => {},
      debug: {
        renderer: () => null,
        canvas: () => null,
        counts: (out) => {
          out.guests = 0;
          out.bartenders = 0;
          out.queues = 0;
          out.particles = 0;
        },
        frames: () => probe.report(),
        resetFrames: () => probe.reset(),
      },
    };
  }

  store.getState().setBooting(true, 0.6);
  textures = createTextures(stage.app.renderer);
  scene = new ClubScene(textures, club);
  scene.onBeat = (index) => audio.beat(index);
  if (!persistent) scene.pinCrowd(STRESS_CROWD);
  stage.world.addChild(scene.view);

  // --- publishing ---------------------------------------------------------
  // One reusable object per slice. `publish*` copies the fields into Zustand,
  // so handing the same object over twice is safe and the 10 Hz path stays
  // allocation-free.
  const fast: FastSnapshot = {
    cash: 0,
    incomePerSecond: 0,
    baseIncomePerSecond: 0,
    multiplier: 1,
    lastCallMeter: 0,
    lastCallRemaining: 0,
    turnedAwayPerSecond: 0,
    nextPurchaseProgress: 0,
    nothingAffordable: false,
    elapsedSeconds: 0,
  };
  let lastPublishAt = 0;

  function publishFast(force: boolean): void {
    const now = performance.now();
    if (!force && now - lastPublishAt < UI_PUBLISH_INTERVAL_MS) return;
    lastPublishAt = now;

    const next = club.derived.nextPurchase;
    fast.cash = club.cash;
    fast.incomePerSecond = effectiveIncomePerSecond(club);
    fast.baseIncomePerSecond = club.derived.baseIncomePerSecond;
    fast.multiplier = currentMultiplier(club);
    fast.lastCallMeter = club.lastCallMeter;
    fast.lastCallRemaining = club.lastCallRemaining;
    fast.turnedAwayPerSecond = club.derived.flow.turnedAwayPerSecond;
    fast.nextPurchaseProgress = next === null ? 1 : Math.min(1, club.cash / next.cost);
    fast.nothingAffordable = next !== null && club.cash < next.cost;
    fast.elapsedSeconds = club.elapsedSeconds;
    store.getState().publishFast(fast);
  }

  /**
   * Publish the structural slice. Allocates — purchase-time only.
   *
   * This is the one place `StationView` rows are built, so the sheets and the
   * bottom-bar badges all read the same prices the economy charged.
   */
  function publishStructure(): void {
    const flow = club.derived.flow;

    const stations: StationView[] = club.stations.map((st) => {
      const def = stationDef(st.key);
      const stationFlow = flow.stations.find((f) => f.key === st.key);
      const stars = STAR_LEVELS.filter((l) => l <= st.level).length;
      const nextStar = STAR_LEVELS.find((l) => l > st.level);

      return {
        key: st.key,
        name: def.name,
        unlocked: st.unlocked,
        level: st.level,
        lanes: st.lanes,
        stars,
        maxed: st.unlocked && st.level >= MAX_STATION_LEVEL,
        upgradeCost:
          st.unlocked && st.level < MAX_STATION_LEVEL ? stationUpgradeCost(def, st.level) : null,
        laneCost: st.unlocked && st.lanes < MAX_LANES ? laneCost(def, st.lanes + 1) : null,
        unlockCost: st.unlocked ? null : def.unlockCost,
        // A locked station still shows what it would pay, because that is the
        // reason to unlock it.
        pricePerGuest: stationFlow?.pricePerGuest ?? previewPrice(st.key, st.level),
        servedPerSecond: stationFlow?.servedPerSecond ?? 0,
        capacityPerSecond: stationFlow?.capacityPerSecond ?? 0,
        saturated: stationFlow?.saturated ?? false,
        idleLanes: stationFlow?.idleLanes ?? 0,
        levelsToNextStar: nextStar === undefined ? null : nextStar - st.level,
      };
    });

    const structure: StructureSnapshot = {
      doorLevel: club.doorLevel,
      doorMaxed: club.doorLevel >= DOOR_MAX,
      doorCost: club.doorLevel < DOOR_MAX ? doorUpgradeCost(club.doorLevel) : null,
      arrivalsPerSecond: flow.arrivalsPerSecond,
      capacityPerSecond: totalCapacity(progressOf(club)),
      stations,
      nextPurchase: club.derived.nextPurchase,
      nextPurchaseLabel: describePurchase(club),
      complete: club.derived.complete,
      totalEarned: club.totalEarned,
      purchaseCount: club.purchaseCount,
      bubblesCollected: club.bubblesCollected,
      lastCallFiredCount: club.lastCallFiredCount,
    };
    store.getState().publishStructure(structure);
  }

  // --- player actions -----------------------------------------------------
  let starTimer = 0;

  /**
   * Everything that has to happen after a successful purchase, in one place.
   *
   * Ordering matters: the scene and the HUD are updated *before* the sound
   * plays, so the visible change is never waiting on the audio graph.
   */
  function afterPurchase(): void {
    scene?.syncProgress();
    publishStructure();
    publishFast(true);

    vibrate(settings.haptics);
    audio.upgrade();

    const star = takePendingStar(club);
    if (star !== null) {
      store.getState().setStar(star);
      audio.star(star.stars);
      window.clearTimeout(starTimer);
      // Auto-dismiss. Nothing is claimed in the overlay, so there is nothing
      // the player can miss by being slow — §9 forbids timeouts that cost
      // anything, and this one costs nothing.
      starTimer = window.setTimeout(() => store.getState().setStar(null), STAR_DISMISS_MS);
    }

    if (shouldShowComplete(club)) {
      // The last purchase in the game is Booth lane 3, bought from the BARS
      // sheet, so this fires with a sheet open every time on the real path.
      // The card is the payoff image and it should land over the finished
      // room, not over a list of rows.
      store.getState().closeSheet();
      store.getState().setShowComplete(true);
    }
  }

  function buy(run: () => string): void {
    // A failed purchase still gets haptic feedback — pressing an unaffordable
    // button must not feel like a dead button (criterion 2).
    if (run() === 'bought') {
      afterPurchase();
    } else {
      vibrate(settings.haptics, 5);
      publishFast(true);
    }
  }

  store.getState().bindActions({
    upgradeStation: (key) => buy(() => upgradeStation(club, key)),
    buyLane: (key) => buy(() => buyLane(club, key)),
    unlockStation: (key) => buy(() => unlockStation(club, key)),
    upgradeDoor: () => buy(() => upgradeDoor(club)),

    collectOffline: () => {
      const { offline } = store.getState();
      creditCash(club, offline.amount);
      store.getState().setOffline(NO_OFFLINE_EARNINGS, false);
      audio.coin(false);
      publishFast(true);
      save();
    },

    acknowledgeComplete: () => {
      club.completeSeen = true;
      store.getState().setShowComplete(false);
      // The club keeps earning and the player is never locked out — scope item
      // 13. Acknowledging is the only thing this button does.
      publishStructure();
      save();
    },

    resetSave: () => {
      clearSave(storage);
      club = createClubState();
      loop.restoreTicks(0);
      store.getState().setSaveStatus('new');
      store.getState().setStar(null);
      store.getState().setShowComplete(false);
      store.getState().setOffline(NO_OFFLINE_EARNINGS, false);
      store.getState().closeSheet();
      // The scene holds a reference to the old state object, so it has to be
      // rebuilt rather than resynced.
      rebuildScene();
      publishStructure();
      publishFast(true);
      save();
    },
  });

  function rebuildScene(): void {
    if (stage === null || textures === null) return;
    scene?.destroy();
    scene = new ClubScene(textures, club);
    scene.onBeat = (index) => audio.beat(index);
    scene.setReducedMotion(store.getState().reducedMotion);
    if (!persistent) scene.pinCrowd(STRESS_CROWD);
    stage.world.addChild(scene.view);
  }

  // --- canvas input -------------------------------------------------------
  // One reusable point. Pointer events are frequent and this is the latency
  // path.
  const point = { x: 0, y: 0 };

  const onPointerDown = (event: PointerEvent): void => {
    if (stage === null || scene === null) return;

    // Creating the audio context has to happen inside a user gesture, so the
    // first tap in the session is what turns sound on. Also exactly what the
    // brief asks for: audio loads after first interaction.
    audio.unlock();

    // An overlay is open: the canvas is behind a scrim and must not take taps.
    // Without this, a tap on the offline card's backdrop would also collect a
    // bubble underneath it.
    const state = store.getState();
    if (state.sheet !== 'none' || state.showOffline || state.showComplete) return;

    stage.toDesign(event.clientX, event.clientY, point);
    const hit = scene.pick(point.x, point.y);
    if (hit === null) return;

    if (hit.kind === 'bubble') {
      const collected = collectBubble(club, hit.index);
      if (!collected.collected) return;

      vibrate(settings.haptics);
      audio.coin(collected.vip);
      if (collected.firedLastCall) {
        audio.lastCall(true);
        // Last Call changes how fast the room moves, which is a structural
        // change to the scene rather than a number.
        scene.syncProgress();
      }
      publishFast(true);
      return;
    }

    if (hit.kind === 'station') {
      // Tapping a bar on the floor buys a level. This is the hook — roughly
      // fifteen of these in the first minute — so it is one tap on the thing
      // itself, not a tap to open a sheet and then a tap to buy.
      buy(() => upgradeStation(club, hit.station));
      return;
    }

    // A locked station opens the sheet rather than buying silently: an unlock
    // is 900 or 18,000 and should not be a mis-tap.
    store.getState().openSheet('bars');
  };

  stage.app.canvas.addEventListener('pointerdown', onPointerDown);

  // --- settings changes ---------------------------------------------------
  const unsubscribeSettings = store.subscribe((state, previous) => {
    if (state.settings !== previous.settings) {
      settings = state.settings;
      audio.setEnabled(settings.audio);
      // Settings only change from a tap on the sheet, so this subscriber runs
      // inside the gesture — the one place other than the canvas that is
      // allowed to open the context. Without it, turning sound on in a session
      // that has never had a context would set the flag and stay silent.
      if (settings.audio) audio.unlock();
      save();
    }
    if (state.reducedMotion !== previous.reducedMotion) {
      scene?.setReducedMotion(state.reducedMotion);
    }
  });
  scene.setReducedMotion(store.getState().reducedMotion);

  // --- save ---------------------------------------------------------------
  const save = (): void => {
    writeSave(storage, createSave(snapshotClub(club), settings, loop.ticks));
  };

  const autosaveTimer = window.setInterval(save, AUTOSAVE_INTERVAL_MS);

  // --- the frame loop -----------------------------------------------------
  // Declared before the lifecycle handlers because they start and stop it.
  let rafHandle = 0;
  let lastFrameAt = performance.now();
  let running = true;
  let lastCallWasActive = club.lastCallRemaining > 0;

  const frame = (now: number): void => {
    if (!running) return;
    rafHandle = requestAnimationFrame(frame);

    const delta = now - lastFrameAt;
    lastFrameAt = now;

    probe.beginFrame(now);

    loop.advance(delta);
    probe.mark('sim');

    if (scene !== null) scene.render(loop.alpha, delta);
    probe.mark('scene');

    publishFast(false);
    probe.mark('publish');

    stage?.app.render();
    probe.mark('gpu');

    probe.endFrame();

    // Last Call starting or ending is the one thing a tick can change that the
    // scene has to be told about, because it changes how fast the room moves
    // rather than just what a number says.
    const firing = club.lastCallRemaining > 0;
    if (firing !== lastCallWasActive) {
      lastCallWasActive = firing;
      if (!firing) audio.lastCall(false);
      scene?.syncProgress();
    }
  };

  // `visibilitychange` is the only reliable "app is going away" signal on
  // mobile: iOS does not fire `beforeunload` when the app is swiped away or
  // the tab is evicted. `pagehide` covers the remaining desktop cases.
  let hiddenAt = 0;

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      running = false;
      cancelAnimationFrame(rafHandle);
      audio.setEnabled(false);
      save();
      return;
    }

    // Back in the foreground. The simulation was paused, so the time away is
    // credited under the §5 offline rule rather than replayed as ticks — which
    // is both correct and the only option that does not block the main thread
    // for an hour of catch-up.
    if (hiddenAt > 0) {
      applyTimeAway(hiddenAt);
      hiddenAt = 0;
    }
    audio.setEnabled(settings.audio);
    if (!running) {
      running = true;
      lastFrameAt = performance.now();
      rafHandle = requestAnimationFrame(frame);
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', save);

  /**
   * Credit time away and decide whether it is worth a card.
   *
   * Under the 30 s threshold the cash is still paid, just silently — a tab
   * switch is not a night away and does not deserve a modal, but it should not
   * cost the player anything either.
   */
  function applyTimeAway(since: number): void {
    const earnings = offlineEarningsSince(club.derived.baseIncomePerSecond, since);
    if (earnings.show) {
      store.getState().setOffline(earnings, true);
      return;
    }
    creditCash(club, earnings.amount);
    publishFast(true);
  }

  // --- offline return on boot --------------------------------------------
  if (offlineLastSeenAt !== null) {
    applyTimeAway(offlineLastSeenAt);
  }

  // --- the payoff screen survives a reload --------------------------------
  // `completeSeen` is only set when the player taps [KEEP PLAYING], and autosave
  // persists the completed club long before that. So the same predicate the
  // purchase path uses has to run on the restore path too, or finishing the club
  // and reloading before tapping loses the payoff moment for good.
  if (shouldShowComplete(club)) {
    store.getState().setShowComplete(true);
  }

  publishStructure();
  publishFast(true);

  store.getState().setBooting(false, 1);
  rafHandle = requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    installDevHooks({
      club,
      loop,
      probe,
      afterPurchase,
      publishStructure,
      publishFast,
      getScene: () => scene,
    });
  }

  return {
    debug: {
      renderer: () => stage?.app.renderer ?? null,
      canvas: () => stage?.app.canvas ?? null,
      counts: (out) => {
        if (scene === null) {
          out.guests = 0;
          out.bartenders = 0;
          out.queues = 0;
          out.particles = 0;
          return;
        }
        scene.countRendered(out);
      },
      frames: () => probe.report(),
      resetFrames: () => probe.reset(),
    },

    destroy: () => {
      running = false;
      cancelAnimationFrame(rafHandle);
      window.clearInterval(autosaveTimer);
      window.clearTimeout(starTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', save);
      stage?.app.canvas.removeEventListener('pointerdown', onPointerDown);
      unsubscribeSettings();
      save();

      audio.destroy();
      scene?.destroy();
      scene = null;
      textures?.destroy();
      textures = null;
      stage?.destroy();
      stage = null;
    },
  };
}

/**
 * What a station would charge per guest if it were open.
 *
 * Preview only — a locked station has no entry in `ClubFlow` because it serves
 * nobody, but the sheet still has to say what unlocking it would buy. Goes
 * through `baseDrinkPrice` rather than re-deriving the curve, so a locked
 * station's quoted price cannot disagree with what it charges once open.
 */
function previewPrice(key: StationKey, level: number): number {
  return baseDrinkPrice(stationDef(key), level) * AVERAGE_SPEND_MULTIPLIER;
}

/** A human label for the next purchase, for the HUD and dev output. */
function describePurchase(club: ClubState): string {
  const next = club.derived.nextPurchase;
  if (next === null) return 'Club complete';
  if (next.kind === 'door') return `Door Lv ${club.doorLevel + 1}`;

  const name = STATION_DEFS.find((s) => s.key === next.station)?.name ?? 'Bar';
  if (next.kind === 'unlock') return `Unlock ${name}`;
  if (next.kind === 'lane') return `${name} lane ${next.lane}`;
  return `${name} Lv ${(club.stations.find((s) => s.key === next.station)?.level ?? 1) + 1}`;
}

/**
 * Dev-only console hooks.
 *
 * `window.__club.autoBuy()` is the in-browser half of acceptance criterion 1 —
 * it drives the *shipping* state machine rather than a model of it, so a
 * divergence between the two shows up here rather than at review.
 * `window.__club.frames()` is the per-system frame-time readout for criterion
 * 8. Both are behind `import.meta.env.DEV`, so neither reaches the production
 * bundle.
 */
function installDevHooks(deps: {
  club: ClubState;
  loop: FixedStepLoop;
  probe: FrameProbe;
  afterPurchase: () => void;
  publishStructure: () => void;
  publishFast: (force: boolean) => void;
  getScene: () => ClubScene | null;
}): void {
  const { club, probe, afterPurchase, publishFast, getScene } = deps;
  let autoBuyTimer = 0;

  (window as unknown as { __club?: unknown }).__club = {
    state: () => club,
    frames: () => probe.report(),
    resetFrames: () => probe.reset(),

    /** Buy the cheapest affordable purchase as soon as it is affordable. */
    autoBuy: (on = true) => {
      window.clearInterval(autoBuyTimer);
      if (!on) return 'auto-buy off';
      autoBuyTimer = window.setInterval(() => {
        const next = club.derived.nextPurchase;
        if (next === null) return;
        if (club.cash < next.cost) return;
        if (applyPurchase(club, next) === 'bought') afterPurchase();
      }, 100);
      return 'auto-buy on';
    },

    /** Jump the clock, to reach a late-game state without playing to it. */
    grant: (amount: number) => {
      creditCash(club, amount);
      publishFast(true);
      return club.cash;
    },

    /**
     * Buy everything, for reaching the club-complete state directly.
     *
     * Goes through the real purchase functions rather than writing levels into
     * the state, so the screenshots and the manual checks exercise the same
     * code a player would — including the ★ queue and the complete trigger.
     */
    buyAll: () => {
      creditCash(club, 1e12);
      for (let guard = 0; guard < 500; guard += 1) {
        const next = club.derived.nextPurchase;
        if (next === null) break;
        if (applyPurchase(club, next) !== 'bought') break;
      }
      afterPurchase();
      return { purchases: club.purchaseCount, complete: club.derived.complete };
    },

    /**
     * Time one simulation tick and one scene tick, in isolation.
     *
     * The per-frame `sim` figure from `frames()` is contaminated wherever the
     * renderer is slow: a 180 ms frame on a software rasteriser hands
     * `FixedStepLoop.advance` eighteen ticks' worth of time, so the phase
     * timing reports eighteen ticks and reads as a simulation problem. This
     * runs the tick in a tight loop with nothing else in the frame, which is a
     * number that does not depend on how fast the GPU is — and therefore one
     * that transfers to a real device.
     */
    benchTick: (iterations = 200_000) => {
      const scene = getScene();

      // A warm-up pass, so the figure is of optimised code rather than of the
      // interpreter's first look at it.
      for (let i = 0; i < 10_000; i += 1) tickClub(club);

      const simStart = performance.now();
      for (let i = 0; i < iterations; i += 1) tickClub(club);
      const simMs = performance.now() - simStart;

      let sceneMs = 0;
      if (scene !== null) {
        const sceneIterations = Math.max(1, Math.floor(iterations / 10));
        for (let i = 0; i < 1_000; i += 1) scene.tick();
        const sceneStart = performance.now();
        for (let i = 0; i < sceneIterations; i += 1) scene.tick();
        sceneMs = ((performance.now() - sceneStart) / sceneIterations) * 1_000_000;
      }

      return {
        iterations,
        simNsPerTick: (simMs / iterations) * 1_000_000,
        sceneNsPerTick: sceneMs,
        // What one 60 fps frame's worth of simulation actually costs: at 10 Hz
        // ticks and 60 fps, a frame runs a tick one time in six.
        simMsPerFrameAt60: (simMs / iterations) * (10 / 60),
      };
    },

    /**
     * Pin the scene at the §11 ceiling and measure it.
     *
     * The honest answer to criterion 8 from a container with no GPU: this is
     * CPU-side frame time at the worst case the design allows, per system. It
     * is not an fps figure and must not be reported as one.
     */
    stress: () => {
      creditCash(club, 1e12);
      for (let guard = 0; guard < 500; guard += 1) {
        const next = club.derived.nextPurchase;
        if (next === null) break;
        if (applyPurchase(club, next) !== 'bought') break;
      }
      afterPurchase();
      const counts = getScene()?.stressTest() ?? null;
      probe.reset();
      return counts;
    },

    /**
     * Raise the Door without touching lanes, to force a queue.
     *
     * The fastest way to see the queue-overflow state, and a legitimate thing a
     * player can do to themselves — which is the point of rendering it.
     */
    floodDoor: () => {
      creditCash(club, 1e9);
      for (let i = 0; i < 20; i += 1) upgradeDoor(club);
      afterPurchase();
      return club.derived.flow.turnedAwayPerSecond;
    },
  };
}
