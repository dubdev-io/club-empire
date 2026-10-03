import { describe, expect, it } from 'vitest';
import { DOOR_MAX, MAX_LANES } from '../config/economy.ts';
import {
  buyLane,
  createClubState,
  creditCash,
  stationStateOf,
  unlockStation,
  upgradeDoor,
  upgradeStation,
  type ClubState,
} from '../sim/clubState.ts';
import { canAddLanes, doorDiagnosis } from './DoorSheet.tsx';

/**
 * The DOOR sheet's queue line (DUB-13).
 *
 * The bug was that the line branched on how big the overflow was instead of on
 * whether the player could do anything about it, so it advised "more lanes" in
 * the state where every lane is already bought. Two things are pinned here: the
 * copy each state produces, and the economy fact that makes the dead end
 * reachable mid-run rather than only at full build-out.
 */

/** A `StationView` stub with only the two fields the predicate reads. */
function station(laneCost: number | null, unlockCost: number | null) {
  return { laneCost, unlockCost };
}

/** Flatten a diagnosis to the sentence the player sees, glyph included. */
function line(d: ReturnType<typeof doorDiagnosis>): string {
  return d.lead === null ? `${d.glyph} ${d.body}` : `${d.glyph} ${d.lead} — ${d.body}`;
}

describe('canAddLanes', () => {
  it('is true while any station can take another lane', () => {
    expect(canAddLanes([station(120, null), station(null, null)])).toBe(true);
  });

  it('counts a locked station, because unlocking it is how its lanes arrive', () => {
    expect(canAddLanes([station(null, null), station(null, 5_000)])).toBe(true);
  });

  it('is false only when every lane purchase is gone', () => {
    expect(canAddLanes([station(null, null), station(null, null)])).toBe(false);
  });
});

describe('the DOOR sheet queue diagnosis', () => {
  it('says nothing is queueing when nothing is', () => {
    const d = doorDiagnosis(0, true, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ No queue. Every guest who arrives gets served.');
  });

  it('warns — and advises lanes — while a lane can still be bought', () => {
    const d = doorDiagnosis(1.42, true, false);

    expect(d.warn).toBe(true);
    expect(line(d)).toBe('⚠ Queue — 1.42/s turned away. More lanes before more guests.');
  });

  it('points at levels, without a warning, once every lane is bought', () => {
    const d = doorDiagnosis(0.058, false, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ Full house — 0.06/s walk past. Levels are what pay now.');
  });

  it('reads as finished when the club is complete', () => {
    const d = doorDiagnosis(0.058, false, true);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ Full house — 0.06/s walk past. The club is as big as it gets.');
  });

  it('never shows ⚠ when no lane is purchasable, at any overflow rate', () => {
    for (const rate of [0.002, 0.058, 0.5, 3.2, 40]) {
      const d = doorDiagnosis(rate, false, false);
      expect(d.warn).toBe(false);
      expect(d.glyph).not.toBe('⚠');
    }
  });

  it('keeps both dead-end strings inside the two-line box at 390 px', () => {
    // Measured at 390x844: the diagnosis box fits 64 characters on two lines
    // before it pushes the buy button down. Guarding the length here is cheaper
    // than re-measuring a screenshot every time the copy is edited.
    for (const complete of [false, true]) {
      expect(line(doorDiagnosis(0.058, false, complete)).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('the state the dead-end copy exists for', () => {
  /** Door maxed, every lane bought, stations left at `level`. */
  function fullLanes(level: number): ClubState {
    const club = createClubState();
    creditCash(club, 1e9);
    unlockStation(club, 'cocktail');
    unlockStation(club, 'booth');
    for (const key of ['tap', 'cocktail', 'booth'] as const) {
      while (stationStateOf(club, key).lanes < MAX_LANES) {
        creditCash(club, 1e9);
        if (buyLane(club, key) !== 'bought') break;
      }
      while (stationStateOf(club, key).level < level) {
        creditCash(club, 1e9);
        if (upgradeStation(club, key) !== 'bought') break;
      }
    }
    while (club.doorLevel < DOOR_MAX) {
      creditCash(club, 1e9);
      if (upgradeDoor(club) !== 'bought') break;
    }
    return club;
  }

  it('is reachable with 23 station levels still to buy', () => {
    const club = fullLanes(7);

    expect(club.doorLevel).toBe(DOOR_MAX);
    for (const st of club.stations) {
      expect(st.unlocked).toBe(true);
      expect(st.lanes).toBe(MAX_LANES);
      expect(st.level).toBe(7);
    }

    // The residual is structural: Lv 8 arrives faster than three stations at
    // three lanes can serve, and no purchase closes the gap.
    expect(club.derived.flow.turnedAwayPerSecond).toBeGreaterThan(0.001);
    expect(club.derived.flow.turnedAwayPerSecond).toBeCloseTo(0.058, 3);

    // Which is why the old absolute threshold was wrong: there is nothing to buy.
    const views = club.stations.map((st) =>
      station(st.lanes < MAX_LANES ? 1 : null, st.unlocked ? null : 1),
    );
    expect(canAddLanes(views)).toBe(false);
    expect(club.derived.complete).toBe(false);
  });
});
