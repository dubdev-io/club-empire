import { describe, expect, it } from 'vitest';
import {
  DOOR_MAX,
  MAX_LANES,
  MAX_STATION_LEVEL,
  QUEUE_WARNING_SHARE,
  laneCost,
  stationDef,
} from '../config/economy.ts';
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

  /** Door Lv 5 with one tap lane and one cocktail lane: 1.03/s of 1.87/s. */
  const SEVERE = [1.033, 1.866] as const;
  /** The fresh club: 0.40/s of 0.90/s is 44%, a real queue and not an alarm. */
  const MILD = [0.4, 0.9] as const;
  /** Three bars at Door Lv 1: saturated stations, nobody turned away. */
  const NO_QUEUE = [0, 0.9] as const;

  it('says nothing when the station is neither queueing nor idling', () => {
    expect(stationDiagnosis(view({ idleLanes: 0.2 }), ...SEVERE, false)).toBeNull();
  });

  // Tier A. The only line that earns amber, and the only one that kept its
  // string: when it was true it was already right.
  it('warns — and advises a lane — once the club is losing most of the door', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: 120 }), ...SEVERE, false);

    expect(d?.warn).toBe(true);
    expect(line(d!)).toBe('⚠ Queue — every lane is busy. Add a lane.');
  });

  // Tier B. DUB-24: this is the state the old rule shouted in at second zero,
  // over a £400 lane the player could not buy, with a £5 upgrade beside it.
  it('gives the same advice without the alarm below the warning share', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: 120 }), ...MILD, false);

    expect(d?.warn).toBe(false);
    expect(d?.glyph).not.toBe('⚠');
    expect(line(d!)).toBe('◦ Every lane is busy. Another lane serves more.');
  });

  // Tier C. The one that made the old line *false*: routing is price-ordered,
  // so a station sits at capacity while the club turns away nobody. The word
  // "Queue" must not appear, and the lever named is the Door — the same
  // instruction the idle cards give, so the sheet agrees with itself.
  it('points at the Door, not a lane, when nobody is queueing', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: 140_000 }), ...NO_QUEUE, false);

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — every lane is pouring. Raise the Door.');
    expect(d?.body).not.toMatch(/Queue/i);
    expect(d?.lead).not.toMatch(/Queue/i);
  });

  // Tier C'. "Raise the Door" is dead advice at Door Lv 8, so it falls back to
  // the string the all-lanes-bought tier already uses.
  it('points at levels instead once the Door is maxed', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: 140_000 }), ...NO_QUEUE, true);

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — every lane is pouring. Levels are what pay now.');
  });

  it('turns amber exactly at the threshold the other three surfaces use', () => {
    // Pinned on the constant, not on 0.5, so retuning the economy moves the
    // HUD banner, the DOOR badge, the Door sheet and this sheet together.
    const arrivals = 2;
    const at = stationDiagnosis(
      view({ saturated: true }),
      arrivals * QUEUE_WARNING_SHARE,
      arrivals,
      false,
    );
    const under = stationDiagnosis(
      view({ saturated: true }),
      arrivals * QUEUE_WARNING_SHARE - 0.01,
      arrivals,
      false,
    );

    expect(at?.warn).toBe(true);
    expect(under?.warn).toBe(false);
  });

  it('divides by no zero when the club has no arrivals at all', () => {
    // The same guard `doorDiagnosis` and `BottomBar` carry. A club with no
    // arrivals is turning nobody away, so it belongs in the no-queue tier —
    // and whatever it says, it must not be NaN and must not be amber.
    for (const doorMaxed of [false, true]) {
      const d = stationDiagnosis(view({ saturated: true, laneCost: 120 }), 0, 0, doorMaxed);

      expect(d?.warn).toBe(false);
      expect(d?.glyph).toBe('◦');
      expect(d?.lead).toBe('Full house');
      expect(line(d!)).not.toMatch(/NaN/);
    }

    // And if a residual somehow outlives the arrivals, the share is 0, not
    // Infinity — so it is the neutral tier, never the alarm.
    const residual = stationDiagnosis(view({ saturated: true, laneCost: 120 }), 0.4, 0, false);
    expect(residual?.warn).toBe(false);
  });

  // Item E. The warning used to fire here, one row above a button reading
  // "3 LANES", on all three cards at once behind the CLUB COMPLETE card.
  it('states the fact without an imperative once every lane is bought', () => {
    const d = stationDiagnosis(view({ saturated: true, laneCost: null }), ...SEVERE, false);

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — every lane is pouring. Levels are what pay now.');
  });

  it('names no lever at all when the level axis is finished too', () => {
    const d = stationDiagnosis(
      view({ saturated: true, laneCost: null, maxed: true }),
      ...SEVERE,
      false,
    );

    expect(d?.warn).toBe(false);
    expect(line(d!)).toBe('◦ Full house — this bar is as big as it gets.');
  });

  it('never shows ⚠ when no lane is purchasable, maxed or not, at any share', () => {
    for (const maxed of [false, true]) {
      for (const [turnedAway, arrivals] of [SEVERE, MILD, NO_QUEUE, [3.2, 3.225]] as const) {
        const d = stationDiagnosis(
          view({ saturated: true, laneCost: null, maxed }),
          turnedAway,
          arrivals,
          false,
        );
        expect(d?.warn).toBe(false);
        expect(d?.glyph).not.toBe('⚠');
      }
    }
  });

  it('never shows ⚠ below the warning share, however big the raw rate', () => {
    // The old rule had no magnitude in it at all, so a saturated lane read the
    // same at 0% as at 84%. Volume follows the door's share, never the
    // station's own saturation and never the raw rate.
    for (const rate of [0, 0.002, 0.058, 0.5, 3.2, 40]) {
      const arrivals = rate === 0 ? 0.9 : rate / (QUEUE_WARNING_SHARE / 2);
      const d = stationDiagnosis(view({ saturated: true, laneCost: 120 }), rate, arrivals, false);
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
      const d = stationDiagnosis(view({ idleLanes }), ...SEVERE, false);
      expect(d?.body).toBe(`${expected} idle — raise the Door, not the lanes.`);
    }
  });

  it('keeps every line inside the two-line box at 390 px', () => {
    // Same 64-character budget the Door lines are held to.
    for (const [over, turnedAway, arrivals, doorMaxed] of [
      [{ saturated: true, laneCost: 120 }, ...SEVERE, false],
      [{ saturated: true, laneCost: 120 }, ...MILD, false],
      [{ saturated: true, laneCost: 120 }, ...NO_QUEUE, false],
      [{ saturated: true, laneCost: 120 }, ...NO_QUEUE, true],
      [{ saturated: true, laneCost: null }, ...SEVERE, false],
      [{ saturated: true, laneCost: null, maxed: true }, ...SEVERE, false],
      [{ idleLanes: 2 }, ...SEVERE, false],
    ] as const) {
      const d = stationDiagnosis(view(over), turnedAway, arrivals, doorMaxed);
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

/**
 * The whole Bars sheet, driven through the real club (DUB-24).
 *
 * The per-tier tests above fix the copy; these fix the *states*, because the
 * bug was never in the strings — it was in which state each string reached.
 * Stubs cannot catch that: the defect was a station saturating while the club
 * turned nobody away, and whether that is even possible is a fact about
 * `computeFlow`'s price-ordered routing, not about a fixture. So every row here
 * comes from `createClubState()` and the flow the floor renders.
 */
describe('the Bars sheet against the real club', () => {
  /**
   * The slice of `StationView` the diagnosis reads, built the way
   * `runtime.ts#publishStructure` builds it. If that mapping ever drifts, this
   * is the test that should fail.
   */
  function stationViews(club: ClubState) {
    return club.stations.map((st) => {
      const def = stationDef(st.key);
      const flow = club.derived.flow.stations.find((f) => f.key === st.key);
      return {
        key: st.key,
        unlocked: st.unlocked,
        saturated: flow?.saturated ?? false,
        idleLanes: flow?.idleLanes ?? 0,
        laneCost: st.unlocked && st.lanes < MAX_LANES ? laneCost(def, st.lanes + 1) : null,
        maxed: st.unlocked && st.level >= MAX_STATION_LEVEL,
        servedPerSecond: flow?.servedPerSecond ?? 0,
        capacityPerSecond: flow?.capacityPerSecond ?? 0,
      };
    });
  }

  /** Every line the sheet would render, in row order. A locked row has none. */
  function sheetLines(club: ClubState): string[] {
    const { turnedAwayPerSecond, arrivalsPerSecond } = club.derived.flow;
    const doorMaxed = club.doorLevel >= DOOR_MAX;

    return stationViews(club)
      .filter((v) => v.unlocked)
      .map((v) => {
        const d = stationDiagnosis(v, turnedAwayPerSecond, arrivalsPerSecond, doorMaxed);
        return d === null ? '' : line(d);
      })
      .filter((s) => s !== '');
  }

  /** Is the HUD banner up? `Hud.tsx` and `BottomBar.tsx` both compute this. */
  function hudIsAmber(club: ClubState): boolean {
    const { turnedAwayPerSecond, arrivalsPerSecond } = club.derived.flow;
    const share = arrivalsPerSecond > 0 ? turnedAwayPerSecond / arrivalsPerSecond : 0;
    return share >= QUEUE_WARNING_SHARE;
  }

  /** Buy out one station's lanes, and take its level to `level`. */
  function build(club: ClubState, key: 'tap' | 'cocktail' | 'booth', level: number): void {
    while (stationStateOf(club, key).lanes < MAX_LANES) {
      creditCash(club, 1e9);
      if (buyLane(club, key) !== 'bought') break;
    }
    while (stationStateOf(club, key).level < level) {
      creditCash(club, 1e9);
      if (upgradeStation(club, key) !== 'bought') break;
    }
  }

  // Criterion 1. The state a first-time player opens the sheet in.
  it('is calm at second zero, with the one amber colour on screen unused', () => {
    const club = createClubState();

    expect(club.derived.flow.arrivalsPerSecond).toBeCloseTo(0.9, 3);
    expect(club.derived.flow.turnedAwayPerSecond).toBeCloseTo(0.4, 3);
    expect(hudIsAmber(club)).toBe(false);

    // One unlocked station, saturated, with a £400 lane the player cannot
    // afford on £30 — which is exactly why this must not be an alarm.
    expect(sheetLines(club)).toEqual(['◦ Every lane is busy. Another lane serves more.']);
    expect(sheetLines(club).some((l) => l.includes('⚠'))).toBe(false);
  });

  // Criterion 2. The state that proved the old line was *false*, not just
  // early: Booth Service at capacity with `turnedAwayPerSecond = 0.000/s`.
  it('agrees with the idle cards when a station saturates with no queue', () => {
    const club = createClubState();
    creditCash(club, 1e9);
    unlockStation(club, 'cocktail');
    unlockStation(club, 'booth');
    build(club, 'tap', 1);
    build(club, 'cocktail', 1);

    // The routing fact the whole ticket rests on: Booth is the highest price,
    // so it is served first and saturates, while four idle lanes below it
    // absorb the overflow and nobody is turned away.
    const views = stationViews(club);
    const booth = views.find((v) => v.key === 'booth')!;
    expect(booth.saturated).toBe(true);
    expect(booth.laneCost).toBe(140_000);
    expect(club.derived.flow.turnedAwayPerSecond).toBeCloseTo(0, 6);

    const lines = sheetLines(club);
    expect(lines).toEqual([
      '◦ 3 lanes idle — raise the Door, not the lanes.',
      '◦ 1 lane idle — raise the Door, not the lanes.',
      '◦ Full house — every lane is pouring. Raise the Door.',
    ]);

    // Nobody is queueing, so the word must not be on the sheet — and all three
    // cards now name the same lever instead of contradicting each other.
    expect(lines.join(' ')).not.toMatch(/Queue/i);
    expect(lines.every((l) => l.includes('Door'))).toBe(true);
    expect(lines.some((l) => l.includes('⚠'))).toBe(false);
  });

  // Criteria 3 and 4. The state the alarm is *for*, and the agreement check.
  it('shouts only when the HUD shouts, in the same frame', () => {
    const club = createClubState();
    creditCash(club, 1e9);
    unlockStation(club, 'cocktail');
    while (club.doorLevel < 5) {
      creditCash(club, 1e9);
      if (upgradeDoor(club) !== 'bought') break;
    }

    // 1.03/s of 1.87/s is 55%: the club really is losing most of the door.
    expect(club.derived.flow.arrivalsPerSecond).toBeCloseTo(1.866, 3);
    expect(club.derived.flow.turnedAwayPerSecond).toBeCloseTo(1.033, 3);
    expect(hudIsAmber(club)).toBe(true);

    const lines = sheetLines(club);
    expect(lines).toEqual([
      '⚠ Queue — every lane is busy. Add a lane.',
      '⚠ Queue — every lane is busy. Add a lane.',
    ]);

    // The Door sheet is amber in the same frame, off the same constant.
    const door = doorDiagnosis(
      club.derived.flow.turnedAwayPerSecond,
      club.derived.flow.arrivalsPerSecond,
      canAddLanes(stationViews(club).map((v) => station(v.laneCost, v.unlocked ? null : 1))),
      club.derived.complete,
    );
    expect(door.warn).toBe(true);
  });

  // Criterion 4, as a rule rather than as one frame: walk the whole run and
  // assert the three surfaces never disagree about volume.
  it('never disagrees with the HUD or the Door sheet at any point in a run', () => {
    const club = createClubState();
    creditCash(club, 1e9);
    let checked = 0;

    for (const step of [
      () => unlockStation(club, 'cocktail'),
      () => upgradeDoor(club),
      () => buyLane(club, 'tap'),
      () => upgradeDoor(club),
      () => unlockStation(club, 'booth'),
      () => upgradeDoor(club),
      () => buyLane(club, 'cocktail'),
      () => upgradeDoor(club),
      () => buyLane(club, 'tap'),
      () => upgradeDoor(club),
      () => buyLane(club, 'booth'),
      () => upgradeDoor(club),
      () => buyLane(club, 'cocktail'),
      () => buyLane(club, 'booth'),
    ]) {
      creditCash(club, 1e9);
      step();

      const amberOnBars = sheetLines(club).some((l) => l.includes('⚠'));
      const views = stationViews(club);
      const door = doorDiagnosis(
        club.derived.flow.turnedAwayPerSecond,
        club.derived.flow.arrivalsPerSecond,
        canAddLanes(views.map((v) => station(v.laneCost, v.unlocked ? null : 1))),
        club.derived.complete,
      );

      // The Bars sheet carries one extra gate the Door does not — a station
      // must be saturated with a lane to buy — so it may stay quiet while the
      // Door shouts. It must never be the louder of the two.
      if (amberOnBars) {
        expect(hudIsAmber(club)).toBe(true);
        expect(door.warn).toBe(true);
      }
      checked += 1;
    }

    expect(checked).toBe(14);
  });

  // Criterion 5. Every lane bought, 23 station levels still to buy.
  it('does not regress the dead end mid-run', () => {
    const club = createClubState();
    creditCash(club, 1e9);
    unlockStation(club, 'cocktail');
    unlockStation(club, 'booth');
    for (const key of ['tap', 'cocktail', 'booth'] as const) build(club, key, 7);
    while (club.doorLevel < DOOR_MAX) {
      creditCash(club, 1e9);
      if (upgradeDoor(club) !== 'bought') break;
    }

    expect(club.derived.complete).toBe(false);
    expect(sheetLines(club)).toEqual([
      '◦ Full house — every lane is pouring. Levels are what pay now.',
      '◦ Full house — every lane is pouring. Levels are what pay now.',
      '◦ Full house — every lane is pouring. Levels are what pay now.',
    ]);
  });

  // Criterion 6. Nothing amber behind the CLUB COMPLETE card.
  it('does not regress full build-out', () => {
    const club = createClubState();
    creditCash(club, 1e9);
    unlockStation(club, 'cocktail');
    unlockStation(club, 'booth');
    for (const key of ['tap', 'cocktail', 'booth'] as const) build(club, key, MAX_STATION_LEVEL);
    while (club.doorLevel < DOOR_MAX) {
      creditCash(club, 1e9);
      if (upgradeDoor(club) !== 'bought') break;
    }

    expect(club.derived.complete).toBe(true);
    expect(sheetLines(club)).toEqual([
      '◦ Full house — this bar is as big as it gets.',
      '◦ Full house — this bar is as big as it gets.',
      '◦ Full house — this bar is as big as it gets.',
    ]);
  });
});
