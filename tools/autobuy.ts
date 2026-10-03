/**
 * Acceptance criterion 1 — the dev-mode auto-buyer.
 *
 *   npm run sim:autobuy              # the shipping game, no tapping
 *   node tools/autobuy.ts --tap      # with a player collecting every bubble
 *   node tools/autobuy.ts --purchases
 *
 * The distinction from `npm run sim:economy` is the whole point. That one runs
 * the economy *model* — closed-form, no game state, and the thing DUB-4
 * actually reviewed. This one runs the **shipping game**: the real `ClubState`,
 * the real `tickClub`, the real `upgradeStation` / `buyLane` / `unlockStation` /
 * `upgradeDoor`, the real derived-flow cache. A model that matches the §4.4
 * table while the game does not is precisely the failure criterion 1 exists to
 * catch, and only this script can see it.
 *
 * Both read the same table from `src/config/pacing.ts`, so they cannot both
 * pass against different expectations.
 *
 * **The default run does not tap bubbles**, and that is deliberate. §4.4 was
 * authored and signed off against passive income, so the passive curve is what
 * the ±20% is measured on. `--tap` then shows how much a player who taps
 * everything accelerates it — which the design intends (Last Call exists to do
 * exactly that), and which is worth having a number for rather than a guess.
 *
 * Exits non-zero if any row falls outside ±20%, so it works as a CI gate.
 */

import { TICKS_PER_SECOND, TICK_SECONDS } from '../src/sim/constants.ts';
import {
  AVERAGE_SPEND_MULTIPLIER,
  MAX_BUBBLES_ON_SCREEN,
  LAST_CALL_DURATION_SECONDS,
  incomePerSecond,
} from '../src/config/economy.ts';
import {
  CLUB_COMPLETE_LABEL,
  MILESTONES,
  PACING_TOLERANCE,
  pacingError,
  withinTolerance,
} from '../src/config/pacing.ts';
import {
  applyPurchase,
  collectBubble,
  createClubState,
  progressOf,
  tickClub,
  type ClubState,
} from '../src/sim/clubState.ts';

const argv = process.argv.slice(2);
const TAP = argv.includes('--tap');
const SHOW_PURCHASES = argv.includes('--purchases');

/** Hard stop, so a balance change that stalls the curve fails instead of hanging. */
const MAX_MINUTES = 90;

interface PurchaseRecord {
  seconds: number;
  label: string;
  cost: number;
}

interface Reached {
  seconds: number;
  incomePerSecond: number;
}

/**
 * The buyer.
 *
 * Deliberately dumb: buy the cheapest available purchase the moment it is
 * affordable, which is `ClubState`'s own `nextPurchase` — the same thing the
 * §4.4b outline fill tracks. It never saves up on purpose. A cleverer buyer
 * would beat the table and tell us nothing about what a player experiences.
 */
function run(): {
  club: ClubState;
  reached: Map<string, Reached>;
  purchases: PurchaseRecord[];
  seconds: number;
  lastCallSeconds: number;
} {
  const club = createClubState();
  const reached = new Map<string, Reached>();
  const purchases: PurchaseRecord[] = [];

  let ticks = 0;
  let lastCallTicks = 0;
  const maxTicks = MAX_MINUTES * 60 * TICKS_PER_SECOND;

  while (ticks < maxTicks) {
    tickClub(club);
    ticks += 1;
    if (club.lastCallRemaining > 0) lastCallTicks += 1;

    if (TAP) {
      // A player tapping everything the moment it appears. The spawner caps the
      // rate at one bubble per interval, so this is the ceiling a real player
      // can reach, not an unbounded stream.
      for (let i = 0; i < MAX_BUBBLES_ON_SCREEN; i += 1) {
        collectBubble(club, i);
      }
    }

    // Spend down to nothing, in case income or a tip covers several at once.
    for (;;) {
      const next = club.derived.nextPurchase;
      if (next === null || club.cash < next.cost) break;
      if (applyPurchase(club, next) !== 'bought') break;
      purchases.push({ seconds: ticks * TICK_SECONDS, label: describe(club, next), cost: next.cost });
    }

    const progress = progressOf(club);
    for (const milestone of MILESTONES) {
      if (reached.has(milestone.label)) continue;
      if (!milestone.met(progress)) continue;
      reached.set(milestone.label, {
        seconds: ticks * TICK_SECONDS,
        // Priced Regular-only, as the §4.4 income column is specified.
        incomePerSecond: incomePerSecond(progress, { spendMultiplier: 1 }),
      });
    }

    if (reached.has(CLUB_COMPLETE_LABEL)) break;
  }

  return {
    club,
    reached,
    purchases,
    seconds: ticks * TICK_SECONDS,
    lastCallSeconds: lastCallTicks * TICK_SECONDS,
  };
}

function describe(club: ClubState, next: NonNullable<ClubState['derived']['nextPurchase']>): string {
  if (next.kind === 'door') return `Door -> L${club.doorLevel}`;
  const station = club.stations.find((st) => st.key === next.station);
  if (next.kind === 'unlock') return `unlock ${next.station}`;
  if (next.kind === 'lane') return `${next.station} lane ${next.lane}`;
  return `${next.station} -> L${station?.level ?? '?'}`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function num(value: number): string {
  return value >= 1000 ? Math.round(value).toLocaleString('en-GB') : value.toPrecision(3);
}

const result = run();

console.log('');
console.log(`Club Empire — auto-buyer against the shipping ClubState`);
console.log(`  bubble tapping: ${TAP ? 'ON (every bubble, as fast as it spawns)' : 'OFF (passive income only)'}`);
console.log(
  `  guest mix:      VIPs on (option (a)), average spend x${AVERAGE_SPEND_MULTIPLIER.toFixed(2)} — income column priced Regular-only to match §4.4`,
);
console.log('');

/**
 * Two baselines, because the §4.4 table and the shipping game are not run under
 * the same guest mix.
 *
 * The table's times were authored and signed off with **Regular guests only**.
 * The game ships with **VIPs on (option (a))**, which multiplies income by
 * `AVERAGE_SPEND_MULTIPLIER` (1.40) at every point while leaving the cost curve
 * untouched — so every milestone arrives at `1 / 1.40` = 71.4% of its table
 * time. DUB-4 recorded and accepted that: "VIPs make the whole curve ~30%
 * faster (club complete at ~13.8 min rather than ~19.4)".
 *
 * So comparing the shipping run straight against the table measures the VIP
 * decision, not the code, and would read as a 13-row failure for a reason
 * nobody needs to fix. The gate is the **option (a) prediction** — the table
 * scaled by that factor — which is what actually tests whether the shipping
 * state machine reproduces the model DUB-4 reviewed. The raw delta is printed
 * beside it so the design decision stays visible rather than buried in a
 * scaling factor.
 */
const VIP_TIME_FACTOR = 1 / AVERAGE_SPEND_MULTIPLIER;

console.log(
  pad('milestone', 46) +
    padLeft('§4.4', 8) +
    padLeft('opt(a)', 9) +
    padLeft('actual', 9) +
    padLeft('vs opt(a)', 11) +
    padLeft('vs §4.4', 9) +
    padLeft('result', 8) +
    padLeft('income/s', 11),
);
console.log('-'.repeat(111));

let passes = 0;
let fails = 0;
let rawPasses = 0;
const missing: string[] = [];

for (const milestone of MILESTONES) {
  const predicted = milestone.expectedMinutes * VIP_TIME_FACTOR;
  const hit = result.reached.get(milestone.label);

  if (hit === undefined) {
    missing.push(milestone.label);
    fails += 1;
    console.log(
      pad(milestone.label, 46) +
        padLeft(milestone.expectedMinutes.toFixed(2), 8) +
        padLeft(predicted.toFixed(2), 9) +
        padLeft('never', 9) +
        padLeft('—', 11) +
        padLeft('—', 9) +
        padLeft('MISS', 8) +
        padLeft('—', 11),
    );
    continue;
  }

  const actualMinutes = hit.seconds / 60;
  const error = pacingError(predicted, actualMinutes);
  const rawError = pacingError(milestone.expectedMinutes, actualMinutes);
  const ok = withinTolerance(predicted, actualMinutes);

  if (ok) passes += 1;
  else fails += 1;
  if (withinTolerance(milestone.expectedMinutes, actualMinutes)) rawPasses += 1;

  console.log(
    pad(milestone.label, 46) +
      padLeft(milestone.expectedMinutes.toFixed(2), 8) +
      padLeft(predicted.toFixed(2), 9) +
      padLeft(actualMinutes.toFixed(2), 9) +
      padLeft(`${error >= 0 ? '+' : ''}${(error * 100).toFixed(1)}%`, 11) +
      padLeft(`${rawError >= 0 ? '+' : ''}${(rawError * 100).toFixed(0)}%`, 9) +
      padLeft(ok ? 'pass' : 'FAIL', 8) +
      padLeft(num(hit.incomePerSecond), 11),
  );
}

const tolerancePercent = (PACING_TOLERANCE * 100).toFixed(0);
console.log('');
console.log(
  `${passes}/${MILESTONES.length} rows within +/-${tolerancePercent}% of the option (a) prediction (§4.4 x ${VIP_TIME_FACTOR.toFixed(3)}), ${fails} outside.`,
);
console.log(
  `${rawPasses}/${MILESTONES.length} rows within +/-${tolerancePercent}% of the raw §4.4 times — the shortfall is the VIP multiplier DUB-4 accepted, not a code defect.`,
);

const complete = result.reached.get(CLUB_COMPLETE_LABEL);
console.log('');
console.log(`Club complete at      ${complete ? `${(complete.seconds / 60).toFixed(2)} min` : 'never'}`);
console.log(`Purchases made        ${result.club.purchaseCount}`);
console.log(
  `Final income/s        ${num(incomePerSecond(progressOf(result.club), { spendMultiplier: 1 }))} (Regular-only), ` +
    `${num(result.club.derived.baseIncomePerSecond)} (with VIPs)`,
);
console.log(`Bubbles collected     ${result.club.bubblesCollected}`);
console.log(
  `Last Call fired       ${result.club.lastCallFiredCount}x, active ${result.lastCallSeconds.toFixed(0)}s of ` +
    `${result.seconds.toFixed(0)}s (${((result.lastCallSeconds / result.seconds) * 100).toFixed(1)}% of the run)`,
);

const flow = result.club.derived.flow;
console.log(
  `Final throughput      ${flow.servedPerSecond.toFixed(3)} served/s of ${flow.arrivalsPerSecond.toFixed(3)} arriving/s` +
    (flow.turnedAwayPerSecond > 0.001 ? ` — ${flow.turnedAwayPerSecond.toFixed(3)}/s queued` : ' — no queue'),
);

if (TAP) {
  console.log('');
  console.log(
    `Tapping is expected to beat the table: Last Call is a x3 for ${LAST_CALL_DURATION_SECONDS}s and the\n` +
      `design asks for it. The +/-20% criterion is measured on the passive run above.`,
  );
}

if (SHOW_PURCHASES) {
  console.log('');
  console.log('Purchase log');
  for (const purchase of result.purchases) {
    console.log(
      `  ${padLeft(purchase.seconds.toFixed(1), 8)}s  ${pad(purchase.label, 26)} ${padLeft(num(purchase.cost), 12)}`,
    );
  }
}

console.log('');

// Non-zero exit on a pacing regression, but only for the passive run — the
// tapping run is informational and is *meant* to be faster than the table.
if (!TAP && fails > 0) {
  console.error(
    `FAIL: ${fails} row(s) outside +/-${(PACING_TOLERANCE * 100).toFixed(0)}%` +
      (missing.length > 0 ? `; never reached: ${missing.join(', ')}` : ''),
  );
  process.exit(1);
}
