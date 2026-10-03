import { describe, expect, it } from 'vitest';
import {
  BUBBLE_SPAWN_INTERVAL_SECONDS,
  LAST_CALL_DECAY_PER_SECOND,
  LAST_CALL_DURATION_SECONDS,
  LAST_CALL_GAIN_PER_BUBBLE,
  LAST_CALL_MULTIPLIER,
  MAX_BUBBLES_ON_SCREEN,
  MAX_LANES,
  MAX_STATION_LEVEL,
  STARTING_CASH,
  DOOR_MAX,
} from '../config/economy.ts';
import { TICKS_PER_SECOND } from './constants.ts';
import {
  buyLane,
  cheapestPurchase,
  collectBubble,
  createClubState,
  creditCash,
  currentMultiplier,
  restoreClub,
  snapshotClub,
  spawnBubble,
  stationStateOf,
  takePendingStar,
  tickClub,
  unlockStation,
  upgradeDoor,
  upgradeStation,
  type ClubState,
} from './clubState.ts';

/** Run `seconds` of simulated time. */
function run(club: ClubState, seconds: number): void {
  const ticks = Math.round(seconds * TICKS_PER_SECOND);
  for (let i = 0; i < ticks; i += 1) tickClub(club);
}

/** Give the club money without routing it through a purchase or a tick. */
function fund(club: ClubState, amount: number): void {
  creditCash(club, amount);
}

describe('a fresh club', () => {
  it('starts with the Tap Bar open, one lane, and nothing else', () => {
    const club = createClubState();

    expect(club.cash).toBe(STARTING_CASH);
    expect(club.doorLevel).toBe(1);
    expect(stationStateOf(club, 'tap')).toMatchObject({ unlocked: true, level: 1, lanes: 1 });
    expect(stationStateOf(club, 'cocktail').unlocked).toBe(false);
    expect(stationStateOf(club, 'booth').unlocked).toBe(false);
  });

  it('affords a burst of upgrades at t = 0, then runs out', () => {
    // The hook depends on this. "0-60 s is almost pure tapping (~15 upgrades
    // in minute one)" only works if the player can buy several before waiting
    // for any income at all: 30 starting cash against 5, 6.05, 7.32, 8.86
    // buys four taps immediately and stops at the fifth.
    const club = createClubState();

    let bought = 0;
    while (upgradeStation(club, 'tap') === 'bought') bought += 1;

    expect(bought).toBe(4);
    expect(upgradeStation(club, 'tap')).toBe('too-expensive');
  });

  it('is already earning, so the counter moves before the player does', () => {
    const club = createClubState();
    expect(club.derived.baseIncomePerSecond).toBeGreaterThan(0);
  });
});

describe('the tick', () => {
  it('credits income at the base rate', () => {
    const club = createClubState();
    const rate = club.derived.baseIncomePerSecond;

    run(club, 10);

    expect(club.cash).toBeCloseTo(STARTING_CASH + rate * 10, 6);
  });

  it('is frame-rate independent — only the tick count matters', () => {
    // The same property `FixedStepLoop` protects, asserted at the level that
    // actually pays out money.
    const a = createClubState();
    const b = createClubState();

    for (let i = 0; i < 100; i += 1) tickClub(a);
    run(b, 10);

    expect(b.cash).toBeCloseTo(a.cash, 10);
  });

  it('tracks lifetime earnings separately from cash', () => {
    const club = createClubState();
    run(club, 30);

    const earned = club.totalEarned;
    const cash = club.cash;
    const price = 5;

    expect(upgradeStation(club, 'tap')).toBe('bought');

    // Spending moves cash and must not touch what was earned — the
    // club-complete stats are a record of the run, not a balance.
    expect(club.cash).toBeCloseTo(cash - price, 6);
    expect(club.totalEarned).toBe(earned);
  });

  it('does not count the starting cash as earned', () => {
    // 30 cash the player did not earn. `restoreClub` used to clamp
    // `totalEarned` up to `cash`, which rewrote the stat on every reload for
    // as long as the two were in this order.
    const club = createClubState();
    expect(club.totalEarned).toBe(0);
    expect(club.cash).toBe(STARTING_CASH);

    run(club, 10);
    expect(club.totalEarned).toBeLessThan(club.cash);
    expect(restoreClub(snapshotClub(club)).totalEarned).toBeCloseTo(club.totalEarned, 6);
  });
});

describe('purchases', () => {
  it('raises income when a level is bought', () => {
    const club = createClubState();
    const before = club.derived.baseIncomePerSecond;

    upgradeStation(club, 'tap');

    expect(club.derived.baseIncomePerSecond).toBeGreaterThan(before);
  });

  it('refuses a purchase it cannot afford and leaves the club untouched', () => {
    const club = createClubState();
    const snapshot = snapshotClub(club);

    expect(buyLane(club, 'tap')).toBe('too-expensive');

    expect(snapshotClub(club)).toEqual(snapshot);
  });

  it('gives a newly unlocked station its free first lane', () => {
    // A station with zero lanes serves nobody and would read as a bug.
    const club = createClubState();
    fund(club, 1_000);

    expect(unlockStation(club, 'cocktail')).toBe('bought');
    expect(stationStateOf(club, 'cocktail').lanes).toBe(1);
    expect(club.derived.flow.stations.some((f) => f.key === 'cocktail')).toBe(true);
  });

  it('stops at the level, lane and door ceilings', () => {
    const club = createClubState();
    fund(club, 1e12);

    for (let i = 0; i < 100; i += 1) upgradeStation(club, 'tap');
    for (let i = 0; i < 100; i += 1) buyLane(club, 'tap');
    for (let i = 0; i < 100; i += 1) upgradeDoor(club);

    expect(stationStateOf(club, 'tap').level).toBe(MAX_STATION_LEVEL);
    expect(stationStateOf(club, 'tap').lanes).toBe(MAX_LANES);
    expect(club.doorLevel).toBe(DOOR_MAX);
    expect(upgradeStation(club, 'tap')).toBe('not-available');
    expect(buyLane(club, 'tap')).toBe('not-available');
    expect(upgradeDoor(club)).toBe('not-available');
  });

  it('queues exactly one ★ celebration per star level', () => {
    const club = createClubState();
    fund(club, 1e9);

    const stars: number[] = [];
    for (let level = 1; level < MAX_STATION_LEVEL; level += 1) {
      upgradeStation(club, 'tap');
      const star = takePendingStar(club);
      if (star !== null) stars.push(star.level);
    }

    expect(stars).toEqual([10, 20, 30]);
  });

  it('reports club complete only at full build-out', () => {
    const club = createClubState();
    fund(club, 1e12);

    for (const key of ['tap', 'cocktail', 'booth'] as const) {
      unlockStation(club, key);
      for (let i = 0; i < 40; i += 1) upgradeStation(club, key);
      for (let i = 0; i < 4; i += 1) buyLane(club, key);
    }
    expect(club.derived.complete).toBe(false);

    for (let i = 0; i < 10; i += 1) upgradeDoor(club);

    expect(club.derived.complete).toBe(true);
    expect(cheapestPurchase(club)).toBeNull();
  });
});

describe('the next purchase (§4.4b)', () => {
  it('is the cheapest thing available, so the outline fill tracks what comes first', () => {
    const club = createClubState();
    const next = cheapestPurchase(club);

    expect(next).not.toBeNull();
    for (const alternative of [5, 60, 400, 900]) {
      expect(next!.cost).toBeLessThanOrEqual(alternative);
    }
  });

  it('becomes null at full build-out rather than reporting a phantom purchase', () => {
    const club = createClubState();
    fund(club, 1e12);
    for (const key of ['tap', 'cocktail', 'booth'] as const) {
      unlockStation(club, key);
      for (let i = 0; i < 40; i += 1) upgradeStation(club, key);
      for (let i = 0; i < 4; i += 1) buyLane(club, key);
    }
    for (let i = 0; i < 10; i += 1) upgradeDoor(club);

    expect(club.derived.nextPurchase).toBeNull();
  });
});

describe('cash bubbles', () => {
  it('spawns on the exact tick the interval lands on', () => {
    // Pins the float-drift bug this used to have: eight accumulated
    // TICK_SECONDS sum to 0.7999999999999999, so a `>= 0.8` comparison on a
    // running float missed its tick every single time and the spawner ran one
    // tick late for the whole session. The counter is integer ticks now.
    const club = createClubState();
    const ticks = Math.round(BUBBLE_SPAWN_INTERVAL_SECONDS * TICKS_PER_SECOND);

    for (let i = 0; i < ticks - 1; i += 1) tickClub(club);
    expect(activeBubbles(club)).toBe(0);

    tickClub(club);
    expect(activeBubbles(club)).toBe(1);
  });

  it('caps at three on screen, and uncollected bubbles block the next spawn', () => {
    const club = createClubState();

    // Long enough to have produced many more than three if nothing blocked.
    run(club, 60);

    expect(activeBubbles(club)).toBe(MAX_BUBBLES_ON_SCREEN);
  });

  it('refills as fast as the player clears it, but no faster than the interval', () => {
    const club = createClubState();
    run(club, 60);
    expect(activeBubbles(club)).toBe(3);

    collectBubble(club, 0);
    expect(activeBubbles(club)).toBe(2);

    // A freed slot refills on the next tick — the floor keeps up with a fast
    // tapper — but the spawner still cannot exceed one per interval.
    tickClub(club);
    expect(activeBubbles(club)).toBe(3);

    // Two more cleared, but the counter was just reset by that spawn, so the
    // floor does not instantly refill — the rate limit is what stops a fast
    // tapper from turning three slots into an unbounded stream.
    collectBubble(club, 0);
    collectBubble(club, 1);
    tickClub(club);
    expect(activeBubbles(club)).toBe(1);

    run(club, BUBBLE_SPAWN_INTERVAL_SECONDS);
    expect(activeBubbles(club)).toBe(2);
  });

  it('pays out and cannot be collected twice', () => {
    const club = createClubState();
    run(club, 1);
    const before = club.cash;

    const first = collectBubble(club, 0);
    expect(first.collected).toBe(true);
    expect(first.value).toBeGreaterThan(0);
    expect(club.cash).toBeCloseTo(before + first.value, 6);

    const second = collectBubble(club, 0);
    expect(second.collected).toBe(false);
    expect(second.value).toBe(0);
  });

  it('prices a VIP tip at six times a Regular one', () => {
    const club = createClubState();
    club.bubbles[0] = { ...club.bubbles[0]!, active: true, value: 10, vip: false };
    club.bubbles[1] = { ...club.bubbles[1]!, active: true, value: 60, vip: true };

    const regular = collectBubble(club, 0);
    const vip = collectBubble(club, 1);

    expect(vip.value / regular.value).toBeCloseTo(6, 6);
    expect(vip.vip).toBe(true);
  });

  it('dismisses the one-time bubble hint when a bubble is tapped', () => {
    const club = createClubState();
    expect(club.hintBubblePending).toBe(true);

    run(club, 1);
    collectBubble(club, 0);

    expect(club.hintBubblePending).toBe(false);
  });
});

describe('Last Call (§4.5)', () => {
  it('fires automatically at 100% and resets the meter', () => {
    const club = createClubState();
    const needed = Math.ceil(1 / LAST_CALL_GAIN_PER_BUBBLE);

    let fired = false;
    for (let i = 0; i < needed; i += 1) {
      // Refill a slot by hand so the test measures the meter, not the spawner.
      club.bubbles[0]!.active = true;
      club.bubbles[0]!.value = 1;
      club.bubbles[0]!.vip = false;
      const result = collectBubble(club, 0);
      if (result.firedLastCall) fired = true;
    }

    expect(fired).toBe(true);
    expect(club.lastCallMeter).toBe(0);
    expect(club.lastCallRemaining).toBe(LAST_CALL_DURATION_SECONDS);
    expect(club.lastCallFiredCount).toBe(1);
  });

  it('needs ~25 bubbles, which is the §4.5 figure the spawn rate was set from', () => {
    expect(Math.ceil(1 / LAST_CALL_GAIN_PER_BUBBLE)).toBe(25);
    // 25 bubbles at the spawn interval is the "~20 s" the brief specifies.
    expect(25 * BUBBLE_SPAWN_INTERVAL_SECONDS).toBeCloseTo(20, 6);
  });

  it('multiplies income by three while firing, and only while firing', () => {
    const club = createClubState();
    const rate = club.derived.baseIncomePerSecond;

    club.lastCallRemaining = LAST_CALL_DURATION_SECONDS;
    expect(currentMultiplier(club)).toBe(LAST_CALL_MULTIPLIER);

    const start = club.cash;
    run(club, 10);
    expect(club.cash - start).toBeCloseTo(rate * LAST_CALL_MULTIPLIER * 10, 6);

    // Run past the end of the buff and the rate returns to base.
    run(club, LAST_CALL_DURATION_SECONDS);
    expect(club.lastCallRemaining).toBe(0);
    expect(currentMultiplier(club)).toBe(1);

    const after = club.cash;
    run(club, 10);
    expect(club.cash - after).toBeCloseTo(rate * 10, 6);
  });

  it('decays while the player is not tapping, and never below zero', () => {
    const club = createClubState();
    club.lastCallMeter = 0.5;

    run(club, 10);
    expect(club.lastCallMeter).toBeCloseTo(0.5 - LAST_CALL_DECAY_PER_SECOND * 10, 6);

    run(club, 600);
    expect(club.lastCallMeter).toBe(0);
  });

  it('has no cooldown beyond refilling the meter', () => {
    const club = createClubState();
    club.lastCallRemaining = LAST_CALL_DURATION_SECONDS;
    club.lastCallMeter = 1 - LAST_CALL_GAIN_PER_BUBBLE;

    club.bubbles[0]!.active = true;
    club.bubbles[0]!.value = 1;
    const result = collectBubble(club, 0);

    // Fires again while already firing — the meter is the only gate.
    expect(result.firedLastCall).toBe(true);
    expect(club.lastCallFiredCount).toBe(1);
    expect(club.lastCallRemaining).toBe(LAST_CALL_DURATION_SECONDS);
  });
});

describe('restore', () => {
  it('round-trips a played club through its snapshot', () => {
    const club = createClubState();
    fund(club, 50_000);
    upgradeStation(club, 'tap');
    upgradeStation(club, 'tap');
    buyLane(club, 'tap');
    unlockStation(club, 'cocktail');
    upgradeDoor(club);

    const restored = restoreClub(snapshotClub(club));

    expect(snapshotClub(restored)).toEqual(snapshotClub(club));
    expect(restored.derived.baseIncomePerSecond).toBeCloseTo(club.derived.baseIncomePerSecond, 10);
  });

  it('does not restore Last Call as firing', () => {
    // A x3 buff that survives a reload is a buff you can bank.
    const club = createClubState();
    club.lastCallRemaining = LAST_CALL_DURATION_SECONDS;
    club.lastCallMeter = 0.6;

    const restored = restoreClub(snapshotClub(club));

    expect(restored.lastCallRemaining).toBe(0);
    expect(restored.lastCallMeter).toBeCloseTo(0.6, 6);
  });

  it.each([
    ['a hand-edited string level', 'max'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative level', -5],
    ['beyond the ceiling', 999],
  ])('clamps %s rather than producing NaN income', (_label, level) => {
    // `localStorage` is player-writable and the brief forbids anti-cheat. The
    // point of clamping is not to stop cheating, it is that an out-of-range
    // level reaching `baseDrinkPrice` makes every later tick NaN — a crash,
    // not an advantage.
    const snapshot = snapshotClub(createClubState());
    const tampered = {
      ...snapshot,
      stations: snapshot.stations.map((st) =>
        st.key === 'tap' ? { ...st, level: level as unknown as number } : st,
      ),
    };

    const restored = restoreClub(tampered);

    expect(Number.isFinite(restored.derived.baseIncomePerSecond)).toBe(true);
    expect(restored.derived.baseIncomePerSecond).toBeGreaterThan(0);

    run(restored, 5);
    expect(Number.isFinite(restored.cash)).toBe(true);
  });

  it('repairs a save claiming the Tap Bar is locked', () => {
    // The Tap Bar is open at t = 0 by definition. A club that cannot earn is a
    // club that can never be repaired by playing it.
    const snapshot = snapshotClub(createClubState());
    const broken = {
      ...snapshot,
      stations: snapshot.stations.map((st) =>
        st.key === 'tap' ? { ...st, unlocked: false, lanes: 0 } : st,
      ),
    };

    const restored = restoreClub(broken);

    expect(stationStateOf(restored, 'tap').unlocked).toBe(true);
    expect(stationStateOf(restored, 'tap').lanes).toBeGreaterThanOrEqual(1);
    expect(restored.derived.baseIncomePerSecond).toBeGreaterThan(0);
  });

  it('never restores negative cash', () => {
    const snapshot = { ...snapshotClub(createClubState()), cash: -1_000 };
    expect(restoreClub(snapshot).cash).toBe(0);
  });
});

describe('the hot path', () => {
  it('does not reallocate the bubble pool when bubbles come and go', () => {
    // The pool is the only thing a tick touches that could grow, and growing
    // it mid-session is exactly the GC stutter the architecture exists to
    // avoid.
    const club = createClubState();
    const pool = club.bubbles;
    const slots = club.bubbles.map((b) => b);

    run(club, 30);
    for (let i = 0; i < MAX_BUBBLES_ON_SCREEN; i += 1) collectBubble(club, i);
    run(club, 30);

    expect(club.bubbles).toBe(pool);
    expect(club.bubbles).toHaveLength(MAX_BUBBLES_ON_SCREEN);
    club.bubbles.forEach((slot, i) => expect(slot).toBe(slots[i]));
  });

  it('does not recompute derived state on a tick', () => {
    // Income depends only on purchases. If a tick replaced `derived`, the
    // allocation-free guarantee would be gone and `computeFlow` would be
    // running ten times a second.
    const club = createClubState();
    const derived = club.derived;

    run(club, 60);
    expect(club.derived).toBe(derived);

    upgradeStation(club, 'tap');
    expect(club.derived).not.toBe(derived);
  });

  it('spawns without allocating a new slot object', () => {
    const club = createClubState();
    const slot = club.bubbles[0];

    expect(spawnBubble(club)).toBe(true);
    expect(club.bubbles[0]).toBe(slot);
    expect(club.bubbles[0]!.serial).toBe(1);
  });
});

function activeBubbles(club: ClubState): number {
  return club.bubbles.filter((b) => b.active).length;
}
