import { describe, expect, it } from 'vitest';
import { DOOR_MAX, MAX_LANES, QUEUE_WARNING_SHARE } from '../config/economy.ts';
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
 * the state where every lane is already bought — and fired the game's only
 * alarm glyph on a fresh club, where the HUD banner and the DOOR badge both
 * correctly stay quiet. Three things are pinned here: the copy each of the five
 * states produces, that `⚠` needs both severity and purchasability, and the
 * economy fact that makes the dead end reachable mid-run rather than only at
 * full build-out.
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
  it('A — says nothing is queueing when nothing is', () => {
    const d = doorDiagnosis(0, 0.9, true, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ No queue. Every guest who arrives gets served.');
  });

  it('B — warns once most arrivals are being turned away and a lane is buyable', () => {
    // The flooded door: 3.22/s arriving, 0.50/s served, 84% turned away.
    const d = doorDiagnosis(2.72, 3.22, true, false);

    expect(d.warn).toBe(true);
    expect(line(d)).toBe('⚠ Queue — 2.72/s turned away. More lanes before more guests.');
  });

  it('C — gives the same advice without the alarm on a fresh club', () => {
    // Second zero of every run: 0.90/s arriving, 0.50/s served, 44% turned
    // away, and the Door Lv 2 buy locked behind cash for three more minutes.
    const d = doorDiagnosis(0.4, 0.9, true, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ 0.40/s walk past. More lanes before more guests.');
  });

  it('C/B — the amber tier starts exactly at QUEUE_WARNING_SHARE', () => {
    const arrivals = 2;
    const at = doorDiagnosis(arrivals * QUEUE_WARNING_SHARE, arrivals, true, false);
    const below = doorDiagnosis(arrivals * QUEUE_WARNING_SHARE - 0.01, arrivals, true, false);

    expect(at.warn).toBe(true);
    expect(below.warn).toBe(false);
    // Only the register moves across the boundary; the advice does not.
    expect(at.body).toContain('More lanes before more guests.');
    expect(below.body).toContain('More lanes before more guests.');
  });

  it('D1 — points at levels, without a warning, once every lane is bought', () => {
    const d = doorDiagnosis(0.058, 3.225, false, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ Full house — 0.06/s walk past. Levels are what pay now.');
  });

  it('D2 — reads as finished when the club is complete', () => {
    const d = doorDiagnosis(0.058, 3.225, false, true);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe("◦ Full house — 0.06/s walk past. You've built it all.");
  });

  it('never shows ⚠ when no lane is purchasable, at any overflow share', () => {
    for (const rate of [0.002, 0.058, 0.5, 3.2, 40]) {
      for (const arrivals of [0, 0.9, 3.225, 40]) {
        const d = doorDiagnosis(rate, arrivals, false, false);
        expect(d.warn).toBe(false);
        expect(d.glyph).not.toBe('⚠');
      }
    }
  });

  it('never shows ⚠ below the share the HUD and the DOOR badge use', () => {
    // The sheet was the only surface ignoring this threshold; the point of the
    // fix is that all three now agree about when the glyph is earned.
    for (const share of [0, 0.1, 0.3, 0.44, 0.499]) {
      const d = doorDiagnosis(share * 3.225, 3.225, true, false);
      expect(d.warn).toBe(false);
      expect(d.glyph).not.toBe('⚠');
    }
  });

  it('keeps every string inside the two-line box at 390 px', () => {
    // Measured at 390x844: the diagnosis box fits 64 characters on two lines
    // before it pushes the buy button down. Guarding the length here is cheaper
    // than re-measuring a screenshot every time the copy is edited.
    const lines = [
      doorDiagnosis(0, 0.9, true, false),
      doorDiagnosis(2.72, 3.22, true, false),
      doorDiagnosis(0.4, 0.9, true, false),
      doorDiagnosis(0.058, 3.225, false, false),
      doorDiagnosis(0.058, 3.225, false, true),
    ];

    for (const d of lines) {
      expect(line(d).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('the two states the new copy exists for', () => {
  it('a fresh club overflows below the warning share, so tier C is the first-run state', () => {
    const club = createClubState();
    const { arrivalsPerSecond: arrivals, turnedAwayPerSecond: turnedAway } = club.derived.flow;

    // 0.90/s arriving against 0.50/s served — the `min()` binds from second
    // zero, which is exactly why gating on magnitude alone lit the alarm on a
    // brand-new save.
    expect(turnedAway).toBeGreaterThan(0.001);
    expect(turnedAway / arrivals).toBeLessThan(QUEUE_WARNING_SHARE);

    const d = doorDiagnosis(turnedAway, arrivals, true, false);
    expect(d.warn).toBe(false);
    expect(d.glyph).toBe('◦');
    expect(d.body).toContain('walk past. More lanes before more guests.');
  });

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

  it('a flooded door with two stations still locked stays in the warning tier', () => {
    const club = createClubState();
    while (club.doorLevel < DOOR_MAX) {
      creditCash(club, 1e9);
      if (upgradeDoor(club) !== 'bought') break;
    }

    const { arrivalsPerSecond: arrivals, turnedAwayPerSecond: turnedAway } = club.derived.flow;
    const views = club.stations.map((st) =>
      station(st.lanes < MAX_LANES ? 1 : null, st.unlocked ? null : 1),
    );

    // Unlocking a station is how its lanes arrive, so a locked station is a
    // lane that can be bought — the line must not read as a dead end here.
    expect(club.stations.filter((st) => !st.unlocked)).toHaveLength(2);
    expect(canAddLanes(views)).toBe(true);
    expect(turnedAway / arrivals).toBeGreaterThanOrEqual(QUEUE_WARNING_SHARE);

    const d = doorDiagnosis(turnedAway, arrivals, canAddLanes(views), club.derived.complete);
    expect(d.warn).toBe(true);
    expect(d.lead).toBe('Queue');
  });
});
