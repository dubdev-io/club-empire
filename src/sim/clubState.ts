/**
 * The club — the one source of truth for everything the player owns.
 *
 * This object is mutated in place and is deliberately *not* React state and
 * *not* the Zustand store. The store publishes a projection of it to the UI at
 * a bounded rate (`src/state/store.ts`); the tick never allocates.
 *
 * The one structural rule worth stating up front: **income depends only on
 * purchases**. Nothing a tick does can change what the club earns per second,
 * so the `min()` throughput rule is resolved once per purchase into
 * `state.derived` and the tick is a multiply-and-add. That is what keeps the
 * hot path allocation-free without a second, hand-rolled copy of the economy
 * drifting away from the signed-off one in `src/config/economy.ts`.
 */

import {
  BUBBLE_MIN_VALUE,
  BUBBLE_SPAWN_INTERVAL_SECONDS,
  BUBBLE_VALUE_SECONDS_OF_INCOME,
  AVERAGE_SPEND_MULTIPLIER,
  DOOR_MAX,
  GUEST_TYPES,
  LAST_CALL_DECAY_PER_SECOND,
  LAST_CALL_DURATION_SECONDS,
  LAST_CALL_GAIN_PER_BUBBLE,
  LAST_CALL_MULTIPLIER,
  MAX_BUBBLES_ON_SCREEN,
  MAX_LANES,
  MAX_STATION_LEVEL,
  MIN_DOOR_LEVEL,
  MIN_STATION_LEVEL,
  STAR_LEVELS,
  STATION_DEFS,
  STARTING_CASH,
  computeFlow,
  doorUpgradeCost,
  isClubComplete,
  laneCost,
  stationDef,
  stationUpgradeCost,
  starsAtOrBelow,
  type ClubFlow,
  type ClubProgress,
  type StationKey,
} from '../config/economy.ts';
import { TICK_SECONDS, TICKS_PER_SECOND } from './constants.ts';

/**
 * The bubble spawn interval, in whole ticks.
 *
 * Derived from the configured interval once, here, rather than compared against
 * an accumulating float every tick.
 */
const BUBBLE_SPAWN_INTERVAL_TICKS = Math.max(
  1,
  Math.round(BUBBLE_SPAWN_INTERVAL_SECONDS * TICKS_PER_SECOND),
);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * `key` is carried on the state rather than inferred from array position.
 * Index alignment with `STATION_DEFS` is still maintained, but a save that
 * somehow reordered them then produces a readable error rather than silently
 * pricing the Booth Service like a Tap Bar.
 */
export interface StationState {
  readonly key: StationKey;
  unlocked: boolean;
  level: number;
  lanes: number;
}

/**
 * A cash bubble. Slots are pooled: `MAX_BUBBLES_ON_SCREEN` of them exist for
 * the lifetime of the game and are reused, so spawning allocates nothing.
 */
export interface BubbleSlot {
  active: boolean;
  value: number;
  /** VIP tip — gold ring, louder coin, worth six times a Regular's. */
  vip: boolean;
  /**
   * Position as a fraction of the floor region, in `[0, 1]`.
   *
   * The sim does not know where the floor is on screen — that is the
   * renderer's business and it changes with the safe area. Normalised
   * coordinates keep the two apart.
   */
  u: number;
  v: number;
  /** Seconds since this slot was filled. Drives the spawn pop. */
  age: number;
  /** Bumped on each spawn so the renderer can tell a reused slot from a held one. */
  serial: number;
}

/** A ★ that has been earned and not yet celebrated. */
export interface PendingStar {
  readonly station: StationKey;
  readonly level: number;
  readonly stars: number;
}

/** Everything resolved from the purchase state. Recomputed on purchase, never on a tick. */
export interface Derived {
  readonly flow: ClubFlow;
  /**
   * Income per second with Last Call *excluded*.
   *
   * The §5 offline rule is specified against the unboosted rate, and the HUD
   * shows the boost as a separate multiplier rather than folding it in, so the
   * unboosted number is the one worth caching.
   */
  readonly baseIncomePerSecond: number;
  /** Cheapest legal purchase, or null at full build-out. Drives the §4.4b outline fill. */
  readonly nextPurchase: Purchase | null;
  readonly complete: boolean;
}

export interface ClubState {
  cash: number;
  /** Lifetime earnings, for the club-complete stats. */
  totalEarned: number;
  doorLevel: number;
  /** Index-aligned with `STATION_DEFS`. */
  stations: StationState[];
  bubbles: BubbleSlot[];
  /**
   * Ticks since the last bubble spawned.
   *
   * An integer tick count, not an accumulated float. Summing `TICK_SECONDS`
   * eight times gives 0.7999999999999999, so a `>= 0.8` comparison misses the
   * tick it should fire on and the spawner runs one tick late — every time, for
   * the whole session. Same class of bug as the one `FixedStepLoop` derives its
   * tick count by division to avoid.
   */
  bubbleTicks: number;
  /** Last Call meter, `0..1`. */
  lastCallMeter: number;
  /** Seconds of Last Call left to run. 0 when not firing. */
  lastCallRemaining: number;
  lastCallFiredCount: number;
  bubblesCollected: number;
  elapsedSeconds: number;
  purchaseCount: number;
  pendingStar: PendingStar | null;
  /** True once the club-complete screen has been shown, so it fires once. */
  completeSeen: boolean;
  /** The one-time pulsing rings (§ core loop). Each is dismissed by being tapped. */
  hintBubblePending: boolean;
  hintStationPending: boolean;
  derived: Derived;
  /** xorshift32 state. Not persisted — bubble placement need not survive a reload. */
  rng: number;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export type Purchase =
  | { readonly kind: 'unlock'; readonly station: StationKey; readonly cost: number }
  | { readonly kind: 'level'; readonly station: StationKey; readonly cost: number }
  | { readonly kind: 'lane'; readonly station: StationKey; readonly lane: number; readonly cost: number }
  | { readonly kind: 'door'; readonly cost: number };

/** Every purchase that is legal right now, affordable or not. Allocates — purchase-time only. */
export function availablePurchases(state: ClubState): Purchase[] {
  const out: Purchase[] = [];

  for (const st of state.stations) {
    const def = stationDef(st.key);
    if (!st.unlocked) {
      out.push({ kind: 'unlock', station: def.key, cost: def.unlockCost });
      continue;
    }
    if (st.level < MAX_STATION_LEVEL) {
      out.push({ kind: 'level', station: def.key, cost: stationUpgradeCost(def, st.level) });
    }
    if (st.lanes < MAX_LANES) {
      const lane = st.lanes + 1;
      out.push({ kind: 'lane', station: def.key, lane, cost: laneCost(def, lane) });
    }
  }

  if (state.doorLevel < DOOR_MAX) {
    out.push({ kind: 'door', cost: doorUpgradeCost(state.doorLevel) });
  }

  return out;
}

/**
 * The cheapest thing left to buy.
 *
 * §4.4b hangs the progress fill off this: the dotted outline sits at this
 * purchase's floor slot and fills from the bottom as cash approaches its price.
 * Cheapest rather than "most useful" on purpose — it is the one the player will
 * reach first, so it is the one whose fill tells them something true.
 */
export function cheapestPurchase(state: ClubState): Purchase | null {
  let best: Purchase | null = null;
  for (const p of availablePurchases(state)) {
    if (best === null || p.cost < best.cost) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** The read-only view the economy config wants. Allocates — purchase-time only. */
export function progressOf(state: ClubState): ClubProgress {
  return {
    doorLevel: state.doorLevel,
    stations: state.stations.map((st) => ({
      key: st.key,
      unlocked: st.unlocked,
      level: st.level,
      lanes: st.lanes,
    })),
  };
}

function freshStations(): StationState[] {
  return STATION_DEFS.map((def, i) => ({
    key: def.key,
    unlocked: i === 0,
    level: MIN_STATION_LEVEL,
    lanes: i === 0 ? 1 : 0,
  }));
}

function freshBubbles(): BubbleSlot[] {
  const out: BubbleSlot[] = [];
  for (let i = 0; i < MAX_BUBBLES_ON_SCREEN; i += 1) {
    out.push({ active: false, value: 0, vip: false, u: 0.5, v: 0.5, age: 0, serial: 0 });
  }
  return out;
}

export function createClubState(): ClubState {
  const state: ClubState = {
    cash: STARTING_CASH,
    totalEarned: 0,
    doorLevel: MIN_DOOR_LEVEL,
    stations: freshStations(),
    bubbles: freshBubbles(),
    bubbleTicks: 0,
    lastCallMeter: 0,
    lastCallRemaining: 0,
    lastCallFiredCount: 0,
    bubblesCollected: 0,
    elapsedSeconds: 0,
    purchaseCount: 0,
    pendingStar: null,
    completeSeen: false,
    hintBubblePending: true,
    hintStationPending: true,
    // Any non-zero seed. xorshift32 is stuck at zero.
    rng: 0x2f6e2b1,
    derived: {
      flow: computeFlow({ doorLevel: MIN_DOOR_LEVEL, stations: [] }),
      baseIncomePerSecond: 0,
      nextPurchase: null,
      complete: false,
    },
  };
  recomputeDerived(state);
  return state;
}

/**
 * Resolve the throughput rule and cache it.
 *
 * Call this after *any* change to cash-earning state. It allocates, which is
 * why it must never be reached from a tick or a frame.
 */
export function recomputeDerived(state: ClubState): void {
  const progress = progressOf(state);
  const flow = computeFlow(progress);
  state.derived = {
    flow,
    baseIncomePerSecond: flow.incomePerSecond,
    nextPurchase: cheapestPurchase(state),
    complete: isClubComplete(progress),
  };
}

export function stationStateOf(state: ClubState, key: StationKey): StationState {
  const hit = state.stations.find((st) => st.key === key);
  if (hit === undefined) throw new Error(`no station "${key}" in state`);
  return hit;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** Income multiplier in force right now. 1, or `LAST_CALL_MULTIPLIER` while firing. */
export function currentMultiplier(state: ClubState): number {
  return state.lastCallRemaining > 0 ? LAST_CALL_MULTIPLIER : 1;
}

/** Income per second as the counter is actually climbing, boost included. */
export function effectiveIncomePerSecond(state: ClubState): number {
  return state.derived.baseIncomePerSecond * currentMultiplier(state);
}

/**
 * Advance the club by exactly one fixed tick.
 *
 * Allocation-free: numeric reads and writes only, and the bubble pool is
 * pre-sized. Because the step is a constant, the result depends only on how
 * many times this runs — never on how long a render frame took.
 */
export function tickClub(state: ClubState): void {
  const dt = TICK_SECONDS;

  state.elapsedSeconds += dt;

  const gain = state.derived.baseIncomePerSecond * currentMultiplier(state) * dt;
  state.cash += gain;
  state.totalEarned += gain;

  if (state.lastCallRemaining > 0) {
    state.lastCallRemaining -= dt;
    if (state.lastCallRemaining < 0) state.lastCallRemaining = 0;
  }

  // §4.5: the meter decays while the player is not tapping. Modelled as a
  // continuous drain rather than an idle timer — a bubble adds four seconds'
  // worth, so sustained tapping outruns it comfortably and a put-down phone
  // bleeds back to zero in a minute forty.
  if (state.lastCallMeter > 0) {
    state.lastCallMeter -= LAST_CALL_DECAY_PER_SECOND * dt;
    if (state.lastCallMeter < 0) state.lastCallMeter = 0;
  }

  for (let i = 0; i < state.bubbles.length; i += 1) {
    const bubble = state.bubbles[i]!;
    if (bubble.active) bubble.age += dt;
  }

  state.bubbleTicks += 1;
  if (state.bubbleTicks >= BUBBLE_SPAWN_INTERVAL_TICKS) {
    if (spawnBubble(state)) {
      state.bubbleTicks = 0;
    } else {
      // Every slot is held by an uncollected bubble. §4.5: uncollected bubbles
      // block the next spawn. Parking the counter at the threshold rather than
      // resetting it means a collected bubble is replaced on the next tick, so
      // the floor refills as fast as the player clears it — but three held
      // bubbles still stop the flow dead.
      state.bubbleTicks = BUBBLE_SPAWN_INTERVAL_TICKS;
    }
  }
}

// ---------------------------------------------------------------------------
// Bubbles and Last Call
// ---------------------------------------------------------------------------

/**
 * What a tip is worth.
 *
 * Scaled so that the *expected* value across the 92/8 guest mix is exactly
 * `BUBBLE_VALUE_SECONDS_OF_INCOME` seconds of income: a Regular pays
 * `1.0 / 1.40` of the average and a VIP `6.0 / 1.40`. Pinning the mean here
 * rather than eyeballing it is what stops the VIP rate quietly re-tuning the
 * economy the designer signed off.
 */
export function bubbleValue(state: ClubState, vip: boolean): number {
  const spend = (vip ? GUEST_TYPES[1]!.spend : GUEST_TYPES[0]!.spend) / AVERAGE_SPEND_MULTIPLIER;
  const proportional = state.derived.baseIncomePerSecond * BUBBLE_VALUE_SECONDS_OF_INCOME * spend;
  const floor = BUBBLE_MIN_VALUE * spend;
  return Math.max(floor, proportional);
}

/** Fill a free slot. Returns false when all three are held. Allocation-free. */
export function spawnBubble(state: ClubState): boolean {
  for (let i = 0; i < state.bubbles.length; i += 1) {
    const bubble = state.bubbles[i]!;
    if (bubble.active) continue;

    const vip = random(state) < GUEST_TYPES[1]!.share;
    bubble.active = true;
    bubble.vip = vip;
    bubble.value = bubbleValue(state, vip);
    bubble.u = 0.1 + random(state) * 0.8;
    bubble.v = 0.15 + random(state) * 0.7;
    bubble.age = 0;
    bubble.serial += 1;
    return true;
  }
  return false;
}

export interface BubbleCollection {
  readonly collected: boolean;
  readonly value: number;
  readonly vip: boolean;
  /** True when this tap took the meter to 100% and fired Last Call. */
  readonly firedLastCall: boolean;
}

const NOT_COLLECTED: BubbleCollection = {
  collected: false,
  value: 0,
  vip: false,
  firedLastCall: false,
};

/**
 * Collect one bubble.
 *
 * Applied synchronously on the input event, never deferred to the next tick —
 * a tap has to change the screen in the frame it arrives, and 100 ms of tick
 * latency is the whole difference between a counter that feels connected and
 * one that feels dead.
 */
export function collectBubble(state: ClubState, index: number): BubbleCollection {
  const bubble = state.bubbles[index];
  if (!bubble || !bubble.active) return NOT_COLLECTED;

  const { value, vip } = bubble;
  bubble.active = false;
  bubble.value = 0;

  state.cash += value;
  state.totalEarned += value;
  state.bubblesCollected += 1;
  state.hintBubblePending = false;

  // §4.5: +4% per bubble regardless of the tip's size. The meter measures
  // attention, not money — a VIP tip is worth six times as much cash but the
  // same 4%, so Last Call cannot be farmed by waiting for gold ones.
  let firedLastCall = false;
  state.lastCallMeter += LAST_CALL_GAIN_PER_BUBBLE;
  if (state.lastCallMeter >= 1) {
    // Fires automatically at 100%. Not purchasable, not ad-gated, no cooldown
    // beyond refilling the meter.
    state.lastCallMeter = 0;
    state.lastCallRemaining = LAST_CALL_DURATION_SECONDS;
    state.lastCallFiredCount += 1;
    firedLastCall = true;
  }

  return { collected: true, value, vip, firedLastCall };
}

// ---------------------------------------------------------------------------
// Player purchases
// ---------------------------------------------------------------------------

export type PurchaseResult = 'bought' | 'too-expensive' | 'not-available';

function spend(state: ClubState, cost: number): boolean {
  if (state.cash < cost) return false;
  state.cash -= cost;
  state.purchaseCount += 1;
  return true;
}

export function canUpgradeStation(state: ClubState, key: StationKey): boolean {
  const st = stationStateOf(state, key);
  return st.unlocked && st.level < MAX_STATION_LEVEL;
}

export function stationUpgradePrice(state: ClubState, key: StationKey): number {
  const st = stationStateOf(state, key);
  return stationUpgradeCost(stationDef(key), st.level);
}

/**
 * Buy one station level. The most-pressed button in the game — roughly fifteen
 * of these happen in the first minute, so it stays a single cheap mutation
 * plus one `recomputeDerived`.
 */
export function upgradeStation(state: ClubState, key: StationKey): PurchaseResult {
  if (!canUpgradeStation(state, key)) return 'not-available';
  const st = stationStateOf(state, key);
  const before = starsAtOrBelow(st.level);

  if (!spend(state, stationUpgradeCost(stationDef(key), st.level))) return 'too-expensive';

  st.level += 1;
  state.hintStationPending = false;

  const after = starsAtOrBelow(st.level);
  if (after > before) {
    // x2 drink price is already in `baseDrinkPrice`; this only queues the
    // celebration. The overlay clears it.
    state.pendingStar = { station: key, level: st.level, stars: after };
  }

  recomputeDerived(state);
  return 'bought';
}

export function canBuyLane(state: ClubState, key: StationKey): boolean {
  const st = stationStateOf(state, key);
  return st.unlocked && st.lanes < MAX_LANES;
}

export function lanePrice(state: ClubState, key: StationKey): number {
  const st = stationStateOf(state, key);
  return laneCost(stationDef(key), st.lanes + 1);
}

export function buyLane(state: ClubState, key: StationKey): PurchaseResult {
  if (!canBuyLane(state, key)) return 'not-available';
  const st = stationStateOf(state, key);

  if (!spend(state, laneCost(stationDef(key), st.lanes + 1))) return 'too-expensive';

  st.lanes += 1;
  recomputeDerived(state);
  return 'bought';
}

export function canUnlockStation(state: ClubState, key: StationKey): boolean {
  return !stationStateOf(state, key).unlocked;
}

export function unlockPrice(key: StationKey): number {
  return stationDef(key).unlockCost;
}

export function unlockStation(state: ClubState, key: StationKey): PurchaseResult {
  if (!canUnlockStation(state, key)) return 'not-available';
  if (!spend(state, stationDef(key).unlockCost)) return 'too-expensive';

  const st = stationStateOf(state, key);
  st.unlocked = true;
  // Lane 1 comes free with the unlock — a station with zero lanes serves
  // nobody and would read as a bug.
  st.lanes = Math.max(1, st.lanes);
  recomputeDerived(state);
  return 'bought';
}

export function canUpgradeDoor(state: ClubState): boolean {
  return state.doorLevel < DOOR_MAX;
}

export function doorPrice(state: ClubState): number {
  return doorUpgradeCost(state.doorLevel);
}

export function upgradeDoor(state: ClubState): PurchaseResult {
  if (!canUpgradeDoor(state)) return 'not-available';
  if (!spend(state, doorUpgradeCost(state.doorLevel))) return 'too-expensive';

  state.doorLevel += 1;
  recomputeDerived(state);
  return 'bought';
}

/** Apply any purchase by value. Used by the sheets and the dev auto-buyer. */
export function applyPurchase(state: ClubState, purchase: Purchase): PurchaseResult {
  switch (purchase.kind) {
    case 'unlock':
      return unlockStation(state, purchase.station);
    case 'level':
      return upgradeStation(state, purchase.station);
    case 'lane':
      return buyLane(state, purchase.station);
    case 'door':
      return upgradeDoor(state);
  }
}

/** Credit offline or boosted earnings without routing them through a tick. */
export function creditCash(state: ClubState, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  state.cash += amount;
  state.totalEarned += amount;
}

export function takePendingStar(state: ClubState): PendingStar | null {
  const star = state.pendingStar;
  state.pendingStar = null;
  return star;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** The persisted subset. Everything else is derived or presentational. */
export interface ClubSnapshot {
  cash: number;
  totalEarned: number;
  doorLevel: number;
  stations: readonly { key: string; unlocked: boolean; level: number; lanes: number }[];
  lastCallMeter: number;
  lastCallFiredCount: number;
  bubblesCollected: number;
  elapsedSeconds: number;
  purchaseCount: number;
  completeSeen: boolean;
  hintBubblePending: boolean;
  hintStationPending: boolean;
}

export function snapshotClub(state: ClubState): ClubSnapshot {
  return {
    cash: state.cash,
    totalEarned: state.totalEarned,
    doorLevel: state.doorLevel,
    stations: state.stations.map((st) => ({
      key: st.key,
      unlocked: st.unlocked,
      level: st.level,
      lanes: st.lanes,
    })),
    lastCallMeter: state.lastCallMeter,
    lastCallFiredCount: state.lastCallFiredCount,
    bubblesCollected: state.bubblesCollected,
    elapsedSeconds: state.elapsedSeconds,
    purchaseCount: state.purchaseCount,
    completeSeen: state.completeSeen,
    hintBubblePending: state.hintBubblePending,
    hintStationPending: state.hintStationPending,
  };
}

function clampLevel(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : min;
  return n < min ? min : n > max ? max : n;
}

function clampCash(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Rebuild a club from a snapshot.
 *
 * Every field is clamped rather than trusted. `localStorage` is player-writable
 * and the brief is explicit that we do not add anti-cheat — but a hand-edited
 * `level: "lots"` reaching `baseDrinkPrice` turns every later tick into `NaN`,
 * which is a crash, not cheating. Clamping costs nothing and the failure mode
 * it prevents is a white screen.
 *
 * Last Call is deliberately *not* restored as firing. A x3 buff that survives a
 * reload is a buff you can bank, and the meter is the thing worth keeping.
 */
export function restoreClub(snapshot: ClubSnapshot): ClubState {
  const state = createClubState();

  state.cash = clampCash(snapshot.cash);
  // Not clamped up to `cash`: the club starts with cash it did not earn, so
  // `totalEarned < cash` is a legitimate early-game state and forcing them
  // equal would rewrite the stat on every reload.
  state.totalEarned = clampCash(snapshot.totalEarned);
  state.doorLevel = clampLevel(snapshot.doorLevel, MIN_DOOR_LEVEL, DOOR_MAX);

  for (const st of state.stations) {
    const saved = snapshot.stations.find((s) => s.key === st.key);
    if (!saved) continue;
    st.unlocked = saved.unlocked === true;
    st.level = clampLevel(saved.level, MIN_STATION_LEVEL, MAX_STATION_LEVEL);
    st.lanes = clampLevel(saved.lanes, 0, MAX_LANES);
    if (st.unlocked && st.lanes < 1) st.lanes = 1;
    if (!st.unlocked) st.lanes = 0;
  }

  // The Tap Bar is open at t = 0 by definition; a save claiming otherwise
  // would produce a club that can never earn and never be repaired.
  const tap = state.stations[0]!;
  if (!tap.unlocked) {
    tap.unlocked = true;
    tap.lanes = Math.max(1, tap.lanes);
  }

  const meter = typeof snapshot.lastCallMeter === 'number' ? snapshot.lastCallMeter : 0;
  state.lastCallMeter = Number.isFinite(meter) ? Math.min(1, Math.max(0, meter)) : 0;
  state.lastCallRemaining = 0;

  state.lastCallFiredCount = clampLevel(snapshot.lastCallFiredCount, 0, Number.MAX_SAFE_INTEGER);
  state.bubblesCollected = clampLevel(snapshot.bubblesCollected, 0, Number.MAX_SAFE_INTEGER);
  state.elapsedSeconds = clampCash(snapshot.elapsedSeconds);
  state.purchaseCount = clampLevel(snapshot.purchaseCount, 0, Number.MAX_SAFE_INTEGER);
  state.completeSeen = snapshot.completeSeen === true;
  state.hintBubblePending = snapshot.hintBubblePending !== false;
  state.hintStationPending = snapshot.hintStationPending !== false;

  recomputeDerived(state);
  return state;
}

/** Full build-out reached and not yet celebrated. */
export function shouldShowComplete(state: ClubState): boolean {
  return state.derived.complete && !state.completeSeen;
}

/** xorshift32 — deterministic and allocation-free. Bubble placement only. */
function random(state: ClubState): number {
  let x = state.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rng = x >>> 0;
  return state.rng / 0x100000000;
}

export { MAX_STATION_LEVEL, MAX_LANES, DOOR_MAX, STAR_LEVELS };
