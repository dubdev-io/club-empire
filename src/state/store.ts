import { create } from 'zustand';
import type { StationKey } from '../config/economy.ts';
import type { PendingStar, Purchase } from '../sim/clubState.ts';
import type { OfflineEarnings } from '../sim/offlineEarnings.ts';
import { NO_OFFLINE_EARNINGS } from '../sim/offlineEarnings.ts';
import type { SavedSettings } from '../save/schema.ts';
import { DEFAULT_SETTINGS } from '../save/schema.ts';

/**
 * The UI's read model.
 *
 * This is a *projection* of the simulation, not the simulation. The club lives
 * in a plain mutable object inside the runtime (`src/game/runtime.ts`) and is
 * advanced allocation-free; the runtime pushes snapshots in here so React
 * re-renders at a rate we choose rather than at the economy tick rate.
 *
 * The projection is split in two on purpose:
 *
 *  - **`fast`** — the numbers that move continuously: cash, income, the Last
 *    Call meter, queue pressure. Published at 10 Hz. Primitives only, so a
 *    component that subscribes to one of them re-renders only when that number
 *    changes.
 *  - **`structure`** — levels, lanes, prices, what is unlocked. Published on
 *    **purchase only**, a few hundred times in a whole run.
 *
 * Without the split, every sheet row would re-render ten times a second
 * because the cash counter moved. With it, the sheets are static between
 * purchases and the counter is three text nodes.
 */

// ---------------------------------------------------------------------------
// Fast slice — 10 Hz
// ---------------------------------------------------------------------------

export interface FastSnapshot {
  cash: number;
  /** What the counter is actually climbing at, Last Call included. */
  incomePerSecond: number;
  /** Unboosted. What the offline card will be priced from if the player leaves now. */
  baseIncomePerSecond: number;
  /** 1, or 3 while Last Call is firing. */
  multiplier: number;
  /** 0..1. */
  lastCallMeter: number;
  lastCallRemaining: number;
  /** Guests per second being turned away. Non-zero means a queue at the door. */
  turnedAwayPerSecond: number;
  /** Cash as a fraction of the next purchase's price, 0..1. Drives the HUD's share of §4.4b. */
  nextPurchaseProgress: number;
  /** True when the player can afford nothing — the cue to promote the Last Call meter. */
  nothingAffordable: boolean;
  elapsedSeconds: number;
}

// ---------------------------------------------------------------------------
// Structure slice — on purchase
// ---------------------------------------------------------------------------

export interface StationView {
  readonly key: StationKey;
  readonly name: string;
  readonly unlocked: boolean;
  readonly level: number;
  readonly lanes: number;
  readonly stars: number;
  readonly maxed: boolean;
  /** Null when there is nothing left to buy on that axis. */
  readonly upgradeCost: number | null;
  readonly laneCost: number | null;
  readonly unlockCost: number | null;
  readonly pricePerGuest: number;
  readonly servedPerSecond: number;
  readonly capacityPerSecond: number;
  readonly saturated: boolean;
  readonly idleLanes: number;
  /** Levels until the next ★, or null at L30. */
  readonly levelsToNextStar: number | null;
}

export interface StructureSnapshot {
  doorLevel: number;
  doorMaxed: boolean;
  doorCost: number | null;
  arrivalsPerSecond: number;
  capacityPerSecond: number;
  stations: StationView[];
  nextPurchase: Purchase | null;
  nextPurchaseLabel: string;
  complete: boolean;
  totalEarned: number;
  purchaseCount: number;
  bubblesCollected: number;
  lastCallFiredCount: number;
}

// ---------------------------------------------------------------------------
// Presentation state
// ---------------------------------------------------------------------------

/** There is no screen stack. One canvas, and at most one sheet over it. */
export type SheetId = 'none' | 'bars' | 'door' | 'settings';

/**
 * Why the save layer could not give us a club.
 *
 * `corrupt` and `future-version` both surface the same banner — the player
 * does not care which, only that their club could not be read and the game did
 * not silently wipe it.
 */
export type SaveStatus = 'booting' | 'new' | 'loaded' | 'migrated' | 'corrupt';

export interface GameActions {
  upgradeStation: (key: StationKey) => void;
  buyLane: (key: StationKey) => void;
  unlockStation: (key: StationKey) => void;
  upgradeDoor: () => void;
  collectOffline: () => void;
  acknowledgeComplete: () => void;
  resetSave: () => void;
}

const NO_ACTIONS: GameActions = {
  upgradeStation: () => {},
  buyLane: () => {},
  unlockStation: () => {},
  upgradeDoor: () => {},
  collectOffline: () => {},
  acknowledgeComplete: () => {},
  resetSave: () => {},
};

export interface GameStore extends FastSnapshot, StructureSnapshot {
  // --- lifecycle --------------------------------------------------------
  /** True until the runtime has booted the renderer and the first frame is up. */
  booting: boolean;
  bootProgress: number;
  saveStatus: SaveStatus;
  /** Set when WebGL is unavailable. The game shows a text screen, never a black canvas. */
  webglUnavailable: boolean;
  /** Private mode or a full quota: the game runs, but nothing persists. */
  storageUnavailable: boolean;
  /** Dismissed banners stay dismissed for the session. */
  dismissedBanners: Record<string, boolean>;

  // --- overlays ---------------------------------------------------------
  sheet: SheetId;
  star: PendingStar | null;
  offline: OfflineEarnings;
  showOffline: boolean;
  showComplete: boolean;

  // --- settings ---------------------------------------------------------
  settings: SavedSettings;
  /** Resolved `prefers-reduced-motion`, combined with the explicit toggle. */
  reducedMotion: boolean;

  actions: GameActions;

  // --- mutators ---------------------------------------------------------
  publishFast: (snapshot: FastSnapshot) => void;
  publishStructure: (snapshot: StructureSnapshot) => void;
  setBooting: (booting: boolean, progress?: number) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setWebglUnavailable: (unavailable: boolean) => void;
  setStorageUnavailable: (unavailable: boolean) => void;
  dismissBanner: (id: string) => void;
  openSheet: (sheet: SheetId) => void;
  closeSheet: () => void;
  setStar: (star: PendingStar | null) => void;
  setOffline: (offline: OfflineEarnings, show: boolean) => void;
  setShowComplete: (show: boolean) => void;
  setSettings: (settings: SavedSettings) => void;
  setReducedMotion: (reduced: boolean) => void;
  bindActions: (actions: GameActions) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  // fast
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

  // structure
  doorLevel: 1,
  doorMaxed: false,
  doorCost: null,
  arrivalsPerSecond: 0,
  capacityPerSecond: 0,
  stations: [],
  nextPurchase: null,
  nextPurchaseLabel: '',
  complete: false,
  totalEarned: 0,
  purchaseCount: 0,
  bubblesCollected: 0,
  lastCallFiredCount: 0,

  // lifecycle
  booting: true,
  bootProgress: 0,
  saveStatus: 'booting',
  webglUnavailable: false,
  storageUnavailable: false,
  dismissedBanners: {},

  // overlays
  sheet: 'none',
  star: null,
  offline: NO_OFFLINE_EARNINGS,
  showOffline: false,
  showComplete: false,

  // settings
  settings: { ...DEFAULT_SETTINGS },
  reducedMotion: false,

  actions: NO_ACTIONS,

  // `set` copies the fields out, so the runtime can hand the same mutable
  // snapshot object in every time and the 10 Hz path stays allocation-free.
  publishFast: (snapshot) => set(snapshot),
  publishStructure: (snapshot) => set(snapshot),

  setBooting: (booting, progress) =>
    set((s) => ({ booting, bootProgress: progress ?? s.bootProgress })),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setWebglUnavailable: (webglUnavailable) => set({ webglUnavailable }),
  setStorageUnavailable: (storageUnavailable) => set({ storageUnavailable }),
  dismissBanner: (id) =>
    set((s) => ({ dismissedBanners: { ...s.dismissedBanners, [id]: true } })),

  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: 'none' }),
  setStar: (star) => set({ star }),
  setOffline: (offline, showOffline) => set({ offline, showOffline }),
  setShowComplete: (showComplete) => set({ showComplete }),
  setSettings: (settings) => set({ settings }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  bindActions: (actions) => set({ actions }),
}));

/**
 * Is any overlay open?
 *
 * `Escape` and browser-back dismiss the topmost overlay rather than leaving the
 * game, and this is the order they come off in.
 */
export function topOverlay(state: GameStore): 'complete' | 'offline' | 'sheet' | null {
  if (state.showComplete) return 'complete';
  if (state.showOffline) return 'offline';
  if (state.sheet !== 'none') return 'sheet';
  return null;
}
