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

export function createSave(
  economy: CurrentSave['economy'],
  elapsedTicks: number,
  now: number = Date.now(),
): CurrentSave {
  return {
    version: CURRENT_SAVE_VERSION,
    lastSeenAt: now,
    elapsedTicks,
    economy: { money: economy.money, barLevel: economy.barLevel },
  };
}
