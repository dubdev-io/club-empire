import { describe, expect, it } from 'vitest';
import { CURRENT_SAVE_VERSION, SAVE_STORAGE_KEY, type SaveV1 } from './schema.ts';
import { clearSave, createSave, loadSave, writeSave, type SaveStorage } from './storage.ts';

/** In-memory `localStorage` stand-in, so the codec can be tested in node. */
function memoryStorage(seed: Record<string, string> = {}): SaveStorage & { raw: Record<string, string> } {
  const raw: Record<string, string> = { ...seed };
  return {
    raw,
    getItem: (key) => raw[key] ?? null,
    setItem: (key, value) => {
      raw[key] = value;
    },
    removeItem: (key) => {
      delete raw[key];
    },
  };
}

function throwingStorage(): SaveStorage {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };
}

describe('save round-trip', () => {
  it('writes and reads back the same economy state', () => {
    const storage = memoryStorage();
    const now = 1_700_000_000_000;

    const written = createSave({ money: 1234.56, barLevel: 7 }, 4321, now);
    expect(writeSave(storage, written)).toBe(true);

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.migratedFrom).toBeNull();
    expect(result.save.version).toBe(CURRENT_SAVE_VERSION);
    expect(result.save.lastSeenAt).toBe(now);
    expect(result.save.elapsedTicks).toBe(4321);
    expect(result.save.economy).toEqual({ money: 1234.56, barLevel: 7 });
  });

  it('reports an absent save as empty rather than failing', () => {
    expect(loadSave(memoryStorage()).status).toBe('empty');
    expect(loadSave(null).status).toBe('empty');
  });
});

describe('save migration', () => {
  it('migrates a v1 save forward instead of crashing', () => {
    const v1: SaveV1 = { version: 1, lastSeenAt: 1_699_000_000_000, money: 999 };
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(v1) });

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.migratedFrom).toBe(1);
    expect(result.save.version).toBe(CURRENT_SAVE_VERSION);
    // Money survives the version bump; new fields get defaults.
    expect(result.save.economy.money).toBe(999);
    expect(result.save.economy.barLevel).toBe(1);
    expect(result.save.lastSeenAt).toBe(1_699_000_000_000);
    expect(result.save.elapsedTicks).toBe(0);
  });

  it('a migrated save can be re-saved and re-read at the current version', () => {
    const v1: SaveV1 = { version: 1, lastSeenAt: 1_699_000_000_000, money: 50 };
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(v1) });

    const first = loadSave(storage);
    expect(first.status).toBe('loaded');
    if (first.status !== 'loaded') return;

    writeSave(storage, createSave(first.save.economy, 10, 1_699_000_100_000));

    const second = loadSave(storage);
    expect(second.status).toBe('loaded');
    if (second.status !== 'loaded') return;
    expect(second.migratedFrom).toBeNull();
    expect(second.save.economy.money).toBe(50);
  });
});

describe('save robustness', () => {
  it('discards corrupt JSON and clears it', () => {
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: '{not json' });
    const result = loadSave(storage);
    expect(result).toEqual({ status: 'discarded', reason: 'corrupt-json' });
    expect(storage.raw[SAVE_STORAGE_KEY]).toBeUndefined();
  });

  it.each([
    ['missing version', { lastSeenAt: 1, money: 1 }],
    ['missing lastSeenAt', { version: 2, elapsedTicks: 0, economy: { money: 1, barLevel: 1 } }],
    ['wrong money type', { version: 2, lastSeenAt: 1, elapsedTicks: 0, economy: { money: 'lots', barLevel: 1 } }],
    ['NaN money', { version: 2, lastSeenAt: 1, elapsedTicks: 0, economy: { money: Number.NaN, barLevel: 1 } }],
    ['missing economy', { version: 2, lastSeenAt: 1, elapsedTicks: 0 }],
    ['array', [1, 2, 3]],
    ['null', null],
    ['unknown version', { version: 0, lastSeenAt: 1 }],
  ])('discards an invalid save (%s) without throwing', (_label, payload) => {
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(payload) });
    const result = loadSave(storage);
    expect(result.status).toBe('discarded');
    if (result.status !== 'discarded') return;
    expect(result.reason).toBe('invalid');
  });

  it('refuses a save from a newer version but leaves it on disk', () => {
    const future = JSON.stringify({ version: CURRENT_SAVE_VERSION + 1, lastSeenAt: 1, anything: true });
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: future });

    const result = loadSave(storage);
    expect(result).toEqual({ status: 'discarded', reason: 'future-version' });
    // The player may just have a stale bundle cached — do not destroy
    // progress they still have on a newer build.
    expect(storage.raw[SAVE_STORAGE_KEY]).toBe(future);
  });

  it('survives storage that throws on every operation', () => {
    const storage = throwingStorage();
    expect(loadSave(storage)).toEqual({ status: 'discarded', reason: 'storage-unreadable' });
    expect(writeSave(storage, createSave({ money: 1, barLevel: 1 }, 0))).toBe(false);
    expect(() => clearSave(storage)).not.toThrow();
  });
});
