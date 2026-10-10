/**
 * Capture every one of the ten required states, at both review viewports.
 *
 *   npm run shots                 # dev server must already be running
 *   CLUB_URL=http://host:5173 node tools/screenshots.ts
 *
 * Design review is not deferrable: the designer asked for screenshots at
 * 390x844 and 1440x900, or a preview URL. This produces the screenshots.
 *
 * Driven over the Chrome DevTools Protocol with **no new dependency** — Node 24
 * has a global `WebSocket`, and CDP is a JSON protocol over it. A screenshot
 * harness is not worth a `puppeteer` install in a repo whose whole point is a
 * small reproducible build, and the brief is explicit about not adding
 * dependencies casually.
 *
 * Every state is reached through a **real code path**, never by faking the UI:
 *
 *  - first-run      -> `localStorage` cleared
 *  - save-corrupt   -> garbage written into the save key
 *  - offline-return -> a valid save with an old `lastSeenAt`
 *  - queue-overflow -> the Door raised without buying lanes
 *  - club-complete  -> every purchase bought, through the purchase functions
 *  - reduced-motion -> CDP media emulation, as the OS would set it
 *
 * So a screenshot that looks right is evidence the path works, not evidence
 * that a component renders.
 *
 * And a run that cannot reach a state **fails**. It does not photograph the
 * boot splash under the state's filename and exit 0 — `screenshots/` is
 * gitignored, so "the file exists" is the only check a reviewer has on a shot,
 * and a plausible-looking wrong file defeats it. Two gates enforce that:
 * `SHOT_READY_MS` for the runtime globals, and a per-shot `expectSelector`
 * that has to match after the state has been driven.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SAVE_STORAGE_KEY } from '../src/save/schema.ts';

const BASE_URL = process.env.CLUB_URL ?? 'http://127.0.0.1:5173';
const DEBUG_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9222';
const OUT_DIR = process.env.CLUB_SHOTS ?? 'screenshots';

/**
 * How long a single state may take to boot before the run gives up on it.
 *
 * The old budget was a hard-coded 6s, which is a fast-machine number: a cold
 * `vite dev` server on a loaded container spends longer than that transpiling
 * the first request alone. Generous by default because the cost of waiting too
 * long is a slow run, and the cost of waiting too little used to be a silently
 * wrong screenshot.
 */
const READY_BUDGET_MS = readyBudgetMs(process.env.SHOT_READY_MS);

/**
 * How long the post-drive `expectSelector` check may keep looking.
 *
 * Only the failing path pays this: a state that is already on screen matches
 * on the first poll and the run continues with no added delay. Separate from
 * `settleMs`, which stays the deliberate "catch it mid-animation" delay.
 */
const EXPECT_BUDGET_MS = readyBudgetMs(process.env.SHOT_EXPECT_MS, 5_000);

const POLL_MS = 100;

/** Parse a millisecond budget from the environment, or fall back to `fallback`. */
export function readyBudgetMs(raw: string | undefined, fallback = 30_000): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  // A typo'd budget must not quietly become `NaN` and make every comparison
  // false — that is the same class of bug as the loop this replaced.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid millisecond budget ${JSON.stringify(raw)}: expected a positive number`);
  }
  return parsed;
}

/** The design viewport, and the desktop size that must not be *broken*. */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
] as const;

// ---------------------------------------------------------------------------
// A minimal CDP client
// ---------------------------------------------------------------------------

interface CdpTarget {
  webSocketDebuggerUrl: string;
  type: string;
  url: string;
}

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // CDP has no timeout of its own, and a hung call here would hang the
      // whole script with no indication of which step stalled.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  /** Evaluate in the page and return the JSON-serialised result. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------

interface Shot {
  readonly name: string;
  /** What this proves, for the handoff note. */
  readonly note: string;
  /** Run before the page loads — seeds `localStorage`. */
  readonly seed?: string;
  /** Run after the game has booted. */
  readonly drive?: string;
  readonly reducedMotion?: boolean;
  /** Extra settle time, for states with an animation worth catching. */
  readonly settleMs?: number;
  /**
   * A selector that only this state's screen satisfies, checked after `drive`
   * and `settleMs` and before the shutter.
   *
   * **Required, deliberately.** The readiness gate below proves the game
   * booted; it cannot prove the shot reached the state it is named after. The
   * boot splash passes a readiness check — it does not have a `[role="dialog"]`
   * in it. Making this non-optional means the next state added to this list
   * cannot skip the one check that catches a wrong picture, because `tsc`
   * refuses the entry.
   */
  readonly expectSelector: string;
}

/** The page globals the driver waits on. Reported by name when they never arrive. */
interface PageGlobals {
  readonly clubStore: boolean;
  readonly club: boolean;
}

const ABSENT_GLOBALS: PageGlobals = { clubStore: false, club: false };

/**
 * Every shot waits for both globals — including `01-boot`.
 *
 * It used to be the exception, on the reasoning that the boot shot wants the
 * loading state and so must not wait for the runtime. But its `drive` forces
 * `setBooting(true, 0.45)`, and `installDevHooks` (which publishes
 * `window.__club`) runs *after* the runtime's own `setBooting(false, 1)`. Not
 * waiting therefore raced the real boot: force the flag on at 100 ms, the
 * runtime clears it at 300 ms, and the picture filed as `01-boot` is the
 * club. Waiting for `__club` means the flag is set with nothing left to clear
 * it, so the shot is the boot screen every time. The `expectSelector` below
 * is what caught this.
 */
export function isReady(globals: PageGlobals): boolean {
  return globals.clubStore && globals.club;
}

/** The globals this shot needed and did not get, for the failure message. */
export function missingGlobals(globals: PageGlobals): readonly string[] {
  const missing: string[] = [];
  if (!globals.clubStore) missing.push('window.__clubStore');
  if (!globals.club) missing.push('window.__club');
  return missing;
}

const FRESH = `localStorage.removeItem(${JSON.stringify(SAVE_STORAGE_KEY)});`;

/**
 * A mid-run club, as a v3 save.
 *
 * Written through `localStorage` rather than built by clicking, so the
 * offline-return shot also exercises the load-and-migrate path.
 */
function seededSave(lastSeenAt: number): string {
  const save = {
    version: 3,
    lastSeenAt,
    elapsedTicks: 4_200,
    club: {
      cash: 24_500,
      totalEarned: 180_000,
      doorLevel: 5,
      stations: [
        { key: 'tap', unlocked: true, level: 30, lanes: 3 },
        { key: 'cocktail', unlocked: true, level: 22, lanes: 2 },
        { key: 'booth', unlocked: false, level: 1, lanes: 0 },
      ],
      lastCallMeter: 0.32,
      lastCallFiredCount: 4,
      bubblesCollected: 190,
      elapsedSeconds: 420,
      purchaseCount: 58,
      completeSeen: false,
      hintBubblePending: false,
      hintStationPending: false,
    },
    settings: { audio: true, reducedMotion: 'auto', haptics: true },
  };
  return `localStorage.setItem(${JSON.stringify(SAVE_STORAGE_KEY)}, ${JSON.stringify(
    JSON.stringify(save),
  )});`;
}

export const SHOTS: readonly Shot[] = [
  {
    // The flag is forced back on *after* the runtime has finished booting —
    // see `isReady`. Forcing it while the real boot is still in flight means
    // the runtime's own `setBooting(false, 1)` clears it again a frame later,
    // and the file named `01-boot` is a picture of the club.
    name: '01-boot',
    expectSelector: '.boot',
    note: 'boot / loading — club silhouette, spinner, progress bar',
    seed: FRESH,
    drive: `window.__clubStore.getState().setBooting(true, 0.45);`,
  },
  {
    name: '02-first-run',
    expectSelector: '.hud',
    note: 'first run — empty club, pulsing ring on the first cash bubble, no modal',
    seed: FRESH,
    settleMs: 1400,
  },
  {
    name: '03-playing',
    expectSelector: '.hud__cash',
    note: 'playing — a club part-way through, bubbles on the floor, Last Call part-filled',
    seed: FRESH,
    drive: `
      window.__club.grant(40000);
      for (let i = 0; i < 18; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.buyLane('tap');
      window.__clubStore.getState().actions.unlockStation('cocktail');
      window.__clubStore.getState().actions.upgradeDoor();
      window.__clubStore.getState().actions.upgradeDoor();
      window.__club.state().lastCallMeter = 0.56;
    `,
    settleMs: 1600,
  },
  {
    name: '04-queue-overflow',
    expectSelector: '.queue-warning',
    note: 'queue overflow — Door raised without lanes: queue at the door, warning banner, DOOR badge',
    seed: FRESH,
    drive: `window.__club.floodDoor();`,
    settleMs: 1200,
  },
  {
    name: '05-bars-sheet',
    expectSelector: '[role="dialog"][aria-label="Bars"]',
    note: 'BARS sheet — level and lane per station, served-vs-capacity, ★ progress',
    seed: FRESH,
    drive: `
      window.__club.grant(60000);
      for (let i = 0; i < 14; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.unlockStation('cocktail');
      // Fourteen upgrades crosses Lv 10, so a 800 ms ★ fires while settle is
      // 700 ms — a race that covered the sheet in roughly half of all runs.
      // Cleared explicitly, the same way 07 and 11 already do; the ★ has its
      // own shot and does not belong on top of this one.
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 700,
  },
  {
    name: '06-door-sheet',
    expectSelector: '[role="dialog"][aria-label="Door"]',
    note: 'DOOR sheet — arrivals vs capacity, the min() made legible',
    seed: FRESH,
    drive: `window.__club.floodDoor(); window.__clubStore.getState().openSheet('door');`,
    settleMs: 700,
  },
  {
    name: '07-station-maxed',
    expectSelector: '[role="dialog"][aria-label="Bars"]',
    note: 'station maxed — Tap Bar at L30 ★★★, MAXED badge, attention moves on',
    seed: FRESH,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 40; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    name: '08-star-celebration',
    expectSelector: '.star-burst',
    note: '★ celebration — ×2 drink price, flash and confetti, auto-dismissing',
    seed: FRESH,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 8; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.upgradeStation('tap');
    `,
    settleMs: 260,
  },
  {
    name: '09-offline-return',
    expectSelector: '[role="dialog"][aria-labelledby="offline-title"]',
    note: 'offline return — "the night carried on", capped at 10 min, COLLECT in the thumb zone',
    seed: seededSave(Date.now() - 2 * 3600_000 - 14 * 60_000),
    settleMs: 1100,
  },
  {
    name: '10-save-corrupt',
    expectSelector: '.banner--warn',
    note: 'save corrupt — readable banner and [Start fresh], never a white screen',
    seed: `localStorage.setItem(${JSON.stringify(SAVE_STORAGE_KEY)}, '{"version":3,"lastSeen');`,
    settleMs: 1100,
  },
  {
    name: '11-club-complete',
    expectSelector: '[role="dialog"][aria-labelledby="complete-title"]',
    note: 'club complete — stats, ★★★, "Phase 2: a second venue", [KEEP PLAYING]',
    seed: FRESH,
    drive: `window.__club.buyAll(); window.__clubStore.getState().setStar(null);`,
    settleMs: 900,
  },
  {
    name: '12-settings-audio-off',
    expectSelector: '[role="dialog"][aria-label="Settings"]',
    note: 'settings / audio off — the only two toggles in scope, plus a two-step reset',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      s.setSettings({ audio: false, reducedMotion: 'off', haptics: false });
      s.openSheet('settings');
    `,
    settleMs: 700,
  },
  {
    name: '13-reduced-motion',
    expectSelector: '.star-burst--still',
    note: 'reduced motion — the ★ celebration as a static flash and a number, feedback not removed',
    seed: FRESH,
    reducedMotion: true,
    drive: `
      window.__club.grant(1e7);
      for (let i = 0; i < 9; i++) window.__clubStore.getState().actions.upgradeStation('tap');
      window.__clubStore.getState().actions.upgradeStation('tap');
    `,
    settleMs: 300,
  },
  {
    // Every lane bought and the Door maxed, but the stations still at Lv 7.
    // Door Lv 8 arrives at 3.225/s against 3.167/s of lane capacity, so 0.058/s
    // is turned away permanently — and the sheet's diagnosis fires on an
    // absolute threshold, so it advises "more lanes" when every `laneCost` and
    // `unlockCost` is already `null`. Captured because the fix has to be looked
    // at, not reasoned about.
    name: '14-door-dead-end',
    expectSelector: '[role="dialog"][aria-label="Door"]',
    note: 'DOOR sheet dead end — every lane bought, levels mid-run, and it still says "more lanes"',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      window.__club.grant(1e9);
      s.actions.unlockStation('cocktail');
      s.actions.unlockStation('booth');
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 2; i++) window.__clubStore.getState().actions.buyLane(key);
      }
      for (let i = 0; i < 8; i++) window.__clubStore.getState().actions.upgradeDoor();
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 6; i++) window.__clubStore.getState().actions.upgradeStation(key);
      }
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('door');
    `,
    settleMs: 900,
  },
  {
    // The same dead end at full build-out, with the completion card dismissed
    // so the sheet is readable. This is the state the player is left in
    // forever, so it is the one the end-state copy has to be judged on.
    name: '15-door-full-buildout',
    expectSelector: '[role="dialog"][aria-label="Door"]',
    note: 'DOOR sheet after club complete — the permanent 0.06/s residual, nothing left to buy',
    seed: FRESH,
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setShowComplete(false);
      s.setStar(null);
      s.openSheet('door');
    `,
    settleMs: 900,
  },
  {
    // The same dead end one sheet over. Every lane bought with the stations at
    // Lv 7, so all three cards are saturated with no lane left to buy — the
    // state where the old line said "Add a lane" directly above a row reading
    // "3 LANES". Reachable mid-run, which is why it is captured apart from the
    // full build-out shot below.
    name: '16-bars-dead-end',
    expectSelector: '[role="dialog"][aria-label="Bars"]',
    note: 'BARS sheet dead end — every lane bought, levels mid-run, no lane left to advise',
    seed: FRESH,
    drive: `
      const s = window.__clubStore.getState();
      window.__club.grant(1e9);
      s.actions.unlockStation('cocktail');
      s.actions.unlockStation('booth');
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 2; i++) window.__clubStore.getState().actions.buyLane(key);
      }
      for (let i = 0; i < 8; i++) window.__clubStore.getState().actions.upgradeDoor();
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 6; i++) window.__clubStore.getState().actions.upgradeStation(key);
      }
      window.__clubStore.getState().setStar(null);
      window.__clubStore.getState().openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    // Full build-out with the completion card dismissed: all three stations at
    // Lv 30 with three lanes. This is the shot design review asked for by name,
    // because it is the one state that proves the Bars sheet no longer puts
    // three amber warnings behind the CLUB COMPLETE card.
    name: '17-bars-full-buildout',
    expectSelector: '[role="dialog"][aria-label="Bars"]',
    note: 'BARS sheet after club complete — three terminal cards, no ⚠ and no imperative',
    seed: FRESH,
    drive: `
      window.__club.buyAll();
      const s = window.__clubStore.getState();
      s.setShowComplete(false);
      s.setStar(null);
      s.openSheet('bars');
    `,
    settleMs: 900,
  },
  {
    // The completion card on the path a player actually takes to it. `buyAll`
    // reaches the same state with no sheet open, which is exactly the case that
    // cannot show the bug: the last purchase in the game is Booth lane 3, and it
    // is bought from the BARS sheet. So this drive buys everything *except* that
    // lane, opens the sheet, and buys it — leaving the card over the finished
    // room rather than over a list of rows.
    name: '18-complete-over-sheet',
    expectSelector: '[role="dialog"][aria-labelledby="complete-title"]',
    note: 'club complete fired from the BARS sheet — the real last purchase, sheet dismissed',
    seed: FRESH,
    drive: `
      const S = () => window.__clubStore.getState();
      window.__club.grant(1e12);
      S().actions.unlockStation('cocktail');
      S().actions.unlockStation('booth');
      for (let i = 0; i < 8; i++) S().actions.upgradeDoor();
      for (const key of ['tap', 'cocktail', 'booth']) {
        for (let i = 0; i < 30; i++) S().actions.upgradeStation(key);
      }
      for (const key of ['tap', 'cocktail']) {
        for (let i = 0; i < 2; i++) S().actions.buyLane(key);
      }
      S().actions.buyLane('booth');
      S().setStar(null);
      S().openSheet('bars');
      S().actions.buyLane('booth');
    `,
    settleMs: 900,
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function pageTarget(): Promise<string> {
  const response = await fetch(`${DEBUG_URL}/json/list`);
  const targets = (await response.json()) as CdpTarget[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('no page target; is Chrome running with --remote-debugging-port?');
  return page.webSocketDebuggerUrl;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const manifest: { viewport: string; name: string; note: string; file: string }[] = [];

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });

    for (const shot of SHOTS) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-reduced-motion', value: shot.reducedMotion === true ? 'reduce' : 'no-preference' },
        ],
      });

      // Seed on the no-boot page, then navigate to the real one.
      //
      // Seeding on a page with a running game does not work: navigating away
      // fires `pagehide`, the outgoing game writes its own save, and the seed
      // is overwritten before the next load reads it. That is not a theory —
      // it is how the offline-return shot came out showing the club from the
      // shot before it.
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?noboot=1` });
      await sleep(400);
      if (shot.seed !== undefined) await cdp.evaluate(`${shot.seed} return true;`);

      await cdp.send('Page.navigate', { url: `${BASE_URL}/` });

      // Wait for the runtime rather than a fixed delay.
      //
      // When the budget runs out this *throws*. The loop it replaced merely
      // ended, and execution fell through to `drive` and the shutter — which is
      // how a boot splash got written out as `mobile-24-…png`, exit 0, success
      // line printed (DUB-108).
      const label = `${viewport.name} ${shot.name}`;
      const readyDeadline = Date.now() + READY_BUDGET_MS;
      for (;;) {
        await sleep(POLL_MS);
        const globals = await cdp
          .evaluate<PageGlobals>(
            `return { clubStore: Boolean(window.__clubStore), club: Boolean(window.__club) };`,
          )
          .catch(() => ABSENT_GLOBALS);
        if (isReady(globals)) break;
        if (Date.now() >= readyDeadline) {
          throw new Error(
            `${label}: never became ready within ${READY_BUDGET_MS} ms — ` +
              `missing ${missingGlobals(globals).join(', ')}. ` +
              `Nothing captured. Raise SHOT_READY_MS if the dev server is cold, ` +
              `or check that ${BASE_URL}/ actually boots.`,
          );
        }
      }

      if (shot.drive !== undefined) await cdp.evaluate(`${shot.drive} return true;`);
      await sleep(shot.settleMs ?? 400);

      // The readiness gate proves the game booted. This proves the shot is of
      // the state it is named after: a splash satisfies the former and fails
      // the latter.
      const expectDeadline = Date.now() + EXPECT_BUDGET_MS;
      for (;;) {
        const present = await cdp
          .evaluate<boolean>(
            `return document.querySelector(${JSON.stringify(shot.expectSelector)}) !== null;`,
          )
          .catch(() => false);
        if (present) break;
        if (Date.now() >= expectDeadline) {
          throw new Error(
            `${label}: nothing matched ${shot.expectSelector} after drive + ` +
              `${String(shot.settleMs ?? 400)} ms settle + ${EXPECT_BUDGET_MS} ms wait. ` +
              `Nothing captured — the page is not showing this state.`,
          );
        }
        await sleep(POLL_MS);
      }

      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });

      const file = `${viewport.name}-${shot.name}.png`;
      await writeFile(`${OUT_DIR}/${file}`, Buffer.from(data, 'base64'));
      manifest.push({ viewport: viewport.name, name: shot.name, note: shot.note, file });
      console.log(`  ${viewport.name.padEnd(8)} ${shot.name.padEnd(22)} -> ${file}`);
    }
  }

  await writeFile(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  cdp.close();
  console.log(`\n${manifest.length} screenshots in ${OUT_DIR}/`);
}

/**
 * Only drive a browser when this file *is* the command.
 *
 * `screenshots.test.ts` imports `SHOTS` and the gate helpers; without this
 * guard the import would try to open a CDP socket from inside vitest.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
