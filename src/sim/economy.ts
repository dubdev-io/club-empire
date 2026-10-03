import { TICK_SECONDS } from './constants.ts';

/**
 * The authoritative economy state.
 *
 * This object is the single source of truth and is mutated in place — it is
 * deliberately *not* React state and *not* the Zustand store. The store
 * publishes a copy of it to the UI at a bounded rate (see `src/state/store.ts`);
 * the simulation never allocates to advance.
 *
 * There is no gameplay here on purpose. DUB-2 owns the income formula; this is
 * the minimum shape needed to prove the tick is frame-rate independent and
 * that save/load round-trips.
 */
export interface EconomyState {
  /** Current cash. */
  money: number;
  /** Cash added per real second at the current upgrade level. */
  incomePerSecond: number;
  /** Placeholder for the upgrade layer. Raises `incomePerSecond`. */
  barLevel: number;
}

export const BASE_INCOME_PER_SECOND = 2;

/** Placeholder curve. The real one belongs to the design brief (DUB-2). */
export function incomeForBarLevel(barLevel: number): number {
  return BASE_INCOME_PER_SECOND * barLevel;
}

export function createEconomyState(): EconomyState {
  return {
    money: 0,
    incomePerSecond: incomeForBarLevel(1),
    barLevel: 1,
  };
}

/**
 * Advance the economy by exactly one tick.
 *
 * Mutates in place and allocates nothing. Because the step is a constant, the
 * result depends only on how many times this is called — never on how long a
 * render frame took.
 */
export function stepEconomy(state: EconomyState): void {
  state.money += state.incomePerSecond * TICK_SECONDS;
}

/** The one placeholder player action in the shell: buy a bar upgrade. */
export function upgradeBar(state: EconomyState): boolean {
  const cost = barUpgradeCost(state.barLevel);
  if (state.money < cost) return false;
  state.money -= cost;
  state.barLevel += 1;
  state.incomePerSecond = incomeForBarLevel(state.barLevel);
  return true;
}

export function barUpgradeCost(barLevel: number): number {
  return Math.round(25 * Math.pow(1.6, barLevel - 1));
}
