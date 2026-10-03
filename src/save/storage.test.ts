import { describe, expect, it } from 'vitest';
import {
  CURRENT_SAVE_VERSION,
  DEFAULT_SETTINGS,
  SAVE_STORAGE_KEY,
  freshSavedClub,
  type SaveV1,
  type SaveV2,
} from './schema.ts';
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

/** A club part-way through a run, for round-trip tests. */
function playedClub() {
  const club = freshSavedClub();
  club.cash = 12_345.67;
  club.totalEarned = 98_765.4;
  club.doorLevel = 4;
  club.stations = [
    { key: 'tap', unlocked: true, level: 30, lanes: 3 },
    { key: 'cocktail', unlocked: true, level: 17, lanes: 2 },
    { key: 'booth', unlocked: false, level: 1, lanes: 0 },
  ];
  club.lastCallMeter = 0.44;
  club.lastCallFiredCount = 3;
  club.bubblesCollected = 212;
  club.elapsedSeconds = 517.5;
  club.purchaseCount = 61;
  club.hintBubblePending = false;
  club.hintStationPending = false;
  return club;
}

describe('save round-trip', () => {
  it('writes and reads back the same club', () => {
    const storage = memoryStorage();
    const now = 1_700_000_000_000;
    const club = playedClub();

    const written = createSave(club, DEFAULT_SETTINGS, 4321, now);
    expect(writeSave(storage, written)).toBe(true);

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.migratedFrom).toBeNull();
    expect(result.save.version).toBe(CURRENT_SAVE_VERSION);
    expect(result.save.lastSeenAt).toBe(now);
    expect(result.save.elapsedTicks).toBe(4321);
    expect(result.save.club).toEqual(club);
  });

  it('round-trips settings, so a muted club stays muted', () => {
    const storage = memoryStorage();
    const settings = { audio: false, reducedMotion: 'on' as const, haptics: false };

    writeSave(storage, createSave(freshSavedClub(), settings, 0, 1));
    const result = loadSave(storage);

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;
    expect(result.save.settings).toEqual(settings);
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
    // Cash survives two version bumps; the club itself starts fresh.
    expect(result.save.club.cash).toBe(999);
    expect(result.save.club.doorLevel).toBe(1);
    expect(result.save.lastSeenAt).toBe(1_699_000_000_000);
  });

  it('migrates v2 by keeping cash and discarding the placeholder bar level', () => {
    // v2's `barLevel` was the technical shell's placeholder curve. A "level 7"
    // there is not a level 7 Tap Bar, and carrying it across would hand the
    // player a club they never built.
    const v2: SaveV2 = {
      version: 2,
      lastSeenAt: 1_699_000_000_000,
      elapsedTicks: 900,
      economy: { money: 4_200, barLevel: 7 },
    };
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(v2) });

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.migratedFrom).toBe(2);
    expect(result.save.club.cash).toBe(4_200);
    expect(result.save.club.stations).toHaveLength(3);
    expect(result.save.club.stations[0]).toEqual({
      key: 'tap',
      unlocked: true,
      level: 1,
      lanes: 1,
    });
    expect(result.save.club.stations[1]!.unlocked).toBe(false);
    expect(result.save.elapsedTicks).toBe(900);
    expect(result.save.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('a migrated save can be re-saved and re-read at the current version', () => {
    const v1: SaveV1 = { version: 1, lastSeenAt: 1_699_000_000_000, money: 50 };
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(v1) });

    const first = loadSave(storage);
    expect(first.status).toBe('loaded');
    if (first.status !== 'loaded') return;

    writeSave(storage, createSave(first.save.club, first.save.settings, 10, 1_699_000_100_000));

    const second = loadSave(storage);
    expect(second.status).toBe('loaded');
    if (second.status !== 'loaded') return;
    expect(second.migratedFrom).toBeNull();
    expect(second.save.club.cash).toBe(50);
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
    ['missing version', { lastSeenAt: 1, club: freshSavedClub() }],
    ['missing lastSeenAt', { version: 3, elapsedTicks: 0, club: freshSavedClub() }],
    ['missing club', { version: 3, lastSeenAt: 1, elapsedTicks: 0 }],
    [
      'cash is a string',
      {
        version: 3,
        lastSeenAt: 1,
        elapsedTicks: 0,
        club: { ...freshSavedClub(), cash: 'lots' },
      },
    ],
    [
      'NaN cash',
      {
        version: 3,
        lastSeenAt: 1,
        elapsedTicks: 0,
        club: { ...freshSavedClub(), cash: Number.NaN },
      },
    ],
    [
      'station level is a string',
      {
        version: 3,
        lastSeenAt: 1,
        elapsedTicks: 0,
        club: {
          ...freshSavedClub(),
          stations: [{ key: 'tap', unlocked: true, level: 'max', lanes: 1 }],
        },
      },
    ],
    [
      'no stations at all',
      { version: 3, lastSeenAt: 1, elapsedTicks: 0, club: { ...freshSavedClub(), stations: [] } },
    ],
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

  it('keeps a club whose settings block is malformed', () => {
    // Settings are preferences, not progress. Losing a twenty-minute club
    // because a boolean went missing would be the worst possible trade.
    const storage = memoryStorage({
      [SAVE_STORAGE_KEY]: JSON.stringify({
        version: 3,
        lastSeenAt: 1,
        elapsedTicks: 0,
        club: playedClub(),
        settings: { audio: 'yes', reducedMotion: 'sometimes' },
      }),
    });

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;
    expect(result.save.club.cash).toBe(12_345.67);
    expect(result.save.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('tolerates a save missing fields added after it was written', () => {
    // Forward compatibility within a version: an early v3 save that predates
    // the hint flags must still load, with those flags defaulted.
    const partial: Record<string, unknown> = { ...playedClub() };
    delete partial.lastCallMeter;
    delete partial.hintBubblePending;
    const storage = memoryStorage({
      [SAVE_STORAGE_KEY]: JSON.stringify({
        version: 3,
        lastSeenAt: 1,
        elapsedTicks: 0,
        club: partial,
      }),
    });

    const result = loadSave(storage);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;
    expect(result.save.club.lastCallMeter).toBe(0);
    expect(result.save.club.hintBubblePending).toBe(true);
    expect(result.save.club.cash).toBe(12_345.67);
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
    expect(writeSave(storage, createSave(freshSavedClub(), DEFAULT_SETTINGS, 0))).toBe(false);
    expect(() => clearSave(storage)).not.toThrow();
  });
});
