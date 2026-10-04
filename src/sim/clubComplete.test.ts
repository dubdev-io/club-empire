/**
 * The club-complete screen has to survive a reload (DUB-11 defect 2).
 *
 * The payoff moment is reachable exactly once in a run, and `completeSeen` is
 * only set when the player taps [KEEP PLAYING]. Autosave persists the finished
 * club long before that tap, so completing the club and then reloading — or
 * having the tab evicted in the background — used to lose the screen for good.
 *
 * `shouldShowComplete()` was correct all along. It was exported and called from
 * nowhere, with the live trigger an inline copy of it on the purchase path only.
 * So these tests cover both halves of the fix: that the predicate survives the
 * save round trip a reload performs, and that both paths that need it call it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOOR_MAX, MAX_LANES, MAX_STATION_LEVEL, STATION_DEFS } from '../config/economy.ts';
import {
  buyLane,
  createClubState,
  restoreClub,
  shouldShowComplete,
  snapshotClub,
  unlockStation,
  upgradeDoor,
  upgradeStation,
  type ClubState,
} from './clubState.ts';

/**
 * A finished club, built through the real purchase functions.
 *
 * Not a hand-written snapshot: the point of the test is that a club the player
 * actually completed reads as complete after a reload, and setting the fields
 * directly would skip the code that decides what "complete" means.
 */
function completedClub(): ClubState {
  const club = createClubState();
  // Cash is not the subject here; the purchase functions all check affordability.
  club.cash = 1e12;

  for (const def of STATION_DEFS) {
    if (!club.stations.find((st) => st.key === def.key)?.unlocked) {
      unlockStation(club, def.key);
    }
    while ((club.stations.find((st) => st.key === def.key)?.level ?? 0) < MAX_STATION_LEVEL) {
      club.cash = 1e12;
      upgradeStation(club, def.key);
    }
    while ((club.stations.find((st) => st.key === def.key)?.lanes ?? 0) < MAX_LANES) {
      club.cash = 1e12;
      buyLane(club, def.key);
    }
  }
  while (club.doorLevel < DOOR_MAX) {
    club.cash = 1e12;
    upgradeDoor(club);
  }

  return club;
}

/** What a reload does: write the save, then read it back into a fresh club. */
function throughASave(club: ClubState): ClubState {
  return restoreClub(JSON.parse(JSON.stringify(snapshotClub(club))) as ReturnType<typeof snapshotClub>);
}

describe('shouldShowComplete across a reload', () => {
  it('is false for a club that is not finished', () => {
    expect(shouldShowComplete(createClubState())).toBe(false);
  });

  it('is true the moment the club is finished', () => {
    const club = completedClub();

    expect(club.derived.complete).toBe(true);
    expect(club.completeSeen).toBe(false);
    expect(shouldShowComplete(club)).toBe(true);
  });

  it('is still true after a reload the player did not acknowledge', () => {
    // The defect, in one assertion: complete the club, reload before tapping
    // [KEEP PLAYING], and the screen must come back.
    const restored = throughASave(completedClub());

    expect(restored.derived.complete).toBe(true);
    expect(restored.completeSeen).toBe(false);
    expect(shouldShowComplete(restored)).toBe(true);
  });

  it('is false after a reload once the player has acknowledged it', () => {
    const club = completedClub();
    // What `acknowledgeComplete` does.
    club.completeSeen = true;

    const restored = throughASave(club);

    expect(restored.derived.complete).toBe(true);
    expect(restored.completeSeen).toBe(true);
    expect(shouldShowComplete(restored)).toBe(false);
    // And it does not come back on the reload after that one either.
    expect(shouldShowComplete(throughASave(restored))).toBe(false);
  });

  it('is false for an unfinished club after a reload', () => {
    const club = createClubState();
    club.cash = 1e12;
    upgradeDoor(club);

    expect(shouldShowComplete(throughASave(club))).toBe(false);
  });
});

/**
 * A predicate nobody calls is what the defect actually was — `shouldShowComplete`
 * was exported, correct, and unreferenced, while the live trigger was an inline
 * duplicate on the purchase path. No unit test of the predicate can catch that,
 * and `runtime.ts` itself needs a WebGL context so it cannot be imported here.
 *
 * So this reads the source. It is a blunt test and it is the right shape for this
 * bug: the thing to protect is that both paths route through the one predicate.
 */
describe('both paths that need the predicate call it', () => {
  const runtime = readFileSync(new URL('../game/runtime.ts', import.meta.url), 'utf8');

  it('calls shouldShowComplete on the purchase path and the boot path', () => {
    const calls = runtime.match(/shouldShowComplete\(club\)/g) ?? [];

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps no inline copy of the predicate', () => {
    // `club.derived.complete && !club.completeSeen` is the duplicate that drifted
    // out of sync with the boot path. One definition, in clubState.ts.
    expect(runtime).not.toMatch(/derived\.complete\s*&&\s*!\s*club\.completeSeen/);
  });
});
