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
 * Nothing in here throws. The caller gets a save or `null`.
 */

/** Bump this whenever the persisted shape changes, and add a migration. */
export const CURRENT_SAVE_VERSION = 2;

export const SAVE_STORAGE_KEY = 'club-empire:save';

/** v1 — the first shipped shape. Kept for the migration path only. */
export interface SaveV1 {
  version: 1;
  lastSeenAt: number;
  money: number;
}

/** v2 — current. Economy grouped, tick clock persisted. */
export interface SaveV2 {
  version: 2;
  lastSeenAt: number;
  elapsedTicks: number;
  economy: {
    money: number;
    barLevel: number;
  };
}

export type AnySave = SaveV1 | SaveV2;
export type CurrentSave = SaveV2;

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
      economy: {
        money: v1.money,
        barLevel: 1,
      },
    };
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural validation of a raw parsed blob against a known version.
 *
 * Returns the typed save, or `null` if the version is unknown or a required
 * field is missing or the wrong type. Field-level validation matters here:
 * `localStorage` is player-writable, and a `money: "lots"` that reached the
 * economy would turn every subsequent tick into `NaN`.
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
 * Applies migrations one version at a time so each step only has to know
 * about its immediate successor. Re-validates after every step, which is what
 * catches a migration that produces a broken shape.
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
