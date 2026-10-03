import { create } from 'zustand';
import type { OfflineElapsed } from '../sim/offline.ts';
import { NO_OFFLINE_ELAPSED } from '../sim/offline.ts';

/**
 * The UI's read model.
 *
 * This is a *projection* of the simulation, not the simulation. The economy
 * lives in a plain mutable object inside the runtime (`src/game/runtime.ts`)
 * and is advanced allocation-free; the runtime pushes a snapshot in here at a
 * bounded rate so React re-renders at a rate we choose rather than at the
 * economy tick rate.
 */
export interface UiSnapshot {
  money: number;
  incomePerSecond: number;
  barLevel: number;
  upgradeCost: number;
  ticks: number;
}

export interface GameStore extends UiSnapshot {
  /** How long the player was away, resolved once at startup. */
  offline: OfflineElapsed;
  /** Null until the runtime has booted; then 'new' or 'loaded'. */
  saveStatus: 'booting' | 'new' | 'loaded' | 'migrated' | 'discarded';
  /** Set by the runtime so UI components can trigger player actions. */
  requestUpgrade: () => void;

  publish: (snapshot: UiSnapshot) => void;
  setOffline: (offline: OfflineElapsed) => void;
  setSaveStatus: (status: GameStore['saveStatus']) => void;
  bindActions: (actions: { requestUpgrade: () => void }) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  money: 0,
  incomePerSecond: 0,
  barLevel: 1,
  upgradeCost: 0,
  ticks: 0,

  offline: NO_OFFLINE_ELAPSED,
  saveStatus: 'booting',
  requestUpgrade: () => {},

  publish: (snapshot) => set(snapshot),
  setOffline: (offline) => set({ offline }),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  bindActions: ({ requestUpgrade }) => set({ requestUpgrade }),
}));
