/**
 * Club Empire — economy model (DUB-4, Step 0).
 *
 * A greedy-buyer simulation of the §4.4 cost/income curve, written to be run
 * *before* any gameplay code exists. No dependencies:
 *
 *   npm run sim:economy                       # Regular guests only (the §4.4 table)
 *   node tools/economy-sim.ts --vip           # with the 1.40 average spend multiplier
 *   node tools/economy-sim.ts --arrivals=0.64 # override DOOR_BASE_ARRIVALS
 *   node tools/economy-sim.ts --price-scale=0.714  # scale every P1
 *   node tools/economy-sim.ts --purchases     # print the full purchase log
 *
 * Exits non-zero if any §4.4 row falls outside ±20% on wall-clock time, so the
 * default invocation doubles as a regression check on the constants.
 *
 * The buyer is intentionally dumb: every tick, among the purchases it can
 * currently afford, it buys the one with the best marginal income/s per unit
 * cost, and repeats until nothing affordable improves income. It never saves up
 * on purpose — it saves only because everything it can afford is worth nothing
 * to it yet. That is the behaviour we want from the dev-mode auto-buyer, so
 * this file is meant to survive into the real build.
 */

// ---------------------------------------------------------------------------
// Constants (§4.4)
// ---------------------------------------------------------------------------

const STARTING_CASH = 30;
const COST_GROWTH = 1.21; // R — upgrade cost multiplier per station level
const INCOME_GROWTH = 1.09; // M — drink price multiplier per station level
const STAR_LEVELS = [10, 20, 30];
const STAR_MULTIPLIER = 2;
const MAX_STATION_LEVEL = 30;
const MAX_LANES = 3;
const DOOR_MAX = 8;

const DOOR_ARRIVAL_GROWTH = 1.2;
const DOOR_COST_BASE = 60;
const DOOR_COST_GROWTH = 2.6;

/** 0.92 Regular x1.0 + 0.08 VIP x6.0. */
const VIP_SPEND_MULTIPLIER = 1.4;

interface StationDef {
  key: string;
  name: string;
  unlockCost: number;
  /** First upgrade cost. */
  c1: number;
  /** Drink price at level 1. */
  p1: number;
  /** Seconds to serve one guest, per lane. */
  serveTime: number;
  /** Cost of lanes 1..3. Lane 1 comes free with the unlock. */
  laneCosts: readonly [number, number, number];
}

const STATION_DEFS: readonly StationDef[] = [
  { key: 'tap', name: 'Tap Bar', unlockCost: 0, c1: 5, p1: 2, serveTime: 2.0, laneCosts: [0, 400, 3_200] },
  { key: 'cocktail', name: 'Cocktail Bar', unlockCost: 900, c1: 90, p1: 18, serveTime: 3.0, laneCosts: [0, 7_000, 56_000] },
  { key: 'booth', name: 'Booth Service', unlockCost: 18_000, c1: 900, p1: 150, serveTime: 4.5, laneCosts: [0, 140_000, 1_120_000] },
];

const TICKS_PER_SECOND = 10;
const TICK_SECONDS = 1 / TICKS_PER_SECOND;
const SIM_LIMIT_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function numericFlag(prefix: string, fallback: number): number {
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit === undefined) return fallback;
  const value = Number(hit.slice(prefix.length));
  if (!Number.isFinite(value)) throw new Error(`${prefix} needs a number, got "${hit}"`);
  return value;
}

const useVip = argv.includes('--vip');
const showPurchases = argv.includes('--purchases');
const DOOR_BASE_ARRIVALS = numericFlag('--arrivals=', 0.9);
/** Scales every station's P1 — use with --vip to cancel the uplift at source. */
const priceScale = numericFlag('--price-scale=', 1);
const spendMultiplier = (useVip ? VIP_SPEND_MULTIPLIER : 1) * priceScale;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StationState {
  def: StationDef;
  unlocked: boolean;
  level: number;
  lanes: number;
}

interface State {
  cash: number;
  door: number;
  stations: StationState[];
}

function createState(): State {
  return {
    cash: STARTING_CASH,
    door: 1,
    stations: STATION_DEFS.map((def, i) => ({
      def,
      unlocked: i === 0, // the Tap Bar is free at start, with lane 1
      level: 1,
      lanes: i === 0 ? 1 : 0,
    })),
  };
}

function cloneState(s: State): State {
  return {
    cash: s.cash,
    door: s.door,
    stations: s.stations.map((st) => ({ def: st.def, unlocked: st.unlocked, level: st.level, lanes: st.lanes })),
  };
}

/** Station lookup by key. Throws rather than returning undefined so callers stay readable. */
function station(s: State, key: string): StationState {
  const hit = s.stations.find((st) => st.def.key === key);
  if (hit === undefined) throw new Error(`no station "${key}"`);
  return hit;
}

// ---------------------------------------------------------------------------
// Formulae
// ---------------------------------------------------------------------------

function starsAtOrBelow(level: number): number {
  return STAR_LEVELS.filter((l) => l <= level).length;
}

function upgradeCost(st: StationState): number {
  return st.def.c1 * COST_GROWTH ** (st.level - 1);
}

function drinkPrice(st: StationState): number {
  return st.def.p1 * INCOME_GROWTH ** (st.level - 1) * STAR_MULTIPLIER ** starsAtOrBelow(st.level) * spendMultiplier;
}

function laneCost(def: StationDef, lane: number): number {
  const [first, second, third] = def.laneCosts;
  if (lane === 1) return first;
  if (lane === 2) return second;
  if (lane === 3) return third;
  throw new Error(`no lane ${lane} on ${def.name}`);
}

function arrivalsPerSecond(door: number): number {
  return DOOR_BASE_ARRIVALS * DOOR_ARRIVAL_GROWTH ** (door - 1);
}

function doorCost(door: number): number {
  return DOOR_COST_BASE * DOOR_COST_GROWTH ** (door - 1);
}

/** Guests per second a station can serve with the lanes it has. */
function capacity(st: StationState): number {
  return st.lanes / st.def.serveTime;
}

function totalCapacity(s: State): number {
  return s.stations.reduce((sum, st) => sum + (st.unlocked ? capacity(st) : 0), 0);
}

/**
 * The throughput rule — the whole design.
 *
 *   income/s = SUM over stations [ min(guests routed, lanes / serveTime) * drinkPrice ]
 *
 * Routing sends each guest to the highest-drink-price station with a free lane,
 * so in steady state the highest-price station fills its capacity first and the
 * remainder overflows down the price order. Per-station queues (max 4) and door
 * waiting buffer arrival jitter but cannot change the steady-state *rate*, so
 * they are deliberately not modelled here — they are a latency and animation
 * concern, not an income one.
 *
 * Station level buys cash per guest. Lanes and the Door buy guests per second.
 * The `min()` is what couples them, and it is why a level-only income model
 * would pass this simulation and ship a broken game.
 */
function incomePerSecond(s: State): number {
  const open = s.stations.filter((st) => st.unlocked && st.lanes > 0).sort((a, b) => drinkPrice(b) - drinkPrice(a));

  let remaining = arrivalsPerSecond(s.door);
  let income = 0;
  for (const st of open) {
    const served = Math.min(remaining, capacity(st));
    income += served * drinkPrice(st);
    remaining -= served;
  }
  return income;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

interface Purchase {
  label: string;
  cost: number;
  apply: (s: State) => void;
}

function availablePurchases(s: State): Purchase[] {
  const out: Purchase[] = [];

  for (const st of s.stations) {
    const { def, key } = { def: st.def, key: st.def.key };

    if (!st.unlocked) {
      out.push({
        label: `unlock ${def.name}`,
        cost: def.unlockCost,
        apply: (t) => {
          const target = station(t, key);
          target.unlocked = true;
          target.lanes = 1; // lane 1 is free with the unlock
        },
      });
      continue;
    }

    if (st.level < MAX_STATION_LEVEL) {
      const to = st.level + 1;
      out.push({
        label: `${def.name} L${st.level}->L${to}${STAR_LEVELS.includes(to) ? ' *' : ''}`,
        cost: upgradeCost(st),
        apply: (t) => {
          station(t, key).level += 1;
        },
      });
    }

    if (st.lanes < MAX_LANES) {
      const lane = st.lanes + 1;
      out.push({
        label: `${def.name} lane ${lane}`,
        cost: laneCost(def, lane),
        apply: (t) => {
          station(t, key).lanes += 1;
        },
      });
    }
  }

  if (s.door < DOOR_MAX) {
    out.push({
      label: `Door L${s.door}->L${s.door + 1}`,
      cost: doorCost(s.door),
      apply: (t) => {
        t.door += 1;
      },
    });
  }

  return out;
}

interface Choice {
  purchase: Purchase;
  ratio: number;
  gain: number;
}

/** The best affordable purchase by marginal income/s per unit cost, or null. */
function bestPurchase(s: State): Choice | null {
  const base = incomePerSecond(s);
  let best: Choice | null = null;

  for (const purchase of availablePurchases(s)) {
    if (purchase.cost > s.cash) continue;
    const probe = cloneState(s);
    purchase.apply(probe);
    const gain = incomePerSecond(probe) - base;
    if (gain <= 0) continue; // a zero-marginal buy is how the buyer learns to save
    const ratio = gain / Math.max(purchase.cost, 1e-9);
    if (best === null || ratio > best.ratio) best = { purchase, ratio, gain };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Milestones (§4.4 table)
// ---------------------------------------------------------------------------

interface Milestone {
  label: string;
  expectedMinutes: number;
  expectedIncome: number;
  met: (s: State) => boolean;
}

const MILESTONES: readonly Milestone[] = [
  { label: 'Tap L12', expectedMinutes: 1, expectedIncome: 5.2, met: (s) => station(s, 'tap').level >= 12 },
  { label: 'Tap L17', expectedMinutes: 2, expectedIncome: 7.9, met: (s) => station(s, 'tap').level >= 17 },
  { label: 'Tap L22', expectedMinutes: 3, expectedIncome: 24.4, met: (s) => station(s, 'tap').level >= 22 },
  {
    label: 'Tap lane 2 + Door L2',
    expectedMinutes: 3.5,
    expectedIncome: 58,
    met: (s) => station(s, 'tap').lanes >= 2 && s.door >= 2,
  },
  { label: 'Cocktail Bar unlocked', expectedMinutes: 4.4, expectedIncome: 91, met: (s) => station(s, 'cocktail').unlocked },
  {
    label: 'Tap L29, Cocktail L12, Door L4',
    expectedMinutes: 5,
    expectedIncome: 120,
    met: (s) => station(s, 'tap').level >= 29 && station(s, 'cocktail').level >= 12 && s.door >= 4,
  },
  { label: 'Tap Bar maxed L30 ***', expectedMinutes: 6, expectedIncome: 251, met: (s) => station(s, 'tap').level >= 30 },
  {
    label: 'Tap lane 3 + Door L5',
    expectedMinutes: 6.3,
    expectedIncome: 416,
    met: (s) => station(s, 'tap').lanes >= 3 && s.door >= 5,
  },
  {
    label: 'Cocktail lane 2 + Door L6',
    expectedMinutes: 7.3,
    expectedIncome: 641,
    met: (s) => station(s, 'cocktail').lanes >= 2 && s.door >= 6,
  },
  { label: 'Booth Service unlocked', expectedMinutes: 9, expectedIncome: 839, met: (s) => station(s, 'booth').unlocked },
  {
    label: 'Tap 30 / Cocktail 29 / Booth 14, Door L7',
    expectedMinutes: 10,
    expectedIncome: 1033,
    met: (s) =>
      station(s, 'tap').level >= 30 && station(s, 'cocktail').level >= 29 && station(s, 'booth').level >= 14 && s.door >= 7,
  },
  {
    label: 'Booth L27, Cocktail lane 3, Door L8',
    expectedMinutes: 15,
    expectedIncome: 3298,
    met: (s) => station(s, 'booth').level >= 27 && station(s, 'cocktail').lanes >= 3 && s.door >= 8,
  },
  {
    label: 'All L30, all 3 lanes, Door L8 — CLUB COMPLETE',
    expectedMinutes: 20,
    expectedIncome: 11783,
    met: (s) =>
      s.door >= DOOR_MAX &&
      s.stations.every((st) => st.unlocked && st.level >= MAX_STATION_LEVEL && st.lanes >= MAX_LANES),
  },
];

const CLUB_COMPLETE = 'All L30, all 3 lanes, Door L8 — CLUB COMPLETE';

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface PurchaseRecord {
  seconds: number;
  label: string;
  cost: number;
  gain: number;
}

const state = createState();
const reached = new Map<string, { seconds: number; income: number }>();
/** income/s sampled at each milestone's *expected* time, for an at-a-glance income column. */
const incomeAtExpected = new Map<string, number>();
const purchases: PurchaseRecord[] = [];

/**
 * Which side of the `min()` binds, counted in ticks. `doorBound` means arrivals
 * are below total lane capacity, so DOOR_BASE_ARRIVALS moves income;
 * `capacityBound` means lanes bind and the Door multiplier does nothing at all.
 */
const bottleneck = { doorBound: 0, capacityBound: 0 };

let elapsed = 0;

function recordMilestones(): void {
  for (const m of MILESTONES) {
    if (!reached.has(m.label) && m.met(state)) {
      reached.set(m.label, { seconds: elapsed, income: incomePerSecond(state) });
    }
  }
}

recordMilestones();

while (elapsed < SIM_LIMIT_SECONDS) {
  if (arrivalsPerSecond(state.door) < totalCapacity(state)) bottleneck.doorBound += 1;
  else bottleneck.capacityBound += 1;

  state.cash += incomePerSecond(state) * TICK_SECONDS;
  elapsed += TICK_SECONDS;

  for (;;) {
    const best = bestPurchase(state);
    if (best === null) break;
    state.cash -= best.purchase.cost;
    best.purchase.apply(state);
    purchases.push({ seconds: elapsed, label: best.purchase.label, cost: best.purchase.cost, gain: best.gain });
  }

  recordMilestones();

  for (const m of MILESTONES) {
    if (!incomeAtExpected.has(m.label) && elapsed >= m.expectedMinutes * 60) {
      incomeAtExpected.set(m.label, incomePerSecond(state));
    }
  }

  if (reached.has(CLUB_COMPLETE)) break;
}

// The run can finish before the last expected sample time. Once the club is
// complete income is flat, so the final rate is the honest value at that time.
for (const m of MILESTONES) {
  if (!incomeAtExpected.has(m.label)) incomeAtExpected.set(m.label, incomePerSecond(state));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmtMin = (s: number) => `${(s / 60).toFixed(2)} min`;
const fmtNum = (n: number) =>
  n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(n < 100 ? 1 : 0);
const pad = (v: string, w: number) => v.padEnd(w);
const padL = (v: string, w: number) => v.padStart(w);

console.log('\nClub Empire economy model — greedy buyer');
console.log(
  `spend multiplier ${spendMultiplier.toFixed(3)} (${useVip ? 'VIPs on' : 'Regular only'}` +
    `${priceScale === 1 ? '' : `, P1 scaled x${priceScale}`}), ` +
    `DOOR_BASE_ARRIVALS ${DOOR_BASE_ARRIVALS}, ${TICKS_PER_SECOND} ticks/s\n`,
);

console.log(
  pad('milestone', 44) +
    padL('design t', 10) +
    padL('sim t', 10) +
    padL('delta', 9) +
    padL('verdict', 9) +
    padL('design $/s', 12) +
    padL('sim $/s @hit', 14) +
    padL('sim $/s @design t', 19),
);
console.log('-'.repeat(127));

let passes = 0;
let fails = 0;
for (const m of MILESTONES) {
  const atExpected = incomeAtExpected.get(m.label);
  const sampled = padL(atExpected === undefined ? '—' : fmtNum(atExpected), 19);
  const expectedSeconds = m.expectedMinutes * 60;
  const hit = reached.get(m.label);

  if (hit === undefined) {
    fails += 1;
    console.log(
      pad(m.label, 44) +
        padL(fmtMin(expectedSeconds), 10) +
        padL('never', 10) +
        padL('—', 9) +
        padL('FAIL', 9) +
        padL(fmtNum(m.expectedIncome), 12) +
        padL('—', 14) +
        sampled,
    );
    continue;
  }

  const delta = (hit.seconds - expectedSeconds) / expectedSeconds;
  const ok = Math.abs(delta) <= 0.2;
  if (ok) passes += 1;
  else fails += 1;
  console.log(
    pad(m.label, 44) +
      padL(fmtMin(expectedSeconds), 10) +
      padL(fmtMin(hit.seconds), 10) +
      padL(`${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`, 9) +
      padL(ok ? 'pass' : 'FAIL', 9) +
      padL(fmtNum(m.expectedIncome), 12) +
      padL(fmtNum(hit.income), 14) +
      sampled,
  );
}

console.log('-'.repeat(127));
console.log(`${passes}/${MILESTONES.length} rows within +/-20% on wall-clock time, ${fails} outside.\n`);

// --- Sanity check 1: drift between consecutive Tap Bar level upgrades --------

const tapUpgrades = purchases.filter((p) => p.label.startsWith('Tap Bar L'));
if (tapUpgrades.length > 2) {
  console.log('Sanity check 1 — gap between consecutive Tap Bar level buys (R/M = 1.1101 expected)');
  console.log(pad('  level', 12) + padL('t', 10) + padL('gap', 9) + padL('gap ratio', 11));
  let prevSeconds: number | null = null;
  let prevGap: number | null = null;
  let level = 1;
  for (const up of tapUpgrades) {
    level += 1;
    if (prevSeconds !== null) {
      const gap = up.seconds - prevSeconds;
      const ratio = prevGap !== null && prevGap > 0 ? (gap / prevGap).toFixed(3) : '—';
      const star = up.label.endsWith('*') ? ' *' : '';
      console.log(pad(`  L${level - 1}->L${level}${star}`, 12) + padL(fmtMin(up.seconds), 10) + padL(`${gap.toFixed(1)}s`, 9) + padL(ratio, 11));
      prevGap = gap;
    }
    prevSeconds = up.seconds;
  }
  console.log('');
}

// --- Sanity check 2: the 6-7 min dead patch ---------------------------------

const tapMaxed = purchases.find((p) => p.label === 'Tap Bar L29->L30 *');
const cocktailUnlock = purchases.find((p) => p.label === 'unlock Cocktail Bar');
console.log('Sanity check 2 — the 6-7 min dead patch');
console.log(`  Cocktail Bar unlocked at   ${cocktailUnlock === undefined ? 'never' : fmtMin(cocktailUnlock.seconds)}`);
console.log(`  Tap Bar maxed at           ${tapMaxed === undefined ? 'never' : fmtMin(tapMaxed.seconds)}`);
if (tapMaxed !== undefined) {
  const next = purchases.find((p) => p.seconds > tapMaxed.seconds);
  console.log(
    `  next purchase after that   ${next === undefined ? 'none' : `${fmtMin(next.seconds)}  (${next.label})`}` +
      `${next === undefined ? '' : ` — idle gap ${(next.seconds - tapMaxed.seconds).toFixed(1)}s`}`,
  );
}

// The longest stretches with nothing worth buying, wherever they fall. These are
// the real dead patches — the 6-7 min window is only a guess at where one is.
const gaps: { gap: number; from: number; label: string; cost: number }[] = [];
let prev: PurchaseRecord | null = null;
for (const p of purchases) {
  if (prev !== null) gaps.push({ gap: p.seconds - prev.seconds, from: prev.seconds, label: p.label, cost: p.cost });
  prev = p;
}
gaps.sort((a, b) => b.gap - a.gap);
console.log('\n  longest no-purchase stretches in the whole run:');
for (const g of gaps.slice(0, 5)) {
  console.log(`    ${padL(`${g.gap.toFixed(1)}s`, 8)} from ${fmtMin(g.from)}  ended by ${pad(g.label, 28)} (cost ${fmtNum(g.cost)})`);
}
console.log('');

// --- Final state ------------------------------------------------------------

console.log(
  `Final: Door L${state.door}, ` +
    state.stations.map((st) => `${st.def.name} L${st.level}/${st.lanes} lanes`).join(', '),
);
console.log(`Final income/s ${fmtNum(incomePerSecond(state))}, total purchases ${purchases.length}`);

// Saturation at full build-out. The design intends arrivals to just exceed total
// capacity so the last lane is still worth buying. If capacity exceeds arrivals,
// some lane purchase is partly or wholly a dead buy.
const fullCapacity = STATION_DEFS.reduce((sum, def) => sum + MAX_LANES / def.serveTime, 0);
const maxArrivals = arrivalsPerSecond(DOOR_MAX);
console.log(
  `Full build-out capacity ${fullCapacity.toFixed(3)} guests/s vs Door L${DOOR_MAX} arrivals ${maxArrivals.toFixed(3)} guests/s -> ` +
    (maxArrivals >= fullCapacity
      ? 'saturated (no dead buy)'
      : `${(fullCapacity - maxArrivals).toFixed(3)} guests/s of DEAD capacity`),
);

const totalTicks = bottleneck.doorBound + bottleneck.capacityBound;
const doorPct = (bottleneck.doorBound / totalTicks) * 100;
console.log(
  `Bottleneck over the run: Door binding ${doorPct.toFixed(1)}% of ticks, lane capacity binding ${(100 - doorPct).toFixed(1)}%.`,
);
console.log('');

if (showPurchases) {
  console.log('Purchase log');
  for (const p of purchases) {
    console.log(`  ${padL(fmtMin(p.seconds), 10)}  ${pad(p.label, 30)} cost ${padL(fmtNum(p.cost), 10)}  +${fmtNum(p.gain)}/s`);
  }
  console.log('');
}

// Non-zero exit when any row falls outside ±20%, so this is usable as a check.
process.exitCode = fails > 0 ? 1 : 0;
