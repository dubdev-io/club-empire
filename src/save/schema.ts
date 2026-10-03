/**
 * Save schema definitions and the migration chain.
 *
 * Rules this file exists to enforce:
 *  - every save on disk carries its own `version`;
 *  - a save written by an older build is migrated forward, one version at a
 *    time, by a pure function;
 *  - a save written by a *newer* build (player downgraded, or a stale CDN
 *    bundle) is discarded, not reinterpreted;
 *  - anything unparseable or structurally wrong is discarded.
 *
 * Nothing in here throws. The caller gets a save or `null`, and the boot path
 * turns a `null` into a readable banner rather than a white screen.
 *
 * Field-level validation is not optional here. `localStorage` is
 * player-writable and the brief is explicit that we add no anti-cheat — but a
 * hand-edited `cash: "lots"` reaching the economy turns every later tick into
 * `NaN`, and that is a crash rather than a cheat.
 */

/** Bump this whenever the persisted shape changes, and add a migration. */
export const CURRENT_SAVE_VERSION = 3;

export const SAVE_STORAGE_KEY = 'club-empire:save';

/** v1 — the first shell shape. Kept for the migration path only. */
export interface SaveV1 {
  version: 1;
  lastSeenAt: number;
  money: number;
}

/** v2 — the shell's placeholder economy. Kept for the migration path only. */
export interface SaveV2 {
  version: 2;
  lastSeenAt: number;
  elapsedTicks: number;
  economy: {
    money: number;
    barLevel: number;
  };
}

export interface SavedStation {
  key: string;
  unlocked: boolean;
  level: number;
  lanes: number;
}

export interface SavedSettings {
  audio: boolean;
  /** `auto` follows `prefers-reduced-motion`; the other two are explicit overrides. */
  reducedMotion: 'auto' | 'on' | 'off';
  haptics: boolean;
}

/** v3 — current. The real club. */
export interface SaveV3 {
  version: 3;
  lastSeenAt: number;
  elapsedTicks: number;
  club: {
    cash: number;
    totalEarned: number;
    doorLevel: number;
    stations: SavedStation[];
    lastCallMeter: number;
    lastCallFiredCount: number;
    bubblesCollected: number;
    elapsedSeconds: number;
    purchaseCount: number;
    completeSeen: boolean;
    hintBubblePending: boolean;
    hintStationPending: boolean;
  };
  settings: SavedSettings;
}

export type AnySave = SaveV1 | SaveV2 | SaveV3;
export type CurrentSave = SaveV3;

export const DEFAULT_SETTINGS: SavedSettings = {
  audio: true,
  reducedMotion: 'auto',
  haptics: true,
};

/** A club nobody has played yet, in persisted form. */
export function freshSavedClub(): SaveV3['club'] {
  return {
    cash: 0,
    totalEarned: 0,
    doorLevel: 1,
    stations: [
      { key: 'tap', unlocked: true, level: 1, lanes: 1 },
      { key: 'cocktail', unlocked: false, level: 1, lanes: 0 },
      { key: 'booth', unlocked: false, level: 1, lanes: 0 },
    ],
    lastCallMeter: 0,
    lastCallFiredCount: 0,
    bubblesCollected: 0,
    elapsedSeconds: 0,
    purchaseCount: 0,
    completeSeen: false,
    hintBubblePending: true,
    hintStationPending: true,
  };
}

/**
 * `migrations[n]` upgrades a version-`n` save to version `n + 1`.
 * A missing entry for a version below current means that save cannot be
 * migrated and must be discarded.
 */
export const migrations: Record<number, (save: AnySave) => AnySave> = {
  1: (save) => {
    const v1 = save as SaveV1;
    return {
      version: 2,
      lastSeenAt: v1.lastSeenAt,
      elapsedTicks: 0,
      economy: { money: v1.money, barLevel: 1 },
    };
  },

  2: (save) => {
    const v2 = save as SaveV2;
    // The v2 `barLevel` was the technical shell's placeholder curve and has no
    // counterpart in the real economy — a "level 7" there is not a level 7 Tap
    // Bar and pretending otherwise would hand the player a club they did not
    // build. Cash carries over, because cash is cash; everything else starts
    // from a fresh club. Only ever affects pre-Phase-1 dev saves.
    const club = freshSavedClub();
    club.cash = v2.economy.money;
    club.totalEarned = v2.economy.money;
    return {
      version: 3,
      lastSeenAt: v2.lastSeenAt,
      elapsedTicks: v2.elapsedTicks,
      club,
      settings: { ...DEFAULT_SETTINGS },
    };
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function num(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function validateStations(raw: unknown): SavedStation[] | null {
  if (!Array.isArray(raw)) return null;

  const out: SavedStation[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) return null;
    if (typeof entry.key !== 'string') return null;
    if (!isFiniteNumber(entry.level) || !isFiniteNumber(entry.lanes)) return null;
    out.push({
      key: entry.key,
      unlocked: entry.unlocked === true,
      level: entry.level,
      lanes: entry.lanes,
    });
  }
  return out;
}

function validateSettings(raw: unknown): SavedSettings {
  // Settings are preferences, not progress. A malformed settings block is not
  // worth discarding a club over — fall back to defaults field by field.
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS };

  const motion = raw.reducedMotion;
  return {
    audio: bool(raw.audio, DEFAULT_SETTINGS.audio),
    reducedMotion:
      motion === 'on' || motion === 'off' || motion === 'auto' ? motion : DEFAULT_SETTINGS.reducedMotion,
    haptics: bool(raw.haptics, DEFAULT_SETTINGS.haptics),
  };
}

/**
 * Structural validation of a raw parsed blob against a known version.
 *
 * Returns the typed save, or `null` if the version is unknown or a required
 * field is missing or the wrong type. "Required" means load-bearing: cash,
 * levels and lane counts are validated strictly because the economy reads them
 * as numbers, while cosmetic counters and flags take defaults so that an older
 * save missing a field added later still loads.
 */
export function validateSave(raw: unknown): AnySave | null {
  if (!isObject(raw)) return null;
  if (!isFiniteNumber(raw.version)) return null;
  if (!isFiniteNumber(raw.lastSeenAt)) return null;

  switch (raw.version) {
    case 1:
      if (!isFiniteNumber(raw.money)) return null;
      return { version: 1, lastSeenAt: raw.lastSeenAt, money: raw.money };

    case 2: {
      if (!isFiniteNumber(raw.elapsedTicks)) return null;
      const economy = raw.economy;
      if (!isObject(economy)) return null;
      if (!isFiniteNumber(economy.money)) return null;
      if (!isFiniteNumber(economy.barLevel)) return null;
      return {
        version: 2,
        lastSeenAt: raw.lastSeenAt,
        elapsedTicks: raw.elapsedTicks,
        economy: { money: economy.money, barLevel: economy.barLevel },
      };
    }

    case 3: {
      if (!isFiniteNumber(raw.elapsedTicks)) return null;
      const club = raw.club;
      if (!isObject(club)) return null;
      if (!isFiniteNumber(club.cash)) return null;
      if (!isFiniteNumber(club.doorLevel)) return null;

      const stations = validateStations(club.stations);
      if (stations === null || stations.length === 0) return null;

      return {
        version: 3,
        lastSeenAt: raw.lastSeenAt,
        elapsedTicks: raw.elapsedTicks,
        club: {
          cash: club.cash,
          totalEarned: num(club.totalEarned, club.cash),
          doorLevel: club.doorLevel,
          stations,
          lastCallMeter: num(club.lastCallMeter, 0),
          lastCallFiredCount: num(club.lastCallFiredCount, 0),
          bubblesCollected: num(club.bubblesCollected, 0),
          elapsedSeconds: num(club.elapsedSeconds, 0),
          purchaseCount: num(club.purchaseCount, 0),
          completeSeen: bool(club.completeSeen, false),
          hintBubblePending: bool(club.hintBubblePending, true),
          hintStationPending: bool(club.hintStationPending, true),
        },
        settings: validateSettings(raw.settings),
      };
    }

    default:
      // Includes saves from a future version — discard rather than guess.
      return null;
  }
}

export type MigrateOutcome =
  | { status: 'ok'; save: CurrentSave; migratedFrom: number | null }
  | { status: 'discarded'; reason: 'invalid' | 'future-version' | 'no-migration-path' };

/**
 * Bring any validated save up to `CURRENT_SAVE_VERSION`.
 *
 * Applies migrations one version at a time so each step only has to know about
 * its immediate successor. Re-validates after every step, which is what catches
 * a migration that produces a broken shape — the failure mode that would
 * otherwise reach the player as a wiped club.
 */
export function migrateSave(raw: unknown): MigrateOutcome {
  const validated = validateSave(raw);
  if (!validated) {
    const version = isObject(raw) && isFiniteNumber(raw.version) ? raw.version : null;
    if (version !== null && version > CURRENT_SAVE_VERSION) {
      return { status: 'discarded', reason: 'future-version' };
    }
    return { status: 'discarded', reason: 'invalid' };
  }

  const startedAt = validated.version;
  let save: AnySave = validated;

  while (save.version < CURRENT_SAVE_VERSION) {
    const migrate = migrations[save.version];
    if (!migrate) {
      return { status: 'discarded', reason: 'no-migration-path' };
    }
    const next = validateSave(migrate(save));
    if (!next || next.version <= save.version) {
      // A migration that does not move forward would loop forever.
      return { status: 'discarded', reason: 'no-migration-path' };
    }
    save = next;
  }

  return {
    status: 'ok',
    save: save as CurrentSave,
    migratedFrom: startedAt === CURRENT_SAVE_VERSION ? null : startedAt,
  };
}
