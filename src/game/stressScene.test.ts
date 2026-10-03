/**
 * The C1 certification scene has to be the same scene twice.
 *
 * DUB-6's criterion C1 is "25 guests, 9 bartenders and 3 queues on screen",
 * and the whole value of `?debug=1&stress=1` is that the owner's reading and
 * QA's reading are taken against *that* floor rather than two similar ones. So
 * the counts are asserted here rather than eyeballed on a phone.
 *
 * What this cannot cover: the sprites. `ClubScene` needs a WebGL context and
 * vitest runs on the node environment, so the two halves are tested where they
 * live — the club state and the crowd arithmetic here, and the fact that the
 * scene honours the pin is a three-line path in `syncProgress` that is checked
 * by reading the overlay's `guests_rendered` on the device. That seam is called
 * out in the README so it is a known gap rather than an assumed pass.
 */

import { describe, expect, it } from 'vitest';
import {
  DOOR_MAX,
  MAX_LANES,
  MAX_RENDERED_GUESTS,
  MAX_STATION_LEVEL,
  STATION_DEFS,
} from '../config/economy.ts';
import { snapshotClub, tickClub } from '../sim/clubState.ts';
import {
  STRESS_BARTENDERS,
  STRESS_CROWD,
  STRESS_GUESTS,
  STRESS_QUEUES,
  createStressClub,
  stressCrowdTotals,
} from './stressScene.ts';

describe('the stress scene club', () => {
  it('owns nine serving lanes — one bartender each', () => {
    const club = createStressClub();
    const lanes = club.stations.reduce((sum, st) => sum + st.lanes, 0);

    expect(lanes).toBe(STRESS_BARTENDERS);
    expect(lanes).toBe(9);
    expect(club.stations.every((st) => st.unlocked)).toBe(true);
    expect(club.stations.every((st) => st.lanes === MAX_LANES)).toBe(true);
  });

  it('saturates all three bars, so all three draw a queue', () => {
    const club = createStressClub();
    const flow = club.derived.flow;

    expect(flow.stations).toHaveLength(STATION_DEFS.length);
    expect(flow.stations.filter((st) => st.saturated)).toHaveLength(STRESS_QUEUES);
    // The door is maxed, so arrivals outrun total capacity and the `min()` is
    // binding on capacity — which is the state the queue diagnostic exists for.
    expect(club.doorLevel).toBe(DOOR_MAX);
    expect(flow.bottleneck).toBe('capacity');
    expect(flow.turnedAwayPerSecond).toBeGreaterThan(0);
  });

  it('stops one level short of complete, so the next-purchase outline still draws', () => {
    const club = createStressClub();

    expect(club.derived.complete).toBe(false);
    expect(club.derived.nextPurchase).not.toBeNull();
    // Exactly one station is short, and only by one level: anything more would
    // be measuring a floor with a dimmer bar on it than C1 specifies.
    const short = club.stations.filter((st) => st.level < MAX_STATION_LEVEL);
    expect(short).toHaveLength(1);
    expect(short[0]!.level).toBe(MAX_STATION_LEVEL - 1);
  });

  it('is identical on every load', () => {
    expect(snapshotClub(createStressClub())).toEqual(snapshotClub(createStressClub()));
  });

  it('runs — the scene is measured live, not paused', () => {
    const club = createStressClub();
    expect(club.cash).toBe(0);

    tickClub(club);
    expect(club.cash).toBeGreaterThan(0);
    expect(club.derived.baseIncomePerSecond).toBeGreaterThan(0);
  });
});

describe('the pinned crowd', () => {
  it('puts 25 guests in 3 queues on screen', () => {
    const totals = stressCrowdTotals();

    expect(totals.guests).toBe(STRESS_GUESTS);
    expect(totals.guests).toBe(25);
    expect(totals.queues).toBe(STRESS_QUEUES);
    expect(totals.queues).toBe(3);
  });

  it('stays inside the §11 cap of 30 rendered guests', () => {
    expect(stressCrowdTotals().withinGuestCap).toBe(true);
    expect(STRESS_GUESTS).toBeLessThanOrEqual(MAX_RENDERED_GUESTS);
  });

  it('keeps every bar queue inside the four-deep limit DUB-6 states', () => {
    expect(STRESS_CROWD.queuePerStation).toBeLessThanOrEqual(4);
    expect(STRESS_CROWD.queuePerStation).toBeGreaterThan(0);
    expect(STRESS_CROWD.dancers).toBeGreaterThan(0);
  });
});
