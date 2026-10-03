/**
 * The §4.4 pacing table — the thing acceptance criterion 1 is measured against.
 *
 * Signed off in DUB-4 and frozen for Phase 1. It lives here, beside the
 * constants, rather than inside a tool, because **two** things verify against
 * it and they must not each carry their own copy:
 *
 *  - `tools/economy-sim.ts` — the economy *model*, which is what DUB-4
 *    reviewed. Fast, closed-form, no game state.
 *  - `tools/autobuy.ts` — the shipping `ClubState` driven by the real
 *    `tickClub` and the real purchase functions.
 *
 * The second is the one that matters for the acceptance criterion, because a
 * model that matches the table while the game does not is exactly the failure
 * mode the criterion exists to catch. Keeping one table means a divergence
 * between model and game shows up as two different sets of numbers against the
 * same expectations, rather than as two tools that both pass.
 *
 * Predicates take `ClubProgress`, the one shape both the model and the game can
 * produce.
 */

import {
  DOOR_MAX,
  MAX_LANES,
  MAX_STATION_LEVEL,
  type ClubProgress,
  type StationKey,
} from './economy.ts';

export interface Milestone {
  readonly label: string;
  /** Target wall-clock time from a fresh club, in minutes. */
  readonly expectedMinutes: number;
  /** Income/s the §4.4 table expects at that moment, Regular guests only. */
  readonly expectedIncome: number;
  readonly met: (progress: ClubProgress) => boolean;
}

/** Tolerance on wall-clock time. The criterion is ±20%. */
export const PACING_TOLERANCE = 0.2;

function stationAt(progress: ClubProgress, key: StationKey) {
  const hit = progress.stations.find((st) => st.key === key);
  if (hit === undefined) throw new Error(`no station "${key}"`);
  return hit;
}

export const MILESTONES: readonly Milestone[] = [
  {
    label: 'Tap L12',
    expectedMinutes: 1,
    expectedIncome: 5.2,
    met: (p) => stationAt(p, 'tap').level >= 12,
  },
  {
    label: 'Tap L17',
    expectedMinutes: 2,
    expectedIncome: 7.9,
    met: (p) => stationAt(p, 'tap').level >= 17,
  },
  {
    label: 'Tap L22',
    expectedMinutes: 3,
    expectedIncome: 24.4,
    met: (p) => stationAt(p, 'tap').level >= 22,
  },
  {
    label: 'Tap lane 2 + Door L2',
    expectedMinutes: 3.5,
    expectedIncome: 58,
    met: (p) => stationAt(p, 'tap').lanes >= 2 && p.doorLevel >= 2,
  },
  {
    label: 'Cocktail Bar unlocked',
    expectedMinutes: 4.4,
    expectedIncome: 91,
    met: (p) => stationAt(p, 'cocktail').unlocked,
  },
  {
    label: 'Tap L29, Cocktail L12, Door L4',
    expectedMinutes: 5,
    expectedIncome: 120,
    met: (p) =>
      stationAt(p, 'tap').level >= 29 && stationAt(p, 'cocktail').level >= 12 && p.doorLevel >= 4,
  },
  {
    label: 'Tap Bar maxed L30 ***',
    expectedMinutes: 6,
    expectedIncome: 251,
    met: (p) => stationAt(p, 'tap').level >= 30,
  },
  {
    label: 'Tap lane 3 + Door L5',
    expectedMinutes: 6.3,
    expectedIncome: 416,
    met: (p) => stationAt(p, 'tap').lanes >= 3 && p.doorLevel >= 5,
  },
  {
    label: 'Cocktail lane 2 + Door L6',
    expectedMinutes: 7.3,
    expectedIncome: 641,
    met: (p) => stationAt(p, 'cocktail').lanes >= 2 && p.doorLevel >= 6,
  },
  {
    label: 'Booth Service unlocked',
    expectedMinutes: 9,
    expectedIncome: 839,
    met: (p) => stationAt(p, 'booth').unlocked,
  },
  {
    label: 'Tap 30 / Cocktail 29 / Booth 14, Door L7',
    expectedMinutes: 10,
    expectedIncome: 1033,
    met: (p) =>
      stationAt(p, 'tap').level >= 30 &&
      stationAt(p, 'cocktail').level >= 29 &&
      stationAt(p, 'booth').level >= 14 &&
      p.doorLevel >= 7,
  },
  {
    label: 'Booth L27, Cocktail lane 3, Door L8',
    expectedMinutes: 15,
    expectedIncome: 3298,
    met: (p) =>
      stationAt(p, 'booth').level >= 27 && stationAt(p, 'cocktail').lanes >= 3 && p.doorLevel >= 8,
  },
  {
    label: 'All L30, all 3 lanes, Door L8 — CLUB COMPLETE',
    expectedMinutes: 20,
    expectedIncome: 11783,
    met: (p) =>
      p.doorLevel >= DOOR_MAX &&
      p.stations.every(
        (st) => st.unlocked && st.level >= MAX_STATION_LEVEL && st.lanes >= MAX_LANES,
      ),
  },
];

export const CLUB_COMPLETE_LABEL = 'All L30, all 3 lanes, Door L8 — CLUB COMPLETE';

/** Signed relative error on a milestone's wall-clock time. */
export function pacingError(expectedMinutes: number, actualMinutes: number): number {
  return (actualMinutes - expectedMinutes) / expectedMinutes;
}

export function withinTolerance(expectedMinutes: number, actualMinutes: number): boolean {
  return Math.abs(pacingError(expectedMinutes, actualMinutes)) <= PACING_TOLERANCE;
}
