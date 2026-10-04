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
import { canAddLanes, doorDiagnosis, stationDiagnosis, type Diagnosis } from './diagnosis.ts';

/**
 * The two sheets' queue lines (DUB-13 on the Door, design review item E on the
 * Bars).
 *
 * Both had the same bug: the line branched on how big the shortfall was, or on
 * saturation alone, instead of on whether the player could do anything about
 * it — so each advised "more lanes" in the state where every lane is already
 * bought. Three things are pinned here: the copy each state produces, the rule
 * that `⚠` never appears without a purchasable fix, and the economy fact that
 * makes the dead end reachable mid-run rather than only at full build-out.
 */

/** A `StationView` stub with only the two fields the predicate reads. */
function station(laneCost: number | null, unlockCost: number | null) {
  return { laneCost, unlockCost };
}

/** Flatten a diagnosis to the sentence the player sees, glyph included. */
function line(d: Diagnosis): string {
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
    const d = doorDiagnosis(0, 0.9, true, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ No queue. Every guest who arrives gets served.');
  });

  it('warns — and advises lanes — once the overflow is most of the door', () => {
    const d = doorDiagnosis(2.72, 3.22, true, false);

    expect(d.warn).toBe(true);
    expect(line(d)).toBe('⚠ Queue — 2.72/s turned away. More lanes before more guests.');
  });

  it('gives the same advice without the alarm below the warning share', () => {
    // The fresh club: 0.40/s of 0.90/s is 44%, under the 50% the Hud and the
    // DOOR badge both gate on. Same move, lower register.
    const d = doorDiagnosis(0.4, 0.9, true, false);

    expect(d.warn).toBe(false);
    expect(d.glyph).not.toBe('⚠');
    expect(line(d)).toBe('◦ 0.40/s walk past. More lanes before more guests.');
  });

  it('turns amber exactly at the threshold the other two surfaces use', () => {
    // Pinned on the constant, not on 0.5, so retuning the economy moves all
    // three surfaces together instead of leaving this one behind again.
    const arrivals = 2;
    const at = doorDiagnosis(arrivals * QUEUE_WARNING_SHARE, arrivals, true, false);
    const under = doorDiagnosis(arrivals * QUEUE_WARNING_SHARE - 0.01, arrivals, true, false);

    expect(at.warn).toBe(true);
    expect(under.warn).toBe(false);
  });

  it('stays quiet when there is no door to take a share of', () => {
    // The divide's guard. Not reachable from a single `ClubFlow`, where
    // `turnedAway <= arrivals` holds by construction — but the sheet reads
    // `turnedAway` and `arrivals` off two separately published store slices, so
    // the pairing is a publish-order promise rather than an invariant. Pinned
    // because the failure mode is silent: `0.4 / 0` is `Infinity`, which clears
    // the share threshold and restores the exact fresh-club alarm DUB-13
    // removed. Dropping `arrivals > 0` leaves every other test in this file
    // green.
    const d = doorDiagnosis(0.4, 0, true, false);

    expect(d.warn).toBe(false);
    expect(d.glyph).not.toBe('⚠');
  });

  it('points at levels, without a warning, once every lane is bought', () => {
    const d = doorDiagnosis(0.058, 3.225, false, false);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ Full house — 0.06/s walk past. Levels are what pay now.');
  });

  it('reads as finished, not as a ceiling, when the club is complete', () => {
    const d = doorDiagnosis(0.058, 3.225, false, true);

    expect(d.warn).toBe(false);
    expect(line(d)).toBe("◦ Full house — 0.06/s walk past. You've built it all.");
    // The completion card promises a second venue in Phase 2. This line is read
    // right after it, so it must not claim the game is out of room.
    expect(d.body).not.toMatch(/as big as it gets/);
  });

  it('never shows ⚠ when no lane is purchasable, at any overflow rate', () => {
    for (const rate of [0.002, 0.058, 0.5, 3.2, 40]) {
      const d = doorDiagnosis(rate, 3.225, false, false);
      expect(d.warn).toBe(false);
      expect(d.glyph).not.toBe('⚠');
    }
  });

  it('never shows ⚠ below the warning share, however big the raw rate', () => {
    // The old gate was an absolute 0.001, so a large club turning away a small
    // fraction of a large door read the same as a flood. Volume follows the
    // share, never the magnitude.
    for (const rate of [0.002, 0.058, 0.5, 3.2, 40]) {
      const d = doorDiagnosis(rate, rate / (QUEUE_WARNING_SHARE / 2), true, false);
      expect(d.warn).toBe(false);
      expect(d.glyph).not.toBe('⚠');
    }
  });

  it('keeps every advice string inside the two-line box at 390 px', () => {
    // Measured at 390x844: the diagnosis box fits 64 characters on two lines
    // before it pushes the buy button down. Guarding the length here is cheaper
    // than re-measuring a screenshot every time the copy is edited.
    //
    // The amber tier is in the sweep too, not just the neutral three. At 60
    // characters it is the longest of the four — the only one carrying both a
    // lead and a rate — so leaving it out tested every line except the one
    // nearest the budget, with four characters of headroom. The rate is
    // already at its widest here: the Lv 8 door cannot turn away more than
    // 3.22/s, which is the same six characters as 2.72/s.
    const strings = [
      doorDiagnosis(2.72, 3.22, true, false),
      doorDiagnosis(0.4, 0.9, true, false),
      doorDiagnosis(0.058, 3.225, false, false),
      doorDiagnosis(0.058, 3.225, false, true),
    ];

    for (const d of strings) {
      expect(line(d).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('the BARS sheet station diagnosis', () => {
  /** A `StationView` stub with only the fields the diagnosis reads. */
  function view(over: Partial<Parameters<typeof stationDiagnosis>[0]> = {}) {
    return {
      saturated: false,
      idleLanes: 0,
      laneCost: 120 as number | null,
      maxed: false,
      servedPerSecond: 1,
      capacityPerSecond: 2,
      ...over,
    };
  }

  it('says nothing when the station is neither queueing nor idling', () => {
    expect(stationDiagnosis(view({ idleLanes: 0.2 }))).toBeNull();
  });

  it('warns — and advises a lane — while a lane can still be bought', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: 120 }));

    expect(d?.warn).toBe(true);
    expect(line(d!)).toBe('⚠ Queue — every lane is busy. Add a lane.');
  });

  // Item E. The warning used to fire here, one row above a button reading
  // "3 LANES", on all three cards at once behind the CLUB COMPLETE card.
  it('states the fact without an imperative once every lane is bought', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: null }));

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — every lane is pouring. Levels are what pay now.');
  });

  it('names no lever at all when the level axis is finished too', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: null, maxed: true }));

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — this bar is as big as it gets.');
  });

  it('never shows ⚠ when no lane is purchasable, maxed or not', () => {
    for (const maxed of [false, true]) {
      const d = stationDiagnosis(view({ saturated: true, laneCost: null, maxed }));
      expect(d?.warn).toBe(false);
      expect(d?.glyph).not.toBe('⚠');
    }
  });

  it('counts idle lanes in whole bartenders, never a decimal and never zero', () => {
    // "1.0 lanes idle" reads as a rendering bug; and the 0.5 threshold must not
    // be able to round down to "0 lanes idle", which would say nothing at all.
    for (const [idleLanes, expected] of [
      [0.5, '1 lane'],
      [1, '1 lane'],
      [1.4, '1 lane'],
      [1.6, '2 lanes'],
      [2.5, '3 lanes'],
    ] as const) {
      const d = stationDiagnosis(view({ idleLanes }));
      expect(d?.body).toBe(`${expected} idle — raise the Door, not the lanes.`);
    }
  });

  it('keeps every line inside the two-line box at 390 px', () => {
    // Same 64-character budget the Door lines are held to.
    for (const over of [
      { saturated: true, laneCost: 120 },
      { saturated: true, laneCost: null },
      { saturated: true, laneCost: null, maxed: true },
      { idleLanes: 2 },
    ]) {
      const d = stationDiagnosis(view(over));
      expect(line(d!).length).toBeLessThanOrEqual(64);
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

describe('the first state every player sees', () => {
  /**
   * The fresh club, straight out of `createClubState`, against the real
   * economy.
   *
   * This is the state the second fix exists for, and the reason it is pinned
   * against the simulation rather than a stub: the dead end at the end of the
   * run is visible by reading the economy, but the nag at the start was only
   * visible by opening the sheet on a new save. A stub would have let me pick
   * the share that proves my own point. These numbers come from the config.
   */
  it('turns away 44% of the door — a real queue, but not an alarm', () => {
    const club = createClubState();
    const { arrivalsPerSecond, turnedAwayPerSecond } = club.derived.flow;

    // §4.4: 0.90/s arriving against 0.50/s of one tap station at one lane.
    expect(arrivalsPerSecond).toBeCloseTo(0.9, 3);
    expect(turnedAwayPerSecond).toBeCloseTo(0.4, 3);

    const share = turnedAwayPerSecond / arrivalsPerSecond;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(QUEUE_WARNING_SHARE);

    // A lane is buyable here, so the advice is given — just not in amber, with
    // the player holding £32 against a £60 upgrade.
    const views = club.stations.map((st) =>
      station(st.lanes < MAX_LANES ? 1 : null, st.unlocked ? null : 1),
    );
    expect(canAddLanes(views)).toBe(true);

    const d = doorDiagnosis(turnedAwayPerSecond, arrivalsPerSecond, canAddLanes(views), false);
    expect(d.warn).toBe(false);
    expect(line(d)).toBe('◦ 0.40/s walk past. More lanes before more guests.');
  });
});
