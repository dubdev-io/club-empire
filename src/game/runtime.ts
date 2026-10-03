import { ClubFloor } from '../render/clubFloor.ts';
import { createStage, type Stage } from '../render/stage.ts';
import { createTextures, type GeneratedTextures } from '../render/textures.ts';
import { AUTOSAVE_INTERVAL_MS } from '../sim/constants.ts';
import { FixedStepLoop } from '../sim/fixedStepLoop.ts';
import {
  barUpgradeCost,
  createEconomyState,
  incomeForBarLevel,
  stepEconomy,
  upgradeBar,
  type EconomyState,
} from '../sim/economy.ts';
import { computeOfflineElapsed } from '../sim/offline.ts';
import { createSave, getBrowserStorage, loadSave, writeSave, type SaveStorage } from '../save/storage.ts';
import { useGameStore, type UiSnapshot } from '../state/store.ts';

/** How often the UI read model is refreshed. 10 Hz is below the eye's ability
 *  to read a changing number and well under the React render budget. */
const UI_PUBLISH_INTERVAL_MS = 100;

export interface GameRuntime {
  destroy(): void;
}

/**
 * Boots the game and owns the only `requestAnimationFrame` loop in the app.
 *
 * The important structural property: `rAF` does nothing but (a) hand the frame
 * delta to the fixed-step loop and (b) render. All economy mutation happens
 * inside `FixedStepLoop.advance`, in whole 100 ms steps. Nothing downstream of
 * this function can make income depend on frame rate.
 */
export async function startGame(parent: HTMLElement): Promise<GameRuntime> {
  const store = useGameStore;

  // --- state restore -----------------------------------------------------
  const storage: SaveStorage | null = getBrowserStorage();
  const economy: EconomyState = createEconomyState();

  let stage: Stage | null = null;
  let textures: GeneratedTextures | null = null;
  let floor: ClubFloor | null = null;

  // One tick = one economy step plus one scene-logic step. Both run at the
  // fixed rate; neither sees a frame delta.
  const loop = new FixedStepLoop(() => {
    stepEconomy(economy);
    if (floor) floor.tick();
  });

  const result = loadSave(storage);
  if (result.status === 'loaded') {
    economy.money = result.save.economy.money;
    economy.barLevel = Math.max(1, Math.floor(result.save.economy.barLevel));
    economy.incomePerSecond = incomeForBarLevel(economy.barLevel);
    loop.restoreTicks(result.save.elapsedTicks);

    store.getState().setOffline(computeOfflineElapsed(result.save.lastSeenAt));
    store.getState().setSaveStatus(result.migratedFrom === null ? 'loaded' : 'migrated');
  } else {
    store.getState().setSaveStatus(result.status === 'empty' ? 'new' : 'discarded');
  }

  // --- render ------------------------------------------------------------
  stage = await createStage(parent);
  textures = createTextures(stage.app.renderer);
  floor = new ClubFloor(textures);
  floor.setGuestCount(12 + economy.barLevel * 4);
  stage.world.addChild(floor.view);

  // --- player actions ----------------------------------------------------
  // Applied synchronously on the input event, not deferred to the next tick:
  // a tap must change the screen in the frame it arrives.
  const requestUpgrade = (): void => {
    if (upgradeBar(economy)) {
      floor?.setGuestCount(12 + economy.barLevel * 4);
      publishSnapshot(true);
    }
  };
  store.getState().bindActions({ requestUpgrade });

  // --- UI projection -----------------------------------------------------
  // One reusable object. `publish` copies the fields into Zustand, so handing
  // the same object over twice is safe and the hot path stays allocation-free.
  const snapshot: UiSnapshot = {
    money: 0,
    incomePerSecond: 0,
    barLevel: 0,
    upgradeCost: 0,
    ticks: 0,
  };
  let lastPublishAt = 0;

  function publishSnapshot(force: boolean): void {
    const now = performance.now();
    if (!force && now - lastPublishAt < UI_PUBLISH_INTERVAL_MS) return;
    lastPublishAt = now;

    snapshot.money = economy.money;
    snapshot.incomePerSecond = economy.incomePerSecond;
    snapshot.barLevel = economy.barLevel;
    snapshot.upgradeCost = barUpgradeCost(economy.barLevel);
    snapshot.ticks = loop.ticks;
    store.getState().publish(snapshot);
  }

  publishSnapshot(true);

  // --- save --------------------------------------------------------------
  const save = (): void => {
    writeSave(storage, createSave(economy, loop.ticks));
  };

  const autosaveTimer = window.setInterval(save, AUTOSAVE_INTERVAL_MS);

  // `visibilitychange` is the only reliable "app is going away" signal on
  // mobile: iOS does not fire `beforeunload` when the app is swiped away or
  // the tab is evicted. `pagehide` covers the remaining desktop cases.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') save();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', save);

  // --- the frame loop ----------------------------------------------------
  let rafHandle = 0;
  let lastFrameAt = performance.now();
  let running = true;

  const frame = (now: number): void => {
    if (!running) return;
    rafHandle = requestAnimationFrame(frame);

    const delta = now - lastFrameAt;
    lastFrameAt = now;

    loop.advance(delta);

    if (floor) floor.render(loop.alpha);
    publishSnapshot(false);
    stage?.app.render();
  };
  rafHandle = requestAnimationFrame(frame);

  return {
    destroy: () => {
      running = false;
      cancelAnimationFrame(rafHandle);
      window.clearInterval(autosaveTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', save);
      save();

      floor?.destroy();
      floor = null;
      textures?.destroy();
      textures = null;
      stage?.destroy();
      stage = null;
    },
  };
}
