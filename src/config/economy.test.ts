import { describe, expect, it } from 'vitest';
import {
  AVERAGE_SPEND_MULTIPLIER,
  DOOR_MAX,
  GUEST_TYPES,
  MAX_LANES,
  MAX_STATION_LEVEL,
  STATION_DEFS,
  baseDrinkPrice,
  bottleneckOf,
  doorArrivalsPerSecond,
  doorUpgradeCost,
  incomePerSecond,
  isClubComplete,
  laneCost,
  starsAtOrBelow,
  startingProgress,
  stationCapacity,
  stationDef,
  stationUpgradeCost,
  totalCapacity,
  type ClubProgress,
} from './economy.ts';

/** Every station at L30 with 3 lanes and the Door at L8 — the §4.4 end state. */
function completeClub(): ClubProgress {
  return {
    doorLevel: DOOR_MAX,
    stations: STATION_DEFS.map((def) => ({
      key: def.key,
      unlocked: true,
      level: MAX_STATION_LEVEL,
      lanes: MAX_LANES,
    })),
  };
}

/**
 * These are not round numbers chosen for a test — they are the figures DUB-4
 * verified against the §4.4 table and that the designer signed off. If one of
 * them moves, the economy has changed and the pacing table is no longer the one
 * that was approved. Re-run `npm run sim:economy` before changing an expectation
 * here.
 */
describe('§4.4 verified figures', () => {
  it('completes the club on 11,783/s with Regular guests only', () => {
    expect(Math.round(incomePerSecond(completeClub(), { spendMultiplier: 1 }))).toBe(11_783);
  });

  it('completes on 16,496/s with the real guest mix — DUB-4 option (a)', () => {
    expect(Math.round(incomePerSecond(completeClub()))).toBe(16_496);
  });

  it('prices the guest mix at exactly 1.40', () => {
    expect(AVERAGE_SPEND_MULTIPLIER).toBeCloseTo(1.4, 10);
    expect(GUEST_TYPES.reduce((sum, g) => sum + g.share, 0)).toBeCloseTo(1, 10);
  });

  it('starts the player one upgrade away from the second upgrade', () => {
    const tap = stationDef('tap');
    expect(baseDrinkPrice(tap, 1)).toBe(2);
    expect(stationUpgradeCost(tap, 1)).toBe(5);
    expect(doorUpgradeCost(1)).toBe(60);
  });

  it('leaves no dead buy at full build-out', () => {
    // §4.4 was tuned so the last lane is still worth buying: arrivals at Door L8
    // must exceed what every lane in the club can serve. If this inverts, the
    // final purchases become dead and the club-complete beat is hollow.
    expect(doorArrivalsPerSecond(DOOR_MAX)).toBeGreaterThan(totalCapacity(completeClub()));
  });
});

describe('star levels', () => {
  it('awards a ★ at 10, 20 and 30 and nowhere else', () => {
    expect(starsAtOrBelow(9)).toBe(0);
    expect(starsAtOrBelow(10)).toBe(1);
    expect(starsAtOrBelow(19)).toBe(1);
    expect(starsAtOrBelow(20)).toBe(2);
    expect(starsAtOrBelow(30)).toBe(3);
  });

  it('doubles the drink price on the ★ level itself', () => {
    const tap = stationDef('tap');
    // L9 -> L10 is one level of growth (x1.09) and one ★ (x2).
    expect(baseDrinkPrice(tap, 10)).toBeCloseTo(baseDrinkPrice(tap, 9) * 1.09 * 2, 10);
    // L10 -> L11 crosses no ★, so it is growth alone.
    expect(baseDrinkPrice(tap, 11)).toBeCloseTo(baseDrinkPrice(tap, 10) * 1.09, 10);
  });
});

/**
 * The throughput rule is the design. These tests exist specifically to fail if
 * someone "simplifies" the `min()` away, because that version of the game still
 * looks correct in a spreadsheet and is broken on the floor: the queue at the
 * door would stop meaning anything, and the queue is the entire tutorial.
 */
describe('the min() throughput rule', () => {
  it('is bound by lanes, not arrivals, on a fresh club', () => {
    const fresh = startingProgress();
    // Door L1 delivers 0.9 guests/s; one Tap Bar lane serves 1/2.0 = 0.5/s.
    expect(doorArrivalsPerSecond(fresh.doorLevel)).toBeCloseTo(0.9, 10);
    expect(totalCapacity(fresh)).toBeCloseTo(0.5, 10);

    // So income is 0.5 x £2, not 0.9 x £2. Dropping the min() would give 1.8.
    expect(incomePerSecond(fresh, { spendMultiplier: 1 })).toBeCloseTo(1.0, 10);
    expect(bottleneckOf(fresh)).toBe('capacity');
  });

  it('makes a lane worthless once arrivals are the constraint', () => {
    const withLanes = (lanes: number): ClubProgress => ({
      doorLevel: 1,
      stations: STATION_DEFS.map((def, i) => ({
        key: def.key,
        unlocked: i === 0,
        level: 1,
        lanes: i === 0 ? lanes : 0,
      })),
    });

    // Two lanes serve 1.0/s and three serve 1.5/s, but Door L1 only delivers
    // 0.9/s, so the third lane buys nothing. This is the "bartenders visibly
    // idle" state, and the player is meant to diagnose it by looking.
    const two = incomePerSecond(withLanes(2), { spendMultiplier: 1 });
    const three = incomePerSecond(withLanes(3), { spendMultiplier: 1 });
    expect(three).toBeCloseTo(two, 10);
    expect(three).toBeCloseTo(0.9 * 2, 10);
    expect(bottleneckOf(withLanes(3))).toBe('door');
  });

  it('routes guests to the dearest station first and overflows down', () => {
    // Tap and Cocktail open at L1 with one lane each: capacities 0.5 and 0.333.
    // Door L5 delivers 0.9 x 1.2^4 = 1.866/s, more than both together, so both
    // saturate and income is the sum of capacity x price.
    const progress: ClubProgress = {
      doorLevel: 5,
      stations: STATION_DEFS.map((def, i) => ({
        key: def.key,
        unlocked: i < 2,
        level: 1,
        lanes: i < 2 ? 1 : 0,
      })),
    };
    const tap = stationDef('tap');
    const cocktail = stationDef('cocktail');
    const expected =
      stationCapacity(tap, 1) * baseDrinkPrice(tap, 1) + stationCapacity(cocktail, 1) * baseDrinkPrice(cocktail, 1);
    expect(incomePerSecond(progress, { spendMultiplier: 1 })).toBeCloseTo(expected, 10);
  });

  it('serves the dearer station first and turns away the true overflow', () => {
    // Door L1 delivers 0.9/s. Cocktail (£18) takes 1/3 per second, leaving
    // 0.567/s of demand for the Tap Bar — but the Tap Bar's single lane only
    // serves 0.5/s, so 0.067 guests/s are turned away entirely.
    //
    // This is the case that catches a routing bug a simpler test would miss:
    // the overflow is clamped by the *receiving* station's capacity too, not
    // just by what the dearer station left behind. Income is 6 + 1 = 7/s, and
    // the 0.067/s that nobody can serve is what the player sees as a queue.
    const progress: ClubProgress = {
      doorLevel: 1,
      stations: STATION_DEFS.map((def, i) => ({
        key: def.key,
        unlocked: i < 2,
        level: 1,
        lanes: i < 2 ? 1 : 0,
      })),
    };

    const cocktailServed = 1 / 3;
    const tapServed = 0.5; // capacity-bound, below the 0.567 routed to it
    expect(tapServed).toBeLessThan(0.9 - cocktailServed);
    expect(incomePerSecond(progress, { spendMultiplier: 1 })).toBeCloseTo(cocktailServed * 18 + tapServed * 2, 10);
    expect(incomePerSecond(progress, { spendMultiplier: 1 })).toBeCloseTo(7, 10);
  });

  it('earns nothing from a station with no lanes', () => {
    const progress: ClubProgress = {
      doorLevel: 3,
      stations: STATION_DEFS.map((def) => ({ key: def.key, unlocked: true, level: 10, lanes: 0 })),
    };
    expect(incomePerSecond(progress)).toBe(0);
  });
});

describe('lane and door tables', () => {
  it('prices lane 1 free and keeps the 8x lane-2 to lane-3 step', () => {
    for (const def of STATION_DEFS) {
      expect(laneCost(def, 1)).toBe(0);
      expect(laneCost(def, 3)).toBe(laneCost(def, 2) * 8);
    }
  });

  it('rejects a lane the design does not have', () => {
    expect(() => laneCost(stationDef('tap'), 4)).toThrow();
    expect(() => laneCost(stationDef('tap'), 0)).toThrow();
  });

  it('rejects an unknown station rather than returning undefined', () => {
    // @ts-expect-error — the point is the runtime guard, not the type.
    expect(() => stationDef('rooftop')).toThrow();
  });
});

describe('club completion', () => {
  it('is false until the last lane and the last Door level are bought', () => {
    expect(isClubComplete(startingProgress())).toBe(false);

    const nearly = completeClub();
    expect(isClubComplete({ ...nearly, doorLevel: DOOR_MAX - 1 })).toBe(false);
    expect(
      isClubComplete({
        ...nearly,
        stations: nearly.stations.map((st, i) => (i === 2 ? { ...st, lanes: MAX_LANES - 1 } : st)),
      }),
    ).toBe(false);
  });

  it('is true at full build-out', () => {
    expect(isClubComplete(completeClub())).toBe(true);
  });
});
