/**
 * Does the boot progress bar actually reach the screen once the load passes 1 s?
 *
 *   CLUB_URL=http://127.0.0.1:4173/club-empire node tools/boot-progress.ts 1 6 10 20
 *
 * DUB-21: the bar was gated by a `setTimeout` scheduled from the boot screen's
 * effect, and on a slow load that timer never ran. Not because it was wrong, but
 * because `startGame` holds the main thread in long tasks for the whole boot
 * window — so the timer came due while the thread was busy and the boot screen
 * had already unmounted by the time it was free. The bar therefore appeared only
 * on loads where `.boot` mounted *after* t=1000 and the `useState` initializer
 * caught it, which is the opposite of the case the threshold exists for.
 *
 * This script is the regression instrument, and it measures two different things
 * on purpose:
 *
 *  - `missingDomMs` — *milliseconds* in which `.boot` is mounted at t >= 1000
 *    and `.boot__progress` is not in the DOM. This is the verdict, and it is
 *    QA's acceptance criterion (`qa-harness/scripts/boot-progress-timeline.mjs`).
 *    Elapsed time rather than sampled frames, for the reason in `report()`.
 *  - `missingPaint` — of the frames the probe *did* get to sample, how many had
 *    the bar in the DOM but still fully transparent. A corroborating signal and
 *    not a proof: it is counted from `requestAnimationFrame`, and a blocked main
 *    thread fires no rAF, so on exactly the loads this ticket is about there are
 *    one or two samples at most and `missingPaint === 0` is close to vacuous.
 *    Read the `dark/seen` column together: a 0 out of 0 says nothing.
 *
 * Proof that the reveal reaches the *screen* through a blocked thread has to
 * come from outside the renderer's main thread, so it is out of band here:
 * `Page.startScreencast` keeps delivering compositor frames through a 700 ms
 * long task, and correlates to page time via `performance.timeOrigin`. Both the
 * DUB-21 fix and its review used it to watch the fade and the sweep advance
 * while the thread was blocked. Reading it needs JPEG decoding and a judgement
 * about pixels, which is a human's job and not a CI gate's — this script gates
 * the thing it can gate honestly, and says so.
 *
 * Needs a preview server and a headless Chrome with `--remote-debugging-port`,
 * the same pair `npm run measure:frames` uses — and the preview server's base
 * path in `CLUB_URL`, because `dist/` is built for `/club-empire/`. CPU
 * throttling is applied through CDP, which is the only knob here that moves the
 * boot window across the 1 s gate — mount time, not the throttle rate, is what
 * decides the outcome.
 *
 * Exit status:
 *
 *   0  every load that reached the measured condition passed
 *   1  at least one load was owed a bar and did not have one
 *   2  usage
 *   3  at least one load produced no measurement at all — the boot screen never
 *      appeared, or no load was still booting at the threshold. On those rows
 *      the instrument has no opinion, and an instrument with no opinion must
 *      not report a pass. That false green is the same one the first,
 *      frame-counting version of this file produced.
 */

import { pathToFileURL } from 'node:url';
import { Cdp, pageTarget, sleep } from './cdp.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:4173';

/**
 * A single CDP call may take this long before it counts as hung.
 *
 * Longer than the shared default, because this is the only tool that drives the
 * page at 20x CPU throttling: a `Page.navigate` under that is slow on purpose,
 * and a timeout tuned for an unthrottled tool would fire on a healthy run.
 */
const CDP_TIMEOUT_MS = 180_000;

/** Same threshold the component uses. Kept as a literal: this is the oracle. */
const GATE_MS = 1000;

/** One frame of slack at the gate, so a sample landing on it is not a failure. */
const GRACE_MS = 32;

/**
 * A positive-number knob off the environment.
 *
 * Unset and empty both mean the default: `Number('')` is 0, and `CLUB_BOOT_WAIT_MS=`
 * collapsing the wait budget to zero would have every load report `no-boot` for
 * a reason that is nowhere on screen. A value that is present but not a positive
 * number is an error rather than a default — the caller plainly meant to set
 * something, and quietly ignoring them is the same silence this tool exists to
 * not keep.
 */
export function envCount(name: string, fallback: number, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a positive number`);
  }
  return value;
}

/** How many times to repeat each rate. The failure was intermittent by nature. */
const repeats = (): number => envCount('CLUB_BOOT_REPEATS', 1, process.env.CLUB_BOOT_REPEATS);

/**
 * How long to let a measured load run before reading its record back.
 *
 * Scaled with the throttle rate, because that is what it slows down. Overridable
 * because the floor of what a cold load costs is the host's, not ours: a load
 * that has not reached the boot screen inside the budget reports `no-boot` and
 * fails the run rather than being averaged away, so there has to be a knob.
 */
const waitMsFor = (rate: number): number =>
  envCount('CLUB_BOOT_WAIT_MS', Math.max(5_000, 1_000 * rate), process.env.CLUB_BOOT_WAIT_MS);

const RATES = process.argv.slice(2).map(Number).filter(Number.isFinite);

interface Sample {
  t: number;
  boot: boolean;
  bar: boolean;
  opacity: number;
  /** The inlined `#boot-fallback`. Still up at the end means React never ran. */
  fallback: boolean;
}

interface Timeline {
  samples: Sample[];
  events: { t: number; name: string }[];
  longTasks: { start: number; dur: number }[];
  /**
   * When the probe last wrote its record, and what was on the page then.
   *
   * The honest end of a boot window that never closed. `samples.at(-1).t` cannot
   * play that role: it is a `requestAnimationFrame` timestamp, so on the blocked
   * thread this tool exists to measure it stops advancing while the boot screen
   * is still up — and a window that ends at the last frame is a window that ends
   * when the evidence ran out rather than when the thing did. Written from
   * `pagehide`, an event-loop task that runs when the driver navigates away, so
   * it lands at the end of the wait budget however little the thread yielded.
   */
  savedAt?: number;
  fallbackAtSave?: boolean;
}

interface RunReport {
  rate: number;
  repeat: number;
  bootFrom: number | null;
  bootTo: number | null;
  barFrom: number | null;
  /** Ms the boot screen was on screen past the threshold, and so owed a bar. */
  owedMs: number;
  /** Of those, ms with no `.boot__progress` in the DOM. The acceptance figure. */
  missingDomMs: number;
  /** Frames inside the owed window the probe actually got to sample. */
  samples: number;
  /** Of those, frames where the bar was in the DOM but fully transparent. */
  missingPaint: number;
  busyMsAfterGate: number;
  /** `#boot-fallback` was still on the page when the probe wrote its record. */
  fallbackStuck: boolean;
  /**
   * `pass`/`fail` are verdicts. The other two are not:
   *
   *  - `n/a` — the load finished before the threshold, so no bar was owed and
   *    a bar there would be the defect rather than the fix. Nothing measured.
   *  - `no-boot` — `.boot` never entered the DOM, so the page under measurement
   *    was not the one we meant to measure. Nothing measured, and an error.
   */
  verdict: 'pass' | 'fail' | 'n/a' | 'no-boot';
}


/**
 * Wait for the quiet page to actually be the quiet page.
 *
 * A fixed sleep after `Page.navigate` is a guess about the host, not about the
 * page, and on a loaded box the guess is wrong: the document is still the opaque
 * `about:blank` origin when the budget runs out, and reading `localStorage` off
 * it throws `SecurityError`. That is a measurement the instrument never took,
 * dressed as a failure of the thing being measured — which is the mistake this
 * whole tool is an apology for. So wait on the condition instead of on a clock.
 *
 * Only for the unthrottled bookend pages. The measured load keeps its fixed
 * budget, because there the elapsed time *is* the subject.
 */
async function quietPageReady(cdp: Cdp, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const ok = await cdp.evaluate<boolean>(
        "return location.origin !== 'null' && document.readyState !== 'loading';",
      );
      if (ok) return;
    } catch {
      // Same-document-less window mid-navigation: not ready, not yet an error.
    }
    if (Date.now() > deadline) throw new Error(`the quiet page never settled before ${what}`);
    await sleep(100);
  }
}

/**
 * The in-page probe, installed before a byte of the bundle has run.
 *
 * It parks its result in `localStorage` rather than waiting to be read, because
 * by the time the boot screen is gone the running game owns the main thread and
 * a `Runtime.evaluate` against it can take tens of seconds. The driver reads the
 * record back from a quiet `?noboot=1` page instead.
 */
const PROBE = `
(() => {
  const timeline = { samples: [], events: [], longTasks: [] };
  window.__clubBootTimeline = timeline;

  let boot = false;
  let bar = false;

  const read = () => {
    const bootEl = document.querySelector('.boot');
    const barEl = document.querySelector('.boot__progress');
    return {
      t: Math.round(performance.now()),
      boot: Boolean(bootEl),
      bar: Boolean(barEl),
      opacity: barEl ? Number(getComputedStyle(barEl).opacity) : 0,
      fallback: Boolean(document.querySelector('#boot-fallback')),
    };
  };

  const save = () => {
    // Stamped here, not read off the last frame: this is the one clock in the
    // probe that a blocked main thread cannot stop. See \`Timeline.savedAt\`.
    timeline.savedAt = Math.round(performance.now());
    timeline.fallbackAtSave = Boolean(document.querySelector('#boot-fallback'));
    try { localStorage.setItem('__clubBootTimeline', JSON.stringify(timeline)); } catch {}
  };

  const edges = (sample) => {
    if (sample.boot !== boot) {
      boot = sample.boot;
      timeline.events.push({ t: sample.t, name: boot ? 'boot-mount' : 'boot-unmount' });
      // Flushed on the unmount edge: everything the criterion cares about has
      // happened by then, and the game is about to take the thread.
      if (!boot) save();
    }
    if (sample.bar !== bar) {
      bar = sample.bar;
      timeline.events.push({ t: sample.t, name: bar ? 'bar-in-dom' : 'bar-out-of-dom' });
    }
  };

  // Sampled per frame *and* on every mutation: a frame is what the player sees,
  // and a mutation is where the mount/unmount edges actually are. Under a
  // blocked main thread neither fires, which is the whole problem — so the
  // long-task list is recorded next to them to make that visible.
  const frame = () => {
    const sample = read();
    timeline.samples.push(sample);
    edges(sample);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  new MutationObserver(() => { edges(read()); }).observe(document, {
    childList: true, subtree: true, attributes: true,
  });

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        timeline.longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}

  window.addEventListener('pagehide', save);
  setTimeout(save, 15000);
})();
`;

/** Main-thread time spent inside long tasks while the boot screen was overdue a bar. */
function busyAfterGate(timeline: Timeline, from: number, to: number): number {
  const start = Math.max(from, GATE_MS);
  if (to <= start) return 0;
  let busy = 0;
  for (const task of timeline.longTasks) {
    const overlap = Math.min(to, task.start + task.dur) - Math.max(start, task.start);
    if (overlap > 0) busy += overlap;
  }
  return Math.round(busy);
}

/**
 * Judged on elapsed time, not on how many frames happened to get sampled.
 *
 * Counting sampled frames is the trap this whole ticket sits in. The main thread
 * is blocked for most of a slow boot window, so `requestAnimationFrame` does not
 * run — and a window with no samples in it scores zero missing frames and reads
 * as a pass. That is exactly how a bar that was never in the DOM at all came
 * back green. The mount/unmount edges come from a `MutationObserver` instead,
 * which runs as a microtask of whichever task did the mutating and therefore
 * cannot be starved into silence.
 */
export function report(rate: number, repeat: number, timeline: Timeline): RunReport {
  const at = (name: string): number | null => timeline.events.find((e) => e.name === name)?.t ?? null;
  const bootFrom = at('boot-mount');
  const bootTo = at('boot-unmount');
  const barFrom = at('bar-in-dom');
  const barTo = at('bar-out-of-dom');

  // When observation stopped. `savedAt` first and the last frame only as a
  // fallback: a boot screen that never unmounted was up until the probe was
  // navigated away from, not until the last frame it managed to sample. Scoring
  // it off frames made a 20 s boot window read `owed 0 ms, n/a` — measured here,
  // 20x CPU, `.boot` up from 620 and never unmounted, frames stopping near the
  // threshold. `n/a` is not a measurement, so a *missing* bar on that path would
  // have been dropped from the tally instead of failing it. That is this
  // ticket's own defect wearing the instrument's clothes.
  const observedTo = timeline.savedAt ?? timeline.samples.at(-1)?.t ?? GATE_MS;

  // A boot that ended before the threshold is owed nothing, and a bar there
  // would be the defect rather than the fix.
  const owedFrom = Math.max(GATE_MS, bootFrom ?? GATE_MS);
  const owedTo = bootTo ?? observedTo;
  const owedMs = bootFrom === null ? 0 : Math.max(0, owedTo - owedFrom);

  // The bar's own window, clipped to the window it was owed in. Its end takes
  // the same clock for the same reason — and the edges themselves are safe
  // either way, because a `MutationObserver` runs as a microtask of whichever
  // task mutated the DOM and so cannot be starved into silence.
  const barWindowFrom = barFrom ?? Number.POSITIVE_INFINITY;
  const barWindowTo = barTo ?? observedTo;
  const covered = Math.max(
    0,
    Math.min(owedTo, barWindowTo) - Math.max(owedFrom, barWindowFrom),
  );
  const missingDomMs = Math.round(Math.max(0, owedMs - covered));

  // Visibility, where there are frames to judge it on. Measured from when the
  // reveal can first have started — the threshold, or the mount on a load that
  // was already past it — so a sample taken mid-fade is not a missing bar.
  const owedSamples = timeline.samples.filter((s) => s.boot && s.t >= owedFrom + GRACE_MS);
  const missingPaint = owedSamples.filter((s) => s.bar && s.opacity <= 0).length;

  return {
    rate,
    repeat,
    bootFrom,
    bootTo,
    barFrom,
    owedMs,
    missingDomMs,
    samples: owedSamples.length,
    missingPaint,
    busyMsAfterGate: busyAfterGate(timeline, bootFrom ?? 0, owedTo),
    // Same clock again: this drives the "the bundle never executed" diagnosis,
    // and reading it off the last frame makes it a claim about when the frames
    // stopped rather than about what was on the page at the end.
    fallbackStuck: (timeline.fallbackAtSave ?? timeline.samples.at(-1)?.fallback) === true,
    verdict:
      // `.boot` never in the DOM is not a boot that was too fast to need a bar.
      // It is a page that did not run our bundle, and the instrument has to be
      // able to tell those apart or a broken URL reads as a clean run.
      bootFrom === null
        ? 'no-boot'
        : owedMs <= GRACE_MS
          ? 'n/a'
          : missingDomMs <= GRACE_MS && missingPaint === 0
            ? 'pass'
            : 'fail',
  };
}

/**
 * What the run as a whole comes to, and the status it exits with.
 *
 * Separated out and exported so it can be asserted rather than demonstrated:
 * this is the part that was wrong at `c37868d`, where a run of eight rows that
 * all read `.boot window: never` printed a cheerful summary and exited 0. The
 * rule is that only a measurement can produce a pass — `pass` and `fail` are
 * measurements, `n/a` and `no-boot` are not, and a run with none of the former
 * has no opinion and must not be mistaken for agreement.
 */
export function tally(reports: readonly RunReport[]): {
  failures: RunReport[];
  unbooted: RunReport[];
  overdue: RunReport[];
  code: 0 | 1 | 3;
} {
  const failures = reports.filter((r) => r.verdict === 'fail');
  const unbooted = reports.filter((r) => r.verdict === 'no-boot');
  const overdue = reports.filter((r) => r.verdict === 'pass' || r.verdict === 'fail');
  const code = failures.length > 0 ? 1 : unbooted.length > 0 || overdue.length === 0 ? 3 : 0;
  return { failures, unbooted, overdue, code };
}

/**
 * The word the summary leads with.
 *
 * Separate from `tally` because the exit code and the sentence answer different
 * questions, and conflating them produced a third wrong summary: a run of four
 * measured passes and one unreadable load exits 3 — correctly, an unreadable
 * load is not absorbed by its neighbours — but printing `NO MEASUREMENT` over
 * "4 of 12 loads were still booting at the threshold" contradicts the table
 * directly above it. `INCOMPLETE` is the honest word for a run that measured
 * something and could not measure all of it; `NO MEASUREMENT` is reserved for a
 * run that measured nothing, which is a different thing to go and fix.
 */
export function headlineFor(
  reports: readonly RunReport[],
): 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NO MEASUREMENT' {
  const { failures, overdue, code } = tally(reports);
  if (code === 0) return 'PASS';
  if (failures.length > 0) return 'FAIL';
  return overdue.length > 0 ? 'INCOMPLETE' : 'NO MEASUREMENT';
}

async function measure(cdp: Cdp, rate: number, repeat: number): Promise<RunReport> {
  // Unthrottled quiet page: clearing here rather than on the measured load keeps
  // a previous run's save (and its offline card) out of the boot path.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
  await quietPageReady(cdp, 'clearing the previous save');
  await cdp.evaluate('localStorage.clear(); return true;');
  await cdp.send('Network.clearBrowserCache');

  // Installed for exactly one load and removed again. `?noboot=1` is dev-only,
  // so on a production build the page we read the record back from boots the
  // game too — and with the probe still installed it would file its own fast,
  // unthrottled timeline over the measured one. (It did: every rate reported a
  // ~90 ms boot window until this was fixed.)
  const probe = await cdp.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
    source: PROBE,
  });

  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await sleep(waitMsFor(rate));

  // Throttle off *before* the bookkeeping call, not after. By now the game owns
  // the main thread, and asking a renderer that is both throttled and busy to
  // acknowledge anything is how a run dies of its own measurement: on a loaded
  // box this exact call sat for the full 180 s CDP budget and took the run with
  // it. Still before the navigate, though — the probe has to be gone before the
  // next document exists, or the quiet page installs it and files its own fast
  // timeline over the measured one.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });

  // Read from a fresh page, not from the measured one: the game owns the main
  // thread by now and a `Runtime.evaluate` against it waits tens of seconds.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
  await quietPageReady(cdp, 'reading the timeline back');
  const raw = await cdp.evaluate<string | null>(
    "return localStorage.getItem('__clubBootTimeline');",
  );
  if (raw === null) throw new Error(`no timeline recorded at ${rate}x (did the bundle load?)`);

  return report(rate, repeat, JSON.parse(raw) as Timeline);
}

function row(r: RunReport): string {
  const window = r.bootFrom === null ? 'never' : `${r.bootFrom} → ${r.bootTo ?? 'still up'}`;
  const bar = r.barFrom === null ? 'never' : `from ${r.barFrom}`;
  return (
    `  ${`${r.rate}x`.padEnd(5)}${String(r.repeat).padEnd(4)}` +
    `${window.padEnd(18)}${bar.padEnd(13)}` +
    `${`${r.owedMs} ms`.padStart(8)}${`${r.missingDomMs} ms`.padStart(10)}` +
    `${`${r.missingPaint}/${r.samples}`.padStart(11)}${`${r.busyMsAfterGate} ms`.padStart(9)}  ${r.verdict}`
  );
}

async function main(): Promise<void> {
  if (RATES.length === 0) {
    console.error('usage: node tools/boot-progress.ts <cpuRate...>   (e.g. 1 6 10 20)');
    process.exit(2);
  }

  const cdp = await Cdp.connect(await pageTarget(), CDP_TIMEOUT_MS);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  console.log('');
  console.log('Club Empire — boot progress bar against the 1 s gate');
  console.log(`  url     ${BASE_URL}`);
  console.log(`  gate    ${GATE_MS} ms from the navigation time origin (+${GRACE_MS} ms frame grace)`);
  console.log(
    `  wait    ${RATES.map((r) => `${r}x:${waitMsFor(r)}ms`).join('  ')}  (CLUB_BOOT_WAIT_MS)`,
  );
  console.log('');
  console.log(
    `  ${'cpu'.padEnd(5)}${'rep'.padEnd(4)}${'.boot window'.padEnd(18)}${'.boot__progress'.padEnd(13)}` +
      `${'owed'.padStart(8)}${'missing'.padStart(10)}${'dark/seen'.padStart(11)}${'busy'.padStart(9)}  verdict`,
  );
  console.log(`  ${'-'.repeat(86)}`);

  const reports: RunReport[] = [];
  for (const rate of RATES) {
    for (let repeat = 1; repeat <= repeats(); repeat += 1) {
      const result = await measure(cdp, rate, repeat);
      reports.push(result);
      console.log(row(result));
    }
  }

  const { failures, unbooted, overdue, code } = tally(reports);
  console.log(`  ${'-'.repeat(86)}`);
  console.log('');
  // The verdict leads. The counts alone read the same whether the run passed or
  // not — "0 of 8 loads were still booting at the threshold" is the shape of the
  // false green this tool shipped twice, and it should not be the first thing a
  // reader has to interpret.
  const summary =
    `  ${headlineFor(reports)} — ${overdue.length} of ${reports.length} loads were still ` +
    `booting at the threshold; ${failures.length} failed` +
    `${unbooted.length > 0 ? `; ${unbooted.length} unreadable` : ''}.`;
  if (code === 0) console.log(summary);
  else console.error(summary);
  console.log('  owed/missing are ms of the boot screen past the threshold, not frame counts:');
  console.log('  a blocked main thread samples no frames, and a window with no samples in it');
  console.log('  scores zero missing frames whatever is on screen. `dark/seen` is the frames');
  console.log('  that were sampled, and how many of them had the bar present but transparent —');
  console.log('  corroborating, not proof: 0 out of 0 says nothing, which is the usual case on');
  console.log('  the slow loads this measures. `busy` is main-thread time inside long tasks');
  console.log('  after the threshold — the reason a timer-gated bar never appeared. A CSS-gated');
  console.log('  one does not need the thread.');
  console.log('');

  if (unbooted.length > 0) {
    console.error(
      `  ${unbooted.length} of ${reports.length} load(s) never put \`.boot\` in the DOM at all,`,
    );
    console.error('  so there was nothing to measure on them. Not a pass — no measurement is not');
    console.error('  a good measurement, which is the whole lesson of this ticket.');
    if (unbooted.every((r) => r.fallbackStuck)) {
      // `main.tsx` removes `#boot-fallback` in the same task as React's first
      // commit, so the fallback still being up at the end means the bundle's
      // module body never got that far. Two causes, and the script cannot tell
      // them apart from here, so it names both rather than guessing.
      console.error('');
      console.error('  `#boot-fallback` was still up at the end of every one, so the bundle never');
      console.error('  executed. Either:');
      console.error('');
      console.error(`   - ${BASE_URL} is not serving the built JavaScript. This is the one that`);
      console.error('     has actually happened: `vite preview` on a base the build does not use');
      console.error('     answers the module path with the SPA fallback, so the script arrives as');
      console.error('     `text/html`, is refused, and React never mounts. `dist/` is built for');
      console.error('     /club-empire/, so CLUB_URL needs that path on it. Check with:');
      console.error(`       curl -so /dev/null -w '%{content_type}\\n' <the module dist asks for>`);
      console.error('   - or the load did not get there inside the wait budget. Raise it with');
      console.error('     CLUB_BOOT_WAIT_MS.');
    }
    console.error('');
  }

  if (overdue.length === 0 && unbooted.length === 0) {
    console.error('  Nothing was measured: every load finished before the threshold, so no frame');
    console.error('  was owed a bar and there is nothing to have an opinion about. This is not a');
    console.error('  pass either. Raise the CPU throttle rates until a load crosses the gate.');
    console.error('');
  }

  if (process.env.CLUB_BOOT_JSON !== undefined && process.env.CLUB_BOOT_JSON !== '') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.CLUB_BOOT_JSON, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
    console.log(`  wrote ${process.env.CLUB_BOOT_JSON}`);
    console.log('');
  }

  cdp.close();
  if (code !== 0) process.exit(code);
}

// Only when run as a script, so `bootProgressTally.test.ts` can import `tally`
// without driving a browser.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
