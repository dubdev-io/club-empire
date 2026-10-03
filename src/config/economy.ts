/**
 * Club Empire — the one config module (§4, §4.5, §5, §11).
 *
 * Every balance number the designer may want to turn lives here, and nowhere
 * else. The brief is explicit about it: "Expose every constant in one config
 * module — no magic numbers scattered through gameplay code."
 *
 * The split from `src/sim/constants.ts` is deliberate and is the only split:
 *
 * - **here** — game balance. Prices, costs, growth rates, guest mix, Last Call,
 *   offline earnings, the design-side performance caps. Changing a number here
 *   changes how the game plays, and `npm run sim:economy` will tell you by how
 *   much.
 * - **`src/sim/constants.ts`** — engine mechanics. Tick rate, catch-up bound,
 *   design resolution, autosave cadence. Changing a number there changes how the
 *   game *runs*, not how it plays.
 *
 * Every value below is the one verified in DUB-4 against the §4.4 pacing table:
 * 13/13 rows inside ±20%, club complete at 11,783/s with Regular guests only.
 * `tools/economy-sim.ts` imports from this file rather than keeping its own
 * copy, so the model that was signed off and the game that ships cannot drift
 * apart. If you change a number here, re-run the sim before you commit.
 */

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export type StationKey = 'tap' | 'cocktail' | 'booth';

export interface StationDef {
  readonly key: StationKey;
  readonly name: string;
  /** Cash to open the station. The Tap Bar is free and open at t = 0. */
  readonly unlockCost: number;
  /** C1 — cost of the level 1 -> 2 upgrade. */
  readonly c1: number;
  /** P1 — drink price at level 1, for a Regular guest. */
  readonly p1: number;
  /** Seconds one lane takes to serve one guest. This sets capacity. */
  readonly serveTime: number;
  /** Cost of lanes 1..3. Lane 1 is free: it comes with the unlock. */
  readonly laneCosts: readonly [number, number, number];
}

/**
 * Price order matters. Guests route to the highest-drink-price station with a
 * free lane and overflow down this order, so the array order is load-bearing,
 * not cosmetic.
 */
export const STATION_DEFS: readonly StationDef[] = [
  {
    key: 'tap',
    name: 'Tap Bar',
    unlockCost: 0,
    c1: 5,
    p1: 2,
    serveTime: 2.0,
    laneCosts: [0, 400, 3_200],
  },
  {
    key: 'cocktail',
    name: 'Cocktail Bar',
    unlockCost: 900,
    c1: 90,
    p1: 18,
    serveTime: 3.0,
    laneCosts: [0, 7_000, 56_000],
  },
  {
    key: 'booth',
    name: 'Booth Service',
    unlockCost: 18_000,
    c1: 900,
    p1: 150,
    serveTime: 4.5,
    laneCosts: [0, 140_000, 1_120_000],
  },
];

/** Station lookup. Throws rather than returning undefined so callers stay readable. */
export function stationDef(key: StationKey): StationDef {
  const hit = STATION_DEFS.find((s) => s.key === key);
  if (hit === undefined) throw new Error(`no station "${key}"`);
  return hit;
}

// ---------------------------------------------------------------------------
// Growth curves
// ---------------------------------------------------------------------------

/** Cash the player starts with. Enough for the first upgrade, not the second. */
export const STARTING_CASH = 30;

/** R — upgrade cost multiplier per station level. */
export const COST_GROWTH = 1.21;

/** M — drink price multiplier per station level. */
export const INCOME_GROWTH = 1.09;

/** Levels that award a ★. */
export const STAR_LEVELS: readonly number[] = [10, 20, 30];

/** What a ★ does to the drink price. */
export const STAR_MULTIPLIER = 2;

export const MIN_STATION_LEVEL = 1;
export const MAX_STATION_LEVEL = 30;

/** Serving lanes per station. Each one is a visible bartender on the floor. */
export const MAX_LANES = 3;

// ---------------------------------------------------------------------------
// Door
// ---------------------------------------------------------------------------

export const MIN_DOOR_LEVEL = 1;
export const DOOR_MAX = 8;

/** Guests per second at Door L1. */
export const DOOR_BASE_ARRIVALS = 0.9;

/** Arrivals multiplier per Door level. */
export const DOOR_ARRIVAL_GROWTH = 1.2;

export const DOOR_COST_BASE = 60;
export const DOOR_COST_GROWTH = 2.6;

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

export interface GuestTypeDef {
  readonly key: 'regular' | 'vip';
  /** Share of arrivals. The shares sum to 1. */
  readonly share: number;
  /** Multiplier on the station's drink price. */
  readonly spend: number;
}

export const GUEST_TYPES: readonly GuestTypeDef[] = [
  { key: 'regular', share: 0.92, spend: 1.0 },
  { key: 'vip', share: 0.08, spend: 6.0 },
];

/**
 * Expected spend multiplier across the guest mix: 0.92 x 1.0 + 0.08 x 6.0 = 1.40.
 *
 * This is what income/s is computed from — a per-guest coin flip would make the
 * HUD number jitter for no gameplay gain, and the §4.4 table was authored
 * against the average, not a sampled run.
 *
 * DUB-4 recorded **option (a)**: ship the §4.4 constants unchanged and accept
 * that VIPs make the whole curve ~30% faster (club complete at ~13.8 min rather
 * than ~19.4). The alternative that was tested and rejected — clamping
 * `DOOR_BASE_ARRIVALS` to 0.64 — recovers under a fifth of the gap and leaves
 * dead capacity at Door L8, which breaks the "no dead buy at the end" property
 * §4.4 was tuned for. If the table ever has to hold exactly with VIPs on, the
 * lever is to divide every `p1` by 1.40, not to touch the door.
 */
export const AVERAGE_SPEND_MULTIPLIER = GUEST_TYPES.reduce((sum, g) => sum + g.share * g.spend, 0);

// ---------------------------------------------------------------------------
// Cash bubbles and Last Call (§4.5)
// ---------------------------------------------------------------------------

/** Uncollected bubbles block the next spawn, so this is a hard ceiling. */
export const MAX_BUBBLES_ON_SCREEN = 3;

/**
 * Seconds between bubble spawns, when a slot is free.
 *
 * Pinned by §4.5 rather than chosen: "~25 bubbles in ~20 s triggers it" means
 * the player must be able to collect ~1.25 bubbles a second, so the spawner has
 * to offer them at least that fast. With three slots and a 0.8 s interval a
 * player tapping as fast as they see them gets 1.25/s and fires Last Call in
 * 20 s, exactly as specified.
 */
export const BUBBLE_SPAWN_INTERVAL_SECONDS = 0.8;

/**
 * A bubble is a tip, priced in seconds of current income.
 *
 * Deliberately small. The §4.4 pacing table was authored and signed off against
 * *passive* income, so bubbles have to stay a garnish on that curve rather than
 * a second income stream — at the full 1.25 bubbles/s this is +50% income, and
 * the acceleration the design wants from tapping is meant to come from Last
 * Call (x3), not from the tips themselves. The dev auto-buyer does not tap, so
 * acceptance criterion 1 measures the passive curve.
 */
export const BUBBLE_VALUE_SECONDS_OF_INCOME = 0.4;

/**
 * Floor on a bubble's value, in cash.
 *
 * At t = 0 income is 1.26/s, so a pure proportional tip would be worth 0.5 —
 * a counter that visibly does nothing when tapped. The first tap in the game is
 * the one that teaches the whole loop; it has to pay.
 */
export const BUBBLE_MIN_VALUE = 1;

/** Meter gained per bubble tapped, as a fraction of full. */
export const LAST_CALL_GAIN_PER_BUBBLE = 0.04;

/** Meter lost per second while not tapping, as a fraction of full. */
export const LAST_CALL_DECAY_PER_SECOND = 0.01;

/** Income multiplier while Last Call is firing. */
export const LAST_CALL_MULTIPLIER = 3;

export const LAST_CALL_DURATION_SECONDS = 30;

/**
 * Share of arrivals turned away before the HUD raises a queue *warning*.
 *
 * The queue itself is always drawn — it is the diagnostic and the whole reason
 * this is a nightclub and not a spreadsheet. This threshold governs only the
 * amber `⚠` banner, which is a different thing: an alarm.
 *
 * It exists because the §4.4 economy is capacity-bound for **93.2% of the run**
 * (DUB-4's own bottleneck split), and a fresh club serves 0.50 guests/s against
 * 0.90 arriving — so a banner that fired whenever the `min()` binds would be on
 * screen almost permanently, from the first second, telling the player to buy a
 * lane they cannot afford for three and a half minutes. A permanent alarm is
 * not a diagnostic, it is nagging, and the brief rules out nagging copy.
 *
 * At 0.5 the banner means "you are turning away more guests than you serve",
 * which is the distinct `queue-overflow` state Phase 1 scope item 12 asks for
 * rather than the ordinary condition of play.
 */
export const QUEUE_WARNING_SHARE = 0.5;

// ---------------------------------------------------------------------------
// Offline earnings (§5)
// ---------------------------------------------------------------------------

/** Fraction of income/s earned while away, measured unboosted at the moment of leaving. */
export const OFFLINE_RATE = 0.5;

/** The one named cap. 10 minutes, editable in dev mode. */
export const OFFLINE_CAP_SECONDS = 600;

/** Below this, no return card — a tab switch is not a night away. */
export const OFFLINE_MIN_SECONDS_TO_SHOW = 30;

// ---------------------------------------------------------------------------
// Design-side performance caps (§11)
// ---------------------------------------------------------------------------

/** Hard ceiling on rendered guests. A busier room uses the back-wall parallax sprite, not more entities. */
export const MAX_RENDERED_GUESTS = 30;

export const MAX_PARTICLES = 60;

// ---------------------------------------------------------------------------
// Formulae
// ---------------------------------------------------------------------------

/** How many ★ a station at this level has earned. */
export function starsAtOrBelow(level: number): number {
  return STAR_LEVELS.filter((l) => l <= level).length;
}

/** Cash to go from `level` to `level + 1`. */
export function stationUpgradeCost(def: StationDef, level: number): number {
  return def.c1 * COST_GROWTH ** (level - 1);
}

/**
 * What one Regular guest pays at this station and level.
 *
 * Multiply by a guest type's `spend` for an individual guest, or by
 * `AVERAGE_SPEND_MULTIPLIER` for a rate.
 */
export function baseDrinkPrice(def: StationDef, level: number): number {
  return def.p1 * INCOME_GROWTH ** (level - 1) * STAR_MULTIPLIER ** starsAtOrBelow(level);
}

/** Cash for the nth lane. Lane 1 is free with the unlock. */
export function laneCost(def: StationDef, lane: number): number {
  const [first, second, third] = def.laneCosts;
  if (lane === 1) return first;
  if (lane === 2) return second;
  if (lane === 3) return third;
  throw new Error(`no lane ${lane} on ${def.name}`);
}

/** Guests per second this station can serve with the lanes it has. */
export function stationCapacity(def: StationDef, lanes: number): number {
  return lanes / def.serveTime;
}

/** Guests per second walking in at this Door level. */
export function doorArrivalsPerSecond(doorLevel: number): number {
  return DOOR_BASE_ARRIVALS * DOOR_ARRIVAL_GROWTH ** (doorLevel - 1);
}

/** Cash to go from `doorLevel` to `doorLevel + 1`. */
export function doorUpgradeCost(doorLevel: number): number {
  return DOOR_COST_BASE * DOOR_COST_GROWTH ** (doorLevel - 1);
}

// ---------------------------------------------------------------------------
// The throughput rule
// ---------------------------------------------------------------------------

export interface StationProgress {
  readonly key: StationKey;
  readonly unlocked: boolean;
  readonly level: number;
  readonly lanes: number;
}

export interface ClubProgress {
  readonly doorLevel: number;
  readonly stations: readonly StationProgress[];
}

/** A fresh club: Tap Bar open at L1 with one lane, Door L1, nothing else. */
export function startingProgress(): ClubProgress {
  return {
    doorLevel: MIN_DOOR_LEVEL,
    stations: STATION_DEFS.map((def, i) => ({
      key: def.key,
      unlocked: i === 0,
      level: MIN_STATION_LEVEL,
      lanes: i === 0 ? 1 : 0,
    })),
  };
}

/** Total guests per second every open station can serve between them. */
export function totalCapacity(progress: ClubProgress): number {
  let sum = 0;
  for (const st of progress.stations) {
    if (!st.unlocked) continue;
    sum += stationCapacity(stationDef(st.key), st.lanes);
  }
  return sum;
}

/** Which side of the `min()` is binding. This is what the floor renders as a queue, or as an idle bartender. */
export type Bottleneck = 'door' | 'capacity';

export function bottleneckOf(progress: ClubProgress): Bottleneck {
  return doorArrivalsPerSecond(progress.doorLevel) < totalCapacity(progress) ? 'door' : 'capacity';
}

/**
 * The throughput rule — the whole design.
 *
 *   income/s = SUM over stations [ min(guests routed to it, lanes / serveTime) * drinkPrice(level) ]
 *
 * Station level buys cash per guest; lanes and the Door buy guests per second.
 * The `min()` is what couples them. A level-only income model would still look
 * plausible in a spreadsheet and would ship a game where the queue at the door
 * means nothing — and that queue is the entire tutorial.
 *
 * Routing sends each guest to the highest-drink-price station with a free lane,
 * so in steady state the dearest station fills first and the remainder overflows
 * down the price order. Per-station queues and door waiting buffer arrival
 * jitter but cannot change the steady-state *rate*, so they are a latency and
 * animation concern rather than an income one and are not modelled here.
 */
export interface IncomeOptions {
  /** Defaults to `AVERAGE_SPEND_MULTIPLIER`, the shipping configuration. Pass 1 to price Regular guests only, as the §4.4 table is specified. */
  readonly spendMultiplier?: number;
  /** Overrides the Door curve. Only the economy model's `--arrivals=` flag uses this. */
  readonly arrivalsPerSecond?: number;
}

/** What one station is doing right now. The floor renders this, it does not invent it. */
export interface StationFlow {
  readonly key: StationKey;
  /** Guests per second actually being served here. */
  readonly servedPerSecond: number;
  /** Guests per second this station *could* serve: `lanes / serveTime`. */
  readonly capacityPerSecond: number;
  /** What one average guest pays here, across the guest mix. */
  readonly pricePerGuest: number;
  readonly incomePerSecond: number;
  /**
   * Every lane is busy and guests are still arriving for this station.
   * This is what puts a queue beside the bar.
   */
  readonly saturated: boolean;
  /** Lanes with nothing to do, fractional. This is what makes a bartender visibly idle. */
  readonly idleLanes: number;
}

/** The whole club's throughput, resolved. */
export interface ClubFlow {
  readonly arrivalsPerSecond: number;
  readonly servedPerSecond: number;
  /**
   * Guests per second arriving that no station can take.
   *
   * This is the door queue, and it is the entire tutorial: it is non-zero
   * exactly when the player's next useful purchase is capacity rather than
   * another level.
   */
  readonly turnedAwayPerSecond: number;
  readonly incomePerSecond: number;
  readonly bottleneck: Bottleneck;
  readonly stations: readonly StationFlow[];
}

/**
 * The throughput rule, resolved into every number the game needs — the one
 * implementation of the `min()`.
 *
 * `incomePerSecond` is a projection of this, so the signed-off economy model
 * and the queues drawn on the floor cannot disagree about what the club is
 * doing. Routing sends each guest to the highest-drink-price station with a
 * free lane; the remainder overflows down the price order and whatever is left
 * at the end is turned away at the door.
 *
 * Allocates. That is fine and deliberate: nothing this depends on changes on a
 * tick, so `ClubState` calls it on purchase only and caches the result. It must
 * never be called from the per-frame or per-tick path.
 */
export function computeFlow(progress: ClubProgress, options: IncomeOptions = {}): ClubFlow {
  const spendMultiplier = options.spendMultiplier ?? AVERAGE_SPEND_MULTIPLIER;
  const arrivalsPerSecond = options.arrivalsPerSecond ?? doorArrivalsPerSecond(progress.doorLevel);

  const open = progress.stations
    .filter((st) => st.unlocked && st.lanes > 0)
    .map((st) => {
      const def = stationDef(st.key);
      return { def, price: baseDrinkPrice(def, st.level), capacity: stationCapacity(def, st.lanes) };
    })
    .sort((a, b) => b.price - a.price);

  const stations: StationFlow[] = [];
  let remaining = arrivalsPerSecond;
  let income = 0;
  let served = 0;

  for (const st of open) {
    const demand = remaining;
    const take = Math.min(demand, st.capacity);
    const stationIncome = take * st.price * spendMultiplier;

    income += stationIncome;
    served += take;
    remaining -= take;

    stations.push({
      key: st.def.key,
      servedPerSecond: take,
      capacityPerSecond: st.capacity,
      pricePerGuest: st.price * spendMultiplier,
      incomePerSecond: stationIncome,
      // Saturated means the lanes ran out before the demand did. `demand`
      // includes everything that overflowed from dearer stations, so this is
      // true exactly when guests are still waiting for *this* bar.
      saturated: demand > st.capacity,
      // capacity = lanes / serveTime, so the fraction of unused capacity
      // scaled by the lane count is the number of lanes standing still.
      idleLanes: (1 - take / st.capacity) * st.def.serveTime * st.capacity,
    });
  }

  return {
    arrivalsPerSecond,
    servedPerSecond: served,
    turnedAwayPerSecond: remaining,
    incomePerSecond: income,
    bottleneck: arrivalsPerSecond < totalCapacity(progress) ? 'door' : 'capacity',
    stations,
  };
}

export function incomePerSecond(progress: ClubProgress, options: IncomeOptions = {}): number {
  return computeFlow(progress, options).incomePerSecond;
}

/** Full build-out: every station L30 with 3 lanes, and Door L8. */
export function isClubComplete(progress: ClubProgress): boolean {
  return (
    progress.doorLevel >= DOOR_MAX &&
    progress.stations.length === STATION_DEFS.length &&
    progress.stations.every((st) => st.unlocked && st.level >= MAX_STATION_LEVEL && st.lanes >= MAX_LANES)
  );
}
