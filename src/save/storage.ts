import {
  CURRENT_SAVE_VERSION,
  SAVE_STORAGE_KEY,
  migrateSave,
  type CurrentSave,
} from './schema.ts';

/**
 * The subset of `Storage` the save layer needs. Injecting it keeps the codec
 * testable in a `node` environment and keeps us honest about Safari private
 * mode, where `localStorage` exists but throws on write.
 */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadResult =
  | { status: 'loaded'; save: CurrentSave; migratedFrom: number | null }
  | { status: 'empty' }
  | { status: 'discarded'; reason: string };

/**
 * Returns `localStorage` if it is actually usable, otherwise `null`.
 * Accessing the property alone can throw when cookies are blocked, so the
 * probe is a real round-trip inside a try/catch.
 */
export function getBrowserStorage(): SaveStorage | null {
  try {
    const probeKey = `${SAVE_STORAGE_KEY}:probe`;
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Read and migrate the save. Never throws, never returns a partially valid
 * object — the game either gets a current-version save or starts fresh.
 */
export function loadSave(storage: SaveStorage | null): LoadResult {
  if (!storage) return { status: 'empty' };

  let text: string | null;
  try {
    text = storage.getItem(SAVE_STORAGE_KEY);
  } catch {
    return { status: 'discarded', reason: 'storage-unreadable' };
  }
  if (text === null || text === '') return { status: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    clearSave(storage);
    return { status: 'discarded', reason: 'corrupt-json' };
  }

  const outcome = migrateSave(parsed);
  if (outcome.status === 'discarded') {
    // A future-version save is left in place: the player may simply have an
    // old bundle cached, and deleting it would destroy real progress they
    // still have. Anything else is unrecoverable, so clear it.
    if (outcome.reason !== 'future-version') clearSave(storage);
    return { status: 'discarded', reason: outcome.reason };
  }

  return {
    status: 'loaded',
    save: outcome.save,
    migratedFrom: outcome.migratedFrom,
  };
}

/** Write the save. Returns false instead of throwing when storage refuses. */
export function writeSave(storage: SaveStorage | null, save: CurrentSave): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(save));
    return true;
  } catch {
    // Quota exceeded or private mode. Dropping a save is survivable; throwing
    // out of a `visibilitychange` handler is not.
    return false;
  }
}

export function clearSave(storage: SaveStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(SAVE_STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
}

/**
 * The live club, as `createSave` needs to read it.
 *
 * Structurally identical to `SaveV3['club']` but with a readonly station list,
 * so `ClubState`'s immutable snapshot can be passed straight in. Spelling it
 * out rather than widening `SaveV3` keeps the persisted type exactly as strict
 * as it is on disk.
 */
export interface SavableClub extends Omit<CurrentSave['club'], 'stations'> {
  readonly stations: readonly {
    readonly key: string;
    readonly unlocked: boolean;
    readonly level: number;
    readonly lanes: number;
  }[];
}

export function createSave(
  club: SavableClub,
  settings: CurrentSave['settings'],
  elapsedTicks: number,
  now: number = Date.now(),
): CurrentSave {
  return {
    version: CURRENT_SAVE_VERSION,
    lastSeenAt: now,
    elapsedTicks,
    // Copied field by field rather than spread, so adding a field to the live
    // `ClubState` cannot silently start persisting it without a version bump.
    club: {
      cash: club.cash,
      totalEarned: club.totalEarned,
      doorLevel: club.doorLevel,
      stations: club.stations.map((st) => ({
        key: st.key,
        unlocked: st.unlocked,
        level: st.level,
        lanes: st.lanes,
      })),
      lastCallMeter: club.lastCallMeter,
      lastCallFiredCount: club.lastCallFiredCount,
      bubblesCollected: club.bubblesCollected,
      elapsedSeconds: club.elapsedSeconds,
      purchaseCount: club.purchaseCount,
      completeSeen: club.completeSeen,
      hintBubblePending: club.hintBubblePending,
      hintStationPending: club.hintStationPending,
    },
    settings: { ...settings },
  };
}
