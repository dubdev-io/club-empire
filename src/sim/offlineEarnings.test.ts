import { describe, expect, it } from 'vitest';
import {
  OFFLINE_CAP_SECONDS,
  OFFLINE_MIN_SECONDS_TO_SHOW,
  OFFLINE_RATE,
} from '../config/economy.ts';
import { computeOfflineEarnings, offlineEarningsSince } from './offlineEarnings.ts';
import { computeOfflineElapsed } from './offline.ts';

const RATE = 100;

/** `seconds` away, measured without a cap, as the boot path does it. */
function away(seconds: number) {
  return computeOfflineElapsed(0, seconds * 1000, Number.POSITIVE_INFINITY);
}

describe('the §5 rule', () => {
  it('pays half the income rate for the time away', () => {
    const earnings = computeOfflineEarnings(RATE, away(120));

    expect(earnings.amount).toBeCloseTo(RATE * OFFLINE_RATE * 120, 6);
    expect(earnings.capped).toBe(false);
    expect(earnings.creditedSeconds).toBe(120);
  });

  it('caps credited time at ten minutes', () => {
    const earnings = computeOfflineEarnings(RATE, away(8 * 3600));

    expect(earnings.capped).toBe(true);
    expect(earnings.creditedSeconds).toBe(OFFLINE_CAP_SECONDS);
    expect(earnings.amount).toBeCloseTo(RATE * OFFLINE_RATE * OFFLINE_CAP_SECONDS, 6);
  });

  it('still reports the true time away when the cap bites', () => {
    // The card says "You were away 2h 14m" and then pays ten minutes of it.
    // Clamping the measurement would make the first line a lie.
    const earnings = computeOfflineEarnings(RATE, away(8 * 3600));
    expect(earnings.awaySeconds).toBe(8 * 3600);
  });

  it('shows no card below the 30 s threshold, but still pays', () => {
    const earnings = computeOfflineEarnings(RATE, away(OFFLINE_MIN_SECONDS_TO_SHOW - 1));

    expect(earnings.show).toBe(false);
    // A tab switch is not a night away and does not deserve a modal — but it
    // must not cost the player anything either.
    expect(earnings.amount).toBeGreaterThan(0);
  });

  it('shows the card exactly at the threshold', () => {
    expect(computeOfflineEarnings(RATE, away(OFFLINE_MIN_SECONDS_TO_SHOW)).show).toBe(true);
  });

  it('shows nothing for a club that earns nothing', () => {
    // A "£0" card at the moment the player can least do anything about it is
    // noise, not information.
    const earnings = computeOfflineEarnings(0, away(3600));
    expect(earnings.show).toBe(false);
    expect(earnings.amount).toBe(0);
  });
});

describe('clock robustness', () => {
  it('clamps a backwards clock to zero rather than paying a negative', () => {
    // Crossing a timezone, a DST change, or an NTP correction. The brief
    // forbids clock validation, so the only correct behaviour is to credit
    // nothing and carry on — never to punish the player.
    const earnings = offlineEarningsSince(RATE, 2_000_000, 1_000_000);

    expect(earnings.amount).toBe(0);
    expect(earnings.awaySeconds).toBe(0);
    expect(earnings.clockWentBackwards).toBe(true);
    expect(earnings.show).toBe(false);
  });

  it('survives a non-finite timestamp', () => {
    expect(offlineEarningsSince(RATE, Number.NaN, 1000).amount).toBe(0);
    expect(offlineEarningsSince(RATE, 1000, Number.POSITIVE_INFINITY).amount).toBe(0);
  });

  it('survives a non-finite income rate', () => {
    expect(computeOfflineEarnings(Number.NaN, away(600)).amount).toBe(0);
    expect(computeOfflineEarnings(Number.POSITIVE_INFINITY, away(600)).amount).toBe(0);
    expect(computeOfflineEarnings(-50, away(600)).amount).toBe(0);
  });

  it('measures a year away without clamping the measurement', () => {
    // `computeOfflineElapsed`'s own 8-hour default would have reported 8h and
    // flagged `clamped`; the offline path deliberately passes no cap so the
    // "away" line stays true and only the payout is capped.
    const oneYear = 365 * 24 * 3600;
    const earnings = offlineEarningsSince(RATE, 0, oneYear * 1000);

    expect(earnings.awaySeconds).toBeCloseTo(oneYear, 6);
    expect(earnings.creditedSeconds).toBe(OFFLINE_CAP_SECONDS);
  });
});

describe('no dark patterns', () => {
  it('has no doubling, no decay and nothing that expires', () => {
    // Criterion 11, asserted structurally. These keys not existing is the
    // whole point: if one appears, this fails and somebody has to justify it.
    const earnings = computeOfflineEarnings(RATE, away(600));
    const keys = Object.keys(earnings);

    for (const forbidden of ['doubled', 'canDouble', 'expiresAt', 'decay', 'streak', 'bonus']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('pays the same amount however long the player waits to collect', () => {
    // Nothing in the card is time-sensitive, so there is no urgency to
    // manufacture. The same absence produces the same number twice.
    const first = computeOfflineEarnings(RATE, away(300));
    const second = computeOfflineEarnings(RATE, away(300));
    expect(second.amount).toBe(first.amount);
  });
});
