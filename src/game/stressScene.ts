/**
 * The DUB-6 C1 certification scene, as a deterministic preset.
 *
 * Criterion C1 is specified at "**>= 50 fps** on mid-range Android with 25
 * guests, 9 bartenders and 3 queues on screen". The owner is not going to play
 * up to that on a phone with a stopwatch in the other hand, and "roughly that
 * busy" is not a condition two people can measure the same way twice. So
 * `?debug=1&stress=1` puts the game straight into it.
 *
 * Two halves, and the split matters:
 *
 *  - **The club state** is real. Three stations open, L30/L29, three lanes
 *    each, Door L8 — a club the player can actually own, which is why the 9
 *    bartenders are 9 *owned lanes* rather than 9 sprites turned on. The
 *    economy, the queues and the idle-bartender diagnostic all behave here
 *    exactly as they do in a real late-game session.
 *  - **The crowd allocation** is pinned, because no purchase state puts
 *    exactly 25 guests in 3 queues on screen. At full build-out the door only
 *    outruns capacity by 0.06 guests/s, so every queue is one guest deep. See
 *    `CrowdPin`.
 *
 * Determinism: nothing here reads the clock, the save, or `Math.random`. Same
 * owned state, same cash, same RNG seed, same crowd on every load — so two
 * runs on the same phone are comparable, and the owner's number and QA's
 * number are measuring the same scene.
 */

import {
  DOOR_MAX,
  MAX_LANES,
  MAX_RENDERED_GUESTS,
  MAX_STATION_LEVEL,
  STATION_DEFS,
} from '../config/economy.ts';
import type { CrowdPin } from '../render/clubScene.ts';
import { createClubState, recomputeDerived, type ClubState } from '../sim/clubState.ts';

/** Guests on screen in the C1 scene. §11 caps the room at 30. */
export const STRESS_GUESTS = 25;

/** Queues on screen in the C1 scene: one at each of the three bars. */
export const STRESS_QUEUES = 3;

/**
 * Guests per bar queue. DUB-6's queue-overflow state says "max 4 per station",
 * so 4 is the deepest queue the game is allowed to draw.
 */
export const STRESS_QUEUE_LENGTH = 4;

/** Bartenders on screen: three stations x three lanes, all owned. */
export const STRESS_BARTENDERS = STATION_DEFS.length * MAX_LANES;

/**
 * The crowd, resolved.
 *
 * The door queue is empty on purpose: C1 says three queues, and the three bar
 * queues are the ones that carry the diagnostic. Whatever the bar queues do
 * not use goes to the dance floor, where guests are the expensive ones — they
 * are the only entities that move, interpolate and avoid each other.
 */
export const STRESS_CROWD: CrowdPin = {
  queuePerStation: STRESS_QUEUE_LENGTH,
  doorQueue: 0,
  dancers: STRESS_GUESTS - STRESS_QUEUES * STRESS_QUEUE_LENGTH,
};

/**
 * One level short of full build-out, and that is deliberate.
 *
 * A complete club has no next purchase, so the §4.4b dotted outline and its
 * progress fill are hidden — and they are the only per-frame crossfade in the
 * scene. Leaving the Booth at L29 keeps them on screen without changing the
 * routing order (the Booth is still the dearest station by a factor of four),
 * so every drawn element of a late-game floor is being measured.
 */
const STRESS_SHORTFALL_STATION = 'booth';

/**
 * Build the C1 club.
 *
 * Cash starts at 0, which is not an accident either: it means the next-purchase
 * outline is dotted and the Last Call meter is in its promoted state for the
 * first seconds of a measurement, then crosses into affordable. Both are drawn
 * states and both get measured, in the same order, every run.
 */
export function createStressClub(): ClubState {
  const club = createClubState();

  club.doorLevel = DOOR_MAX;
  for (const station of club.stations) {
    station.unlocked = true;
    station.lanes = MAX_LANES;
    station.level =
      station.key === STRESS_SHORTFALL_STATION ? MAX_STATION_LEVEL - 1 : MAX_STATION_LEVEL;
  }

  club.cash = 0;
  // Nothing has been earned in this session and nothing is owed: the preset is
  // a measurement fixture, not a save, and it is never written back.
  club.totalEarned = 0;
  // The two one-time hint rings are first-run guidance. A L30 club that still
  // has them pending would be a state the game cannot reach, and the ring sits
  // on top of a bar.
  club.hintBubblePending = false;
  club.hintStationPending = false;
  // Belt and braces: the preset is one level short of complete, so this cannot
  // fire today — but if the shortfall is ever removed the club-complete card
  // must not land on top of the overlay mid-measurement.
  club.completeSeen = true;

  recomputeDerived(club);
  return club;
}

/**
 * What the pinned crowd adds up to.
 *
 * Exported so the arithmetic is testable without a WebGL context — the scene
 * itself cannot be constructed under `vitest`'s node environment.
 */
export function stressCrowdTotals(): {
  guests: number;
  queues: number;
  withinGuestCap: boolean;
} {
  const queued = STRESS_CROWD.queuePerStation * STATION_DEFS.length;
  const guests = queued + STRESS_CROWD.dancers + STRESS_CROWD.doorQueue;
  return {
    guests,
    queues:
      (STRESS_CROWD.queuePerStation > 0 ? STATION_DEFS.length : 0) +
      (STRESS_CROWD.doorQueue > 0 ? 1 : 0),
    withinGuestCap: guests <= MAX_RENDERED_GUESTS,
  };
}
